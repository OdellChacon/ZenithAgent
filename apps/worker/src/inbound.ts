import { INBOUND_MAX_ATTEMPTS, windowExpiresAt, type ParsedEvent } from '@zenith/core';
import {
  claimWebhookEvent,
  finishWebhookEvent,
  releaseWebhookEvent,
  resolveChannelAccount,
  resolveWhatsAppWaba,
  withTenant,
  type Pool,
  type PoolClient,
} from '@zenith/db';
import { parseTakeoverSettings } from '@zenith/brain';

/** Resta a la hora (en ms) del historial para que su seq quede negativo. */
const HISTORY_SEQ_OFFSET = 10_000_000_000_000;
/** Si el negocio desactivó la retoma automática, igual se mira solo lo de las últimas 12 h. */
const DEFAULT_RECENT_MINUTES = 12 * 60;

export type InboundOutcome =
  | {
      result: 'message';
      tenantId: string;
      conversationId: string;
      messageId: string;
      duplicate: boolean;
      /** Modo de la conversación: solo en 'bot' responde la IA. */
      mode: 'bot' | 'human';
      /** El bot retomó la conversación porque el asesor dejó de escribir desde la app. */
      resumed: boolean;
    }
  | {
      /** Un asesor escribió desde la app de WhatsApp Business: el bot se calla en ese chat. */
      result: 'agent_echo';
      tenantId: string;
      conversationId: string;
      messageId: string;
      duplicate: boolean;
    }
  | {
      /** Chat del historial importado al conectar el número (no despierta al bot). */
      result: 'history';
      tenantId: string;
      conversationId: string;
      imported: number;
    }
  | {
      /** Aviso de conexión (desconexión, reconexión, historial rechazado) aplicado a estos negocios. */
      result: 'account';
      tenantIds: string[];
      notice: NonNullable<ParsedEvent['account']>;
    }
  | {
      /** Contacto de la agenda de la app: nombre guardado por el negocio. */
      result: 'contact';
      tenantId: string;
      contactId: string | null;
    }
  | { result: 'status'; tenantId: string; updated: number }
  /** Se editó o borró un mensaje ya guardado (por el cliente o por el negocio desde la app). */
  | { result: 'edited'; tenantId: string; conversationId: string | null }
  | { result: 'ignored'; reason: string }
  | { result: 'failed'; reason: string }
  | { result: 'skipped' };

/**
 * Procesa un evento guardado por el gateway: resuelve el tenant, registra contacto,
 * conversación y mensaje (o actualiza el estado de un envío) y marca el evento.
 * Todo lo del tenant ocurre en una transacción con RLS activa.
 *
 * Aún no responde: el cerebro (IA) se conecta en el siguiente paso de F1.
 */
