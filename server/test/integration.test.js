/**
 * Integración de arranque: montaje del router REAL de reportes en `createApp`
 * y servicio del build de Vite en el mismo proceso.
 *
 * No usa PostgreSQL: el pool es un doble en memoria (igual que las pruebas
 * del módulo `reports/`), por lo que aquí se comprueba el cableado HTTP, no
 * el SQL. La validación contra PostgreSQL real está en
 * `scripts/verify-reports.js` y su evidencia.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `server/db/pool.js` valida DATABASE_URL al importarse. Ninguna consulta de
// esta prueba toca la base; el pool de reportes se inyecta como doble.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://integration:integration@127.0.0.1:1/relevo_integration_offline';
process.env.NODE_ENV = 'test';
process.env.NOTIFICATIONS_AUTO_PROCESS = 'false';
process.env.CORS_ORIGINS = '';

const { createApp, DEFAULT_STATIC_DIR, resolveStaticDir } = await import('../app.js');
const { createReportsRouter } = await import('../../reports/index.js');

const INDEX_MARKER = 'relevo-static-integration-marker';

const fakePool = {
  async query(_text, _params) {
    return {
      rows: [
        {
          dia: '2026-01-15',
          payments: 2,
          income_cents: '5000',
          amount_cents: '2500',
          created_at: new Date(Date.UTC(2026, 0, 15, 18, 0)),
          active: true,
        },
      ],
    };
  },
};

/** Auth falsa: exige encabezado para distinguir 401 de sesión válida. */
function testAuth(req, res, next) {
  if (req.get('x-test-auth') !== 'ok') {
    return res.status(401).json({
      error: { code: 'AUTH_REQUIRED', message: 'Debe iniciar sesión' },
    });
  }
  req.user = { id: 1, email: 'admin@relevo.test', role: 'admin' };
  return next();
}

function testRequireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: { code: 'AUTH_REQUIRED', message: 'Debe iniciar sesión' },
      });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'No tiene permiso para esta operación' },
      });
    }
    return next();
  };
}

let server;
let baseUrl;
let staticDir;

before(async () => {
  staticDir = await mkdtemp(join(tmpdir(), 'relevo-static-'));
  await mkdir(join(staticDir, 'assets'), { recursive: true });
  await writeFile(
    join(staticDir, 'index.html'),
    `<!doctype html><html lang="es"><body><div id="app">${INDEX_MARKER}</div>` +
      '<script type="module" src="/assets/app.js"></script></body></html>',
  );
  await writeFile(join(staticDir, 'assets', 'app.js'), `console.log("${INDEX_MARKER}");`);
  await writeFile(join(staticDir, 'robots.txt'), 'User-agent: *\nDisallow: /api\n');

  const reportsRouter = createReportsRouter({
    pool: fakePool,
    requireAuth: testAuth,
    requireRole: testRequireRole,
  });
  const app = createApp({ reportsRouter, staticDir });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (staticDir) await rm(staticDir, { recursive: true, force: true });
});

async function call(path, options = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

test('la raíz sirve el index del build sin exigir sesión', async () => {
  const response = await call('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/html/);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.match(await response.text(), new RegExp(INDEX_MARKER));
});

test('los assets del build se sirven con caché inmutable', async () => {
  const response = await call('/assets/app.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /javascript/);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(await response.text(), new RegExp(INDEX_MARKER));
});

test('archivos públicos sueltos se sirven como estáticos', async () => {
  const response = await call('/robots.txt');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/plain/);
  assert.match(await response.text(), /Disallow: \/api/);
});

test('GET /api/reports sin sesión -> 401 JSON, nunca index.html', async () => {
  const response = await call('/api/reports');
  assert.equal(response.status, 401);
  assert.match(response.headers.get('content-type') || '', /^application\/json/);
  const body = await response.json();
  assert.equal(body.error.code, 'AUTH_REQUIRED');
  assert.equal(response.headers.get('content-type')?.includes('text/html'), false);
});

test('el router real de reportes está montado en /api/reports con 16 entradas', async () => {
  const response = await call('/api/reports', { headers: { 'x-test-auth': 'ok' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 16);
  assert.equal(body.data[0].slug, 'clientes-registrados');
  assert.equal(body.data.at(-1).slug, 'reparaciones-por-estado');
});

test('un reporte real responde JSON normalizado a través de la app integrada', async () => {
  const response = await call('/api/reports/ingresos-diarios?from=2026-01-01&to=2026-01-31', {
    headers: { 'x-test-auth': 'ok' },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^application\/json/);
  const body = await response.json();
  assert.equal(body.data.report.slug, 'ingresos-diarios');
  assert.equal(body.data.filters.from, '2026-01-01');
  assert.equal(body.data.rows[0].income_cents, 5000);
  assert.equal(body.data.summary.ingreso_cents, 5000);
});

test('slug de reporte desconocido -> 404 REPORT_NOT_FOUND en JSON', async () => {
  const response = await call('/api/reports/no-existe', { headers: { 'x-test-auth': 'ok' } });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, 'REPORT_NOT_FOUND');
});

test('GET /api desconocida sin sesión -> JSON de error, nunca el index', async () => {
  // La autenticación se evalúa antes del 404 para no revelar rutas; lo que
  // importa aquí es que el fallback estático jamás responda HTML en /api.
  const response = await call('/api/no-existe');
  assert.equal(response.status, 401);
  assert.match(response.headers.get('content-type') || '', /^application\/json/);
  const text = await response.text();
  assert.equal(JSON.parse(text).error.code, 'AUTH_REQUIRED');
  assert.equal(text.includes(INDEX_MARKER), false);
});

test('POST /api desconocida sin CSRF -> JSON de error, nunca el index', async () => {
  const response = await call('/api/ruta-inexistente', { method: 'POST' });
  assert.equal(response.status, 403);
  assert.match(response.headers.get('content-type') || '', /^application\/json/);
  const text = await response.text();
  assert.equal(text.includes(INDEX_MARKER), false);
});

test('GET /api/algo.html con extensión tampoco cae en un archivo estático', async () => {
  const response = await call('/api/algo.html');
  assert.equal(response.status, 401);
  assert.match(response.headers.get('content-type') || '', /^application\/json/);
  assert.equal((await response.text()).includes(INDEX_MARKER), false);
});

test('ruta no-API desconocida -> 404 JSON, el hash router no necesita fallback', async () => {
  const response = await call('/dashboard');
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') || '', /^application\/json/);
  const text = await response.text();
  assert.equal(text.includes(INDEX_MARKER), false);
});

test('la ruta del build se resuelve desde el módulo, no desde cwd', () => {
  assert.match(
    DEFAULT_STATIC_DIR.replaceAll('\\', '/'),
    /\/frontend\/dist$/,
  );
  assert.equal(resolveStaticDir('frontend/dist'), DEFAULT_STATIC_DIR);
  if (!process.env.FRONTEND_DIST) {
    assert.equal(resolveStaticDir(), DEFAULT_STATIC_DIR);
  }
});
