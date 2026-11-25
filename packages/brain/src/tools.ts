import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { calculateBoxes } from './boxes.js';

export const HANDOFF_REASONS = ['precio', 'pedido_grande', 'pago', 'queja', 'pide_humano', 'fuera_de_alcance', 'otro'] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** Acceso al catálogo que necesitan las herramientas. Lo implementa el worker con RLS. */
export interface CatalogReader {
  search(filters: ProductSearch): Promise<ProductRow[]>;
  get(productId: string): Promise<ProductRow | null>;
  /** Primera foto de cada producto, achicada para que el modelo la vea (si el lector lo permite). */
  photos?(productIds: string[]): Promise<Map<string, CatalogPhoto>>;
}

export interface CatalogPhoto {
  mediaType: 'image/jpeg' | 'image/png';
  base64: string;
}

/** Descripción visual de un producto hecha por el modelo de visión a partir de su foto. */
export interface ProductLook {
  aspecto: string[];
  colores: string[];
  patron: string | null;
  descripcion: string;
}

export interface ProductSearch {
  text: string | null;
  category: string | null;
  surface: 'piso' | 'pared' | null;
  usage: 'interior' | 'exterior' | null;
  limit: number;
}

export interface ProductRow {
  id: string;
  name: string;
  category: string | null;
  category_name: string | null;
  description: string | null;
  format: string | null;
  area_per_box_m2: string | null;
  pieces_per_box: number | null;
  attributes: Record<string, unknown>;
  /** Lo que se ve en la foto del producto (ver ProductLook), o null si aún no se describió. */
  look?: ProductLook | null;
  price: string | null;
  currency: string | null;
  in_visualizer: boolean;
  /** Si hay al menos una foto guardada del producto. */
  has_photo: boolean;
  /** Puntaje de la búsqueda (más alto = coincide mejor). Solo viene en los resultados de search. */
  score?: number;
}

/** Fotos por mensaje: más que esto satura el chat del cliente. */
export const MAX_PHOTOS_PER_TURN = 6;

export interface ToolContext {
  catalog: CatalogReader;
  wastePercent: number | null;
  /** El negocio cargó la foto de su fachada (se envía con la dirección). */
  hasStorefrontPhoto?: boolean;
  /**
   * Fotos del catálogo que el modelo ve junto a los resultados de la búsqueda, para comparar
   * imagen con imagen: `perSearch` por búsqueda y `remaining` en todo el turno (se va descontando).
   */
  catalogPhotos?: { perSearch: number; remaining: number };
  /**
   * Si el cliente mandó una foto: pregunta si alguno de los productos encontrados es exactamente
   * ese (con un modelo de visión). `remaining` limita las consultas por turno.
   */
  identifyPhoto?: { run: (candidates: { name: string; photo: CatalogPhoto }[]) => Promise<string | null>; remaining: number };
}

/** Lo que las herramientas piden al sistema además de responder (se aplica al guardar). */
export interface ToolEffects {
  handoff: { reason: HandoffReason; summary: string } | null;
  /** Productos cuya foto hay que enviar antes del texto, en orden. */
  photos: { productId: string; name: string }[];
  /** El cliente pidió que no le escriban más por iniciativa del negocio (seguimientos). */
  stopFollowups?: boolean;
  /** Enviar la foto de la fachada, con la dirección como pie, antes del texto. */
  storefront?: boolean;
  /**
   * Opciones que coinciden bien con lo último que pidió el cliente (cuando son más de 3). Si la
   * respuesta del bot no las nombra todas, el sistema agrega las que faltan.
   */
  listing?: { names: string[]; total: number };
  /** Productos que trajeron las búsquedas del turno, por nombre (para mandar fotos prometidas). */
  seen?: Map<string, { id: string; hasPhoto: boolean }>;
}

// --------------------------------------------------------------------- definiciones

