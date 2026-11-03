import test from 'node:test'
import assert from 'node:assert/strict'
import { bindIntakeReceiptPrint, intakeReceiptMarkup } from '../intake-receipt.js'

test('receipt gives the client case details and both credentials without exposing device identifiers', () => {
  const html = intakeReceiptMarkup({
    caseNumber: 'RV-2026-000009', trackingToken: 'tracking-key-0123456789012345',
    clientName: 'Ana Salgado', terminal: { brand: 'Samsung', model: 'Galaxy A15', initial_condition: 'Marcas leves', accessories: 'Cargador' },
    reportedProblem: 'Se apaga con poca batería', receivedAt: '2026-11-02T18:00:00.000Z',
  })
  assert.match(html, /Recepción del equipo/)
  assert.match(html, /RV-2026-000009/)
  assert.match(html, /tracking-key-0123456789012345/)
  assert.match(html, /Samsung Galaxy A15/)
  assert.match(html, /Se apaga con poca batería/)
  assert.match(html, /Marcas leves/)
  assert.match(html, /Cargador/)
  assert.match(html, /no necesita crear una cuenta/)
  assert.doesNotMatch(html, /IMEI|<script/)
})

test('receipt escapes supplied values and describes missing intake details honestly', () => {
  const html = intakeReceiptMarkup({ caseNumber: '<img src=x>', trackingToken: '<bad>', reportedProblem: '<script>x</script>' })
  assert.match(html, /&lt;img src=x&gt;/)
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>/)
  assert.equal((html.match(/No registrado/g) || []).length, 4)
})

test('print binding invokes print and removes its listener on leave', () => {
  const listeners = new Map()
  const button = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name) } }
  let calls = 0
  const dispose = bindIntakeReceiptPrint({ querySelector: () => button }, () => { calls += 1 })
  listeners.get('click')()
  assert.equal(calls, 1)
  dispose()
  assert.equal(listeners.size, 0)
})
