// Equipos de préstamo: alta y listado con estado real.
import { get, post } from '../api.js'
import { esc, fmtDay } from '../util.js'
import { workShell, requireAuth, onLeave } from '../layout/work.js'
import { field } from '../ui.js'
import { fleetDock } from '../loan-devices.js'
import { bindLoanLocator, loanLocatorButton } from '../loan-locator-motion.js'
import '../styles/loans-motion.css'
import { gsap } from 'gsap'

const listRequests = new WeakMap()
const fleetMotion = new WeakMap()
const loanGateMotion = new WeakMap()
const loanLocator = new WeakMap()

function cleanupLoanLocator(root) {
  const stop = loanLocator.get(root)
  if (!stop) return
  loanLocator.delete(root)
  stop()
}

function cleanupLoanGate(root) {
  const stop = loanGateMotion.get(root)
  if (!stop) return
  loanGateMotion.delete(root)
  stop()
}

// Entrada/salida del formulario como compuerta de muelle; solo transforma y desvanece.
export function wireLoanGate(box, opener, {
  gsapApi = gsap,
  matchMedia = query => window.matchMedia(query),
  getActiveElement = () => document.activeElement,
} = {}) {
  const panel = box.querySelector('[data-loan-gate]')
  if (!panel) return () => {}
  const content = [...panel.querySelectorAll('[data-loan-gate-content]')]
  const media = matchMedia('(prefers-reduced-motion: reduce)')
  let phase = 'opening'
  let timeline = null
  let disposed = false
  let listening = false
  const removeMotionListener = () => {
    if (!listening) return
    listening = false
    if (media.removeEventListener) media.removeEventListener('change', onMotionChange)
    else media.removeListener?.(onMotionChange)
  }

  const clearStyles = () => {
    gsapApi.set([panel, ...content], { clearProps: 'all' })
  }
  const settleOpen = () => {
    if (disposed || phase !== 'opening') return
    phase = 'open'
    panel.dataset.gateState = 'open'
    clearStyles()
    panel.inert = false
    if (opener.isConnected && getActiveElement() === opener) {
      box.querySelector('input, select, textarea, button')?.focus({ preventScroll: true })
    }
  }
  const settleClosed = () => {
    if (disposed || phase !== 'closing') return
    phase = 'closed'
    clearStyles()
    removeMotionListener()
    box.replaceChildren()
    opener.disabled = false
  }
  const animateOpen = () => {
    panel.dataset.gateState = 'opening'
    timeline = gsapApi.timeline({ onComplete: settleOpen })
      .fromTo(panel,
        { autoAlpha: 0, y: -24, rotationX: -8, scaleY: .94, transformOrigin: 'top center' },
        { autoAlpha: 1, y: 0, rotationX: 0, scaleY: 1, duration: .48, ease: 'power4.out' })
      .fromTo(content,
        { autoAlpha: 0, y: -8 },
        { autoAlpha: 1, y: 0, duration: .24, stagger: .055, ease: 'power2.out' }, '-=.25')
  }
  const finishImmediately = () => {
    timeline?.kill()
    timeline = null
    if (phase === 'opening') settleOpen()
    else if (phase === 'closing') settleClosed()
  }
  const onMotionChange = event => {
    if (event.matches) finishImmediately()
  }

  panel.inert = true
  if (media.addEventListener) media.addEventListener('change', onMotionChange)
  else media.addListener?.(onMotionChange)
  listening = true
  if (media.matches) settleOpen()
  else animateOpen()

  const close = () => {
    if (disposed || phase === 'closing' || phase === 'closed') return
    if (phase === 'opening') {
      timeline?.kill()
      timeline = null
    }
    phase = 'closing'
    panel.dataset.gateState = 'closing'
    opener.disabled = false
    opener.focus()
    panel.inert = true
    box.querySelectorAll('input, select, textarea, button').forEach(control => { control.disabled = true })
    if (media.matches) {
      settleClosed()
      return
    }
    timeline = gsapApi.timeline({ onComplete: settleClosed })
      .to(content, { autoAlpha: 0, y: -6, duration: .14, stagger: .025, ease: 'power2.in' })
      .to(panel, { autoAlpha: 0, y: -18, rotationX: -5, scaleY: .96, duration: .26, ease: 'power3.in' }, '<')
  }
  box.querySelector('[data-cancel]')?.addEventListener('click', close)

  return () => {
    if (disposed) return
    disposed = true
    phase = 'disposed'
    timeline?.kill()
    timeline = null
    removeMotionListener()
    opener.disabled = false
    panel.inert = false
    delete panel.dataset.gateState
    clearStyles()
  }
}