export const TOOL_DEFINITIONS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'buscar_productos',
    description:
      'Busca productos activos en el catálogo del negocio. Úsala antes de recomendar o mencionar cualquier producto. ' +
      'Devuelve nombre, categoría, formato, m² por caja, superficie, acabado, uso, características y "como_se_ve" (cómo se ve en su foto). ' +
      'Los resultados vienen ordenados por cuántas palabras coinciden: los primeros son los más parecidos. ' +
      'Si no hay resultados, prueba con menos filtros o con otras palabras.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        texto: {
          type: ['string', 'null'],
          description:
            'De una a tres palabras clave: aspecto (madera, mármol, piedra, cemento), color, acabado o nombre del modelo. ' +
            'Ej. "madera", "mármol blanco", "antideslizante".',
        },
        categoria: {
          type: ['string', 'null'],
          description: 'Categoría del catálogo si el cliente la dejó clara (ej. "cerámicas", "sanitarios", "lavamanos").',
        },
        superficie: { type: ['string', 'null'], enum: ['piso', 'pared', null] },
        uso: { type: ['string', 'null'], enum: ['interior', 'exterior', null] },
        limite: { type: 'integer', description: 'Cantidad máxima de resultados (1 a 12). Usa 12 cuando el cliente pregunta qué hay de un color, estilo o tipo.' },
      },
      required: ['texto', 'categoria', 'superficie', 'uso', 'limite'],
      additionalProperties: false,
    },
  },
  {
    name: 'calcular_cajas',
    description:
      'Calcula cuántas cajas de un producto de cerámica o porcelanato necesita el cliente para cierta cantidad de m². ' +
      'Úsala siempre que haya que estimar cajas; no hagas la cuenta por tu cuenta.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        producto_id: { type: 'string', description: 'El id que devolvió buscar_productos.' },
        metros_cuadrados: { type: 'number', description: 'Área a cubrir en m².' },
      },
      required: ['producto_id', 'metros_cuadrados'],
      additionalProperties: false,
    },
  },
  {
    name: 'enviar_fotos',
    description:
      'Envía al cliente la foto de hasta 3 productos (una por producto), justo antes de tu mensaje. ' +
      'Úsala cuando el cliente pida fotos o cuando mostrar el producto ayude a decidir. Solo sirve con productos que ' +
      'devolvió buscar_productos y que tienen "tiene_foto": true. Tu mensaje puede decir que le enviaste las fotos.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        producto_ids: { type: 'array', items: { type: 'string' }, description: 'Ids de buscar_productos, máximo 6.' },
      },
      required: ['producto_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'enviar_ubicacion',
    description:
      'Envía al cliente la foto de la fachada de la tienda con la dirección como pie de foto, justo antes de tu mensaje. ' +
      'Úsala cuando pregunte dónde quedan, la dirección o cómo llegar.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'derivar_a_asesor',
    description:
      'Pasa la conversación a un asesor humano del negocio. Úsala cuando el cliente pide precio o cotización, quiere comprar, ' +
      'pregunta formas de pago, pide hablar con una persona, tiene una queja, hace un pedido grande o necesita algo que no puedes resolver. ' +
      'Después de usarla, despídete diciendo que un asesor le escribirá; tú ya no seguirás respondiendo.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', enum: [...HANDOFF_REASONS] },
        resumen: {
          type: 'string',
          description: 'Resumen para el asesor: qué busca el cliente, productos y cantidades de interés y qué falta resolver.',
        },
      },
      required: ['motivo', 'resumen'],
      additionalProperties: false,
    },
  },
  {
    name: 'no_escribir_mas',
    description:
      'Úsala solo si el cliente pide que no le escriban más, que no le manden mensajes o que lo saquen de la lista. ' +
      'El negocio dejará de escribirle por su cuenta; si el cliente vuelve a escribir, se le sigue atendiendo. ' +
      'Después, confírmale con amabilidad que no le escribirán más.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

// --------------------------------------------------------------------- validación

const searchInput = z.object({
  texto: z.string().trim().max(200).nullable(),
  categoria: z.string().trim().max(40).nullable(),
  superficie: z.enum(['piso', 'pared']).nullable(),
  uso: z.enum(['interior', 'exterior']).nullable(),
  limite: z.number().int(),
});

const boxesInput = z.object({
  producto_id: z.string().uuid(),
  metros_cuadrados: z.number().positive().max(100_000),
});

const photosInput = z.object({
  producto_ids: z.array(z.string().uuid()).min(1).max(10),
});

const handoffInput = z.object({
  motivo: z.enum(HANDOFF_REASONS),
  resumen: z.string().trim().min(1).max(1000),
});

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** Fotos de productos para que el modelo las vea después del resultado. */
  images?: { label: string; photo: CatalogPhoto }[];
}

