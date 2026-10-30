import test from 'node:test'
import assert from 'node:assert/strict'
import { buildUserPayload } from '../user-form.js'

test('user payload normalizes text and preserves active state as a boolean', () => {
  assert.deepEqual(buildUserPayload({
    email: '  PERSONA@EXAMPLE.COM ',
    full_name: ' Ana Pérez ',
    role: 'admin',
    active: 'false',
  }), {
    email: 'PERSONA@EXAMPLE.COM',
    full_name: 'Ana Pérez',
    role: 'admin',
    active: false,
  })
})

test('blank optional password is omitted; a supplied password is sent unchanged', () => {
  const base = { email: 'a@example.com', full_name: 'Ana', role: 'technician' }
  assert.equal(Object.hasOwn(buildUserPayload({ ...base, password: '' }), 'password'), false)
  assert.equal(buildUserPayload({ ...base, password: '  ten chars  ' }).password, '  ten chars  ')
})
