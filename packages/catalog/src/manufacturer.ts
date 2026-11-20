import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ProductInput } from './sync.js';

/**
 * Enriquecimiento con el catálogo del fabricante (Cerámica Italia), el mismo que importa
 * ZenithVisualizer en data/catalog/ceramica_italia/catalog.json.
 *
 * La tienda de Mora Mora casi no describe sus productos (no dice si una cerámica es tipo
 * madera o mármol), pero el fabricante sí. Se cruzan por nombre del modelo y medidas, y solo
 * se agregan atributos descriptivos. Los precios del fabricante NO se copian: son de otro
 * mercado y moneda.
 */
const manufacturerProductSchema = z.object({
  ref: z.string(),
  nombre: z.string(),
  diseno: z.array(z.string()).nullish(),
  color: z.string().nullish(),
  coleccion: z.string().nullish(),
  trafico: z.string().nullish(),
  pei: z.union([z.string(), z.number()]).nullish(),
  ancho_cm: z.number().nullish(),
  largo_cm: z.number().nullish(),
});
export type ManufacturerProduct = z.infer<typeof manufacturerProductSchema>;

export async function loadCeramicaItaliaCatalog(path: string): Promise<ManufacturerProduct[]> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as { productos?: unknown[] };
  if (!Array.isArray(raw.productos)) throw new Error('El catálogo del fabricante no tiene la lista "productos"');
  return raw.productos.flatMap((p) => {
    const parsed = manufacturerProductSchema.safeParse(p);
    return parsed.success ? [parsed.data] : [];
  });
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// El fabricante escribe el mismo diseño de varias formas ("Marmolizado", "Marmolizados", "Marmol"…).
const DESIGN_CANON: [RegExp, string][] = [
  [/madera/, 'Madera'],
  [/marmol/, 'Mármol'],
  [/natural|piedra/, 'Piedra natural'],
  [/cemento/, 'Cemento'],
  [/hidraulico/, 'Hidráulico'],
  [/oxido/, 'Óxido'],
  [/plano|liso/, 'Liso'],
  [/decorado|acento/, 'Decorado'],
  [/fachaleta/, 'Fachaleta'],
  [/exterior/, 'Exterior'],
];

export function canonicalDesign(values: string[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const n = norm(v);
    const hit = DESIGN_CANON.find(([re]) => re.test(n));
    out.add(hit ? hit[1] : v.trim());
  }
  return [...out];
}

// Palabras del nombre que no identifican al modelo.
const STOP = new Set(['dual', 'mix', 'primera', 'calidad', 'ceranatto', 'ceramica', 'piso', 'pared', 'exterior', 'cyr']);
const words = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

const TILE_CATEGORIES = new Set(['ceramicas', 'ceranattos', 'porcelanato']);

/** Busca el producto del fabricante que corresponde; null si no hay uno o hay varios distintos. */
export function matchManufacturer(product: ProductInput, catalog: ManufacturerProduct[]): ManufacturerProduct | null {
  if (!product.category || !TILE_CATEGORIES.has(product.category)) return null;
  const own = words(product.name);
  if (!own.length) return null;
  const has = (c: ManufacturerProduct, w: string) => words(c.nombre).includes(w);
  // 1) Productos cuyo nombre trae todas las palabras ("Itria Beige" → Itria y Beige).
  let candidates = catalog.filter((c) => own.every((w) => has(c, w)));
  // 2) Si no hay, la palabra más distintiva: la que aparece en menos productos del fabricante.
  if (!candidates.length) {
    const byWord = own.map((w) => catalog.filter((c) => has(c, w))).filter((list) => list.length);
    candidates = byWord.sort((a, b) => a.length - b.length)[0] ?? [];
  }
  if (candidates.length > 1 && product.pieceWidthCm && product.pieceLengthCm) {
    const bySize = candidates.filter(
      (c) =>
        c.ancho_cm != null && c.largo_cm != null &&
        Math.abs(c.ancho_cm - product.pieceWidthCm!) < 0.6 && Math.abs(c.largo_cm - product.pieceLengthCm!) < 0.6,
    );
    if (bySize.length) candidates = bySize;
  }
  if (!candidates.length) return null;
  // Varios candidatos sirven solo si describen lo mismo.
  const signature = (c: ManufacturerProduct) => JSON.stringify([canonicalDesign(c.diseno ?? []), c.color ?? null]);
  return new Set(candidates.map(signature)).size === 1 ? candidates[0]! : null;
}

export interface EnrichResult {
  products: ProductInput[];
  matched: number;
  unmatched: string[];
}

export function enrichWithManufacturer(products: ProductInput[], catalog: ManufacturerProduct[]): EnrichResult {
  let matched = 0;
  const unmatched: string[] = [];
  const out = products.map((p) => {
    if (!p.category || !TILE_CATEGORIES.has(p.category)) return p;
    const m = matchManufacturer(p, catalog);
    if (!m) {
      unmatched.push(p.name);
      return p;
    }
    matched++;
    const extra: Record<string, unknown> = { manufacturer_ref: m.ref };
    const design = canonicalDesign(m.diseno ?? []);
    if (design.length) extra.design = design;
    if (m.color) extra.color = m.color;
    if (m.coleccion) extra.collection = m.coleccion;
    if (m.trafico) extra.traffic = m.trafico;
    if (m.pei != null && String(m.pei).trim()) extra.pei = String(m.pei);
    // Lo que trae la tienda manda: el fabricante solo completa.
    return { ...p, attributes: { ...extra, ...p.attributes } };
  });
  return { products: out, matched, unmatched };
}
