import test from 'node:test'
import assert from 'node:assert/strict'
import { session } from '../session.js'
import { workShell } from '../layout/work.js'

const priorLocation = globalThis.location
globalThis.location = { hash: '' }

function linksFor(role) {
  session.user = { role }
  return [...workShell('Prueba', '', '').matchAll(/<a class="rail-link" href="#([^\"]+)"/g)].map(match => match[1])
}

test('Reportes aparece para administración y recepción; Usuarios y Auditoría siguen solo para administración', () => {
  const admin = linksFor('admin')
  const reception = linksFor('reception')
  const technician = linksFor('technician')

  assert.ok(admin.includes('/reports'))
  assert.ok(reception.includes('/reports'))
  assert.ok(!technician.includes('/reports'))
  assert.ok(admin.includes('/users') && admin.includes('/audit'))
  assert.ok(!reception.includes('/users') && !reception.includes('/audit'))
  assert.ok(!technician.includes('/users') && !technician.includes('/audit'))
})

test.after(() => {
  session.user = null
  if (priorLocation === undefined) delete globalThis.location
  else globalThis.location = priorLocation
})
