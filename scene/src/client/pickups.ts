// BattleZone client — floating collectibles.
// One GLB per kind (bullets / rockets / boost). Active set comes from the
// server-synced PickupState; flying near one sends a pickup request that the
// server validates by proximity.

import { engine, Transform, Entity, GltfContainer, ColliderLayer } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { PickupState, DropState } from '../shared/components'
import { room } from '../shared/messages'
import {
  PICKUP_SPOTS, withinPickupRange,
  MAX_DROPS, DROP_KIND_BULLETS, DROP_KIND_ROCKETS,
  PICKUP_MODEL_BULLETS, PICKUP_MODEL_ROCKETS, PICKUP_MODEL_BOOST
} from '../shared/constants'
import { canSend, myState } from './serverLink'
import { localPlanePosition } from './planes'
import { collectPuff } from './vfx'
import { playCollect } from './sfx'
import { planeRootFor } from './planes'

const HIDDEN_Y = -430

/** Both channels off — see the note at the top of the file. */
const NO_COLLIDERS = {
  visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
  invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
}

/** Model for a static crate's kind. */
function spotModel(kind: 'bullets' | 'rockets' | 'boost'): string {
  if (kind === 'bullets') return PICKUP_MODEL_BULLETS
  if (kind === 'rockets') return PICKUP_MODEL_ROCKETS
  return PICKUP_MODEL_BOOST
}

/** A death drop's DROP_KIND_* as the name collectPuff colours by. */
function dropKindName(kind: number): string {
  if (kind === DROP_KIND_ROCKETS) return 'rockets'
  if (kind === DROP_KIND_BULLETS) return 'bullets'
  return 'boost'
}

/** Model for a death drop's DROP_KIND_*. */
function dropModel(kind: number): string {
  if (kind === DROP_KIND_BULLETS) return PICKUP_MODEL_BULLETS
  if (kind === DROP_KIND_ROCKETS) return PICKUP_MODEL_ROCKETS
  return PICKUP_MODEL_BOOST
}

interface ClientPickup {
  entity: Entity
  active: boolean
  requestCooldown: number
  phase: number
}

const clientPickups: ClientPickup[] = []
let lastActiveJson = ''

export function setupPickups() {
  for (const spot of PICKUP_SPOTS) {
    const entity = engine.addEntity()
    Transform.create(entity, {
      position: Vector3.create(spot.x, spot.y, spot.z),
      scale: Vector3.One() // models are authored at true size - see constants.ts
    })
    GltfContainer.create(entity, { src: spotModel(spot.kind), ...NO_COLLIDERS })
    clientPickups.push({ entity, active: true, requestCooldown: 0, phase: Math.random() * Math.PI * 2 })
  }

  room.onMessage('pickupTaken', (data) => {
    const pickup = clientPickups[data.pickupId]
    const spot = PICKUP_SPOTS[data.pickupId]
    if (pickup === undefined || spot === undefined) return
    pickup.active = false
    Transform.getMutable(pickup.entity).position.y = HIDDEN_Y
    // Both are for everyone - hearing and seeing someone else resupply is
    // worth knowing. The puff hangs off THEIR plane, so it reads as who took it
    // rather than as something happening in mid-air.
    const at = Vector3.create(spot.x, spot.y, spot.z)
    playCollect(at, data.playerId)
    collectPuff(spot.kind, planeRootFor(data.playerId), at)
  })
}

