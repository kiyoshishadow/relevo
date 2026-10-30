// Clientes: listado, alta y edición inline contra /api/clients.
import { get, post, patch } from '../api.js'
import { esc, fmtDate } from '../util.js'
import { workShell, requireAuth, onLeave } from '../layout/work.js'
import { clientFormPayload, clientListErrorStatus, clientListStatus } from '../client-form-state.js'
import { animateClientSaveConfirmation, clientSaveChanges } from '../client-save-motion.js'
import gsap from 'gsap'
import '../styles/clients-motion.css'

const listRequests = new WeakMap()
const listState = new WeakMap()
const formMotion = new WeakMap()
const resultMotion = new WeakMap()
const saveMotion = new WeakMap()

function clearResultMotionState(state) {
  if (!state) return
  state.tween?.kill()
  state.tween = null
  if (state.media?.removeEventListener) state.media.removeEventListener('change', state.onChange)
  else state.media?.removeListener?.(state.onChange)
  state.api.set(state.targets, { clearProps: 'opacity,visibility,transform' })
  state.list.classList.remove('is-results-animating')
}

export function stopClientResultMotion(root) {
  const state = resultMotion.get(root)
  if (!state) return
  resultMotion.delete(root)
  clearResultMotionState(state)
}

export function stopClientSaveMotion(root) {
  const state = saveMotion.get(root)
  if (!state) return
  saveMotion.delete(root)
  state.finish?.()
}

// Anima la respuesta ya validada; aria-busy, texto de estado y foco se actualizan antes.
export function animateClientResults(root, list, {
  gsapApi = gsap,
  matchMedia = query => window.matchMedia?.(query),
  exclude = null,
} = {}) {
  stopClientResultMotion(root)
  const targets = [...list.querySelectorAll('[data-client-result], [data-empty-result]')].filter(target => target !== exclude)
  if (!targets.length) return
  const media = matchMedia('(prefers-reduced-motion: reduce)')
  if (!media || media.matches || !list.isConnected) return

  const state = { api: gsapApi, media, targets, list, tween: null, onChange: null }
  const finish = () => {
    if (resultMotion.get(root) !== state) return
    resultMotion.delete(root)
    clearResultMotionState(state)
  }
  state.onChange = event => {
    if (event.matches) finish()
  }
  if (media.addEventListener) media.addEventListener('change', state.onChange)
  else media.addListener?.(state.onChange)
  resultMotion.set(root, state)
  list.classList.add('is-results-animating')

  const empty = targets.length === 1 && targets[0].hasAttribute('data-empty-result')
  state.tween = gsapApi.fromTo(targets,
    empty
      ? { opacity: .65, y: 9, scale: .985 }
      : { opacity: .65, y: 11, scale: .99 },
    {
      opacity: 1, y: 0, scale: 1,
      duration: empty ? .36 : .3,
      stagger: empty ? 0 : .035,
      ease: empty ? 'power3.out' : 'power2.out',
      clearProps: 'opacity,visibility,transform',
      onComplete: finish,
    })
}

export async function clientsView(root) {
  if (!(await requireAuth(root))) return
  if (!root.isConnected) return
  onLeave(() => {
    cancelTray(root, { settle: false })
    stopClientResultMotion(root)
    stopClientSaveMotion(root)
  })
  root.innerHTML = workShell('Clientes', 'Cartera del taller', `<div class="skel">Cargando clientes…</div>`)
  await loadList(root)
}