export async function processInboundEvent(pool: Pool, webhookEventId: string): Promise<InboundOutcome> {
  const row = await claimWebhookEvent(pool, webhookEventId);
  if (!row) return { result: 'skipped' }; // ya lo procesó otro worker, o no existe

  const event = row.normalized;
  try {
    if (event.kind === 'unsupported') {
      await finishWebhookEvent(pool, row.id, 'ignored', `tipo no soportado: ${event.unsupportedType ?? 'desconocido'}`);
      return { result: 'ignored', reason: 'unsupported' };
    }

    if (event.kind === 'account' && event.account?.scope === 'waba') {
      const accounts = await resolveWhatsAppWaba(pool, event.channelExternalAccountId);
      if (!accounts.length) {
        await finishWebhookEvent(pool, row.id, 'ignored', 'cuenta de WhatsApp Business (WABA) sin números registrados');
        return { result: 'ignored', reason: 'unknown_waba' };
      }
      for (const a of accounts) await withTenant(pool, a.tenantId, (client) => applyAccountNotice(client, a.channelAccountId, event));
      await finishWebhookEvent(pool, row.id, 'processed');
      return { result: 'account', tenantIds: [...new Set(accounts.map((a) => a.tenantId))], notice: event.account };
    }

    const account = await resolveChannelAccount(pool, event.channel, event.channelExternalAccountId);
    if (!account) {
      // Error permanente: reintentar no lo arregla. Queda visible para soporte.
      await finishWebhookEvent(pool, row.id, 'failed', 'cuenta de canal desconocida o inactiva');
      return { result: 'failed', reason: 'unknown_channel_account' };
    }

    return await withTenant(pool, account.tenantId, async (client) => {
      if (event.kind === 'account') {
        await applyAccountNotice(client, account.channelAccountId, event);
        await finishWebhookEvent(client, row.id, 'processed');
        return { result: 'account', tenantIds: [account.tenantId], notice: event.account! } satisfies InboundOutcome;
      }
      const outcome =
        event.kind === 'status'
          ? await applyStatus(client, account.tenantId, event)
          : event.kind === 'echo'
            ? await storeAgentEcho(client, account.tenantId, account.channelAccountId, event)
            : event.kind === 'history'
              ? await storeHistory(client, account.tenantId, account.channelAccountId, event)
              : event.kind === 'contact'
                ? await storeAgendaContact(client, account.tenantId, event)
                : event.kind === 'edit'
                  ? await applyEdit(client, account.tenantId, event)
                  : await storeMessage(client, account.tenantId, account.channelAccountId, event);
      if (outcome.result === 'ignored') {
        await finishWebhookEvent(client, row.id, 'ignored', outcome.reason);
        return outcome;
      }
      await finishWebhookEvent(client, row.id, 'processed');
      return outcome;
    });
  } catch (err) {
    const message = (err as Error).message;
    const state = await releaseWebhookEvent(pool, row.id, message, INBOUND_MAX_ATTEMPTS);
    if (state === 'failed') return { result: 'failed', reason: message };
    throw err; // BullMQ reintenta con backoff
  }
}

async function applyStatus(client: PoolClient, tenantId: string, event: ParsedEvent): Promise<InboundOutcome> {
  const st = event.status;
  if (!st) return { result: 'status', tenantId, updated: 0 };
  // Los estados pueden llegar desordenados: no se retrocede de 'read' a 'delivered'.
  const { rowCount } = await client.query(
    `UPDATE outbound_messages
        SET status = $2,
            last_error = CASE WHEN $2 = 'failed' THEN $3 ELSE last_error END,
            updated_at = now()
      WHERE tenant_id = $1 AND external_message_id = $4
        AND CASE status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END
          < CASE $2 WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 4 END`,
    [tenantId, st.state, st.errorCode ? `código ${st.errorCode}` : null, st.externalMessageId],
  );
  return { result: 'status', tenantId, updated: rowCount ?? 0 };
}

async function storeMessage(
  client: PoolClient,
  tenantId: string,
  channelAccountId: string,
  event: ParsedEvent,
): Promise<InboundOutcome> {
  const from = event.from;
  if (!from) throw new Error('Mensaje sin remitente');

  const contactId = await upsertContact(client, tenantId, event.channel, from);
  const conversationId = await openConversation(client, tenantId, channelAccountId, contactId);

  const type = event.media?.[0]?.type ?? (event.location ? 'location' : event.sharedContacts ? 'contacts' : 'text');
  const body = event.location ? locationText(event.location) : event.sharedContacts ? contactsText(event.sharedContacts) : (event.text ?? null);
  const attachments = event.location ? [{ location: event.location }] : event.sharedContacts ? [{ contacts: event.sharedContacts }] : (event.media ?? []);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, author, type, body, attachments, external_message_id, created_at)
     VALUES ($1, $2, 'in', 'customer', $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [tenantId, conversationId, type, body, JSON.stringify(attachments), event.externalMessageId ?? null, event.occurredAt],
  );

  let messageId = inserted.rows[0]?.id;
  const duplicate = !messageId;
  if (!messageId) {
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM messages WHERE tenant_id = $1 AND external_message_id = $2',
      [tenantId, event.externalMessageId],
    );
    messageId = existing.rows[0]?.id;
    if (!messageId) throw new Error('No se encontró el mensaje duplicado');
  }

  const resumed = await resumeBotIfAgentLeft(client, tenantId, conversationId);

  // La ventana se mide desde el último mensaje del usuario, aunque lleguen desordenados.
  const occurredAt = new Date(event.occurredAt);
  const updated = await client.query<{ mode: 'bot' | 'human' }>(
    `UPDATE conversations
        SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, $2), $2),
            window_expires_at = GREATEST(COALESCE(window_expires_at, $3), $3),
            updated_at = now()
      WHERE id = $1
      RETURNING mode`,
    [conversationId, occurredAt, windowExpiresAt(occurredAt)],
  );

  return { result: 'message', tenantId, conversationId, messageId, duplicate, mode: updated.rows[0]!.mode, resumed };
}

