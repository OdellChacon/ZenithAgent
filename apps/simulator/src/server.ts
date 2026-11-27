import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { signMetaPayload } from '@zenith/channel-whatsapp';

/**
 * Simulador local del bot. Hace dos papeles:
 * 1. Cliente: arma un webhook de WhatsApp, Messenger o Instagram como lo haría Meta, lo firma y
 *    lo manda al gateway.
 * 2. Meta: recibe los envíos del worker (apuntando META_GRAPH_BASE_URL aquí) por la Cloud API
 *    de WhatsApp o por la Send API de la página, y se los muestra al navegador por SSE. También
 *    devuelve los estados "entregado" y "leído".
 * Todo el resto del sistema (gateway, colas, worker, BD, ventanas de mensajería) es el real.
 */
export type SimChannel = 'whatsapp' | 'messenger' | 'instagram';
export interface SimulatorDeps {
  gatewayUrl: string;
  metaAppSecret: string;
  phoneNumberId: string;
  /** Página de Facebook simulada (Messenger) y cuenta de Instagram vinculada. */
  pageId?: string;
  instagramId?: string;
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
  /** MARKETING o UTILITY, como la clasifica Meta. */
  category?: string;
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
  /** Video o documento que mandó un asesor desde el panel. */
  file?: { url: string; name: string; kind: 'video' | 'document' };
  /** Canal por el que salió. */
  channel?: SimChannel;
  at: string;
}

export const SIM_PAGE_ID = '100000000000777';
export const SIM_INSTAGRAM_ID = '17841400000000777';
const channelSchema = z.enum(['whatsapp', 'messenger', 'instagram']).default('whatsapp');

const customerSchema = z.object({
  from: z.string().regex(/^\d{8,15}$/, 'Número inválido'),
  name: z.string().trim().min(1).max(60),
  caption: z.string().trim().max(1024).optional(),
  channel: channelSchema,
});

const sendSchema = z.object({
  from: z.string().regex(/^\d{8,15}$/, 'Número inválido'),
  name: z.string().trim().min(1).max(60),
  text: z.string().trim().min(1).max(4096),
  button: z.boolean().optional(),
  channel: channelSchema,
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
    type: z.literal('video'),
    video: z.object({ id: z.string().min(1), caption: z.string().optional() }),
  }),
  z.object({
    messaging_product: z.literal('whatsapp'),
    to: z.string().min(1),
    type: z.literal('document'),
    document: z.object({ id: z.string().min(1), caption: z.string().optional(), filename: z.string().optional() }),
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

/** Fotos del cliente: como Meta, JPEG o PNG de hasta 5 MB. */
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png']);
/** Lo que puede subir el worker (fotos del catálogo y archivos de los asesores). */
const UPLOAD_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'video/mp4',
  'video/3gpp',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
/** Notas de voz que acepta el simulador (WhatsApp las manda en ogg/opus). */
const AUDIO_TYPES = new Set(['audio/ogg', 'audio/mpeg', 'audio/webm']);

/**
 * Chrome graba las notas de voz en webm/opus; WhatsApp las manda en ogg/opus. El simulador
 * cambia el contenedor (sin recodificar) para que el negocio reciba lo mismo que con Meta.
 */
function webmToOgg(data: Buffer, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ffmpegPath, ['-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'copy', '-f', 'ogg', 'pipe:1'], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    const out: Buffer[] = [];
    const timer = setTimeout(() => proc.kill('SIGKILL'), 15_000);
    proc.stdout.on('data', (c: Buffer) => out.push(c));
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.length ? Buffer.concat(out) : null);
    });
    proc.stdin.on('error', () => undefined);
    proc.stdin.end(data);
  });
}

const sharedSchema = z
  .object({
    from: z.string().regex(/^\d{8,15}$/, 'Número inválido'),
    name: z.string().trim().min(1).max(60),
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        name: z.string().trim().max(200).optional(),
        address: z.string().trim().max(300).optional(),
      })
      .optional(),
    contact: z.object({ name: z.string().trim().min(1).max(120), phone: z.string().trim().min(6).max(30) }).optional(),
  })
  .refine((v) => Boolean(v.location) !== Boolean(v.contact), 'Manda una ubicación o un contacto');
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const UI_PATH = new URL('../public/index.html', import.meta.url);

