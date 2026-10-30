// Etiquetas, estados y dinero del contrato

export const CASE_STATES = [
  'received', 'diagnosing', 'awaiting_approval', 'awaiting_payment',
  'repairing', 'ready', 'delivered', 'cancelled',
]

export const STATE_LABEL = {
  received: 'Recibido',
  diagnosing: 'En diagnóstico',
  awaiting_approval: 'Esperando aprobación',
  awaiting_payment: 'Esperando pago',
  repairing: 'En reparación',
  ready: 'Listo para entrega',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
}

export const ROLE_LABEL = { admin: 'Administración', reception: 'Recepción', technician: 'Técnico' }

export function stateLabel(s) { return STATE_LABEL[s] || s || '—' }

export function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('es-SV', { dateStyle: 'medium', timeStyle: 'short', timeZone: MONEY_TZ })
}

export function fmtDay(iso) {
  if (!iso) return '—'
  // Date-only (YYYY-MM-DD): calendario estricto sin desviación de zona.
  if (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d))
    if (Number.isNaN(dt.getTime()) || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      return '—'
    }
    return dt.toLocaleDateString('es-SV', { dateStyle: 'long', timeZone: 'UTC' })
  }
  // Timestamps completos: presentados en la hora oficial de El Salvador.
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('es-SV', { dateStyle: 'long', timeZone: MONEY_TZ })
}

// Importes: el contrato API define quote.total, payment.amount y
// unit_price en UNIDADES (cadena decimal). Para centavos usar
// fmtMoneyCents; no dividir globalmente aquí.
export function fmtMoney(v) {
  if (v === null || v === undefined || v === '' || v === 'NaN') return '—'
  if (typeof v === 'boolean') return '—'
  if (typeof v === 'string' && v.trim() === '') return '—'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('es', { style: 'currency', currency: 'USD' })
}

// Centavos enteros (dashboard.income_cents): conversión explícita /100.
// Dato inválido o ausente ⇒ '—', jamás 0 silencioso.
export function fmtMoneyCents(cents) {
  if (cents === null || cents === undefined || cents === '') return '—'
  if (typeof cents === 'boolean') return '—'
  if (typeof cents === 'string' && cents.trim() === '') return '—'
  const n = typeof cents === 'number' ? cents : Number(cents)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return '—'
  return fmtMoney(n / 100)
}

export const MONEY_TZ = 'America/El_Salvador'

export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export function pill(state) {
  return `<span class="pill pill-${esc(state) || 'neutral'}">${esc(stateLabel(state))}</span>`
}
