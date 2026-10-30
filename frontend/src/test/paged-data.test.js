import test from 'node:test'
import assert from 'node:assert/strict'
import { loadAllPages } from '../paged-data.js'

test('loadAllPages respects the API limit and returns rows from every page', async () => {
  const requests = []
  const request = async path => {
    requests.push(path)
    const page = Number(new URL(`http://localhost${path}`).searchParams.get('page'))
    return page === 1
      ? { data: ['a', 'b'], meta: { total: 5, pageSize: 2 } }
      : page === 2
        ? { data: ['c', 'd'], meta: { total: 5, pageSize: 2 } }
        : { data: ['e'], meta: { total: 5, pageSize: 2 } }
  }

  assert.deepEqual(await loadAllPages(request, '/clients', 2), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(requests, [
    '/clients?page=1&pageSize=2',
    '/clients?page=2&pageSize=2',
    '/clients?page=3&pageSize=2',
  ])
})

test('loadAllPages never requests a page larger than the endpoint maximum', async () => {
  await assert.rejects(loadAllPages(async () => ({ data: [] }), '/clients', 200), RangeError)
})

test('loadAllPages carries filters through every page and encodes them safely', async () => {
  const requests = []
  const request = async path => {
    requests.push(path)
    const url = new URL(`http://localhost${path}`)
    const page = Number(url.searchParams.get('page'))
    return page === 1
      ? { data: ['a'], meta: { total: 2, pageSize: 1 } }
      : { data: ['b'], meta: { total: 2, pageSize: 1 } }
  }

  assert.deepEqual(await loadAllPages(request, '/terminals', 1, { client_id: 42, q: 'A & B' }), ['a', 'b'])
  assert.deepEqual(requests.map(path => {
    const params = new URL(`http://localhost${path}`).searchParams
    return [params.get('client_id'), params.get('q'), params.get('page'), params.get('pageSize')]
  }), [['42', 'A & B', '1', '1'], ['42', 'A & B', '2', '1']])
})
