// A single lightweight 3D stage shared by the workshop dashboard metrics.
// HTML owns every label and value; this module only renders decorative models.
import * as THREE from 'three/webgpu'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import gsap from 'gsap'
import { createStudioEnvironment } from './studio-environment.js'

const COLORS = {
  ink: 0x282722,
  graphite: 0x45433d,
  ivory: 0xf4f0e7,
  porcelain: 0xfffcf5,
  amber: 0xc3943e,
  amberLight: 0xf2c96e,
  teal: 0x7faeb2,
  violet: 0x9e8ab2,
  green: 0x829b7c,
  muted: 0xa9a293,
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

function metricKey(card, slot, index) {
  const explicit = slot.dataset.statKey || slot.dataset.metric || card?.dataset.statKey
  if (explicit) return explicit.toLowerCase().replace(/[^a-z0-9]+/g, '_')
  const text = (card?.textContent || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  if (/recibid/.test(text)) return 'received'
  if (/aprobacion|aprobacion/.test(text)) return 'awaiting_approval'
  if (/pago|cobro/.test(text)) return 'awaiting_payment'
  if (/reparacion|reparando/.test(text)) return 'repairing'
  if (/listos|entrega/.test(text)) return 'ready'
  if (/prestam/.test(text)) return 'loans_out'
  if (/cliente/.test(text)) return 'clients'
  if (/equipos|terminales/.test(text)) return 'terminals'
  if (/casos/.test(text)) return 'total_cases'
  return `metric_${index + 1}`
}

function metricValue(stats, key) {
  const value = {
    received: stats?.counts?.received,
    awaiting_approval: stats?.counts?.awaiting_approval,
    awaiting_payment: stats?.counts?.awaiting_payment,
    repairing: stats?.counts?.repairing,
    ready: stats?.counts?.ready,
    loans_out: stats?.loans_out,
    clients: stats?.totals?.clients,
    terminals: stats?.totals?.terminals,
    total_cases: stats?.counts?.total_cases ?? stats?.totals?.cases,
  }[key]
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function accentFor(key, tone) {
  if (key === 'ready' || tone === 'ready') return COLORS.teal
  if (key === 'repairing' || tone === 'review') return COLORS.violet
  if (key === 'received' || tone === 'info') return COLORS.amber
  if (key.startsWith('awaiting') || key === 'loans_out' || tone === 'signal') return COLORS.amberLight
  if (key === 'clients') return COLORS.green
  return COLORS.teal
}

function createModel(key, accent, resources) {
  const root = new THREE.Group()
  const materials = new Map()
  const material = (name, color, roughness = .34, metalness = .35, extra = {}) => {
    if (!materials.has(name)) {
      const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra })
      materials.set(name, mat)
      resources.materials.push(mat)
    }
    return materials.get(name)
  }
  const shell = material('shell', COLORS.ivory, .27, .52)
  const dark = material('dark', COLORS.graphite, .32, .55)
  const ink = material('ink', COLORS.ink, .26, .4)
  const metal = material('metal', COLORS.porcelain, .19, .82)
  const accentMat = material('accent', accent, .25, .55, { emissive: accent, emissiveIntensity: .22 })
  const dimAccent = material('dim-accent', accent, .42, .4)

  const add = (geometry, mat, position = [0, 0, 0], scale = [1, 1, 1], rotation = [0, 0, 0]) => {
    resources.geometries.push(geometry)
    const item = new THREE.Mesh(geometry, mat)
    item.position.set(...position)
    item.scale.set(...scale)
    item.rotation.set(...rotation)
    item.castShadow = false
    item.receiveShadow = false
    root.add(item)
    return item
  }
  const box = (size, mat, position, radius = .08, rotation = [0, 0, 0]) => add(
    new RoundedBoxGeometry(size[0], size[1], size[2], 2, Math.min(radius, Math.min(...size) * .45)),
    mat, position, [1, 1, 1], rotation,
  )
  const sphere = (radius, mat, position, segments = 18) => add(new THREE.SphereGeometry(radius, segments, 12), mat, position)
  const torus = (radius, tube, mat, position = [0, 0, 0], rotation = [0, 0, 0]) => add(
    new THREE.TorusGeometry(radius, tube, 8, 48), mat, position, [1, 1, 1], rotation,
  )
  const cylinder = (rTop, rBottom, depth, mat, position = [0, 0, 0], rotation = [Math.PI / 2, 0, 0], radial = 24) => add(
    new THREE.CylinderGeometry(rTop, rBottom, depth, radial, 1, false), mat, position, [1, 1, 1], rotation,
  )

  // Every metric gets a recognizable workshop object and a small orbital rig.
  // The rig is intentionally shared so the grid reads as one diagnostic engine.
  torus(.72, .018, dimAccent, [0, 0, -.28], [.38, .12, 0])
  torus(.82, .009, metal, [0, 0, -.34], [-.24, -.2, .12])
  sphere(.055, accentMat, [.73, .08, .05], 12)
  sphere(.035, metal, [-.56, .52, -.02], 10)

  if (key === 'received' || key === 'terminals' || key === 'total_cases' || key === 'metric_1') {
    // A miniature phone chassis with a floating inspection lens.
    box([.72, 1.17, .12], shell, [0, 0, .08], .11)
    box([.63, 1.04, .055], ink, [0, -.015, .16], .08)
    box([.54, .8, .022], dark, [0, .03, .205], .055)
    box([.32, .036, .018], accentMat, [0, .29, .222], .012)
    box([.2, .018, .014], metal, [0, -.24, .222], .008)
    const scanMaterial = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: .62, depthWrite: false })
    resources.materials.push(scanMaterial)
    const scanBeam = add(new THREE.PlaneGeometry(.48, .018), scanMaterial, [0, -.3, .232])
    root.userData.scanBeam = scanBeam
    root.userData.scanMaterial = scanMaterial
    root.userData.scanRange = [-.3, .35]
    torus(.16, .028, accentMat, [.32, .42, .3], [0, 0, 0])
    sphere(.045, metal, [.32, .42, .3], 14)
    // Fine side rails catch highlights as the object turns.
    box([.018, .76, .026], metal, [-.365, 0, .08], .008)
    box([.018, .55, .026], accentMat, [.365, -.08, .08], .008)
  } else if (key === 'awaiting_approval') {
    // Approval: precision-cut crystal held inside a gimbal.
    add(new THREE.OctahedronGeometry(.42, 1), shell, [0, 0, .08], [1, 1, .72], [.12, .18, .08])
    add(new THREE.OctahedronGeometry(.24, 0), accentMat, [0, 0, .28], [1, 1, .75], [.12, .18, .08])
    torus(.55, .035, metal, [0, 0, -.02], [.3, .35, 0])
    sphere(.08, metal, [0, -.5, .2], 14)
  } else if (key === 'awaiting_payment') {
    // A nested stack of service-credit discs; no amount is implied here.
    cylinder(.4, .4, .12, shell, [0, .18, .02])
    cylinder(.4, .4, .12, metal, [0, .04, .11])
    cylinder(.4, .4, .12, shell, [0, -.1, .2])
    cylinder(.34, .34, .035, accentMat, [0, -.1, .27])
    torus(.18, .035, dark, [0, -.1, .294], [0, 0, 0])
    sphere(.065, accentMat, [0, -.1, .3], 16)
  } else if (key === 'repairing') {
    // A rotor with eight ceramic teeth and a suspended service core.
    torus(.39, .1, shell, [0, 0, .08], [0, 0, 0])
    torus(.21, .055, accentMat, [0, 0, .11], [0, 0, 0])
    sphere(.13, ink, [0, 0, .16])
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4
      box([.14, .12, .12], metal, [Math.cos(a) * .46, Math.sin(a) * .46, .06], .025, [0, 0, a])
    }
    box([.48, .09, .11], accentMat, [0, 0, .25], .025, [0, 0, Math.PI / 4])
    box([.48, .09, .11], shell, [0, 0, .27], .025, [0, 0, -Math.PI / 4])
  } else if (key === 'ready') {
    // Ready: a device lifted through a lit delivery arch.
    torus(.54, .035, metal, [0, .08, -.02], [0, 0, Math.PI / 2])
    box([.58, .78, .08], shell, [0, -.02, .1], .09)
    box([.48, .62, .045], dark, [0, -.015, .15], .06)
    box([.24, .035, .018], accentMat, [0, .16, .18], .01)
    for (let i = 0; i < 3; i++) sphere(.055, i === 2 ? accentMat : metal, [-.23 + i * .23, -.29, .19], 12)
    box([.035, .76, .05], accentMat, [-.48, 0, -.02], .018)
    box([.035, .76, .05], metal, [.48, 0, -.02], .018)
    box([.99, .045, .07], metal, [0, .39, -.02], .02)
  } else if (key === 'loans_out') {
    // Two loan devices are staged on separate planes for clear depth.
    box([.55, .91, .1], shell, [-.18, .02, -.06], .09, [0, .08, -.12])
    box([.48, .8, .05], ink, [-.18, .02, 0], .065, [0, .08, -.12])
    box([.55, .91, .1], metal, [.2, -.02, .14], .09, [0, -.08, .1])
    box([.46, .78, .05], dark, [.2, -.02, .2], .06, [0, -.08, .1])
    box([.21, .035, .018], accentMat, [.2, .23, .24], .01)
    const scanMaterial = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: .5, depthWrite: false })
    resources.materials.push(scanMaterial)
    const scanBeam = add(new THREE.PlaneGeometry(.36, .016), scanMaterial, [.2, -.32, .255])
    root.userData.scanBeam = scanBeam
    root.userData.scanMaterial = scanMaterial
    root.userData.scanRange = [-.32, .31]
    sphere(.07, accentMat, [.46, -.42, .28], 14)
  } else if (key === 'clients') {
    // A pair of connected service nodes rather than a generic avatar glyph.
    sphere(.27, shell, [-.27, .14, .08], 20)
    sphere(.22, metal, [.27, .1, .12], 18)
    torus(.3, .035, accentMat, [0, -.25, .08], [0, Math.PI / 2, 0])
    box([.42, .045, .06], dark, [0, -.1, .12], .02)
    sphere(.075, accentMat, [0, -.1, .2], 14)
  } else {
    // Unknown future metric: a distinctive holo-core, no fabricated quantity.
    add(new THREE.IcosahedronGeometry(.44, 1), shell, [0, 0, .08], [1, .82, .95], [.16, .1, .05])
    add(new THREE.DodecahedronGeometry(.23, 0), accentMat, [0, 0, .23])
    torus(.56, .026, metal, [0, 0, -.03], [.4, .3, 0])
  }

  root.userData.materials = [...materials.values()]
  return root
}

