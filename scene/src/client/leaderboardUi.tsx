// BattleZone client — the LEADERBOARD tab.
//
// Two sub-boards: ALL TIME (running totals), ROUND and EVENT Portraits come from `avatarTexture`,
// the engine's own avatar render — it arrives with a transparent background and needs no profile fetch or media-hostname permission.

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { isMobile } from '@dcl/sdk/platform'
import { Color4 } from '@dcl/sdk/math'
import {
  UI_RIM, UI_TAB_BG, UI_TAB_ACTIVE_BG, UI_TEXT, UI_TEXT_DIM, UI_ACCENT,
  ICON_KILLS, ICON_DRONES
} from './uiAssets'
import { allTimeRows, eventRows, isEventBoardActive, eventLabel } from './leaderboard'
import { getLocalAddress, playerStates, displayName } from './serverLink'
import { coinsFor } from '../shared/constants'

/** Row geometry. Ten rows plus the header fit the panel on a phone; a desktop
 * panel is taller and simply shows more before the list needs scrolling. */
const ROW_HEIGHT = 54
const ROW_GAP = 4
const HEADER_HEIGHT = 46
/** BoardHeader's own bottom margin. Its wrapper has to allow for it. */
const HEADER_MARGIN = 2

/**
 * Width of the scrollbar gutter a scroll container reserves on the right.
 *
 * The row list is a scroll container and reserves this whether or not it has
 * anything to scroll, which squeezes its columns inward. The header is not one
 * — it must not be, or it draws a scrollbar of its own — so it is padded by the
 * same amount by hand. Without it the headings sit a gutter's width right of
 * the data they label.
 *
 * MEASURED BY EYE.
 */
const SCROLL_GUTTER = 26
const SUBTAB_HEIGHT = 40

/**
 * Column widths, in the order the columns are read.
 *
 * Every one is FIXED, the name included. Giving the name flexGrow let a long
 * one take the slack and shove the stat columns out of line with the headings
 * above them - and, once it ran out of room, wrap onto a second line.
 *
 * They must also add up to comfortably LESS than the panel's ~1158 virtual px.
 * flexShrink defaults to 0 here, so a row that does not fit is not compressed -
 * it simply runs off the right edge, which is what pushed the numbers out from
 * under their headings. The total below leaves real slack for a phone
 * where the safe-area inset eats into the usable width. Currently ~1050.
 */
const COL_RANK = 64
/** Clear space between the rank and the portrait. */
const RANK_GAP = 8
/**
 * The avatar render is square, so the box is too. (0.75 on PC and 1.25 on
 * mobile each looked right at one point - but that was measuring a row that was
 * overflowing, not the texture. With the row inside its width budget, 1:1 is
 * correct on both.)
 *
 * 'center' is the no-distortion fallback, at the cost of cropping to the middle
 * of the image - that is what made it look zoomed in.
 */
const COL_PORTRAIT_H = 54
const COL_PORTRAIT_W = COL_PORTRAIT_H
/** Cell around the portrait; the surplus is the breathing room either side. */
const COL_PORTRAIT_CELL = 74

/**
 * Six stat columns share the row. Width buys two things at once: the gap
 * between one column's numbers and the next, and room for a heading beside its
 * icon — at 78 "PLAYER" was wrapping onto a second line.
 */
const COL_SCORE = 92
/** Room for a long DCL name on one line. */
const COL_NAME = 340
const NAME_LEFT = 12
/** Kill icons in the headings, matching the HUD's own stat chips. */
const HEADER_ICON = 16
const HEADER_ICON_GAP = 5
/**
 * Label box beside a heading icon: everything the icon does not use, rather
 * than a width estimated from the text. Text measures wider on mobile than on
 * desktop, so a value hand-picked to just fit on PC wraps on a phone.
 */
