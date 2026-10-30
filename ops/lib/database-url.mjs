import { EXIT, OpsError } from './errors.mjs';

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const SECRET_QUERY_KEYS = new Set(['password', 'pass', 'passwd', 'pwd', 'pgpassword']);
const MAX_IDENTIFIER_BYTES = 63;

/** Prefijo obligatorio para cualquier destino de restauración. */
export const RESTORE_DATABASE_PATTERN = /^relevo_(?:restore|test)(?:_[a-z0-9]+)*$/i;

const PG_ENV_MAP = Object.freeze({
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  sslcrl: 'PGSSLCRL',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  application_name: 'PGAPPNAME',
  options: 'PGOPTIONS',
  target_session_attrs: 'PGTARGETSESSIONATTRS',
});

const SCRUBBED_PG_ENV = Object.freeze([
  'PGHOST',
  'PGHOSTADDR',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGSERVICE',
  'PGSERVICEFILE',
  ...Object.values(PG_ENV_MAP),
]);

function decodeUrlPart(value, label) {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    throw new OpsError(`${label} contiene caracteres escapados no válidos.`, EXIT.CONFIG);
  }
}

function stripIpv6Brackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function formatHostForUrl(hostname) {
  return hostname.includes(':') ? `[${hostname}]` : hostname;
}

/**
 * Convierte DATABASE_URL/RESTORE_DATABASE_URL en datos de conexión sin exponer
 * la contraseña al serializar el objeto. Solo se admite TCP (host en la URL).
 *
 * @param {string} raw
 * @param {string} label
 */
export function parseDatabaseUrl(raw, label = 'DATABASE_URL') {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new OpsError(`${label} no está definida o está vacía.`, EXIT.CONFIG);
  }

  const value = raw.trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OpsError(`${label} no es una URL válida.`, EXIT.CONFIG);
  }

  if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
    throw new OpsError(`${label} debe usar el esquema postgres:// o postgresql://.`, EXIT.CONFIG);
  }
  if (!url.hostname) {
    throw new OpsError(`${label} debe incluir un host TCP. No se admiten sockets locales.`, EXIT.CONFIG);
  }

  let database;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    throw new OpsError(`${label} contiene un nombre de base con escapes no válidos.`, EXIT.CONFIG);
  }
  if (!database || database.includes('/')) {
    throw new OpsError(`${label} debe incluir el nombre de una base de datos.`, EXIT.CONFIG);
  }

  const port = url.port === '' ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new OpsError(`${label} contiene un puerto no válido.`, EXIT.CONFIG);
  }

  const params = {};
  for (const [key, paramValue] of url.searchParams.entries()) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
      throw new OpsError(
        `${label} no debe incluir contraseñas en la cadena de consulta; use la parte de usuario de la URL o PGPASSFILE.`,
        EXIT.CONFIG,
      );
    }
    params[key] = paramValue;
  }

  const host = stripIpv6Brackets(url.hostname);
  const username = decodeUrlPart(url.username, label);
  const password = decodeUrlPart(url.password, label);
  if ((username === undefined || username === '') && password !== undefined) {
    throw new OpsError(`${label} incluye contraseña sin usuario.`, EXIT.CONFIG);
  }

  const connection = {
    label,
    host,
    port,
    database,
    username,
    params,
    display: `${database}@${host.includes(':') ? `[${host}]` : host}:${port}`,
  };

  // No enumerables: evitan que un JSON.stringify accidental publique secretos.
  Object.defineProperty(connection, 'password', { value: password, enumerable: false });
  Object.defineProperty(connection, 'raw', { value, enumerable: false });
  Object.defineProperty(connection, 'identity', {
    value: `${host.toLowerCase()}:${port}/${database}`,
    enumerable: false,
  });

  return connection;
}

export function sameDatabase(left, right) {
  return Boolean(left && right && left.identity === right.identity);
}

/**
 * Segunda barrera antes de tocar una base. El nombre debe empezar por
 * relevo_restore o relevo_test y no puede ser la misma base de origen.
 *
 * @param {{target: object, origin?: object|null}} input
 */
export function assertRestoreTarget({ target, origin = null }) {
  if (!target) {
    throw new OpsError('Falta el destino de restauración.', EXIT.RESTORE_GUARD);
  }

  const bytes = Buffer.byteLength(target.database, 'utf8');
  if (bytes > MAX_IDENTIFIER_BYTES) {
    throw new OpsError(
      `El nombre de destino supera ${MAX_IDENTIFIER_BYTES} bytes; PostgreSQL podría truncarlo y romper la garantía de aislamiento.`,
      EXIT.RESTORE_GUARD,
    );
  }

  if (!RESTORE_DATABASE_PATTERN.test(target.database)) {
    throw new OpsError(
      'Destino rechazado: solo se restaura en bases cuyo nombre empiece por "relevo_restore" o "relevo_test" (sufijo opcional _[a-z0-9]+).',
      EXIT.RESTORE_GUARD,
    );
  }

  if (origin && sameDatabase(target, origin)) {
    throw new OpsError(
      `Destino rechazado: ${target.display} es la misma base de origen.`,
      EXIT.RESTORE_GUARD,
    );
  }

  return target;
}

/** URL equivalente sin usuario, contraseña ni parámetros. */
export function redactDatabaseUrl(connection) {
  return `postgresql://<redacted>@${formatHostForUrl(connection.host)}:${connection.port}/${encodeURIComponent(connection.database)}`;
}

/**
 * Elimina URLs, contraseñas conocidas y pares PGPASSWORD/password de textos
 * antes de imprimirlos o guardarlos en mensajes de error.
 *
 * @param {unknown} input
 * @param {Array<string|undefined|null>} [secrets]
 */
export function redactText(input, secrets = []) {
  let text = String(input ?? '');

  const known = [...new Set(secrets.filter((secret) => typeof secret === 'string' && secret.length > 0))]
    .sort((a, b) => b.length - a.length);
  for (const secret of known) {
    text = text.split(secret).join('***');
    let encoded;
    try {
      encoded = encodeURIComponent(secret);
    } catch {
      encoded = secret;
    }
    if (encoded !== secret) text = text.split(encoded).join('***');
  }

  text = text.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, 'postgresql://<redacted>');
  text = text.replace(/\b(PGPASSWORD|password|passwd|pwd)\s*=\s*[^\s;]+/gi, '$1=***');
  return text;
}

/**
 * Entorno para pg_dump/pg_restore/psql. Se eliminan las variables PG* que
 * pudieran apuntar a otra base y se derivan exclusivamente de la URL indicada.
 * PGPASSFILE se conserva para quienes no ponen contraseña en la URL.
 */
export function buildPgEnvironment(connection, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of SCRUBBED_PG_ENV) delete env[key];

  env.PGHOST = connection.host;
  env.PGPORT = String(connection.port);
  env.PGDATABASE = connection.database;
  if (connection.username !== undefined) env.PGUSER = connection.username;
  if (connection.password !== undefined) env.PGPASSWORD = connection.password;

  for (const [key, envName] of Object.entries(PG_ENV_MAP)) {
    if (connection.params[key] !== undefined) env[envName] = connection.params[key];
  }

  return env;
}

/** Representación segura para logs: nunca usuario, contraseña ni parámetros. */
export function safeConnectionInfo(connection) {
  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
  };
}
