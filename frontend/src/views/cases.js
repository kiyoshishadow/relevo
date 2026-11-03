// Casos: listado y detalle con acciones reales del contrato.
import { get, patch, post } from '../api.js'
import { esc, pill, fmtDate, fmtMoney, stateLabel, CASE_STATES, STATE_LABEL } from '../util.js'
import { workShell, requireAuth, onLeave } from '../layout/work.js'
import { flashError, flashOk, field } from '../ui.js'
import gsap from 'gsap'
import { caseFlowMarkup, caseBenchMarkup } from '../components/case-flow.js'
import { disposeCaseInspector, mountCaseInspector } from '../components/case-inspector.js'
import '../styles/case-detail-motion.css'
import '../styles/case-list-motion.css'
import { loadAllPages } from '../paged-data.js'
import { availableLoanDevices, loanDeviceOptionLabel } from '../loan-devices.js'
import { session } from '../session.js'
import { canSubmitTechnicianAssignment, preferredTechnicianSelection, UNAVAILABLE_TECHNICIAN } from '../technician-assignment.js'
import { canIssueQuote, canManageQuote, parseQuoteDecision } from '../quote-controls.js'
import { availableCaseTransitions, canAddCaseAction, canAssignCaseLoan, canAssignCaseTechnician, canCancelCase, canDiagnose, canRegisterCasePayment, canReturnCaseLoan, caseExcludedReason } from '../case-permissions.js'
import { casePaymentSummaryMarkup, completeCaseOperation, shouldShowPaymentForm } from '../case-payment-summary.js'

const listRequests = new WeakMap()
const caseAnimations = new WeakMap()
const listAnimations = new WeakMap()
const benchOpenAnimations = new WeakMap()
const benchResting = new WeakMap()
const replacementMotionByZone = new WeakMap()

const replacementPolicies = {
  new: {
    label: 'Nueva cobertura',
    explanation: 'Se crea una cobertura nueva con el mismo plan y plazo de la cobertura del caso.',
  },
  continue: {
    label: 'Continuar cobertura',
    explanation: 'El terminal elegido continúa con la cobertura registrada para este caso.',
  },
}

export function replacementPolicyInfo(policy) {
  return replacementPolicies[policy] || null
}

export function canRegisterReplacement(cs, role) {
  const policy = cs?.terminal?.coverage?.replacement_policy
  return ['admin', 'reception'].includes(role)
    && cs?.coverage_covered === true
    && cs?.terminal?.coverage?.id !== null
    && cs?.terminal?.coverage?.id !== undefined
    && Boolean(replacementPolicyInfo(policy))
    && ['diagnosing', 'repairing', 'ready'].includes(cs?.status)
    && !cs?.replacement
}

export function replacementTerminalChoices(terminals, clientId, originalTerminalId) {
  if (clientId === null || clientId === undefined) return []
  return (Array.isArray(terminals) ? terminals : [])
    .filter(terminal => String(terminal.client_id) === String(clientId)
      && String(terminal.id) !== String(originalTerminalId))
}

export function replacementTerminalSelection(choices, pendingDraft, valueBeforeLoad) {
  const desiredValue = pendingDraft ?? valueBeforeLoad
  return (Array.isArray(choices) ? choices : [])
    .some(terminal => String(terminal.id) === String(desiredValue))
    ? String(desiredValue)
    : ''
}

export function restoreReplacementTerminalDraft(select, value) {
  const draftValue = String(value)
  if ([...select.options].some(option => option.value === draftValue)) {
    select.value = draftValue
    delete select.dataset.pendingReplacementDraft
  } else if (select.disabled) {
    select.dataset.pendingReplacementDraft = draftValue
  } else {
    select.value = ''
    delete select.dataset.pendingReplacementDraft
  }
}

export function replacementSummaryMarkup(replacement) {
  if (!replacement) return ''
  const terminal = replacement.terminal || {}
  const device = [terminal.brand, terminal.model].filter(Boolean).join(' ') || 'Terminal sin detalle'
  const policy = replacementPolicyInfo(replacement.policy)
  return `<div data-replacement-summary>
    <p>El caso ya tiene un reemplazo registrado.</p>
    <dl class="kv"><dt>Equipo</dt><dd>${esc(device)}</dd>
      <dt>Política aplicada</dt><dd>${esc(policy?.label || replacement.policy || '—')}</dd></dl>
    ${policy ? `<p style="color:var(--ink-mute)">${esc(policy.explanation)}</p>` : ''}
  </div>`
}

export function caseReplacementPanelMarkup(cs, role, id) {
  if (cs?.replacement) {
    return `<section class="panel" data-panel="replacement"><h3>Reemplazo</h3>${replacementSummaryMarkup(cs.replacement)}</section>`
  }
  if (!canRegisterReplacement(cs, role)) return ''
  const policy = cs.terminal.coverage.replacement_policy
  const info = replacementPolicyInfo(policy)
  const original = [cs.terminal?.brand, cs.terminal?.model].filter(Boolean).join(' ') || 'Terminal original sin detalle'
  return `<section class="panel" data-panel="replacement"><h3>Reemplazo</h3>
    <p>La cobertura registrada establece <b>${esc(info.label)}</b>. ${esc(info.explanation)}</p>
    <form data-replacement data-draft-key="replacement">
      <div class="field"><label for="replacement-terminal-${esc(id)}">Terminal del mismo cliente</label>
        <select id="replacement-terminal-${esc(id)}" name="terminal_id" required disabled aria-describedby="replacement-catalog-status-${esc(id)}">
          <option value="">Cargando equipos…</option>
        </select>
      </div>
      <p id="replacement-catalog-status-${esc(id)}" data-replacement-catalog-status role="status" aria-live="polite">Cargando equipos del cliente…</p>
      <div class="case-replacement-exchange" data-replacement-exchange data-state="empty">
        <p class="case-replacement-exchange__summary" data-exchange-summary aria-live="polite">Selecciona un equipo para ver el intercambio.</p>
        <div class="case-replacement-exchange__stage" aria-hidden="true">
          <div class="case-replacement-exchange__device" data-exchange-original><span>Original</span><b>${esc(original)}</b></div>
          <span class="case-replacement-exchange__connector" data-exchange-connector></span>
          <div class="case-replacement-exchange__device case-replacement-exchange__device--candidate" data-exchange-candidate><span>Seleccionado</span><b data-exchange-candidate-name>Elige un equipo</b></div>
        </div>
        <p class="case-replacement-exchange__policy">${esc(info.label)} · ${esc(info.explanation)}</p>
      </div>
      <button class="btn btn-primary" type="submit" disabled>Registrar reemplazo</button>
    </form>
  </section>`
}

/* Vista decorativa del intercambio. El texto inmediato siempre procede de la
   selección real y la política persistida; esta escena nunca confirma un POST. */
