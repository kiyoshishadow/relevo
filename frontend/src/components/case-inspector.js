import { esc } from '../util.js'
import { phoneSvgHtml, setPhoneSvgPose } from './phone.js'
import { resolveDeviceProfile } from './device-profiles.js'
import { gsap } from 'gsap'

const instances = new WeakMap()

function diagnosisText(cs) {
  const value = cs?.diagnosis?.text ?? cs?.diagnosis
  return typeof value === 'string' ? value.trim() : ''
}

function suggestedPart(cs) {
  const source = `${diagnosisText(cs)} ${cs?.reported_problem || ''}`.toLocaleLowerCase('es')
  const matches = [
    ['battery', /bater[ií]a|carga|autonom[ií]a|no mantiene/],
    ['display', /pantalla|display|lcd|oled|t[aá]ctil/],
    ['board', /placa|tarjeta|circuito|motherboard/],
  ].filter(([, pattern]) => pattern.test(source))
  return matches.length === 1 ? matches[0][0] : null
}

export function caseInspectorMarkup(cs = {}) {
  const profile = resolveDeviceProfile(cs.terminal?.brand, cs.terminal?.model)
  const device = [cs.terminal?.brand, cs.terminal?.model].filter(Boolean).join(' ') || 'Equipo sin identificar'
  const exactLabel = profile.exact ? 'Perfil de catálogo' : 'Modelo ilustrativo · perfil no identificado'
  const diagnosis = diagnosisText(cs)
  const suggestedKey = suggestedPart(cs)
  const suggestedLabel = { battery: 'Batería', display: 'Pantalla', board: 'Placa' }[suggestedKey]
  const id = `case-inspector-phone-${String(cs.id ?? 'case').replace(/[^a-zA-Z0-9_-]/g, '-')}`
  return `<section class="case-inspector" id="case-inspector-${esc(cs.id)}" data-case-inspector hidden aria-labelledby="case-inspector-title">
    <header class="case-inspector__header">
      <div><p class="case-inspector__eyebrow">MESA DE INSPECCIÓN · ESQUEMA INTERNO</p><h2 id="case-inspector-title" tabindex="-1">${esc(device)}</h2><p>${esc(exactLabel)}. Las capas internas representan componentes comunes, no un despiece verificado del modelo.</p></div>
      <button class="case-inspector__close" type="button" data-case-inspector-close aria-label="Cerrar inspección">Cerrar</button>
    </header>
    <div class="case-inspector__layout">
      <div class="case-inspector__bench">
        <div class="case-inspector__stage" data-inspector-stage>
          <div class="case-inspector__phone phone-stage" data-phone-host data-assembled="true">
            ${phoneSvgHtml({ id, profile })}
          </div>
          <span class="case-inspector__stage-mark" aria-hidden="true">VISTA TÉCNICA</span>
        </div>
        <div class="case-inspector__controls" aria-label="Controles de inspección">
          <button class="case-inspector__assembly" type="button" data-inspector-assembly aria-pressed="true">Explorar las capas</button>
          <button class="case-inspector__full" type="button" data-inspector-full>Vista completa</button>
        </div>
        <div class="case-inspector__parts" role="group" aria-label="Seleccionar componente">
          <button type="button" data-part-key="display" aria-pressed="false"${suggestedKey === 'display' ? ' data-part-suggested="true"' : ''}>Pantalla</button>
          <button type="button" data-part-key="battery" aria-pressed="false"${suggestedKey === 'battery' ? ' data-part-suggested="true"' : ''}>Batería</button>
          <button type="button" data-part-key="board" aria-pressed="false"${suggestedKey === 'board' ? ' data-part-suggested="true"' : ''}>Placa</button>
        </div>
        <p class="case-inspector__status" data-inspector-status role="status" aria-live="polite">${suggestedLabel ? `${esc(suggestedLabel)} sugerida por el texto del expediente. La selección es orientativa y no confirma la pieza averiada.` : 'Teléfono ensamblado. Selecciona una pieza para inspeccionar el modelo o el diagrama esquemático.'}</p>
      </div>
      <aside class="case-inspector__record" aria-label="Registro del caso">
        ${suggestedLabel ? `<div class="case-inspector__reference" data-inspector-reference><span class="case-inspector__reference-label">Mencionada en el expediente</span><strong>${esc(suggestedLabel)}</strong><p data-inspector-relation>Selecciona la pieza para relacionarla con el registro.</p><button type="button" data-inspector-reference-select>Volver a ${esc(suggestedLabel).toLocaleLowerCase('es')}</button></div>` : ''}
        <article><p class="case-inspector__record-label">01 / RECEPCIÓN</p><h3>Problema reportado</h3><p>${esc(cs.reported_problem || 'No hay problema reportado en el expediente.')}</p></article>
        <article><p class="case-inspector__record-label">02 / DIAGNÓSTICO</p><h3>Registro técnico</h3><p>${esc(diagnosis || 'Aún no hay un diagnóstico registrado.')}</p>${cs.diagnosis?.problem_type || cs.problem_type ? `<small>Tipo registrado: ${esc(cs.diagnosis?.problem_type || cs.problem_type)}</small>` : ''}</article>
        <p class="case-inspector__record-note">${suggestedLabel ? `“${esc(suggestedLabel)}” se sugiere solo por las palabras del reporte o diagnóstico. La confirmación de la pieza requiere inspección técnica.` : 'El expediente no identifica una pieza concreta. Esta escena sirve para orientación visual.'}</p>
      </aside>
    </div>
  </section>`
}

