import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const { replacementPolicyLabel } = await import('../views/coverages.js')
styles.deregister()

test('policy labels match API semantics: continue keeps existing coverage and new creates one with same plan and term', () => {
  assert.equal(replacementPolicyLabel('continue'), 'Continuar cobertura existente')
  assert.equal(replacementPolicyLabel('new'), 'Nueva cobertura con mismo plan y plazo')
})

test('unknown, empty or missing policy values get no invented label', () => {
  assert.equal(replacementPolicyLabel('legacy'), null)
  assert.equal(replacementPolicyLabel(''), null)
  assert.equal(replacementPolicyLabel(undefined), null)
  assert.equal(replacementPolicyLabel(null), null)
})
