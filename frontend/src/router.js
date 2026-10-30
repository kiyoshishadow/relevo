// Enrutador hash mínimo: cada vista es async (root, params, ...args).
import { captureRouteStation, playRouteStation, cancelRouteStation } from './route-station-motion.js'

const routes = [] // {segs, fn}
const viewCleanups = new Set()
let renderSequence = 0
let pendingFocusHeading = false
let focusIntentSequence = 0
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', event => {
    if (event.target && event.target !== document.body && event.target !== document.documentElement) {
      focusIntentSequence += 1
    }
  })
}

export function registerView(pattern, fn) {
  routes.push({ segs: pattern.split('/').filter(Boolean), fn })
}

export function onLeave(fn) {
  if (typeof fn === 'function') viewCleanups.add(fn)
}

function runViewCleanups() {
  const cleanups = [...viewCleanups]
  viewCleanups.clear()
  for (const cleanup of cleanups) {
    try { cleanup() } catch {}
  }
}

function focusHeading(stage) {
  const heading = stage.querySelector('h1')
  if (!heading) return false
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
  heading.focus({ preventScroll: true })
  return true
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/'
  const [path, query] = raw.split('?')
  return { path: path || '/', params: new URLSearchParams(query || '') }
}

export function navigate(path) {
  const hash = path.startsWith('#') ? path : '#' + path
  if (location.hash === hash) render()
  else location.hash = hash
}

export async function render(root = document.getElementById('app')) {
  const sequence = ++renderSequence
  const focusIntentAtStart = focusIntentSequence
  // Capture the outgoing station before its connected stage is replaced.
  const routeStation = captureRouteStation(root, parseHash().path)
  const focused = document.activeElement
  let shouldFocusHeading = pendingFocusHeading
  if (focused && root.contains(focused)) {
    try { shouldFocusHeading ||= focused.matches(':focus-visible') } catch {}
  }
  if (shouldFocusHeading) pendingFocusHeading = true

  // A new navigation leaves the current view immediately. Its cleanup runs
  // while the view is still connected, before its DOM is replaced.
  runViewCleanups()

  const stage = document.createElement('div')
  stage.dataset.routeView = String(sequence)
  stage.setAttribute('aria-busy', 'true')
  stage.innerHTML = '<div class="page"><div class="skel" role="status" aria-live="polite">Cargando vista…</div></div>'
  root.replaceChildren(stage)

  const { path, params } = parseHash()
  const segs = path.split('/').filter(Boolean)

  for (const { segs: pat, fn } of routes) {
    if (pat.length !== segs.length) continue
    const args = []
    const ok = pat.every((seg, i) => {
      if (seg.startsWith(':')) { args.push(segs[i]); return true }
      return seg === segs[i]
    })
    if (!ok) continue
    let viewFailed = false
    try {
      // Each route owns a connected stage. If a newer navigation starts while
      // this view awaits data, its stage is detached and can no longer replace
      // the current screen when it eventually finishes.
      await fn(stage, params, ...args)
    } catch {
      viewFailed = true
      if (sequence === renderSequence) {
        stage.innerHTML = '<div class="page"><h1>Error al abrir la vista</h1><div class="notice notice-error" role="alert">No se pudo mostrar esta vista. Intenta navegar de nuevo.</div></div>'
      }
    }
    if (sequence !== renderSequence || !stage.isConnected) return

    stage.removeAttribute('aria-busy')
    const view = stage.querySelector('.work-main, .page') || stage.firstElementChild
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let stationPlayed = false
    if (routeStation && !viewFailed) {
      try { stationPlayed = playRouteStation(stage, routeStation, sequence, () => sequence === renderSequence) }
      catch { cancelRouteStation() }
    }
    if (!reduced && !viewFailed && !stationPlayed) view?.classList.add('view-enter')

    // Move focus only when the outgoing focus was visibly keyboard-driven.
    // Pointer navigation and initial page load keep their natural focus.
    if (sequence === renderSequence) {
      if (focusIntentSequence === focusIntentAtStart && shouldFocusHeading) focusHeading(stage)
      pendingFocusHeading = false
    }
    return
  }
  if (sequence !== renderSequence || !stage.isConnected) return
  stage.removeAttribute('aria-busy')
  stage.innerHTML = `<div class="page"><h1>Página no encontrada</h1><div class="notice notice-info">Esta dirección no existe. <a href="#/">Volver al inicio</a></div></div>`
  cancelRouteStation()
  if (sequence === renderSequence) {
    if (focusIntentSequence === focusIntentAtStart && shouldFocusHeading) focusHeading(stage)
    pendingFocusHeading = false
  }
}
