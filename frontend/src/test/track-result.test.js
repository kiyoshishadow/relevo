import test from 'node:test'
import assert from 'node:assert/strict'
import { setTrackSceneReady, trackResultHtml } from '../views/track.js'
import { getExteriorYawFromPose, getMovementInspectionPose } from '../components/phone3d.js'

test('public tracking highlights the authoritative current status and recorded history', () => {
  const html = trackResultHtml({
    case_number: 'RV-2026-000028',
    status: 'repairing',
    terminal: { brand: 'Nokia', model: 'G22' },
    history: [
      { status: 'received', at: '2026-10-20T10:00:00Z' },
      { status: 'diagnosing', at: '2026-10-20T11:00:00Z' },
      { status: 'repairing', at: '2026-10-21T09:00:00Z' },
    ],
  })

  assert.match(html, /Estado actual/)
  assert.match(html, /Nokia G22/)
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1)
  assert.match(html, /Historia del caso no|Recorrido del caso/)
})

test('public tracking includes a model-aware 3D scene and accessible assembly control', () => {
  const html = trackResultHtml({
    status: 'repairing',
    terminal: { brand: 'Google', model: 'Pixel 8' },
    history: [{ status: 'repairing', at: '2026-10-21T09:00:00Z' }],
  })

  assert.match(html, /aria-label="Vista interactiva del equipo"/)
  assert.match(html, /data-track-device-stage/)
  assert.match(html, /Google Pixel 8/)
  assert.match(html, /data-track-device-toggle aria-pressed="true"/)
  assert.match(html, /Los componentes internos son una representación esquemática/)
})

test('registered movements can be inspected without changing the authoritative current status', () => {
  const html = trackResultHtml({
    status: 'repairing',
    terminal: { brand: 'Apple', model: 'iPhone 13' },
    history: [
      { status: 'received', at: '2026-10-20T10:00:00Z' },
      { status: 'diagnosing', at: '2026-10-20T11:00:00Z' },
      { status: 'repairing', at: '2026-10-21T09:00:00Z' },
    ],
  })

  assert.equal((html.match(/data-track-history-step/g) || []).length, 3)
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 2) // history selection and assembly control
  assert.match(html, /data-track-step-status="repairing"[^>]*aria-pressed="true"/)
  assert.match(html, /data-track-focus-readout aria-live="polite"/)
})

test('public tracking escapes model text in its scene label', () => {
  const html = trackResultHtml({
    status: 'received',
    terminal: { brand: 'Marca', model: '<img src=x onerror=alert(1)>' },
    history: [{ status: 'received', at: '2026-10-21T09:00:00Z' }],
  })

  assert.doesNotMatch(html, /<img src=x/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('public tracking does not assign a date to a status absent from history', () => {
  const html = trackResultHtml({
    status: 'awaiting_payment',
    history: [{ status: 'repairing', at: '2026-10-21T09:00:00Z' }],
  })

  assert.equal((html.match(/aria-current="step"/g) || []).length, 1)
  assert.match(html, /El estado actual no coincide con el último movimiento registrado/)
  assert.match(html, /Estado actual/)
  assert.doesNotMatch(html, /<time[^>]*>[^<]*Esperando pago/)
})

test('each recorded movement gets its own stable inspection pose for the same phone', () => {
  const base = { yaw: .055, camera: { x: 2.8, y: 3.65, z: -11.8 } }
  const statuses = ['received', 'diagnosing', 'awaiting_approval', 'awaiting_payment', 'repairing', 'ready', 'delivered', 'cancelled']
  const poses = statuses.map(status => getMovementInspectionPose(status, base))

  const numbers = pose => [pose.phone.x, pose.phone.y, pose.phone.z,
    pose.camera.x, pose.camera.y, pose.camera.z,
    pose.target.x, pose.target.y, pose.target.z]
  poses.forEach(pose => numbers(pose).forEach(value => assert.ok(Number.isFinite(value))))
  // The rear camera keeps looking at the same phone from behind, never through it.
  poses.forEach(pose => assert.ok(pose.camera.z < 0))
  // Every movement is visually distinguishable; repeated selection is idempotent.
  assert.equal(new Set(poses.map(pose => JSON.stringify(pose))).size, statuses.length)
  assert.deepEqual(getMovementInspectionPose('repairing', base), getMovementInspectionPose('repairing', base))
  // The orbit stays a bounded inspection angle regardless of quick retargets.
  poses.forEach(pose => assert.ok(Math.abs(pose.phone.y - base.yaw) <= .5))
})

test('an unknown movement falls back to a finite neutral inspection pose', () => {
  const pose = getMovementInspectionPose('unknown_status', { yaw: .055, camera: { x: 2.8, y: 3.65, z: -11.8 } })
  assert.equal(pose.status, 'default')
  assert.ok([pose.phone.x, pose.phone.y, pose.phone.z, pose.camera.x, pose.camera.y, pose.camera.z, pose.target.y].every(Number.isFinite))
  assert.ok(pose.camera.z < 0)
})

test('tracking readiness markers gate SVG pose transforms and are cleared on fallback', () => {
  const attributes = new Map()
  const host = {
    dataset: {},
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
    hasAttribute: name => attributes.has(name),
  }

  setTrackSceneReady(host, true)
  assert.equal(host.dataset.deviceLabReady, 'true')
  assert.equal(attributes.get('data-3d-ready'), 'true')

  setTrackSceneReady(host, false)
  assert.equal(host.dataset.deviceLabReady, undefined)
  assert.equal(host.hasAttribute('data-3d-ready'), false)
})

test('the same recorded movement resolves coherently across repeated assembly toggles', () => {
  const base = { yaw: .055, camera: { x: 2.8, y: 3.65, z: -11.8 } }
  const assembled = getMovementInspectionPose('repairing', { ...base, assembled: true })
  const exploded = getMovementInspectionPose('repairing', { ...base, assembled: false })
  const reassembled = getMovementInspectionPose('repairing', { ...base, assembled: true })

  assert.notDeepEqual(assembled, exploded)
  assert.deepEqual(reassembled, assembled)

  let exteriorYaw = base.yaw
  for (let i = 0; i < 6; i++) {
    for (const isAssembled of [false, true]) {
      const sideOffset = isAssembled ? 0 : Math.PI
      const pose = getMovementInspectionPose('repairing', {
        ...base, yaw: exteriorYaw + sideOffset, assembled: isAssembled,
      })
      exteriorYaw = getExteriorYawFromPose(pose.phone.y, {
        profiled: true, assembled: isAssembled, movementStatus: 'repairing',
      })
      assert.ok(Math.abs(exteriorYaw - base.yaw) < 1e-12)
    }
  }
})
