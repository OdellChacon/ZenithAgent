/**
 * Envío por WhatsApp Cloud API:
 * - Mensajes: POST https://graph.facebook.com/{version}/{phone_number_id}/messages
 * - Archivos:  POST https://graph.facebook.com/{version}/{phone_number_id}/media (multipart)
 *
 * Imágenes: JPEG o PNG de hasta 5 MB; los ids de archivos subidos duran 30 días (Meta).
 * Por verificar en la documentación vigente de Meta antes de producción:
 * - largo máximo del texto (se asume 4096 caracteres) y del pie de foto (se asume 1024);
 * - códigos de error de límite de tasa (se asumen 4, 80007, 130429 y 131056).
 */
export const WHATSAPP_MAX_TEXT_LENGTH = 4096;
export const WHATSAPP_MAX_CAPTION_LENGTH = 1024;
export const WHATSAPP_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131056]);
const GRAPH_VERSION_RE = /^v\d+\.\d+$/;

export interface WhatsAppSendConfig {
  graphApiVersion: string;
  phoneNumberId: string;
  accessToken: string;
  /** Solo para pruebas locales contra un simulador. Por defecto, Graph API de Meta. */
  graphBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_GRAPH_BASE_URL = 'https://graph.facebook.com';

export type SendResult =
  | { ok: true; externalMessageId: string }
  | { ok: false; retryable: boolean; httpStatus: number | null; errorCode?: number; message: string };

export type UploadResult =
  | { ok: true; mediaId: string }
  | { ok: false; retryable: boolean; httpStatus: number | null; errorCode?: number; message: string };

export class WhatsAppSendError extends Error {
  override name = 'WhatsAppSendError';
}

function endpoint(config: WhatsAppSendConfig, path: 'messages' | 'media'): string {
  if (!GRAPH_VERSION_RE.test(config.graphApiVersion)) {
    throw new WhatsAppSendError('META_GRAPH_API_VERSION debe tener la forma vNN.N');
  }
  const base = new URL(config.graphBaseUrl ?? DEFAULT_GRAPH_BASE_URL);
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') {
    throw new WhatsAppSendError('La URL de Graph API debe usar https');
  }
  return new URL(`/${config.graphApiVersion}/${encodeURIComponent(config.phoneNumberId)}/${path}`, base).toString();
}

type GraphReply = { id?: string; messages?: { id?: string }[]; error?: { code?: number; message?: string } } | null;

async function graphCall(
  config: WhatsAppSendConfig,
  url: string,
  init: { body: string | FormData; json: boolean },
): Promise<{ ok: true; data: GraphReply } | { ok: false; retryable: boolean; httpStatus: number | null; errorCode?: number; message: string }> {
  const doFetch = config.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, ...(init.json ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body,
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
  } catch (err) {
    // Red caída o timeout: se puede reintentar.
    return { ok: false, retryable: true, httpStatus: null, message: `Error de red: ${(err as Error).message}` };
  }
  const data = (await res.json().catch(() => null)) as GraphReply;
  if (res.ok) return { ok: true, data };
  const errorCode = data?.error?.code;
  const retryable = res.status === 429 || res.status >= 500 || (errorCode !== undefined && RATE_LIMIT_CODES.has(errorCode));
  return {
    ok: false,
    retryable,
    httpStatus: res.status,
    ...(errorCode !== undefined ? { errorCode } : {}),
    message: data?.error?.message ?? `Respuesta inesperada de Meta (HTTP ${res.status})`,
  };
}

function checkRecipient(to: string) {
  if (!/^\d{6,20}$/.test(to)) throw new WhatsAppSendError('Número de destino inválido');
}

async function sendMessage(config: WhatsAppSendConfig, to: string, message: Record<string, unknown>): Promise<SendResult> {
  const url = endpoint(config, 'messages');
  const res = await graphCall(config, url, {
    json: true,
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message }),
  });
  if (!res.ok) return res;
  const id = res.data?.messages?.[0]?.id;
  return id
    ? { ok: true, externalMessageId: id }
    : { ok: false, retryable: false, httpStatus: 200, message: 'Meta no devolvió el id del mensaje' };
}

export async function sendWhatsAppText(config: WhatsAppSendConfig, to: string, body: string): Promise<SendResult> {
  checkRecipient(to);
  const text = body.trim();
  if (!text) throw new WhatsAppSendError('El mensaje está vacío');
  if (text.length > WHATSAPP_MAX_TEXT_LENGTH) throw new WhatsAppSendError('El mensaje supera el largo máximo');
  return sendMessage(config, to, { type: 'text', text: { body: text } });
}

/** Envía una imagen ya subida (mediaId) con un pie de foto opcional. */
export async function sendWhatsAppImage(config: WhatsAppSendConfig, to: string, mediaId: string, caption?: string): Promise<SendResult> {
  checkRecipient(to);
  if (!mediaId) throw new WhatsAppSendError('Falta el id de la imagen');
  const text = caption?.trim();
  if (text && text.length > WHATSAPP_MAX_CAPTION_LENGTH) throw new WhatsAppSendError('El pie de foto supera el largo máximo');
  return sendMessage(config, to, { type: 'image', image: { id: mediaId, ...(text ? { caption: text } : {}) } });
}

/** Sube una imagen a WhatsApp y devuelve su id (válido 30 días según Meta). */
export async function uploadWhatsAppMedia(
  config: WhatsAppSendConfig,
  data: Buffer,
  mimeType: 'image/jpeg' | 'image/png',
  filename: string,
): Promise<UploadResult> {
  if (!data.length) throw new WhatsAppSendError('La imagen está vacía');
  if (data.length > WHATSAPP_MAX_IMAGE_BYTES) throw new WhatsAppSendError('La imagen supera los 5 MB');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), filename);
  const res = await graphCall(config, endpoint(config, 'media'), { json: false, body: form });
  if (!res.ok) return res;
  const id = res.data?.id;
  return id ? { ok: true, mediaId: id } : { ok: false, retryable: false, httpStatus: 200, message: 'Meta no devolvió el id del archivo' };
}
