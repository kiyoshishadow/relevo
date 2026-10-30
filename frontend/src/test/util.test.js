// Prueba discriminante del dinero y las fechas (node --test).
// Corre: npm test en frontend/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtMoney, fmtMoneyCents, fmtDay, fmtDate } from '../util.js'

test('7999 dólares en unidades se mantiene en unidades (sin división global)', () => {
  const s = fmtMoney('7999.00')
  assert.match(s, /7999[.,]00/, `esperaba 7999,00 en ${s}`)
})

test('7999 CENTAVOS se convierte explícitamente a $79.99 — el bug del dashboard', () => {
  const s = fmtMoneyCents(7999)
  assert.match(s, /79[.,]99/, `esperaba 79,99/79.99 en ${s}`)
  assert.doesNotMatch(s, /7[.,]999/, `centavos no deben formatearse en unidades: ${s}`)
  // Cadena numérica de centavos enteros también soportada
  assert.match(fmtMoneyCents('7999'), /79[.,]99/)
})

test('cero monetario válido se formatea correctamente en unidades y centavos', () => {
  assert.match(fmtMoney(0), /0[.,]00/)
  assert.match(fmtMoney('0'), /0[.,]00/)
  assert.match(fmtMoneyCents(0), /0[.,]00/)
  assert.match(fmtMoneyCents('0'), /0[.,]00/)
})

test('dato financiero ausente o inválido devuelve "—", nunca 0 silencioso', () => {
  // fmtMoney
  assert.equal(fmtMoney(null), '—')
  assert.equal(fmtMoney(undefined), '—')
  assert.equal(fmtMoney(''), '—')
  assert.equal(fmtMoney('   '), '—')
  assert.equal(fmtMoney('abc'), '—')
  assert.equal(fmtMoney(NaN), '—')
  assert.equal(fmtMoney(Infinity), '—')
  assert.equal(fmtMoney(false), '—')
  assert.equal(fmtMoney(true), '—')

  // fmtMoneyCents (especial cuidado: Number(null) es 0 en JS, pero debe dar "—")
  assert.equal(fmtMoneyCents(null), '—')
  assert.equal(fmtMoneyCents(undefined), '—')
  assert.equal(fmtMoneyCents(''), '—')
  assert.equal(fmtMoneyCents('   '), '—')
  assert.equal(fmtMoneyCents('abc'), '—')
  assert.equal(fmtMoneyCents(79.5), '—') // centavos no enteros: inválido
  assert.equal(fmtMoneyCents(NaN), '—')
  assert.equal(fmtMoneyCents(false), '—')
  assert.equal(fmtMoneyCents(true), '—')
})

test('quote.total y payment.amount en unidades NO cambian de escala', () => {
  assert.match(fmtMoney('45.50'), /45[.,]50/)
})

test('fmtDay con YYYY-MM-DD no corre un día en UTC ni America/El_Salvador', () => {
  const s27 = fmtDay('2026-10-27')
  assert.ok(s27.includes('27') && s27.includes('octubre') && s27.includes('2026'), `esperaba 27 de octubre de 2026 en ${s27}`)
  const s01 = fmtDay('2026-01-01')
  assert.ok(s01.includes('1') && s01.includes('enero') && s01.includes('2026'), `esperaba 1 de enero de 2026 en ${s01}`)
})

test('fmtDay valida fechas inválidas y datos vacíos', () => {
  assert.equal(fmtDay(null), '—')
  assert.equal(fmtDay(undefined), '—')
  assert.equal(fmtDay(''), '—')
  assert.equal(fmtDay('invalido'), '—')
  assert.equal(fmtDay('2026-02-31'), '—')
  assert.equal(fmtDay('2026-13-40'), '—')
})

test('fmtDay con timestamp ISO respeta el huso horario de El Salvador (UTC-6)', () => {
  // 2026-10-28 02:00 UTC son las 20:00 del 27 de octubre en El Salvador
  const sEarlier = fmtDay('2026-10-28T02:00:00Z')
  assert.ok(sEarlier.includes('27'), `02:00Z del 28 oct debe ser 27 oct en SV: ${sEarlier}`)

  // 2026-10-28 07:00 UTC es la 01:00 del 28 de octubre en El Salvador (cambio de día)
  const sLater = fmtDay('2026-10-28T07:00:00Z')
  assert.ok(sLater.includes('28'), `07:00Z del 28 oct debe ser 28 oct en SV: ${sLater}`)
})

test('fmtDate formatea fecha y hora en America/El_Salvador y valida errores', () => {
  // 2026-10-27T23:30:00Z => 17:30 en El Salvador (UTC-6), 27 oct.
  const s = fmtDate('2026-10-27T23:30:00Z')
  assert.ok(s.includes('27') && /(17:30|5:30)/.test(s), s)

  assert.equal(fmtDate(null), '—')
  assert.equal(fmtDate(undefined), '—')
  assert.equal(fmtDate(''), '—')
  assert.equal(fmtDate('fecha-invalida'), '—')
})
