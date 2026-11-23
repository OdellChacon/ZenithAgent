export const CHANNELS = ['whatsapp', 'instagram', 'messenger', 'tiktok'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * message: lo escribió el cliente. echo: lo escribió alguien del negocio desde la app de
 * WhatsApp Business o un dispositivo vinculado (no la API), así que el bot no lo envió.
 * history: chats anteriores que Meta manda una sola vez al conectar un número que ya usaba
 * la app (coexistencia). account: aviso sobre la conexión del número (desconexión, etc.).
 */
export type EventKind = 'message' | 'echo' | 'history' | 'account' | 'status' | 'unsupported';

/** Un mensaje del historial importado. `fromBusiness`: lo mandó el negocio, no el cliente. */
export interface HistoryMessage {
  externalMessageId: string;
  fromBusiness: boolean;
  occurredAt: string;
  /** text, image, … o media_placeholder (el archivo llega después en otro aviso). */
  type: string;
  text?: string;
  media?: MediaRef[];
}

/**
 * Aviso sobre la conexión de un número.
 * - disconnected: Meta desconectó el número de la API (reason: PRIMARY_INACTIVITY, …).
 * - reconnected: se volvió a conectar.
 * - history_declined: el negocio no quiso compartir su historial.
 * `scope` dice qué trae `channelExternalAccountId`: el phone_number_id o el id de la cuenta
 * de WhatsApp Business (WABA), que puede tener varios números.
 */
export interface AccountNotice {
  type: 'disconnected' | 'reconnected' | 'history_declined';
  scope: 'phone' | 'waba';
  /** Evento original de Meta (PARTNER_REMOVED, ACCOUNT_OFFBOARDED…). */
  event?: string;
  reason?: string;
}

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
  /** Cliente que recibió el mensaje (solo `kind = 'echo'`). */
  to?: { externalUserId: string; displayName?: string; phone?: string };
  /** Id del mensaje en la plataforma (`kind = 'message'` o `'echo'`). */
  externalMessageId?: string;
  text?: string;
  media?: MediaRef[];
  status?: { externalMessageId: string; state: DeliveryState; errorCode?: string };
  /** Chat del historial (`kind = 'history'`): cliente y sus mensajes de este tramo. */
  history?: { progress: number; messages: HistoryMessage[] };
  /** `kind = 'account'`. */
  account?: AccountNotice;
  /** Tipo original cuando `kind = 'unsupported'` (ej. "location", "reaction"). */
  unsupportedType?: string;
}

export type MessageAuthor = 'customer' | 'bot' | 'agent' | 'system';
