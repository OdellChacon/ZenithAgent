/**
 * Conecta la página de Facebook de un negocio (Messenger) y, si tiene, la cuenta de Instagram
 * vinculada. Hasta que la app de Meta pase la revisión, el token de la página se saca a mano
 * (Meta Business Suite o el Explorador de la Graph API) y se conecta con este comando.
 *
 *   META_PAGE_ACCESS_TOKEN=... npm run channel:connect-meta -- --tenant inversiones-mora-mora --page-id 1234567890 [--instagram]
 *
 * El token va por variable de entorno, no como argumento, para que no quede en el historial
 * de la terminal. Se guarda cifrado con ENCRYPTION_MASTER_KEY. Usa MIGRATION_DATABASE_URL
 * (rol dueño), igual que el seed: la app no puede crear cuentas de canal de otros negocios.
 */
import { parseArgs } from 'node:util';
import { encryptCredentials, parseMasterKey } from '@zenith/core';
import { getPageInfo, subscribePage } from '@zenith/channel-meta';
import { createPool } from '@zenith/db';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    'page-id': { type: 'string' },
    instagram: { type: 'boolean', default: false },
    'skip-subscribe': { type: 'boolean', default: false },
  },
});

const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const url = process.env.MIGRATION_DATABASE_URL ?? fail('Falta MIGRATION_DATABASE_URL');
const token = process.env.META_PAGE_ACCESS_TOKEN?.trim() || fail('Falta META_PAGE_ACCESS_TOKEN (token de la página)');
const version = process.env.META_GRAPH_API_VERSION ?? fail('Falta META_GRAPH_API_VERSION');
const masterKey = parseMasterKey(process.env.ENCRYPTION_MASTER_KEY);
const slug = values.tenant ?? fail('Falta --tenant <slug del negocio>');
const pageId = values['page-id'] ?? fail('Falta --page-id <id de la página>');
if (!/^\d{1,32}$/.test(pageId)) fail('El id de la página son solo números');

const graph = { graphApiVersion: version, ...(process.env.META_GRAPH_BASE_URL ? { graphBaseUrl: process.env.META_GRAPH_BASE_URL } : {}) };
const page = await getPageInfo(graph, token, pageId);
if (values.instagram && !page.instagram) fail('La página no tiene una cuenta de Instagram profesional vinculada');
if (!values['skip-subscribe']) await subscribePage(graph, token, pageId);

const client = createPool(url, 1);

try {
  const tenant = (await client.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [slug])).rows[0] ?? fail(`No existe el negocio ${slug}`);

  const upsert = async (channel: 'messenger' | 'instagram', externalId: string, name: string | null) => {
    const owner = await client.query<{ tenant_id: string }>('SELECT tenant_id FROM channel_accounts WHERE channel = $1 AND external_account_id = $2', [
      channel,
      externalId,
    ]);
    if (owner.rows[0] && owner.rows[0].tenant_id !== tenant.id) fail(`Esa cuenta de ${channel} ya está conectada en otro negocio`);
    const row = await client.query<{ id: string; tenant_id: string }>(
      `INSERT INTO channel_accounts (tenant_id, channel, external_account_id, display_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel, external_account_id) DO UPDATE
         SET display_name = COALESCE(EXCLUDED.display_name, channel_accounts.display_name), connected_at = now(), status = 'active'
       RETURNING id, tenant_id`,
      [tenant.id, channel, externalId, name],
    );
    const account = row.rows[0]!;
    const enc = encryptCredentials(JSON.stringify({ accessToken: token, pageId }), masterKey, account.id);
    await client.query(
      `UPDATE channel_accounts SET credentials_enc = $2, credentials_key_id = $3, credentials_invalid_at = NULL, credentials_error = NULL,
              credentials_checked_at = now(), credentials_alerted_at = NULL, disconnected_at = NULL, disconnect_reason = NULL
        WHERE id = $1`,
      [account.id, enc, process.env.ENCRYPTION_MASTER_KEY_ID ?? null],
    );
    console.log(`${channel}: ${name ?? externalId} conectado (cuenta ${account.id})`);
  };

  await upsert('messenger', pageId, page.name);
  if (values.instagram && page.instagram) {
    await upsert('instagram', page.instagram.id, page.instagram.username ? `@${page.instagram.username}` : page.name);
  }
} finally {
  await client.end();
}
