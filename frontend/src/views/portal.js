// Portal público: consulta inmediata del caso + secuencia protagonista del teléfono.
import { get, post } from '../api.js'
import { esc } from '../util.js'
import { navigate, onLeave } from '../router.js'
import { ensureSessionNav, publicShell, bindLogout } from '../layout/public.js'
import { phoneSvgHtml, presentPhone, toggleAssembly, buildControl, describeAssembly, setPhoneSvgPose } from '../components/phone.js'
import gsap from 'gsap'

let introTl = null
let copyTl = null
let ctlTls = []
let dispose3d = null

// Cada bloque informativo entra en secuencia: ninguno depende del primer <p>.
export const PORTAL_COPY_TARGETS = '.hero-copy h1, .hero-copy .lede, .hero-copy form, .hero-copy .portal-form-feedback, .hero-copy .hero-form-help, .hero-copy .hero-meters'

export function savePortalCredentials(storage, caseNumber, token) {
  const n = String(caseNumber ?? '').trim()
  const t = String(token ?? '').trim()
  if (!n || !t) return false
  try {
    storage.removeItem('relevo:track-cred')
    storage.setItem('relevo:track-cred', JSON.stringify({ n, t }))
    return true
  } catch {
    return false
  }
}

export function portalSceneGuidance(state) {
  const messages = {
    loading: 'Preparando la vista 3D del teléfono…',
    ready: 'Vista 3D lista. Arrastra el teléfono para inspeccionarlo; sus capas internas son esquemáticas.',
    fallback: 'La vista 3D no está disponible; puedes explorar el esquema interactivo del teléfono.',
    reduced: 'Vista interactiva disponible. Las capas internas son una representación ilustrativa.',
    illustration: 'Este teléfono es ilustrativo. Usa «Explorar las capas»; los componentes internos son esquemáticos.',
  }
  return messages[state] || messages.illustration
}

// Keep the renderer lifecycle testable without creating a real GPU context.
// `isAllowed` is checked both around the asynchronous import and after GPU init.
export async function mountPhoneSceneSafely({ loadModule, mount, isAllowed, onFallback, onReady }) {
  if (!isAllowed()) return null
  const { mountPhone3d } = await loadModule()
  if (!isAllowed()) return null

  let fellBackDuringMount = false
  const dispose = await mount(mountPhone3d, () => {
    fellBackDuringMount = true
    onFallback()
  })

  if (fellBackDuringMount || !isAllowed()) {
    dispose?.()
    return null
  }

  onReady()
  return dispose
}

