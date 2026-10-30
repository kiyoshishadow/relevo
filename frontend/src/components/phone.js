// Teléfono vertical en capas: Three.js es opcional y se monta bajo demanda.
// El SVG del portal siempre queda como fallback accesible.
import gsap from 'gsap'
import { esc } from '../util.js'

const LAYERS = [
  { key: 'frame', name: 'Chasis', note: 'aluminio mecanizado' },
  { key: 'display', name: 'Pantalla', note: 'vidrio y panel táctil' },
  { key: 'battery', name: 'Batería', note: 'celda y conexión' },
  { key: 'board', name: 'Placa', note: 'componentes de diagnóstico' },
]
const SVG_SPREAD = [
  { x: -34, y: -8, rotation: -6 },
  { x: 34, y: -4, rotation: 5 },
  { x: -25, y: 7, rotation: -4 },
  { x: 25, y: 12, rotation: 6 },
]

// Rear exterior uses the very same camera coordinates as the 3D scene. The
// four explorable layers below remain a shared repair schematic, not a teardown.
function profileSvgHtml(id, profile) {
  const exact = profile.exact === true && !!profile.cameraGeometry
  const geometry = exact ? profile.cameraGeometry : {
    housing: 'illustrative', center: [.49, 1.4], island: [.84, 1.54], radius: .14,
    lenses: [[.66, 1.75, .14], [.28, 1.75, .14], [.66, 1.37, .14]],
  }
  const n = value => Math.round(value * 100) / 100
  const x = value => n(170 - value * 91.5)
  const y = value => n(245 - value * 91.5)
  const size = value => n(value * 91.5)
  const color = (value, fallback) => Number.isInteger(value) && value >= 0 && value <= 0xffffff
    ? `#${value.toString(16).padStart(6, '0')}` : fallback
  const body = color(profile.body, '#747a79')
  const back = color(profile.back, '#9ea19a')
  const accent = color(profile.accent, '#d7d9d3')
  const sx = exact ? n(profile.dimensionsMm.width / 71.5) : 1
  const sy = exact ? n(profile.dimensionsMm.height / 146.7) : 1
  const radius = size(exact ? profile.frameRadius : .23)
  const name = exact ? `${profile.brand} ${profile.model}` : 'Teléfono ilustrativo'
  const plate = (center, dimensions, round, fill, attrs = '') => `<rect ${attrs} x="${x(center[0] + dimensions[0] / 2)}" y="${y(center[1] + dimensions[1] / 2)}" width="${size(dimensions[0])}" height="${size(dimensions[1])}" rx="${size(round)}" fill="${fill}" stroke="${accent}" stroke-width="1"/>`
  // The metal bridge renders as a shallow raised bar with fully rounded ends,
  // matching the extruded 3D cover; flat housings keep their catalog radius.
  const bridge = geometry.housing === 'metal-bridge'
  const barRadius = bridge ? Math.min(geometry.island[1] / 2, .235) : geometry.radius
  // A raised bar catches light along its top edge and shades at its base; the
  // pill window reads recessed thanks to a dark seam at its top rim. Both trim
  // bands only span the straight section of the stadium silhouette.
  const trim = (cx, cy, w, h, fill, opacity) =>
    `<rect x="${x(cx + w / 2)}" y="${y(cy + h / 2)}" width="${size(w)}" height="${size(h)}" rx="${size(h / 2)}" fill="${fill}" opacity="${opacity}"/>`
  const barTrim = bridge ? (() => {
    const [cx, cy] = geometry.center
    const [bw, bh] = geometry.island
    const w = bw - barRadius * 2 - .04
    return trim(cx, cy + bh / 2 - .012, w, .024, '#ffffff', '.38') +
      trim(cx, cy - bh / 2 + .013, w, .026, '#0a1112', '.32')
  })() : ''
  const windowShade = bridge && geometry.window ? (() => {
    const [cx, cy] = geometry.window.center
    const [ww, wh] = geometry.window.size
    const w = ww - .12
    return trim(cx, cy + wh / 2 - .013, w, .026, '#000000', '.55') +
      trim(cx, cy - wh / 2 + .01, w, .02, '#ffffff', '.18')
  })() : ''
  const housing = geometry.housing === 'separate-rings' ? '' : plate(
    geometry.center, geometry.island, barRadius,
    bridge ? `url(#${id}-rim)` : back,
    'data-camera-housing',
  )
  const bridgeBase = geometry.bridgeBase
    ? plate(geometry.center, geometry.bridgeBase, geometry.radius + .035, '#343c3a', 'data-camera-bridge-base') : ''
  const window = geometry.window ? plate(geometry.window.center, geometry.window.size, geometry.window.radius, '#10191e', 'data-camera-window') : ''
  const lenses = geometry.lenses.map(([cx, cy, r]) => `<g data-camera-lens transform="translate(${x(cx)} ${y(cy)})"><circle r="${size(r) + 2}" fill="url(#${id}-rim)"/><circle r="${size(r)}" fill="#111c25" stroke="#5f747b" stroke-width="1"/><circle r="${size(r * .66)}" fill="url(#${id}-lens)"/><circle cx="${size(-r * .24)}" cy="${size(-r * .25)}" r="${size(r * .2)}" fill="#bddeeb" opacity=".75"/><path d="M${size(-r * .45)} ${size(r * .42)}q${size(r * .45)} ${size(r * .24)} ${size(r * .84)} 0" fill="none" stroke="#769aaa" stroke-width=".7"/></g>`).join('')
  const flash = geometry.flash ? `<circle data-camera-flash cx="${x(geometry.flash[0])}" cy="${y(geometry.flash[1])}" r="${size(geometry.flash[2])}" fill="#fff0cf" stroke="${accent}" stroke-width="2"/>` : ''
  return `<svg id="${id}" class="phone-svg" viewBox="0 0 360 520" role="img" aria-label="${esc(name)}: vista posterior simplificada y capas internas esquemáticas" focusable="false" data-exterior-profile="${exact ? esc(profile.model) : 'illustrative'}" data-camera-style="${exact ? esc(profile.camera) : 'generic-triple'}">
    <defs>
      <linearGradient id="${id}-rim" x1="0" y1="0" x2="1" y2=".8"><stop stop-color="${accent}"/><stop offset=".35" stop-color="#f0f2ef"/><stop offset=".55" stop-color="${body}"/><stop offset="1" stop-color="${accent}"/></linearGradient>
      <linearGradient id="${id}-back" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${accent}"/><stop offset=".28" stop-color="${back}"/><stop offset="1" stop-color="${body}"/></linearGradient>
      <radialGradient id="${id}-lens"><stop stop-color="#11181f"/><stop offset=".42" stop-color="#1b3b4c"/><stop offset=".7" stop-color="#142329"/><stop offset="1" stop-color="#34546a"/></radialGradient>
    </defs>
    <g class="phone-fallback" transform="translate(170 245) scale(${sx} ${sy}) translate(-170 -245)">
      <rect x="80" y="55" width="194" height="398" rx="${radius}" fill="#071619" opacity=".45"/>
      <g class="phone-layer phone-chassis" data-layer="0" style="opacity:1"><rect x="73" y="46" width="194" height="398" rx="${radius}" fill="url(#${id}-rim)" stroke="${accent}" stroke-width="2"/><rect x="79" y="52" width="182" height="386" rx="${Math.max(2, radius - 5)}" fill="#213135"/><path d="M160 437h20" stroke="${accent}" stroke-width="3" stroke-linecap="round"/></g>
      <g class="phone-layer" data-layer="1" style="opacity:1"><rect data-device-back x="77" y="50" width="186" height="390" rx="${Math.max(2, radius - 3)}" fill="url(#${id}-back)" stroke="${accent}" stroke-width="1"/><path d="M${83 + radius} 54h${166 - radius * 2}" stroke="#fff" stroke-opacity=".45" stroke-linecap="round"/><g data-camera-module data-camera-housing-kind="${geometry.housing}">${bridgeBase}${housing}${barTrim}${window}${windowShade}${lenses}${flash}</g></g>
      <g class="phone-layer" data-layer="2" style="opacity:0"><rect x="105" y="190" width="130" height="190" rx="12" fill="#283d40" stroke="#b9c5c1" stroke-width="2"/><path d="M122 211h96M122 226h96M122 352h96" stroke="#879e9d" stroke-width="2"/><rect x="148" y="177" width="43" height="13" rx="3" fill="#c0afa0"/><text x="170" y="285" text-anchor="middle" fill="#e5ebe6" font-size="10">Batería</text><text x="170" y="302" text-anchor="middle" fill="#afc0bc" font-size="8">Esquema compartido</text></g>
      <g class="phone-layer" data-layer="3" style="opacity:0"><path d="M98 71h144v90h-42v53H98z" fill="#24463e" stroke="#a8bca9" stroke-width="2"/><rect x="113" y="89" width="48" height="44" rx="4" fill="#14292e" stroke="#c4c7d1"/><rect x="179" y="88" width="46" height="55" rx="4" fill="#33424b" stroke="#b4a4c9"/><path d="M116 151h69v40M128 162h42v26" fill="none" stroke="#cbb275" stroke-width="2"/><g fill="#cfb879"><circle cx="113" cy="200" r="3"/><circle cx="127" cy="200" r="3"/><circle cx="141" cy="200" r="3"/></g></g>
    </g></svg>`
}

