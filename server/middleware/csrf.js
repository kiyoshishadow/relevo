import { ApiError } from '../lib/http.js';
import { safeEqualText } from '../domain/tokens.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_MUTATIONS = new Set(['/api/track']);

/**
 * CSRF basado en token ligado a la sesión persistente. /api/track es una
 * consulta pública con token propio e idempotente, por lo que no exige CSRF;
 * sí está limitada por tasa.
 */
export function csrfProtection(req, _res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  // req.path es relativo al montaje (`/api`), por eso se usa la URL original.
  const fullPath = (req.originalUrl || req.url || '').split('?')[0];
  if (PUBLIC_MUTATIONS.has(fullPath)) return next();

  if (!req.session) {
    return next(
      new ApiError(
        403,
        'CSRF_SESSION_REQUIRED',
        'Solicite /api/auth/csrf y envíe la cookie de sesión junto con X-CSRF-Token',
      ),
    );
  }

  const header = req.get('X-CSRF-Token');
  if (!header || !safeEqualText(header, req.session.csrfToken)) {
    return next(new ApiError(403, 'CSRF_INVALID', 'Token CSRF inválido o ausente'));
  }

  return next();
}
