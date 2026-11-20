import { z } from 'zod';
import { parseTileFormat } from './format.js';
import type { ProductInput } from './sync.js';

/**
 * Catálogo de la tienda de Inversiones Mora Mora (la misma API que usa su web y el visualizador):
 *   GET {base}/api/v1/store/categories
 *   GET {base}/api/v1/store/products
 * Las imágenes vienen embebidas en base64 y no se copian: el bot no las necesita para responder.
 */
export const IMM_STORE_SOURCE = 'imm_store';

const text = z.string().nullish().transform((v) => (v ?? '').trim());

// La tienda manda 0 en las medidas de objeto que no aplican (cerámicas): 0 = sin dato.
const optionalDimension = z
  .number()
  .nonnegative()
  .nullish()
  .transform((v) => (v ? v : null));

const categorySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  in_visualizer: z.boolean().optional().default(false),
});

const productSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  name: z.string().min(1),
  cat: z.string().min(1),
  fmt: text,
  desc: text,
  surface: text,
  finish: text,
  usage: text,
  specs: text,
  price: z.number().nonnegative().nullish(),
  offer: z.boolean().nullish(),
  old: z.number().nonnegative().nullish(),
  obj_w_cm: optionalDimension,
  obj_h_cm: optionalDimension,
  obj_d_cm: optionalDimension,
});

const productsResponseSchema = z.object({ items: z.array(z.unknown()), total: z.number().optional() });

export type ImmCategory = z.infer<typeof categorySchema>;
export type ImmProduct = z.infer<typeof productSchema>;

export class CatalogSourceError extends Error {
  override name = 'CatalogSourceError';
}

/** "Acasta / Primera Calidad" → nombre "Acasta", calidad "Primera Calidad"; "… / Marca Corona" → marca "Corona". */
export function splitName(raw: string): { name: string; quality?: string; brand?: string } {
  const [head, ...rest] = raw.split('/');
  const name = (head ?? raw).trim();
  const suffix = rest.join('/').trim();
  if (!suffix) return { name };
  const brand = /^marca\s+(.+)$/i.exec(suffix)?.[1]?.trim();
  return brand ? { name, brand } : { name, quality: suffix };
}

const splitList = (s: string) =>
  s
    .split('/')
    .map((v) => v.trim())
    .filter(Boolean);

export function mapImmProduct(item: ImmProduct, categories: Map<string, ImmCategory>, currency: string): ProductInput {
  const { name, quality, brand } = splitName(item.name);
  const tile = parseTileFormat(item.fmt);
  const category = categories.get(item.cat);

  const attributes: Record<string, unknown> = {};
  if (item.surface) attributes.surface = item.surface;
  if (item.finish) attributes.finish = item.finish;
  if (item.usage) attributes.usage = item.usage;
  const features = splitList(item.specs);
  if (features.length) attributes.features = features;
  if (quality) attributes.quality = quality;
  if (brand) attributes.brand = brand;
  if (item.obj_w_cm || item.obj_h_cm || item.obj_d_cm) {
    attributes.dimensions_cm = { width: item.obj_w_cm ?? null, height: item.obj_h_cm ?? null, depth: item.obj_d_cm ?? null };
  }
  if (item.offer && item.old != null) attributes.previous_price = item.old;

  return {
    externalId: String(item.id),
    name,
    category: item.cat,
    categoryName: category?.name ?? null,
    description: item.desc || null,
    format: item.fmt || null,
    pieceWidthCm: tile?.pieceWidthCm ?? null,
    pieceLengthCm: tile?.pieceLengthCm ?? null,
    areaPerBoxM2: tile?.areaPerBoxM2 ?? null,
    piecesPerBox: tile?.piecesPerBox ?? null,
    attributes,
    // Hoy la tienda no publica precios: queda NULL y el bot deriva el precio a un asesor.
    price: item.price ?? null,
    currency: item.price != null ? currency : null,
    onOffer: Boolean(item.offer),
    inVisualizer: category?.in_visualizer ?? false,
  };
}

export interface FetchImmCatalogOptions {
  baseUrl: string;
  currency: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ImmCatalogResult {
  products: ProductInput[];
  /** Productos que no pasaron la validación (se informan, no se importan). */
  rejected: { index: number; reason: string }[];
}

async function getJson(doFetch: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await doFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new CatalogSourceError(`No se pudo conectar con ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new CatalogSourceError(`${url} respondió HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new CatalogSourceError(`${url} no devolvió JSON`);
  }
}

export async function fetchImmCatalog(opts: FetchImmCatalogOptions): Promise<ImmCatalogResult> {
  const base = new URL(opts.baseUrl);
  if (base.protocol !== 'https:' && base.hostname !== 'localhost') {
    throw new CatalogSourceError('La URL del catálogo debe usar https');
  }
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const [rawCategories, rawProducts] = await Promise.all([
    getJson(doFetch, new URL('/api/v1/store/categories', base).toString(), timeoutMs),
    getJson(doFetch, new URL('/api/v1/store/products', base).toString(), timeoutMs),
  ]);

  const categories = z.array(categorySchema).safeParse(rawCategories);
  if (!categories.success) throw new CatalogSourceError('Las categorías no tienen el formato esperado');
  const productsEnvelope = productsResponseSchema.safeParse(rawProducts);
  if (!productsEnvelope.success) throw new CatalogSourceError('Los productos no tienen el formato esperado');

  const categoryMap = new Map(categories.data.map((c) => [c.slug, c]));
  const products: ProductInput[] = [];
  const rejected: ImmCatalogResult['rejected'] = [];

  productsEnvelope.data.items.forEach((raw, index) => {
    const parsed = productSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ index, reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }
    products.push(mapImmProduct(parsed.data, categoryMap, opts.currency));
  });

  return { products, rejected };
}
