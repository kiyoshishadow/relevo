// Sesión: solo refleja lo que responde GET /api/auth/me; nada simulado.
import { get } from './api.js'

export const session = { user: null, loaded: false }

export async function loadSession() {
  try {
    const { data } = await get('/auth/me')
    session.user = data && data.user ? data.user : data
  } catch {
    session.user = null
  }
  session.loaded = true
  return session.user
}
