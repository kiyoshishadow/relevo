import test from 'node:test'
import assert from 'node:assert/strict'
import { fmtMoney } from '../util.js'
import {
  casePaymentSummaryMarkup,
  hasConfirmedZeroBalance,
  shouldShowPaymentForm,
} from '../case-payment-summary.js'

test('muestra los importes que entrega el servidor en un pago parcial y mantiene el formulario', () => {
  const html = casePaymentSummaryMarkup('15.50', '34.50')
  assert.ok(html.includes(`data-paid-total>${fmtMoney('15.50')}</dd>`))
  assert.ok(html.includes(`data-payment-balance>${fmtMoney('34.50')}</dd>`))
  assert.equal(shouldShowPaymentForm({ mayRegisterPayment: true, balance: '34.50' }), true)
})

test('saldo confirmado cero se muestra y oculta el formulario de pago', () => {
  const html = casePaymentSummaryMarkup('50.00', '0.00')
  assert.ok(html.includes(`data-paid-total>${fmtMoney('50.00')}</dd>`))
  assert.ok(html.includes(`data-payment-balance>${fmtMoney('0.00')}</dd>`))
  assert.equal(hasConfirmedZeroBalance('0.00'), true)
  assert.equal(shouldShowPaymentForm({ mayRegisterPayment: true, balance: '0.00' }), false)
})

test('saldo o total ausente se informa sin inventar cero y mantiene el formulario elegible', () => {
  const html = casePaymentSummaryMarkup(undefined, null)
  assert.match(html, /data-paid-total>No disponible/)
  assert.match(html, /data-payment-balance>No disponible/)
  assert.equal(hasConfirmedZeroBalance(undefined), false)
  assert.equal(shouldShowPaymentForm({ mayRegisterPayment: true, balance: undefined }), true)
})

test('un saldo inválido no se interpreta como cero ni se inserta como HTML', () => {
  const html = casePaymentSummaryMarkup('<img src=x>', 'desconocido')
  assert.match(html, /data-paid-total>No disponible/)
  assert.match(html, /data-payment-balance>No disponible/)
  assert.doesNotMatch(html, /<img/)
  assert.equal(shouldShowPaymentForm({ mayRegisterPayment: true, balance: 'desconocido' }), true)
  assert.equal(shouldShowPaymentForm({ mayRegisterPayment: false, balance: '25.00' }), false)
})
