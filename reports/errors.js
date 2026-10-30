/** Errores de API con la forma del contrato {error:{code,message,details?}}. */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Envuelve handlers asíncronos para Express 4/5. */
export function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Middleware final del router: nunca filtra mensajes internos. */
export function reportsErrorMiddleware(error, _req, res, next) {
  if (error instanceof ApiError) {
    const body = { error: { code: error.code, message: error.message } };
    if (error.details !== undefined) body.error.details = error.details;
    return res.status(error.status).json(body);
  }
  // Los guards inyectados pertenecen al servidor y usan su propia clase
  // ApiError. El manejador del host debe conservar sus estados y ocultar
  // cualquier error interno; este router solo serializa sus propios errores.
  return next(error);
}
