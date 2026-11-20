import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { ParsedEvent } from '@zenith/core';
import { parseWhatsAppWebhook, verifyMetaSignature, WhatsAppPayloadError } from '@zenith/channel-whatsapp';

export interface GatewayDeps {
  metaAppSecret: string;
  metaVerifyToken: string;
  /** Guarda el evento si es nuevo y devuelve su id; `null` si ya existía. */
  saveEvent(event: ParsedEvent, payload: unknown): Promise<string | null>;
  enqueue(webhookEventId: string): Promise<void>;
  /** Comprueba BD y cola para /readyz. */
  checkReady?(): Promise<void>;
}

/** Meta reintenta si no respondemos rápido; el cuerpo de un webhook es pequeño. */
const BODY_LIMIT_BYTES = 1024 * 1024;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Gateway de webhooks. No ejecuta lógica de negocio: verifica la firma, guarda cada evento una
 * sola vez, lo encola y responde 200. Si encolar falla, el evento ya quedó guardado y el
 * barrido del worker lo recupera, así que igual se responde 200 para que Meta no reintente.
 */
export function buildGateway(deps: GatewayDeps, opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({ bodyLimit: BODY_LIMIT_BYTES, ...opts });

  // El cuerpo se conserva crudo: la firma se calcula sobre los bytes exactos recibidos.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await deps.checkReady?.();
      return { ok: true };
    } catch (err) {
      app.log.error({ err }, 'readyz falló');
      return reply.code(503).send({ ok: false });
    }
  });

  // Handshake de suscripción de Meta.
  app.get<{ Querystring: Record<string, string | undefined> }>('/webhooks/meta', async (req, reply) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && challenge && deps.metaVerifyToken && safeEqual(token, deps.metaVerifyToken)) {
      return reply.type('text/plain').send(challenge);
    }
    return reply.code(403).send({ error: { code: 'verification_failed', message: 'Token de verificación inválido' } });
  });

  app.post('/webhooks/meta/whatsapp', async (req, reply) => {
    const raw = req.body;
    if (!Buffer.isBuffer(raw)) {
      return reply.code(415).send({ error: { code: 'unsupported_media_type', message: 'Se espera application/json' } });
    }

    const signature = req.headers['x-hub-signature-256'];
    if (!verifyMetaSignature(raw, typeof signature === 'string' ? signature : undefined, deps.metaAppSecret)) {
      req.log.warn('Webhook de WhatsApp con firma inválida');
      return reply.code(401).send({ error: { code: 'invalid_signature', message: 'Firma inválida' } });
    }

    let payload: unknown;
    let events: ParsedEvent[];
    try {
      payload = JSON.parse(raw.toString('utf8'));
      events = parseWhatsAppWebhook(payload);
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof WhatsAppPayloadError) {
        req.log.warn({ err: err.message }, 'Webhook de WhatsApp con cuerpo inválido');
        return reply.code(400).send({ error: { code: 'invalid_payload', message: 'Cuerpo inválido' } });
      }
      throw err;
    }

    let stored = 0;
    for (const event of events) {
      // Si guardar falla, se responde 500 y Meta reintenta: la idempotencia evita duplicados.
      const id = await deps.saveEvent(event, payload);
      if (!id) continue;
      stored++;
      try {
        await deps.enqueue(id);
      } catch (err) {
        req.log.error({ err, webhookEventId: id }, 'No se pudo encolar; lo recupera el barrido del worker');
      }
    }

    req.log.info({ events: events.length, stored }, 'Webhook de WhatsApp recibido');
    return reply.code(200).send({ ok: true });
  });

  return app;
}
