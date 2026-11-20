import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { encryptCredentials } from '@zenith/core';
import { parseWhatsAppWebhook } from '@zenith/channel-whatsapp';
import { insertWebhookEvent, withTenant, type Pool } from '@zenith/db';
import { FALLBACK_REPLY } from '@zenith/brain';
import { syncProducts, type ProductInput } from '@zenith/catalog';
import { processInboundEvent } from '../src/inbound.js';
import { processBrainJob } from '../src/brain-job.js';
import { processOutbound } from '../src/outbound.js';
import { createCatalogReader, normalizeTerms } from '../src/catalog-reader.js';
import { hasDb, seedTenant, setupDb } from '../../../packages/db/test/helpers.js';
import { textWebhook } from '../../../packages/channel-whatsapp/test/fixtures.js';
import { scriptedLlm, text, tool } from '../../../packages/brain/test/fake-llm.js';
import moraMora from '../../../config/tenants/inversiones-mora-mora.json' with { type: 'json' };

const masterKey = randomBytes(32);

const tile = (externalId: string, name: string, attrs: Record<string, unknown>, extra: Partial<ProductInput> = {}): ProductInput => ({
  externalId,
  name,
  category: 'ceramicas',
  categoryName: 'Cerámicas',
  description: null,
  format: '60x60/1.80m²/5 Piezas',
  pieceWidthCm: 60,
  pieceLengthCm: 60,
  areaPerBoxM2: 1.8,
  piecesPerBox: 5,
  attributes: attrs,
  price: null,
  currency: null,
  onOffer: false,
  inVisualizer: true,
  ...extra,
});

describe('normalizeTerms', () => {
  it('quita tildes, signos, palabras cortas y la s final', () => {
    // Igual que unaccent() en Postgres: la ñ también pierde la tilde.
    expect(normalizeTerms('¿Cerámicas de MADERA para el baño?')).toEqual(['ceramica', 'madera', 'para', 'bano']);
    expect(normalizeTerms(null)).toEqual([]);
  });
});

