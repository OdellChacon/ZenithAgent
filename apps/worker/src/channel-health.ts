import { decryptCredentials, type Channel } from '@zenith/core';
import { getPhoneInfo, isMetaAuthError } from '@zenith/channel-whatsapp';
import { getPageInfo, MetaOnboardingError } from '@zenith/channel-meta';
import { withTenant, type Pool } from '@zenith/db';
import type { Mailer } from './notify.js';

/**
 * Salud del token de cada cuenta de canal. El token de integración de negocio de Meta no
 * vence por defecto, pero se puede revocar (el negocio quita la app) o configurarse a 60 días.
 * Una vez al día se le pregunta a Meta por la cuenta con su token: si lo rechaza, la cuenta
 * queda marcada y el equipo recibe un aviso; si un token marcado vuelve a funcionar, se limpia.
 */
export interface ChannelHealthDeps {
  pool: Pool;
  masterKey: Buffer;
  graphApiVersion: string;
  graphBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Cada cuánto se revisa cada cuenta. */
  everyMs?: number;
  log?: (msg: string, data: Record<string, unknown>) => void;
}

/** Se avisa cuando faltan estos días para que venza el token. */
export const TOKEN_EXPIRY_WARNING_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type HealthFinding = { tenantId: string; channelAccountId: string; state: 'invalid' | 'expiring' | 'recovered' };

interface AccountRow {
  id: string;
  channel: Channel;
  external_account_id: string;
  credentials_enc: Buffer;
  credentials_invalid_at: Date | null;
  token_expires_at: Date | null;
}

