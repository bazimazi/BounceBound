/**
 * The ball collision solver.
 *
 * This is where "bouncing is the combat system" is actually implemented. One
 * function turns a geometric contact into a gameplay event, and everything else
 * - damage, upgrades, feedback, combo, enemy rules - is expressed as a reaction
 * to that event.
 *
 * Substepping: the ball can exceed 1400 units/second while its radius is 12, so
 * a single 240 Hz step could move it nearly half a radius. Movement is therefore
 * split into substeps no longer than 40% of the radius, which makes tunnelling
 * through thin geometry impossible at any legal speed.
 *
 * One bounce per substep: only the deepest contact reflects. Remaining overlaps
 * are resolved positionally without a second reflection, because reflecting
 * twice in one substep produces the classic corner-jitter that makes physics
 * games feel unreliable.
 */

import { clamp, clamp01 } from '../core/math';
import { circleVsShape, shapeBoundRadius, shapeCenterX, shapeCenterY } from './geometry';
import { getMaterial } from './materials';
import { EnemyFlag, type Enemy, type Prop } from './entities';
import { addStrain, defencesIntact, hasFlag, isDangerous, knockback, rotateArmorToward, withinArc } from './enemyLogic';
import { propIsHarmful, propIsSolid, touchTemporary } from './propLogic';
import { getEnemyDef } from '../content/enemies';
import {
  applyImpactSquash,
  breakPerfectStreak,
  consumePerfect,
  enforceMinimumBounce,
  isDiving,
  performAirBounce,
  DIVE_BOUNCE_SCALE,
  refreshAirResources,
  tryAirDash,
  tryArmBounce,
  type Ball,
  type InputState,
} from './ball';
import {
  applyReflection,
  buildImpact,
  impactIntensity,
  impactPool,
  speedFactor,
  type ImpactContext,
  type ImpactTargetKind,
} from './impact';
import { addCombo, comboMultiplier, momentumMultiplier } from './combo';
import type { World } from './world';

/** Skin width keeps the ball a hair off the surface to avoid re-contact jitter. */
const SKIN = 0.6;
/** Maximum substeps; at legal speeds four is plenty, the cap is a safety net. */
const MAX_SUBSTEPS = 10;

interface CandidateContact {
  depth: number;
  nx: number;
  ny: number;
  px: number;
  py: number;
  prop: Prop | null;
  enemy: Enemy | null;
}

const best: CandidateContact = { depth: 0, nx: 0, ny: 0, px: 0, py: 0, prop: null, enemy: null };

export function resolveBallCollisions(world: World, dt: number, input: InputState): void {
  const ball = world.ball;
  const stats = world.currentStats;

  // One button, two meanings, disambiguated by distance to the next surface:
  // close enough to matter arms the Perfect Bounce window, far from anything
  // spends an air-bounce charge. The player only ever learns "press to bounce".
  if (input.bouncePressed) {
    const ttc = estimateTimeToImpact(world);
    const farFromSurface = ttc > Math.max(0.2, stats.perfectWindow * 1.8);
    if (farFromSurface && ball.airBounces > 0 && performAirBounce(ball, stats)) {
      world.requestEffect('airBounce', ball.x, ball.y, ball.radius * 3.2, 1);
      world.bus.emit('abilityUsed', { kind: 'airBounce', x: ball.x, y: ball.y });
    } else {
      tryArmBounce(ball, input, world.simTime);
    }
  }
  if (input.dashPressed) {
    if (tryAirDash(ball, input, stats)) {
      world.requestEffect('dash', ball.x, ball.y, ball.radius * 3, 1);
      world.bus.emit('abilityUsed', { kind: 'dash', x: ball.x, y: ball.y });
    }
  }

  ball.diving = isDiving(input);

  const speed = Math.hypot(ball.vx, ball.vy);
  const travel = speed * dt;
  const substeps = clamp(Math.ceil(travel / Math.max(2, ball.radius * 0.4)), 1, MAX_SUBSTEPS);
  const sub = dt / substeps;

  for (let s = 0; s < substeps; s++) {
    ball.x += ball.vx * sub;
    ball.y += ball.vy * sub;
    resolveArenaBounds(world, ball, stats.restitution);
    resolveOnce(world, ball, input, sub);
    if (!ball.alive) return;
  }
}

