#!/usr/bin/env node
import path from 'node:path';
import { formatHelp, parseCommandLine, rejectConnectionStringsInArgs, runMain } from './lib/cli.mjs';
import { resolvePgBinary, tailForError } from './lib/child-process.mjs';
import {
  assertRestoreTarget,
  buildPgEnvironment,
  parseDatabaseUrl,
} from './lib/database-url.mjs';
import { EXIT, OpsError } from './lib/errors.mjs';
import {
  assertExpectedTables,
  inspectRestoreTarget,
  listRestoredTables,
  normalizeExpectedTables,
  restoreDump,
} from './lib/restore.mjs';
import { autoManifestPath, verifyArchive } from './lib/verify.mjs';

const HELP = formatHelp('Uso: node ops/restore.mjs --dump <archivo.dump> [opciones]', [
  'Restaura un respaldo verificado SOLO en una base aislada relevo_restore* o relevo_test*.',
  'Rechaza la base de origen, bases con otros nombres y destinos no vacíos.',
  'Nunca usa --clean ni DROP; restaura en una sola transacción.',
  '',
  'Variables de entorno:',
  '  DATABASE_URL         URL de la base de origen (obligatoria, para comparar identidad).',
  '  RESTORE_DATABASE_URL URL de la base aislada de destino (obligatoria).',
  '  PG_BIN               Carpeta bin de PostgreSQL (opcional; PATH/Program Files).',
  '',
  'Opciones:',
  '  --dump <ruta>          Respaldo .dump (obligatorio).',
  '  --manifest <ruta>      Manifiesto JSON; por defecto el .manifest.json hermano.',
  '  --expect-table <tabla> Tabla que debe existir tras restaurar (repetible).',
  '  --help                 Muestra esta ayuda.',
]);

const SPEC = {
  dump: { type: 'string' },
  manifest: { type: 'string' },
  'expect-table': { type: 'multiple' },
};

async function main() {
  rejectConnectionStringsInArgs(process.argv.slice(2));
  const { values, help } = parseCommandLine(process.argv.slice(2), SPEC);
  if (help) {
    console.log(HELP);
    return EXIT.OK;
  }
  if (!values.dump) {
    throw new OpsError('Falta --dump.', EXIT.USAGE);
  }

  const origin = parseDatabaseUrl(process.env.DATABASE_URL, 'DATABASE_URL');
  const target = parseDatabaseUrl(process.env.RESTORE_DATABASE_URL, 'RESTORE_DATABASE_URL');
  assertRestoreTarget({ target, origin });
  const expectedTables = normalizeExpectedTables(values['expect-table'] ?? []);

  const dumpPath = path.resolve(values.dump);
  const manifestPath = autoManifestPath(dumpPath, values.manifest ? path.resolve(values.manifest) : undefined);
  if (!manifestPath) {
    throw new OpsError('El respaldo debe tener extensión .dump para localizar su manifiesto.', EXIT.USAGE);
  }

  const pgRestore = resolvePgBinary('pg_restore', { pgBin: process.env.PG_BIN, env: process.env });
  const psql = resolvePgBinary('psql', { pgBin: process.env.PG_BIN, env: process.env });
  const targetEnv = buildPgEnvironment(target);
  const originEnv = buildPgEnvironment(origin);

  const verified = await verifyArchive({
    dumpPath,
    manifestPath,
    pgRestorePath: pgRestore,
    env: originEnv,
    requireManifest: true,
  });

  console.log(`Respaldo verificado: ${verified.sha256} (${verified.tocEntries} entradas TOC).`);
  console.log(`Destino aislado: ${target.display}`);

  const preflight = await inspectRestoreTarget({
    psqlPath: psql,
    target,
    env: targetEnv,
  });
  console.log(`Preflight OK: base "${preflight.currentDatabase}" vacía (${preflight.userRelations} relaciones de usuario).`);

  const restored = await restoreDump({
    pgRestorePath: pgRestore,
    dumpPath,
    database: target.database,
    env: targetEnv,
  });

  const tables = await listRestoredTables({ psqlPath: psql, env: targetEnv });
  if (expectedTables.length > 0) {
    assertExpectedTables(expectedTables, tables);
  }

  console.log('Restauración ejecutada en la base aislada.');
  console.log(`Destino: ${target.display}`);
  console.log(`Tablas restauradas: ${tables.length}`);
  if (expectedTables.length > 0) {
    console.log(`Tablas esperadas comprobadas: ${expectedTables.join(', ')}`);
  }
  console.log(`Duración: ${(restored.durationMs / 1000).toFixed(1)} s`);
  if (restored.stderr.trim()) {
    console.warn(`Avisos de pg_restore: ${tailForError(restored.stderr, 1500)}`);
  }

  return EXIT.OK;
}

await runMain(main);
