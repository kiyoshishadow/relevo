/**
 * INTEGRATE-01 — Verificación del arranque integrado contra PostgreSQL real.
 *
 * Arranca un servidor propio (por defecto 127.0.0.1:3104 o un puerto efímero
 * si está ocupado), inicia sesión con la cuenta SINTÉTICA, recorre catálogo,
 * los 16 reportes JSON, filtros, exportaciones PDF/XLSX, archivos estáticos y
 * conciliación de ingresos contra SUM(payments.amount_cents).
 *
 * Uso (PowerShell):
 *   $env:VERIFY_DATABASE_URL = "postgresql://terminales@127.0.0.1:55432/relevo_dev"
 *   npm run verify:reports
 *
 * Nunca imprime ni guarda cookies, tokens CSRF, contraseñas ni filas con datos
 * personales. Solo limpia el proceso hijo que este script inicia.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const EVIDENCE_DIR = join(SCRIPT_DIR, 'evidence');

const EXPECTED_SLUGS = [
  'clientes-registrados',
  'reparaciones-por-periodo',
  'ingresos-totales',
  'terminales-ingresados',
  'reparaciones-por-tecnico',
  'reparaciones-por-problema',
  'terminales-por-marca',
  'reparaciones-por-cobertura',
  'historial-reparaciones',
  'pagos-por-reparacion',
  'registro-terminales',
  'prestamos',
  'ingresos-diarios',
  'ingresos-semanales',
  'ingresos-mensuales',
  'reparaciones-por-estado',
];

// Columnas que los 16 SQL de reports/reports.js leen del esquema real.
const EXPECTED_SCHEMA = {
  clients: [
    'id', 'full_name', 'document_id', 'phone', 'email', 'address', 'active', 'created_at',
  ],
  cases: [
    'id', 'case_number', 'client_id', 'terminal_id', 'reported_problem', 'technician_id',
    'status', 'problem_type', 'coverage_covered', 'created_at',
  ],
  terminals: [
    'id', 'client_id', 'brand', 'model', 'purchase_date', 'coverage_id', 'created_at',
  ],
  users: ['id', 'full_name', 'role', 'active'],
  payments: ['id', 'case_id', 'amount_cents', 'method', 'reference', 'created_at'],
  case_history: ['id', 'case_id', 'from_status', 'to_status', 'note', 'changed_by', 'created_at'],
  loans: [
    'id', 'case_id', 'loan_device_id', 'condition_out', 'condition_in', 'loaned_at', 'returned_at',
  ],
  loan_devices: ['id', 'asset_tag', 'brand', 'model'],
  coverages: ['id', 'name'],
  terminal_imeis: ['terminal_id', 'imei'],
};

const SENSITIVE_KEYS = new Set([
  'password_hash', 'tracking_token_hash', 'csrf_token', 'idempotency_key',
  'request_hash', 'password', 'cookie',
]);
const FORBIDDEN_PORTS = new Set([3001, 3103, 5175]);

const databaseUrl = process.env.VERIFY_DATABASE_URL || process.env.DATABASE_URL || '';
const adminEmail = process.env.VERIFY_ADMIN_EMAIL || 'admin@relevo.test';
const adminPassword = process.env.VERIFY_ADMIN_PASSWORD || 'RelevoDemo2026!';
const technicianEmail = process.env.VERIFY_TECH_EMAIL || 'tecnico@relevo.test';
const buildDir = process.env.FRONTEND_DIST || join(PROJECT_ROOT, 'frontend', 'dist');

const startedAt = new Date();
const evidence = {
  task: 'INTEGRATE-01',
  started_at: startedAt.toISOString(),
  status: 'running',
  environment: {},
  checks: [],
  warnings: [],
  limitations: [],
  reports: {},
  exports: {},
  income: {},
  static: {},
};

const failures = [];
const started = new Map();

function beginCheck(name) {
  started.set(name, performance.now());
}

function record(name, ok, detail = {}, error = null) {
  const duration = Math.round(performance.now() - (started.get(name) || performance.now()));
  const entry = { name, ok, duration_ms: duration, ...detail };
  if (!ok) {
    entry.error = error?.message || 'Comprobación fallida';
    failures.push({ name, error: entry.error });
  }
  evidence.checks.push(entry);
  const mark = ok ? 'OK  ' : 'FAIL';
  console.log(`${mark} ${name}${ok ? '' : `: ${entry.error}`}`);
  return ok;
}

async function check(name, fn) {
  beginCheck(name);
  try {
    const detail = (await fn()) || {};
    record(name, true, detail);
    return detail;
  } catch (error) {
    record(name, false, {}, error);
    return null;
  }
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseDbInfo(url) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port,
    database: parsed.pathname.replace(/^\//, ''),
    user: decodeURIComponent(parsed.username),
    password_present: Boolean(parsed.password),
  };
}

async function portIsFree(port) {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.once('error', () => resolvePort(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePort(true)));
  });
}

async function ephemeralPort() {
  const probe = createServer();
  await new Promise((resolvePort, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolvePort);
  });
  const { port } = probe.address();
  await new Promise((resolvePort) => probe.close(resolvePort));
  return port;
}

async function choosePort() {
  const requested = Number(process.env.VERIFY_PORT || 3104);
  ensure(Number.isInteger(requested) && requested > 0, 'VERIFY_PORT inválido');
  ensure(
    !FORBIDDEN_PORTS.has(requested),
    `El puerto ${requested} está reservado al coordinador (3001/3103/5175)`,
  );
  if (await portIsFree(requested)) return { port: requested, mode: 'preferred' };
  const port = await ephemeralPort();
  evidence.warnings.push(
    `El puerto ${requested} estaba ocupado; se usó el puerto efímero ${port}. No se tocó al ocupante.`,
  );
  return { port, mode: 'ephemeral' };
}

function createHttpClient(baseUrl) {
  let cookie = '';

  async function request(path, { method = 'GET', body, csrf, headers = {} } = {}) {
    const finalHeaders = { ...headers };
    if (cookie) finalHeaders.cookie = cookie;
    if (body !== undefined) finalHeaders['content-type'] = 'application/json';
    if (csrf) finalHeaders['x-csrf-token'] = csrf;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = response.headers.getSetCookie?.() || [];
    for (const raw of setCookies) {
      const pair = raw.split(';')[0];
      const index = pair.indexOf('=');
      if (index < 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      cookie = value ? `${name}=${value}` : '';
    }
    return response;
  }

  return { request, hasCookie: () => Boolean(cookie) };
}

async function readBody(response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    contentLength: response.headers.get('content-length'),
    disposition: response.headers.get('content-disposition') || '',
    cacheControl: response.headers.get('cache-control') || '',
    bytes: buffer.length,
    buffer,
    text: buffer.toString('utf8'),
  };
}

function findSensitiveKeys(value, path = '', found = []) {
  if (Array.isArray(value)) {
    for (const item of value) findSensitiveKeys(item, path, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key)) found.push(path ? `${path}.${key}` : key);
      findSensitiveKeys(child, path ? `${path}.${key}` : key, found);
    }
  }
  return found;
}

async function waitForHealth(baseUrl, child, logRef) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`El servidor terminó antes de responder (código ${child.exitCode})`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.data?.status === 'ok') return body;
      }
    } catch {
      // Aún arrancando.
    }
    await delay(250);
  }
  throw new Error(`El servidor no respondió en 30 s. Últimas líneas: ${logRef.tail()}`);
}

function createLogCollector() {
  let text = '';
  return {
    push(chunk) {
      text += chunk;
      if (text.length > 200000) text = text.slice(-100000);
    },
    tail(lines = 8) {
      return text.trim().split(/\r?\n/).slice(-lines).join(' | ').slice(0, 2000);
    },
    events() {
      return text
        .split(/\r?\n/)
        .filter((line) => line.startsWith('{'))
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter((event) => ['server.started', 'server.shutdown', 'http.error'].includes(event.event))
        .map(({ event, url, env, reports, frontend, signal, code, path, status }) => ({
          event, url, env, reports, frontend, signal, code, path, status,
        }));
    },
  };
}

async function main() {
  ensure(databaseUrl, 'Defina VERIFY_DATABASE_URL (o DATABASE_URL) con la base PostgreSQL real');
  const dbInfo = parseDbInfo(databaseUrl);
  ensure(!/sicis/i.test(dbInfo.database), 'Prohibido usar la base SICIS');
  evidence.environment = {
    database: dbInfo,
    admin_role: 'admin',
    frontend_dist: relative(PROJECT_ROOT, buildDir).replaceAll('\\', '/'),
    node: process.version,
  };

  const { default: pg } = await import('pg');
  const dbPool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5000,
  });

  // 1. Esquema real frente a las columnas que usan los 16 SQL.
  await check('schema.report_columns', async () => {
    const { rows } = await dbPool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [Object.keys(EXPECTED_SCHEMA)],
    );
    const present = new Map();
    for (const row of rows) {
      if (!present.has(row.table_name)) present.set(row.table_name, new Set());
      present.get(row.table_name).add(row.column_name);
    }
    const missing = [];
    let checked = 0;
    for (const [table, columns] of Object.entries(EXPECTED_SCHEMA)) {
      for (const column of columns) {
        checked += 1;
        if (!present.get(table)?.has(column)) missing.push(`${table}.${column}`);
      }
    }
    ensure(missing.length === 0, `Columnas ausentes: ${missing.join(', ')}`);
    return { tables: Object.keys(EXPECTED_SCHEMA).length, columns: checked, missing: 0 };
  });

  // 2. Cota de filas y definiciones reales del módulo (se informa, no se oculta).
  await check('reports.row_limit_declared', async () => {
    const { REPORT_DEFINITIONS } = await import('../reports/reports.js');
    const definitionSlugs = Object.keys(REPORT_DEFINITIONS).sort();
    ensure(
      JSON.stringify(definitionSlugs) === JSON.stringify([...EXPECTED_SLUGS].sort()),
      'Las definiciones SQL no coinciden con los 16 slugs esperados',
    );
    const limits = new Set();
    const fixedUniverses = { 'ingresos-totales': 4, 'reparaciones-por-estado': 8 };
    for (const slug of EXPECTED_SLUGS) {
      const definition = REPORT_DEFINITIONS[slug];
      const sql = definition.build({}).sql;
      const match = /\bLIMIT\s+(\d+)\s*$/i.exec(sql.trim());
      if (fixedUniverses[slug]) {
        ensure(definition.limit === fixedUniverses[slug], `${slug}: cardinalidad declarada incorrecta`);
        ensure(!match, `${slug}: el universo fijo no debe truncarse`);
      } else {
        ensure(match && Number(match[1]) === definition.limit + 1,
          `${slug}: falta la fila adicional para detectar exceso del límite`);
      }
      limits.add(definition.limit);
    }
    const rowLimit = Math.max(...limits);
    evidence.limitations.push(
      `Los reportes de cardinalidad abierta admiten hasta ${rowLimit} filas: ` +
        'la API rechaza el exceso con 413 y exige acotar filtros antes de exportar.',
    );
    return { definitions: definitionSlugs.length, row_limit: rowLimit };
  });

  // 3. Datos de referencia para filtros y conciliación.
  const reference = await check('database.reference_data', async () => {
    const totals = await dbPool.query(
      `SELECT COALESCE(sum(amount_cents), 0)::bigint AS income_cents,
              count(*)::int AS payments,
              (min(created_at) AT TIME ZONE 'America/El_Salvador')::date::text AS min_day,
              (max(created_at) AT TIME ZONE 'America/El_Salvador')::date::text AS max_day
         FROM payments`,
    );
    const technician = await dbPool.query(
      `SELECT u.id
         FROM users u
         JOIN cases ca ON ca.technician_id = u.id
        WHERE u.role = 'technician' AND u.active
        GROUP BY u.id
        ORDER BY count(*) DESC, u.id
        LIMIT 1`,
    );
    const brand = await dbPool.query(
      `SELECT t.brand
         FROM cases ca
         JOIN terminals t ON t.id = ca.terminal_id
        WHERE t.brand IS NOT NULL
        ORDER BY ca.id
        LIMIT 1`,
    );
    const row = totals.rows[0];
    ensure(technician.rowCount > 0, 'No hay técnico activo para probar el filtro technician_id');
    ensure(brand.rowCount > 0, 'No hay marcas para probar el filtro brand');
    return {
      income_cents: Number(row.income_cents),
      payments: Number(row.payments),
      min_day: row.min_day,
      max_day: row.max_day,
      technician_id: Number(technician.rows[0].id),
      brand: brand.rows[0].brand,
    };
  });
  if (reference) evidence.income.reference = reference;

  const dbTotals = await dbPool.query(
    `SELECT COALESCE(sum(amount_cents), 0)::bigint AS income_cents, count(*)::int AS payments FROM payments`,
  );
  const dbIncome = {
    income_cents: Number(dbTotals.rows[0].income_cents),
    payments: Number(dbTotals.rows[0].payments),
  };

  // 4. Servidor propio.
  const chosen = await choosePort();
  const baseUrl = `http://127.0.0.1:${chosen.port}`;
  evidence.environment.port = chosen.port;
  evidence.environment.port_mode = chosen.mode;
  const log = createLogCollector();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: String(chosen.port),
      COOKIE_SECURE: 'false',
      NOTIFICATIONS_MODE: 'local',
      NOTIFICATIONS_AUTO_PROCESS: 'false',
      CORS_ORIGINS: '',
      FRONTEND_DIST: buildDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  evidence.environment.server_pid = child.pid;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => log.push(chunk));
  child.stderr.on('data', (chunk) => log.push(chunk));

  try {
    const health = await check('server.health', async () => {
      const body = await waitForHealth(baseUrl, child, log);
      return { status: body.data.status, database: body.data.database };
    });
    if (!health) {
      throw new Error('El servidor no arrancó; se omiten las comprobaciones HTTP');
    }

    const admin = createHttpClient(baseUrl);
    let adminCsrf = '';
    const logged = await check('auth.login_admin', async () => {
      const csrfResponse = await admin.request('/api/auth/csrf');
      ensure(csrfResponse.status === 200, `GET /api/auth/csrf devolvió ${csrfResponse.status}`);
      const csrfBody = await csrfResponse.json();
      const firstToken = csrfBody?.data?.csrfToken;
      ensure(firstToken, 'No se recibió csrfToken');
      const loginResponse = await admin.request('/api/auth/login', {
        method: 'POST',
        body: { email: adminEmail, password: adminPassword },
        csrf: firstToken,
      });
      ensure(loginResponse.status === 200, `POST /api/auth/login devolvió ${loginResponse.status}`);
      const loginBody = await loginResponse.json();
      adminCsrf = loginBody?.data?.csrfToken;
      ensure(adminCsrf, 'El login no rotó el csrfToken');
      ensure(loginBody?.data?.user?.role === 'admin', 'La cuenta no tiene rol admin');
      return { status: 200, role: 'admin', cookie: 'HttpOnly recibida' };
    });

    if (!logged) {
      evidence.warnings.push('Sin sesión administrativa no se ejecutan catálogo/reportes/estáticos.');
    } else {
      const catalog = await check('reports.catalog', async () => {
        const response = await admin.request('/api/reports');
        const body = await readBody(response);
        ensure(body.status === 200, `GET /api/reports devolvió ${body.status}`);
        ensure(/^application\/json/.test(body.contentType), `Content-Type inesperado: ${body.contentType}`);
        const json = JSON.parse(body.text);
        const slugs = json.data.map((item) => item.slug);
        ensure(json.data.length === 16, `Se esperaban 16 reportes y llegaron ${json.data.length}`);
        ensure(
          JSON.stringify(slugs) === JSON.stringify(EXPECTED_SLUGS),
          'El orden/slugs del catálogo no coincide con el contrato',
        );
        for (const item of json.data) {
          ensure(typeof item.name === 'string' && item.name.length > 0, `${item.slug}: sin nombre`);
          ensure(Array.isArray(item.filters), `${item.slug}: filtros inválidos`);
        }
        return { count: json.data.length, bytes: body.bytes, slugs };
      });

      const reportData = {};
      for (const slug of EXPECTED_SLUGS) {
        const result = await check(`reports.json.${slug}`, async () => {
          const response = await admin.request(`/api/reports/${slug}`);
          const body = await readBody(response);
          ensure(body.status === 200, `HTTP ${body.status}`);
          ensure(/^application\/json/.test(body.contentType), `Content-Type ${body.contentType}`);
          const json = JSON.parse(body.text);
          const data = json.data;
          ensure(data.report?.slug === slug, 'El slug devuelto no coincide');
          ensure(Array.isArray(data.rows), 'rows no es un arreglo');
          ensure(Array.isArray(data.columns) && data.columns.length > 0, 'columns vacío');
          ensure(data.summary && typeof data.summary === 'object', 'summary ausente');
          ensure(JSON.stringify(data.filters) === '{}', 'filtros iniciales no vacíos');
          ensure(data.rows.length < 10000, 'El reporte alcanzó el LIMIT 10000: posible truncación');
          const leaked = findSensitiveKeys(json);
          ensure(leaked.length === 0, `Claves sensibles expuestas: ${leaked.join(', ')}`);
          reportData[slug] = data;
          evidence.reports[slug] = {
            rows: data.rows.length,
            columns: data.columns.length,
            summary: data.summary,
            bytes: body.bytes,
            row_limit_reached: data.rows.length >= 10000,
            duration_ms: Math.round(performance.now() - (started.get(`reports.json.${slug}`) || performance.now())),
          };
          return {
            rows: data.rows.length,
            columns: data.columns.length,
            summary: data.summary,
            bytes: body.bytes,
          };
        });
        if (!result.ok) evidence.reports[slug] = { error: 'falló la consulta JSON' };
      }

      // 5. Filtros reales y errores de validación.
      if (reference) {
        await check('filters.brand', async () => {
          const query = new URLSearchParams({ brand: reference.brand });
          const response = await admin.request(`/api/reports/terminales-ingresados?${query}`);
          const body = await readBody(response);
          ensure(body.status === 200, `HTTP ${body.status}`);
          const json = JSON.parse(body.text);
          ensure(json.data.filters.brand === reference.brand, 'El filtro brand no se refleja');
          for (const row of json.data.rows) {
            ensure(String(row.brand).toLowerCase() === reference.brand.toLowerCase(), `Marca inesperada: ${row.brand}`);
          }
          return { brand: reference.brand, rows: json.data.rows.length };
        });

        await check('filters.technician_id', async () => {
          const query = new URLSearchParams({ technician_id: String(reference.technician_id) });
          const response = await admin.request(`/api/reports/reparaciones-por-tecnico?${query}`);
          const body = await readBody(response);
          ensure(body.status === 200, `HTTP ${body.status}`);
          const json = JSON.parse(body.text);
          ensure(json.data.filters.technician_id === reference.technician_id, 'El filtro no se refleja');
          ensure(json.data.rows.length > 0, 'El técnico elegido no tiene filas');
          for (const row of json.data.rows) {
            ensure(row.technician_id === reference.technician_id, 'Se coló otro técnico');
          }
          return { technician_id: reference.technician_id, rows: json.data.rows.length };
        });

        await check('filters.date_range', async () => {
          const query = new URLSearchParams({ from: reference.min_day, to: reference.max_day });
          const response = await admin.request(`/api/reports/reparaciones-por-estado?${query}`);
          const body = await readBody(response);
          ensure(body.status === 200, `HTTP ${body.status}`);
          const json = JSON.parse(body.text);
          ensure(json.data.rows.length === 8, `Se esperaban 8 estados y llegaron ${json.data.rows.length}`);
          ensure(json.data.filters.from === reference.min_day, 'from no se refleja');
          ensure(json.data.filters.to === reference.max_day, 'to no se refleja');
          const sum = json.data.rows.reduce((total, row) => total + row.casos, 0);
          ensure(sum === json.data.summary.casos, 'El resumen de estados no suma las filas');
          return { from: reference.min_day, to: reference.max_day, rows: 8, cases: sum };
        });
      }

      for (const [name, path, expectedStatus, expectedCode] of [
        ['validation.impossible_date', '/api/reports/ingresos-diarios?from=2026-02-30', 400, 'VALIDATION_ERROR'],
        ['validation.inverted_range', '/api/reports/ingresos-diarios?from=2026-02-02&to=2026-02-01', 400, 'VALIDATION_ERROR'],
        ['validation.technician_id', '/api/reports/reparaciones-por-tecnico?technician_id=abc', 400, 'VALIDATION_ERROR'],
        ['validation.format', '/api/reports/ingresos-diarios?format=csv', 400, 'VALIDATION_ERROR'],
        ['validation.unknown_slug', '/api/reports/no-existe', 404, 'REPORT_NOT_FOUND'],
      ]) {
        await check(name, async () => {
          const response = await admin.request(path);
          const body = await readBody(response);
          ensure(body.status === expectedStatus, `HTTP ${body.status}, se esperaba ${expectedStatus}`);
          ensure(/^application\/json/.test(body.contentType), `Content-Type ${body.contentType}`);
          const json = JSON.parse(body.text);
          ensure(json.error?.code === expectedCode, `Código ${json.error?.code}, se esperaba ${expectedCode}`);
          return { status: body.status, code: json.error.code };
        });
      }

      // 6. Exportaciones: las 16 en PDF y XLSX.
      for (const slug of EXPECTED_SLUGS) {
        for (const format of ['pdf', 'xlsx']) {
          await check(`exports.${format}.${slug}`, async () => {
            const response = await admin.request(`/api/reports/${slug}?format=${format}`);
            const body = await readBody(response);
            ensure(body.status === 200, `HTTP ${body.status}`);
            const expectedType = format === 'pdf'
              ? 'application/pdf'
              : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            ensure(body.contentType === expectedType, `Content-Type ${body.contentType}`);
            ensure(body.disposition.startsWith('attachment; filename="relevo-'), `Disposition ${body.disposition}`);
            ensure(body.disposition.includes(slug), 'El nombre del archivo no incluye el slug');
            ensure(body.contentLength === String(body.bytes), 'Content-Length no coincide con el cuerpo');
            if (format === 'pdf') {
              ensure(body.buffer.subarray(0, 4).toString('latin1') === '%PDF', 'Firma PDF ausente');
              ensure(body.bytes > 800, `PDF demasiado pequeño (${body.bytes} bytes)`);
            } else {
              ensure(body.buffer[0] === 0x50 && body.buffer[1] === 0x4b, 'Firma ZIP/XLSX ausente');
              ensure(body.bytes > 800, `XLSX demasiado pequeño (${body.bytes} bytes)`);
            }
            evidence.exports[`${slug}.${format}`] = {
              status: body.status,
              content_type: body.contentType,
              bytes: body.bytes,
              filename: body.disposition.match(/filename="([^"]+)"/)?.[1] || null,
            };
            return { status: body.status, content_type: body.contentType, bytes: body.bytes };
          });
        }
      }

      // 7. Conciliación de ingresos: resumen, filas y período.
      if (reference && Object.keys(reportData).length === 16) {
        await check('income.totals_vs_db', async () => {
          const incomeReports = ['ingresos-totales', 'ingresos-diarios', 'ingresos-semanales', 'ingresos-mensuales'];
          const detail = {};
          for (const slug of incomeReports) {
            const data = reportData[slug];
            ensure(data.summary.ingreso_cents === dbIncome.income_cents, `${slug}: resumen ≠ SUM(payments)`);
            ensure(data.summary.pagos === dbIncome.payments, `${slug}: conteo ≠ COUNT(payments)`);
            const rowsTotal = data.rows.reduce((total, row) => total + row.income_cents, 0);
            const rowsCount = data.rows.reduce((total, row) => total + row.payments, 0);
            ensure(rowsTotal === dbIncome.income_cents, `${slug}: suma de filas ≠ SUM(payments)`);
            ensure(rowsCount === dbIncome.payments, `${slug}: suma de conteos ≠ COUNT(payments)`);
            detail[slug] = { summary_income_cents: data.summary.ingreso_cents, rows_income_cents: rowsTotal };
          }
          const payments = reportData['pagos-por-reparacion'];
          const paymentsRows = payments.rows.reduce((total, row) => total + row.amount_cents, 0);
          ensure(payments.summary.ingreso_cents === dbIncome.income_cents, 'pagos-por-reparacion: resumen ≠ DB');
          ensure(paymentsRows === dbIncome.income_cents, 'pagos-por-reparacion: filas ≠ DB');
          const casePaymentCount = await dbPool.query('SELECT count(*)::int AS payments FROM payments');
          ensure(payments.summary.pagos === casePaymentCount.rows[0].payments, 'pagos-por-reparacion: conteo ≠ DB');
          evidence.income.overall = {
            database_income_cents: dbIncome.income_cents,
            database_payments: dbIncome.payments,
            reports: detail,
            pagos_por_reparacion_rows_cents: paymentsRows,
          };
          return { database_income_cents: dbIncome.income_cents, database_payments: dbIncome.payments };
        });

        await check('income.period_vs_db', async () => {
          const { min_day: from, max_day: to } = reference;
          const period = await dbPool.query(
            `SELECT COALESCE(sum(amount_cents), 0)::bigint AS income_cents, count(*)::int AS payments
               FROM payments
              WHERE created_at >= ($1::date)::timestamp AT TIME ZONE 'America/El_Salvador'
                AND created_at < (($2::date + 1)::timestamp AT TIME ZONE 'America/El_Salvador')`,
            [from, to],
          );
          const expected = {
            income_cents: Number(period.rows[0].income_cents),
            payments: Number(period.rows[0].payments),
          };
          const detail = {};
          for (const slug of [
            'ingresos-totales', 'ingresos-diarios', 'ingresos-semanales',
            'ingresos-mensuales', 'pagos-por-reparacion',
          ]) {
            const query = new URLSearchParams({ from, to });
            const response = await admin.request(`/api/reports/${slug}?${query}`);
            const body = await readBody(response);
            ensure(body.status === 200, `${slug}: HTTP ${body.status}`);
            const json = JSON.parse(body.text);
            const income = slug === 'pagos-por-reparacion'
              ? json.data.summary.ingreso_cents
              : json.data.summary.ingreso_cents;
            const count = slug === 'pagos-por-reparacion'
              ? json.data.summary.pagos
              : json.data.summary.pagos;
            ensure(income === expected.income_cents, `${slug}: ingreso ${income} ≠ ${expected.income_cents}`);
            ensure(count === expected.payments, `${slug}: pagos ${count} ≠ ${expected.payments}`);
            detail[slug] = { income_cents: income, payments: count };
          }
          evidence.income.period = { from, to, database: expected, reports: detail };
          return { from, to, ...expected };
        });

        await check('income.daily_groups_vs_db', async () => {
          const rows = reportData['ingresos-diarios'].rows;
          ensure(rows.length > 0, 'ingresos-diarios no devolvió días');
          let checkedDays = 0;
          for (const row of rows) {
            const dbDay = await dbPool.query(
              `SELECT COALESCE(sum(amount_cents), 0)::bigint AS income_cents, count(*)::int AS payments
                 FROM payments
                WHERE (created_at AT TIME ZONE 'America/El_Salvador')::date = $1::date`,
              [row.dia],
            );
            ensure(
              Number(dbDay.rows[0].income_cents) === row.income_cents,
              `${row.dia}: ingreso ${row.income_cents} ≠ ${dbDay.rows[0].income_cents}`,
            );
            ensure(
              Number(dbDay.rows[0].payments) === row.payments,
              `${row.dia}: pagos ${row.payments} ≠ ${dbDay.rows[0].payments}`,
            );
            checkedDays += 1;
          }
          evidence.income.daily = { days_checked: checkedDays, mismatches: 0 };
          return { days_checked: checkedDays, mismatches: 0 };
        });
      } else {
        evidence.warnings.push('No se pudo conciliar ingresos: faltan datos de referencia o reportes.');
      }

      // 8. Frontend compilado servido en el mismo puerto (público, sin sesión).
      const publicClient = createHttpClient(baseUrl);
      await check('static.root', async () => {
        const response = await publicClient.request('/');
        const body = await readBody(response);
        ensure(body.status === 200, `HTTP ${body.status}`);
        ensure(/^text\/html/.test(body.contentType), `Content-Type ${body.contentType}`);
        ensure(body.text.includes('<div id="app">'), 'El index no contiene el contenedor de la app');
        ensure(body.cacheControl === 'no-cache', `Cache-Control ${body.cacheControl}`);
        const assets = [...new Set(body.text.match(/\/assets\/[A-Za-z0-9._-]+/g) || [])];
        ensure(assets.length >= 2, `El index debería referenciar JS y CSS; encontró ${assets.length}`);
        evidence.static = { root_bytes: body.bytes, assets };
        return { status: body.status, bytes: body.bytes, assets };
      });

      const rootCheck = evidence.checks.find((entry) => entry.name === 'static.root');
      if (rootCheck?.ok) {
        for (const asset of rootCheck.assets) {
          await check(`static.asset${asset.replace(/^\/assets\//, '.')}`, async () => {
            const response = await publicClient.request(asset);
            const body = await readBody(response);
            ensure(body.status === 200, `HTTP ${body.status}`);
            ensure(body.bytes > 100, `Archivo vacío (${body.bytes} bytes)`);
            ensure(
              /^(text\/css|text\/javascript|application\/javascript|image\/|font\/|application\/font)/.test(body.contentType),
              `Content-Type ${body.contentType}`,
            );
            ensure(body.cacheControl.includes('immutable'), `Cache-Control ${body.cacheControl}`);
            return { status: body.status, content_type: body.contentType, bytes: body.bytes };
          });
        }

        await check('static.api_unknown_authenticated', async () => {
          const response = await admin.request('/api/ruta-inexistente');
          const body = await readBody(response);
          ensure(body.status === 404, `HTTP ${body.status}, se esperaba 404`);
          ensure(/^application\/json/.test(body.contentType), `Content-Type ${body.contentType}`);
          const json = JSON.parse(body.text);
          ensure(json.error?.code === 'NOT_FOUND', `Código ${json.error?.code}`);
          ensure(!body.text.includes('<div id="app">'), 'La API desconocida devolvió el index');
          return { status: body.status, code: json.error.code };
        });

        await check('static.non_api_unknown', async () => {
          const response = await admin.request('/dashboard');
          const body = await readBody(response);
          ensure(body.status === 404, `HTTP ${body.status}`);
          ensure(!body.text.includes('<div id="app">'), 'Ruta desconocida devolvió el index');
          return { status: body.status, content_type: body.contentType };
        });

        await check('static.missing_asset', async () => {
          const response = await admin.request('/assets/no-existe.js');
          const body = await readBody(response);
          ensure(body.status === 404, `HTTP ${body.status}`);
          ensure(!body.text.includes('<div id="app">'), 'Asset ausente devolvió el index');
          return { status: body.status, content_type: body.contentType };
        });
      }

      // 9. Control de acceso: sin sesión y con rol técnico.
      await check('security.no_session', async () => {
        const anonymous = createHttpClient(baseUrl);
        const response = await anonymous.request('/api/reports');
        const body = await readBody(response);
        ensure(body.status === 401, `HTTP ${body.status}, se esperaba 401`);
        ensure(/^application\/json/.test(body.contentType), `Content-Type ${body.contentType}`);
        return { status: body.status };
      });

      await check('security.technician_forbidden', async () => {
        const technician = createHttpClient(baseUrl);
        const csrfResponse = await technician.request('/api/auth/csrf');
        const csrfBody = await csrfResponse.json();
        const loginResponse = await technician.request('/api/auth/login', {
          method: 'POST',
          body: { email: technicianEmail, password: adminPassword },
          csrf: csrfBody.data.csrfToken,
        });
        ensure(loginResponse.status === 200, `Login técnico HTTP ${loginResponse.status}`);
        const response = await technician.request('/api/reports');
        const body = await readBody(response);
        ensure(body.status === 403, `HTTP ${body.status}, se esperaba 403`);
        const json = JSON.parse(body.text);
        ensure(json.error?.code === 'FORBIDDEN', `Código ${json.error?.code}`);
        return { status: body.status, code: json.error.code };
      });

      // 10. Cierre de la sesión administrativa (limpieza).
      await check('auth.logout_admin', async () => {
        const response = await admin.request('/api/auth/logout', {
          method: 'POST',
          csrf: adminCsrf,
        });
        ensure(response.status === 200, `HTTP ${response.status}`);
        return { status: response.status };
      });
    }
  } finally {
    evidence.environment.server_events = log.events();
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(5000)]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await Promise.race([once(child, 'exit'), delay(3000)]);
      }
    }
    evidence.environment.server_exit_code = child.exitCode;
    await dbPool.end().catch(() => {});
  }
}

function buildMarkdown(result) {
  const passed = result.checks.filter((entry) => entry.ok).length;
  const failed = result.checks.length - passed;
  const lines = [
    '# INTEGRATE-01 — Evidencia de reportes contra PostgreSQL real',
    '',
    `- Estado: **${result.status}**`,
    `- Inicio: ${result.started_at}`,
    `- Fin: ${result.finished_at}`,
    `- Base: \`${result.environment.database?.host}:${result.environment.database?.port}/${result.environment.database?.database}\``,
    `- Puerto: ${result.environment.port} (${result.environment.port_mode})`,
    `- Comprobaciones: ${passed} aprobadas, ${failed} fallidas`,
    '',
    '## Comprobaciones',
    '',
    '| Comprobación | Resultado | Detalle |',
    '| --- | --- | --- |',
    ...result.checks.map((entry) => {
      const detail = entry.ok
        ? Object.entries(entry)
            .filter(([key]) => !['name', 'ok', 'duration_ms'].includes(key))
            .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
            .join(' ')
        : `error=${entry.error}`;
      return `| ${entry.name} | ${entry.ok ? 'OK' : 'FALLO'} | ${String(detail).replaceAll('|', '\\|').slice(0, 300)} |`;
    }),
    '',
    '## Reportes',
    '',
    '| Reporte | Filas | Columnas | Resumen | JSON bytes |',
    '| --- | ---: | ---: | --- | ---: |',
    ...Object.entries(result.reports).map(([slug, data]) =>
      `| ${slug} | ${data.rows ?? '-'} | ${data.columns ?? '-'} | ${data.summary ? JSON.stringify(data.summary) : '-'} | ${data.bytes ?? '-'} |`,
    ),
    '',
    '## Exportaciones',
    '',
    `${Object.keys(result.exports).length} archivos generados (PDF/XLSX) sin guardar datos clínicos ni personales; solo tamaño, tipo MIME y nombre.`,
    '',
  ];
  if (result.warnings.length) {
    lines.push('## Advertencias', '', ...result.warnings.map((warning) => `- ${warning}`), '');
  }
  if (result.limitations.length) {
    lines.push('## Limitaciones', '', ...result.limitations.map((item) => `- ${item}`), '');
  }
  return lines.join('\n');
}

let exitCode = 1;
try {
  await main();
  evidence.status = failures.length === 0 ? 'passed' : 'failed';
} catch (error) {
  evidence.status = 'failed';
  failures.push({ name: 'unexpected', error: error.message });
  console.error(`Fallo inesperado: ${error.message}`);
} finally {
  evidence.finished_at = new Date().toISOString();
  evidence.summary = {
    checks: evidence.checks.length,
    passed: evidence.checks.filter((entry) => entry.ok).length,
    failed: failures.length,
  };
  evidence.failures = failures;
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const jsonPath = join(EVIDENCE_DIR, 'integrate-01-reports.json');
  const markdownPath = join(EVIDENCE_DIR, 'integrate-01-reports.md');
  await writeFile(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, `${buildMarkdown(evidence)}\n`, 'utf8');
  console.log(
    JSON.stringify({
      event: 'verify.reports',
      status: evidence.status,
      checks: evidence.summary.checks,
      passed: evidence.summary.passed,
      failed: evidence.summary.failed,
      evidence: 'scripts/evidence/integrate-01-reports.json',
    }),
  );
  exitCode = evidence.status === 'passed' ? 0 : 1;
}

process.exit(exitCode);
