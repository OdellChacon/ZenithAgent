/**
 * Envío por WhatsApp Cloud API: POST https://graph.facebook.com/{version}/{phone_number_id}/messages
 *
 * Por verificar en la documentación vigente de Meta antes de producción:
 * - largo máximo del texto (se asume 4096 caracteres);
 * - códigos de error de límite de tasa (se asumen 4, 80007, 130429 y 131056).
 */
export const WHATSAPP_MAX_TEXT_LENGTH = 4096;
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131056]);
const GRAPH_VERSION_RE = /^v\d+\.\d+$/;

export interface WhatsAppSendConfig {
  graphApiVersion: string;
  phoneNumberId: string;
  accessToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type SendResult =
  | { ok: true; externalMessageId: string }
  | { ok: false; retryable: boolean; httpStatus: number | null; errorCode?: number; message: string };

export class WhatsAppSendError extends Error {
  override name = 'WhatsAppSendError';
}

export async function sendWhatsAppText(config: WhatsAppSendConfig, to: string, body: string): Promise<SendResult> {
  if (!GRAPH_VERSION_RE.test(config.graphApiVersion)) {
    throw new WhatsAppSendError('META_GRAPH_API_VERSION debe tener la forma vNN.N');
  }
  if (!/^\d{6,20}$/.test(to)) throw new WhatsAppSendError('Número de destino inválido');
  const text = body.trim();
  if (!text) throw new WhatsAppSendError('El mensaje está vacío');
  if (text.length > WHATSAPP_MAX_TEXT_LENGTH) throw new WhatsAppSendError('El mensaje supera el largo máximo');

  const doFetch = config.fetch ?? fetch;
  const url = `https://graph.facebook.com/${config.graphApiVersion}/${encodeURIComponent(config.phoneNumberId)}/messages`;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });
  } catch (err) {
    // Red caída o timeout: se puede reintentar.
    return { ok: false, retryable: true, httpStatus: null, message: `Error de red: ${(err as Error).message}` };
  }

  const data = (await res.json().catch(() => null)) as
    | { messages?: { id?: string }[]; error?: { code?: number; message?: string } }
    | null;

  const id = data?.messages?.[0]?.id;
  if (res.ok && id) return { ok: true, externalMessageId: id };

  const errorCode = data?.error?.code;
  const retryable =
    res.status === 429 || res.status >= 500 || (errorCode !== undefined && RATE_LIMIT_CODES.has(errorCode));
  return {
    ok: false,
    retryable,
    httpStatus: res.status,
    ...(errorCode !== undefined ? { errorCode } : {}),
    message: data?.error?.message ?? `Respuesta inesperada de Meta (HTTP ${res.status})`,
  };
}
