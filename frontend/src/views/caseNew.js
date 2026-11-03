// Crear caso: requiere cliente y terminal existentes; devuelve número y clave una sola vez.
import { get, post } from '../api.js'
import { esc } from '../util.js'
import { workShell, requireAuth, onLeave } from '../layout/work.js'
import { loadAllPages } from '../paged-data.js'
import { INTAKE_FIELDS, activeIntakeClients, intakeErrorElement, intakeState, intakeTerminalsForClient } from '../intake-state.js'
import { createIntakeDevicePreview } from '../intake-device-preview.js'
import { bindIntakeReceiptPrint, intakeReceiptMarkup } from '../intake-receipt.js'
import '../styles/intake.css'
import gsap from 'gsap'

export function createIntakeErrorPulse({ gsapApi = gsap, mediaQuery } = {}) {
  let tween = null
  let target = null
  let disposed = false

  const clear = () => {
    tween?.kill()
    tween = null
    if (target) {
      const previous = target
      target = null
      previous.classList.remove('intake-error-pulse')
      gsapApi.set(previous, { clearProps: 'boxShadow,transform' })
    }
  }
  const onMotionChange = event => { if (event.matches) clear() }
  if (mediaQuery?.addEventListener) mediaQuery.addEventListener('change', onMotionChange)
  else mediaQuery?.addListener?.(onMotionChange)

  return {
    play(nextTarget) {
      clear()
      if (disposed || !nextTarget || mediaQuery?.matches) return
      target = nextTarget
      target.classList.add('intake-error-pulse')
      const pulseTarget = target
      tween = gsapApi.fromTo(pulseTarget,
        { boxShadow: '0 0 0 0 rgba(190, 137, 38, 0)', scale: 1 },
        {
          boxShadow: '0 0 0 5px rgba(190, 137, 38, .38)', scale: 1.012,
          duration: .24, repeat: 1, yoyo: true, ease: 'power2.out',
          clearProps: 'boxShadow,transform',
          onComplete: () => {
            if (target !== pulseTarget) return
            tween = null
            target = null
            pulseTarget.classList.remove('intake-error-pulse')
            gsapApi.set(pulseTarget, { clearProps: 'boxShadow,transform' })
          },
        })
    },
    clear,
    dispose() {
      if (disposed) return
      disposed = true
      if (mediaQuery?.removeEventListener) mediaQuery.removeEventListener('change', onMotionChange)
      else mediaQuery?.removeListener?.(onMotionChange)
      clear()
    },
  }
}

export function focusFirstInvalidIntakeField(form, state, pulse) {
  const field = INTAKE_FIELDS.find(candidate => state.errors[candidate.name])
  if (!field) return false
  form.elements[field.name].focus()
  pulse.play(form.querySelector(`[data-intake-field="${field.key}"]`))
  return true
}

