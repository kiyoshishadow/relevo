// Tablero del taller: laboratorio 3D con perfiles exactos y KPIs reales.
import { get } from '../api.js'
import { esc, pill, fmtMoney, fmtMoneyCents, fmtDate } from '../util.js'
import { workShell, requireAuth, onLeave } from '../layout/work.js'
import { phoneSvgHtml, toggleAssembly } from '../components/phone.js'
import { resolveDeviceProfile } from '../components/device-profiles.js'
import gsap from 'gsap'
import '../styles/dashboard-responsive.css'
import '../styles/dashboard-activity.css'

export function dashboardRendererLabel(backend) {
  const labels = {
    loading: 'ESCENA · CARGANDO',
    webgpu: 'WEBGPU · 3D',
    webgl2: 'WEBGL · 3D',
    fallback: 'SVG · 2D',
    'reduced-motion-svg': 'SVG · MOVIMIENTO REDUCIDO',
  }
  return labels[backend] || 'RENDERER · NO DISPONIBLE'
}

export function dashboardRendererBadgeHtml(backend = 'loading') {
  const knownBackend = ['loading', 'webgpu', 'webgl2', 'fallback', 'reduced-motion-svg'].includes(backend)
    ? backend : 'unknown'
  return `<span data-renderer-badge data-renderer-backend="${knownBackend}" aria-live="polite" aria-atomic="true">${dashboardRendererLabel(knownBackend)}</span>`
}

export function dashboardActivityHtml(data = {}) {
  const counts = data?.counts || {}
  const totals = data?.totals || {}
  const stat = (key, value, label, tone, href) => {
    const n = value === null || value === undefined || value === '' ? null : Number(value)
    const shown = n !== null && Number.isFinite(n) ? n : '—'
    return `<a class="stat" data-tone="${tone}" data-stat-key="${esc(key)}" href="${esc(href)}" aria-label="${esc(label)}: ${esc(shown)}. Ver registros">
      <b>${esc(shown)}</b><span class="stat-label">${esc(label)}</span><span class="stat-open" aria-hidden="true">↗</span><span class="stat-model" data-stat-key="${esc(key)}" aria-hidden="true"></span>
    </a>`
  }
  return `<div class="dashboard-activity">
    <section class="activity-group activity-workflow" aria-labelledby="activity-workflow-title" aria-describedby="activity-workflow-help">
      <header class="activity-group-heading"><h4 id="activity-workflow-title">Casos por estado</h4><p id="activity-workflow-help">Casos distintos en cada estado del servicio. Selecciona un grupo para revisar sus registros.</p></header>
      <div class="stat-row activity-workflow-grid">
        ${stat('received', counts.received, 'Recibidos · por diagnosticar', 'info', '#/cases?status=received')}
        ${stat('awaiting_approval', counts.awaiting_approval, 'Esperando aprobación', 'signal', '#/cases?status=awaiting_approval')}
        ${stat('awaiting_payment', counts.awaiting_payment, 'Esperando pago', 'signal', '#/cases?status=awaiting_payment')}
        ${stat('repairing', counts.repairing, 'En reparación', 'review', '#/cases?status=repairing')}
        ${stat('ready', counts.ready, 'Listos para entrega', 'ready', '#/cases?status=ready')}
      </div>
    </section>
    <section class="activity-group activity-inventory" aria-labelledby="activity-inventory-title" aria-describedby="activity-inventory-help">
      <header class="activity-group-heading"><h4 id="activity-inventory-title">Inventario y registros</h4><p id="activity-inventory-help">Consulta los préstamos fuera del taller y los registros de clientes, equipos y casos.</p></header>
      <div class="stat-row activity-inventory-grid">
        ${stat('loans_out', data?.loans_out, 'Préstamos fuera', 'signal', '#/loans')}
        ${stat('clients', totals.clients, 'Clientes registrados', 'neutral', '#/clients')}
        ${stat('terminals', totals.terminals, 'Equipos registrados', 'neutral', '#/terminals')}
        ${stat('total_cases', counts.total_cases ?? totals.cases, 'Casos totales', 'info', '#/cases')}
      </div>
    </section>
  </div>`
}

