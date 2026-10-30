/**
 * Pruebas del router integrado con Express: catálogo 16, detalle, formato
 * pdf/xlsx, errores 404/400 y control de roles, usando un pool falso (sin
 * base de datos y sin afirmar SQL ejecutado).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createReportsRouter } from '../index.js';
import { ApiError as HostApiError } from '../../server/lib/http.js';

let server;
let baseUrl;

test('errores de autenticación del host conservan 401/403 al cruzar el router', async () => {
  let queries = 0;
  const app = express();
  app.use('/reports', createReportsRouter({
    pool: { query: async () => { queries++; return { rows: [] }; } },
    requireAuth: (req, _res, next) => {
      if (!req.get('x-test-login')) return next(new HostApiError(401, 'AUTH_REQUIRED', 'Inicie sesión'));
      next();
    },
    requireRole: () => (_req, _res, next) => next(new HostApiError(403, 'FORBIDDEN', 'Rol no autorizado')),
  }));
  app.use((error, _req, res, _next) => {
    assert.ok(error instanceof HostApiError);
    res.status(error.status).json({ error: { code: error.code } });
  });
  const local = app.listen(0, '127.0.0.1');
  await new Promise(resolve => local.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${local.address().port}/reports/clientes-registrados`;
    const anonymous = await fetch(url);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error.code, 'AUTH_REQUIRED');
    const technician = await fetch(url, { headers: { 'x-test-login': 'yes' } });
    assert.equal(technician.status, 403);
    assert.equal((await technician.json()).error.code, 'FORBIDDEN');
    assert.equal(queries, 0);
  } finally {
    await new Promise(resolve => local.close(resolve));
  }
});

const fakePool = {
  async query(_text, _params) {
    return {
      rows: [
        {
          case_number: 'CAS-1',
          full_name: 'Ana',
          amount_cents: '5000',
          created_at: new Date(Date.UTC(2026, 0, 15, 20, 30)),
          active: true,
        },
      ],
    };
  },
};

function fakeAuth(req, _res, next) {
  req.user = { id: 1, email: 'admin@relevo.local', role: 'admin' };
  next();
}

function fakeRequireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Debe iniciar sesión' } });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No tiene permiso para esta operación' } });
    }
    return next();
  };
}

before(async () => {
  const app = express();
  app.use('/api/reports', createReportsRouter({
    pool: fakePool,
    requireAuth: fakeAuth,
    requireRole: fakeRequireRole,
  }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}/api/reports`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return response;
}

test('GET / devuelve 16 reportes exactos', async () => {
  const response = await call('/');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 16);
  for (const item of body.data) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ['category', 'filters', 'name', 'slug'],
    );
  }
});

test('GET /:slug devuelve data completa', async () => {
  const response = await call('/pagos-por-reparacion');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.report.slug, 'pagos-por-reparacion');
  assert.ok(body.data.columns.length > 0);
  const row = body.data.rows[0];
  // Dinero normalizado a centavos enteros.
  assert.equal(row.amount_cents, 5000);
  // Fecha ISO UTC
  assert.equal(row.created_at, new Date(Date.UTC(2026, 0, 15, 20, 30)).toISOString());
  assert.deepEqual(body.data.filters, {});
  assert.equal(body.error, undefined);
});

test('slug desconocido -> 404 con {error:{code,message}}', async () => {
  const response = await call('/no-existe');
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, 'REPORT_NOT_FOUND');
  assert.ok(body.error.message);
});

test('formato desconocido -> 400', async () => {
  const response = await call('/ingresos-diarios?format=csv');
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('fechas imposibles o invertidas -> 400', async () => {
  for (const query of ['from=2026-02-30', 'from=31-12-2026', 'from=2026-02-01&to=2026-01-01']) {
    const response = await call(`/ingresos-diarios?${query}`);
    assert.equal(response.status, 400, query);
    const body = await response.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  }
});

test('technician_id inválido -> 400', async () => {
  const response = await call('/reparaciones-por-tecnico?technician_id=abc');
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('format=pdf: cabeceras de descarga y contenido %PDF', async () => {
  const response = await call('/ingresos-diarios?format=pdf&from=2026-01-01&to=2026-01-31');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  const disposition = response.headers.get('content-disposition');
  assert.ok(disposition.startsWith('attachment; filename="'));
  assert.ok(disposition.includes('relevo-ingresos-diarios_2026-01-01_2026-01-31.pdf'));
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.equal(buffer.subarray(0, 4).toString('latin1'), '%PDF');
});

test('format=xlsx: cabeceras MIME de hoja de cálculo', async () => {
  const response = await call('/ingresos-mensuales?format=xlsx');
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('content-type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  const buffer = Buffer.from(await response.arrayBuffer());
  // Firma ZIP (xlsx es un paquete Office Open XML).
  assert.deepEqual([...buffer.subarray(0, 2)], [0x50, 0x4b]);
});

test('rol no autorizado -> 403; filtro por rol', async () => {
  // Configura requireRole restrictivo: solo admin.
  const app = express();
  app.use('/api/reports', createReportsRouter({
    pool: fakePool,
    requireAuth: (req, _res, next) => {
      req.user = { id: 2, role: 'technician' };
      next();
    },
    requireRole: fakeRequireRole,
  }));
  const local = http.createServer(app);
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${local.address().port}/api/reports/`;
  const response = await fetch(url);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, 'FORBIDDEN');
  await new Promise((resolve) => local.close(resolve));
});

test('exceso de filas: 413 REPORT_TOO_LARGE en json y pdf, sin exportación parcial', async () => {
  // El pool falso devuelve 9 filas, por encima del límite de
  // reparaciones-por-estado (8): simula un resultado que excede el tope.
  const bigPool = {
    async query() {
      return { rows: Array.from({ length: 9 }, () => ({ estado: 'received', casos: 1 })) };
    },
  };
  const app = express();
  app.use('/api/reports', createReportsRouter({
    pool: bigPool,
    requireAuth: fakeAuth,
    requireRole: fakeRequireRole,
  }));
  const local = http.createServer(app);
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${local.address().port}/api/reports`;
  try {
    const jsonResponse = await fetch(`${base}/reparaciones-por-estado`);
    assert.equal(jsonResponse.status, 413);
    const body = await jsonResponse.json();
    assert.equal(body.error.code, 'REPORT_TOO_LARGE');
    assert.ok(body.error.message.includes('acote los filtros'));

    const pdfResponse = await fetch(`${base}/reparaciones-por-estado?format=pdf`);
    assert.equal(pdfResponse.status, 413);
    assert.ok((pdfResponse.headers.get('content-type') ?? '').includes('application/json'));
    const pdfBody = await pdfResponse.json();
    assert.equal(pdfBody.error.code, 'REPORT_TOO_LARGE');
    assert.ok(!pdfResponse.headers.get('content-disposition'));
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
});
