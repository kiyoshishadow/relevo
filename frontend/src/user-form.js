// Campos de usuario compartidos por alta/edición. La contraseña vacía en edición
// significa conservar la actual; nunca se envía como cadena vacía.
export function buildUserPayload({ email, full_name, role, active, password }) {
  const payload = {
    email: String(email ?? '').trim(),
    full_name: String(full_name ?? '').trim(),
    role: String(role ?? ''),
  }
  if (active !== undefined) payload.active = active === true || active === 'true'
  if (password !== undefined && password !== '') payload.password = String(password)
  return payload
}
