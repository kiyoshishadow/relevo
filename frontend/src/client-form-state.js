export function clientFormPayload(values, editing = false) {
  const read = name => String(values?.[name] ?? '').trim()
  const optional = name => read(name) || null

  const payload = {
    full_name: read('full_name'),
    phone: read('phone'),
    email: read('email'),
    document_id: optional('document_id'),
    address: optional('address'),
  }

  if (editing) payload.active = values?.active !== 'false' && values?.active !== false
  return payload
}

export function clientListStatus({ total, page, pageCount, successMessage = '' }) {
  const count = Number(total) || 0
  const result = `${count} ${count === 1 ? 'cliente encontrado' : 'clientes encontrados'}. Página ${Number(page) || 1} de ${Number(pageCount) || 1}.`
  return [successMessage, result].filter(Boolean).join(' ')
}

export function clientListErrorStatus(successMessage = '') {
  if (!successMessage) return 'No se pudieron cargar los clientes.'
  return `${successMessage} No se pudo actualizar la lista. Puedes reintentar la lectura sin repetir el guardado.`
}
