export const CHANNELS = ['whatsapp', 'instagram', 'messenger', 'tiktok'] as const;
export type Channel = (typeof CHANNELS)[number];

export type EventKind = 'message' | 'status' | 'unsupported';

export type MediaType = 'image' | 'audio' | 'video' | 'document' | 'sticker';

export interface MediaRef {
  type: MediaType;
  externalMediaId: string;
  mimeType?: string;
  caption?: string;
}

export type DeliveryState = 'sent' | 'delivered' | 'read' | 'failed';

/**
 * Evento entrante ya traducido desde el formato de una plataforma.
 * Todavía no conoce el tenant: el worker lo resuelve a partir de `channelExternalAccountId`
 * (phone_number_id en WhatsApp, page_id / ig_user_id en Meta, etc.).
 * Es serializable a JSON: las fechas van en ISO 8601.
 */
export interface ParsedEvent {
  channel: Channel;
  channelExternalAccountId: string;
  /** Único por canal; es la clave de idempotencia de entrada. */
  externalEventId: string;
  kind: EventKind;
  occurredAt: string;
  from?: { externalUserId: string; displayName?: string; phone?: string };
  /** Id del mensaje en la plataforma (solo `kind = 'message'`). */
  externalMessageId?: string;
  text?: string;
  media?: MediaRef[];
  status?: { externalMessageId: string; state: DeliveryState; errorCode?: string };
  /** Tipo original cuando `kind = 'unsupported'` (ej. "location", "reaction"). */
  unsupportedType?: string;
}

export type MessageAuthor = 'customer' | 'bot' | 'agent' | 'system';
