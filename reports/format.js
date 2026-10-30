/**
 * Formato y zona horaria de negocio.
 * Fechas de negocio e identificadores de rango se interpretan/calculan en
 * America/El_Salvador (CST, UTC-6, sin horario de verano). Las fechas de
 * marca de tiempo (timestamptz) se serializan en ISO UTC por el contrato.
 */
export const TZ = 'America/El_Salvador';

export function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Centavos enteros -> "1,234.56" (centavos/100). Nunca suma flotante. */
export function fmtCents(cents) {
  const number = typeof cents === 'string' ? Number(cents) : cents;
  if (!Number.isFinite(number)) return '';
  return (number / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** 'AAAA-MM-DD' -> 'DD/MM/AAAA'. */
export function fmtDate(value) {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  if (value instanceof Date) {
    return new Intl.DateTimeFormat('es-ES', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(value);
  }
  return String(value);
}

/** Date o ISO UTC -> 'DD/MM/AAAA HH:mm' en hora de El Salvador. */
export function fmtDateTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  let text = new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return text.replace(', ', ' ');
}

/** Texto de celda según el tipo de columna para exportaciones. */
export function cellText(value, type) {
  if (value === null || value === undefined || value === '') return '';
  switch (type) {
    case 'cents':
      return fmtCents(value);
    case 'date':
      return fmtDate(value);
    case 'datetime':
      return fmtDateTime(value);
    case 'boolean':
      return value ? 'Sí' : 'No';
    default:
      return String(value);
  }
}
