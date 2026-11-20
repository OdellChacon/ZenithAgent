import { parseArgs } from 'node:util';
import { createPool, withTenant } from '@zenith/db';
import { fetchImmCatalog, IMM_STORE_SOURCE } from '../imm-store.js';
import { enrichWithManufacturer, loadCeramicaItaliaCatalog } from '../manufacturer.js';
import { syncProducts } from '../sync.js';

/**
 * Uso: npm run catalog:sync-imm -- --tenant-id <uuid> [--base-url https://inversionesmoramora.com]
 *        [--currency USD] [--manufacturer-catalog ruta/a/catalog.json]
 *
 * --manufacturer-catalog (o CI_CATALOG_PATH) agrega aspecto, color y colección desde el
 * catálogo de Cerámica Italia que importa ZenithVisualizer.
 */
const { values } = parseArgs({
  options: {
    'tenant-id': { type: 'string' },
    'base-url': { type: 'string' },
    currency: { type: 'string', default: 'USD' },
    'manufacturer-catalog': { type: 'string' },
  },
});

const tenantId = values['tenant-id'];
const baseUrl = values['base-url'] ?? process.env.IMM_STORE_BASE_URL;
const manufacturerPath = values['manufacturer-catalog'] ?? process.env.CI_CATALOG_PATH;
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
  const { products: storeProducts, rejected } = await fetchImmCatalog({ baseUrl, currency: values.currency! });
  let products = storeProducts;
  if (manufacturerPath) {
    const enriched = enrichWithManufacturer(products, await loadCeramicaItaliaCatalog(manufacturerPath));
    products = enriched.products;
    console.log(`Fabricante: ${enriched.matched} productos enriquecidos; sin pareja: ${enriched.unmatched.join(', ') || 'ninguno'}.`);
  } else {
    console.warn('Sin catálogo del fabricante: el bot no sabrá el aspecto (madera, mármol…) de cada producto.');
  }
  const result = await withTenant(pool, tenantId, (client) => syncProducts(client, tenantId, IMM_STORE_SOURCE, products));
  console.log(`Catálogo sincronizado: ${result.upserted} productos, ${result.deactivated} desactivados, ${result.images} fotos nuevas o cambiadas.`);
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
