export const UNAVAILABLE_TECHNICIAN = '__unavailable__'

export function preferredTechnicianSelection({ technicians, currentTechnician, previousValue, preserveDraft = false }) {
  const roster = technicians || []
  const currentIsActive = roster.some(technician => String(technician.id) === String(currentTechnician?.id))

  if (preserveDraft) {
    if (previousValue === '') return ''
    if (roster.some(technician => String(technician.id) === String(previousValue))) {
      return String(previousValue)
    }
    return UNAVAILABLE_TECHNICIAN
  }
  if (previousValue === UNAVAILABLE_TECHNICIAN && currentTechnician && !currentIsActive) {
    return UNAVAILABLE_TECHNICIAN
  }
  if (roster.some(technician => String(technician.id) === String(previousValue))) {
    return String(previousValue)
  }
  if (currentIsActive) return String(currentTechnician.id)
  if (currentTechnician) return UNAVAILABLE_TECHNICIAN
  return ''
}

export function canSubmitTechnicianAssignment(value) {
  return value !== UNAVAILABLE_TECHNICIAN
}
