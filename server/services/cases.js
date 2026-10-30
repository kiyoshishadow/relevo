import { pool, query, withTransaction } from '../db/pool.js';
import {
  fingerprintPayment,
  generateTrackingToken,
  hashToken,
  safeEqualText,
} from '../domain/tokens.js';
import { formatCents, sumCents } from '../domain/money.js';
import { assertTransition } from '../domain/states.js';
import { evaluateCoverage, todayIso } from '../domain/coverage.js';
import { ApiError, iso } from '../lib/http.js';
import { writeAudit } from './audit.js';
import { notifyCase } from './notifications.js';

const LIVE_CASE_STATUSES = ['received', 'diagnosing', 'awaiting_approval', 'awaiting_payment', 'repairing', 'ready'];
const CASE_EDITABLE_STATUSES = new Set(['received', 'diagnosing', 'awaiting_approval']);

const CASE_JOIN = `
  SELECT c.*,
         cl.full_name AS client_name,
         cl.document_id AS client_document_id,
         cl.phone AS client_phone,
         cl.email AS client_email,
         cl.address AS client_address,
         cl.active AS client_active,
         t.brand AS terminal_brand,
         t.model AS terminal_model,
         t.purchase_date AS terminal_purchase_date,
         t.accessories AS terminal_accessories,
         t.initial_condition AS terminal_initial_condition,
         t.coverage_id AS terminal_coverage_id,
         cov.name AS coverage_name,
         cov.plan AS coverage_plan,
         cov.months AS coverage_months,
         cov.exclusions AS coverage_exclusions,
         cov.replacement_policy AS coverage_replacement_policy,
         u.full_name AS technician_name,
         u.email AS technician_email
    FROM cases c
    JOIN clients cl ON cl.id = c.client_id
    JOIN terminals t ON t.id = c.terminal_id
    LEFT JOIN coverages cov ON cov.id = t.coverage_id
    LEFT JOIN users u ON u.id = c.technician_id`;

async function loadCaseRow(db, id, { forUpdate = false } = {}) {
  const { rows } = await db.query(
    `${CASE_JOIN} WHERE c.id = $1${forUpdate ? ' FOR UPDATE OF c' : ''}`,
    [id],
  );
  return rows[0] || null;
}

function assertCaseAccess(actor, row) {
  if (actor.role === 'technician' && row.technician_id !== actor.id) {
    throw new ApiError(403, 'CASE_NOT_ASSIGNED', 'El caso no está asignado a este técnico');
  }
}

function requireCaseEditable(row) {
  if (row.status === 'cancelled') {
    throw new ApiError(409, 'CASE_CANCELLED', 'Un caso cancelado no admite cambios');
  }
  if (row.status === 'delivered') {
    throw new ApiError(409, 'CASE_DELIVERED', 'Un caso entregado no admite cambios');
  }
}

async function insertHistory(db, { caseId, from, to, note, actorId }) {
  await db.query(
    `INSERT INTO case_history (case_id, from_status, to_status, note, changed_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [caseId, from, to, note || null, actorId],
  );
}

function quoteTotal(row) {
  return row && row.status !== 'rejected' ? Number(row.total_cents || 0) : 0;
}

function serializeQuote(row, items = []) {
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    note: row.note,
    status: row.status,
    total: formatCents(row.total_cents),
    total_cents: Number(row.total_cents),
    created_at: iso(row.created_at),
    decided_at: iso(row.decided_at),
    items: items.map((item) => ({
      id: item.id,
      description: item.description,
      quantity: item.quantity,
      unit_price: formatCents(item.unit_price_cents),
      line_total: formatCents(item.line_total_cents),
    })),
  };
}

function serializePayment(row) {
  return {
    id: row.id,
    amount: formatCents(row.amount_cents),
    amount_cents: Number(row.amount_cents),
    method: row.method,
    reference: row.reference,
    created_at: iso(row.created_at),
  };
}

function serializeLoan(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.returned_at ? 'returned' : 'active',
    device: {
      id: row.loan_device_id,
      asset_tag: row.asset_tag,
      brand: row.brand,
      model: row.model,
    },
    condition_out: row.condition_out,
    condition_in: row.condition_in,
    loaned_at: iso(row.loaned_at),
    returned_at: iso(row.returned_at),
  };
}

export async function listCases(actor, filters) {
  const { q, page, pageSize, offset } = filters;
  const where = [];
  const params = [];

  if (actor.role === 'technician') {
    params.push(actor.id);
    where.push(`c.technician_id = $${params.length}`);
  } else if (filters.technician_id) {
    params.push(filters.technician_id);
    where.push(`c.technician_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`c.status = $${params.length}`);
  }
  if (filters.client_id) {
    params.push(filters.client_id);
    where.push(`c.client_id = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(lower(c.case_number) LIKE $${params.length}
      OR lower(c.reported_problem) LIKE $${params.length}
      OR lower(cl.full_name) LIKE $${params.length}
      OR lower(t.brand || ' ' || t.model) LIKE $${params.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const count = await query(
    `SELECT count(*)::int AS total
       FROM cases c
       JOIN clients cl ON cl.id = c.client_id
       JOIN terminals t ON t.id = c.terminal_id
       ${whereSql}`,
    params,
  );

  const listParams = [...params, pageSize, offset];
  const { rows } = await query(
    `SELECT c.id, c.case_number, c.status, c.reported_problem, c.created_at, c.updated_at,
            c.coverage_covered, c.technician_id,
            cl.id AS client_id, cl.full_name AS client_name,
            t.id AS terminal_id, t.brand, t.model,
            u.full_name AS technician_name,
            qa.total_cents AS quote_total_cents,
            COALESCE(pay.paid_cents, 0)::bigint AS paid_cents,
            EXISTS (SELECT 1 FROM loans l WHERE l.case_id = c.id AND l.returned_at IS NULL) AS loan_active
       FROM cases c
       JOIN clients cl ON cl.id = c.client_id
       JOIN terminals t ON t.id = c.terminal_id
       LEFT JOIN users u ON u.id = c.technician_id
       LEFT JOIN LATERAL (
         SELECT total_cents FROM case_quotes WHERE case_id = c.id ORDER BY version DESC LIMIT 1
       ) qa ON true
       LEFT JOIN LATERAL (
         SELECT sum(amount_cents) AS paid_cents FROM payments WHERE case_id = c.id
       ) pay ON true
       ${whereSql}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams,
  );

  const total = count.rows[0].total;
  return {
    data: rows.map((row) => ({
      id: row.id,
      case_number: row.case_number,
      status: row.status,
      reported_problem: row.reported_problem,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      coverage_covered: row.coverage_covered,
      client: { id: row.client_id, full_name: row.client_name },
      terminal: { id: row.terminal_id, brand: row.brand, model: row.model },
      technician: row.technician_id
        ? { id: row.technician_id, full_name: row.technician_name }
        : null,
      quote_total: formatCents(row.quote_total_cents || 0),
      paid_total: formatCents(row.paid_cents || 0),
      loan_active: row.loan_active,
    })),
    meta: { total, page, pageSize },
  };
}

