import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createPool } from '@zenith/db';
import { hashPassword } from '@zenith/core';

/**
 * Crea un usuario del panel (o lo agrega a otro negocio) con una contraseña aleatoria que se
 * muestra una sola vez.
 *
 * Uso: npm run user:create -- --tenant-id <uuid> --email ana@ejemplo.com --name "Ana Pérez" [--role agent|admin|owner]
 */
const { values } = parseArgs({
  options: {
    'tenant-id': { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', default: 'agent' },
  },
});

const tenantId = values['tenant-id'];
const email = values.email?.trim().toLowerCase();
const name = values.name?.trim();
const role = values.role;
if (!tenantId || !email || !name || !process.env.DATABASE_URL) {
  console.error('Faltan --tenant-id, --email, --name o DATABASE_URL.');
  process.exit(1);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Correo inválido.');
  process.exit(1);
}
if (!['agent', 'admin', 'owner'].includes(role ?? '')) {
  console.error('--role debe ser agent, admin u owner.');
  process.exit(1);
}

const pool = createPool(process.env.DATABASE_URL, 1);
try {
  const password = randomBytes(12).toString('base64url');
  const existing = await pool.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [email]);
  let userId = existing.rows[0]?.id;
  if (!userId) {
    const created = await pool.query<{ id: string }>('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [
      email,
      name,
      await hashPassword(password),
    ]);
    userId = created.rows[0]!.id;
  }
  await pool.query(
    `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, tenantId, role],
  );
  console.log(existing.rows[0] ? `Usuario existente agregado al negocio como ${role}.` : `Usuario creado (${role}).`);
  if (!existing.rows[0]) console.log(`Contraseña temporal (se muestra una sola vez): ${password}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
