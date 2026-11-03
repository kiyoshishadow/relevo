import { esc, fmtDay } from './util.js'

const zones = [
  { key: 'available', title: 'Reserva del taller', description: 'Disponibles para entregar', location: 'En el taller · disponible' },
  { key: 'loaned', title: 'Con cliente', description: 'Préstamos pendientes de devolución', location: 'Fuera del taller · prestado' },
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
  return `<section class="loan-map" aria-label="Ubicación operativa de los equipos de esta página">
    <header class="loan-map__heading"><div><p class="loan-map__kicker">Flota de respaldo</p><h2>Dónde está cada equipo</h2><p>Distribución por estado registrado en esta página. El plano es esquemático; no muestra GPS ni direcciones.</p></div>
    <div class="loan-map__controls"><label>Seleccionar equipo<select data-location-select><option value="">Vista de toda la flota</option>${items.filter(d => d.id != null).map(d => `<option value="${esc(String(d.id))}">${esc(d.asset_tag || 'Sin etiqueta')} · ${esc(nameOf(d))}</option>`).join('')}</select></label><button type="button" class="btn btn-ghost" data-location-reset>Ver todos</button></div></header>
    <div class="loan-map__legend">${groups.map(zone => `<span class="loan-map__key loan-map__key--${zone.key}"><i></i>${zone.title}<strong>${items.filter(d => loanLocation(d).key === zone.key).length}</strong></span>`).join('')}</div>
    <div class="loan-map__stage" data-location-stage>
      <div class="loan-map__fallback">${groups.map(zone => `<section class="loan-map__zone loan-map__zone--${zone.key}"><h3>${zone.title}</h3><p>${zone.description}</p><div>${items.filter(d => loanLocation(d).key === zone.key).map(d => `<button type="button" data-locate="${esc(String(d.id ?? ''))}" aria-pressed="false" ${d.id == null ? 'disabled' : ''}><span class="loan-map__phone" aria-hidden="true"></span><strong>${esc(d.asset_tag || 'Sin etiqueta')}</strong><span>${esc(nameOf(d))}</span></button>`).join('') || '<span class="loan-map__vacant">Sin equipos</span>'}</div></section>`).join('')}</div>
      <div class="loan-map__canvas" data-location-canvas aria-hidden="true"></div>
      <p class="loan-map__hint" data-location-hint>Elige un equipo en el plano o en la lista.</p>
    </div>
    <div class="loan-map__detail" data-location-detail role="status" aria-live="polite" aria-atomic="true"><span class="loan-map__pin" aria-hidden="true">⌖</span><div><h3>${items.length ? 'Selecciona un equipo para ubicarlo' : 'No hay equipos en esta página'}</h3><p>Consulta su disponibilidad y, si está prestado, abre el caso asociado.</p></div></div>
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
    map.querySelector('[data-location-hint]').textContent = 'Elige un equipo en el plano o en la lista.'
  }
  const choose = (id, scroll = false) => {
    if (disposed) return
    const device = devices.find(d => d.id != null && String(d.id) === String(id))
    selectedId = device ? String(device.id) : null
    select.value = selectedId || ''
    main.querySelectorAll('[data-locate]').forEach(button => button.setAttribute('aria-pressed', String(Boolean(device) && button.dataset.locate === selectedId)))
    if (device) {
      const zone = loanLocation(device)
      const loan = device.status === 'loaned' ? device.active_loan : null
      const caseId = Number(loan?.case_id)
      const caseLink = loan?.case_number && Number.isSafeInteger(caseId) && caseId > 0
        ? `<a class="btn btn-ghost" href="#/cases/${caseId}">Abrir caso ${esc(loan.case_number)}</a>` : ''
      detail.innerHTML = `<span class="loan-map__pin loan-map__pin--${zone.key}" aria-hidden="true">⌖</span><div><p class="loan-map__location">${zone.location}</p><h3>${esc(nameOf(device))} <span>${esc(device.asset_tag || 'Sin etiqueta')}</span></h3><p>${esc(device.condition || 'Sin condición registrada')}${loan?.loaned_at ? ` · Entregado el ${esc(fmtDay(loan.loaned_at))}` : ''}</p>${device.status === 'loaned' && !loan ? '<p>No hay un caso activo asociado en este registro.</p>' : ''}</div>${caseLink}`
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
      const { mountLoanLocationScene } = await import('./components/loan-location-scene.js')
      if (disposed || !host.isConnected) return
      const mounted = await mountLoanLocationScene(host, { devices, selectedId, onSelect: id => choose(id), isActive: () => !disposed && host.isConnected, onFallback: fallback })
      if (disposed || !host.isConnected) { mounted?.dispose(); return }
      instance = mounted
      instance.select(selectedId)
      stage.dataset.sceneReady = 'true'
      stage.dataset.rendererBackend = instance.backend
      map.querySelector('[data-location-hint]').textContent = 'Arrastra para girar el plano. Toca un teléfono para ver su ubicación.'
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
