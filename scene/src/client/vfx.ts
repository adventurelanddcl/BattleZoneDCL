// BattleZone client — explosion / hit VFX.

import {
  engine, Transform, Entity, ParticleSystem, MeshRenderer, Material,
  PBParticleSystem_BlendMode
} from '@dcl/sdk/ecs'
import { Vector3, Color4, Color3 } from '@dcl/sdk/math'

interface Vfx {
  emitter: Entity
  sphere: Entity
  ttl: number
  age: number
  maxScale: number
}

const POOL_SIZE = 16
const PUFF_POOL_SIZE = 6
const PUFF_LIFE = 0.7

interface Puff {
  entity: Entity
  ttl: number
}
const puffs: Puff[] = []

/** What each crate throws off. The three are far enough apart to read at speed. */
function puffColors(kind: string): { start: Color4; end: Color4 } {
  if (kind === 'rockets') {
    return { start: Color4.create(1, 0.92, 0.25, 1), end: Color4.create(1, 0.7, 0.05, 0) } // yellow
  }
  if (kind === 'boost') {
    return { start: Color4.create(0.55, 0.85, 1, 1), end: Color4.create(0.1, 0.4, 1, 0) } // blue
  }
  return { start: Color4.create(1, 0.6, 0.15, 1), end: Color4.create(1, 0.25, 0.02, 0) } // orange
}
const pool: Vfx[] = []

export function setupVfx() {
  for (let i = 0; i < POOL_SIZE; i++) {
    const emitter = engine.addEntity()
    Transform.create(emitter, { position: Vector3.create(0, -500, 0) })
    const sphere = engine.addEntity()
    Transform.create(sphere, { position: Vector3.create(0, -500, 0), scale: Vector3.Zero() })
    MeshRenderer.setSphere(sphere)
    Material.setPbrMaterial(sphere, {
      albedoColor: Color4.create(1, 0.55, 0.1, 0.8),
      emissiveColor: Color3.create(1, 0.4, 0.05),
      emissiveIntensity: 4
    })
    pool.push({ emitter, sphere, ttl: 0, age: 0, maxScale: 1 })
  }

  for (let i = 0; i < PUFF_POOL_SIZE; i++) {
    const entity = engine.addEntity()
    Transform.create(entity, { position: Vector3.create(0, -500, 0) })
    puffs.push({ entity, ttl: 0 })
  }
}

/** A free puff slot, or whichever is closest to finishing. */
function takePuff(): Puff {
  for (const puff of puffs) {
    if (puff.ttl <= 0) return puff
  }
  let oldest = puffs[0]
  for (const puff of puffs) {
    if (puff.ttl < oldest.ttl) oldest = puff
  }
  return oldest
}

/**
 * A crate being taken, thrown off the plane that took it.
 */
export function collectPuff(kind: string, plane: Entity | null, at: Vector3) {
  const puff = takePuff()
  puff.ttl = PUFF_LIFE
  Transform.createOrReplace(
    puff.entity,
    plane !== null ? { parent: plane, position: Vector3.Zero() } : { position: Vector3.clone(at) }
  )
  const colors = puffColors(kind)
  ParticleSystem.createOrReplace(puff.entity, {
    rate: 0,
    loop: false,
    lifetime: 0.55,
    maxParticles: 24,
    bursts: { values: [{ time: 0, count: 14, cycles: 1, interval: 0.01, probability: 1 }] },
    // Thrown outward off the body, not dropped: the plane is moving, and a spray that stays put reads as debris rather than as a pickup.
    shape: ParticleSystem.Shape.Sphere({ radius: 0.5 }),
    initialVelocitySpeed: { start: 1.5, end: 3.5 },
    initialSize: { start: 0.12, end: 0.22 },
    sizeOverTime: { start: 1, end: 0.1 },
    colorOverTime: colors,
    // PSB_ADD is 1, not 2 — 2 is PSB_MULTIPLY, which DARKENS against whateveris behind it. Named rather than numbered so the value cannot drift from what the comment claims
    blendMode: PBParticleSystem_BlendMode.PSB_ADD,
    gravity: 0
  })
}

/** A free slot, or - if every one is busy - whichever is closest to finishing. */
function takeSlot(): Vfx {
  for (const vfx of pool) {
    if (vfx.ttl <= 0) return vfx
  }
  let oldest = pool[0]
  for (const vfx of pool) {
    if (vfx.ttl < oldest.ttl) oldest = vfx
  }
  return oldest
}

/** One-shot explosion. size ~1 for hit sparks, ~3 for drones, ~5 for planes. */
export function explode(position: Vector3, size: number) {
  const vfx = takeSlot()
  vfx.ttl = 1.6
  vfx.age = 0
  vfx.maxScale = size

  Transform.getMutable(vfx.emitter).position = Vector3.clone(position)
  const sphereTransform = Transform.getMutable(vfx.sphere)
  sphereTransform.position = Vector3.clone(position)
  sphereTransform.scale = Vector3.create(0.2, 0.2, 0.2)

  ParticleSystem.createOrReplace(vfx.emitter, {
    rate: 0,
    loop: false,
    lifetime: 1.2,
    maxParticles: 80,
    bursts: { values: [{ time: 0, count: Math.min(80, 25 * size), cycles: 1, interval: 0.01, probability: 1 }] },
    initialVelocitySpeed: { start: 3 * size, end: 7 * size },
    initialSize: { start: 0.15 * size, end: 0.4 * size },
    sizeOverTime: { start: 1, end: 0.1 },
    gravity: 0.3,
    colorOverTime: {
      start: Color4.create(1, 0.7, 0.2, 1),
      end: Color4.create(0.4, 0.1, 0.05, 0)
    },
    blendMode: 2,
    shape: ParticleSystem.Shape.Sphere({ radius: 0.3 * size })
  })
}

export function vfxSystem(dt: number) {
  for (const puff of puffs) {
    if (puff.ttl <= 0) continue
    puff.ttl -= dt
    if (puff.ttl > 0) continue
    ParticleSystem.deleteFrom(puff.entity)
    Transform.createOrReplace(puff.entity, { position: Vector3.create(0, -500, 0) })
  }

  for (const vfx of pool) {
    if (vfx.ttl <= 0) continue
    vfx.age += dt
    vfx.ttl -= dt

    // shockwave sphere: quick expand + collapse in the first 0.45s
    const t = vfx.age / 0.45
    const sphereTransform = Transform.getMutable(vfx.sphere)
    if (t < 1) {
      const scale = vfx.maxScale * 1.6 * Math.sin(Math.min(1, t) * Math.PI)
      sphereTransform.scale = Vector3.create(scale, scale, scale)
    } else {
      sphereTransform.scale = Vector3.Zero()
    }

    if (vfx.ttl <= 0) {
      sphereTransform.position.y = -500
      Transform.getMutable(vfx.emitter).position.y = -500
      // Drop the spent system rather than leaving it to be overwritten.
      ParticleSystem.deleteFrom(vfx.emitter)
    }
  }
}
