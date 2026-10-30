import bcrypt from 'bcryptjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { userCreateSchema } from '../server/validation/schemas.js';

const ADMIN_MEMBERSHIP_LOCK_NAMESPACE = 0x55534552; // Shared with server/routes/users.js.
const ADMIN_MEMBERSHIP_LOCK_KEY = 1;
const HASH_COST = 12;

export function parseBootstrapAdminEnv(env) {
  const required = [
    'BOOTSTRAP_ADMIN_EMAIL',
    'BOOTSTRAP_ADMIN_FULL_NAME',
    'BOOTSTRAP_ADMIN_PASSWORD',
  ];
  for (const name of required) {
    if (typeof env?.[name] !== 'string' || env[name].length === 0) {
      throw new Error(`${name} es obligatorio; no hay valores por defecto`);
    }
  }

  const result = userCreateSchema.safeParse({
    email: env.BOOTSTRAP_ADMIN_EMAIL,
    full_name: env.BOOTSTRAP_ADMIN_FULL_NAME,
    password: env.BOOTSTRAP_ADMIN_PASSWORD,
    role: 'admin',
  });
  if (!result.success) {
    throw new Error('Los datos BOOTSTRAP_ADMIN_* no cumplen el esquema de usuario');
  }
  return result.data;
}

/** Creates the first administrator using injected DB/hash dependencies for isolated tests. */
export async function bootstrapAdmin({
  env = process.env,
  withTransaction,
  hashPassword = bcrypt.hash,
} = {}) {
  if (typeof withTransaction !== 'function') {
    throw new Error('Se requiere una función transaccional de base de datos');
  }
  const user = parseBootstrapAdminEnv(env);
  const passwordHash = await hashPassword(user.password, HASH_COST);

  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      ADMIN_MEMBERSHIP_LOCK_NAMESPACE,
      ADMIN_MEMBERSHIP_LOCK_KEY,
    ]);
    await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const existing = await client.query('SELECT id FROM users LIMIT 1');
    if (existing.rows.length > 0) {
      throw new Error('Bootstrap bloqueado: la tabla users ya contiene usuarios');
    }
    await client.query(
      `INSERT INTO users (email, full_name, role, password_hash, active)
       VALUES ($1, $2, 'admin', $3, true)`,
      [user.email, user.full_name, passwordHash],
    );
  });
}

async function main() {
  // Fail input validation before initializing the database pool.
  parseBootstrapAdminEnv(process.env);
  const { withTransaction, closePool } = await import('../server/db/pool.js');
  try {
    await bootstrapAdmin({ withTransaction });
    console.log('Primer administrador creado.');
  } finally {
    await closePool();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch(() => {
    console.error('No se pudo crear el primer administrador; revise la configuración sin compartir secretos.');
    process.exitCode = 1;
  });
}
