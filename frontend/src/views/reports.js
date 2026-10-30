import { get } from '../api.js'
import { esc } from '../util.js'
import { reportCell, reportSummary, reportError } from '../report-format.js'
import { reportVisualModel, reportVisualHtml, wireReportVisual } from '../report-visual.js'
import { workShell, requireAuth, onLeave } from '../layout/work.js'
import { createReportConnectionMotion, createReportPassportModel, unlockReportControlsThenRefresh } from '../report-query-passport.js'
import '../styles/reports.css'

const FILTERS = {
  from:{label:'Desde',type:'date'}, to:{label:'Hasta',type:'date'},
  technician_id:{label:'ID del técnico',type:'number',extra:'min="1" step="1"'},
  brand:{label:'Marca del terminal',type:'text',extra:'maxlength="80" placeholder="Ej. Samsung"'},
}
const FILTER_LABELS = Object.fromEntries(Object.entries(FILTERS).map(([key, item]) => [key, item.label]))

function describeQuery(snapshot) {
  return snapshot?.filters?.length
    ? snapshot.filters.map(({ label, value }) => `${label}: ${value}`).join(' · ')
    : 'Sin filtros'
}

export async function reportsView(root) {
  if (!(await requireAuth(root))) return
  let viewActive = true
  let disposeVisual = () => {}
  let connectionMotion = null
  const passport = createReportPassportModel()
  onLeave(() => {
    viewActive = false
    passport.dispose()
    connectionMotion?.dispose()
    disposeVisual()
    disposeVisual = () => {}
  })
  root.innerHTML = workShell('Reportes','Consultas oficiales','<div class="skel" role="status" aria-live="polite">Cargando catálogo…</div>')
  const main = root.querySelector('.work-main')
  let catalog
  try {
    const { data } = await get('/reports')
    if (!viewActive || !main.isConnected) return
    catalog = Array.isArray(data) ? data : data?.reports || []
  } catch(error) {
    if (!viewActive || !main.isConnected) return
    main.innerHTML = `<div class="reports-page">
      <header class="reports-heading"><div><h1>Reportes del taller</h1><p>Consultas oficiales de la actividad, los equipos y los ingresos.</p></div></header>
      <section class="reports-unavailable panel" role="alert" aria-labelledby="reports-unavailable-title">
        <span class="reports-unavailable__signal" aria-hidden="true"><span></span></span>
        <div><p class="reports-unavailable__eyebrow">CONSULTAS DEL TALLER</p><h2 id="reports-unavailable-title">La estación de reportes está en pausa</h2>
          <p class="reports-unavailable__message">${esc(reportError(error))}</p>
          <button class="btn btn-primary" type="button" data-retry>Reintentar carga</button></div>
      </section>
    </div>`
    main.querySelector('[data-retry]').onclick = () => reportsView(root)
    return
  }
  main.innerHTML = `<div class="reports-page">
    <header class="reports-heading"><div><h1>Reportes del taller</h1><p>Revisa la actividad, los equipos y los ingresos con los datos del sistema.</p></div><span class="reports-count">${catalog.length} consultas disponibles</span></header>
    <form data-run class="reports-controls panel">
      <div class="reports-select field"><label for="report-slug">¿Qué quieres consultar?</label><select id="report-slug" name="slug" required>${catalog.map(r => `<option value="${esc(r.slug)}">${esc(r.name)}</option>`).join('') || '<option value="">No hay reportes disponibles</option>'}</select><span data-category class="reports-category"></span></div>
      <div data-filters class="reports-filters"></div>
      <section class="reports-query-passport" data-query-passport aria-labelledby="reports-query-passport-title">
        <header><p id="reports-query-passport-title">Ficha de consulta</p><span data-passport-status>Sin generar</span></header>
        <h2 data-passport-name></h2>
        <p class="reports-query-passport__count"><span data-passport-count>0</span> filtros en borrador</p>
        <dl data-passport-filters class="reports-query-passport__filters"><div><dt>Filtros</dt><dd>Sin filtros</dd></div></dl>
        <p class="reports-query-passport__last" data-passport-last hidden></p>
      </section>
      <div class="reports-actions"><div class="field"><label for="report-format">Presentación</label><select id="report-format" name="format"><option value="screen">Ver en pantalla</option><option value="pdf">Descargar PDF</option><option value="xlsx">Descargar Excel</option></select></div><button class="btn btn-primary" type="submit" ${catalog.length ? '' : 'disabled'}>Generar reporte</button><button class="btn btn-ghost" type="reset">Limpiar filtros</button></div>
    </form>
    <p data-state class="reports-state" role="status" aria-live="polite" aria-atomic="true">Selecciona un reporte para comenzar.</p>
    <div class="reports-query-connection" data-query-connection aria-hidden="true"><span></span></div>
    <section data-result aria-label="Resultado del reporte"><div class="reports-empty"><span aria-hidden="true">▤</span><h2>Una vista clara de tu taller</h2><p>Elige una consulta y aplica los filtros que necesites. También puedes descargarla para compartirla.</p></div></section>
  </div>`
  const form = main.querySelector('[data-run]')
  const select = form.elements.slug
  const button = form.querySelector('[type="submit"]')
  const state = main.querySelector('[data-state]')
  const result = main.querySelector('[data-result]')
  connectionMotion = createReportConnectionMotion({
    getConnector: () => main.querySelector('[data-query-connection]'),
    isActive: () => viewActive && main.isConnected,
  })
  let busy = false
  function updatePassport() {
    if (!viewActive || !main.isConnected) return
    const entry = catalog.find(report => report.slug === select.value)
    const draft = passport.capture(entry, new FormData(form), FILTER_LABELS)
    main.querySelector('[data-passport-name]').textContent = draft.name
    main.querySelector('[data-passport-status]').textContent = passport.status(draft)
    main.querySelector('[data-passport-count]').textContent = String(draft.filters.length)
    const filters = main.querySelector('[data-passport-filters]')
    filters.innerHTML = draft.filters.length
      ? draft.filters.map(filter => `<div><dt>${esc(filter.label)}</dt><dd>${esc(filter.value)}</dd></div>`).join('')
      : '<div><dt>Filtros</dt><dd>Sin filtros</dd></div>'
    const last = passport.lastDisplayed()
    const lastLabel = main.querySelector('[data-passport-last]')
    lastLabel.hidden = !last
    lastLabel.textContent = last ? `Último resultado mostrado: ${last.name} — ${describeQuery(last)}` : ''
  }
  function updateFilters() {
    const entry = catalog.find(r => r.slug === select.value)
    main.querySelector('[data-category]').textContent = entry?.category || ''
    main.querySelector('[data-filters]').innerHTML = (entry?.filters || []).filter(k => FILTERS[k]).map(key => {
      const f = FILTERS[key]
      return `<div class="field"><label for="report-${key}">${f.label}</label><input id="report-${key}" name="${key}" type="${f.type}" ${f.extra || ''}></div>`
    }).join('')
    updatePassport()
  }
  updateFilters()
  select.addEventListener('change',updateFilters)
  form.addEventListener('input',updatePassport)
  form.addEventListener('change',updatePassport)
  form.addEventListener('reset',() => queueMicrotask(updateFilters))
  form.addEventListener('submit',async event => {
    event.preventDefault()
    if (busy) return
    const entry = catalog.find(r => r.slug === select.value)
    if (!entry) return
    const values = new FormData(form)
    const snapshot = passport.capture(entry, values, FILTER_LABELS)
    const params = new URLSearchParams(snapshot.params)
    if (params.get('from') && params.get('to') && params.get('from') > params.get('to')) {
      state.textContent = 'La fecha Desde debe ser anterior o igual a Hasta.'
      form.elements.to.focus()
      return
    }
    busy = true
    connectionMotion.cancel()
    const controls = [...form.querySelectorAll('input,select,button')]
    controls.forEach(c => c.disabled = true)
    button.textContent = 'Generando…'
    result.setAttribute('aria-busy','true')
    state.textContent = `Consultando ${entry.name.toLowerCase()}…`
    try {
      const path = `/reports/${encodeURIComponent(entry.slug)}`
      if (values.get('format') === 'screen') {
        const { data } = await get(`${path}?${params}`)
        if (!viewActive || !main.isConnected || !passport.isActive()) return
        disposeVisual()
        disposeVisual = renderReport(result,data,entry,params,snapshot)
        passport.commitScreen(snapshot)
        connectionMotion.connect()
        state.textContent = `${entry.name}: ${data.rows.length} registros encontrados.`
      } else {
        const format = values.get('format')
        params.set('format',format)
        const response = await fetch(`/api${path}?${params}`,{credentials:'same-origin'})
        if (!response.ok) {
          const body = await response.json().catch(() => null)
          throw { ...(body?.error || {}), status: response.status }
        }
        if (!viewActive || !main.isConnected || !passport.isActive()) return
        const blob = await response.blob()
        if (!viewActive || !main.isConnected || !passport.isActive()) return
        const url = URL.createObjectURL(blob)
        const a = Object.assign(document.createElement('a'),{href:url,download:`${entry.slug}.${format}`})
        document.body.append(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url),1000)
        state.textContent = `${entry.name}: descarga ${format.toUpperCase()} preparada.`
      }
    } catch(error) {
      if (!viewActive || !main.isConnected || !passport.isActive()) return
      disposeVisual()
      disposeVisual = () => {}
      passport.clearDisplayed()
      connectionMotion.clear()
      result.innerHTML = `<div class="notice notice-error" role="alert">${esc(reportError(error))}</div>`
      state.textContent = 'No se generó el reporte. Sigue la indicación y vuelve a intentarlo.'
    } finally {
      busy = false
      if (!viewActive || !main.isConnected) return
      unlockReportControlsThenRefresh(controls, () => {
        button.textContent = 'Generar reporte'
        result.removeAttribute('aria-busy')
        updatePassport()
      })
    }
  })
}

