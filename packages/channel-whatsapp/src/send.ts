/**
 * Envío por WhatsApp Cloud API:
 * - Mensajes: POST https://graph.facebook.com/{version}/{phone_number_id}/messages
 * - Archivos:  POST https://graph.facebook.com/{version}/{phone_number_id}/media (multipart)
 *
 * Límites confirmados en la documentación de Meta (revisada el 27/11/2026):
 * - texto: 4096 caracteres; pie de foto, video o documento: 1024 caracteres;
 * - imagen JPEG o PNG hasta 5 MB; video MP4 o 3GP (H.264 + AAC) hasta 16 MB; documento
 *   (PDF, TXT, Word, Excel, PowerPoint) hasta 100 MB. Los ids de archivos subidos duran 30 días;
 * - límite de tasa, se puede reintentar: 4 (app), 80007 (cuenta), 130429 (caudal) y 131056
 *   (demasiados mensajes al mismo cliente). El 131048 (número restringido por spam) no se
 *   reintenta: es una restricción de calidad, no de tasa;
 * - token vencido o revocado: 190 (y 0 cuando Meta no puede autenticar). Hay que volver a
 *   conectar el número: reintentar no sirve.
 */
export const WHATSAPP_MAX_TEXT_LENGTH = 4096;
export const WHATSAPP_MAX_CAPTION_LENGTH = 1024;
export const WHATSAPP_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const WHATSAPP_MAX_VIDEO_BYTES = 16 * 1024 * 1024;
export const WHATSAPP_MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131056]);
/** Token vencido, revocado o que Meta no puede autenticar. */
export const META_AUTH_ERROR_CODES: ReadonlySet<number> = new Set([0, 190]);

/** Tipos de archivo que se pueden mandar y su tamaño máximo según Meta. */
export const WHATSAPP_UPLOAD_TYPES = {
  image: { maxBytes: WHATSAPP_MAX_IMAGE_BYTES, mimeTypes: new Set(['image/jpeg', 'image/png']) },
  video: { maxBytes: WHATSAPP_MAX_VIDEO_BYTES, mimeTypes: new Set(['video/mp4', 'video/3gpp']) },
  document: {
    maxBytes: WHATSAPP_MAX_DOCUMENT_BYTES,
    mimeTypes: new Set([
      'application/pdf',
      'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ]),
  },
} as const;
export type WhatsAppUploadType = keyof typeof WHATSAPP_UPLOAD_TYPES;

/** Qué tipo de mensaje corresponde a un archivo, o null si WhatsApp no lo admite. */
export function whatsappMediaTypeFor(mimeType: string): WhatsAppUploadType | null {
  for (const type of Object.keys(WHATSAPP_UPLOAD_TYPES) as WhatsAppUploadType[]) {
    if ((WHATSAPP_UPLOAD_TYPES[type].mimeTypes as ReadonlySet<string>).has(mimeType)) return type;
  }
  return null;
}
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

/** `authError`: el token venció o fue revocado; hay que volver a conectar la cuenta. */
export type SendFailure = { ok: false; retryable: boolean; httpStatus: number | null; errorCode?: number; authError?: true; message: string };

export type SendResult = { ok: true; externalMessageId: string } | SendFailure;

export type UploadResult = { ok: true; mediaId: string } | SendFailure;

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
): Promise<{ ok: true; data: GraphReply } | SendFailure> {
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
  const authError = res.status === 401 || (errorCode !== undefined && META_AUTH_ERROR_CODES.has(errorCode));
  const retryable = !authError && (res.status === 429 || res.status >= 500 || (errorCode !== undefined && RATE_LIMIT_CODES.has(errorCode)));
  return {
    ok: false,
    retryable,
    httpStatus: res.status,
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(authError ? { authError: true as const } : {}),
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

/**
 * Marca como leído un mensaje del cliente (y los anteriores de ese chat). Con `typing`, el
 * cliente ve "escribiendo…" hasta que llega la respuesta o pasan 25 segundos (Meta). Solo
 * se usa cuando de verdad se va a responder.
 */
export async function markWhatsAppRead(
  config: WhatsAppSendConfig,
  externalMessageId: string,
  opts: { typing?: boolean } = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!externalMessageId) throw new WhatsAppSendError('Falta el id del mensaje');
  const res = await graphCall(config, endpoint(config, 'messages'), {
    json: true,
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: externalMessageId,
      ...(opts.typing ? { typing_indicator: { type: 'text' } } : {}),
    }),
  });
  return res.ok ? { ok: true } : { ok: false, message: res.message };
}

