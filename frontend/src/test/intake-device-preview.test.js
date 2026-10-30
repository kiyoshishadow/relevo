import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { createIntakeDevicePreview } from '../intake-device-preview.js'

class FakeClassList {
  add() {}
  remove() {}
}
class FakeNode {
  constructor() { this.isConnected = true; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.classList = new FakeClassList(); this.textContent = ''; }
  setAttribute(key, value) { this.attributes[key] = String(value) }
  getAttribute(key) { return this.attributes[key] ?? null }
  removeAttribute(key) { delete this.attributes[key] }
  addEventListener(type, listener) { this.listeners.set(type, listener) }
  removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type) }
  querySelector(selector) { return this.children?.[selector] || null }
  replaceChildren() { this.children = {}; this.innerHTML = '' }
  set innerHTML(value) {
    this._html = value
    const stage = new FakeNode(), button = new FakeNode(), status = new FakeNode(), fallback = new FakeNode(), svg = new FakeNode()
    svg.querySelectorAll = () => []
    stage.querySelector = selector => selector === '.phone-fallback' ? fallback : selector === '.phone-svg' ? svg : null
    this.children = { '[data-intake-device-stage]': stage, '[data-intake-device-toggle]': button, '[data-intake-device-status]': status }
  }
  get innerHTML() { return this._html || '' }
}
const terminal = (id, client_id, brand = 'Google', model = 'Pixel 8') => ({ id, client_id, brand, model })
const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const { newCaseView } = await import('../views/caseNew.js')
styles.deregister()

test('case view imports and initializes reduced-motion before constructing its preview', async () => {
  assert.equal(typeof newCaseView, 'function')
  const source = await readFile(new URL('../views/caseNew.js', import.meta.url), 'utf8')
  assert.ok(source.indexOf("const motionQuery = window.matchMedia") < source.indexOf('createIntakeDevicePreview({ host:'))
})

test('selected known and unknown equipment use only the selected record identity', async () => {
  const host = new FakeNode()
  const preview = createIntakeDevicePreview({ host, motionQuery: { matches: true } })
  await preview.select(terminal('known', 'client'), 'client')
  assert.match(host.innerHTML, /Google Pixel 8/)
  assert.match(host.innerHTML, /Perfil exterior identificado/)
  assert.doesNotMatch(host.innerHTML, /IMEI|clave|personal/i)
  await preview.select(terminal('unknown', 'client', 'Marca rara', 'Modelo exacto 77'), 'client')
  assert.match(host.innerHTML, /Marca rara Modelo exacto 77/)
  assert.match(host.innerHTML, /Vista ilustrativa/)
  assert.doesNotMatch(host.innerHTML, /Pixel|iPhone|Galaxy/)
  await preview.dispose()
})

test('a newer selection invalidates an import that resolves late', async () => {
  const host = new FakeNode()
  let resolveModule
  let mounts = 0
  const modulePromise = new Promise(resolve => { resolveModule = resolve })
  const preview = createIntakeDevicePreview({ host, loadModule: () => modulePromise })
  const first = preview.select(terminal('old', 'client'), 'client')
  await Promise.resolve()
  const second = preview.select(terminal('new', 'client', 'Apple', 'iPhone 13'), 'client')
  resolveModule({ mountPhone3d: async () => { mounts++; return () => {} } })
  await Promise.all([first, second])
  assert.equal(mounts, 1)
  assert.match(host.innerHTML, /Apple iPhone 13/)
  await preview.dispose()
})

