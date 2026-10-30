import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapAdmin } from '../../scripts/bootstrap-admin.js';

const input = {
  BOOTSTRAP_ADMIN_EMAIL: ' OWNER@EXAMPLE.COM ',
  BOOTSTRAP_ADMIN_FULL_NAME: ' Ada Owner ',
  BOOTSTRAP_ADMIN_PASSWORD: 'long-test-password',
};

function makeDatabase({ initialUsers = [], failInsert = false, afterEmptyCheck = async () => {} } = {}) {
  let users = initialUsers.map((user) => ({ ...user }));
  let lockTail = Promise.resolve();
  let tableLockTail = Promise.resolve();
  const queries = [];

  const acquireTableLock = async () => {
    const previous = tableLockTail;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    tableLockTail = previous.then(() => gate);
    await previous;
    return release;
  };

  const withTransaction = async (work) => {
    let unlock;
    let unlockTable;
    let snapshot;
    const client = {
      async query(sql, params = []) {
        queries.push({ sql, params });
        if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
          const previous = lockTail;
          let release;
          lockTail = new Promise((resolve) => { release = resolve; });
          await previous;
          unlock = release;
          snapshot = users.map((user) => ({ ...user }));
          assert.deepEqual(params, [0x55534552, 1]);
          return { rows: [] };
        }
        if (sql === 'LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE') {
          unlockTable = await acquireTableLock();
          return { rows: [] };
        }
        if (sql === 'SELECT id FROM users LIMIT 1') {
          await afterEmptyCheck();
          return { rows: users.slice(0, 1).map(({ id }) => ({ id })) };
        }
        if (sql.includes('INSERT INTO users')) {
          if (failInsert) throw new Error('synthetic insert failure');
          users.push({ email: params[0], full_name: params[1], role: 'admin', password_hash: params[2], active: true });
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL in fake: ${sql}`);
      },
    };
    try {
      return await work(client);
    } catch (error) {
      if (snapshot) users = snapshot;
      throw error;
    } finally {
      unlockTable?.();
      unlock?.();
    }
  };

  const insertFromOtherWriter = async (user) => {
    const release = await acquireTableLock();
    try {
      users.push({ ...user });
    } finally {
      release();
    }
  };

  return { withTransaction, insertFromOtherWriter, queries, get users() { return users; } };
}

function deps(database, calls = []) {
  return {
    env: input,
    withTransaction: database.withTransaction,
    async hashPassword(password, cost) {
      calls.push({ password, cost });
      return 'synthetic-bcrypt-hash';
    },
  };
}

test('bootstrap valida el esquema, exige rol admin y crea el usuario sin filtrar secretos', async () => {
  const database = makeDatabase();
  const hashes = [];
  await bootstrapAdmin(deps(database, hashes));

  assert.deepEqual(database.users, [{
    email: 'owner@example.com',
    full_name: 'Ada Owner',
    role: 'admin',
    password_hash: 'synthetic-bcrypt-hash',
    active: true,
  }]);
  assert.deepEqual(hashes, [{ password: input.BOOTSTRAP_ADMIN_PASSWORD, cost: 12 }]);
  assert.match(database.queries[0].sql, /pg_advisory_xact_lock/);
  assert.equal(database.queries[1].sql, 'LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
  assert.equal(database.queries[2].sql, 'SELECT id FROM users LIMIT 1');
});

test('no reemplaza ni altera una base que ya tiene cualquier usuario', async () => {
  const database = makeDatabase({ initialUsers: [{ id: 8, email: 'existing@example.com' }] });
  const before = structuredClone(database.users);

  await assert.rejects(bootstrapAdmin(deps(database)), /users ya contiene usuarios/);
  assert.deepEqual(database.users, before);
});

test('rechaza variables faltantes y datos fuera del userCreateSchema antes de hashear', async () => {
  const database = makeDatabase();
  let hashCalls = 0;
  const base = deps(database);
  const invalid = { ...base, env: { ...input, BOOTSTRAP_ADMIN_PASSWORD: 'short' }, hashPassword: async () => { hashCalls += 1; } };

  await assert.rejects(bootstrapAdmin({ ...base, env: { ...input, BOOTSTRAP_ADMIN_EMAIL: '' } }), /BOOTSTRAP_ADMIN_EMAIL es obligatorio/);
  await assert.rejects(bootstrapAdmin(invalid), /no cumplen el esquema/);
  await assert.rejects(
    bootstrapAdmin({
      ...base,
      env: { ...input, BOOTSTRAP_ADMIN_PASSWORD: 'ñ'.repeat(37) },
    }),
    /no cumplen el esquema/,
  );
  assert.equal(hashCalls, 0);
  assert.equal(database.users.length, 0);
});

test('un error de INSERT revierte la transacción', async () => {
  const database = makeDatabase({ failInsert: true });
  await assert.rejects(bootstrapAdmin(deps(database)), /synthetic insert failure/);
  assert.deepEqual(database.users, []);
});

test('el bloqueo advisory serializa dos bootstraps concurrentes y solo deja un admin', async () => {
  const database = makeDatabase();
  const results = await Promise.allSettled([
    bootstrapAdmin(deps(database)),
    bootstrapAdmin(deps(database)),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(database.users.length, 1);
  assert.equal(database.users[0].role, 'admin');
});

test('el bloqueo de tabla detiene INSERT externos entre el chequeo de vacío y el commit', async () => {
  let reachedEmptyCheck;
  let allowCheckToFinish;
  const emptyCheckReached = new Promise((resolve) => { reachedEmptyCheck = resolve; });
  const proceed = new Promise((resolve) => { allowCheckToFinish = resolve; });
  const database = makeDatabase({ afterEmptyCheck: async () => {
    reachedEmptyCheck();
    await proceed;
  } });

  const bootstrap = bootstrapAdmin(deps(database));
  await emptyCheckReached;
  let writerFinished = false;
  const writer = database.insertFromOtherWriter({ id: 2, email: 'concurrent@example.com' })
    .then(() => { writerFinished = true; });
  await Promise.resolve();
  assert.equal(writerFinished, false, 'un INSERT sin advisory lock también espera por el bloqueo de tabla');

  allowCheckToFinish();
  await bootstrap;
  await writer;
  assert.deepEqual(database.users.map((user) => user.email), [
    'owner@example.com',
    'concurrent@example.com',
  ]);
});
