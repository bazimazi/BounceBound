/**
 * Enemy construction and behaviour.
 *
 * Behaviours are selected by the `ai` field of an enemy definition, so adding an
 * enemy is a data entry plus (only if it needs genuinely new motion) one case
 * here. Movement is intentionally simple and highly readable: the player must be
 * able to predict where an enemy will be at the end of a 0.6 second arc, or
 * planning a trajectory becomes guesswork rather than skill.
 */

import { Rng } from '../core/rng';
import { TAU, clamp, damp } from '../core/math';
import { tickDown } from '../core/clock';
import { circle, regularPoly, refreshPoly, type CircleShape, type PolyShape } from './geometry';
import { EnemyFlag, type Enemy, type StatusStacks } from './entities';
import type { EnemyDef } from '../content/enemies';
import type { World } from './world';

let nextEnemyId = 1;

export function resetEnemyIds(): void {
  nextEnemyId = 1;
}

function emptyStatus(): StatusStacks {
  return {
    burn: 0,
    burnTime: 0,
    frost: 0,
    frostTime: 0,
    poison: 0,
    poisonTime: 0,
    shock: 0,
    shockTime: 0,
    mark: 0,
    markTime: 0,
    charmTime: 0,
  };
}

function buildShape(def: EnemyDef, x: number, y: number, radius: number): CircleShape | PolyShape {
  switch (def.shape) {
    case 'tri':
      return regularPoly(x, y, radius * 1.15, 3, -Math.PI / 2);
    case 'quad':
      return regularPoly(x, y, radius * 1.08, 4, Math.PI / 4);
    case 'hex':
      return regularPoly(x, y, radius * 1.05, 6, 0);
    case 'diamond':
      return regularPoly(x, y, radius * 1.1, 4, 0);
    default:
      return circle(x, y, radius);
  }
}

export interface SpawnOptions {
  /** Multiplies health; used by depth scaling and Bound levels. */
  healthScale?: number;
  /** Multiplies contact damage. */
  damageScale?: number;
  generation?: number;
  parentId?: number;
  radiusScale?: number;
  vx?: number;
  vy?: number;
}

export function createEnemy(def: EnemyDef, x: number, y: number, options: SpawnOptions = {}): Enemy {
  const radius = def.radius * (options.radiusScale ?? 1);
  const hp = Math.max(1, Math.round(def.hp * (options.healthScale ?? 1) * (options.radiusScale ?? 1)));
  return {
    id: nextEnemyId++,
    defId: def.id,
    x,
    y,
    vx: options.vx ?? 0,
    vy: options.vy ?? 0,
    radius,
    shape: buildShape(def, x, y, radius),
    hp,
    maxHp: hp,
    flags: def.flags,
    state: 'idle',
    stateTime: 0,
    age: 0,
    armorAngle: def.params.faceBall ? 0 : -Math.PI / 2,
    armorArc: def.armorArc,
    contactDamage: def.contactDamage * (options.damageScale ?? 1),
    stun: 0,
    flash: 0,
    hitCooldown: 0,
    status: emptyStatus(),
    generation: options.generation ?? 0,
    scratch: { homeX: x, homeY: y, phase: 0 },
    reward: def.reward,
    dead: false,
    killedByEnvironment: false,
    phase: 0,
    parentId: options.parentId ?? 0,
  };
}

export function hasFlag(enemy: Enemy, flag: number): boolean {
  return (enemy.flags & flag) !== 0;
}

/**
 * Strain and breach.
 *
 * Defensive gating (armour plates, wards) is the point of several enemies, but an
 * enemy a player *cannot ever* get through is a softlock, not a puzzle. Balance
 * simulation confirmed this: a Platewright with its plate facing upward blocked
 * every attack from a player who only ever falls onto things.
 *
 * So blocked hits accumulate strain, and enough strain forces the defence open
 * for a few seconds. Coming from the correct angle is still far faster - that is
 * the lesson the enemy teaches - but brute persistence is now a slow, expensive
 * answer rather than no answer.
 */
const STRAIN_TO_BREACH = 3;
const BREACH_DURATION = 2.6;

