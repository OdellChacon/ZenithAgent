import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AccountNotice, DeliveryState, HistoryMessage, MediaRef, MediaType, ParsedEvent } from '@zenith/core';

/**
 * Esquema mínimo del webhook de WhatsApp Cloud API. Solo se exige lo que se usa; el resto
 * pasa sin validar para tolerar campos nuevos de Meta.
 */
const mediaSchema = z.object({
  id: z.string().min(1),
  mime_type: z.string().optional(),
  caption: z.string().optional(),
});

const messageSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    timestamp: z.string().regex(/^\d+$/),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    image: mediaSchema.optional(),
    audio: mediaSchema.optional(),
    video: mediaSchema.optional(),
    document: mediaSchema.optional(),
    sticker: mediaSchema.optional(),
    button: z.object({ text: z.string() }).optional(),
    interactive: z
      .object({
        button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
        list_reply: z.object({ id: z.string(), title: z.string() }).optional(),
      })
      .optional(),
  })
  .passthrough();

const statusSchema = z
  .object({
    id: z.string().min(1),
    status: z.string(),
    timestamp: z.string().regex(/^\d+$/),
    recipient_id: z.string().optional(),
    errors: z.array(z.object({ code: z.number() }).passthrough()).optional(),
  })
  .passthrough();

const valueSchema = z
  .object({
    metadata: z.object({ phone_number_id: z.string().min(1) }).passthrough(),
    contacts: z
      .array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).partial().optional() }).passthrough())
      .optional(),
    messages: z.array(messageSchema).optional(),
    statuses: z.array(statusSchema).optional(),
  })
  .passthrough();

/**
 * Copia de un mensaje que alguien del negocio mandó desde la app de WhatsApp Business o un
 * dispositivo vinculado (coexistencia). `to` puede faltar si el cliente solo tiene usuario.
 */
const echoSchema = z
  .object({
    id: z.string().min(1),
    to: z.string().min(1).optional(),
    timestamp: z.union([z.string().regex(/^\d+$/), z.number().int()]),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    image: mediaSchema.optional(),
    audio: mediaSchema.optional(),
    video: mediaSchema.optional(),
    document: mediaSchema.optional(),
    sticker: mediaSchema.optional(),
  })
  .passthrough();

const echoValueSchema = z
  .object({
    metadata: z.object({ phone_number_id: z.string().min(1) }).passthrough(),
    message_echoes: z.array(echoSchema).optional(),
  })
  .passthrough();

/**
 * Historial de chats (campo `history`). Llega por tramos (phase 0: último día, 1: hasta 90
 * días, 2: hasta 180) y en trozos que pueden venir desordenados. Si el negocio no quiso
 * compartirlo, llega un solo aviso con el error 2593109.
 */
const historyMessageSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().optional(),
    from_user_id: z.string().optional(),
    timestamp: z.union([z.string().regex(/^\d+$/), z.number().int()]),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    image: mediaSchema.optional(),
    audio: mediaSchema.optional(),
    video: mediaSchema.optional(),
    document: mediaSchema.optional(),
    sticker: mediaSchema.optional(),
  })
  .passthrough();

