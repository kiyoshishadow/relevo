// Three.js procedural construction. Every scene resource is owned by this mount.
import * as THREE from 'three/webgpu'
import gsap from 'gsap'
import { describeAssembly, readAssemblyState } from './phone.js'
import { createStudioEnvironment } from './studio-environment.js'
import { mountPhoneCallouts } from './phone-callouts.js'

export function makeRounded(w, h, d, radius = .12) {
  // XY silhouette rounding must be independent of this thin part's Z depth.
  // The bevel rounds only the machined edge; arcs preserve a true glass pill.
  const bevel = Math.min(.018, d * .2, w * .1, h * .1)
  const r = Math.min(Math.max(.0001, radius - bevel), Math.min(w, h) / 2 - bevel)
  const halfW = w / 2 - bevel
  const halfH = h / 2 - bevel
  const shape = new THREE.Shape()
  shape.moveTo(-halfW + r, -halfH)
  shape.lineTo(halfW - r, -halfH)
  shape.absarc(halfW - r, -halfH + r, r, -Math.PI / 2, 0, false)
  shape.lineTo(halfW, halfH - r)
  shape.absarc(halfW - r, halfH - r, r, 0, Math.PI / 2, false)
  shape.lineTo(-halfW + r, halfH)
  shape.absarc(-halfW + r, halfH - r, r, Math.PI / 2, Math.PI, false)
  shape.lineTo(-halfW, -halfH + r)
  shape.absarc(-halfW + r, -halfH + r, r, Math.PI, Math.PI * 1.5, false)
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(.001, d - bevel * 2),
    bevelEnabled: true,
    bevelSegments: 2,
    steps: 1,
    bevelSize: bevel,
    bevelThickness: bevel,
    curveSegments: 5,
  })
  geometry.center()
  geometry.computeVertexNormals()
  return geometry
}
const BASE_SCENE_ROTATION = { x: -.05, y: .055, z: .01 }

// A recorded movement only chooses a viewing angle. It never describes a
// repair action, a damaged part or a progress claim. Targets are derived from
// the resting pose, not the current one, so quick selections converge on the
// same stable angle instead of stacking rotations.
const MOVEMENT_INSPECTION_VIEWS = Object.freeze({
  received: { turn: -.34, tilt: -.05, orbit: -.18, lift: -.14, zoom: 1.05, focusY: .18 },
  diagnosing: { turn: -.12, tilt: .03, orbit: .22, lift: .38, zoom: .92, focusY: .55 },
  awaiting_approval: { turn: .1, tilt: -.02, orbit: .34, lift: .05, zoom: 1.02, focusY: -.1 },
  awaiting_payment: { turn: .26, tilt: .04, orbit: -.2, lift: .24, zoom: .98, focusY: -.35 },
  repairing: { turn: .4, tilt: .05, orbit: .1, lift: .52, zoom: .9, focusY: .35 },
  ready: { turn: .18, tilt: -.04, orbit: -.3, lift: .62, zoom: .88, focusY: .15 },
  delivered: { turn: -.28, tilt: .02, orbit: .4, lift: .1, zoom: 1.06, focusY: 0 },
  cancelled: { turn: -.48, tilt: -.03, orbit: -.06, lift: -.08, zoom: 1.1, focusY: 0 },
  default: { turn: -.2, tilt: 0, orbit: .18, lift: .25, zoom: 1, focusY: 0 },
})

export function getMovementInspectionPose(status, { yaw = BASE_SCENE_ROTATION.y, camera = { x: 2.8, y: 3.65, z: 11.8 }, assembled = true } = {}) {
  const view = MOVEMENT_INSPECTION_VIEWS[status] || MOVEMENT_INSPECTION_VIEWS.default
  const base = {
    x: Number.isFinite(camera?.x) ? camera.x : 2.8,
    y: Number.isFinite(camera?.y) ? camera.y : 3.65,
    z: Number.isFinite(camera?.z) ? camera.z : 11.8,
  }
  const baseYaw = Number.isFinite(yaw) ? yaw : BASE_SCENE_ROTATION.y
  const orbit = view.orbit * (assembled ? 1 : 1.08)
  const cos = Math.cos(orbit)
  const sin = Math.sin(orbit)
  const orbitedX = base.x * cos - base.z * sin
  const orbitedZ = base.x * sin + base.z * cos
  return {
    status: MOVEMENT_INSPECTION_VIEWS[status] ? status : 'default',
    phone: {
      x: BASE_SCENE_ROTATION.x + view.tilt,
      y: baseYaw + view.turn,
      z: BASE_SCENE_ROTATION.z,
    },
    camera: {
      x: orbitedX * view.zoom,
      y: base.y + view.lift,
      z: orbitedZ * view.zoom,
    },
    target: { x: 0, y: view.focusY, z: 0 },
  }
}

export function getMovementYawOffset(status, { assembled = true } = {}) {
  return getMovementInspectionPose(status, {
    yaw: 0,
    camera: { x: 0, y: 0, z: 1 },
    assembled,
  }).phone.y
}

export function getExteriorYawFromPose(rotationY, { profiled = false, assembled = true, movementStatus = '' } = {}) {
  const assemblyOffset = profiled && !assembled ? Math.PI : 0
  const movementOffset = movementStatus ? getMovementYawOffset(movementStatus, { assembled }) : 0
  return rotationY - assemblyOffset - movementOffset
}

// Convert a drag gesture to a deliberately small, predictable inspection orbit.
// Exported as a pure helper so its limits can be tested without a GPU context.
export function getDragRotation({ deltaX, deltaY, width, height }, base = BASE_SCENE_ROTATION) {
  const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value))
  return {
    x: base.x + clamp((deltaY / Math.max(1, height)) * .62, .24),
    y: base.y + clamp((deltaX / Math.max(1, width)) * .78, .34),
  }
}

// A short press selects a real mesh; a drag must never turn into a selection,
// including when the pointer returns to its original position before release.
export function getInspectionPoint({ clientX, clientY, startX, startY, moved = false }, rect) {
  if (!rect || rect.width <= 0 || rect.height <= 0 || moved ||
    ![clientX, clientY, startX, startY, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) ||
    Math.hypot(clientX - startX, clientY - startY) > 6) return null
  const x = (clientX - rect.left) / rect.width
  const y = (clientY - rect.top) / rect.height
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x: x * 2 - 1, y: 1 - y * 2 }
}

