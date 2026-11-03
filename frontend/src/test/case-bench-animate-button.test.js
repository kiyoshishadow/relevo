import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const { wireBenchAnimate } = await import('../views/cases.js')
styles.deregister()

function fakeMatchMedia(initialMatches) {
  const listeners = new Set()
  const media = {
    matches: initialMatches,
    addEventListener: (type, fn) => { if (type === 'change') listeners.add(fn) },
    removeEventListener: (type, fn) => { if (type === 'change') listeners.delete(fn) },
    dispatchChange() { for (const fn of [...listeners]) fn({ matches: media.matches }) },
    listenerCount: () => listeners.size,
  }
  return media
}

// Control ligero: permite comprobar copy, listeners y acceso por teclado/tacto.
function fixture({ reducedInitial = false } = {}) {
  const media = fakeMatchMedia(reducedInitial)
  const listeners = new Map()
  const button = {
    disabled: false,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: type => listeners.delete(type),
    click: () => listeners.get('click')?.(),
    focus: () => listeners.get('focus')?.(),
    listenerCount: () => listeners.size,
  }
  const hint = { textContent: '' }
  const bench = { isConnected: true, querySelector: selector => (
    selector === '[data-bench-animate]' ? button :
    selector === '[data-bench-animate-hint]' ? hint : null) }
  const main = { isConnected: true, querySelector: selector => (
    selector === '[data-case-bench]' ? bench : null) }
  return { media, button, hint, main }
}

test('con movimiento reducido el teléfono sigue siendo accesible y explica la escena estática', () => {
  const { media, main, button, hint } = fixture({ reducedInitial: true })
  wireBenchAnimate(main, { matchMedia: name => assert.equal(name, '(prefers-reduced-motion: reduce)') || media })

  assert.equal(button.disabled, false)
  assert.match(hint.textContent, /Toca el teléfono/)
  assert.match(hint.textContent, /pausada por la preferencia/)
})

test('sin movimiento reducido la ilustración invita a tocarla', () => {
  const { media, main, button, hint } = fixture()
  wireBenchAnimate(main, { matchMedia: () => media })

  assert.equal(button.disabled, false)
  assert.match(hint.textContent, /Toca el teléfono para ver cómo se abren sus capas/)
})

test('el cambio dinámico de preferencia actualiza el mando sin recablear', () => {
  const { media, main, button, hint } = fixture()
  wireBenchAnimate(main, { matchMedia: () => media })

  media.matches = true
  media.dispatchChange()
  assert.equal(button.disabled, false)
  assert.match(hint.textContent, /pausada por la preferencia/)

  media.matches = false
  media.dispatchChange()
  assert.equal(button.disabled, false)
  assert.match(hint.textContent, /Toca el teléfono/)
  assert.equal(button.listenerCount(), 2, 'conserva foco y clic del control ilustrado')
})

test('repetir el cableado retira el oyente de la preferencia anterior', () => {
  const { media, main, button, hint } = fixture()
  wireBenchAnimate(main, { matchMedia: () => media })

  assert.equal(media.listenerCount(), 1)
  wireBenchAnimate(main, { matchMedia: () => media })
  assert.equal(media.listenerCount(), 1, 'no acumula oyentes al actualizar el banco')
})

// El registro de apertura viva vive en benchOpenAnimations (clavado al main
// dentro del módulo), así que esta prueba pasa por el flujo real: el clic del
// botón arranca el vuelo con GSAP de verdad sobre piezas planas y un
// window mínimo para que isReduced consulte sin entorno de navegador.
function animationFixture({ reducedInitial = false } = {}) {
  const previousWindow = globalThis.window
  globalThis.window = { matchMedia: () => ({ matches: false }) }
  const media = fakeMatchMedia(reducedInitial)
  const clicks = []
  const classes = new Set()
  const button = {
    disabled: false,
    addEventListener: (type, fn) => { if (type === 'click') clicks.push(fn) },
    click() { for (const fn of [...clicks]) fn() },
  }
  const hint = { textContent: '' }
  const parts = {
    '.case-bench__screen': { z: 70, y: 10 },
    '.case-bench__board': { z: 42, y: 0 },
    '.case-bench__shell': { z: -18, y: 0 },
  }
  const bench = {
    isConnected: true,
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    },
    querySelector: selector => (
      selector === '[data-bench-animate]' ? button :
      selector === '[data-bench-animate-hint]' ? hint :
      parts[selector] || null),
  }
  const main = { isConnected: true, querySelector: selector => (
    selector === '[data-case-bench]' ? bench : null) }
  return {
    restoreWindow() {
      if (previousWindow === undefined) delete globalThis.window
      else globalThis.window = previousWindow
    },
    media, button, hint, parts, bench, main,
  }
}

test('cambiar a movimiento reducido con apertura en vuelo la cancela y limpia el banco', async () => {
  const fix = animationFixture()
  try {
    wireBenchAnimate(fix.main, { matchMedia: () => fix.media })

    // Vuelo en curso: clic real del botón registra la apertura bajo este main.
    fix.button.click()
    assert.ok(fix.bench.classList.contains('is-brief-open'), 'precondición: la apertura quedó en vuelo')

    fix.media.matches = true
    fix.media.dispatchChange()
    assert.equal(fix.button.disabled, false)
    assert.match(fix.hint.textContent, /pausada por la preferencia/)
    assert.ok(!fix.bench.classList.contains('is-brief-open'),
      'stop() retiró la clase del vuelo, no se espera al onComplete')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(fix.parts['.case-bench__screen'].z, 70,
      'el vuelo quedó cancelado: la capa nunca alcanzó su apertura')
    assert.equal(fix.parts['.case-bench__screen'].y, 10)
    assert.equal(fix.parts['.case-bench__board'].z, 42)
    assert.equal(fix.parts['.case-bench__shell'].z, -18)
  } finally {
    fix.restoreWindow()
  }
})

test('con movimiento reducido inicial no falla aunque no exista apertura previa', () => {
  const fix = animationFixture({ reducedInitial: true })
  try {
    wireBenchAnimate(fix.main, { matchMedia: () => fix.media })

    assert.equal(fix.button.disabled, false)
    assert.ok(!fix.bench.classList.contains('is-brief-open'))
    assert.match(fix.hint.textContent, /pausada por la preferencia/)
  } finally {
    fix.restoreWindow()
  }
})

test('en vuelo y regresando a no-preferencia el botón sigue disponible sin restos', () => {
  const fix = animationFixture()
  try {
    wireBenchAnimate(fix.main, { matchMedia: () => fix.media })
    fix.button.click()
    fix.media.matches = true
    fix.media.dispatchChange()
    fix.media.matches = false
    fix.media.dispatchChange()

    assert.equal(fix.button.disabled, false)
    assert.match(fix.hint.textContent, /Toca el teléfono/)
    assert.ok(!fix.bench.classList.contains('is-brief-open'),
      'la clase del vuelo cancelado no vuelve a aparecer')
    assert.equal(fix.parts['.case-bench__screen'].z, 70)
  } finally {
    fix.restoreWindow()
  }
})
