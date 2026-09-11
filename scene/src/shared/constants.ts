// BattleZone — shared tuning constants (imported by both server and client).

// ── World ──
export const SCENE_SIZE = 160 // 10x10 parcels
export const CENTER_X = 80
export const CENTER_Z = 80
export const CEILING_Y = 87
export const FLOOR_Y = 2
export const BOUNDS_MARGIN = 6 
export const TERRAIN_SPAN = 104
export const TERRAIN_HALF = TERRAIN_SPAN / 2

// ── Round ──
export const ROUND_LENGTH_MS = 4 * 60 * 1000
export const INTERMISSION_MS = 20_000
export const SCOREBOARD_MAX_ROWS = 20

export const COINS_PER_PLAYER_KILL = 2
export const COINS_PER_DRONE_KILL = 1

/** What a pilot has earned, from the two kill counts every board carries. */
export function coinsFor(kills: number, droneKills: number): number {
  return kills * COINS_PER_PLAYER_KILL + droneKills * COINS_PER_DRONE_KILL
}

export const ROUND_START_BULLETS = 20
export const ROUND_START_ROCKETS = 10
export const ROUND_START_BOOST_MS = 5_000

// ── Player / combat ──
export const MAX_HEALTH = 4 
export const BULLET_DAMAGE = 1
export const ROCKET_DAMAGE = 4 
export const RESPAWN_COOLDOWN_MS = 10_000

export const BULLET_VOLLEY_INTERVAL = 0.5 
export const BULLETS_PER_VOLLEY = 2
export const ROCKET_INTERVAL = 1.0 

/**
 * How close two actions have to be to count as being used AT THE SAME TIME.
 */
export const ACTION_OVERLAP_MS = 100

/**
 * Floor on how long the UI dim stays up once it appears.
 */
export const ACTION_DIM_HOLD_MS = 100

export const BULLET_SPEED = 80
export const BULLET_RANGE = 130
export const BULLET_HIT_RADIUS = 2.4
export const ROCKET_SPEED = 40
export const ROCKET_RANGE = 160
export const ROCKET_SPLASH_RADIUS = 4.75
export const ROCKET_PROXIMITY_FUSE = 3.4

// server-side plausibility window for client-reported hits (lag tolerance)
export const HIT_VALIDATION_SLACK = 20

// ── Drones ──
export const DRONE_COUNT = 8
export const DRONE_HP = 1 
export const DRONE_SPEED = 5 
export const DRONE_IDLE_SPEED = 2 
export const DRONE_TURN_RATE = 1.6 
export const DRONE_CHASE_SPEED = 9
export const DRONE_AGGRO_RADIUS = 18
export const DRONE_GIVE_UP_DISTANCE = 30
export const DRONE_MAX_LEASH = 60
export const DRONE_PATROL_RADIUS = 8
export const DRONE_PATROL_PERIOD_MS = 14_000
export const DRONE_SEPARATION = 4.5
export const DRONE_SEPARATION_FORCE = 8
export const DRONE_MIN_GAP = 3.2
export const DRONE_SEPARATION_PASSES = 4
export const DRONE_EXPLODE_RADIUS = 2.3
export const DRONE_DAMAGE = 1

// ── Flying into the rock ──
export const TERRAIN_GRIND_SPEED = 2.5 
export const TERRAIN_GRIND_COMMAND = 6 
/** Seconds of being stuck before the first hit lands. */
export const TERRAIN_GRIND_DELAY = 1
/** And one more hit for every second after that. */
export const TERRAIN_GRIND_INTERVAL = 1
export const TERRAIN_GRIND_DAMAGE = 1
export const DRONE_RESPAWN_MS = 15_000
export const DRONE_MIN_Y = 12
export const DRONE_MAX_Y = 52 
export const DRONE_SYNC_INTERVAL = 0.5 

// ── Pickups (floating collectibles) ──
/**
 * Client-side collect distance, for crates AND death drops.
 */
export const PICKUP_RADIUS = 2.2

export const PICKUP_RADIUS_Y = 1.4

interface PickupPoint {
  x: number
  y: number
  z: number
}

/**
 * Close enough to collect? An ELLIPSOID - PICKUP_RADIUS across, PICKUP_RADIUS_Y
 * up - rather than a sphere, because the plane is far wider than it is tall.
 */
export function withinPickupRange(plane: PickupPoint, crate: PickupPoint, slack: number = 0): boolean {
  const dx = plane.x - crate.x
  const dy = plane.y - crate.y
  const dz = plane.z - crate.z
  const across = PICKUP_RADIUS + slack
  const up = PICKUP_RADIUS_Y + slack
  return (dx * dx + dz * dz) / (across * across) + (dy * dy) / (up * up) <= 1
}
/**
 * Extra distance the SERVER allows before rejecting a pickup. Anti-cheat bound checked against the server's replicated view of the plane
 */
