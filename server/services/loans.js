import { query, withTransaction } from '../db/pool.js';
import { ApiError, iso } from '../lib/http.js';
import { writeAudit } from './audit.js';
import { notifyCase } from './notifications.js';

function assertCaseAccess(actor, row) {
  if (actor.role === 'technician' && row.technician_id !== actor.id) {
    throw new ApiError(403, 'CASE_NOT_ASSIGNED', 'El caso no está asignado a este técnico');
  }
}

export async function listLoanDevices(filters) {
  const { q, page, pageSize, offset } = filters;
  const where = [];
  const params = [];
  if (filters.status) {
    params.push(filters.status);
    where.push(`d.status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(lower(d.asset_tag) LIKE $${params.length}
      OR lower(d.brand || ' ' || d.model) LIKE $${params.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await query(`SELECT count(*)::int AS total FROM loan_devices d ${whereSql}`, params);
  const listParams = [...params, pageSize, offset];
  const { rows } = await query(
    `SELECT d.*, l.id AS loan_id, l.loaned_at,
            c.id AS case_id, c.case_number
       FROM loan_devices d
       LEFT JOIN loans l ON l.loan_device_id = d.id AND l.returned_at IS NULL
       LEFT JOIN cases c ON c.id = l.case_id
       ${whereSql}
       ORDER BY d.asset_tag
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams,
  );
  return {
    data: rows.map((row) => ({
      id: row.id,
      asset_tag: row.asset_tag,
      brand: row.brand,
      model: row.model,
      condition: row.condition,
      notes: row.notes,
      status: row.status,
      active_loan: row.loan_id
        ? {
            id: row.loan_id,
            case_id: row.case_id,
            case_number: row.case_number,
            loaned_at: iso(row.loaned_at),
          }
        : null,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    })),
    meta: { total: count.rows[0].total, page, pageSize },
  };
}

export async function createLoanDevice(actor, input, { ip } = {}) {
  return withTransaction(async (client) => {
    let inserted;
    try {
      inserted = (
        await client.query(
          `INSERT INTO loan_devices (asset_tag, brand, model, condition, notes)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [input.asset_tag, input.brand, input.model, input.condition || '', input.notes || null],
        )
      ).rows[0];
    } catch (error) {
      if (error.code === '23505') {
        throw new ApiError(409, 'ASSET_TAG_DUPLICATE', 'El código de préstamo ya existe');
      }
      throw error;
    }
    await writeAudit(client, {
      actorId: actor.id,
      action: 'loan_device.create',
      entityType: 'loan_device',
      entityId: inserted.id,
      details: { asset_tag: inserted.asset_tag },
      ip,
    });
    return {
      id: inserted.id,
      asset_tag: inserted.asset_tag,
      brand: inserted.brand,
      model: inserted.model,
      condition: inserted.condition,
      status: inserted.status,
      created_at: iso(inserted.created_at),
    };
  });
}

export async function assignLoan(actor, caseId, input, { ip } = {}) {
  return withTransaction(async (client) => {
    const row = (
      await client.query(
        `SELECT c.id, c.case_number, c.status, c.technician_id, cl.email AS client_email
           FROM cases c JOIN clients cl ON cl.id = c.client_id
          WHERE c.id = $1
          FOR UPDATE OF c`,
        [caseId],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, 'CASE_NOT_FOUND', 'Caso no encontrado');
    assertCaseAccess(actor, row);
    if (['delivered', 'cancelled'].includes(row.status)) {
      throw new ApiError(409, 'CASE_CLOSED', 'Un caso cerrado no admite préstamos');
    }

    const existing = (
      await client.query('SELECT id FROM loans WHERE case_id = $1 AND returned_at IS NULL', [caseId])
    ).rows[0];
    if (existing) {
      throw new ApiError(409, 'LOAN_ALREADY_ACTIVE', 'El caso ya tiene un préstamo activo');
    }

    const device = (
      await client.query('SELECT * FROM loan_devices WHERE id = $1 FOR UPDATE', [
        input.loan_device_id,
      ])
    ).rows[0];
    if (!device) throw new ApiError(404, 'LOAN_DEVICE_NOT_FOUND', 'Equipo de préstamo no encontrado');
    if (device.status !== 'available') {
      throw new ApiError(409, 'LOAN_DEVICE_UNAVAILABLE', 'El equipo de préstamo no está disponible');
    }
    const deviceLoan = (
      await client.query(
        'SELECT id FROM loans WHERE loan_device_id = $1 AND returned_at IS NULL',
        [device.id],
      )
    ).rows[0];
    if (deviceLoan) {
      throw new ApiError(409, 'LOAN_DEVICE_UNAVAILABLE', 'El equipo de préstamo ya está prestado');
    }

    const loan = (
      await client.query(
        `INSERT INTO loans (case_id, loan_device_id, condition_out, loaned_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [caseId, device.id, input.condition_out, actor.id],
      )
    ).rows[0];
    await client.query(`UPDATE loan_devices SET status = 'loaned' WHERE id = $1`, [device.id]);

    await notifyCase(client, row, {
      template: 'loan_assigned',
      subject: `Relevo: equipo de préstamo asignado al caso ${row.case_number}`,
      body:
        `Se asignó un equipo de préstamo ${device.brand} ${device.model} ` +
        `(${device.asset_tag}) al caso ${row.case_number}.\n` +
        `Condición de salida: ${input.condition_out}. Debe devolverse para completar la entrega.`,
    });

    await writeAudit(client, {
      actorId: actor.id,
      action: 'loan.assign',
      entityType: 'case',
      entityId: caseId,
      details: { loan_id: loan.id, loan_device_id: device.id, asset_tag: device.asset_tag },
      ip,
    });

    return {
      id: loan.id,
      status: 'active',
      device: { id: device.id, asset_tag: device.asset_tag, brand: device.brand, model: device.model },
      condition_out: loan.condition_out,
      loaned_at: iso(loan.loaned_at),
    };
  });
}

export async function returnLoan(actor, caseId, input, { ip } = {}) {
  return withTransaction(async (client) => {
    const row = (
      await client.query(
        `SELECT c.id, c.case_number, c.status, c.technician_id, cl.email AS client_email
           FROM cases c JOIN clients cl ON cl.id = c.client_id
          WHERE c.id = $1
          FOR UPDATE OF c`,
        [caseId],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, 'CASE_NOT_FOUND', 'Caso no encontrado');
    assertCaseAccess(actor, row);

    const loan = (
      await client.query(
        `SELECT l.*, d.asset_tag, d.brand, d.model, d.id AS device_id
           FROM loans l JOIN loan_devices d ON d.id = l.loan_device_id
          WHERE l.case_id = $1 AND l.returned_at IS NULL
          FOR UPDATE OF l, d`,
        [caseId],
      )
    ).rows[0];
    if (!loan) throw new ApiError(409, 'NO_ACTIVE_LOAN', 'El caso no tiene un préstamo activo');

    const updated = (
      await client.query(
        `UPDATE loans
            SET returned_at = now(), returned_by = $2, condition_in = $3
          WHERE id = $1
          RETURNING *`,
        [loan.id, actor.id, input.condition_in],
      )
    ).rows[0];
    await client.query(`UPDATE loan_devices SET status = 'available' WHERE id = $1`, [loan.device_id]);

    await notifyCase(client, row, {
      template: 'loan_returned',
      subject: `Relevo: devolución de préstamo del caso ${row.case_number}`,
      body:
        `Se registró la devolución del equipo de préstamo ${loan.brand} ${loan.model} ` +
        `(${loan.asset_tag}) del caso ${row.case_number}.\n` +
        `Condición de entrada: ${input.condition_in}.`,
    });

    await writeAudit(client, {
      actorId: actor.id,
      action: 'loan.return',
      entityType: 'case',
      entityId: caseId,
      details: { loan_id: loan.id, condition_in: input.condition_in },
      ip,
    });

    return {
      id: loan.id,
      status: 'returned',
      condition_in: updated.condition_in,
      returned_at: iso(updated.returned_at),
    };
  });
}
