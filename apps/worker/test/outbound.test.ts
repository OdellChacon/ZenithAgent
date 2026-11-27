import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { encryptCredentials } from '@zenith/core';
import type { Pool } from '@zenith/db';
import { processOutboundMessage } from '../src/outbound.js';
import { checkChannelTokens, notifyCredentials } from '../src/channel-health.js';
import { hasDb, seedTenant, setupDb } from '../../../packages/db/test/helpers.js';

const masterKey = randomBytes(32);
const HOUR = 3_600_000;

describe.skipIf(!hasDb)('envíos por canal, archivos del asesor y token de Meta', () => {
  let owner: pg.Pool;
  let app: Pool;
  let t: Awaited<ReturnType<typeof seedTenant>>;
  let messengerId: string;
  let instagramId: string;
  const pageId = String(Date.now());
  const igId = `1784${Date.now()}`;

  beforeAll(async () => {
    ({ owner, app } = await setupDb());
    t = await seedTenant(owner, 'outbound');
    const enc = (id: string, creds: object) => encryptCredentials(JSON.stringify(creds), masterKey, id);
    await owner.query('UPDATE channel_accounts SET credentials_enc = $2 WHERE id = $1', [t.channelAccountId, enc(t.channelAccountId, { accessToken: 'WA-TOKEN' })]);
    messengerId = (
      await owner.query<{ id: string }>(`INSERT INTO channel_accounts (tenant_id, channel, external_account_id) VALUES ($1, 'messenger', $2) RETURNING id`, [t.tenantId, pageId])
    ).rows[0]!.id;
    instagramId = (
      await owner.query<{ id: string }>(`INSERT INTO channel_accounts (tenant_id, channel, external_account_id) VALUES ($1, 'instagram', $2) RETURNING id`, [t.tenantId, igId])
    ).rows[0]!.id;
    await owner.query('UPDATE channel_accounts SET credentials_enc = $2 WHERE id = $1', [messengerId, enc(messengerId, { accessToken: 'PAGE-TOKEN', pageId })]);
    await owner.query('UPDATE channel_accounts SET credentials_enc = $2 WHERE id = $1', [instagramId, enc(instagramId, { accessToken: 'PAGE-TOKEN', pageId })]);
  });

  afterAll(async () => {
    if (t) await owner.query('DELETE FROM tenants WHERE id = $1', [t.tenantId]);
    await owner?.query(`DELETE FROM users WHERE email LIKE 'ana-%@prueba.test'`);
    await owner?.end();
    await app?.end();
  });

  /** Conversación con un cliente que escribió hace `hoursAgo` horas, y un envío pendiente. */
  async function pending(accountId: string, channel: string, recipient: string, payload: Record<string, unknown>, hoursAgo = 1) {
    const contact = (await owner.query<{ id: string }>('INSERT INTO contacts (tenant_id, name) VALUES ($1, $2) RETURNING id', [t.tenantId, 'Cliente'])).rows[0]!.id;
    await owner.query('INSERT INTO contact_identities (tenant_id, contact_id, channel, external_user_id) VALUES ($1, $2, $3, $4)', [t.tenantId, contact, channel, recipient]);
    const conv = (
      await owner.query<{ id: string }>(
        `INSERT INTO conversations (tenant_id, contact_id, channel_account_id, last_inbound_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        [t.tenantId, contact, accountId, new Date(Date.now() - hoursAgo * HOUR)],
      )
    ).rows[0]!.id;
    const message = (
      await owner.query<{ id: string }>(`INSERT INTO messages (tenant_id, conversation_id, direction, author, type) VALUES ($1, $2, 'out', 'agent', 'text') RETURNING id`, [
        t.tenantId,
        conv,
      ])
    ).rows[0]!.id;
    const out = (
      await owner.query<{ id: string }>(
        `INSERT INTO outbound_messages (tenant_id, conversation_id, message_id, idempotency_key, channel, payload) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [t.tenantId, conv, message, randomUUID(), channel, JSON.stringify({ to: recipient, ...payload })],
      )
    ).rows[0]!.id;
    return { conv, message, out };
  }

  async function addFile(conv: string, mediaType: string, mimeType: string, filename: string, data: Buffer) {
    return (
      await owner.query<{ id: string }>(
        `INSERT INTO message_files (tenant_id, conversation_id, media_type, mime_type, filename, bytes, sha256, data) VALUES ($1, $2, $3, $4, $5, $6, 'x', $7) RETURNING id`,
        [t.tenantId, conv, mediaType, mimeType, filename, data.length, data],
      )
    ).rows[0]!.id;
  }

  /** Graph API falsa: guarda cada llamada y responde según la ruta. */
  function graph(handler: (url: string, body: unknown) => { status?: number; body: unknown }) {
    const calls: { url: string; body: unknown }[] = [];
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      const r = handler(url, body);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    });
    return { fetchFn, calls };
  }

  const deps = (fetchFn: typeof fetch) => ({ pool: app, masterKey, graphApiVersion: 'v27.0', fetch: fetchFn });

  it('WhatsApp: sube el documento del asesor y lo manda con su nombre', async () => {
    const p = await pending(t.channelAccountId, 'whatsapp', '584141110001', { kind: 'file', fileId: '', caption: 'Su cotización', author: 'agent' });
    const fileId = await addFile(p.conv, 'document', 'application/pdf', 'cotizacion.pdf', Buffer.from('%PDF-1.4 prueba'));
    await owner.query(`UPDATE outbound_messages SET payload = jsonb_set(payload, '{fileId}', to_jsonb($2::text)) WHERE id = $1`, [p.out, fileId]);
    const g = graph((url) => (url.endsWith('/media') ? { body: { id: 'MEDIA-DOC' } } : { body: { messages: [{ id: 'wamid.DOC1' }] } }));

    expect(await processOutboundMessage(deps(g.fetchFn), { tenantId: t.tenantId, outboundMessageId: p.out })).toEqual({ result: 'sent', externalMessageId: 'wamid.DOC1' });
    expect(g.calls[0]!.url).toBe(`https://graph.facebook.com/v27.0/${t.phoneNumberId}/media`);
    expect((g.calls[0]!.body as FormData).get('type')).toBe('application/pdf');
    expect(g.calls[1]!.body).toMatchObject({ type: 'document', document: { id: 'MEDIA-DOC', filename: 'cotizacion.pdf', caption: 'Su cotización' } });
  });

  it('WhatsApp: si Meta rechaza el token marca la cuenta y no vuelve a intentar hasta reconectar', async () => {
    const first = await pending(t.channelAccountId, 'whatsapp', '584141110002', { kind: 'text', text: 'Hola', author: 'agent' });
    const g = graph(() => ({ status: 401, body: { error: { code: 190, message: 'Error validating access token' } } }));
    expect(await processOutboundMessage(deps(g.fetchFn), { tenantId: t.tenantId, outboundMessageId: first.out })).toEqual({
      result: 'failed',
      reason: 'auth_failed',
      channelAccountId: t.channelAccountId,
    });
    const acc = (await owner.query('SELECT credentials_invalid_at, credentials_error FROM channel_accounts WHERE id = $1', [t.channelAccountId])).rows[0];
    expect(acc.credentials_invalid_at).not.toBeNull();
    expect(acc.credentials_error).toContain('Error validating access token');

    const second = await pending(t.channelAccountId, 'whatsapp', '584141110003', { kind: 'text', text: 'Hola', author: 'agent' });
    const untouched = graph(() => ({ body: {} }));
    expect(await processOutboundMessage(deps(untouched.fetchFn), { tenantId: t.tenantId, outboundMessageId: second.out })).toMatchObject({ result: 'failed', reason: 'auth_failed' });
    expect(untouched.calls).toHaveLength(0);
    const { rows } = await owner.query('SELECT status, last_error FROM outbound_messages WHERE id = $1', [second.out]);
    expect(rows[0]).toMatchObject({ status: 'failed' });
    expect(rows[0].last_error).toContain('volver a conectarla');
    await owner.query('UPDATE channel_accounts SET credentials_invalid_at = NULL, credentials_error = NULL WHERE id = $1', [t.channelAccountId]);
  });

  it('Messenger: responde dentro de 24 h por la página', async () => {
    const p = await pending(messengerId, 'messenger', '24680001', { kind: 'text', text: 'Tenemos ese modelo', author: 'bot' });
    const g = graph(() => ({ body: { message_id: 'm_out1' } }));
    expect(await processOutboundMessage(deps(g.fetchFn), { tenantId: t.tenantId, outboundMessageId: p.out })).toEqual({ result: 'sent', externalMessageId: 'm_out1' });
    expect(g.calls[0]!.url).toBe(`https://graph.facebook.com/v27.0/${pageId}/messages`);
    expect(g.calls[0]!.body).toEqual({ recipient: { id: '24680001' }, messaging_type: 'RESPONSE', message: { text: 'Tenemos ese modelo' } });
  });

  it('Messenger: a los 3 días el asesor responde con la etiqueta Human Agent y el bot no puede', async () => {
    const agent = await pending(messengerId, 'messenger', '24680002', { kind: 'text', text: 'Le escribo yo', author: 'agent' }, 72);
    const g = graph(() => ({ body: { message_id: 'm_out2' } }));
    expect(await processOutboundMessage(deps(g.fetchFn), { tenantId: t.tenantId, outboundMessageId: agent.out })).toMatchObject({ result: 'sent' });
    expect(g.calls[0]!.body).toMatchObject({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' });

    const bot = await pending(messengerId, 'messenger', '24680003', { kind: 'text', text: '¿Sigue interesado?', author: 'bot' }, 72);
    expect(await processOutboundMessage(deps(g.fetchFn), { tenantId: t.tenantId, outboundMessageId: bot.out })).toEqual({ result: 'blocked_window' });

    const late = await pending(messengerId, 'messenger', '24680004', { kind: 'text', text: 'Hola', author: 'agent' }, 24 * 8);
    expect(await processOutboundMessage(deps(g.fetchFn), { tenantId: t.tenantId, outboundMessageId: late.out })).toEqual({ result: 'blocked_window' });
  });

  it('Messenger no manda plantillas de WhatsApp', async () => {
    const p = await pending(messengerId, 'messenger', '24680005', { kind: 'template', name: 'seguimiento', language: 'es', bodyParams: [], author: 'agent' });
    expect(await processOutboundMessage(deps(graph(() => ({ body: {} })).fetchFn), { tenantId: t.tenantId, outboundMessageId: p.out })).toEqual({ result: 'blocked_window' });
  });

  it('Instagram: sube la foto del asesor por la página vinculada y manda el texto aparte', async () => {
    const p = await pending(instagramId, 'instagram', '17840001', { kind: 'file', fileId: '', caption: 'Así queda instalado', author: 'agent' });
    const fileId = await addFile(p.conv, 'image', 'image/jpeg', 'foto.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    await owner.query(`UPDATE outbound_messages SET payload = jsonb_set(payload, '{fileId}', to_jsonb($2::text)) WHERE id = $1`, [p.out, fileId]);
    const g = graph((url) => (url.endsWith('/message_attachments') ? { body: { attachment_id: 'att_9' } } : { body: { message_id: 'ig_out' } }));
    expect(await processOutboundMessage(deps(g.fetchFn), { tenantId: t.tenantId, outboundMessageId: p.out })).toMatchObject({ result: 'sent' });
    expect(g.calls.map((c) => c.url)).toEqual([
      `https://graph.facebook.com/v27.0/${pageId}/message_attachments`,
      `https://graph.facebook.com/v27.0/${pageId}/messages`,
      `https://graph.facebook.com/v27.0/${pageId}/messages`,
    ]);
    expect(g.calls[1]!.body).toMatchObject({ recipient: { id: '17840001' }, message: { attachment: { type: 'image', payload: { attachment_id: 'att_9' } } } });
    expect(g.calls[2]!.body).toMatchObject({ message: { text: 'Así queda instalado' } });
  });

  it('un catálogo se sube a WhatsApp una sola vez y después se reutiliza su id', async () => {
    const catalogId = (
      await owner.query<{ id: string }>(
        `INSERT INTO catalogs (tenant_id, title, media_type, mime_type, filename, bytes, sha256, data)
         VALUES ($1, 'Porcelanatos', 'document', 'application/pdf', 'porcelanatos.pdf', 9, 'sha-1', $2) RETURNING id`,
        [t.tenantId, Buffer.from('%PDF-1.4 ')],
      )
    ).rows[0]!.id;
    const g = graph((url) => (url.endsWith('/media') ? { body: { id: 'MEDIA-CAT' } } : { body: { messages: [{ id: `wamid.C${Math.random()}` }] } }));
    const first = await pending(t.channelAccountId, 'whatsapp', '584141110010', { kind: 'catalog', catalogId, caption: 'Le paso el catálogo', author: 'agent' });
    expect(await processOutboundMessage(deps(g.fetchFn), { tenantId: t.tenantId, outboundMessageId: first.out })).toMatchObject({ result: 'sent' });
    expect(g.calls[1]!.body).toMatchObject({ type: 'document', document: { id: 'MEDIA-CAT', filename: 'porcelanatos.pdf', caption: 'Le paso el catálogo' } });

    const second = await pending(t.channelAccountId, 'whatsapp', '584141110011', { kind: 'catalog', catalogId, author: 'agent' });
    expect(await processOutboundMessage(deps(g.fetchFn), { tenantId: t.tenantId, outboundMessageId: second.out })).toMatchObject({ result: 'sent' });
    expect(g.calls.filter((c) => c.url.endsWith('/media'))).toHaveLength(1);
    expect(g.calls.at(-1)!.body).toMatchObject({ document: { id: 'MEDIA-CAT' } });

    // Si el archivo del catálogo cambia, se vuelve a subir.
    await owner.query(`UPDATE catalogs SET sha256 = 'sha-2' WHERE id = $1`, [catalogId]);
    const third = await pending(t.channelAccountId, 'whatsapp', '584141110012', { kind: 'catalog', catalogId, author: 'agent' });
    await processOutboundMessage(deps(g.fetchFn), { tenantId: t.tenantId, outboundMessageId: third.out });
    expect(g.calls.filter((c) => c.url.endsWith('/media'))).toHaveLength(2);
  });

  it('Messenger: el catálogo va como archivo por la página', async () => {
    const catalogId = (
      await owner.query<{ id: string }>(
        `INSERT INTO catalogs (tenant_id, title, media_type, mime_type, filename, bytes, sha256, data)
         VALUES ($1, 'Baños', 'document', 'application/pdf', 'banos.pdf', 9, 'sha-b', $2) RETURNING id`,
        [t.tenantId, Buffer.from('%PDF-1.4 ')],
      )
    ).rows[0]!.id;
    const p = await pending(messengerId, 'messenger', '24680010', { kind: 'catalog', catalogId, author: 'agent' });
    const g = graph((url) => (url.endsWith('/message_attachments') ? { body: { attachment_id: 'att_cat' } } : { body: { message_id: 'm_cat' } }));
    expect(await processOutboundMessage(deps(g.fetchFn), { tenantId: t.tenantId, outboundMessageId: p.out })).toMatchObject({ result: 'sent' });
    expect(JSON.parse(String((g.calls[0]!.body as FormData).get('message')))).toEqual({ attachment: { type: 'file', payload: { is_reusable: true } } });
    expect(g.calls[1]!.body).toMatchObject({ message: { attachment: { type: 'file', payload: { attachment_id: 'att_cat' } } } });
  });

  describe('revisión diaria del token', () => {
    const health = (fetchFn: typeof fetch, now = new Date()) => ({ pool: app, masterKey, graphApiVersion: 'v27.0', fetch: fetchFn, now: () => now });
    const tenantFindings = (all: Awaited<ReturnType<typeof checkChannelTokens>>) => all.filter((f) => f.tenantId === t.tenantId);

    it('marca la cuenta cuyo token Meta rechaza y la limpia cuando vuelve a funcionar', async () => {
      await owner.query('UPDATE channel_accounts SET credentials_checked_at = NULL WHERE tenant_id = $1', [t.tenantId]);
      const rejected = graph((url) => (url.includes(t.phoneNumberId) ? { status: 400, body: { error: { code: 190, message: 'expired' } } } : { body: { name: 'Página' } }));
      const found = tenantFindings(await checkChannelTokens(health(rejected.fetchFn)));
      expect(found).toEqual([{ tenantId: t.tenantId, channelAccountId: t.channelAccountId, state: 'invalid' }]);
      expect((await owner.query('SELECT credentials_invalid_at FROM channel_accounts WHERE id = $1', [t.channelAccountId])).rows[0].credentials_invalid_at).not.toBeNull();

      // Ya revisadas hoy: no se vuelven a consultar.
      const again = graph(() => ({ body: {} }));
      expect(tenantFindings(await checkChannelTokens(health(again.fetchFn)))).toEqual([]);

      await owner.query('UPDATE channel_accounts SET credentials_checked_at = NULL WHERE tenant_id = $1', [t.tenantId]);
      const ok = graph(() => ({ body: { display_phone_number: '58', name: 'Página' } }));
      expect(tenantFindings(await checkChannelTokens(health(ok.fetchFn)))).toEqual([{ tenantId: t.tenantId, channelAccountId: t.channelAccountId, state: 'recovered' }]);
      expect((await owner.query('SELECT credentials_invalid_at FROM channel_accounts WHERE id = $1', [t.channelAccountId])).rows[0].credentials_invalid_at).toBeNull();
    });

    it('avisa una semana antes de que venza un token de 60 días, como mucho un correo por día', async () => {
      await owner.query('UPDATE channel_accounts SET credentials_checked_at = NULL, token_expires_at = $2 WHERE id = $1', [
        messengerId,
        new Date(Date.now() + 3 * 24 * HOUR),
      ]);
      const ok = graph(() => ({ body: { name: 'Página', display_phone_number: '58' } }));
      const found = tenantFindings(await checkChannelTokens(health(ok.fetchFn)));
      expect(found).toContainEqual({ tenantId: t.tenantId, channelAccountId: messengerId, state: 'expiring' });

      const user = (await owner.query<{ id: string }>(`INSERT INTO users (email, name, password_hash) VALUES ($1, 'Ana', 'x') RETURNING id`, [`ana-${randomUUID()}@prueba.test`])).rows[0]!.id;
      await owner.query(`INSERT INTO memberships (user_id, tenant_id, role, notify_email) VALUES ($1, $2, 'owner', true)`, [user, t.tenantId]);
      const sent: { subject: string }[] = [];
      const mailer = { send: async (m: { subject: string }) => void sent.push(m) };
      const notifyDeps = { pool: app, mailer, panelUrl: 'http://panel.test' } as Parameters<typeof notifyCredentials>[0];
      expect(await notifyCredentials(notifyDeps, t.tenantId, messengerId, 'expiring')).toBe('sent');
      expect(await notifyCredentials(notifyDeps, t.tenantId, messengerId, 'expiring')).toBe('throttled');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.subject).toContain('Messenger');

      // Un "sin acceso" no espera al día siguiente por un "vence pronto" ya avisado hoy.
      expect(await notifyCredentials(notifyDeps, t.tenantId, messengerId, 'invalid')).toBe('sent');
      expect(await notifyCredentials(notifyDeps, t.tenantId, messengerId, 'invalid')).toBe('throttled');
      expect(sent.at(-1)!.subject).toContain('sin acceso');
    });

    it('si el correo no sale, el aviso no se da por hecho y el siguiente intento vuelve a avisar', async () => {
      const failing = { send: async () => Promise.reject(new Error('SMTP caído')) };
      const deps = (mailer: Parameters<typeof notifyCredentials>[0]['mailer']) => ({ pool: app, mailer, panelUrl: 'http://panel.test' });
      await expect(notifyCredentials(deps(failing), t.tenantId, instagramId, 'invalid')).rejects.toThrow('SMTP caído');
      expect((await owner.query('SELECT credentials_alerted_at FROM channel_accounts WHERE id = $1', [instagramId])).rows[0].credentials_alerted_at).toBeNull();

      // Sin nadie que reciba avisos tampoco se consume.
      await owner.query('UPDATE memberships SET notify_email = false WHERE tenant_id = $1', [t.tenantId]);
      const sent: unknown[] = [];
      const ok = { send: async (m: unknown) => void sent.push(m) };
      expect(await notifyCredentials(deps(ok), t.tenantId, instagramId, 'invalid')).toBe('no_recipients');
      await owner.query('UPDATE memberships SET notify_email = true WHERE tenant_id = $1', [t.tenantId]);
      expect(await notifyCredentials(deps(ok), t.tenantId, instagramId, 'invalid')).toBe('sent');
      expect(sent).toHaveLength(1);
    });
  });

  it('si la cuenta se reconecta mientras un envío falla con el token viejo, no se marca el token nuevo', async () => {
    const p = await pending(t.channelAccountId, 'whatsapp', '584141110020', { kind: 'text', text: 'Hola', author: 'agent' });
    const fresh = encryptCredentials(JSON.stringify({ accessToken: 'WA-TOKEN-NUEVO' }), masterKey, t.channelAccountId);
    // Meta rechaza el token viejo; justo en ese momento el dueño vuelve a conectar el número.
    const g = graph(() => ({ status: 401, body: { error: { code: 190, message: 'expired' } } }));
    const reconnecting: typeof fetch = async (input, init) => {
      await owner.query('UPDATE channel_accounts SET credentials_enc = $2 WHERE id = $1', [t.channelAccountId, fresh]);
      return g.fetchFn(input, init);
    };
    await expect(processOutboundMessage(deps(reconnecting), { tenantId: t.tenantId, outboundMessageId: p.out })).rejects.toThrow();
    const acc = (await owner.query('SELECT credentials_invalid_at FROM channel_accounts WHERE id = $1', [t.channelAccountId])).rows[0];
    expect(acc.credentials_invalid_at).toBeNull();
    // Queda en cola y el reintento sale con el token nuevo.
    expect((await owner.query('SELECT status FROM outbound_messages WHERE id = $1', [p.out])).rows[0].status).toBe('queued');
    const ok = graph(() => ({ body: { messages: [{ id: 'wamid.NUEVO' }] } }));
    expect(await processOutboundMessage(deps(ok.fetchFn), { tenantId: t.tenantId, outboundMessageId: p.out })).toEqual({ result: 'sent', externalMessageId: 'wamid.NUEVO' });
  });
});
