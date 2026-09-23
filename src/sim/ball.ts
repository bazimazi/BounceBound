/**
 * The ball: state, input model and airborne control.
 *
 * Design intent, in priority order:
 *
 *  1. The ball is *always* bouncing. A floor contact can never settle it, so the
 *     player is never waiting for the game to give control back.
 *  2. Steering is an acceleration, not a velocity set. The ball keeps its
 *     momentum, so routing is a physical negotiation rather than a joystick
 *     readout. Steering authority falls off at very high speed, which makes
 *     "should I preserve this momentum?" a real question.
 *  3. The Perfect Bounce is the skill core. It is a timed input just before
 *     contact that converts a routine bounce into a stronger, safer, more
 *     damaging one. Crucially it is *punished when mistimed*: a whiffed press
 *     locks the input briefly, so mashing is worse than not pressing at all.
 *  4. Diving (holding down) trades control for impact speed, and because damage
 *     scales with speed, that is an offensive decision.
 */

import { clamp, clamp01, damp } from '../core/math';
import { tickDown } from '../core/clock';
import type { ResolvedStats } from './stats';

/** Snapshot of player intent for one simulation step. */
export interface InputState {
  /** Analog steering, -1..1 on each axis. */
  moveX: number;
  moveY: number;
  /** Bounce key currently held. */
  bounceHeld: boolean;
  /** True only on the step the bounce key transitioned to held. */
  bouncePressed: boolean;
  brakeHeld: boolean;
  dashPressed: boolean;
  /** Aim direction in world space (mouse or right stick), normalised. */
  aimX: number;
  aimY: number;
  /** True when the aim vector is meaningful this step. */
  aiming: boolean;
}

export function createInput(): InputState {
  return {
    moveX: 0,
    moveY: 0,
    bounceHeld: false,
    bouncePressed: false,
    brakeHeld: false,
    dashPressed: false,
    aimX: 1,
    aimY: 0,
    aiming: false,
  };
}

export type BounceArmState = 'ready' | 'armed' | 'spent' | 'whiffed';

/** Seconds the bounce input is locked out after a mistimed press. */
export const WHIFF_LOCKOUT = 0.26;
/** Seconds the bounce input is locked out after a successful perfect bounce. */
export const SPENT_LOCKOUT = 0.1;

export interface TrailSample {
  x: number;
  y: number;
  age: number;
  speed: number;
  perfect: boolean;
}

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Position at the start of the current frame, for interpolated rendering. */
  renderPrevX: number;
  renderPrevY: number;

  radius: number;
  hp: number;
  maxHp: number;
  shield: number;
  reviveCharges: number;

  /** Invulnerability remaining. */
  iframes: number;
  /** Phase (intangible) remaining; set by Phantom effects. */
  phase: number;

  alive: boolean;

  /* ---- airborne state ---- */
  airTime: number;
  /** Impacts since the last floor contact. */
  chain: number;
  /** True for a short grace period after touching a floor. */
  grounded: boolean;
  groundedTimer: number;
  /**
   * Whether the player is holding the dive input.
   *
   * Read by the collision solver, because diving suppresses the guaranteed
   * minimum rebound. That pairing is the player's height control: bounce high by
   * default, hold down to stay low and to drop off a platform you would otherwise
   * keep bouncing on.
   */
  diving: boolean;
  lastImpactTime: number;
  /** Impacts this room, used by several upgrades and the room summary. */
  roomImpacts: number;

  /* ---- abilities ---- */
  airDashes: number;
  /** Free mid-air rebounds remaining; granted by the Bounce upgrade family. */
  airBounces: number;
  dashCooldown: number;
  /** Stored momentum for Momentum Storage style upgrades. */
  storedMomentum: number;

  /* ---- perfect bounce timing ---- */
  armState: BounceArmState;
  /** Sim time at which the bounce input was pressed. */
  armedAt: number;
  armLockout: number;
  /** Consecutive perfect bounces, for escalating feedback. */
  perfectStreak: number;
  /** Last perfect quality, 0..1. */
  lastPerfectQuality: number;

  /* ---- presentation ---- */
  /** Squash magnitude 0..1 and the direction it squashes along. */
  squash: number;
  squashAngle: number;
  flash: number;
  spin: number;
  rotation: number;
  trail: TrailSample[];
  trailTimer: number;

  /* ---- per-run scratch used by upgrades ---- */
  scratch: Record<string, number>;
}

