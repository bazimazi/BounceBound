/**
 * The run's build.
 *
 * Owns which upgrades are held, the resolved stat block, the active synergies and
 * the archetype fingerprint. Three responsibilities worth calling out:
 *
 *  - Installation is idempotent and reversible. Adding a stack re-installs
 *    nothing; removing an upgrade (curse cleansing, event effects) tears down
 *    exactly its own listeners via the event bus group mechanism.
 *  - Synergies are re-evaluated after every change, and a newly satisfied synergy
 *    announces itself. Discovering a combination should be an *event*, not
 *    something the player has to infer from a damage number.
 *  - The archetype fingerprint is derived, never chosen. The player never picks
 *    "Ricochet"; they take wall-related upgrades and the game notices.
 */

import type { Rng } from '../core/rng';
import type { EventBus } from '../core/events';
import type { GameEvents } from '../sim/gameEvents';
import type { World } from '../sim/world';
import { StatSheet, type ResolvedStats, type StatModifiers } from '../sim/stats';
import type { ArchetypeId, UpgradeFamily } from '../content/ids';
import { ARCHETYPE_NAMES } from '../content/ids';
import { SYNERGY_DEFS, type SynergyDef } from '../content/synergies';
import { getUpgrade, maxStacksOf, type BuildQuery, type UpgradeContext, type UpgradeDef } from './upgradeSystem';

interface HeldUpgrade {
  def: UpgradeDef;
  stacks: number;
  memory: Record<string, number>;
  /** Event bus group label used to tear down this upgrade's listeners. */
  group: string;
}

export interface BuildDeps {
  bus: EventBus<GameEvents>;
  rng: Rng;
  world: () => World;
  notify: (text: string, tone?: 'info' | 'good' | 'bad' | 'rare') => void;
  /** Called when a synergy becomes active for the first time this run. */
  onDiscovery?: (kind: 'synergy' | 'upgrade', id: string) => void;
}

export class BuildState {
  private readonly held = new Map<string, HeldUpgrade>();
  private readonly sheet = new StatSheet();
  private readonly activeSynergies = new Set<string>();
  private readonly deps: BuildDeps;
  /** Acquisition order, for the build panel and the run summary. */
  readonly order: string[] = [];
  /** Current room index, used by offer weighting. */
  depth = 0;
  /** Ball class base stat overrides. */
  private baseOverrides: StatModifiers = {};

  constructor(deps: BuildDeps) {
    this.deps = deps;
  }

  /* ------------------------------------------------------------- lifecycle -- */

  setBallClass(overrides: StatModifiers): void {
    this.baseOverrides = { ...overrides };
    this.sheet.setBaseOverrides(this.baseOverrides);
    this.deps.bus.emit('statsChanged', { keys: [] });
  }

  /** Adds one stack. Returns false when already at maximum. */
  add(id: string): boolean {
    const def = getUpgrade(id);
    if (!def) return false;
    const existing = this.held.get(id);
    if (existing) {
      if (existing.stacks >= maxStacksOf(def)) return false;
      existing.stacks++;
      // Stat modifiers stack; behaviour listeners do not re-register. Upgrades
      // that scale with stacks read `ctx.stacks()`.
      this.applyStats(def);
    } else {
      const group = `upgrade:${id}`;
      const holder: HeldUpgrade = { def, stacks: 1, memory: {}, group };
      this.held.set(id, holder);
      this.order.push(id);
      this.applyStats(def);
      if (def.install) def.install(this.contextFor(holder));
    }

    // Evolutions replace their prerequisite so a chain does not double-count.
    if (def.evolvesFrom && this.held.has(def.evolvesFrom)) {
      this.remove(def.evolvesFrom, { silent: true });
    }

    this.deps.bus.emit('upgradeGained', { id, name: def.name, tier: this.stacksOf(id) });
    this.deps.bus.emit('statsChanged', { keys: this.sheet.changedKeys() });
    this.refreshSynergies();
    return true;
  }

