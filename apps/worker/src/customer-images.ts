import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { decryptCredentials, type Channel } from '@zenith/core';
import {
  WHATSAPP_MAX_DOWNLOAD_BYTES,
  WHATSAPP_MAX_VIDEO_BYTES_IN,
  WHATSAPP_VIDEO_MIME_TYPES,
} from '@zenith/channel-whatsapp';
import { downloadCustomerMedia, META_MAX_IMAGE_BYTES, type CustomerMediaAccess } from '@zenith/channel-meta';
import type { HistoryMessage, ModelImage } from '@zenith/brain';

/** Lo necesario para bajar los archivos que manda el cliente. */
export interface CustomerMediaDeps {
  masterKey: Buffer;
  graphApiVersion: string;
  graphBaseUrl?: string;
  fetch?: typeof fetch;
  log?: (msg: string, data: Record<string, unknown>) => void;
  /** Ruta de ffmpeg para sacar un cuadro de los videos (por defecto, el del PATH). */
  ffmpegPath?: string;
}

export interface PendingImage extends HistoryMessage {
  id: string;
  externalMediaId: string | null;
  /** Messenger e Instagram: url del archivo en el CDN de Meta. */
  mediaUrl?: string | null;
  mimeType?: string | null;
}

export interface ChannelAccountCreds {
  channel: string;
  channelAccountId: string;
  credentialsEnc: Buffer | null;
}

/** Lado mayor de la foto que ve el modelo: suficiente para reconocer el diseño. */
const MODEL_IMAGE_MAX_SIDE = 1024;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DOCUMENT_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png']);
const FFMPEG_TIMEOUT_MS = 30_000;

/**
 * Prepara una foto del cliente para el modelo: la gira según EXIF, la achica y la pasa a
 * JPEG. Al volver a codificarla se pierden los metadatos (por ejemplo, la ubicación GPS).
 */
export async function toModelImage(data: Buffer): Promise<ModelImage | null> {
  try {
    const jpeg = await sharp(data, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: MODEL_IMAGE_MAX_SIDE, height: MODEL_IMAGE_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { mediaType: 'image/jpeg', base64: jpeg.toString('base64') };
  } catch {
    return null;
  }
}

/**
 * Saca un cuadro representativo de un video con ffmpeg (filtro thumbnail). El video va a un
 * archivo temporal porque los MP4 suelen tener el índice al final y no se leen bien por tubería.
 * Corre sin shell y se corta si se demora.
 */
export async function videoFrame(data: Buffer, ffmpegPath = 'ffmpeg'): Promise<Buffer | null> {
  const file = path.join(tmpdir(), `zenith-video-${randomUUID()}`);
  try {
    await writeFile(file, data);
    return await new Promise<Buffer | null>((resolve) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'thumbnail,scale=1024:-2', '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1'];
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      } catch {
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      let done = false;
      const finish = (v: Buffer | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        finish(null);
      }, FFMPEG_TIMEOUT_MS);
      proc.on('error', () => finish(null)); // ffmpeg no instalado
      proc.stdout!.on('data', (c: Buffer) => chunks.push(c));
      proc.on('close', (code) => finish(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
    });
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

/** Token del número de WhatsApp (Messenger e Instagram no lo necesitan para bajar). */
export function mediaAccess(deps: CustomerMediaDeps, account: ChannelAccountCreds): CustomerMediaAccess | null {
  const base = {
    channel: account.channel as Channel,
    graphApiVersion: deps.graphApiVersion,
    ...(deps.graphBaseUrl ? { graphBaseUrl: deps.graphBaseUrl } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
  if (account.channel === 'messenger' || account.channel === 'instagram') return base;
  if (account.channel !== 'whatsapp' || !account.credentialsEnc) return null;
  try {
    const creds = JSON.parse(decryptCredentials(account.credentialsEnc, deps.masterKey, account.channelAccountId)) as { accessToken?: string };
    return creds.accessToken ? { ...base, accessToken: creds.accessToken } : null;
  } catch {
    deps.log?.('no se pudieron leer las credenciales para bajar archivos', { channelAccountId: account.channelAccountId });
    return null;
  }
}

/** Límites de descarga según lo que se quiere ver. */
function limitsFor(m: PendingImage) {
  if (m.type === 'video') return { maxBytes: WHATSAPP_MAX_VIDEO_BYTES_IN, allowedMimeTypes: WHATSAPP_VIDEO_MIME_TYPES, timeoutMs: 30_000 };
  if (m.type === 'document') return { maxBytes: WHATSAPP_MAX_DOWNLOAD_BYTES, allowedMimeTypes: DOCUMENT_IMAGE_MIME_TYPES };
  return { maxBytes: Math.max(WHATSAPP_MAX_DOWNLOAD_BYTES, META_MAX_IMAGE_BYTES), allowedMimeTypes: IMAGE_MIME_TYPES };
}

/**
 * Descarga lo que el modelo puede mirar: fotos, un cuadro de cada video y los documentos que en
 * realidad son imágenes. Si algo falla, se omite y el modelo recibe una nota de texto: un
 * archivo que no baja no debe dejar al cliente sin respuesta.
 */
export async function loadCustomerImages(
  deps: CustomerMediaDeps,
  account: ChannelAccountCreds,
  pending: PendingImage[],
): Promise<Map<string, ModelImage>> {
  const out = new Map<string, ModelImage>();
  if (!pending.length) return out;
  const access = mediaAccess(deps, account);
  if (!access) return out;

  await Promise.all(
    pending.map(async (m) => {
      if (!m.externalMediaId && !m.mediaUrl) return;
      // Un documento que no es imagen (PDF, Word…) no se baja: el modelo no lo puede mirar.
      if (m.type === 'document' && m.mimeType && !DOCUMENT_IMAGE_MIME_TYPES.has(m.mimeType)) return;
      const res = await downloadCustomerMedia(access, { externalMediaId: m.externalMediaId ?? '', ...(m.mediaUrl ? { url: m.mediaUrl } : {}) }, limitsFor(m));
      if (!res.ok) {
        deps.log?.('no se pudo bajar un archivo del cliente', { messageId: m.id, type: m.type, error: res.message });
        return;
      }
      const still = m.type === 'video' ? await videoFrame(res.data, deps.ffmpegPath) : res.data;
      if (!still) {
        deps.log?.('no se pudo sacar un cuadro del video (¿está instalado ffmpeg?)', { messageId: m.id });
        return;
      }
      const image = await toModelImage(still);
      if (image) out.set(m.id, image);
      else deps.log?.('el archivo del cliente no se pudo leer como imagen', { messageId: m.id });
    }),
  );
  return out;
}
