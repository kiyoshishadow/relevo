import crypto from 'node:crypto';

export function generateTrackingToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export function safeEqualText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function generateSessionId() {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function fingerprintPayment({ amountCents, method, reference }) {
  return crypto
    .createHash('sha256')
    .update(`${amountCents}|${method}|${reference || ''}`, 'utf8')
    .digest('hex');
}

export function newRequestId() {
  return crypto.randomUUID();
}
