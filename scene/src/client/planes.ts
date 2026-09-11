// BattleZone client — plane models.
//
// The two planes are attached in DIFFERENT ways, on purpose:
//
// LOCAL — parented to engine.PlayerEntity. Scene-code Transform writes land at
// the scene tick rate and the renderer does not interpolate them, so a plane at
// 20 m/s visibly stepped; as a child, the engine composes the pose from the
// avatar transform on every rendered frame, so it moves exactly as smoothly as
// the avatar. Parenting to engine.PlayerEntity is the documented way to carry an
// item on the local player, and its Transform then holds LOCAL values — which is
// why world positions for aiming come from the avatar entity, not from here.
//
// REMOTE — plain world-space entities, NOT parented. Parenting them to another
// player's avatar entity made them stop rendering entirely (other players'
// planes vanished); only engine.PlayerEntity is a supported parent, and the
// sanctioned way to hang something off another player is AvatarAttach. So these
// are positioned in world space and smoothed toward the avatar each frame, which
// filters the comms-rate steps without depending on parenting.

import {
  engine, Transform, GltfContainer, ColliderLayer, Entity, PlayerIdentityData,
  MeshRenderer, Material, Billboard, BillboardMode
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4, Color3 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import {
  PLANE_MODEL_SRC, PLANE_ENEMY_MODEL_SRC, PLANE_MODEL_YAW_OFFSET,
  MUZZLE_SIDE, MUZZLE_FORWARD, MUZZLE_FORWARD_MOBILE, MUZZLE_DOWN, ROCKET_MUZZLE_DOWN,
  MAX_HEALTH
} from '../shared/constants'
import { getFlightDirection, getBankAngle, getFlightMode, FlightMode, isRoundPaused } from './flight'
import { getLocalAddress, playerStates } from './serverLink'

const HIDDEN_Y = -400 // parking depth for hidden models (GLTF visibility toggling is unreliable)
export const BODY_LIFT = 1.0 // plane body sits ~1m above avatar feet

let localRoot: Entity | null = null

/** How fast a remote plane converges on its avatar (higher = tighter). */
const REMOTE_FOLLOW = 12
/** Beyond this the plane teleports instead of gliding (respawn, big correction). */
const REMOTE_SNAP_DISTANCE = 20

interface RemotePlane {
  root: Entity
  avatar: Entity // where its world position comes from
  /** Billboarded bar above the plane; see makeHealthBar. */
  label: Entity
  /** Its segments, left to right. */
  segments: Entity[]
  /** Last health painted, so the bar is only rewritten when it changes. */
  labelHealth: number
  renderPos: Vector3.MutableVector3
  lastPos: Vector3.MutableVector3
  dir: Vector3.MutableVector3
  seen: boolean
}
const remotePlanes = new Map<string, RemotePlane>()

/**
 * How far above the plane body the health bar floats.
 *
 * The plane's own half-height is 0.236, so this clears the canopy by about
 * three quarters of a metre — close enough to read as belonging to that plane
 * rather than hovering unattached above it, which 1.6 did.
 */
const LABEL_LIFT = 1.0
/** One segment, in metres, and the space between two of them. */
const SEG_WIDTH = 0.3
const SEG_HEIGHT = 0.1
const SEG_GAP = 0.07

/** The HUD's own colours, so the bar overhead reads as the same instrument. */
const SEG_FULL = Color4.create(0.2, 0.9, 0.35, 0.95)
const SEG_FULL_GLOW = Color3.create(0.15, 0.8, 0.3)
/**
 * Spent segments. Darker and far more opaque than the HUD's 15% white: that
 * works against a UI panel, but out in the cave a near-transparent segment
 * disappears and the bar stops reading as a bar with pieces missing.
 */
const SEG_EMPTY = Color4.create(0.1, 0.1, 0.12, 0.8)
const SEG_EMPTY_GLOW = Color3.create(0, 0, 0)

/**
 * The health bar that floats over an enemy plane — the HUD's segmented bar,
 * built out of quads in world space so it reads as the same instrument.
 *
 * Quads rather than block characters in a TextShape: a real bar needs no font
 * to support the glyphs, and each segment can be lit on its own.
 *
 * The BILLBOARD is on this parent and the segments are its children, so one
 * rotation turns the whole bar. All axes rather than the usual BM_Y: Y-only
 * keeps a label upright, which is right for a sign on the ground, but planes
 * fight above and below each other constantly and an upright bar goes edge-on —
 * invisible exactly when someone is diving on you. A camera-facing billboard is
 * worked out locally per viewer, so every pilot sees it turned toward
 * themselves.
 *
 * A CHILD of the plane root, so it travels with the plane and is parked out of
 * the world with it on death — no separate lifecycle to keep in step.
 */
function makeHealthBar(parent: Entity): { label: Entity; segments: Entity[] } {
  const label = engine.addEntity()
  Transform.create(label, { parent, position: Vector3.create(0, LABEL_LIFT, 0) })
  Billboard.create(label, { billboardMode: BillboardMode.BM_ALL })

  const segments: Entity[] = []
  const pitch = SEG_WIDTH + SEG_GAP
  // centred on the plane: the whole run is (MAX_HEALTH - 1) pitches wide
  const left = -((MAX_HEALTH - 1) * pitch) / 2
  for (let i = 0; i < MAX_HEALTH; i++) {
    const seg = engine.addEntity()
    Transform.create(seg, {
      parent: label,
      position: Vector3.create(left + i * pitch, 0, 0),
      scale: Vector3.create(SEG_WIDTH, SEG_HEIGHT, 1)
    })
    MeshRenderer.setPlane(seg)
    segments.push(seg)
  }
  return { label, segments }
}

/** Paint the bar for `health`. Emissive, so it holds up in an unlit cave. */
function paintHealthBar(segments: Entity[], health: number) {
  for (let i = 0; i < segments.length; i++) {
    const full = i < health
    Material.setPbrMaterial(segments[i], {
      albedoColor: full ? SEG_FULL : SEG_EMPTY,
      emissiveColor: full ? SEG_FULL_GLOW : SEG_EMPTY_GLOW,
      emissiveIntensity: full ? 1.5 : 0
    })
  }
}

/** Inverse of a unit quaternion (the math lib exposes no invert/conjugate). */
function conjugate(q: Quaternion): Quaternion {
  return Quaternion.create(-q.x, -q.y, -q.z, q.w)
}

/**
 * Local rotation that composes to `worldRotation` under `parent`.
 * The engine composes world = parent * local, so local = inverse(parent) * world.
 */
function localRotationUnder(parent: Entity, worldRotation: Quaternion): Quaternion {
  const parentTransform = Transform.getOrNull(parent)
  if (parentTransform === null) return worldRotation
  return Quaternion.multiply(conjugate(parentTransform.rotation), worldRotation)
}

/**
 * `parent` is engine.PlayerEntity for the local plane, or null for a remote one
 * (see the note at the top on why remote planes are not parented).
 *
 * `src` is passed in rather than inferred from `parent` so the two decisions
 * stay separate: what the plane is attached to, and which skin it wears.
 */
function createPlaneEntity(parent: Entity | null, src: string): Entity {
  const root = engine.addEntity()
  Transform.create(
    root,
    parent !== null
      ? { parent, position: Vector3.create(0, BODY_LIFT, 0) } // local offset on the avatar
      : { position: Vector3.create(0, HIDDEN_Y, 0) } // world space, placed each frame
  )
  const model = engine.addEntity()
  Transform.create(model, {
    parent: root,
    scale: Vector3.One(), // models are authored at true size - see constants.ts
    rotation: Quaternion.fromEulerDegrees(0, PLANE_MODEL_YAW_OFFSET, 0)
  })
  GltfContainer.create(model, {
    src,
    visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
    invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
  })
  return root
}

export function setupPlanes() {
  localRoot = createPlaneEntity(engine.PlayerEntity, PLANE_MODEL_SRC)
}

/**
 * The plane entity for an address, local or remote, for anything that has to
 * travel WITH a plane rather than sit at a fixed point — a looping engine sound,
 * say. Null while that plane has not been built yet.
 */
export function planeRootFor(address: string): Entity | null {
  const key = address.toLowerCase()
  // '' counts as local: the address is not known on the first frames, and the
  // local plane exists before it is.
  if (key === '' || key === getLocalAddress()) return localRoot
  const remote = remotePlanes.get(key)
  return remote !== undefined ? remote.root : null
}

/**
 * The local plane's root, for anything that has to be mounted ON the plane
 * rather than on the avatar.
 *
 * Its frame is the PLANE's: +Z is the flight direction and the roll is the
 * bank, both of which the avatar's own rotation is not. Hanging something off
 * the avatar instead puts it wherever the avatar happens to be facing, which
 * slides side to side through a turn as the two rotations diverge. Null until
 * setupPlanes has run.
 */
export function localPlaneRoot(): Entity | null {
  return localRoot
}

/** World position of the local plane body (avatar + lift). */
export function localPlanePosition(): Vector3 | null {
  const t = Transform.getOrNull(engine.PlayerEntity)
  if (t === null) return null
  return Vector3.create(t.position.x, t.position.y + BODY_LIFT, t.position.z)
}

/**
 * The plane's world rotation, bank included.
 *
 * Shared with the renderer below so the guns cannot drift away from the model
 * they are mounted on: the muzzles were built from the UN-banked rotation while
 * the visible plane was rolled, so in a hard turn the tracers left from beside
 * the wing rather than under it.
 */
export function planeWorldRotation(): Quaternion {
  const look = Quaternion.lookRotation(getFlightDirection(), Vector3.Up())
  const bankDeg = (getBankAngle() * 180) / Math.PI
  return Quaternion.multiply(look, Quaternion.fromEulerDegrees(0, 0, bankDeg))
}

/** Muzzle points for the weapons, derived from the plane pose. */
export function getMuzzles(): { left: Vector3; right: Vector3; under: Vector3 } | null {
  const pos = localPlanePosition()
  if (pos === null) return null
  const rot = planeWorldRotation()
  const right = Vector3.rotate(Vector3.Right(), rot)
  const forward = Vector3.rotate(Vector3.Forward(), rot)
  const up = Vector3.rotate(Vector3.Up(), rot)

  // A longer frame puts a bullet's first drawn position further past the gun,
  // so the gun starts further back to compensate. The choice lives here rather
  // than in constants.ts because that file is imported by the server, which has
  // no isMobile() to call - the same split as the sound levels in sfx.ts.
  const muzzleForward = isMobile() ? MUZZLE_FORWARD_MOBILE : MUZZLE_FORWARD

  // Offsets run along the PLANE's own axes, not the world's, so a muzzle stays
  // under its wing through a roll.
  const wing = (side: number) =>
    Vector3.create(
      pos.x + right.x * MUZZLE_SIDE * side + forward.x * muzzleForward - up.x * MUZZLE_DOWN,
      pos.y + right.y * MUZZLE_SIDE * side + forward.y * muzzleForward - up.y * MUZZLE_DOWN,
      pos.z + right.z * MUZZLE_SIDE * side + forward.z * muzzleForward - up.z * MUZZLE_DOWN
    )

  return {
    left: wing(-1),
    right: wing(1),
    under: Vector3.create(
      pos.x - up.x * ROCKET_MUZZLE_DOWN,
      pos.y - up.y * ROCKET_MUZZLE_DOWN,
      pos.z - up.z * ROCKET_MUZZLE_DOWN
    )
  }
}

/**
 * World positions of every live remote plane (for hit detection). Read from the
 * avatar entity, because the plane Transform is parent-relative now.
 */
export function remotePlanePositions(): { address: string; position: Vector3; dir: Vector3 }[] {
  const list: { address: string; position: Vector3; dir: Vector3 }[] = []
  for (const [address, plane] of remotePlanes) {
    const state = playerStates.get(address)
    if (state !== undefined && !state.alive) continue
    const t = Transform.getOrNull(plane.avatar)
    if (t !== null) {
      list.push({
        address,
        position: Vector3.create(t.position.x, t.position.y + BODY_LIFT, t.position.z),
        // the smoothed heading the model is already turned to, so anything hung
        // off the tail sits where the tail looks like it is
        dir: Vector3.clone(plane.dir)
      })
    }
  }
  return list
}

/**
 * Where THIS client currently sees a given pilot's plane, local or remote.
 */
export function planePosition(address: string): Vector3 | null {
  const key = address.toLowerCase()
  if (key === getLocalAddress()) return localPlanePosition()
  const plane = remotePlanes.get(key)
  if (plane === undefined) return null
  const t = Transform.getOrNull(plane.avatar)
  if (t === null) return null
  return Vector3.create(t.position.x, t.position.y + BODY_LIFT, t.position.z)
}

export function planesSystem(dt: number) {
  // ── local plane ──
  if (localRoot !== null) {
    const t = Transform.getMutable(localRoot)
    const mode = getFlightMode()
    // no plane in the lobby either - you are watching, not flying - and none
    // between rounds, where the plane is frozen and has nothing to show
    if (mode === FlightMode.DEAD || mode === FlightMode.LOBBY || isRoundPaused()) {
      t.position.y = HIDDEN_Y
    } else {
      t.position.y = BODY_LIFT
      t.rotation = localRotationUnder(engine.PlayerEntity, planeWorldRotation())
    }
  }

  // ── remote planes ──
  for (const plane of remotePlanes.values()) plane.seen = false

  const local = getLocalAddress()
  for (const [avatarEntity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    const address = identity.address.toLowerCase()
    if (address === local || avatarEntity === engine.PlayerEntity) continue
    const avatarTransform = Transform.getOrNull(avatarEntity)
    if (avatarTransform === null) continue

    const target = Vector3.create(
      avatarTransform.position.x,
      avatarTransform.position.y + BODY_LIFT,
      avatarTransform.position.z
    )

    let plane = remotePlanes.get(address)
    // Recreate if the avatar entity for this address changed (rejoin, recycled
    // slot), so the plane never tracks a dead entity.
    if (plane !== undefined && plane.avatar !== avatarEntity) {
      engine.removeEntityWithChildren(plane.root)
      remotePlanes.delete(address)
      plane = undefined
    }
    if (plane === undefined) {
      // every other pilot is a target: red skin, same mesh
      const root = createPlaneEntity(null, PLANE_ENEMY_MODEL_SRC)
      const bar = makeHealthBar(root)
      plane = {
        root,
        avatar: avatarEntity,
        label: bar.label,
        segments: bar.segments,
        labelHealth: -1, // nothing painted yet
        renderPos: Vector3.clone(target),
        lastPos: Vector3.clone(avatarTransform.position),
        dir: Vector3.create(0, 0, 1),
        seen: true
      }
      remotePlanes.set(address, plane)
    }
    plane.seen = true

    // heading from movement delta, smoothed
    const delta = Vector3.subtract(avatarTransform.position, plane.lastPos)
    const deltaLen = Vector3.length(delta)
    if (deltaLen > 0.05) {
      const dir = Vector3.scale(delta, 1 / deltaLen)
      const blend = Math.min(1, 5 * dt)
      plane.dir.x += (dir.x - plane.dir.x) * blend
      plane.dir.y += (dir.y - plane.dir.y) * blend
      plane.dir.z += (dir.z - plane.dir.z) * blend
      const len = Vector3.length(plane.dir)
      if (len > 0.001) {
        plane.dir.x /= len
        plane.dir.y /= len
        plane.dir.z /= len
      }
    }
    plane.lastPos = Vector3.clone(avatarTransform.position)

    // Ease toward the avatar rather than snapping to it: the remote transform
    // arrives at comms rate, so following it verbatim reproduces those steps.
    const gap = Vector3.distance(plane.renderPos, target)
    if (gap > REMOTE_SNAP_DISTANCE) {
      plane.renderPos = Vector3.clone(target) // respawn or teleport, do not glide
    } else {
      const blend = 1 - Math.exp(-REMOTE_FOLLOW * dt)
      plane.renderPos.x += (target.x - plane.renderPos.x) * blend
      plane.renderPos.y += (target.y - plane.renderPos.y) * blend
      plane.renderPos.z += (target.z - plane.renderPos.z) * blend
    }

    const t = Transform.getMutable(plane.root)
    const state = playerStates.get(address)

    // Repainted only when the number actually changes — this runs every frame
    // for every plane in the sky, and MAX_HEALTH material writes per plane per frame would be for nothing between hits.
    const health = state !== undefined ? state.health : MAX_HEALTH
    if (health !== plane.labelHealth) {
      plane.labelHealth = health
      paintHealthBar(plane.segments, health)
    }

    if (isRoundPaused() || (state !== undefined && !state.alive)) {
      // destroyed, or the round is over — hidden until it comes back
      t.position.y = HIDDEN_Y
    } else {
      // world space, so the rotation is the world rotation — no counter-rotation
      t.position = plane.renderPos
      t.rotation = Quaternion.lookRotation(plane.dir, Vector3.Up())
    }
  }

  // cleanup planes for players who left
  for (const [address, plane] of remotePlanes) {
    if (!plane.seen) {
      engine.removeEntityWithChildren(plane.root)
      remotePlanes.delete(address)
    }
  }
}
