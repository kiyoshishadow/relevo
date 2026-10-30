import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { formatHelp, parseCommandLine, rejectConnectionStringsInArgs } from '../lib/cli.mjs';
import {
  assertRestoreTarget,
  buildPgEnvironment,
  parseDatabaseUrl,
  redactDatabaseUrl,
  redactText,
  sameDatabase,
} from '../lib/database-url.mjs';
import { assertExpectedTables, normalizeExpectedTables } from '../lib/restore.mjs';

const OPS_DIR = path.resolve(import.meta.dirname, '..');

function url(database, { user = 'equipo', password = 'S3cr3t!', host = 'localhost', port = 5432 } = {}) {
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : '';
  return `postgresql://${auth}${host}:${port}/${database}`;
}

function runCli(script, args = [], extraEnv = {}) {
  const env = { ...process.env };
  for (const key of ['DATABASE_URL', 'RESTORE_DATABASE_URL', 'PG_BIN', 'BACKUP_DIR']) delete env[key];
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [path.join(OPS_DIR, script), ...args], {
    cwd: OPS_DIR,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('parseDatabaseUrl acepta URL TCP y oculta la contraseña al serializar', () => {
  const connection = parseDatabaseUrl(
    'postgresql://us%40er:p%40ss@127.0.0.1:5544/relevo?sslmode=require&connect_timeout=5',
    'DATABASE_URL',
  );
  assert.equal(connection.username, 'us@er');
  assert.equal(connection.password, 'p@ss');
  assert.equal(connection.host, '127.0.0.1');
  assert.equal(connection.port, 5544);
  assert.equal(connection.database, 'relevo');
  assert.equal(connection.params.sslmode, 'require');
  assert.equal(JSON.stringify(connection).includes('p@ss'), false);
  assert.equal(redactDatabaseUrl(connection).includes('p@ss'), false);
  assert.equal(redactDatabaseUrl(connection).includes('us%40er'), false);

  const env = buildPgEnvironment(connection, {
    PATH: 'x',
    PGHOST: 'otro-host',
    PGPASSWORD: 'stale',
    PGPASSFILE: 'archivo',
  });
  assert.equal(env.PGHOST, '127.0.0.1');
  assert.equal(env.PGDATABASE, 'relevo');
  assert.equal(env.PGPASSWORD, 'p@ss');
  assert.equal(env.PGSSLMODE, 'require');
  assert.equal(env.PGPASSFILE, 'archivo');
});

test('parseDatabaseUrl rechaza esquemas, bases y secretos no soportados', () => {
  for (const value of [
    'mysql://localhost/relevo',
    'postgresql://localhost',
    'postgresql://localhost/',
    'postgresql://:p@localhost/relevo',
    'postgresql://localhost:99999/relevo',
    'postgresql://localhost/relevo?password=secreto',
  ]) {
    assert.throws(() => parseDatabaseUrl(value), /URL|esquema|host|base|puerto|contraseñas/i, value);
  }
});

test('sameDatabase compara host, puerto y nombre de base', () => {
  const base = parseDatabaseUrl(url('relevo'));
  assert.equal(sameDatabase(base, parseDatabaseUrl(url('relevo'))), true);
  assert.equal(sameDatabase(base, parseDatabaseUrl(url('relevo', { port: 5433 }))), false);
  assert.equal(sameDatabase(base, parseDatabaseUrl(url('relevo', { host: '127.0.0.1' }))), false);
});

test('assertRestoreTarget acepta solo destinos aislados y rechaza el origen', () => {
  const origin = parseDatabaseUrl(url('relevo'));
  for (const name of ['relevo_restore', 'relevo_restore_ops01', 'relevo_test', 'relevo_test_20261027']) {
    assert.doesNotThrow(() => assertRestoreTarget({
      target: parseDatabaseUrl(url(name)),
      origin,
    }), name);
  }

  for (const name of [
    'relevo',
    'postgres',
    'relevo_restorex',
    'relevo_restore-ops',
    'relevo_restore__ops',
    'relevo_restore_',
    'relevo_test;drop',
    'relevo_prod',
  ]) {
    assert.throws(
      () => assertRestoreTarget({ target: parseDatabaseUrl(url(name)), origin }),
      (error) => error.exitCode === 6,
      name,
    );
  }

  const tooLong = `relevo_restore_${'a'.repeat(60)}`;
  assert.throws(() => assertRestoreTarget({ target: parseDatabaseUrl(url(tooLong)), origin }), /63/);

  assert.throws(
    () => assertRestoreTarget({
      target: parseDatabaseUrl(url('relevo_test')),
      origin: parseDatabaseUrl(url('relevo_test')),
    }),
    /misma base de origen/,
  );

  assert.doesNotThrow(() => assertRestoreTarget({
    target: parseDatabaseUrl(url('relevo_test', { host: '127.0.0.1' })),
    origin: parseDatabaseUrl(url('relevo_test')),
  }));
});

test('redactText elimina URLs y asignaciones de contraseña', () => {
  const text = redactText(
    'falló postgresql://usuario:S3cr3t!@localhost:5432/relevo PGPASSWORD=S3cr3t! password=otro',
    ['S3cr3t!'],
  );
  assert.equal(text.includes('S3cr3t!'), false);
  assert.equal(text.includes('usuario:'), false);
  assert.match(text, /postgresql:\/\/<redacted>/);
  assert.match(text, /PGPASSWORD=\*\*\*/);
  assert.match(text, /password=\*\*\*/);
});

test('parseCommandLine no repite valores en errores', () => {
  assert.throws(
    () => parseCommandLine(['--desconocida=postgresql://u:p@h/db'], {}),
    (error) => error.exitCode === 2 && !error.message.includes('p@h'),
  );
  assert.throws(
    () => parseCommandLine(['valor-posicional'], {}),
    /posicionales/,
  );
  assert.throws(
    () => parseCommandLine(['--dump', 'a', '--dump', 'b'], { dump: { type: 'string' } }),
    /más de una vez/,
  );
  assert.throws(
    () => parseCommandLine(['--weekly=1'], { weekly: { type: 'boolean' } }),
    /no admite valor/,
  );
  assert.throws(
    () => rejectConnectionStringsInArgs(['--x=postgresql://u:p@h/db']),
    /cadenas de conexión/,
  );
});

test('normalizeExpectedTables y assertExpectedTables validan nombres', () => {
  assert.deepEqual(normalizeExpectedTables(['cases', 'public.payments', 'CASES']), ['public.cases', 'public.payments']);
  assert.throws(() => normalizeExpectedTables(['cases; drop table x']), /no válido/);
  assert.equal(assertExpectedTables(['public.cases'], ['public.cases', 'public.payments']), true);
  assert.throws(() => assertExpectedTables(['public.otros'], ['public.cases']), /faltan tablas/);
});

test('CLI usa códigos de salida seguros sin conexión conocida', () => {
  const help = runCli('backup.mjs', ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /DATABASE_URL/);

  const noEnv = runCli('backup.mjs');
  assert.equal(noEnv.status, 3);
  assert.match(noEnv.stderr, /DATABASE_URL/);

  const unknown = runCli('backup.mjs', ['--database-url=postgresql://u:S3cr3t!@localhost:5432/relevo']);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stderr.includes('S3cr3t!'), false);

  const verifyNoDump = runCli('verify.mjs');
  assert.equal(verifyNoDump.status, 2);
  assert.match(verifyNoDump.stderr, /--dump/);

  const restoreNoEnv = runCli('restore.mjs', ['--dump', 'inexistente.dump']);
  assert.equal(restoreNoEnv.status, 3);

  const restoreOtherDb = runCli('restore.mjs', ['--dump', 'inexistente.dump'], {
    DATABASE_URL: url('relevo'),
    RESTORE_DATABASE_URL: url('postgres'),
  });
  assert.equal(restoreOtherDb.status, 6);
  assert.equal(restoreOtherDb.stderr.includes('S3cr3t!'), false);

  const restoreSameDb = runCli('restore.mjs', ['--dump', 'inexistente.dump'], {
    DATABASE_URL: url('relevo_test'),
    RESTORE_DATABASE_URL: url('relevo_test'),
  });
  assert.equal(restoreSameDb.status, 6);
  assert.match(restoreSameDb.stderr, /misma base de origen/);

  const pruneHelp = runCli('prune.mjs', ['--help']);
  assert.equal(pruneHelp.status, 0);
  assert.match(formatHelp('x', ['y']), /Códigos/);
});