export async function getCaseDetail(actor, id) {
  const row = await loadCaseRow(pool, id);
  if (!row) throw new ApiError(404, 'CASE_NOT_FOUND', 'Caso no encontrado');
  assertCaseAccess(actor, row);

  const [imeis, history, quote, payments, loan, actions, replacement] = await Promise.all([
    query('SELECT imei FROM terminal_imeis WHERE terminal_id = $1 ORDER BY imei', [row.terminal_id]),
    query(
      `SELECT h.*, u.full_name AS actor_name
         FROM case_history h
         LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.case_id = $1
        ORDER BY h.created_at, h.id`,
      [id],
    ),
    query('SELECT * FROM case_quotes WHERE case_id = $1 ORDER BY version DESC LIMIT 1', [id]),
    query('SELECT * FROM payments WHERE case_id = $1 ORDER BY created_at, id', [id]),
    query(
      `SELECT l.*, d.asset_tag, d.brand, d.model
         FROM loans l JOIN loan_devices d ON d.id = l.loan_device_id
        WHERE l.case_id = $1
        ORDER BY (l.returned_at IS NULL) DESC, l.loaned_at DESC
        LIMIT 1`,
      [id],
    ),
    query(
      `SELECT a.*, u.full_name AS actor_name
         FROM case_actions a LEFT JOIN users u ON u.id = a.created_by
        WHERE a.case_id = $1 ORDER BY a.created_at, a.id`,
      [id],
    ),
    query(
      `SELECT r.*, t.brand, t.model
         FROM case_replacements r JOIN terminals t ON t.id = r.terminal_id
        WHERE r.case_id = $1`,
      [id],
    ),
  ]);

  let quoteItems = [];
  if (quote.rows[0]) {
    const items = await query(
      'SELECT * FROM case_quote_items WHERE quote_id = $1 ORDER BY id',
      [quote.rows[0].id],
    );
    quoteItems = items.rows;
  }

  const paidCents = sumCents(payments.rows.map((payment) => Number(payment.amount_cents)));
  const currentQuote = quote.rows[0] || null;
  const totalCents = quoteTotal(currentQuote);

  return {
    id: row.id,
    case_number: row.case_number,
    status: row.status,
    reported_problem: row.reported_problem,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    delivered_at: iso(row.delivered_at),
    cancelled_at: iso(row.cancelled_at),
    client: {
      id: row.client_id,
      full_name: row.client_name,
      document_id: row.client_document_id,
      phone: row.client_phone,
      email: row.client_email,
      address: row.client_address,
      active: row.client_active,
    },
    terminal: {
      id: row.terminal_id,
      brand: row.terminal_brand,
      model: row.terminal_model,
      purchase_date: row.terminal_purchase_date,
      accessories: row.terminal_accessories,
      initial_condition: row.terminal_initial_condition,
      imeis: imeis.rows.map((item) => item.imei),
      coverage_id: row.terminal_coverage_id,
      coverage: row.terminal_coverage_id
        ? {
            id: row.terminal_coverage_id,
            name: row.coverage_name,
            plan: row.coverage_plan,
            months: row.coverage_months,
            exclusions: row.coverage_exclusions,
            replacement_policy: row.coverage_replacement_policy,
          }
        : null,
    },
    technician: row.technician_id
      ? { id: row.technician_id, full_name: row.technician_name, email: row.technician_email }
      : null,
    diagnosis: row.diagnosis
      ? {
          text: row.diagnosis,
          problem_type: row.problem_type,
          excluded_reason: row.excluded_reason,
          diagnosed_at: iso(row.diagnosed_at),
        }
      : null,
    coverage_evaluation: row.coverage_evaluation,
    coverage_covered: row.coverage_covered,
    coverage_override: row.coverage_override,
    override_reason: row.override_reason,
    history: history.rows.map((item) => ({
      id: item.id,
      from_status: item.from_status,
      to_status: item.to_status,
      note: item.note,
      actor: item.actor_name ? { id: item.changed_by, full_name: item.actor_name } : null,
      created_at: iso(item.created_at),
    })),
    quote: serializeQuote(currentQuote, quoteItems),
    payments: payments.rows.map(serializePayment),
    paid_total: formatCents(paidCents),
    paid_total_cents: paidCents,
    balance: formatCents(Math.max(0, totalCents - paidCents)),
    loan: serializeLoan(loan.rows[0] || null),
    actions: actions.rows.map((item) => ({
      id: item.id,
      description: item.description,
      parts: item.parts,
      actor: item.actor_name ? { id: item.created_by, full_name: item.actor_name } : null,
      created_at: iso(item.created_at),
    })),
    replacement: replacement.rows[0]
      ? {
          id: replacement.rows[0].id,
          policy: replacement.rows[0].policy,
          coverage_id: replacement.rows[0].coverage_id,
          created_at: iso(replacement.rows[0].created_at),
          terminal: {
            id: replacement.rows[0].terminal_id,
            brand: replacement.rows[0].brand,
            model: replacement.rows[0].model,
          },
        }
      : null,
  };
}

