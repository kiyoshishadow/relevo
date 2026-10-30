import { resolveDeviceProfile } from './components/device-profiles.js'
import { phoneSvgHtml, toggleAssembly, describeAssembly } from './components/phone.js'
import { terminalBelongsToClient } from './intake-state.js'
import { esc } from './util.js'

const loadPhone3d = () => import('./components/phone3d.js')

function markup(terminal, profile) {
  const name = [terminal.brand, terminal.model].filter(Boolean).join(' ').trim() || 'Terminal'
  return `<section class="intake-device-preview" data-device-preview aria-label="Vista previa del equipo seleccionado">
    <div class="intake-device-preview__scene">
      <div class="device-lab-stage intake-device-preview__stage" data-intake-device-stage>
        <div class="phone-fallback"><div class="phone-fallback-inner">${phoneSvgHtml({ id: 'intake-terminal-phone', profile })}</div></div>
        <span class="device-stage-tag">${profile.exact ? 'Perfil exterior identificado' : 'Vista ilustrativa'}</span>
      </div>
    </div>
    <div class="intake-device-preview__details">
      <span class="track-kicker">EQUIPO SELECCIONADO</span>
      <h2 data-intake-device-name>${esc(name)}</h2>
      <button class="btn btn-ghost device-assembly-toggle" type="button" data-intake-device-toggle aria-pressed="true">Explorar las capas</button>
      <p class="device-lab-status" data-intake-device-status aria-live="polite">Vista posterior del equipo. Arrastra para inspeccionarlo.</p>
    </div>
  </section>`
}

/** Coordinates selection generations and serializes renderer teardown/mount. */
export function createIntakeDevicePreview({ host, loadModule = loadPhone3d, motionQuery = null, setSvgPose = toggleAssembly } = {}) {
  let generation = 0
  let active = true
  let selectedKey = ''
  let queue = Promise.resolve()
  let disposeScene = null
  let svgTween = null
  let current = null
  let lastSelection = null

  const reduced = () => Boolean(motionQuery?.matches)
  const valid = (terminal, clientId) => Boolean(terminal && terminalBelongsToClient(terminal, clientId))
  const currentGeneration = token => active && token === generation && host?.isConnected && current?.host?.isConnected
  const enqueue = task => {
    queue = queue.catch(() => {}).then(task)
    return queue
  }
  const stopScene = () => {
    disposeScene?.()
    disposeScene = null
    svgTween?.kill?.()
    svgTween = null
  }
  const fallbackToggle = () => {
    if (!current || !currentGeneration(current.token)) return
    const assembled = current.button.getAttribute('aria-pressed') !== 'false'
    const next = !assembled
    current.button.setAttribute('aria-pressed', String(next))
    describeAssembly(current.button, current.status, next)
    svgTween?.kill?.()
    svgTween = setSvgPose(current.host, 'intake-terminal-phone', next, { reduced: reduced() })
  }
  const updateBackend = (token, view) => {
    if (!currentGeneration(token)) return
    if (view.fallbackState !== null) return
    const backend = view.host.dataset.rendererBackend
    const labels = { webgpu: 'Vista interactiva activa con WebGPU.', webgl2: 'Vista interactiva activa con WebGL 2.', 'reduced-motion-svg': 'Movimiento reducido: vista esquemática estática; usa el control para separar las capas.' }
    view.status.textContent = labels[backend] || 'Vista esquemática interactiva. Arrastra para inspeccionar el equipo.'
    view.host.querySelector('canvas')?.setAttribute('aria-hidden', 'true')
    if (backend === 'webgpu' || backend === 'webgl2') {
      view.host.querySelector('.phone-fallback')?.setAttribute('aria-hidden', 'true')
      view.host.querySelector('.phone-svg')?.classList.add('has-webgl')
      view.button.removeEventListener('click', fallbackToggle)
    }
  }
  const onMotionChange = () => {
    if (lastSelection) select(lastSelection.terminal, lastSelection.clientId)
  }
  motionQuery?.addEventListener?.('change', onMotionChange)
  const select = (terminal, clientId) => {
    const token = ++generation
    stopScene()
    current = null
    selectedKey = valid(terminal, clientId) ? `${clientId}:${terminal.id}` : ''
    if (!selectedKey) {
      lastSelection = null
      host.replaceChildren()
      host.hidden = true
      return Promise.resolve()
    }
    lastSelection = { terminal, clientId }
    const profile = resolveDeviceProfile(terminal.brand, terminal.model)
    host.innerHTML = markup(terminal, profile)
    host.hidden = false
    const view = {
      token,
      host: host.querySelector('[data-intake-device-stage]'),
      button: host.querySelector('[data-intake-device-toggle]'),
      status: host.querySelector('[data-intake-device-status]'),
      assembled: true,
      profile,
      fallbackState: null,
    }
    current = view
    view.button.addEventListener('click', fallbackToggle)
    if (reduced()) {
      view.host.dataset.rendererBackend = 'reduced-motion-svg'
      view.status.textContent = 'Movimiento reducido: vista esquemática estática; usa el control para separar las capas.'
      return Promise.resolve()
    }
    return enqueue(async () => {
      // The old renderer is always disposed before another renderer is created.
      stopScene()
      if (!currentGeneration(token)) return
      try {
        const { mountPhone3d } = await loadModule()
        if (!currentGeneration(token)) return
        const dispose = await mountPhone3d(view.host, view.button, view.status, {
          profile, assembled: true, playIntro: true, idleAnimation: true, idleScan: false, reduced: reduced(),
          getAssembled: () => view.button.getAttribute('aria-pressed') !== 'false',
          isActive: () => currentGeneration(token) && current === view && selectedKey === `${clientId}:${terminal.id}`,
          onFallback: assembled => {
            if (!currentGeneration(token)) return
            view.fallbackState = assembled
            svgTween?.kill?.()
            svgTween = setSvgPose(view.host, 'intake-terminal-phone', assembled, { reduced: true })
            view.button.setAttribute('aria-pressed', String(assembled))
            describeAssembly(view.button, view.status, assembled)
            view.host.querySelector('.phone-fallback')?.removeAttribute('aria-hidden')
            view.host.querySelector('.phone-svg')?.classList.remove('has-webgl')
            view.button.addEventListener('click', fallbackToggle)
            view.status.textContent += ' La escena 3D dejó de estar disponible; puedes explorar el esquema SVG.'
          },
        })
        if (!currentGeneration(token)) { dispose?.(); return }
        disposeScene = dispose
        updateBackend(token, view)
      } catch {
        if (!currentGeneration(token)) return
        view.host.dataset.rendererBackend = 'svg-fallback'
        view.status.textContent = 'La escena 3D no está disponible; puedes explorar el esquema SVG.'
      }
    })
  }
  const clear = () => select(null, '')
  const dispose = () => {
    if (!active) return queue
    active = false
    generation++
    selectedKey = ''
    current = null
    lastSelection = null
    motionQuery?.removeEventListener?.('change', onMotionChange)
    return enqueue(() => {
      stopScene()
      host?.replaceChildren()
      if (host) host.hidden = true
    })
  }
  return { select, clear, dispose, get generation() { return generation } }
}
