import { describe, expect, it, vi } from 'vitest';
import { parseWhatsAppWebhook, verifyMetaSignature } from '@zenith/channel-whatsapp';
import { buildSimulator } from '../src/server.js';

const SECRET = 'secreto-simulador';
const PHONE = '100000000000001';

function setup(gatewayStatus = 200) {
  const sent: { url: string; body: string; signature: string }[] = [];
  const gateway = vi.fn<typeof fetch>(async (url, init) => {
    sent.push({ url: String(url), body: String(init?.body), signature: (init?.headers as Record<string, string>)['x-hub-signature-256']! });
    return new Response('{}', { status: gatewayStatus });
  });
  const app = buildSimulator({ gatewayUrl: 'http://localhost:3000', metaAppSecret: SECRET, phoneNumberId: PHONE, fetch: gateway, statusDelayMs: 0 });
  return { app, sent, gateway };
}

describe('simulador: papel de cliente', () => {
  it('manda al gateway un webhook de WhatsApp firmado y válido', async () => {
    const { app, sent } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/send', payload: { from: '584141234567', name: 'Ana', text: 'Hola' } });
    expect(res.statusCode).toBe(200);
    expect(sent[0]?.url).toBe('http://localhost:3000/webhooks/meta/whatsapp');
    expect(verifyMetaSignature(Buffer.from(sent[0]!.body), sent[0]!.signature, SECRET)).toBe(true);
    const [event] = parseWhatsAppWebhook(JSON.parse(sent[0]!.body));
    expect(event).toMatchObject({ kind: 'message', channelExternalAccountId: PHONE, text: 'Hola', from: { externalUserId: '584141234567', displayName: 'Ana' } });
  });

  it('valida lo que escribe el navegador', async () => {
    const { app, gateway } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/send', payload: { from: 'abc', name: 'Ana', text: 'Hola' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/send', payload: { from: '584141234567', name: 'Ana', text: '   ' } })).statusCode).toBe(400);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('avisa si el gateway rechaza o no está levantado', async () => {
    expect((await setup(401).app.inject({ method: 'POST', url: '/api/send', payload: { from: '584141234567', name: 'A', text: 'x' } })).statusCode).toBe(502);
    const down = buildSimulator({
      gatewayUrl: 'http://localhost:3000',
      metaAppSecret: SECRET,
      phoneNumberId: PHONE,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    const res = await down.inject({ method: 'POST', url: '/api/send', payload: { from: '584141234567', name: 'A', text: 'x' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('gateway_unreachable');
  });

  it('sirve la interfaz', async () => {
    const res = await setup().app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Simulador del bot');
  });
});

describe('simulador: papel de Meta', () => {
  const graph = (app: ReturnType<typeof setup>['app'], body: unknown, auth = 'Bearer token', phone = PHONE) =>
    app.inject({ method: 'POST', url: `/v21.0/${phone}/messages`, headers: { authorization: auth }, payload: body as object });

  it('recibe el envío del bot, responde como Graph y luego manda los estados', async () => {
    const { app, sent } = setup();
    const res = await graph(app, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '584141234567', type: 'text', text: { body: 'Buenas tardes' } });
    expect(res.statusCode).toBe(200);
    const id = res.json().messages[0].id as string;
    expect(app.botMessages).toEqual([expect.objectContaining({ id, to: '584141234567', text: 'Buenas tardes' })]);

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const states = sent.map((s) => parseWhatsAppWebhook(JSON.parse(s.body))[0]?.status?.state);
    expect(states).toEqual(['delivered', 'read']);
    expect(sent.every((s) => verifyMetaSignature(Buffer.from(s.body), s.signature, SECRET))).toBe(true);
  });

  it('rechaza envíos sin token, a otro número o con cuerpo inválido', async () => {
    const { app } = setup();
    const ok = { messaging_product: 'whatsapp', to: '584141234567', type: 'text', text: { body: 'x' } };
    expect((await graph(app, ok, '')).statusCode).toBe(401);
    expect((await graph(app, ok, 'Bearer t', '999')).statusCode).toBe(400);
    expect((await graph(app, { ...ok, type: 'image' })).statusCode).toBe(400);
    expect(app.botMessages).toHaveLength(0);
  });

  it('recibe fotos subidas como multipart, las envía y las sirve al navegador', async () => {
    const { app } = setup();
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'image/jpeg');
    form.append('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'foto.jpg');
    const req = new Request('http://x', { method: 'POST', body: form });
    const upload = await app.inject({
      method: 'POST',
      url: `/v21.0/${PHONE}/media`,
      headers: { authorization: 'Bearer t', 'content-type': req.headers.get('content-type')! },
      payload: Buffer.from(await req.arrayBuffer()),
    });
    expect(upload.statusCode).toBe(200);
    const mediaId = upload.json().id as string;

    const sent = await graph(app, { messaging_product: 'whatsapp', to: '584141234567', type: 'image', image: { id: mediaId, caption: 'Aconna Beige' } });
    expect(sent.statusCode).toBe(200);
    expect(app.botMessages.at(-1)).toMatchObject({ text: 'Aconna Beige', image: `/sim-media/${mediaId}` });

    const served = await app.inject({ method: 'GET', url: `/sim-media/${mediaId}` });
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(served.rawPayload.length).toBe(4);
  });

  it('rechaza fotos con un id que no se subió o de un tipo no admitido', async () => {
    const { app } = setup();
    const unknown = await graph(app, { messaging_product: 'whatsapp', to: '584141234567', type: 'image', image: { id: 'nada' } });
    expect(unknown.statusCode).toBe(400);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1])], { type: 'image/webp' }), 'x.webp');
    const req = new Request('http://x', { method: 'POST', body: form });
    const res = await app.inject({
      method: 'POST',
      url: `/v21.0/${PHONE}/media`,
      headers: { authorization: 'Bearer t', 'content-type': req.headers.get('content-type')! },
      payload: Buffer.from(await req.arrayBuffer()),
    });
    expect(res.statusCode).toBe(400);
  });

  it('el stream exige un número válido', async () => {
    expect((await setup().app.inject({ method: 'GET', url: '/api/stream?to=abc' })).statusCode).toBe(400);
  });
});
