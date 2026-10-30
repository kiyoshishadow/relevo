import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'

// Node does not render styles. Import the actual view's confirmation rule while
// leaving its browser-only lifecycle dormant, rather than duplicate it here.
const styles = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/styles/terminals-motion.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  },
})
// The view chain includes router.js, which registers a browser focus listener
// at import time for the real app; tests stub the minimum so the shared view
// stays importable without shipping that listener duplication into a DOM.
globalThis.document = { addEventListener() {}, removeEventListener() {} }
const { terminalSavedFeedback } = await import('../views/terminals.js')
styles.deregister()

const viewSource = await readFile(new URL('../views/terminals.js', import.meta.url), 'utf8')

test('the purchase_date column is labeled Compra, never Ingreso', () => {
  assert.match(viewSource, /<th>Compra<\/th>/)
  assert.doesNotMatch(viewSource, /<th>Ingreso<\/th>/)
  assert.match(viewSource, /label for="terminal-purchase-date">Fecha de compra/)
})

test('two numeric IMEI fields are offered without requiring a comma key', () => {
  for (const field of ['imei_1', 'imei_2']) {
    const match = viewSource.match(new RegExp(`<input id="terminal-${field.replace('_', '-')}" ([^>]+)>`))
    assert.ok(match, `IMEI field ${field} exists`)
    assert.match(match[1], new RegExp(`name="${field}"`))
    assert.match(match[1], /inputmode="numeric"/)
    assert.match(match[1], /autocomplete="off"/)
  }
  assert.match(viewSource, /label for="terminal-imei-1">IMEI 1/)
  assert.match(viewSource, /label for="terminal-imei-2">IMEI 2/)
  assert.doesNotMatch(viewSource, /separados por coma/)
  // Any leftover onKeyDown-style aggregation must route through the validated
  // combine helper, keeping the backend contract (`imeis` array) unchanged.
  assert.match(viewSource, /imeis: combineTerminalImeis\(f\.get\('imei_1'\), f\.get\('imei_2'\)\)\.values/)
  assert.doesNotMatch(viewSource, /f\.get\('imeis'\)/)
})

test('a settled registration stays confirmed even if the list reload fails', () => {
  assert.equal(terminalSavedFeedback(true).status, 'El equipo se registró correctamente.')
  assert.equal(terminalSavedFeedback(true).notice, '')
  const stale = terminalSavedFeedback(false)
  assert.equal(stale.status, 'El equipo se registró correctamente.')
  assert.match(stale.notice, /registrado correctamente/)
  assert.match(stale.notice, /data-retry-list-reload/)
  assert.match(stale.notice, /Reintentar la lectura/)
  // The stale notice must never claim the save itself failed.
  assert.doesNotMatch(stale.notice, /no se registró|no se pudo registrar/)
})

test('the save flow confirms first and only re-reads, never re-posts', () => {
  // Confirmation is written before the reload is attempted, and the retry
  // handler calls refreshAfterSave (a read), not the POST call.
  assert.match(viewSource, /\[data-save-status\]'\)\.textContent = terminalSavedFeedback\(false\)\.status[\s\S]*?await refreshAfterSave\(\)/)
  const retry = viewSource.match(/slot\.querySelector\('\[data-retry-list-reload\]'\)[\s\S]{0,200}/)
  assert.ok(retry)
  assert.match(retry[0], /refreshAfterSave\(\)/)
  assert.doesNotMatch(retry[0], /post\(/)
})
