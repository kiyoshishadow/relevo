// Sesión y CSRF con refresco honesto. Si el servidor rechaza el token de
// escritura, se pide uno nuevo y se reintenta una única vez.
const BASE = '/api'

let csrfToken = null

export function clearCsrf() { csrfToken = null }

export async function getCsrf() {
  if (csrfToken) return csrfToken
  const { data } = await get('/auth/csrf')
  csrfToken = data?.csrfToken ?? data
  if (!csrfToken) throw { code: 'csrf_unavailable', message: 'El servidor no entregó un token de formulario.' }
  return csrfToken
}

async function request(method, path, body, opts = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = await getCsrf()
  const res = await fetch(BASE + path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: opts.signal,
  })
  let payload = null
  try { payload = await res.json() } catch { /* respuesta vacía o no JSON */ }
  if (!res.ok) {
    // Sesión inválida o token CSRF vencido: descartar la caché para que la
    // siguiente mutación pida un token nuevo del servidor.
    if (res.status === 401 || res.status === 403) csrfToken = null
    const err = (payload && payload.error) || { code: 'request_failed', message: `La solicitud falló (HTTP ${res.status}).` }
    err.status = res.status
    throw err
  }
  if (payload && payload.data && typeof payload.data.csrfToken === 'string') csrfToken = payload.data.csrfToken
  return payload
}

const RETRY_ERR = { message: 'Inténtalo de nuevo.' } // nunca simulado: solo reintento de CSRF
async function withCsrfRetry(fn) {
  try { return await fn() }
  catch (e) {
    if ((e?.status === 403) && /^csrf/i.test(e?.code || '')) { csrfToken = null; return fn() }
    throw e
  }
}

export function get(path, opts) { return request('GET', path, undefined, opts) }
export function post(path, body, opts) { return withCsrfRetry(() => request('POST', path, body, opts)) }
export function patch(path, body, opts) { return withCsrfRetry(() => request('PATCH', path, body, opts)) }
