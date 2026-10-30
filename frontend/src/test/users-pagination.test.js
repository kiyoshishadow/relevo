import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
} })
const { createUsersPageHandler, createUsersPagination, userPageRange } = await import('../views/admin.js')
styles.deregister()

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function page(pageNumber, total = 205) {
  const pageSize = 100
  const start = (pageNumber - 1) * pageSize + 1
  const length = Math.max(0, Math.min(pageSize, total - start + 1))
  return {
    data: Array.from({ length }, (_, index) => ({ id: start + index, email: `u${start + index}@test` })),
    meta: { page: pageNumber, pageSize, total },
  }
}

test('rango y navegación reflejan páginas reales de más de cien usuarios', async () => {
  assert.deepEqual(userPageRange({ page: 2, pageSize: 100, total: 205 }), {
    page: 2, pageSize: 100, total: 205, pages: 3, first: 101, last: 200,
  })
  const requested = []
  const controller = createUsersPagination({
    fetchPage: async pageNumber => { requested.push(pageNumber); return page(pageNumber) },
  })
  await controller.load(1)
  await controller.load(2)
  await controller.load(1)
  assert.deepEqual(requested, [1, 2, 1])
  assert.equal(controller.state.data.length, 100)
  assert.equal(controller.state.page, 1)
  assert.equal(userPageRange(controller.state.meta).pages, 3)
})

test('el wiring de página exitosa llama al render real y al callback del guardado', async () => {
  const rendered = []
  const finalized = []
  const onPage = createUsersPageHandler((data, meta, state, options) => {
    rendered.push({ ids: data.map(user => user.id), meta, page: state.page, focusStatus: options.focusStatus })
  })
  const controller = createUsersPagination({
    fetchPage: async number => page(number),
    onPage,
  })
  await controller.load(1)
  await controller.load(2, { focusStatus: true, onSuccess: ({ state }) => finalized.push(state.page) })
  assert.deepEqual(rendered.map(result => result.page), [1, 2])
  assert.equal(rendered[1].ids[0], 101)
  assert.equal(rendered[1].focusStatus, true)
  assert.deepEqual(finalized, [2])
})

test('error de página conserva la vista y reintenta el mismo GET sin mutación', async () => {
  let getCount = 0
  let successfulMutations = 0
  const errors = []
  const controller = createUsersPagination({
    fetchPage: async pageNumber => {
      getCount += 1
      if (pageNumber === 2 && getCount === 2) throw new Error('Temporal')
      return page(pageNumber)
    },
    onError: (error, failedPage) => errors.push([error.message, failedPage]),
  })
  await controller.load(1)
  successfulMutations += 1 // Represents the one completed POST/PATCH.
  assert.equal(await controller.load(2), false)
  assert.equal(controller.state.page, 1, 'la página estable no cambia al fallar el GET')
  assert.deepEqual(errors, [['Temporal', 2]])
  assert.equal(await controller.retry(), true)
  assert.equal(controller.state.page, 2)
  assert.equal(getCount, 3, 'el reintento vuelve a consultar, no repite la mutación')
  assert.equal(successfulMutations, 1)
})

test('el editor y su borrador permanecen intactos durante una carga de página', async () => {
  const nextPage = deferred()
  const editor = { open: true, draft: 'texto escrito sin guardar' }
  let busySnapshots = 0
  let pageUpdates = 0
  const controller = createUsersPagination({
    fetchPage: number => number === 2 ? nextPage.promise : Promise.resolve(page(number)),
    onBusy: () => { busySnapshots += 1 },
    onPage: () => { pageUpdates += 1 },
  })
  await controller.load(1)
  const pending = controller.load(2)
  assert.equal(await controller.load(3), false, 'la navegación duplicada se rechaza mientras carga')
  assert.deepEqual(editor, { open: true, draft: 'texto escrito sin guardar' })
  assert.equal(controller.state.page, 1)
  nextPage.resolve(page(2))
  await pending
  assert.deepEqual(editor, { open: true, draft: 'texto escrito sin guardar' })
  assert.equal(controller.state.page, 2)
  assert.equal(pageUpdates, 2)
  assert.ok(busySnapshots >= 4)
})

