import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/styles/terminals-motion.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const { createCoverageCardMotion } = await import('../views/terminals.js')
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
  const activeTweens = new Set()
  const applyClearProps = (target, props) => {
    for (const property of String(props || '').split(',')) delete target.style[property.trim()]
  }
  const gsapApi = {
    fromTo(target, from, to) {
      target.style.opacity = String(from.autoAlpha)
      target.style.visibility = from.autoAlpha === 0 ? 'hidden' : 'inherit'
      const tween = {
        method: 'fromTo', target, from, vars: to, killed: false,
        kill() { this.killed = true },
        complete() {
          if (to.autoAlpha !== undefined) {
            target.style.opacity = String(to.autoAlpha)
            target.style.visibility = to.autoAlpha === 0 ? 'hidden' : 'inherit'
          }
          applyClearProps(target, to.clearProps)
          to.onComplete?.()
        },
      }
      tweens.push(tween)
      return tween
    },
    to(target, vars) {
      const tween = {
        method: 'to', target, vars, killed: false,
        kill() { this.killed = true },
        complete() {
          if (vars.autoAlpha !== undefined) {
            target.style.opacity = String(vars.autoAlpha)
            target.style.visibility = vars.autoAlpha === 0 ? 'hidden' : 'inherit'
          }
          applyClearProps(target, vars.clearProps)
          vars.onComplete?.()
        },
      }
      tweens.push(tween)
      return tween
    },
    set(target, vars) { resets.push({ target, vars }); applyClearProps(target, vars.clearProps) },
  }
  const dataset = {}
  const card = { hidden: true, dataset, style: {} }
  return { media, listeners, tweens, resets, activeTweens, gsapApi, card }
}

test('selección y sustitución encajan una sola ficha; identidad sin cambios no repite movimiento', () => {
  const f = fixture()
  const motion = createCoverageCardMotion(f.card, { gsapApi: f.gsapApi, mediaQuery: f.media, tweens: f.activeTweens })
  motion.sync('global-plan')
  assert.equal(f.card.hidden, false)
  assert.equal(f.tweens[0].method, 'fromTo')
  assert.equal(f.tweens[0].from.y, -14)
  assert.equal(f.card.dataset.coverageMotion, 'seat')
  assert.match(f.tweens[0].vars.clearProps, /visibility/)
  motion.sync('global-plan')
  assert.equal(f.tweens.length, 1)

  motion.sync('brand-plan')
  assert.equal(f.tweens[0].killed, true)
  assert.equal(f.tweens[1].from.x, 16)
  assert.equal(f.card.dataset.coverageMotion, 'replace')
  f.tweens[1].complete()
  assert.equal(f.card.hidden, false)
  assert.equal(f.activeTweens.size, 0)
  motion.dispose()
})

test('Sin plan e invalidación por marca retiran la ficha por rutas visuales diferentes', () => {
  const f = fixture()
  const motion = createCoverageCardMotion(f.card, { gsapApi: f.gsapApi, mediaQuery: f.media, tweens: f.activeTweens })
  motion.sync('plan-a')
  f.tweens[0].complete()
  motion.sync('', 'none')
  const manualRetire = f.tweens[1]
  assert.equal(manualRetire.method, 'to')
  assert.equal(manualRetire.vars.y, 13)
  assert.equal(f.card.dataset.retireReason, 'none')
  manualRetire.complete()
  assert.equal(f.card.hidden, true)

  motion.sync('plan-b')
  f.tweens[2].complete()
  motion.sync('', 'incompatible')
  const automaticRetire = f.tweens[3]
  assert.equal(automaticRetire.vars.x, 18)
  assert.equal(automaticRetire.vars.y, -3)
  assert.equal(f.card.dataset.retireReason, 'incompatible')
  automaticRetire.complete()
  assert.equal(f.card.hidden, true)
  motion.dispose()
})

test('reduced motion fija el estado final en vivo y dispose cancela y retira listener', () => {
  const f = fixture({ reduced: true })
  const motion = createCoverageCardMotion(f.card, { gsapApi: f.gsapApi, mediaQuery: f.media, tweens: f.activeTweens })
  motion.sync('plan-a')
  assert.equal(f.card.hidden, false)
  assert.equal(f.tweens.length, 0)

  f.media.matches = false
  motion.sync('', 'none')
  const exit = f.tweens[0]
  f.media.matches = true
  f.media.change()
  assert.equal(exit.killed, true)
  assert.equal(f.card.hidden, true)
  assert.equal(f.activeTweens.size, 0)
  assert.equal(f.listeners.size, 1)

  f.media.matches = false
  motion.sync('plan-b')
  const entry = f.tweens[1]
  motion.dispose()
  assert.equal(entry.killed, true)
  assert.equal(f.card.hidden, true)
  assert.equal(f.listeners.size, 0)
})

test('retiro completo limpia visibility; plan nuevo con reduced motion queda visible y una interrupción se cancela', () => {
  const f = fixture()
  const motion = createCoverageCardMotion(f.card, { gsapApi: f.gsapApi, mediaQuery: f.media, tweens: f.activeTweens })
  motion.sync('plan-anterior')
  f.tweens[0].complete()
  motion.sync('', 'none')
  const retirement = f.tweens[1]
  assert.match(retirement.vars.clearProps, /visibility/)
  retirement.complete()
  assert.equal(f.card.hidden, true)
  assert.equal(f.card.style.visibility, undefined)
  assert.ok(f.resets.some(reset => reset.vars.clearProps.includes('visibility')))

  f.media.matches = true
  f.media.change()
  motion.sync('plan-nuevo')
  assert.equal(f.card.hidden, false)
  assert.equal(f.card.style.visibility, undefined)

  f.media.matches = false
  motion.sync('plan-sustituto')
  const interrupted = f.tweens[2]
  assert.equal(f.card.style.visibility, 'hidden', 'la entrada animada empieza con autoAlpha=0')
  f.media.matches = true
  f.media.change()
  assert.equal(interrupted.killed, true)
  assert.equal(f.card.hidden, false)
  assert.equal(f.card.style.visibility, undefined, 'la cancelación no deja visibility:hidden')
  assert.equal(f.activeTweens.size, 0)
  motion.dispose()
})
