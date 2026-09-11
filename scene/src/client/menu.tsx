// BattleZone client — the in-game menu opened from the HUD menu button.
//
// Closing rules: the menu button toggles it, and a full-screen catcher sits
// behind the panel, so a click anywhere off the panel closes it — including on
// the bullet / rocket / boost buttons, which the catcher covers while open. It
// is invisible: it blocks and receives clicks without dimming the game.
//
// The catcher and the panel are SIBLINGS, not parent and child. Nesting the
// panel inside the catcher would risk a click on the panel also counting as a
// click on its parent and closing the menu; as siblings the panel is simply the
// topmost blocking element where it sits, and the catcher gets everything else.

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import {
  BULLET_BUTTON_TEXTURE, ROCKET_BUTTON_TEXTURE, BOOST_BUTTON_TEXTURE,
  ICON_PILOTS, ICON_KILLS, ICON_DRONES,
  UI_PANEL_BG, UI_RIM, UI_TAB_BG, UI_TAB_ACTIVE_BG, UI_TEXT, UI_ACCENT, UI_TEXT_DIM
} from './uiAssets'
import {
  ROUND_LENGTH_MS, MAX_HEALTH, RESPAWN_COOLDOWN_MS, BOOST_PICKUP_MS,
  PICKUP_BULLET_AMOUNT, PICKUP_ROCKET_AMOUNT, BULLET_VOLLEY_INTERVAL, ROCKET_INTERVAL,
  LOBBY_TRANSITION_MS, INTERMISSION_MS, DRONE_COUNT, DRONE_AGGRO_RADIUS,
  ROUND_START_BULLETS, ROUND_START_ROCKETS, ROUND_START_BOOST_MS,
  COINS_PER_PLAYER_KILL, COINS_PER_DRONE_KILL
} from '../shared/constants'
import { room } from '../shared/messages'
import { inLobby, isSwitchPending, getSwitchRemainingMs, canSend } from './serverLink'
import { Leaderboard } from './leaderboardUi'

// Content tabs only. The lobby <-> play switch is not one of them: it is an
// action, not a view, so it is drawn last (see SwitchTab) and sits at the right
// end of the row, apart from the tabs that merely change what is below.
export const MENU_TABS = ['LEADERBOARD', 'MUSIC', 'HOW TO PLAY'] as const
const LEADERBOARD = 0
const HOW_TO_PLAY = 2

// Open on arrival: the lobby IS this menu, and a player who has just landed in
// the scene has nothing else to look at.
let menuOpen = true
// Opens on HOW TO PLAY, the only tab with anything under it so far.
let activeTab: number = HOW_TO_PLAY

export function isMenuOpen(): boolean {
  return menuOpen
}
export function toggleMenu() {
  menuOpen = !menuOpen
}
export function closeMenu() {
  menuOpen = false
}
/** Reopens on HOW TO PLAY — used when the player lands back in the lobby. */
export function openMenu() {
  menuOpen = true
  activeTab = HOW_TO_PLAY
}

/**
 * Asks the server to move us between the lobby and the battle. It only ever
 * arms the switch: the server counts LOBBY_TRANSITION_MS down and makes the
 * change itself, so leaving a fight for the lobby is never instant.
 */
export function requestSwitch() {
  // A tap on the X lands on the button behind it too. The server has not
  // answered yet at that point, so isSwitchPending() is still true and would
  // swallow this — but once it clears, the same stray tap would re-arm what was
  // just cancelled. This window covers the gap.
  if (Date.now() - cancelledAt < CANCEL_GUARD_MS) return
  if (isSwitchPending() || !canSend()) return
  room.send(inLobby() ? 'requestPlay' : 'requestLobby', { t: Date.now() })
}

const CANCEL_GUARD_MS = 500
let cancelledAt = 0

