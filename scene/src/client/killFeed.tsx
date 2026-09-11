// BattleZone client — the kill feed beside the minimap.
//
// Fed by planeDestroyed, which the server already broadcasts to everyone, so
// every pilot sees the same feed with no new traffic and no new state.
//
// Newest first: the list is drawn top down in child order, so a new row appears
// at the top and pushes the rest down on its own.

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { isMobile } from '@dcl/sdk/platform'
import { Color4 } from '@dcl/sdk/math'
import { displayName, getLocalAddress } from './serverLink'
import { UI_READOUT_BG, MINIMAP_SIZE } from './uiAssets'

/** Full opacity for this long... */
const HOLD_MS = 5000
/** ...then out over this long. The row is gone at HOLD + FADE. */
const FADE_MS = 1000

/**
 * Rows on screen at once. A fourth kill drops the oldest row immediately rather
 * than waiting out its three seconds — the feed is for what just happened.
 */
const MAX_ROWS = 3

const ROW_HEIGHT = 26
/**
 * Breathing room inside the tint. Kept small on purpose: charBudget spends the
 * plate on padding first and names second, so every pixel here is a pixel a
 * name cannot have. 4 is enough that the text is not flush against the edge.
 */
const ROW_PAD_X = 1
/**
 * Flush against the minimap's left edge — the plates and the map read as one
 * strip, so there is deliberately no gap here to tune.
 *
 * MINIMAP_SIZE is the map's FULL footprint: UiTransform is border-box, so its
 * 2 px rim is drawn inside that number rather than added to it.
 */
const FEED_RIGHT = MINIMAP_SIZE
const FEED_TOP = 0
/**
 * Plate width, FIXED, and the text is cut to fit it — the reverse of before,
 * where the names decided the width and the plate grew to suit.
 *
 * What bounds it is the top bar, not the text. That block is now
 * STAT_SIDE_WIDTH * 2 + CLOCK_WIDTH = 164 + 100 + 164 = 428 px, so the
 * drone-kill chip's right edge lands (canvas - 428) / 2 in from the right and
 * the feed gets that minus the map's MINIMAP_SIZE. The block was 550 when these
 * two widths were chosen, so there is MORE room now than they assume — they are
 * safe, just no longer tight.
 */
const PLATE_WIDTH_DESKTOP = 392
/**
 * Halfway between the 392 that ran under the drone count and the 240 that fit
 * but cut names to about six characters each. Safe on a canvas of 1432 or
 * wider; if it still overlaps, that canvas is narrower than that and this has
 * to come down again — or the feed has to drop below the bar, which stops the
 * bar bounding it at all.
 */
const PLATE_WIDTH_MOBILE = 332

/**
 * Advance width of one character as a fraction of the font size. The UI font is
 * proportional, so this is a deliberately roomy average — wide capitals run
 * about 0.62 and lowercase nearer 0.5. Erring high costs a character of name
 * length; erring low pushes text past the plate.
 */
const CHAR_WIDTH_RATIO = 0.58

/** Characters that fit on one line of a plate this wide. */
function charBudget(width: number, fontSize: number): number {
  return Math.max(0, Math.floor((width - ROW_PAD_X * 2) / (fontSize * CHAR_WIDTH_RATIO)))
}

/** Cut to `max` characters, the last one spent on an ellipsis. */
function cut(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  if (max === 1) return '…'
  return text.slice(0, max - 1) + '…'
}

/**
 * Share `budget` characters between two names.
 *
 * Half each only when both need it: a short name donates its slack to the other,
 * so 'Ana killed SomeVeryLongName' keeps far more of the long one than an even
 * split would, and neither is cut at all when the pair already fits.
 */
function fitPair(a: string, b: string, budget: number): [string, string] {
  if (a.length + b.length <= budget) return [a, b]
  let aMax = Math.floor(budget / 2)
  let bMax = budget - aMax
  if (a.length < aMax) bMax += aMax - a.length
  else if (b.length < bMax) aMax += bMax - b.length
  return [cut(a, aMax), cut(b, bMax)]
}

const TEXT = Color4.create(1, 1, 1, 1)
/** You did it. */
const TEXT_MINE = Color4.create(0.55, 0.92, 1, 1)
/** It was done to you. */
const TEXT_VICTIM = Color4.create(1, 0.45, 0.35, 1)

