import express from 'express';
import { query } from '../db/pool.js';
import { asyncHandler } from '../lib/http.js';

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const started = Date.now();
    try {
      await query('SELECT 1');
      res.set('Cache-Control', 'no-store');
      return res.status(200).json({
        data: {
          status: 'ok',
          database: 'up',
          latency_ms: Date.now() - started,
          checked_at: new Date().toISOString(),
        },
      });
    } catch (error) {
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({
        data: {
          status: 'degraded',
          database: 'down',
          latency_ms: Date.now() - started,
          checked_at: new Date().toISOString(),
        },
      });
    }
  }),
);

export default router;
