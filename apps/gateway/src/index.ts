import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { INBOUND_MAX_ATTEMPTS, QUEUES, type InboundJobData } from '@zenith/core';
import { createPool, insertWebhookEvent } from '@zenith/db';
import { loadGatewayConfig } from './config.js';
import { buildGateway } from './server.js';

const config = loadGatewayConfig();
const pool = createPool(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
const inbound = new Queue<InboundJobData>(QUEUES.inbound, { connection: redis });

const app = buildGateway(
  {
    metaAppSecret: config.META_APP_SECRET,
    metaVerifyToken: config.META_WEBHOOK_VERIFY_TOKEN,
    saveEvent: (event, payload) => insertWebhookEvent(pool, event, payload),
    enqueue: async (webhookEventId) => {
      await inbound.add(
        'event',
        { webhookEventId },
        {
          jobId: webhookEventId,
          attempts: INBOUND_MAX_ATTEMPTS,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );
    },
    checkReady: async () => {
      await pool.query('SELECT 1');
      await redis.ping();
    },
  },
  {
    logger: {
      level: config.LOG_LEVEL,
      // Nunca se registran cuerpos ni cabeceras de firma.
      redact: ['req.headers["x-hub-signature-256"]', 'req.headers.authorization'],
    },
  },
);

const shutdown = async () => {
  await app.close();
  await inbound.close();
  redis.disconnect();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: '0.0.0.0', port: config.GATEWAY_PORT });
