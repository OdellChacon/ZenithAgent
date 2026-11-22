import { z } from 'zod';
import type { LlmClient, ProductLook } from '@zenith/brain';
import { withTenant, type Pool } from '@zenith/db';
import { toModelImage } from './customer-images.js';

/**
 * Describe cómo se ve cada producto a partir de su foto del catálogo. La tienda casi no
 * describe sus piezas (muchas no dicen ni el color), así que sin esto el bot no puede
 * encontrar un producto por su aspecto ni compararlo con la foto que manda un cliente.
 * Las fotos del catálogo son públicas; no llevan datos de clientes.
 */

const LOOK_SYSTEM = [
  'Describes productos de una tienda de cerámicas, porcelanatos, sanitarios y lavamanos a partir de sus fotos de catálogo.',
  'Muchas fotos muestran un ambiente decorado: describe solo el producto (el piso, la pared revestida o la pieza sanitaria), nunca los muebles ni la decoración.',
  'Si hay una foto de la pieza sola, úsala para el diseño y el color; la del ambiente, para ver cómo queda instalada.',
  'Responde solo con un objeto JSON, sin texto antes ni después, con estas claves:',
  '- "aspecto": lista de 1 a 3 palabras en español sobre lo que imita o su estilo (ej. "madera", "mármol", "piedra", "cemento", "liso", "geométrico", "rústico", "una pieza").',
  '- "colores": lista de 1 a 3 colores en español, del más al menos presente (ej. "gris", "beige", "blanco", "negro", "terracota").',
  '- "patron": cómo se ve el diseño o la colocación si tiene uno (ej. "espiga", "chevron", "listones", "hexágonos", "vetas") o null.',
  '- "descripcion": una frase de hasta 25 palabras en español que describa el producto como lo haría un vendedor.',
  'No inventes medidas, marcas ni precios.',
].join('\n');

const lookSchema = z.object({
  aspecto: z.array(z.string().trim().min(1).max(40)).max(5),
  colores: z.array(z.string().trim().min(1).max(30)).max(5),
  patron: z.string().trim().max(60).nullable().optional(),
  descripcion: z.string().trim().min(5).max(300),
});

/** Saca el JSON de la respuesta del modelo (a veces lo envuelve en ```json). */
export function parseLook(text: string): ProductLook | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = lookSchema.safeParse(raw);
  if (!parsed.success) return null;
  const lower = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))].slice(0, 3);
  return {
    aspecto: lower(parsed.data.aspecto),
    colores: lower(parsed.data.colores),
    patron: parsed.data.patron ? parsed.data.patron.toLowerCase() : null,
    descripcion: parsed.data.descripcion,
  };
}

/** Pide al modelo la descripción de un producto a partir de hasta dos fotos. */
export async function describeLook(
  llm: LlmClient,
  model: string,
  product: { name: string; category: string | null },
  photos: Buffer[],
): Promise<ProductLook | null> {
  const images = (await Promise.all(photos.slice(0, 2).map(toModelImage))).filter((i) => i !== null);
  if (!images.length) return null;
  const response = await llm.create({
    model,
    max_tokens: 400,
    output_config: { effort: 'low' },
    system: LOOK_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          // El nombre ayuda (ej. "Cenizo" es un gris), pero lo que manda es la foto.
          { type: 'text', text: `Producto: ${product.name} (categoría: ${product.category ?? 'sin dato'}).` },
          ...images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 } })),
        ],
      },
    ],
  });
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('');
  return parseLook(text);
}

export interface DescribeCatalogResult {
  described: number;
  skipped: number;
  failed: { name: string; error: string }[];
}

/**
 * Describe los productos activos con foto que aún no tienen descripción visual, o cuya foto
 * cambió. Va de a uno y con una pausa entre llamadas, para no pasar el límite de la capa
 * gratuita del proveedor.
 */
export async function describeCatalog(opts: {
  pool: Pool;
  tenantId: string;
  llm: LlmClient;
  model: string;
  force?: boolean;
  limit?: number;
  delayMs?: number;
  onProgress?: (msg: string) => void;
}): Promise<DescribeCatalogResult> {
  const pending = await withTenant(opts.pool, opts.tenantId, async (client) => {
    const { rows } = await client.query<{ id: string; name: string; category: string | null; sha256: string }>(
      `SELECT p.id, p.name, coalesce(p.category_name, p.category) AS category, first.sha256
         FROM products p
         JOIN LATERAL (SELECT sha256 FROM product_images WHERE product_id = p.id ORDER BY position LIMIT 1) first ON true
        WHERE p.active AND ($1 OR p.look IS NULL OR p.look_image_sha256 IS DISTINCT FROM first.sha256)
        ORDER BY p.name`,
      [Boolean(opts.force)],
    );
    return rows;
  });
  const todo = opts.limit ? pending.slice(0, opts.limit) : pending;
  const result: DescribeCatalogResult = { described: 0, skipped: 0, failed: [] };

  for (const [i, product] of todo.entries()) {
    if (i > 0 && opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const photos = await withTenant(opts.pool, opts.tenantId, async (client) => {
      const { rows } = await client.query<{ data: Buffer }>(
        'SELECT data FROM product_images WHERE product_id = $1 ORDER BY position LIMIT 2',
        [product.id],
      );
      return rows.map((r) => r.data);
    });
    let look: ProductLook | null;
    try {
      look = await describeLook(opts.llm, opts.model, product, photos);
    } catch (err) {
      result.failed.push({ name: product.name, error: (err as Error).message.slice(0, 200) });
      opts.onProgress?.(`✗ ${product.name}: ${(err as Error).message.slice(0, 120)}`);
      continue;
    }
    if (!look) {
      result.skipped++;
      opts.onProgress?.(`- ${product.name}: el modelo no devolvió una descripción válida`);
      continue;
    }
    await withTenant(opts.pool, opts.tenantId, (client) =>
      client.query(
        `UPDATE products SET look = $2, look_image_sha256 = $3, look_model = $4, look_at = now() WHERE id = $1`,
        [product.id, JSON.stringify(look), product.sha256, opts.model],
      ),
    );
    result.described++;
    opts.onProgress?.(`✓ ${product.name}: ${look.aspecto.join(', ')} · ${look.colores.join(', ')}${look.patron ? ` · ${look.patron}` : ''}`);
  }
  return result;
}
