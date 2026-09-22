/**
 * The persistent profile.
 *
 * Holds everything that survives a run: currencies, unlock ranks, achievements,
 * discovered content, statistics, settings and run history. It is the single
 * source of truth for "what does this player have access to", and every content
 * gate in the game asks it the same question via `isUnlocked`.
 *
 * Reliability requirements, in order of importance:
 *  1. Never lose progress. Writes are journalled (see `PersistentStore`) and
 *     coalesced, with a forced flush on run end and page hide.
 *  2. Never double-grant. Achievement and unlock grants are idempotent sets.
 *  3. Never end up in an impossible state. Loading validates and repairs rather
 *     than trusting the file, because a stored profile is untrusted input.
 */

import { PersistentStore, SaveScheduler, type KeyValueStorage, type LoadOutcome } from '../core/storage';
import { clamp } from '../core/math';
import type { CurrencyId } from '../content/ids';
import { ACHIEVEMENT_BY_ID, ACHIEVEMENT_DEFS, PER_RUN_COUNTERS, type AchievementDef } from '../content/achievements';
import { UNLOCK_BY_ID, UNLOCK_NODES, maxRanks, nodeCost, type UnlockNode } from '../content/unlocks';
import type { StatModifiers } from '../sim/stats';
import { defaultSettings, mergeSettings, type Settings } from './settings';

export const PROFILE_VERSION = 3;

export interface RunRecord {
  at: number;
  seed: string;
  ballId: string;
  boundLevel: number;
  victory: boolean;
  cause: string;
  roomsCleared: number;
  deepestBiome: string;
  enemiesKilled: number;
  bestCombo: number;
  shardsEarned: number;
  echoesEarned: number;
  durationSeconds: number;
  upgrades: string[];
  synergies: string[];
  identity: string;
  /** Damage attributed by source, for the death screen breakdown. */
  damageBySource: Record<string, number>;
}

export interface DiscoveryLog {
  upgrades: string[];
  enemies: string[];
  bosses: string[];
  biomes: string[];
  events: string[];
  synergies: string[];
  balls: string[];
  secrets: string[];
}

export interface ProfileData {
  version: number;
  currencies: Record<CurrencyId, number>;
  /** Unlock tree node id -> ranks purchased. */
  unlockRanks: Record<string, number>;
  /** Content gate ids granted by the tree or by achievements. */
  granted: string[];
  /** Achievement id -> completion timestamp. */
  achievements: Record<string, number>;
  counters: Record<string, number>;
  discovered: DiscoveryLog;
  settings: Settings;
  selectedBall: string;
  boundLevel: number;
  lastSeed: string;
  history: RunRecord[];
  totalPlaySeconds: number;
  createdAt: number;
}

function emptyDiscovery(): DiscoveryLog {
  return { upgrades: [], enemies: [], bosses: [], biomes: [], events: [], synergies: [], balls: [], secrets: [] };
}

export function createProfileData(): ProfileData {
  return {
    version: PROFILE_VERSION,
    currencies: { shards: 0, cores: 0, echoes: 0, relics: 0 },
    unlockRanks: {},
    granted: [],
    achievements: {},
    counters: {},
    discovered: emptyDiscovery(),
    settings: defaultSettings(),
    selectedBall: 'standard',
    boundLevel: 0,
    lastSeed: '',
    history: [],
    totalPlaySeconds: 0,
    createdAt: Date.now(),
  };
}

/**
 * Repairs an untrusted profile. Anything missing is defaulted, anything
 * nonsensical is clamped, and unknown ids are dropped. A save from a future
 * version that we cannot understand is rejected upstream by the checksum and
 * version check; this handles the ordinary case of an older or edited file.
 */