export const TRAIL_CAPACITY = 44;

export function createBall(x: number, y: number, stats: ResolvedStats): Ball {
  const trail: TrailSample[] = [];
  for (let i = 0; i < TRAIL_CAPACITY; i++) trail.push({ x, y, age: Infinity, speed: 0, perfect: false });
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    renderPrevX: x,
    renderPrevY: y,
    radius: stats.radius,
    hp: stats.maxHealth,
    maxHp: stats.maxHealth,
    shield: stats.shieldCharges,
    reviveCharges: stats.reviveCharges,
    iframes: 0,
    phase: 0,
    alive: true,
    airTime: 0,
    chain: 0,
    grounded: false,
    groundedTimer: 0,
    diving: false,
    lastImpactTime: -10,
    roomImpacts: 0,
    airDashes: stats.airDashCharges,
    airBounces: stats.airBounceCharges,
    dashCooldown: 0,
    storedMomentum: 0,
    armState: 'ready',
    armedAt: -10,
    armLockout: 0,
    perfectStreak: 0,
    lastPerfectQuality: 0,
    squash: 0,
    squashAngle: 0,
    flash: 0,
    spin: 0,
    rotation: 0,
    trail,
    trailTimer: 0,
    scratch: {},
  };
}

/** Re-applies stat-derived values, preserving current health fraction. */
export function syncBallToStats(ball: Ball, stats: ResolvedStats, preserveHealthFraction = true): void {
  const fraction = ball.maxHp > 0 ? ball.hp / ball.maxHp : 1;
  ball.radius = stats.radius;
  ball.maxHp = stats.maxHealth;
  ball.hp = preserveHealthFraction ? clamp(fraction * stats.maxHealth, 1, stats.maxHealth) : stats.maxHealth;
  ball.reviveCharges = Math.max(ball.reviveCharges, stats.reviveCharges);
}

export function speedOf(ball: Ball): number {
  return Math.hypot(ball.vx, ball.vy);
}

/**
 * Steering authority as a function of speed.
 *
 * At low speed the player has full control; approaching the speed cap authority
 * falls to `steerAuthorityAtSpeed`. This is what stops "hold toward target" from
 * being a universally correct input and makes high-momentum builds a genuine
 * trade of power for precision.
 */
export function steerAuthority(ball: Ball, stats: ResolvedStats): number {
  const speed = speedOf(ball);
  const t = clamp01((speed - stats.maxSpeed * 0.35) / (stats.maxSpeed * 0.65));
  return 1 - t * (1 - stats.steerAuthorityAtSpeed);
}

/** True when the player is deliberately diving to build impact speed. */
export function isDiving(input: InputState): boolean {
  return input.moveY > 0.55;
}

/**
 * How much of the guaranteed minimum rebound survives a dive.
 *
 * Low enough that holding down reliably keeps the ball near the floor and lets it
 * fall off a narrow platform, high enough that the ball still never stops moving.
 */
export const DIVE_BOUNCE_SCALE = 0.3;

/** Horizontal velocity decay per second while steering, and while coasting. */
const LATERAL_DRAG_STEERING = 0.3;
const LATERAL_DRAG_IDLE = 1.15;

/**
 * Applies player intent and gravity for one fixed step. Collision resolution
 * happens afterwards in the world solver.
 */
