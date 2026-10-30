import test from 'node:test'
import assert from 'node:assert/strict'
import { casePaymentSummaryMarkup, completeCaseOperation } from '../case-payment-summary.js'

test('el sello solo aparece con el resumen del servidor tras completar un pago', async () => {
  const summaryMarkup = casePaymentSummaryMarkup('12.00', '8.00')
  assert.match(summaryMarkup, /^<div data-payment-summary><dl class="kv">[\s\S]*<\/dl><\/div>$/)
  assert.doesNotMatch(summaryMarkup, /case-payment-stamp/)
  assert.doesNotMatch(summaryMarkup.match(/<dl[\s\S]*?<\/dl>/)?.[0] || '', /<(?:div|span)/)
  assert.match(summaryMarkup, /data-paid-total>12/)
  assert.match(summaryMarkup, /data-payment-balance>8/)

  let posts = 0
  let reads = 0
  const first = await completeCaseOperation({
    operationType: 'payment',
    action: async () => { posts += 1 },
    refresh: async () => { reads += 1; throw new Error('GET no disponible') },
  })
  assert.equal(first.showPaymentReceipt, false)
  assert.equal(first.savedOperation.operationType, 'payment')

  const retry = await completeCaseOperation({
    savedOperation: first.savedOperation,
    operationType: 'other',
    action: async () => { posts += 1 },
    refresh: async operation => { reads += 1; assert.equal(operation.operationType, 'payment') },
  })
  assert.equal(retry.error, null)
  assert.equal(retry.savedOperation, null)
  assert.equal(retry.showPaymentReceipt, true)
  assert.equal(posts, 1)
  assert.equal(reads, 2)
})

test('POST fallido y operaciones ajenas a pagos nunca habilitan el sello', async () => {
  const failedPost = await completeCaseOperation({
    operationType: 'payment',
    action: async () => { throw new Error('POST rechazado') },
    refresh: async () => assert.fail('no debe hacer GET tras POST fallido'),
  })
  assert.equal(failedPost.showPaymentReceipt, false)
  assert.equal(failedPost.savedOperation, null)

  const otherOperation = await completeCaseOperation({
    operationType: 'transition',
    action: async () => {},
    refresh: async () => {},
  })
  assert.equal(otherOperation.showPaymentReceipt, false)
})
