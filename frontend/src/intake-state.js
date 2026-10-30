export const INTAKE_FIELDS = Object.freeze([
  { key: 'client', name: 'client_id', errorId: 'case-client-error', error: 'Selecciona al cliente que entrega el equipo.', hint: 'Identifica al cliente que entrega el equipo.' },
  { key: 'terminal', name: 'terminal_id', errorId: 'case-terminal-error', error: 'Selecciona el equipo que ingresa al taller.', hint: 'Vincula el equipo que ingresa al taller.' },
  { key: 'problem', name: 'reported_problem', errorId: 'case-reported-problem-error', error: 'Describe el problema reportado con al menos 3 caracteres.', hint: 'Describe el problema con las palabras del cliente y usa al menos 3 caracteres.' },
])

export function intakeErrorElement(form, field) {
  return form.querySelector(`#${field.errorId}`)
}

export function activeIntakeClients(clients = []) {
  return clients.filter(client => client?.active === true)
}

export function terminalBelongsToClient(terminal, clientId) {
  if (clientId === '' || clientId === null || clientId === undefined) return false
  const ownerId = terminal?.client_id ?? terminal?.client?.id
  return ownerId !== null && ownerId !== undefined && String(ownerId) === String(clientId)
}

export function intakeTerminalsForClient(terminals = [], clientId = '') {
  if (clientId === '' || clientId === null || clientId === undefined) return terminals
  return terminals.filter(terminal => terminalBelongsToClient(terminal, clientId))
}

/** Completion describes actual fields, independently of the order of entry. */
export function intakeState(values = {}, { clients = [], terminals = [] } = {}) {
  const clientId = String(values.client_id ?? '').trim()
  const clientValid = activeIntakeClients(clients).some(client => String(client.id) === clientId)
  const terminalId = String(values.terminal_id ?? '').trim()
  const terminalValid = clientValid && terminals.some(terminal =>
    String(terminal.id) === terminalId && terminalBelongsToClient(terminal, clientId),
  )
  const problemValid = String(values.reported_problem ?? '').trim().length >= 3
  const validity = { client_id: clientValid, terminal_id: terminalValid, reported_problem: problemValid }
  const steps = INTAKE_FIELDS.map(field => ({ ...field, complete: validity[field.name] }))
  const done = steps.filter(step => step.complete).length
  const next = steps.find(step => !step.complete)
  return {
    steps, done, currentKey: next?.key ?? null, progress: done / steps.length,
    hint: next?.hint ?? 'Recepción completa: el caso está listo para abrirse.',
    errors: Object.fromEntries(steps.filter(step => !step.complete).map(step => [step.name, step.error])),
  }
}
