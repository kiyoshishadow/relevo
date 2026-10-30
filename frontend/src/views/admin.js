// Usuarios y auditoría (solo admin), datos reales del servidor.
import { get, post, patch } from '../api.js'
import { esc, fmtDate, ROLE_LABEL } from '../util.js'
import { workShell, requireAuth } from '../layout/work.js'
import { field } from '../ui.js'
import { buildUserPayload } from '../user-form.js'
import { onLeave } from '../router.js'
import gsap from 'gsap'
import '../styles/access-plans.css'
import '../styles/users-filter-motion.css'
import '../styles/notifications-motion.css'
import '../styles/audit-motion.css'
import '../styles/user-role-motion.css'
import { createUserRoleMotion, confirmUserRoleFromSnapshot } from '../user-role-motion.js'
import { createAuditProvenanceMotion } from '../audit-provenance-motion.js'

// Filtro local: solo etiquetas de rol existentes. Nunca crea roles ni permisos.
const USER_ROLE_FILTERS = [
  { value: 'all', label: 'Todas' },
  { value: 'reception', label: 'Recepción' },
  { value: 'technician', label: 'Técnico' },
  { value: 'admin', label: 'Administración' },
]
const USER_FILTER_LABEL = Object.fromEntries(USER_ROLE_FILTERS.map(({ value, label }) => [value, label]))
const isUserFilter = value => USER_ROLE_FILTERS.some(filter => filter.value === value)
const userFilterCount = (data, value) => value === 'all' ? data.length : data.filter(user => user.role === value).length
const USERS_PAGE_SIZE = 100
const usersPaginationByMain = new WeakMap()
const userRoleMotionByMain = new WeakMap()

export function userRosterSummary(users) {
  return ['reception', 'technician', 'admin'].map(role => ({
    role, label: ROLE_LABEL[role], total: users.filter(user => user.role === role).length,
    active: users.filter(user => user.role === role && user.active !== false).length,
  }))
}

export function userPageRange(meta = {}) {
  const page = Math.max(1, Number(meta.page) || 1)
  const pageSize = Math.max(1, Number(meta.pageSize) || USERS_PAGE_SIZE)
  const total = Math.max(0, Number(meta.total) || 0)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return { page, pageSize, total, pages, first: total ? (page - 1) * pageSize + 1 : 0, last: Math.min(page * pageSize, total) }
}

// Separates request sequencing from the editor DOM so page loads never replace
// drafts. Invalidation also prevents a late response painting an abandoned view.
export function createUsersPagination({ fetchPage, isCurrent = () => true, onBusy = () => {}, onPage = () => {}, onError = () => {} } = {}) {
  const state = { page: 1, pageSize: USERS_PAGE_SIZE, total: 0, data: [], loading: false, loaded: false, failedPage: null, mutating: false, savedRefreshPending: false }
  let revision = 0
  let failedOptions = {}
  let disposed = false

  async function load(page = state.page, options = {}) {
    if (disposed || state.loading || state.mutating || !isCurrent()) return false
    const target = Math.max(1, Number(page) || 1)
    const currentRevision = ++revision
    state.loading = true
    state.pendingPage = target
    state.failedPage = null
    onBusy(true, state)
    try {
      const response = await fetchPage(target)
      if (disposed || currentRevision !== revision || !isCurrent()) return false
      const data = Array.isArray(response?.data) ? response.data : []
      const meta = response?.meta || {}
      const range = userPageRange({ ...meta, page: meta.page ?? target })
      state.page = range.page
      state.pageSize = range.pageSize
      state.total = range.total
      state.data = data
      state.meta = meta
      state.loaded = true
      state.failedPage = null
      failedOptions = {}
      onPage({ data, meta, state, options })
      return true
    } catch (error) {
      if (disposed || currentRevision !== revision || !isCurrent()) return false
      state.failedPage = target
      failedOptions = options
      onError(error, target, state)
      return false
    } finally {
      if (!disposed && currentRevision === revision) {
        state.loading = false
        delete state.pendingPage
        if (isCurrent()) onBusy(false, state)
      }
    }
  }

  return {
    state,
    load,
    retry(options = {}) { return state.failedPage == null ? Promise.resolve(false) : load(state.failedPage, { ...failedOptions, ...options }) },
    beginMutation() {
      if (disposed || !isCurrent() || state.loading || state.mutating || state.savedRefreshPending) return false
      state.mutating = true
      return true
    },
    endMutation() { state.mutating = false },
    setSavedRefreshPending(value) { state.savedRefreshPending = Boolean(value) },
    invalidate() {
      revision += 1
      state.loading = false
      state.failedPage = null
      failedOptions = {}
      delete state.pendingPage
      onBusy(false, state)
    },
    dispose() {
      disposed = true
      revision += 1
      state.loading = false
      delete state.pendingPage
    },
  }
}

// Adapter shared with tests so successful controller responses exercise the
// exact render-and-success wiring used by the Users view.
export function createUsersPageHandler(renderPage, afterRender = () => {}) {
  return ({ data, meta, state, options = {} }) => {
    renderPage(data, meta, state, { focusStatus: options.focusStatus })
    afterRender(data, meta, state)
    options.onSuccess?.({ data, meta, state })
  }
}