describe.skipIf(!hasDb)('turno completo del bot', () => {
  let owner: pg.Pool;
  let app: Pool;
  let t: Awaited<ReturnType<typeof seedTenant>>;
  let other: Awaited<ReturnType<typeof seedTenant>>;
  let seq = 0;

  const graph = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${++seq}` }] }), { status: 200 }));
  const outboundDeps = () => ({ pool: app, masterKey, graphApiVersion: 'v21.0', fetch: graph });

  async function customerSays(body: string, from = '584141230000', timestamp = String(Math.floor(Date.now() / 1000))) {
    seq++;
    const payload = textWebhook({ id: `wamid.IN${Date.now()}${seq}`, from, body, timestamp });
    (payload.entry[0]!.changes[0]!.value as { metadata: { phone_number_id: string } }).metadata.phone_number_id = t.phoneNumberId;
    const [event] = parseWhatsAppWebhook(payload);
    const id = await insertWebhookEvent(app, event!, payload);
    const outcome = await processInboundEvent(app, id!);
    if (outcome.result !== 'message') throw new Error(`se esperaba un mensaje, llegó ${outcome.result}`);
    return outcome;
  }

  beforeAll(async () => {
    ({ owner, app } = await setupDb());
    t = await seedTenant(owner, 'turn');
    other = await seedTenant(owner, 'turn-otro');
    await owner.query('UPDATE tenants SET settings = $2 WHERE id = $1', [t.tenantId, JSON.stringify(moraMora.settings)]);
    await owner.query('UPDATE channel_accounts SET credentials_enc = $2 WHERE id = $1', [
      t.channelAccountId,
      encryptCredentials(JSON.stringify({ accessToken: 'token-prueba' }), masterKey, t.channelAccountId),
    ]);
    await withTenant(app, t.tenantId, (c) =>
      syncProducts(c, t.tenantId, 'imm_store', [
        tile('1', 'Aconna Beige', { surface: 'Piso y pared', finish: 'Mate', usage: 'Interior y exterior', features: ['Antideslizante'] }),
        tile('2', 'Marmol Velletri', { surface: 'Pared', finish: 'Brillante', usage: 'Interior y exterior' }, { format: '25x75/1.50m²/8 Piezas', areaPerBoxM2: 1.5, piecesPerBox: 8 }),
        tile('3', 'Sanitario Cascade', { brand: 'Corona', finish: 'Brillante' }, {
          category: 'sanitarios', categoryName: 'Sanitarios', format: null, areaPerBoxM2: null, piecesPerBox: null, inVisualizer: false,
        }),
      ]),
    );
    // Un producto de otro tenant que nunca debe aparecer.
    await withTenant(app, other.tenantId, (c) => syncProducts(c, other.tenantId, 'imm_store', [tile('1', 'Producto Ajeno Beige', { surface: 'Piso' })]));
  });

  afterAll(async () => {
    if (t) {
      await owner.query('DELETE FROM webhook_events WHERE channel_external_account_id = ANY($1)', [[t.phoneNumberId, other?.phoneNumberId]]);
      await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[t.tenantId, other?.tenantId].filter(Boolean)]);
    }
    await owner?.end();
    await app?.end();
  });

  it('la búsqueda del catálogo filtra, no distingue tildes y no ve otros tenants', async () => {
    const reader = createCatalogReader(app, t.tenantId);
    const beige = await reader.search({ text: 'beige', category: null, surface: null, usage: null, limit: 8 });
    expect(beige.map((p) => p.name)).toEqual(['Aconna Beige']);
    const marmol = await reader.search({ text: 'mármol brillante', category: 'cerámicas', surface: 'pared', usage: null, limit: 8 });
    expect(marmol[0]?.name).toBe('Marmol Velletri');
    const pisos = await reader.search({ text: null, category: null, surface: 'piso', usage: 'exterior', limit: 8 });
    expect(pisos.map((p) => p.name)).toEqual(['Aconna Beige']);
    const sanitarios = await reader.search({ text: null, category: 'sanitarios', surface: null, usage: null, limit: 8 });
    expect(sanitarios.map((p) => p.name)).toEqual(['Sanitario Cascade']);
  });

  it('responde al cliente, guarda la respuesta y la envía por WhatsApp', async () => {
    const msg = await customerSays('Hola, busco cerámica beige para 12 m² de piso', '584141230001');
    const productId = (await createCatalogReader(app, t.tenantId).search({ text: 'beige', category: null, surface: null, usage: null, limit: 1 }))[0]!.id;
    const { llm, calls } = scriptedLlm([
      tool('buscar_productos', { texto: 'beige', categoria: null, superficie: 'piso', uso: null, limite: 3 }),
      tool('calcular_cajas', { producto_id: productId, metros_cuadrados: 12 }),
      text('Buenas tardes. Le recomiendo el Aconna Beige 60x60 mate y antideslizante: para 12 m² necesitaría 7 cajas.'),
    ]);

    const turn = await processBrainJob({ pool: app, llm }, { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId });
    expect(turn).toMatchObject({ result: 'replied', handoff: false, outcome: 'replied' });
    if (turn.result !== 'replied') return;

    // El modelo recibió el historial con el mensaje del cliente y el prompt del negocio.
    expect(JSON.stringify(calls[0]?.messages)).toContain('busco cerámica beige');
    expect(String(calls[0]?.system)).toContain('Inversiones Mora Mora');
    expect(JSON.stringify(calls[2]?.messages.at(-1))).toContain('\\"cajas\\":7');

    const sent = await processOutbound(outboundDeps(), { tenantId: t.tenantId, outboundMessageId: turn.outboundMessageId });
    expect(sent.result).toBe('sent');
    const [url, init] = graph.mock.calls.at(-1)!;
    expect(String(url)).toBe(`https://graph.facebook.com/v21.0/${t.phoneNumberId}/messages`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ to: '584141230001', text: { body: expect.stringContaining('7 cajas') } });
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token-prueba');

    const rows = await withTenant(app, t.tenantId, async (c) => ({
      out: (await c.query(`SELECT status, external_message_id FROM outbound_messages WHERE id = $1`, [turn.outboundMessageId])).rows[0],
      msg: (await c.query(`SELECT author, body, external_message_id FROM messages WHERE conversation_id = $1 AND direction = 'out'`, [msg.conversationId])).rows,
      run: (await c.query(`SELECT outcome, iterations, input_tokens FROM ai_runs WHERE conversation_id = $1`, [msg.conversationId])).rows,
    }));
    expect(rows.out?.status).toBe('sent');
    expect(rows.msg).toHaveLength(1);
    expect(rows.msg[0]).toMatchObject({ author: 'bot', external_message_id: rows.out?.external_message_id });
    expect(rows.run).toEqual([{ outcome: 'replied', iterations: 3, input_tokens: 300 }]);

    // Reintentar el mismo turno o el mismo envío no duplica nada.
    expect(await processBrainJob({ pool: app, llm: scriptedLlm([]).llm }, { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId })).toEqual({
      result: 'skipped',
      reason: 'already_answered',
    });
    expect(await processOutbound(outboundDeps(), { tenantId: t.tenantId, outboundMessageId: turn.outboundMessageId })).toEqual({ result: 'skipped' });
  });

  it('si el cliente escribió otra vez, el turno viejo se descarta', async () => {
    const first = await customerSays('Hola', '584141230002');
    await customerSays('¿Tienen sanitarios?', '584141230002');
    const { llm, calls } = scriptedLlm([text('no debería usarse')]);
    expect(await processBrainJob({ pool: app, llm }, { tenantId: t.tenantId, conversationId: first.conversationId, triggerMessageId: first.messageId })).toEqual({
      result: 'skipped',
      reason: 'superseded',
    });
    expect(calls).toHaveLength(0);
  });

  it('al pedir precio deriva al asesor, el bot se calla y el asesor queda avisado', async () => {
    const msg = await customerSays('¿Cuánto cuesta el Aconna Beige?', '584141230003');
    const { llm } = scriptedLlm([
      tool('derivar_a_asesor', { motivo: 'precio', resumen: 'Pide precio del Aconna Beige.' }),
      text('Con gusto. Un asesor le enviará la cotización en breve.'),
    ]);
    const turn = await processBrainJob({ pool: app, llm }, { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId });
    expect(turn).toMatchObject({ result: 'replied', handoff: true });

    const state = await withTenant(app, t.tenantId, async (c) => ({
      conv: (await c.query('SELECT mode FROM conversations WHERE id = $1', [msg.conversationId])).rows[0],
      handoff: (await c.query('SELECT reason, summary, taken_at FROM handoffs WHERE conversation_id = $1', [msg.conversationId])).rows,
    }));
    expect(state.conv?.mode).toBe('human');
    expect(state.handoff).toEqual([{ reason: 'precio', summary: 'Pide precio del Aconna Beige.', taken_at: null }]);

    // El siguiente mensaje del cliente ya no dispara al bot.
    const next = await customerSays('Gracias, espero', '584141230003');
    expect(next.mode).toBe('human');
    expect(await processBrainJob({ pool: app, llm: scriptedLlm([]).llm }, { tenantId: t.tenantId, conversationId: next.conversationId, triggerMessageId: next.messageId })).toEqual({
      result: 'skipped',
      reason: 'human_mode',
    });
  });

  it('si el modelo falla sin remedio, el cliente recibe el respaldo y se deriva', async () => {
    const msg = await customerSays('Hola', '584141230004');
    const llm = { create: vi.fn().mockRejectedValue(new Error('respuesta inválida')) };
    const turn = await processBrainJob({ pool: app, llm }, { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId });
    expect(turn).toMatchObject({ result: 'replied', handoff: true, outcome: 'error' });
    const body = await withTenant(app, t.tenantId, async (c) =>
      (await c.query(`SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'out'`, [msg.conversationId])).rows[0]?.body,
    );
    expect(body).toBe(FALLBACK_REPLY);
  });

  it('no envía texto libre fuera de la ventana de 24 h', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 25 * 3600);
    const msg = await customerSays('Hola', '584141230005', old);
    const { llm } = scriptedLlm([text('Buenas tardes, ¿en qué le puedo ayudar?')]);
    const turn = await processBrainJob({ pool: app, llm }, { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId });
    if (turn.result !== 'replied') throw new Error('se esperaba respuesta');
    const before = graph.mock.calls.length;
    expect(await processOutbound(outboundDeps(), { tenantId: t.tenantId, outboundMessageId: turn.outboundMessageId })).toEqual({ result: 'blocked_window' });
    expect(graph.mock.calls.length).toBe(before);
  });

  it('reintenta errores transitorios de Meta y marca fallidos los permanentes', async () => {
    const make = async (from: string) => {
      const msg = await customerSays('Hola', from);
      const turn = await processBrainJob({ pool: app, llm: scriptedLlm([text('Buenas tardes.')]).llm }, { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId });
      if (turn.result !== 'replied') throw new Error('se esperaba respuesta');
      return turn.outboundMessageId;
    };

    const transient = await make('584141230006');
    const busy = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(processOutbound({ ...outboundDeps(), fetch: busy }, { tenantId: t.tenantId, outboundMessageId: transient })).rejects.toThrow();
    expect(await processOutbound(outboundDeps(), { tenantId: t.tenantId, outboundMessageId: transient })).toMatchObject({ result: 'sent' });

    const permanent = await make('584141230007');
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 131026, message: 'No se pudo entregar' } }), { status: 400 }));
    expect(await processOutbound({ ...outboundDeps(), fetch: rejected }, { tenantId: t.tenantId, outboundMessageId: permanent })).toEqual({
      result: 'failed',
      reason: 'send_failed',
    });
  });

  it('sin credenciales válidas no envía', async () => {
    const msg = await customerSays('Hola', '584141230008');
    const turn = await processBrainJob({ pool: app, llm: scriptedLlm([text('Buenas tardes.')]).llm }, { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId });
    if (turn.result !== 'replied') throw new Error('se esperaba respuesta');
    expect(await processOutbound({ ...outboundDeps(), masterKey: randomBytes(32) }, { tenantId: t.tenantId, outboundMessageId: turn.outboundMessageId })).toEqual({
      result: 'failed',
      reason: 'bad_credentials',
    });
  });
});
