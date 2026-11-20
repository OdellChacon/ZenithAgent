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
import { createAnthropicLlm } from '@zenith/brain';
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
    AI_MODEL: z.string().min(1).default('claude-opus-5-5'),
    AI_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL });
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  log.warn('No hay ANTHROPIC_API_KEY: si el SDK no encuentra otra credencial, cada turno responderá con el mensaje de respaldo y derivará a un asesor');
}
const pool = createPool(env.DATABASE_URL);
const masterKey = parseMasterKey(env.ENCRYPTION_MASTER_KEY);
const llm = createAnthropicLlm();
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
    const outcome = await processBrainJob({ pool, llm, config: { model: env.AI_MODEL, effort: env.AI_EFFORT } }, job.data);
    log.info({ conversationId: job.data.conversationId, outcome }, 'turno del bot');
    if (outcome.result === 'replied') {
      await outboundQueue.add(
        'send',
        { tenantId: job.data.tenantId, outboundMessageId: outcome.outboundMessageId },
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
    log.info({ outboundMessageId: job.data.outboundMessageId, outcome: outcome.result }, 'envío procesado');
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

log.info({ concurrency: env.WORKER_CONCURRENCY, model: env.AI_MODEL, effort: env.AI_EFFORT }, 'workers iniciados');
