import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { EXIT, OpsError } from './errors.mjs';
import {
  BACKUP_KINDS,
  manifestNameForDump,
  parseBackupFileName,
} from './paths.mjs';

export const DEFAULT_RETENTION = Object.freeze({ daily: 7, weekly: 4 });

function assertLimits(limits) {
  for (const kind of BACKUP_KINDS) {
    if (!Number.isInteger(limits[kind]) || limits[kind] < 0) {
      throw new OpsError(`Límite de retención no válido para ${kind}.`, EXIT.RETENTION);
    }
  }
}

async function isRegular(filePath) {
  try {
    return (await lstat(filePath)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Descubre únicamente pares gestionados .dump + .manifest.json. Los archivos
 * desconocidos, parciales o huérfanos se informan y nunca se borran solos.
 */
export async function listManagedBackups(root) {
  const entries = [];
  const warnings = [];

  for (const kind of BACKUP_KINDS) {
    const directory = path.join(root, kind);
    let dirents;
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new OpsError(`No se pudo leer ${directory}: ${error.message}`, EXIT.RETENTION);
    }

    const dumpNames = new Set();
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith('.dump')) continue;
      const parsed = parseBackupFileName(dirent.name);
      if (!parsed) {
        warnings.push(`Archivo .dump no gestionado (se conserva): ${kind}/${dirent.name}`);
        continue;
      }
      dumpNames.add(dirent.name);

      const dumpPath = path.join(directory, dirent.name);
      const manifestName = manifestNameForDump(dirent.name);
      const manifestPath = path.join(directory, manifestName);
      if (!await isRegular(manifestPath)) {
        warnings.push(`Respaldo sin manifiesto (se conserva): ${kind}/${dirent.name}`);
        continue;
      }

      entries.push({
        kind,
        name: dirent.name,
        dumpPath,
        manifestPath,
        timestampMs: parsed.timestampMs,
        createdAt: parsed.iso,
      });
    }

    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith('.manifest.json')) continue;
      const dumpName = `${dirent.name.slice(0, -'.manifest.json'.length)}.dump`;
      if (!dumpNames.has(dumpName)) {
        warnings.push(`Manifiesto sin respaldo (se conserva): ${kind}/${dirent.name}`);
      }
    }
  }

  return { entries, warnings };
}

function compareNewestFirst(left, right) {
  return right.timestampMs - left.timestampMs || right.name.localeCompare(left.name);
}

/**
 * Decide qué conservar: las N copias diarias más recientes y las N semanales
 * más recientes, por separado. Función pura para poder probar la política.
 */
export function planRetention(entries, limits = DEFAULT_RETENTION) {
  assertLimits(limits);
  const keep = [];
  const remove = [];

  for (const kind of BACKUP_KINDS) {
    const sorted = entries
      .filter((entry) => entry.kind === kind)
      .slice()
      .sort(compareNewestFirst);
    sorted.forEach((entry, index) => {
      if (index < limits[kind]) keep.push(entry);
      else remove.push(entry);
    });
  }

  return { keep, remove };
}

/**
 * Aplica la retención. Solo elimina pares previamente identificados; si un
 * archivo no encaja en el formato, se deja intacto.
 */
export async function pruneBackups(root, limits = DEFAULT_RETENTION, options = {}) {
  assertLimits(limits);
  const dryRun = options.dryRun === true;
  const protectedPaths = new Set((options.protect ?? []).map((entry) => path.resolve(entry)));
  const { entries, warnings } = await listManagedBackups(root);
  const plan = planRetention(entries, limits);
  const keep = [...plan.keep];
  const remove = [];
  const removed = [];

  for (const entry of plan.remove) {
    if (protectedPaths.has(path.resolve(entry.dumpPath))) {
      keep.push(entry);
      warnings.push(`Respaldo protegido por ser el más reciente de esta ejecución: ${entry.kind}/${entry.name}`);
    } else {
      remove.push(entry);
    }
  }

  if (!dryRun) {
    for (const entry of remove) {
      // El manifiesto primero: si hay interrupción, queda un .dump huérfano
      // (pequeño y visible) en lugar de un par aparentemente válido.
      await unlink(entry.manifestPath);
      await unlink(entry.dumpPath).catch((error) => {
        if (error?.code === 'ENOENT') return;
        throw new OpsError(
          `No se pudo eliminar ${entry.dumpPath}; el manifiesto ya fue retirado: ${error.message}`,
          EXIT.RETENTION,
        );
      });
      removed.push(entry);
    }
  }

  return {
    keep,
    remove,
    removed: dryRun ? remove : removed,
    dryRun,
    warnings,
  };
}
