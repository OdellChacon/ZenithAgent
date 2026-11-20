/**
 * Última barrera antes de enviar: el bot no tiene precios, así que cualquier monto en la
 * respuesta es inventado. También se cortan respuestas vacías o desmedidas.
 */
const MONEY_PATTERNS = [
  /(?:\$|US\$|USD|U\$S|€|EUR|Bs\.?S?|VES|COP)\s?\d/i,
  /\d[\d.,]*\s?(?:\$|USD|d[oó]lares?|bol[ií]vares?|euros?|Bs\b|pesos?)/i,
  /\bprecio\s+(?:es|de|:)\s*\d/i,
];

export const MAX_REPLY_CHARS = 1500;

export type ReplyCheck = { ok: true; text: string } | { ok: false; reason: 'empty' | 'mentions_price' | 'too_long' };

export function checkReply(raw: string): ReplyCheck {
  const text = raw.trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (MONEY_PATTERNS.some((re) => re.test(text))) return { ok: false, reason: 'mentions_price' };
  if (text.length > MAX_REPLY_CHARS) return { ok: false, reason: 'too_long' };
  return { ok: true, text };
}
