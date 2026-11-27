import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { buildSimulator, type SimTemplate } from './server.js';

const env = z
  .object({
    NODE_ENV: z.string().optional(),
    META_APP_SECRET: z.string().min(1, 'Define META_APP_SECRET (el mismo que usa el gateway)'),
    DEV_WHATSAPP_PHONE_NUMBER_ID: z.string().min(1, 'Define DEV_WHATSAPP_PHONE_NUMBER_ID (el del seed de desarrollo)'),
    SIMULATOR_PORT: z.coerce.number().int().min(1).max(65535).default(4010),
    SIMULATOR_GATEWAY_URL: z.string().url().default('http://127.0.0.1:3000'),
    DEV_MESSENGER_PAGE_ID: z.string().regex(/^\d+$/).optional().or(z.literal('')),
    DEV_INSTAGRAM_ID: z.string().regex(/^\d+$/).optional().or(z.literal('')),
  })
  .parse(process.env);

if (env.NODE_ENV === 'production') {
  console.error('El simulador es solo para desarrollo local.');
  process.exit(1);
}

// Plantillas "aprobadas" de la cuenta simulada (en Meta se aprueban en el administrador de WhatsApp).
const templates = JSON.parse(await readFile(new URL('../templates.json', import.meta.url), 'utf8')) as Record<string, SimTemplate>;

const app = buildSimulator({
  gatewayUrl: env.SIMULATOR_GATEWAY_URL,
  metaAppSecret: env.META_APP_SECRET,
  phoneNumberId: env.DEV_WHATSAPP_PHONE_NUMBER_ID,
  ...(env.DEV_MESSENGER_PAGE_ID ? { pageId: env.DEV_MESSENGER_PAGE_ID } : {}),
  ...(env.DEV_INSTAGRAM_ID ? { instagramId: env.DEV_INSTAGRAM_ID } : {}),
  templates,
});

// Solo en la máquina local: el simulador firma webhooks con el secreto de la app.
await app.listen({ host: '127.0.0.1', port: env.SIMULATOR_PORT });
console.log(`Simulador listo en http://localhost:${env.SIMULATOR_PORT}`);
console.log(`El worker debe correr con META_GRAPH_BASE_URL=http://localhost:${env.SIMULATOR_PORT}`);
