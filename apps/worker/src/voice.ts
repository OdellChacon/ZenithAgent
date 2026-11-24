import { spawn } from 'node:child_process';
import { decryptCredentials } from '@zenith/core';
import { downloadWhatsAppMedia, WHATSAPP_AUDIO_MIME_TYPES, WHATSAPP_MAX_AUDIO_BYTES } from '@zenith/channel-whatsapp';
import { transcribeVoiceNote, type HistoryMessage, type LlmClient, type ModelAudio } from '@zenith/brain';
import type { ChannelAccountCreds, CustomerMediaDeps } from './customer-images.js';

/** Transcripción de notas de voz. Sin esto, el bot le pide al cliente que escriba. */
export interface VoiceDeps {
  llm: LlmClient;
  model: string;
  /** Ruta de ffmpeg (por defecto, el del PATH). */
  ffmpegPath?: string;
}

/** Más que esto no se escucha: una nota de voz de venta rara vez pasa de 2 o 3 minutos. */
const MAX_SECONDS = 300;
const FFMPEG_TIMEOUT_MS = 30_000;
const MAX_MP3_BYTES = 8 * 1024 * 1024;

/**
 * Pasa el audio de WhatsApp (ogg/opus u otro) a mp3 mono de 16 kHz, que es lo que acepta el
 * modelo. Corre ffmpeg sin shell, con entrada y salida por tuberías, y lo corta si se demora.
 */
export function toModelAudio(data: Buffer, ffmpegPath = 'ffmpeg'): Promise<ModelAudio | null> {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', String(MAX_SECONDS), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', 'pipe:1'];
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: ModelAudio | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(null);
    }, FFMPEG_TIMEOUT_MS);
    proc.on('error', () => finish(null)); // ffmpeg no instalado
    proc.stdout!.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_MP3_BYTES) {
        proc.kill('SIGKILL');
        finish(null);
        return;
      }
      chunks.push(c);
    });
    proc.on('close', (code) => finish(code === 0 && size > 0 ? { format: 'mp3', base64: Buffer.concat(chunks).toString('base64') } : null));
    proc.stdin!.on('error', () => undefined); // ffmpeg puede cerrar la entrada antes de leerla toda
    proc.stdin!.end(data);
  });
}

/**
 * Baja, convierte y transcribe las notas de voz pendientes. Devuelve el texto por id de
 * mensaje; las que fallan no se incluyen (el bot le pide al cliente que la repita o la escriba).
 */
export async function transcribeVoiceNotes(
  media: CustomerMediaDeps,
  voice: VoiceDeps,
  account: ChannelAccountCreds,
  pending: (HistoryMessage & { id: string; externalMediaId: string | null })[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!pending.length || account.channel !== 'whatsapp' || !account.credentialsEnc) return out;
  let accessToken: string;
  try {
    const creds = JSON.parse(decryptCredentials(account.credentialsEnc, media.masterKey, account.channelAccountId)) as { accessToken?: string };
    if (!creds.accessToken) return out;
    accessToken = creds.accessToken;
  } catch {
    media.log?.('no se pudieron leer las credenciales para bajar audios', { channelAccountId: account.channelAccountId });
    return out;
  }

  for (const m of pending) {
    if (!m.externalMediaId) continue;
    const file = await downloadWhatsAppMedia(
      {
        graphApiVersion: media.graphApiVersion,
        accessToken,
        maxBytes: WHATSAPP_MAX_AUDIO_BYTES,
        allowedMimeTypes: WHATSAPP_AUDIO_MIME_TYPES,
        timeoutMs: 20_000,
        ...(media.graphBaseUrl ? { graphBaseUrl: media.graphBaseUrl } : {}),
        ...(media.fetch ? { fetch: media.fetch } : {}),
      },
      m.externalMediaId,
    ).catch((err: Error) => ({ ok: false as const, message: err.message }));
    if (!file.ok) {
      media.log?.('no se pudo bajar una nota de voz', { messageId: m.id, error: file.message });
      continue;
    }
    const audio = await toModelAudio(file.data, voice.ffmpegPath);
    if (!audio) {
      media.log?.('no se pudo convertir una nota de voz (¿está instalado ffmpeg?)', { messageId: m.id });
      continue;
    }
    try {
      const text = await transcribeVoiceNote(voice.llm, voice.model, audio);
      if (text) out.set(m.id, text);
      else media.log?.('la nota de voz no se entendió', { messageId: m.id });
    } catch (err) {
      media.log?.('falló la transcripción de una nota de voz', { messageId: m.id, error: (err as Error).message });
    }
  }
  return out;
}
