import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const {
  createCoveragePager, coveragePagination, setCoverageNavigationBusy,
  focusCoverageReturnTarget, coveragePageResponseCanRender, retrySavedCoverageRefresh,
} = await import('../views/coverages.js')
styles.deregister()

test('pagination model reports page controls and status from API metadata', () => {
  const first = coveragePagination({ total: 201, page: 1, pageSize: 100 }, 1, 100)
  assert.equal(first.status, '1–100 de 201 planes · página 1 de 3')
  assert.equal(first.canPrevious, false)
  assert.equal(first.canNext, true)

  const last = coveragePagination({ total: 201, page: 3, pageSize: 100 }, 3, 1)
  assert.equal(last.status, '201–201 de 201 planes · página 3 de 3')
  assert.equal(last.canPrevious, true)
  assert.equal(last.canNext, false)
})

test('pager requests only the chosen page and refreshes the same page', async () => {
  const requests = []
  const request = async path => {
    requests.push(path)
    const params = new URL(path, 'http://localhost').searchParams
    const page = Number(params.get('page'))
    assert.equal(params.get('pageSize'), '100')
    return {
      data: Array.from({ length: page === 3 ? 1 : 100 }, (_, index) => ({ id: (page - 1) * 100 + index + 1 })),
      meta: { total: 201, page, pageSize: 100 },
    }
  }
  const pager = createCoveragePager(request)

  const first = await pager.load(1)
  const third = await pager.load(3)
  const refreshed = await pager.refresh()

  assert.equal(first.data.length, 100)
  assert.equal(third.data[0].id, 201)
  assert.equal(refreshed.pagination.page, 3)
  assert.equal(pager.currentPage, 3)
  assert.deepEqual(requests, [
    '/coverages?page=1&pageSize=100',
    '/coverages?page=3&pageSize=100',
    '/coverages?page=3&pageSize=100',
  ])
})

test('unknown metadata is stated honestly and failed navigation does not change the current page', async () => {
  const unknown = coveragePagination(undefined, 1, 100)
  assert.equal(unknown.status, 'Página 1 · total desconocido')
  assert.equal(unknown.canNext, true)
  assert.equal(unknown.canPrevious, false)

  let failNext = false
  const pager = createCoveragePager(async path => {
    const page = Number(new URL(path, 'http://localhost').searchParams.get('page'))
    if (failNext) throw new Error('falló lectura')
    return { data: [{ id: page }], meta: { total: 2, page, pageSize: 100 } }
  })
  await pager.load(1)
  failNext = true
  await assert.rejects(pager.load(2), /falló lectura/)
  assert.equal(pager.currentPage, 1)
})

test('delayed navigation disables form openers and restores the page boundary controls after failure', async () => {
  const controls = [
    { selector: '[data-new]', disabled: false },
    { selector: '[data-edit]', disabled: false },
    { selector: '[data-page][aria-label="Página anterior de coberturas"]', disabled: true },
    { selector: '[data-page][aria-label="Página siguiente de coberturas"]', disabled: false },
  ]
  const main = {
    querySelectorAll(selector) {
      if (selector === '[data-retry-page]') return []
      return controls.filter(control => selector === '[data-new], [data-edit]'
        ? ['[data-new]', '[data-edit]'].includes(control.selector)
        : control.selector.startsWith('[data-page]'))
    },
    querySelector(selector) {
      if (selector === '[data-newform] form') return null
      if (selector.includes('anterior')) return controls[2]
      if (selector.includes('siguiente')) return controls[3]
      return null
    },
  }
  let resolveResponse
  const delayed = new Promise(resolve => { resolveResponse = resolve })
  const pageOne = { canPrevious: false, canNext: true }

  assert.equal(main.querySelector('[data-page][aria-label="Página anterior de coberturas"]'), controls[2])
  setCoverageNavigationBusy(main, true, pageOne)
  assert.equal(controls[0].disabled, true)
  assert.equal(controls[1].disabled, true)
  assert.equal(controls[2].disabled, true, JSON.stringify(controls))
  assert.equal(controls[3].disabled, true)
  resolveResponse()
  await delayed
  setCoverageNavigationBusy(main, false, pageOne)
  assert.equal(controls[0].disabled, false)
  assert.equal(controls[1].disabled, false)
  assert.equal(controls[2].disabled, true, JSON.stringify(controls))
  assert.equal(controls[3].disabled, false)
})

