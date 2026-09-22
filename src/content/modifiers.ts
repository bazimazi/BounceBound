/**
 * Bound levels: the endgame difficulty ladder.
 *
 * Each level adds one *named* modifier rather than a global multiplier, so the
 * challenge stays legible: a player knows exactly which rule made the last run
 * harder, and can talk about Bound 7 as a specific thing rather than as a number.
 *
 * The ordering matters. Early levels remove safety nets, middle levels add
 * complexity, late levels attack the player's habits. None of them simply inflate
 * enemy health, because that produces longer runs rather than harder ones.
 */

import type { StatModifiers } from '../sim/stats';

export interface BoundModifier {
  id: string;
  name: string;
  /** What actually changes, in the player's terms. */
  description: string;
  /** Level at which this modifier is introduced. */
  level: number;
  /** Stat penalties applied to the ball. */
  playerModifiers?: StatModifiers;
  /** Generator and world adjustments, read by the run layer. */
  world?: {
    enemyHealthScale?: number;
    enemyDamageScale?: number;
    enemySpeedScale?: number;
    hazardDamageScale?: number;
    /** Extra threat budget fraction. */
    threatScale?: number;
    /** Multiplier on healing received. */
    healScale?: number;
    /** Removes this many upgrade options from offers. */
    fewerChoices?: number;
    /** Elites appear from this depth onward. */
    eliteFromDepth?: number;
    /** Multiplier on shard and echo rewards. */
    rewardScale?: number;
    /** Reduces the number of respite rooms generated. */
    fewerRespites?: boolean;
    /** Enables hidden-node-heavy maps. */
    obscureMap?: boolean;
    /** Gravity multiplier for every biome. */
    gravityScale?: number;
    /** Temporary platforms everywhere. */
    unstableGround?: boolean;
  };
}

export const BOUND_MODIFIERS: BoundModifier[] = [
  {
    id: 'bound_tighter',
    name: 'Tighter',
    description: 'Enemies are tougher and hit harder. A gentle recalibration of everything you know.',
    level: 1,
    world: { enemyHealthScale: 1.18, enemyDamageScale: 1.15, rewardScale: 1.15 },
  },
  {
    id: 'bound_thirst',
    name: 'Thirst',
    description: 'Healing is halved, and Wellsprings are rarer. Integrity becomes a budget.',
    level: 2,
    world: { healScale: 0.5, fewerRespites: true, rewardScale: 1.25 },
  },
  {
    id: 'bound_early_primes',
    name: 'Early Primes',
    description: 'Elites appear from the second room onward.',
    level: 3,
    world: { eliteFromDepth: 2, threatScale: 1.1, rewardScale: 1.35 },
  },
  {
    id: 'bound_sharpened',
    name: 'Sharpened',
    description: 'Every hazard in every room hurts substantially more.',
    level: 4,
    world: { hazardDamageScale: 1.8, rewardScale: 1.45 },
  },
  {
    id: 'bound_narrow',
    name: 'Narrow',
    description: 'One fewer option on every upgrade offer. Your build has to commit earlier.',
    level: 5,
    world: { fewerChoices: 1, rewardScale: 1.55 },
  },
  {
    id: 'bound_quickened',
    name: 'Quickened',
    description: 'Everything hostile moves and acts noticeably faster.',
    level: 6,
    world: { enemySpeedScale: 1.3, rewardScale: 1.7 },
  },
  {
    id: 'bound_obscured',
    name: 'Obscured',
    description: 'Most of the route is hidden until you are standing next to it.',
    level: 7,
    world: { obscureMap: true, rewardScale: 1.85 },
  },
  {
    id: 'bound_heavy_air',
    name: 'Heavy Air',
    description: 'Gravity is stronger everywhere. Every arc you have learned is now shorter.',
    level: 8,
    world: { gravityScale: 1.25, rewardScale: 2 },
    playerModifiers: { airAccel: 0.92 },
  },
  {
    id: 'bound_brittle_world',
    name: 'Brittle World',
    description: 'Platforms are provisional in every biome. The floor is a loan.',
    level: 9,
    world: { unstableGround: true, rewardScale: 2.2 },
  },
  {
    id: 'bound_swarming',
    name: 'Swarming',
    description: 'Rooms hold far more enemies, and the budget stretches to fit them.',
    level: 10,
    world: { threatScale: 1.45, enemyHealthScale: 1.1, rewardScale: 2.4 },
  },
  {
    id: 'bound_fragile_shell',
    name: 'Fragile Shell',
    description: 'You have a third less integrity and a shorter recovery window.',
    level: 11,
    playerModifiers: { maxHealth: 0.66, iframeDuration: -0.15 },
    world: { rewardScale: 2.7 },
  },
  {
    id: 'bound_unbound',
    name: 'Unbound',
    description: 'Bosses gain an additional phase and no longer pause between them.',
    level: 12,
    world: { enemyHealthScale: 1.15, enemyDamageScale: 1.2, rewardScale: 3 },
  },
];

