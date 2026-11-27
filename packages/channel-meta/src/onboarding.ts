/**
 * Conexión de una página de Facebook (Messenger) y de la cuenta de Instagram vinculada.
 * Con el token de la página:
 * 1. GET /{page_id}?fields=name,instagram_business_account{id,username} → nombre y cuenta de IG.
 * 2. POST /{page_id}/subscribed_apps con los campos de mensajería → la app recibe los webhooks.
 * Los campos de la página (Messenger) son messages, message_echoes, message_edits,
 * message_deliveries y messaging_postbacks. Instagram se suscribe en la configuración del
 * webhook de la app (objeto "instagram", campo messages).
 */
export interface MetaGraphConfig {
  graphApiVersion: string;
  graphBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class MetaOnboardingError extends Error {
  override name = 'MetaOnboardingError';
  constructor(
    message: string,
    readonly errorCode?: number,
  ) {
    super(message);
  }
}

export const MESSENGER_SUBSCRIBED_FIELDS = ['messages', 'message_echoes', 'message_edits', 'message_deliveries', 'messaging_postbacks'];

function url(config: MetaGraphConfig, path: string, query: Record<string, string> = {}): string {
  if (!/^v\d+\.\d+$/.test(config.graphApiVersion)) throw new MetaOnboardingError('META_GRAPH_API_VERSION debe tener la forma vNN.N');
  const base = new URL(config.graphBaseUrl ?? 'https://graph.facebook.com');
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') {
    throw new MetaOnboardingError('La URL de Graph API debe usar https');
  }
  const u = new URL(`/${config.graphApiVersion}/${path}`, base);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

async function call(config: MetaGraphConfig, method: 'GET' | 'POST', target: string, token: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await (config.fetch ?? fetch)(target, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new MetaOnboardingError(`No se pudo conectar con Meta: ${(err as Error).message}`);
  }
  const data = (await res.json().catch(() => null)) as { error?: { code?: number; message?: string } } | null;
  if (!res.ok || !data || data.error) throw new MetaOnboardingError(data?.error?.message ?? `Meta respondió ${res.status}`, data?.error?.code);
  return data as Record<string, unknown>;
}

export interface PageInfo {
  name: string | null;
  instagram: { id: string; username: string | null } | null;
}

export async function getPageInfo(config: MetaGraphConfig, token: string, pageId: string): Promise<PageInfo> {
  if (!/^\d{1,32}$/.test(pageId)) throw new MetaOnboardingError('Id de página inválido');
  const data = await call(config, 'GET', url(config, pageId, { fields: 'name,instagram_business_account{id,username}' }), token);
  const ig = data.instagram_business_account as { id?: unknown; username?: unknown } | undefined;
  return {
    name: typeof data.name === 'string' ? data.name : null,
    instagram: ig && typeof ig.id === 'string' ? { id: ig.id, username: typeof ig.username === 'string' ? ig.username : null } : null,
  };
}

export async function subscribePage(config: MetaGraphConfig, token: string, pageId: string): Promise<void> {
  if (!/^\d{1,32}$/.test(pageId)) throw new MetaOnboardingError('Id de página inválido');
  await call(config, 'POST', url(config, `${pageId}/subscribed_apps`, { subscribed_fields: MESSENGER_SUBSCRIBED_FIELDS.join(',') }), token);
}

/**
 * Nombre del cliente: en Messenger, first_name y last_name; en Instagram, name y username.
 * Necesita los permisos de la app; si Meta no lo da, devuelve null y el contacto queda sin nombre.
 */
export async function getMetaProfile(
  config: MetaGraphConfig,
  token: string,
  channel: 'messenger' | 'instagram',
  userId: string,
): Promise<string | null> {
  if (!/^\d{1,40}$/.test(userId)) return null;
  try {
    const fields = channel === 'messenger' ? 'first_name,last_name' : 'name,username';
    const data = await call(config, 'GET', url(config, userId, { fields }), token);
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const name =
      channel === 'messenger'
        ? [str(data.first_name), str(data.last_name)].filter(Boolean).join(' ') || null
        : (str(data.name) ?? (str(data.username) ? `@${str(data.username)}` : null));
    return name ? name.slice(0, 120) : null;
  } catch {
    return null;
  }
}
