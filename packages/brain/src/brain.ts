import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam, LlmClient } from './llm.js';
import { TOOL_DEFINITIONS, runTool, type HandoffReason, type ToolContext, type ToolEffects } from './tools.js';
import { checkReply, promisesHandoff } from './validate.js';

/** Etiqueta de cada foto del catálogo que se le muestra al modelo tras una búsqueda. */
export const CATALOG_PHOTO_PREFIX = '[Foto del catálogo, solo para que la mires (el cliente no la ha visto): ';

export interface BrainConfig {
  model: string;
  effort: 'low' | 'medium' | 'high';
  maxIterations: number;
  maxTokens: number;
}

export const DEFAULT_BRAIN_CONFIG: BrainConfig = {
  model: 'claude-opus-5-5',
  effort: 'medium',
  // Buscar, calcular y responder caben en 3 vueltas; más suele ser el modelo dando vueltas.
  maxIterations: 4,
  maxTokens: 16_000,
};

export type BrainOutcome = 'replied' | 'handoff' | 'blocked_by_validator' | 'refusal' | 'error';

export interface BrainResult {
  outcome: BrainOutcome;
  /** Texto a enviar al cliente (siempre hay uno, aunque sea el mensaje de respaldo). */
  reply: string;
  handoff: { reason: HandoffReason | 'seguridad' | 'error'; summary: string } | null;
  /** Fotos a enviar antes del texto, en orden. */
  photos: { productId: string; name: string }[];
  /** El cliente pidió que no le escriban más: se desactivan sus seguimientos. */
  stopFollowups?: boolean;
  /** Enviar la foto de la fachada (con la dirección) antes del texto. */
  storefront?: boolean;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  iterations: number;
  stopReason: string | null;
  model: string;
  error?: string;
}

export const FALLBACK_REPLY =
  'Gracias por escribirnos. Un asesor de nuestro equipo continuará la atención en breve para ayudarle con su consulta.';

/**
 * Un turno del bot: el modelo conversa con las herramientas del catálogo hasta tener una
 * respuesta final. Si algo sale mal (límite de iteraciones, rechazo, respuesta con precios),
 * no se improvisa: se responde con el mensaje de respaldo y se deriva a un asesor.
 */
export async function runBrainTurn(params: {
  llm: LlmClient;
  system: string;
  messages: BetaMessageParam[];
  tools: ToolContext;
  config?: Partial<BrainConfig>;
}): Promise<BrainResult> {
  const config = { ...DEFAULT_BRAIN_CONFIG, ...params.config };
  const messages = [...params.messages];
  const effects: ToolEffects = { handoff: null, photos: [] };
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let iterations = 0;
  let stopReason: string | null = null;
  let model = config.model;

  const fail = (outcome: BrainOutcome, summary: string, error?: string): BrainResult => ({
    outcome,
    reply: FALLBACK_REPLY,
    handoff: effects.handoff ?? { reason: outcome === 'refusal' ? 'seguridad' : 'error', summary },
    photos: [],
    ...(effects.stopFollowups ? { stopFollowups: true } : {}),
    usage,
    iterations,
    stopReason,
    model,
    ...(error ? { error } : {}),
  });

  if (!messages.length) return fail('error', 'Conversación sin mensajes del cliente');

  // Una vuelta extra si el modelo termina sin escribirle nada al cliente.
  let nudged = false;
  while (iterations < config.maxIterations + (nudged ? 1 : 0)) {
    iterations++;
    const response = await params.llm.create({
      model: config.model,
      max_tokens: config.maxTokens,
      // Claude Opus 5.5 piensa de forma adaptativa por defecto; el esfuerzo controla cuánto.
      output_config: { effort: config.effort },
      // Si el modelo rechaza por un filtro de seguridad, la API reintenta con el modelo de respaldo.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // El prompt de sistema y las herramientas son estables por tenant: se cachean.
      cache_control: { type: 'ephemeral' },
      system: params.system,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    model = response.model;
    stopReason = response.stop_reason;
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;

    if (response.stop_reason === 'refusal') {
      return fail('refusal', 'El modelo rechazó responder esta conversación');
    }

    // Se devuelve el contenido completo (incluidos los bloques de pensamiento) sin tocarlo.
    messages.push({ role: 'assistant', content: response.content as Anthropic.Beta.BetaContentBlockParam[] });

    if (response.stop_reason === 'pause_turn') continue;

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');

    if (response.stop_reason === 'tool_use' && toolUses.length) {
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      // Fotos del catálogo que trajeron las búsquedas: van después de los resultados, en el mismo turno.
      const photoBlocks: (Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam)[] = [];
      for (const call of toolUses) {
        let outcome;
        try {
          outcome = await runTool(call.name, call.input, params.tools, effects);
        } catch {
          // Un fallo de BD en una herramienta no tumba el turno: el modelo recibe el error y deriva.
          outcome = { content: JSON.stringify({ error: 'Error interno de la herramienta' }), isError: true };
        }
        results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, is_error: outcome.isError });
        for (const img of 'images' in outcome ? (outcome.images ?? []) : []) {
          photoBlocks.push({ type: 'text', text: `${CATALOG_PHOTO_PREFIX}${img.label}]` });
          photoBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.photo.mediaType, data: img.photo.base64 } });
        }
      }
      // Todos los resultados van juntos en un único mensaje.
      messages.push({ role: 'user', content: [...results, ...photoBlocks] });
      continue;
    }

    if (response.stop_reason === 'max_tokens') return fail('error', 'La respuesta superó el límite de tokens');

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (!text && !nudged) {
      // A veces el modelo cierra sin texto después de buscar y mandar fotos: se le pide la respuesta.
      nudged = true;
      messages.pop();
      const note = { type: 'text' as const, text: '[Nota interna: escribe ahora tu respuesta al cliente con lo que encontraste.]' };
      const last = messages.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content)) (last.content as unknown[]).push(note);
      else messages.push({ role: 'user', content: [note] });
      continue;
    }

    const check = checkReply(text);
    if (!check.ok) {
      return {
        ...fail('blocked_by_validator', `Respuesta bloqueada por el validador (${check.reason})`),
        error: check.reason,
      };
    }
    // Prometió un asesor sin derivar: se cumple la promesa para que el cliente no quede esperando.
    if (!effects.handoff && promisesHandoff(check.text)) {
      effects.handoff = {
        reason: 'otro',
        summary: 'El bot le dijo al cliente que un asesor lo atendería, pero no dejó resumen. Revise la conversación.',
      };
    }

    sendPromisedPhotos(check.text, effects);
    return {
      outcome: effects.handoff ? 'handoff' : 'replied',
      reply: completeListing(check.text, effects),
      handoff: effects.handoff,
      photos: effects.photos,
      ...(effects.stopFollowups ? { stopFollowups: true } : {}),
      ...(effects.storefront ? { storefront: true } : {}),
      usage,
      iterations,
      stopReason,
      model,
    };
  }

  return fail('error', 'Se alcanzó el máximo de iteraciones con herramientas');
}

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Si la búsqueda encontró varias opciones que coinciden bien y la respuesta no las nombra todas,
 * agrega las que faltan antes de la pregunta final: el cliente no tiene por qué saber qué
 * modelos preguntar. Con más opciones de las que caben, dice cuántas hay en total.
 */
