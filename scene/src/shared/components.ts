// BattleZone — synced ECS components. All of them are server-authoritative:
// clients read, only the server writes (enforced by validateBeforeChange below).

import { engine, Schemas } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { AUTH_SERVER_PEER_ID } from '@dcl/sdk/network/message-bus-sync'

// ── Round state (singleton, SyncIds.ROUND_STATE) ──
export const RoundState = engine.defineComponent(
  'bz-round-state',
  {
    roundId: Schemas.Int,
    endsAtMs: Schemas.Int64
  },
  { roundId: 0, endsAtMs: 0 }
)

// ── Server heartbeat (singleton, SyncIds.HEARTBEAT) ──
// Kept separate from RoundState so the 2s pulse doesn't re-send round data.
export const ServerHeartbeat = engine.defineComponent(
  'bz-heartbeat',
  {
    tickMs: Schemas.Int64
  },
  { tickMs: 0 }
)

// ── Pickup state (singleton, SyncIds.PICKUP_STATE) ──
// JSON array of active pickup ids, e.g. "[0,1,4,7]". Small and only changes on a pickup being taken or respawned.
export const PickupState = engine.defineComponent(
  'bz-pickup-state',
  {
    activeJson: Schemas.String
  },
  { activeJson: '[]' }
)

// ── Per-player state (auto sync id, matched by playerId field) ──
export const PlayerState = engine.defineComponent(
  'bz-player-state',
  {
    playerId: Schemas.String,
    health: Schemas.Int,
    bullets: Schemas.Int,
    rockets: Schemas.Int,
    boostMs: Schemas.Int,
    boosting: Schemas.Boolean,
    collectedBullets: Schemas.Int,
    collectedRockets: Schemas.Int,
    collectedBoostMs: Schemas.Int,
    kills: Schemas.Int,
    droneKills: Schemas.Int,
    deaths: Schemas.Int,
    alive: Schemas.Boolean,
    respawnAtMs: Schemas.Int64,
    roundId: Schemas.Int,
    inLobby: Schemas.Boolean,
    switchAtMs: Schemas.Int64
  },
  {
    playerId: '',
    health: 0,
    bullets: 0,
    rockets: 0,
    boostMs: 0,
    boosting: false,
    collectedBullets: 0,
    collectedRockets: 0,
    collectedBoostMs: 0,
    kills: 0,
    droneKills: 0,
    deaths: 0,
    alive: false,
    respawnAtMs: 0,
    roundId: 0,
    inLobby: true,
    switchAtMs: 0
  }
)

// ── Per-drone state (auto sync id, matched by droneId field) ──
// Position + velocity snapshot written at DRONE_SYNC_INTERVAL;
export const DroneState = engine.defineComponent(
  'bz-drone-state',
  {
    droneId: Schemas.Int,
    active: Schemas.Boolean,
    hp: Schemas.Int,
    px: Schemas.Float,
    py: Schemas.Float,
    pz: Schemas.Float,
    vx: Schemas.Float,
    vy: Schemas.Float,
    vz: Schemas.Float
  },
  { droneId: 0, active: false, hp: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0 }
)

// ── Death drops (pooled, auto sync id, matched by dropId field)
export const DropState = engine.defineComponent(
  'bz-drop-state',
  {
    dropId: Schemas.Int,
    active: Schemas.Boolean,
    kind: Schemas.Int,
    amount: Schemas.Int,
    x: Schemas.Float,
    y: Schemas.Float,
    z: Schemas.Float
  },
  { dropId: 0, active: false, kind: 0, amount: 0, x: 0, y: 0, z: 0 }
)

// ── Leaderboard (singleton, SyncIds.LEADERBOARD) ──
export const LeaderboardState = engine.defineComponent(
  'bz-leaderboard',
  {
    allTimeJson: Schemas.String, // BoardRow[]
    eventJson: Schemas.String, // EventRow[]
    eventLabel: Schemas.String, // event id, for the tab
    eventBoardActive: Schemas.Boolean, // show the EVENT tab at all
    updatedAtMs: Schemas.Int64
  },
  { allTimeJson: '[]', eventJson: '[]', eventLabel: '', eventBoardActive: false, updatedAtMs: 0 }
)

// ── Server-only write protection ──
if (isServer()) {
  const serverOnly = (value: { senderAddress: string }) => value.senderAddress === AUTH_SERVER_PEER_ID
  RoundState.validateBeforeChange(serverOnly)
  ServerHeartbeat.validateBeforeChange(serverOnly)
  PickupState.validateBeforeChange(serverOnly)
  PlayerState.validateBeforeChange(serverOnly)
  DroneState.validateBeforeChange(serverOnly)
  DropState.validateBeforeChange(serverOnly)
  LeaderboardState.validateBeforeChange(serverOnly)
}