export async function createCase(actor, input, { ip } = {}) {
  const result = await withTransaction(async (client) => {
    const clientRow = (
      await client.query('SELECT id, full_name, email, active FROM clients WHERE id = $1', [
        input.client_id,
      ])
    ).rows[0];
    if (!clientRow) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Cliente no encontrado');
    if (!clientRow.active) throw new ApiError(409, 'CLIENT_INACTIVE', 'El cliente está inactivo');

    const terminal = (
      await client.query(
        `SELECT t.id, t.client_id, t.brand, t.model, t.coverage_id
           FROM terminals t WHERE t.id = $1 FOR UPDATE`,
        [input.terminal_id],
      )
    ).rows[0];
    if (!terminal) throw new ApiError(404, 'TERMINAL_NOT_FOUND', 'Terminal no encontrado');
    if (terminal.client_id !== input.client_id) {
      throw new ApiError(
        409,
        'TERMINAL_CLIENT_MISMATCH',
        'El terminal no pertenece al cliente indicado',
      );
    }

    const reservedReplacement = (
      await client.query(
        `SELECT 1
           FROM case_replacements r
           JOIN cases c ON c.id = r.case_id
          WHERE r.terminal_id = $1
            AND c.status NOT IN ('delivered', 'cancelled')
          LIMIT 1`,
        [input.terminal_id],
      )
    ).rows[0];
    if (reservedReplacement) {
      throw new ApiError(
        409,
        'TERMINAL_RESERVED_FOR_REPLACEMENT',
        'El terminal está reservado como reemplazo para un caso abierto',
      );
    }

    if (input.technician_id) {
      const technician = (
        await client.query(
          `SELECT id FROM users
            WHERE id = $1 AND role = 'technician' AND active = true`,
          [input.technician_id],
        )
      ).rows[0];
      if (!technician) {
        throw new ApiError(
          409,
          'INVALID_TECHNICIAN',
          'El técnico indicado no existe, no está activo o no tiene rol technician',
        );
      }
    }

    const sequence = (await client.query('SELECT nextval($1::regclass) AS value', ['case_number_seq']))
      .rows[0].value;
    const caseNumber = `RV-${new Date().getUTCFullYear()}-${String(sequence).padStart(6, '0')}`;
    const trackingToken = generateTrackingToken();

    const inserted = (
      await client.query(
        `INSERT INTO cases
           (case_number, client_id, terminal_id, reported_problem, technician_id,
            status, tracking_token_hash, created_by)
         VALUES ($1, $2, $3, $4, $5, 'received', $6, $7)
         RETURNING id, case_number, status, created_at`,
        [
          caseNumber,
          input.client_id,
          input.terminal_id,
          input.reported_problem,
          input.technician_id || null,
          hashToken(trackingToken),
          actor.id,
        ],
      )
    ).rows[0];

    await insertHistory(client, {
      caseId: inserted.id,
      from: null,
      to: 'received',
      note: 'Caso creado en recepción',
      actorId: actor.id,
    });

    await notifyCase(
      client,
      { ...inserted, client_email: clientRow.email },
      {
        template: 'case_received',
        subject: `Relevo: recibimos el caso ${caseNumber}`,
        body:
          `Hola ${clientRow.full_name},\n\n` +
          `Registramos el ingreso del terminal ${terminal.brand} ${terminal.model} ` +
          `con el caso ${caseNumber}.\nProblema reportado: ${input.reported_problem}\n\n` +
          'Conserve el número de caso y el token de seguimiento entregados en recepción. ' +
          'No compartimos datos de otros clientes.',
      },
    );

    await writeAudit(client, {
      actorId: actor.id,
      action: 'case.create',
      entityType: 'case',
      entityId: inserted.id,
      details: { case_number: caseNumber, client_id: input.client_id, terminal_id: input.terminal_id },
      ip,
    });

    return { ...inserted, tracking_token: trackingToken };
  });

  return {
    id: result.id,
    case_number: result.case_number,
    status: result.status,
    created_at: iso(result.created_at),
    tracking_token: result.tracking_token,
  };
}

