import express from 'express';
import { query, withTransaction } from '../db/pool.js';
import { todayIso } from '../domain/coverage.js';
import {
  ApiError,
  asyncHandler,
  clientIp,
  iso,
  ok,
  parseIdQuery,
  parsePagination,
  searchTerm,
} from '../lib/http.js';
import { terminalCreateSchema, validateBody } from '../validation/schemas.js';
import { writeAudit } from '../services/audit.js';

const router = express.Router();

function serializeTerminal(row) {
  return {
    id: row.id,
    client_id: row.client_id,
    client: row.client_name ? { id: row.client_id, full_name: row.client_name } : undefined,
    brand: row.brand,
    model: row.model,
    imeis: row.imeis || [],
    purchase_date: row.purchase_date,
    accessories: row.accessories,
    initial_condition: row.initial_condition,
    coverage_id: row.coverage_id,
    coverage: row.coverage_name
      ? {
          id: row.coverage_id,
          name: row.coverage_name,
          plan: row.coverage_plan,
          months: row.coverage_months,
          replacement_policy: row.coverage_replacement_policy,
        }
      : null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query);
    const q = searchTerm(req.query.q);
    const clientId = parseIdQuery(req.query.client_id, 'client_id');
    const coverageId = parseIdQuery(req.query.coverage_id, 'coverage_id');
    const where = [];
    const params = [];
    if (clientId) {
      params.push(clientId);
      where.push(`t.client_id = $${params.length}`);
    }
    if (coverageId) {
      params.push(coverageId);
      where.push(`t.coverage_id = $${params.length}`);
    }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`(lower(t.brand || ' ' || t.model) LIKE $${params.length}
        OR lower(c.full_name) LIKE $${params.length}
        OR EXISTS (SELECT 1 FROM terminal_imeis i WHERE i.terminal_id = t.id AND i.imei LIKE $${params.length}))`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      await query(
        `SELECT count(*)::int AS total FROM terminals t JOIN clients c ON c.id = t.client_id ${whereSql}`,
        params,
      )
    ).rows[0].total;
    const listParams = [...params, pageSize, offset];
    const { rows } = await query(
      `SELECT t.*, c.full_name AS client_name,
              cov.name AS coverage_name, cov.plan AS coverage_plan,
              cov.months AS coverage_months, cov.replacement_policy AS coverage_replacement_policy,
              COALESCE(
                (SELECT json_agg(i.imei ORDER BY i.imei) FROM terminal_imeis i WHERE i.terminal_id = t.id),
                '[]'::json
              ) AS imeis
         FROM terminals t
         JOIN clients c ON c.id = t.client_id
         LEFT JOIN coverages cov ON cov.id = t.coverage_id
         ${whereSql}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );
    return ok(res, rows.map(serializeTerminal), 200, { total, page, pageSize });
  }),
);

router.post(
  '/',
  validateBody(terminalCreateSchema),
  asyncHandler(async (req, res) => {
    if (!['admin', 'reception'].includes(req.user.role)) {
      throw new ApiError(403, 'FORBIDDEN', 'Solo recepción o administración pueden crear terminales');
    }
    if (req.body.purchase_date > todayIso()) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'La fecha de compra no puede ser futura');
    }

    const created = await withTransaction(async (client) => {
      const clientRow = (
        await client.query('SELECT id, active FROM clients WHERE id = $1', [req.body.client_id])
      ).rows[0];
      if (!clientRow) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Cliente no encontrado');
      if (!clientRow.active) throw new ApiError(409, 'CLIENT_INACTIVE', 'El cliente está inactivo');

      if (req.body.coverage_id) {
        const coverage = (
          await client.query('SELECT id, active, brand FROM coverages WHERE id = $1 FOR SHARE', [
            req.body.coverage_id,
          ])
        ).rows[0];
        if (!coverage) throw new ApiError(404, 'COVERAGE_NOT_FOUND', 'Cobertura no encontrada');
        if (!coverage.active) throw new ApiError(409, 'COVERAGE_INACTIVE', 'La cobertura está inactiva');
        if (
          coverage.brand !== null &&
          String(coverage.brand).trim().toLowerCase() !== req.body.brand.trim().toLowerCase()
        ) {
          throw new ApiError(
            409,
            'COVERAGE_BRAND_MISMATCH',
            'La cobertura seleccionada no corresponde a la marca del terminal',
            [{ path: ['coverage_id'], message: 'Seleccione una cobertura global o de la misma marca' }],
          );
        }
      }

      const imeis = req.body.imeis || [];
      if (imeis.length > 0) {
        const existing = await client.query(
          'SELECT imei FROM terminal_imeis WHERE imei = ANY($1::text[])',
          [imeis],
        );
        if (existing.rows.length > 0) {
          throw new ApiError(409, 'IMEI_DUPLICATE', 'Uno o más IMEI ya están registrados', {
            imeis: existing.rows.map((row) => row.imei),
          });
        }
      }

      const terminal = (
        await client.query(
          `INSERT INTO terminals
             (client_id, brand, model, purchase_date, accessories, initial_condition, coverage_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            req.body.client_id,
            req.body.brand,
            req.body.model,
            req.body.purchase_date,
            req.body.accessories || '',
            req.body.initial_condition,
            req.body.coverage_id || null,
          ],
        )
      ).rows[0];

      for (const imei of imeis) {
        await client.query('INSERT INTO terminal_imeis (terminal_id, imei) VALUES ($1, $2)', [
          terminal.id,
          imei,
        ]);
      }

      await writeAudit(client, {
        actorId: req.user.id,
        action: 'terminal.create',
        entityType: 'terminal',
        entityId: terminal.id,
        details: { brand: terminal.brand, model: terminal.model, imeis },
        ip: clientIp(req),
      });
      return { ...terminal, imeis };
    });

    return ok(res, serializeTerminal(created), 201);
  }),
);

export default router;