function cleanupFleetMotion(root) {
  const stop = fleetMotion.get(root)
  if (!stop) return
  fleetMotion.delete(root)
  stop()
}

// Pausa la animación continua del muelle cuando la escena no se ve o la pestaña está oculta.
function bindFleetMotion(root, main) {
  cleanupFleetMotion(root)
  const dock = main.querySelector('.fleet-dock')
  if (!dock) return

  let paused = null
  const apply = next => {
    if (next === paused) return
    paused = next
    dock.dataset.motion = next ? 'paused' : 'running'
  }
  const sync = visible => apply(document.hidden === true || !visible)

  let visible = false
  let refresh = () => {}
  let stopObserver = () => {}

  if (typeof IntersectionObserver === 'function') {
    // Arranca en pausa; el observador reanuda solo cuando la escena vuelve a ser visible.
    apply(true)
    const observer = new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1]
      if (!entry) return
      visible = entry.isIntersecting
      sync(visible)
    }, { threshold: 0 })
    observer.observe(dock)
    stopObserver = () => observer.disconnect()
  } else {
    // Sin IntersectionObserver: medimos en scroll/resize, como máximo una vez por frame.
    let frame = 0
    const measure = () => {
      frame = 0
      const rect = dock.getBoundingClientRect()
      const viewport = window.innerHeight || document.documentElement.clientHeight || 0
      visible = rect.bottom > 0 && rect.top < viewport && rect.width > 0 && rect.height > 0
      sync(visible)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    refresh = schedule
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule, { passive: true })
    stopObserver = () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
    measure()
  }

  const onVisibility = () => {
    if (document.hidden === true) {
      apply(true)
      return
    }
    refresh()
    sync(visible)
  }
  document.addEventListener('visibilitychange', onVisibility)

  fleetMotion.set(root, () => {
    stopObserver()
    document.removeEventListener('visibilitychange', onVisibility)
    dock.removeAttribute('data-motion')
  })
}

export async function loansView(root) {
  if (!(await requireAuth(root))) return
  if (!root.isConnected) return
  onLeave(() => {
    cleanupLoanGate(root)
    cleanupFleetMotion(root)
    cleanupLoanLocator(root)
  })
  root.innerHTML = workShell('Equipos de préstamo', 'Flota de respaldo', `<div class="skel">Cargando flota…</div>`)
  await load(root)
}

