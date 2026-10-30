import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const { dashboardActivityHtml, dashboardRendererLabel, dashboardRendererBadgeHtml } = await import('../views/dashboard.js')
styles.deregister()

test('activity separates five service states from four inventory links without changing scene anchors or focus order', () => {
  const html = dashboardActivityHtml({ counts: { received: 1, awaiting_approval: 2, awaiting_payment: 3, repairing: 4, ready: 5, total_cases: 9 }, loans_out: 6, totals: { clients: 7, terminals: 8 } })
  const links = [...html.matchAll(/<a class="stat"[^>]*data-stat-key="([^"]+)"[^>]*href="([^"]+)"[^>]*>\s*<b>([^<]+)<\/b>/g)]
  const expected = [
    ['received', '#/cases?status=received'], ['awaiting_approval', '#/cases?status=awaiting_approval'],
    ['awaiting_payment', '#/cases?status=awaiting_payment'], ['repairing', '#/cases?status=repairing'],
    ['ready', '#/cases?status=ready'], ['loans_out', '#/loans'], ['clients', '#/clients'],
    ['terminals', '#/terminals'], ['total_cases', '#/cases'],
  ]
  assert.deepEqual(links.map(link => [link[1], link[2]]), expected)
  assert.deepEqual(links.map(link => Number(link[3])), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  for (const [key] of expected) {
    assert.equal((html.match(new RegExp(`class="stat-model" data-stat-key="${key}"`, 'g')) || []).length, 1)
  }
  const groups = [...html.matchAll(/<section[^>]*aria-labelledby="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)]
  assert.equal(groups.length, 2)
  assert.equal((groups[0][2].match(/<a class="stat"/g) || []).length, 5)
  assert.equal((groups[1][2].match(/<a class="stat"/g) || []).length, 4)
  assert.match(html, /Casos distintos en cada estado/)
  assert.doesNotMatch(html, /tabindex|aria-valuenow|progressbar/)
})

test('activity preserves reported zeroes, missing counts and the existing total-case fallback', () => {
  const html = dashboardActivityHtml({ counts: { received: 0, ready: '' }, totals: { cases: 18 } })
  assert.match(html, /data-stat-key="received"[^>]*>\s*<b>0<\/b>/)
  assert.match(html, /data-stat-key="ready"[^>]*>\s*<b>—<\/b>/)
  assert.match(html, /data-stat-key="total_cases"[^>]*>\s*<b>18<\/b>/)
  assert.match(dashboardActivityHtml(), /data-stat-key="clients"[^>]*>\s*<b>—<\/b>/)
})

test('renderer badge reports the backend actually available, including reduced-motion and unknown states', () => {
  assert.equal(dashboardRendererLabel('webgpu'), 'WEBGPU · 3D')
  assert.equal(dashboardRendererLabel('webgl2'), 'WEBGL · 3D')
  assert.equal(dashboardRendererLabel('fallback'), 'SVG · 2D')
  assert.equal(dashboardRendererLabel('reduced-motion-svg'), 'SVG · MOVIMIENTO REDUCIDO')
  assert.equal(dashboardRendererLabel('loading'), 'ESCENA · CARGANDO')
  assert.equal(dashboardRendererLabel('unknown-backend'), 'RENDERER · NO DISPONIBLE')
  assert.match(dashboardRendererBadgeHtml(), /data-renderer-backend="loading"[^>]*aria-live="polite"[^>]*>ESCENA · CARGANDO/)
  assert.doesNotMatch(dashboardRendererBadgeHtml(), /WEBGPU/)
  assert.match(dashboardRendererBadgeHtml('unknown-backend'), /data-renderer-backend="unknown"[^>]*>RENDERER · NO DISPONIBLE/)
})
