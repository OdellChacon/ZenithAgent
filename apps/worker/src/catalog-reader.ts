import type { CatalogReader, ProductRow, ProductSearch } from '@zenith/brain';
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
  // Se quita la "s" final para que "ceramicas" encuentre "ceramica" y viceversa.
  return [...new Set(words.map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)))].slice(0, 8);
}

/** Nombres de color en italiano o inglés que usan los modelos del catálogo (Notte Nero, Monte Bianco…). */
const SYNONYMS: Record<string, string[]> = {
  negr: ['nero', 'black'],
  blanc: ['bianc', 'white'],
  gris: ['grigi', 'grey', 'gray'],
  marron: ['brown'],
  dorad: ['gold', 'oro'],
};

/**
 * Patrón (regex de Postgres) para una palabra ya normalizada: sin la vocal final de género
 * ("negra" y "negro" → negr) y con sus equivalentes. Las palabras ya son [a-z0-9], no hay que escapar.
 */
export function termPattern(term: string): string {
  const stem = term.length >= 5 && /[ao]$/.test(term) ? term.slice(0, -1) : term;
  return [stem, ...(SYNONYMS[stem] ?? [])].join('|');
}

/**
 * Lector del catálogo para las herramientas del bot. Cada consulta corre en su propia
 * transacción con el tenant fijado, así que RLS impide leer productos de otro negocio.
 */
export function createCatalogReader(pool: Pool, tenantId: string): CatalogReader {
  return {
    async search(filters: ProductSearch): Promise<ProductRow[]> {
      const terms = normalizeTerms(filters.text);
      const category = normalizeTerms(filters.category)[0] ?? null;
      return withTenant(pool, tenantId, async (client) => {
        // Puntaje por palabra: en el nombre pesa más; después el color principal de la foto, los
        // demás colores, el aspecto de la foto y, al final, la ficha (que a veces trae el color mal).
        const { rows } = await client.query<ProductRow & { score: number }>(
          `WITH candidates AS (
             SELECT ${COLUMNS},
                    unaccent(lower(name)) AS n,
                    unaccent(lower(coalesce(look->'colores'->>0, ''))) AS c1,
                    unaccent(lower(coalesce(look->>'colores', ''))) AS cs,
                    unaccent(lower(coalesce(look::text, ''))) AS lk,
                    unaccent(lower(coalesce(description, '') || ' ' || coalesce(category_name, '') || ' ' ||
                                   coalesce(format, '') || ' ' || attributes::text)) AS rest
               FROM products
              WHERE active
                AND ($1::text IS NULL OR unaccent(lower(coalesce(category, '') || ' ' || coalesce(category_name, ''))) LIKE '%' || $1 || '%')
                AND ($2::text IS NULL OR unaccent(lower(coalesce(attributes->>'surface', ''))) LIKE '%' || $2 || '%')
                AND ($3::text IS NULL OR unaccent(lower(coalesce(attributes->>'usage', ''))) LIKE '%' || $3 || '%'))
           SELECT ${BASE_COLUMNS}, has_photo,
                  (SELECT coalesce(sum(
                            CASE WHEN n ~ w THEN 4 ELSE 0 END + CASE WHEN c1 ~ w THEN 3 ELSE 0 END +
                            CASE WHEN cs ~ w THEN 2 ELSE 0 END + CASE WHEN lk ~ w THEN 1 ELSE 0 END +
                            CASE WHEN rest ~ w THEN 0.5 ELSE 0 END), 0)
                     FROM unnest($4::text[]) AS w)::float AS score
             FROM candidates
            WHERE cardinality($4::text[]) = 0
               OR EXISTS (SELECT 1 FROM unnest($4::text[]) AS w WHERE n ~ w OR lk ~ w OR rest ~ w)
            ORDER BY score DESC, has_photo DESC, name
            LIMIT $5`,
          [category, filters.surface, filters.usage, terms.map(termPattern), filters.limit],
        );
        return rows.map(({ score: _score, ...row }) => row);
      });
    },

    async get(productId: string): Promise<ProductRow | null> {
      return withTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query<ProductRow>(`SELECT ${COLUMNS} FROM products WHERE id = $1 AND active`, [productId]);
        return rows[0] ?? null;
      });
    },
  };
}
