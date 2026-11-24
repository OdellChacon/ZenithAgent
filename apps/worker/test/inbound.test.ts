import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { parseWhatsAppWebhook } from '@zenith/channel-whatsapp';
import { insertWebhookEvent, reclaimStaleWebhookEvents, withTenant, type Pool } from '@zenith/db';
import { processInboundEvent } from '../src/inbound.js';
import { hasDb, seedTenant, setupDb } from '../../../packages/db/test/helpers.js';
import { accountUpdateWebhook, echoWebhook, historyWebhook, stateSyncWebhook, statusWebhook, textWebhook } from '../../../packages/channel-whatsapp/test/fixtures.js';

describe.skipIf(!hasDb)('worker de entrada', () => {
  let owner: pg.Pool;
  let app: Pool;
  let t: Awaited<ReturnType<typeof seedTenant>>;
  let seq = 0;

  /** Webhook con el phone_number_id del tenant de prueba e ids únicos por prueba. */
  function webhook(opts: { body?: string; from?: string; timestamp?: string } = {}) {
    seq++;
    const payload = textWebhook({ id: `wamid.T${Date.now()}${seq}`, ...opts });
    (payload.entry[0]!.changes[0]!.value as { metadata: { phone_number_id: string } }).metadata.phone_number_id = t.phoneNumberId;
    return payload;
  }

  /** Copia de un mensaje que un asesor mandó desde la app, con la hora actual. */
  function echo(opts: { to: string; id?: string; body?: string }) {
    seq++;
    const payload = echoWebhook([
      {
        from: '584140000000',
        to: opts.to,
        id: opts.id ?? `wamid.E${Date.now()}${seq}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: opts.body ?? 'Buenas, le escribo por la cotización' },
      },
    ]);
    (payload.entry[0]!.changes[0]!.value as { metadata: { phone_number_id: string } }).metadata.phone_number_id = t.phoneNumberId;
    return payload;
  }

  const nowTs = () => String(Math.floor(Date.now() / 1000));

  async function conversation(id: string) {
    return withTenant(app, t.tenantId, async (c) => (await c.query('SELECT * FROM conversations WHERE id = $1', [id])).rows[0]);
  }

  async function ingest(payload: unknown) {
    const ids: string[] = [];
    for (const e of parseWhatsAppWebhook(payload)) {
      const id = await insertWebhookEvent(app, e, payload);
      if (id) ids.push(id);
    }
    return ids;
  }

  beforeAll(async () => {
    ({ owner, app } = await setupDb());
    t = await seedTenant(owner, 'worker');
  });

  afterAll(async () => {
    if (t) {
      await owner.query('DELETE FROM webhook_events WHERE channel_external_account_id = $1', [t.phoneNumberId]);
      await owner.query('DELETE FROM tenants WHERE id = $1', [t.tenantId]);
    }
    await owner?.end();
    await app?.end();
  });

  it('crea contacto, conversación y mensaje, y abre la ventana de 24 h', async () => {
    const [id] = await ingest(webhook({ from: '584140000001', timestamp: '1763632800' }));
    const outcome = await processInboundEvent(app, id!);
    expect(outcome.result).toBe('message');
    if (outcome.result !== 'message') return;
    expect(outcome.tenantId).toBe(t.tenantId);

    const conv = await withTenant(app, t.tenantId, async (c) =>
      (await c.query('SELECT * FROM conversations WHERE id = $1', [outcome.conversationId])).rows[0],
    );
    expect(conv.mode).toBe('bot');
    expect(new Date(conv.last_inbound_at).toISOString()).toBe('2025-11-20T10:00:00.000Z');
    expect(new Date(conv.window_expires_at).toISOString()).toBe('2025-11-21T10:00:00.000Z');

    const contact = await withTenant(app, t.tenantId, async (c) =>
      (await c.query('SELECT name, phone FROM contacts WHERE id = $1', [conv.contact_id])).rows[0],
    );
    expect(contact).toEqual({ name: 'Cliente Prueba', phone: '584140000001' });

    const { rows } = await owner.query('SELECT status FROM webhook_events WHERE id = $1', [id]);
    expect(rows[0]?.status).toBe('processed');
  });

  it('un segundo mensaje del mismo cliente va a la misma conversación', async () => {
    const [id1] = await ingest(webhook({ from: '584140000002', timestamp: '1763632800' }));
    const [id2] = await ingest(webhook({ from: '584140000002', timestamp: '1763640000' }));
    const o1 = await processInboundEvent(app, id1!);
    const o2 = await processInboundEvent(app, id2!);
    expect(o1.result === 'message' && o2.result === 'message' && o1.conversationId === o2.conversationId).toBe(true);
  });

  it('un mensaje viejo que llega tarde no acorta la ventana', async () => {
    const [nuevo] = await ingest(webhook({ from: '584140000003', timestamp: '1763640000' }));
    const [viejo] = await ingest(webhook({ from: '584140000003', timestamp: '1763632800' }));
    await processInboundEvent(app, nuevo!);
    const o = await processInboundEvent(app, viejo!);
    if (o.result !== 'message') throw new Error('se esperaba un mensaje');
    const conv = await withTenant(app, t.tenantId, async (c) =>
      (await c.query('SELECT last_inbound_at FROM conversations WHERE id = $1', [o.conversationId])).rows[0],
    );
    expect(new Date(conv.last_inbound_at).toISOString()).toBe(new Date(1763640000 * 1000).toISOString());
  });

  it('el mismo evento no se procesa dos veces', async () => {
    const payload = webhook({ from: '584140000004' });
    const [id] = await ingest(payload);
    expect(await ingest(payload)).toHaveLength(0); // el gateway no lo guarda de nuevo
    await processInboundEvent(app, id!);
    expect(await processInboundEvent(app, id!)).toEqual({ result: 'skipped' });
  });

  it('guarda ubicaciones y tarjetas de contacto como mensajes del cliente', async () => {
    const payload = webhook({ from: '584140000006' });
    const msg = (payload.entry[0]!.changes[0]!.value as { messages: Record<string, unknown>[] }).messages[0]!;
    msg.type = 'location';
    delete msg.text;
    msg.location = { latitude: 7.7669, longitude: -72.225, name: 'Mi casa', address: 'Barrio Obrero' };
    const [id] = await ingest(payload);
    const loc = await processInboundEvent(app, id!);
    if (loc.result !== 'message') throw new Error('se esperaba un mensaje');
    expect(loc.mode).toBe('bot');

    const payload2 = webhook({ from: '584140000006' });
    const msg2 = (payload2.entry[0]!.changes[0]!.value as { messages: Record<string, unknown>[] }).messages[0]!;
    msg2.type = 'contacts';
    delete msg2.text;
    msg2.contacts = [{ name: { formatted_name: 'Arq. Luis Pérez' }, phones: [{ phone: '+58 414-1234567', wa_id: '584141234567' }] }];
    const [id2] = await ingest(payload2);
    expect(await processInboundEvent(app, id2!)).toMatchObject({ result: 'message' });

    const rows = await withTenant(app, t.tenantId, async (c) =>
      (await c.query('SELECT type, body, attachments FROM messages WHERE conversation_id = $1 ORDER BY seq', [loc.conversationId])).rows,
    );
    expect(rows).toEqual([
      {
        type: 'location',
        body: 'Mi casa, Barrio Obrero (7.76690, -72.22500)',
        attachments: [{ location: { latitude: 7.7669, longitude: -72.225, name: 'Mi casa', address: 'Barrio Obrero' } }],
      },
      { type: 'contacts', body: 'Arq. Luis Pérez: 584141234567', attachments: [{ contacts: [{ name: 'Arq. Luis Pérez', phones: ['584141234567'] }] }] },
    ]);
  });

  it('ignora tipos de mensaje no soportados', async () => {
    const payload = webhook({ from: '584140000005' });
    const msg = (payload.entry[0]!.changes[0]!.value as { messages: Record<string, unknown>[] }).messages[0]!;
    msg.type = 'location';
    delete msg.text;
    const [id] = await ingest(payload);
    expect(await processInboundEvent(app, id!)).toEqual({ result: 'ignored', reason: 'unsupported' });
  });

  it('marca como fallido un evento de una cuenta desconocida', async () => {
    const payload = textWebhook({ id: `wamid.UNK${Date.now()}` });
    (payload.entry[0]!.changes[0]!.value as { metadata: { phone_number_id: string } }).metadata.phone_number_id = `unk-${Date.now()}`;
    const [id] = await ingest(payload);
    expect(await processInboundEvent(app, id!)).toEqual({ result: 'failed', reason: 'unknown_channel_account' });
    await owner.query('DELETE FROM webhook_events WHERE id = $1', [id]);
  });

  it('actualiza el estado de un envío sin retroceder', async () => {
    const [msgId] = await ingest(webhook({ from: '584140000006' }));
    const m = await processInboundEvent(app, msgId!);
    if (m.result !== 'message') throw new Error('se esperaba un mensaje');
    await withTenant(app, t.tenantId, (c) =>
      c.query(
        `INSERT INTO outbound_messages (tenant_id, conversation_id, idempotency_key, channel, payload, status, external_message_id)
         VALUES ($1, $2, $3, 'whatsapp', '{}', 'read', 'wamid.OUT1')`,
        [t.tenantId, m.conversationId, `k-${Date.now()}`],
      ),
    );
    const payload = structuredClone(statusWebhook);
    (payload.entry[0]!.changes[0]!.value as { metadata: { phone_number_id: string } }).metadata.phone_number_id = t.phoneNumberId;
    const ids = await ingest(payload);
    const delivered = await processInboundEvent(app, ids[0]!); // 'delivered' llega después de 'read'
    expect(delivered).toEqual({ result: 'status', tenantId: t.tenantId, updated: 0 });
  });

  it('el barrido recupera eventos que no llegaron a la cola', async () => {
    const [id] = await ingest(webhook({ from: '584140000007' }));
    await owner.query(`UPDATE webhook_events SET received_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
    const reclaimed = await reclaimStaleWebhookEvents(app, { receivedOlderThanMs: 60_000, processingOlderThanMs: 60_000, limit: 100 });
    expect(reclaimed).toContain(id);
  });
  describe('asesor que contesta desde la app (coexistencia)', () => {
    it('guarda el mensaje del asesor, calla al bot y da por atendido el pase', async () => {
      const [inId] = await ingest(webhook({ from: '584140000101', timestamp: nowTs() }));
      const m = await processInboundEvent(app, inId!);
      if (m.result !== 'message') throw new Error('se esperaba un mensaje');
      const before = await conversation(m.conversationId);
      await withTenant(app, t.tenantId, async (c) => {
        await c.query(`UPDATE conversations SET mode = 'human' WHERE id = $1`, [m.conversationId]);
        await c.query(`INSERT INTO handoffs (tenant_id, conversation_id, reason) VALUES ($1, $2, 'precio')`, [t.tenantId, m.conversationId]);
      });

      const [echoId] = await ingest(echo({ to: '584140000101', id: 'wamid.ECHO-A' }));
      const outcome = await processInboundEvent(app, echoId!);
      expect(outcome).toMatchObject({ result: 'agent_echo', conversationId: m.conversationId, duplicate: false });

      const conv = await conversation(m.conversationId);
      expect(conv.mode).toBe('human');
      expect(conv.agent_active_at).not.toBeNull();
      // La app no mueve la ventana de 24 h.
      expect(conv.window_expires_at).toEqual(before.window_expires_at);

      const rows = await withTenant(app, t.tenantId, async (c) => ({
        msg: (await c.query(`SELECT direction, author, body, sent_by_user_id FROM messages WHERE external_message_id = 'wamid.ECHO-A'`)).rows[0],
        handoff: (await c.query('SELECT taken_at, returned_at FROM handoffs WHERE conversation_id = $1', [m.conversationId])).rows[0],
      }));
      expect(rows.msg).toEqual({ direction: 'out', author: 'agent', body: 'Buenas, le escribo por la cotización', sent_by_user_id: null });
      expect(rows.handoff.taken_at).not.toBeNull();
      expect(rows.handoff.returned_at).toBeNull();

      // Si el cliente responde ahora, el bot sigue callado.
      const [next] = await ingest(webhook({ from: '584140000101', timestamp: nowTs() }));
      expect(await processInboundEvent(app, next!)).toMatchObject({ result: 'message', mode: 'human', resumed: false });
    });

    it('si el asesor escribe primero a un cliente nuevo, el bot no le contesta', async () => {
      const [echoId] = await ingest(echo({ to: '584140000102' }));
      const outcome = await processInboundEvent(app, echoId!);
      if (outcome.result !== 'agent_echo') throw new Error('se esperaba una copia');
      const [reply] = await ingest(webhook({ from: '584140000102', timestamp: nowTs() }));
      expect(await processInboundEvent(app, reply!)).toMatchObject({ result: 'message', conversationId: outcome.conversationId, mode: 'human' });
    });

    it('ignora la copia de un mensaje que mandó la API', async () => {
      const [inId] = await ingest(webhook({ from: '584140000103', timestamp: nowTs() }));
      const m = await processInboundEvent(app, inId!);
      if (m.result !== 'message') throw new Error('se esperaba un mensaje');
      await withTenant(app, t.tenantId, (c) =>
        c.query(
          `INSERT INTO outbound_messages (tenant_id, conversation_id, idempotency_key, channel, payload, status, external_message_id)
           VALUES ($1, $2, $3, 'whatsapp', '{}', 'sent', 'wamid.OWN-1')`,
          [t.tenantId, m.conversationId, `k-own-${Date.now()}`],
        ),
      );
      const [echoId] = await ingest(echo({ to: '584140000103', id: 'wamid.OWN-1' }));
      expect(await processInboundEvent(app, echoId!)).toEqual({ result: 'ignored', reason: 'copia de un mensaje enviado por la API' });
      expect((await conversation(m.conversationId)).mode).toBe('bot');
      const { rows } = await owner.query('SELECT status FROM webhook_events WHERE id = $1', [echoId]);
      expect(rows[0]?.status).toBe('ignored');
    });

    it('el bot retoma si el asesor lleva más de 12 h sin escribir', async () => {
      const [echoId] = await ingest(echo({ to: '584140000104' }));
      const e = await processInboundEvent(app, echoId!);
      if (e.result !== 'agent_echo') throw new Error('se esperaba una copia');
      await withTenant(app, t.tenantId, async (c) => {
        await c.query(`INSERT INTO handoffs (tenant_id, conversation_id, reason, taken_at) VALUES ($1, $2, 'precio', now())`, [
          t.tenantId,
          e.conversationId,
        ]);
        await c.query(`UPDATE conversations SET agent_active_at = now() - interval '13 hours' WHERE id = $1`, [e.conversationId]);
      });

      const [inId] = await ingest(webhook({ from: '584140000104', timestamp: nowTs() }));
      expect(await processInboundEvent(app, inId!)).toMatchObject({ result: 'message', mode: 'bot', resumed: true });
      expect((await conversation(e.conversationId)).agent_active_at).toBeNull();
      const handoff = await withTenant(app, t.tenantId, async (c) =>
        (await c.query('SELECT returned_at FROM handoffs WHERE conversation_id = $1', [e.conversationId])).rows[0],
      );
      expect(handoff.returned_at).not.toBeNull();
    });

    it('no retoma un chat tomado desde el panel ni si el negocio lo desactivó', async () => {
      const user = await owner.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash) VALUES ($1, 'Asesora', 'x') RETURNING id`,
        [`asesora-${Date.now()}@ejemplo.test`],
      );
      try {
        const [echoId] = await ingest(echo({ to: '584140000105' }));
        const e = await processInboundEvent(app, echoId!);
        if (e.result !== 'agent_echo') throw new Error('se esperaba una copia');
        await owner.query(`UPDATE conversations SET assigned_user_id = $2, agent_active_at = now() - interval '2 days' WHERE id = $1`, [
          e.conversationId,
          user.rows[0]!.id,
        ]);
        const [inId] = await ingest(webhook({ from: '584140000105', timestamp: nowTs() }));
        expect(await processInboundEvent(app, inId!)).toMatchObject({ mode: 'human', resumed: false });

        const [echo2] = await ingest(echo({ to: '584140000106' }));
        const e2 = await processInboundEvent(app, echo2!);
        if (e2.result !== 'agent_echo') throw new Error('se esperaba una copia');
        await owner.query(`UPDATE tenants SET settings = settings || '{"takeover": {"resumeBotAfterMinutes": 0}}' WHERE id = $1`, [t.tenantId]);
        await owner.query(`UPDATE conversations SET agent_active_at = now() - interval '2 days' WHERE id = $1`, [e2.conversationId]);
        const [in2] = await ingest(webhook({ from: '584140000106', timestamp: nowTs() }));
        expect(await processInboundEvent(app, in2!)).toMatchObject({ mode: 'human', resumed: false });
      } finally {
        await owner.query(`UPDATE tenants SET settings = settings - 'takeover' WHERE id = $1`, [t.tenantId]);
        await owner.query('UPDATE conversations SET assigned_user_id = NULL WHERE assigned_user_id = $1', [user.rows[0]!.id]);
        await owner.query('DELETE FROM users WHERE id = $1', [user.rows[0]!.id]);
      }
    });
  });

  describe('historial y conexión del número (coexistencia)', () => {
    const wabaId = `WABA${Date.now()}`;

    /** Un chat del historial con el phone_number_id del tenant de prueba. */
    function history(customer: string, messages: Record<string, unknown>[], progress = 50) {
      const payload = historyWebhook([{ metadata: { phase: 0, chunk_order: 1, progress }, threads: [{ id: customer, messages }] }]);
      (payload.entry[0]!.changes[0]!.value as { metadata: { phone_number_id: string } }).metadata.phone_number_id = t.phoneNumberId;
      return payload;
    }
    const tsAgo = (minutes: number) => String(Math.floor(Date.now() / 1000) - minutes * 60);
    const account = async () => (await owner.query('SELECT * FROM channel_accounts WHERE id = $1', [t.channelAccountId])).rows[0];

    beforeAll(async () => {
      await owner.query('UPDATE channel_accounts SET waba_id = $2 WHERE id = $1', [t.channelAccountId, wabaId]);
    });
    afterAll(async () => {
      await owner.query('DELETE FROM webhook_events WHERE channel_external_account_id = $1', [wabaId]);
    });

    it('importa el chat sin despertar al bot, sin abrir la ventana y antes de lo recibido en vivo', async () => {
      const customer = '584140000201';
      const [live] = await ingest(webhook({ from: customer, timestamp: nowTs() }));
      const m = await processInboundEvent(app, live!);
      if (m.result !== 'message') throw new Error('se esperaba un mensaje');
      const before = await conversation(m.conversationId);

      const [h] = await ingest(
        history(customer, [
          { from: customer, id: `wamid.HA${seq}`, timestamp: tsAgo(60 * 24 * 30), type: 'text', text: { body: 'Buenas, ¿tienen granito?' } },
          { from: '584140000000', id: `wamid.HB${seq}`, timestamp: tsAgo(60 * 24 * 30 - 5), type: 'text', text: { body: 'Buenas tardes, sí tenemos.' } },
        ]),
      );
      expect(await processInboundEvent(app, h!)).toEqual({ result: 'history', tenantId: t.tenantId, conversationId: m.conversationId, imported: 2 });

      const conv = await conversation(m.conversationId);
      // El asesor escribió hace un mes: el bot sigue atendiendo.
      expect(conv.mode).toBe('bot');
      expect(conv.agent_active_at).toBeNull();
      expect(conv.window_expires_at).toEqual(before.window_expires_at);
      expect(conv.last_inbound_at).toEqual(before.last_inbound_at);

      const rows = await withTenant(app, t.tenantId, async (c) =>
        (await c.query('SELECT author, direction, body FROM messages WHERE conversation_id = $1 ORDER BY seq', [m.conversationId])).rows,
      );
      expect(rows.map((r) => `${r.author}:${r.body}`)).toEqual([
        'customer:Buenas, ¿tienen granito?',
        'agent:Buenas tardes, sí tenemos.',
        'customer:¿Tienen porcelanato para exterior?',
      ]);
      expect((await account()).history_status).toBe('importing');
    });

    it('si el asesor escribió hace poco, el chat importado queda en sus manos', async () => {
      const customer = '584140000202';
      const [h] = await ingest(
        history(customer, [
          { from: customer, id: `wamid.HC${seq}`, timestamp: tsAgo(40), type: 'text', text: { body: '¿Me cotiza 20 m²?' } },
          { from: '584140000000', id: `wamid.HD${seq}`, timestamp: tsAgo(30), type: 'text', text: { body: 'Con gusto, ya le preparo la cotización.' } },
        ]),
      );
      const out = await processInboundEvent(app, h!);
      if (out.result !== 'history') throw new Error('se esperaba historial');
      const conv = await conversation(out.conversationId);
      expect(conv.mode).toBe('human');
      expect(conv.agent_active_at).not.toBeNull();
      // Un chat creado por la importación se ordena por su último mensaje.
      expect(new Date(conv.updated_at).getTime()).toBeLessThan(Date.now() - 25 * 60_000);

      const [next] = await ingest(webhook({ from: customer, timestamp: nowTs() }));
      expect(await processInboundEvent(app, next!)).toMatchObject({ result: 'message', mode: 'human', resumed: false });
    });

    it('completa el archivo que llegó después y no duplica lo ya importado', async () => {
      const customer = '584140000203';
      const id = `wamid.HE${seq}`;
      const ts = tsAgo(600);
      const [p] = await ingest(history(customer, [{ from: customer, id, timestamp: ts, type: 'media_placeholder' }]));
      expect(await processInboundEvent(app, p!)).toMatchObject({ result: 'history', imported: 1 });
      const [media] = await ingest(
        history(customer, [{ from: customer, id, timestamp: ts, type: 'image', image: { id: 'media-77', mime_type: 'image/jpeg', caption: 'Como esta' } }], 100),
      );
      expect(await processInboundEvent(app, media!)).toMatchObject({ result: 'history', imported: 0 });

      const msg = await withTenant(app, t.tenantId, async (c) =>
        (await c.query('SELECT type, body, attachments FROM messages WHERE external_message_id = $1', [id])).rows[0],
      );
      expect(msg).toEqual({ type: 'image', body: 'Como esta', attachments: [{ type: 'image', externalMediaId: 'media-77', mimeType: 'image/jpeg', caption: 'Como esta' }] });
      expect(await account()).toMatchObject({ history_status: 'done', history_progress: 100 });
    });

    it('registra que el negocio no compartió su historial', async () => {
      const payload = historyWebhook([{ errors: [{ code: 2593109, title: 'History sync is turned off' }] }]);
      (payload.entry[0]!.changes[0]!.value as { metadata: { phone_number_id: string } }).metadata.phone_number_id = t.phoneNumberId;
      await owner.query('DELETE FROM webhook_events WHERE external_event_id = $1', [`history-declined:${t.phoneNumberId}`]);
      const [id] = await ingest(payload);
      expect(await processInboundEvent(app, id!)).toEqual({
        result: 'account',
        tenantIds: [t.tenantId],
        notice: { type: 'history_declined', scope: 'phone' },
      });
      expect((await account()).history_status).toBe('declined');
      await owner.query('UPDATE channel_accounts SET history_status = NULL, history_progress = NULL WHERE id = $1', [t.channelAccountId]);
    });

    it('marca el número como desconectado por su WABA y lo limpia al reconectar', async () => {
      const time = Math.floor(Date.now() / 1000) - 60;
      const [off] = await ingest(
        accountUpdateWebhook(
          { event: 'PARTNER_REMOVED', waba_info: { waba_id: wabaId }, disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' } },
          wabaId,
          time,
        ),
      );
      expect(await processInboundEvent(app, off!)).toMatchObject({ result: 'account', tenantIds: [t.tenantId], notice: { type: 'disconnected', reason: 'PRIMARY_INACTIVITY' } });
      expect(await account()).toMatchObject({ disconnect_reason: 'PRIMARY_INACTIVITY' });
      expect((await account()).disconnected_at).not.toBeNull();

      const [on] = await ingest(accountUpdateWebhook({ event: 'ACCOUNT_RECONNECTED' }, wabaId, time + 30));
      expect(await processInboundEvent(app, on!)).toMatchObject({ result: 'account', notice: { type: 'reconnected' } });
      expect(await account()).toMatchObject({ disconnected_at: null, disconnect_reason: null });

      const [unknown] = await ingest(accountUpdateWebhook({ event: 'ACCOUNT_OFFBOARDED' }, `${wabaId}X`, time));
      expect(await processInboundEvent(app, unknown!)).toEqual({ result: 'ignored', reason: 'unknown_waba' });
      await owner.query('DELETE FROM webhook_events WHERE channel_external_account_id = $1', [`${wabaId}X`]);
    });
  });

  describe('agenda de la app WhatsApp Business', () => {
    const sync = (items: Record<string, unknown>[]) => stateSyncWebhook(items, t.phoneNumberId);
    const contactOf = async (phone: string) =>
      withTenant(app, t.tenantId, async (c) =>
        (
          await c.query(
            `SELECT ct.name, ci.profile FROM contact_identities ci JOIN contacts ct ON ct.id = ci.contact_id
              WHERE ci.channel = 'whatsapp' AND ci.external_user_id = $1`,
            [phone],
          )
        ).rows[0],
      );

    it('usa el nombre de la agenda, sin pisar uno cambiado en el panel, y lo quita al borrarlo', async () => {
      // Cliente que ya escribió: tenía el nombre de su perfil de WhatsApp.
      const [m] = await ingest(webhook({ from: '584140000301', timestamp: nowTs() }));
      await processInboundEvent(app, m!);
      expect((await contactOf('584140000301')).name).toBe('Cliente Prueba');

      const ts = Math.floor(Date.now() / 1000);
      const [a] = await ingest(sync([{ type: 'contact', action: 'add', contact: { full_name: 'Carmen Obra Pirineos', phone_number: '584140000301' }, metadata: { timestamp: String(ts) } }]));
      expect(await processInboundEvent(app, a!)).toMatchObject({ result: 'contact', tenantId: t.tenantId });
      expect(await contactOf('584140000301')).toMatchObject({ name: 'Carmen Obra Pirineos', profile: { name: 'Cliente Prueba', agendaName: 'Carmen Obra Pirineos' } });

      // Alguien lo renombró en el panel: la agenda ya no lo cambia.
      await owner.query(
        `UPDATE contacts SET name = 'Carmen (arquitecta)' WHERE id = (SELECT contact_id FROM contact_identities WHERE external_user_id = '584140000301' AND tenant_id = $1)`,
        [t.tenantId],
      );
      const [b] = await ingest(sync([{ type: 'contact', action: 'add', contact: { full_name: 'Carmen P.', phone_number: '584140000301' }, metadata: { timestamp: String(ts + 1) } }]));
      await processInboundEvent(app, b!);
      expect(await contactOf('584140000301')).toMatchObject({ name: 'Carmen (arquitecta)', profile: { agendaName: 'Carmen P.' } });

      const [r] = await ingest(sync([{ type: 'contact', action: 'remove', contact: { phone_number: '584140000301' }, metadata: { timestamp: String(ts + 2) } }]));
      await processInboundEvent(app, r!);
      const after = await contactOf('584140000301');
      expect(after.profile.agendaName).toBeUndefined();
      expect(after.name).toBe('Carmen (arquitecta)');
    });

    it('un contacto de la agenda que nunca escribió queda creado, sin conversación', async () => {
      const [a] = await ingest(sync([{ type: 'contact', action: 'add', contact: { full_name: 'Ferretería El Tornillo', phone_number: '584140000302' }, metadata: { timestamp: String(Math.floor(Date.now() / 1000)) } }]));
      const out = await processInboundEvent(app, a!);
      if (out.result !== 'contact' || !out.contactId) throw new Error('se esperaba un contacto');
      expect((await contactOf('584140000302')).name).toBe('Ferretería El Tornillo');
      const convs = await withTenant(app, t.tenantId, async (c) => (await c.query('SELECT 1 FROM conversations WHERE contact_id = $1', [out.contactId])).rowCount);
      expect(convs).toBe(0);
    });
  });
});