const historyValueSchema = z
  .object({
    metadata: z.object({ phone_number_id: z.string().min(1), display_phone_number: z.string().optional() }).passthrough(),
    history: z.array(
      z
        .object({
          metadata: z.object({ phase: z.number().int(), chunk_order: z.number().int(), progress: z.number() }).partial().optional(),
          threads: z
            .array(
              z
                .object({
                  id: z.string().optional(),
                  context: z.object({ wa_id: z.string().optional() }).passthrough().optional(),
                  messages: z.array(historyMessageSchema).default([]),
                })
                .passthrough(),
            )
            .optional(),
          errors: z.array(z.object({ code: z.number() }).passthrough()).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** Código de Meta cuando el negocio no compartió su historial desde la app. */
export const HISTORY_DECLINED_CODE = 2593109;

/**
 * Avisos de la cuenta (campo `account_update`). No traen phone_number_id: se identifican por
 * la cuenta de WhatsApp Business (WABA), que va en waba_info o, si falta, en entry.id.
 */
const accountValueSchema = z
  .object({
    event: z.string(),
    waba_info: z.object({ waba_id: z.string().optional() }).passthrough().optional(),
    disconnection_info: z.object({ reason: z.string().optional(), initiated_by: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

/**
 * Agenda de la app WhatsApp Business (campo `smb_app_state_sync`): llega al conectar el número
 * si se pide, y después cada vez que alguien agrega, edita o borra un contacto en la app.
 */
const stateSyncValueSchema = z
  .object({
    metadata: z.object({ phone_number_id: z.string().min(1) }).passthrough(),
    state_sync: z.array(
      z
        .object({
          type: z.string(),
          action: z.string().optional(),
          contact: z.object({ full_name: z.string().optional(), first_name: z.string().optional(), phone_number: z.string().optional() }).passthrough().optional(),
          metadata: z.object({ timestamp: z.union([z.string(), z.number()]).optional() }).passthrough().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const DISCONNECT_EVENTS = ['PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED', 'ACCOUNT_DELETED'];
const RECONNECT_EVENTS = ['ACCOUNT_RECONNECTED', 'PARTNER_ADDED'];

export const whatsappWebhookSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      time: z.number().int().optional(),
      changes: z.array(z.object({ field: z.string(), value: z.unknown() })),
    }),
  ),
});

export class WhatsAppPayloadError extends Error {
  override name = 'WhatsAppPayloadError';
}

const MEDIA_TYPES: readonly MediaType[] = ['image', 'audio', 'video', 'document', 'sticker'];
const DELIVERY_STATES: readonly DeliveryState[] = ['sent', 'delivered', 'read', 'failed'];

/** Hora de Meta (segundos Unix) a ISO. Si viene inválida, la de llegada: un dato raro no tumba el webhook. */
const toIso = (unixSeconds: string | number) => {
  const d = new Date(Number(unixSeconds) * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
};

type WaMessage = z.infer<typeof messageSchema>;

function toMessageEvent(msg: WaMessage, phoneNumberId: string, displayName: string | undefined): ParsedEvent {
  const base: ParsedEvent = {
    channel: 'whatsapp',
    channelExternalAccountId: phoneNumberId,
    externalEventId: `msg:${msg.id}`,
    externalMessageId: msg.id,
    kind: 'message',
    occurredAt: toIso(msg.timestamp),
    from: { externalUserId: msg.from, phone: msg.from, ...(displayName ? { displayName } : {}) },
  };

  if (msg.type === 'text' && msg.text) return { ...base, text: msg.text.body };

  if ((MEDIA_TYPES as readonly string[]).includes(msg.type)) {
    const media = msg[msg.type as MediaType];
    if (media) {
      const ref: MediaRef = { type: msg.type as MediaType, externalMediaId: media.id };
      if (media.mime_type) ref.mimeType = media.mime_type;
      if (media.caption) ref.caption = media.caption;
      return { ...base, media: [ref], ...(media.caption ? { text: media.caption } : {}) };
    }
  }

  // Respuestas a botones de plantillas y mensajes interactivos: se tratan como texto.
  if (msg.type === 'button' && msg.button) return { ...base, text: msg.button.text };
  if (msg.type === 'interactive' && msg.interactive) {
    const reply = msg.interactive.button_reply ?? msg.interactive.list_reply;
    if (reply) return { ...base, text: reply.title };
  }

  return { ...base, kind: 'unsupported', unsupportedType: msg.type };
}

type WaEcho = z.infer<typeof echoSchema>;

function toEchoEvent(echo: WaEcho, phoneNumberId: string): ParsedEvent {
  const base: ParsedEvent = {
    channel: 'whatsapp',
    channelExternalAccountId: phoneNumberId,
    externalEventId: `echo:${echo.id}`,
    externalMessageId: echo.id,
    kind: 'echo',
    occurredAt: toIso(echo.timestamp),
  };
  // Sin teléfono no se puede ubicar al cliente; editar o borrar no es un mensaje nuevo.
  if (!echo.to) return { ...base, kind: 'unsupported', unsupportedType: 'echo_sin_destinatario' };
  if (echo.type === 'edit' || echo.type === 'revoke') return { ...base, kind: 'unsupported', unsupportedType: `echo_${echo.type}` };

  const withTo: ParsedEvent = { ...base, to: { externalUserId: echo.to, phone: echo.to } };
  if (echo.type === 'text' && echo.text) return { ...withTo, text: echo.text.body };
  if ((MEDIA_TYPES as readonly string[]).includes(echo.type)) {
    const media = echo[echo.type as MediaType];
    if (media) {
      const ref: MediaRef = { type: echo.type as MediaType, externalMediaId: media.id };
      if (media.mime_type) ref.mimeType = media.mime_type;
      if (media.caption) ref.caption = media.caption;
      return { ...withTo, media: [ref], ...(media.caption ? { text: media.caption } : {}) };
    }
  }
  // Otros tipos (ubicación, contacto…): igual cuentan como que el asesor está atendiendo.
  return { ...withTo, unsupportedType: echo.type };
}


const digits = (phone: string | undefined) => (phone ?? '').replace(/\D/g, '');

function toMediaRefs(msg: { type: string } & Partial<Record<MediaType, z.infer<typeof mediaSchema>>>): MediaRef[] | undefined {
  if (!(MEDIA_TYPES as readonly string[]).includes(msg.type)) return undefined;
  const media = msg[msg.type as MediaType];
  if (!media) return undefined;
  const ref: MediaRef = { type: msg.type as MediaType, externalMediaId: media.id };
  if (media.mime_type) ref.mimeType = media.mime_type;
  if (media.caption) ref.caption = media.caption;
  return [ref];
}

function toHistoryEvents(value: z.infer<typeof historyValueSchema>): ParsedEvent[] {
  const phoneNumberId = value.metadata.phone_number_id;
  const businessPhone = digits(value.metadata.display_phone_number);
  const events: ParsedEvent[] = [];
  for (const chunk of value.history) {
    if (chunk.errors?.some((e) => e.code === HISTORY_DECLINED_CODE)) {
      events.push({
        channel: 'whatsapp',
        channelExternalAccountId: phoneNumberId,
        externalEventId: `history-declined:${phoneNumberId}`,
        kind: 'account',
        occurredAt: new Date().toISOString(),
        account: { type: 'history_declined', scope: 'phone' },
      });
      continue;
    }
    const progress = chunk.metadata?.progress ?? 0;
    for (const thread of chunk.threads ?? []) {
      // Sin teléfono (cliente con solo nombre de usuario) no hay cómo ubicarlo: se omite.
      const customer = digits(thread.id ?? thread.context?.wa_id);
      if (!customer || customer === businessPhone) continue;
      const messages: HistoryMessage[] = thread.messages.map((m) => {
        // El cliente trae from_user_id; si no, se compara el remitente con su teléfono.
        const fromBusiness = m.from_user_id ? false : m.from ? digits(m.from) !== customer : true;
        const media = toMediaRefs(m);
        const text = m.type === 'text' ? m.text?.body : media?.[0]?.caption;
        return {
          externalMessageId: m.id,
          fromBusiness,
          occurredAt: toIso(m.timestamp),
          type: m.type,
          ...(text !== undefined ? { text } : {}),
          ...(media ? { media } : {}),
        };
      });
      if (!messages.length) continue;
      // Meta puede reenviar un trozo y luego mandar los archivos de los mismos mensajes: la
      // clave sale del contenido, no del orden del trozo.
      const digest = createHash('sha256')
        .update(messages.map((m) => `${m.externalMessageId}:${m.type}:${m.media?.[0]?.externalMediaId ?? ''}`).join('|'))
        .digest('hex')
        .slice(0, 24);
      const last = messages.reduce((a, b) => (a.occurredAt > b.occurredAt ? a : b));
      events.push({
        channel: 'whatsapp',
        channelExternalAccountId: phoneNumberId,
        externalEventId: `history:${customer}:${digest}`,
        kind: 'history',
        occurredAt: last.occurredAt,
        from: { externalUserId: customer, phone: customer },
        history: { progress, messages },
      });
    }
  }
  return events;
}

function toContactEvents(value: z.infer<typeof stateSyncValueSchema>): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  for (const item of value.state_sync) {
    const action = item.action === 'remove' ? 'remove' : item.action === 'add' ? 'add' : null;
    const phone = digits(item.contact?.phone_number);
    // Sin teléfono (solo usuario) no se puede ubicar al cliente.
    if (item.type !== 'contact' || !action || !phone) continue;
    const ts = item.metadata?.timestamp;
    // Una hora inválida no debe tumbar el aviso completo: se usa la de llegada.
    const seconds = ts !== undefined && /^\d{1,11}$/.test(String(ts)) ? Number(ts) : NaN;
    const occurredAt = Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : new Date().toISOString();
    const fullName = item.contact?.full_name?.trim() || item.contact?.first_name?.trim();
    events.push({
      channel: 'whatsapp',
      channelExternalAccountId: value.metadata.phone_number_id,
      externalEventId: `contact:${phone}:${action}:${ts ?? occurredAt}`,
      kind: 'contact',
      occurredAt,
      contact: { phone, action, ...(action === 'add' && fullName ? { fullName: fullName.slice(0, 120) } : {}) },
    });
  }
  return events;
}

function toAccountEvent(entryId: string, time: number | undefined, value: z.infer<typeof accountValueSchema>): ParsedEvent | null {
  const type: AccountNotice['type'] | null = DISCONNECT_EVENTS.includes(value.event)
    ? 'disconnected'
    : RECONNECT_EVENTS.includes(value.event)
      ? 'reconnected'
      : null;
  if (!type) return null;
  const wabaId = value.waba_info?.waba_id ?? entryId;
  const occurredAt = time ? new Date(time * 1000).toISOString() : new Date().toISOString();
  const reason = value.disconnection_info?.reason;
  return {
    channel: 'whatsapp',
    channelExternalAccountId: wabaId,
    externalEventId: `account:${wabaId}:${value.event}:${time ?? occurredAt}`,
    kind: 'account',
    occurredAt,
    account: { type, scope: 'waba', event: value.event, ...(reason ? { reason } : {}) },
  };
}

/**
 * Traduce un webhook de WhatsApp a eventos normalizados. Un mismo webhook puede traer varios
 * mensajes y estados. Lanza `WhatsAppPayloadError` si el sobre no es de WhatsApp; los cambios
 * individuales con forma inesperada se descartan sin romper el resto.
 */
export function parseWhatsAppWebhook(body: unknown): ParsedEvent[] {
  const envelope = whatsappWebhookSchema.safeParse(body);
  if (!envelope.success) throw new WhatsAppPayloadError('El cuerpo no es un webhook de WhatsApp válido');

  const events: ParsedEvent[] = [];
  for (const entry of envelope.data.entry) {
    for (const change of entry.changes) {
      if (change.field === 'smb_message_echoes') {
        const value = echoValueSchema.safeParse(change.value);
        if (!value.success) continue;
        for (const echo of value.data.message_echoes ?? []) events.push(toEchoEvent(echo, value.data.metadata.phone_number_id));
        continue;
      }
      if (change.field === 'history') {
        const value = historyValueSchema.safeParse(change.value);
        if (value.success) events.push(...toHistoryEvents(value.data));
        continue;
      }
      if (change.field === 'smb_app_state_sync') {
        const value = stateSyncValueSchema.safeParse(change.value);
        if (value.success) events.push(...toContactEvents(value.data));
        continue;
      }
      if (change.field === 'account_update') {
        const value = accountValueSchema.safeParse(change.value);
        const event = value.success ? toAccountEvent(entry.id, entry.time, value.data) : null;
        if (event) events.push(event);
        continue;
      }
      if (change.field !== 'messages') continue;
      const value = valueSchema.safeParse(change.value);
      if (!value.success) continue;

      const phoneNumberId = value.data.metadata.phone_number_id;
      const names = new Map((value.data.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));

      for (const msg of value.data.messages ?? []) {
        events.push(toMessageEvent(msg, phoneNumberId, names.get(msg.from)));
      }

      for (const st of value.data.statuses ?? []) {
        if (!(DELIVERY_STATES as readonly string[]).includes(st.status)) continue;
        const errorCode = st.errors?.[0]?.code;
        events.push({
          channel: 'whatsapp',
          channelExternalAccountId: phoneNumberId,
          // Un mismo mensaje pasa por sent → delivered → read: cada estado es un evento.
          externalEventId: `status:${st.id}:${st.status}`,
          kind: 'status',
          occurredAt: toIso(st.timestamp),
          status: {
            externalMessageId: st.id,
            state: st.status as DeliveryState,
            ...(errorCode !== undefined ? { errorCode: String(errorCode) } : {}),
          },
        });
      }
    }
  }
  return events;
}
