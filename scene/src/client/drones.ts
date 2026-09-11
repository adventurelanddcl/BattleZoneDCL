// BattleZone client — drone rendering.

import { engine, Transform, GltfContainer, ColliderLayer, Entity } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { DroneState } from '../shared/components'
import { room } from '../shared/messages'
import { DRONE_MODEL_SRC, DRONE_COUNT } from '../shared/constants'
import { explode } from './vfx'
import { playImpact } from './sfx'

const HIDDEN_Y = -420

interface ClientDrone {
  root: Entity
  syncPos: Vector3.MutableVector3
  syncVel: Vector3.MutableVector3
  syncSeenAt: number // client clock, ms
  renderPos: Vector3.MutableVector3
  yaw: number
  spin: number
  active: boolean
  lastRaw: string // change detector for the synced snapshot
}

const clientDrones = new Map<number, ClientDrone>()

function createDrone(): Entity {
  const root = engine.addEntity()
  Transform.create(root, { position: Vector3.create(0, HIDDEN_Y, 0) })
  const model = engine.addEntity()
  Transform.create(model, {
    parent: root,
    scale: Vector3.One() // models are authored at true size - see constants.ts
  })
  GltfContainer.create(model, {
    src: DRONE_MODEL_SRC,
    visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
    invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
  })
  return root
}

export function setupDrones() {
  room.onMessage('droneExploded', (data) => {
    const drone = clientDrones.get(data.droneId)
    const seen = drone ? Transform.getOrNull(drone.root) : null
    const burstAt =
      seen !== null
        ? Vector3.create(seen.position.x, seen.position.y, seen.position.z)
        : Vector3.create(data.x, data.y, data.z)
    explode(burstAt, 3)
    // '' even when it rammed somebody: the blast belongs to the place, and the drone that made it has just ceased to exist.
    playImpact(burstAt, '')
    if (drone) {
      drone.active = false
      Transform.getMutable(drone.root).position.y = HIDDEN_Y
    }
  })
}

/** Rendered drone positions for local hit detection. */
export function getClientDronePositions(): { id: number; position: Vector3 }[] {
  const list: { id: number; position: Vector3 }[] = []
  for (const [id, drone] of clientDrones) {
    if (drone.active) list.push({ id, position: drone.renderPos })
  }
  return list
}

export function dronesSystem(dt: number) {
  const now = Date.now()

  for (const [, state] of engine.getEntitiesWith(DroneState)) {
    if (state.droneId < 0 || state.droneId >= DRONE_COUNT) continue
    let drone = clientDrones.get(state.droneId)
    if (drone === undefined) {
      drone = {
        root: createDrone(),
        syncPos: Vector3.create(state.px, state.py, state.pz),
        syncVel: Vector3.create(state.vx, state.vy, state.vz),
        syncSeenAt: now,
        renderPos: Vector3.create(state.px, state.py, state.pz),
        yaw: 0,
        spin: Math.random() * Math.PI * 2,
        active: state.active,
        lastRaw: ''
      }
      clientDrones.set(state.droneId, drone)
    }

    // adopt new snapshots (client-observed time, so prediction is skew-proof)
    const raw = `${state.px.toFixed(2)}|${state.py.toFixed(2)}|${state.pz.toFixed(2)}|${state.vx.toFixed(2)}|${state.vy.toFixed(2)}|${state.vz.toFixed(2)}|${state.active}`
    if (raw !== drone.lastRaw) {
      drone.lastRaw = raw
      drone.syncPos = Vector3.create(state.px, state.py, state.pz)
      drone.syncVel = Vector3.create(state.vx, state.vy, state.vz)
      drone.syncSeenAt = now
      if (state.active && !drone.active) {
        // respawned — snap to the new spot instead of gliding across the map
        drone.renderPos = Vector3.create(state.px, state.py, state.pz)
      }
      drone.active = state.active
    }
  }

  for (const drone of clientDrones.values()) {
    const t = Transform.getMutable(drone.root)
    if (!drone.active) {
      t.position.y = HIDDEN_Y
      continue
    }

    // dead reckoning: predicted = snapshot + velocity * elapsed (capped)
    const elapsed = Math.min(1.5, (Date.now() - drone.syncSeenAt) / 1000)
    const predicted = Vector3.create(
      drone.syncPos.x + drone.syncVel.x * elapsed,
      drone.syncPos.y + drone.syncVel.y * elapsed,
      drone.syncPos.z + drone.syncVel.z * elapsed
    )
    const blend = Math.min(1, 5 * dt)
    drone.renderPos.x += (predicted.x - drone.renderPos.x) * blend
    drone.renderPos.y += (predicted.y - drone.renderPos.y) * blend
    drone.renderPos.z += (predicted.z - drone.renderPos.z) * blend

    // face travel direction (yaw only) + menace wobble
    const speedSq = drone.syncVel.x * drone.syncVel.x + drone.syncVel.z * drone.syncVel.z
    if (speedSq > 0.5) {
      const targetYaw = Math.atan2(drone.syncVel.x, drone.syncVel.z)
      let delta = targetYaw - drone.yaw
      if (delta > Math.PI) delta -= Math.PI * 2
      if (delta < -Math.PI) delta += Math.PI * 2
      drone.yaw += delta * Math.min(1, 3 * dt)
    }
    drone.spin += dt * 2

    t.position = drone.renderPos
    t.rotation = Quaternion.fromEulerDegrees(
      Math.sin(drone.spin) * 6,
      (drone.yaw * 180) / Math.PI,
      Math.cos(drone.spin * 1.3) * 6
    )
  }
}