async function load(root, q = '', status = '', page = 1) {
  const active = document.activeElement
  const filterFocus = active?.matches?.('[data-search] input[name="q"]')
    ? '[data-search] input[name="q"]'
    : active?.matches?.('[data-search] button[type="submit"]')
      ? '[data-search] button[type="submit"]'
      : null
  const requestId = (listRequests.get(root) || 0) + 1
  listRequests.set(root, requestId)
  const main = root.querySelector('.work-main')
  cleanupLoanGate(root)
  cleanupFleetMotion(root)
  cleanupLoanLocator(root)
  const isCurrent = () => listRequests.get(root) === requestId && main?.isConnected && root.contains(main)
  main.innerHTML = `
    <div class="spread"><h1 tabindex="-1">Equipos de préstamo</h1><div style="color:var(--ink-mute)">Flota de respaldo</div></div>
    <p style="max-width:64ch;color:var(--ink-soft)">Los equipos de préstamo se entregan desde un caso abierto y deben volver antes de marcar un caso como entregado.</p>
    <form data-search class="row" style="gap:.6rem;margin-bottom:1rem">
      <input name="q" value="${esc(q)}" placeholder="Buscar por etiqueta/IMEI, marca o modelo" style="max-width:280px" aria-label="Buscar equipos de préstamo por etiqueta, marca o modelo">
      <select name="status" aria-label="Filtrar equipos de préstamo por estado">
        <option value="">Todos los estados</option>
        <option value="available" ${status === 'available' ? 'selected' : ''}>Disponibles</option>
        <option value="loaned" ${status === 'loaned' ? 'selected' : ''}>Entregados</option>
        <option value="retired" ${status === 'retired' ? 'selected' : ''}>Retirados</option>
      </select>
      <button class="btn btn-ghost" type="submit">Filtrar</button>
    </form>
    <div class="row" style="margin-bottom:1rem">
      <button class="btn btn-primary" data-new>+ Registrar equipo de préstamo</button>
    </div>
    <div data-newform></div>
    <p data-list-status role="status" aria-live="polite" aria-atomic="true" style="color:var(--ink-mute);margin:.25rem 0 .75rem">${q || status ? 'Aplicando filtros…' : 'Cargando equipos…'}</p>
    <div data-list aria-busy="true"><div class="skel" role="status">Cargando equipos…</div></div>`

  main.querySelector('[data-new]').addEventListener('click', event => {
    const opener = event.currentTarget
    const box = main.querySelector('[data-newform]')
    if (opener.disabled || box.firstElementChild) return
    box.innerHTML = `
      <section class="panel loan-gate" data-loan-gate>
        <h3 data-loan-gate-content>Registrar equipo</h3>
        <form data-form class="grid2" data-loan-gate-content>
          ${field('Marca', `<input name="brand" required>`)}
          ${field('Modelo', `<input name="model" required>`)}
          ${field('Etiqueta / IMEI / serie', `<input name="asset_tag" class="mono" required>`)}
          ${field('Condición', `<input name="condition" placeholder="Estado del equipo">`)}
          <div class="row" style="grid-column:1/-1">
            <button class="btn btn-primary" type="submit">Registrar</button>
            <button class="btn btn-ghost" type="button" data-cancel>Cancelar</button>
          </div>
        </form>
        <div data-err data-loan-gate-content></div>
      </section>`
    const stopGate = wireLoanGate(box, opener)
    loanGateMotion.set(root, stopGate)
    const form = box.querySelector('[data-form]')
    box.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' })
    form.addEventListener('submit', async ev => {
      ev.preventDefault()
      const cancel = box.querySelector('[data-cancel]')
      const err = box.querySelector('[data-err]')
      err.innerHTML = ''
      const f = new FormData(form)
      const btn = form.querySelector('button[type=submit]')
      btn.disabled = true
      cancel.disabled = true
      try {
        await post('/loan-devices', {
          brand: f.get('brand'), model: f.get('model'), asset_tag: f.get('asset_tag'),
          condition: f.get('condition') || undefined,
        })
        if (form.isConnected && main?.isConnected && root.contains(main)) {
          await load(root)
          if (main?.isConnected && root.contains(main)) root.querySelector('.work-main h1')?.focus()
        }
      } catch (e) {
        if (!form.isConnected || !main?.isConnected || !root.contains(main)) return
        err.innerHTML = `<div class="notice notice-error" role="alert">${esc(e?.message || 'No se pudo registrar.')}</div>`
        btn.disabled = false
        cancel.disabled = false
      }
    })
  })
  main.querySelector('[data-search]').addEventListener('submit', ev => {
    ev.preventDefault()
    const formData = new FormData(ev.currentTarget)
    load(root, String(formData.get('q') || '').trim(), String(formData.get('status') || ''), 1)
  })

  try {
    const qs = new URLSearchParams({ page: String(page), pageSize: '50' })
    if (q) qs.set('q', q)
    if (status) qs.set('status', status)
    const { data, meta } = await get('/loan-devices?' + qs)
    if (!isCurrent()) return
    const total = Number(meta?.total ?? data?.length ?? 0)
    const statusText = status ? `Filtro aplicado: ${total} ${total === 1 ? 'equipo' : 'equipos'}.` : `${total} ${total === 1 ? 'equipo' : 'equipos'} en la flota.`
    const listStatus = main.querySelector('[data-list-status]')
    if (listStatus) listStatus.textContent = q ? `Búsqueda completada. ${statusText}` : statusText
    main.querySelector('[data-list]')?.setAttribute('aria-busy', 'false')
    const emptyMessage = q || status
      ? 'No hay equipos que coincidan con el filtro.'
      : 'Flota vacía: registra el primer equipo.'
    main.querySelector('[data-list]').innerHTML = `
        ${fleetDock(data || [])}
      <div class="table-wrap" tabindex="0" role="region" aria-label="Tabla de equipos de préstamo"><table>
        <thead><tr><th scope="col">Equipo</th><th scope="col">Etiqueta / IMEI / serie</th><th scope="col">Estado</th><th scope="col">Asignado a</th><th scope="col">Localizador</th></tr></thead>
        <tbody>${(data || []).map(d => {
          const out = d.status === 'loaned' && d.active_loan
          const statusText = d.status === 'available'
            ? 'Disponible en mostrador'
            : d.status === 'loaned'
              ? 'Entregado a cliente'
              : d.status === 'retired'
                ? 'Retirado'
                : d.status || 'Desconocido'
          const statusClass = d.status === 'available' ? 'pill-ready' : d.status === 'loaned' ? 'pill-repairing' : 'pill-neutral'
          return `<tr>
            <td>${esc(d.brand)} ${esc(d.model)}</td>
            <td class="mono">${esc(d.asset_tag || '—')}</td>
            <td><span class="pill ${statusClass}">${esc(statusText)}</span></td>
            <td>${out && d.active_loan.case_number ? `<a href="#/cases/${esc(d.active_loan.case_id)}" class="mono">${esc(d.active_loan.case_number)}</a>` : '—'}</td>
            <td>${loanLocatorButton(d)}</td>
          </tr>`}).join('') || `<tr><td colspan="5" style="color:var(--ink-mute)">${emptyMessage}</td></tr>`}
        </tbody></table></div>
        ${pagination(meta, page)}`
    bindPagination(main, nextPage => load(root, q, status, nextPage))
    bindFleetMotion(root, main)
    loanLocator.set(root, bindLoanLocator(main, data || [], { gsap }))
    if (filterFocus) main.querySelector(filterFocus)?.focus()
  } catch (e) {
    if (!isCurrent()) return
    const listStatus = main.querySelector('[data-list-status]')
    if (listStatus) listStatus.textContent = 'No se pudo cargar la flota.'
    main.querySelector('[data-list]')?.setAttribute('aria-busy', 'false')
    main.querySelector('[data-list]').innerHTML = `<div class="notice notice-error" role="alert">${esc(e?.message || 'No se pudo cargar la flota.')}</div>`
  }
}

function pagination(meta, requestedPage) {
  if (!meta) return ''
  const page = Number(meta.page) || requestedPage
  const pageSize = Number(meta.pageSize) || 50
  const total = Number(meta.total) || 0
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = total ? (page - 1) * pageSize + 1 : 0
  const last = Math.min(page * pageSize, total)
  return `<nav class="row" aria-label="Paginación de equipos de préstamo" style="justify-content:space-between;gap:.75rem;align-items:center;margin-top:.8rem">
    <p data-page-status tabindex="-1" aria-live="polite" style="color:var(--ink-mute);margin:0">${first}–${last} de ${total} · página ${page} de ${pages}</p>
    <div class="row" style="gap:.5rem"><button class="btn btn-ghost" type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Página anterior de equipos de préstamo">← Anterior</button>
    <button class="btn btn-ghost" type="button" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Página siguiente de equipos de préstamo">Siguiente →</button></div>
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
