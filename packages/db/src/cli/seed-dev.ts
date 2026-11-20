import pg from 'pg';

/**
 * Crea (o reutiliza) el tenant de Inversiones Mora Mora y su cuenta de WhatsApp para
 * desarrollo local. Usa el rol dueño porque dar de alta tenants es tarea de superadmin.
 *
 * Variables: MIGRATION_DATABASE_URL, DEV_WHATSAPP_PHONE_NUMBER_ID (id de prueba de Meta).
 */
const url = process.env.MIGRATION_DATABASE_URL;
const phoneNumberId = process.env.DEV_WHATSAPP_PHONE_NUMBER_ID;
if (!url || !phoneNumberId) {
  console.error('Faltan MIGRATION_DATABASE_URL o DEV_WHATSAPP_PHONE_NUMBER_ID.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  const tenant = await client.query<{ id: string }>(
    `INSERT INTO tenants (name, slug, timezone, currency, locale, settings)
     VALUES ('Inversiones Mora Mora', 'inversiones-mora-mora', 'America/Caracas', 'USD', 'es', $1)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [JSON.stringify({ catalog: { source: 'imm_store', baseUrl: 'https://inversionesmoramora.com' } })],
  );
  const tenantId = tenant.rows[0]!.id;
  await client.query(
    `INSERT INTO channel_accounts (tenant_id, channel, external_account_id, display_name)
     VALUES ($1, 'whatsapp', $2, 'WhatsApp IMM (desarrollo)')
     ON CONFLICT (channel, external_account_id) DO NOTHING`,
    [tenantId, phoneNumberId],
  );
  await client.query('COMMIT');
  console.log(`Tenant listo: ${tenantId}`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
