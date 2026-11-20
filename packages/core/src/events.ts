/**
 * Eventos que ven los asesores en el panel en vivo. El worker y la API los publican en Redis
 * (pub/sub) por tenant; la API los reenvía al navegador por Server-Sent Events.
 * Solo llevan ids y datos mínimos: el panel pide el detalle a la API, que aplica permisos.
 */
export type PanelEvent =
  | { type: 'handoff.requested'; conversationId: string; reason: string }
  | { type: 'message.new'; conversationId: string; direction: 'in' | 'out'; author: 'customer' | 'bot' | 'agent' | 'system' }
  | { type: 'conversation.updated'; conversationId: string };

export function tenantEventsChannel(tenantId: string): string {
  return `zenith:tenant:${tenantId}:events`;
}

export interface NotifyJobData {
  tenantId: string;
  conversationId: string;
  handoffId: string;
}
