// BattleZone — client<->server messages. Statically imported from index.ts
// (registerMessages defines a component internally and must run before the engine seals).

import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // ── Client → Server ──
  // Rejoin after the death cooldown (also a no-op keep-alive on join).
  requestSpawn: Schemas.Map({ t: Schemas.Int64 }),
  // Lobby <-> play. Neither takes effect at once: the server stamps switchAtMs
  // and makes the change itself once the wait is up, so the countdown is not
  // something a client can skip.
  requestPlay: Schemas.Map({ t: Schemas.Int64 }),
  requestLobby: Schemas.Map({ t: Schemas.Int64 }),
  // Calls off an armed switch before it fires (the X on the button).
  cancelSwitch: Schemas.Map({ t: Schemas.Int64 }),
  // Fired a volley/rocket. Origin + dir let other clients draw the tracer;
  // the server decrements ammo and validates the origin against its own view.
  fireBullet: Schemas.Map({
    ox: Schemas.Float, oy: Schemas.Float, oz: Schemas.Float,
    dx: Schemas.Float, dy: Schemas.Float, dz: Schemas.Float
  }),
  fireRocket: Schemas.Map({
    ox: Schemas.Float, oy: Schemas.Float, oz: Schemas.Float,
    dx: Schemas.Float, dy: Schemas.Float, dz: Schemas.Float
  }),
  // Client-detected hits, validated server-side (distance plausibility, ammo
  // spent, both parties alive) before damage is applied.
  reportPlayerHit: Schemas.Map({
    victimId: Schemas.String,
    weapon: Schemas.String, // 'bullet' | 'rocket'
    x: Schemas.Float, y: Schemas.Float, z: Schemas.Float
  }),
  reportDroneHit: Schemas.Map({
    droneId: Schemas.Int,
    weapon: Schemas.String,
    x: Schemas.Float, y: Schemas.Float, z: Schemas.Float
  }),
  requestPickup: Schemas.Map({ pickupId: Schemas.Int }),
  requestDropPickup: Schemas.Map({ dropId: Schemas.Int }),
  // Boost is spent while the jump button is held. The client brackets the burn
  // with these two and the server bills the elapsed time off its own clock, so
  // a client cannot under-report how long it boosted.
  /**
   * "I am jammed against the terrain."
   */
  reportTerrainHit: Schemas.Map({ t: Schemas.Int64 }),
  boostStart: Schemas.Map({ t: Schemas.Int64 }),
  boostStop: Schemas.Map({ t: Schemas.Int64 }),

  // ── Server → Client ──
  // Remote tracer rendering (relayed fire event, excludes the shooter).
  playerFired: Schemas.Map({
    playerId: Schemas.String,
    weapon: Schemas.String,
    ox: Schemas.Float, oy: Schemas.Float, oz: Schemas.Float,
    dx: Schemas.Float, dy: Schemas.Float, dz: Schemas.Float
  }),
  hitConfirmed: Schemas.Map({
    victimId: Schemas.String,
    attackerId: Schemas.String,
    weapon: Schemas.String,
    victimHealth: Schemas.Int,
    x: Schemas.Float, y: Schemas.Float, z: Schemas.Float
  }),
  planeDestroyed: Schemas.Map({
    victimId: Schemas.String,
    attackerId: Schemas.String, // '' when a drone did it
    cause: Schemas.String, // 'bullet' | 'rocket' | 'drone'
    x: Schemas.Float, y: Schemas.Float, z: Schemas.Float
  }),
  droneExploded: Schemas.Map({
    droneId: Schemas.Int,
    victimId: Schemas.String, // '' when shot down
    byPlayerId: Schemas.String, // '' when it rammed
    x: Schemas.Float, y: Schemas.Float, z: Schemas.Float
  }),
  pickupTaken: Schemas.Map({ pickupId: Schemas.Int, playerId: Schemas.String }),
  dropTaken: Schemas.Map({ dropId: Schemas.Int, playerId: Schemas.String }),
  roundStarted: Schemas.Map({ roundId: Schemas.Int, endsAtMs: Schemas.Int64 }),
  // scoreboardJson is a ScoreRow[] (see shared/stats), already sorted by player kills.
  roundEnded: Schemas.Map({
    roundId: Schemas.Int,
    scoreboardJson: Schemas.String,
    intermissionMs: Schemas.Int
  }),
  denied: Schemas.Map({ reason: Schemas.String })
}

export const room = registerMessages(Messages)
