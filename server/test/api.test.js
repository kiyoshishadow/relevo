import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const databaseUrl = process.env.TEST_DATABASE_URL;
const hasDatabase = Boolean(databaseUrl);

if (!hasDatabase) {
  test('integración API omitida: defina TEST_DATABASE_URL para ejecutarla', { skip: true }, () => {});
} else {
  const parsed = new URL(databaseUrl);
  if (!/test/i.test(parsed.pathname)) {
    throw new Error('TEST_DATABASE_URL debe apuntar a una base cuyo nombre contenga "test"');
  }

  const testApplicationName = `relevo-users-test-${process.pid}`;
  parsed.searchParams.set('application_name', testApplicationName);
  process.env.DATABASE_URL = parsed.toString();
  process.env.NODE_ENV = 'test';
  process.env.PORT = process.env.TEST_PORT || '3102';
  process.env.HOST = '127.0.0.1';
  process.env.NOTIFICATIONS_MODE = 'local';
  process.env.NOTIFICATIONS_AUTO_PROCESS = 'false';
  process.env.COOKIE_SECURE = 'false';
  process.env.CORS_ORIGINS = 'http://localhost:5173';
  // El limitador de login es por IP y en memoria; la suite comparte 127.0.0.1.
  process.env.LOGIN_RATE_LIMIT = '1000';
  process.env.TRACK_RATE_LIMIT = '1000';

  const bcrypt = (await import('bcryptjs')).default;
  const { createApp } = await import('../app.js');
  const { pool, query, closePool } = await import('../db/pool.js');
  const { runMigrations } = await import('../db/migrate.js');

  const PORT = Number(process.env.PORT);
  const BASE = `http://127.0.0.1:${PORT}`;
  const PASSWORD = 'TestPass!2026';
  const tableList = `
    notification_outbox, audit_log, case_replacements, case_actions, loans,
    loan_devices, payments, case_quote_items, case_quotes, case_history,
    cases, terminal_imeis, terminals, coverages, clients, sessions, users
  `;

  let server;
  let passwordHash;
  let users = {};
  let imeiCounter = 0;

  function daysAgoIso(days) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function makeAgent() {
    let cookie = '';
    let csrf = '';
    async function request(path, { method = 'GET', body, headers = {}, useCsrf = true, signal } = {}) {
      const finalHeaders = { ...headers };
      if (cookie) finalHeaders.cookie = cookie;
      if (body !== undefined) finalHeaders['content-type'] = 'application/json';
      if (useCsrf && csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        finalHeaders['x-csrf-token'] = csrf;
      }
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers: finalHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      const setCookies = response.headers.getSetCookie?.() || [];
      for (const raw of setCookies) {
        const pair = raw.split(';')[0];
        const index = pair.indexOf('=');
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (value) cookie = `${name}=${value}`;
        else cookie = '';
      }
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      return { status: response.status, body: json, headers: response.headers };
    }

    async function csrfToken() {
      const response = await request('/api/auth/csrf');
      assert.equal(response.status, 200);
      csrf = response.body.data.csrfToken;
      return csrf;
    }

    async function login(email, password = PASSWORD) {
      await csrfToken();
      const response = await request('/api/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      if (response.status === 200) csrf = response.body.data.csrfToken;
      return response;
    }

    return {
      request,
      csrfToken,
      login,
      get csrf() {
        return csrf;
      },
      get cookie() {
        return cookie;
      },
    };
  }

  async function loginAs(role) {
    const agent = makeAgent();
    const response = await agent.login(users[role].email);
    assert.equal(response.status, 200, `login ${role}: ${JSON.stringify(response.body)}`);
    return agent;
  }

  const adminMembershipLock = { namespace: 0x55534552, key: 1 };

  async function waitForAdminLockWaiters(expected, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let pids = [];
    while (Date.now() < deadline) {
      const { rows } = await query(
        `SELECT a.pid
           FROM pg_locks l
           JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE a.datid = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND a.application_name = $1
            AND a.query LIKE '%pg_advisory_xact_lock%'
            AND l.locktype = 'advisory' AND l.classid = $2::oid AND l.objid = $3::oid
            AND l.objsubid = 2 AND l.granted = false
          ORDER BY a.pid`,
        [testApplicationName, adminMembershipLock.namespace, adminMembershipLock.key],
      );
      pids = rows.map((row) => row.pid);
      if (pids.length === expected && new Set(pids).size === expected) return pids;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return pids;
  }

  async function settleRequests(pending, controllers, timeoutMs = 5000) {
    if (!pending) return null;
    let timer;
    let result = await Promise.race([
      pending.then((value) => ({ settled: true, value })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ settled: false }), timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (!result.settled) {
      controllers.forEach((controller) => controller.abort());
      let cleanupTimer;
      const cleanup = await Promise.race([
        pending.then((value) => ({ settled: true, value })),
        new Promise((resolve) => { cleanupTimer = setTimeout(() => resolve({ settled: false }), 1000); }),
      ]);
      clearTimeout(cleanupTimer);
      result = cleanup;
    }
    return result;
  }

  async function resetDatabase() {
    await query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    await query('ALTER SEQUENCE case_number_seq RESTART WITH 1');
    const rows = [
      ['admin@test.relevo', 'Admin Test', 'admin'],
      ['reception@test.relevo', 'Recepción Test', 'reception'],
      ['tech1@test.relevo', 'Técnico Uno', 'technician'],
      ['tech2@test.relevo', 'Técnico Dos', 'technician'],
    ];
    users = {};
    for (const [email, fullName, role] of rows) {
      const row = (
        await query(
          `INSERT INTO users (email, full_name, role, password_hash)
           VALUES ($1, $2, $3, $4) RETURNING id, email, role`,
          [email, fullName, role, passwordHash],
        )
      ).rows[0];
      users[role === 'technician' ? (email.startsWith('tech2') ? 'tech2' : 'tech1') : role] = row;
    }
  }

  async function createClient(api, suffix = '1', overrides = {}) {
    const response = await api.request('/api/clients', {
      method: 'POST',
      body: {
        full_name: `Cliente Sintético ${suffix}`,
        document_id: `DUI-TEST-${suffix}`,
        phone: '5550-9000',
        email: `cliente.${suffix}@example.test`,
        address: 'Calle Sintética 1',
        ...overrides,
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data;
  }

  async function createCoverage(api, overrides = {}) {
    const response = await api.request('/api/coverages', {
      method: 'POST',
      body: {
        brand: null,
        name: 'Cobertura de prueba',
        plan: 'total',
        months: 12,
        exclusions: ['golpe'],
        replacement_policy: 'new',
        ...overrides,
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data;
  }

  async function createTerminal(api, { clientId, coverageId = null, suffix = '1', ...overrides }) {
    void suffix;
    imeiCounter += 1;
    const imei = `3567890${String(imeiCounter).padStart(8, '0')}`;
    const response = await api.request('/api/terminals', {
      method: 'POST',
      body: {
        client_id: clientId,
        brand: 'Samsung',
        model: 'Galaxy A15',
        imeis: [imei],
        purchase_date: daysAgoIso(30),
        accessories: 'Cargador',
        initial_condition: 'Buen estado',
        coverage_id: coverageId,
        ...overrides,
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data;
  }

  async function createCase(api, { clientId, terminalId, technicianId, reportedProblem = 'No enciende' }) {
    const response = await api.request('/api/cases', {
      method: 'POST',
      body: {
        client_id: clientId,
        terminal_id: terminalId,
        reported_problem: reportedProblem,
        technician_id: technicianId,
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data;
  }

  async function setupCoveredCase(reception, admin, suffix = '1', problemType = 'pantalla') {
    const client = await createClient(reception, suffix);
    const coverage = await createCoverage(reception);
    const terminal = await createTerminal(reception, {
      clientId: client.id,
      coverageId: coverage.id,
      suffix,
    });
    const caseData = await createCase(reception, {
      clientId: client.id,
      terminalId: terminal.id,
      technicianId: users.tech1.id,
    });
    const diagnosis = await admin.request(`/api/cases/${caseData.id}/diagnosis`, {
      method: 'POST',
      body: { diagnosis: 'Diagnóstico sintético de prueba', problem_type: problemType },
    });
    assert.equal(diagnosis.status, 200, JSON.stringify(diagnosis.body));
    assert.equal(diagnosis.body.data.coverage_covered, true);
    return { client, coverage, terminal, caseData };
  }

  before(async () => {
    passwordHash = await bcrypt.hash(PASSWORD, 4);
    await runMigrations();
    const app = createApp();
    await new Promise((resolve, reject) => {
      server = app.listen(PORT, '127.0.0.1', resolve);
      server.on('error', reject);
    });
  });

  beforeEach(async () => {
    await resetDatabase();
    imeiCounter = 0;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool().catch(() => {});
  });

  test('paginación usa offsets distintos en casos y equipos de préstamo', async () => {
    const reception = await loginAs('reception');
    const client = await createClient(reception, 'paging');
    for (let index = 0; index < 21; index += 1) {
      const terminal = await createTerminal(reception, { clientId: client.id });
      await createCase(reception, {
        clientId: client.id,
        terminalId: terminal.id,
        technicianId: users.tech1.id,
        reportedProblem: `Problema de paginación ${index}`,
      });
      const device = await reception.request('/api/loan-devices', {
        method: 'POST',
        body: { asset_tag: `PAGE-LP-${index}`, brand: 'Nokia', model: '105' },
      });
      assert.equal(device.status, 201, JSON.stringify(device.body));
    }

    const casesPage1 = await reception.request('/api/cases?page=1&pageSize=20');
    const casesPage2 = await reception.request('/api/cases?page=2&pageSize=20');
    assert.equal(casesPage1.status, 200);
    assert.equal(casesPage2.status, 200);
    assert.equal(casesPage1.body.meta.total, 21);
    assert.equal(casesPage2.body.meta.total, 21);
    assert.equal(casesPage2.body.data.length, 1);
    assert.equal(
      casesPage1.body.data.some((item) => item.id === casesPage2.body.data[0].id),
      false,
    );

    const devicesPage1 = await reception.request('/api/loan-devices?page=1&pageSize=20');
    const devicesPage2 = await reception.request('/api/loan-devices?page=2&pageSize=20');
    assert.equal(devicesPage1.status, 200);
    assert.equal(devicesPage2.status, 200);
    assert.equal(devicesPage1.body.meta.total, 21);
    assert.equal(devicesPage2.body.meta.total, 21);
    assert.equal(devicesPage2.body.data.length, 1);
    assert.equal(
      devicesPage1.body.data.some((item) => item.id === devicesPage2.body.data[0].id),
      false,
    );
  });

  test('saldo respeta rechazo y cotización reemplazada', async () => {
    const reception = await loginAs('reception');
    const admin = await loginAs('admin');
    const client = await createClient(reception, 'quote-status');
    const terminal = await createTerminal(reception, { clientId: client.id });
    const caseData = await createCase(reception, {
      clientId: client.id,
      terminalId: terminal.id,
    });
    const diagnosis = await admin.request(`/api/cases/${caseData.id}/diagnosis`, {
      method: 'POST',
      body: { diagnosis: 'Requiere repuesto', problem_type: 'otro' },
    });
    assert.equal(diagnosis.status, 200);

    const quoteInput = (amount) => ({
      items: [{ description: 'Repuesto', quantity: 1, unit_price: amount }],
    });
    const firstQuote = await reception.request(`/api/cases/${caseData.id}/quote`, {
      method: 'POST',
      body: quoteInput('10.00'),
    });
    assert.equal(firstQuote.status, 201);
    const replacementQuote = await reception.request(`/api/cases/${caseData.id}/quote`, {
      method: 'POST',
      body: quoteInput('12.00'),
    });
    assert.equal(replacementQuote.status, 201);

    const replacedDetail = await admin.request(`/api/cases/${caseData.id}`);
    assert.equal(replacedDetail.body.data.quote.version, 2);
    assert.equal(replacedDetail.body.data.quote.status, 'pending');
    assert.equal(replacedDetail.body.data.quote.total, '12.00');
    assert.equal(replacedDetail.body.data.balance, '12.00');

    const rejected = await reception.request(`/api/cases/${caseData.id}/quote/decision`, {
      method: 'POST',
      body: { accepted: false },
    });
    assert.equal(rejected.status, 200);
    const rejectedDetail = await admin.request(`/api/cases/${caseData.id}`);
    assert.equal(rejectedDetail.body.data.quote.version, 2);
    assert.equal(rejectedDetail.body.data.quote.status, 'rejected');
    assert.equal(rejectedDetail.body.data.quote.total, '12.00');
    assert.equal(rejectedDetail.body.data.balance, '0.00');
  });

  test('catálogo de técnicos y asignación respetan rol y estado', async () => {
    const reception = await loginAs('reception');
    const admin = await loginAs('admin');
    const tech = await loginAs('tech1');

    const firstPage = await reception.request('/api/technicians?page=1&pageSize=1');
    const secondPage = await reception.request('/api/technicians?page=2&pageSize=1');
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.meta.total, 2);
    assert.deepEqual(Object.keys(firstPage.body.data[0]).sort(), ['full_name', 'id']);
    assert.equal(secondPage.body.data.length, 1);
    assert.notEqual(firstPage.body.data[0].id, secondPage.body.data[0].id);
    assert.equal((await tech.request('/api/technicians')).status, 403);
    assert.equal((await reception.request('/api/users')).status, 403);
    const deactivate = await admin.request(`/api/users/${users.tech2.id}`, {
      method: 'PATCH',
      body: { active: false },
    });
    assert.equal(deactivate.status, 200);
    const activeOnly = await reception.request('/api/technicians');
    assert.equal(activeOnly.body.meta.total, 1);
    assert.deepEqual(activeOnly.body.data.map(row => row.id), [users.tech1.id]);
    const reactivate = await admin.request(`/api/users/${users.tech2.id}`, {
      method: 'PATCH',
      body: { active: true },
    });
    assert.equal(reactivate.status, 200);

    const client = await createClient(reception, 'assignment');
    const coverage = await createCoverage(reception);
    const terminal = await createTerminal(reception, { clientId: client.id, coverageId: coverage.id });
    const caseData = await createCase(reception, { clientId: client.id, terminalId: terminal.id });

    const initialAssignment = await reception.request(`/api/cases/${caseData.id}`, {
      method: 'PATCH',
      body: { technician_id: users.tech1.id },
    });
    assert.equal(initialAssignment.status, 200);
    const diagnosis = await admin.request(`/api/cases/${caseData.id}/diagnosis`, {
      method: 'POST',
      body: { diagnosis: 'Falla de pantalla', problem_type: 'pantalla' },
    });
    assert.equal(diagnosis.status, 200);

    const reassignment = await reception.request(`/api/cases/${caseData.id}`, {
      method: 'PATCH',
      body: { technician_id: users.tech2.id },
    });
    assert.equal(reassignment.status, 200);
    const detail = await admin.request(`/api/cases/${caseData.id}`);
    assert.equal(detail.body.data.technician.id, users.tech2.id);

    const startRepair = await admin.request(`/api/cases/${caseData.id}/transition`, {
      method: 'POST',
      body: { status: 'repairing' },
    });
    assert.equal(startRepair.status, 200);
    const reassignmentDuringRepair = await reception.request(`/api/cases/${caseData.id}`, {
      method: 'PATCH',
      body: { technician_id: users.tech1.id },
    });
    assert.equal(reassignmentDuringRepair.status, 200);
    const duringRepairDetail = await admin.request(`/api/cases/${caseData.id}`);
    assert.equal(duringRepairDetail.body.data.technician.id, users.tech1.id);

    const cancel = await admin.request(`/api/cases/${caseData.id}/transition`, {
      method: 'POST',
      body: { status: 'cancelled' },
    });
    assert.equal(cancel.status, 200);
    const finalReassignment = await reception.request(`/api/cases/${caseData.id}`, {
      method: 'PATCH',
      body: { technician_id: users.tech2.id },
    });
    assert.equal(finalReassignment.status, 409);
    assert.equal(finalReassignment.body.error.code, 'CASE_CANCELLED');
  });

  test('health, CSRF y sesión persistente', async () => {
    const anonymous = makeAgent();
    const health = await anonymous.request('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.data.status, 'ok');
    assert.equal(health.body.data.database, 'up');

    const noSession = await anonymous.request('/api/auth/login', {
      method: 'POST',
      body: { email: users.admin.email, password: PASSWORD },
      useCsrf: false,
    });
    assert.equal(noSession.status, 403);
    assert.equal(noSession.body.error.code, 'CSRF_SESSION_REQUIRED');

    await anonymous.csrfToken();
    const anonymousCookie = anonymous.cookie;
    const noHeader = await anonymous.request('/api/auth/login', {
      method: 'POST',
      body: { email: users.admin.email, password: PASSWORD },
      useCsrf: false,
    });
    assert.equal(noHeader.status, 403);
    assert.equal(noHeader.body.error.code, 'CSRF_INVALID');

    const login = await anonymous.login(users.admin.email);
    assert.equal(login.status, 200);
    assert.equal(login.body.data.user.role, 'admin');
    assert.equal(login.body.data.user.password_hash, undefined);
    assert.notEqual(anonymous.cookie, anonymousCookie, 'login rota el identificador de sesión');
    const staleCookieReplay = await makeAgent().request('/api/auth/me', {
      headers: { cookie: anonymousCookie },
    });
    assert.equal(staleCookieReplay.status, 401, 'la sesión anónima anterior ya no autentica');

    const me = await anonymous.request('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.email, users.admin.email);

    const logout = await anonymous.request('/api/auth/logout', { method: 'POST' });
    assert.equal(logout.status, 200);
    const afterLogout = await anonymous.request('/api/auth/me');
    assert.equal(afterLogout.status, 401);
  });

  test('credenciales inválidas y autorización por rol', async () => {
    const agent = makeAgent();
    await agent.csrfToken();
    const bad = await agent.request('/api/auth/login', {
      method: 'POST',
      body: { email: users.admin.email, password: 'incorrecta' },
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');

    const reception = await loginAs('reception');
    const forbiddenUsers = await reception.request('/api/users');
    assert.equal(forbiddenUsers.status, 403);

    const tech = await loginAs('tech1');
    const forbiddenClient = await tech.request('/api/clients', {
      method: 'POST',
      body: {
        full_name: 'No permitido',
        phone: '5550-0000',
        email: 'no@example.test',
      },
    });
    assert.equal(forbiddenClient.status, 403);

    const admin = await loginAs('admin');
    const listUsers = await admin.request('/api/users');
    assert.equal(listUsers.status, 200);
    assert.ok(Array.isArray(listUsers.body.data));
  });

  test('caso cubierto: diagnóstico, reparación y entrega', async () => {
    const reception = await loginAs('reception');
    const admin = await loginAs('admin');
    const { caseData } = await setupCoveredCase(reception, admin, 'cov');

    const repair = await admin.request(`/api/cases/${caseData.id}/transition`, {
      method: 'POST',
      body: { status: 'repairing' },
    });
    assert.equal(repair.status, 200, JSON.stringify(repair.body));

    const invalidDelivery = await admin.request(`/api/cases/${caseData.id}/transition`, {
      method: 'POST',
      body: { status: 'delivered' },
    });
    assert.equal(invalidDelivery.status, 409);
    assert.equal(invalidDelivery.body.error.code, 'DELIVERY_REQUIRES_READY');

    const ready = await admin.request(`/api/cases/${caseData.id}/transition`, {
      method: 'POST',
      body: { status: 'ready', note: 'Listo para entrega' },
    });
    assert.equal(ready.status, 200);
    const delivered = await admin.request(`/api/cases/${caseData.id}/transition`, {
      method: 'POST',
      body: { status: 'delivered' },
    });
    assert.equal(delivered.status, 200);

    const detail = await admin.request(`/api/cases/${caseData.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.status, 'delivered');
    assert.ok(detail.body.data.history.some((item) => item.to_status === 'delivered'));
    assert.equal(detail.body.data.tracking_token, undefined);
  });

  test('fuera de cobertura: bloqueo, idempotencia de pago y pago completo', async () => {
    const reception = await loginAs('reception');
    const admin = await loginAs('admin');
    const client = await createClient(reception, 'uncovered');
    const coverage = await createCoverage(reception, { exclusions: ['golpe'] });
    const terminal = await createTerminal(reception, {
      clientId: client.id,
      coverageId: coverage.id,
      suffix: '20',
    });
    const caseData = await createCase(reception, {
      clientId: client.id,
      terminalId: terminal.id,
      technicianId: users.tech1.id,
    });

    const diagnosis = await admin.request(`/api/cases/${caseData.id}/diagnosis`, {
      method: 'POST',
      body: { diagnosis: 'Golpe fuerte en la carcasa', problem_type: 'golpe' },
    });
    assert.equal(diagnosis.status, 200);
    assert.equal(diagnosis.body.data.coverage_covered, false);
    assert.equal(diagnosis.body.data.status, 'awaiting_approval');

    const blocked = await admin.request(`/api/cases/${caseData.id}/transition`, {
      method: 'POST',
      body: { status: 'repairing' },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'QUOTE_NOT_ACCEPTED');

    const quote = await reception.request(`/api/cases/${caseData.id}/quote`, {
      method: 'POST',
      body: {
        items: [
          { description: 'Repuesto', quantity: 1, unit_price: '0.10' },
          { description: 'Mano de obra', quantity: 1, unit_price: '0.20' },
        ],
        note: 'Cotización de prueba',
      },
    });
    assert.equal(quote.status, 201);
    assert.equal(quote.body.data.quote.total, '0.30');

    const accepted = await reception.request(`/api/cases/${caseData.id}/quote/decision`, {
      method: 'POST',
      body: { accepted: true },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.data.status, 'awaiting_payment');

    const unpaidDetail = await admin.request(`/api/cases/${caseData.id}`);
    assert.equal(unpaidDetail.status, 200);
    assert.equal(unpaidDetail.body.data.balance, '0.30');

    const stillBlocked = await admin.request(`/api/cases/${caseData.id}/transition`, {
      method: 'POST',
      body: { status: 'repairing' },
    });
    assert.equal(stillBlocked.status, 409);
    assert.equal(stillBlocked.body.error.code, 'PAYMENT_REQUIRED');

    const firstPayment = {
      amount: '0.10',
      method: 'cash',
      reference: 'Recibo test 1',
      idempotency_key: 'idem-test-0001',
    };
    const partial = await reception.request(`/api/cases/${caseData.id}/payments`, {
      method: 'POST',
      body: firstPayment,
    });
    assert.equal(partial.status, 201);
    assert.equal(partial.body.data.payment.amount, '0.10');
    assert.equal(partial.body.data.balance, '0.20');

    const partialDetail = await admin.request(`/api/cases/${caseData.id}`);
    assert.equal(partialDetail.status, 200);
    assert.equal(partialDetail.body.data.balance, '0.20');

    const replay = await reception.request(`/api/cases/${caseData.id}/payments`, {
      method: 'POST',
      body: firstPayment,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.replayed, true);
    assert.equal(replay.body.data.payment.id, partial.body.data.payment.id);

    const conflictingReplay = await reception.request(`/api/cases/${caseData.id}/payments`, {
      method: 'POST',
      body: { ...firstPayment, amount: '0.20' },
    });
    assert.equal(conflictingReplay.status, 409);
    assert.equal(conflictingReplay.body.error.code, 'IDEMPOTENCY_CONFLICT');

    const overpay = await reception.request(`/api/cases/${caseData.id}/payments`, {
      method: 'POST',
      body: { ...firstPayment, amount: '0.30', idempotency_key: 'idem-test-0002' },
    });
    assert.equal(overpay.status, 409);
    assert.equal(overpay.body.error.code, 'PAYMENT_EXCEEDS_BALANCE');

    const second = await reception.request(`/api/cases/${caseData.id}/payments`, {
      method: 'POST',
      body: {
        amount: '0.20',
        method: 'card',
        reference: 'Recibo test 2',
        idempotency_key: 'idem-test-0002',
      },
    });
    assert.equal(second.status, 201);
    assert.equal(second.body.data.balance, '0.00');

    const repair = await admin.request(`/api/cases/${caseData.id}/transition`, {
      method: 'POST',
      body: { status: 'repairing' },
    });
    assert.equal(repair.status, 200, JSON.stringify(repair.body));

    const dashboard = await reception.request('/api/dashboard');
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.data.income_cents, 30);
    assert.equal(dashboard.body.data.counts.repairing, 1);
    const phoneModel = dashboard.body.data.device_models.find(
      (item) => item.brand === 'Samsung' && item.model === 'Galaxy A15',
    );
    assert.deepEqual(phoneModel, {
      brand: 'Samsung',
      model: 'Galaxy A15',
      terminal_count: 1,
      case_count: 1,
    });
    assert.deepEqual(Object.keys(phoneModel).sort(), ['brand', 'case_count', 'model', 'terminal_count']);

    const detail = await admin.request(`/api/cases/${caseData.id}`);
    assert.equal(detail.body.data.quote.total, '0.30');
    assert.equal(detail.body.data.paid_total, '0.30');
    assert.equal(detail.body.data.payments.length, 2);
  });

  test('técnico no puede rediagnosticar una excepción activa y administración sí puede editarla', async () => {
    const reception = await loginAs('reception');
    const admin = await loginAs('admin');
    const technician = await loginAs('tech1');
    const client = await createClient(reception, 'override-rediagnosis');
    const coverage = await createCoverage(reception, { exclusions: ['golpe'] });
    const terminal = await createTerminal(reception, {
      clientId: client.id,
      coverageId: coverage.id,
      suffix: 'override-rediagnosis',
    });
    const caseData = await createCase(reception, {
      clientId: client.id,
      terminalId: terminal.id,
      technicianId: users.tech1.id,
    });

    const diagnosis = await admin.request(`/api/cases/${caseData.id}/diagnosis`, {
      method: 'POST',
      body: {
        diagnosis: 'Golpe revisado por administración',
        problem_type: 'golpe',
        excluded_reason: 'Daño por impacto',
        coverage_override: true,
        override_reason: 'Excepción autorizada por gerencia',
      },
    });
    assert.equal(diagnosis.status, 200, JSON.stringify(diagnosis.body));

    const rejected = await technician.request(`/api/cases/${caseData.id}/diagnosis`, {
      method: 'POST',
      body: { diagnosis: 'Intento de editar', problem_type: 'golpe' },
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error.code, 'OVERRIDE_REQUIRES_ADMIN');

    const unchanged = await admin.request(`/api/cases/${caseData.id}`);
    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.body.data.coverage_override, true);
    assert.equal(unchanged.body.data.override_reason, 'Excepción autorizada por gerencia');
    assert.equal(unchanged.body.data.diagnosis.text, 'Golpe revisado por administración');
    assert.equal(unchanged.body.data.diagnosis.excluded_reason, 'Daño por impacto');

    const editedByAdmin = await admin.request(`/api/cases/${caseData.id}/diagnosis`, {
      method: 'POST',
      body: {
        diagnosis: 'Golpe verificado y actualizado',
        problem_type: 'golpe',
        excluded_reason: 'Daño por impacto',
        coverage_override: true,
        override_reason: 'Excepción revalidada por gerencia',
      },
    });
    assert.equal(editedByAdmin.status, 200, JSON.stringify(editedByAdmin.body));
    const finalDetail = await admin.request(`/api/cases/${caseData.id}`);
    assert.equal(finalDetail.body.data.coverage_override, true);
    assert.equal(finalDetail.body.data.override_reason, 'Excepción revalidada por gerencia');
    assert.equal(finalDetail.body.data.diagnosis.text, 'Golpe verificado y actualizado');
  });

  test('préstamo: préstamo único, devolución y bloqueo de entrega', async () => {
    const reception = await loginAs('reception');
    const admin = await loginAs('admin');
    const { client, caseData } = await setupCoveredCase(reception, admin, 'loan');
    const coverage2 = await createCoverage(reception);
    const terminal2 = await createTerminal(reception, {
      clientId: client.id,
      coverageId: coverage2.id,
      suffix: 'loan2',
    });
    const case2 = await createCase(reception, {
      clientId: client.id,
      terminalId: terminal2.id,
      technicianId: users.tech1.id,
    });
    const diag2 = await admin.request(`/api/cases/${case2.id}/diagnosis`, {
      method: 'POST',
      body: { diagnosis: 'Diagnóstico del segundo equipo', problem_type: 'pantalla' },
    });
    assert.equal(diag2.status, 200);
    for (const id of [caseData.id, case2.id]) {
      const repair = await admin.request(`/api/cases/${id}/transition`, {
        method: 'POST',
        body: { status: 'repairing' },
      });
      assert.equal(repair.status, 200, JSON.stringify(repair.body));
    }

    const device1 = await reception.request('/api/loan-devices', {
      method: 'POST',
      body: { asset_tag: 'TEST-LP-1', brand: 'Nokia', model: '105' },
    });
    const device2 = await reception.request('/api/loan-devices', {
      method: 'POST',
      body: { asset_tag: 'TEST-LP-2', brand: 'Samsung', model: 'A05' },
    });
    assert.equal(device1.status, 201);

    const assigned = await reception.request(`/api/cases/${caseData.id}/loan`, {
      method: 'POST',
      body: { loan_device_id: device1.body.data.id, condition_out: 'Bueno' },
    });
    assert.equal(assigned.status, 201);

    const duplicateCaseLoan = await reception.request(`/api/cases/${caseData.id}/loan`, {
      method: 'POST',
      body: { loan_device_id: device2.body.data.id, condition_out: 'Bueno' },
    });
    assert.equal(duplicateCaseLoan.status, 409);
    assert.equal(duplicateCaseLoan.body.error.code, 'LOAN_ALREADY_ACTIVE');

    const duplicateDevice = await reception.request(`/api/cases/${case2.id}/loan`, {
      method: 'POST',
      body: { loan_device_id: device1.body.data.id, condition_out: 'Bueno' },
    });
    assert.equal(duplicateDevice.status, 409);
    assert.equal(duplicateDevice.body.error.code, 'LOAN_DEVICE_UNAVAILABLE');

    const ready = await admin.request(`/api/cases/${caseData.id}/transition`, {
      method: 'POST',
      body: { status: 'ready' },
    });
    assert.equal(ready.status, 200);
    const blockedDelivery = await admin.request(`/api/cases/${caseData.id}/transition`, {
      method: 'POST',
      body: { status: 'delivered' },
    });
    assert.equal(blockedDelivery.status, 409);
    assert.equal(blockedDelivery.body.error.code, 'LOAN_NOT_RETURNED');

    const returned = await reception.request(`/api/cases/${caseData.id}/loan/return`, {
      method: 'POST',
      body: { condition_in: 'Devuelto sin daños' },
    });
    assert.equal(returned.status, 200);
    assert.equal(returned.body.data.status, 'returned');

    const delivered = await admin.request(`/api/cases/${caseData.id}/transition`, {
      method: 'POST',
      body: { status: 'delivered' },
    });
    assert.equal(delivered.status, 200);

    const devices = await reception.request('/api/loan-devices?q=TEST-LP-1');
    assert.equal(devices.status, 200);
    assert.equal(devices.body.data[0].status, 'available');
  });

  test('cancelado no se reabre y el portal público no filtra datos del cliente', async () => {
    const reception = await loginAs('reception');
    const admin = await loginAs('admin');
    const client = await createClient(reception, 'track');
    const terminal = await createTerminal(reception, {
      clientId: client.id,
      coverageId: null,
      suffix: '30',
    });
    const caseData = await createCase(reception, {
      clientId: client.id,
      terminalId: terminal.id,
    });

    const validTrack = await makeAgent().request('/api/track', {
      method: 'POST',
      body: { case_number: caseData.case_number, token: caseData.tracking_token },
      useCsrf: false,
    });
    assert.equal(validTrack.status, 200);
    assert.equal(validTrack.body.data.case_number, caseData.case_number);
    assert.equal(validTrack.body.data.client, undefined);
    assert.equal(validTrack.body.data.terminal.brand, terminal.brand);

    const invalidTrack = await makeAgent().request('/api/track', {
      method: 'POST',
      body: { case_number: caseData.case_number, token: 'token-invalido-de-prueba-123' },
      useCsrf: false,
    });
    assert.equal(invalidTrack.status, 404);

    const cancelled = await admin.request(`/api/cases/${caseData.id}/transition`, {
      method: 'POST',
      body: { status: 'cancelled', note: 'Cancelado por el cliente' },
    });
    assert.equal(cancelled.status, 200);
    const reopened = await admin.request(`/api/cases/${caseData.id}/transition`, {
      method: 'POST',
      body: { status: 'received' },
    });
    assert.equal(reopened.status, 409);
    assert.equal(reopened.body.error.code, 'CASE_CANCELLED');
  });

  test('reemplazo exige política registrada y crea cobertura nueva', async () => {
    const reception = await loginAs('reception');
    const admin = await loginAs('admin');
    const { client, caseData } = await setupCoveredCase(reception, admin, 'replacement');
    const alternateCoverage = await createCoverage(reception, { name: 'Cobertura alternativa' });
    const replacementTerminal = await createTerminal(reception, {
      clientId: client.id,
      coverageId: null,
      suffix: '40',
    });
    const untouchedTerminal = await createTerminal(reception, {
      clientId: client.id,
      coverageId: alternateCoverage.id,
      suffix: '41',
      brand: 'Apple',
      model: 'iPhone 13',
    });

    const mismatch = await reception.request(`/api/cases/${caseData.id}/replacement`, {
      method: 'POST',
      body: { terminal_id: replacementTerminal.id, policy: 'continue' },
    });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error.code, 'POLICY_MISMATCH');

    const replacement = await reception.request(`/api/cases/${caseData.id}/replacement`, {
      method: 'POST',
      body: { terminal_id: replacementTerminal.id, policy: 'new' },
    });
    assert.equal(replacement.status, 201, JSON.stringify(replacement.body));
    assert.equal(replacement.body.data.status, 'ready');
    assert.notEqual(replacement.body.data.replacement.coverage_id, null);

    const row = (
      await query('SELECT coverage_id FROM terminals WHERE id = $1', [replacementTerminal.id])
    ).rows[0];
    assert.equal(row.coverage_id, replacement.body.data.replacement.coverage_id);

    const countsBeforeDuplicate = (
      await query(
        `SELECT (SELECT count(*)::integer FROM case_replacements WHERE case_id = $1) AS replacements,
                (SELECT count(*)::integer FROM coverages) AS coverages`,
        [caseData.id],
      )
    ).rows[0];
    const duplicate = await reception.request(`/api/cases/${caseData.id}/replacement`, {
      method: 'POST',
      body: { terminal_id: untouchedTerminal.id, policy: 'new' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'REPLACEMENT_ALREADY_EXISTS');
    const countsAfterDuplicate = (
      await query(
        `SELECT (SELECT count(*)::integer FROM case_replacements WHERE case_id = $1) AS replacements,
                (SELECT count(*)::integer FROM coverages) AS coverages`,
        [caseData.id],
      )
    ).rows[0];
    assert.deepEqual(countsAfterDuplicate, countsBeforeDuplicate);
    const untouched = (
      await query('SELECT coverage_id FROM terminals WHERE id = $1', [untouchedTerminal.id])
    ).rows[0];
    assert.equal(untouched.coverage_id, alternateCoverage.id);

    const detail = await admin.request(`/api/cases/${caseData.id}`);
    assert.equal(detail.body.data.status, 'ready');
    assert.equal(detail.body.data.replacement.terminal.id, replacementTerminal.id);

    const { client: concurrentClient, caseData: concurrentCase } = await setupCoveredCase(
      reception,
      admin,
      'replacement-concurrent',
    );
    const concurrentTerminals = await Promise.all([
      createTerminal(reception, { clientId: concurrentClient.id, suffix: '42' }),
      createTerminal(reception, { clientId: concurrentClient.id, suffix: '43' }),
    ]);
    const coverageCountBeforeConcurrent = Number(
      (await query('SELECT count(*)::integer AS count FROM coverages')).rows[0].count,
    );
    const concurrentResults = await Promise.all(concurrentTerminals.map((terminal) =>
      reception.request(`/api/cases/${concurrentCase.id}/replacement`, {
        method: 'POST',
        body: { terminal_id: terminal.id, policy: 'new' },
      }),
    ));
    assert.deepEqual(concurrentResults.map((result) => result.status).sort(), [201, 409]);
    const concurrentCounts = (
      await query(
        `SELECT (SELECT count(*)::integer FROM case_replacements WHERE case_id = $1) AS replacements,
                (SELECT count(*)::integer FROM coverages) AS coverages`,
        [concurrentCase.id],
      )
    ).rows[0];
    assert.equal(concurrentCounts.replacements, 1);
    assert.equal(concurrentCounts.coverages, coverageCountBeforeConcurrent + 1);
    const concurrentRejectedTerminal = concurrentTerminals[concurrentResults[0].status === 409 ? 0 : 1];
    const rejectedTerminalRow = (
      await query('SELECT coverage_id FROM terminals WHERE id = $1', [concurrentRejectedTerminal.id])
    ).rows[0];
    assert.equal(rejectedTerminalRow.coverage_id, null);
  });

  test('un terminal no se asigna a dos reemplazos abiertos y puede reutilizarse al cerrar el caso', async () => {
    const reception = await loginAs('reception');
    const admin = await loginAs('admin');
    const client = await createClient(reception, 'replacement-reservation');
    const coverage = await createCoverage(reception, { replacement_policy: 'new' });
    const makeCoveredCase = async (suffix) => {
      const terminal = await createTerminal(reception, {
        clientId: client.id,
        coverageId: coverage.id,
        suffix,
      });
      const caseData = await createCase(reception, {
        clientId: client.id,
        terminalId: terminal.id,
        technicianId: users.tech1.id,
      });
      const diagnosis = await admin.request(`/api/cases/${caseData.id}/diagnosis`, {
        method: 'POST',
        body: { diagnosis: 'Diagnóstico de reserva', problem_type: 'pantalla' },
      });
      assert.equal(diagnosis.status, 200, JSON.stringify(diagnosis.body));
      assert.equal(diagnosis.body.data.coverage_covered, true);
      return caseData;
    };

    const sequentialCases = await Promise.all([
      makeCoveredCase('replacement-reservation-a'),
      makeCoveredCase('replacement-reservation-b'),
    ]);
    const sequentialTerminal = await createTerminal(reception, {
      clientId: client.id,
      coverageId: null,
      suffix: 'replacement-reservation-target',
    });
    const firstAssignment = await reception.request(
      `/api/cases/${sequentialCases[0].id}/replacement`,
      { method: 'POST', body: { terminal_id: sequentialTerminal.id, policy: 'new' } },
    );
    assert.equal(firstAssignment.status, 201, JSON.stringify(firstAssignment.body));
    const firstCoverageId = firstAssignment.body.data.replacement.coverage_id;
    const coverageCountAfterFirst = Number(
      (await query('SELECT count(*)::integer AS count FROM coverages')).rows[0].count,
    );

    const blockedAssignment = await reception.request(
      `/api/cases/${sequentialCases[1].id}/replacement`,
      { method: 'POST', body: { terminal_id: sequentialTerminal.id, policy: 'new' } },
    );
    assert.equal(blockedAssignment.status, 409);
    assert.equal(blockedAssignment.body.error.code, 'REPLACEMENT_TERMINAL_IN_USE');
    assert.equal(
      Number((await query('SELECT count(*)::integer AS count FROM coverages')).rows[0].count),
      coverageCountAfterFirst,
    );
    assert.equal(
      Number((await query(
        'SELECT count(*)::integer AS count FROM case_replacements WHERE terminal_id = $1',
        [sequentialTerminal.id],
      )).rows[0].count),
      1,
    );
    const sequentialTerminalAfterRejection = (
      await query('SELECT coverage_id FROM terminals WHERE id = $1', [sequentialTerminal.id])
    ).rows[0];
    assert.equal(sequentialTerminalAfterRejection.coverage_id, firstCoverageId);

    const closeFirstCase = await admin.request(
      `/api/cases/${sequentialCases[0].id}/transition`,
      { method: 'POST', body: { status: 'delivered' } },
    );
    assert.equal(closeFirstCase.status, 200, JSON.stringify(closeFirstCase.body));
    const reusedAssignment = await reception.request(
      `/api/cases/${sequentialCases[1].id}/replacement`,
      { method: 'POST', body: { terminal_id: sequentialTerminal.id, policy: 'new' } },
    );
    assert.equal(reusedAssignment.status, 201, JSON.stringify(reusedAssignment.body));
    const sequentialRows = (
      await query(
        `SELECT r.case_id, r.coverage_id, c.status
           FROM case_replacements r JOIN cases c ON c.id = r.case_id
          WHERE r.terminal_id = $1 ORDER BY r.id`,
        [sequentialTerminal.id],
      )
    ).rows;
    assert.equal(sequentialRows.length, 2);
    assert.deepEqual(sequentialRows.map((row) => row.status), ['delivered', 'ready']);
    assert.equal(sequentialRows[1].coverage_id, reusedAssignment.body.data.replacement.coverage_id);

    const concurrentCases = await Promise.all([
      makeCoveredCase('replacement-concurrent-a'),
      makeCoveredCase('replacement-concurrent-b'),
    ]);
    const concurrentTerminal = await createTerminal(reception, {
      clientId: client.id,
      coverageId: null,
      suffix: 'replacement-concurrent-target',
    });
    const coverageCountBeforeRace = Number(
      (await query('SELECT count(*)::integer AS count FROM coverages')).rows[0].count,
    );
    const concurrentResults = await Promise.all(concurrentCases.map(async (caseData) => ({
      caseData,
      response: await reception.request(`/api/cases/${caseData.id}/replacement`, {
        method: 'POST',
        body: { terminal_id: concurrentTerminal.id, policy: 'new' },
      }),
    })));
    assert.deepEqual(concurrentResults.map(({ response }) => response.status).sort(), [201, 409]);
    const concurrentWinner = concurrentResults.find(({ response }) => response.status === 201);
    const concurrentLoser = concurrentResults.find(({ response }) => response.status === 409);
    assert.equal(concurrentLoser.response.body.error.code, 'REPLACEMENT_TERMINAL_IN_USE');
    assert.equal(
      Number((await query('SELECT count(*)::integer AS count FROM coverages')).rows[0].count),
      coverageCountBeforeRace + 1,
    );
    const concurrentRows = (
      await query(
        `SELECT r.case_id, r.coverage_id, c.status
           FROM case_replacements r JOIN cases c ON c.id = r.case_id
          WHERE r.terminal_id = $1`,
        [concurrentTerminal.id],
      )
    ).rows;
    assert.equal(concurrentRows.length, 1);
    assert.equal(concurrentRows[0].case_id, concurrentWinner.caseData.id);
    assert.equal(concurrentRows[0].coverage_id, concurrentWinner.response.body.data.replacement.coverage_id);
    const concurrentTerminalRow = (
      await query('SELECT coverage_id FROM terminals WHERE id = $1', [concurrentTerminal.id])
    ).rows[0];
    assert.equal(concurrentTerminalRow.coverage_id, concurrentWinner.response.body.data.replacement.coverage_id);

    const occupiedTerminal = await createTerminal(reception, {
      clientId: client.id,
      coverageId: null,
      suffix: 'replacement-active-case-target',
    });
    await createCase(reception, {
      clientId: client.id,
      terminalId: occupiedTerminal.id,
      technicianId: users.tech1.id,
    });
    const otherCoveredCase = await makeCoveredCase('replacement-active-case-source');
    const coverageCountBeforeActiveCase = Number(
      (await query('SELECT count(*)::integer AS count FROM coverages')).rows[0].count,
    );
    const activeCaseAssignment = await reception.request(
      `/api/cases/${otherCoveredCase.id}/replacement`,
      { method: 'POST', body: { terminal_id: occupiedTerminal.id, policy: 'new' } },
    );
    assert.equal(activeCaseAssignment.status, 409);
    assert.equal(activeCaseAssignment.body.error.code, 'TERMINAL_HAS_ACTIVE_CASE');
    assert.equal(
      Number((await query('SELECT count(*)::integer AS count FROM coverages')).rows[0].count),
      coverageCountBeforeActiveCase,
    );
    const occupiedTerminalRow = (
      await query('SELECT coverage_id FROM terminals WHERE id = $1', [occupiedTerminal.id])
    ).rows[0];
    assert.equal(occupiedTerminalRow.coverage_id, null);
  });

  test('casos y reservas de reemplazo se excluyen en ambas direcciones bajo concurrencia', async () => {
    const reception = await loginAs('reception');
    const admin = await loginAs('admin');
    const client = await createClient(reception, 'replacement-case-race');
    const coverage = await createCoverage(reception, { replacement_policy: 'new' });
    const makeCoveredCase = async (suffix) => {
      const terminal = await createTerminal(reception, {
        clientId: client.id,
        coverageId: coverage.id,
        suffix,
      });
      const caseData = await createCase(reception, {
        clientId: client.id,
        terminalId: terminal.id,
        technicianId: users.tech1.id,
      });
      const diagnosis = await admin.request(`/api/cases/${caseData.id}/diagnosis`, {
        method: 'POST',
        body: { diagnosis: 'Diagnóstico para reemplazo', problem_type: 'pantalla' },
      });
      assert.equal(diagnosis.status, 200, JSON.stringify(diagnosis.body));
      return caseData;
    };
    const makeReplacementTerminal = (suffix) => createTerminal(reception, {
      clientId: client.id,
      coverageId: null,
      suffix,
    });

    const reservedTerminal = await makeReplacementTerminal('reserved');
    const firstSource = await makeCoveredCase('source-sequential');
    const firstReplacement = await reception.request(
      `/api/cases/${firstSource.id}/replacement`,
      { method: 'POST', body: { terminal_id: reservedTerminal.id, policy: 'new' } },
    );
    assert.equal(firstReplacement.status, 201, JSON.stringify(firstReplacement.body));
    const rejectedReception = await reception.request('/api/cases', {
      method: 'POST',
      body: { client_id: client.id, terminal_id: reservedTerminal.id, reported_problem: 'No carga' },
    });
    assert.equal(rejectedReception.status, 409);
    assert.equal(rejectedReception.body.error.code, 'TERMINAL_RESERVED_FOR_REPLACEMENT');

    const closeSource = await admin.request(`/api/cases/${firstSource.id}/transition`, {
      method: 'POST', body: { status: 'delivered' },
    });
    assert.equal(closeSource.status, 200, JSON.stringify(closeSource.body));
    const allowedAfterClose = await reception.request('/api/cases', {
      method: 'POST',
      body: { client_id: client.id, terminal_id: reservedTerminal.id, reported_problem: 'No carga' },
    });
    assert.equal(allowedAfterClose.status, 201, JSON.stringify(allowedAfterClose.body));

    const occupiedTerminal = await makeReplacementTerminal('occupied');
    const otherSource = await makeCoveredCase('source-active-replacement');
    const activeCase = await reception.request('/api/cases', {
      method: 'POST',
      body: { client_id: client.id, terminal_id: occupiedTerminal.id, reported_problem: 'No enciende' },
    });
    assert.equal(activeCase.status, 201, JSON.stringify(activeCase.body));
    const deniedReplacement = await reception.request(`/api/cases/${otherSource.id}/replacement`, {
      method: 'POST',
      body: { terminal_id: occupiedTerminal.id, policy: 'new' },
    });
    assert.equal(deniedReplacement.status, 409);
    assert.equal(deniedReplacement.body.error.code, 'TERMINAL_HAS_ACTIVE_CASE');

    const raceTerminal = await makeReplacementTerminal('race-target');
    const raceSource = await makeCoveredCase('race-source');
    const [caseAttempt, replacementAttempt] = await Promise.all([
      reception.request('/api/cases', {
        method: 'POST',
        body: { client_id: client.id, terminal_id: raceTerminal.id, reported_problem: 'Falla intermitente' },
      }),
      reception.request(`/api/cases/${raceSource.id}/replacement`, {
        method: 'POST', body: { terminal_id: raceTerminal.id, policy: 'new' },
      }),
    ]);
    assert.deepEqual([caseAttempt.status, replacementAttempt.status].sort(), [201, 409]);
    const losingAttempt = caseAttempt.status === 409 ? caseAttempt : replacementAttempt;
    assert.ok([
      'TERMINAL_RESERVED_FOR_REPLACEMENT',
      'TERMINAL_HAS_ACTIVE_CASE',
    ].includes(losingAttempt.body.error.code));
    const raceState = (
      await query(
        `SELECT
           (SELECT count(*)::integer FROM cases WHERE terminal_id = $1 AND status NOT IN ('delivered','cancelled')) AS active_cases,
           (SELECT count(*)::integer FROM case_replacements r JOIN cases c ON c.id = r.case_id
             WHERE r.terminal_id = $1 AND c.status NOT IN ('delivered','cancelled')) AS open_reservations`,
        [raceTerminal.id],
      )
    ).rows[0];
    assert.ok(
      (raceState.active_cases === 1 && raceState.open_reservations === 0)
      || (raceState.active_cases === 0 && raceState.open_reservations === 1),
      JSON.stringify(raceState),
    );
  });

  test('técnico solo accede a casos asignados y no administra clientes', async () => {
    const reception = await loginAs('reception');
    const admin = await loginAs('admin');
    const client = await createClient(reception, 'perm');
    const coverage = await createCoverage(reception);
    const terminal1 = await createTerminal(reception, {
      clientId: client.id,
      coverageId: coverage.id,
      suffix: '50',
    });
    const terminal2 = await createTerminal(reception, {
      clientId: client.id,
      coverageId: coverage.id,
      suffix: '51',
      brand: 'Apple',
      model: 'iPhone 13',
    });
    const own = await createCase(reception, {
      clientId: client.id,
      terminalId: terminal1.id,
      technicianId: users.tech1.id,
    });
    const other = await createCase(reception, {
      clientId: client.id,
      terminalId: terminal2.id,
      technicianId: users.tech2.id,
    });

    const tech = await loginAs('tech1');
    const ownDashboard = await tech.request('/api/dashboard');
    assert.equal(ownDashboard.status, 200);
    assert.deepEqual(ownDashboard.body.data.device_models, [{
      brand: 'Samsung', model: 'Galaxy A15', terminal_count: 1, case_count: 1,
    }]);
    const tech2Dashboard = await (await loginAs('tech2')).request('/api/dashboard');
    assert.deepEqual(tech2Dashboard.body.data.device_models, [{
      brand: 'Apple', model: 'iPhone 13', terminal_count: 1, case_count: 1,
    }]);
    const receptionDashboard = await reception.request('/api/dashboard');
    assert.equal(receptionDashboard.body.data.device_models.length, 2);
    const list = await tech.request('/api/cases');
    assert.equal(list.status, 200);
    assert.equal(list.body.meta.total, 1);
    assert.equal(list.body.data[0].id, own.id);

    const forbidden = await tech.request(`/api/cases/${other.id}`);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'CASE_NOT_ASSIGNED');

    const clients = await tech.request('/api/clients');
    assert.equal(clients.status, 200);
    const usersList = await tech.request('/api/users');
    assert.equal(usersList.status, 403);

    const noAssign = await tech.request(`/api/cases/${own.id}`, {
      method: 'PATCH',
      body: { technician_id: users.tech2.id },
    });
    assert.equal(noAssign.status, 403);
  });

  test('validación, edición de clientes y restricciones de IMEI', async () => {
    const reception = await loginAs('reception');
    const invalid = await reception.request('/api/clients', {
      method: 'POST',
      body: { full_name: 'X', phone: '1', email: 'no-es-correo' },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');

    const client = await createClient(reception, 'valid');
    const duplicateDocument = await reception.request('/api/clients', {
      method: 'POST',
      body: {
        full_name: 'Otro cliente',
        document_id: 'DUI-TEST-valid',
        phone: '5550-1234',
        email: 'otro@example.test',
      },
    });
    assert.equal(duplicateDocument.status, 409);

    const updated = await reception.request(`/api/clients/${client.id}`, {
      method: 'PATCH',
      body: { address: 'Dirección actualizada' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.address, 'Dirección actualizada');

    const list = await reception.request('/api/clients?page=1&pageSize=1');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.meta.pageSize, 1);
    const tooBig = await reception.request('/api/clients?pageSize=101');
    assert.equal(tooBig.status, 400);

    const coverage = await createCoverage(reception);
    const terminal = await createTerminal(reception, {
      clientId: client.id,
      coverageId: coverage.id,
      suffix: '60',
      imeis: ['356789012349999'],
    });
    assert.deepEqual(terminal.imeis, ['356789012349999']);
    const duplicateImei = await reception.request('/api/terminals', {
      method: 'POST',
      body: {
        client_id: client.id,
        brand: 'Samsung',
        model: 'Duplicado',
        imeis: ['356789012349999'],
        purchase_date: daysAgoIso(10),
        initial_condition: 'Buen estado',
        coverage_id: coverage.id,
      },
    });
    assert.equal(duplicateImei.status, 409);
    assert.equal(duplicateImei.body.error.code, 'IMEI_DUPLICATE');

    const invalidImei = await reception.request('/api/terminals', {
      method: 'POST',
      body: {
        client_id: client.id,
        brand: 'Samsung',
        model: 'Inválido',
        imeis: ['123'],
        purchase_date: daysAgoIso(10),
        initial_condition: 'Buen estado',
        coverage_id: coverage.id,
      },
    });
    assert.equal(invalidImei.status, 400);
  });

  test('notificaciones outbox local y auditoría', async () => {
    const reception = await loginAs('reception');
    const admin = await loginAs('admin');
    const client = await createClient(reception, 'notify');
    const terminal = await createTerminal(reception, {
      clientId: client.id,
      coverageId: null,
      suffix: '70',
    });
    await createCase(reception, { clientId: client.id, terminalId: terminal.id });

    const pending = await reception.request('/api/notifications?status=pending');
    assert.equal(pending.status, 200);
    assert.ok(pending.body.meta.total >= 1);

    const forbidden = await reception.request('/api/notifications/process', { method: 'POST' });
    assert.equal(forbidden.status, 403);

    const processed = await admin.request('/api/notifications/process', { method: 'POST' });
    assert.equal(processed.status, 200);
    assert.ok(processed.body.data.sent >= 1);

    const sent = await reception.request('/api/notifications?status=sent');
    assert.ok(sent.body.meta.total >= 1);

    const audit = await admin.request('/api/audit?action=case.create');
    assert.equal(audit.status, 200);
    assert.ok(audit.body.meta.total >= 1);
    assert.equal(audit.body.data[0].action, 'case.create');

    const auditForbidden = await reception.request('/api/audit');
    assert.equal(auditForbidden.status, 403);
  });

  test('usuarios: creación, actualización y protección del último administrador', async () => {
    const admin = await loginAs('admin');
    const created = await admin.request('/api/users', {
      method: 'POST',
      body: {
        email: 'nuevo.tecnico@test.relevo',
        full_name: 'Nuevo Técnico',
        role: 'technician',
        password: 'OtraClave!2026',
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.role, 'technician');

    const oldPasswordAgent = makeAgent();
    assert.equal((await oldPasswordAgent.login(created.body.data.email, 'OtraClave!2026')).status, 200);
    const changedPassword = await admin.request(`/api/users/${created.body.data.id}`, {
      method: 'PATCH',
      body: { password: 'NuevaClave!2026' },
    });
    assert.equal(changedPassword.status, 200);
    const remainingSessions = await query('SELECT count(*)::int AS count FROM sessions WHERE user_id = $1', [created.body.data.id]);
    assert.equal(remainingSessions.rows[0].count, 0, 'cambiar contraseña revoca todas las sesiones del target');
    assert.equal((await oldPasswordAgent.request('/api/auth/me')).status, 401);
    const newPasswordAgent = makeAgent();
    assert.equal((await newPasswordAgent.login(created.body.data.email, 'NuevaClave!2026')).status, 200);

    const updated = await admin.request(`/api/users/${created.body.data.id}`, {
      method: 'PATCH',
      body: { active: false },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.active, false);

    const selfDeactivate = await admin.request(`/api/users/${users.admin.id}`, {
      method: 'PATCH',
      body: { active: false },
    });
    assert.equal(selfDeactivate.status, 409);
    assert.equal(selfDeactivate.body.error.code, 'CANNOT_DEACTIVATE_SELF');

    const duplicate = await admin.request('/api/users', {
      method: 'POST',
      body: {
        email: users.admin.email,
        full_name: 'Duplicado',
        role: 'reception',
        password: 'OtraClave!2026',
      },
    });
    assert.equal(duplicate.status, 409);

    const ownCookie = admin.cookie;
    const selfPasswordChange = await admin.request(`/api/users/${users.admin.id}`, {
      method: 'PATCH',
      body: { password: 'AdminChangedPass!2026' },
    });
    assert.equal(selfPasswordChange.status, 200);
    assert.notEqual(admin.cookie, ownCookie, 'la cookie propia se limpia tras el cambio de contraseña');
    assert.equal((await admin.request('/api/auth/me')).status, 401, 'el cambio propio exige iniciar sesión de nuevo');
  });

  test('usuarios: advisory lock serializa dos auto-demociones del último administrador', async () => {
    const adminA = await loginAs('admin');
    const secondAdmin = (await query(
      `INSERT INTO users (email, full_name, role, password_hash)
       VALUES ($1, $2, 'admin', $3) RETURNING id, email`,
      ['admin-race@test.relevo', 'Admin Race', passwordHash],
    )).rows[0];
    const adminB = makeAgent();
    const loginB = await adminB.login(secondAdmin.email);
    assert.equal(loginB.status, 200);

    const { namespace, key: lockKey } = adminMembershipLock;
    const blocker = await pool.connect();
    const controllers = [new AbortController(), new AbortController()];
    let pending;
    let settlement;
    let waiterPids = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1, $2)', [namespace, lockKey]);
      pending = Promise.allSettled([
        adminA.request(`/api/users/${users.admin.id}`, {
          method: 'PATCH', body: { role: 'reception' }, signal: controllers[0].signal,
        }),
        adminB.request(`/api/users/${secondAdmin.id}`, {
          method: 'PATCH', body: { role: 'technician' }, signal: controllers[1].signal,
        }),
      ]);
      waiterPids = await waitForAdminLockWaiters(2);
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
      settlement = await settleRequests(pending, controllers);
    }

    assert.equal(waiterPids.length, 2, 'ambas solicitudes propias deben esperar en la misma clave advisory');
    assert.ok(settlement?.settled, 'las dos solicitudes deben terminar dentro del límite tras liberar la barrera');
    assert.ok(settlement.value.every((result) => result.status === 'fulfilled'));
    const responses = settlement.value.map((result) => result.value);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const conflict = responses.find((response) => response.status === 409);
    assert.equal(conflict.body.error.code, 'LAST_ADMIN');

    const activeAdmins = await query(
      `SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND active = true`,
    );
    assert.equal(activeAdmins.rows[0].count, 1);
    const successfulAudit = await query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE action = 'user.update' AND entity_type = 'user' AND entity_id = ANY($1::text[])`,
      [[String(users.admin.id), String(secondAdmin.id)]],
    );
    assert.equal(successfulAudit.rows[0].count, 1, 'solo se audita la democión confirmada');
  });

  test('usuarios: revalida al actor degradado incluso para una edición de email', async () => {
    const secondAdmin = (await query(
      `INSERT INTO users (email, full_name, role, password_hash)
       VALUES ($1, $2, 'admin', $3) RETURNING id, email`,
      ['admin-actor-wait@test.relevo', 'Admin Waiting Actor', passwordHash],
    )).rows[0];
    const actor = makeAgent();
    assert.equal((await actor.login(secondAdmin.email)).status, 200);

    const blocker = await pool.connect();
    const controller = new AbortController();
    let pending;
    let settlement;
    let waiterPids = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1, $2)', [
        adminMembershipLock.namespace,
        adminMembershipLock.key,
      ]);
      pending = Promise.allSettled([actor.request(`/api/users/${users.tech1.id}`, {
        method: 'PATCH', body: { email: 'must-not-update@test.relevo' }, signal: controller.signal,
      })]);
      waiterPids = await waitForAdminLockWaiters(1);
      assert.equal(waiterPids.length, 1, 'la solicitud debe estar esperando antes de degradar al actor');
      await query("UPDATE users SET role = 'reception' WHERE id = $1", [secondAdmin.id]);
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
      settlement = await settleRequests(pending, [controller]);
    }

    assert.ok(settlement?.settled, 'la solicitud debe finalizar tras liberar la barrera');
    assert.equal(settlement.value[0].status, 'fulfilled');
    const response = settlement.value[0].value;
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FORBIDDEN');
    const target = await query('SELECT active, email FROM users WHERE id = $1', [users.tech1.id]);
    assert.equal(target.rows[0].active, true, 'el target no cambia tras perder autorización');
    assert.equal(target.rows[0].email, users.tech1.email, 'el email tampoco cambia tras perder autorización');
    const audit = await query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE action = 'user.update' AND entity_type = 'user' AND entity_id = $1`,
      [String(users.tech1.id)],
    );
    assert.equal(audit.rows[0].count, 0, 'la operación rechazada no deja auditoría de éxito');
  });
}