export interface ResolvedBound {
  level: number;
  active: BoundModifier[];
  enemyHealthScale: number;
  enemyDamageScale: number;
  enemySpeedScale: number;
  hazardDamageScale: number;
  threatScale: number;
  healScale: number;
  fewerChoices: number;
  eliteFromDepth: number;
  rewardScale: number;
  fewerRespites: boolean;
  obscureMap: boolean;
  gravityScale: number;
  unstableGround: boolean;
  playerModifiers: StatModifiers;
}

/** Collapses every modifier at or below `level` into one resolved record. */
export function resolveBound(level: number): ResolvedBound {
  const active = BOUND_MODIFIERS.filter((m) => m.level <= level);
  const out: ResolvedBound = {
    level,
    active,
    enemyHealthScale: 1,
    enemyDamageScale: 1,
    enemySpeedScale: 1,
    hazardDamageScale: 1,
    threatScale: 1,
    healScale: 1,
    fewerChoices: 0,
    eliteFromDepth: 4,
    rewardScale: 1,
    fewerRespites: false,
    obscureMap: false,
    gravityScale: 1,
    unstableGround: false,
    playerModifiers: {},
  };

  for (const modifier of active) {
    const world = modifier.world;
    if (world) {
      if (world.enemyHealthScale) out.enemyHealthScale *= world.enemyHealthScale;
      if (world.enemyDamageScale) out.enemyDamageScale *= world.enemyDamageScale;
      if (world.enemySpeedScale) out.enemySpeedScale *= world.enemySpeedScale;
      if (world.hazardDamageScale) out.hazardDamageScale *= world.hazardDamageScale;
      if (world.threatScale) out.threatScale *= world.threatScale;
      if (world.healScale) out.healScale *= world.healScale;
      if (world.fewerChoices) out.fewerChoices += world.fewerChoices;
      if (world.eliteFromDepth !== undefined) out.eliteFromDepth = Math.min(out.eliteFromDepth, world.eliteFromDepth);
      // Reward scale is set, not multiplied: the table already states the total.
      if (world.rewardScale) out.rewardScale = Math.max(out.rewardScale, world.rewardScale);
      if (world.fewerRespites) out.fewerRespites = true;
      if (world.obscureMap) out.obscureMap = true;
      if (world.gravityScale) out.gravityScale *= world.gravityScale;
      if (world.unstableGround) out.unstableGround = true;
    }
    if (modifier.playerModifiers) {
      for (const [key, value] of Object.entries(modifier.playerModifiers)) {
        const typed = key as keyof StatModifiers;
        // Values below 1 for health-like stats are intended as multipliers, so
        // they are stored separately by the run layer; here they are merged as
        // the table declares them.
        out.playerModifiers[typed] = value as number;
      }
    }
  }
  return out;
}

export function boundName(level: number): string {
  if (level <= 0) return 'Unbound off';
  const modifier = BOUND_MODIFIERS.find((m) => m.level === level);
  return modifier ? `Bound ${level}: ${modifier.name}` : `Bound ${level}`;
}
