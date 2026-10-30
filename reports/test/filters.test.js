import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCalendarDate,
  parseDateParam,
  parseTechnicianId,
  parseBrand,
  parseFilters,
} from '../filters.js';
import { ApiError } from '../errors.js';

const expectApiError = (fn, status, code) => {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
};

test('isCalendarDate rechaza fechas imposibles', () => {
  assert.equal(isCalendarDate('2026-02-30'), false);
  assert.equal(isCalendarDate('2026-04-31'), false);
  assert.equal(isCalendarDate('2026-13-01'), false);
  assert.equal(isCalendarDate('2025-02-29'), false);
  assert.equal(isCalendarDate('2024-02-29'), true);
  assert.equal(isCalendarDate('2026-02-28'), true);
});

test('parseDateParam: vacío -> null, formato y calendario validados', () => {
  assert.equal(parseDateParam(undefined, 'from'), null);
  assert.equal(parseDateParam('', 'from'), null);
  assert.equal(parseDateParam('  2026-01-31  ', 'from'), '2026-01-31');
  expectApiError(() => parseDateParam('31/01/2026', 'from'), 400, 'VALIDATION_ERROR');
  expectApiError(() => parseDateParam('2026-1-5', 'from'), 400, 'VALIDATION_ERROR');
  expectApiError(() => parseDateParam('2026-02-30', 'from'), 400, 'VALIDATION_ERROR');
});

test('rangos imposibles se rechazan en parseFilters', () => {
  const entry = { filters: ['from', 'to'] };
  const valid = parseFilters(entry, { from: '2026-01-01', to: '2026-01-31' });
  assert.deepEqual(valid, { from: '2026-01-01', to: '2026-01-31' });
  // límites inclusivos: from == to es válido
  assert.deepEqual(parseFilters(entry, { from: '2026-02-03', to: '2026-02-03' }), {
    from: '2026-02-03',
    to: '2026-02-03',
  });
  expectApiError(
    () => parseFilters(entry, { from: '2026-01-31', to: '2026-01-01' }),
    400,
    'VALIDATION_ERROR',
  );
});

test('technician_id catastrófico e inválido', () => {
  assert.equal(parseTechnicianId(undefined), null);
  assert.equal(parseTechnicianId('42'), 42);
  for (const bad of ['abc', '-1', '0', '3.5', '1e2', ' 12x']) {
    expectApiError(() => parseTechnicianId(bad), 400, 'VALIDATION_ERROR');
  }
  // Vacío significa "sin filtro", no error.
  assert.equal(parseTechnicianId(''), null);
});

test('brand: recorta, quita caracteres de control y de limita', () => {
  assert.equal(parseBrand(undefined), null);
  assert.equal(parseBrand('  Samsung  '), 'Samsung');
  assert.equal(parseBrand('\u0001Samsung\tGalaxy\n'), 'Samsung Galaxy');
  expectApiError(() => parseBrand('x'.repeat(81)), 400, 'VALIDATION_ERROR');
});

test('parseFilters ignora filtros no permitidos por el reporte', () => {
  const entry = { filters: ['from', 'to'] };
  const filters = parseFilters(entry, {
    from: '2026-01-01',
    to: '2026-01-02',
    technician_id: '999',
    brand: 'Apple',
  });
  assert.deepEqual(filters, { from: '2026-01-01', to: '2026-01-02' });
});

test('parseFilters valida según los filtros del reporte', () => {
  const entry = { filters: ['from', 'to', 'technician_id', 'brand'] };
  const filters = parseFilters(entry, {
    from: '2026-01-01',
    to: '2026-01-31',
    technician_id: '7',
    brand: 'Xiaomi',
  });
  assert.deepEqual(filters, {
    from: '2026-01-01',
    to: '2026-01-31',
    technician_id: 7,
    brand: 'Xiaomi',
  });
  expectApiError(
    () => parseFilters(entry, { technician_id: 'x' }),
    400,
    'VALIDATION_ERROR',
  );
  // Un reporte sin filtros no valida nada
  assert.deepEqual(parseFilters({ filters: [] }, { from: 'garbage' }), {});
});
