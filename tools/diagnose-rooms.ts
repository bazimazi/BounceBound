/**
 * Per-room pacing diagnostic.
 *
 * Reports how long each room takes to clear and how long the exit takes after
 * that, broken down by archetype and by the enemies present. Room pacing is the
 * single most important tuning number in the game: a room that takes three
 * minutes is not hard, it is boring.
 */

import { MemoryStorage } from '../src/core/storage';
import { FIXED_DT } from '../src/core/clock';
import { Profile } from '../src/meta/profile';
import { Run } from '../src/run/run';
import { Bot, mulberry } from '../tests/helpers/bot';

interface Sample {
  archetype: string;
  clearSeconds: number;
  exitSeconds: number;
  enemies: string[];
  cleared: boolean;
}

const samples: Sample[] = [];

for (let i = 0; i < 24; i++) {
  const profile = new Profile(new MemoryStorage());
  for (const gate of ['elite_primes', 'enemy_specialists', 'family_transformation']) profile.grant(gate);
  const run = new Run({ profile, seed: `ROOMS-${i}`, ballId: 'standard', biomes: ['verdant', 'foundry', 'abyss'] });
  const bot = new Bot({ random: mulberry(i * 131 + 7), skill: 0.55 });

  let roomStart = 0;
  let clearedAt = -1;
  let current = {
    archetype: run.currentRoom.archetype,
    enemies: run.currentRoom.enemies.map((e) => e.defId),
  };

  let steps = 0;
  const budget = 240 * 60 * 8;
  while (steps < budget && !run.finished) {
    if (run.phase === 'playing') {
      run.step(FIXED_DT, bot.update(run.world, FIXED_DT));
      steps++;
      if (clearedAt < 0 && run.world.cleared) clearedAt = run.world.roomTime;
    } else if (run.phase === 'reward') {
      const offer = run.reward;
      if (!offer || offer.upgrades.length === 0) run.skipReward();
      else run.takeUpgrade(offer.upgrades[0].id);
    } else if (run.phase === 'event') {
      if (run.eventPrompt && !run.eventPrompt.resolved) run.chooseEventOption(0);
      else run.closeEvent();
    } else if (run.phase === 'map') {
      samples.push({
        archetype: current.archetype,
        clearSeconds: clearedAt < 0 ? -1 : clearedAt,
        exitSeconds: clearedAt < 0 ? -1 : run.world.roomTime - clearedAt,
        enemies: current.enemies,
        cleared: clearedAt >= 0,
      });
      const choice = run.mapChoices[0];
      if (!choice) break;
      run.chooseNode(choice.id);
      roomStart = 0;
      clearedAt = -1;
      current = {
        archetype: run.currentRoom.archetype,
        enemies: run.currentRoom.enemies.map((e) => e.defId),
      };
      void roomStart;
    } else {
      break;
    }
  }
  if (run.phase === 'playing') {
    samples.push({
      archetype: current.archetype,
      clearSeconds: -1,
      exitSeconds: -1,
      enemies: current.enemies,
      cleared: false,
    });
    const goal = run.world.props.find((p) => p.kind === 'goal');
    const before = { x: run.world.ball.x, y: run.world.ball.y };
    for (let s = 0; s < 240 * 3; s++) run.step(FIXED_DT, bot.update(run.world, FIXED_DT));
    const moved = Math.hypot(run.world.ball.x - before.x, run.world.ball.y - before.y);
    console.log(
      `STALL ${current.archetype}/${run.currentRoom.templateId} cleared=${run.world.cleared} ` +
        `exitOpen=${run.world.exitOpenTime.toFixed(0)}s live=${run.world.enemies.filter((e) => !e.dead).length} ` +
        `goalActive=${goal?.active} goal=${goal && goal.shape.kind === 'circle' ? `${Math.round(goal.shape.x)},${Math.round(goal.shape.y)}` : '?'} ` +
        `ball=${Math.round(run.world.ball.x)},${Math.round(run.world.ball.y)} speed=${Math.hypot(run.world.ball.vx, run.world.ball.vy).toFixed(0)} ` +
        `movedIn3s=${moved.toFixed(0)} hp=${run.world.ball.hp.toFixed(0)} phase=${run.phase}`,
    );
  }
  run.dispose();
}

function stats(values: number[]): string {
  if (values.length === 0) return 'n/a';
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return `n=${sorted.length} mean ${mean.toFixed(0)}s p50 ${sorted[Math.floor(sorted.length * 0.5)].toFixed(0)}s p90 ${sorted[
    Math.floor(sorted.length * 0.9)
  ].toFixed(0)}s max ${sorted[sorted.length - 1].toFixed(0)}s`;
}

const cleared = samples.filter((s) => s.cleared);
console.log(`\nrooms sampled ${samples.length}, cleared ${cleared.length} (${((cleared.length / samples.length) * 100).toFixed(0)}%)`);
console.log(`clear time     ${stats(cleared.map((s) => s.clearSeconds))}`);
console.log(`exit time      ${stats(cleared.map((s) => s.exitSeconds))}`);

console.log('\nby archetype:');
const byArchetype = new Map<string, number[]>();
for (const sample of cleared) {
  if (!byArchetype.has(sample.archetype)) byArchetype.set(sample.archetype, []);
  byArchetype.get(sample.archetype)!.push(sample.clearSeconds);
}
for (const [archetype, values] of [...byArchetype.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${archetype.padEnd(10)} ${stats(values)}`);
}

console.log('\nslowest rooms:');
for (const sample of [...cleared].sort((a, b) => b.clearSeconds - a.clearSeconds).slice(0, 10)) {
  console.log(`  ${sample.clearSeconds.toFixed(0)}s ${sample.archetype.padEnd(10)} [${sample.enemies.join(', ')}]`);
}

const failed = samples.filter((s) => !s.cleared);
if (failed.length > 0) {
  console.log('\nnever cleared:');
  for (const sample of failed.slice(0, 10)) {
    console.log(`  ${sample.archetype.padEnd(10)} [${sample.enemies.join(', ')}]`);
  }
}

// Which enemies show up in the slowest quartile disproportionately often.
const slowThreshold = [...cleared].sort((a, b) => a.clearSeconds - b.clearSeconds)[
  Math.floor(cleared.length * 0.75)
]?.clearSeconds ?? 0;
const slowCounts = new Map<string, number>();
const allCounts = new Map<string, number>();
for (const sample of cleared) {
  for (const id of new Set(sample.enemies)) {
    allCounts.set(id, (allCounts.get(id) ?? 0) + 1);
    if (sample.clearSeconds >= slowThreshold) slowCounts.set(id, (slowCounts.get(id) ?? 0) + 1);
  }
}
console.log(`\nenemies over-represented in the slowest quartile (>= ${slowThreshold.toFixed(0)}s):`);
for (const [id, total] of [...allCounts.entries()].sort((a, b) => b[1] - a[1])) {
  const slow = slowCounts.get(id) ?? 0;
  console.log(`  ${id.padEnd(16)} ${slow}/${total} (${((slow / total) * 100).toFixed(0)}%)`);
}
