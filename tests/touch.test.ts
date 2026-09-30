import { describe, expect, it } from 'vitest';
import { computeLayout, NO_INSETS } from '../src/game/layout';
import { TouchControls, touchGeometry } from '../src/game/touch';
import { defaultSettings } from '../src/meta/settings';
import { ROOM_H, ROOM_W } from '../src/gen/templates';

function controls(width: number, height: number): { touch: TouchControls; actions: string[] } {
  const actions: string[] = [];
  const touch = new TouchControls((role) => actions.push(role));
  const layout = computeLayout(width, height, NO_INSETS, true);
  touch.visible = true;
  touch.setGeometry(touchGeometry(layout, defaultSettings()));
  return { touch, actions };
}

describe('screen layout', () => {
  it('gives a portrait phone a full-width arena with a control deck beneath it', () => {
    const layout = computeLayout(390, 844, { top: 47, right: 0, bottom: 34, left: 0 }, true);
    expect(layout.portrait).toBe(true);
    expect(layout.arena.w).toBeCloseTo(390, 0);
    expect(layout.arena.h / layout.arena.w).toBeCloseTo(ROOM_H / ROOM_W, 3);
    expect(layout.arena.y).toBeGreaterThan(47);
    expect(layout.deckTop).toBeGreaterThan(layout.arena.y + layout.arena.h);
    expect(844 - layout.deckTop).toBeGreaterThan(200);
  });

  it('keeps the whole screen for the arena in landscape, inside the safe area', () => {
    const layout = computeLayout(844, 390, { top: 0, right: 47, bottom: 21, left: 47 }, true);
    expect(layout.portrait).toBe(false);
    expect(layout.compact).toBe(true);
    expect(layout.arena).toEqual({ x: 47, y: 0, w: 750, h: 369 });
  });

  it('leaves a desktop window alone', () => {
    const layout = computeLayout(1280, 720, NO_INSETS, false);
    expect(layout.compact).toBe(false);
    expect(layout.arena).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
  });
});

describe('touch controls', () => {
  it('steers with a stick on the left and pulls down to dive', () => {
    const { touch } = controls(844, 390);
    touch.touchStart(1, 150, 250);
    touch.touchMove(1, 250, 250);
    expect(touch.moveX).toBe(1);
    expect(touch.moveY).toBe(0);
    touch.touchMove(1, 150, 350);
    expect(touch.moveY).toBeGreaterThan(0.55);
    touch.touchEnd(1);
    expect(touch.moveX).toBe(0);
    expect(touch.moveY).toBe(0);
  });

  it('does not dive when the thumb only drifts a little downward while steering', () => {
    const { touch } = controls(844, 390);
    touch.touchStart(1, 150, 250);
    touch.touchMove(1, 210, 265);
    expect(touch.moveX).toBeGreaterThan(0.5);
    expect(touch.moveY).toBe(0);
  });

  it('treats the whole right side as the bounce button, apart from brake', () => {
    const { touch } = controls(844, 390);
    const g = touchGeometry(computeLayout(844, 390, NO_INSETS, true), defaultSettings());
    touch.touchStart(2, 600, 120);
    expect(touch.isHeld('bounce')).toBe(true);
    touch.touchEnd(2);
    touch.touchStart(3, g.brake.x, g.brake.y);
    expect(touch.isHeld('brake')).toBe(true);
    expect(touch.isHeld('bounce')).toBe(false);
  });

  it('latches a tap that begins and ends between two frames', () => {
    const { touch } = controls(844, 390);
    touch.touchStart(4, 700, 300);
    touch.touchEnd(4);
    expect(touch.isHeld('bounce')).toBe(false);
    expect(touch.consumePress('bounce')).toBe(true);
    expect(touch.consumePress('bounce')).toBe(false);
  });

  it('only offers the dash button when the build has a dash', () => {
    const { touch } = controls(844, 390);
    const g = touchGeometry(computeLayout(844, 390, NO_INSETS, true), defaultSettings());
    touch.touchStart(5, g.dash.x, g.dash.y);
    expect(touch.isHeld('bounce')).toBe(true);
    touch.touchEnd(5);
    touch.setDashShown(true);
    touch.touchStart(6, g.dash.x, g.dash.y);
    expect(touch.isHeld('dash')).toBe(true);
  });

  it('fires pause and build from their corner buttons', () => {
    const { touch, actions } = controls(844, 390);
    const g = touchGeometry(computeLayout(844, 390, NO_INSETS, true), defaultSettings());
    touch.touchStart(7, g.pause.x, g.pause.y);
    touch.touchStart(8, g.build.x, g.build.y);
    expect(actions).toEqual(['pause', 'build']);
  });

  it('mirrors for a player who steers with the right thumb', () => {
    const settings = { ...defaultSettings(), touchSwapSides: true };
    const touch = new TouchControls(() => {});
    touch.setGeometry(touchGeometry(computeLayout(844, 390, NO_INSETS, true), settings));
    touch.touchStart(1, 700, 250);
    touch.touchMove(1, 640, 250);
    expect(touch.moveX).toBeLessThan(0);
    touch.touchStart(2, 100, 250);
    expect(touch.isHeld('bounce')).toBe(true);
  });

  it('places portrait controls in the deck, below the arena', () => {
    const layout = computeLayout(390, 844, NO_INSETS, true);
    const g = touchGeometry(layout, defaultSettings());
    for (const c of [g.stickHome, g.bounce, g.brake]) {
      expect(c.y - c.r).toBeGreaterThan(layout.arena.y + layout.arena.h);
      expect(c.x - c.r).toBeGreaterThanOrEqual(0);
      expect(c.x + c.r).toBeLessThanOrEqual(390);
    }
  });
});
