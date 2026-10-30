import test from 'node:test'
import assert from 'node:assert/strict'
import { availableLoanDevices, loanDeviceOptionLabel } from '../loan-devices.js'

test('only devices whose service status is available can be offered for a loan', () => {
  const devices = [
    { id: 'a', status: 'available' },
    { id: 'b', status: 'loaned', active_loan: { case_id: 'case-1' } },
    { id: 'c', status: 'retired' },
    { id: 'd', active_loan: null },
  ]

  assert.deepEqual(availableLoanDevices(devices).map(device => device.id), ['a'])
  assert.deepEqual(availableLoanDevices(null), [])
})

test('loan choices identify the terminal and use the service asset tag', () => {
  assert.equal(
    loanDeviceOptionLabel({ brand: 'Nokia', model: 'G22', asset_tag: 'PREST-014', imei: 'ignored' }),
    'Nokia G22 · PREST-014',
  )
  assert.equal(loanDeviceOptionLabel({ asset_tag: 'PREST-015' }), 'Terminal · PREST-015')
})
