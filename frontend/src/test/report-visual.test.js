import test from 'node:test'
import assert from 'node:assert/strict'
import { reportVisualModel, reportVisualHtml, wireReportVisual } from '../report-visual.js'

test('customer visualization groups by active flag and never exposes identifying fields', () => {
  const columns = ['id', 'full_name', 'document_id', 'email', 'active'].map(key => ({ key }))
  const rows = [
    { id: 1, full_name: 'Persona Uno', document_id: 'DOC-1', email: 'one@example.test', active: true },
    { id: 2, full_name: 'Persona Dos', document_id: 'DOC-2', email: 'two@example.test', active: true },
    { id: 3, full_name: 'Persona Tres', document_id: 'DOC-3', email: 'three@example.test', active: false },
  ]
  const model = reportVisualModel('clientes-registrados', columns, rows)
  assert.deepEqual(model.items, [
    { label: 'Activos', value: 2, rowIndexes: [0, 1] },
    { label: 'Inactivos', value: 1, rowIndexes: [2] },
  ])
  const html = reportVisualHtml(model)
  assert.match(html, /Activos/)
  assert.doesNotMatch(html, /Persona Uno|DOC-1|one@example\.test/)
})

test('visualization aggregates repeated categories and limits dense charts', () => {
  const columns = [{ key: 'problem_type' }, { key: 'cases' }]
  const rows = Array.from({ length: 12 }, (_, index) => ({ problem_type: `Problema ${index}`, cases: index + 1 }))
  rows.push({ problem_type: 'Problema 11', cases: 5 })
  const model = reportVisualModel('reparaciones-por-problema', columns, rows)
  assert.equal(model.totalCategories, 12)
  assert.equal(model.items.length, 8)
  assert.equal(model.items[0].label, 'Problema 11')
  assert.equal(model.items[0].value, 17)
  assert.equal(model.truncated, true)
})

test('time charts preserve chronological order and expose accessible values', () => {
  const columns = [{ key: 'dia' }, { key: 'income_cents' }]
  const rows = [
    { dia: '2026-10-01', income_cents: 2500 },
    { dia: '2026-10-02', income_cents: 5000 },
  ]
  const model = reportVisualModel('ingresos-diarios', columns, rows)
  assert.deepEqual(model.items.map(item => item.value), [2500, 5000])
  const html = reportVisualHtml(model)
  assert.match(html, /role="img"/)
  assert.match(html, />1 oct<\/text>/)
  assert.match(html, /1 de octubre de 2026: 25,00/)
  assert.match(html, /25,00/)
  assert.match(html, /50,00/)
})

test('visualization fails closed when report columns do not match its contract', () => {
  assert.equal(reportVisualModel('reparaciones-por-problema', [{ key: 'full_name' }], [{ full_name: 'Cliente' }]), null)
  assert.equal(reportVisualHtml(null), '')
})

test('each legend category is a neutral accessible control tied to its bar', () => {
  const columns = [{ key: 'brand' }, { key: 'terminals' }]
  const rows = [{ brand: 'Samsung', terminals: 4 }, { brand: 'Xiaomi', terminals: 2 }]
  const html = reportVisualHtml(reportVisualModel('terminales-por-marca', columns, rows))
  const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map(match => match[1])
  assert.equal(controls.length, 2)
  for (const id of controls) assert.match(html, new RegExp(`id="${id}"`))
  assert.equal((html.match(/<button class="report-chart__legend-button" type="button"/g) || []).length, 2)
  assert.equal((html.match(/aria-pressed="false"/g) || []).length, 2)
  assert.doesNotMatch(html, /aria-pressed="true"/)
  assert.match(html, /aria-label="Samsung: 4"/)
  assert.match(html, /data-chart-detail role="status" aria-live="polite" aria-atomic="true"/)
  assert.doesNotMatch(html, /data-chart-detail[^>]*aria-hidden/)
  assert.match(html, /Elige una categoría de la leyenda/)
  assert.match(html, /data-chart-detail-value hidden/)
})

test('chart control ids are unique per render so no control targets a previous report', () => {
  const columns = [{ key: 'brand' }, { key: 'terminals' }]
  const model = reportVisualModel('terminales-por-marca', columns, [{ brand: 'Samsung', terminals: 4 }])
  const first = /aria-controls="([^"]+)"/.exec(reportVisualHtml(model))[1]
  const second = /aria-controls="([^"]+)"/.exec(reportVisualHtml(model))[1]
  assert.notEqual(first, second)
})

test('legend labels and values stay escaped in text and accessible names', () => {
  const columns = [{ key: 'brand' }, { key: 'terminals' }]
  const label = 'A&B <img src=x onerror=alert(1)> "Pro"'
  const html = reportVisualHtml(reportVisualModel('terminales-por-marca', columns, [{ brand: label, terminals: 1 }]))
  assert.doesNotMatch(html, /<img src=x/)
  assert.match(html, /A&amp;B &lt;img src=x onerror=alert\(1\)&gt; &quot;Pro&quot;/)
  assert.match(html, /aria-label="A&amp;B &lt;img src=x onerror=alert\(1\)&gt; &quot;Pro&quot;: 1"/)
})

