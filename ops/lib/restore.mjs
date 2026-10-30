import { runProcess, tailForError } from './child-process.mjs';
import { redactText } from './database-url.mjs';
import { EXIT, OpsError } from './errors.mjs';

const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema')";
const NON_USER_SCHEMAS = "('pg_catalog', 'information_schema', 'public')";

const PREFLIGHT_SQL = `
SELECT current_database(),
       (SELECT count(*)
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','p','v','m','S','f')
           AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
           AND n.nspname NOT LIKE 'pg_toast%'
           AND n.nspname NOT LIKE 'pg_temp%') AS user_relations,
       (SELECT count(*)
          FROM pg_catalog.pg_namespace
         WHERE nspname NOT IN ${NON_USER_SCHEMAS}
           AND nspname NOT LIKE 'pg_toast%'
           AND nspname NOT LIKE 'pg_temp%') AS user_schemas;
`;

const TABLES_SQL = `
SELECT n.nspname || '.' || c.relname
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r','p')
   AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
   AND n.nspname NOT LIKE 'pg_toast%'
   AND n.nspname NOT LIKE 'pg_temp%'
 ORDER BY 1;
`;

function psqlFailure(label, result, secret) {
  if (result.timedOut) {
    return new OpsError(`${label} excedió el tiempo máximo.`, EXIT.CONNECTION);
  }
  const detail = tailForError(redactText(result.stderr, [secret]));
  return new OpsError(
    `${label} falló (código ${result.code}).${detail ? ` ${detail}` : ''}`,
    EXIT.CONNECTION,
  );
}

async function runPsql(psqlPath, sql, env, label, timeoutMs, runner = runProcess) {
  return runner(
    psqlPath,
    [
      '--no-psqlrc',
      '--no-password',
      '--set=ON_ERROR_STOP=1',
      '--tuples-only',
      '--no-align',
      '--field-separator=|',
      '--command',
      sql,
    ],
    { env, label, timeoutMs, maxOutputBytes: 4 * 1024 * 1024 },
  );
}

function nonEmptyLines(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Comprueba que la conexión apunta a la base esperada y que está vacía.
 * No modifica nada.
 */
export async function inspectRestoreTarget({
  psqlPath,
  target,
  env,
  timeoutMs = 60_000,
  runner = runProcess,
}) {
  const result = await runPsql(psqlPath, PREFLIGHT_SQL, env, 'inspección del destino', timeoutMs, runner);
  if (result.code !== 0 || result.timedOut) throw psqlFailure('La inspección del destino', result, target.password);

  const line = nonEmptyLines(result.stdout)[0];
  if (!line) {
    throw new OpsError('La inspección del destino no devolvió datos.', EXIT.CONNECTION);
  }
  const [currentDatabase, relationsText, schemasText] = line.split('|');
  const userRelations = Number(relationsText);
  const userSchemas = Number(schemasText);
  if (!Number.isInteger(userRelations) || !Number.isInteger(userSchemas)) {
    throw new OpsError('La inspección del destino devolvió un formato inesperado.', EXIT.CONNECTION);
  }

  if (currentDatabase !== target.database) {
    throw new OpsError(
      `La conexión llegó a la base "${currentDatabase}", distinta de la base aislada esperada "${target.database}".`,
      EXIT.RESTORE_GUARD,
    );
  }
  if (userRelations > 0 || userSchemas > 0) {
    throw new OpsError(
      `Destino no vacío (${userRelations} relaciones y ${userSchemas} esquemas de usuario). No se borra ni se sobrescribe nada; cree una base aislada nueva.`,
      EXIT.RESTORE_GUARD,
    );
  }

  return { currentDatabase, userRelations, userSchemas };
}

/**
 * Argumentos de pg_restore. `--dbname` es obligatorio: pg_restore no toma la
 * base de PGDATABASE cuando se le pasa un archivo y exige -d/--dbname o -f.
 * Se pasa el nombre, nunca una URL ni una contraseña.
 */
export function buildRestoreArguments(database, dumpPath) {
  if (typeof database !== 'string' || database.trim() === '') {
    throw new OpsError('Falta el nombre de la base destino para pg_restore.', EXIT.RESTORE_GUARD);
  }
  if (/postgres(?:ql)?:\/\//i.test(database)) {
    throw new OpsError('El destino de pg_restore debe ser un nombre de base, no una URL.', EXIT.RESTORE_GUARD);
  }
  return [
    '--no-owner',
    '--no-privileges',
    '--no-password',
    '--exit-on-error',
    '--single-transaction',
    '--dbname',
    database,
    dumpPath,
  ];
}

/**
 * Restaura sin --clean, sin DROP y en una sola transacción. El destino debe
 * haber pasado inspectRestoreTarget (vacío y con nombre permitido).
 *
 * `runner` permite inyectar un ejecutor en pruebas para comprobar el argv.
 */
export async function restoreDump({
  pgRestorePath,
  dumpPath,
  database,
  env,
  timeoutMs = 60 * 60 * 1000,
  runner = runProcess,
}) {
  const started = Date.now();
  const args = buildRestoreArguments(database, dumpPath);
  const result = await runner(
    pgRestorePath,
    args,
    {
      env,
      label: 'pg_restore',
      timeoutMs,
      maxOutputBytes: 8 * 1024 * 1024,
    },
  );

  if (result.timedOut) {
    throw new OpsError(
      'pg_restore excedió el tiempo máximo y se interrumpió; la transacción debe haber revertido al cerrar la conexión. Verifique el estado antes de reintentar.',
      EXIT.RESTORE,
    );
  }
  if (result.code !== 0) {
    const detail = tailForError(redactText(result.stderr));
    throw new OpsError(
      `pg_restore falló (código ${result.code}); --single-transaction debe haber revertido los cambios.${detail ? ` ${detail}` : ''}`,
      EXIT.RESTORE,
    );
  }

  return {
    durationMs: Date.now() - started,
    stderr: redactText(result.stderr),
  };
}

/** Lista tablas y vistas materializadas de usuario tras la restauración. */
export async function listRestoredTables({
  psqlPath,
  env,
  timeoutMs = 60_000,
  runner = runProcess,
}) {
  const result = await runPsql(psqlPath, TABLES_SQL, env, 'comprobación posterior', timeoutMs, runner);
  if (result.code !== 0 || result.timedOut) throw psqlFailure('La comprobación posterior', result);
  return nonEmptyLines(result.stdout);
}

export function normalizeExpectedTables(expectedTables = []) {
  const normalized = new Set();
  for (const raw of expectedTables) {
    const value = String(raw).trim().toLowerCase();
    if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(value)) {
      throw new OpsError(`Nombre de tabla esperada no válido: ${raw}`, EXIT.USAGE);
    }
    normalized.add(value.includes('.') ? value : `public.${value}`);
  }
  return [...normalized];
}

export function assertExpectedTables(expectedTables, actualTables) {
  const actual = new Set(actualTables.map((name) => name.toLowerCase()));
  const missing = expectedTables.filter((name) => !actual.has(name));
  if (missing.length > 0) {
    throw new OpsError(
      `La restauración terminó, pero faltan tablas esperadas: ${missing.join(', ')}. Los datos restaurados permanecen en la base aislada para inspección.`,
      EXIT.RESTORE,
    );
  }
  return true;
}