test('una respuesta invalidada por una navegación más reciente no reemplaza la página actual', async () => {
  const slowPage = deferred()
  const seen = []
  const controller = createUsersPagination({
    fetchPage: number => number === 2 ? slowPage.promise : Promise.resolve(page(number)),
    onPage: ({ state }) => seen.push(state.page),
  })
  await controller.load(1)
  const stale = controller.load(2)
  controller.invalidate()
  await controller.load(3)
  slowPage.resolve(page(2))
  assert.equal(await stale, false)
  assert.equal(controller.state.page, 3)
  assert.deepEqual(seen, [1, 3])
})

test('refrescar tras guardar consulta la página actual y no inserta un usuario fuera de ella', async () => {
  let mutations = 0
  const requestedPages = []
  const rendered = []
  let failFirstRefresh = false
  const controller = createUsersPagination({
    fetchPage: async number => {
      requestedPages.push(number)
      if (number === 2 && failFirstRefresh) { failFirstRefresh = false; throw new Error('GET falló') }
      return page(number)
    },
    onPage: ({ data, options }) => rendered.push({ ids: data.map(user => user.id), savedId: options.savedId }),
  })
  await controller.load(2)
  failFirstRefresh = true
  const savedUser = { id: 250, role: 'admin' }
  mutations += 1
  const refreshed = await controller.load(controller.state.page, { savedId: savedUser.id })
  assert.equal(refreshed, false)
  assert.equal(await controller.retry(), true)
  assert.deepEqual(requestedPages, [2, 2, 2])
  assert.equal(mutations, 1)
  assert.equal(controller.state.data.some(user => user.id === savedUser.id), false)
  assert.equal(rendered.at(-1).savedId, savedUser.id, 'la UI puede anunciar el guardado sin inventar una fila')
})

test('no permite iniciar una mutación mientras cambia de página y conserva el borrador', async () => {
  const nextPage = deferred()
  const editor = { draft: 'borrador sin guardar' }
  const controller = createUsersPagination({
    fetchPage: number => number === 2 ? nextPage.promise : Promise.resolve(page(number)),
  })
  await controller.load(1)
  const navigation = controller.load(2)
  assert.equal(controller.beginMutation(), false)
  assert.deepEqual(editor, { draft: 'borrador sin guardar' })
  nextPage.resolve(page(2))
  await navigation
  assert.equal(controller.beginMutation(), true)
  assert.equal(await controller.load(3), false, 'no inicia GET mientras el POST/PATCH está activo')
  assert.equal(controller.state.failedPage, null, 'bloqueo de carrera no se representa como GET fallido')
  controller.endMutation()
  assert.equal(await controller.load(3), true)
})

test('GET de guardado puede reintentarse tras desconectar editor y libera estado sin repetir mutación', async () => {
  let mutationCount = 0
  let failRefresh = false
  let editorConnected = true
  let notice = ''
  let focused = false
  const controller = createUsersPagination({
    fetchPage: async number => {
      if (failRefresh) { failRefresh = false; throw new Error('GET temporal') }
      return page(number)
    },
    onPage: ({ options }) => options.onSuccess?.(),
  })
  await controller.load(2)
  failRefresh = true
  assert.equal(controller.beginMutation(), true)
  mutationCount += 1 // POST/PATCH succeeded once.
  controller.endMutation()
  controller.setSavedRefreshPending(true)
  assert.equal(await controller.load(2, { onSuccess: () => {
    controller.setSavedRefreshPending(false)
    if (!editorConnected) { notice = 'actualizada'; focused = true }
  } }), false)
  assert.equal(controller.state.failedPage, 2)
  editorConnected = false // The user closes the editor before retrying.
  assert.equal(await controller.retry(), true)
  assert.equal(controller.state.savedRefreshPending, false)
  assert.equal(notice, 'actualizada')
  assert.equal(focused, true)
  assert.equal(mutationCount, 1, 'retry solo repite GET')
})
