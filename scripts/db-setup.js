import { closePool } from '../server/db/pool.js';
import { runMigrations } from '../server/db/migrate.js';
import { seedDatabase } from './db-seed.js';

async function main() {
  const applied = await runMigrations();
  for (const file of applied) console.log(`Aplicada: ${file}`);
  const summary = await seedDatabase();
  console.log('Base sintética preparada (migraciones + seed).');
  console.log(`Contraseña demo: ${summary.password}`);
}

main()
  .catch((error) => {
    console.error(`db:setup falló: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
