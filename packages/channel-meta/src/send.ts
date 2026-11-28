import type { SendFailure, SendResult } from '@zenith/channel-whatsapp';

/**
 * Envío por la Send API de Messenger, que también atiende a las cuentas de Instagram
 * vinculadas a una página (Facebook Login):
 *   POST https://graph.facebook.com/{version}/{page_id}/messages   (token de la página)
 *   POST https://graph.facebook.com/{version}/{page_id}/message_attachments   (subida de archivos)
 *
 * Confirmado en la documentación de Meta (27/11/2026):
 * - destinatario: recipient.id = PSID (Messenger) o IGSID (Instagram); messaging_type RESPONSE
 *   dentro de las 24 h desde el último mensaje del cliente;
 * - entre 24 h y 7 días solo puede contestar una persona, con la etiqueta Human Agent;
 * - Instagram: texto de hasta 1000 bytes (UTF-8); imágenes PNG o JPEG hasta 8 MB, audio, video
 *   y archivos hasta 25 MB.
 * Por confirmar al hacer la revisión de la app (la referencia de la Send API no cargó):
 * - el literal de la etiqueta (se usa messaging_type MESSAGE_TAG + tag HUMAN_AGENT);
 * - el largo máximo del texto en Messenger (se asumen 2000 caracteres);
 * - la ruta de subida /{page_id}/message_attachments y su respuesta { attachment_id }.
 */
export const MESSENGER_MAX_TEXT_CHARS = 2000;
export const INSTAGRAM_MAX_TEXT_BYTES = 1000;
export const META_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const META_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Errores de límite de tasa de la Graph API (se reintentan). */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const AUTH_ERROR_CODES = new Set([0, 190]);
const GRAPH_VERSION_RE = /^v\d+\.\d+$/;
const ID_RE = /^\d{1,32}$/;

export interface MetaSendConfig {
  graphApiVersion: string;
  /** Página que envía (en Instagram, la página vinculada a la cuenta). */
  pageId: string;
  /** Token de la página. */
  accessToken: string;
  channel: 'messenger' | 'instagram';
  graphBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class MetaSendError extends Error {
  override name = 'MetaSendError';
}

function endpoint(config: MetaSendConfig, path: 'messages' | 'message_attachments'): string {
  if (!GRAPH_VERSION_RE.test(config.graphApiVersion)) throw new MetaSendError('META_GRAPH_API_VERSION debe tener la forma vNN.N');
  if (!ID_RE.test(config.pageId)) throw new MetaSendError('Id de página inválido');
  const base = new URL(config.graphBaseUrl ?? 'https://graph.facebook.com');
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') {
    throw new MetaSendError('La URL de Graph API debe usar https');
  }
  return new URL(`/${config.graphApiVersion}/${config.pageId}/${path}`, base).toString();
}

type Reply = { message_id?: string; attachment_id?: string; error?: { code?: number; message?: string } } | null;