/** Adjunta al resultado las fotos de los primeros productos con foto, dentro del límite del turno. */
async function withPhotos(outcome: ToolOutcome, rows: ProductRow[], ctx: ToolContext): Promise<ToolOutcome> {
  const budget = ctx.catalogPhotos;
  if (!budget || !ctx.catalog.photos || budget.remaining <= 0) return outcome;
  const pick = rows.filter((r) => r.has_photo).slice(0, Math.min(budget.perSearch, budget.remaining));
  if (!pick.length) return outcome;
  let photos: Map<string, CatalogPhoto>;
  try {
    photos = await ctx.catalog.photos(pick.map((r) => r.id));
  } catch {
    return outcome; // sin fotos el resultado sigue sirviendo
  }
  const images = pick.flatMap((r) => {
    const photo = photos.get(r.id);
    return photo ? [{ label: r.name, photo }] : [];
  });
  budget.remaining -= images.length;
  if (!images.length) return outcome;

  const identify = ctx.identifyPhoto;
  if (identify && identify.remaining > 0) {
    identify.remaining--;
    let same: string | null = null;
    try {
      same = await identify.run(images.map((i) => ({ name: i.label, photo: i.photo })));
    } catch {
      same = null; // sin la comparación el resultado sigue sirviendo
    }
    if (same) {
      const data = JSON.parse(outcome.content) as { productos?: { nombre: string; mismo_diseno_en_otros_colores?: string[] }[] };
      const variants = data.productos?.find((p) => p.nombre === same)?.mismo_diseno_en_otros_colores ?? [];
      const also = variants.length
        ? ` Como buen vendedor, ofrézcale también los otros colores del mismo modelo: ${variants.join(', ')}.`
        : ' Después siga asesorándolo (espacio, metros).';
      return {
        ...outcome,
        images,
        content: JSON.stringify({
          es_el_mismo_de_la_foto_del_cliente: same,
          nota_foto: `La foto del cliente es el ${same}: dígale primero que sí lo tiene y muéstrele ese.${also}`,
          ...data,
        }),
      };
    }
  }
  return { ...outcome, images };
}

const json = (value: unknown): ToolOutcome => ({ content: JSON.stringify(value), isError: false });
const error = (message: string): ToolOutcome => ({ content: JSON.stringify({ error: message }), isError: true });

/** Primeras palabras que no forman un diseño propio: "Marmol Oslo" y "Marmol Alba" son modelos distintos. */
const GENERIC_BASES = new Set(['marmol', 'mármol', 'sanitario', 'lavamanos', 'orinal', 'taza']);

/** "Archi Cenizo" → "Archi"; "Exterior Medellin Gris" → "Exterior Medellin". null si no hay base útil. */
export function designBase(name: string): string | null {
  const words = name.trim().split(/\s+/);
  if (words.length < 2) return null;
  const base = words.slice(0, -1).join(' ');
  if (base.length < 4 || GENERIC_BASES.has(base.toLocaleLowerCase('es'))) return null;
  return base;
}

/**
 * Otros colores del mismo diseño para los primeros resultados (ej. Archi Cenizo → Archi Terra),
 * para que el bot los ofrezca como "también viene en…" en vez de buscar parecidos.
 */
async function withVariants(rows: ProductRow[], ctx: ToolContext): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const bases = new Map<string, ProductRow[]>();
  for (const r of rows.slice(0, 3)) {
    const base = designBase(r.name);
    if (!base) continue;
    if (!bases.has(base)) {
      const found = await ctx.catalog.search({ text: base, category: null, surface: null, usage: null, limit: 8 });
      bases.set(base, found.filter((f) => f.name.toLocaleLowerCase('es').startsWith(`${base.toLocaleLowerCase('es')} `)));
    }
    const others = [...new Set(bases.get(base)!.filter((f) => f.name !== r.name).map((f) => f.name))];
    if (others.length) out.set(r.id, others);
  }
  return out;
}

const presentWith = (variants: Map<string, string[]>, best = 0) => (p: ProductRow) => {
  const v = variants.get(p.id);
  const out: Record<string, unknown> = { ...presentProduct(p) };
  if (best > 0 && p.score !== undefined) out.coincidencia = p.score >= best * 0.6 ? 'alta' : 'parcial';
  if (v) out.mismo_diseno_en_otros_colores = v;
  return out;
};

/**
 * Cuántos productos coinciden bien con lo pedido. Con más de 3, el resultado le recuerda al bot
 * que, si el cliente preguntó qué hay, se los nombre todos (el modelo tiende a quedarse con 2).
 */
