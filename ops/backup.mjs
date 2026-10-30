#!/usr/bin/env node
import { chmod, rename } from 'node:fs/promises';
import path from 'node:path';
import { formatHelp, parseCommandLine, rejectConnectionStringsInArgs, runMain } from './lib/cli.mjs';
import {
  buildPgEnvironment,
  parseDatabaseUrl,
  redactText,
} from './lib/database-url.mjs';
import { resolvePgBinary, runProcess, readToolVersion, tailForError } from './lib/child-process.mjs';
import { EXIT, OpsError } from './lib/errors.mjs';
import { buildManifest } from './lib/manifest.mjs';
import {
  buildBackupFileName,
  defaultBackupRoot,
  ensureBackupLayout,
  formatBytes,
  isPathInside,
  OPS_DIR,
  pathExists,
  removeIfExists,
  sha256File,
  validateBackupRoot,
  writeJsonAtomic,
  copyFileAtomic,
  manifestNameForDump,
} from './lib/paths.mjs';
import { DEFAULT_RETENTION, pruneBackups } from './lib/retention.mjs';
import { verifyArchive } from './lib/verify.mjs';

const HELP = formatHelp('Uso: node ops/backup.mjs [opciones]', [
  'Crea un respaldo pg_dump en formato custom, lo verifica con pg_restore --list,',
  'escribe su manifiesto con SHA-256 y aplica retención 7 diarias / 4 semanales.',
  '',
  'Variables de entorno:',
  '  DATABASE_URL   URL PostgreSQL de origen (obligatoria; no se lee .env).',
  '  PG_BIN         Carpeta bin de PostgreSQL (opcional; por defecto PATH/Program Files).',
  '  BACKUP_DIR     Carpeta raíz de respaldos (opcional; por defecto ops/backups).',
  '',
  'Opciones:',
  '  --output-dir <ruta>  Reemplaza BACKUP_DIR.',
  '  --weekly             Fuerza además la copia semanal (los domingos UTC es automática).',
  '  --no-prune           No aplica retención en esta ejecución.',
  '  --help               Muestra esta ayuda.',
]);

const SPEC = {
  'output-dir': { type: 'string' },
  weekly: { type: 'boolean' },
  'no-prune': { type: 'boolean' },
};

