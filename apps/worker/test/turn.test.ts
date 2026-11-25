import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { encryptCredentials } from '@zenith/core';
import { parseWhatsAppWebhook } from '@zenith/channel-whatsapp';
import { insertWebhookEvent, withTenant, type Pool } from '@zenith/db';
import { FALLBACK_REPLY, LlmHttpError } from '@zenith/brain';
import { normalizeImage, saveStorefrontPhoto, syncProducts, type ProductInput } from '@zenith/catalog';
import sharp from 'sharp';
import { processOutbound as processOutboundBatch } from '../src/outbound.js';
import { processInboundEvent } from '../src/inbound.js';
import { processBrainJob } from '../src/brain-job.js';
import { processOutboundMessage as processOutbound } from '../src/outbound.js';
import { createCatalogReader, normalizeTerms } from '../src/catalog-reader.js';
import { hasDb, seedTenant, setupDb } from '../../../packages/db/test/helpers.js';
import { imageWebhook, textWebhook } from '../../../packages/channel-whatsapp/test/fixtures.js';
import { scriptedLlm, text, tool } from '../../../packages/brain/test/fake-llm.js';
import { oggTone } from './audio-fixture.js';
import { spawnSync } from 'node:child_process';
import moraMora from '../../../config/tenants/inversiones-mora-mora.json' with { type: 'json' };

const masterKey = randomBytes(32);

const tile = (externalId: string, name: string, attrs: Record<string, unknown>, extra: Partial<ProductInput> = {}): ProductInput => ({
  externalId,
  name,
  category: 'ceramicas',
  categoryName: 'Cerámicas',
  description: null,
  format: '60x60/1.80m²/5 Piezas',
  pieceWidthCm: 60,
  pieceLengthCm: 60,
  areaPerBoxM2: 1.8,
  piecesPerBox: 5,
  attributes: attrs,
  price: null,
  currency: null,
  onOffer: false,
  inVisualizer: true,
  ...extra,
});

describe('normalizeTerms', () => {
  it('quita tildes, signos, palabras cortas y la s final', () => {
    // Igual que unaccent() en Postgres: la ñ también pierde la tilde.
    expect(normalizeTerms('¿Cerámicas de MADERA para el baño?')).toEqual(['ceramica', 'madera', 'bano']);
    expect(normalizeTerms('algo tipo madera')).toEqual(['madera']);
    expect(normalizeTerms(null)).toEqual([]);
  });
});

