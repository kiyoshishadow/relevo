import test from 'node:test'
import assert from 'node:assert/strict'
import { canIssueQuote, canManageQuote, parseQuoteDecision } from '../quote-controls.js'

test('solo recepción y administración pueden gestionar cotizaciones', () => {
  assert.equal(canManageQuote('admin'), true)
  assert.equal(canManageQuote('reception'), true)
  assert.equal(canManageQuote('technician'), false)
  assert.equal(canManageQuote(undefined), false)
})

test('nueva versión solo se permite en estados compatibles y sin pagos', () => {
  for (const status of ['diagnosing', 'awaiting_approval', 'awaiting_payment']) {
    assert.equal(canIssueQuote({ role: 'reception', status, payments: [] }), true)
  }
  assert.equal(canIssueQuote({ role: 'admin', status: 'awaiting_payment', payments: [{}] }), false)
  assert.equal(canIssueQuote({ role: 'technician', status: 'diagnosing', payments: [] }), false)
  assert.equal(canIssueQuote({ role: 'admin', status: 'repairing', payments: [] }), false)
})

test('decisión reconoce únicamente los valores de submit explícitos', () => {
  assert.equal(parseQuoteDecision('true'), true)
  assert.equal(parseQuoteDecision('false'), false)
  for (const value of [undefined, '', 'yes', 'True', null]) assert.equal(parseQuoteDecision(value), null)
})
