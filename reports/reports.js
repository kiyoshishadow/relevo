/**
 * Definiciones SQL de los 16 reportes. Todas las consultas:
 * - Son completamente parametrizadas ($1..$n); ningún valor dinámico se
 *   concatenan al texto SQL.
 * - Rinden dinero en centavos enteros (bigint), sin aritmética de punto flotante.
 * - Normalizan fechas/grupos en America/El_Salvador; rangos inclusivos: para
 *   columnas timestamptz se usa >= inicio(día) y < inicio(día +1); para columnas
 *   DATE se usa >= y <=.
 * - Evitan doble conteo por JOIN: agrupaciones hechas por subconsulta sobre la
 *   entidad mutex o con joins 1:1 (clients, terminals, users, coverages son
 *   únicos por case/loan/terminal). Los IMEI se agregan en subconsulta.
 * - Garantizan conteos cero en los universos fijos (estados, técnicos activos).
 *
 * Limita filas sí o sí con guardia explícita: runReport consulta LIMIT (n+1) por
 * reporte y rechaza con 413 REPORT_TOO_LARGE si el resultado excede el límite
 * (pidiendo acotar filtros); nunca se entrega un reporte incompleto ni un
 * resumen calculado sobre un subconjunto.
 * Sin límite SQL y con límite declarado solo si la cardinalidad del grupo está
 * garantizada por el esquema (estados del enum, métodos de pago del enum).
 * Nunca se seleccionan columnas sensibles: password_hash, tracking_token_hash,
 * csrf_token, idempotency_key, request_hash, sessions, audit_log.
 */
import { TZ } from './format.js';

const ROW_LIMIT = 10000; // tope por reporte; runReport consulta LIMIT n+1 y rechaza si excede

function makeParams() {
  const values = [];
  return {
    list: values,
    add(value) {
      values.push(value);
      return `$${values.length}`;
    },
  };
}

/**
 * Rango inclusivo. `dateColumn=true` cuando la columna es DATE (p. ej.
 * purchase_date); si no, la columna es timestamptz.
 */
function range(columnExpr, filters, params, { dateColumn = false } = {}) {
  const conditions = [];
  if (dateColumn) {
    if (filters.from !== undefined) {
      conditions.push(`${columnExpr} >= ${params.add(filters.from)}::date`);
    }
    if (filters.to !== undefined) {
      conditions.push(`${columnExpr} <= ${params.add(filters.to)}::date`);
    }
  } else {
    if (filters.from !== undefined) {
      conditions.push(
        `${columnExpr} >= (${params.add(filters.from)}::date)::timestamp AT TIME ZONE '${TZ}'`,
      );
    }
    if (filters.to !== undefined) {
      conditions.push(
        `${columnExpr} < ((${params.add(filters.to)}::date + 1)::timestamp AT TIME ZONE '${TZ}')`,
      );
    }
  }
  return conditions.length > 0 ? conditions.join(' AND ') : 'true';
}

const dayInTz = (columnExpr) => `(${columnExpr} AT TIME ZONE '${TZ}')::date`;
const monthInTz = (columnExpr) =>
  `date_trunc('month', ${columnExpr} AT TIME ZONE '${TZ}')::date`;
const weekInTz = (columnExpr) =>
  `date_trunc('week', ${columnExpr} AT TIME ZONE '${TZ}')::date`;

const sumColumn = (key) => (rows) =>
  rows.reduce((total, row) => {
    const value = Number(row[key]);
    return Number.isFinite(value) ? total + value : total;
  }, 0);