function matchSummary(rows: ProductRow[], total?: number): { best: number; extra: Record<string, unknown> } {
  const best = Math.max(0, ...rows.map((r) => r.score ?? 0));
  if (!best) return { best: 0, extra: {} };
  const high = rows.filter((r) => (r.score ?? 0) >= best * 0.6).length;
  // Más de las que caben en un mensaje: un vendedor dice cuántas hay y ayuda a elegir por estilo.
  if (total !== undefined && total > rows.length) {
    return {
      best,
      extra: {
        coincidencias_altas: total,
        nota_opciones: `Hay ${total} productos que coinciden bien; aquí van los ${rows.length} más fieles. Son demasiados para nombrarlos todos: dígale al cliente cuántos hay, nómbrele los más representativos agrupados por estilo (por ejemplo mármol, cemento, madera, piedra) y pregúntele qué estilo o espacio busca para mostrarle el resto con otra búsqueda.`,
      },
    };
  }
  return {
    best,
    extra: {
      coincidencias_altas: high,
      ...(high > 3
        ? {
            nota_opciones: `Hay ${high} productos que coinciden bien (marcados "coincidencia": "alta", del más fiel al menos). Si el cliente preguntó qué hay o qué opciones tiene, nómbraselos todos en una línea corta cada uno; descarta solo los que en su foto o descripción claramente no son lo que pide.`,
          }
        : {}),
    },
  };
}

function presentProduct(p: ProductRow) {
  const a = p.attributes;
  return {
    id: p.id,
    nombre: p.name,
    categoria: p.category_name ?? p.category,
    formato: p.format,
    m2_por_caja: p.area_per_box_m2 !== null ? Number(p.area_per_box_m2) : null,
    piezas_por_caja: p.pieces_per_box,
    aspecto: a.design ?? p.look?.aspecto ?? null,
    // El color de la foto manda: la ficha del fabricante a veces trae otro (ej. "Negro" en un gris).
    color: p.look?.colores.length ? p.look.colores.join(', ') : (a.color ?? null),
    // Descrito por IA a partir de la foto del catálogo: sirve para comparar con lo que pide el cliente.
    como_se_ve: p.look ? [p.look.descripcion, p.look.patron ? `patrón: ${p.look.patron}` : ''].filter(Boolean).join(' · ') : null,
    coleccion: a.collection ?? null,
    trafico: a.traffic ?? null,
    superficie: a.surface ?? null,
    acabado: a.finish ?? null,
    uso: a.usage ?? null,
    caracteristicas: a.features ?? [],
    calidad: a.quality ?? null,
    marca: a.brand ?? null,
    descripcion: p.description ? p.description.slice(0, 300) : null,
    // Los precios no salen de aquí aunque existan: hoy los da un asesor.
    precio: 'lo confirma un asesor',
    en_visualizador: p.in_visualizer,
    tiene_foto: p.has_photo,
  };
}

/**
 * Ejecuta una herramienta pedida por el modelo. Nunca lanza por datos del modelo: un input
 * inválido vuelve como error para que el modelo lo corrija.
 */
