import { outboundIdempotencyKey, type BrainJobData } from '@zenith/core';
import { withTenant, type Pool, type PoolClient } from '@zenith/db';
import {
  buildSystemPrompt,
  FALLBACK_REPLY,
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
}

export type BrainJobOutcome =
  | { result: 'replied'; outboundMessageId: string; handoff: boolean; outcome: BrainResult['outcome'] }
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
    `SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY created_at DESC, id DESC LIMIT 1`,
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
         SELECT direction, author, type, body, created_at, id FROM messages
          WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2) recent
        ORDER BY created_at, id`,
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
    if (isRetryableLlmError(err)) throw err; // la cola reintenta con backoff
    brain = {
      outcome: 'error',
      reply: FALLBACK_REPLY,
      handoff: { reason: 'error', summary: 'Falló la llamada al modelo; atender manualmente.' },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      iterations: 0,
      stopReason: null,
      model: deps.config?.model ?? 'desconocido',
      error: (err as Error).message.slice(0, 500),
    };
  }
  const latencyMs = Date.now() - started;

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

    const message = await client.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, author, type, body)
       VALUES ($1, $2, 'out', 'bot', 'text', $3) RETURNING id`,
      [job.tenantId, job.conversationId, brain.reply],
    );
    const messageId = message.rows[0]!.id;

    const outbound = await client.query<{ id: string }>(
      `INSERT INTO outbound_messages (tenant_id, conversation_id, message_id, idempotency_key, channel, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        job.tenantId,
        job.conversationId,
        messageId,
        key,
        snapshot.channel,
        JSON.stringify({ kind: 'text', text: brain.reply, to: snapshot.recipient, author: 'bot' }),
      ],
    );
    if (!outbound.rows[0]) {
      // Otro intento ya guardó la respuesta: se deshace esta transacción.
      throw new AlreadyAnsweredError();
    }

    if (brain.handoff) {
      await client.query(`UPDATE conversations SET mode = 'human', updated_at = now() WHERE id = $1`, [job.conversationId]);
      await client.query(`INSERT INTO handoffs (tenant_id, conversation_id, reason, summary) VALUES ($1, $2, $3, $4)`, [
        job.tenantId,
        job.conversationId,
        brain.handoff.reason,
        brain.handoff.summary.slice(0, 1000),
      ]);
    }
    await logRun(brain.outcome);

    return { result: 'replied', outboundMessageId: outbound.rows[0].id, handoff: Boolean(brain.handoff), outcome: brain.outcome };
  }).catch((err) => {
    if (err instanceof AlreadyAnsweredError) return { result: 'skipped', reason: 'already_answered' } as const;
    throw err;
  });
}

class AlreadyAnsweredError extends Error {}