/**
 * Cheap forward look along the current velocity, used only to decide what the
 * bounce button means this instant. A short horizon keeps it inexpensive and
 * matches the player's intuition: "am I about to hit something?"
 */
function estimateTimeToImpact(world: World): number {
  const ball = world.ball;
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed < 1) return Infinity;
  const horizon = 0.3;
  const dist = speed * horizon;
  const hit = world.raycast(ball.x, ball.y, ball.vx / speed, ball.vy / speed, dist, ball.radius * 0.85);
  return hit.t >= 0 ? hit.t / speed : Infinity;
}

/** The arena is always closed; walls are implicit rather than generated props. */
function resolveArenaBounds(world: World, ball: Ball, restitution: number): void {
  const r = ball.radius;
  if (ball.x < r) {
    ball.x = r;
    if (ball.vx < 0) emitWallImpact(world, 1, 0, r, ball.y);
  } else if (ball.x > world.width - r) {
    ball.x = world.width - r;
    if (ball.vx > 0) emitWallImpact(world, -1, 0, world.width - r, ball.y);
  }
  if (ball.y < r) {
    ball.y = r;
    if (ball.vy < 0) emitWallImpact(world, 0, 1, ball.x, r);
  } else if (ball.y > world.height - r) {
    ball.y = world.height - r;
    if (ball.vy > 0) emitWallImpact(world, 0, -1, ball.x, world.height - r);
  }
  void restitution;
}

function emitWallImpact(world: World, nx: number, ny: number, px: number, py: number): void {
  // The ball has already been clamped onto the wall, so there is no penetration
  // left for the pipeline to correct.
  best.depth = 0;
  best.prop = null;
  best.enemy = null;
  const ctx = buildImpact({
    targetKind: 'surface',
    targetId: -1,
    material: world.arenaMaterial,
    px,
    py,
    nx,
    ny,
    inVx: world.ball.vx,
    inVy: world.ball.vy,
    targetVx: 0,
    targetVy: 0,
  });
  finishImpact(world, ctx, 0, 0);
}

/** Finds and resolves at most one reflecting contact, plus positional pushout. */
function resolveOnce(world: World, ball: Ball, input: InputState, dt: number): void {
  best.depth = 0;
  best.prop = null;
  best.enemy = null;

  const queryR = ball.radius + 4;
  const props = world.propGrid.queryCircle(ball.x, ball.y, queryR);

  // Non-solid triggers and harmful volumes are handled first: they never
  // reflect, so they cannot compete for the single bounce this substep.
  for (let i = 0; i < props.length; i++) {
    const prop = props[i];
    if (prop.destroyed) continue;
    if (propIsSolid(prop)) continue;
    handleTrigger(world, ball, prop, dt);
  }

  for (let i = 0; i < props.length; i++) {
    const prop = props[i];
    if (!propIsSolid(prop)) continue;
    const c = circleVsShape(ball.x, ball.y, ball.radius, prop.shape, world.contact, ball.vx, ball.vy);
    if (!c.hit) continue;
    if (c.depth > best.depth) {
      best.depth = c.depth;
      best.nx = c.nx;
      best.ny = c.ny;
      best.px = c.px;
      best.py = c.py;
      best.prop = prop;
      best.enemy = null;
    }
  }

  for (let i = 0; i < world.enemies.length; i++) {
    const enemy = world.enemies[i];
    if (enemy.dead || enemy.hitCooldown > 0) continue;
    // Broad-phase rejection before the polygon test.
    const br = shapeBoundRadius(enemy.shape) + ball.radius;
    if (Math.abs(enemy.x - ball.x) > br || Math.abs(enemy.y - ball.y) > br) continue;
    const c = circleVsShape(ball.x, ball.y, ball.radius, enemy.shape, world.contact, ball.vx, ball.vy);
    if (!c.hit) continue;
    if (c.depth > best.depth) {
      best.depth = c.depth;
      best.nx = c.nx;
      best.ny = c.ny;
      best.px = c.px;
      best.py = c.py;
      best.enemy = enemy;
      best.prop = null;
    }
  }

  if (best.prop) {
    resolvePropContact(world, ball, best.prop, dt);
  } else if (best.enemy) {
    resolveEnemyContact(world, ball, best.enemy);
  }
  void input;
}

