import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { calculateBoxes } from './boxes.js';

export const HANDOFF_REASONS = ['precio', 'pedido_grande', 'pago', 'queja', 'pide_humano', 'fuera_de_alcance', 'otro'] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** Acceso al catálogo que necesitan las herramientas. Lo implementa el worker con RLS. */
export interface CatalogReader {
  search(filters: ProductSearch): Promise<ProductRow[]>;
  get(productId: string): Promise<ProductRow | null>;
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
}

/** Fotos por mensaje: más que esto satura el chat del cliente. */
export const MAX_PHOTOS_PER_TURN = 3;

export interface ToolContext {
  catalog: CatalogReader;
  wastePercent: number | null;
}

/** Lo que las herramientas piden al sistema además de responder (se aplica al guardar). */
export interface ToolEffects {
  handoff: { reason: HandoffReason; summary: string } | null;
  /** Productos cuya foto hay que enviar antes del texto, en orden. */
  photos: { productId: string; name: string }[];
  /** El cliente pidió que no le escriban más por iniciativa del negocio (seguimientos). */
  stopFollowups?: boolean;
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
        limite: { type: 'integer', description: 'Cantidad máxima de resultados (1 a 8).' },
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
        producto_ids: { type: 'array', items: { type: 'string' }, description: 'Ids de buscar_productos, máximo 3.' },
      },
      required: ['producto_ids'],
      additionalProperties: false,
    },
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
}

const json = (value: unknown): ToolOutcome => ({ content: JSON.stringify(value), isError: false });
const error = (message: string): ToolOutcome => ({ content: JSON.stringify({ error: message }), isError: true });

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
    color: a.color ?? (p.look?.colores.length ? p.look.colores.join(', ') : null),
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
        limit: Math.min(Math.max(limite, 1), 8),
      };
      const rows = await ctx.catalog.search(filters);
      if (rows.length) return json({ resultados: rows.length, productos: rows.map(presentProduct) });

      // Sin coincidencias exactas: se aflojan los filtros una vez, para que el modelo tenga
      // alternativas reales y no repita búsquedas (cada vuelta cuesta tiempo).
      const relaxed = filters.text
        ? { ...filters, text: null }
        : { ...filters, category: null, usage: null };
      const similar = await ctx.catalog.search(relaxed);
      return json({
        resultados: 0,
        nota:
          'No hubo coincidencias exactas. Abajo van los productos más parecidos del catálogo: ofréceselos al cliente. ' +
          'No digas que no hay stock (no conoces el inventario) y no repitas la búsqueda; si nada encaja, ofrece conseguirlo bajo pedido con un asesor.',
        sugerencias: similar.map(presentProduct),
      });
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
