/**
 * The impact pipeline.
 *
 * This is the single most important extension point in the game. Every
 * collision - surface, enemy, breakable, boss plate - is described by one
 * `ImpactContext` record that carries the full kinematic and gameplay situation.
 * Upgrades subscribe to impact events and read or mutate that record; they never
 * touch the collision solver.
 *
 * Resolution order per impact:
 *
 *   1. Physics produces the raw contact (normal, depth, velocities).
 *   2. `buildImpact` derives the gameplay view: speeds, angles, combo state,
 *      perfect/critical flags, base damage.
 *   3. `impactPre` listeners may veto, redirect the rebound or rescale damage.
 *      Bounce-family upgrades live here.
 *   4. The solver applies the rebound and deals damage.
 *   5. `impact` listeners fire secondary effects: explosions, arcs, fields,
 *      projectiles, resource generation. Impact-family upgrades live here.
 *   6. `impactResolved` listeners observe the final numbers: combo, telemetry,
 *      audio, screen effects.
 *
 * Contexts are pooled because a heavy chain reaction can produce dozens per
 * frame and allocation churn during a combo is felt as stutter.
 */

import { Pool } from '../core/pool';
import type { SurfaceClass, MaterialId } from './materials';
import { classifySurface, getMaterial } from './materials';
import type { Enemy, Prop } from './entities';

export type ImpactTargetKind = 'surface' | 'breakable' | 'enemy' | 'boss' | 'hazard' | 'projectile';

/** Why the rebound was modified, for readable debug output. */
export type ReboundTag = 'normal' | 'perfect' | 'redirected' | 'preserved' | 'phase' | 'reversed';

export interface ImpactContext {
  /* ---- identity ---- */
  targetKind: ImpactTargetKind;
  enemy: Enemy | null;
  prop: Prop | null;
  material: MaterialId;
  surface: SurfaceClass;
  /** Stable id of the thing hit, for de-duplication within a chain. */
  targetId: number;

  /* ---- contact geometry ---- */
  px: number;
  py: number;
  nx: number;
  ny: number;

  /* ---- kinematics ---- */
  inVx: number;
  inVy: number;
  /** Mutable: listeners may redirect the rebound before it is applied. */
  outVx: number;
  outVy: number;
  /** Magnitude of the incoming velocity. */
  impactSpeed: number;
  /** Incoming speed along the contact normal (always >= 0 for a real hit). */
  normalSpeed: number;
  /** Incoming speed along the surface tangent. */
  tangentSpeed: number;
  /** Speed relative to a moving target, which is what heavy enemies modify. */
  relativeSpeed: number;
  /**
   * Incidence angle in radians measured from the surface normal.
   * 0 = dead-on, PI/2 = grazing. Several upgrades reward grazing or dead-on hits.
   */
  incidence: number;
  reboundTag: ReboundTag;

  /* ---- gameplay state at the moment of contact ---- */
  combo: number;
  comboBefore: number;
  /** Impacts since the last floor contact; the airborne chain length. */
  chain: number;
  /** Total impacts this room. */
  roomImpacts: number;
  /** Seconds since the previous impact of any kind. */
  timeSinceLast: number;
  /** Seconds since the ball last touched a floor. */
  airTime: number;

  /* ---- outcome (mutable during the pipeline) ---- */
  isPerfect: boolean;
  isCrit: boolean;
  /** How precisely the perfect-bounce input landed, in [0,1]. */
  perfectQuality: number;
  damage: number;
  damageDealt: number;
  killed: boolean;
  /** Set by phase effects: the ball passes through instead of rebounding. */
  passThrough: boolean;
  /** Set when the impact should not count for combo (e.g. harmless graze). */
  ignoreCombo: boolean;
  /** Suppresses the default bounce sound so a special cue can replace it. */
  silent: boolean;
  /** Names of effects that fired, shown by the debug overlay and hit readout. */
  effects: string[];
  /** Effect recursion depth, so chain effects cannot loop forever. */
  depth: number;
}

function blank(): ImpactContext {
  return {
    targetKind: 'surface',
    enemy: null,
    prop: null,
    material: 'stone',
    surface: 'floor',
    targetId: -1,
    px: 0,
    py: 0,
    nx: 0,
    ny: -1,
    inVx: 0,
    inVy: 0,
    outVx: 0,
    outVy: 0,
    impactSpeed: 0,
    normalSpeed: 0,
    tangentSpeed: 0,
    relativeSpeed: 0,
    incidence: 0,
    reboundTag: 'normal',
    combo: 0,
    comboBefore: 0,
    chain: 0,
    roomImpacts: 0,
    timeSinceLast: 0,
    airTime: 0,
    isPerfect: false,
    isCrit: false,
    perfectQuality: 0,
    damage: 0,
    damageDealt: 0,
    killed: false,
    passThrough: false,
    ignoreCombo: false,
    silent: false,
    effects: [],
    depth: 0,
  };
}

