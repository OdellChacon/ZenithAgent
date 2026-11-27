import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { PanelEvent } from '@zenith/core';
import type { Pool } from '@zenith/db';
import { buildApi } from '../src/server.js';
import { sniffFile } from '../src/files.js';
import { decryptCredentials, encryptCredentials, hashPassword, verifyPassword } from '@zenith/core';
import { hasDb, seedTenant, setupDb } from '../../../packages/db/test/helpers.js';

describe('contraseñas', () => {
  it('verifica la contraseña correcta y rechaza otras', async () => {
    const hash = await hashPassword('una-clave-larga');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('una-clave-larga', hash)).toBe(true);
    expect(await verifyPassword('otra-clave-larga', hash)).toBe(false);
    expect(await verifyPassword('x', 'formato-raro')).toBe(false);
  });

  it('exige un largo mínimo', async () => {
    await expect(hashPassword('corta')).rejects.toThrow('al menos');
  });
});

describe('tipo real de los archivos', () => {
  const box = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`, 'latin1'), Buffer.alloc(16)]);
  it('acepta MP4 y 3GP, y rechaza .mov del iPhone, HEIC y M4A aunque tengan la misma caja ftyp', () => {
    expect(sniffFile(box('isom'), 'video.mp4')?.mimeType).toBe('video/mp4');
    expect(sniffFile(box('mp42'), 'video.mp4')?.mimeType).toBe('video/mp4');
    expect(sniffFile(box('3gp4'), 'video.3gp')?.mimeType).toBe('video/3gpp');
    expect(sniffFile(box('qt  '), 'IMG_0001.MOV')).toBeNull();
    expect(sniffFile(box('heic'), 'IMG_0002.HEIC')).toBeNull();
    expect(sniffFile(box('M4A '), 'nota.m4a')).toBeNull();
  });
});

describe('/healthz para el monitoreo', () => {
  const build = (health?: () => Promise<Record<string, boolean>>) =>
    buildApi({
      pool: {} as never,
      secureCookies: false,
      enqueueOutbound: async () => undefined,
      publish: async () => undefined,
      subscribe: async () => async () => undefined,
      ...(health ? { health } : {}),
    });

  it('responde 200 si todo está bien y 503 diciendo qué falla, sin pedir sesión', async () => {
    const ok = await build(async () => ({ db: true, redis: true, worker: true })).inject({ method: 'GET', url: '/healthz' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, checks: { db: true, redis: true, worker: true } });
    const down = await build(async () => ({ db: true, redis: true, worker: false })).inject({ method: 'GET', url: '/healthz' });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ ok: false, checks: { db: true, redis: true, worker: false } });
    const broken = await build(async () => {
      throw new Error('x');
    }).inject({ method: 'GET', url: '/healthz' });
    expect(broken.statusCode).toBe(503);
  });
});

describe.skipIf(!hasDb)('API del panel', () => {
  let owner: pg.Pool;
  let pool: Pool;
  let t: Awaited<ReturnType<typeof seedTenant>>;
  let other: Awaited<ReturnType<typeof seedTenant>>;
  const run = randomUUID().slice(0, 8);
  const PASSWORD = 'clave-de-prueba-123';
  const users: Record<'ana' | 'beto' | 'admin' | 'ajeno', { id: string; email: string }> = {} as never;
  const enqueued: { tenantId: string; ids: string[] }[] = [];
  const published: PanelEvent[] = [];
  let app: ReturnType<typeof buildApi>;

  // Meta falso para el registro insertado: anota cada llamada y responde como Graph API.
  const masterKey = randomBytes(32);
  const graph = { bizApp: true };
  const graphCalls: string[] = [];
  const fakeGraph: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? ` ${String(init.body)}` : '';
    graphCalls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}${body}`);
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    // Archivo del cliente: primero la url (Graph API) y después los bytes (CDN de Meta).
    if (url.pathname.endsWith('/MEDIA-FOTO')) return json(200, { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'image/jpeg' });
    if (url.hostname === 'lookaside.fbsbx.com') return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (url.pathname.endsWith('/oauth/access_token')) {
      return url.searchParams.get('code') === 'codigo-bueno'
        ? json(200, { access_token: 'TOKEN-NEGOCIO', token_type: 'bearer' })
        : json(400, { error: { code: 100, message: 'Invalid verification code format.' } });
    }
    if (url.pathname.endsWith('/subscribed_apps') || url.pathname.endsWith('/register')) return json(200, { success: true });
    if (url.pathname.endsWith('/smb_app_data')) return json(200, { messaging_product: 'whatsapp', request_id: 'req-1' });
    if (url.pathname.endsWith('/message_templates')) {
      if (init && (init.headers as Record<string, string>)?.Authorization !== 'Bearer TOKEN-PLANTILLAS') return json(401, { error: { code: 190, message: 'Invalid OAuth access token' } });
      return json(200, {
        data: [
          {
            name: 'retomar_consulta',
            language: 'es',
            status: 'APPROVED',
            category: 'UTILITY',
            components: [{ type: 'BODY', text: 'Hola {{1}}, le escribe {{2}}. ¿Seguimos con su consulta?' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Sí' }] }],
          },
          // Con foto en el encabezado: el panel todavía no la sabe mandar, no se ofrece.
          { name: 'promo_foto', language: 'es', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Oferta' }] },
        ],
      });
    }
    return json(200, { display_phone_number: '+58 414-0000001', verified_name: 'Inversiones Prueba', is_on_biz_app: graph.bizApp, platform_type: 'CLOUD_API' });
  };

  const headers = (cookie?: string, csrf = true) => ({ ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-zenith-csrf': '1' } : {}) });

  async function login(email: string, password = PASSWORD) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: headers(), payload: { email, password } });
    const set = res.headers['set-cookie'];
    const cookie = (Array.isArray(set) ? set[0] : set)?.split(';')[0];
    return { res, cookie: cookie ?? '' };
  }

  async function seedConversation(tenantId: string, channelAccountId: string, opts: { hoursSinceInbound?: number; name?: string } = {}) {
    const contact = await owner.query<{ id: string }>('INSERT INTO contacts (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING id', [
      tenantId,
      opts.name ?? 'Carla Prueba',
      '584141119999',
    ]);
    await owner.query(`INSERT INTO contact_identities (tenant_id, contact_id, channel, external_user_id) VALUES ($1, $2, 'whatsapp', $3)`, [
      tenantId,
      contact.rows[0]!.id,
      `5841411${Math.floor(Math.random() * 1e5)}`,
    ]);
    const lastInbound = new Date(Date.now() - (opts.hoursSinceInbound ?? 0.1) * 3_600_000);
    const conv = await owner.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, contact_id, channel_account_id, mode, last_inbound_at, window_expires_at)
       VALUES ($1, $2, $3, 'human', $4, $5) RETURNING id`,
      [tenantId, contact.rows[0]!.id, channelAccountId, lastInbound, new Date(lastInbound.getTime() + 24 * 3_600_000)],
    );
    const id = conv.rows[0]!.id;
    await owner.query(`INSERT INTO messages (tenant_id, conversation_id, direction, author, type, body) VALUES ($1, $2, 'in', 'customer', 'text', '¿Precio del Aconna?')`, [
      tenantId,
      id,
    ]);
    await owner.query(`INSERT INTO handoffs (tenant_id, conversation_id, reason, summary) VALUES ($1, $2, 'precio', 'Pide precio del Aconna Beige.')`, [
      tenantId,
      id,
    ]);
    return id;
  }

  beforeAll(async () => {
    ({ owner, app: pool } = await setupDb());
    t = await seedTenant(owner, 'panel');
    other = await seedTenant(owner, 'panel-otro');
    const hash = await hashPassword(PASSWORD);
    for (const [key, tenantId, role] of [
      ['ana', t.tenantId, 'agent'],
      ['beto', t.tenantId, 'agent'],
      ['admin', t.tenantId, 'admin'],
      ['ajeno', other.tenantId, 'agent'],
    ] as const) {
      const email = `${key}-${run}@prueba.test`;
      const u = await owner.query<{ id: string }>('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [email, key, hash]);
      await owner.query('INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)', [u.rows[0]!.id, tenantId, role]);
      users[key] = { id: u.rows[0]!.id, email };
    }
    app = buildApi({
      pool,
      secureCookies: false,
      enqueueOutbound: async (tenantId, ids) => void enqueued.push({ tenantId, ids }),
      publish: async (_tenantId, event) => void published.push(event),
      subscribe: async () => async () => undefined,
      graph: { graphApiVersion: 'v27.0', graphBaseUrl: 'https://graph.prueba.test', masterKey, fetch: fakeGraph },
      whatsappSignup: {
        appId: 'APP-1',
        appSecret: 'SECRETO',
        configId: 'CFG-1',
        graphApiVersion: 'v27.0',
        graphBaseUrl: 'https://graph.prueba.test',
        masterKey,
        masterKeyId: 'k1',
        fetch: fakeGraph,
      },
    });
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [Object.values(users).map((u) => u.id)]);
      await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[t?.tenantId, other?.tenantId].filter(Boolean)]);
      await owner.end();
    }
    await pool?.end();
  });

  it('inicia sesión con cookie segura y rechaza credenciales malas sin decir cuál falló', async () => {
    const ok = await login(users.ana.email);
    expect(ok.res.statusCode).toBe(200);
    const cookie = String(ok.res.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');

    const bad = await login(users.ana.email, 'otra-clave-equivocada');
    const unknown = await login(`nadie-${run}@prueba.test`);
    expect(bad.res.statusCode).toBe(401);
    expect(unknown.res.statusCode).toBe(401);
    expect(bad.res.json().error.message).toBe(unknown.res.json().error.message);
  });

  it('bloquea tras muchos intentos fallidos', async () => {
    const email = `fuerza-${run}@prueba.test`;
    for (let i = 0; i < 10; i++) await login(email, 'mala-clave-0000');
    expect((await login(email, 'mala-clave-0000')).res.statusCode).toBe(429);
  });

  it('exige sesión y la cabecera de seguridad en los cambios', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/conversations' })).statusCode).toBe(401);
    const { cookie } = await login(users.ana.email);
    const id = await seedConversation(t.tenantId, t.channelAccountId);
    const noCsrf = await app.inject({ method: 'POST', url: `/api/v1/conversations/${id}/take`, headers: headers(cookie, false) });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('muestra los derivados en Pendientes y un asesor de otro negocio no los ve', async () => {
    const id = await seedConversation(t.tenantId, t.channelAccountId, { name: 'Cliente Pendiente' });
    const { cookie } = await login(users.ana.email);
    const list = await app.inject({ method: 'GET', url: '/api/v1/conversations?view=pending', headers: headers(cookie) });
    const item = list.json().items.find((i: { id: string }) => i.id === id);
    expect(item).toMatchObject({ contactName: 'Cliente Pendiente', mode: 'human', assignedTo: null, handoff: { reason: 'precio' } });

    const ajeno = await login(users.ajeno.email);
    const otherList = await app.inject({ method: 'GET', url: '/api/v1/conversations?view=all', headers: headers(ajeno.cookie) });
    expect(otherList.json().items.map((i: { id: string }) => i.id)).not.toContain(id);
    expect((await app.inject({ method: 'GET', url: `/api/v1/conversations/${id}`, headers: headers(ajeno.cookie) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/v1/conversations/${id}/take`, headers: headers(ajeno.cookie) })).statusCode).toBe(404);
  });

  it('tomar, responder y devolver al bot', async () => {
    const id = await seedConversation(t.tenantId, t.channelAccountId);
    const ana = await login(users.ana.email);
    const beto = await login(users.beto.email);
    const admin = await login(users.admin.email);

    // Sin tomarla no se puede responder.
    const early = await app.inject({ method: 'POST', url: `/api/v1/conversations/${id}/messages`, headers: headers(ana.cookie), payload: { text: 'Hola' } });
    expect(early.json().error.code).toBe('not_assigned');

    expect((await app.inject({ method: 'POST', url: `/api/v1/conversations/${id}/take`, headers: headers(ana.cookie) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/v1/conversations/${id}/take`, headers: headers(beto.cookie) })).statusCode).toBe(409);
    expect(published).toContainEqual({ type: 'conversation.updated', conversationId: id });

    const clientId = randomUUID();
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${id}/messages`,
        headers: headers(ana.cookie),
        payload: { text: 'Buenas tardes, le envío la cotización.', clientId },
      });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200); // doble clic: no duplica
    expect(enqueued.filter((e) => e.tenantId === t.tenantId)).toHaveLength(1);

    const { rows } = await owner.query(
      `SELECT m.author, m.sent_by_user_id, o.payload FROM messages m JOIN outbound_messages o ON o.message_id = m.id WHERE m.conversation_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ author: 'agent', sent_by_user_id: users.ana.id, payload: { kind: 'text', author: 'agent' } });

    const detail = await app.inject({ method: 'GET', url: `/api/v1/conversations/${id}`, headers: headers(ana.cookie) });
    expect(detail.json()).toMatchObject({ assignedTo: { id: users.ana.id }, window: { state: 'FREE' }, handoff: { reason: 'precio' } });
    expect(detail.json().messages.at(-1)).toMatchObject({ author: 'agent', sentBy: 'ana', delivery: 'queued' });

    // Otro asesor no puede devolverla; un administrador sí.
    const finish = (cookie: string) =>
      app.inject({ method: 'POST', url: `/api/v1/conversations/${id}/finish`, headers: headers(cookie), payload: { action: 'release' } });
    expect((await finish(beto.cookie)).statusCode).toBe(403);
    expect((await finish(admin.cookie)).statusCode).toBe(200);
    const state = await owner.query('SELECT c.mode, c.assigned_user_id, h.taken_by, h.returned_at FROM conversations c JOIN handoffs h ON h.conversation_id = c.id WHERE c.id = $1', [id]);
    expect(state.rows[0]).toMatchObject({ mode: 'bot', assigned_user_id: null, taken_by: users.ana.id });
    expect(state.rows[0].returned_at).not.toBeNull();
  });

  it('no deja escribir texto libre con la ventana de 24 h cerrada', async () => {
    const id = await seedConversation(t.tenantId, t.channelAccountId, { hoursSinceInbound: 30 });
    const { cookie } = await login(users.ana.email);
    await app.inject({ method: 'POST', url: `/api/v1/conversations/${id}/take`, headers: headers(cookie) });
    const res = await app.inject({ method: 'POST', url: `/api/v1/conversations/${id}/messages`, headers: headers(cookie), payload: { text: 'Hola' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('window_closed');
  });

  it('cerrar la sesión invalida la cookie', async () => {
    const { cookie } = await login(users.ana.email);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: headers(cookie) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: headers(cookie) })).statusCode).toBe(401);
  });

  it('devuelve los datos del usuario y su negocio', async () => {
    const { cookie } = await login(users.admin.email);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: headers(cookie) });
    expect(me.json()).toMatchObject({ id: users.admin.id, role: 'admin', tenant: { id: t.tenantId } });
  });

  it('valida los ids y el texto', async () => {
    const { cookie } = await login(users.ana.email);
    expect((await app.inject({ method: 'GET', url: '/api/v1/conversations/no-es-uuid', headers: headers(cookie) })).statusCode).toBe(404);
    const id = await seedConversation(t.tenantId, t.channelAccountId);
    await app.inject({ method: 'POST', url: `/api/v1/conversations/${id}/take`, headers: headers(cookie) });
    const empty = await app.inject({ method: 'POST', url: `/api/v1/conversations/${id}/messages`, headers: headers(cookie), payload: { text: '   ' } });
    expect(empty.statusCode).toBe(400);
  });
  it('lista contactos con etiquetas y señales, los filtra y los edita', async () => {
    const convId = await seedConversation(t.tenantId, t.channelAccountId, { name: 'Daniela Contacto' });
    const contactId = (await owner.query<{ contact_id: string }>('SELECT contact_id FROM conversations WHERE id = $1', [convId])).rows[0]!.contact_id;
    // El bot le mostró la foto de un producto: queda como interés del contacto.
    const product = await owner.query<{ id: string }>(
      `INSERT INTO products (tenant_id, source, external_id, name, category, category_name) VALUES ($1, 'prueba', $2, 'Archi Cenizo', 'ceramicas', 'Cerámicas') RETURNING id`,
      [t.tenantId, `p-${run}`],
    );
    const image = await owner.query<{ id: string }>(
      `INSERT INTO product_images (tenant_id, product_id, position, mime_type, data, bytes, sha256) VALUES ($1, $2, 0, 'image/jpeg', $3, 1, 'x') RETURNING id`,
      [t.tenantId, product.rows[0]!.id, Buffer.from([0])],
    );
    await owner.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, author, type, body, attachments) VALUES ($1, $2, 'out', 'bot', 'image', 'Archi Cenizo', $3)`,
      [t.tenantId, convId, JSON.stringify([{ productImageId: image.rows[0]!.id }])],
    );

    const { cookie } = await login(users.ana.email);
    const get = (url: string, c = cookie) => app.inject({ method: 'GET', url, headers: headers(c) });
    const patch = (payload: unknown, c = cookie, csrf = true) =>
      app.inject({ method: 'PATCH', url: `/api/v1/contacts/${contactId}`, headers: headers(c, csrf), payload: payload as object });

    const listed = (await get('/api/v1/contacts?q=daniela')).json().items;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: contactId,
      name: 'Daniela Contacto',
      channels: ['whatsapp'],
      tags: [],
      optOutFollowups: false,
      lastHandoffReason: 'precio',
      followupSent: false,
      conversation: { id: convId, mode: 'human', waitingAdvisor: true },
      interest: { products: ['Archi Cenizo'], categories: ['Cerámicas'] },
    });

    // Etiquetas: se normalizan (sin #, minúsculas, sin repetir) y se validan.
    expect((await patch({ tags: ['#Arquitecto', 'arquitecto', '  Obra   grande '] })).statusCode).toBe(200);
    expect((await get(`/api/v1/contacts/${contactId}`)).json()).toMatchObject({
      tags: ['arquitecto', 'obra grande'],
      conversations: [{ id: convId, channel: 'whatsapp' }],
    });
    expect((await patch({ tags: ['<script>'] })).statusCode).toBe(400);
    expect((await patch({ tags: Array.from({ length: 16 }, (_, i) => `t${i}`) })).statusCode).toBe(400);
    expect((await patch({ precio: 1 })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ tags: ['x'] }, cookie, false)).statusCode).toBe(403);

    // Notas y "no enviar seguimientos".
    expect((await patch({ notes: '  Prefiere que le escriban en la tarde. ', optOutFollowups: true })).statusCode).toBe(200);
    const after = (await get(`/api/v1/contacts/${contactId}`)).json();
    expect(after).toMatchObject({ notes: 'Prefiere que le escriban en la tarde.', optOutFollowups: true, tags: ['arquitecto', 'obra grande'] });

    // Filtro por etiqueta, búsqueda por etiqueta y por teléfono, y lista de etiquetas con conteo.
    expect((await get('/api/v1/contacts?tag=arquitecto')).json().items.map((i: { id: string }) => i.id)).toEqual([contactId]);
    expect((await get('/api/v1/contacts?q=obra')).json().items.map((i: { id: string }) => i.id)).toContain(contactId);
    expect((await get('/api/v1/contacts?q=%25')).statusCode).toBe(200);
    expect((await get('/api/v1/contact-tags')).json().items).toEqual(expect.arrayContaining([expect.objectContaining({ tag: 'arquitecto', count: 1 })]));
    // La conversación también muestra las etiquetas del contacto.
    expect((await get(`/api/v1/conversations/${convId}`)).json().contact).toMatchObject({ id: contactId, tags: ['arquitecto', 'obra grande'] });

    // Otro negocio no ve ni edita el contacto.
    const ajeno = await login(users.ajeno.email);
    expect((await get(`/api/v1/contacts/${contactId}`, ajeno.cookie)).statusCode).toBe(404);
    expect((await patch({ tags: ['hack'] }, ajeno.cookie)).statusCode).toBe(404);
    expect((await get('/api/v1/contacts?q=daniela', ajeno.cookie)).json().items).toEqual([]);
    expect((await get('/api/v1/contact-tags', ajeno.cookie)).json().items).toEqual([]);
  });

  it('administra etiquetas con color, grupos de una sola opción, renombrar, fusionar y borrar', async () => {
    const convId = await seedConversation(t.tenantId, t.channelAccountId, { name: 'Ernesto Etiquetas' });
    const contactId = (await owner.query<{ contact_id: string }>('SELECT contact_id FROM conversations WHERE id = $1', [convId])).rows[0]!.contact_id;
    const admin = (await login(users.admin.email)).cookie;
    const agent = (await login(users.ana.email)).cookie;
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, c: string, payload?: unknown) =>
      app.inject({ method, url, headers: headers(c), ...(payload ? { payload: payload as object } : {}) });
    const tags = async () => (await call('GET', `/api/v1/contacts/${contactId}`, admin)).json().tags as string[];
    const setTags = (list: string[], c = agent) => call('PATCH', `/api/v1/contacts/${contactId}`, c, { tags: list });
    const g = `Tipo ${run}`.slice(0, 30);

    // Grupo de una sola opción con dos etiquetas.
    expect((await call('POST', '/api/v1/contact-tag-groups', agent, { name: g, exclusive: true })).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/contact-tag-groups', admin, { name: g, exclusive: true })).statusCode).toBe(201);
    expect((await call('POST', '/api/v1/contact-tag-groups', admin, { name: g })).statusCode).toBe(409);
    // Cualquier asesor puede crear etiquetas; el color se valida.
    expect((await call('POST', '/api/v1/contact-tags', agent, { name: 'Mayorista X', color: 'blue', group: g, description: 'Compra al mayor' })).statusCode).toBe(201);
    expect((await call('POST', '/api/v1/contact-tags', agent, { name: 'potencial x', color: 'amber', group: g })).statusCode).toBe(201);
    expect((await call('POST', '/api/v1/contact-tags', agent, { name: 'mayorista x' })).statusCode).toBe(409);
    expect((await call('POST', '/api/v1/contact-tags', agent, { name: 'otra', color: 'fucsia' })).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/contact-tags', agent, { name: 'otra', group: 'no existe' })).statusCode).toBe(400);

    const list = (await call('GET', '/api/v1/contact-tags', agent)).json();
    expect(list.canManage).toBe(false);
    expect(list.groups).toEqual(expect.arrayContaining([{ name: g, exclusive: true }]));
    expect(list.items).toEqual(
      expect.arrayContaining([{ tag: 'mayorista x', count: 0, color: 'blue', group: g, description: 'Compra al mayor' }]),
    );

    // En un grupo de una sola opción queda la última que se agregó; las etiquetas nuevas se registran solas.
    const r = await setTags(['potencial x', 'obra', 'mayorista x']);
    expect(r.json()).toEqual({ ok: true, tags: ['obra', 'mayorista x'] });
    expect(await tags()).toEqual(['obra', 'mayorista x']);
    expect((await call('GET', '/api/v1/contact-tags', agent)).json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ tag: 'obra', count: 1, group: null })]),
    );

    // Renombrar cambia la etiqueta en los contactos; renombrar a una existente las fusiona.
    expect((await call('PATCH', '/api/v1/contact-tags/obra', agent, { name: 'obra nueva' })).statusCode).toBe(403);
    expect((await call('PATCH', '/api/v1/contact-tags/obra', admin, { name: 'obra nueva', color: 'teal' })).json()).toEqual({ ok: true, merged: false });
    expect(await tags()).toEqual(['obra nueva', 'mayorista x']);
    expect((await call('PATCH', `/api/v1/contact-tags/${encodeURIComponent('mayorista x')}`, admin, { name: 'obra nueva' })).json()).toEqual({
      ok: true,
      merged: true,
    });
    expect(await tags()).toEqual(['obra nueva']);
    expect((await call('PATCH', '/api/v1/contact-tags/no-existe', admin, { color: 'red' })).statusCode).toBe(404);

    // Borrar una etiqueta la quita de los contactos; borrar el grupo deja sus etiquetas sin grupo.
    expect((await call('DELETE', `/api/v1/contact-tags/${encodeURIComponent('obra nueva')}`, agent)).statusCode).toBe(403);
    expect((await call('DELETE', `/api/v1/contact-tags/${encodeURIComponent('obra nueva')}`, admin)).json()).toEqual({ ok: true, contacts: 1 });
    expect(await tags()).toEqual([]);
    expect((await call('DELETE', `/api/v1/contact-tag-groups/${encodeURIComponent(g)}`, admin)).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/contact-tags', agent)).json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ tag: 'potencial x', group: null })]),
    );

    // Otro negocio no ve ni toca estas etiquetas.
    const ajeno = (await login(users.ajeno.email)).cookie;
    expect((await call('GET', '/api/v1/contact-tags', ajeno)).json().items.map((i: { tag: string }) => i.tag)).not.toContain('potencial x');
    expect((await call('DELETE', `/api/v1/contact-tags/${encodeURIComponent('potencial x')}`, ajeno)).statusCode).toBe(403);
  });

  it('fuera de las 24 h el asesor elige una plantilla aprobada, la completa y la envía', async () => {
    // Número con su cuenta de WhatsApp Business y su token cifrado.
    await owner.query('UPDATE channel_accounts SET waba_id = $2, credentials_enc = $3 WHERE id = $1', [
      t.channelAccountId,
      '123456789',
      encryptCredentials(JSON.stringify({ accessToken: 'TOKEN-PLANTILLAS' }), masterKey, t.channelAccountId),
    ]);
    const convId = await seedConversation(t.tenantId, t.channelAccountId, { hoursSinceInbound: 30, name: 'Rosa Plantilla' });
    const { cookie } = await login(users.ana.email);
    const call = (method: 'GET' | 'POST', path: string, payload?: unknown, c = cookie) =>
      app.inject({ method, url: `/api/v1/conversations/${convId}${path}`, headers: headers(c), ...(payload ? { payload: payload as object } : {}) });

    const list = await call('GET', '/templates');
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual([
      { name: 'retomar_consulta', language: 'es', category: 'UTILITY', body: 'Hola {{1}}, le escribe {{2}}. ¿Seguimos con su consulta?', params: 2, header: null, footer: null, buttons: ['Sí'] },
    ]);

    // El texto libre sigue cerrado; hay que tomar la conversación para mandar la plantilla.
    const send = (payload: unknown) => call('POST', '/templates', payload);
    expect((await send({ name: 'retomar_consulta', language: 'es', params: ['Rosa', 'Ana'] })).statusCode).toBe(409);
    expect((await call('POST', '/take')).statusCode).toBe(200);
    expect((await call('POST', '/messages', { text: 'Hola' })).statusCode).toBe(409);

    expect((await send({ name: 'no_existe', language: 'es', params: [] })).json().error.code).toBe('unknown_template');
    expect((await send({ name: 'retomar_consulta', language: 'es', params: ['Rosa'] })).json().error.message).toBe('La plantilla pide 2 datos');
    expect((await send({ name: 'retomar_consulta', language: 'es', params: ['Rosa', 'línea\nnueva'] })).statusCode).toBe(400);

    const before = enqueued.length;
    const ok = await send({ name: 'retomar_consulta', language: 'es', params: [' Rosa ', 'Ana'], clientId: randomUUID() });
    expect(ok.statusCode).toBe(200);
    expect(enqueued.length).toBe(before + 1);
    const row = (
      await owner.query(
        `SELECT m.type, m.author, m.body, o.payload FROM outbound_messages o JOIN messages m ON m.id = o.message_id WHERE o.id = $1`,
        [ok.json().outboundMessageId],
      )
    ).rows[0];
    expect(row).toMatchObject({
      type: 'template',
      author: 'agent',
      body: 'Hola Rosa, le escribe Ana. ¿Seguimos con su consulta?',
      payload: { kind: 'template', name: 'retomar_consulta', language: 'es', bodyParams: ['Rosa', 'Ana'], author: 'agent' },
    });
    // El panel muestra el mensaje como del asesor.
    const detail = (await app.inject({ method: 'GET', url: `/api/v1/conversations/${convId}`, headers: headers(cookie) })).json();
    expect(detail.messages.at(-1)).toMatchObject({ type: 'template', author: 'agent', body: 'Hola Rosa, le escribe Ana. ¿Seguimos con su consulta?' });

    // Otro negocio no ve ni usa las plantillas de esta conversación.
    const ajeno = (await login(users.ajeno.email)).cookie;
    expect((await call('GET', '/templates', undefined, ajeno)).statusCode).toBe(503);
    graphCalls.length = 0; // el Meta falso es compartido con otras pruebas
  });

  it('muestra los números desconectados por Meta solo a su negocio', async () => {
    const { cookie } = await login(users.ana.email);
    const get = (c: string) => app.inject({ method: 'GET', url: '/api/v1/channels', headers: headers(c) });
    const ok = (await get(cookie)).json().items.find((i: { id: string }) => i.id === t.channelAccountId);
    expect(ok).toMatchObject({ channel: 'whatsapp', disconnected: null, history: null });

    await owner.query(
      `UPDATE channel_accounts SET disconnected_at = now(), disconnect_reason = 'PRIMARY_INACTIVITY', history_status = 'importing', history_progress = 40 WHERE id = $1`,
      [t.channelAccountId],
    );
    try {
      const down = (await get(cookie)).json().items.find((i: { id: string }) => i.id === t.channelAccountId);
      expect(down).toMatchObject({
        disconnected: { reason: 'PRIMARY_INACTIVITY', label: 'El teléfono principal pasó unos 14 días sin abrir WhatsApp Business.' },
        history: { status: 'importing', progress: 40 },
      });
      const ajeno = await login(users.ajeno.email);
      expect((await get(ajeno.cookie)).json().items.map((i: { id: string }) => i.id)).not.toContain(t.channelAccountId);
    } finally {
      await owner.query(
        'UPDATE channel_accounts SET disconnected_at = NULL, disconnect_reason = NULL, history_status = NULL, history_progress = NULL WHERE id = $1',
        [t.channelAccountId],
      );
    }
  });

  describe('conectar WhatsApp (registro insertado de Meta)', () => {
    const post = (payload: unknown, cookie: string) =>
      app.inject({ method: 'POST', url: '/api/v1/channels/whatsapp/connect', headers: headers(cookie), payload: payload as object });
    const phone = (n: number) => `${Date.now()}${n}`;

    it('solo el dueño o un administrador puede conectar', async () => {
      const agent = await login(users.ana.email);
      expect((await app.inject({ method: 'GET', url: '/api/v1/channels/whatsapp/signup', headers: headers(agent.cookie) })).json()).toEqual({
        enabled: false,
        canConnect: false,
      });
      expect((await post({ code: 'c', phoneNumberId: '1', wabaId: '2' }, agent.cookie)).statusCode).toBe(403);

      const admin = await login(users.admin.email);
      expect((await app.inject({ method: 'GET', url: '/api/v1/channels/whatsapp/signup', headers: headers(admin.cookie) })).json()).toEqual({
        enabled: true,
        canConnect: true,
        appId: 'APP-1',
        configId: 'CFG-1',
        graphApiVersion: 'v27.0',
        simulated: null,
      });
      expect((await post({ code: 'c', phoneNumberId: 'abc', wabaId: '2' }, admin.cookie)).statusCode).toBe(400);
      expect(graphCalls).toEqual([]);
    });

    it('conecta un número que sigue en la app: sin registrarlo, y pide contactos e historial', async () => {
      const admin = await login(users.admin.email);
      const id = phone(1);
      graph.bizApp = true;
      graphCalls.length = 0;
      published.length = 0;
      const res = await post({ code: 'codigo-bueno', phoneNumberId: id, wabaId: '777' }, admin.cookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, name: 'Inversiones Prueba · +58 414-0000001', coexistence: true, warnings: [] });
      expect(graphCalls).toEqual([
        'GET /v27.0/oauth/access_token?client_id=APP-1&client_secret=SECRETO&code=codigo-bueno',
        `GET /v27.0/${id}?fields=display_phone_number%2Cverified_name%2Cis_on_biz_app%2Cplatform_type`,
        'POST /v27.0/777/subscribed_apps',
        `POST /v27.0/${id}/smb_app_data {"messaging_product":"whatsapp","sync_type":"smb_app_state_sync"}`,
        `POST /v27.0/${id}/smb_app_data {"messaging_product":"whatsapp","sync_type":"history"}`,
      ]);
      const row = (await owner.query('SELECT * FROM channel_accounts WHERE external_account_id = $1', [id])).rows[0];
      expect(row).toMatchObject({ tenant_id: t.tenantId, waba_id: '777', on_biz_app: true, history_status: 'importing', credentials_key_id: 'k1' });
      expect(JSON.parse(decryptCredentials(row.credentials_enc, masterKey, row.id))).toEqual({ accessToken: 'TOKEN-NEGOCIO' });
      expect(published).toContainEqual({ type: 'channel.updated' });
    });

    it('registra con un PIN un número nuevo en la API', async () => {
      const admin = await login(users.admin.email);
      const id = phone(2);
      graph.bizApp = false;
      graphCalls.length = 0;
      expect((await post({ code: 'codigo-bueno', phoneNumberId: id, wabaId: '778' }, admin.cookie)).json()).toMatchObject({ coexistence: false });
      const register = graphCalls.find((c) => c.includes('/register'));
      expect(register).toMatch(new RegExp(`^POST /v27.0/${id}/register \\{"messaging_product":"whatsapp","pin":"\\d{6}"\\}$`));
      expect(graphCalls.some((c) => c.includes('smb_app_data'))).toBe(false);
      const row = (await owner.query('SELECT * FROM channel_accounts WHERE external_account_id = $1', [id])).rows[0];
      const creds = JSON.parse(decryptCredentials(row.credentials_enc, masterKey, row.id));
      expect(register).toContain(`"pin":"${creds.pin}"`);
      expect(row.history_status).toBeNull();
    });

    it('no guarda nada si Meta rechaza el código, y no toca números de otro negocio', async () => {
      const admin = await login(users.admin.email);
      const id = phone(3);
      const bad = await post({ code: 'vencido', phoneNumberId: id, wabaId: '779' }, admin.cookie);
      expect(bad.statusCode).toBe(502);
      expect(bad.json().error.code).toBe('meta_code');
      expect((await owner.query('SELECT 1 FROM channel_accounts WHERE external_account_id = $1', [id])).rowCount).toBe(0);

      const taken = await post({ code: 'codigo-bueno', phoneNumberId: other.phoneNumberId, wabaId: '780' }, admin.cookie);
      expect(taken.statusCode).toBe(409);
      const row = (await owner.query('SELECT tenant_id, waba_id FROM channel_accounts WHERE external_account_id = $1', [other.phoneNumberId])).rows[0];
      expect(row).toEqual({ tenant_id: other.tenantId, waba_id: null });
    });
  });

  describe('archivos y canales de Meta', () => {
    /** Cuerpo multipart como lo manda el navegador: los datos y después el archivo. */
    function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Buffer }) {
      const boundary = `----zenith${run}`;
      const parts: Buffer[] = [];
      for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
      parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
      return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
    }

    async function upload(cookie: string, id: string, file: { name: string; type: string; data: Buffer }, caption?: string) {
      const body = multipart({ ...(caption ? { caption } : {}), clientId: randomUUID() }, file);
      return app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${id}/files`,
        headers: { ...headers(cookie), 'content-type': body.contentType },
        payload: body.payload,
      });
    }

    const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');

    it('el asesor manda un PDF: queda guardado, en cola para enviar y se puede abrir solo desde su negocio', async () => {
      const id = await seedConversation(t.tenantId, t.channelAccountId);
      const ana = await login(users.ana.email);
      await app.inject({ method: 'POST', url: `/api/v1/conversations/${id}/take`, headers: headers(ana.cookie) });
      const before = enqueued.length;
      const res = await upload(ana.cookie, id, { name: 'cotización junio.pdf', type: 'application/pdf', data: PDF }, 'Su cotización');
      expect(res.statusCode).toBe(200);
      expect(enqueued.length).toBe(before + 1);
      const out = (await owner.query('SELECT payload FROM outbound_messages WHERE id = $1', [enqueued.at(-1)!.ids[0]])).rows[0].payload;
      expect(out).toMatchObject({ kind: 'file', caption: 'Su cotización', author: 'agent' });

      const detail = (await app.inject({ method: 'GET', url: `/api/v1/conversations/${id}`, headers: headers(ana.cookie) })).json();
      const msg = detail.messages.at(-1);
      expect(msg).toMatchObject({ type: 'document', body: 'Su cotización', file: { name: 'cotización junio.pdf', mimeType: 'application/pdf', mediaType: 'document' } });
      expect(msg.file.url).toBe(`/api/v1/files/${out.fileId}`);

      const file = await app.inject({ method: 'GET', url: msg.file.url, headers: headers(ana.cookie) });
      expect(file.statusCode).toBe(200);
      expect(file.rawPayload.equals(PDF)).toBe(true);
      expect(file.headers['content-type']).toBe('application/pdf');
      expect(file.headers['content-disposition']).toContain('attachment;');
      expect(file.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('cotización junio.pdf')}`);
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect(file.headers['content-security-policy']).toContain('sandbox');

      const ajeno = await login(users.ajeno.email);
      expect((await app.inject({ method: 'GET', url: msg.file.url, headers: headers(ajeno.cookie) })).statusCode).toBe(404);
    });

    it('revisa el tipo real del archivo y lo que admite el canal', async () => {
      const id = await seedConversation(t.tenantId, t.channelAccountId);
      const ana = await login(users.ana.email);
      await app.inject({ method: 'POST', url: `/api/v1/conversations/${id}/take`, headers: headers(ana.cookie) });
      // Un ejecutable con nombre de PDF no pasa.
      const fake = await upload(ana.cookie, id, { name: 'factura.pdf', type: 'application/pdf', data: Buffer.from('MZ\x90\x00binario') });
      expect(fake.statusCode).toBe(415);
      // Una foto de más de 5 MB no entra en WhatsApp.
      const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5 * 1024 * 1024)]);
      const tooBig = await upload(ana.cookie, id, { name: 'foto.jpg', type: 'image/jpeg', data: big });
      expect(tooBig.statusCode).toBe(413);
      // Sin tomar la conversación no se puede mandar.
      const beto = await login(users.beto.email);
      expect((await upload(beto.cookie, id, { name: 'p.pdf', type: 'application/pdf', data: PDF })).statusCode).toBe(409);
    });

    it('muestra la foto que mandó el cliente pidiéndosela a Meta en el momento', async () => {
      const id = await seedConversation(t.tenantId, t.channelAccountId);
      await owner.query('UPDATE channel_accounts SET credentials_enc = $2 WHERE id = $1', [
        t.channelAccountId,
        encryptCredentials(JSON.stringify({ accessToken: 'TOKEN-WA' }), masterKey, t.channelAccountId),
      ]);
      const msgId = (
        await owner.query<{ id: string }>(
          `INSERT INTO messages (tenant_id, conversation_id, direction, author, type, attachments) VALUES ($1, $2, 'in', 'customer', 'image', $3) RETURNING id`,
          [t.tenantId, id, JSON.stringify([{ type: 'image', externalMediaId: 'MEDIA-FOTO', mimeType: 'image/jpeg' }])],
        )
      ).rows[0]!.id;
      const ana = await login(users.ana.email);
      const detail = (await app.inject({ method: 'GET', url: `/api/v1/conversations/${id}`, headers: headers(ana.cookie) })).json();
      const msg = detail.messages.find((m: { id: string }) => m.id === msgId);
      expect(msg.file).toEqual({ url: `/api/v1/messages/${msgId}/media`, name: null, mimeType: 'image/jpeg', mediaType: 'image' });
      const media = await app.inject({ method: 'GET', url: msg.file.url, headers: headers(ana.cookie) });
      expect(media.statusCode).toBe(200);
      expect(media.headers['content-type']).toBe('image/jpeg');
      expect(media.headers['content-disposition']).toBe('inline');
      expect(media.rawPayload.length).toBe(7);

      // Un mensaje borrado ya no se entrega.
      await owner.query('UPDATE messages SET deleted_at = now() WHERE id = $1', [msgId]);
      expect((await app.inject({ method: 'GET', url: msg.file.url, headers: headers(ana.cookie) })).statusCode).toBe(404);
    });

    it('en Messenger el asesor puede responder hasta 7 días (Human Agent), no después', async () => {
      const pageId = String(Date.now());
      const account = (
        await owner.query<{ id: string }>(`INSERT INTO channel_accounts (tenant_id, channel, external_account_id) VALUES ($1, 'messenger', $2) RETURNING id`, [t.tenantId, pageId])
      ).rows[0]!.id;
      const conversationAt = async (hours: number) => {
        const contact = (await owner.query<{ id: string }>(`INSERT INTO contacts (tenant_id, name) VALUES ($1, 'Cliente Messenger') RETURNING id`, [t.tenantId])).rows[0]!.id;
        await owner.query(`INSERT INTO contact_identities (tenant_id, contact_id, channel, external_user_id) VALUES ($1, $2, 'messenger', $3)`, [
          t.tenantId,
          contact,
          String(Math.floor(Math.random() * 1e12)),
        ]);
        return (
          await owner.query<{ id: string }>(
            `INSERT INTO conversations (tenant_id, contact_id, channel_account_id, mode, last_inbound_at) VALUES ($1, $2, $3, 'human', $4) RETURNING id`,
            [t.tenantId, contact, account, new Date(Date.now() - hours * 3_600_000)],
          )
        ).rows[0]!.id;
      };
      const ana = await login(users.ana.email);
      const threeDays = await conversationAt(72);
      await app.inject({ method: 'POST', url: `/api/v1/conversations/${threeDays}/take`, headers: headers(ana.cookie) });
      const detail = (await app.inject({ method: 'GET', url: `/api/v1/conversations/${threeDays}`, headers: headers(ana.cookie) })).json();
      expect(detail.window.state).toBe('HUMAN_AGENT_ONLY');
      expect((await app.inject({ method: 'POST', url: `/api/v1/conversations/${threeDays}/messages`, headers: headers(ana.cookie), payload: { text: 'Le escribo yo' } })).statusCode).toBe(200);
      expect((await upload(ana.cookie, threeDays, { name: 'p.pdf', type: 'application/pdf', data: PDF })).statusCode).toBe(200);

      const eightDays = await conversationAt(24 * 8);
      await app.inject({ method: 'POST', url: `/api/v1/conversations/${eightDays}/take`, headers: headers(ana.cookie) });
      const late = await app.inject({ method: 'POST', url: `/api/v1/conversations/${eightDays}/messages`, headers: headers(ana.cookie), payload: { text: 'Hola' } });
      expect(late.statusCode).toBe(409);
      expect(late.json().error.message).toContain('7 días');
    });

    it('el estado de los canales dice si Meta rechazó el token o cuándo vence', async () => {
      await owner.query(`UPDATE channel_accounts SET credentials_invalid_at = now(), credentials_error = 'expired', token_expires_at = NULL WHERE id = $1`, [t.channelAccountId]);
      const admin = await login(users.admin.email);
      const list = (await app.inject({ method: 'GET', url: '/api/v1/channels', headers: headers(admin.cookie) })).json();
      const wa = list.items.find((c: { id: string }) => c.id === t.channelAccountId);
      expect(wa.token.invalid).toMatchObject({ error: 'expired' });
      expect(wa.token.expiresAt).toBeNull();
      await owner.query(`UPDATE channel_accounts SET credentials_invalid_at = NULL, credentials_error = NULL WHERE id = $1`, [t.channelAccountId]);
    });
  });

  describe('catálogos', () => {
    const PDF = Buffer.from('%PDF-1.4\ncatálogo de prueba\n');
    function form(fields: Record<string, string>, file: { name: string; type: string; data: Buffer }) {
      const boundary = `----cat${run}`;
      const parts: Buffer[] = [];
      for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
      parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
      return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
    }
    const uploadCatalog = (cookie: string, fields: Record<string, string>, file = { name: 'Porcelanatos 2026.pdf', type: 'application/pdf', data: PDF }) => {
      const body = form(fields, file);
      return app.inject({ method: 'POST', url: '/api/v1/catalogs', headers: { ...headers(cookie), 'content-type': body.contentType }, payload: body.payload });
    };

    it('el administrador sube, edita y archiva catálogos; el asesor solo los ve y otro negocio no', async () => {
      const admin = await login(users.admin.email);
      const ana = await login(users.ana.email);
      expect((await uploadCatalog(ana.cookie, { title: 'No' })).statusCode).toBe(403);

      const up = await uploadCatalog(admin.cookie, { title: 'Porcelanatos madera', description: 'Precios de noviembre' });
      expect(up.statusCode).toBe(200);
      const item = up.json().item;
      expect(item).toMatchObject({ title: 'Porcelanatos madera', description: 'Precios de noviembre', mediaType: 'document', mimeType: 'application/pdf', filename: 'Porcelanatos 2026.pdf' });

      const list = (await app.inject({ method: 'GET', url: '/api/v1/catalogs', headers: headers(ana.cookie) })).json();
      expect(list.canManage).toBe(false);
      expect(list.items.map((c: { id: string }) => c.id)).toContain(item.id);

      const file = await app.inject({ method: 'GET', url: item.url, headers: headers(ana.cookie) });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toBe('application/pdf');
      expect(file.headers['content-disposition']).toContain('inline;');
      expect(file.rawPayload.equals(PDF)).toBe(true);

      const ajeno = await login(users.ajeno.email);
      expect((await app.inject({ method: 'GET', url: item.url, headers: headers(ajeno.cookie) })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/v1/catalogs', headers: headers(ajeno.cookie) })).json().items).toEqual([]);

      const renamed = await app.inject({ method: 'PATCH', url: `/api/v1/catalogs/${item.id}`, headers: headers(admin.cookie), payload: { title: 'Madera 2026', description: null } });
      expect(renamed.json().item).toMatchObject({ title: 'Madera 2026', description: null });
      expect((await app.inject({ method: 'PATCH', url: `/api/v1/catalogs/${item.id}`, headers: headers(ana.cookie), payload: { title: 'x' } })).statusCode).toBe(403);

      // Un archivo que no es lo que dice no se acepta.
      expect((await uploadCatalog(admin.cookie, {}, { name: 'catalogo.pdf', type: 'application/pdf', data: Buffer.from('MZ ejecutable') })).statusCode).toBe(415);

      expect((await app.inject({ method: 'DELETE', url: `/api/v1/catalogs/${item.id}`, headers: headers(admin.cookie) })).statusCode).toBe(200);
      const after = (await app.inject({ method: 'GET', url: '/api/v1/catalogs', headers: headers(admin.cookie) })).json();
      expect(after.items.map((c: { id: string }) => c.id)).not.toContain(item.id);
      // Archivado: sigue abriéndose desde los chats donde ya se mandó.
      expect((await app.inject({ method: 'GET', url: item.url, headers: headers(ana.cookie) })).statusCode).toBe(200);
    });

    it('el asesor manda un catálogo al chat: queda en la conversación y en cola para enviarse', async () => {
      const admin = await login(users.admin.email);
      const item = (await uploadCatalog(admin.cookie, { title: 'Grifería' })).json().item;
      const id = await seedConversation(t.tenantId, t.channelAccountId);
      const ana = await login(users.ana.email);
      const share = (cookie: string, body: object) =>
        app.inject({ method: 'POST', url: `/api/v1/conversations/${id}/catalogs`, headers: headers(cookie), payload: body });

      expect((await share(ana.cookie, { catalogId: item.id })).statusCode).toBe(409); // sin tomar la conversación
      await app.inject({ method: 'POST', url: `/api/v1/conversations/${id}/take`, headers: headers(ana.cookie) });
      const before = enqueued.length;
      const res = await share(ana.cookie, { catalogId: item.id, caption: 'Aquí tiene el catálogo de grifería', clientId: randomUUID() });
      expect(res.statusCode).toBe(200);
      expect(enqueued.length).toBe(before + 1);
      const out = (await owner.query('SELECT payload FROM outbound_messages WHERE id = $1', [enqueued.at(-1)!.ids[0]])).rows[0].payload;
      expect(out).toMatchObject({ kind: 'catalog', catalogId: item.id, caption: 'Aquí tiene el catálogo de grifería', author: 'agent' });

      const detail = (await app.inject({ method: 'GET', url: `/api/v1/conversations/${id}`, headers: headers(ana.cookie) })).json();
      expect(detail.messages.at(-1)).toMatchObject({
        type: 'document',
        body: 'Aquí tiene el catálogo de grifería',
        file: { url: item.url, name: 'Porcelanatos 2026.pdf', mediaType: 'document' },
      });

      // Un catálogo archivado ya no se puede mandar.
      await app.inject({ method: 'DELETE', url: `/api/v1/catalogs/${item.id}`, headers: headers(admin.cookie) });
      expect((await share(ana.cookie, { catalogId: item.id })).statusCode).toBe(404);
    });
  });
});
