import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { fmtDate } from '../util.js'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const { recentCasesHtml } = await import('../views/dashboard.js')
styles.deregister()

test('recent cases keep complete server values and one encoded detail link per record', () => {
  const created = '2026-10-28T18:45:00Z'
  const terminal = 'Samsung Galaxy S24 Ultra Enterprise Edition 512 GB'
  const html = recentCasesHtml([{ id: 'case/one', case_number: 'RV-2026-00128', client_name: 'María Hernández López', terminal: { brand: 'Samsung', model: terminal.slice(8) }, status: 'awaiting_approval', created_at: created }])
  assert.ok(html.includes(terminal))
  assert.ok(html.includes('María Hernández López'))
  assert.ok(html.includes(fmtDate(created)))
  assert.ok(html.includes('Esperando aprobación'))
  assert.equal((html.match(/href="#\/cases\/case%2Fone"/g) || []).length, 1)
  assert.match(html, /aria-label="Abrir caso RV-2026-00128"/)
  assert.equal((html.match(/scope="col"/g) || []).length, 5)
  assert.equal((html.match(/role="cell"/g) || []).length, 5)
})

test('recent cases escape user text and retain unknown states and missing data honestly', () => {
  const html = recentCasesHtml([{ id: 4, case_number: '<img src=x>', client_name: 'A & B <script>bad</script>', terminal: { brand: '<svg onload=bad>' }, status: 'future-state', created_at: 'invalid' }])
  assert.doesNotMatch(html, /<img|<script|<svg/)
  assert.ok(html.includes('&lt;img src=x&gt;'))
  assert.ok(html.includes('A &amp; B &lt;script&gt;bad&lt;/script&gt;'))
  assert.ok(html.includes('&lt;svg onload=bad&gt;'))
  assert.ok(html.includes('future-state'))
  assert.match(html, /Fecha de recepción<\/span><span>—<\/span>/)
  const missing = recentCasesHtml([{ id: 5, case_number: 'R5' }])
  assert.match(missing, /Terminal<\/span><span>—<\/span>/)
  assert.match(missing, /Cliente<\/span><span>—<\/span>/)
})

test('empty recent cases expose guidance without inventing records', () => {
  for (const records of [undefined, null, []]) {
    const html = recentCasesHtml(records)
    assert.match(html, /Aún no hay casos/)
    assert.doesNotMatch(html, /data-id=/)
    assert.match(html, /href="#\/cases\/new"/)
  }
})