/** Pregunta a Meta por la cuenta. 'invalid' si rechaza el token; 'unknown' si falló por otra cosa. */
async function probe(deps: ChannelHealthDeps, row: AccountRow): Promise<'ok' | 'invalid' | 'unknown'> {
  let creds: { accessToken?: string; pageId?: string };
  try {
    creds = JSON.parse(decryptCredentials(row.credentials_enc, deps.masterKey, row.id)) as typeof creds;
  } catch {
    return 'unknown';
  }
  if (!creds.accessToken) return 'unknown';
  const graph = {
    graphApiVersion: deps.graphApiVersion,
    ...(deps.graphBaseUrl ? { graphBaseUrl: deps.graphBaseUrl } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
  try {
    if (row.channel === 'whatsapp') await getPhoneInfo(graph, creds.accessToken, row.external_account_id);
    else {
      const pageId = row.channel === 'messenger' ? row.external_account_id : creds.pageId;
      if (!pageId) return 'unknown';
      await getPageInfo(graph, creds.accessToken, pageId);
    }
    return 'ok';
  } catch (err) {
    if (isMetaAuthError(err)) return 'invalid';
    if (err instanceof MetaOnboardingError && (err.errorCode === 0 || err.errorCode === 190)) return 'invalid';
    return 'unknown';
  }
}

/** Revisa las cuentas que tocan hoy. Devuelve lo que cambió o hay que avisar. */
export async function checkChannelTokens(deps: ChannelHealthDeps): Promise<HealthFinding[]> {
  const now = deps.now?.() ?? new Date();
  const everyMs = deps.everyMs ?? DAY_MS;
  const findings: HealthFinding[] = [];
  const { rows: tenants } = await deps.pool.query<{ id: string }>('SELECT active_tenant_ids() AS id');
  for (const { id: tenantId } of tenants) {
    const accounts = await withTenant(deps.pool, tenantId, async (c) =>
      (
        await c.query<AccountRow>(
          `SELECT id, channel, external_account_id, credentials_enc, credentials_invalid_at, token_expires_at
             FROM channel_accounts
            WHERE status = 'active' AND credentials_enc IS NOT NULL AND channel IN ('whatsapp', 'messenger', 'instagram')
              AND (credentials_checked_at IS NULL OR credentials_checked_at < $1)`,
          [new Date(now.getTime() - everyMs)],
        )
      ).rows,
    );
    for (const row of accounts) {
      const state = await probe(deps, row);
      // false si la cuenta se volvió a conectar mientras se revisaba: lo revisado ya no aplica.
      const applied = await withTenant(deps.pool, tenantId, async (c) => {
        if (state === 'invalid') {
          return (await c.query(
            `UPDATE channel_accounts SET credentials_invalid_at = COALESCE(credentials_invalid_at, $2),
                    credentials_error = COALESCE(credentials_error, 'Meta rechazó el token en la revisión diaria'), credentials_checked_at = $2
              WHERE id = $1 AND credentials_enc = $3`,
            [row.id, now, row.credentials_enc],
          )).rowCount === 1;
        }
        if (state === 'ok') {
          return (await c.query(
            `UPDATE channel_accounts SET credentials_invalid_at = NULL, credentials_error = NULL, credentials_checked_at = $2
              WHERE id = $1 AND credentials_enc = $3`,
            [row.id, now, row.credentials_enc],
          )).rowCount === 1;
        }
        // Meta no respondió o falló por otra cosa: se vuelve a probar en la próxima pasada.
        deps.log?.('no se pudo revisar el token de una cuenta', { channelAccountId: row.id });
        return false;
      });
      if (!applied) continue;
      if (state === 'invalid' && !row.credentials_invalid_at) findings.push({ tenantId, channelAccountId: row.id, state: 'invalid' });
      if (state === 'ok' && row.credentials_invalid_at) findings.push({ tenantId, channelAccountId: row.id, state: 'recovered' });
      if (
        state === 'ok' &&
        row.token_expires_at &&
        new Date(row.token_expires_at).getTime() - now.getTime() < TOKEN_EXPIRY_WARNING_DAYS * DAY_MS
      ) {
        findings.push({ tenantId, channelAccountId: row.id, state: 'expiring' });
      }
    }
  }
  return findings;
}

const CHANNEL_NAMES: Record<string, string> = { whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram', tiktok: 'TikTok' };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Correo al equipo: el token de una cuenta fue rechazado o está por vencer. Como mucho uno por
 * día, cuenta y tipo de aviso, aunque fallen muchos envíos seguidos; un "sin acceso" sale aunque
 * ese día ya haya salido un "vence pronto". El aviso se reserva antes de mandarlo (así dos
 * workers a la vez no mandan dos correos) y, si el correo no sale, se devuelve la reserva para
 * que el siguiente intento vuelva a avisar.
 */
export async function notifyCredentials(
  deps: { pool: Pool; mailer: Mailer; panelUrl: string; now?: () => Date },
  tenantId: string,
  channelAccountId: string,
  state: 'invalid' | 'expiring',
): Promise<'sent' | 'throttled' | 'no_recipients'> {
  const now = deps.now?.() ?? new Date();
  const info = await withTenant(deps.pool, tenantId, async (c) => {
    const { rows } = await c.query<{
      tenant: string;
      name: string;
      channel: string;
      token_expires_at: Date | null;
      prev_at: Date | null;
      prev_state: string | null;
    }>(
      `UPDATE channel_accounts ca SET credentials_alerted_at = $2, credentials_alert_state = $4
         FROM tenants t,
              (SELECT id, credentials_alerted_at AS prev_at, credentials_alert_state AS prev_state FROM channel_accounts WHERE id = $1) p
        WHERE ca.id = $1 AND p.id = ca.id AND t.id = ca.tenant_id
          AND (ca.credentials_alerted_at IS NULL OR ca.credentials_alerted_at < $3
               OR ($4 = 'invalid' AND ca.credentials_alert_state IS DISTINCT FROM 'invalid'))
        RETURNING t.name AS tenant, coalesce(ca.display_name, ca.external_account_id) AS name, ca.channel, ca.token_expires_at,
                  p.prev_at, p.prev_state`,
      [channelAccountId, now, new Date(now.getTime() - DAY_MS), state],
    );
    return rows[0];
  });
  if (!info) return 'throttled';

  /** El correo no salió: se libera la reserva (solo si sigue siendo la nuestra). */
  const release = () =>
    withTenant(deps.pool, tenantId, (c) =>
      c.query(
        `UPDATE channel_accounts SET credentials_alerted_at = $3, credentials_alert_state = $4
          WHERE id = $1 AND credentials_alerted_at = $2`,
        [channelAccountId, now, info.prev_at, info.prev_state],
      ),
    );

  const { rows: recipients } = await deps.pool.query<{ email: string }>(
    `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.notify_email AND u.status = 'active'`,
    [tenantId],
  );
  if (!recipients.length) {
    await release();
    return 'no_recipients';
  }

  const channel = CHANNEL_NAMES[info.channel] ?? info.channel;
  const link = new URL('/', deps.panelUrl).toString();
  const when = info.token_expires_at ? new Date(info.token_expires_at).toLocaleDateString('es-VE', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  const subject =
    state === 'invalid'
      ? `${channel} sin acceso en ${info.tenant}: el bot no puede enviar mensajes`
      : `El acceso a ${channel} de ${info.tenant} vence${when ? ` el ${when}` : ' pronto'}`;
  const body =
    state === 'invalid'
      ? `Meta rechazó el acceso del sistema a ${info.name} (${channel}): el permiso venció o alguien quitó la app de la cuenta. ` +
        'Mientras tanto el bot no puede enviar mensajes en esa cuenta. Hay que volver a conectarla desde el panel.'
      : `El acceso del sistema a ${info.name} (${channel}) vence${when ? ` el ${when}` : ' en menos de una semana'}. ` +
        'Para que el bot no deje de responder, vuelvan a conectar la cuenta desde el panel antes de esa fecha.';
  try {
    await deps.mailer.send({
      to: recipients.map((r) => r.email),
      subject,
      text: `${body}\n\nPanel: ${link}\n`,
      html: `<p>${escapeHtml(body)}</p><p><a href="${escapeHtml(link)}">Abrir el panel</a></p>`,
    });
  } catch (err) {
    await release().catch(() => undefined);
    throw err;
  }
  return 'sent';
}
