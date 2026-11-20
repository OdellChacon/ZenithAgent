import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Pool } from '@zenith/db';
import { processNotifyJob, type MailMessage } from '../src/notify.js';
import { hasDb, seedTenant, setupDb } from '../../../packages/db/test/helpers.js';

describe.skipIf(!hasDb)('aviso por correo al derivar', () => {
  let owner: pg.Pool;
  let app: Pool;
  let t: Awaited<ReturnType<typeof seedTenant>>;
  const userIds: string[] = [];
  const run = randomUUID().slice(0, 8);

  async function handoff(name: string | null) {
    const contact = await owner.query<{ id: string }>('INSERT INTO contacts (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING id', [
      t.tenantId,
      name,
      '584149990000',
    ]);
    const conv = await owner.query<{ id: string }>('INSERT INTO conversations (tenant_id, contact_id, channel_account_id, mode) VALUES ($1, $2, $3, $4) RETURNING id', [
      t.tenantId,
      contact.rows[0]!.id,
      t.channelAccountId,
      'human',
    ]);
    const h = await owner.query<{ id: string }>(
      `INSERT INTO handoffs (tenant_id, conversation_id, reason, summary) VALUES ($1, $2, 'precio', 'Pide <b>precio</b> del Aconna.') RETURNING id`,
      [t.tenantId, conv.rows[0]!.id],
    );
    return { conversationId: conv.rows[0]!.id, handoffId: h.rows[0]!.id };
  }

  beforeAll(async () => {
    ({ owner, app } = await setupDb());
    t = await seedTenant(owner, 'notify');
    for (const [key, notify] of [['ana', true], ['beto', false]] as const) {
      const u = await owner.query<{ id: string }>(`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [
        `${key}-${run}@prueba.test`,
        key,
      ]);
      userIds.push(u.rows[0]!.id);
      await owner.query(`INSERT INTO memberships (user_id, tenant_id, role, notify_email) VALUES ($1, $2, 'agent', $3)`, [u.rows[0]!.id, t.tenantId, notify]);
    }
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM tenants WHERE id = $1', [t?.tenantId]);
      await owner.end();
    }
    await app?.end();
  });

  it('escribe a los asesores que tienen el aviso activo, con resumen y enlace, sin el teléfono', async () => {
    const sent: MailMessage[] = [];
    const h = await handoff('Carla');
    const outcome = await processNotifyJob(
      { pool: app, mailer: { send: async (m) => void sent.push(m) }, panelUrl: 'https://panel.ejemplo.test' },
      { tenantId: t.tenantId, ...h },
    );
    expect(outcome).toEqual({ result: 'sent', recipients: 1 });
    expect(sent[0]!.to).toEqual([`ana-${run}@prueba.test`]);
    expect(sent[0]!.subject).toBe('Carla espera a un asesor · Pide precio o cotización');
    expect(sent[0]!.text).toContain(`https://panel.ejemplo.test/conversaciones/${h.conversationId}`);
    expect(sent[0]!.html).toContain('Pide &lt;b&gt;precio&lt;/b&gt;');
    expect(sent[0]!.text).not.toContain('584149990000');
  });

  it('no avisa si alguien ya tomó la conversación', async () => {
    const h = await handoff(null);
    await owner.query('UPDATE handoffs SET taken_at = now() WHERE id = $1', [h.handoffId]);
    const outcome = await processNotifyJob({ pool: app, mailer: { send: async () => undefined }, panelUrl: 'https://x.test' }, { tenantId: t.tenantId, ...h });
    expect(outcome).toEqual({ result: 'skipped', reason: 'already_taken' });
  });
});
