export class CoverageRuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CoverageRuleError';
    this.status = 400;
    this.code = 'COVERAGE_RULE_ERROR';
  }
}

export const BUSINESS_TIME_ZONE = 'America/El_Salvador';

/**
 * Fecha de negocio en El Salvador, no en UTC. Un caso evaluado a las 20:00
 * locales del 27 de octubre sigue siendo 27 aunque UTC ya marque el 28.
 */
export function todayIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Suma meses calendario conservando el último día válido del mes. */
export function addMonths(dateOnly, months) {
  if (!isValidDateOnly(dateOnly)) throw new CoverageRuleError('Fecha de compra inválida');
  const [year, month, day] = dateOnly.split('-').map(Number);
  const targetIndex = month - 1 + Number(months);
  const targetYear = year + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  const result = new Date(Date.UTC(targetYear, targetMonth, targetDay));
  return result.toISOString().slice(0, 10);
}

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Evalúa la garantía de un terminal. La decisión de si un administrador puede
 * autorizar una excepción se comprueba en la capa de rutas; aquí se exige que
 * toda excepción tenga motivo y se conserva la evaluación original.
 */
export function evaluateCoverage({
  coverage,
  purchaseDate,
  terminalBrand,
  problemType,
  excludedReason = null,
  coverageOverride = false,
  overrideReason = null,
  now = new Date(),
}) {
  if (!isValidDateOnly(purchaseDate)) {
    throw new CoverageRuleError('Fecha de compra inválida');
  }
  if (coverageOverride && !String(overrideReason || '').trim()) {
    throw new CoverageRuleError('Una excepción de cobertura requiere override_reason');
  }

  const reasons = [];
  const evaluation = {
    covered: false,
    decision: 'not_covered',
    coverage_id: coverage?.id ?? null,
    coverage_name: coverage?.name ?? null,
    coverage_plan: coverage?.plan ?? null,
    replacement_policy: coverage?.replacement_policy ?? null,
    coverage_start: purchaseDate,
    coverage_end: null,
    brand_match: null,
    within_period: null,
    exclusions: coverage?.exclusions ?? [],
    excluded_by_rule: false,
    excluded_reason: excludedReason || null,
    override: {
      applied: Boolean(coverageOverride),
      reason: overrideReason || null,
    },
    reasons,
    evaluated_at: new Date(now).toISOString(),
  };

  if (!coverage) {
    reasons.push('El terminal no tiene una cobertura asociada');
  } else {
    evaluation.coverage_end = addMonths(purchaseDate, coverage.months);
    evaluation.brand_match =
      !coverage.brand || normalized(coverage.brand) === normalized(terminalBrand);
    if (!evaluation.brand_match) {
      reasons.push(`La cobertura aplica a ${coverage.brand}, no a ${terminalBrand}`);
    }

    const today = todayIso(now);
    evaluation.within_period = today >= purchaseDate && today <= evaluation.coverage_end;
    if (today < purchaseDate) {
      reasons.push('La fecha de compra del terminal está en el futuro');
    } else if (today > evaluation.coverage_end) {
      reasons.push(`La cobertura venció el ${evaluation.coverage_end}`);
    }

    const exclusions = Array.isArray(coverage.exclusions) ? coverage.exclusions : [];
    const excludedByProblem = exclusions.some((item) => normalized(item) === normalized(problemType));
    evaluation.excluded_by_rule = excludedByProblem;
    if (excludedByProblem) {
      reasons.push(`El problema "${problemType}" está excluido por la cobertura`);
    }
  }

  if (excludedReason) {
    reasons.push(`Exclusión indicada: ${excludedReason}`);
  }

  const ruleCovered = Boolean(
    coverage &&
      evaluation.brand_match &&
      evaluation.within_period &&
      !evaluation.excluded_by_rule &&
      !excludedReason,
  );
  evaluation.covered = ruleCovered || Boolean(coverageOverride);

  if (coverageOverride) {
    evaluation.decision = 'override';
    reasons.push(`Excepción autorizada: ${overrideReason}`);
  } else if (evaluation.covered) {
    evaluation.decision = 'covered';
  } else {
    evaluation.decision = 'not_covered';
  }

  return evaluation;
}
