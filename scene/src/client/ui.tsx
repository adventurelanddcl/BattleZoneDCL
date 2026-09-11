// BattleZone client — screen-space HUD.
// Crosshair (center — the plane always shoots there), health, ammo, round
// timer, kill counters, death overlay with respawn countdown, round banners.

import ReactEcs, { ReactEcsRenderer, UiEntity, Label, UiTransformProps } from '@dcl/sdk/react-ecs'
import { engine, InputAction } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import { Color4, Vector3 } from '@dcl/sdk/math'
import {
  MAX_HEALTH, CENTER_X, CENTER_Z, TERRAIN_SPAN, TERRAIN_HALF, ACTION_DIM_HOLD_MS,
  FLOOR_Y, CEILING_Y
} from '../shared/constants'
import {
  myState, roundView, isServerAlive, playerStates, getRespawnRemainingMs,
  inLobby, isSwitchPending, getSwitchRemainingMs
} from './serverLink'
import { ammoView } from './weapons'
import { boostSecondsLeft, boostView } from './boost'
import { currentAction, PlaneAction } from './actionLock'
import { localPlanePosition, remotePlanePositions } from './planes'
import { getClientDronePositions } from './drones'
import { getFlightMode, FlightMode, getFlightVelocity } from './flight'
import { getDamageFlashAlpha } from './damageIndicator'
import {
  BULLET_BUTTON_TEXTURE, ROCKET_BUTTON_TEXTURE, BOOST_BUTTON_TEXTURE, MENU_BUTTON_TEXTURE,
  ICON_PILOTS, ICON_KILLS, ICON_DRONES, UI_READOUT_BG, MINIMAP_SIZE, UI_ACCENT
} from './uiAssets'
import { GameMenu, toggleMenu, openMenu, closeMenu } from './menu'
import { RoundSummary, intermissionRemainingMs } from './roundSummary'
import { spectateLabel, cycleSpectate, spectateAvailable } from './spectate'
import { KillFeed } from './killFeed'

// ── mutable UI state, driven by uiStateSystem + message handlers ──
export const uiState = {
  killFlash: 0, // white hit-marker pulse when we land a hit
  banner: '',
  bannerTtl: 0,
  hintTtl: 18, // controls hint shown for the first seconds
  speedDisplay: 0 // low-passed speed for the readout, see uiStateSystem
}

const SPEED_SMOOTHING = 1

/** A respawn teleport is a huge one-frame delta, not a speed — ignore it. */
const SPEED_SPIKE_LIMIT = 120

/** Flip to true to put the speed readout back on the HUD. */
const SHOW_SPEED = false

export function showBanner(text: string, seconds: number) {
  uiState.banner = text
  uiState.bannerTtl = seconds
}

let lastLobbyState: boolean | null = null

export function uiStateSystem(dt: number) {
  // The menu IS the lobby screen, so it opens on arrival and gets out of the
  // way on launch.
  const state = myState()
  if (state !== null && state.inLobby !== lastLobbyState) {
    lastLobbyState = state.inLobby
    if (state.inLobby) {
      openMenu()
    } else {
      closeMenu()
      uiState.hintTtl = 12 // the autopilot hint belongs at launch, not at load
    }
  }

  uiState.killFlash = Math.max(0, uiState.killFlash - dt * 3)
  uiState.bannerTtl = Math.max(0, uiState.bannerTtl - dt)
  uiState.hintTtl = Math.max(0, uiState.hintTtl - dt)

  const raw = Math.min(SPEED_SPIKE_LIMIT, Vector3.length(getFlightVelocity()))
  uiState.speedDisplay += (raw - uiState.speedDisplay) * (1 - Math.exp(-SPEED_SMOOTHING * dt))
}

const WHITE = Color4.White()
const DIM = Color4.create(1, 1, 1, 0.55)
/** Between-rounds clock, so a pause never reads as play time. */
const PAUSE_CLOCK = Color4.create(1, 0.82, 0.35, 1)

/** Speed readout offset from the bottom edge. */
const SPEED_BOTTOM = 0

const TOP_ROW_HEIGHT = 52

