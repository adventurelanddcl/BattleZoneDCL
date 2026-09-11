// BattleZone — stat and leaderboard record shapes, shared by the server (which writes them to Storage) and the client (which renders them).

/** Scene key: the published all-time board (top LEADERBOARD_MAX rows). */
export const KEY_LEADERBOARD = 'leaderboard'
/** Scene key: the manually edited event config list. See EventConfig. */
export const KEY_EVENTS = 'events'
/** Scene key prefix: per-event standings, one key per event id. */
export const KEY_EVENT_WINS = 'event-wins:'
/** Scene key prefix: one debug record per finished round. */
export const KEY_ROUND = 'round:'
/** Scene key: the list of round keys currently stored, oldest first. */
export const KEY_ROUND_INDEX = 'rounds'
/** Player key: that player's all-time totals. */
export const KEY_PLAYER_STATS = 'stats'

/** Rows published to clients. Per-player totals are kept for everyone. */
export const LEADERBOARD_MAX = 100
/** Debug round records kept before the oldest is pruned. */
export const ROUND_LOG_MAX = 50
/** How often the server re-reads the event config, so manual edits apply live. */
export const EVENT_CONFIG_POLL_MS = 30_000

/** Event kinds. Only round-wins exists so far. */
export const EVENT_TYPE_ROUND_WINS = 0

export interface EventConfig {
  id: string
  index: number
  type: number
  eventActive: boolean
  leaderboardActive: boolean
}

/** A player's all-time totals (player storage, key `stats`). */
export interface PlayerTotals {
  name: string
  kills: number
  droneKills: number
  deaths: number
  /** Crates collected, all time. Boost is in milliseconds, shown as seconds. */
  bulletsCollected: number
  rocketsCollected: number
  boostCollectedMs: number
  rounds: number
  lastSeenMs: number
}

/** One row of the published all-time board. */
export interface BoardRow {
  id: string
  name: string
  kills: number
  droneKills: number
  deaths: number
  bullets: number
  rockets: number
  boostMs: number
}

/** One row of the published event board. */
export interface EventRow {
  id: string
  name: string
  wins: number
}

/** What one player did in one round (debug record + the all-time rollup). */
export interface RoundPlayerRecord {
  id: string
  name: string
  kills: number
  droneKills: number
  deaths: number
  bulletsCollected: number
  rocketsCollected: number
  boostCollectedMs: number
}

/**
 * One line of the end-of-round scoreboard, broadcast to every client while the
 * intermission runs. A subset of RoundPlayerRecord: only what is displayed.
 */
export interface ScoreRow {
  id: string
  name: string
  kills: number
  droneKills: number
  deaths: number
  /** Crates collected during the round. */
  bullets: number
  rockets: number
  boostMs: number
}

/** The debug record written per round. Backend only — never rendered. */
export interface RoundRecord {
  roundId: number
  startedAtMs: number
  endedAtMs: number
  endedAt: string
  /** Most player kills in the round, and >0. Empty when nobody scored. */
  winners: string[]
  players: RoundPlayerRecord[]
}

export function emptyTotals(name = ''): PlayerTotals {
  return {
    name,
    kills: 0, droneKills: 0, deaths: 0,
    bulletsCollected: 0, rocketsCollected: 0, boostCollectedMs: 0,
    rounds: 0, lastSeenMs: 0
  }
}

/**
 * Fills in fields a stored record predates.
 *
 * Records written before a counter existed come back without it, and
 * `undefined + n` is NaN - which would then be written back and poison that
 * player's totals permanently. Every read from storage goes through here.
 */
export function normaliseTotals(raw: Partial<PlayerTotals> | null, name = ''): PlayerTotals {
  const base = emptyTotals(name)
  if (raw === null) return base
  const num = (value: unknown, fallback: number) => (typeof value === 'number' && isFinite(value) ? value : fallback)
  return {
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : base.name,
    kills: num(raw.kills, 0),
    droneKills: num(raw.droneKills, 0),
    deaths: num(raw.deaths, 0),
    bulletsCollected: num(raw.bulletsCollected, 0),
    rocketsCollected: num(raw.rocketsCollected, 0),
    boostCollectedMs: num(raw.boostCollectedMs, 0),
    rounds: num(raw.rounds, 0),
    lastSeenMs: num(raw.lastSeenMs, 0)
  }
}

/** Highest-index event, or null when none is configured. */
export function latestEvent(events: EventConfig[]): EventConfig | null {
  let best: EventConfig | null = null
  for (const event of events) {
    if (best === null || event.index > best.index) best = event
  }
  return best
}
