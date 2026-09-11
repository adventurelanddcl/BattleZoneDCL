/**
 * Damage-taken indicator: a translucent red border that fades in and back out
 * around the screen edge over a second whenever the player loses health.
 */
import { isMobile } from '@dcl/sdk/platform'

/** How long the whole fade in/out takes, in milliseconds. */
const FLASH_DURATION_MS = 1000

/** Fade-in portion. Short, so a hit registers immediately; the remainder of
 * FLASH_DURATION_MS is the slower fade back out. Set to half the duration for a
 * symmetric pulse. */
const FADE_IN_MS = 200

/**
 * Peak opacity, reached at the end of the fade in.
 *
 * Mobile gets a much stronger value: the border covers far fewer pixels on a
 * phone and the screen is typically viewed in brighter light, so the subtle tint
 * that reads well on a monitor is effectively invisible there.
 */
const MAX_ALPHA_DESKTOP = 0.5
const MAX_ALPHA_MOBILE = 0.5

/** When the current flash ends (epoch ms); 0 or past means nothing to draw. */
let flashEndsAt = 0

/**
 * Starts (or restarts) the damage flash. Taking another hit mid-flash resets it
 * to a full second at full strength rather than stacking.
 */
export function showDamageIndicator(): void {
  flashEndsAt = Date.now() + FLASH_DURATION_MS
}

/** Clears the flash immediately (e.g. on death, so it doesn't bleed over). */
export function clearDamageIndicator(): void {
  flashEndsAt = 0
}

/**
 * Border opacity for this frame: 0 when idle, otherwise a single smooth pulse —
 * up to the platform's peak over FADE_IN_MS, then back down across the rest of
 * the second. Both halves are eased, so it swells and recedes instead of ramping linearly.
 */
export function getDamageFlashAlpha(): number {
  const remaining = flashEndsAt - Date.now()
  if (remaining <= 0) return 0

  const peak = isMobile() ? MAX_ALPHA_MOBILE : MAX_ALPHA_DESKTOP
  const elapsed = FLASH_DURATION_MS - remaining
  if (elapsed < FADE_IN_MS) {
    return peak * smoothstep(elapsed / FADE_IN_MS)
  }

  const fadeOut = (elapsed - FADE_IN_MS) / (FLASH_DURATION_MS - FADE_IN_MS)
  return peak * smoothstep(1 - fadeOut)
}

/** Ease in/out curve on [0,1]; flat at both ends so the fade has no hard edges. */
function smoothstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t))
  return clamped * clamped * (3 - 2 * clamped)
}
