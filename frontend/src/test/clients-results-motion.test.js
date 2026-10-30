import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const { animateClientResults, stopClientResultMotion } = await import('../views/clients.js')
styles.deregister()

function fixture({ empty = false, reduced = false } = {}) {
  const listeners = new Set()
  const media = {
    matches: reduced,
    addEventListener(_type, callback) { listeners.add(callback) },
    removeEventListener(_type, callback) { listeners.delete(callback) },
    change() { for (const callback of [...listeners]) callback({ matches: media.matches }) },
  }
  const targets = Array.from({ length: empty ? 1 : 3 }, () => ({
    hasAttribute(name) { return empty && name === 'data-empty-result' },
  }))
  const classes = new Set()
  const list = {
    isConnected: true,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    querySelectorAll: () => targets,
  }
  const tweens = []
  const clears = []
  const gsapApi = {
    fromTo(target, from, to) {
      const tween = { target, from, to, killed: false, kill() { this.killed = true } }
      tweens.push(tween)
      return tween
    },
    set(target, vars) { clears.push({ target, vars }) },
  }
  const root = {}
  return { root, list, targets, media, listeners, tweens, clears, gsapApi, classes }
}

test('las filas reales entran escalonadas con transform y opacidad', () => {
  const f = fixture()
  animateClientResults(f.root, f.list, { gsapApi: f.gsapApi, matchMedia: () => f.media })

  assert.equal(f.tweens.length, 1)
  assert.deepEqual(f.tweens[0].target, f.targets)
  assert.deepEqual({ opacity: f.tweens[0].from.opacity, y: f.tweens[0].from.y, scale: f.tweens[0].from.scale },
    { opacity: .65, y: 11, scale: .99 })
  assert.equal(f.tweens[0].to.stagger, .035)
  assert.equal(f.tweens[0].to.opacity, 1)
  assert.equal('autoAlpha' in f.tweens[0].from, false, 'no oculta temporalmente las filas al teclado o lectores')
  assert.ok(f.tweens[0].from.opacity >= .6, 'las acciones siguen visibles durante el stagger')
  assert.equal(f.classes.has('is-results-animating'), true)
})

test('el estado vacío usa una entrada propia y movimiento reducido inicial la omite', () => {
  const empty = fixture({ empty: true })
  animateClientResults(empty.root, empty.list, { gsapApi: empty.gsapApi, matchMedia: () => empty.media })
  assert.equal(empty.tweens[0].from.y, 9)
  assert.equal(empty.tweens[0].from.scale, .985)
  assert.equal(empty.tweens[0].to.duration, .36)

  const reduced = fixture({ reduced: true })
  animateClientResults(reduced.root, reduced.list, { gsapApi: reduced.gsapApi, matchMedia: () => reduced.media })
  assert.equal(reduced.tweens.length, 0)
  assert.equal(reduced.listeners.size, 0)

  const unsupported = fixture()
  animateClientResults(unsupported.root, unsupported.list, { gsapApi: unsupported.gsapApi, matchMedia: () => undefined })
  assert.equal(unsupported.tweens.length, 0)
  assert.equal(unsupported.listeners.size, 0)
})

test('reducir movimiento en vuelo o reemplazar la lista cancela y limpia tween y listener', () => {
  const f = fixture()
  animateClientResults(f.root, f.list, { gsapApi: f.gsapApi, matchMedia: () => f.media })
  f.media.matches = true
  f.media.change()
  assert.equal(f.tweens[0].killed, true)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.classes.has('is-results-animating'), false)
  assert.deepEqual(f.clears[0].vars, { clearProps: 'opacity,visibility,transform' })

  f.media.matches = false
  animateClientResults(f.root, f.list, { gsapApi: f.gsapApi, matchMedia: () => f.media })
  const active = f.tweens[1]
  stopClientResultMotion(f.root)
  assert.equal(active.killed, true)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.classes.has('is-results-animating'), false)
})
