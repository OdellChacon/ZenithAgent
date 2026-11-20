import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MAX_IMAGES_PER_PRODUCT, normalizeImage, normalizeImages } from '../src/index.js';

async function dataUri(format: 'webp' | 'jpeg' | 'png', width = 40, height = 30) {
  const img = sharp({ create: { width, height, channels: 3, background: { r: 150, g: 100, b: 60 } } });
  const buf = await (format === 'webp' ? img.webp() : format === 'png' ? img.png() : img.jpeg()).toBuffer();
  return `data:image/${format};base64,${buf.toString('base64')}`;
}

describe('normalizeImage', () => {
  it('convierte WebP a JPEG, que es lo que acepta WhatsApp', async () => {
    const img = await normalizeImage(await dataUri('webp'));
    expect(img?.mimeType).toBe('image/jpeg');
    expect((await sharp(img!.data).metadata()).format).toBe('jpeg');
    expect(img?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('deja JPEG y PNG tal cual', async () => {
    const png = await dataUri('png');
    const img = await normalizeImage(png);
    expect(img?.mimeType).toBe('image/png');
    expect(img?.data.equals(Buffer.from(png.split(',')[1]!, 'base64'))).toBe(true);
  });

  it('achica las fotos enormes al convertirlas', async () => {
    const img = await normalizeImage(await dataUri('webp', 3000, 2000));
    const meta = await sharp(img!.data).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(1600);
  });

  it('descarta lo que no es una imagen válida', async () => {
    expect(await normalizeImage('data:image/webp;base64,AAAA')).toBeNull();
    expect(await normalizeImage('https://ejemplo.com/foto.jpg')).toBeNull();
    expect(await normalizeImage('data:text/plain;base64,aG9sYQ==')).toBeNull();
  });
});

describe('normalizeImages', () => {
  it(`guarda como máximo ${MAX_IMAGES_PER_PRODUCT} fotos válidas por producto`, async () => {
    const good = await dataUri('jpeg');
    const out = await normalizeImages(['data:image/webp;base64,AAAA', good, good, good, good]);
    expect(out).toHaveLength(MAX_IMAGES_PER_PRODUCT);
  });
});
