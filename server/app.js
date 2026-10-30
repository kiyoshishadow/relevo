import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { attachSession, requireAuth } from './middleware/session.js';
import { csrfProtection } from './middleware/csrf.js';
import { ApiError, asyncHandler, ok } from './lib/http.js';
import { newRequestId } from './domain/tokens.js';

import authRouter from './routes/auth.js';
import healthRouter from './routes/health.js';
import trackRouter from './routes/track.js';
import clientsRouter from './routes/clients.js';
import terminalsRouter from './routes/terminals.js';
import coveragesRouter from './routes/coverages.js';
import casesRouter from './routes/cases.js';
import loanDevicesRouter from './routes/loan-devices.js';
import dashboardRouter from './routes/dashboard.js';
import usersRouter from './routes/users.js';
import techniciansRouter from './routes/technicians.js';
import auditRouter from './routes/audit.js';
import notificationsRouter from './routes/notifications.js';

/**
 * Rutas del proyecto resueltas desde este archivo, no desde `process.cwd()`.
 * Así `npm start`, una tarea programada o una prueba desde otro directorio
 * apuntan siempre al mismo `frontend/dist`.
 */
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SERVER_DIR, '..');

export const DEFAULT_STATIC_DIR = join(PROJECT_ROOT, 'frontend', 'dist');

/** Resuelve `FRONTEND_DIST` (absoluta o relativa a la raíz del proyecto). */
export function resolveStaticDir(value = process.env.FRONTEND_DIST) {
  if (!value) return DEFAULT_STATIC_DIR;
  return isAbsolute(value) ? value : resolve(PROJECT_ROOT, value);
}

/**
 * Fábrica de la aplicación. `reportsRouter` es el router real de REPORT-01
 * inyectado por `server/index.js`; `staticDir` es el build de Vite.
 */
export function createApp({ reportsRouter = null, staticDir = resolveStaticDir() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  const frontendDir = staticDir ? resolve(staticDir) : null;
  const hasFrontend = Boolean(frontendDir) && existsSync(join(frontendDir, 'index.html'));
  app.locals.frontendDir = hasFrontend ? frontendDir : null;
  app.locals.reportsMounted = Boolean(reportsRouter);

  const allowedOrigins = new Set(config.corsOrigins);

  app.use((req, res, next) => {
    req.id = req.get('X-Request-Id') || newRequestId();
    res.set('X-Request-Id', req.id);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    const origin = req.get('Origin');
    if (origin && (allowedOrigins.has('*') || allowedOrigins.has(origin))) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Credentials', 'true');
      res.set('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Request-Id');
      res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.set('Access-Control-Max-Age', '600');
      res.set('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      if (req.path === '/api/health') return;
      console.log(
        JSON.stringify({
          event: 'http.request',
          request_id: req.id,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: Date.now() - started,
        }),
      );
    });
    next();
  });

  app.use('/api', attachSession);
  app.use('/api', csrfProtection);

  // Rutas públicas.
  app.use('/api/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/track', trackRouter);

  // REPORT-01 se monta aquí porque su router ya aplica `requireAuth` y
  // `requireRole('admin','reception')` con los middlewares inyectados. No se
  // simulan reportes ni se duplica la comprobación de sesión.
  if (reportsRouter) {
    app.use('/api/reports', reportsRouter);
  }

  // A partir de aquí todo exige sesión válida.
  app.use('/api', requireAuth);

  app.use('/api/clients', clientsRouter);
  app.use('/api/terminals', terminalsRouter);
  app.use('/api/coverages', coveragesRouter);
  app.use('/api/cases', casesRouter);
  app.use('/api/loan-devices', loanDevicesRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/technicians', techniciansRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/notifications', notificationsRouter);

  app.get(
    '/api',
    asyncHandler(async (_req, res) =>
      ok(res, {
        service: 'relevo-backend',
        version: '0.1.0',
        reports: reportsRouter ? 'mounted' : 'external',
        frontend: hasFrontend ? 'served' : 'not_built',
      }),
    ),
  );

  // Toda /api desconocida termina aquí como JSON; el frontend se sirve después
  // para que una ruta API mal escrita nunca reciba index.html con estado 200.
  app.use('/api', (req, _res, next) => {
    next(new ApiError(404, 'NOT_FOUND', `Ruta no encontrada: ${req.method} ${req.originalUrl}`));
  });

  // Build de Vite (hash router): raíz y archivos con hash. Los assets llevan
  // caché inmutable; el index se revalida en cada carga.
  if (hasFrontend) {
    const assetsDir = join(frontendDir, 'assets') + sep;
    app.use(
      express.static(frontendDir, {
        index: false,
        fallthrough: true,
        etag: true,
        setHeaders(res, filePath) {
          res.setHeader(
            'Cache-Control',
            filePath.startsWith(assetsDir)
              ? 'public, max-age=31536000, immutable'
              : 'no-cache',
          );
        },
      }),
    );

    const sendIndex = (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(frontendDir, 'index.html'), (error) => {
        if (error) next(error);
      });
    };
    app.get('/', sendIndex);
    app.get('/index.html', sendIndex);
  }

  app.use((req, _res, next) => {
    next(new ApiError(404, 'NOT_FOUND', `Ruta no encontrada: ${req.method} ${req.originalUrl}`));
  });

  app.use((error, req, res, _next) => {
    if (res.headersSent) return;

    let status = error.status || 500;
    let code = error.code || 'INTERNAL_ERROR';
    let message = error.message || 'Error interno';
    let details = error.details;

    if (error.type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_JSON';
      message = 'JSON inválido';
    } else if (error.type === 'entity.too.large') {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'El cuerpo de la petición excede el límite';
    } else if (error.code === '23505') {
      status = 409;
      code = 'CONFLICT';
      message = 'El registro entra en conflicto con uno existente';
    } else if (error.code === '23503') {
      status = 409;
      code = 'REFERENCE_CONFLICT';
      message = 'El registro hace referencia a datos inexistentes o en uso';
    } else if (error.code === '23514') {
      status = 400;
      code = 'CONSTRAINT_VIOLATION';
      message = 'Los datos no cumplen una restricción de la base de datos';
    } else if (error.code === '22P02') {
      status = 400;
      code = 'INVALID_INPUT';
      message = 'Formato de dato inválido';
    } else if (['40001', '40P01'].includes(error.code)) {
      status = 409;
      code = 'CONCURRENT_CONFLICT';
      message = 'Conflicto de concurrencia; reintente la operación';
    } else if (!(error instanceof ApiError) && status >= 500) {
      console.error(
        JSON.stringify({
          event: 'http.error',
          request_id: req.id,
          method: req.method,
          path: req.path,
          code: error.code || 'INTERNAL_ERROR',
          message: error.message,
          stack: error.stack,
        }),
      );
      message = 'Error interno del servidor';
      code = 'INTERNAL_ERROR';
      details = undefined;
    }

    const body = { error: { code, message } };
    if (details !== undefined) body.error.details = details;
    res.status(status).json(body);
  });

  return app;
}

export const app = createApp();
export default app;
