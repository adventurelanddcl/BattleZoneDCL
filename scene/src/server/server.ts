// BattleZone — authoritative server. Owns rounds, player health/ammo, drone AI
// and pickups. Clients only ever *request*; every state change is validated and
// applied here, then reaches clients via synced components + messages.

import { engine, AvatarBase } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import {
  RoundState,
  ServerHeartbeat,
  PickupState,
  PlayerState,
  DroneState,
  DropState,
  LeaderboardState
} from '../shared/components'
import { room } from '../shared/messages'
import {
  ROUND_LENGTH_MS,
  INTERMISSION_MS,
  SCOREBOARD_MAX_ROWS,
  ROUND_START_BULLETS,
  ROUND_START_ROCKETS,
  ROUND_START_BOOST_MS,
  MAX_HEALTH,
  BULLET_DAMAGE,
  ROCKET_DAMAGE,
  TERRAIN_GRIND_DAMAGE,
  RESPAWN_COOLDOWN_MS,
  LOBBY_TRANSITION_MS,
  BULLETS_PER_VOLLEY,
  ACTION_OVERLAP_MS,
  BULLET_RANGE,
  ROCKET_RANGE,
  HIT_VALIDATION_SLACK,
  DRONE_COUNT,
  DRONE_HP,
  DRONE_SPEED,
  DRONE_IDLE_SPEED,
  DRONE_TURN_RATE,
  DRONE_EXPLODE_RADIUS,
  DRONE_CHASE_SPEED,
  DRONE_AGGRO_RADIUS,
  DRONE_GIVE_UP_DISTANCE,
  DRONE_MAX_LEASH,
  DRONE_PATROL_RADIUS,
  DRONE_PATROL_PERIOD_MS,
  DRONE_SEPARATION,
  DRONE_SEPARATION_FORCE,
  DRONE_MIN_GAP,
  DRONE_SEPARATION_PASSES,
  DRONE_DAMAGE,
  DRONE_RESPAWN_MS,
  DRONE_MIN_Y,
  DRONE_MAX_Y,
  DRONE_SYNC_INTERVAL,
  PICKUP_SPOTS,
  withinPickupRange,
  PICKUP_SERVER_SLACK,
  PICKUP_RESPAWN_MS,
  PICKUP_BULLET_AMOUNT,
  PICKUP_ROCKET_AMOUNT,
  BOOST_PICKUP_MS,
  MAX_DROPS,
  DROP_SPACING,
  DROP_KIND_BULLETS,
  DROP_KIND_ROCKETS,
  DROP_KIND_BOOST,
  HEARTBEAT_INTERVAL_MS,
  SyncIds,
  CENTER_X,
  CENTER_Z
} from '../shared/constants'
import { EVENT_CONFIG_POLL_MS, RoundPlayerRecord, ScoreRow } from '../shared/stats'
import {
  leaderboardView,
  loadLeaderboard,
  refreshEvents,
  loadPlayerTotals,
  noteName,
  markParticipant,
  displayNameFor,
  recordRound,
  refreshPublished,
  noteCollected,
  collectedFor
} from './leaderboard'
import {
  playerEntities,
  avatarEntities,
  getPlayerPosition,
  getPlayerState,
  refreshAvatarMap,
  drones,
  pickups,
  isRateLimited,
  roundInfo,
  DRONE_SPAWNS,
  boostingSince,
  weaponLock,
  drops
} from './serverState'

/** The board published at the last round end; empty while a round is running. */
let lastScoreboard: ScoreRow[] = []

let roundEntity = engine.RootEntity
let heartbeatEntity = engine.RootEntity
let pickupEntity = engine.RootEntity
let leaderboardEntity = engine.RootEntity
let publishedLeaderboardVersion = -1

export async function setupServer(): Promise<void> {
  console.log('[SERVER] BattleZone server starting...')

  // ── Singletons ──
  const now = Date.now()
  roundInfo.roundId = 1
  roundInfo.endsAtMs = (Math.floor(now / ROUND_LENGTH_MS) + 1) * ROUND_LENGTH_MS

  roundEntity = engine.addEntity()
  RoundState.create(roundEntity, { roundId: roundInfo.roundId, endsAtMs: roundInfo.endsAtMs })
  syncEntity(roundEntity, [RoundState.componentId], SyncIds.ROUND_STATE)

  heartbeatEntity = engine.addEntity()
  // First pulse inside setup so the first client doesn't wait a full interval.
  ServerHeartbeat.create(heartbeatEntity, { tickMs: now })
  syncEntity(heartbeatEntity, [ServerHeartbeat.componentId], SyncIds.HEARTBEAT)

  pickupEntity = engine.addEntity()
  PickupState.create(pickupEntity, { activeJson: buildPickupJson() })
  syncEntity(pickupEntity, [PickupState.componentId], SyncIds.PICKUP_STATE)

  leaderboardEntity = engine.addEntity()
  LeaderboardState.create(leaderboardEntity, {
    allTimeJson: '[]',
    eventJson: '[]',
    eventLabel: '',
    eventBoardActive: false,
    updatedAtMs: 0
  })
  syncEntity(leaderboardEntity, [LeaderboardState.componentId], SyncIds.LEADERBOARD)

  // ── Drones ──
  for (let i = 0; i < DRONE_COUNT; i++) {
    const spawn = DRONE_SPAWNS[i]
    const entity = engine.addEntity()
    DroneState.create(entity, {
      droneId: i,
      active: true,
      hp: DRONE_HP,
      px: spawn.x,
      py: spawn.y,
      pz: spawn.z,
      vx: 0,
      vy: 0,
      vz: 0
    })
    syncEntity(entity, [DroneState.componentId]) // auto id, matched by droneId field
    drones.push({
      id: i,
      entity,
      active: true,
      hp: DRONE_HP,
      pos: Vector3.create(spawn.x, spawn.y, spawn.z),
      vel: Vector3.create(0, 0, 0),
      respawnAtMs: 0,
      syncTimer: (i / DRONE_COUNT) * DRONE_SYNC_INTERVAL, // stagger CRDT writes
      home: Vector3.create(spawn.x, spawn.y, spawn.z),
      chasing: ''
    })
  }

  // ── Death drop pool ──
  // Pre-created and reused: no entity churn, and no sync ids being recycled while a client still holds the old one.
  for (let i = 0; i < MAX_DROPS; i++) {
    const entity = engine.addEntity()
    DropState.create(entity, { dropId: i, active: false, kind: 0, amount: 0, x: 0, y: 0, z: 0 })
    syncEntity(entity, [DropState.componentId])
    drops.push({ id: i, entity, active: false, kind: 0, amount: 0, droppedAtMs: 0 })
  }

  registerHandlers()
  registerSystems()
  // Not awaited: players can join and fly while the board is still loading.
  void loadLeaderboard()
  console.log('[SERVER] BattleZone ready. Round', roundInfo.roundId, 'ends', new Date(roundInfo.endsAtMs).toISOString())
}

