// Equipos: alta de terminales con IMEIs múltiples; listado real.
import { get, post } from '../api.js'
import { esc, fmtDay } from '../util.js'
import { workShell, requireAuth, onLeave } from '../layout/work.js'
import { loadAllPages } from '../paged-data.js'
import { localDateOnly, combineTerminalImeis, terminalPurchaseDateError } from '../terminal-form.js'
import { mountTerminalRegistrationMotion } from '../terminal-registration-motion.js'
import gsap from 'gsap'
import '../styles/terminals-motion.css'

const listRequests = new WeakMap()
const viewStates = new WeakMap()

// A coverage with no brand applies to every terminal. Keep normalization aligned
// with the API, which compares trimmed, case-insensitive brand names.
export function compatibleTerminalCoverages(coverages, brand) {
  const normalizedBrand = String(brand || '').trim().toLowerCase()
  return coverages.filter(coverage => coverage.active === true &&
    (coverage.brand == null || String(coverage.brand).trim().toLowerCase() === normalizedBrand))
}

// Unambiguous confirmation of a successful registration, preserved even when
// reloading the list fails. The retry notice only re-reads; it never re-posts.
export function terminalSavedFeedback(listUpdated) {
  const status = 'El equipo se registró correctamente.'
  return {
    status,
    notice: listUpdated ? '' : `<div class="notice notice-ok" role="status">Equipo registrado correctamente. La lista de equipos no se pudo actualizar todavía.<button class="btn btn-ghost" type="button" data-retry-list-reload>Reintentar la lectura de la lista</button></div>`,
  }
}

export function createCoverageCardMotion(card, { gsapApi = gsap, mediaQuery, tweens = new Set() } = {}) {
  let selectedId = ''
  let tween = null
  let disposed = false
  const resetStyles = () => {
    gsapApi.set(card, { clearProps: 'opacity,visibility,transform' })
    delete card.dataset.coverageMotion
    delete card.dataset.retireReason
  }
  const cancelTween = () => {
    if (!tween) return
    tween.kill()
    tweens.delete(tween)
    tween = null
    resetStyles()
  }
  const finish = current => {
    if (tween !== current) return
    tweens.delete(current)
    tween = null
    card.hidden = !selectedId
    resetStyles()
  }
  const onPreferenceChange = event => {
    if (!event.matches) return
    cancelTween()
    card.hidden = !selectedId
  }
  if (mediaQuery?.addEventListener) mediaQuery.addEventListener('change', onPreferenceChange)
  else mediaQuery?.addListener?.(onPreferenceChange)

  return {
    sync(nextId, removalReason = 'none') {
      const next = String(nextId || '')
      if (disposed || next === selectedId) return
      const previous = selectedId
      selectedId = next
      cancelTween()
      if (mediaQuery?.matches) {
        card.hidden = !next
        return
      }
      if (next) {
        card.hidden = false
        card.dataset.coverageMotion = previous ? 'replace' : 'seat'
        let current
        current = gsapApi.fromTo(card,
          previous
            ? { autoAlpha: 0, x: 16, y: -2, rotationY: 9, scale: .96 }
            : { autoAlpha: 0, x: 0, y: -14, rotationY: -10, scale: .9 },
          {
            autoAlpha: 1, x: 0, y: 0, rotationY: 0, scale: 1,
            duration: .3, ease: 'back.out(1.25)', clearProps: 'opacity,visibility,transform',
            onComplete: () => finish(current),
          })
        tween = current
        tweens.add(current)
        return
      }
      if (!previous) return
      card.hidden = false
      card.dataset.coverageMotion = 'retire'
      card.dataset.retireReason = removalReason === 'incompatible' ? 'incompatible' : 'none'
      let current
      current = gsapApi.to(card, removalReason === 'incompatible'
        ? {
            autoAlpha: 0, x: 18, y: -3, rotationY: 13, scale: .96,
            duration: .24, ease: 'power2.in', clearProps: 'opacity,visibility,transform',
            onComplete: () => finish(current),
          }
        : {
            autoAlpha: 0, x: 0, y: 13, rotationX: -8, scale: .93,
            duration: .22, ease: 'power2.in', clearProps: 'opacity,visibility,transform',
            onComplete: () => finish(current),
          })
      tween = current
      tweens.add(current)
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (mediaQuery?.removeEventListener) mediaQuery.removeEventListener('change', onPreferenceChange)
      else mediaQuery?.removeListener?.(onPreferenceChange)
      cancelTween()
      selectedId = ''
      card.hidden = true
    },
  }
}