test('restore focus falls back to Registrar plan when the edited row is not on the refreshed page', () => {
  let focused = false
  const opener = { focus() { focused = true } }
  const main = {
    querySelectorAll: () => [{ dataset: { edit: '10' }, focus() { throw new Error('unexpected row focus') } }],
    querySelector: selector => selector === '[data-new]' ? opener : null,
  }

  assert.equal(focusCoverageReturnTarget(main, 99), opener)
  assert.equal(focused, true)
})

test('restore focus falls back to page status when no opener is present', () => {
  let focused = false
  const status = { focus() { focused = true } }
  const main = { querySelectorAll: () => [], querySelector: selector => selector === '[data-page-status]' ? status : null }

  assert.equal(focusCoverageReturnTarget(main, 99), status)
  assert.equal(focused, true)
})

test('a page response cannot replace an open draft, and page retry is disabled during editing', () => {
  const retry = { disabled: false }
  const previous = { disabled: false }
  const next = { disabled: false }
  const form = {}
  const main = {
    isConnected: true,
    querySelector: selector => selector === '[data-newform] form' ? form
      : selector.includes('Página anterior') ? previous
        : selector.includes('Página siguiente') ? next : null,
    querySelectorAll: selector => selector === '[data-retry-page]' ? [retry] : [],
  }

  assert.equal(coveragePageResponseCanRender(main), false)
  setCoverageNavigationBusy(main, false, { canPrevious: true, canNext: true })
  assert.equal(retry.disabled, true)
  assert.equal(previous.disabled, true)
  assert.equal(next.disabled, true)
})

test('saved-plan refresh retry locks openers during GET, restores them on failure, and never posts again', async () => {
  const controls = [
    { selector: '[data-new]', disabled: false },
    { selector: '[data-edit]', disabled: false },
    { selector: '[data-page][aria-label="Página anterior de coberturas"]', disabled: true },
    { selector: '[data-page][aria-label="Página siguiente de coberturas"]', disabled: true },
  ]
  const closeButton = { disabled: false }
  const main = {
    isConnected: true,
    querySelector(selector) {
      if (selector === '[data-newform] form') return {}
      return controls.find(control => control.selector === selector) || null
    },
    querySelectorAll(selector) {
      if (selector === '[data-new], [data-edit]') return controls.slice(0, 2)
      if (selector === '[data-retry-page]') return []
      return controls.filter(control => control.selector.startsWith('[data-page]'))
    },
  }
  let resolveGet
  const getPending = new Promise((_, reject) => { resolveGet = reject })
  let getCount = 0
  let postCount = 1 // El POST original ya terminó con éxito.
  const pager = { refresh() { getCount += 1; return getPending } }
  const pagination = { canPrevious: true, canNext: true }
  const retry = retrySavedCoverageRefresh(main, pager, pagination, () => assert.fail('GET debía fallar'), () => {})

  assert.equal(controls[0].disabled, true)
  assert.equal(controls[1].disabled, true)
  assert.equal(closeButton.disabled, false)
  assert.equal(getCount, 1)
  resolveGet(new Error('falló GET'))
  assert.equal(await retry, false)
  assert.equal(controls[0].disabled, true)
  assert.equal(controls[1].disabled, true)
  assert.equal(closeButton.disabled, false)
  assert.equal(getCount, 1)
  assert.equal(postCount, 1)
})
