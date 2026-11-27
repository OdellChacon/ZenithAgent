import { z } from 'zod';
import type { Channel, MediaRef, MediaType, ParsedEvent } from '@zenith/core';

/**
 * Webhooks de Messenger (object "page") e Instagram (object "instagram"). Documentación de Meta
 * revisada el 27/11/2026: cada entry trae `messaging[]` con sender.id, recipient.id, timestamp
 * (milisegundos) y el evento: `message` (con `is_echo` si lo mandó la página), `message_edit`
 * (Messenger), `delivery`, `read`, `postback`. Instagram marca con `is_deleted` el mensaje que
 * el cliente borró. Los clientes se identifican por PSID (Messenger) o IGSID (Instagram): no
 * hay teléfono.
 */
const attachmentSchema = z
  .object({
    type: z.string(),
    payload: z.object({ url: z.string().optional(), title: z.string().optional() }).passthrough().nullish(),
  })
  .passthrough();

const messagingSchema = z
  .object({
    sender: z.object({ id: z.string().min(1) }),
    recipient: z.object({ id: z.string().min(1) }),
    timestamp: z.number().optional(),
    message: z
      .object({
        mid: z.string().min(1),
        text: z.string().optional(),
        is_echo: z.boolean().optional(),
        is_deleted: z.boolean().optional(),
        app_id: z.union([z.number(), z.string()]).optional(),
        quick_reply: z.object({ payload: z.string().optional() }).passthrough().optional(),
        attachments: z.array(attachmentSchema).optional(),
      })
      .passthrough()
      .optional(),
    message_edit: z.object({ mid: z.string().min(1), text: z.string().optional() }).passthrough().optional(),
    delivery: z.object({ mids: z.array(z.string()).optional(), watermark: z.number().optional() }).passthrough().optional(),
    postback: z.object({ title: z.string().optional(), payload: z.string().optional(), mid: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export const metaMessagingWebhookSchema = z.object({
  object: z.enum(['page', 'instagram']),
  entry: z.array(
    z
      .object({
        id: z.string(),
        time: z.number().optional(),
        messaging: z.array(z.unknown()).optional(),
      })
      .passthrough(),
  ),
});

export class MetaPayloadError extends Error {
  override name = 'MetaPayloadError';
}

/** Tipo de adjunto de Meta → tipo de archivo del sistema. "file" es un documento. */
const ATTACHMENT_TYPES: Record<string, MediaType> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
  file: 'document',
  sticker: 'sticker',
};

const toIso = (ms: number | undefined) => {
  const d = new Date(ms ?? Date.now());
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
};

function toMedia(attachments: z.infer<typeof attachmentSchema>[] | undefined): MediaRef[] {
  const out: MediaRef[] = [];
  for (const a of attachments ?? []) {
    const type = ATTACHMENT_TYPES[a.type];
    const url = a.payload?.url;
    if (!type || !url) continue;
    out.push({ type, externalMediaId: '', url, ...(a.payload?.title ? { filename: a.payload.title.slice(0, 240) } : {}) });
  }
  return out;
}

function toEvents(channel: Channel, accountId: string, raw: unknown): ParsedEvent[] {
  const parsed = messagingSchema.safeParse(raw);
  if (!parsed.success) return [];
  const m = parsed.data;
  const occurredAt = toIso(m.timestamp);
  const base = { channel, channelExternalAccountId: accountId, occurredAt };

  if (m.message_edit) {
    return [
      {
        ...base,
        kind: 'edit',
        externalEventId: `edit:${m.message_edit.mid}:${m.timestamp ?? ''}`,
        edit: {
          originalExternalMessageId: m.message_edit.mid,
          action: 'edit',
          byBusiness: m.sender.id === accountId,
          ...(m.message_edit.text !== undefined ? { text: m.message_edit.text } : {}),
        },
      },
    ];
  }

  if (m.delivery) {
    return (m.delivery.mids ?? []).map((mid) => ({
      ...base,
      kind: 'status' as const,
      externalEventId: `status:${mid}:delivered`,
      status: { externalMessageId: mid, state: 'delivered' as const },
    }));
  }

  if (m.postback) {
    // Botón tocado por el cliente: cuenta como lo que dice el botón.
    const text = m.postback.title ?? m.postback.payload;
    if (!text) return [];
    const id = m.postback.mid ?? `postback:${m.sender.id}:${m.timestamp ?? ''}`;
    return [{ ...base, kind: 'message', externalEventId: `msg:${id}`, externalMessageId: id, from: { externalUserId: m.sender.id }, text }];
  }

  const msg = m.message;
  if (!msg) return [];

  if (msg.is_deleted) {
    return [
      {
        ...base,
        kind: 'edit',
        externalEventId: `revoke:${msg.mid}`,
        edit: { originalExternalMessageId: msg.mid, action: 'revoke', byBusiness: m.sender.id === accountId },
      },
    ];
  }

  const media = toMedia(msg.attachments);
  const text = msg.text ?? undefined;

  if (msg.is_echo) {
    // Lo mandó la página o la cuenta. Con app_id lo envió una app por la API (este sistema u
    // otra herramienta conectada): no es un asesor escribiendo a mano.
    if (msg.app_id !== undefined) {
      return [{ ...base, kind: 'unsupported', externalEventId: `echo:${msg.mid}`, unsupportedType: 'echo_api' }];
    }
    return [
      {
        ...base,
        kind: 'echo',
        externalEventId: `echo:${msg.mid}`,
        externalMessageId: msg.mid,
        to: { externalUserId: m.recipient.id },
        ...(text !== undefined ? { text } : {}),
        ...(media.length ? { media } : {}),
      },
    ];
  }

  const event: ParsedEvent = {
    ...base,
    kind: 'message',
    externalEventId: `msg:${msg.mid}`,
    externalMessageId: msg.mid,
    from: { externalUserId: m.sender.id },
  };
  if (text !== undefined && text !== '') return [{ ...event, text, ...(media.length ? { media } : {}) }];
  if (media.length) return [{ ...event, media }];
  // Gifs, stickers de Instagram, compartidos de historias, etc.
  return [{ ...event, kind: 'unsupported', unsupportedType: msg.attachments?.[0]?.type ?? 'desconocido' }];
}

/**
 * Traduce un webhook de Messenger o Instagram a eventos normalizados. Lanza `MetaPayloadError`
 * si el sobre no es de esos canales; los eventos individuales con forma rara se descartan.
 */
export function parseMetaMessagingWebhook(body: unknown): ParsedEvent[] {
  const envelope = metaMessagingWebhookSchema.safeParse(body);
  if (!envelope.success) throw new MetaPayloadError('El cuerpo no es un webhook de Messenger o Instagram válido');
  const channel: Channel = envelope.data.object === 'page' ? 'messenger' : 'instagram';
  const events: ParsedEvent[] = [];
  for (const entry of envelope.data.entry) {
    for (const raw of entry.messaging ?? []) events.push(...toEvents(channel, entry.id, raw));
  }
  return events;
}
