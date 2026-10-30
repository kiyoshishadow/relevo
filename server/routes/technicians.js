import express from 'express';
import { query } from '../db/pool.js';
import { asyncHandler, ok, parsePagination } from '../lib/http.js';
import { requireRole } from '../middleware/session.js';

const router = express.Router();
router.use(requireRole('admin', 'reception'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query);
    const total = (
      await query(
        "SELECT count(*)::int AS total FROM users WHERE role = 'technician' AND active = true",
      )
    ).rows[0].total;
    const { rows } = await query(
      `SELECT id, full_name
         FROM users
        WHERE role = 'technician' AND active = true
        ORDER BY full_name, id
        LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    );
    return ok(res, rows, 200, { total, page, pageSize });
  }),
);

export default router;
