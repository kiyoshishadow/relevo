import path from 'node:path';
import { stat } from 'node:fs/promises';
import { redactText, safeConnectionInfo } from './database-url.mjs';
import { EXIT, OpsError } from './errors.mjs';
import { isPathInside, readJsonFile, sha256File, toPosixRelative } from './paths.mjs';

export const MANIFEST_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONNECTION_WITH_USERINFO = /postgres(?:ql)?:\/\/[^\s/]*@/i;
const PASSWORD_ASSIGNMENT = /\b(PGPASSWORD|password|passwd|pwd)\s*=/i;

function redactCommandArgs(binary, args, root) {
  return [path.basename(binary), ...args].map((arg) => {
    let text = String(arg);
    if (root && path.isAbsolute(text) && isPathInside(root, text)) {
      text = `<backup-root>/${toPosixRelative(root, text)}`;
    } else if (root) {
      text = text.split(path.resolve(root)).join('<backup-root>');
    }
    return redactText(text);
  });
}

/**
 * Construye el manifiesto que acompaña a cada .dump. No recibe la contraseña
 * ni la URL original: solo el comando redactado y datos no secretos.
 */
export function buildManifest({
  kind,
  createdAt,
  completedAt,
  connection,
  root,
  dumpPath,
  bytes,
  sha256,
  commandBinary,
  commandArgs,
  pgDumpVersion,
  verification,
  source,
}) {
  if (!['daily', 'weekly'].includes(kind)) {
    throw new OpsError(`Tipo de respaldo no válido: ${kind}`, EXIT.BACKUP);
  }

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind,
    createdAt: createdAt.toISOString(),
    completedAt: completedAt.toISOString(),
    connection: safeConnectionInfo(connection),
    dump: {
      file: toPosixRelative(root, dumpPath),
      bytes,
      sha256,
    },
    command: redactCommandArgs(commandBinary, commandArgs, root),
    tool: {
      pgDumpVersion: pgDumpVersion ?? null,
    },
    verification: {
      method: 'pg_restore --list',
      ok: true,
      tocEntries: verification.tocEntries,
      checkedAt: verification.checkedAt.toISOString(),
    },
  };

  if (source !== undefined) manifest.source = source;
  return manifest;
}

function assertIsoUtc(value, label) {
  if (typeof value !== 'string' || !value.endsWith('Z') || Number.isNaN(Date.parse(value))) {
    throw new OpsError(`Manifiesto inválido: ${label} debe ser una fecha ISO en UTC.`, EXIT.VERIFY);
  }
}

function assertSafeRelativeFile(file) {
  if (typeof file !== 'string' || file === '' || file.includes('\0') || file.includes('\\')) {
    throw new OpsError('Manifiesto inválido: dump.file no es una ruta relativa válida.', EXIT.VERIFY);
  }
  const normalized = path.posix.normalize(file);
  if (
    path.posix.isAbsolute(file)
    || normalized !== file
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new OpsError('Manifiesto inválido: dump.file debe permanecer dentro de la carpeta de respaldos.', EXIT.VERIFY);
  }
}