function revealFallback(host, assembled, status, buttons) {
  host.removeAttribute('data-3d-ready')
  host.removeAttribute('data-renderer-backend')
  host.querySelector('.phone-svg')?.classList.remove('has-webgl')
  host.querySelector('.phone-fallback')?.removeAttribute('aria-hidden')
  host.querySelectorAll('.phone-canvas').forEach(canvas => canvas.remove())
  host.dataset.assembled = String(assembled)
  const assemblyButton = host.closest('[data-case-inspector]')?.querySelector('[data-inspector-assembly]')
  if (assemblyButton) {
    assemblyButton.setAttribute('aria-pressed', String(assembled))
    assemblyButton.textContent = assembled ? 'Explorar las capas' : 'Armar el teléfono'
  }
  setPhoneSvgPose(host, assembled, { reduced: true })
  if (!assembled) {
    const selected = buttons.find(button => button.getAttribute('aria-pressed') === 'true')
    status.textContent = `${selected ? `${selected.textContent} seleccionada. ` : ''}Diagrama esquemático: capas comunes visibles; la selección no enfoca una pieza en esta vista estática.`
  }
}

export function mountCaseInspector(main, cs) {
  disposeCaseInspector(main)
  const benchWrap = main.querySelector('[data-case-bench-wrap]')
  const bench = benchWrap?.querySelector('[data-case-bench]')
  if (!benchWrap || !bench) return () => {}
  benchWrap.insertAdjacentHTML('beforeend', caseInspectorMarkup(cs))
  const panel = benchWrap.querySelector('[data-case-inspector]')
  const openButton = bench.querySelector('[data-case-inspector-open]')
  const closeButton = panel.querySelector('[data-case-inspector-close]')
  const host = panel.querySelector('[data-phone-host]')
  const assemblyButton = panel.querySelector('[data-inspector-assembly]')
  const fullButton = panel.querySelector('[data-inspector-full]')
  const status = panel.querySelector('[data-inspector-status]')
  const partButtons = [...panel.querySelectorAll('[data-part-key]')]
  const referenceButton = panel.querySelector('[data-inspector-reference-select]')
  const relation = panel.querySelector('[data-inspector-relation]')
  const suggestedKey = partButtons.find(button => button.dataset.partSuggested === 'true')?.dataset.partKey || null
  const profile = resolveDeviceProfile(cs.terminal?.brand, cs.terminal?.model)
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  let generation = 0
  let cleanup3d = null
  let selectedKey = suggestedKey
  let assembled = !selectedKey
  let opened = false
  let disposed = false
  let mounting = false
  const motion = gsap.context(() => {}, panel)
  let transition = null
  const syncReference = () => {
    const pressed = partButtons.find(button => button.getAttribute('aria-pressed') === 'true')
    const linked = pressed?.dataset.partKey === suggestedKey
    panel.dataset.recordLinked = String(Boolean(linked))
    if (relation) relation.textContent = linked
      ? 'Pieza seleccionada · consulta el texto registrado abajo.'
      : pressed ? `Explorando ${pressed.textContent.split(' · ')[0]}. La mención del expediente se mantiene.`
        : 'Selecciona la pieza para relacionarla con el registro.'
    if (referenceButton) referenceButton.hidden = Boolean(linked)
  }
  const selectionObserver = new MutationObserver(() => {
    const pressed = partButtons.find(button => button.getAttribute('aria-pressed') === 'true')
    if (pressed) selectedKey = pressed.dataset.partKey
    syncReference()
  })
  partButtons.forEach(button => selectionObserver.observe(button, { attributes: true, attributeFilter: ['aria-pressed'] }))

  const active = token => !disposed && opened && panel.isConnected && token === generation
  const clearSelection = () => {
    selectedKey = null
    partButtons.forEach(button => button.setAttribute('aria-pressed', 'false'))
  }
  const fallbackState = () => revealFallback(host, assembled, status, partButtons)
  const stop3d = () => {
    const cleanup = cleanup3d
    cleanup3d = null
    cleanup?.()
    host._phoneSvgTween?.kill?.()
    host._phoneSvgTween = null
    delete host.dataset.phoneLive
    host.removeAttribute('data-3d-ready')
    host.removeAttribute('data-renderer-backend')
    host.querySelectorAll('.phone-canvas').forEach(canvas => canvas.remove())
  }
  const mount = async () => {
    if (!opened || mounting || disposed) return
    mounting = true
    const token = ++generation
    fallbackState()
    status.textContent = 'Preparando vista 3D; el esquema continúa disponible.'
    try {
      const { mountPhone3d } = await import('./phone3d.js')
      if (!active(token)) return
      const cleanup = await mountPhone3d(host, assemblyButton, status, {
        reduced: media.matches,
        assembled,
        getAssembled: () => assembled,
        playIntro: false,
        idleAnimation: false,
        idleScan: false,
        profile,
        partButtons,
        isActive: () => active(token),
        onStateChange: value => {
          assembled = value
          assemblyButton.setAttribute('aria-pressed', String(value))
          assemblyButton.textContent = value ? 'Explorar las capas' : 'Armar el teléfono'
        },
        onFallback: value => {
          assembled = value
          cleanup3d = null
          fallbackState()
          status.textContent = 'La vista 3D no está disponible. Puedes seguir inspeccionando el esquema.'
        },
      })
      if (!active(token)) { cleanup?.(); return }
      cleanup3d = cleanup
      const desiredAssembled = assembled
      const engineAssembled = host.dataset.assembled === 'true'
      assembled = engineAssembled
      assemblyButton.setAttribute('aria-pressed', String(assembled))
      assemblyButton.textContent = assembled ? 'Explorar las capas' : 'Armar el teléfono'
      if (engineAssembled !== desiredAssembled) assemblyButton.click()
      host.dataset.phoneLive = 'true'
      host.querySelector('.phone-fallback')?.setAttribute('aria-hidden', 'true')
      host.querySelector('.phone-svg')?.classList.add('has-webgl')
      const selectionAtReady = selectedKey
      if (selectionAtReady) {
        const button = partButtons.find(item => item.dataset.partKey === selectionAtReady)
        selectedKey = null
        button?.click()
      } else {
        status.textContent = 'Teléfono ensamblado. Selecciona Pantalla, Batería o Placa para inspeccionar sus capas.'
      }
    } catch {
      if (active(token)) {
        assembled = host.dataset.assembled !== 'false'
        fallbackState()
        status.textContent = 'La vista 3D no está disponible. Puedes seguir inspeccionando el esquema.'
      }
    } finally {
      if (token === generation) mounting = false
    }
  }
  const open = () => {
    if (disposed || opened) return
    opened = true
    panel.hidden = false
    panel.inert = false
    openButton.setAttribute('aria-expanded', 'true')
    if (selectedKey) {
      assembled = false
      host.dataset.assembled = 'false'
      assemblyButton.setAttribute('aria-pressed', 'false')
      assemblyButton.textContent = 'Armar el teléfono'
    }
    void mount()
    if (!transition) motion.add(() => {
      transition = gsap.fromTo(panel, { opacity: 0, y: 12, clipPath: 'inset(0 0 100% 0 round 18px)' }, {
        opacity: 1, y: 0, clipPath: 'inset(0 0 0% 0 round 18px)', duration: .42,
        ease: 'power2.out', paused: true,
        onReverseComplete: () => { if (!opened) panel.hidden = true },
      })
    })
    transition.timeScale(1).play()
    if (media.matches) transition.progress(1).pause()
    panel.querySelector('h2').focus({ preventScroll: true })
    panel.scrollIntoView({ behavior: media.matches ? 'instant' : 'smooth', block: 'nearest' })
  }
  const close = () => {
    if (!opened) return
    opened = false
    generation++
    mounting = false
    stop3d()
    assembled = true
    clearSelection()
    selectedKey = suggestedKey
    assemblyButton.setAttribute('aria-pressed', 'true')
    assemblyButton.textContent = 'Explorar las capas'
    panel.inert = true
    transition?.timeScale(1.6).reverse()
    if (media.matches || !transition || transition.progress() === 0) {
      transition?.progress(0).pause()
      panel.hidden = true
    }
    openButton.setAttribute('aria-expanded', 'false')
    openButton.focus({ preventScroll: true })
  }
  const onReducedChange = () => {
    if (media.matches && transition) {
      transition.progress(opened ? 1 : 0).pause()
      panel.hidden = !opened
    }
    if (!opened) return
    stop3d()
    mounting = false
    void mount()
  }
  const onPart = event => {
    const button = event.currentTarget
    if (cleanup3d) {
      selectedKey = button.dataset.partKey
      return
    }
    const next = button.dataset.partKey
    clearSelection()
    selectedKey = next
    if (next) button.setAttribute('aria-pressed', 'true')
    assembled = !next
    host.dataset.assembled = String(assembled)
    setPhoneSvgPose(host, assembled, { reduced: media.matches })
    status.textContent = next
      ? `${button.textContent} seleccionada. Diagrama esquemático: capas comunes visibles; la selección no enfoca una pieza en esta vista estática.`
      : 'Teléfono ensamblado. Selecciona una pieza para inspeccionar el modelo o el diagrama esquemático.'
  }
  const onPartCapture = event => {
    const button = event.currentTarget
    if (cleanup3d && selectedKey === button.dataset.partKey) event.stopImmediatePropagation()
  }
  const onAssembly = () => {
    clearSelection()
    if (cleanup3d) return
    assembled = !assembled
    host.dataset.assembled = String(assembled)
    setPhoneSvgPose(host, assembled, { reduced: media.matches })
    assemblyButton.setAttribute('aria-pressed', String(assembled))
    assemblyButton.textContent = assembled ? 'Explorar las capas' : 'Armar el teléfono'
    status.textContent = assembled
      ? 'Teléfono ensamblado. Selecciona una pieza para inspeccionar el modelo o el diagrama esquemático.'
      : 'Diagrama esquemático: capas comunes visibles; la selección no enfoca una pieza en esta vista estática.'
  }
  const onFull = () => {
    clearSelection()
    if (cleanup3d) {
      if (!assembled) assemblyButton.click()
      else status.textContent = 'Vista completa. Selecciona Pantalla, Batería o Placa para inspeccionar.'
    } else {
      assembled = true
      host.dataset.assembled = 'true'
      setPhoneSvgPose(host, true, { reduced: media.matches })
      assemblyButton.setAttribute('aria-pressed', 'true')
      assemblyButton.textContent = 'Explorar las capas'
      status.textContent = 'Vista completa. Selecciona una pieza para consultar el diagrama esquemático.'
    }
  }
  const onEscape = event => {
    if (event.key !== 'Escape' || !opened) return
    event.preventDefault()
    close()
  }
  const onReference = () => {
    const button = partButtons.find(item => item.dataset.partKey === suggestedKey)
    button?.click()
    button?.focus({ preventScroll: true })
  }
  panel.addEventListener('keydown', onEscape)
  referenceButton?.addEventListener('click', onReference)
  partButtons.forEach(button => {
    button.setAttribute('aria-label', `${button.textContent.split(' · ')[0]}${button.dataset.partSuggested ? ', mencionada en el expediente' : ''}`)
  })
  openButton.addEventListener('click', open)
  closeButton.addEventListener('click', close)
  fullButton.addEventListener('click', onFull)
  assemblyButton.addEventListener('click', onAssembly)
  partButtons.forEach(button => button.addEventListener('click', onPart))
  partButtons.forEach(button => button.addEventListener('click', onPartCapture, true))
  media.addEventListener?.('change', onReducedChange)
  const dispose = () => {
    if (disposed) return
    disposed = true
    opened = false
    generation++
    mounting = false
    stop3d()
    motion.revert()
    panel.removeEventListener('keydown', onEscape)
    referenceButton?.removeEventListener('click', onReference)
    media.removeEventListener?.('change', onReducedChange)
    openButton.removeEventListener('click', open)
    closeButton.removeEventListener('click', close)
    fullButton.removeEventListener('click', onFull)
    assemblyButton.removeEventListener('click', onAssembly)
    partButtons.forEach(button => button.removeEventListener('click', onPart))
    partButtons.forEach(button => button.removeEventListener('click', onPartCapture, true))
    selectionObserver.disconnect()
    instances.delete(main)
  }
  instances.set(main, dispose)
  return dispose
}

export function disposeCaseInspector(main) {
  instances.get(main)?.()
}
