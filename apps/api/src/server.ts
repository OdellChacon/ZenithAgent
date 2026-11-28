import { randomInt, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  exchangeSignupCode,
  getPhoneInfo,
  registerPhone,
  requestSmbAppData,
  subscribeAppToWaba,
  WhatsAppOnboardingError,
  listWhatsAppTemplates,
  renderTemplateBody,
  type ApprovedTemplate,
  WHATSAPP_AUDIO_MIME_TYPES,
  WHATSAPP_DOCUMENT_MIME_TYPES,
  WHATSAPP_MAX_AUDIO_BYTES,
  WHATSAPP_MAX_DOCUMENT_BYTES_IN,
  WHATSAPP_MAX_VIDEO_BYTES_IN,
  WHATSAPP_VIDEO_MIME_TYPES,
} from '@zenith/channel-whatsapp';
import { downloadCustomerMedia, META_MAX_IMAGE_BYTES } from '@zenith/channel-meta';
import { agentFileSpec, sniffFile, AGENT_FILE_MAX_BYTES, CATALOG_MAX_BYTES, catalogSendLimit } from './files.js';
import { decryptCredentials, disconnectReasonLabel, dummyHash, encryptCredentials, outboundIdempotencyKey, verifyPassword, windowState, type Channel, type PanelEvent } from '@zenith/core';
import { withTenant, type Pool, type PoolClient } from '@zenith/db';

import {
  createLoginLimiter,
  createSession,
  findSession,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type SessionUser,
} from './sessions.js';

export interface ApiDeps {
  pool: Pool;
  /** Encola el envío de mensajes de asesor. */
  enqueueOutbound(tenantId: string, outboundMessageIds: string[]): Promise<void>;
  /** Publica un evento al panel de un tenant. */
  publish(tenantId: string, event: PanelEvent): Promise<void>;
  /** Suscribe a los eventos de un tenant; devuelve la función para cancelar. */
  subscribe(tenantId: string, onEvent: (event: PanelEvent) => void): Promise<() => Promise<void>>;
  /** Cookie Secure: true en producción (https). */
  secureCookies: boolean;
  /** Para /healthz: revisa base de datos, Redis y que el worker siga vivo. */
  health?: () => Promise<Record<string, boolean>>;
  /** Acceso a Graph API con el token de cada número (para leer sus plantillas aprobadas). */
  graph?: { graphApiVersion: string; graphBaseUrl?: string; masterKey: Buffer; fetch?: typeof fetch };
  /** Alta de números con el registro insertado de Meta. Sin esto, el panel no ofrece conectar. */
  whatsappSignup?: WhatsAppSignupConfig;
  now?: () => Date;
}

export interface WhatsAppSignupConfig {
  appId: string;
  appSecret: string;
  /** Configuración de Facebook Login for Business (Embedded Signup). */
  configId: string;
  graphApiVersion: string;
  graphBaseUrl?: string;
  /** Clave para cifrar el token del número (ENCRYPTION_MASTER_KEY). */
  masterKey: Buffer;
  masterKeyId?: string;
  /** Solo con el simulador local: número que el panel conecta sin abrir el registro de Meta. */
  simulatedPhoneNumberId?: string;
  fetch?: typeof fetch;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

const CSRF_HEADER = 'x-zenith-csrf';
const UUID = z.string().uuid();

const err = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });

/**
 * API del panel de asesores. Toda consulta de datos del negocio pasa por withTenant con el
 * tenant de la sesión, así que RLS impide ver otro negocio aunque se adivine un id.
 */
