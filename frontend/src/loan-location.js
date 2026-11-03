import { esc, fmtDay } from './util.js'
import { demoDeviceCoordinates } from './loan-map-demo.js'

const zones = [
  { key: 'available', title: 'Disponibles', description: 'Disponibles para entregar', location: 'Disponible para préstamo' },
  { key: 'loaned', title: 'Prestados', description: 'Préstamos pendientes de devolución', location: 'Préstamo activo' },
  { key: 'retired', title: 'Fuera de servicio', description: 'Retirados de la flota', location: 'Retirado · no disponible' },
]
export function loanLocation(device) {
  return zones.find(zone => zone.key === device?.status) || { key: 'unknown', title: 'Sin clasificar', description: 'Estado sin ubicación asignada', location: 'Ubicación no determinada' }
}
const nameOf = device => [device.brand, device.model].filter(Boolean).join(' ') || 'Equipo'

export function fleetLocation(devices) {
  const items = Array.isArray(devices) ? devices : []
  const groups = [...zones]
  if (items.some(device => loanLocation(device).key === 'unknown')) groups.push(loanLocation({}))
  return `<section class="loan-map loan-map--geographic" aria-label="Mapa geográfico de demostración de equipos">
    <header class="loan-map__heading"><div><p class="loan-map__kicker">Flota de respaldo · San Salvador</p><h2>Mapa de equipos</h2><p>Calles reales y posiciones de ejemplo. La aplicación todavía no recibe señal GPS de los móviles.</p></div>
    <div class="loan-map__controls"><label>Seleccionar equipo<select data-location-select><option value="">Vista de toda la flota</option>${items.filter(d => d.id != null).map(d => `<option value="${esc(String(d.id))}">${esc(d.asset_tag || 'Sin etiqueta')} · ${esc(nameOf(d))}</option>`).join('')}</select></label><button type="button" class="btn btn-ghost" data-location-reset>Ver todos</button></div></header>
    <div class="loan-map__legend">${groups.map(zone => `<span class="loan-map__key loan-map__key--${zone.key}"><i></i>${zone.title}<strong>${items.filter(d => loanLocation(d).key === zone.key).length}</strong></span>`).join('')}</div>
    <div class="loan-map__stage" data-location-stage>
      <span class="loan-map__demo-badge">Demostración · posiciones simuladas</span>
      <div class="loan-map__fallback">${groups.map(zone => `<section class="loan-map__zone loan-map__zone--${zone.key}"><h3>${zone.title}</h3><p>${zone.description}</p><div>${items.filter(d => loanLocation(d).key === zone.key).map(d => `<button type="button" data-locate="${esc(String(d.id ?? ''))}" aria-pressed="false" ${d.id == null ? 'disabled' : ''}><span class="loan-map__phone" aria-hidden="true"></span><strong>${esc(d.asset_tag || 'Sin etiqueta')}</strong><span>${esc(nameOf(d))}</span></button>`).join('') || '<span class="loan-map__vacant">Sin equipos</span>'}</div></section>`).join('')}</div>
      <div class="loan-map__canvas" data-location-canvas></div>
    </div>
    <p class="loan-map__geo-help" data-location-hint>${items.filter(d => demoDeviceCoordinates(d)).length} posiciones simuladas de ${items.length} equipos de esta página. Arrastra el mapa o selecciona un marcador.</p>
    <div class="loan-map__detail" data-location-detail role="status" aria-live="polite" aria-atomic="true"><span class="loan-map__pin" aria-hidden="true">⌖</span><div><h3>${items.length ? 'Selecciona un móvil en el mapa' : 'No hay equipos en esta página'}</h3><p>Consulta su punto de ejemplo y abre el caso asociado.</p></div></div>
  </section>`
}

export function loanLocatorButton(device) {
  return `<button class="btn btn-ghost loan-locate" type="button" data-locate="${esc(String(device.id ?? ''))}" aria-label="Ver ubicación de ${esc(nameOf(device))}, ${esc(device.asset_tag || 'sin etiqueta')}" aria-pressed="false" ${device.id == null ? 'disabled' : ''}>Ver ubicación</button>`
}