/** Registers a blocked hit. Returns true when the defence has just broken open. */
export function addStrain(enemy: Enemy, amount = 1): boolean {
  if ((enemy.scratch.breach ?? 0) > 0) return false;
  enemy.scratch.strain = (enemy.scratch.strain ?? 0) + amount;
  if (enemy.scratch.strain < STRAIN_TO_BREACH) return false;
  enemy.scratch.strain = 0;
  enemy.scratch.breach = BREACH_DURATION;
  return true;
}

/** True while the enemy's armour plate or ward is intact. */
export function defencesIntact(enemy: Enemy): boolean {
  return (enemy.scratch.breach ?? 0) <= 0;
}

/** True when touching this enemy hurts the ball right now. */
export function isDangerous(enemy: Enemy, contactNx: number, contactNy: number): boolean {
  if (!hasFlag(enemy, EnemyFlag.Spiked)) return false;
  if (enemy.stun > 0 || enemy.state === 'stunned' || enemy.state === 'vulnerable') return false;
  if (enemy.contactDamage <= 0) return false;
  if (!defencesIntact(enemy)) return false;
  if (enemy.armorArc <= 0) return true;
  return withinArc(enemy, contactNx, contactNy);
}

/**
 * Whether a contact arrived inside the enemy's protected arc.
 *
 * The contact normal points from the enemy toward the ball, so comparing it to
 * the armour direction directly answers "did I hit the plated side".
 */
export function withinArc(enemy: Enemy, nx: number, ny: number): boolean {
  if (enemy.armorArc <= 0) return false;
  const contactAngle = Math.atan2(ny, nx);
  let delta = contactAngle - enemy.armorAngle;
  while (delta > Math.PI) delta -= TAU;
  while (delta < -Math.PI) delta += TAU;
  return Math.abs(delta) <= enemy.armorArc;
}

/** Keeps the enemy's collision shape aligned with its logical position. */
export function syncEnemyShape(enemy: Enemy): void {
  const shape = enemy.shape;
  shape.x = enemy.x;
  shape.y = enemy.y;
  if (shape.kind === 'poly') {
    // Armoured enemies visibly rotate their plate, so the collision polygon
    // must rotate with it or the readable silhouette would be a lie.
    if (enemy.armorArc > 0) shape.rotation = enemy.armorAngle;
    shape.dirty = true;
    refreshPoly(shape);
  } else if (shape.kind === 'circle') {
    shape.radius = enemy.radius;
  }
}

/** Frost slows enemies; shock briefly stuns. Returns the movement multiplier. */
export function statusSpeedScale(enemy: Enemy): number {
  const frost = enemy.status.frostTime > 0 ? clamp(1 - enemy.status.frost * 0.18, 0.15, 1) : 1;
  const shock = enemy.status.shockTime > 0 ? 0.55 : 1;
  return frost * shock;
}

/** Advances damage-over-time and timed statuses. Returns damage to apply. */
export function tickStatuses(enemy: Enemy, dt: number): { burn: number; poison: number } {
  const s = enemy.status;
  let burn = 0;
  let poison = 0;
  if (s.burnTime > 0) {
    s.burnTime = tickDown(s.burnTime, dt);
    burn = s.burn * dt;
    if (s.burnTime === 0) s.burn = 0;
  }
  if (s.poisonTime > 0) {
    s.poisonTime = tickDown(s.poisonTime, dt);
    poison = s.poison * dt;
    if (s.poisonTime === 0) s.poison = 0;
  }
  if (s.frostTime > 0) {
    s.frostTime = tickDown(s.frostTime, dt);
    if (s.frostTime === 0) s.frost = 0;
  }
  if (s.shockTime > 0) {
    s.shockTime = tickDown(s.shockTime, dt);
    if (s.shockTime === 0) s.shock = 0;
  }
  if (s.markTime > 0) {
    s.markTime = tickDown(s.markTime, dt);
    if (s.markTime === 0) s.mark = 0;
  }
  if (s.charmTime > 0) s.charmTime = tickDown(s.charmTime, dt);
  return { burn, poison };
}

const GRAVITY = 1650;