export function createReplacementExchangeMotion({
  stage, original, candidate, candidateName, connector, summary, policyLabel,
  gsapApi = gsap, matchMedia = window.matchMedia.bind(window),
} = {}) {
  if (!stage) return { select() {}, clear() {}, dispose() {} }
  const media = matchMedia('(prefers-reduced-motion: reduce)')
  let tween = null
  let disposed = false
  const reset = () => {
    tween?.kill?.()
    tween = null
    gsapApi.set([original, candidate, connector], { clearProps: 'transform,opacity,visibility' })
  }
  const clear = () => {
    if (disposed) return
    reset()
    stage.dataset.state = 'empty'
    delete stage.dataset.selectedTerminal
    delete stage.dataset.selectedBrand
    delete stage.dataset.selectedModel
    if (candidateName) candidateName.textContent = 'Elige un equipo'
    if (summary) summary.textContent = 'Selecciona un equipo para ver el intercambio.'
  }
  const select = terminal => {
    reset()
    if (!terminal || disposed) { clear(); return }
    const name = [terminal.brand, terminal.model].filter(Boolean).join(' ') || 'Terminal sin detalle'
    stage.dataset.state = 'selected'
    if (candidateName) candidateName.textContent = name
    if (summary) summary.textContent = `Vista previa: ${name} · ${policyLabel || 'política registrada'}. Aún no se ha registrado el reemplazo.`
    if (media.matches) return
    const timeline = gsapApi.timeline({ defaults: { ease: 'power3.inOut' } })
    tween = timeline
    timeline.fromTo(original, { x: 0, rotationY: 0, opacity: 1 }, { x: -18, rotationY: -18, opacity: .72, duration: .34 }, 0)
      .fromTo(candidate, { x: 24, rotationY: 18, opacity: .48 }, { x: 0, rotationY: 0, opacity: 1, duration: .42 }, 0)
      .fromTo(connector, { scaleX: 0, opacity: 0, transformOrigin: 'left center' }, { scaleX: 1, opacity: 1, duration: .3 }, .12)
  }
  const onPreferenceChange = () => {
    if (media.matches) reset()
    else {
      const value = stage.dataset.selectedTerminal
      if (value) select({ brand: stage.dataset.selectedBrand, model: stage.dataset.selectedModel })
    }
  }
  media.addEventListener?.('change', onPreferenceChange)
  return {
    select(terminal) {
      if (disposed) return
      if (terminal) {
        stage.dataset.selectedTerminal = String(terminal.id)
        stage.dataset.selectedBrand = terminal.brand || ''
        stage.dataset.selectedModel = terminal.model || ''
      } else {
        delete stage.dataset.selectedTerminal
        delete stage.dataset.selectedBrand
        delete stage.dataset.selectedModel
      }
      select(terminal)
    },
    clear,
    dispose() {
      if (disposed) return
      disposed = true
      reset()
      media.removeEventListener?.('change', onPreferenceChange)
      stage.removeAttribute?.('data-state')
      delete stage.dataset.selectedTerminal
      delete stage.dataset.selectedBrand
      delete stage.dataset.selectedModel
    },
  }
}

export async function casesView(root, params) {
  if (!(await requireAuth(root))) return
  const q = params.get('q') || ''
  const status = params.get('status') || ''
  root.innerHTML = workShell('Casos', 'Seguimiento interno', '<div class="skel">Cargando casos…</div>')
  const main = root.querySelector('.work-main')
  main.classList.add('case-register')
  onLeave(() => {
    listRequests.delete(root)
    listAnimations.get(main)?.revert()
    listAnimations.delete(main)
  })
  buildList(root, q, status)
}

// These are visible-page counts, never workshop totals or simulated progress.
export function caseListCounts(cases = []) {
  const counts = new Map(CASE_STATES.map(state => [state, 0]))
  for (const item of cases) if (counts.has(item.status)) counts.set(item.status, counts.get(item.status) + 1)
  return counts
}

export function caseDocketMarkup(cases = []) {
  return cases.map(cs => {
    const device = cs.terminal_summary || [cs.terminal?.brand, cs.terminal?.model].filter(Boolean).join(' ') || 'Equipo sin detalle'
    const client = cs.client_name || cs.client?.full_name || 'Cliente sin detalle'
    return `<li class="case-docket" data-id="${esc(cs.id)}">
      <div class="case-docket__device" aria-hidden="true"><span></span><i></i></div>
      <div class="case-docket__identity"><a class="case-docket__link mono" href="#/cases/${encodeURIComponent(cs.id)}" aria-label="Abrir caso ${esc(cs.case_number)}">${esc(cs.case_number)}</a><span>${esc(device)}</span></div>
      <div class="case-docket__client"><span class="case-docket__label">Cliente</span><span>${esc(client)}</span></div>
      <div class="case-docket__state"><span class="case-docket__label">Estado</span>${pill(cs.status)}</div>
      <div class="case-docket__updated"><span class="case-docket__label">Actualizado</span><time${cs.updated_at && !Number.isNaN(new Date(cs.updated_at).getTime()) ? ` datetime="${esc(cs.updated_at)}"` : ''}>${fmtDate(cs.updated_at)}</time></div>
      <span class="case-docket__open" aria-hidden="true">↗</span>
    </li>`
  }).join('')
}

async function buildList(root, q, status, page = 1) {
  const requestId = (listRequests.get(root) || 0) + 1
  listRequests.set(root, requestId)
  const main = root.querySelector('.work-main')
  const isCurrent = () => listRequests.get(root) === requestId && main?.isConnected && root.contains(main)
  main.setAttribute('aria-busy', 'true')
  try {
    const qs = new URLSearchParams({ page: String(page), pageSize: '20' })
    if (q) qs.set('q', q)
    if (status) qs.set('status', status)
    const { data, meta } = await get('/cases?' + qs.toString())
    if (!isCurrent()) return
    const cases = data || []
    const counts = caseListCounts(cases)
    listAnimations.get(main)?.revert()
    main.innerHTML = `
      <header class="case-register__heading">
        <div class="case-register__assembly" aria-hidden="true"><span class="case-register__layer case-register__layer--base"></span><span class="case-register__layer case-register__layer--board"></span><span class="case-register__layer case-register__layer--glass"></span></div>
        <div><h1>Casos del taller</h1><p>Cada equipo, su reparación y la próxima decisión.</p></div>
        <a class="btn btn-primary" href="#/cases/new">Recibir un equipo</a>
      </header>
      <section class="case-register__controls" aria-label="Buscar y filtrar casos">
        <form data-search class="case-register__search">
          <label>Buscar caso<input name="q" value="${esc(q)}" placeholder="Número, cliente o IMEI" type="search"></label>
          <label>Estado<select name="status"><option value="">Todos los estados</option>${CASE_STATES.map(s => `<option value="${s}" ${s === status ? 'selected' : ''}>${stateLabel(s)}</option>`).join('')}</select></label>
          <button class="btn btn-ghost" type="submit">Filtrar</button>
          ${q || status ? '<a class="case-register__clear" href="#/cases">Limpiar filtros</a>' : ''}
        </form>
        <div class="case-register__states" aria-label="Estados de los casos en esta página">
          <p>En esta página <strong>${cases.length} casos</strong></p>
          <div>${CASE_STATES.filter(s => counts.get(s) > 0).map(s => `<button class="case-register__state" type="button" data-state="${s}" aria-pressed="${s === status}">${pill(s)}<strong>${counts.get(s)}</strong><span class="sr-only"> casos en esta página. Filtrar por este estado</span></button>`).join('')}</div>
        </div>
      </section>
      <section class="case-register__results" aria-label="Casos encontrados">
        <div class="case-register__legend" aria-hidden="true"><span>Equipo y número de caso</span><span>Cliente</span><span>Estado actual</span><span>Última actualización</span></div>
        ${cases.length ? `<ul class="case-dockets">${caseDocketMarkup(cases)}</ul>` : '<div class="case-register__empty"><h2>No hay casos para estos filtros</h2><p>Prueba otro número, cliente o estado para encontrar el equipo.</p><a class="btn btn-ghost" href="#/cases">Ver todos los casos</a></div>'}
        ${pagination(meta, page, 'casos')}
      </section>`
    main.querySelector('[data-search]').addEventListener('submit', ev => {
      ev.preventDefault()
      const f = new FormData(ev.target)
      location.hash = `#/cases?q=${encodeURIComponent(f.get('q'))}&status=${encodeURIComponent(f.get('status'))}`
    })
    main.querySelectorAll('[data-state]').forEach(button => button.addEventListener('click', () => {
      location.hash = `#/cases?q=${encodeURIComponent(q)}&status=${encodeURIComponent(button.dataset.state)}`
    }))
    bindPagination(main, nextPage => buildList(root, q, status, nextPage))
    main.querySelectorAll('.case-docket').forEach(row => row.addEventListener('click', ev => {
      if (ev.target.closest('a, button') || window.getSelection()?.toString()) return
      location.hash = '#/cases/' + encodeURIComponent(row.dataset.id)
    }))
    const motion = gsap.matchMedia()
    listAnimations.set(main, motion)
    motion.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from(main.querySelectorAll('.case-register__layer'), { y: 22, opacity: 0, stagger: .07, duration: .65, ease: 'power3.out', clearProps: 'all' })
      gsap.from(main.querySelectorAll('.case-docket'), { y: 9, opacity: 0, stagger: { amount: .2 }, duration: .3, ease: 'power2.out', clearProps: 'all' })
    })
  } catch (e) {
    if (!isCurrent()) return
    const error = `<div class="notice notice-error case-register__error" role="alert">${esc(e?.message || 'No se pudieron cargar los casos.')} <button class="btn btn-ghost" type="button" data-retry-cases>Reintentar</button></div>`
    const previousError = main.querySelector('.case-register__error')
    previousError?.remove()
    const loading = main.querySelector('.skel')
    if (loading) loading.outerHTML = error
    else main.insertAdjacentHTML('beforeend', error)
    main.querySelector('[data-retry-cases]').addEventListener('click', () => buildList(root, q, status, page))
  } finally {
    if (isCurrent()) main.removeAttribute('aria-busy')
  }
}

