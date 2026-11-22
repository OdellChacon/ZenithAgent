import { parseArgs } from 'node:util';
import { createPool } from '@zenith/db';
import { describeCatalog } from '../catalog-look.js';
import { buildLlm, readAiEnv } from '../llm-provider.js';

/**
 * Uso: npm run catalog:describe -- --tenant-id <uuid> [--force] [--limit 10] [--delay-ms 4500]
 *
 * Mira la foto de cada producto con el modelo de visión (AI_PROVIDER) y guarda su aspecto,
 * colores y patrón, para que el bot encuentre las piezas por cómo se ven. Solo procesa los
 * productos nuevos o cuya foto cambió, salvo con --force. Conviene correrlo después de
 * catalog:sync-imm.
 */
const { values } = parseArgs({
  options: {
    'tenant-id': { type: 'string' },
    force: { type: 'boolean', default: false },
    limit: { type: 'string' },
    'delay-ms': { type: 'string', default: '4500' },
  },
});

const tenantId = values['tenant-id'];
const dbUrl = process.env.DATABASE_URL;
if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId) || !dbUrl) {
  console.error('Faltan --tenant-id (uuid) o DATABASE_URL.');
  process.exit(1);
}
const limit = values.limit ? Number(values.limit) : undefined;
const delayMs = Number(values['delay-ms']);
if ((limit !== undefined && (!Number.isInteger(limit) || limit < 1)) || !Number.isInteger(delayMs) || delayMs < 0) {
  console.error('--limit debe ser un entero positivo y --delay-ms un entero >= 0.');
  process.exit(1);
}

const env = readAiEnv();
if (env.AI_PROVIDER === 'none') {
  console.error('Este comando necesita un proveedor de IA con visión (AI_PROVIDER).');
  process.exit(1);
}
const { llm, model } = buildLlm(env, (msg) => console.warn(msg));
const pool = createPool(dbUrl, 2);
try {
  const result = await describeCatalog({
    pool,
    tenantId,
    llm,
    model,
    force: values.force,
    ...(limit ? { limit } : {}),
    delayMs,
    onProgress: (msg) => console.log(msg),
  });
  console.log(`\nDescritos: ${result.described} · sin descripción válida: ${result.skipped} · con error: ${result.failed.length}`);
  if (result.failed.length) process.exitCode = 1;
} finally {
  await pool.end();
}
