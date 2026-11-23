/**
 * Alta de un número por Embedded Signup (registro insertado de Meta), como Tech Provider.
 * Documentación revisada el 23/11/2026 (Embedded Signup v5):
 * 1. El panel abre el registro de Meta y recibe un código (vence a los 5 minutos).
 * 2. El servidor lo canjea por un token de negocio (GET /oauth/access_token).
 * 3. Suscribe la app a los webhooks de la cuenta (POST /{waba_id}/subscribed_apps).
 * 4. Si el número es nuevo en la API, lo registra con un PIN (POST /{phone_number_id}/register).
 *    Si ya usaba la app WhatsApp Business (coexistencia), ese paso se omite.
 * 5. En coexistencia pide, una sola vez y dentro de 24 h, los contactos y luego el historial
 *    (POST /{phone_number_id}/smb_app_data).
 * Todas las llamadas son de servidor a servidor: el secreto de la app nunca va al navegador.
 */

export interface GraphConfig {
  graphApiVersion: string;
  /** Solo para pruebas locales contra el simulador. Por defecto, Graph API de Meta. */
  graphBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class WhatsAppOnboardingError extends Error {
  override name = 'WhatsAppOnboardingError';
  constructor(
    /** Paso que falló, para decírselo al negocio. */
    readonly step: 'code' | 'phone' | 'subscribe' | 'register' | 'sync',
    message: string,
    readonly errorCode?: number,
  ) {
    super(message);
  }
}

const GRAPH_VERSION_RE = /^v\d+\.\d+$/;
const ID_RE = /^\d{1,32}$/;

function graphUrl(config: GraphConfig, path: string, query?: Record<string, string>): string {
  if (!GRAPH_VERSION_RE.test(config.graphApiVersion)) throw new Error('META_GRAPH_API_VERSION debe tener la forma vNN.N');
  const base = new URL(config.graphBaseUrl ?? 'https://graph.facebook.com');
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') {
    throw new Error('La URL de Graph API debe usar https');
  }
  const url = new URL(`/${config.graphApiVersion}/${path}`, base);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

async function call(
  config: GraphConfig,
  step: WhatsAppOnboardingError['step'],
  url: string,
  init: { method: 'GET' | 'POST'; token?: string; body?: unknown },
): Promise<Record<string, unknown>> {
  const doFetch = config.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: init.method,
      headers: {
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new WhatsAppOnboardingError(step, `No se pudo conectar con Meta: ${(err as Error).message}`);
  }
  const data = (await res.json().catch(() => null)) as { error?: { code?: number; message?: string } } | null;
  if (!res.ok || !data || data.error) {
    throw new WhatsAppOnboardingError(step, data?.error?.message ?? `Meta respondió ${res.status}`, data?.error?.code);
  }
  return data as Record<string, unknown>;
}

function requireId(step: WhatsAppOnboardingError['step'], value: string, name: string) {
  if (!ID_RE.test(value)) throw new WhatsAppOnboardingError(step, `${name} inválido`);
}

/** Canjea el código del registro por el token de negocio del cliente. */
export async function exchangeSignupCode(
  config: GraphConfig,
  opts: { appId: string; appSecret: string; code: string },
): Promise<string> {
  if (!opts.appId || !opts.appSecret) throw new WhatsAppOnboardingError('code', 'Faltan META_APP_ID o META_APP_SECRET');
  const data = await call(
    config,
    'code',
    graphUrl(config, 'oauth/access_token', { client_id: opts.appId, client_secret: opts.appSecret, code: opts.code }),
    { method: 'GET' },
  );
  if (typeof data.access_token !== 'string' || !data.access_token) throw new WhatsAppOnboardingError('code', 'Meta no devolvió el token');
  return data.access_token;
}

export interface PhoneInfo {
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  /** El número sigue en la app WhatsApp Business (coexistencia). */
  isOnBizApp: boolean;
  platformType: string | null;
}

/** Datos del número; también confirma que el token tiene acceso a él. */
export async function getPhoneInfo(config: GraphConfig, token: string, phoneNumberId: string): Promise<PhoneInfo> {
  requireId('phone', phoneNumberId, 'phone_number_id');
  const data = await call(
    config,
    'phone',
    graphUrl(config, encodeURIComponent(phoneNumberId), { fields: 'display_phone_number,verified_name,is_on_biz_app,platform_type' }),
    { method: 'GET', token },
  );
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    displayPhoneNumber: str(data.display_phone_number),
    verifiedName: str(data.verified_name),
    isOnBizApp: data.is_on_biz_app === true,
    platformType: str(data.platform_type),
  };
}

/** Suscribe la app a los webhooks de la cuenta de WhatsApp Business del cliente. */
export async function subscribeAppToWaba(config: GraphConfig, token: string, wabaId: string): Promise<void> {
  requireId('subscribe', wabaId, 'waba_id');
  await call(config, 'subscribe', graphUrl(config, `${encodeURIComponent(wabaId)}/subscribed_apps`), { method: 'POST', token });
}

/** Registra un número nuevo en la API. El PIN de 6 dígitos queda como verificación en dos pasos. */
export async function registerPhone(config: GraphConfig, token: string, phoneNumberId: string, pin: string): Promise<void> {
  requireId('register', phoneNumberId, 'phone_number_id');
  if (!/^\d{6}$/.test(pin)) throw new WhatsAppOnboardingError('register', 'El PIN debe tener 6 dígitos');
  await call(config, 'register', graphUrl(config, `${encodeURIComponent(phoneNumberId)}/register`), {
    method: 'POST',
    token,
    body: { messaging_product: 'whatsapp', pin },
  });
}

/**
 * Pide a Meta los contactos (smb_app_state_sync) o el historial (history) de la app. Cada uno
 * se puede pedir una sola vez; repetirlo exige desconectar y volver a conectar el número.
 * Devuelve el request_id (solo confirma que Meta recibió el pedido).
 */
export async function requestSmbAppData(
  config: GraphConfig,
  token: string,
  phoneNumberId: string,
  syncType: 'smb_app_state_sync' | 'history',
): Promise<string | null> {
  requireId('sync', phoneNumberId, 'phone_number_id');
  const data = await call(config, 'sync', graphUrl(config, `${encodeURIComponent(phoneNumberId)}/smb_app_data`), {
    method: 'POST',
    token,
    body: { messaging_product: 'whatsapp', sync_type: syncType },
  });
  return typeof data.request_id === 'string' ? data.request_id : null;
}