function addFallback(slot, index, accent) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 72 72')
  svg.setAttribute('aria-hidden', 'true')
  svg.dataset.workshopFallback = ''
  svg.style.cssText = 'display:block;width:100%;height:100%;overflow:visible;filter:drop-shadow(0 7px 8px rgba(42,38,28,.16))'
  const accentHex = `#${accent.toString(16).padStart(6, '0')}`
  const shape = index % 3 === 0
    ? `<rect x="23" y="11" width="26" height="49" rx="6" fill="#f4f0e7" stroke="#45433d" stroke-width="2"/><rect x="27" y="17" width="18" height="34" rx="3" fill="#282722"/><path d="M30 24h12M30 28h8" stroke="${accentHex}" stroke-width="2" stroke-linecap="round"/><circle cx="36" cy="55" r="1.8" fill="${accentHex}"/>`
    : `<path d="M36 8 58 20v25L36 62 14 49V23z" fill="#f4f0e7" stroke="#45433d" stroke-width="2"/><path d="M36 8v25m22-13L36 33 14 23m22 10v29" fill="none" stroke="${accentHex}" stroke-width="2"/><circle cx="36" cy="33" r="5" fill="${accentHex}"/>`
  svg.innerHTML = `<ellipse cx="36" cy="62" rx="23" ry="4" fill="rgba(40,39,34,.12)"/><ellipse cx="36" cy="36" rx="31" ry="13" fill="none" stroke="${accentHex}" stroke-opacity=".42" stroke-width="1.5" transform="rotate(-24 36 36)"/>${shape}`
  slot.append(svg)
  return svg
}

