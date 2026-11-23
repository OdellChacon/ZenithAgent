import { decryptCredentials, windowState, type Channel, type OutboundJobData } from '@zenith/core';
import {
  sendWhatsAppImage,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  uploadWhatsAppMedia,
  type SendResult,
  type WhatsAppSendConfig,
} from '@zenith/channel-whatsapp';
import { withTenant, type Pool } from '@zenith/db';

export interface OutboundDeps {
  pool: Pool;
  masterKey: Buffer;
  graphApiVersion: string;
  graphBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  maxAttempts?: number;
}

export type OutboundOutcome =
  | { result: 'sent'; externalMessageId: string }
  | { result: 'skipped' }
  | { result: 'blocked_window' }
  | { result: 'failed'; reason: string };

interface Claimed {
  id: string;
  message_id: string | null;
  conversation_id: string;
  attempts: number;
  payload:
    | { kind: 'text'; text: string; to: string; author: 'bot' | 'agent' }
    | { kind: 'image'; productImageId: string; caption?: string; to: string; author: 'bot' | 'agent' }
    | { kind: 'template'; name: string; language: string; bodyParams: string[]; to: string; author: 'bot' | 'agent' };
  channel: Channel;
  last_inbound_at: Date | null;
  channel_account_id: string;
  external_account_id: string;
  credentials_enc: Buffer | null;
}

/** El bot deja de usar texto libre un minuto antes de que cierre la ventana de 24 h. */
const BOT_SAFETY_MARGIN_MS = 60_000;

export class RetryableSendError extends Error {
  override name = 'RetryableSendError';
}

/** WhatsApp guarda los archivos subidos 30 días; se reutilizan hasta 25 para tener margen. */
const MEDIA_REUSE_DAYS = 25;

type MediaLookup = { ok: true; mediaId: string; cached: boolean } | { ok: false; retryable: boolean; message: string };

/** Devuelve el id de WhatsApp de una foto: el guardado si sigue vigente, o la sube. */
async function resolveMedia(
  deps: OutboundDeps,
  tenantId: string,
  channelAccountId: string,
  productImageId: string,
  config: WhatsAppSendConfig,
): Promise<MediaLookup> {
  const found = await withTenant(deps.pool, tenantId, async (client) => {
    const image = await client.query<{ data: Buffer; mime_type: 'image/jpeg' | 'image/png'; sha256: string }>(
      'SELECT data, mime_type, sha256 FROM product_images WHERE id = $1',
      [productImageId],
    );
    const cached = await client.query<{ external_media_id: string; image_sha256: string }>(
      `SELECT external_media_id, image_sha256 FROM channel_media
        WHERE channel_account_id = $1 AND product_image_id = $2 AND uploaded_at > now() - make_interval(days => $3)`,
      [channelAccountId, productImageId, MEDIA_REUSE_DAYS],
    );
    return { image: image.rows[0], cached: cached.rows[0] };
  });
  if (!found.image) return { ok: false, retryable: false, message: 'la foto del producto ya no existe' };
  if (found.cached && found.cached.image_sha256 === found.image.sha256) {
    return { ok: true, mediaId: found.cached.external_media_id, cached: true };
  }

  const ext = found.image.mime_type === 'image/png' ? 'png' : 'jpg';
  const upload = await uploadWhatsAppMedia(config, found.image.data, found.image.mime_type, `producto-${productImageId}.${ext}`);
  if (!upload.ok) return { ok: false, retryable: upload.retryable, message: `subida de foto: ${upload.message}` };

  await withTenant(deps.pool, tenantId, (client) =>
    client.query(
      `INSERT INTO channel_media (tenant_id, channel_account_id, product_image_id, image_sha256, external_media_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_account_id, product_image_id) DO UPDATE SET
         image_sha256 = EXCLUDED.image_sha256, external_media_id = EXCLUDED.external_media_id, uploaded_at = now()`,
      [tenantId, channelAccountId, productImageId, found.image!.sha256, upload.mediaId],
    ),
  );
  return { ok: true, mediaId: upload.mediaId, cached: false };
}

async function forgetMedia(deps: OutboundDeps, tenantId: string, channelAccountId: string, productImageId: string) {
  await withTenant(deps.pool, tenantId, (client) =>
    client.query('DELETE FROM channel_media WHERE channel_account_id = $1 AND product_image_id = $2', [channelAccountId, productImageId]),
  );
}

/**
 * Envía varios mensajes en orden (fotos y luego texto). Si uno falla por algo pasajero, se
 * reintenta el lote completo: los que ya salieron se saltan solos.
 */
export async function processOutbound(deps: OutboundDeps, job: OutboundJobData): Promise<OutboundOutcome[]> {
  const results: OutboundOutcome[] = [];
  for (const outboundMessageId of job.outboundMessageIds) {
    results.push(await processOutboundMessage(deps, { tenantId: job.tenantId, outboundMessageId }));
  }
  return results;
}

/**
 * Envía un mensaje pendiente. Lo toma primero ('sending') para que dos workers no lo manden
 * dos veces, revisa la ventana de mensajería, envía y guarda el resultado.
 */