/** Envía una imagen ya subida (mediaId) con un pie de foto opcional. */
export async function sendWhatsAppImage(config: WhatsAppSendConfig, to: string, mediaId: string, caption?: string): Promise<SendResult> {
  return sendWhatsAppMedia(config, to, { type: 'image', mediaId, ...(caption ? { caption } : {}) });
}

/** Envía una foto, un video o un documento ya subido. El documento lleva su nombre de archivo. */
export async function sendWhatsAppMedia(
  config: WhatsAppSendConfig,
  to: string,
  media: { type: WhatsAppUploadType; mediaId: string; caption?: string; filename?: string },
): Promise<SendResult> {
  checkRecipient(to);
  if (!media.mediaId) throw new WhatsAppSendError('Falta el id del archivo');
  const text = media.caption?.trim();
  if (text && text.length > WHATSAPP_MAX_CAPTION_LENGTH) throw new WhatsAppSendError('El pie de foto supera el largo máximo');
  const filename = media.type === 'document' ? media.filename?.trim().slice(0, 240) : undefined;
  return sendMessage(config, to, {
    type: media.type,
    [media.type]: { id: media.mediaId, ...(text ? { caption: text } : {}), ...(filename ? { filename } : {}) },
  });
}

/** Sube un archivo (foto, video o documento) a WhatsApp y devuelve su id (válido 30 días según Meta). */
export async function uploadWhatsAppMedia(config: WhatsAppSendConfig, data: Buffer, mimeType: string, filename: string): Promise<UploadResult> {
  if (!data.length) throw new WhatsAppSendError('El archivo está vacío');
  const type = whatsappMediaTypeFor(mimeType);
  if (!type) throw new WhatsAppSendError(`WhatsApp no admite archivos ${mimeType}`);
  const limit = WHATSAPP_UPLOAD_TYPES[type].maxBytes;
  if (data.length > limit) throw new WhatsAppSendError(`El archivo supera los ${Math.round(limit / 1024 / 1024)} MB`);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), filename);
  const res = await graphCall(config, endpoint(config, 'media'), { json: false, body: form });
  if (!res.ok) return res;
  const id = res.data?.id;
  return id ? { ok: true, mediaId: id } : { ok: false, retryable: false, httpStatus: 200, message: 'Meta no devolvió el id del archivo' };
}

export interface WhatsAppTemplate {
  /** Nombre de la plantilla aprobada en el administrador de WhatsApp. */
  name: string;
  /** Código de idioma con el que se aprobó (ej. "es", "es_MX"). */
  language: string;
  /** Valores de {{1}}, {{2}}… del cuerpo, en orden. */
  bodyParams: string[];
}

/**
 * Envía una plantilla aprobada. Es lo único que WhatsApp permite fuera de las 24 h desde el
 * último mensaje del cliente. Meta rechaza parámetros vacíos o con saltos de línea.
 */
export async function sendWhatsAppTemplate(config: WhatsAppSendConfig, to: string, template: WhatsAppTemplate): Promise<SendResult> {
  checkRecipient(to);
  if (!/^[a-z0-9_]{1,512}$/.test(template.name)) throw new WhatsAppSendError('Nombre de plantilla inválido');
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(template.language)) throw new WhatsAppSendError('Idioma de plantilla inválido');
  for (const p of template.bodyParams) {
    if (!p.trim() || /[\n\t]| {4,}/.test(p)) throw new WhatsAppSendError('Parámetro de plantilla vacío o con saltos de línea');
  }
  return sendMessage(config, to, {
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language },
      ...(template.bodyParams.length
        ? { components: [{ type: 'body', parameters: template.bodyParams.map((text) => ({ type: 'text', text })) }] }
        : {}),
    },
  });
}
