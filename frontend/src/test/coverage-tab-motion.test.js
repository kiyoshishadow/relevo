import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const { createCoverageTabMotion } = await import('../views/coverages.js')
styles.deregister()

function fixture(reduced = false) {
  const listeners = new Set()
  const mediaQuery = {
    matches: reduced,
    addEventListener(_name, listener) { listeners.add(listener) },
    removeEventListener(_name, listener) { listeners.delete(listener) },
    change(matches) {
      this.matches = matches
      for (const listener of [...listeners]) listener({ matches })
    },
  }
  const tweens = []
  const sets = []
  const gsapApi = {
    fromTo(target, from, to) {
      const tween = { target, from, to, killed: false, kill() { this.killed = true } }
      tweens.push(tween)
      return tween
    },
    to(target, vars) {
      const tween = { target, vars, killed: false, kill() { this.killed = true } }
      tweens.push(tween)
      return tween
    },
    set(target, vars) { sets.push({ target, vars }) },
  }
  const clones = []
  const tab = {
    isConnected: true,
    style: {},
    getBoundingClientRect: () => ({ left: 8, top: 16, width: 140, height: 40 }),
    cloneNode: () => {
      const clone = {
        style: {}, connected: false,
        setAttribute() {},
        remove() { this.connected = false },
      }
      clones.push(clone)
      return clone
    },
  }
  const documentRef = { body: { appendChild(node) { node.connected = true } } }
  return { tab, mediaQuery, listeners, tweens, sets, clones, gsapApi, documentRef }
}

test('policy sheet opens on decorative transforms only and reduced motion settles it immediately', () => {
  const f = fixture()
  const motion = createCoverageTabMotion(f.tab, { gsapApi: f.gsapApi, mediaQuery: f.mediaQuery, documentRef: f.documentRef })
  motion.reveal()

  assert.equal(f.tweens.length, 1)
  assert.equal(f.tweens[0].target, f.tab)
  assert.equal(f.tweens[0].to.opacity, 1)
  assert.equal(f.tweens[0].to.clearProps, 'transform,opacity')
  f.mediaQuery.change(true)
  assert.equal(f.tweens[0].killed, true)
  assert.equal(f.sets.at(-1).target, f.tab)
  assert.equal(f.sets.at(-1).vars.opacity, 1)
  motion.cleanup()
  assert.equal(f.listeners.size, 0)
})

test('reduced motion at open skips the tween; closing retracts a detached decorative tab', () => {
  const f = fixture(true)
  const motion = createCoverageTabMotion(f.tab, { gsapApi: f.gsapApi, mediaQuery: f.mediaQuery, documentRef: f.documentRef })
  motion.reveal()
  assert.equal(f.tweens.length, 0)
  assert.equal(f.sets[0].target, f.tab)
  f.mediaQuery.change(false)
  motion.retract()

  assert.equal(f.clones.length, 1)
  assert.equal(f.clones[0].connected, true)
  assert.equal(f.clones[0].style.left, '8px')
  assert.equal(f.tweens[0].target, f.clones[0])
  assert.equal(f.tweens[0].vars.opacity, 0)
  f.tweens[0].vars.onComplete()
  assert.equal(f.clones[0].connected, false)
  assert.equal(f.listeners.size, 0)
})

test('a live reduced-motion change cancels and cleans up an in-flight retract', () => {
  const f = fixture()
  const motion = createCoverageTabMotion(f.tab, { gsapApi: f.gsapApi, mediaQuery: f.mediaQuery, documentRef: f.documentRef })
  motion.reveal()
  motion.retract()
  const retract = f.tweens.at(-1)
  f.mediaQuery.change(true)

  assert.equal(retract.killed, true)
  assert.equal(f.clones[0].connected, false)
  assert.equal(f.listeners.size, 0)
})

test('cleanup cancels an entrance tween and removes its live preference listener', () => {
  const f = fixture()
  const motion = createCoverageTabMotion(f.tab, { gsapApi: f.gsapApi, mediaQuery: f.mediaQuery, documentRef: f.documentRef })
  motion.reveal()
  const entrance = f.tweens[0]
  motion.cleanup()

  assert.equal(entrance.killed, true)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.sets.at(-1).vars.clearProps, 'transform,opacity')
})
