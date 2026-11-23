import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { z } from 'zod';
import {
  BRAIN_DEBOUNCE_MS,
  INBOUND_MAX_ATTEMPTS,
  parseMasterKey,
  QUEUES,
  tenantEventsChannel,
  type BrainJobData,
  type InboundJobData,
  type NotifyJobData,
  type OutboundJobData,
  type PanelEvent,
} from '@zenith/core';
import { createPool, reclaimStaleWebhookEvents } from '@zenith/db';
import { processBrainJob } from './brain-job.js';
import { processInboundEvent } from './inbound.js';
import { processOutbound } from './outbound.js';
import { processNotifyJob } from './notify.js';
import { runFollowups } from './followups.js';
import { createLogMailer, createSmtpMailer } from './mailer.js';
import { aiEnvShape, buildLlm } from './llm-provider.js';

const env = z
  .object({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    ENCRYPTION_MASTER_KEY: z.string().min(1),
    META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/, 'Usa la forma vNN.N'),
    // Solo para pruebas locales contra un simulador de Graph API.
    META_GRAPH_BASE_URL: z.string().url().optional(),
    ...aiEnvShape,
    // Avisos a los asesores.
    PANEL_URL: z.string().url().default('http://localhost:5180'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: z.enum(['true', 'false']).default('false'),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL });

const { llm, model } = buildLlm(env, (msg) => log.warn(msg));
const pool = createPool(env.DATABASE_URL);
const masterKey = parseMasterKey(env.ENCRYPTION_MASTER_KEY);
// BullMQ exige maxRetriesPerRequest: null en las conexiones de los workers.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const inboundQueue = new Queue<InboundJobData>(QUEUES.inbound, { connection });
const brainQueue = new Queue<BrainJobData>(QUEUES.brain, { connection });
const outboundQueue = new Queue<OutboundJobData>(QUEUES.outbound, { connection });
const notifyQueue = new Queue<NotifyJobData>(QUEUES.notify, { connection });

// Conexión aparte para publicar eventos al panel (las de BullMQ quedan bloqueadas esperando jobs).
const publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
async function publish(tenantId: string, event: PanelEvent) {
  try {
    await publisher.publish(tenantEventsChannel(tenantId), JSON.stringify(event));
  } catch (err) {
    // El panel en vivo es un extra: si falla, el asesor igual ve todo al recargar.
    log.warn({ err: (err as Error).message }, 'no se pudo publicar un evento al panel');
  }
}

const mailer = env.SMTP_HOST
  ? createSmtpMailer({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE === 'true',
      ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
      ...(env.SMTP_PASS ? { pass: env.SMTP_PASS } : {}),
      from: env.SMTP_FROM ?? env.SMTP_USER ?? 'ZenithAgent <no-reply@localhost>',
    })
  : createLogMailer((msg, data) => log.warn(data, msg));
if (!env.SMTP_HOST) log.warn('SMTP no configurado: los avisos por correo a los asesores solo quedan en el log');

const inboundWorker = new Worker<InboundJobData>(
  QUEUES.inbound,
  async (job) => {
    const outcome = await processInboundEvent(pool, job.data.webhookEventId);
    log.info({ webhookEventId: job.data.webhookEventId, outcome: outcome.result }, 'evento procesado');
    if (outcome.result === 'message' && !outcome.duplicate) {
      await publish(outcome.tenantId, { type: 'message.new', conversationId: outcome.conversationId, direction: 'in', author: 'customer' });
    }
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
    const outcome = await processBrainJob(
      {
        pool,
        llm,
        finalAttempt,
        config: { model, effort: env.AI_EFFORT },
        media: {
          masterKey,
          graphApiVersion: env.META_GRAPH_API_VERSION,
          ...(env.META_GRAPH_BASE_URL ? { graphBaseUrl: env.META_GRAPH_BASE_URL } : {}),
          log: (msg, data) => log.warn(data, msg),
        },
      },
      job.data,
    );
    log.info({ conversationId: job.data.conversationId, outcome }, 'turno del bot');
    if (outcome.result === 'replied') {
      await outboundQueue.add(
        'send',
        { tenantId: job.data.tenantId, outboundMessageIds: outcome.outboundMessageIds, pausesMs: outcome.pausesMs },
        { jobId: outcome.outboundMessageId, attempts: 5, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 1000 },
      );
      const { tenantId, conversationId } = job.data;
      await publish(tenantId, { type: 'message.new', conversationId, direction: 'out', author: 'bot' });
      if (outcome.handoffId) {
        await publish(tenantId, { type: 'handoff.requested', conversationId, reason: 'nuevo' });
        await notifyQueue.add(
          'handoff',
          { tenantId, conversationId, handoffId: outcome.handoffId },
          { jobId: outcome.handoffId, attempts: 5, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: 1000 },
        );
      }
    }
    return outcome;
  },
  { connection, concurrency: env.WORKER_CONCURRENCY },
);

const notifyWorker = new Worker<NotifyJobData>(
  QUEUES.notify,
  async (job) => {
    const outcome = await processNotifyJob({ pool, mailer, panelUrl: env.PANEL_URL }, job.data);
    log.info({ handoffId: job.data.handoffId, outcome }, 'aviso a asesores');
    return outcome;
  },
  { connection, concurrency: 2 },
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
  ['notify', notifyWorker],
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

/** Seguimiento a clientes que dejaron de responder (ver followups.ts). Una pasada a la vez. */
let followupsRunning = false;
async function followupTick() {
  if (followupsRunning || env.AI_PROVIDER === 'none') return;
  followupsRunning = true;
  try {
    const run = await runFollowups({
      pool,
      llm,
      model,
      effort: env.AI_EFFORT,
      log: (msg, data) => log.warn(data, msg),
    });
    for (const s of run.sent) {
      await outboundQueue.add(
        'send',
        { tenantId: s.tenantId, outboundMessageIds: [s.outboundMessageId] },
        { jobId: s.outboundMessageId, attempts: 5, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 1000 },
      );
      await publish(s.tenantId, { type: 'message.new', conversationId: s.conversationId, direction: 'out', author: 'bot' });
    }
    if (run.sent.length || run.failed) log.info({ sent: run.sent.length, skipped: run.skipped, failed: run.failed }, 'seguimientos');
  } catch (err) {
    log.error({ err: (err as Error).message }, 'falló la pasada de seguimientos');
  } finally {
    followupsRunning = false;
  }
}
const followupTimer = setInterval(followupTick, 60_000);

const shutdown = async () => {
  clearInterval(sweepTimer);
  clearInterval(followupTimer);
  await Promise.all([inboundWorker.close(), brainWorker.close(), outboundWorker.close(), notifyWorker.close()]);
  await Promise.all([inboundQueue.close(), brainQueue.close(), outboundQueue.close(), notifyQueue.close()]);
  connection.disconnect();
  publisher.disconnect();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log.info(
  { concurrency: env.WORKER_CONCURRENCY, provider: env.AI_PROVIDER, ...(env.AI_PROVIDER !== 'none' ? { model, effort: env.AI_EFFORT } : {}) },
  'workers iniciados',
);
