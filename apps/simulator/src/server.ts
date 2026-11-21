import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
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
  /** Texto, o pie de foto si es una imagen. */
  text: string;
  /** Ruta para ver la imagen en el navegador, si el mensaje es una foto. */
  image?: string;
  at: string;
}

const customerSchema = z.object({
  from: z.string().regex(/^\d{8,15}$/, 'Número inválido'),
  name: z.string().trim().min(1).max(60),
  caption: z.string().trim().max(1024).optional(),
});

const sendSchema = z.object({
  from: z.string().regex(/^\d{8,15}$/, 'Número inválido'),
  name: z.string().trim().min(1).max(60),
  text: z.string().trim().min(1).max(4096),
});

const graphBodySchema = z.discriminatedUnion('type', [
  z.object({ messaging_product: z.literal('whatsapp'), to: z.string().min(1), type: z.literal('text'), text: z.object({ body: z.string() }) }),
  z.object({
    messaging_product: z.literal('whatsapp'),
    to: z.string().min(1),
    type: z.literal('image'),
    image: z.object({ id: z.string().min(1), caption: z.string().optional() }),
  }),
]);

/** Como Meta: JPEG o PNG de hasta 5 MB. */
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png']);
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

const UI_PATH = new URL('../public/index.html', import.meta.url);

export function buildSimulator(deps: SimulatorDeps): FastifyInstance & { botMessages: BotMessage[] } {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  void app.register(multipart, { limits: { fileSize: MAX_MEDIA_BYTES, files: 1, fields: 5, fieldSize: 2048 } });
  const media = new Map<string, { mime: string; data: Buffer }>();
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

  /**
   * Foto del cliente (multipart: from, name y caption antes del archivo). Queda guardada como
   * la guardaría Meta y el webhook solo lleva su id: el worker la baja por la Graph API.
   */
  app.post('/api/send-image', async (req, reply) => {
    const bad = (message: string) => reply.code(400).send({ error: { code: 'invalid_input', message } });
    let file;
    try {
      file = await req.file();
    } catch {
      return bad('Se espera multipart/form-data');
    }
    if (!file) return bad('Falta la foto');
    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch {
      return bad('La foto supera los 5 MB');
    }
    if (!MEDIA_TYPES.has(file.mimetype)) return bad('Solo JPEG o PNG');
    const field = (name: string) => {
      const f = file.fields[name];
      const one = Array.isArray(f) ? f[0] : f;
      return one && 'value' in one && typeof one.value === 'string' ? one.value : undefined;
    };
    const caption = field('caption')?.trim();
    const parsed = customerSchema.safeParse({ from: field('from'), name: field('name'), ...(caption ? { caption } : {}) });
    if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const { from, name } = parsed.data;

    const mediaId = `${Date.now()}${++seq}`;
    media.set(mediaId, { mime: file.mimetype, data });
    const id = `wamid.SIM${Date.now()}${++seq}`;
    let status: number;
    try {
      status = await postWebhook(
        envelope({
          contacts: [{ profile: { name }, wa_id: from }],
          messages: [
            {
              from,
              id,
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'image',
              image: { id: mediaId, mime_type: file.mimetype, ...(parsed.data.caption ? { caption: parsed.data.caption } : {}) },
            },
          ],
        }),
      );
    } catch {
      return reply.code(502).send({ error: { code: 'gateway_unreachable', message: `No se pudo conectar con el gateway en ${deps.gatewayUrl}` } });
    }
    if (status !== 200) {
      return reply.code(502).send({ error: { code: 'gateway_rejected', message: `El gateway respondió ${status}` } });
    }
    return { ok: true, id, image: `/sim-media/${mediaId}` };
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
    const body = parsed.data;
    if (body.type === 'image' && !media.has(body.image.id)) {
      return reply.code(400).send({ error: { code: 131053, message: 'Id de archivo desconocido' } });
    }

    const message: BotMessage = {
      id: `wamid.BOT${Date.now()}${++seq}`,
      to: body.to,
      text: body.type === 'text' ? body.text.body : (body.image.caption ?? ''),
      ...(body.type === 'image' ? { image: `/sim-media/${encodeURIComponent(body.image.id)}` } : {}),
      at: new Date().toISOString(),
    };
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

  /** Subida de archivos, como /{phone_number_id}/media de Meta. */
  app.post<{ Params: { version: string; phoneNumberId: string } }>('/:version/:phoneNumberId/media', async (req, reply) => {
    if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) {
      return reply.code(401).send({ error: { code: 190, message: 'Falta el token de acceso' } });
    }
    if (req.params.phoneNumberId !== deps.phoneNumberId) {
      return reply.code(400).send({ error: { code: 100, message: 'phone_number_id desconocido' } });
    }
    let file;
    try {
      file = await req.file();
    } catch {
      return reply.code(400).send({ error: { code: 100, message: 'Se espera multipart/form-data' } });
    }
    if (!file) return reply.code(400).send({ error: { code: 100, message: 'Falta el archivo' } });
    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch {
      return reply.code(400).send({ error: { code: 131052, message: 'El archivo supera los 5 MB' } });
    }
    if (!MEDIA_TYPES.has(file.mimetype)) {
      return reply.code(400).send({ error: { code: 131053, message: `Tipo no admitido: ${file.mimetype}` } });
    }
    const id = `${Date.now()}${++seq}`;
    media.set(id, { mime: file.mimetype, data });
    return { id };
  });

  /** Como GET /{media_id} de Meta: devuelve la url para descargar el archivo (con el token). */
  app.get<{ Params: { version: string; mediaId: string } }>('/:version/:mediaId', async (req, reply) => {
    if (!/^v\d+\.\d+$/.test(req.params.version)) return reply.code(404).send({ error: { code: 'not_found', message: 'No existe' } });
    if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) {
      return reply.code(401).send({ error: { code: 190, message: 'Falta el token de acceso' } });
    }
    const item = media.get(req.params.mediaId);
    if (!item) return reply.code(404).send({ error: { code: 100, message: 'Id de archivo desconocido' } });
    const origin = `${req.protocol}://${req.headers.host ?? 'localhost'}`;
    return {
      messaging_product: 'whatsapp',
      id: req.params.mediaId,
      url: `${origin}/sim-media/${encodeURIComponent(req.params.mediaId)}`,
      mime_type: item.mime,
      file_size: item.data.length,
    };
  });

  app.get<{ Params: { id: string } }>('/sim-media/:id', async (req, reply) => {
    const item = media.get(req.params.id);
    if (!item) return reply.code(404).send({ error: { code: 'not_found', message: 'No existe' } });
    return reply.type(item.mime).header('cache-control', 'private, max-age=3600').send(item.data);
  });

  return Object.assign(app, { botMessages });
}
