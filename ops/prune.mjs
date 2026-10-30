#!/usr/bin/env node
import path from 'node:path';
import { formatHelp, parseCommandLine, rejectConnectionStringsInArgs, runMain } from './lib/cli.mjs';
import { EXIT } from './lib/errors.mjs';
import { defaultBackupRoot, validateBackupRoot } from './lib/paths.mjs';
import { DEFAULT_RETENTION, pruneBackups } from './lib/retention.mjs';

const HELP = formatHelp('Uso: node ops/prune.mjs [opciones]', [
  'Aplica retención a pares gestionados: 7 respaldos diarios y 4 semanales.',
  'Nunca borra archivos desconocidos, parciales ni huérfanos.',
  '',
  'Variables de entorno:',
  '  BACKUP_DIR   Carpeta raíz de respaldos (opcional; por defecto ops/backups).',
  '',
  'Opciones:',
  '  --output-dir <ruta>  Reemplaza BACKUP_DIR.',
  '  --dry-run            Muestra qué se eliminaría sin borrar.',
  '  --help               Muestra esta ayuda.',
]);

const SPEC = {
  'output-dir': { type: 'string' },
  'dry-run': { type: 'boolean' },
};

async function main() {
  rejectConnectionStringsInArgs(process.argv.slice(2));
  const { values, help } = parseCommandLine(process.argv.slice(2), SPEC);
  if (help) {
    console.log(HELP);
    return EXIT.OK;
  }

  const root = validateBackupRoot(values['output-dir'] ?? defaultBackupRoot(process.env));
  const result = await pruneBackups(root, DEFAULT_RETENTION, { dryRun: values['dry-run'] === true });

  console.log(`Carpeta: ${path.resolve(root)}`);
  console.log(`Política: ${DEFAULT_RETENTION.daily} diarios / ${DEFAULT_RETENTION.weekly} semanales.`);
  console.log(`Conservados: ${result.keep.length}; ${result.dryRun ? 'se eliminarían' : 'eliminados'}: ${result.removed.length}.`);
  for (const entry of result.removed) {
    console.log(`${result.dryRun ? 'Se eliminaría' : 'Eliminado'}: ${entry.kind}/${entry.name}`);
  }
  for (const warning of result.warnings) {
    console.warn(`Aviso: ${warning}`);
  }

  return EXIT.OK;
}

await runMain(main);