function pagination(meta, requestedPage, label) {
  if (!meta) return ''
  const page = Number(meta.page) || requestedPage
  const pageSize = Number(meta.pageSize) || 20
  const total = Number(meta.total) || 0
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = total ? (page - 1) * pageSize + 1 : 0
  const last = Math.min(page * pageSize, total)
  return `<nav class="row" aria-label="Paginación de ${label}" style="justify-content:space-between;gap:.75rem;align-items:center;margin-top:.8rem">
    <p data-page-status tabindex="-1" aria-live="polite" style="color:var(--ink-mute);margin:0">${first}–${last} de ${total} · página ${page} de ${pages}</p>
    <div class="row" style="gap:.5rem"><button class="btn btn-ghost" type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Página anterior de ${label}">← Anterior</button>
    <button class="btn btn-ghost" type="button" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Página siguiente de ${label}">Siguiente →</button></div>
  </nav>`
}

function bindPagination(main, onPage) {
  main.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', async () => {
    if (!button.disabled && main.getAttribute('aria-busy') !== 'true') {
      await onPage(Number(button.dataset.page))
      main.querySelector('[data-page-status]')?.focus()
    }
  }))
}

// ---------- Detalle ----------
export async function caseDetailView(root, params, id) {
  if (!(await requireAuth(root))) return
  root.innerHTML = workShell('Caso', 'Detalle interno', `<div class="skel">Cargando el caso…</div>`)
  const main = root.querySelector('.work-main')

  try {
    const { data: cs } = await get('/cases/' + id)
    if (!main.isConnected) return
    main.classList.add('case-detail')
    main.innerHTML = `
      <div class="spread">
        <div data-case-heading>
          <h1 class="mono" style="font-size:2rem">${esc(cs.case_number)}</h1>
          <span data-case-status>${pill(cs.status)} <span style="color:var(--ink-mute)">${esc(stateLabel(cs.status))}</span></span>
        </div>
        <button class="btn btn-ghost" data-back>← Volver a casos</button>
      </div>

      <div data-case-bench-wrap>${caseBenchMarkup(cs)}</div>

      <div class="split mt" data-case-flow-wrap>
        <div>
          <section class="panel"><h3>Cliente</h3>
            <dl class="kv">
              <dt>Nombre</dt><dd>${esc(cs.client?.full_name || '—')}</dd>
              <dt>Teléfono</dt><dd>${esc(cs.client?.phone || '—')}</dd>
              <dt>Documento</dt><dd>${esc(cs.client?.document_id || '—')}</dd>
            </dl>
          </section>
          <section class="panel"><h3>Terminal</h3>
            <dl class="kv">
              <dt>Marca / modelo</dt><dd>${esc(cs.terminal?.brand || '')} ${esc(cs.terminal?.model || '')}</dd>
              <dt>IMEI</dt><dd class="mono">${(cs.terminal?.imeis || []).map(esc).join('<br>') || '—'}</dd>
              <dt>Accesorios</dt><dd>${esc(cs.terminal?.accessories || '—')}</dd>
              <dt>Estado inicial</dt><dd>${esc(cs.terminal?.initial_condition || '—')}</dd>
            </dl>
          </section>
          <section class="panel"><h3>Problema reportado</h3><p>${esc(cs.reported_problem || '—')}</p></section>
        </div>
        <div>${caseFlowMarkup(cs.status, cs.history)}</div>
      </div>

      <div data-zone></div>
    `

    animateCaseFlow(main)
    wireBenchAnimate(main)
    mountCaseInspector(main, cs)
    onLeave(() => disposeCaseInspector(main))
    onLeave(() => caseAnimations.get(main)?.revert())
    onLeave(() => benchOpenAnimations.get(main)?.stop())
    main.querySelector('[data-back]').addEventListener('click', () => location.hash = '#/cases')
    main.addEventListener('click', event => {
      const jump = event.target.closest('[data-case-jump]')
      if (!jump) return
      const panel = main.querySelector(`[data-panel="${CSS.escape(jump.dataset.caseJump)}"]`)
      if (!panel) return
      const heading = panel.querySelector('h3')
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }) }
      panel.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' })
      animateUpdatedPanel(panel)
    })
    await renderZones(main.querySelector('[data-zone]'), cs, id)
  } catch (e) {
    disposeCaseInspector(main)
    main.innerHTML = `<div class="notice notice-error" role="alert">${esc(e?.message || 'No se pudo cargar el caso.')}</div>`
  }
}

function animateCaseFlow(main) {
  const flow = main.querySelector('.case-flow')
  if (!flow) return
  caseAnimations.get(main)?.revert()
  // El refresco reconstruye el banco: detiene una apertura breve en vuelo para no animar nodos huérfanos.
  benchOpenAnimations.get(main)?.stop()
  const media = gsap.matchMedia()
  caseAnimations.set(main, media)
  media.add('(prefers-reduced-motion: no-preference)', () => {
    const bench = main.querySelector('[data-case-bench]')
    const tl = gsap.timeline({ defaults: { duration: .5, ease: 'power3.out', clearProps: 'all' } })
    tl.from(bench.querySelector('.case-bench__assembly'), { y: 18, rotationZ: -8, autoAlpha: 0 }, 0)
      .from(bench.querySelectorAll('.case-bench__readout > *'), { y: 6, autoAlpha: 0, stagger: .045 }, .12)
      .from(flow.querySelectorAll('.case-flow__item'), { x: -7, autoAlpha: 0, duration: .3, stagger: .04 }, .2)
    if (['inspect', 'repair'].includes(bench.dataset.mode)) {
      tl.fromTo(bench.querySelector('.case-bench__scan'), { y: -25, opacity: 0 }, { y: 120, opacity: .65, duration: .65, clearProps: 'all' }, .15)
    }
  })
}

function animateUpdatedPanel(panel) {
  const media = gsap.matchMedia()
  media.add('(prefers-reduced-motion: no-preference)', () => {
    const ctx = gsap.context(() => {
      gsap.fromTo(panel, { autoAlpha: 0, y: 8 }, {
        autoAlpha: 1, y: 0, duration: .22, ease: 'power2.out', clearProps: 'all',
      })
    }, panel)
    return () => ctx.revert()
  })
  onLeave(() => media.revert())
}

