import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  exchangeSignupCode,
  getPhoneInfo,
  parseWhatsAppWebhook,
  requestSmbAppData,
  subscribeAppToWaba,
  verifyMetaSignature,
} from '@zenith/channel-whatsapp';
import { parseMetaMessagingWebhook } from '@zenith/channel-meta';
import { buildSimulator, SIM_INSTAGRAM_ID, SIM_PAGE_ID } from '../src/server.js';

const SECRET = 'secreto-simulador';
const PHONE = '100000000000001';

function setup(gatewayStatus = 200) {
  const sent: { url: string; body: string; signature: string }[] = [];
  const gateway = vi.fn<typeof fetch>(async (url, init) => {
    sent.push({ url: String(url), body: String(init?.body), signature: (init?.headers as Record<string, string>)['x-hub-signature-256']! });
    return new Response('{}', { status: gatewayStatus });
  });
  const app = buildSimulator({ gatewayUrl: 'http://localhost:3000', metaAppSecret: SECRET, phoneNumberId: PHONE, fetch: gateway, statusDelayMs: 0, metaUsersFile: null });
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

  it.skipIf(spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0)(
    'una nota de voz grabada en webm (Chrome) le llega al negocio como ogg/opus',
    async () => {
      // Un segundo de tono en webm/opus, como lo graba Chrome.
      const webm = spawnSync(
        'ffmpeg',
        ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'],
        { windowsHide: true, maxBuffer: 1 << 20 },
      ).stdout;
      const { app, sent } = setup();
      const form = new FormData();
      form.append('from', '584141234567');
      form.append('name', 'Ana');
      form.append('file', new Blob([new Uint8Array(webm)], { type: 'audio/webm;codecs=opus' }), 'nota.webm');
      const req = new Request('http://x', { method: 'POST', body: form });
      const res = await app.inject({
        method: 'POST',
        url: '/api/send-audio',
        headers: { 'content-type': req.headers.get('content-type')! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      expect(res.statusCode).toBe(200);
      const [event] = parseWhatsAppWebhook(JSON.parse(sent[0]!.body));
      expect(event).toMatchObject({ kind: 'message', media: [{ type: 'audio', mimeType: 'audio/ogg; codecs=opus' }] });
      // El archivo que se baja empieza con la firma de un ogg.
      const mediaId = (event as { media: { externalMediaId: string }[] }).media[0]!.externalMediaId;
      const file = await app.inject({ method: 'GET', url: `/sim-media/${mediaId}` });
      expect(file.rawPayload.subarray(0, 4).toString()).toBe('OggS');
    },
  );

  it('el cliente manda una foto: el webhook lleva su id y se baja como en la Graph API', async () => {
    const { app, sent } = setup();
    const form = new FormData();
    form.append('from', '584141234567');
    form.append('name', 'Ana');
    form.append('caption', '¿Tienen algo así?');
    form.append('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'foto.jpg');
    const req = new Request('http://x', { method: 'POST', body: form });
    const res = await app.inject({
      method: 'POST',
      url: '/api/send-image',
      headers: { 'content-type': req.headers.get('content-type')! },
      payload: Buffer.from(await req.arrayBuffer()),
    });
    expect(res.statusCode).toBe(200);
    const [event] = parseWhatsAppWebhook(JSON.parse(sent[0]!.body));
    expect(event).toMatchObject({ kind: 'message', text: '¿Tienen algo así?', media: [{ type: 'image', mimeType: 'image/jpeg' }] });
    const mediaId = (event as { media: { externalMediaId: string }[] }).media[0]!.externalMediaId;

    expect((await app.inject({ method: 'GET', url: `/v21.0/${mediaId}` })).statusCode).toBe(401);
    const info = await app.inject({ method: 'GET', url: `/v21.0/${mediaId}`, headers: { authorization: 'Bearer t', host: 'localhost:4010' } });
    expect(info.json()).toMatchObject({ url: `http://localhost:4010/sim-media/${mediaId}`, mime_type: 'image/jpeg', file_size: 4 });
  });

  it('rechaza fotos del cliente sin número válido', async () => {
    const { app, gateway } = setup();
    const form = new FormData();
    form.append('from', 'abc');
    form.append('name', 'Ana');
    form.append('file', new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }), 'foto.jpg');
    const req = new Request('http://x', { method: 'POST', body: form });
    const res = await app.inject({
      method: 'POST',
      url: '/api/send-image',
      headers: { 'content-type': req.headers.get('content-type')! },
      payload: Buffer.from(await req.arrayBuffer()),
    });
    expect(res.statusCode).toBe(400);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('manda plantillas aprobadas con sus botones y rechaza las que no existen o no calzan', async () => {
    const { app, sent } = setup();
    const templates = { seguimiento: { language: 'es', body: 'Hola {{1}}, ¿pudo ver las opciones?', buttons: ['Sí', 'No, gracias'] } };
    const sim = buildSimulator({ gatewayUrl: 'http://localhost:3000', metaAppSecret: SECRET, phoneNumberId: PHONE, statusDelayMs: 0, templates,
      fetch: vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 })) });
    const tpl = (name: string, code: string, params: string[]) => ({
      messaging_product: 'whatsapp', to: '584141234567', type: 'template',
      template: { name, language: { code }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] },
    });
    const ok = await graph(sim as ReturnType<typeof setup>['app'], tpl('seguimiento', 'es', ['Ana']));
    expect(ok.statusCode).toBe(200);
    expect(sim.botMessages.at(-1)).toMatchObject({ text: 'Hola Ana, ¿pudo ver las opciones?', buttons: ['Sí', 'No, gracias'] });
    expect((await graph(sim as ReturnType<typeof setup>['app'], tpl('otra', 'es', ['Ana']))).json().error.code).toBe(132001);
    expect((await graph(sim as ReturnType<typeof setup>['app'], tpl('seguimiento', 'en', ['Ana']))).json().error.code).toBe(132001);
    expect((await graph(sim as ReturnType<typeof setup>['app'], tpl('seguimiento', 'es', []))).json().error.code).toBe(132000);

    // El toque de un botón llega al negocio como respuesta de botón, y se lee como texto.
    const res = await app.inject({ method: 'POST', url: '/api/send', payload: { from: '584141234567', name: 'Ana', text: 'Sí', button: true } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(sent[0]!.body);
    expect(body.entry[0].changes[0].value.messages[0]).toMatchObject({ type: 'button', button: { text: 'Sí' } });
    expect(parseWhatsAppWebhook(body)[0]).toMatchObject({ kind: 'message', text: 'Sí' });
  });

  it('el stream exige un número válido', async () => {
    expect((await setup().app.inject({ method: 'GET', url: '/api/stream?to=abc' })).statusCode).toBe(400);
  });
});

describe('simulador: conexión del número (registro insertado)', () => {
  it('responde como Graph al alta y manda el historial ficticio una sola vez', async () => {
    const { app, sent } = setup();
    // El cliente de alta real, apuntado al simulador.
    const viaSim: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const res = await app.inject({
        method: (init?.method ?? 'GET') as 'GET' | 'POST',
        url: url.pathname + url.search,
        headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
        ...(init?.body ? { payload: String(init.body) } : {}),
      });
      return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
    };
    const graph = { graphApiVersion: 'v27.0', graphBaseUrl: 'http://localhost:4010', fetch: viaSim };
    const { accessToken: token, expiresAt } = await exchangeSignupCode(graph, { appId: 'simulador', appSecret: 's', code: 'simulador' });
    expect(expiresAt).toBeNull();
    expect(token).toMatch(/^SIM-TOKEN-/);
    expect(await getPhoneInfo(graph, token, PHONE)).toMatchObject({ isOnBizApp: true, verifiedName: 'Simulador IMM' });
    await subscribeAppToWaba(graph, token, '100000000000999');
    expect(await requestSmbAppData(graph, token, PHONE, 'smb_app_state_sync')).toMatch(/^sim-/);
    expect(await requestSmbAppData(graph, token, PHONE, 'history')).toMatch(/^sim-/);
    await expect(requestSmbAppData(graph, token, PHONE, 'history')).rejects.toThrow('ya se pidió');

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(verifyMetaSignature(Buffer.from(sent[0]!.body), sent[0]!.signature, SECRET)).toBe(true);
    const events = parseWhatsAppWebhook(JSON.parse(sent[0]!.body));
    expect(events.map((e) => [e.kind, e.from?.externalUserId, e.history?.messages.length])).toEqual([
      ['history', '584247770001', 3],
      ['history', '584247770002', 2],
    ]);
    expect(events[0]!.history!.messages.map((m) => m.fromBusiness)).toEqual([false, true, false]);
  });
});

