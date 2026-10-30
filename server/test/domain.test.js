import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths,
  evaluateCoverage,
  isValidDateOnly,
  todayIso,
} from '../domain/coverage.js';
import {
  assertTransition,
  canTransition,
  TransitionError,
} from '../domain/states.js';
import { formatCents, parseMoneyToCents } from '../domain/money.js';
import {
  fingerprintPayment,
  generateTrackingToken,
  hashToken,
  safeEqualText,
} from '../domain/tokens.js';
import { loadConfig } from '../config.js';
import { parsePagination } from '../lib/http.js';

const coverage = {
  id: 10,
  name: 'Garantía 12',
  plan: 'total',
  months: 12,
  exclusions: ['daño por líquidos', 'robo'],
  replacement_policy: 'new',
};

test('fecha de negocio usa America/El_Salvador, no UTC', () => {
  assert.equal(todayIso(new Date('2026-10-28T02:00:00.000Z')), '2026-10-27');
  assert.equal(todayIso(new Date('2026-10-28T05:59:59.000Z')), '2026-10-27');
  assert.equal(todayIso(new Date('2026-10-28T06:00:00.000Z')), '2026-10-28');
});

test('cobertura en el último día local sigue vigente aunque UTC ya cambió de día', () => {
  const evaluation = evaluateCoverage({
    coverage,
    purchaseDate: '2025-10-27',
    terminalBrand: 'Samsung',
    problemType: 'pantalla',
    now: new Date('2026-10-28T02:00:00.000Z'), // 27 oct 20:00 en El Salvador
  });
  assert.equal(evaluation.covered, true);
  assert.equal(evaluation.coverage_end, '2026-10-27');
  assert.equal(evaluation.within_period, true);
  assert.equal(evaluation.decision, 'covered');
});

test('cobertura vence al día siguiente local', () => {
  const evaluation = evaluateCoverage({
    coverage,
    purchaseDate: '2025-10-27',
    terminalBrand: 'Samsung',
    problemType: 'pantalla',
    now: new Date('2026-10-28T12:00:00.000Z'), // 28 oct 06:00 local
  });
  assert.equal(evaluation.covered, false);
  assert.equal(evaluation.within_period, false);
  assert.ok(evaluation.reasons.some((reason) => reason.includes('venció')));
});

test('cobertura valida marca, exclusiones y ausencia de póliza', () => {
  const brandMismatch = evaluateCoverage({
    coverage: { ...coverage, brand: 'Apple' },
    purchaseDate: '2026-09-01',
    terminalBrand: 'Samsung',
    problemType: 'pantalla',
    now: new Date('2026-10-27T12:00:00.000Z'),
  });
  assert.equal(brandMismatch.covered, false);
  assert.equal(brandMismatch.brand_match, false);

  const excluded = evaluateCoverage({
    coverage,
    purchaseDate: '2026-09-01',
    terminalBrand: 'Samsung',
    problemType: 'daño por líquidos',
    now: new Date('2026-10-27T12:00:00.000Z'),
  });
  assert.equal(excluded.covered, false);
  assert.equal(excluded.excluded_by_rule, true);

  const none = evaluateCoverage({
    coverage: null,
    purchaseDate: '2026-09-01',
    terminalBrand: 'Samsung',
    problemType: 'pantalla',
    now: new Date('2026-10-27T12:00:00.000Z'),
  });
  assert.equal(none.covered, false);
  assert.equal(none.decision, 'not_covered');
});