export async function diagnoseCase(actor, id, input, { ip } = {}) {
  return withTransaction(async (client) => {
    const row = await loadCaseRow(client, id, { forUpdate: true });
    if (!row) throw new ApiError(404, 'CASE_NOT_FOUND', 'Caso no encontrado');
    assertCaseAccess(actor, row);
    if (!['admin', 'technician'].includes(actor.role)) {
      throw new ApiError(403, 'FORBIDDEN', 'El diagnóstico lo registra un técnico o administrador');
    }
    if (actor.role === 'technician' && row.coverage_override) {
      throw new ApiError(
        403,
        'OVERRIDE_REQUIRES_ADMIN',
        'El diagnóstico tiene una excepción de cobertura activa; solicite a administración que la revise',
      );
    }
    if (!CASE_EDITABLE_STATUSES.has(row.status)) {
      throw new ApiError(
        409,
        'CASE_STATE_CONFLICT',
        `No se puede diagnosticar un caso en estado ${row.status}`,
      );
    }
    if (input.coverage_override && actor.role !== 'admin') {
      throw new ApiError(
        403,
        'OVERRIDE_REQUIRES_ADMIN',
        'Solo un administrador puede autorizar una excepción de cobertura',
      );
    }

    const coverage =
      row.terminal_coverage_id === null
        ? null
        : {
            id: row.terminal_coverage_id,
            name: row.coverage_name,
            plan: row.coverage_plan,
            months: row.coverage_months,
            exclusions: row.coverage_exclusions,
            replacement_policy: row.coverage_replacement_policy,
          };

    let evaluation;
    try {
      evaluation = evaluateCoverage({
        coverage,
        purchaseDate: row.terminal_purchase_date,
        terminalBrand: row.terminal_brand,
        problemType: input.problem_type,
        excludedReason: input.excluded_reason || null,
        coverageOverride: Boolean(input.coverage_override),
        overrideReason: input.override_reason || null,
        now: new Date(),
      });
    } catch (error) {
      throw new ApiError(400, 'COVERAGE_RULE_ERROR', error.message);
    }

    let currentStatus = row.status;
    if (currentStatus === 'received') {
      await insertHistory(client, {
        caseId: id,
        from: 'received',
        to: 'diagnosing',
        note: 'Diagnóstico iniciado',
        actorId: actor.id,
      });
      currentStatus = 'diagnosing';
    }

    const historyNotes = [];
    if (!evaluation.covered && currentStatus === 'diagnosing') {
      await insertHistory(client, {
        caseId: id,
        from: 'diagnosing',
        to: 'awaiting_approval',
        note: 'Cobertura no aplica; se requiere cotización y aceptación',
        actorId: actor.id,
      });
      currentStatus = 'awaiting_approval';
      historyNotes.push('awaiting_approval');
    }

    await client.query(
      `UPDATE cases
          SET diagnosis = $2,
              problem_type = $3,
              excluded_reason = $4,
              coverage_covered = $5,
              coverage_evaluation = $6::jsonb,
              coverage_override = $7,
              override_reason = $8,
              diagnosed_at = now(),
              status = $9
        WHERE id = $1`,
      [
        id,
        input.diagnosis,
        input.problem_type,
        input.excluded_reason || null,
        evaluation.covered,
        JSON.stringify(evaluation),
        Boolean(input.coverage_override),
        input.override_reason || null,
        currentStatus,
      ],
    );

    await notifyCase(
      client,
      row,
      {
        template: 'case_diagnosis',
        subject: `Relevo: diagnóstico del caso ${row.case_number}`,
        body:
          `El diagnóstico del caso ${row.case_number} fue registrado.\n` +
          `Problema: ${input.problem_type}\n` +
          `Cobertura: ${evaluation.covered ? 'aplica' : 'no aplica'}\n` +
          (evaluation.covered
            ? 'El equipo continúa en evaluación técnica.'
            : 'La recepción le contactará para cotización y autorización.'),
      },
    );

    await writeAudit(client, {
      actorId: actor.id,
      action: 'case.diagnosis',
      entityType: 'case',
      entityId: id,
      details: {
        status: currentStatus,
        covered: evaluation.covered,
        override: Boolean(input.coverage_override),
        reasons: evaluation.reasons,
      },
      ip,
    });

    return { id, status: currentStatus, coverage_covered: evaluation.covered, coverage_evaluation: evaluation };
  });
}

export async function transitionCase(actor, id, input, { ip } = {}) {
  return withTransaction(async (client) => {
    const row = await loadCaseRow(client, id, { forUpdate: true });
    if (!row) throw new ApiError(404, 'CASE_NOT_FOUND', 'Caso no encontrado');
    assertCaseAccess(actor, row);

    if (actor.role === 'technician' && !['diagnosing', 'repairing', 'ready'].includes(input.status)) {
      throw new ApiError(
        403,
        'TRANSITION_FORBIDDEN',
        'El técnico solo puede mover el caso a diagnosing, repairing o ready',
      );
    }

    const quote = (
      await client.query(
        `SELECT total_cents FROM case_quotes
          WHERE case_id = $1 AND status = 'accepted' ORDER BY version DESC LIMIT 1`,
        [id],
      )
    ).rows[0];
    const paid = (
      await client.query(
        'SELECT COALESCE(sum(amount_cents), 0)::bigint AS paid FROM payments WHERE case_id = $1',
        [id],
      )
    ).rows[0].paid;
    const activeLoan = Boolean(
      (
        await client.query('SELECT 1 FROM loans WHERE case_id = $1 AND returned_at IS NULL', [id])
      ).rows[0],
    );

    try {
      assertTransition({
        from: row.status,
        to: input.status,
        context: {
          coverageEvaluated: row.coverage_covered !== null,
          covered: row.coverage_covered === true,
          acceptedQuote: Boolean(quote),
          quoteTotalCents: quote ? Number(quote.total_cents) : 0,
          paidCents: Number(paid),
          activeLoan,
        },
      });
    } catch (error) {
      throw new ApiError(error.status || 409, error.code || 'INVALID_TRANSITION', error.message, error.details);
    }

    const timestampField =
      input.status === 'delivered' ? ', delivered_at = now()' : input.status === 'cancelled' ? ', cancelled_at = now()' : '';

    await client.query(`UPDATE cases SET status = $2${timestampField} WHERE id = $1`, [id, input.status]);

    const note =
      input.note ||
      ({
        diagnosing: 'Diagnóstico en curso',
        awaiting_approval: 'Pendiente de aprobación del cliente',
        awaiting_payment: 'Pendiente de pago',
        repairing: 'Reparación iniciada',
        ready: 'Equipo listo para entrega',
        delivered: 'Equipo entregado al cliente',
        cancelled: 'Caso cancelado',
      }[input.status] ??
        `Cambio de estado a ${input.status}`);

    await insertHistory(client, {
      caseId: id,
      from: row.status,
      to: input.status,
      note,
      actorId: actor.id,
    });

    if (['ready', 'delivered', 'cancelled', 'repairing'].includes(input.status)) {
      await notifyCase(
        client,
        row,
        {
          template: `case_${input.status}`,
          subject: `Relevo: caso ${row.case_number} en estado ${input.status}`,
          body:
            `El caso ${row.case_number} cambió a estado "${input.status}".\n` +
            (input.status === 'ready'
              ? 'Puede coordinar la entrega en recepción.\n'
              : input.status === 'delivered'
                ? 'Gracias por confiar en Relevo.\n'
                : ''),
        },
      );
    }

    await writeAudit(client, {
      actorId: actor.id,
      action: 'case.transition',
      entityType: 'case',
      entityId: id,
      details: { from: row.status, to: input.status, note },
      ip,
    });

    return { id, status: input.status, updated_at: new Date().toISOString() };
  });
}

