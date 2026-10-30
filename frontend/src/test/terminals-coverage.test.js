import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { loadAllPages } from '../paged-data.js'

// Node does not render styles. Import the actual view's data rule while leaving
// its browser-only lifecycle dormant, rather than duplicate that rule here.
const styles = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/styles/terminals-motion.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  },
})
// router.js registers a browser-only focus listener at import time; stubbing the
// minimum document surface keeps the equipos view importable under node --test.
globalThis.document = { addEventListener() {}, removeEventListener() {} }
const { compatibleTerminalCoverages } = await import('../views/terminals.js')
styles.deregister()

test('terminal plans include active global and matching brand coverage only', () => {
  const plans = [
    { id: 'global', active: true, brand: null },
    { id: 'apple', active: true, brand: ' Apple ' },
    { id: 'samsung', active: true, brand: 'Samsung' },
    { id: 'inactive-global', active: false, brand: null },
    { id: 'inactive-apple', active: false, brand: 'Apple' },
  ]
  assert.deepEqual(compatibleTerminalCoverages(plans, ' apple ').map(plan => plan.id), ['global', 'apple'])
  assert.deepEqual(compatibleTerminalCoverages(plans, 'SAMSUNG').map(plan => plan.id), ['global', 'samsung'])
  assert.deepEqual(compatibleTerminalCoverages(plans, '').map(plan => plan.id), ['global'])
  assert.deepEqual(compatibleTerminalCoverages(plans, 'Unknown').map(plan => plan.id), ['global'])
})

test('a matching active plan beyond the first coverage page remains selectable', async () => {
  const pages = []
  const firstPage = Array.from({ length: 100 }, (_, id) => ({ id, active: true, brand: 'Samsung' }))
  const all = await loadAllPages(async path => {
    const page = Number(new URL(path, 'http://localhost').searchParams.get('page'))
    pages.push(page)
    return { data: page === 1 ? firstPage : [{ id: 100, active: true, brand: 'Apple' }], meta: { total: 101 } }
  }, '/coverages')
  assert.deepEqual(pages, [1, 2])
  assert.deepEqual(compatibleTerminalCoverages(all, 'Apple').map(plan => plan.id), [100])
})
