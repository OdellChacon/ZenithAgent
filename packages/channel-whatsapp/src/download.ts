import { WhatsAppSendError, type WhatsAppSendConfig } from './send.js';

/**
 * Descarga de archivos que manda el cliente (WhatsApp Cloud API):
 * 1. GET https://graph.facebook.com/{version}/{media_id} con el token → { url, mime_type, file_size }
 * 2. GET {url} con el mismo token → los bytes. Según Meta, la url vence a los 5 minutos.
 *
 * El token solo se manda a hosts de Meta (o al simulador local configurado en graphBaseUrl):
 * la url viene en una respuesta y no debe poder llevarse el token a otro lado.
 */
export const WHATSAPP_MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** Notas de voz y audios: WhatsApp los manda como ogg/opus; también pueden llegar mp3, m4a o amr. */
export const WHATSAPP_AUDIO_MIME_TYPES = new Set(['audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr']);
/** Audios: hasta 16 MB según Meta. */
export const WHATSAPP_MAX_AUDIO_BYTES = 16 * 1024 * 1024;
/** Videos del cliente: MP4 o 3GP, hasta 16 MB según Meta. */
export const WHATSAPP_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/3gpp']);
export const WHATSAPP_MAX_VIDEO_BYTES_IN = 16 * 1024 * 1024;
/** Stickers: WebP. */
export const WHATSAPP_STICKER_MIME_TYPES = new Set(['image/webp']);
/**
 * Documentos del cliente: Meta admite hasta 100 MB, pero el panel solo los sirve hasta 25 MB
 * para no tener al servidor descargando archivos enormes por cada clic.
 */
export const WHATSAPP_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg',
  'image/png',
]);
export const WHATSAPP_MAX_DOCUMENT_BYTES_IN = 25 * 1024 * 1024;
const META_MEDIA_HOST_SUFFIXES = ['.fbsbx.com', '.facebook.com', '.whatsapp.net', '.fbcdn.net'];
const GRAPH_VERSION_RE = /^v\d+\.\d+$/;
const MEDIA_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const DEFAULT_GRAPH_BASE_URL = 'https://graph.facebook.com';

export type DownloadResult =
  | { ok: true; data: Buffer; mimeType: string }
  | { ok: false; retryable: boolean; httpStatus: number | null; message: string };

type DownloadConfig = Omit<WhatsAppSendConfig, 'phoneNumberId'> & { maxBytes?: number; allowedMimeTypes?: ReadonlySet<string> };

/** ¿Se le puede mandar el token a esta url? */
export function isTrustedMediaUrl(url: string, graphBaseUrl?: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (graphBaseUrl) {
    const base = new URL(graphBaseUrl);
    const local = base.hostname === 'localhost' || base.hostname === '127.0.0.1';
    // Con el simulador local, la url apunta al mismo origen que la Graph API simulada.
    if (local && u.origin === base.origin) return true;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return META_MEDIA_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

async function get(config: DownloadConfig, url: string): Promise<Response | { error: string }> {
  const doFetch = config.fetch ?? fetch;
  try {
    return await doFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.accessToken}` },
      redirect: 'error', // una redirección podría llevarse el token a otro host
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
  } catch (err) {
    return { error: (err as Error).message };
  }
}

const retryableStatus = (status: number) => status === 429 || status >= 500;

/** Descarga un archivo del cliente (imagen por defecto). No lanza por errores de red o de Meta. */
export async function downloadWhatsAppMedia(config: DownloadConfig, mediaId: string): Promise<DownloadResult> {
  if (!GRAPH_VERSION_RE.test(config.graphApiVersion)) {
    throw new WhatsAppSendError('META_GRAPH_API_VERSION debe tener la forma vNN.N');
  }
  if (!MEDIA_ID_RE.test(mediaId)) return { ok: false, retryable: false, httpStatus: null, message: 'Id de archivo inválido' };
  const maxBytes = config.maxBytes ?? WHATSAPP_MAX_DOWNLOAD_BYTES;
  const base = new URL(config.graphBaseUrl ?? DEFAULT_GRAPH_BASE_URL);
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') {
    throw new WhatsAppSendError('La URL de Graph API debe usar https');
  }

  const infoRes = await get(config, new URL(`/${config.graphApiVersion}/${encodeURIComponent(mediaId)}`, base).toString());
  if ('error' in infoRes) return { ok: false, retryable: true, httpStatus: null, message: `Error de red: ${infoRes.error}` };
  const info = (await infoRes.json().catch(() => null)) as
    | { url?: string; mime_type?: string; file_size?: number; error?: { message?: string } }
    | null;
  if (!infoRes.ok || !info?.url) {
    return {
      ok: false,
      retryable: retryableStatus(infoRes.status),
      httpStatus: infoRes.status,
      message: info?.error?.message ?? `Meta no devolvió la url del archivo (HTTP ${infoRes.status})`,
    };
  }
  if (!isTrustedMediaUrl(info.url, config.graphBaseUrl)) {
    return { ok: false, retryable: false, httpStatus: null, message: 'La url del archivo no es de Meta' };
  }
  if (typeof info.file_size === 'number' && info.file_size > maxBytes) {
    return { ok: false, retryable: false, httpStatus: null, message: 'El archivo es demasiado grande' };
  }

  const fileRes = await get(config, info.url);
  if ('error' in fileRes) return { ok: false, retryable: true, httpStatus: null, message: `Error de red: ${fileRes.error}` };
  if (!fileRes.ok) {
    return { ok: false, retryable: retryableStatus(fileRes.status), httpStatus: fileRes.status, message: `Descarga fallida (HTTP ${fileRes.status})` };
  }
  const mimeType = (fileRes.headers.get('content-type') ?? info.mime_type ?? '').split(';')[0]!.trim().toLowerCase();
  if (!(config.allowedMimeTypes ?? DOWNLOAD_MIME_TYPES).has(mimeType)) {
    return { ok: false, retryable: false, httpStatus: null, message: `Tipo de archivo no admitido: ${mimeType || 'desconocido'}` };
  }
  const declared = Number(fileRes.headers.get('content-length') ?? '0');
  if (declared > maxBytes) return { ok: false, retryable: false, httpStatus: null, message: 'El archivo es demasiado grande' };

  // Se lee por partes para cortar si el servidor manda más de lo permitido.
  const reader = fileRes.body?.getReader();
  if (!reader) return { ok: false, retryable: true, httpStatus: null, message: 'Respuesta vacía' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, retryable: false, httpStatus: null, message: 'El archivo es demasiado grande' };
    }
    chunks.push(value);
  }
  if (!total) return { ok: false, retryable: false, httpStatus: null, message: 'El archivo está vacío' };
  return { ok: true, data: Buffer.concat(chunks), mimeType };
}
