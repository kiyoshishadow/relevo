import express from 'express';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { generateCsrfToken, generateSessionId, safeEqualText } from '../domain/tokens.js';
import { ApiError, asyncHandler, clientIp, ok } from '../lib/http.js';
import { loginSchema, validateBody } from '../validation/schemas.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import {
  clearSessionCookie,
  establishLoginSession,
  requireAuth,
  serializeUser,
  setSessionCookie,
} from '../middleware/session.js';
import { writeAudit } from '../services/audit.js';

const router = express.Router();

// Hash válido para comparar también cuando el correo no existe y reducir
// diferencias de tiempo. No corresponde a ninguna cuenta.
const DUMMY_HASH = '$2b$10$lNrQpmt5t8oY35/G22BHH.hDHJz1TZxe7rgAgutWla77eKMnKrkmi';

const loginLimiter = createRateLimiter({
  windowMs: config.loginRateWindowMinutes * 60 * 1000,
  max: config.loginRateLimit,
  code: 'LOGIN_RATE_LIMITED',
  message: 'Demasiados intentos de inicio de sesión. Intente más tarde.',
});

router.get(
  '/csrf',
  asyncHandler(async (req, res) => {
    let sessionId = req.session?.id;
    let csrfToken = req.session?.csrfToken;

    if (!sessionId) {
      sessionId = generateSessionId();
      csrfToken = generateCsrfToken();
      await query(
        `INSERT INTO sessions (id, csrf_token, expires_at, user_agent, ip)
         VALUES ($1, $2, now() + ($3::int * interval '1 minute'), $4, $5)`,
        [
          sessionId,
          csrfToken,
          config.sessionTtlMinutes,
          req.get('User-Agent')?.slice(0, 500) || null,
          clientIp(req),
        ],
      );
      setSessionCookie(res, sessionId);
    }

    return ok(res, {
      csrfToken,
      expires_in_seconds: config.sessionTtlMinutes * 60,
    });
  }),
);

router.post(
  '/login',
  loginLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    if (!req.session) {
      throw new ApiError(
        403,
        'CSRF_SESSION_REQUIRED',
        'Solicite /api/auth/csrf antes de iniciar sesión',
      );
    }

    const { rows } = await query(
      `SELECT id, email, full_name, role, password_hash, active, created_at, updated_at
         FROM users WHERE lower(email) = lower($1)`,
      [req.body.email],
    );
    const user = rows[0];
    const valid = await bcrypt.compare(req.body.password, user?.password_hash || DUMMY_HASH);
    if (!user || !user.active || !valid) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos');
    }

    const newCsrf = generateCsrfToken();
    const oldSessionId = req.session.id;
    const newSessionId = generateSessionId();
    const authenticatedUser = await withTransaction((client) => establishLoginSession(client, {
      candidateUser: user,
      previousId: oldSessionId,
      nextId: newSessionId,
      csrfToken: newCsrf,
      ttlMinutes: config.sessionTtlMinutes,
      userAgent: req.get('User-Agent')?.slice(0, 500) || null,
      ip: clientIp(req),
      writeLoginAudit: (db, currentUser) => writeAudit(db, {
        actorId: currentUser.id,
        action: 'auth.login',
        entityType: 'user',
        entityId: currentUser.id,
        ip: clientIp(req),
      }),
    }));
    req.session.id = newSessionId;
    req.session.userId = authenticatedUser.id;
    req.session.csrfToken = newCsrf;
    req.user = serializeUser(authenticatedUser);
    setSessionCookie(res, newSessionId);

    return ok(res, { user: serializeUser(authenticatedUser), csrfToken: newCsrf });
  }),
);

router.get('/me', requireAuth, (req, res) => {
  return ok(res, { user: req.user, csrfToken: req.session.csrfToken });
});

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await query('DELETE FROM sessions WHERE id = $1', [req.session.id]);
    clearSessionCookie(res);
    await writeAudit(null, {
      actorId: req.user.id,
      action: 'auth.logout',
      entityType: 'user',
      entityId: req.user.id,
      ip: clientIp(req),
    });
    return ok(res, { logged_out: true });
  }),
);

export default router;