/**
 * Mount one WebGPU/WebGL stage shared by all `.stat-model` anchors under host.
 * `stats` is the unmodified API dashboard payload. Visible metric copy and
 * values remain in the surrounding HTML. Returns an idempotent cleanup.
 */
export function mountWorkshopScene(host, stats = {}) {
  let disposed = false
  let renderer = null
  let renderFrame = 0
  let lastFrame = 0
  let visible = !('IntersectionObserver' in window)
  const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  let reduced = motionPreference?.matches ?? false
  let resizeObserver = null
  let intersectionObserver = null
  let lostContext = false
  const resources = { geometries: [], materials: [] }
  const scene = new THREE.Scene()
  let environmentTexture = null
  const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, .1, 100)
  camera.position.set(0, 0, 30)
  camera.lookAt(0, 0, 0)
  // The orthographic camera stays fixed: all nine objects share DOM anchors.
  const lightFocus = { x: 0, y: 0, intensity: 0 }
  let focusTween = null
  const focusLight = new THREE.PointLight(COLORS.amberLight, 0, 2.8, 2)
  focusLight.position.set(0, 0, 1.8)
  scene.add(focusLight)
  const cards = [...host.querySelectorAll('.stat')]
  const slots = [...host.querySelectorAll('.stat-model')]
  const models = []
  const tweens = new Set()
  let introTween = null
  const fallbackNodes = []
  const previousHostPosition = host.style.position
  const previousSceneState = host.dataset.workshopScene
  const previousRenderer = host.dataset.rendererBackend
  let canvas = null
  let rafCallback = null

  const killFocusTween = () => {
    if (!focusTween) return
    tweens.delete(focusTween)
    focusTween.kill()
    focusTween = null
  }

  if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
  host.dataset.workshopScene = 'loading'

  const cleanup = () => {
    if (disposed) return
    disposed = true
    if (renderFrame) cancelAnimationFrame(renderFrame)
    renderFrame = 0
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('resize', onLayout, { passive: true })
    window.removeEventListener('scroll', onLayout, true)
    host.removeEventListener('scroll', onLayout)
    motionPreference?.removeEventListener?.('change', onMotionPreference)
    resizeObserver?.disconnect()
    intersectionObserver?.disconnect()
    cards.forEach((card, index) => {
      const model = models[index]
      if (!model) return
      card.removeEventListener('pointerenter', model.onEnter)
      card.removeEventListener('pointerleave', model.onLeave)
      card.removeEventListener('focusin', model.onEnter)
      card.removeEventListener('focusout', model.onFocusOut)
      model.tween?.kill()
      model.tween = null
    })
    tweens.forEach(tween => tween.kill())
    tweens.clear()
    introTween = null
    killFocusTween()
    scene.environment = null
    environmentTexture?.dispose(); environmentTexture = null
    const lights = []
    scene.traverse(object => { if (object.isLight) lights.push(object) })
    scene.remove(...lights)
    resources.geometries.forEach(geometry => geometry.dispose())
    resources.materials.forEach(material => material.dispose())
    fallbackNodes.forEach(node => node.remove())
    if (renderer) {
      renderer.domElement?.removeEventListener('webglcontextlost', onContextLost)
      renderer.dispose()
      renderer.domElement?.remove()
      renderer = null
    }
    host.style.position = previousHostPosition
    if (previousSceneState === undefined) delete host.dataset.workshopScene
    else host.dataset.workshopScene = previousSceneState
    if (previousRenderer === undefined) delete host.dataset.rendererBackend
    else host.dataset.rendererBackend = previousRenderer
  }

  const metricFor = (slot, index) => {
    const card = slot.closest('.stat') || cards[index] || slot.parentElement
    const key = metricKey(card, slot, index)
    return { card, key, value: metricValue(stats, key), accent: accentFor(key, card?.dataset.tone) }
  }

  slots.forEach((slot, index) => {
    const metric = metricFor(slot, index)
    const group = createModel(metric.key, metric.accent, resources)
    group.userData.metricKey = metric.key
    group.userData.value = metric.value
    scene.add(group)
    const fallback = addFallback(slot, index, metric.accent)
    fallbackNodes.push(fallback)
    models.push({ ...metric, slot, group, fallback, card: metric.card, phase: index * 1.19, tween: null, hovered: false, scanBeam: group.userData.scanBeam, scanMaterial: group.userData.scanMaterial, scanRange: group.userData.scanRange })
  })

  const updateAnchors = () => {
    if (!host.clientWidth || !host.clientHeight) return
    const width = host.clientWidth
    const height = host.clientHeight
    const unitsPerPixel = 100
    camera.left = -width / (2 * unitsPerPixel)
    camera.right = width / (2 * unitsPerPixel)
    camera.top = height / (2 * unitsPerPixel)
    camera.bottom = -height / (2 * unitsPerPixel)
    camera.updateProjectionMatrix()
    for (const model of models) {
      const rect = model.slot.getBoundingClientRect()
      const parentRect = host.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2 - parentRect.left
      const centerY = rect.top + rect.height / 2 - parentRect.top
      model.group.position.set((centerX - width / 2) / unitsPerPixel, (height / 2 - centerY) / unitsPerPixel, 0)
      const scale = clamp(Math.min(rect.width, rect.height) * .48 / unitsPerPixel, .2, .68)
      model.group.scale.setScalar(scale)
      model.baseScale = scale
    }
    if (renderer) {
      renderer.setSize(width, height, false)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    }
    scheduleRender()
  }

  const scheduleRender = () => {
    if (disposed || !renderer || renderFrame || !visible || document.hidden || reduced || lostContext) return
    renderFrame = requestAnimationFrame(rafCallback)
  }

  const render = timestamp => {
    renderFrame = 0
    if (disposed || !renderer || !visible || document.hidden || reduced || lostContext) return
    const active = models.some(model => model.hovered || model.tween?.isActive())
    const targetFrameTime = active ? 1000 / 30 : 1000 / 18
    if (timestamp - lastFrame < targetFrameTime) {
      renderFrame = requestAnimationFrame(rafCallback)
      return
    }
    lastFrame = timestamp
    const elapsed = timestamp / 1000
    for (const model of models) {
      if (model.hovered || model.tween?.isActive()) continue
      model.group.rotation.x = .08 + Math.sin(elapsed * .48 + model.phase) * .045
      model.group.rotation.y = .24 + Math.sin(elapsed * .34 + model.phase) * .12
      model.group.rotation.z = Math.sin(elapsed * .32 + model.phase) * .035
      model.group.position.z = Math.sin(elapsed * .8 + model.phase) * .035
      if (model.scanBeam && model.scanRange) {
        const phase = ((elapsed * .17 + model.phase * .09) % 1 + 1) % 1
        model.scanBeam.position.y = model.scanRange[0] + phase * (model.scanRange[1] - model.scanRange[0])
        model.scanMaterial.opacity = .25 + Math.sin(phase * Math.PI) * .45
      }
    }
    focusLight.position.set(lightFocus.x, lightFocus.y, 1.8)
    focusLight.intensity = lightFocus.intensity
    renderer.render(scene, camera)
    renderFrame = requestAnimationFrame(rafCallback)
  }
  rafCallback = render

  const moveFocusLight = model => {
    killFocusTween()
    focusTween = gsap.to(lightFocus, {
      ...(model ? { x: model.group.position.x, y: model.group.position.y } : {}),
      intensity: model ? 14 : 0,
      duration: model ? .32 : .35,
      ease: 'power3.out',
      onUpdate: scheduleRender,
    })
    tweens.add(focusTween)
  }

  const onEnter = model => () => {
    if (disposed || reduced || model.hovered) return
    model.hovered = true
    moveFocusLight(model)
    if (model.tween) { tweens.delete(model.tween); model.tween.kill() }
    model.tween = gsap.timeline({ onUpdate: scheduleRender, onComplete: () => tweens.delete(model.tween) })
      .to(model.group.rotation, {
        x: -.18,
        y: model.group.rotation.y + Math.PI * 2 + .2,
        z: -.1,
        duration: .72,
        ease: 'power3.out',
        overwrite: true,
      }, 0)
      .to(model.group.scale, {
        x: model.baseScale * 1.14,
        y: model.baseScale * 1.14,
        z: model.baseScale * 1.14,
        duration: .42,
        ease: 'back.out(1.35)',
        overwrite: true,
      }, .06)
    tweens.add(model.tween)
    scheduleRender()
  }

  const onLeave = model => () => {
    if (disposed || reduced || !model.hovered) return
    model.hovered = false
    moveFocusLight(models.find(item => item.hovered && item.focused) || models.find(item => item.hovered))
    if (model.tween) { tweens.delete(model.tween); model.tween.kill() }
    model.tween = gsap.timeline({ onUpdate: scheduleRender, onComplete: () => tweens.delete(model.tween) })
      .to(model.group.scale, {
        x: model.baseScale,
        y: model.baseScale,
        z: model.baseScale,
        duration: .35,
        ease: 'power2.out',
        overwrite: true,
      }, 0)
      .to(model.group.rotation, {
        x: .08,
        y: .24 + Math.round((model.group.rotation.y - .24) / (Math.PI * 2)) * Math.PI * 2,
        z: 0,
        duration: .35,
        ease: 'power2.out',
      }, 0)
    tweens.add(model.tween)
    scheduleRender()
  }

  cards.forEach((card, index) => {
    const model = models.find(item => item.card === card) || models[index]
    if (!model) return
    const enter = onEnter(model)
    const leave = onLeave(model)
    model.onEnter = event => {
      if (event.type === 'focusin') model.focused = true
      else model.pointed = true
      enter()
    }
    model.onLeave = () => {
      model.pointed = false
      if (!model.focused) leave()
    }
    model.onFocusOut = event => {
      if (card.contains(event.relatedTarget)) return
      model.focused = false
      if (!model.pointed) leave()
    }
    card.addEventListener('pointerenter', model.onEnter)
    card.addEventListener('pointerleave', model.onLeave)
    card.addEventListener('focusin', model.onEnter)
    card.addEventListener('focusout', model.onFocusOut)
  })

  const setMotionMode = () => {
    reduced = motionPreference?.matches ?? false
    if (reduced) {
      if (renderFrame) cancelAnimationFrame(renderFrame)
      renderFrame = 0
      introTween?.kill()
      if (introTween) tweens.delete(introTween)
      introTween = null
      models.forEach(model => {
        if (model.tween) { tweens.delete(model.tween); model.tween.kill() }
        model.tween = null
        model.hovered = false
        model.focused = false
        model.pointed = false
        model.group.scale.setScalar(model.baseScale || 1)
        model.group.rotation.set(.08, .24, 0)
        model.group.position.z = 0
      })
      killFocusTween()
      lightFocus.intensity = 0
      focusLight.intensity = 0
      if (renderer && visible && !document.hidden) renderer.render(scene, camera)
    } else scheduleRender()
  }
  const onMotionPreference = () => setMotionMode()
  const onVisibility = () => {
    if (document.hidden) {
      if (renderFrame) cancelAnimationFrame(renderFrame)
      renderFrame = 0
      focusTween?.pause()
      models.forEach(model => model.tween?.pause())
    } else {
      focusTween?.resume()
      models.forEach(model => model.tween?.resume())
      scheduleRender()
    }
  }
  const onLayout = () => updateAnchors()
  const onContextLost = event => {
    event.preventDefault()
    lostContext = true
    host.dataset.workshopScene = 'fallback'
    host.dataset.rendererBackend = 'fallback'
    if (renderFrame) cancelAnimationFrame(renderFrame)
    renderFrame = 0
    fallbackNodes.forEach(node => { node.style.display = 'block' })
    renderer?.dispose()
    renderer?.domElement?.remove()
    renderer = null
  }

  if (!slots.length) {
    host.dataset.workshopScene = 'fallback'
    return cleanup
  }

  const fallbackRenderer = () => {
    if (disposed) return
    host.dataset.workshopScene = 'fallback'
    host.dataset.rendererBackend = 'fallback'
    fallbackNodes.forEach(node => { node.style.display = 'block' })
    canvas?.remove()
    canvas = null
    renderer = null
  }

  const initialize = async () => {
    try {
      renderer = new THREE.WebGPURenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
      await renderer.init()
      if (disposed) { renderer.dispose(); renderer = null; return }
    } catch (webgpuError) {
      renderer?.dispose()
      renderer = null
      if (disposed) return
      try {
        renderer = new THREE.WebGPURenderer({ alpha: true, antialias: true, forceWebGL: true, powerPreference: 'low-power' })
        await renderer.init()
        if (disposed) { renderer.dispose(); renderer = null; return }
      } catch (webglError) {
        renderer?.dispose()
        renderer = null
        fallbackRenderer()
        return
      }
    }

    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    canvas = renderer.domElement
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;overflow:visible'
    host.append(canvas)
    fallbackNodes.forEach(node => { node.style.display = 'none' })
    host.dataset.workshopScene = 'ready'
    host.dataset.rendererBackend = renderer.backend?.isWebGPUBackend ? 'webgpu' : renderer.backend?.isWebGLBackend ? 'webgl2' : 'unknown'
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)
    if (typeof renderer.onDeviceLost === 'function') {
      const previousDeviceLost = renderer.onDeviceLost.bind(renderer)
      renderer.onDeviceLost = info => { previousDeviceLost(info); onContextLost({ preventDefault() {} }) }
    }
    updateAnchors()
    if (reduced) renderer.render(scene, camera)
    else {
      introTween = gsap.timeline({
        onUpdate: scheduleRender,
        onComplete: () => { if (introTween) tweens.delete(introTween); introTween = null },
      })
      tweens.add(introTween)
      models.forEach((model, index) => {
        const y = model.group.position.y
        model.group.position.y = y - .18
        model.group.position.z = -.55
        model.group.rotation.y -= .8
        model.group.scale.setScalar(.005)
        const at = index * .055
        introTween.to(model.group.position, { y, z: 0, duration: .62, ease: 'power3.out' }, at)
          .to(model.group.rotation, { x: .08, y: .24, z: 0, duration: .62, ease: 'power3.out' }, at)
          .to(model.group.scale, { x: model.baseScale, y: model.baseScale, z: model.baseScale, duration: .72, ease: 'back.out(1.45)' }, at)
      })
      scheduleRender()
    }
  }

  scene.add(new THREE.AmbientLight(0xfff6e7, 2.15))
  const keyLight = new THREE.DirectionalLight(0xfff5e4, 3.2)
  keyLight.position.set(-4, 7, 10)
  scene.add(keyLight)
  const fillLight = new THREE.DirectionalLight(0xb9c6c2, .9)
  fillLight.position.set(5, -4, 6)
  scene.add(fillLight)
  environmentTexture = createStudioEnvironment()
  if (environmentTexture) {
    scene.environment = environmentTexture
    scene.environmentIntensity = .52
  }

  resizeObserver = new ResizeObserver(onLayout)
  resizeObserver.observe(host)
  slots.forEach(slot => resizeObserver.observe(slot))
  intersectionObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    visible = Boolean(entries[0]?.isIntersecting)
    if (visible) scheduleRender()
    else if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = 0 }
  }, { rootMargin: '96px' }) : null
  intersectionObserver?.observe(host)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('resize', onLayout, { passive: true })
  motionPreference?.addEventListener?.('change', onMotionPreference)
  updateAnchors()
  initialize()

  return cleanup
}
