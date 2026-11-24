import type { PoolClient } from '@zenith/db';
import { normalizeImage } from './images.js';

const MIME_BY_EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/**
 * Guarda (o reemplaza) la foto de la fachada del negocio. La convierte al formato que acepta
 * WhatsApp (JPEG o PNG de menos de 5 MB). Corre dentro de withTenant, con RLS.
 */
export async function saveStorefrontPhoto(client: PoolClient, tenantId: string, file: { name: string; data: Buffer }): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mime = MIME_BY_EXT[ext];
  if (!mime) throw new Error('La foto debe ser JPG, PNG o WebP');
  const image = await normalizeImage(`data:${mime};base64,${file.data.toString('base64')}`);
  if (!image) throw new Error('No se pudo leer la foto');
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO product_images (tenant_id, product_id, purpose, position, mime_type, data, bytes, sha256)
     VALUES ($1, NULL, 'storefront', 0, $2, $3, $4, $5)
     ON CONFLICT (tenant_id) WHERE purpose = 'storefront' DO UPDATE SET
       mime_type = EXCLUDED.mime_type, data = EXCLUDED.data, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256, updated_at = now()
     RETURNING id`,
    [tenantId, image.mimeType, image.data, image.data.length, image.sha256],
  );
  return rows[0]!.id;
}
