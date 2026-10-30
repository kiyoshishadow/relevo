import test from 'node:test'
import assert from 'node:assert/strict'
import { mountPhoneSceneSafely, portalSceneGuidance, savePortalCredentials, PORTAL_COPY_TARGETS } from '../views/portal.js'

test('no importa Three cuando la vista no permite montar la escena', async () => {
  let imports = 0
  let mounts = 0
  const result = await mountPhoneSceneSafely({
    loadModule: async () => { imports++; return { mountPhone3d: () => {} } },
    mount: async () => { mounts++ },
    isAllowed: () => false,
    onFallback() {},
    onReady() {},
  })

  assert.equal(result, null)
  assert.equal(imports, 0)
  assert.equal(mounts, 0)
})

test('un fallback notificado durante el montaje impide ocultar el SVG y dispone la escena', async () => {
  let disposed = 0
  let fallback = 0
  let ready = 0
  const result = await mountPhoneSceneSafely({
    loadModule: async () => ({ mountPhone3d: () => {} }),
    mount: async (_mountPhone3d, onFallback) => {
      onFallback()
      return () => { disposed++ }
    },
    isAllowed: () => true,
    onFallback: () => { fallback++ },
    onReady: () => { ready++ },
  })

  assert.equal(result, null)
  assert.equal(fallback, 1)
  assert.equal(disposed, 1)
  assert.equal(ready, 0)
})

test('si la vista deja de estar activa mientras Three se importa, no crea el renderer', async () => {
  let allowed = true
  let mounts = 0
  let ready = 0
  const result = await mountPhoneSceneSafely({
    loadModule: async () => {
      allowed = false
      return { mountPhone3d: () => {} }
    },
    mount: async () => { mounts++ },
    isAllowed: () => allowed,
    onFallback() {},
    onReady: () => { ready++ },
  })

  assert.equal(result, null)
  assert.equal(mounts, 0)
  assert.equal(ready, 0)
})

test('la guía del portal distingue renderer 3D listo, carga, fallback y movimiento reducido', () => {
  assert.match(portalSceneGuidance('loading'), /Preparando.*3D/i)
  assert.match(portalSceneGuidance('ready'), /3D lista.*Arrastra/i)
  assert.match(portalSceneGuidance('fallback'), /no está disponible.*esquema interactivo/i)
  assert.doesNotMatch(portalSceneGuidance('reduced'), /3D lista/i)
  assert.match(portalSceneGuidance('reduced'), /representación ilustrativa/i)
})

test('la entrada del portal incluye feedback y ayuda como objetivos separados de la descripción', () => {
  const targets = PORTAL_COPY_TARGETS.split(',').map(selector => selector.trim())
  assert.ok(targets.includes('.hero-copy .lede'))
  assert.ok(targets.includes('.hero-copy .portal-form-feedback'))
  assert.ok(targets.includes('.hero-copy .hero-form-help'))
  assert.equal(targets.some(selector => selector === '.hero-copy p'), false)
})

test('las credenciales se recortan, reemplazan las anteriores y permanecen en almacenamiento efímero', () => {
  const entries = new Map([['relevo:track-cred', 'stale']])
  const storage = {
    removeItem(key) { entries.delete(key) },
    setItem(key, value) { entries.set(key, value) },
  }
  assert.equal(savePortalCredentials(storage, ' CAS-42 ', ' key-42 '), true)
  assert.deepEqual(JSON.parse(entries.get('relevo:track-cred')), { n: 'CAS-42', t: 'key-42' })
})

test('la consulta vacía se rechaza y un error de sessionStorage se convierte en resultado controlable', () => {
  let writes = 0
  assert.equal(savePortalCredentials({ removeItem() {}, setItem() { writes++ } }, '   ', 'token'), false)
  assert.equal(savePortalCredentials({ removeItem() {}, setItem() { throw new Error('storage disabled') } }, 'CAS-42', 'token'), false)
  assert.equal(writes, 0)
})