export async function runTool(name: string, input: unknown, ctx: ToolContext, effects: ToolEffects): Promise<ToolOutcome> {
  switch (name) {
    case 'buscar_productos': {
      const parsed = searchInput.safeParse(input);
      if (!parsed.success) return error('Parámetros inválidos para buscar_productos');
      const { texto, categoria, superficie, uso, limite } = parsed.data;
      const filters = {
        text: texto || null,
        category: categoria || null,
        surface: superficie,
        usage: uso,
        limit: Math.min(Math.max(limite, 1), 12),
      };
      const rows = await ctx.catalog.search(filters);
      effects.seen ??= new Map();
      for (const r of rows) if (!effects.seen.has(r.name)) effects.seen.set(r.name, { id: r.id, hasPhoto: r.has_photo });
      if (rows.length) {
        const variants = await withVariants(rows, ctx);
        // Si se llenó el límite, se cuentan aparte cuántas coinciden bien en todo el catálogo.
        let total: number | undefined;
        if (filters.text && rows.length >= filters.limit) {
          const all = await ctx.catalog.search({ ...filters, limit: 200 });
          const top = Math.max(0, ...all.map((r) => r.score ?? 0));
          total = all.filter((r) => (r.score ?? 0) >= top * 0.6).length;
        }
        const summary = matchSummary(rows, total);
        const best = summary.best;
        const strong = best ? rows.filter((r) => (r.score ?? 0) >= best * 0.6).map((r) => r.name) : [];
        if (strong.length > 3) effects.listing = { names: [...new Set(strong)], total: total ?? strong.length };
        return withPhotos(
          json({ resultados: rows.length, ...summary.extra, productos: rows.map(presentWith(variants, summary.best)) }),
          rows,
          ctx,
        );
      }

      // La categoría que dice el cliente no siempre es la del catálogo ("porcelanato" puede estar
      // en otra categoría, o la categoría tener productos mal puestos): se busca lo mismo sin ella.
      if (filters.category) {
        const anyCategory = await ctx.catalog.search({ ...filters, category: null });
        if (anyCategory.length) {
          return withPhotos(json({
            resultados: anyCategory.length,
            nota: `En la categoría "${filters.category}" no hubo coincidencias; estos productos de otras categorías sí coinciden con lo que busca el cliente.`,
            productos: anyCategory.map(presentWith(await withVariants(anyCategory, ctx))),
          }), anyCategory, ctx);
        }
      }

      // Sin coincidencias exactas: se aflojan los filtros una vez, para que el modelo tenga
      // alternativas reales y no repita búsquedas (cada vuelta cuesta tiempo).
      const relaxed = filters.text
        ? { ...filters, text: null, category: null }
        : { ...filters, category: null, usage: null };
      const similar = await ctx.catalog.search(relaxed);
      return withPhotos(json({
        resultados: 0,
        nota:
          'No hubo coincidencias exactas. Abajo van los productos más parecidos del catálogo: ofréceselos al cliente. ' +
          'No digas que no hay stock (no conoces el inventario). Si nada de esto encaja, prueba una búsqueda con otras palabras o ofrece conseguirlo bajo pedido con un asesor.',
        sugerencias: similar.map(presentProduct),
      }), similar, ctx);
    }

    case 'calcular_cajas': {
      const parsed = boxesInput.safeParse(input);
      if (!parsed.success) return error('Indique un producto_id válido y metros_cuadrados mayores que 0');
      const product = await ctx.catalog.get(parsed.data.producto_id);
      if (!product) return error('Producto no encontrado o inactivo');
      const area = product.area_per_box_m2 !== null ? Number(product.area_per_box_m2) : null;
      if (!area) return error('Este producto no se vende por m²; no aplica el cálculo de cajas');
      const r = calculateBoxes(parsed.data.metros_cuadrados, area, product.pieces_per_box, ctx.wastePercent);
      return json({
        producto: product.name,
        metros_solicitados: parsed.data.metros_cuadrados,
        cajas: r.boxes,
        m2_que_cubren: r.coveredM2,
        piezas: r.pieces,
        desperdicio_aplicado:
          r.wastePercent === null ? 'no definido: el cálculo no incluye desperdicio y un asesor confirma la cantidad final' : `${r.wastePercent}%`,
      });
    }

    case 'enviar_fotos': {
      const parsed = photosInput.safeParse(input);
      if (!parsed.success) return error('Indique producto_ids con los ids que devolvió buscar_productos');
      const sent: string[] = [];
      const skipped: string[] = [];
      for (const id of [...new Set(parsed.data.producto_ids)]) {
        if (effects.photos.length >= MAX_PHOTOS_PER_TURN) {
          skipped.push(`${id}: máximo ${MAX_PHOTOS_PER_TURN} fotos por mensaje`);
          continue;
        }
        if (effects.photos.some((p) => p.productId === id)) continue;
        const product = await ctx.catalog.get(id);
        if (!product) skipped.push(`${id}: producto no encontrado`);
        else if (!product.has_photo) skipped.push(`${product.name}: no tiene foto`);
        else {
          effects.photos.push({ productId: product.id, name: product.name });
          sent.push(product.name);
        }
      }
      return json({ fotos_que_se_enviaran: sent, no_enviadas: skipped });
    }

    case 'enviar_ubicacion': {
      if (!ctx.hasStorefrontPhoto) {
        return json({
          foto_enviada: false,
          indicacion: 'No hay foto de la fachada cargada. Dale la dirección del showroom en tu mensaje.',
        });
      }
      effects.storefront = true;
      return json({
        foto_enviada: true,
        indicacion:
          'La foto de la fachada llega antes de tu mensaje con la dirección como pie. No repitas la dirección completa: ' +
          'menciona que le enviaste la foto para que la ubique fácil y, si viene al caso, el horario.',
      });
    }

    case 'derivar_a_asesor': {
      const parsed = handoffInput.safeParse(input);
      if (!parsed.success) return error('Indique motivo y resumen');
      effects.handoff = { reason: parsed.data.motivo, summary: parsed.data.resumen };
      return json({ ok: true, indicacion: 'Un asesor continuará la conversación. Despídase con amabilidad.' });
    }

    case 'no_escribir_mas': {
      effects.stopFollowups = true;
      return json({ ok: true, indicacion: 'No se le escribirá más por iniciativa del negocio. Confírmeselo en una frase.' });
    }

    default:
      return error(`Herramienta desconocida: ${name}`);
  }
}
