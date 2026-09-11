// BattleZone client — flight controller.
//
// The hidden avatar IS the plane's physics body: movement input is frozen with
// InputModifier, and a continuous Physics force steers the avatar's velocity
// toward wherever the camera points (a velocity servo + gravity compensation).
// Remote players see us because avatar positions replicate natively.
//
// Players arrive in the LOBBY - out of play - and press
// PLAY to launch. From there the plane auto-circles the city top until the
// player's first input (camera swing or any key), then the camera takes over.

import {
  engine, Transform, InputModifier, InputAction, PointerEventType, inputSystem, Physics
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'
import { room } from '../shared/messages'
import {
  CENTER_X, CENTER_Z, CEILING_Y, FLOOR_Y, BOUNDS_MARGIN, SCENE_SIZE,
  FLIGHT_BASE_SPEED, FLIGHT_DIVE_BONUS, FLIGHT_MIN_SPEED, FLIGHT_MAX_SPEED,
  FLIGHT_TURN_FREE_RATE, FLIGHT_TURN_BLEED, FLIGHT_TURN_MIN, FLIGHT_TURN_RECOVER,
  FLIGHT_ACCEL_GAIN, FLIGHT_GRAVITY_COMP, FLIGHT_MAX_FORCE, FLIGHT_CLIMB_ASSIST,
  FLIGHT_DEAD_BRAKE_GAIN,
  FLIGHT_BOOST_MULTIPLIER,
  TERRAIN_GRIND_SPEED,
  TERRAIN_GRIND_COMMAND,
  TERRAIN_GRIND_DELAY,
  TERRAIN_GRIND_INTERVAL,
  FLIGHT_BOOST_SPOOL,
  FLIGHT_BOOST_DECAY,
  CIRCLE_ALTITUDE, CIRCLE_RADIUS, CIRCLE_SPEED, FIRST_INPUT_ANGLE_DEG,
  LOBBY_VIEW_X, LOBBY_VIEW_Y, LOBBY_VIEW_Z, LOBBY_LOOK_X, LOBBY_LOOK_Y, LOBBY_LOOK_Z,
  LOBBY_HOLD_GAIN, LOBBY_HOLD_MAX_SPEED, LOBBY_SNAP_DISTANCE, LOBBY_SNAP_COOLDOWN
} from '../shared/constants'
import { myState, canSend } from './serverLink'
import { isBoosting } from './boost'

export enum FlightMode {
  BOOTING, // waiting for the initial teleport into the sky
  CIRCLING, // auto-flying circles until the first input
  CONTROL, // player steers with the camera
  DEAD, // plane destroyed, waiting for respawn
  LOBBY // out of play, watching the map from above
}

let mode: FlightMode = FlightMode.BOOTING
export function getFlightMode(): FlightMode {
  return mode
}

const forceOwner = engine.addEntity()

// measured avatar velocity (position deltas), smoothed for the plane model
const velocity: Vector3.MutableVector3 = Vector3.Zero()
const smoothedDir: Vector3.MutableVector3 = Vector3.create(0, 0, 1)
let prevPos: Vector3.MutableVector3 | null = null
let bankAngle = 0
let prevYaw = 0

export function getFlightVelocity(): Vector3.ReadonlyVector3 {
  return velocity
}
export function getFlightDirection(): Vector3.ReadonlyVector3 {
  return smoothedDir
}
export function getBankAngle(): number {
  return bankAngle
}

/**
 * The boost multiplier as it actually stands, which is NOT the same as whether
 * the button is down: holding it winds this up to full over FLIGHT_BOOST_SPOOL,
 * releasing it winds back down to 1 over FLIGHT_BOOST_DECAY. Both are constant
 * RATES, so a burn that never reached full does not take a full run-out to
 * fade either — a tap costs and gives proportionally.
 *
 * Re-pressing mid-run-out resumes the climb from wherever it had got to, which
 * neither punishes nor rewards feathering the button.
 */
let boostFactor = 1

/**
 * The turn-bleed factor, on the same pattern as boostFactor: a multiplier on
 * commanded speed that hard turning drives down and level flight winds back up.
 *
 * Kept separate from the burn rather than folded into it because they run out
 * differently — a turn is paid for once and recovered from in a second or so,
 * while a burn keeps costing banked boost for as long as it is held.
 */
let turnFactor = 1
/** Last frame's aim, for measuring how far the nose swept. */
let prevAim: Vector3 | null = null

// camera baseline for first-input detection
let baselineForward: Vector3 | null = null
let baselineGrace = 0 // seconds to wait after teleport before capturing baseline
let teleporting = false
let wasAlive = true
/** Rate limit on lobby re-teleports; see LOBBY_SNAP_DISTANCE. */
let lobbySnapCooldown = 0

// ── flying into the rock ──
//
// How long the plane has been going nowhere while asking to move, and how many
// hits that has been reported for. Both reset the moment it comes free, so a
// pilot who scrapes a wall and flies on owes nothing.
let grindSeconds = 0
let grindReported = 0

// ── round pause ──
//
// Scoring stops between rounds, so the planes stop with it: frozen where the
// round ended and hidden, rather than still circling over the scoreboard.
//
// Held as a DEADLINE, not a flag. `roundStarted` is what normally lifts it, but
// a dropped message would otherwise leave the player frozen for good — the
// intermission length the server sent is the failsafe. Same two-source shape as
// the scoreboard panel, and for the same reason.
let pauseEndsAtMs = 0

/** From the roundEnded message; `durationMs` is what is LEFT of the pause. */
export function beginRoundPause(durationMs: number) {
  pauseEndsAtMs = Date.now() + durationMs
}

/** From the roundStarted message — play resumes now, whatever the deadline said. */
export function endRoundPause() {
  pauseEndsAtMs = 0
}

/** True while the round is over and the next one has not started. */
export function isRoundPaused(): boolean {
  return pauseEndsAtMs > 0 && Date.now() < pauseEndsAtMs
}

export function setupFlight() {
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: true })
  })
  // Everyone starts in the lobby; the server keeps them out of play until they
  // press PLAY, and the flip to `inLobby: false` is what launches them.
  enterLobby()
}

