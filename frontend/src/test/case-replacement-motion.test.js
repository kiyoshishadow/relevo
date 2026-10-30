import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const { createReplacementExchangeMotion, caseReplacementPanelMarkup } = await import('../views/cases.js')
styles.deregister()
const motionCss = await readFile(new URL('../styles/case-detail-motion.css', import.meta.url), 'utf8')

function fixture({ reduced = false } = {}) {
  const listeners = new Set()
  const media = {
    matches: reduced,
    addEventListener(_type, listener) { listeners.add(listener) },
    removeEventListener(_type, listener) { listeners.delete(listener) },
    change() { for (const listener of [...listeners]) listener({ matches: media.matches }) },
  }
  const timelines = []
  const resets = []
  const gsapApi = {
    timeline(options) {
      const timeline = {
        options, steps: [], killed: false,
        fromTo(target, from, to, position) { this.steps.push({ target, from, to, position }); return this },
        kill() { this.killed = true },
      }
      timelines.push(timeline)
      return timeline
    },
    set(target, vars) { resets.push({ target, vars }) },
  }
  const stage = { dataset: {}, removeAttribute(name) { delete this.dataset[name] } }
  const original = {}
  const candidate = {}
  const connector = {}
  const candidateName = { textContent: '' }
  const summary = { textContent: '' }
  const motion = createReplacementExchangeMotion({
    stage, original, candidate, connector, candidateName, summary,
    policyLabel: 'Nueva cobertura', gsapApi, matchMedia: () => media,
  })
  return { media, listeners, timelines, resets, stage, original, candidate, connector, candidateName, summary, motion }
}

test('selección válida dibuja equipo real, política registrada y retarget cancela la escena anterior', () => {
  const f = fixture()
  f.motion.select({ id: 31, brand: 'Google', model: 'Pixel 8' })
  assert.equal(f.stage.dataset.state, 'selected')
  assert.equal(f.candidateName.textContent, 'Google Pixel 8')
  assert.match(f.summary.textContent, /Google Pixel 8 · Nueva cobertura/)
  assert.match(f.summary.textContent, /Aún no se ha registrado/)
  assert.equal(f.timelines.length, 1)
  assert.deepEqual(f.timelines[0].steps.map(step => step.target), [f.original, f.candidate, f.connector])
  assert.equal(f.timelines[0].steps[2].to.scaleX, 1)

  f.motion.select({ id: 32, brand: 'Samsung', model: 'A55' })
  assert.equal(f.timelines[0].killed, true)
  assert.equal(f.candidateName.textContent, 'Samsung A55')
  assert.equal(f.timelines.length, 2)
  f.motion.clear()
  assert.equal(f.timelines[1].killed, true)
  assert.equal(f.stage.dataset.state, 'empty')
  assert.equal(f.candidateName.textContent, 'Elige un equipo')
  assert.equal(f.summary.textContent, 'Selecciona un equipo para ver el intercambio.')
  f.motion.dispose()
})

test('movimiento reducido inicial y activado en vivo no crean o mantienen tweens', () => {
  const f = fixture({ reduced: true })
  f.motion.select({ id: 31, brand: 'Google', model: 'Pixel 8' })
  assert.equal(f.timelines.length, 0)
  assert.equal(f.candidateName.textContent, 'Google Pixel 8')
  f.media.matches = false
  f.media.change()
  assert.equal(f.timelines.length, 1, 'al volver a movimiento normal, representa la selección actual')
  f.media.matches = true
  f.media.change()
  assert.equal(f.timelines[0].killed, true)
  assert.ok(f.resets.length >= 2)
  assert.equal(f.candidateName.textContent, 'Google Pixel 8', 'la información permanece estática')
  f.motion.dispose()
  assert.equal(f.listeners.size, 0)
  assert.match(motionCss, /\.case-replacement-exchange\[data-state='selected'\] \.case-replacement-exchange__connector\s*\{[^}]*transform:\s*scaleX\(1\)/)
  assert.match(motionCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)[^{]*\{\s*\.case-replacement-exchange\[data-state='selected'\] \.case-replacement-exchange__connector\s*\{[^}]*transform:\s*none/)
})

test('limpiar elimina los datos de retarget y una preferencia posterior no revive el equipo previo', () => {
  const f = fixture()
  f.motion.select({ id: 31, brand: 'Google', model: 'Pixel 8' })
  f.motion.clear()
  assert.equal(f.stage.dataset.selectedTerminal, undefined)
  assert.equal(f.stage.dataset.selectedBrand, undefined)
  assert.equal(f.stage.dataset.selectedModel, undefined)

  f.media.matches = true
  f.media.change()
  f.media.matches = false
  f.media.change()
  assert.equal(f.timelines.length, 1, 'no se crea otro tween desde una selección borrada')
  assert.equal(f.candidateName.textContent, 'Elige un equipo')
  assert.equal(f.summary.textContent, 'Selecciona un equipo para ver el intercambio.')
  assert.equal(f.stage.dataset.state, 'empty')
  f.motion.dispose()
})

test('desmontar la escena cancela su tween y el dibujo se marca como decorativo', () => {
  const f = fixture()
  f.motion.select({ id: 31, brand: 'Google', model: 'Pixel 8' })
  f.motion.dispose()
  assert.equal(f.timelines[0].killed, true)
  assert.equal(f.listeners.size, 0)
  assert.ok(f.resets.length > 0)

  const stageAfterDispose = { ...f.stage.dataset }
  const summaryAfterDispose = f.summary.textContent
  const candidateAfterDispose = f.candidateName.textContent
  const timelinesAfterDispose = f.timelines.length
  const resetsAfterDispose = f.resets.length
  f.motion.select({ id: 32, brand: 'Samsung', model: 'A55' })
  f.motion.clear()
  assert.deepEqual(f.stage.dataset, stageAfterDispose)
  assert.equal(f.summary.textContent, summaryAfterDispose)
  assert.equal(f.candidateName.textContent, candidateAfterDispose)
  assert.equal(f.timelines.length, timelinesAfterDispose)
  assert.equal(f.resets.length, resetsAfterDispose)

  const html = caseReplacementPanelMarkup({
    status: 'diagnosing', coverage_covered: true, client: { id: 4 },
    terminal: { id: 2, brand: 'OriginalCo', model: 'Phone 1', coverage: { id: 1, replacement_policy: 'continue' } },
  }, 'reception', 10)
  assert.match(html, /aria-hidden="true"/)
  assert.match(html, /OriginalCo Phone 1/)
  assert.match(html, /Continuar cobertura/)
  assert.match(html, /data-exchange-candidate-name/)
})