test('late disposal is isolated from current controls and renderer mounts stay serialized', async () => {
  const host = new FakeNode()
  let releaseFirst
  const firstMount = new Promise(resolve => { releaseFirst = resolve })
  let starts = 0, activeRenderers = 0, maximum = 0, oldView
  const preview = createIntakeDevicePreview({ host, loadModule: async () => ({
    mountPhone3d: async (_stage, button, status) => {
      starts++
      if (starts === 1) {
        oldView = { button, status }
        activeRenderers++
        maximum = Math.max(maximum, activeRenderers)
        await firstMount
        return () => { activeRenderers--; button.textContent = 'old disposed'; status.textContent = 'old disposed' }
      }
      activeRenderers++
      maximum = Math.max(maximum, activeRenderers)
      return () => { activeRenderers-- }
    },
  }) })
  const first = preview.select(terminal('old', 'client'), 'client')
  for (let turn = 0; turn < 12 && starts === 0; turn++) await Promise.resolve()
  assert.equal(starts, 1)
  const second = preview.select(terminal('new', 'client', 'Apple', 'iPhone 13'), 'client')
  const currentButton = host.querySelector('[data-intake-device-toggle]')
  const currentStatus = host.querySelector('[data-intake-device-status]')
  releaseFirst()
  await Promise.all([first, second])
  assert.equal(maximum, 1)
  assert.notEqual(oldView.button, currentButton)
  assert.notEqual(currentButton.textContent, 'old disposed')
  assert.notEqual(currentStatus.textContent, 'old disposed')
  await preview.dispose()
})

test('incompatible client clears the preview and dispose is idempotent', async () => {
  const host = new FakeNode()
  const preview = createIntakeDevicePreview({ host, motionQuery: { matches: true } })
  await preview.select(terminal('device', 'owner'), 'other')
  assert.equal(host.hidden, true)
  assert.equal(host.innerHTML, '')
  await preview.select(terminal('device', 'owner'), 'owner')
  await preview.dispose()
  await preview.dispose()
  assert.equal(host.hidden, true)
})

test('reduced motion keeps SVG actions and does not load or animate 3D', async () => {
  const host = new FakeNode()
  let imports = 0
  const motionQuery = { matches: true }
  const preview = createIntakeDevicePreview({ host, motionQuery, loadModule: async () => { imports++; return {} } })
  await preview.select(terminal('device', 'owner'), 'owner')
  const stage = host.querySelector('[data-intake-device-stage]')
  const button = host.querySelector('[data-intake-device-toggle]')
  assert.equal(stage.dataset.rendererBackend, 'reduced-motion-svg')
  assert.equal(imports, 0)
  button.listeners.get('click')()
  assert.equal(button.getAttribute('aria-pressed'), 'false')
  assert.equal(imports, 0)
  await preview.dispose()
})

test('normal intake mount keeps its entrance and subtle turn without a repeating scan', async () => {
  const host = new FakeNode()
  let options
  const preview = createIntakeDevicePreview({ host, loadModule: async () => ({
    mountPhone3d: async (_stage, _button, _status, nextOptions) => { options = nextOptions; return () => {} },
  }) })
  await preview.select(terminal('device', 'owner'), 'owner')
  assert.equal(options.playIntro, true)
  assert.equal(options.idleAnimation, true)
  assert.equal(options.idleScan, false)
  await preview.dispose()
})

test('context loss while expanded synchronizes the SVG fallback and keeps its status', async () => {
  const host = new FakeNode()
  const poseCalls = []
  const preview = createIntakeDevicePreview({ host, setSvgPose: (...args) => { poseCalls.push(args); return null }, loadModule: async () => ({
    mountPhone3d: async (_stage, button, _status, options) => {
      button.setAttribute('aria-pressed', 'false')
      options.onFallback(false)
      return () => {}
    },
  }) })
  await preview.select(terminal('device', 'owner'), 'owner')
  const button = host.querySelector('[data-intake-device-toggle]')
  const status = host.querySelector('[data-intake-device-status]')
  assert.equal(button.getAttribute('aria-pressed'), 'false')
  assert.equal(button.textContent, 'Armar el teléfono')
  assert.match(status.textContent, /Vista de reparación/)
  assert.match(status.textContent, /esquema SVG/)
  assert.equal(poseCalls.length, 1)
  assert.equal(poseCalls[0][2], false)
  assert.deepEqual(poseCalls[0][3], { reduced: true })
  await preview.dispose()
})