async function loadList(root, q = '', page = 1, options = {}) {
  const requestId = (listRequests.get(root) || 0) + 1
  listRequests.set(root, requestId)
  listState.set(root, { q, page })
  const main = root.querySelector('.work-main')
  stopClientResultMotion(root)
  stopClientSaveMotion(root)
  const isCurrent = () => listRequests.get(root) === requestId && main?.isConnected && root.contains(main)
  if (!main.querySelector('[data-search]')) {
    main.innerHTML = `
      <div class="clients-directory">
      <div class="clients-heading"><div><p class="clients-kicker">Cartera del taller</p><h1>Clientes</h1><p class="clients-intro">Identifica a cada cliente y mantén sus datos de contacto a mano.</p></div><div class="clients-mark" aria-hidden="true"><span></span><span></span><span></span></div></div>
      <form data-search class="row clients-search">
        <input name="q" value="${esc(q)}" placeholder="Buscar por nombre o documento" style="max-width:280px" aria-label="Buscar clientes">
        <button class="btn btn-ghost" type="submit">Buscar</button>
        <button class="btn btn-primary" type="button" data-new>+ Registrar cliente</button>
      </form>
      <div data-newform class="clients-tray"></div>
      <p data-list-status role="status" aria-live="polite" aria-atomic="true" tabindex="-1" style="color:var(--ink-mute);margin:.25rem 0 .75rem"></p>
      <div data-list aria-busy="true"><div class="skel">Cargando clientes…</div></div></div>`

    main.querySelector('[data-search]').addEventListener('submit', ev => {
      ev.preventDefault()
      loadList(root, String(new FormData(ev.target).get('q') || ''))
    })
    main.querySelector('[data-new]').addEventListener('click', ev => showForm(root, null, ev.currentTarget))
  } else {
    main.querySelector('[data-search] [name="q"]').value = q
  }

  const list = main.querySelector('[data-list]')
  const status = main.querySelector('[data-list-status]')
  const active = document.activeElement
  const focusWasInPagination = active?.matches?.('[data-page]') && main.contains(active)
  status.textContent = options.successMessage
    ? `${options.successMessage} Actualizando la lista…`
    : q ? 'Buscando clientes…' : 'Cargando clientes…'
  list.setAttribute('aria-busy', 'true')

  try {
    const qs = new URLSearchParams({ page: String(page), pageSize: '30' })
    if (q) qs.set('q', q)
    const { data, meta } = await get('/clients?' + qs)
    if (!isCurrent()) return
    list.innerHTML = `
      <div class="clients-table-wrap" role="region" aria-label="Tabla de clientes"><table class="clients-table">
        <thead><tr><th>Nombre</th><th>Documento</th><th>Teléfono</th><th>Correo</th><th>Estado</th><th></th></tr></thead>
        <tbody>${(data || []).map(c => `
          <tr data-client-result data-client-id="${esc(c.id)}">
            <td data-label="Nombre" data-client-field="full_name"><span class="clients-save-marker" data-client-save-marker aria-hidden="true"></span><div class="clients-identity"><span class="clients-avatar" aria-hidden="true">${esc(String(c.full_name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase())}</span><strong>${esc(c.full_name)}</strong></div><span class="clients-save-underline" data-client-save-underline aria-hidden="true"></span></td>
            <td data-label="Documento" class="mono" data-client-field="document_id">${esc(c.document_id || '—')}<span class="clients-save-underline" data-client-save-underline aria-hidden="true"></span></td>
            <td data-label="Teléfono" data-client-field="phone">${esc(c.phone || '—')}<span class="clients-save-underline" data-client-save-underline aria-hidden="true"></span></td>
            <td data-label="Correo" class="clients-email" data-client-field="email">${esc(c.email || '—')}<span class="clients-save-underline" data-client-save-underline aria-hidden="true"></span></td>
            <td data-label="Estado" data-client-field="active"><span class="clients-status ${c.active !== false ? 'is-active' : 'is-inactive'}">${c.active !== false ? 'Activo' : 'Inactivo'}</span><span class="clients-save-underline" data-client-save-underline aria-hidden="true"></span></td>
            <td class="clients-actions"><button class="btn btn-ghost" data-edit="${esc(c.id)}" aria-label="Editar ${esc(c.full_name)}">Editar</button></td>
          </tr>`).join('') || `<tr data-empty-result class="clients-empty-result"><td colspan="6" style="color:var(--ink-mute)">${q ? 'No hay clientes que coincidan con la búsqueda.' : 'Sin clientes todavía: registra el primero.'}</td></tr>`}
        </tbody></table></div>
        ${pagination(meta, page)}`

    main.querySelectorAll('[data-edit]').forEach(btn =>
      btn.addEventListener('click', () => showForm(root, data.find(c => String(c.id) === btn.dataset.edit), btn)))
    bindPagination(main, nextPage => loadList(root, q, nextPage))
    list.setAttribute('aria-busy', 'false')
    const total = Number(meta?.total ?? data?.length ?? 0)
    const pageCount = Math.max(1, Math.ceil(total / (Number(meta?.pageSize) || 30)))
    status.textContent = clientListStatus({ total, page: Number(meta?.page) || page, pageCount, successMessage: options.successMessage })
    if (options.focusStatus) status.focus()
    if (focusWasInPagination) {
      const focusTarget = main.querySelector('[data-page-status]') || main.querySelector('[data-search] [name="q"]')
      focusTarget?.focus()
    }
    let confirmedRow = null
    const confirmation = options.pendingConfirmation
    if (confirmation) {
      const changed = clientSaveChanges(confirmation.snapshot, data, confirmation.id)
      if (changed) {
        confirmedRow = [...list.querySelectorAll('[data-client-result]')]
          .find(row => row.dataset.clientId === changed.id) || null
        if (confirmedRow) {
          const motion = animateClientSaveConfirmation(confirmedRow, changed.fields, {
            gsapApi: gsap,
            onFinish: state => { if (saveMotion.get(root) === state) saveMotion.delete(root) },
          })
          if (motion) saveMotion.set(root, motion)
        }
      }
    }
    animateClientResults(root, list, { exclude: confirmedRow })
  } catch (e) {
    if (!isCurrent()) return
    list.innerHTML = `<div class="notice notice-error" role="alert"><p>${esc(e?.message || 'No se pudieron cargar los clientes.')}</p><button class="btn btn-ghost" type="button" data-retry-list>Reintentar lectura</button></div>`
    list.setAttribute('aria-busy', 'false')
    status.textContent = clientListErrorStatus(options.successMessage)
    list.querySelector('[data-retry-list]')?.addEventListener('click', () => {
      loadList(root, q, page, { successMessage: options.successMessage, focusStatus: options.focusStatus, pendingConfirmation: options.pendingConfirmation })
    })
    if (options.focusStatus) status.focus()
    if (focusWasInPagination) main.querySelector('[data-search] [name="q"]')?.focus()
  }
}

function pagination(meta, requestedPage) {
  if (!meta) return ''
  const page = Number(meta.page) || requestedPage
  const pageSize = Number(meta.pageSize) || 30
  const total = Number(meta.total) || 0
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = total ? (page - 1) * pageSize + 1 : 0
  const last = Math.min(page * pageSize, total)
  return `<nav class="row" aria-label="Paginación de clientes" style="justify-content:space-between;gap:.75rem;align-items:center;margin-top:.8rem">
    <p data-page-status tabindex="-1" aria-live="polite" style="color:var(--ink-mute);margin:0">${first}–${last} de ${total} · página ${page} de ${pages}</p>
    <div class="row" style="gap:.5rem"><button class="btn btn-ghost" type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Página anterior de clientes">← Anterior</button>
    <button class="btn btn-ghost" type="button" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Página siguiente de clientes">Siguiente →</button></div>
  </nav>`
}

function bindPagination(main, onPage) {
  main.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', async () => {
    if (!button.disabled) {
      await onPage(Number(button.dataset.page))
      main.querySelector('[data-page-status]')?.focus()
    }
  }))
}

