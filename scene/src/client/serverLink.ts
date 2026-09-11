// BattleZone client — view over the server-synced state.
// Tracks server liveness via the heartbeat (client-observed time, so a stale CRDT snapshot from a dead server doesn't read as alive)

import { engine } from '@dcl/sdk/ecs'
import { isStateSyncronized } from '@dcl/sdk/network'
import { RoundState, ServerHeartbeat, PlayerState } from '../shared/components'
import { HEARTBEAT_TIMEOUT_MS, RESPAWN_COOLDOWN_MS, LOBBY_TRANSITION_MS } from '../shared/constants'

export interface PlayerSnapshot {
  playerId: string
  health: number
  bullets: number
  rockets: number
  boostMs: number
  kills: number
  droneKills: number
  deaths: number
  boosting: boolean
  collectedBullets: number
  collectedRockets: number
  collectedBoostMs: number
  alive: boolean
  respawnAtMs: number
  roundId: number
  inLobby: boolean
  switchAtMs: number
}

let localAddress = ''
export function setLocalAddress(address: string) {
  localAddress = address.toLowerCase()
}
export function getLocalAddress(): string {
  return localAddress
}

// address (lowercase) → latest synced snapshot
export const playerStates = new Map<string, PlayerSnapshot>()

// address (lowercase) → display name (filled from onEnterScene)
export const playerNames = new Map<string, string>()
export function displayName(address: string): string {
  const name = playerNames.get(address.toLowerCase())
  if (name && !name.startsWith('0x')) return name
  return address.slice(0, 6) + '…'
}

// ---- Respawn countdown ----
// PlayerState.respawnAtMs is stamped with the SERVER clock, so subtracting the
// client clock from it shows whatever the two clocks disagree by (it read 15s
// for a 10s cooldown) and made the client wait that long before asking to
// rejoin. The server stays authoritative for granting the respawn - its own
// gate spans a correct 10 real seconds whatever its clock reads - while the
// countdown here runs from the moment this client saw itself die.
let respawnReadyAt = 0
let wasDownedLocally = false

/** Milliseconds left of the local respawn cooldown; 0 once it is up. */
export function getRespawnRemainingMs(): number {
  if (respawnReadyAt === 0) return 0
  return Math.max(0, respawnReadyAt - Date.now())
}

// ---- Lobby <-> play countdown ----
// Server-owned (it stamps switchAtMs and makes the change), but displayed on
// the client clock for the same reason as the respawn countdown above: the two
// clocks disagree, and subtracting one from the other showed the wrong number.
let switchReadyAt = 0
let switchPending = false

/** Milliseconds left of a pending lobby<->play switch; 0 when none is armed. */
export function getSwitchRemainingMs(): number {
  if (!switchPending) return 0
  return Math.max(0, switchReadyAt - Date.now())
}

/** True while a lobby<->play switch is armed and counting down. */
export function isSwitchPending(): boolean {
  return switchPending
}

/** True while we are watching from the lobby rather than flying. */
export function inLobby(): boolean {
  const mine = myState()
  // Unknown counts as IN the lobby, which is where every player actually is
  // for the frames before their PlayerState arrives: the server creates them
  // with inLobby true and setupFlight parks them at the vantage point. Reading
  // it the other way flashed the in-play UI on load — the switch button offered
  // LOBBY when it should have said PLAY, and the weapon slots appeared for a
  // moment on a plane that did not exist yet.
  return mine === null || mine.inLobby
}

export function myState(): PlayerSnapshot | null {
  return playerStates.get(localAddress) ?? null
}

// ── Round info ──
export const roundView = { roundId: 0, endsAtMs: 0 }

// ── Heartbeat / liveness ──
let lastHeartbeatValue = -1
let lastHeartbeatSeenAt = 0

export function isServerAlive(): boolean {
  return lastHeartbeatSeenAt > 0 && Date.now() - lastHeartbeatSeenAt < HEARTBEAT_TIMEOUT_MS
}

export function canSend(): boolean {
  return isStateSyncronized() && isServerAlive()
}

/** Per-frame sync scan. Cheap: a handful of entities. */
export function serverLinkSystem(_dt: number) {
  for (const [, heartbeat] of engine.getEntitiesWith(ServerHeartbeat)) {
    if (heartbeat.tickMs !== lastHeartbeatValue) {
      lastHeartbeatValue = heartbeat.tickMs
      lastHeartbeatSeenAt = Date.now() // client-observed time, not the server's
    }
  }
  for (const [, round] of engine.getEntitiesWith(RoundState)) {
    roundView.roundId = round.roundId
    roundView.endsAtMs = round.endsAtMs
  }
  const seen = new Set<string>()
  for (const [, state] of engine.getEntitiesWith(PlayerState)) {
    const key = state.playerId.toLowerCase()
    if (key === '') continue
    seen.add(key)
    playerStates.set(key, {
      playerId: key,
      health: state.health,
      bullets: state.bullets,
      rockets: state.rockets,
      boostMs: state.boostMs,
      boosting: state.boosting,
      collectedBullets: state.collectedBullets,
      collectedRockets: state.collectedRockets,
      collectedBoostMs: state.collectedBoostMs,
      kills: state.kills,
      droneKills: state.droneKills,
      deaths: state.deaths,
      alive: state.alive,
      respawnAtMs: state.respawnAtMs,
      roundId: state.roundId,
      inLobby: state.inLobby,
      switchAtMs: state.switchAtMs
    })
  }
  for (const key of playerStates.keys()) {
    if (!seen.has(key)) playerStates.delete(key)
  }

  // start the cooldown the moment we observe our own death, on this clock.
  // Being in the lobby is also "not alive", but it is not a death and carries
  // no respawn countdown — only a downed pilot waits one out.
  const mine = playerStates.get(localAddress)
  if (mine !== undefined) {
    const downed = !mine.alive && !mine.inLobby
    if (downed && !wasDownedLocally) respawnReadyAt = Date.now() + RESPAWN_COOLDOWN_MS
    if (!downed) respawnReadyAt = 0
    wasDownedLocally = downed

    const pending = mine.switchAtMs !== 0
    if (pending && !switchPending) switchReadyAt = Date.now() + LOBBY_TRANSITION_MS
    switchPending = pending
  }
}