// Keep a single set of records and links as the container switches layout.
export function recentCasesHtml(cases = []) {
  const rows = (Array.isArray(cases) ? cases : []).map(cs => {
    const terminal = [cs.terminal?.brand, cs.terminal?.model].filter(Boolean).join(' ') || '—'
    return `<tr class="clickable" role="row" data-id="${esc(cs.id)}">
      <td role="cell" class="recent-case-number"><span class="recent-case-label" aria-hidden="true">Caso</span><a class="mono" href="#/cases/${encodeURIComponent(cs.id)}" aria-label="Abrir caso ${esc(cs.case_number)}">${esc(cs.case_number)}</a></td>
      <td role="cell"><span class="recent-case-label" aria-hidden="true">Cliente</span><span>${esc(cs.client_name || '—')}</span></td>
      <td role="cell" class="recent-case-terminal"><span class="recent-case-label" aria-hidden="true">Terminal</span><span>${esc(terminal)}</span></td>
      <td role="cell"><span class="recent-case-label" aria-hidden="true">Estado</span><span>${pill(cs.status)}</span></td>
      <td role="cell"><span class="recent-case-label" aria-hidden="true">Fecha de recepción</span><span>${fmtDate(cs.created_at)}</span></td>
    </tr>`
  }).join('')
  return `<section class="recent-cases" aria-labelledby="recent-cases-title">
    <h2 class="mt" id="recent-cases-title">Casos recientes</h2>
    <div class="table-wrap recent-cases-wrap"><table class="recent-cases-table" role="table" aria-labelledby="recent-cases-title">
      <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Número</th><th role="columnheader" scope="col">Cliente</th><th role="columnheader" scope="col">Terminal</th><th role="columnheader" scope="col">Estado</th><th role="columnheader" scope="col">Fecha de recepción</th></tr></thead>
      <tbody role="rowgroup">${rows || '<tr role="row" class="recent-cases-empty"><td role="cell" colspan="5">Aún no hay casos. <a href="#/cases/new">Abrir un nuevo caso</a>.</td></tr>'}</tbody>
    </table></div>
  </section>`
}

