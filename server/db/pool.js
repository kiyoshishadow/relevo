import pg from 'pg';
import { config, requireDatabaseUrl } from '../config.js';

const { Pool, types } = pg;

// BIGINT (int8) se usa para centavos y conteos. Todos los valores manejados
// quedan por debajo de Number.MAX_SAFE_INTEGER; el dominio valida los límites.
types.setTypeParser(20, (value) => Number(value));
// DATE se mantiene como YYYY-MM-DD; convertirlo a Date introduciría zona horaria.
types.setTypeParser(1082, (value) => value);

export const pool = new Pool({
  connectionString: requireDatabaseUrl(),
  max: config.databasePoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (error) => {
  console.error(JSON.stringify({ event: 'db.pool.error', message: error.message }));
});

export function query(text, params = []) {
  return pool.query(text, params);
}

export async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // El error original es más útil que un fallo de rollback.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
