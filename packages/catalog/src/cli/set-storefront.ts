import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { createPool, withTenant } from '@zenith/db';
import { saveStorefrontPhoto } from '../storefront.js';

/**
 * Uso: npm run tenant:storefront -- --tenant-id <uuid> --photo ruta/a/fachada.jpg
 *
 * Carga la foto de la fachada que el bot envía con la dirección cuando el cliente pregunta
 * dónde queda la tienda. Si ya había una, la reemplaza.
 */
const { values } = parseArgs({ options: { 'tenant-id': { type: 'string' }, photo: { type: 'string' } } });
const tenantId = values['tenant-id'];
const photo = values.photo;
const dbUrl = process.env.DATABASE_URL;
if (!tenantId || !photo || !dbUrl) {
  console.error('Faltan --tenant-id, --photo o DATABASE_URL.');
  process.exit(1);
}

const pool = createPool(dbUrl, 1);
try {
  const data = await readFile(photo);
  const id = await withTenant(pool, tenantId, (c) => saveStorefrontPhoto(c, tenantId, { name: basename(photo), data }));
  console.log(`Foto de la fachada guardada (${id}).`);
} catch (err) {
  console.error(`No se pudo guardar la foto: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
