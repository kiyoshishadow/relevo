import express from 'express';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../db/pool.js';
import {
  ApiError,
  asyncHandler,
  clientIp,
  ok,
  parseId,
  parseOptionalBoolean,
  parsePagination,
  searchTerm,
} from '../lib/http.js';
import { clearSessionCookie, requireRole, serializeUser } from '../middleware/session.js';
import {
  userCreateSchema,
  userPatchSchema,
  validateBody,
} from '../validation/schemas.js';
import { writeAudit } from '../services/audit.js';

const router = express.Router();
router.use(requireRole('admin'));

// Serializa cambios que alteran el conjunto de administradores activos.
// La pareja namespace/key es estable y compartida por todos los PATCH de usuarios.
const ADMIN_MEMBERSHIP_LOCK_NAMESPACE = 0x55534552; // "USER"
const ADMIN_MEMBERSHIP_LOCK_KEY = 1;

export async function lockAndRequireActiveAdmin(client, actorId) {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
    ADMIN_MEMBERSHIP_LOCK_NAMESPACE,
    ADMIN_MEMBERSHIP_LOCK_KEY,
  ]);
  const actor = (await client.query('SELECT role, active FROM users WHERE id = $1', [actorId])).rows[0];
  if (!actor || !actor.active || actor.role !== 'admin') {
    throw new ApiError(403, 'FORBIDDEN', 'No tiene permiso para esta operación');
  }
  return actor;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query);
    const q = searchTerm(req.query.q);
    const role = searchTerm(req.query.role);
    const active = parseOptionalBoolean(req.query.active);
    const where = [];
    const params = [];
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`(lower(email) LIKE $${params.length} OR lower(full_name) LIKE $${params.length})`);
    }
    if (role) {
      params.push(role);
      where.push(`role = $${params.length}`);
    }
    if (active !== undefined) {
      params.push(active);
      where.push(`active = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      await query(`SELECT count(*)::int AS total FROM users ${whereSql}`, params)
    ).rows[0].total;
    const listParams = [...params, pageSize, offset];
    const { rows } = await query(
      `SELECT id, email, full_name, role, active, created_at, updated_at
         FROM users ${whereSql}
        ORDER BY full_name
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );
    return ok(res, rows.map(serializeUser), 200, { total, page, pageSize });
  }),
);

router.post(
  '/',
  validateBody(userCreateSchema),
  asyncHandler(async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 12);
    const result = await withTransaction(async (client) => {
      let row;
      try {
        row = (
          await client.query(
            `INSERT INTO users (email, full_name, role, password_hash, active)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, email, full_name, role, active, created_at, updated_at`,
            [req.body.email, req.body.full_name, req.body.role, hash, req.body.active ?? true],
          )
        ).rows[0];
      } catch (error) {
        if (error.code === '23505') {
          throw new ApiError(409, 'EMAIL_DUPLICATE', 'El correo ya está registrado');
        }
        throw error;
      }
      await writeAudit(client, {
        actorId: req.user.id,
        action: 'user.create',
        entityType: 'user',
        entityId: row.id,
        details: { email: row.email, role: row.role },
        ip: clientIp(req),
      });
      return row;
    });
    return ok(res, serializeUser(result), 201);
  }),
);

router.patch(
  '/:id',
  validateBody(userPatchSchema),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const passwordHash = Object.hasOwn(req.body, 'password')
      ? await bcrypt.hash(req.body.password, 12)
      : null;
    const result = await withTransaction(async (client) => {
      await lockAndRequireActiveAdmin(client, req.user.id);
      const target = (await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]))
        .rows[0];
      if (!target) throw new ApiError(404, 'USER_NOT_FOUND', 'Usuario no encontrado');

      if (id === req.user.id && req.body.active === false) {
        throw new ApiError(409, 'CANNOT_DEACTIVATE_SELF', 'No puede desactivar su propia cuenta');
      }

      const wasActiveAdmin = target.role === 'admin' && target.active === true;
      const resultingRole = Object.hasOwn(req.body, 'role') ? req.body.role : target.role;
      const resultingActive = Object.hasOwn(req.body, 'active') ? req.body.active : target.active;
      const removingAdmin = wasActiveAdmin && !(resultingRole === 'admin' && resultingActive === true);
      if (removingAdmin) {
        const remaining = (
          await client.query(
            `SELECT count(*)::int AS count FROM users
              WHERE role = 'admin' AND active = true AND id <> $1`,
            [id],
          )
        ).rows[0].count;
        if (remaining === 0) {
          throw new ApiError(409, 'LAST_ADMIN', 'Debe quedar al menos un administrador activo');
        }
      }

      const fields = [];
      const params = [];
      for (const key of ['email', 'full_name', 'role', 'active']) {
        if (Object.hasOwn(req.body, key)) {
          params.push(req.body[key]);
          fields.push(`${key} = $${params.length}`);
        }
      }
      if (Object.hasOwn(req.body, 'password')) {
        params.push(passwordHash);
        fields.push(`password_hash = $${params.length}`);
      }
      params.push(id);
      let row;
      try {
        row = (
          await client.query(
            `UPDATE users SET ${fields.join(', ')} WHERE id = $${params.length}
             RETURNING id, email, full_name, role, active, created_at, updated_at`,
            params,
          )
        ).rows[0];
      } catch (error) {
        if (error.code === '23505') {
          throw new ApiError(409, 'EMAIL_DUPLICATE', 'El correo ya está registrado');
        }
        throw error;
      }
      if (Object.hasOwn(req.body, 'password')) {
        // Changing anyone's password revokes all their sessions. A self-change
        // also clears this browser's cookie after commit and requires a fresh login.
        await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      }
      await writeAudit(client, {
        actorId: req.user.id,
        action: 'user.update',
        entityType: 'user',
        entityId: id,
        details: { fields: Object.keys(req.body) },
        ip: clientIp(req),
      });
      return row;
    });
    if (Object.hasOwn(req.body, 'password') && id === req.user.id) clearSessionCookie(res);
    return ok(res, serializeUser(result));
  }),
);

export default router;
