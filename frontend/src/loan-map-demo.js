// Explicit demonstration positions, never inferred from a customer's address.
// New inventory has no location until a real location source is implemented.
const positions = Object.freeze({
  'LP-001': [-89.2188, 13.7040],
  'LP-002': [-89.2258, 13.7012],
  'LP-003': [-89.2248, 13.6988],
})
export function demoDeviceCoordinates(device) {
  const point = Object.hasOwn(positions, device?.asset_tag) ? positions[device.asset_tag] : null
  return point ? [...point] : null
}
