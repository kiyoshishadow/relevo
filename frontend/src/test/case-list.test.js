import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format:'module', source:'', shortCircuit:true }
  return nextLoad(url, context)
} })
const { caseListCounts, caseDocketMarkup } = await import('../views/cases.js')
styles.deregister()

test('case strip counts only visible records and does not invent progress for unknown states', () => {
  const counts = caseListCounts([{ status:'received' }, { status:'repairing' }, { status:'repairing' }, { status:'future-state' }])
  assert.equal(counts.get('received'), 1)
  assert.equal(counts.get('repairing'), 2)
  assert.equal(counts.get('ready'), 0)
  assert.equal(counts.has('future-state'), false)
  assert.equal([...caseListCounts().values()].reduce((sum, count) => sum + count, 0), 0)
})

test('docket preserves reported values, safe detail navigation and escaped user text', () => {
  const html = caseDocketMarkup([{ id:'one/two', case_number:'<img src=x onerror=alert(1)>', client_name:'A & B <script>bad</script>', terminal_summary:'Pixel 8', status:'diagnosing', updated_at:'2026-10-28T13:30:00Z' }])
  assert.ok(html.includes('href="#/cases/one%2Ftwo"'))
  assert.ok(html.includes('A &amp; B &lt;script&gt;bad&lt;/script&gt;'))
  assert.doesNotMatch(html, /<img|<script/)
  assert.match(html, /Pixel 8/)
  assert.match(html, /En diagnóstico/)
  assert.match(html, /datetime="2026-10-28T13:30:00Z"/)
})

test('docket keeps unknown status visible and does not manufacture a date or device', () => {
  const html = caseDocketMarkup([{ id:1, case_number:'R-1', status:'future-state', updated_at:'invalid' }])
  assert.match(html, /future-state/)
  assert.match(html, /Equipo sin detalle/)
  assert.match(html, /Cliente sin detalle/)
  assert.doesNotMatch(html, /datetime=/)
  assert.ok(html.includes('<time>—</time>'))
  assert.equal(caseDocketMarkup([]), '')
})