export async function assignTechnician(actor, id, input, { ip } = {}) {
  if (!['admin', 'reception'].includes(actor.role)) {
    throw new ApiError(403, 'FORBIDDEN', 'Solo recepción o administración pueden asignar técnicos');
  }
  return withTransaction(async (client) => {
    const row = await loadCaseRow(client, id, { forUpdate: true });
    if (!row) throw new ApiError(404, 'CASE_NOT_FOUND', 'Caso no encontrado');
    requireCaseEditable(row);

    if (input.technician_id !== null && input.technician_id !== undefined) {
      const technician = (
        await client.query(
          `SELECT id FROM users WHERE id = $1 AND role = 'technician' AND active = true`,
          [input.technician_id],
        )
      ).rows[0];
      if (!technician) {
        throw new ApiError(409, 'INVALID_TECHNICIAN', 'El técnico indicado no está disponible');
      }
    }

    await client.query('UPDATE cases SET technician_id = $2 WHERE id = $1', [
      id,
      input.technician_id ?? null,
    ]);
    await writeAudit(client, {
      actorId: actor.id,
      action: 'case.assign',
      entityType: 'case',
      entityId: id,
      details: { from: row.technician_id, to: input.technician_id ?? null },
      ip,
    });
    return { id, technician_id: input.technician_id ?? null };
  });
}

export async function addCaseAction(actor, id, input, { ip } = {}) {
  return withTransaction(async (client) => {
    const row = await loadCaseRow(client, id, { forUpdate: true });
    if (!row) throw new ApiError(404, 'CASE_NOT_FOUND', 'Caso no encontrado');
    assertCaseAccess(actor, row);
    if (row.status === 'delivered') {
      throw new ApiError(409, 'CASE_DELIVERED', 'Un caso entregado no admite acciones');
    }
    if (row.status === 'cancelled') {
      throw new ApiError(409, 'CASE_CANCELLED', 'Un caso cancelado no admite acciones');
    }

    const inserted = (
      await client.query(
        `INSERT INTO case_actions (case_id, description, parts, created_by)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING *`,
        [id, input.description, JSON.stringify(input.parts || []), actor.id],
      )
    ).rows[0];

    await writeAudit(client, {
      actorId: actor.id,
      action: 'case.action.create',
      entityType: 'case',
      entityId: id,
      details: { action_id: inserted.id, parts: input.parts || [] },
      ip,
    });

    return {
      id: inserted.id,
      description: inserted.description,
      parts: inserted.parts,
      created_at: iso(inserted.created_at),
    };
  });
}

