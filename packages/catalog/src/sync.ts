import type { PoolClient } from '@zenith/db';
import type { ProductImageInput } from './images.js';

export interface ProductInput {
  /** Fotos ya normalizadas; si no se pasa, no se tocan las fotos guardadas. */
  images?: ProductImageInput[];
  externalId: string;
  name: string;
  category: string | null;
  categoryName: string | null;
  description: string | null;
  format: string | null;
  pieceWidthCm: number | null;
  pieceLengthCm: number | null;
  areaPerBoxM2: number | null;
  piecesPerBox: number | null;
  attributes: Record<string, unknown>;
  price: number | null;
  currency: string | null;
  onOffer: boolean;
  inVisualizer: boolean;
}

export interface SyncResult {
  upserted: number;
  deactivated: number;
  /** Fotos nuevas o cambiadas. */
  images: number;
}

/**
 * Inserta o actualiza los productos de una fuente y desactiva los que ya no aparecen.
 * Debe correr dentro de `withTenant`: RLS garantiza que solo toca el catálogo de ese tenant.
 * Si la fuente vino vacía no desactiva nada, para no vaciar el catálogo por una caída de la tienda.
 */
export async function syncProducts(client: PoolClient, tenantId: string, source: string, products: ProductInput[]): Promise<SyncResult> {
  if (products.length === 0) return { upserted: 0, deactivated: 0, images: 0 };

  const ids = new Set<string>();
  for (const p of products) {
    if (ids.has(p.externalId)) throw new Error(`Producto repetido en la fuente: ${p.externalId}`);
    ids.add(p.externalId);
  }

  const { rowCount: upserted } = await client.query(
    `INSERT INTO products (
       tenant_id, source, external_id, name, category, category_name, description, format,
       piece_width_cm, piece_length_cm, area_per_box_m2, pieces_per_box, attributes,
       price, currency, on_offer, in_visualizer, active, synced_at)
     SELECT $1, $2, p.external_id, p.name, p.category, p.category_name, p.description, p.format,
            p.piece_width_cm, p.piece_length_cm, p.area_per_box_m2, p.pieces_per_box, p.attributes,
            p.price, p.currency, p.on_offer, p.in_visualizer, true, now()
       FROM jsonb_to_recordset($3::jsonb) AS p(
         external_id text, name text, category text, category_name text, description text, format text,
         piece_width_cm numeric, piece_length_cm numeric, area_per_box_m2 numeric, pieces_per_box int,
         attributes jsonb, price numeric, currency char(3), on_offer boolean, in_visualizer boolean)
     ON CONFLICT (tenant_id, source, external_id) DO UPDATE SET
       name = EXCLUDED.name, category = EXCLUDED.category, category_name = EXCLUDED.category_name,
       description = EXCLUDED.description, format = EXCLUDED.format,
       piece_width_cm = EXCLUDED.piece_width_cm, piece_length_cm = EXCLUDED.piece_length_cm,
       area_per_box_m2 = EXCLUDED.area_per_box_m2, pieces_per_box = EXCLUDED.pieces_per_box,
       attributes = EXCLUDED.attributes, price = EXCLUDED.price, currency = EXCLUDED.currency,
       on_offer = EXCLUDED.on_offer, in_visualizer = EXCLUDED.in_visualizer,
       active = true, synced_at = now()`,
    [
      tenantId,
      source,
      JSON.stringify(
        products.map((p) => ({
          external_id: p.externalId,
          name: p.name,
          category: p.category,
          category_name: p.categoryName,
          description: p.description,
          format: p.format,
          piece_width_cm: p.pieceWidthCm,
          piece_length_cm: p.pieceLengthCm,
          area_per_box_m2: p.areaPerBoxM2,
          pieces_per_box: p.piecesPerBox,
          attributes: p.attributes,
          price: p.price,
          currency: p.currency,
          on_offer: p.onOffer,
          in_visualizer: p.inVisualizer,
        })),
      ),
    ],
  );

  const { rowCount: deactivated } = await client.query(
    `UPDATE products SET active = false, synced_at = now()
      WHERE tenant_id = $1 AND source = $2 AND active AND NOT (external_id = ANY($3::text[]))`,
    [tenantId, source, [...ids]],
  );

  const images = await syncImages(client, tenantId, source, products);
  return { upserted: upserted ?? 0, deactivated: deactivated ?? 0, images };
}

/** Guarda las fotos de cada producto; solo reescribe las que cambiaron. */
async function syncImages(client: PoolClient, tenantId: string, source: string, products: ProductInput[]): Promise<number> {
  const withImages = products.filter((p) => p.images);
  if (!withImages.length) return 0;
  const { rows } = await client.query<{ id: string; external_id: string }>(
    'SELECT id, external_id FROM products WHERE tenant_id = $1 AND source = $2 AND external_id = ANY($3::text[])',
    [tenantId, source, withImages.map((p) => p.externalId)],
  );
  const productIds = new Map(rows.map((r) => [r.external_id, r.id]));
  let written = 0;
  for (const p of withImages) {
    const productId = productIds.get(p.externalId);
    if (!productId) continue;
    const images = p.images ?? [];
    for (const [position, img] of images.entries()) {
      const { rowCount } = await client.query(
        `INSERT INTO product_images (tenant_id, product_id, position, mime_type, data, bytes, sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (product_id, position) DO UPDATE SET
           mime_type = EXCLUDED.mime_type, data = EXCLUDED.data, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256, updated_at = now()
         WHERE product_images.sha256 <> EXCLUDED.sha256`,
        [tenantId, productId, position, img.mimeType, img.data, img.data.length, img.sha256],
      );
      written += rowCount ?? 0;
    }
    await client.query('DELETE FROM product_images WHERE product_id = $1 AND position >= $2', [productId, images.length]);
  }
  return written;
}