// ══════════════════════ helpers ══════════════════════

function buildPickupJson(): string {
  return JSON.stringify(pickups.filter((p) => p.active).map((p) => p.id))
}

function publishPickups() {
  const state = PickupState.getMutableOrNull(pickupEntity)
  if (state) state.activeJson = buildPickupJson()
}

function freshLoadout(state: { health: number; bullets: number; rockets: number; boostMs: number; alive: boolean }) {
  state.health = MAX_HEALTH
  state.bullets = ROUND_START_BULLETS
  state.rockets = ROUND_START_ROCKETS
  state.boostMs = ROUND_START_BOOST_MS // topped up beyond this with blue crates
  state.alive = true
}

function createPlayerEntity(address: string) {
  const entity = engine.addEntity()
  PlayerState.create(entity, {
    playerId: address,
    health: MAX_HEALTH,
    bullets: ROUND_START_BULLETS,
    rockets: ROUND_START_ROCKETS,
    boostMs: ROUND_START_BOOST_MS,
    boosting: false,
    collectedBullets: 0,
    collectedRockets: 0,
    collectedBoostMs: 0,
    kills: 0,
    droneKills: 0,
    deaths: 0,
    alive: false,
    respawnAtMs: 0,
    roundId: roundInfo.roundId,
    inLobby: true,
    switchAtMs: 0
  })
  syncEntity(entity, [PlayerState.componentId]) // auto id — matched by playerId field
  playerEntities.set(address, entity)

  // Arriving mid-pause: the roundEnded broadcast has already been and gone, so
  // send this one player the board on its own. Without it they wait out a pause
  // with no idea why nothing is happening.
  if (inIntermission()) {
    room.send(
      'roundEnded',
      {
        roundId: roundInfo.roundId,
        scoreboardJson: JSON.stringify(lastScoreboard),
        // what is LEFT of the pause, not its full length
        intermissionMs: Math.max(0, roundInfo.intermissionUntilMs - Date.now())
      },
      { to: [address] }
    )
  }
  console.log('[SERVER] player joined (lobby):', address)
}

/**
 * One action at a time: bullets, rockets or boost. The client enforces this too
 * (client/actionLock.ts), for feel; this copy is what makes it a RULE rather
 * than a client courtesy, which is the point — the whole reason it exists is
 * that PC can hold three inputs at once and a phone cannot.
 *
 * Returns what has the plane, or null if it is free.
 */
function actionHolder(address: string): string | null {
  if (boostingSince.has(address)) return 'boost'
  const lock = weaponLock.get(address)
  if (lock === undefined) return null
  if (Date.now() >= lock.untilMs) {
    weaponLock.delete(address)
    return null
  }
  return lock.action
}

/** True if `action` may start. Repeating the same action is never blocked. */
function actionFree(address: string, action: string): boolean {
  const held = actionHolder(address)
  return held === null || held === action
}

/**
 * Marks a gun as in use for the overlap window — long enough to catch a second
 * action fired off alongside it, short enough that switching to boost right
 * after a shot is not a wait. NOT the weapon's firing interval: that made the
 * server refuse boost for most of a second after a rocket.
 */
function holdWeapon(address: string, action: string) {
  weaponLock.set(address, { action, untilMs: Date.now() + ACTION_OVERLAP_MS })
}

/**
 * Bills any boost burned so far against the stock and stops the burn. Charged
 * from the server clock, so the elapsed time is not something a client reports.
 * Safe to call when not boosting.
 */
function settleBoost(address: string) {
  const startedAt = boostingSince.get(address)
  if (startedAt === undefined) return
  boostingSince.delete(address)
  const state = getPlayerState(address)
  if (state === null) return
  state.boostMs = Math.max(0, state.boostMs - (Date.now() - startedAt))
}

function publishDrop(drop: (typeof drops)[number], x: number, y: number, z: number) {
  const state = DropState.getMutableOrNull(drop.entity)
  if (state === null) return
  state.active = drop.active
  state.kind = drop.kind
  state.amount = drop.amount
  state.x = x
  state.y = y
  state.z = z
}

function clearDrop(drop: (typeof drops)[number]) {
  drop.active = false
  drop.amount = 0
  drop.droppedAtMs = 0
  const state = DropState.getMutableOrNull(drop.entity)
  if (state) state.active = false
}

/**
 * Free slot, or the longest-standing crate if every slot is busy. Crates have no
 * expiry - they sit where they fell until collected or until the round ends - so
 * a full pool recycles the oldest rather than waiting for one to time out.
 */