/* --------------------------------------------------------------- triggers -- */

function handleTrigger(world: World, ball: Ball, prop: Prop, dt: number): void {
  const shape = prop.shape;
  const cx = shapeCenterX(shape);
  const cy = shapeCenterY(shape);
  const reach = shapeBoundRadius(shape) + ball.radius;
  if (Math.abs(cx - ball.x) > reach || Math.abs(cy - ball.y) > reach) return;
  const c = circleVsShape(ball.x, ball.y, ball.radius, shape, world.contact, ball.vx, ball.vy);
  if (!c.hit) return;

  switch (prop.kind) {
    case 'laser':
      if (prop.active && propIsHarmful(prop)) {
        world.damageBall(prop.contactDamage, 'hazard', prop.id, c.px, c.py);
      }
      break;
    case 'teleporter':
      if (prop.active && prop.timer <= 0) {
        prop.timer = 0.6;
        const tx = prop.params.tx ?? ball.x;
        const ty = prop.params.ty ?? ball.y;
        world.requestEffect('teleportOut', ball.x, ball.y, 60, 1);
        ball.x = tx;
        ball.y = ty;
        // Exit speed is preserved but re-aimed, so a teleporter is a routing
        // tool rather than a momentum reset.
        const speed = Math.hypot(ball.vx, ball.vy);
        const ax = prop.params.exitX ?? 0;
        const ay = prop.params.exitY ?? -1;
        const len = Math.hypot(ax, ay) || 1;
        ball.vx = (ax / len) * speed;
        ball.vy = (ay / len) * speed;
        world.requestEffect('teleportIn', tx, ty, 60, 1);
      }
      break;
    case 'slowzone': {
      const factor = Math.exp(-(prop.params.drag ?? 2.2) * dt);
      ball.vx *= factor;
      ball.vy *= factor;
      break;
    }
    case 'goal':
      // Handled by the run layer, which polls `world.cleared` and goal overlap.
      break;
    default:
      break;
  }
  if (prop.timer > 0) prop.timer = Math.max(0, prop.timer - dt);
}

/* ---------------------------------------------------------- prop contacts -- */

function resolvePropContact(world: World, ball: Ball, prop: Prop, dt: number): void {
  const material = getMaterial(prop.material);
  const ctx = buildImpact({
    targetKind: prop.hp > 0 && prop.kind === 'breakable' ? 'breakable' : prop.contactDamage > 0 ? 'hazard' : 'surface',
    targetId: prop.id,
    material: prop.material,
    px: best.px,
    py: best.py,
    nx: best.nx,
    ny: best.ny,
    inVx: ball.vx,
    inVy: ball.vy,
    targetVx: prop.velX,
    targetVy: prop.velY,
    prop,
  });

  let bounceBonus = prop.bounceBonus;

  switch (prop.kind) {
    case 'bouncepad':
      // Pads add a fixed impulse *and* extra restitution so they are useful even
      // on a slow arrival, which is what makes them reliable routing tools.
      bounceBonus += prop.params.power ?? 0.55;
      break;
    case 'launcher': {
      const power = prop.params.power ?? 1250;
      const ax = prop.params.dirX ?? 0;
      const ay = prop.params.dirY ?? -1;
      const len = Math.hypot(ax, ay) || 1;
      ctx.outVx = (ax / len) * power;
      ctx.outVy = (ay / len) * power;
      ctx.reboundTag = 'redirected';
      break;
    }
    case 'temporary':
      touchTemporary(prop);
      break;
    default:
      break;
  }

  if (propIsHarmful(prop)) {
    world.damageBall(prop.contactDamage, 'hazard', prop.id, best.px, best.py);
  }

  const damage = computeImpactDamage(world, ctx);
  ctx.damage = prop.kind === 'breakable' ? damage * material.impactScale : damage;

  finishImpact(world, ctx, bounceBonus, dt);
}

/* --------------------------------------------------------- enemy contacts -- */