export function createUsersRangeMotion({ getTrack, getNeedle, gsapApi = gsap, mediaQuery } = {}) {
  const motionQuery = mediaQuery || (typeof window !== 'undefined'
    ? window.matchMedia?.('(prefers-reduced-motion: reduce)')
    : null)
  let reduced = Boolean(motionQuery?.matches)
  let tween = null
  let destination = null
  let disposed = false

  const finish = () => {
    if (!destination) return
    tween?.kill?.()
    tween = null
    gsapApi.set(destination.needle, { x: destination.x, opacity: 1 })
  }
  const onMotionChange = event => {
    reduced = Boolean(event.matches)
    if (reduced) finish()
  }
  motionQuery?.addEventListener?.('change', onMotionChange)
  if (motionQuery && !motionQuery.addEventListener) motionQuery.addListener?.(onMotionChange)

  return {
    update(page, pages, { animate = false, fromPage = null } = {}) {
      if (disposed) return
      const track = getTrack?.()
      const needle = getNeedle?.()
      if (!track || !needle) return
      tween?.kill?.()
      tween = null
      const trackWidth = track.getBoundingClientRect().width
      const needleWidth = needle.getBoundingClientRect().width
      const travel = Math.max(0, trackWidth - needleWidth)
      const x = pages <= 1 ? 0 : travel * ((page - 1) / (pages - 1))
      destination = { needle, x }
      if (!animate || reduced) {
        finish()
        return
      }
      if (fromPage != null) {
        const fromX = pages <= 1 ? 0 : travel * ((fromPage - 1) / (pages - 1))
        gsapApi.set(needle, { x: fromX, opacity: 1 })
      }
      tween = gsapApi.to(needle, { x, opacity: 1, duration: 0.15, ease: 'power2.out', overwrite: true })
    },
    dispose() {
      if (disposed) return
      disposed = true
      tween?.kill?.()
      tween = null
      motionQuery?.removeEventListener?.('change', onMotionChange)
      if (motionQuery && !motionQuery.removeEventListener) motionQuery.removeListener?.(onMotionChange)
    },
  }
}

export async function usersView(root) {
  if (!(await requireAuth(root))) return
  root.innerHTML = workShell('Usuarios', 'Accesos del taller', '')
  const main = root.querySelector('.work-main')
  main.classList.add('access-plans')
  renderUsers(main, [], { page: 1, pageSize: USERS_PAGE_SIZE, total: 0 }, { initialLoading: true })
  const rangeMotion = createUsersRangeMotion({
    getTrack: () => main.querySelector('[data-users-range-track]'),
    getNeedle: () => main.querySelector('[data-users-range-needle]'),
  })
  const roleMotion = createUserRoleMotion({
    root: main,
    gsapApi: gsap,
    mediaQuery: window.matchMedia?.('(prefers-reduced-motion: reduce)'),
  })
  userRoleMotionByMain.set(main, roleMotion)
  let renderedPage = null
  const pagination = createUsersPagination({
    fetchPage: page => get(`/users?page=${page}&pageSize=${USERS_PAGE_SIZE}`),
    isCurrent: () => main.isConnected,
    onBusy: busy => setUsersBusy(main, busy),
    onPage: createUsersPageHandler(
      (data, meta, _state, renderOptions) => updateUsersPage(main, data, meta, renderOptions),
      (_data, meta) => {
        const range = userPageRange(meta)
        rangeMotion.update(range.page, range.pages, {
          animate: renderedPage !== null && renderedPage !== range.page,
          fromPage: renderedPage,
        })
        renderedPage = range.page
      },
    ),
    onError: (error, page) => showUsersLoadError(main, error, page),
  })
  usersPaginationByMain.set(main, pagination)
  onLeave(() => {
    rangeMotion.dispose()
    roleMotion.dispose()
    pagination.dispose()
    usersPaginationByMain.delete(main)
    userRoleMotionByMain.delete(main)
  })
  await pagination.load(1)
}

function renderUsers(main, data, meta, { initialLoading = false } = {}) {
  main.classList.add('access-plans')
  const activeFilter = isUserFilter(main.dataset.userFilter) ? main.dataset.userFilter : 'all'
  main.dataset.userFilter = activeFilter
  main.innerHTML = `
    <header class="access-plans-heading"><div><h1>Usuarios</h1><p>Organiza los accesos de recepción, técnicos y administración.</p></div><button class="btn btn-primary" type="button" data-new>Crear usuario</button></header>
    <section class="access-roster" data-users-roster aria-label="Roles de los usuarios mostrados"></section>
    <fieldset class="users-filter" data-users-filter aria-describedby="users-scope">
      <legend>Filtrar por rol</legend>
      <div class="users-filter-options">${USER_ROLE_FILTERS.map(({ value, label }) => `<label class="users-filter-option">
          <input class="users-filter-input" type="radio" name="user-role-filter" value="${value}"${value === activeFilter ? ' checked' : ''}>
          <span class="users-filter-chip">${esc(label)}<span class="users-filter-count" data-role-count="${value}" aria-hidden="true">0</span></span>
          <span class="users-filter-sr" data-role-sr-count="${value}">0 usuarios</span>
        </label>`).join('')}</div>
      <p class="users-scope" id="users-scope">Filtros y conteos aplican solo a la página actual.</p>
      <p class="users-filter-status" data-users-filter-status role="status" aria-live="polite" aria-atomic="true"></p>
    </fieldset>
    <div data-newform></div>
    <div data-users-feedback></div>
    <p data-users-load-status role="status" aria-live="polite" aria-atomic="true"></p>
    <div data-users-pager></div>
    <div class="table-wrap mt" tabindex="0" role="region" aria-label="Tabla de usuarios"><table class="users-table">
      <thead><tr><th scope="col">Correo</th><th scope="col">Nombre</th><th scope="col">Rol</th><th scope="col">Estado</th><th scope="col">Acciones</th></tr></thead>
      <tbody><tr data-users-loading ${initialLoading ? '' : 'hidden'}><td colspan="5"><span class="skel" role="status">Cargando usuarios…</span></td></tr>
        <tr data-users-filter-empty hidden><td colspan="5"><p class="users-filter-empty">No hay usuarios de <strong data-users-empty-role></strong> en esta página.</p></td></tr>
      </tbody></table></div>`

  const radios = [...main.querySelectorAll('.users-filter-input')]
  radios.forEach(radio => radio.addEventListener('change', () => {
    if (!radio.checked) return
    main.dataset.userFilter = radio.value
    applyUsersFilter(main, { animate: true })
  }))

  main.querySelector('[data-new]').addEventListener('click', event => showUserForm(main, null, event.currentTarget))
  if (!initialLoading) updateUsersPage(main, data, meta, { focusStatus: false })
}

