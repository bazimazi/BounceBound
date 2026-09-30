/**
 * Screen layout.
 *
 * On a desktop the arena simply fills the window and the HUD floats over its
 * edges. A phone breaks both halves of that: its screen has notches and rounded
 * corners the HUD must avoid, and in portrait the 16:9 arena fills only a third of
 * the height - so the controls belong in the empty space below it rather than on
 * top of the play area.
 *
 * Everything here is plain geometry in CSS pixels, recomputed on every resize, so
 * the camera, the HUD and the touch controls all agree on where things are.
 */

import { ROOM_H, ROOM_W } from '../gen/templates';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenLayout {
  width: number;
  height: number;
  /** Device safe area (notch, home indicator, rounded corners). */
  safe: Insets;
  /** Taller than wide by a clear margin. */
  portrait: boolean;
  /** On-screen touch controls are showing. */
  touch: boolean;
  /** Small enough that the HUD switches to its compact form. */
  compact: boolean;
  /** Screen rectangle the arena is fitted into. */
  arena: Rect;
  /**
   * Top of the touch control deck. In portrait the deck is the space under the
   * arena; in landscape the controls overlay the arena and this is the height.
   */
  deckTop: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Height reserved above the arena in portrait for the integrity bar and shards. */
const PORTRAIT_HUD_BAND = 76;
/** Smallest control deck worth having under a portrait arena. */
const MIN_DECK = 210;

let probe: HTMLElement | null = null;

/**
 * Reads the device safe area from CSS `env()`, which is the only place a page
 * can learn it. A hidden probe element carries the insets as padding.
 */
export function readSafeArea(): Insets {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return NO_INSETS;
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);';
    document.body.append(probe);
  }
  const style = getComputedStyle(probe);
  const px = (value: string): number => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    top: px(style.paddingTop),
    right: px(style.paddingRight),
    bottom: px(style.paddingBottom),
    left: px(style.paddingLeft),
  };
}

export function computeLayout(width: number, height: number, safe: Insets, touch: boolean, uiScale = 1): ScreenLayout {
  const portrait = height > width * 1.15;
  const compact = width / uiScale < 760 || height / uiScale < 460;
  const aspect = ROOM_H / ROOM_W;

  if (portrait && touch) {
    // Arena directly under the HUD band, full width; the rest is the deck.
    const top = safe.top + PORTRAIT_HUD_BAND * Math.min(1.2, uiScale);
    const usableW = width - safe.left - safe.right;
    const maxH = Math.max(120, height - top - Math.max(MIN_DECK, safe.bottom + MIN_DECK * 0.9));
    const arenaH = Math.min(usableW * aspect, maxH);
    const arenaW = arenaH / aspect;
    const arena = { x: safe.left + (usableW - arenaW) / 2, y: top, w: arenaW, h: arenaH };
    return { width, height, safe, portrait, touch, compact, arena, deckTop: arena.y + arena.h + 6 };
  }

  // Landscape (and every desktop): the arena gets the whole screen inside the
  // safe area, and anything on top of it floats.
  const arena = {
    x: safe.left,
    y: safe.top,
    w: Math.max(1, width - safe.left - safe.right),
    h: Math.max(1, height - safe.top - safe.bottom),
  };
  return { width, height, safe, portrait, touch, compact, arena, deckTop: height };
}
