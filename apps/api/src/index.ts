import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { parseMasterKey, QUEUES, tenantEventsChannel, type OutboundJobData, type PanelEvent } from '@zenith/core';
import { createPool } from '@zenith/db';
import { buildApi } from './server.js';

const env = z
  .object({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    // true cuando el panel se sirve por https (producción).
    COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
    // Conexión de números desde el panel (Embedded Signup). Sin estos datos, el botón no aparece.
    META_APP_ID: z.string().trim().optional(),
    META_APP_SECRET: z.string().trim().optional(),
    META_ES_CONFIG_ID: z.string().trim().optional(),
    META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/, 'Usa la forma vNN.N').optional(),
    META_GRAPH_BASE_URL: z.string().url().optional().or(z.literal('')),
    ENCRYPTION_MASTER_KEY: z.string().optional(),
    ENCRYPTION_MASTER_KEY_ID: z.string().optional(),
    DEV_WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  })
  .parse(process.env);

/**
 * Con el simulador local (META_GRAPH_BASE_URL en localhost) no hace falta una app de Meta:
 * el panel conecta el número de prueba y el simulador hace de Graph API.
 */
function signupConfig() {
  const local = env.META_GRAPH_BASE_URL ? /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(env.META_GRAPH_BASE_URL) : false;
  const appId = env.META_APP_ID || (local ? 'simulador' : '');
  const configId = env.META_ES_CONFIG_ID || (local ? 'simulador' : '');
  if (!appId || !configId || !env.META_APP_SECRET || !env.META_GRAPH_API_VERSION || !env.ENCRYPTION_MASTER_KEY) return undefined;
  return {
    appId,
    appSecret: env.META_APP_SECRET,
    configId,
    graphApiVersion: env.META_GRAPH_API_VERSION,
    masterKey: parseMasterKey(env.ENCRYPTION_MASTER_KEY),
    ...(env.ENCRYPTION_MASTER_KEY_ID ? { masterKeyId: env.ENCRYPTION_MASTER_KEY_ID } : {}),
    ...(env.META_GRAPH_BASE_URL ? { graphBaseUrl: env.META_GRAPH_BASE_URL } : {}),
    ...(local && env.DEV_WHATSAPP_PHONE_NUMBER_ID ? { simulatedPhoneNumberId: env.DEV_WHATSAPP_PHONE_NUMBER_ID } : {}),
  };
}

const pool = createPool(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const outbound = new Queue<OutboundJobData>(QUEUES.outbound, { connection: redis });

// Una sola conexión de suscripción para todos los navegadores conectados.
const listeners = new Map<string, Set<(e: PanelEvent) => void>>();
subscriber.on('message', (channel: string, message: string) => {
  let event: PanelEvent;
  try {
    event = JSON.parse(message) as PanelEvent;
  } catch {
    return;
  }
  for (const listener of listeners.get(channel) ?? []) listener(event);
});

const app = buildApi({
  pool,
  secureCookies: env.COOKIE_SECURE === 'true',
  whatsappSignup: signupConfig(),
  enqueueOutbound: async (tenantId, outboundMessageIds) => {
    await outbound.add('send', { tenantId, outboundMessageIds }, {
      jobId: outboundMessageIds[0],
      attempts: 5,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: 1000,
    });
  },
  publish: async (tenantId, event) => {
    await redis.publish(tenantEventsChannel(tenantId), JSON.stringify(event)).catch(() => undefined);
  },
  subscribe: async (tenantId, onEvent) => {
    const channel = tenantEventsChannel(tenantId);
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
      await subscriber.subscribe(channel);
    }
    set.add(onEvent);
    return async () => {
      set!.delete(onEvent);
      if (!set!.size) {
        listeners.delete(channel);
        await subscriber.unsubscribe(channel).catch(() => undefined);
      }
    };
  },
});

// En producción la API también sirve el panel ya compilado (apps/panel/dist).
const panelDist = fileURLToPath(new URL('../../panel/dist', import.meta.url));
if (existsSync(panelDist)) {
  await app.register(fastifyStatic, { root: panelDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'not_found', message: 'No existe' } });
  });
}

const shutdown = async () => {
  await app.close();
  await outbound.close();
  redis.disconnect();
  subscriber.disconnect();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: '127.0.0.1', port: env.API_PORT });
console.log(`API del panel en http://localhost:${env.API_PORT}`);