function takeDropSlot(): (typeof drops)[number] {
  for (const drop of drops) if (!drop.active) return drop
  let oldest = drops[0]
  for (const drop of drops) if (drop.droppedAtMs < oldest.droppedAtMs) oldest = drop
  return oldest
}

/**
 * Leaves the wreck: one crate per resource the pilot still had, spread along a
 * short line so the crates never intersect. What is dropped is removed from the
 * pilot, so a kill genuinely transfers the load rather than duplicating it.
 */
function spawnDeathDrops(victim: ReturnType<typeof getPlayerState>, x: number, y: number, z: number) {
  if (victim === null) return
  const loads: { kind: number; amount: number }[] = []
  if (victim.bullets > 0) loads.push({ kind: DROP_KIND_BULLETS, amount: victim.bullets })
  if (victim.rockets > 0) loads.push({ kind: DROP_KIND_ROCKETS, amount: victim.rockets })
  if (victim.boostMs > 0) loads.push({ kind: DROP_KIND_BOOST, amount: victim.boostMs })
  if (loads.length === 0) return

  for (let i = 0; i < loads.length; i++) {
    const drop = takeDropSlot()
    drop.active = true
    drop.kind = loads[i].kind
    drop.amount = loads[i].amount
    drop.droppedAtMs = Date.now()
    // centred on the wreck: offsets run -1,0,+1 slots for three crates
    const offset = (i - (loads.length - 1) / 2) * DROP_SPACING
    publishDrop(drop, x + offset, y, z)
  }

  victim.bullets = 0
  victim.rockets = 0
  victim.boostMs = 0
}

function applyDamage(
  victimId: string,
  damage: number,
  attackerId: string,
  cause: string,
  x: number,
  y: number,
  z: number
) {
  // the round is over and its numbers are on screen - nothing may change them
  if (inIntermission()) return
  const victim = getPlayerState(victimId)
  if (victim === null || !victim.alive) return

  victim.health = Math.max(0, victim.health - damage)
  room.send('hitConfirmed', {
    victimId,
    attackerId,
    weapon: cause,
    victimHealth: victim.health,
    x,
    y,
    z
  })

  if (victim.health <= 0) {
    settleBoost(victimId) // bill any burn first, so the dropped boost is accurate
    spawnDeathDrops(victim, x, y, z)
    victim.alive = false
    victim.deaths += 1
    victim.respawnAtMs = Date.now() + RESPAWN_COOLDOWN_MS
    if (attackerId !== '' && attackerId !== victimId) {
      const attacker = getPlayerState(attackerId)
      if (attacker) attacker.kills += 1
    }
    room.send('planeDestroyed', { victimId, attackerId, cause, x, y, z })
    console.log('[SERVER] plane destroyed:', victimId, 'by', attackerId || cause)
  }
}

function explodeDrone(drone: (typeof drones)[number], victimId: string, byPlayerId: string) {
  drone.active = false
  drone.hp = 0
  drone.respawnAtMs = Date.now() + DRONE_RESPAWN_MS
  const state = DroneState.getMutableOrNull(drone.entity)
  if (state) {
    state.active = false
    state.hp = 0
  }
  room.send('droneExploded', {
    droneId: drone.id,
    victimId,
    byPlayerId,
    x: drone.pos.x,
    y: drone.pos.y,
    z: drone.pos.z
  })
}

/**
 * Applies armed lobby<->play switches whose wait is up.
 *
 * Runs every frame rather than on the 1s slow tick so the change lands when the
 * countdown the player is watching hits zero, not up to a second later.
 */
function lobbySwitchTick() {
  const now = Date.now()
  for (const address of playerEntities.keys()) {
    const state = getPlayerState(address)
    if (state === null || state.switchAtMs === 0 || now < state.switchAtMs) continue
    state.switchAtMs = 0

    if (state.inLobby) {
      // into the battle, on the round's loadout
      state.inLobby = false
      state.respawnAtMs = 0
      freshLoadout(state)
      markParticipant(address)
      state.roundId = roundInfo.roundId
      console.log('[SERVER] entered play:', address)
    } else {
      // out to the lobby. Not a death: no drop, no death counted, and the
      // loadout is dropped rather than banked, since coming back re-arms with
      // the round loadout anyway.
      settleBoost(address)
      state.alive = false
      state.inLobby = true
      state.respawnAtMs = 0
      console.log('[SERVER] entered lobby:', address)
    }
  }
}

// ══════════════════════ message handlers ══════════════════════

