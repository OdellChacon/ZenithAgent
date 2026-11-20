import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, CreateParams, LlmClient } from './llm.js';

/**
 * Adaptador para proveedores con API compatible con OpenAI (Chat Completions): Gemini,
 * Ollama, Cloudflare Workers AI, OpenRouter, etc.
 *
 * El cerebro habla internamente el formato de mensajes de Anthropic; este adaptador traduce
 * la petición al formato de OpenAI y la respuesta de vuelta, así el resto del bot no cambia.
 *
 * Esquemas: los parámetros que admiten null ("type": ["string","null"]) se envían como
 * opcionales, porque no todos los proveedores aceptan tipos múltiples. Si el modelo los omite,
 * al volver se rellenan con null para que la validación del bot siga igual.
 */
export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  /** Si se define, el esfuerzo del bot (low/medium/high) se envía como reasoning_effort. */
  sendReasoningEffort?: boolean;
  /**
   * Modelos a probar, en orden, si el principal está saturado o no responde a tiempo
   * (429, 5xx o timeout). Los errores permanentes (clave inválida, petición mala) no saltan.
   */
  fallbackModels?: string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class LlmHttpError extends Error {
  override name = 'LlmHttpError';
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

type JsonSchema = { [key: string]: unknown };

interface ToolSchemaInfo {
  parameters: JsonSchema;
  /** Propiedades que admitían null y pasaron a ser opcionales. */
  nullable: string[];
}

/** Convierte el esquema de una herramienta a una forma que aceptan todos los proveedores. */
export function portableSchema(schema: JsonSchema): ToolSchemaInfo {
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const nullable: string[] = [];
  const properties: Record<string, JsonSchema> = {};

  for (const [key, prop] of Object.entries(props)) {
    const copy: JsonSchema = { ...prop };
    if (Array.isArray(copy.type)) {
      const types = (copy.type as string[]).filter((t) => t !== 'null');
      if (types.length !== (copy.type as string[]).length) {
        nullable.push(key);
        required.delete(key);
      }
      copy.type = types.length === 1 ? types[0] : types;
    }
    if (Array.isArray(copy.enum)) copy.enum = (copy.enum as unknown[]).filter((v) => v !== null);
    properties[key] = copy;
  }

  const parameters: JsonSchema = { type: 'object', properties };
  if (required.size) parameters.required = [...required];
  return { parameters, nullable };
}

function systemText(system: CreateParams['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).join('\n\n');
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? (b as { text: string }).text : ''))
      .join('');
  }
  return '';
}

type OaiMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string }; extra_content?: unknown }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Traduce los mensajes del formato de Anthropic al de OpenAI. */
export function toOpenAiMessages(params: CreateParams): OaiMessage[] {
  const out: OaiMessage[] = [];
  const sys = systemText(params.system);
  if (sys) out.push({ role: 'system', content: sys });

  for (const m of params.messages) {
    const role = m.role as string;
    if (typeof m.content === 'string') {
      if (role === 'assistant') out.push({ role: 'assistant', content: m.content });
      else out.push({ role: role === 'system' ? 'system' : 'user', content: m.content });
      continue;
    }
    const blocks = m.content as unknown as Array<{ type: string; [k: string]: unknown }>;

    if (role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text as string).join('');
      // Los bloques de pensamiento de otros proveedores no se reenvían.
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id as string,
          type: 'function' as const,
          function: { name: b.name as string, arguments: JSON.stringify(b.input ?? {}) },
          // Datos propios del proveedor que hay que devolver tal cual (ej. thought_signature de Gemini).
          ...(b.provider_extra ? { extra_content: b.provider_extra } : {}),
        }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    for (const b of blocks) {
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: b.tool_use_id as string, content: blockText(b.content) });
      }
    }
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text as string).join('');
    if (text) out.push({ role: role === 'system' ? 'system' : 'user', content: text });
  }
  return out;
}

interface OaiResponse {
  id?: string;
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string; code?: number | string; status?: string };
}

const STOP_REASONS: Record<string, BetaMessage['stop_reason']> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

let callSeq = 0;

