// BattleZone client — gameplay sound.

import { engine, Transform, Entity, AudioSource } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import { Vector3 } from '@dcl/sdk/math'
import {
  SOUND_BULLET_SHOT,
  SOUND_ROCKET_SHOT,
  SOUND_IMPACT,
  SOUND_IMPACT_PC_SPATIAL,
  SOUND_COLLECT,
  SOUND_PLANE_IDLE,
  SOUND_BOOST,
  SOUND_ROUND_END,
  SOUND_ROUND_START,
  SFX_SHOT_VOLUME,
  SFX_IMPACT_VOLUME,
  SFX_COLLECT_VOLUME,
  SFX_ROUND_END_VOLUME,
  SFX_ROUND_START_VOLUME,
  ENGINE_IDLE_VOLUME,
  ENGINE_IDLE_VOLUME_PC,
  SFX_IMPACT_VOLUME_PC_SPATIAL,
  SFX_COLLECT_VOLUME_PC_MINE,
  SFX_ROUND_END_VOLUME_PC,
  ENGINE_BOOST_VOLUME
} from '../shared/constants'
import { planeRootFor } from './planes'
import { isRoundPaused } from './flight'
import { getLocalAddress, playerStates, myState } from './serverLink'
import { isBoosting } from './boost'

/** Parking depth for an idle one-shot, matching the convention in planes.ts. */
const HIDDEN_Y = -400

// ── the desktop mix ──
//
// Mobile keeps the tuned values throughout; only PC diverges, and only for the
// three that were wrong there. Written as functions because isMobile() cannot be answered at module load.

/** Louder on PC only when it has distance to cross. */
const impactVolume = (mine: boolean) =>
  isMobile() || mine ? SFX_IMPACT_VOLUME : SFX_IMPACT_VOLUME_PC_SPATIAL

const impactClip = (mine: boolean) =>
  isMobile() || mine ? SOUND_IMPACT : SOUND_IMPACT_PC_SPATIAL

/** Louder on PC only when it is your own — theirs are already right. */
const collectVolume = (mine: boolean) =>
  isMobile() || !mine ? SFX_COLLECT_VOLUME : SFX_COLLECT_VOLUME_PC_MINE

/** Quieter on PC, for every plane: the clip itself sits hot in a desktop mix. */
const idleVolume = () => (isMobile() ? ENGINE_IDLE_VOLUME : ENGINE_IDLE_VOLUME_PC)

/** Quieter on PC. The start sting is unchanged — only the end one was hot. */
const roundEndVolume = () => (isMobile() ? SFX_ROUND_END_VOLUME : SFX_ROUND_END_VOLUME_PC)

/**
 * One-shot voices. Every simultaneous sound needs its own entity, because a
 * retrigger restarts the clip on that entity rather than layering — a volley landing on two planes at once would otherwise cut itself off.
 */
const VOICE_COUNT = 12

interface Voice {
  entity: Entity
  /** When it is free again; a retrigger before then would cut the clip short. */
  busyUntilMs: number
}
const voices: Voice[] = []
let nextVoice = 0

/**
 * The round stings get their own entity rather than a voice from the pool,
 * because they are the only sounds here that are `global` — no falloff, no
 * position. A pooled voice is spatial and would fade with distance from
 * wherever it happened to be parked.
 *
 * One entity serves both: they are a round apart and can never overlap, so a
 * second would be an idle duplicate.
 */
let announcerVoice: Entity = engine.RootEntity

/** Longest of the clips, so a voice is not reused while it is still sounding. */
const VOICE_BUSY_MS = 900

interface EngineLoop {
  idle: Entity
  boost: Entity
  /** What was last written to each, so a steady plane costs no writes at all. */
  idleOn: boolean
  boostOn: boolean
}
/** address (lowercased, '' for the local plane) -> its two loops. */
const engines = new Map<string, EngineLoop>()