function reveal(root, targets, { x = 0, y = 7, stagger = 0 } = {}) {
  const state = viewStates.get(root)
  if (!state?.active || state.motionPreference.matches || !targets?.length) return
  let tween
  tween = gsap.fromTo(targets, { opacity: .35, x, y }, {
    opacity: 1, x: 0, y: 0, duration: .24, stagger, ease: 'power2.out',
    clearProps: 'opacity,transform', onComplete: () => state.tweens.delete(tween),
  })
  state.tweens.add(tween)
}

function clearMotion(state) {
  for (const tween of state.tweens) {
    const targets = tween.targets()
    tween.kill()
    gsap.set(targets, { clearProps: 'opacity,transform' })
  }
  state.tweens.clear()
}

export async function terminalsView(root) {
  if (!(await requireAuth(root))) return
  if (!root.isConnected) return
  const state = { active: true, formRequest: 0, tweens: new Set(), cleanups: new Set(), pendingRegistration: null, motionPreference: window.matchMedia('(prefers-reduced-motion: reduce)') }
  const preferenceChange = () => { if (state.motionPreference.matches) clearMotion(state) }
  state.motionPreference.addEventListener('change', preferenceChange)
  viewStates.set(root, state)
  onLeave(() => {
    state.active = false
    state.formRequest++
    listRequests.set(root, (listRequests.get(root) || 0) + 1)
    for (const cleanup of state.cleanups) cleanup()
    state.cleanups.clear()
    clearMotion(state)
    state.motionPreference.removeEventListener('change', preferenceChange)
    viewStates.delete(root)
  })
  root.innerHTML = workShell('Equipos', 'Terminales registrados', `<div class="skel">Cargando equipos…</div>`)
  root.querySelector('.work-main').classList.add('terminals-workspace')
  await load(root)
}

