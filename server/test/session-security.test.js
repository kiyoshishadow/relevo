import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { userCreateSchema, userPatchSchema } from '../validation/schemas.js';

// Import the persistence helper without connecting to or mutating any database.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://unit:unit@127.0.0.1:5432/relevo_test';
const { replaceSessionRecord, establishLoginSession } = await import('../middleware/session.js');
const { lockAndRequireActiveAdmin } = await import('../routes/users.js');
const { closePool } = await import('../db/pool.js');

after(async () => closePool());

test('altas y cambios aceptan como máximo 72 bytes UTF-8 de contraseña', () => {
  const validUser = {
    email: 'owner@example.com', full_name: 'Owner Person', role: 'admin',
    password: 'x'.repeat(72),
  };
  assert.equal(userCreateSchema.safeParse(validUser).success, true);
  assert.equal(userPatchSchema.safeParse({ password: 'x'.repeat(72) }).success, true);
  assert.equal(userCreateSchema.safeParse({ ...validUser, password: `${'x'.repeat(72)}x` }).success, false);
  assert.equal(userPatchSchema.safeParse({ password: 'ñ'.repeat(37) }).success, false);
});

test('rotación elimina primero la sesión antigua e inserta la nueva identidad', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [{ id: params[0] }] };
    },
  };

  await replaceSessionRecord(client, {
    previousId: 'anonymous-session',
    nextId: 'authenticated-session',
    userId: 47,
    csrfToken: 'rotated-csrf',
    ttlMinutes: 480,
    userAgent: 'test-agent',
    ip: '127.0.0.1',
  });

  assert.match(calls[0].sql, /^DELETE FROM sessions WHERE id = \$1 RETURNING id$/);
  assert.deepEqual(calls[0].params, ['anonymous-session']);
  assert.match(calls[1].sql, /INSERT INTO sessions \(id, user_id, csrf_token, expires_at, user_agent, ip\)/);
  assert.deepEqual(calls[1].params, [
    'authenticated-session', 47, 'rotated-csrf', 480, 'test-agent', '127.0.0.1',
  ]);
});

test('si la sesión anterior ya no existe, no inserta una sesión autenticada', async () => {
  let inserts = 0;
  const client = {
    async query(sql) {
      if (sql.startsWith('DELETE')) return { rowCount: 0, rows: [] };
      inserts += 1;
      return { rowCount: 1, rows: [] };
    },
  };

  await assert.rejects(
    replaceSessionRecord(client, {
      previousId: 'expired-session',
      nextId: 'new-session',
      userId: 47,
      csrfToken: 'rotated-csrf',
      ttlMinutes: 480,
      userAgent: null,
      ip: null,
    }),
    error => error.code === 'CSRF_SESSION_EXPIRED' && error.status === 403,
  );
  assert.equal(inserts, 0);
});

function makeLoginTransaction({ user, sessions = [{ id: 'anonymous', user_id: null }] }) {
  const state = { user, sessions: structuredClone(sessions) };
  const withTransaction = async (work) => {
    const snapshot = structuredClone(state.sessions);
    const client = {
      async query(sql, params = []) {
        if (sql.includes('FROM users WHERE id = $1 FOR UPDATE')) return { rows: [state.user] };
        if (sql.startsWith('DELETE FROM sessions')) {
          const before = state.sessions.length;
          state.sessions = state.sessions.filter((session) => session.id !== params[0]);
          return { rowCount: before - state.sessions.length, rows: [] };
        }
        if (sql.includes('INSERT INTO sessions')) {
          state.sessions.push({ id: params[0], user_id: params[1] });
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    try {
      return await work(client);
    } catch (error) {
      state.sessions = snapshot;
      throw error;
    }
  };
  return { state, withTransaction };
}

const candidateUser = {
  id: 7,
  email: 'owner@example.com',
  full_name: 'Owner',
  role: 'admin',
  password_hash: 'bcrypt-hash-before-check',
  active: true,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

function loginInput(candidate = candidateUser, writeLoginAudit = async () => {}) {
  return {
    candidateUser: candidate,
    previousId: 'anonymous',
    nextId: 'authenticated',
    csrfToken: 'rotated-token',
    ttlMinutes: 480,
    userAgent: 'test-agent',
    ip: '127.0.0.1',
    writeLoginAudit,
  };
}

test('login vuelve a validar estado y hash bajo bloqueo de fila antes de rotar sesión', async () => {
  for (const changedUser of [
    { ...candidateUser, active: false },
    { ...candidateUser, password_hash: 'new-hash-after-bcrypt' },
  ]) {
    const database = makeLoginTransaction({ user: changedUser });
    await assert.rejects(
      database.withTransaction((client) => establishLoginSession(client, loginInput())),
      (error) => error.code === 'INVALID_CREDENTIALS' && error.status === 401,
    );
    assert.deepEqual(database.state.sessions, [{ id: 'anonymous', user_id: null }]);
  }
});

test('fallo de auditoría revierte la nueva sesión autenticada y conserva la anterior anónima', async () => {
  const database = makeLoginTransaction({ user: candidateUser });
  let auditWritten = false;
  await assert.rejects(
    database.withTransaction((client) => establishLoginSession(client, loginInput(candidateUser, async () => {
      auditWritten = true;
      throw new Error('synthetic audit failure');
    }))),
    /synthetic audit failure/,
  );
  assert.equal(auditWritten, true);
  assert.deepEqual(database.state.sessions, [{ id: 'anonymous', user_id: null }]);
});

test('PATCH toma el advisory lock y revalida el rol actual antes de escribir', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      return { rows: [{ role: 'reception', active: true }] };
    },
  };

  await assert.rejects(
    lockAndRequireActiveAdmin(client, 12),
    (error) => error.code === 'FORBIDDEN' && error.status === 403,
  );
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[0].params, [0x55534552, 1]);
  assert.match(calls[1].sql, /SELECT role, active FROM users WHERE id = \$1/);
  assert.deepEqual(calls[1].params, [12]);
});
