/**
 * Soak test: hunts for unreachable game states.
 *
 * Plays many long runs and reports the two failures that matter most and that unit
 * tests cannot find, because they need thousands of simulated seconds across
 * hundreds of generated rooms to surface:
 *
 *  1. A room that never clears - which enemy is still alive, where, and in what
 *     state. Every hit so far has been a real defect: an enemy buried in a prop, a
 *     defence with no way through, a ball unable to regain height, a splitter
 *     multiplying its own spawner.
 *  2. A non-finite ball position, reported with the impacts that preceded it.
 *
 * Run before any release: `npm run soak`.
 */

import { MemoryStorage } from '../src/core/storage';
import { FIXED_DT } from '../src/core/clock';
import { Profile } from '../src/meta/profile';
import { Run } from '../src/run/run';
import { Bot, mulberry } from '../tests/helpers/bot';
import { describeImpact } from '../src/sim/impact';

const survivors = new Map<string, number>();
const details: string[] = [];
const nanReports: string[] = [];

for (let i = 0; i < 40; i++) {
  const profile = new Profile(new MemoryStorage());
  for (const gate of ['elite_primes', 'enemy_specialists', 'family_transformation', 'family_cursed']) profile.grant(gate);
  const run = new Run({ profile, seed: `BUG-${i}`, ballId: 'standard', biomes: ['verdant', 'foundry', 'abyss'] });
  const bot = new Bot({ random: mulberry(i * 977 + 3), skill: 0.5 });

  const recent: string[] = [];
  run.bus.on('impactResolved', (ctx) => {
    recent.push(describeImpact(ctx));
    if (recent.length > 6) recent.shift();
  });

  let nanFound = false;
  let steps = 0;
  const budget = 240 * 60 * 5;

  while (steps < budget && !run.finished) {
    if (run.phase === 'playing') {
      run.step(FIXED_DT, bot.update(run.world, FIXED_DT));
      steps++;
      const ball = run.world.ball;
      if (!nanFound && (!Number.isFinite(ball.x) || !Number.isFinite(ball.y) || !Number.isFinite(ball.vx))) {
        nanFound = true;
        nanReports.push(
          `run ${i} room ${run.currentRoom.archetype}/${run.currentRoom.templateId} biome ${run.currentRoom.biome}\n` +
            `  ball ${ball.x},${ball.y} vel ${ball.vx},${ball.vy} radius ${ball.radius}\n` +
            `  gravity ${run.world.activeGravityX},${run.world.activeGravityY} flip ${run.world.gravityFlipTimer}\n` +
            `  build ${run.build.order.join(', ')}\n` +
            `  recent impacts:\n${recent.map((r) => `    ${r}`).join('\n')}`,
        );
        break;
      }
    } else if (run.phase === 'reward') {
      const offer = run.reward;
      if (!offer || offer.upgrades.length === 0) run.skipReward();
      else run.takeUpgrade(offer.upgrades[0].id);
    } else if (run.phase === 'event') {
      if (run.eventPrompt && !run.eventPrompt.resolved) run.chooseEventOption(0);
      else run.closeEvent();
    } else if (run.phase === 'map') {
      const choice = run.mapChoices[0];
      if (!choice) break;
      run.chooseNode(choice.id);
    } else {
      break;
    }
  }

  if (!nanFound && run.phase === 'playing' && !run.world.cleared) {
    for (const enemy of run.world.enemies) {
      if (enemy.dead) continue;
      survivors.set(enemy.defId, (survivors.get(enemy.defId) ?? 0) + 1);
      if (details.length < 14) {
        details.push(
          `${run.currentRoom.archetype}/${run.currentRoom.templateId}: ${enemy.defId} ` +
            `gen${enemy.generation} hp ${enemy.hp.toFixed(0)}/${enemy.maxHp} r${enemy.radius.toFixed(1)} ` +
            `at ${Math.round(enemy.x)},${Math.round(enemy.y)} (arena ${run.world.width}x${run.world.height}) ` +
            `state ${enemy.state} flags ${enemy.flags} breach ${(enemy.scratch.breach ?? 0).toFixed(1)} ` +
            `ballAt ${Math.round(run.world.ball.x)},${Math.round(run.world.ball.y)}`,
        );
      }
    }
  }
  run.dispose();
}

console.log('=== unkillable survivors ===');
for (const [id, n] of [...survivors.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${id.padEnd(16)} ${n}`);
}
console.log('');
for (const line of details) console.log(`  ${line}`);

console.log('\n=== non-finite ball reports ===');
if (nanReports.length === 0) console.log('  none');
for (const report of nanReports) console.log(report);