const HEADER_LABEL_W = COL_SCORE - HEADER_ICON - HEADER_ICON_GAP
/**
 * How far right a number is nudged in a column whose heading carries an icon.
 *
 * Those headings are not visually centred in their cell: the text is pushed
 * against the icon, and the icon hangs off the end of it, so the ink as a whole
 * sits right of centre. A number centred in the cell therefore reads as sitting
 * left of its heading. This shifts it by the same amount without changing the
 * column's width - the label gives up twice this at its left edge and takes it
 * back as margin.
 */
const ICON_COLUMN_SHIFT = 12

/** A stat column: its heading, and the icon that stands for it (if any). */
export interface StatColumn {
  label: string
  icon?: string
}

/**
 * Text sizes, per platform.
 *
 * Box widths are virtual units and identical everywhere, but the SAME fontSize
 * does not cover the same number of virtual pixels on a phone as on a monitor -
 * mobile text comes out proportionally wider, which is why every width picked
 * to fit on PC has then wrapped on mobile. Rather than keep guessing at
 * per-column widths, the text is scaled down on mobile so it needs less room,
 * and the name is clipped shorter there.
 */
const FONT_NAME = () => (isMobile() ? 16 : 19)
const FONT_SCORE = () => (isMobile() ? 16 : 18)
const FONT_RANK = () => (isMobile() ? 17 : 19)
/**
 * Column headings. Raised from 10/12, which was legible on a monitor and barely
 * so on a phone.
 *
 * Every heading still fits its column except ROUND WINS, the all-time board's
 * only one, which needs 99 of its 92 and wraps to two lines. That is allowed
 * for: HeaderCell gives its label two lines' worth of height precisely so a
 * wrap stays readable, and a wrap changes the cell's height without moving the
 * column. The round-end board's longest heading, ROCKETS, needs 69 and is not
 * close to wrapping.
 */
const FONT_HEADER = () => (isMobile() ? 13 : 16)
/**
 * Space between the column headings and the first row, applied as a TOP margin
 * on the row list.
 *
 * Not as a bottom margin on the header or its wrapper: the wrapper is a scroll
 * container, so anything that makes its content taller than itself gives the
 * headings a scrollbar of their own instead of a gap.
 */
const HEADER_GAP = 8
/** Longest name drawn before it is clipped, so it cannot reach a second line. */
const nameMaxChars = () => (isMobile() ? 16 : 24)

const ROW_BG = Color4.create(1, 1, 1, 0.05)
const ROW_BG_SELF = Color4.create(UI_ACCENT.r, UI_ACCENT.g, UI_ACCENT.b, 0.16)

/** ALL TIME | ROUND | EVENT. Module state, like the menu's own tab selection. */
type BoardMode = 'all' | 'round' | 'event'
/**
 * ROUND by default: the menu is opened during a fight far more often than
 * between them, and what a pilot wants then is where they stand right now.
 * The all-time totals are still one tap away and do not change mid-round.
 */
let boardMode: BoardMode = 'round'

/**
 * The current round, live, from the synced PlayerState of everyone present.
 *
 * No server call and no new message: every number here is already replicated
 * for the HUD and the trail, so the board is simply a different reading of what
 * this client already holds. It follows the round rather than a snapshot, which
 * is the point — it can be opened mid-fight.
 *
 * Sorted exactly as the end-of-round board is (see endRound), so the standings
 * a player watches climb are the ones they finish on.
 */
function roundRows() {
  const list = []
  for (const [address, state] of playerStates) {
    list.push({
      id: address,
      name: displayName(address),
      kills: state.kills,
      droneKills: state.droneKills,
      deaths: state.deaths,
      bullets: state.collectedBullets,
      rockets: state.collectedRockets,
      boostMs: state.collectedBoostMs
    })
  }
  list.sort((a, b) => b.kills - a.kills || b.droneKills - a.droneKills || a.deaths - b.deaths)
  return list
}

function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