export function pickupsSystem(dt: number) {
  // adopt the synced active set when it changes
  for (const [, state] of engine.getEntitiesWith(PickupState)) {
    if (state.activeJson !== lastActiveJson) {
      lastActiveJson = state.activeJson
      let activeIds: number[] = []
      try {
        activeIds = JSON.parse(state.activeJson) as number[]
      } catch {
        activeIds = []
      }
      const activeSet = new Set(activeIds)
      for (let i = 0; i < clientPickups.length; i++) {
        clientPickups[i].active = activeSet.has(i)
      }
    }
  }

  const now = Date.now() / 1000
  const planePos = localPlanePosition()
  const state = myState()
  const collecting = planePos !== null && state !== null && state.alive && canSend()

  for (let i = 0; i < clientPickups.length; i++) {
    const pickup = clientPickups[i]
    const spot = PICKUP_SPOTS[i]
    const t = Transform.getMutable(pickup.entity)
    pickup.requestCooldown = Math.max(0, pickup.requestCooldown - dt)

    if (!pickup.active) {
      t.position.y = HIDDEN_Y
      continue
    }

    // bob + spin
    t.position.x = spot.x
    t.position.z = spot.z
    t.position.y = spot.y + Math.sin(now * 1.5 + pickup.phase) * 0.5
    t.rotation = Quaternion.fromEulerDegrees(0, ((now * 40 + pickup.phase * 60) % 360), 0)

    if (collecting && pickup.requestCooldown <= 0 && planePos !== null) {
      if (withinPickupRange(planePos, t.position)) {
        pickup.requestCooldown = 1.5
        room.send('requestPickup', { pickupId: i })
      }
    }
  }
}

// ── Death drops ──
// A destroyed plane leaves its unspent load in crates at the wreck. The server
// owns them (position and contents) and publishes through DropState; this is a
// pooled set of crates that mirrors whatever the server says is out there.

interface ClientDrop {
  entity: Entity
  kind: number // last kind this slot was set to, so the model is only swapped on change
  requestCooldown: number
  phase: number
}
const clientDrops: ClientDrop[] = []

/**
 * Points a pooled slot at the model for its contents.
 *
 * Guarded on the kind actually changing: writing `src` reloads the GLB, and a
 * pool slot keeps its contents for the life of the crate, so an unguarded write
 * would reload the same model every frame.
 */
function setDropModel(drop: ClientDrop, kind: number) {
  if (drop.kind === kind) return
  drop.kind = kind
  GltfContainer.getMutable(drop.entity).src = dropModel(kind)
}

export function setupDrops() {
  for (let i = 0; i < MAX_DROPS; i++) {
    const entity = engine.addEntity()
    Transform.create(entity, {
      position: Vector3.create(0, HIDDEN_Y, 0),
      scale: Vector3.One() // same crate model, so the same size as a static one
    })
    GltfContainer.create(entity, { src: dropModel(DROP_KIND_BULLETS), ...NO_COLLIDERS })
    // -1 so the first real kind always swaps the model in, whatever it is
    clientDrops.push({ entity, kind: -1, requestCooldown: 0, phase: Math.random() * Math.PI * 2 })
  }

  room.onMessage('dropTaken', (data) => {
    const drop = clientDrops[data.dropId]
    if (drop === undefined) return
    const t = Transform.getMutable(drop.entity)
    const at = Vector3.create(t.position.x, t.position.y, t.position.z)
    playCollect(at, data.playerId)
    collectPuff(dropKindName(drop.kind), planeRootFor(data.playerId), at)
    t.position.y = HIDDEN_Y
  })
}

export function dropsSystem(dt: number) {
  const now = Date.now() / 1000
  const planePos = localPlanePosition()
  const state = myState()
  const collecting = planePos !== null && state !== null && state.alive && canSend()

  for (const [, drop] of engine.getEntitiesWith(DropState)) {
    if (drop.dropId < 0 || drop.dropId >= clientDrops.length) continue
    const slot = clientDrops[drop.dropId]
    const t = Transform.getMutable(slot.entity)
    slot.requestCooldown = Math.max(0, slot.requestCooldown - dt)

    if (!drop.active) {
      t.position.y = HIDDEN_Y
      continue
    }

    setDropModel(slot, drop.kind)
    t.position.x = drop.x
    t.position.z = drop.z
    t.position.y = drop.y + Math.sin(now * 1.5 + slot.phase) * 0.4
    t.rotation = Quaternion.fromEulerDegrees(0, (now * 55 + slot.phase * 60) % 360, 0)

    if (collecting && slot.requestCooldown <= 0 && planePos !== null) {
      if (withinPickupRange(planePos, t.position)) {
        slot.requestCooldown = 1.5
        room.send('requestDropPickup', { dropId: drop.dropId })
      }
    }
  }
}
