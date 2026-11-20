import type { CatalogReader, ProductRow, ProductSearch } from '@zenith/brain';
import { withTenant, type Pool } from '@zenith/db';

const COLUMNS = `id, name, category, category_name, description, format, area_per_box_m2, pieces_per_box,
                 attributes, price, currency, in_visualizer`;

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
        const { rows } = await client.query<ProductRow & { score: number }>(
          `WITH candidates AS (
             SELECT ${COLUMNS},
                    unaccent(lower(name || ' ' || coalesce(description, '') || ' ' || coalesce(category_name, '') || ' ' ||
                                   coalesce(format, '') || ' ' || attributes::text)) AS doc
               FROM products
              WHERE active
                AND ($1::text IS NULL OR unaccent(lower(coalesce(category, '') || ' ' || coalesce(category_name, ''))) LIKE '%' || $1 || '%')
                AND ($2::text IS NULL OR unaccent(lower(coalesce(attributes->>'surface', ''))) LIKE '%' || $2 || '%')
                AND ($3::text IS NULL OR unaccent(lower(coalesce(attributes->>'usage', ''))) LIKE '%' || $3 || '%'))
           SELECT ${COLUMNS},
                  (SELECT count(*) FROM unnest($4::text[]) AS w WHERE doc LIKE '%' || w || '%')::int AS score
             FROM candidates
            WHERE cardinality($4::text[]) = 0
               OR EXISTS (SELECT 1 FROM unnest($4::text[]) AS w WHERE doc LIKE '%' || w || '%')
            ORDER BY score DESC, name
            LIMIT $5`,
          [category, filters.surface, filters.usage, terms, filters.limit],
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