function setUsersBusy(main, busy) {
  if (!main.isConnected) return
  main.querySelector('.users-table')?.setAttribute('aria-busy', String(busy))
  const state = usersPaginationByMain.get(main)?.state
  const locked = busy || state?.mutating || state?.savedRefreshPending || main.dataset.usersSavedRefreshPending === 'true'
  main.querySelectorAll('[data-new], [data-edit]').forEach(button => { button.disabled = locked })
  main.querySelectorAll('[data-users-page]').forEach(button => {
    const target = Number(button.dataset.usersPage)
    const pages = Math.max(1, Math.ceil((state?.total || 0) / (state?.pageSize || USERS_PAGE_SIZE)))
    button.disabled = locked || target < 1 || target > pages || target === state?.page
  })
  const loadingRow = main.querySelector('[data-users-loading]')
  if (loadingRow && !state?.loaded) loadingRow.hidden = !busy
  const status = main.querySelector('[data-users-load-status]')
  if (status) status.textContent = busy ? `Cargando página ${usersPaginationByMain.get(main)?.state.pendingPage || 1}…` : ''
}

function showUsersLoadError(main, error, page) {
  if (!main.isConnected) return
  const feedback = main.querySelector('[data-users-feedback]')
  feedback.innerHTML = `<div class="notice notice-error" role="alert"><p>${esc(error?.message || 'No se pudo cargar la página de usuarios.')}</p><button class="btn btn-ghost" type="button" data-retry-users>Reintentar página ${page}</button></div>`
  feedback.querySelector('[data-retry-users]')?.addEventListener('click', () => usersPaginationByMain.get(main)?.retry({ focusStatus: true }))
}

function updateUsersPage(main, data, meta, { focusStatus = false } = {}) {
  const page = userPageRange(meta)
  const activeFilter = isUserFilter(main.dataset.userFilter) ? main.dataset.userFilter : 'all'
  const roster = main.querySelector('[data-users-roster]')
  roster.innerHTML = userRosterSummary(data).map(group => `<div class="access-role"><span class="access-role-glyph" aria-hidden="true">${group.role === 'reception' ? '◉' : group.role === 'technician' ? '⌘' : '◇'}</span><div><h2>${esc(group.label)}</h2><p><strong>${group.active}</strong> activos de ${group.total} mostrados en esta página</p></div></div>`).join('')
  for (const { value } of USER_ROLE_FILTERS) {
    const count = userFilterCount(data, value)
    const badge = main.querySelector(`[data-role-count="${value}"]`)
    const srCount = main.querySelector(`[data-role-sr-count="${value}"]`)
    if (badge) badge.textContent = String(count)
    if (srCount) srCount.textContent = `${count} usuario${count === 1 ? '' : 's'} en esta página`
  }
  const scope = main.querySelector('#users-scope')
  if (scope) {
    const itemLabel = page.total === 1 ? 'usuario' : 'usuarios'
    scope.textContent = `Página ${page.page} de ${page.pages}: ${page.first}–${page.last} de ${page.total} ${itemLabel}. Filtros y conteos de rol aplican solo a esta página; filtrar no vuelve a consultar la API.`
  }

  const tbody = main.querySelector('.users-table tbody')
  tbody.innerHTML = `${data.map(user => `
    <tr data-user-row data-user-id="${esc(user.id)}" data-role="${esc(user.role)}"><td>${esc(user.email)}</td><td>${esc(user.full_name || '—')}</td>
    <td data-user-role-cell><span data-user-role-label>${esc(ROLE_LABEL[user.role] || user.role)}</span><span data-user-role-frame aria-hidden="true"></span></td>
    <td><span class="pill pill-neutral">${user.active !== false ? 'Activo' : 'Inactivo'}</span></td>
    <td><button class="btn btn-ghost" type="button" data-edit="${esc(user.id)}" aria-label="Editar usuario ${esc(user.email)}">Editar</button></td></tr>`).join('')}
    ${data.length ? '' : '<tr data-users-base-empty><td colspan="5" style="color:var(--ink-mute)">Sin usuarios en esta página.</td></tr>'}
    <tr data-users-filter-empty hidden><td colspan="5"><p class="users-filter-empty">No hay usuarios de <strong data-users-empty-role></strong> en esta página.</p></td></tr>`
  main.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => {
    const user = data.find(candidate => String(candidate.id) === button.dataset.edit)
    if (user) showUserForm(main, user, button)
  }))
  applyUsersFilter(main, { animate: false })
  renderUsersPager(main, page)
  main.querySelector('[data-users-feedback]').replaceChildren()
  if (focusStatus) main.querySelector('[data-users-page-status]')?.focus()
}