export function completeListing(reply: string, effects: ToolEffects): string {
  const listing = effects.listing;
  if (!listing || effects.handoff) return reply;
  const said = plain(reply);
  const shown = new Set(effects.photos.map((p) => p.name));
  const missing = listing.names.filter((n) => !shown.has(n) && !said.includes(plain(n)));
  if (!missing.length) return reply;
  const names = missing.map((n) => `*${n}*`);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
  const more =
    listing.total > listing.names.length
      ? ` En total son unos ${listing.total} modelos; si me dice el estilo que busca (mármol, cemento, madera, piedra…), le muestro el resto.`
      : '';
  const extra = `También tenemos ${list}. Si quiere, le mando las fotos.${more}`;
  const parts = reply.split(/\n\s*\n/);
  // Antes del último párrafo con pregunta, para que la conversación siga terminando en ella.
  let q = -1;
  parts.forEach((p, i) => {
    if (p.includes('?')) q = i;
  });
  if (q > 0) return [...parts.slice(0, q), extra, ...parts.slice(q)].join('\n\n');
  return `${reply}\n\n${extra}`;
}

/** "le envié", "le mando", "le acabo de enviar", "en la primera foto"… */
const CLAIMS_PHOTOS = /\b(?:le|les)\s+(?:acabo\s+de\s+)?(?:envi|mand|adjunt|compart)\p{L}*|\b(?:primera|segunda|tercera)\s+foto|\ben\s+las\s+fotos\b/iu;

/**
 * Si el bot dice que mandó fotos sin usar enviar_fotos, se mandan las de los productos que nombró
 * (de los que trajo la búsqueda, con foto, en el orden en que los nombró, máximo 3): lo que el
 * cliente lee tiene que ser cierto.
 */
export function sendPromisedPhotos(reply: string, effects: ToolEffects): void {
  if (effects.photos.length || !effects.seen?.size) return;
  // Las ofertas ("¿Quiere que le mande las fotos?") no cuentan: solo afirmaciones.
  const statements = reply.split(/(?<=[.!?…])\s+|\n+/).filter((x) => !/^¿|\?\s*$/.test(x.trim()));
  if (!statements.some((x) => CLAIMS_PHOTOS.test(plain(x)))) return;
  const said = plain(reply);
  const named = [...effects.seen.entries()]
    .filter(([name, p]) => p.hasPhoto && said.includes(plain(name)))
    .sort(([a], [b]) => said.indexOf(plain(a)) - said.indexOf(plain(b)))
    .slice(0, 3);
  for (const [name, p] of named) effects.photos.push({ productId: p.id, name });
}