describe.skipIf(!hasDb)('turno completo del bot', () => {
  let owner: pg.Pool;
  let app: Pool;
  let t: Awaited<ReturnType<typeof seedTenant>>;
  let other: Awaited<ReturnType<typeof seedTenant>>;
  let seq = 0;

  const graph = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${++seq}` }] }), { status: 200 }));
  const outboundDeps = () => ({ pool: app, masterKey, graphApiVersion: 'v21.0', fetch: graph });

  async function customerSays(body: string, from = '584141230000', timestamp = String(Math.floor(Date.now() / 1000))) {
    seq++;
    const payload = textWebhook({ id: `wamid.IN${Date.now()}${seq}`, from, body, timestamp });
    (payload.entry[0]!.changes[0]!.value as { metadata: { phone_number_id: string } }).metadata.phone_number_id = t.phoneNumberId;
    const [event] = parseWhatsAppWebhook(payload);
    const id = await insertWebhookEvent(app, event!, payload);
    const outcome = await processInboundEvent(app, id!);
    if (outcome.result !== 'message') throw new Error(`se esperaba un mensaje, llegó ${outcome.result}`);
    return outcome;
  }

  beforeAll(async () => {
    ({ owner, app } = await setupDb());
    t = await seedTenant(owner, 'turn');
    other = await seedTenant(owner, 'turn-otro');
    await owner.query('UPDATE tenants SET settings = $2 WHERE id = $1', [t.tenantId, JSON.stringify(moraMora.settings)]);
    await owner.query('UPDATE channel_accounts SET credentials_enc = $2 WHERE id = $1', [
      t.channelAccountId,
      encryptCredentials(JSON.stringify({ accessToken: 'token-prueba' }), masterKey, t.channelAccountId),
    ]);
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c8a27a' } }).jpeg().toBuffer();
    const photo = await normalizeImage(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
    await withTenant(app, t.tenantId, (c) =>
      syncProducts(c, t.tenantId, 'imm_store', [
        tile('1', 'Aconna Beige', { surface: 'Piso y pared', finish: 'Mate', usage: 'Interior y exterior', features: ['Antideslizante'] }, { images: [photo!] }),
        tile('2', 'Marmol Velletri', { surface: 'Pared', finish: 'Brillante', usage: 'Interior y exterior' }, { format: '25x75/1.50m²/8 Piezas', areaPerBoxM2: 1.5, piecesPerBox: 8 }),
        tile('3', 'Sanitario Cascade', { brand: 'Corona', finish: 'Brillante' }, {
          category: 'sanitarios', categoryName: 'Sanitarios', format: null, areaPerBoxM2: null, piecesPerBox: null, inVisualizer: false,
        }),
      ]),
    );
    // Un producto de otro tenant que nunca debe aparecer.
    await withTenant(app, other.tenantId, (c) => syncProducts(c, other.tenantId, 'imm_store', [tile('1', 'Producto Ajeno Beige', { surface: 'Piso' })]));
  });

  afterAll(async () => {
    if (t) {
      await owner.query('DELETE FROM webhook_events WHERE channel_external_account_id = ANY($1)', [[t.phoneNumberId, other?.phoneNumberId]]);
      await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[t.tenantId, other?.tenantId].filter(Boolean)]);
    }
    await owner?.end();
    await app?.end();
  });

  it('la búsqueda del catálogo filtra, no distingue tildes y no ve otros tenants', async () => {
    const reader = createCatalogReader(app, t.tenantId);
    const beige = await reader.search({ text: 'beige', category: null, surface: null, usage: null, limit: 8 });
    expect(beige.map((p) => p.name)).toEqual(['Aconna Beige']);
    const marmol = await reader.search({ text: 'mármol brillante', category: 'cerámicas', surface: 'pared', usage: null, limit: 8 });
    expect(marmol[0]?.name).toBe('Marmol Velletri');
    const pisos = await reader.search({ text: null, category: null, surface: 'piso', usage: 'exterior', limit: 8 });
    expect(pisos.map((p) => p.name)).toEqual(['Aconna Beige']);
    const sanitarios = await reader.search({ text: null, category: 'sanitarios', surface: null, usage: null, limit: 8 });
    expect(sanitarios.map((p) => p.name)).toEqual(['Sanitario Cascade']);
  });

  it('responde al cliente, guarda la respuesta y la envía por WhatsApp', async () => {
    const msg = await customerSays('Hola, busco cerámica beige para 12 m² de piso', '584141230001');
    const productId = (await createCatalogReader(app, t.tenantId).search({ text: 'beige', category: null, surface: null, usage: null, limit: 1 }))[0]!.id;
    const { llm, calls } = scriptedLlm([
      tool('buscar_productos', { texto: 'beige', categoria: null, superficie: 'piso', uso: null, limite: 3 }),
      tool('calcular_cajas', { producto_id: productId, metros_cuadrados: 12 }),
      text('Buenas tardes. Le recomiendo el Aconna Beige 60x60 mate y antideslizante: para 12 m² necesitaría 7 cajas.'),
    ]);

    const turn = await processBrainJob({ pool: app, llm }, { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId });
    expect(turn).toMatchObject({ result: 'replied', handoff: false, outcome: 'replied' });
    if (turn.result !== 'replied') return;

    // El modelo recibió el historial con el mensaje del cliente y el prompt del negocio.
    expect(JSON.stringify(calls[0]?.messages)).toContain('busco cerámica beige');
    expect(String(calls[0]?.system)).toContain('Inversiones Mora Mora');
    expect(JSON.stringify(calls[2]?.messages.at(-1))).toContain('\\"cajas\\":7');

    const sent = await processOutbound(outboundDeps(), { tenantId: t.tenantId, outboundMessageId: turn.outboundMessageId });
    expect(sent.result).toBe('sent');
    const [url, init] = graph.mock.calls.at(-1)!;
    expect(String(url)).toBe(`https://graph.facebook.com/v21.0/${t.phoneNumberId}/messages`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ to: '584141230001', text: { body: expect.stringContaining('7 cajas') } });
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token-prueba');

    const rows = await withTenant(app, t.tenantId, async (c) => ({
      out: (await c.query(`SELECT status, external_message_id FROM outbound_messages WHERE id = $1`, [turn.outboundMessageId])).rows[0],
      msg: (await c.query(`SELECT author, body, external_message_id FROM messages WHERE conversation_id = $1 AND direction = 'out'`, [msg.conversationId])).rows,
      run: (await c.query(`SELECT outcome, iterations, input_tokens FROM ai_runs WHERE conversation_id = $1`, [msg.conversationId])).rows,
    }));
    expect(rows.out?.status).toBe('sent');
    expect(rows.msg).toHaveLength(1);
    expect(rows.msg[0]).toMatchObject({ author: 'bot', external_message_id: rows.out?.external_message_id });
    expect(rows.run).toEqual([{ outcome: 'replied', iterations: 3, input_tokens: 300 }]);

    // Reintentar el mismo turno o el mismo envío no duplica nada.
    expect(await processBrainJob({ pool: app, llm: scriptedLlm([]).llm }, { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId })).toEqual({
      result: 'skipped',
      reason: 'already_answered',
    });
    expect(await processOutbound(outboundDeps(), { tenantId: t.tenantId, outboundMessageId: turn.outboundMessageId })).toEqual({ result: 'skipped' });
  });

  it('envía las fotos antes del texto y sube cada foto a WhatsApp una sola vez', async () => {
    const reader = createCatalogReader(app, t.tenantId);
    const [aconna] = await reader.search({ text: 'aconna', category: null, surface: null, usage: null, limit: 1 });
    expect(aconna?.has_photo).toBe(true);
    const [sanitario] = await reader.search({ text: 'cascade', category: null, surface: null, usage: null, limit: 1 });
    expect(sanitario?.has_photo).toBe(false);

    const calls: string[] = [];
    let n = 0;
    const meta = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/media')) {
        calls.push('subida');
        return new Response(JSON.stringify({ id: `media-${++n}` }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body));
      calls.push(body.type === 'image' ? `foto:${body.image.id}:${body.image.caption}` : `texto:${body.text.body}`);
      return new Response(JSON.stringify({ messages: [{ id: `wamid.P${++n}` }] }), { status: 200 });
    });

    for (const from of ['584141230011', '584141230012']) {
      const msg = await customerSays('¿Me envía fotos del Aconna Beige?', from);
      const turn = await processBrainJob(
        { pool: app, llm: scriptedLlm([
            tool('enviar_fotos', { producto_ids: [aconna!.id, sanitario!.id] }),
            // El modelo a veces repite el nombre de la foto o la marca interna: no se manda.
            text('*Aconna Beige*\n\n[Foto enviada al cliente: Aconna Beige]\nAquí tiene la foto.'),
          ]).llm },
        { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId },
      );
      if (turn.result !== 'replied') throw new Error('se esperaba respuesta');
      expect(turn.outboundMessageIds).toHaveLength(2);
      expect(turn.outboundMessageIds.at(-1)).toBe(turn.outboundMessageId);
      const results = await processOutboundBatch({ ...outboundDeps(), fetch: meta }, { tenantId: t.tenantId, outboundMessageIds: turn.outboundMessageIds });
      expect(results.map((r) => r.result)).toEqual(['sent', 'sent']);
    }

    // Primera conversación: se sube la foto. Segunda: se reutiliza el id guardado.
    expect(calls).toEqual([
      'subida',
      'foto:media-1:Aconna Beige',
      'texto:Aquí tiene la foto.',
      'foto:media-1:Aconna Beige',
      'texto:Aquí tiene la foto.',
    ]);
  });

  it('cuando preguntan la dirección manda la foto de la fachada con la dirección como pie', async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer();
    await withTenant(app, t.tenantId, (c) => saveStorefrontPhoto(c, t.tenantId, { name: 'fachada.png', data: jpeg }));
    const sent: string[] = [];
    const meta = vi.fn<typeof fetch>(async (url, init) => {
      if (new URL(String(url)).pathname.endsWith('/media')) return new Response(JSON.stringify({ id: 'media-fachada' }), { status: 200 });
      const body = JSON.parse(String(init?.body));
      sent.push(body.type === 'image' ? `foto:${body.image.id}:${body.image.caption}` : `texto:${body.text.body}`);
      return new Response(JSON.stringify({ messages: [{ id: `wamid.F${++seq}` }] }), { status: 200 });
    });
    try {
      const msg = await customerSays('¿Dónde quedan?', '584141230097');
      const turn = await processBrainJob(
        { pool: app, llm: scriptedLlm([tool('enviar_ubicacion', {}), text('Le mandé la foto de la fachada para que nos ubique fácil.')]).llm },
        { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId },
      );
      if (turn.result !== 'replied') throw new Error('se esperaba respuesta');
      await processOutboundBatch({ ...outboundDeps(), fetch: meta }, { tenantId: t.tenantId, outboundMessageIds: turn.outboundMessageIds });
      expect(sent).toEqual([
        `foto:media-fachada:${moraMora.settings.business.address}`,
        'texto:Le mandé la foto de la fachada para que nos ubique fácil.',
      ]);
      // La fachada no cuenta como producto que le interesó al cliente.
      const photo = await withTenant(app, t.tenantId, async (c) =>
        (await c.query(`SELECT product_id, purpose, mime_type FROM product_images WHERE purpose = 'storefront'`)).rows,
      );
      expect(photo).toEqual([{ product_id: null, purpose: 'storefront', mime_type: 'image/png' }]);
    } finally {
      await owner.query(`DELETE FROM product_images WHERE tenant_id = $1 AND purpose = 'storefront'`, [t.tenantId]);
    }
  });

  it.skipIf(spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0)(
    'transcribe la nota de voz, guarda el texto y el bot responde a lo que dijo',
    async () => {
      seq++;
      const payload = textWebhook({ id: `wamid.VOZ${Date.now()}${seq}`, from: '584141230095' });
      const value = payload.entry[0]!.changes[0]!.value as { metadata: { phone_number_id: string }; messages: Record<string, unknown>[] };
      value.metadata.phone_number_id = t.phoneNumberId;
      const m = value.messages[0]!;
      m.type = 'audio';
      delete m.text;
      m.audio = { id: 'media-voz-1', mime_type: 'audio/ogg; codecs=opus', voice: true };
      const [event] = parseWhatsAppWebhook(payload);
      const msg = await processInboundEvent(app, (await insertWebhookEvent(app, event!, payload))!);
      if (msg.result !== 'message') throw new Error('se esperaba un mensaje');

      const ogg = oggTone();
      const meta = vi.fn<typeof fetch>(async (url) => {
        const u = String(url);
        if (u.endsWith('/v21.0/media-voz-1')) {
          return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=voz', mime_type: 'audio/ogg; codecs=opus' }), { status: 200 });
        }
        if (u.includes('lookaside')) return new Response(new Uint8Array(ogg), { status: 200, headers: { 'content-type': 'audio/ogg' } });
        return new Response(JSON.stringify({ success: true }), { status: 200 }); // leído
      });
      const { llm, calls } = scriptedLlm([text('Quiero porcelanato gris para la terraza, son veinte metros.'), text('Para la terraza le va bien un porcelanato antideslizante.')]);
      const turn = await processBrainJob(
        { pool: app, llm, media: { masterKey, graphApiVersion: 'v21.0', fetch: meta }, voice: { llm, model: 'modelo-voz' } },
        { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId },
      );
      expect(turn).toMatchObject({ result: 'replied' });
      // 1.ª llamada: transcripción con el audio en mp3. 2.ª: el turno, ya con el texto.
      expect(calls[0]!.model).toBe('modelo-voz');
      expect(JSON.stringify(calls[0]!.messages)).toContain('"format":"mp3"');
      expect(JSON.stringify(calls[1]!.messages)).toContain('transcrita automáticamente:] Quiero porcelanato gris para la terraza');
      const saved = (await owner.query('SELECT body FROM messages WHERE id = $1', [msg.messageId])).rows[0];
      expect(saved.body).toBe('Quiero porcelanato gris para la terraza, son veinte metros.');
    },
  );

  it('marca el mensaje como leído y muestra "escribiendo…" antes de responder', async () => {
    const order: string[] = [];
    const meta = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      order.push(`meta:${body.status ?? body.type}:${body.typing_indicator?.type ?? ''}:${body.message_id ?? ''}`);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const msg = await customerSays('Hola, ¿tienen grama artificial?', '584141230096');
    const external = (await owner.query('SELECT external_message_id FROM messages WHERE id = $1', [msg.messageId])).rows[0].external_message_id;
    const { llm } = scriptedLlm([text('Sí, tenemos grama artificial.')]);
    const spy = { ...llm, create: async (...args: Parameters<typeof llm.create>) => (order.push('modelo'), llm.create(...args)) };
    const turn = await processBrainJob(
      { pool: app, llm: spy, media: { masterKey, graphApiVersion: 'v21.0', fetch: meta } },
      { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId },
    );
    expect(turn).toMatchObject({ result: 'replied' });
    expect(order).toEqual([`meta:read:text:${external}`, 'modelo']);

    // Si Meta falla, igual responde.
    const down = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code: 131009, message: 'x' } }), { status: 400 }));
    const msg2 = await customerSays('¿Y en qué colores?', '584141230096');
    const turn2 = await processBrainJob(
      { pool: app, llm: scriptedLlm([text('Tenemos varios tonos de verde.')]).llm, media: { masterKey, graphApiVersion: 'v21.0', fetch: down } },
      { tenantId: t.tenantId, conversationId: msg2.conversationId, triggerMessageId: msg2.messageId },
    );
    expect(turn2).toMatchObject({ result: 'replied' });
  });

  it('parte la respuesta en mensajes cortos, con una pausa de "escribiendo" entre ellos', async () => {
    const msg = await customerSays('Buenas, busco algo tipo cemento para la pared', '584141230021');
    const turn = await processBrainJob(
      { pool: app, llm: scriptedLlm([text('Buenas tardes. Tengo la *Itria Gris*: lisa, mate, gris parejo.\n\n¿Cuántos metros tiene la pared?')]).llm },
      { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId },
    );
    if (turn.result !== 'replied') throw new Error('se esperaba respuesta');
    expect(turn.outboundMessageIds).toHaveLength(2);
    expect(turn.outboundMessageIds[0]).toBe(turn.outboundMessageId);
    expect(turn.pausesMs[0]).toBe(0); // el primero sale apenas está listo
    expect(turn.pausesMs[1]).toBeGreaterThanOrEqual(800);

    const sent: string[] = [];
    const waits: number[] = [];
    const meta = vi.fn<typeof fetch>(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)).text.body);
      return new Response(JSON.stringify({ messages: [{ id: `wamid.B${sent.length}${Date.now()}` }] }), { status: 200 });
    });
    const deps = { ...outboundDeps(), fetch: meta, sleep: async (ms: number) => void waits.push(ms) };
    const job = { tenantId: t.tenantId, outboundMessageIds: turn.outboundMessageIds, pausesMs: turn.pausesMs };
    expect((await processOutboundBatch(deps, job)).map((r) => r.result)).toEqual(['sent', 'sent']);
    expect(sent).toEqual(['Buenas tardes. Tengo la *Itria Gris*: lisa, mate, gris parejo.', '¿Cuántos metros tiene la pared?']);
    expect(waits).toEqual([turn.pausesMs[1]]);

    // Un reintento del lote no reenvía ni vuelve a esperar.
    expect((await processOutboundBatch(deps, job)).map((r) => r.result)).toEqual(['skipped', 'skipped']);
    expect(waits).toHaveLength(1);
  });

  it('el modelo ve la foto que manda el cliente, achicada y sin metadatos', async () => {
    seq++;
    const payload = structuredClone(imageWebhook);
    const value = payload.entry[0]!.changes[0]!.value as { metadata: { phone_number_id: string }; messages: unknown[]; contacts: { wa_id: string }[] };
    value.metadata.phone_number_id = t.phoneNumberId;
    value.contacts[0]!.wa_id = '584141230099';
    value.messages = [{ from: '584141230099', id: `wamid.IMG${Date.now()}${seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'media-foto-1', mime_type: 'image/jpeg', caption: '¿Tienen algo así?' } }];
    const [event] = parseWhatsAppWebhook(payload);
    const msg = await processInboundEvent(app, (await insertWebhookEvent(app, event!, payload))!);
    if (msg.result !== 'message') throw new Error('se esperaba un mensaje');

    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#d9c7a8' } })
      .withMetadata({ exif: { IFD0: { Copyright: 'dato-privado' } } })
      .jpeg()
      .toBuffer();
    const meta = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/v21.0/media-foto-1')) {
        return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'image/jpeg' }), { status: 200 });
      }
      return new Response(new Uint8Array(big), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    const { llm, calls } = scriptedLlm([text('Gracias por la foto. Se parece mucho a nuestro *Aconna Beige*.')]);
    const turn = await processBrainJob(
      { pool: app, llm, media: { masterKey, graphApiVersion: 'v21.0', fetch: meta } },
      { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId },
    );
    expect(turn).toMatchObject({ result: 'replied' });
    expect((meta.mock.calls[0]![1]?.headers as Record<string, string>).Authorization).toBe('Bearer token-prueba');

    const content = calls[0]!.messages.at(-1)!.content as { type: string; text?: string; source?: { data: string } }[];
    // Primero la nota con la hora de la tienda y el nombre del cliente; después, la foto.
    expect(content.map((b) => b.type)).toEqual(['text', 'text', 'image', 'text']);
    expect(content[0]?.text).toMatch(/^\[Datos internos/);
    expect(content[3]?.text).toBe('¿Tienen algo así?');
    const seen = Buffer.from(content[2]!.source!.data, 'base64');
    const info = await sharp(seen).metadata();
    expect(Math.max(info.width!, info.height!)).toBe(1024);
    expect(info.exif).toBeUndefined();

    // Sin acceso a la foto, el turno igual responde con la nota de texto.
    const failing = scriptedLlm([text('¿Podría describirme el producto?')]);
    const down = vi.fn<typeof fetch>(async () => new Response('{}', { status: 404 }));
    seq++;
    value.messages = [{ from: '584141230099', id: `wamid.IMG${Date.now()}${seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'media-foto-2', mime_type: 'image/jpeg' } }];
    const [event2] = parseWhatsAppWebhook(payload);
    const msg2 = await processInboundEvent(app, (await insertWebhookEvent(app, event2!, payload))!);
    if (msg2.result !== 'message') throw new Error('se esperaba un mensaje');
    const turn2 = await processBrainJob(
      { pool: app, llm: failing.llm, media: { masterKey, graphApiVersion: 'v21.0', fetch: down } },
      { tenantId: t.tenantId, conversationId: msg2.conversationId, triggerMessageId: msg2.messageId },
    );
    expect(turn2).toMatchObject({ result: 'replied' });
    expect(JSON.stringify(failing.calls[0]!.messages.at(-1))).toContain('no tienes a la vista');
  });

  it('si el cliente escribió otra vez, el turno viejo se descarta', async () => {
    const first = await customerSays('Hola', '584141230002');
    await customerSays('¿Tienen sanitarios?', '584141230002');
    const { llm, calls } = scriptedLlm([text('no debería usarse')]);
    expect(await processBrainJob({ pool: app, llm }, { tenantId: t.tenantId, conversationId: first.conversationId, triggerMessageId: first.messageId })).toEqual({
      result: 'skipped',
      reason: 'superseded',
    });
    expect(calls).toHaveLength(0);
  });

  it('ordena por llegada aunque la respuesta del bot tenga una hora posterior al siguiente mensaje', async () => {
    const now = Math.floor(Date.now() / 1000);
    const first = await customerSays('Hola', '584141230010', String(now));
    const reply = await processBrainJob(
      { pool: app, llm: scriptedLlm([text('Buenas tardes, ¿en qué le ayudo?')]).llm },
      { tenantId: t.tenantId, conversationId: first.conversationId, triggerMessageId: first.messageId },
    );
    expect(reply.result).toBe('replied');
    // El cliente contesta en el mismo segundo: WhatsApp le pone una hora anterior a la respuesta guardada.
    const second = await customerSays('Busco sanitarios', '584141230010', String(now));
    const { llm, calls } = scriptedLlm([text('Con gusto.')]);
    const turn = await processBrainJob({ pool: app, llm }, { tenantId: t.tenantId, conversationId: second.conversationId, triggerMessageId: second.messageId });
    expect(turn.result).toBe('replied');
    const sent = calls[0]!.messages;
    expect(sent.at(-1)).toMatchObject({ role: 'user', content: 'Busco sanitarios' });
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('al pedir precio deriva al asesor, el bot se calla y el asesor queda avisado', async () => {
    const msg = await customerSays('¿Cuánto cuesta el Aconna Beige?', '584141230003');
    const { llm } = scriptedLlm([
      tool('derivar_a_asesor', { motivo: 'precio', resumen: 'Pide precio del Aconna Beige.' }),
      text('Con gusto. Un asesor le enviará la cotización en breve.'),
    ]);
    const turn = await processBrainJob({ pool: app, llm }, { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId });
    expect(turn).toMatchObject({ result: 'replied', handoff: true });

    const state = await withTenant(app, t.tenantId, async (c) => ({
      conv: (await c.query('SELECT mode FROM conversations WHERE id = $1', [msg.conversationId])).rows[0],
      handoff: (await c.query('SELECT reason, summary, taken_at FROM handoffs WHERE conversation_id = $1', [msg.conversationId])).rows,
    }));
    expect(state.conv?.mode).toBe('human');
    expect(state.handoff).toEqual([{ reason: 'precio', summary: 'Pide precio del Aconna Beige.', taken_at: null }]);

    // El siguiente mensaje del cliente ya no dispara al bot.
    const next = await customerSays('Gracias, espero', '584141230003');
    expect(next.mode).toBe('human');
    expect(await processBrainJob({ pool: app, llm: scriptedLlm([]).llm }, { tenantId: t.tenantId, conversationId: next.conversationId, triggerMessageId: next.messageId })).toEqual({
      result: 'skipped',
      reason: 'human_mode',
    });
  });

  it('si el modelo falla sin remedio, el cliente recibe el respaldo y se deriva', async () => {
    const msg = await customerSays('Hola', '584141230004');
    const llm = { create: vi.fn().mockRejectedValue(new Error('respuesta inválida')) };
    const turn = await processBrainJob({ pool: app, llm }, { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId });
    expect(turn).toMatchObject({ result: 'replied', handoff: true, outcome: 'error' });
    const body = await withTenant(app, t.tenantId, async (c) =>
      (await c.query(`SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'out'`, [msg.conversationId])).rows[0]?.body,
    );
    expect(body).toBe(FALLBACK_REPLY);
  });

  it('si el proveedor está saturado reintenta, y en el último intento responde con el respaldo', async () => {
    const msg = await customerSays('Hola', '584141230009');
    const busy = { create: vi.fn().mockRejectedValue(new LlmHttpError('high demand', 503, true)) };
    const job = { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId };

    await expect(processBrainJob({ pool: app, llm: busy }, job)).rejects.toThrow('high demand');
    const last = await processBrainJob({ pool: app, llm: busy, finalAttempt: true }, job);
    expect(last).toMatchObject({ result: 'replied', handoff: true, outcome: 'error' });
    const state = await withTenant(app, t.tenantId, async (c) => ({
      body: (await c.query(`SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'out'`, [msg.conversationId])).rows[0]?.body,
      handoff: (await c.query('SELECT summary FROM handoffs WHERE conversation_id = $1', [msg.conversationId])).rows[0]?.summary,
    }));
    expect(state.body).toBe(FALLBACK_REPLY);
    expect(state.handoff).toContain('no respondió');
  });

  it('no envía texto libre fuera de la ventana de 24 h', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 25 * 3600);
    const msg = await customerSays('Hola', '584141230005', old);
    const { llm } = scriptedLlm([text('Buenas tardes, ¿en qué le puedo ayudar?')]);
    const turn = await processBrainJob({ pool: app, llm }, { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId });
    if (turn.result !== 'replied') throw new Error('se esperaba respuesta');
    const before = graph.mock.calls.length;
    expect(await processOutbound(outboundDeps(), { tenantId: t.tenantId, outboundMessageId: turn.outboundMessageId })).toEqual({ result: 'blocked_window' });
    expect(graph.mock.calls.length).toBe(before);
  });

  it('reintenta errores transitorios de Meta y marca fallidos los permanentes', async () => {
    const make = async (from: string) => {
      const msg = await customerSays('Hola', from);
      const turn = await processBrainJob({ pool: app, llm: scriptedLlm([text('Buenas tardes.')]).llm }, { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId });
      if (turn.result !== 'replied') throw new Error('se esperaba respuesta');
      return turn.outboundMessageId;
    };

    const transient = await make('584141230006');
    const busy = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(processOutbound({ ...outboundDeps(), fetch: busy }, { tenantId: t.tenantId, outboundMessageId: transient })).rejects.toThrow();
    expect(await processOutbound(outboundDeps(), { tenantId: t.tenantId, outboundMessageId: transient })).toMatchObject({ result: 'sent' });

    const permanent = await make('584141230007');
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 131026, message: 'No se pudo entregar' } }), { status: 400 }));
    expect(await processOutbound({ ...outboundDeps(), fetch: rejected }, { tenantId: t.tenantId, outboundMessageId: permanent })).toEqual({
      result: 'failed',
      reason: 'send_failed',
    });
  });

  it('sin credenciales válidas no envía', async () => {
    const msg = await customerSays('Hola', '584141230008');
    const turn = await processBrainJob({ pool: app, llm: scriptedLlm([text('Buenas tardes.')]).llm }, { tenantId: t.tenantId, conversationId: msg.conversationId, triggerMessageId: msg.messageId });
    if (turn.result !== 'replied') throw new Error('se esperaba respuesta');
    expect(await processOutbound({ ...outboundDeps(), masterKey: randomBytes(32) }, { tenantId: t.tenantId, outboundMessageId: turn.outboundMessageId })).toEqual({
      result: 'failed',
      reason: 'bad_credentials',
    });
  });
});
