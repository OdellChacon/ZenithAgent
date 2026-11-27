import { describe, expect, it, vi } from 'vitest';
import {
  downloadMetaUrl,
  isMetaCdnUrl,
  MetaPayloadError,
  parseMetaMessagingWebhook,
  sendMetaAttachment,
  sendMetaText,
  splitForMetaChannel,
  uploadMetaAttachment,
  INSTAGRAM_MAX_TEXT_BYTES,
} from '../src/index.js';

const PAGE = '111222333';
const IG = '17841400000000';
const PSID = '24680135791';

const webhook = (object: 'page' | 'instagram', accountId: string, messaging: unknown[]) => ({ object, entry: [{ id: accountId, time: 1764200000000, messaging }] });
const event = (over: Record<string, unknown>) => ({ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1764200000000, ...over });

describe('parseMetaMessagingWebhook', () => {
  it('traduce un mensaje de texto de Messenger', () => {
    const [e] = parseMetaMessagingWebhook(webhook('page', PAGE, [event({ message: { mid: 'm_1', text: 'Hola, ¿tienen porcelanato?' } })]));
    expect(e).toEqual({
      channel: 'messenger',
      channelExternalAccountId: PAGE,
      occurredAt: new Date(1764200000000).toISOString(),
      kind: 'message',
      externalEventId: 'msg:m_1',
      externalMessageId: 'm_1',
      from: { externalUserId: PSID },
      text: 'Hola, ¿tienen porcelanato?',
    });
  });

  it('traduce fotos, audios y archivos de Instagram con su url del CDN', () => {
    const [e] = parseMetaMessagingWebhook(
      webhook('instagram', IG, [
        event({
          recipient: { id: IG },
          message: {
            mid: 'ig_1',
            attachments: [
              { type: 'image', payload: { url: 'https://scontent.cdninstagram.com/a.jpg' } },
              { type: 'file', payload: { url: 'https://lookaside.fbsbx.com/f.pdf', title: 'plano.pdf' } },
            ],
          },
        }),
      ]),
    );
    expect(e!.channel).toBe('instagram');
    expect(e!.media).toEqual([
      { type: 'image', externalMediaId: '', url: 'https://scontent.cdninstagram.com/a.jpg' },
      { type: 'document', externalMediaId: '', url: 'https://lookaside.fbsbx.com/f.pdf', filename: 'plano.pdf' },
    ]);
  });

  it('una copia sin app_id es un asesor escribiendo a mano; con app_id la mandó una app y se ignora', () => {
    const events = parseMetaMessagingWebhook(
      webhook('page', PAGE, [
        event({ sender: { id: PAGE }, recipient: { id: PSID }, message: { mid: 'm_2', is_echo: true, text: 'Le escribo yo' } }),
        event({ sender: { id: PAGE }, recipient: { id: PSID }, message: { mid: 'm_3', is_echo: true, app_id: 123, text: 'Respuesta del bot' } }),
      ]),
    );
    expect(events[0]).toMatchObject({ kind: 'echo', externalMessageId: 'm_2', to: { externalUserId: PSID }, text: 'Le escribo yo' });
    expect(events[1]).toMatchObject({ kind: 'unsupported', unsupportedType: 'echo_api' });
  });

  it('traduce ediciones (Messenger), borrados (Instagram), entregas y botones', () => {
    const edits = parseMetaMessagingWebhook(webhook('page', PAGE, [event({ message_edit: { mid: 'm_1', text: 'Mejor 20 m²', num_edit: 1 } })]));
    expect(edits[0]).toMatchObject({ kind: 'edit', edit: { originalExternalMessageId: 'm_1', action: 'edit', byBusiness: false, text: 'Mejor 20 m²' } });

    const deleted = parseMetaMessagingWebhook(webhook('instagram', IG, [event({ message: { mid: 'ig_9', is_deleted: true } })]));
    expect(deleted[0]).toMatchObject({ kind: 'edit', edit: { originalExternalMessageId: 'ig_9', action: 'revoke' } });

    const delivered = parseMetaMessagingWebhook(webhook('page', PAGE, [event({ delivery: { mids: ['m_a', 'm_b'], watermark: 1 } })]));
    expect(delivered.map((d) => [d.kind, d.status?.externalMessageId, d.status?.state])).toEqual([
      ['status', 'm_a', 'delivered'],
      ['status', 'm_b', 'delivered'],
    ]);

    const button = parseMetaMessagingWebhook(webhook('page', PAGE, [event({ postback: { title: 'Ver catálogo', payload: 'CAT', mid: 'm_p' } })]));
    expect(button[0]).toMatchObject({ kind: 'message', text: 'Ver catálogo', externalMessageId: 'm_p' });
  });

  it('descarta eventos raros sin tumbar el resto y rechaza sobres que no son de Meta', () => {
    const events = parseMetaMessagingWebhook(webhook('page', PAGE, [{ basura: true }, event({ message: { mid: 'm_ok', text: 'hola' } })]));
    expect(events.map((e) => e.externalMessageId)).toEqual(['m_ok']);
    expect(() => parseMetaMessagingWebhook({ object: 'whatsapp_business_account', entry: [] })).toThrow(MetaPayloadError);
  });
});

