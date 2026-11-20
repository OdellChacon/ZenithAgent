import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { z } from 'zod';
import {
  BRAIN_DEBOUNCE_MS,
  INBOUND_MAX_ATTEMPTS,
  parseMasterKey,
  QUEUES,
  type BrainJobData,
  type InboundJobData,
  type OutboundJobData,
} from '@zenith/core';
import {
  createAnthropicLlm,
  createDisabledLlm,
  createOpenAiCompatibleLlm,
  GEMINI_DEFAULT_FALLBACK_MODELS,
  GEMINI_DEFAULT_MODEL,
  GEMINI_OPENAI_BASE_URL,
  type LlmClient,
} from '@zenith/brain';
import { createPool, reclaimStaleWebhookEvents } from '@zenith/db';
import { processBrainJob } from './brain-job.js';
import { processInboundEvent } from './inbound.js';
import { processOutbound } from './outbound.js';

const env = z
  .object({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    ENCRYPTION_MASTER_KEY: z.string().min(1),
    META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/, 'Usa la forma vNN.N'),
    // Solo para pruebas locales contra un simulador de Graph API.
    META_GRAPH_BASE_URL: z.string().url().optional(),
    // none: sin IA (respaldo + asesor). gemini: API de Google. openai-compatible: Ollama, OpenRouter, etc.
    // anthropic: Claude (ver la política de regiones antes de usarlo).
    AI_PROVIDER: z.enum(['none', 'gemini', 'openai-compatible', 'anthropic']).default('none'),
    AI_MODEL: z.string().min(1).optional(),
    // Modelos de respaldo separados por coma, si el principal está saturado.
    AI_FALLBACK_MODELS: z.string().optional(),
    GEMINI_API_KEY: z.string().optional(),
    AI_BASE_URL: z.string().url().optional(),
    AI_API_KEY: z.string().optional(),
    AI_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL });

const fallbackModels = env.AI_FALLBACK_MODELS?.split(',').map((m) => m.trim()).filter(Boolean);

function buildLlm(): { llm: LlmClient; model: string } {
  switch (env.AI_PROVIDER) {
    case 'none':
      log.warn('AI_PROVIDER=none: el bot no usa IA; cada mensaje recibe el respaldo y pasa a un asesor');
      return { llm: createDisabledLlm(), model: 'ninguno' };
    case 'gemini':
      if (!env.GEMINI_API_KEY) throw new Error('AI_PROVIDER=gemini necesita GEMINI_API_KEY');
      log.warn(
        'Gemini en capa gratuita: Google puede usar y revisar lo enviado. Úsalo solo con datos ficticios (simulador), nunca con clientes reales',
      );
      return {
        llm: createOpenAiCompatibleLlm({
          baseUrl: GEMINI_OPENAI_BASE_URL,
          apiKey: env.GEMINI_API_KEY.trim(),
          sendReasoningEffort: true,
          fallbackModels: fallbackModels ?? GEMINI_DEFAULT_FALLBACK_MODELS,
        }),
        model: env.AI_MODEL ?? GEMINI_DEFAULT_MODEL,
      };
    case 'openai-compatible':
      if (!env.AI_BASE_URL || !env.AI_MODEL) throw new Error('AI_PROVIDER=openai-compatible necesita AI_BASE_URL y AI_MODEL');
      return {
        llm: createOpenAiCompatibleLlm({ baseUrl: env.AI_BASE_URL, apiKey: env.AI_API_KEY?.trim() || 'sin-clave', fallbackModels: fallbackModels ?? [] }),
        model: env.AI_MODEL,
      };
    case 'anthropic':
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        log.warn('No hay ANTHROPIC_API_KEY: si el SDK no encuentra otra credencial, cada turno responderá con el respaldo');
      }
      return { llm: createAnthropicLlm(), model: env.AI_MODEL ?? 'claude-opus-5-5' };
  }
}
const pool = createPool(env.DATABASE_URL);
const masterKey = parseMasterKey(env.ENCRYPTION_MASTER_KEY);
const { llm, model } = buildLlm();
// BullMQ exige maxRetriesPerRequest: null en las conexiones de los workers.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const inboundQueue = new Queue<InboundJobData>(QUEUES.inbound, { connection });
const brainQueue = new Queue<BrainJobData>(QUEUES.brain, { connection });
const outboundQueue = new Queue<OutboundJobData>(QUEUES.outbound, { connection });

