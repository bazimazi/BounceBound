/**
 * Stat resolution.
 *
 * Upgrades never write to the ball directly. They contribute flat and
 * multiplicative modifiers to named stats, and the resolved block is rebuilt
 * whenever the build changes. This has three benefits:
 *
 *  - Trade-off upgrades are expressible as a single data entry (bigger radius,
 *    worse steering) instead of bespoke code.
 *  - The build screen can show exactly which upgrades produced a number.
 *  - Balance tooling can diff resolved stat blocks across simulated runs.
 *
 * Resolution is `(base + flat) * mult`, clamped to each stat's documented range
 * so that stacked modifiers cannot produce degenerate values such as negative
 * gravity or an unbounded speed cap.
 */

export type StatKey =
  // Survivability
  | 'maxHealth'
  | 'shieldCharges'
  | 'iframeDuration'
  | 'reviveCharges'
  // Body
  | 'radius'
  | 'mass'
  | 'gravity'
  | 'maxSpeed'
  // Control
  | 'airAccel'
  | 'airAccelVertical'
  | 'airBrakePower'
  | 'diveGravity'
  | 'airDashCharges'
  | 'airDashPower'
  | 'airBounceCharges'
  | 'steerAuthorityAtSpeed'
  // Bouncing
  | 'restitution'
  | 'minBounceSpeed'
  | 'perfectWindow'
  | 'perfectPower'
  | 'wallBouncePower'
  | 'enemyBouncePower'
  | 'momentumRetention'
  // Offence
  | 'damage'
  | 'speedDamageScale'
  | 'critChance'
  | 'critMult'
  | 'explosionRadius'
  | 'explosionDamage'
  | 'lightningDamage'
  | 'lightningJumps'
  | 'burnDamage'
  | 'frostPower'
  | 'poisonDamage'
  | 'shockwavePower'
  | 'knockback'
  // Combo
  | 'comboGain'
  | 'comboDecayRate'
  | 'comboDamageScale'
  | 'comboCap'
  // Economy and meta
  | 'magnetRadius'
  | 'shardGain'
  | 'healOnKill'
  | 'luck'
  | 'rerolls'
  | 'upgradeChoices'
  | 'shopDiscount'
  // Exotic
  | 'timeSlowPower'
  | 'phaseDuration'
  | 'extraBalls';

interface StatSpec {
  base: number;
  min: number;
  max: number;
  /** Shown in the build panel when non-empty. */
  label: string;
  /** How the value should be formatted for the player. */
  format: 'number' | 'percent' | 'seconds' | 'integer';
  /** True when a higher value is worse, so trade-offs colour correctly. */
  inverted?: boolean;
}

/**
 * Baseline values for the standard ball. Units are world-units and seconds; the
 * arena is 1120x630 world units, which makes gravity of 2150 read as roughly a
 * one-second arc across a third of the room.
 */
