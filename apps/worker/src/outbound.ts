import { decryptCredentials, windowState, type Channel, type OutboundJobData } from '@zenith/core';
import { sendWhatsAppText, type SendResult } from '@zenith/channel-whatsapp';
import { withTenant, type Pool } from '@zenith/db';

export interface OutboundDeps {
  pool: Pool;
  masterKey: Buffer;
  graphApiVersion: string;
  graphBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  maxAttempts?: number;
}

export type OutboundOutcome =
  | { result: 'sent'; externalMessageId: string }
  | { result: 'skipped' }
  | { result: 'blocked_window' }
  | { result: 'failed'; reason: string };

interface Claimed {
  id: string;
  message_id: string | null;
  conversation_id: string;
  attempts: number;
  payload: { kind: 'text'; text: string; to: string; author: 'bot' | 'agent' };
  channel: Channel;
  last_inbound_at: Date | null;
  channel_account_id: string;
  external_account_id: string;
  credentials_enc: Buffer | null;
}

/** El bot deja de usar texto libre un minuto antes de que cierre la ventana de 24 h. */
const BOT_SAFETY_MARGIN_MS = 60_000;

export class RetryableSendError extends Error {
  override name = 'RetryableSendError';
}

/**
 * Envía un mensaje pendiente. Lo toma primero ('sending') para que dos workers no lo manden
 * dos veces, revisa la ventana de mensajería, envía y guarda el resultado.
 */
export async function processOutbound(deps: OutboundDeps, job: OutboundJobData): Promise<OutboundOutcome> {
  const now = deps.now?.() ?? new Date();
  const maxAttempts = deps.maxAttempts ?? 5;

  const claimed = await withTenant(deps.pool, job.tenantId, async (client) => {
    const { rows } = await client.query<Claimed>(
      `UPDATE outbound_messages o
          SET status = 'sending', attempts = o.attempts + 1, updated_at = now()
         FROM conversations c JOIN channel_accounts ca ON ca.id = c.channel_account_id
        WHERE o.id = $1 AND o.status = 'queued' AND c.id = o.conversation_id
        RETURNING o.id, o.message_id, o.conversation_id, o.attempts, o.payload, ca.channel, c.last_inbound_at,
                  ca.id AS channel_account_id, ca.external_account_id, ca.credentials_enc`,
      [job.outboundMessageId],
    );
    return rows[0] ?? null;
  });
  if (!claimed) return { result: 'skipped' };

  const finish = (status: 'sent' | 'failed' | 'blocked_window' | 'queued', fields: { error?: string; externalId?: string } = {}) =>
    withTenant(deps.pool, job.tenantId, async (client) => {
      await client.query(
        `UPDATE outbound_messages SET status = $2, last_error = $3, external_message_id = COALESCE($4, external_message_id),
                updated_at = now()
          WHERE id = $1`,
        [claimed.id, status, fields.error ?? null, fields.externalId ?? null],
      );
      if (status === 'sent') {
        await client.query('UPDATE conversations SET last_outbound_at = now(), updated_at = now() WHERE id = $1', [
          claimed.conversation_id,
        ]);
        if (claimed.message_id) {
          await client.query('UPDATE messages SET external_message_id = $2 WHERE id = $1', [claimed.message_id, fields.externalId]);
        }
      }
    });

  const window = windowState({
    channel: claimed.channel,
    lastInboundAt: claimed.last_inbound_at ? new Date(claimed.last_inbound_at) : null,
    now,
    author: claimed.payload.author,
    botSafetyMarginMs: BOT_SAFETY_MARGIN_MS,
  });
  if (window !== 'FREE') {
    // Fuera de ventana el texto libre no se puede mandar; queda visible para el equipo.
    await finish('blocked_window', { error: `ventana: ${window}` });
    return { result: 'blocked_window' };
  }

  if (claimed.channel !== 'whatsapp') {
    await finish('failed', { error: `canal ${claimed.channel} aún no implementado` });
    return { result: 'failed', reason: 'channel_not_implemented' };
  }
  if (!claimed.credentials_enc) {
    await finish('failed', { error: 'la cuenta de canal no tiene credenciales' });
    return { result: 'failed', reason: 'missing_credentials' };
  }

  let accessToken: string;
  try {
    const creds = JSON.parse(decryptCredentials(claimed.credentials_enc, deps.masterKey, claimed.channel_account_id)) as {
      accessToken?: string;
    };
    if (!creds.accessToken) throw new Error('sin accessToken');
    accessToken = creds.accessToken;
  } catch {
    await finish('failed', { error: 'no se pudieron leer las credenciales de la cuenta' });
    return { result: 'failed', reason: 'bad_credentials' };
  }

  let res: SendResult;
  try {
    res = await sendWhatsAppText(
      {
        graphApiVersion: deps.graphApiVersion,
        phoneNumberId: claimed.external_account_id,
        accessToken,
        ...(deps.graphBaseUrl ? { graphBaseUrl: deps.graphBaseUrl } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      },
      claimed.payload.to,
      claimed.payload.text,
    );
  } catch (err) {
    await finish('failed', { error: (err as Error).message });
    return { result: 'failed', reason: 'invalid_message' };
  }

  if (res.ok) {
    await finish('sent', { externalId: res.externalMessageId });
    return { result: 'sent', externalMessageId: res.externalMessageId };
  }
  if (res.retryable && claimed.attempts < maxAttempts) {
    await finish('queued', { error: res.message });
    throw new RetryableSendError(res.message);
  }
  await finish('failed', { error: `${res.errorCode ?? res.httpStatus ?? ''} ${res.message}`.trim() });
  return { result: 'failed', reason: 'send_failed' };
}
