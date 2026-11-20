import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { parseWhatsAppWebhook } from '@zenith/channel-whatsapp';
import { insertWebhookEvent, reclaimStaleWebhookEvents, withTenant, type Pool } from '@zenith/db';
import { processInboundEvent } from '../src/inbound.js';
import { hasDb, seedTenant, setupDb } from '../../../packages/db/test/helpers.js';
import { statusWebhook, textWebhook } from '../../../packages/channel-whatsapp/test/fixtures.js';

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
});
