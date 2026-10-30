/**
 * HTTP regression for terminal/coverage compatibility. Like integration.test.js,
 * this uses a pool double: no PostgreSQL connection or database writes are made.
 * The real router, body schema and transaction wrapper remain under test.
 */
import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DATABASE_URL = 'postgres://offline:offline@127.0.0.1:1/terminals_test_offline';
process.env.NODE_ENV = 'test';
const { pool, closePool } = await import('../db/pool.js');
const { default: terminalsRouter } = await import('../routes/terminals.js');

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, role: 'reception' };
    next();
  });
  app.use('/api/terminals', terminalsRouter);
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  });
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await closePool();
});

async function createTerminal({ coverage, brand = 'Apple', coverageId = 7 }) {
  const statements = [];
  let released = false;
  const connection = {
    async query(sql, params) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      statements.push(normalized);
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)) return { rows: [] };
      if (normalized.startsWith('SELECT id, active FROM clients')) {
        return { rows: [{ id: 1, active: true }] };
      }
      if (normalized.includes('FROM coverages')) {
        assert.deepEqual(params, [coverageId]);
        assert.match(normalized, /\bbrand\b/);
        assert.match(normalized, /FOR SHARE$/);
        return { rows: coverage ? [coverage] : [] };
      }
      if (normalized.startsWith('INSERT INTO terminals')) {
        return { rows: [{
          id: 42, client_id: params[0], brand: params[1], model: params[2],
          purchase_date: params[3], coverage_id: params[6],
        }] };
      }
      if (normalized.startsWith('INSERT INTO audit_log')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() { released = true; },
  };
  const connect = mock.method(pool, 'connect', async () => connection);
  try {
    const response = await fetch(`${base}/api/terminals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: 1, brand, model: 'Regression device',
        purchase_date: '2020-01-01', initial_condition: 'Pantalla averiada',
        coverage_id: coverageId,
      }),
    });
    const body = await response.json();
    assert.equal(released, true, 'transaction connection must be released');
    return { status: response.status, body, statements };
  } finally {
    connect.mock.restore();
  }
}

function assertRejected(result, code, status = 409) {
  assert.equal(result.status, status);
  assert.equal(result.body.error.code, code);
  assert.equal(result.statements.at(-1), 'ROLLBACK');
  assert.equal(result.statements.some((sql) => sql.startsWith('INSERT')), false,
    'rejected coverage must not insert a terminal or an audit record');
}

test('rejects an active coverage belonging to another brand before any write', async () => {
  const result = await createTerminal({ coverage: { id: 7, active: true, brand: 'Samsung' } });
  assertRejected(result, 'COVERAGE_BRAND_MISMATCH');
  assert.deepEqual(result.body.error.details[0].path, ['coverage_id']);
});

for (const [label, coverageBrand, terminalBrand] of [
  ['global coverage', null, 'Apple'],
  ['matching brand', 'Apple', 'Apple'],
  ['normalized brand', '  aPpLe  ', ' APPLE '],
]) {
  test(`accepts ${label} and commits terminal plus audit`, async () => {
    const result = await createTerminal({
      coverage: { id: 7, active: true, brand: coverageBrand }, brand: terminalBrand,
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.data.coverage_id, 7);
    assert.equal(result.statements.at(-1), 'COMMIT');
    assert.equal(result.statements.filter((sql) => sql.startsWith('INSERT')).length, 2);
  });
}

test('retains inactive coverage conflict even when the brand matches', async () => {
  assertRejected(await createTerminal({ coverage: { id: 7, active: false, brand: 'Apple' } }),
    'COVERAGE_INACTIVE');
});

test('retains missing coverage response', async () => {
  assertRejected(await createTerminal({ coverage: null }), 'COVERAGE_NOT_FOUND', 404);
});

test('allows a terminal without coverage without reading the coverage table', async () => {
  const result = await createTerminal({ coverageId: null });
  assert.equal(result.status, 201);
  assert.equal(result.body.data.coverage_id, null);
  assert.equal(result.statements.some((sql) => sql.includes('FROM coverages')), false);
  assert.equal(result.statements.at(-1), 'COMMIT');
});
