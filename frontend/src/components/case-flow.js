import { esc, fmtDate, STATE_LABEL } from '../util.js'

const benchStates = {
  received: ['intake', 'Recepción del equipo', 'diagnosis'],
  diagnosing: ['inspect', 'Inspección técnica', 'diagnosis'],
  awaiting_approval: ['hold', 'Decisión del cliente', 'quote'],
  awaiting_payment: ['hold', 'Pago de la reparación', 'payment'],
  repairing: ['repair', 'Trabajo en el equipo', 'actions'],
  ready: ['closed', 'Preparación de entrega', 'transition'],
  delivered: ['closed', 'Entrega registrada', 'transition'],
  cancelled: ['stopped', 'Caso cancelado', null],
}

/** Scene vocabulary describes the confirmed state, never inferred progress. */
export function caseBenchModel(cs = {}) {
  const [mode, caption, panel] = benchStates[cs.status] || ['unknown', 'Estado sin identificar', null]
  return { mode, caption, panel, label: STATE_LABEL[cs.status] || 'Estado sin identificar',
    device: [cs.terminal?.brand, cs.terminal?.model].filter(Boolean).join(' ') || 'Terminal sin identificar' }
}

export function caseBenchMarkup(cs) {
  const model = caseBenchModel(cs)
  return `<section class="case-bench" data-case-bench data-mode="${model.mode}" aria-labelledby="case-bench-title">
    <div class="case-bench__stage" aria-hidden="true">
      <div class="case-bench__orbit"></div><div class="case-bench__orbit case-bench__orbit--inner"></div>
      <div class="case-bench__assembly">
        <div class="case-bench__part case-bench__shell"><i></i><i></i></div>
        <div class="case-bench__part case-bench__board"><i></i><i></i><i></i><span></span></div>
        <div class="case-bench__part case-bench__screen"><span></span><i></i></div>
      </div>
      <div class="case-bench__probe"></div><div class="case-bench__scan"></div>
      <span class="case-bench__caption">${esc(model.caption)}</span>
    </div>
    <div class="case-bench__readout">
      <p class="case-bench__verified"><span></span>Estado confirmado</p>
      <h2 id="case-bench-title">${esc(model.label)}</h2>
      <p class="case-bench__device">${esc(model.device)}</p>
      <dl><div><dt>Última actualización</dt><dd>${esc(fmtDate(cs.updated_at))}</dd></div>
      <div><dt>Técnico asignado</dt><dd>${esc(cs.technician?.full_name || 'Sin asignar')}</dd></div></dl>
      ${model.panel ? `<button type="button" class="btn btn-ghost" data-case-jump="${model.panel}">Abrir ${({ diagnosis: 'diagnóstico', quote: 'cotización', payment: 'pagos', actions: 'acciones', transition: 'estado' })[model.panel]}</button>` : ''}
      <button type="button" class="btn btn-ghost" data-bench-animate aria-describedby="case-bench-animate-hint">Animar despiece</button>
      <button type="button" class="btn btn-primary" data-case-inspector-open aria-expanded="false" aria-controls="case-inspector-${esc(cs.id)}">Inspeccionar equipo</button>
      <small id="case-bench-animate-hint" data-bench-animate-hint>Reproduce el despiece del esquema sin modificar el caso.</small>
      <small>Vista esquemática de servicio. El estado procede del expediente.</small>
    </div>
  </section>`
}

const knownStatuses = new Set(Object.keys(STATE_LABEL))

/**
 * The API history is authoritative for past milestones. The current status is
 * authoritative for the present; it is shown without a timestamp if history
 * is empty or does not end at that status.
 */
export function caseFlowMarkup(status, history = [], { interactive = false } = {}) {
  const recorded = (Array.isArray(history) ? history : [])
    .map(item => ({
      status: item?.to_status || item?.status,
      at: item?.created_at || item?.at,
      note: item?.note,
    }))
    .filter(item => knownStatuses.has(item.status))

  const historyEndsAtCurrent = recorded.at(-1)?.status === status
  const events = recorded.map((item, index) => ({
    ...item,
    current: historyEndsAtCurrent && index === recorded.length - 1,
    completed: !(historyEndsAtCurrent && index === recorded.length - 1),
    unrecorded: false,
  }))

  if (!historyEndsAtCurrent && knownStatuses.has(status)) {
    events.push({ status, at: null, note: null, current: true, completed: false, unrecorded: true })
  }

  const noHistory = recorded.length === 0
  const mismatch = recorded.length > 0 && !historyEndsAtCurrent

  return `<section class="panel case-flow" aria-labelledby="case-flow-title">
    <div class="case-flow__heading"><div><p class="case-flow__eyebrow">SEGUIMIENTO DEL TALLER</p><h2 id="case-flow-title">Recorrido del caso</h2></div>
      <span class="case-flow__count">${recorded.length} ${recorded.length === 1 ? 'movimiento' : 'movimientos'}</span></div>
    <ol class="case-flow__list" aria-label="Movimientos del caso">
      ${events.map((event, index) => {
        const next = events[index + 1]
        const uncertainLink = event.completed && next?.unrecorded
        const marker = `<span class="case-flow__marker" aria-hidden="true">${event.current ? '<span></span>' : event.completed ? '✓' : '·'}</span>`
        const details = `<span class="case-flow__line"><b>${esc(STATE_LABEL[event.status])}</b>
            <span class="case-flow__badge">${event.current ? 'Estado actual' : 'Etapa completada'}</span></span>
            ${event.at ? `<time class="case-flow__time">${esc(fmtDate(event.at))}</time>` : ''}
            ${event.note ? `<span class="case-flow__note">${esc(event.note)}</span>` : ''}
            ${event.unrecorded ? `<span class="case-flow__note">${noHistory ? 'No hay movimientos reconocibles en el historial; se muestra solo el estado actual.' : 'El historial disponible no confirma la fecha de este estado.'}</span>` : ''}`
        const step = interactive
          ? `<button class="case-flow__step${event.current ? ' is-selected' : ''}" type="button" data-track-history-step data-track-step-status="${esc(event.status)}" data-track-step-time="${esc(event.at || '')}" aria-pressed="${event.current ? 'true' : 'false'}" aria-label="Inspeccionar ${esc(STATE_LABEL[event.status])}${event.at ? `, registrado ${esc(fmtDate(event.at))}` : ''}">${marker}<span class="case-flow__content">${details}</span></button>`
          : `${marker}<div class="case-flow__content">${details}</div>`
        return `<li class="case-flow__item${event.current ? ' is-current' : ''}${event.completed ? ' is-complete' : ''}${uncertainLink ? ' has-unrecorded-gap' : ''}"${event.current ? ' aria-current="step"' : ''}>
        ${step}
      </li>`}).join('')}
    </ol>
    ${mismatch ? '<p class="case-flow__notice" role="status">El estado actual no coincide con el último movimiento registrado. Se conserva el historial y se muestra el estado vigente sin atribuirle una fecha.</p>' : ''}
  </section>`
}
