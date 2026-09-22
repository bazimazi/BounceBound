/**
 * Headless balance simulator.
 *
 * Runs many bot-played runs and reports the aggregate numbers the brief asks to
 * balance against: how far runs get, what kills players, which upgrades get
 * picked, which builds form, and where damage actually comes from.
 *
 * This is not a substitute for playing the game. It is a substitute for *guessing*
 * - it catches an upgrade nobody can use, a room archetype that kills everyone,
 * and a curse that is strictly better than its alternatives, all of which are
 * invisible until you look at a few hundred runs at once.
 *
 * Usage: npm run balance -- [runs] [boundLevel]
 */

import { MemoryStorage } from '../src/core/storage';
import { Profile } from '../src/meta/profile';
import { Run } from '../src/run/run';
import { Bot, mulberry, playRun } from '../tests/helpers/bot';
import { BALL_CLASSES } from '../src/content/balls';
import { upgradeCatalogue } from '../src/content/upgrades/index';
import type { BiomeId } from '../src/content/ids';

const ALL_GATES = [
  'family_transformation',
  'family_cursed',
  'family_evolution',
  'family_exotic',
  'biome_citadel',
  'biome_rift',
  'biome_void',
  'elite_primes',
  'enemy_specialists',
  'room_miniboss',
  'bound_levels',
  'event_portals',
  'room_secret',
];

interface Aggregate {
  runs: number;
  wins: number;
  roomsCleared: number[];
  durations: number[];
  bestCombos: number[];
  damageBySource: Record<string, number>;
  deathCauses: Record<string, number>;
  pickCounts: Record<string, number>;
  offerCounts: Record<string, number>;
  identities: Record<string, number>;
  damageByEffect: Record<string, number>;
  synergiesSeen: Record<string, number>;
  ballResults: Record<string, { runs: number; rooms: number; wins: number }>;
}

