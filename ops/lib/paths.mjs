import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { EXIT, OpsError } from './errors.mjs';

export const OPS_DIR = path.resolve(import.meta.dirname, '..');
export const BACKUP_KINDS = Object.freeze(['daily', 'weekly']);
export const BACKUP_FILE_PATTERN = /^relevo_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z\.dump$/;

export function formatBackupTimestamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new OpsError('Fecha no válida para el nombre de respaldo.', EXIT.USAGE);
  }
  return date.toISOString().replace(/[-:.]/g, '');
}

export function buildBackupFileName(date) {
  return `relevo_${formatBackupTimestamp(date)}.dump`;
}

/** Devuelve la fecha UTC del nombre o null si no sigue el formato gestionado. */
export function parseBackupFileName(name) {
  const match = BACKUP_FILE_PATTERN.exec(String(name));
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const timestampMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond),
  );
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return null;
  if (formatBackupTimestamp(date) !== `${year}${month}${day}T${hour}${minute}${second}${millisecond}Z`) {
    return null;
  }
  return { name: String(name), timestampMs, iso: date.toISOString() };
}

export function manifestNameForDump(dumpName) {
  const name = String(dumpName);
  if (!name.endsWith('.dump')) {
    throw new OpsError('El respaldo debe tener extensión .dump.', EXIT.USAGE);
  }
  return `${name.slice(0, -'.dump'.length)}.manifest.json`;
}

export function defaultBackupRoot(env = process.env) {
  const configured = env.BACKUP_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(OPS_DIR, 'backups');
}

export function validateBackupRoot(root) {
  const resolved = path.resolve(String(root));
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    throw new OpsError('BACKUP_DIR no puede ser la raíz de una unidad.', EXIT.USAGE);
  }
  return resolved;
}

export async function ensureBackupLayout(root) {
  await mkdir(path.join(root, 'daily'), { recursive: true });
  await mkdir(path.join(root, 'weekly'), { recursive: true });
}

export function toPosixPath(value) {
  return String(value).split(path.sep).join('/');
}

export function toPosixRelative(root, target) {
  return toPosixPath(path.relative(root, target));
}

export function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function assertRegularFile(candidate, label = 'archivo', exitCode = EXIT.USAGE) {
  let info;
  try {
    info = await stat(candidate);
  } catch {
    throw new OpsError(`No existe el ${label}: ${candidate}`, exitCode);
  }
  if (!info.isFile()) {
    throw new OpsError(`El ${label} no es un archivo regular: ${candidate}`, exitCode);
  }
  return info;
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

export async function readJsonFile(filePath, maxBytes = 1024 * 1024) {
  const info = await assertRegularFile(filePath, 'manifiesto', EXIT.VERIFY);
  if (info.size > maxBytes) {
    throw new OpsError('El manifiesto excede el tamaño máximo admitido.', EXIT.VERIFY);
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new OpsError(`El manifiesto no es JSON válido: ${filePath}`, EXIT.VERIFY);
  }
  return parsed;
}

function tempSibling(filePath) {
  return `${filePath}.partial-${process.pid}-${randomUUID()}`;
}

export async function writeJsonAtomic(filePath, value) {
  const temp = tempSibling(filePath);
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, filePath);
  } catch (error) {
    await removeIfExists(temp);
    throw error;
  }
}

export async function copyFileAtomic(source, destination) {
  const temp = tempSibling(destination);
  try {
    await copyFile(source, temp);
    await rename(temp, destination);
  } catch (error) {
    await removeIfExists(temp);
    throw error;
  }
}

export async function removeIfExists(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'desconocido';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
