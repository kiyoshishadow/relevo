import test from 'node:test'
import assert from 'node:assert/strict'
import { clientSaveChanges, animateClientSaveConfirmation } from '../client-save-motion.js'

const before = { id: 12, full_name: 'Sam Lee', document_id: 'A-1', phone: '5550101', email: 'sam@example.test', active: true, address: 'Old St' }

test('la confirmación usa ID exacto, aunque el nombre esté duplicado', () => {
  const result = clientSaveChanges(before, [
    { ...before, id: 11, full_name: 'Renamed wrong row', phone: '5550102' },
    { ...before, id: 12, full_name: 'Sam Lee', phone: '5550101' },
  ])
  assert.equal(result, null)
  const changed = clientSaveChanges(before, [
    { ...before, id: 11, full_name: 'Other Sam', phone: '5550199' },
    { ...before, id: 12, full_name: 'Sam Lee', phone: '5550102' },
  ])
  assert.deepEqual(changed, { id: '12', fields: ['phone'] })
})

test('enumera múltiples campos confirmados; dirección sola y sin cambios no animan', () => {
  assert.deepEqual(clientSaveChanges(before, [{ ...before, full_name: 'Sam Lee Jr', email: 'new@example.test', active: false }]),
    { id: '12', fields: ['full_name', 'email', 'active'] })
  assert.equal(clientSaveChanges(before, [{ ...before, address: 'New St' }]), null)
  assert.equal(clientSaveChanges(before, [{ ...before }]), null)
})

test('fila fuera del resultado/página no se inventa ni se desplaza', () => {
  assert.equal(clientSaveChanges(before, [{ ...before, id: 13, phone: 'different' }]), null)
})

function motionFixture({ reduced = false } = {}) {
  const listeners = new Set()
  const media = {
    matches: reduced,
    addEventListener(_type, fn) { listeners.add(fn) },
    removeEventListener(_type, fn) { listeners.delete(fn) },
  }
  const attrs = new Set()
  const marker = {}
  const underlines = [{ attrs: new Set(), setAttribute(name) { this.attrs.add(name) }, removeAttribute(name) { this.attrs.delete(name) } },
    { attrs: new Set(), setAttribute(name) { this.attrs.add(name) }, removeAttribute(name) { this.attrs.delete(name) } },
    { attrs: new Set(), setAttribute(name) { this.attrs.add(name) }, removeAttribute(name) { this.attrs.delete(name) } }]
  const cells = {
    phone: { querySelector: () => underlines[0] },
    email: { querySelector: () => underlines[1] },
    document_id: { querySelector: () => underlines[2] },
  }
  const row = {
    isConnected: true,
    querySelector(selector) {
      if (selector === '[data-client-save-marker]') return marker
      const field = selector.match(/data-client-field="([^"]+)"/)?.[1]
      return cells[field]?.querySelector('[data-client-save-underline]') || null
    },
    setAttribute(name) { attrs.add(name) },
    removeAttribute(name) { attrs.delete(name) },
  }
  const calls = []
  const api = {
    set(target, vars) { calls.push({ type: 'set', target, vars }) },
    timeline(options) {
      const tl = {
        options, steps: [], killed: false,
        fromTo(...args) { this.steps.push(args); return this },
        kill() { this.killed = true },
      }
      calls.push({ type: 'timeline', tl })
      return tl
    },
  }
  return { row, media, listeners, attrs, marker, underlines, calls, api }
}

test('marca la fila y los campos, limpia al activar reduced-motion en vivo y al disponer', () => {
  const f = motionFixture()
  const motion = animateClientSaveConfirmation(f.row, ['phone', 'email'], { gsapApi: f.api, matchMedia: () => f.media })
  assert.ok(motion)
  assert.equal(f.attrs.has('data-client-save-motion'), true)
  assert.equal(motion.targets.length, 3)
  assert.equal(motion.tween.steps[1][2].stagger, .055)
  assert.deepEqual(f.underlines.map(node => node.attrs.has('data-client-save-changed')), [true, true, false],
    'solo los campos cambiados reciben el marcador visible')
  const initialTween = motion.tween
  f.media.matches = true
  motion.onChange({ matches: true })
  assert.equal(initialTween.killed, true)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.attrs.has('data-client-save-motion'), false)
  assert.equal(f.attrs.has('data-client-save-static'), true)
  assert.deepEqual(f.underlines.map(node => node.attrs.has('data-client-save-changed')), [true, true, false],
    'el fallback estático conserva solo los campos cambiados')
  assert.deepEqual(f.calls.at(-1).vars, { clearProps: 'opacity,transform' })

  f.media.matches = false
  const replaced = animateClientSaveConfirmation(f.row, ['phone'], { gsapApi: f.api, matchMedia: () => f.media })
  const replacementTween = replaced.tween
  replaced.finish()
  assert.equal(replacementTween.killed, true)
  assert.equal(f.listeners.size, 0)
  assert.deepEqual(f.underlines.map(node => node.attrs.has('data-client-save-changed')), [false, true, false],
    'al descartar el vuelo se limpia su marcador temporal')
})

test('reduced-motion inicial deja una marca estática sin timeline', () => {
  const f = motionFixture({ reduced: true })
  assert.equal(animateClientSaveConfirmation(f.row, ['phone'], { gsapApi: f.api, matchMedia: () => f.media }), null)
  assert.equal(f.attrs.has('data-client-save-static'), true)
  assert.equal(f.calls.some(call => call.type === 'timeline'), false)
  assert.equal(f.listeners.size, 0)
})
