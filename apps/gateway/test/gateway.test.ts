import { describe, expect, it, vi } from 'vitest';
import type { ParsedEvent } from '@zenith/core';
import { signMetaPayload } from '@zenith/channel-whatsapp';
import { buildGateway, type GatewayDeps } from '../src/server.js';
import { statusWebhook, textWebhook } from '../../../packages/channel-whatsapp/test/fixtures.js';

const SECRET = 'app-secret-de-prueba';
const VERIFY = 'verify-token-de-prueba-123';

function setup(overrides: Partial<GatewayDeps> = {}) {
  const seen = new Set<string>();
  const saveEvent = vi.fn(async (e: ParsedEvent) => {
    if (seen.has(e.externalEventId)) return null;
    seen.add(e.externalEventId);
    return `id-${e.externalEventId}`;
  });
  const enqueue = vi.fn(async (_id: string) => undefined);
  const app = buildGateway({ metaAppSecret: SECRET, metaVerifyToken: VERIFY, saveEvent, enqueue, ...overrides });
  return { app, saveEvent, enqueue };
}

function post(app: ReturnType<typeof setup>['app'], body: unknown, signature?: string) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/webhooks/meta/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? signMetaPayload(raw, SECRET) },
    payload: raw,
  });
}

describe('handshake de Meta', () => {
  it('devuelve el challenge con el token correcto', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('12345');
  });

  it('rechaza un token incorrecto', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1' });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /webhooks/meta/whatsapp', () => {
  it('guarda y encola cada evento nuevo', async () => {
    const { app, saveEvent, enqueue } = setup();
    const res = await post(app, textWebhook());
    expect(res.statusCode).toBe(200);
    expect(saveEvent).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('id-msg:wamid.TEXT1');
  });

  it('no reencola un webhook repetido por Meta', async () => {
    const { app, enqueue } = setup();
    await post(app, textWebhook());
    const res = await post(app, textWebhook());
    expect(res.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('procesa varios eventos de un mismo webhook', async () => {
    const { app, enqueue } = setup();
    await post(app, statusWebhook);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('rechaza firmas inválidas sin guardar nada', async () => {
    const { app, saveEvent } = setup();
    const res = await post(app, textWebhook(), signMetaPayload('otro cuerpo', SECRET));
    expect(res.statusCode).toBe(401);
    expect(saveEvent).not.toHaveBeenCalled();
  });

  it('rechaza peticiones sin firma', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/meta/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(textWebhook()),
    });
    expect(res.statusCode).toBe(401);
  });

  it('responde 400 a JSON inválido o a sobres que no son de WhatsApp', async () => {
    const { app } = setup();
    expect((await post(app, '{no es json')).statusCode).toBe(400);
    expect((await post(app, { object: 'page', entry: [] })).statusCode).toBe(400);
  });

  it('responde 200 aunque falle la cola: el evento ya quedó guardado', async () => {
    const { app, saveEvent } = setup({ enqueue: vi.fn().mockRejectedValue(new Error('redis caído')) });
    const res = await post(app, textWebhook());
    expect(res.statusCode).toBe(200);
    expect(saveEvent).toHaveBeenCalled();
  });

  it('responde 500 si no se pudo guardar, para que Meta reintente', async () => {
    const { app, enqueue } = setup({ saveEvent: vi.fn().mockRejectedValue(new Error('bd caída')) });
    const res = await post(app, textWebhook());
    expect(res.statusCode).toBe(500);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('salud', () => {
  it('readyz responde 503 si falla una dependencia', async () => {
    const { app } = setup({ checkReady: vi.fn().mockRejectedValue(new Error('x')) });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
});

describe('Messenger e Instagram', () => {
  const page = (object: 'page' | 'instagram', mid: string) => ({
    object,
    entry: [{ id: '111222333', time: 1764200000000, messaging: [{ sender: { id: '999' }, recipient: { id: '111222333' }, timestamp: 1764200000000, message: { mid, text: 'Hola' } }] }],
  });
  const postTo = (app: ReturnType<typeof setup>['app'], channel: string, body: unknown, secret = SECRET) => {
    const raw = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: `/webhooks/meta/${channel}`,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMetaPayload(raw, secret) },
      payload: raw,
    });
  };

  it('Meta verifica cada webhook en su propia URL de callback', async () => {
    const { app } = setup();
    for (const channel of ['whatsapp', 'messenger', 'instagram']) {
      const res = await app.inject({ method: 'GET', url: `/webhooks/meta/${channel}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=777` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('777');
    }
    expect((await app.inject({ method: 'GET', url: `/webhooks/meta/tiktok?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1` })).statusCode).toBe(404);
  });

  it('guarda los mensajes de Messenger e Instagram con su canal', async () => {
    const { app, saveEvent, enqueue } = setup();
    expect((await postTo(app, 'messenger', page('page', 'm_1'))).statusCode).toBe(200);
    expect((await postTo(app, 'instagram', page('instagram', 'ig_1'))).statusCode).toBe(200);
    expect(saveEvent.mock.calls.map(([e]) => [e.channel, e.externalEventId])).toEqual([
      ['messenger', 'msg:m_1'],
      ['instagram', 'msg:ig_1'],
    ]);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('rechaza firmas inválidas y un webhook mandado a la URL de otro canal', async () => {
    const { app, saveEvent } = setup();
    expect((await postTo(app, 'messenger', page('page', 'm_2'), 'otro-secreto')).statusCode).toBe(401);
    expect((await postTo(app, 'instagram', page('page', 'm_3'))).statusCode).toBe(400);
    expect((await postTo(app, 'messenger', textWebhook())).statusCode).toBe(400);
    expect((await postTo(app, 'tiktok', page('page', 'm_4'))).statusCode).toBe(404);
    expect(saveEvent).not.toHaveBeenCalled();
  });
});
