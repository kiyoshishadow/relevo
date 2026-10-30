const DEFAULT_PAGE_SIZE = 100

/** Load a complete paginated collection without exceeding the API page limit. */
export async function loadAllPages(request, path, pageSize = DEFAULT_PAGE_SIZE, filters = {}) {
  if (typeof request !== 'function') throw new TypeError('request debe ser una función')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > DEFAULT_PAGE_SIZE) {
    throw new RangeError(`pageSize debe estar entre 1 y ${DEFAULT_PAGE_SIZE}`)
  }
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new TypeError('filters debe ser un objeto')
  }

  const pagePath = page => {
    const [base, existingQuery = ''] = path.split('?')
    const params = new URLSearchParams(existingQuery)
    for (const [key, value] of Object.entries(filters)) {
      if (value !== null && value !== undefined && value !== '') params.set(key, String(value))
    }
    params.set('page', String(page))
    params.set('pageSize', String(pageSize))
    return `${base}?${params.toString()}`
  }

  const first = await request(pagePath(1))
  const rows = Array.isArray(first?.data) ? first.data : []
  const total = Number(first?.meta?.total)
  const pageCount = Number.isFinite(total) && total >= 0
    ? Math.max(1, Math.ceil(total / pageSize))
    : 1

  if (pageCount === 1) return rows

  const pages = await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) =>
    request(pagePath(index + 2)),
  ))
  return rows.concat(...pages.map(page => Array.isArray(page?.data) ? page.data : []))
}
