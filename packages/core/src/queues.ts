import { createHash } from 'node:crypto';

/** Nombres de colas compartidos entre gateway y workers. */
export const QUEUES = {
  inbound: 'inbound',
  brain: 'brain',
  outbound: 'outbound',
} as const;

export interface InboundJobData {
  webhookEventId: string;
}

export interface BrainJobData {
  tenantId: string;
  conversationId: string;
  /** Mensaje del cliente que disparó el turno. Si llega otro después, este turno se descarta. */
  triggerMessageId: string;
}

export interface OutboundJobData {
  tenantId: string;
  outboundMessageId: string;
}

/**
 * Espera antes de responder: agrupa los mensajes seguidos del cliente ("hola" + "¿tienen…?")
 * en un solo turno del bot.
 */
export const BRAIN_DEBOUNCE_MS = 3000;

/** Máximo de intentos de procesar un evento antes de marcarlo como fallido. */
export const INBOUND_MAX_ATTEMPTS = 5;

/**
 * Clave de idempotencia para envíos salientes: el mismo paso disparado por el mismo mensaje
 * en la misma conversación nunca se envía dos veces, aunque el worker se reintente.
 */
export function outboundIdempotencyKey(conversationId: string, triggerMessageId: string, step: string): string {
  return createHash('sha256').update(`${conversationId}\u0000${triggerMessageId}\u0000${step}`).digest('hex');
}
