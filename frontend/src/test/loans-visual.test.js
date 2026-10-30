import test from 'node:test'
import assert from 'node:assert/strict'
import { fleetDock } from '../loan-devices.js'

test('fleet summary counts only returned devices and escapes device names', () => {
  const html = fleetDock([
    { brand: '<img src=x>', model: 'Uno', status: 'available', asset_tag: 'SECRET-IMEI' },
    { brand: 'Marca', model: 'Dos', status: 'loaned' },
    { brand: 'Marca', model: 'Tres', status: 'mantenimiento' },
  ])
  assert.match(html, /<strong>1<\/strong><span>Disponibles/)
  assert.match(html, /<strong>1<\/strong><span>Entregados/)
  assert.match(html, /<strong>0<\/strong><span>Retirados/)
  assert.match(html, /<strong>1<\/strong><span>Otros estados/)
  assert.match(html, /&lt;img src=x&gt;/)
  assert.doesNotMatch(html, /<img|SECRET-IMEI/)
  assert.match(html, /esta página/)
})

test('empty page produces a truthful empty state', () => {
  const html = fleetDock([])
  assert.match(html, /SIN EQUIPOS EN ESTA PÁGINA/)
  assert.match(html, /00 \/ EQUIPOS/)
})

test('known models use their camera family and unknown models stay illustrative', () => {
  const html = fleetDock([
    { brand: 'Google', model: 'Pixel 8', status: 'available' },
    { brand: 'Marca', model: 'Modelo inventariado', status: 'available' },
  ])

  assert.match(html, /fleet-device--pixel-bar-dual/)
  assert.match(html, /fleet-device--illustrative/)
})
