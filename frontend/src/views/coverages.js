// Coberturas: listado, alta y edición (admin/recepción).
import { get, post, patch } from '../api.js'
import { esc } from '../util.js'
import { workShell, requireAuth } from '../layout/work.js'
import { field } from '../ui.js'
import gsap from 'gsap'
import '../styles/access-plans.css'
import '../styles/coverage-policy-motion.css'

export function coverageListSummary(plans) {
  return {
    active: plans.filter(plan => plan.active !== false).length,
    global: plans.filter(plan => plan.brand == null || String(plan.brand).trim() === '').length,
    total: plans.length,
  }
}

// Etiquetas de la política de reemplazo según el valor de la API.
// continue: se mantiene la cobertura existente del equipo.
// new: se crea una cobertura nueva con el mismo plan y plazo.
export function replacementPolicyLabel(policy) {
  if (policy === 'continue') return 'Continuar cobertura existente'
  if (policy === 'new') return 'Nueva cobertura con mismo plan y plazo'
  return null
}

const COVERAGES_PAGE_SIZE = 100
const pendingCoveragePageReads = new WeakSet()
const coverageTabMotions = new WeakMap()

export function createCoverageTabMotion(tab, {
  gsapApi = gsap,
  mediaQuery = globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)') || null,
  documentRef = globalThis.document,
  onCleanup = () => {},
} = {}) {
  let target = tab
  let tween = null
  let detachedTab = null
  let closing = false
  let disposed = false
  const finalState = { x: 0, y: 0, scaleY: 1, opacity: 1, clearProps: 'transform,opacity' }
  const reduceMotion = () => Boolean(mediaQuery?.matches)
  const clearTween = () => {
    tween?.kill?.()
    tween = null
  }
  const cleanup = () => {
    if (disposed) return
    disposed = true
    clearTween()
    gsapApi.set(tab, { clearProps: 'transform,opacity' })
    if (detachedTab) {
      gsapApi.set(detachedTab, { clearProps: 'transform,opacity' })
      detachedTab.remove?.()
      detachedTab = null
    }
    if (mediaQuery?.removeEventListener) mediaQuery.removeEventListener('change', onMotionPreferenceChange)
    else mediaQuery?.removeListener?.(onMotionPreferenceChange)
    onCleanup()
  }
  const onMotionPreferenceChange = event => {
    if (!event.matches || disposed) return
    clearTween()
    if (closing) cleanup()
    else gsapApi.set(tab, finalState)
  }
  if (mediaQuery?.addEventListener) mediaQuery.addEventListener('change', onMotionPreferenceChange)
  else mediaQuery?.addListener?.(onMotionPreferenceChange)

  return {
    reveal() {
      if (disposed) return
      if (reduceMotion()) {
        gsapApi.set(tab, finalState)
        return
      }
      clearTween()
      tween = gsapApi.fromTo(tab,
        { y: -12, scaleY: .55, opacity: .2, transformOrigin: 'top center' },
        { ...finalState, duration: .3, ease: 'power3.out', immediateRender: true },
      )
    },
    retract() {
      if (disposed) return
      clearTween()
      if (reduceMotion() || !tab.isConnected || !documentRef?.body) {
        cleanup()
        return
      }
      const rect = tab.getBoundingClientRect()
      detachedTab = tab.cloneNode(true)
      detachedTab.setAttribute?.('aria-hidden', 'true')
      Object.assign(detachedTab.style, {
        position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`, margin: '0',
        zIndex: '1000', pointerEvents: 'none', transformOrigin: 'top center',
      })
      documentRef.body.appendChild(detachedTab)
      target = detachedTab
      closing = true
      tween = gsapApi.to(target, {
        y: -10, scaleY: .55, opacity: 0, duration: .2, ease: 'power2.in',
        onComplete: cleanup,
      })
    },
    cleanup,
  }
}

function cleanupCoverageTabMotion(root) {
  const entry = coverageTabMotions.get(root)
  if (!entry) return
  coverageTabMotions.delete(root)
  entry.observer?.disconnect()
  entry.motion.cleanup()
}

function installCoverageTabMotion(root, main, tab) {
  cleanupCoverageTabMotion(root)
  let observer = null
  const motion = createCoverageTabMotion(tab, {
    onCleanup: () => {
      observer?.disconnect()
      if (coverageTabMotions.get(root)?.motion === motion) coverageTabMotions.delete(root)
    },
  })
  if (globalThis.MutationObserver && globalThis.document?.body) {
    observer = new MutationObserver(() => {
      if (!main.isConnected) cleanupCoverageTabMotion(root)
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }
  coverageTabMotions.set(root, { motion, observer })
  motion.reveal()
  return motion
}

export function coveragePagination(meta, requestedPage, itemCount, pageSize = COVERAGES_PAGE_SIZE) {
  const page = Math.max(1, Number(meta?.page) || requestedPage)
  const totalValue = Number(meta?.total)
  const total = meta?.total !== null && meta?.total !== undefined && Number.isFinite(totalValue) && totalValue >= 0
    ? totalValue
    : null
  const responsePageSize = Number(meta?.pageSize)
  const resolvedPageSize = Number.isInteger(responsePageSize) && responsePageSize > 0 ? responsePageSize : pageSize
  const pages = total === null ? null : Math.max(1, Math.ceil(total / resolvedPageSize))
  const first = total === null ? null : total ? (page - 1) * resolvedPageSize + 1 : 0
  const last = total === null ? null : Math.min(page * resolvedPageSize, total)
  return {
    page,
    pages,
    total,
    first,
    last,
    canPrevious: page > 1,
    canNext: pages === null ? itemCount >= resolvedPageSize : page < pages,
    status: pages === null
      ? `Página ${page} · total desconocido`
      : `${first}–${last} de ${total} planes · página ${page} de ${pages}`,
  }
}

export async function loadCoveragePage(request = get, page = 1) {
  const requestedPage = Math.max(1, Math.floor(Number(page) || 1))
  const response = await request(`/coverages?page=${requestedPage}&pageSize=${COVERAGES_PAGE_SIZE}`)
  const data = Array.isArray(response?.data) ? response.data : []
  return {
    data,
    meta: response?.meta ?? null,
    pagination: coveragePagination(response?.meta, requestedPage, data.length),
  }
}

export function createCoveragePager(request = get) {
  let currentPage = 1
  return {
    load: async page => {
      const result = await loadCoveragePage(request, page)
      currentPage = result.pagination.page
      return result
    },
    refresh: () => loadCoveragePage(request, currentPage),
    get currentPage() { return currentPage },
  }
}

export function setCoverageNavigationBusy(main, busy, pagination, allowActionsWhileForm = false) {
  const formOpen = Boolean(main.querySelector('[data-newform] form'))
  main.querySelectorAll('[data-new], [data-edit]').forEach(button => { button.disabled = busy || (formOpen && !allowActionsWhileForm) })
  const previous = main.querySelector('[data-page][aria-label="Página anterior de coberturas"]')
  const next = main.querySelector('[data-page][aria-label="Página siguiente de coberturas"]')
  if (previous) previous.disabled = busy || formOpen || !pagination?.canPrevious
  if (next) next.disabled = busy || formOpen || !pagination?.canNext
  main.querySelectorAll('[data-retry-page]').forEach(button => { button.disabled = busy || formOpen })
}

export function coveragePageResponseCanRender(main) {
  return Boolean(main?.isConnected && !main.querySelector('[data-newform] form'))
}

export async function retrySavedCoverageRefresh(main, pager, pagination, onSuccess, onFailure) {
  setCoverageNavigationBusy(main, true, pagination)
  let rendered = false
  try {
    const result = await pager.refresh()
    if (!main.isConnected) return false
    onSuccess(result)
    rendered = true
    return true
  } catch (error) {
    if (main.isConnected) onFailure(error)
    return false
  } finally {
    if (!rendered && main.isConnected) setCoverageNavigationBusy(main, false, pagination)
  }
}

export function focusCoverageReturnTarget(main, focusId = null) {
  const editTarget = focusId == null
    ? null
    : [...main.querySelectorAll('[data-edit]')].find(button => button.dataset.edit === String(focusId))
  const target = editTarget || main.querySelector('[data-new]') || main.querySelector('[data-page-status]')
  target?.focus()
  return target || null
}

// Copia visible de la vista previa. No describe fechas, equipos ni guardado.
const POLICY_PREVIEW_COPY = {
  continue: {
    title: 'Se mantiene la cobertura existente',
    body: 'El equipo sigue con la cobertura que ya tiene; no se crea otra.',
  },
  new: {
    title: 'Se crea una cobertura nueva',
    body: 'Se crea otra cobertura con el mismo plan y los mismos meses de vigencia.',
  },
}

function coveragePolicyPreview(initial) {
  const policy = initial === 'new' ? 'new' : 'continue'
  const copy = POLICY_PREVIEW_COPY[policy]
  return `
    <div class="coverage-policy" data-policy-preview data-policy="${policy}">
      <figure class="coverage-policy-figure" aria-hidden="true">
        <svg class="coverage-policy-svg" viewBox="0 0 304 166" role="presentation" focusable="false">
          <g class="cp-phone">
            <rect class="cp-phone-shell" x="16" y="38" width="58" height="100" rx="13"></rect>
            <rect class="cp-phone-screen" x="22" y="46" width="46" height="80" rx="8"></rect>
            <rect class="cp-phone-detail" x="38" y="42" width="14" height="2.6" rx="1.3"></rect>
            <rect class="cp-phone-detail" x="36" y="131" width="18" height="2.6" rx="1.3"></rect>
            <text class="cp-label" x="45" y="155" text-anchor="middle">Equipo</text>
          </g>
          <path class="cp-rail" d="M74 87 H102"></path>
          <path class="cp-loop" pathLength="1" d="M76 87 C 76 113, 100 113, 100 87"></path>
          <g class="cp-token cp-token--a">
            <text class="cp-label" x="141" y="55" text-anchor="middle">Existente</text>
            <rect class="cp-token-card" x="102" y="62" width="78" height="50" rx="10"></rect>
            <g class="cp-bars">
              <rect x="114" y="74" width="38" height="5" rx="2.5"></rect>
              <rect x="114" y="85" width="26" height="5" rx="2.5"></rect>
              <rect x="114" y="96" width="46" height="5" rx="2.5"></rect>
            </g>
            <g class="cp-seal">
              <circle cx="172" cy="103" r="8.5"></circle>
              <path d="M168 103 l3 3 5 -6.5"></path>
            </g>
          </g>
          <g class="cp-connector">
            <path class="cp-connector-line" d="M180 87 H210"></path>
            <path class="cp-connector-line" d="M203 83 L208 87 L203 91"></path>
          </g>
          <g class="cp-token cp-token--b">
            <text class="cp-label" x="249" y="55" text-anchor="middle">Nueva</text>
            <rect class="cp-token-card" x="210" y="62" width="78" height="50" rx="10"></rect>
            <g class="cp-bars">
              <rect x="222" y="74" width="38" height="5" rx="2.5"></rect>
              <rect x="222" y="85" width="26" height="5" rx="2.5"></rect>
              <rect x="222" y="96" width="46" height="5" rx="2.5"></rect>
            </g>
          </g>
        </svg>
      </figure>
      <div class="coverage-policy-copy">
        <p class="coverage-policy-kicker">Vista previa ilustrativa</p>
        <h3 class="coverage-policy-title" data-policy-title>${copy.title}</h3>
        <p class="coverage-policy-body" data-policy-body role="status" aria-live="polite" aria-atomic="true">${copy.body}</p>
        <p class="coverage-policy-note">La ilustración refleja la política elegida; no registra ni confirma el guardado del plan.</p>
      </div>
    </div>`
}

export async function coveragesView(root) {
  cleanupCoverageTabMotion(root)
  if (!(await requireAuth(root))) return
  root.innerHTML = workShell('Coberturas', 'Planes de cobertura', `<div class="skel" role="status" aria-live="polite">Cargando planes…</div>`)
  const main = root.querySelector('.work-main')

  const pager = createCoveragePager()
  try {
    const result = await pager.load(1)
    if (main.isConnected) renderList(main, result, root, pager)
  } catch (e) {
    if (!main.isConnected) return
    const retryInitialLoad = async error => {
      main.innerHTML = `<div class="notice notice-error" role="alert"><p>${esc(error?.message || 'No se pudieron cargar las coberturas.')}</p><button class="btn btn-ghost" type="button" data-retry-coverages>Reintentar lectura</button></div>`
      main.querySelector('[data-retry-coverages]')?.addEventListener('click', async () => {
        const retry = main.querySelector('[data-retry-coverages]')
        if (!retry || retry.disabled) return
        retry.disabled = true
        retry.textContent = 'Cargando…'
        try {
          const result = await pager.load(1)
          if (coveragePageResponseCanRender(main)) renderList(main, result, root, pager)
        } catch (retryError) {
          if (main.isConnected) retryInitialLoad(retryError)
        }
      })
    }
    retryInitialLoad(e)
    return
  }

}

function renderList(main, result, root, pager, { restoreFocus = false, focusId = null } = {}) {
  cleanupCoverageTabMotion(root)
  const { data, pagination } = result
  const summary = coverageListSummary(data)
  main.classList.add('access-plans')
  main.innerHTML = `
    <header class="access-plans-heading"><div><h1>Coberturas</h1><p>Consulta vigencia, marca y política de los planes del taller.</p></div><button class="btn btn-primary" type="button" data-new>Registrar plan</button></header>
    <section class="access-roster" aria-label="Resumen de planes mostrados">
      <div class="access-role"><span class="access-role-glyph" aria-hidden="true">◇</span><div><h2>Catálogo consultado</h2><p><strong>${summary.total}</strong> planes mostrados</p></div></div>
      <div class="access-role"><span class="access-role-glyph" aria-hidden="true">✓</span><div><h2>Planes activos</h2><p><strong>${summary.active}</strong> en esta lista</p></div></div>
      <div class="access-role"><span class="access-role-glyph" aria-hidden="true">◎</span><div><h2>Todas las marcas</h2><p><strong>${summary.global}</strong> planes en esta lista</p></div></div>
    </section>
    <div data-newform></div>
    ${restoreFocus ? '<p class="notice notice-info" role="status">Plan de cobertura guardado.</p>' : ''}
    <p id="coverage-scroll-help" class="coverage-scroll-help">Desliza la tabla horizontalmente para consultar todas las columnas. Con teclado, enfoca la tabla y usa las flechas.</p>
    <div class="table-wrap mt coverage-table" tabindex="0" role="region" aria-label="Tabla de coberturas" aria-describedby="coverage-scroll-help"><table>
      <colgroup><col class="coverage-name-col"><col class="coverage-brand-col"><col class="coverage-plan-col"><col class="coverage-months-col"><col class="coverage-policy-col"><col class="coverage-action-col"></colgroup>
      <thead><tr><th scope="col">Nombre</th><th scope="col">Marca</th><th scope="col">Plan</th><th scope="col">Vigencia</th><th scope="col">Reemplazo</th><th scope="col">Acciones</th></tr></thead>
      <tbody>${data.map(c => `
        <tr>
          <td><span class="access-plan-name">${esc(c.name || '—')}</span><span class="access-plan-status">${c.active === false ? 'Inactivo' : 'Activo'}</span></td>
          <td>${esc(c.brand || 'Todas')}</td>
          <td>${esc(c.plan || '—')}</td>
          <td><span class="access-duration"><strong>${esc(c.months ?? '—')}</strong> meses</span></td>
          <td>${replacementPolicyLabel(c.replacement_policy) ?? esc(c.replacement_policy || '—')}</td>
          <td><button class="btn btn-ghost" type="button" data-edit="${esc(c.id)}" aria-label="Editar cobertura ${esc(c.name || c.plan || '')}">Editar</button></td>
        </tr>`).join('') || '<tr><td colspan="6" style="color:var(--ink-mute)">Sin planes registrados.</td></tr>'}
      </tbody></table></div>
    <nav class="row coverage-pagination" aria-label="Paginación de coberturas" style="justify-content:space-between;gap:.75rem;align-items:center;flex-wrap:wrap;margin-top:.8rem">
      <p data-page-status tabindex="-1" aria-live="polite" style="color:var(--ink-mute);margin:0">${esc(pagination.status)}</p>
      <div class="row" style="gap:.5rem"><button class="btn btn-ghost" type="button" data-page="${pagination.page - 1}" ${pagination.canPrevious ? '' : 'disabled'} aria-label="Página anterior de coberturas">← Anterior</button>
      <button class="btn btn-ghost" type="button" data-page="${pagination.page + 1}" ${pagination.canNext ? '' : 'disabled'} aria-label="Página siguiente de coberturas">Siguiente →</button></div>
    </nav><div data-pagination-error></div>`

  main.querySelector('[data-new]').addEventListener('click', event => showForm(main, null, data, root, pager, pagination, event.currentTarget))
  main.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => {
    const selected = data.find(c => String(c.id) === button.dataset.edit)
    if (selected) showForm(main, selected, data, root, pager, pagination, button)
  }))
  main.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', async () => {
    const form = main.querySelector('[data-newform] form')
    if (button.disabled || form) return
    await changePage(main, root, pager, Number(button.dataset.page), true, pagination)
  }))
  if (restoreFocus) focusCoverageReturnTarget(main, focusId)
}

async function changePage(main, root, pager, page, focusStatus = false, currentPagination = null) {
  if (!coveragePageResponseCanRender(main) || pendingCoveragePageReads.has(main)) return
  pendingCoveragePageReads.add(main)
  setCoverageNavigationBusy(main, true, currentPagination)
  const errorSlot = main.querySelector('[data-pagination-error]')
  if (errorSlot) errorSlot.innerHTML = ''
  let rendered = false
  try {
    const result = await pager.load(page)
    if (!coveragePageResponseCanRender(main)) return
    renderList(main, result, root, pager)
    rendered = true
    if (focusStatus) main.querySelector('[data-page-status]')?.focus()
  } catch (e) {
    if (!main.isConnected || !coveragePageResponseCanRender(main)) return
    const slot = main.querySelector('[data-pagination-error]')
    if (!slot) return
    slot.innerHTML = `<div class="notice notice-error" role="alert"><p>${esc(e?.message || 'No se pudo cargar la página.')}</p><button class="btn btn-ghost" type="button" data-retry-page>Reintentar lectura</button></div>`
    slot.querySelector('[data-retry-page]')?.addEventListener('click', () => changePage(main, root, pager, page, focusStatus, currentPagination))
  } finally {
    pendingCoveragePageReads.delete(main)
    if (!rendered && main.isConnected) setCoverageNavigationBusy(main, false, currentPagination)
  }
}

function showForm(main, existing, all, root, pager, pagination, returnFocus = null) {
  cleanupCoverageTabMotion(root)
  const box = main.querySelector('[data-newform]')
  if (box.querySelector('form[aria-busy="true"]')) return
  main.querySelectorAll('[data-edit]').forEach(button => button.closest('tr').classList.toggle('access-row-selected', button.dataset.edit === String(existing?.id)))
  box.innerHTML = `
    <section class="panel access-editor" aria-labelledby="coverage-form-title">
      <div class="coverage-policy-tab" data-coverage-policy-tab aria-hidden="true"><span class="coverage-policy-tab-mark">◇</span><span><strong>Póliza</strong><small>Hoja de cobertura</small></span></div>
      <h2 id="coverage-form-title">${existing ? 'Editar plan' : 'Registrar plan de cobertura'}</h2>
      <p class="access-editor-context">${existing ? esc(existing.name) : 'Define qué cubre el plan y durante cuánto tiempo.'}</p>
      <form data-form class="grid2">
        ${field('Nombre comercial del plan', `<input name="name" value="${esc(existing?.name || '')}" required minlength="2" maxlength="120">`)}
        ${field('Marca que cubre', `<input name="brand" value="${esc(existing?.brand || '')}" maxlength="80" placeholder="Por ejemplo, Apple">`, 'Déjala vacía para cubrir todas las marcas.')}
        ${field('Plan', `<input name="plan" value="${esc(existing?.plan || '')}" required maxlength="80" placeholder="Por ejemplo, pantalla o módulo completo">`)}
        ${field('Meses de vigencia', `<input name="months" type="number" min="1" max="120" step="1" required value="${esc(existing?.months ?? '')}">`, 'Entre 1 y 120 meses completos.')}
        <div style="grid-column:1/-1">${field('Exclusiones', `<textarea name="exclusions" rows="2" placeholder="Un punto por linea">${esc((existing?.exclusions || []).join('\n'))}</textarea>`)}</div>
        ${field('Política de reemplazo', `<select id="coverage-replacement-policy" name="replacement_policy">
            <option value="continue" ${existing?.replacement_policy === 'continue' ? 'selected' : ''}>${replacementPolicyLabel('continue')}</option>
            <option value="new" ${existing?.replacement_policy === 'new' ? 'selected' : ''}>${replacementPolicyLabel('new')}</option>
          </select>`, '«Continuar cobertura existente» mantiene la cobertura actual del equipo; «Nueva cobertura con mismo plan y plazo» crea una cobertura nueva respetando el plan y los meses vigentes.')}
        ${coveragePolicyPreview(existing?.replacement_policy)}
        <p class="access-form-status" data-form-status role="status" aria-live="polite" aria-atomic="true"></p>
        <div class="row access-form-actions">
          <button class="btn btn-primary" type="submit">${existing ? 'Guardar cambios' : 'Registrar'}</button>
          <button class="btn btn-ghost" type="button" data-cancel>Cancelar</button>
        </div>
      </form>
      <div data-err></div>
    </section>`
  const tabMotion = installCoverageTabMotion(root, main, box.querySelector('[data-coverage-policy-tab]'))
  const form = box.querySelector('[data-form]')
  // La vista previa sigue al select; el control nativo mantiene teclado y móvil.
  const policySelect = box.querySelector('#coverage-replacement-policy')
  const policyPreview = box.querySelector('[data-policy-preview]')
  const policyTitle = box.querySelector('[data-policy-title]')
  const policyBody = box.querySelector('[data-policy-body]')
  const policyAbort = new AbortController()
  const applyPolicyPreview = () => {
    const policy = POLICY_PREVIEW_COPY[policySelect?.value] ? policySelect.value : 'continue'
    if (!policyPreview?.isConnected) return
    const copy = POLICY_PREVIEW_COPY[policy]
    policyPreview.dataset.policy = policy
    if (policyTitle.textContent !== copy.title) policyTitle.textContent = copy.title
    if (policyBody.textContent !== copy.body) policyBody.textContent = copy.body
  }
  policySelect?.addEventListener('change', applyPolicyPreview, { signal: policyAbort.signal })
  applyPolicyPreview()
  box.querySelector('[data-cancel]').addEventListener('click', () => {
    policyAbort.abort()
    tabMotion.retract()
    box.innerHTML = ''
    main.querySelectorAll('.access-row-selected').forEach(row => row.classList.remove('access-row-selected'))
    setCoverageNavigationBusy(main, false, pagination)
    returnFocus?.focus()
  })
  setCoverageNavigationBusy(main, false, pagination)
  form.querySelector('input, textarea, select')?.focus()
  box.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' })
  form.addEventListener('submit', async ev => {
    ev.preventDefault()
    if (form.getAttribute('aria-busy') === 'true' || form.dataset.saved === 'true') return
    form.querySelectorAll('input[type="text"], input:not([type])').forEach(input => { input.value = input.value.trim() })
    if (!form.reportValidity()) return
    const cancel = box.querySelector('[data-cancel]')
    const err = box.querySelector('[data-err]')
    err.innerHTML = ''
    const f = new FormData(form)
    const payload = {
      name: f.get('name'),
      brand: f.get('brand') || (existing ? null : undefined),
      plan: f.get('plan'),
      months: f.get('months') ? Number(f.get('months')) : undefined,
      exclusions: String(f.get('exclusions') || '').split('\n').map(s => s.trim()).filter(Boolean),
      replacement_policy: f.get('replacement_policy'),
    }
    const btn = form.querySelector('button[type=submit]')
    const status = form.querySelector('[data-form-status]')
    form.setAttribute('aria-busy', 'true')
    form.querySelectorAll('input,select,textarea').forEach(control => { control.disabled = true })
    main.querySelectorAll('[data-new], [data-edit]').forEach(button => { button.disabled = true })
    btn.disabled = true
    cancel.disabled = true
    btn.textContent = existing ? 'Guardando…' : 'Registrando…'
    status.textContent = 'Guardando el plan de cobertura…'
    try {
      await (existing ? patch('/coverages/' + existing.id, payload) : post('/coverages', payload))
    } catch (e) {
      if (!form.isConnected) return
      err.innerHTML = `<div class="notice notice-error" role="alert">${esc(e?.message || 'No se pudo guardar.')}</div>`
      form.removeAttribute('aria-busy')
      form.querySelectorAll('input,select,textarea').forEach(control => { control.disabled = false })
      status.textContent = ''
      setCoverageNavigationBusy(main, false, pagination)
      btn.disabled = false
      cancel.disabled = false
      btn.textContent = existing ? 'Guardar cambios' : 'Registrar'
      btn.focus()
      return
    }

    if (!form.isConnected) return
    form.dataset.saved = 'true'
    policyAbort.abort()
    status.textContent = 'Plan guardado. Actualizando la lista…'
    const viewMain = main
    try {
      const result = await pager.refresh()
      if (!viewMain.isConnected) return
      renderList(viewMain, result, root, pager, { restoreFocus: true, focusId: existing?.id })
    } catch (e) {
      if (form.isConnected) {
        err.innerHTML = `<div class="notice notice-info" role="status" tabindex="-1">Se guardó el plan, pero no se pudo actualizar la lista.</div><button class="btn btn-ghost" type="button" data-retry-refresh>Reintentar actualización</button>`
        form.removeAttribute('aria-busy')
        status.textContent = ''
        btn.textContent = 'Guardado'
        cancel.disabled = false
        cancel.textContent = 'Cerrar'
        setCoverageNavigationBusy(main, false, pagination)
        err.querySelector('[role="status"]')?.focus()
        err.querySelector('[data-retry-refresh]')?.addEventListener('click', async () => {
          const retry = err.querySelector('[data-retry-refresh]')
          if (!retry || retry.disabled || pendingCoveragePageReads.has(main)) return
          retry.disabled = true
          await retrySavedCoverageRefresh(viewMain, pager, pagination,
            refreshed => renderList(viewMain, refreshed, root, pager, { restoreFocus: true, focusId: existing?.id }),
            retryError => {
              if (!form.isConnected) return
              err.querySelector('[role="status"]')?.replaceChildren(document.createTextNode('Se guardó el plan, pero no se pudo actualizar la lista.'))
              retry.title = retryError?.message || 'No se pudo actualizar la lista.'
              retry.disabled = false
            })
        })
      }
    }
  })
}
