import { EXIT, isOpsError, OpsError } from './errors.mjs';
import { redactText } from './database-url.mjs';

const OPTION_NAME = /^[a-z][a-z0-9-]*$/;
const CONNECTION_STRING = /postgres(?:ql)?:\/\//i;

/**
 * Parser mínimo y estricto (sin dependencias). Nunca repite valores en los
 * errores para no filtrar contraseñas que lleguen por accidente.
 *
 * spec: { nombre: { type: 'boolean' | 'string' | 'multiple', description } }
 */
export function parseCommandLine(argv, spec, options = {}) {
  const allowPositionals = options.allowPositionals === true;
  const values = {};
  const positionals = [];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg === '') {
      throw new OpsError('Argumento vacío no permitido.', EXIT.USAGE);
    }
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new OpsError('Opción corta no reconocida; use --ayuda.', EXIT.USAGE);
    }

    const equals = arg.indexOf('=');
    const rawName = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (!OPTION_NAME.test(rawName)) {
      throw new OpsError('Opción no reconocida.', EXIT.USAGE);
    }

    const definition = spec[rawName];
    if (!definition) {
      throw new OpsError(`Opción no reconocida: --${rawName}.`, EXIT.USAGE);
    }

    if (definition.type === 'boolean') {
      if (equals !== -1) {
        throw new OpsError(`La opción --${rawName} no admite valor.`, EXIT.USAGE);
      }
      values[rawName] = true;
      continue;
    }

    let value;
    if (equals !== -1) {
      value = arg.slice(equals + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new OpsError(`Falta el valor de --${rawName}.`, EXIT.USAGE);
      }
      value = next;
      index += 1;
    }
    if (value === '' || value.includes('\0')) {
      throw new OpsError(`El valor de --${rawName} no es válido.`, EXIT.USAGE);
    }

    if (definition.type === 'multiple') {
      if (!Array.isArray(values[rawName])) values[rawName] = [];
      values[rawName].push(value);
    } else {
      if (values[rawName] !== undefined) {
        throw new OpsError(`La opción --${rawName} se indicó más de una vez.`, EXIT.USAGE);
      }
      values[rawName] = value;
    }
  }

  if (positionals.length > 0 && !allowPositionals) {
    throw new OpsError('No se admiten argumentos posicionales; use las opciones documentadas.', EXIT.USAGE);
  }

  return { values, positionals, help };
}

/** Evita que una URL con credenciales acabe en la lista de procesos o en un log. */
export function rejectConnectionStringsInArgs(argv) {
  if (argv.some((arg) => CONNECTION_STRING.test(arg))) {
    throw new OpsError(
      'No pase cadenas de conexión por argumentos. Use DATABASE_URL o RESTORE_DATABASE_URL en el entorno.',
      EXIT.USAGE,
    );
  }
}

export function formatHelp(title, lines) {
  return [title, '', ...lines, '', 'Códigos: 0 OK, 1 error inesperado, 2 uso, 3 configuración, 4 dump, 5 verificación,', '6 guarda de restauración, 7 restauración, 8 retención, 9 conexión.'].join('\n');
}

/**
 * Ejecuta un CLI y traduce OpsError a un código de salida. Los mensajes se
 * redactan de nuevo como última barrera.
 */
export async function runMain(main) {
  try {
    const code = await main();
    process.exitCode = Number.isInteger(code) ? code : EXIT.OK;
  } catch (error) {
    const code = isOpsError(error) ? error.exitCode : 1;
    console.error(`Error: ${redactText(error?.message ?? String(error))}`);
    if (process.env.OPS_DEBUG === '1' && error?.stack) {
      console.error(redactText(error.stack));
    }
    process.exitCode = code;
  }
}
