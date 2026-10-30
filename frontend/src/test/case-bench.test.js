import test from 'node:test'
import assert from 'node:assert/strict'
import { caseBenchModel, caseBenchMarkup } from '../components/case-flow.js'

test('repair bench uses current API status even when history ends at another state', () => {
  const cs = { status: 'awaiting_payment', history: [{ to_status: 'repairing' }], terminal: { brand: 'Google', model: 'Pixel 8' } }
  assert.deepEqual(caseBenchModel(cs), { mode: 'hold', caption: 'Pago de la reparación', panel: 'payment', label: 'Esperando pago', device: 'Google Pixel 8' })
  const html = caseBenchMarkup(cs)
  assert.match(html, /data-mode="hold"/)
  assert.match(html, /data-case-jump="payment"/)
  assert.doesNotMatch(html, /En reparación|%|Etapa completada/)
})

test('terminal and unknown states do not invent an actionable next repair stage', () => {
  assert.equal(caseBenchModel({ status: 'cancelled' }).panel, null)
  assert.equal(caseBenchModel({ status: 'future_status' }).mode, 'unknown')
  const html = caseBenchMarkup({ status: 'future_status', terminal: { model: '<script>bad</script>' } })
  assert.doesNotMatch(html, /data-case-jump|<script>|Listo para entrega/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /Última actualización<\/dt><dd>—/)
})