/** Calls off an armed switch; the player stays exactly where they are. */
export function cancelSwitch() {
  if (!isSwitchPending() || !canSend()) return
  cancelledAt = Date.now()
  room.send('cancelSwitch', { t: Date.now() })
}

/** Label for the switch tab: the destination, plus its countdown once armed. */
export function switchTabLabel(): string {
  const lobby = inLobby()
  if (isSwitchPending()) {
    const seconds = Math.ceil(getSwitchRemainingMs() / 1000)
    return lobby ? `PLAY IN ${seconds}` : `LOBBY IN ${seconds}`
  }
  return lobby ? 'PLAY' : 'LOBBY'
}

/** Sits just below the round timer / stat row. */
export const MENU_TOP = 96
/**
 * Gap below the panel. Desktop keeps a margin; mobile runs to the very bottom,
 * where the canvas is short and every pixel of body copy counts.
 *
 * Resolved per render, not at module load: platform info is not guaranteed to
 * be ready while modules are still evaluating.
 */
const MENU_BOTTOM_DESKTOP = 28
const MENU_BOTTOM_MOBILE = 0
export function menuBottom(): number {
  return isMobile() ? MENU_BOTTOM_MOBILE : MENU_BOTTOM_DESKTOP
}
/** Left/right inset; 19% a side leaves a 62%-wide panel, centred. */
/**
 * Side inset of the menu panel, and so how wide it is.
 */
export function menuSide(): `${number}%` {
  return isMobile() ? '15%' : '19%'
}
export const PANEL_PAD = 16
/**
 * One tab, and the row that holds them.
 *
 * Explorers disagree about which box an absolutely positioned child fills, and
 * there is no single answer that satisfies both - all three of these were tried
 * in-world:
 *
 *   height '100%' / insets  -> correct on PC, 2*TAB_BORDER too tall on mobile
 *   height tabHeight() - 4  -> correct on mobile, 2*TAB_BORDER short on PC
 *
 * i.e. mobile measures such a child from the PADDING box and PC from the BORDER
 * box. So a child meant to fill a tab has to be told which one it is on (see
 * cancelStripTransform); do not "simplify" that branch away.
 */
const TAB_HEIGHT_DESKTOP = 52
/** Taller for a fingertip. Everything below reads this, so the strip, the
 *  switch button and the content inset all move together. */
const TAB_HEIGHT_MOBILE = 64
/** A function, not a const: isMobile() is not answerable at module load. */
const tabHeight = () => (isMobile() ? TAB_HEIGHT_MOBILE : TAB_HEIGHT_DESKTOP)
const TAB_BORDER = 2

// ── tabs ────────────────────────────────────────────────────────────────

// React-ECS does not special-case key the way React does, so a component used
// inside a map has to declare it.
function MenuTab(props: { key?: string; label: string; active: boolean; onClick: () => void }) {
  const active = props.active
  return (
    <UiEntity
      uiTransform={{
        width: '23%',
        height: tabHeight(),
        margin: { left: 4, right: 4 },
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: TAB_BORDER,
        borderColor: active ? UI_RIM : Color4.create(UI_RIM.r, UI_RIM.g, UI_RIM.b, 0.35),
        pointerFilter: 'block'
      }}
      uiBackground={{ color: active ? UI_TAB_ACTIVE_BG : UI_TAB_BG }}
      onMouseDown={props.onClick}
    >
      <Label
        value={props.label}
        fontSize={20}
        color={active ? UI_TEXT : UI_TEXT_DIM}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 30 }}
      />
    </UiEntity>
  )
}

// ── the lobby <-> play switch ───────────────────────────────────────────

/** Seconds for one full breath of the idle pulse. */
const SWITCH_PULSE_MS = 3000
/** Width of the cancel strip on the armed button. */
const CANCEL_WIDTH = 40

/**
 * 0..1 triangle-free pulse straight off the clock. No system and no state: the
 * UI tree is re-evaluated every frame, so reading the time here is all an
 * animation needs (the damage border animates the same way).
 */