export function phoneSvgHtml({ id = 'phone-hero', profile } = {}) {
  id = esc(id)
  if (profile) return profileSvgHtml(id, profile)
  return `<svg id="${id}" class="phone-svg" viewBox="0 0 360 520" role="img" aria-label="Teléfono Relevo con chasis, pantalla, batería y placa lógica" focusable="false">
    <defs>
      <linearGradient id="${id}-metal" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#8aa39d"/><stop offset=".22" stop-color="#29464a"/><stop offset=".8" stop-color="#132c31"/><stop offset="1" stop-color="#e7b94a"/></linearGradient>
      <linearGradient id="${id}-glass" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#34565c"/><stop offset="1" stop-color="#10282e"/></linearGradient>
    </defs>
    <g id="${id}-fallback" class="phone-fallback">
      <rect x="83" y="24" width="194" height="438" rx="34" fill="#071619" opacity=".62" transform="translate(8 12)"/>
      <rect x="73" y="16" width="194" height="438" rx="34" fill="url(#${id}-metal)" stroke="#c3d2cd" stroke-opacity=".48" stroke-width="2"/>
      <rect x="81" y="24" width="178" height="422" rx="27" fill="#091b1f"/>
      <g class="phone-layer phone-chassis" data-layer="0"><rect x="73" y="16" width="194" height="438" rx="34" fill="url(#${id}-metal)" stroke="#c3d2cd" stroke-opacity=".48" stroke-width="2"/><rect x="81" y="24" width="178" height="422" rx="27" fill="#091b1f"/><rect x="87" y="31" width="166" height="406" rx="23" fill="none" stroke="#e7b94a" stroke-width="2"/><circle cx="170" cy="429" r="3" fill="#e7b94a"/></g>
      <g class="phone-layer" data-layer="1"><rect x="91" y="35" width="158" height="398" rx="20" fill="url(#${id}-glass)" stroke="#7fc7b5" stroke-width="2"/><rect x="145" y="43" width="50" height="5" rx="3" fill="#7fc7b5" opacity=".75"/><path d="M111 98h117M111 111h75" stroke="#52767b" stroke-width="2" stroke-linecap="round"/></g>
      <g class="phone-layer" data-layer="2"><rect x="105" y="183" width="130" height="198" rx="12" fill="#1b3b38" stroke="#7fc7b5" stroke-width="2"/><path d="M119 201h102M119 217h102M119 233h102M119 349h102" stroke="#42665c" stroke-width="2"/><rect x="122" y="251" width="96" height="75" rx="7" fill="#234b43" stroke="#a9c4ad" stroke-opacity=".55"/><text x="170" y="292" text-anchor="middle" fill="#c3d2cd" font-size="9" font-family="monospace">RELEVO / CELL</text></g>
      <g class="phone-layer" data-layer="3"><path d="M98 63h144v354H98z" fill="#102b2e" stroke="#c78de0" stroke-width="2"/><rect x="113" y="115" width="45" height="38" rx="4" fill="#1b4144" stroke="#c78de0"/><rect x="174" y="121" width="49" height="54" rx="4" fill="#183638" stroke="#7fc7b5"/><rect x="125" y="179" width="98" height="47" rx="5" fill="#122a2d" stroke="#63827f"/><g fill="#e7b94a"><circle cx="119" cy="251" r="3"/><circle cx="133" cy="251" r="3"/><circle cx="147" cy="251" r="3"/><circle cx="211" cy="242" r="3"/><circle cx="211" cy="256" r="3"/></g><path d="M121 279h94v48h-94zM121 342h41v29h-41z" fill="none" stroke="#557370"/></g>
    </g></svg>`
}

