import { esc } from './util.js'
import { reportCell } from './report-format.js'
import gsap from 'gsap'

// Each visualization uses fields already returned by the corresponding report.
// Deliberately excludes customer-identifying columns from the visual summary.
const VISUALS = {
  'clientes-registrados': { dimension: 'active', measure: 'row-count', label: 'Estado de los clientes' },
  'reparaciones-por-periodo': { dimension: 'day', measure: 'cases', label: 'Casos recibidos por día' },
  'ingresos-totales': { dimension: 'method_label', measure: 'income_cents', label: 'Ingresos por método de pago' },
  'terminales-ingresados': { dimension: 'status', measure: 'row-count', label: 'Casos por estado' },
  'reparaciones-por-tecnico': { dimension: 'technician_name', measure: 'cases', label: 'Casos por técnico' },
  'reparaciones-por-problema': { dimension: 'problem_type', measure: 'cases', label: 'Casos por tipo de problema' },
  'terminales-por-marca': { dimension: 'brand', measure: 'terminals', label: 'Terminales por marca' },
  'reparaciones-por-cobertura': { dimension: 'coverage_name', measure: 'cases', label: 'Casos por cobertura' },
  'historial-reparaciones': { dimension: 'to_status', measure: 'row-count', label: 'Movimientos por estado de llegada' },
  'pagos-por-reparacion': { dimension: 'method_label', measure: 'amount_cents', label: 'Importe por método de pago' },
  'registro-terminales': { dimension: 'brand', measure: 'row-count', label: 'Equipos registrados por marca' },
  prestamos: { dimension: 'estado', measure: 'row-count', label: 'Préstamos por estado' },
  'ingresos-diarios': { dimension: 'dia', measure: 'income_cents', label: 'Ingresos por día' },
  'ingresos-semanales': { dimension: 'semana', measure: 'income_cents', label: 'Ingresos por semana' },
  'ingresos-mensuales': { dimension: 'mes', measure: 'income_cents', label: 'Ingresos por mes' },
  'reparaciones-por-estado': { dimension: 'estado', measure: 'casos', label: 'Casos por estado' },
}

function dimensionLabel(key, value) {
  if (key === 'active') return value === true ? 'Activos' : value === false ? 'Inactivos' : 'Sin dato'
  if (key === 'to_status') return String(value || 'Sin estado')
  return reportCell(value, key === 'day' || key === 'dia' || key === 'semana' || key === 'mes' ? 'date' : 'text')
}

function axisLabel(label) {
  const match = /^(\d{1,2}) de (\p{L}+) de \d{4}$/u.exec(label)
  return match ? `${match[1]} ${match[2].slice(0, 3)}` : label.length > 12 ? `${label.slice(0, 11)}…` : label
}

export function reportVisualModel(slug, columns, rows) {
  const spec = VISUALS[slug]
  if (!spec || !Array.isArray(rows) || rows.length === 0) return null
  const available = new Set((columns || []).map(column => column.key))
  if (!available.has(spec.dimension) || (spec.measure !== 'row-count' && !available.has(spec.measure))) return null

  const grouped = new Map()
  for (const [rowIndex, row] of rows.entries()) {
    const label = dimensionLabel(spec.dimension, row[spec.dimension])
    if (!label || label === '—') continue
    const raw = spec.measure === 'row-count' ? 1 : Number(row[spec.measure])
    if (!Number.isFinite(raw) || raw < 0) continue
    const current = grouped.get(label) || { value: 0, rowIndexes: [] }
    current.value += raw
    current.rowIndexes.push(rowIndex)
    grouped.set(label, current)
  }

  const all = [...grouped].map(([label, group]) => ({ label, value: group.value, rowIndexes: group.rowIndexes }))
  if (!all.length) return null
  const ordered = ['day', 'dia', 'semana', 'mes'].includes(spec.dimension)
    ? all
    : all.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'es'))
  const isTimeline = ['day', 'dia', 'semana', 'mes'].includes(spec.dimension)
  const visible = isTimeline ? ordered.slice(-12) : ordered.slice(0, 8)
  return {
    label: spec.label,
    metric: spec.measure.endsWith('_cents') ? 'cents' : 'integer',
    items: visible,
    totalCategories: all.length,
    truncated: visible.length < all.length,
  }
}

// Unique per render so a control can never point at a bar from a previous report.
let chartSequence = 0

