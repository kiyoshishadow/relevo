import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const {
  canRegisterReplacement,
  caseReplacementPanelMarkup,
  replacementPolicyInfo,
  replacementSummaryMarkup,
  replacementTerminalChoices,
  replacementTerminalSelection,
  restoreReplacementTerminalDraft,
} = await import('../views/cases.js')
styles.deregister()

function coveredCase(overrides = {}) {
  return {
    id: 12,
    status: 'diagnosing',
    coverage_covered: true,
    client: { id: 8 },
    terminal: {
      id: 21,
      coverage: { id: 5, replacement_policy: 'new' },
    },
    replacement: null,
    ...overrides,
  }
}

test('replacement is available only to reception/admin on covered cases with a real policy and allowed state', () => {
  assert.equal(canRegisterReplacement(coveredCase(), 'reception'), true)
  assert.equal(canRegisterReplacement(coveredCase(), 'admin'), true)
  assert.equal(canRegisterReplacement(coveredCase(), 'technician'), false)
  assert.equal(canRegisterReplacement(coveredCase({ coverage_covered: false }), 'admin'), false)
  assert.equal(canRegisterReplacement(coveredCase({ terminal: { id: 21, coverage: null } }), 'admin'), false)
  assert.equal(canRegisterReplacement(coveredCase({ terminal: { id: 21, coverage: { id: 5, replacement_policy: 'legacy' } } }), 'admin'), false)
  assert.equal(canRegisterReplacement(coveredCase({ status: 'delivered' }), 'admin'), false)
  assert.equal(canRegisterReplacement(coveredCase({ status: 'ready' }), 'reception'), true)
  assert.equal(canRegisterReplacement(coveredCase({ status: 'repairing' }), 'reception'), true)
  assert.equal(canRegisterReplacement(coveredCase({ replacement: { id: 4 } }), 'admin'), false)
})

test('panel explains the stored policy and requires a deliberate terminal selection', () => {
  const html = caseReplacementPanelMarkup(coveredCase(), 'reception', '12')
  assert.match(html, /Nueva cobertura/)
  assert.match(html, /Se crea una cobertura nueva/)
  assert.match(html, /name="terminal_id" required disabled/)
  assert.match(html, /Cargando equipos del cliente/)
  assert.match(html, /Registrar reemplazo/)
  assert.equal(replacementPolicyInfo('continue').label, 'Continuar cobertura')
  assert.match(replacementPolicyInfo('continue').explanation, /continúa con la cobertura registrada/)
})

test('catalogue choices include only the active client and exclude the original terminal', () => {
  const devices = [
    { id: 21, client_id: 8, brand: 'Original' },
    { id: 22, client_id: 8, brand: 'Eligible' },
    { id: 23, client_id: 9, brand: 'Other client' },
  ]
  assert.deepEqual(replacementTerminalChoices(devices, 8, 21), [{ id: 22, client_id: 8, brand: 'Eligible' }])
  assert.deepEqual(replacementTerminalChoices(devices, null, 21), [])
})

test('replacement selection restores a draft after loading and never falls back when it is unavailable', () => {
  const choices = [{ id: 22 }, { id: 23 }]
  const select = { options: [{ value: '' }], disabled: true, value: '', dataset: {} }
  restoreReplacementTerminalDraft(select, '23')
  assert.equal(select.value, '')
  assert.equal(select.dataset.pendingReplacementDraft, '23')
  assert.equal(replacementTerminalSelection(choices, '23', ''), '23')
  assert.equal(replacementTerminalSelection(choices, '99', ''), '')
  assert.equal(replacementTerminalSelection(choices, undefined, '22'), '22')
})

test('a registered replacement remains visible in closed cases with the actual device and policy', () => {
  const html = caseReplacementPanelMarkup({
    status: 'delivered',
    replacement: { policy: 'continue', terminal: { brand: 'Google', model: 'Pixel 8' } },
  }, 'technician', '12')
  assert.match(html, /Google Pixel 8/)
  assert.match(html, /Continuar cobertura/)
  assert.match(html, /terminal elegido continúa con la cobertura registrada/)
  assert.doesNotMatch(html, /<form/)
})

test('replacement summary escapes server device text', () => {
  const html = replacementSummaryMarkup({
    policy: 'new',
    terminal: { brand: '<img src=x>', model: 'A & B' },
  })
  assert.match(html, /&lt;img src=x&gt; A &amp; B/)
  assert.doesNotMatch(html, /<img/)
})
