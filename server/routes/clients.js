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
import { clientCreateSchema, clientPatchSchema, validateBody } from '../validation/schemas.js';
import { writeAudit } from '../services/audit.js';

const router = express.Router();

function serializeClient(row) {
  return {
    id: row.id,
    full_name: row.full_name,
    document_id: row.document_id,
    phone: row.phone,
    email: row.email,
    address: row.address,
    active: row.active,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    ...(row.terminal_count !== undefined ? { terminal_count: row.terminal_count } : {}),
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query);
    const q = searchTerm(req.query.q);
    const active = parseOptionalBoolean(req.query.active);
    const where = [];
    const params = [];

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`(lower(c.full_name) LIKE $${params.length}
        OR lower(COALESCE(c.document_id, '')) LIKE $${params.length}
        OR lower(c.phone) LIKE $${params.length}
        OR lower(c.email) LIKE $${params.length})`);
    }
    if (active !== undefined) {
      params.push(active);
      where.push(`c.active = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      await query(`SELECT count(*)::int AS total FROM clients c ${whereSql}`, params)
    ).rows[0].total;
    const listParams = [...params, pageSize, offset];
    const { rows } = await query(
      `SELECT c.*, (SELECT count(*)::int FROM terminals t WHERE t.client_id = c.id) AS terminal_count
         FROM clients c ${whereSql}
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );
    return ok(res, rows.map(serializeClient), 200, { total, page, pageSize });
  }),
);

router.post(
  '/',
  validateBody(clientCreateSchema),
  asyncHandler(async (req, res) => {
    if (!['admin', 'reception'].includes(req.user.role)) {
      throw new ApiError(403, 'FORBIDDEN', 'Solo recepción o administración pueden crear clientes');
    }
    const created = await withTransaction(async (client) => {
      let row;
      try {
        row = (
          await client.query(
            `INSERT INTO clients (full_name, document_id, phone, email, address, active)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [
              req.body.full_name,
              req.body.document_id ?? null,
              req.body.phone,
              req.body.email,
              req.body.address ?? null,
              req.body.active ?? true,
            ],
          )
        ).rows[0];
      } catch (error) {
        if (error.code === '23505') {
          throw new ApiError(409, 'DOCUMENT_DUPLICATE', 'El documento ya está registrado');
        }
        throw error;
      }
      await writeAudit(client, {
        actorId: req.user.id,
        action: 'client.create',
        entityType: 'client',
        entityId: row.id,
        details: { full_name: row.full_name },
        ip: clientIp(req),
      });
      return row;
    });
    return ok(res, serializeClient(created), 201);
  }),
);

router.patch(
  '/:id',
  validateBody(clientPatchSchema),
  asyncHandler(async (req, res) => {
    if (!['admin', 'reception'].includes(req.user.role)) {
      throw new ApiError(403, 'FORBIDDEN', 'Solo recepción o administración pueden editar clientes');
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ApiError(400, 'VALIDATION_ERROR', 'id inválido');

    const allowed = ['full_name', 'document_id', 'phone', 'email', 'address', 'active'];
    const fields = [];
    const params = [];
    for (const key of allowed) {
      if (Object.hasOwn(req.body, key)) {
        params.push(req.body[key]);
        fields.push(`${key} = $${params.length}`);
      }
    }
    params.push(id);
    const updated = await withTransaction(async (client) => {
      let row;
      try {
        row = (
          await client.query(
            `UPDATE clients SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
            params,
          )
        ).rows[0];
      } catch (error) {
        if (error.code === '23505') {
          throw new ApiError(409, 'DOCUMENT_DUPLICATE', 'El documento ya está registrado');
        }
        throw error;
      }
      if (!row) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Cliente no encontrado');
      await writeAudit(client, {
        actorId: req.user.id,
        action: 'client.update',
        entityType: 'client',
        entityId: id,
        details: { fields: Object.keys(req.body) },
        ip: clientIp(req),
      });
      return row;
    });
    return ok(res, serializeClient(updated));
  }),
);

export default router;
