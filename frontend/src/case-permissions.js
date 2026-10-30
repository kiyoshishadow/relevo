const TRANSITIONS = {
  received: ['diagnosing'],
  diagnosing: ['awaiting_approval', 'awaiting_payment', 'repairing'],
  awaiting_approval: ['awaiting_payment', 'repairing'],
  awaiting_payment: ['repairing'],
  repairing: ['ready'],
  ready: ['delivered'],
  delivered: [],
  cancelled: [],
}

const TERMINAL = new Set(['delivered', 'cancelled'])
const DIAGNOSIS_STATES = new Set(['received', 'diagnosing', 'awaiting_approval'])
const STAFF = new Set(['admin', 'reception', 'technician'])

function hasCaseAccess({ role, assignedTo, userId }) {
  if (!STAFF.has(role)) return false
  if (role !== 'technician') return true
  if (assignedTo === null || assignedTo === undefined || assignedTo === '' || userId === null || userId === undefined || userId === '') return false
  const assignedId = Number(assignedTo)
  const actorId = Number(userId)
  return Number.isSafeInteger(assignedId) && assignedId > 0
    && Number.isSafeInteger(actorId) && actorId > 0 && assignedId === actorId
}

export function caseExcludedReason(caseDetail) {
  return caseDetail?.diagnosis?.excluded_reason || ''
}

export function canDiagnose({ role, status, assignedTo, userId, coverageOverride = false } = {}) {
  if (role === 'technician' && coverageOverride) return false
  return ['admin', 'technician'].includes(role) && DIAGNOSIS_STATES.has(status)
    && hasCaseAccess({ role, assignedTo, userId })
}

export function availableCaseTransitions({ from, role, coverageEvaluated, covered, acceptedQuote, paidCents = 0, quoteTotalCents = 0, activeLoan } = {}) {
  if (!STAFF.has(role) || !TRANSITIONS[from] || TERMINAL.has(from)) return []
  return TRANSITIONS[from].filter(to => {
    if (role === 'technician' && !['diagnosing', 'repairing', 'ready'].includes(to)) return false
    if (to === 'awaiting_payment' && !acceptedQuote) return false
    if (to === 'repairing') {
      if (!coverageEvaluated) return false
      if (!covered && (!acceptedQuote || Number(paidCents) < Number(quoteTotalCents))) return false
    }
    if (to === 'delivered' && activeLoan) return false
    return true
  })
}

export function canAddCaseAction({ role, status, assignedTo, userId } = {}) {
  return hasCaseAccess({ role, assignedTo, userId }) && !TERMINAL.has(status)
}

export function canAssignCaseLoan({ role, status, assignedTo, userId, activeLoan } = {}) {
  return hasCaseAccess({ role, assignedTo, userId }) && !TERMINAL.has(status) && !activeLoan
}

export function canReturnCaseLoan({ role, status, assignedTo, userId, activeLoan } = {}) {
  return hasCaseAccess({ role, assignedTo, userId }) && Boolean(activeLoan)
}

export function canRegisterCasePayment({ role, status, acceptedQuote } = {}) {
  return ['admin', 'reception'].includes(role) && status === 'awaiting_payment' && Boolean(acceptedQuote)
}

export function canAssignCaseTechnician({ role, status } = {}) {
  return ['admin', 'reception'].includes(role) && !TERMINAL.has(status)
}

export function canCancelCase({ role, status } = {}) {
  return ['admin', 'reception'].includes(role) && !TERMINAL.has(status)
}