function circleEntryPoint(): Vector3 {
  const angle = Math.random() * Math.PI * 2
  return Vector3.create(
    CENTER_X + Math.cos(angle) * CIRCLE_RADIUS,
    CIRCLE_ALTITUDE,
    CENTER_Z + Math.sin(angle) * CIRCLE_RADIUS
  )
}

/**
 * Where the pending teleport is headed. BOOTING is shared by both destinations,
 * and a failed teleport is retried — without this the retry would always come
 * back into the sky, launching a player who asked for the lobby.
 */
let bootDestination: 'sky' | 'lobby' = 'lobby'

/**
 * Park at the lobby vantage point, camera aimed down at the terrain.
 *
 * The lobby reuses the flight body rather than a VirtualCamera: the avatar is
 * already frozen and hidden, so teleporting it above the map and holding it
 * there gives the overhead view for free, and leaves the player free to swing
 * the camera and look around the battle.
 */
function enterLobby() {
  if (teleporting) return
  teleporting = true
  bootDestination = 'lobby'
  mode = FlightMode.BOOTING
  Physics.removeForceFromPlayer(forceOwner)
  void movePlayerTo({
    newRelativePosition: Vector3.create(LOBBY_VIEW_X, LOBBY_VIEW_Y, LOBBY_VIEW_Z),
    cameraTarget: Vector3.create(LOBBY_LOOK_X, LOBBY_LOOK_Y, LOBBY_LOOK_Z)
  })
    .then(() => {
      teleporting = false
      mode = FlightMode.LOBBY
      boostFactor = 1 // no run-out carried into the lobby
      turnFactor = 1
      prevAim = null // the teleport swings the view; that is not a turn flown
      velocity.x = 0
      velocity.y = 0
      velocity.z = 0
      prevPos = null
    })
    .catch(() => {
      teleporting = false // stay in BOOTING; flightSystem retries shortly
      skyRetryTimer = 1.5
    })
}

