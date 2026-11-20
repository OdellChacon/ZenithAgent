import Anthropic from '@anthropic-ai/sdk';

export type BetaMessage = Anthropic.Beta.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
export type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;

/** Lo único que el cerebro necesita del proveedor. Permite probarlo con un modelo simulado. */
export interface LlmClient {
  create(params: CreateParams): Promise<BetaMessage>;
}

export function createAnthropicLlm(opts: { apiKey?: string; timeoutMs?: number } = {}): LlmClient {
  // Sin apiKey explícita, el SDK toma ANTHROPIC_API_KEY u otra credencial del entorno.
  const client = new Anthropic({
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    timeout: opts.timeoutMs ?? 60_000,
    maxRetries: 2,
  });
  return { create: (params) => client.beta.messages.create(params) };
}

export class LlmUnavailableError extends Error {
  override name = 'LlmUnavailableError';
}

/**
 * Sin proveedor configurado: no se llama a ninguna API. Cada turno termina con el mensaje de
 * respaldo y el pase a un asesor, así el resto del sistema se puede probar sin costo.
 */
export function createDisabledLlm(): LlmClient {
  return {
    create: async () => {
      throw new LlmUnavailableError('No hay proveedor de IA configurado (AI_PROVIDER=none)');
    },
  };
}

/** Errores del proveedor que conviene reintentar más tarde (cola con backoff). */
export function isRetryableLlmError(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof Anthropic.APIConnectionError) return true; // incluye timeouts
  if (err instanceof Anthropic.APIError) return err.status === 529 || err.status === 408;
  return false;
}
