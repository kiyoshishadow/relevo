import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const { playBenchOpen } = await import('../views/cases.js')
styles.deregister()

function fakeElement(trace) {
  const classes = new Set()
  return {
    isConnected: true,
    classList: {
      add: name => classes.add(name),
      remove: name => { classes.delete(name); trace?.push({ kind: 'class-remove', name }) },
      contains: name => classes.has(name),
    },
  }
}

function fakeBench(parts, trace) {
  const bench = fakeElement(trace)
  bench.querySelector = selector => parts[selector] || null
  return bench
}

function fakeEngine(trace) {
  const timelines = []
  const engine = {
    timelines,
    getProperty: (target, prop) => Number(target?.[prop]) || 0,
    set(target, vars) { trace?.push({ kind: 'set', target, vars }) },
    timeline(vars) {
      const children = []
      const callbacks = {}
      const tl = {
        vars,
        children,
        callbacks,
        killed: false,
        to(target, tweenVars, position) { children.push({ target, vars: tweenVars, at: position ?? 0 }); return tl },
        kill() { tl.killed = true },
        eventCallback(name, fn) { callbacks[name] = fn },
      }
      tl.complete = () => { if (!tl.killed) callbacks.onComplete?.() }
      timelines.push(tl)
      return tl
    },
  }
  return engine
}

// Posiciones tipo modo (la pantalla puede venir desplazada por data-mode).
function fixture() {
  const trace = []
  const parts = {
    '.case-bench__screen': { z: 70, y: 10 },
    '.case-bench__board': { z: 42, y: 0 },
    '.case-bench__shell': { z: -18, y: 0 },
  }
  const bench = fakeBench(parts, trace)
  const engine = fakeEngine(trace)
  const store = { record: undefined }
  const onStore = record => { store.record = record }
  const play = overrides => playBenchOpen({ bench, animate: engine, isReduced: () => false, onStore, previous: store.record, ...overrides })
  return { parts, bench, engine, store, trace, play }
}

test('con movimiento reducido no anima, cancela una apertura previa y limpia su clase', () => {
  const { engine, store } = fixture()
  const stopped = []
  const previous = { stop() { stopped.push(true) } }
  const record = playBenchOpen({
    animate: engine,
    isReduced: () => true,
    previous,
    onStore: value => { store.record = value },
    bench: fakeBench({ '.case-bench__screen': { z: 35 } }),
  })

  assert.equal(record, null)
  assert.equal(stopped.length, 1, 'detiene la animación previa aunque no empiece una nueva')
  assert.equal(engine.timelines.length, 0, 'no crea tweens para movimiento reducido')
  assert.equal(store.record, null, 'no queda registro pendiente de limpieza')
})

test('cada capa se abre hacia su lado y regresa a la posición capturada del modo', () => {
  const { parts, bench, engine, store, play } = fixture()
  const record = play()

  assert.ok(bench.classList.contains('is-brief-open'), 'usa la clase que apaga la transición CSS de las piezas')
  assert.equal(engine.timelines.length, 1)
  assert.equal(store.record?.tl, engine.timelines[0], 'la apertura queda registrada para su limpieza')

  const opened = { '.case-bench__screen': { z: 116, y: 0 }, '.case-bench__board': { z: 26, y: 0 }, '.case-bench__shell': { z: -26, y: 0 } }
  for (const [name, part] of Object.entries(parts)) {
    const moves = engine.timelines[0].children.filter(child => child.target === part)
    assert.equal(moves.length, 2, `${name} abre y regresa`)
    const [open, back] = moves
    assert.equal(open.vars.z, opened[name].z, `${name} se abre hacia su delta`)
    assert.equal(open.vars.y, opened[name].y, `${name} conserva su desplazamiento de modo al abrir`)
    assert.equal(back.vars.z, part.z, `${name} regresa a su línea base`)
    assert.equal(back.vars.y, part.y, `${name} regresa a su línea base vertical`)
    assert.equal(back.vars.clearProps, 'transform', `${name} devuelve el mando al CSS al terminar`)
  }

  const newest = Math.max(...engine.timelines[0].children.map(c => c.at + c.vars.duration))
  assert.ok(newest <= 0.75, `la coreografía completa es breve, dura ${newest}s`)
  for (const child of engine.timelines[0].children) {
    assert.ok(!('repeat' in child.vars), 'sin bucles')
    assert.ok(!('yoyo' in child.vars), 'sin vaivén infinito')
  }
})