test('wiring a missing chart returns an idempotent no-op cleanup', () => {
  const dispose = wireReportVisual(null)
  assert.equal(typeof dispose, 'function')
  dispose()
  dispose()
})

function chartHarness(items) {
  const listeners = new Map()
  const chartClasses = new Set()
  const detailLabel = { textContent: 'Elige una categoría de la leyenda' }
  const detailValue = { textContent: '', hidden: true }
  const detailCount = { textContent: '', hidden: true }
  const classList = set => ({
    toggle: (name, on) => on ? set.add(name) : set.delete(name),
    add: name => set.add(name),
    remove: name => set.delete(name),
  })
  const buttons = items.map((item, index) => {
    const classes = new Set()
    const attrs = new Map()
    return {
      classes, attrs,
      dataset: { chartIndex: String(index) },
      classList: classList(classes),
      setAttribute: (name, value) => attrs.set(name, value),
      querySelector: selector => ({
        textContent: selector === '.report-chart__legend-label' ? item.label : item.value,
      }),
      focus() { this.focused = true },
    }
  })
  const rows = items.map((_, index) => {
    const classes = new Set()
    return { dataset: { reportRowIndex: String(index) }, classes, classList: classList(classes) }
  })
  const columns = items.map((item, index) => {
    const classes = new Set()
    return {
      classes,
      classList: classList(classes),
      dataset: {
        chartIndex: String(index), chartLabel: item.label, chartValue: item.value,
        rowIndexes: (item.rowIndexes || [index]).join(','), chartZero: 'false',
      },
      querySelector: () => ({ getAttribute: () => '0', style: {} }),
    }
  })
  const result = { querySelectorAll: () => rows }
  const chart = {
    classes: chartClasses,
    classList: classList(chartClasses),
    contains: node => buttons.includes(node),
    querySelectorAll: selector => selector === '.report-chart__legend-button' ? buttons : columns,
    querySelector: selector => ({
      '[data-chart-detail-label]': detailLabel,
      '[data-chart-detail-value]': detailValue,
      '[data-chart-detail-count]': detailCount,
    })[selector] || null,
    closest: selector => selector === '[data-result]' ? result : null,
    addEventListener: (type, handler, options) => {
      listeners.set(type, handler)
      options.signal.addEventListener('abort', () => listeners.delete(type))
    },
  }
  return { scope: { querySelector: () => chart }, buttons, columns, rows, chart, detailLabel, detailValue, detailCount, listeners }
}

test('legend wiring selects, toggles and resets its bar and detail, then cleans up', () => {
  const harness = chartHarness([{ label: 'Samsung', value: '4' }, { label: 'Xiaomi', value: '2' }])
  const dispose = wireReportVisual(harness.scope)
  const click = button => harness.listeners.get('click')({ target: { closest: () => button } })

  click(harness.buttons[0])
  assert.equal(harness.buttons[0].attrs.get('aria-pressed'), 'true')
  assert.equal(harness.buttons[1].attrs.get('aria-pressed'), 'false')
  assert.equal(harness.chart.classes.has('is-focused'), true)
  assert.equal(harness.columns[0].classes.has('is-selected'), true)
  assert.equal(harness.columns[1].classes.has('is-selected'), false)
  assert.equal(harness.detailLabel.textContent, 'Samsung')
  assert.equal(harness.detailValue.textContent, '4')
  assert.equal(harness.detailValue.hidden, false)
  assert.equal(harness.detailCount.textContent, '1 registros contribuyentes · 1 visibles en esta página')
  assert.equal(harness.rows[0].classes.has('is-provenance-match'), true)
  assert.equal(harness.rows[1].classes.has('is-provenance-match'), false)

  click(harness.buttons[0])
  assert.equal(harness.buttons[0].attrs.get('aria-pressed'), 'false')
  assert.equal(harness.chart.classes.has('is-focused'), false)
  assert.equal(harness.detailLabel.textContent, 'Elige una categoría de la leyenda')
  assert.equal(harness.detailValue.hidden, true)
  assert.equal(harness.detailCount.hidden, true)
  assert.equal(harness.rows[0].classes.has('is-provenance-match'), false)

  let prevented = false
  harness.listeners.get('keydown')({
    target: { closest: () => harness.buttons[0] },
    key: 'ArrowRight',
    preventDefault: () => { prevented = true },
  })
  assert.equal(prevented, true)
  assert.equal(harness.buttons[1].focused, true)

  click(harness.buttons[1])
  assert.equal(harness.buttons[1].attrs.get('aria-pressed'), 'true')
  dispose()
  assert.equal(harness.listeners.size, 0)
  assert.equal(harness.buttons[1].attrs.get('aria-pressed'), 'false')
  assert.equal(harness.columns[1].classes.has('is-selected'), false)
  assert.equal(harness.chart.classes.has('is-focused'), false)
  assert.equal(harness.detailValue.hidden, true)
})
