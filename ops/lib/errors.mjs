/**
 * Códigos de salida estables para todos los comandos de ops/.
 * Documentados en ops/README.md; las pruebas los verifican.
 */
export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  CONFIG: 3,
  BACKUP: 4,
  VERIFY: 5,
  RESTORE_GUARD: 6,
  RESTORE: 7,
  RETENTION: 8,
  CONNECTION: 9,
});

export class OpsError extends Error {
  /**
   * @param {string} message Mensaje ya apto para mostrar (sin secretos).
   * @param {number} exitCode Código de salida de EXIT.
   * @param {{cause?: unknown, details?: unknown}} [options]
   */
  constructor(message, exitCode = 1, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OpsError';
    this.exitCode = Number.isInteger(exitCode) ? exitCode : 1;
    this.details = options.details;
  }
}

export function isOpsError(error) {
  return error instanceof OpsError;
}
