import { decryptCredentials, windowState, type Channel, type OutboundJobData } from '@zenith/core';
import {
  sendWhatsAppImage,
  sendWhatsAppMedia,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  uploadWhatsAppMedia,
  type SendFailure,
  type SendResult,
  type WhatsAppSendConfig,
} from '@zenith/channel-whatsapp';
import { sendMetaAttachment, sendMetaText, uploadMetaAttachment, type MetaAttachmentType, type MetaSendConfig } from '@zenith/channel-meta';
import { withTenant, type Pool } from '@zenith/db';

export interface OutboundDeps {
  pool: Pool;
  masterKey: Buffer;
  graphApiVersion: string;
  graphBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type OutboundOutcome =
  | { result: 'sent'; externalMessageId: string }
  | { result: 'skipped' }
  | { result: 'blocked_window' }
  /** `auth_failed`: Meta rechazó el token de la cuenta; hay que avisar y volver a conectarla. */
  | { result: 'failed'; reason: string; channelAccountId?: string };

type Author = 'bot' | 'agent';
export type OutboundPayload =
  | { kind: 'text'; text: string; to: string; author: Author }
  | { kind: 'image'; productImageId: string; caption?: string; to: string; author: Author }
  | { kind: 'template'; name: string; language: string; bodyParams: string[]; to: string; author: Author }
  /** Archivo que subió un asesor desde el panel (message_files). */
  | { kind: 'file'; fileId: string; caption?: string; to: string; author: Author }
  /** Catálogo de productos que el asesor arrastró al chat (catalogs). */
  | { kind: 'catalog'; catalogId: string; caption?: string; to: string; author: Author };

interface Claimed {
  id: string;
  message_id: string | null;
  conversation_id: string;
  attempts: number;
  payload: OutboundPayload;
  channel: Channel;
  last_inbound_at: Date | null;
  channel_account_id: string;
  external_account_id: string;
  credentials_enc: Buffer | null;
  credentials_invalid_at: Date | null;
}

/** El bot deja de usar texto libre un minuto antes de que cierre la ventana de 24 h. */
const BOT_SAFETY_MARGIN_MS = 60_000;

export class RetryableSendError extends Error {
  override name = 'RetryableSendError';
}

/** WhatsApp guarda los archivos subidos 30 días; se reutilizan hasta 25 para tener margen. */
const MEDIA_REUSE_DAYS = 25;

interface Creds {
  accessToken: string;
  /** Messenger e Instagram: página que envía. */
  pageId?: string;
}

/** Un canal ya listo para enviar: cada uno sabe subir un archivo y mandar cada tipo de mensaje. */
interface ChannelSender {
  upload(data: Buffer, mimeType: string, mediaType: 'image' | 'video' | 'document', filename: string): Promise<{ ok: true; id: string } | SendFailure>;
  text(to: string, text: string): Promise<SendResult>;
  media(to: string, m: { mediaType: 'image' | 'video' | 'document'; id: string; caption?: string; filename?: string }): Promise<SendResult>;
  template(to: string, t: { name: string; language: string; bodyParams: string[] }): Promise<SendResult>;
}

function whatsappSender(config: WhatsAppSendConfig): ChannelSender {
  return {
    async upload(data, mimeType, _type, filename) {
      const r = await uploadWhatsAppMedia(config, data, mimeType, filename);
      return r.ok ? { ok: true, id: r.mediaId } : r;
    },
    text: (to, text) => sendWhatsAppText(config, to, text),
    media: (to, m) =>
      m.mediaType === 'image'
        ? sendWhatsAppImage(config, to, m.id, m.caption)
        : sendWhatsAppMedia(config, to, { type: m.mediaType, mediaId: m.id, ...(m.caption ? { caption: m.caption } : {}), ...(m.filename ? { filename: m.filename } : {}) }),
    template: (to, t) => sendWhatsAppTemplate(config, to, t),
  };
}

const META_ATTACHMENT: Record<'image' | 'video' | 'document', MetaAttachmentType> = { image: 'image', video: 'video', document: 'file' };

function metaSender(config: MetaSendConfig, humanAgent: boolean): ChannelSender {
  return {
    async upload(data, mimeType, type, filename) {
      const r = await uploadMetaAttachment(config, data, mimeType, META_ATTACHMENT[type], filename);
      return r.ok ? { ok: true, id: r.attachmentId } : r;
    },
    text: (to, text) => sendMetaText(config, to, text, { humanAgent }),
    media: (to, m) => sendMetaAttachment(config, to, { type: META_ATTACHMENT[m.mediaType], attachmentId: m.id, ...(m.caption ? { caption: m.caption } : {}) }, { humanAgent }),
    template: async () => ({ ok: false, retryable: false, httpStatus: null, message: 'Las plantillas solo existen en WhatsApp' }),
  };
}

type MediaLookup = { ok: true; mediaId: string; cached: boolean } | { ok: false; retryable: boolean; authError?: true; message: string };

/** Devuelve el id de una foto del catálogo en el canal: el guardado si sigue vigente, o la sube. */
async function resolveProductImage(
  deps: OutboundDeps,
  tenantId: string,
  channelAccountId: string,
  productImageId: string,
  sender: ChannelSender,
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
  const upload = await sender.upload(found.image.data, found.image.mime_type, 'image', `producto-${productImageId}.${ext}`);
  if (!upload.ok) return { ok: false, retryable: upload.retryable, ...(upload.authError ? { authError: true as const } : {}), message: `subida de foto: ${upload.message}` };

  await withTenant(deps.pool, tenantId, (client) =>
    client.query(
      `INSERT INTO channel_media (tenant_id, channel_account_id, product_image_id, image_sha256, external_media_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_account_id, product_image_id) DO UPDATE SET
         image_sha256 = EXCLUDED.image_sha256, external_media_id = EXCLUDED.external_media_id, uploaded_at = now()`,
      [tenantId, channelAccountId, productImageId, found.image!.sha256, upload.id],
    ),
  );
  return { ok: true, mediaId: upload.id, cached: false };
}

/**
 * Id del catálogo en el canal: el guardado si sigue vigente y el archivo no cambió, o lo sube.
 * Un catálogo se manda muchas veces; subir el PDF una sola vez ahorra tiempo y datos.
 */
async function resolveCatalog(
  deps: OutboundDeps,
  tenantId: string,
  channelAccountId: string,
  catalogId: string,
  sender: ChannelSender,
): Promise<(MediaLookup & { ok: true; mediaType: 'image' | 'video' | 'document'; filename: string }) | Exclude<MediaLookup, { ok: true }>> {
  const found = await withTenant(deps.pool, tenantId, async (client) => {
    const catalog = await client.query<{ data: Buffer; mime_type: string; media_type: 'image' | 'video' | 'document'; filename: string; sha256: string }>(
      'SELECT data, mime_type, media_type, filename, sha256 FROM catalogs WHERE id = $1',
      [catalogId],
    );
    const cached = await client.query<{ external_media_id: string; sha256: string }>(
      `SELECT external_media_id, sha256 FROM catalog_media
        WHERE channel_account_id = $1 AND catalog_id = $2 AND uploaded_at > now() - make_interval(days => $3)`,
      [channelAccountId, catalogId, MEDIA_REUSE_DAYS],
    );
    return { catalog: catalog.rows[0], cached: cached.rows[0] };
  });
  const c = found.catalog;
  if (!c) return { ok: false, retryable: false, message: 'el catálogo ya no existe' };
  if (found.cached && found.cached.sha256 === c.sha256) {
    return { ok: true, mediaId: found.cached.external_media_id, cached: true, mediaType: c.media_type, filename: c.filename };
  }
  const upload = await sender.upload(c.data, c.mime_type, c.media_type, c.filename);
  if (!upload.ok) return { ok: false, retryable: upload.retryable, ...(upload.authError ? { authError: true as const } : {}), message: `subida del catálogo: ${upload.message}` };
  await withTenant(deps.pool, tenantId, (client) =>
    client.query(
      `INSERT INTO catalog_media (tenant_id, channel_account_id, catalog_id, sha256, external_media_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_account_id, catalog_id) DO UPDATE SET
         sha256 = EXCLUDED.sha256, external_media_id = EXCLUDED.external_media_id, uploaded_at = now()`,
      [tenantId, channelAccountId, catalogId, c.sha256, upload.id],
    ),
  );
  return { ok: true, mediaId: upload.id, cached: false, mediaType: c.media_type, filename: c.filename };
}

async function forgetMedia(deps: OutboundDeps, tenantId: string, channelAccountId: string, productImageId: string) {
  await withTenant(deps.pool, tenantId, (client) =>
    client.query('DELETE FROM channel_media WHERE channel_account_id = $1 AND product_image_id = $2', [channelAccountId, productImageId]),
  );
}

/**
 * Meta rechazó el token: la cuenta queda marcada para que el panel y el correo avisen. Solo si
 * sigue guardado el mismo token con que se intentó: si alguien volvió a conectar la cuenta
 * mientras este envío estaba en curso, el error es del token viejo y no hay que marcar el nuevo.
 * Devuelve si la marcó.
 */
async function markCredentialsInvalid(
  deps: OutboundDeps,
  tenantId: string,
  channelAccountId: string,
  usedCredentials: Buffer,
  message: string,
): Promise<boolean> {
  const { rowCount } = await withTenant(deps.pool, tenantId, (client) =>
    client.query(
      `UPDATE channel_accounts SET credentials_invalid_at = COALESCE(credentials_invalid_at, now()), credentials_error = $2
        WHERE id = $1 AND credentials_enc = $3`,
      [channelAccountId, message.slice(0, 500), usedCredentials],
    ),
  );
  return Boolean(rowCount);
}

/**
 * Envía varios mensajes en orden (fotos y luego texto). Si uno falla por algo pasajero, se
 * reintenta el lote completo: los que ya salieron se saltan solos.
 */
export async function processOutbound(deps: OutboundDeps, job: OutboundJobData): Promise<OutboundOutcome[]> {
  const results: OutboundOutcome[] = [];
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (const [i, outboundMessageId] of job.outboundMessageIds.entries()) {
    // Pausa de "escribiendo" entre mensajes; en un reintento, lo que ya salió no espera.
    const pause = job.pausesMs?.[i] ?? 0;
    if (pause > 0 && results.at(-1)?.result === 'sent') await sleep(Math.min(pause, 5000));
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
                  ca.id AS channel_account_id, ca.external_account_id, ca.credentials_enc, ca.credentials_invalid_at`,
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

  const payload = claimed.payload;
  const window = windowState({
    channel: claimed.channel,
    lastInboundAt: claimed.last_inbound_at ? new Date(claimed.last_inbound_at) : null,
    now,
    author: payload.author,
    botSafetyMarginMs: BOT_SAFETY_MARGIN_MS,
  });
  // Fuera de las 24 h: en WhatsApp solo plantillas aprobadas; en Messenger e Instagram solo una
  // persona, hasta 7 días, con la etiqueta Human Agent.
  const humanAgent = window === 'HUMAN_AGENT_ONLY' && payload.author === 'agent' && payload.kind !== 'template';
  const allowed = window === 'FREE' ? payload.kind !== 'template' || claimed.channel === 'whatsapp' : (window === 'TEMPLATE_ONLY' && payload.kind === 'template') || humanAgent;
  if (!allowed) {
    // Fuera de ventana el texto libre no se puede mandar; queda visible para el equipo.
    await finish('blocked_window', { error: `ventana: ${window}` });
    return { result: 'blocked_window' };
  }

  if (claimed.channel !== 'whatsapp' && claimed.channel !== 'messenger' && claimed.channel !== 'instagram') {
    await finish('failed', { error: `canal ${claimed.channel} aún no implementado` });
    return { result: 'failed', reason: 'channel_not_implemented' };
  }
  if (!claimed.credentials_enc) {
    await finish('failed', { error: 'la cuenta de canal no tiene credenciales' });
    return { result: 'failed', reason: 'missing_credentials' };
  }
  if (claimed.credentials_invalid_at) {
    // Meta ya rechazó este token: no se insiste hasta que alguien vuelva a conectar la cuenta.
    await finish('failed', { error: 'Meta rechazó el token de la cuenta: hay que volver a conectarla desde el panel' });
    return { result: 'failed', reason: 'auth_failed', channelAccountId: claimed.channel_account_id };
  }

  let creds: Creds;
  try {
    const parsed = JSON.parse(decryptCredentials(claimed.credentials_enc, deps.masterKey, claimed.channel_account_id)) as Partial<Creds>;
    if (!parsed.accessToken) throw new Error('sin accessToken');
    creds = { accessToken: parsed.accessToken, ...(parsed.pageId ? { pageId: parsed.pageId } : {}) };
  } catch {
    await finish('failed', { error: 'no se pudieron leer las credenciales de la cuenta' });
    return { result: 'failed', reason: 'bad_credentials' };
  }

  const common = {
    graphApiVersion: deps.graphApiVersion,
    accessToken: creds.accessToken,
    ...(deps.graphBaseUrl ? { graphBaseUrl: deps.graphBaseUrl } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
  let sender: ChannelSender;
  if (claimed.channel === 'whatsapp') {
    sender = whatsappSender({ ...common, phoneNumberId: claimed.external_account_id });
  } else {
    // Messenger: la cuenta es la página. Instagram: se envía por la página vinculada.
    const pageId = claimed.channel === 'messenger' ? claimed.external_account_id : creds.pageId;
    if (!pageId) {
      await finish('failed', { error: 'la cuenta de Instagram no tiene la página vinculada' });
      return { result: 'failed', reason: 'missing_credentials' };
    }
    sender = metaSender({ ...common, pageId, channel: claimed.channel }, humanAgent);
  }

  const authFailed = async (message: string): Promise<OutboundOutcome> => {
    const marked = await markCredentialsInvalid(deps, job.tenantId, claimed.channel_account_id, claimed.credentials_enc!, message);
    if (!marked) {
      // La cuenta se volvió a conectar mientras tanto: se reintenta con el token nuevo.
      if (claimed.attempts < maxAttempts) {
        await finish('queued', { error: `token reemplazado durante el envío: ${message}` });
        throw new RetryableSendError(message);
      }
      await finish('failed', { error: `token rechazado por Meta: ${message}` });
      return { result: 'failed', reason: 'send_failed' };
    }
    await finish('failed', { error: `token rechazado por Meta: ${message}` });
    return { result: 'failed', reason: 'auth_failed', channelAccountId: claimed.channel_account_id };
  };

  let res: SendResult;
  try {
    if (payload.kind === 'image') {
      const media = await resolveProductImage(deps, job.tenantId, claimed.channel_account_id, payload.productImageId, sender);
      if (!media.ok) {
        if (media.authError) return await authFailed(media.message);
        if (media.retryable && claimed.attempts < maxAttempts) {
          await finish('queued', { error: media.message });
          throw new RetryableSendError(media.message);
        }
        await finish('failed', { error: media.message });
        return { result: 'failed', reason: 'media_upload_failed' };
      }
      res = await sender.media(payload.to, { mediaType: 'image', id: media.mediaId, ...(payload.caption ? { caption: payload.caption } : {}) });
      // Si Meta ya no reconoce un id guardado, se descarta y se reintenta subiendo la foto de nuevo.
      if (!res.ok && !res.authError && media.cached) {
        await forgetMedia(deps, job.tenantId, claimed.channel_account_id, payload.productImageId);
        if (claimed.attempts < maxAttempts) {
          await finish('queued', { error: `id de foto vencido: ${res.message}` });
          throw new RetryableSendError(res.message);
        }
      }
    } else if (payload.kind === 'catalog') {
      const media = await resolveCatalog(deps, job.tenantId, claimed.channel_account_id, payload.catalogId, sender);
      if (!media.ok) {
        if (media.authError) return await authFailed(media.message);
        if (media.retryable && claimed.attempts < maxAttempts) {
          await finish('queued', { error: media.message });
          throw new RetryableSendError(media.message);
        }
        await finish('failed', { error: media.message });
        return { result: 'failed', reason: 'media_upload_failed' };
      }
      res = await sender.media(payload.to, {
        mediaType: media.mediaType,
        id: media.mediaId,
        filename: media.filename,
        ...(payload.caption ? { caption: payload.caption } : {}),
      });
      // Un id guardado que Meta ya no reconoce se olvida y se reintenta subiendo de nuevo.
      if (!res.ok && !res.authError && media.cached) {
        await withTenant(deps.pool, job.tenantId, (client) =>
          client.query('DELETE FROM catalog_media WHERE channel_account_id = $1 AND catalog_id = $2', [claimed.channel_account_id, payload.catalogId]),
        );
        if (claimed.attempts < maxAttempts) {
          await finish('queued', { error: `id del catálogo vencido: ${res.message}` });
          throw new RetryableSendError(res.message);
        }
      }
    } else if (payload.kind === 'file') {
      const file = await withTenant(deps.pool, job.tenantId, async (client) =>
        (
          await client.query<{ data: Buffer; mime_type: string; media_type: 'image' | 'video' | 'document'; filename: string }>(
            'SELECT data, mime_type, media_type, filename FROM message_files WHERE id = $1',
            [payload.fileId],
          )
        ).rows[0],
      );
      if (!file) {
        await finish('failed', { error: 'el archivo ya no existe' });
        return { result: 'failed', reason: 'media_upload_failed' };
      }
      const upload = await sender.upload(file.data, file.mime_type, file.media_type, file.filename);
      if (!upload.ok) {
        if (upload.authError) return await authFailed(upload.message);
        if (upload.retryable && claimed.attempts < maxAttempts) {
          await finish('queued', { error: `subida de archivo: ${upload.message}` });
          throw new RetryableSendError(upload.message);
        }
        await finish('failed', { error: `subida de archivo: ${upload.message}` });
        return { result: 'failed', reason: 'media_upload_failed' };
      }
      res = await sender.media(payload.to, {
        mediaType: file.media_type,
        id: upload.id,
        filename: file.filename,
        ...(payload.caption ? { caption: payload.caption } : {}),
      });
    } else if (payload.kind === 'template') {
      const { name, language, bodyParams } = payload;
      res = await sender.template(payload.to, { name, language, bodyParams });
    } else {
      res = await sender.text(payload.to, payload.text);
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
  if (res.authError) return authFailed(res.message);
  if (res.retryable && claimed.attempts < maxAttempts) {
    await finish('queued', { error: res.message });
    throw new RetryableSendError(res.message);
  }
  await finish('failed', { error: `${res.errorCode ?? res.httpStatus ?? ''} ${res.message}`.trim() });
  return { result: 'failed', reason: 'send_failed' };
}
