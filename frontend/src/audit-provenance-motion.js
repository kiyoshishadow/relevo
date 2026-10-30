import gsap from 'gsap'

const reduceQuery = '(prefers-reduced-motion: reduce)'

/** Decorative, per-event provenance trace. Source content stays native and visible. */
export function createAuditProvenanceMotion(main) {
  if (!main) return { dispose() {} }

  const media = window.matchMedia(reduceQuery)
  const frames = new Map()
  const active = new Map()
  const tweens = new Map()
  const observers = new Map()
  let disposed = false

  const removeTrace = details => {
    const tween = tweens.get(details)
    tween?.kill()
    tweens.delete(details)
    const frame = frames.get(details)
    if (frame != null) cancelAnimationFrame(frame)
    frames.delete(details)
    observers.get(details)?.disconnect()
    observers.delete(details)
    active.get(details)?.remove()
    active.delete(details)
    details.querySelector('.audit-provenance-trace')?.remove()
    details.removeAttribute('data-provenance-active')
  }

  const buildPath = (svg, body) => {
    const facts = [...body.querySelectorAll('[data-audit-station]')]
    const end = body.querySelector('[data-audit-provenance-end]')
    if (facts.length !== 4 || !end) return null
    const box = body.getBoundingClientRect()
    const width = Math.max(1, body.clientWidth)
    const height = Math.max(body.scrollHeight, body.clientHeight)
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))

    // Anchors sit in the existing inner gutter, leaving every label and value untouched.
    const pointFor = (element, x) => {
      const rect = element.getBoundingClientRect()
      return { x, y: rect.top - box.top + rect.height / 2 }
    }
    const narrow = window.matchMedia('(max-width: 760px)').matches
    const points = facts.map(el => {
      if (narrow) return pointFor(el, 7)
      const rect = el.getBoundingClientRect()
      // Run through the whitespace above each grid cell, never through its label/value.
      return { x: rect.left - box.left + rect.width / 2, y: rect.top - box.top - 6 }
    })
    const endRect = end.getBoundingClientRect()
    points.push(narrow
      ? pointFor(end, 7)
      : { x: 7, y: endRect.top - box.top - 5 })

    const d = points.map((point, index) => {
      if (index === 0) return `M ${point.x} ${point.y}`
      const previous = points[index - 1]
      const midX = (previous.x + point.x) / 2
      return `C ${midX} ${previous.y}, ${midX} ${point.y}, ${point.x} ${point.y}`
    }).join(' ')
    const path = svg.querySelector('path')
    path.setAttribute('d', d)
    svg.querySelectorAll('circle').forEach((circle, index) => {
      circle.setAttribute('cx', String(points[index].x))
      circle.setAttribute('cy', String(points[index].y))
    })
    return path
  }

  const draw = (details, animate) => {
    if (disposed || !details.open || !details.isConnected) return
    removeTrace(details)
    details.setAttribute('data-provenance-active', '')
    const body = details.querySelector('.audit-body')
    if (!body) return
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.classList.add('audit-provenance-trace')
    svg.setAttribute('viewBox', '0 0 1 1')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    svg.innerHTML = '<path></path><circle r="3"></circle><circle r="3"></circle><circle r="3"></circle><circle r="3"></circle><circle class="audit-provenance-terminal" r="2.2"></circle>'
    body.prepend(svg)
    const path = buildPath(svg, body)
    if (!path) {
      svg.remove()
      details.removeAttribute('data-provenance-active')
      return
    }
    active.set(details, svg)
    const length = path.getTotalLength()
    path.style.strokeDasharray = `${length}`
    path.style.strokeDashoffset = animate && !media.matches ? `${length}` : '0'
    svg.querySelectorAll('circle').forEach(circle => {
      circle.style.opacity = animate && !media.matches ? '0' : '1'
      circle.style.transform = animate && !media.matches ? 'scale(0)' : ''
    })
    if (animate && !media.matches) {
      const nodes = [...svg.querySelectorAll('circle')]
      const tween = gsap.timeline({ onComplete: () => {
        const finalPath = svg.querySelector('path')
        if (finalPath) finalPath.style.strokeDasharray = `${finalPath.getTotalLength()}`
        tweens.delete(details)
      } })
        .to(path, { strokeDashoffset: 0, duration: 0.52, ease: 'power2.out' }, 0)
        .to(nodes, { opacity: 1, scale: 1, transformOrigin: 'center', duration: 0.16, stagger: 0.09, ease: 'back.out(1.8)' }, 0.16)
      tweens.set(details, tween)
    }
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        if (disposed || !details.open || active.get(details) !== svg) return
        const resizedPath = buildPath(svg, body)
        if (!resizedPath || tweens.has(details)) return
        const resizedLength = resizedPath.getTotalLength()
        resizedPath.style.strokeDasharray = `${resizedLength}`
        resizedPath.style.strokeDashoffset = '0'
      })
      observers.set(details, observer)
      observer.observe(body)
      body.querySelectorAll('[data-audit-station], [data-audit-provenance-end]').forEach(element => observer.observe(element))
    }
  }

  const onClick = event => {
    const summary = event.target.closest?.('.audit-event > summary')
    if (!summary || !main.contains(summary)) return
    const details = summary.parentElement
    const previous = frames.get(details)
    if (previous != null) cancelAnimationFrame(previous)
    const frame = requestAnimationFrame(() => {
      frames.delete(details)
      if (details.open) draw(details, true)
      else removeTrace(details)
    })
    frames.set(details, frame)
  }

  const onMotionChange = () => {
    if (disposed) return
    for (const details of active.keys()) {
      tweens.get(details)?.kill()
      tweens.delete(details)
      const path = details.querySelector('.audit-provenance-trace path')
      if (path) {
        const length = path.getTotalLength()
        path.style.strokeDasharray = `${length}`
        path.style.strokeDashoffset = '0'
      }
      details.querySelectorAll('.audit-provenance-trace circle').forEach(circle => {
        circle.style.opacity = '1'
        circle.style.transform = ''
      })
    }
  }

  main.addEventListener('click', onClick)
  media.addEventListener?.('change', onMotionChange)
  if (!media.addEventListener) media.addListener?.(onMotionChange)

  const clear = () => {
    for (const details of new Set([...active.keys(), ...tweens.keys(), ...frames.keys(), ...observers.keys()])) removeTrace(details)
    active.clear()
    tweens.clear()
    frames.clear()
    observers.clear()
  }

  return {
    clear,
    dispose() {
      if (disposed) return
      disposed = true
      main.removeEventListener('click', onClick)
      media.removeEventListener?.('change', onMotionChange)
      if (!media.removeEventListener) media.removeListener?.(onMotionChange)
      clear()
    },
  }
}