export function buildSimulator(deps: SimulatorDeps): FastifyInstance & { botMessages: BotMessage[] } {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  void app.register(multipart, { limits: { fileSize: MAX_MEDIA_BYTES, files: 1, fields: 5, fieldSize: 2048 } });
  const media = new Map<string, { mime: string; data: Buffer }>();
  const doFetch = deps.fetch ?? fetch;
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const botMessages: BotMessage[] = [];
  const pageId = deps.pageId ?? SIM_PAGE_ID;
  const instagramId = deps.instagramId ?? SIM_INSTAGRAM_ID;
  /** Clientes de Messenger e Instagram (PSID o IGSID → canal y nombre), para estados y perfil. */
  const metaUsers = new Map<string, { channel: 'messenger' | 'instagram'; name: string }>();
  const uploads = new Map<string, { mime: string; name: string }>();
  /** Mensajes que mandó cada cliente (wamid → número), para aceptar el "leído" como Meta. */
  const inbound = new Map<string, string>();
  let seq = 0;

  async function postWebhook(payload: unknown, channel: SimChannel = 'whatsapp'): Promise<number> {
    const raw = JSON.stringify(payload);
    const res = await doFetch(new URL(`/webhooks/meta/${channel}`, deps.gatewayUrl), {
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

  // Sin caché: así el navegador siempre carga la última versión de la página del simulador.
  app.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(await readFile(UI_PATH, 'utf8')),
  );

  // ---------------------------------------------------------------- papel de cliente

  /** Texto del cliente, o el toque de un botón de plantilla (button: true), como los manda Meta. */
  app.post('/api/send', async (req, reply) => {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_input', message: parsed.error.issues[0]?.message ?? 'Datos inválidos' } });
    }
    const { from, name, text, button, channel } = parsed.data;
    const id = channel === 'whatsapp' ? `wamid.SIM${Date.now()}${++seq}` : `m_SIM${Date.now()}${++seq}`;
    inbound.set(id, from);
    if (channel !== 'whatsapp') {
      return sendCustomerWebhook(reply, from, name, id, button ? { postback: { title: text, payload: text, mid: id } } : { text }, channel);
    }
    const content = button ? { type: 'button', button: { text, payload: text } } : { type: 'text', text: { body: text } };
    return sendCustomerWebhook(reply, from, name, id, content);
  });

  /**
   * Nota de voz del cliente (multipart: from y name antes del archivo ogg/opus o mp3). Como Meta,
   * el webhook solo lleva el id y el worker la baja por la Graph API.
   */
  app.post('/api/send-audio', async (req, reply) => {
    const bad = (message: string) => reply.code(400).send({ error: { code: 'invalid_input', message } });
    let file;
    try {
      file = await req.file();
    } catch {
      return bad('Se espera multipart/form-data');
    }
    if (!file) return bad('Falta el audio');
    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch {
      return bad('El audio supera los 5 MB');
    }
    let mime = file.mimetype.split(';')[0]!.trim();
    if (!AUDIO_TYPES.has(mime)) return bad('Solo audio ogg, webm o mp3');
    if (mime === 'audio/webm') {
      const ogg = await webmToOgg(data);
      if (!ogg) return bad('No se pudo convertir la nota de voz (¿está instalado ffmpeg?)');
      data = ogg;
      mime = 'audio/ogg';
    }
    const field = (name: string) => {
      const f = file.fields[name];
      const one = Array.isArray(f) ? f[0] : f;
      return one && 'value' in one && typeof one.value === 'string' ? one.value : undefined;
    };
    const parsed = customerSchema.safeParse({ from: field('from'), name: field('name'), channel: field('channel') });
    if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const { from, name, channel } = parsed.data;
    const mediaId = `${Date.now()}${++seq}`;
    media.set(mediaId, { mime, data });
    const id = channel === 'whatsapp' ? `wamid.SIM${Date.now()}${++seq}` : `m_SIM${Date.now()}${++seq}`;
    inbound.set(id, from);
    if (channel !== 'whatsapp') {
      // Messenger e Instagram mandan la url del archivo en su CDN, no un id.
      return sendCustomerWebhook(reply, from, name, id, { attachments: [{ type: 'audio', payload: { url: mediaUrl(req, mediaId) } }] }, channel);
    }
    return sendCustomerWebhook(reply, from, name, id, {
      type: 'audio',
      audio: { id: mediaId, mime_type: mime === 'audio/ogg' ? 'audio/ogg; codecs=opus' : mime, voice: true },
    });
  });

  /** Ubicación o tarjeta de contacto del cliente, con la forma de Meta. */
  app.post('/api/send-shared', async (req, reply) => {
    const parsed = sharedSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_input', message: parsed.error.issues[0]?.message ?? 'Datos inválidos' } });
    }
    const { from, name, location, contact } = parsed.data;
    const id = `wamid.SIM${Date.now()}${++seq}`;
    inbound.set(id, from);
    const content = location
      ? { type: 'location', location }
      : { type: 'contacts', contacts: [{ name: { formatted_name: contact!.name, first_name: contact!.name.split(' ')[0] }, phones: [{ phone: contact!.phone, wa_id: contact!.phone.replace(/\D/g, ''), type: 'CELL' }] }] };
    return sendCustomerWebhook(reply, from, name, id, content);
  });

  /** Url pública de un archivo del simulador (Messenger e Instagram mandan urls, no ids). */
  const mediaUrl = (req: import('fastify').FastifyRequest, mediaId: string) =>
    `${req.protocol}://${req.headers.host ?? 'localhost'}/sim-media/${encodeURIComponent(mediaId)}`;

  /** Webhook de Messenger (object "page") o Instagram (object "instagram") con un evento de mensajería. */
  const metaEnvelope = (channel: 'messenger' | 'instagram', event: Record<string, unknown>) => {
    const account = channel === 'messenger' ? pageId : instagramId;
    return {
      object: channel === 'messenger' ? 'page' : 'instagram',
      entry: [{ id: account, time: Date.now(), messaging: [{ recipient: { id: account }, timestamp: Date.now(), ...event }] }],
    };
  };

  async function sendCustomerWebhook(
    reply: import('fastify').FastifyReply,
    from: string,
    name: string,
    id: string,
    content: Record<string, unknown>,
    channel: SimChannel = 'whatsapp',
  ) {
    let status: number;
    try {
      if (channel !== 'whatsapp') {
        metaUsers.set(from, { channel, name });
        const event = 'postback' in content ? { sender: { id: from }, ...content } : { sender: { id: from }, message: { mid: id, ...content } };
        status = await postWebhook(metaEnvelope(channel, event), channel);
      } else {
        status = await postWebhook(
          envelope({
            contacts: [{ profile: { name }, wa_id: from }],
            messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), ...content }],
          }),
        );
      }
    } catch {
      return reply.code(502).send({ error: { code: 'gateway_unreachable', message: `No se pudo conectar con el gateway en ${deps.gatewayUrl}` } });
    }
    if (status !== 200) return reply.code(502).send({ error: { code: 'gateway_rejected', message: `El gateway respondió ${status}` } });
    return { ok: true, id };
  }

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
    const parsed = customerSchema.safeParse({ from: field('from'), name: field('name'), channel: field('channel'), ...(caption ? { caption } : {}) });
    if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const { from, name, channel } = parsed.data;

    const mediaId = `${Date.now()}${++seq}`;
    media.set(mediaId, { mime: file.mimetype, data });
    const id = channel === 'whatsapp' ? `wamid.SIM${Date.now()}${++seq}` : `m_SIM${Date.now()}${++seq}`;
    inbound.set(id, from);
    const content =
      channel === 'whatsapp'
        ? { type: 'image', image: { id: mediaId, mime_type: file.mimetype, ...(parsed.data.caption ? { caption: parsed.data.caption } : {}) } }
        : { attachments: [{ type: 'image', payload: { url: mediaUrl(req, mediaId) } }], ...(parsed.data.caption ? { text: parsed.data.caption } : {}) };
    const sent = await sendCustomerWebhook(reply, from, name, id, content, channel);
    return 'ok' in (sent as object) ? { ok: true, id, image: `/sim-media/${mediaId}` } : sent;
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
    if (req.params.phoneNumberId === pageId) return pageSend(req.body, reply);
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
    const mediaRef = body.type === 'image' ? body.image : body.type === 'video' ? body.video : body.type === 'document' ? body.document : null;
    if (mediaRef && !media.has(mediaRef.id)) {
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
      text = body.type === 'text' ? body.text.body : (mediaRef?.caption ?? '');
    }

    const message: BotMessage = {
      id: `wamid.BOT${Date.now()}${++seq}`,
      to: body.to,
      text,
      channel: 'whatsapp',
      ...(body.type === 'image' ? { image: `/sim-media/${encodeURIComponent(body.image.id)}` } : {}),
      ...(body.type === 'video' || body.type === 'document'
        ? {
            file: {
              url: `/sim-media/${encodeURIComponent(mediaRef!.id)}`,
              name: (body.type === 'document' ? body.document.filename : undefined) ?? uploads.get(mediaRef!.id)?.name ?? 'archivo',
              kind: body.type,
            },
          }
        : {}),
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
    if (!UPLOAD_TYPES.has(file.mimetype)) {
      return reply.code(400).send({ error: { code: 131053, message: `Tipo no admitido: ${file.mimetype}` } });
    }
    const id = `${Date.now()}${++seq}`;
    media.set(id, { mime: file.mimetype, data });
    uploads.set(id, { mime: file.mimetype, name: file.filename });
    return { id };
  });

  // ---------------------------------------------------------------- papel de Meta: Send API de la página

  const pageSendSchema = z.object({
    recipient: z.object({ id: z.string().min(1) }),
    messaging_type: z.string().optional(),
    tag: z.string().optional(),
    sender_action: z.enum(['mark_seen', 'typing_on', 'typing_off']).optional(),
    message: z
      .object({
        text: z.string().optional(),
        attachment: z.object({ type: z.string(), payload: z.object({ attachment_id: z.string() }) }).optional(),
      })
      .optional(),
  });

  /**
   * POST /{page_id}/messages: Messenger y las cuentas de Instagram vinculadas. Como Meta: fuera
   * de las 24 h solo con la etiqueta HUMAN_AGENT (el sistema ya lo controla; aquí solo se valida
   * la forma). Instagram corta en 1000 bytes.
   */
  async function pageSend(raw: unknown, reply: import('fastify').FastifyReply) {
    const parsed = pageSendSchema.safeParse(raw);
    if (!parsed.success) return reply.code(400).send({ error: { code: 100, message: 'Cuerpo inválido' } });
    const body = parsed.data;
    const to = body.recipient.id;
    const user = metaUsers.get(to);
    if (!user) return reply.code(400).send({ error: { code: 100, message: 'No hay ninguna persona con ese id' } });
    if (body.sender_action) {
      if (body.sender_action !== 'typing_off') bus.emit('read', { to, typing: body.sender_action === 'typing_on' });
      return { recipient_id: to };
    }
    if (body.messaging_type === 'MESSAGE_TAG' && body.tag !== 'HUMAN_AGENT') {
      return reply.code(400).send({ error: { code: 100, message: 'Etiqueta no admitida' } });
    }
    const text = body.message?.text;
    if (user.channel === 'instagram' && text && Buffer.byteLength(text, 'utf8') > 1000) {
      return reply.code(400).send({ error: { code: 100, message: 'El texto supera los 1000 bytes' } });
    }
    const att = body.message?.attachment;
    if (att && !media.has(att.payload.attachment_id)) return reply.code(400).send({ error: { code: 100, message: 'Archivo desconocido' } });
    if (!text && !att) return reply.code(400).send({ error: { code: 100, message: 'Mensaje vacío' } });
    const fileUrl = att ? `/sim-media/${encodeURIComponent(att.payload.attachment_id)}` : null;
    const message: BotMessage = {
      id: `m_BOT${Date.now()}${++seq}`,
      to,
      text: text ?? '',
      channel: user.channel,
      ...(att?.type === 'image' ? { image: fileUrl! } : {}),
      ...(att && att.type !== 'image'
        ? { file: { url: fileUrl!, name: uploads.get(att.payload.attachment_id)?.name ?? 'archivo', kind: att.type === 'video' ? 'video' : 'document' } as const }
        : {}),
      at: new Date().toISOString(),
    };
    botMessages.push(message);
    bus.emit('bot', message);
    // Messenger avisa la entrega por webhook (Instagram usa "visto", que el sistema no necesita).
    if (user.channel === 'messenger') {
      setTimeout(() => {
        void postWebhook(metaEnvelope('messenger', { sender: { id: to }, delivery: { mids: [message.id], watermark: Date.now() } }), 'messenger').catch(
          () => undefined,
        );
      }, deps.statusDelayMs ?? 400);
    }
    return { recipient_id: to, message_id: message.id };
  }

  /** POST /{page_id}/message_attachments: subida de archivos de la página. */
  app.post<{ Params: { version: string; pageId: string } }>('/:version/:pageId/message_attachments', async (req, reply) => {
    if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) return reply.code(401).send({ error: { code: 190, message: 'Falta el token de acceso' } });
    if (req.params.pageId !== pageId) return reply.code(400).send({ error: { code: 100, message: 'Página desconocida' } });
    let data: Buffer | null = null;
    let mime = '';
    let name = 'archivo';
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          data = await part.toBuffer();
          mime = part.mimetype;
          name = part.filename;
        }
      }
    } catch {
      return reply.code(400).send({ error: { code: 100, message: 'Se espera multipart/form-data' } });
    }
    if (!data?.length || !UPLOAD_TYPES.has(mime)) return reply.code(400).send({ error: { code: 100, message: `Tipo no admitido: ${mime}` } });
    const id = `att${Date.now()}${++seq}`;
    media.set(id, { mime, data });
    uploads.set(id, { mime, name });
    return { attachment_id: id };
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

  /** Plantillas aprobadas de la cuenta (las de templates.json), con la forma de Graph. */
  app.get<{ Params: { version: string; wabaId: string } }>('/:version/:wabaId/message_templates', async (req, reply) => {
    if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) {
      return reply.code(401).send({ error: { code: 190, message: 'Falta el token de acceso' } });
    }
    const data = Object.entries(deps.templates ?? {}).map(([name, t]) => ({
      name,
      language: t.language,
      status: 'APPROVED',
      category: t.category ?? 'UTILITY',
      components: [
        { type: 'BODY', text: t.body },
        ...(t.buttons?.length ? [{ type: 'BUTTONS', buttons: t.buttons.map((text) => ({ type: 'QUICK_REPLY', text })) }] : []),
      ],
    }));
    return { data };
  });

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
    // GET /{page_id}: datos de la página y su cuenta de Instagram (conexión de Messenger e Instagram).
    if (req.params.mediaId === pageId) {
      return { id: pageId, name: 'Simulador IMM', instagram_business_account: { id: instagramId, username: 'simulador.imm' } };
    }
    // GET /{psid}: perfil del cliente de Messenger o Instagram.
    const metaUser = metaUsers.get(req.params.mediaId);
    if (metaUser) {
      const [first, ...rest] = metaUser.name.split(' ');
      return metaUser.channel === 'messenger'
        ? { id: req.params.mediaId, first_name: first, last_name: rest.join(' ') }
        : { id: req.params.mediaId, name: metaUser.name, username: metaUser.name.toLowerCase().replace(/\s+/g, '.') };
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
