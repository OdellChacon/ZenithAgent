import { z } from 'zod';
import {
  createAnthropicLlm,
  createDisabledLlm,
  createOpenAiCompatibleLlm,
  GEMINI_DEFAULT_FALLBACK_MODELS,
  GEMINI_DEFAULT_MODEL,
  GEMINI_OPENAI_BASE_URL,
  type LlmClient,
} from '@zenith/brain';

/** Variables de entorno del proveedor de IA (las comparten el worker y los comandos). */
export const aiEnvShape = {
  // none: sin IA (respaldo + asesor). gemini: API de Google. openai-compatible: Ollama, OpenRouter, etc.
  // anthropic: Claude (ver la política de regiones antes de usarlo).
  AI_PROVIDER: z.enum(['none', 'gemini', 'openai-compatible', 'anthropic']).default('none'),
  AI_MODEL: z.string().min(1).optional(),
  // Modelos de respaldo separados por coma, si el principal está saturado.
  AI_FALLBACK_MODELS: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().url().optional(),
  AI_API_KEY: z.string().optional(),
  AI_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
};

const aiEnvSchema = z.object(aiEnvShape);
export type AiEnv = z.infer<typeof aiEnvSchema>;

export function buildLlm(env: AiEnv, warn: (msg: string) => void): { llm: LlmClient; model: string } {
  const fallbackModels = env.AI_FALLBACK_MODELS?.split(',').map((m) => m.trim()).filter(Boolean);
  switch (env.AI_PROVIDER) {
    case 'none':
      warn('AI_PROVIDER=none: el bot no usa IA; cada mensaje recibe el respaldo y pasa a un asesor');
      return { llm: createDisabledLlm(), model: 'ninguno' };
    case 'gemini':
      if (!env.GEMINI_API_KEY) throw new Error('AI_PROVIDER=gemini necesita GEMINI_API_KEY');
      warn('Gemini en capa gratuita: Google puede usar y revisar lo enviado. Úsalo solo con datos ficticios (simulador), nunca con clientes reales');
      return {
        llm: createOpenAiCompatibleLlm({
          baseUrl: GEMINI_OPENAI_BASE_URL,
          apiKey: env.GEMINI_API_KEY.trim(),
          sendReasoningEffort: true,
          fallbackModels: fallbackModels ?? GEMINI_DEFAULT_FALLBACK_MODELS,
        }),
        model: env.AI_MODEL ?? GEMINI_DEFAULT_MODEL,
      };
    case 'openai-compatible':
      if (!env.AI_BASE_URL || !env.AI_MODEL) throw new Error('AI_PROVIDER=openai-compatible necesita AI_BASE_URL y AI_MODEL');
      return {
        llm: createOpenAiCompatibleLlm({ baseUrl: env.AI_BASE_URL, apiKey: env.AI_API_KEY?.trim() || 'sin-clave', fallbackModels: fallbackModels ?? [] }),
        model: env.AI_MODEL,
      };
    case 'anthropic':
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        warn('No hay ANTHROPIC_API_KEY: si el SDK no encuentra otra credencial, cada turno responderá con el respaldo');
      }
      return { llm: createAnthropicLlm(), model: env.AI_MODEL ?? 'claude-opus-5-5' };
  }
}

/** Lee solo las variables de IA del entorno (para comandos que no necesitan el resto). */
export function readAiEnv(source: NodeJS.ProcessEnv = process.env): AiEnv {
  return aiEnvSchema.parse(source);
}
