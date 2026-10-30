import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const { createUsersPageHandler, createUsersPagination, createUsersRangeMotion } = await import('../views/admin.js')
styles.deregister()

function fakeGsap() {
  const calls = []
  return {
    calls,
    set(target, vars) { calls.push({ type: 'set', target, vars }) },
    to(target, vars) {
      const tween = { type: 'to', target, vars, killed: false, kill() { this.killed = true } }
      calls.push(tween)
      return tween
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
    change(value) { this.matches = value; for (const listener of listeners) listener({ matches: value }) },
  }
}

function element(width) {
  return { getBoundingClientRect: () => ({ width }) }
}

test('el índice se anima solo tras una página distinta cargada con éxito', async () => {
  const gsap = fakeGsap()
  const track = element(100)
  const needle = element(10)
  const motion = createUsersRangeMotion({ getTrack: () => track, getNeedle: () => needle, gsapApi: gsap, mediaQuery: fakeMedia() })
  let paintedPage = null
  const onPage = createUsersPageHandler(() => {}, (_data, meta) => {
    const page = meta.page
    motion.update(page, meta.pages, { animate: paintedPage !== null && paintedPage !== page })
    paintedPage = page
  })
  let fail = false
  const controller = createUsersPagination({
    fetchPage: async page => {
      if (fail) { fail = false; throw new Error('GET falló') }
      return { data: [], meta: { page, pages: 3, pageSize: 100, total: 300 } }
    },
    onPage,
  })

  await controller.load(1)
  assert.deepEqual(gsap.calls.map(call => call.type), ['set'], 'la primera carga fija el índice sin animar')
  fail = true
  assert.equal(await controller.load(2), false)
  assert.equal(gsap.calls.length, 1, 'un GET fallido no altera ni anima el índice')
  await controller.retry()
  assert.equal(gsap.calls.at(-1).type, 'to')
  assert.equal(gsap.calls.at(-1).vars.x, 45)
  assert.equal(gsap.calls.at(-1).vars.duration, 0.15)
  motion.dispose()
})

test('retarget coloca una aguja nueva en la página anterior antes de avanzar o retroceder', async () => {
  const gsap = fakeGsap()
  const track = element(100)
  let needle = { ...element(10), key: 'render-0' }
  const renderedNeedles = []
  const motion = createUsersRangeMotion({ getTrack: () => track, getNeedle: () => needle, gsapApi: gsap, mediaQuery: fakeMedia() })
  let previousPage = null
  const onPage = createUsersPageHandler(() => {
    needle = { ...element(10), key: `render-${renderedNeedles.length + 1}` }
    renderedNeedles.push(needle)
  }, (_data, meta) => {
    const range = { page: meta.page, pages: 3 }
    motion.update(range.page, range.pages, { animate: previousPage !== null && previousPage !== range.page, fromPage: previousPage })
    previousPage = range.page
  })
  const controller = createUsersPagination({
    fetchPage: async page => ({ data: [], meta: { page, pageSize: 100, total: 300 } }),
    onPage,
  })

  await controller.load(1)
  await controller.load(2)
  const forwardSet = gsap.calls.at(-2)
  const forwardTween = gsap.calls.at(-1)
  assert.equal(forwardSet.type, 'set')
  assert.equal(forwardSet.target, renderedNeedles.at(-1))
  assert.equal(forwardSet.vars.x, 0)
  assert.equal(forwardTween.vars.x, 45)

  await controller.load(1)
  const backwardSet = gsap.calls.at(-2)
  const backwardTween = gsap.calls.at(-1)
  assert.equal(backwardSet.target, renderedNeedles.at(-1))
  assert.equal(backwardSet.vars.x, 45)
  assert.equal(backwardTween.vars.x, 0)

  await controller.load(2)
  await controller.load(3)
  const finalSet = gsap.calls.at(-2)
  const finalTween = gsap.calls.at(-1)
  assert.equal(finalSet.vars.x, 45)
  assert.equal(finalTween.vars.x, 90)
  motion.dispose()
})

test('reduced-motion inicial y en vivo fija el destino; dispose mata tween y listener', () => {
  const gsap = fakeGsap()
  const media = fakeMedia(true)
  const motion = createUsersRangeMotion({ getTrack: () => element(100), getNeedle: () => element(10), gsapApi: gsap, mediaQuery: media })
  motion.update(3, 3, { animate: true })
  assert.equal(gsap.calls.at(-1).type, 'set')
  assert.equal(gsap.calls.at(-1).vars.x, 90)

  media.change(false)
  motion.update(1, 3, { animate: true })
  const activeTween = gsap.calls.at(-1)
  assert.equal(activeTween.type, 'to')
  media.change(true)
  assert.equal(activeTween.killed, true)
  assert.equal(gsap.calls.at(-1).type, 'set')
  assert.equal(gsap.calls.at(-1).vars.x, 0)

  media.change(false)
  motion.update(2, 3, { animate: true })
  const finalTween = gsap.calls.at(-1)
  motion.dispose()
  assert.equal(finalTween.killed, true)
  assert.equal(media.listeners.size, 0)
})
