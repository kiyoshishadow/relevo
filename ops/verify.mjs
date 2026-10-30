#!/usr/bin/env node
import path from 'node:path';
import { formatHelp, parseCommandLine, rejectConnectionStringsInArgs, runMain } from './lib/cli.mjs';
import { resolvePgBinary } from './lib/child-process.mjs';
import { EXIT, OpsError } from './lib/errors.mjs';
import { formatBytes, pathExists } from './lib/paths.mjs';
import { autoManifestPath, verifyArchive } from './lib/verify.mjs';

const HELP = formatHelp('Uso: node ops/verify.mjs --dump <archivo.dump> [--manifest <archivo.json>]', [
  'Verifica tamaño, SHA-256 y legibilidad del respaldo con pg_restore --list.',
  'Si no se indica --manifest, busca el .manifest.json junto al .dump.',
  '',
  'Variables de entorno:',
  '  PG_BIN   Carpeta bin de PostgreSQL (opcional; por defecto PATH/Program Files).',
  '',
  'Opciones:',
  '  --dump <ruta>       Respaldo .dump (obligatorio).',
  '  --manifest <ruta>   Manifiesto JSON explícito.',
  '  --help              Muestra esta ayuda.',
]);

const SPEC = {
  dump: { type: 'string' },
  manifest: { type: 'string' },
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

  const dumpPath = path.resolve(values.dump);
  let manifestPath = autoManifestPath(dumpPath, values.manifest ? path.resolve(values.manifest) : undefined);
  if (!values.manifest && manifestPath && !await pathExists(manifestPath)) {
    manifestPath = null;
  }
  const pgRestore = resolvePgBinary('pg_restore', { pgBin: process.env.PG_BIN, env: process.env });
  const result = await verifyArchive({
    dumpPath,
    manifestPath,
    pgRestorePath: pgRestore,
    requireManifest: false,
  });

  console.log('Verificación OK.');
  console.log(`Archivo: ${result.dumpPath}`);
  console.log(`Tamaño: ${formatBytes(result.bytes)}`);
  console.log(`SHA-256: ${result.sha256}`);
  console.log(`Manifiesto: ${result.manifestPath ?? 'no encontrado (solo se verificó el archivo)'}`);
  console.log(`Entradas TOC: ${result.tocEntries}`);
  return EXIT.OK;
}

await runMain(main);