function registerHandlers() {
  room.onMessage('requestSpawn', (_data, context) => {
    if (context === undefined) return
    const address = context.from.toLowerCase()
    const state = getPlayerState(address)
    if (state === null) return
    if (state.alive) return
    if (state.inLobby) return // in the lobby by choice, not waiting to respawn
    if (state.switchAtMs !== 0) return // on the way to the lobby — do not put them back in the air
    if (Date.now() < state.respawnAtMs) return // cooldown not over
    freshLoadout(state)
    markParticipant(address)
    state.roundId = roundInfo.roundId
  })

  // ── lobby <-> play ──
  // Both directions only ever ARM the switch; lobbySwitchTick makes the change
  // once the wait is up. A second request while one is pending is ignored
  // rather than restarting the clock.
  room.onMessage('requestPlay', (_data, context) => {
    if (context === undefined) return
    const state = getPlayerState(context.from.toLowerCase())
    if (state === null) return
    if (!state.inLobby || state.switchAtMs !== 0) return
    state.switchAtMs = Date.now() + LOBBY_TRANSITION_MS
  })

  room.onMessage('requestLobby', (_data, context) => {
    if (context === undefined) return
    const state = getPlayerState(context.from.toLowerCase())
    if (state === null) return
    // Allowed while dead as well as while flying: a downed pilot can head for
    // the lobby instead of waiting out the respawn.
    if (state.inLobby || state.switchAtMs !== 0) return
    state.switchAtMs = Date.now() + LOBBY_TRANSITION_MS
  })

  room.onMessage('cancelSwitch', (_data, context) => {
    if (context === undefined) return
    const state = getPlayerState(context.from.toLowerCase())
    if (state === null) return
    // Disarming leaves the player exactly where they are, so it is safe right
    // up to the moment lobbySwitchTick fires the switch.
    state.switchAtMs = 0
  })

  room.onMessage('fireBullet', (data, context) => {
    if (context === undefined) return
    const address = context.from.toLowerCase()
    if (isRateLimited(address, 'fireB', 4)) return
    const state = getPlayerState(address)
    if (state === null || !state.alive || state.bullets <= 0) return
    if (!actionFree(address, 'bullets')) return
    holdWeapon(address, 'bullets')
    state.bullets = Math.max(0, state.bullets - BULLETS_PER_VOLLEY)
    room.send('playerFired', {
      playerId: address,
      weapon: 'bullet',
      ox: data.ox,
      oy: data.oy,
      oz: data.oz,
      dx: data.dx,
      dy: data.dy,
      dz: data.dz
    })
  })

  room.onMessage('fireRocket', (data, context) => {
    if (context === undefined) return
    const address = context.from.toLowerCase()
    if (isRateLimited(address, 'fireR', 2)) return
    const state = getPlayerState(address)
    if (state === null || !state.alive || state.rockets <= 0) return
    if (!actionFree(address, 'rockets')) return
    holdWeapon(address, 'rockets')
    state.rockets -= 1
    room.send('playerFired', {
      playerId: address,
      weapon: 'rocket',
      ox: data.ox,
      oy: data.oy,
      oz: data.oz,
      dx: data.dx,
      dy: data.dy,
      dz: data.dz
    })
  })

  room.onMessage('reportPlayerHit', (data, context) => {
    if (context === undefined) return
    const attackerId = context.from.toLowerCase()
    const victimId = data.victimId.toLowerCase()
    if (attackerId === victimId) return
    const maxPerSecond = data.weapon === 'rocket' ? 3 : 6
    if (isRateLimited(attackerId, 'hit', maxPerSecond)) return

    const attacker = getPlayerState(attackerId)
    const victim = getPlayerState(victimId)
    if (attacker === null || victim === null || !attacker.alive || !victim.alive) return

    // Plausibility: server-side distance between the two planes must be within
    // weapon range (+ slack for projectile flight time and replication lag).
    const attackerPos = getPlayerPosition(attackerId)
    const victimPos = getPlayerPosition(victimId)
    if (attackerPos === null || victimPos === null) return
    const range = (data.weapon === 'rocket' ? ROCKET_RANGE : BULLET_RANGE) + HIT_VALIDATION_SLACK
    if (Vector3.distance(attackerPos, victimPos) > range) {
      room.send('denied', { reason: 'hit-out-of-range' }, { to: [context.from] })
      return
    }

    const damage = data.weapon === 'rocket' ? ROCKET_DAMAGE : BULLET_DAMAGE
    applyDamage(victimId, damage, attackerId, data.weapon, data.x, data.y, data.z)
  })

  room.onMessage('reportDroneHit', (data, context) => {
    if (context === undefined) return
    const attackerId = context.from.toLowerCase()
    if (inIntermission()) return
    if (isRateLimited(attackerId, 'droneHit', 6)) return
    const attacker = getPlayerState(attackerId)
    if (attacker === null || !attacker.alive) return
    const drone = drones[data.droneId]
    if (drone === undefined || !drone.active) return

    const attackerPos = getPlayerPosition(attackerId)
    if (attackerPos === null) return
    const range = (data.weapon === 'rocket' ? ROCKET_RANGE : BULLET_RANGE) + HIT_VALIDATION_SLACK
    if (Vector3.distance(attackerPos, drone.pos) > range) return

    drone.hp -= data.weapon === 'rocket' ? DRONE_HP : 1
    if (drone.hp <= 0) {
      attacker.droneKills += 1
      explodeDrone(drone, '', attackerId)
    }
  })

  room.onMessage('reportTerrainHit', (_data, context) => {
    if (context === undefined) return
    const address = context.from.toLowerCase()
    // ONE per second, and this is what sets the pace rather than the client's
    // own timer: a client reporting every frame still loses a hit a second, so
    // grinding the wall costs the same whatever it claims.
    if (isRateLimited(address, 'terrain', 1)) return
    const state = getPlayerState(address)
    if (state === null || !state.alive || state.inLobby) return
    const pos = getPlayerPosition(address)
    if (pos === null) return
    // No attacker: nobody gets the kill for a pilot flying into a wall.
    applyDamage(address, TERRAIN_GRIND_DAMAGE, '', 'terrain', pos.x, pos.y, pos.z)
  })

  room.onMessage('boostStart', (_data, context) => {
    if (context === undefined) return
    const address = context.from.toLowerCase()
    if (isRateLimited(address, 'boost', 8)) return
    const state = getPlayerState(address)
    if (state === null || !state.alive || state.boostMs <= 0) return
    if (boostingSince.has(address)) return // already burning
    if (!actionFree(address, 'boost')) return // a gun still has the plane
    boostingSince.set(address, Date.now())
  })

  room.onMessage('boostStop', (_data, context) => {
    if (context === undefined) return
    settleBoost(context.from.toLowerCase())
  })

  room.onMessage('requestDropPickup', (data, context) => {
    if (context === undefined) return
    const address = context.from.toLowerCase()
    if (isRateLimited(address, 'drop', 4)) return
    const state = getPlayerState(address)
    if (state === null || !state.alive) return
    const drop = drops[data.dropId]
    if (drop === undefined || !drop.active) return

    const dropState = DropState.getOrNull(drop.entity)
    if (dropState === null) return
    const pos = getPlayerPosition(address)
    if (pos === null) return
    const at = Vector3.create(dropState.x, dropState.y, dropState.z)
    if (!withinPickupRange(pos, at, PICKUP_SERVER_SLACK)) return

    // No ceiling on what a pilot can carry, so a crate is always taken whole.
    if (drop.kind === DROP_KIND_BULLETS) {
      state.bullets += drop.amount
      noteCollected(address, drop.amount, 0, 0)
    } else if (drop.kind === DROP_KIND_ROCKETS) {
      state.rockets += drop.amount
      noteCollected(address, 0, drop.amount, 0)
    } else {
      settleBoost(address) // bill any burn before topping the stock up
      state.boostMs += drop.amount
      noteCollected(address, 0, 0, drop.amount)
      if (boostingSince.has(address)) boostingSince.set(address, Date.now())
    }

    clearDrop(drop)
    room.send('dropTaken', { dropId: drop.id, playerId: address })
  })

  room.onMessage('requestPickup', (data, context) => {
    if (context === undefined) return
    const address = context.from.toLowerCase()
    if (isRateLimited(address, 'pickup', 4)) return
    const state = getPlayerState(address)
    if (state === null || !state.alive) return
    const record = pickups[data.pickupId]
    const spot = PICKUP_SPOTS[data.pickupId]
    if (record === undefined || spot === undefined || !record.active) return

    const pos = getPlayerPosition(address)
    if (pos === null) return
    if (!withinPickupRange(pos, spot, PICKUP_SERVER_SLACK)) return

    if (spot.kind === 'bullets') {
      state.bullets += PICKUP_BULLET_AMOUNT
      noteCollected(address, PICKUP_BULLET_AMOUNT, 0, 0)
    } else if (spot.kind === 'rockets') {
      state.rockets += PICKUP_ROCKET_AMOUNT
      noteCollected(address, 0, PICKUP_ROCKET_AMOUNT, 0)
    } else {
      // settle first: topping up mid-burn would otherwise credit the new stock
      // and then bill the whole burn against it when the player lets go
      settleBoost(address)
      state.boostMs += BOOST_PICKUP_MS
      noteCollected(address, 0, 0, BOOST_PICKUP_MS)
      if (boostingSince.has(address)) boostingSince.set(address, Date.now())
    }
    record.active = false
    record.respawnAtMs = Date.now() + PICKUP_RESPAWN_MS
    publishPickups()
    room.send('pickupTaken', { pickupId: data.pickupId, playerId: address })
  })
}

