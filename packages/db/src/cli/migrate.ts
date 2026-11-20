import { migrate } from '../migrate.js';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('Falta MIGRATION_DATABASE_URL (rol dueño del esquema).');
  process.exit(1);
}

try {
  const applied = await migrate(url);
  console.log(applied.length ? `Migraciones aplicadas: ${applied.join(', ')}` : 'La base ya estaba al día.');
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
