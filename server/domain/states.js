export const CASE_STATUSES = Object.freeze([
  'received',
  'diagnosing',
  'awaiting_approval',
  'awaiting_payment',
  'repairing',
  'ready',
  'delivered',
  'cancelled',
]);

export const TERMINAL_STATUSES = Object.freeze(['delivered', 'cancelled']);

export const ALLOWED_TRANSITIONS = Object.freeze({
  received: Object.freeze(['diagnosing', 'cancelled']),
  diagnosing: Object.freeze(['awaiting_approval', 'awaiting_payment', 'repairing', 'cancelled']),
  awaiting_approval: Object.freeze(['awaiting_payment', 'repairing', 'cancelled']),
  awaiting_payment: Object.freeze(['repairing', 'cancelled']),
  repairing: Object.freeze(['ready', 'cancelled']),
  ready: Object.freeze(['delivered', 'cancelled']),
  delivered: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export class TransitionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
    this.status = 409;
    this.details = details;
  }
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from, to) {
  return Boolean(ALLOWED_TRANSITIONS[from]?.includes(to));
}

/**
 * Valida una transición de estado con las garantías del contrato.
 * context: { coverageEvaluated, covered, acceptedQuote, paidCents,
 *            quoteTotalCents, activeLoan }
 */
export function assertTransition({ from, to, context = {} }) {
  if (!CASE_STATUSES.includes(from)) {
    throw new TransitionError('INVALID_STATUS', `Estado de origen desconocido: ${from}`);
  }
  if (!CASE_STATUSES.includes(to)) {
    throw new TransitionError('INVALID_STATUS', `Estado de destino desconocido: ${to}`);
  }
  if (from === to) {
    throw new TransitionError('SAME_STATUS', 'El caso ya se encuentra en ese estado');
  }
  if (from === 'cancelled') {
    throw new TransitionError('CASE_CANCELLED', 'Un caso cancelado no puede reabrirse');
  }
  if (from === 'delivered') {
    throw new TransitionError('CASE_DELIVERED', 'Un caso entregado no admite más transiciones');
  }

  if (!canTransition(from, to)) {
    if (to === 'delivered' && from !== 'ready') {
      throw new TransitionError('DELIVERY_REQUIRES_READY', 'La entrega exige que el caso esté listo');
    }
    throw new TransitionError(
      'INVALID_TRANSITION',
      `Transición no permitida: ${from} -> ${to}`,
      { allowed: ALLOWED_TRANSITIONS[from] || [] },
    );
  }

  if (to === 'repairing') {
    if (!context.coverageEvaluated) {
      throw new TransitionError(
        'COVERAGE_NOT_EVALUATED',
        'Debe registrarse el diagnóstico y evaluar la cobertura antes de reparar',
      );
    }
    if (!context.covered) {
      if (!context.acceptedQuote) {
        throw new TransitionError(
          'QUOTE_NOT_ACCEPTED',
          'Un caso fuera de cobertura requiere una cotización aceptada',
        );
      }
      const paid = Number(context.paidCents || 0);
      const total = Number(context.quoteTotalCents || 0);
      if (paid < total) {
        throw new TransitionError(
          'PAYMENT_REQUIRED',
          'Un caso fuera de cobertura requiere pago completo antes de reparar',
          { paid_cents: paid, quote_total_cents: total, balance_cents: Math.max(0, total - paid) },
        );
      }
    }
  }

  if (to === 'awaiting_payment' && !context.acceptedQuote) {
    throw new TransitionError(
      'QUOTE_NOT_ACCEPTED',
      'No se puede esperar pago sin una cotización aceptada',
    );
  }

  if (to === 'delivered') {
    if (from !== 'ready') {
      throw new TransitionError('DELIVERY_REQUIRES_READY', 'La entrega exige que el caso esté listo');
    }
    if (context.activeLoan) {
      throw new TransitionError(
        'LOAN_NOT_RETURNED',
        'No se puede entregar el caso mientras exista un préstamo activo',
      );
    }
  }

  return true;
}
