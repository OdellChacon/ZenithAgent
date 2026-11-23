import { describe, expect, it, vi } from 'vitest';
import {
  parseWhatsAppWebhook,
  sendWhatsAppImage,
  sendWhatsAppText,
  uploadWhatsAppMedia,
  signMetaPayload,
  verifyMetaSignature,
  WhatsAppPayloadError,
  WhatsAppSendError,
} from '../src/index.js';
import { accountUpdateWebhook, echoWebhook, historyWebhook, imageWebhook, PHONE_NUMBER_ID, statusWebhook, textWebhook } from './fixtures.js';

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

  it('traduce la copia de lo que el negocio mandó desde la app', () => {
    const events = parseWhatsAppWebhook(
      echoWebhook([
        { from: '584140000000', to: '584141112233', to_user_id: 'VE.123', id: 'wamid.E1', timestamp: '1763632900', type: 'text', text: { body: 'Le paso la cotización' } },
        { from: '584140000000', to: '584141112233', id: 'wamid.E2', timestamp: 1763632901, type: 'image', image: { id: 'MEDIA9', mime_type: 'image/jpeg', caption: 'Así queda' } },
        { from: '584140000000', to: '584141112233', id: 'wamid.E3', timestamp: '1763632902', type: 'location' },
      ]),
    );
    expect(events).toEqual([
      {
        channel: 'whatsapp',
        channelExternalAccountId: PHONE_NUMBER_ID,
        externalEventId: 'echo:wamid.E1',
        externalMessageId: 'wamid.E1',
        kind: 'echo',
        occurredAt: new Date(1763632900 * 1000).toISOString(),
        to: { externalUserId: '584141112233', phone: '584141112233' },
        text: 'Le paso la cotización',
      },
      expect.objectContaining({
        kind: 'echo',
        externalMessageId: 'wamid.E2',
        text: 'Así queda',
        media: [{ type: 'image', externalMediaId: 'MEDIA9', mimeType: 'image/jpeg', caption: 'Así queda' }],
      }),
      expect.objectContaining({ kind: 'echo', externalMessageId: 'wamid.E3', unsupportedType: 'location' }),
    ]);
  });

  it('no trata como mensaje nuevo una edición, un borrado ni una copia sin destinatario', () => {
    const events = parseWhatsAppWebhook(
      echoWebhook([
        { from: '584140000000', to: '584141112233', id: 'wamid.E4', timestamp: '1763632903', type: 'revoke', revoke: { original_message_id: 'wamid.E1' } },
        { from: '584140000000', to: '584141112233', id: 'wamid.E5', timestamp: '1763632904', type: 'edit', edit: { original_message_id: 'wamid.E1' } },
        { from: '584140000000', to_user_id: 'VE.123', id: 'wamid.E6', timestamp: '1763632905', type: 'text', text: { body: 'Hola' } },
      ]),
    );
    expect(events.map((e) => [e.kind, e.unsupportedType])).toEqual([
      ['unsupported', 'echo_revoke'],
      ['unsupported', 'echo_edit'],
      ['unsupported', 'echo_sin_destinatario'],
    ]);
  });
});

