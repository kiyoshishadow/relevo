export const CLIENT_SAVE_FIELDS = Object.freeze(['full_name', 'document_id', 'phone', 'email', 'active'])

function normalized(field, value) {
  if (field === 'active') return value !== false
  return String(value ?? '').trim()
}

// Confirmation derives only from a fresh server snapshot and a stable identifier.
export function clientSaveChanges(snapshot, rows, id = snapshot?.id) {
  if (!snapshot || id == null || String(snapshot.id) !== String(id)) return null
  const saved = (rows || []).find(row => row?.id != null && String(row.id) === String(id))
  if (!saved) return null
  const fields = CLIENT_SAVE_FIELDS.filter(field => normalized(field, saved[field]) !== normalized(field, snapshot[field]))
  return fields.length ? { id: String(id), fields } : null
}

export function animateClientSaveConfirmation(row, fields, {
  gsapApi,
  matchMedia = query => window.matchMedia?.(query),
  onFinish = () => {},
} = {}) {
  if (!row?.isConnected || !fields?.length || !gsapApi) return null
  const media = matchMedia('(prefers-reduced-motion: reduce)')
  const marker = row.querySelector('[data-client-save-marker]')
  const underlines = fields.map(field => row.querySelector(`[data-client-field="${field}"] [data-client-save-underline]`)).filter(Boolean)
  if (!marker || !underlines.length) return null
  underlines.forEach(underline => underline.setAttribute('data-client-save-changed', 'true'))
  if (!media || media.matches) {
    row.setAttribute('data-client-save-static', 'true')
    return null
  }
  const targets = [marker, ...underlines]
  const state = { tween: null, media, onChange: null, row, gsapApi, targets }
  const finish = ({ keepStatic = false } = {}) => {
    state.tween?.kill()
    state.tween = null
    if (media.removeEventListener) media.removeEventListener('change', state.onChange)
    else media.removeListener?.(state.onChange)
    gsapApi.set(targets, { clearProps: 'opacity,transform' })
    row.removeAttribute('data-client-save-motion')
    row.removeAttribute('data-client-save-static')
    if (keepStatic && row.isConnected) row.setAttribute('data-client-save-static', 'true')
    else underlines.forEach(underline => underline.removeAttribute('data-client-save-changed'))
    onFinish(state, { keepStatic })
  }
  state.finish = finish
  state.onChange = event => { if (event.matches) finish({ keepStatic: true }) }
  if (media.addEventListener) media.addEventListener('change', state.onChange)
  else media.addListener?.(state.onChange)
  row.setAttribute('data-client-save-motion', 'true')
  gsapApi.set(marker, { transformOrigin: 'left center' })
  gsapApi.set(underlines, { transformOrigin: 'left center' })
  const timeline = gsapApi.timeline({ defaults: { ease: 'power3.out' }, onComplete: finish })
  timeline.fromTo(marker, { scaleX: 0, opacity: .55 }, { scaleX: 1, opacity: 1, duration: .32 }, 0)
  timeline.fromTo(underlines, { scaleX: 0 }, { scaleX: 1, duration: .3, stagger: .055 }, .12)
  state.tween = timeline
  return state
}
