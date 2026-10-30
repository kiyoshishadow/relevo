// Procedural lat-long studio reflection for small PBR product scenes.
// Keep it local: the renderer needs no remote HDR download or extra request.
import { CanvasTexture, EquirectangularReflectionMapping, SRGBColorSpace } from 'three/webgpu'

// Named imports preserve tree shaking. Passing the entire THREE namespace into
// this helper would retain unrelated exports in both deferred scene bundles.
export function createStudioEnvironment() {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) return null

  const sky = context.createLinearGradient(0, 0, 0, canvas.height)
  sky.addColorStop(0, '#d7ded8')
  sky.addColorStop(.28, '#b4c3c3')
  sky.addColorStop(.48, '#50676a')
  sky.addColorStop(.53, '#273c40')
  sky.addColorStop(.72, '#203236')
  sky.addColorStop(1, '#101d20')
  context.fillStyle = sky
  context.fillRect(0, 0, canvas.width, canvas.height)

  const softboxes = [
    { x: 44, y: 28, w: 45, h: 146, color: 'rgba(255,252,239,.84)', glow: 'rgba(255,243,209,.45)' },
    { x: 167, y: 48, w: 21, h: 108, color: 'rgba(214,231,235,.7)', glow: 'rgba(214,231,235,.3)' },
    { x: 314, y: 22, w: 60, h: 126, color: 'rgba(250,249,240,.9)', glow: 'rgba(240,245,232,.42)' },
    { x: 438, y: 64, w: 27, h: 94, color: 'rgba(236,199,119,.77)', glow: 'rgba(236,199,119,.38)' },
  ]
  for (const box of softboxes) {
    const glow = context.createRadialGradient(box.x + box.w / 2, box.y + box.h / 2, 2, box.x + box.w / 2, box.y + box.h / 2, box.h * .64)
    glow.addColorStop(0, box.glow)
    glow.addColorStop(1, 'rgba(255,255,255,0)')
    context.fillStyle = glow
    context.fillRect(box.x - box.h * .55, box.y - 12, box.w + box.h * 1.1, box.h + 24)
    context.fillStyle = box.color
    context.beginPath()
    if (typeof context.roundRect === 'function') context.roundRect(box.x, box.y, box.w, box.h, 8)
    else context.rect(box.x, box.y, box.w, box.h)
    context.fill()
  }

  const horizon = context.createLinearGradient(0, 158, 0, 211)
  horizon.addColorStop(0, 'rgba(231,185,74,0)')
  horizon.addColorStop(.48, 'rgba(231,185,74,.1)')
  horizon.addColorStop(1, 'rgba(231,185,74,0)')
  context.fillStyle = horizon
  context.fillRect(0, 158, canvas.width, 53)

  const texture = new CanvasTexture(canvas)
  texture.mapping = EquirectangularReflectionMapping
  texture.colorSpace = SRGBColorSpace
  texture.needsUpdate = true
  return texture
}
