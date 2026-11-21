import sharp from 'sharp';
import { decryptCredentials } from '@zenith/core';
import { downloadWhatsAppMedia } from '@zenith/channel-whatsapp';
import type { HistoryMessage, ModelImage } from '@zenith/brain';

/** Lo necesario para bajar las fotos que manda el cliente por WhatsApp. */
export interface CustomerMediaDeps {
  masterKey: Buffer;
  graphApiVersion: string;
  graphBaseUrl?: string;
  fetch?: typeof fetch;
  log?: (msg: string, data: Record<string, unknown>) => void;
}

export interface PendingImage extends HistoryMessage {
  id: string;
  externalMediaId: string | null;
}

export interface ChannelAccountCreds {
  channel: string;
  channelAccountId: string;
  credentialsEnc: Buffer | null;
}

/** Lado mayor de la foto que ve el modelo: suficiente para reconocer el diseño. */
const MODEL_IMAGE_MAX_SIDE = 1024;

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
 * Descarga las fotos pendientes del cliente. Si una falla, se omite y el modelo recibe la
 * nota de "imagen no disponible": una foto que no baja no debe dejar al cliente sin respuesta.
 */
export async function loadCustomerImages(
  deps: CustomerMediaDeps,
  account: ChannelAccountCreds,
  pending: PendingImage[],
): Promise<Map<string, ModelImage>> {
  const out = new Map<string, ModelImage>();
  if (!pending.length || account.channel !== 'whatsapp' || !account.credentialsEnc) return out;

  let accessToken: string;
  try {
    const creds = JSON.parse(decryptCredentials(account.credentialsEnc, deps.masterKey, account.channelAccountId)) as {
      accessToken?: string;
    };
    if (!creds.accessToken) return out;
    accessToken = creds.accessToken;
  } catch {
    deps.log?.('no se pudieron leer las credenciales para bajar fotos', { channelAccountId: account.channelAccountId });
    return out;
  }

  await Promise.all(
    pending.map(async (m) => {
      if (!m.externalMediaId) return;
      const res = await downloadWhatsAppMedia(
        {
          graphApiVersion: deps.graphApiVersion,
          accessToken,
          ...(deps.graphBaseUrl ? { graphBaseUrl: deps.graphBaseUrl } : {}),
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        },
        m.externalMediaId,
      ).catch((err: Error) => ({ ok: false as const, message: err.message }));
      if (!res.ok) {
        deps.log?.('no se pudo bajar una foto del cliente', { messageId: m.id, error: res.message });
        return;
      }
      const image = await toModelImage(res.data);
      if (image) out.set(m.id, image);
      else deps.log?.('la foto del cliente no se pudo leer', { messageId: m.id });
    }),
  );
  return out;
}
