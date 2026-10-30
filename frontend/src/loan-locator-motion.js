import { esc } from './util.js'
import { fleetDeviceMarkup } from './loan-devices.js'

const cleanups = new WeakMap()

function deviceName(device) {
  return [device?.brand, device?.model].filter(Boolean).join(' ') || 'Equipo'
}

function deviceStatus(device) {
  if (device?.status === 'available') return 'Disponible en mostrador'
  if (device?.status === 'loaned') return 'Entregado a cliente'
  if (device?.status === 'retired') return 'Retirado'
  return device?.status || 'Desconocido'
}

function isVisible(element) {
  const rect = element.getBoundingClientRect()
  const height = window.innerHeight || document.documentElement.clientHeight
  return rect.bottom > 0 && rect.top < height && rect.width > 0 && rect.height > 0
}

// Read-only locator: identifiers always come from device.id; no API calls occur here.
export function bindLoanLocator(main, devices, { gsap: suppliedGsap = null } = {}) {
  cleanups.get(main)?.()
  const dock = main.querySelector('.fleet-dock')
  const list = main.querySelector('[data-list]')
  if (!dock || !list) return () => {}

  let selected = null
  let timeline = null
  let animationGeneration = 0
  let gsapApi = suppliedGsap
  let disposed = false
  let slotDevice = null
  const stage = dock.querySelector('.fleet-dock__stage')
  const rack = dock.querySelector('.fleet-dock__rack')
  const live = document.createElement('p')
  live.className = 'loan-locator-status'
  live.dataset.locatorStatus = ''
  live.setAttribute('role', 'status')
  live.setAttribute('aria-live', 'polite')
  live.setAttribute('aria-atomic', 'true')
  live.hidden = true
  list.prepend(live)
  const reveal = document.createElement('button')
  reveal.type = 'button'
  reveal.className = 'btn btn-ghost loan-locator-status__reveal'
  reveal.textContent = 'Ver en el muelle'
  reveal.hidden = true
  live.addEventListener('click', event => {
    if (event.target.closest('[data-locator-reveal]')) {
      dock.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' })
    }
  })
  reveal.dataset.locatorReveal = ''

  const slots = () => [...rack.querySelectorAll('.fleet-device')]
  const setMotionPaused = paused => {
    if (paused) dock.dataset.locatorActive = 'true'
    else dock.removeAttribute('data-locator-active')
  }
  const setSlot = device => {
    const current = slots()
    if (!current.length) return null
    const alreadyVisible = current.find(slot => slot.dataset.deviceId === String(device.id))
    if (alreadyVisible && current.indexOf(alreadyVisible) < 4) {
      clearSlotOverride()
      return slots().find(slot => slot.dataset.deviceId === String(device.id))
    }
    const fifth = current[4]
    if (!fifth) return null
    fifth.outerHTML = fleetDeviceMarkup(device, 4)
    slotDevice = device
    return slots()[4]
  }
  const clearSlotOverride = () => {
    if (!slotDevice) return
    const original = (devices || []).slice(0, 5)[4]
    const fifth = slots()[4]
    if (fifth && original) fifth.outerHTML = fleetDeviceMarkup(original, 4)
    slotDevice = null
  }
  const stopTimeline = () => {
    animationGeneration += 1
    timeline?.kill()
    timeline = null
    if (gsapApi) gsapApi.killTweensOf(slots().map(slot => slot.querySelector('.fleet-device__motion')).filter(Boolean))
    slots().forEach(slot => {
      const motion = slot.querySelector('.fleet-device__motion')
      if (motion && gsapApi) gsapApi.set(motion, { clearProps: 'transform' })
    })
  }
  const clearSelection = () => {
    stopTimeline()
    selected = null
    list.querySelectorAll('[data-locate]').forEach(button => button.setAttribute('aria-pressed', 'false'))
    slots().forEach(slot => slot.classList.remove('is-selected', 'is-dimmed'))
    clearSlotOverride()
    setMotionPaused(false)
    live.hidden = true
    live.replaceChildren()
  }
  const animateSelection = target => {
    if (disposed || !selected || selected.id !== target.id) return
    const invocation = ++animationGeneration
    if (disposed || invocation !== animationGeneration || !selected || selected.id !== target.id) return
    const motion = slots().find(slot => slot.dataset.deviceId === String(target.id))?.querySelector('.fleet-device__motion')
    if (!motion || !gsapApi || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (disposed || invocation !== animationGeneration) return
    const nextTimeline = gsapApi.timeline({ defaults: { duration: .36, ease: 'power3.out' } })
      .fromTo(motion, { rotation: -13, y: 0 }, { rotation: 0, y: -18 })
    if (disposed || invocation !== animationGeneration) {
      nextTimeline.kill()
      gsapApi.killTweensOf(motion)
      return
    }
    timeline = nextTimeline
  }
  const syncReveal = () => { reveal.hidden = !selected || isVisible(dock) }
  const onViewportChange = () => { if (selected) syncReveal() }
  const showSelection = (device, button) => {
    stopTimeline()
    selected = device
    const slot = setSlot(device)
    setMotionPaused(true)
    slots().forEach(item => {
      item.classList.toggle('is-selected', item === slot)
      item.classList.toggle('is-dimmed', item !== slot)
    })
    list.querySelectorAll('[data-locate]').forEach(control => {
      control.setAttribute('aria-pressed', String(control === button))
    })

    const message = document.createElement('span')
    message.className = 'loan-locator-status__copy'
    message.textContent = `Seleccionado: ${deviceName(device)} · ${device.asset_tag || 'Sin etiqueta'} · ${deviceStatus(device)}.`
    live.replaceChildren(message, document.createTextNode(' '), reveal)
    live.hidden = false
    syncReveal()
    animateSelection(device)
  }

  const onClick = event => {
    const button = event.target.closest('[data-locate]')
    if (!button || !list.contains(button) || button.disabled) return
    const id = button.dataset.locate
    const device = (devices || []).find(item => item.id != null && String(item.id) === id)
    if (!device) return
    if (selected?.id === device.id) clearSelection()
    else showSelection(device, button)
  }
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  const onMotionChange = event => {
    if (!event.matches || !selected) return
    stopTimeline()
    const motion = slots().find(slot => slot.dataset.deviceId === String(selected.id))?.querySelector('.fleet-device__motion')
    if (motion && gsapApi) gsapApi.set(motion, { clearProps: 'transform' })
  }
  list.addEventListener('click', onClick)
  window.addEventListener('scroll', onViewportChange, { passive: true })
  window.addEventListener('resize', onViewportChange)
  media.addEventListener?.('change', onMotionChange)
  const cleanup = () => {
    if (disposed) return
    disposed = true
    list.removeEventListener('click', onClick)
    window.removeEventListener('scroll', onViewportChange)
    window.removeEventListener('resize', onViewportChange)
    media.removeEventListener?.('change', onMotionChange)
    stopTimeline()
    selected = null
    setMotionPaused(false)
    if (slotDevice) {
      const original = (devices || []).slice(0, 5)[4]
      const fifth = slots()[4]
      if (fifth && original) fifth.outerHTML = fleetDeviceMarkup(original, 4)
      slotDevice = null
    }
    slots().forEach(slot => slot.classList.remove('is-selected', 'is-dimmed'))
    live.remove()
    cleanups.delete(main)
  }
  cleanups.set(main, cleanup)
  return cleanup
}

export function loanLocatorButton(device) {
  const id = device?.id == null ? '' : String(device.id)
  const label = `Localizar ${deviceName(device)}${device?.asset_tag ? `, ${device.asset_tag}` : ''}`
  return `<button class="btn btn-ghost loan-locate" type="button" data-locate="${esc(id)}" aria-label="${esc(label)}" aria-pressed="false" ${id ? '' : 'disabled title="Este equipo no tiene un identificador disponible."'}>Localizar</button>`
}
