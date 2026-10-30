import { esc, fmtMoney } from './util.js'

const SERVER_AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/

function readServerAmount(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? String(value) : null
  }
  if (typeof value !== 'string') return null
  const amount = value.trim()
  return SERVER_AMOUNT.test(amount) ? amount : null
}

export function hasConfirmedZeroBalance(balance) {
  const amount = readServerAmount(balance)
  return amount !== null && /^0+(?:\.0+)?$/.test(amount)
}

export function shouldShowPaymentForm({ mayRegisterPayment, balance }) {
  return Boolean(mayRegisterPayment) && !hasConfirmedZeroBalance(balance)
}

function serverAmountMarkup(value) {
  const amount = readServerAmount(value)
  return amount === null ? 'No disponible' : esc(fmtMoney(amount))
}

export function casePaymentSummaryMarkup(paidTotal, balance) {
  return `<div data-payment-summary><dl class="kv">
    <dt>Total pagado</dt><dd data-paid-total>${serverAmountMarkup(paidTotal)}</dd>
    <dt>Saldo</dt><dd data-payment-balance>${serverAmountMarkup(balance)}</dd>
  </dl></div>`
}

/* The saved write is retained across a failed refresh, so retries only call
   refresh. A decorative receipt is eligible only after that refresh resolves. */
export async function completeCaseOperation({ savedOperation, operationContext = {}, action, refresh, operationType = 'other' }) {
  let saved = savedOperation
  try {
    if (!saved) {
      await action()
      saved = { ...operationContext, operationType }
    }
    await refresh(saved)
    return { savedOperation: null, error: null, showPaymentReceipt: saved.operationType === 'payment' }
  } catch (error) {
    return { savedOperation: saved ?? null, error, showPaymentReceipt: false }
  }
}
