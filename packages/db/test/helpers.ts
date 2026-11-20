import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool, migrate } from '../src/index.js';

/**
 * Las pruebas de integración necesitan Postgres local (docker compose up -d) y dos URLs:
 * - TEST_DATABASE_URL: rol de la app (sujeto a RLS).
 * - TEST_MIGRATION_DATABASE_URL: rol dueño, para migrar y sembrar datos.
 * Sin ellas, las pruebas se saltan.
 */
export const APP_URL = process.env.TEST_DATABASE_URL;
export const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL;
export const hasDb = Boolean(APP_URL && OWNER_URL);

export async function setupDb() {
  await migrate(OWNER_URL!);
  const owner = new pg.Pool({ connectionString: OWNER_URL!, max: 2 });
  const app = createPool(APP_URL!, 5);
  return { owner, app };
}

export async function seedTenant(owner: pg.Pool, label: string) {
  const suffix = randomUUID().slice(0, 8);
  const tenant = await owner.query<{ id: string }>(
    'INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id',
    [`Prueba ${label}`, `test-${label}-${suffix}`],
  );
  const tenantId = tenant.rows[0]!.id;
  const phoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const account = await owner.query<{ id: string }>(
    `INSERT INTO channel_accounts (tenant_id, channel, external_account_id) VALUES ($1, 'whatsapp', $2) RETURNING id`,
    [tenantId, phoneNumberId],
  );
  return { tenantId, channelAccountId: account.rows[0]!.id, phoneNumberId };
}
