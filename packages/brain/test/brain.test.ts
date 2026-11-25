import { describe, expect, it, vi } from 'vitest';
import { conversationNote, customerFirstName, splitBubbles, storeStatus, typingPauseMs } from '../src/human.js';
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
  completeListing,
  sendPromisedPhotos,
  designBase,
  identifyProductInPhoto,
  polishReply,
  pendingVoiceNotes,
  promisesHandoff,
  toModelMessages,
  transcribeVoiceNote,
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
    for (const t of ['Son una excelente opción por su acabado mate.', 'Perfecto para exteriores, es antideslizante.', '¡Perfecto!', 'Con gusto. Quedamos a su orden para lo que necesite.']) {
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
    expect(out[0]?.content).toContain('envió una foto hace rato');
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

  it('marca las fotos posteriores a la última respuesta y la última foto anterior', () => {
    const pending = pendingCustomerImages([
      { id: 'a', direction: 'in', author: 'customer', type: 'image', body: null },
      { id: 'b', direction: 'out', author: 'bot', type: 'text', body: 'Recibido' },
      { id: 'c', direction: 'in', author: 'customer', type: 'image', body: null },
      { id: 'd', direction: 'in', author: 'customer', type: 'text', body: 'y esta' },
      { id: 'e', direction: 'in', author: 'customer', type: 'image', body: null },
    ]);
    // 'a' es anterior a la respuesta del bot, pero el cliente puede volver sobre ella.
    expect(pending.map((m) => m.id)).toEqual(['a', 'c', 'e']);
    const old = [
      { id: 'x', direction: 'in' as const, author: 'customer' as const, type: 'image', body: null },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, direction: (i % 2 ? 'out' : 'in') as 'in' | 'out', author: (i % 2 ? 'bot' : 'customer') as 'bot' | 'customer', type: 'text', body: 'hola' })),
      { id: 'y', direction: 'in' as const, author: 'customer' as const, type: 'text', body: '¿y lo de la foto?' },
    ];
    expect(pendingCustomerImages(old)).toEqual([]); // demasiado vieja
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
    expect(cat.search.mock.calls[1]?.[0]).toMatchObject({ text: null, category: null, surface: 'piso' });
    const result = JSON.stringify(calls[1]?.messages.at(-1));
    expect(result).toContain('sugerencias');
    expect(result).toContain('Aconna Beige');
    expect(result).toContain('No digas que no hay stock');
  });

  it('agrega los otros colores del mismo diseño a los resultados', async () => {
    const terra = { ...PRODUCT, id: '22222222-2222-4222-8222-222222222222', name: 'Archi Terra' };
    const cenizo = { ...PRODUCT, name: 'Archi Cenizo' };
    const cat = catalog([cenizo, terra]);
    const { llm, calls } = scriptedLlm([
      tool('buscar_productos', { texto: 'gris geométrico', categoria: null, superficie: null, uso: null, limite: 3 }),
      text('Sí, ese lo tenemos: es el Archi Cenizo.'),
    ]);
    await runBrainTurn({ ...base, llm, messages: customer('¿Tienen este?'), tools: { catalog: cat, wastePercent: null } });
    const result = JSON.parse(String((calls[1]!.messages.at(-1)!.content as { content: string }[])[0]!.content));
    expect(result.productos[0]).toMatchObject({ nombre: 'Archi Cenizo', mismo_diseno_en_otros_colores: ['Archi Terra'] });
    expect(result.productos[1]).toMatchObject({ nombre: 'Archi Terra', mismo_diseno_en_otros_colores: ['Archi Cenizo'] });
    // Solo una búsqueda extra por diseño, aunque haya dos productos de la misma familia.
    expect(cat.search).toHaveBeenCalledTimes(2);
  });

  it('si la foto del cliente es uno de los productos, el resultado lo dice', async () => {
    const rows = [
      { ...PRODUCT, name: 'Archi Cenizo', has_photo: true },
      { ...PRODUCT, id: '22222222-2222-4222-8222-222222222222', name: 'Libano Gris', has_photo: true },
    ];
    const cat = { ...catalog(rows), photos: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { mediaType: 'image/jpeg' as const, base64: 'X' }]))) };
    const run = vi.fn(async (c: { name: string }[]) => c[0]!.name);
    const { llm, calls } = scriptedLlm([
      tool('buscar_productos', { texto: 'gris geométrico', categoria: null, superficie: null, uso: null, limite: 3 }),
      text('Sí, ese lo tenemos: es el Archi Cenizo.'),
    ]);
    await runBrainTurn({
      ...base,
      llm,
      messages: customer('¿Tienen este?'),
      tools: { catalog: cat, wastePercent: null, catalogPhotos: { perSearch: 4, remaining: 8 }, identifyPhoto: { run, remaining: 2 } },
    });
    expect(run).toHaveBeenCalledWith([expect.objectContaining({ name: 'Archi Cenizo' }), expect.objectContaining({ name: 'Libano Gris' })]);
    expect(JSON.stringify(calls[1]!.messages.at(-1))).toContain('es_el_mismo_de_la_foto_del_cliente\\":\\"Archi Cenizo');
  });

  it('identifyProductInPhoto devuelve el nombre del número elegido, o null', async () => {
    const photo = { mediaType: 'image/jpeg' as const, base64: 'X' };
    const cands = [{ name: 'Archi Cenizo', photo }, { name: 'Libano Gris', photo }];
    const yes = scriptedLlm([text('1')]);
    expect(await identifyProductInPhoto(yes.llm, 'm', photo, cands)).toBe('Archi Cenizo');
    expect(JSON.stringify(yes.calls[0]!.messages)).toContain('Producto 2:');
    expect(await identifyProductInPhoto(scriptedLlm([text('0')]).llm, 'm', photo, cands)).toBeNull();
    expect(await identifyProductInPhoto(scriptedLlm([text('Ninguno')]).llm, 'm', photo, cands)).toBeNull();
    expect(await identifyProductInPhoto(scriptedLlm([text('7')]).llm, 'm', photo, cands)).toBeNull();
  });

  it('si el modelo termina sin escribir nada, se le pide la respuesta una vez', async () => {
    const { llm, calls } = scriptedLlm([text(''), text('Claro, le muestro opciones.')]);
    const res = await runBrainTurn({ ...base, llm, messages: customer('¿Qué cerámicas grises tienen?'), tools: { catalog: catalog(), wastePercent: null } });
    expect(res).toMatchObject({ outcome: 'replied', reply: 'Claro, le muestro opciones.' });
    const nudge = JSON.stringify(calls[1]!.messages);
    expect(nudge).toContain('NO es un mensaje del cliente');
    expect(nudge).toContain('sobre su mensaje \\"¿Qué cerámicas grises tienen?\\"');
    // Si vuelve a quedar vacía, no se insiste: se bloquea y deriva como antes.
    const twice = await runBrainTurn({ ...base, llm: scriptedLlm([text(''), text('')]).llm, messages: customer('Hola'), tools: { catalog: catalog(), wastePercent: null } });
    expect(twice).toMatchObject({ outcome: 'blocked_by_validator', error: 'empty' });
  });

  it('si el bot dice que mandó fotos sin mandarlas, se mandan las de los productos que nombró', () => {
    const seen = new Map([
      ['Bosco Camel', { id: 'b', hasPhoto: true }],
      ['Archi Terra', { id: 'a', hasPhoto: true }],
      ['Sin Foto', { id: 's', hasPhoto: false }],
      ['Brunel Dual', { id: 'r', hasPhoto: true }],
    ]);
    const effects = { handoff: null, photos: [] as { productId: string; name: string }[], seen };
    sendPromisedPhotos('Le envío tres modelos: *Archi Terra*, *Bosco Camel* y *Sin Foto*.', effects);
    expect(effects.photos).toEqual([{ productId: 'a', name: 'Archi Terra' }, { productId: 'b', name: 'Bosco Camel' }]);
    // Una oferta en pregunta no es una afirmación.
    const offer = { handoff: null, photos: [] as { productId: string; name: string }[], seen };
    sendPromisedPhotos('Tenemos el Brunel Dual. ¿Quiere que le mande las fotos?', offer);
    expect(offer.photos).toEqual([]);
  });

  it('completeListing agrega antes de la pregunta las opciones que el bot no nombró', () => {
    const effects = {
      handoff: null,
      photos: [{ productId: 'x', name: 'Notte Nero' }],
      listing: { names: ['Notte Nero', 'Stasera', 'Toba', 'Violina', 'Brooklyn'], total: 5 },
    };
    const out = completeListing('Tenemos el *Notte Nero* y el *Stasera*.\n\n¿Es para piso o pared?', effects);
    expect(out).toBe(
      'Tenemos el *Notte Nero* y el *Stasera*.\n\nTambién tenemos *Toba*, *Violina* y *Brooklyn*. Si quiere, le mando las fotos.\n\n¿Es para piso o pared?',
    );
    // Si ya los nombró todos (aunque sea sin tildes ni mayúsculas), no agrega nada.
    expect(completeListing('notte nero, stasera, toba, violina y brooklyn', effects)).toBe('notte nero, stasera, toba, violina y brooklyn');
    // Con más de las que caben, dice cuántas hay.
    const many = { ...effects, listing: { names: ['Notte Nero', 'Stasera', 'Toba', 'Violina'], total: 20 } };
    expect(completeListing('Tenemos el Notte Nero, el Stasera y el Toba.', many)).toContain('*Violina*. Si quiere, le mando las fotos. En total son unos 20 modelos');
    // Si se deriva a un asesor, no se toca.
    expect(completeListing('Le paso con un asesor.', { ...effects, handoff: { reason: 'otro' as const, summary: 'x' } })).toBe('Le paso con un asesor.');
  });

  it('designBase separa el diseño del color y deja fuera los nombres genéricos', () => {
    expect(designBase('Archi Cenizo')).toBe('Archi');
    expect(designBase('Exterior Medellin Gris')).toBe('Exterior Medellin');
    expect(designBase('Marmol Oslo')).toBeNull();
    expect(designBase('Brooklyn')).toBeNull();
  });

  it('después de buscar, el modelo ve las fotos del catálogo, con tope por turno', async () => {
    const rows = ['a', 'b', 'c'].map((x, i) => ({ ...PRODUCT, id: `${x.repeat(8)}-1111-4111-8111-111111111111`, name: `Madera ${i + 1}`, has_photo: i !== 1 }));
    const cat = {
      ...catalog(rows),
      photos: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { mediaType: 'image/jpeg' as const, base64: `FOTO-${id.slice(0, 1)}` }]))),
    };
    const { llm, calls } = scriptedLlm([
      tool('buscar_productos', { texto: 'madera', categoria: null, superficie: null, uso: null, limite: 3 }),
      tool('buscar_productos', { texto: 'madera clara', categoria: null, superficie: null, uso: null, limite: 3 }),
      text('Le muestro la Madera 1.'),
    ]);
    const budget = { perSearch: 3, remaining: 3 };
    const res = await runBrainTurn({ ...base, llm, messages: customer('Algo tipo madera'), tools: { catalog: cat, wastePercent: null, catalogPhotos: budget } });
    expect(res.outcome).toBe('replied');
    // Solo los que tienen foto: Madera 1 y Madera 3.
    expect(cat.photos).toHaveBeenNthCalledWith(1, [rows[0]!.id, rows[2]!.id]);
    const first = JSON.stringify(calls[1]!.messages.at(-1));
    expect(first).toContain('el cliente no la ha visto): Madera 1]');
    expect(first).toContain('el cliente no la ha visto): Madera 3]');
    expect(first).toContain('"data":"FOTO-a"');
    expect(first).not.toContain('Madera 2]');
    // Quedaba 1 foto en el turno: la segunda búsqueda trae solo una.
    expect(cat.photos).toHaveBeenNthCalledWith(2, [rows[0]!.id]);
    expect(budget.remaining).toBe(0);
  });

  it('si la categoría no trae nada, busca lo mismo en todo el catálogo', async () => {
    const { llm, calls } = scriptedLlm([
      tool('buscar_productos', { texto: 'gris', categoria: 'porcelanato', superficie: 'piso', uso: 'exterior', limite: 3 }),
      text('Para la terraza le sirve el Aconna Beige.'),
    ]);
    const cat = catalog();
    cat.search.mockImplementationOnce(async () => []);
    const res = await runBrainTurn({ ...base, llm, messages: customer('Porcelanato gris para terraza'), tools: { catalog: cat, wastePercent: null } });
    expect(res.outcome).toBe('replied');
    // 1.ª con categoría, 2.ª sin ella, 3.ª los otros colores del mismo diseño ("Aconna …").
    expect(cat.search).toHaveBeenCalledTimes(3);
    expect(cat.search.mock.calls[2]?.[0]).toMatchObject({ text: 'Aconna' });
    expect(cat.search.mock.calls[1]?.[0]).toMatchObject({ text: 'gris', category: null, surface: 'piso', usage: 'exterior' });
    const result = JSON.stringify(calls[1]?.messages.at(-1));
    expect(result).toContain('otras categorías');
    expect(result).toContain('Aconna Beige');
  });

  it('envía fotos solo de productos reales con foto, máximo 6 por mensaje', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', '7', '8'].map((x) => `${x.repeat(8)}-1111-4111-8111-111111111111`);
    const rows: ProductRow[] = ids.map((id, i) => ({ ...PRODUCT, id, name: `Producto ${i + 1}`, has_photo: i !== 1 }));
    const { llm, calls } = scriptedLlm([
      tool('enviar_fotos', { producto_ids: [...ids, '99999999-1111-4111-8111-111111111111'] }),
      text('Le envié las fotos.'),
    ]);
    const res = await runBrainTurn({ ...base, llm, messages: customer('¿Tienen fotos?'), tools: { catalog: catalog(rows), wastePercent: null } });
    // El 2 no tiene foto: salen 1, 3, 4, 5, 6 y 7; el 8 ya pasa del tope.
    expect(res.photos.map((p) => p.name)).toEqual(['Producto 1', 'Producto 3', 'Producto 4', 'Producto 5', 'Producto 6', 'Producto 7']);
    const result = JSON.stringify(calls[1]?.messages.at(-1));
    expect(result).toContain('Producto 2: no tiene foto');
    expect(result).toContain('máximo 6 fotos');
  });

  it('manda la foto de la fachada solo si el negocio la cargó', async () => {
    const withPhoto = scriptedLlm([tool('enviar_ubicacion', {}), text('Le mandé la foto de la fachada para que nos ubique fácil.')]);
    const res = await runBrainTurn({
      ...base,
      llm: withPhoto.llm,
      messages: customer('¿Dónde quedan?'),
      tools: { catalog: catalog([]), wastePercent: null, hasStorefrontPhoto: true },
    });
    expect(res.storefront).toBe(true);
    expect(JSON.stringify(withPhoto.calls[1]?.messages.at(-1))).toContain('No repitas la dirección completa');

    const noPhoto = scriptedLlm([tool('enviar_ubicacion', {}), text('Estamos en la Av. 19 de Abril.')]);
    const res2 = await runBrainTurn({ ...base, llm: noPhoto.llm, messages: customer('¿Dónde quedan?'), tools: { catalog: catalog([]), wastePercent: null } });
    expect(res2.storefront).toBeUndefined();
    expect(JSON.stringify(noPhoto.calls[1]?.messages.at(-1))).toContain('No hay foto de la fachada');
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
    expect(cat.search.mock.calls[0]?.[0].limit).toBe(15);
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

  it('si el modelo promete un asesor sin derivar, el pase se crea igual', async () => {
    const { llm } = scriptedLlm([text('Le voy a pasar su caso a uno de nuestros asesores. Un asesor le estará escribiendo por aquí mismo.')]);
    const res = await runBrainTurn({ ...base, llm, messages: customer('Quiero cotizar 20 metros'), tools: { catalog: catalog(), wastePercent: null } });
    expect(res.outcome).toBe('handoff');
    expect(res.handoff?.reason).toBe('otro');
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


describe('detalles humanos', () => {
  it('parte la respuesta en mensajes por párrafo, sin partir listas y con máximo 3', () => {
    expect(splitBubbles('Hola.\n\nTengo dos opciones.')).toEqual(['Hola.', 'Tengo dos opciones.']);
    expect(splitBubbles('Una sola línea\ncon salto')).toEqual(['Una sola línea\ncon salto']);
    expect(splitBubbles('Tengo estas:\n\n- Arrieta\n\n- Berilo\n\n¿Cuál le gusta?')).toEqual(['Tengo estas:\n\n- Arrieta\n\n- Berilo', '¿Cuál le gusta?']);
    expect(splitBubbles('a\n\nb\n\nc\n\nd')).toEqual(['a', 'b', 'c\n\nd']);
    expect(splitBubbles('  \n\n  ')).toEqual([]);
  });

  it('la pausa de "escribiendo" crece con el largo, con tope', () => {
    expect(typingPauseMs('Sí')).toBe(800);
    expect(typingPauseMs('a'.repeat(60))).toBe(2100);
    expect(typingPauseMs('a'.repeat(500))).toBe(3500);
  });

  it('usa solo un primer nombre que parezca nombre', () => {
    expect(customerFirstName('carolina PÉREZ')).toBe('Carolina');
    expect(customerFirstName('🙂')).toBeNull();
    expect(customerFirstName('J')).toBeNull();
    expect(customerFirstName(null)).toBeNull();
  });

  it('la nota trae la hora de la tienda y el nombre, sin inventarlo', () => {
    // 2026-11-20T01:30Z = jueves 21:30 en Caracas.
    const note = conversationNote({ customerName: 'Ana María', now: new Date('2026-11-20T01:30:00Z'), timezone: 'America/Caracas' });
    expect(note).toMatch(/jueves/);
    expect(note).toContain('de noche');
    expect(note).toContain('"Ana"');
    const anon = conversationNote({ customerName: null, now: new Date('2026-11-20T14:00:00Z'), timezone: 'America/Caracas' });
    expect(anon).toContain('de mañana');
    expect(anon).toContain('no se lo inventes');
  });

  describe('horario de la tienda', () => {
    // Lunes a viernes 8 a 17, sábado 8 a 13 (Inversiones Mora Mora). Caracas = UTC-4.
    const hours = moraMora.settings.business.openingHours;
    const at = (iso: string) => storeStatus(new Date(iso), 'America/Caracas', hours);

    it('dice si está abierta y a qué hora cierra', () => {
      expect(at('2026-11-23T14:00:00Z')).toEqual({ open: true, closesAt: '5:00 p. m.' }); // lunes 10:00
      expect(at('2026-11-28T16:59:00Z')).toEqual({ open: true, closesAt: '1:00 p. m.' }); // sábado 12:59
    });

    it('si está cerrada, dice cuándo abre', () => {
      expect(at('2026-11-23T11:00:00Z')).toEqual({ open: false, opensAt: 'hoy a las 8:00 a. m.' }); // lunes 7:00
      expect(at('2026-11-23T21:00:00Z')).toEqual({ open: false, opensAt: 'mañana a las 8:00 a. m.' }); // lunes 17:00
      expect(at('2026-11-28T17:00:00Z')).toEqual({ open: false, opensAt: 'el lunes a las 8:00 a. m.' }); // sábado 13:00
      expect(at('2026-11-29T15:00:00Z')).toEqual({ open: false, opensAt: 'mañana a las 8:00 a. m.' }); // domingo
    });

    it('sin horario cargado no dice nada', () => {
      expect(storeStatus(new Date(), 'America/Caracas', [])).toBeNull();
      expect(conversationNote({ customerName: null, now: new Date(), timezone: 'America/Caracas' })).not.toContain('La tienda está');
    });

    it('la nota lo incluye', () => {
      const note = conversationNote({ customerName: null, now: new Date('2026-11-28T23:00:00Z'), timezone: 'America/Caracas', openingHours: hours });
      expect(note).toContain('La tienda está cerrada: abre el lunes a las 8:00 a. m.');
    });
  });
});

describe('notas de voz, ubicaciones y contactos para el modelo', () => {
  it('pasa la transcripción, la ubicación sin coordenadas y los contactos sin teléfonos', () => {
    const out = toModelMessages([
      { id: 'a', direction: 'in', author: 'customer', type: 'audio', body: 'Quiero porcelanato gris para la terraza' },
      { id: 'b', direction: 'in', author: 'customer', type: 'location', body: 'Mi casa, Barrio Obrero (7.76690, -72.22500)' },
      { id: 'c', direction: 'in', author: 'customer', type: 'location', body: '7.76690, -72.22500' },
      { id: 'd', direction: 'in', author: 'customer', type: 'contacts', body: 'Arq. Luis Pérez: 584141234567\nMaestro Juan: 584241112233, 584121112233' },
      { id: 'e', direction: 'in', author: 'customer', type: 'audio', body: null },
    ]);
    const text = String(out[0]?.content);
    expect(text).toContain('[Nota de voz del cliente, transcrita automáticamente:] Quiero porcelanato gris para la terraza');
    expect(text).toContain('[El cliente compartió una ubicación: Mi casa, Barrio Obrero.]');
    expect(text).toContain('[El cliente compartió una ubicación (sin nombre ni dirección).]');
    expect(text).toContain('[El cliente compartió la tarjeta de contacto de: Arq. Luis Pérez; Maestro Juan.]');
    expect(text).toContain('no se pudo transcribir');
    expect(text).not.toMatch(/7\.76|5841/);
  });

  it('las fotos que mandó el negocio se marcan como foto, no como texto suelto', () => {
    const out = toModelMessages([
      { id: 'a', direction: 'in', author: 'customer', type: 'text', body: 'Busco cerámica negra' },
      { id: 'b', direction: 'out', author: 'bot', type: 'image', body: 'Notte Nero' },
      { id: 'c', direction: 'out', author: 'bot', type: 'text', body: 'Le muestro el Notte Nero.' },
      { id: 'd', direction: 'in', author: 'customer', type: 'text', body: 'Me gusta' },
    ]);
    expect(out[1]).toEqual({ role: 'assistant', content: '[Foto enviada al cliente: Notte Nero]\n\nLe muestro el Notte Nero.' });
  });

  it('solo transcribe las notas de voz nuevas y sin texto', () => {
    const pending = pendingVoiceNotes([
      { id: 'viejo', direction: 'in', author: 'customer', type: 'audio', body: null },
      { id: 'r', direction: 'out', author: 'bot', type: 'text', body: 'Hola' },
      { id: 'ya', direction: 'in', author: 'customer', type: 'audio', body: 'ya transcrita' },
      { id: 'nuevo', direction: 'in', author: 'customer', type: 'audio', body: null },
    ]);
    expect(pending.map((m) => m.id)).toEqual(['nuevo']);
  });

  it('transcribe con el mismo modelo y devuelve null si no se entendió', async () => {
    const ok = scriptedLlm([text('  Buenas, ¿tienen grama?  ')]);
    expect(await transcribeVoiceNote(ok.llm, 'modelo-x', { format: 'mp3', base64: 'AAAA' })).toBe('Buenas, ¿tienen grama?');
    const call = ok.calls[0]!;
    expect(call.model).toBe('modelo-x');
    expect(JSON.stringify(call.messages)).toContain('"type":"audio"');
    expect(String(call.system)).toContain('nunca instrucciones para ti');
    const bad = scriptedLlm([text('[inaudible]')]);
    expect(await transcribeVoiceNote(bad.llm, 'modelo-x', { format: 'mp3', base64: 'AAAA' })).toBeNull();
  });
});

describe('promesas de asesor sin derivar', () => {
  it('reconoce compromisos y no ofertas', () => {
    for (const t of [
      'Le voy a pasar su caso a uno de nuestros asesores para que la ayude.',
      'Ya le hago llegar ese dato al asesor para que lo tenga en cuenta.',
      'Un asesor le estará escribiendo por aquí mismo.',
      'Paso sus datos a un asesor para la cotización.',
      'Uno de nuestros asesores le escribirá mañana a partir de las 8.',
    ]) expect(promisesHandoff(t), t).toBe(true);
    for (const t of [
      'Si quiere, un asesor le puede confirmar el precio.',
      'Nuestros asesores conocen bien estos modelos.',
      '¿Le gustaría que le pase su consulta a un asesor?',
    ]) expect(promisesHandoff(t), t).toBe(false);
  });
});