export function applyBallForces(
  ball: Ball,
  input: InputState,
  stats: ResolvedStats,
  dt: number,
  gravityX: number,
  gravityY: number,
): void {
  const authority = steerAuthority(ball, stats);

  // Horizontal steering: full authority, scaled by speed.
  if (input.moveX !== 0) {
    ball.vx += input.moveX * stats.airAccel * authority * dt;
  }

  // Vertical steering is deliberately weaker so gravity remains the dominant
  // force and arcs stay readable.
  if (input.moveY !== 0) {
    ball.vy += input.moveY * stats.airAccelVertical * authority * dt;
  }

  // Gravity, amplified while diving.
  const diveScale = isDiving(input) ? stats.diveGravity : 1;
  ball.vx += gravityX * dt;
  ball.vy += gravityY * diveScale * dt;

  /**
   * Lateral bleed.
   *
   * Horizontal speed decays continuously; vertical speed does not, because that is
   * gravity's business. Without this, wall contacts compound: each one returns
   * nearly all of the tangential component, so a few ricochets accumulate into a
   * side-to-side ping-pong that is fast, loud, and impossible to steer out of.
   * Playtesting described exactly that as "too bouncy to the sides".
   *
   * The drag is much weaker while the player is actively steering, so deliberately
   * building and keeping speed - which Momentum builds depend on - still works. Let
   * go of the stick and the ball settles into something controllable.
   */
  const lateralDrag = input.moveX !== 0 ? LATERAL_DRAG_STEERING : LATERAL_DRAG_IDLE;
  ball.vx *= Math.exp(-lateralDrag * dt);

  // Air brake: exponential damping plus a control bonus, at the cost of the
  // momentum that damage scaling depends on.
  if (input.brakeHeld && stats.airBrakePower > 0) {
    const factor = Math.exp(-stats.airBrakePower * dt);
    ball.vx *= factor;
    ball.vy *= factor;
  }

  // Speed cap applied as a soft clamp so hitting it does not feel like a wall.
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > stats.maxSpeed) {
    const target = damp(speed, stats.maxSpeed, 14, dt);
    const k = target / speed;
    ball.vx *= k;
    ball.vy *= k;
  }
}

/** Advances timers that are independent of collision. */
export function tickBall(ball: Ball, stats: ResolvedStats, dt: number, simTime: number): void {
  ball.iframes = tickDown(ball.iframes, dt);
  ball.phase = tickDown(ball.phase, dt);
  ball.dashCooldown = tickDown(ball.dashCooldown, dt);
  ball.armLockout = tickDown(ball.armLockout, dt);
  ball.airTime += dt;
  ball.groundedTimer = tickDown(ball.groundedTimer, dt);
  ball.grounded = ball.groundedTimer > 0;
  ball.flash = tickDown(ball.flash, dt * 6);
  ball.squash = Math.max(0, ball.squash - dt * 5.5);

  // Rotation follows horizontal velocity so the ball reads as rolling/spinning.
  ball.spin = damp(ball.spin, ball.vx / Math.max(6, ball.radius) * 0.9, 8, dt);
  ball.rotation += ball.spin * dt;

  // The armed window expires into a whiff, which is the anti-mash mechanism.
  if (ball.armState === 'armed' && simTime - ball.armedAt > stats.perfectWindow) {
    ball.armState = 'whiffed';
    ball.armLockout = WHIFF_LOCKOUT;
  }
  if ((ball.armState === 'whiffed' || ball.armState === 'spent') && ball.armLockout <= 0) {
    ball.armState = 'ready';
  }

  if (ball.trailTimer <= 0) {
    ball.trailTimer = 0.012;
  } else {
    ball.trailTimer -= dt;
  }
  for (let i = 0; i < ball.trail.length; i++) {
    const sample = ball.trail[i];
    if (sample.age < Infinity) sample.age += dt;
  }
}

/** Pushes a trail sample; called from the world after integration. */
export function pushTrail(ball: Ball, perfect = false): void {
  // Reuse the oldest slot to avoid allocation.
  let oldest = ball.trail[0];
  for (let i = 1; i < ball.trail.length; i++) {
    if (ball.trail[i].age > oldest.age) oldest = ball.trail[i];
  }
  oldest.x = ball.x;
  oldest.y = ball.y;
  oldest.age = 0;
  oldest.speed = Math.hypot(ball.vx, ball.vy);
  oldest.perfect = perfect;
}

/** Handles the bounce input edge. Returns true when the input armed a window. */
export function tryArmBounce(ball: Ball, input: InputState, simTime: number): boolean {
  if (!input.bouncePressed) return false;
  if (ball.armState !== 'ready') return false;
  ball.armState = 'armed';
  ball.armedAt = simTime;
  return true;
}

/**
 * Evaluates whether a contact occurring now counts as a Perfect Bounce, and
 * consumes the armed window. Quality is 1.0 for a press landing exactly at
 * contact and falls to 0 at the edge of the window, which rewards precision
 * beyond simply being inside the window.
 */
export function consumePerfect(ball: Ball, stats: ResolvedStats, simTime: number): number {
  if (ball.armState !== 'armed') return 0;
  const elapsed = simTime - ball.armedAt;
  if (elapsed < 0 || elapsed > stats.perfectWindow) return 0;
  ball.armState = 'spent';
  ball.armLockout = SPENT_LOCKOUT;
  const quality = 1 - clamp01(elapsed / stats.perfectWindow);
  ball.lastPerfectQuality = quality;
  ball.perfectStreak++;
  return Math.max(0.05, quality);
}

