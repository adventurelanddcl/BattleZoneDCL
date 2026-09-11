// BattleZone client — bootstrap. Terrain model, scene-wide avatar hiding, forced
// third-person camera, mobile touch controls, message handlers and the single per-frame system that drives every client module.

import {
  engine, Transform, GltfContainer, ColliderLayer, AvatarModifierArea, AvatarModifierType,
  CameraModeArea, CameraType, TouchScreenControls, InputAction
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { getPlayer, onEnterScene, onLeaveScene } from '@dcl/sdk/players'
import { room } from '../shared/messages'
import { TERRAIN_MODEL_SRC, CENTER_X, CENTER_Z, SCENE_SIZE, RESPAWN_COOLDOWN_MS } from '../shared/constants'
import {
  setLocalAddress, getLocalAddress, playerNames, displayName,
  serverLinkSystem, myState, canSend, getRespawnRemainingMs
} from './serverLink'
import { setupFlight, flightSystem, beginRoundPause, endRoundPause } from './flight'
import { setupPlanes, planesSystem, planePosition } from './planes'
import { setupWeapons, weaponsSystem } from './weapons'
import { setupDrones, dronesSystem } from './drones'
import { setupPickups, pickupsSystem, setupDrops, dropsSystem } from './pickups'
import { boostSystem } from './boost'
import { leaderboardSystem } from './leaderboard'
import { setupVfx, vfxSystem, explode } from './vfx'
import { setupBoostTrail, boostTrailSystem } from './boostTrail'
import { setupUi, uiStateSystem, uiState, showBanner } from './ui'
import { showRoundScoreboard, hideRoundScoreboard } from './roundSummary'
import { ScoreRow } from '../shared/stats'
import { showDamageIndicator, clearDamageIndicator } from './damageIndicator'
import { pushKill, clearKillFeed } from './killFeed'
import { setupSfx, sfxSystem, playImpact, playRoundEnd, playRoundStart } from './sfx'
import { setupSpectate, spectateSystem } from './spectate'

export async function setupClient(): Promise<void> {
  console.log('[CLIENT] BattleZone client starting...')

  // ── terrain ──
  // The model is centred on its own origin, so placing it at the scene centre
  // lines its 160 m footprint up with the parcels exactly.
  const terrain = engine.addEntity()
  Transform.create(terrain, { position: Vector3.create(CENTER_X, 0, CENTER_Z) })
  GltfContainer.create(terrain, {
    src: TERRAIN_MODEL_SRC,
    // The model ships its own `_collider` mesh - a plain copy of the ground -
    // so collision comes off THAT and the visible meshes carry none. Without
    // the split, the glowing wireframe would be physics geometry too, and planes would collide with the lines.
    visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
    invisibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
  })

  // ── everyone's avatar is hidden — you are your plane ──
  const hideArea = Vector3.create(SCENE_SIZE, 180, SCENE_SIZE)
  const modifierArea = engine.addEntity()
  AvatarModifierArea.create(modifierArea, {
    area: hideArea,
    modifiers: [AvatarModifierType.AMT_HIDE_AVATARS, AvatarModifierType.AMT_DISABLE_PASSPORTS],
    excludeIds: []
  })
  Transform.create(modifierArea, { position: Vector3.create(CENTER_X, 70, CENTER_Z), scale: hideArea })

  // ── consistent third-person aiming everywhere ──
  const cameraArea = engine.addEntity()
  Transform.create(cameraArea, { position: Vector3.create(CENTER_X, 70, CENTER_Z) })
  CameraModeArea.create(cameraArea, {
    area: Vector3.create(CENTER_X * 2, 160, CENTER_Z * 2),
    mode: CameraType.CT_THIRD_PERSON
  })

  // ── mobile: no walking joystick, big button = guns (safe no-op on desktop) ──
  TouchScreenControls.createOrReplace(engine.RootEntity, {
    // Every native button is hidden. The native gamepad offers no way to size
    // or stack its buttons (only hide / main-action / icon), so the scene draws
    // its own equal-sized column instead - see ActionButtons in ui.tsx.
    touchInputs: [
      { inputAction: InputAction.IA_POINTER, hide: true },
      { inputAction: InputAction.IA_PRIMARY, hide: true },
      { inputAction: InputAction.IA_SECONDARY, hide: true },
      { inputAction: InputAction.IA_JUMP, hide: true },
      { inputAction: InputAction.IA_ACTION_3, hide: true },
      { inputAction: InputAction.IA_ACTION_4, hide: true },
      { inputAction: InputAction.IA_ACTION_5, hide: true },
      { inputAction: InputAction.IA_ACTION_6, hide: true }
    ],
    // Kept pointing at the guns as a fallback, in case a client still draws the
    // large central button despite its action being hidden.
    mainAction: InputAction.IA_PRIMARY,
    hideJoystick: true,
    hideCrosshair: true // we draw our own crosshair
  })

  // ── identity + name book ──
  const local = getPlayer()
  if (local) {
    setLocalAddress(local.userId)
    if (local.name) playerNames.set(local.userId.toLowerCase(), local.name)
  }
  onEnterScene((player) => {
    if (player.name) playerNames.set(player.userId.toLowerCase(), player.name)
  })
  onLeaveScene((userId) => {
    playerNames.delete(userId.toLowerCase())
  })

  // ── modules ──
  setupVfx()
  setupSfx()
  setupPlanes()
  setupSpectate()
  setupBoostTrail() // mounts on the plane root, so it has to come after
  setupDrones()
  setupPickups()
  setupDrops()
  setupWeapons()
  setupFlight()
  setupUi()

  registerMessageHandlers()

  // ── the one engine system driving all client modules ──
  let respawnAskCooldown = 0
  engine.addSystem((dt: number) => {
    try {
      // getPlayer() can be null on the very first frames — keep retrying
      if (getLocalAddress() === '') {
        const me = getPlayer()
        if (me) {
          setLocalAddress(me.userId)
          if (me.name) playerNames.set(me.userId.toLowerCase(), me.name)
        }
      }
      serverLinkSystem(dt)
      flightSystem(dt)
      planesSystem(dt)
      weaponsSystem(dt)
      dronesSystem(dt)
      pickupsSystem(dt)
      dropsSystem(dt)
      boostSystem(dt)
      // after planesSystem, so it follows the plane poses set this frame
      spectateSystem(dt)
      sfxSystem() // engine loops start and stop here
      boostTrailSystem() // after boostSystem, so the burn state is this frame's
      leaderboardSystem()
      vfxSystem(dt)
      uiStateSystem(dt)

      // auto-rejoin once the 10s cooldown is over. Not for a player sitting in
      // the lobby, or one on their way to it — they are out of play on purpose,
      // and only PLAY brings them back.
      respawnAskCooldown = Math.max(0, respawnAskCooldown - dt)
      const state = myState()
      if (
        state !== null && !state.alive && !state.inLobby && state.switchAtMs === 0 &&
        getRespawnRemainingMs() <= 0 &&
        respawnAskCooldown <= 0 && canSend()
      ) {
        respawnAskCooldown = 1
        room.send('requestSpawn', { t: Date.now() })
      }
    } catch (err) {
      console.error('[CLIENT] system error:', err)
    }
  })

  console.log('[CLIENT] BattleZone ready')
}

function registerMessageHandlers() {
  room.onMessage('hitConfirmed', (data) => {
    // Drawn where THIS client sees the victim now, not at the coordinates in
    // the message - those are the shooter's already-lagged view of the victim,
    // delayed again by the server hop. See planePosition().
    const hitAt = planePosition(data.victimId) ?? Vector3.create(data.x, data.y, data.z)
    explode(hitAt, 1)
    // Rockets are skipped: detonateRocket already sounded the burst, and a
    // splash across three planes would otherwise fire the same clip four times.
    if (data.weapon !== 'rocket') playImpact(hitAt, data.victimId)
    if (data.victimId.toLowerCase() === getLocalAddress()) {
      showDamageIndicator() // red border pulse around the screen edge
    }
    if (data.attackerId.toLowerCase() === getLocalAddress()) {
      uiState.killFlash = 1 // hit marker pulse on the crosshair
    }
  })

  room.onMessage('planeDestroyed', (data) => {
    const wreckAt = planePosition(data.victimId) ?? Vector3.create(data.x, data.y, data.z)
    explode(wreckAt, 5)
    // The victim IS named, so a pilot's own destruction plays global rather than
    // deafening them from point blank — but attaching is refused, because
    // planes.ts parks a destroyed plane at y=-400 on this very frame and a
    // sound parented to it would be dragged down there mid-blast.
    playImpact(wreckAt, data.victimId, false)
    // Everyone's feed, off the broadcast everyone already receives.
    pushKill(data.attackerId, data.victimId, data.cause)
    const me = getLocalAddress()
    if (data.victimId.toLowerCase() === me) {
      clearDamageIndicator()
      if (data.cause === 'terrain') {
        showBanner(`Flew into the rock!`, 5)
      } else {
        const who = data.attackerId !== '' ? displayName(data.attackerId) : 'a drone'
        showBanner(`Shot down by ${who}!`, 5)
      }
    } else if (data.attackerId.toLowerCase() === me) {
      showBanner(`You shot down ${displayName(data.victimId)}!`, 4)
    }
  })

  room.onMessage('roundStarted', (data) => {
    // Belt and braces: the scoreboard runs on a local timer, and this drops it
    // the moment play actually resumes.
    hideRoundScoreboard()
    clearKillFeed() // last round's kills do not belong over this one
    endRoundPause() // planes back, controls live
    playRoundStart()
    showBanner(`Fight!`, 5)
  })

  room.onMessage('roundEnded', (data) => {
    // No banner. The scoreboard panel IS the round-over announcement — it names
    // the winner at the top of its own list — and a second one laid over it said
    // the same thing twice.
    // Before the parse: a malformed board must not leave the planes flying.
    beginRoundPause(data.intermissionMs)
    playRoundEnd()
    try {
      const board = JSON.parse(data.scoreboardJson) as ScoreRow[]
      showRoundScoreboard(board, data.intermissionMs)
    } catch {
      // the pause is already set above, so a bad board costs the standings and
      // nothing else
    }
  })

  room.onMessage('denied', (data) => {
    console.log('[CLIENT] server denied action:', data.reason)
  })
}
