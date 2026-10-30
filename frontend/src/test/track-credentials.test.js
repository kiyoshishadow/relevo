import test from 'node:test'
import assert from 'node:assert/strict'
import {
  trackCredentialError,
  trackCredForm,
  getSessionStorage,
  persistTrackCredential,
  announceStorageFailure,
  submitStoredTrackCredential,
  TRACK_STORAGE_MESSAGE,
} from '../views/track.js'

test('track credentials require trimmed case number and token with field-specific guidance', () => {
  assert.match(trackCredentialError('case_number', '  '), /número.*ficha/i)
  assert.match(trackCredentialError('token', ''), /clave.*seguimiento/i)
  assert.equal(trackCredentialError('case_number', ' CAS-42 '), '')
  assert.equal(trackCredentialError('token', ' llave '), '')
})

test('direct tracking form exposes linked accessible errors and does not rely on browser bubbles', () => {
  const html = trackCredForm()
  assert.match(html, /novalidate/)
  assert.match(html, /id="track-case-number"[^>]*aria-describedby="track-case-number-error"[^>]*aria-invalid="false"/)
  assert.match(html, /id="track-case-number-error" aria-live="polite"/)
  assert.match(html, /id="track-token"[^>]*aria-describedby="track-token-error"[^>]*aria-invalid="false"/)
  assert.match(html, /id="track-token-error" aria-live="polite"/)
  assert.match(html, /id="track-credential-help"/)
})

test('the fallback form keeps a hidden, focusable inline notice for storage failures', () => {
  const html = trackCredForm()
  assert.match(html, /id="track-credential-storage-error"[^>]*role="alert"[^>]*tabindex="-1"[^>]*hidden/)
  assert.match(html, /data-track-storage-notice/)
  assert.match(html, /aria-describedby="track-credential-help"/)
  assert.doesNotMatch(html, /aria-describedby="[^"]*track-credential-storage-error/)
  // El aviso vive dentro del formulario: al fallar se conserva lo ya escrito.
  assert.ok(html.indexOf('data-track-storage-notice') < html.indexOf('</form>'))
  assert.ok(html.indexOf('name="case_number"') < html.indexOf('data-track-storage-notice'))
  assert.ok(html.indexOf('name="token"') < html.indexOf('data-track-storage-notice'))
})

test('a session store that throws is reported as unsaved instead of crashing', () => {
  const blocked = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
    removeItem() { throw new Error('blocked') },
  }
  assert.equal(persistTrackCredential(blocked, { n: 'CAS-2026-0007', t: 'llave-secreta' }), false)
  assert.equal(persistTrackCredential(null, { n: 'CAS-2026-0007', t: 'llave-secreta' }), false)
})

test('reading window.sessionStorage can throw without breaking the view', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    get() { throw new Error('SecurityError: storage blocked') },
  })
  try {
    assert.equal(getSessionStorage(), null)
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else delete globalThis.window
  }
})

test('a failed save keeps the form, shows and focuses the notice, and never navigates', () => {
  const notice = { hidden: true, textContent: '', focused: false, focus() { this.focused = true } }
  let navigations = 0
  const storage = { setItem() { throw new Error('QuotaExceededError') } }

  const saved = submitStoredTrackCredential({
    storage,
    notice,
    values: { n: ' CAS-2026-0007 ', t: ' llave-secreta ' },
    go: () => { navigations += 1 },
  })

  assert.equal(saved, false)
  assert.equal(navigations, 0)
  assert.equal(notice.hidden, false)
  assert.equal(notice.textContent, TRACK_STORAGE_MESSAGE)
  assert.equal(notice.focused, true)
  // El aviso visible no repite la credencial capturada.
  assert.doesNotMatch(notice.textContent, /CAS-2026-0007|llave-secreta/)
})

test('a working store persists the trimmed credential and then navigates', () => {
  const writes = []
  const storage = { setItem(key, value) { writes.push([key, value]) } }
  const notice = { hidden: false, textContent: 'aviso previo', focused: false, focus() { this.focused = true } }
  let navigations = 0

  const saved = submitStoredTrackCredential({
    storage,
    notice,
    values: { n: ' CAS-2026-0007 ', t: ' llave-secreta ' },
    go: () => { navigations += 1 },
  })

  assert.equal(saved, true)
  assert.equal(navigations, 1)
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], 'relevo:track-cred')
  assert.deepEqual(JSON.parse(writes[0][1]), { n: 'CAS-2026-0007', t: 'llave-secreta' })
})

test('announceStorageFailure tolerates a missing notice and still refuses silently', () => {
  assert.equal(announceStorageFailure(null), false)
  const notice = { hidden: true, textContent: '', focus() { throw new Error('not focusable') } }
  assert.equal(announceStorageFailure(notice), true)
  assert.equal(notice.hidden, false)
  assert.equal(notice.textContent, TRACK_STORAGE_MESSAGE)
})