describe('historial y avisos de conexión (coexistencia)', () => {
  const thread = (messages: Record<string, unknown>[]) => ({ id: '584141112233', context: { wa_id: '584141112233' }, messages });

  it('traduce cada chat del historial con quién escribió cada mensaje', () => {
    const events = parseWhatsAppWebhook(
      historyWebhook([
        {
          metadata: { phase: 0, chunk_order: 1, progress: 40 },
          threads: [
            thread([
              { from: '584141112233', from_user_id: 'VE.1', id: 'wamid.H1', timestamp: '1763600000', type: 'text', text: { body: 'Buenas, ¿tienen granito?' }, history_context: { status: 'READ' } },
              { from: '584140000000', id: 'wamid.H2', timestamp: '1763600100', type: 'text', text: { body: 'Buenas tardes, sí tenemos.' } },
              { from: '584141112233', id: 'wamid.H3', timestamp: '1763600200', type: 'media_placeholder' },
            ]),
            { context: { username: 'solo_usuario' }, messages: [{ id: 'wamid.H9', timestamp: '1763600000', type: 'text', text: { body: 'x' } }] },
          ],
        },
      ]),
    );
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({ kind: 'history', channelExternalAccountId: PHONE_NUMBER_ID, from: { externalUserId: '584141112233' } });
    expect(e.externalEventId).toMatch(/^history:584141112233:[0-9a-f]{24}$/);
    expect(e.occurredAt).toBe(new Date(1763600200 * 1000).toISOString());
    expect(e.history).toEqual({
      progress: 40,
      messages: [
        { externalMessageId: 'wamid.H1', fromBusiness: false, occurredAt: new Date(1763600000 * 1000).toISOString(), type: 'text', text: 'Buenas, ¿tienen granito?' },
        { externalMessageId: 'wamid.H2', fromBusiness: true, occurredAt: new Date(1763600100 * 1000).toISOString(), type: 'text', text: 'Buenas tardes, sí tenemos.' },
        { externalMessageId: 'wamid.H3', fromBusiness: false, occurredAt: new Date(1763600200 * 1000).toISOString(), type: 'media_placeholder' },
      ],
    });
  });

  it('da otra clave al aviso que trae el archivo de un mensaje ya recibido', () => {
    const placeholder = parseWhatsAppWebhook(
      historyWebhook([{ metadata: { progress: 100 }, threads: [thread([{ from: '584141112233', id: 'wamid.H3', timestamp: '1763600200', type: 'media_placeholder' }])] }]),
    );
    const media = parseWhatsAppWebhook(
      historyWebhook([
        {
          metadata: { progress: 100 },
          threads: [thread([{ from: '584141112233', id: 'wamid.H3', timestamp: '1763600200', type: 'image', image: { id: 'media-9', mime_type: 'image/jpeg', caption: 'Así la quiero' } }])],
        },
      ]),
    );
    expect(media[0]!.externalEventId).not.toBe(placeholder[0]!.externalEventId);
    expect(media[0]!.history!.messages[0]).toMatchObject({ type: 'image', text: 'Así la quiero', media: [{ type: 'image', externalMediaId: 'media-9' }] });
  });

  it('avisa cuando el negocio no compartió su historial', () => {
    const events = parseWhatsAppWebhook(historyWebhook([{ errors: [{ code: 2593109, title: 'History sync is turned off' }] }]));
    expect(events).toEqual([
      expect.objectContaining({ kind: 'account', channelExternalAccountId: PHONE_NUMBER_ID, account: { type: 'history_declined', scope: 'phone' } }),
    ]);
  });

  it('traduce desconexiones y reconexiones de la cuenta e ignora lo demás', () => {
    const removed = parseWhatsAppWebhook(
      accountUpdateWebhook({
        event: 'PARTNER_REMOVED',
        waba_info: { waba_id: '980198427658004', owner_business_id: '1' },
        disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
      }),
    );
    expect(removed).toEqual([
      {
        channel: 'whatsapp',
        channelExternalAccountId: '980198427658004',
        externalEventId: 'account:980198427658004:PARTNER_REMOVED:1763632800',
        kind: 'account',
        occurredAt: new Date(1763632800 * 1000).toISOString(),
        account: { type: 'disconnected', scope: 'waba', event: 'PARTNER_REMOVED', reason: 'PRIMARY_INACTIVITY' },
      },
    ]);
    // ACCOUNT_OFFBOARDED no trae waba_info: se usa entry.id.
    expect(parseWhatsAppWebhook(accountUpdateWebhook({ event: 'ACCOUNT_OFFBOARDED' }, '102290129340398'))[0]).toMatchObject({
      channelExternalAccountId: '102290129340398',
      account: { type: 'disconnected', event: 'ACCOUNT_OFFBOARDED' },
    });
    expect(parseWhatsAppWebhook(accountUpdateWebhook({ event: 'ACCOUNT_RECONNECTED' }))[0]!.account!.type).toBe('reconnected');
    expect(parseWhatsAppWebhook(accountUpdateWebhook({ event: 'VOLUME_BASED_PRICING_TIER_UPDATE' }))).toEqual([]);
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

  it('sube una foto como multipart y devuelve su id', async () => {
    const fetchMock = reply(200, { id: 'media-77' });
    const res = await uploadWhatsAppMedia({ ...base, fetch: fetchMock }, Buffer.from([1, 2, 3]), 'image/jpeg', 'foto.jpg');
    expect(res).toEqual({ ok: true, mediaId: 'media-77' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`);
    const form = init?.body as FormData;
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(form.get('type')).toBe('image/jpeg');
    expect((form.get('file') as File).size).toBe(3);
    expect((init?.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('rechaza fotos vacías o de más de 5 MB antes de llamar a Meta', async () => {
    const fetchMock = reply(200, {});
    await expect(uploadWhatsAppMedia({ ...base, fetch: fetchMock }, Buffer.alloc(0), 'image/png', 'x.png')).rejects.toThrow(WhatsAppSendError);
    await expect(uploadWhatsAppMedia({ ...base, fetch: fetchMock }, Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png', 'x.png')).rejects.toThrow(
      WhatsAppSendError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('envía la foto con su pie', async () => {
    const fetchMock = reply(200, { messages: [{ id: 'wamid.IMG9' }] });
    const res = await sendWhatsAppImage({ ...base, fetch: fetchMock }, '584141112233', 'media-77', ' Aconna Beige ');
    expect(res).toEqual({ ok: true, externalMessageId: 'wamid.IMG9' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      to: '584141112233',
      type: 'image',
      image: { id: 'media-77', caption: 'Aconna Beige' },
    });
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
