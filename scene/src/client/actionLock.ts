// BattleZone client — one action at a time.
//
// Bullets, rockets and boost are mutually exclusive: while one has the plane the
// other two are refused. A keyboard can hold three inputs at once and a
// touchscreen cannot, so without this rule the same plane is simply a better
// plane on PC than on Mobile — which is the whole reason the lock exists.

export type PlaneAction = 'bullets' | 'rockets' | 'boost'

let holder: PlaneAction | null = null
/** When the hold lapses. 0 = held until explicitly released (boost). */
let untilMs = 0

/** The action using the plane, or null if it is free. */
export function currentAction(): PlaneAction | null {
  if (holder !== null && untilMs !== 0 && Date.now() >= untilMs) {
    holder = null
    untilMs = 0
  }
  return holder
}

/** True if `action` may start now — nothing else has the plane. */
export function actionAvailable(action: PlaneAction): boolean {
  const held = currentAction()
  return held === null || held === action
}

/** Take the plane. `forMs` of 0 keeps it until releaseAction. */
export function takeAction(action: PlaneAction, forMs: number) {
  holder = action
  untilMs = forMs > 0 ? Date.now() + forMs : 0
}

/** Give the plane back. Only the holder can, so a stale release is harmless. */
export function releaseAction(action: PlaneAction) {
  if (holder !== action) return
  holder = null
  untilMs = 0
}