export function reportVisualHtml(model) {
  if (!model?.items?.length) return ''
  const width = 760
  const height = 248
  const top = 24
  const baseline = 190
  const plotHeight = baseline - top
  const slot = width / model.items.length
  const barWidth = Math.min(58, slot * 0.56)
  const peak = Math.max(...model.items.map(item => item.value), 1)
  const chartId = `report-chart-${++chartSequence}`
  const bars = model.items.map((item, index) => {
    const x = slot * index + (slot - barWidth) / 2
    const barHeight = item.value === 0 ? 2 : Math.max(3, item.value / peak * (plotHeight - 22))
    const y = baseline - barHeight
    const label = esc(axisLabel(item.label))
    const value = esc(reportCell(item.value, model.metric))
    const focusWidth = Math.min(slot - 6, barWidth + 26)
    const focusX = slot * index + (slot - focusWidth) / 2
    return `<g class="report-chart__column" data-chart-index="${index}" data-chart-label="${esc(item.label)}" data-chart-value="${value}" data-chart-zero="${item.value === 0}" style="--bar-delay:${index * 55}ms;--bar-scale:${(barHeight / plotHeight).toFixed(4)}" data-row-indexes="${item.rowIndexes.join(',')}">
      <title>${esc(item.label)}: ${value}</title>
      <rect class="report-chart__focus" x="${focusX.toFixed(1)}" y="6" width="${focusWidth.toFixed(1)}" height="${baseline - 2}" rx="10" aria-hidden="true" />
      <rect id="${chartId}-bar-${index}" class="report-chart__bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="7" />
      <text class="report-chart__value" x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle">${value}</text>
      <text class="report-chart__label" x="${(slot * index + slot / 2).toFixed(1)}" y="${baseline + 24}" text-anchor="middle">${label}</text>
    </g>`
  }).join('')
  const accessible = model.items.map(item => `${item.label}: ${reportCell(item.value, model.metric)}`).join('; ')
  const legend = model.items.map((item, index) => {
    const value = reportCell(item.value, model.metric)
    return `<li><button class="report-chart__legend-button" type="button" data-chart-index="${index}" aria-pressed="false" aria-controls="${chartId}-bar-${index}" aria-label="${esc(`${item.label}: ${value}`)}"><span class="report-chart__legend-label">${esc(item.label)}</span><strong class="report-chart__legend-value">${esc(value)}</strong></button></li>`
  }).join('')
  return `<section class="report-chart" aria-label="${esc(model.label)}">
    <header class="report-chart__heading"><div><p class="report-chart__eyebrow">LECTURA VISUAL</p><h3>${esc(model.label)}</h3></div><span>${model.truncated ? `${model.items.length} de ${model.totalCategories} grupos` : `${model.totalCategories} ${model.totalCategories === 1 ? 'grupo' : 'grupos'}`}</span></header>
    <div class="report-chart__stage">
      <svg class="report-chart__svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(model.label)}. ${esc(accessible)}" preserveAspectRatio="xMidYMid meet">
        <defs><linearGradient id="report-bar-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--signal)"/><stop offset="1" stop-color="var(--signal-text)"/></linearGradient></defs>
        <path class="report-chart__grid" d="M0 65H760 M0 125H760 M0 190H760" />${bars}
        <g class="report-chart__provenance" data-provenance aria-hidden="true" opacity="0" pointer-events="none"><line class="report-chart__provenance-rule" x1="0" x2="760" y1="190" y2="190"/><circle class="report-chart__provenance-cursor" cx="0" cy="190" r="5"/></g>
      </svg>
    </div>
    <p class="report-chart__detail" data-chart-detail role="status" aria-live="polite" aria-atomic="true"><span class="report-chart__detail-label" data-chart-detail-label>Elige una categoría de la leyenda para ver su detalle.</span><strong class="report-chart__detail-value" data-chart-detail-value hidden></strong><span class="report-chart__detail-count" data-chart-detail-count hidden></span></p>
    <ul class="report-chart__legend" aria-label="Categorías de la gráfica; activa una para resaltar su barra">${legend}</ul>
  </section>`
}

