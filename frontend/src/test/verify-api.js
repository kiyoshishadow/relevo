// Servidor de VERIFICACIÓN del dashboard (no es el backend real).
// Replica la forma exacta documentada de GET /api/* según
// backend/server/services/dashboard.js, para probar el consumidor
// del frontend de FRONT-01 en navegador. Puerto efímero o 3199.
import http from 'node:http'

const health = { data: { status: 'ok', database: 'verificación' } }
const dashboard = {
  data: {
    counts: {
      received: 4, diagnosing: 2, awaiting_approval: 3, awaiting_payment: 1,
      repairing: 2, ready: 5, delivered: 41, cancelled: 3, total_cases: 61,
    },
    totals: { clients: 12, terminals: 27, cases: 61 },
    recent_cases: [
      { id: 'c1', case_number: 'CAS-2026-0061', status: 'received', created_at: '2026-10-27T21:45:11.000Z', client_name: 'Ana Salgado', terminal: { brand: 'Xiaomi', model: 'Redmi Note 13' } },
      { id: 'c2', case_number: 'CAS-2026-0060', status: 'repairing', created_at: '2026-10-27T18:02:00.000Z', client_name: 'Luis Membreño', terminal: { brand: 'Samsung', model: 'A54' } },
    ],
    income_cents: 7999, // 79.99 USD — discriminante anti-bug ×100
    income: '79.99',
    loans_out: 2,
  },
}
const me = { data: { user: { id: 'u1', email: 'equipo02@local.invalid', role: 'admin', full_name: 'Equipo 02' } } }

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Set-Cookie': 'relevo.sid=verify; HttpOnly; Path=/' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (url === '/api/health') return json(res, 200, health)
  if (url === '/api/auth/me') return json(res, 200, me)
  if (url === '/api/auth/csrf') return json(res, 200, { data: { csrfToken: 'verify-token' } })
  if (url === '/api/dashboard') return json(res, 200, dashboard)
  json(res, 404, { error: { code: 'no_route', message: 'ruta de verificación no implementada' } })
})

const port = Number(process.env.PORT) || 3199
server.listen(port, '127.0.0.1', () => console.log(`verify-api listening ${port}`))