async function load(root, q = '', page = 1) {
  const state = viewStates.get(root)
  if (!state?.active) return null
  state.formRequest++
  for (const cleanup of state.cleanups) cleanup()
  state.cleanups.clear()
  clearMotion(state)
  const requestId = (listRequests.get(root) || 0) + 1
  listRequests.set(root, requestId)
  const main = root.querySelector('.work-main')
  const focused = main?.contains(document.activeElement) ? document.activeElement : null
  const restoreSearchFocus = focused?.matches('[data-search] input[name="q"], [data-search] button[type="submit"]')
  const selection = focused?.matches('input[name="q"]')
    ? [focused.selectionStart, focused.selectionEnd]
    : null
  const isCurrent = () => listRequests.get(root) === requestId && main?.isConnected && root.contains(main)
  main.innerHTML = `
    <div class="spread"><h1>Equipos</h1><div style="color:var(--ink-mute)">Terminales registrados</div></div>
    <form data-search class="row" style="gap:.6rem;margin-bottom:1rem">
      <input name="q" value="${esc(q)}" placeholder="Cliente, marca, modelo o IMEI" style="max-width:320px" aria-label="Buscar equipos por cliente, marca, modelo o IMEI">
      <button class="btn btn-ghost" type="submit">Buscar</button>
      <button class="btn btn-primary" type="button" data-new aria-expanded="false" aria-controls="terminal-registration">+ Registrar equipo</button>
    </form>
    <div data-newform id="terminal-registration"></div>
    <p data-list-status role="status" aria-live="polite" aria-atomic="true" style="color:var(--ink-mute);margin:.5rem 0">Cargando equipos…</p>
    <div data-list tabindex="-1" aria-busy="true"><div class="skel" aria-hidden="true">Cargando…</div></div>`

  const searchForm = main.querySelector('[data-search]')
  searchForm.addEventListener('submit', ev => {
    ev.preventDefault()
    load(root, String(new FormData(ev.target).get('q') || '').trim())
  })
  main.querySelector('[data-new]').addEventListener('click', ev => showForm(root, ev.currentTarget))
  if (restoreSearchFocus) {
    const searchInput = searchForm.querySelector('input[name="q"]')
    searchInput.focus()
    if (selection) searchInput.setSelectionRange(...selection)
  }

  try {
    const qs = new URLSearchParams({ page: String(page), pageSize: '30' })
    if (q) qs.set('q', q)
    const { data, meta } = await get('/terminals?' + qs)
    if (!isCurrent()) return null
    const list = main.querySelector('[data-list]')
    const status = main.querySelector('[data-list-status]')
    const count = Number.isFinite(Number(meta?.total)) ? Number(meta.total) : (data || []).length
    status.textContent = q
      ? `${count} equipos encontrados para “${q}”.`
      : `${count} equipos registrados.`
    list.setAttribute('aria-busy', 'false')
    list.innerHTML = `
      <div class="table-wrap" tabindex="0" role="region" aria-label="Tabla de equipos"><table>
        <thead><tr><th>Cliente</th><th>Marca / modelo</th><th>IMEI</th><th>Compra</th><th>Cobertura</th></tr></thead>
        <tbody>${(data || []).map(t => `
          <tr>
            <td>${esc(t.client_name || t.client?.full_name || '—')}</td>
            <td>${esc(t.brand)} ${esc(t.model)}</td>
            <td class="mono">${(t.imeis || []).map(esc).join(', ') || '—'}</td>
            <td>${fmtDay(t.purchase_date || t.created_at)}</td>
            <td>${esc(t.coverage_name || t.coverage?.name || '—')}</td>
          </tr>`).join('') || '<tr><td colspan="5" style="color:var(--ink-mute)">Sin equipos registrados.</td></tr>'}
        </tbody></table></div>
        ${pagination(meta, page)}`
    const pending = state.pendingRegistration
    const savedTerminal = pending && !pending.shown
      ? (data || []).find(terminal => String(terminal.id) === pending.id)
      : null
    if (savedTerminal) {
      try {
        const motion = mountTerminalRegistrationMotion(list, savedTerminal, { gsapApi: gsap, mediaQuery: state.motionPreference })
        if (motion) {
          pending.shown = true
          state.cleanups.add(motion.dispose)
        }
      } catch { /* an illustration issue never changes the confirmed save */ }
      const shell = root.querySelector('[data-list-status]')
      if (shell) shell.textContent = `Equipo registrado · ${savedTerminal.brand || 'Marca desconocida'} / ${savedTerminal.model || 'modelo desconocido'}`
    }
    if (pending && !pending.shown && !savedTerminal) {
      const shell = root.querySelector('[data-list-status]')
      if (shell) shell.textContent = `${count} equipos registrados. El equipo se guardó correctamente; todavía no aparece en esta página.`
    }
    if (!data?.length) {
      const emptyCell = list.querySelector('tbody td')
      if (emptyCell) emptyCell.textContent = q ? 'No se encontraron equipos con esa búsqueda.' : 'Sin equipos registrados.'
    }
    bindPagination(main, nextPage => load(root, q, nextPage))
    reveal(root, list.querySelectorAll('tbody tr'), { x: -5, y: 0, stagger: .014 })
    return true
  } catch (e) {
    if (!isCurrent()) return null
    main.querySelector('[data-list-status]').textContent = 'No se pudieron cargar los equipos.'
    const list = main.querySelector('[data-list]')
    list.setAttribute('aria-busy', 'false')
    list.innerHTML = `<div class="notice notice-error" role="alert">${esc(e?.message || 'No se pudieron cargar los equipos.')}</div>`
    reveal(root, list.querySelectorAll('.notice'), { y: 4 })
    return false
  }
}