async function main() {
  rejectConnectionStringsInArgs(process.argv.slice(2));
  const { values, help } = parseCommandLine(process.argv.slice(2), SPEC);
  if (help) {
    console.log(HELP);
    return EXIT.OK;
  }

  const databaseUrl = process.env.DATABASE_URL;
  const connection = parseDatabaseUrl(databaseUrl, 'DATABASE_URL');
  const pgEnv = buildPgEnvironment(connection);
  const pgDump = resolvePgBinary('pg_dump', { pgBin: process.env.PG_BIN, env: process.env });
  const pgRestore = resolvePgBinary('pg_restore', { pgBin: process.env.PG_BIN, env: process.env });

  const root = validateBackupRoot(values['output-dir'] ?? defaultBackupRoot(process.env));
  try {
    await ensureBackupLayout(root);
  } catch (error) {
    throw new OpsError(`No se pudo preparar la carpeta de respaldos ${root}: ${error.message}`, EXIT.BACKUP, { cause: error });
  }
  if (isPathInside(OPS_DIR, root)) {
    console.warn('Aviso: la carpeta de respaldos está dentro del repositorio. En producción use BACKUP_DIR fuera del equipo de PostgreSQL y del repositorio.');
  }

  const startedAt = new Date();
  const fileName = buildBackupFileName(startedAt);
  const dailyDump = path.join(root, 'daily', fileName);
  const dailyManifest = path.join(root, 'daily', manifestNameForDump(fileName));
  const weeklyDump = path.join(root, 'weekly', fileName);
  const weeklyManifest = path.join(root, 'weekly', manifestNameForDump(fileName));
  const tempDump = `${dailyDump}.partial-${process.pid}-${startedAt.getTime()}`;

  if (await pathExists(dailyDump) || await pathExists(dailyManifest)
    || await pathExists(weeklyDump) || await pathExists(weeklyManifest)) {
    throw new OpsError(`Ya existe un respaldo con el mismo nombre: ${fileName}`, EXIT.BACKUP);
  }

  const pgDumpVersion = await readToolVersion(pgDump, pgEnv);
  const dumpArgs = [
    '--format=custom',
    '--compress=9',
    '--no-owner',
    '--no-privileges',
    '--no-password',
    '--lock-wait-timeout=30s',
    '--file',
    tempDump,
  ];
  const displayArgs = [
    '--format=custom',
    '--compress=9',
    '--no-owner',
    '--no-privileges',
    '--no-password',
    '--lock-wait-timeout=30s',
    '--file',
    `<backup-root>/daily/${fileName}`,
  ];

  let dailyVerified;
  try {
    const dumpResult = await runProcess(pgDump, dumpArgs, {
      env: pgEnv,
      label: 'pg_dump',
      timeoutMs: 30 * 60 * 1000,
    });
    if (dumpResult.timedOut) {
      throw new OpsError('pg_dump excedió el tiempo máximo de 30 minutos.', EXIT.BACKUP);
    }
    if (dumpResult.code !== 0) {
      const detail = tailForError(redactText(dumpResult.stderr, [connection.password, connection.raw]));
      throw new OpsError(
        `pg_dump falló (código ${dumpResult.code}).${detail ? ` ${detail}` : ''}`,
        EXIT.BACKUP,
      );
    }

    try {
      await chmod(tempDump, 0o600);
      await rename(tempDump, dailyDump);
    } catch (error) {
      throw new OpsError(`No se pudo preparar el respaldo diario ${dailyDump}: ${error.message}`, EXIT.BACKUP, { cause: error });
    }

    try {
      dailyVerified = await verifyArchive({
        dumpPath: dailyDump,
        manifestPath: null,
        pgRestorePath: pgRestore,
        env: pgEnv,
        requireManifest: false,
      });
    } catch (error) {
      await removeIfExists(dailyDump);
      throw error;
    }
  } finally {
    await removeIfExists(tempDump);
  }

  const dailyManifestData = buildManifest({
    kind: 'daily',
    createdAt: startedAt,
    completedAt: new Date(),
    connection,
    root,
    dumpPath: dailyDump,
    bytes: dailyVerified.bytes,
    sha256: dailyVerified.sha256,
    commandBinary: pgDump,
    commandArgs: displayArgs,
    pgDumpVersion,
    verification: {
      tocEntries: dailyVerified.tocEntries,
      checkedAt: dailyVerified.checkedAt,
    },
  });

  try {
    await writeJsonAtomic(dailyManifest, dailyManifestData);
  } catch (error) {
    await removeIfExists(dailyDump);
    throw new OpsError(`No se pudo escribir el manifiesto diario: ${error.message}`, EXIT.BACKUP, { cause: error });
  }

  let weeklyVerified = null;
  const makeWeekly = values.weekly === true || startedAt.getUTCDay() === 0;
  if (makeWeekly) {
    try {
      await copyFileAtomic(dailyDump, weeklyDump);
      await chmod(weeklyDump, 0o600);
      const weeklySha = await sha256File(weeklyDump);
      if (weeklySha !== dailyVerified.sha256) {
        throw new OpsError('La copia semanal no coincide en SHA-256 con la diaria.', EXIT.VERIFY);
      }
      weeklyVerified = await verifyArchive({
        dumpPath: weeklyDump,
        manifestPath: null,
        pgRestorePath: pgRestore,
        env: pgEnv,
        requireManifest: false,
      });
      const weeklyManifestData = buildManifest({
        kind: 'weekly',
        createdAt: startedAt,
        completedAt: new Date(),
        connection,
        root,
        dumpPath: weeklyDump,
        bytes: weeklyVerified.bytes,
        sha256: weeklyVerified.sha256,
        commandBinary: pgDump,
        commandArgs: displayArgs,
        pgDumpVersion,
        verification: {
          tocEntries: weeklyVerified.tocEntries,
          checkedAt: weeklyVerified.checkedAt,
        },
        source: `daily/${fileName}`,
      });
      await writeJsonAtomic(weeklyManifest, weeklyManifestData);
    } catch (error) {
      await removeIfExists(weeklyDump);
      await removeIfExists(weeklyManifest);
      throw new OpsError(`Falló la copia semanal: ${redactText(error.message)}`, EXIT.BACKUP, { cause: error });
    }
  }

  let pruned = null;
  if (values['no-prune'] !== true) {
    pruned = await pruneBackups(root, DEFAULT_RETENTION, {
      protect: makeWeekly ? [dailyDump, weeklyDump] : [dailyDump],
    });
  }

  console.log('Respaldo completado.');
  console.log(`Base de origen: ${connection.display}`);
  console.log(`Diario: ${dailyDump}`);
  console.log(`Semanal: ${makeWeekly ? weeklyDump : 'no generado (use --weekly o espere al domingo UTC)'}`);
  console.log(`Tamaño: ${formatBytes(dailyVerified.bytes)}`);
  console.log(`SHA-256: ${dailyVerified.sha256}`);
  console.log(`Verificación: OK (${dailyVerified.tocEntries} entradas TOC)`);
  if (dailyVerified.tocEntries === 0) {
    console.warn('Aviso: el archivo es válido pero no contiene entradas TOC (base de origen vacía).');
  }
  if (pruned) {
    console.log(`Retención: ${pruned.removed.length} respaldo(s) eliminado(s); conservados ${pruned.keep.filter((entry) => entry.kind === 'daily').length} diarios y ${pruned.keep.filter((entry) => entry.kind === 'weekly').length} semanales.`);
    for (const warning of pruned.warnings) console.warn(`Aviso: ${warning}`);
  } else {
    console.log('Retención: omitida por --no-prune.');
  }

  return EXIT.OK;
}

await runMain(main);