function sanitise(input: unknown): ProfileData | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<ProfileData>;
  const out = createProfileData();
  out.createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Date.now();

  if (raw.currencies && typeof raw.currencies === 'object') {
    for (const key of Object.keys(out.currencies) as CurrencyId[]) {
      const value = (raw.currencies as Record<string, unknown>)[key];
      out.currencies[key] = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    }
  }

  if (raw.unlockRanks && typeof raw.unlockRanks === 'object') {
    for (const [id, ranks] of Object.entries(raw.unlockRanks)) {
      const node = UNLOCK_BY_ID[id];
      if (!node || typeof ranks !== 'number') continue;
      out.unlockRanks[id] = clamp(Math.floor(ranks), 0, maxRanks(node));
    }
  }

  if (Array.isArray(raw.granted)) {
    out.granted = [...new Set(raw.granted.filter((id): id is string => typeof id === 'string'))];
  }

  if (raw.achievements && typeof raw.achievements === 'object') {
    for (const [id, at] of Object.entries(raw.achievements)) {
      if (!ACHIEVEMENT_BY_ID[id]) continue;
      out.achievements[id] = typeof at === 'number' ? at : Date.now();
    }
  }

  if (raw.counters && typeof raw.counters === 'object') {
    for (const [key, value] of Object.entries(raw.counters)) {
      if (typeof value === 'number' && Number.isFinite(value)) out.counters[key] = value;
    }
  }

  if (raw.discovered && typeof raw.discovered === 'object') {
    for (const key of Object.keys(out.discovered) as Array<keyof DiscoveryLog>) {
      const list = (raw.discovered as unknown as Record<string, unknown>)[key];
      if (Array.isArray(list)) {
        out.discovered[key] = [...new Set(list.filter((v): v is string => typeof v === 'string'))];
      }
    }
  }

  out.settings = mergeSettings(raw.settings);
  out.selectedBall = typeof raw.selectedBall === 'string' ? raw.selectedBall : 'standard';
  out.boundLevel = typeof raw.boundLevel === 'number' ? clamp(Math.floor(raw.boundLevel), 0, 20) : 0;
  out.lastSeed = typeof raw.lastSeed === 'string' ? raw.lastSeed : '';
  out.totalPlaySeconds = typeof raw.totalPlaySeconds === 'number' ? Math.max(0, raw.totalPlaySeconds) : 0;

  if (Array.isArray(raw.history)) {
    out.history = raw.history
      .filter((r): r is RunRecord => !!r && typeof r === 'object')
      .slice(-40)
      .map((r) => ({
        at: typeof r.at === 'number' ? r.at : Date.now(),
        seed: typeof r.seed === 'string' ? r.seed : '',
        ballId: typeof r.ballId === 'string' ? r.ballId : 'standard',
        boundLevel: typeof r.boundLevel === 'number' ? r.boundLevel : 0,
        victory: !!r.victory,
        cause: typeof r.cause === 'string' ? r.cause : 'unknown',
        roomsCleared: Number(r.roomsCleared) || 0,
        deepestBiome: typeof r.deepestBiome === 'string' ? r.deepestBiome : 'verdant',
        enemiesKilled: Number(r.enemiesKilled) || 0,
        bestCombo: Number(r.bestCombo) || 0,
        shardsEarned: Number(r.shardsEarned) || 0,
        echoesEarned: Number(r.echoesEarned) || 0,
        durationSeconds: Number(r.durationSeconds) || 0,
        upgrades: Array.isArray(r.upgrades) ? r.upgrades.filter((u): u is string => typeof u === 'string') : [],
        synergies: Array.isArray(r.synergies) ? r.synergies.filter((u): u is string => typeof u === 'string') : [],
        identity: typeof r.identity === 'string' ? r.identity : '',
        damageBySource: r.damageBySource && typeof r.damageBySource === 'object' ? r.damageBySource : {},
      }));
  }

  return out;
}

export interface AchievementUnlockResult {
  def: AchievementDef;
  echoes: number;
  granted: string[];
}

export class Profile {
  data: ProfileData;
  private readonly store: PersistentStore<ProfileData>;
  private readonly scheduler: SaveScheduler;
  /** Fast membership set rebuilt from `granted`. */
  private grantedSet = new Set<string>();
  loadOutcome: LoadOutcome = 'empty';

  constructor(storage?: KeyValueStorage) {
    this.store = new PersistentStore<ProfileData>({
      key: 'bouncebound.profile',
      version: PROFILE_VERSION,
      storage,
      // Older versions are readable because every field is optional and repaired.
      migrate: (data) => sanitise(data),
    });
    const loaded = this.store.load();
    this.loadOutcome = loaded.outcome;
    this.data = (loaded.data && sanitise(loaded.data)) || createProfileData();
    this.rebuildGranted();
    this.scheduler = new SaveScheduler(() => this.store.save(this.data), 1200);
  }

