// Shared UI image paths and the palette

import { Color4 } from '@dcl/sdk/math'

export const BULLET_BUTTON_TEXTURE = 'images/bullet-button.png'
export const ROCKET_BUTTON_TEXTURE = 'images/rocket-button.png'
export const BOOST_BUTTON_TEXTURE = 'images/boost-button.png'
export const MENU_BUTTON_TEXTURE = 'images/menu-button.png'

export const ICON_PILOTS = 'images/icon-pilots.png'
export const ICON_KILLS = 'images/icon-kills.png'
export const ICON_DRONES = 'images/icon-drones.png'

/** Panel body — the button's dark teal centre. */
export const UI_PANEL_BG = Color4.create(0.03, 0.11, 0.14, 0.94)
/** The cyan rim that glows around the button edge. */
export const UI_RIM = Color4.create(0.42, 0.88, 1, 0.85)
/** Tab in its resting state: a touch lighter than the panel. */
export const UI_TAB_BG = Color4.create(0.05, 0.18, 0.22, 0.95)
/** Selected tab, pushed toward the rim colour. */
export const UI_TAB_ACTIVE_BG = Color4.create(0.1, 0.36, 0.44, 0.98)
/** Body copy — the near-white of the button glyphs. */
export const UI_TEXT = Color4.create(0.9, 0.98, 1, 1)
/** Headings and highlights. */
export const UI_ACCENT = Color4.create(0.55, 0.92, 1, 1)
/** Secondary copy. */
export const UI_TEXT_DIM = Color4.create(0.62, 0.78, 0.84, 1)

/**
 * The smoked-glass tint the minimap sits on, shared with the kill feed beside
 * it so the two read as one piece of furniture. Anything drawn over the world
 * rather than inside a panel should use this rather than its own black.
 */
export const UI_READOUT_BG = Color4.create(0, 0, 0, 0.45)

/**
 * Side of the minimap square, and so where the readouts to its left have to
 * stop. Shared because the kill feed butts straight against the map with no
 * gap: two copies of this number would open one the first time either moved.
 *
 * It is the FULL footprint. UiTransform is border-box, so the map's 2 px rim
 * is drawn inside this, not added to it.
 */
export const MINIMAP_SIZE = 125
