import express from 'express';
import { config } from '../config.js';
import { asyncHandler, ok } from '../lib/http.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { trackSchema, validateBody } from '../validation/schemas.js';
import { getPublicTracking } from '../services/cases.js';

const router = express.Router();

const trackLimiter = createRateLimiter({
  windowMs: config.trackRateWindowMinutes * 60 * 1000,
  max: config.trackRateLimit,
  code: 'TRACK_RATE_LIMITED',
  message: 'Demasiadas consultas de seguimiento. Intente más tarde.',
});

router.post(
  '/',
  trackLimiter,
  validateBody(trackSchema),
  asyncHandler(async (req, res) => {
    const result = await getPublicTracking(req.body.case_number, req.body.token);
    res.set('Cache-Control', 'no-store');
    return ok(res, result);
  }),
);

export default router;
