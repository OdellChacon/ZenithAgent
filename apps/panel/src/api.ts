import type { SignupConfig, SignupResult } from './signup';
export const TAG_COLORS = ['gray', 'red', 'orange', 'amber', 'lime', 'green', 'teal', 'sky', 'blue', 'violet', 'pink'] as const;
export type TagColor = (typeof TAG_COLORS)[number];
export interface TagDef {
  tag: string;
  count: number;
  color: TagColor;
  group: string | null;
  description: string | null;
}
export interface TagGroup {
  name: string;
  exclusive: boolean;
}
export interface TagCatalog {
  items: TagDef[];
  groups: TagGroup[];
  canManage: boolean;
}
export interface MessageTemplate {
  name: string;
  language: string;
  category: string;
  body: string;
  params: number;
  header: string | null;
  footer: string | null;
  buttons: string[];
}
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
  /** Un asesor escribió desde la app de WhatsApp Business (el bot está callado ahí). */
  agentPhoneAt: string | null;
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
  /** Archivo del mensaje (del asesor o del cliente): se abre desde `url`. */
  file: { url: string; name: string | null; mimeType: string | null; mediaType: string } | null;
  editedAt: string | null;
  deletedAt: string | null;
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
  agentPhoneAt: string | null;
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

export interface ChannelStatus {
  id: string;
  channel: string;
  name: string;
  /** Meta desconectó el número de la API: el bot no atiende ahí. */
  disconnected: { at: string; reason: string | null; label: string } | null;
  history: { status: 'importing' | 'done' | 'declined'; progress: number } | null;
  /** El número sigue en la app WhatsApp Business del teléfono. */
  coexistence: boolean;
  /** Acceso a Meta: `invalid` si Meta rechazó el token; `expiresAt` si vence. */
  token: { invalid: { at: string; error: string | null } | null; expiresAt: string | null };
  connectedAt: string;
}

