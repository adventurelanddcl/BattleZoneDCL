// BattleZone client — the end-of-round scoreboard shown during the pause between rounds.

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { isMobile } from '@dcl/sdk/platform'
import { BoardHeader, LeaderRow, EmptyBoard, StatColumn } from './leaderboardUi'
import { MENU_TOP, menuSide, PANEL_PAD, menuBottom, closeMenu } from './menu'
import { ICON_KILLS, ICON_DRONES, UI_PANEL_BG, UI_RIM, UI_ACCENT, UI_TEXT_DIM } from './uiAssets'
import { ScoreRow } from '../shared/stats'
import { coinsFor } from '../shared/constants'

const TITLE_HEIGHT = 40
const SUBTITLE_HEIGHT = 28

/** Same set, in the same order, as the all-time board in the menu. */
const COLUMNS: StatColumn[] = [
  { label: 'PLAYER', icon: ICON_KILLS },
  { label: 'DRONE', icon: ICON_DRONES },
  { label: 'DEATHS' },
  { label: 'BULLETS' },
  { label: 'ROCKETS' },
  { label: 'BOOST' }, // collected in ms, shown in whole seconds
  { label: 'COINS' }
]

let rows: ScoreRow[] = []
/** End of the pause on this client's clock. 0 = no pause running. */
let pauseEndsAtMs = 0
/** The player clicked off the panel; the pause carries on without it. */
let dismissed = false

/** Called from the roundEnded handler. `durationMs` is what is LEFT of the pause. */
export function showRoundScoreboard(list: ScoreRow[], durationMs: number) {
  rows = list
  pauseEndsAtMs = Date.now() + durationMs
  dismissed = false
  // The two panels occupy the same frame, so an open menu would sit behind this
  // one and reappear the moment the board is dismissed. It stays closed: the
  // player reopens it if they want it.
  closeMenu()
}

/** Called when the next round starts, so nothing outlives the pause. */
export function hideRoundScoreboard() {
  rows = []
  pauseEndsAtMs = 0
  dismissed = false
}

/** Milliseconds left of the pause; 0 when a round is running. Drives the HUD clock. */
export function intermissionRemainingMs(): number {
  if (pauseEndsAtMs === 0) return 0
  return Math.max(0, pauseEndsAtMs - Date.now())
}

function panelVisible(): boolean {
  return !dismissed && intermissionRemainingMs() > 0
}

export function RoundSummary() {
  if (!panelVisible()) return <UiEntity uiTransform={{ display: 'none' }} />

  const list = rows.map((row, i) => (
    <LeaderRow
      key={`rs${row.id}`}
      rank={i + 1}
      address={row.id}
      name={row.name}
      columns={COLUMNS}
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
  ))
  if (list.length === 0) {
    list.push(<EmptyBoard key="rs-empty" text="Nobody flew this round." />)
  }

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}>
      {/* Catcher and panel are SIBLINGS, as in the menu: nested, a click on the
          panel could count as a click on its parent and close the board. It is
          invisible - it dims nothing - and exists only to receive the click. */}
      <UiEntity
        uiTransform={{
          width: '100%',
          height: '100%',
          positionType: 'absolute',
          position: { top: 0, left: 0 },
          pointerFilter: 'block'
        }}
        onMouseDown={() => { dismissed = true }}
      />

      {/* Insets rather than width/height in a flex wrapper, for the reason the
          menu panel documents: a percentage height needs a parent with a
          definite height, and the row list needs a real height to scroll in. */}
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { top: MENU_TOP, bottom: menuBottom(), left: menuSide(), right: menuSide() },
          borderWidth: 3,
          borderColor: UI_RIM,
          pointerFilter: 'block'
        }}
        uiBackground={{ color: UI_PANEL_BG }}
        // absorbs clicks so they never reach the catcher behind
        onMouseDown={() => {}}
      >
        <Label
          value="ROUND OVER"
          fontSize={isMobile() ? 26 : 32}
          color={UI_ACCENT}
          textAlign="middle-center"
          uiTransform={{
            positionType: 'absolute',
            position: { top: PANEL_PAD, left: PANEL_PAD, right: PANEL_PAD },
            height: TITLE_HEIGHT
          }}
        />
        <Label
          value={`Next round in ${Math.ceil(intermissionRemainingMs() / 1000)}s`}
          fontSize={isMobile() ? 16 : 19}
          color={UI_TEXT_DIM}
          textAlign="middle-center"
          uiTransform={{
            positionType: 'absolute',
            position: { top: PANEL_PAD + TITLE_HEIGHT, left: PANEL_PAD, right: PANEL_PAD },
            height: SUBTITLE_HEIGHT
          }}
        />

        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: {
              top: PANEL_PAD + TITLE_HEIGHT + SUBTITLE_HEIGHT + 8,
              bottom: PANEL_PAD,
              left: PANEL_PAD,
              right: PANEL_PAD
            },
            flexDirection: 'column',
            // more pilots than fit is possible; the list scrolls under the
            // header rather than running off the panel
            overflow: 'scroll'
          }}
        >
          <BoardHeader columns={COLUMNS} />
          {list}
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