function pagination(meta, requestedPage) {
  if (!meta) return ''
  const page = Number(meta.page) || requestedPage
  const pageSize = Number(meta.pageSize) || 30
  const total = Number(meta.total) || 0
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = total ? (page - 1) * pageSize + 1 : 0
  const last = Math.min(page * pageSize, total)
  return `<nav class="row" aria-label="Paginación de equipos" style="justify-content:space-between;gap:.75rem;align-items:center;margin-top:.8rem">
    <p data-page-status tabindex="-1" aria-live="polite" style="color:var(--ink-mute);margin:0">${first}–${last} de ${total} · página ${page} de ${pages}</p>
    <div class="row" style="gap:.5rem"><button class="btn btn-ghost" type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Página anterior de equipos">← Anterior</button>
    <button class="btn btn-ghost" type="button" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Página siguiente de equipos">Siguiente →</button></div>
  </nav>`
}

function bindPagination(main, onPage) {
  main.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', async () => {
    if (!button.disabled) {
      await onPage(Number(button.dataset.page))
      main.querySelector('[data-page-status]')?.focus()
    }
  }))
}

async function showForm(root, opener) {
  const box = root.querySelector('[data-newform]')
  const state = viewStates.get(root)
  if (!box || !state?.active || opener.disabled) return
  for (const cleanup of state.cleanups) cleanup()
  state.cleanups.clear()
  clearMotion(state)
  const requestId = ++state.formRequest
  const isCurrent = () => state.active && state.formRequest === requestId && box.isConnected && root.contains(box)
  // Survives load()'s re-render, which replaces the form box; it only checks
  // that the view is still alive so a settled POST can report its outcome.
  const main = root.querySelector('.work-main')
  const saveAlive = () => state.active && main.isConnected && root.contains(main)
  // Re-read only: every branch here reloads the list and never repeats the POST.
  const refreshAfterSave = async () => {
    let result = false
    try { result = await load(root) } catch { result = false }
    // A newer load/navigation owns the current UI. Do not replace it with a
    // retry notice from this older save flow or move its focus.
    if (result === null) return
    const listUpdated = result === true
    if (!saveAlive()) return
    const feedback = terminalSavedFeedback(listUpdated)
    if (!listUpdated) {
      const slot = main.querySelector('[data-newform]')
      if (slot && feedback.notice) {
        slot.innerHTML = feedback.notice
        reveal(root, slot.querySelectorAll('.notice'), { y: 4 })
        slot.querySelector('[data-retry-list-reload]')?.addEventListener('click', () => {
          if (saveAlive()) refreshAfterSave()
        })
      }
      return
    }
    const listStatus = main.querySelector('[data-list-status]')
    if (listStatus && state.pendingRegistration?.shown) listStatus.textContent = `${listStatus.textContent} Último equipo registrado correctamente.`
    main.querySelector('[data-list]')?.focus()
  }
  opener.disabled = true
  opener.setAttribute('aria-expanded', 'true')
  box.setAttribute('aria-busy', 'true')
  box.innerHTML = '<div class="terminal-form-loading" role="status">Preparando clientes y coberturas…</div>'
  let clients = [], coverages = []
  try {
    const [allClients, allCoverages] = await Promise.all([
      loadAllPages(get, '/clients'),
      loadAllPages(get, '/coverages'),
    ])
    if (!isCurrent()) return
    clients = allClients.filter(client => client.active === true)
    coverages = allCoverages.filter(coverage => coverage.active === true)
  } catch (e) {
    if (!isCurrent()) return
    box.innerHTML = `<div class="notice notice-error" role="alert">${esc(e?.message || 'No hay clientes disponibles; registra uno primero.')}</div>`
    box.setAttribute('aria-busy', 'false')
    opener.disabled = false
    opener.setAttribute('aria-expanded', 'false')
    reveal(root, box.querySelectorAll('.notice'), { y: 4 })
    return
  }
  box.setAttribute('aria-busy', 'false')
  box.innerHTML = `
    <section class="panel terminal-registration">
      <h3>Registrar equipo</h3>
      <p class="terminal-registration__intro">Identifica el terminal y su estado al ingresar al taller.</p>
      ${!clients.length ? '<p class="notice notice-info" role="status">No hay clientes activos. <a href="#/clients">Registra o activa un cliente</a> antes de continuar.</p>' : ''}
      <form data-form class="grid2">
        <div class="field"><label for="terminal-client">Cliente</label>
          <select id="terminal-client" name="client_id" required>
            <option value="">Elegir cliente…</option>${clients.map(c => `<option value="${esc(c.id)}">${esc(c.full_name)}</option>`).join('')}
          </select></div>
        <div class="field"><label for="terminal-brand">Marca</label><input id="terminal-brand" name="brand" required autocomplete="off"></div>
        <div class="field"><label for="terminal-coverage">Cobertura</label>
          <select id="terminal-coverage" name="coverage_id" aria-describedby="terminal-coverage-help"></select>
          <div class="terminal-coverage-dock" aria-hidden="true"><div class="terminal-coverage-dock__bay"><span class="terminal-coverage-card" data-coverage-card hidden><i></i><b></b></span></div></div>
          <small id="terminal-coverage-help" role="status" aria-live="polite"></small></div>
        <div class="field"><label for="terminal-model">Modelo</label><input id="terminal-model" name="model" required autocomplete="off"></div>
        <div class="field"><label for="terminal-imei-1">IMEI 1 <span>(SIM 1)</span></label><input id="terminal-imei-1" name="imei_1" inputmode="numeric" autocomplete="off" placeholder="14 a 16 dígitos" aria-describedby="terminal-imeis-help"></div>
        <div class="field"><label for="terminal-imei-2">IMEI 2 <span>(SIM 2, opcional)</span></label><input id="terminal-imei-2" name="imei_2" inputmode="numeric" autocomplete="off" placeholder="14 a 16 dígitos" aria-describedby="terminal-imeis-help"><small id="terminal-imeis-help" role="status" aria-live="polite">Puedes dejarlos vacíos o indicar uno o dos IMEI de 14 a 16 dígitos.</small></div>
        <div class="sim-slots" data-sim-slots role="group" aria-label="Estado de las ranuras SIM según los campos IMEI">
          <p class="sim-slots__title">Ranuras SIM <span>Según los campos IMEI</span></p>
          <div class="sim-slots__list">
            <div class="sim-slot is-empty" data-sim-slot="1">
              <span class="sim-slot__chip" aria-hidden="true"></span>
              <span class="sim-slot__body"><span class="sim-slot__name">SIM 1</span><span class="sim-slot__state" data-sim-state>Sin dato</span></span>
            </div>
            <div class="sim-slot is-empty" data-sim-slot="2">
              <span class="sim-slot__chip" aria-hidden="true"></span>
              <span class="sim-slot__body"><span class="sim-slot__name">SIM 2</span><span class="sim-slot__state" data-sim-state>Sin dato</span></span>
            </div>
          </div>
        </div>
        <div class="field"><label for="terminal-purchase-date">Fecha de compra</label><input id="terminal-purchase-date" name="purchase_date" type="date" required max="${localDateOnly()}" aria-describedby="terminal-purchase-date-help"><small id="terminal-purchase-date-help" role="status" aria-live="polite">Obligatoria; no puede ser posterior a hoy.</small></div>
        <div class="field"><label for="terminal-accessories">Accesorios entregados</label><input id="terminal-accessories" name="accessories" placeholder="Cargador, funda…"></div>
        <div style="grid-column:1/-1"><div class="field"><label for="terminal-initial-condition">Estado inicial del equipo</label><textarea id="terminal-initial-condition" name="initial_condition" required placeholder="Rayones, pantalla, encendido…"></textarea></div></div>
        <div class="row" style="grid-column:1/-1">
          <button class="btn btn-primary" type="submit" ${!clients.length ? 'disabled title="Registre primero un cliente"' : ''}>Registrar</button>
          <button class="btn btn-ghost" type="button" data-cancel>Cancelar</button>
        </div>
      </form>
      <p class="terminal-form-status" data-save-status role="status" aria-live="polite"></p>
      <div data-err></div>
    </section>`
  const cancelBtn = box.querySelector('[data-cancel]')
  const form = box.querySelector('[data-form]')
  const brandInput = form.elements.brand
  const coverageInput = form.elements.coverage_id
  const coverageHelp = box.querySelector('#terminal-coverage-help')
  const coverageCard = box.querySelector('[data-coverage-card]')
  const coverageMotion = createCoverageCardMotion(coverageCard, { mediaQuery: state.motionPreference, tweens: state.tweens })
  const stopCoverageMotion = coverageMotion.dispose
  state.cleanups.add(stopCoverageMotion)
  const disposeCoverageMotion = () => {
    stopCoverageMotion()
    state.cleanups.delete(stopCoverageMotion)
  }
  const imeiInputs = [form.elements.imei_1, form.elements.imei_2]
  const imeiHelp = box.querySelector('#terminal-imeis-help')
  const simSlots = [...box.querySelectorAll('[data-sim-slot]')]
  const simSlotTweens = new WeakMap()
  const purchaseDateInput = form.elements.purchase_date
  const purchaseDateHelp = box.querySelector('#terminal-purchase-date-help')
  // Purely local to each field: no IMEI text, no server lookup, no validation change.
  const imeiSlotState = value => {
    const raw = String(value ?? '').trim()
    if (!raw) return { state: 'empty', label: 'Sin dato' }
    if (/^\d{14,16}$/.test(raw)) return { state: 'complete', label: 'Completo' }
    return { state: 'review', label: 'Revisar' }
  }
  const pulseSimSlot = slot => {
    if (!state.active || state.motionPreference.matches) return
    const target = slot.querySelector('.sim-slot__state')
    if (!target) return
    const previous = simSlotTweens.get(slot)
    if (previous) {
      previous.kill()
      state.tweens.delete(previous)
    }
    let tween
    tween = gsap.fromTo(target, { y: 2, opacity: .45 }, {
      y: 0, opacity: 1, duration: .18, ease: 'power2.out',
      clearProps: 'opacity,transform',
      onComplete: () => { state.tweens.delete(tween); simSlotTweens.delete(slot) },
    })
    state.tweens.add(tween)
    simSlotTweens.set(slot, tween)
  }
  const updateSimSlots = () => {
    simSlots.forEach((slot, index) => {
      const next = imeiSlotState(imeiInputs[index]?.value)
      const stateClass = `is-${next.state}`
      if (!slot.classList.contains(stateClass)) {
        slot.classList.remove('is-empty', 'is-complete', 'is-review')
        slot.classList.add(stateClass)
        pulseSimSlot(slot)
      }
      const status = slot.querySelector('[data-sim-state]')
      if (status && status.textContent !== next.label) status.textContent = next.label
    })
  }
  const updateImeis = () => {
    const result = combineTerminalImeis(imeiInputs[0]?.value, imeiInputs[1]?.value)
    imeiInputs.forEach(input => input?.setCustomValidity(result.error))
    imeiHelp.textContent = result.error || 'Puedes dejarlos vacíos o indicar uno o dos IMEI de 14 a 16 dígitos. El servidor confirma si ya está registrado.'
    updateSimSlots()
  }
  const updatePurchaseDate = () => {
    const error = terminalPurchaseDateError(purchaseDateInput.value)
    purchaseDateInput.setCustomValidity(error)
    purchaseDateHelp.textContent = error || 'Obligatoria; no puede ser posterior a hoy.'
  }
  imeiInputs.forEach(input => input?.addEventListener('input', updateImeis))
  purchaseDateInput.addEventListener('input', updatePurchaseDate)
  let removedIncompatiblePlan = false
  const updateCoverages = (cause = 'brand') => {
    const previous = coverageInput.value
    const choices = compatibleTerminalCoverages(coverages, brandInput.value)
    coverageInput.innerHTML = '<option value="">Sin plan</option>' + choices.map(c =>
      `<option value="${esc(c.id)}">${esc(c.name || c.plan)} (${esc(c.brand ?? 'todas las marcas')})</option>`).join('')
    const kept = choices.some(coverage => String(coverage.id) === previous)
    coverageInput.value = kept ? previous : ''
    const invalidated = Boolean(previous && !kept)
    if (invalidated) removedIncompatiblePlan = true
    coverageHelp.textContent = removedIncompatiblePlan
      ? 'Se retiró el plan anterior porque no corresponde a esta marca. Elige otro o continúa sin plan.'
      : !brandInput.value.trim()
        ? 'Escribe la marca para ver sus planes. Las coberturas globales ya están disponibles.'
        : choices.length
          ? 'Planes activos para esta marca y coberturas globales.'
          : 'No hay planes activos para esta marca. Puedes registrar el equipo sin plan.'
    coverageHelp.classList.toggle('terminal-coverage-reset', removedIncompatiblePlan)
    coverageMotion.sync(kept ? previous : '', cause === 'brand' && invalidated ? 'incompatible' : 'none')
  }
  updateCoverages()
  brandInput.addEventListener('input', updateCoverages)
  coverageInput.addEventListener('change', () => {
    removedIncompatiblePlan = false
    updateCoverages('selection')
  })
  reveal(root, box.querySelectorAll('.terminal-registration'), { y: -8 })
  box.querySelector('#terminal-client').focus()
  cancelBtn.addEventListener('click', () => {
    state.formRequest++
    disposeCoverageMotion()
    clearMotion(state)
    box.innerHTML = ''
    opener.disabled = false
    opener.setAttribute('aria-expanded', 'false')
    if (opener?.isConnected) opener.focus()
  })
  form.addEventListener('submit', ev => {
    ev.preventDefault()
    if (form.dataset.saving === 'true' || !isCurrent()) return
    updateImeis()
    updatePurchaseDate()
    if (!form.reportValidity()) return
    const f = new FormData(form)
    const btn = form.querySelector('button[type=submit]')
    const controls = [...form.querySelectorAll('[name]')].map(control => [control, control.disabled])
    box.querySelector('[data-err]').innerHTML = ''
    btn.disabled = true
    cancelBtn.disabled = true
    form.dataset.saving = 'true'
    form.setAttribute('aria-busy', 'true')
    controls.forEach(([control]) => { control.disabled = true })
    btn.textContent = 'Registrando…'
    box.querySelector('[data-save-status]').textContent = 'Registrando el equipo…'
    post('/terminals', {
      client_id: f.get('client_id'),
      brand: f.get('brand'), model: f.get('model'),
      imeis: combineTerminalImeis(f.get('imei_1'), f.get('imei_2')).values,
      purchase_date: f.get('purchase_date'),
      accessories: f.get('accessories') || undefined,
      initial_condition: f.get('initial_condition'),
      ...(f.get('coverage_id') ? { coverage_id: f.get('coverage_id') } : {}),
    }).then(async response => {
      // The registration succeeded: settle the confirmation before touching the
      // list, so a failed reload can never be mistaken for a failed save.
      if (!saveAlive()) return
      box.querySelector('[data-save-status]').textContent = terminalSavedFeedback(false).status
      const terminalId = response?.data?.id
      if (terminalId != null) state.pendingRegistration = { id: String(terminalId), shown: false }
      await refreshAfterSave()
    }).catch(e => {
      if (!isCurrent()) return
      box.querySelector('[data-err]').innerHTML = `<div class="notice notice-error" role="alert">${esc(e?.message || 'No se pudo registrar el equipo.')}</div>`
      form.dataset.saving = 'false'
      form.setAttribute('aria-busy', 'false')
      controls.forEach(([control, disabled]) => { control.disabled = disabled })
      btn.textContent = 'Registrar'
      box.querySelector('[data-save-status]').textContent = 'El equipo no se registró. Revisa el mensaje y vuelve a intentarlo.'
      btn.disabled = false
      cancelBtn.disabled = false
      reveal(root, box.querySelectorAll('[data-err] .notice'), { y: 4 })
    })
  })
}