const inboundWorker = new Worker<InboundJobData>(
  QUEUES.inbound,
  async (job) => {
    const outcome = await processInboundEvent(pool, job.data.webhookEventId);
    log.info({ webhookEventId: job.data.webhookEventId, outcome: outcome.result }, 'evento procesado');
    if (outcome.result === 'message' && !outcome.duplicate && outcome.mode === 'bot') {
      // La espera agrupa ráfagas de mensajes; si llega otro, este turno se descarta solo.
      await brainQueue.add(
        'turn',
        { tenantId: outcome.tenantId, conversationId: outcome.conversationId, triggerMessageId: outcome.messageId },
        {
          jobId: `${outcome.conversationId}-${outcome.messageId}`,
          delay: BRAIN_DEBOUNCE_MS,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );
    }
    return outcome;
  },
  { connection, concurrency: env.WORKER_CONCURRENCY },
);

const brainWorker = new Worker<BrainJobData>(
  QUEUES.brain,
  async (job) => {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const outcome = await processBrainJob({ pool, llm, finalAttempt, config: { model, effort: env.AI_EFFORT } }, job.data);
    log.info({ conversationId: job.data.conversationId, outcome }, 'turno del bot');
    if (outcome.result === 'replied') {
      await outboundQueue.add(
        'send',
        { tenantId: job.data.tenantId, outboundMessageIds: outcome.outboundMessageIds },
        { jobId: outcome.outboundMessageId, attempts: 5, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 1000 },
      );
    }
    return outcome;
  },
  { connection, concurrency: env.WORKER_CONCURRENCY },
);

const outboundWorker = new Worker<OutboundJobData>(
  QUEUES.outbound,
  async (job) => {
    const outcome = await processOutbound(
      {
        pool,
        masterKey,
        graphApiVersion: env.META_GRAPH_API_VERSION,
        ...(env.META_GRAPH_BASE_URL ? { graphBaseUrl: env.META_GRAPH_BASE_URL } : {}),
      },
      job.data,
    );
    log.info({ outboundMessageIds: job.data.outboundMessageIds, outcome: outcome.map((o) => o.result) }, 'envío procesado');
    return outcome;
  },
  { connection, concurrency: env.WORKER_CONCURRENCY },
);

for (const [name, worker] of [
  ['inbound', inboundWorker],
  ['brain', brainWorker],
  ['outbound', outboundWorker],
] as const) {
  worker.on('failed', (job, err) => log.error({ queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'falló un job'));
}

/** Recupera eventos guardados que no llegaron a la cola o que quedaron tomados por un worker caído. */
async function sweep() {
  try {
    const ids = await reclaimStaleWebhookEvents(pool, {
      receivedOlderThanMs: 2 * 60_000,
      processingOlderThanMs: 5 * 60_000,
      limit: 500,
    });
    for (const id of ids) {
      await inboundQueue.add(
        'event',
        { webhookEventId: id },
        { jobId: `${id}-sweep-${Date.now()}`, attempts: INBOUND_MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000 },
      );
    }
    if (ids.length) log.warn({ count: ids.length }, 'eventos reencolados por el barrido');
  } catch (err) {
    log.error({ err: (err as Error).message }, 'falló el barrido');
  }
}
const sweepTimer = setInterval(sweep, 60_000);
void sweep();

const shutdown = async () => {
  clearInterval(sweepTimer);
  await Promise.all([inboundWorker.close(), brainWorker.close(), outboundWorker.close()]);
  await Promise.all([inboundQueue.close(), brainQueue.close(), outboundQueue.close()]);
  connection.disconnect();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log.info(
  { concurrency: env.WORKER_CONCURRENCY, provider: env.AI_PROVIDER, ...(env.AI_PROVIDER !== 'none' ? { model, effort: env.AI_EFFORT } : {}) },
  'workers iniciados',
);
