/**
 * Crea o actualiza un negocio a partir de su archivo de configuración (config/tenants/*.json):
 * nombre, zona horaria, moneda y todo lo que el bot sabe del negocio. Sirve en producción, donde
 * no se corre el seed de desarrollo. Imprime el id del negocio (lo piden user:create y
 * catalog:sync-imm). Usa el rol dueño (MIGRATION_DATABASE_URL): dar de alta negocios es tarea
 * de superadmin.
 *
 *   npm run tenant:sync -- --config config/tenants/inversiones-mora-mora.json
 *
 * Volver a correrlo con el archivo cambiado actualiza lo que sabe el bot (formas de pago,
 * horario…) sin tocar conversaciones, contactos ni canales.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { z } from 'zod';

const { values } = parseArgs({ options: { config: { type: 'string' } } });
const url = process.env.MIGRATION_DATABASE_URL;
if (!url || !values.config) {
  console.error('Uso: MIGRATION_DATABASE_URL=… npm run tenant:sync -- --config config/tenants/<negocio>.json');
  process.exit(1);
}

const config = z
  .object({
    name: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9-]{2,64}$/),
    timezone: z.string().min(1),
    currency: z.string().length(3),
    locale: z.string().min(2),
    settings: z.record(z.string(), z.unknown()),
  })
  .parse(JSON.parse(await readFile(values.config, 'utf8')));

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query<{ id: string; created: boolean }>(
    `INSERT INTO tenants (name, slug, timezone, currency, locale, settings)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone, currency = EXCLUDED.currency,
                                      locale = EXCLUDED.locale, settings = EXCLUDED.settings
     RETURNING id, (xmax = 0) AS created`,
    [config.name, config.slug, config.timezone, config.currency, config.locale, JSON.stringify(config.settings)],
  );
  console.log(`${rows[0]!.created ? 'Negocio creado' : 'Negocio actualizado'}: ${config.name}`);
  console.log(`tenant-id: ${rows[0]!.id}`);
} finally {
  await client.end();
}
