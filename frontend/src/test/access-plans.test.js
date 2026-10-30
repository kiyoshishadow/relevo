import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  },
})
const { userRosterSummary } = await import('../views/admin.js')
const { coverageListSummary } = await import('../views/coverages.js')
styles.deregister()

test('role summary counts active and inactive accounts without inventing users in an empty role', () => {
  const groups = userRosterSummary([
    { role: 'admin', active: true }, { role: 'admin', active: false },
    { role: 'technician', active: true },
  ])
  assert.deepEqual(groups.map(({ role, active, total }) => ({ role, active, total })), [
    { role: 'reception', active: 0, total: 0 },
    { role: 'technician', active: 1, total: 1 },
    { role: 'admin', active: 1, total: 2 },
  ])
})

test('coverage summary reports current list scope and distinguishes universal brand coverage', () => {
  assert.deepEqual(coverageListSummary([
    { active: true, brand: 'Apple' }, { active: false, brand: null },
    { active: true, brand: 'Samsung' }, { active: true, brand: '' },
  ]), { active: 3, global: 2, total: 4 })
  assert.deepEqual(coverageListSummary([]), { active: 0, global: 0, total: 0 })
})
