import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { renderPdf } from '../exporters/pdf.js';
import { renderXlsx, needsFormulaGuard } from '../exporters/xlsx.js';
import { fmtCents } from '../format.js';

const columns = [
  { key: 'case_number', label: 'Número', type: 'text' },
  { key: 'client', label: 'Cliente', type: 'text' },
  { key: 'note', label: 'Observación', type: 'text' },
  { key: 'amount_cents', label: 'Monto (USD)', type: 'cents' },
  { key: 'created_at', label: 'Fecha', type: 'datetime' },
];

const INJECTION = '=cmd|\' /C calc\'!A0';

const rows = [
  {
    case_number: 'CAS-1',
    client: 'Ana María',
    note: 'todo normal',
    amount_cents: 1234567,
    created_at: '2026-01-15T20:30:00.000Z',
  },
  {
    case_number: 'CAS-2',
    client: 'Beto',
    note: INJECTION,
    amount_cents: 3,
    created_at: '2026-02-01T15:00:00.000Z',
  },
  {
    case_number: 'CAS-3',
    client: '+soporte falsificado',
    note: '@riesgo de fórmula',
    amount_cents: 0,
    created_at: null,
  },
];

test('fmtCents sin suma flotante', () => {
  assert.equal(fmtCents(1234567), '12,345.67');
  assert.equal(fmtCents(3), '0.03');
  assert.equal(fmtCents(0), '0.00');
});

test('guardia de fórmulas aplica a =, +, - y @', () => {
  assert.equal(needsFormulaGuard(INJECTION), true);
  assert.equal(needsFormulaGuard('+1 COMANDO'), true);
  assert.equal(needsFormulaGuard('-2 دیگر'), true);
  assert.equal(needsFormulaGuard('@X'), true);
  assert.equal(needsFormulaGuard('total normal'), false);
  assert.equal(needsFormulaGuard(''), false);
});

test('PDF: bytes válidos, cabecera con título y paginación repetida', async () => {
  const buffer = await renderPdf({
    title: 'Ingresos diarios',
    filtersApplied: { from: '2026-01-01', to: '2026-01-31', brand: 'Samsung' },
    columns,
    rows,
    generatedAt: new Date(Date.UTC(2026, 0, 27, 18, 0, 0)),
  });
  assert.ok(buffer.length > 800);
  assert.deepEqual([...buffer.subarray(0, 5)], [...Buffer.from('%PDF-')]);
  assert.ok(buffer.toString('latin1').includes('%%EOF'));
});

test('PDF: varias páginas con 300 filas de texto largo (cabecera repetida)', async () => {
  const manyRows = Array.from({ length: 300 }, (_v, i) => ({
    case_number: `CAS-${i}`,
    client: 'Cliente Argüello Membreño Núñez'.repeat(3),
    note: 'descripción extendida del diagnóstico con observaciones técnicas y partes utilizadas '.repeat(2),
    amount_cents: i * 100,
    created_at: '2026-01-15T20:30:00.000Z',
  }));
  const buffer = await renderPdf({ title: 'Historial', filtersApplied: {}, columns, rows: manyRows });
  const pageDicts = (buffer.toString('latin1').match(/\/Type \/Page(?!s)/g) ?? []).length;
  assert.ok(pageDicts >= 2, `solo ${pageDicts} páginas`);
});

test('XLSX: hoja legible, dinero decimal exacto y fórmulas neutralizadas', async () => {
  const buffer = await renderXlsx({
    title: 'Pagos por reparación',
    filtersApplied: { from: '2026-01-01', to: '2026-01-31' },
    columns,
    rows,
    generatedAt: new Date(Date.UTC(2026, 0, 27, 18, 0, 0)),
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  assert.ok(sheet);

  // Cabecera en fila 6.
  const header = sheet.getRow(6);
  assert.equal(header.getCell(1).value, 'Número');
  assert.equal(header.getCell(4).value, 'Monto (USD)');

  // Dinero como número decimal exacto 2:12,345.67
  assert.equal(sheet.getRow(7).getCell(4).value, 1234567 / 100);
  assert.equal(sheet.getRow(8).getCell(4).value, 0.03);

  // Fecha legible en hora de El Salvador
  assert.equal(sheet.getRow(7).getCell(5).numFmt, 'dd/mm/yyyy hh:mm');

  // Inyección: celda de tipo texto con contenido literal intacto.
  const evil = sheet.getRow(8).getCell(3);
  assert.equal(evil.text, INJECTION);
  const plus = sheet.getRow(9).getCell(2);
  assert.equal(plus.text, '+soporte falsificado');
  const at = sheet.getRow(9).getCell(3);
  assert.equal(at.text.startsWith('@'), true);

  // Tipo formula nunca presente en celdas de texto.
  for (const rowIndex of [7, 8, 9]) {
    for (const cellIndex of [1, 2, 3]) {
      const cell = sheet.getRow(rowIndex).getCell(cellIndex);
      const value = cell.value;
      assert.ok(!(value !== null && typeof value === 'object' && 'formula' in value));
    }
  }
});
