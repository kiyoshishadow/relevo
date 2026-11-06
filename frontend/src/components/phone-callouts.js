// Screen-space technical annotations; the renderer supplies projected anchors.
// No extra render loop, canvas, pointer handlers or GPU resources.
export function mountPhoneCallouts(host) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.classList.add('phone-callouts')
  svg.setAttribute('aria-hidden', 'true')
  const reticle = document.createElementNS(ns, 'path')
  reticle.classList.add('phone-callouts__reticle')
  svg.append(reticle)
  const parts = [
    { index: 1, name: 'PANTALLA', code: '01', side: 1, row: .29 },
    { index: 2, name: 'BATERÍA', code: '02', side: -1, row: .72 },
    { index: 3, name: 'PLACA', code: '03', side: -1, row: .23 },
  ].map(part => {
    const group = document.createElementNS(ns, 'g')
    const path = document.createElementNS(ns, 'path')
    const dot = document.createElementNS(ns, 'circle')
    const text = document.createElementNS(ns, 'text')
    dot.setAttribute('r', '3')
    text.textContent = `${part.code} / ${part.name}`
    group.append(path, dot, text)
    svg.append(group)
    return { ...part, group, path, dot, text }
  })
  host.append(svg)
  return {
    update({ width, height, assembled, focused, anchors, focusBounds }) {
      svg.style.opacity = assembled ? '0' : '1'
      if (assembled || !width || !height) return
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
      reticle.style.display = focusBounds && focused !== null ? '' : 'none'
      if (focusBounds && focused !== null) {
        const { left, right, top, bottom } = focusBounds
        const x1 = Math.max(8, left - 10), x2 = Math.min(width - 8, right + 10)
        const y1 = Math.max(30, top - 10), y2 = Math.min(height - 12, bottom + 10)
        const arm = Math.min(16, (x2 - x1) / 4, (y2 - y1) / 4)
        reticle.setAttribute('d', `M${x1} ${y1+arm}V${y1}H${x1+arm} M${x2-arm} ${y1}H${x2}V${y1+arm} M${x2} ${y2-arm}V${y2}H${x2-arm} M${x1+arm} ${y2}H${x1}V${y2-arm}`)
      }
      parts.forEach(part => {
        const point = anchors[part.index]
        const visible = point && point.z > -1 && point.z < 1 && (width >= 420 || focused === null || focused === part.index)
        part.group.style.display = visible ? '' : 'none'
        if (!visible) return
        const right = part.side === 1
        const x = right ? width - 14 : 14
        const y = Math.max(40, Math.min(height - 32, height * part.row))
        const end = right ? x - 95 : x + 95
        const px = Math.max(10, Math.min(width - 10, (point.x + 1) * width / 2))
        const py = Math.max(10, Math.min(height - 10, (1 - point.y) * height / 2))
        part.group.classList.toggle('is-active', focused === part.index)
        part.group.classList.toggle('is-muted', focused !== null && focused !== part.index)
        part.text.setAttribute('x', x)
        part.text.setAttribute('y', y - 8)
        part.text.setAttribute('text-anchor', right ? 'end' : 'start')
        part.path.setAttribute('d', `M ${x} ${y} H ${end} L ${px} ${py}`)
        part.dot.setAttribute('cx', px)
        part.dot.setAttribute('cy', py)
      })
    },
    dispose() { svg.remove() },
  }
}
