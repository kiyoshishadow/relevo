export function localDateOnly(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/El_Salvador',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function parseTerminalImeis(raw) {
  const values = String(raw ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (values.length > 2) return { values, error: 'Se admiten como máximo dos IMEI (doble SIM).' }
  if (values.some(value => !/^\d{14,16}$/.test(value))) {
    return { values, error: 'Cada IMEI debe contener entre 14 y 16 dígitos.' }
  }
  if (new Set(values).size !== values.length) {
    return { values, error: 'Los IMEI no pueden repetirse.' }
  }
  return { values, error: '' }
}

// Capture on mobile: numeric keypads lack a comma key, so the form offers two
// numeric fields instead. Validation still lives in parseTerminalImeis, keeping
// the same rules (and the backend contract) as before.
export function combineTerminalImeis(first = '', second = '') {
  const raw = [first, second].map(value => String(value ?? '').trim()).filter(Boolean).join(',')
  return parseTerminalImeis(raw)
}

export function terminalPurchaseDateError(value, today = localDateOnly()) {
  if (!value) return 'La fecha de compra es obligatoria.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Usa una fecha válida.'
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return 'Usa una fecha válida.'
  }
  if (value > today) return 'La fecha de compra no puede ser futura.'
  return ''
}
