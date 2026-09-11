// BattleZone client — the lobby player spectator camera.

import {
  engine, Transform, Entity, VirtualCamera, MainCamera,
  Raycast, RaycastResult, RaycastQueryType, ColliderLayer
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { SCENE_SIZE, FLOOR_Y, CEILING_Y } from '../shared/constants'
import { inLobby, displayName } from './serverLink'
import { remotePlanePositions } from './planes'

/** How far behind and above the watched plane the camera sits, at most. */
const CHASE_BACK = 7
const CHASE_UP = 2.2

/**
 * How close to the rock the camera is allowed to end up when it has to pull in.
 * Stopping exactly at the hit puts the near plane inside the surface and you
 * see through it anyway.
 */
const WALL_CLEARANCE = 0.8
/** Never closer than this, or the camera ends up inside the plane it is watching. */
const MIN_CHASE_BACK = 1.5
/**
 * How fast the chase distance moves, in metres per second.
 */
const CHASE_EASE = 14

/**
 * Kept this far inside the parcels. The engine switches a VirtualCamera OFF
 * once it leaves scene bounds, and a plane flying at the wall would otherwise
 * drag the camera out behind it and blank the view at the worst moment.
 */
const BOUNDS_KEEP_IN = 3

/** The overview: the lobby's own vantage point, with no override at all. */
const OVERVIEW = ''
export const OVERVIEW_LABEL = 'OVERVIEW CAMERA'

/** Address being watched, or OVERVIEW. */
let watching: string = OVERVIEW
let camera: Entity = engine.RootEntity
/**
 * Casts backwards from the watched plane, so the camera can be pulled in shortof anything solid.
 */
let ray: Entity = engine.RootEntity
/** Current chase distance, eased toward whatever the rock allows. */
let chaseBack = CHASE_BACK
/** Whether MainCamera is currently pointed at our camera. */
let active = false

export function setupSpectate() {
  camera = engine.addEntity()
  Transform.create(camera, { position: Vector3.create(SCENE_SIZE / 2, CEILING_Y / 2, SCENE_SIZE / 2) })
  // No config: the Transform is driven every frame, so a transition would fight
  // the follow rather than smooth it.
  VirtualCamera.create(camera, {})

  ray = engine.addEntity()
  Transform.create(ray, { position: Vector3.create(SCENE_SIZE / 2, CEILING_Y / 2, SCENE_SIZE / 2) })
  // Created ONCE, and aimed by rotating the entity rather than by rewriting the
  // component. `continuous` means the engine re-casts it every frame from wherever the entity now is
  Raycast.create(ray, {
    direction: { $case: 'localDirection', localDirection: Vector3.create(0, 0, 1) },
    maxDistance: CHASE_BACK,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: true,
    collisionMask: ColliderLayer.CL_PHYSICS
  })
}

/**
 * Everyone worth watching, in a STABLE order.
 *
 * Sorted by address rather than left in map order, so the arrows always step the same way and a pilot dying does not reshuffle who is next.
 */
function watchable(): string[] {
  return remotePlanePositions()
    .map((plane) => plane.address)
    .sort()
}

/**
 * Is there anybody to watch? False in an empty round, or one where everyone is
 * sitting in the lobby — the arrows have nowhere to step and say so.
 */
export function spectateAvailable(): boolean {
  return watchable().length > 0
}

/** OVERVIEW_LABEL, or the name of whoever is being watched. */
export function spectateLabel(): string {
  if (watching === OVERVIEW) return OVERVIEW_LABEL
  return displayName(watching)
}

/** Step through [overview, ...pilots]. Wraps both ways. */
export function cycleSpectate(step: number) {
  const list = watchable()
  // The overview is one entry ahead of the pilots, so the ring is list.length+1
  const ring = list.length + 1
  const current = watching === OVERVIEW ? 0 : list.indexOf(watching) + 1
  // indexOf is -1 when whoever was being watched has gone; that lands on 0,
  // which is the overview, and is the right place to be sent back to.
  const next = (((current === 0 ? 0 : current) + step) % ring + ring) % ring
  watching = next === 0 ? OVERVIEW : list[next - 1]
}

/** Drop the override and go back to the overview. */
function release() {
  watching = OVERVIEW
  chaseBack = CHASE_BACK // next pilot starts at full distance
  if (!active) return
  active = false
  const main = MainCamera.getMutableOrNull(engine.CameraEntity)
  if (main !== null) main.virtualCameraEntity = undefined
}

export function spectateSystem(dt: number) {
  // Flying means the camera is yours again — spectating is a lobby-only thing.
  if (!inLobby()) {
    release()
    return
  }
  if (watching === OVERVIEW) {
    if (active) release()
    return
  }

  const plane = remotePlanePositions().find((p) => p.address === watching)
  if (plane === undefined) {
    // They died, left, or went to the lobby themselves. Back to the overview rather than freezing on an empty patch of sky.
    release()
    return
  }

  // Behind and a little above, looking the way they are flying — what that
  // pilot sees, from just outside their own cockpit.
  const dir = plane.dir

  // The ray rides the plane and points BACKWARDS along its flight line — the
  // same line the camera wants to sit on. Only the Transform is touched; the cast itself was set up once.
  const rayT = Transform.getMutable(ray)
  rayT.position = Vector3.clone(plane.position)
  rayT.rotation = Quaternion.lookRotation(Vector3.create(-dir.x, -dir.y, -dir.z), Vector3.Up())

  // Full distance unless something is actually nearer than that.
  let wanted = CHASE_BACK
  const result = RaycastResult.getOrNull(ray)
  if (result !== null && result.hits.length > 0) {
    const room = result.hits[0].length - WALL_CLEARANCE
    if (room < CHASE_BACK) wanted = Math.max(MIN_CHASE_BACK, room)
  }

  // Eased, not snapped: the cast flickers between hit and no-hit as the plane moves, and following that verbatim reads as the camera stuttering.
  const step = CHASE_EASE * dt
  if (chaseBack < wanted) chaseBack = Math.min(wanted, chaseBack + step)
  else if (chaseBack > wanted) chaseBack = Math.max(wanted, chaseBack - step)

  const pos = Vector3.create(
    plane.position.x - dir.x * chaseBack,
    plane.position.y - dir.y * chaseBack + CHASE_UP,
    plane.position.z - dir.z * chaseBack
  )
  const t = Transform.getMutable(camera)
  t.position = Vector3.create(
    Math.max(BOUNDS_KEEP_IN, Math.min(SCENE_SIZE - BOUNDS_KEEP_IN, pos.x)),
    Math.max(FLOOR_Y + 1, Math.min(CEILING_Y - 1, pos.y)),
    Math.max(BOUNDS_KEEP_IN, Math.min(SCENE_SIZE - BOUNDS_KEEP_IN, pos.z))
  )
  t.rotation = Quaternion.lookRotation(dir, Vector3.Up())

  if (!active) {
    active = true
    // createOrReplace on the first activation: MainCamera may not exist yet and getMutable would throw.
    MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: camera })
  }
}
