import { ApiError, clientIp } from '../lib/http.js';

/**
 * Limitador en memoria suficiente para una instancia única. Se reinicia al
 * reiniciar el proceso y no se comparte entre procesos; queda documentado.
 */
export function createRateLimiter({
  windowMs,
  max,
  keyGenerator = (req) => clientIp(req),
  code = 'RATE_LIMITED',
  message = 'Demasiados intentos. Intente más tarde.',
}) {
  const buckets = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of buckets) {
      const active = timestamps.filter((timestamp) => now - timestamp < windowMs);
      if (active.length === 0) buckets.delete(key);
      else buckets.set(key, active);
    }
  }, Math.max(windowMs, 60000));
  cleanup.unref?.();

  const middleware = (req, res, next) => {
    const now = Date.now();
    const key = keyGenerator(req);
    const active = (buckets.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
    if (active.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - active[0])) / 1000));
      res.set('Retry-After', String(retryAfter));
      buckets.set(key, active);
      return next(
        new ApiError(429, code, message, {
          retry_after_seconds: retryAfter,
          limit: max,
          window_seconds: Math.ceil(windowMs / 1000),
        }),
      );
    }
    active.push(now);
    buckets.set(key, active);
    return next();
  };

  middleware.stop = () => clearInterval(cleanup);
  middleware.reset = () => buckets.clear();
  return middleware;
}
