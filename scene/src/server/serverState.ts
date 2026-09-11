// BattleZone server — in-memory state. Live gameplay state lives here

import { Entity, Transform, engine, PlayerIdentityData } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { PlayerState } from '../shared/components'
import { DRONE_SPAWNS, PICKUP_SPOTS } from '../shared/constants'

// ── Players ──
// address (lowercase) → synced PlayerState entity
export const playerEntities = new Map<string, Entity>()
// address (lowercase) → avatar entity (server-side replicated avatar, for positions)
export const avatarEntities = new Map<string, Entity>()

/** Server-verified scene-local position of a player, or null if unknown. */
export function getPlayerPosition(address: string): Vector3 | null {
  const avatar = avatarEntities.get(address.toLowerCase())
  if (avatar === undefined) return null
  const t = Transform.getOrNull(avatar)
  return t ? t.position : null
}

/** Validate a cached PlayerState entity, dropping stale handles (recycled slots). */
export function getPlayerState(address: string) {
  const entity = playerEntities.get(address.toLowerCase())
  if (entity === undefined) return null
  const state = PlayerState.getMutableOrNull(entity)
  if (state === null) {
    playerEntities.delete(address.toLowerCase())
    return null
  }
  return state
}

/** Rebuild the avatar entity map from the engine. */
export function refreshAvatarMap() {
  avatarEntities.clear()
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    avatarEntities.set(identity.address.toLowerCase(), entity)
  }
}

// ── Drones ──
export interface DroneRecord {
  id: number
  entity: Entity
  active: boolean
  hp: number
  pos: Vector3.MutableVector3
  vel: Vector3.MutableVector3
  respawnAtMs: number
  syncTimer: number
  /** Centre of the patch this drone patrols and returns to - its spawn point. */
  home: Vector3.MutableVector3
  /** Address being chased, or empty while patrolling. */
  chasing: string
}
export const drones: DroneRecord[] = []

// ── Pickups ──
export interface PickupRecord {
  id: number
  active: boolean
  respawnAtMs: number
}
export const pickups: PickupRecord[] = PICKUP_SPOTS.map((s) => ({ id: s.id, active: true, respawnAtMs: 0 }))

// ── Death drops ──
export interface DropRecord {
  id: number
  entity: Entity
  active: boolean
  kind: number
  amount: number
  droppedAtMs: number // when it fell; only used to pick which crate to recycle
}
export const drops: DropRecord[] = []

// ── Boost ──
// address (lowercase) -> server timestamp the current burn started at.
// Absent means not boosting.
export const boostingSince = new Map<string, number>()

/**
 * address -> the gun occupying the plane and when it frees up, for the
 * one-action-at-a-time rule. Boost is NOT tracked here: it is already held
 * authoritatively in boostingSince above, and a second copy would only be
 * something to keep in step with it.
 */
export const weaponLock = new Map<string, { action: string; untilMs: number }>()

// ── Rate limiting (per-address counters, reset every second) ──
const rateCounters = new Map<string, number>()
export function isRateLimited(address: string, key: string, maxPerSecond: number): boolean {
  const bucket = `${address}|${key}|${Math.floor(Date.now() / 1000)}`
  const count = (rateCounters.get(bucket) ?? 0) + 1
  rateCounters.set(bucket, count)
  if (rateCounters.size > 2000) rateCounters.clear() // crude GC, buckets expire each second anyway
  return count > maxPerSecond
}

// ── Round ──
export const roundInfo = {
  roundId: 0,
  endsAtMs: 0,
  /** While > 0 the round is over and the scoreboard is up; 0 means play. */
  intermissionUntilMs: 0
}

export { DRONE_SPAWNS }