// ══════════════════════ systems ══════════════════════

function registerSystems() {
  let heartbeatTimer = 0
  let slowTimer = 0
  let eventPollTimer = 0

  engine.addSystem((dt: number) => {
    try {
      droneSystem(dt)
      lobbySwitchTick()
      // On the fast path, not the 1 Hz block: a trail that turns up a second
      // after the burn is a trail behind the wrong piece of sky. It writes only
      // when a burn starts or stops, so the rate costs nothing.
      publishBoostFlags()

      heartbeatTimer += dt
      if (heartbeatTimer >= HEARTBEAT_INTERVAL_MS / 1000) {
        heartbeatTimer = 0
        const hb = ServerHeartbeat.getMutableOrNull(heartbeatEntity)
        if (hb) hb.tickMs = Date.now()
      }

      slowTimer += dt
      if (slowTimer >= 1) {
        slowTimer = 0
        playerTrackingTick()
        publishCollected()
        roundTick()
        pickupRespawnTick()
        refreshPublished()
        publishLeaderboard()
      }

      eventPollTimer += dt
      if (eventPollTimer >= EVENT_CONFIG_POLL_MS / 1000) {
        eventPollTimer = 0
        void refreshEvents()
      }
    } catch (err) {
      console.error('[SERVER] system error:', err)
    }
  })
}

/** Writes the synced board, but only when it actually changed. */
function publishLeaderboard() {
  if (leaderboardView.version === publishedLeaderboardVersion) return
  const state = LeaderboardState.getMutableOrNull(leaderboardEntity)
  if (state === null) return
  publishedLeaderboardVersion = leaderboardView.version
  state.allTimeJson = leaderboardView.allTimeJson
  state.eventJson = leaderboardView.eventJson
  state.eventLabel = leaderboardView.eventLabel
  state.eventBoardActive = leaderboardView.eventBoardActive
  state.updatedAtMs = Date.now()
}

function playerTrackingTick() {
  refreshAvatarMap()
  // joins
  for (const address of avatarEntities.keys()) {
    if (!playerEntities.has(address)) {
      createPlayerEntity(address)
      void loadPlayerTotals(address) // pulls their all-time totals into memory
    } else if (getPlayerState(address) === null) {
      createPlayerEntity(address) // stale handle recovered
    }
  }
  // Display names for the board, straight off the replicated avatar. The
  // leaderboard shows people who are offline, so the name has to be captured
  // while they are here - and taking it from the avatar rather than from a
  // client message means a client cannot post under someone else's name.
  for (const [address, avatar] of avatarEntities) {
    const base = AvatarBase.getOrNull(avatar)
    if (base !== null) noteName(address, base.name)
  }
  // leaves
  for (const [address, entity] of playerEntities) {
    if (!avatarEntities.has(address)) {
      settleBoost(address)
      weaponLock.delete(address) // no stale lock for someone who is gone
      engine.removeEntity(entity)
      playerEntities.delete(address)
      console.log('[SERVER] player left:', address)
    }
  }
}

