import { createHash } from 'node:crypto';

/** Nombres de colas compartidos entre gateway y workers. */
export const QUEUES = {
  inbound: 'inbound',
} as const;

export interface InboundJobData {
  webhookEventId: string;
}

/** Máximo de intentos de procesar un evento antes de marcarlo como fallido. */
export const INBOUND_MAX_ATTEMPTS = 5;

/**
 * Clave de idempotencia para envíos salientes: el mismo paso disparado por el mismo mensaje
 * en la misma conversación nunca se envía dos veces, aunque el worker se reintente.
 */
export function outboundIdempotencyKey(conversationId: string, triggerMessageId: string, step: string): string {
  return createHash('sha256').update(`${conversationId}\u0000${triggerMessageId}\u0000${step}`).digest('hex');
}
