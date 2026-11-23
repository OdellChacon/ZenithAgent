import { describe, expect, it, vi } from 'vitest';
import {
  buildSystemPrompt,
  calculateBoxes,
  checkReply,
  FALLBACK_REPLY,
  formatForChannel,
  parseTenantBotSettings,
  runBrainTurn,
  TenantSettingsError,
  pendingCustomerImages,
  polishReply,
  toModelMessages,
  type CatalogReader,
  type ProductRow,
} from '../src/index.js';
import { scriptedLlm, text, tool } from './fake-llm.js';
import moraMora from '../../../config/tenants/inversiones-mora-mora.json' with { type: 'json' };

const settings = parseTenantBotSettings(moraMora.settings);

const PRODUCT: ProductRow = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Aconna Beige',
  category: 'ceramicas',
  category_name: 'Cerámicas',
  description: null,
  format: '60x60/1.80m²/5 Piezas',
  area_per_box_m2: '1.800',
  pieces_per_box: 5,
  attributes: { surface: 'Piso y pared', finish: 'Mate', usage: 'Interior y exterior', features: ['Antideslizante'] },
  price: '99.00', // aunque exista, el bot no debe verlo
  currency: 'USD',
  in_visualizer: true,
  has_photo: true,
};

function catalog(rows: ProductRow[] = [PRODUCT]): CatalogReader & { search: ReturnType<typeof vi.fn> } {
  return {
    search: vi.fn(async () => rows),
    get: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
  };
}

const customer = (body: string) => toModelMessages([{ direction: 'in', author: 'customer', type: 'text', body }]);

describe('calculateBoxes', () => {
  it('redondea hacia arriba a cajas completas', () => {
    expect(calculateBoxes(12, 1.8, 5, null)).toEqual({ boxes: 7, coveredM2: 12.6, pieces: 35, wastePercent: null });
  });
  it('no suma una caja por error de coma flotante', () => {
    expect(calculateBoxes(5.4, 1.8, 5, null).boxes).toBe(3);
  });
  it('aplica el desperdicio cuando el negocio lo define', () => {
    expect(calculateBoxes(12, 1.8, 5, 10).boxes).toBe(8); // 13.2 m² / 1.8
  });
  it('rechaza áreas inválidas', () => {
    expect(() => calculateBoxes(0, 1.8, 5, null)).toThrow(RangeError);
    expect(() => calculateBoxes(Number.NaN, 1.8, 5, null)).toThrow(RangeError);
  });
});

describe('formatForChannel', () => {
  const md = '### Opciones\n**Aconna Beige** y __Sinai__.\n* Mate\n* Antideslizante\nVea [el visualizador](https://inversionesmoramora.com/#visualizador)';

  it('convierte el Markdown al formato de WhatsApp', () => {
    expect(formatForChannel(md, 'whatsapp')).toBe(
      '*Opciones*\n*Aconna Beige* y _Sinai_.\n- Mate\n- Antideslizante\nVea el visualizador: https://inversionesmoramora.com/#visualizador',
    );
  });

  it('deja texto plano en Instagram y Messenger', () => {
    expect(formatForChannel(md, 'instagram')).toBe(
      'Opciones\nAconna Beige y Sinai.\n- Mate\n- Antideslizante\nVea el visualizador: https://inversionesmoramora.com/#visualizador',
    );
    expect(formatForChannel('Le recomiendo el *Aconna Beige*.', 'messenger')).toBe('Le recomiendo el Aconna Beige.');
  });

  it('no toca el texto que ya está bien', () => {
    expect(formatForChannel('Necesita 7 cajas (12,6 m²).', 'whatsapp')).toBe('Necesita 7 cajas (12,6 m²).');
  });
});

