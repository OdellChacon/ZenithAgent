import { outboundIdempotencyKey, type BrainJobData, type Channel } from '@zenith/core';
import { withTenant, type Pool, type PoolClient } from '@zenith/db';
import {
  buildSystemPrompt,
  FALLBACK_REPLY,
  formatForChannel,
  isRetryableLlmError,
  parseTenantBotSettings,
  runBrainTurn,
  toModelMessages,
  type BrainConfig,
  type BrainResult,
  type HistoryMessage,
  type LlmClient,
} from '@zenith/brain';
import { createCatalogReader } from './catalog-reader.js';

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
}

export type BrainJobOutcome =
  | {
      result: 'replied';
      /** El mensaje de texto. */
      outboundMessageId: string;
      /** Todos los envíos, en el orden en que deben salir (fotos y luego texto). */
      outboundMessageIds: string[];
      handoff: boolean;
      /** Pase a asesor creado en este turno, para avisar al equipo. */
      handoffId?: string;
      outcome: BrainResult['outcome'];
    }
  | { result: 'skipped'; reason: 'not_found' | 'human_mode' | 'closed' | 'superseded' | 'already_answered' }
  | { result: 'failed'; reason: string };

interface Snapshot {
  channel: string;
  recipient: string;
  settings: unknown;
  history: HistoryMessage[];
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
    const conv = await client.query<{ mode: string; status: string; channel: string; recipient: string | null }>(
      `SELECT c.mode, c.status, ca.channel,
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

    const tenant = await client.query<{ settings: unknown }>('SELECT settings FROM tenants WHERE id = $1', [job.tenantId]);
    const history = await client.query<HistoryMessage>(
      `SELECT direction, author, type, body FROM (
         SELECT direction, author, type, body, seq FROM messages
          WHERE conversation_id = $1 ORDER BY seq DESC LIMIT $2) recent
        ORDER BY seq`,
      [job.conversationId, deps.historyLimit ?? 30],
    );
    return { channel: row.channel, recipient: row.recipient, settings: tenant.rows[0]?.settings, history: history.rows };
  });

  if ('result' in snapshot) return snapshot;

  let settings;
  try {
    settings = parseTenantBotSettings(snapshot.settings);
  } catch (err) {
    return { result: 'failed', reason: (err as Error).message };
  }

  const started = Date.now();
  let brain: BrainResult;
  try {
    brain = await runBrainTurn({
      llm: deps.llm,
      system: buildSystemPrompt(settings),
      messages: toModelMessages(snapshot.history),
      tools: { catalog: createCatalogReader(pool, job.tenantId), wastePercent: settings.boxes.wastePercent },
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

    // Primero las fotos (cada una con el nombre del producto como pie) y después el texto.
    const ordered: string[] = [];
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
      if (id) ordered.push(id);
    }

    const textId = await queue('text', brain.reply, { kind: 'text', text: brain.reply, to: snapshot.recipient, author: 'bot' }, key);
    if (!textId) {
      // Otro intento ya guardó la respuesta: se deshace esta transacción.
      throw new AlreadyAnsweredError();
    }
    ordered.push(textId);

    let handoffId: string | undefined;
    if (brain.handoff) {
      await client.query(`UPDATE conversations SET mode = 'human', updated_at = now() WHERE id = $1`, [job.conversationId]);
      const handoff = await client.query<{ id: string }>(
        `INSERT INTO handoffs (tenant_id, conversation_id, reason, summary) VALUES ($1, $2, $3, $4) RETURNING id`,
        [job.tenantId, job.conversationId, brain.handoff.reason, brain.handoff.summary.slice(0, 1000)],
      );
      handoffId = handoff.rows[0]!.id;
    }
    await logRun(brain.outcome);

    return {
      result: 'replied',
      outboundMessageId: textId,
      outboundMessageIds: ordered,
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
