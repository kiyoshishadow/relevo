// Seguimiento público del caso: solo lo que devuelve POST /api/track.
// La clave viaja por almacenamiento efímero de sesión (no por la URL);
// al agotarse la credencial, la vista pide los datos de nuevo en formulario.
import { post } from '../api.js'
import { esc, fmtDate, fmtMoney, pill } from '../util.js'
import { publicShell, bindLogout, ensureSessionNav } from '../layout/public.js'
import { navigate, onLeave } from '../router.js'
import { field } from '../ui.js'
import { caseFlowMarkup } from '../components/case-flow.js'
import { phoneSvgHtml, toggleAssembly, describeAssembly } from '../components/phone.js'
import { resolveDeviceProfile } from '../components/device-profiles.js'
import gsap from 'gsap'

const KEY = 'relevo:track-cred'

export const TRACK_STORAGE_MESSAGE = 'No pudimos guardar la clave en este navegador, así que no abrimos la consulta. Activa el almacenamiento del sitio o prueba en otra ventana; los datos siguen solo en este formulario.'

export function setTrackSceneReady(host, ready) {
  if (ready) {
    host.dataset.deviceLabReady = 'true'
    host.setAttribute('data-3d-ready', 'true')
  } else {
    delete host.dataset.deviceLabReady
    host.removeAttribute('data-3d-ready')
  }
}

// El acceso a window.sessionStorage puede lanzar (modo privado, cookies
// bloqueadas). Nunca debe romper la vista ni el envío del formulario.
export function getSessionStorage() {
  try {
    const storage = globalThis.window?.sessionStorage
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return null
    return storage
  } catch {
    return null
  }
}

export function persistTrackCredential(storage, values) {
  const n = String(values?.n ?? '').trim()
  const t = String(values?.t ?? '').trim()
  if (!storage || !n || !t) return false
  try {
    storage.setItem(KEY, JSON.stringify({ n, t }))
    return true
  } catch {
    return false
  }
}

export function announceStorageFailure(notice, message = TRACK_STORAGE_MESSAGE) {
  if (!notice) return false
  notice.hidden = false
  notice.textContent = message
  try { notice.focus() } catch { /* sin foco programable: el aviso sigue visible */ }
  return true
}

// Guarda la credencial y solo entonces navega. Si el almacenamiento falla,
// conserva el formulario y enfoca el aviso inline.
export function submitStoredTrackCredential({ storage, notice, values, go }) {
  if (!persistTrackCredential(storage, values)) {
    announceStorageFailure(notice)
    return false
  }
  go()
  return true
}