export const REPORT_DEFINITIONS = {
  'clientes-registrados': {
    limit: ROW_LIMIT,
    columns: [
      { key: 'id', label: 'ID', type: 'integer' },
      { key: 'full_name', label: 'Nombre', type: 'text' },
      { key: 'document_id', label: 'Documento', type: 'text' },
      { key: 'phone', label: 'Teléfono', type: 'text' },
      { key: 'email', label: 'Correo', type: 'text' },
      { key: 'address', label: 'Dirección', type: 'text' },
      { key: 'active', label: 'Activo', type: 'boolean' },
      { key: 'registered_on', label: 'Registrado', type: 'date' },
    ],
    build(filters) {
      const params = makeParams();
      return {
        sql: `SELECT c.id, c.full_name, c.document_id, c.phone, c.email, c.address,
                     c.active, ${dayInTz('c.created_at')}::text AS registered_on
                FROM clients c
               WHERE ${range('c.created_at', filters, params)}
               ORDER BY ${dayInTz('c.created_at')}, c.id
               LIMIT ${ROW_LIMIT + 1}`,
        params: params.list,
      };
    },
    summarize(rows) {
      return { clientes: rows.length };
    },
  },

  'reparaciones-por-periodo': {
    limit: ROW_LIMIT,
    columns: [
      { key: 'day', label: 'Día (El Salvador)', type: 'date' },
      { key: 'cases', label: 'Casos', type: 'integer' },
      { key: 'delivered', label: 'Entregados', type: 'integer' },
    ],
    build(filters) {
      const params = makeParams();
      return {
        sql: `SELECT ${dayInTz('ca.created_at')}::text AS day,
                     count(*)::int AS cases,
                     count(*) FILTER (WHERE ca.status = 'delivered')::int AS delivered
                FROM cases ca
               WHERE ${range('ca.created_at', filters, params)}
               GROUP BY ${dayInTz('ca.created_at')}
               ORDER BY ${dayInTz('ca.created_at')}
               LIMIT ${ROW_LIMIT + 1}`,
        params: params.list,
      };
    },
    summarize(rows) {
      return {
        dias: rows.length,
        casos: sumColumn('cases')(rows),
        entregados: sumColumn('delivered')(rows),
      };
    },
  },

  'ingresos-totales': {
    limit: 4, // cardinalidad garantizada: métodos del enum de payments
    columns: [
      { key: 'method_label', label: 'Método', type: 'text' },
      { key: 'payments', label: 'Pagos', type: 'integer' },
      { key: 'income_cents', label: 'Ingreso (USD)', type: 'cents' },
    ],
    build(filters) {
      const params = makeParams();
      return {
        sql: `SELECT CASE p.method
                        WHEN 'cash' THEN 'Efectivo'
                        WHEN 'card' THEN 'Tarjeta'
                        WHEN 'transfer' THEN 'Transferencia'
                        ELSE 'Otro' END AS method_label,
                     count(*)::int AS payments,
                     COALESCE(sum(p.amount_cents), 0)::bigint AS income_cents
                FROM payments p
               WHERE ${range('p.created_at', filters, params)}
               GROUP BY p.method
               ORDER BY p.method`,
        params: params.list,
      };
    },
    summarize(rows) {
      return {
        pagos: sumColumn('payments')(rows),
        ingreso_cents: sumColumn('income_cents')(rows),
      };
    },
  },

  'terminales-ingresados': {
    limit: ROW_LIMIT,
    columns: [
      { key: 'case_number', label: 'Número', type: 'text' },
      { key: 'client_name', label: 'Cliente', type: 'text' },
      { key: 'brand', label: 'Marca', type: 'text' },
      { key: 'model', label: 'Modelo', type: 'text' },
      { key: 'reported_problem', label: 'Problema reportado', type: 'text' },
      { key: 'technician_name', label: 'Técnico', type: 'text' },
      { key: 'status', label: 'Estado', type: 'text' },
      { key: 'created_at', label: 'Ingresado', type: 'datetime' },
    ],
    build(filters) {
      const params = makeParams();
      const conditions = [range('ca.created_at', filters, params)];
      if (filters.brand !== undefined) {
        conditions.push(`lower(t.brand) = lower(${params.add(filters.brand)}::text)`);
      }
      if (filters.technician_id !== undefined) {
        conditions.push(`ca.technician_id = ${params.add(filters.technician_id)}::bigint`);
      }
      return {
        sql: `SELECT ca.case_number, c.full_name AS client_name, t.brand, t.model,
                     ca.reported_problem, u.full_name AS technician_name,
                     ca.status, ca.created_at
                FROM cases ca
                JOIN clients c ON c.id = ca.client_id
                JOIN terminals t ON t.id = ca.terminal_id
                LEFT JOIN users u ON u.id = ca.technician_id
               WHERE ${conditions.join(' AND ')}
               ORDER BY ca.created_at DESC, ca.id DESC
               LIMIT ${ROW_LIMIT + 1}`,
        params: params.list,
      };
    },
    summarize(rows) {
      return { casos: rows.length };
    },
  },

  'reparaciones-por-tecnico': {
    limit: ROW_LIMIT,
    columns: [
      { key: 'technician_id', label: 'ID técnico', type: 'integer' },
      { key: 'technician_name', label: 'Técnico', type: 'text' },
      { key: 'cases', label: 'Casos', type: 'integer' },
      { key: 'delivered', label: 'Entregados', type: 'integer' },
      { key: 'active_cases', label: 'Activos', type: 'integer' },
    ],
    build(filters) {
      const params = makeParams();
      // El rango va en el ON del LEFT JOIN para mantener técnicos con 0 casos.
      const rangeFragment = range('ca.created_at', filters, params);
      const technicianFragment =
        filters.technician_id !== undefined
          ? ` AND u.id = ${params.add(filters.technician_id)}::bigint`
          : '';
      return {
        sql: `SELECT u.id AS technician_id, u.full_name AS technician_name,
                     count(ca.id)::int AS cases,
                     count(ca.id) FILTER (WHERE ca.status = 'delivered')::int AS delivered,
                     count(ca.id) FILTER (WHERE ca.status NOT IN ('delivered','cancelled'))::int AS active_cases
                FROM users u
                LEFT JOIN cases ca
                       ON ca.technician_id = u.id
                      AND ${rangeFragment}
               WHERE u.role = 'technician'
                 AND u.active${technicianFragment}
               GROUP BY u.id, u.full_name
               ORDER BY cases DESC, technician_name
               LIMIT ${ROW_LIMIT + 1}`,
        params: params.list,
      };
    },
    summarize(rows) {
      return {
        tecnicos: rows.length,
        casos: sumColumn('cases')(rows),
        entregados: sumColumn('delivered')(rows),
      };
    },
  },

  'reparaciones-por-problema': {
    limit: ROW_LIMIT,
    columns: [
      { key: 'problem_type', label: 'Tipo de problema', type: 'text' },
      { key: 'cases', label: 'Casos', type: 'integer' },
    ],
    build(filters) {
      const params = makeParams();
      return {
        sql: `SELECT COALESCE(NULLIF(btrim(ca.problem_type), ''), 'sin diagnóstico') AS problem_type,
                     count(*)::int AS cases
                FROM cases ca
               WHERE ${range('ca.created_at', filters, params)}
               GROUP BY 1
               ORDER BY cases DESC, problem_type
               LIMIT ${ROW_LIMIT + 1}`,
        params: params.list,
      };
    },
    summarize(rows) {
      return { tipos: rows.length, casos: sumColumn('cases')(rows) };
    },
  },

  'terminales-por-marca': {
    limit: ROW_LIMIT,
    columns: [
      { key: 'brand', label: 'Marca', type: 'text' },
      { key: 'terminals', label: 'Terminales', type: 'integer' },
      { key: 'with_coverage', label: 'Con cobertura', type: 'integer' },
    ],
    build(filters) {
      const params = makeParams();
      const brandCondition =
        filters.brand !== undefined
          ? ` AND lower(t.brand) = lower(${params.add(filters.brand)}::text)`
          : '';
      return {
        sql: `SELECT t.brand, count(*)::int AS terminals,
                     count(*) FILTER (WHERE t.coverage_id IS NOT NULL)::int AS with_coverage
                FROM terminals t
               WHERE ${range('t.created_at', filters, params)}${brandCondition}
               GROUP BY t.brand
               ORDER BY terminals DESC, t.brand
               LIMIT ${ROW_LIMIT + 1}`,
        params: params.list,
      };
    },
    summarize(rows) {
      return { marcas: rows.length, terminales: sumColumn('terminals')(rows) };
    },
  },

  'reparaciones-por-cobertura': {
    limit: ROW_LIMIT,
    columns: [
      { key: 'coverage_name', label: 'Cobertura', type: 'text' },
      { key: 'evaluation', label: 'Evaluación', type: 'text' },
      { key: 'cases', label: 'Casos', type: 'integer' },
    ],
    build(filters) {
      const params = makeParams();
      return {
        sql: `SELECT COALESCE(cv.name, 'sin cobertura') AS coverage_name,
                     CASE
                       WHEN ca.coverage_covered IS TRUE THEN 'cubierto'
                       WHEN ca.coverage_covered IS FALSE THEN 'no cubierto'
                       ELSE 'sin evaluación' END AS evaluation,
                     count(*)::int AS cases
                FROM cases ca
                JOIN terminals t ON t.id = ca.terminal_id
                LEFT JOIN coverages cv ON cv.id = t.coverage_id
               WHERE ${range('ca.created_at', filters, params)}
               GROUP BY 1, 2
               ORDER BY coverage_name, evaluation
               LIMIT ${ROW_LIMIT + 1}`,
        params: params.list,
      };
    },
    summarize(rows) {
      return { casos: sumColumn('cases')(rows) };
    },
  },

  'historial-reparaciones': {
    limit: ROW_LIMIT,
    columns: [
      { key: 'case_number', label: 'Número', type: 'text' },
      { key: 'from_status', label: 'De', type: 'text' },
      { key: 'to_status', label: 'A', type: 'text' },
      { key: 'note', label: 'Nota', type: 'text' },
      { key: 'changed_by', label: 'Usuario', type: 'text' },
      { key: 'created_at', label: 'Fecha', type: 'datetime' },
    ],
    build(filters) {
      const params = makeParams();
      const conditions = [range('ch.created_at', filters, params)];
      if (filters.technician_id !== undefined) {
        conditions.push(
          `ca.technician_id = ${params.add(filters.technician_id)}::bigint`,
        );
      }
      return {
        sql: `SELECT ca.case_number, ch.from_status, ch.to_status, ch.note,
                     u.full_name AS changed_by, ch.created_at
                FROM case_history ch
                JOIN cases ca ON ca.id = ch.case_id
                LEFT JOIN users u ON u.id = ch.changed_by
               WHERE ${conditions.join(' AND ')}
               ORDER BY ch.created_at, ch.id
               LIMIT ${ROW_LIMIT + 1}`,
        params: params.list,
      };
    },
    summarize(rows) {
      return { eventos: rows.length };
    },
  },

  'pagos-por-reparacion': {
    limit: ROW_LIMIT,
    columns: [
      { key: 'case_number', label: 'Número de caso', type: 'text' },
      { key: 'client_name', label: 'Cliente', type: 'text' },
      { key: 'amount_cents', label: 'Monto (USD)', type: 'cents' },
      { key: 'method_label', label: 'Método', type: 'text' },
      { key: 'reference', label: 'Referencia', type: 'text' },
      { key: 'created_at', label: 'Fecha', type: 'datetime' },
    ],
    build(filters) {
      const params = makeParams();
      return {
        // Sin idempotency_key ni request_hash: nunca salen de la base de datos.
        sql: `SELECT ca.case_number, c.full_name AS client_name,
                     p.amount_cents, p.method AS method_label, p.reference,
                     p.created_at
                FROM payments p
                JOIN cases ca ON ca.id = p.case_id
                JOIN clients c ON c.id = ca.client_id
               WHERE ${range('p.created_at', filters, params)}
               ORDER BY p.created_at, p.id
               LIMIT ${ROW_LIMIT + 1}`,
        params: params.list,
      };
    },
    summarize(rows) {
      return {
        pagos: rows.length,
        ingreso_cents: sumColumn('amount_cents')(rows),
      };
    },
  },

  'registro-terminales': {
    limit: ROW_LIMIT,
    columns: [
      { key: 'terminal_id', label: 'ID', type: 'integer' },
      { key: 'brand', label: 'Marca', type: 'text' },
      { key: 'model', label: 'Modelo', type: 'text' },
      { key: 'imeis', label: 'IMEI', type: 'text' },
      { key: 'client_name', label: 'Cliente', type: 'text' },
      { key: 'purchase_date', label: 'Compra', type: 'date' },
      { key: 'coverage_name', label: 'Cobertura', type: 'text' },
      { key: 'registered_on', label: 'Registrado', type: 'date' },
    ],
    build(filters) {
      const params = makeParams();
      const brandCondition =
        filters.brand !== undefined
          ? ` AND lower(t.brand) = lower(${params.add(filters.brand)}::text)`
          : '';
      return {
        sql: `SELECT t.id AS terminal_id, t.brand, t.model,
                     COALESCE((SELECT string_agg(i.imei, ', ' ORDER BY i.imei)
                                 FROM terminal_imeis i
                                WHERE i.terminal_id = t.id), 'sin IMEI') AS imeis,
                     c.full_name AS client_name,
                     t.purchase_date::text AS purchase_date,
                     COALESCE(cv.name, 'sin cobertura') AS coverage_name,
                     ${dayInTz('t.created_at')}::text AS registered_on
                FROM terminals t
                JOIN clients c ON c.id = t.client_id
                LEFT JOIN coverages cv ON cv.id = t.coverage_id
               WHERE ${range('t.created_at', filters, params, { dateColumn: false })}${brandCondition}
               ORDER BY t.created_at, t.id
               LIMIT ${ROW_LIMIT + 1}`,
        params: params.list,
      };
    },
    summarize(rows) {
      return { terminales: rows.length };
    },
  },

  prestamos: {
    limit: ROW_LIMIT,
    columns: [
      { key: 'asset_tag', label: 'Equipo', type: 'text' },
      { key: 'device_brand', label: 'Marca equipo', type: 'text' },
      { key: 'device_model', label: 'Modelo equipo', type: 'text' },
      { key: 'case_number', label: 'Número de caso', type: 'text' },
      { key: 'condition_out', label: 'Condición al salir', type: 'text' },
      { key: 'condition_in', label: 'Condición al regresar', type: 'text' },
      { key: 'estado', label: 'Estado', type: 'text' },
      { key: 'loaned_at', label: 'Prestado', type: 'datetime' },
      { key: 'returned_at', label: 'Devuelto', type: 'datetime' },
    ],
    build(filters) {
      const params = makeParams();
      return {
        sql: `SELECT d.asset_tag, d.brand AS device_brand, d.model AS device_model,
                     ca.case_number, l.condition_out, l.condition_in,
                     CASE WHEN l.returned_at IS NULL THEN 'en préstamo'
                          ELSE 'devuelto' END AS estado,
                     l.loaned_at, l.returned_at
                FROM loans l
                JOIN loan_devices d ON d.id = l.loan_device_id
                JOIN cases ca ON ca.id = l.case_id
               WHERE ${range('l.loaned_at', filters, params)}
               ORDER BY l.loaned_at DESC, l.id DESC
               LIMIT ${ROW_LIMIT + 1}`,
        params: params.list,
      };
    },
    summarize(rows) {
      return {
        prestamos: rows.length,
        pendientes: rows.filter((row) => row.returned_at === null).length,
      };
    },
  },

  'ingresos-diarios': {
    limit: ROW_LIMIT,
    columns: [
      { key: 'dia', label: 'Día (El Salvador)', type: 'date' },
      { key: 'payments', label: 'Pagos', type: 'integer' },
      { key: 'income_cents', label: 'Ingreso (USD)', type: 'cents' },
    ],
    build(filters) {
      const params = makeParams();
      return {
        sql: `SELECT ${dayInTz('p.created_at')}::text AS dia,
                     count(*)::int AS payments,
                     COALESCE(sum(p.amount_cents), 0)::bigint AS income_cents
                FROM payments p
               WHERE ${range('p.created_at', filters, params)}
               GROUP BY ${dayInTz('p.created_at')}
               ORDER BY ${dayInTz('p.created_at')}
               LIMIT ${ROW_LIMIT + 1}`,
        params: params.list,
      };
    },
    summarize(rows) {
      return {
        dias: rows.length,
        pagos: sumColumn('payments')(rows),
        ingreso_cents: sumColumn('income_cents')(rows),
      };
    },
  },

  'ingresos-semanales': {
    limit: ROW_LIMIT,
    columns: [
      { key: 'semana', label: 'Semana (inicio lunes)', type: 'date' },
      { key: 'payments', label: 'Pagos', type: 'integer' },
      { key: 'income_cents', label: 'Ingreso (USD)', type: 'cents' },
    ],
    build(filters) {
      const params = makeParams();
      return {
        sql: `SELECT ${weekInTz('p.created_at')}::text AS semana,
                     count(*)::int AS payments,
                     COALESCE(sum(p.amount_cents), 0)::bigint AS income_cents
                FROM payments p
               WHERE ${range('p.created_at', filters, params)}
               GROUP BY ${weekInTz('p.created_at')}
               ORDER BY ${weekInTz('p.created_at')}
               LIMIT ${ROW_LIMIT + 1}`,
        params: params.list,
      };
    },
    summarize(rows) {
      return {
        semanas: rows.length,
        pagos: sumColumn('payments')(rows),
        ingreso_cents: sumColumn('income_cents')(rows),
      };
    },
  },

  'ingresos-mensuales': {
    limit: ROW_LIMIT,
    columns: [
      { key: 'mes', label: 'Mes', type: 'date' },
      { key: 'payments', label: 'Pagos', type: 'integer' },
      { key: 'income_cents', label: 'Ingreso (USD)', type: 'cents' },
    ],
    build(filters) {
      const params = makeParams();
      return {
        sql: `SELECT ${monthInTz('p.created_at')}::text AS mes,
                     count(*)::int AS payments,
                     COALESCE(sum(p.amount_cents), 0)::bigint AS income_cents
                FROM payments p
               WHERE ${range('p.created_at', filters, params)}
               GROUP BY ${monthInTz('p.created_at')}
               ORDER BY ${monthInTz('p.created_at')}
               LIMIT ${ROW_LIMIT + 1}`,
        params: params.list,
      };
    },
    summarize(rows) {
      return {
        meses: rows.length,
        pagos: sumColumn('payments')(rows),
        ingreso_cents: sumColumn('income_cents')(rows),
      };
    },
  },

  'reparaciones-por-estado': {
    limit: 8, // cardinalidad garantizada: 8 estados del enum
    columns: [
      { key: 'estado', label: 'Estado', type: 'text' },
      { key: 'casos', label: 'Casos', type: 'integer' },
    ],
    build(filters) {
      const params = makeParams();
      const statuses = [
        'received',
        'diagnosing',
        'awaiting_approval',
        'awaiting_payment',
        'repairing',
        'ready',
        'delivered',
        'cancelled',
      ];
      const valuesSql = statuses.map(
        (status, index) => `('${status}', ${params.add(index + 1)})`,
      );
      return {
        // Universo fijo de estados: siempre aparecen los 8, con conteo cero.
        sql: `WITH estados(estado, ord) AS (VALUES ${valuesSql.join(', ')})
              SELECT e.estado, count(ca.id)::int AS casos
                FROM estados e
                LEFT JOIN cases ca
                       ON ca.status = e.estado
                      AND ${range('ca.created_at', filters, params)}
               GROUP BY e.estado, e.ord
               ORDER BY e.ord`,
        params: params.list,
      };
    },
    summarize(rows) {
      return { casos: sumColumn('casos')(rows) };
    },
  },
};

/** Metadatos de filtros documentados por slug. */
export const REPORT_FILTER_DOC = {
  from: { name: 'from', label: 'Desde', type: 'date' },
  to: { name: 'to', label: 'Hasta', type: 'date' },
  technician_id: { name: 'technician_id', label: 'Técnico', type: 'id' },
  brand: { name: 'brand', label: 'Marca', type: 'text' },
};