export async function dashboardView(root) {
  if (!(await requireAuth(root))) return
  root.innerHTML = workShell('Banco de servicio', 'Vista general de equipos y reparaciones', `<div class="skel">Consultando el servidor…</div>`)

  try {
    const { data } = await get('/dashboard')
    // La BD local contiene fixtures identificadas explícitamente por MarcaQA-*;
    // no deben presentarse como modelos del inventario del taller.
    const devices = (Array.isArray(data?.device_models) ? data.device_models : [])
      .filter(item => !/^MarcaQA-/i.test(String(item.brand || '')))
    const incomeShown = data?.income !== null && data?.income !== undefined && data?.income !== ''
      ? fmtMoney(data.income)
      : fmtMoneyCents(data?.income_cents)
    const modelOptions = devices.map((item, index) =>
      `<option value="${index}">${esc(item.brand)} ${esc(item.model)} · ${esc(item.terminal_count)} equipos</option>`).join('')
    const initialIndex = devices.length
      ? Math.max(0, devices.findIndex(item => resolveDeviceProfile(item.brand, item.model).exact))
      : -1

    root.querySelector('.work-main').innerHTML = `
      <section class="workshop-overview" aria-labelledby="workshop-title">
        <div class="workshop-heading">
          <div><p class="workshop-kicker"><span class="workshop-live-dot" aria-hidden="true"></span> BANCO DE SERVICIO · EN VIVO</p>
          <h2 id="workshop-title">Inspecciona el equipo</h2>
          <p class="workshop-intro">Abre una vista de producto, separa sus componentes y vuelve a ensamblarlo. Los datos del taller siguen siendo los registrados por el servidor.</p></div>
          <div class="workshop-index"><span>RELEVO / LAB</span>${dashboardRendererBadgeHtml()}</div>
        </div>

        <div class="device-lab">
          <div class="device-lab-stage-wrap">
            <div class="device-lab-stage" data-device-stage aria-label="Vista tridimensional ilustrativa del teléfono">
              <div class="device-stage-orbit" aria-hidden="true"><i></i><i></i><i></i></div>
              <div class="device-stage-mark" aria-hidden="true"><span>R</span><i></i><i></i></div>
              <div class="phone-fallback"><div class="phone-fallback-inner">${phoneSvgHtml({ id: 'device-lab-phone', profile: resolveDeviceProfile(devices[initialIndex]?.brand, devices[initialIndex]?.model) })}</div></div>
              <div class="device-stage-tag"><span class="device-stage-signal"></span><span data-profile-tag>Vista ilustrativa</span></div>
            </div>
            <div class="device-stage-caption"><span>Vista posterior de producto</span><span data-device-gesture>Usa los controles para explorar el esquema</span></div>
          </div>

          <aside class="device-lab-console" aria-label="Controles de inspección">
            <div class="device-console-top"><span class="device-console-icon" aria-hidden="true">⌁</span><div><small>CATÁLOGO DEL TALLER</small><h3>Equipo seleccionado</h3></div></div>
            ${devices.length
              ? `<label class="device-select-label" for="device-model-select">Modelo registrado</label><select id="device-model-select" data-device-model-select class="device-model-select">${modelOptions}</select>`
              : `<div class="device-empty-note">Aún no hay equipos registrados. La maqueta de demostración no representa un caso real.</div>`}
            <div class="device-selected-model" aria-live="polite"><span data-device-brand>${esc(devices[initialIndex]?.brand || 'Dispositivo de muestra')}</span><strong data-device-model>${esc(devices[initialIndex]?.model || 'Teléfono ilustrativo')}</strong><small data-device-count>${devices.length ? `${esc(devices[initialIndex]?.terminal_count)} equipos · ${esc(devices[initialIndex]?.case_count)} casos` : 'Sin datos de inventario'}</small></div>
            <div class="device-model-note" data-model-note>Interior esquemático para explicar el servicio; no es un despiece de fábrica.</div>
            <div class="device-console-divider"></div>
            <button class="btn btn-primary device-assembly-toggle" type="button" aria-pressed="true" data-device-toggle>Explorar las capas</button>
            <div class="device-part-heading"><span>Enfocar componente</span><span>SELECCIÓN 3D</span></div>
            <div class="device-part-grid">
              <button type="button" class="device-part" data-part-key="back" aria-pressed="false">Carcasa</button>
              <button type="button" class="device-part" data-part-key="display" aria-pressed="false">Pantalla</button>
              <button type="button" class="device-part" data-part-key="battery" aria-pressed="false">Batería</button>
              <button type="button" class="device-part" data-part-key="cameras" aria-pressed="false">Cámaras</button>
              <button type="button" class="device-part" data-part-key="board" aria-pressed="false">Placa</button>
              <button type="button" class="device-part" data-part-key="chassis" aria-pressed="false">Estructura</button>
              <button type="button" class="device-part device-part-reset" data-part-key="" aria-pressed="false">Vista completa</button>
            </div>
            <p class="device-lab-status" data-device-status role="status">Preparando el banco de inspección…</p>
          </aside>
        </div>

        <div class="workshop-stats-heading"><h3>Actividad del taller</h3><span>Selecciona un indicador para abrir sus registros</span></div>
        ${dashboardActivityHtml(data)}
      </section>
      <a class="panel income-panel" href="#/reports" aria-label="Ingresos registrados: ${esc(incomeShown)}. Abrir reportes"><span class="income-ornament" aria-hidden="true"><i></i><i></i><i></i><i></i></span><b class="mono" style="font-size:1.5rem">${esc(incomeShown)}</b>
        <div style="color:var(--ink-mute)">Ingresos registrados${incomeShown === '—' ? ' (sin dato válido del servidor)' : ''}</div>
      </a>
      ${recentCasesHtml(data.recent_cases)}`

    const open = id => location.hash = '#/cases/' + encodeURIComponent(id)
    root.querySelectorAll('.recent-cases-table tbody tr.clickable').forEach(row => {
      row.addEventListener('click', event => {
        if (event.target.closest('a, button')) return
        open(row.dataset.id)
      })
    })

    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const host = root.querySelector('[data-device-stage]')
    const toggle = root.querySelector('[data-device-toggle]')
    const status = root.querySelector('[data-device-status]')
    const select = root.querySelector('[data-device-model-select]')
    const partButtons = [...root.querySelectorAll('[data-part-key]')]
    let active = true
    let sceneDispose = null
    let metricsSceneDispose = null
    let selectionVersion = 0
    let selectedIndex = initialIndex
    let modelInfoTween = null
    let rendererBadgeTween = null
    let fallbackAssembled = true
    let fallbackClick = null
    const rendererBadge = root.querySelector('[data-renderer-badge]')
    const setRendererBadge = backend => {
      const knownBackend = ['loading', 'webgpu', 'webgl2', 'fallback', 'reduced-motion-svg'].includes(backend)
        ? backend : 'unknown'
      const label = dashboardRendererLabel(knownBackend)
      if (!rendererBadge || rendererBadge.textContent === label) return
      rendererBadge.textContent = label
      rendererBadge.dataset.rendererBackend = knownBackend
      rendererBadgeTween?.kill()
      if (!reduced) {
        rendererBadgeTween = gsap.fromTo(rendererBadge,
          { y: -4, scale: .97, autoAlpha: .55 },
          { y: 0, scale: 1, autoAlpha: 1, duration: .26, ease: 'power3.out' })
      }
    }
    const dropFallbackEvents = () => {
      if (fallbackClick) toggle.removeEventListener('click', fallbackClick)
      partButtons.forEach(button => button.removeEventListener('click', onFallbackPart))
    }
    const onFallbackPart = event => {
      partButtons.forEach(button => button.setAttribute('aria-pressed', String(button === event.currentTarget)))
      const labels = { back: 'carcasa posterior', display: 'pantalla', battery: 'batería', cameras: 'cámaras', board: 'placa', chassis: 'estructura' }
      status.textContent = event.currentTarget.dataset.partKey
        ? `Vista esquemática: ${labels[event.currentTarget.dataset.partKey]}. Usa Explorar las capas para separar los componentes.`
        : 'Vista esquemática completa. Interior ilustrativo.'
    }
    const activateFallback = (message, assembled = fallbackAssembled) => {
      if (!active) return
      setRendererBadge(host.dataset.rendererBackend || 'fallback')
      root.querySelector('[data-device-gesture]').textContent = 'Usa los controles para explorar el esquema'
      fallbackAssembled = assembled
      host.dataset.assembled = String(assembled)
      toggle.setAttribute('aria-pressed', String(assembled))
      toggle.textContent = assembled ? 'Explorar las capas' : 'Ensamblar teléfono'
      toggleAssembly(root, 'device-lab-phone', assembled, { reduced })
      dropFallbackEvents()
      fallbackClick = () => {
        fallbackAssembled = !fallbackAssembled
        host.dataset.assembled = String(fallbackAssembled)
        toggle.setAttribute('aria-pressed', String(fallbackAssembled))
        toggle.textContent = fallbackAssembled ? 'Explorar las capas' : 'Ensamblar teléfono'
        toggleAssembly(root, 'device-lab-phone', fallbackAssembled, { reduced })
        status.textContent = fallbackAssembled ? 'Teléfono esquemático ensamblado.' : 'Piezas esquemáticas separadas; interior ilustrativo.'
      }
      toggle.addEventListener('click', fallbackClick)
      partButtons.forEach(button => button.addEventListener('click', onFallbackPart))
      status.textContent = message
    }
    const renderDevice = async index => {
      // With an empty catalog, keep the explicitly labelled demonstration
      // usable instead of leaving its SVG and controls in a loading state.
      if (!Number.isInteger(index) || (devices.length ? index < 0 || index >= devices.length : index !== -1)) return
      selectedIndex = index
      if (select && select.value !== String(index)) select.value = String(index)
      const version = ++selectionVersion
      sceneDispose?.(); sceneDispose = null
      host.dataset.rendererBackend = 'loading'
      host.removeAttribute('data-device-lab-ready')
      host.removeAttribute('data-3d-ready')
      setRendererBadge('loading')
      const device = devices[index] || null
      const profile = resolveDeviceProfile(device?.brand, device?.model)
      host.dataset.deviceProfile = profile.exact ? `${profile.brand}:${profile.model}` : 'illustrative'
      host.dataset.assembled = 'true'
      root.querySelector('[data-device-brand]').textContent = device?.brand || 'Dispositivo de muestra'
      root.querySelector('[data-device-model]').textContent = device?.model || 'Teléfono ilustrativo'
      root.querySelector('[data-device-count]').textContent = device
        ? `${device.terminal_count} equipos · ${device.case_count} casos`
        : 'Sin datos de inventario'
      modelInfoTween?.kill()
      if (!reduced) {
        modelInfoTween = gsap.fromTo(root.querySelector('.device-selected-model'),
          { y: 10, autoAlpha: .55, scale: .985 },
          { y: 0, autoAlpha: 1, scale: 1, duration: .38, ease: 'power3.out', clearProps: 'all' })
      }
      root.querySelector('[data-profile-tag]').textContent = profile.exact ? 'Perfil exterior identificado' : 'Vista ilustrativa'
      root.querySelector('[data-model-note]').textContent = profile.exact
        ? 'Exterior con rasgos reconocibles; componentes internos representados de forma esquemática.'
        : device
          ? 'No existe un perfil exacto para este modelo; se conserva el nombre y se muestra una silueta ilustrativa.'
          : 'Maqueta de demostración; no representa un equipo o reparación registrados.'
      root._phoneSvgTween?.kill()
      host.querySelector('.phone-fallback').innerHTML = `<div class="phone-fallback-inner">${phoneSvgHtml({ id: 'device-lab-phone', profile })}</div>`
      host.querySelector('.phone-fallback')?.removeAttribute('aria-hidden')
      host.querySelector('.phone-svg')?.classList.remove('has-webgl')
      host.removeAttribute('data-3d-ready')
      dropFallbackEvents()
      fallbackAssembled = true
      toggle.setAttribute('aria-pressed', 'true')
      toggle.textContent = 'Explorar las capas'
      partButtons.forEach(button => button.setAttribute('aria-pressed', 'false'))

      if (reduced) {
        host.dataset.rendererBackend = 'reduced-motion-svg'
        activateFallback('Movimiento reducido activado: vista estática con controles accesibles.')
        return
      }
      activateFallback('Vista 2D disponible mientras se prepara la escena WebGPU…')
      try {
        const { mountPhone3d } = await import('../components/phone3d.js')
        if (!active || version !== selectionVersion || !host.isConnected) return
        const dispose = await mountPhone3d(host, toggle, status, {
          profile,
          partButtons,
          reduced,
          assembled: fallbackAssembled,
          getAssembled: () => fallbackAssembled,
          // Rebuild each selected model through the same short exploded-to-assembled reveal.
          playIntro: true,
          isActive: () => active && version === selectionVersion && host.isConnected,
          onStateChange: assembled => {
            host.dataset.assembled = String(assembled)
            fallbackAssembled = assembled
          },
          onFallback: assembled => activateFallback('La GPU no está disponible; se conserva el diagrama 2D interactivo.', assembled),
        })
        if (!active || version !== selectionVersion) { dispose?.(); return }
        sceneDispose = dispose
        dropFallbackEvents()
        if (!host.dataset.rendererBackend || ['loading', 'unknown'].includes(host.dataset.rendererBackend)) {
          activateFallback('WebGPU no pudo iniciar; se conserva el diagrama 2D interactivo.')
        } else {
          setRendererBadge(host.dataset.rendererBackend)
          dropFallbackEvents()
          host.querySelector('.phone-fallback')?.setAttribute('aria-hidden', 'true')
          host.querySelector('.phone-svg')?.classList.add('has-webgl')
          host.dataset.deviceLabReady = 'true'
          root.querySelector('[data-device-gesture]').textContent = 'Arrastra para girar; toca una pieza para enfocarla'
          status.textContent = `Escena ${host.dataset.rendererBackend === 'webgpu' ? 'WebGPU' : 'WebGL'} lista. Arrastra para girar o selecciona una pieza en el teléfono o en sus controles.`
        }
      } catch {
        if (active && version === selectionVersion) {
          host.dataset.rendererBackend = 'fallback'
          activateFallback('WebGPU no pudo iniciar; se conserva el diagrama 2D interactivo.')
        }
      }
    }
    if (select) {
      select.value = String(initialIndex)
      const onDeviceSelection = () => {
        const nextIndex = Number(select.value)
        if (nextIndex !== selectedIndex) void renderDevice(nextIndex)
      }
      // Native selects fire input and change at different times across browsers.
      // Both routes feed the same guarded selection so the label, profile and scene stay in sync.
      select.addEventListener('input', onDeviceSelection)
      select.addEventListener('change', onDeviceSelection)
      onLeave(() => {
        select.removeEventListener('input', onDeviceSelection)
        select.removeEventListener('change', onDeviceSelection)
      })
    }
    onLeave(() => {
      active = false
      selectionVersion++
      modelInfoTween?.kill(); modelInfoTween = null
      rendererBadgeTween?.kill(); rendererBadgeTween = null
      sceneDispose?.(); sceneDispose = null
      metricsSceneDispose?.(); metricsSceneDispose = null
      root._phoneSvgTween?.kill()
      dropFallbackEvents()
    })
    void renderDevice(initialIndex)

    // The dashboard metrics own independent, lightweight 3D props. Keep the
    // import lazy so public pages and other admin routes do not pay its cost.
    void import('../components/workshop-scene.js').then(({ mountWorkshopScene }) => {
      if (!active || !host.isConnected) return
      metricsSceneDispose = mountWorkshopScene(root.querySelector('.dashboard-activity'), data)
    }).catch(() => {})

    const cards = root.querySelectorAll('.stat')
    if (!reduced) {
      const tl = gsap.from(cards, {
        autoAlpha: 0,
        y: 10,
        duration: .42,
        stagger: .035,
        ease: 'power3.out',
        clearProps: 'all',
      })
      onLeave(() => tl.kill())
    }
  } catch (error) {
    root.querySelector('.work-main').innerHTML = `<div class="notice notice-error" role="alert">${esc(error?.message || 'No se pudo cargar el estado del taller.')}</div>`
  }
}