export function trackResultHtml(data) {
  const terminal = [data.terminal?.brand, data.terminal?.model].filter(Boolean).join(' ')
  const profile = resolveDeviceProfile(data.terminal?.brand, data.terminal?.model)
  const receiptFields = [
    ['Equipo recibido', terminal || 'Terminal registrado'],
    ['Problema indicado', data.reported_problem],
    ['Condición al ingreso', data.terminal?.initial_condition],
    ['Accesorios recibidos', data.terminal?.accessories],
  ].filter(([, value]) => String(value ?? '').trim())

  return `
    <div class="track-result">
      <section class="panel track-summary" aria-label="Resumen del caso">
        <div class="track-summary-status">
          <span class="track-kicker">Estado actual</span>
          ${pill(data.status)}
        </div>
        <p class="track-summary-note">El avance que ves aquí corresponde al historial registrado por el taller.</p>
      </section>
      <details class="track-receipt" data-track-receipt>
        <summary><span><strong>Comprobante de recepción</strong><small>Consulta qué equipo y qué reporte quedaron registrados al recibirlo.</small></span><span class="track-receipt__action">Ver comprobante</span></summary>
        <div class="track-receipt__body">
          <div class="track-receipt__heading"><div><span>RELEVO · RECEPCIÓN</span><h2>Ficha de ingreso</h2></div><div class="track-receipt__number"><small>NÚMERO DE CASO</small><strong>${esc(data.case_number || '—')}</strong></div></div>
          <p class="track-receipt__date">Recibido el ${esc(fmtDate(data.received_at))}</p>
          <dl>${receiptFields.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
          <p class="track-receipt__note">Esta ficha refleja la información registrada al recibir el equipo. No sustituye el comprobante físico firmado.</p>
          <button class="btn btn-ghost" type="button" data-track-print>Imprimir comprobante</button>
        </div>
      </details>
      <section class="track-device-view" aria-label="Vista interactiva del equipo">
        <div class="device-lab-stage track-device-view__scene" data-track-device-stage>
          <div class="device-stage-orbit" aria-hidden="true"><i></i><i></i><i></i></div>
          <div class="phone-fallback"><div class="phone-fallback-inner">${phoneSvgHtml({ id: 'track-terminal-phone', profile })}</div></div>
          <div class="device-stage-tag"><span class="device-stage-signal"></span><span data-track-profile-tag>${profile.exact ? 'Perfil exterior identificado' : 'Vista ilustrativa'}</span></div>
          <div class="device-stage-mark" aria-hidden="true"><span>R</span><i></i><i></i></div>
        </div>
        <div class="track-device-view__details">
          <span class="track-kicker">PERFIL EXTERIOR</span>
          <h2>${esc(terminal || 'Terminal registrado')}</h2>
          <p>${profile.exact ? 'Exterior con rasgos reconocibles del modelo.' : 'Este modelo se representa con una silueta ilustrativa.'} Los componentes internos son una representación esquemática compartida.</p>
          <div class="track-focus-readout" data-track-focus-readout aria-live="polite">
            <span>MOVIMIENTO REGISTRADO</span>
            <strong data-track-focus-label>Estado actual</strong>
            <time data-track-focus-time hidden></time>
          </div>
          <button class="btn btn-primary device-assembly-toggle" type="button" data-track-device-toggle aria-pressed="true">Explorar las capas</button>
          <p class="device-lab-status" data-track-device-status aria-live="polite">Vista posterior del equipo. Arrastra para inspeccionarlo.</p>
        </div>
      </section>
      ${caseFlowMarkup(data.status, data.history || [], { interactive: true })}
      ${data.diagnosis ? `
      <section class="panel">
        <h2>Diagnóstico</h2>
        <p>${esc(typeof data.diagnosis === 'string' ? data.diagnosis : data.diagnosis.text || '')}</p>
      </section>` : ''}
      ${(data.quote || data.quotes?.[0]) ? (() => {
        const q = data.quote || data.quotes[0]
        return `
      <section class="panel">
        <h2>Cotización</h2>
        <div class="table-wrap" tabindex="0" role="region" aria-label="Tabla de conceptos de la cotización"><table>
          <thead><tr><th>Concepto</th><th>Cant.</th><th>Precio unit.</th></tr></thead>
          <tbody>${(q.items || []).map(it => `
            <tr><td>${esc(it.description)}</td><td>${esc(it.quantity)}</td><td>${fmtMoney(it.unit_price)}</td></tr>`).join('')}
          </tbody>
        </table></div>
        <p class="mt"><b>Total: ${fmtMoney(q.total ?? q.amount ?? '')}</b></p>
      </section>`})() : ''}
    </div>`
}

export function trackCredForm(pageSel = '.page') {
  return `
    <h1 tabindex="-1">Detalle del caso</h1>
    <form data-track class="panel track-credential-form" novalidate aria-describedby="track-credential-help" style="max-width:440px">
      <p id="track-credential-help">Escribe los datos tal como aparecen en la ficha que te entregaron.</p>
      ${field('Número de caso', `<input id="track-case-number" name="case_number" required autocomplete="off" placeholder="p. ej. CAS-2026-0001" aria-describedby="track-case-number-error" aria-invalid="false"><span class="track-field-error" id="track-case-number-error" aria-live="polite"></span>`)}
      ${field('Clave de seguimiento', `<input id="track-token" name="token" required autocomplete="off" aria-describedby="track-token-error" aria-invalid="false"><span class="track-field-error" id="track-token-error" aria-live="polite"></span>`)}
      <p class="notice notice-error" id="track-credential-storage-error" data-track-storage-notice role="alert" tabindex="-1" hidden></p>
      <button class="btn btn-primary" type="submit">Consultar</button>
    </form>
    <div data-err></div>`
}

