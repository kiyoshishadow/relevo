import { config } from '../config.js';
import { query } from '../db/pool.js';
import { ApiError, iso } from '../lib/http.js';

export function serializeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    active: row.active,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/** Replaces a session row inside the caller's transaction; the old ID dies before auth is stored. */
export async function replaceSessionRecord(client, {
  previousId,
  nextId,
  userId,
  csrfToken,
  ttlMinutes,
  userAgent,
  ip,
}) {
  const deleted = await client.query(
    'DELETE FROM sessions WHERE id = $1 RETURNING id',
    [previousId],
  );
  if (!deleted.rowCount) {
    throw new ApiError(403, 'CSRF_SESSION_EXPIRED', 'La sesión expiró; solicite un nuevo token CSRF');
  }
  await client.query(
    `INSERT INTO sessions (id, user_id, csrf_token, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, now() + ($4::int * interval '1 minute'), $5, $6)`,
    [nextId, userId, csrfToken, ttlMinutes, userAgent, ip],
  );
}

/** Locks the user after bcrypt verification so changes made during hashing invalidate the login. */
export async function establishLoginSession(client, {
  candidateUser,
  previousId,
  nextId,
  csrfToken,
  ttlMinutes,
  userAgent,
  ip,
  writeLoginAudit,
}) {
  const { rows } = await client.query(
    `SELECT id, email, full_name, role, password_hash, active, created_at, updated_at
       FROM users WHERE id = $1 FOR UPDATE`,
    [candidateUser.id],
  );
  const currentUser = rows[0];
  if (!currentUser?.active || currentUser.password_hash !== candidateUser.password_hash) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos');
  }

  await replaceSessionRecord(client, {
    previousId,
    nextId,
    userId: currentUser.id,
    csrfToken,
    ttlMinutes,
    userAgent,
    ip,
  });
  await writeLoginAudit(client, currentUser);
  return currentUser;
}

export function setSessionCookie(res, sessionId) {
  res.cookie(config.cookieName, sessionId, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionTtlMinutes * 60 * 1000,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
  });
}

/** Carga la sesión persistente de PostgreSQL en cada petición /api. */
export async function attachSession(req, res, next) {
  try {
    const sessionId = req.cookies?.[config.cookieName];
    if (!sessionId) return next();

    const { rows } = await query(
      `SELECT s.id, s.user_id, s.csrf_token, s.expires_at, s.last_seen_at,
              u.id AS u_id, u.email, u.full_name, u.role, u.active,
              u.created_at AS u_created_at, u.updated_at AS u_updated_at
         FROM sessions s
         LEFT JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [sessionId],
    );
    const row = rows[0];
    if (!row) {
      clearSessionCookie(res);
      return next();
    }
    if (row.user_id && !row.active) {
      await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      clearSessionCookie(res);
      return next();
    }

    req.session = {
      id: row.id,
      userId: row.user_id,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
    };
    req.user = row.user_id
      ? serializeUser({
          id: row.u_id,
          email: row.email,
          full_name: row.full_name,
          role: row.role,
          active: row.active,
          created_at: row.u_created_at,
          updated_at: row.u_updated_at,
        })
      : null;

    await query(
      `UPDATE sessions
          SET last_seen_at = now(),
              expires_at = now() + ($2::int * interval '1 minute')
        WHERE id = $1
          AND last_seen_at < now() - interval '2 minutes'`,
      [sessionId, config.sessionTtlMinutes],
    );

    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireAuth(req, _res, next) {
  if (!req.user) {
    return next(new ApiError(401, 'AUTH_REQUIRED', 'Debe iniciar sesión'));
  }
  return next();
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'AUTH_REQUIRED', 'Debe iniciar sesión'));
    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, 'FORBIDDEN', 'No tiene permiso para esta operación'));
    }
    return next();
  };
}
