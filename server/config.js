const DEFAULT_CORS = 'http://localhost:5173,http://127.0.0.1:5173';

function integer(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Variable ${name} inválida: se esperaba un entero entre ${min} y ${max}`);
  }
  return value;
}

function bool(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`Variable ${name} inválida: use true/false`);
}

function list(env, name, fallback = '') {
  const raw = env[name] ?? fallback;
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const envName = env.NODE_ENV || 'development';
  const trustProxyEnabled = bool(env, 'TRUST_PROXY', false);
  const cfg = {
    env: envName,
    port: integer(env, 'PORT', 3000, { min: 0, max: 65535 }),
    host: env.HOST || '127.0.0.1',
    databaseUrl: env.DATABASE_URL || '',
    databasePoolMax: integer(env, 'DATABASE_POOL_MAX', 10, { min: 1, max: 100 }),
    // A single trusted reverse proxy is the Render deployment shape. Avoid
    // `true`, which would trust forwarded headers from every hop/client.
    trustProxy: trustProxyEnabled ? 1 : false,
    cookieName: env.COOKIE_NAME || 'relevo_session',
    cookieSecure: bool(env, 'COOKIE_SECURE', envName === 'production'),
    sessionTtlMinutes: integer(env, 'SESSION_TTL_MINUTES', 480, { min: 5, max: 60 * 24 * 30 }),
    corsOrigins: list(env, 'CORS_ORIGINS', DEFAULT_CORS),
    loginRateLimit: integer(env, 'LOGIN_RATE_LIMIT', 20, { min: 1, max: 1000 }),
    loginRateWindowMinutes: integer(env, 'LOGIN_RATE_WINDOW_MINUTES', 15, { min: 1, max: 1440 }),
    trackRateLimit: integer(env, 'TRACK_RATE_LIMIT', 20, { min: 1, max: 1000 }),
    trackRateWindowMinutes: integer(env, 'TRACK_RATE_WINDOW_MINUTES', 15, { min: 1, max: 1440 }),
    notificationsMode: (env.NOTIFICATIONS_MODE || 'local').toLowerCase(),
    notificationsAutoProcess: bool(env, 'NOTIFICATIONS_AUTO_PROCESS', true),
    notificationsIntervalMs: integer(env, 'NOTIFICATIONS_INTERVAL_MS', 15000, { min: 1000, max: 3600000 }),
    notificationsFrom: env.NOTIFICATIONS_FROM || 'no-reply@relevo.local',
    notificationsLocalFile: env.NOTIFICATIONS_LOCAL_FILE || '',
    smtp: {
      host: env.SMTP_HOST || '',
      port: integer(env, 'SMTP_PORT', 587, { min: 1, max: 65535 }),
      secure: bool(env, 'SMTP_SECURE', false),
      user: env.SMTP_USER || '',
      password: env.SMTP_PASSWORD || '',
      from: env.SMTP_FROM || env.NOTIFICATIONS_FROM || 'no-reply@relevo.local',
    },
    seedDemoPassword: env.SEED_DEMO_PASSWORD || 'RelevoDemo2026!',
    allowSeed: bool(env, 'ALLOW_SEED', false),
  };

  if (cfg.env === 'production' && !cfg.cookieSecure) {
    throw new Error('COOKIE_SECURE debe ser true en producción');
  }

  if (!['local', 'smtp'].includes(cfg.notificationsMode)) {
    throw new Error('NOTIFICATIONS_MODE debe ser "local" o "smtp"');
  }
  if (cfg.notificationsMode === 'smtp' && !cfg.smtp.host) {
    throw new Error('NOTIFICATIONS_MODE=smtp requiere SMTP_HOST');
  }

  return Object.freeze(cfg);
}

export const config = loadConfig();

export function requireDatabaseUrl() {
  if (!config.databaseUrl) {
    throw new Error(
      'DATABASE_URL no está definida. Configure una base PostgreSQL dedicada del proyecto; ' +
        'este backend no lee archivos .env externos. Use .env.example como referencia.',
    );
  }
  return config.databaseUrl;
}