function resolveEnemyContact(world: World, ball: Ball, enemy: Enemy): void {
  const def = getEnemyDef(enemy.defId);
  const ctx = buildImpact({
    targetKind: hasFlag(enemy, EnemyFlag.Boss) ? 'boss' : 'enemy',
    targetId: enemy.id,
    material: def.material,
    px: best.px,
    py: best.py,
    nx: best.nx,
    ny: best.ny,
    inVx: ball.vx,
    inVy: ball.vy,
    targetVx: enemy.vx,
    targetVy: enemy.vy,
    enemy,
  });

  let bounceBonus = 0;
  let damageScale = 1;
  let blockedReason = '';

  const defended = defencesIntact(enemy);

  // Armour: a plated contact is a hard, loud, damage-free ricochet. The bounce
  // is *stronger* than normal so the failure still reads as useful momentum.
  if (defended && hasFlag(enemy, EnemyFlag.Armored) && withinArc(enemy, best.nx, best.ny)) {
    damageScale = 0;
    bounceBonus += 0.35;
    blockedReason = 'armor';
  }

  // Ricochet gate: the ward only ignores a ball that came straight off the floor.
  if (defended && hasFlag(enemy, EnemyFlag.RicochetGated) && ball.chain < 1) {
    damageScale = 0;
    bounceBonus += 0.2;
    blockedReason = blockedReason || 'ward';
  }

  // A blocked hit is not wasted: it strains the defence, and enough strain forces
  // it open. Persistence works, but far more slowly than a correct angle.
  if (blockedReason && addStrain(enemy)) {
    world.requestEffect('breach', enemy.x, enemy.y, enemy.radius * 3.4, 1);
    ctx.effects.push('breach');
  }

  if (isDangerous(enemy, best.nx, best.ny)) {
    world.damageBall(enemy.contactDamage, 'enemy', enemy.id, best.px, best.py);
    // A spined contact still bounces the ball away, hard, so a mistake is
    // recoverable rather than a death spiral.
    bounceBonus += 0.25;
    damageScale *= 0.25;
    blockedReason = blockedReason || 'spines';
  }

  if (hasFlag(enemy, EnemyFlag.Reflector)) {
    const factor = def.params.reflectBoost ?? 1.1;
    ctx.outVx = -ball.vx * factor;
    ctx.outVy = -ball.vy * factor;
    ctx.reboundTag = 'reversed';
  }

  if (hasFlag(enemy, EnemyFlag.Heavy)) {
    // Heavy enemies absorb momentum: the ball comes off slower. Combined with
    // velocity-scaled damage this makes them a genuine momentum tax.
    bounceBonus -= def.params.absorb ?? 0.45;
  }

  if (hasFlag(enemy, EnemyFlag.Platform) || hasFlag(enemy, EnemyFlag.Springy)) {
    refreshAirResources(ball, world.currentStats);
    if (hasFlag(enemy, EnemyFlag.Springy)) bounceBonus += 0.3;
  }

  const stats = world.currentStats;
  bounceBonus += (stats.enemyBouncePower - 1) * 0.5;

  let damage = computeImpactDamage(world, ctx) * damageScale;

  // Fragile enemies are a pure precision check: fast enough shatters instantly,
  // too slow and they harden, denying the lazy repeat attempt.
  if (hasFlag(enemy, EnemyFlag.Fragile) && def.params.shatterSpeed) {
    if (ctx.relativeSpeed >= def.params.shatterSpeed) {
      damage = Math.max(damage, enemy.maxHp * 1.2);
      ctx.effects.push('shatter');
    } else if (enemy.scratch.harden > 0) {
      damage = 0;
      blockedReason = blockedReason || 'hardened';
    } else {
      enemy.scratch.harden = def.params.hardenTime ?? 1;
      damage *= 0.35;
    }
  }

  ctx.damage = damage;
  if (blockedReason) ctx.effects.push(blockedReason);

  // Plated enemies turn their plate toward the wound, forcing a new approach.
  if (def.params.rotateToHit && damageScale > 0) rotateArmorToward(enemy, best.nx, best.ny);

  enemy.hitCooldown = 0.06;
  finishImpact(world, ctx, bounceBonus, 0);
}

/* ------------------------------------------------------------ the pipeline -- */

/**
 * Base impact damage.
 *
 * `damage * speedTerm * combo * momentum`, then perfect and critical multipliers.
 * The speed term is the important one: at the reference speed it is 1.0, so all
 * tuning numbers elsewhere read naturally, while a dive into a wall ricochet can
 * push it past 2.
 */
