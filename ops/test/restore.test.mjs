import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertExpectedTables,
  buildRestoreArguments,
  inspectRestoreTarget,
  listRestoredTables,
  restoreDump,
} from '../lib/restore.mjs';

test('buildRestoreArguments incluye --dbname explícito y no usa --clean', () => {
  const args = buildRestoreArguments('relevo_restore', 'C:/respaldos/daily/relevo.dump');
  const index = args.indexOf('--dbname');
  assert.notEqual(index, -1, 'pg_restore exige --dbname aunque PGDATABASE esté en el entorno');
  assert.equal(args[index + 1], 'relevo_restore');
  assert.equal(args.includes('--clean'), false);
  assert.equal(args.includes('--create'), false);
  assert.equal(args.includes('--single-transaction'), true);
  assert.equal(args.includes('--exit-on-error'), true);
  assert.equal(args.at(-1), 'C:/respaldos/daily/relevo.dump');
  assert.equal(args.some((arg) => arg.includes('postgresql://')), false);

  assert.throws(() => buildRestoreArguments('', 'dump'), /nombre de la base/);
  assert.throws(
    () => buildRestoreArguments('postgresql://u:p@host/relevo_restore', 'dump'),
    /nombre de base/,
  );
});

test('restoreDump pasa --dbname al ejecutor real (regresión del exit 1)', async () => {
  let captured;
  const runner = async (binary, args, options) => {
    captured = { binary, args, options };
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false };
  };

  const result = await restoreDump({
    pgRestorePath: 'C:/PostgreSQL/bin/pg_restore.exe',
    dumpPath: 'C:/respaldos/daily/relevo.dump',
    database: 'relevo_restore',
    env: { PGDATABASE: 'relevo_restore', PGPASSWORD: 'no-debe-ir-en-argv' },
    runner,
  });

  assert.equal(captured.binary, 'C:/PostgreSQL/bin/pg_restore.exe');
  const index = captured.args.indexOf('--dbname');
  assert.notEqual(index, -1);
  assert.equal(captured.args[index + 1], 'relevo_restore');
  assert.equal(captured.args.some((arg) => arg.includes('no-debe-ir-en-argv')), false);
  assert.equal(captured.args.some((arg) => arg.includes('postgresql://')), false);
  assert.equal(captured.args.includes('--clean'), false);
  assert.equal(typeof result.durationMs, 'number');
});

test('preflight cuenta relaciones de public y rechaza destino no vacío', async () => {
  let sql = '';
  const runner = async (_binary, args) => {
    const index = args.indexOf('--command');
    sql = args[index + 1];
    return {
      code: 0,
      signal: null,
      stdout: 'relevo_restore|1|0\n',
      stderr: '',
      timedOut: false,
    };
  };

  await assert.rejects(
    () => inspectRestoreTarget({
      psqlPath: 'psql',
      target: { database: 'relevo_restore' },
      env: {},
      runner,
    }),
    (error) => error.exitCode === 6 && /no vacío/.test(error.message),
  );

  assert.match(sql, /n\.nspname NOT IN \('pg_catalog', 'information_schema'\)/);
  assert.equal(
    sql.includes("n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')"),
    false,
    'las tablas de public deben contar como datos existentes',
  );
});

test('listRestoredTables no excluye el esquema public', async () => {
  let sql = '';
  const runner = async (_binary, args) => {
    const index = args.indexOf('--command');
    sql = args[index + 1];
    return {
      code: 0,
      signal: null,
      stdout: 'public.cases\npublic.payments\npublic.coverages\npublic.loans\n',
      stderr: '',
      timedOut: false,
    };
  };

  const tables = await listRestoredTables({ psqlPath: 'psql', env: {}, runner });
  assert.deepEqual(tables, [
    'public.cases',
    'public.payments',
    'public.coverages',
    'public.loans',
  ]);
  assert.equal(
    sql.includes("n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')"),
    false,
    'la comprobación posterior debe incluir public',
  );
  assert.equal(
    assertExpectedTables(['public.cases', 'public.payments', 'public.coverages', 'public.loans'], tables),
    true,
  );
});