describe('envío por la Send API', () => {
  const ok = (body: unknown) => vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
  const config = (fetchFn: typeof fetch, channel: 'messenger' | 'instagram' = 'messenger') => ({
    graphApiVersion: 'v27.0',
    pageId: PAGE,
    accessToken: 'PAGE-TOKEN',
    channel,
    fetch: fetchFn,
  });

  it('responde dentro de 24 h con messaging_type RESPONSE', async () => {
    const fetchMock = ok({ recipient_id: PSID, message_id: 'm_out' });
    expect(await sendMetaText(config(fetchMock), PSID, 'Hola')).toEqual({ ok: true, externalMessageId: 'm_out' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://graph.facebook.com/v27.0/${PAGE}/messages`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer PAGE-TOKEN');
    expect(JSON.parse(String(init?.body))).toEqual({ recipient: { id: PSID }, messaging_type: 'RESPONSE', message: { text: 'Hola' } });
  });

  it('un asesor entre 24 h y 7 días responde con la etiqueta Human Agent', async () => {
    const fetchMock = ok({ message_id: 'm_out' });
    await sendMetaText(config(fetchMock), PSID, 'Le escribo yo', { humanAgent: true });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' });
  });

  it('parte en varios mensajes un texto que no entra en Instagram (1000 bytes)', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `Párrafo número ${i} con acentos: cerámica, porcelanato, baño.`).join('\n\n');
    const parts = splitForMetaChannel(long, 'instagram');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(INSTAGRAM_MAX_TEXT_BYTES);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '));
    const fetchMock = ok({ message_id: 'm_x' });
    await sendMetaText(config(fetchMock, 'instagram'), PSID, long);
    expect(fetchMock).toHaveBeenCalledTimes(parts.length);
  });

  it('sube un archivo y lo manda por su attachment_id, con el pie como texto aparte', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ attachment_id: 'att_1' }), { status: 200 }))
      .mockImplementation(async () => new Response(JSON.stringify({ message_id: 'm_y' }), { status: 200 }));
    const up = await uploadMetaAttachment(config(fetchMock), Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg', 'image', 'foto.jpg');
    expect(up).toEqual({ ok: true, attachmentId: 'att_1' });
    expect(fetchMock.mock.calls[0]![0]).toBe(`https://graph.facebook.com/v27.0/${PAGE}/message_attachments`);
    const form = fetchMock.mock.calls[0]![1]?.body as FormData;
    expect(JSON.parse(String(form.get('message')))).toEqual({ attachment: { type: 'image', payload: { is_reusable: true } } });

    await sendMetaAttachment(config(fetchMock), PSID, { type: 'image', attachmentId: 'att_1', caption: 'Este es el modelo' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)).message).toEqual({ attachment: { type: 'image', payload: { attachment_id: 'att_1' } } });
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body)).message).toEqual({ text: 'Este es el modelo' });
  });

  it('distingue token rechazado, límite de tasa y errores definitivos', async () => {
    const fail = (status: number, code: number) =>
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code, message: 'x' } }), { status }));
    expect(await sendMetaText(config(fail(400, 190)), PSID, 'x')).toMatchObject({ ok: false, retryable: false, authError: true });
    expect(await sendMetaText(config(fail(400, 613)), PSID, 'x')).toMatchObject({ ok: false, retryable: true });
    expect(await sendMetaText(config(fail(400, 10)), PSID, 'x')).toMatchObject({ ok: false, retryable: false, errorCode: 10 });
  });
});

describe('descarga del CDN de Meta', () => {
  it('solo baja de hosts de Meta (o del simulador local)', () => {
    expect(isMetaCdnUrl('https://scontent.xx.fbcdn.net/v/a.jpg')).toBe(true);
    expect(isMetaCdnUrl('https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1')).toBe(true);
    expect(isMetaCdnUrl('https://evil.example.com/fbcdn.net')).toBe(false);
    expect(isMetaCdnUrl('http://scontent.fbcdn.net/a.jpg')).toBe(false);
    expect(isMetaCdnUrl('http://localhost:4010/sim-media/1', 'http://localhost:4010')).toBe(true);
  });

  it('respeta el tipo y el tamaño máximo', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => new Response(Buffer.alloc(10), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const allowed = new Set(['image/jpeg']);
    expect(await downloadMetaUrl('https://a.fbcdn.net/x.jpg', { maxBytes: 100, allowedMimeTypes: allowed, fetch: fetchFn })).toMatchObject({ ok: true, mimeType: 'image/jpeg' });
    expect(await downloadMetaUrl('https://a.fbcdn.net/x.jpg', { maxBytes: 5, allowedMimeTypes: allowed, fetch: fetchFn })).toMatchObject({ ok: false });
    expect(await downloadMetaUrl('https://a.fbcdn.net/x.jpg', { maxBytes: 100, allowedMimeTypes: new Set(['video/mp4']), fetch: fetchFn })).toMatchObject({
      ok: false,
    });
    expect(await downloadMetaUrl('https://otro.com/x.jpg', { maxBytes: 100, allowedMimeTypes: allowed, fetch: fetchFn })).toMatchObject({ ok: false });
  });
});
