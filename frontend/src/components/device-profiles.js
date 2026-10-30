// Perfiles visuales deliberadamente explícitos: un nombre desconocido conserva
// su identidad y recibe una silueta ilustrativa, nunca un modelo parecido.
const profiles = [
  { brand: 'Apple', model: 'iPhone 13', family: 'iPhone 13', camera: 'iphone-diagonal-dual', front: 'notch', frameRadius: .19, dimensionsMm: { height: 146.7, width: 71.5, depth: 7.65 }, accent: 0xd9e0e4, body: 0x858e93, back: 0xc9d0d5 },
  { brand: 'Samsung', model: 'Galaxy S24', family: 'Galaxy S24', camera: 'vertical-triple', front: 'punch', frameRadius: .17, dimensionsMm: { height: 147, width: 70.6, depth: 7.6 }, accent: 0xbec6d0, body: 0x818b96, back: 0xabb4bf },
  { brand: 'Samsung', model: 'Galaxy S23', family: 'Galaxy S23', camera: 'separate-triple', front: 'punch', frameRadius: .2, dimensionsMm: { height: 146.3, width: 70.9, depth: 7.6 }, accent: 0xddd8ca, body: 0x777d78, back: 0xaba99e },
  { brand: 'Samsung', model: 'Galaxy A54', family: 'Galaxy A54', camera: 'separate-triple', front: 'punch', frameRadius: .22, dimensionsMm: { height: 158.2, width: 76.7, depth: 8.2 }, accent: 0xd6d2c4, body: 0x7c857c, back: 0xb5b6ab },
  { brand: 'Samsung', model: 'Galaxy A15', family: 'Galaxy A15', camera: 'separate-triple', front: 'notch', frameRadius: .2, dimensionsMm: { height: 160.1, width: 76.8, depth: 8.4 }, accent: 0x9fa9c5, body: 0x737987, back: 0x9ea4be },
  { brand: 'Google', model: 'Pixel 8', family: 'Pixel 8', camera: 'pixel-bar-dual', front: 'punch', frameRadius: .31, dimensionsMm: { height: 150.5, width: 70.8, depth: 8.9 }, accent: 0xd0d5cb, body: 0x828980, back: 0xb1b7ad },
  { brand: 'Xiaomi', model: 'Redmi Note 12', family: 'Redmi Note 12', camera: 'square-triple', front: 'punch', frameRadius: .24, dimensionsMm: { height: 165.66, width: 75.96, depth: 7.85 }, accent: 0xa4b4bd, body: 0x788992, back: 0xa3b0b8 },
  { brand: 'Motorola', model: 'Moto G54', family: 'Moto G54', camera: 'moto-round-dual', front: 'punch', frameRadius: .24, dimensionsMm: { height: 161.56, width: 73.82, depth: 7.99 }, accent: 0xc7bba9, body: 0x817564, back: 0xb4a895 },
]

// Coordinates describe a simplified exterior, in the shared modelling units.
// Positive X is the left side when viewed from the rear (-Z). These layouts
// are visual identifiers; the exploded internals are a common repair schematic.
const cameraGeometry = {
  'iPhone 13': { housing: 'glass-square', center: [.49, 1.43], island: [.96, .96, .055], radius: .21, lenses: [[.69, 1.67, .17], [.29, 1.27, .17]], flash: [.24, 1.7, .075] },
  'Galaxy S24': { housing: 'separate-rings', lenses: [[.68, 1.74, .16], [.68, 1.26, .16], [.68, .78, .16]], flash: [.28, 1.7, .06] },
  'Galaxy S23': { housing: 'separate-rings', lenses: [[.67, 1.73, .165], [.67, 1.23, .165], [.67, .73, .165]], flash: [.26, 1.66, .06] },
  'Galaxy A54': { housing: 'separate-rings', lenses: [[.66, 1.72, .172], [.66, 1.2, .172], [.66, .68, .15]], flash: [.25, 1.65, .063] },
  'Galaxy A15': { housing: 'separate-rings', lenses: [[.66, 1.72, .16], [.66, 1.23, .16], [.66, .74, .13]], flash: [.25, 1.65, .06] },
  'Pixel 8': { housing: 'metal-bridge', center: [0, 1.5], bridgeBase: [2.04, .53, .085], island: [1.99, .47, .13], radius: .16, window: { center: [.22, 1.5], size: [1.25, .34, .035], radius: .17 }, lenses: [[.52, 1.5, .136], [-.01, 1.5, .136]], flash: [-.72, 1.5, .078] },
  'Redmi Note 12': { housing: 'glass-square', center: [.44, 1.45], island: [1.12, 1.24, .065], radius: .12, lenses: [[.65, 1.72, .19], [.65, 1.17, .19], [.15, 1.7, .105]], flash: [.15, 1.24, .065] },
  'Moto G54': { housing: 'rounded-rectangle', center: [.5, 1.43], island: [.83, 1.23, .065], radius: .14, lenses: [[.57, 1.72, .18], [.57, 1.19, .18]], flash: [.21, 1.17, .06] },
}
profiles.forEach(profile => { profile.cameraGeometry = cameraGeometry[profile.model] })

const norm = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const key = (brand, model) => `${norm(brand)}:${norm(model)}`
const exactProfiles = new Map(profiles.map(profile => [key(profile.brand, profile.model), profile]))

export function resolveDeviceProfile(brand, model) {
  const profile = exactProfiles.get(key(brand, model))
  if (profile) return { ...profile, exact: true }
  return {
    brand: String(brand ?? '').trim(),
    model: String(model ?? '').trim(),
    family: 'Vista ilustrativa',
    camera: 'generic-triple',
    front: 'punch',
    accent: 0xb8b7ae,
    body: 0x747a79,
    back: 0x9ea19a,
    frameRadius: .23,
    exact: false,
  }
}

export function knownDeviceProfiles() {
  return profiles.map(profile => ({ ...profile }))
}
