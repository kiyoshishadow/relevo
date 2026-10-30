/**
 * Validación de filtros de reporte: from/to (fechas de negocio en
 * America/El_Salvador), technician_id y brand. Rechaza fechas imposibles,
 * rangos imposibles e IDs inválidos con 400 VALIDATION_ERROR.
 */
import { ApiError } from './errors.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TECHNICIAN_RE = /^[1-9]\d*$/;

/** Fecha de calendario real (rechaza 2026-02-30, 2026-13-01, etc.). */
export function isCalendarDate(text) {
  if (!DATE_RE.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

export function parseDateParam(raw, field) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const text = String(raw).trim();
  if (!DATE_RE.test(text)) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `Parámetro ${field} inválido: use el formato AAAA-MM-DD`,
    );
  }
  if (!isCalendarDate(text)) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `Parámetro ${field} inválido: la fecha no existe en el calendario`,
    );
  }
  return text;
}

export function parseTechnicianId(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const text = String(raw).trim();
  if (!TECHNICIAN_RE.test(text)) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Parámetro technician_id inválido: debe ser un entero positivo',
    );
  }
  const id = Number(text);
  if (!Number.isSafeInteger(id) || id > Number.MAX_SAFE_INTEGER) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Parámetro technician_id inválido');
  }
  return id;
}

export function parseBrand(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  let text = String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 80) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Parámetro brand demasiado largo');
  }
  return text === '' ? null : text;
}

/**
 * Parses and validates every allowed filter for the report entry.
 * @param {{filters: Array<string|{name:string}>}} entry
 * @param {object} query req.query
 * @returns {{from?:string, to?:string, technician_id?:number, brand?:string}}
 */
export function parseFilters(entry, query = {}) {
  const allowedNames = (entry.filters ?? []).map((filter) =>
    typeof filter === 'string' ? filter : filter.name,
  );
  const filters = {};
  if (allowedNames.includes('from')) {
    const from = parseDateParam(query.from, 'from');
    if (from) filters.from = from;
  }
  if (allowedNames.includes('to')) {
    const to = parseDateParam(query.to, 'to');
    if (to) filters.to = to;
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Rango imposible: from no puede ser posterior a to',
    );
  }
  if (allowedNames.includes('technician_id')) {
    const technicianId = parseTechnicianId(query.technician_id);
    if (technicianId !== null) filters.technician_id = technicianId;
  }
  if (allowedNames.includes('brand')) {
    const brand = parseBrand(query.brand);
    if (brand !== null) filters.brand = brand;
  }
  return filters;
}
