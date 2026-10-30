import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const { createIntakeErrorPulse, focusFirstInvalidIntakeField } = await import('../views/caseNew.js')
styles.deregister()

function fixture({ reduced = false } = {}) {
  const listeners = new Set()
  const media = {
    matches: reduced,
    addEventListener(_type, callback) { listeners.add(callback) },
    removeEventListener(_type, callback) { listeners.delete(callback) },
    change() { for (const callback of [...listeners]) callback({ matches: media.matches }) },
  }
  const tweens = []
  const resets = []
  const gsapApi = {
    fromTo(target, from, to) {
      const tween = { target, from, to, killed: false, kill() { this.killed = true } }
      tweens.push(tween)
      return tween
    },
    set(target, vars) { resets.push({ target, vars }) },
  }
  const classes = new Set()
  const field = { classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) } }
  const focused = []
  const controls = { client_id: { focus: () => focused.push('client_id') }, terminal_id: { focus: () => focused.push('terminal_id') }, reported_problem: { focus: () => focused.push('reported_problem') } }
  const form = { elements: controls, querySelector: selector => selector === '[data-intake-field="client"]' ? field : null }
  return { media, listeners, tweens, resets, gsapApi, field, classes, focused, form }
}

test('el primer error de intake conserva el orden de foco y recibe una onda ámbar breve', () => {
  const f = fixture()
  const pulse = createIntakeErrorPulse({ gsapApi: f.gsapApi, mediaQuery: f.media })
  const didFocus = focusFirstInvalidIntakeField(f.form, {
    errors: { client_id: 'Requerido', terminal_id: 'Requerido', reported_problem: '' },
  }, pulse)

  assert.equal(didFocus, true)
  assert.deepEqual(f.focused, ['client_id'])
  assert.equal(f.tweens[0].target, f.field)
  assert.equal(f.tweens[0].to.duration, .24)
  assert.equal(f.tweens[0].to.repeat, 1)
  assert.equal(f.tweens[0].to.yoyo, true)
  assert.match(f.tweens[0].to.boxShadow, /190, 137, 38/)
  assert.equal(f.classes.has('intake-error-pulse'), true)
  pulse.dispose()
})

test('un nuevo intento reemplaza el objetivo anterior y reduced-motion en vivo cancela y limpia', () => {
  const f = fixture()
  const pulse = createIntakeErrorPulse({ gsapApi: f.gsapApi, mediaQuery: f.media })
  pulse.play(f.field)
  const secondField = { classList: { add: () => {}, remove: () => {} } }
  pulse.play(secondField)
  assert.equal(f.tweens[0].killed, true)
  assert.equal(f.classes.has('intake-error-pulse'), false)
  assert.equal(f.tweens[1].target, secondField)

  f.media.matches = true
  f.media.change()
  assert.equal(f.tweens[1].killed, true)
  assert.equal(f.listeners.size, 1, 'la vista conserva su listener para cambios posteriores')
  f.media.matches = false
  pulse.play(f.field)
  f.media.matches = true
  f.media.change()
  assert.equal(f.tweens[2].killed, true)
  assert.equal(f.resets.length, 3)
  assert.equal(f.listeners.size, 1)

  pulse.dispose()
  assert.equal(f.listeners.size, 0)
})

test('movimiento reducido inicial mantiene el campo estático y no crea tween', () => {
  const f = fixture({ reduced: true })
  const pulse = createIntakeErrorPulse({ gsapApi: f.gsapApi, mediaQuery: f.media })
  pulse.play(f.field)
  assert.equal(f.tweens.length, 0)
  assert.equal(f.classes.has('intake-error-pulse'), false)
  pulse.dispose()
})
