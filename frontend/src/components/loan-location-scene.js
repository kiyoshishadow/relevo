// Interactive state map for loan devices. The layout communicates workflow
// state only; it deliberately does not imply a physical address or GPS fix.
import * as THREE from 'three/webgpu'
import gsap from 'gsap'

const COLORS = Object.freeze({
  floor: 0x242722,
  platform: 0x343833,
  edge: 0x55594f,
  ivory: 0xe9e4d7,
  cream: 0xf4f0e7,
  glass: 0x1e2929,
  green: 0x83a68c,
  greenGlow: 0x426e55,
  amber: 0xd8a84e,
  amberGlow: 0xffc75e,
  retired: 0x9d8170,
  unknown: 0x87908b,
  dark: 0x171b19,
})

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const statusZone = status => status === 'available' ? 'available' : status === 'loaned' ? 'loaned' : status === 'retired' ? 'retired' : 'unknown'

export async function mountLoanLocationScene(host, { devices = [], selectedId = null, onSelect = () => {}, onFallback = () => {}, isActive = () => true } = {}) {
  if (!host) throw new TypeError('loan location scene requires a host element')

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x202420)
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 80)
  const target = new THREE.Vector3(0, 0, 0)
  const cameraRest = new THREE.Vector3(10.4, 11.8, 14.6)
  camera.position.copy(cameraRest)
  camera.lookAt(target)

  const geometries = new Set()
  const materials = new Set()
  const textures = new Set()
  const deviceGroups = new Map()
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
  let motionReduced = motionQuery?.matches ?? false
  let renderer = null
  let rendererReady = false
  let resizeObserver = null
  let raf = 0
  let disposed = false
  let dragging = false
  let pointerDown = null
  let hasDragged = false
  let activeTween = null
  let fallbackCalled = false
  let backend = 'unknown'
  let activeSelection = selectedId === null || selectedId === undefined ? null : String(selectedId)
  let cameraRadius = cameraRest.length()
  const overviewRadius = aspect => Math.max(cameraRest.length(), 17 / (2 * Math.tan(35 * Math.PI / 360) * Math.max(aspect || 1, .1)))
  const overviewPosition = aspect => {
    const radius = overviewRadius(aspect)
    return new THREE.Vector3(Math.sin(yaw) * radius * Math.cos(tilt), radius * Math.sin(tilt), Math.cos(yaw) * radius * Math.cos(tilt))
  }
  const originalTouchAction = host.style.touchAction
  const originalCursor = host.style.cursor
  let selectedRing = null
  let yaw = Math.atan2(cameraRest.x, cameraRest.z)
  let tilt = Math.atan2(cameraRest.y, Math.hypot(cameraRest.x, cameraRest.z))
  const spheres = []

  const geometry = value => { geometries.add(value); return value }
  const material = (color, roughness = 0.58, metalness = 0.18, extra = {}) => {
    const value = new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra })
    materials.add(value)
    return value
  }
  const mats = {
    floor: material(COLORS.floor), platform: material(COLORS.platform, .7, .12), edge: material(COLORS.edge, .48, .28),
    cream: material(COLORS.cream, .28, .42), ivory: material(COLORS.ivory, .36, .42), glass: material(COLORS.glass, .18, .42, { emissive: 0x12201f, emissiveIntensity: .3 }),
    green: material(COLORS.green, .32, .3), amber: material(COLORS.amber, .32, .35, { emissive: COLORS.amber, emissiveIntensity: .25 }),
    amberGlow: material(COLORS.amberGlow, .3, .28, { emissive: COLORS.amberGlow, emissiveIntensity: 1.1 }), retired: material(COLORS.retired, .56, .14),
    unknown: material(COLORS.unknown, .6, .12), dark: material(COLORS.dark, .72, .1),
  }
  const boxGeo = geometry(new THREE.BoxGeometry(1, 1, 1))
  const phoneBodyGeo = geometry(new THREE.BoxGeometry(.43, .79, .075))
  const phoneScreenGeo = geometry(new THREE.BoxGeometry(.365, .69, .012))
  const phoneCameraGeo = geometry(new THREE.CircleGeometry(.026, 12))
  const ringGeo = geometry(new THREE.TorusGeometry(.39, .025, 8, 44))
  const unitGeo = geometry(new THREE.CylinderGeometry(.024, .024, .008, 16))

  const mesh = (parent, geo, mat, position, scale) => {
    const item = new THREE.Mesh(geo, mat)
    item.position.set(...position)
    if (scale) item.scale.set(...scale)
    item.castShadow = false
    item.receiveShadow = false
    parent.add(item)
    return item
  }
  const block = (parent, mat, position, size) => mesh(parent, boxGeo, mat, position, size)

  const ground = new THREE.Group()
  ground.name = 'loan-workshop-layout'
  scene.add(ground)
  block(ground, mats.floor, [0, -.28, 0], [15.8, .24, 11.2])
  block(ground, mats.platform, [-1.6, -.12, .05], [10.7, .22, 8.15])
  block(ground, mats.edge, [-1.6, -.245, .05], [10.76, .05, 8.21])

  // Warm inset strips give the miniature workshop a readable footprint.
  for (const [x, z, sx, sz] of [[-1.6, -4.0, 10.25, .035], [-1.6, 4.1, 10.25, .035], [-6.93, .05, .035, 8.1], [3.73, .05, .035, 8.1]]) {
    block(ground, mats.amber, [x, .005, z], [sx, .018, sz])
  }

  // Low walls and backlit shelf bays define the reserve area without blocking phones.
  for (let i = 0; i < 4; i++) {
    const x = -5.25 + i * .72
    block(ground, mats.edge, [x, .44, -3.42], [.07, .9, .08])
    block(ground, mats.edge, [x, .44, -2.54], [.07, .9, .08])
    block(ground, mats.cream, [x + .36, .2, -3.42], [.65, .05, .08])
    block(ground, mats.cream, [x + .36, .64, -3.42], [.65, .05, .08])
    block(ground, mats.cream, [x + .36, .2, -2.54], [.65, .05, .08])
    block(ground, mats.cream, [x + .36, .64, -2.54], [.65, .05, .08])
  }
  block(ground, mats.edge, [-5.2, .24, -2.98], [.09, .54, 1.0])
  block(ground, mats.edge, [-2.4, .24, -2.98], [.09, .54, 1.0])

  // Reception bench and inspection mat.
  block(ground, mats.edge, [.72, .14, 2.72], [3.05, .22, 1.45])
  block(ground, mats.cream, [.72, .28, 2.72], [3.0, .12, 1.42])
  block(ground, mats.dark, [.72, .365, 2.72], [1.18, .025, .78])
  for (const x of [-.43, 1.87]) for (const z of [2.2, 3.24]) block(ground, mats.edge, [x, -.01, z], [.12, .28, .12])
  // Small segmented floor grid supports spatial reading without labels.
  for (let x = -6; x <= 3; x += 1) block(ground, mats.edge, [x, .001, .05], [.009, .006, 7.65])
  for (let z = -3; z <= 4; z += 1) block(ground, mats.edge, [-1.55, .001, z], [10.05, .006, .009])

  // The customer hand-off is a separate plinth outside the workshop footprint.
  block(ground, mats.edge, [5.15, -.12, -2.55], [3.35, .22, 2.7])
  block(ground, mats.platform, [5.15, -.015, -2.55], [3.29, .09, 2.64])
  block(ground, mats.amber, [3.78, .04, -2.55], [.045, .018, 2.3])
  const routePoints = [new THREE.Vector3(1.0, .045, .95), new THREE.Vector3(2.0, .075, .5), new THREE.Vector3(2.7, .11, -.7), new THREE.Vector3(3.5, .13, -1.9), new THREE.Vector3(4.05, .13, -2.35)]
  const routeCurve = new THREE.CatmullRomCurve3(routePoints)
  const route = new THREE.Mesh(geometry(new THREE.TubeGeometry(routeCurve, 44, .027, 8, false)), mats.amberGlow)
  ground.add(route)
  for (const t of [.14, .39, .64, .88]) {
    const point = routeCurve.getPoint(t)
    const marker = new THREE.Mesh(unitGeo, mats.amberGlow)
    marker.position.copy(point); marker.position.y += .016; ground.add(marker)
  }

  // Retired and unclassified states sit in a quiet review bay beyond the main work zones.
  block(ground, mats.edge, [5.15, -.12, 1.65], [3.35, .22, 2.25])
  block(ground, mats.platform, [5.15, -.015, 1.65], [3.29, .09, 2.19])
  block(ground, mats.edge, [5.15, .05, 1.65], [2.85, .018, .018])
  block(ground, mats.edge, [5.15, -.12, 4.1], [3.35, .22, 1.5])
  block(ground, mats.platform, [5.15, -.015, 4.1], [3.29, .09, 1.44])

  scene.add(new THREE.HemisphereLight(0xf0eadc, 0x282c29, 2.25))
  const keyLight = new THREE.DirectionalLight(0xffd99a, 3.3)
  keyLight.position.set(-5, 11, 7); scene.add(keyLight)
  const fillLight = new THREE.DirectionalLight(0xadd1c1, 1.45)
  fillLight.position.set(7, 6, -6); scene.add(fillLight)
  const zoneLights = [
    [-4.1, 1.3, -3.0, COLORS.green],
    [5.1, 1.15, -2.5, COLORS.amber],
    [5.15, .9, 1.6, COLORS.retired],
  ]
  for (const [x, y, z, color] of zoneLights) {
    const light = new THREE.PointLight(color, 8, 5.2, 2)
    light.position.set(x, y, z); scene.add(light)
  }

  const zoneSlots = {
    available: { x: -4.1, z: -1.5, mat: mats.green, maxColumns: 10, baseDx: .72, baseDz: .79 },
    loaned: { x: 5.15, z: -2.55, mat: mats.amber, maxColumns: 10, baseDx: .42, baseDz: .4 },
    retired: { x: 5.15, z: 1.65, mat: mats.retired, maxColumns: 10, baseDx: .42, baseDz: .4 },
    unknown: { x: 5.15, z: 4.1, mat: mats.unknown, maxColumns: 10, baseDx: .42, baseDz: .4 },
  }
  const zoneCounts = { available: 0, loaned: 0, retired: 0, unknown: 0 }
  const deviceList = Array.isArray(devices) ? devices.slice(0, 50) : []
  for (const device of deviceList) if (device?.id !== null && device?.id !== undefined) zoneCounts[statusZone(device.status)]++
  for (const [name, slot] of Object.entries(zoneSlots)) {
    const count = zoneCounts[name]
    slot.columns = Math.min(slot.maxColumns, Math.max(1, Math.ceil(Math.sqrt(count * 2))))
    slot.rows = Math.max(1, Math.ceil(count / slot.columns))
    slot.dx = count > 9 ? slot.baseDx * (name === 'available' ? .72 : .82) : slot.baseDx
    slot.dz = count > 9 ? slot.baseDz * (name === 'available' ? .7 : .82) : slot.baseDz
    slot.scale = count > 9 ? .6 : count === 1 ? 1.35 : 1
  }
  zoneCounts.available = zoneCounts.loaned = zoneCounts.retired = zoneCounts.unknown = 0
  for (const device of deviceList) {
    if (device?.id === null || device?.id === undefined) continue
    const zoneName = statusZone(device.status)
    const slot = zoneSlots[zoneName]
    const index = zoneCounts[zoneName]++
    const col = index % slot.columns
    const row = Math.floor(index / slot.columns)
    const group = new THREE.Group()
    group.name = `loan-device-${String(device.id)}`
    group.userData.deviceId = String(device.id)
    group.userData.zone = zoneName
    const zoneCenterZ = slot.z + (slot.rows - 1) * slot.dz / 2
    group.position.set(slot.x + (col - (slot.columns - 1) / 2) * slot.dx, .06, zoneCenterZ - row * slot.dz)
    const bodyMat = zoneName === 'available' ? mats.ivory : zoneName === 'loaned' ? mats.cream : zoneName === 'retired' ? mats.retired : mats.unknown
    mesh(group, phoneBodyGeo, bodyMat, [0, .43, 0])
    mesh(group, phoneScreenGeo, mats.glass, [0, .43, .044])
    const cameraDot = new THREE.Mesh(phoneCameraGeo, mats.dark)
    cameraDot.position.set(0, .765, .052); group.add(cameraDot)
    const base = new THREE.Mesh(unitGeo, slot.mat)
    base.position.set(0, .018, 0); group.add(base)
    const glow = new THREE.Mesh(unitGeo, slot.mat)
    glow.position.set(0, .03, 0); glow.scale.set(1.7, .3, 1.7); group.add(glow)
    if (slot.scale !== 1) group.scale.setScalar(slot.scale)
    ground.add(group)
    deviceGroups.set(String(device.id), group)
    spheres.push(group)
  }

  const addZoneLabel = (text, position, accent) => {
    const canvas = document.createElement('canvas')
    canvas.width = 640; canvas.height = 160
    const context = canvas.getContext('2d')
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = 'rgba(23, 27, 25, 0.92)'
    context.beginPath(); context.roundRect(8, 8, 624, 144, 22); context.fill()
    context.fillStyle = accent
    context.beginPath(); context.roundRect(8, 8, 14, 144, 7); context.fill()
    context.fillStyle = '#f4f0e7'
    context.font = '600 48px Archivo, Arial, sans-serif'
    context.textBaseline = 'middle'
    context.fillText(text, 48, 80, 555)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    textures.add(texture)
    const labelMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
    materials.add(labelMaterial)
    const label = new THREE.Sprite(labelMaterial)
    label.position.set(...position)
    label.scale.set(3.25, .8, 1)
    ground.add(label)
  }
  addZoneLabel('RESERVA', [-4.1, 1.05, -3.56], '#83a68c')
  addZoneLabel('CON CLIENTE', [5.15, .76, -3.7], '#d8a84e')
  addZoneLabel('FUERA DE SERVICIO', [5.15, .76, .48], '#b79887')
  if (zoneCounts.unknown > 0) addZoneLabel('SIN CLASIFICAR', [5.15, .76, 3.44], '#aab2ad')

  const selection = new THREE.Mesh(ringGeo, mats.amberGlow)
  selection.rotation.x = -Math.PI / 2
  selection.position.y = .055
  selection.visible = false
  ground.add(selection)
  selectedRing = selection

  const render = () => {
    raf = 0
    if (disposed || !rendererReady || !renderer || !isActive() || document.hidden) return
    try { renderer.render(scene, camera) } catch (error) { failToFallback(error) }
  }
  const requestRender = () => {
    if (!raf && rendererReady && !disposed && isActive() && !document.hidden) raf = requestAnimationFrame(render)
  }
  const setCamera = () => {
    camera.position.set(target.x + Math.sin(yaw) * cameraRadius * Math.cos(tilt), target.y + cameraRadius * Math.sin(tilt), target.z + Math.cos(yaw) * cameraRadius * Math.cos(tilt))
    camera.lookAt(target)
    requestRender()
  }
  const setPoseInstant = id => {
    const group = id === null ? null : deviceGroups.get(String(id))
    if (selectedRing) {
      selectedRing.visible = Boolean(group)
      if (group) {
        selectedRing.position.x = group.position.x
        selectedRing.position.z = group.position.z
        selectedRing.scale.setScalar(group.scale.x)
      }
    }
    cameraRadius = group ? 12.8 : overviewRadius(camera.aspect)
    if (group) target.set(group.position.x, .1, group.position.z)
    else target.set(0, 0, 0)
    if (!group) {
      yaw = Math.atan2(cameraRest.x, cameraRest.z)
      tilt = Math.atan2(cameraRest.y, Math.hypot(cameraRest.x, cameraRest.z))
      camera.position.copy(overviewPosition(camera.aspect))
    } else {
      camera.position.set(target.x + Math.sin(yaw) * cameraRadius * Math.cos(tilt), target.y + cameraRadius * Math.sin(tilt), target.z + Math.cos(yaw) * cameraRadius * Math.cos(tilt))
    }
    camera.lookAt(target)
    requestRender()
  }
  const focus = id => {
    if (id === null || id === undefined) {
      activeSelection = null
      activeTween?.kill(); activeTween = null
      if (motionReduced) { setPoseInstant(null); return }
      const nextTarget = { x: target.x, y: target.y, z: target.z }
      const nextCamera = { x: camera.position.x, y: camera.position.y, z: camera.position.z }
      selectedRing.visible = false
      cameraRadius = overviewRadius(camera.aspect)
      const homePosition = overviewPosition(camera.aspect)
      activeTween = gsap.timeline({ onUpdate: () => { target.set(nextTarget.x, nextTarget.y, nextTarget.z); camera.position.set(nextCamera.x, nextCamera.y, nextCamera.z); camera.lookAt(target); requestRender() }, onComplete: () => { activeTween = null; setPoseInstant(null) } })
      activeTween.to(nextTarget, { x: 0, y: 0, z: 0, duration: .65, ease: 'power2.inOut' }, 0)
      activeTween.to(nextCamera, { x: homePosition.x, y: homePosition.y, z: homePosition.z, duration: .65, ease: 'power2.inOut' }, 0)
      return
    }
    const group = deviceGroups.get(String(id))
    if (!group) return
    activeSelection = String(id)
    selectedRing.position.x = group.position.x
    selectedRing.position.z = group.position.z
    selectedRing.scale.setScalar(group.scale.x)
    selectedRing.visible = true
    cameraRadius = 12.8
    if (motionReduced) { setPoseInstant(activeSelection); return }
    activeTween?.kill()
    const nextTarget = { x: target.x, y: target.y, z: target.z }
    const nextCamera = { x: camera.position.x, y: camera.position.y, z: camera.position.z }
    activeTween = gsap.timeline({ onUpdate: () => { target.set(nextTarget.x, nextTarget.y, nextTarget.z); camera.position.set(nextCamera.x, nextCamera.y, nextCamera.z); camera.lookAt(target); requestRender() }, onComplete: () => { activeTween = null } })
    activeTween.to(nextTarget, { x: group.position.x, y: .1, z: group.position.z, duration: .72, ease: 'power2.inOut' }, 0)
    activeTween.to(nextCamera, { x: group.position.x + Math.sin(yaw) * cameraRadius * Math.cos(tilt), y: .1 + cameraRadius * Math.sin(tilt), z: group.position.z + Math.cos(yaw) * cameraRadius * Math.cos(tilt), duration: .72, ease: 'power2.inOut' }, 0)
  }
  const select = id => { if (!disposed) focus(id) }
  const onMotionPreference = event => {
    motionReduced = event.matches
    if (motionReduced) {
      activeTween?.kill(); activeTween = null
      setPoseInstant(activeSelection)
    }
  }

  const onResize = () => {
    if (!rendererReady || !renderer || disposed) return
    const rect = host.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    camera.aspect = rect.width / rect.height
    camera.updateProjectionMatrix()
    if (!activeSelection) {
      activeTween?.kill(); activeTween = null
      setPoseInstant(null)
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    renderer.setSize(rect.width, rect.height, false)
    requestRender()
  }
  const onPointerDown = event => {
    if (event.button !== undefined && event.button !== 0) return
    pointerDown = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    hasDragged = false
    dragging = false
  }
  const onPointerMove = event => {
    if (!pointerDown || (event.pointerId !== undefined && event.pointerId !== pointerDown.pointerId)) return
    const dx = event.clientX - pointerDown.x
    const dy = event.clientY - pointerDown.y
    if (!dragging && Math.hypot(dx, dy) > 6) {
      hasDragged = true
      // Preserve native vertical touch scrolling; only horizontal gestures orbit.
      if (event.pointerType === 'touch' && Math.abs(dy) > Math.abs(dx)) return
      dragging = true
      activeTween?.kill(); activeTween = null
      host.style.cursor = 'grabbing'
    }
    if (!dragging) return
    yaw = clamp(yaw - dx * .006, -.92, .92)
    tilt = clamp(tilt + dy * .004, .48, 1.08)
    pointerDown.x = event.clientX; pointerDown.y = event.clientY
    setCamera()
  }
  const onPointerUp = event => {
    if (!pointerDown) return
    const wasDrag = dragging
    pointerDown = null; dragging = false
    host.style.cursor = ''
    if (wasDrag || hasDragged) { hasDragged = false; return }
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObjects(spheres, true).find(item => {
      let node = item.object
      while (node && !node.userData.deviceId) node = node.parent
      return Boolean(node)
    })
    if (!hit) return
    let node = hit.object
    while (node && !node.userData.deviceId) node = node.parent
    if (!node) return
    const id = String(node.userData.deviceId)
    focus(id)
    onSelect(id)
  }
  const onVisibility = () => { if (document.hidden && raf) { cancelAnimationFrame(raf); raf = 0 } else requestRender() }
  const onContextLost = event => { event.preventDefault(); failToFallback(new Error('loan location renderer context was lost')) }
  const failToFallback = error => {
    if (fallbackCalled || disposed) return
    fallbackCalled = true
    dispose()
    onFallback(error)
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    rendererReady = false
    if (raf) cancelAnimationFrame(raf)
    activeTween?.kill(); activeTween = null
    resizeObserver?.disconnect(); resizeObserver = null
    window.removeEventListener('resize', onResize)
    document.removeEventListener('visibilitychange', onVisibility)
    host.removeEventListener('pointerdown', onPointerDown)
    host.removeEventListener('pointermove', onPointerMove)
    host.removeEventListener('pointerup', onPointerUp)
    host.removeEventListener('pointercancel', onPointerUp)
    host.removeEventListener('webglcontextlost', onContextLost)
    renderer?.domElement?.removeEventListener('webglcontextlost', onContextLost)
    if (motionQuery?.removeEventListener) motionQuery.removeEventListener('change', onMotionPreference)
    else motionQuery?.removeListener?.(onMotionPreference)
    scene.clear()
    host.style.touchAction = originalTouchAction
    host.style.cursor = originalCursor
    for (const geo of geometries) geo.dispose()
    for (const mat of materials) mat.dispose()
    for (const texture of textures) texture.dispose()
    geometries.clear(); materials.clear(); textures.clear(); deviceGroups.clear()
    if (renderer) {
      renderer.setAnimationLoop(null)
      renderer.dispose()
      renderer.domElement.remove()
      renderer = null
    }
  }

  host.addEventListener('pointerdown', onPointerDown)
  host.addEventListener('pointermove', onPointerMove)
  host.addEventListener('pointerup', onPointerUp)
  host.addEventListener('pointercancel', onPointerUp)
  host.addEventListener('webglcontextlost', onContextLost)
  host.style.touchAction = 'pan-y'
  document.addEventListener('visibilitychange', onVisibility)
  if (motionQuery?.addEventListener) motionQuery.addEventListener('change', onMotionPreference)
  else motionQuery?.addListener?.(onMotionPreference)
  window.addEventListener('resize', onResize, { passive: true })
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(host)
  }

  try {
    try {
      renderer = new THREE.WebGPURenderer({ alpha: false, antialias: true, powerPreference: 'low-power' })
      await renderer.init()
    } catch (webgpuError) {
      renderer?.dispose(); renderer = null
      renderer = new THREE.WebGPURenderer({ alpha: false, antialias: true, forceWebGL: true, powerPreference: 'low-power' })
      await renderer.init()
    }
    if (disposed || !isActive()) {
      dispose()
      throw new Error('loan location scene became inactive during renderer initialization')
    }
    renderer.onDeviceLost = info => {
      if (info?.reason !== 'destroyed') failToFallback(new Error(`loan location graphics device lost${info?.message ? `: ${info.message}` : ''}`))
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.06
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    renderer.domElement.setAttribute('aria-hidden', 'true')
    renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:pan-y;cursor:grab'
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)
    host.append(renderer.domElement)
    rendererReady = true
    onResize()
    if (selectedId !== null && selectedId !== undefined) focus(selectedId)
    requestRender()
    backend = renderer?.backend?.isWebGPUBackend ? 'webgpu' : renderer?.backend?.isWebGLBackend ? 'webgl2' : 'unknown'
    return { select, dispose, get backend() { return backend } }
  } catch (error) {
    dispose()
    throw error
  }
}
