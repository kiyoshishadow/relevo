import express from 'express';
import { query, withTransaction } from '../db/pool.js';
import {
  ApiError,
  asyncHandler,
  clientIp,
  iso,
  ok,
  parseOptionalBoolean,
  parsePagination,
  searchTerm,
} from '../lib/http.js';
import {
  coverageCreateSchema,
  coveragePatchSchema,
  validateBody,
} from '../validation/schemas.js';
import { writeAudit } from '../services/audit.js';

const router = express.Router();

function serializeCoverage(row) {
  return {
    id: row.id,
    brand: row.brand,
    name: row.name,
    plan: row.plan,
    months: row.months,
    exclusions: row.exclusions,
    replacement_policy: row.replacement_policy,
    active: row.active,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query);
    const q = searchTerm(req.query.q);
    const brand = searchTerm(req.query.brand);
    const active = parseOptionalBoolean(req.query.active);
    const where = [];
    const params = [];
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`(lower(name) LIKE $${params.length} OR lower(plan) LIKE $${params.length})`);
    }
    if (brand) {
      params.push(brand.toLowerCase());
      where.push(`lower(COALESCE(brand, '')) = $${params.length}`);
    }
    if (active !== undefined) {
      params.push(active);
      where.push(`active = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      await query(`SELECT count(*)::int AS total FROM coverages ${whereSql}`, params)
    ).rows[0].total;
    const listParams = [...params, pageSize, offset];
    const { rows } = await query(
      `SELECT * FROM coverages ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );
    return ok(res, rows.map(serializeCoverage), 200, { total, page, pageSize });
  }),
);

router.post(
  '/',
  validateBody(coverageCreateSchema),
  asyncHandler(async (req, res) => {
    if (!['admin', 'reception'].includes(req.user.role)) {
      throw new ApiError(403, 'FORBIDDEN', 'Solo recepción o administración pueden crear coberturas');
    }
    const created = await withTransaction(async (client) => {
      const row = (
        await client.query(
          `INSERT INTO coverages
             (brand, name, plan, months, exclusions, replacement_policy, active)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           RETURNING *`,
          [
            req.body.brand ?? null,
            req.body.name,
            req.body.plan,
            req.body.months,
            JSON.stringify(req.body.exclusions || []),
            req.body.replacement_policy,
            req.body.active ?? true,
          ],
        )
      ).rows[0];
      await writeAudit(client, {
        actorId: req.user.id,
        action: 'coverage.create',
        entityType: 'coverage',
        entityId: row.id,
        details: { name: row.name, plan: row.plan, months: row.months },
        ip: clientIp(req),
      });
      return row;
    });
    return ok(res, serializeCoverage(created), 201);
  }),
);

router.patch(
  '/:id',
  validateBody(coveragePatchSchema),
  asyncHandler(async (req, res) => {
    if (!['admin', 'reception'].includes(req.user.role)) {
      throw new ApiError(403, 'FORBIDDEN', 'Solo recepción o administración pueden editar coberturas');
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ApiError(400, 'VALIDATION_ERROR', 'id inválido');

    const jsonFields = new Set(['exclusions']);
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(req.body)) {
      params.push(jsonFields.has(key) ? JSON.stringify(value) : value);
      fields.push(`${key} = $${params.length}${jsonFields.has(key) ? '::jsonb' : ''}`);
    }
    params.push(id);
    const updated = await withTransaction(async (client) => {
      const row = (
        await client.query(
          `UPDATE coverages SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
          params,
        )
      ).rows[0];
      if (!row) throw new ApiError(404, 'COVERAGE_NOT_FOUND', 'Cobertura no encontrada');
      await writeAudit(client, {
        actorId: req.user.id,
        action: 'coverage.update',
        entityType: 'coverage',
        entityId: id,
        details: { fields: Object.keys(req.body) },
        ip: clientIp(req),
      });
      return row;
    });
    return ok(res, serializeCoverage(updated));
  }),
);

export default router;