export function bindLoanLocator(main, devices) {
  const map = main.querySelector('.loan-map')
  if (!map) return () => {}
  const select = map.querySelector('[data-location-select]')
  const detail = map.querySelector('[data-location-detail]')
  const stage = map.querySelector('[data-location-stage]')
  const host = map.querySelector('[data-location-canvas]')
  const initialDetail = detail.innerHTML
  let selectedId = null
  let disposed = false
  let instance = null
  let started = false
  const fallback = () => {
    delete stage.dataset.sceneReady
    delete stage.dataset.rendererBackend
    map.querySelector('[data-location-hint]').textContent = 'No se pudo cargar el mapa. Puedes seleccionar un equipo en la lista y abrir su punto demo en Google Maps.'
  }
  const choose = (id, scroll = false) => {
    if (disposed) return
    const device = devices.find(d => d.id != null && String(d.id) === String(id))
    selectedId = device ? String(device.id) : null
    select.value = selectedId || ''
    main.querySelectorAll('[data-locate]').forEach(button => button.setAttribute('aria-pressed', String(Boolean(device) && button.dataset.locate === selectedId)))
    if (device) {
      const zone = loanLocation(device)
      const point = demoDeviceCoordinates(device)
      const loan = device.status === 'loaned' ? device.active_loan : null
      const caseId = Number(loan?.case_id)
      const caseLink = loan?.case_number && Number.isSafeInteger(caseId) && caseId > 0
        ? `<a class="btn btn-ghost" href="#/cases/${caseId}">Abrir caso ${esc(loan.case_number)}</a>` : ''
      const externalMap = point ? `<a class="btn btn-ghost" href="https://www.google.com/maps/search/?api=1&amp;query=${point[1]},${point[0]}" target="_blank" rel="noopener noreferrer">Abrir punto demo en Google Maps ↗</a>` : ''
      detail.innerHTML = `<span class="loan-map__pin loan-map__pin--${zone.key}" aria-hidden="true">⌖</span><div><p class="loan-map__location">${point ? 'Posición simulada · ' : 'Sin ubicación registrada · '}${zone.location}</p><h3>${esc(nameOf(device))} <span>${esc(device.asset_tag || 'Sin etiqueta')}</span></h3><p>${point ? `${point[1].toFixed(5)}, ${point[0].toFixed(5)} · Ejemplo, no señal GPS` : 'Este equipo aún no tiene coordenadas.'}</p><p>${esc(device.condition || 'Sin condición registrada')}${loan?.loaned_at ? ` · Entregado el ${esc(fmtDay(loan.loaned_at))}` : ''}</p>${device.status === 'loaned' && !loan ? '<p>No hay un caso activo asociado en este registro.</p>' : ''}</div><div class="loan-map__links">${externalMap}${caseLink}</div>`
    } else detail.innerHTML = initialDetail
    instance?.select(selectedId)
    if (scroll) map.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  const onClick = event => {
    const button = event.target.closest('[data-locate]')
    if (button && main.contains(button) && !button.disabled) choose(button.dataset.locate, !map.contains(button))
    if (event.target.closest('[data-location-reset]')) choose(null)
  }
  const onChange = () => choose(select.value)
  main.addEventListener('click', onClick)
  select.addEventListener('change', onChange)
  const start = async () => {
    if (started || disposed || !devices.length) return
    started = true
    try {
      const { mountLoanGeographicMap } = await import('./components/loan-geographic-map.js')
      if (disposed || !host.isConnected) return
      const mounted = await mountLoanGeographicMap(host, { devices, selectedId, onSelect: id => choose(id), isActive: () => !disposed && host.isConnected, onFallback: fallback, onReady: () => {
        if (!disposed && host.isConnected) {
          stage.dataset.sceneReady = 'true'
          stage.dataset.rendererBackend = 'maplibre'
        }
      } })
      if (disposed || !host.isConnected) { mounted?.dispose(); return }
      instance = mounted
      instance.select(selectedId)
    } catch (error) {
      if (!disposed) {
        if (import.meta.env?.DEV) console.warn('Plano 3D no disponible:', error)
        fallback()
      }
    }
  }
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); start() }
  }) : null
  if (observer) observer.observe(stage)
  else start()
  return () => {
    disposed = true
    observer?.disconnect()
    main.removeEventListener('click', onClick)
    select.removeEventListener('change', onChange)
    instance?.dispose()
    instance = null
  }
}
