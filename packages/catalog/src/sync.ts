import type { PoolClient } from '@zenith/db';

export interface ProductInput {
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
}

/**
 * Inserta o actualiza los productos de una fuente y desactiva los que ya no aparecen.
 * Debe correr dentro de `withTenant`: RLS garantiza que solo toca el catálogo de ese tenant.
 * Si la fuente vino vacía no desactiva nada, para no vaciar el catálogo por una caída de la tienda.
 */
export async function syncProducts(client: PoolClient, tenantId: string, source: string, products: ProductInput[]): Promise<SyncResult> {
  if (products.length === 0) return { upserted: 0, deactivated: 0 };

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

  return { upserted: upserted ?? 0, deactivated: deactivated ?? 0 };
}
