/**
 * Ejecución de reportes contra el pool inyectado del backend.
 * Normaliza valores para JSON (dinero = centavos enteros, fechas ISO) y
 * calcula el resumen sin aritmética de flotantes (sumas de enteros).
 */
import { REPORT_DEFINITIONS } from './reports.js';
import { iso } from './format.js';
import { ApiError } from './errors.js';

function normalizeValue(type, value) {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'cents':
    case 'integer': {
      const number = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(number) ? number : null;
    }
    case 'datetime':
      return value instanceof Date ? iso(value) : String(value);
    case 'date':
      return String(value);
    case 'boolean':
      return Boolean(value);
    default:
      return String(value);
  }
}

/** Convierte filas crudas del driver a objetos por columna del reporte. */
export function normalizeRows(columns, rawRows) {
  return rawRows.map((raw) => {
    const row = {};
    for (const column of columns) {
      row[column.key] = normalizeValue(column.type, raw[column.key]);
    }
    return row;
  });
}

/**
 * Ejecuta el reporte del catálogo.
 * Guardia anti-truncación: la consulta pide LIMIT (límite + 1); si vuelve una
 * fila de más se rechaza con 413 REPORT_TOO_LARGE pidiendo acotar filtros.
 * Nunca se entrega un reporte incompleto ni un resumen sobre un subconjunto:
 * si pasa la guardia, las filas y el resumen cubren el conjunto completo.
 * @param {{slug:string}} entry
 * @param {{from?:string,to?:string,technician_id?:number,brand?:string}} filters
 * @param {{query:Function}} pool pool de pg inyectado por el backend
 * @returns {Promise<{report,columns,rows,summary,filters}>}
 */
export async function runReport(entry, filters, pool) {
  const definition = REPORT_DEFINITIONS[entry.slug];
  if (!definition) throw new Error(`Reporte sin definición: ${entry.slug}`);
  const built = definition.build(filters);
  const result = await pool.query(built.sql, built.params);
  const rawRows = result.rows ?? [];
  if (rawRows.length > definition.limit) {
    throw new ApiError(
      413,
      'REPORT_TOO_LARGE',
      `El reporte excede el máximo de ${definition.limit} filas para exportación; ` +
        'acote los filtros (from, to, technician_id, brand) y reintente',
      [{ limit: definition.limit, returned: rawRows.length }],
    );
  }
  const rows = normalizeRows(definition.columns, rawRows);
  const summary = definition.summarize ? definition.summarize(rows) : {};
  return {
    report: entry,
    columns: definition.columns,
    rows,
    summary,
    filters: { ...filters },
  };
}

export { REPORT_DEFINITIONS };