  /* ---------------------------------------------------------------- saving -- */

  markDirty(): void {
    this.scheduler.request();
  }

  flush(): void {
    this.scheduler.flush();
  }

  wipe(): void {
    this.store.wipe();
    this.data = createProfileData();
    this.rebuildGranted();
    this.store.save(this.data);
  }

  exportSave(): string {
    this.flush();
    return this.store.exportText();
  }

  importSave(text: string): boolean {
    const imported = this.store.importText(text);
    if (!imported) return false;
    const clean = sanitise(imported);
    if (!clean) return false;
    this.data = clean;
    this.rebuildGranted();
    this.store.save(this.data);
    return true;
  }

  /* ------------------------------------------------------------ currencies -- */

  balance(currency: CurrencyId): number {
    return this.data.currencies[currency] ?? 0;
  }

  addCurrency(currency: CurrencyId, amount: number): void {
    if (amount === 0) return;
    this.data.currencies[currency] = Math.max(0, (this.data.currencies[currency] ?? 0) + Math.floor(amount));
    this.markDirty();
  }

  spend(currency: CurrencyId, amount: number): boolean {
    if (amount <= 0) return true;
    if (this.balance(currency) < amount) return false;
    this.data.currencies[currency] -= amount;
    this.markDirty();
    return true;
  }

  /* ---------------------------------------------------------------- unlocks -- */

  private rebuildGranted(): void {
    this.grantedSet = new Set(this.data.granted);
    // Tree nodes contribute their grants implicitly, so a repaired profile never
    // loses access to content it paid for.
    for (const [id, ranks] of Object.entries(this.data.unlockRanks)) {
      if (ranks <= 0) continue;
      for (const gate of UNLOCK_BY_ID[id]?.grants ?? []) this.grantedSet.add(gate);
    }
    for (const id of Object.keys(this.data.achievements)) {
      for (const gate of ACHIEVEMENT_BY_ID[id]?.grants ?? []) this.grantedSet.add(gate);
    }
  }

  isUnlocked(gateId: string): boolean {
    return this.grantedSet.has(gateId);
  }

  grant(gateId: string): boolean {
    if (this.grantedSet.has(gateId)) return false;
    this.grantedSet.add(gateId);
    this.data.granted.push(gateId);
    this.markDirty();
    return true;
  }

  ranksOf(nodeId: string): number {
    return this.data.unlockRanks[nodeId] ?? 0;
  }

  canPurchase(node: UnlockNode): { ok: boolean; reason: string; cost: number } {
    const ranks = this.ranksOf(node.id);
    const cost = nodeCost(node, ranks);
    if (ranks >= maxRanks(node)) return { ok: false, reason: 'Fully acquired', cost };
    for (const req of node.requires) {
      if (this.ranksOf(req) <= 0) {
        return { ok: false, reason: `Requires ${UNLOCK_BY_ID[req]?.name ?? req}`, cost };
      }
    }
    if (this.balance('echoes') < cost) return { ok: false, reason: `Needs ${cost} echoes`, cost };
    return { ok: true, reason: '', cost };
  }

  purchase(nodeId: string): boolean {
    const node = UNLOCK_BY_ID[nodeId];
    if (!node) return false;
    const check = this.canPurchase(node);
    if (!check.ok) return false;
    if (!this.spend('echoes', check.cost)) return false;
    this.data.unlockRanks[nodeId] = this.ranksOf(nodeId) + 1;
    for (const gate of node.grants ?? []) this.grant(gate);
    this.markDirty();
    return true;
  }

  /** Permanent stat bonuses from purchased tree nodes, as one source. */
  permanentModifiers(): StatModifiers {
    const out: StatModifiers = {};
    for (const node of UNLOCK_NODES) {
      const ranks = this.ranksOf(node.id);
      if (ranks <= 0 || !node.modifiers) continue;
      for (const [key, value] of Object.entries(node.modifiers)) {
        const typed = key as keyof StatModifiers;
        out[typed] = (out[typed] ?? 0) + (value as number) * ranks;
      }
    }
    return out;
  }

