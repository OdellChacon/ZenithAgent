import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { z } from 'zod';
import { INBOUND_MAX_ATTEMPTS, QUEUES, type InboundJobData } from '@zenith/core';
import { createPool, reclaimStaleWebhookEvents } from '@zenith/db';
import { processInboundEvent } from './inbound.js';

const env = z
  .object({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL });
const pool = createPool(env.DATABASE_URL);
// BullMQ exige maxRetriesPerRequest: null en las conexiones de los workers.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const inboundQueue = new Queue<InboundJobData>(QUEUES.inbound, { connection });

const worker = new Worker<InboundJobData>(
  QUEUES.inbound,
  async (job) => {
    const outcome = await processInboundEvent(pool, job.data.webhookEventId);
    log.info({ webhookEventId: job.data.webhookEventId, outcome: outcome.result }, 'evento procesado');
    return outcome;
  },
  { connection, concurrency: env.WORKER_CONCURRENCY },
);

worker.on('failed', (job, err) => {
  log.error({ webhookEventId: job?.data.webhookEventId, attempts: job?.attemptsMade, err: err.message }, 'falló el evento');
});

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
  await worker.close();
  await inboundQueue.close();
  connection.disconnect();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log.info({ concurrency: env.WORKER_CONCURRENCY }, 'worker de entrada iniciado');
