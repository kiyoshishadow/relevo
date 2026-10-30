import express from 'express';
import { asyncHandler, ok } from '../lib/http.js';
import { getDashboard } from '../services/dashboard.js';

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    return ok(res, await getDashboard(req.user));
  }),
);

export default router;
