export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function ok(res, data, status = 200, meta) {
  const body = { data };
  if (meta !== undefined) body.meta = meta;
  return res.status(status).json(body);
}

export function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function parsePagination(query = {}, { defaultPageSize = 20, maxPageSize = 100 } = {}) {
  const page = parsePositiveInteger(query.page, 1, 'page');
  const pageSize = parsePositiveInteger(query.pageSize, defaultPageSize, 'pageSize');
  if (pageSize > maxPageSize) {
    throw new ApiError(400, 'VALIDATION_ERROR', `pageSize no puede superar ${maxPageSize}`, [
      { path: ['pageSize'], message: `Máximo ${maxPageSize}` },
    ]);
  }
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function parsePositiveInteger(value, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Parámetro ${field} inválido`, [
      { path: [field], message: 'Debe ser un entero mayor o igual a 1' },
    ]);
  }
  return number;
}

export function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (['1', 'true', 'yes'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false', 'no'].includes(String(value).toLowerCase())) return false;
  throw new ApiError(400, 'VALIDATION_ERROR', 'Valor booleano inválido');
}

export function parseId(value, field = 'id') {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} inválido`);
  }
  return number;
}

export function parseIdQuery(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  return parseId(value, field);
}

export function searchTerm(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function nowIso() {
  return new Date().toISOString();
}

export function assertRole(user, roles, message = 'No tiene permiso para esta operación') {
  if (!user || !roles.includes(user.role)) {
    throw new ApiError(403, 'FORBIDDEN', message);
  }
}
