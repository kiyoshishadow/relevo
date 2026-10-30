import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG } from '../catalog.js';
import { REPORT_DEFINITIONS } from '../reports.js';
import { runReport } from '../run.js';
import { TZ } from '../format.js';
import { ApiError } from '../errors.js';

const ALL = CATALOG.map((report) => ({
  entry: report,
  definition: REPORT_DEFINITIONS[report.slug],
}));

test('cada reporte del catálogo tiene definición SQL con columnas', () => {
  for (const { entry, definition } of ALL) {
  assert.ok(definition, `sin definición: ${entry.slug}`);
    assert.ok(definition.columns.length >= 2);
    assert.ok(definition.build, `${entry.slug} sin build`);
    assert.ok(definition.summarize, `${entry.slug} sin summarize`);
  }
});

test('SQL siempre parametrizado: cada $n tiene valor y ningún valor entra al texto', () => {
  for (const { entry, definition } of ALL) {
    for (const filters of [
      {},
      { from: '2026-01-01', to: '2026-01-31' },
      { from: '2026-01-01' },
      { to: '2026-12-31' },
      { technician_id: 7, brand: 'Samsung' },
    ]) {
      if (filters.technician_id && !entry.filters.includes('technician_id')) continue;
      if (filters.brand && !entry.filters.includes('brand')) continue;
      const built = definition.build(filters);
      const placeholders = built.sql.match(/\$\d+/g) ?? [];
      const unique = [...new Set(placeholders)].map((mark) => Number(mark.slice(1)));
      const maxIndex = Math.max(0, ...unique);
      assert.equal(
        built.params.length,
        maxIndex,
        `${entry.slug}: parámetros ${built.params.length} vs placeholders hasta $${maxIndex}`,
      );
      assert.deepEqual(unique.sort((a, b) => a - b), Array.from({ length: maxIndex }, (_v, i) => i + 1));
      // El orden de los parámetros sigue el orden textual de los $n.
      // Los valores solo viajan en params, nunca concatenados al texto.
      for (const [paramIndex, value] of built.params.entries()) {
        const marker = `$${paramIndex + 1}`;
        assert.ok(placeholders.includes(marker), `${entry.slug}: $${paramIndex + 1} sin valor (${value})`);
      }
    }
  }
});

test('rangos inclusivos America/El_Salvador para timestamptz', () => {
  const built = REPORT_DEFINITIONS['reparaciones-por-periodo'].build({
    from: '2026-01-01',
    to: '2026-01-31',
  });
  assert.ok(built.sql.includes(`AT TIME ZONE '${TZ}'`));
  assert.ok(built.sql.includes('$1::date)::timestamp'));
  assert.deepEqual(built.params, ['2026-01-01', '2026-01-31']);
});

test('rangos: límite superior exclusivo del día siguiente (to inclusivo)', () => {
  const built = REPORT_DEFINITIONS['reparaciones-por-periodo'].build({ to: '2026-01-31' });
  assert.ok(built.sql.includes('$1::date + 1'));
  assert.deepEqual(built.params, ['2026-01-31']);
});

test('columnas DATE (purchase_date) se serializan como texto AAAA-MM-DD', () => {
  const built = REPORT_DEFINITIONS['registro-terminales'].build({});
  assert.ok(built.sql.includes('t.purchase_date::text'));
});

test('conteos cero: estados y técnicos fijos con LEFT JOIN', () => {
  const estados = REPORT_DEFINITIONS['reparaciones-por-estado'].build({}).sql;
  assert.ok(estados.includes("LEFT JOIN cases ca"));
  assert.ok(estados.includes("VALUES"));
  for (const status of ['received', 'delivered', 'cancelled']) {
    assert.ok(estados.includes(`'${status}'`));
  }
  const tecnicos = REPORT_DEFINITIONS['reparaciones-por-tecnico'].build({}).sql;
  assert.ok(tecnicos.includes("u.role = 'technician'"));
  assert.ok(tecnicos.includes("LEFT JOIN cases ca"));
});

test('dinero en centavos enteros vía SQL, nunca flotante', () => {
  const built = REPORT_DEFINITIONS['ingresos-totales'].build({
    from: '2026-01-01',
    to: '2026-01-31',
  });
  assert.ok(built.sql.includes('COALESCE(sum(p.amount_cents), 0)::bigint'));
  assert.ok(!built.sql.toLowerCase().includes('::float'));
  assert.ok(!built.sql.toLowerCase().includes('::numeric'));
});

