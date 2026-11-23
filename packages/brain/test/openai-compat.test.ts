import { describe, expect, it, vi } from 'vitest';
import {
  buildSystemPrompt,
  createOpenAiCompatibleLlm,
  isRetryableLlmError,
  LlmHttpError,
  parseTenantBotSettings,
  portableSchema,
  runBrainTurn,
  TOOL_DEFINITIONS,
  toModelMessages,
  toOpenAiMessages,
  type CatalogReader,
  type CreateParams,
} from '../src/index.js';
import moraMora from '../../../config/tenants/inversiones-mora-mora.json' with { type: 'json' };

const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai/';

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const completion = (message: Record<string, unknown>, finish = 'stop') => ({
  id: 'chatcmpl-1',
  model: 'gemini-3.8-flash',
  choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', ...message } }],
  usage: { prompt_tokens: 120, completion_tokens: 30 },
});

describe('portableSchema', () => {
  it('convierte los parámetros que admiten null en opcionales', () => {
    const search = TOOL_DEFINITIONS.find((t) => t.name === 'buscar_productos')!;
    const { parameters, nullable } = portableSchema(search.input_schema as Record<string, unknown>);
    expect(nullable).toEqual(['texto', 'categoria', 'superficie', 'uso']);
    expect(parameters.required).toEqual(['limite']);
    const props = parameters.properties as Record<string, { type: unknown; enum?: unknown[] }>;
    expect(props.texto?.type).toBe('string');
    expect(props.superficie?.enum).toEqual(['piso', 'pared']);
    expect(JSON.stringify(parameters)).not.toContain('null');
    expect(parameters).not.toHaveProperty('additionalProperties');
  });
});

describe('toOpenAiMessages', () => {
  it('manda las fotos del cliente como image_url con data URL', () => {
    const out = toOpenAiMessages({
      model: 'm',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '[El cliente envió esta foto:]' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
            { type: 'text', text: '¿Tienen algo así?' },
          ],
        },
      ],
    });
    expect(out).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '[El cliente envió esta foto:]' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
          { type: 'text', text: '¿Tienen algo así?' },
        ],
      },
    ]);
  });

  it('traduce sistema, llamadas a herramientas y sus resultados', () => {
    const params = {
      model: 'm',
      max_tokens: 100,
      system: 'Eres el asistente.',
      messages: [
        { role: 'user', content: 'Hola' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 'x' },
            { type: 'text', text: 'Busco…' },
            { type: 'tool_use', id: 'call_1', name: 'buscar_productos', input: { texto: 'beige' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"resultados":1}' }] },
      ],
    } as unknown as CreateParams;
    expect(toOpenAiMessages(params)).toEqual([
      { role: 'system', content: 'Eres el asistente.' },
      { role: 'user', content: 'Hola' },
      {
        role: 'assistant',
        content: 'Busco…',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'buscar_productos', arguments: '{"texto":"beige"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"resultados":1}' },
    ]);
  });
});