export function buildApi(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: true });
  void app.register(cookie);
  // Solo la ruta de archivos lee multipart; el resto de la API acepta JSON de hasta 64 KB.
  void app.register(multipart, { limits: { fileSize: AGENT_FILE_MAX_BYTES, files: 1, fields: 4, fieldSize: 4096 } });
  const now = () => deps.now?.() ?? new Date();
  // Por correo se frena la fuerza bruta contra una cuenta; por IP el límite es más alto porque
  // en una oficina todos los asesores salen por la misma IP.
  const emailLimiter = createLoginLimiter(10);
  const ipLimiter = createLoginLimiter(50);

  // Los cambios exigen una cabecera propia: un formulario de otro sitio no puede enviarla
  // sin una petición CORS previa, que esta API no permite.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers[CSRF_HEADER] !== '1') {
      return err(reply, 403, 'csrf', 'Falta la cabecera de seguridad');
    }
    if (req.url.startsWith('/api/v1/auth/login')) return;
    req.user = (await findSession(deps.pool, req.cookies[SESSION_COOKIE])) ?? undefined;
    if (!req.user) return err(reply, 401, 'unauthenticated', 'Inicia sesión');
  });

  /**
   * Para el monitor externo (UptimeRobot o similar) y Docker: 200 si todo está bien, 503 si algo
   * falla. Solo dice qué parte falló, sin detalles internos.
   */
  app.get('/healthz', async (_req, reply) => {
    if (!deps.health) return { ok: true };
    let checks: Record<string, boolean>;
    try {
      checks = await deps.health();
    } catch {
      checks = { api: false };
    }
    const ok = Object.values(checks).every(Boolean);
    return reply.code(ok ? 200 : 503).header('cache-control', 'no-store').send({ ok, checks });
  });

  /**
   * Para el healthcheck de Docker: solo dice si este proceso responde. /healthz incluye al
   * worker y a Redis; si Docker usara ese, un worker caído marcaría también a la API como
   * enferma aunque el panel funcione.
   */
  app.get('/readyz', async (_req, reply) => reply.header('cache-control', 'no-store').send({ ok: true }));

  const user = (req: FastifyRequest) => req.user!;
  const tenant = <T>(req: FastifyRequest, fn: (c: PoolClient) => Promise<T>) => withTenant(deps.pool, user(req).tenantId, fn);

  // ---------------------------------------------------------------- sesión

  const loginSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, 'invalid_input', 'Correo o contraseña inválidos');
    const { email, password } = parsed.data;
    const ipKey = `ip:${req.ip}`;
    const emailKey = `email:${email}`;
    if (ipLimiter.blocked(ipKey) || emailLimiter.blocked(emailKey)) {
      return err(reply, 429, 'too_many_attempts', 'Demasiados intentos. Prueba en unos minutos.');
    }

    const { rows } = await deps.pool.query<{ id: string; password_hash: string; tenant_id: string | null }>(
      `SELECT u.id, u.password_hash,
              (SELECT m.tenant_id FROM memberships m, LATERAL auth_tenant(m.tenant_id) t
                WHERE m.user_id = u.id AND t.status = 'active' ORDER BY m.created_at LIMIT 1) AS tenant_id
         FROM users u WHERE lower(u.email) = $1 AND u.status = 'active'`,
      [email],
    );
    const found = rows[0];
    const ok = await verifyPassword(password, found?.password_hash ?? (await dummyHash()));
    if (!found || !ok || !found.tenant_id) {
      ipLimiter.fail(ipKey);
      emailLimiter.fail(emailKey);
      return err(reply, 401, 'invalid_credentials', 'Correo o contraseña incorrectos');
    }
    emailLimiter.reset(emailKey);
    const session = await createSession(deps.pool, {
      userId: found.id,
      tenantId: found.tenant_id,
      ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
      ip: req.ip,
    });
    void reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: deps.secureCookies,
      sameSite: 'strict',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return { ok: true };
  });

  app.get('/api/v1/auth/me', async (req) => {
    const u = user(req);
    return { id: u.userId, name: u.name, email: u.email, role: u.role, tenant: { id: u.tenantId, name: u.tenantName } };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    await revokeSession(deps.pool, user(req).sessionId);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- bandeja

  const listSchema = z.object({ view: z.enum(['pending', 'mine', 'all']).default('pending') });

  app.get('/api/v1/conversations', async (req, reply) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return err(reply, 400, 'invalid_input', 'Vista inválida');
    const { view } = parsed.data;
    const rows = await tenant(req, async (c) =>
      (
        await c.query(
          `SELECT c.id, ct.name AS contact_name, ca.channel, c.mode, c.status, c.assigned_user_id, u.name AS assigned_name,
                  c.window_expires_at, c.updated_at, c.agent_active_at,
                  lm.body AS last_body, lm.author AS last_author, lm.type AS last_type, lm.created_at AS last_at,
                  h.reason AS handoff_reason, h.summary AS handoff_summary, h.requested_at AS handoff_at
             FROM conversations c
             JOIN contacts ct ON ct.id = c.contact_id
             JOIN channel_accounts ca ON ca.id = c.channel_account_id
             LEFT JOIN users u ON u.id = c.assigned_user_id
             LEFT JOIN LATERAL (SELECT body, author, type, created_at FROM messages m
                                 WHERE m.conversation_id = c.id ORDER BY seq DESC LIMIT 1) lm ON true
             LEFT JOIN LATERAL (SELECT reason, summary, requested_at FROM handoffs h
                                 WHERE h.conversation_id = c.id AND h.returned_at IS NULL
                                 ORDER BY requested_at DESC LIMIT 1) h ON true
            WHERE c.status <> 'closed'
              AND CASE $1
                    WHEN 'pending' THEN c.mode = 'human' AND c.assigned_user_id IS NULL AND c.agent_active_at IS NULL
                    WHEN 'mine' THEN c.assigned_user_id = $2
                    ELSE true END
            ORDER BY CASE WHEN $1 = 'pending' THEN h.requested_at END ASC NULLS LAST, c.updated_at DESC
            LIMIT 100`,
          [view, user(req).userId],
        )
      ).rows,
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        contactName: r.contact_name ?? 'Cliente sin nombre',
        channel: r.channel,
        mode: r.mode,
        status: r.status,
        assignedTo: r.assigned_user_id ? { id: r.assigned_user_id, name: r.assigned_name } : null,
        agentPhoneAt: r.agent_active_at,
        lastMessage: r.last_at ? { body: r.last_body, author: r.last_author, type: r.last_type, at: r.last_at } : null,
        handoff: r.handoff_at ? { reason: r.handoff_reason, summary: r.handoff_summary, requestedAt: r.handoff_at } : null,
        windowExpiresAt: r.window_expires_at,
        updatedAt: r.updated_at,
      })),
    };
  });

  // ---------------------------------------------------------------- conversación

  async function loadConversation(c: PoolClient, id: string) {
    const { rows } = await c.query(
      `SELECT c.id, c.mode, c.status, c.assigned_user_id, u.name AS assigned_name, c.last_inbound_at, c.window_expires_at, c.agent_active_at,
              ct.id AS contact_id, ct.name AS contact_name, ct.phone AS contact_phone, ct.tags AS contact_tags, ca.channel,
              (SELECT ci.external_user_id FROM contact_identities ci
                WHERE ci.contact_id = c.contact_id AND ci.channel = ca.channel LIMIT 1) AS recipient
         FROM conversations c
         JOIN contacts ct ON ct.id = c.contact_id
         JOIN channel_accounts ca ON ca.id = c.channel_account_id
         LEFT JOIN users u ON u.id = c.assigned_user_id
        WHERE c.id = $1`,
      [id],
    );
    return rows[0] as
      | {
          id: string;
          mode: 'bot' | 'human';
          status: string;
          assigned_user_id: string | null;
          assigned_name: string | null;
          last_inbound_at: Date | null;
          window_expires_at: Date | null;
          agent_active_at: Date | null;
          contact_id: string;
          contact_name: string | null;
          contact_phone: string | null;
          contact_tags: string[];
          channel: Channel;
          recipient: string | null;
        }
      | undefined;
  }

  app.get<{ Params: { id: string } }>('/api/v1/conversations/:id', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Conversación no encontrada');
    const data = await tenant(req, async (c) => {
      const conv = await loadConversation(c, req.params.id);
      if (!conv) return null;
      const messages = (
        await c.query(
          `SELECT * FROM (
             SELECT m.id, m.direction, m.author, m.type, m.body, m.attachments, m.created_at, m.seq, su.name AS sent_by,
                    o.status AS delivery, m.edited_at, m.deleted_at
               FROM messages m
               LEFT JOIN users su ON su.id = m.sent_by_user_id
               LEFT JOIN outbound_messages o ON o.message_id = m.id
              WHERE m.conversation_id = $1 ORDER BY m.seq DESC LIMIT 200) recent
           ORDER BY seq`,
          [req.params.id],
        )
      ).rows;
      const handoff = (
        await c.query(
          `SELECT id, reason, summary, requested_at, taken_at, returned_at FROM handoffs
            WHERE conversation_id = $1 ORDER BY requested_at DESC LIMIT 1`,
          [req.params.id],
        )
      ).rows[0];
      return { conv, messages, handoff };
    });
    if (!data) return err(reply, 404, 'not_found', 'Conversación no encontrada');
    const { conv, messages, handoff } = data;
    return {
      id: conv.id,
      mode: conv.mode,
      status: conv.status,
      channel: conv.channel,
      contact: { id: conv.contact_id, name: conv.contact_name ?? 'Cliente sin nombre', phone: conv.contact_phone, tags: conv.contact_tags },
      assignedTo: conv.assigned_user_id ? { id: conv.assigned_user_id, name: conv.assigned_name } : null,
      /** Cuándo escribió por última vez un asesor desde la app de WhatsApp Business. */
      agentPhoneAt: conv.agent_active_at,
      window: {
        // Lo que puede hacer un asesor ahora: FREE = texto libre; fuera de eso, no se puede escribir.
        state: windowState({ channel: conv.channel, lastInboundAt: conv.last_inbound_at, now: now(), author: 'agent' }),
        expiresAt: conv.window_expires_at,
      },
      handoff: handoff
        ? { reason: handoff.reason, summary: handoff.summary, requestedAt: handoff.requested_at, takenAt: handoff.taken_at, returnedAt: handoff.returned_at }
        : null,
      messages: messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        author: m.author,
        type: m.type,
        body: m.body,
        sentBy: m.sent_by,
        delivery: m.delivery,
        imageId: Array.isArray(m.attachments) ? (m.attachments[0]?.productImageId ?? null) : null,
        // Archivo que mandó un asesor desde el panel, o que mandó el cliente (se pide a Meta al abrirlo).
        file: presentFile(m.id, m.type, m.attachments),
        editedAt: m.edited_at,
        deletedAt: m.deleted_at,
        // 1 = mensaje de seguimiento del bot; 2 = plantilla de seguimiento.
        followup: Array.isArray(m.attachments) ? (m.attachments[0]?.followup ?? null) : null,
        at: m.created_at,
      })),
    };
  });

  /** Archivo de un mensaje para el panel: dónde verlo, nombre y tipo. */
  function presentFile(messageId: string, type: string, attachments: unknown) {
    const a = Array.isArray(attachments) ? (attachments[0] as Record<string, unknown> | undefined) : undefined;
    if (!a) return null;
    const name = typeof a.filename === 'string' ? a.filename : null;
    const mimeType = typeof a.mimeType === 'string' ? a.mimeType : null;
    if (typeof a.fileId === 'string') return { url: `/api/v1/files/${a.fileId}`, name, mimeType, mediaType: type };
    if (typeof a.catalogId === 'string') return { url: `/api/v1/catalogs/${a.catalogId}/file`, name, mimeType, mediaType: type };
    if ((typeof a.externalMediaId === 'string' && a.externalMediaId) || typeof a.url === 'string') {
      return { url: `/api/v1/messages/${messageId}/media`, name, mimeType, mediaType: typeof a.type === 'string' ? a.type : type };
    }
    return null;
  }

  /**
   * Lo que puede escribir un asesor ahora. En WhatsApp, fuera de 24 h solo plantillas; en
   * Messenger e Instagram, hasta 7 días con la etiqueta Human Agent.
   */
  const agentCanWrite = (channel: Channel, window: ReturnType<typeof windowState>) =>
    window === 'FREE' || (window === 'HUMAN_AGENT_ONLY' && (channel === 'messenger' || channel === 'instagram'));

  const windowClosedMessage = (channel: Channel) =>
    channel === 'whatsapp'
      ? 'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite plantillas aprobadas.'
      : 'Pasaron más de 7 días desde el último mensaje del cliente: Meta no deja escribirle hasta que vuelva a escribir.';

  /** Solo quien tiene la conversación (o un administrador) puede actuar sobre ella. */
  const canAct = (u: SessionUser, assigned: string | null) => assigned === u.userId || u.role !== 'agent';

  app.post<{ Params: { id: string } }>('/api/v1/conversations/:id/take', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Conversación no encontrada');
    const u = user(req);
    const result = await tenant(req, async (c) => {
      const conv = await loadConversation(c, req.params.id);
      if (!conv) return 'not_found' as const;
      if (conv.assigned_user_id && conv.assigned_user_id !== u.userId && u.role === 'agent') return 'taken' as const;
      await c.query(`UPDATE conversations SET mode = 'human', assigned_user_id = $2, status = 'open', updated_at = now() WHERE id = $1`, [
        conv.id,
        u.userId,
      ]);
      await c.query(`UPDATE handoffs SET taken_by = $2, taken_at = now() WHERE conversation_id = $1 AND returned_at IS NULL AND taken_at IS NULL`, [
        conv.id,
        u.userId,
      ]);
      return 'ok' as const;
    });
    if (result === 'not_found') return err(reply, 404, 'not_found', 'Conversación no encontrada');
    if (result === 'taken') return err(reply, 409, 'already_taken', 'Otro asesor ya atiende esta conversación');
    await deps.publish(u.tenantId, { type: 'conversation.updated', conversationId: req.params.id });
    return { ok: true };
  });

  const sendSchema = z.object({ text: z.string().trim().min(1).max(4096), clientId: z.string().uuid().optional() });

  app.post<{ Params: { id: string } }>('/api/v1/conversations/:id/messages', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Conversación no encontrada');
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, 'invalid_input', 'Escribe un mensaje (máximo 4096 caracteres)');
    const u = user(req);
    const clientId = parsed.data.clientId ?? randomUUID();
    const result = await tenant(req, async (c) => {
      const conv = await loadConversation(c, req.params.id);
      if (!conv) return { error: 'not_found' as const };
      if (conv.assigned_user_id !== u.userId) return { error: 'not_assigned' as const };
      if (!conv.recipient) return { error: 'no_recipient' as const };
      const window = windowState({ channel: conv.channel, lastInboundAt: conv.last_inbound_at, now: now(), author: 'agent' });
      // Por ahora solo texto libre: las plantillas de WhatsApp y la etiqueta Human Agent llegan después.
      if (!agentCanWrite(conv.channel, window)) return { error: 'window_closed' as const, window, channel: conv.channel };

      const key = outboundIdempotencyKey(conv.id, clientId, `agent:${u.userId}`);
      const existing = await findOutboundByKey(c, key);
      if (existing.rows[0]) return { id: existing.rows[0].id, duplicate: true };

      const message = await c.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, author, type, body, sent_by_user_id)
         VALUES ($1, $2, 'out', 'agent', 'text', $3, $4) RETURNING id`,
        [u.tenantId, conv.id, parsed.data.text, u.userId],
      );
      const outbound = await c.query<{ id: string }>(
        `INSERT INTO outbound_messages (tenant_id, conversation_id, message_id, idempotency_key, channel, payload)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          u.tenantId,
          conv.id,
          message.rows[0]!.id,
          key,
          conv.channel,
          JSON.stringify({ kind: 'text', text: parsed.data.text, to: conv.recipient, author: 'agent' }),
        ],
      );
      await c.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conv.id]);
      return { id: outbound.rows[0]!.id, duplicate: false };
    });

    if ('error' in result) {
      switch (result.error) {
        case 'not_found':
          return err(reply, 404, 'not_found', 'Conversación no encontrada');
        case 'not_assigned':
          return err(reply, 409, 'not_assigned', 'Toma la conversación antes de responder');
        case 'no_recipient':
          return err(reply, 409, 'no_recipient', 'No se encontró el destinatario de esta conversación');
        case 'window_closed':
          return err(reply, 409, 'window_closed', windowClosedMessage(result.channel));
      }
    }
    if (!result.duplicate) {
      await deps.enqueueOutbound(u.tenantId, [result.id]);
      await deps.publish(u.tenantId, { type: 'message.new', conversationId: req.params.id, direction: 'out', author: 'agent' });
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------- plantillas (fuera de las 24 h)

  /** Plantillas aprobadas por número, guardadas unos minutos para no pedírselas a Meta cada vez. */
  const templateCache = new Map<string, { at: number; items: ApprovedTemplate[] }>();
  const TEMPLATE_TTL_MS = 5 * 60_000;

  async function approvedTemplates(c: PoolClient, conversationId: string): Promise<ApprovedTemplate[] | { error: string }> {
    const g = deps.graph;
    if (!g) return { error: 'El servidor no tiene configurado el acceso a Meta (META_GRAPH_API_VERSION y ENCRYPTION_MASTER_KEY).' };
    const { rows } = await c.query<{ id: string; waba_id: string | null; credentials_enc: Buffer | null }>(
      `SELECT ca.id, ca.waba_id, ca.credentials_enc FROM conversations c JOIN channel_accounts ca ON ca.id = c.channel_account_id WHERE c.id = $1`,
      [conversationId],
    );
    const acc = rows[0];
    if (!acc) return { error: 'Conversación no encontrada' };
    const cached = templateCache.get(acc.id);
    if (cached && Date.now() - cached.at < TEMPLATE_TTL_MS) return cached.items;
    if (!acc.waba_id || !acc.credentials_enc) return { error: 'Este número no tiene su cuenta de WhatsApp Business registrada: vuelva a conectarlo desde la sección WhatsApp.' };
    let token: string;
    try {
      token = (JSON.parse(decryptCredentials(acc.credentials_enc, g.masterKey, acc.id)) as { accessToken?: string }).accessToken ?? '';
    } catch {
      token = '';
    }
    if (!token) return { error: 'No se pudieron leer las credenciales del número: vuelva a conectarlo.' };
    try {
      const items = await listWhatsAppTemplates(
        { graphApiVersion: g.graphApiVersion, ...(g.graphBaseUrl ? { graphBaseUrl: g.graphBaseUrl } : {}), ...(g.fetch ? { fetch: g.fetch } : {}) },
        token,
        acc.waba_id,
      );
      templateCache.set(acc.id, { at: Date.now(), items });
      return items;
    } catch (e) {
      return { error: `Meta no devolvió las plantillas: ${(e as Error).message}` };
    }
  }

  app.get<{ Params: { id: string } }>('/api/v1/conversations/:id/templates', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Conversación no encontrada');
    const result = await tenant(req, (c) => approvedTemplates(c, req.params.id));
    if ('error' in result) return err(reply, 503, 'templates_unavailable', result.error);
    return { items: result };
  });

  // Meta no admite saltos de línea, tabulaciones ni más de 4 espacios seguidos en los valores.
  const templateParam = z
    .string()
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(1, 'Completa todos los datos de la plantilla')
        .max(200, 'Cada dato de la plantilla tiene como máximo 200 caracteres')
        .refine((v) => !/[\n\r\t]| {4,}/.test(v), 'Los datos de la plantilla no pueden tener saltos de línea ni muchos espacios seguidos'),
    );
  const templateSendSchema = z
    .object({
      name: z.string().min(1).max(512),
      language: z.string().min(2).max(15),
      params: z.array(templateParam).max(20),
      clientId: z.string().uuid().optional(),
    })
    .strict();

  app.post<{ Params: { id: string } }>('/api/v1/conversations/:id/templates', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Conversación no encontrada');
    const parsed = templateSendSchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const v = parsed.data;
    const u = user(req);
    const clientId = v.clientId ?? randomUUID();
    const result = await tenant(req, async (c) => {
      const conv = await loadConversation(c, req.params.id);
      if (!conv) return { error: 'not_found' as const };
      if (conv.assigned_user_id !== u.userId) return { error: 'not_assigned' as const };
      if (!conv.recipient) return { error: 'no_recipient' as const };
      const list = await approvedTemplates(c, conv.id);
      if ('error' in list) return { error: 'unavailable' as const, message: list.error };
      const tpl = list.find((t) => t.name === v.name && t.language === v.language);
      if (!tpl) return { error: 'unknown_template' as const };
      if (v.params.length !== tpl.params) return { error: 'bad_params' as const, expected: tpl.params };

      const key = outboundIdempotencyKey(conv.id, clientId, `agent-template:${u.userId}`);
      const existing = await findOutboundByKey(c, key);
      if (existing.rows[0]) return { id: existing.rows[0].id, duplicate: true };

      const body = renderTemplateBody(tpl.body, v.params);
      const message = await c.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, author, type, body, sent_by_user_id)
         VALUES ($1, $2, 'out', 'agent', 'template', $3, $4) RETURNING id`,
        [u.tenantId, conv.id, body, u.userId],
      );
      const outbound = await c.query<{ id: string }>(
        `INSERT INTO outbound_messages (tenant_id, conversation_id, message_id, idempotency_key, channel, payload)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          u.tenantId,
          conv.id,
          message.rows[0]!.id,
          key,
          conv.channel,
          JSON.stringify({ kind: 'template', name: tpl.name, language: tpl.language, bodyParams: v.params, to: conv.recipient, author: 'agent' }),
        ],
      );
      await c.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conv.id]);
      return { id: outbound.rows[0]!.id, duplicate: false };
    });

    if ('error' in result) {
      switch (result.error) {
        case 'not_found':
          return err(reply, 404, 'not_found', 'Conversación no encontrada');
        case 'not_assigned':
          return err(reply, 409, 'not_assigned', 'Toma la conversación antes de responder');
        case 'no_recipient':
          return err(reply, 409, 'no_recipient', 'No se encontró el destinatario de esta conversación');
        case 'unavailable':
          return err(reply, 503, 'templates_unavailable', result.message);
        case 'unknown_template':
          return err(reply, 400, 'unknown_template', 'Esa plantilla no está aprobada para este número');
        case 'bad_params':
          return err(reply, 400, 'invalid_input', `La plantilla pide ${result.expected} ${result.expected === 1 ? 'dato' : 'datos'}`);
      }
    }
    if (!result.duplicate) {
      await deps.enqueueOutbound(u.tenantId, [result.id]);
      await deps.publish(u.tenantId, { type: 'message.new', conversationId: req.params.id, direction: 'out', author: 'agent' });
    }
    return { ok: true, outboundMessageId: result.id };
  });

  // ---------------------------------------------------------------- archivos del asesor

  const fileFieldsSchema = z.object({
    caption: z.string().trim().max(1024, 'El texto que acompaña al archivo tiene como máximo 1024 caracteres').optional(),
    clientId: z.string().uuid().optional(),
  });

  /**
   * El asesor manda una foto, un video o un documento (multipart: caption y clientId antes del
   * archivo). Se revisa el tipo real por su contenido, no por el nombre, y que el canal lo admita.
   */
  app.post<{ Params: { id: string } }>('/api/v1/conversations/:id/files', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Conversación no encontrada');
    if (!req.isMultipart()) return err(reply, 415, 'unsupported_media_type', 'Se espera un archivo (multipart/form-data)');
    const u = user(req);
    const fields: Record<string, string> = {};
    let upload: { data: Buffer; filename: string } | null = null;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const data = await part.toBuffer();
          upload = { data, filename: part.filename };
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
    } catch (e) {
      if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        return err(reply, 413, 'file_too_large', `El archivo supera los ${AGENT_FILE_MAX_BYTES / 1024 / 1024} MB`);
      }
      return err(reply, 400, 'invalid_input', 'No se pudo leer el archivo');
    }
    if (!upload || !upload.data.length) return err(reply, 400, 'invalid_input', 'Adjunta un archivo');
    const parsedFields = fileFieldsSchema.safeParse(fields);
    if (!parsedFields.success) return err(reply, 400, 'invalid_input', parsedFields.error.issues[0]?.message ?? 'Datos inválidos');
    const { caption, clientId = randomUUID() } = parsedFields.data;

    const sniffed = sniffFile(upload.data, upload.filename);
    if (!sniffed) {
      return err(reply, 415, 'unsupported_file', 'Ese tipo de archivo no se puede enviar. Usa una foto (JPG o PNG), un video MP4 o un PDF, Word, Excel, PowerPoint o texto.');
    }
    const data = upload.data;

    const result = await tenant(req, async (c) => {
      const conv = await loadConversation(c, req.params.id);
      if (!conv) return { error: 'not_found' as const };
      if (conv.assigned_user_id !== u.userId) return { error: 'not_assigned' as const };
      if (!conv.recipient) return { error: 'no_recipient' as const };
      const window = windowState({ channel: conv.channel, lastInboundAt: conv.last_inbound_at, now: now(), author: 'agent' });
      if (!agentCanWrite(conv.channel, window)) return { error: 'window_closed' as const, channel: conv.channel };
      const spec = agentFileSpec(conv.channel, sniffed.mimeType);
      if (!spec) return { error: 'channel_unsupported' as const };
      if (data.length > spec.maxBytes) return { error: 'too_large' as const, maxBytes: spec.maxBytes };

      const key = outboundIdempotencyKey(conv.id, clientId, `agent-file:${u.userId}`);
      const existing = await findOutboundByKey(c, key);
      if (existing.rows[0]) return { id: existing.rows[0].id, duplicate: true };

      const file = await c.query<{ id: string }>(
        `INSERT INTO message_files (tenant_id, conversation_id, uploaded_by, media_type, mime_type, filename, bytes, sha256, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [u.tenantId, conv.id, u.userId, spec.mediaType, sniffed.mimeType, sniffed.filename, data.length, createHash('sha256').update(data).digest('hex'), data],
      );
      const fileId = file.rows[0]!.id;
      const message = await c.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, author, type, body, attachments, sent_by_user_id)
         VALUES ($1, $2, 'out', 'agent', $3, $4, $5, $6) RETURNING id`,
        [u.tenantId, conv.id, spec.mediaType, caption || null, JSON.stringify([{ fileId, filename: sniffed.filename, mimeType: sniffed.mimeType }]), u.userId],
      );
      const outbound = await c.query<{ id: string }>(
        `INSERT INTO outbound_messages (tenant_id, conversation_id, message_id, idempotency_key, channel, payload)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          u.tenantId,
          conv.id,
          message.rows[0]!.id,
          key,
          conv.channel,
          JSON.stringify({ kind: 'file', fileId, ...(caption ? { caption } : {}), to: conv.recipient, author: 'agent' }),
        ],
      );
      await c.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conv.id]);
      return { id: outbound.rows[0]!.id, duplicate: false };
    });

    if ('error' in result) {
      switch (result.error) {
        case 'not_found':
          return err(reply, 404, 'not_found', 'Conversación no encontrada');
        case 'not_assigned':
          return err(reply, 409, 'not_assigned', 'Toma la conversación antes de responder');
        case 'no_recipient':
          return err(reply, 409, 'no_recipient', 'No se encontró el destinatario de esta conversación');
        case 'window_closed':
          return err(reply, 409, 'window_closed', windowClosedMessage(result.channel));
        case 'channel_unsupported':
          return err(reply, 415, 'unsupported_file', 'Este canal no admite ese tipo de archivo');
        case 'too_large':
          return err(reply, 413, 'file_too_large', `En este canal el archivo puede pesar hasta ${Math.round(result.maxBytes / 1024 / 1024)} MB`);
      }
    }
    if (!result.duplicate) {
      await deps.enqueueOutbound(u.tenantId, [result.id]);
      await deps.publish(u.tenantId, { type: 'message.new', conversationId: req.params.id, direction: 'out', author: 'agent' });
    }
    return { ok: true };
  });

  /**
   * Busca un envío por su clave de idempotencia. Antes toma un candado de la transacción sobre la
   * clave: si el panel reintenta el mismo envío dos veces a la vez, el segundo espera a que el
   * primero termine y lo encuentra, en vez de chocar con la restricción única (500).
   */
  const findOutboundByKey = async (c: PoolClient, key: string) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    return c.query<{ id: string }>('SELECT id FROM outbound_messages WHERE idempotency_key = $1', [key]);
  };

  /** RFC 6266: nombre del archivo en la descarga, sin romper la cabecera con caracteres raros. */
  const disposition = (kind: 'inline' | 'attachment', name: string | null) => {
    if (!name) return kind;
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  };

  /** Cabeceras para servir un archivo que no controlamos: nunca se ejecuta en el origen del panel. */
  const sendFile = (reply: FastifyReply, data: Buffer, mimeType: string, name: string | null, inline: boolean) =>
    reply
      .header('content-type', mimeType)
      .header('content-disposition', disposition(inline ? 'inline' : 'attachment', name))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, max-age=3600')
      .send(data);

  const INLINE_TYPES = /^(image\/(jpeg|png|webp)|video\/(mp4|3gpp)|audio\/.+)$/;

  // ---------------------------------------------------------------- catálogos

  type CatalogRow = {
    id: string;
    title: string;
    description: string | null;
    media_type: 'image' | 'video' | 'document';
    mime_type: string;
    filename: string;
    bytes: number;
    category: string | null;
    default_message: string | null;
    bot_enabled: boolean;
    created_at: Date;
    updated_at: Date;
    /** Solo en el listado: envíos que llegaron a salir (asesores y bot). */
    sent_count?: number;
    bot_sent_count?: number;
    last_sent_at?: Date | null;
  };
  const CATALOG_COLUMNS = 'id, title, description, media_type, mime_type, filename, bytes, category, default_message, bot_enabled, created_at, updated_at';
  const presentCatalog = (r: CatalogRow) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
    defaultMessage: r.default_message,
    botEnabled: r.bot_enabled,
    mediaType: r.media_type,
    mimeType: r.mime_type,
    filename: r.filename,
    bytes: r.bytes,
    url: `/api/v1/catalogs/${r.id}/file`,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    usage: { sent: r.sent_count ?? 0, byBot: r.bot_sent_count ?? 0, lastSentAt: r.last_sent_at ?? null },
  });
  const canManageCatalogs = (req: FastifyRequest) => user(req).role !== 'agent';
  const botCanSendCatalogs = async (c: PoolClient) =>
    Boolean((await c.query<{ bot_can_send: boolean }>('SELECT bot_can_send FROM catalog_settings')).rows[0]?.bot_can_send);

  app.get('/api/v1/catalogs', async (req) => {
    const { rows, botCanSend } = await tenant(req, async (c) => ({
      // Cuántas veces salió cada catálogo: los envíos quedan en outbound_messages (índice por catalogId).
      rows: (
        await c.query<CatalogRow>(
          `SELECT ${CATALOG_COLUMNS.split(', ').map((col) => `k.${col}`).join(', ')},
                  coalesce(u.sent, 0)::int AS sent_count, coalesce(u.by_bot, 0)::int AS bot_sent_count, u.last_sent_at
             FROM catalogs k
             LEFT JOIN LATERAL (
               SELECT count(*) AS sent, count(*) FILTER (WHERE o.payload->>'author' = 'bot') AS by_bot, max(o.created_at) AS last_sent_at
                 FROM outbound_messages o
                WHERE o.tenant_id = k.tenant_id AND o.payload->>'kind' = 'catalog' AND o.payload->>'catalogId' = k.id::text
                  AND o.status IN ('sent', 'delivered', 'read')
             ) u ON true
            WHERE k.archived_at IS NULL
            ORDER BY k.created_at DESC
            LIMIT 200`,
        )
      ).rows,
      botCanSend: await botCanSendCatalogs(c),
    }));
    const categories = [...new Set(rows.map((r) => r.category).filter((x): x is string => Boolean(x)))].sort((a, b) => a.localeCompare(b, 'es'));
    return { items: rows.map(presentCatalog), categories, canManage: canManageCatalogs(req), botCanSend };
  });

  /** Si el bot puede mandar catálogos por su cuenta. Lo decide el dueño o un administrador. */
  app.put('/api/v1/catalogs/settings', async (req, reply) => {
    if (!canManageCatalogs(req)) return err(reply, 403, 'forbidden', 'Solo el dueño o un administrador puede cambiar esto');
    const parsed = z.object({ botCanSend: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) return err(reply, 400, 'invalid_input', 'Indica si el bot puede mandar catálogos');
    const u = user(req);
    await tenant(req, (c) =>
      c.query(
        `INSERT INTO catalog_settings (tenant_id, bot_can_send, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id) DO UPDATE SET bot_can_send = EXCLUDED.bot_can_send, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [u.tenantId, parsed.data.botCanSend, u.userId],
      ),
    );
    return { ok: true, botCanSend: parsed.data.botCanSend };
  });

  const catalogTitle = z.string().trim().min(1, 'Ponle un nombre al catálogo').max(120, 'El nombre tiene como máximo 120 caracteres');
  const catalogDescription = z
    .string()
    .trim()
    .max(300, 'La descripción tiene como máximo 300 caracteres')
    .transform((d) => d || null);
  const catalogCategory = z
    .string()
    .trim()
    .max(40, 'La categoría tiene como máximo 40 caracteres')
    .transform((d) => d.replace(/\s+/g, ' ') || null);
  const catalogMessage = z
    .string()
    .trim()
    .max(1000, 'El mensaje tiene como máximo 1000 caracteres')
    .transform((d) => d || null);

  /** Sube un catálogo (multipart: title y description antes del archivo). Solo dueño o administrador. */
  app.post('/api/v1/catalogs', async (req, reply) => {
    if (!canManageCatalogs(req)) return err(reply, 403, 'forbidden', 'Solo el dueño o un administrador puede subir catálogos');
    if (!req.isMultipart()) return err(reply, 415, 'unsupported_media_type', 'Se espera un archivo (multipart/form-data)');
    const fields: Record<string, string> = {};
    let upload: { data: Buffer; filename: string } | null = null;
    try {
      for await (const part of req.parts({ limits: { fileSize: CATALOG_MAX_BYTES } })) {
        if (part.type === 'file') upload = { data: await part.toBuffer(), filename: part.filename };
        else if (typeof part.value === 'string') fields[part.fieldname] = part.value;
      }
    } catch (e) {
      if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') return err(reply, 413, 'file_too_large', 'El catálogo supera los 25 MB');
      return err(reply, 400, 'invalid_input', 'No se pudo leer el archivo');
    }
    if (!upload?.data.length) return err(reply, 400, 'invalid_input', 'Adjunta el archivo del catálogo');
    const parsed = z
      .object({
        title: catalogTitle.optional(),
        description: catalogDescription.optional(),
        category: catalogCategory.optional(),
        defaultMessage: catalogMessage.optional(),
        botEnabled: z.enum(['true', 'false']).optional(),
        allowDuplicate: z.enum(['true', 'false']).optional(),
      })
      .safeParse(fields);
    if (!parsed.success) return err(reply, 400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const sniffed = sniffFile(upload.data, upload.filename);
    if (!sniffed) return err(reply, 415, 'unsupported_file', 'Sube un PDF, una foto (JPG o PNG), un video MP4 o un documento de Office');
    const mediaType = sniffed.mimeType.startsWith('image/') ? 'image' : sniffed.mimeType.startsWith('video/') ? 'video' : 'document';
    const title = parsed.data.title ?? sniffed.filename.replace(/\.[^.]+$/, '').slice(0, 120);
    const sha256 = createHash('sha256').update(upload.data).digest('hex');
    const u = user(req);
    const result = await tenant(req, async (c) => {
      // El mismo archivo ya subido: se avisa (y se puede subir igual con allowDuplicate).
      if (parsed.data.allowDuplicate !== 'true') {
        const dup = (await c.query<CatalogRow>(`SELECT ${CATALOG_COLUMNS} FROM catalogs WHERE sha256 = $1 AND archived_at IS NULL LIMIT 1`, [sha256])).rows[0];
        if (dup) return { duplicate: dup };
      }
      const row = (
        await c.query<CatalogRow>(
          `INSERT INTO catalogs (tenant_id, title, description, category, default_message, bot_enabled, media_type, mime_type, filename, bytes, sha256, data, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${CATALOG_COLUMNS}`,
          [
            u.tenantId,
            title,
            parsed.data.description ?? null,
            parsed.data.category ?? null,
            parsed.data.defaultMessage ?? null,
            parsed.data.botEnabled !== 'false',
            mediaType,
            sniffed.mimeType,
            sniffed.filename,
            upload!.data.length,
            sha256,
            upload!.data,
            u.userId,
          ],
        )
      ).rows[0]!;
      return { row };
    });
    if (result.duplicate) {
      return reply.code(409).send({
        error: { code: 'duplicate', message: `Este archivo ya está subido como “${result.duplicate.title}”.` },
        existing: presentCatalog(result.duplicate),
      });
    }
    return { ok: true, item: presentCatalog(result.row!) };
  });

  const catalogPatchSchema = z
    .object({
      title: catalogTitle.optional(),
      description: catalogDescription.nullable().optional(),
      category: catalogCategory.nullable().optional(),
      defaultMessage: catalogMessage.nullable().optional(),
      botEnabled: z.boolean().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, 'No hay cambios');

  app.patch<{ Params: { id: string } }>('/api/v1/catalogs/:id', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Catálogo no encontrado');
    if (!canManageCatalogs(req)) return err(reply, 403, 'forbidden', 'Solo el dueño o un administrador puede editar catálogos');
    const parsed = catalogPatchSchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const v = parsed.data;
    const row = await tenant(req, async (c) =>
      (
        await c.query<CatalogRow>(
          `UPDATE catalogs SET title = COALESCE($2, title),
                  description = CASE WHEN $3 THEN $4 ELSE description END,
                  category = CASE WHEN $5 THEN $6 ELSE category END,
                  default_message = CASE WHEN $7 THEN $8 ELSE default_message END,
                  bot_enabled = COALESCE($9, bot_enabled),
                  updated_at = now()
            WHERE id = $1 AND archived_at IS NULL RETURNING ${CATALOG_COLUMNS}`,
          [
            req.params.id,
            v.title ?? null,
            v.description !== undefined,
            v.description ?? null,
            v.category !== undefined,
            v.category ?? null,
            v.defaultMessage !== undefined,
            v.defaultMessage ?? null,
            v.botEnabled ?? null,
          ],
        )
      ).rows[0],
    );
    if (!row) return err(reply, 404, 'not_found', 'Catálogo no encontrado');
    return { ok: true, item: presentCatalog(row) };
  });

  /** Quita el catálogo de la lista. Se archiva: los chats donde ya se mandó lo siguen mostrando. */
  app.delete<{ Params: { id: string } }>('/api/v1/catalogs/:id', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Catálogo no encontrado');
    if (!canManageCatalogs(req)) return err(reply, 403, 'forbidden', 'Solo el dueño o un administrador puede quitar catálogos');
    const { rowCount } = await tenant(req, (c) => c.query('UPDATE catalogs SET archived_at = now() WHERE id = $1 AND archived_at IS NULL', [req.params.id]));
    if (!rowCount) return err(reply, 404, 'not_found', 'Catálogo no encontrado');
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/v1/catalogs/:id/file', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Catálogo no encontrado');
    const file = await tenant(req, async (c) =>
      (await c.query<{ data: Buffer; mime_type: string; filename: string }>('SELECT data, mime_type, filename FROM catalogs WHERE id = $1', [req.params.id])).rows[0],
    );
    if (!file) return err(reply, 404, 'not_found', 'Catálogo no encontrado');
    // El PDF se abre en el visor del navegador; con "sandbox" Chrome no lo mostraría. El visor
    // corre aparte y no ejecuta nada en el origen del panel; content-type fijo + nosniff impiden
    // que un archivo disfrazado se interprete como HTML. Además: ningún otro sitio puede
    // incrustarlo (frame-ancestors) ni leerlo (CORP), y abre sin acceso a la ventana del panel.
    if (file.mime_type === 'application/pdf') {
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', disposition('inline', file.filename))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "frame-ancestors 'self'")
        .header('cross-origin-resource-policy', 'same-origin')
        .header('cross-origin-opener-policy', 'same-origin')
        .header('cache-control', 'private, max-age=3600')
        .send(file.data);
    }
    return sendFile(reply, file.data, file.mime_type, file.filename, INLINE_TYPES.test(file.mime_type));
  });

  const shareCatalogSchema = z
    .object({
      catalogId: z.string().uuid(),
      caption: z.string().trim().max(1024, 'El texto que acompaña al catálogo tiene como máximo 1024 caracteres').optional(),
      clientId: z.string().uuid().optional(),
    })
    .strict();

  /** El asesor manda un catálogo al cliente (lo arrastró al chat o lo eligió de la lista). */
  app.post<{ Params: { id: string } }>('/api/v1/conversations/:id/catalogs', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Conversación no encontrada');
    const parsed = shareCatalogSchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const { catalogId, caption, clientId = randomUUID() } = parsed.data;
    const u = user(req);
    const result = await tenant(req, async (c) => {
      const conv = await loadConversation(c, req.params.id);
      if (!conv) return { error: 'not_found' as const };
      if (conv.assigned_user_id !== u.userId) return { error: 'not_assigned' as const };
      if (!conv.recipient) return { error: 'no_recipient' as const };
      const window = windowState({ channel: conv.channel, lastInboundAt: conv.last_inbound_at, now: now(), author: 'agent' });
      if (!agentCanWrite(conv.channel, window)) return { error: 'window_closed' as const, channel: conv.channel };
      const catalog = (
        await c.query<{ id: string; title: string; media_type: 'image' | 'video' | 'document'; mime_type: string; filename: string; bytes: number }>(
          'SELECT id, title, media_type, mime_type, filename, bytes FROM catalogs WHERE id = $1 AND archived_at IS NULL',
          [catalogId],
        )
      ).rows[0];
      if (!catalog) return { error: 'no_catalog' as const };
      const limit = catalogSendLimit(conv.channel, catalog.media_type, catalog.mime_type);
      if (limit === null) return { error: 'channel_unsupported' as const };
      if (catalog.bytes > limit) return { error: 'too_large' as const, maxBytes: limit };

      const key = outboundIdempotencyKey(conv.id, clientId, `agent-catalog:${u.userId}`);
      const existing = await findOutboundByKey(c, key);
      if (existing.rows[0]) return { id: existing.rows[0].id, duplicate: true };

      const message = await c.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, author, type, body, attachments, sent_by_user_id)
         VALUES ($1, $2, 'out', 'agent', $3, $4, $5, $6) RETURNING id`,
        [
          u.tenantId,
          conv.id,
          catalog.media_type,
          caption || null,
          JSON.stringify([{ catalogId: catalog.id, filename: catalog.filename, mimeType: catalog.mime_type, title: catalog.title }]),
          u.userId,
        ],
      );
      const outbound = await c.query<{ id: string }>(
        `INSERT INTO outbound_messages (tenant_id, conversation_id, message_id, idempotency_key, channel, payload)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          u.tenantId,
          conv.id,
          message.rows[0]!.id,
          key,
          conv.channel,
          JSON.stringify({ kind: 'catalog', catalogId: catalog.id, ...(caption ? { caption } : {}), to: conv.recipient, author: 'agent' }),
        ],
      );
      await c.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conv.id]);
      return { id: outbound.rows[0]!.id, duplicate: false };
    });

    if ('error' in result) {
      switch (result.error) {
        case 'not_found':
          return err(reply, 404, 'not_found', 'Conversación no encontrada');
        case 'not_assigned':
          return err(reply, 409, 'not_assigned', 'Toma la conversación antes de responder');
        case 'no_recipient':
          return err(reply, 409, 'no_recipient', 'No se encontró el destinatario de esta conversación');
        case 'window_closed':
          return err(reply, 409, 'window_closed', windowClosedMessage(result.channel));
        case 'no_catalog':
          return err(reply, 404, 'no_catalog', 'Ese catálogo ya no está disponible');
        case 'channel_unsupported':
          return err(reply, 415, 'unsupported_file', 'Este canal no admite ese tipo de archivo');
        case 'too_large':
          return err(reply, 413, 'file_too_large', `Por este canal el catálogo puede pesar hasta ${Math.round(result.maxBytes / 1024 / 1024)} MB`);
      }
    }
    if (!result.duplicate) {
      await deps.enqueueOutbound(u.tenantId, [result.id]);
      await deps.publish(u.tenantId, { type: 'message.new', conversationId: req.params.id, direction: 'out', author: 'agent' });
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/v1/files/:id', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Archivo no encontrado');
    const file = await tenant(req, async (c) =>
      (await c.query<{ data: Buffer; mime_type: string; filename: string }>('SELECT data, mime_type, filename FROM message_files WHERE id = $1', [req.params.id])).rows[0],
    );
    if (!file) return err(reply, 404, 'not_found', 'Archivo no encontrado');
    return sendFile(reply, file.data, file.mime_type, file.filename, INLINE_TYPES.test(file.mime_type));
  });

  /** Límites al traer de Meta lo que mandó el cliente, según el tipo. */
  const CUSTOMER_MEDIA_LIMITS: Record<string, { maxBytes: number; allowedMimeTypes: ReadonlySet<string> }> = {
    image: { maxBytes: META_MAX_IMAGE_BYTES, allowedMimeTypes: new Set(['image/jpeg', 'image/png', 'image/webp']) },
    sticker: { maxBytes: 1024 * 1024, allowedMimeTypes: new Set(['image/webp', 'image/png']) },
    audio: { maxBytes: WHATSAPP_MAX_AUDIO_BYTES, allowedMimeTypes: new Set([...WHATSAPP_AUDIO_MIME_TYPES, 'audio/x-m4a', 'audio/wav', 'video/mp4']) },
    video: { maxBytes: WHATSAPP_MAX_VIDEO_BYTES_IN, allowedMimeTypes: WHATSAPP_VIDEO_MIME_TYPES },
    document: { maxBytes: WHATSAPP_MAX_DOCUMENT_BYTES_IN, allowedMimeTypes: WHATSAPP_DOCUMENT_MIME_TYPES },
  };

  /**
   * Archivo que mandó el cliente (o un asesor desde el teléfono): se pide a Meta en el momento.
   * WhatsApp guarda los archivos unos 30 días; pasado eso Meta ya no lo entrega.
   */
  app.get<{ Params: { id: string } }>('/api/v1/messages/:id/media', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Archivo no encontrado');
    const g = deps.graph;
    if (!g) return err(reply, 503, 'not_configured', 'El servidor no tiene configurado el acceso a Meta');
    const row = await tenant(req, async (c) =>
      (
        await c.query<{ attachments: unknown; type: string; channel: Channel; account_id: string; credentials_enc: Buffer | null }>(
          `SELECT m.attachments, m.type, ca.channel, ca.id AS account_id, ca.credentials_enc
             FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN channel_accounts ca ON ca.id = c.channel_account_id
            WHERE m.id = $1 AND m.deleted_at IS NULL`,
          [req.params.id],
        )
      ).rows[0],
    );
    const a = row && Array.isArray(row.attachments) ? (row.attachments[0] as Record<string, unknown> | undefined) : undefined;
    const mediaType = typeof a?.type === 'string' ? a.type : row?.type;
    const limits = mediaType ? CUSTOMER_MEDIA_LIMITS[mediaType] : undefined;
    if (!row || !a || !limits) return err(reply, 404, 'not_found', 'Archivo no encontrado');
    let accessToken: string | undefined;
    if (row.channel === 'whatsapp') {
      try {
        accessToken = row.credentials_enc
          ? (JSON.parse(decryptCredentials(row.credentials_enc, g.masterKey, row.account_id)) as { accessToken?: string }).accessToken
          : undefined;
      } catch {
        accessToken = undefined;
      }
      if (!accessToken) return err(reply, 503, 'no_credentials', 'No se pudieron leer las credenciales del número');
    }
    const res = await downloadCustomerMedia(
      {
        channel: row.channel,
        ...(accessToken ? { accessToken } : {}),
        graphApiVersion: g.graphApiVersion,
        ...(g.graphBaseUrl ? { graphBaseUrl: g.graphBaseUrl } : {}),
        ...(g.fetch ? { fetch: g.fetch } : {}),
      },
      { externalMediaId: typeof a.externalMediaId === 'string' ? a.externalMediaId : '', ...(typeof a.url === 'string' ? { url: a.url } : {}) },
      { ...limits, timeoutMs: 30_000 },
    );
    if (!res.ok) {
      req.log.warn({ messageId: req.params.id, error: res.message }, 'No se pudo traer un archivo de Meta');
      return err(reply, 502, 'media_unavailable', 'Meta ya no entrega este archivo o no se pudo descargar');
    }
    const name = typeof a.filename === 'string' ? a.filename : null;
    return sendFile(reply, res.data, res.mimeType, name, INLINE_TYPES.test(res.mimeType));
  });

  const finishSchema = z.object({ action: z.enum(['release', 'close']) });

  app.post<{ Params: { id: string } }>('/api/v1/conversations/:id/finish', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Conversación no encontrada');
    const parsed = finishSchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, 'invalid_input', 'Acción inválida');
    const u = user(req);
    const result = await tenant(req, async (c) => {
      const conv = await loadConversation(c, req.params.id);
      if (!conv) return 'not_found' as const;
      if (!canAct(u, conv.assigned_user_id)) return 'forbidden' as const;
      // Devolver: el bot vuelve a responder. Cerrar: la próxima vez que escriba el cliente empieza una conversación nueva.
      await c.query(
        `UPDATE conversations SET mode = 'bot', assigned_user_id = NULL, agent_active_at = NULL, status = $2, updated_at = now() WHERE id = $1`,
        [conv.id, parsed.data.action === 'close' ? 'closed' : 'open'],
      );
      await c.query('UPDATE handoffs SET returned_at = now() WHERE conversation_id = $1 AND returned_at IS NULL', [conv.id]);
      return 'ok' as const;
    });
    if (result === 'not_found') return err(reply, 404, 'not_found', 'Conversación no encontrada');
    if (result === 'forbidden') return err(reply, 403, 'forbidden', 'Esta conversación la atiende otro asesor');
    await deps.publish(u.tenantId, { type: 'conversation.updated', conversationId: req.params.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- contactos

  /**
   * Resumen de cada contacto: sus etiquetas (las pone el equipo) y señales que salen de los
   * datos, no de la IA: qué productos le mostró el bot, si pidió precio, si lo atiende un
   * asesor, si recibió seguimiento y si pidió que no le escriban.
   */
  const CONTACT_SUMMARY = `
    SELECT ct.id, ct.name, ct.phone, ct.tags, ct.opt_out_followups, ct.notes, ct.created_at,
           (SELECT array_agg(DISTINCT ci.channel::text) FROM contact_identities ci WHERE ci.contact_id = ct.id) AS channels,
           lc.id AS conversation_id, lc.mode, lc.status, lc.assigned_user_id, lc.agent_active_at, lc.updated_at AS last_activity_at,
           (SELECT h.reason FROM handoffs h JOIN conversations c2 ON c2.id = h.conversation_id
             WHERE c2.contact_id = ct.id ORDER BY h.requested_at DESC LIMIT 1) AS last_handoff_reason,
           EXISTS (SELECT 1 FROM followups f JOIN conversations c3 ON c3.id = f.conversation_id
                    WHERE c3.contact_id = ct.id AND f.status = 'sent') AS followup_sent,
           shown.products, shown.categories
      FROM contacts ct
      LEFT JOIN LATERAL (SELECT c.id, c.mode, c.status, c.assigned_user_id, c.agent_active_at, c.updated_at FROM conversations c
                          WHERE c.contact_id = ct.id ORDER BY (c.status <> 'closed') DESC, c.updated_at DESC LIMIT 1) lc ON true
      LEFT JOIN LATERAL (
        SELECT (array_agg(name ORDER BY last_seen DESC))[1:3] AS products,
               (array_agg(DISTINCT category) FILTER (WHERE category IS NOT NULL))[1:3] AS categories
          FROM (SELECT p.name, coalesce(p.category_name, p.category) AS category, max(m.created_at) AS last_seen
                  FROM messages m
                  JOIN conversations c4 ON c4.id = m.conversation_id AND c4.contact_id = ct.id
                  JOIN product_images pi ON pi.id = (m.attachments->0->>'productImageId')::uuid
                  JOIN products p ON p.id = pi.product_id
                 WHERE m.author = 'bot' AND m.type = 'image'
                 GROUP BY p.name, coalesce(p.category_name, p.category)) seen
      ) shown ON true`;

  type ContactRow = {
    id: string;
    name: string | null;
    phone: string | null;
    tags: string[];
    opt_out_followups: boolean;
    notes: string | null;
    created_at: Date;
    channels: string[] | null;
    conversation_id: string | null;
    mode: 'bot' | 'human' | null;
    status: string | null;
    assigned_user_id: string | null;
    agent_active_at: Date | null;
    last_activity_at: Date | null;
    last_handoff_reason: string | null;
    followup_sent: boolean;
    products: string[] | null;
    categories: string[] | null;
  };

  const presentContact = (r: ContactRow) => ({
    id: r.id,
    name: r.name ?? 'Cliente sin nombre',
    phone: r.phone,
    channels: r.channels ?? [],
    tags: r.tags,
    notes: r.notes,
    optOutFollowups: r.opt_out_followups,
    lastActivityAt: r.last_activity_at ?? r.created_at,
    conversation: r.conversation_id
      ? {
          id: r.conversation_id,
          mode: r.mode,
          status: r.status,
          waitingAdvisor: r.mode === 'human' && !r.assigned_user_id && !r.agent_active_at && r.status !== 'closed',
        }
      : null,
    lastHandoffReason: r.last_handoff_reason,
    followupSent: r.followup_sent,
    interest: { products: r.products ?? [], categories: r.categories ?? [] },
  });

  /** Etiquetas en minúsculas, sin # ni espacios de más. */
  const tagSchema = z
    .string()
    .transform((t) => t.trim().replace(/^#+/, '').replace(/\s+/g, ' ').toLocaleLowerCase('es'))
    .pipe(
      z
        .string()
        .min(1, 'Etiqueta vacía')
        .max(30, 'Cada etiqueta tiene como máximo 30 caracteres')
        .regex(/^[\p{L}\p{N} _-]+$/u, 'Usa letras, números, espacios, - o _'),
    );

  const contactListSchema = z.object({
    q: z.string().trim().max(80).optional(),
    tag: tagSchema.optional(),
  });

  // % y _ son comodines de LIKE: se escapan para buscar el texto tal cual.
  const likeEscape = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

  app.get('/api/v1/contacts', async (req, reply) => {
    const parsed = contactListSchema.safeParse(req.query);
    if (!parsed.success) return err(reply, 400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Filtro inválido');
    const { q, tag } = parsed.data;
    const digits = q?.replace(/\D/g, '') ?? '';
    const rows = await tenant(req, async (c) =>
      (
        await c.query<ContactRow>(
          `${CONTACT_SUMMARY}
            WHERE ($1::text IS NULL OR ct.name ILIKE '%' || $1 || '%' OR ($2 <> '' AND ct.phone LIKE '%' || $2 || '%')
                   OR EXISTS (SELECT 1 FROM unnest(ct.tags) tg WHERE tg ILIKE '%' || $1 || '%'))
              AND ($3::text IS NULL OR $3 = ANY (ct.tags))
            ORDER BY coalesce(lc.updated_at, ct.created_at) DESC
            LIMIT 200`,
          [q ? likeEscape(q) : null, digits, tag ?? null],
        )
      ).rows,
    );
    return { items: rows.map(presentContact) };
  });

  // ---------------------------------------------------------------- canales

  // Estado de los números conectados: desconexiones de Meta e importación del historial.
  app.get('/api/v1/channels', async (req) => {
    const rows = await tenant(req, async (c) =>
      (
        await c.query<{
          id: string;
          channel: string;
          display_name: string | null;
          disconnected_at: Date | null;
          disconnect_reason: string | null;
          history_status: string | null;
          history_progress: number | null;
          on_biz_app: boolean;
          connected_at: Date;
          token_expires_at: Date | null;
          credentials_invalid_at: Date | null;
          credentials_error: string | null;
        }>(
          `SELECT id, channel, display_name, disconnected_at, disconnect_reason, history_status, history_progress, on_biz_app, connected_at,
                  token_expires_at, credentials_invalid_at, credentials_error
             FROM channel_accounts WHERE status = 'active' ORDER BY connected_at`,
        )
      ).rows,
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        name: r.display_name ?? 'Número sin nombre',
        disconnected: r.disconnected_at
          ? { at: r.disconnected_at.toISOString(), reason: r.disconnect_reason, label: disconnectReasonLabel(r.disconnect_reason) }
          : null,
        /**
         * El token de Meta: `invalid` si Meta lo rechazó (vencido o revocado: el bot no puede
         * enviar hasta volver a conectar); `expiresAt` si tiene fecha de vencimiento.
         */
        token: {
          invalid: r.credentials_invalid_at ? { at: r.credentials_invalid_at.toISOString(), error: r.credentials_error } : null,
          expiresAt: r.token_expires_at ? r.token_expires_at.toISOString() : null,
        },
        history: r.history_status ? { status: r.history_status, progress: r.history_progress ?? 0 } : null,
        coexistence: r.on_biz_app,
        connectedAt: r.connected_at.toISOString(),
      })),
    };
  });

  // Datos públicos para abrir el registro de Meta en el panel. Sin configuración, el botón no aparece.
  app.get('/api/v1/channels/whatsapp/signup', async (req) => {
    const s = deps.whatsappSignup;
    const canConnect = user(req).role !== 'agent';
    if (!s || !canConnect) return { enabled: false, canConnect };
    return {
      enabled: true,
      canConnect,
      appId: s.appId,
      configId: s.configId,
      graphApiVersion: s.graphApiVersion,
      // Con el simulador local no hay registro de Meta: el panel conecta el número de prueba.
      simulated: s.simulatedPhoneNumberId ? { phoneNumberId: s.simulatedPhoneNumberId } : null,
    };
  });

  const connectSchema = z.object({
    code: z.string().trim().min(1).max(2048),
    phoneNumberId: z.string().regex(/^\d{1,32}$/),
    wabaId: z.string().regex(/^\d{1,32}$/),
  });

  const STEP_LABELS: Record<WhatsAppOnboardingError['step'], string> = {
    code: 'Meta no aceptó el código del registro (vence a los 5 minutos); vuelve a intentarlo',
    phone: 'No se pudo leer el número en Meta',
    subscribe: 'No se pudo suscribir el sistema a los mensajes del número',
    register: 'No se pudo registrar el número en la API',
    sync: 'No se pudo pedir el historial',
  };

  /**
   * Termina el registro de Meta: canjea el código, suscribe los webhooks, registra el número
   * si es nuevo y, si sigue en la app (coexistencia), pide contactos e historial. Guarda el
   * token cifrado. Solo dueño o administrador.
   */
  app.post('/api/v1/channels/whatsapp/connect', async (req, reply) => {
    const u = user(req);
    if (u.role === 'agent') return err(reply, 403, 'forbidden', 'Solo el dueño o un administrador puede conectar números');
    const s = deps.whatsappSignup;
    if (!s) return err(reply, 503, 'not_configured', 'La conexión con Meta no está configurada en el servidor');
    const parsed = connectSchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, 'invalid_input', 'Datos del registro inválidos');
    const { code, phoneNumberId, wabaId } = parsed.data;
    const graph = { graphApiVersion: s.graphApiVersion, ...(s.graphBaseUrl ? { graphBaseUrl: s.graphBaseUrl } : {}), ...(s.fetch ? { fetch: s.fetch } : {}) };

    let token: string;
    let tokenExpiresAt: Date | null;
    let info: Awaited<ReturnType<typeof getPhoneInfo>>;
    let pin: string | null = null;
    try {
      ({ accessToken: token, expiresAt: tokenExpiresAt } = await exchangeSignupCode(graph, { appId: s.appId, appSecret: s.appSecret, code }));
      info = await getPhoneInfo(graph, token, phoneNumberId);
      await subscribeAppToWaba(graph, token, wabaId);
      if (!info.isOnBizApp) {
        // Número nuevo en la API: se registra con un PIN propio, guardado cifrado con el token.
        pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
        await registerPhone(graph, token, phoneNumberId, pin);
      }
    } catch (e) {
      if (e instanceof WhatsAppOnboardingError) {
        req.log.warn({ step: e.step, code: e.errorCode, message: e.message }, 'Falló la conexión de WhatsApp');
        return err(reply, 502, `meta_${e.step}`, STEP_LABELS[e.step]);
      }
      throw e;
    }

    const name = info.verifiedName && info.displayPhoneNumber ? `${info.verifiedName} · ${info.displayPhoneNumber}` : (info.displayPhoneNumber ?? info.verifiedName);
    let accountId: string;
    try {
      accountId = await tenant(req, async (c) => {
        const row = await c.query<{ id: string }>(
          `INSERT INTO channel_accounts (tenant_id, channel, external_account_id, display_name, waba_id, on_biz_app)
           VALUES ($1, 'whatsapp', $2, $3, $4, $5)
           ON CONFLICT (channel, external_account_id) DO UPDATE
             SET display_name = COALESCE(EXCLUDED.display_name, channel_accounts.display_name),
                 waba_id = EXCLUDED.waba_id, on_biz_app = EXCLUDED.on_biz_app, connected_at = now()
           RETURNING id`,
          [u.tenantId, phoneNumberId, name, wabaId, info.isOnBizApp],
        );
        const id = row.rows[0]!.id;
        const enc = encryptCredentials(JSON.stringify({ accessToken: token, ...(pin ? { pin } : {}) }), s.masterKey, id);
        await c.query(
          `UPDATE channel_accounts SET credentials_enc = $2, credentials_key_id = $3, disconnected_at = NULL, disconnect_reason = NULL,
                  token_expires_at = $4, credentials_invalid_at = NULL, credentials_error = NULL,
                  credentials_checked_at = now(), credentials_alerted_at = NULL, credentials_alert_state = NULL
            WHERE id = $1`,
          [id, enc, s.masterKeyId ?? null, tokenExpiresAt],
        );
        return id;
      });
    } catch (e) {
      // El número ya está conectado en otro negocio: RLS no deja tocar su fila.
      if ((e as { code?: string }).code === '42501') return err(reply, 409, 'taken', 'Ese número ya está conectado en otra cuenta');
      throw e;
    }

    // Coexistencia: contactos y luego historial, una sola vez y dentro de 24 h.
    const warnings: string[] = [];
    if (info.isOnBizApp) {
      try {
        await requestSmbAppData(graph, token, phoneNumberId, 'smb_app_state_sync');
      } catch (e) {
        req.log.warn({ message: (e as Error).message }, 'No se pudieron pedir los contactos de la app');
        warnings.push('No se pudieron pedir los contactos de la app.');
      }
      try {
        await requestSmbAppData(graph, token, phoneNumberId, 'history');
        await tenant(req, (c) =>
          c.query(`UPDATE channel_accounts SET history_status = 'importing', history_progress = 0 WHERE id = $1 AND history_status IS NULL`, [accountId]),
        );
      } catch (e) {
        req.log.warn({ message: (e as Error).message }, 'No se pudo pedir el historial de la app');
        warnings.push('No se pudo pedir el historial de chats. Avisa a soporte: Meta solo permite pedirlo dentro de las 24 h siguientes a la conexión.');
      }
    }

    await deps.publish(u.tenantId, { type: 'channel.updated' });
    return { ok: true, channelId: accountId, name, coexistence: info.isOnBizApp, warnings };
  });

  // ---------------------------------------------------------------- etiquetas de contactos

  const TAG_COLORS = ['gray', 'red', 'orange', 'amber', 'lime', 'green', 'teal', 'sky', 'blue', 'violet', 'pink'] as const;
  const groupNameSchema = z
    .string()
    .transform((g) => g.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1, 'El grupo necesita un nombre').max(30, 'El nombre del grupo tiene como máximo 30 caracteres'));
  const descriptionSchema = z
    .string()
    .max(200, 'La descripción tiene como máximo 200 caracteres')
    .transform((d) => d.trim() || null)
    .nullable();
  const tagCreateSchema = z
    .object({
      name: tagSchema,
      color: z.enum(TAG_COLORS).optional(),
      group: groupNameSchema.nullable().optional(),
      description: descriptionSchema.optional(),
    })
    .strict();
  const tagPatchSchema = z
    .object({
      name: tagSchema.optional(),
      color: z.enum(TAG_COLORS).optional(),
      group: groupNameSchema.nullable().optional(),
      description: descriptionSchema.optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, 'No hay cambios');
  const groupCreateSchema = z.object({ name: groupNameSchema, exclusive: z.boolean().optional() }).strict();
  const groupPatchSchema = z
    .object({ name: groupNameSchema.optional(), exclusive: z.boolean().optional() })
    .strict()
    .refine((v) => Object.keys(v).length > 0, 'No hay cambios');

  /** Color estable para una etiqueta nueva sin color elegido. */
  const autoColor = (name: string) => {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return TAG_COLORS[1 + (h % (TAG_COLORS.length - 1))]!;
  };

  const canManageTags = (req: FastifyRequest) => user(req).role !== 'agent';
  const tagParam = (raw: string) => tagSchema.safeParse(raw);
  const pgCode = (e: unknown) => (e as { code?: string })?.code;

  app.get('/api/v1/contact-tags', async (req) => {
    return tenant(req, async (c) => {
      const tags = await c.query<{ tag: string; count: number; color: string | null; group_name: string | null; description: string | null }>(
        `WITH used AS (SELECT tg, count(*)::int AS n FROM contacts, unnest(tags) tg GROUP BY tg)
         SELECT coalesce(d.name, u.tg) AS tag, coalesce(u.n, 0) AS count, d.color, d.group_name, d.description
           FROM contact_tag_defs d
           FULL JOIN used u ON u.tg = d.name
           LEFT JOIN contact_tag_groups g ON g.tenant_id = d.tenant_id AND g.name = d.group_name
          ORDER BY g.position NULLS LAST, d.group_name NULLS LAST, d.position, coalesce(u.n, 0) DESC, 1
          LIMIT 300`,
      );
      const groups = await c.query<{ name: string; exclusive: boolean }>(
        'SELECT name, exclusive FROM contact_tag_groups ORDER BY position, created_at, name',
      );
      return {
        items: tags.rows.map((t) => ({
          tag: t.tag,
          count: t.count,
          color: t.color ?? autoColor(t.tag),
          group: t.group_name,
          description: t.description,
        })),
        groups: groups.rows,
        canManage: canManageTags(req),
      };
    });
  });

  app.post('/api/v1/contact-tags', async (req, reply) => {
    const parsed = tagCreateSchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const v = parsed.data;
    try {
      await tenant(req, (c) =>
        c.query(
          `INSERT INTO contact_tag_defs (tenant_id, name, color, group_name, description, position)
           VALUES (app_current_tenant(), $1, $2, $3, $4, (SELECT coalesce(max(position), 0) + 1 FROM contact_tag_defs))`,
          [v.name, v.color ?? autoColor(v.name), v.group ?? null, v.description ?? null],
        ),
      );
    } catch (e) {
      if (pgCode(e) === '23505') return err(reply, 409, 'conflict', 'Ya existe una etiqueta con ese nombre');
      if (pgCode(e) === '23503') return err(reply, 400, 'invalid_input', 'Ese grupo no existe');
      throw e;
    }
    return reply.code(201).send({ ok: true, name: v.name });
  });

  app.patch<{ Params: { name: string } }>('/api/v1/contact-tags/:name', async (req, reply) => {
    if (!canManageTags(req)) return err(reply, 403, 'forbidden', 'Solo un administrador puede editar etiquetas');
    const current = tagParam(req.params.name);
    if (!current.success) return err(reply, 404, 'not_found', 'Etiqueta no encontrada');
    const parsed = tagPatchSchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const from = current.data;
    const v = parsed.data;
    let result: 'ok' | 'not_found' | 'merged';
    try {
      result = await tenant(req, async (c) => {
        // Las etiquetas que solo existían en contactos (sin definición) se registran al editarlas.
        await c.query(
          `INSERT INTO contact_tag_defs (tenant_id, name, color)
           SELECT app_current_tenant(), $1, $2 WHERE EXISTS (SELECT 1 FROM contacts WHERE $1 = ANY (tags))
           ON CONFLICT DO NOTHING`,
          [from, autoColor(from)],
        );
        const exists = await c.query('SELECT 1 FROM contact_tag_defs WHERE name = $1', [from]);
        if (!exists.rowCount) return 'not_found';
        let target = from;
        let merged = false;
        if (v.name && v.name !== from) {
          target = v.name;
          // Renombrar a una etiqueta que ya existe = fusionarlas: los contactos quedan con la otra.
          merged = !!(await c.query('SELECT 1 FROM contact_tag_defs WHERE name = $1', [target])).rowCount;
          await c.query(
            `UPDATE contacts
                SET tags = ARRAY(SELECT t FROM unnest(array_replace(tags, $1, $2)) WITH ORDINALITY AS x(t, i) GROUP BY t ORDER BY min(i)),
                    updated_at = now()
              WHERE $1 = ANY (tags)`,
            [from, target],
          );
          if (merged) await c.query('DELETE FROM contact_tag_defs WHERE name = $1', [from]);
          else await c.query('UPDATE contact_tag_defs SET name = $2 WHERE name = $1', [from, target]);
        }
        await c.query(
          `UPDATE contact_tag_defs SET
              color = CASE WHEN $2 THEN $3 ELSE color END,
              group_name = CASE WHEN $4 THEN $5 ELSE group_name END,
              description = CASE WHEN $6 THEN $7 ELSE description END
            WHERE name = $1`,
          [
            target,
            v.color !== undefined && !merged,
            v.color ?? null,
            v.group !== undefined && !merged,
            v.group ?? null,
            v.description !== undefined && !merged,
            v.description ?? null,
          ],
        );
        return merged ? 'merged' : 'ok';
      });
    } catch (e) {
      if (pgCode(e) === '23503') return err(reply, 400, 'invalid_input', 'Ese grupo no existe');
      throw e;
    }
    if (result === 'not_found') return err(reply, 404, 'not_found', 'Etiqueta no encontrada');
    return { ok: true, merged: result === 'merged' };
  });

  app.delete<{ Params: { name: string } }>('/api/v1/contact-tags/:name', async (req, reply) => {
    if (!canManageTags(req)) return err(reply, 403, 'forbidden', 'Solo un administrador puede borrar etiquetas');
    const name = tagParam(req.params.name);
    if (!name.success) return err(reply, 404, 'not_found', 'Etiqueta no encontrada');
    const removed = await tenant(req, async (c) => {
      const contacts = await c.query(
        'UPDATE contacts SET tags = array_remove(tags, $1), updated_at = now() WHERE $1 = ANY (tags)',
        [name.data],
      );
      const def = await c.query('DELETE FROM contact_tag_defs WHERE name = $1', [name.data]);
      return { contacts: contacts.rowCount ?? 0, found: (def.rowCount ?? 0) + (contacts.rowCount ?? 0) > 0 };
    });
    if (!removed.found) return err(reply, 404, 'not_found', 'Etiqueta no encontrada');
    return { ok: true, contacts: removed.contacts };
  });

  app.post('/api/v1/contact-tag-groups', async (req, reply) => {
    if (!canManageTags(req)) return err(reply, 403, 'forbidden', 'Solo un administrador puede crear grupos');
    const parsed = groupCreateSchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Datos inválidos');
    try {
      await tenant(req, (c) =>
        c.query(
          `INSERT INTO contact_tag_groups (tenant_id, name, exclusive, position)
           VALUES (app_current_tenant(), $1, $2, (SELECT coalesce(max(position), 0) + 1 FROM contact_tag_groups))`,
          [parsed.data.name, parsed.data.exclusive ?? false],
        ),
      );
    } catch (e) {
      if (pgCode(e) === '23505') return err(reply, 409, 'conflict', 'Ya existe un grupo con ese nombre');
      throw e;
    }
    return reply.code(201).send({ ok: true });
  });

  app.patch<{ Params: { name: string } }>('/api/v1/contact-tag-groups/:name', async (req, reply) => {
    if (!canManageTags(req)) return err(reply, 403, 'forbidden', 'Solo un administrador puede editar grupos');
    const parsed = groupPatchSchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const v = parsed.data;
    let count: number;
    try {
      count = await tenant(req, async (c) => {
        const r = await c.query(
          `UPDATE contact_tag_groups SET
              name = CASE WHEN $2 THEN $3 ELSE name END,
              exclusive = CASE WHEN $4 THEN $5 ELSE exclusive END
            WHERE name = $1`,
          [req.params.name, v.name !== undefined, v.name ?? null, v.exclusive !== undefined, v.exclusive ?? false],
        );
        return r.rowCount ?? 0;
      });
    } catch (e) {
      if (pgCode(e) === '23505') return err(reply, 409, 'conflict', 'Ya existe un grupo con ese nombre');
      throw e;
    }
    if (!count) return err(reply, 404, 'not_found', 'Grupo no encontrado');
    return { ok: true };
  });

  app.delete<{ Params: { name: string } }>('/api/v1/contact-tag-groups/:name', async (req, reply) => {
    if (!canManageTags(req)) return err(reply, 403, 'forbidden', 'Solo un administrador puede borrar grupos');
    // Las etiquetas del grupo se conservan, sin grupo.
    const count = await tenant(req, async (c) => (await c.query('DELETE FROM contact_tag_groups WHERE name = $1', [req.params.name])).rowCount ?? 0);
    if (!count) return err(reply, 404, 'not_found', 'Grupo no encontrado');
    return { ok: true };
  });

  /**
   * Prepara las etiquetas de un contacto antes de guardarlas: registra las nuevas y, en los
   * grupos de una sola opción, deja solo la última que se agregó (cambiar de "potencial" a
   * "cliente" reemplaza en vez de acumular).
   */
  async function resolveContactTags(c: PoolClient, tags: string[]): Promise<string[]> {
    if (!tags.length) return tags;
    await c.query(
      `INSERT INTO contact_tag_defs (tenant_id, name, color, position)
       SELECT app_current_tenant(), t.name, t.color, (SELECT coalesce(max(position), 0) FROM contact_tag_defs) + t.i
         FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(name, color, i)
       ON CONFLICT DO NOTHING`,
      [tags, tags.map(autoColor)],
    );
    const { rows } = await c.query<{ name: string; group_name: string }>(
      `SELECT d.name, d.group_name FROM contact_tag_defs d
         JOIN contact_tag_groups g ON g.tenant_id = d.tenant_id AND g.name = d.group_name
        WHERE g.exclusive AND d.name = ANY ($1)`,
      [tags],
    );
    const groupOf = new Map(rows.map((r) => [r.name, r.group_name]));
    const taken = new Set<string>();
    const keep: string[] = [];
    for (const t of [...tags].reverse()) {
      const g = groupOf.get(t);
      if (g) {
        if (taken.has(g)) continue;
        taken.add(g);
      }
      keep.unshift(t);
    }
    return keep;
  }

  app.get<{ Params: { id: string } }>('/api/v1/contacts/:id', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Contacto no encontrado');
    const data = await tenant(req, async (c) => {
      const contact = (await c.query<ContactRow>(`${CONTACT_SUMMARY} WHERE ct.id = $1`, [req.params.id])).rows[0];
      if (!contact) return null;
      const conversations = await c.query<{
        id: string;
        mode: string;
        status: string;
        channel: string;
        created_at: Date;
        updated_at: Date;
        last_body: string | null;
        last_author: string | null;
        last_type: string | null;
      }>(
        `SELECT c.id, c.mode, c.status, ca.channel, c.created_at, c.updated_at,
                lm.body AS last_body, lm.author AS last_author, lm.type AS last_type
           FROM conversations c
           JOIN channel_accounts ca ON ca.id = c.channel_account_id
           LEFT JOIN LATERAL (SELECT body, author, type FROM messages m
                               WHERE m.conversation_id = c.id ORDER BY seq DESC LIMIT 1) lm ON true
          WHERE c.contact_id = $1
          ORDER BY c.updated_at DESC
          LIMIT 20`,
        [req.params.id],
      );
      return { contact, conversations: conversations.rows };
    });
    if (!data) return err(reply, 404, 'not_found', 'Contacto no encontrado');
    return {
      ...presentContact(data.contact),
      conversations: data.conversations.map((r) => ({
        id: r.id,
        mode: r.mode,
        status: r.status,
        channel: r.channel,
        startedAt: r.created_at,
        updatedAt: r.updated_at,
        lastMessage: r.last_author ? { body: r.last_body, author: r.last_author, type: r.last_type } : null,
      })),
    };
  });

  const contactPatchSchema = z
    .object({
      name: z.string().trim().min(1, 'El nombre no puede quedar vacío').max(80).optional(),
      tags: z
        .array(tagSchema)
        .max(15, 'Máximo 15 etiquetas por contacto')
        .transform((tags) => [...new Set(tags)])
        .optional(),
      notes: z
        .string()
        .max(2000, 'Las notas tienen como máximo 2000 caracteres')
        .transform((n) => n.trim() || null)
        .nullable()
        .optional(),
      optOutFollowups: z.boolean().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, 'No hay cambios');

  app.patch<{ Params: { id: string } }>('/api/v1/contacts/:id', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Contacto no encontrado');
    const parsed = contactPatchSchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const v = parsed.data;
    const updated = await tenant(req, async (c) => {
      // Primero se confirma que el contacto es de este negocio: si no, no se registra ninguna etiqueta.
      if (!(await c.query('SELECT 1 FROM contacts WHERE id = $1', [req.params.id])).rowCount) return null;
      const tags = v.tags !== undefined ? await resolveContactTags(c, v.tags) : [];
      const { rows } = await c.query<{ id: string; conversation_id: string | null }>(
        `UPDATE contacts SET
            name = CASE WHEN $2 THEN $3 ELSE name END,
            tags = CASE WHEN $4 THEN $5::text[] ELSE tags END,
            notes = CASE WHEN $6 THEN $7 ELSE notes END,
            opt_out_followups = CASE WHEN $8 THEN $9 ELSE opt_out_followups END,
            updated_at = now()
          WHERE id = $1
          RETURNING id, (SELECT id FROM conversations WHERE contact_id = $1 ORDER BY updated_at DESC LIMIT 1) AS conversation_id`,
        [
          req.params.id,
          v.name !== undefined,
          v.name ?? null,
          v.tags !== undefined,
          tags,
          v.notes !== undefined,
          v.notes ?? null,
          v.optOutFollowups !== undefined,
          v.optOutFollowups ?? false,
        ],
      );
      return rows[0] ? { ...rows[0], tags } : null;
    });
    if (!updated) return err(reply, 404, 'not_found', 'Contacto no encontrado');
    if (updated.conversation_id) {
      await deps.publish(user(req).tenantId, { type: 'conversation.updated', conversationId: updated.conversation_id });
    }
    return v.tags !== undefined ? { ok: true, tags: updated.tags } : { ok: true };
  });

  // ---------------------------------------------------------------- fotos de productos

  app.get<{ Params: { id: string } }>('/api/v1/product-images/:id', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return err(reply, 404, 'not_found', 'Foto no encontrada');
    const img = await tenant(req, async (c) =>
      (await c.query<{ data: Buffer; mime_type: string; sha256: string }>('SELECT data, mime_type, sha256 FROM product_images WHERE id = $1', [req.params.id]))
        .rows[0],
    );
    if (!img) return err(reply, 404, 'not_found', 'Foto no encontrada');
    return reply.type(img.mime_type).header('cache-control', 'private, max-age=86400').header('etag', `"${img.sha256}"`).send(img.data);
  });

  // ---------------------------------------------------------------- eventos en vivo

  app.get('/api/v1/events', async (req, reply) => {
    const u = user(req);
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    reply.raw.write(': conectado\n\n');
    const unsubscribe = await deps.subscribe(u.tenantId, (event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`));
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    // La sesión se revisa cada minuto: si caduca o se cierra, el stream se corta.
    const check = setInterval(async () => {
      if (!(await findSession(deps.pool, req.cookies[SESSION_COOKIE]))) reply.raw.end();
    }, 60_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      clearInterval(check);
      void unsubscribe();
    });
  });

  return app;
}