// ---------- Apertura breve del banco al saltar a un panel ----------
/* El teléfono esquemático separa sus capas como al abrir un equipo y regresa a
   la posición que fija el modo del banco. Es solo presentación: no bloquea el
   salto ni cambia datos, cancela la apertura previa al repetirse y deja el
   mando al CSS al terminar. Dependencias inyectadas para poder probarlo. */
export function playBenchOpen({ bench, animate, isReduced, previous, onStore, resting } = {}) {
  previous?.stop?.()
  onStore?.(null)
  if (!bench?.isConnected || !animate || isReduced?.()) return null
  const layers = ([['.case-bench__screen', 46, -10], ['.case-bench__board', -16, 0], ['.case-bench__shell', -8, 0]]
    .map(([selector, dz, dy]) => ({ part: bench.querySelector(selector), dz, dy }))
    .filter(layer => layer.part))
  if (!layers.length) return null
  // La posición de reposo se captura una vez por banco: repetir el salto regresa
  // a la del modo actual, nunca a la de un vuelo interrumpido.
  const restingOf = resting ?? benchResting
  let base = restingOf.get(bench)
  if (!base) {
    base = new Map(layers.map(({ part }) => [part, {
      y: Number(animate.getProperty?.(part, 'y')) || 0,
      z: Number(animate.getProperty?.(part, 'z')) || 0,
    }]))
    restingOf.set(bench, base)
  }
  bench.classList?.add?.('is-brief-open')
  const leave = () => {
    bench.classList?.remove?.('is-brief-open')
    onStore?.(null)
  }
  const tl = animate.timeline({ defaults: { duration: .26, ease: 'power2.out', overwrite: 'auto' } })
  let at = 0
  for (const { part, dz, dy } of layers) {
    const from = base.get(part)
    tl.to(part, { z: from.z + dz, y: from.y + dy, duration: .26 }, at)
    tl.to(part, { z: from.z, y: from.y, duration: .3, ease: 'power3.inOut', clearProps: 'transform' }, .32 + at)
    at += .04
  }
  tl.eventCallback?.('onComplete', leave)
  // Al interrumpir el vuelo, el inline queda a mitad de camino; limpiarlo antes
  // de retirar la clase devuelve cada capa al transform que fija el modo en CSS,
  // para que una apertura repetida posterior o movimiento reducido no hereden
  // piezas desplazadas, y el retiro de la clase no genere un salto.
  const record = {
    tl,
    stop() {
      tl.kill()
      for (const { part } of layers) {
        const from = base.get(part)
        animate.set?.(part, { z: from.z, y: from.y, clearProps: 'transform' })
      }
      leave()
    },
  }
  onStore?.(record)
  return record
}

function animateBenchOpen(main) {
  playBenchOpen({
    bench: main.querySelector('[data-case-bench]'),
    animate: gsap,
    isReduced: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    previous: benchOpenAnimations.get(main),
    onStore: record => {
      if (record) benchOpenAnimations.set(main, record)
      else benchOpenAnimations.delete(main)
    },
  })
}

// ---------- Encuadre del banco al usar su mando en pantallas cortas ----------
/* En móvil el banco se apila: escena arriba, mando abajo. Al enfocar el botón
   el navegador desplaza solo lo justo para mostrar el mando y la escena queda
   fuera de la ventana, con el teléfono cortado por arriba. `block:'nearest'`
   reencuadra el banco completo solo cuando algo sale de la vista: sin mover la
   página si ya cabe y con el mínimo recorrido si no. El foco sigue llegando por
   teclado y con movimiento reducido el desplazamiento es instantáneo. */
export function reframeBench(bench, { reduced, act } = {}) {
  if (!bench?.isConnected) return false
  const move = bench.scrollIntoView?.bind?.(bench)
  if (!move) return false
  const schedule = act ?? (fn => requestAnimationFrame(fn))
  schedule(() => {
    if (!bench.isConnected) return
    move({ behavior: (typeof reduced === 'function' ? reduced() : reduced) ? 'auto' : 'smooth', block: 'nearest' })
  })
  return true
}

// ---------- Gesto del teléfono para desplegar el esquema ----------
/* La propia ilustración es el control: ratón, tacto, Enter y Espacio lanzan la
   misma apertura breve. Movimiento reducido conserva la interacción y explica
   que la escena queda estática. Cada cableado limpia sus listeners al salir. */
const benchAnimateBindings = new WeakMap()

export function wireBenchAnimate(main, { matchMedia } = {}) {
  const previous = benchAnimateBindings.get(main)
  previous?.dispose?.()
  benchAnimateBindings.delete(main)
  const bench = main.querySelector('[data-case-bench]')
  if (!bench?.isConnected) return
  const button = bench.querySelector('[data-bench-animate]')
  const hint = bench.querySelector('[data-bench-animate-hint]')
  if (!button || !hint) return
  const media = (matchMedia ?? window.matchMedia.bind(window))('(prefers-reduced-motion: reduce)')
  const applyPreference = () => {
    hint.textContent = media.matches
      ? 'Toca el teléfono para explorar sus capas; la animación está pausada por la preferencia de movimiento reducido.'
      : 'Toca el teléfono para ver cómo se abren sus capas.'
    if (media.matches) benchOpenAnimations.get(main)?.stop()
  }
  const onFocus = () => reframeBench(bench, { reduced: () => media.matches })
  const onClick = () => animateBenchOpen(main)
  applyPreference()
  media.addEventListener?.('change', applyPreference)
  button.addEventListener('focus', onFocus)
  button.addEventListener('click', onClick)
  const binding = {
    dispose() {
      media.removeEventListener?.('change', applyPreference)
      button.removeEventListener('focus', onFocus)
      button.removeEventListener('click', onClick)
    },
  }
  benchAnimateBindings.set(main, binding)
  onLeave(() => {
    if (benchAnimateBindings.get(main) !== binding) return
    binding.dispose()
    benchAnimateBindings.delete(main)
  })
}

