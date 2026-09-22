/**
 * The gameplay event contract.
 *
 * Everything reactive in Bouncebound - upgrades, achievements, audio, screen
 * effects, telemetry, the journal - listens here. Keeping one explicit map means
 * the compiler catches a listener that expects a payload the emitter no longer
 * sends, which is the usual failure mode of loosely typed event buses.
 *
 * Listener order conventions (lower runs first):
 *   -200  engine-level bookkeeping
 *   -100  bounce-family upgrades that redirect the rebound
 *      0  default gameplay resolution
 *    100  impact-family upgrades and secondary effects
 *    200  combo, telemetry and feedback
 */
export const ORDER = {
  engine: -200,
  bounce: -100,
  gameplay: 0,
  effect: 100,
  feedback: 200,
} as const;

import type { ImpactContext } from './impact';
import type { Enemy, Field, Pickup, Projectile, Prop, PickupKind } from './entities';
import type { StatKey } from './stats';

export interface DamagePayload {
  amount: number;
  /** Mutable: defensive upgrades reduce or convert this before it is applied. */
  finalAmount: number;
  sourceKind: 'hazard' | 'enemy' | 'projectile' | 'field' | 'curse' | 'self';
  sourceId: number;
  x: number;
  y: number;
  /** Set by a listener to fully negate the hit (shield, phase, invulnerability). */
  blocked: boolean;
  blockedBy: string;
}

export interface EnemyDamagePayload {
  enemy: Enemy;
  amount: number;
  finalAmount: number;
  source: 'impact' | 'explosion' | 'lightning' | 'burn' | 'poison' | 'field' | 'projectile' | 'environment' | 'other';
  ctx: ImpactContext | null;
  isCrit: boolean;
}

export interface KillPayload {
  enemy: Enemy;
  ctx: ImpactContext | null;
  source: EnemyDamagePayload['source'];
  x: number;
  y: number;
}

export interface ComboPayload {
  value: number;
  delta: number;
  multiplier: number;
  reason: string;
}

export interface PickupPayload {
  kind: PickupKind;
  value: number;
  x: number;
  y: number;
  payload: string;
}

export interface RoomPayload {
  roomIndex: number;
  archetype: string;
  biome: string;
  /** Seconds spent in the room; only present on clear. */
  duration?: number;
  /** True when the room was cleared without taking damage. */
  flawless?: boolean;
}

export interface EffectRequest {
  /** Named effect, e.g. 'explosion', 'arc', 'shockwave'. */
  kind: string;
  x: number;
  y: number;
  radius: number;
  power: number;
  ctx: ImpactContext | null;
  depth: number;
  /** Second point, for effects drawn between two places (arcs, tethers). */
  x2?: number;
  y2?: number;
}

export interface GameEvents extends Record<string, unknown> {
  /** Before the rebound and damage are applied. Mutating the context is expected. */
  impactPre: ImpactContext;
  /** After rebound and damage. Secondary effects trigger here. */
  impact: ImpactContext;
  /** Final observation point; the context is released immediately after. */
  impactResolved: ImpactContext;
  perfectBounce: ImpactContext;
  /** Emitted when the ball touches a floor, ending an airborne chain. */
  grounded: { chain: number; airTime: number };
  /**
   * Once per fixed simulation step, after the world has advanced. Upgrades that
   * need continuous behaviour (charging, marking, trails) live here rather than
   * polling from the render loop, so they stay in lockstep with the physics.
   */
  tick: { dt: number };
  /** An airborne ability was spent. */
  abilityUsed: { kind: 'dash' | 'airBounce'; x: number; y: number };

  enemyDamaged: EnemyDamagePayload;
  enemyKilled: KillPayload;
  enemySpawned: Enemy;
  propDamaged: { prop: Prop; amount: number };
  propDestroyed: { prop: Prop; byBall: boolean };

  ballDamagePre: DamagePayload;
  ballDamaged: DamagePayload;
  ballHealed: { amount: number };
  ballDeath: { cause: string };
  ballRevived: { chargesLeft: number };

  comboChanged: ComboPayload;
  comboBroken: { peak: number };

  pickupCollected: PickupPayload;
  projectileSpawned: Projectile;
  fieldCreated: Field;
  pickupSpawned: Pickup;

  roomEntered: RoomPayload;
  roomCleared: RoomPayload;
  bossPhase: { enemy: Enemy; phase: number };
  bossDefeated: { defId: string };

  upgradeGained: { id: string; name: string; tier: number };
  upgradeRemoved: { id: string };
  synergyActivated: { id: string; name: string };
  statsChanged: { keys: StatKey[] };

  /** Generic effect request so upgrades can trigger effects they do not own. */
  effectRequested: EffectRequest;

  runStarted: { seed: string; ballId: string; boundLevel: number };
  runEnded: { victory: boolean; cause: string };
  discovery: { kind: 'upgrade' | 'enemy' | 'boss' | 'biome' | 'event' | 'synergy' | 'ball' | 'secret'; id: string };
  achievementUnlocked: { id: string };
  /** Player-facing notification. */
  notify: { text: string; tone: 'info' | 'good' | 'bad' | 'rare' };
}