export interface Catalog {
  id: string;
  title: string;
  description: string | null;
  /** Para filtrar (ej. "Grifería"). */
  category: string | null;
  /** Texto que se propone al mandarlo a un chat. */
  defaultMessage: string | null;
  /** Si el bot puede mandarlo (cuando el negocio lo permite en general). */
  botEnabled: boolean;
  /** Envíos que llegaron a salir, de asesores y del bot. */
  usage: { sent: number; byBot: number; lastSentAt: string | null };
  mediaType: 'image' | 'video' | 'document';
  mimeType: string;
  filename: string;
  bytes: number;
  /** Para abrirlo o verlo en el navegador. */
  url: string;
  createdAt: string;
  updatedAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** El resto de la respuesta de error (ej. el catálogo que ya existía). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
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

/** POST con archivo (multipart). El navegador pone el límite del cuerpo; no se manda Content-Type a mano. */
async function upload<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'x-zenith-csrf': '1' },
      body: form,
    });
  } catch {
    throw new ApiError(0, 'network', 'No hay conexión con el servidor');
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Error ${res.status}`);
  return data as T;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

/**
 * Igual que `upload`, pero informa el avance (fetch no lo hace) y se puede cancelar. Usado para
 * archivos grandes como los catálogos.
 */
function uploadWithProgress<T>(path: string, form: FormData, opts: { onProgress?: (p: UploadProgress) => void; signal?: AbortSignal } = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('x-zenith-csrf', '1');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && opts.onProgress?.({ loaded: e.loaded, total: e.total });
    xhr.onload = () => {
      const data = xhr.response as ({ error?: { code: string; message: string } } & T) | null;
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, data?.error?.code ?? 'error', data?.error?.message ?? `Error ${xhr.status}`, (data ?? undefined) as Record<string, unknown> | undefined));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'No hay conexión con el servidor'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Subida cancelada'));
    if (opts.signal) {
      if (opts.signal.aborted) return reject(new ApiError(0, 'aborted', 'Subida cancelada'));
      opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });
}

/** "2,4 MB", "350 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toLocaleString('es-VE', { maximumFractionDigits: 1 })} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Tipo de dato del arrastre de un catálogo hacia un chat. */
export const CATALOG_DRAG_TYPE = 'application/x-zenith-catalog';

export const api = {
  me: () => request<Me>('GET', '/auth/me'),
  login: (email: string, password: string) => request<{ ok: true }>('POST', '/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  list: (view: View) => request<{ items: ConversationSummary[] }>('GET', `/conversations?view=${view}`),
  get: (id: string) => request<ConversationDetail>('GET', `/conversations/${encodeURIComponent(id)}`),
  take: (id: string) => request<{ ok: true }>('POST', `/conversations/${encodeURIComponent(id)}/take`),
  templates: (id: string) => request<{ items: MessageTemplate[] }>('GET', `/conversations/${encodeURIComponent(id)}/templates`),
  sendTemplate: (id: string, t: { name: string; language: string; params: string[]; clientId: string }) =>
    request<{ ok: true }>('POST', `/conversations/${encodeURIComponent(id)}/templates`, t),
  send: (id: string, text: string, clientId: string) =>
    request<{ ok: true }>('POST', `/conversations/${encodeURIComponent(id)}/messages`, { text, clientId }),
  sendFile: (id: string, file: File, caption: string, clientId: string) => {
    const form = new FormData();
    // Los datos van antes del archivo: así la API los lee sin guardar el archivo en memoria dos veces.
    if (caption.trim()) form.append('caption', caption.trim());
    form.append('clientId', clientId);
    form.append('file', file, file.name);
    return upload<{ ok: true }>(`/conversations/${encodeURIComponent(id)}/files`, form);
  },
  catalogs: () => request<{ items: Catalog[]; categories: string[]; canManage: boolean; botCanSend: boolean }>('GET', '/catalogs'),
  setCatalogBot: (botCanSend: boolean) => request<{ ok: true; botCanSend: boolean }>('PUT', '/catalogs/settings', { botCanSend }),
  uploadCatalog: (
    file: File,
    fields: { title: string; description: string; category: string; defaultMessage: string; botEnabled: boolean; allowDuplicate?: boolean },
    opts: { onProgress?: (p: UploadProgress) => void; signal?: AbortSignal } = {},
  ) => {
    const form = new FormData();
    if (fields.title.trim()) form.append('title', fields.title.trim());
    if (fields.description.trim()) form.append('description', fields.description.trim());
    if (fields.category.trim()) form.append('category', fields.category.trim());
    if (fields.defaultMessage.trim()) form.append('defaultMessage', fields.defaultMessage.trim());
    form.append('botEnabled', String(fields.botEnabled));
    if (fields.allowDuplicate) form.append('allowDuplicate', 'true');
    form.append('file', file, file.name);
    return uploadWithProgress<{ ok: true; item: Catalog }>('/catalogs', form, opts);
  },
  updateCatalog: (id: string, patch: { title?: string; description?: string | null; category?: string | null; defaultMessage?: string | null; botEnabled?: boolean }) =>
    request<{ ok: true; item: Catalog }>('PATCH', `/catalogs/${encodeURIComponent(id)}`, patch),
  deleteCatalog: (id: string) => request<{ ok: true }>('DELETE', `/catalogs/${encodeURIComponent(id)}`),
  shareCatalog: (conversationId: string, catalogId: string, caption: string, clientId: string) =>
    request<{ ok: true }>('POST', `/conversations/${encodeURIComponent(conversationId)}/catalogs`, {
      catalogId,
      clientId,
      ...(caption.trim() ? { caption: caption.trim() } : {}),
    }),
  finish: (id: string, action: 'release' | 'close') => request<{ ok: true }>('POST', `/conversations/${encodeURIComponent(id)}/finish`, { action }),
  contacts: (filters: { q?: string; tag?: string }) => {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.tag) params.set('tag', filters.tag);
    const qs = params.toString();
    return request<{ items: ContactSummary[] }>('GET', `/contacts${qs ? `?${qs}` : ''}`);
  },
  contact: (id: string) => request<ContactDetail>('GET', `/contacts/${encodeURIComponent(id)}`),
  channels: () => request<{ items: ChannelStatus[] }>('GET', '/channels'),
  signupConfig: () => request<SignupConfig>('GET', '/channels/whatsapp/signup'),
  connectWhatsApp: (signup: SignupResult) =>
    request<{ ok: true; name: string | null; coexistence: boolean; warnings: string[] }>('POST', '/channels/whatsapp/connect', signup),
  contactTags: () => request<TagCatalog>('GET', '/contact-tags'),
  updateContact: (id: string, patch: ContactPatch) => request<{ ok: true; tags?: string[] }>('PATCH', `/contacts/${encodeURIComponent(id)}`, patch),
  createTag: (tag: { name: string; color?: TagColor; group?: string | null; description?: string | null }) =>
    request<{ ok: true; name: string }>('POST', '/contact-tags', tag),
  updateTag: (name: string, patch: { name?: string; color?: TagColor; group?: string | null; description?: string | null }) =>
    request<{ ok: true; merged: boolean }>('PATCH', `/contact-tags/${encodeURIComponent(name)}`, patch),
  deleteTag: (name: string) => request<{ ok: true; contacts: number }>('DELETE', `/contact-tags/${encodeURIComponent(name)}`),
  createTagGroup: (group: { name: string; exclusive?: boolean }) => request<{ ok: true }>('POST', '/contact-tag-groups', group),
  updateTagGroup: (name: string, patch: { name?: string; exclusive?: boolean }) =>
    request<{ ok: true }>('PATCH', `/contact-tag-groups/${encodeURIComponent(name)}`, patch),
  deleteTagGroup: (name: string) => request<{ ok: true }>('DELETE', `/contact-tag-groups/${encodeURIComponent(name)}`),
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