// ---------- Bandeja de expediente: apertura y cierre del formulario ----------
/* El formulario crece en el flujo, bajo la búsqueda: no flota ni tapa controles.
   El movimiento es solo presentación; los campos quedan utilizables desde el
   primer fotograma y el envío nunca espera a la animación. Cualquier reemplazo
   del formulario o de la vista cancela el vuelo y limpia los estilos en línea
   para que no reviva contenido viejo ni quede recortado. */
function reduceMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

function motionState(root) {
  let state = formMotion.get(root)
  if (!state) {
    state = { seq: 0, tween: null, opener: null, formId: 0 }
    formMotion.set(root, state)
  }
  return state
}

// Reposo legible: sin alto recortado ni opacidad heredada de un vuelo.
function settleTray(box, panel) {
  if (!box) return
  box.classList.remove('is-tray-moving')
  gsap.set(box, { clearProps: 'height,overflow' })
  if (panel) gsap.set(panel, { clearProps: 'opacity,visibility,transform' })
}

function cancelTray(root, { settle = true } = {}) {
  const state = formMotion.get(root)
  if (!state) return
  state.seq += 1
  state.tween?.kill()
  state.tween = null
  if (settle) {
    const box = root.querySelector('[data-newform]')
    settleTray(box, box?.firstElementChild)
  }
}

