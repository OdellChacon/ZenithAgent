import { INBOUND_MAX_ATTEMPTS, windowExpiresAt, type ParsedEvent } from '@zenith/core';
import {
  claimWebhookEvent,
  finishWebhookEvent,
  releaseWebhookEvent,
  resolveChannelAccount,
  withTenant,
  type Pool,
  type PoolClient,
} from '@zenith/db';

export type InboundOutcome =
  | { result: 'message'; tenantId: string; conversationId: string; messageId: string; duplicate: boolean }
  | { result: 'status'; tenantId: string; updated: number }
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

    const account = await resolveChannelAccount(pool, event.channel, event.channelExternalAccountId);
    if (!account) {
      // Error permanente: reintentar no lo arregla. Queda visible para soporte.
      await finishWebhookEvent(pool, row.id, 'failed', 'cuenta de canal desconocida o inactiva');
      return { result: 'failed', reason: 'unknown_channel_account' };
    }

    return await withTenant(pool, account.tenantId, async (client) => {
      const outcome =
        event.kind === 'status'
          ? await applyStatus(client, account.tenantId, event)
          : await storeMessage(client, account.tenantId, account.channelAccountId, event);
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

  const type = event.media?.[0]?.type ?? 'text';
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, author, type, body, attachments, external_message_id, created_at)
     VALUES ($1, $2, 'in', 'customer', $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [tenantId, conversationId, type, event.text ?? null, JSON.stringify(event.media ?? []), event.externalMessageId ?? null, event.occurredAt],
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

  // La ventana se mide desde el último mensaje del usuario, aunque lleguen desordenados.
  const occurredAt = new Date(event.occurredAt);
  await client.query(
    `UPDATE conversations
        SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, $2), $2),
            window_expires_at = GREATEST(COALESCE(window_expires_at, $3), $3),
            updated_at = now()
      WHERE id = $1`,
    [conversationId, occurredAt, windowExpiresAt(occurredAt)],
  );

  return { result: 'message', tenantId, conversationId, messageId, duplicate };
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