/**
 * True while the scoreboard is up between rounds. Scoring is closed for that
 * window, so the numbers on screen cannot move while they are being read.
 */
function inIntermission(): boolean {
  return roundInfo.intermissionUntilMs > 0
}

function roundTick() {
  const now = Date.now()

  // The pause owns the clock while it runs: the next round starts when it ends,
  // not on the wall-clock boundary, so play is never cut short by it.
  if (inIntermission()) {
    if (now < roundInfo.intermissionUntilMs) return
    roundInfo.intermissionUntilMs = 0
    startNextRound(now)
    return
  }

  if (now < roundInfo.endsAtMs) return
  endRound(now)
}

/**
 * Closes the round: publishes the scoreboard, banks the round for the all-time
 * totals, and opens the intermission. Nothing is reset here — the standings
 * have to survive on the server until the next round actually starts, because
 * a player joining mid-pause still gets sent the board.
 */
function endRound(now: number) {
  const rows: ScoreRow[] = []
  for (const address of playerEntities.keys()) {
    const state = getPlayerState(address)
    if (state === null) continue
    // Crate counts are kept outside PlayerState, in the leaderboard's per-round
    // tally. Read here while it is still filled — recordRound below clears it.
    const picked = collectedFor(address)
    rows.push({
      id: address,
      name: displayNameFor(address),
      kills: state.kills,
      droneKills: state.droneKills,
      deaths: state.deaths,
      bullets: picked.bullets,
      rockets: picked.rockets,
      boostMs: picked.boostMs
    })
  }
  // Most player kills first; drone kills only break a tie, so a drone farmer
  // never outranks someone who actually shot down planes.
  rows.sort((a, b) => b.kills - a.kills || b.droneKills - a.droneKills || a.deaths - b.deaths)

  roundInfo.intermissionUntilMs = now + INTERMISSION_MS
  lastScoreboard = rows.slice(0, SCOREBOARD_MAX_ROWS)
  room.send('roundEnded', {
    roundId: roundInfo.roundId,
    scoreboardJson: JSON.stringify(lastScoreboard),
    intermissionMs: INTERMISSION_MS
  })

  // Snapshot the round BEFORE the reset zeroes every PlayerState, then fold it
  // into the all-time totals off the tick. recordRound is the only thing that
  // writes to Storage, and it only runs here, once per round.
  // Crate fields stay ZERO here even though the rows above carry them:
  // recordRound adds the same tally itself, so seeding them would double it.
  const roundRows: RoundPlayerRecord[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    kills: row.kills,
    droneKills: row.droneKills,
    deaths: row.deaths,
    bulletsCollected: 0,
    rocketsCollected: 0,
    boostCollectedMs: 0
  }))
  void recordRound(roundInfo.roundId, now, ROUND_LENGTH_MS, roundRows)
  console.log('[SERVER] round', roundInfo.roundId, 'ended,', rows.length, 'pilots; pause', INTERMISSION_MS / 1000 + 's')
}

/** Resets the world and puts the next round on the clock. */
function startNextRound(now: number) {
  lastScoreboard = []
  roundInfo.roundId += 1
  // Full length from the moment play resumes, rather than the next wall-clock
  // boundary — otherwise the pause would eat into the round that follows it.
  roundInfo.endsAtMs = now + ROUND_LENGTH_MS
  const round = RoundState.getMutableOrNull(roundEntity)
  if (round) {
    round.roundId = roundInfo.roundId
    round.endsAtMs = roundInfo.endsAtMs
  }

  boostingSince.clear()
  weaponLock.clear()
  for (const drop of drops) clearDrop(drop)

  // reset players — everyone respawns with the round loadout
  for (const address of playerEntities.keys()) {
    const state = getPlayerState(address)
    if (state === null) continue
    freshLoadout(state)
    // ...but a new round does not drag anyone out of the lobby: they are there
    // by choice and only PLAY takes them back into the air.
    if (state.inLobby) state.alive = false
    else markParticipant(address)
    state.kills = 0
    state.droneKills = 0
    state.deaths = 0
    state.respawnAtMs = 0
    state.roundId = roundInfo.roundId
  }

  // reset drones
  const nowMs = Date.now()
  for (const drone of drones) respawnDrone(drone, nowMs)

  // reset pickups
  for (const pickup of pickups) {
    pickup.active = true
    pickup.respawnAtMs = 0
  }
  publishPickups()

  room.send('roundStarted', { roundId: roundInfo.roundId, endsAtMs: roundInfo.endsAtMs })
  console.log('[SERVER] round', roundInfo.roundId, 'started, ends', new Date(roundInfo.endsAtMs).toISOString())
}

/**
 * Mirrors the burn onto the synced state so every client can draw the trail.
 *
 * DERIVED from boostingSince each tick rather than written beside it: settling
 * a burn is not always the end of one (a crate top-up settles and immediately
 * restarts it), so a flag set at the call sites would have drifted on exactly
 * the paths that are easiest to miss. Assigned only when it changes, so this
 * costs a CRDT write on the press and the release and nothing in between.
 */
function publishBoostFlags() {
  for (const address of playerEntities.keys()) {
    const state = getPlayerState(address)
    if (state === null) continue
    const burning = boostingSince.has(address)
    if (state.boosting !== burning) state.boosting = burning
  }
}

