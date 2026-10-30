import gsap from 'gsap'
import { reportParams } from './report-format.js'

export function unlockReportControlsThenRefresh(controls, refresh) {
  controls.forEach(control => { control.disabled = false })
  refresh?.()
}

export function createReportPassportModel({ paramsFor = reportParams } = {}) {
  let lastDisplayed = null
  let disposed = false

  return {
    capture(entry, values, filterLabels = {}) {
      const params = paramsFor(entry, values)
      const filters = [...params].map(([key, value]) => ({ key, label: filterLabels[key] || key, value }))
      return {
        slug: String(entry?.slug || ''),
        name: String(entry?.name || 'Sin consulta seleccionada'),
        params,
        filters,
        signature: JSON.stringify([String(entry?.slug || ''), params.toString()]),
      }
    },
    status(draft) {
      if (!lastDisplayed) return 'Sin generar'
      return draft?.signature === lastDisplayed.signature ? 'Coincide con el último resultado' : 'Cambios sin generar'
    },
    lastDisplayed() { return lastDisplayed },
    commitScreen(snapshot) {
      if (disposed) return false
      lastDisplayed = snapshot
      return true
    },
    clearDisplayed() {
      if (!disposed) lastDisplayed = null
    },
    isActive() { return !disposed },
    dispose() {
      disposed = true
      lastDisplayed = null
    },
  }
}

export function createReportConnectionMotion({ getConnector, gsapApi = gsap, mediaQuery, isActive = () => true } = {}) {
  const query = mediaQuery || (typeof window !== 'undefined'
    ? window.matchMedia?.('(prefers-reduced-motion: reduce)')
    : null)
  let reduced = Boolean(query?.matches)
  let tween = null
  let connector = null
  let hasSuccessfulScreenResult = false
  let disposed = false

  const connected = node => Boolean(node && node.isConnected !== false)
  const setVisible = visible => {
    if (disposed || !connected(connector) || !isActive()) return
    const vars = { opacity: visible ? 1 : 0, scaleY: visible ? 1 : 0.04, transformOrigin: 'top center' }
    if (gsapApi?.set) gsapApi.set(connector, vars)
    else {
      connector.style.opacity = String(vars.opacity)
      connector.style.transform = `scaleY(${vars.scaleY})`
      connector.style.transformOrigin = vars.transformOrigin
    }
  }
  const settle = visible => {
    tween?.kill?.()
    tween = null
    setVisible(visible)
  }
  const onMotionChange = event => {
    reduced = Boolean(event.matches)
    if (reduced && hasSuccessfulScreenResult) settle(true)
  }
  query?.addEventListener?.('change', onMotionChange)
  if (query && !query.addEventListener) query.addListener?.(onMotionChange)

  return {
    connect() {
      if (disposed || !isActive()) return
      connector = getConnector?.()
      if (!connected(connector)) return
      hasSuccessfulScreenResult = true
      tween?.kill?.()
      tween = null
      if (reduced || !gsapApi?.fromTo) {
        setVisible(true)
        return
      }
      tween = gsapApi.fromTo(connector,
        { opacity: 0, scaleY: 0.04, transformOrigin: 'top center' },
        { opacity: 1, scaleY: 1, transformOrigin: 'top center', duration: 0.18, ease: 'power2.out', overwrite: true },
      )
    },
    cancel() {
      if (disposed) return
      if (hasSuccessfulScreenResult && connector && connected(connector) && isActive()) settle(true)
      else { tween?.kill?.(); tween = null }
    },
    clear() {
      if (disposed) return
      hasSuccessfulScreenResult = false
      settle(false)
    },
    dispose() {
      if (disposed) return
      disposed = true
      tween?.kill?.()
      tween = null
      hasSuccessfulScreenResult = false
      query?.removeEventListener?.('change', onMotionChange)
      if (query && !query.removeEventListener) query.removeListener?.(onMotionChange)
      connector = null
    },
  }
}
