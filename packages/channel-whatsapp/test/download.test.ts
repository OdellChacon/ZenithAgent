import { describe, expect, it } from 'vitest';
import { downloadWhatsAppMedia, isTrustedMediaUrl } from '../src/index.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function fakeMeta(opts: { url?: string; contentType?: string; body?: Buffer; fileSize?: number; infoStatus?: number } = {}) {
  const calls: { url: string; auth: string | null; redirect?: RequestInit['redirect'] }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get('authorization'), ...(init?.redirect ? { redirect: init.redirect } : {}) });
    if (url.includes('/v21.0/')) {
      return new Response(
        JSON.stringify({ url: opts.url ?? 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'image/jpeg', file_size: opts.fileSize ?? 8 }),
        { status: opts.infoStatus ?? 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(new Uint8Array(opts.body ?? JPEG), { status: 200, headers: { 'content-type': opts.contentType ?? 'image/jpeg' } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const config = (fetchFn: typeof fetch, extra: object = {}) => ({ graphApiVersion: 'v21.0', accessToken: 'TOKEN', fetch: fetchFn, ...extra });

describe('downloadWhatsAppMedia', () => {
  it('pide la url del archivo y luego lo descarga con el token, sin seguir redirecciones', async () => {
    const { fetchFn, calls } = fakeMeta();
    const res = await downloadWhatsAppMedia(config(fetchFn), 'MEDIA123');
    expect(res).toEqual({ ok: true, data: JPEG, mimeType: 'image/jpeg' });
    expect(calls[0]?.url).toBe('https://graph.facebook.com/v21.0/MEDIA123');
    expect(calls.every((c) => c.auth === 'Bearer TOKEN' && c.redirect === 'error')).toBe(true);
  });

  it('no manda el token a una url que no es de Meta', async () => {
    const { fetchFn, calls } = fakeMeta({ url: 'https://evil.example.com/robar' });
    const res = await downloadWhatsAppMedia(config(fetchFn), 'MEDIA123');
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('rechaza archivos grandes o de otro tipo', async () => {
    const big = fakeMeta({ fileSize: 10 * 1024 * 1024 });
    expect((await downloadWhatsAppMedia(config(big.fetchFn), 'M1')).ok).toBe(false);
    const overflow = fakeMeta({ body: Buffer.alloc(64), fileSize: 8 });
    expect((await downloadWhatsAppMedia(config(overflow.fetchFn, { maxBytes: 32 }), 'M1')).ok).toBe(false);
    const pdf = fakeMeta({ contentType: 'application/pdf' });
    expect((await downloadWhatsAppMedia(config(pdf.fetchFn), 'M1')).ok).toBe(false);
  });

  it('marca como reintentable un error 5xx de Meta', async () => {
    const { fetchFn } = fakeMeta({ infoStatus: 503 });
    expect(await downloadWhatsAppMedia(config(fetchFn), 'M1')).toMatchObject({ ok: false, retryable: true });
  });

  it('rechaza ids con caracteres raros', async () => {
    const { fetchFn, calls } = fakeMeta();
    expect((await downloadWhatsAppMedia(config(fetchFn), '../me')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('isTrustedMediaUrl', () => {
  it('acepta hosts de Meta por https y el simulador local configurado', () => {
    expect(isTrustedMediaUrl('https://lookaside.fbsbx.com/x')).toBe(true);
    expect(isTrustedMediaUrl('http://lookaside.fbsbx.com/x')).toBe(false);
    expect(isTrustedMediaUrl('https://fbsbx.com.evil.com/x')).toBe(false);
    expect(isTrustedMediaUrl('http://localhost:4010/sim-media/1', 'http://localhost:4010')).toBe(true);
    expect(isTrustedMediaUrl('http://localhost:9999/x', 'http://localhost:4010')).toBe(false);
    expect(isTrustedMediaUrl('http://localhost:4010/x')).toBe(false);
  });
});