describe('simulador: leído y escribiendo', () => {
  it('acepta el "leído" de un mensaje real del cliente y lo avisa al navegador', async () => {
    const { app } = setup();
    const sent = await app.inject({ method: 'POST', url: '/api/send', payload: { from: '584141234567', name: 'Ana', text: 'Hola' } });
    const id = sent.json().id as string;
    const auth = { authorization: 'Bearer token' };
    const read = (message_id: string) =>
      app.inject({
        method: 'POST',
        url: `/v27.0/${PHONE}/messages`,
        headers: auth,
        payload: { messaging_product: 'whatsapp', status: 'read', message_id, typing_indicator: { type: 'text' } },
      });
    const ok = await read(id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ success: true });
    const bad = await read('wamid.NO-EXISTE');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe(131009);
  });
});

describe('simulador: Messenger e Instagram', () => {
  it('el cliente de Messenger escribe: el webhook va firmado a la URL de Messenger con la forma de Meta', async () => {
    const { app, sent } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/send', payload: { from: '24680135791', name: 'Laura Pérez', text: 'Hola', channel: 'messenger' } });
    expect(res.statusCode).toBe(200);
    expect(sent[0]!.url).toBe('http://localhost:3000/webhooks/meta/messenger');
    expect(verifyMetaSignature(Buffer.from(sent[0]!.body), sent[0]!.signature, SECRET)).toBe(true);
    const [event] = parseMetaMessagingWebhook(JSON.parse(sent[0]!.body));
    expect(event).toMatchObject({ channel: 'messenger', channelExternalAccountId: SIM_PAGE_ID, kind: 'message', from: { externalUserId: '24680135791' }, text: 'Hola' });
  });

  it('la foto del cliente de Instagram llega como url que el worker puede bajar', async () => {
    const { app, sent } = setup();
    const boundary = '----sim';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="from"\r\n\r\n17840000001\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nLaura\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="channel"\r\n\r\ninstagram\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/send-image', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, host: 'localhost:4010' }, payload: body });
    expect(res.statusCode).toBe(200);
    expect(sent[0]!.url).toBe('http://localhost:3000/webhooks/meta/instagram');
    const [event] = parseMetaMessagingWebhook(JSON.parse(sent[0]!.body));
    expect(event!.media![0]).toMatchObject({ type: 'image' });
    const url = new URL(event!.media![0]!.url!);
    expect(url.origin).toBe('http://localhost:4010');
    expect((await app.inject({ method: 'GET', url: url.pathname })).headers['content-type']).toBe('image/jpeg');
  });

  it('la página responde por la Send API: texto, Human Agent, "escribiendo…", entregas y perfil', async () => {
    const { app, sent } = setup();
    await app.inject({ method: 'POST', url: '/api/send', payload: { from: '24680135792', name: 'Laura Pérez', text: 'Hola', channel: 'messenger' } });
    const page = (payload: object) => app.inject({ method: 'POST', url: `/v27.0/${SIM_PAGE_ID}/messages`, headers: { authorization: 'Bearer t' }, payload });

    expect((await page({ recipient: { id: '24680135792' }, sender_action: 'typing_on' })).statusCode).toBe(200);
    const res = await page({ recipient: { id: '24680135792' }, messaging_type: 'RESPONSE', message: { text: 'Buenas' } });
    expect(res.statusCode).toBe(200);
    expect(app.botMessages.at(-1)).toMatchObject({ to: '24680135792', text: 'Buenas', channel: 'messenger' });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(parseMetaMessagingWebhook(JSON.parse(sent[1]!.body))[0]).toMatchObject({ kind: 'status', status: { externalMessageId: res.json().message_id, state: 'delivered' } });

    expect((await page({ recipient: { id: '24680135792' }, messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT', message: { text: 'Le escribo yo' } })).statusCode).toBe(200);
    expect((await page({ recipient: { id: '24680135792' }, messaging_type: 'MESSAGE_TAG', tag: 'ACCOUNT_UPDATE', message: { text: 'x' } })).statusCode).toBe(400);
    expect((await page({ recipient: { id: '999' }, message: { text: 'x' } })).statusCode).toBe(400);

    const profile = await app.inject({ method: 'GET', url: '/v27.0/24680135792?fields=first_name,last_name', headers: { authorization: 'Bearer t' } });
    expect(profile.json()).toMatchObject({ first_name: 'Laura', last_name: 'Pérez' });
    const info = await app.inject({ method: 'GET', url: `/v27.0/${SIM_PAGE_ID}?fields=name`, headers: { authorization: 'Bearer t' } });
    expect(info.json()).toMatchObject({ name: 'Simulador IMM', instagram_business_account: { id: SIM_INSTAGRAM_ID } });
  });

  it('WhatsApp recibe documentos y videos del asesor', async () => {
    const { app } = setup();
    const boundary = '----up';
    const upload = await app.inject({
      method: 'POST',
      url: `/v21.0/${PHONE}/media`,
      headers: { authorization: 'Bearer t', 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cotizacion.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4`),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(upload.statusCode).toBe(200);
    const res = await app.inject({
      method: 'POST',
      url: `/v21.0/${PHONE}/messages`,
      headers: { authorization: 'Bearer t' },
      payload: { messaging_product: 'whatsapp', to: '584141234567', type: 'document', document: { id: upload.json().id, filename: 'cotizacion.pdf', caption: 'Su cotización' } },
    });
    expect(res.statusCode).toBe(200);
    expect(app.botMessages.at(-1)).toMatchObject({ text: 'Su cotización', file: { name: 'cotizacion.pdf', kind: 'document' } });
  });
});