async function renderZones(zone, cs, id, { showPaymentReceipt = false } = {}) {
  replacementMotionByZone.get(zone)?.()
  replacementMotionByZone.delete(zone)
  const main = zone.closest('.work-main')
  const status = cs.status
  const excludedReason = caseExcludedReason(cs)
  const isCancelled = status === 'cancelled'
  const role = session.user?.role
  const userId = session.user?.id
  const assignedTo = cs.technician?.id
  const canAssignTechnician = canAssignCaseTechnician({ role, status })
  const mayCancelCase = canCancelCase({ role, status })
  const mayDiagnose = canDiagnose({ role, status, assignedTo, userId, coverageOverride: cs.coverage_override === true })
  const mayAddAction = canAddCaseAction({ role, status, assignedTo, userId })
  const activeLoan = Boolean(cs.loan && !cs.loan.returned_at)
  const mayAssignLoan = canAssignCaseLoan({ role, status, assignedTo, userId, activeLoan })
  const mayReturnLoan = canReturnCaseLoan({ role, status, assignedTo, userId, activeLoan })
  const mayRegisterPayment = canRegisterCasePayment({ role, status, acceptedQuote: cs.quote?.status === 'accepted' })
  const showPaymentForm = shouldShowPaymentForm({ mayRegisterPayment, balance: cs.balance })
  const canManageCaseQuote = canManageQuote(session.user?.role)
  const mayIssueQuote = canIssueQuote({ role: session.user?.role, status, payments: cs.payments || [] })
  const transitionChoices = availableCaseTransitions({
    from: status,
    role,
    coverageEvaluated: cs.coverage_covered !== null && cs.coverage_covered !== undefined,
    covered: cs.coverage_covered === true,
    acceptedQuote: cs.quote?.status === 'accepted',
    paidCents: cs.paid_total_cents,
    quoteTotalCents: cs.quote?.total_cents,
    activeLoan,
  })
  const quoteStatusLabel = { pending: 'Pendiente de decisión', accepted: 'Aceptada', rejected: 'Rechazada', superseded: 'Reemplazada' }

  zone.innerHTML = `
    <h2 class="section-head">Gestión del caso</h2>
    <div class="grid2">
      ${canAssignTechnician ? `
      <div class="panel" data-panel="assignment"><h3>Asignación técnica</h3>
        <p>Asignado actualmente: <b>${esc(cs.technician?.full_name || 'Sin asignar')}</b></p>
        <form data-assignment data-draft-key="assignment">
          <div class="field"><label for="case-technician-${esc(id)}">Técnico activo</label>
            <select id="case-technician-${esc(id)}" name="technician_id" disabled><option value="">Cargando técnicos…</option></select></div>
          <button class="btn btn-ghost" type="submit" disabled>Guardar asignación</button>
        </form>
      </div>` : ''}
      <div class="panel" data-panel="diagnosis"><h3>Diagnóstico</h3>
        ${cs.diagnosis ? `<p>${esc(cs.diagnosis.text || cs.diagnosis)}</p><p style="color:var(--ink-mute)">Tipo de problema: ${esc(cs.diagnosis.problem_type || cs.problem_type || '—')}</p>${excludedReason ? `<p>Exclusión: ${esc(excludedReason)}</p>` : ''}${cs.coverage_override ? `<p>Excepción de cobertura: ${esc(cs.override_reason || 'Autorizada')}</p>` : ''}` : ''}
        ${role === 'technician' && cs.coverage_override === true ? '<p role="status">La excepción de cobertura está activa. Administración debe revisar el diagnóstico para conservarla.</p>' : ''}
        ${mayDiagnose ? `
          <form data-diagnosis data-draft-key="diagnosis">
            ${field('Diagnóstico', `<textarea name="diagnosis" required placeholder="Qué falla se detectó">${esc(cs.diagnosis?.text || '')}</textarea>`)}
            ${field('Tipo de problema', `<select name="problem_type">
              ${['hardware', 'software', 'both'].map(type => `<option value="${type}" ${type === (cs.diagnosis?.problem_type || cs.problem_type) ? 'selected' : ''}>${type === 'hardware' ? 'Hardware' : type === 'software' ? 'Software' : 'Hardware y software'}</option>`).join('')}</select>`)}
            ${field('Motivo de exclusión', `<input name="excluded_reason" maxlength="500" value="${esc(excludedReason)}" placeholder="Si aplica">`)}
            ${role === 'admin' ? `<div class="field"><label><input type="checkbox" name="coverage_override" ${cs.coverage_override ? 'checked' : ''}> Autorizar excepción de cobertura</label></div>${field('Motivo de excepción', `<input name="override_reason" maxlength="500" value="${esc(cs.override_reason || '')}" placeholder="Requerido para autorizar la excepción">`)}` : ''}
            <button class="btn btn-primary" type="submit">Registrar diagnóstico</button>
          </form>` : ''}
      </div>
      <div class="panel" data-panel="transition"><h3>Cambiar estado</h3>
        ${transitionChoices.length
          ? `<form data-transition data-draft-key="transition">${field('Estado destino', `<select name="status">
              ${transitionChoices.map(s => `<option value="${s}">${stateLabel(s)}</option>`).join('')}
              </select>`)}
             ${field('Nota', `<input name="note" placeholder="Por qué cambia el estado">`)}
             <button class="btn btn-primary" type="submit">Aplicar cambio</button></form>` : `<p style="color:var(--ink-mute)">${isCancelled ? 'Este caso está cancelado y no puede reabrirse.' : status === 'delivered' ? 'El caso ya fue entregado y no admite cambios de estado.' : 'No hay destinos disponibles según el estado y las reglas actuales del caso.'}</p>`}
        ${mayCancelCase ? `<form data-case-cancel data-draft-key="case-cancel" class="mt">
          <p role="note"><b>Cancelar el caso es irreversible.</b> El caso quedará cerrado y no podrá reabrirse.</p>
          ${field('Motivo obligatorio', `<input name="note" required minlength="1" maxlength="2000" placeholder="Por qué se cancela el caso">`)}
          <div class="field"><label><input type="checkbox" name="confirm_cancel" required> Confirmo que quiero cancelar este caso</label></div>
          <button class="btn btn-ghost" type="submit">Cancelar caso definitivamente</button>
        </form>` : ''}
      </div>
      <div class="panel" data-panel="actions"><h3>Acciones realizadas</h3>
        ${((cs.actions || []).length) ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Tabla de acciones realizadas"><table><tbody>
          ${(cs.actions || []).map(a => `<tr><td>${esc(a.description || '')}</td><td class="mono">${esc(Array.isArray(a.parts) ? a.parts.join(', ') : a.parts || '')}</td></tr>`).join('')}
        </tbody></table></div>` : '<p style="color:var(--ink-mute)">Sin acciones registradas.</p>'}
        ${mayAddAction ? `<form data-action data-draft-key="actions" class="mt" style="margin-top:1rem">
          ${field('Descripción', `<input name="description" required placeholder="Qué se trabajó">`)}
          ${field('Repuestos', `<input name="parts" placeholder="Separados por coma">`)}
          <button class="btn btn-ghost" type="submit">Registrar acción</button>
        </form>` : ''}
      </div>
      <div class="panel" data-panel="loan"><h3>Préstamo</h3>
        ${cs.loan ? `
          <dl class="kv"><dt>Equipo</dt><dd>${esc(cs.loan.device?.brand || cs.loan.brand || cs.loan.terminal_brand || '')} ${esc(cs.loan.device?.model || cs.loan.model || cs.loan.terminal_model || '')}</dd>
          <dt>Salida</dt><dd>${fmtDate(cs.loan.loaned_at)}</dd>
          <dt>Condición salida</dt><dd>${esc(cs.loan.condition_out || '—')}</dd>
          <dt>Devolución</dt><dd>${cs.loan.returned_at ? fmtDate(cs.loan.returned_at) : `<b style="color:var(--signal)">pendiente</b>`}</dd></dl>
          ${mayReturnLoan ? `
          <form data-loan-return data-draft-key="loan-return" class="mt" style="margin-top:1rem">
              ${field('Condición al devolver', `<input name="condition_in" required>`)}
              <button class="btn btn-ghost" type="submit">Registrar devolución</button>
            </form>` : ''}` : mayAssignLoan ? `
          <form data-loan data-draft-key="loan">
            <div class="field"><label for="loan-device-id">Equipo de préstamo</label><select id="loan-device-id" name="loan_device_id" required><option value="">Cargando…</option></select></div>
            ${field('Condición de salida', `<input name="condition_out" required placeholder="P. ej. sin rayones, con cargador">`)}
            <button class="btn btn-primary" type="submit">Entregar préstamo</button>
          </form>` : '<p style="color:var(--ink-mute)">No se puede asignar un préstamo en este estado o hay uno activo.</p>'}
      </div>
      <div class="panel" data-panel="quote"><h3>Cotización</h3>
        ${cs.quote ? `
          <p><b>Versión ${esc(cs.quote.version)}</b>${cs.quote.status ? ` · ${esc(quoteStatusLabel[cs.quote.status] || cs.quote.status)}` : ''}</p>
          <div class="table-wrap" tabindex="0" role="region" aria-label="Tabla de conceptos de cotización"><table>
            <thead><tr><th>Concepto</th><th>Cant.</th><th>Precio unit.</th><th>Sub.</th></tr></thead>
            <tbody>${(cs.quote.items || []).map(it => `
              <tr><td>${esc(it.description)}</td><td>${esc(it.quantity)}</td><td>${fmtMoney(it.unit_price)}</td>
              <td>${fmtMoney((Number(it.unit_price) || 0) * (Number(it.quantity) || 0))}</td></tr>`).join('')}
            </tbody></table></div>
          <p class="mt"><b>Total: ${fmtMoney(cs.quote.total)}</b></p>
          ${canManageCaseQuote && cs.quote.status === 'pending' ? `<form data-quote-decision class="mt" aria-label="Decidir versión ${esc(cs.quote.version)} de la cotización">
            <button class="btn btn-primary" type="submit" name="accepted" value="true">Aceptar cotización</button>
            <button class="btn btn-ghost" type="submit" name="accepted" value="false">Rechazar cotización</button>
          </form>` : ''}` : '<p style="color:var(--ink-mute)">Aún no hay cotizaciones.</p>'}
        ${mayIssueQuote ? `<form data-quote data-draft-key="quote" class="mt">
            ${cs.quote ? '<p>Emitir una cotización nueva crea la siguiente versión y reemplaza la pendiente o aceptada. El cliente deberá aceptar la nueva versión antes de continuar.</p>' : ''}
            <div class="field"><label for="quote-items-${esc(id)}">${cs.quote ? 'Conceptos de la nueva versión' : 'Conceptos'}</label><small id="quote-items-help-${esc(id)}">Un renglón por concepto: concepto | cantidad | precio</small>
            <textarea id="quote-items-${esc(id)}" name="items" aria-describedby="quote-items-help-${esc(id)}" rows="3" required placeholder="Pantalla | 1 | 45.50"></textarea></div>
            ${field('Nota', `<input name="note">`)}
            <button class="btn btn-primary" type="submit">${cs.quote ? 'Emitir nueva versión' : 'Emitir cotización'}</button>
          </form>` : canManageCaseQuote && ['diagnosing', 'awaiting_approval', 'awaiting_payment'].includes(status) && (cs.payments || []).length
            ? '<p role="status">No se puede emitir otra versión porque ya hay pagos registrados.</p>' : ''}
      </div>
      <div class="panel" data-panel="payment"><h3>Pagos</h3>
        ${((cs.payments || []).length) ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Tabla de pagos registrados"><table><tbody>
          ${(cs.payments || []).map(p => `<tr><td>${fmtMoney(p.amount)}</td><td>${esc(p.method)}</td><td class="mono">${esc(p.reference || '')}</td></tr>`).join('')}
        </tbody></table></div>` : '<p style="color:var(--ink-mute)">Sin pagos registrados.</p>'}
        ${casePaymentSummaryMarkup(cs.paid_total, cs.balance)}
        ${showPaymentForm ? `<form data-payment data-draft-key="payment" class="mt" style="margin-top:1rem">
          ${field('Importe', `<input name="amount" type="number" step="0.01" min="0.01" required>`)}
          <div class="field"><label for="payment-method">Método</label><select id="payment-method" name="method">
            <option value="cash">Efectivo</option><option value="card">Tarjeta</option><option value="transfer">Transferencia</option></select></div>
          ${field('Referencia', `<input name="reference">`)}
          <button class="btn btn-ghost" type="submit">Registrar pago</button>
        </form>` : mayRegisterPayment
          ? '<p role="status" style="color:var(--ink-mute)">El servidor confirma saldo cero; no hay pagos pendientes.</p>'
          : '<p style="color:var(--ink-mute)">Solo se registra pago con una cotización aceptada en estado pendiente de pago.</p>'}
      </div>
      <div class="panel" data-panel="coverage"><h3>Cobertura</h3>
        ${cs.coverage_evaluation ? `
          <p><b style="color:${cs.coverage_covered ? 'var(--st-ready)' : 'var(--signal)'}">${cs.coverage_covered ? 'Cubierto por plan' : 'Fuera de plan'}</b></p>
          ${cs.coverage_covered ? '<p style="color:var(--ink-mute)">La reparación puede pasar directamente a reparación sin cotización previa.</p>'
            : `<p style="color:var(--ink-mute)">Requiere cotización aceptada y pago completo antes de reparar.</p>`}`
        : `<p style="color:var(--ink-mute)">Aún sin evaluación: se genera al registrar el diagnóstico.</p>`}
      </div>
      ${caseReplacementPanelMarkup(cs, role, id)}
    </div>
    <p class="mt" style="color:var(--ink-mute)">Enlace de seguimiento del cliente: número y clave al crear el caso (se muestra una sola vez).</p>
  `

  const refresh = async (message, panelSelector, form, operationType = 'other') => {
    const { data: latest } = await get('/cases/' + id)
    if (!zone.isConnected) return
    // Snapshot after the request: typing in another form during the GET is kept.
    const drafts = [...zone.querySelectorAll('form')]
      .filter(candidate => candidate !== form)
      .map(candidate => ({ key: candidate.getAttribute('data-draft-key'), values: [...candidate.elements]
        .filter(control => control.name).map(control => [control.name, control.type === 'checkbox' ? control.checked : control.value]) }))
      .filter(draft => draft.key)
    disposeCaseInspector(main)
    main.querySelector('[data-case-status]').innerHTML = `${pill(latest.status)} <span style="color:var(--ink-mute)">${esc(stateLabel(latest.status))}</span>`
    main.querySelector('[data-case-bench-wrap]').innerHTML = caseBenchMarkup(latest)
    const flowWrap = main.querySelector('[data-case-flow-wrap] > div:last-child')
    if (flowWrap) flowWrap.innerHTML = caseFlowMarkup(latest.status, latest.history)
    animateCaseFlow(main)
    wireBenchAnimate(main)
    mountCaseInspector(main, latest)
    await renderZones(zone, latest, id, { showPaymentReceipt: operationType === 'payment' })
    for (const draft of drafts) {
      const candidate = zone.querySelector(`form[data-draft-key="${CSS.escape(draft.key)}"]`)
      for (const [name, value] of draft.values) {
        const control = candidate?.elements.namedItem(name)
        if (control && typeof value === 'boolean') {
          control.checked = value
          if (name === 'coverage_override') control.dispatchEvent(new Event('change', { bubbles: true }))
        }
        else if (control && name === 'terminal_id' && candidate.matches('[data-replacement]')) {
          restoreReplacementTerminalDraft(control, value)
        }
        else if (control) {
          if (name === 'technician_id') control.dataset.pendingTechnicianDraft = String(value)
          control.value = value
          if (name === 'technician_id') {
            const submit = candidate.querySelector('button[type="submit"]')
            if (submit) submit.disabled = control.disabled || !canSubmitTechnicianAssignment(value)
          }
        }
      }
    }
    flashOk(message)
    const panel = zone.querySelector(panelSelector)
    if (panel) {
      const heading = panel.querySelector('h3')
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }) }
      animateUpdatedPanel(panel)
    }
  }

  // A successful write is never repeated just because its following GET fails.
  let savedOperation = null
  let busy = false
  const runMutation = async (form, message, panelSelector, action, operationType = 'other') => {
    if (busy) return
    busy = true
    const focused = document.activeElement
    const button = form.querySelector('button[type="submit"]')
    const buttons = [...zone.querySelectorAll('button[type="submit"]')].map(node => [node, node.disabled])
    let feedback = form.querySelector('[data-operation-status]')
    if (!feedback) {
      feedback = document.createElement('p')
      feedback.className = 'case-operation-status'
      feedback.dataset.operationStatus = ''
      feedback.setAttribute('role', 'alert')
      form.append(feedback)
    }
    feedback.textContent = ''
    form.setAttribute('aria-busy', 'true')
    button?.classList.add('is-loading')
    buttons.forEach(([node]) => { node.disabled = true })
    try {
      const result = await completeCaseOperation({
        savedOperation,
        operationContext: { form, message, panelSelector },
        operationType,
        action,
        refresh: operation => refresh(operation.message, operation.panelSelector, operation.form, operation.operationType),
      })
      savedOperation = result.savedOperation
      if (result.error) throw result.error
    } catch (error) {
      if (!zone.isConnected) return
      feedback.textContent = savedOperation
        ? `La operación se guardó. Falta actualizar el expediente: ${error?.message || 'error de conexión'}.`
        : `${error?.message || 'No se pudo guardar.'} Tus datos se conservan; revisa e intenta de nuevo.`
      if (savedOperation) {
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.className = 'btn btn-ghost'
        retry.textContent = 'Actualizar expediente'
        retry.addEventListener('click', () => runMutation(form, message, panelSelector, action))
        feedback.append(document.createElement('br'), retry)
      }
      if (focused?.isConnected) focused.focus({ preventScroll: true })
    } finally {
      busy = false
      form.removeAttribute('aria-busy')
      button?.classList.remove('is-loading')
      buttons.forEach(([node, disabled]) => { node.disabled = disabled })
      if (feedback.textContent && focused?.isConnected) focused.focus({ preventScroll: true })
    }
  }

  const on = (sel, fn) => zone.querySelector(sel)?.addEventListener('submit', fn)

  const replacementForm = zone.querySelector('[data-replacement]')
  if (replacementForm) {
    const terminalSelect = replacementForm.elements.terminal_id
    const submit = replacementForm.querySelector('button[type="submit"]')
    const status = replacementForm.querySelector('[data-replacement-catalog-status]')
    const exchange = replacementForm.querySelector('[data-replacement-exchange]')
    const exchangeMotion = createReplacementExchangeMotion({
      stage: exchange,
      original: exchange?.querySelector('[data-exchange-original]'),
      candidate: exchange?.querySelector('[data-exchange-candidate]'),
      candidateName: exchange?.querySelector('[data-exchange-candidate-name]'),
      connector: exchange?.querySelector('[data-exchange-connector]'),
      summary: exchange?.querySelector('[data-exchange-summary]'),
      policyLabel: replacementPolicyInfo(cs.terminal.coverage.replacement_policy)?.label,
    })
    let eligibleChoices = []
    let catalogLoading = false
    const cleanupMotion = () => exchangeMotion.dispose()
    replacementMotionByZone.set(zone, cleanupMotion)
    onLeave(() => {
      if (replacementMotionByZone.get(zone) === cleanupMotion) replacementMotionByZone.delete(zone)
      cleanupMotion()
    })

    const loadReplacementCatalog = async () => {
      if (catalogLoading || !replacementForm.isConnected) return
      catalogLoading = true
      const valueBeforeLoad = terminalSelect.value
      terminalSelect.disabled = true
      submit.disabled = true
      exchangeMotion.clear()
      exchange.dataset.state = 'loading'
      terminalSelect.innerHTML = '<option value="">Cargando equipos…</option>'
      status.replaceChildren(document.createTextNode('Cargando equipos del cliente…'))
      try {
        if (!cs.client?.id) throw new Error('No se pudo identificar al cliente del caso.')
        const terminals = await loadAllPages(get, '/terminals', 100, { client_id: cs.client.id })
        if (!zone.isConnected || !replacementForm.isConnected) return
        const choices = replacementTerminalChoices(terminals, cs.client.id, cs.terminal?.id)
        eligibleChoices = choices
        const selectedValue = replacementTerminalSelection(
          choices,
          terminalSelect.dataset.pendingReplacementDraft,
          valueBeforeLoad,
        )
        delete terminalSelect.dataset.pendingReplacementDraft
        terminalSelect.innerHTML = `<option value="">Elegir equipo…</option>${choices
          .map(terminal => `<option value="${esc(terminal.id)}">${esc([terminal.brand, terminal.model].filter(Boolean).join(' '))} — IMEI ${esc(terminal.imeis?.[0] || '—')}</option>`).join('')}`
        if (!choices.length) {
          exchange.dataset.state = 'empty'
          terminalSelect.options[0].textContent = 'No hay otros equipos registrados'
          status.textContent = 'Registra otro terminal para este cliente antes de continuar.'
          submit.disabled = true
          return
        }
        terminalSelect.value = selectedValue
        terminalSelect.disabled = false
        submit.disabled = !terminalSelect.value
        const selected = choices.find(terminal => String(terminal.id) === String(terminalSelect.value))
        exchangeMotion.select(selected)
        status.textContent = `Se muestran ${choices.length} equipo${choices.length === 1 ? '' : 's'} del cliente, sin incluir el terminal original.`
      } catch (error) {
        if (!zone.isConnected || !replacementForm.isConnected) return
        terminalSelect.innerHTML = '<option value="">No se pudo cargar el catálogo</option>'
        eligibleChoices = []
        exchangeMotion.clear()
        exchange.dataset.state = 'error'
        status.replaceChildren(document.createTextNode(`No se pudo cargar el catálogo: ${error?.message || 'error de conexión'} `))
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.className = 'btn btn-ghost'
        retry.textContent = 'Reintentar carga'
        retry.addEventListener('click', () => loadReplacementCatalog())
        status.append(retry)
      } finally {
        catalogLoading = false
      }
    }

    terminalSelect.addEventListener('change', () => {
      const selected = eligibleChoices.find(terminal => String(terminal.id) === String(terminalSelect.value))
      submit.disabled = !selected
      exchangeMotion.select(selected)
    })
    on('[data-replacement]', event => {
      event.preventDefault()
      if (!terminalSelect.value) {
        terminalSelect.focus()
        return
      }
      const form = event.target
      const payload = {
        terminal_id: Number(terminalSelect.value),
        policy: cs.terminal.coverage.replacement_policy,
      }
      runMutation(form, 'Reemplazo registrado.', '[data-panel="replacement"]', () =>
        post(`/cases/${id}/replacement`, payload))
    })

    void loadReplacementCatalog()
  }

  const diagnosisForm = zone.querySelector('[data-diagnosis]')
  const coverageOverride = diagnosisForm?.elements.coverage_override
  const overrideReason = diagnosisForm?.elements.override_reason
  if (coverageOverride && overrideReason) {
    const updateOverrideRequirement = () => { overrideReason.required = coverageOverride.checked }
    coverageOverride.addEventListener('change', updateOverrideRequirement)
    updateOverrideRequirement()
  }

  const assignmentForm = zone.querySelector('[data-assignment]')
  if (assignmentForm) {
    const select = assignmentForm.elements.technician_id
    const save = assignmentForm.querySelector('button[type="submit"]')
    select.addEventListener('change', () => {
      delete select.dataset.pendingTechnicianDraft
      save.disabled = !canSubmitTechnicianAssignment(select.value)
    })
    on('[data-assignment]', ev => {
      ev.preventDefault()
      const technicianId = ev.target.elements.technician_id.value
      if (!canSubmitTechnicianAssignment(technicianId)) {
        ev.target.elements.technician_id.focus()
        return
      }
      runMutation(ev.target, 'Asignación actualizada.', '[data-panel="assignment"]', () =>
        patch(`/cases/${id}`, { technician_id: technicianId ? Number(technicianId) : null }))
    })

    const loadTechnicianOptions = async () => {
      select.disabled = true
      save.disabled = true
      try {
        const technicians = await loadAllPages(get, '/technicians')
        if (!zone.isConnected || !assignmentForm.isConnected) return
        // Draft values are stashed because the select may not have that option yet.
        const hasPendingDraft = Object.hasOwn(select.dataset, 'pendingTechnicianDraft')
        const previousValue = hasPendingDraft ? select.dataset.pendingTechnicianDraft : select.value
        const selectedValue = preferredTechnicianSelection({
          technicians,
          currentTechnician: cs.technician,
          previousValue,
          preserveDraft: hasPendingDraft,
        })
        const selectedIsActive = technicians.some(technician => String(technician.id) === String(cs.technician?.id))
        const unavailableDraft = hasPendingDraft && previousValue !== '' && selectedValue === UNAVAILABLE_TECHNICIAN
        const currentOption = unavailableDraft || (cs.technician && !selectedIsActive)
          ? `<option value="${UNAVAILABLE_TECHNICIAN}" disabled selected>${unavailableDraft ? 'La selección guardada no está disponible' : `${esc(cs.technician.full_name)} (no disponible)`}</option>`
          : ''
        select.innerHTML = `${currentOption}<option value="">Sin asignar</option>${technicians
          .map(technician => `<option value="${esc(technician.id)}">${esc(technician.full_name)}</option>`).join('')}`
        select.value = selectedValue
        delete select.dataset.pendingTechnicianDraft
        select.disabled = false
        save.disabled = !canSubmitTechnicianAssignment(select.value)
        assignmentForm.querySelector('[data-technician-error]')?.remove()
      } catch (error) {
        if (!zone.isConnected || !assignmentForm.isConnected) return
        select.innerHTML = '<option value="">No se pudo cargar el catálogo</option>'
        const message = document.createElement('div')
        message.className = 'notice notice-error'
        message.dataset.technicianError = ''
        message.setAttribute('role', 'alert')
        const description = document.createElement('p')
        description.textContent = `No se pudo cargar el catálogo de técnicos: ${error?.message || 'error de conexión'}`
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.className = 'btn btn-ghost'
        retry.textContent = 'Reintentar carga'
        retry.addEventListener('click', () => loadTechnicianOptions())
        message.append(description, retry)
        assignmentForm.append(message)
      }
    }

    void loadTechnicianOptions()
  }

  on('[data-diagnosis]', ev => {
    ev.preventDefault()
    const f = new FormData(ev.target)
    runMutation(ev.target, 'Diagnóstico registrado.', '[data-panel="diagnosis"]', () => post(`/cases/${id}/diagnosis`, {
      diagnosis: f.get('diagnosis'),
      problem_type: f.get('problem_type'),
      excluded_reason: f.get('excluded_reason') || undefined,
      ...(f.get('coverage_override') === 'on' ? { coverage_override: true, override_reason: f.get('override_reason') || undefined } : {}),
    }))
  })

  on('[data-transition]', ev => {
    ev.preventDefault()
    const f = new FormData(ev.target)
    runMutation(ev.target, 'Estado actualizado.', '[data-panel="transition"]', () => post(`/cases/${id}/transition`, { status: f.get('status'), note: f.get('note') || undefined }))
  })

  on('[data-case-cancel]', ev => {
    ev.preventDefault()
    const f = new FormData(ev.target)
    const note = String(f.get('note') || '').trim()
    if (!note) {
      const input = ev.target.elements.note
      input.setCustomValidity('Escribe el motivo de cancelación.')
      input.reportValidity()
      input.focus()
      return
    }
    if (f.get('confirm_cancel') !== 'on') return
    runMutation(ev.target, 'Caso cancelado.', '[data-panel="transition"]', () => post(`/cases/${id}/transition`, { status: 'cancelled', note }))
  })
  zone.querySelector('[data-case-cancel] [name="note"]')?.addEventListener('input', event => event.currentTarget.setCustomValidity(''))

  on('[data-action]', ev => {
    ev.preventDefault()
    const f = new FormData(ev.target)
    runMutation(ev.target, 'Acción registrada.', '[data-panel="actions"]', () => post(`/cases/${id}/actions`, {
        description: f.get('description'),
        parts: String(f.get('parts') || '').split(',').map(s => s.trim()).filter(Boolean),
      }))
  })

  on('[data-quote]', ev => {
    ev.preventDefault()
    const raw = String(ev.target.querySelector('[name=items]').value || '')
    const items = raw.split('\n').map(l => l.split('|').map(s => s.trim()))
      .filter(p => p[0]).map(p => ({ description: p[0], quantity: Number(p[1] || 1), unit_price: p[2] || '0' }))
    if (!items.length) { flashError('Agrega al menos un concepto con el formato concepto | cantidad | precio.'); return }
    runMutation(ev.target, 'Cotización emitida.', '[data-panel="quote"]', () => post(`/cases/${id}/quote`, { items, note: ev.target.querySelector('[name=note]').value || undefined }))
  })

  on('[data-quote-decision]', ev => {
    ev.preventDefault()
    const accepted = parseQuoteDecision(ev.submitter?.value)
    if (accepted === null) {
      flashError('Selecciona aceptar o rechazar la cotización.')
      return
    }
    runMutation(ev.target, `Cotización ${accepted ? 'aceptada' : 'rechazada'}.`, '[data-panel="quote"]', () =>
      post(`/cases/${id}/quote/decision`, { accepted }))
  })

  let paymentAttempt = null
  on('[data-payment]', ev => {
    ev.preventDefault()
    const f = new FormData(ev.target)
    const payload = { amount: f.get('amount'), method: f.get('method'), reference: f.get('reference') || undefined }
    const fingerprint = JSON.stringify(payload)
    if (paymentAttempt?.fingerprint !== fingerprint) paymentAttempt = { fingerprint, key: crypto.randomUUID() }
    runMutation(ev.target, 'Pago registrado.', '[data-panel="payment"]', () => post(`/cases/${id}/payments`, {
        ...payload,
        idempotency_key: paymentAttempt.key,
      }), 'payment')
  })

  // Préstamos: poblar equipos reales y registrar entrega/devolución.
  const loanForm = zone.querySelector('[data-loan]')
  if (loanForm) {
    try {
      const devices = await loadAllPages(get, '/loan-devices')
      const available = availableLoanDevices(devices)
      const sel = loanForm.querySelector('[name=loan_device_id]')
      sel.innerHTML = '<option value="">Elegir equipo disponible…</option>' + available
        .map(device => `<option value="${esc(device.id)}">${esc(loanDeviceOptionLabel(device))}</option>`).join('')
      if (!available.length) {
        sel.options[0].textContent = 'Sin equipos disponibles'
        sel.disabled = true
        loanForm.querySelector('button[type="submit"]').disabled = true
      }
    } catch (e) {
      loanForm.querySelector('select[name=loan_device_id]').innerHTML = `<option value="">No disponible: ${esc(e?.message || '')}</option>`
      loanForm.querySelector('select[name=loan_device_id]').disabled = true
      loanForm.querySelector('button').disabled = true
    }
    on('[data-loan]', ev => {
      ev.preventDefault()
      const f = new FormData(ev.target)
      runMutation(ev.target, 'Préstamo entregado.', '[data-panel="loan"]', () => post(`/cases/${id}/loan`, { loan_device_id: f.get('loan_device_id'), condition_out: f.get('condition_out') }))
    })
  }

  on('[data-loan-return]', ev => {
    ev.preventDefault()
    const f = new FormData(ev.target)
    runMutation(ev.target, 'Devolución registrada.', '[data-panel="loan"]', () => post(`/cases/${id}/loan/return`, { condition_in: f.get('condition_in') }))
  })

  // Add the decorative seal only after every asynchronous zone renderer has
  // completed; a renderer failure must not leave a visible confirmation.
  if (showPaymentReceipt && zone.isConnected) {
    const summary = zone.querySelector('[data-panel="payment"] [data-payment-summary]')
    if (summary) {
      const stamp = document.createElement('span')
      stamp.className = 'case-payment-stamp'
      stamp.setAttribute('aria-hidden', 'true')
      stamp.textContent = 'PAGO REGISTRADO'
      summary.append(stamp)
    }
  }
}
