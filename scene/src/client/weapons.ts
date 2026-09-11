// BattleZone client — weapons.

import {
  engine, Transform, Entity, MeshRenderer, Material, InputAction, inputSystem,
  raycastSystem, RaycastQueryType, ColliderLayer
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4, Color3 } from '@dcl/sdk/math'
import { room } from '../shared/messages'
import {
  BULLET_VOLLEY_INTERVAL, BULLETS_PER_VOLLEY, ROCKET_INTERVAL,
  BULLET_SPEED, BULLET_RANGE, BULLET_HIT_RADIUS,
  ROCKET_SPEED, ROCKET_RANGE, ROCKET_SPLASH_RADIUS, ROCKET_PROXIMITY_FUSE
} from '../shared/constants'
import { canSend, myState, getLocalAddress } from './serverLink'
import { getFlightMode, FlightMode, isRoundPaused } from './flight'
import { actionAvailable, takeAction, releaseAction } from './actionLock'
import { getMuzzles, remotePlanePositions } from './planes'
import { getClientDronePositions } from './drones'
import { explode } from './vfx'
import { playShot, playImpact } from './sfx'

// Optimistic ammo view for the HUD (server value + local pending decrements).
export const ammoView = { bullets: 0, rockets: 0, synced: false }
let lastServerBullets = -1
let lastServerRockets = -1

type Weapon = 'bullet' | 'rocket'

interface Projectile {
  entity: Entity
  active: boolean
  mine: boolean // local projectiles detect hits; remote ones are cosmetic
  weapon: Weapon
  pos: Vector3.MutableVector3
  dir: Vector3
  speed: number
  traveled: number
  maxDist: number
}

/**
 * Pool sizes, shared by our own shots AND every relayed tracer.
 */
const BULLET_POOL = 28
const ROCKET_POOL = 8

const HIDDEN = Vector3.create(0, -450, 0)
const projectiles: Projectile[] = []
const rayEntities: Entity[] = []
let rayIndex = 0

function createProjectile(weapon: Weapon): Projectile {
  const entity = engine.addEntity()
  Transform.create(entity, { position: Vector3.clone(HIDDEN) })
  MeshRenderer.setBox(entity)
  if (weapon === 'bullet') {
    Material.setPbrMaterial(entity, {
      albedoColor: Color4.create(1, 0.9, 0.3, 1),
      emissiveColor: Color3.create(1, 0.85, 0.2),
      emissiveIntensity: 6
    })
  } else {
    Material.setPbrMaterial(entity, {
      albedoColor: Color4.create(1, 0.4, 0.1, 1),
      emissiveColor: Color3.create(1, 0.3, 0.05),
      emissiveIntensity: 5
    })
  }
  return {
    entity, active: false, mine: false, weapon,
    pos: Vector3.Zero(), dir: Vector3.Forward(), speed: 0, traveled: 0, maxDist: 0
  }
}

export function setupWeapons() {
  for (let i = 0; i < BULLET_POOL; i++) projectiles.push(createProjectile('bullet'))
  for (let i = 0; i < ROCKET_POOL; i++) projectiles.push(createProjectile('rocket'))
  for (let i = 0; i < 8; i++) {
    const entity = engine.addEntity()
    Transform.create(entity, { position: Vector3.clone(HIDDEN) })
    rayEntities.push(entity)
  }

  // remote tracers
  room.onMessage('playerFired', (data) => {
    if (data.playerId.toLowerCase() === getLocalAddress()) return
    const origin = Vector3.create(data.ox, data.oy, data.oz)
    const dir = Vector3.create(data.dx, data.dy, data.dz)
    playShot(data.weapon, origin, data.playerId)
    if (data.weapon === 'bullet') {
      // two wing tracers, like the local volley
      const rot = Quaternion.lookRotation(dir, Vector3.Up())
      const right = Vector3.rotate(Vector3.Right(), rot)
      spawnProjectile('bullet', Vector3.add(origin, Vector3.scale(right, -1.6)), dir, false)
      spawnProjectile('bullet', Vector3.add(origin, Vector3.scale(right, 1.6)), dir, false)
    } else {
      spawnProjectile('rocket', origin, dir, false)
    }
  })
}

function takeSlot(weapon: Weapon): Projectile | null {
  for (const p of projectiles) {
    if (!p.active && p.weapon === weapon) return p
  }
  return null
}

