import { gsap } from 'gsap'

let activeTimeline = null
let activeOverlay = null
let activeListeners = null

const internalModule = path => {
  const first = path.split('/').filter(Boolean)[0]
  return first && !['portal', 'track', 'login'].includes(first) ? first : null
}

const validRect = rect => rect && rect.width > 0 && rect.height > 0 &&
  [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)

export function cancelRouteStation() {
  activeTimeline?.kill()
  activeTimeline = null
  activeOverlay?.remove()
  activeOverlay = null
  if (activeListeners) {
    window.removeEventListener('resize', activeListeners.cancel)
    window.removeEventListener('scroll', activeListeners.cancel, true)
    activeListeners.media?.removeEventListener?.('change', activeListeners.cancel)
    activeListeners = null
  }
}

export function captureRouteStation(root, targetPath) {
  cancelRouteStation()
  try {
    const targetModule = internalModule(targetPath)
    const sourceMain = root?.querySelector('.work-main')
    const sourceLink = root?.querySelector('.work-rail .rail-link[aria-current="page"]')
    const sourceModule = sourceLink?.getAttribute('href')?.replace(/^#/, '').split('/').filter(Boolean)[0]
    const sourceRect = sourceLink?.getBoundingClientRect()
    if (!targetModule || !sourceMain || !sourceLink || !sourceModule || sourceModule === targetModule || !validRect(sourceRect)) return null
    return { sourceRect: { left: sourceRect.left, top: sourceRect.top, right: sourceRect.right, bottom: sourceRect.bottom, width: sourceRect.width, height: sourceRect.height } }
  } catch {
    return null
  }
}

function createOverlay(mainRect, sourceRect, targetRect, mobile) {
  const ns = 'http://www.w3.org/2000/svg'
  const overlay = document.createElement('div')
  overlay.className = 'route-station-overlay'
  overlay.setAttribute('aria-hidden', 'true')
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.classList.add('route-station-overlay__svg')
  const x = mainRect.left + 12
  const y = mainRect.top + 12
  const right = mainRect.right - 12
  const bottom = mainRect.bottom - 12
  const corners = []
  const horizontalVisible = x >= 0 && right <= window.innerWidth
  const topVisible = horizontalVisible && y >= 0 && y + 16 <= window.innerHeight
  const bottomVisible = horizontalVisible && bottom <= window.innerHeight - 16
  if (topVisible) {
    corners.push(`M${x + 16} ${y} H${x} V${y + 16}`)
    corners.push(`M${right - 16} ${y} H${right} V${y + 16}`)
  }
  if (bottomVisible) {
    corners.push(`M${x} ${bottom - 16} V${bottom} H${x + 16}`)
    corners.push(`M${right - 16} ${bottom} H${right} V${bottom - 16}`)
  }
  const marks = corners.map(d => {
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', d)
    path.classList.add('route-station-overlay__corner')
    svg.append(path)
    return path
  })
  const trace = document.createElementNS(ns, 'path')
  const traceRoom = Math.max(0, right - x - 32)
  const traceWidth = Math.min(56, traceRoom)
  const traceStart = x + 16 + (traceRoom - traceWidth) / 2
  trace.setAttribute('d', `M${traceStart} ${y} H${traceStart + traceWidth}`)
  trace.setAttribute('pathLength', '1')
  trace.classList.add('route-station-overlay__trace')
  svg.append(trace)
  const cursor = document.createElement('span')
  cursor.className = 'route-station-cursor'
  const startX = mobile ? targetRect.left - 10 : sourceRect.left + sourceRect.width / 2
  const startY = mobile ? targetRect.top + targetRect.height / 2 : sourceRect.top + sourceRect.height / 2
  const endX = mobile ? targetRect.left + Math.min(14, targetRect.width / 3) : targetRect.left + targetRect.width / 2
  const endY = targetRect.top + targetRect.height / 2
  cursor.style.left = `${startX}px`
  cursor.style.top = `${startY}px`
  overlay.append(svg, cursor)
  document.body.append(overlay)
  return { overlay, cursor, marks, trace, startX, startY, endX, endY }
}

export function playRouteStation(stage, capture, sequence, isCurrent) {
  cancelRouteStation()
  try {
    const main = stage?.querySelector('.work-main')
    const targetLink = stage?.querySelector('.work-rail .rail-link[aria-current="page"]')
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const mainRect = main?.getBoundingClientRect()
    const targetRect = targetLink?.getBoundingClientRect()
    if (!main || !targetLink || !validRect(mainRect) || !validRect(targetRect) ||
      media?.matches || !stage.isConnected || !isCurrent()) return false

    const visibleMainRect = mainRect && {
      left: Math.max(0, mainRect.left),
      top: Math.max(0, mainRect.top),
      right: Math.min(window.innerWidth, mainRect.right),
      bottom: Math.min(window.innerHeight, mainRect.bottom),
    }
    if (visibleMainRect) {
      visibleMainRect.width = visibleMainRect.right - visibleMainRect.left
      visibleMainRect.height = visibleMainRect.bottom - visibleMainRect.top
    }
    if (!validRect(visibleMainRect)) return false

    const mobile = window.matchMedia?.('(max-width: 600px)').matches
    const origin = mobile ? targetRect : capture.sourceRect
    if (!validRect(origin)) return false
    const elements = createOverlay(visibleMainRect, origin, targetRect, mobile)
    activeOverlay = elements.overlay
    const cancel = () => cancelRouteStation()
    activeListeners = { cancel, media }
    window.addEventListener('resize', cancel, { once: true })
    window.addEventListener('scroll', cancel, { once: true, capture: true })
    media?.addEventListener?.('change', cancel, { once: true })

    const timeline = gsap.timeline({
      onComplete: () => {
        if (sequence !== Number(stage.dataset.routeView) || !stage.isConnected || !isCurrent()) return cancelRouteStation()
        cancelRouteStation()
      },
    })
    activeTimeline = timeline
    gsap.set(elements.marks, { transformOrigin: 'center', scale: 0.72, opacity: 0 })
    gsap.set(elements.trace, { strokeDasharray: 1, strokeDashoffset: 1, opacity: 1 })
    gsap.set(elements.cursor, { x: -5, y: -5, opacity: 1 })
    timeline.to(elements.cursor, {
      x: elements.endX - elements.startX - 5,
      y: elements.endY - elements.startY - 5,
      duration: mobile ? 0.12 : 0.24,
      ease: 'power3.inOut',
    }, 0)
    timeline.to(elements.marks, { scale: 1, opacity: 1, duration: 0.32, ease: 'power3.inOut' }, 0)
    timeline.to(elements.trace, { strokeDashoffset: 0, duration: 0.12, ease: 'power3.inOut' }, 0)
    timeline.to(elements.cursor, { opacity: 0, duration: 0.06 }, mobile ? 0.12 : 0.24)
    return true
  } catch {
    cancelRouteStation()
    return false
  }
}