/**
 * Mirrors the per-round collected tally onto the synced state, for the live
 * ROUND board.
 *
 * DERIVED from collectedFor each tick, like publishBoostFlags: the tally is
 * already maintained at six grant sites and cleared inside recordRound, and a
 * second copy written beside each of those would be six more places to forget.
 * Assigned only when a number actually moves, so this is a handful of CRDT
 * writes per crate and nothing at all in between. On the 1 Hz tick, not the
 * fast one - a leaderboard a second behind is a leaderboard.
 */
function publishCollected() {
  for (const address of playerEntities.keys()) {
    const state = getPlayerState(address)
    if (state === null) continue
    const taken = collectedFor(address)
    if (state.collectedBullets !== taken.bullets) state.collectedBullets = taken.bullets
    if (state.collectedRockets !== taken.rockets) state.collectedRockets = taken.rockets
    if (state.collectedBoostMs !== taken.boostMs) state.collectedBoostMs = taken.boostMs
  }
}

function pickupRespawnTick() {
  const now = Date.now()
  let changed = false
  for (const pickup of pickups) {
    if (!pickup.active && now >= pickup.respawnAtMs) {
      pickup.active = true
      changed = true
    }
  }
  if (changed) publishPickups()
}

// ── Drone AI ──

function respawnDrone(drone: (typeof drones)[number], nowMs: number) {
  const spawn = DRONE_SPAWNS[drone.id]
  drone.active = true
  drone.hp = DRONE_HP
  drone.pos.x = spawn.x
  drone.pos.y = spawn.y
  drone.pos.z = spawn.z
  drone.vel.x = 0
  drone.vel.y = 0
  drone.vel.z = 0
  drone.respawnAtMs = 0
  drone.chasing = '' // back on patrol, not still after whoever it died chasing
  drone.home.x = spawn.x
  drone.home.y = spawn.y
  drone.home.z = spawn.z
  const state = DroneState.getMutableOrNull(drone.entity)
  if (state) {
    state.active = true
    state.hp = DRONE_HP
    state.px = spawn.x
    state.py = spawn.y
    state.pz = spawn.z
    state.vx = 0
    state.vy = 0
    state.vz = 0
  }
  void nowMs
}

function nearestAlivePlayer(pos: Vector3): { address: string; position: Vector3 } | null {
  let best: { address: string; position: Vector3 } | null = null
  let bestDistance = Infinity
  for (const address of playerEntities.keys()) {
    const state = getPlayerState(address)
    if (state === null || !state.alive) continue
    const playerPos = getPlayerPosition(address)
    if (playerPos === null) continue
    const distance = Vector3.distance(pos, playerPos)
    if (distance < bestDistance) {
      bestDistance = distance
      best = { address, position: playerPos }
    }
  }
  return best
}

/** Live position of the plane a drone is chasing, or null if it is gone. */
function chaseTarget(drone: (typeof drones)[number]): Vector3 | null {
  if (drone.chasing === '') return null
  const state = getPlayerState(drone.chasing)
  if (state === null || !state.alive) return null
  return getPlayerPosition(drone.chasing)
}

/**
 * Decides what this drone is doing this tick: picks up a plane that has entered
 * its patch, and drops one that has outrun it or dragged it too far from home.
 * Returns the plane to chase, or null to patrol.
 */
function updateChaseState(drone: (typeof drones)[number]): Vector3 | null {
  // The round is over: let go of whoever they were after and go home.
  if (inIntermission()) {
    drone.chasing = ''
    return null
  }

  const current = chaseTarget(drone)
  if (current !== null) {
    // Broken by outrunning the drone, which is what boost is for, or by the
    // drone reaching the end of its leash from home.
    const escaped = Vector3.distance(drone.pos, current) > DRONE_GIVE_UP_DISTANCE
    const tooFarFromHome = Vector3.distance(drone.pos, drone.home) > DRONE_MAX_LEASH
    if (escaped || tooFarFromHome) {
      drone.chasing = ''
      return null
    }
    return current
  }

  // Not chasing: wake only for a plane inside this drone's own patch, so a
  // plane crossing the map wakes the drones it flies past, not all of them.
  drone.chasing = ''
  const candidate = nearestAlivePlayer(drone.home)
  if (candidate === null) return null
  if (Vector3.distance(drone.home, candidate.position) > DRONE_AGGRO_RADIUS) return null
  drone.chasing = candidate.address
  return candidate.position
}

/** Holds a drone inside the play volume. Re-applied after every constraint sweep. */
function clampToArena(drone: (typeof drones)[number]) {
  drone.pos.y = Math.max(DRONE_MIN_Y, Math.min(DRONE_MAX_Y, drone.pos.y))
  drone.pos.x = Math.max(4, Math.min(CENTER_X * 2 - 4, drone.pos.x))
  drone.pos.z = Math.max(4, Math.min(CENTER_Z * 2 - 4, drone.pos.z))
}

/**
 * Moves overlapping drones apart after they have flown. This is the guarantee
 * that two drones are never in the same place; the steering push below only
 * makes the approach look natural (see DRONE_MIN_GAP for why steering alone
 * cannot do it).
 *
 * Bounds are re-applied inside the sweep, not after it: a drone pushed up
 * through the ceiling would otherwise be dropped straight back onto the one it
 * had just been separated from.
 */
