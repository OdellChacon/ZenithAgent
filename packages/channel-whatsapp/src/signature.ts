import { createHmac, timingSafeEqual } from 'node:crypto';

const HEADER_RE = /^sha256=([0-9a-f]{64})$/i;

/**
 * Verifica la cabecera `X-Hub-Signature-256` de Meta: HMAC-SHA256 del cuerpo crudo con el
 * App Secret. Debe recibir los bytes tal como llegaron, antes de parsear el JSON.
 */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!appSecret || !header) return false;
  const match = HEADER_RE.exec(header.trim());
  if (!match?.[1]) return false;
  const received = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Firma un cuerpo como lo haría Meta. Útil para pruebas y simuladores locales. */
export function signMetaPayload(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}