function reset(ctx: ImpactContext): void {
  ctx.enemy = null;
  ctx.prop = null;
  ctx.effects.length = 0;
  ctx.isPerfect = false;
  ctx.isCrit = false;
  ctx.passThrough = false;
  ctx.ignoreCombo = false;
  ctx.silent = false;
  ctx.killed = false;
  ctx.damageDealt = 0;
  ctx.reboundTag = 'normal';
  ctx.depth = 0;
  ctx.perfectQuality = 0;
}

export const impactPool = new Pool<ImpactContext>(blank, reset, 48);

export interface ImpactSeed {
  targetKind: ImpactTargetKind;
  targetId: number;
  material: MaterialId;
  px: number;
  py: number;
  nx: number;
  ny: number;
  inVx: number;
  inVy: number;
  /** Target velocity, used for relative speed on movers and flying enemies. */
  targetVx: number;
  targetVy: number;
  enemy?: Enemy | null;
  prop?: Prop | null;
}

/**
 * Derives the full gameplay view of a contact.
 *
 * Damage uses `base * (1 + speedScale * speedFactor) * comboFactor`, where the
 * speed factor is normalised against a reference impact speed. Scaling on
 * *velocity* rather than a flat number is what makes the physics the combat
 * system: choosing to dive before a hit, or to preserve momentum through a
 * ricochet, is a damage decision.
 */
export const REFERENCE_IMPACT_SPEED = 700;

export function buildImpact(seed: ImpactSeed): ImpactContext {
  const ctx = impactPool.obtain();
  ctx.targetKind = seed.targetKind;
  ctx.targetId = seed.targetId;
  ctx.material = seed.material;
  ctx.enemy = seed.enemy ?? null;
  ctx.prop = seed.prop ?? null;
  ctx.px = seed.px;
  ctx.py = seed.py;
  ctx.nx = seed.nx;
  ctx.ny = seed.ny;
  ctx.inVx = seed.inVx;
  ctx.inVy = seed.inVy;
  ctx.outVx = seed.inVx;
  ctx.outVy = seed.inVy;
  ctx.surface = classifySurface(seed.nx, seed.ny);

  const speed = Math.hypot(seed.inVx, seed.inVy);
  ctx.impactSpeed = speed;
  // Normal component of the *approach*: negative dot means moving into surface.
  const alongNormal = seed.inVx * seed.nx + seed.inVy * seed.ny;
  ctx.normalSpeed = Math.max(0, -alongNormal);
  ctx.tangentSpeed = Math.sqrt(Math.max(0, speed * speed - alongNormal * alongNormal));
  ctx.incidence = speed > 1e-4 ? Math.acos(Math.min(1, ctx.normalSpeed / speed)) : 0;

  const relVx = seed.inVx - seed.targetVx;
  const relVy = seed.inVy - seed.targetVy;
  ctx.relativeSpeed = Math.hypot(relVx, relVy);
  return ctx;
}

/** Normalised 0..N speed factor used by damage and feedback intensity. */
export function speedFactor(ctx: ImpactContext): number {
  return ctx.relativeSpeed / REFERENCE_IMPACT_SPEED;
}

/** 0..1 intensity used to scale shake, particles and audio. */
export function impactIntensity(ctx: ImpactContext): number {
  const speedPart = Math.min(1, ctx.relativeSpeed / 1300);
  const perfectPart = ctx.isPerfect ? 0.25 : 0;
  const critPart = ctx.isCrit ? 0.2 : 0;
  const killPart = ctx.killed ? 0.2 : 0;
  return Math.min(1.6, speedPart + perfectPart + critPart + killPart);
}

/** Restitution actually used, combining material, stats and perfect bonus. */
export function effectiveRestitution(ctx: ImpactContext, statRestitution: number, bounceBonus: number): number {
  return getMaterial(ctx.material).restitution * statRestitution + bounceBonus;
}

/** Applies a standard reflection to the context's outgoing velocity. */
export function applyReflection(ctx: ImpactContext, restitution: number, tangentRetention: number): void {
  const vn = ctx.inVx * ctx.nx + ctx.inVy * ctx.ny;
  const tangentX = ctx.inVx - vn * ctx.nx;
  const tangentY = ctx.inVy - vn * ctx.ny;
  const reboundN = -vn * restitution;
  ctx.outVx = tangentX * tangentRetention + ctx.nx * reboundN;
  ctx.outVy = tangentY * tangentRetention + ctx.ny * reboundN;
}

/** Human-readable one-line summary used by the debug impact log. */
export function describeImpact(ctx: ImpactContext): string {
  const target =
    ctx.targetKind === 'enemy' || ctx.targetKind === 'boss'
      ? ctx.enemy?.defId ?? 'enemy'
      : ctx.prop
        ? ctx.prop.kind
        : ctx.surface;
  const flags = [
    ctx.isPerfect ? 'PERFECT' : '',
    ctx.isCrit ? 'CRIT' : '',
    ctx.killed ? 'KILL' : '',
    ctx.passThrough ? 'PHASE' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `${target} ${Math.round(ctx.relativeSpeed)}u/s ${Math.round((ctx.incidence * 180) / Math.PI)}deg dmg ${ctx.damageDealt.toFixed(
    0,
  )} x${ctx.combo} ${flags}${ctx.effects.length ? ` [${ctx.effects.join(',')}]` : ''}`.trim();
}
