// BattleZone client — view over the synced leaderboard.
//
// The server publishes the board as JSON on a single component, changing once
// per round. Parsing that on every UI frame would be wasteful, so the payload
// is parsed only when the string itself changes and the UI reads the cached arrays.

import { engine } from '@dcl/sdk/ecs'
import { LeaderboardState } from '../shared/components'
import { BoardRow, EventRow } from '../shared/stats'

const allTime: BoardRow[] = []
const event: EventRow[] = []
const view = { eventLabel: '', eventBoardActive: false }

// The payload is a few KB of JSON. Comparing it every frame to spot a change
// would be silly when the server already stamps every publish, so the
// timestamp is the change token and the strings are only touched when it moves.
let lastUpdatedAtMs = -1

export function allTimeRows(): BoardRow[] {
  return allTime
}
export function eventRows(): EventRow[] {
  return event
}
export function isEventBoardActive(): boolean {
  return view.eventBoardActive
}
export function eventLabel(): string {
  return view.eventLabel
}

/** A malformed payload must not take the HUD down, so parsing is guarded. */
function parseRows<T>(json: string, into: T[]) {
  into.length = 0
  try {
    const parsed = JSON.parse(json)
    if (Array.isArray(parsed)) for (const row of parsed) into.push(row as T)
  } catch (err) {
    console.error('[CLIENT] bad leaderboard payload:', err)
  }
}

export function leaderboardSystem() {
  for (const [, state] of engine.getEntitiesWith(LeaderboardState)) {
    if (state.updatedAtMs === lastUpdatedAtMs) continue
    lastUpdatedAtMs = state.updatedAtMs
    parseRows(state.allTimeJson, allTime)
    parseRows(state.eventJson, event)
    view.eventLabel = state.eventLabel
    view.eventBoardActive = state.eventBoardActive
  }
}