function openTray(root, box, panel) {
  const state = motionState(root)
  state.tween?.kill()
  state.tween = null
  const seq = ++state.seq
  settleTray(box, panel)
  if (!panel || reduceMotion() || !box.isConnected) return
  const height = box.offsetHeight
  if (!height) return
  box.classList.add('is-tray-moving')
  const timeline = gsap.timeline({
    defaults: { ease: 'power3.out' },
    onComplete: () => {
      if (state.seq !== seq) return
      state.tween = null
      settleTray(box, panel)
    },
  })
  timeline.fromTo(box, { height: 0 }, { height, duration: .34 }, 0)
    .fromTo(panel, { y: -9, opacity: 0 }, { y: 0, opacity: 1, duration: .3, clearProps: 'opacity,transform' }, .06)
  state.tween = timeline
}

function closeTray(root, box, panel) {
  const state = motionState(root)
  const opener = state.opener
  state.tween?.kill()
  state.tween = null
  const seq = ++state.seq
  const finish = () => {
    if (state.seq !== seq) return
    state.tween = null
    if (!box.isConnected || !root.contains(box)) return
    box.replaceChildren()
  }
  // El foco vuelve al botón que abrió la bandeja de inmediato: el teclado no
  // espera a que termine la animación.
  if (box.isConnected && root.contains(box)) {
    if (opener?.isConnected && root.contains(opener)) opener.focus()
    else (root.querySelector('[data-new]') || root.querySelector('[data-search] [name="q"]'))?.focus()
  }
  if (!panel || reduceMotion()) {
    settleTray(box, panel)
    finish()
    return
  }
  box.classList.add('is-tray-moving')
  const timeline = gsap.timeline({
    defaults: { ease: 'power2.in' },
    onComplete: () => {
      if (state.seq !== seq) return
      settleTray(box, panel)
      finish()
    },
  })
  timeline.to(panel, { y: -9, autoAlpha: 0, duration: .2 }, 0)
    .to(box, { height: 0, duration: .26, ease: 'power2.inOut' }, .05)
  state.tween = timeline
}