/**
 * Edición o borrado de un mensaje ya guardado. Al borrar se quita el contenido (el cliente o el
 * asesor decidió retirarlo) y queda la marca para el panel. No despierta al bot: el cliente que
 * corrige algo suele mandar después otro mensaje.
 */
async function applyEdit(client: PoolClient, tenantId: string, event: ParsedEvent): Promise<InboundOutcome> {
  const e = event.edit;
  if (!e) throw new Error('Edición sin datos');
  const { rows } =
    e.action === 'revoke'
      ? await client.query<{ conversation_id: string }>(
          `UPDATE messages SET body = NULL, attachments = '[]'::jsonb, deleted_at = COALESCE(deleted_at, $3)
            WHERE tenant_id = $1 AND external_message_id = $2 RETURNING conversation_id`,
          [tenantId, e.originalExternalMessageId, event.occurredAt],
        )
      : // Las ediciones pueden llegar desordenadas: una más vieja que la guardada no pisa el texto.
        await client.query<{ conversation_id: string }>(
          `UPDATE messages
              SET body = CASE WHEN edited_at IS NULL OR edited_at <= $4 THEN COALESCE($3, body) ELSE body END,
                  edited_at = GREATEST(edited_at, $4)
            WHERE tenant_id = $1 AND external_message_id = $2 AND deleted_at IS NULL RETURNING conversation_id`,
          [tenantId, e.originalExternalMessageId, e.text ?? null, event.occurredAt],
        );
  if (!rows[0]) return { result: 'ignored', reason: 'edición de un mensaje que no está guardado' };
  return { result: 'edited', tenantId, conversationId: rows[0].conversation_id };
}

/** "Casa de Pedro, Av. Libertador (7.7669, -72.2250)" — lo que ve el asesor y el bot. */
function locationText(l: NonNullable<ParsedEvent['location']>): string {
  const label = [l.name, l.address].filter(Boolean).join(', ');
  const coords = `${l.latitude.toFixed(5)}, ${l.longitude.toFixed(5)}`;
  return label ? `${label} (${coords})` : coords;
}

/** "Arq. Luis Pérez: 584141112233" — una línea por contacto. */
function contactsText(list: NonNullable<ParsedEvent['sharedContacts']>): string {
  return list.map((c) => (c.phones.length ? `${c.name}: ${c.phones.join(', ')}` : c.name)).join('\n');
}

/**
 * Si un asesor atendió desde la app y lleva más de `resumeBotAfterMinutes` sin escribir, el
 * bot vuelve a atender. No toca chats tomados desde el panel (esos se devuelven a mano).
 */
