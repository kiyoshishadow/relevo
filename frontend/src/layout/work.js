// Vista interna: raíl lateral según el rol de la sesión.
import { session, loadSession } from '../session.js'
import { esc } from '../util.js'
import { onLeave, render } from '../router.js'

const linksFor = (role) => [
  ...(role === 'admin' || role === 'reception'
    ? [['/dashboard', 'Inicio del taller'], ['/notifications', 'Avisos internos']]
    : []),
  ['/cases', 'Casos'],
  ['/clients', 'Clientes'],
  ['/terminals', 'Equipos'],
  ...(role === 'admin' || role === 'reception' ? [['/coverages', 'Coberturas'], ['/loans', 'Equipos de préstamo']] : []),
  ...(role === 'admin' || role === 'reception' ? [['/reports', 'Reportes']] : []),
  ...(role === 'admin' ? [['/users', 'Usuarios'], ['/audit', 'Auditoría']] : []),
]

export function workShell(title, subtitle, bodyHtml, { wide = false } = {}) {
  const role = (session.user && session.user.role) || ''
  const links = linksFor(role)
    .map(([href, label]) =>
      `<a class="rail-link" href="#${href}" ${location.hash.startsWith('#' + href) ? "aria-current='page'" : ''}>${esc(label)}</a>`)
    .join('')
  return `
  <div class="work">
    <aside class="work-rail">
      <a href="#/dashboard" class="brand">Relevo</a>
      <div class="rail-group">Taller</div>
      ${links}
      <a class="rail-link" href="#/portal">Salida pública ↗</a>
    </aside>
    <main class="work-main">
      <div class="spread"><h1>${esc(title)}</h1><div style="color:var(--ink-mute)">${esc(subtitle || '')}</div></div>
      ${bodyHtml}
    </main>
  </div>`
}

// Guardia: exige sesión válida en el servidor. Nunca asume sin verificar.
export async function requireAuth(root) {
  if (!session.loaded) await loadSession()
  if (!session.user) {
    render(); // navega respetando el hash
    location.hash = '#/login'
    return false
  }
  return true
}

// Limpieza: las vistas registran trabajo por abandonar (timelines, listeners).
export { onLeave } from '../router.js'