export async function createQuote(actor, id, input, { ip } = {}) {
  if (!['admin', 'reception'].includes(actor.role)) {
    throw new ApiError(403, 'FORBIDDEN', 'La cotización la registra recepción o administración');
  }
  return withTransaction(async (client) => {
    const row = await loadCaseRow(client, id, { forUpdate: true });
    if (!row) throw new ApiError(404, 'CASE_NOT_FOUND', 'Caso no encontrado');
    if (!['diagnosing', 'awaiting_approval', 'awaiting_payment'].includes(row.status)) {
      throw new ApiError(
        409,
        'CASE_STATE_CONFLICT',
        `No se puede cotizar un caso en estado ${row.status}`,
      );
    }

    const payments = (
      await client.query('SELECT count(*)::int AS count FROM payments WHERE case_id = $1', [id])
    ).rows[0].count;
    if (payments > 0) {
      throw new ApiError(
        409,
        'QUOTE_LOCKED',
        'No se puede reemplazar la cotización después de registrar pagos',
      );
    }

    const items = input.items.map((item) => ({
      ...item,
      lineTotalCents: item.quantity * item.unit_price,
    }));
    const totalCents = sumCents(items.map((item) => item.lineTotalCents));

    await client.query(
      `UPDATE case_quotes SET status = 'superseded'
        WHERE case_id = $1 AND status IN ('pending', 'accepted')`,
      [id],
    );

    let currentStatus = row.status;
    if (currentStatus === 'awaiting_payment') {
      await insertHistory(client, {
        caseId: id,
        from: 'awaiting_payment',
        to: 'awaiting_approval',
        note: 'Nueva cotización; se requiere nueva aceptación',
        actorId: actor.id,
      });
      currentStatus = 'awaiting_approval';
      await client.query('UPDATE cases SET status = $2 WHERE id = $1', [id, currentStatus]);
    }

    const version = (
      await client.query(
        'SELECT COALESCE(max(version), 0) + 1 AS version FROM case_quotes WHERE case_id = $1',
        [id],
      )
    ).rows[0].version;

    const quote = (
      await client.query(
        `INSERT INTO case_quotes (case_id, version, note, total_cents, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, version, input.note || null, totalCents, actor.id],
      )
    ).rows[0];

    for (const item of items) {
      await client.query(
        `INSERT INTO case_quote_items
           (quote_id, description, quantity, unit_price_cents, line_total_cents)
         VALUES ($1, $2, $3, $4, $5)`,
        [quote.id, item.description, item.quantity, item.unit_price, item.lineTotalCents],
      );
    }

    if (currentStatus === 'diagnosing' && row.coverage_covered === false) {
      await insertHistory(client, {
        caseId: id,
        from: 'diagnosing',
        to: 'awaiting_approval',
        note: 'Cotización registrada; pendiente de aprobación',
        actorId: actor.id,
      });
      currentStatus = 'awaiting_approval';
      await client.query('UPDATE cases SET status = $2 WHERE id = $1', [id, currentStatus]);
    }

    await notifyCase(
      client,
      row,
      {
        template: 'quote_created',
        subject: `Relevo: cotización del caso ${row.case_number}`,
        body:
          `Se registró la cotización ${version} del caso ${row.case_number} ` +
          `por USD ${formatCents(totalCents)}.\n` +
          'La recepción confirmará la aceptación antes de iniciar la reparación.',
      },
    );

    await writeAudit(client, {
      actorId: actor.id,
      action: 'quote.create',
      entityType: 'case',
      entityId: id,
      details: { quote_id: quote.id, version, total_cents: totalCents },
      ip,
    });

    return {
      quote: {
        id: quote.id,
        version,
        status: quote.status,
        total: formatCents(totalCents),
        total_cents: totalCents,
        created_at: iso(quote.created_at),
        items: items.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unit_price: formatCents(item.unit_price),
          line_total: formatCents(item.lineTotalCents),
        })),
      },
      status: currentStatus,
    };
  });
}

export async function decideQuote(actor, id, input, { ip } = {}) {
  if (!['admin', 'reception'].includes(actor.role)) {
    throw new ApiError(403, 'FORBIDDEN', 'La decisión de cotización la registra recepción o administración');
  }
  return withTransaction(async (client) => {
    const row = await loadCaseRow(client, id, { forUpdate: true });
    if (!row) throw new ApiError(404, 'CASE_NOT_FOUND', 'Caso no encontrado');

    const quote = (
      await client.query(
        `SELECT * FROM case_quotes WHERE case_id = $1 AND status = 'pending'
          ORDER BY version DESC LIMIT 1`,
        [id],
      )
    ).rows[0];
    if (!quote) throw new ApiError(409, 'NO_PENDING_QUOTE', 'No existe una cotización pendiente');

    let currentStatus = row.status;
    if (input.accepted) {
      if (!['diagnosing', 'awaiting_approval'].includes(row.status)) {
        throw new ApiError(
          409,
          'CASE_STATE_CONFLICT',
          `No se puede aceptar la cotización en estado ${row.status}`,
        );
      }
      await client.query(
        `UPDATE case_quotes SET status = 'accepted', decided_at = now(), decided_by = $2
          WHERE id = $1`,
        [quote.id, actor.id],
      );
      await insertHistory(client, {
        caseId: id,
        from: row.status,
        to: 'awaiting_payment',
        note: 'Cotización aceptada; pendiente de pago',
        actorId: actor.id,
      });
      currentStatus = 'awaiting_payment';
      await client.query('UPDATE cases SET status = $2 WHERE id = $1', [id, currentStatus]);
    } else {
      await client.query(
        `UPDATE case_quotes SET status = 'rejected', decided_at = now(), decided_by = $2
          WHERE id = $1`,
        [quote.id, actor.id],
      );
      if (row.status === 'diagnosing') {
        await insertHistory(client, {
          caseId: id,
          from: 'diagnosing',
          to: 'awaiting_approval',
          note: 'Cotización rechazada; el caso permanece pendiente de decisión',
          actorId: actor.id,
        });
        currentStatus = 'awaiting_approval';
        await client.query('UPDATE cases SET status = $2 WHERE id = $1', [id, currentStatus]);
      }
    }

    await notifyCase(
      client,
      row,
      {
        template: input.accepted ? 'quote_accepted' : 'quote_rejected',
        subject: `Relevo: cotización ${input.accepted ? 'aceptada' : 'rechazada'} del caso ${row.case_number}`,
        body: input.accepted
          ? `La cotización del caso ${row.case_number} fue aceptada. Le indicaremos el monto y el pago requerido antes de reparar.`
          : `La cotización del caso ${row.case_number} fue rechazada. Recepción revisará las alternativas con usted.`,
      },
    );

    await writeAudit(client, {
      actorId: actor.id,
      action: 'quote.decision',
      entityType: 'case',
      entityId: id,
      details: { quote_id: quote.id, accepted: input.accepted, status: currentStatus },
      ip,
    });

    return {
      quote_id: quote.id,
      quote_status: input.accepted ? 'accepted' : 'rejected',
      status: currentStatus,
    };
  });
}

export async function addPayment(actor, id, input, { ip } = {}) {
  if (!['admin', 'reception'].includes(actor.role)) {
    throw new ApiError(403, 'FORBIDDEN', 'El pago lo registra recepción o administración');
  }
  const requestHash = fingerprintPayment({
    amountCents: input.amount,
    method: input.method,
    reference: input.reference || '',
  });

  return withTransaction(async (client) => {
    const existing = (
      await client.query('SELECT * FROM payments WHERE idempotency_key = $1', [
        input.idempotency_key,
      ])
    ).rows[0];
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'La clave de idempotencia ya fue usada con otros datos',
        );
      }
      const paid = (
        await client.query(
          'SELECT COALESCE(sum(amount_cents), 0)::bigint AS paid FROM payments WHERE case_id = $1',
          [existing.case_id],
        )
      ).rows[0].paid;
      const quote = (
        await client.query(
          `SELECT total_cents FROM case_quotes
            WHERE case_id = $1 AND status = 'accepted' ORDER BY version DESC LIMIT 1`,
          [existing.case_id],
        )
      ).rows[0];
      return {
        payment: serializePayment(existing),
        paid_total: formatCents(paid),
        balance: formatCents(Math.max(0, Number(quote?.total_cents || 0) - Number(paid))),
        replayed: true,
      };
    }

    const row = await loadCaseRow(client, id, { forUpdate: true });
    if (!row) throw new ApiError(404, 'CASE_NOT_FOUND', 'Caso no encontrado');
    if (row.status !== 'awaiting_payment') {
      throw new ApiError(
        409,
        'CASE_STATE_CONFLICT',
        `No se pueden registrar pagos en estado ${row.status}`,
      );
    }

    const quote = (
      await client.query(
        `SELECT * FROM case_quotes WHERE case_id = $1 AND status = 'accepted'
          ORDER BY version DESC LIMIT 1`,
        [id],
      )
    ).rows[0];
    if (!quote) throw new ApiError(409, 'QUOTE_NOT_ACCEPTED', 'No existe una cotización aceptada');

    const paid = (
      await client.query(
        'SELECT COALESCE(sum(amount_cents), 0)::bigint AS paid FROM payments WHERE case_id = $1',
        [id],
      )
    ).rows[0].paid;
    const outstanding = Number(quote.total_cents) - Number(paid);
    if (input.amount > outstanding) {
      throw new ApiError(409, 'PAYMENT_EXCEEDS_BALANCE', 'El pago excede el saldo pendiente', {
        outstanding_cents: outstanding,
      });
    }

    const inserted = (
      await client.query(
        `INSERT INTO payments
           (case_id, amount_cents, method, reference, idempotency_key, request_hash, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          id,
          input.amount,
          input.method,
          input.reference || null,
          input.idempotency_key,
          requestHash,
          actor.id,
        ],
      )
    ).rows[0];

    const newPaid = Number(paid) + input.amount;
    await notifyCase(
      client,
      row,
      {
        template: 'payment_received',
        subject: `Relevo: pago registrado del caso ${row.case_number}`,
        body:
          `Registramos un pago de USD ${formatCents(input.amount)} para el caso ${row.case_number}.\n` +
          `Total pagado: USD ${formatCents(newPaid)} de USD ${formatCents(Number(quote.total_cents))}.`,
      },
    );

    await writeAudit(client, {
      actorId: actor.id,
      action: 'payment.create',
      entityType: 'case',
      entityId: id,
      details: {
        payment_id: inserted.id,
        amount_cents: input.amount,
        method: input.method,
        idempotency_key: input.idempotency_key,
      },
      ip,
    });

    return {
      payment: serializePayment(inserted),
      paid_total: formatCents(newPaid),
      balance: formatCents(Math.max(0, Number(quote.total_cents) - newPaid)),
      replayed: false,
    };
  });
}

