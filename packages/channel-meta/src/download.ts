import { downloadWhatsAppMedia, type DownloadResult } from '@zenith/channel-whatsapp';
import type { Channel, MediaRef } from '@zenith/core';

/**
 * Messenger e Instagram mandan la url del archivo en el CDN de Meta. Se baja sin token (la url
 * ya está firmada) y solo de hosts de Meta: la url viene en un webhook y no debe poder usarse
 * para que el servidor pida cualquier dirección.
 */
const META_CDN_SUFFIXES = ['.fbcdn.net', '.fbsbx.com', '.cdninstagram.com', '.facebook.com', '.instagram.com'];

export function isMetaCdnUrl(url: string, localBaseUrl?: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (localBaseUrl) {
    const base = new URL(localBaseUrl);
    const local = base.hostname === 'localhost' || base.hostname === '127.0.0.1';
    if (local && u.origin === base.origin) return true; // simulador local
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return META_CDN_SUFFIXES.some((s) => host.endsWith(s));
}

export interface UrlDownloadOptions {
  maxBytes: number;
  allowedMimeTypes: ReadonlySet<string>;
  /** Solo para el simulador local. */
  localBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Baja un archivo del CDN de Meta. No lanza por errores de red. */
export async function downloadMetaUrl(url: string, opts: UrlDownloadOptions): Promise<DownloadResult> {
  if (!isMetaCdnUrl(url, opts.localBaseUrl)) return { ok: false, retryable: false, httpStatus: null, message: 'La url del archivo no es de Meta' };
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
  } catch (err) {
    return { ok: false, retryable: true, httpStatus: null, message: `Error de red: ${(err as Error).message}` };
  }
  // Una redirección no debe sacar la descarga de los hosts de Meta.
  if (res.url && res.url !== url && !isMetaCdnUrl(res.url, opts.localBaseUrl)) {
    return { ok: false, retryable: false, httpStatus: null, message: 'La descarga salió de los hosts de Meta' };
  }
  if (!res.ok) return { ok: false, retryable: res.status === 429 || res.status >= 500, httpStatus: res.status, message: `Descarga fallida (HTTP ${res.status})` };
  const mimeType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!opts.allowedMimeTypes.has(mimeType)) {
    return { ok: false, retryable: false, httpStatus: null, message: `Tipo de archivo no admitido: ${mimeType || 'desconocido'}` };
  }
  if (Number(res.headers.get('content-length') ?? '0') > opts.maxBytes) {
    return { ok: false, retryable: false, httpStatus: null, message: 'El archivo es demasiado grande' };
  }
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, retryable: true, httpStatus: null, message: 'Respuesta vacía' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > opts.maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, retryable: false, httpStatus: null, message: 'El archivo es demasiado grande' };
    }
    chunks.push(value);
  }
  if (!total) return { ok: false, retryable: false, httpStatus: null, message: 'El archivo está vacío' };
  return { ok: true, data: Buffer.concat(chunks), mimeType };
}

export interface CustomerMediaAccess {
  channel: Channel;
  /** Token del número (WhatsApp). Messenger e Instagram no lo necesitan para bajar. */
  accessToken?: string;
  graphApiVersion: string;
  graphBaseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Baja un archivo que mandó el cliente, venga del canal que venga: en WhatsApp por su id con
 * el token del número; en Messenger e Instagram por la url del CDN de Meta.
 */
export async function downloadCustomerMedia(
  access: CustomerMediaAccess,
  ref: Pick<MediaRef, 'externalMediaId' | 'url'>,
  limits: { maxBytes: number; allowedMimeTypes: ReadonlySet<string>; timeoutMs?: number },
): Promise<DownloadResult> {
  if (access.channel === 'whatsapp') {
    if (!access.accessToken || !ref.externalMediaId) return { ok: false, retryable: false, httpStatus: null, message: 'Falta el id del archivo o el token' };
    return downloadWhatsAppMedia(
      {
        graphApiVersion: access.graphApiVersion,
        accessToken: access.accessToken,
        maxBytes: limits.maxBytes,
        allowedMimeTypes: limits.allowedMimeTypes,
        ...(limits.timeoutMs ? { timeoutMs: limits.timeoutMs } : {}),
        ...(access.graphBaseUrl ? { graphBaseUrl: access.graphBaseUrl } : {}),
        ...(access.fetch ? { fetch: access.fetch } : {}),
      },
      ref.externalMediaId,
    ).catch((err: Error) => ({ ok: false as const, retryable: false, httpStatus: null, message: err.message }));
  }
  if (!ref.url) return { ok: false, retryable: false, httpStatus: null, message: 'Falta la url del archivo' };
  return downloadMetaUrl(ref.url, {
    maxBytes: limits.maxBytes,
    allowedMimeTypes: limits.allowedMimeTypes,
    ...(limits.timeoutMs ? { timeoutMs: limits.timeoutMs } : {}),
    ...(access.graphBaseUrl ? { localBaseUrl: access.graphBaseUrl } : {}),
    ...(access.fetch ? { fetch: access.fetch } : {}),
  });
}
