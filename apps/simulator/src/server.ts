import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signMetaPayload } from '@zenith/channel-whatsapp';

/**
 * Simulador local del bot. Hace dos papeles:
 * 1. Cliente: arma un webhook de WhatsApp como lo haría Meta, lo firma y lo manda al gateway.
 * 2. Meta: recibe los envíos del worker (apuntando META_GRAPH_BASE_URL aquí) y se los muestra
 *    al navegador por SSE. También devuelve los estados "entregado" y "leído".
 * Todo el resto del sistema (gateway, colas, worker, BD, ventana de 24 h) es el real.
 */
export interface SimulatorDeps {
  gatewayUrl: string;
  metaAppSecret: string;
  phoneNumberId: string;
  fetch?: typeof fetch;
  /** Retardo de los estados simulados; 0 en pruebas. */
  statusDelayMs?: number;
}

export interface BotMessage {
  id: string;
  to: string;
  text: string;
  at: string;
}

const sendSchema = z.object({
  from: z.string().regex(/^\d{8,15}$/, 'Número inválido'),
  name: z.string().trim().min(1).max(60),
  text: z.string().trim().min(1).max(4096),
});

const graphBodySchema = z.object({
  messaging_product: z.literal('whatsapp'),
  to: z.string().min(1),
  type: z.literal('text'),
  text: z.object({ body: z.string() }),
});

const UI_PATH = new URL('../public/index.html', import.meta.url);

export function buildSimulator(deps: SimulatorDeps): FastifyInstance & { botMessages: BotMessage[] } {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const doFetch = deps.fetch ?? fetch;
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const botMessages: BotMessage[] = [];
  let seq = 0;

  async function postWebhook(payload: unknown): Promise<number> {
    const raw = JSON.stringify(payload);
    const res = await doFetch(new URL('/webhooks/meta/whatsapp', deps.gatewayUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMetaPayload(raw, deps.metaAppSecret) },
      body: raw,
    });
    return res.status;
  }

  const envelope = (value: Record<string, unknown>) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'SIMULADOR',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: 'simulador', phone_number_id: deps.phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  });

  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(await readFile(UI_PATH, 'utf8')));

  // ---------------------------------------------------------------- papel de cliente

  app.post('/api/send', async (req, reply) => {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_input', message: parsed.error.issues[0]?.message ?? 'Datos inválidos' } });
    }
    const { from, name, text } = parsed.data;
    const id = `wamid.SIM${Date.now()}${++seq}`;
    let status: number;
    try {
      status = await postWebhook(
        envelope({
          contacts: [{ profile: { name }, wa_id: from }],
          messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
        }),
      );
    } catch {
      return reply.code(502).send({ error: { code: 'gateway_unreachable', message: `No se pudo conectar con el gateway en ${deps.gatewayUrl}` } });
    }
    if (status !== 200) {
      return reply.code(502).send({ error: { code: 'gateway_rejected', message: `El gateway respondió ${status}` } });
    }
    return { ok: true, id };
  });

  /** Mensajes del bot para un cliente, en vivo (Server-Sent Events). */
  app.get<{ Querystring: { to?: string } }>('/api/stream', (req, reply) => {
    const to = req.query.to ?? '';
    if (!/^\d{8,15}$/.test(to)) {
      void reply.code(400).send({ error: { code: 'invalid_input', message: 'Número inválido' } });
      return;
    }
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // Un primer comentario abre el stream de inmediato en el navegador.
    reply.raw.write(': conectado\n\n');
    const push = (m: BotMessage) => {
      if (m.to === to) reply.raw.write(`data: ${JSON.stringify(m)}\n\n`);
    };
    bus.on('bot', push);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('bot', push);
    });
  });

  // ---------------------------------------------------------------- papel de Meta (Graph API)

  app.post<{ Params: { version: string; phoneNumberId: string } }>('/:version/:phoneNumberId/messages', async (req, reply) => {
    if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) {
      return reply.code(401).send({ error: { code: 190, message: 'Falta el token de acceso' } });
    }
    if (req.params.phoneNumberId !== deps.phoneNumberId) {
      return reply.code(400).send({ error: { code: 100, message: 'phone_number_id desconocido' } });
    }
    const parsed = graphBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 100, message: 'Cuerpo inválido' } });

    const message: BotMessage = { id: `wamid.BOT${Date.now()}${++seq}`, to: parsed.data.to, text: parsed.data.text.body, at: new Date().toISOString() };
    botMessages.push(message);
    bus.emit('bot', message);

    // Como Meta: después del envío llegan los estados por webhook.
    const delay = deps.statusDelayMs ?? 400;
    for (const [i, state] of (['delivered', 'read'] as const).entries()) {
      setTimeout(() => {
        void postWebhook(
          envelope({ statuses: [{ id: message.id, status: state, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: message.to }] }),
        ).catch(() => undefined);
      }, delay * (i + 1));
    }

    return { messaging_product: 'whatsapp', contacts: [{ input: message.to, wa_id: message.to }], messages: [{ id: message.id }] };
  });

  return Object.assign(app, { botMessages });
}