export function setupSfx() {
  for (let i = 0; i < VOICE_COUNT; i++) {
    const entity = engine.addEntity()
    Transform.create(entity, { position: Vector3.create(0, HIDDEN_Y, 0) })
    // Created up front and silent. playSound needs the component to exist —
    // it returns false on an entity without one.
    AudioSource.create(entity, { audioClipUrl: SOUND_IMPACT, playing: false, loop: false })
    voices.push({ entity, busyUntilMs: 0 })
  }

  announcerVoice = engine.addEntity()
  Transform.create(announcerVoice, { position: Vector3.create(0, HIDDEN_Y, 0) })
  AudioSource.create(announcerVoice, {
    audioClipUrl: SOUND_ROUND_END,
    playing: false,
    loop: false,
    volume: roundEndVolume(),
    global: true // heard the same by everyone, wherever they are on the map
  })
}

/**
 * The next voice to use: a free one, else the oldest busy one. Round-robin from
 * where the last search stopped, so a burst spreads across the pool instead of hammering slot 0.
 */
function takeVoice(): Voice {
  const now = Date.now()
  for (let i = 0; i < VOICE_COUNT; i++) {
    const voice = voices[(nextVoice + i) % VOICE_COUNT]
    if (voice.busyUntilMs <= now) {
      nextVoice = (nextVoice + i + 1) % VOICE_COUNT
      return voice
    }
  }
  const voice = voices[nextVoice]
  nextVoice = (nextVoice + 1) % VOICE_COUNT
  return voice
}

/**
 * Play `clip` at a place. `attachTo` parents the voice to a plane so the sound
 * travels with it; without it the voice sits at the world position, which is
 * what a terrain hit wants — the terrain is not going anywhere.
 *
 * `mine` makes it non-spatial, for the same reason the local engine loops are:
 * the camera is the listener, and a cave wall shoving it closer to your own
 * plane would otherwise be heard as your own guns getting louder. Your sounds
 * are yours, not a point in the world. Everyone else's stay spatial, where
 * distance says something worth knowing.
 */
function playAt(clip: string, volume: number, position: Vector3, attachTo: Entity | null, mine: boolean) {
  const voice = takeVoice()
  voice.busyUntilMs = Date.now() + VOICE_BUSY_MS
  Transform.createOrReplace(
    voice.entity,
    attachTo !== null
      ? { parent: attachTo, position: Vector3.Zero() }
      : { position: Vector3.clone(position) }
  )
  // playSound first: it rewrites the component, so anything set before it could
  // be discarded. That includes `global`, which is why a pooled voice has to be
  // told every time rather than once at creation.
  AudioSource.playSound(voice.entity, clip)
  const source = AudioSource.getMutableOrNull(voice.entity)
  if (source !== null) {
    source.volume = volume
    source.global = mine
  }
}

/** Guns, from the shooter's plane so the sound tracks them as they fly on. */
export function playShot(weapon: string, position: Vector3, shooter: string) {
  playAt(
    weapon === 'rocket' ? SOUND_ROCKET_SHOT : SOUND_BULLET_SHOT,
    SFX_SHOT_VOLUME,
    position,
    planeRootFor(shooter),
    shooter.toLowerCase() === getLocalAddress()
  )
}

/**
 * Bullet, rocket and drone impacts. Pass the victim's address to hang the sound
 * on their plane; pass '' for terrain, walls and anything else that does not
 * move, and it stays where it went off.
 */
export function playImpact(position: Vector3, victim: string, attachToPlane: boolean = true) {
  // Hits on YOU go global. Spatially the source is your own plane, which the
  // camera sits a few metres off and much closer than that in a tight spot —
  // so the one impact you least want overwhelming you was the loudest of them
  // all. Everyone else's stay spatial: where a blast came from is worth hearing, and distance is how you know.
  const mine = victim !== '' && victim.toLowerCase() === getLocalAddress()
  // A global voice ignores position entirely, so it needs no parent. Anything
  // else rides the victim's plane, unless the caller says not to — a wreck is parked out of the world the same frame it blows up.
  const attachTo = mine || !attachToPlane || victim === '' ? null : planeRootFor(victim)
  playAt(impactClip(mine), impactVolume(mine), position, attachTo, mine)
}

/** Either sting, at the same volume for everyone wherever they are. */
function announce(clip: string, volume: number) {
  AudioSource.playSound(announcerVoice, clip)
  const source = AudioSource.getMutableOrNull(announcerVoice)
  if (source !== null) {
    // playSound rewrites the whole component, so both have to be re-asserted —
    // without this the second round plays at the defaults, spatial and at 1.
    source.volume = volume
    source.global = true
  }
}

