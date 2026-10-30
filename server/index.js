import { config } from './config.js';
import { pool, query, closePool } from './db/pool.js';
import { createApp } from './app.js';
import { requireAuth, requireRole } from './middleware/session.js';
import { createReportsRouter } from '../reports/index.js';
import { startNotificationDispatcher } from './services/notifications.js';

// REPORT-01: router real, con el pool y los middlewares del backend.
const reportsRouter = createReportsRouter({ pool, requireAuth, requireRole });
const app = createApp({ reportsRouter });
const server = app.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      event: 'server.started',
      url: `http://${config.host}:${config.port}`,
      env: config.env,
      reports: 'mounted',
      frontend: app.locals.frontendDir ? 'served' : 'not_built',
      static_dir: app.locals.frontendDir,
      notifications_mode: config.notificationsMode,
      notifications_note:
        config.notificationsMode === 'local'
          ? 'Modo local: no equivale a correo externo entregado'
          : 'SMTP configurado',
    }),
  );
});

server.on('error', (error) => {
  console.error(JSON.stringify({ event: 'server.error', message: error.message }));
  process.exitCode = 1;
});

const stopDispatcher = startNotificationDispatcher();

const sessionCleanup = setInterval(async () => {
  try {
    const result = await query('DELETE FROM sessions WHERE expires_at < now()');
    if (result.rowCount > 0) {
      console.log(JSON.stringify({ event: 'sessions.cleanup', deleted: result.rowCount }));
    }
  } catch (error) {
    console.error(JSON.stringify({ event: 'sessions.cleanup_error', message: error.message }));
  }
}, 15 * 60 * 1000);
sessionCleanup.unref?.();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: 'server.shutdown', signal }));
  clearInterval(sessionCleanup);
  stopDispatcher();
  await new Promise((resolve) => server.close(resolve));
  await closePool().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server, pool };