  remove(id: string, options: { silent?: boolean } = {}): void {
    const holder = this.held.get(id);
    if (!holder) return;
    this.deps.bus.clearGroup(holder.group);
    this.held.delete(id);
    const index = this.order.indexOf(id);
    if (index >= 0) this.order.splice(index, 1);
    this.rebuildStats();
    if (!options.silent) this.deps.bus.emit('upgradeRemoved', { id });
    this.refreshSynergies();
  }

  dispose(): void {
    for (const holder of this.held.values()) this.deps.bus.clearGroup(holder.group);
    for (const id of this.activeSynergies) this.deps.bus.clearGroup(`synergy:${id}`);
    this.held.clear();
    this.activeSynergies.clear();
    this.order.length = 0;
    this.sheet.reset();
    this.sheet.setBaseOverrides(this.baseOverrides);
  }

  /* ----------------------------------------------------------------- stats -- */

  private applyStats(def: UpgradeDef): void {
    this.sheet.add({ id: def.id, name: def.name, flat: def.flat, mult: def.mult });
  }

  /** Full rebuild, used after a removal since modifiers are not subtractable. */
  private rebuildStats(): void {
    this.sheet.reset();
    this.sheet.setBaseOverrides(this.baseOverrides);
    for (const holder of this.held.values()) {
      for (let i = 0; i < holder.stacks; i++) this.applyStats(holder.def);
    }
    for (const id of this.activeSynergies) {
      const synergy = SYNERGY_DEFS.find((s) => s.id === id);
      if (synergy?.flat || synergy?.mult) {
        this.sheet.add({ id: `synergy:${id}`, name: synergy.name, flat: synergy.flat, mult: synergy.mult });
      }
    }
    this.deps.bus.emit('statsChanged', { keys: this.sheet.changedKeys() });
  }

  stats(): ResolvedStats {
    return this.sheet.get();
  }

  statSheet(): StatSheet {
    return this.sheet;
  }

  /* --------------------------------------------------------------- queries -- */

  has(id: string): boolean {
    return this.held.has(id);
  }

  stacksOf(id: string): number {
    return this.held.get(id)?.stacks ?? 0;
  }

  countTag(tag: string): number {
    let n = 0;
    for (const holder of this.held.values()) {
      if (holder.def.tags.includes(tag)) n += holder.stacks;
    }
    return n;
  }

  countFamily(family: UpgradeFamily): number {
    let n = 0;
    for (const holder of this.held.values()) {
      if (holder.def.family === family) n += holder.stacks;
    }
    return n;
  }

  get size(): number {
    let n = 0;
    for (const holder of this.held.values()) n += holder.stacks;
    return n;
  }

  list(): Array<{ def: UpgradeDef; stacks: number }> {
    return this.order.map((id) => {
      const holder = this.held.get(id)!;
      return { def: holder.def, stacks: holder.stacks };
    });
  }

  query(): BuildQuery {
    return {
      has: (id) => this.has(id),
      stacksOf: (id) => this.stacksOf(id),
      countTag: (tag) => this.countTag(tag),
      countFamily: (family) => this.countFamily(family),
      stats: this.stats(),
      depth: this.depth,
      archetypeScore: (id) => this.archetypeScores()[id] ?? 0,
    };
  }

  /* ------------------------------------------------------------ archetypes -- */

  /**
   * Derives the build's identity from the upgrades held. Scores are raw counts
   * weighted by stacks; the HUD shows the top one or two, which is how a player
   * learns the vocabulary ("oh, I am playing Ricochet this run").
   */
  archetypeScores(): Record<ArchetypeId, number> {
    const scores = {} as Record<ArchetypeId, number>;
    for (const key of Object.keys(ARCHETYPE_NAMES) as ArchetypeId[]) scores[key] = 0;
    for (const holder of this.held.values()) {
      for (const archetype of holder.def.archetypes ?? []) {
        scores[archetype] += holder.stacks;
      }
    }
    return scores;
  }

