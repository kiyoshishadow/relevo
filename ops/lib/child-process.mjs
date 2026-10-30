import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { EXIT, OpsError } from './errors.mjs';
import { redactText } from './database-url.mjs';

const ALLOWED_BINARIES = new Set(['pg_dump', 'pg_restore', 'psql', 'createdb']);
const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024;

function executableName(name, platform) {
  return platform === 'win32' ? `${name}.exe` : name;
}

function windowsPostgresBinDirs(env) {
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
  const root = path.join(programFiles, 'PostgreSQL');
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .sort((a, b) => b - a)
      .map((version) => path.join(root, String(version), 'bin'));
  } catch {
    return [];
  }
}

/**
 * Resuelve un binario de PostgreSQL. Prioridad: PG_BIN explícito, PATH y, en
 * Windows, las instalaciones bajo Program Files (la más reciente primero).
 */
export function resolvePgBinary(name, options = {}) {
  if (!ALLOWED_BINARIES.has(name)) {
    throw new OpsError(`Binario no permitido: ${name}`, EXIT.CONFIG);
  }

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exe = executableName(name, platform);
  const explicit = options.pgBin ?? env.PG_BIN;

  if (explicit !== undefined && String(explicit).trim() !== '') {
    const candidate = path.resolve(String(explicit).trim(), exe);
    if (isFile(candidate)) return candidate;
    throw new OpsError(
      `No se encontró ${exe} en PG_BIN (${path.resolve(String(explicit).trim())}).`,
      EXIT.CONFIG,
    );
  }

  const pathValue = env.PATH ?? env.Path ?? '';
  const pathDirs = pathValue.split(path.delimiter).filter(Boolean);
  const candidates = pathDirs.map((dir) => path.join(dir, exe));
  if (platform === 'win32') {
    for (const dir of windowsPostgresBinDirs(env)) candidates.push(path.join(dir, exe));
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (isFile(normalized)) return normalized;
  }

  throw new OpsError(
    `No se encontró ${exe}. Configure PG_BIN con la carpeta bin de PostgreSQL o agréguela al PATH.`,
    EXIT.CONFIG,
  );
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function appendLimited(current, chunk, maxBytes) {
  if (current.length >= maxBytes) return current;
  const next = current + chunk.toString('utf8');
  return Buffer.byteLength(next, 'utf8') > maxBytes
    ? next.slice(0, Math.max(0, maxBytes - 1))
    : next;
}

/**
 * Ejecuta un proceso con argv (nunca shell) y captura salida acotada.
 * No lanza por código distinto de cero: el llamador decide el significado.
 *
 * @returns {Promise<{code:number|null,signal:string|null,stdout:string,stderr:string,timedOut:boolean}>}
 */
export function runProcess(binary, args, options = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    return Promise.reject(new OpsError('Argumentos de proceso no válidos.', EXIT.CONFIG));
  }

  const label = options.label ?? path.basename(binary);
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new OpsError(`No se pudo iniciar ${label}: ${error.message}`, EXIT.CONFIG, { cause: error }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };

    timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 5000).unref();
      }, timeoutMs)
      : null;
    timer?.unref?.();

    child.stdout?.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk, maxBytes);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk, maxBytes);
    });

    child.once('error', (error) => {
      finish(reject, new OpsError(
        `No se pudo ejecutar ${label}: ${redactText(error.message)}`,
        EXIT.CONFIG,
        { cause: error },
      ));
    });

    child.once('close', (code, signal) => {
      finish(resolve, { code, signal, stdout, stderr, timedOut });
    });
  });
}

export function tailForError(text, maxChars = 2000) {
  const clean = String(text ?? '').trim();
  if (clean.length <= maxChars) return clean;
  return `…${clean.slice(-maxChars)}`;
}

export async function readToolVersion(binary, env = process.env) {
  try {
    const result = await runProcess(binary, ['--version'], {
      env,
      label: path.basename(binary),
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
    });
    if (result.code !== 0) return null;
    const line = result.stdout.split(/\r?\n/).find((entry) => entry.trim() !== '');
    return line?.trim() ?? null;
  } catch {
    return null;
  }
}