function computeImpactDamage(world: World, ctx: ImpactContext): number {
  const stats = world.currentStats;
  const sf = clamp(speedFactor(ctx), 0, 3.2);
  const speedTerm = 0.4 + 0.6 * sf * stats.speedDamageScale;
  const combo = comboMultiplier(world.combo, stats);
  const momentum = momentumMultiplier(Math.hypot(world.ball.vx, world.ball.vy), stats);
  // Dead-on impacts are worth a little more than grazes: it gives "aim properly"
  // a mechanical payoff without punishing ricochet play.
  const incidenceTerm = 1 + 0.18 * (1 - clamp01(ctx.incidence / (Math.PI / 2)));
  return stats.damage * speedTerm * combo * momentum * incidenceTerm;
}

/**
 * Runs the shared tail of every impact: perfect/critical evaluation, the
 * `impactPre` hook, rebound application, damage application, the `impact` hook,
 * combo accounting and the `impactResolved` hook.
 */
function finishImpact(world: World, ctx: ImpactContext, bounceBonus: number, dt: number): void {
  const ball = world.ball;
  const stats = world.currentStats;
  const material = getMaterial(ctx.material);

  ctx.comboBefore = world.combo.value;
  ctx.combo = world.combo.value;
  ctx.chain = ball.chain;
  ctx.roomImpacts = ball.roomImpacts;
  ctx.timeSinceLast = world.simTime - ball.lastImpactTime;
  ctx.airTime = ball.airTime;

  const quality = consumePerfect(ball, stats, world.simTime);
  if (quality > 0) {
    ctx.isPerfect = true;
    ctx.perfectQuality = quality;
  } else if (ctx.targetKind === 'surface' || ctx.targetKind === 'hazard') {
    breakPerfectStreak(ball);
  }

  if (ctx.damage > 0) {
    ctx.isCrit = world.rng.chance(stats.critChance);
    if (ctx.isPerfect) ctx.damage *= 1 + 0.6 * ctx.perfectQuality;
    if (ctx.isCrit) ctx.damage *= stats.critMult;
  }

  world.bus.emit('impactPre', ctx);

  /* ---- rebound ---- */
  if (ctx.passThrough || ball.phase > 0) {
    ctx.reboundTag = 'phase';
    // Nudge out of the surface just enough to avoid sticking while intangible.
    ball.x += ctx.nx * 0.5;
    ball.y += ctx.ny * 0.5;
  } else {
    if (ctx.reboundTag === 'normal') {
      const restitution = material.restitution * stats.restitution + bounceBonus;
      let tangentRetention = material.tangentRetention;
      if (ctx.surface === 'wall') {
        // Wall rebounds are scaled by their own stat so Ricochet builds can
        // specialise in them without making floors feel bouncy.
        tangentRetention *= 1;
      }
      applyReflection(ctx, Math.max(0.12, restitution) * stats.momentumRetention, tangentRetention);
      if (ctx.surface === 'wall' && stats.wallBouncePower !== 1) {
        ctx.outVx *= stats.wallBouncePower;
        ctx.outVy *= stats.wallBouncePower;
      }
    }

    const minimumRebound = stats.minBounceSpeed * (ball.diving ? DIVE_BOUNCE_SCALE : 1);
    const enforced = enforceMinimumBounce(ctx.outVx, ctx.outVy, ctx.nx, ctx.ny, minimumRebound);
    ctx.outVx = enforced.vx;
    ctx.outVy = enforced.vy;

    if (ctx.isPerfect) {
      // A perfect bounce boosts the *normal* component only, so it always sends
      // the ball back out along a predictable line.
      const vn = ctx.outVx * ctx.nx + ctx.outVy * ctx.ny;
      const boost = (stats.perfectPower - 1) * (0.5 + 0.5 * ctx.perfectQuality);
      ctx.outVx += ctx.nx * vn * boost;
      ctx.outVy += ctx.ny * vn * boost;
      ctx.reboundTag = 'perfect';
      ball.iframes = Math.max(ball.iframes, 0.3 + 0.2 * ctx.perfectQuality);
    }

    // Moving geometry transfers its velocity, which is how platforms fling.
    if (ctx.prop && (ctx.prop.velX !== 0 || ctx.prop.velY !== 0)) {
      const transfer = 0.85;
      ctx.outVx += ctx.prop.velX * transfer;
      ctx.outVy += ctx.prop.velY * transfer;
    }

    ball.vx = ctx.outVx;
    ball.vy = ctx.outVy;
    // Positional correction after the velocity is final.
    ball.x += ctx.nx * (best.depth > 0 ? best.depth + SKIN : SKIN);
    ball.y += ctx.ny * (best.depth > 0 ? best.depth + SKIN : SKIN);
  }

  /* ---- damage ---- */
  if (ctx.damage > 0) {
    if (ctx.enemy) {
      ctx.damageDealt = world.damageEnemy(ctx.enemy, ctx.damage, 'impact', ctx, ctx.isCrit);
      if (ctx.enemy.dead) ctx.killed = true;
      if (!hasFlag(ctx.enemy, EnemyFlag.Anchored)) {
        const power = 120 * world.currentStats.knockback * (0.5 + speedFactor(ctx) * 0.5);
        knockback(ctx.enemy, -ctx.nx, -ctx.ny, power);
      }
    } else if (ctx.prop && ctx.prop.hp > 0) {
      ctx.prop.hp -= ctx.damage;
      ctx.prop.flash = 1;
      ctx.damageDealt = ctx.damage;
      world.bus.emit('propDamaged', { prop: ctx.prop, amount: ctx.damage });
      if (ctx.prop.hp <= 0) {
        ctx.prop.destroyed = true;
        world.stats.propsDestroyed++;
        if (ctx.prop.reward > 0) world.spawnPickup('shard', shapeCenterX(ctx.prop.shape), shapeCenterY(ctx.prop.shape), ctx.prop.reward);
        world.bus.emit('propDestroyed', { prop: ctx.prop, byBall: true });
      }
    }
  }

  /* ---- bookkeeping ---- */
  ball.lastImpactTime = world.simTime;
  ball.roomImpacts++;
  world.stats.impacts++;
  world.combo.recentImpacts++;

  if (ctx.surface === 'floor' && !ctx.enemy) {
    if (ball.chain > 0) world.bus.emit('grounded', { chain: ball.chain, airTime: ball.airTime });
    ball.chain = 0;
    ball.airTime = 0;
    ball.groundedTimer = 0.12;
    refreshAirResources(ball, stats);
  } else {
    ball.chain++;
  }

  applyImpactSquash(ball, ctx.nx, ctx.ny, impactIntensity(ctx));

  world.bus.emit('impact', ctx);

  if (!ctx.ignoreCombo) {
    /**
     * Combo tracks *combat flow*, not time spent bouncing.
     *
     * An ordinary surface bounce contributes nothing. Balance simulation showed
     * that giving surfaces even half credit let a player sit in a corner and pin
     * the meter at its cap without fighting anything, which made the multiplier a
     * baseline rather than a reward. Now the meter only moves for things that
     * take aim: hitting a target, breaking something, or landing a perfect bounce.
     */
    const isCombatContact = ctx.targetKind !== 'surface' && ctx.targetKind !== 'hazard';
    if (isCombatContact || ctx.isPerfect) {
      let gain = stats.comboGain;
      if (ctx.isPerfect) gain += 1;
      if (ctx.killed) gain += 1;
      if (ctx.enemy && hasFlag(ctx.enemy, EnemyFlag.Elite) && ctx.killed) gain += 3;
      // A perfect bounce off bare geometry is skilful but not combat, so it is
      // worth less than connecting with something.
      if (!isCombatContact) gain *= 0.6;
      const delta = addCombo(world.combo, gain, stats);
      if (delta > 0) {
        ctx.combo = world.combo.value;
        world.bus.emit('comboChanged', {
          value: world.combo.value,
          delta,
          multiplier: comboMultiplier(world.combo, stats),
          reason: ctx.targetKind,
        });
      }
    }
  }

  if (ctx.isPerfect) world.bus.emit('perfectBounce', ctx);
  world.bus.emit('impactResolved', ctx);
  impactPool.release(ctx);
  void dt;
}