export function trackCredentialError(name, value) {
  if (String(value ?? '').trim()) return ''
  return name === 'case_number'
    ? 'Escribe el número que aparece en tu ficha.'
    : 'Escribe la clave de seguimiento de tu ficha.'
}

export async function trackView(root) {
  await ensureSessionNav()
  root.innerHTML = publicShell(`<div class="page"><div class="skel" role="status">Consultando el servidor…</div></div>`, { navTrack: false })
  bindLogout(root)
  const page = root.querySelector('.page')

  let cred = null
  const storage = getSessionStorage()
  try { cred = JSON.parse(storage?.getItem(KEY) || 'null') } catch { cred = null }
  try { storage?.removeItem(KEY) } catch { /* almacenamiento bloqueado: se pide la clave de nuevo */ }

  if (!cred || !cred.n || !cred.t) {
    page.innerHTML = trackCredForm()
    bindCredForm(page)
    return
  }

  try {
    const { data } = await post('/track', { case_number: cred.n, token: cred.t })
    page.innerHTML = `
      <h1 tabindex="-1">Caso ${esc(cred.n)}</h1>
      ${trackResultHtml(data)}
      <p class="track-privacy">Por privacidad, la clave de seguimiento no quedó guardada ni en la URL. Para revisar de nuevo, consulta desde el portal.</p>`
    bindLogout(root)
    mountTrackedDevice(page, data)
    onLeave(bindReceiptPrint(page))
  } catch (e) {
    page.innerHTML = `
      <h1 tabindex="-1">Detalle del caso</h1>
      <div class="notice notice-error" role="alert">${esc(e?.message || 'No se pudo consultar este caso.')} <a href="#/portal">Volver al portal</a></div>`
  }
}

export function bindReceiptPrint(page, print = () => globalThis.window?.print?.()) {
  const button = page.querySelector('[data-track-print]')
  const receipt = page.querySelector('[data-track-receipt]')
  if (!button || !receipt) return () => {}
  const listener = () => {
    receipt.open = true
    globalThis.document?.body?.classList.add('print-track-receipt')
    print()
    globalThis.document?.body?.classList.remove('print-track-receipt')
  }
  button.addEventListener('click', listener)
  return () => {
    button.removeEventListener('click', listener)
    globalThis.document?.body?.classList.remove('print-track-receipt')
  }
}