function enterSky() {
  if (teleporting) return
  teleporting = true
  bootDestination = 'sky'
  mode = FlightMode.BOOTING
  // No force while the teleport is in flight — the hold force from the wreck
  // must not follow the respawned plane to its entry point.
  Physics.removeForceFromPlayer(forceOwner)
  const entry = circleEntryPoint()
  void movePlayerTo({
    newRelativePosition: entry,
    cameraTarget: Vector3.create(CENTER_X, CIRCLE_ALTITUDE - 20, CENTER_Z)
  })
    .then(() => {
      teleporting = false
      mode = FlightMode.CIRCLING
      boostFactor = 1 // a respawn launches at cruise, not on someone's old burn
      turnFactor = 1
      prevAim = null
      baselineForward = null
      baselineGrace = 0.5 // let the camera settle before sampling the baseline
      velocity.x = 0
      velocity.y = 0
      velocity.z = 0
      prevPos = null
    })
    .catch(() => {
      teleporting = false // stay in BOOTING; flightSystem retries shortly
      skyRetryTimer = 1.5
    })
}
let skyRetryTimer = 0

function cameraForward(): Vector3 | null {
  const cam = Transform.getOrNull(engine.CameraEntity)
  if (cam === null) return null
  return Vector3.rotate(Vector3.Forward(), cam.rotation)
}

function anyControlInput(): boolean {
  const actions = [
    InputAction.IA_PRIMARY, InputAction.IA_SECONDARY, InputAction.IA_POINTER,
    InputAction.IA_JUMP, InputAction.IA_FORWARD, InputAction.IA_BACKWARD,
    InputAction.IA_LEFT, InputAction.IA_RIGHT
  ]
  for (const action of actions) {
    if (inputSystem.isTriggered(action, PointerEventType.PET_DOWN)) return true
  }
  return false
}