function showForm(root, client, opener) {
  const box = root.querySelector('[data-newform]')
  if (!box) return
  // Un envío pendiente es dueño de la bandeja: otra pulsación de Registrar o
  // Editar no sustituye el formulario ni descarta lo que el usuario escribió.
  // La apertura animada no bloquea: solo lo hace el submit deshabilitado.
  if (box.querySelector('[data-form] button[type=submit]')?.disabled) return
  const state = motionState(root)
  state.opener = opener || root.querySelector('[data-new]') || null
  const formId = ++state.formId
  box.innerHTML = `
    <section class="panel clients-form">
      <h3 tabindex="-1">${client ? 'Editar cliente' : 'Registrar cliente'}</h3>
      <p class="clients-form-note" style="margin:-.35rem 0 1rem;color:var(--clients-muted);font-size:.85rem">Obligatorios: nombre (2–160 caracteres), teléfono (5–40) y correo válido (3–254).</p>
      <form data-form class="grid2">
        <div class="field"><label for="client-full-name">Nombre completo <span aria-hidden="true">*</span></label><input id="client-full-name" name="full_name" value="${esc(client?.full_name || '')}" minlength="2" maxlength="160" required aria-required="true"></div>
        <div class="field"><label for="client-document-id">Documento de identidad</label><input id="client-document-id" name="document_id" value="${esc(client?.document_id || '')}" maxlength="60"></div>
        <div class="field"><label for="client-phone">Teléfono <span aria-hidden="true">*</span></label><input id="client-phone" name="phone" value="${esc(client?.phone || '')}" minlength="5" maxlength="40" autocomplete="tel" required aria-required="true"></div>
        <div class="field"><label for="client-email">Correo <span aria-hidden="true">*</span></label><input id="client-email" name="email" type="email" value="${esc(client?.email || '')}" minlength="3" maxlength="254" autocomplete="email" required aria-required="true"></div>
        <div class="field"><label for="client-address">Dirección</label><input id="client-address" name="address" value="${esc(client?.address || '')}" maxlength="300"></div>
        ${client ? `<div class="field"><label for="client-active">Estado</label><select id="client-active" name="active">
          <option value="true" ${client.active !== false ? 'selected' : ''}>Activo</option>
          <option value="false" ${client.active === false ? 'selected' : ''}>Inactivo</option></select></div>` : ''}
        <div class="row" style="grid-column:1/-1">
          <button class="btn btn-primary" type="submit">${client ? 'Guardar cambios' : 'Registrar'}</button>
          <button class="btn btn-ghost" type="button" data-cancel>Cancelar</button>
        </div>
      </form>
      <div data-err></div>
    </section>`
  const panel = box.firstElementChild
  const cancelBtn = box.querySelector('[data-cancel]')
  const submitBtn = box.querySelector('button[type=submit]')
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    closeTray(root, box, panel)
  }
  cancelBtn.addEventListener('click', close)
  // Escape cierra la bandeja sin enviar; durante el envío no interrumpe la petición.
  panel.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape' || submitBtn.disabled || ev.target.closest?.('select')) return
    ev.preventDefault()
    close()
  })
  openTray(root, box, panel)
  panel.querySelector('h3')?.focus({ preventScroll: true })
  const behavior = reduceMotion() ? 'auto' : 'smooth'
  box.scrollIntoView({ behavior, block: 'nearest' })
  const form = box.querySelector('[data-form]')
  form.addEventListener('submit', ev => {
    ev.preventDefault()
    const f = Object.fromEntries(new FormData(form))
    const payload = clientFormPayload(f, Boolean(client))
    const btn = form.querySelector('button[type=submit]')
    box.querySelector('[data-err]').innerHTML = ''
    btn.disabled = true
    cancelBtn.disabled = true
    const context = listState.get(root) || { q: '', page: 1 }
    const refreshQuery = client ? context.q : ''
    const refreshPage = client ? context.page : 1
    ;(client ? patch('/clients/' + client.id, payload) : post('/clients', payload))
      .then(() => {
        if (!box.isConnected || !root.contains(box)) return
        const successMessage = client ? 'Cambios del cliente guardados.' : 'Cliente registrado.'
        closed = true
        // Solo se recoge el formulario que aún es el actual: si otra acción ya
        // lo sustituyó, no se borra ni se resucita el expediente viejo.
        if (state.formId === formId) {
          cancelTray(root)
          box.replaceChildren()
        }
        const status = root.querySelector('[data-list-status]')
        status.textContent = successMessage
        status.focus()
        loadList(root, refreshQuery, refreshPage, {
          successMessage,
          focusStatus: true,
          pendingConfirmation: client ? { id: client.id, snapshot: { ...client } } : null,
        })
      })
      .catch(e => {
        if (!box.isConnected || !root.contains(box)) return
        // La bandeja ya pertenece a otro expediente: el error anterior no se
        // escribe en el formulario nuevo ni reactiva botones ajenos.
        if (state.formId !== formId) return
        // Ningún vuelo en curso debe recortar el aviso ni los botones.
        cancelTray(root)
        box.querySelector('[data-err]').innerHTML = `<div class="notice notice-error" role="alert">${esc(e?.message || 'No se pudo guardar.')}</div>`
        btn.disabled = false
        cancelBtn.disabled = false
      })
  })
}