async function call(config: MetaSendConfig, url: string, body: string | FormData): Promise<{ ok: true; data: Reply } | SendFailure> {
  let res: Response;
  try {
    res = await (config.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
      body,
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
  } catch (err) {
    return { ok: false, retryable: true, httpStatus: null, message: `Error de red: ${(err as Error).message}` };
  }
  const data = (await res.json().catch(() => null)) as Reply;
  if (res.ok && !data?.error) return { ok: true, data };
  const errorCode = data?.error?.code;
  const authError = res.status === 401 || (errorCode !== undefined && AUTH_ERROR_CODES.has(errorCode));
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

function checkRecipient(id: string) {
  if (!/^\d{1,40}$/.test(id)) throw new MetaSendError('Destinatario inválido');
}

/** Cómo se envía: respuesta normal (24 h) o respuesta de una persona con la etiqueta Human Agent. */
function messagingType(humanAgent: boolean) {
  return humanAgent ? { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' } : { messaging_type: 'RESPONSE' };
}

async function sendMessage(config: MetaSendConfig, to: string, message: Record<string, unknown>, humanAgent: boolean): Promise<SendResult> {
  checkRecipient(to);
  const res = await call(config, endpoint(config, 'messages'), JSON.stringify({ recipient: { id: to }, ...messagingType(humanAgent), message }));
  if (!res.ok) return res;
  const id = res.data?.message_id;
  return id ? { ok: true, externalMessageId: id } : { ok: false, retryable: false, httpStatus: 200, message: 'Meta no devolvió el id del mensaje' };
}

const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');

/**
 * Parte un texto largo en mensajes que entren en el canal, por párrafos, después por frases y
 * en último caso por palabras. Un mensaje del bot rara vez pasa el límite, pero un asesor sí
 * puede pegar uno largo.
 */
export function splitForMetaChannel(text: string, channel: 'messenger' | 'instagram'): string[] {
  const fits = (s: string) => (channel === 'instagram' ? byteLength(s) <= INSTAGRAM_MAX_TEXT_BYTES : s.length <= MESSENGER_MAX_TEXT_CHARS);
  const clean = text.trim();
  if (!clean) return [];
  if (fits(clean)) return [clean];
  const parts: string[] = [];
  let current = '';
  const pieces = clean.split(/(\n\n+|(?<=[.!?])\s+|\s+)/);
  for (const piece of pieces) {
    const next = current + piece;
    if (fits(next)) {
      current = next;
      continue;
    }
    if (current.trim()) parts.push(current.trim());
    current = piece.trimStart();
    // Una sola "palabra" que no entra (un enlace enorme): se corta por caracteres.
    while (current && !fits(current)) {
      let cut = current.length;
      while (cut > 1 && !fits(current.slice(0, cut))) cut = Math.floor(cut * 0.9);
      parts.push(current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Avance de un envío en varias partes. Con `skip` un reintento salta las partes que ya llegaron
 * y `onPart` se llama al confirmar cada una, para guardarlo antes de mandar la siguiente.
 */
export interface MetaSendProgress {
  skip: number;
  onPart(index: number, externalMessageId: string): Promise<void>;
  /** Id de la última parte ya enviada (si todas se saltan, es el resultado). */
  lastExternalId?: string | null;
}

export interface MetaSendOptions {
  humanAgent?: boolean;
  progress?: MetaSendProgress;
}

/** Manda una secuencia de mensajes en orden; se detiene en el primero que falla. */
async function sendParts(config: MetaSendConfig, to: string, messages: Record<string, unknown>[], opts: MetaSendOptions): Promise<SendResult> {
  const skip = opts.progress?.skip ?? 0;
  let last: SendResult | null = null;
  for (let i = skip; i < messages.length; i++) {
    last = await sendMessage(config, to, messages[i]!, opts.humanAgent ?? false);
    if (!last.ok) return last;
    await opts.progress?.onPart(i, last.externalMessageId);
  }
  if (last) return last;
  // Todo había salido en un intento anterior.
  return opts.progress?.lastExternalId
    ? { ok: true, externalMessageId: opts.progress.lastExternalId }
    : { ok: false, retryable: false, httpStatus: null, message: 'No quedaba nada por enviar y no hay id del último mensaje' };
}

const textParts = (text: string, channel: 'messenger' | 'instagram') => splitForMetaChannel(text, channel).map((part) => ({ text: part }));

/**
 * Envía un texto. Si no entra en un mensaje se manda en varios; devuelve el id del último.
 * Si uno de los trozos falla, se devuelve el error (los anteriores ya salieron: con `progress`
 * el reintento sigue desde el que falló).
 */
export async function sendMetaText(config: MetaSendConfig, to: string, text: string, opts: MetaSendOptions = {}): Promise<SendResult> {
  checkRecipient(to);
  const parts = textParts(text, config.channel);
  if (!parts.length) throw new MetaSendError('El mensaje está vacío');
  return sendParts(config, to, parts, opts);
}

export type MetaAttachmentType = 'image' | 'video' | 'audio' | 'file';

/** Sube un archivo para mandarlo después por su attachment_id (reutilizable). */
export async function uploadMetaAttachment(
  config: MetaSendConfig,
  data: Buffer,
  mimeType: string,
  type: MetaAttachmentType,
  filename: string,
): Promise<{ ok: true; attachmentId: string } | SendFailure> {
  if (!data.length) throw new MetaSendError('El archivo está vacío');
  const limit = type === 'image' ? META_MAX_IMAGE_BYTES : META_MAX_FILE_BYTES;
  if (data.length > limit) throw new MetaSendError(`El archivo supera los ${Math.round(limit / 1024 / 1024)} MB`);
  const form = new FormData();
  form.append('message', JSON.stringify({ attachment: { type, payload: { is_reusable: true } } }));
  form.append('filedata', new Blob([new Uint8Array(data)], { type: mimeType }), filename);
  const res = await call(config, endpoint(config, 'message_attachments'), form);
  if (!res.ok) return res;
  const id = res.data?.attachment_id;
  return id ? { ok: true, attachmentId: id } : { ok: false, retryable: false, httpStatus: 200, message: 'Meta no devolvió el id del archivo' };
}

/**
 * Envía un archivo ya subido. Messenger e Instagram no tienen pie de foto: va como texto aparte,
 * después del archivo. Si el texto falla se devuelve el error, para que el reintento lo mande
 * (con `progress`, sin repetir el archivo).
 */
export async function sendMetaAttachment(
  config: MetaSendConfig,
  to: string,
  attachment: { type: MetaAttachmentType; attachmentId: string; caption?: string },
  opts: MetaSendOptions = {},
): Promise<SendResult> {
  checkRecipient(to);
  if (!attachment.attachmentId) throw new MetaSendError('Falta el id del archivo');
  const messages: Record<string, unknown>[] = [{ attachment: { type: attachment.type, payload: { attachment_id: attachment.attachmentId } } }];
  if (attachment.caption?.trim()) messages.push(...textParts(attachment.caption, config.channel));
  return sendParts(config, to, messages, opts);
}

/** "Visto" y "escribiendo…" mientras el bot prepara la respuesta. Si falla no pasa nada. */
export async function sendMetaSenderAction(config: MetaSendConfig, to: string, action: 'mark_seen' | 'typing_on'): Promise<boolean> {
  checkRecipient(to);
  const res = await call(config, endpoint(config, 'messages'), JSON.stringify({ recipient: { id: to }, sender_action: action }));
  return res.ok;
}
