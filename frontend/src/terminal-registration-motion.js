import { resolveDeviceProfile } from './components/device-profiles.js'
import { esc } from './util.js'

const cameraMarkup = camera => {
  if (camera === 'pixel-bar-dual') return '<rect class="trm-camera-base" x="20" y="22" width="40" height="9" rx="4.5"/><circle class="trm-lens" cx="32" cy="26.5" r="3"/><circle class="trm-lens" cx="42" cy="26.5" r="3"/><circle class="trm-flash" cx="53" cy="26.5" r="1.5"/>'
  if (camera === 'square-triple') return '<rect class="trm-camera-base" x="20" y="18" width="29" height="33" rx="6"/><circle class="trm-lens" cx="29" cy="28" r="4"/><circle class="trm-lens" cx="40" cy="28" r="4"/><circle class="trm-lens" cx="29" cy="41" r="4"/>'
  if (camera === 'separate-triple' || camera === 'vertical-triple') return '<circle class="trm-lens" cx="29" cy="23" r="4"/><circle class="trm-lens" cx="29" cy="35" r="4"/><circle class="trm-lens" cx="29" cy="47" r="4"/><circle class="trm-flash" cx="42" cy="23" r="1.7"/>'
  if (camera === 'moto-round-dual') return '<rect class="trm-camera-base" x="19" y="19" width="31" height="31" rx="12"/><circle class="trm-lens" cx="31" cy="30" r="4"/><circle class="trm-lens" cx="40" cy="40" r="4"/>'
  return '<rect class="trm-camera-base" x="19" y="19" width="34" height="32" rx="8"/><circle class="trm-lens" cx="30" cy="29" r="4"/><circle class="trm-lens" cx="42" cy="41" r="4"/><circle class="trm-flash" cx="43" cy="27" r="1.7"/>'
}

function htmlFor(terminal, profile) {
  const label = `${String(terminal.brand || 'Marca desconocida')} / ${String(terminal.model || 'modelo desconocido')}`
  const width = Number(profile.dimensionsMm?.width) || 72
  const height = Number(profile.dimensionsMm?.height) || 154
  const scaleX = Math.max(.86, Math.min(1.08, (width / height) / .47))
  const scaleY = Math.max(.9, Math.min(1.06, height / 154))
  const radius = Math.round(8 + (Number(profile.frameRadius) || .23) * 16)
  return `<aside class="terminal-registration-motion" data-profile="${profile.exact ? 'recognized' : 'illustrative'}">
    <div class="terminal-registration-motion__visual">
      <svg class="terminal-registration-motion__svg" data-terminal-svg aria-hidden="true" viewBox="0 0 80 160" focusable="false">
        <g data-device-body class="trm-body" transform="translate(40 80) scale(1 1) translate(-40 -80)">
          <rect class="trm-outline" x="11" y="8" width="58" height="144" rx="${radius}"/>
          <rect class="trm-backpanel" x="15" y="12" width="50" height="136" rx="${Math.max(4, radius - 4)}"/>
          <path class="trm-back-seam" d="M25 137h30"/>
        </g>
        <g data-camera class="trm-camera" transform="translate(0 -7) scale(.86)">${cameraMarkup(profile.camera)}</g>
        <g class="trm-register" data-register>
          <path d="M5 17h7M8.5 13.5v7M68 139h7M71.5 135.5v7M5 139h7M8.5 135.5v7M68 17h7M71.5 13.5v7"/>
        </g>
      </svg>
    </div>
    <div class="terminal-registration-motion__copy">
      <p class="terminal-registration-motion__eyebrow">Equipo registrado</p>
      <p class="terminal-registration-motion__title">${esc(label)}</p>
      ${profile.exact ? '' : '<p class="terminal-registration-motion__note">Perfil ilustrativo</p>'}
    </div>
  </aside>`
}

export function mountTerminalRegistrationMotion(container, terminal, { gsapApi, mediaQuery } = {}) {
  if (!container || !terminal || terminal.id == null) return null
  const profile = resolveDeviceProfile(terminal.brand, terminal.model)
  let timeline = null
  let disposed = false
  container.insertAdjacentHTML('afterbegin', htmlFor(terminal, profile))
  const band = container.querySelector('.terminal-registration-motion')
  const body = band?.querySelector('[data-device-body]')
  const camera = band?.querySelector('[data-camera]')
  const registration = band?.querySelector('[data-register]')
  const setFinal = () => {
    if (!gsapApi || !body) return
    const width = Number(profile.dimensionsMm?.width) || 72
    const height = Number(profile.dimensionsMm?.height) || 154
    const sx = Math.max(.86, Math.min(1.08, (width / height) / .47))
    const sy = Math.max(.9, Math.min(1.06, height / 154))
    gsapApi.set(body, { scaleX: sx, scaleY: sy, transformOrigin: '40px 80px' })
    gsapApi.set(camera, { y: 0, scale: 1, transformOrigin: '36px 35px' })
    gsapApi.set(registration, { autoAlpha: 1 })
  }
  const onPreferenceChange = event => {
    if (!event.matches || disposed) return
    timeline?.kill()
    timeline = null
    setFinal()
  }
  if (mediaQuery?.addEventListener) mediaQuery.addEventListener('change', onPreferenceChange)
  else mediaQuery?.addListener?.(onPreferenceChange)
  try {
    if (!gsapApi || mediaQuery?.matches) setFinal()
    else {
      gsapApi.set(registration, { autoAlpha: 0 })
      timeline = gsapApi.timeline({ defaults: { ease: 'power2.out' } })
      const width = Number(profile.dimensionsMm?.width) || 72
      const height = Number(profile.dimensionsMm?.height) || 154
      timeline.to(body, {
        scaleX: Math.max(.86, Math.min(1.08, (width / height) / .47)),
        scaleY: Math.max(.9, Math.min(1.06, height / 154)),
        transformOrigin: '40px 80px', duration: .24,
      }, 0)
      timeline.to(camera, { y: 0, scale: 1, transformOrigin: '36px 35px', duration: .18 }, .07)
      timeline.to(registration, { autoAlpha: 1, duration: .18 }, .2)
    }
  } catch {
    timeline?.kill()
    timeline = null
    try { setFinal() } catch { /* visual failure never affects saved data */ }
  }
  return {
    profile,
    dispose() {
      if (disposed) return
      disposed = true
      timeline?.kill()
      timeline = null
      if (mediaQuery?.removeEventListener) mediaQuery.removeEventListener('change', onPreferenceChange)
      else mediaQuery?.removeListener?.(onPreferenceChange)
      band?.remove()
    },
  }
}
