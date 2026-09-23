/**
 * Ball-feel probe.
 *
 * Quantifies "how bouncy is it" so tuning is measured rather than argued about.
 * Reports, over a fixed window in a real generated room:
 *
 *   - average and peak total speed
 *   - average and peak *horizontal* speed, which is what players feel as being
 *     thrown around sideways
 *   - wall contacts per second, the direct measure of ping-ponging
 *   - how long the ball spends above a "hard to control" speed threshold
 *
 * Run with no input (coasting) and with steering held, because the two should feel
 * different: coasting should settle, steering should let you build speed.
 */

import { EventBus } from '../src/core/events';
import { Rng } from '../src/core/rng';
import { FIXED_DT } from '../src/core/clock';
import { World } from '../src/sim/world';
import { createBall, createInput } from '../src/sim/ball';
import { createBaseStats } from '../src/sim/stats';
import { generateRoom } from '../src/gen/roomgen';
import { ROOM_H, ROOM_W } from '../src/gen/templates';
import type { GameEvents } from '../src/sim/gameEvents';
import type { BiomeId } from '../src/content/ids';

const UNCONTROLLABLE = 900;

function probe(label: string, biome: BiomeId, steer: number): void {
  const stats = createBaseStats();
  const bus = new EventBus<GameEvents>();
  const world = new World({
    width: ROOM_W,
    height: ROOM_H,
    bus,
    rng: new Rng('feel'),
    stats: () => stats,
    gravityY: stats.gravity,
  });

  const room = generateRoom({
    seed: `feel-${biome}`,
    archetype: 'combat',
    biome,
    depth: 3,
    progress: 0.3,
    ballRadius: stats.radius,
    boundLevel: 0,
    unlocked: () => true,
  });
  world.addProps(room.props.map((p) => ({ ...p })));
  world.ball = createBall(room.spawnX, room.spawnY, stats);

  let wallHits = 0;
  let floorHits = 0;
  bus.on('impactResolved', (ctx) => {
    if (ctx.enemy) return;
    if (ctx.surface === 'wall') wallHits++;
    if (ctx.surface === 'floor') floorHits++;
  });

  const input = createInput();
  input.moveX = steer;

  const seconds = 30;
  const samples = seconds * 240;
  let speedSum = 0;
  let speedPeak = 0;
  let lateralSum = 0;
  let lateralPeak = 0;
  let fastSteps = 0;

  for (let i = 0; i < samples; i++) {
    world.step(FIXED_DT, input);
    const speed = Math.hypot(world.ball.vx, world.ball.vy);
    const lateral = Math.abs(world.ball.vx);
    speedSum += speed;
    lateralSum += lateral;
    speedPeak = Math.max(speedPeak, speed);
    lateralPeak = Math.max(lateralPeak, lateral);
    if (speed > UNCONTROLLABLE) fastSteps++;
  }

  console.log(
    `${label.padEnd(26)} speed avg ${(speedSum / samples).toFixed(0).padStart(4)} peak ${speedPeak
      .toFixed(0)
      .padStart(4)}  |  lateral avg ${(lateralSum / samples).toFixed(0).padStart(4)} peak ${lateralPeak
      .toFixed(0)
      .padStart(4)}  |  wall/s ${(wallHits / seconds).toFixed(2)} floor/s ${(floorHits / seconds).toFixed(
      2,
    )}  |  above ${UNCONTROLLABLE}: ${((fastSteps / samples) * 100).toFixed(0)}%`,
  );
}

console.log('coasting (no input) - should settle into something controllable:');
probe('  verdant (stone)', 'verdant', 0);
probe('  foundry (metal)', 'foundry', 0);
probe('  abyss (ice)', 'abyss', 0);

console.log('\nsteering held - should still be able to build speed:');
probe('  verdant (stone)', 'verdant', 1);
probe('  foundry (metal)', 'foundry', 1);
probe('  abyss (ice)', 'abyss', 1);
