import express from 'express';
import { clientIp, parsePagination, searchTerm, ok, asyncHandler } from '../lib/http.js';
import { requireRole } from '../middleware/session.js';
import {
  createLoanDevice,
  listLoanDevices,
} from '../services/loans.js';
import { loanDeviceCreateSchema, validateBody } from '../validation/schemas.js';

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query);
    const status = searchTerm(req.query.status);
    if (status && !['available', 'loaned', 'retired'].includes(status)) {
      const { ApiError } = await import('../lib/http.js');
      throw new ApiError(400, 'VALIDATION_ERROR', 'status inválido');
    }
    const result = await listLoanDevices({
      q: searchTerm(req.query.q),
      status: status || undefined,
      page,
      pageSize,
      offset,
    });
    return ok(res, result.data, 200, result.meta);
  }),
);

router.post(
  '/',
  requireRole('admin', 'reception'),
  validateBody(loanDeviceCreateSchema),
  asyncHandler(async (req, res) => {
    const created = await createLoanDevice(req.user, req.body, { ip: clientIp(req) });
    return ok(res, created, 201);
  }),
);

export default router;