/** Called when a non-perfect impact happens, to break the perfect streak. */
export function breakPerfectStreak(ball: Ball): void {
  ball.perfectStreak = 0;
}

/**
 * Guarantees perpetual bouncing.
 *
 * Without this, low-energy floor contacts asymptotically settle and the game
 * stops. Enforcing a minimum outbound normal speed on floor-ish surfaces means
 * the ball always returns to the air. The boost is deliberately *only* applied
 * on floors: a wall that kicks the ball back would feel wrong and would break
 * wall-riding play.
 */
export function enforceMinimumBounce(
  outVx: number,
  outVy: number,
  nx: number,
  ny: number,
  minSpeed: number,
): { vx: number; vy: number; boosted: boolean } {
  if (ny > -0.4) return { vx: outVx, vy: outVy, boosted: false };
  const normalComponent = outVx * nx + outVy * ny;
  if (normalComponent >= minSpeed) return { vx: outVx, vy: outVy, boosted: false };
  const deficit = minSpeed - normalComponent;
  return { vx: outVx + nx * deficit, vy: outVy + ny * deficit, boosted: true };
}

/** Applies squash-and-stretch feedback for an impact along a normal. */
export function applyImpactSquash(ball: Ball, nx: number, ny: number, intensity: number): void {
  ball.squash = Math.min(1, Math.max(ball.squash, 0.25 + intensity * 0.6));
  ball.squashAngle = Math.atan2(ny, nx);
  ball.flash = Math.max(ball.flash, Math.min(1, 0.4 + intensity));
}

/** Consumes an air dash if available, returning true on success. */
export function tryAirDash(ball: Ball, input: InputState, stats: ResolvedStats): boolean {
  if (stats.airDashCharges <= 0) return false;
  if (ball.airDashes <= 0 || ball.dashCooldown > 0) return false;
  let dx: number;
  let dy: number;
  if (input.aiming) {
    dx = input.aimX;
    dy = input.aimY;
  } else if (input.moveX !== 0 || input.moveY !== 0) {
    const len = Math.hypot(input.moveX, input.moveY) || 1;
    dx = input.moveX / len;
    dy = input.moveY / len;
  } else {
    const speed = Math.hypot(ball.vx, ball.vy) || 1;
    dx = ball.vx / speed;
    dy = ball.vy / speed;
  }
  ball.airDashes--;
  ball.dashCooldown = 0.18;
  // A dash *sets* rather than adds speed along the dash axis, so it is a
  // reliable escape tool even at awkward velocities.
  const power = stats.airDashPower;
  const along = ball.vx * dx + ball.vy * dy;
  const keep = Math.max(0, along);
  ball.vx = dx * (keep * 0.35 + power) + (ball.vx - dx * along) * 0.25;
  ball.vy = dy * (keep * 0.35 + power) + (ball.vy - dy * along) * 0.25;
  return true;
}

/** Refills air resources; called on floor contact and on enemy bounces. */
export function refreshAirResources(ball: Ball, stats: ResolvedStats): void {
  ball.airDashes = stats.airDashCharges;
  ball.airBounces = stats.airBounceCharges;
}

/**
 * A free mid-air rebound.
 *
 * This is the Bounce family's signature ability: pressing the bounce input far
 * from any surface spends a charge and kicks the ball back the way a floor would
 * have. It turns the perfect-bounce input into a single verb that means "bounce
 * now" whether or not there is anything to bounce off, which is much easier to
 * internalise than a separate jump button.
 */
export function performAirBounce(ball: Ball, stats: ResolvedStats): boolean {
  if (ball.airBounces <= 0) return false;
  ball.airBounces--;
  const minimum = Math.max(stats.minBounceSpeed * 1.15, 420);
  // Cancel downward motion entirely, then apply the rebound: a mid-air bounce
  // has to feel decisive, not like a nudge fighting gravity.
  ball.vy = -Math.max(minimum, Math.abs(ball.vy) * 0.85);
  ball.squash = Math.max(ball.squash, 0.5);
  ball.squashAngle = Math.PI / 2;
  return true;
}
