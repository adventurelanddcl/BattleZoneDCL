// BattleZone server — persistent stats, the all-time board, and events.
//
// Storage is durable persistence, not a live datastore, so nothing here writes
// during a round: working state is held in memory and flushed once, at round
// end. That is also what keeps the write count under the isolate's in-flight
// host-call cap - an over-frequent Storage.set resolves false and loses the
// write silently.
//
// What ends up at decentraland.org/storage:
//   scene  leaderboard        the published top-N board
//   scene  events             THE EVENT CONFIG
//   scene  event-wins:<id>    standings for one event
//   scene  round:<endedAtMs>  one debug record per round, who played and what
//   scene  rounds             which round keys exist, oldest first
//   player stats              that player's all-time totals

import { Storage } from '@dcl/sdk/server'
import {
  KEY_LEADERBOARD, KEY_EVENTS, KEY_EVENT_WINS, KEY_ROUND, KEY_ROUND_INDEX, KEY_PLAYER_STATS,
  LEADERBOARD_MAX, ROUND_LOG_MAX, EVENT_TYPE_ROUND_WINS,
  EventConfig, PlayerTotals, BoardRow, EventRow, RoundRecord, RoundPlayerRecord,
  emptyTotals, normaliseTotals, latestEvent
} from '../shared/stats'

// ── in-memory truth ──

/** address -> all-time totals. Loaded lazily per player, flushed at round end. */
const totals = new Map<string, PlayerTotals>()
/** Addresses whose totals changed and have not been written yet. */
const dirtyTotals = new Set<string>()
/** Best-known display name per address, from AvatarBase. */
const names = new Map<string, string>()
/** Set when a name or a freshly loaded record could change the published board. */
let boardDirty = false
/** Everyone who actually took to the air this round. */
const participants = new Set<string>()

/**
 * Crates picked up this round, per player. Deliberately NOT a PlayerState
 * field: nothing on the HUD shows it, and a synced field would push the number
 * to every client on every crate for no one's benefit.
 */
interface Collected {
  bullets: number
  rockets: number
  boostMs: number
}
const collected = new Map<string, Collected>()

/** Counts a crate against the collector. Called from the pickup handlers. */
export function noteCollected(address: string, bullets: number, rockets: number, boostMs: number) {
  const row = collected.get(address) ?? { bullets: 0, rockets: 0, boostMs: 0 }
  row.bullets += bullets
  row.rockets += rockets
  row.boostMs += boostMs
  collected.set(address, row)
}

/**
 * This round s crate tally for one player. Read by the end-of-round scoreboard
 * BEFORE recordRound() folds it into the all-time totals and clears it - the map is per round, not cumulative.
 */
export function collectedFor(address: string): Collected {
  return collected.get(address) ?? { bullets: 0, rockets: 0, boostMs: 0 }
}

/** Rows of the published board, sorted, longest-standing source of truth for
 * players who have not been seen this session. */
let board: BoardRow[] = []

let events: EventConfig[] = []
let current: EventConfig | null = null
/** Standings for `current`, address -> wins. */
let eventWins = new Map<string, EventRow>()
let eventWinsLoadedFor = ''

/** Keys of stored round records, oldest first. */
let roundKeys: string[] = []

/**
 * What the server should publish. `version` bumps on every change so the
 * caller can write the synced component only when there is something new.
 */
export const leaderboardView = {
  version: 0,
  allTimeJson: '[]',
  eventJson: '[]',
  eventLabel: '',
  eventBoardActive: false
}

// ── loading ──

/** Reads everything that must survive a restart. Call once, at boot. */
export async function loadLeaderboard(): Promise<void> {
  board = (await safeGet<BoardRow[]>(KEY_LEADERBOARD)) ?? []
  roundKeys = (await safeGet<string[]>(KEY_ROUND_INDEX)) ?? []
  await refreshEvents()
  // Deliberately NOT seeded from `board`: a board row carries only kills and
  // drone kills, so seeding would put a record with deaths/rounds zeroed into
  // `totals`, loadPlayerTotals would then skip the real one as already loaded,
  // and round end would write the partial record over the player's history.
  // `totals` is only ever filled from a player's own stored key.
  publish()
  console.log('[SERVER] leaderboard loaded:', board.length, 'rows,', roundKeys.length, 'round records')
}

/**
 * Re-reads event config. Called on a timer, with the read cache
 * bypassed, so an edit made in the storage UI takes effect on a running server
 * without a redeploy.
 */
