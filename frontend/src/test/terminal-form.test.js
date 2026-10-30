import test from 'node:test'
import assert from 'node:assert/strict'
import { localDateOnly, parseTerminalImeis, combineTerminalImeis, terminalPurchaseDateError } from '../terminal-form.js'

test('terminal IMEIs are optional, accept one or two valid values, and reject repeats or extras', () => {
  assert.deepEqual(parseTerminalImeis(''), { values: [], error: '' })
  assert.deepEqual(parseTerminalImeis('12345678901234'), { values: ['12345678901234'], error: '' })
  assert.deepEqual(parseTerminalImeis('12345678901234, 1234567890123456'), {
    values: ['12345678901234', '1234567890123456'], error: '',
  })
  assert.match(parseTerminalImeis('1234567890123').error, /14 y 16 dígitos/)
  assert.match(parseTerminalImeis('12345678901234,12345678901234').error, /no pueden repetirse/)
  assert.match(parseTerminalImeis('12345678901234,12345678901234,12345678901234').error, /máximo dos/)
})

test('two numeric IMEI fields combine into the same validated contract, without any comma', () => {
  assert.deepEqual(combineTerminalImeis(), { values: [], error: '' })
  assert.deepEqual(combineTerminalImeis('12345678901234', ''), { values: ['12345678901234'], error: '' })
  // Second-only capture: the SIM 2 field works even if SIM 1 was left empty.
  assert.deepEqual(combineTerminalImeis('', '1234567890123456'), { values: ['1234567890123456'], error: '' })
  assert.deepEqual(combineTerminalImeis(' 12345678901234 ', ' 1234567890123456 '), {
    values: ['12345678901234', '1234567890123456'], error: '',
  })
  assert.match(combineTerminalImeis('12345678901234', '12345678901234').error, /no pueden repetirse/)
  assert.match(combineTerminalImeis('123', '').error, /14 y 16 dígitos/)
  assert.match(combineTerminalImeis('12345678901234', '123').error, /14 y 16 dígitos/)
})

test('purchase date is required, calendar-valid, and no later than local today', () => {
  assert.equal(localDateOnly(new Date('2026-10-28T05:59:59.000Z')), '2026-10-27')
  assert.equal(localDateOnly(new Date('2026-10-28T06:00:00.000Z')), '2026-10-28')
  assert.equal(terminalPurchaseDateError('', '2026-10-28'), 'La fecha de compra es obligatoria.')
  assert.equal(terminalPurchaseDateError('2026-02-30', '2026-10-28'), 'Usa una fecha válida.')
  assert.equal(terminalPurchaseDateError('2026-10-29', '2026-10-28'), 'La fecha de compra no puede ser futura.')
  assert.equal(terminalPurchaseDateError('2026-10-28', '2026-10-28'), '')
})
