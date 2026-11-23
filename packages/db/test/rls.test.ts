import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { resolveChannelAccount, withTenant, type Pool } from '../src/index.js';
import { hasDb, seedTenant, setupDb } from './helpers.js';

describe.skipIf(!hasDb)('aislamiento multi-tenant (RLS)', () => {
  let owner: pg.Pool;
  let app: Pool;
  let a: Awaited<ReturnType<typeof seedTenant>>;
  let b: Awaited<ReturnType<typeof seedTenant>>;

  beforeAll(async () => {
    ({ owner, app } = await setupDb());
    a = await seedTenant(owner, 'a');
    b = await seedTenant(owner, 'b');
    await owner.query('INSERT INTO contacts (tenant_id, name) VALUES ($1, $2), ($3, $4)', [a.tenantId, 'Contacto A', b.tenantId, 'Contacto B']);
  });

  afterAll(async () => {
    await owner?.query('DELETE FROM tenants WHERE id = ANY($1)', [[a?.tenantId, b?.tenantId].filter(Boolean)]);
    await owner?.end();
    await app?.end();
  });

  it('cada tenant solo ve sus propios contactos', async () => {
    const seenByA = await withTenant(app, a.tenantId, async (c) => (await c.query('SELECT name, tenant_id FROM contacts')).rows);
    expect(seenByA.every((r) => r.tenant_id === a.tenantId)).toBe(true);
    expect(seenByA.map((r) => r.name)).toContain('Contacto A');
    expect(seenByA.map((r) => r.name)).not.toContain('Contacto B');
  });

  it('sin tenant fijado no se ve nada', async () => {
    const { rows } = await app.query('SELECT * FROM contacts');
    expect(rows).toHaveLength(0);
    expect((await app.query('SELECT * FROM tenants')).rows).toHaveLength(0);
  });

  it('no se puede escribir en otro tenant', async () => {
    await expect(
      withTenant(app, a.tenantId, (c) => c.query('INSERT INTO contacts (tenant_id, name) VALUES ($1, $2)', [b.tenantId, 'intruso'])),
    ).rejects.toThrow(/row-level security/);
  });

  it('no se puede modificar datos de otro tenant', async () => {
    const { rowCount } = await withTenant(app, a.tenantId, (c) =>
      c.query('UPDATE contacts SET name = $1 WHERE tenant_id = $2', ['hackeado', b.tenantId]),
    );
    expect(rowCount).toBe(0);
    const { rows } = await owner.query('SELECT name FROM contacts WHERE tenant_id = $1', [b.tenantId]);
    expect(rows[0]?.name).toBe('Contacto B');
  });

  it('el tenant fijado no se filtra a la siguiente transacción de la misma conexión', async () => {
    const single = (await import('../src/index.js')).createPool(process.env.TEST_DATABASE_URL!, 1);
    try {
      await withTenant(single, a.tenantId, (c) => c.query('SELECT 1'));
      const { rows } = await single.query('SELECT * FROM contacts');
      expect(rows).toHaveLength(0);
    } finally {
      await single.end();
    }
  });

  it('la app no crea tenants y solo conecta números de su propio negocio', async () => {
    await expect(app.query(`INSERT INTO tenants (name, slug) VALUES ('x', 'x-hack')`)).rejects.toThrow(/permission denied/);
    // Conectar un número (panel → Embedded Signup) sí, pero solo en el negocio de la sesión.
    await expect(
      withTenant(app, a.tenantId, (c) =>
        c.query(`INSERT INTO channel_accounts (tenant_id, channel, external_account_id) VALUES ($1, 'whatsapp', '999')`, [b.tenantId]),
      ),
    ).rejects.toThrow(/row-level security/);
    const own = `rls-${Date.now()}`;
    await withTenant(app, a.tenantId, (c) =>
      c.query(`INSERT INTO channel_accounts (tenant_id, channel, external_account_id) VALUES ($1, 'whatsapp', $2)`, [a.tenantId, own]),
    );
    // No puede cambiar de dueño, de número ni reactivar una cuenta desactivada.
    for (const col of [`tenant_id = '${b.tenantId}'`, `external_account_id = 'otro'`, `status = 'active'`]) {
      await expect(
        withTenant(app, a.tenantId, (c) => c.query(`UPDATE channel_accounts SET ${col} WHERE external_account_id = $1`, [own])),
      ).rejects.toThrow(/permission denied/);
    }
    await owner.query('DELETE FROM channel_accounts WHERE external_account_id = $1', [own]);
  });

  it('resolve_channel_account encuentra el tenant sin exponer otros datos', async () => {
    expect(await resolveChannelAccount(app, 'whatsapp', a.phoneNumberId)).toEqual({
      channelAccountId: a.channelAccountId,
      tenantId: a.tenantId,
    });
    expect(await resolveChannelAccount(app, 'whatsapp', 'no-existe')).toBeNull();
    expect(await resolveChannelAccount(app, 'instagram', a.phoneNumberId)).toBeNull();
  });

  it('una cuenta de un tenant suspendido no se resuelve', async () => {
    await owner.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [b.tenantId]);
    expect(await resolveChannelAccount(app, 'whatsapp', b.phoneNumberId)).toBeNull();
    await owner.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [b.tenantId]);
  });

  it('rechaza tenantId que no es uuid', async () => {
    await expect(withTenant(app, "x'; DROP TABLE contacts; --", async () => 1)).rejects.toThrow('tenantId inválido');
  });
});
