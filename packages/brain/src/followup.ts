import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam, LlmClient } from './llm.js';
import { checkReply } from './validate.js';

/** Lo que responde el modelo cuando no corresponde escribirle al cliente. */
export const FOLLOWUP_SKIP = 'NO_SEGUIR';

/**
 * Instrucción para el seguimiento. Va como nota final del historial (no en el prompt de
 * sistema) para que el prompt del negocio siga en caché.
 */
export function followupNote(minutesSilent: number): string {
  const hours = Math.max(1, Math.round(minutesSilent / 60));
  return [
    `[Nota interna del sistema, no es un mensaje del cliente: el cliente no responde desde hace unas ${hours} horas.`,
    'Decide si corresponde escribirle para retomar la conversación.',
    `Responde exactamente ${FOLLOWUP_SKIP} si el cliente se despidió o cerró con un "gracias", dijo que ya compró, que no le interesa o que lo piensa con calma y no quiere que le escriban, pidió que no le escriban, la conversación fue solo un saludo sin una consulta concreta, o lo último fue que un asesor lo atendería.`,
    'Si corresponde, escribe UN solo mensaje corto (1 o 2 frases), como lo haría un vendedor atento de la tienda: retoma lo último que hablaron (el producto o el proyecto) y termina con una pregunta fácil de responder o una ayuda concreta.',
    'No vuelvas a saludar como al inicio, no digas que es un "seguimiento" ni que el cliente no ha respondido, no presiones, no inventes promociones, precios, existencias ni urgencias, y no uses herramientas.]',
  ].join(' ');
}

export type FollowupDraft =
  | { decision: 'send'; text: string }
  | { decision: 'skip' }
  | { decision: 'blocked'; reason: string };

export interface FollowupResult {
  draft: FollowupDraft;
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

/**
 * Pide al modelo el mensaje de seguimiento, sin herramientas. Pasa por el mismo validador que
 * las respuestas normales: nada de precios ni mensajes desmedidos.
 */
export async function writeFollowup(params: {
  llm: LlmClient;
  system: string;
  messages: BetaMessageParam[];
  model: string;
  effort: 'low' | 'medium' | 'high';
}): Promise<FollowupResult> {
  const response = await params.llm.create({
    model: params.model,
    max_tokens: 2000,
    output_config: { effort: params.effort },
    cache_control: { type: 'ephemeral' },
    system: params.system,
    messages: params.messages,
  });
  const usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
  };
  const base = { model: response.model, usage };
  if (response.stop_reason === 'refusal') return { ...base, draft: { decision: 'blocked', reason: 'refusal' } };
  if (response.stop_reason === 'max_tokens') return { ...base, draft: { decision: 'blocked', reason: 'max_tokens' } };

  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (text.toUpperCase().includes(FOLLOWUP_SKIP)) return { ...base, draft: { decision: 'skip' } };

  const check = checkReply(text);
  if (!check.ok) return { ...base, draft: { decision: 'blocked', reason: check.reason } };
  return { ...base, draft: { decision: 'send', text: check.text } };
}

/** Rellena {{1}}, {{2}}… de una plantilla con sus parámetros. */
export function renderTemplate(preview: string, params: readonly string[]): string {
  return preview.replace(/\{\{(\d+)\}\}/g, (whole, n: string) => params[Number(n) - 1] ?? whole);
}

/**
 * Valor de un parámetro de plantilla: {nombre} es el primer nombre del cliente y {negocio}
 * el nombre del negocio. Meta no acepta parámetros vacíos ni con saltos de línea.
 */
export function templateParam(raw: string, ctx: { contactName: string | null; businessName: string; nameFallback: string }): string {
  const first = ctx.contactName?.trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{M}'-]/gu, '') ?? '';
  const name = first ? first.charAt(0).toLocaleUpperCase('es') + first.slice(1) : ctx.nameFallback;
  const value = raw.replaceAll('{nombre}', name).replaceAll('{negocio}', ctx.businessName);
  return value.replace(/\s+/g, ' ').trim().slice(0, 60) || ctx.nameFallback;
}
