import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canSubmitTechnicianAssignment,
  preferredTechnicianSelection,
  UNAVAILABLE_TECHNICIAN,
} from '../technician-assignment.js'

test('un técnico inactivo requiere una elección explícita antes de guardar', () => {
  const value = preferredTechnicianSelection({
    technicians: [{ id: 2, full_name: 'Técnico activo' }],
    currentTechnician: { id: 1, full_name: 'Técnico inactivo' },
    previousValue: '',
  })

  assert.equal(value, UNAVAILABLE_TECHNICIAN)
  assert.equal(canSubmitTechnicianAssignment(value), false)
  assert.equal(canSubmitTechnicianAssignment(''), true)
  assert.equal(canSubmitTechnicianAssignment('2'), true)
})

test('un borrador vacío conserva la elección Sin asignar aunque el caso tenga técnico', () => {
  assert.equal(preferredTechnicianSelection({
    technicians: [{ id: 1, full_name: 'Técnico actual' }],
    currentTechnician: { id: 1, full_name: 'Técnico actual' },
    previousValue: '',
    preserveDraft: true,
  }), '')
})

test('un borrador con técnico activo restaura ese ID y no el técnico anterior', () => {
  assert.equal(preferredTechnicianSelection({
    technicians: [
      { id: 1, full_name: 'Técnico actual' },
      { id: 2, full_name: 'Técnico elegido' },
    ],
    currentTechnician: { id: 1, full_name: 'Técnico actual' },
    previousValue: '2',
    preserveDraft: true,
  }), '2')
})

test('sin borrador mantiene el técnico activo actual al cargar el catálogo', () => {
  assert.equal(preferredTechnicianSelection({
    technicians: [{ id: 1, full_name: 'Técnico actual' }],
    currentTechnician: { id: 1, full_name: 'Técnico actual' },
    previousValue: '',
  }), '1')
})
