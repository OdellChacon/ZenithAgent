import type { BetaMessageParam } from './llm.js';

export interface HistoryMessage {
  direction: 'in' | 'out';
  author: 'customer' | 'bot' | 'agent' | 'system';
  type: string;
  body: string | null;
}

const MEDIA_LABEL: Record<string, string> = {
  image: '[El cliente envió una imagen. Todavía no puedes verla: pídale que describa el producto o que indique su nombre.]',
  audio: '[El cliente envió una nota de voz. Todavía no puedes escucharla: pídale con amabilidad que la escriba.]',
  video: '[El cliente envió un video que no puedes ver.]',
  document: '[El cliente envió un documento que no puedes abrir.]',
  sticker: '[El cliente envió un sticker.]',
};

/**
 * Convierte el historial guardado en mensajes para el modelo. El texto del cliente va tal
 * cual (es dato, no instrucción); lo que escribió un asesor también cuenta como respuesta
 * del negocio. La conversación debe empezar por el cliente.
 */
export function toModelMessages(history: HistoryMessage[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of history) {
    if (m.author === 'system') continue;
    const role = m.direction === 'in' ? 'user' : 'assistant';
    const parts: string[] = [];
    if (m.direction === 'in' && m.type !== 'text') parts.push(MEDIA_LABEL[m.type] ?? '[Mensaje no compatible]');
    if (m.body?.trim()) parts.push(m.body.trim());
    if (!parts.length) continue;
    const text = parts.join('\n');

    const last = out[out.length - 1];
    if (last && last.role === role && typeof last.content === 'string') {
      last.content = `${last.content}\n\n${text}`; // mensajes seguidos del mismo lado se unen
    } else {
      out.push({ role, content: text });
    }
  }
  while (out.length && out[0]!.role !== 'user') out.shift();
  // El bot responde al cliente: el historial siempre termina en un mensaje suyo.
  while (out.length && out[out.length - 1]!.role !== 'user') out.pop();
  return out;
}