function separateDrones() {
  for (let pass = 0; pass < DRONE_SEPARATION_PASSES; pass++) {
    for (let i = 0; i < drones.length; i++) {
      const a = drones[i]
      if (!a.active) continue
      for (let j = i + 1; j < drones.length; j++) {
        const b = drones[j]
        if (!b.active) continue
        const dx = a.pos.x - b.pos.x
        const dy = a.pos.y - b.pos.y
        const dz = a.pos.z - b.pos.z
        let distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (distance >= DRONE_MIN_GAP) continue

        let ux: number
        let uy: number
        let uz: number
        if (distance < 0.0001) {
          // Exactly coincident: there is no direction to push along, so pick a
          // deterministic one off the drone id rather than dividing by zero.
          ux = Math.cos(i * 2.4)
          uy = 0
          uz = Math.sin(i * 2.4)
          distance = 0.0001
        } else {
          ux = dx / distance
          uy = dy / distance
          uz = dz / distance
        }
        // half the correction each, so neither is privileged
        const push = (DRONE_MIN_GAP - distance) / 2
        a.pos.x += ux * push
        a.pos.y += uy * push
        a.pos.z += uz * push
        b.pos.x -= ux * push
        b.pos.y -= uy * push
        b.pos.z -= uz * push
      }
    }
    for (const drone of drones) if (drone.active) clampToArena(drone)
  }
}

/**
 * Push away from drones that are too close, strongest as they touch. Smooths
 * the approach so drones fan out rather than converging and being shoved apart
 * by separateDrones().
 */
function separation(drone: (typeof drones)[number]): Vector3.MutableVector3 {
  const push = Vector3.create(0, 0, 0)
  for (const other of drones) {
    if (other === drone || !other.active) continue
    const dx = drone.pos.x - other.pos.x
    const dy = drone.pos.y - other.pos.y
    const dz = drone.pos.z - other.pos.z
    const distanceSq = dx * dx + dy * dy + dz * dz
    if (distanceSq >= DRONE_SEPARATION * DRONE_SEPARATION || distanceSq < 0.0001) continue
    const distance = Math.sqrt(distanceSq)
    // 0 at the edge of personal space, 1 when they are on top of each other
    const strength = (DRONE_SEPARATION - distance) / DRONE_SEPARATION
    push.x += (dx / distance) * strength
    push.y += (dy / distance) * strength
    push.z += (dz / distance) * strength
  }
  return push
}

function droneSystem(dt: number) {
  const now = Date.now()

  // ── pass 1: decide and fly ──
  for (const drone of drones) {
    if (!drone.active) {
      if (drone.respawnAtMs > 0 && now >= drone.respawnAtMs) respawnDrone(drone, now)
      continue
    }

    // chase a plane in this drone's patch, or patrol it
    const target = updateChaseState(drone)
    let desired: Vector3
    if (target !== null) {
      // aim ~1m above avatar feet (plane body height)
      const aim = Vector3.create(target.x, target.y + 1, target.z)
      desired = Vector3.scale(Vector3.normalize(Vector3.subtract(aim, drone.pos)), DRONE_CHASE_SPEED)
    } else {
      // Patrol: circle the patch. Steering toward a point ON the orbit rather
      // than along a fixed heading also walks the drone back after a chase,
      // so returning home needs no separate state.
      const angle = (now / DRONE_PATROL_PERIOD_MS) * Math.PI * 2 + drone.id
      const orbit = Vector3.create(
        drone.home.x + Math.cos(angle) * DRONE_PATROL_RADIUS,
        drone.home.y,
        drone.home.z + Math.sin(angle) * DRONE_PATROL_RADIUS
      )
      const toOrbit = Vector3.subtract(orbit, drone.pos)
      const away = Vector3.length(toOrbit)
      // far from the patch it hurries back, on the patch it drifts
      const speed = away > DRONE_PATROL_RADIUS * 2 ? DRONE_SPEED : DRONE_IDLE_SPEED
      desired = away < 0.001 ? Vector3.create(0, 0, 0) : Vector3.scale(Vector3.scale(toOrbit, 1 / away), speed)
    }

    // Keeps drones out of each other regardless of what they are doing, so a
    // shared target never collapses them into one body.
    const apart = separation(drone)
    desired = Vector3.create(
      desired.x + apart.x * DRONE_SEPARATION_FORCE,
      desired.y + apart.y * DRONE_SEPARATION_FORCE,
      desired.z + apart.z * DRONE_SEPARATION_FORCE
    )

    const blend = Math.min(1, DRONE_TURN_RATE * dt)
    drone.vel.x += (desired.x - drone.vel.x) * blend
    drone.vel.y += (desired.y - drone.vel.y) * blend
    drone.vel.z += (desired.z - drone.vel.z) * blend

    drone.pos.x += drone.vel.x * dt
    drone.pos.y += drone.vel.y * dt
    drone.pos.z += drone.vel.z * dt
    clampToArena(drone)
  }

  // ── pass 2: nothing overlaps after this, whatever the steering did ──
  separateDrones()

  // ── pass 3: ram, publish ──
  // After separation, so the place a client is shown is the same place the ram
  // check read.
  for (const drone of drones) {
    if (!drone.active) continue

    // ── ram check ──
    // Skipped during the pause: applyDamage would refuse the hit anyway, so the
    // drone would blow itself up for nothing while the scoreboard is up.
    const target = chaseTarget(drone)
    if (!inIntermission() && target !== null && Vector3.distance(drone.pos, target) <= DRONE_EXPLODE_RADIUS) {
      const victim = drone.chasing
      explodeDrone(drone, victim, '')
      applyDamage(victim, DRONE_DAMAGE, '', 'drone', drone.pos.x, drone.pos.y, drone.pos.z)
      continue
    }

    // ── throttled CRDT snapshot (clients dead-reckon in between) ──
    drone.syncTimer += dt
    if (drone.syncTimer >= DRONE_SYNC_INTERVAL) {
      drone.syncTimer = 0
      const state = DroneState.getMutableOrNull(drone.entity)
      if (state) {
        state.px = drone.pos.x
        state.py = drone.pos.y
        state.pz = drone.pos.z
        state.vx = drone.vel.x
        state.vy = drone.vel.y
        state.vz = drone.vel.z
      }
    }
  }
}
