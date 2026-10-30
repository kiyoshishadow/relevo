import { esc } from './util.js'
import { resolveDeviceProfile } from './components/device-profiles.js'

export function availableLoanDevices(devices) {
  return Array.isArray(devices) ? devices.filter(device => device.status === 'available') : []
}

export function loanDeviceOptionLabel(device) {
  const name = [device?.brand, device?.model].filter(Boolean).join(' ') || 'Terminal'
  return device?.asset_tag ? `${name} · ${device.asset_tag}` : name
}

const states = [
  { key: 'available', label: 'Disponibles' },
  { key: 'loaned', label: 'Entregados' },
  { key: 'retired', label: 'Retirados' },
]

// El escenario siempre refleja únicamente la página que devolvió la API.
export function fleetDock(devices) {
  const items = Array.isArray(devices) ? devices : []
  const counts = states.map(state => ({ ...state, count: items.filter(item => item.status === state.key).length }))
  const unknown = items.length - counts.reduce((sum, state) => sum + state.count, 0)
  if (unknown) counts.push({ key: 'unknown', label: 'Otros estados', count: unknown })
  const models = items.slice(0, 5)
  return `<section class="fleet-dock" aria-label="Resumen de equipos de esta página">
      <div class="fleet-dock__content">
      <div class="fleet-dock__eyebrow"><span></span> CENTRO DE RESPALDO <b> / FLOTA</b></div>
      <h2>Una flota<br><em>para acompañar.</em></h2>
      <p>Muestra: ${Math.min(items.length, 5)} de ${items.length} equipos de esta página. Usa «Localizar» en una fila para destacarlo.</p>
      <div class="fleet-dock__counts">${counts.map(state => `<div class="fleet-dock__count fleet-dock__count--${state.key}"><strong>${state.count}</strong><span>${state.label}</span></div>`).join('')}</div>
    </div>
    <div class="fleet-dock__stage" aria-hidden="true">
      <div class="fleet-dock__orbit fleet-dock__orbit--one"></div><div class="fleet-dock__orbit fleet-dock__orbit--two"></div>
      <div class="fleet-dock__rack">${models.length ? models.map((item, index) => fleetDeviceMarkup(item, index)).join('') : '<div class="fleet-dock__empty">SIN EQUIPOS EN ESTA PÁGINA</div>'}</div>
      <div class="fleet-dock__stage-label"><span>INVENTARIO VISIBLE</span><span>${String(items.length).padStart(2, '0')} / ${items.length === 1 ? 'EQUIPO' : 'EQUIPOS'}</span></div>
    </div>
  </section>`
}

export function fleetDeviceMarkup(item, index = 0) {
  const profile = resolveDeviceProfile(item.brand, item.model)
  const camera = profile.exact ? profile.camera : 'illustrative'
  const name = [item.brand, item.model].filter(Boolean).join(' ') || 'Equipo'
  const id = item.id == null ? '' : String(item.id)
  return `<div class="fleet-device fleet-device--${camera}" data-device-id="${esc(id)}" style="--fleet-index:${index}"><div class="fleet-device__motion"><div class="fleet-device__shell"><i></i><i></i><i></i></div><span title="${esc(name)}">${esc(name)}</span></div></div>`
}
