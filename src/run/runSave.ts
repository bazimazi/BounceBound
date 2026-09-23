/**
 * In-progress run persistence.
 *
 * A refresh, a crash, or closing the tab must not cost the player their run. That
 * is a hard requirement for a game that plays in a browser, where an accidental
 * reload is one keystroke away.
 *
 * What makes this cheap is determinism. Because the map and every room are pure
 * functions of the run seed, none of the *world* needs saving - no geometry, no
 * enemy placement, no props. Only the things the player accumulated need to be
 * written down, and the room is regenerated on load.
 *
 * Granularity is the room, not the frame. A resumed run puts the player back at the
 * start of the room they were in, carrying their current integrity, shields, build
 * and currency. Saving mid-flight would mean serialising every entity's position
 * and velocity for a benefit nobody asked for; restarting the room is a clean,
 * comprehensible contract. Vitals are stored live rather than at room entry, so a
 * reload cannot be used to undo damage already taken.
 */

import { PersistentStore, type KeyValueStorage } from '../core/storage';
import type { BiomeId } from '../content/ids';
import { getUpgrade } from '../game/upgradeSystem';
import type { RunTelemetry } from './run';

export const RUN_SAVE_VERSION = 2;

export interface RunSnapshot {
  version: number;
  savedAt: number;

  /* identity: everything needed to rebuild the same map */
  seed: string;
  ballId: string;
  boundLevel: number;
  biomes: BiomeId[];

  /* position in the run */
  nodeId: number;
  visitedNodes: number[];
  /** Nodes whose hidden flag has already been revealed to the player. */
  revealedNodes: number[];

  /* what the player has accumulated */
  upgrades: Array<{ id: string; stacks: number }>;
  shards: number;
  relics: number;
  rerolls: number;

  /* live vitals */
  hp: number;
  maxHp: number;
  shield: number;
  revives: number;

  seenEvents: string[];
  telemetry: RunTelemetry;
  droppedBelowHalf: boolean;
}

export class RunStore {
  private readonly store: PersistentStore<RunSnapshot>;

  constructor(storage?: KeyValueStorage) {
    this.store = new PersistentStore<RunSnapshot>({
      key: 'bouncebound.run',
      version: RUN_SAVE_VERSION,
      storage,
    });
  }

  save(snapshot: RunSnapshot): void {
    this.store.save(snapshot);
  }

  /** Returns a usable snapshot, or null. Never throws on bad data. */
  load(): RunSnapshot | null {
    const result = this.store.load();
    const data = result.data;
    if (!data) return null;
    return sanitiseSnapshot(data);
  }

  clear(): void {
    this.store.wipe();
  }

  get hasSave(): boolean {
    return this.load() !== null;
  }
}

/**
 * Validates and repairs a snapshot.
 *
 * A saved run is untrusted input, and it can also be *stale*: written by an older
 * build whose upgrade ids or biome list no longer match. Anything unrecognised is
 * dropped rather than trusted, and a snapshot missing something structural is
 * rejected outright so the player gets a clean menu instead of a broken run.
 */
export function sanitiseSnapshot(raw: unknown): RunSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Partial<RunSnapshot>;

  if (typeof input.seed !== 'string' || input.seed.length === 0) return null;
  if (typeof input.nodeId !== 'number' || !Number.isFinite(input.nodeId)) return null;
  if (!Array.isArray(input.biomes) || input.biomes.length === 0) return null;

  const upgrades: Array<{ id: string; stacks: number }> = [];
  if (Array.isArray(input.upgrades)) {
    for (const entry of input.upgrades) {
      if (!entry || typeof entry.id !== 'string') continue;
      // Silently skip upgrades this build no longer defines.
      if (!getUpgrade(entry.id)) continue;
      const stacks = typeof entry.stacks === 'number' ? Math.max(1, Math.floor(entry.stacks)) : 1;
      upgrades.push({ id: entry.id, stacks });
    }
  }

  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  return {
    version: RUN_SAVE_VERSION,
    savedAt: number(input.savedAt, Date.now()),
    seed: input.seed,
    ballId: typeof input.ballId === 'string' ? input.ballId : 'standard',
    boundLevel: Math.max(0, Math.floor(number(input.boundLevel, 0))),
    biomes: input.biomes.filter((b): b is BiomeId => typeof b === 'string'),
    nodeId: Math.floor(input.nodeId),
    visitedNodes: Array.isArray(input.visitedNodes) ? input.visitedNodes.filter((n): n is number => typeof n === 'number') : [],
    revealedNodes: Array.isArray(input.revealedNodes) ? input.revealedNodes.filter((n): n is number => typeof n === 'number') : [],
    upgrades,
    shards: Math.max(0, Math.floor(number(input.shards, 0))),
    relics: Math.max(0, Math.floor(number(input.relics, 0))),
    rerolls: Math.max(0, Math.floor(number(input.rerolls, 0))),
    hp: Math.max(1, number(input.hp, 100)),
    maxHp: Math.max(1, number(input.maxHp, 100)),
    shield: Math.max(0, Math.floor(number(input.shield, 0))),
    revives: Math.max(0, Math.floor(number(input.revives, 0))),
    seenEvents: Array.isArray(input.seenEvents) ? input.seenEvents.filter((e): e is string => typeof e === 'string') : [],
    telemetry: sanitiseTelemetry(input.telemetry),
    droppedBelowHalf: !!input.droppedBelowHalf,
  };
}

function sanitiseTelemetry(raw: unknown): RunTelemetry {
  const input = (raw ?? {}) as Partial<RunTelemetry>;
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const record = (value: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
      }
    }
    return out;
  };
  return {
    startedAt: num(input.startedAt) || Date.now(),
    durationSeconds: num(input.durationSeconds),
    roomsCleared: num(input.roomsCleared),
    roomsEntered: num(input.roomsEntered),
    enemiesKilled: num(input.enemiesKilled),
    elitesKilled: num(input.elitesKilled),
    bossesKilled: num(input.bossesKilled),
    propsDestroyed: num(input.propsDestroyed),
    impacts: num(input.impacts),
    perfectBounces: num(input.perfectBounces),
    bestCombo: num(input.bestCombo),
    shardsEarned: num(input.shardsEarned),
    shardsSpent: num(input.shardsSpent),
    damageDealt: num(input.damageDealt),
    damageTaken: num(input.damageTaken),
    upgradesTaken: num(input.upgradesTaken),
    rerollsUsed: num(input.rerollsUsed),
    deepestDepth: num(input.deepestDepth),
    deepestBiome: (typeof input.deepestBiome === 'string' ? input.deepestBiome : 'verdant') as BiomeId,
    damageBySource: record(input.damageBySource),
    killsBySource: record(input.killsBySource),
    damageByEffect: record(input.damageByEffect),
  };
}

/** Short human description used by the Continue button on the menu. */
export function describeSnapshot(snapshot: RunSnapshot): string {
  const act = snapshot.biomes.indexOf(snapshot.telemetry.deepestBiome as BiomeId) + 1;
  return [
    `depth ${Math.max(1, act)}`,
    `${snapshot.telemetry.roomsCleared} rooms`,
    `${snapshot.upgrades.length} upgrades`,
    `${Math.ceil(snapshot.hp)} integrity`,
  ].join(' - ');
}