const HEALTH_TOP = 69
const HEALTH_HEIGHT = 14

const BANNER_TOP = HEALTH_TOP + HEALTH_HEIGHT + 6

/** Lobby<->play countdown, above the speed readout and clear of the buttons. */
const SWITCH_TEXT_BOTTOM = 150

/** How far down the screen the death message starts (virtual px from the top). */
const DEATH_TEXT_TOP = 300

/** Owner entity for the damage-border renderer (see setupUi). */
const damageBorderEntity = engine.addEntity()

/** Thickness of the damage-indicator border, as a percentage of the screen. */
const DAMAGE_BORDER_PCT = 4

/** How many strips make up each border edge. More = smoother gradient, at one UI entity per strip per edge. */
const DAMAGE_GRADIENT_STEPS = 10

/**
 * Builds one edge of the damage border as a stack of strips running from the
 * screen edge inward, each weaker than the last so the inner lip fades out.
 */
function damageBorderEdge(edge: 'top' | 'bottom' | 'left' | 'right', alpha: number) {
  const stripSize = DAMAGE_BORDER_PCT / DAMAGE_GRADIENT_STEPS
  // Percentages are template-literal types (PositionUnit), so the computed
  // values need that shape rather than a plain string.
  const sideHeight: `${number}%` = `${100 - DAMAGE_BORDER_PCT * 2}%`
  const sideTop: `${number}%` = `${DAMAGE_BORDER_PCT}%`

  const strips = []
  for (let i = 0; i < DAMAGE_GRADIENT_STEPS; i++) {
    // Outermost strip carries the full alpha; each step inward is weaker, and
    // the innermost lands just above zero.
    const color = Color4.create(1, 0, 0, alpha * (1 - i / DAMAGE_GRADIENT_STEPS))
    const offset: `${number}%` = `${i * stripSize}%`
    const thickness: `${number}%` = `${stripSize}%`

    const transform: UiTransformProps =
      edge === 'top'
        ? { positionType: 'absolute', width: '100%', height: thickness, position: { top: offset, left: '0%' } }
        : edge === 'bottom'
        ? { positionType: 'absolute', width: '100%', height: thickness, position: { bottom: offset, left: '0%' } }
        : edge === 'left'
        ? { positionType: 'absolute', width: thickness, height: sideHeight, position: { left: offset, top: sideTop } }
        : { positionType: 'absolute', width: thickness, height: sideHeight, position: { right: offset, top: sideTop } }

    strips.push(<UiEntity key={`damage-${edge}-${i}`} uiTransform={transform} uiBackground={{ color }} />)
  }
  return strips
}

/**
 * Damage indicator: translucent red bars along the top and bottom screen edges,
 * faded in and back out over a second whenever we lose health.
 */
