import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createUserRoleMotion, confirmUserRoleFromSnapshot } from '../user-role-motion.js'

function fakeFrame() {
  const classes = new Set()
  return {
    isConnected: true,
    classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
  }
}

function fakeRow(id, role, { hidden = false, connected = true } = {}) {
  const frame = fakeFrame()
  const row = {
    isConnected: connected,
    hidden,
    dataset: { userId: String(id), role },
    closest: () => null,
    querySelector: selector => selector === '[data-user-role-frame]' ? frame : null,
  }
  return { row, frame }
}

function fakeGsap() {
  const calls = []
  const timelines = []
  return {
    calls,
    timelines,
    set(target, vars) { calls.push({ type: 'set', target, vars }) },
    timeline(options = {}) {
      const timeline = {
        killed: false,
        steps: [],
        to(target, vars, position) { this.steps.push({ target, vars, position }); return this },
        kill() { this.killed = true },
        complete() { options.onComplete?.() },
      }
      timelines.push(timeline)
      return timeline
    },
  }
}

function fakeMedia(matches = false) {
  const listeners = new Set()
  return {
    matches,
    listeners,
    addEventListener(_type, listener) { listeners.add(listener) },
    removeEventListener(_type, listener) { listeners.delete(listener) },
    change(value) { this.matches = value; for (const listener of [...listeners]) listener({ matches: value }) },
  }
}

function fakeRoot(rows) {
  return { isConnected: true, querySelectorAll: () => rows }
}

test('solo confirma el rol nuevo en la fila del mismo ID', () => {
  const first = fakeRow(12, 'technician')
  const other = fakeRow(44, 'technician')
  const gsap = fakeGsap()
  const motion = createUserRoleMotion({ root: fakeRoot([other.row, first.row]), gsapApi: gsap, mediaQuery: fakeMedia() })
  assert.equal(motion.confirm({ id: 12, previousRole: 'reception', confirmedRole: 'technician' }), true)
  assert.equal(gsap.timelines.length, 1)
  assert.ok(gsap.timelines[0].steps.every(step => step.target === first.frame))
  assert.equal(first.frame.classList.contains('is-active'), true)
  assert.ok(gsap.timelines[0].steps.some(step => step.vars.duration >= 0.2))
  motion.dispose()
})

test('no anima creación, cambio de otros campos, rol igual o fila fuera de vista', () => {
  const visible = fakeRow(1, 'admin')
  const hidden = fakeRow(2, 'technician', { hidden: true })
  const gsap = fakeGsap()
  const motion = createUserRoleMotion({ root: fakeRoot([visible.row, hidden.row]), gsapApi: gsap, mediaQuery: fakeMedia() })
  assert.equal(motion.confirm({ id: 1, previousRole: 'admin', confirmedRole: 'admin' }), false)
  assert.equal(motion.confirm({ id: 2, previousRole: 'reception', confirmedRole: 'technician' }), false)
  assert.equal(motion.confirm({ id: 3, previousRole: 'reception', confirmedRole: 'admin' }), false)
  assert.equal(motion.confirm({ id: 1, previousRole: 'reception', confirmedRole: 'technician' }), false)
  assert.equal(gsap.timelines.length, 0)
  motion.dispose()
})

test('el rol se obtiene de la instantánea confirmada del GET', () => {
  const calls = []
  const motion = { confirm: payload => { calls.push(payload); return true } }
  const users = [{ id: 7, role: 'admin' }]
  assert.equal(confirmUserRoleFromSnapshot({ motion, users, id: '7', previousRole: 'reception' }), true)
  assert.deepEqual(calls, [{ id: '7', previousRole: 'reception', confirmedRole: 'admin' }])
  assert.equal(confirmUserRoleFromSnapshot({ motion, users: [], id: 7, previousRole: 'reception' }), false)
  assert.equal(confirmUserRoleFromSnapshot({ motion, users, id: 7, previousRole: 'admin' }), false)
  assert.equal(calls.length, 1)
})

test('reduced motion inicial no crea tween ni estilos inline para el marco decorativo', () => {
  const { row } = fakeRow(1, 'admin')
  const gsap = fakeGsap()
  const motion = createUserRoleMotion({ root: fakeRoot([row]), gsapApi: gsap, mediaQuery: fakeMedia(true) })
  assert.equal(motion.confirm({ id: 1, previousRole: 'reception', confirmedRole: 'admin' }), false)
  assert.equal(gsap.timelines.length, 0)
  assert.equal(gsap.calls.length, 0)
  motion.dispose()
})

test('activar reduced motion durante el vuelo cancela el tween, quita la clase y limpia estilos inline', () => {
  const { row, frame } = fakeRow(1, 'technician')
  const gsap = fakeGsap()
  const media = fakeMedia()
  const motion = createUserRoleMotion({ root: fakeRoot([row]), gsapApi: gsap, mediaQuery: media })
  motion.confirm({ id: 1, previousRole: 'reception', confirmedRole: 'technician' })
  const active = gsap.timelines[0]
  media.change(true)
  assert.equal(active.killed, true)
  assert.equal(frame.classList.contains('is-active'), false)
  assert.ok(gsap.calls.some(call => call.target === frame && call.vars.clearProps === 'opacity,scale,transform'))
  media.change(false)
  assert.equal(gsap.timelines.length, 1, 'no reproduce la animación cuando vuelve a movimiento normal')
  motion.dispose()
})

test('dispose cancela tween y retira el listener de preferencia', () => {
  const { row } = fakeRow(1, 'admin')
  const gsap = fakeGsap()
  const media = fakeMedia()
  const motion = createUserRoleMotion({ root: fakeRoot([row]), gsapApi: gsap, mediaQuery: media })
  motion.confirm({ id: 1, previousRole: 'reception', confirmedRole: 'admin' })
  const tween = gsap.timelines[0]
  motion.dispose()
  assert.equal(tween.killed, true)
  assert.equal(media.listeners.size, 0)
  assert.equal(motion.confirm({ id: 1, previousRole: 'reception', confirmedRole: 'admin' }), false)
})

test('texto de rol conserva lectura semántica y el marco decorativo se oculta a AT', async () => {
  const source = await readFile(new URL('../views/admin.js', import.meta.url), 'utf8')
  assert.match(source, /data-user-role-label/)
  assert.match(source, /data-user-role-frame aria-hidden="true"/)
})
