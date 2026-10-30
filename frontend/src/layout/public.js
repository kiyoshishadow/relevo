// Casco público: barra superior con marca y navegación mínima.
import { session, loadSession } from '../session.js'
import { esc } from '../util.js'
import { post, clearCsrf } from '../api.js'
import { flashError } from '../ui.js'
import { navigate } from '../router.js'

export function publicShell(innerHtml, { navTrack = true, showcase = false } = {}) {
  const user = session.user
  return `
  <div class="shell${showcase ? ' portal-showcase' : ''}">
    <header class="topbar">
      <a href="#/portal" class="brand">Relevo</a>
      <nav aria-label="Principal">
        ${navTrack ? `<a class="topnav-link" href="#/portal" ${location.hash === '#/portal' ? "aria-current='page'" : ''}>Consultar mi caso</a>` : ''}
        ${user
          ? `<a class="topnav-link" href="#/dashboard" ${location.hash.startsWith('#/dashboard') ? "aria-current='page'" : ''}>Panel del taller</a>
             <button class="btn btn-ghost" data-logout>Salir</button>`
          : `<a class="topnav-link" href="#/login" ${location.hash === '#/login' ? "aria-current='page'" : ''}>Acceso del taller</a>`}
      </nav>
    </header>
    ${innerHtml}
    <footer class="foot">
      <span>Relevo · reparación de terminales</span>
      <span>Consulta tu caso con el número y la clave que te dimos al recibir el equipo.</span>
    </footer>
  </div>`
}

// Enlaza el botón de salir si existe (real: llama al servidor).
export function bindLogout(root) {
  const btn = root.querySelector('[data-logout]')
  if (!btn) return
  btn.addEventListener('click', async () => {
    btn.disabled = true
    try {
      await post('/auth/logout')
      clearCsrf()
      session.user = null
      navigate('/portal')
    } catch (e) {
      flashError(e)
      btn.disabled = false
    }
  })
}

// Asegura carga de sesión para decidir el nav (sin bloquear el portal).
export async function ensureSessionNav() {
  if (!session.loaded) await loadSession()
}