// Wires the legend controls for one rendered chart. Returns an idempotent
// cleanup so changing report or leaving the view cannot keep stale listeners,
// pressed states or highlights alive.
export function wireReportVisual(scope) {
  const chart = scope?.querySelector?.('.report-chart')
  if (!chart) return () => {}
  const buttons = [...chart.querySelectorAll('.report-chart__legend-button')]
  const columns = [...chart.querySelectorAll('.report-chart__column')]
  if (!buttons.length || buttons.length !== columns.length) return () => {}
  const detailLabel = chart.querySelector('[data-chart-detail-label]')
  const detailValue = chart.querySelector('[data-chart-detail-value]')
  const detailCount = chart.querySelector('[data-chart-detail-count]')
  const provenance = chart.querySelector('[data-provenance]')
  const provenanceRule = chart.querySelector('.report-chart__provenance-rule')
  const provenanceCursor = chart.querySelector('.report-chart__provenance-cursor')
  const svg = chart.querySelector('.report-chart__svg')
  const result = chart.closest('[data-result]')
  const getRows = () => result ? [...result.querySelectorAll('.reports-table tbody tr[data-report-row-index]')] : []
  const media = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null
  let reduced = Boolean(media?.matches)
  let tween = null
  const neutralLabel = detailLabel?.textContent || ''
  const controller = new AbortController()
  const { signal } = controller
  let selected = -1
  let disposed = false

  function apply(index) {
    tween?.kill?.()
    tween = null
    selected = index
    chart.classList.toggle('is-focused', index >= 0)
    columns.forEach(column => column.classList.toggle('is-selected', Number(column.dataset.chartIndex) === index))
    buttons.forEach((button, position) => {
      const active = Number(button.dataset.chartIndex) === index
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
      button.classList.toggle('is-selected', active)
    })
    if (detailLabel) {
      const selectedColumn = columns.find(column => Number(column.dataset.chartIndex) === index)
      const name = selectedColumn?.dataset.chartLabel || ''
      detailLabel.textContent = index >= 0 ? name || neutralLabel : neutralLabel
    }
    if (detailValue) {
      const value = columns.find(column => Number(column.dataset.chartIndex) === index)?.dataset.chartValue || ''
      detailValue.textContent = value || ''
      detailValue.hidden = !value
    }
    if (detailCount) {
      if (index >= 0) {
        const column = columns.find(item => Number(item.dataset.chartIndex) === index)
        const indexes = new Set((column?.dataset.rowIndexes || '').split(',').filter(Boolean).map(Number))
        const rows = getRows()
        const visibleCount = rows.reduce((count, row) => {
          const match = indexes.has(Number(row.dataset.reportRowIndex))
          row.classList.toggle('is-provenance-match', match)
          return count + Number(match)
        }, 0)
        detailCount.textContent = `${indexes.size} registros contribuyentes · ${visibleCount} visibles en esta página`
        detailCount.hidden = false
      } else {
        getRows().forEach(row => row.classList.remove('is-provenance-match'))
        detailCount.textContent = ''
        detailCount.hidden = true
      }
    }
    if (provenance && provenanceRule && provenanceCursor && index >= 0) {
      const column = columns.find(item => Number(item.dataset.chartIndex) === index)
      const bar = column.querySelector('.report-chart__bar')
      // The SVG attributes describe final geometry; clear the entry transform
      // before placing the rule so the visual bar and guide stay aligned.
      bar.style.animation = 'none'
      bar.style.transform = 'none'
      bar.style.opacity = '1'
      const x = Number(bar?.getAttribute('x') || 0) + Number(bar?.getAttribute('width') || 0) / 2
      const barY = Number(bar?.getAttribute('y') || 190)
      const barHeight = Number(bar?.getAttribute('height') || 0)
      const y = column?.dataset.chartZero === 'true'
        ? 190 : barY + barHeight / 2
      const target = { y, x }
      provenance.setAttribute('opacity', '1')
      if (reduced || !gsap?.to) {
        provenanceRule.setAttribute('y1', String(y)); provenanceRule.setAttribute('y2', String(y))
        provenanceCursor.setAttribute('cx', String(x)); provenanceCursor.setAttribute('cy', String(y))
      } else {
        tween = gsap.timeline()
          .to(provenanceRule, { attr: { y1: y, y2: y }, duration: 0.28, ease: 'power2.out' }, 0)
          .to(provenanceCursor, { attr: { cx: x, cy: y }, duration: 0.22, ease: 'power2.out' }, 0)
      }
    } else if (provenance) {
      if (reduced || !gsap?.to) provenance.setAttribute('opacity', '0')
      else tween = gsap.to(provenance, { attr: { opacity: 0 }, duration: 0.16, ease: 'power2.out' })
    }
  }

  const onMotionChange = event => {
    reduced = Boolean(event.matches)
    if (!reduced) return
    tween?.kill?.(); tween = null
    apply(selected)
  }
  media?.addEventListener?.('change', onMotionChange)
  if (media && !media.addEventListener) media.addListener?.(onMotionChange)

  chart.addEventListener('click', event => {
    const button = event.target.closest?.('.report-chart__legend-button')
    if (!button || !chart.contains(button)) return
    const index = Number(button.dataset.chartIndex)
    if (!Number.isInteger(index) || !columns.some(column => Number(column.dataset.chartIndex) === index)) return
    apply(index === selected ? -1 : index)
  }, { signal })

  chart.addEventListener('keydown', event => {
    const button = event.target.closest?.('.report-chart__legend-button')
    if (!button) return
    if (event.key === 'Escape') {
      if (selected === -1) return
      event.preventDefault()
      const previous = buttons[selected]
      apply(-1)
      previous?.focus()
      return
    }
    const current = buttons.indexOf(button)
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    let next = null
    if (step) next = (current + step + buttons.length) % buttons.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = buttons.length - 1
    if (next === null) return
    event.preventDefault()
    buttons[next].focus()
  }, { signal })

  const cleanup = () => {
    if (disposed) return
    disposed = true
    controller.abort()
    tween?.kill?.()
    media?.removeEventListener?.('change', onMotionChange)
    if (media && !media.removeEventListener) media.removeListener?.(onMotionChange)
    reduced = true
    apply(-1)
    getRows().forEach(row => row.classList.remove('is-provenance-match'))
  }
  cleanup.refresh = () => { if (!disposed && selected >= 0) apply(selected) }
  return cleanup
}