async function resumeBotIfAgentLeft(client: PoolClient, tenantId: string, conversationId: string): Promise<boolean> {
  const tenant = await client.query<{ settings: unknown }>('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const { resumeBotAfterMinutes } = parseTakeoverSettings(tenant.rows[0]?.settings);
  if (resumeBotAfterMinutes <= 0) return false;
  const { rowCount } = await client.query(
    `UPDATE conversations SET mode = 'bot', agent_active_at = NULL, updated_at = now()
      WHERE id = $1 AND mode = 'human' AND assigned_user_id IS NULL
        AND agent_active_at < now() - make_interval(mins => $2)`,
    [conversationId, resumeBotAfterMinutes],
  );
  if (!rowCount) return false;
  await client.query('UPDATE handoffs SET returned_at = now() WHERE conversation_id = $1 AND returned_at IS NULL', [conversationId]);
  return true;
}

/**
 * Guarda lo que un asesor mandó desde la app de WhatsApp Business y calla al bot en ese chat.
 * Si había un pase a asesor esperando, queda como atendido. No mueve la ventana de 24 h:
 * según Meta, los mensajes de la app no la abren ni la extienden.
 */
async function storeAgentEcho(
  client: PoolClient,
  tenantId: string,
  channelAccountId: string,
  event: ParsedEvent,
): Promise<InboundOutcome> {
  const to = event.to;
  if (!to) throw new Error('Copia de mensaje sin destinatario');

  // Lo que manda la API no debería volver como copia; si vuelve, es del bot y no cuenta.
  const own = await client.query('SELECT 1 FROM outbound_messages WHERE tenant_id = $1 AND external_message_id = $2', [
    tenantId,
    event.externalMessageId,
  ]);
  if (own.rowCount) return { result: 'ignored', reason: 'copia de un mensaje enviado por la API' };

  const contactId = await upsertContact(client, tenantId, event.channel, to);
  const conversationId = await openConversation(client, tenantId, channelAccountId, contactId);

  // La copia puede llegar antes de que el worker de salida guarde el id que devolvió Meta: si
  // este sistema está mandando ese mismo texto en el chat y todavía no tiene el id, es nuestra.
  // Un envío que ya guardó su id no absorbe copias: si un asesor escribe lo mismo que el bot
  // (un "ok", un "gracias") desde el teléfono, se registra como suyo.
  if (event.text) {
    const recent = await client.query(
      `SELECT 1 FROM outbound_messages
        WHERE conversation_id = $1 AND status IN ('sending', 'sent') AND external_message_id IS NULL
          AND updated_at > now() - interval '2 minutes' AND btrim(payload->>'text') = btrim($2)
        LIMIT 1`,
      [conversationId, event.text],
    );
    if (recent.rowCount) return { result: 'ignored', reason: 'copia de un mensaje enviado por la API' };
  }

  const type = event.media?.[0]?.type ?? (event.unsupportedType ? event.unsupportedType : 'text');
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, author, type, body, attachments, external_message_id, created_at)
     VALUES ($1, $2, 'out', 'agent', $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [tenantId, conversationId, type, event.text ?? null, JSON.stringify(event.media ?? []), event.externalMessageId ?? null, event.occurredAt],
  );
  let messageId = inserted.rows[0]?.id;
  const duplicate = !messageId;
  if (!messageId) {
    const existing = await client.query<{ id: string }>('SELECT id FROM messages WHERE tenant_id = $1 AND external_message_id = $2', [
      tenantId,
      event.externalMessageId,
    ]);
    messageId = existing.rows[0]?.id;
    if (!messageId) throw new Error('No se encontró el mensaje duplicado');
  }

  const occurredAt = new Date(event.occurredAt);
  await client.query(
    `UPDATE conversations
        SET mode = 'human',
            agent_active_at = GREATEST(COALESCE(agent_active_at, $2), $2),
            last_outbound_at = GREATEST(COALESCE(last_outbound_at, $2), $2),
            updated_at = now()
      WHERE id = $1`,
    [conversationId, occurredAt],
  );
  await client.query('UPDATE handoffs SET taken_at = now() WHERE conversation_id = $1 AND returned_at IS NULL AND taken_at IS NULL', [
    conversationId,
  ]);
  return { result: 'agent_echo', tenantId, conversationId, messageId, duplicate };
}

/**
 * Guarda un chat del historial que Meta manda al conectar un número que ya usaba la app.
 * No despierta al bot, no mueve la ventana de 24 h ni dispara seguimientos: solo deja el
 * contexto a la vista del asesor y del bot. Si el asesor escribió hace poco (dentro del plazo
 * de takeover), el chat queda en sus manos igual que con una copia de la app.
 */
