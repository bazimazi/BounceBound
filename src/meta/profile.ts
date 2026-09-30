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
import { UNLOCK_BY_ID, UNLOCK_NODES, maxRanks, nodeCost, nodeCurrency, type UnlockNode } from '../content/unlocks';
import { BALL_CLASSES, getBallClass } from '../content/balls';
import {
  FINISH_BY_ID,
  masteryReward,
  masteryTier,
  rankReward,
  runExperience,
  xpToNextRank,
  type CareerReward,
  type RunSummary,
} from '../content/career';
import {
  CONTRACT_REWARDS,
  applyRunToContracts,
  dayKey,
  isContractKind,
  rollContracts,
  type Contract,
  type ContractDay,
} from '../content/contracts';
import type { StatModifiers } from '../sim/stats';
import { defaultSettings, mergeSettings, type Settings } from './settings';

export const PROFILE_VERSION = 4;

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

/**
 * The career: rank, mastery, contracts and cosmetics. See `content/career`.
 * Kept in one record so an older profile gains the whole thing in one repair.
 */
export interface CareerData {
  rank: number;
  /** Experience into the current rank. */
  xp: number;
  /** Every point ever earned, for the statistics line. */
  totalXp: number;
  title: string;
  titles: string[];
  finish: string;
  finishes: string[];
  /** Ball class id -> cumulative mastery experience. */
  mastery: Record<string, number>;
  /** Ball classes that have completed a run. */
  ballsWon: string[];
  contracts: ContractDay | null;
}

export function createCareer(): CareerData {
  return {
    rank: 1,
    xp: 0,
    totalXp: 0,
    title: '',
    titles: [],
    finish: 'class',
    finishes: ['class'],
    mastery: {},
    ballsWon: [],
    contracts: null,
  };
}

/** Everything a finished run moved on the career, for the summary screen. */
export interface CareerResult {
  xpLines: Array<{ label: string; amount: number }>;
  xpTotal: number;
  rankBefore: number;
  rankAfter: number;
  /** Fraction into the rank, before and after, for the animated bar. */
  fractionBefore: number;
  fractionAfter: number;
  rankUps: Array<{ rank: number; reward: CareerReward }>;
  mastery: { ballId: string; before: number; after: number; tierUps: Array<{ tier: number; reward: CareerReward }> };
  contracts: Contract[];
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
  career: CareerData;
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
    career: createCareer(),
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string'))] : [];
}

