/**
 * A headless bot that plays well enough to exercise the systems.
 *
 * This exists so tests and the balance simulator can drive thousands of rooms
 * without a renderer. It is deliberately a *mediocre* player: it steers toward
 * targets, dives when high, and attempts perfect bounces with imperfect timing.
 * That makes its results a useful floor - anything it can clear, a human
 * certainly can, and anything that kills it constantly is worth looking at.
 */

import { FIXED_DT } from '../../src/core/clock';
import { createInput, type InputState } from '../../src/sim/ball';
import { defencesIntact as defended } from '../../src/sim/enemyLogic';
import type { Run } from '../../src/run/run';
import type { World } from '../../src/sim/world';

export interface BotOptions {
  /** 0 = never attempts perfect bounces, 1 = attempts with good timing. */
  skill?: number;
  /** Deterministic jitter source. */
  random?: () => number;
}

export class Bot {
  readonly input: InputState = createInput();
  private bouncePressedLast = false;
  private armCooldown = 0;
  private readonly skill: number;
  private readonly random: () => number;
  private stuckTimer = 0;
  private lastEnemyCount = -1;
  private lastProgressMarker = -1;

  constructor(options: BotOptions = {}) {
    this.skill = options.skill ?? 0.5;
    this.random = options.random ?? Math.random;
  }

  /** Produces one step of input for the given world. */
  update(world: World, dt: number): InputState {
    const input = this.input;
    const ball = world.ball;

    // Track progress. A player who has not hurt anything for a while concludes
    // something is in the way; the bot needs the same instinct or it reports
    // "unclearable" for rooms that merely require breaking a wall.
    const damageNow = world.stats.enemiesKilled + world.stats.propsDestroyed + world.stats.impacts;
    if (damageNow !== this.lastProgressMarker) {
      this.lastProgressMarker = damageNow;
    }
    const enemiesAlive = world.enemies.filter((e) => !e.dead).length;
    if (enemiesAlive !== this.lastEnemyCount) {
      this.lastEnemyCount = enemiesAlive;
      this.stuckTimer = 0;
    } else {
      this.stuckTimer += dt;
    }

    // Pick a target: nearest living enemy, else the open exit, else room centre.
    let targetX = world.width / 2;
    let targetY = world.height / 2;
    let approachOffsetY = -46;
    const blocker = this.stuckTimer > 6 ? nearestBreakable(world) : null;
    const enemy = blocker ? null : world.nearestEnemy(ball.x, ball.y, 4000);
    if (blocker) {
      targetX = blocker.x;
      targetY = blocker.y;
      approachOffsetY = 0;
    } else if (enemy) {
      targetX = enemy.x;
      targetY = enemy.y;
      // Read the armour arc and approach from outside it, which is what the
      // directional enemies exist to teach. Without this the bot dive-bombs
      // everything and reports spined enemies as unbeatable.
      if (enemy.armorArc > 0.2 && defended(enemy)) {
        const safeAngle = enemy.armorAngle + Math.PI;
        const reach = enemy.radius + 60;
        targetX = enemy.x + Math.cos(safeAngle) * reach;
        targetY = enemy.y + Math.sin(safeAngle) * reach;
        // Come in level with the flank rather than from above it.
        approachOffsetY = Math.sin(safeAngle) < -0.4 ? -30 : 0;
      }
    } else {
      const goal = world.props.find((p) => p.kind === 'goal' && p.active && !p.destroyed);
      if (goal && goal.shape.kind === 'circle') {
        targetX = goal.shape.x;
        targetY = goal.shape.y;
      }
      const chest = world.pickups.find((p) => p.active && p.kind !== 'shard');
      if (chest) {
        targetX = chest.x;
        targetY = chest.y;
      }
    }

    // Aim slightly above the target so the approach is a descent onto it: falling
    // onto something is both easier to land and harder for the target to dodge.
    const approachY = targetY + approachOffsetY;
    const dx = targetX - ball.x;
    const dy = approachY - ball.y;

    input.moveX = Math.abs(dx) < 18 ? 0 : Math.max(-1, Math.min(1, dx / 120));
    input.moveY = Math.max(-1, Math.min(1, dy / 120));
    // Commit to a dive once lined up horizontally and above the target: velocity
    // is damage, so this is the bot's main offensive decision.
    if (dy > 60 && Math.abs(dx) < 90) input.moveY = 1;

    // Escape a platform the ball is trapped bouncing on: when the target is well
    // below and almost directly underneath, drift sideways to reach an edge.
    // A human does this reflexively; the bot needs to be told.
    if (dy > 150 && Math.abs(dx) < 50) {
      input.moveX = ball.x < world.width / 2 ? 1 : -1;
      input.moveY = 1;
    }

    input.aiming = true;
    const len = Math.hypot(dx, targetY - ball.y) || 1;
    input.aimX = dx / len;
    input.aimY = (targetY - ball.y) / len;

    const ttc = world.timeToImpact();
    const stats = world.currentStats;
    this.armCooldown = Math.max(0, this.armCooldown - dt);

    let wantBounce = false;
    if (this.armCooldown <= 0) {
      if (Number.isFinite(ttc) && ttc <= Math.max(0.01, stats.perfectWindow * 0.5 + (this.random() - 0.5) * (1 - this.skill) * 0.35)) {
        // Perfect-bounce attempt, with skill-dependent timing error so the bot
        // both lands them and whiffs them.
        wantBounce = true;
        this.armCooldown = 0.32;
      } else if (ball.airBounces > 0 && ball.vy > 120 && dy < -40) {
        // Falling below the target with a charge in hand: bounce back up.
        wantBounce = true;
        this.armCooldown = 0.3;
      }
    }
    input.bouncePressed = wantBounce && !this.bouncePressedLast;
    input.bounceHeld = wantBounce;
    this.bouncePressedLast = wantBounce;

    // Brake only when speed has become genuinely uncontrollable.
    input.brakeHeld = Math.hypot(ball.vx, ball.vy) > stats.maxSpeed * 0.95;
    // Dash to close distance rather than on a timer.
    input.dashPressed = ball.airDashes > 0 && ball.dashCooldown <= 0 && Math.hypot(dx, dy) > 260 && ball.airTime > 0.5;
    return input;
  }
}

