import { Map, Marker, LngLatBounds, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { demoDeviceCoordinates } from '../loan-map-demo.js'

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'
const HOME = Object.freeze({ center: [-89.2225, 13.702], zoom: 15, pitch: 45, bearing: -20 })
const MAP_TIMEOUT_MS = 30_000

const STATUS_CLASS = Object.freeze({
  available: 'loan-geographic-marker--available',
  loaned: 'loan-geographic-marker--loaned',
  retired: 'loan-geographic-marker--retired',
})

function noOpController() {
  return { select() {}, dispose() {}, backend: 'maplibre' }
}

function validCoordinates(value) {
  return Array.isArray(value)
    && value.length >= 2
    && Number.isFinite(Number(value[0]))
    && Number.isFinite(Number(value[1]))
    && Number(value[0]) >= -180 && Number(value[0]) <= 180
    && Number(value[1]) >= -90 && Number(value[1]) <= 90
}

export async function mountLoanGeographicMap(host, {
  devices = [],
  selectedId = null,
  onSelect = () => {},
  isActive = () => true,
  onFallback = () => {},
  onReady = () => {},
} = {}) {
  if (!host) throw new TypeError('loan geographic map requires a host element')
  if (!isActive()) return noOpController()

  let map = null
  let mapRoot = null
  let resizeObserver = null
  let timeoutId = 0
  let disposed = false
  let loaded = false
  let fallbackCalled = false
  let motionQuery = null
  let motionReduced = false
  let activeSelection = selectedId === null || selectedId === undefined ? null : String(selectedId)
  let hostContextCanvas = null
  let markerStyle = null
  const markers = new globalThis.Map()
  const pointBounds = []
  const records = []
  const originalHostPosition = host.style.position

  const removeMarkers = () => {
    for (const record of records) {
      record.element.removeEventListener('click', record.onClick)
      record.marker.remove()
    }
    records.length = 0
    markers.clear()
  }

  const cleanup = () => {
    if (disposed) return
    disposed = true
    if (timeoutId) window.clearTimeout(timeoutId)
    timeoutId = 0
    resizeObserver?.disconnect()
    resizeObserver = null
    if (motionQuery?.removeEventListener) motionQuery.removeEventListener('change', onMotionPreference)
    else motionQuery?.removeListener?.(onMotionPreference)
    window.removeEventListener('resize', onResize)
    if (map) {
      map.off('load', onLoad)
      map.off('error', onMapError)
      map.off('style.load', onStyleLoad)
      if (hostContextCanvas) hostContextCanvas.removeEventListener('webglcontextlost', onContextLost)
    }
    removeMarkers()
    map?.remove()
    map = null
    mapRoot?.remove()
    mapRoot = null
    markerStyle?.remove()
    markerStyle = null
    if (host.style.position === 'relative' && originalHostPosition !== 'relative') host.style.position = originalHostPosition
  }

  const failToFallback = error => {
    if (disposed || fallbackCalled) return
    fallbackCalled = true
    cleanup()
    if (isActive()) onFallback(error instanceof Error ? error : new Error(String(error)))
  }

  const fitOverview = () => {
    if (!map || !loaded || disposed) return
    map.stop()
    for (const record of records) {
      record.element.classList.remove('is-selected')
      record.element.setAttribute('aria-pressed', 'false')
    }
    if (!pointBounds.length) {
      const options = { ...HOME, duration: motionReduced ? 0 : 650, essential: !motionReduced }
      if (motionReduced) map.jumpTo(HOME)
      else map.easeTo(options)
      return
    }
    if (pointBounds.length === 1) {
      const options = { center: pointBounds[0], zoom: Math.min(HOME.zoom, 15.5), pitch: HOME.pitch, bearing: HOME.bearing, duration: motionReduced ? 0 : 650, essential: !motionReduced }
      if (motionReduced) map.jumpTo(options)
      else map.easeTo(options)
      return
    }
    const bounds = new LngLatBounds()
    for (const point of pointBounds) bounds.extend(point)
    const options = { padding: 82, maxZoom: 15.5, pitch: HOME.pitch, bearing: HOME.bearing, duration: motionReduced ? 0 : 650, essential: !motionReduced }
    if (motionReduced) map.fitBounds(bounds, { ...options, duration: 0 })
    else map.fitBounds(bounds, options)
  }

  const focus = id => {
    if (id === null || id === undefined) {
      activeSelection = null
      fitOverview()
      return
    }
    const key = String(id)
    if (!loaded) {
      activeSelection = key
      return
    }
    const record = markers.get(key)
    if (!record) {
      activeSelection = null
      fitOverview()
      return
    }
    activeSelection = key
    for (const item of records) {
      const selected = item.id === key
      item.element.classList.toggle('is-selected', selected)
      item.element.setAttribute('aria-pressed', selected ? 'true' : 'false')
    }
    if (!loaded || !map) return
    const options = { center: record.coordinates, zoom: 16.5, pitch: HOME.pitch, bearing: HOME.bearing, duration: motionReduced ? 0 : 720, essential: !motionReduced }
    if (motionReduced) map.jumpTo(options)
    else map.easeTo(options)
  }

  const select = id => {
    if (disposed) return
    focus(id)
  }

  const onMotionPreference = event => {
    motionReduced = event.matches
    if (motionReduced && loaded && !disposed) {
      if (activeSelection !== null && markers.has(activeSelection)) focus(activeSelection)
      else fitOverview()
    }
  }

  const addBuildingExtrusions = () => {
    if (!map || !map.isStyleLoaded()) return
    const style = map.getStyle()
    const layers = style?.layers || []
    if (layers.some(layer => layer.type === 'fill-extrusion' && /building/i.test(layer.id))) return
    const sourceEntry = Object.entries(style?.sources || {}).find(([sourceId, source]) => source.type === 'vector'
      && layers.some(layer => layer.source === sourceId && layer['source-layer'] === 'building'))
    if (!sourceEntry) return
    const [sourceId] = sourceEntry
    const beforeLayer = layers.find(layer => layer.type === 'symbol' && layer.layout?.['text-field'])?.id
    const buildingLayer = {
      id: 'loan-map-buildings-3d',
      type: 'fill-extrusion',
      source: sourceId,
      'source-layer': 'building',
      minzoom: 14,
      filter: ['!', ['has', 'hide_3d']],
      paint: {
        'fill-extrusion-color': '#c9c9bb',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 0],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.78,
      },
    }
    try {
      if (beforeLayer) map.addLayer(buildingLayer, beforeLayer)
      else map.addLayer(buildingLayer)
    } catch {
      // Building extrusion is progressive enhancement; preserve the basemap.
    }
  }

  const onStyleLoad = () => {
    if (disposed || !isActive()) { cleanup(); return }
    addBuildingExtrusions()
  }

  const onLoad = () => {
    if (disposed || !isActive()) { cleanup(); return }
    loaded = true
    if (timeoutId) window.clearTimeout(timeoutId)
    timeoutId = 0
    addBuildingExtrusions()
    for (let index = 0; index < (Array.isArray(devices) ? devices.length : 0); index++) {
      const device = devices[index]
      if (!device || device.id === null || device.id === undefined) continue
      let coordinates
      try { coordinates = demoDeviceCoordinates(device, index) } catch { coordinates = null }
      if (!validCoordinates(coordinates)) continue
      const point = [Number(coordinates[0]), Number(coordinates[1])]
      const id = String(device.id)
      const assetTag = String(device.asset_tag ?? device.assetTag ?? '').trim()
      if (!assetTag) continue
      const statusClass = STATUS_CLASS[device.status] || 'loan-geographic-marker--unknown'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `loan-geographic-marker ${statusClass}`
      button.textContent = `${assetTag} · Demo`
      button.setAttribute('aria-label', `Ver posición simulada de ${assetTag}`)
      button.setAttribute('aria-pressed', 'false')
      const marker = new Marker({ element: button, anchor: 'bottom' }).setLngLat(point).addTo(map)
      const record = { id, coordinates: point, element: button, marker, onClick: null }
      record.onClick = event => {
        event.stopPropagation()
        focus(id)
        onSelect(String(id))
      }
      button.addEventListener('click', record.onClick)
      records.push(record)
      markers.set(id, record)
      pointBounds.push(point)
    }
    if (activeSelection !== null && markers.has(activeSelection)) focus(activeSelection)
    else {
      activeSelection = null
      fitOverview()
    }
    if (!isActive() || disposed) { cleanup(); return }
    try {
      onReady()
    } catch (error) {
      failToFallback(error)
      return
    }
    if (!isActive()) cleanup()
  }

  const onContextLost = event => {
    event.preventDefault()
    failToFallback(new Error('MapLibre WebGL context was lost'))
  }

  const onResize = () => { if (!disposed) map?.resize() }

  const onMapError = event => {
    if (loaded || disposed) return
    const error = event?.error
    const url = String(error?.url || error?.response?.url || event?.url || '')
    const message = String(error?.message || '')
    if (url.includes('/styles/liberty') || /failed to load style|style.*(?:failed|invalid)|webgl.*(?:unavailable|unsupported)/i.test(message)) {
      failToFallback(error || new Error(message || 'OpenFreeMap style failed to load'))
    }
  }

  try {
    setWorkerUrl(workerUrl)
    motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
    motionReduced = motionQuery?.matches ?? false
    if (motionQuery?.addEventListener) motionQuery.addEventListener('change', onMotionPreference)
    else motionQuery?.addListener?.(onMotionPreference)

    markerStyle = document.createElement('style')
    markerStyle.textContent = `
      .loan-geographic-marker{appearance:none;display:flex;align-items:center;gap:.42rem;padding:.42rem .62rem;border:1px solid rgba(244,240,231,.8);border-radius:999px;color:#f4f0e7;background:#343833;box-shadow:0 3px 14px rgba(17,22,19,.4);font:600 12px/1.1 Archivo,Arial,sans-serif;letter-spacing:.01em;white-space:nowrap;cursor:pointer;transition:transform .18s ease,box-shadow .18s ease}
      .loan-geographic-marker::before{content:"";width:.52rem;height:.52rem;flex:0 0 .52rem;border-radius:50%;background:#aab2ad;box-shadow:0 0 0 3px rgba(244,240,231,.14)}
      .loan-geographic-marker--available{background:#315d48}.loan-geographic-marker--available::before{background:#a7d5a9}
      .loan-geographic-marker--loaned{background:#725522}.loan-geographic-marker--loaned::before{background:#f5c760}
      .loan-geographic-marker--retired{background:#514944}.loan-geographic-marker--retired::before{background:#c4a89b}
      .loan-geographic-marker.is-selected{z-index:2;box-shadow:0 0 0 3px rgba(244,240,231,.44),0 5px 20px rgba(17,22,19,.58)}
      .loan-geographic-marker:focus-visible{outline:3px solid #b8862d;outline-offset:4px}
      @media(prefers-reduced-motion:reduce){.loan-geographic-marker{transition:none}}
    `
    host.append(markerStyle)

    const computedPosition = window.getComputedStyle(host).position
    if (computedPosition === 'static') host.style.position = 'relative'
    mapRoot = document.createElement('div')
    mapRoot.className = 'loan-geographic-map__canvas'
    mapRoot.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:hidden'
    host.append(mapRoot)

    map = new Map({
      container: mapRoot,
      style: STYLE_URL,
      center: HOME.center,
      zoom: HOME.zoom,
      pitch: HOME.pitch,
      bearing: HOME.bearing,
      cooperativeGestures: true,
      scrollZoom: false,
      attributionControl: true,
      canvasContextAttributes: { antialias: true },
      locale: {
        'Map.Title': 'Mapa de equipos',
        'NavigationControl.ZoomIn': 'Acercar',
        'NavigationControl.ZoomOut': 'Alejar',
        'NavigationControl.ResetBearing': 'Girar el mapa; pulsa para orientar al norte',
        'AttributionControl.ToggleAttribution': 'Mostrar atribución',
        'CooperativeGesturesHandler.MobileHelpText': 'Usa dos dedos para mover el mapa',
        'CooperativeGesturesHandler.WindowsHelpText': 'Usa Ctrl y la rueda para acercar el mapa',
        'CooperativeGesturesHandler.MacHelpText': 'Usa ⌘ y la rueda para acercar el mapa',
      },
    })
    map.addControl(new NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right')
    map.addControl(new ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left')
    map.on('load', onLoad)
    map.on('error', onMapError)
    map.on('style.load', onStyleLoad)
    hostContextCanvas = map.getCanvas()
    hostContextCanvas.addEventListener('webglcontextlost', onContextLost)
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(onResize)
      resizeObserver.observe(host)
    } else {
      window.addEventListener('resize', onResize, { passive: true })
    }
    timeoutId = window.setTimeout(() => {
      if (!loaded && !disposed) failToFallback(new Error('OpenFreeMap style did not load within 30 seconds'))
    }, MAP_TIMEOUT_MS)
  } catch (error) {
    cleanup()
    onFallback(error instanceof Error ? error : new Error(String(error)))
    throw error
  }

  return { select, dispose: cleanup, backend: 'maplibre' }
}
