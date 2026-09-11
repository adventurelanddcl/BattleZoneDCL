// BattleZone client — speed boost.
// Boost is banked in seconds (blue collectibles)

import { InputAction, inputSystem } from '@dcl/sdk/ecs'
import { room } from '../shared/messages'
import { canSend, myState } from './serverLink'
import { getFlightMode, FlightMode, isRoundPaused } from './flight'
import { actionAvailable, takeAction, releaseAction } from './actionLock'

/** Optimistic view of the banked boost, in milliseconds. */
export const boostView = { ms: 0 }

let boosting = false
let lastServerMs = -1

/** True while the plane should be flying at boosted speed. */
export function isBoosting(): boolean {
  return boosting
}

/** Seconds of boost left, for the HUD. */
export function boostSecondsLeft(): number {
  return boostView.ms / 1000
}

function stopBoost() {
  if (!boosting) return
  boosting = false
  releaseAction('boost') // the guns can have the plane back
  if (canSend()) room.send('boostStop', { t: Date.now() })
}

export function boostSystem(dt: number) {
  const state = myState()

  // Adopt the server value whenever it changes (pickup granted, burn settled, round reset). Between those, the local countdown below owns the number.
  if (state !== null && state.boostMs !== lastServerMs) {
    lastServerMs = state.boostMs
    boostView.ms = state.boostMs
  }

  const mode = getFlightMode()
  // CONTROL only: the speed multiplier is applied in that branch of flight.ts,
  // so burning fuel while the autopilot circles would cost the player nothing back
  // Frozen between rounds counts as not flying: the multiplier in flight.ts is
  // not applied to a standstill, so a burn would cost the player stock for nothing.
  const flying = mode === FlightMode.CONTROL && !isRoundPaused()
  if (state === null || !state.alive || !flying) {
    stopBoost()
    return
  }

  const wants = inputSystem.isPressed(InputAction.IA_JUMP)

  // Refused while a gun still has the plane: one action at a time, so a burn
  // cannot be layered on top of a volley the way it can on a keyboard.
  if (wants && !boosting && boostView.ms > 0 && canSend() && actionAvailable('boost')) {
    boosting = true
    takeAction('boost', 0) // held until the button comes up
    room.send('boostStart', { t: Date.now() })
  } else if (!wants && boosting) {
    stopBoost()
  }

  if (boosting) {
    boostView.ms = Math.max(0, boostView.ms - dt * 1000)
    if (boostView.ms <= 0) stopBoost()
  }
}
