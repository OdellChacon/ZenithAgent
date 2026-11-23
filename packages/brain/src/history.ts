import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam } from './llm.js';

export interface HistoryMessage {
  /** Id del mensaje; sirve para emparejarlo con su foto descargada. */
  id?: string;
  direction: 'in' | 'out';
  author: 'customer' | 'bot' | 'agent' | 'system';
  type: string;
  body: string | null;
}

/** Foto del cliente lista para el modelo (JPEG en base64). */
export interface ModelImage {
  mediaType: 'image/jpeg' | 'image/png';
  base64: string;
}

const MEDIA_LABEL: Record<string, string> = {
  image:
    '[El cliente envió una foto hace rato, que ya no tienes a la vista. Si la necesitas, pídale con naturalidad que se la vuelva a mandar.]',
  audio: '[El cliente envió una nota de voz. Todavía no puedes escucharla: pídale con amabilidad que la escriba.]',
  video: '[El cliente envió un video que no puedes ver.]',
  document: '[El cliente envió un documento que no puedes abrir.]',
  sticker: '[El cliente envió un sticker.]',
};

const IMAGE_INTRO = '[El cliente envió esta foto:]';

type Block = Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam;

/**
 * Convierte el historial guardado en mensajes para el modelo. El texto del cliente va tal
 * cual (es dato, no instrucción); lo que escribió un asesor también cuenta como respuesta
 * del negocio. La conversación debe empezar por el cliente.
 *
 * `images` trae las fotos del cliente ya descargadas, por id de mensaje. Las que no están
 * (viejas o que no se pudieron bajar) quedan como una nota de texto.
 */
export function toModelMessages(
  history: HistoryMessage[],
  images?: ReadonlyMap<string, ModelImage>,
  opts: {
    /**
     * Nota interna que se agrega al final como turno del usuario. Sirve para pedirle algo al
     * modelo cuando el último mensaje es del negocio (por ejemplo, un seguimiento).
     */
    trailingNote?: string;
    /** Nota interna al principio de la conversación (hora de la tienda, nombre del cliente). */
    leadingNote?: string;
  } = {},
): BetaMessageParam[] {
  const turns: { role: 'user' | 'assistant'; blocks: Block[] }[] = [];
  for (const m of history) {
    if (m.author === 'system') continue;
    const role = m.direction === 'in' ? 'user' : 'assistant';
    const blocks: Block[] = [];
    if (m.direction === 'in' && m.type !== 'text') {
      const image = m.type === 'image' && m.id ? images?.get(m.id) : undefined;
      if (image) {
        blocks.push({ type: 'text', text: IMAGE_INTRO });
        blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } });
      } else {
        blocks.push({ type: 'text', text: MEDIA_LABEL[m.type] ?? '[Mensaje no compatible]' });
      }
    }
    if (m.body?.trim()) blocks.push({ type: 'text', text: m.body.trim() });
    if (!blocks.length) continue;

    const last = turns[turns.length - 1];
    if (last && last.role === role) last.blocks.push(...blocks); // mensajes seguidos del mismo lado se unen
    else turns.push({ role, blocks });
  }
  if (opts.trailingNote) {
    const note: Block = { type: 'text', text: opts.trailingNote };
    const last = turns[turns.length - 1];
    if (last && last.role === 'user') last.blocks.push(note);
    else turns.push({ role: 'user', blocks: [note] });
  }
  while (turns.length && turns[0]!.role !== 'user') turns.shift();
  if (opts.leadingNote && turns.length) turns[0]!.blocks.unshift({ type: 'text', text: opts.leadingNote });
  // El bot responde al cliente: el historial siempre termina en un mensaje suyo.
  while (turns.length && turns[turns.length - 1]!.role !== 'user') turns.pop();

  return turns.map(({ role, blocks }) => {
    if (blocks.every((b) => b.type === 'text')) {
      return { role, content: blocks.map((b) => (b as Anthropic.Beta.BetaTextBlockParam).text).join('\n\n') };
    }
    return { role, content: blocks };
  });
}

/**
 * Fotos del cliente que el modelo debe ver en este turno: las que mandó después de la última
 * respuesta del negocio y, además, la última foto anterior si es reciente (el cliente suele
 * volver sobre ella: "¿y algo como la pared del fondo?"). Como máximo `max`.
 */
export function pendingCustomerImages(history: HistoryMessage[], max = 3, lookback = 12): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  let i = history.length - 1;
  for (; i >= 0; i--) {
    const m = history[i]!;
    if (m.direction === 'out' && m.author !== 'system') break;
    if (m.direction === 'in' && m.type === 'image' && m.id) out.unshift(m);
  }
  if (out.length < max) {
    for (let j = i; j >= Math.max(0, history.length - lookback); j--) {
      const m = history[j]!;
      if (m.direction === 'in' && m.type === 'image' && m.id) {
        out.unshift(m);
        break;
      }
    }
  }
  return out.slice(-max);
}
