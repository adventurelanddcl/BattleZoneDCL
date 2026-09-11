// BattleZone client — the blue trail behind a burning plane.
//
// Every plane in the sky gets one, the local plane included: the local burn is
// read straight off the button so it starts on the same frame the speed does,
// and remote burns off PlayerState.boosting, which the server publishes for
// exactly this (no client can see another client's keypress).

import {
  engine,
  Transform,
  Entity,
  ParticleSystem,
  PBParticleSystem_BlendMode,
  PBParticleSystem_SimulationSpace
} from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { isBoosting } from './boost'
import { remotePlanePositions, localPlaneRoot } from './planes'
import { getLocalAddress, playerStates } from './serverLink'

/** Parking depth for an unassigned emitter, matching the convention in planes.ts. */
const HIDDEN_Y = -400

/**
 * How far behind the plane the local emitter sits, along the plane's own -Z —
 * the tail, where the engine is. It needs to clear the model and no more, since
 * it no longer compensates for any lag or drift: plane reaches 1.017 m
 * back from its centre, so 1.5 leaves the same margin 1.2 left on the model before it.
 */
const TRAIL_BACK = 1.5
/** Remote emitters are placed in world space, along the flight line. */
const REMOTE_TRAIL_BACK = 2.0

/**
 * Lifetime sets the LENGTH of the trail: on PSS_WORLD the particles stay where
 * they were born, so the tail reaches back speed x lifetime
 */
const TRAIL_LIFETIME = 0.9
/** Particles per second. rate x lifetime = ~32 live per burning plane. */
const TRAIL_RATE = 35
/** Ceiling per emitter, so one plane can never eat the scene budget. */
const TRAIL_MAX_PARTICLES = 48

/**
 * Remote emitters, so seven other planes can trail at once alongside yours.
 * Eight in total hold ~256 live particles, about a quarter of the scene budget,
 * which leaves room for several explosions at the same time.
 */
const POOL_SIZE = 7

interface TrailEmitter {
  entity: Entity
  /** Address of the plane it follows, '' for the local one, null if free. */
  owner: string | null
  emitting: boolean
}
const pool: TrailEmitter[] = []

/** Rides the avatar, so it never falls behind the plane. Local plane only. */
let localEmitter: TrailEmitter | null = null

function createEmitter(parented: boolean): TrailEmitter {
  const entity = engine.addEntity()
  // The plane root is itself a child of engine.PlayerEntity, so the engine still
  // composes this pose every rendered frame — the mount only changes WHICH
  // rotation the offset is measured in, from the avatar's to the plane's.
  const planeRoot = parented ? localPlaneRoot() : null
  Transform.create(
    entity,
    planeRoot !== null
      ? { parent: planeRoot, position: Vector3.create(0, 0, -TRAIL_BACK) }
      : { position: Vector3.create(0, HIDDEN_Y, 0) }
  )
  ParticleSystem.create(entity, {
      active: false, // switched on when a plane claims this emitter
      rate: TRAIL_RATE,
      lifetime: TRAIL_LIFETIME,
      maxParticles: TRAIL_MAX_PARTICLES,
      // Left behind in world space rather than carried along — see the note at
      // the top. Without this there is no trail.
      simulationSpace: PBParticleSystem_SimulationSpace.PSS_WORLD,
      // A tight spawn ball and barely any speed of their own: the line is drawn
      // by the plane's motion, so anything else here only smears it into a cone.
      shape: ParticleSystem.Shape.Sphere({ radius: 0.12 }),
      initialVelocitySpeed: { start: 0.2, end: 0.8 },
      initialSize: { start: 0.18, end: 0.34 },
      sizeOverTime: { start: 1, end: 0.15 },
      // Alpha reaching 0 is what actually fades a particle out; the shrink above only shapes the taper.
      colorOverTime: {
        start: Color4.create(0.7, 0.93, 1, 1), 
        end: Color4.create(0.1, 0.4, 1, 0) 
      },
      blendMode: PBParticleSystem_BlendMode.PSB_ADD, // glow, and it stacks
    gravity: 0 // exhaust hangs where it was left; it does not fall
  })
  return { entity, owner: null, emitting: false }
}

export function setupBoostTrail() {
  localEmitter = createEmitter(true)
  for (let i = 0; i < POOL_SIZE; i++) pool.push(createEmitter(false))
}

/** The emitter already following `owner`, or a free one, or null if all are busy. */
function emitterFor(owner: string): TrailEmitter | null {
  for (const emitter of pool) {
    if (emitter.owner === owner) return emitter
  }
  for (const emitter of pool) {
    if (emitter.owner === null) return emitter
  }
  return null
}

function setEmitting(emitter: TrailEmitter, on: boolean) {
  if (emitter.emitting === on) return
  emitter.emitting = on
  // `active`, not playbackState: this stops NEW particles and lets the ones in
  // the air finish, so a released burn leaves its tail hanging where it was.
  ParticleSystem.getMutable(emitter.entity).active = on
}

/** Put a remote plane's emitter on its tail and switch it on. */
function trailFor(owner: string, position: Vector3, dir: Vector3) {
  const emitter = emitterFor(owner)
  if (emitter === null) return
  emitter.owner = owner
  Transform.getMutable(emitter.entity).position = Vector3.create(
    position.x - dir.x * REMOTE_TRAIL_BACK,
    position.y - dir.y * REMOTE_TRAIL_BACK,
    position.z - dir.z * REMOTE_TRAIL_BACK
  )
  setEmitting(emitter, true)
}

export function boostTrailSystem() {
  const burning = new Set<string>()

  // ── local plane: straight off the button, no round trip ──
  // Nothing to position: the emitter is carried on the avatar, so it is already
  // wherever the plane is. Only the burn has to be switched on and off.
  if (localEmitter !== null) setEmitting(localEmitter, isBoosting())

  // ── everyone else: off the flag the server publishes ──
  const local = getLocalAddress()
  for (const plane of remotePlanePositions()) {
    if (plane.address === local) continue
    const state = playerStates.get(plane.address)
    if (state === undefined || !state.boosting) continue
    burning.add(plane.address)
    trailFor(plane.address, plane.position, plane.dir)
  }

  // ── release anyone who stopped burning, died or left ──
  for (const emitter of pool) {
    if (emitter.owner === null || burning.has(emitter.owner)) continue
    setEmitting(emitter, false)
    emitter.owner = null
    // Parking the emitter does not drag the trail down with it: those particles
    // live in world space and stay where they were laid until they expire.
    Transform.getMutable(emitter.entity).position.y = HIDDEN_Y
  }
}
