import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

test('hover and keyboard focus preserve all nine projected anchors; reduced motion and cleanup stop local tweens', async () => {
  const saved = new Map()
  const install = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const animations = []
  const apply = (target, vars) => {
    for (const key of ['x', 'y', 'z', 'intensity']) if (typeof vars[key] === 'number') target[key] = vars[key]
    vars.onUpdate?.()
  }
  const animation = () => {
    const item = { killed: false, kill() { this.killed = true }, pause() {}, resume() {}, isActive() { return !this.killed } }
    animations.push(item)
    return item
  }
  const gsap = {
    to(target, vars) { apply(target, vars); return animation() },
    timeline() { const item = animation(); item.to = (target, vars) => { apply(target, vars); return item }; return item },
  }
  class Node extends EventTarget {
    listeners = new Map()
    style = {}
    dataset = {}
    children = []
    addEventListener(type, listener, options) { this.listeners.set(listener, type); super.addEventListener(type, listener, options) }
    removeEventListener(type, listener, options) { this.listeners.delete(listener); super.removeEventListener(type, listener, options) }
    setAttribute() {}
    append(node) { this.children.push(node); node.parent = this }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this) }
    contains(node) { return node === this || this.children.includes(node) }
  }
  let renderer
  class Renderer {
    domElement = new Node()
    backend = { isWebGPUBackend: true }
    constructor() { renderer = this }
    async init() {}
    setClearColor() {}
    setPixelRatio() {}
    setSize() {}
    dispose() { this.disposed = true }
    render(scene, camera) { this.scene = scene; this.camera = camera; scene.updateMatrixWorld(); camera.updateMatrixWorld() }
  }
  const frames = new Map()
  let frameId = 0
  const mql = Object.assign(new Node(), { matches: false })
  const doc = Object.assign(new Node(), { hidden: false, createElementNS: () => new Node() })
  const win = Object.assign(new Node(), { matchMedia: () => mql, devicePixelRatio: 1 })
  const observers = []
  class Observer { constructor() { observers.push(this) } observe() {} disconnect() { this.disconnected = true } }
  const keys = ['received', 'awaiting_approval', 'awaiting_payment', 'repairing', 'ready', 'loans_out', 'clients', 'terminals', 'total_cases']
  const cards = keys.map(() => new Node())
  const slots = cards.map((card, index) => {
    const slot = new Node()
    slot.dataset.statKey = keys[index]
    slot.closest = () => card
    slot.getBoundingClientRect = () => ({ left: 50 + (index % 3) * 200, top: 60 + Math.floor(index / 3) * 120, width: 48, height: 48 })
    card.append(slot)
    return slot
  })
  const host = Object.assign(new Node(), {
    clientWidth: 650, clientHeight: 450,
    querySelectorAll: selector => selector === '.stat' ? cards : slots,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  })
  let hooks
  let dispose
  try {
    install('__workshopTest', { Renderer, gsap })
    install('document', doc)
    install('window', win)
    install('getComputedStyle', () => ({ position: 'static' }))
    install('ResizeObserver', Observer)
    install('requestAnimationFrame', callback => { frames.set(++frameId, callback); return frameId })
    install('cancelAnimationFrame', id => frames.delete(id))
    const threeUrl = import.meta.resolve('three')
    hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        const name = specifier === 'three/webgpu' ? 'three' : specifier === 'gsap' ? 'gsap' : specifier.endsWith('studio-environment.js') ? 'environment' : null
        return name ? { url: `workshop-test:${name}`, shortCircuit: true } : nextResolve(specifier, context)
      },
      load(url, context, nextLoad) {
        const source = {
          'workshop-test:three': `export * from '${threeUrl}'; export const WebGPURenderer = globalThis.__workshopTest.Renderer`,
          'workshop-test:gsap': 'export default globalThis.__workshopTest.gsap',
          'workshop-test:environment': 'export const createStudioEnvironment = () => null',
        }[url]
        return source ? { format: 'module', source, shortCircuit: true } : nextLoad(url, context)
      },
    })
    const { mountWorkshopScene } = await import('../components/workshop-scene.js')
    dispose = mountWorkshopScene(host)
    await new Promise(resolve => setImmediate(resolve))
    const frame = time => {
      const [id, callback] = frames.entries().next().value
      frames.delete(id)
      callback(time)
    }
    frame(1000)
    const models = renderer.scene.children.filter(child => child.userData.metricKey)
    const pointLight = renderer.scene.children.find(child => child.isPointLight)
    assert.equal(models.length, 9)
    const projected = () => models.map(model => model.position.clone().project(renderer.camera).toArray().slice(0, 2))
    const anchors = projected()
    const zoom = renderer.camera.zoom
    const cameraPosition = renderer.camera.position.toArray()
    let time = 1000
    for (const type of ['pointerenter', 'focusin']) {
      cards[4].dispatchEvent(new Event(type))
      frame(time += 1000)
      assert.deepEqual(projected(), anchors)
      assert.equal(renderer.camera.zoom, zoom)
      assert.deepEqual(renderer.camera.position.toArray(), cameraPosition)
      assert.equal(pointLight.position.x, models[4].position.x)
      assert.equal(pointLight.position.y, models[4].position.y)
      assert.equal(pointLight.intensity, 14)
      cards[4].dispatchEvent(new Event(type === 'focusin' ? 'focusout' : 'pointerleave'))
      const returnRotation = models[4].rotation.toArray()
      frame(time += 1000)
      assert.deepEqual(models[4].rotation.toArray(), returnRotation)
      assert.deepEqual(projected(), anchors)
      assert.equal(pointLight.intensity, 0)
    }
    // Leaving with the pointer must not cancel the keyboard's active focus.
    cards[2].dispatchEvent(new Event('pointerenter'))
    cards[2].dispatchEvent(new Event('focusin'))
    cards[2].dispatchEvent(new Event('pointerleave'))
    frame(time += 1000)
    assert.equal(pointLight.intensity, 14)
    cards[2].dispatchEvent(new Event('focusout'))
    frame(time += 1000)
    assert.equal(pointLight.intensity, 0)
    cards[0].dispatchEvent(new Event('pointerenter'))
    mql.matches = true
    mql.dispatchEvent(new Event('change'))
    assert.equal(frames.size, 0)
    assert.equal(pointLight.intensity, 0)
    const animationsBefore = animations.length
    cards[1].dispatchEvent(new Event('focusin'))
    assert.equal(animations.length, animationsBefore)
    assert.deepEqual(projected(), anchors)
    dispose(); dispose()
    assert.equal(renderer.disposed, true)
    assert.ok(observers.every(observer => observer.disconnected))
    assert.ok(animations.every(item => item.killed))
    assert.ok(cards.every(card => card.listeners.size === 0))
    assert.equal(mql.listeners.size + doc.listeners.size + win.listeners.size, 0)
    assert.equal(host.children.length, 0)
    assert.ok(slots.every(slot => slot.children.length === 0))
    mql.matches = false
    mql.dispatchEvent(new Event('change'))
    cards[0].dispatchEvent(new Event('pointerenter'))
    assert.equal(frames.size, 0)
    assert.equal(animations.length, animationsBefore)
  } finally {
    dispose?.()
    hooks?.deregister()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})