async function storeHistory(client: PoolClient, tenantId: string, channelAccountId: string, event: ParsedEvent): Promise<InboundOutcome> {
  const from = event.from;
  const history = event.history;
  if (!from || !history) throw new Error('Historial sin cliente');

  const contactId = await upsertContact(client, tenantId, event.channel, from);
  const conversationId = await openConversation(client, tenantId, channelAccountId, contactId);

  let imported = 0;
  let latest: Date | null = null;
  let latestBusiness: Date | null = null;
  for (const [i, m] of history.messages.entries()) {
    const at = new Date(m.occurredAt);
    if (!latest || at > latest) latest = at;
    if (m.fromBusiness && (!latestBusiness || at > latestBusiness)) latestBusiness = at;
    // seq negativo y creciente con la hora: lo importado queda antes que lo recibido en vivo,
    // que siempre es posterior a la conexión.
    const seq = Math.floor(at.getTime() / 1000) * 1000 + (i % 1000) - HISTORY_SEQ_OFFSET;
    const type = m.media?.[0]?.type ?? m.type;
    const res = await client.query<{ inserted: boolean }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, author, type, body, attachments, external_message_id, created_at, seq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL
       DO UPDATE SET type = EXCLUDED.type, attachments = EXCLUDED.attachments, body = COALESCE(EXCLUDED.body, messages.body)
        -- Meta manda primero un aviso sin archivo y después el archivo del mismo mensaje.
        WHERE messages.type = 'media_placeholder' AND EXCLUDED.type <> 'media_placeholder'
       RETURNING (xmax = 0) AS inserted`,
      [
        tenantId,
        conversationId,
        m.fromBusiness ? 'out' : 'in',
        m.fromBusiness ? 'agent' : 'customer',
        type,
        m.text ?? null,
        JSON.stringify(m.media ?? []),
        m.externalMessageId,
        at,
        seq,
      ],
    );
    if (res.rows[0]?.inserted) imported++;
  }

  const tenant = await client.query<{ settings: unknown }>('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const { resumeBotAfterMinutes } = parseTakeoverSettings(tenant.rows[0]?.settings);
  const recentMinutes = resumeBotAfterMinutes > 0 ? resumeBotAfterMinutes : DEFAULT_RECENT_MINUTES;
  await client.query(
    `UPDATE conversations
        SET -- Un chat creado por la importación se ordena por su último mensaje, no por hoy.
            updated_at = CASE WHEN last_inbound_at IS NULL AND last_outbound_at IS NULL THEN $2 ELSE updated_at END,
            mode = CASE WHEN $3::timestamptz > now() - make_interval(mins => $4) AND assigned_user_id IS NULL THEN 'human' ELSE mode END,
            agent_active_at = CASE WHEN $3::timestamptz > now() - make_interval(mins => $4) AND assigned_user_id IS NULL
                                   THEN GREATEST(agent_active_at, $3) ELSE agent_active_at END
      WHERE id = $1`,
    [conversationId, latest, latestBusiness, recentMinutes],
  );

  await client.query(
    `UPDATE channel_accounts
        SET history_progress = GREATEST(COALESCE(history_progress, 0), $2),
            history_status = CASE WHEN GREATEST(COALESCE(history_progress, 0), $2) >= 100 THEN 'done' ELSE 'importing' END
      WHERE id = $1 AND history_status IS DISTINCT FROM 'declined'`,
    [channelAccountId, Math.max(0, Math.min(100, Math.round(history.progress)))],
  );
  return { result: 'history', tenantId, conversationId, imported };
}

/**
 * Nombre con el que el negocio guardó al cliente en la agenda del teléfono. Queda en el perfil
 * de su identidad (agendaName) y pasa a ser el nombre del contacto si este no tenía nombre o
 * seguía con el de su perfil de WhatsApp; no pisa un nombre que alguien cambió en el panel.
 * Al borrarlo de la agenda solo se quita agendaName.
 */
async function storeAgendaContact(client: PoolClient, tenantId: string, event: ParsedEvent): Promise<InboundOutcome> {
  const c = event.contact;
  if (!c) throw new Error('Contacto sin datos');
  if (c.action === 'remove') {
    const { rows } = await client.query<{ contact_id: string }>(
      `UPDATE contact_identities SET profile = profile - 'agendaName'
        WHERE tenant_id = $1 AND channel = 'whatsapp' AND external_user_id = $2 RETURNING contact_id`,
      [tenantId, c.phone],
    );
    return { result: 'contact', tenantId, contactId: rows[0]?.contact_id ?? null };
  }
  if (!c.fullName) return { result: 'ignored', reason: 'contacto sin nombre' };
  const contactId = await upsertContact(client, tenantId, 'whatsapp', { externalUserId: c.phone, phone: c.phone });
  await client.query(
    `UPDATE contacts ct
        SET name = $3, updated_at = now()
       FROM contact_identities ci
      WHERE ct.id = $2 AND ci.contact_id = ct.id AND ci.tenant_id = $1 AND ci.channel = 'whatsapp' AND ci.external_user_id = $4
        AND (ct.name IS NULL OR ct.name = ci.profile->>'name' OR ct.name = ci.profile->>'agendaName')`,
    [tenantId, contactId, c.fullName, c.phone],
  );
  await client.query(
    `UPDATE contact_identities SET profile = profile || jsonb_build_object('agendaName', $3::text)
      WHERE tenant_id = $1 AND channel = 'whatsapp' AND external_user_id = $2`,
    [tenantId, c.phone, c.fullName],
  );
  return { result: 'contact', tenantId, contactId };
}

/** Desconexión, reconexión o historial rechazado: queda en la cuenta del canal y el panel avisa. */
async function applyAccountNotice(client: PoolClient, channelAccountId: string, event: ParsedEvent): Promise<void> {
  const notice = event.account;
  if (!notice) return;
  if (notice.type === 'disconnected') {
    await client.query(
      `UPDATE channel_accounts SET disconnected_at = COALESCE(disconnected_at, $2), disconnect_reason = $3 WHERE id = $1`,
      [channelAccountId, event.occurredAt, notice.reason ?? notice.event ?? null],
    );
  } else if (notice.type === 'reconnected') {
    // Un aviso viejo de reconexión no borra una desconexión posterior.
    await client.query(
      `UPDATE channel_accounts SET disconnected_at = NULL, disconnect_reason = NULL
        WHERE id = $1 AND (disconnected_at IS NULL OR disconnected_at <= $2)`,
      [channelAccountId, event.occurredAt],
    );
  } else {
    await client.query(`UPDATE channel_accounts SET history_status = 'declined' WHERE id = $1`, [channelAccountId]);
  }
}

async function upsertContact(
  client: PoolClient,
  tenantId: string,
  channel: ParsedEvent['channel'],
  from: NonNullable<ParsedEvent['from']>,
): Promise<string> {
  const profile = JSON.stringify(from.displayName ? { name: from.displayName } : {});
  const existing = await client.query<{ contact_id: string }>(
    `UPDATE contact_identities SET profile = profile || $4::jsonb
      WHERE tenant_id = $1 AND channel = $2 AND external_user_id = $3
      RETURNING contact_id`,
    [tenantId, channel, from.externalUserId, profile],
  );
  if (existing.rows[0]) return existing.rows[0].contact_id;

  const contact = await client.query<{ id: string }>(
    'INSERT INTO contacts (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING id',
    [tenantId, from.displayName ?? null, from.phone ?? null],
  );
  const newContactId = contact.rows[0]!.id;

  const identity = await client.query<{ contact_id: string }>(
    `INSERT INTO contact_identities (tenant_id, contact_id, channel, external_user_id, profile)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, channel, external_user_id) DO UPDATE SET profile = contact_identities.profile
     RETURNING contact_id`,
    [tenantId, newContactId, channel, from.externalUserId, profile],
  );
  const contactId = identity.rows[0]!.contact_id;
  if (contactId !== newContactId) {
    // Otro worker creó la identidad a la vez: se descarta el contacto sobrante.
    await client.query('DELETE FROM contacts WHERE id = $1', [newContactId]);
  }
  return contactId;
}

async function openConversation(client: PoolClient, tenantId: string, channelAccountId: string, contactId: string): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, contact_id, channel_account_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (channel_account_id, contact_id) WHERE status <> 'closed' DO NOTHING
     RETURNING id`,
    [tenantId, contactId, channelAccountId],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const open = await client.query<{ id: string }>(
    `SELECT id FROM conversations
      WHERE channel_account_id = $1 AND contact_id = $2 AND status <> 'closed'
      FOR UPDATE`,
    [channelAccountId, contactId],
  );
  if (!open.rows[0]) throw new Error('No se pudo abrir la conversación');
  return open.rows[0].id;
}
