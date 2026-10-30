import test from 'node:test'
import assert from 'node:assert/strict'
import { clientFormPayload, clientListErrorStatus, clientListStatus } from '../client-form-state.js'

test('client create payload keeps required contact fields and normalizes empty optional values', () => {
  assert.deepEqual(clientFormPayload({
    full_name: '  Ana Rivera  ',
    phone: '  5555-1234 ',
    email: ' ana@example.com ',
    document_id: '',
    address: '  ',
  }), {
    full_name: 'Ana Rivera',
    phone: '5555-1234',
    email: 'ana@example.com',
    document_id: null,
    address: null,
  })
})

test('client patch sends null for optional fields cleared by the operator', () => {
  assert.deepEqual(clientFormPayload({
    full_name: 'Ana Rivera',
    phone: '5555-1234',
    email: 'ana@example.com',
    document_id: '   ',
    address: '',
    active: 'false',
  }, true), {
    full_name: 'Ana Rivera',
    phone: '5555-1234',
    email: 'ana@example.com',
    document_id: null,
    address: null,
    active: false,
  })
})

test('list refresh error preserves the confirmed write and offers read-only retry language', () => {
  const saved = 'Cliente registrado.'
  assert.equal(clientListErrorStatus(saved), 'Cliente registrado. No se pudo actualizar la lista. Puedes reintentar la lectura sin repetir el guardado.')
  assert.equal(clientListStatus({ total: 1, page: 1, pageCount: 1, successMessage: saved }), 'Cliente registrado. 1 cliente encontrado. Página 1 de 1.')
})