describe('checkReply', () => {
  it('acepta respuestas normales', () => {
    expect(checkReply('  Con gusto le ayudo. ¿Es para piso o pared?  ')).toEqual({
      ok: true,
      text: 'Con gusto le ayudo. ¿Es para piso o pared?',
    });
  });
  it.each(['Cuesta $25 la caja', 'Son 30 dólares', 'Le sale en 120 Bs', 'el precio es 15', 'USD 40 por m²'])(
    'bloquea montos: %s',
    (t) => {
      expect(checkReply(t)).toEqual({ ok: false, reason: 'mentions_price' });
    },
  );
  it('no confunde medidas ni cantidades con precios', () => {
    expect(checkReply('Necesita 7 cajas de 60x60 (12.6 m²).').ok).toBe(true);
  });
  it('bloquea vacías y demasiado largas', () => {
    expect(checkReply('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(checkReply('a'.repeat(2000))).toEqual({ ok: false, reason: 'too_long' });
  });
});

describe('polishReply', () => {
  it.each([
    [
      'Excelente. En un momento un asesor le escribe por este mismo chat con la cotización.',
      'En un momento un asesor le escribe por este mismo chat con la cotización.',
    ],
    [
      'Para los 30 metros del *Arrieta*, el sistema calcula unas 17 cajas (30.6 m²).',
      'Para los 30 metros del *Arrieta*, serían unas 17 cajas (30.6 m²).',
    ],
    ['Según el sistema, necesitaría 7 cajas.', 'Necesitaría 7 cajas.'],
    ['El sistema indica que necesita 7 cajas.', 'Necesita 7 cajas.'],
    [
      '¡Excelente! Ya he notificado a nuestro equipo. En breve un asesor le escribe.\n\n¡Que tenga un excelente día!',
      'En breve un asesor le escribe.',
    ],
    [
      'Hola. Es un gusto saludarle.\n\nHe revisado el catálogo y, aunque no sé si es el mismo modelo, estos se parecen.',
      'Hola.\n\nAunque no sé si es el mismo modelo, estos se parecen.',
    ],
    ['¡Claro que sí! Tenemos tres lavamanos de sobreponer.', 'Tenemos tres lavamanos de sobreponer.'],
    ['Muy buenos días. Qué excelente elección, la madera da calidez.', 'Muy buenos días. La madera da calidez.'],
  ])('quita muletillas: %s', (raw, clean) => {
    expect(polishReply(raw)).toBe(clean);
    expect(checkReply(raw)).toEqual({ ok: true, text: clean });
  });

  it('no toca lo que no es muletilla', () => {
    for (const t of ['Son una excelente opción por su acabado mate.', 'Perfecto para exteriores, es antideslizante.', '¡Perfecto!']) {
      expect(polishReply(t)).toBe(t);
    }
  });
});

describe('toModelMessages', () => {
  it('une mensajes seguidos, marca la media y empieza por el cliente', () => {
    const out = toModelMessages([
      { direction: 'out', author: 'bot', type: 'text', body: 'Mensaje viejo del bot' },
      { direction: 'in', author: 'customer', type: 'text', body: 'Hola' },
      { direction: 'in', author: 'customer', type: 'image', body: null },
      { direction: 'out', author: 'agent', type: 'text', body: 'Buenas tardes' },
      { direction: 'in', author: 'customer', type: 'text', body: 'Gracias' },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]?.role).toBe('user');
    expect(out[0]?.content).toContain('Hola');
    expect(out[0]?.content).toContain('envió una imagen');
    expect(out[1]).toEqual({ role: 'assistant', content: 'Buenas tardes' });
    expect(out[2]).toEqual({ role: 'user', content: 'Gracias' });
  });

  it('pone la foto del cliente como imagen cuando está descargada', () => {
    const images = new Map([['m2', { mediaType: 'image/jpeg' as const, base64: 'QUJD' }]]);
    const out = toModelMessages(
      [
        { id: 'm1', direction: 'in', author: 'customer', type: 'text', body: 'Hola' },
        { id: 'm2', direction: 'in', author: 'customer', type: 'image', body: '¿Tienen algo así?' },
      ],
      images,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toEqual([
      { type: 'text', text: 'Hola' },
      { type: 'text', text: '[El cliente envió esta foto:]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
      { type: 'text', text: '¿Tienen algo así?' },
    ]);
  });

  it('sin la foto descargada deja una nota de texto', () => {
    const out = toModelMessages([{ id: 'm1', direction: 'in', author: 'customer', type: 'image', body: null }], new Map());
    expect(typeof out[0]?.content).toBe('string');
    expect(out[0]?.content).toContain('no tienes a la vista');
  });

  it('solo marca como pendientes las fotos posteriores a la última respuesta', () => {
    const pending = pendingCustomerImages([
      { id: 'a', direction: 'in', author: 'customer', type: 'image', body: null },
      { id: 'b', direction: 'out', author: 'bot', type: 'text', body: 'Recibido' },
      { id: 'c', direction: 'in', author: 'customer', type: 'image', body: null },
      { id: 'd', direction: 'in', author: 'customer', type: 'text', body: 'y esta' },
      { id: 'e', direction: 'in', author: 'customer', type: 'image', body: null },
    ]);
    expect(pending.map((m) => m.id)).toEqual(['c', 'e']);
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `i${i}`, direction: 'in' as const, author: 'customer' as const, type: 'image', body: null }));
    expect(pendingCustomerImages(many).map((m) => m.id)).toEqual(['i2', 'i3', 'i4']);
  });

  it('nunca termina en un mensaje del negocio', () => {
    const out = toModelMessages([
      { direction: 'in', author: 'customer', type: 'text', body: 'Hola' },
      { direction: 'out', author: 'bot', type: 'text', body: 'Buenas tardes' },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'Hola' }]);
  });
});

