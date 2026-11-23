import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { encryptCredentials } from '@zenith/core';
import { parseWhatsAppWebhook } from '@zenith/channel-whatsapp';
import { insertWebhookEvent, withTenant, type Pool } from '@zenith/db';
import { followupNote, renderTemplate, templateParam, toModelMessages, writeFollowup, type LlmClient } from '@zenith/brain';
import { processInboundEvent } from '../src/inbound.js';
import { processBrainJob } from '../src/brain-job.js';
import { processOutboundMessage } from '../src/outbound.js';
import { inQuietHours, runFollowups } from '../src/followups.js';
import { hasDb, seedTenant, setupDb } from '../../../packages/db/test/helpers.js';
import { textWebhook } from '../../../packages/channel-whatsapp/test/fixtures.js';
import { scriptedLlm, text, tool } from '../../../packages/brain/test/fake-llm.js';
import moraMora from '../../../config/tenants/inversiones-mora-mora.json' with { type: 'json' };

const HOUR = 60 * 60_000;

describe('piezas del seguimiento', () => {
  it('respeta el horario de descanso en la hora local del negocio', () => {
    const quiet = { start: 20, end: 8 };
    // 01:00 UTC = 21:00 en Caracas (UTC-4): descanso. 15:00 UTC = 11:00: se puede escribir.
    expect(inQuietHours(new Date('2026-11-20T01:00:00Z'), 'America/Caracas', quiet)).toBe(true);
    expect(inQuietHours(new Date('2026-11-20T15:00:00Z'), 'America/Caracas', quiet)).toBe(false);
    expect(inQuietHours(new Date('2026-11-20T11:30:00Z'), 'America/Caracas', quiet)).toBe(true); // 07:30
    expect(inQuietHours(new Date('2026-11-20T03:00:00Z'), 'UTC', { start: 0, end: 0 })).toBe(false);
  });

  it('arma los parámetros y el texto de la plantilla', () => {
    const ctx = { businessName: 'Inversiones Mora Mora', nameFallback: 'estimado cliente' };
    expect(templateParam('{nombre}', { ...ctx, contactName: 'ana maría pérez' })).toBe('Ana');
    expect(templateParam('{nombre}', { ...ctx, contactName: '🙂' })).toBe('estimado cliente');
    expect(templateParam('{nombre}', { ...ctx, contactName: null })).toBe('estimado cliente');
    expect(templateParam('{negocio}', { ...ctx, contactName: null })).toBe('Inversiones Mora Mora');
    expect(renderTemplate('Hola {{1}}, gracias por escribir a {{2}}.', ['Ana', 'IMM'])).toBe('Hola Ana, gracias por escribir a IMM.');
  });

  it('el historial puede terminar en una nota interna aunque lo último sea del negocio', () => {
    const history = [
      { direction: 'in' as const, author: 'customer' as const, type: 'text', body: 'Busco piso gris' },
      { direction: 'out' as const, author: 'bot' as const, type: 'text', body: 'Tenemos el Archi Cenizo.' },
    ];
    // Sin nota, el turno del bot se descarta (el bot siempre responde al cliente).
    expect(toModelMessages(history).map((m) => m.role)).toEqual(['user']);
    const withNote = toModelMessages(history, undefined, { trailingNote: followupNote(20 * 60) });
    expect(withNote.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(String(withNote[2]?.content)).toContain('unas 20 horas');
  });

  it('el seguimiento pasa por el validador y entiende NO_SEGUIR', async () => {
    const base = { system: 's', messages: [], model: 'm', effort: 'low' as const };
    expect((await writeFollowup({ ...base, llm: scriptedLlm([text('NO_SEGUIR')]).llm })).draft).toEqual({ decision: 'skip' });
    expect((await writeFollowup({ ...base, llm: scriptedLlm([text('Le queda en $25 el metro.')]).llm })).draft).toEqual({
      decision: 'blocked',
      reason: 'mentions_price',
    });
    expect((await writeFollowup({ ...base, llm: scriptedLlm([text('¿Le gustó el Archi Cenizo?')]).llm })).draft).toEqual({
      decision: 'send',
      text: '¿Le gustó el Archi Cenizo?',
    });
  });
});

describe.skipIf(!hasDb)('seguimiento automático', () => {
  const masterKey = randomBytes(32);
  let owner: pg.Pool;
  let app: Pool;
  let t: Awaited<ReturnType<typeof seedTenant>>;
  let seq = 0;
  const graph = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ messages: [{ id: `wamid.FU${++seq}` }] }), { status: 200 }));

  const settings = {
    ...moraMora.settings,
    // Sin horario de descanso: las pruebas corren a cualquier hora.
    followups: { ...moraMora.settings.followups, quietHours: { start: 0, end: 0 } },
  };

  async function customerSays(from: string, body: string, name = 'Ana María') {
    seq++;
    const payload = textWebhook({ id: `wamid.FUIN${Date.now()}${seq}`, from, body, timestamp: String(Math.floor(Date.now() / 1000)) });
    const value = payload.entry[0]!.changes[0]!.value as { metadata: { phone_number_id: string }; contacts?: { profile: { name: string } }[] };
    value.metadata.phone_number_id = t.phoneNumberId;
    if (value.contacts?.[0]) value.contacts[0].profile.name = name;
    const [event] = parseWhatsAppWebhook(payload);
    const outcome = await processInboundEvent(app, (await insertWebhookEvent(app, event!, payload))!);
    if (outcome.result !== 'message') throw new Error('se esperaba un mensaje');
    return outcome;
  }

  /** El cliente escribe y el bot le responde. */
  async function chat(from: string, body: string, reply: string) {
    const msg = await customerSays(from, body);
    const turn = await processBrainJob(
      { pool: app, llm: scriptedLlm([text(reply)]).llm },
      { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId },
    );
    expect(turn.result).toBe('replied');
    return msg.conversationId;
  }

  /**
   * Modelo simulado para seguimientos: responde según la conversación (varias pueden vencer en
   * la misma pasada). Si ninguna regla calza, decide no escribir.
   */
  function rulesLlm(rules: Record<string, string>) {
    const calls: Parameters<LlmClient['create']>[0][] = [];
    const llm: LlmClient = {
      create: async (params) => {
        calls.push(params);
        const seen = JSON.stringify(params.messages);
        const hit = Object.entries(rules).find(([needle]) => seen.includes(needle));
        return scriptedLlm([text(hit ? hit[1] : 'NO_SEGUIR')]).llm.create(params);
      },
    };
    return { llm, calls };
  }

  const run = (hoursLater: number, rules: Record<string, string> = {}) => {
    const { llm, calls } = rulesLlm(rules);
    const now = new Date(Date.now() + hoursLater * HOUR);
    return runFollowups({ pool: app, llm, model: 'modelo-prueba', effort: 'low', now: () => now, tenantIds: [t.tenantId] }).then((r) => ({
      ...r,
      calls,
      now,
    }));
  };

  const followupRows = (conversationId: string) =>
    withTenant(app, t.tenantId, async (c) =>
      (
        await c.query<{ step: number; status: string; reason: string | null }>(
          'SELECT step, status, reason FROM followups WHERE conversation_id = $1 ORDER BY step',
          [conversationId],
        )
      ).rows,
    );

  beforeAll(async () => {
    ({ owner, app } = await setupDb());
    t = await seedTenant(owner, 'seguimiento');
    await owner.query('UPDATE tenants SET settings = $2 WHERE id = $1', [t.tenantId, JSON.stringify(settings)]);
    await owner.query('UPDATE channel_accounts SET credentials_enc = $2 WHERE id = $1', [
      t.channelAccountId,
      encryptCredentials(JSON.stringify({ accessToken: 'token-prueba' }), masterKey, t.channelAccountId),
    ]);
  });

  afterAll(async () => {
    if (t) {
      await owner.query('DELETE FROM webhook_events WHERE channel_external_account_id = $1', [t.phoneNumberId]);
      await owner.query('DELETE FROM tenants WHERE id = $1', [t.tenantId]);
    }
    await owner?.end();
    await app?.end();
  });

  it('escribe una vez dentro de las 24 h y, ya cerrada la ventana, manda la plantilla', async () => {
    const conv = await chat('584140001001', 'Hola, busco un piso gris tipo madera', 'Tenemos el *Archi Cenizo*, ¿para qué espacio sería?');

    // Antes de tiempo, nada.
    expect((await run(19)).sent).toEqual([]);

    const first = await run(21, { 'piso gris tipo madera': '¿Pudo ver el *Archi Cenizo*? Si me dice los metros, le calculo las cajas.' });
    expect(first.sent).toEqual([{ tenantId: t.tenantId, conversationId: conv, step: 1, outboundMessageId: expect.any(String) }]);
    // El modelo vio la conversación y la nota interna al final.
    expect(JSON.stringify(first.calls[0]?.messages)).toContain('Archi Cenizo');
    expect(JSON.stringify(first.calls[0]?.messages.at(-1))).toContain('Nota interna');
    expect(first.calls[0]?.tools).toBeUndefined();

    const sent = await processOutboundMessage(
      { pool: app, masterKey, graphApiVersion: 'v21.0', fetch: graph, now: () => first.now },
      { tenantId: t.tenantId, outboundMessageId: first.sent[0]!.outboundMessageId },
    );
    expect(sent.result).toBe('sent');
    expect(JSON.parse(String(graph.mock.calls.at(-1)![1]?.body))).toMatchObject({ type: 'text', text: { body: expect.stringContaining('Archi Cenizo') } });

    // No se repite por el mismo silencio.
    expect((await run(22)).sent).toEqual([]);

    // A las 49 h la ventana está cerrada: va la plantilla aprobada, con el nombre del cliente.
    const second = await run(49);
    expect(second.calls).toEqual([]); // la plantilla no gasta IA
    expect(second.sent.map((s) => s.step)).toEqual([2]);
    const tpl = await processOutboundMessage(
      { pool: app, masterKey, graphApiVersion: 'v21.0', fetch: graph, now: () => second.now },
      { tenantId: t.tenantId, outboundMessageId: second.sent[0]!.outboundMessageId },
    );
    expect(tpl.result).toBe('sent');
    expect(JSON.parse(String(graph.mock.calls.at(-1)![1]?.body))).toMatchObject({
      type: 'template',
      template: {
        name: 'seguimiento_consulta',
        language: { code: 'es' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }] }],
      },
    });

    // En el historial queda el texto que vio el cliente, marcado como seguimiento.
    const msgs = await withTenant(app, t.tenantId, async (c) =>
      (await c.query<{ type: string; body: string; attachments: { followup?: number }[] }>(
        `SELECT type, body, attachments FROM messages WHERE conversation_id = $1 AND author = 'bot' ORDER BY seq`,
        [conv],
      )).rows,
    );
    expect(msgs.map((m) => m.attachments[0]?.followup ?? null)).toEqual([null, 1, 2]);
    expect(msgs[2]).toMatchObject({ type: 'template', body: expect.stringMatching(/^Hola Ana, le escribimos de Inversiones Mora Mora/) });
    expect(await followupRows(conv)).toEqual([
      { step: 1, status: 'sent', reason: null },
      { step: 2, status: 'sent', reason: null },
    ]);

    // Después de la plantilla ya no hay más pasos.
    expect((await run(80)).sent).toEqual([]);
  });

  it('un texto libre fuera de las 24 h se sigue bloqueando', async () => {
    const conv = await chat('584140001002', 'Hola', 'Hola, con gusto le ayudo. ¿Qué está buscando?');
    const reply = await withTenant(app, t.tenantId, async (c) =>
      (await c.query<{ id: string }>('SELECT id FROM outbound_messages WHERE conversation_id = $1', [conv])).rows[0]!.id,
    );
    const late = new Date(Date.now() + 30 * HOUR);
    expect(
      await processOutboundMessage({ pool: app, masterKey, graphApiVersion: 'v21.0', fetch: graph, now: () => late }, { tenantId: t.tenantId, outboundMessageId: reply }),
    ).toEqual({ result: 'blocked_window' });
  });

  it('si la IA juzga que no corresponde, no escribe ni manda plantilla después', async () => {
    const conv = await chat('584140001003', 'Ya compré en la tienda, gracias', 'Qué bueno, gracias a usted. Aquí estamos para lo que necesite.');
    const r = await run(21, { 'Ya compré': 'NO_SEGUIR' });
    expect(r.sent).toEqual([]);
    expect(await followupRows(conv)).toEqual([{ step: 1, status: 'skipped', reason: 'no_seguir' }]);
    expect((await run(49)).sent.filter((s) => s.conversationId === conv)).toEqual([]);
  });

  it('si la ventana ya cerró cuando toca el paso 1, espera a la plantilla', async () => {
    const conv = await chat('584140001004', 'Busco porcelanato para cocina', 'Tenemos varias opciones, ¿lo prefiere claro u oscuro?');
    // El worker estuvo caído: la primera pasada ocurre a las 30 h.
    const late = await run(30, { 'porcelanato para cocina': '¿Lo prefiere claro u oscuro? Así le muestro las opciones.' });
    expect(late.sent.filter((s) => s.conversationId === conv)).toEqual([]);
    expect(await followupRows(conv)).toEqual([{ step: 1, status: 'skipped', reason: 'ventana' }]);
    expect((await run(49)).sent.filter((s) => s.conversationId === conv).map((s) => s.step)).toEqual([2]);
  });

  it('no escribe a quien pidió que no le escriban, ni a conversaciones con un asesor', async () => {
    // El cliente pide que no le escriban: el bot usa la herramienta y queda anotado en el contacto.
    const msg = await customerSays('584140001005', 'Por favor no me manden más mensajes');
    const turn = await processBrainJob(
      { pool: app, llm: scriptedLlm([tool('no_escribir_mas', {}), text('Entendido, no le escribiremos más. Cuando guste, aquí estamos.')]).llm },
      { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId },
    );
    expect(turn.result).toBe('replied');
    const optOut = await withTenant(app, t.tenantId, async (c) =>
      (await c.query<{ opt_out_followups: boolean }>(
        'SELECT ct.opt_out_followups FROM contacts ct JOIN conversations cv ON cv.contact_id = ct.id WHERE cv.id = $1',
        [msg.conversationId],
      )).rows[0]!.opt_out_followups,
    );
    expect(optOut).toBe(true);

    // Una conversación que pasó a un asesor tampoco recibe seguimientos del bot.
    const human = await customerSays('584140001006', '¿Qué precio tiene el Archi Cenizo?');
    const handed = await processBrainJob(
      {
        pool: app,
        llm: scriptedLlm([tool('derivar_a_asesor', { motivo: 'precio', resumen: 'Pide precio del Archi Cenizo' }), text('Un asesor le pasa el precio por aquí mismo.')]).llm,
      },
      { tenantId: t.tenantId, conversationId: human.conversationId, triggerMessageId: human.messageId },
    );
    expect(handed).toMatchObject({ result: 'replied', handoff: true });

    const r = await run(21, { 'no me manden': 'No debería usarse', 'precio tiene': 'Tampoco esta' });
    const ids = r.sent.map((s) => s.conversationId);
    expect(ids).not.toContain(msg.conversationId);
    expect(ids).not.toContain(human.conversationId);
  });

  it('si el cliente responde, el silencio anterior se cierra y el siguiente cuenta desde cero', async () => {
    const conv = await chat('584140001007', 'Busco un lavamanos', '¿Lo quiere de sobreponer o de empotrar?');
    const lavamanos = { 'Busco un lavamanos': '¿Lo prefiere de sobreponer o de empotrar?' };
    expect((await run(21, lavamanos)).sent.filter((s) => s.conversationId === conv)).toHaveLength(1);
    // El cliente vuelve a escribir y el bot responde: la plantilla del silencio anterior ya no
    // aplica. Para el nuevo silencio vuelve a tocar el paso 1 (que a +49 h ya no cabe en la ventana).
    await chat('584140001007', 'De sobreponer', 'Perfecto, le muestro dos opciones.');
    const r = await run(49, lavamanos);
    expect(r.sent.filter((s) => s.conversationId === conv)).toEqual([]);
    expect((await followupRows(conv)).map((f) => `${f.step}:${f.status}:${f.reason ?? ''}`)).toEqual(['1:sent:', '1:skipped:ventana']);
  });
});