test('repetir el salto cancela la apertura anterior y renueva la escena', () => {
  const { parts, bench, engine, store, trace, play } = fixture()
  const first = play()
  const second = play()

  assert.notEqual(first, second)
  assert.equal(first.tl.killed, true, 'la animación previa queda cancelada')
  const cleaned = trace.filter(e => e.kind === 'set' && e.vars.clearProps === 'transform')
  assert.equal(cleaned.length, Object.keys(parts).length,
    'cancelar la apertura anterior limpia el transform inline de cada capa')
  assert.equal(engine.timelines.length, 2)
  assert.equal(store.record?.tl, second.tl, 'solo la última queda registrada')
  assert.ok(bench.classList.contains('is-brief-open'))

  second.tl.complete()
  assert.ok(!bench.classList.contains('is-brief-open'), 'al completar se retira la clase')
  assert.equal(store.record, null, 'al completar se libera el registro')
})

test('cancelar a mitad de vuelo no contamina la línea base del regreso', () => {
  const { parts, bench, engine, play } = fixture()
  play()
  // Un vuelo interrumpido deja el transform inline a mitad de camino.
  Object.assign(parts['.case-bench__screen'], { z: 93, y: -3 })
  const offset = parts['.case-bench__board']
  Object.assign(offset, { z: 30 })

  play()
  for (const [name, part] of Object.entries(parts)) {
    const back = engine.timelines[1].children.find(c => c.target === part && 'clearProps' in c.vars)
    // La línea base quedó capturada en el primer vuelo: replica el modo, no el vuelo interrumpido.
    assert.equal(back.vars.z, { '.case-bench__screen': 70, '.case-bench__board': 42, '.case-bench__shell': -18 }[name],
      `${name} regresa a la posición del modo, no al vuelo interrumpido`)
    assert.equal(back.vars.y, { '.case-bench__screen': 10, '.case-bench__board': 0, '.case-bench__shell': 0 }[name])
  }
})

test('stop() al interrumpir limpia el transform inline antes de retirar la clase y libera el registro', () => {
  const { parts, bench, engine, store, trace, play } = fixture()
  const record = play()
  // Vuelo interrumpido: el transform inline quedó a mitad de camino.
  Object.assign(parts['.case-bench__screen'], { z: 93, y: -3 })

  record.stop()
  assert.equal(record.tl.killed, true)
  const clearings = trace.filter(e => e.kind === 'set' && e.vars.clearProps === 'transform')
  assert.deepEqual(clearings.map(e => e.target), Object.values(parts),
    'cada capa vuelve al transform del modo, también la del vuelo interrumpido')
  const setAt = trace.reduce((last, e, i) => e.kind === 'set' ? i : last, -1)
  const removeAt = trace.findIndex(e => e.kind === 'class-remove' && e.name === 'is-brief-open')
  assert.ok(setAt !== -1 && setAt < removeAt, 'limpia el inline antes de retirar la clase')
  assert.ok(!bench.classList.contains('is-brief-open'))
  assert.equal(store.record, null)

  record.tl.complete()
  assert.equal(record.tl.children.length, 6, 'el kill no ejecuta callbacks de finalización')
})

test('sin banco vigente no toca el DOM ni deja registro', () => {
  const { engine, store } = fixture()
  const detached = fakeBench({ '.case-bench__screen': { z: 35 } })
  detached.isConnected = false
  const record = playBenchOpen({ bench: detached, animate: engine, isReduced: () => false, onStore: value => { store.record = value } })

  assert.equal(record, null)
  assert.equal(engine.timelines.length, 0)
  assert.ok(!detached.classList.contains('is-brief-open'))
  assert.equal(store.record, null)
})
