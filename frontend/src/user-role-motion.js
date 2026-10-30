/**
 * User role motion – amber credential frame that assembles around a role change
 * after PATCH + GET confirm the new role.
 *
 * API:
 *   createUserRoleMotion({ root, gsapApi, mediaQuery })
 *   .confirm({ id, previousRole, confirmedRole })
 *   .dispose()
 *
 * – Finds the row by comparing dataset.userId (no selector built from ID string).
 * – The row's data-role must match confirmedRole.
 * – Animates the [data-user-role-frame] element inside the row.
 * – confirmedRole truth comes from the confirmed GET list (controller.state.data),
 *   not just from PATCH.
 * – Integrates after updateUsersPage via createUsersPageHandler / options.onSuccess.
 * – Decorative only: text readable from frame 1, aria-hidden for adornments,
 *   no focus/live-region moving or delaying.
 * – Respects prefers-reduced-motion: zero tween, immediate final state.
 * – dispose() kills tween and removes listeners.
 */

export function createUserRoleMotion({ root, gsapApi, mediaQuery } = {}) {
  // --- State ---
  let reduced = false
  let tween = null
  let disposed = false
  const activeTweens = new Map()
  let currentFrame = null

  // --- Reduced-motion setup ---
  const motionQuery =
    mediaQuery ||
    (typeof window !== 'undefined'
      ? window.matchMedia?.('(prefers-reduced-motion: reduce)')
      : null)

  const onMotionChange = event => {
    reduced = Boolean(event?.matches)
    if (reduced) {
      const frame = currentFrame
      cleanup()
      // Stop the in-flight visual effect and let the reduced-motion CSS keep
      // the decorative frame hidden without stale inline transforms.
      if (frame) gsapApi?.set?.(frame, { clearProps: 'opacity,scale,transform' })
    }
  }

  if (motionQuery?.addEventListener) {
    motionQuery.addEventListener('change', onMotionChange)
  } else if (motionQuery?.addListener) {
    motionQuery.addListener?.(onMotionChange)
  }

  const isReduced = () => reduced || Boolean(motionQuery?.matches)

  // --- Cleanup tween and listeners ---
  function cleanup() {
    if (currentFrame) {
      currentFrame.classList.remove('is-active')
      activeTweens.delete(currentFrame)
    }
    if (tween) {
      tween.kill()
      tween = null
    }
    disposed = true
    if (motionQuery?.removeEventListener) {
      motionQuery.removeEventListener('change', onMotionChange)
    } else if (motionQuery?.removeListener) {
      motionQuery.removeListener(onMotionChange)
    }
    currentFrame = null
  }

  // --- Animation: expand frame around role ---
  function expandFrame(frame) {
    if (disposed) return
    if (!frame.isConnected) return

    // Reduced motion: immediately set to final state
    if (isReduced()) {
      gsapApi.set(frame, {
        opacity: 1,
        scale: 1,
        transformOrigin: 'center',
      })
      return
    }

    // Distinctive animation: frame expands from reduced size to normal
    tween = gsapApi.timeline({
      defaults: {
        ease: 'power2.out',
      },
      onComplete: () => {
        // Ensure final state is visible
        gsapApi.set(frame, {
          opacity: 1,
          scale: 1,
          transformOrigin: 'center',
        })
        // Schedule cleanup after animation
        setTimeout(() => {
          if (!disposed) {
            frame.classList.remove('is-active')
            if (activeTweens.get(frame) === tween) activeTweens.delete(frame)
          }
        }, 0)
      },
    })

    // Animation sequence: scale up from small to normal, with brief amber accent
    tween.to(frame, { opacity: 1, scale: 1.045, duration: 0.14, ease: 'power2.out' }, '+=0.04')
    tween.to(frame, { scale: 1, opacity: 1, duration: 0.24, ease: 'power1.inOut' }, '+=0.08')
  }

  // --- Public API ---
  return {
    /** Confirm a role change for a user ID.
     *  id: the user's dataset.userId value (matched against row.dataset.userId)
     *  previousRole: the role before the PATCH
     *  confirmedRole: the role confirmed by the GET callback (from controller.state.data)
     */
    confirm({ id, previousRole, confirmedRole }) {
      if (disposed) return false
      if (!root?.isConnected) return false
      if (!previousRole || !confirmedRole) return false
      if (previousRole === confirmedRole) return false // no change

      // Find the row by comparing dataset.userId
      // (no selector built from ID - just compare dataset values)
      const rows = [...(root.querySelectorAll?.('[data-user-row]') || [])]
      const candidate = rows.find(candidate =>
        String(candidate.dataset.userId) === String(id)
      )

      // Row must exist, be connected, visible, and have matching data-role
      if (
        !candidate ||
        !candidate.isConnected ||
        candidate.hidden ||
        candidate.closest?.('[hidden]') ||
        candidate.dataset.role !== confirmedRole
      ) {
        return false
      }

      // Get the frame element inside the row
      const frame = candidate.querySelector?.('[data-user-role-frame]')
      if (!frame || !frame.isConnected) return false

      // Store reference for cleanup/redirection
      currentFrame = frame

      // Skip the decorative animation entirely when reduced motion is enabled.
      if (isReduced()) {
        // The frame is decorative and CSS hides it for reduced motion.
        // Leave it at its stylesheet state without creating inline styles.
        return false
      }

      // Clean any existing tween for this frame
      const oldTween = activeTweens.get(frame)
      if (oldTween) {
        tween?.kill?.()
        tween = null
        // Reset frame style
        gsapApi.set(frame, { clearProps: 'opacity,transform,scale' })
        frame.classList.remove('is-active')
        activeTweens.delete(frame)
      }

      // Play the expansion animation
      frame.classList.add('is-active')
      expandFrame(frame)

      return true
    },

    /** Dispose of all animations, listeners, and DOM additions. */
    dispose() {
      if (disposed) return
      cleanup()
      disposed = true
    },
  }
}

/** Integration helper: attach user-role-motion to a users view root element.
 * Call this after render, passing the root and the GSAP instance.
 *
 * Example within admin.js:
 *   import { createUserRoleMotion, confirmUserRoleFromSnapshot } from './user-role-motion.js'
 *
 *   const motion = createUserRoleMotion({
 *     root: main,
 *     gsapApi: gsap,
 *     mediaQuery: window.matchMedia('(prefers-reduced-motion: reduce)'),
 *   })
 *
 *   // Inside the form submit handler, after successful save + GET:
 *   const savedRow = controller.state.data.find(
 *     candidate => String(candidate.id) === String(saved.id)
 *   )
 *   if (savedRow && savedRow.role !== editedUser.role) {
 *     motion.confirm({
 *       id: String(editedUser.id),
 *       previousRole: editedUser.role,
 *       confirmedRole: savedRow.role,
 *     })
 *   }
 */

export function integrateUserRoleMotion(root, { gsapApi = gsap, mediaQuery } = {}) {
  const motion = createUserRoleMotion({ root, gsapApi, mediaQuery })
  return motion
}

/** Helper: confirm role change using the POST-save GET snapshot as authority.
 *  Used within the onSuccess callback of updateUsersPage.
 *  Finds the saved user in controller.state.data and triggers the motion if the role changed.
 */
export function confirmUserRoleFromSnapshot({ motion, users, id, previousRole }) {
  if (!Array.isArray(users) || id == null || !previousRole) return false
  const savedUser = users.find(user => String(user.id) === String(id))
  if (!savedUser || !savedUser.role || savedUser.role === previousRole) return false
  return Boolean(motion?.confirm?.({ id, previousRole, confirmedRole: savedUser.role }))
}
