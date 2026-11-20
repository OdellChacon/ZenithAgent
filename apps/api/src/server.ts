import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import { dummyHash, outboundIdempotencyKey, verifyPassword, windowState, type Channel, type PanelEvent } from '@zenith/core';
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
  now?: () => Date;
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
                  c.window_expires_at, c.updated_at,
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
                    WHEN 'pending' THEN c.mode = 'human' AND c.assigned_user_id IS NULL
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
      `SELECT c.id, c.mode, c.status, c.assigned_user_id, u.name AS assigned_name, c.last_inbound_at, c.window_expires_at,
              ct.name AS contact_name, ct.phone AS contact_phone, ca.channel,
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
          contact_name: string | null;
          contact_phone: string | null;
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
                    o.status AS delivery
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
      contact: { name: conv.contact_name ?? 'Cliente sin nombre', phone: conv.contact_phone },
      assignedTo: conv.assigned_user_id ? { id: conv.assigned_user_id, name: conv.assigned_name } : null,
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
        at: m.created_at,
      })),
    };
  });

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
      if (window !== 'FREE') return { error: 'window_closed' as const, window };

      const key = outboundIdempotencyKey(conv.id, clientId, `agent:${u.userId}`);
      const existing = await c.query<{ id: string }>('SELECT id FROM outbound_messages WHERE idempotency_key = $1', [key]);
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
          return err(
            reply,
            409,
            'window_closed',
            'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite plantillas aprobadas.',
          );
      }
    }
    if (!result.duplicate) {
      await deps.enqueueOutbound(u.tenantId, [result.id]);
      await deps.publish(u.tenantId, { type: 'message.new', conversationId: req.params.id, direction: 'out', author: 'agent' });
    }
    return { ok: true };
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
        `UPDATE conversations SET mode = 'bot', assigned_user_id = NULL, status = $2, updated_at = now() WHERE id = $1`,
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