/** A name only if we have a real one — an address is not a display name. */
function rowName(name: string, address: string): string {
  const value = name !== '' && !name.startsWith('0x') ? name : shortAddress(address)
  // Belt and braces with COL_NAME: a name past any sane length is clipped
  // rather than allowed to wrap and break the row's alignment.
  const max = nameMaxChars()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function SubTab(props: { key?: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <UiEntity
      uiTransform={{
        height: SUBTAB_HEIGHT,
        // even both sides: a right-only margin would push a centred group off-centre by half of it
        margin: { left: 5, right: 5 },
        padding: { left: 18, right: 18 },
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: props.active ? UI_RIM : Color4.create(UI_RIM.r, UI_RIM.g, UI_RIM.b, 0.3),
        pointerFilter: 'block'
      }}
      uiBackground={{ color: props.active ? UI_TAB_ACTIVE_BG : UI_TAB_BG }}
      onMouseDown={props.onClick}
    >
      <Label
        value={props.label}
        fontSize={15}
        color={props.active ? UI_TEXT : UI_TEXT_DIM}
        textAlign="middle-center"
        uiTransform={{ height: 22 }}
      />
    </UiEntity>
  )
}

/**
 * The box every stat column is drawn in, header and row alike.
 *
 * Both sides go through this so a heading and the numbers under it are laid out
 * by identical boxes — the numbers were a bare Label while the heading was a
 * flex container, and the two did not land in the same place.
 */
function statCell(height: number) {
  return {
    width: COL_SCORE,
    height,
    flexDirection: 'row' as const,
    justifyContent: 'center' as const,
    alignItems: 'center' as const
  }
}

/** One heading, optionally with the HUD icon that stands for the stat. */
function HeaderCell(props: { key?: string; label: string; icon?: string }) {
  return (
    <UiEntity uiTransform={statCell(HEADER_HEIGHT)}>
      <Label
        value={props.label}
        fontSize={FONT_HEADER()}
        color={UI_TEXT_DIM}
        textAlign={props.icon !== undefined ? 'middle-right' : 'middle-center'}
        // two lines' worth of height: if a heading does wrap it stays legible,
        // and a wrap only ever changes height - it cannot move the column
        uiTransform={{ width: props.icon !== undefined ? HEADER_LABEL_W : COL_SCORE, height: 38 }}
      />
      {props.icon !== undefined ? (
        <UiEntity
          uiTransform={{ width: HEADER_ICON, height: HEADER_ICON, margin: { left: HEADER_ICON_GAP } }}
          // white silhouette with an alpha mask, tinted by `color` — same as
          // the HUD stat chips these icons come from
          uiBackground={{ texture: { src: props.icon }, textureMode: 'stretch', color: UI_TEXT_DIM }}
        />
      ) : null}
    </UiEntity>
  )
}

/** Column headings. Widths are shared with LeaderRow so the two line up. */
export function BoardHeader(props: { columns: StatColumn[] }) {
  const scores = props.columns.map((column, i) => (
    <HeaderCell key={`h${i}`} label={column.label} icon={column.icon} />
  ))
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: HEADER_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        margin: { bottom: HEADER_MARGIN }
      }}
    >
      <Label value="#" fontSize={FONT_HEADER()} color={UI_TEXT_DIM} textAlign="middle-center" uiTransform={{ width: COL_RANK, height: 24, margin: { right: RANK_GAP } }} />
      <UiEntity uiTransform={{ width: COL_PORTRAIT_CELL, height: 24 }} />
      <Label value="PILOT" fontSize={FONT_HEADER()} color={UI_TEXT_DIM} textAlign="middle-left" uiTransform={{ width: COL_NAME, height: 24, margin: { left: NAME_LEFT } }} />
      {scores}
    </UiEntity>
  )
}

/**
 * One board row: rank, portrait, name, then one or two score columns.
 *
 * The portrait is `avatarTexture`, which the explorer renders from the account
 * itself — it works for players who are not in the scene, which is most of a
 * leaderboard.
 */