export async function refreshEvents(): Promise<void> {
  const loaded = await safeGet<EventConfig[]>(KEY_EVENTS, true)
  if (loaded === null) {
    // Seed a disabled template the first time, so the storage UI shows the
    // shape to copy rather than an empty box.
    events = [{ id: 'event-1', index: 1, type: EVENT_TYPE_ROUND_WINS, eventActive: false, leaderboardActive: false }]
    await safeSet(KEY_EVENTS, events)
  } else {
    events = Array.isArray(loaded) ? loaded.filter(isEventConfig) : []
  }

  const next = latestEvent(events)
  current = next
  if (next !== null && eventWinsLoadedFor !== next.id) {
    const stored = (await safeGet<EventRow[]>(KEY_EVENT_WINS + next.id)) ?? []
    eventWins = new Map(stored.map((row) => [row.id, row]))
    eventWinsLoadedFor = next.id
  }
  if (next === null) {
    eventWins = new Map()
    eventWinsLoadedFor = ''
  }
  publish()
}

/** Pulls a player's totals into memory the first time we see them. */
export async function loadPlayerTotals(address: string): Promise<void> {
  if (totals.has(address)) return
  const stored = await safeGetPlayer<PlayerTotals>(address, KEY_PLAYER_STATS)
  // Another load may have finished while this one was in flight; the stored
  // value is the older of the two, so do not clobber.
  if (totals.has(address)) return
  totals.set(address, normaliseTotals(stored, names.get(address) ?? ''))
  boardDirty = true
}

// ── live bookkeeping (no I/O) ──

/** Remembers a display name; the leaderboard shows people who are offline. */
export function noteName(address: string, name: string) {
  if (name === '' || name.startsWith('0x')) return
  if (names.get(address) === name) return
  names.set(address, name)
  const record = totals.get(address)
  if (record) record.name = name
  boardDirty = true
}

/** Marks a player as having actually flown this round. */
export function markParticipant(address: string) {
  participants.add(address)
}

export function displayNameFor(address: string): string {
  return names.get(address) ?? totals.get(address)?.name ?? ''
}

// ── round end ──

/**
 * Folds one finished round into the all-time totals, the event standings and
 * the debug log, then republishes the board.
 *
 * The caller passes a SNAPSHOT: the round reset that follows immediately zeroes
 * every PlayerState, so reading them from here would find nothing but zeroes.
 */
export async function recordRound(roundId: number, endedAtMs: number, roundLengthMs: number, rows: RoundPlayerRecord[]) {
  const played = rows.filter((row) => participants.has(row.id))
  // Cleared synchronously, before the first await: the round reset that runs straight after this call marks the next round's participants.
  for (const row of played) {
    const picked = collected.get(row.id)
    if (picked === undefined) continue
    row.bulletsCollected += picked.bullets
    row.rocketsCollected += picked.rockets
    row.boostCollectedMs += picked.boostMs
  }
  participants.clear()
  collected.clear()
  if (played.length === 0) return

  // Make sure every participant's stored totals are in memory first. Without
  // this, a player whose load was still in flight would be folded into a fresh
  // zeroed record - and that record would then be written over their real
  // history a few lines below.
  for (const row of played) await loadPlayerTotals(row.id)

  // winners = most player kills, and more than none.
  let bestKills = 0
  for (const row of played) bestKills = Math.max(bestKills, row.kills)
  const winners = bestKills > 0 ? played.filter((row) => row.kills === bestKills).map((row) => row.id) : []

  for (const row of played) {
    const record = totals.get(row.id) ?? emptyTotals(row.name)
    record.name = row.name !== '' ? row.name : record.name
    record.kills += row.kills
    record.droneKills += row.droneKills
    record.deaths += row.deaths
    record.bulletsCollected += row.bulletsCollected
    record.rocketsCollected += row.rocketsCollected
    record.boostCollectedMs += row.boostCollectedMs
    record.rounds += 1
    record.lastSeenMs = endedAtMs
    totals.set(row.id, record)
    dirtyTotals.add(row.id)
  }

  const scoringEvent = current !== null && current.eventActive && current.type === EVENT_TYPE_ROUND_WINS
  if (scoringEvent && winners.length > 0) {
    // One round is worth one win, however many people tied for it — two get
    // half each, three a third each etc.
    const share = Math.round((1 / winners.length) * 100) / 100
    for (const id of winners) {
      const row = eventWins.get(id) ?? { id, name: displayNameFor(id), wins: 0 }
      row.wins = Math.round((row.wins + share) * 100) / 100
      row.name = displayNameFor(id) || row.name
      eventWins.set(id, row)
    }
  }

  rebuildBoard()
  publish()

  // ── persist, serially ──
  // Serial rather than Promise.all on purpose: a busy round end would otherwise
  // fire ~20 writes at once against a 40 in-flight host-call cap shared with everything else the isolate is doing.
  for (const address of Array.from(dirtyTotals)) {
    const record = totals.get(address)
    if (record === undefined) {
      dirtyTotals.delete(address)
      continue
    }
    if (await safeSetPlayer(address, KEY_PLAYER_STATS, record)) dirtyTotals.delete(address)
  }

  await safeSet(KEY_LEADERBOARD, board)

  if (scoringEvent && current !== null) {
    await safeSet(KEY_EVENT_WINS + current.id, Array.from(eventWins.values()))
  }

  await writeRoundRecord({
    roundId,
    startedAtMs: endedAtMs - roundLengthMs,
    endedAtMs,
    endedAt: new Date(endedAtMs).toISOString(),
    winners,
    players: played
  })
}