interface KillRow {
  key: number
  /** planeDestroyed's cause. 'terrain' reads as a crash, not as a kill. */
  cause: string
  /** Attacker address, or '' for a drone kill. */
  attacker: string
  victim: string
  atMs: number
}

let rows: KillRow[] = []
let nextKey = 1

/**
 * From the planeDestroyed handler. `attacker` is '' when nobody did it — which
 * covers both a drone and the rock, so `cause` is what tells those apart.
 */
export function pushKill(attacker: string, victim: string, cause: string) {
  // Unshift, not push: index 0 is the top of the feed.
  rows.unshift({ key: nextKey++, attacker, victim, cause, atMs: Date.now() })
  if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS)
}

/** Nothing outlives a round; the next one starts with a clean feed. */
export function clearKillFeed() {
  rows = []
}

/** 1 while held, easing to 0 across the fade, 0 once it is over. */
function opacityOf(row: KillRow, now: number): number {
  const age = now - row.atMs
  if (age <= HOLD_MS) return 1
  return Math.max(0, 1 - (age - HOLD_MS) / FADE_MS)
}

export function KillFeed() {
  const now = Date.now()
  // Prune here rather than on a timer: this runs every frame anyway, and a row
  // that has faded out has nothing left to do.
  rows = rows.filter((row) => now - row.atMs < HOLD_MS + FADE_MS)
  if (rows.length === 0) return <UiEntity uiTransform={{ display: 'none' }} />

  const me = getLocalAddress()
  const fontSize = isMobile() ? 18 : 18
  const width = isMobile() ? PLATE_WIDTH_MOBILE : PLATE_WIDTH_DESKTOP
  const budget = charBudget(width, fontSize)

  const lines = rows.map((row) => {
    const alpha = opacityOf(row, now)
    const crashed = row.cause === 'terrain'
    const drone = row.attacker === '' && !crashed
    // Cut to the plate rather than to a fixed name length, so the text can never
    // run past the tint however wide the plate is set.
    let text: string
    if (crashed) {
      const tail = ' crashed'
      text = cut(displayName(row.victim), budget - tail.length) + tail
    } else if (drone) {
      const lead = 'Drone killed '
      text = lead + cut(displayName(row.victim), budget - lead.length)
    } else {
      const [attackerName, victimName] = fitPair(
        displayName(row.attacker),
        displayName(row.victim),
        budget - ' killed '.length
      )
      text = `${attackerName} killed ${victimName}`
    }

    // Tint by whether this one is about you — in a feed everyone shares, your
    // own kills and deaths are the only rows you need to find at a glance.
    let base = TEXT
    if (me !== '' && row.victim.toLowerCase() === me) base = TEXT_VICTIM
    else if (me !== '' && !drone && row.attacker.toLowerCase() === me) base = TEXT_MINE

    // The tint fades WITH the text. Left at a fixed alpha it would outlive the
    // words and leave an empty smear beside the map.
    return (
      <UiEntity
        key={`kf${row.key}`}
        uiTransform={{
          // No margin between rows, deliberately: the plates butt together so a
          // busy feed reads as one block of tint beside the map rather than
          // three separate bars.
          width: '100%', // every plate the same, whatever the names are
          height: ROW_HEIGHT,
          padding: { left: ROW_PAD_X, right: ROW_PAD_X },
          justifyContent: 'center',
          alignItems: 'center'
        }}
        uiBackground={{ color: Color4.create(UI_READOUT_BG.r, UI_READOUT_BG.g, UI_READOUT_BG.b, UI_READOUT_BG.a * alpha) }}
      >
        <Label
          value={text}
          fontSize={fontSize}
          color={Color4.create(base.r, base.g, base.b, alpha)}
          textAlign="middle-right"
        />
      </UiEntity>
    )
  })

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: FEED_TOP, right: FEED_RIGHT },
        width,
        flexDirection: 'column',
        // it is a readout, not a control: never let it eat a tap meant for the
        // action buttons or the camera
        pointerFilter: 'none'
      }}
    >
      {lines}
    </UiEntity>
  )
}