export function LeaderRow(props: {
  key?: string
  rank: number
  address: string
  name: string
  columns: StatColumn[]
  scores: string[]
}) {
  const isSelf = props.address.toLowerCase() === getLocalAddress()
  const scores = props.scores.map((value, i) => {
    // matched to its heading: shifted only where that heading carries an icon
    const shift = props.columns[i]?.icon !== undefined ? ICON_COLUMN_SHIFT : 0
    return (
      <UiEntity key={`s${i}`} uiTransform={statCell(ROW_HEIGHT)}>
        <Label
          value={value}
          fontSize={FONT_SCORE()}
          color={UI_TEXT}
          textAlign="middle-center"
          // width + margin still totals COL_SCORE, so the shift moves the text
          // without moving the column
          uiTransform={{ width: COL_SCORE - shift * 2, height: 26, margin: { left: shift * 2 } }}
        />
      </UiEntity>
    )
  })

  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: ROW_HEIGHT,
        margin: { bottom: ROW_GAP },
        flexDirection: 'row',
        alignItems: 'center'
      }}
      uiBackground={{ color: isSelf ? ROW_BG_SELF : ROW_BG }}
    >
      <Label
        value={`${props.rank}.`}
        fontSize={FONT_RANK()}
        color={props.rank <= 3 ? UI_ACCENT : UI_TEXT_DIM}
        textAlign="middle-center"
        uiTransform={{ width: COL_RANK, height: 26, margin: { right: RANK_GAP } }}
      />
      <UiEntity uiTransform={{ width: COL_PORTRAIT_CELL, height: COL_PORTRAIT_H, justifyContent: 'center', alignItems: 'center' }}>
        <UiEntity
          uiTransform={{ width: COL_PORTRAIT_W, height: COL_PORTRAIT_H }}
          uiBackground={{ textureMode: 'stretch', avatarTexture: { userId: props.address } }}
        />
      </UiEntity>
      <Label
        value={rowName(props.name, props.address)}
        fontSize={FONT_NAME()}
        color={UI_TEXT}
        textAlign="middle-left"
        uiTransform={{ width: COL_NAME, height: 26, margin: { left: NAME_LEFT } }}
      />
      {scores}
    </UiEntity>
  )
}

// key has to be declared, like MenuTab's - React-ECS does not special-case it
export function EmptyBoard(props: { key?: string; text: string }) {
  return (
    <UiEntity uiTransform={{ width: '100%', height: 120, justifyContent: 'center', alignItems: 'center' }}>
      <Label value={props.text} fontSize={18} color={UI_TEXT_DIM} textAlign="middle-center" uiTransform={{ width: '100%', height: 26 }} />
    </UiEntity>
  )
}