  /** Starting shards granted by the Reserves node. */
  startingShards(): number {
    return this.ranksOf('core_reserves') * 18;
  }

  /* ----------------------------------------------------------- statistics -- */

  counter(key: string): number {
    return this.data.counters[key] ?? 0;
  }

  /** Adds to a counter. */
  bump(key: string, amount = 1): void {
    if (amount === 0) return;
    this.data.counters[key] = (this.data.counters[key] ?? 0) + amount;
    this.markDirty();
  }

  /** Records a high-water mark. */
  record(key: string, value: number): void {
    if (value > (this.data.counters[key] ?? 0)) {
      this.data.counters[key] = value;
      this.markDirty();
    }
  }

  resetPerRunCounters(): void {
    for (const key of PER_RUN_COUNTERS) this.data.counters[key] = 0;
    this.markDirty();
  }

  /* --------------------------------------------------------- achievements -- */

  isAchieved(id: string): boolean {
    return this.data.achievements[id] !== undefined;
  }

  /** Evaluates every achievement and returns the ones newly completed. */
  checkAchievements(): AchievementUnlockResult[] {
    const results: AchievementUnlockResult[] = [];
    for (const def of ACHIEVEMENT_DEFS) {
      if (this.isAchieved(def.id)) continue;
      if (this.counter(def.counter) < def.target) continue;
      this.data.achievements[def.id] = Date.now();
      const granted: string[] = [];
      for (const gate of def.grants ?? []) {
        if (this.grant(gate)) granted.push(gate);
      }
      if (def.echoes) this.addCurrency('echoes', def.echoes);
      results.push({ def, echoes: def.echoes ?? 0, granted });
    }
    if (results.length > 0) this.markDirty();
    return results;
  }

  achievementProgress(def: AchievementDef): { current: number; target: number; fraction: number } {
    const current = Math.min(this.counter(def.counter), def.target);
    return { current, target: def.target, fraction: def.target > 0 ? current / def.target : 0 };
  }

  /* ------------------------------------------------------------- discovery -- */

  discover(kind: keyof DiscoveryLog, id: string): boolean {
    const list = this.data.discovered[kind];
    if (list.includes(id)) return false;
    list.push(id);
    // Several achievements count unique discoveries; keep those counters in sync
    // here rather than at every call site.
    if (kind === 'upgrades') this.record('uniqueUpgrades', list.length);
    if (kind === 'synergies') {
      this.record('uniqueSynergies', list.length);
      this.bump('synergiesFound');
    }
    this.markDirty();
    return true;
  }

  hasDiscovered(kind: keyof DiscoveryLog, id: string): boolean {
    return this.data.discovered[kind].includes(id);
  }

  discoveryCount(kind: keyof DiscoveryLog): number {
    return this.data.discovered[kind].length;
  }

  /* ------------------------------------------------------------- run history -- */

  recordRun(record: RunRecord): void {
    this.data.history.push(record);
    if (this.data.history.length > 40) this.data.history.splice(0, this.data.history.length - 40);
    this.data.totalPlaySeconds += record.durationSeconds;
    this.data.lastSeed = record.seed;
    this.bump('runsPlayed');
    if (record.victory) {
      this.bump('runsWon');
      this.record('bestBoundWin', record.boundLevel);
    }
    this.record('bestCombo', record.bestCombo);
    this.markDirty();
    this.flush();
  }

  get settings(): Settings {
    return this.data.settings;
  }

  updateSettings(patch: Partial<Settings>): void {
    this.data.settings = { ...this.data.settings, ...patch };
    this.markDirty();
  }

  /** Highest Bound level the player may select. */
  maxBoundLevel(): number {
    if (!this.isUnlocked('bound_levels')) return 0;
    const wins = this.counter('runsWon');
    const best = this.counter('bestBoundWin');
    // One new level per win, so escalation always follows a demonstrated clear.
    return clamp(Math.max(1, Math.min(wins, best + 1)), 0, 12);
  }
}
