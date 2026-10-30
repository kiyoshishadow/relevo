import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, findReportBySlug, catalogView } from '../catalog.js';

test('catálogo: 16 reportes exactos', () => {
  assert.equal(CATALOG.length, 16);
  const slugs = CATALOG.map((report) => report.slug);
  assert.equal(new Set(slugs).size, 16);
});

test('catálogo: slugs kebab-case estables', () => {
  for (const report of CATALOG) {
    assert.match(report.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.equal(typeof report.name, 'string');
    assert.ok(report.name.length > 0);
    assert.equal(typeof report.category, 'string');
    assert.ok(Array.isArray(report.filters));
  }
});

test('catálogo: cubre las 16 piezas del encargo', () => {
  const slugs = new Set(CATALOG.map((report) => report.slug));
  for (const slug of [
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
  ]) {
    assert.ok(slugs.has(slug), `falta ${slug}`);
  }
});

test('catálogo: filtros usados están entre los permitidos', () => {
  for (const report of CATALOG) {
    for (const filter of report.filters) {
      assert.ok(
        ['from', 'to', 'technician_id', 'brand'].includes(filter),
        `filtro no documentado: ${report.slug}/${filter}`,
      );
    }
  }
});

test('catálogo: vista por slug y desconocidos', () => {
  assert.equal(findReportBySlug('ingresos-diarios').category, 'Ingresos');
  assert.equal(findReportBySlug('no-existe'), null);
  assert.equal(findReportBySlug(undefined), null);
  const view = catalogView();
  assert.equal(view.length, 16);
  for (const item of view) {
    assert.deepEqual(Object.keys(item).sort(), ['category', 'filters', 'name', 'slug']);
  }
});