export function Leaderboard() {
  const eventLive = isEventBoardActive()
  // An event can close while its tab is selected; fall back rather than rendering a board that is no longer there.
  const mode: BoardMode = boardMode === 'event' && !eventLive ? 'all' : boardMode
  const showingEvent = mode === 'event'

  const subTabs = [
    <SubTab key="st-all" label="ALL TIME" active={mode === 'all'} onClick={() => { boardMode = 'all' }} />,
    <SubTab key="st-round" label="ROUND" active={mode === 'round'} onClick={() => { boardMode = 'round' }} />
  ]
  if (eventLive) {
    // Just EVENT: the configured id is a storage key, not a player-facing name.
    subTabs.push(<SubTab key="st-event" label="EVENT" active={showingEvent} onClick={() => { boardMode = 'event' }} />)
  }

  // ROUND shows the same six as ALL TIME, so the live standings and the totals they feed read identically.
  const columns: StatColumn[] = showingEvent
    ? [{ label: 'ROUND WINS' }]
    : [
        { label: 'PLAYER', icon: ICON_KILLS },
        { label: 'DRONE', icon: ICON_DRONES },
        { label: 'DEATHS' },
        { label: 'BULLETS' },
        { label: 'ROCKETS' },
        { label: 'BOOST' }, // banked in ms, shown in whole seconds
        { label: 'COINS' } // derived from the two kill columns — see coinsFor
      ]

  const rows = []
  if (showingEvent) {
    const list = eventRows()
    for (let i = 0; i < list.length; i++) {
      const row = list[i]
      rows.push(
        <LeaderRow key={`ev${row.id}`} rank={i + 1} address={row.id} name={row.name} columns={columns} scores={[`${row.wins}`]} />
      )
    }
    if (list.length === 0) rows.push(<EmptyBoard key="ev-empty" text="No round wins yet — win a round to get on the board." />)
  } else if (mode === 'round') {
    const list = roundRows()
    for (let i = 0; i < list.length; i++) {
      const row = list[i]
      rows.push(
        <LeaderRow
          key={`rd${row.id}`}
          rank={i + 1}
          address={row.id}
          name={row.name}
          columns={columns}
          scores={[
            `${row.kills}`,
            `${row.droneKills}`,
            `${row.deaths}`,
            `${row.bullets}`,
            `${row.rockets}`,
            `${Math.round(row.boostMs / 1000)}`,
            `${coinsFor(row.kills, row.droneKills)}`
          ]}
        />
      )
    }
    if (list.length === 0) rows.push(<EmptyBoard key="rd-empty" text="Nobody is here yet." />)
  } else {
    const list = allTimeRows()
    for (let i = 0; i < list.length; i++) {
      const row = list[i]
      rows.push(
        <LeaderRow
          key={`at${row.id}`}
          rank={i + 1}
          address={row.id}
          name={row.name}
          columns={columns}
          scores={[
            `${row.kills ?? 0}`,
            `${row.droneKills ?? 0}`,
            `${row.deaths ?? 0}`,
            `${row.bullets ?? 0}`,
            `${row.rockets ?? 0}`,
            `${Math.round((row.boostMs ?? 0) / 1000)}`,
            `${coinsFor(row.kills ?? 0, row.droneKills ?? 0)}`
          ]}
        />
      )
    }
    if (list.length === 0) rows.push(<EmptyBoard key="at-empty" text="No rounds finished yet. Totals are added up when a round ends." />)
  }

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', flexDirection: 'column' }}>
      <UiEntity
        uiTransform={{
          width: '100%',
          height: SUBTAB_HEIGHT,
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'center',
          margin: { bottom: 10 }
        }}
      >
        {subTabs}
      </UiEntity>

      {/*
        Wrapped in a scroll container it will never actually scroll, purely so
        it has the SAME parent shape as the row list below. A scroll container
        can inset its content (a scrollbar gutter), and with the header outside
        one and the rows inside, that inset moved the rows relative to the
        headings on mobile while PC looked fine.
      */}
      {/*
        NOT a scroll container. UiTransform has `overflow` and nothing else —
        no scrollbar-visibility field — so `overflow: 'scroll'` draws a bar
        whether or not there is anything to scroll, and the column headings
        ended up with a little scrollbar of their own.

        The wrapper used to be one so it would carry the same scrollbar gutter
        as the row list and keep the headings lined up with their columns. The
        gutter came WITH the bar, so it is reproduced by hand instead — see
        SCROLL_GUTTER for the padding that stands in for it.
      */}
      <UiEntity
        uiTransform={{
          width: '100%',
          height: HEADER_HEIGHT + HEADER_MARGIN,
          flexDirection: 'column',
          // stands in for the row list's scrollbar gutter — see SCROLL_GUTTER
          padding: { right: SCROLL_GUTTER }
        }}
      >
        <BoardHeader columns={columns} />
      </UiEntity>

      {/* the list scrolls; the header above it does not. The gap between the
          two lives here, as a top margin, for the reason at HEADER_GAP. */}
      <UiEntity
        uiTransform={{
          width: '100%',
          flexGrow: 1,
          flexDirection: 'column',
          overflow: 'scroll',
          margin: { top: HEADER_GAP }
        }}
      >
        {rows}
      </UiEntity>
    </UiEntity>
  )
}
