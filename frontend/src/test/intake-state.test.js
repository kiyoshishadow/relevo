import test from 'node:test'
import assert from 'node:assert/strict'
import { INTAKE_FIELDS, activeIntakeClients, intakeErrorElement, intakeState, intakeTerminalsForClient } from '../intake-state.js'

const clients = [
  { id: 7, active: true },
  { id: 8, active: false },
  { id: 9 },
]
const terminals = [
  { id: 12, client_id: 7 },
  { id: 13, client_id: 8 },
  { id: 14, client: { id: 7 } },
]
const context = { clients, terminals }
const valuesFor = mask => ({
  client_id: mask & 1 ? '7' : '',
  terminal_id: mask & 2 ? '12' : '',
  reported_problem: mask & 4 ? 'Pantalla rota' : '',
})

test('error de problema se encuentra por su ID explícito aunque la ayuda use dos IDs', () => {
  const problemField = INTAKE_FIELDS.find(field => field.key === 'problem')
  const errorNode = { textContent: '', hidden: true }
  const queries = []
  const form = {
    querySelector(selector) {
      queries.push(selector)
      return selector === '#case-reported-problem-error' ? errorNode : null
    },
  }

  assert.equal(intakeErrorElement(form, problemField), errorNode)
  assert.deepEqual(queries, ['#case-reported-problem-error'])
})

test('recepción cuenta solo cliente activo, equipo asociado y problema de al menos tres caracteres', () => {
  for (let mask = 0; mask < 8; mask++) {
    const state = intakeState(valuesFor(mask), context)
    const valid = [Boolean(mask & 1), Boolean((mask & 1) && (mask & 2)), Boolean(mask & 4)]
    const done = valid.filter(Boolean).length
    assert.equal(state.done, done)
    assert.equal(state.progress, done / 3)
    assert.equal(Object.keys(state.errors).length, 3 - done)
    assert.equal(state.currentKey, ['client', 'terminal', 'problem'].find((_, index) => !valid[index]) ?? null)
  }
})

test('cliente inactivo o sin active verdadero nunca completa el paso de cliente', () => {
  assert.deepEqual(activeIntakeClients(clients), [clients[0]])
  for (const client_id of ['8', '9', '']) {
    const state = intakeState({ client_id, terminal_id: '12', reported_problem: 'No enciende' }, context)
    assert.equal(state.steps[0].complete, false)
    assert.equal(state.steps[1].complete, false)
    assert.ok(state.errors.client_id)
    assert.ok(state.errors.terminal_id)
  }
})

test('un equipo seleccionado antes del cliente se conserva para comprobarlo después', () => {
  assert.deepEqual(intakeTerminalsForClient(terminals).map(terminal => terminal.id), [12, 13, 14])
  assert.deepEqual(intakeTerminalsForClient(terminals, '' ).map(terminal => terminal.id), [12, 13, 14])
  assert.deepEqual(intakeTerminalsForClient(terminals, '7').map(terminal => terminal.id), [12, 14])
  const pending = intakeState({ terminal_id: '12' }, context)
  const matched = intakeState({ client_id: '7', terminal_id: '12' }, context)
  const incompatible = intakeState({ client_id: '7', terminal_id: '13' }, context)
  assert.equal(pending.steps[1].complete, false)
  assert.equal(matched.steps[1].complete, true)
  assert.equal(incompatible.steps[1].complete, false)
  assert.ok(incompatible.errors.terminal_id)
})

test('problema exige tres caracteres útiles y se corrige al editar el borrador', () => {
  const complete = { client_id: '7', terminal_id: '12', reported_problem: 'No enciende' }
  const tooShort = intakeState({ ...complete, reported_problem: ' a ' }, context)
  assert.match(tooShort.errors.reported_problem, /al menos 3 caracteres/)
  assert.match(tooShort.hint, /al menos 3 caracteres/)
  for (const reported_problem of ['', '  ', 'a', ' a ']) {
    const state = intakeState({ ...complete, reported_problem }, context)
    assert.equal(state.steps[2].complete, false)
    assert.ok(state.errors.reported_problem)
  }
  const recovered = intakeState({ ...complete, reported_problem: '  LCD  ' }, context)
  assert.equal(recovered.steps[2].complete, true)
  assert.equal(recovered.currentKey, null)
})

test('borrar un campo válido vuelve a señalar el siguiente paso pendiente', () => {
  const complete = { client_id: '7', terminal_id: '12', reported_problem: 'No enciende' }
  assert.equal(intakeState(complete, context).currentKey, null)
  const edited = intakeState({ ...complete, reported_problem: '  ' }, context)
  assert.equal(edited.currentKey, 'problem')
  assert.equal(edited.done, 2)
  assert.deepEqual(Object.keys(edited.errors), ['reported_problem'])
})