export const STAT_SPECS: Record<StatKey, StatSpec> = {
  maxHealth: { base: 100, min: 1, max: 100000, label: 'Integrity', format: 'integer' },
  shieldCharges: { base: 0, min: 0, max: 12, label: 'Shield charges', format: 'integer' },
  iframeDuration: { base: 0.55, min: 0.1, max: 4, label: 'Recovery window', format: 'seconds' },
  reviveCharges: { base: 0, min: 0, max: 5, label: 'Reforge charges', format: 'integer' },

  radius: { base: 12, min: 5, max: 42, label: 'Radius', format: 'number' },
  mass: { base: 1, min: 0.2, max: 8, label: 'Mass', format: 'number' },
  gravity: { base: 2150, min: 200, max: 9000, label: 'Gravity', format: 'number' },
  maxSpeed: { base: 1450, min: 300, max: 5000, label: 'Speed cap', format: 'number' },

  airAccel: { base: 2750, min: 0, max: 12000, label: 'Air steering', format: 'number' },
  airAccelVertical: { base: 1150, min: 0, max: 8000, label: 'Vertical steering', format: 'number' },
  airBrakePower: { base: 5.5, min: 0, max: 30, label: 'Air brake', format: 'number' },
  diveGravity: { base: 2.5, min: 1, max: 8, label: 'Dive weight', format: 'number' },
  airDashCharges: { base: 0, min: 0, max: 8, label: 'Air dashes', format: 'integer' },
  airDashPower: { base: 720, min: 0, max: 3000, label: 'Dash power', format: 'number' },
  airBounceCharges: { base: 0, min: 0, max: 6, label: 'Air bounces', format: 'integer' },
  steerAuthorityAtSpeed: { base: 0.55, min: 0.05, max: 1, label: 'High-speed control', format: 'percent' },

  restitution: { base: 1, min: 0.35, max: 2.2, label: 'Bounciness', format: 'percent' },
  /**
   * The floor always returns at least this much speed along its normal.
   *
   * This number is load-bearing for the entire game, and it has a narrow good
   * range. At 2150 gravity a rebound of 780 lifts the ball about 140 units, a bit
   * over a fifth of the 648-unit arena: enough that the ball is always back in
   * useful airspace with time to steer, and calm enough that it is not permanently
   * launched.
   *
   * Both directions are wrong in ways playtesting caught. At 300 the hop was 21
   * units, so a ball that had bled off energy was stuck on the floor and could not
   * reach anything - rooms became unclearable. At 950 the floor was a trampoline
   * that kept total speed above 900 u/s a quarter of the time, which read as the
   * ball being too bouncy to enjoy.
   *
   * Diving scales this down (see `DIVE_BOUNCE_SCALE`), which is how the player
   * chooses to stay low.
   */
  minBounceSpeed: { base: 780, min: 60, max: 2200, label: 'Minimum rebound', format: 'number' },
  perfectWindow: { base: 0.13, min: 0.03, max: 0.6, label: 'Perfect window', format: 'seconds' },
  perfectPower: { base: 1.3, min: 1, max: 3.2, label: 'Perfect power', format: 'number' },
  wallBouncePower: { base: 1, min: 0.4, max: 3.5, label: 'Wall rebound', format: 'percent' },
  enemyBouncePower: { base: 1, min: 0.4, max: 3.5, label: 'Enemy rebound', format: 'percent' },
  momentumRetention: { base: 1, min: 0.5, max: 1.4, label: 'Momentum retention', format: 'percent' },

  damage: { base: 10, min: 0, max: 100000, label: 'Impact damage', format: 'number' },
  speedDamageScale: { base: 1, min: 0, max: 5, label: 'Velocity scaling', format: 'percent' },
  critChance: { base: 0.05, min: 0, max: 1, label: 'Critical chance', format: 'percent' },
  critMult: { base: 2, min: 1, max: 12, label: 'Critical power', format: 'number' },
  explosionRadius: { base: 0, min: 0, max: 600, label: 'Blast radius', format: 'number' },
  explosionDamage: { base: 0, min: 0, max: 10000, label: 'Blast damage', format: 'number' },
  lightningDamage: { base: 0, min: 0, max: 10000, label: 'Arc damage', format: 'number' },
  lightningJumps: { base: 0, min: 0, max: 24, label: 'Arc jumps', format: 'integer' },
  burnDamage: { base: 0, min: 0, max: 5000, label: 'Burn per second', format: 'number' },
  frostPower: { base: 0, min: 0, max: 20, label: 'Frost power', format: 'number' },
  poisonDamage: { base: 0, min: 0, max: 5000, label: 'Toxin per second', format: 'number' },
  shockwavePower: { base: 0, min: 0, max: 5000, label: 'Shockwave', format: 'number' },
  knockback: { base: 1, min: 0, max: 8, label: 'Knockback', format: 'percent' },

  comboGain: { base: 1, min: 0, max: 8, label: 'Combo gain', format: 'number' },
  comboDecayRate: { base: 1, min: 0.1, max: 4, label: 'Combo decay', format: 'percent', inverted: true },
  comboDamageScale: { base: 1, min: 0, max: 6, label: 'Combo scaling', format: 'percent' },
  comboCap: { base: 40, min: 5, max: 999, label: 'Combo ceiling', format: 'integer' },

  magnetRadius: { base: 70, min: 0, max: 1400, label: 'Collection range', format: 'number' },
  shardGain: { base: 1, min: 0, max: 8, label: 'Shard yield', format: 'percent' },
  healOnKill: { base: 0, min: 0, max: 200, label: 'Leech per kill', format: 'number' },
  luck: { base: 0, min: -1, max: 4, label: 'Fortune', format: 'number' },
  rerolls: { base: 1, min: 0, max: 20, label: 'Rerolls', format: 'integer' },
  upgradeChoices: { base: 3, min: 1, max: 6, label: 'Upgrade options', format: 'integer' },
  shopDiscount: { base: 0, min: -1, max: 0.85, label: 'Shop discount', format: 'percent' },

  timeSlowPower: { base: 0, min: 0, max: 0.92, label: 'Time dilation', format: 'percent' },
  phaseDuration: { base: 0, min: 0, max: 4, label: 'Phase duration', format: 'seconds' },
  extraBalls: { base: 0, min: 0, max: 12, label: 'Companion balls', format: 'integer' },
};