export function flightSystem(dt: number) {
  if (dt <= 0) return
  const playerTransform = Transform.getOrNull(engine.PlayerEntity)
  if (playerTransform === null) return
  const pos = playerTransform.position

  // ── measure avatar velocity from position deltas ──
  if (prevPos !== null && dt > 0.0001) {
    velocity.x = (pos.x - prevPos.x) / dt
    velocity.y = (pos.y - prevPos.y) / dt
    velocity.z = (pos.z - prevPos.z) / dt
  }
  prevPos = Vector3.clone(pos)

  // smoothed heading for the plane model
  const speed = Vector3.length(velocity)
  if (speed > 2) {
    const dir = Vector3.normalize(velocity)
    const blend = Math.min(1, 6 * dt)
    smoothedDir.x += (dir.x - smoothedDir.x) * blend
    smoothedDir.y += (dir.y - smoothedDir.y) * blend
    smoothedDir.z += (dir.z - smoothedDir.z) * blend
    const len = Vector3.length(smoothedDir)
    if (len > 0.001) {
      smoothedDir.x /= len
      smoothedDir.y /= len
      smoothedDir.z /= len
    }
  }

  // visual banking from yaw rate
  const yaw = Math.atan2(smoothedDir.x, smoothedDir.z)
  let yawDelta = yaw - prevYaw
  if (yawDelta > Math.PI) yawDelta -= Math.PI * 2
  if (yawDelta < -Math.PI) yawDelta += Math.PI * 2
  prevYaw = yaw
  const targetBank = Math.max(-0.9, Math.min(0.9, -(yawDelta / dt) * 0.35))
  bankAngle += (targetBank - bankAngle) * Math.min(1, 4 * dt)

  // ── lobby / death / respawn transitions (server-authoritative) ──
  // The server owns all three: it flips inLobby when a switch countdown fires
  // and alive on death and respawn. Nothing here is decided locally, so a
  // client cannot put itself back in the air early.
  const state = myState()
  if (state !== null) {
    const lobbyHere = mode === FlightMode.LOBBY || (mode === FlightMode.BOOTING && bootDestination === 'lobby')
    if (state.inLobby && !lobbyHere) {
      enterLobby()
    } else if (!state.inLobby && lobbyHere) {
      enterSky() // PLAY granted — into the circle
    } else if (!state.inLobby) {
      // ordinary combat death and respawn, only meaningful while in play
      if (!state.alive && wasAlive) {
        mode = FlightMode.DEAD
        // The force stays on: see the DEAD branch of the desired-velocity block.
      }
      if (state.alive && !wasAlive) enterSky()
    }
    wasAlive = state.alive
  }

  if (mode === FlightMode.BOOTING) {
    // the initial teleport can fail while the scene is still loading — retry
    if (!teleporting) {
      skyRetryTimer -= dt
      if (skyRetryTimer <= 0) {
        if (bootDestination === 'lobby') enterLobby()
        else enterSky()
      }
    }
    return
  }

  // ── first-input handover ──
  if (mode === FlightMode.CIRCLING) {
    if (baselineGrace > 0) {
      baselineGrace -= dt
    } else {
      const forward = cameraForward()
      if (forward !== null) {
        if (baselineForward === null) {
          baselineForward = forward
        } else {
          const dot = Math.max(-1, Math.min(1, Vector3.dot(forward, baselineForward)))
          const angleDeg = (Math.acos(dot) * 180) / Math.PI
          if (angleDeg > FIRST_INPUT_ANGLE_DEG) mode = FlightMode.CONTROL
        }
      }
      if (anyControlInput()) mode = FlightMode.CONTROL
    }
  }

  // ── boost wind-up and run-out ──
  // Stepped every frame, not inside the CONTROL branch, so the run-out keeps
  // going while the button is up and there is nothing to re-trigger it.
  if (isBoosting()) {
    boostFactor = Math.min(
      FLIGHT_BOOST_MULTIPLIER,
      boostFactor + ((FLIGHT_BOOST_MULTIPLIER - 1) * dt) / FLIGHT_BOOST_SPOOL
    )
  } else if (boostFactor > 1) {
    boostFactor = Math.max(1, boostFactor - ((FLIGHT_BOOST_MULTIPLIER - 1) * dt) / FLIGHT_BOOST_DECAY)
  }

  // ── turn bleed ──
  //
  // Measured off the AIM rather than off the velocity: the aim is the command,
  // and charging for the swing the moment it is made is what makes the plane
  // come out of a flip slow. Reading it back off the velocity would charge for
  // the turn a beat after the servo had already flown it.
  //
  // Only counted in CONTROL. The circle flies itself and the lobby is not
  // flying at all, so neither should be able to run up a debt, and prevAim is
  // dropped with every teleport so the jump in view that comes with one is not
  // read as a turn.
  const aim = cameraForward()
  const swept =
    mode === FlightMode.CONTROL && aim !== null && prevAim !== null && dt > 0.0001
      ? Math.acos(Math.max(-1, Math.min(1, Vector3.dot(aim, prevAim))))
      : 0
  const hard = swept - FLIGHT_TURN_FREE_RATE * dt
  if (hard > 0) turnFactor = Math.max(FLIGHT_TURN_MIN, turnFactor - hard * FLIGHT_TURN_BLEED)
  else turnFactor = Math.min(1, turnFactor + FLIGHT_TURN_RECOVER * dt)
  prevAim = mode === FlightMode.CONTROL ? aim : null

  // ── desired velocity ──
  let desired: Vector3.MutableVector3
  if (mode === FlightMode.LOBBY) {
    const offX = LOBBY_VIEW_X - pos.x
    const offY = LOBBY_VIEW_Y - pos.y
    const offZ = LOBBY_VIEW_Z - pos.z
    const off = Math.sqrt(offX * offX + offY * offY + offZ * offZ)
    lobbySnapCooldown = Math.max(0, lobbySnapCooldown - dt)

    if (off > LOBBY_SNAP_DISTANCE) {
      // Properly out of place — teleport back rather than fly, and the teleport
      // restores the look down over the city along with the position.
      if (lobbySnapCooldown === 0 && !teleporting) {
        lobbySnapCooldown = LOBBY_SNAP_COOLDOWN
        enterLobby()
        return
      }
      // Waiting on that teleport: stand still. Setting off for the vantage
      // point here is exactly the travel the snap exists to remove.
      desired = Vector3.Zero()
    } else {
      // Within arm's reach of the spot: hold the point itself, not merely a
      // standstill — over an open-ended stay the residual sink of a velocity
      // hold would walk the view down into the city. Speed-capped so a
      // correction stays gentle.
      desired = Vector3.create(offX * LOBBY_HOLD_GAIN, offY * LOBBY_HOLD_GAIN, offZ * LOBBY_HOLD_GAIN)
      const wanted = Vector3.length(desired)
      if (wanted > LOBBY_HOLD_MAX_SPEED) {
        const scale = LOBBY_HOLD_MAX_SPEED / wanted
        desired.x *= scale
        desired.y *= scale
        desired.z *= scale
      }
    }
  } else if (mode === FlightMode.DEAD) {
    // Hold station where the plane went down. The camera rides the avatar, so
    // dropping the force here (as this used to) let gravity take it and the
    // death view slid all the way to the street. Servoing to a standstill
    // instead keeps the vantage point of the kill for the whole countdown, and
    // the gravity compensation below is what stops it sinking.
    desired = Vector3.Zero()
  } else if (isRoundPaused()) {
    // Frozen where the round ended. Servoed to a standstill rather than left
    // unforced for the same reason as DEAD: the camera rides the avatar, so
    // cutting the force would sink the view to the street over the pause.
    desired = Vector3.Zero()
  } else if (mode === FlightMode.CONTROL) {
    const forward = aim
    if (forward === null) return
    // dive faster, climb slower — nose direction modulates speed
    let flightSpeed = FLIGHT_BASE_SPEED + -forward.y * FLIGHT_DIVE_BONUS
    flightSpeed = Math.max(FLIGHT_MIN_SPEED, Math.min(FLIGHT_MAX_SPEED, flightSpeed))
    // After the clamp, so a burn genuinely beats the cruise ceiling. The factor
    // is 1 when no burn is running or running out, so this is a no-op then.
    //
    // The burn multiplies what the plane can do UP TO CRUISE; whatever a dive
    // adds on top of cruise is added at face value rather than multiplied along
    // with it. Multiplying the lot meant a nose-down burn was worth
    // 2.25 x 8 = 18 m/s of dive bonus as well as 2.25 x the cruise, so the dive
    // ran away with the burn - 45 m/s against 27 level. It is worth the same
    // 8 m/s boosted as unboosted now, for 35.
    //
    // Both terms are the identity when boostFactor is 1, so level, diving and
    // climbing without a burn are untouched - and so is a boosted CLIMB, where
    // the trim is negative and the whole of the (clamped) speed is cruise.
    const cruisePart = Math.min(flightSpeed, FLIGHT_BASE_SPEED)
    const divePart = Math.max(0, flightSpeed - FLIGHT_BASE_SPEED)
    flightSpeed = cruisePart * boostFactor + divePart
    // The turn charge lands on top of the burn, so a flip costs a boosted plane
    // the most — it has the most speed to lose. Floored at the slowest the
    // plane flies rather than at the factor alone: below that it is not turning
    // hard, it is falling.
    flightSpeed = Math.max(FLIGHT_MIN_SPEED, flightSpeed * turnFactor)
    desired = Vector3.scale(forward, flightSpeed)
  } else {
    // CIRCLING: fly the ring, correcting radius + altitude drift
    const rx = pos.x - CENTER_X
    const rz = pos.z - CENTER_Z
    const radius = Math.max(0.001, Math.sqrt(rx * rx + rz * rz))
    const tangent = Vector3.create(-rz / radius, 0, rx / radius)
    const radialError = CIRCLE_RADIUS - radius // positive = drift outward wanted
    desired = Vector3.create(
      tangent.x * CIRCLE_SPEED + (rx / radius) * radialError * 0.4,
      Math.max(-4, Math.min(4, (CIRCLE_ALTITUDE - pos.y) * 0.5)),
      tangent.z * CIRCLE_SPEED + (rz / radius) * radialError * 0.4
    )
  }

  // ── soft bounds: steer back inside the scene ──
  const margin = BOUNDS_MARGIN
  if (pos.x < margin) desired.x += (margin - pos.x) * 3
  if (pos.x > SCENE_SIZE - margin) desired.x -= (pos.x - (SCENE_SIZE - margin)) * 3
  if (pos.z < margin) desired.z += (margin - pos.z) * 3
  if (pos.z > SCENE_SIZE - margin) desired.z -= (pos.z - (SCENE_SIZE - margin)) * 3
  if (pos.y > CEILING_Y) desired.y = Math.min(desired.y, -(pos.y - CEILING_Y) * 2)
  if (pos.y < FLOOR_Y + 4) desired.y = Math.max(desired.y, (FLOOR_Y + 4 - pos.y) * 2)

  // ── velocity servo + gravity compensation ──
  const holding = mode === FlightMode.DEAD || mode === FlightMode.LOBBY || isRoundPaused()
  const gain = holding ? FLIGHT_DEAD_BRAKE_GAIN : FLIGHT_ACCEL_GAIN
  const force = Vector3.create(
    (desired.x - velocity.x) * gain,
    (desired.y - velocity.y) * gain + FLIGHT_GRAVITY_COMP,
    (desired.z - velocity.z) * gain
  )
  // Climb assist: only the shortfall between commanded and actual climb is
  // boosted, so this adds nothing in level flight, nothing in a dive, and
  // nothing on clients whose gravity the base servo already overcomes.
  const climbShortfall = Math.max(0, desired.y - velocity.y)
  force.y += climbShortfall * FLIGHT_CLIMB_ASSIST

  const magnitude = Vector3.length(force)
  if (magnitude > FLIGHT_MAX_FORCE) {
    const scale = FLIGHT_MAX_FORCE / magnitude
    force.x *= scale
    force.y *= scale
    force.z *= scale
  }
  Physics.applyForceToPlayer(forceOwner, force)

  // ── pressed against the terrain? ──
  //
  // Commanding speed and measuring almost none means something solid is in the
  // way. Checked here rather than earlier because `desired` is only settled at
  // this point, and it is the comparison BETWEEN the two that carries the
  // meaning — either number alone is just a plane flying slowly.
  const commanded = Vector3.length(desired)
  const measured = Vector3.length(velocity)
  const flyingNow = mode === FlightMode.CONTROL || mode === FlightMode.CIRCLING
  const alive = state !== null && state.alive && !state.inLobby
  const jammed =
    flyingNow && alive && !isRoundPaused() && commanded > TERRAIN_GRIND_COMMAND && measured < TERRAIN_GRIND_SPEED

  if (!jammed) {
    grindSeconds = 0
    grindReported = 0
    return
  }

  grindSeconds += dt
  // First hit at TERRAIN_GRIND_DELAY, then one per interval after it. A while
  // rather than an if, so a frame long enough to cross two boundaries still
  // owes two — the server's rate limit refuses the extra anyway, but the count
  // here should not silently fall behind.
  while (grindSeconds >= TERRAIN_GRIND_DELAY + grindReported * TERRAIN_GRIND_INTERVAL) {
    grindReported += 1
    if (canSend()) room.send('reportTerrainHit', { t: Date.now() })
  }
}
