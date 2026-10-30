import express from 'express';
import { query } from '../db/pool.js';
import {
  ApiError,
  asyncHandler,
  clientIp,
  ok,
  parsePagination,
  searchTerm,
} from '../lib/http.js';
import { requireRole } from '../middleware/session.js';
import {
  processOutbox,
  serializeNotification,
} from '../services/notifications.js';
import { writeAudit } from '../services/audit.js';

const router = express.Router();
router.use(requireRole('admin', 'reception'));

const STATUSES = new Set(['pending', 'sending', 'sent', 'failed']);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query);
    const status = searchTerm(req.query.status);
    if (status && !STATUSES.has(status)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'status inválido');
    }
    const q = searchTerm(req.query.q);
    const where = [];
    const params = [];
    if (status) {
      params.push(status);
      where.push(`o.status = $${params.length}`);
    }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`(lower(o.recipient) LIKE $${params.length}
        OR lower(o.subject) LIKE $${params.length}
        OR lower(COALESCE(c.case_number, '')) LIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      await query(
        `SELECT count(*)::int AS total
           FROM notification_outbox o LEFT JOIN cases c ON c.id = o.case_id ${whereSql}`,
        params,
      )
    ).rows[0].total;
    const listParams = [...params, pageSize, offset];
    const { rows } = await query(
      `SELECT o.*, c.case_number
         FROM notification_outbox o LEFT JOIN cases c ON c.id = o.case_id
         ${whereSql}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );
    return ok(res, rows.map((row) => serializeNotification(row)), 200, {
      total,
      page,
      pageSize,
    });
  }),
);

router.post(
  '/process',
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      throw new ApiError(403, 'FORBIDDEN', 'Solo administración puede procesar la bandeja');
    }
    const result = await processOutbox({ limit: 25 });
    await writeAudit(null, {
      actorId: req.user.id,
      action: 'notification.process',
      entityType: 'notification_outbox',
      details: result,
      ip: clientIp(req),
    });
    return ok(res, result);
  }),
);

export default router;
