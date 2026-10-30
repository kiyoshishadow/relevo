// Utilidades de render honesto: cargando, error y helpers de formularios (sin simulaciones).
import { esc } from './util.js'

export function pageShell(title, subtitle, innerHtml = '') {
  return `
    <div class="page">
      <div class="spread">
        <h1>${esc(title)}</h1>
        ${subtitle ? `<div style="color:var(--ink-mute)">${esc(subtitle)}</div>` : ''}
      </div>
      <div class="view-body">${innerHtml}</div>
    </div>`
}

export function loadingHtml(msg = 'Cargando…') {
  return `<div class="skel" role="status">${esc(msg)}</div>`
}

export function errorHtml(err) {
  const msg = err && err.message ? err.message : 'Ocurrió un problema.'
  const code = err && err.code ? ` (${esc(err.code)})` : ''
  return `<div class="notice notice-error" role="alert">${msg}${code}</div>`
}

export async function handleAction(button, fn) {
  if (button.disabled) return
  button.disabled = true
  button.classList.add('is-loading')
  try { await fn() } catch (e) { flashError(e) }
  finally { button.disabled = false; button.classList.remove('is-loading') }
}

let toastTimer = null
export function flash(message, kind = 'error') {
  let box = document.getElementById('flash-box')
  if (!box) {
    box = document.createElement('div')
    box.id = 'flash-box'
    box.style.cssText = 'position:fixed;bottom:1.2rem;left:50%;transform:translateX(-50%);z-index:99;max-width:min(90vw,520px)'
    document.body.appendChild(box)
  }
  box.innerHTML = `<div class="notice notice-${kind}" role="status" style="margin:0">${esc(message)}</div>`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { box.innerHTML = '' }, 6000)
}

export function flashError(e) {
  flash(e && e.message ? e.message : 'Ocurrió un problema.', 'error')
}

export function flashOk(message) { flash(message, 'ok') }

let fieldId = 0
export function field(label, inputHtml, help = '') {
  const control = inputHtml.match(/<(input|select|textarea)\b[^>]*>/i)?.[0]
  const existingId = control?.match(/\bid=["']([^"']+)["']/i)?.[1]
  const id = existingId || `field-${++fieldId}`
  const helpId = help ? `${id}-help` : ''
  let linkedHtml = inputHtml
  if (control) {
    let linkedControl = control
    if (!existingId) linkedControl = linkedControl.replace(/^<(input|select|textarea)\b/i, `<$1 id="${id}"`)
    if (help) {
      const describedBy = linkedControl.match(/\baria-describedby=["']([^"']*)["']/i)?.[1]
      const ids = describedBy ? describedBy.split(/\s+/).filter(Boolean) : []
      if (!ids.includes(helpId)) ids.push(helpId)
      if (describedBy) linkedControl = linkedControl.replace(/\baria-describedby=["'][^"']*["']/i, `aria-describedby="${esc(ids.join(' '))}"`)
      else linkedControl = linkedControl.replace(/\s*\/?\s*>$/, ` aria-describedby="${esc(ids.join(' '))}">`)
    }
    linkedHtml = inputHtml.replace(control, linkedControl)
  }
  return `<div class="field"><label for="${esc(id)}">${esc(label)}</label>${linkedHtml}${help ? `<small id="${esc(helpId)}">${esc(help)}</small>` : ''}</div>`
}

export function textInput(name, placeholder = '', attrs = '') {
  return `<input id="f-${name}" name="${esc(name)}" type="text" placeholder="${esc(placeholder)}" ${attrs}>`
}
