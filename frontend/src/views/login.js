// Acceso del taller: formulario real contra POST /api/auth/login.
import '../styles/login-motion.css'
import { post, clearCsrf } from '../api.js'
import { session, loadSession } from '../session.js'
import { esc } from '../util.js'
import { navigate, render } from '../router.js'
import { publicShell } from '../layout/public.js'
import { field } from '../ui.js'

export async function loginView(root) {
  await loadSession()
  if (session.user) { navigate('/dashboard'); return }

  root.innerHTML = publicShell(`
    <div class="page login-page login-access-page">
      <h1 style="margin-top:2rem">Acceso del taller</h1>
      <form data-login class="panel login-panel login-access">
        ${field('Correo', `<input name="email" type="email" autocomplete="username" required>`)}
        ${field('Contraseña', `<input name="password" type="password" autocomplete="current-password" required>`)}
        <button class="btn btn-primary login-access__submit" type="submit">Entrar</button>
        <div data-error></div>
      </form>
      <p><small>¿Sin cuenta? Solo el equipo del taller tiene acceso; los clientes consultan su caso en <a href="#/portal">seguimiento</a>.</small></p>
    </div>
  `, { navTrack: false })

  const form = root.querySelector('[data-login]')
  const errBox = root.querySelector('[data-error]')
  const btn = form.querySelector('button[type=submit]')
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    errBox.innerHTML = ''
    btn.disabled = true
    btn.classList.add('is-auth-pending')
    const f = new FormData(form)
    try {
      await post('/auth/login', { email: f.get('email'), password: f.get('password') })
      clearCsrf() // la sesión nueva puede tener un token CSRF nuevo
      await loadSession()
      navigate('/dashboard')
    } catch (e) {
      errBox.innerHTML = errorAlert(e)
      btn.classList.remove('is-auth-pending')
      btn.disabled = false
    }
  })
}

function errorAlert(e) {
  return `<div class="notice notice-error" role="alert" style="margin-top:.8rem">${esc(e?.message || 'No se pudo iniciar sesión.')}${e?.code ? `<small>${esc(e.code)}</small>` : ''}</div>`
}