export async function processOutboundMessage(
  deps: OutboundDeps,
  job: { tenantId: string; outboundMessageId: string },
): Promise<OutboundOutcome> {
  const now = deps.now?.() ?? new Date();
  const maxAttempts = deps.maxAttempts ?? 5;

  const claimed = await withTenant(deps.pool, job.tenantId, async (client) => {
    const { rows } = await client.query<Claimed>(
      `UPDATE outbound_messages o
          SET status = 'sending', attempts = o.attempts + 1, updated_at = now()
         FROM conversations c JOIN channel_accounts ca ON ca.id = c.channel_account_id
        WHERE o.id = $1 AND o.status = 'queued' AND c.id = o.conversation_id
        RETURNING o.id, o.message_id, o.conversation_id, o.attempts, o.payload, ca.channel, c.last_inbound_at,
                  ca.id AS channel_account_id, ca.external_account_id, ca.credentials_enc`,
      [job.outboundMessageId],
    );
    return rows[0] ?? null;
  });
  if (!claimed) return { result: 'skipped' };

  const finish = (status: 'sent' | 'failed' | 'blocked_window' | 'queued', fields: { error?: string; externalId?: string } = {}) =>
    withTenant(deps.pool, job.tenantId, async (client) => {
      await client.query(
        `UPDATE outbound_messages SET status = $2, last_error = $3, external_message_id = COALESCE($4, external_message_id),
                updated_at = now()
          WHERE id = $1`,
        [claimed.id, status, fields.error ?? null, fields.externalId ?? null],
      );
      if (status === 'sent') {
        await client.query('UPDATE conversations SET last_outbound_at = now(), updated_at = now() WHERE id = $1', [
          claimed.conversation_id,
        ]);
        if (claimed.message_id) {
          await client.query('UPDATE messages SET external_message_id = $2 WHERE id = $1', [claimed.message_id, fields.externalId]);
        }
      }
    });

  const window = windowState({
    channel: claimed.channel,
    lastInboundAt: claimed.last_inbound_at ? new Date(claimed.last_inbound_at) : null,
    now,
    author: claimed.payload.author,
    botSafetyMarginMs: BOT_SAFETY_MARGIN_MS,
  });
  // Las plantillas aprobadas son lo único que WhatsApp deja mandar fuera de las 24 h.
  const allowed = window === 'FREE' || (window === 'TEMPLATE_ONLY' && claimed.payload.kind === 'template');
  if (!allowed) {
    // Fuera de ventana el texto libre no se puede mandar; queda visible para el equipo.
    await finish('blocked_window', { error: `ventana: ${window}` });
    return { result: 'blocked_window' };
  }

  if (claimed.channel !== 'whatsapp') {
    await finish('failed', { error: `canal ${claimed.channel} aún no implementado` });
    return { result: 'failed', reason: 'channel_not_implemented' };
  }
  if (!claimed.credentials_enc) {
    await finish('failed', { error: 'la cuenta de canal no tiene credenciales' });
    return { result: 'failed', reason: 'missing_credentials' };
  }

  let accessToken: string;
  try {
    const creds = JSON.parse(decryptCredentials(claimed.credentials_enc, deps.masterKey, claimed.channel_account_id)) as {
      accessToken?: string;
    };
    if (!creds.accessToken) throw new Error('sin accessToken');
    accessToken = creds.accessToken;
  } catch {
    await finish('failed', { error: 'no se pudieron leer las credenciales de la cuenta' });
    return { result: 'failed', reason: 'bad_credentials' };
  }

  const config: WhatsAppSendConfig = {
    graphApiVersion: deps.graphApiVersion,
    phoneNumberId: claimed.external_account_id,
    accessToken,
    ...(deps.graphBaseUrl ? { graphBaseUrl: deps.graphBaseUrl } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };

  let res: SendResult;
  try {
    if (claimed.payload.kind === 'image') {
      const media = await resolveMedia(deps, job.tenantId, claimed.channel_account_id, claimed.payload.productImageId, config);
      if (!media.ok) {
        if (media.retryable && claimed.attempts < maxAttempts) {
          await finish('queued', { error: media.message });
          throw new RetryableSendError(media.message);
        }
        await finish('failed', { error: media.message });
        return { result: 'failed', reason: 'media_upload_failed' };
      }
      res = await sendWhatsAppImage(config, claimed.payload.to, media.mediaId, claimed.payload.caption);
      // Si Meta ya no reconoce un id guardado, se descarta y se reintenta subiendo la foto de nuevo.
      if (!res.ok && media.cached) {
        await forgetMedia(deps, job.tenantId, claimed.channel_account_id, claimed.payload.productImageId);
        if (claimed.attempts < maxAttempts) {
          await finish('queued', { error: `id de foto vencido: ${res.message}` });
          throw new RetryableSendError(res.message);
        }
      }
    } else if (claimed.payload.kind === 'template') {
      const { name, language, bodyParams } = claimed.payload;
      res = await sendWhatsAppTemplate(config, claimed.payload.to, { name, language, bodyParams });
    } else {
      res = await sendWhatsAppText(config, claimed.payload.to, claimed.payload.text);
    }
  } catch (err) {
    if (err instanceof RetryableSendError) throw err;
    await finish('failed', { error: (err as Error).message });
    return { result: 'failed', reason: 'invalid_message' };
  }

  if (res.ok) {
    await finish('sent', { externalId: res.externalMessageId });
    return { result: 'sent', externalMessageId: res.externalMessageId };
  }
  if (res.retryable && claimed.attempts < maxAttempts) {
    await finish('queued', { error: res.message });
    throw new RetryableSendError(res.message);
  }
  await finish('failed', { error: `${res.errorCode ?? res.httpStatus ?? ''} ${res.message}`.trim() });
  return { result: 'failed', reason: 'send_failed' };
}
