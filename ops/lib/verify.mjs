import path from 'node:path';
import { runProcess, tailForError } from './child-process.mjs';
import { redactText } from './database-url.mjs';
import { EXIT, OpsError } from './errors.mjs';
import { validateManifest, verifyManifestAndFile } from './manifest.mjs';
import { assertRegularFile } from './paths.mjs';

export function countTocEntries(listOutput) {
  return String(listOutput ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith(';'))
    .length;
}

/**
 * Comprueba archivo, manifiesto y legibilidad con `pg_restore --list`.
 * No se conecta a ninguna base.
 */
export async function verifyArchive({
  dumpPath,
  manifestPath,
  pgRestorePath,
  env = process.env,
  requireManifest = false,
  timeoutMs = 5 * 60 * 1000,
}) {
  await assertRegularFile(dumpPath, 'respaldo', EXIT.VERIFY);
  const fileCheck = await verifyManifestAndFile(dumpPath, manifestPath, { requireManifest });

  const result = await runProcess(pgRestorePath, ['--list', '--no-password', dumpPath], {
    env,
    label: 'pg_restore --list',
    timeoutMs,
    maxOutputBytes: 32 * 1024 * 1024,
  });

  if (result.timedOut) {
    throw new OpsError('pg_restore --list excedió el tiempo máximo de verificación.', EXIT.VERIFY);
  }
  if (result.code !== 0) {
    const detail = tailForError(redactText(result.stderr, [fileCheck.manifest?.connection?.database]));
    throw new OpsError(
      `pg_restore --list rechazó el archivo (código ${result.code}).${detail ? ` ${detail}` : ''}`,
      EXIT.VERIFY,
    );
  }

  const tocEntries = countTocEntries(result.stdout);

  return {
    ...fileCheck,
    dumpPath: path.resolve(dumpPath),
    tocEntries,
    checkedAt: new Date(),
  };
}

export function autoManifestPath(dumpPath, explicitManifest) {
  if (explicitManifest) return explicitManifest;
  const name = path.basename(dumpPath);
  if (!name.endsWith('.dump')) return null;
  return path.join(path.dirname(dumpPath), `${name.slice(0, -'.dump'.length)}.manifest.json`);
}

export function validateManifestObject(manifest, expected = {}) {
  return validateManifest(manifest, expected);
}