function pulse01(periodMs: number): number {
  return 0.5 - 0.5 * Math.cos(((Date.now() % periodMs) / periodMs) * Math.PI * 2)
}

/** Cancel strip down the right edge of an armed switch — a full-height tap
 * target rather than a corner dot, which would be unhittable on a phone. */
/** Fills a tab's right edge exactly, on whichever box this explorer measures
 * from - see the tabHeight() note above. */
function cancelStripTransform() {
  if (isMobile()) {
    // padding box: an explicit height, and no bottom inset to fight it
    return { position: { top: 0, right: 0 }, height: tabHeight() - TAB_BORDER * 2 }
  }
  // border box: let the insets resolve the height
  return { position: { top: 0, bottom: 0, right: 0 } }
}

function CancelStrip() {
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        ...cancelStripTransform(),
        width: CANCEL_WIDTH,
        justifyContent: 'center',
        alignItems: 'center',
        pointerFilter: 'block'
      }}
      uiBackground={{ color: UI_PANEL_BG }}
      onMouseDown={cancelSwitch}
    >
      <Label value="X" fontSize={20} color={UI_TEXT} textAlign="middle-center" uiTransform={{ width: CANCEL_WIDTH, height: 24 }} />
    </UiEntity>
  )
}

/**
 * PLAY when you are in the lobby, LOBBY when you are flying, and the countdown once armed.
 *
 * Idle, the border breathes to pull the eye to the one control that starts a
 * round. Armed, it holds steady and grows an X instead: the click that matters
 * then is the cancel, and a button still begging to be pressed would be pointing at the wrong one.
 */
function SwitchTab() {
  const armed = isSwitchPending()
  const glow = armed ? 1 : pulse01(SWITCH_PULSE_MS)
  // Between the palette's rim and white — UI_RIM and UI_ACCENT are near enough
  // to each other that a pulse across them would not read at all.
  const border = Color4.create(
    UI_RIM.r * 0.45 + (1 - UI_RIM.r * 0.45) * glow,
    UI_RIM.g * 0.45 + (1 - UI_RIM.g * 0.45) * glow,
    UI_RIM.b * 0.45 + (1 - UI_RIM.b * 0.45) * glow,
    1
  )

  return (
    <UiEntity
      uiTransform={{
        width: '23%',
        height: tabHeight(),
        margin: { left: 4, right: 4 },
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: TAB_BORDER,
        borderColor: border,
        pointerFilter: 'block'
      }}
      uiBackground={{ color: armed ? UI_TAB_ACTIVE_BG : UI_TAB_BG }}
      onMouseDown={requestSwitch}
    >
      <Label
        value={switchTabLabel()}
        fontSize={20}
        color={UI_TEXT}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 26 }}
      />
      {armed ? <CancelStrip /> : null}
    </UiEntity>
  )
}

// ── HOW TO PLAY content ─────────────────────────────────────────────────

/** A row of body copy with the matching game image beside it. */
function InfoRow(props: { image: string; title: string; lines: string[] }) {
  return (
    <UiEntity uiTransform={{ width: '100%', height: 86, flexDirection: 'row', alignItems: 'center', margin: { bottom: 10 } }}>
      <UiEntity
        uiTransform={{ width: 68, height: 68, margin: { right: 16 } }}
        uiBackground={{ texture: { src: props.image }, textureMode: 'stretch' }}
      />
      <UiEntity uiTransform={{ flexGrow: 1, height: 84, flexDirection: 'column', justifyContent: 'center' }}>
        <Label
          value={props.title}
          fontSize={20}
          color={UI_ACCENT}
          textAlign="middle-left"
          uiTransform={{ width: '100%', height: 30 }}
        />
        {props.lines.map((line, i) => (
          <Label
            key={`l${i}`}
            value={line}
            fontSize={18}
            color={UI_TEXT}
            textAlign="middle-left"
            uiTransform={{ width: '100%', height: 27 }}
          />
        ))}
      </UiEntity>
    </UiEntity>
  )
}

