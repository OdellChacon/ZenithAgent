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
  /**
   * Plantillas "aprobadas" en esta cuenta simulada. Como Meta, el simulador guarda el texto y
   * los botones; el worker solo manda el nombre y los parámetros.
   */
  templates?: Record<string, SimTemplate>;
}

export interface SimTemplate {
  language: string;
  body: string;
  buttons?: string[];
}

export interface BotMessage {
  id: string;
  to: string;
  /** Texto, o pie de foto si es una imagen. */
  text: string;
  /** Ruta para ver la imagen en el navegador, si el mensaje es una foto. */
  image?: string;
  /** Botones de respuesta rápida, si el mensaje es una plantilla que los tiene. */
  buttons?: string[];
  /** Lo escribió un asesor desde la app del negocio, no el bot. */
  fromAgent?: boolean;
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
  button: z.boolean().optional(),
});

const agentReplySchema = z.object({
  to: z.string().regex(/^\d{8,15}$/, 'Número inválido'),
  text: z.string().trim().min(1).max(4096),
});

const readSchema = z.object({
  messaging_product: z.literal('whatsapp'),
  status: z.literal('read'),
  message_id: z.string().min(1),
  typing_indicator: z.object({ type: z.literal('text') }).optional(),
});

const graphBodySchema = z.discriminatedUnion('type', [
  z.object({ messaging_product: z.literal('whatsapp'), to: z.string().min(1), type: z.literal('text'), text: z.object({ body: z.string() }) }),
  z.object({
    messaging_product: z.literal('whatsapp'),
    to: z.string().min(1),
    type: z.literal('image'),
    image: z.object({ id: z.string().min(1), caption: z.string().optional() }),
  }),
  z.object({
    messaging_product: z.literal('whatsapp'),
    to: z.string().min(1),
    type: z.literal('template'),
    template: z.object({
      name: z.string().min(1),
      language: z.object({ code: z.string().min(1) }),
      components: z
        .array(z.object({ type: z.string(), parameters: z.array(z.object({ type: z.literal('text'), text: z.string() })).optional() }))
        .optional(),
    }),
  }),
]);

