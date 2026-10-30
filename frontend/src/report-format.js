import { fmtDate, fmtDay, fmtMoneyCents } from './util.js'
export function reportCell(value, type) {
  if (value === null || value === undefined || value === '' || (typeof value === 'string' && !value.trim())) return '—'
  if (type === 'cents') return fmtMoneyCents(value)
  if (type === 'date') return fmtDay(value)
  if (type === 'datetime') return fmtDate(value)
  if (type === 'boolean') return value === true ? 'Sí' : value === false ? 'No' : '—'
  if (type === 'integer') return Number.isSafeInteger(Number(value)) && typeof value !== 'boolean' ? Number(value).toLocaleString('es-SV') : '—'
  return String(value)
}
export function reportSummary(key, value) {
  const labels = { dias:'Días',semanas:'Semanas',meses:'Meses',tecnicos:'Técnicos',pendientes:'Pendientes de devolución',casos:'Reparaciones',clientes:'Clientes',entregados:'Entregados',tipos:'Tipos de problema',marcas:'Marcas',terminales:'Terminales',eventos:'Eventos',pagos:'Pagos',prestamos:'Préstamos',devueltos:'Devueltos',activos:'Activos',ingreso_cents:'Ingresos',total_cents:'Total' }
  return { label:labels[key] || key.replace(/_cents$/, ' (USD)').replaceAll('_',' '), value:reportCell(value,key.endsWith('_cents') ? 'cents' : 'integer') }
}
export function reportParams(entry, values) {
  const params = new URLSearchParams()
  for (const key of entry?.filters || []) {
    const value = String(values.get(key) || '').trim()
    if (value) params.set(key,value)
  }
  return params
}

export function reportError(error) {
  if (error?.status === 401) return 'Tu sesión terminó. Vuelve a iniciar sesión para consultar los reportes.'
  if (error?.status === 403) return 'Tu cuenta no tiene acceso a los reportes. Consulta con la administración del taller.'
  if (error?.code === 'REPORT_NOT_FOUND') return 'Este reporte ya no está disponible. Actualiza el catálogo y elige otra consulta.'
  if (['VALIDATION_ERROR','REPORT_TOO_LARGE'].includes(error?.code) && error?.message) return error.message
  if (error?.status === 404 || error?.code === 'NOT_FOUND') return 'Los reportes no están disponibles en este momento. Reintenta en unos instantes; si continúa, avisa a la administración del taller.'
  if (error?.status >= 500) return 'No pudimos preparar el reporte. Reintenta en unos instantes; si continúa, avisa a la administración del taller.'
  return 'No pudimos conectar con los reportes. Comprueba la conexión y vuelve a intentarlo.'
}