function SectionTitle(props: { text: string }) {
  return (
    <Label
      value={props.text}
      fontSize={22}
      color={UI_ACCENT}
      textAlign="middle-left"
      uiTransform={{ width: '100%', height: 34, margin: { top: 6, bottom: 6 } }}
    />
  )
}

function RuleLine(props: { text: string }) {
  return (
    <Label
      value={props.text}
      fontSize={18}
      color={UI_TEXT}
      textAlign="middle-left"
      uiTransform={{ width: '100%', height: 28 }}
    />
  )
}

function HowToPlay() {
  const roundMinutes = ROUND_LENGTH_MS / 60000
  const respawnSeconds = RESPAWN_COOLDOWN_MS / 1000
  const boostPer = BOOST_PICKUP_MS / 1000

  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <SectionTitle text="FLYING" />
      <RuleLine text="Your plane always flies where the camera looks. Look up to climb, point down to dive, diving is faster." />

      <SectionTitle text="ACTIONS" />
      <InfoRow
        image={BULLET_BUTTON_TEXTURE}
        title="BULLETS — press this button on mobile or hold E on PC"
        lines={[
          `Shoot two bullets, every ${BULLET_VOLLEY_INTERVAL} seconds. ${MAX_HEALTH} hits destroy a plane.`,
          `Red bullet collectibles add +${PICKUP_BULLET_AMOUNT} bullet each.`
        ]}
      />
      <InfoRow
        image={ROCKET_BUTTON_TEXTURE}
        title="ROCKETS — press this button on mobile or hold F on PC"
        lines={[
          `One rocket shot per ${ROCKET_INTERVAL} second. One rocket destroys a plane and anything nearby.`,
          `Yellow rocket collectibles add +${PICKUP_ROCKET_AMOUNT} rocket each.`
        ]}
      />
      <InfoRow
        image={BOOST_BUTTON_TEXTURE}
        title="SPEED BOOST — press this button on mobile or hold Jump on PC"
        lines={[
          'Burns collected speed boost for a burst of speed.',
          `Blue boost collectibles add +${boostPer} seconds each.`
        ]}
      />

      <SectionTitle text="ONE AT A TIME" />
      <RuleLine text="Guns, Rockets and Speed Boost are one action at a time — never two at once." />

      <SectionTitle text="HEALTH" />
      <RuleLine text={`A plane has ${MAX_HEALTH} healths. Your health is the green bar under the round clock.`} />
      <RuleLine text="The screen edge flashes red when you are hit." />
      <RuleLine text="Enemy planes display their health bar above them" />

      <SectionTitle text="DRONES" />
      <RuleLine text={`${DRONE_COUNT} drones patrol the cave. Outrun drones with speed boost.`} />
      <RuleLine text="A drone that reaches you costs one health and it explodes on impact." />
      <RuleLine text="One bullet destroys a drone." />

      <SectionTitle text="THE MAP" />
      <RuleLine text="Top right: you are green, other pilots red, drones yellow." />
      <RuleLine text="Dot SIZE is altitude — big means low to the ground, small means high above ground." />

      <SectionTitle text="THE ROUND" />
      <RuleLine text={`Rounds are ${roundMinutes} minutes long.`} />
      <RuleLine text={`Shot down? You are back in the air ${respawnSeconds} seconds later.`} />
      <RuleLine text={`You start each round with ${ROUND_START_BULLETS} bullets, ${ROUND_START_ROCKETS} rockets and ${ROUND_START_BOOST_MS / 1000}s of boost.`} />
      <RuleLine text="A downed plane drops whatever it was carrying — go and take it." />
      <RuleLine text={`PLAY and LOBBY swap you in and out — either way takes ${LOBBY_TRANSITION_MS / 1000} seconds.`} />

      <SectionTitle text="SCORING" />
      <RuleLine text={`Highest player kill count wins. Players get coins: ${COINS_PER_PLAYER_KILL} for a plane, ${COINS_PER_DRONE_KILL} for a drone.`} />
      <RuleLine text="The kill feed beside the map shows who just got whom." />
      <RuleLine text="LEADERBOARD shows ROUND info with player stats durring round." />
      <RuleLine text="ALL TIME totals up every round you have finished here." />

      <SectionTitle text="TIPS" />
      <RuleLine text="Use speed boost together with dive to gain maximum speed and dodge enemy fire." />
      <RuleLine text="On PC click right click to lock the camera for easier flying." />

      <SectionTitle text="YOUR READOUTS" />
      <InfoRow
        image={ICON_PILOTS}
        title="PILOTS ONLINE"
        lines={['How many pilots are in the battle right now.']}
      />
      <InfoRow
        image={ICON_KILLS}
        title="KILLS"
        lines={['Planes you have shot down this round.']}
      />
      <InfoRow
        image={ICON_DRONES}
        title="DRONES"
        lines={['Drones you have destroyed this round.']}
      />
    </UiEntity>
  )
}

