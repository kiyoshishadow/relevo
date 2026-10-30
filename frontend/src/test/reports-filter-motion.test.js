import test from 'node:test'
import assert from 'node:assert/strict'
import { createReportConnectionMotion, createReportPassportModel, unlockReportControlsThenRefresh } from '../report-query-passport.js'

function values(entries = {}) {
  const form = new FormData()
  for (const [key, value] of Object.entries(entries)) form.set(key, value)
  return form
}

function fakeGsap() {
  const calls = []
  return {
    calls,
    set(target, vars) { calls.push({ type: 'set', target, vars }) },
    fromTo(target, fromVars, toVars) {
      const tween = { type: 'fromTo', target, fromVars, toVars, killed: false, kill() { this.killed = true } }
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
    addEventListener(_type, fn) { listeners.add(fn) },
    removeEventListener(_type, fn) { listeners.delete(fn) },
    change(value) { this.matches = value; for (const fn of [...listeners]) fn({ matches: value }) },
  }
}

function connector() {
  return { isConnected: true, style: {}, getBoundingClientRect: () => ({ width: 1 }) }
}

test('ficha deriva firma y valores del catálogo real para cero, uno y cuatro filtros', () => {
  const passport = createReportPassportModel()
  const labels = { from: 'Desde', to: 'Hasta', technician_id: 'ID del técnico', brand: 'Marca' }
  const zero = passport.capture({ slug: 'summary', name: 'Resumen', filters: [] }, values(), labels)
  assert.equal(zero.filters.length, 0)
  assert.equal(passport.status(zero), 'Sin generar')

  const one = passport.capture({ slug: 'device', name: 'Equipos', filters: ['brand'] }, values({ brand: ' Samsung ' }), labels)
  assert.deepEqual(one.filters, [{ key: 'brand', label: 'Marca', value: 'Samsung' }])
  assert.equal(one.params.toString(), 'brand=Samsung')

  const four = passport.capture({ slug: 'activity', name: 'Actividad', filters: ['from', 'to', 'technician_id', 'brand'] }, values({
    from: '2026-10-01', to: '2026-10-29', technician_id: '7', brand: 'Pixel', ignored: 'no',
  }), labels)
  assert.equal(four.filters.length, 4)
  assert.deepEqual(four.filters.map(filter => filter.value), ['2026-10-01', '2026-10-29', '7', 'Pixel'])
  assert.match(four.signature, /activity/)
})

test('cambio y reset distinguen borrador de pasaporte del último GET mostrado; descarga no cambia firma', () => {
  const passport = createReportPassportModel()
  const report = { slug: 'income', name: 'Ingresos', filters: ['from', 'to'] }
  const first = passport.capture(report, values({ from: '2026-10-01', to: '2026-10-15' }), { from: 'Desde', to: 'Hasta' })
  assert.equal(passport.commitScreen(first), true)
  assert.equal(passport.status(first), 'Coincide con el último resultado')
  assert.equal(passport.lastDisplayed().name, 'Ingresos', 'el pasaporte del resultado conserva el reporte de origen')

  const changed = passport.capture(report, values({ from: '2026-10-02', to: '2026-10-15' }), { from: 'Desde', to: 'Hasta' })
  assert.equal(passport.status(changed), 'Cambios sin generar')
  assert.equal(passport.lastDisplayed().name, 'Ingresos')
  assert.equal(passport.lastDisplayed().filters[0].value, '2026-10-01', 'el pasaporte conserva los valores originales del resultado')

  const downloadParams = new URLSearchParams(changed.params)
  downloadParams.set('format', 'pdf')
  assert.equal(passport.status(changed), 'Cambios sin generar', 'preparar descarga no confirma un resultado en pantalla')
  const reset = passport.capture(report, values(), { from: 'Desde', to: 'Hasta' })
  assert.equal(reset.filters.length, 0)
  assert.equal(passport.status(reset), 'Cambios sin generar')
  passport.clearDisplayed()
  assert.equal(passport.status(reset), 'Sin generar', 'el error que reemplaza el resultado descarta el pasaporte mostrado')
})

test('ciclo screen exitoso rehabilita controles antes de recalcular la ficha con los filtros enviados', () => {
  const passport = createReportPassportModel()
  const report = { slug: 'income', name: 'Ingresos', filters: ['from', 'to'] }
  const controls = [
    { name: 'slug', value: 'income', disabled: true },
    { name: 'from', value: '2026-10-01', disabled: true },
    { name: 'to', value: '2026-10-29', disabled: true },
    { name: 'format', value: 'screen', disabled: true },
  ]
  const sentSnapshot = passport.capture(report, values({ from: '2026-10-01', to: '2026-10-29' }), { from: 'Desde', to: 'Hasta' })
  passport.commitScreen(sentSnapshot)

  let refreshed
  unlockReportControlsThenRefresh(controls, () => {
    const formData = new FormData()
    controls.filter(control => !control.disabled).forEach(control => formData.set(control.name, control.value))
    refreshed = passport.capture(report, formData, { from: 'Desde', to: 'Hasta' })
  })

  assert.equal(refreshed.filters.length, 2)
  assert.equal(refreshed.signature, sentSnapshot.signature)
  assert.equal(passport.status(refreshed), 'Coincide con el último resultado')

  const changedSlug = passport.capture({ slug: 'cases', name: 'Casos', filters: ['technician_id'] }, values({ technician_id: '8' }), { technician_id: 'ID del técnico' })
  assert.equal(passport.status(changedSlug), 'Cambios sin generar')
  assert.equal(passport.lastDisplayed().name, 'Ingresos')
  assert.deepEqual(passport.lastDisplayed().filters.map(filter => filter.value), ['2026-10-01', '2026-10-29'])
})

test('un GET tardío después de salir no puede confirmar ni acceder a la ficha', () => {
  const passport = createReportPassportModel()
  const snapshot = passport.capture({ slug: 'cases', name: 'Casos', filters: [] }, values())
  passport.dispose()
  assert.equal(passport.isActive(), false)
  assert.equal(passport.commitScreen(snapshot), false)
  assert.equal(passport.lastDisplayed(), null)
})

test('la conexión decorativa aparece solo al conectar, retarget/cancel/clear limpian tween y salida listeners', () => {
  const gsap = fakeGsap()
  const media = fakeMedia(false)
  const node = connector()
  const motion = createReportConnectionMotion({ getConnector: () => node, gsapApi: gsap, mediaQuery: media })
  assert.equal(media.listeners.size, 1)
  assert.equal(gsap.calls.length, 0, 'crear la ficha no dibuja conexión')

  motion.connect()
  const first = gsap.calls.at(-1)
  assert.equal(first.type, 'fromTo')
  motion.connect()
  assert.equal(first.killed, true, 'un retarget mata el tween anterior')
  const second = gsap.calls.at(-1)
  motion.cancel()
  assert.equal(second.killed, true, 'retry cancela el tween pendiente y deja destino final')
  assert.equal(gsap.calls.at(-1).type, 'set')
  motion.clear()
  assert.equal(gsap.calls.at(-1).vars.opacity, 0, 'error limpia la línea que ya no apunta a resultado')
  const clearedAt = gsap.calls.length
  motion.cancel()
  assert.equal(gsap.calls.length, clearedAt, 'reintentar no vuelve visible la conexión sin un GET exitoso')

  motion.connect()
  const leaving = gsap.calls.at(-1)
  motion.dispose()
  assert.equal(leaving.killed, true)
  assert.equal(media.listeners.size, 0)
  const callsAfterDispose = gsap.calls.length
  motion.clear()
  motion.connect()
  assert.equal(gsap.calls.length, callsAfterDispose, 'tras salir no se escribe en el DOM')
})

test('reduced-motion inicial/en vivo y ausencia de GSAP fijan estado final sin tween', () => {
  const reducedGsap = fakeGsap()
  const reducedQuery = fakeMedia(true)
  const reducedNode = connector()
  const reduced = createReportConnectionMotion({ getConnector: () => reducedNode, gsapApi: reducedGsap, mediaQuery: reducedQuery })
  reduced.connect()
  assert.equal(reducedGsap.calls.at(-1).type, 'set')
  assert.equal(reducedGsap.calls.at(-1).vars.opacity, 1)

  reducedQuery.change(false)
  reduced.connect()
  const active = reducedGsap.calls.at(-1)
  assert.equal(active.type, 'fromTo')
  reducedQuery.change(true)
  assert.equal(active.killed, true)
  assert.equal(reducedGsap.calls.at(-1).vars.opacity, 1)
  reduced.dispose()

  const staticNode = connector()
  const noGsap = createReportConnectionMotion({ getConnector: () => staticNode, gsapApi: null, mediaQuery: fakeMedia(false) })
  noGsap.connect()
  assert.equal(staticNode.style.opacity, '1')
  assert.equal(staticNode.style.transform, 'scaleY(1)')
  noGsap.dispose()
})
