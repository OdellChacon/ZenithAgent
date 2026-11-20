import type Anthropic from '@anthropic-ai/sdk';
import type { CreateParams, LlmClient } from '../src/llm.js';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown };

/** Una respuesta guionada del modelo simulado. */
export interface ScriptedTurn {
  stop: 'end_turn' | 'tool_use' | 'refusal' | 'max_tokens' | 'pause_turn';
  blocks: Block[];
}

export const text = (t: string): ScriptedTurn => ({ stop: 'end_turn', blocks: [{ type: 'text', text: t }] });
export const tool = (name: string, input: unknown, preface?: string): ScriptedTurn => ({
  stop: 'tool_use',
  blocks: [...(preface ? [{ type: 'text' as const, text: preface }] : []), { type: 'tool_use', name, input }],
});

/** Modelo simulado: devuelve las respuestas en orden y guarda cada petición. */
export function scriptedLlm(turns: ScriptedTurn[]) {
  const calls: CreateParams[] = [];
  let i = 0;
  const llm: LlmClient = {
    async create(params) {
      calls.push(structuredClone(params));
      const turn = turns[i++];
      if (!turn) throw new Error('El guion del modelo se quedó sin respuestas');
      let n = 0;
      return {
        id: `msg_${i}`,
        type: 'message',
        role: 'assistant',
        model: params.model,
        stop_reason: turn.stop,
        stop_sequence: null,
        content: turn.blocks.map((b) =>
          b.type === 'text'
            ? { type: 'text', text: b.text, citations: null }
            : { type: 'tool_use', id: `toolu_${i}_${n++}`, name: b.name, input: b.input },
        ),
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
      } as unknown as Anthropic.Beta.BetaMessage;
    },
  };
  return { llm, calls };
}