/**
 * Updates one enemy for a simulation step.
 *
 * `world` is passed as an interface-like dependency so behaviours can spawn
 * projectiles, thorns and children without knowing anything about the run or
 * rendering layers.
 */
export function updateEnemy(enemy: Enemy, def: EnemyDef, world: World, dt: number): void {
  enemy.age += dt;
  enemy.stateTime += dt;
  enemy.stun = tickDown(enemy.stun, dt);
  enemy.flash = Math.max(0, enemy.flash - dt * 5);
  enemy.hitCooldown = tickDown(enemy.hitCooldown, dt);
  if (enemy.stun > 0) enemy.state = 'stunned';
  else if (enemy.state === 'stunned') enemy.state = 'active';

  if ((enemy.scratch.breach ?? 0) > 0) {
    enemy.scratch.breach = Math.max(0, enemy.scratch.breach - dt);
  }

  const dot = tickStatuses(enemy, dt);
  if (dot.burn > 0) world.damageEnemy(enemy, dot.burn, 'burn', null);
  if (dot.poison > 0) world.damageEnemy(enemy, dot.poison, 'poison', null);
  if (enemy.dead) return;

  const speedScale = statusSpeedScale(enemy) * (enemy.stun > 0 ? 0 : 1);
  const ball = world.ball;
  const toBallX = ball.x - enemy.x;
  const toBallY = ball.y - enemy.y;
  const distToBall = Math.hypot(toBallX, toBallY) || 1;

  // Armour orientation. A fixed arc is a static puzzle, tracking the ball makes a
  // moving one, and facing the last wound makes a sequence puzzle. Fixed arcs are
  // used for the enemies meant to teach approach angles, because a static answer
  // is one a player can actually learn.
  if (def.params.fixedArmor !== undefined) {
    enemy.armorAngle = def.params.fixedArmor;
  } else if (def.params.faceBall) {
    const target = Math.atan2(toBallY, toBallX);
    enemy.armorAngle += shortestAngle(enemy.armorAngle, target) * Math.min(1, dt * 4.5);
  } else if (def.params.rotateToHit && enemy.scratch.targetArmor !== undefined) {
    enemy.armorAngle +=
      shortestAngle(enemy.armorAngle, enemy.scratch.targetArmor) * Math.min(1, dt * (def.params.rotateSpeed ?? 4));
  }

  switch (def.ai) {
    case 'swarm': {
      const follow = def.params.followStrength ?? 130;
      enemy.vx = damp(enemy.vx, (toBallX / distToBall) * follow, 2.2, dt);
      enemy.vy = damp(enemy.vy, (toBallY / distToBall) * follow, 2.2, dt);
      // A little per-enemy wobble keeps clusters from collapsing into one point,
      // which would remove the chain-reaction fantasy.
      const wob = enemy.id * 0.7;
      enemy.vx += Math.cos(enemy.age * 3.1 + wob) * 26 * dt * 10;
      enemy.vy += Math.sin(enemy.age * 2.7 + wob) * 26 * dt * 10;
      integrate(enemy, dt, speedScale);
      break;
    }
    case 'walker': {
      if (!hasFlag(enemy, EnemyFlag.Anchored)) {
        const dir = enemy.scratch.dir || (enemy.scratch.dir = world.rng.sign());
        enemy.vx = dir * (def.params.walkSpeed ?? 60) * speedScale;
      } else {
        enemy.vx = 0;
      }
      enemy.vy += GRAVITY * dt;
      integrate(enemy, dt, 1);
      if (world.resolveEnemyGround(enemy)) {
        enemy.vy = 0;
      } else if (!hasFlag(enemy, EnemyFlag.Anchored) && enemy.y > world.height + 80) {
        // Walked off the world: recover to spawn rather than vanish silently.
        enemy.x = enemy.scratch.homeX;
        enemy.y = enemy.scratch.homeY;
        enemy.vy = 0;
      }
      if (world.wouldLeaveLedge(enemy)) enemy.scratch.dir = -(enemy.scratch.dir || 1);
      break;
    }
    case 'charger': {
      const cooldown = def.params.cooldown ?? 2;
      if (enemy.state === 'idle' || enemy.state === 'active') {
        enemy.vx = (enemy.scratch.dir || (enemy.scratch.dir = world.rng.sign())) * (def.params.walkSpeed ?? 70) * speedScale;
        if (enemy.stateTime > cooldown && Math.abs(toBallY) < 140) {
          enemy.state = 'telegraph';
          enemy.stateTime = 0;
          enemy.scratch.chargeDir = Math.sign(toBallX) || 1;
        }
      } else if (enemy.state === 'telegraph') {
        enemy.vx = 0;
        if (enemy.stateTime > (def.params.telegraph ?? 0.6)) {
          enemy.state = 'attacking';
          enemy.stateTime = 0;
        }
      } else if (enemy.state === 'attacking') {
        enemy.vx = enemy.scratch.chargeDir * (def.params.chargeSpeed ?? 420) * speedScale;
        enemy.armorAngle = enemy.scratch.chargeDir > 0 ? 0 : Math.PI;
        if (enemy.stateTime > 0.85) {
          enemy.state = 'active';
          enemy.stateTime = 0;
        }
      }
      enemy.vy += GRAVITY * dt;
      integrate(enemy, dt, 1);
      if (world.resolveEnemyGround(enemy)) enemy.vy = 0;
      if (world.blockedHorizontally(enemy)) {
        enemy.scratch.dir = -(enemy.scratch.dir || 1);
        if (enemy.state === 'attacking') {
          enemy.state = 'active';
          enemy.stateTime = 0;
        }
      }
      break;
    }
    case 'hover': {
      const targetY = enemy.scratch.homeY - 0;
      const hoverY = targetY + Math.sin(enemy.age * 1.4 + enemy.id) * 18;
      enemy.vy = damp(enemy.vy, (hoverY - enemy.y) * 2.4, 6, dt);
      enemy.vx = damp(enemy.vx, Math.cos(enemy.age * 0.9 + enemy.id) * 55, 3, dt);
      // Dodge: Wisps and Glasslings slide away from a fast approach, which is
      // what forces a committed trajectory rather than a lazy drift.
      const dodgeRange = def.params.dodgeRange ?? 0;
      if (dodgeRange > 0 && distToBall < dodgeRange) {
        const closing = (ball.vx * toBallX + ball.vy * toBallY) / distToBall;
        if (closing > 260) {
          const strength = (def.params.dodgeStrength ?? 180) * (1 - distToBall / dodgeRange);
          enemy.vx -= (toBallX / distToBall) * strength * dt * 6;
          enemy.vy -= (toBallY / distToBall) * strength * dt * 6;
        }
      }
      if (def.params.hardenTime && enemy.scratch.harden > 0) {
        enemy.scratch.harden = Math.max(0, enemy.scratch.harden - dt);
      }
      integrate(enemy, dt, speedScale);
      break;
    }
    case 'turret': {
      enemy.vx = 0;
      enemy.vy = 0;
      enemy.armorAngle = Math.atan2(toBallY, toBallX);
      const interval = (def.params.fireInterval ?? 2) / speedScaleSafe(speedScale);
      if (enemy.state === 'idle' || enemy.state === 'active') {
        if (enemy.stateTime > interval) {
          enemy.state = 'telegraph';
          enemy.stateTime = 0;
        }
      } else if (enemy.state === 'telegraph') {
        if (enemy.stateTime > (def.params.telegraph ?? 0.5)) {
          enemy.state = 'active';
          enemy.stateTime = 0;
          const burst = Math.max(1, def.params.burst ?? 1);
          const baseAngle = Math.atan2(toBallY, toBallX);
          for (let i = 0; i < burst; i++) {
            const spread = burst > 1 ? (i - (burst - 1) / 2) * 0.22 : 0;
            world.spawnProjectile({
              kind: 'bullet',
              faction: 'hostile',
              x: enemy.x + Math.cos(baseAngle + spread) * (enemy.radius + 6),
              y: enemy.y + Math.sin(baseAngle + spread) * (enemy.radius + 6),
              vx: Math.cos(baseAngle + spread) * (def.params.bulletSpeed ?? 320),
              vy: Math.sin(baseAngle + spread) * (def.params.bulletSpeed ?? 320),
              radius: 6,
              damage: def.params.bulletDamage ?? 10,
              life: 4,
              color: def.accent,
            });
          }
        }
      }
      break;
    }
    case 'anchored': {
      const amp = def.params.hoverAmp ?? 0;
      if (amp > 0) {
        enemy.y = enemy.scratch.homeY + Math.sin(enemy.age * (def.params.hoverSpeed ?? 1)) * amp;
      }
      enemy.vx = 0;
      enemy.vy = 0;
      break;
    }
    case 'blinker': {
      const interval = def.params.blinkInterval ?? 2;
      const telegraph = def.params.telegraph ?? 0.4;
      if (enemy.state === 'telegraph') {
        if (enemy.stateTime > telegraph) {
          enemy.x = enemy.scratch.blinkX;
          enemy.y = enemy.scratch.blinkY;
          enemy.state = 'active';
          enemy.stateTime = 0;
          world.requestEffect('blink', enemy.x, enemy.y, enemy.radius * 2, 1);
        }
      } else if (enemy.stateTime > interval) {
        // Choose a destination away from the ball but inside the arena, and
        // telegraph it so the player can aim at the *future* position.
        const target = world.findBlinkTarget(enemy, def.params.blinkRange ?? 240);
        enemy.scratch.blinkX = target.x;
        enemy.scratch.blinkY = target.y;
        enemy.state = 'telegraph';
        enemy.stateTime = 0;
        world.requestEffect('blinkTarget', target.x, target.y, enemy.radius * 2, telegraph);
      }
      if (def.params.fireInterval) {
        enemy.scratch.fireTimer = (enemy.scratch.fireTimer ?? 0) + dt;
        if (enemy.scratch.fireTimer > def.params.fireInterval && enemy.state === 'active') {
          enemy.scratch.fireTimer = 0;
          const a = Math.atan2(toBallY, toBallX);
          world.spawnProjectile({
            kind: 'orb',
            faction: 'hostile',
            x: enemy.x,
            y: enemy.y,
            vx: Math.cos(a) * (def.params.bulletSpeed ?? 360),
            vy: Math.sin(a) * (def.params.bulletSpeed ?? 360),
            radius: 8,
            damage: def.params.bulletDamage ?? 12,
            life: 4,
            color: def.accent,
            homing: 0.9,
          });
        }
      }
      break;
    }
    case 'orbiter': {
      const r = def.params.orbitRadius ?? 90;
      const a = enemy.age * (def.params.orbitSpeed ?? 1.1);
      enemy.x = enemy.scratch.homeX + Math.cos(a) * r;
      enemy.y = enemy.scratch.homeY + Math.sin(a) * r;
      break;
    }
    case 'lodestone': {
      const radius = def.params.pullRadius ?? 280;
      if (distToBall < radius) {
        const falloff = 1 - distToBall / radius;
        const force = (def.params.pullForce ?? 1600) * falloff * falloff;
        world.applyBallForce((-toBallX / distToBall) * force, (-toBallY / distToBall) * force, dt);
      }
      break;
    }
    case 'mirror': {
      enemy.vx = damp(enemy.vx, Math.cos(enemy.age * 0.8 + enemy.id) * (def.params.driftSpeed ?? 48), 2, dt);
      enemy.vy = damp(enemy.vy, Math.sin(enemy.age * 0.6 + enemy.id * 1.3) * (def.params.driftSpeed ?? 48), 2, dt);
      integrate(enemy, dt, speedScale);
      break;
    }
    case 'bomber': {
      const drift = def.params.driftSpeed ?? 34;
      enemy.vx = damp(enemy.vx, (toBallX / distToBall) * drift, 1.4, dt);
      enemy.vy = damp(enemy.vy, (toBallY / distToBall) * drift, 1.4, dt);
      integrate(enemy, dt, speedScale);
      break;
    }
    case 'splitter': {
      if (def.params.spawnInterval) {
        enemy.scratch.spawnTimer = (enemy.scratch.spawnTimer ?? 0) + dt;
        // Cap the live brood. Uncapped spawning turned the Matron fight into a
        // war of attrition against the stream instead of against the Matron,
        // measured at 95 seconds in pacing runs. With a cap the correct read -
        // ignore the brood, kill the source - is also the fastest one.
        let brood = 0;
        for (const other of world.enemies) {
          if (!other.dead && other.parentId === enemy.id) brood++;
        }
        const broodCap = def.params.broodCap ?? 6;
        if (enemy.scratch.spawnTimer > def.params.spawnInterval && brood < broodCap && world.enemies.length < world.enemyBudget) {
          enemy.scratch.spawnTimer = 0;
          world.spawnEnemyById('mote', enemy.x + world.rng.range(-30, 30), enemy.y + world.rng.range(-30, 30), {
            generation: 1,
            parentId: enemy.id,
          });
        }
      }
      enemy.vy += hasFlag(enemy, EnemyFlag.Flying) ? 0 : GRAVITY * dt;
      enemy.vx = damp(enemy.vx, Math.sign(toBallX) * 44, 1.2, dt);
      integrate(enemy, dt, speedScale);
      if (!hasFlag(enemy, EnemyFlag.Flying) && world.resolveEnemyGround(enemy)) enemy.vy = 0;
      break;
    }
    case 'weaver': {
      enemy.scratch.growTimer = (enemy.scratch.growTimer ?? 0) + dt;
      if (enemy.scratch.growTimer > (def.params.growInterval ?? 3.5)) {
        enemy.scratch.growTimer = 0;
        world.growThorns(enemy, def.params.thornLife ?? 7, def.params.thornDamage ?? 10);
      }
      break;
    }
    case 'bossMirror':
    case 'bossCrusher':
    case 'bossArchitect':
    case 'bossPart':
      // Boss behaviour is driven by its own controller so that phases, arena
      // manipulation and part coordination live in one readable place.
      world.updateBoss(enemy, def, dt);
      break;
  }

  syncEnemyShape(enemy);
}

