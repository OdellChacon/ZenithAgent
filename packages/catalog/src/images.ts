import { createHash } from 'node:crypto';
import sharp from 'sharp';

export interface ProductImageInput {
  mimeType: 'image/jpeg' | 'image/png';
  data: Buffer;
  sha256: string;
}

/** Fotos por producto que se guardan; el bot envía la primera. */
export const MAX_IMAGES_PER_PRODUCT = 3;
/** WhatsApp acepta hasta 5 MB por imagen; se deja margen. */
const MAX_BYTES = 4.5 * 1024 * 1024;
const MAX_SIDE = 1600;

const DATA_URI_RE = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/;

/**
 * Convierte una foto embebida de la tienda (data URI) al formato que acepta WhatsApp:
 * JPEG o PNG de menos de 5 MB. WebP y otros formatos pasan a JPEG. Devuelve null si la foto
 * no se puede leer, en vez de romper la sincronización.
 */
export async function normalizeImage(dataUri: string): Promise<ProductImageInput | null> {
  const m = DATA_URI_RE.exec(dataUri);
  if (!m) return null;
  const mime = m[1]!;
  const input = Buffer.from(m[2]!.replace(/\s/g, ''), 'base64');
  if (!input.length) return null;

  try {
    let data: Buffer;
    let mimeType: ProductImageInput['mimeType'];
    if ((mime === 'image/jpeg' || mime === 'image/png') && input.length <= MAX_BYTES) {
      // Se valida que sea una imagen real antes de guardarla tal cual.
      await sharp(input).metadata();
      data = input;
      mimeType = mime;
    } else {
      data = await sharp(input)
        .rotate()
        .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
      mimeType = 'image/jpeg';
    }
    if (data.length > MAX_BYTES) return null;
    return { mimeType, data, sha256: createHash('sha256').update(data).digest('hex') };
  } catch {
    return null;
  }
}

export async function normalizeImages(dataUris: string[]): Promise<ProductImageInput[]> {
  const out: ProductImageInput[] = [];
  for (const uri of dataUris) {
    if (out.length >= MAX_IMAGES_PER_PRODUCT) break;
    const img = await normalizeImage(uri);
    if (img) out.push(img);
  }
  return out;
}