function renderReport(result,data,entry,params,snapshot) {
  const columns = Array.isArray(data.columns) ? data.columns : []
  const rows = Array.isArray(data.rows) ? data.rows : []
  const visual = reportVisualHtml(reportVisualModel(entry.slug, columns, rows))
  const pageSize = 50
  let page = 1
  const pages = Math.max(1,Math.ceil(rows.length/pageSize))
  result.innerHTML = `<div class="reports-summary">${Object.entries(data.summary || {}).map(([key,value]) => {
    const stat = reportSummary(key,value)
    return `<div class="reports-metric"><span>${esc(stat.label)}</span><strong>${esc(stat.value)}</strong></div>`
  }).join('')}</div>${visual}<div class="reports-result panel" data-result-signature="${esc(snapshot.signature)}"><header><div><h2>${esc(data.report?.name || entry.name)}</h2><p>${rows.length.toLocaleString('es-SV')} registros · ${params.size ? 'Filtros aplicados' : 'Todo el período'}</p></div><span class="reports-category">${esc(entry.category)}</span></header><div class="reports-result-passport" aria-label="Consulta usada para este resultado"><span>Pasaporte del resultado</span><strong>${esc(snapshot.name)}</strong><p>${esc(describeQuery(snapshot))}</p></div><div class="reports-table-scroll" role="region" aria-label="Tabla del reporte; desplázate para ver todas las columnas" tabindex="0"><table class="reports-table"><caption class="sr-only">${esc(entry.name)}</caption><thead><tr>${columns.map(c => `<th scope="col" class="${['cents','integer'].includes(c.type) ? 'reports-numeric' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody></tbody></table></div><div class="reports-pagination"><button class="btn btn-ghost" data-prev>Anterior</button><span data-page role="status" aria-live="polite"></span><button class="btn btn-ghost" data-next>Siguiente</button></div></div>`
  const filterDescription = [...params].map(([key,value]) => `${FILTERS[key]?.label || key}: ${reportCell(value,['from','to'].includes(key) ? 'date' : 'text')}`).join(' · ')
  result.querySelector('.reports-result > header p').textContent = `${rows.length.toLocaleString('es-SV')} registros · ${filterDescription || 'Todo el período'}`
  const tbody = result.querySelector('tbody')
  const prev = result.querySelector('[data-prev]')
  const next = result.querySelector('[data-next]')
  let refreshVisual = () => {}
  function renderPage() {
    tbody.innerHTML = rows.slice((page-1)*pageSize,page*pageSize).map((row, offset) => `<tr data-report-row-index="${(page-1)*pageSize+offset}">${columns.map(c => `<td class="${['cents','integer'].includes(c.type) ? 'reports-numeric' : ''}">${esc(reportCell(row[c.key],c.type))}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${Math.max(columns.length,1)}" class="reports-no-data">No hay registros para estos filtros. Amplía el período o cambia los filtros.</td></tr>`
    prev.disabled = page === 1
    next.disabled = page === pages
    result.querySelector('[data-page]').textContent = `${rows.length ? (page-1)*pageSize+1 : 0}–${Math.min(page*pageSize,rows.length)} de ${rows.length} · página ${page} de ${pages}`
    refreshVisual()
  }
  prev.onclick = () => { page--; renderPage() }
  next.onclick = () => { page++; renderPage() }
  renderPage()
  const cleanup = wireReportVisual(result)
  refreshVisual = cleanup.refresh || refreshVisual
  return cleanup
}