function speedScaleSafe(scale: number): number {
  return Math.max(0.2, scale);
}

function integrate(enemy: Enemy, dt: number, speedScale: number): void {
  enemy.x += enemy.vx * dt * speedScale;
  enemy.y += enemy.vy * dt * speedScale;
}

function shortestAngle(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Applies knockback, respecting the Anchored and Heavy flags. */
export function knockback(enemy: Enemy, dirX: number, dirY: number, power: number): void {
  if (hasFlag(enemy, EnemyFlag.Anchored)) return;
  const mass = hasFlag(enemy, EnemyFlag.Heavy) ? 3.2 : 1;
  enemy.vx += (dirX * power) / mass;
  enemy.vy += (dirY * power) / mass;
}

/** Records the direction a wound came from so the plate can turn to cover it. */
export function rotateArmorToward(enemy: Enemy, nx: number, ny: number): void {
  enemy.scratch.targetArmor = Math.atan2(ny, nx);
}

export function applyStatus(
  enemy: Enemy,
  kind: 'burn' | 'frost' | 'poison' | 'shock' | 'mark',
  power: number,
  duration: number,
): void {
  const s = enemy.status;
  switch (kind) {
    case 'burn':
      s.burn = Math.max(s.burn, power);
      s.burnTime = Math.max(s.burnTime, duration);
      break;
    case 'frost':
      s.frost = Math.min(6, s.frost + power);
      s.frostTime = Math.max(s.frostTime, duration);
      break;
    case 'poison':
      // Poison stacks additively: it is the one status that rewards many small
      // hits rather than one big one, which gives Swarm builds a damage outlet.
      s.poison += power;
      s.poisonTime = Math.max(s.poisonTime, duration);
      break;
    case 'shock':
      s.shock = Math.max(s.shock, power);
      s.shockTime = Math.max(s.shockTime, duration);
      break;
    case 'mark':
      s.mark = Math.max(s.mark, power);
      s.markTime = Math.max(s.markTime, duration);
      break;
  }
}

/** Utility for behaviours that need a deterministic per-enemy random. */
export function enemyRng(enemy: Enemy, salt: string): Rng {
  return new Rng(`${enemy.id}:${salt}`);
}
