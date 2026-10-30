import { closePool } from '../server/db/pool.js';
import { runMigrations } from '../server/db/migrate.js';

async function main() {
  const applied = await runMigrations();
  if (applied.length === 0) {
    console.log('Migraciones al día. No se aplicaron cambios.');
  } else {
    for (const file of applied) console.log(`Aplicada: ${file}`);
  }
}

main()
  .catch((error) => {
    console.error(`db:migrate falló: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
