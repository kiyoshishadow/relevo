import test from 'node:test'
import assert from 'node:assert/strict'
import { phoneSvgHtml } from '../components/phone.js'
import { knownDeviceProfiles, resolveDeviceProfile } from '../components/device-profiles.js'
import { trackResultHtml } from '../views/track.js'

const fallback = (brand, model) => phoneSvgHtml({ id: 'test-phone', profile: resolveDeviceProfile(brand, model) })
const count = (html, attribute) => [...html.matchAll(new RegExp(`\\b${attribute}(?: |>)`, 'g'))].length

test('el fallback identifica iPhone dual diagonal, Pixel con barra y Samsung sin placa', () => {
  const iphone = fallback('Apple', 'iPhone 13')
  const pixel = fallback('Google', 'Pixel 8')
  const samsung = fallback('Samsung', 'Galaxy S24')
  assert.match(iphone, /data-camera-housing-kind="glass-square"/)
  assert.equal(count(iphone, 'data-camera-lens'), 2)
  // Coordinates are mapped from the same cameraGeometry as the 3D scene:
  // iPhone lenses differ on both axes, Pixel lenses share the same height.
  const positions = html => [...html.matchAll(/data-camera-lens transform="translate\(([^)]+)\)"/g)].map(match => match[1].split(' ').map(Number))
  const [i1, i2] = positions(iphone)
  assert.notEqual(i1[0], i2[0])
  assert.notEqual(i1[1], i2[1])
  assert.match(pixel, /data-camera-housing-kind="metal-bridge"/)
  assert.equal(count(pixel, 'data-camera-bridge-base'), 1)
  assert.equal(count(pixel, 'data-camera-housing'), 1)
  assert.equal(count(pixel, 'data-camera-window'), 1)
  assert.equal(count(pixel, 'data-camera-lens'), 2)
  assert.equal(positions(pixel)[0][1], positions(pixel)[1][1])
  assert.equal(count(pixel, 'data-camera-flash'), 1)
  assert.match(samsung, /data-camera-housing-kind="separate-rings"/)
  assert.equal(count(samsung, 'data-camera-housing'), 0)
  assert.equal(count(samsung, 'data-camera-lens'), 3)
  assert.equal(new Set(positions(samsung).map(pos => pos[0])).size, 1)
})

test('cada perfil conocido conserva su exterior, dimensiones y cuatro capas operables', () => {
  const exteriors = new Set()
  for (const { brand, model } of knownDeviceProfiles()) {
    const html = fallback(brand, model)
    assert.ok(html.includes(`data-exterior-profile="${model}"`))
    assert.equal(count(html, 'data-camera-module'), 1)
    for (let i = 0; i < 4; i++) assert.ok(html.includes(`data-layer="${i}"`))
    assert.match(html, /capas internas esquemáticas/)
    assert.doesNotMatch(html, /NaN|undefined/)
    exteriors.add(html)
  }
  assert.equal(exteriors.size, knownDeviceProfiles().length)
  assert.match(fallback('Xiaomi', 'Redmi Note 12'), /scale\(1\.06 1\.13\)/)
})