export interface PlayResult {
  steps: number;
  finished: boolean;
  victory: boolean;
  phaseChanges: number;
  error: Error | null;
}

/**
 * Drives a run to completion or until the step budget runs out, automatically
 * resolving reward, map and event phases so the whole loop is exercised.
 */
export function playRun(run: Run, options: { maxSteps?: number; bot?: Bot; pickFirst?: boolean } = {}): PlayResult {
  const maxSteps = options.maxSteps ?? 240 * 60 * 12;
  const bot = options.bot ?? new Bot({ random: mulberry(12345) });
  let steps = 0;
  let phaseChanges = 0;
  let lastPhase = run.phase;

  try {
    while (steps < maxSteps && !run.finished) {
      if (run.phase === 'playing') {
        const input = bot.update(run.world, FIXED_DT);
        run.step(FIXED_DT, input);
        run.observeHealth();
        steps++;
      } else if (run.phase === 'reward') {
        const offer = run.reward;
        if (!offer || offer.upgrades.length === 0) {
          run.skipReward();
        } else {
          run.takeUpgrade(offer.upgrades[options.pickFirst === false ? offer.upgrades.length - 1 : 0].id);
        }
      } else if (run.phase === 'event') {
        if (run.eventPrompt && !run.eventPrompt.resolved) {
          const index = run.eventPrompt.def.choices.findIndex((c) => run.canChooseEvent(c));
          run.chooseEventOption(index >= 0 ? index : 0);
        } else {
          run.closeEvent();
        }
      } else if (run.phase === 'map') {
        const choice = run.mapChoices[0];
        if (!choice) break;
        run.chooseNode(choice.id);
      } else {
        break;
      }
      if (run.phase !== lastPhase) {
        phaseChanges++;
        lastPhase = run.phase;
      }
    }
  } catch (error) {
    return { steps, finished: run.finished, victory: run.victory, phaseChanges, error: error as Error };
  }

  return { steps, finished: run.finished, victory: run.victory, phaseChanges, error: null };
}

/** The closest breakable prop, used when the bot concludes it is walled off. */
function nearestBreakable(world: World): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  for (const prop of world.props) {
    if (prop.destroyed || prop.hp <= 0) continue;
    const x = prop.shape.kind === 'segment' ? (prop.shape.x1 + prop.shape.x2) / 2 : prop.shape.x;
    const y = prop.shape.kind === 'segment' ? (prop.shape.y1 + prop.shape.y2) / 2 : prop.shape.y;
    const dist = Math.hypot(x - world.ball.x, y - world.ball.y);
    if (dist < bestDist) {
      bestDist = dist;
      best = { x, y };
    }
  }
  return best;
}

/** Small deterministic PRNG for reproducible bot jitter. */
export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
