import { z } from 'zod';
import type { DeliveryState, MediaRef, MediaType, ParsedEvent } from '@zenith/core';

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

export const whatsappWebhookSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(z.object({ field: z.string(), value: z.unknown() })),
    }),
  ),
});

export class WhatsAppPayloadError extends Error {
  override name = 'WhatsAppPayloadError';
}

const MEDIA_TYPES: readonly MediaType[] = ['image', 'audio', 'video', 'document', 'sticker'];
const DELIVERY_STATES: readonly DeliveryState[] = ['sent', 'delivered', 'read', 'failed'];

const toIso = (unixSeconds: string | number) => new Date(Number(unixSeconds) * 1000).toISOString();

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
