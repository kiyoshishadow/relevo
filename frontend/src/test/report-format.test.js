import test from 'node:test'
import assert from 'node:assert/strict'
import { reportCell, reportSummary, reportParams, reportError } from '../report-format.js'
test('report cells preserve cents, booleans and missing data',()=>{
  assert.equal(reportCell(7999,'cents'),new Intl.NumberFormat('es',{style:'currency',currency:'USD'}).format(79.99))
  assert.equal(reportCell(false,'boolean'),'No')
  assert.equal(reportCell('false','boolean'),'—')
  assert.equal(reportCell(null,'integer'),'—')
  assert.equal(reportCell('  ','integer'),'—')
  assert.equal(reportCell('2026-10-27','date').includes('27'),true)
  assert.equal(reportCell('2026-02-31','date'),'—')
  assert.equal(reportSummary('ingreso_cents',7999).label,'Ingresos')
})
test('report params include only catalog filters',()=>{
  const values=new FormData()
  values.set('brand',' Samsung ')
  values.set('technician_id','3')
  values.set('from','2026-10-01')
  values.set('format','pdf')
  assert.equal(reportParams({filters:['brand','from']},values).toString(),'brand=Samsung&from=2026-10-01')
})
test('report errors hide technical routes and preserve actionable validation',()=>{
  const unavailable=reportError({status:404,code:'NOT_FOUND',message:'Ruta no encontrada: GET /api/reports'})
  assert.match(unavailable,/Reintenta/)
  assert.doesNotMatch(unavailable,/GET|\/api|Ruta no encontrada/)
  assert.match(reportError(new TypeError('Failed to fetch')),/conexión/)
  assert.doesNotMatch(reportError({status:500,message:'SELECT password_hash FROM users'}),/SELECT|password_hash/)
  assert.equal(reportError({code:'VALIDATION_ERROR',message:'La fecha Desde debe ser anterior a Hasta.'}),'La fecha Desde debe ser anterior a Hasta.')
  assert.match(reportError({status:401}),/iniciar sesión/)
})
