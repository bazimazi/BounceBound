/**
 * Daily contracts.
 *
 * Three objectives a day - one easy, one medium, one hard - drawn from a seed made
 * of the date, so everyone gets the same three and a reload cannot reroll them.
 * Progress accumulates across every run played that day, which matters: a contract
 * that must be done in one run punishes the player whose run went badly, and the
 * whole point is to make a bad run still count toward something.
 *
 * Contracts are phrased as things to *do*, never as things to survive, and each
 * one nudges toward a part of the game a player might be neglecting - perfect
 * bounces, elites, breaking things, a ball class they have not picked in a while.
 */

import { Rng } from '../core/rng';
import type { RunSummary } from './career';

export type ContractKind =
  | 'perfects'
  | 'kills'
  | 'elites'
  | 'rooms'
  | 'combo'
  | 'props'
  | 'shards'
  | 'bosses'
  | 'depth'
  | 'synergies'
  | 'ballRooms';

interface ContractTemplate {
  kind: ContractKind;
  /** `{n}` is the target, `{ball}` the ball class name; `a|b` picks singular or plural. */
  text: string;
  /** Easy, medium and hard targets. */
  targets: [number, number, number];
  /** `sum` accumulates across runs; `max` takes the best single run. */
  mode: 'sum' | 'max';
}

const TEMPLATES: ContractTemplate[] = [
  { kind: 'perfects', text: 'Land {n} perfect bounces', targets: [12, 30, 60], mode: 'sum' },
  { kind: 'kills', text: 'Destroy {n} enemies', targets: [25, 60, 120], mode: 'sum' },
  { kind: 'elites', text: 'Defeat {n} elite|elites', targets: [1, 3, 6], mode: 'sum' },
  { kind: 'rooms', text: 'Clear {n} rooms', targets: [6, 14, 26], mode: 'sum' },
  { kind: 'combo', text: 'Reach a {n}-hit combo', targets: [10, 18, 30], mode: 'max' },
  { kind: 'props', text: 'Break {n} objects', targets: [15, 40, 80], mode: 'sum' },
  { kind: 'shards', text: 'Earn {n} shards', targets: [120, 300, 600], mode: 'sum' },
  { kind: 'bosses', text: 'Defeat {n} boss|bosses', targets: [1, 2, 3], mode: 'sum' },
  { kind: 'depth', text: 'Reach depth {n}', targets: [2, 3, 3], mode: 'max' },
  { kind: 'synergies', text: 'Have {n} synergy|synergies active in one run', targets: [1, 2, 3], mode: 'max' },
  { kind: 'ballRooms', text: 'Clear {n} rooms as {ball}', targets: [4, 8, 16], mode: 'sum' },
];

const TEMPLATE_BY_KIND = Object.fromEntries(TEMPLATES.map((t) => [t.kind, t])) as Record<ContractKind, ContractTemplate>;

/** What each difficulty pays. The hard contract is the day's relic source. */
export const CONTRACT_REWARDS = [
  { echoes: 6, xp: 40, relics: 0 },
  { echoes: 10, xp: 70, relics: 0 },
  { echoes: 14, xp: 110, relics: 1 },
];

export interface Contract {
  kind: ContractKind;
  tier: number;
  target: number;
  /** Ball class for `ballRooms`, otherwise empty. */
  ballId: string;
  progress: number;
  done: boolean;
}

export interface ContractDay {
  day: string;
  contracts: Contract[];
}

/** UTC calendar day, the same boundary the daily seed uses. */
export function dayKey(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const d = `${date.getUTCDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Seconds until the contracts roll over. */
export function secondsUntilRollover(date = new Date()): number {
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(0, Math.round((next - date.getTime()) / 1000));
}

/**
 * The day's three contracts. `balls` is the profile's unlocked classes: a ball
 * contract is only possible once there is more than one class to choose between,
 * and it always names one other than the last one played, to push some variety.
 */
export function rollContracts(day: string, balls: string[], lastBall = ''): ContractDay {
  const rng = new Rng(`contracts:${day}`);
  const kinds = TEMPLATES.map((t) => t.kind).filter((kind) => kind !== 'ballRooms' || balls.length > 1);
  const chosen = rng.sample(kinds, 3);
  const others = balls.filter((b) => b !== lastBall);
  const contracts = chosen.map((kind, tier) => ({
    kind,
    tier,
    target: TEMPLATE_BY_KIND[kind].targets[tier],
    ballId: kind === 'ballRooms' ? rng.pick(others.length > 0 ? others : balls) : '',
    progress: 0,
    done: false,
  }));
  return { day, contracts };
}

export function contractText(contract: Contract, ballName: (id: string) => string): string {
  return TEMPLATE_BY_KIND[contract.kind].text
    .replace(/(\w+)\|(\w+)/, (_, one: string, many: string) => (contract.target === 1 ? one : many))
    .replace('{n}', `${contract.target}`)
    .replace('{ball}', contract.ballId ? ballName(contract.ballId) : '');
}

/** The value a run contributes to a contract. */
function runValue(contract: Contract, run: RunSummary): number {
  switch (contract.kind) {
    case 'perfects':
      return run.perfectBounces;
    case 'kills':
      return run.enemiesKilled;
    case 'elites':
      return run.elitesKilled;
    case 'rooms':
      return run.roomsCleared;
    case 'combo':
      return run.bestCombo;
    case 'props':
      return run.propsDestroyed;
    case 'shards':
      return run.shardsEarned;
    case 'bosses':
      return run.bossesKilled;
    case 'depth':
      return run.depth;
    case 'synergies':
      return run.synergies;
    case 'ballRooms':
      return run.ballId === contract.ballId ? run.roomsCleared : 0;
    default:
      return 0;
  }
}

/**
 * Applies a finished run to the day's contracts and returns the ones it
 * completed. Completed contracts never regress and never pay twice.
 */
export function applyRunToContracts(day: ContractDay, run: RunSummary): Contract[] {
  const completed: Contract[] = [];
  for (const contract of day.contracts) {
    if (contract.done) continue;
    const value = runValue(contract, run);
    const mode = TEMPLATE_BY_KIND[contract.kind]?.mode ?? 'sum';
    contract.progress = mode === 'sum' ? contract.progress + value : Math.max(contract.progress, value);
    if (contract.progress >= contract.target) {
      contract.progress = contract.target;
      contract.done = true;
      completed.push(contract);
    }
  }
  return completed;
}

export function isContractKind(value: unknown): value is ContractKind {
  return typeof value === 'string' && value in TEMPLATE_BY_KIND;
}