function applyUsersFilter(main, { animate = true } = {}) {
  const filter = isUserFilter(main.dataset.userFilter) ? main.dataset.userFilter : 'all'
  const tbody = main.querySelector('.users-table tbody')
  const rows = [...tbody.querySelectorAll('[data-user-row]')]
  const radios = [...main.querySelectorAll('.users-filter-input')]
  const status = main.querySelector('[data-users-filter-status]')
  const emptyRow = tbody.querySelector('[data-users-filter-empty]')
  const emptyRole = emptyRow?.querySelector('[data-users-empty-role]')
  const focusedRow = document.activeElement?.closest?.('[data-user-row]') || null
  const current = usersPaginationByMain.get(main)?.state
  const total = current?.data.length || 0
  let visible = 0
  rows.forEach((row, index) => {
    const match = filter === 'all' || row.dataset.role === filter
    row.hidden = !match
    if (match) visible += 1
    row.style.setProperty('--users-row-i', String(index))
  })
  if (emptyRow) emptyRow.hidden = filter === 'all' || visible > 0 || total === 0
  if (emptyRole) emptyRole.textContent = USER_FILTER_LABEL[filter] || ''
  if (animate) {
    rows.forEach(row => row.classList.remove('users-row-enter'))
    void tbody.offsetWidth
    rows.forEach(row => { if (!row.hidden) row.classList.add('users-row-enter') })
  }
  if (status) status.textContent = filter === 'all'
    ? `Mostrando los ${total} usuarios de esta página.`
    : visible
      ? `Mostrando ${visible} de ${total} usuarios de esta página con rol ${USER_FILTER_LABEL[filter]}.`
      : `Sin usuarios con rol ${USER_FILTER_LABEL[filter]} en esta página.`
  if (focusedRow?.hidden) radios.find(radio => radio.checked)?.focus()
}

function renderUsersPager(main, range) {
  const pager = main.querySelector('[data-users-pager]')
  const summary = `${range.first}–${range.last} de ${range.total} usuarios · página ${range.page} de ${range.pages}`
  pager.innerHTML = `<nav class="row" aria-label="Paginación de usuarios" style="justify-content:space-between;gap:.75rem;align-items:center;flex-wrap:wrap;margin-top:1rem">
    <p data-users-page-status tabindex="-1" aria-live="polite" style="color:var(--ink-mute);margin:0">${summary}
      <span class="users-range-index" aria-hidden="true"><span data-users-range-track><span data-users-range-needle></span></span></span>
    </p>
    <div class="row" style="gap:.5rem">
      <button class="btn btn-ghost" type="button" data-users-page="${range.page - 1}" ${range.page <= 1 ? 'disabled' : ''} aria-label="Página anterior de usuarios">← Anterior</button>
      <button class="btn btn-ghost" type="button" data-users-page="${range.page + 1}" ${range.page >= range.pages ? 'disabled' : ''} aria-label="Página siguiente de usuarios">Siguiente →</button>
    </div>
  </nav>`
  pager.querySelectorAll('[data-users-page]').forEach(button => button.addEventListener('click', () => {
    const target = Number(button.dataset.usersPage)
    const controller = usersPaginationByMain.get(main)
    if (button.disabled || main.dataset.usersMutationPending === 'true' || main.dataset.usersSavedRefreshPending === 'true' || controller?.state.loading || controller?.state.mutating || target === controller?.state.page) return
    controller?.load(target, { focusStatus: true })
  }))
}

