/**
 * Runtime entity shapes.
 *
 * Entities are plain mutable records rather than classes with behaviour. All
 * behaviour lives in data-driven definitions (`src/content/*`) plus shared
 * systems (`src/sim/*`), which is what lets a new enemy or prop be added as a
 * data entry instead of a new subclass.
 */

import type { CircleShape, PolyShape, Shape } from './geometry';
import type { MaterialId } from './materials';

export type Faction = 'player' | 'hostile' | 'neutral';

/* ------------------------------------------------------------------ props -- */

/**
 * Everything the room is built from: walls, platforms, hazards, breakables,
 * bounce pads, launchers, switches. One record type with a behaviour tag keeps
 * room templates declarative.
 */
export type PropKind =
  | 'terrain'
  | 'platform'
  | 'oneway'
  | 'breakable'
  | 'spike'
  | 'bouncepad'
  | 'launcher'
  | 'crusher'
  | 'blade'
  | 'laser'
  | 'teleporter'
  | 'gravityzone'
  | 'slowzone'
  | 'switch'
  | 'door'
  | 'temporary'
  | 'goal';

export type MotionKind = 'static' | 'patrol' | 'orbit' | 'spin' | 'pendulum' | 'cycle';

export interface Motion {
  kind: MotionKind;
  /** Patrol/pendulum endpoints, or orbit centre. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Cycles per second. */
  speed: number;
  /** Phase offset in [0,1) so a row of crushers can be staggered. */
  phase: number;
  /** For spin/orbit: radians per second or orbit radius. */
  amount: number;
  /** Fraction of the cycle spent paused at the endpoints (crusher dwell). */
  dwell: number;
}

export interface Prop {
  id: number;
  kind: PropKind;
  shape: Shape;
  material: MaterialId;
  /** Blocks the ball. False for trigger volumes such as gravity zones. */
  solid: boolean;
  /** Extra restitution added on top of the material value. */
  bounceBonus: number;
  /** Damage dealt to the ball on contact. */
  contactDamage: number;
  hp: number;
  maxHp: number;
  destroyed: boolean;
  /** Set for one frame after taking damage, for the hit flash. */
  flash: number;
  motion: Motion | null;
  /** Home position; motion is expressed relative to this. */
  homeX: number;
  homeY: number;
  /** Previous-frame position, so movers can transfer velocity to the ball. */
  prevX: number;
  prevY: number;
  velX: number;
  velY: number;
  /** Behaviour parameters (launch strength, teleport target, gravity vector). */
  params: Record<string, number>;
  /** Enabled state for switches, doors, timed lasers, temporary platforms. */
  active: boolean;
  /** Countdown used by temporary platforms and re-arming hazards. */
  timer: number;
  /** Link id used to wire switches to doors. */
  link: number;
  tags: string[];
  /** Loot/score granted when destroyed. */
  reward: number;
}

/* ---------------------------------------------------------------- enemies -- */

export type EnemyState = 'idle' | 'active' | 'telegraph' | 'attacking' | 'stunned' | 'vulnerable' | 'dying';

/** Bit flags describing how an enemy interacts with collisions. */
export const EnemyFlag = {
  /** Touching it hurts the ball unless it is stunned or vulnerable. */
  Spiked: 1 << 0,
  /** Damage only lands from behind/above depending on `armorArc`. */
  Armored: 1 << 1,
  /** Immune until the ball has bounced off a surface first (ricochet gate). */
  RicochetGated: 1 << 2,
  /** Reverses the ball's velocity instead of reflecting it. */
  Reflector: 1 << 3,
  /** Detonates on death. */
  Explosive: 1 << 4,
  /** Spawns children on death. */
  Splitter: 1 << 5,
  /** Pulls the ball toward itself. */
  Magnetic: 1 << 6,
  /** Heavy: transfers momentum to the ball rather than absorbing it. */
  Heavy: 1 << 7,
  /** Dies to a single sufficiently fast impact. */
  Fragile: 1 << 8,
  /** Ignores gravity. */
  Flying: 1 << 9,
  /** Cannot be knocked back. */
  Anchored: 1 << 10,
  /** Counts as an elite for rewards and telemetry. */
  Elite: 1 << 11,
  /** Acts as a solid bounce surface even while alive (stepping stone). */
  Platform: 1 << 12,
  /** Can be used as a bounce target that refreshes air abilities. */
  Springy: 1 << 13,
  /** Boss or boss part: never despawns, has phases. */
  Boss: 1 << 14,
} as const;

