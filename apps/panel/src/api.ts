export type View = 'pending' | 'mine' | 'all';
export type WindowState = 'FREE' | 'TEMPLATE_ONLY' | 'HUMAN_AGENT_ONLY' | 'CLOSED';

export interface Me {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'agent';
  tenant: { id: string; name: string };
}

export interface ConversationSummary {
  id: string;
  contactName: string;
  channel: string;
  mode: 'bot' | 'human';
  status: string;
  assignedTo: { id: string; name: string } | null;
  lastMessage: { body: string | null; author: string; type: string; at: string } | null;
  handoff: { reason: string; summary: string | null; requestedAt: string } | null;
  windowExpiresAt: string | null;
  updatedAt: string;
}

export interface Message {
  id: string;
  direction: 'in' | 'out';
  author: 'customer' | 'bot' | 'agent' | 'system';
  type: string;
  body: string | null;
  sentBy: string | null;
  delivery: string | null;
  imageId: string | null;
  /** Mensaje de seguimiento automático: 1 = del bot, 2 = plantilla. */
  followup: 1 | 2 | null;
  at: string;
}

export interface ConversationDetail {
  id: string;
  mode: 'bot' | 'human';
  status: string;
  channel: string;
  contact: { id: string; name: string; phone: string | null; tags: string[] };
  assignedTo: { id: string; name: string } | null;
  window: { state: WindowState; expiresAt: string | null };
  handoff: { reason: string; summary: string | null; requestedAt: string; takenAt: string | null; returnedAt: string | null } | null;
  messages: Message[];
}

export interface ContactSummary {
  id: string;
  name: string;
  phone: string | null;
  channels: string[];
  tags: string[];
  notes: string | null;
  optOutFollowups: boolean;
  lastActivityAt: string;
  conversation: { id: string; mode: 'bot' | 'human'; status: string; waitingAdvisor: boolean } | null;
  lastHandoffReason: string | null;
  followupSent: boolean;
  /** Productos que el bot le mostró con foto (los más recientes) y sus categorías. */
  interest: { products: string[]; categories: string[] };
}

export interface ContactDetail extends ContactSummary {
  conversations: {
    id: string;
    mode: string;
    status: string;
    channel: string;
    startedAt: string;
    updatedAt: string;
    lastMessage: { body: string | null; author: string; type: string } | null;
  }[];
}

export interface ContactPatch {
  name?: string;
  tags?: string[];
  notes?: string | null;
  optOutFollowups?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'x-zenith-csrf': '1' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : method !== 'GET' ? { body: '{}' } : {}),
    });
  } catch {
    throw new ApiError(0, 'network', 'No hay conexión con el servidor');
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Error ${res.status}`);
  return data as T;
}

export const api = {
  me: () => request<Me>('GET', '/auth/me'),
  login: (email: string, password: string) => request<{ ok: true }>('POST', '/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  list: (view: View) => request<{ items: ConversationSummary[] }>('GET', `/conversations?view=${view}`),
  get: (id: string) => request<ConversationDetail>('GET', `/conversations/${encodeURIComponent(id)}`),
  take: (id: string) => request<{ ok: true }>('POST', `/conversations/${encodeURIComponent(id)}/take`),
  send: (id: string, text: string, clientId: string) =>
    request<{ ok: true }>('POST', `/conversations/${encodeURIComponent(id)}/messages`, { text, clientId }),
  finish: (id: string, action: 'release' | 'close') => request<{ ok: true }>('POST', `/conversations/${encodeURIComponent(id)}/finish`, { action }),
  contacts: (filters: { q?: string; tag?: string }) => {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.tag) params.set('tag', filters.tag);
    const qs = params.toString();
    return request<{ items: ContactSummary[] }>('GET', `/contacts${qs ? `?${qs}` : ''}`);
  },
  contact: (id: string) => request<ContactDetail>('GET', `/contacts/${encodeURIComponent(id)}`),
  contactTags: () => request<{ items: { tag: string; count: number }[] }>('GET', '/contact-tags'),
  updateContact: (id: string, patch: ContactPatch) => request<{ ok: true }>('PATCH', `/contacts/${encodeURIComponent(id)}`, patch),
};

export const REASON_LABELS: Record<string, string> = {
  precio: 'Pide precio',
  pedido_grande: 'Pedido grande',
  pago: 'Formas de pago',
  queja: 'Queja',
  pide_humano: 'Pidió una persona',
  fuera_de_alcance: 'Fuera del alcance del bot',
  seguridad: 'El bot no pudo responder',
  error: 'Falla del bot',
  otro: 'Otro',
};

export const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  messenger: 'Messenger',
  tiktok: 'TikTok',
};
