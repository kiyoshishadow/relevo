import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveDeviceProfile } from '../components/device-profiles.js'

test('resuelve perfiles solo por marca y modelo exactos', () => {
  assert.equal(resolveDeviceProfile('Apple', 'iPhone 13').camera, 'iphone-diagonal-dual')
  assert.equal(resolveDeviceProfile('google', ' PIXEL 8 ').camera, 'pixel-bar-dual')
  assert.equal(resolveDeviceProfile('Motorola', 'Moto G54').camera, 'moto-round-dual')
})

test('un modelo parecido o desconocido conserva su nombre y queda como ilustrativo', () => {
  const profile = resolveDeviceProfile('Apple', 'iPhone 13 Pro')
  assert.equal(profile.exact, false)
  assert.equal(profile.model, 'iPhone 13 Pro')
  assert.equal(profile.family, 'Vista ilustrativa')
  assert.equal(profile.dimensionsMm, undefined)
})

test('los modelos exactos conservan dimensiones físicas para distinguir sus siluetas', () => {
  const iphone = resolveDeviceProfile('Apple', 'iPhone 13')
  const pixel = resolveDeviceProfile('Google', 'Pixel 8')

  assert.equal(iphone.exact, true)
  assert.deepEqual(iphone.dimensionsMm, { height: 146.7, width: 71.5, depth: 7.65 })
  assert.equal(pixel.exact, true)
  assert.deepEqual(pixel.dimensionsMm, { height: 150.5, width: 70.8, depth: 8.9 })
  assert.notDeepEqual(pixel.dimensionsMm, iphone.dimensionsMm)
})