export type EnemyFlags = number;

export interface StatusStacks {
  burn: number;
  burnTime: number;
  frost: number;
  frostTime: number;
  poison: number;
  poisonTime: number;
  shock: number;
  shockTime: number;
  mark: number;
  markTime: number;
  /** Set by Parasite-family effects: the enemy fights for the player. */
  charmTime: number;
}

export interface Enemy {
  id: number;
  defId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /**
   * Enemies are circles or convex polygons only. Segments are excluded so that
   * "which way is this thing facing" always has a meaningful answer, which the
   * armour and danger arcs depend on.
   */
  shape: CircleShape | PolyShape;
  hp: number;
  maxHp: number;
  flags: EnemyFlags;
  state: EnemyState;
  stateTime: number;
  /** Total lifetime, used by oscillating movement. */
  age: number;
  /** Direction the armour faces, in radians. */
  armorAngle: number;
  /** Half-width of the protected arc, in radians. */
  armorArc: number;
  /** Damage dealt to the ball on a dangerous contact. */
  contactDamage: number;
  /** Remaining stun; while > 0 the enemy is safe to touch and takes bonus damage. */
  stun: number;
  /** Set for one frame when damaged. */
  flash: number;
  /** Hit cooldown so a single pass cannot multi-hit in consecutive substeps. */
  hitCooldown: number;
  status: StatusStacks;
  /** Generation depth for splitters, to bound recursion. */
  generation: number;
  /** Per-behaviour scratch values. */
  scratch: Record<string, number>;
  /** Currency/discovery reward on death. */
  reward: number;
  dead: boolean;
  /** Set when the death was caused by the environment, for achievements. */
  killedByEnvironment: boolean;
  /** Boss phase index. */
  phase: number;
  /** Optional parent (boss core for boss parts, splitter parent). */
  parentId: number;
}

/* ------------------------------------------------------------ projectiles -- */

export type ProjectileKind = 'bullet' | 'orb' | 'shard' | 'wave' | 'lightning' | 'miniball';

export interface Projectile {
  id: number;
  kind: ProjectileKind;
  faction: Faction;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  life: number;
  maxLife: number;
  /** Bounces remaining before expiry; -1 for non-bouncing. */
  bounces: number;
  gravityScale: number;
  /** Homing strength in radians/second. */
  homing: number;
  pierce: number;
  color: string;
  active: boolean;
  /** Set for player mini-balls so they can trigger impact effects. */
  isBall: boolean;
  hitIds: number[];
  scratch: Record<string, number>;
}

/* --------------------------------------------------------------- pickups -- */

export type PickupKind = 'shard' | 'core' | 'heal' | 'chest' | 'relic' | 'key';

export interface Pickup {
  id: number;
  kind: PickupKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  value: number;
  life: number;
  /** Magnet influence accumulates so vacuum upgrades feel smooth. */
  attract: number;
  /**
   * Seconds before this pickup can be collected.
   *
   * Required by anything that re-spawns a pickup the ball is currently sitting on
   * - an unaffordable shop pedestal, for instance. Without it, collection and
   * re-spawn alternate every frame.
   */
  armTime: number;
  active: boolean;
  payload: string;
}

/* ------------------------------------------------------- field effects ---- */

export type FieldKind = 'fire' | 'frost' | 'void' | 'shock' | 'trail' | 'singularity' | 'heal';

/** Persistent area effects: burning ground, black holes, dangerous trails. */
export interface Field {
  id: number;
  kind: FieldKind;
  x: number;
  y: number;
  radius: number;
  life: number;
  maxLife: number;
  power: number;
  faction: Faction;
  active: boolean;
  /** Pull (negative) or push (positive) applied to the ball. */
  force: number;
  tickTimer: number;
}
