import test from 'node:test'
import assert from 'node:assert/strict'
import { ALLOWED_TRANSITIONS } from '../../../server/domain/states.js'
import {
  availableCaseTransitions,
  canAddCaseAction,
  canAssignCaseLoan,
  canAssignCaseTechnician,
  canCancelCase,
  canDiagnose,
  canRegisterCasePayment,
  canReturnCaseLoan,
  caseExcludedReason,
} from '../case-permissions.js'

test('diagnóstico respeta rol, estados editables y asignación técnica', () => {
  assert.equal(canDiagnose({ role: 'admin', status: 'awaiting_approval' }), true)
  assert.equal(canDiagnose({ role: 'reception', status: 'received' }), false)
  assert.equal(canDiagnose({ role: 'technician', status: 'diagnosing', assignedTo: 9, userId: 9 }), true)
  assert.equal(canDiagnose({ role: 'technician', status: 'diagnosing', assignedTo: 8, userId: 9 }), false)
  assert.equal(canDiagnose({ role: 'technician', status: 'diagnosing' }), false)
  assert.equal(canDiagnose({ role: 'technician', status: 'diagnosing', assignedTo: 9 }), false)
  assert.equal(canDiagnose({ role: 'technician', status: 'diagnosing', userId: 9 }), false)
  assert.equal(canDiagnose({ role: 'technician', status: 'diagnosing', assignedTo: '9', userId: 9 }), true)
  assert.equal(canDiagnose({ role: 'technician', status: 'diagnosing', assignedTo: ' ', userId: ' ' }), false)
  assert.equal(canDiagnose({ role: 'technician', status: 'diagnosing', assignedTo: 9, userId: 9, coverageOverride: true }), false)
  assert.equal(canDiagnose({ role: 'admin', status: 'diagnosing', coverageOverride: true }), true)
  assert.equal(canAddCaseAction({ role: 'technician', status: 'repairing' }), false)
  assert.equal(canAssignCaseLoan({ role: 'technician', status: 'repairing', activeLoan: false }), false)
  assert.equal(canReturnCaseLoan({ role: 'technician', activeLoan: true }), false)
  assert.equal(canDiagnose({ role: 'admin', status: 'repairing' }), false)
})

test('la exclusión se lee desde la forma anidada del detalle API', () => {
  const detail = { diagnosis: { text: 'No enciende', problem_type: 'hardware', excluded_reason: 'Daño por líquido', diagnosed_at: '2026-10-28T10:00:00.000Z' } }
  assert.equal(caseExcludedReason(detail), 'Daño por líquido')
  assert.equal(caseExcludedReason({ diagnosis: null }), '')
})

test('transiciones parten del dominio y esconden destinos bloqueados por reglas reales', () => {
  assert.deepEqual(availableCaseTransitions({ from: 'received', role: 'admin' }), ['diagnosing'])
  assert.deepEqual(availableCaseTransitions({ from: 'diagnosing', role: 'technician' }), [])
  assert.deepEqual(availableCaseTransitions({ from: 'diagnosing', role: 'admin', coverageEvaluated: true, covered: true }), ['awaiting_approval', 'repairing'])
  assert.deepEqual(availableCaseTransitions({ from: 'diagnosing', role: 'admin', acceptedQuote: true }), ['awaiting_approval', 'awaiting_payment'])
  assert.deepEqual(availableCaseTransitions({ from: 'awaiting_payment', role: 'admin', coverageEvaluated: true, covered: false, acceptedQuote: true, paidCents: 50, quoteTotalCents: 100 }), [])
  assert.deepEqual(availableCaseTransitions({ from: 'ready', role: 'admin', activeLoan: true }), [])
  assert.deepEqual(availableCaseTransitions({ from: 'cancelled', role: 'admin' }), [])
  for (const from of Object.keys(ALLOWED_TRANSITIONS)) {
    const choices = availableCaseTransitions({
      from,
      role: 'admin',
      coverageEvaluated: true,
      covered: true,
      acceptedQuote: true,
      activeLoan: false,
    })
    assert.ok(choices.every(to => ALLOWED_TRANSITIONS[from].includes(to) && to !== 'cancelled'))
  }
})

test('acciones, préstamos, pagos y asignación se limitan por rol y estado', () => {
  assert.equal(canAddCaseAction({ role: 'technician', status: 'ready', assignedTo: 9, userId: 9 }), true)
  assert.equal(canAddCaseAction({ role: 'reception', status: 'delivered' }), false)
  assert.equal(canAssignCaseLoan({ role: 'reception', status: 'repairing', activeLoan: false }), true)
  assert.equal(canAssignCaseLoan({ role: 'reception', status: 'cancelled', activeLoan: false }), false)
  assert.equal(canAssignCaseLoan({ role: 'technician', status: 'repairing', assignedTo: 8, userId: 9, activeLoan: false }), false)
  assert.equal(canReturnCaseLoan({ role: 'technician', status: 'repairing', assignedTo: 9, userId: 8, activeLoan: true }), false)
  assert.equal(canReturnCaseLoan({ role: 'reception', status: 'repairing', activeLoan: true }), true)
  assert.equal(canReturnCaseLoan({ role: 'reception', status: 'cancelled', activeLoan: true }), true)
  assert.equal(canReturnCaseLoan({ role: 'reception', status: 'cancelled', activeLoan: false }), false)
  assert.equal(canRegisterCasePayment({ role: 'reception', status: 'awaiting_payment', acceptedQuote: true }), true)
  assert.equal(canRegisterCasePayment({ role: 'admin', status: 'repairing', acceptedQuote: true }), false)
  assert.equal(canAssignCaseTechnician({ role: 'admin', status: 'ready' }), true)
  assert.equal(canAssignCaseTechnician({ role: 'reception', status: 'delivered' }), false)
  assert.equal(canCancelCase({ role: 'admin', status: 'ready' }), true)
  assert.equal(canCancelCase({ role: 'reception', status: 'received' }), true)
  assert.equal(canCancelCase({ role: 'technician', status: 'diagnosing' }), false)
  assert.equal(canCancelCase({ role: 'admin', status: 'delivered' }), false)
  assert.equal(canCancelCase({ role: 'reception', status: 'cancelled' }), false)
})