export async function newCaseView(root) {
  if (!(await requireAuth(root))) return
  root.innerHTML = workShell('Nuevo caso', 'Recepción del terminal', '')
  const main = root.querySelector('.work-main')
  main.classList.add('intake-page')
  let clients = [], terminals = [], technicians = []

  main.innerHTML = `
    <h1>Recepción de un terminal</h1>
    <div class="intake-catalogs" data-catalogs></div>
    <section class="intake-workflow" aria-label="Progreso de recepción">
      <div class="intake-workflow__head"><span>SECUENCIA DE RECEPCIÓN</span><b data-intake-count>0 / 3</b></div>
      <ol class="intake-rail">
        <li data-intake-step="client" aria-current="step"><i>01</i><span>Cliente</span></li>
        <li data-intake-step="terminal"><i>02</i><span>Equipo</span></li>
        <li data-intake-step="problem"><i>03</i><span>Problema reportado</span></li>
      </ol>
      <div class="intake-meter" aria-hidden="true"><span data-intake-fill></span></div>
      <p class="intake-workflow__hint" data-intake-hint aria-live="polite">Identifica al cliente para iniciar el registro.</p>
    </section>
    <form data-newcase class="panel intake-form" novalidate>
      <p class="notice notice-error intake-validation" data-validation role="alert" hidden></p>
      <div class="field" data-intake-field="client"><label for="case-client">Cliente</label>
        <select id="case-client" name="client_id" required aria-describedby="case-client-error" disabled>
          <option value="">Elegir cliente…</option>
          ${clients.map(c => `<option value="${esc(c.id)}">${esc(c.full_name)} ${c.document_id ? `(${esc(c.document_id)})` : ''}</option>`).join('')}
        </select>
        <p id="case-client-error" class="intake-field-error" hidden></p>
      </div>
      <div class="field" data-intake-field="terminal"><label for="case-terminal">Terminal</label>
        <select id="case-terminal" name="terminal_id" required aria-describedby="case-terminal-error" disabled>
          <option value="">Elegir equipo…</option>
          ${terminals.map(t => `<option value="${esc(t.id)}">${esc(t.brand)} ${esc(t.model)} — IMEI ${esc((t.imeis || [])[0] || '—')}</option>`).join('')}
        </select>
        <p id="case-terminal-error" class="intake-field-error" hidden></p>
      </div>
      <div data-intake-preview hidden></div>
      <div class="field" data-intake-field="problem"><label for="case-reported-problem">Problema reportado por el cliente</label><textarea id="case-reported-problem" name="reported_problem" required aria-describedby="case-reported-problem-help case-reported-problem-error" placeholder="En palabras del cliente"></textarea><small id="case-reported-problem-help">Escribe al menos 3 caracteres.</small><p id="case-reported-problem-error" class="intake-field-error" hidden></p></div>
      <div class="field"><label for="case-technician">Técnico asignado (opcional)</label>
        <select id="case-technician" name="technician_id" disabled><option value="">Sin asignar</option>
        ${technicians.map(u => `<option value="${esc(u.id)}">${esc(u.full_name || u.email)}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-primary" type="submit" disabled>Abrir caso</button>
    </form>
    <div data-result></div>
  `

  const form = main.querySelector('[data-newcase]')
  const result = main.querySelector('[data-result]')
  const intakeFields = INTAKE_FIELDS.map(({ key }) => form.querySelector(`[data-intake-field="${key}"]`))
  const intakeSteps = INTAKE_FIELDS.map(({ key }) => main.querySelector(`[data-intake-step="${key}"]`))
  const intakeFill = main.querySelector('[data-intake-fill]')
  const intakeCount = main.querySelector('[data-intake-count]')
  const intakeHint = main.querySelector('[data-intake-hint]')
  const catalogs = main.querySelector('[data-catalogs]')
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  const devicePreview = createIntakeDevicePreview({ host: form.querySelector('[data-intake-preview]'), motionQuery })
  const validation = form.querySelector('[data-validation]')
  const submitButton = form.querySelector('button[type=submit]')
  const errorPulse = createIntakeErrorPulse({ mediaQuery: motionQuery })
  const reducedMotion = () => motionQuery.matches
  let progressTween, stepTween, introTween, submitTween, lastActiveIndex = -1
  let submitting = false
  let viewActive = true
  let catalogLoading = false, validationAttempted = false
  const isActive = () => viewActive && main.isConnected
  const readState = () => intakeState(
    Object.fromEntries(INTAKE_FIELDS.map(field => [field.name, form.elements[field.name].value])),
    { clients, terminals },
  )
  function renderErrors(state) {
    for (const field of INTAKE_FIELDS) {
      const control = form.elements[field.name]
      const error = intakeErrorElement(form, field)
      const message = validationAttempted ? state.errors[field.name] || '' : ''
      error.textContent = message
      error.hidden = !message
      if (message) control.setAttribute('aria-invalid', 'true')
      else control.removeAttribute('aria-invalid')
    }
    const count = validationAttempted ? Object.keys(state.errors).length : 0
    validation.hidden = !count
    validation.textContent = count ? `Revisa ${count === 1 ? 'el campo señalado' : `los ${count} campos señalados`} antes de abrir el caso.` : ''
  }
  const updateIntake = animate => {
    const state = readState()
    const complete = state.steps.map(step => step.complete)
    const activeIndex = state.steps.findIndex(step => step.key === state.currentKey)
    intakeCount.textContent = `${state.done} / 3`
    intakeHint.textContent = state.hint
    intakeSteps.forEach((step, index) => {
      step.classList.toggle('is-complete', complete[index])
      step.classList.toggle('is-current', index === activeIndex)
      if (index === activeIndex) step.setAttribute('aria-current', 'step')
      else step.removeAttribute('aria-current')
    })
    intakeFields.forEach((field, index) => {
      field.classList.toggle('is-complete', complete[index])
      field.classList.toggle('is-current', index === activeIndex)
    })
    progressTween?.kill()
    if (!animate || reducedMotion()) gsap.set(intakeFill, { scaleX: state.progress })
    else progressTween = gsap.to(intakeFill, { scaleX: state.progress, duration: .35, ease: 'power3.out' })
    if (activeIndex !== lastActiveIndex) {
      stepTween?.kill()
      if (animate && !reducedMotion() && activeIndex !== -1) stepTween = gsap.fromTo(intakeSteps[activeIndex], { scale: .96 }, { scale: 1, duration: .25, ease: 'power2.out', clearProps: 'transform' })
    }
    lastActiveIndex = activeIndex
    renderErrors(state)
  }
  function fillOptions(select, rows, placeholder, label) {
    const selected = select.value
    select.innerHTML = `<option value="">${esc(placeholder)}</option>` + rows.map(row => `<option value="${esc(row.id)}">${esc(label(row))}</option>`).join('')
    if (rows.some(row => String(row.id) === selected)) select.value = selected
    select.disabled = !rows.length
  }
  function syncTerminalOptions() {
    const clientId = form.elements.client_id.value
    const compatible = intakeTerminalsForClient(terminals, clientId)
    fillOptions(
      form.elements.terminal_id,
      compatible,
      clientId ? 'Elegir equipo de este cliente…' : 'Elegir equipo…',
      terminal => `${terminal.brand} ${terminal.model} — IMEI ${(terminal.imeis || [])[0] || '—'}`,
    )
    const chosen = compatible.find(terminal => String(terminal.id) === String(form.elements.terminal_id.value))
    devicePreview.select(chosen, clientId)
  }
  async function reloadCatalogs(focusResult = false) {
    if (catalogLoading || submitting || !isActive()) return
    catalogLoading = true
    devicePreview.clear()
    submitButton.disabled = true
    catalogs.setAttribute('aria-busy', 'true')
    catalogs.innerHTML = '<p role="status" aria-live="polite">Cargando clientes y equipos… Se conserva lo que hayas escrito.</p>'
    const responses = await Promise.allSettled([
      loadAllPages(get, '/clients', 100, { active: true }), loadAllPages(get, '/terminals'), loadAllPages(get, '/technicians'),
    ])
    if (!isActive()) return
    const failures = []
    if (responses[0].status === 'fulfilled') clients = activeIntakeClients(responses[0].value)
    else failures.push('No se pudieron cargar los clientes.')
    if (responses[1].status === 'fulfilled') terminals = responses[1].value
    else failures.push('No se pudieron cargar los equipos.')
    if (responses[2].status === 'fulfilled') technicians = responses[2].value
    else failures.push('No se pudo actualizar la lista opcional de técnicos; puedes continuar sin asignar.')
    fillOptions(form.elements.client_id, clients, 'Elegir cliente…', client => `${client.full_name}${client.document_id ? ` (${client.document_id})` : ''}`)
    syncTerminalOptions()
    fillOptions(form.elements.technician_id, technicians, 'Sin asignar', user => user.full_name || user.email)
    catalogLoading = false
    catalogs.removeAttribute('aria-busy')
    submitButton.disabled = !clients.length || !terminals.length
    const empty = []
    if (!clients.length && responses[0].status === 'fulfilled') empty.push('Registra un cliente para abrir el caso.')
    if (!terminals.length && responses[1].status === 'fulfilled') empty.push('Registra un equipo para abrir el caso.')
    const messages = [...failures, ...empty]
    catalogs.innerHTML = messages.length ? `<div class="notice ${failures.length ? 'notice-error' : 'notice-info'}">
      <div role="${failures.length ? 'alert' : 'status'}" tabindex="-1" data-catalog-message>${messages.map(message => `<p>${esc(message)}</p>`).join('')}</div>
      <div class="intake-catalogs__actions"><button class="btn btn-ghost" type="button" data-retry-catalogs>${failures.length ? 'Reintentar carga' : 'Actualizar catálogos'}</button>
      ${!clients.length ? '<a href="#/clients">Registrar cliente</a>' : ''}${!terminals.length ? '<a href="#/terminals">Registrar equipo</a>' : ''}</div></div>` : '<p role="status" tabindex="-1" data-catalog-message>Clientes y equipos disponibles. Puedes completar los campos en cualquier orden.</p>'
    updateIntake(false)
    if (focusResult) catalogs.querySelector('[data-catalog-message]')?.focus({ preventScroll: true })
  }
  const onIntakeInput = () => updateIntake(true)
  const onIntakeChange = event => {
    if (event.target === form.elements.client_id || event.target === form.elements.terminal_id) syncTerminalOptions()
    updateIntake(true)
  }
  const onMotionChange = () => {
    progressTween?.kill(); stepTween?.kill(); introTween?.kill(); submitTween?.kill()
    gsap.set([main.querySelector('.intake-workflow'), form, result], { clearProps: 'transform,opacity,visibility' })
    updateIntake(false)
  }
  catalogs.addEventListener('click', event => {
    if (event.target.closest('[data-retry-catalogs]')) reloadCatalogs(true)
  })
  form.addEventListener('input', onIntakeInput)
  form.addEventListener('change', onIntakeChange)
  motionQuery.addEventListener('change', onMotionChange)
  updateIntake(false)
  if (!reducedMotion()) {
    introTween = gsap.fromTo([main.querySelector('.intake-workflow'), form],
      { autoAlpha: 0, y: 14 },
      { autoAlpha: 1, y: 0, duration: .52, stagger: .08, ease: 'power3.out', clearProps: 'all' })
  }
  onLeave(() => {
    viewActive = false
    progressTween?.kill()
    stepTween?.kill()
    introTween?.kill()
    submitTween?.kill()
    errorPulse.clear()
    form.removeEventListener('input', onIntakeInput)
    form.removeEventListener('change', onIntakeChange)
    motionQuery.removeEventListener('change', onMotionChange)
    errorPulse.dispose()
    devicePreview.dispose()
  })
  const showResult = (markup, selector, hideForm = false) => {
    if (!isActive()) return
    result.innerHTML = markup
    result.querySelector(selector)?.focus()
    submitTween?.kill()
    if (reducedMotion()) {
      if (hideForm) form.hidden = true
      return
    }
    submitTween = gsap.timeline({ defaults: { ease: 'power2.out' } })
    if (hideForm) submitTween.to(form, {
      autoAlpha: 0, y: -6, duration: .16,
      onComplete: () => { form.hidden = true },
    })
    submitTween.fromTo(result, { autoAlpha: 0, y: 8 }, {
      autoAlpha: 1, y: 0, duration: .24,
      clearProps: 'transform,opacity,visibility',
    }, hideForm ? '<' : 0)
  }
  form.addEventListener('submit', ev => {
    ev.preventDefault()
    if (submitting || catalogLoading || !clients.length || !terminals.length) return
    errorPulse.clear()
    validationAttempted = true
    const state = readState()
    renderErrors(state)
    if (Object.keys(state.errors).length) {
      focusFirstInvalidIntakeField(form, state, errorPulse)
      return
    }
    submitting = true
    const f = new FormData(form)
    const btn = form.querySelector('button[type=submit]')
    btn.disabled = true
    btn.setAttribute('aria-busy', 'true')
    btn.textContent = 'Abriendo…'
    form.setAttribute('aria-busy', 'true')
    result.innerHTML = '<div class="notice" role="status" tabindex="-1" aria-live="polite">Registrando la recepción…</div>'
    result.querySelector('[role="status"]').focus()
    if (!reducedMotion()) {
      submitTween?.kill()
      submitTween = gsap.fromTo(result, { autoAlpha: 0, y: 5 }, {
        autoAlpha: 1, y: 0, duration: .18, ease: 'power2.out',
        clearProps: 'transform,opacity,visibility',
      })
    }
    post('/cases', {
      client_id: f.get('client_id'),
      terminal_id: f.get('terminal_id'),
      reported_problem: f.get('reported_problem'),
      ...(f.get('technician_id') ? { technician_id: f.get('technician_id') } : {}),
    }).then(({ data }) => {
      if (!viewActive) return
      devicePreview.clear()
      const client = clients.find(item => String(item.id) === String(f.get('client_id')))
      const terminal = terminals.find(item => String(item.id) === String(f.get('terminal_id')))
      showResult(`
        <div class="notice notice-ok" role="status" tabindex="-1" aria-live="polite">
          <p><b>Caso abierto.</b> Imprime o entrega este comprobante al cliente ahora. La clave se muestra una sola vez.</p>
        </div>
        ${intakeReceiptMarkup({ caseNumber: data.case_number, trackingToken: data.tracking_token, clientName: client?.full_name, terminal, reportedProblem: f.get('reported_problem'), receivedAt: data.created_at })}
        <a class="btn btn-ghost" href="#/cases/${esc(data.id)}">Ir al caso del taller</a>`, '[role="status"]', true)
      onLeave(bindIntakeReceiptPrint(result))
    }).catch(e => {
      if (!viewActive) return
      showResult(`<div class="notice notice-error" role="alert" tabindex="-1">${esc(e?.message || 'No se pudo abrir el caso.')}</div>`, '[role="alert"]')
      submitting = false
      btn.disabled = false
      btn.removeAttribute('aria-busy')
      btn.textContent = 'Abrir caso'
      form.removeAttribute('aria-busy')
    })
  })
  await reloadCatalogs()
}
