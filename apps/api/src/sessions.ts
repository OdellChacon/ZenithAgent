import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from '@zenith/db';

export const SESSION_COOKIE = 'zs';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type Role = 'owner' | 'admin' | 'agent';

export interface SessionUser {
  sessionId: string;
  userId: string;
  tenantId: string;
  tenantName: string;
  role: Role;
  name: string;
  email: string;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(
  pool: Pool,
  data: { userId: string; tenantId: string; userAgent?: string; ip?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, user_agent, ip) VALUES ($1, $2, $3, $4, $5, $6)`,
    [hashToken(token), data.userId, data.tenantId, expiresAt, data.userAgent?.slice(0, 300) ?? null, data.ip ?? null],
  );
  return { token, expiresAt };
}

export async function findSession(pool: Pool, token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 100) return null;
  const { rows } = await pool.query<{
    id: string;
    user_id: string;
    tenant_id: string;
    tenant_name: string;
    role: Role;
    name: string;
    email: string;
  }>(
    `SELECT s.id, s.user_id, s.tenant_id, t.name AS tenant_name, m.role, u.name, u.email
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id
       CROSS JOIN LATERAL auth_tenant(s.tenant_id) t
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND t.status = 'active'`,
    [hashToken(token)],
  );
  const r = rows[0];
  return r
    ? { sessionId: r.id, userId: r.user_id, tenantId: r.tenant_id, tenantName: r.tenant_name, role: r.role, name: r.name, email: r.email }
    : null;
}

export async function revokeSession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
}

/** Límite simple de intentos de login por clave (IP o correo), en memoria del proceso. */
export function createLoginLimiter(max = 10, windowMs = 15 * 60 * 1000) {
  const hits = new Map<string, { count: number; until: number }>();
  return {
    blocked(key: string): boolean {
      const h = hits.get(key);
      if (!h || h.until < Date.now()) return false;
      return h.count >= max;
    },
    fail(key: string) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || h.until < now) hits.set(key, { count: 1, until: now + windowMs });
      else h.count++;
    },
    reset(key: string) {
      hits.delete(key);
    },
  };
}