describe('prompt y configuración del tenant', () => {
  it('incluye los datos del negocio y marca lo que no se sabe', () => {
    const prompt = buildSystemPrompt(settings);
    expect(prompt).toContain('Inversiones Mora Mora');
    expect(prompt).toContain('Av. 19 de Abril');
    expect(prompt).toContain('IMM Visualizer');
    expect(prompt).toMatch(/Formas de pago: SIN DATO/);
    expect(prompt).toContain('usted');
  });
  it('no depende de la fecha, para poder cachearse', () => {
    expect(buildSystemPrompt(settings)).toBe(buildSystemPrompt(settings));
  });
  it('rechaza configuraciones sin datos del negocio', () => {
    expect(() => parseTenantBotSettings({})).toThrow(TenantSettingsError);
  });
});

describe('runBrainTurn', () => {
  const base = { system: buildSystemPrompt(settings) };

  it('busca en el catálogo, calcula cajas y responde', async () => {
    const { llm, calls } = scriptedLlm([
      tool('buscar_productos', { texto: 'beige', categoria: 'cerámicas', superficie: 'piso', uso: null, limite: 3 }),
      tool('calcular_cajas', { producto_id: PRODUCT.id, metros_cuadrados: 12 }),
      text('Para 12 m² del Aconna Beige necesitaría 7 cajas (12,6 m²). Un asesor confirmará la cantidad final.'),
    ]);
    const cat = catalog();
    const res = await runBrainTurn({ ...base, llm, messages: customer('Busco cerámica beige para 12 m² de piso'), tools: { catalog: cat, wastePercent: null } });

    expect(res.outcome).toBe('replied');
    expect(res.reply).toContain('7 cajas');
    expect(res.handoff).toBeNull();
    expect(res.iterations).toBe(3);
    expect(cat.search).toHaveBeenCalledWith({ text: 'beige', category: 'cerámicas', surface: 'piso', usage: null, limit: 3 });

    // La herramienta no le muestra el precio al modelo aunque exista en la BD.
    const toolResult = JSON.stringify(calls[1]?.messages.at(-1));
    expect(toolResult).toContain('lo confirma un asesor');
    expect(toolResult).not.toContain('99');
    // El cálculo de cajas se hizo en código.
    expect(JSON.stringify(calls[2]?.messages.at(-1))).toContain('\\"cajas\\":7');

    // Petición: modelo, esfuerzo, respaldo y caché configurados; nada de tool_choice forzado.
    expect(calls[0]).toMatchObject({
      model: 'claude-opus-5-5',
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
    });
    expect(calls[0]).not.toHaveProperty('tool_choice');
    expect(calls[0]).not.toHaveProperty('thinking');
  });

  it('sin coincidencias exactas devuelve sugerencias en una sola vuelta', async () => {
    const { llm, calls } = scriptedLlm([
      tool('buscar_productos', { texto: 'roble', categoria: null, superficie: 'piso', uso: null, limite: 3 }),
      text('No tengo ese nombre exacto, pero le sugiero el Aconna Beige.'),
    ]);
    const cat = catalog();
    cat.search.mockImplementationOnce(async () => []);
    const res = await runBrainTurn({ ...base, llm, messages: customer('¿Tienen roble?'), tools: { catalog: cat, wastePercent: null } });
    expect(res.outcome).toBe('replied');
    expect(cat.search).toHaveBeenCalledTimes(2);
    expect(cat.search.mock.calls[1]?.[0]).toMatchObject({ text: null, surface: 'piso' });
    const result = JSON.stringify(calls[1]?.messages.at(-1));
    expect(result).toContain('sugerencias');
    expect(result).toContain('Aconna Beige');
    expect(result).toContain('No digas que no hay stock');
  });

  it('envía fotos solo de productos reales con foto, máximo 3 por mensaje', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'].map((x) => `${x.repeat(8)}-1111-4111-8111-111111111111`);
    const rows: ProductRow[] = ids.map((id, i) => ({ ...PRODUCT, id, name: `Producto ${i + 1}`, has_photo: i !== 1 }));
    const { llm, calls } = scriptedLlm([
      tool('enviar_fotos', { producto_ids: [...ids, '99999999-1111-4111-8111-111111111111'] }),
      text('Le envié las fotos.'),
    ]);
    const res = await runBrainTurn({ ...base, llm, messages: customer('¿Tienen fotos?'), tools: { catalog: catalog(rows), wastePercent: null } });
    expect(res.photos).toEqual([
      { productId: ids[0], name: 'Producto 1' },
      { productId: ids[2], name: 'Producto 3' },
      { productId: ids[3], name: 'Producto 4' },
    ]);
    const result = JSON.stringify(calls[1]?.messages.at(-1));
    expect(result).toContain('Producto 2: no tiene foto');
    expect(result).toContain('máximo 3 fotos');
  });

  it('si el turno falla no se envían las fotos pedidas', async () => {
    const { llm } = scriptedLlm([tool('enviar_fotos', { producto_ids: [PRODUCT.id] }), text('Cuesta $20')]);
    const res = await runBrainTurn({ ...base, llm, messages: customer('fotos y precio'), tools: { catalog: catalog(), wastePercent: null } });
    expect(res.outcome).toBe('blocked_by_validator');
    expect(res.photos).toEqual([]);
  });

  it('limita la cantidad de resultados aunque el modelo pida más', async () => {
    const { llm } = scriptedLlm([
      tool('buscar_productos', { texto: null, categoria: null, superficie: null, uso: null, limite: 500 }),
      text('Estas son algunas opciones.'),
    ]);
    const cat = catalog();
    await runBrainTurn({ ...base, llm, messages: customer('¿Qué tienen?'), tools: { catalog: cat, wastePercent: null } });
    expect(cat.search.mock.calls[0]?.[0].limit).toBe(8);
  });

  it('deriva a un asesor cuando preguntan el precio', async () => {
    const { llm } = scriptedLlm([
      tool('derivar_a_asesor', { motivo: 'precio', resumen: 'Quiere precio de Aconna Beige para 12 m².' }),
      text('Con gusto. Un asesor le enviará la cotización en breve.'),
    ]);
    const res = await runBrainTurn({ ...base, llm, messages: customer('¿Cuánto cuesta?'), tools: { catalog: catalog(), wastePercent: null } });
    expect(res.outcome).toBe('handoff');
    expect(res.handoff).toEqual({ reason: 'precio', summary: 'Quiere precio de Aconna Beige para 12 m².' });
    expect(res.reply).toContain('asesor');
  });

  it('si el modelo inventa un precio, no se envía y se deriva', async () => {
    const { llm } = scriptedLlm([text('El Aconna Beige cuesta $18 la caja.')]);
    const res = await runBrainTurn({ ...base, llm, messages: customer('precio?'), tools: { catalog: catalog(), wastePercent: null } });
    expect(res.outcome).toBe('blocked_by_validator');
    expect(res.reply).toBe(FALLBACK_REPLY);
    expect(res.handoff?.reason).toBe('error');
  });

  it('devuelve errores de herramienta al modelo sin romper el turno', async () => {
    const { llm, calls } = scriptedLlm([
      tool('calcular_cajas', { producto_id: 'no-es-uuid', metros_cuadrados: -3 }),
      tool('herramienta_inventada', {}),
      text('¿Me confirma el producto que le interesa?'),
    ]);
    const res = await runBrainTurn({ ...base, llm, messages: customer('cajas'), tools: { catalog: catalog(), wastePercent: null } });
    expect(res.outcome).toBe('replied');
    const results = calls.slice(1).map((c) => c.messages.at(-1)?.content);
    expect(JSON.stringify(results)).toContain('"is_error":true');
  });

  it('un fallo del catálogo vuelve como error al modelo', async () => {
    const { llm, calls } = scriptedLlm([
      tool('buscar_productos', { texto: 'x', categoria: null, superficie: null, uso: null, limite: 3 }),
      text('Disculpe, tuve un inconveniente. ¿Le paso con un asesor?'),
    ]);
    const broken: CatalogReader = { search: async () => Promise.reject(new Error('bd caída')), get: async () => null };
    const res = await runBrainTurn({ ...base, llm, messages: customer('hola'), tools: { catalog: broken, wastePercent: null } });
    expect(res.outcome).toBe('replied');
    expect(JSON.stringify(calls[1]?.messages.at(-1))).toContain('Error interno');
  });

  it('ante un rechazo del modelo responde con el respaldo y deriva', async () => {
    const { llm } = scriptedLlm([{ stop: 'refusal', blocks: [] }]);
    const res = await runBrainTurn({ ...base, llm, messages: customer('...'), tools: { catalog: catalog(), wastePercent: null } });
    expect(res.outcome).toBe('refusal');
    expect(res.reply).toBe(FALLBACK_REPLY);
    expect(res.handoff?.reason).toBe('seguridad');
  });

  it('corta los bucles de herramientas', async () => {
    const loop = Array.from({ length: 10 }, () => tool('buscar_productos', { texto: 'x', categoria: null, superficie: null, uso: null, limite: 1 }));
    const { llm } = scriptedLlm(loop);
    const res = await runBrainTurn({
      ...base,
      llm,
      messages: customer('hola'),
      tools: { catalog: catalog(), wastePercent: null },
      config: { maxIterations: 3 },
    });
    expect(res.outcome).toBe('error');
    expect(res.iterations).toBe(3);
    expect(res.reply).toBe(FALLBACK_REPLY);
  });

  it('suma el uso de tokens de todas las vueltas', async () => {
    const { llm } = scriptedLlm([
      tool('buscar_productos', { texto: 'x', categoria: null, superficie: null, uso: null, limite: 1 }),
      text('Listo.'),
    ]);
    const res = await runBrainTurn({ ...base, llm, messages: customer('hola'), tools: { catalog: catalog(), wastePercent: null } });
    expect(res.usage).toEqual({ inputTokens: 200, outputTokens: 40, cacheReadTokens: 160 });
  });
});
