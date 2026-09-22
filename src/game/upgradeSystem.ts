/**
 * The upgrade system.
 *
 * An upgrade is a data record with two optional halves: stat modifiers, and an
 * `install` function that registers event listeners. Nothing else in the codebase
 * knows an upgrade exists. That is the whole point of the impact pipeline - a new
 * mechanic is a new listener, never a change to the collision solver.
 *
 * Offer generation is where balance actually lives:
 *
 *  - Weights respond to the build. An upgrade that combines with what the player
 *    already has is more likely to appear, so builds *converge* instead of
 *    drifting into a pile of unrelated effects. This is the mechanism behind
 *    "if I get X, I should start looking for Y".
 *  - Evolutions only appear once their prerequisite is held, so the tier chains
 *    read as growth rather than as duplicate cards.
 *  - Nothing already at max stacks is ever offered, so there are no dead picks.
 *  - Cursed upgrades appear at a controlled rate and always state their cost.
 */

import type { Rng } from '../core/rng';
import type { EventBus, SubscribeOptions } from '../core/events';
import type { GameEvents } from '../sim/gameEvents';
import type { World } from '../sim/world';
import type { ResolvedStats, StatModifiers } from '../sim/stats';
import type { ArchetypeId, UpgradeFamily, UpgradeRarity } from '../content/ids';
import { RARITY_WEIGHTS } from '../content/ids';

/** What an upgrade's `install` function is given. */
export interface UpgradeContext {
  /** Current world. Never capture the return value across rooms. */
  world: () => World;
  bus: EventBus<GameEvents>;
  stats: () => ResolvedStats;
  rng: Rng;
  /** Number of copies of this upgrade currently held (>= 1). */
  stacks: () => number;
  /** Subscribe with automatic cleanup when the upgrade or run ends. */
  on: <K extends keyof GameEvents>(
    type: K,
    fn: (payload: GameEvents[K]) => void,
    options?: SubscribeOptions,
  ) => void;
  /** Per-upgrade mutable scratch space, persisted for the run. */
  memory: Record<string, number>;
  notify: (text: string, tone?: 'info' | 'good' | 'bad' | 'rare') => void;
}

/** Read-only view of the build, used by offer requirements and weighting. */
export interface BuildQuery {
  has: (id: string) => boolean;
  stacksOf: (id: string) => number;
  countTag: (tag: string) => number;
  countFamily: (family: UpgradeFamily) => number;
  stats: ResolvedStats;
  depth: number;
  archetypeScore: (id: ArchetypeId) => number;
}

export interface UpgradeDef {
  id: string;
  name: string;
  family: UpgradeFamily;
  rarity: UpgradeRarity;
  /** What it does, in the player's terms. One or two short sentences. */
  text: string;
  /** The trade-off, if any. Rendered in a warning colour. */
  cost?: string;
  /** A nudge toward what it combines with. Never mechanical detail. */
  hint?: string;
  flat?: StatModifiers;
  mult?: StatModifiers;
  maxStacks?: number;
  /** Synergy and archetype detection tags. */
  tags: string[];
  archetypes?: ArchetypeId[];
  install?: (ctx: UpgradeContext) => void;
  /** Only offered when this passes. */
  requires?: (build: BuildQuery) => boolean;
  /** Prerequisite upgrade for a tier chain. */
  evolvesFrom?: string;
  /** Base weight before contextual adjustment. */
  weight?: number;
  /** Meta unlock gate. */
  unlock?: string;
  /** Excluded from shops (transformations are room rewards only). */
  noShop?: boolean;
}

export const UPGRADE_REGISTRY = new Map<string, UpgradeDef>();

export function registerUpgrades(defs: UpgradeDef[]): void {
  for (const def of defs) {
    if (UPGRADE_REGISTRY.has(def.id)) throw new Error(`Duplicate upgrade id: ${def.id}`);
    UPGRADE_REGISTRY.set(def.id, def);
  }
}

export function getUpgrade(id: string): UpgradeDef | undefined {
  return UPGRADE_REGISTRY.get(id);
}

export function allUpgrades(): UpgradeDef[] {
  return [...UPGRADE_REGISTRY.values()];
}

export function maxStacksOf(def: UpgradeDef): number {
  return def.maxStacks ?? 1;
}

/* ------------------------------------------------------------------ offers -- */

export interface OfferOptions {
  rng: Rng;
  build: BuildQuery;
  count: number;
  /** Bias toward this rarity floor; elite and boss rewards raise it. */
  rarityBonus?: number;
  /** Fortune stat, improving rare appearance rates. */
  luck?: number;
  /** Restrict to these families (used by themed events). */
  families?: UpgradeFamily[];
  /** Exclude cursed offers (respite and shop rooms). */
  allowCursed?: boolean;
  /** Only upgrades purchasable in a shop. */
  shopOnly?: boolean;
  unlocked: (id: string) => boolean;
  /** Ids already offered in this batch. */
  exclude?: Set<string>;
}