export function createOpenAiCompatibleLlm(opts: OpenAiCompatOptions): LlmClient {
  const base = new URL(opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`);
  const local = base.hostname === 'localhost' || base.hostname === '127.0.0.1';
  if (base.protocol !== 'https:' && !local) throw new Error('La URL del proveedor de IA debe usar https');
  const endpoint = new URL('chat/completions', base).toString();
  const doFetch = opts.fetch ?? fetch;

  const createOnce = async (params: CreateParams): Promise<BetaMessage> => {
      const schemas = new Map<string, ToolSchemaInfo>();
      const tools = (params.tools ?? []).flatMap((t) => {
        const tool = t as Anthropic.Beta.BetaTool;
        if (!tool.input_schema) return []; // herramientas de servidor de Anthropic: no aplican
        const info = portableSchema(tool.input_schema as JsonSchema);
        schemas.set(tool.name, info);
        return [{ type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: info.parameters } }];
      });

      const effort = params.output_config?.effort;
      const body = {
        model: params.model,
        messages: toOpenAiMessages(params),
        max_tokens: params.max_tokens,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        ...(opts.sendReasoningEffort && effort && ['low', 'medium', 'high'].includes(effort) ? { reasoning_effort: effort } : {}),
      };

      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
        });
      } catch (err) {
        throw new LlmHttpError(`No se pudo conectar con el proveedor de IA: ${(err as Error).message}`, null, true);
      }

      const raw = await res.text();
      let data: OaiResponse | OaiResponse[] | null = null;
      try {
        data = JSON.parse(raw) as OaiResponse | OaiResponse[];
      } catch {
        data = null;
      }
      // Algunos proveedores devuelven los errores dentro de un arreglo.
      const payload = Array.isArray(data) ? data[0] : data;

      if (!res.ok) {
        const detail = payload?.error?.message ?? raw.slice(0, 300);
        const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
        throw new LlmHttpError(`El proveedor de IA respondió ${res.status}: ${detail}`, res.status, retryable);
      }

      const choice = payload?.choices?.[0];
      if (!choice?.message) throw new LlmHttpError('Respuesta del proveedor de IA sin contenido', res.status, true);

      const content: unknown[] = [];
      const text = choice.message.content?.trim();
      if (text) content.push({ type: 'text', text, citations: null });

      for (const call of choice.message.tool_calls ?? []) {
        const name = call.function?.name ?? '';
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(call.function?.arguments || '{}') as Record<string, unknown>;
          if (!input || typeof input !== 'object' || Array.isArray(input)) input = { __argumentos_invalidos: true };
        } catch {
          input = { __argumentos_invalidos: true };
        }
        for (const key of schemas.get(name)?.nullable ?? []) {
          if (!(key in input)) input[key] = null;
        }
        content.push({
          type: 'tool_use',
          id: call.id || `call_${Date.now()}_${++callSeq}`,
          name,
          input,
          ...(call.extra_content ? { provider_extra: call.extra_content } : {}),
        });
      }

      const hasCalls = (choice.message.tool_calls ?? []).length > 0;
      const stop_reason = hasCalls ? 'tool_use' : (STOP_REASONS[choice.finish_reason ?? 'stop'] ?? 'end_turn');

      return {
        id: payload?.id ?? `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: payload?.model ?? params.model,
        content,
        stop_reason,
        stop_sequence: null,
        usage: {
          input_tokens: payload?.usage?.prompt_tokens ?? 0,
          output_tokens: payload?.usage?.completion_tokens ?? 0,
          cache_read_input_tokens: payload?.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          cache_creation_input_tokens: 0,
        },
      } as unknown as BetaMessage;
  };

  return {
    async create(params) {
      const models = [params.model, ...(opts.fallbackModels ?? []).filter((m) => m && m !== params.model)];
      let lastError: unknown;
      for (const model of models) {
        try {
          return await createOnce({ ...params, model });
        } catch (err) {
          lastError = err;
          if (!(err instanceof LlmHttpError) || !err.retryable) throw err;
        }
      }
      throw lastError;
    },
  };
}

/**
 * Gemini por su API compatible con OpenAI. Medido el 2026-11-20 en la capa gratuita:
 * gemini-3.8-flash y gemini-3.6-flash no respondieron en 45 s. En conversaciones del simulador,
 * gemini-3.5-flash-lite tardó entre 9 y 47 s por turno y gemini-3.1-flash-lite unos 3 s.
 */
export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
export const GEMINI_DEFAULT_MODEL = 'gemini-3.1-flash-lite';
export const GEMINI_DEFAULT_FALLBACK_MODELS = ['gemini-3.5-flash-lite'];