/** Arma el texto de una plantilla como lo vería el cliente. null si los parámetros no calzan. */
export function renderSimTemplate(template: SimTemplate, params: string[]): string | null {
  const needed = new Set([...template.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
  if (needed.size !== params.length || params.some((p) => !p.trim())) return null;
  return template.body.replace(/\{\{(\d+)\}\}/g, (_w, n: string) => params[Number(n) - 1]!);
}

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
  /** Mensajes que mandó cada cliente (wamid → número), para aceptar el "leído" como Meta. */
  const inbound = new Map<string, string>();
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

  const envelope = (value: Record<string, unknown>, field = 'messages') => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'SIMULADOR',
        changes: [
          {
            field,
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

  /** Texto del cliente, o el toque de un botón de plantilla (button: true), como los manda Meta. */
  app.post('/api/send', async (req, reply) => {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_input', message: parsed.error.issues[0]?.message ?? 'Datos inválidos' } });
    }
    const { from, name, text, button } = parsed.data;
    const id = `wamid.SIM${Date.now()}${++seq}`;
    inbound.set(id, from);
    const content = button ? { type: 'button', button: { text, payload: text } } : { type: 'text', text: { body: text } };
    let status: number;
    try {
      status = await postWebhook(
        envelope({
          contacts: [{ profile: { name }, wa_id: from }],
          messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), ...content }],
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

  // ---------------------------------------------------------------- papel de asesor en la app

  /**
   * Un asesor responde desde la app de WhatsApp Business del negocio (coexistencia): el cliente
   * recibe el mensaje y Meta le manda al sistema una copia (smb_message_echoes).
   */
  app.post('/api/agent-reply', async (req, reply) => {
    const parsed = agentReplySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_input', message: parsed.error.issues[0]?.message ?? 'Datos inválidos' } });
    }
    const { to, text } = parsed.data;
    const id = `wamid.SIMAPP${Date.now()}${++seq}`;
    const at = new Date();
    let status: number;
    try {
      status = await postWebhook(
        envelope(
          {
            contacts: [{ wa_id: to }],
            message_echoes: [
              { from: 'simulador', to, id, timestamp: String(Math.floor(at.getTime() / 1000)), type: 'text', text: { body: text } },
            ],
          },
          'smb_message_echoes',
        ),
      );
    } catch {
      return reply.code(502).send({ error: { code: 'gateway_unreachable', message: `No se pudo conectar con el gateway en ${deps.gatewayUrl}` } });
    }
    if (status !== 200) {
      return reply.code(502).send({ error: { code: 'gateway_rejected', message: `El gateway respondió ${status}` } });
    }
    const message: BotMessage = { id, to, text, fromAgent: true, at: at.toISOString() };
    bus.emit('bot', message);
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
    inbound.set(id, from);
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
    // "Leído" + "escribiendo…": evento con nombre propio, para no mezclarlo con los mensajes.
    const read = (r: { to: string; typing: boolean }) => {
      if (r.to === to) reply.raw.write(`event: read\ndata: ${JSON.stringify(r)}\n\n`);
    };
    bus.on('bot', push);
    bus.on('read', read);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('bot', push);
      bus.off('read', read);
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
    // Marcar como leído (con "escribiendo…" opcional), como POST /messages con status "read".
    const readBody = readSchema.safeParse(req.body);
    if (readBody.success) {
      const to = inbound.get(readBody.data.message_id);
      if (!to) return reply.code(400).send({ error: { code: 131009, message: 'Parameter value is not valid' } });
      bus.emit('read', { to, typing: readBody.data.typing_indicator?.type === 'text' });
      return { success: true };
    }
    const parsed = graphBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 100, message: 'Cuerpo inválido' } });
    const body = parsed.data;
    if (body.type === 'image' && !media.has(body.image.id)) {
      return reply.code(400).send({ error: { code: 131053, message: 'Id de archivo desconocido' } });
    }

    let text: string;
    let buttons: string[] | undefined;
    if (body.type === 'template') {
      // Como Meta: la plantilla tiene que existir aprobada en ese idioma y con sus parámetros.
      const tpl = deps.templates?.[body.template.name];
      if (!tpl || tpl.language !== body.template.language.code) {
        return reply.code(404).send({ error: { code: 132001, message: 'La plantilla no existe en ese idioma' } });
      }
      const params = (body.template.components ?? []).find((c) => c.type === 'body')?.parameters?.map((p) => p.text) ?? [];
      const rendered = renderSimTemplate(tpl, params);
      if (rendered === null) {
        return reply.code(400).send({ error: { code: 132000, message: 'El número de parámetros no coincide con la plantilla' } });
      }
      text = rendered;
      buttons = tpl.buttons?.length ? tpl.buttons : undefined;
    } else {
      text = body.type === 'text' ? body.text.body : (body.image.caption ?? '');
    }

    const message: BotMessage = {
      id: `wamid.BOT${Date.now()}${++seq}`,
      to: body.to,
      text,
      ...(body.type === 'image' ? { image: `/sim-media/${encodeURIComponent(body.image.id)}` } : {}),
      ...(buttons ? { buttons } : {}),
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

  // ---------------------------------------------------------------- papel de Meta: conexión del número

  /**
   * Registro insertado (Embedded Signup) contra el simulador: canje del código, suscripción,
   * registro y pedido de contactos e historial. Como Meta, cada sincronización se acepta una
   * sola vez; el historial llega después como webhook, con chats ficticios.
   */
  const synced = new Set<string>();
  const bearer = (auth: string | undefined) => /^Bearer \S+$/.test(auth ?? '');
  const badVersion = (v: string) => !/^v\d+\.\d+$/.test(v);

  app.get<{ Params: { version: string }; Querystring: Record<string, string | undefined> }>('/:version/oauth/access_token', async (req, reply) => {
    if (badVersion(req.params.version)) return reply.code(404).send({ error: { code: 'not_found', message: 'No existe' } });
    const { client_id, client_secret, code } = req.query;
    if (!client_id || !client_secret || !code) return reply.code(400).send({ error: { code: 100, message: 'Faltan parámetros' } });
    return { access_token: `SIM-TOKEN-${Date.now()}`, token_type: 'bearer' };
  });

  app.post<{ Params: { version: string; id: string } }>('/:version/:id/subscribed_apps', async (req, reply) => {
    if (badVersion(req.params.version) || !bearer(req.headers.authorization)) return reply.code(401).send({ error: { code: 190, message: 'Token inválido' } });
    return { success: true };
  });

  app.post<{ Params: { version: string; id: string } }>('/:version/:id/register', async (req, reply) => {
    if (badVersion(req.params.version) || !bearer(req.headers.authorization)) return reply.code(401).send({ error: { code: 190, message: 'Token inválido' } });
    return { success: true };
  });

  app.post<{ Params: { version: string; id: string }; Body: { sync_type?: string } }>('/:version/:id/smb_app_data', async (req, reply) => {
    if (badVersion(req.params.version) || !bearer(req.headers.authorization)) return reply.code(401).send({ error: { code: 190, message: 'Token inválido' } });
    const type = req.body?.sync_type;
    if (type !== 'smb_app_state_sync' && type !== 'history') return reply.code(400).send({ error: { code: 100, message: 'sync_type inválido' } });
    if (req.params.id !== deps.phoneNumberId) return reply.code(400).send({ error: { code: 100, message: 'phone_number_id desconocido' } });
    if (synced.has(type)) return reply.code(400).send({ error: { code: 100, message: 'Esta sincronización ya se pidió' } });
    synced.add(type);
    if (type === 'history') setTimeout(() => void postWebhook(simulatedHistory()).catch(() => undefined), deps.statusDelayMs ?? 1000);
    return { messaging_product: 'whatsapp', request_id: `sim-${type}-${Date.now()}` };
  });

  /** Dos chats ficticios de hace semanas, como los mandaría Meta tras conectar el número. */
  function simulatedHistory() {
    const now = Math.floor(Date.now() / 1000);
    const day = 86_400;
    const thread = (phone: string, msgs: [boolean, number, string][]) => ({
      id: phone,
      context: { wa_id: phone },
      messages: msgs.map(([business, ago, body], i) => ({
        from: business ? 'simulador' : phone,
        ...(business ? {} : { from_user_id: `VE.${phone}` }),
        id: `wamid.SIMHIST${phone}${i}`,
        timestamp: String(now - ago),
        type: 'text',
        text: { body },
        history_context: { status: 'READ' },
      })),
    });
    return envelope(
      {
        history: [
          {
            metadata: { phase: 1, chunk_order: 1, progress: 100 },
            threads: [
              thread('584247770001', [
                [false, 21 * day, 'Buenas, ¿tienen cerámica para baño en tono beige?'],
                [true, 21 * day - 600, 'Buenas tardes. Sí, tenemos varias opciones en beige. ¿Para piso o pared?'],
                [false, 21 * day - 900, 'Para pared, unos 12 metros.'],
              ]),
              thread('584247770002', [
                [false, 40 * day, '¿Trabajan grama artificial?'],
                [true, 40 * day - 300, 'Sí, con gusto. Le paso la información por aquí.'],
              ]),
            ],
          },
        ],
      },
      'history',
    );
  }

  /** Como GET /{media_id} de Meta: devuelve la url para descargar el archivo (con el token). */
  app.get<{ Params: { version: string; mediaId: string } }>('/:version/:mediaId', async (req, reply) => {
    if (!/^v\d+\.\d+$/.test(req.params.version)) return reply.code(404).send({ error: { code: 'not_found', message: 'No existe' } });
    if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) {
      return reply.code(401).send({ error: { code: 190, message: 'Falta el token de acceso' } });
    }
    // GET /{phone_number_id}: datos del número (conexión). El número simulado "sigue en la app".
    if (req.params.mediaId === deps.phoneNumberId) {
      return {
        id: deps.phoneNumberId,
        display_phone_number: '+58 414-0000000',
        verified_name: 'Simulador IMM',
        is_on_biz_app: true,
        platform_type: 'CLOUD_API',
      };
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