export function validateManifest(manifest, expected = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new OpsError('Manifiesto inválido: se esperaba un objeto JSON.', EXIT.VERIFY);
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new OpsError(`Manifiesto con versión no soportada: ${manifest.schemaVersion}.`, EXIT.VERIFY);
  }
  if (!['daily', 'weekly'].includes(manifest.kind)) {
    throw new OpsError('Manifiesto inválido: kind debe ser daily o weekly.', EXIT.VERIFY);
  }
  assertIsoUtc(manifest.createdAt, 'createdAt');
  assertIsoUtc(manifest.completedAt, 'completedAt');

  const connection = manifest.connection;
  if (
    !connection
    || typeof connection.host !== 'string'
    || !Number.isInteger(connection.port)
    || connection.port < 1
    || connection.port > 65535
    || typeof connection.database !== 'string'
    || connection.database === ''
  ) {
    throw new OpsError('Manifiesto inválido: datos de conexión incompletos.', EXIT.VERIFY);
  }

  const dump = manifest.dump;
  if (!dump || typeof dump !== 'object') {
    throw new OpsError('Manifiesto inválido: falta dump.', EXIT.VERIFY);
  }
  assertSafeRelativeFile(dump.file);
  if (!Number.isInteger(dump.bytes) || dump.bytes < 0) {
    throw new OpsError('Manifiesto inválido: dump.bytes debe ser un entero no negativo.', EXIT.VERIFY);
  }
  if (typeof dump.sha256 !== 'string' || !SHA256_PATTERN.test(dump.sha256)) {
    throw new OpsError('Manifiesto inválido: dump.sha256 no es SHA-256 hexadecimal.', EXIT.VERIFY);
  }

  if (!Array.isArray(manifest.command) || manifest.command.length === 0
    || manifest.command.some((part) => typeof part !== 'string')) {
    throw new OpsError('Manifiesto inválido: command debe ser una lista de cadenas.', EXIT.VERIFY);
  }
  for (const part of manifest.command) {
    if (CONNECTION_WITH_USERINFO.test(part) || PASSWORD_ASSIGNMENT.test(part)) {
      throw new OpsError('Manifiesto rechazado: command contiene credenciales sin redactar.', EXIT.VERIFY);
    }
    if (part.includes('\0')) {
      throw new OpsError('Manifiesto inválido: command contiene bytes nulos.', EXIT.VERIFY);
    }
  }

  if (!manifest.verification || manifest.verification.ok !== true) {
    throw new OpsError('Manifiesto inválido: el respaldo no figura verificado.', EXIT.VERIFY);
  }
  if (manifest.verification.method !== 'pg_restore --list') {
    throw new OpsError('Manifiesto inválido: método de verificación desconocido.', EXIT.VERIFY);
  }
  if (!Number.isInteger(manifest.verification.tocEntries) || manifest.verification.tocEntries < 0) {
    throw new OpsError('Manifiesto inválido: tocEntries no es un entero válido.', EXIT.VERIFY);
  }
  assertIsoUtc(manifest.verification.checkedAt, 'verification.checkedAt');

  if (expected.bytes !== undefined && dump.bytes !== expected.bytes) {
    throw new OpsError(
      `El tamaño del archivo (${expected.bytes} B) no coincide con el manifiesto (${dump.bytes} B).`,
      EXIT.VERIFY,
    );
  }
  if (expected.sha256 !== undefined && dump.sha256 !== expected.sha256) {
    throw new OpsError('El SHA-256 del archivo no coincide con el manifiesto.', EXIT.VERIFY);
  }

  return manifest;
}

export function assertManifestMatchesDump(manifest, dumpPath) {
  const dumpName = path.basename(dumpPath);
  const manifestName = path.posix.basename(manifest.dump.file);
  if (dumpName !== manifestName) {
    throw new OpsError(
      `El manifiesto describe ${manifestName}, pero se intentó usar ${dumpName}.`,
      EXIT.VERIFY,
    );
  }
  const parentKind = path.basename(path.dirname(path.resolve(dumpPath))).toLowerCase();
  if (['daily', 'weekly'].includes(parentKind) && manifest.kind !== parentKind) {
    throw new OpsError(
      `El manifiesto es de tipo ${manifest.kind}, pero el archivo está en ${parentKind}/.`,
      EXIT.VERIFY,
    );
  }
}

export async function readManifest(filePath) {
  return readJsonFile(filePath);
}

/**
 * Verifica hash, tamaño y manifiesto. No ejecuta pg_restore.
 */
export async function verifyManifestAndFile(dumpPath, manifestPath, options = {}) {
  const info = await stat(dumpPath);
  if (!info.isFile()) {
    throw new OpsError(`El respaldo no es un archivo regular: ${dumpPath}`, EXIT.VERIFY);
  }
  if (info.size === 0) {
    throw new OpsError('El respaldo está vacío.', EXIT.VERIFY);
  }

  const sha256 = await sha256File(dumpPath);
  let manifest = null;
  if (manifestPath) {
    manifest = validateManifest(await readManifest(manifestPath), {
      bytes: info.size,
      sha256,
    });
    assertManifestMatchesDump(manifest, dumpPath);
  } else if (options.requireManifest === true) {
    throw new OpsError('Se requiere el manifiesto JSON para verificar el respaldo.', EXIT.VERIFY);
  }

  return {
    bytes: info.size,
    sha256,
    manifest,
    manifestPath: manifestPath ?? null,
  };
}