export function buildControl(root) {
  const bar = document.createElement('div')
  bar.className = 'phone-control'
  bar.innerHTML = `<button class="btn btn-ghost" type="button" data-mode-toggle aria-pressed="true">Explorar las capas</button><span class="phone-status" aria-live="polite">Teléfono ensamblado · frente de vidrio y chasis</span><span class="phone-labels">${LAYERS.map(x => `<span>${x.name}<small>${x.note}</small></span>`).join('')}</span>`
  return { bar, uid: root.querySelector('.phone-svg')?.id || 'phone-hero' }
}

export function presentPhone(root, { reduced = false } = {}) {
  const svg = root.querySelector('.phone-svg')
  const layers = [...(svg?.querySelectorAll('.phone-layer') || [])]
  if (!layers.length) return null
  const ctx = gsap.context(() => {
    gsap.set(layers, { x: 0, y: 0, opacity: 1 })
    gsap.set(layers.slice(2), { opacity: 0 })
  }, svg)
  return { kill: () => ctx.revert() }
}

export function describeAssembly(button, status, assembled) {
  button.setAttribute('aria-pressed', String(assembled))
  button.textContent = assembled ? 'Explorar las capas' : 'Armar el teléfono'
  status.dataset.mode = assembled ? 'assembled' : 'exploded'
  status.textContent = assembled
    ? 'Teléfono ensamblado · exterior y chasis'
    : 'Vista de reparación · componentes internos separados'
}

export function readAssemblyState(initial, getCurrentState) {
  const current = getCurrentState?.()
  return typeof current === 'boolean' ? current : initial
}

export function setPhoneSvgPose(root, assembled, { reduced = false } = {}) {
  const layers = [...(root.querySelector('.phone-svg')?.querySelectorAll('.phone-layer') || [])]
  if (!layers.length) return null
  root._phoneSvgTween?.kill()
  const timeline = gsap.timeline({ defaults: { duration: reduced ? 0 : .9, ease: 'power3.inOut' } })
  layers.forEach((layer, i) => timeline.to(layer, {
    x: assembled ? 0 : SVG_SPREAD[i].x,
    y: assembled ? 0 : SVG_SPREAD[i].y,
    rotation: assembled ? 0 : SVG_SPREAD[i].rotation,
    opacity: assembled && i > 1 ? 0 : 1,
    transformOrigin: 'center center',
  }, reduced ? 0 : i * .055))
  root._phoneSvgTween = timeline
  return timeline
}

export function toggleAssembly(root, _uid, toAssembled, { reduced = false } = {}) {
  if (root.querySelector('.phone-stage[data-3d-ready="true"]')) return null
  return setPhoneSvgPose(root, toAssembled, { reduced })
}
