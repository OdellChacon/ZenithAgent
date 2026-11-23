/**
 * Registro insertado de Meta (Embedded Signup v5) en el navegador. Abre la ventana de Meta,
 * donde el negocio elige su cuenta y su número, y devuelve el código que el servidor canjea.
 * En v5 la coexistencia (número que sigue en la app WhatsApp Business) viene activada.
 */

export interface SignupConfig {
  enabled: boolean;
  canConnect: boolean;
  appId?: string;
  configId?: string;
  graphApiVersion?: string;
  simulated?: { phoneNumberId: string } | null;
}

export interface SignupResult {
  code: string;
  phoneNumberId: string;
  wabaId: string;
}

interface FacebookSdk {
  init(opts: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(cb: (res: { authResponse?: { code?: string } | null }) => void, opts: Record<string, unknown>): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let sdk: Promise<FacebookSdk> | null = null;

function loadSdk(appId: string, version: string): Promise<FacebookSdk> {
  sdk ??= new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      sdk = null;
      reject(new Error('No se pudo cargar la ventana de Meta. Revisa la conexión o si hay un bloqueador de anuncios.'));
    };
    document.body.appendChild(script);
  });
  return sdk;
}

const fromFacebook = (origin: string) => {
  try {
    const host = new URL(origin).hostname;
    return host === 'facebook.com' || host.endsWith('.facebook.com');
  } catch {
    return false;
  }
};

export async function runEmbeddedSignup(cfg: SignupConfig): Promise<SignupResult> {
  if (!cfg.appId || !cfg.configId || !cfg.graphApiVersion) throw new Error('Falta la configuración de Meta');
  const FB = await loadSdk(cfg.appId, cfg.graphApiVersion);

  // Meta manda el número y la cuenta elegidos por postMessage, aparte del código.
  let session: { phoneNumberId?: string; wabaId?: string } = {};
  let failure: string | null = null;
  const onMessage = (e: MessageEvent) => {
    if (!fromFacebook(e.origin)) return;
    let msg: { type?: string; event?: string; data?: Record<string, unknown> };
    try {
      msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch {
      return;
    }
    if (msg?.type !== 'WA_EMBEDDED_SIGNUP') return;
    const d = msg.data ?? {};
    if (msg.event === 'FINISH' || msg.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
      // v4 manda waba_id; v5, messaging_account_ids.
      const ids = d.messaging_account_ids;
      const waba = typeof d.waba_id === 'string' ? d.waba_id : Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : undefined;
      session = { ...(typeof d.phone_number_id === 'string' ? { phoneNumberId: d.phone_number_id } : {}), ...(waba ? { wabaId: waba } : {}) };
    } else if (msg.event === 'ERROR') {
      failure = typeof d.error_message === 'string' ? d.error_message : 'Meta informó un error en el registro';
    }
  };
  window.addEventListener('message', onMessage);
  try {
    const code = await new Promise<string>((resolve, reject) =>
      FB.login(
        (res) => {
          const c = res.authResponse?.code;
          if (c) resolve(c);
          else reject(new Error(failure ?? 'Se cerró la ventana de Meta sin terminar el registro.'));
        },
        { config_id: cfg.configId, response_type: 'code', override_default_response_type: true, extras: { version: 'v5' } },
      ),
    );
    // El aviso con el número puede llegar justo después del código.
    for (let i = 0; i < 30 && !(session.phoneNumberId && session.wabaId); i++) await new Promise((r) => setTimeout(r, 100));
    if (!session.phoneNumberId || !session.wabaId) throw new Error(failure ?? 'Meta no informó qué número se eligió. Vuelve a intentarlo.');
    return { code, phoneNumberId: session.phoneNumberId, wabaId: session.wabaId };
  } finally {
    window.removeEventListener('message', onMessage);
  }
}
