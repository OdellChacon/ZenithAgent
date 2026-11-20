import type { Channel } from './types.js';

/** Ventana estándar de Meta desde el último mensaje del usuario. */
export const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Etiqueta Human Agent de Instagram/Messenger: solo respuestas manuales de una persona. */
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * - FREE: se puede enviar texto libre.
 * - TEMPLATE_ONLY: solo plantilla aprobada (WhatsApp fuera de 24 h).
 * - HUMAN_AGENT_ONLY: solo una persona, con la etiqueta Human Agent (IG/Messenger, 24 h a 7 días).
 * - CLOSED: no se puede enviar nada.
 */
export type WindowDecision = 'FREE' | 'TEMPLATE_ONLY' | 'HUMAN_AGENT_ONLY' | 'CLOSED';

export interface WindowInput {
  channel: Channel;
  lastInboundAt: Date | null;
  now: Date;
  author: 'bot' | 'agent';
  /**
   * Margen antes del cierre en el que el bot deja de mandar texto libre, para no chocar
   * con el vencimiento mientras el mensaje está en cola. No aplica a personas.
   */
  botSafetyMarginMs?: number;
}

export function windowState(input: WindowInput): WindowDecision {
  const { channel, lastInboundAt, now, author } = input;

  if (lastInboundAt === null) {
    // El usuario nunca escribió: en WhatsApp solo se puede iniciar con plantilla.
    return channel === 'whatsapp' ? 'TEMPLATE_ONLY' : 'CLOSED';
  }

  // Un reloj desfasado no debe abrir la ventana más allá de lo real.
  const elapsed = Math.max(0, now.getTime() - lastInboundAt.getTime());
  const margin = author === 'bot' ? Math.max(0, input.botSafetyMarginMs ?? 0) : 0;

  if (elapsed < STANDARD_WINDOW_MS - margin) return 'FREE';

  switch (channel) {
    case 'whatsapp':
      return 'TEMPLATE_ONLY';
    case 'instagram':
    case 'messenger':
      return author === 'agent' && elapsed < HUMAN_AGENT_WINDOW_MS ? 'HUMAN_AGENT_ONLY' : 'CLOSED';
    case 'tiktok':
      // Reglas de TikTok por verificar: hasta confirmarlas, no se envía fuera de 24 h.
      return 'CLOSED';
  }
}

export function windowExpiresAt(lastInboundAt: Date): Date {
  return new Date(lastInboundAt.getTime() + STANDARD_WINDOW_MS);
}
