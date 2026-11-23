import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { parseWhatsAppWebhook } from '@zenith/channel-whatsapp';
import { insertWebhookEvent, reclaimStaleWebhookEvents, withTenant, type Pool } from '@zenith/db';
import { processInboundEvent } from '../src/inbound.js';
import { hasDb, seedTenant, setupDb } from '../../../packages/db/test/helpers.js';
import { echoWebhook, statusWebhook, textWebhook } from '../../../packages/channel-whatsapp/test/fixtures.js';

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
});
