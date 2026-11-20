import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { encryptCredentials, parseMasterKey } from '@zenith/core';

/**
 * Crea o actualiza el tenant de Inversiones Mora Mora (config/tenants/inversiones-mora-mora.json)
 * y su cuenta de WhatsApp de prueba. Usa el rol dueño: dar de alta tenants es tarea de superadmin.
 *
 * Variables: MIGRATION_DATABASE_URL, DEV_WHATSAPP_PHONE_NUMBER_ID y, si se quiere enviar
 * mensajes reales, DEV_WHATSAPP_ACCESS_TOKEN + ENCRYPTION_MASTER_KEY.
 */
const url = process.env.MIGRATION_DATABASE_URL;
const phoneNumberId = process.env.DEV_WHATSAPP_PHONE_NUMBER_ID;
const accessToken = process.env.DEV_WHATSAPP_ACCESS_TOKEN;
if (!url || !phoneNumberId) {
  console.error('Faltan MIGRATION_DATABASE_URL o DEV_WHATSAPP_PHONE_NUMBER_ID.');
  process.exit(1);
}

const config = JSON.parse(await readFile(new URL('../../../../config/tenants/inversiones-mora-mora.json', import.meta.url), 'utf8')) as {
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  locale: string;
  settings: unknown;
};

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  const tenant = await client.query<{ id: string }>(
    `INSERT INTO tenants (name, slug, timezone, currency, locale, settings)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone, currency = EXCLUDED.currency,
                                      locale = EXCLUDED.locale, settings = EXCLUDED.settings
     RETURNING id`,
    [config.name, config.slug, config.timezone, config.currency, config.locale, JSON.stringify(config.settings)],
  );
  const tenantId = tenant.rows[0]!.id;

  const account = await client.query<{ id: string }>(
    `INSERT INTO channel_accounts (tenant_id, channel, external_account_id, display_name)
     VALUES ($1, 'whatsapp', $2, 'WhatsApp IMM (desarrollo)')
     ON CONFLICT (channel, external_account_id) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [tenantId, phoneNumberId],
  );
  const accountId = account.rows[0]!.id;

  if (accessToken) {
    const masterKey = parseMasterKey(process.env.ENCRYPTION_MASTER_KEY);
    const enc = encryptCredentials(JSON.stringify({ accessToken }), masterKey, accountId);
    await client.query('UPDATE channel_accounts SET credentials_enc = $2, credentials_key_id = $3 WHERE id = $1', [
      accountId,
      enc,
      process.env.ENCRYPTION_MASTER_KEY_ID ?? null,
    ]);
  }

  await client.query('COMMIT');
  console.log(`Tenant listo: ${tenantId}${accessToken ? ' (con credenciales de WhatsApp cifradas)' : ' (sin credenciales de envío)'}`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