export const PICKUP_SERVER_SLACK = 8
export const PICKUP_RESPAWN_MS = 20_000
export const PICKUP_BULLET_AMOUNT = 10
export const PICKUP_ROCKET_AMOUNT = 5

// ── Death drops ──
// A destroyed plane leaves its unspent load behind: one crate per resource it still had, so up to three, side by side at the wreck.
export const DROP_KIND_BULLETS = 0
export const DROP_KIND_ROCKETS = 1
export const DROP_KIND_BOOST = 2
export const DROPS_PER_DEATH = 3
/**
 * Pooled drop slots shared by everyone (5 deaths worth). Crates never expire,
 * so they accumulate across a round; when every slot is busy the longest-
 * standing crate is recycled. Cleared at round end.
 */
export const MAX_DROPS = 15
/** Crates sit this far apart so the three never intersect. */
export const DROP_SPACING = 2.4

// ── Boost (blue crates, spent with the jump button) ──
export const BOOST_PICKUP_MS = 2_000 // per blue crate
// Applied AFTER the normal speed clamp, so boost genuinely exceeds cruise
// limits. It multiplies the CRUISE part of the speed only (see flight.ts), so
// a level burn is FLIGHT_BASE_SPEED x this = 27 m/s and the fastest the plane
// goes is that plus the dive bonus at face value, 35 m/s.
export const FLIGHT_BOOST_MULTIPLIER = 2.25
/**
 * Seconds for the multiplier to climb from 1 to full while the button is held.
 */
export const FLIGHT_BOOST_SPOOL = 1.5

/**
 * Seconds for the multiplier to run back down to 1 once the button comes up.
 */
export const FLIGHT_BOOST_DECAY = 4

// ── Lobby ──
// The lobby is the out-of-play state
export const LOBBY_TRANSITION_MS = RESPAWN_COOLDOWN_MS

// Where the player parks while in the lobby.
export const LOBBY_VIEW_X = CENTER_X
export const LOBBY_VIEW_Y = 55
export const LOBBY_VIEW_Z = 112
export const LOBBY_LOOK_X = CENTER_X
export const LOBBY_LOOK_Y = 25
export const LOBBY_LOOK_Z = CENTER_Z
export const LOBBY_HOLD_GAIN = 0.8
export const LOBBY_HOLD_MAX_SPEED = 8
export const LOBBY_SNAP_DISTANCE = 3
export const LOBBY_SNAP_COOLDOWN = 1.5

export interface PickupSpot {
  id: number
  kind: 'bullets' | 'rockets' | 'boost'
  x: number
  y: number
  z: number
}

// Deterministic layout (same literal on server and client): two rings of
// bullet crates plus a high ring of rocket crates over the map.
function buildPickupSpots(): PickupSpot[] {
  const spots: PickupSpot[] = []
  let id = 0
  const ring = (count: number, radius: number, y: number, kind: 'bullets' | 'rockets' | 'boost', phase: number) => {
    for (let i = 0; i < count; i++) {
      const a = phase + (i * Math.PI * 2) / count
      spots.push({
        id: id++,
        kind,
        x: CENTER_X + Math.cos(a) * radius,
        y,
        z: CENTER_Z + Math.sin(a) * radius
      })
    }
  }
  ring(8, 30.5, 35, 'bullets', 0.75)
  ring(6, 18.5, 54, 'bullets', 0.57) // 5.8 m
  ring(4, 20.5, 52, 'rockets', 0.39) // 5.4 m
  ring(2, 11, 50, 'rockets', 1.28) // 9.8 m, the roomiest
  ring(5, 22.25, 45, 'boost', 0.2) // 5.6 m
  return spots
}
export const PICKUP_SPOTS: PickupSpot[] = buildPickupSpots()

// Drone spawn anchors — ring over the rooftops.
export interface DroneSpawn {
  x: number
  y: number
  z: number
}
function buildDroneSpawns(): DroneSpawn[] {
  const list: DroneSpawn[] = []
  for (let i = 0; i < DRONE_COUNT; i++) {
    const a = (i * Math.PI * 2) / DRONE_COUNT + 0.09
    list.push({
      x: CENTER_X + Math.cos(a) * 30,
      y: 22 + (i % 4) * 10, // top of the stagger stays under DRONE_MAX_Y
      z: CENTER_Z + Math.sin(a) * 30
    })
  }
  return list
}
export const DRONE_SPAWNS: DroneSpawn[] = buildDroneSpawns()

// ── Client flight feel (not used by the server) ──
export const FLIGHT_BASE_SPEED = 12 // level cruise m/s
export const FLIGHT_DIVE_BONUS = 8 // extra speed at full nose-down
export const FLIGHT_MIN_SPEED = 8
export const FLIGHT_MAX_SPEED = 20

