import { parseArgs } from 'node:util';
import { createPool, withTenant } from '@zenith/db';
import { fetchImmCatalog, IMM_STORE_SOURCE } from '../imm-store.js';
import { syncProducts } from '../sync.js';

/**
 * Uso: npm run catalog:sync-imm -- --tenant-id <uuid> [--base-url https://inversionesmoramora.com] [--currency USD]
 */
const { values } = parseArgs({
  options: {
    'tenant-id': { type: 'string' },
    'base-url': { type: 'string' },
    currency: { type: 'string', default: 'USD' },
  },
});

const tenantId = values['tenant-id'];
const baseUrl = values['base-url'] ?? process.env.IMM_STORE_BASE_URL;
const dbUrl = process.env.DATABASE_URL;
if (!tenantId || !baseUrl || !dbUrl) {
  console.error('Faltan --tenant-id, --base-url (o IMM_STORE_BASE_URL) o DATABASE_URL.');
  process.exit(1);
}
if (!/^[A-Z]{3}$/.test(values.currency ?? '')) {
  console.error('--currency debe ser un código ISO de 3 letras (ej. USD).');
  process.exit(1);
}

const pool = createPool(dbUrl, 2);
try {
  const { products, rejected } = await fetchImmCatalog({ baseUrl, currency: values.currency! });
  const result = await withTenant(pool, tenantId, (client) => syncProducts(client, tenantId, IMM_STORE_SOURCE, products));
  console.log(`Catálogo sincronizado: ${result.upserted} productos, ${result.deactivated} desactivados.`);
  if (rejected.length) {
    console.warn(`${rejected.length} productos rechazados por formato:`);
    for (const r of rejected) console.warn(`  - #${r.index}: ${r.reason}`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
