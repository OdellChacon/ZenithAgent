/**
 * Revisión previa a la prueba con un número real (docs/prueba-numero-real.md). Comprueba, sin
 * mandarle nada a ningún cliente:
 * 1. Que el sistema responde en https (/healthz: base de datos, Redis y worker).
 * 2. Que Meta puede validar cada webhook (el mismo GET que hace Meta al configurarlo).
 * 3. Por cada cuenta conectada: que el token sirve, que la app está suscrita a la cuenta de
 *    WhatsApp Business y que la plantilla de seguimiento está aprobada.
 *
 *   npm run check:meta -- --url https://bot.ejemplo.com
 *   (en el servidor) sh deploy/admin.sh check-meta --url https://bot.ejemplo.com
 *
 * Usa MIGRATION_DATABASE_URL (lee las cuentas de todos los negocios). No imprime tokens.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { decryptCredentials, parseMasterKey } from '@zenith/core';
import { getPhoneInfo, listWhatsAppTemplates } from '@zenith/channel-whatsapp';
import { getPageInfo } from '@zenith/channel-meta';
import { createPool } from '@zenith/db';

const { values } = parseArgs({ options: { url: { type: 'string' }, tenant: { type: 'string' } } });
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const dbUrl = process.env.MIGRATION_DATABASE_URL ?? fail('Falta MIGRATION_DATABASE_URL');
const version = process.env.META_GRAPH_API_VERSION ?? fail('Falta META_GRAPH_API_VERSION');
const masterKey = parseMasterKey(process.env.ENCRYPTION_MASTER_KEY);
const graph = { graphApiVersion: version, timeoutMs: 15_000, ...(process.env.META_GRAPH_BASE_URL ? { graphBaseUrl: process.env.META_GRAPH_BASE_URL } : {}) };

let failures = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const warn = (msg: string) => console.log(`  ! ${msg}`);

// ---------------------------------------------------------------- 1 y 2: servidor y webhooks
if (values.url) {
  const base = new URL(values.url);
  if (base.protocol !== 'https:') warn('La URL no es https: Meta no acepta webhooks sin https.');
  console.log(`\nServidor ${base.origin}`);
  try {
    const res = await fetch(new URL('/healthz', base), { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json().catch(() => null)) as { checks?: Record<string, boolean> } | null;
    if (res.ok) ok(`/healthz responde: ${Object.keys(body?.checks ?? {}).join(', ') || 'ok'}`);
    else bad(`/healthz respondió ${res.status}: falla ${Object.entries(body?.checks ?? {}).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'algo'}`);
  } catch (err) {
    bad(`No se pudo conectar con ${base.origin}: ${(err as Error).message}`);
  }
  const verify = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!verify) bad('Falta META_WEBHOOK_VERIFY_TOKEN');
  else {
    for (const channel of ['whatsapp', 'messenger', 'instagram']) {
      const challenge = randomBytes(8).toString('hex');
      const u = new URL(`/webhooks/meta/${channel}`, base);
      u.searchParams.set('hub.mode', 'subscribe');
      u.searchParams.set('hub.verify_token', verify);
      u.searchParams.set('hub.challenge', challenge);
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(10_000) });
        const text = await res.text();
        if (res.ok && text === challenge) ok(`Webhook de ${channel}: Meta lo puede validar (${u.origin}${u.pathname})`);
        else bad(`Webhook de ${channel}: respondió ${res.status}; revisa META_WEBHOOK_VERIFY_TOKEN y que /webhooks llegue al gateway`);
      } catch (err) {
        bad(`Webhook de ${channel}: ${(err as Error).message}`);
      }
    }
  }
} else {
  warn('Sin --url no se revisan /healthz ni los webhooks.');
}

// ---------------------------------------------------------------- 3: cuentas conectadas
const pool = createPool(dbUrl, 2);
try {
  const { rows } = await pool.query<{
    id: string;
    tenant: string;
    settings: { followups?: { template?: { name?: string; language?: string } } } | null;
    channel: string;
    external_account_id: string;
    display_name: string | null;
    waba_id: string | null;
    credentials_enc: Buffer | null;
    credentials_invalid_at: Date | null;
    token_expires_at: Date | null;
    disconnected_at: Date | null;
    disconnect_reason: string | null;
  }>(
    `SELECT ca.id, t.name AS tenant, t.settings, ca.channel, ca.external_account_id, ca.display_name, ca.waba_id, ca.credentials_enc,
            ca.credentials_invalid_at, ca.token_expires_at, ca.disconnected_at, ca.disconnect_reason
       FROM channel_accounts ca JOIN tenants t ON t.id = ca.tenant_id
      WHERE ca.status = 'active' AND t.status = 'active' AND ($1::text IS NULL OR t.slug = $1)
      ORDER BY t.name, ca.channel`,
    [values.tenant ?? null],
  );
  if (!rows.length) bad('No hay cuentas de canal conectadas');
  for (const r of rows) {
    console.log(`\n${r.tenant} · ${r.channel} · ${r.display_name ?? r.external_account_id}`);
    if (r.disconnected_at) bad(`Meta desconectó esta cuenta (${r.disconnect_reason ?? 'sin motivo'}): hay que volver a conectarla`);
    if (r.credentials_invalid_at) bad('Meta rechazó el token en el último envío o revisión: hay que volver a conectarla');
    if (r.token_expires_at) {
      const days = Math.round((new Date(r.token_expires_at).getTime() - Date.now()) / 86_400_000);
      if (days < 7) bad(`El token vence en ${days} días`);
      else warn(`El token vence en ${days} días (lo ideal es un token que no venza)`);
    }
    if (!r.credentials_enc) {
      bad('No tiene token guardado');
      continue;
    }
    let creds: { accessToken?: string; pageId?: string };
    try {
      creds = JSON.parse(decryptCredentials(r.credentials_enc, masterKey, r.id)) as typeof creds;
    } catch {
      bad('No se pudo descifrar el token: ¿cambió ENCRYPTION_MASTER_KEY?');
      continue;
    }
    if (!creds.accessToken) {
      bad('El token guardado está vacío');
      continue;
    }
    try {
      if (r.channel === 'whatsapp') {
        const info = await getPhoneInfo(graph, creds.accessToken, r.external_account_id);
        ok(`Token válido: ${info.verifiedName ?? ''} ${info.displayPhoneNumber ?? ''}${info.isOnBizApp ? ' (también en la app WhatsApp Business)' : ''}`.trim());
        if (!r.waba_id) bad('Falta el id de la cuenta de WhatsApp Business: vuelve a conectar el número desde el panel');
        else {
          const tpl = r.settings?.followups?.template;
          const templates = await listWhatsAppTemplates(graph, creds.accessToken, r.waba_id);
          if (tpl?.name) {
            const found = templates.find((t) => t.name === tpl.name && (!tpl.language || t.language === tpl.language));
            if (found) ok(`Plantilla de seguimiento "${tpl.name}" aprobada (${found.category})`);
            else bad(`La plantilla de seguimiento "${tpl.name}" no está aprobada: el seguimiento después de 24 h no va a salir`);
          }
          ok(`${templates.length} plantilla(s) aprobada(s) disponibles para los asesores`);
        }
      } else if (r.channel === 'messenger' || r.channel === 'instagram') {
        const pageId = r.channel === 'messenger' ? r.external_account_id : creds.pageId;
        if (!pageId) bad('Falta la página vinculada');
        else {
          const page = await getPageInfo(graph, creds.accessToken, pageId);
          ok(`Token de la página válido: ${page.name ?? pageId}`);
          if (r.channel === 'instagram' && page.instagram?.id !== r.external_account_id) bad('La cuenta de Instagram ya no está vinculada a esa página');
        }
      }
    } catch (err) {
      bad(`Meta respondió: ${(err as Error).message}`);
    }
  }
} finally {
  await pool.end();
}

console.log(failures ? `\n${failures} problema(s) por resolver antes de la prueba.` : '\nTodo en orden para la prueba con el número real.');
process.exit(failures ? 1 : 0);
