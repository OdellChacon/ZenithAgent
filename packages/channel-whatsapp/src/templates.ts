/**
 * Plantillas de mensaje aprobadas de una cuenta de WhatsApp Business.
 *   GET https://graph.facebook.com/{version}/{waba_id}/message_templates
 * Fuera de la ventana de 24 h, WhatsApp solo deja escribirle al cliente con una de estas.
 */
import type { GraphConfig } from './onboarding.js';

export interface ApprovedTemplate {
  name: string;
  /** Código de idioma con que se aprobó (ej. "es", "es_MX"). */
  language: string;
  /** MARKETING, UTILITY o AUTHENTICATION: define el costo en Meta. */
  category: string;
  /** Texto del cuerpo con sus {{1}}, {{2}}… */
  body: string;
  /** Cuántos valores pide el cuerpo. */
  params: number;
  /** Encabezado de texto fijo, si tiene. */
  header: string | null;
  footer: string | null;
  buttons: string[];
}

interface GraphComponent {
  type?: string;
  format?: string;
  text?: string;
  buttons?: { type?: string; text?: string }[];
}

interface GraphTemplate {
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  components?: GraphComponent[];
}

export class WhatsAppTemplatesError extends Error {
  override name = 'WhatsAppTemplatesError';
}

const GRAPH_VERSION_RE = /^v\d+\.\d+$/;
const ID_RE = /^\d{1,32}$/;

/** {{1}}, {{2}}… del texto: el número más alto (deben ir seguidos desde 1). */
export function countTemplateParams(text: string): number {
  const nums = [...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

export function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (w, n: string) => params[Number(n) - 1] ?? w);
}

/**
 * Convierte una plantilla de Graph a lo que el panel puede enviar. Se dejan fuera las que el
 * sistema todavía no sabe mandar: encabezado con foto, video o documento, o con variables.
 */
export function toApprovedTemplate(t: GraphTemplate): ApprovedTemplate | null {
  if (!t.name || !t.language || t.status !== 'APPROVED') return null;
  const comps = t.components ?? [];
  const body = comps.find((c) => c.type?.toUpperCase() === 'BODY')?.text;
  if (!body) return null;
  const header = comps.find((c) => c.type?.toUpperCase() === 'HEADER');
  if (header && ((header.format && header.format.toUpperCase() !== 'TEXT') || countTemplateParams(header.text ?? '') > 0)) return null;
  const buttons = comps.find((c) => c.type?.toUpperCase() === 'BUTTONS')?.buttons ?? [];
  return {
    name: t.name,
    language: t.language,
    category: (t.category ?? '').toUpperCase(),
    body,
    params: countTemplateParams(body),
    header: header?.text ?? null,
    footer: comps.find((c) => c.type?.toUpperCase() === 'FOOTER')?.text ?? null,
    buttons: buttons.map((b) => b.text ?? '').filter(Boolean),
  };
}

/** Plantillas aprobadas de la cuenta, en el orden en que las devuelve Meta (máximo 100). */
export async function listWhatsAppTemplates(config: GraphConfig, accessToken: string, wabaId: string): Promise<ApprovedTemplate[]> {
  if (!GRAPH_VERSION_RE.test(config.graphApiVersion)) throw new WhatsAppTemplatesError('META_GRAPH_API_VERSION debe tener la forma vNN.N');
  if (!ID_RE.test(wabaId)) throw new WhatsAppTemplatesError('Id de la cuenta de WhatsApp Business inválido');
  const base = new URL(config.graphBaseUrl ?? 'https://graph.facebook.com');
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') {
    throw new WhatsAppTemplatesError('La URL de Graph API debe usar https');
  }
  const url = new URL(`/${config.graphApiVersion}/${wabaId}/message_templates`, base);
  url.searchParams.set('fields', 'name,language,status,category,components');
  url.searchParams.set('status', 'APPROVED');
  url.searchParams.set('limit', '100');
  let res: Response;
  try {
    res = await (config.fetch ?? fetch)(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new WhatsAppTemplatesError(`No se pudo conectar con Meta: ${(err as Error).message}`);
  }
  const data = (await res.json().catch(() => null)) as { data?: GraphTemplate[]; error?: { message?: string } } | null;
  if (!res.ok || !data || data.error || !Array.isArray(data.data)) {
    throw new WhatsAppTemplatesError(data?.error?.message ?? `Meta respondió ${res.status}`);
  }
  return data.data.map(toApprovedTemplate).filter((t): t is ApprovedTemplate => t !== null);
}