export async function portalView(root) {
  await import('../styles/portal-motion.css')
  await ensureSessionNav()
  let viewAlive = true

  // Métricas públicas del servicio cuando existan; si fallan, se muestran omitidas.
  let metersHtml = ''
  try {
    const { data } = await get('/health')
    metersHtml = `<div class="hero-meters">
      <span><b>Servicio en línea</b> · estado del taller: ${esc(data?.status || 'ok')}</span>
    </div>`
  } catch {
    // Sin backend no hay métricas reales: se omite el bloque, no se inventa.
    metersHtml = ''
  }

  root.innerHTML = publicShell(`
    <div class="page">
      <section class="hero">
        <div class="hero-copy">
          <h1>Cada paso de tu reparación,<br>a la vista.</h1>
          <p class="lede">Sigue el avance de tu reparación en cada etapa. Consulta el estado de tu equipo con el número de caso y la clave que te entregamos; la revisión depende del modelo y del diagnóstico.</p>
          <form class="hero-form" data-track novalidate aria-label="Consultar el estado de una reparación" aria-describedby="track-form-help">
            <label class="hero-field" data-field="case_number">
              <span class="hero-field-label">Número de caso</span>
              <input id="portal-case-number" name="case_number" inputmode="text" autocomplete="off" placeholder="p. ej. CAS-2026-0001" aria-describedby="case-number-error track-form-help" aria-invalid="false" required>
              <span class="hero-field-error" id="case-number-error" aria-live="polite"></span>
            </label>
            <label class="hero-field" data-field="token">
              <span class="hero-field-label">Clave de seguimiento</span>
              <input id="portal-tracking-token" name="token" inputmode="text" autocomplete="off" placeholder="La clave de tu ficha" aria-describedby="tracking-token-error track-form-help" aria-invalid="false" required>
              <span class="hero-field-error" id="tracking-token-error" aria-live="polite"></span>
            </label>
            <button class="btn btn-primary" type="submit" data-track-submit>Consultar mi caso</button>
          </form>
          <p class="portal-form-feedback" data-track-feedback role="status" aria-live="polite"></p>
          <p class="hero-form-help" id="track-form-help">Encontrarás el número y la clave en la ficha que te entregaron al recibir el equipo.</p>
          ${metersHtml}
        </div>
        <div class="hero-art">
          <div class="phone-stage">${phoneSvgHtml()}</div>
          <div class="phone-control-slot"></div>
          <p class="portal-scene-guide" data-scene-guide data-scene-state="illustration" role="status" aria-live="polite"><span class="portal-scene-indicator" aria-hidden="true"></span><span>${portalSceneGuidance('illustration')}</span></p>
        </div>
      </section>
    </div>
  `, { showcase: true })
  bindLogout(root)

  const trackForm = root.querySelector('[data-track]')
  const trackSubmit = root.querySelector('[data-track-submit]')
  const formFeedback = root.querySelector('[data-track-feedback]')
  const sceneGuide = root.querySelector('[data-scene-guide]')
  const setSceneState = state => {
    if (!sceneGuide) return
    sceneGuide.dataset.sceneState = state
    sceneGuide.querySelector('span:last-child').textContent = portalSceneGuidance(state)
  }
  const trackFields = [...trackForm.querySelectorAll('input[required]')]
  let isSubmitting = false
  const validateTrackField = (input) => {
    const value = input.value.trim()
    const valid = value.length > 0
    const field = input.closest('.hero-field')
    const error = field.querySelector('.hero-field-error')
    input.setAttribute('aria-invalid', String(!valid))
    field.classList.toggle('is-invalid', !valid)
    error.textContent = valid ? '' : input.name === 'case_number'
      ? 'Escribe el número que aparece en tu ficha.'
      : 'Escribe la clave de seguimiento de tu ficha.'
    return valid
  }
  const onTrackInput = (ev) => {
    if (ev.target.matches('input[required]')) {
      if (ev.target.value.trim()) validateTrackField(ev.target)
      if (formFeedback.textContent) formFeedback.textContent = ''
    }
  }
  const showFormFeedback = message => {
    formFeedback.textContent = message
    if (!reduced) {
      const tl = gsap.fromTo(formFeedback, { y: 5, scale: .99 }, {
        y: 0, scale: 1, duration: .28, ease: 'power2.out',
      })
      ctlTls.push(tl)
    }
  }
  const onTrackSubmit = (ev) => {
    ev.preventDefault()
    if (isSubmitting) return
    const invalid = trackFields.filter(input => !validateTrackField(input))
    if (invalid.length) {
      if (!reduced) {
        const tl = gsap.timeline()
        invalid.forEach((input, i) => tl.fromTo(input.closest('.hero-field-error'),
          { autoAlpha: 0, y: -3 }, { autoAlpha: 1, y: 0, duration: .2, ease: 'power2.out' }, i ? '-=.12' : 0))
        ctlTls.push(tl)
      }
      invalid[0].focus()
      return
    }
    const f = new FormData(trackForm)
    // La clave va por almacenamiento efímero, nunca por la URL (los servidores
    // y navegadores suelen registrar la cadena de consulta).
    const saved = savePortalCredentials(sessionStorage, f.get('case_number'), f.get('token'))
    if (!saved) {
      showFormFeedback('No se pudo preparar la consulta. Activa el almacenamiento de sesión en tu navegador e inténtalo de nuevo.')
      trackSubmit.focus()
      return
    }
    isSubmitting = true
    trackSubmit.disabled = true
    trackSubmit.setAttribute('aria-busy', 'true')
    trackSubmit.textContent = 'Preparando consulta…'
    showFormFeedback('Abriendo el estado de tu reparación…')
    navigate('/track')
  }
  trackForm.addEventListener('input', onTrackInput)
  trackForm.addEventListener('submit', onTrackSubmit)

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const copyTargets = root.querySelectorAll(PORTAL_COPY_TARGETS)
  if (!reduced) {
    gsap.set(copyTargets, { opacity: 0, y: 18 })
    copyTl = gsap.timeline({ delay: .1 })
      .to(root.querySelector('.hero-copy h1'), { opacity: 1, y: 0, duration: .55, ease: 'power3.out' })
      .to(root.querySelector('.hero-copy .lede'), { opacity: 1, y: 0, duration: .48, ease: 'power2.out' }, '-=.3')
      .to(root.querySelector('.hero-copy form'), { opacity: 1, y: 0, duration: .48, ease: 'power2.out' }, '-=.26')
      .to(root.querySelector('.hero-copy .portal-form-feedback'), { opacity: 1, y: 0, duration: .35, ease: 'power2.out' }, '-=.2')
      .to(root.querySelector('.hero-copy .hero-form-help'), { opacity: 1, y: 0, duration: .4, ease: 'power2.out' }, '-=.18')
    const meters = root.querySelector('.hero-copy .hero-meters')
    if (meters) copyTl.to(meters, { opacity: 1, y: 0, duration: .4, ease: 'power2.out' }, '-=.18')
  } else {
    gsap.set(copyTargets, { opacity: 1, y: 0 })
  }
  introTl = presentPhone(root, { reduced })

  // Control accesible: alterna ARMADO ↔ EXPLOREADO (teclado y táctil).
  const svg = root.querySelector('.phone-svg')
  if (svg) {
    const { bar, uid } = buildControl(root)
    root.querySelector('.phone-control-slot').append(bar)
    const btn = bar.querySelector('[data-mode-toggle]')
    const status = bar.querySelector('.phone-status')
    const host = root.querySelector('.phone-stage')
    let assembled = true
    const introKey = 'relevo:phone3d-intro-v1'
    let playIntro = !reduced
    try { playIntro = playIntro && !sessionStorage.getItem(introKey) } catch { /* the SVG remains usable if storage is blocked */ }
    const fallbackToggle = () => {
      assembled = !assembled
      host.dataset.assembled = String(assembled)
      describeAssembly(btn, status, assembled)
      const tl = toggleAssembly(root, uid, assembled, { reduced })
      if (tl) ctlTls.push(tl)
    }
    btn.addEventListener('click', fallbackToggle)
    const restoreSvgFallback = () => {
      dispose3d = null
      root.querySelector('.phone-fallback')?.removeAttribute('aria-hidden')
      root.querySelector('.phone-svg')?.removeAttribute('aria-hidden')
      root.querySelector('.phone-svg')?.classList.remove('has-webgl')
      host.removeAttribute('data-3d-ready')
      setSceneState('fallback')
      setPhoneSvgPose(root, assembled, { reduced: true })
      btn.addEventListener('click', fallbackToggle)
    }

    // Keep the SVG and its accessible control for reduced-motion users. In
    // particular, avoid even downloading Three.js or requesting a GPU context.
    if (reduced) {
      setSceneState('reduced')
    } else {
      setSceneState('loading')
      // Leave the fallback visible until initialization has completed.
      requestAnimationFrame(async () => {
        try {
          dispose3d = await mountPhoneSceneSafely({
            loadModule: () => import('../components/phone3d.js'),
            mount: (mountPhone3d, handleFallback) => mountPhone3d(host, btn, status, {
              reduced, assembled,
              getAssembled: () => assembled,
              isActive: () => viewAlive && root.contains(host) && btn.isConnected,
              playIntro,
              onStateChange: value => { assembled = value },
              onFallback: handleFallback,
            }),
            isAllowed: () => !reduced && viewAlive && root.contains(host) && btn.isConnected,
            onFallback: restoreSvgFallback,
            onReady: () => {
              btn.removeEventListener('click', fallbackToggle)
              root.querySelector('.phone-fallback')?.setAttribute('aria-hidden', 'true')
              root.querySelector('.phone-svg')?.setAttribute('aria-hidden', 'true')
              root.querySelector('.phone-svg')?.classList.add('has-webgl')
              host.setAttribute('data-3d-ready', 'true')
              setSceneState('ready')
              if (playIntro && assembled) {
                try { sessionStorage.setItem(introKey, '1') } catch { /* do not block the scene when storage is unavailable */ }
              }
            },
          })
        } catch {
          // WebGL unavailable or context creation failed: SVG stays in place.
          dispose3d = null
          setSceneState('fallback')
        }
      })
    }
  }

  onLeave(() => {
    viewAlive = false
    trackForm.removeEventListener('input', onTrackInput)
    trackForm.removeEventListener('submit', onTrackSubmit)
    trackSubmit.disabled = false
    trackSubmit.removeAttribute('aria-busy')
    introTl && introTl.kill()
    copyTl?.kill()
    ctlTls.forEach(t => t.kill())
    dispose3d?.(); dispose3d = null
    introTl = null; copyTl = null; ctlTls = []
  })
}
