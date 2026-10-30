import test from 'node:test'
import assert from 'node:assert/strict'
import { describeAssembly, readAssemblyState } from '../components/phone.js'
import { getDragRotation, getInspectionPoint } from '../components/phone3d.js'

function control() {
  const attrs = new Map()
  return {
    textContent: '',
    dataset: {},
    setAttribute: (key, value) => attrs.set(key, value),
    getAttribute: key => attrs.get(key),
  }
}

test('el mismo estado ensamblado se refleja en el control y el anuncio', () => {
  const button = control(), status = control()
  describeAssembly(button, status, true)
  assert.equal(button.getAttribute('aria-pressed'), 'true')
  assert.equal(button.textContent, 'Explorar las capas')
  assert.match(status.textContent, /Teléfono ensamblado/)
})

test('el mismo estado explorado se refleja en el control y el anuncio', () => {
  const button = control(), status = control()
  describeAssembly(button, status, false)
  assert.equal(button.getAttribute('aria-pressed'), 'false')
  assert.equal(button.textContent, 'Armar el teléfono')
  assert.match(status.textContent, /componentes internos separados/)
})

test('la inicialización diferida lee el último estado elegido en el SVG', async () => {
  let assembled = true
  const init = new Promise(resolve => setTimeout(() => resolve(readAssemblyState(true, () => assembled)), 10))
  assembled = false
  assert.equal(await init, false)
})

test('la inspección por arrastre inclina el teléfono en proporción al gesto', () => {
  const rotation = getDragRotation({ deltaX: 100, deltaY: -50, width: 500, height: 500 })
  assert.ok(rotation.y > .055)
  assert.ok(rotation.x < -.05)
})

test('la inspección por arrastre limita la inclinación aunque el puntero salga del canvas', () => {
  const rotation = getDragRotation({ deltaX: 5000, deltaY: -5000, width: 1, height: 1 })
  assert.equal(rotation.x, -.05 - .24)
  assert.equal(rotation.y, .055 + .34)
})

test('un toque sobre la escena se convierte a coordenadas de selección 3D', () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 }
  assert.deepEqual(getInspectionPoint({ clientX: 300, clientY: 150, startX: 298, startY: 150 }, rect), { x: 0, y: 0 })
  assert.deepEqual(getInspectionPoint({ clientX: 100, clientY: 50, startX: 100, startY: 50 }, rect), { x: -1, y: 1 })
})

test('arrastrar, salir del canvas o cancelar nunca selecciona una pieza accidentalmente', () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 }
  assert.equal(getInspectionPoint({ clientX: 300, clientY: 150, startX: 290, startY: 150 }, rect), null)
  assert.equal(getInspectionPoint({ clientX: 300, clientY: 150, startX: 300, startY: 150, moved: true }, rect), null)
  assert.equal(getInspectionPoint({ clientX: 95, clientY: 50, startX: 95, startY: 50 }, rect), null)
  assert.equal(getInspectionPoint({ clientX: 100, clientY: 50, startX: 100, startY: 50 }, { ...rect, width: 0 }), null)
})