// ── Turn bleed: hard turns cost speed ──
export const FLIGHT_TURN_FREE_RATE = 1.2
/** Speed factor lost per radian swept beyond that allowance. */
export const FLIGHT_TURN_BLEED = 0.18
export const FLIGHT_TURN_MIN = 0.45
export const FLIGHT_TURN_RECOVER = 0.4
export const FLIGHT_ACCEL_GAIN = 3.5 
export const FLIGHT_GRAVITY_COMP = 12 
export const FLIGHT_MAX_FORCE = 90
// Extra upward force per m/s of climb the plane is commanded but not achieving.
// PC avatar gravity out-pulls FLIGHT_GRAVITY_COMP, so a camera-up command barely
// climbed there; mobile already climbs, and this term is 0 once the climb lands.
export const FLIGHT_CLIMB_ASSIST = 12
export const FLIGHT_DEAD_BRAKE_GAIN = 12
export const CIRCLE_ALTITUDE = 52
export const CIRCLE_RADIUS = 30
export const CIRCLE_SPEED = 6.5
export const FIRST_INPUT_ANGLE_DEG = 5 // camera swing that hands over control

// ── Model placement ──
export const PICKUP_MODEL_BULLETS = 'assets/models/bullets4.glb'
export const PICKUP_MODEL_ROCKETS = 'assets/models/rockets4.glb'
export const PICKUP_MODEL_BOOST = 'assets/models/boost4.glb'
export const PLANE_MODEL_SRC = 'assets/models/plane-jet-4.glb'
export const PLANE_ENEMY_MODEL_SRC = 'assets/models/plane-jet-enemy-2.glb'
export const DRONE_MODEL_SRC = 'assets/models/droneV2.glb'
export const TERRAIN_MODEL_SRC = 'assets/models/terrain19.glb'
export const MOBILE_RENDER_DOME_SRC = 'assets/models/mobileRenderDome.glb'

// ── Sound (assets/sounds) ──
//
// All of it is spatial: every clip is played from an entity at the place the
// thing happened, so distance does the mixing. See client/sfx.ts.
export const SOUND_BULLET_SHOT = 'assets/sounds/bullet_shot_V3.mp3'
export const SOUND_ROCKET_SHOT = 'assets/sounds/rocket_shot_V3.mp3'
/** Shared by bullet, rocket and drone impacts - one clip covers all three. */
export const SOUND_IMPACT = 'assets/sounds/bullet_rocket_drone_hit_V3.mp3'
/**
 * The same impact, mastered louder, for PC spatial hits only.
 */
export const SOUND_IMPACT_PC_SPATIAL = 'assets/sounds/bullet_rocket_drone_hit_PCspatial_V2.mp3'
export const SOUND_COLLECT = 'assets/sounds/collectible_V3.mp3'
export const SOUND_PLANE_IDLE = 'assets/sounds/plane_idle_V5.mp3'
export const SOUND_BOOST = 'assets/sounds/boost_V5.mp3'
/**
 * The round-end sting.
 */
export const SOUND_ROUND_END = 'assets/sounds/round_end_V1.mp3'
/** The other half of the pair, and non-spatial for the same reason. */
export const SOUND_ROUND_START = 'assets/sounds/fight.mp3'

/**
 * Mix levels.
 */
export const SFX_SHOT_VOLUME = 0.8
export const SFX_IMPACT_VOLUME = 0.7
export const SFX_COLLECT_VOLUME = 0.85
export const SFX_ROUND_END_VOLUME = 0.7
export const SFX_ROUND_START_VOLUME = 0.9

/**
 * PC overrides. Everything above is the MOBILE mix
 */
export const ENGINE_IDLE_VOLUME_PC = 0.15
export const SFX_IMPACT_VOLUME_PC_SPATIAL = 1
export const SFX_COLLECT_VOLUME_PC_MINE = 1
export const SFX_ROUND_END_VOLUME_PC = 0.5
export const ENGINE_IDLE_VOLUME = 0.5
export const ENGINE_BOOST_VOLUME = 0.95

export const PLANE_MODEL_YAW_OFFSET = 0
// Lateral muzzle offset. This is EXACT rather than approximate
export const WING_OFFSET = 1.0

// ── Muzzle geometry, in world metres (the model is authored 1:1) ──
//
// MUZZLE_FORWARD is negative because the wing is behind the centre; it lands on
// the wingtip's leading edge so a tracer leaves the wing rather than crossing it.
export const MUZZLE_SIDE = WING_OFFSET * 0.92 // just inboard of the wingtip
export const MUZZLE_FORWARD = -0.30
export const MUZZLE_DOWN = 0.125 
/**
 * The same offset for MOBILE, where the geometry is right but the frame is not.
 */
export const MUZZLE_FORWARD_MOBILE = -0.40
export const ROCKET_MUZZLE_DOWN = 0.325

// ── Server heartbeat ──
export const HEARTBEAT_INTERVAL_MS = 2000
export const HEARTBEAT_TIMEOUT_MS = 6500

// ── Sync ids for singleton entities ──
export enum SyncIds {
  ROUND_STATE = 1,
  HEARTBEAT = 2,
  PICKUP_STATE = 3,
  LEADERBOARD = 4
}