  /** Top archetypes with at least two contributing upgrades. */
  identity(): Array<{ id: ArchetypeId; name: string; score: number }> {
    const scores = this.archetypeScores();
    return (Object.keys(scores) as ArchetypeId[])
      .filter((id) => scores[id] >= 2)
      .sort((a, b) => scores[b] - scores[a])
      .slice(0, 2)
      .map((id) => ({ id, name: ARCHETYPE_NAMES[id], score: scores[id] }));
  }

  /* -------------------------------------------------------------- synergies -- */

  private refreshSynergies(): void {
    const query = this.query();
    let changed = false;
    for (const synergy of SYNERGY_DEFS) {
      const satisfied = synergyActive(synergy, query);
      const already = this.activeSynergies.has(synergy.id);
      if (satisfied && !already) {
        this.activeSynergies.add(synergy.id);
        if (synergy.install) {
          synergy.install(this.contextForSynergy(synergy));
        }
        changed = true;
        this.deps.bus.emit('synergyActivated', { id: synergy.id, name: synergy.name });
        this.deps.onDiscovery?.('synergy', synergy.id);
        this.deps.notify(`${synergy.name}`, 'rare');
      } else if (!satisfied && already) {
        this.activeSynergies.delete(synergy.id);
        this.deps.bus.clearGroup(`synergy:${synergy.id}`);
        changed = true;
      }
    }
    if (changed) this.rebuildStats();
  }

  synergies(): SynergyDef[] {
    return SYNERGY_DEFS.filter((s) => this.activeSynergies.has(s.id));
  }

  hasSynergy(id: string): boolean {
    return this.activeSynergies.has(id);
  }

  /** Synergies that are one upgrade away, shown as a subtle hint on cards. */
  nearMisses(): SynergyDef[] {
    const query = this.query();
    return SYNERGY_DEFS.filter((s) => {
      if (this.activeSynergies.has(s.id)) return false;
      const missing = s.requiresAll.filter((id) => !query.has(id)).length;
      const tagsMissing = (s.requiresTags ?? []).filter(([tag, count]) => query.countTag(tag) < count).length;
      return missing + tagsMissing === 1;
    });
  }

  /* ---------------------------------------------------------------- context -- */

  private contextFor(holder: HeldUpgrade): UpgradeContext {
    return {
      world: this.deps.world,
      bus: this.deps.bus,
      stats: () => this.stats(),
      rng: this.deps.rng,
      stacks: () => holder.stacks,
      memory: holder.memory,
      notify: this.deps.notify,
      on: (type, fn, options) => {
        this.deps.bus.on(type, fn, { ...options, group: holder.group });
      },
    };
  }

  private contextForSynergy(synergy: SynergyDef): UpgradeContext {
    const memory: Record<string, number> = {};
    const group = `synergy:${synergy.id}`;
    return {
      world: this.deps.world,
      bus: this.deps.bus,
      stats: () => this.stats(),
      rng: this.deps.rng,
      stacks: () => 1,
      memory,
      notify: this.deps.notify,
      on: (type, fn, options) => {
        this.deps.bus.on(type, fn, { ...options, group });
      },
    };
  }

  /** Serialisable snapshot for the run summary and save-in-progress. */
  snapshot(): { upgrades: Array<{ id: string; stacks: number }>; synergies: string[] } {
    return {
      upgrades: this.order.map((id) => ({ id, stacks: this.stacksOf(id) })),
      synergies: [...this.activeSynergies],
    };
  }
}

export function synergyActive(synergy: SynergyDef, query: BuildQuery): boolean {
  for (const id of synergy.requiresAll) {
    if (!query.has(id)) return false;
  }
  if (synergy.requiresAny && synergy.requiresAny.length > 0) {
    if (!synergy.requiresAny.some((id) => query.has(id))) return false;
  }
  for (const [tag, count] of synergy.requiresTags ?? []) {
    if (query.countTag(tag) < count) return false;
  }
  return true;
}