export function mountTrackedDevice(page, data) {
  const host = page.querySelector('[data-track-device-stage]')
  const button = page.querySelector('[data-track-device-toggle]')
  const status = page.querySelector('[data-track-device-status]')
  if (!host || !button || !status) return
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const profile = resolveDeviceProfile(data.terminal?.brand, data.terminal?.model)
  const svgId = 'track-terminal-phone'
  let active = true
  let assembled = true
  let disposeScene = null
  let motionController = null
  let toggleTween = null
  const media = gsap.matchMedia()
  let flowObserver = null
  let flowContext = null
  const profileTag = page.querySelector('[data-track-profile-tag]')
  const focusReadout = page.querySelector('[data-track-focus-readout]')
  const focusLabel = page.querySelector('[data-track-focus-label]')
  const focusTime = page.querySelector('[data-track-focus-time]')
  const historySteps = [...page.querySelectorAll('[data-track-history-step]')]
  let focusTween = null
  const focusStep = (step, animate = true) => {
    historySteps.forEach(item => {
      const selected = item === step
      item.setAttribute('aria-pressed', String(selected))
      item.classList.toggle('is-selected', selected)
    })
    const title = step.querySelector('.case-flow__line b')?.textContent?.trim() || 'Movimiento registrado'
    const time = step.querySelector('.case-flow__time')?.textContent?.trim() || ''
    if (focusLabel) focusLabel.textContent = title
    if (focusTime) {
      focusTime.textContent = time
      focusTime.hidden = !time
    }
    host.dataset.focusStatus = step.dataset.trackStepStatus || ''
    motionController?.focusMovement(host.dataset.focusStatus, { immediate: !animate || reduced })
    if (!animate || reduced) return
    focusTween?.kill()
    const pulse = gsap.timeline()
    if (focusReadout) pulse.fromTo(focusReadout, { autoAlpha: .62, y: 7, scale: .985 }, { autoAlpha: 1, y: 0, scale: 1, duration: .36, ease: 'power3.out', clearProps: 'all' }, 0)
    pulse.fromTo(host, { filter: 'brightness(1.18)' }, { filter: 'brightness(1)', duration: .5, ease: 'sine.out', clearProps: 'filter' }, 0)
    focusTween = pulse
  }
  const stepListeners = historySteps.map(step => {
    const listener = () => focusStep(step)
    step.addEventListener('click', listener)
    return [step, listener]
  })
  const initialStep = historySteps.find(step => step.getAttribute('aria-pressed') === 'true') || historySteps.at(-1)
  if (initialStep) focusStep(initialStep, false)
  if (profileTag) profileTag.textContent = profile.exact ? 'Perfil exterior identificado' : 'Vista ilustrativa'
  const fallbackToggle = () => {
    assembled = !assembled
    button.setAttribute('aria-pressed', String(assembled))
    describeAssembly(button, status, assembled)
    toggleTween?.kill()
    toggleTween = toggleAssembly(page, svgId, assembled, { reduced })
  }
  const restoreFallback = message => {
    motionController = null
    disposeScene?.(); disposeScene = null
    setTrackSceneReady(host, false)
    host.querySelector('.phone-fallback')?.removeAttribute('aria-hidden')
    host.querySelector('.phone-svg')?.classList.remove('has-webgl')
    button.setAttribute('aria-pressed', String(assembled))
    button.textContent = assembled ? 'Explorar las capas' : 'Armar el teléfono'
    toggleTween?.kill()
    toggleTween = toggleAssembly(page, svgId, assembled, { reduced })
    button.addEventListener('click', fallbackToggle)
    status.textContent = message
  }
  button.addEventListener('click', fallbackToggle)
  if (reduced) {
    host.dataset.rendererBackend = 'reduced-motion-svg'
    status.textContent = 'Movimiento reducido: vista esquemática accesible. Usa el control para separar las capas.'
  } else {
    requestAnimationFrame(async () => {
      try {
        const { mountPhone3d } = await import('../components/phone3d.js')
        if (!active || !page.contains(host)) return
        disposeScene = await mountPhone3d(host, button, status, {
          profile,
          assembled: true,
          getAssembled: () => assembled,
          playIntro: true,
          isActive: () => active && page.contains(host) && button.isConnected,
          onStateChange: value => { assembled = value },
          onMotionReady: controller => {
            motionController = controller
            const movementStatus = host.dataset.focusStatus
            if (movementStatus) controller.focusMovement(movementStatus)
          },
          onFallback: value => {
            assembled = value
            restoreFallback('La escena 3D no está disponible; puedes explorar el esquema interactivo.')
          },
        })
        if (!active) { disposeScene?.(); return }
        button.removeEventListener('click', fallbackToggle)
        if (host.dataset.rendererBackend) {
          host.querySelector('.phone-fallback')?.setAttribute('aria-hidden', 'true')
          host.querySelector('.phone-svg')?.classList.add('has-webgl')
          setTrackSceneReady(host, true)
          status.textContent = 'Arrastra el equipo para inspeccionar su exterior.'
        } else {
          restoreFallback('La escena 3D no está disponible; puedes explorar el esquema interactivo.')
        }
      } catch {
        if (active) restoreFallback('La escena 3D no está disponible; puedes explorar el esquema interactivo.')
      }
    })
  }
  media.add('(prefers-reduced-motion: no-preference)', () => {
    gsap.fromTo(host, { autoAlpha: 0, scale: .985 }, { autoAlpha: 1, scale: 1, duration: .48, ease: 'power3.out', clearProps: 'all' })
    const flow = page.querySelector('.case-flow')
    const items = [...(flow?.querySelectorAll('.case-flow__item') || [])]
    if (flow && items.length) {
      flowContext = gsap.context(() => {}, flow)
      const reveal = () => {
        flowObserver?.disconnect()
        flowObserver = null
        flowContext.add(() => {
          const connectors = items.filter(item => item.classList.contains('is-complete'))
          gsap.set(connectors, { '--case-link-progress': 0 })
          const sequence = gsap.timeline()
          sequence.fromTo(items, { autoAlpha: 0, y: 15, filter: 'blur(2px)' }, {
            autoAlpha: 1, y: 0, filter: 'blur(0px)', duration: .38,
            ease: 'power3.out', stagger: .12, clearProps: 'all',
          })
          connectors.forEach(item => {
            const index = items.indexOf(item)
            sequence.to(item, { '--case-link-progress': 1, duration: .24, ease: 'power2.out' }, index * .12 + .12)
          })
          const current = flow.querySelector('.case-flow__item.is-current .case-flow__marker')
          if (current) sequence.fromTo(current, { scale: .82 }, { scale: 1, duration: .42, ease: 'back.out(2)' }, Math.max(.16, (items.length - 1) * .12))
        })
      }
      if ('IntersectionObserver' in window) {
        flowObserver = new IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) reveal()
        }, { threshold: .12, rootMargin: '0px 0px -6% 0px' })
        flowObserver.observe(flow)
      } else reveal()
    }
    return () => {
      flowObserver?.disconnect()
      flowObserver = null
      flowContext?.revert()
      flowContext = null
    }
  })
  onLeave(() => {
    active = false
    media.revert()
    flowObserver?.disconnect()
    flowContext?.revert()
    focusTween?.kill()
    toggleTween?.kill()
    motionController = null
    disposeScene?.(); disposeScene = null
    button.removeEventListener('click', fallbackToggle)
    stepListeners.forEach(([step, listener]) => step.removeEventListener('click', listener))
  })
}

function bindCredForm(page) {
  const form = page.querySelector('[data-track]')
  const notice = page.querySelector('[data-track-storage-notice]')
  const fields = [...form.querySelectorAll('input[required]')]
  const validate = input => {
    const error = trackCredentialError(input.name, input.value)
    input.setAttribute('aria-invalid', String(Boolean(error)))
    input.closest('.field')?.classList.toggle('is-invalid', Boolean(error))
    const errorNode = page.querySelector(`#${input.id}-error`)
    if (errorNode) errorNode.textContent = error
    return !error
  }
  form.addEventListener('input', ev => {
    if (ev.target.matches('input[required]') && ev.target.value.trim()) validate(ev.target)
  })
  form.addEventListener('submit', ev => {
    ev.preventDefault()
    if (notice) { notice.hidden = true; notice.textContent = '' }
    const invalid = fields.filter(input => !validate(input))
    if (invalid.length) {
      invalid[0].focus()
      return
    }
    const f = new FormData(form)
    submitStoredTrackCredential({
      storage: getSessionStorage(),
      notice,
      values: { n: f.get('case_number'), t: f.get('token') },
      // sin recargar la URL: la vista se re-rinde y consume la credencial.
      go: () => navigate('/track'),
    })
  })
}
