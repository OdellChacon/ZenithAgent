import { decryptCredentials, outboundIdempotencyKey, type BrainJobData, type Channel } from '@zenith/core';
import { markWhatsAppRead } from '@zenith/channel-whatsapp';
import { withTenant, type Pool, type PoolClient } from '@zenith/db';
import {
  buildSystemPrompt,
  conversationNote,
  FALLBACK_REPLY,
  formatForChannel,
  isRetryableLlmError,
  parseTenantBotSettings,
  pendingCustomerImages,
  pendingVoiceNotes,
  runBrainTurn,
  splitBubbles,
  typingPauseMs,
  toModelMessages,
  type BrainConfig,
  type BrainResult,
  type HistoryMessage,
  type LlmClient,
  type ModelImage,
} from '@zenith/brain';
import { createCatalogReader } from './catalog-reader.js';
import { loadCustomerImages, type CustomerMediaDeps, type PendingImage } from './customer-images.js';
import { transcribeVoiceNotes, type VoiceDeps } from './voice.js';

export interface BrainJobDeps {
  pool: Pool;
  llm: LlmClient;
  config?: Partial<BrainConfig>;
  /** Mensajes previos que se le muestran al modelo. */
  historyLimit?: number;
  /**
   * Último intento de la cola: si el proveedor sigue fallando, no se reintenta más y el
   * cliente recibe el mensaje de respaldo en vez de quedarse sin respuesta.
   */
  finalAttempt?: boolean;
  /** Para que el modelo vea las fotos del cliente. Sin esto, solo recibe una nota de texto. */
  media?: CustomerMediaDeps;
  /** Para transcribir las notas de voz (necesita `media`). Sin esto, el bot pide que escriban. */
  voice?: VoiceDeps;
  now?: () => Date;
}

export type BrainJobOutcome =
  | {
      result: 'replied';
      /** El mensaje de texto. */
      outboundMessageId: string;
      /** Todos los envíos, en el orden en que deben salir (fotos y luego los mensajes de texto). */
      outboundMessageIds: string[];
      /** Pausa de "escribiendo" antes de cada envío, en el mismo orden. */
      pausesMs: number[];
      handoff: boolean;
      /** Pase a asesor creado en este turno, para avisar al equipo. */
      handoffId?: string;
      outcome: BrainResult['outcome'];
    }
  | { result: 'skipped'; reason: 'not_found' | 'human_mode' | 'closed' | 'superseded' | 'already_answered' }
  | { result: 'failed'; reason: string };

interface Snapshot {
  channel: string;
  channelAccountId: string;
  credentialsEnc: Buffer | null;
  recipient: string;
  settings: unknown;
  timezone: string;
  customerName: string | null;
  /** Foto de la fachada del negocio, si la cargó. */
  storefrontImageId: string | null;
  /** phone_number_id del canal y wamid del mensaje que dispara el turno (para "leído"). */
  externalAccountId: string;
  triggerExternalId: string | null;
  history: (HistoryMessage & { external_media_id: string | null })[];
}

const REPLY_STEP = 'reply';

