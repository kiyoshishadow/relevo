import test from 'node:test'
import assert from 'node:assert/strict'
import { caseFlowMarkup } from '../components/case-flow.js'

test('marks only the current case status as active and recorded transitions as complete', () => {
  const html = caseFlowMarkup('repairing', [
    { to_status: 'received', created_at: '2026-10-20T10:00:00Z', note: 'Ingreso' },
    { to_status: 'diagnosing', created_at: '2026-10-20T11:00:00Z', note: 'Revisión' },
    { to_status: 'repairing', created_at: '2026-10-21T09:00:00Z', note: 'Inicio' },
  ])

  assert.equal((html.match(/aria-current="step"/g) || []).length, 1)
  assert.match(html, /En reparación/)
  assert.match(html, /2026/)
  assert.doesNotMatch(html, /Esperando aprobación|Esperando pago|Listo para entrega/)
})

test('shows a terminal cancellation as the current state without implying delivery', () => {
  const html = caseFlowMarkup('cancelled', [
    { to_status: 'received', created_at: '2026-10-20T10:00:00Z' },
    { to_status: 'cancelled', created_at: '2026-10-20T11:00:00Z', note: 'Solicitud del cliente' },
  ])

  assert.equal((html.match(/aria-current="step"/g) || []).length, 1)
  assert.match(html, /Cancelado/)
  assert.doesNotMatch(html, /Entregado/)
})

test('shows delivered as terminal current state', () => {
  const html = caseFlowMarkup('delivered', [
    { to_status: 'received', created_at: '2026-10-20T10:00:00Z' },
    { to_status: 'ready', created_at: '2026-10-21T10:00:00Z' },
    { to_status: 'delivered', created_at: '2026-10-22T10:00:00Z' },
  ])

  assert.equal((html.match(/aria-current="step"/g) || []).length, 1)
  assert.match(html, /Entregado/)
  assert.match(html, /Estado actual/)
})

test('does not fabricate past steps or dates when the history is absent', () => {
  const html = caseFlowMarkup('awaiting_payment', [])

  assert.equal((html.match(/aria-current="step"/g) || []).length, 1)
  assert.match(html, /Esperando pago/)
  assert.match(html, /No hay movimientos reconocibles en el historial/)
  assert.doesNotMatch(html, /Recibido|En diagnóstico|<time/)
})

test('shows an unmatched current state without inventing its timestamp', () => {
  const html = caseFlowMarkup('repairing', [
    { to_status: 'received', created_at: '2026-10-20T10:00:00Z' },
    { to_status: 'diagnosing', created_at: '2026-10-20T11:00:00Z' },
  ])

  assert.equal((html.match(/aria-current="step"/g) || []).length, 1)
  assert.match(html, /no coincide con el último movimiento/)
  assert.match(html, /no confirma la fecha/)
  assert.equal((html.match(/<time/g) || []).length, 2)
})