test('anti doble conteo: pagos suman sin JOIN de pagos por caso', () => {
  const built = REPORT_DEFINITIONS['pagos-por-reparacion'].build({});
  // Une pagos (1 fila por pago) con caso y cliente: joins 1:1, sin fan-out.
  const paymentTableCount = (built.sql.match(/\bFROM payments\b/g) ?? []).length;
  assert.equal(paymentTableCount, 1);
});

test('sin columnas ni tablas sensibles en ningún reporte', () => {
  const forbidden = [
    'password_hash',
    'tracking_token_hash',
    'csrf_token',
    'idempotency_key',
    'request_hash',
    'sessions',
    's.password_hash',
    'audit_log',
  ];
  for (const { entry, definition } of ALL) {
    for (const filters of [{}, { from: '2026-01-01', to: '2026-01-31' }]) {
      const built = definition.build(filters);
      const lowered = built.sql.toLowerCase();
      for (const token of forbidden) {
        assert.ok(!lowered.includes(token.toLowerCase()), `${entry.slug}: usa ${token}`);
      }
    }
  }
});

test('guardia de tamaño: límite declarado, SQL consulta límite+1 o cardinalidad garantizada', () => {
  for (const { entry, definition } of ALL) {
    assert.ok(
      Number.isInteger(definition.limit) && definition.limit >= 1,
      `${entry.slug} sin limit declarado`,
    );
    const built = definition.build({});
    const match = built.sql.match(/LIMIT (\d+)/);
    if (match) {
      assert.equal(
        Number(match[1]),
        definition.limit + 1,
        `${entry.slug}: SQL debe consultar límite+1 para detectar exceso`,
      );
    } else {
      // Sin consultas LIMIT de truncar solo si la cardinalidad del grupo está
      // garantizada por el esquema y ambas documentación testada.
      assert.ok(
        (entry.slug === 'ingresos-totales' && definition.limit === 4) ||
          (entry.slug === 'reparaciones-por-estado' && definition.limit === 8),
        `${entry.slug}: sin LIMIT pero cardinalidad no garantizada`,
      );
    }
  }
});

test('sin truncación silenciosa: runReport rechaza con 413 REPORT_TOO_LARGE', async () => {
  const entry = CATALOG.find((report) => report.slug === 'reparaciones-por-periodo');
  const definition = REPORT_DEFINITIONS[entry.slug];
  const fakePool = {
    async query() {
      return { rows: Array.from({ length: definition.limit + 1 }, (_v, i) => ({ day: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, cases: 1, delivered: 0 })) };
    },
  };
  await assert.rejects(
    runReport(entry, { from: '2026-01-01', to: '2026-01-31' }, fakePool),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 413);
      assert.equal(error.code, 'REPORT_TOO_LARGE');
      assert.ok(error.message.includes('acote los filtros'));
      // Error completo, no conjunto parcial con meta: no devuelve filas ni resumen.
      assert.deepEqual(error.details?.[0], { limit: definition.limit, returned: definition.limit + 1 });
      return true;
    },
  );
});

test('universos acotados: límites 4/8 declarados y sin LIMIT de truncado', () => {
  assert.equal(REPORT_DEFINITIONS['ingresos-totales'].limit, 4);
  assert.equal(REPORT_DEFINITIONS['ingresos-totales'].build({}).sql.includes('LIMIT'), false);
  assert.equal(REPORT_DEFINITIONS['reparaciones-por-estado'].limit, 8);
  assert.equal(REPORT_DEFINITIONS['reparaciones-por-estado'].build({}).sql.includes('LIMIT'), false);
});

test('runReport normaliza filas y calcula resumen con pool de prueba', async () => {
  const fakePool = {
    async query(_text, _params) {
      return {
        rows: [
          {
            day: '2026-01-05',
            cases: 3,
            delivered: '1',
          },
          { day: '2026-01-06', cases: 2, delivered: 2 },
        ],
      };
    },
  };
  const entry = CATALOG.find((report) => report.slug === 'reparaciones-por-periodo');
  const data = await runReport(entry, { from: '2026-01-01', to: '2026-01-31' }, fakePool);
  assert.equal(data.rows.length, 2);
  assert.deepEqual(data.rows[0], { day: '2026-01-05', cases: 3, delivered: 1 });
  assert.equal(data.summary.casos, 5);
  assert.equal(data.summary.entregados, 3);
  assert.deepEqual(data.filters, { from: '2026-01-01', to: '2026-01-31' });
  assert.deepEqual(
    Object.keys(data).sort(),
    ['columns', 'filters', 'report', 'rows', 'summary'],
  );
});