function showUserForm(main, user, returnFocus) {
  const box = main.querySelector('[data-newform]')
  if (box.querySelector('form[aria-busy="true"]')) return
  main.querySelectorAll('[data-edit]').forEach(button => button.closest('tr').classList.toggle('access-row-selected', button.dataset.edit === String(user?.id)))
  const editing = Boolean(user)
  box.innerHTML = `
    <section class="panel access-editor" aria-labelledby="user-form-title">
      <h2 id="user-form-title">${editing ? 'Editar usuario' : 'Crear usuario'}</h2>
      <p class="access-editor-context">${editing ? esc(user.email) : 'Completa los datos de acceso del nuevo integrante.'}</p>
      <form data-form class="grid2" novalidate>
        ${field('Correo', `<input name="email" type="email" value="${esc(user?.email || '')}" autocomplete="email" required maxlength="254">`)}
        ${field('Nombre', `<input name="full_name" value="${esc(user?.full_name || '')}" required minlength="2" maxlength="160" autocomplete="name">`)}
        ${field('Rol', `<select name="role" required>
          <option value="reception" ${user?.role === 'reception' ? 'selected' : ''}>Recepción</option>
          <option value="technician" ${user?.role === 'technician' ? 'selected' : ''}>Técnico</option>
          <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Administración</option></select>`)}
        ${editing ? field('Estado', `<select name="active">
          <option value="true" ${user.active !== false ? 'selected' : ''}>Activo</option>
          <option value="false" ${user.active === false ? 'selected' : ''}>Inactivo</option></select>`) : ''}
        ${field(editing ? 'Nueva contraseña (opcional)' : 'Contraseña inicial', `<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" ${editing ? '' : 'required'}>`, editing ? 'Déjala vacía para conservar la contraseña actual. Si la cambias, debe tener al menos 10 caracteres.' : 'Debe tener entre 10 y 128 caracteres.')}
        <p data-form-status role="status" aria-live="polite" aria-atomic="true" style="grid-column:1/-1;margin:0;color:var(--ink-mute)"></p>
        <div class="row" style="grid-column:1/-1">
          <button class="btn btn-primary" type="submit">${editing ? 'Guardar cambios' : 'Crear'}</button>
          <button class="btn btn-ghost" type="button" data-cancel>Cancelar</button>
        </div>
      </form>
      <div data-err></div>
    </section>`

  const form = box.querySelector('[data-form]')
  const submit = form.querySelector('[type="submit"]')
  const cancel = box.querySelector('[data-cancel]')
  const status = box.querySelector('[data-form-status]')
  const errorBox = box.querySelector('[data-err]')
  const controller = usersPaginationByMain.get(main)
  const close = () => {
    box.innerHTML = ''
    main.querySelectorAll('.access-row-selected').forEach(row => row.classList.remove('access-row-selected'))
    // El filtro puede ocultar la fila que abrió la edición; en ese caso el botón ya no es enfocable.
    const returnFocusUsable = Boolean(returnFocus?.isConnected) && !returnFocus.closest('[hidden]')
    const focusTarget = returnFocusUsable
      ? returnFocus
      : main.querySelector('.users-filter-input:checked') || main.querySelector('[data-new]')
    focusTarget?.focus()
  }
  cancel.addEventListener('click', close)
  form.querySelector('[name="email"]').focus()
  const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  box.scrollIntoView({ behavior, block: 'nearest' })

  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (form.getAttribute('aria-busy') === 'true' || form.dataset.saved === 'true') return
    errorBox.innerHTML = ''
    const values = Object.fromEntries(new FormData(form))
    if (!form.reportValidity()) return
    if (!controller?.beginMutation()) {
      status.textContent = 'Espera a que termine la carga de la página. Tu borrador se conserva.'
      return
    }
    main.dataset.usersMutationPending = 'true'
    main.querySelectorAll('[data-new], [data-edit], [data-users-page]').forEach(button => { button.disabled = true })
    const payload = buildUserPayload(values)
    form.setAttribute('aria-busy', 'true')
    form.querySelectorAll('input,select').forEach(control => { control.disabled = true })
    submit.disabled = true
    cancel.disabled = true
    submit.textContent = editing ? 'Guardando…' : 'Creando…'
    status.textContent = editing ? 'Guardando cambios del usuario…' : 'Creando usuario…'

    let saved
    try {
      const response = await (editing ? patch(`/users/${encodeURIComponent(user.id)}`, payload) : post('/users', payload))
      saved = response.data
    } catch (e) {
      controller.endMutation()
      delete main.dataset.usersMutationPending
      if (!form.isConnected) return
      setUsersBusy(main, false)
      errorBox.innerHTML = `<div class="notice notice-error" role="alert">${esc(e?.message || (editing ? 'No se pudieron guardar los cambios.' : 'No se pudo crear el usuario.'))}</div>`
      status.textContent = ''
      form.removeAttribute('aria-busy')
      form.querySelectorAll('input,select').forEach(control => { control.disabled = false })
      submit.disabled = false
      cancel.disabled = false
      submit.textContent = editing ? 'Guardar cambios' : 'Crear'
      submit.focus()
      return
    }

    controller.endMutation()
    delete main.dataset.usersMutationPending
    if (!form.isConnected || !main.isConnected) {
      controller.setSavedRefreshPending(true)
      main.dataset.usersSavedRefreshPending = 'true'
    } else {
    form.dataset.saved = 'true'
    controller.setSavedRefreshPending(true)
    main.dataset.usersSavedRefreshPending = 'true'
    status.textContent = `Usuario guardado. Actualizando la página ${usersPaginationByMain.get(main)?.state.page || 1}…`
    }
    const finalizeSavedRefresh = () => {
      controller?.setSavedRefreshPending(false)
      delete main.dataset.usersSavedRefreshPending
      if (!main.isConnected) return
      setUsersBusy(main, false)
      const state = controller?.state
      confirmUserRoleFromSnapshot({
        motion: userRoleMotionByMain.get(main),
        users: state?.data,
        id: saved?.id,
        previousRole: editing ? user?.role : null,
      })
      if (!form.isConnected) {
        const feedback = main.querySelector('[data-users-feedback]')
        feedback.innerHTML = '<p class="notice notice-info" role="status">Usuario guardado. La lista se actualizó.</p>'
        main.querySelector('[data-users-page-status]')?.focus()
        return
      }
      form.removeAttribute('aria-busy')
      submit.disabled = true
      submit.textContent = 'Guardado'
      form.querySelectorAll('input,select').forEach(control => { control.disabled = true })
      cancel.disabled = false
      cancel.textContent = 'Cerrar'
      const currentFilter = isUserFilter(main.dataset.userFilter) ? main.dataset.userFilter : 'all'
      const savedRow = state?.data.find(candidate => String(candidate.id) === String(saved?.id))
      const visible = savedRow && (currentFilter === 'all' || savedRow.role === currentFilter)
      const feedback = main.querySelector('[data-users-feedback]')
      if (visible) {
        box.innerHTML = ''
        main.querySelectorAll('.access-row-selected').forEach(row => row.classList.remove('access-row-selected'))
        feedback.innerHTML = '<p class="notice notice-info" role="status">Usuario guardado.</p>'
        const button = [...main.querySelectorAll('[data-edit]')].find(candidate => candidate.dataset.edit === String(saved.id))
        ;(button || main.querySelector('[data-users-page-status]'))?.focus()
      } else {
        status.textContent = `Usuario guardado. No aparece en la página ${state?.page || 1} con el filtro actual; no se insertó manualmente en la lista.`
        cancel.focus()
      }
      // Trigger role-change animation if role was actually modified
      const motion = main.__userRoleMotion
      if (motion && typeof motion.confirm === 'function') {
        const previousRole = main.dataset.userRolePreviousRole
        const confirmedRole = savedRow?.role
        // Only animate if previous role is stored and different from confirmed role
        if (previousRole && previousRole !== confirmedRole) {
          motion.confirm({
            id: String(saved?.id),
            previousRole,
            confirmedRole,
          })
        }
        // Clear stored data so animation doesn't repeat
        main.dataset.userRolePreviousRole = ''
        delete main.__userRoleMotion
      }
    }
    const loaded = await controller?.load(controller.state.page, {
      savedId: saved?.id,
      onSuccess: finalizeSavedRefresh,
    })
    if (!loaded && form.isConnected) {
      status.textContent = 'Usuario guardado. La lista no se pudo actualizar; usa Reintentar página. El guardado no se repetirá.'
      form.removeAttribute('aria-busy')
      submit.disabled = true
      submit.textContent = 'Guardado'
      cancel.disabled = false
      cancel.textContent = 'Cerrar'
    } else if (!loaded && !form.isConnected && main.isConnected) {
      const status = main.querySelector('[data-users-load-status]')
      if (status) status.textContent = 'Usuario guardado. No se pudo actualizar la lista; usa Reintentar página. El guardado no se repetirá.'
    }
  })
}

const AUDIT_PAGE_SIZE = 50

export async function auditView(root) {
  if (!(await requireAuth(root))) return
  root.innerHTML = workShell('Auditoría', 'Registro de actividad', `
    <p class="audit-intro">Cada evento proviene del registro del servidor. Abre uno para revisar sus detalles tal como los entregó la API.</p>
    <p data-audit-status role="status" aria-live="polite" aria-atomic="true" tabindex="-1" style="color:var(--ink-mute);margin:0 0 .25rem"></p>
    <div data-audit-body aria-busy="true">
      <div class="audit-loading skel" role="status" aria-live="polite">Cargando registros…</div>
    </div>
    <div data-audit-pager></div>`)
  const main = root.querySelector('.work-main')
  const provenanceMotion = createAuditProvenanceMotion(main)
  // Registrar antes del primer GET: al salir durante la carga también se limpian listeners y tweens.
  onLeave(() => provenanceMotion.dispose())

  // Solo se muestran campos que entrega /audit: actor (objeto o null), acción,
  // entidad, detalles y fecha. No se completan datos ausentes.
  const readableDetails = value => {
    if (value == null) return ''
    if (typeof value === 'string') {
      const text = value.trim()
      if (!text) return value
      try {
        return JSON.stringify(JSON.parse(text), null, 2)
      } catch {
        return value
      }
    }
    try {
      const text = JSON.stringify(value, null, 2)
      return text == null ? String(value) : text
    } catch {
      return String(value)
    }
  }

  let currentPage = 1
  let loading = false
  let loadedOnce = false

  async function load(page = 1, { focusPageStatus = false } = {}) {
    if (loading) return false
    const body = main.querySelector('[data-audit-body]')
    const status = main.querySelector('[data-audit-status]')
    const pager = main.querySelector('[data-audit-pager]')
    if (!body || !main.isConnected) return false

    provenanceMotion.clear()
    loading = true
    body.setAttribute('aria-busy', 'true')
    pager.querySelectorAll('[data-audit-page]').forEach(button => { button.disabled = true })
    status.textContent = loadedOnce ? `Cargando página ${page}…` : 'Cargando registros…'

    try {
      const { data, meta } = await get(`/audit?page=${page}&pageSize=${AUDIT_PAGE_SIZE}`)
      if (!main.isConnected) return false

      const events = Array.isArray(data) ? data : []
      const resolvedPage = Number(meta?.page) || page
      currentPage = resolvedPage
      loadedOnce = true
      const roleName = role => ROLE_LABEL[role] || (role ? String(role) : '')
      const actorName = actor => (actor ? (actor.full_name || actor.email || 'Usuario sin nombre') : 'Sin actor registrado')
      const actorMeta = actor => {
        if (!actor) return 'La API no registró un usuario para este evento.'
        return [actor.email, roleName(actor.role)].filter(Boolean).join(' · ') || 'Sin datos adicionales del usuario.'
      }

      const items = events.map(event => {
        const when = event?.created_at || event?.at || null
        const actor = event?.actor && typeof event.actor === 'object' ? event.actor : null
        const action = event?.action ? String(event.action) : ''
        const entityType = event?.entity_type ? String(event.entity_type) : ''
        const entityId = event?.entity_id != null && event.entity_id !== '' ? String(event.entity_id) : ''
        const entity = entityType ? (entityId ? `${entityType} · ${entityId}` : entityType) : entityId
        const details = readableDetails(event?.details)
        const actorText = actorName(actor)

        return `
          <li class="audit-item">
            <span class="audit-marker" aria-hidden="true"></span>
            <details class="audit-event">
              <summary class="audit-summary">
                <span class="audit-when"><time${when ? ` datetime="${esc(when)}"` : ''}>${esc(when ? fmtDate(when) : 'Fecha no disponible')}</time></span>
                <span class="audit-headline">
                  <span class="audit-action">${esc(action || 'Acción no especificada')}</span>
                  <span class="audit-actor">${esc(actorText)}</span>
                </span>
                <span class="audit-entity">${esc(entity || 'Sin entidad')}</span>
                <span class="audit-toggle" aria-hidden="true"></span>
              </summary>
              <div class="audit-body">
                <dl class="audit-facts">
                  <div data-audit-station="date"><dt>Cuándo</dt><dd>${when ? `<time datetime="${esc(when)}">${esc(fmtDate(when))}</time>` : 'Fecha no disponible'}</dd></div>
                  <div data-audit-station="actor"><dt>Actor</dt><dd>${esc(actorText)}${actor ? `<span class="audit-actor-meta">${esc(actorMeta(actor))}</span>` : ''}</dd></div>
                  <div data-audit-station="action"><dt>Acción</dt><dd>${esc(action || 'Acción no especificada')}</dd></div>
                  <div data-audit-station="entity"><dt>Entidad</dt><dd>${esc(entity || 'Sin entidad')}</dd></div>
                </dl>
                <div class="audit-details">
                  <h2 data-audit-provenance-end>Detalles</h2>
                  ${details === ''
                    ? '<p class="audit-details-empty">Sin detalles registrados.</p>'
                    : `<pre tabindex="0" aria-label="Detalles JSON del evento"><code>${esc(details)}</code></pre>`}
                </div>
              </div>
            </details>
          </li>`
      }).join('')

      body.innerHTML = events.length
        ? `<ol class="audit-timeline" aria-label="Cronología de eventos">${items}</ol>`
        : `<div class="audit-empty" role="status"><p>${resolvedPage > 1 ? 'No hay eventos en esta página.' : 'La API no devolvió eventos.'}</p></div>`
      renderPager(meta, page, pager)
      status.textContent = ''
      body.setAttribute('aria-busy', 'false')
      if (focusPageStatus) main.querySelector('[data-audit-page-status]')?.focus()
      return true
    } catch (e) {
      if (!main.isConnected) return false
      pager.innerHTML = ''
      status.textContent = ''
      body.innerHTML = `<div class="notice notice-error" role="alert"><p>${esc(e?.message || 'No se pudo cargar la auditoría.')}</p><button class="btn btn-ghost" type="button" data-retry-audit>Reintentar</button></div>`
      body.setAttribute('aria-busy', 'false')
      body.querySelector('[data-retry-audit]')?.addEventListener('click', () => load(page))
      return false
    } finally {
      loading = false
      if (body.isConnected) body.setAttribute('aria-busy', 'false')
    }
  }

  function renderPager(meta, requestedPage, pager) {
    const total = Number(meta?.total)
    if (!meta || !Number.isFinite(total) || total < 0) {
      pager.innerHTML = ''
      return
    }
    const page = Math.max(1, Number(meta.page) || requestedPage)
    const pageSize = Math.max(1, Number(meta.pageSize) || AUDIT_PAGE_SIZE)
    const pages = Math.max(1, Math.ceil(total / pageSize))
    const first = total ? (page - 1) * pageSize + 1 : 0
    const last = Math.min(page * pageSize, total)
    const summary = `${first}–${last} de ${total} evento${total === 1 ? '' : 's'} · página ${page} de ${pages}`
    pager.innerHTML = `<nav class="row" aria-label="Paginación de auditoría" style="justify-content:space-between;gap:.75rem;align-items:center;flex-wrap:wrap;margin-top:1rem">
      <p data-audit-page-status tabindex="-1" aria-live="polite" style="color:var(--ink-mute);margin:0">${summary}</p>
      <div class="row" style="gap:.5rem">
        <button class="btn btn-ghost" type="button" data-audit-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Página anterior de auditoría">← Anterior</button>
        <button class="btn btn-ghost" type="button" data-audit-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Página siguiente de auditoría">Siguiente →</button>
      </div>
    </nav>`
    pager.querySelectorAll('[data-audit-page]').forEach(button => button.addEventListener('click', () => {
      const target = Number(button.dataset.auditPage)
      if (button.disabled || loading || target === currentPage) return
      load(target, { focusPageStatus: true })
    }))
  }

  await load(1)
}

const NOTIFICATIONS_PAGE_SIZE = 20
const NOTIFICATION_STATUS_LABEL = {
  pending: 'Pendiente',
  sending: 'Enviando',
  sent: 'Enviado',
  failed: 'Falló',
}

// El estado `sent` de un proveedor local solo confirma el procesamiento interno:
// no acredita una entrega externa, así que la etiqueta debe decirlo.
function notificationStatus(n) {
  const rawStatus = String(n?.status ?? '').trim()
  const statusKey = rawStatus.toLowerCase()
  const provider = String(n?.provider ?? '').trim().toLowerCase()
  if (statusKey === 'sent') {
    const localProvider = provider === 'local' || provider.startsWith('local-') || provider.startsWith('local_')
    return { statusKey, label: localProvider ? 'Procesado en modo local' : 'Enviado' }
  }
  return { statusKey, label: NOTIFICATION_STATUS_LABEL[statusKey] || rawStatus || '—' }
}

export async function notificationsView(root) {
  if (!(await requireAuth(root))) return
  root.innerHTML = workShell('Avisos internos', 'Registro de avisos del taller', `
    <p class="notifications-intro">Registro de avisos generado por el servidor. Abre cada aviso para leer su contenido.</p>
    <p data-notifications-status role="status" aria-live="polite" aria-atomic="true" tabindex="-1" style="color:var(--ink-mute);margin:0 0 .25rem"></p>
    <div class="notifications-list" data-notifications-list aria-busy="true">
      <div class="skel" role="status" aria-live="polite">Cargando avisos…</div>
    </div>
    <div data-notifications-pager></div>`)
  const main = root.querySelector('.work-main')

  let currentPage = 1
  let loading = false
  let loadedOnce = false

  async function load(page = 1, { focusPageStatus = false } = {}) {
    if (loading) return false
    const list = main.querySelector('[data-notifications-list]')
    const status = main.querySelector('[data-notifications-status]')
    const pager = main.querySelector('[data-notifications-pager]')
    if (!list || !main.isConnected) return false

    loading = true
    list.setAttribute('aria-busy', 'true')
    pager.querySelectorAll('[data-notifications-page]').forEach(button => { button.disabled = true })
    status.textContent = loadedOnce ? `Cargando página ${page}…` : 'Cargando avisos…'

    try {
      const { data, meta } = await get(`/notifications?page=${page}&pageSize=${NOTIFICATIONS_PAGE_SIZE}`)
      if (!main.isConnected) return false

      const items = Array.isArray(data) ? data : []
      const resolvedPage = Number(meta?.page) || page
      currentPage = resolvedPage
      loadedOnce = true

      list.innerHTML = items.map(n => {
        const { statusKey, label } = notificationStatus(n)
        const statusClass = NOTIFICATION_STATUS_LABEL[statusKey] ? statusKey : 'other'
        const caseNumber = n?.case_number ? String(n.case_number) : ''
        return `<details class="panel notification-item">
          <summary class="notification-summary">
            <span class="notification-subject">${esc(n?.subject || '—')}</span>
            <span class="notification-meta">
              <span class="pill notification-status notification-status--${statusClass}">${esc(label)}</span>
              ${caseNumber ? `<span class="mono">Caso ${esc(caseNumber)}</span>` : ''}
              <time datetime="${esc(n?.created_at || '')}">${esc(fmtDate(n?.created_at))}</time>
            </span>
            <span class="notification-toggle" aria-hidden="true"></span>
          </summary>
          <div class="notification-body">
            <p>${esc(n?.body || '—')}</p>
            ${n?.case_id
              ? `<a class="notification-link" href="#/cases/${esc(encodeURIComponent(n.case_id))}">Abrir caso${caseNumber ? ` ${esc(caseNumber)}` : ''}</a>`
              : '<span class="notification-no-case">Sin caso asociado.</span>'}
          </div>
        </details>`
      }).join('') || `<div class="notice notice-info" role="status">${resolvedPage > 1 ? 'No hay avisos en esta página.' : 'Sin avisos registrados.'}</div>`

      renderPager(meta, page, pager)
      status.textContent = ''
      list.setAttribute('aria-busy', 'false')
      if (focusPageStatus) main.querySelector('[data-notifications-page-status]')?.focus()
      return true
    } catch (e) {
      if (!main.isConnected) return false
      pager.innerHTML = ''
      status.textContent = ''
      list.innerHTML = `<div class="notice notice-error" role="alert"><p>${esc(e?.message || 'No se pudieron cargar los avisos.')}</p><button class="btn btn-ghost" type="button" data-retry-notifications>Reintentar</button></div>`
      list.setAttribute('aria-busy', 'false')
      list.querySelector('[data-retry-notifications]')?.addEventListener('click', () => load(page))
      return false
    } finally {
      loading = false
      if (list.isConnected) list.setAttribute('aria-busy', 'false')
    }
  }

  function renderPager(meta, requestedPage, pager) {
    const total = Number(meta?.total)
    if (!meta || !Number.isFinite(total) || total < 0) {
      pager.innerHTML = ''
      return
    }
    const page = Math.max(1, Number(meta.page) || requestedPage)
    const pageSize = Math.max(1, Number(meta.pageSize) || NOTIFICATIONS_PAGE_SIZE)
    const pages = Math.max(1, Math.ceil(total / pageSize))
    const first = total ? (page - 1) * pageSize + 1 : 0
    const last = Math.min(page * pageSize, total)
    const summary = `${first}–${last} de ${total} avisos · página ${page} de ${pages}`
    pager.innerHTML = `<nav class="row notifications-pagination" aria-label="Paginación de avisos" style="justify-content:space-between;gap:.75rem;align-items:center;flex-wrap:wrap;margin-top:1rem">
      <p data-notifications-page-status tabindex="-1" aria-live="polite" style="color:var(--ink-mute);margin:0">${summary}</p>
      <div class="row" style="gap:.5rem">
        <button class="btn btn-ghost" type="button" data-notifications-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Página anterior de avisos">← Anterior</button>
        <button class="btn btn-ghost" type="button" data-notifications-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Página siguiente de avisos">Siguiente →</button>
      </div>
    </nav>`
    pager.querySelectorAll('[data-notifications-page]').forEach(button => button.addEventListener('click', () => {
      const target = Number(button.dataset.notificationsPage)
      if (button.disabled || loading || target === currentPage) return
      load(target, { focusPageStatus: true })
    }))
  }

  await load(1)
}
