import type { CatalogPhoto, CatalogReader, ProductRow, ProductSearch } from '@zenith/brain';
import sharp from 'sharp';
import { withTenant, type Pool } from '@zenith/db';

const BASE_COLUMNS = `id, name, category, category_name, description, format, area_per_box_m2, pieces_per_box,
                 attributes, look, price, currency, in_visualizer`;
/** Columnas leídas directamente de products, incluida si tiene foto. */
const COLUMNS = `${BASE_COLUMNS},
                 EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id) AS has_photo`;

// Palabras que no describen el producto y solo meten ruido en la búsqueda.
const STOPWORDS = new Set([
  'para', 'con', 'que', 'tipo', 'algo', 'busco', 'una', 'uno', 'unos', 'unas', 'los', 'las', 'del', 'por', 'como', 'mas',
  'tienen', 'tiene', 'quiero', 'parecido', 'estilo', 'color', 'sea', 'muy', 'mi', 'casa',
]);

/** Minúsculas, sin tildes ni signos: lo mismo que hace unaccent(lower()) del lado de la BD. */
export function normalizeTerms(text: string | null): string[] {
  if (!text) return [];
  const words = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  // Plurales: "grises" → gris, "azules" → azul, "marrones" → marron (consonante + es);
  // "ceramicas" → ceramica, "verdes" → verde (solo la s).
  const singular = (w: string) => (w.length > 4 && /[^aeiou]es$/.test(w) ? w.slice(0, -2) : w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
  return [...new Set(words.map(singular))].slice(0, 8);
}

/** Nombres de color en italiano o inglés que usan los modelos del catálogo (Notte Nero, Monte Bianco…). */
const SYNONYMS: Record<string, string[]> = {
  negr: ['nero', 'black'],
  blanc: ['bianc', 'white', 'nieve'],
  gris: ['grigi', 'grey', 'gray', 'plomo', 'ceniz', 'grafit', 'perla'],
  marron: ['brown', 'cafe', 'avellana', 'chocolate', 'camel', 'nogal'],
  beige: ['crema', 'arena', 'marfil', 'hueso', 'sand'],
  azul: ['turquesa', 'celeste', 'aqua', 'blue'],
  verde: ['oliva', 'menta', 'green'],
  terracot: ['oxido', 'ladrillo', 'teja', 'rojiz'],
  dorad: ['gold', 'oro'],
};

/**
 * Los clientes dicen "cerámica" o "porcelanato" para cualquier revestimiento de piso o pared,
 * aunque el catálogo lo separe en Cerámicas, Ceranattos y Porcelanato: se buscan en todas.
 */
const TILE_CATEGORY = 'ceramic|ceranatt|porcelanat';
const TILE_WORDS = /^(ceramic|ceranatt|porcelanat|revestimient|baldos|piso|azulej)/;
export function categoryPattern(term: string | null): string | null {
  if (!term) return null;
  if (TILE_WORDS.test(term)) return TILE_CATEGORY;
  return term.length >= 5 && /[ao]$/.test(term) ? term.slice(0, -1) : term;
}

/**
 * Patrón (regex de Postgres) para una palabra ya normalizada: sin la vocal final de género
 * ("negra" y "negro" → negr) y con sus equivalentes. Las palabras ya son [a-z0-9], no hay que escapar.
 */
export function termPattern(term: string): string {
  const stem = term.length >= 5 && /[ao]$/.test(term) ? term.slice(0, -1) : term;
  const key = SYNONYMS[stem] ? stem : Object.keys(SYNONYMS).find((k) => stem.length >= 4 && (k.startsWith(stem) || stem.startsWith(k)));
  return [stem, ...(key ? SYNONYMS[key]! : [])].join('|');
}

/** Lado mayor de las fotos del catálogo que ve el modelo: alcanza para comparar y gasta pocos tokens. */
const PHOTO_SIDE = 384;
const PHOTO_CACHE_MAX = 300;
/** Fotos ya achicadas, por id de la imagen y su huella (si la foto cambia, cambia la clave). */
const photoCache = new Map<string, CatalogPhoto>();

async function shrink(data: Buffer): Promise<CatalogPhoto | null> {
  try {
    const out = await sharp(data).rotate().resize(PHOTO_SIDE, PHOTO_SIDE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
    return { mediaType: 'image/jpeg', base64: out.toString('base64') };
  } catch {
    return null;
  }
}

/**
 * Lector del catálogo para las herramientas del bot. Cada consulta corre en su propia
 * transacción con el tenant fijado, así que RLS impide leer productos de otro negocio.
 */
export function createCatalogReader(pool: Pool, tenantId: string): CatalogReader {
  return {
    async search(filters: ProductSearch): Promise<ProductRow[]> {
      const terms = normalizeTerms(filters.text);
      const category = categoryPattern(normalizeTerms(filters.category)[0] ?? null);
      return withTenant(pool, tenantId, async (client) => {
        // Puntaje por palabra: en el nombre pesa más; después el color principal de la foto, los
        // demás colores, el aspecto de la foto y, al final, la ficha (que a veces trae el color mal).
        const { rows } = await client.query<ProductRow & { score: number }>(
          `WITH candidates AS (
             SELECT ${COLUMNS},
                    unaccent(lower(name)) AS n,
                    unaccent(lower(coalesce(look->'colores'->>0, ''))) AS c1,
                    unaccent(lower(coalesce(look->>'colores', ''))) AS cs,
                    unaccent(lower(coalesce(look->>'aspecto', '') || ' ' || coalesce(look->>'patron', ''))) AS asp,
                    unaccent(lower(coalesce(look::text, ''))) AS lk,
                    unaccent(lower(coalesce(description, '') || ' ' || coalesce(category_name, '') || ' ' ||
                                   coalesce(format, '') || ' ' || attributes::text)) AS rest
               FROM products
              WHERE active
                AND ($1::text IS NULL OR unaccent(lower(coalesce(category, '') || ' ' || coalesce(category_name, ''))) ~ $1)
                -- La tienda tiene algunos sanitarios dentro de Porcelanato o Ceranattos: al buscar
                -- revestimientos se dejan fuera por el nombre.
                AND ($1::text IS DISTINCT FROM '${TILE_CATEGORY}' OR NOT unaccent(lower(name)) ~ '^(sanitario|sala |lavamanos|orinal|taza)')
                AND ($2::text IS NULL OR unaccent(lower(coalesce(attributes->>'surface', ''))) LIKE '%' || $2 || '%')
                AND ($3::text IS NULL OR unaccent(lower(coalesce(attributes->>'usage', ''))) LIKE '%' || $3 || '%'))
           SELECT ${BASE_COLUMNS}, has_photo,
                  -- Primero cuántas palabras del pedido cumple (10 por cada una): "madera clara" pone las
                  -- maderas claras por encima de los grises claros. Después, dónde coincide cada una.
                  (SELECT coalesce(sum(
                            CASE WHEN n ~ w OR lk ~ w OR rest ~ w THEN 10 ELSE 0 END +
                            CASE WHEN n ~ w THEN 4 ELSE 0 END + CASE WHEN c1 ~ w THEN 3 ELSE 0 END +
                            CASE WHEN asp ~ w THEN 3 ELSE 0 END + CASE WHEN cs ~ w THEN 2 ELSE 0 END +
                            CASE WHEN lk ~ w THEN 1 ELSE 0 END + CASE WHEN rest ~ w THEN 0.5 ELSE 0 END), 0)
                     FROM unnest($4::text[]) AS w)::float AS score
             FROM candidates
            WHERE cardinality($4::text[]) = 0
               OR EXISTS (SELECT 1 FROM unnest($4::text[]) AS w WHERE n ~ w OR lk ~ w OR rest ~ w)
            ORDER BY score DESC, has_photo DESC, name
            LIMIT $5`,
          [category, filters.surface, filters.usage, terms.map(termPattern), filters.limit],
        );
        return rows.map((row) => ({ ...row, score: Number(row.score) }));
      });
    },

    async photos(productIds: string[]): Promise<Map<string, CatalogPhoto>> {
      const out = new Map<string, CatalogPhoto>();
      if (!productIds.length) return out;
      const rows = await withTenant(pool, tenantId, async (client) =>
        (
          await client.query<{ product_id: string; id: string; sha256: string }>(
            `SELECT DISTINCT ON (product_id) product_id, id, sha256 FROM product_images
              WHERE product_id = ANY ($1::uuid[]) ORDER BY product_id, position`,
            [productIds],
          )
        ).rows,
      );
      const missing = rows.filter((r) => !photoCache.has(`${r.id}:${r.sha256}`));
      if (missing.length) {
        const data = await withTenant(pool, tenantId, async (client) =>
          (await client.query<{ id: string; data: Buffer }>('SELECT id, data FROM product_images WHERE id = ANY ($1::uuid[])', [missing.map((r) => r.id)])).rows,
        );
        for (const d of data) {
          const r = missing.find((m) => m.id === d.id)!;
          const photo = await shrink(d.data);
          if (!photo) continue;
          if (photoCache.size >= PHOTO_CACHE_MAX) photoCache.delete(photoCache.keys().next().value!);
          photoCache.set(`${r.id}:${r.sha256}`, photo);
        }
      }
      for (const r of rows) {
        const photo = photoCache.get(`${r.id}:${r.sha256}`);
        if (photo) out.set(r.product_id, photo);
      }
      return out;
    },

    async get(productId: string): Promise<ProductRow | null> {
      return withTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query<ProductRow>(`SELECT ${COLUMNS} FROM products WHERE id = $1 AND active`, [productId]);
        return rows[0] ?? null;
      });
    },
  };
}
