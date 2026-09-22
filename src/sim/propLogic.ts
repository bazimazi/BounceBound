/**
 * Prop motion and behaviour.
 *
 * Moving geometry is kinematic: it follows an authored path exactly and
 * transfers its velocity into the ball on contact rather than being pushed by
 * it. That keeps hazards predictable - a crusher arrives when the player expects
 * it - while still letting a moving platform fling the ball, which is the basis
 * of several traversal routes.
 *
 * Every motion is a pure function of `time`, so a room replays identically from
 * the same seed and a rewind for debugging is trivial.
 */

import { TAU, clamp01, lerp } from '../core/math';
import { refreshPoly, type Shape } from './geometry';
import type { Motion, Prop } from './entities';

export function createMotion(partial: Partial<Motion> & Pick<Motion, 'kind'>): Motion {
  return {
    kind: partial.kind,
    ax: partial.ax ?? 0,
    ay: partial.ay ?? 0,
    bx: partial.bx ?? 0,
    by: partial.by ?? 0,
    speed: partial.speed ?? 0.4,
    phase: partial.phase ?? 0,
    amount: partial.amount ?? 0,
    dwell: partial.dwell ?? 0,
  };
}

/** Triangle wave with configurable dwell at both ends, in [0,1]. */
function dwellTriangle(t: number, dwell: number): number {
  const d = clamp01(dwell);
  const travel = (1 - d * 2) / 2;
  if (travel <= 0) return t < 0.5 ? 0 : 1;
  const p = t % 1;
  if (p < travel) return p / travel;
  if (p < travel + d) return 1;
  if (p < travel * 2 + d) return 1 - (p - travel - d) / travel;
  return 0;
}

function setShapePosition(shape: Shape, x: number, y: number): void {
  if (shape.kind === 'segment') {
    const dx = (shape.x2 - shape.x1) / 2;
    const dy = (shape.y2 - shape.y1) / 2;
    shape.x1 = x - dx;
    shape.y1 = y - dy;
    shape.x2 = x + dx;
    shape.y2 = y + dy;
    return;
  }
  shape.x = x;
  shape.y = y;
  if (shape.kind === 'poly') shape.dirty = true;
}

/**
 * Advances one prop. `time` is simulation time so that motion is deterministic
 * and independent of frame pacing.
 */
export function updateProp(prop: Prop, time: number, dt: number): void {
  prop.prevX = prop.kind === 'terrain' ? prop.homeX : currentX(prop);
  prop.prevY = prop.kind === 'terrain' ? prop.homeY : currentY(prop);

  if (prop.flash > 0) prop.flash = Math.max(0, prop.flash - dt * 5);

  const motion = prop.motion;
  if (motion) {
    const t = (time * motion.speed + motion.phase) % 1;
    switch (motion.kind) {
      case 'patrol': {
        const k = dwellTriangle(t, motion.dwell);
        setShapePosition(prop.shape, lerp(motion.ax, motion.bx, k), lerp(motion.ay, motion.by, k));
        break;
      }
      case 'pendulum': {
        const k = (1 - Math.cos(t * TAU)) * 0.5;
        setShapePosition(prop.shape, lerp(motion.ax, motion.bx, k), lerp(motion.ay, motion.by, k));
        break;
      }
      case 'orbit': {
        const a = t * TAU;
        setShapePosition(prop.shape, motion.ax + Math.cos(a) * motion.amount, motion.ay + Math.sin(a) * motion.amount);
        break;
      }
      case 'spin': {
        if (prop.shape.kind === 'poly') {
          prop.shape.rotation = t * TAU * Math.sign(motion.amount || 1);
          prop.shape.dirty = true;
          refreshPoly(prop.shape);
        }
        break;
      }
      case 'cycle': {
        // On for the first `dwell` fraction of the cycle. Used by timed lasers
        // and blinking platforms; `amount` shifts the telegraph window.
        const on = t < (motion.dwell || 0.5);
        prop.active = on;
        break;
      }
      case 'static':
        break;
    }
  }

  // Temporary platforms fade after being touched, then re-arm.
  if (prop.kind === 'temporary' && prop.timer > 0) {
    prop.timer = Math.max(0, prop.timer - dt);
    if (prop.timer === 0) {
      prop.active = !prop.active;
      prop.timer = prop.active ? 0 : (prop.params.respawn ?? 2.4);
    }
  }

  const nx = currentX(prop);
  const ny = currentY(prop);
  prop.velX = dt > 0 ? (nx - prop.prevX) / dt : 0;
  prop.velY = dt > 0 ? (ny - prop.prevY) / dt : 0;

  if (prop.shape.kind === 'poly' && prop.shape.dirty) refreshPoly(prop.shape);
}

export function currentX(prop: Prop): number {
  const s = prop.shape;
  return s.kind === 'segment' ? (s.x1 + s.x2) / 2 : s.x;
}

export function currentY(prop: Prop): number {
  const s = prop.shape;
  return s.kind === 'segment' ? (s.y1 + s.y2) / 2 : s.y;
}

/** True when the prop should participate in solid collision right now. */
export function propIsSolid(prop: Prop): boolean {
  if (prop.destroyed) return false;
  if (!prop.solid) return false;
  if (prop.kind === 'temporary' || prop.kind === 'door') return prop.active;
  return true;
}

/** True when the prop can hurt the ball right now. */
export function propIsHarmful(prop: Prop): boolean {
  if (prop.destroyed || prop.contactDamage <= 0) return false;
  if (prop.kind === 'laser' || prop.kind === 'blade') return prop.active;
  return true;
}

/** Marks a temporary platform as used, starting its fade. */
export function touchTemporary(prop: Prop): void {
  if (prop.kind !== 'temporary' || !prop.active) return;
  if (prop.timer > 0) return;
  prop.timer = prop.params.linger ?? 0.55;
}