function sanitiseCareer(input: unknown): CareerData {
  const out = createCareer();
  if (!input || typeof input !== 'object') return out;
  const raw = input as Partial<CareerData>;
  const count = (value: unknown, min: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.floor(value)) : min;
  out.rank = clamp(count(raw.rank, 1), 1, 999);
  out.xp = Math.min(count(raw.xp, 0), xpToNextRank(out.rank) - 1);
  out.totalXp = count(raw.totalXp, 0);
  out.titles = strings(raw.titles);
  out.title = typeof raw.title === 'string' && out.titles.includes(raw.title) ? raw.title : '';
  out.finishes = ['class', ...strings(raw.finishes).filter((id) => id !== 'class' && FINISH_BY_ID[id])];
  out.finish = typeof raw.finish === 'string' && out.finishes.includes(raw.finish) ? raw.finish : 'class';
  if (raw.mastery && typeof raw.mastery === 'object') {
    for (const [id, xp] of Object.entries(raw.mastery)) {
      if (BALL_CLASSES.some((b) => b.id === id)) out.mastery[id] = count(xp, 0);
    }
  }
  out.ballsWon = strings(raw.ballsWon).filter((id) => BALL_CLASSES.some((b) => b.id === id));
  const day = raw.contracts;
  if (day && typeof day === 'object' && typeof day.day === 'string' && Array.isArray(day.contracts)) {
    const contracts = day.contracts
      .filter((c): c is Contract => !!c && typeof c === 'object' && isContractKind((c as Contract).kind))
      .slice(0, 3)
      .map((c, index) => ({
        kind: c.kind,
        tier: typeof c.tier === 'number' ? clamp(Math.floor(c.tier), 0, 2) : index,
        target: Math.max(1, count(c.target, 1)),
        ballId: typeof c.ballId === 'string' ? c.ballId : '',
        progress: count(c.progress, 0),
        done: !!c.done,
      }));
    if (contracts.length === 3) out.contracts = { day: day.day, contracts };
  }
  return out;
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
  out.career = sanitiseCareer(raw.career);

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

export interface UnlockGoal {
  node: UnlockNode;
  cost: number;
  currency: 'echoes' | 'relics';
  affordable: boolean;
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
    if (node.planned) return { ok: false, reason: 'Not open yet', cost };
    for (const req of node.requires) {
      if (this.ranksOf(req) <= 0) {
        return { ok: false, reason: `Requires ${UNLOCK_BY_ID[req]?.name ?? req}`, cost };
      }
    }
    const currency = nodeCurrency(node);
    if (this.balance(currency) < cost) {
      const unit = currency === 'relics' ? (cost === 1 ? 'relic' : 'relics') : 'echoes';
      return { ok: false, reason: `Needs ${cost} ${unit}`, cost };
    }
    return { ok: true, reason: '', cost };
  }

  purchase(nodeId: string): boolean {
    const node = UNLOCK_BY_ID[nodeId];
    if (!node) return false;
    const check = this.canPurchase(node);
    if (!check.ok) return false;
    if (!this.spend(nodeCurrency(node), check.cost)) return false;
    this.data.unlockRanks[nodeId] = this.ranksOf(nodeId) + 1;
    for (const gate of node.grants ?? []) this.grant(gate);
    this.markDirty();
    return true;
  }

  /**
   * What the player is saving toward: every node whose prerequisites are met and
   * that is not yet owned, cheapest first. The results screen uses this so a run
   * always ends pointing at a concrete next unlock rather than a bare balance.
   */
  unlockGoals(): UnlockGoal[] {
    const goals: UnlockGoal[] = [];
    for (const node of UNLOCK_NODES) {
      if (node.planned || this.ranksOf(node.id) >= maxRanks(node)) continue;
      if (!node.requires.every((req) => this.ranksOf(req) > 0)) continue;
      const cost = nodeCost(node, this.ranksOf(node.id));
      const currency = nodeCurrency(node);
      goals.push({ node, cost, currency, affordable: this.balance(currency) >= cost });
    }
    return goals.sort((a, b) => a.cost - b.cost);
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

  /* ---------------------------------------------------------------- career -- */

  get career(): CareerData {
    return this.data.career;
  }

  /** Progress into the current rank, 0..1. */
  rankFraction(): number {
    return this.career.xp / xpToNextRank(this.career.rank);
  }

  masteryOf(ballId: string): number {
    return this.career.mastery[ballId] ?? 0;
  }

  private grantCareerReward(reward: CareerReward): void {
    const career = this.career;
    if (reward.echoes) this.addCurrency('echoes', reward.echoes);
    if (reward.relics) this.addCurrency('relics', reward.relics);
    if (reward.title && !career.titles.includes(reward.title)) {
      career.titles.push(reward.title);
      // A new title is worn straight away: the player just earned it, and the
      // menu is where they will see it.
      career.title = reward.title;
    }
    if (reward.finish && !career.finishes.includes(reward.finish)) career.finishes.push(reward.finish);
    this.markDirty();
  }

  /** Adds career experience and pays every rank reached. */
  addExperience(amount: number): Array<{ rank: number; reward: CareerReward }> {
    const career = this.career;
    const ups: Array<{ rank: number; reward: CareerReward }> = [];
    const gained = Math.max(0, Math.floor(amount));
    career.xp += gained;
    career.totalXp += gained;
    while (career.xp >= xpToNextRank(career.rank)) {
      career.xp -= xpToNextRank(career.rank);
      career.rank++;
      const reward = rankReward(career.rank);
      this.grantCareerReward(reward);
      ups.push({ rank: career.rank, reward });
    }
    this.record('careerRank', career.rank);
    this.markDirty();
    return ups;
  }

  /** Adds mastery experience for one ball class and pays every tier reached. */
  addMastery(ballId: string, amount: number): Array<{ tier: number; reward: CareerReward }> {
    const career = this.career;
    const before = this.masteryOf(ballId);
    const after = before + Math.max(0, Math.floor(amount));
    career.mastery[ballId] = after;
    const ups: Array<{ tier: number; reward: CareerReward }> = [];
    const name = getBallClass(ballId).name;
    for (let tier = masteryTier(before) + 1; tier <= masteryTier(after); tier++) {
      const reward = masteryReward(tier, name);
      this.grantCareerReward(reward);
      ups.push({ tier, reward });
    }
    this.record('bestMastery', masteryTier(after));
    this.markDirty();
    return ups;
  }

  /**
   * Today's contracts, rolling a fresh set when the day has changed. Rolled once
   * and stored, so unlocking a ball mid-day cannot change what was offered.
   */
  contractDay(now = new Date()): ContractDay {
    const today = dayKey(now);
    const career = this.career;
    if (!career.contracts || career.contracts.day !== today) {
      const balls = BALL_CLASSES.filter((b) => !b.unlock || this.isUnlocked(b.unlock)).map((b) => b.id);
      career.contracts = rollContracts(today, balls, this.data.selectedBall);
      this.markDirty();
    }
    return career.contracts;
  }

  wearTitle(title: string): void {
    if (title !== '' && !this.career.titles.includes(title)) return;
    this.career.title = title;
    this.markDirty();
  }

  wearFinish(id: string): void {
    if (!this.career.finishes.includes(id)) return;
    this.career.finish = id;
    this.markDirty();
  }

  /**
   * Applies a finished run to the career: contracts first (their experience is
   * part of the run's payout), then rank, then the ball's mastery.
   */
  applyRunProgress(summary: RunSummary, now = new Date()): CareerResult {
    const career = this.career;
    const rankBefore = career.rank;
    const fractionBefore = this.rankFraction();
    const xpLines = runExperience(summary);

    const completed = applyRunToContracts(this.contractDay(now), summary);
    for (const contract of completed) {
      const reward = CONTRACT_REWARDS[contract.tier] ?? CONTRACT_REWARDS[0];
      this.addCurrency('echoes', reward.echoes);
      if (reward.relics) this.addCurrency('relics', reward.relics);
      xpLines.push({ label: 'Contract', amount: reward.xp });
      this.bump('contractsCompleted');
    }

    const xpTotal = xpLines.reduce((sum, line) => sum + line.amount, 0);
    const rankUps = this.addExperience(xpTotal);
    const masteryBefore = this.masteryOf(summary.ballId);
    const tierUps = this.addMastery(summary.ballId, xpTotal);

    if (summary.victory && !career.ballsWon.includes(summary.ballId)) {
      career.ballsWon.push(summary.ballId);
      this.record('ballsWon', career.ballsWon.length);
    }
    this.markDirty();

    return {
      xpLines,
      xpTotal,
      rankBefore,
      rankAfter: career.rank,
      fractionBefore,
      fractionAfter: this.rankFraction(),
      rankUps,
      mastery: { ballId: summary.ballId, before: masteryBefore, after: this.masteryOf(summary.ballId), tierUps },
      contracts: completed,
    };
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