/** The sting over the scoreboard. */
export function playRoundEnd() {
  announce(SOUND_ROUND_END, roundEndVolume())
}

/** The one that starts the fighting, under the FIGHT banner. */
export function playRoundStart() {
  announce(SOUND_ROUND_START, SFX_ROUND_START_VOLUME)
}

/** A crate being taken, heard by everyone. Yours plays flat, theirs from the crate. */
export function playCollect(position: Vector3, collector: string) {
  const mine = collector.toLowerCase() === getLocalAddress()
  playAt(SOUND_COLLECT, collectVolume(mine), position, null, mine)
}

/** Build the pair of loops for a plane, mounted on it. Both start stopped. */
function engineFor(key: string, root: Entity): EngineLoop {
  const existing = engines.get(key)
  if (existing !== undefined) return existing

  // YOUR OWN engine is not a point in the world
  const mine = key === ''

  const idle = engine.addEntity()
  Transform.create(idle, { parent: root, position: Vector3.Zero() })
  AudioSource.create(idle, {
    audioClipUrl: SOUND_PLANE_IDLE,
    playing: false,
    loop: true,
    volume: idleVolume(),
    global: mine
  })

  const boost = engine.addEntity()
  Transform.create(boost, { parent: root, position: Vector3.Zero() })
  AudioSource.create(boost, {
    audioClipUrl: SOUND_BOOST,
    playing: false,
    loop: true,
    volume: ENGINE_BOOST_VOLUME,
    global: mine
  })

  const made: EngineLoop = { idle, boost, idleOn: false, boostOn: false }
  engines.set(key, made)
  return made
}

/**
 * Start or stop a loop, writing only on a change.
 *
 * `playing` is set directly rather than through playSound/stopSound: those
 * rewrite the whole component and would take `loop` with it. The value here
 * genuinely alternates, so it is not the unchanged-value case that CRDT dedup swallows.
 */
function setLoop(entity: Entity, on: boolean) {
  const source = AudioSource.getMutableOrNull(entity)
  if (source === null) return
  source.playing = on
}

/** Idle runs whenever the plane is in play; boost layers over it during a burn. */
function drive(loop: EngineLoop, flying: boolean, boosting: boolean) {
  const wantBoost = flying && boosting
  if (loop.idleOn !== flying) {
    loop.idleOn = flying
    setLoop(loop.idle, flying)
  }
  if (loop.boostOn !== wantBoost) {
    loop.boostOn = wantBoost
    setLoop(loop.boost, wantBoost)
  }
}

export function sfxSystem() {
  const local = getLocalAddress()
  // Between rounds every plane is parked out of sight and every pilot is held
  // still, so no engine should be running either. PlayerState still says alive
  // and in play right through the intermission - it is the round that stopped,
  // not the pilots - which is why this is asked of the round rather than read
  // off the state, exactly as planes.ts asks it before hiding the models.
  const paused = isRoundPaused()

  // ── your own plane: the burn is read off the button, not off the network ──
  const mine = myState()
  const localRoot = planeRootFor(local)
  if (localRoot !== null && mine !== null) {
    const loop = engineFor('', localRoot)
    drive(loop, mine.alive && !mine.inLobby && !paused, isBoosting())
  }

  // ── everyone else: off PlayerState.boosting, the same flag the trail uses ──
  
  // Driven from playerStates rather than the list of VISIBLE planes: a dead pilot drops out of that list, and rebuilding two entities and two
  // AudioSources on every respawn is churn for nothing. Muting holds the loop  in place until they actually leave.
  for (const [address, state] of playerStates) {
    if (address === local) continue
    const root = planeRootFor(address)
    if (root === null) continue
    const loop = engineFor(address, root)
    drive(loop, state.alive && !state.inLobby && !paused, state.boosting)
  }

  // ── players who left: drop the loops with them ──
  for (const [key, loop] of engines) {
    if (key === '' || playerStates.has(key)) continue
    engine.removeEntity(loop.idle)
    engine.removeEntity(loop.boost)
    engines.delete(key)
  }
}