async function latestInboundId(client: PoolClient, conversationId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    // Orden de llegada (seq): la hora de WhatsApp viene al segundo y no sirve para ordenar
    // un mensaje del cliente contra la respuesta del bot guardada en el mismo segundo.
    `SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY seq DESC LIMIT 1`,
    [conversationId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Un turno del bot para una conversación: lee el contexto, llama al cerebro sin mantener
 * transacciones abiertas durante la llamada al modelo, y guarda la respuesta, el envío
 * pendiente y el pase a asesor en una sola transacción.
 */
export async function processBrainJob(deps: BrainJobDeps, job: BrainJobData): Promise<BrainJobOutcome> {
  const { pool } = deps;
  const key = outboundIdempotencyKey(job.conversationId, job.triggerMessageId, REPLY_STEP);

  const snapshot = await withTenant(pool, job.tenantId, async (client): Promise<Snapshot | BrainJobOutcome> => {
    const conv = await client.query<{
      mode: string;
      status: string;
      channel: string;
      channel_account_id: string;
      external_account_id: string;
      credentials_enc: Buffer | null;
      recipient: string | null;
      customer_name: string | null;
    }>(
      `SELECT c.mode, c.status, ca.channel, ca.id AS channel_account_id, ca.external_account_id, ca.credentials_enc,
              (SELECT ct.name FROM contacts ct WHERE ct.id = c.contact_id) AS customer_name,
              (SELECT ci.external_user_id FROM contact_identities ci
                WHERE ci.contact_id = c.contact_id AND ci.channel = ca.channel LIMIT 1) AS recipient
         FROM conversations c JOIN channel_accounts ca ON ca.id = c.channel_account_id
        WHERE c.id = $1`,
      [job.conversationId],
    );
    const row = conv.rows[0];
    if (!row || !row.recipient) return { result: 'skipped', reason: 'not_found' };
    if (row.status === 'closed') return { result: 'skipped', reason: 'closed' };
    if (row.mode !== 'bot') return { result: 'skipped', reason: 'human_mode' };
    if ((await latestInboundId(client, job.conversationId)) !== job.triggerMessageId) {
      return { result: 'skipped', reason: 'superseded' }; // un mensaje más nuevo tiene su propio turno
    }
    const answered = await client.query('SELECT 1 FROM outbound_messages WHERE idempotency_key = $1', [key]);
    if (answered.rowCount) return { result: 'skipped', reason: 'already_answered' };

    const tenant = await client.query<{ settings: unknown; timezone: string }>('SELECT settings, timezone FROM tenants WHERE id = $1', [
      job.tenantId,
    ]);
    const history = await client.query<HistoryMessage & { external_media_id: string | null }>(
      `SELECT id, direction, author, type, body, external_media_id FROM (
         SELECT id, direction, author, type, body, seq, attachments->0->>'externalMediaId' AS external_media_id FROM messages
          WHERE conversation_id = $1 ORDER BY seq DESC LIMIT $2) recent
        ORDER BY seq`,
      [job.conversationId, deps.historyLimit ?? 30],
    );
    // Foto de la fachada (se manda con la dirección cuando el cliente pregunta dónde quedan).
    const storefront = await client.query<{ id: string }>(`SELECT id FROM product_images WHERE purpose = 'storefront' LIMIT 1`);
    const trigger = await client.query<{ external_message_id: string | null }>('SELECT external_message_id FROM messages WHERE id = $1', [
      job.triggerMessageId,
    ]);
    return {
      storefrontImageId: storefront.rows[0]?.id ?? null,
      externalAccountId: row.external_account_id,
      triggerExternalId: trigger.rows[0]?.external_message_id ?? null,
      channel: row.channel,
      channelAccountId: row.channel_account_id,
      credentialsEnc: row.credentials_enc,
      recipient: row.recipient,
      settings: tenant.rows[0]?.settings,
      timezone: tenant.rows[0]?.timezone ?? 'UTC',
      customerName: row.customer_name,
      history: history.rows,
    };
  });

  if ('result' in snapshot) return snapshot;

  let settings;
  try {
    settings = parseTenantBotSettings(snapshot.settings);
  } catch (err) {
    return { result: 'failed', reason: (err as Error).message };
  }

  const started = Date.now();
  // Como una persona que abre el chat: el cliente ve "leído" y "escribiendo…" mientras el bot piensa.
  if (deps.media && snapshot.channel === 'whatsapp' && snapshot.triggerExternalId) {
    await markReadAndTyping(deps.media, snapshot);
  }
  // Notas de voz pendientes: se transcriben y el texto queda guardado en el mensaje, así lo
  // ven el modelo, el panel y los turnos siguientes sin volver a escucharlas.
  if (deps.media && deps.voice) {
    const pending = pendingVoiceNotes(snapshot.history).map((m) => ({
      ...m,
      id: m.id!,
      externalMediaId: (m as Snapshot['history'][number]).external_media_id,
    }));
    const texts = await transcribeVoiceNotes(
      deps.media,
      deps.voice,
      { channel: snapshot.channel, channelAccountId: snapshot.channelAccountId, credentialsEnc: snapshot.credentialsEnc },
      pending,
    );
    if (texts.size) {
      await withTenant(pool, job.tenantId, async (c) => {
        for (const [id, text] of texts) await c.query(`UPDATE messages SET body = $2 WHERE id = $1 AND body IS NULL`, [id, text]);
      });
      for (const m of snapshot.history) if (m.id && texts.has(m.id)) m.body = texts.get(m.id)!;
    }
  }
  // Las fotos que el cliente mandó desde la última respuesta se bajan para que el modelo las vea.
  let images: Map<string, ModelImage> | undefined;
  if (deps.media) {
    const pending = pendingCustomerImages(snapshot.history).map((m) => ({
      ...m,
      externalMediaId: (m as Snapshot['history'][number]).external_media_id,
    })) as PendingImage[];
    images = await loadCustomerImages(
      deps.media,
      { channel: snapshot.channel, channelAccountId: snapshot.channelAccountId, credentialsEnc: snapshot.credentialsEnc },
      pending,
    );
  }

  let brain: BrainResult;
  try {
    brain = await runBrainTurn({
      llm: deps.llm,
      system: buildSystemPrompt(settings),
      messages: toModelMessages(snapshot.history, images, {
        leadingNote: conversationNote({
          customerName: snapshot.customerName,
          now: deps.now?.() ?? new Date(),
          timezone: snapshot.timezone,
          openingHours: settings.business.openingHours,
        }),
      }),
      tools: {
        catalog: createCatalogReader(pool, job.tenantId),
        wastePercent: settings.boxes.wastePercent,
        hasStorefrontPhoto: Boolean(snapshot.storefrontImageId),
      },
      ...(deps.config ? { config: deps.config } : {}),
    });
  } catch (err) {
    if (isRetryableLlmError(err) && !deps.finalAttempt) throw err; // la cola reintenta con backoff
    brain = {
      outcome: 'error',
      reply: FALLBACK_REPLY,
      handoff: {
        reason: 'error',
        summary: isRetryableLlmError(err)
          ? 'El proveedor de IA no respondió tras varios intentos; atender manualmente.'
          : 'Falló la llamada al modelo; atender manualmente.',
      },
      photos: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      iterations: 0,
      stopReason: null,
      model: deps.config?.model ?? 'desconocido',
      error: (err as Error).message.slice(0, 500),
    };
  }
  const latencyMs = Date.now() - started;
  brain = { ...brain, reply: formatForChannel(brain.reply, snapshot.channel as Channel) };

  return withTenant(pool, job.tenantId, async (client): Promise<BrainJobOutcome> => {
    // Mientras pensaba pudo llegar otro mensaje o un asesor pudo tomar la conversación.
    const state = await client.query<{ mode: string }>('SELECT mode FROM conversations WHERE id = $1 FOR UPDATE', [
      job.conversationId,
    ]);
    const superseded = (await latestInboundId(client, job.conversationId)) !== job.triggerMessageId;
    const humanTook = state.rows[0]?.mode !== 'bot';

    const logRun = (outcome: string) =>
      client.query(
        `INSERT INTO ai_runs (tenant_id, conversation_id, trigger_message_id, model, iterations, input_tokens, output_tokens,
                              cache_read_tokens, latency_ms, stop_reason, outcome, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          job.tenantId,
          job.conversationId,
          job.triggerMessageId,
          brain.model,
          brain.iterations,
          brain.usage.inputTokens,
          brain.usage.outputTokens,
          brain.usage.cacheReadTokens,
          latencyMs,
          brain.stopReason,
          outcome,
          brain.error ?? null,
        ],
      );

    if (superseded || humanTook) {
      await logRun('superseded');
      return { result: 'skipped', reason: superseded ? 'superseded' : 'human_mode' };
    }

    /** Guarda un mensaje del bot y su envío pendiente; null si ese paso ya estaba guardado. */
    const queue = async (type: 'text' | 'image', body: string, payload: object, idempotencyKey: string, attachments: object[] = []) => {
      const message = await client.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, author, type, body, attachments)
         VALUES ($1, $2, 'out', 'bot', $3, $4, $5) RETURNING id`,
        [job.tenantId, job.conversationId, type, body, JSON.stringify(attachments)],
      );
      const outbound = await client.query<{ id: string }>(
        `INSERT INTO outbound_messages (tenant_id, conversation_id, message_id, idempotency_key, channel, payload)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [job.tenantId, job.conversationId, message.rows[0]!.id, idempotencyKey, snapshot.channel, JSON.stringify(payload)],
      );
      return outbound.rows[0]?.id ?? null;
    };

    // Primero las fotos (cada una con el nombre del producto como pie) y después el texto,
    // partido en mensajes cortos como escribe una persona.
    const ordered: string[] = [];
    const pauses: number[] = [];
    if (brain.storefront && snapshot.storefrontImageId) {
      const caption = settings.business.address ?? settings.business.name;
      const id = await queue(
        'image',
        caption,
        { kind: 'image', productImageId: snapshot.storefrontImageId, caption, to: snapshot.recipient, author: 'bot' },
        outboundIdempotencyKey(job.conversationId, job.triggerMessageId, 'storefront'),
        [{ productImageId: snapshot.storefrontImageId, storefront: true }],
      );
      if (id) {
        ordered.push(id);
        pauses.push(0);
      }
    }
    for (const photo of brain.photos) {
      const image = await client.query<{ id: string }>(
        'SELECT id FROM product_images WHERE product_id = $1 ORDER BY position LIMIT 1',
        [photo.productId],
      );
      const imageId = image.rows[0]?.id;
      if (!imageId) continue;
      const id = await queue(
        'image',
        photo.name,
        { kind: 'image', productImageId: imageId, caption: photo.name, to: snapshot.recipient, author: 'bot' },
        outboundIdempotencyKey(job.conversationId, job.triggerMessageId, `photo:${photo.productId}`),
        [{ productImageId: imageId }],
      );
      if (id) {
        ordered.push(id);
        pauses.push(0);
      }
    }

    const bubbles = splitBubbles(brain.reply);
    if (!bubbles.length) bubbles.push(brain.reply);
    let textId: string | null = null;
    for (const [i, bubble] of bubbles.entries()) {
      const id = await queue(
        'text',
        bubble,
        { kind: 'text', text: bubble, to: snapshot.recipient, author: 'bot' },
        i === 0 ? key : outboundIdempotencyKey(job.conversationId, job.triggerMessageId, `${REPLY_STEP}:${i + 1}`),
      );
      if (!id) {
        // Otro intento ya guardó la respuesta: se deshace esta transacción.
        throw new AlreadyAnsweredError();
      }
      textId ??= id;
      // El primer mensaje sale sin espera si no hubo fotos: el cliente ya esperó al bot.
      pauses.push(ordered.length ? typingPauseMs(bubble) : 0);
      ordered.push(id);
    }

    if (brain.stopFollowups) {
      await client.query(
        `UPDATE contacts SET opt_out_followups = true, updated_at = now()
          WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)`,
        [job.conversationId],
      );
    }

    let handoffId: string | undefined;
    if (brain.handoff) {
      await client.query(`UPDATE conversations SET mode = 'human', agent_active_at = NULL, updated_at = now() WHERE id = $1`, [job.conversationId]);
      const handoff = await client.query<{ id: string }>(
        `INSERT INTO handoffs (tenant_id, conversation_id, reason, summary) VALUES ($1, $2, $3, $4) RETURNING id`,
        [job.tenantId, job.conversationId, brain.handoff.reason, brain.handoff.summary.slice(0, 1000)],
      );
      handoffId = handoff.rows[0]!.id;
    }
    await logRun(brain.outcome);

    return {
      result: 'replied',
      outboundMessageId: textId!,
      outboundMessageIds: ordered,
      pausesMs: pauses,
      handoff: Boolean(brain.handoff),
      ...(handoffId ? { handoffId } : {}),
      outcome: brain.outcome,
    };
  }).catch((err) => {
    if (err instanceof AlreadyAnsweredError) return { result: 'skipped', reason: 'already_answered' } as const;
    throw err;
  });
}

class AlreadyAnsweredError extends Error {}

/** "Leído" + "escribiendo…". Si falla, se sigue: no debe demorar ni impedir la respuesta. */
async function markReadAndTyping(media: CustomerMediaDeps, snapshot: Snapshot): Promise<void> {
  if (!snapshot.credentialsEnc || !snapshot.triggerExternalId) return;
  try {
    const creds = JSON.parse(decryptCredentials(snapshot.credentialsEnc, media.masterKey, snapshot.channelAccountId)) as { accessToken?: string };
    if (!creds.accessToken) return;
    const res = await markWhatsAppRead(
      {
        graphApiVersion: media.graphApiVersion,
        phoneNumberId: snapshot.externalAccountId,
        accessToken: creds.accessToken,
        timeoutMs: 5_000,
        ...(media.graphBaseUrl ? { graphBaseUrl: media.graphBaseUrl } : {}),
        ...(media.fetch ? { fetch: media.fetch } : {}),
      },
      snapshot.triggerExternalId,
      { typing: true },
    );
    if (!res.ok) media.log?.('no se pudo marcar como leído', { error: res.message });
  } catch (err) {
    media.log?.('no se pudo marcar como leído', { error: (err as Error).message });
  }
}
