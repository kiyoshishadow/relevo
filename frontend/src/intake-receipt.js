import { esc, fmtDate } from './util.js'

export function intakeReceiptMarkup({ caseNumber, trackingToken, clientName, terminal, reportedProblem, receivedAt }) {
  const device = [terminal?.brand, terminal?.model].filter(Boolean).join(' ')
  const details = [
    ['Cliente', clientName],
    ['Equipo', device],
    ['Problema reportado', reportedProblem],
    ['Condición al ingreso', terminal?.initial_condition],
    ['Accesorios recibidos', terminal?.accessories],
  ]
  return `<section class="intake-receipt" tabindex="-1" aria-labelledby="intake-receipt-title">
    <div class="intake-receipt__head"><div><p>RELEVO · COMPROBANTE</p><h2 id="intake-receipt-title">Recepción del equipo</h2><span>Recibido el ${esc(fmtDate(receivedAt))}</span></div><button class="btn btn-primary" type="button" data-intake-print>Imprimir comprobante</button></div>
    <dl class="intake-receipt__details">${details.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(String(value ?? '').trim() || 'No registrado')}</dd></div>`).join('')}</dl>
    <div class="intake-receipt__credentials"><div><span>NÚMERO DE CASO</span><strong>${esc(caseNumber)}</strong></div><div><span>CLAVE DE SEGUIMIENTO</span><strong>${esc(trackingToken)}</strong></div></div>
    <p class="intake-receipt__help">Conserva ambos datos. Para consultar el avance, abre «Consultar mi caso» en Relevo e introduce el número y la clave. El cliente no necesita crear una cuenta; «Acceso del taller» es solo para el personal.</p>
  </section>`
}

export function bindIntakeReceiptPrint(root, print = () => globalThis.window?.print?.()) {
  const button = root?.querySelector?.('[data-intake-print]')
  if (!button) return () => {}
  const listener = () => {
    globalThis.document?.body?.classList.add('print-intake-receipt')
    print()
    globalThis.document?.body?.classList.remove('print-intake-receipt')
  }
  button.addEventListener('click', listener)
  return () => {
    button.removeEventListener('click', listener)
    globalThis.document?.body?.classList.remove('print-intake-receipt')
  }
}