/** Debug record for one round, plus pruning of the oldest. */
async function writeRoundRecord(record: RoundRecord) {
  const key = KEY_ROUND + record.endedAtMs
  if (!(await safeSet(key, record))) return

  roundKeys.push(key)
  while (roundKeys.length > ROUND_LOG_MAX) {
    const oldest = roundKeys.shift()
    if (oldest !== undefined) await safeDelete(oldest)
  }
  await safeSet(KEY_ROUND_INDEX, roundKeys)
}

// ── publishing ──

/**
 * Merges this session's totals into the stored board and re-sorts. Players
 * below the cut keep their own `stats` key - they are simply not published
 * until they climb back into the top LEADERBOARD_MAX.
 */
function rebuildBoard() {
  const merged = new Map<string, BoardRow>()
  for (const row of board) merged.set(row.id, { ...row })
  for (const [address, record] of totals) {
    merged.set(address, {
      id: address,
      name: record.name !== '' ? record.name : (names.get(address) ?? ''),
      kills: record.kills,
      droneKills: record.droneKills,
      deaths: record.deaths,
      bullets: record.bulletsCollected,
      rockets: record.rocketsCollected,
      boostMs: record.boostCollectedMs
    })
  }
  board = Array.from(merged.values())
    .sort((a, b) => b.kills - a.kills || b.droneKills - a.droneKills || a.id.localeCompare(b.id))
    .slice(0, LEADERBOARD_MAX)
}

function publish() {
  const eventRows = Array.from(eventWins.values())
    .sort((a, b) => b.wins - a.wins || a.id.localeCompare(b.id))
    .slice(0, LEADERBOARD_MAX)

  const allTimeJson = JSON.stringify(board)
  const eventJson = JSON.stringify(eventRows)
  const eventLabel = current?.id ?? ''
  const eventBoardActive = current !== null && current.leaderboardActive

  if (
    allTimeJson === leaderboardView.allTimeJson &&
    eventJson === leaderboardView.eventJson &&
    eventLabel === leaderboardView.eventLabel &&
    eventBoardActive === leaderboardView.eventBoardActive
  ) {
    return
  }

  leaderboardView.allTimeJson = allTimeJson
  leaderboardView.eventJson = eventJson
  leaderboardView.eventLabel = eventLabel
  leaderboardView.eventBoardActive = eventBoardActive
  leaderboardView.version += 1
}

/**
 * Republishes after names or freshly loaded totals arrive. Called every second,
 * so it does nothing unless something actually changed - rebuilding and
 * re-serialising a 100-row board once a second for no reason is pure waste.
 */
export function refreshPublished() {
  if (!boardDirty) return
  boardDirty = false
  rebuildBoard()
  publish()
}

// ── Storage wrappers ──
// Every call is wrapped: a storage failure must never take the round down with
// it, and set() resolving false is a silent loss unless it is checked.

function isEventConfig(value: unknown): value is EventConfig {
  const event = value as EventConfig
  return (
    typeof event?.id === 'string' &&
    typeof event?.index === 'number' &&
    typeof event?.type === 'number' &&
    typeof event?.eventActive === 'boolean' &&
    typeof event?.leaderboardActive === 'boolean'
  )
}

async function safeGet<T>(key: string, fresh = false): Promise<T | null> {
  try {
    return await Storage.get<T>(key, { fresh })
  } catch (err) {
    console.error('[SERVER] storage get failed:', key, err)
    return null
  }
}

async function safeGetPlayer<T>(address: string, key: string): Promise<T | null> {
  try {
    return await Storage.player.get<T>(address, key)
  } catch (err) {
    console.error('[SERVER] player storage get failed:', address, key, err)
    return null
  }
}

async function safeSet(key: string, value: unknown): Promise<boolean> {
  try {
    const ok = await Storage.set(key, value)
    if (!ok) console.error('[SERVER] storage set did not persist:', key)
    return ok
  } catch (err) {
    console.error('[SERVER] storage set failed:', key, err)
    return false
  }
}

async function safeSetPlayer(address: string, key: string, value: unknown): Promise<boolean> {
  try {
    const ok = await Storage.player.set(address, key, value)
    if (!ok) console.error('[SERVER] player storage set did not persist:', address, key)
    return ok
  } catch (err) {
    console.error('[SERVER] player storage set failed:', address, key, err)
    return false
  }
}

async function safeDelete(key: string): Promise<void> {
  try {
    await Storage.delete(key)
  } catch (err) {
    console.error('[SERVER] storage delete failed:', key, err)
  }
}
