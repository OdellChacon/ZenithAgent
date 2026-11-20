import type { Channel, ParsedEvent } from '@zenith/core';
import type { Pool, PoolClient } from './pool.js';

export interface WebhookEventRow {
  id: string;
  channel: Channel;
  external_event_id: string;
  status: 'received' | 'processing' | 'processed' | 'ignored' | 'failed';
  attempts: number;
  normalized: ParsedEvent;
}

/**
 * Guarda el evento si es nuevo. Devuelve su id, o `null` si ya existía (reintento de la
 * plataforma o evento duplicado), en cuyo caso no hay que volver a encolarlo.
 */
export async function insertWebhookEvent(pool: Pool, event: ParsedEvent, payload: unknown): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO webhook_events (channel, external_event_id, channel_external_account_id, kind, normalized, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (channel, external_event_id) DO NOTHING
     RETURNING id`,
    [event.channel, event.externalEventId, event.channelExternalAccountId, event.kind, event, payload],
  );
  return rows[0]?.id ?? null;
}

/**
 * Toma el evento para procesarlo. Solo un worker lo consigue; los demás reciben `null`.
 */
export async function claimWebhookEvent(pool: Pool, id: string): Promise<WebhookEventRow | null> {
  const { rows } = await pool.query<WebhookEventRow>(
    `UPDATE webhook_events
        SET status = 'processing', attempts = attempts + 1, claimed_at = now()
      WHERE id = $1 AND status = 'received'
      RETURNING id, channel, external_event_id, status, attempts, normalized`,
    [id],
  );
  return rows[0] ?? null;
}

export async function finishWebhookEvent(
  db: Pool | PoolClient,
  id: string,
  status: 'processed' | 'ignored' | 'failed',
  error?: string,
): Promise<void> {
  await db.query(`UPDATE webhook_events SET status = $2, error = $3, processed_at = now() WHERE id = $1`, [
    id,
    status,
    error ?? null,
  ]);
}

/** Devuelve el evento a la cola tras un error transitorio, o lo marca fallido si agotó intentos. */
export async function releaseWebhookEvent(pool: Pool, id: string, error: string, maxAttempts: number): Promise<'retry' | 'failed'> {
  const { rows } = await pool.query<{ status: 'received' | 'failed' }>(
    `UPDATE webhook_events
        SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'received' END,
            error = $2,
            processed_at = CASE WHEN attempts >= $3 THEN now() ELSE NULL END
      WHERE id = $1 AND status = 'processing'
      RETURNING status`,
    [id, error.slice(0, 2000), maxAttempts],
  );
  return rows[0]?.status === 'failed' ? 'failed' : 'retry';
}

/**
 * Eventos que quedaron sin encolar (falló Redis justo después de guardarlos) o tomados por un
 * worker que murió. Se devuelven a 'received' para reencolarlos.
 */
export async function reclaimStaleWebhookEvents(
  pool: Pool,
  opts: { receivedOlderThanMs: number; processingOlderThanMs: number; limit: number },
): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE webhook_events
        SET status = 'received'
      WHERE id IN (
        SELECT id FROM webhook_events
         WHERE (status = 'received' AND received_at < now() - make_interval(secs => $1 / 1000.0))
            OR (status = 'processing' AND claimed_at < now() - make_interval(secs => $2 / 1000.0))
         ORDER BY received_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING id`,
    [opts.receivedOlderThanMs, opts.processingOlderThanMs, opts.limit],
  );
  return rows.map((r) => r.id);
}

export async function resolveChannelAccount(
  pool: Pool,
  channel: Channel,
  externalAccountId: string,
): Promise<{ channelAccountId: string; tenantId: string } | null> {
  const { rows } = await pool.query<{ channel_account_id: string; tenant_id: string }>(
    'SELECT channel_account_id, tenant_id FROM resolve_channel_account($1, $2)',
    [channel, externalAccountId],
  );
  const row = rows[0];
  return row ? { channelAccountId: row.channel_account_id, tenantId: row.tenant_id } : null;
}
