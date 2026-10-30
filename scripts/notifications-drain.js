import { closePool } from '../server/db/pool.js';
import { processOutbox } from '../server/services/notifications.js';

async function main() {
  const result = await processOutbox({ limit: Number(process.env.NOTIFICATIONS_BATCH || 25) });
  console.log(JSON.stringify({ event: 'notifications.drain', ...result }));
}

main()
  .catch((error) => {
    console.error(`notifications:drain falló: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