/**
 * Contextual weighting.
 *
 * The three multipliers below are the entire "build identity" mechanism:
 * synergy pull makes related upgrades more likely, family saturation stops a
 * build becoming nine copies of one idea, and evolution pull makes tier chains
 * feel like they are being offered to you on purpose.
 */
function weightFor(def: UpgradeDef, build: BuildQuery, options: OfferOptions): number {
  let weight = (def.weight ?? 1) * RARITY_WEIGHTS[def.rarity];

  const luck = options.luck ?? 0;
  if (def.rarity === 'rare') weight *= 1 + luck * 0.35;
  if (def.rarity === 'legendary') weight *= 1 + luck * 0.6;
  if (options.rarityBonus) {
    if (def.rarity === 'rare') weight *= 1 + options.rarityBonus;
    if (def.rarity === 'legendary') weight *= 1 + options.rarityBonus * 2;
    if (def.rarity === 'common') weight *= Math.max(0.2, 1 - options.rarityBonus * 0.7);
  }

  // Synergy pull: shared tags with the existing build.
  let sharedTags = 0;
  for (const tag of def.tags) sharedTags += build.countTag(tag);
  weight *= 1 + Math.min(2.2, sharedTags * 0.24);

  // Archetype pull: reinforce whichever identity is already forming.
  if (def.archetypes) {
    let archetypePull = 0;
    for (const archetype of def.archetypes) archetypePull += build.archetypeScore(archetype);
    weight *= 1 + Math.min(1.6, archetypePull * 0.2);
  }

  // Family saturation: keep some breadth so builds stay playable.
  const familyCount = build.countFamily(def.family);
  weight *= 1 / (1 + familyCount * 0.13);

  // Evolutions are strongly favoured once available - that is the payoff for
  // having committed to the base upgrade.
  if (def.evolvesFrom) weight *= 3.4;

  // Later in a run, commons matter less and transformations matter more.
  if (def.rarity === 'common') weight *= Math.max(0.35, 1 - build.depth * 0.035);
  if (def.family === 'transformation') weight *= 0.6 + build.depth * 0.07;

  return Math.max(0.0001, weight);
}

function isOfferable(def: UpgradeDef, build: BuildQuery, options: OfferOptions): boolean {
  if (options.exclude?.has(def.id)) return false;
  if (def.unlock && !options.unlocked(def.unlock)) return false;
  if (options.shopOnly && def.noShop) return false;
  if (def.rarity === 'cursed' && options.allowCursed === false) return false;
  if (options.families && !options.families.includes(def.family)) return false;
  if (build.stacksOf(def.id) >= maxStacksOf(def)) return false;
  if (def.evolvesFrom && !build.has(def.evolvesFrom)) return false;
  if (def.requires && !def.requires(build)) return false;
  return true;
}

/** Produces a distinct set of offers, ordered so rarer cards read last. */
export function rollOffers(options: OfferOptions): UpgradeDef[] {
  const exclude = new Set(options.exclude ?? []);
  const chosen: UpgradeDef[] = [];
  const pool = allUpgrades();

  for (let i = 0; i < options.count; i++) {
    const candidates = pool.filter((def) => isOfferable(def, options.build, { ...options, exclude }));
    if (candidates.length === 0) break;
    const picked = options.rng.weighted(candidates, (def) => weightFor(def, options.build, options));
    if (!picked) break;
    chosen.push(picked);
    exclude.add(picked.id);
  }

  // Cursed offers never fill an entire hand: a choice between three curses is
  // not a choice.
  const cursed = chosen.filter((d) => d.rarity === 'cursed');
  if (cursed.length > 1) {
    for (let i = 1; i < cursed.length; i++) {
      const index = chosen.indexOf(cursed[i]);
      const replacement = pool.find(
        (def) => def.rarity !== 'cursed' && isOfferable(def, options.build, { ...options, exclude }),
      );
      if (replacement) {
        chosen[index] = replacement;
        exclude.add(replacement.id);
      }
    }
  }

  return chosen;
}

/** Shop price for an upgrade, before discounts. */
export function priceOf(def: UpgradeDef, depth: number): number {
  const base: Record<UpgradeRarity, number> = {
    common: 12,
    uncommon: 20,
    rare: 32,
    legendary: 52,
    cursed: 6,
  };
  return Math.round(base[def.rarity] * (1 + depth * 0.05));
}