export async function createReplacement(actor, id, input, { ip } = {}) {
  if (!['admin', 'reception'].includes(actor.role)) {
    throw new ApiError(403, 'FORBIDDEN', 'El reemplazo lo registra recepción o administración');
  }
  return withTransaction(async (client) => {
    const row = await loadCaseRow(client, id, { forUpdate: true });
    if (!row) throw new ApiError(404, 'CASE_NOT_FOUND', 'Caso no encontrado');
    const existingReplacement = (
      await client.query('SELECT 1 FROM case_replacements WHERE case_id = $1', [id])
    ).rows[0];
    if (existingReplacement) {
      throw new ApiError(409, 'REPLACEMENT_ALREADY_EXISTS', 'El caso ya tiene un reemplazo registrado');
    }
    requireCaseEditable(row);
    if (row.coverage_covered !== true) {
      throw new ApiError(409, 'NOT_COVERED', 'El reemplazo requiere cobertura vigente evaluada');
    }
    if (!['diagnosing', 'repairing', 'ready'].includes(row.status)) {
      throw new ApiError(
        409,
        'CASE_STATE_CONFLICT',
        `No se puede registrar reemplazo en estado ${row.status}`,
      );
    }
    if (input.terminal_id === row.terminal_id) {
      throw new ApiError(409, 'SAME_TERMINAL', 'El terminal de reemplazo debe ser distinto');
    }

    const replacementTerminal = (
      await client.query(
        `SELECT id, client_id, brand, model, coverage_id FROM terminals WHERE id = $1 FOR UPDATE`,
        [input.terminal_id],
      )
    ).rows[0];
    if (!replacementTerminal) {
      throw new ApiError(404, 'TERMINAL_NOT_FOUND', 'Terminal de reemplazo no encontrado');
    }
    if (replacementTerminal.client_id !== row.client_id) {
      throw new ApiError(
        409,
        'REPLACEMENT_CLIENT_MISMATCH',
        'El terminal de reemplazo debe pertenecer al mismo cliente',
      );
    }
    const replacementInUse = (
      await client.query(
        `SELECT 1
           FROM case_replacements r
           JOIN cases c ON c.id = r.case_id
          WHERE r.terminal_id = $1
            AND r.case_id <> $2
            AND c.status NOT IN ('delivered', 'cancelled')
          LIMIT 1`,
        [input.terminal_id, id],
      )
    ).rows[0];
    if (replacementInUse) {
      throw new ApiError(
        409,
        'REPLACEMENT_TERMINAL_IN_USE',
        'El terminal ya está asignado como reemplazo a un caso abierto',
      );
    }
    const active = (
      await client.query(
        `SELECT 1 FROM cases
          WHERE terminal_id = $1 AND status NOT IN ('delivered','cancelled') AND id <> $2`,
        [input.terminal_id, id],
      )
    ).rows[0];
    if (active) {
      throw new ApiError(409, 'TERMINAL_HAS_ACTIVE_CASE', 'El terminal de reemplazo tiene un caso activo');
    }

    const originalCoverage = (
      await client.query('SELECT * FROM coverages WHERE id = $1', [row.terminal_coverage_id])
    ).rows[0];
    if (!originalCoverage) {
      throw new ApiError(409, 'NO_COVERAGE', 'El caso no tiene cobertura para reemplazo');
    }
    if (originalCoverage.replacement_policy !== input.policy) {
      throw new ApiError(
        409,
        'POLICY_MISMATCH',
        `La cobertura registrada exige política "${originalCoverage.replacement_policy}"`,
      );
    }

    let coverageId;
    if (input.policy === 'new') {
      coverageId = (
        await client.query(
          `INSERT INTO coverages (brand, name, plan, months, exclusions, replacement_policy)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           RETURNING id`,
          [
            originalCoverage.brand,
            `Reemplazo de ${originalCoverage.name}`,
            originalCoverage.plan,
            originalCoverage.months,
            JSON.stringify(originalCoverage.exclusions),
            originalCoverage.replacement_policy,
          ],
        )
      ).rows[0].id;
    } else {
      coverageId = originalCoverage.id;
    }

    await client.query('UPDATE terminals SET coverage_id = $2 WHERE id = $1', [
      input.terminal_id,
      coverageId,
    ]);

    const replacement = (
      await client.query(
        `INSERT INTO case_replacements (case_id, client_id, terminal_id, policy, coverage_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [id, row.client_id, input.terminal_id, input.policy, coverageId, actor.id],
      )
    ).rows[0];

    let currentStatus = row.status;
    if (currentStatus !== 'ready') {
      await insertHistory(client, {
        caseId: id,
        from: currentStatus,
        to: 'ready',
        note: `Caso resuelto por reemplazo de terminal (política ${input.policy})`,
        actorId: actor.id,
      });
      currentStatus = 'ready';
      await client.query('UPDATE cases SET status = $2 WHERE id = $1', [id, currentStatus]);
    }

    await notifyCase(
      client,
      row,
      {
        template: 'replacement_registered',
        subject: `Relevo: reemplazo registrado del caso ${row.case_number}`,
        body:
          `El caso ${row.case_number} fue resuelto con un terminal de reemplazo ` +
          `${replacementTerminal.brand} ${replacementTerminal.model}.\n` +
          `Política aplicada: ${input.policy}. Recepción coordinará la entrega.`,
      },
    );

    await writeAudit(client, {
      actorId: actor.id,
      action: 'replacement.create',
      entityType: 'case',
      entityId: id,
      details: {
        replacement_id: replacement.id,
        terminal_id: input.terminal_id,
        policy: input.policy,
        coverage_id: coverageId,
      },
      ip,
    });

    return {
      replacement: {
        id: replacement.id,
        policy: input.policy,
        coverage_id: coverageId,
        terminal_id: input.terminal_id,
        created_at: iso(replacement.created_at),
      },
      status: currentStatus,
    };
  });
}

export async function getPublicTracking(caseNumber, token) {
  const row = (
    await query(
      `SELECT c.id, c.case_number, c.status, c.created_at, c.updated_at,
              c.diagnosis, c.problem_type, c.diagnosed_at,
              t.brand, t.model, c.tracking_token_hash
         FROM cases c JOIN terminals t ON t.id = c.terminal_id
        WHERE c.case_number = $1`,
      [caseNumber],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, 'TRACKING_NOT_FOUND', 'Caso o token inválidos');
  if (!safeEqualText(hashToken(token), row.tracking_token_hash)) {
    throw new ApiError(404, 'TRACKING_NOT_FOUND', 'Caso o token inválidos');
  }

  const [history, quote] = await Promise.all([
    query(
      `SELECT to_status, created_at FROM case_history
        WHERE case_id = $1 ORDER BY created_at, id`,
      [row.id],
    ),
    query(
      `SELECT * FROM case_quotes WHERE case_id = $1 AND status <> 'superseded'
        ORDER BY version DESC LIMIT 1`,
      [row.id],
    ),
  ]);

  let quoteItems = [];
  if (quote.rows[0]) {
    quoteItems = (
      await query('SELECT * FROM case_quote_items WHERE quote_id = $1 ORDER BY id', [
        quote.rows[0].id,
      ])
    ).rows;
  }

  return {
    case_number: row.case_number,
    status: row.status,
    received_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    terminal: { brand: row.brand, model: row.model },
    history: history.rows.map((item) => ({
      status: item.to_status,
      at: iso(item.created_at),
    })),
    diagnosis: row.diagnosis
      ? { text: row.diagnosis, problem_type: row.problem_type, diagnosed_at: iso(row.diagnosed_at) }
      : null,
    quote: quote.rows[0]
      ? {
          version: quote.rows[0].version,
          status: quote.rows[0].status,
          total: formatCents(quote.rows[0].total_cents),
          items: quoteItems.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            unit_price: formatCents(item.unit_price_cents),
            line_total: formatCents(item.line_total_cents),
          })),
        }
      : null,
  };
}

export { todayIso, LIVE_CASE_STATUSES };