describe('createOpenAiCompatibleLlm', () => {
  const params = (): CreateParams =>
    ({
      model: 'gemini-3.8-flash',
      max_tokens: 2000,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: 'sistema',
      tools: TOOL_DEFINITIONS,
      messages: [{ role: 'user', content: 'Hola' }],
    }) as unknown as CreateParams;

  it('envía la petición en formato OpenAI con la clave y el esfuerzo', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply(completion({ content: 'Buenas tardes.' })));
    const llm = createOpenAiCompatibleLlm({ baseUrl: BASE, apiKey: 'clave', sendReasoningEffort: true, fetch: fetchMock });
    const msg = await llm.create(params());

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}chat/completions`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer clave');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'gemini-3.8-flash', max_tokens: 2000, reasoning_effort: 'low', tool_choice: 'auto' });
    expect(body.tools).toHaveLength(5);
    expect(body).not.toHaveProperty('fallbacks');
    expect(body).not.toHaveProperty('betas');

    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.content).toEqual([{ type: 'text', text: 'Buenas tardes.', citations: null }]);
    expect(msg.usage).toMatchObject({ input_tokens: 120, output_tokens: 30 });
  });

  it('traduce llamadas a herramientas y rellena con null lo que el modelo omitió', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      reply(
        completion(
          { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'buscar_productos', arguments: '{"texto":"beige","limite":3}' } }] },
          'tool_calls',
        ),
      ),
    );
    const msg = await createOpenAiCompatibleLlm({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock }).create(params());
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content).toEqual([
      { type: 'tool_use', id: 'c1', name: 'buscar_productos', input: { texto: 'beige', limite: 3, categoria: null, superficie: null, uso: null } },
    ]);
  });

  it('conserva la firma de pensamiento de Gemini y la devuelve en el turno siguiente', async () => {
    const signature = { google: { thought_signature: 'Eo4BCosBAWkU' } };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      reply(
        completion(
          { tool_calls: [{ id: 'c9', type: 'function', function: { name: 'buscar_productos', arguments: '{"limite":2}' }, extra_content: signature }] },
          'tool_calls',
        ),
      ),
    );
    const llm = createOpenAiCompatibleLlm({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    const msg = await llm.create(params());
    const next = {
      ...params(),
      messages: [
        { role: 'user', content: 'Hola' },
        { role: 'assistant', content: msg.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c9', content: '{}' }] },
      ],
    } as unknown as CreateParams;
    const sent = toOpenAiMessages(next);
    expect(sent[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c9', extra_content: signature }] });
  });

  it('marca argumentos inválidos para que el bot los rechace y el modelo corrija', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      reply(completion({ tool_calls: [{ function: { name: 'calcular_cajas', arguments: '{no es json' } }] }, 'tool_calls')),
    );
    const msg = await createOpenAiCompatibleLlm({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock }).create(params());
    const call = msg.content[0] as { type: string; id: string; input: Record<string, unknown> };
    expect(call.type).toBe('tool_use');
    expect(call.id).toMatch(/^call_/);
    expect(call.input.__argumentos_invalidos).toBe(true);
  });

  it('mapea los motivos de corte', async () => {
    const run = async (finish: string) =>
      (await createOpenAiCompatibleLlm({ baseUrl: BASE, apiKey: 'k', fetch: vi.fn<typeof fetch>().mockResolvedValue(reply(completion({ content: 'x' }, finish))) }).create(params()))
        .stop_reason;
    expect(await run('length')).toBe('max_tokens');
    expect(await run('content_filter')).toBe('refusal');
  });

  it('distingue errores reintentables de los permanentes', async () => {
    const fail = (status: number, body: unknown = { error: { message: 'x' } }) =>
      createOpenAiCompatibleLlm({ baseUrl: BASE, apiKey: 'k', fetch: vi.fn<typeof fetch>().mockResolvedValue(reply(body, status)) }).create(params());

    for (const status of [429, 500, 503]) {
      const err = await fail(status).catch((e) => e);
      expect(err).toBeInstanceOf(LlmHttpError);
      expect(isRetryableLlmError(err)).toBe(true);
    }
    // Gemini a veces devuelve los errores dentro de un arreglo.
    const auth = await fail(400, [{ error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } }]).catch((e) => e);
    expect(auth.message).toContain('API key not valid');
    expect(isRetryableLlmError(auth)).toBe(false);
    expect(isRetryableLlmError(await fail(403).catch((e) => e))).toBe(false);

    const down = await createOpenAiCompatibleLlm({ baseUrl: BASE, apiKey: 'k', fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNRESET')) })
      .create(params())
      .catch((e) => e);
    expect(isRetryableLlmError(down)).toBe(true);
  });

  it('si el modelo está saturado prueba el de respaldo, pero no ante errores permanentes', async () => {
    const used: string[] = [];
    const busyFirst = vi.fn<typeof fetch>(async (_u, init) => {
      const model = JSON.parse(String(init?.body)).model as string;
      used.push(model);
      return model === 'principal' ? reply({ error: { message: 'high demand' } }, 503) : reply(completion({ content: 'Hola' }));
    });
    const llm = createOpenAiCompatibleLlm({ baseUrl: BASE, apiKey: 'k', fetch: busyFirst, fallbackModels: ['respaldo'] });
    const msg = await llm.create({ ...params(), model: 'principal' });
    expect(used).toEqual(['principal', 'respaldo']);
    expect(msg.content).toEqual([{ type: 'text', text: 'Hola', citations: null }]);

    const badKey = vi.fn<typeof fetch>().mockResolvedValue(reply([{ error: { message: 'Please pass a valid API key' } }], 400));
    await expect(createOpenAiCompatibleLlm({ baseUrl: BASE, apiKey: 'k', fetch: badKey, fallbackModels: ['respaldo'] }).create(params())).rejects.toThrow(
      'valid API key',
    );
    expect(badKey).toHaveBeenCalledTimes(1);
  });

  it('exige https salvo en la máquina local', () => {
    expect(() => createOpenAiCompatibleLlm({ baseUrl: 'http://ejemplo.com/v1', apiKey: 'k' })).toThrow('https');
    expect(() => createOpenAiCompatibleLlm({ baseUrl: 'http://localhost:11434/v1', apiKey: 'k' })).not.toThrow();
  });
});

describe('el cerebro completo sobre el adaptador', () => {
  it('busca en el catálogo, calcula cajas y responde', async () => {
    const productId = '11111111-1111-4111-8111-111111111111';
    const turns = [
      completion({ tool_calls: [{ id: 'a', function: { name: 'buscar_productos', arguments: '{"texto":"beige","limite":3}' } }] }, 'tool_calls'),
      completion({ tool_calls: [{ id: 'b', function: { name: 'calcular_cajas', arguments: JSON.stringify({ producto_id: productId, metros_cuadrados: 12 }) } }] }, 'tool_calls'),
      completion({ content: 'Para 12 m² del Aconna Beige necesitaría 7 cajas.' }),
    ];
    const bodies: { messages: { role: string; content?: string }[] }[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return reply(turns[bodies.length - 1]);
    });
    const row = {
      id: productId, name: 'Aconna Beige', category: 'ceramicas', category_name: 'Cerámicas', description: null,
      format: '60x60/1.80m²/5 Piezas', area_per_box_m2: '1.800', pieces_per_box: 5, attributes: {}, price: null, currency: null, in_visualizer: true, has_photo: false,
    };
    const catalog: CatalogReader = { search: vi.fn(async () => [row]), get: vi.fn(async () => row) };

    const res = await runBrainTurn({
      llm: createOpenAiCompatibleLlm({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock }),
      system: buildSystemPrompt(parseTenantBotSettings(moraMora.settings)),
      messages: toModelMessages([{ direction: 'in', author: 'customer', type: 'text', body: 'Busco cerámica beige para 12 m²' }]),
      tools: { catalog, wastePercent: null },
      config: { model: 'gemini-3.8-flash' },
    });

    expect(res.outcome).toBe('replied');
    expect(res.reply).toContain('7 cajas');
    expect(catalog.search).toHaveBeenCalledWith({ text: 'beige', category: null, surface: null, usage: null, limit: 3 });
    const toolMsg = bodies[2]!.messages.at(-1)!;
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.content).toContain('"cajas":7');
  });
});
