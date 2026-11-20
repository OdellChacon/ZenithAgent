import { describe, expect, it, vi } from 'vitest';
import {
  parseWhatsAppWebhook,
  sendWhatsAppText,
  signMetaPayload,
  verifyMetaSignature,
  WhatsAppPayloadError,
  WhatsAppSendError,
} from '../src/index.js';
import { imageWebhook, PHONE_NUMBER_ID, statusWebhook, textWebhook } from './fixtures.js';

const SECRET = 'app-secret-de-prueba';

describe('verifyMetaSignature', () => {
  const body = Buffer.from(JSON.stringify(textWebhook()));

  it('acepta una firma correcta', () => {
    expect(verifyMetaSignature(body, signMetaPayload(body, SECRET), SECRET)).toBe(true);
  });

  it('rechaza si el cuerpo fue alterado', () => {
    const tampered = Buffer.from(body.toString().replace('exterior', 'interior'));
    expect(verifyMetaSignature(tampered, signMetaPayload(body, SECRET), SECRET)).toBe(false);
  });

  it('rechaza otro secreto, cabecera ausente o mal formada', () => {
    expect(verifyMetaSignature(body, signMetaPayload(body, 'otro'), SECRET)).toBe(false);
    expect(verifyMetaSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(body, 'sha1=abc', SECRET)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=zz', SECRET)).toBe(false);
  });

  it('rechaza todo si no hay secreto configurado', () => {
    expect(verifyMetaSignature(body, signMetaPayload(body, ''), '')).toBe(false);
  });
});

describe('parseWhatsAppWebhook', () => {
  it('traduce un mensaje de texto', () => {
    const [event] = parseWhatsAppWebhook(textWebhook());
    expect(event).toEqual({
      channel: 'whatsapp',
      channelExternalAccountId: PHONE_NUMBER_ID,
      externalEventId: 'msg:wamid.TEXT1',
      externalMessageId: 'wamid.TEXT1',
      kind: 'message',
      occurredAt: '2025-11-20T10:00:00.000Z',
      from: { externalUserId: '584141112233', phone: '584141112233', displayName: 'Cliente Prueba' },
      text: '¿Tienen porcelanato para exterior?',
    });
  });

  it('traduce imágenes con su leyenda y marca como no soportado lo demás', () => {
    const [img, loc] = parseWhatsAppWebhook(imageWebhook);
    expect(img?.kind).toBe('message');
    expect(img?.media).toEqual([
      { type: 'image', externalMediaId: 'media-123', mimeType: 'image/jpeg', caption: '¿Tienen esta cerámica?' },
    ]);
    expect(img?.text).toBe('¿Tienen esta cerámica?');
    expect(loc).toMatchObject({ kind: 'unsupported', unsupportedType: 'location', externalEventId: 'msg:wamid.LOC1' });
  });

  it('traduce estados de entrega e ignora estados desconocidos', () => {
    const events = parseWhatsAppWebhook(statusWebhook);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'status',
      externalEventId: 'status:wamid.OUT1:delivered',
      status: { externalMessageId: 'wamid.OUT1', state: 'delivered' },
    });
    expect(events[1]?.status).toEqual({ externalMessageId: 'wamid.OUT2', state: 'failed', errorCode: '131047' });
  });

  it('rechaza sobres que no son de WhatsApp', () => {
    expect(() => parseWhatsAppWebhook({ object: 'page', entry: [] })).toThrow(WhatsAppPayloadError);
    expect(() => parseWhatsAppWebhook(null)).toThrow(WhatsAppPayloadError);
  });

  it('descarta cambios malformados sin perder los válidos', () => {
    const body = textWebhook();
    body.entry[0]!.changes.unshift({ field: 'messages', value: { nada: true } } as never);
    expect(parseWhatsAppWebhook(body)).toHaveLength(1);
  });
});

describe('sendWhatsAppText', () => {
  const base = { graphApiVersion: 'v21.0', phoneNumberId: PHONE_NUMBER_ID, accessToken: 'token' };
  const reply = (status: number, body: unknown) =>
    vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it('envía el texto y devuelve el id del mensaje', async () => {
    const fetchMock = reply(200, { messages: [{ id: 'wamid.OUT9' }] });
    const res = await sendWhatsAppText({ ...base, fetch: fetchMock }, '584141112233', '  Hola  ');
    expect(res).toEqual({ ok: true, externalMessageId: 'wamid.OUT9' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ to: '584141112233', type: 'text', text: { body: 'Hola' } });
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token');
  });

  it('marca como reintentable el límite de tasa y los 5xx', async () => {
    expect(await sendWhatsAppText({ ...base, fetch: reply(429, {}) }, '584141112233', 'x')).toMatchObject({ ok: false, retryable: true });
    expect(await sendWhatsAppText({ ...base, fetch: reply(503, {}) }, '584141112233', 'x')).toMatchObject({ ok: false, retryable: true });
    expect(
      await sendWhatsAppText({ ...base, fetch: reply(400, { error: { code: 130429, message: 'rate' } }) }, '584141112233', 'x'),
    ).toMatchObject({ ok: false, retryable: true, errorCode: 130429 });
  });

  it('no reintenta errores permanentes', async () => {
    const res = await sendWhatsAppText(
      { ...base, fetch: reply(400, { error: { code: 131047, message: 'Fuera de la ventana de 24 h' } }) },
      '584141112233',
      'x',
    );
    expect(res).toEqual({ ok: false, retryable: false, httpStatus: 400, errorCode: 131047, message: 'Fuera de la ventana de 24 h' });
  });

  it('reintenta errores de red', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNRESET'));
    expect(await sendWhatsAppText({ ...base, fetch: fetchMock }, '584141112233', 'x')).toMatchObject({ ok: false, retryable: true, httpStatus: null });
  });

  it('valida entradas antes de llamar a Meta', async () => {
    const fetchMock = reply(200, {});
    await expect(sendWhatsAppText({ ...base, fetch: fetchMock }, '+58 414', 'x')).rejects.toThrow(WhatsAppSendError);
    await expect(sendWhatsAppText({ ...base, fetch: fetchMock }, '584141112233', '   ')).rejects.toThrow(WhatsAppSendError);
    await expect(sendWhatsAppText({ ...base, fetch: fetchMock }, '584141112233', 'x'.repeat(4097))).rejects.toThrow(WhatsAppSendError);
    await expect(sendWhatsAppText({ ...base, graphApiVersion: 'latest', fetch: fetchMock }, '584141112233', 'x')).rejects.toThrow(WhatsAppSendError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
