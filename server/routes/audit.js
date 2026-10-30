import express from 'express';
import { query } from '../db/pool.js';
import { asyncHandler, ok, parsePagination, searchTerm, ApiError } from '../lib/http.js';
import { requireRole } from '../middleware/session.js';
import { serializeAudit } from '../services/audit.js';

const router = express.Router();
router.use(requireRole('admin'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query);
    const q = searchTerm(req.query.q);
    const action = searchTerm(req.query.action);
    const entityType = searchTerm(req.query.entity_type);
    const actorId = searchTerm(req.query.actor_id);
    const from = searchTerm(req.query.from);
    const to = searchTerm(req.query.to);
    const where = [];
    const params = [];

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`(lower(a.action) LIKE $${params.length}
        OR lower(a.entity_type) LIKE $${params.length}
        OR lower(COALESCE(a.entity_id, '')) LIKE $${params.length})`);
    }
    if (action) {
      params.push(action);
      where.push(`a.action = $${params.length}`);
    }
    if (entityType) {
      params.push(entityType);
      where.push(`a.entity_type = $${params.length}`);
    }
    if (actorId) {
      const numeric = Number(actorId);
      if (!Number.isInteger(numeric) || numeric < 1) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'actor_id inválido');
      }
      params.push(numeric);
      where.push(`a.actor_id = $${params.length}`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      params.push(from);
      where.push(`a.created_at >= $${params.length}::date`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      params.push(to);
      where.push(`a.created_at < ($${params.length}::date + interval '1 day')`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      await query(`SELECT count(*)::int AS total FROM audit_log a ${whereSql}`, params)
    ).rows[0].total;
    const listParams = [...params, pageSize, offset];
    const { rows } = await query(
      `SELECT a.*, u.full_name AS actor_full_name, u.email AS actor_email, u.role AS actor_role
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         ${whereSql}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );
    return ok(res, rows.map(serializeAudit), 200, { total, page, pageSize });
  }),
);

export default router;
