const QUOTE_EDITABLE_STATUSES = new Set(['diagnosing', 'awaiting_approval', 'awaiting_payment'])

export function canManageQuote(role) {
  return role === 'admin' || role === 'reception'
}

export function canIssueQuote({ role, status, payments = [] } = {}) {
  return canManageQuote(role) && QUOTE_EDITABLE_STATUSES.has(status) && payments.length === 0
}

export function parseQuoteDecision(value) {
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}