function ComingSoon(props: { label: string }) {
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' }}>
      <Label
        value={`${props.label} — coming soon`}
        fontSize={22}
        color={UI_TEXT_DIM}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 34 }}
      />
    </UiEntity>
  )
}

// ── the menu itself ─────────────────────────────────────────────────────

export function GameMenu() {
  if (!menuOpen) return <UiEntity uiTransform={{ display: 'none' }} />

  const tabs = MENU_TABS.map((label, i) => (
    <MenuTab key={`tab${i}`} label={label} active={activeTab === i} onClick={() => { activeTab = i }} />
  ))

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}>
      {/* Invisible catcher: anything off the panel closes the menu. It draws
          nothing - no dim over the game - but still blocks and receives the click. */}
      <UiEntity
        uiTransform={{
          width: '100%',
          height: '100%',
          positionType: 'absolute',
          position: { top: 0, left: 0 },
          pointerFilter: 'block'
        }}
        onMouseDown={closeMenu}
      />

      {/*
        Panel geometry is given as explicit insets rather than a width/height
        pair inside a flex wrapper. A percentage height only resolves against a
        parent with a definite height, and the wrapper had none — so the panel
        sized itself to its content, ran off the bottom of a phone screen, and
        never gave the scroll box a height to scroll within. Deriving the height
        from top + bottom fixes that on every canvas size.
      */}
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
        {/*
          Tabs and body are absolute boxes too. Left to flex, the row shifted
          whenever the body's intrinsic height changed between tabs (Yoga
          defaults flexShrink to 0, so a tall body pushes rather than shrinks).
          Fixed boxes keep the tabs still and give the body one constant size.
        */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: PANEL_PAD, left: PANEL_PAD, right: PANEL_PAD },
            height: tabHeight(),
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center'
          }}
        >
          {tabs}
          {/* last child: the switch sits at the right end of the row */}
          <SwitchTab />
        </UiEntity>

        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: PANEL_PAD + tabHeight() + 12, bottom: PANEL_PAD, left: PANEL_PAD, right: PANEL_PAD },
            flexDirection: 'column',
            // HOW TO PLAY is one long column and scrolls as a whole; the
            // leaderboard scrolls its own row list under a fixed header, and
            // nesting one scroll box inside another gives two things fighting over the same drag.
            overflow: activeTab === LEADERBOARD ? 'hidden' : 'scroll'
          }}
        >
          {activeTab === HOW_TO_PLAY ? (
            <HowToPlay />
          ) : activeTab === LEADERBOARD ? (
            <Leaderboard />
          ) : (
            <ComingSoon label={MENU_TABS[activeTab]} />
          )}
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