test('un dispositivo no conocido conserva el esquema genérico y la etiqueta ilustrativa', () => {
  const html = fallback('Apple', 'iPhone 13 Pro')
  assert.match(html, /data-exterior-profile="illustrative"/)
  assert.match(html, /data-camera-style="generic-triple"/)
  assert.match(html, /data-camera-housing-kind="illustrative"/)
  assert.match(html, /aria-label="Teléfono ilustrativo:/)
  assert.equal(count(html, 'data-camera-lens'), 3)
  assert.doesNotMatch(html, /iPhone 13:/)
})

test('Pixel 8: puente metálico elevado con píldora hundida, lentes dentro y flash sobre el metal', () => {
  const html = fallback('Google', 'Pixel 8')
  const rectWith = marker => {
    const match = new RegExp(`<rect\\b[^>]*\\b${marker}\\b[^>]*>`).exec(html)
    assert.ok(match, `se esperaba un rect con ${marker}`)
    const attr = name => {
      const found = new RegExp(`\\b${name}="([0-9.\\-]+)"`).exec(match[0])
      assert.ok(found, `${name} numérico en ${marker}`)
      return Number(found[1])
    }
    return { x: attr('x'), y: attr('y'), width: attr('width'), height: attr('height'), rx: attr('rx') }
  }
  const bar = rectWith('data-camera-housing')
  const pill = rectWith('data-camera-window')
  // The bridge silhouette keeps fully rounded ends like the 3D extruded cover.
  assert.ok(Math.abs(bar.rx - bar.height / 2) < .5)
  // The dark pill sits fully inside the bar with equal metal margins around it.
  assert.ok(pill.x > bar.x && pill.x + pill.width < bar.x + bar.width)
  assert.ok(pill.y > bar.y && pill.y + pill.height < bar.y + bar.height)
  const topMargin = pill.y - bar.y
  const bottomMargin = bar.y + bar.height - (pill.y + pill.height)
  assert.ok(Math.abs(topMargin - bottomMargin) < .5)
  assert.ok(Math.abs(topMargin - 5.95) < .5)
  // Both lenses live inside the pill window at one shared height.
  const positions = html => [...html.matchAll(/data-camera-lens transform="translate\(([^)]+)\)"/g)].map(match => match[1].split(' ').map(Number))
  const lensPos = positions(html)
  assert.equal(lensPos.length, 2)
  for (const [lx, ly] of lensPos) {
    assert.ok(lx > pill.x && lx < pill.x + pill.width)
    assert.ok(ly > pill.y && ly < pill.y + pill.height)
  }
  // The flash stays on the bridge metal, outside the window span.
  const flashCx = Number(/data-camera-flash cx="([0-9.\\-]+)"/.exec(html)[1])
  assert.ok(flashCx > bar.x && flashCx < bar.x + bar.width)
  assert.ok(flashCx > pill.x + pill.width)
})

test('los demás perfiles no heredan la píldora hundida ni el puente del Pixel', () => {
  for (const { brand, model } of knownDeviceProfiles()) {
    if (model === 'Pixel 8') continue
    const html = fallback(brand, model)
    assert.equal(count(html, 'data-camera-window'), 0)
    assert.equal(count(html, 'data-camera-bridge-base'), 0)
    assert.doesNotMatch(html, /data-camera-housing-kind="metal-bridge"/)
    assert.doesNotMatch(html, /opacity="\.38"/)
    assert.doesNotMatch(html, /opacity="\.32"/)
  }
  const generic = fallback('Apple', 'iPhone 13 Pro')
  assert.equal(count(generic, 'data-camera-window'), 0)
  assert.match(generic, /data-camera-housing-kind="illustrative"/)
  assert.doesNotMatch(generic, /opacity="\.38"/)
})

test('seguimiento público muestra su propio perfil desde el SVG inicial sin ocultarlo a accesibilidad', () => {
  const pixel = trackResultHtml({ terminal: { brand: 'Google', model: 'Pixel 8' }, status: 'received' })
  assert.match(pixel, /data-camera-style="pixel-bar-dual"/)
  assert.match(pixel, /Perfil exterior identificado/)
  assert.doesNotMatch(pixel, /class="phone-fallback" aria-hidden="true"/)
  const unknown = trackResultHtml({ terminal: { brand: 'Acme', model: '<Otro>' }, status: 'received' })
  assert.match(unknown, /data-exterior-profile="illustrative"/)
  assert.match(unknown, /silueta ilustrativa/)
  assert.match(unknown, /Acme &lt;Otro&gt;/)
})

test('IDs SVG interpolados se escapan y la escena genérica del portal mantiene su contrato', () => {
  const html = phoneSvgHtml({ id: 'phone" onload="bad', profile: resolveDeviceProfile('Google', 'Pixel 8') })
  assert.doesNotMatch(html, /id="phone" onload=/)
  const portal = phoneSvgHtml()
  assert.match(portal, /id="phone-hero"/)
  assert.equal(count(portal, 'data-camera-module'), 0)
  for (let i = 0; i < 4; i++) assert.ok(portal.includes(`data-layer="${i}"`))
})