export const STAT_KEYS = Object.keys(STAT_SPECS) as StatKey[];

export type StatModifiers = Partial<Record<StatKey, number>>;

export interface StatSource {
  id: string;
  name: string;
  flat?: StatModifiers;
  mult?: StatModifiers;
}

export type ResolvedStats = Record<StatKey, number>;

export interface StatContribution {
  sourceId: string;
  sourceName: string;
  flat: number;
  mult: number;
}

/** Accumulates modifiers and resolves them, retaining per-stat attribution. */
export class StatSheet {
  private readonly flat = new Map<StatKey, number>();
  private readonly mult = new Map<StatKey, number>();
  private readonly attribution = new Map<StatKey, StatContribution[]>();
  private resolved: ResolvedStats;
  private dirty = true;
  /** Base overrides supplied by the chosen ball class. */
  private baseOverrides: StatModifiers = {};

  constructor() {
    this.resolved = createBaseStats();
  }

  setBaseOverrides(overrides: StatModifiers): void {
    this.baseOverrides = { ...overrides };
    this.dirty = true;
  }

  add(source: StatSource): void {
    if (source.flat) {
      for (const key of Object.keys(source.flat) as StatKey[]) {
        const value = source.flat[key];
        if (value === undefined || value === 0) continue;
        this.flat.set(key, (this.flat.get(key) ?? 0) + value);
        this.record(key, source, value, 1);
      }
    }
    if (source.mult) {
      for (const key of Object.keys(source.mult) as StatKey[]) {
        const value = source.mult[key];
        if (value === undefined) continue;
        this.mult.set(key, (this.mult.get(key) ?? 1) * value);
        this.record(key, source, 0, value);
      }
    }
    this.dirty = true;
  }

  private record(key: StatKey, source: StatSource, flat: number, mult: number): void {
    let list = this.attribution.get(key);
    if (!list) {
      list = [];
      this.attribution.set(key, list);
    }
    const existing = list.find((c) => c.sourceId === source.id);
    if (existing) {
      existing.flat += flat;
      existing.mult *= mult;
    } else {
      list.push({ sourceId: source.id, sourceName: source.name, flat, mult });
    }
  }

  get(): ResolvedStats {
    if (this.dirty) this.resolve();
    return this.resolved;
  }

  contributionsFor(key: StatKey): StatContribution[] {
    return this.attribution.get(key) ?? [];
  }

  /** Stats that differ from the class baseline, for the build panel. */
  changedKeys(): StatKey[] {
    const stats = this.get();
    return STAT_KEYS.filter((key) => {
      const base = this.baseOverrides[key] ?? STAT_SPECS[key].base;
      return Math.abs(stats[key] - base) > 1e-6;
    });
  }

  baseValue(key: StatKey): number {
    return this.baseOverrides[key] ?? STAT_SPECS[key].base;
  }

  private resolve(): void {
    const out = this.resolved;
    for (const key of STAT_KEYS) {
      const spec = STAT_SPECS[key];
      const base = this.baseOverrides[key] ?? spec.base;
      const flat = this.flat.get(key) ?? 0;
      const mult = this.mult.get(key) ?? 1;
      let value = (base + flat) * mult;
      if (!Number.isFinite(value)) value = base;
      out[key] = Math.min(spec.max, Math.max(spec.min, value));
    }
    this.dirty = false;
  }

  reset(): void {
    this.flat.clear();
    this.mult.clear();
    this.attribution.clear();
    this.baseOverrides = {};
    this.dirty = true;
  }
}

export function createBaseStats(): ResolvedStats {
  const out = {} as ResolvedStats;
  for (const key of STAT_KEYS) out[key] = STAT_SPECS[key].base;
  return out;
}

export function formatStat(key: StatKey, value: number): string {
  const spec = STAT_SPECS[key];
  switch (spec.format) {
    case 'percent':
      return `${Math.round(value * 100)}%`;
    case 'seconds':
      return `${value.toFixed(2)}s`;
    case 'integer':
      return `${Math.round(value)}`;
    default:
      return Math.abs(value) >= 100 ? `${Math.round(value)}` : value.toFixed(1);
  }
}