export async function mountPhone3d(host, button, status, { reduced = false, assembled = true, getAssembled, playIntro = true, idleAnimation = true, idleScan = true, isActive = () => true, onStateChange = () => {}, onFallback = () => {}, onMotionReady = () => {}, profile = null, partButtons = [] } = {}) {
  const originalButton = {
    pressed: button.getAttribute('aria-pressed'),
    text: button.textContent,
    status: status.textContent,
  }
  let renderer = null
  let resize = null
  let visibility = null
  let isVisible = !('IntersectionObserver' in window)
  let tween = null
  let idleTween = null
  let scanTween = null
  let focusTween = null
  let movementTween = null
  let pendingMovement = null
  let pendingFocus = null
  let focusedLayer = null
  let drag = null
  let rotationOrigin = null
  let pointerDown = null
  let pointerMove = null
  let pointerUp = null
  let pointerCancel = null
  let lostContext = false
  let disposed = false
  let renderFrame = 0
  let environmentTexture = null
  let annotations = null
  let sweepTexture = null
  const mats = []
  const scene = new THREE.Scene()
  const cleanupScene = () => {
    disposed = true
    tween?.kill(); tween = null
    idleTween?.kill(); idleTween = null
    scanTween?.kill(); scanTween = null
    focusTween?.kill(); focusTween = null
    movementTween?.kill(); movementTween = null
    pendingMovement = null
    button.removeEventListener('click', onClick)
    partButtons.forEach(part => part.removeEventListener('click', onPartClick))
    if (renderer?.domElement) {
      if (pointerDown) renderer.domElement.removeEventListener('pointerdown', pointerDown)
      if (pointerMove) renderer.domElement.removeEventListener('pointermove', pointerMove)
      if (pointerUp) renderer.domElement.removeEventListener('pointerup', pointerUp)
      if (pointerCancel) renderer.domElement.removeEventListener('pointercancel', pointerCancel)
      renderer.domElement.style.cursor = ''
      renderer.domElement.style.touchAction = ''
    }
    document.removeEventListener('visibilitychange', onVisibility)
    renderer?.domElement.removeEventListener('webglcontextlost', onContextLost)
    resize?.disconnect(); visibility?.disconnect()
    if (renderFrame) cancelAnimationFrame(renderFrame)
    renderFrame = 0
    scene.traverse(o => { if (o.geometry) o.geometry.dispose() })
    mats.forEach(m => m.dispose())
    scene.environment = null
    environmentTexture?.dispose(); environmentTexture = null
    sweepTexture?.dispose(); sweepTexture = null
    annotations?.dispose(); annotations = null
    renderer?.dispose(); renderer?.domElement.remove()
    renderer = null
  }
  const restoreFallback = () => {
    cleanupScene()
    host.removeAttribute('data-3d-ready')
    host.removeAttribute('data-renderer-backend')
    host.querySelector('.phone-fallback')?.removeAttribute('aria-hidden')
    host.querySelector('.phone-svg')?.classList.remove('has-webgl')
  }
  const onContextLost = event => {
    event.preventDefault()
    lostContext = true
    restoreFallback()
    describeAssembly(button, status, assembled)
    onFallback(assembled)
  }
  const updateState = value => {
    assembled = value
    host.dataset.assembled = String(value)
    describeAssembly(button, status, value)
    onStateChange(value)
  }
  const onVisibility = () => {
    if (document.hidden) { tween?.pause(); idleTween?.pause(); scanTween?.pause(); focusTween?.pause(); movementTween?.pause() }
    else if (isVisible) {
      tween?.resume(); focusTween?.resume(); movementTween?.resume()
      if (focusedLayer === null && !focusTween && !movementTween) { idleTween?.resume(); scanTween?.resume() }
      if (!tween && !idleTween && !scanTween && !focusTween && !movementTween) draw()
    }
  }
  const startIdle = () => {
    idleTween?.kill()
    scanTween?.kill()
    idleTween = null
    scanTween = null
    if (!idleAnimation || reduced || disposed || !phoneRoot || focusedLayer !== null || movementTween) return
    screenSweep.position.x = -.75
    screenSweepMat.opacity = 0
    idleTween = gsap.timeline({ repeat: -1, yoyo: true, onUpdate: draw })
      .to(phoneRoot.rotation, {
        x: rotationOrigin.x + .02,
        y: rotationOrigin.y + .055,
        duration: 4.2,
        ease: 'sine.inOut',
      }, 0)
      .to(phoneRoot.position, { y: .045, duration: 4.2, ease: 'sine.inOut' }, 0)
    if (idleScan) {
      scanTween = gsap.timeline({ repeat: -1, repeatDelay: 6, onUpdate: draw })
        .set(screenSweep.position, { x: -.75 })
        .set(screenSweepMat, { opacity: .12 })
        .to(screenSweep.position, { x: .38, duration: 1.1, ease: 'power2.inOut' }, 0)
        .to(screenSweepMat, { opacity: 0, duration: .38, ease: 'power1.out' }, .75)
    }
    if (!isVisible || document.hidden) { idleTween.pause(); scanTween?.pause() }
  }
  let layers = []
  let draw = () => {}
  let camera = null
  let cameraRest = null
  let cameraExplore = null
  let exteriorYaw = BASE_SCENE_ROTATION.y
  let activeMovement = null
  const cameraTarget = new THREE.Vector3(0, 0, 0)
  let phoneRoot = null
  const assembledFov = 25
  const explodedFov = 32
  let screenSweep = null
  let screenSweepMat = null
  let dockPulse = null
  let dockPulseMat = null
  const assembledZ = [-.15, .08, -.1, -.22, -.24, -.18]
  // This fan explains common repair parts, rather than a model's real teardown.
  // Profiled devices turn from their rear exterior to the schematic front.
  const explodedPose = [
    { x: 0, y: 0, z: -.18, rx: -.025, ry: -.025, rz: -.01 },
    // Present the display in front of the chassis and the rear cover.
    { x: 1.42, y: .16, z: 1.45, rx: .055, ry: .035, rz: .035 },
    { x: -.78, y: -.35, z: .72, rx: -.035, ry: -.02, rz: -.028 },
    { x: -.78, y: .68, z: 1.08, rx: .045, ry: -.035, rz: .025 },
    // Keep the full-height cover clear of the cradle, including its focus scale.
    { x: .05, y: .35, z: -.65, rx: -.02, ry: -.03, rz: .015 },
    { x: .93, y: 1.0, z: .86, rx: .025, ry: Math.PI + .045, rz: -.025 },
  ]
  const focusLayer = index => {
    if (index === null || index === undefined || !layers[index] || assembled) return
    idleTween?.pause()
    scanTween?.pause()
    focusedLayer = index
    const partKey = ['chassis', 'display', 'battery', 'board', 'back', 'cameras'][index]
    partButtons.forEach(part => part.setAttribute('aria-pressed', String(part.dataset.partKey === partKey)))
    const layer = layers[index]
    scene.updateMatrixWorld(true)
    const target = layer.getWorldPosition(new THREE.Vector3())
    focusTween?.kill()
    focusTween = gsap.timeline({ onUpdate: draw, onComplete: () => { focusTween = null; draw() } })
      .to(camera.position, { x: target.x + 2.2, y: target.y + 2.6, z: cameraRest.z < 0 ? -9.1 : 9.1, duration: reduced ? 0 : .72, ease: 'power3.inOut' }, 0)
      .to(cameraTarget, { x: target.x, y: target.y, z: target.z, duration: reduced ? 0 : .72, ease: 'power3.inOut' }, 0)
    // A single timeline owns every scale. Switching rapidly between parts can
    // interrupt the previous camera move without leaving an enlarged old part.
    layers.forEach((item, i) => {
      const scale = i === index ? 1.1 : 1
      focusTween.to(item.scale, { x: scale, y: scale, z: scale, duration: reduced ? 0 : .48, ease: 'power3.out' }, 0)
    })
    const labels = ['Estructura', 'Pantalla', 'Batería', 'Placa', 'Carcasa', 'Cámaras']
    status.textContent = `${labels[index]} en primer plano. Selecciona otra pieza o Vista completa para volver al conjunto.`
    if (!isVisible || document.hidden) focusTween.pause()
  }
  const resetFocus = () => {
    focusTween?.kill(); focusTween = null
    focusedLayer = null
    if (!camera || assembled) return
    focusTween = gsap.timeline({ onUpdate: draw, onComplete: () => { focusTween = null; draw(); startIdle() } })
      .to(camera.position, { x: cameraExplore.x, y: cameraExplore.y, z: cameraExplore.z, duration: reduced ? 0 : .48, ease: 'power2.inOut' }, 0)
      .to(cameraTarget, { x: 0, y: 0, z: 0, duration: reduced ? 0 : .48, ease: 'power2.inOut' }, 0)
    layers.forEach(layer => focusTween.to(layer.scale, { x: 1, y: 1, z: 1, duration: reduced ? 0 : .28, ease: 'power2.out' }, 0))
    status.textContent = 'Vista completa de los componentes esquemáticos. Selecciona una pieza para inspeccionarla.'
    if (!isVisible || document.hidden) focusTween.pause()
  }
  // A recorded movement orbits the same phone to a stable inspection angle.
  // It only moves the camera and the body pose: layers, assembly state, status
  // copy, history and dates stay untouched.
  const focusMovement = (movementStatus, { immediate = false } = {}) => {
    if (disposed || !camera || !phoneRoot || !movementStatus) return false
    activeMovement = { status: movementStatus, immediate }
    if (tween) { pendingMovement = { status: movementStatus, immediate }; return true }
    pendingMovement = null
    idleTween?.pause()
    scanTween?.pause()
    focusTween?.kill(); focusTween = null
    drag = null
    if (renderer?.domElement) renderer.domElement.style.cursor = 'grab'
    const baseYaw = exteriorYaw + (profile && !assembled ? Math.PI : 0)
    const view = getMovementInspectionPose(movementStatus, {
      yaw: baseYaw,
      camera: assembled ? cameraRest : cameraExplore,
      assembled,
    })
    movementTween?.kill()
    const duration = reduced || immediate ? 0 : .82
    movementTween = gsap.timeline({
      onUpdate: draw,
      onComplete: () => {
        movementTween = null
        rotationOrigin = new THREE.Euler(phoneRoot.rotation.x, phoneRoot.rotation.y, phoneRoot.rotation.z)
        draw()
        if (isVisible && !document.hidden) startIdle()
      },
    })
      .to(phoneRoot.rotation, { x: view.phone.x, y: view.phone.y, z: view.phone.z, duration, ease: 'power3.inOut' }, 0)
      .to(camera.position, { x: view.camera.x, y: view.camera.y, z: view.camera.z, duration: duration ? duration + .14 : 0, ease: 'power3.inOut' }, 0)
      .to(cameraTarget, { x: view.target.x, y: view.target.y, z: view.target.z, duration, ease: 'power3.inOut' }, 0)
    if (!isVisible || document.hidden) movementTween.pause()
    return true
  }
  const selectLayer = index => {
    if (index === undefined) {
      pendingFocus = null
      partButtons.forEach(part => part.setAttribute('aria-pressed', 'false'))
      if (!tween) resetFocus()
      return
    }
    if (assembled) { pendingFocus = index; onClick(); return }
    if (tween) { pendingFocus = index; return }
    if (focusedLayer === index) { partButtons.forEach(part => part.setAttribute('aria-pressed', 'false')); resetFocus(); return }
    focusLayer(index)
  }
  const onPartClick = event => selectLayer(({ chassis: 0, display: 1, battery: 2, board: 3, back: 4, cameras: 5 })[event.currentTarget.dataset.partKey])
  const onClick = event => {
    if (event) pendingFocus = null
    // Keep a fixed exterior heading across interrupted transitions. The mode
    // turn is a target, not another half-turn added to the current animation.
    movementTween?.kill(); movementTween = null
    pendingMovement = null
    if (!tween && !activeMovement) exteriorYaw = getExteriorYawFromPose(phoneRoot.rotation.y, { profiled: Boolean(profile), assembled })
    updateState(!assembled)
    idleTween?.pause()
    scanTween?.pause()
    // Preserve the currently visible idle angle so toggling assembly does not
    // snap back to the original pose before the transition begins.
    rotationOrigin = new THREE.Euler(phoneRoot.rotation.x, phoneRoot.rotation.y, phoneRoot.rotation.z)
    tween?.kill()
    focusTween?.kill(); focusTween = null
    focusedLayer = null
    partButtons.forEach(part => part.setAttribute('aria-pressed', 'false'))
    drag = null
    phoneRoot.rotation.copy(rotationOrigin)
    const inspectYaw = exteriorYaw + (profile && !assembled ? Math.PI : 0)
    screenSweep.position.x = -.75
    screenSweepMat.opacity = assembled ? 0 : .26
    dockPulse.visible = true
    dockPulse.scale.setScalar(assembled ? .62 : .48)
    dockPulseMat.opacity = reduced ? 0 : assembled ? .5 : .62
    tween = gsap.timeline({ onUpdate: draw, onComplete: () => {
      layers.forEach((layer, i) => {
        const pose = assembled ? { x: 0, y: 0, z: assembledZ[i], rx: 0, ry: 0, rz: 0 } : explodedPose[i]
        layer.position.set(pose.x, pose.y, pose.z)
        layer.rotation.set(pose.rx, pose.ry, pose.rz)
        layer.scale.set(1, 1, 1)
      })
      cameraTarget.set(0, 0, 0)
      camera.position.copy(assembled ? cameraRest : cameraExplore)
      rotationOrigin.y = inspectYaw
      phoneRoot.rotation.copy(rotationOrigin)
      screenSweepMat.opacity = 0
      dockPulseMat.opacity = 0
      dockPulse.visible = false
      tween = null; draw()
      if (pendingFocus !== null) { const focus = pendingFocus; pendingFocus = null; focusLayer(focus) }
      if (pendingMovement) {
        const pending = pendingMovement
        pendingMovement = null
        if (focusMovement(pending.status, { immediate: pending.immediate })) return
      }
      if (activeMovement && focusMovement(activeMovement.status, { immediate: activeMovement.immediate })) return
      startIdle()
    } })
    if (!assembled) {
      tween.to(screenSweep.position, { x: .38, duration: reduced ? 0 : .72, ease: 'power2.inOut' }, reduced ? 0 : .1)
      tween.to(screenSweepMat, { opacity: 0, duration: reduced ? 0 : .28, ease: 'power1.out' }, reduced ? 0 : .62)
    }
    tween.to(dockPulse.scale, {
      x: assembled ? 1.4 : 1.65,
      y: assembled ? 1.4 : 1.65,
      z: assembled ? 1.4 : 1.65,
      duration: reduced ? 0 : .72,
      ease: 'power2.out',
    }, 0).to(dockPulseMat, { opacity: 0, duration: reduced ? 0 : .58, ease: 'power1.out' }, reduced ? 0 : .08)
    layers.forEach((layer, i) => tween.to(layer.scale, {
      x: 1, y: 1, z: 1, duration: reduced ? 0 : .28, ease: 'power2.out',
    }, 0).to(layer.position, {
      x: assembled ? 0 : explodedPose[i].x,
      y: assembled ? 0 : explodedPose[i].y,
      z: assembled ? assembledZ[i] : explodedPose[i].z,
      duration: reduced ? 0 : assembled ? .68 : .9,
      ease: assembled ? 'back.in(1.05)' : 'power3.inOut',
    }, reduced ? 0 : assembled ? .17 + (layers.length - 1 - i) * .075 : .05 + i * .105)
      .to(layer.rotation, {
        x: assembled ? 0 : explodedPose[i].rx,
        y: assembled ? 0 : explodedPose[i].ry,
        z: assembled ? 0 : explodedPose[i].rz,
        duration: reduced ? 0 : assembled ? .68 : .9,
        ease: assembled ? 'power3.inOut' : 'power3.out',
      }, reduced ? 0 : assembled ? .17 + (layers.length - 1 - i) * .075 : .05 + i * .105))
    tween.to(camera.position, {
      x: assembled ? cameraRest.x : cameraExplore.x,
      y: assembled ? cameraRest.y : cameraExplore.y,
      z: assembled ? cameraRest.z : cameraExplore.z,
      duration: reduced ? 0 : .96,
      ease: 'power2.inOut',
    }, 0)
    tween.to(cameraTarget, { x: 0, y: 0, z: 0, duration: reduced ? 0 : .68, ease: 'power3.inOut' }, 0)
    tween.to(phoneRoot.rotation, {
      y: inspectYaw,
      duration: reduced ? 0 : .94,
      ease: 'power2.inOut',
    }, 0)
    tween.to(camera, {
      fov: assembled ? assembledFov : explodedFov,
      duration: reduced ? 0 : .96,
      ease: 'power2.inOut',
      onUpdate: () => camera.updateProjectionMatrix(),
    }, 0)
    if (!isVisible || document.hidden) tween.pause()
  }

  try {
  camera = new THREE.PerspectiveCamera(assembledFov, 1, .1, 40)
  // Pull the camera in and lower its orbit to make the device feel substantial
  // in the narrow portal stage while preserving room for the exploded parts.
  cameraRest = new THREE.Vector3(2.8, 3.65, profile ? -11.8 : 11.8)
  // A gentle, reversible orbit keeps the target at stage center while the
  // front glass and internal parts separate.
  cameraExplore = new THREE.Vector3(3.9, 4.15, profile ? -11.35 : 11.35)
  camera.position.set(3.8, 5.3, profile ? -13.1 : 13.1)
  camera.lookAt(0, 0, 0)
  renderer = new THREE.WebGPURenderer({ alpha: true, antialias: true })
  await renderer.init()
  // GPU initialization can outlive the route that requested this scene.
  if (!isActive()) { cleanupScene(); return () => {} }
  // The SVG control stays live while the GPU initializes; read its latest
  // state now so an early toggle is carried into the first 3D frame.
  assembled = readAssemblyState(assembled, getAssembled)
  camera.fov = assembled ? assembledFov : explodedFov
  camera.updateProjectionMatrix()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, matchMedia('(max-width: 700px)').matches ? 1.25 : 1.7))
  renderer.setSize(1, 1, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.1
  environmentTexture = createStudioEnvironment()
  if (environmentTexture) {
    scene.environment = environmentTexture
    scene.environmentIntensity = .68
  }
  renderer.domElement.className = 'phone-canvas'
  renderer.domElement.setAttribute('aria-hidden', 'true')
  renderer.domElement.dataset.renderer = renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2-fallback'
  host.append(renderer.domElement)
  if (partButtons.length) annotations = mountPhoneCallouts(host)

  scene.add(new THREE.HemisphereLight(0xf5f0e7, 0x272b2c, 2.25))
  const key = new THREE.DirectionalLight(0xffd27a, 4.25)
  key.position.set(-4, 7, 8); scene.add(key)
  const fill = new THREE.DirectionalLight(0xe0e8ef, 2.5)
  fill.position.set(5, 3, -4); scene.add(fill)
  const rim = new THREE.DirectionalLight(0xfff2d6, 1.8)
  rim.position.set(1, -5, 5); scene.add(rim)

  const material = (color, roughness = .48, metalness = .18) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness })
    mats.push(m); return m
  }
  const metal = material(profile?.body ?? 0xe1dfd6, .2, .82)
  const darkMetal = material(0x303638, .3, .72)
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x202a2e, roughness: .16, metalness: .08, clearcoat: 1, clearcoatRoughness: .08, emissive: 0x111a1b, emissiveIntensity: .28 })
  mats.push(glass)
  const glowLine = material(0xe7b94a, .32, .42)
  const jade = material(0x7fc7b5, .42, .28)
  const violet = material(0x78628a, .42, .42)
  const pcb = material(0x343b3b, .44, .3)
  const batteryMat = material(0xd5d0c2, .28, .52)
  const chip = material(0x4d5551, .28, .74)
  layers = []
  const makeLayer = (name, z) => {
    const group = new THREE.Group(); group.name = name; group.position.z = z; phoneRoot.add(group); layers.push(group); return group
  }
  const mesh = (parent, geometry, mat, pos = [0, 0, 0]) => {
    const m = new THREE.Mesh(geometry, mat); m.position.set(...pos); parent.add(m); return m
  }
  const cube = (parent, dims, mat, pos, radius = .05) => mesh(parent, makeRounded(...dims, radius), mat, pos)
  const cylinder = (parent, radiusTop, radiusBottom, height, mat, pos, segments = 40) =>
    mesh(parent, new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), mat, pos)
  phoneRoot = new THREE.Group()
  phoneRoot.name = 'repair-phone'
  if (profile?.exact && profile.dimensionsMm) {
    // Normalize exact catalog profiles from manufacturer body dimensions.
    // Unknown models keep the honest illustrative silhouette.
    phoneRoot.scale.set(
      profile.dimensionsMm.width / 71.5,
      profile.dimensionsMm.height / 146.7,
      // The assembled front/back span is .415 before scaling. Match its
      // thickness to the same physical unit used by the 2.12-wide body.
      (profile.dimensionsMm.depth * 2.12 / 71.5) / .415,
    )
  }
  scene.add(phoneRoot)

  // A compact repair cradle anchors the phone like a game-world workbench and
  // gives the one-shot click response a physical surface to travel across.
  const dockTop = -2.175 * phoneRoot.scale.y
  cylinder(scene, 1.34, 1.46, .14, darkMetal, [0, dockTop - .135, 0])
  const dockSurface = material(0xb9b3a4, .55, .62)
  cylinder(scene, 1.26, 1.34, .05, dockSurface, [0, dockTop - .04, 0])
  const dockTrim = mesh(scene, new THREE.TorusGeometry(1.18, .018, 6, 48), glowLine, [0, dockTop - .009, 0])
  dockTrim.rotation.x = Math.PI / 2
  dockPulseMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0, depthWrite: false })
  mats.push(dockPulseMat)
  dockPulse = mesh(scene, new THREE.TorusGeometry(.82, .022, 6, 48), dockPulseMat, [0, dockTop + .001, 0])
  dockPulse.rotation.x = Math.PI / 2
  dockPulse.visible = false

  const chassis = makeLayer('chassis', -.15)
  const frameRadius = profile?.frameRadius ?? .23
  cube(chassis, [2.12, 4.35, .2], metal, [0, 0, 0], frameRadius)
  cube(chassis, [1.98, 4.2, .09], darkMetal, [0, 0, .11], frameRadius * .88)
  cube(chassis, [1.87, 4.05, .05], glowLine, [0, 0, .17], frameRadius * .78)
  cube(chassis, [1.81, 3.99, .05], darkMetal, [0, 0, .205], frameRadius * .72)
  // Side controls machined into the continuous shell.
  cube(chassis, [.07, .44, .12], glowLine, [-1.07, .72, .03], .035)
  cube(chassis, [.07, .7, .12], metal, [1.07, .45, .03], .035)
  cube(chassis, [.07, .48, .12], metal, [1.07, -.26, .03], .035)
  // Small fasteners sit in the exposed repair frame.
  const screw = material(0xf1e7d2, .2, .86)
  const screwSlot = material(0x50585a, .36, .5)
  for (const x of [-.98, .98]) for (const y of [-1.9, 1.9]) {
    const head = cylinder(chassis, .055, .055, .025, screw, [x, y, .235], 16)
    head.rotation.x = Math.PI / 2
    cube(chassis, [.055, .009, .008], screwSlot, [x, y, .25], .004)
  }
  const lensMat = new THREE.MeshPhysicalMaterial({ color: 0x102027, roughness: .1, metalness: .18, clearcoat: 1, emissive: 0x06131b, emissiveIntensity: .25 })
  mats.push(lensMat)
  const lensRim = material(profile?.accent ?? 0xb9a877, .22, .8)
  const cameraLayer = makeLayer('camera-system', -.18)
  const cameraStyle = profile?.camera ?? 'generic-triple'
  const cameraSets = {
    'iphone-diagonal-dual': { island: [.96, .96, .035], centerX: .49, lenses: [[.55, 1.7, .14], [.2, 1.34, .14]] },
    'moto-round-dual': { island: [.58, .58, .035], centerX: .49, lenses: [[.49, 1.58, .14], [.49, 1.22, .14]] },
    'vertical-triple': { island: [.66, 1.82, .11], centerX: .67, lenses: [[.67, 1.8, .135], [.67, 1.42, .135], [.67, 1.04, .135]] },
    'separate-triple': { island: [.62, 1.86, .08], centerX: .67, lenses: [[.67, 1.8, .135], [.67, 1.38, .135], [.67, .96, .135]] },
    'pixel-bar-dual': { island: [1.78, .48, .14], centerX: 0, lenses: [[.49, 1.58, .125], [-.02, 1.58, .125]] },
    'square-triple': { island: [1.12, 1.35, .13], centerX: .49, lenses: [[.61, 1.77, .13], [.25, 1.77, .13], [.61, 1.39, .13]] },
    'generic-triple': { island: [.84, 1.54, .12], centerX: .49, lenses: [[.66, 1.75, .14], [.28, 1.75, .14], [.66, 1.37, .14]] },
  }
  // All rear coordinates use +X = viewer-left. No signed layer scale is needed,
  // so focusing, assembling and resetting cannot mirror lenses or the flash.
  const cameraSet = { ...(cameraSets[cameraStyle] || cameraSets['generic-triple']), ...profile?.cameraGeometry }
  const center = cameraSet.center ?? [cameraSet.centerX, 1.4]
  // Rounded outline in the same arc grammar as makeRounded, so machined parts
  // keep one style. Returns the path so it can outline a bridge or cut a hole.
  const roundedBoxPath = (path, cx, cy, w, h, r) => {
    const radius = Math.min(Math.max(.0001, r), w / 2, h / 2)
    path.moveTo(cx - w / 2 + radius, cy - h / 2)
    path.lineTo(cx + w / 2 - radius, cy - h / 2)
    path.absarc(cx + w / 2 - radius, cy - h / 2 + radius, radius, -Math.PI / 2, 0, false)
    path.lineTo(cx + w / 2, cy + h / 2 - radius)
    path.absarc(cx + w / 2 - radius, cy + h / 2 - radius, radius, 0, Math.PI / 2, false)
    path.lineTo(cx - w / 2 + radius, cy + h / 2)
    path.absarc(cx - w / 2 + radius, cy + h / 2 - radius, radius, Math.PI / 2, Math.PI, false)
    path.lineTo(cx - w / 2, cy - h / 2 + radius)
    path.absarc(cx - w / 2 + radius, cy - h / 2 + radius, radius, Math.PI, Math.PI * 1.5, false)
    path.closePath()
    return path
  }
  // Extrude like makeRounded does: nominals pre-shrunk by the bevel so the
  // silhouette keeps its catalog dimensions after centering.
  const extruded = (path, depth, bevel) => {
    const geometry = new THREE.ExtrudeGeometry(path, {
      depth: Math.max(.001, depth - bevel * 2),
      bevelEnabled: true,
      bevelSegments: 2,
      steps: 1,
      bevelSize: bevel,
      bevelThickness: bevel,
      curveSegments: 24,
    })
    geometry.center()
    geometry.computeVertexNormals()
    return geometry
  }
  if (cameraSet.housing === 'metal-bridge' || cameraStyle === 'pixel-bar-dual') {
    const island = cameraSet.island
    const window = cameraSet.window ?? { center: [.22, 1.5], size: [1.25, .34], radius: .17 }
    // Pixel signature camera bar: the dark seat ahead of the window survives
    // from the stepped base; now the metal cover is pierced by the pill window,
    // so the dark glass sits recessed inside the bridge instead of standing
    // proud of it. Fully rounded bar ends match the catalog silhouette.
    if (cameraSet.bridgeBase) {
      cube(cameraLayer, cameraSet.bridgeBase, darkMetal, [...center, -.085], (cameraSet.radius ?? .16) + .035)
    }
    const bevel = .012
    const barRadius = Math.min(island[1] / 2, .235)
    const barShape = new THREE.Shape()
    roundedBoxPath(barShape, 0, 0, island[0] - bevel * 2, island[1] - bevel * 2, barRadius - bevel)
    // The aperture keeps the catalog window footprint exactly; its rim
    // countersinks slightly under the bevel as a machined reveal.
    const windowHole = new THREE.Path()
    roundedBoxPath(windowHole, window.center[0] - center[0], window.center[1] - center[1],
      window.size[0], window.size[1], window.radius)
    barShape.holes.push(windowHole)
    mesh(cameraLayer, extruded(barShape, island[2], bevel), lensRim, [...center, -.145])
    // The dark glass pill rides .02 behind the bridge plane and overlaps the
    // cut walls by .01 per side, so no seam opens between glass and metal.
    // Its back buries into the dark seat, closing the recess from behind.
    const pillPad = .01
    const pillShape = new THREE.Shape()
    roundedBoxPath(pillShape, 0, 0, window.size[0] + pillPad * 2, window.size[1] + pillPad * 2, window.radius + pillPad)
    mesh(cameraLayer, extruded(pillShape, .08, .008), lensMat, [window.center[0], window.center[1], -.15])
  } else if (cameraSet.housing === 'glass-square' || cameraSet.housing === 'rounded-rectangle') {
    const cameraPlate = material(profile?.back ?? 0xc9d0d5, .25, .18)
    cube(cameraLayer, cameraSet.island, cameraPlate, [...center, -.12], cameraSet.radius)
  } else if (cameraStyle === 'iphone-diagonal-dual') {
    const cameraPlate = material(profile?.back ?? 0xc9d0d5, .25, .18)
    cube(cameraLayer, [.96, .96, .055], cameraPlate, [...center, -.12], .21)
  } else if (cameraStyle === 'moto-round-dual') {
    const cameraPlate = cylinder(cameraLayer, .58, .58, .035, metal, [cameraSet.centerX, 1.4, -.11], 40)
    cameraPlate.rotation.x = Math.PI / 2
    const cameraGlass = cylinder(cameraLayer, .49, .49, .025, darkMetal, [cameraSet.centerX, 1.4, -.14], 40)
    cameraGlass.rotation.x = Math.PI / 2
  } else if (!['vertical-triple', 'separate-triple'].includes(cameraStyle)) {
    cube(cameraLayer, [cameraSet.island[0], cameraSet.island[1], .04], darkMetal, [cameraSet.centerX, 1.4, -.12], .14)
  }
  const flashSpec = cameraSet.flash ?? (['vertical-triple', 'separate-triple'].includes(cameraStyle) ? [.27, 1.8, .06] : null)
  if (flashSpec) {
    const [x, y, radius] = flashSpec
    const flashMat = material(0xfff1cf, .35, .05)
    // The flash sits on the bridge metal as a machined disc: the ring stands
    // just proud of the cover plane and the lamp nests inside it, mirroring
    // the recessed lens stacks instead of one more proud block.
    const rimZ = cameraStyle === 'pixel-bar-dual' ? -.201 : -.163
    const lampZ = cameraStyle === 'pixel-bar-dual' ? -.204 : -.182
    const flashRim = cylinder(cameraLayer, radius, radius, .026, lensRim, [x, y, rimZ], 24)
    flashRim.rotation.x = Math.PI / 2
    const flash = cylinder(cameraLayer, radius * .79, radius * .79, .014, flashMat, [x, y, lampZ], 24)
    flash.rotation.x = Math.PI / 2
  }
  // Pixel lenses mount on the recessed pill: their crowns sit just inside the
  // bridge plane, so both lenses read as sunk into the dark window.
  const lensZ = cameraStyle === 'pixel-bar-dual' ? -.198 : -.175
  for (const [x, y, radius] of cameraSet.lenses) {
    const ringWidth = cameraStyle === 'pixel-bar-dual' ? .009 : .012
    const glassDepth = cameraStyle === 'pixel-bar-dual' ? .018 : .024
    mesh(cameraLayer, new THREE.TorusGeometry(radius, ringWidth, 6, 24), lensRim, [x, y, lensZ])
    const lens = cylinder(cameraLayer, radius * .86, radius * .86, glassDepth, lensMat, [x, y, lensZ + .003], 24)
    lens.rotation.x = Math.PI / 2
    // Place a subtle glass glint above each lens without a texture or shader.
    // Pixel glints hug the recessed lens glass instead of floating off the bar.
    const glintZ = cameraStyle === 'pixel-bar-dual' ? lensZ - .006 : lensZ - .016
    cube(cameraLayer, [radius * .32, .009, .004], metal, [x - radius * .18, y + radius * .2, glintZ], .004)
  }
  // Glass stays as one uninterrupted front face in the assembled state.
  const display = makeLayer('display', .08)
  cube(display, [1.79, 3.96, .115], glass, [0, 0, 0], .17)
  if (profile?.front === 'notch') {
    cube(display, [.62, .16, .035], darkMetal, [0, 1.86, .075], .065)
    cube(display, [.17, .018, .01], metal, [0, 1.79, .096], .008)
  } else if (profile) {
    mesh(display, new THREE.CircleGeometry(.082, 24), darkMetal, [0, 1.84, .075])
    mesh(display, new THREE.CircleGeometry(.043, 18), lensMat, [0, 1.84, .078])
  } else {
    cube(display, [.5, .055, .028], darkMetal, [0, 1.78, .07], .025)
    cube(display, [.14, .035, .03], jade, [0, 1.72, .07], .015)
    mesh(display, new THREE.CircleGeometry(.052, 18), darkMetal, [.63, 1.78, .075])
    mesh(display, new THREE.CircleGeometry(.025, 14), glowLine, [.63, 1.78, .078])
  }
  cube(display, [.7, .025, .016], jade, [0, 1.48, .067], .008)
  cube(display, [.88, .018, .012], glowLine, [0, 1.23, .067], .007)
  cube(display, [.56, .03, .016], metal, [-.27, 1.08, .068], .009)
  cube(display, [1.2, .04, .016], jade, [0, .96, .067], .008)
  cube(display, [.73, .025, .016], glowLine, [-.15, .83, .068], .008)
  cube(display, [.12, .12, .02], glowLine, [-.54, .68, .067], .025)
  cube(display, [.12, .12, .02], jade, [-.18, .68, .067], .025)
  cube(display, [.12, .12, .02], violet, [.18, .68, .067], .025)
  cube(display, [.12, .12, .02], glowLine, [.54, .68, .067], .025)
  cube(chassis, [.32, .075, .05], darkMetal, [0, -2.12, .08], .035)
  for (let i = 0; i < 4; i++) mesh(chassis, new THREE.CircleGeometry(.018, 10), screwSlot, [-.32 + i * .11, -2.12, .108])
  const sweepCanvas = document.createElement('canvas')
  sweepCanvas.width = 128; sweepCanvas.height = 8
  const sweepContext = sweepCanvas.getContext('2d')
  if (sweepContext) {
    const gradient = sweepContext.createLinearGradient(0, 0, 128, 0)
    gradient.addColorStop(0, 'rgba(255,255,255,0)')
    gradient.addColorStop(.5, 'rgba(255,255,255,.65)')
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    sweepContext.fillStyle = gradient
    sweepContext.fillRect(0, 0, 128, 8)
    sweepTexture = new THREE.CanvasTexture(sweepCanvas)
  }
  screenSweepMat = new THREE.MeshBasicMaterial({ color: 0xfff1c9, map: sweepTexture, transparent: true, opacity: 0, depthWrite: false })
  mats.push(screenSweepMat)
  screenSweep = mesh(display, new THREE.PlaneGeometry(.65, 3.4), screenSweepMat, [-.75, 0, .075])
  screenSweep.rotation.z = -.14
  // Common schematic components, intentionally shared across catalog profiles.
  const battery = makeLayer('battery', -.1)
  cube(battery, [1.18, 1.95, .15], batteryMat, [-.12, -.53, .04], .13)
  cube(battery, [1.02, .075, .035], darkMetal, [-.12, .17, .13], .025)
  cube(battery, [.78, .055, .025], glowLine, [-.12, -.23, .13], .018)
  cube(battery, [.045, .28, .025], metal, [-.66, -.54, .13], .018)
  cube(battery, [.045, .28, .025], metal, [.42, -.54, .13], .018)
  for (let i = 0; i < 5; i++) cube(battery, [.82, .012, .012], i === 0 ? glowLine : metal, [-.12, -.02 - i * .12, .12], .005)
  const board = makeLayer('logic-board', -.22)
  const boardShape = new THREE.Shape()
  boardShape.moveTo(-.81, .46); boardShape.lineTo(.79, .46); boardShape.lineTo(.79, 1.52)
  boardShape.lineTo(.41, 1.52); boardShape.lineTo(.41, 1.7); boardShape.lineTo(-.17, 1.7)
  boardShape.lineTo(-.17, 1.51); boardShape.lineTo(-.81, 1.51); boardShape.closePath()
  const boardGeo = new THREE.ExtrudeGeometry(boardShape, { depth: .1, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: .035, bevelThickness: .025 })
  boardGeo.computeVertexNormals()
  mesh(board, boardGeo, pcb, [0, 0, .04])
  cube(board, [.57, .57, .12], chip, [.4, 1.03, .19], .07)
  cube(board, [.49, .42, .1], violet, [-.39, 1.08, .18], .05)
  cube(board, [.56, .2, .09], darkMetal, [-.36, .66, .17], .035)
  cube(board, [.22, .18, .075], jade, [.07, .72, .16], .025)
  cube(board, [.3, .08, .06], glowLine, [.35, .79, .16], .018)
  cube(board, [.025, .33, .018], jade, [-.13, 1.02, .15], .006)
  cube(board, [.38, .025, .018], jade, [.28, 1.35, .15], .006)
  for (let i = 0; i < 6; i++) {
    cube(board, [.09, .05, .045], i % 2 ? jade : glowLine, [-.64 + i * .24, .49, .19], .012)
    cube(board, [.075, .045, .04], metal, [.72, .67 + i * .11, .17], .01)
  }
  const backCover = makeLayer('back-cover', -.24)
  const backMat = material(profile?.back ?? profile?.body ?? 0xbabdb8, .18, .34)
  cube(backCover, [1.94, 4.12, .075], backMat, [0, 0, 0], frameRadius * 1.08)
  cube(backCover, [.25, .025, .012], metal, [0, -1.92, .044], .012)
  layers = ['chassis', 'display', 'battery', 'logic-board', 'back-cover', 'camera-system']
    .map(name => phoneRoot.children.find(child => child.name === name)).filter(Boolean)
  // The idle drift is tween-driven and pauses when the stage leaves the viewport.
  rotationOrigin = new THREE.Euler(BASE_SCENE_ROTATION.x, exteriorYaw + (profile && !assembled ? Math.PI : 0), BASE_SCENE_ROTATION.z)
  phoneRoot.rotation.copy(rotationOrigin)
  let viewportWidth = 0, viewportHeight = 0
  const anchorVectors = { 1: new THREE.Vector3(), 2: new THREE.Vector3(), 3: new THREE.Vector3() }
  const focusBox = new THREE.Box3()
  const corner = new THREE.Vector3()
  const updateAnnotations = () => {
    if (!annotations) return
    scene.updateMatrixWorld(true)
    camera.updateMatrixWorld(true)
    anchorVectors[1].set(0, .4, .08)
    anchorVectors[2].set(0, -.7, .18)
    anchorVectors[3].set(0, 1.2, .18)
    Object.entries(anchorVectors).forEach(([index, point]) => layers[index].localToWorld(point).project(camera))
    let focusBounds = null
    if (!assembled && focusedLayer !== null && layers[focusedLayer]) {
      focusBox.setFromObject(layers[focusedLayer])
      focusBounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
      for (let i = 0; i < 8; i++) {
        corner.set(i & 1 ? focusBox.max.x : focusBox.min.x, i & 2 ? focusBox.max.y : focusBox.min.y, i & 4 ? focusBox.max.z : focusBox.min.z).project(camera)
        const x = (corner.x + 1) * viewportWidth / 2, y = (1 - corner.y) * viewportHeight / 2
        focusBounds.left = Math.min(focusBounds.left, x); focusBounds.right = Math.max(focusBounds.right, x)
        focusBounds.top = Math.min(focusBounds.top, y); focusBounds.bottom = Math.max(focusBounds.bottom, y)
      }
    }
    annotations.update({ width: viewportWidth, height: viewportHeight, assembled, focused: focusedLayer, anchors: anchorVectors, focusBounds })
  }
  draw = (force = false) => {
    if (!renderer || lostContext || (!force && (!isVisible || document.hidden))) return
    if (force) {
      if (renderFrame) cancelAnimationFrame(renderFrame)
      renderFrame = 0
      camera.lookAt(cameraTarget)
      renderer.render(scene, camera)
      updateAnnotations()
      return
    }
    if (renderFrame) return
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0
      if (!renderer || lostContext || (!force && (!isVisible || document.hidden))) return
      camera.lookAt(cameraTarget)
      renderer.render(scene, camera)
      updateAnnotations()
    })
  }
  const applySize = rect => {
    if (!rect?.width || !rect?.height) return
    viewportWidth = rect.width; viewportHeight = rect.height
    renderer.setSize(rect.width, rect.height, false)
    camera.aspect = rect.width / rect.height
    camera.updateProjectionMatrix()
  }
  resize = new ResizeObserver(entries => {
    const rect = entries[0]?.contentRect
    applySize(rect)
    draw()
  })
  resize.observe(host)
  applySize(host.getBoundingClientRect())
  visibility = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    isVisible = Boolean(entries[0]?.isIntersecting)
    if (isVisible && !document.hidden) {
      tween?.resume(); focusTween?.resume(); movementTween?.resume()
      if (focusedLayer === null && !focusTween && !movementTween) { idleTween?.resume(); scanTween?.resume() }
      if (!tween && !idleTween && !scanTween && !focusTween && !movementTween) draw()
    } else { tween?.pause(); idleTween?.pause(); scanTween?.pause(); focusTween?.pause(); movementTween?.pause() }
  }) : null
  visibility?.observe(host)
  isVisible = visibility ? false : true
  document.addEventListener('visibilitychange', onVisibility)
  renderer.domElement.addEventListener('webglcontextlost', onContextLost)
  // Drag directly on the decorative canvas to inspect the model. The canvas is
  // aria-hidden; the existing assembly button remains the keyboard-accessible
  // control. `pan-y` preserves vertical page scrolling on touch screens.
  renderer.domElement.style.cursor = 'grab'
  renderer.domElement.style.touchAction = 'pan-y'
  const raycaster = new THREE.Raycaster()
  pointerDown = event => {
    if (event.button !== 0 || disposed) return
    idleTween?.pause()
    scanTween?.pause()
    // Dragging takes over from an in-flight inspection orbit without snapping.
    movementTween?.kill(); movementTween = null
    rotationOrigin = new THREE.Euler(phoneRoot.rotation.x, phoneRoot.rotation.y, phoneRoot.rotation.z)
    if (!activeMovement) exteriorYaw = getExteriorYawFromPose(rotationOrigin.y, { profiled: Boolean(profile), assembled })
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, rect: renderer.domElement.getBoundingClientRect() }
    renderer.domElement.setPointerCapture?.(event.pointerId)
    renderer.domElement.style.cursor = 'grabbing'
  }
  pointerMove = event => {
    if (!drag || drag.id !== event.pointerId || disposed) return
    drag.moved ||= Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 6
    const rotation = getDragRotation({
      deltaX: event.clientX - drag.x,
      deltaY: event.clientY - drag.y,
      width: drag.rect.width,
      height: drag.rect.height,
    }, rotationOrigin)
    phoneRoot.rotation.set(rotation.x, rotation.y, rotationOrigin.z)
    draw()
  }
  pointerUp = event => {
    if (!drag || drag.id !== event.pointerId) return
    const point = getInspectionPoint({ clientX: event.clientX, clientY: event.clientY, startX: drag.x, startY: drag.y, moved: drag.moved }, drag.rect)
    drag = null
    renderer.domElement.style.cursor = 'grab'
    // Keep the chosen inspection angle after release; the next drag builds on
    // this origin so the phone feels directly manipulable instead of snapping back.
    rotationOrigin = new THREE.Euler(phoneRoot.rotation.x, phoneRoot.rotation.y, phoneRoot.rotation.z)
    if (activeMovement) {
      exteriorYaw = getExteriorYawFromPose(phoneRoot.rotation.y, {
        profiled: Boolean(profile), assembled, movementStatus: activeMovement.status,
      })
    }
    // Public scenes keep their simple assembly interaction; only the lab,
    // which also provides equivalent HTML controls, offers mesh selection.
    if (point && !tween && partButtons.length) {
      scene.updateMatrixWorld(true)
      camera.lookAt(cameraTarget)
      camera.updateMatrixWorld(true)
      raycaster.setFromCamera(point, camera)
      const hit = raycaster.intersectObjects(layers, true)[0]
      if (hit) {
        let layer = hit.object
        while (layer.parent && layer.parent !== phoneRoot) layer = layer.parent
        const index = layers.indexOf(layer)
        if (index !== -1) { selectLayer(index); return }
      }
    }
    if (isVisible && !document.hidden) startIdle()
  }
  pointerCancel = event => {
    if (drag?.id === event.pointerId) { drag.moved = true; pointerUp(event) }
  }
  renderer.domElement.addEventListener('pointerdown', pointerDown)
  renderer.domElement.addEventListener('pointermove', pointerMove)
  renderer.domElement.addEventListener('pointerup', pointerUp)
  renderer.domElement.addEventListener('pointercancel', pointerCancel)
  const priorDeviceLost = renderer.onDeviceLost?.bind(renderer)
  renderer.onDeviceLost = info => {
    priorDeviceLost?.(info)
    if (!disposed) {
      lostContext = true
      restoreFallback()
      describeAssembly(button, status, assembled)
      onFallback(assembled)
    }
  }
  // Preserve state selected on SVG while the dynamic import was downloading.
  const pose = assembled ? assembledZ.map(z => ({x:0,y:0,z,rx:0,ry:0,rz:0})) : explodedPose
  layers.forEach((layer, i) => {
    layer.position.set(pose[i].x, pose[i].y, pose[i].z)
    layer.rotation.set(pose[i].rx, pose[i].ry, pose[i].rz)
  })
  camera.position.copy(assembled ? cameraRest : cameraExplore)
  describeAssembly(button, status, assembled)
  host.dataset.assembled = String(assembled)
  host.dataset.rendererBackend = renderer.backend?.isWebGPUBackend ? 'webgpu' : renderer.backend?.isWebGLBackend ? 'webgl2' : 'unknown'
  button.addEventListener('click', onClick)
  partButtons.forEach(part => part.addEventListener('click', onPartClick))
  if (!visibility) isVisible = true
  if (assembled && !reduced && playIntro) {
    layers.forEach((layer, i) => {
      layer.position.set(explodedPose[i].x, explodedPose[i].y, explodedPose[i].z)
      layer.rotation.set(explodedPose[i].rx, explodedPose[i].ry, explodedPose[i].rz)
    })
    camera.position.set(3.8, 5.3, profile ? -13.1 : 13.1)
    camera.fov = explodedFov
    camera.updateProjectionMatrix()
    phoneRoot.rotation.y = exteriorYaw + (profile ? Math.PI : 0)
    screenSweepMat.opacity = .13
    tween = gsap.timeline({ onUpdate: draw, onComplete: () => {
      tween = null; draw()
      if (pendingMovement) {
        const pending = pendingMovement
        pendingMovement = null
        if (focusMovement(pending.status, { immediate: pending.immediate })) return
      }
      startIdle()
    } })
      .to(camera.position, { x: cameraRest.x, y: cameraRest.y, z: cameraRest.z, duration: .95, ease: 'power3.out' }, 0)
      .to(phoneRoot.rotation, { y: exteriorYaw, duration: .95, ease: 'power3.inOut' }, 0)
      .to(camera, { fov: assembledFov, duration: .95, ease: 'power2.inOut', onUpdate: () => camera.updateProjectionMatrix() }, 0)
      .to(screenSweep.position, { x: .38, duration: .85, ease: 'power2.inOut' }, .16)
      .to(screenSweepMat, { opacity: 0, duration: .32 }, .82)
    layers.forEach((layer, i) => tween.to(layer.position, { x: 0, y: 0, z: assembledZ[i], duration: .72, ease: 'back.inOut(1.15)' }, .12 + i * .12).to(layer.rotation, { x: 0, y: 0, z: 0, duration: .72, ease: 'power3.inOut' }, .12 + i * .12))
    if (!isVisible || document.hidden) tween.pause()
  }
  else startIdle()
  // Render one correctly sized frame before the caller hides the SVG fallback.
  // This avoids a blank flash while IntersectionObserver delivers its first entry.
  draw(true)
  onMotionReady({ focusMovement })
  return () => { cleanupScene(); button.setAttribute('aria-pressed', originalButton.pressed ?? 'false'); button.textContent = originalButton.text; status.textContent = originalButton.status }
  } catch (error) {
    cleanupScene()
    button.setAttribute('aria-pressed', originalButton.pressed ?? 'false')
    button.textContent = originalButton.text
    status.textContent = originalButton.status
    throw error
  }
}
