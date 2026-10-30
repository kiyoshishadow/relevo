import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const { wireLoanGate } = await import('../views/loans.js')
styles.deregister()

function fixture({ reduced = false } = {}) {
  const listeners = new Set()
  const media = {
    matches: reduced,
    addEventListener: (_type, callback) => listeners.add(callback),
    removeEventListener: (_type, callback) => listeners.delete(callback),
    change() { for (const callback of [...listeners]) callback({ matches: media.matches }) },
  }
  const timelines = []
  const gsapApi = {
    timeline(options) {
      const timeline = {
        options, steps: [], killed: false,
        fromTo(target, from, to, position) { this.steps.push({ method: 'fromTo', target, from, to, position }); return this },
        to(target, vars, position) { this.steps.push({ method: 'to', target, vars, position }); return this },
        kill() { this.killed = true },
        complete() { options.onComplete?.() },
      }
      timelines.push(timeline)
      return timeline
    },
    set(target, vars) { gsapApi.resets.push({ target, vars }) },
    resets: [],
  }
  let activeElement
  const firstInput = { focused: false, focus() { this.focused = true; activeElement = this } }
  const cancel = { disabled: false, addEventListener(_type, callback) { this.onClick = callback }, click() { this.onClick?.() } }
  const controls = [cancel, { disabled: false }, { disabled: false }]
  const content = [{}, {}, {}]
  const panel = { dataset: {}, inert: false, querySelectorAll: selector => selector === '[data-loan-gate-content]' ? content : [] }
  let removed = false
  const box = {
    querySelector: selector => selector === '[data-loan-gate]' ? panel : selector === '[data-cancel]' ? cancel : selector === 'input, select, textarea, button' ? firstInput : null,
    querySelectorAll: () => controls,
    replaceChildren() { removed = true },
    get removed() { return removed },
  }
  const opener = {
    disabled: false, isConnected: true, focused: false,
    focus() { this.focused = true; activeElement = this },
  }
  activeElement = opener
  return { media, timelines, gsapApi, cancel, controls, content, firstInput, panel, box, opener, listeners, get activeElement() { return activeElement }, set activeElement(value) { activeElement = value } }
}

test('la compuerta entra en transform y opacidad; cancelar bloquea doble clic y devuelve foco al terminar', () => {
  const f = fixture()
  wireLoanGate(f.box, f.opener, { gsapApi: f.gsapApi, matchMedia: () => f.media, getActiveElement: () => f.activeElement })

  assert.equal(f.opener.disabled, false)
  assert.equal(f.panel.inert, true, 'el panel no recibe foco mientras está entrando')
  assert.equal(f.panel.dataset.gateState, 'opening')
  const entry = f.timelines[0]
  assert.equal(entry.steps[0].method, 'fromTo')
  assert.deepEqual(
    { y: entry.steps[0].from.y, rotationX: entry.steps[0].from.rotationX, opacity: entry.steps[0].from.autoAlpha },
    { y: -24, rotationX: -8, opacity: 0 },
  )
  assert.equal(entry.steps[1].to.stagger, .055)
  entry.complete()
  assert.equal(f.panel.inert, false)
  assert.equal(f.activeElement, f.firstInput, 'el foco entra al formulario cuando ya está visible')

  f.cancel.click()
  assert.equal(f.panel.dataset.gateState, 'closing')
  assert.equal(f.opener.disabled, false, 'el disparador está habilitado antes de recibir el foco')
  assert.equal(f.activeElement, f.opener, 'el foco sale del panel al iniciar la salida')
  assert.equal(f.panel.inert, true, 'el panel queda inerte mientras termina su animación')
  assert.ok(f.controls.every(control => control.disabled), 'el formulario se bloquea durante la salida')
  const exit = f.timelines[1]
  f.cancel.click()
  assert.equal(f.timelines.length, 2, 'el segundo clic no inicia otra salida')
  f.activeElement = { name: 'otro control' }
  exit.complete()
  assert.equal(f.box.removed, true)
  assert.equal(f.opener.disabled, false)
  assert.equal(f.opener.focused, true)
  assert.notEqual(f.activeElement, f.opener, 'la salida no roba foco si la persona ya navegó')
})

test('si movimiento reducido se activa en vivo, la entrada y la salida se completan de inmediato', () => {
  const f = fixture()
  wireLoanGate(f.box, f.opener, { gsapApi: f.gsapApi, matchMedia: () => f.media, getActiveElement: () => f.activeElement })
  const entry = f.timelines[0]
  f.media.matches = true
  f.media.change()
  assert.equal(entry.killed, true)
  assert.equal(f.panel.dataset.gateState, 'open')

  f.media.matches = false
  f.media.change()
  f.cancel.click()
  const exit = f.timelines[1]
  f.media.matches = true
  f.media.change()
  assert.equal(exit.killed, true)
  assert.equal(f.box.removed, true)
  assert.equal(f.opener.focused, true)
  assert.equal(f.listeners.size, 0, 'la preferencia deja de escucharse al cerrar el formulario')
})

test('al reemplazar o salir de la vista se cancelan tweens y se retira el listener', () => {
  const f = fixture()
  const cleanup = wireLoanGate(f.box, f.opener, { gsapApi: f.gsapApi, matchMedia: () => f.media })
  cleanup()
  assert.equal(f.timelines[0].killed, true)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.opener.disabled, false)
  assert.equal(f.panel.dataset.gateState, undefined)
  assert.ok(f.gsapApi.resets.length > 0)
})
