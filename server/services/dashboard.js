import { query } from '../db/pool.js';
import { CASE_STATUSES } from '../domain/states.js';
import { formatCents } from '../domain/money.js';
import { iso } from '../lib/http.js';

export async function getDashboard(actor) {
  const isTechnician = actor.role === 'technician';
  const caseFilter = isTechnician ? 'WHERE c.technician_id = $1' : '';
  const params = isTechnician ? [actor.id] : [];

  const [statusRows, totals, income, recent, loansOut, deviceModels] = await Promise.all([
    query(
      `SELECT c.status, count(*)::int AS count
         FROM cases c ${caseFilter}
        GROUP BY c.status`,
      params,
    ),
    query(
      `SELECT
         (SELECT count(*)::int FROM clients WHERE active = true) AS clients,
         (SELECT count(*)::int FROM terminals) AS terminals,
         (SELECT count(*)::int FROM cases c ${caseFilter}) AS cases`,
      params,
    ),
    query(
      `SELECT COALESCE(sum(p.amount_cents), 0)::bigint AS income_cents
         FROM payments p
         JOIN cases c ON c.id = p.case_id
         ${caseFilter}`,
      params,
    ),
    query(
      `SELECT c.id, c.case_number, c.status, c.created_at,
              cl.full_name AS client_name, t.brand, t.model
         FROM cases c
         JOIN clients cl ON cl.id = c.client_id
         JOIN terminals t ON t.id = c.terminal_id
         ${caseFilter}
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT 6`,
      params,
    ),
    query(
      `SELECT count(*)::int AS loans_out
         FROM loans l JOIN cases c ON c.id = l.case_id
        WHERE l.returned_at IS NULL ${isTechnician ? 'AND c.technician_id = $1' : ''}`,
      params,
    ),
    query(
      `SELECT t.brand, t.model,
              count(DISTINCT t.id)::int AS terminal_count,
              count(c.id)::int AS case_count
         FROM terminals t
         LEFT JOIN cases c ON c.terminal_id = t.id ${isTechnician ? 'AND c.technician_id = $1' : ''}
         ${isTechnician ? 'WHERE EXISTS (SELECT 1 FROM cases assigned WHERE assigned.terminal_id = t.id AND assigned.technician_id = $1)' : ''}
        GROUP BY t.brand, t.model
        ORDER BY lower(t.brand), lower(t.model)`,
      params,
    ),
  ]);

  const counts = Object.fromEntries(CASE_STATUSES.map((status) => [status, 0]));
  for (const row of statusRows.rows) counts[row.status] = row.count;
  const totalsRow = totals.rows[0];
  counts.total_cases = totalsRow.cases;

  return {
    counts,
    totals: {
      clients: totalsRow.clients,
      terminals: totalsRow.terminals,
      cases: totalsRow.cases,
    },
    recent_cases: recent.rows.map((row) => ({
      id: row.id,
      case_number: row.case_number,
      status: row.status,
      created_at: iso(row.created_at),
      client_name: row.client_name,
      terminal: { brand: row.brand, model: row.model },
    })),
    // Minimal model catalog for the dashboard's illustrative 3D device lab.
    // It deliberately excludes client, IMEI and other identifying details.
    device_models: deviceModels.rows.map((row) => ({
      brand: row.brand,
      model: row.model,
      terminal_count: row.terminal_count,
      case_count: row.case_count,
    })),
    income_cents: Number(income.rows[0].income_cents),
    income: formatCents(income.rows[0].income_cents),
    loans_out: loansOut.rows[0].loans_out,
  };
}