function spawnProjectile(weapon: Weapon, origin: Vector3, dir: Vector3, mine: boolean) {
  const p = takeSlot(weapon)
  if (p === null) return
  const range = weapon === 'bullet' ? BULLET_RANGE : ROCKET_RANGE
  p.active = true
  p.mine = mine
  p.pos = Vector3.clone(origin)
  p.dir = Vector3.normalize(dir)
  p.speed = weapon === 'bullet' ? BULLET_SPEED : ROCKET_SPEED
  p.traveled = 0
  p.maxDist = range

  const scale = weapon === 'bullet' ? Vector3.create(0.09, 0.09, 1.3) : Vector3.create(0.28, 0.28, 1.1)
  Transform.createOrReplace(p.entity, {
    position: Vector3.clone(origin),
    rotation: Quaternion.lookRotation(p.dir, Vector3.Up()),
    scale
  })

  // clamp flight distance at the first wall in the way (one-shot renderer raycast)
  const rayEntity = rayEntities[rayIndex]
  rayIndex = (rayIndex + 1) % rayEntities.length
  Transform.getMutable(rayEntity).position = Vector3.clone(origin)
  raycastSystem.registerGlobalDirectionRaycast(
    {
      entity: rayEntity,
      opts: {
        queryType: RaycastQueryType.RQT_HIT_FIRST,
        direction: p.dir,
        maxDistance: range,
        continuous: false,
        collisionMask: ColliderLayer.CL_PHYSICS
      }
    },
    (result) => {
      const hit = result.hits[0]
      if (hit?.length !== undefined && p.active) {
        p.maxDist = Math.min(p.maxDist, hit.length)
      }
    }
  )
}

function killProjectile(p: Projectile) {
  p.active = false
  Transform.getMutable(p.entity).position = Vector3.clone(HIDDEN)
}

function cameraForward(): Vector3 | null {
  const cam = Transform.getOrNull(engine.CameraEntity)
  if (cam === null) return null
  return Vector3.rotate(Vector3.Forward(), cam.rotation)
}

// ── firing ──

let volleyTimer = 0
let rocketTimer = 0

function tryFire(dt: number) {
  volleyTimer = Math.max(0, volleyTimer - dt)
  rocketTimer = Math.max(0, rocketTimer - dt)

  const mode = getFlightMode()
  const state = myState()
  const aim = cameraForward()
  const muzzles = getMuzzles()
  // Everything that has to hold to be shooting at all, as ONE flag rather than a chain of early returns
  const armed =
    (mode === FlightMode.CONTROL || mode === FlightMode.CIRCLING) &&
    !isRoundPaused() &&
    state !== null &&
    state.alive &&
    canSend()

  // A gun holds the plane for exactly as long as its trigger is down — no timer.
  const bulletsDown = armed && inputSystem.isPressed(InputAction.IA_PRIMARY) && ammoView.bullets > 0
  const rocketsDown = armed && inputSystem.isPressed(InputAction.IA_SECONDARY) && ammoView.rockets > 0
  if (!bulletsDown) releaseAction('bullets')
  if (!rocketsDown) releaseAction('rockets')

  if (!armed || aim === null || muzzles === null) return

  if (bulletsDown && actionAvailable('bullets')) {
    takeAction('bullets', 0) // until the trigger comes up
    if (volleyTimer <= 0) {
      volleyTimer = BULLET_VOLLEY_INTERVAL
      ammoView.bullets = Math.max(0, ammoView.bullets - BULLETS_PER_VOLLEY)
      spawnProjectile('bullet', muzzles.left, aim, true)
      spawnProjectile('bullet', muzzles.right, aim, true)
      const center = Vector3.lerp(muzzles.left, muzzles.right, 0.5)
      playShot('bullet', center, getLocalAddress())
      room.send('fireBullet', { ox: center.x, oy: center.y, oz: center.z, dx: aim.x, dy: aim.y, dz: aim.z })
    }
  }

  if (rocketsDown && actionAvailable('rockets')) {
    takeAction('rockets', 0)
    if (rocketTimer <= 0) {
      rocketTimer = ROCKET_INTERVAL
      ammoView.rockets = Math.max(0, ammoView.rockets - 1)
      spawnProjectile('rocket', muzzles.under, aim, true)
      playShot('rocket', muzzles.under, getLocalAddress())
      room.send('fireRocket', {
        ox: muzzles.under.x, oy: muzzles.under.y, oz: muzzles.under.z,
        dx: aim.x, dy: aim.y, dz: aim.z
      })
    }
  }
}

// ── impacts ──

function detonateRocket(p: Projectile) {
  explode(p.pos, 2.5)
  playImpact(p.pos, '')
  if (p.mine) {
    for (const target of remotePlanePositions()) {
      if (Vector3.distance(p.pos, target.position) <= ROCKET_SPLASH_RADIUS) {
        room.send('reportPlayerHit', { victimId: target.address, weapon: 'rocket', x: p.pos.x, y: p.pos.y, z: p.pos.z })
      }
    }
    for (const drone of getClientDronePositions()) {
      if (Vector3.distance(p.pos, drone.position) <= ROCKET_SPLASH_RADIUS) {
        room.send('reportDroneHit', { droneId: drone.id, weapon: 'rocket', x: p.pos.x, y: p.pos.y, z: p.pos.z })
      }
    }
  }
  killProjectile(p)
}

/**
 * Shortest distance from a target point to the segment the projectile covered tick.
 */