function DamageBorder() {
  const alpha = getDamageFlashAlpha()
  if (alpha <= 0) return <UiEntity uiTransform={{ display: 'none' }} />
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        width: '100%',
        height: '100%',
        position: { top: 0, left: 0 },
        // never swallow clicks meant for the world or the HUD beneath it
        pointerFilter: 'none'
      }}
    >
      {damageBorderEdge('top', alpha)}
      {damageBorderEdge('bottom', alpha)}
    </UiEntity>
  )
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s < 10 ? '0' : ''}${s}`
}

function Crosshair() {
  return (
    <UiEntity
      uiTransform={{
        width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 },
        justifyContent: 'center', alignItems: 'center'
      }}
    >
      <UiEntity uiTransform={{ width: 28, height: 28 }}>
        {/* horizontal + vertical bars with a hollow middle */}
        <UiEntity uiTransform={{ width: 9, height: 2, positionType: 'absolute', position: { top: 13, left: 0 } }} uiBackground={{ color: WHITE }} />
        <UiEntity uiTransform={{ width: 9, height: 2, positionType: 'absolute', position: { top: 13, left: 19 } }} uiBackground={{ color: WHITE }} />
        <UiEntity uiTransform={{ width: 2, height: 9, positionType: 'absolute', position: { top: 0, left: 13 } }} uiBackground={{ color: WHITE }} />
        <UiEntity uiTransform={{ width: 2, height: 9, positionType: 'absolute', position: { top: 19, left: 13 } }} uiBackground={{ color: WHITE }} />
        <UiEntity uiTransform={{ width: 4, height: 4, positionType: 'absolute', position: { top: 12, left: 12 } }} uiBackground={{ color: uiState.killFlash > 0 ? Color4.create(1, 0.3, 0.2, 1) : Color4.create(1, 1, 1, 0.7) }} />
      </UiEntity>
    </UiEntity>
  )
}

/** Bare count, one decimal so a burn visibly ticks down. */
function boostLabel(): string {
  return boostSecondsLeft().toFixed(1)
}

/**
 * Lobby-only camera picker: [<] OVERVIEW CAM [>].
 */
const SPECTATE_BAR_HEIGHT = 46
const SPECTATE_LABEL_WIDTH = 260
const SPECTATE_ARROW = 46

function SpectateArrow(props: { glyph: string; step: number }) {
  return (
    <UiEntity
      uiTransform={{
        width: SPECTATE_ARROW,
        height: SPECTATE_BAR_HEIGHT,
        justifyContent: 'center',
        alignItems: 'center',
        pointerFilter: 'block' // it is a button, unlike everything else up here
      }}
      uiBackground={{ color: Color4.create(0, 0, 0, 0.75) }}
      onMouseDown={() => cycleSpectate(props.step)}
    >
      <Label value={props.glyph} fontSize={24} color={UI_ACCENT} textAlign="middle-center" uiTransform={{ width: '100%', height: 30 }} />
    </UiEntity>
  )
}

function SpectateBar() {
  if (!inLobby()) return <UiEntity uiTransform={{ display: 'none' }} />
  const live = spectateAvailable()
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: SPECTATE_BAR_HEIGHT,
        positionType: 'absolute',
        position: { top: TOP_ROW_HEIGHT, left: 0 },
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        pointerFilter: 'none' // only the arrows take clicks
      }}
    >
      {/* Nobody in the air: no arrows at all, rather than arrows that step
          nowhere. The label stays, so the lobby still says what you are looking
          through. */}
      {live ? <SpectateArrow glyph="<" step={-1} /> : null}
      {/* No margins: the label butts against both arrows so the three read as
          one control. UI_READOUT_BG matches the clock and counters above it. */}
      <UiEntity
        uiTransform={{
          width: SPECTATE_LABEL_WIDTH,
          height: SPECTATE_BAR_HEIGHT,
          justifyContent: 'center',
          alignItems: 'center'
        }}
        uiBackground={{ color: UI_READOUT_BG }}
      >
        <Label value={spectateLabel()} fontSize={20} color={WHITE} textAlign="middle-center" uiTransform={{ width: '100%', height: 28 }} />
      </UiEntity>
      {live ? <SpectateArrow glyph=">" step={1} /> : null}
    </UiEntity>
  )
}

function SpeedReadout() {
  const speed = Math.round(uiState.speedDisplay)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { bottom: SPEED_BOTTOM, left: 0 },
        width: '100%',
        flexDirection: 'row',
        justifyContent: 'center'
      }}
    >
      {/* explicit box, so the first frame does not place it off-centre */}
      <Label
        value={`${speed}`}
        fontSize={34}
        color={WHITE}
        textAlign="middle-center"
        uiTransform={{ width: 160, height: 44 }}
      />
    </UiEntity>
  )
}

// ── Minimap ──────────────────────────────────────────────────────────────
// The square is the TERRAIN footprint, not the scene's.

const MAP_SIZE = MINIMAP_SIZE
/**
 * Dot size carries ALTITUDE. A flat square cannot show height any other way.
 */
const MAP_DOT_LOW = 11
const MAP_DOT_HIGH = 5

const MAP_SELF = Color4.create(0.2, 1, 0.35, 1)
const MAP_ENEMY = Color4.create(1, 0.25, 0.2, 1)
const MAP_DRONE = Color4.create(1, 0.9, 0.2, 1)

/** Dot size for a world altitude: MAP_DOT_LOW at FLOOR_Y, MAP_DOT_HIGH at CEILING_Y. */
function dotSize(y: number): number {
  const climb = Math.max(0, Math.min(1, (y - FLOOR_Y) / (CEILING_Y - FLOOR_Y)))
  return MAP_DOT_LOW + (MAP_DOT_HIGH - MAP_DOT_LOW) * climb
}

/**
 * One dot, placed from a world position. +X runs right and +Z runs UP the
 * square, so north sits at the top the way a map is read. The dot is centred on
 * its position and then clamped inside the square, so something at the very
 * edge of the scene still draws fully on the map.
*/
function mapDot(key: string, x: number, y: number, z: number, color: Color4) {
  const size = dotSize(y)
  const nx = Math.max(0, Math.min(1, (x - (CENTER_X - TERRAIN_HALF)) / TERRAIN_SPAN))
  const nz = Math.max(0, Math.min(1, (z - (CENTER_Z - TERRAIN_HALF)) / TERRAIN_SPAN))
  const limit = MAP_SIZE - size
  const left = Math.max(0, Math.min(limit, nx * MAP_SIZE - size / 2))
  const top = Math.max(0, Math.min(limit, (1 - nz) * MAP_SIZE - size / 2))
  return (
    <UiEntity
      key={key}
      uiTransform={{ positionType: 'absolute', width: size, height: size, position: { left, top } }}
      uiBackground={{ color }}
    />
  )
}

function MiniMap() {
  const dots = []
  // drones first, then enemies, then self — later children draw on top, so the player's own dot is never hidden under a drone
  for (const drone of getClientDronePositions()) {
    dots.push(mapDot(`md${drone.id}`, drone.position.x, drone.position.y, drone.position.z, MAP_DRONE))
  }
  for (const plane of remotePlanePositions()) {
    dots.push(mapDot(`mp${plane.address}`, plane.position.x, plane.position.y, plane.position.z, MAP_ENEMY))
  }
  // only while actually in play — remote dots are already filtered the same way, so a lobby or wreck position never shows as a live plane
  const mine = myState()
  const me = mine !== null && mine.alive ? localPlanePosition() : null
  if (me !== null) dots.push(mapDot('mself', me.x, me.y, me.z, MAP_SELF))

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: 0, right: 0 },
        width: MAP_SIZE,
        height: MAP_SIZE,
        borderWidth: 2,
        borderColor: Color4.create(1, 1, 1, 0.35),
        pointerFilter: 'none'
      }}
      uiBackground={{ color: UI_READOUT_BG }}
    >
      {dots}
    </UiEntity>
  )
}

// Top-bar stat icons. White silhouettes with an alpha mask, so uiBackground
// tints them; swap the files to restyle without touching this code.


const STAT_ICON_SIZE = 28
/** Fixed width per side of the clock, so the clock itself stays centred. */
const STAT_SIDE_WIDTH = 164

const CLOCK_WIDTH = 120

/** One icon + number pair in the top bar. */
const STAT_CHIP_GAP = 4

const STAT_VALUE_WIDTH = 38

function StatChip(props: { icon: string; value: string }) {
  return (
    <UiEntity
      uiTransform={{
        flexDirection: 'row',
        alignItems: 'center',
        margin: { left: STAT_CHIP_GAP, right: STAT_CHIP_GAP }
      }}
    >
      <UiEntity
        uiTransform={{ width: STAT_ICON_SIZE, height: STAT_ICON_SIZE, margin: { right: 8 } }}
        uiBackground={{ texture: { src: props.icon }, textureMode: 'stretch', color: WHITE }}
      />
      {/* explicit box, for the same first-frame layout reason as the slot counts */}
      <Label
        value={props.value}
        fontSize={24}
        color={WHITE}
        textAlign="middle-left"
        uiTransform={{ width: STAT_VALUE_WIDTH, height: 32 }}
      />
    </UiEntity>
  )
}


const ACTION_BUTTON_SIZE = 120
const ACTION_BUTTON_GAP = 18

/** Where the lowest button (E) sits — the native main button's old spot. */
const ACTION_COLUMN_RIGHT = 0
const ACTION_COLUMN_BOTTOM = 0

/** Fixed box for the count text inside a slot (see the note in ActionSlot). */
const COUNT_BOX_HEIGHT = 40
const COUNT_BOX_BOTTOM = 8

// Button art and palette live in uiAssets.ts, shared with the menu.

const COUNT_BULLET = Color4.create(1, 0.85, 0.2, 1)
const COUNT_ROCKET = Color4.create(1, 0.45, 0.3, 1)
const COUNT_BOOST = Color4.create(0.55, 0.8, 1, 1)

/**
 * Multiplied over the button art whenever a slot cannot be pressed - because
 * another action has the plane, or because that slot has nothing left to spend.
 * Kept neutral and well short of black: the count has to stay readable, since
 * an unusable button is still the place you look for how much ammo is left.
 */
const ACTION_LOCKED_TINT = Color4.create(0.42, 0.42, 0.45, 1)

/**
 * The dim lags the lock on the way OUT only, by ACTION_DIM_HOLD_MS.
 */
let dimmedBy: PlaneAction | null = null
let dimUntilMs = 0

function lockedForPaint(): PlaneAction | null {
  const held = currentAction()
  if (held !== null) {
    dimmedBy = held
    dimUntilMs = Date.now() + ACTION_DIM_HOLD_MS
    return held
  }
  if (dimmedBy !== null && Date.now() >= dimUntilMs) dimmedBy = null
  return dimmedBy
}

// Desktop slot geometry
const PC_SLOT_WIDTH: `${number}%` = '5%'
const PC_SLOT_RIGHT: `${number}%` = '0.5%'
const PC_SLOT_HEIGHT_PCT = 10
const PC_SLOT_TOP_PCT = 25

const PC_SLOT_GAP_PCT = 1.5

const PC_SLOT_HEIGHT: `${number}%` = `${PC_SLOT_HEIGHT_PCT}%`

function pcSlotTop(slot: number): `${number}%` {
  const top = PC_SLOT_TOP_PCT + slot * (PC_SLOT_HEIGHT_PCT + PC_SLOT_GAP_PCT)
  return `${Math.round(top * 100) / 100}%`
}

function ActionSlot(props: {
  transform: UiTransformProps
  texture: string
  fontSize: number
  countColor: Color4
  /** Omitted by slots that are not a counter, such as the menu button. */
  count?: string
  action?: InputAction
  tint?: Color4
  onClick?: () => void
}) {
  return (
    <UiEntity
      uiTransform={props.transform}
      uiBackground={{ texture: { src: props.texture }, textureMode: 'stretch', color: props.tint }}
      uiInputBinding={props.action !== undefined ? { actions: [props.action] } : undefined}
      onMouseDown={props.onClick}
    >
      <Label
        value={props.count ?? ''}
        fontSize={props.fontSize}
        color={props.countColor}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: COUNT_BOX_HEIGHT, margin: { bottom: COUNT_BOX_BOTTOM } }}
      />
    </UiEntity>
  )
}

function mobileSlotTransform(): UiTransformProps {
  return {
    width: ACTION_BUTTON_SIZE,
    height: ACTION_BUTTON_SIZE,
    margin: { top: ACTION_BUTTON_GAP },
    flexDirection: 'column',
    justifyContent: 'flex-end',
    alignItems: 'center',
    // without this a press falls through and drags the camera mid-fight
    pointerFilter: 'block'
  }
}

function pcSlotTransform(slot: number, clickable = false): UiTransformProps {
  return {
    positionType: 'absolute',
    width: PC_SLOT_WIDTH,
    height: PC_SLOT_HEIGHT,
    position: { top: pcSlotTop(slot), right: PC_SLOT_RIGHT },
    flexDirection: 'column',
    justifyContent: 'flex-end',
    alignItems: 'center',
    // the counters are read-only indicators on desktop and must never eat a click; the menu slot is the one exception, so it opts back in
    pointerFilter: clickable ? 'block' : 'none'
  }
}

function ActionButtons() {
  // In the lobby there is nothing to fire or burn, so the three weapon slots go
  // and only the menu button stays — that is the way back to PLAY.
  const lobby = inLobby()
  const bullets = `${ammoView.bullets}`
  const rockets = `${ammoView.rockets}`
  const boost = boostLabel()
  // One action at a time (see actionLock), and the column says so: whatever has
  // the plane stays lit and the other two go dark. Dimming the action in USE
  // would be backwards — the button you are holding is the one thing that is definitely working.
  const held = lockedForPaint()
  // the one that should go dark.
  const spent = (slot: PlaneAction) => {
    if (slot === 'bullets') return ammoView.bullets <= 0
    if (slot === 'rockets') return ammoView.rockets <= 0
    return boostView.ms <= 0
  }
  const dim = (slot: PlaneAction) =>
    spent(slot) || (held !== null && held !== slot) ? ACTION_LOCKED_TINT : undefined

  if (isMobile()) {
    if (lobby) {
      return (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            // lifted by the three slots that are not drawn, so the menu button
            // stays exactly where it sits during a fight rather than jumping down to the bullet button's corner
            position: {
              right: ACTION_COLUMN_RIGHT,
              bottom: ACTION_COLUMN_BOTTOM + 3 * (ACTION_BUTTON_SIZE + ACTION_BUTTON_GAP)
            },
            flexDirection: 'column-reverse',
            alignItems: 'center'
          }}
        >
          <ActionSlot
            transform={mobileSlotTransform()}
            texture={MENU_BUTTON_TEXTURE}
            fontSize={26}
            countColor={WHITE}
            onClick={toggleMenu}
          />
        </UiEntity>
      )
    }
    return (
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { right: ACTION_COLUMN_RIGHT, bottom: ACTION_COLUMN_BOTTOM },
          // column-reverse stacks upward from the anchor, so the FIRST child
          // keeps the native main button's position and the rest pile above it
          flexDirection: 'column-reverse',
          alignItems: 'center'
        }}
      >
        <ActionSlot
          transform={mobileSlotTransform()}
          texture={BULLET_BUTTON_TEXTURE}
          count={bullets}
          fontSize={26}
          countColor={COUNT_BULLET}
          action={InputAction.IA_PRIMARY}
          tint={dim('bullets')}
        />
        <ActionSlot
          transform={mobileSlotTransform()}
          texture={ROCKET_BUTTON_TEXTURE}
          count={rockets}
          fontSize={26}
          countColor={COUNT_ROCKET}
          action={InputAction.IA_SECONDARY}
          tint={dim('rockets')}
        />
        <ActionSlot
          transform={mobileSlotTransform()}
          texture={BOOST_BUTTON_TEXTURE}
          count={boost}
          fontSize={26}
          countColor={COUNT_BOOST}
          action={InputAction.IA_JUMP}
          tint={dim('boost')}
        />
        {/* last child, so it sits above the other three in the reversed column */}
        <ActionSlot
          transform={mobileSlotTransform()}
          texture={MENU_BUTTON_TEXTURE}
          fontSize={26}
          countColor={WHITE}
          onClick={toggleMenu}
        />
      </UiEntity>
    )
  }

  if (lobby) {
    return (
      <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 }, pointerFilter: 'none' }}>
        <ActionSlot transform={pcSlotTransform(0, true)} texture={MENU_BUTTON_TEXTURE} fontSize={28} countColor={WHITE} onClick={toggleMenu} />
      </UiEntity>
    )
  }

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 }, pointerFilter: 'none' }}>
      {/* menu on top, then the same order as the mobile column */}
      <ActionSlot transform={pcSlotTransform(0, true)} texture={MENU_BUTTON_TEXTURE} fontSize={28} countColor={WHITE} onClick={toggleMenu} />
      <ActionSlot transform={pcSlotTransform(1)} texture={BOOST_BUTTON_TEXTURE} count={boost} fontSize={28} countColor={COUNT_BOOST} tint={dim('boost')} />
      <ActionSlot transform={pcSlotTransform(2)} texture={ROCKET_BUTTON_TEXTURE} count={rockets} fontSize={28} countColor={COUNT_ROCKET} tint={dim('rockets')} />
      <ActionSlot transform={pcSlotTransform(3)} texture={BULLET_BUTTON_TEXTURE} count={bullets} fontSize={28} countColor={COUNT_BULLET} tint={dim('bullets')} />
    </UiEntity>
  )
}

function Hud() {
  const pauseMs = intermissionRemainingMs()
  const state = myState()
  // Round clock and score stay up in the lobby — the battle carries on without
  // you and that is worth watching. Hull and speed do not: there is no plane.
  const flying = state === null || !state.inLobby
  const health = state ? state.health : MAX_HEALTH
  const segments = []
  for (let i = 0; i < MAX_HEALTH; i++) {
    segments.push(
      <UiEntity
        key={`hp${i}`}
        uiTransform={{ width: 46, height: HEALTH_HEIGHT, margin: { left: 3, right: 3 } }}
        uiBackground={{ color: i < health ? Color4.create(0.2, 0.9, 0.35, 0.95) : Color4.create(1, 1, 1, 0.15) }}
      />
    )
  }

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}>
      {/* top bar: pilots | timer | kills, drones */}
      <UiEntity
        uiTransform={{
          width: '100%',
          height: TOP_ROW_HEIGHT,
          positionType: 'absolute',
          position: { top: 0, left: 0 },
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'center'
        }}
      >
        <UiEntity
          uiTransform={{
            height: TOP_ROW_HEIGHT,
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center'
          }}
          uiBackground={{ color: UI_READOUT_BG }}
        >

          <UiEntity uiTransform={{ width: STAT_SIDE_WIDTH, height: TOP_ROW_HEIGHT, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' }}>
            <StatChip icon={ICON_PILOTS} value={`${playerStates.size}`} />
          </UiEntity>

          <UiEntity uiTransform={{ width: CLOCK_WIDTH, height: TOP_ROW_HEIGHT, justifyContent: 'center', alignItems: 'center' }}>
            <Label
              value={pauseMs > 0 ? formatTime(pauseMs) : formatTime(roundView.endsAtMs - Date.now())}
              fontSize={30}
              color={pauseMs > 0 ? PAUSE_CLOCK : WHITE}
            />
          </UiEntity>

          <UiEntity uiTransform={{ width: STAT_SIDE_WIDTH, height: TOP_ROW_HEIGHT, flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'center' }}>
            <StatChip icon={ICON_KILLS} value={`${state ? state.kills : 0}`} />
            <StatChip icon={ICON_DRONES} value={`${state ? state.droneKills : 0}`} />
          </UiEntity>
        </UiEntity>
      </UiEntity>

      {SHOW_SPEED && flying ? <SpeedReadout /> : null}

      {/* health, centred directly under the round timer */}
      <UiEntity
        uiTransform={{
          display: flying ? 'flex' : 'none',
          positionType: 'absolute',
          position: { top: HEALTH_TOP, left: 0 },
          width: '100%',
          flexDirection: 'row',
          justifyContent: 'center'
        }}
      >
        {segments}
      </UiEntity>

    </UiEntity>
  )
}

function Overlays() {
  const state = myState()
  const elements = []

  if (state !== null && !state.alive && !state.inLobby) {
    const remaining = getRespawnRemainingMs()
    elements.push(
      <UiEntity
        key="death"
        uiTransform={{
          width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 },
          justifyContent: 'flex-start', alignItems: 'center', flexDirection: 'column',
          // sits high on the screen, below the round banner, so a downed pilot still sees the sky they are about to respawn into
          padding: { top: DEATH_TEXT_TOP }
        }}
      >
        <Label value="PLANE DESTROYED" fontSize={54} color={Color4.create(1, 0.35, 0.25, 1)} />
        <Label
          value={remaining > 0 ? `Back in the air in ${Math.ceil(remaining / 1000)}…` : 'Respawning…'}
          fontSize={28}
          color={WHITE}
          uiTransform={{ margin: { top: 14 } }}
        />
      </UiEntity>
    )
  }

  // lobby <-> play countdown, so the wait is visible with the menu closed too
  if (isSwitchPending()) {
    const seconds = Math.ceil(getSwitchRemainingMs() / 1000)
    const heading = inLobby() ? 'ENTERING BATTLE' : 'RETURNING TO LOBBY'
    elements.push(
      <UiEntity
        key="switch"
        uiTransform={{ width: '100%', height: 60, positionType: 'absolute', position: { bottom: SWITCH_TEXT_BOTTOM, left: 0 }, justifyContent: 'center' }}
      >
        <UiEntity uiTransform={{ width: 560, height: 54, justifyContent: 'center', alignItems: 'center' }} uiBackground={{ color: Color4.create(0, 0, 0, 0.55) }}>
          <Label
            value={seconds > 0 ? `${heading} IN ${seconds}…` : `${heading}…`}
            fontSize={26}
            color={WHITE}
            textAlign="middle-center"
            uiTransform={{ width: 540, height: 34 }}
          />
        </UiEntity>
      </UiEntity>
    )
  }

  // circling hint
  if (uiState.hintTtl > 0 && getFlightMode() === FlightMode.CIRCLING) {
    elements.push(
      <UiEntity
        key="hint"
        uiTransform={{ width: '100%', height: 90, positionType: 'absolute', position: { bottom: 120, left: 0 }, justifyContent: 'center' }}
      >
        <UiEntity uiTransform={{ width: 640, height: 84, justifyContent: 'center', alignItems: 'center', flexDirection: 'column' }} uiBackground={{ color: Color4.create(0, 0, 0, 0.55) }}>
          <Label value="AUTOPILOT — move the camera to take the controls" fontSize={22} color={WHITE} />
          <Label value="The plane always flies where you look. Crosshair = guns." fontSize={17} color={DIM} uiTransform={{ margin: { top: 6 } }} />
        </UiEntity>
      </UiEntity>
    )
  }

  if (uiState.bannerTtl > 0 && uiState.banner !== '') {
    const bannerTop = inLobby() ? TOP_ROW_HEIGHT + SPECTATE_BAR_HEIGHT + 6 : BANNER_TOP
    elements.push(
      <UiEntity
        key="banner"
        uiTransform={{ width: '100%', height: 64, positionType: 'absolute', position: { top: bannerTop, left: 0 }, justifyContent: 'center' }}
      >
        <UiEntity uiTransform={{ height: 64, justifyContent: 'center', alignItems: 'center', padding: { left: 30, right: 30 } }} uiBackground={{ color: Color4.create(0, 0, 0, 0.6) }}>
          <Label value={uiState.banner} fontSize={28} color={Color4.create(1, 0.9, 0.4, 1)} />
        </UiEntity>
      </UiEntity>
    )
  }

  // server waking up
  if (!isServerAlive()) {
    elements.push(
      <UiEntity
        key="server"
        uiTransform={{ width: '100%', height: 50, positionType: 'absolute', position: { top: 90, left: 0 }, justifyContent: 'center' }}
      >
        <UiEntity uiTransform={{ width: 420, height: 44, justifyContent: 'center', alignItems: 'center' }} uiBackground={{ color: Color4.create(0.1, 0.1, 0.25, 0.75) }}>
          <Label value="Connecting to battle server…" fontSize={20} color={WHITE} />
        </UiEntity>
      </UiEntity>
    )
  }

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}>
      {elements}
    </UiEntity>
  )
}

function BattleZoneUI() {
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
      <Hud />
      <SpectateBar />
      <MiniMap />
      <KillFeed />
      {/* nothing to aim at from the lobby */}
      {inLobby() ? null : <Crosshair />}
      <ActionButtons />
      <Overlays />
      <GameMenu />
      <RoundSummary />
    </UiEntity>
  )
}

export function setupUi() {
  ReactEcsRenderer.setUiRenderer(BattleZoneUI, { virtualWidth: 1920, virtualHeight: 1080 })
  ReactEcsRenderer.addUiRenderer(damageBorderEntity, DamageBorder, {
    virtualWidth: 1920,
    virtualHeight: 1080,
    screenInset: 'none'
  })
}