test('una excepción exige motivo y solo entonces cubre', () => {
  assert.throws(
    () =>
      evaluateCoverage({
        coverage: null,
        purchaseDate: '2026-09-01',
        terminalBrand: 'Samsung',
        problemType: 'pantalla',
        coverageOverride: true,
        now: new Date('2026-10-27T12:00:00.000Z'),
      }),
    /override_reason/,
  );

  const overridden = evaluateCoverage({
    coverage: { ...coverage, months: 1 },
    purchaseDate: '2026-01-01',
    terminalBrand: 'Samsung',
    problemType: 'daño por líquidos',
    coverageOverride: true,
    overrideReason: 'Autorización de gerencia, caso especial',
    now: new Date('2026-10-27T12:00:00.000Z'),
  });
  assert.equal(overridden.covered, true);
  assert.equal(overridden.decision, 'override');
  assert.equal(overridden.override.applied, true);
  assert.ok(overridden.reasons.some((reason) => reason.includes('Excepción autorizada')));
});

test('addMonths respeta fin de mes y valida fechas', () => {
  assert.equal(addMonths('2025-01-31', 1), '2025-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(isValidDateOnly('2026-02-29'), false);
  assert.equal(isValidDateOnly('2026-02-28'), true);
});

test('dinero se convierte a centavos sin errores de punto flotante', () => {
  assert.equal(parseMoneyToCents('0.10'), 10);
  assert.equal(parseMoneyToCents('12.3'), 1230);
  assert.equal(parseMoneyToCents('12'), 1200);
  assert.equal(parseMoneyToCents(0.1), 10);
});

test('dinero rechaza formatos ambiguos y negativos', () => {
  assert.throws(() => parseMoneyToCents('1.234'), /dos decimales/);
  assert.throws(() => parseMoneyToCents('-1.00'), /formato/);
  assert.throws(() => parseMoneyToCents('1e3'), /formato/);
  assert.throws(() => parseMoneyToCents('  '), /formato/);
  assert.throws(() => parseMoneyToCents(0, { allowZero: false }), /mayor que cero/);
  assert.equal(formatCents(1230), '12.30');
  assert.equal(formatCents(5), '0.05');
});

test('máquina de estados: camino cubierto y transiciones inválidas', () => {
  assert.equal(canTransition('received', 'diagnosing'), true);
  assert.equal(canTransition('received', 'ready'), false);
  assert.equal(
    assertTransition({
      from: 'diagnosing',
      to: 'repairing',
      context: { coverageEvaluated: true, covered: true },
    }),
    true,
  );
  assert.throws(
    () => assertTransition({ from: 'received', to: 'ready', context: {} }),
    (error) => error instanceof TransitionError && error.code === 'INVALID_TRANSITION',
  );
  assert.throws(
    () => assertTransition({ from: 'diagnosing', to: 'repairing', context: {} }),
    (error) => error.code === 'COVERAGE_NOT_EVALUATED',
  );
});

test('máquina de estados: fuera de cobertura exige cotización aceptada y pago completo', () => {
  const base = {
    from: 'awaiting_payment',
    to: 'repairing',
    context: {
      coverageEvaluated: true,
      covered: false,
      acceptedQuote: false,
      quoteTotalCents: 5000,
      paidCents: 0,
    },
  };
  assert.throws(
    () => assertTransition(base),
    (error) => error.code === 'QUOTE_NOT_ACCEPTED',
  );
  assert.throws(
    () =>
      assertTransition({
        ...base,
        context: { ...base.context, acceptedQuote: true, paidCents: 4999 },
      }),
    (error) => error.code === 'PAYMENT_REQUIRED' && error.details.balance_cents === 1,
  );
  assert.equal(
    assertTransition({
      ...base,
      context: { ...base.context, acceptedQuote: true, paidCents: 5000 },
    }),
    true,
  );
  assert.equal(
    assertTransition({
      ...base,
      context: { ...base.context, acceptedQuote: true, paidCents: 6000 },
    }),
    true,
  );
});

test('máquina de estados: entrega, préstamo y casos cerrados', () => {
  assert.throws(
    () =>
      assertTransition({
        from: 'ready',
        to: 'delivered',
        context: { activeLoan: true },
      }),
    (error) => error.code === 'LOAN_NOT_RETURNED',
  );
  assert.equal(
    assertTransition({ from: 'ready', to: 'delivered', context: { activeLoan: false } }),
    true,
  );
  assert.throws(
    () => assertTransition({ from: 'repairing', to: 'delivered', context: {} }),
    (error) => error.code === 'DELIVERY_REQUIRES_READY',
  );
  assert.throws(
    () => assertTransition({ from: 'cancelled', to: 'received', context: {} }),
    (error) => error.code === 'CASE_CANCELLED',
  );
  assert.throws(
    () => assertTransition({ from: 'delivered', to: 'cancelled', context: {} }),
    (error) => error.code === 'CASE_DELIVERED',
  );
  assert.throws(
    () =>
      assertTransition({
        from: 'awaiting_approval',
        to: 'awaiting_payment',
        context: { acceptedQuote: false },
      }),
    (error) => error.code === 'QUOTE_NOT_ACCEPTED',
  );
});

test('tokens de seguimiento no se repiten y el hash es estable', () => {
  const a = generateTrackingToken();
  const b = generateTrackingToken();
  assert.notEqual(a, b);
  assert.equal(hashToken(a), hashToken(a));
  assert.notEqual(hashToken(a), hashToken(b));
  assert.equal(safeEqualText(a, a), true);
  assert.equal(safeEqualText(a, b), false);
  assert.equal(safeEqualText(a, null), false);
});

test('huella de pago cambia con monto, método o referencia', () => {
  const base = { amountCents: 1000, method: 'cash', reference: 'R-1' };
  assert.equal(fingerprintPayment(base), fingerprintPayment({ ...base }));
  assert.notEqual(fingerprintPayment(base), fingerprintPayment({ ...base, amountCents: 1001 }));
  assert.notEqual(fingerprintPayment(base), fingerprintPayment({ ...base, method: 'card' }));
  assert.notEqual(fingerprintPayment(base), fingerprintPayment({ ...base, reference: 'R-2' }));
});

test('loadConfig usa el env recibido y respeta PORT=3102', () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PORT: '3102',
    DATABASE_URL: 'postgres://user:pass@127.0.0.1:55432/relevo_test',
    NOTIFICATIONS_MODE: 'local',
    COOKIE_SECURE: 'false',
    LOGIN_RATE_LIMIT: '7',
    CORS_ORIGINS: 'http://localhost:5173',
    TRUST_PROXY: 'true',
  });
  assert.equal(cfg.port, 3102);
  assert.equal(cfg.env, 'test');
  assert.equal(cfg.cookieSecure, false);
  assert.equal(cfg.loginRateLimit, 7);
  assert.equal(cfg.trustProxy, 1);
  assert.deepEqual(cfg.corsOrigins, ['http://localhost:5173']);
  assert.equal(loadConfig({ NODE_ENV: 'development' }).cookieSecure, false);
  assert.equal(loadConfig({ NODE_ENV: 'production', TRUST_PROXY: 'true' }).cookieSecure, true);
  assert.equal(loadConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'true', TRUST_PROXY: 'true' }).trustProxy, 1);
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'false', TRUST_PROXY: 'true' }),
    /COOKIE_SECURE debe ser true en producción/,
  );
  assert.equal(loadConfig({ NODE_ENV: 'production' }).cookieSecure, true);
  assert.equal(loadConfig({ NODE_ENV: 'production' }).trustProxy, false);
  assert.throws(() => loadConfig({ ...process.env, PORT: 'no-numero' }), /PORT inválida/);
});

test('paginación limita pageSize y rechaza valores inválidos', () => {
  assert.deepEqual(parsePagination({ page: '2', pageSize: '10' }), {
    page: 2,
    pageSize: 10,
    offset: 10,
  });
  assert.throws(() => parsePagination({ pageSize: '101' }), /no puede superar/);
  assert.throws(() => parsePagination({ page: '0' }), /page inválido/);
});