function closestT(
  point: Vector3,
  fromX: number, fromY: number, fromZ: number,
  toX: number, toY: number, toZ: number
): number {
  const sx = toX - fromX
  const sy = toY - fromY
  const sz = toZ - fromZ
  const lenSq = sx * sx + sy * sy + sz * sz
  if (lenSq <= 0.000001) return 0
  const t = ((point.x - fromX) * sx + (point.y - fromY) * sy + (point.z - fromZ) * sz) / lenSq
  return t < 0 ? 0 : t > 1 ? 1 : t
}

function distanceToSegment(
  point: Vector3,
  fromX: number, fromY: number, fromZ: number,
  toX: number, toY: number, toZ: number
): number {
  const t = closestT(point, fromX, fromY, fromZ, toX, toY, toZ)
  const dx = point.x - (fromX + (toX - fromX) * t)
  const dy = point.y - (fromY + (toY - fromY) * t)
  const dz = point.z - (fromZ + (toZ - fromZ) * t)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** The impact point itself, for the burst and for what gets reported. */
function impactPoint(
  point: Vector3,
  fromX: number, fromY: number, fromZ: number,
  toX: number, toY: number, toZ: number
): Vector3 {
  const t = closestT(point, fromX, fromY, fromZ, toX, toY, toZ)
  return Vector3.create(fromX + (toX - fromX) * t, fromY + (toY - fromY) * t, fromZ + (toZ - fromZ) * t)
}

export function weaponsSystem(dt: number) {
  // re-sync optimistic ammo whenever the server value changes
  const state = myState()
  if (state !== null) {
    if (state.bullets !== lastServerBullets) {
      lastServerBullets = state.bullets
      ammoView.bullets = state.bullets
    }
    if (state.rockets !== lastServerRockets) {
      lastServerRockets = state.rockets
      ammoView.rockets = state.rockets
    }
    ammoView.synced = true
  }

  tryFire(dt)

  // ── projectile flight + hit detection ──
  const remotes = remotePlanePositions()
  const drones = getClientDronePositions()

  for (const p of projectiles) {
    if (!p.active) continue
    // segment start, for the swept hit test below
    const fromX = p.pos.x
    const fromY = p.pos.y
    const fromZ = p.pos.z
    const step = p.speed * dt
    p.pos.x += p.dir.x * step
    p.pos.y += p.dir.y * step
    p.pos.z += p.dir.z * step
    p.traveled += step
    Transform.getMutable(p.entity).position = p.pos

    if (p.traveled >= p.maxDist) {
      const overshoot = p.traveled - p.maxDist
      p.pos.x -= p.dir.x * overshoot
      p.pos.y -= p.dir.y * overshoot
      p.pos.z -= p.dir.z * overshoot
      p.traveled = p.maxDist
      Transform.getMutable(p.entity).position = p.pos

      if (p.weapon === 'rocket') detonateRocket(p)
      else {
        explode(p.pos, 0.6) // bullet puff on walls / at range end
        playImpact(p.pos, '') // stays on the rock it hit
        killProjectile(p)
      }
      continue
    }

    if (!p.mine) continue // cosmetic remote tracer

    if (p.weapon === 'bullet') {
      let hit = false
      for (const target of remotes) {
        if (distanceToSegment(target.position, fromX, fromY, fromZ, p.pos.x, p.pos.y, p.pos.z) <= BULLET_HIT_RADIUS) {
          const at = impactPoint(target.position, fromX, fromY, fromZ, p.pos.x, p.pos.y, p.pos.z)
          room.send('reportPlayerHit', { victimId: target.address, weapon: 'bullet', x: at.x, y: at.y, z: at.z })
          explode(at, 1)
          hit = true
          break
        }
      }
      if (!hit) {
        for (const drone of drones) {
          if (distanceToSegment(drone.position, fromX, fromY, fromZ, p.pos.x, p.pos.y, p.pos.z) <= BULLET_HIT_RADIUS) {
            const at = impactPoint(drone.position, fromX, fromY, fromZ, p.pos.x, p.pos.y, p.pos.z)
            room.send('reportDroneHit', { droneId: drone.id, weapon: 'bullet', x: at.x, y: at.y, z: at.z })
            explode(at, 1)
            hit = true
            break
          }
        }
      }
      if (hit) killProjectile(p)
    } else {
      // rocket proximity fuse
      let fused = false
      for (const target of remotes) {
        if (distanceToSegment(target.position, fromX, fromY, fromZ, p.pos.x, p.pos.y, p.pos.z) <= ROCKET_PROXIMITY_FUSE) {
          fused = true
          break
        }
      }
      if (!fused) {
        for (const drone of drones) {
          if (distanceToSegment(drone.position, fromX, fromY, fromZ, p.pos.x, p.pos.y, p.pos.z) <= ROCKET_PROXIMITY_FUSE) {
            fused = true
            break
          }
        }
      }
      if (fused) detonateRocket(p)
    }
  }
}