function emptyAggregate(): Aggregate {
  return {
    runs: 0,
    wins: 0,
    roomsCleared: [],
    durations: [],
    bestCombos: [],
    damageBySource: {},
    deathCauses: {},
    pickCounts: {},
    offerCounts: {},
    identities: {},
    damageByEffect: {},
    synergiesSeen: {},
    ballResults: {},
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function simulate(count: number, boundLevel: number, skill: number): Aggregate {
  const aggregate = emptyAggregate();
  const biomes: BiomeId[] = ['verdant', 'foundry', 'abyss'];

  for (let i = 0; i < count; i++) {
    const profile = new Profile(new MemoryStorage());
    for (const gate of ALL_GATES) profile.grant(gate);
    const ballClass = BALL_CLASSES[i % BALL_CLASSES.length];
    const run = new Run({
      profile,
      seed: `SIM-${boundLevel}-${i}`,
      ballId: ballClass.id,
      boundLevel,
      biomes,
    });

    // Record what was offered versus what was taken, which is the only honest way
    // to measure pick rate.
    run.bus.on('upgradeGained', ({ id }) => {
      aggregate.pickCounts[id] = (aggregate.pickCounts[id] ?? 0) + 1;
    });
    run.bus.on('synergyActivated', ({ id }) => {
      aggregate.synergiesSeen[id] = (aggregate.synergiesSeen[id] ?? 0) + 1;
    });

    const bot = new Bot({ random: mulberry(i * 7919 + 13), skill });
    playRun(run, { maxSteps: 240 * 60 * 12, bot });

    aggregate.runs++;
    if (run.victory) aggregate.wins++;
    aggregate.roomsCleared.push(run.telemetry.roomsCleared);
    aggregate.durations.push(run.telemetry.durationSeconds);
    aggregate.bestCombos.push(run.telemetry.bestCombo);
    const cause = run.finished ? (run.victory ? 'victory' : run.deathCause) : 'timeout';
    aggregate.deathCauses[cause] = (aggregate.deathCauses[cause] ?? 0) + 1;
    for (const [source, amount] of Object.entries(run.telemetry.damageBySource)) {
      aggregate.damageBySource[source] = (aggregate.damageBySource[source] ?? 0) + amount;
    }
    for (const [effect, amount] of Object.entries(run.telemetry.damageByEffect)) {
      aggregate.damageByEffect[effect] = (aggregate.damageByEffect[effect] ?? 0) + amount;
    }
    const identity = run.build.identity().map((x) => x.name).join('/') || 'Improvised';
    aggregate.identities[identity] = (aggregate.identities[identity] ?? 0) + 1;

    const ballEntry = (aggregate.ballResults[ballClass.id] ??= { runs: 0, rooms: 0, wins: 0 });
    ballEntry.runs++;
    ballEntry.rooms += run.telemetry.roomsCleared;
    if (run.victory) ballEntry.wins++;

    run.dispose();
  }
  return aggregate;
}

function report(label: string, aggregate: Aggregate): void {
  const catalogue = upgradeCatalogue();
  console.log(`\n=== ${label} ===`);
  console.log(`runs ${aggregate.runs}  wins ${aggregate.wins} (${((aggregate.wins / aggregate.runs) * 100).toFixed(1)}%)`);
  console.log(
    `rooms cleared  mean ${mean(aggregate.roomsCleared).toFixed(1)}  p10 ${percentile(aggregate.roomsCleared, 0.1)}  p50 ${percentile(
      aggregate.roomsCleared,
      0.5,
    )}  p90 ${percentile(aggregate.roomsCleared, 0.9)}`,
  );
  console.log(
    `run length s   mean ${mean(aggregate.durations).toFixed(0)}  p50 ${percentile(aggregate.durations, 0.5).toFixed(0)}  p90 ${percentile(
      aggregate.durations,
      0.9,
    ).toFixed(0)}`,
  );
  console.log(`best combo     mean ${mean(aggregate.bestCombos).toFixed(1)}  p90 ${percentile(aggregate.bestCombos, 0.9)}`);

  console.log('\ndeath causes:');
  for (const [cause, n] of Object.entries(aggregate.deathCauses).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cause.padEnd(14)} ${((n / aggregate.runs) * 100).toFixed(1)}%`);
  }

  console.log('\ndamage taken by source:');
  const totalTaken = Object.values(aggregate.damageBySource).reduce((a, b) => a + b, 0) || 1;
  for (const [source, amount] of Object.entries(aggregate.damageBySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${source.padEnd(14)} ${((amount / totalTaken) * 100).toFixed(1)}%`);
  }

  console.log('\nbuild identities:');
  for (const [identity, n] of Object.entries(aggregate.identities).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${identity.padEnd(22)} ${((n / aggregate.runs) * 100).toFixed(1)}%`);
  }

  console.log('\nballs:');
  for (const [id, entry] of Object.entries(aggregate.ballResults)) {
    console.log(`  ${id.padEnd(10)} rooms/run ${(entry.rooms / entry.runs).toFixed(1)}  wins ${entry.wins}/${entry.runs}`);
  }

  const picked = Object.entries(aggregate.pickCounts).sort((a, b) => b[1] - a[1]);
  console.log('\nmost picked upgrades:');
  for (const [id, n] of picked.slice(0, 12)) console.log(`  ${id.padEnd(22)} ${n}`);

  const neverPicked = catalogue.filter((def) => !aggregate.pickCounts[def.id]).map((d) => d.id);
  console.log(`\nnever picked (${neverPicked.length}/${catalogue.length}):`);
  if (neverPicked.length > 0) console.log(`  ${neverPicked.join(', ')}`);

  console.log('\nsynergies observed:');
  const synergies = Object.entries(aggregate.synergiesSeen).sort((a, b) => b[1] - a[1]);
  if (synergies.length === 0) console.log('  none');
  for (const [id, n] of synergies) console.log(`  ${id.padEnd(22)} ${n}`);

  console.log('\ndamage dealt by effect tag:');
  const totalDealt = Object.values(aggregate.damageByEffect).reduce((a, b) => a + b, 0) || 1;
  for (const [effect, amount] of Object.entries(aggregate.damageByEffect).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${effect.padEnd(16)} ${((amount / totalDealt) * 100).toFixed(1)}%`);
  }
}

const runCount = Number(process.argv[2] ?? 60);
const bound = Number(process.argv[3] ?? 0);

report(`Bound ${bound}, mediocre bot (skill 0.45)`, simulate(runCount, bound, 0.45));
report(`Bound ${bound}, skilled bot (skill 0.9)`, simulate(Math.max(10, Math.floor(runCount / 2)), bound, 0.9));
