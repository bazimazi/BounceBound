/**
 * The arena simulation.
 *
 * `World` owns one room: its geometry, enemies, projectiles, pickups and field
 * effects, plus the ball and the combo meter. It knows nothing about runs, maps,
 * upgrades or rendering. Upgrades reach into it only through the event bus and
 * the public primitives at the bottom of this file (`damageArea`, `spawnField`,
 * `spawnProjectile`, ...), which is what keeps new content from needing changes
 * here.
 *
 * Update order per fixed step is fixed and documented, because several gameplay
 * guarantees depend on it:
 *
 *   1. Props move first, so a crusher's position for this step is final before
 *      the ball is tested against it.
 *   2. The ball integrates with collision substeps and emits impacts.
 *   3. Enemies act, using the ball's new position.
 *   4. Projectiles, fields, pickups.
 *   5. Combo decay and cleanup.
 */

import { EventBus } from '../core/events';
import { Rng } from '../core/rng';
import { clamp, clamp01 } from '../core/math';
import { compact } from '../core/pool';
import { tickDown } from '../core/clock';
import {
  boxPoly,
  circleVsShape,
  makeContact,
  rayVsShape,
  shapeBoundRadius,
  shapeCenterX,
  shapeCenterY,
  type Contact,
  type Shape,
} from './geometry';
import { SpatialGrid } from './spatial';
import { EnemyFlag, type Enemy, type Field, type FieldKind, type Pickup, type PickupKind, type Projectile, type ProjectileKind, type Prop } from './entities';
import { createEnemy, hasFlag, knockback, resetEnemyIds, syncEnemyShape, updateEnemy, type SpawnOptions } from './enemyLogic';
import { propIsHarmful, propIsSolid, updateProp } from './propLogic';
import { getEnemyDef, type EnemyDef } from '../content/enemies';
import { createCombo, tickCombo, type ComboState } from './combo';
import { createBall, tickBall, applyBallForces, pushTrail, type Ball, type InputState } from './ball';
import { createBaseStats, type ResolvedStats } from './stats';
import type { MaterialId } from './materials';
import type { GameEvents, EnemyDamagePayload } from './gameEvents';
import { ORDER } from './gameEvents';
import { resolveBallCollisions } from './ballCollision';
import { updateBossBehavior } from './bossLogic';

export interface WorldOptions {
  width: number;
  height: number;
  bus: EventBus<GameEvents>;
  rng: Rng;
  /** Live stat block; re-read every step so upgrades apply immediately. */
  stats: () => ResolvedStats;
  /** Global gravity, overridden per biome and by gravity zones. */
  gravityX?: number;
  gravityY?: number;
}

let nextPropId = 1;
let nextProjectileId = 1;
let nextPickupId = 1;
let nextFieldId = 1;

export function resetWorldIds(): void {
  nextPropId = 1;
  nextProjectileId = 1;
  nextPickupId = 1;
  nextFieldId = 1;
  resetEnemyIds();
}

export interface ProjectileSpec {
  kind: ProjectileKind;
  faction: 'player' | 'hostile' | 'neutral';
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  life: number;
  color: string;
  bounces?: number;
  gravityScale?: number;
  homing?: number;
  pierce?: number;
  isBall?: boolean;
}

export class World {
  readonly width: number;
  readonly height: number;
  readonly bus: EventBus<GameEvents>;
  readonly rng: Rng;
  readonly statsFn: () => ResolvedStats;

  props: Prop[] = [];
  enemies: Enemy[] = [];
  projectiles: Projectile[] = [];
  pickups: Pickup[] = [];
  fields: Field[] = [];

  ball: Ball;
  combo: ComboState = createCombo();

  /** Material of the implicit arena walls; set per biome for sound and feel. */
  arenaMaterial: MaterialId = 'stone';

  /** Base gravity for the room, before zones. */
  gravityX: number;
  gravityY: number;
  /** Gravity actually used this step, after zone overrides. */
  activeGravityX: number;
  activeGravityY: number;

  /** Soft cap on concurrent enemies, protecting frame time and readability. */
  enemyBudget = 70;

  simTime = 0;
  roomTime = 0;
  /** True once every enemy required for clearing is dead. */
  cleared = false;
  /** Seconds since the exit opened; drives the exit's pull and reach. */
  exitOpenTime = 0;
  /** Enemies that must die to clear; boss parts are excluded. */
  requiredKills = 0;
  killsThisRoom = 0;
  damageTakenThisRoom = 0;

  /** Scratch contact record shared by the collision solver. */
  readonly contact: Contact = makeContact();
  readonly propGrid: SpatialGrid<Prop>;
  /** Rebuilt each step because enemies move. */
  readonly enemyGrid: SpatialGrid<Enemy>;

  /**
   * Slow-motion request for this step, in (0, 1]. Upgrades and bosses write the
   * lowest value they want; the game loop reads it and drives the clock. Keeping
   * it as a request rather than letting content touch the clock directly means
   * time effects compose instead of fighting.
   */
  timeScaleRequest = 1;
  /** Remaining seconds of inverted gravity, set by the Gravity Flip upgrade. */
  gravityFlipTimer = 0;
  /** Latest aim direction from input, for abilities that need a target vector. */
  lastAimX = 1;
  lastAimY = 0;

  /** Set while an effect chain is resolving, to bound recursion. */
  effectDepth = 0;
  /** Telemetry counters for the debug overlay. */
  stats = { impacts: 0, explosions: 0, arcs: 0, enemiesKilled: 0, propsDestroyed: 0 };

  /** Predicted contact point for the aiming reticle, refreshed each frame. */
  prediction = { valid: false, x: 0, y: 0, time: 0, nx: 0, ny: 0 };
  /** Sampled trajectory points for the optional preview line. */
  predictedPath: number[] = [];

  private readonly enemyDamagePayload: EnemyDamagePayload = {
    enemy: null as unknown as Enemy,
    amount: 0,
    finalAmount: 0,
    source: 'impact',
    ctx: null,
    isCrit: false,
  };

  constructor(options: WorldOptions) {
    this.width = options.width;
    this.height = options.height;
    this.bus = options.bus;
    this.rng = options.rng;
    this.statsFn = options.stats;
    this.gravityX = options.gravityX ?? 0;
    this.gravityY = options.gravityY ?? createBaseStats().gravity;
    this.activeGravityX = this.gravityX;
    this.activeGravityY = this.gravityY;
    this.propGrid = new SpatialGrid<Prop>(options.width, options.height, 112);
    this.enemyGrid = new SpatialGrid<Enemy>(options.width, options.height, 112);
    this.ball = createBall(options.width / 2, options.height / 2, options.stats());
  }

  get currentStats(): ResolvedStats {
    return this.statsFn();
  }

  /* ------------------------------------------------------------- building -- */

  addProp(prop: Omit<Prop, 'id'> & { id?: number }): Prop {
    const full: Prop = { ...prop, id: prop.id ?? nextPropId++ } as Prop;
    this.props.push(full);
    this.rebuildPropGrid();
    return full;
  }

  /** Bulk insert avoids rebuilding the grid once per prop during generation. */
  addProps(props: Array<Omit<Prop, 'id'> & { id?: number }>): Prop[] {
    const made: Prop[] = [];
    for (const p of props) {
      const full: Prop = { ...p, id: p.id ?? nextPropId++ } as Prop;
      this.props.push(full);
      made.push(full);
    }
    this.rebuildPropGrid();
    return made;
  }

  rebuildPropGrid(): void {
    this.propGrid.clear();
    for (const prop of this.props) {
      if (prop.destroyed) continue;
      const r = shapeBoundRadius(prop.shape);
      const cx = shapeCenterX(prop.shape);
      const cy = shapeCenterY(prop.shape);
      // Movers are inserted with their full travel envelope so the broad phase
      // stays valid without a rebuild every step.
      const pad = prop.motion && prop.motion.kind !== 'static' && prop.motion.kind !== 'cycle' ? this.motionPad(prop) : 0;
      this.propGrid.insert(prop, cx - r - pad, cy - r - pad, cx + r + pad, cy + r + pad);
    }
  }

  private motionPad(prop: Prop): number {
    const m = prop.motion!;
    if (m.kind === 'orbit') return m.amount;
    if (m.kind === 'spin') return 0;
    return Math.hypot(m.bx - m.ax, m.by - m.ay);
  }

  spawnEnemy(def: EnemyDef, x: number, y: number, options: SpawnOptions = {}): Enemy {
    const enemy = createEnemy(def, x, y, options);
    syncEnemyShape(enemy);
    this.enemies.push(enemy);
    if (!hasFlag(enemy, EnemyFlag.Boss) || enemy.parentId === 0) {
      if (options.generation === undefined || options.generation === 0) this.requiredKills++;
    }
    this.cleared = false;
    this.bus.emit('enemySpawned', enemy);
    return enemy;
  }

  spawnEnemyById(id: string, x: number, y: number, options: SpawnOptions = {}): Enemy {
    return this.spawnEnemy(getEnemyDef(id), x, y, options);
  }

  reset(): void {
    this.props.length = 0;
    this.enemies.length = 0;
    this.projectiles.length = 0;
    this.pickups.length = 0;
    this.fields.length = 0;
    this.propGrid.clear();
    this.roomTime = 0;
    this.cleared = false;
    this.exitOpenTime = 0;
    this.requiredKills = 0;
    this.killsThisRoom = 0;
    this.damageTakenThisRoom = 0;
    this.ball.roomImpacts = 0;
    this.ball.chain = 0;
    this.stats.impacts = 0;
  }

  /* ----------------------------------------------------------------- step -- */

  step(dt: number, input: InputState): void {
    this.simTime += dt;
    this.roomTime += dt;
    const stats = this.currentStats;
    this.timeScaleRequest = 1;
    if (input.aiming) {
      this.lastAimX = input.aimX;
      this.lastAimY = input.aimY;
    }
    if (this.gravityFlipTimer > 0) this.gravityFlipTimer = tickDown(this.gravityFlipTimer, dt);

    // 1. Geometry moves before anything is tested against it.
    for (let i = 0; i < this.props.length; i++) {
      const prop = this.props[i];
      if (!prop.destroyed) updateProp(prop, this.simTime, dt);
    }

    // Gravity zones are resolved before forces so the ball obeys the zone it is
    // in at the start of the step, which is what the player can see.
    this.resolveGravityZones();

    // 2. Ball.
    if (this.ball.alive) {
      tickBall(this.ball, stats, dt, this.simTime);
      applyBallForces(this.ball, input, stats, dt, this.activeGravityX, this.activeGravityY);
      this.applyFieldForces(dt);
      resolveBallCollisions(this, dt, input);
      pushTrail(this.ball);
      this.clampBallToArena();
    }

    // 3. Enemies.
    this.enemyGrid.clear();
    for (let i = 0; i < this.enemies.length; i++) {
      const enemy = this.enemies[i];
      if (enemy.dead) continue;
      updateEnemy(enemy, getEnemyDef(enemy.defId), this, dt);
      if (!enemy.dead) {
        // Containment first, then de-penetration: an enemy shoved back inside the
        // arena may land inside the floor slab, and that has to be resolved after.
        this.containEnemy(enemy);
        this.depenetrateEnemy(enemy, dt);
      }
      if (!enemy.dead) {
        const r = enemy.radius + 4;
        this.enemyGrid.insert(enemy, enemy.x - r, enemy.y - r, enemy.x + r, enemy.y + r);
      }
    }

    // 4. Projectiles, fields, pickups.
    this.updateProjectiles(dt);
    this.updateFields(dt);
    this.updatePickups(dt, stats);

    // 5. Combo decay and cleanup.
    const lapsed = tickCombo(this.combo, dt);
    if (lapsed > 0) this.bus.emit('comboBroken', { peak: lapsed });

    this.cleanup();
    this.checkCleared();
    this.updateExit(dt);
    this.bus.emit('tick', { dt });
  }

  /**
   * The open exit pulls the ball toward it, more strongly the longer it stays
   * open, and its collection radius grows.
   *
   * Reaching the exit is not meant to be the challenge - the room was. Without
   * this, a cleared room with the exit on a high ledge becomes a tedious
   * platforming section after the interesting part is already over, and a player
   * who cannot route upward is simply stuck. The pull is gentle enough for the
   * first few seconds that a player who wants to sweep up shards or reach a chest
   * first is never dragged away from them.
   */
  private updateExit(dt: number): void {
    if (!this.cleared) return;
    this.exitOpenTime += dt;
    const ball = this.ball;
    for (const prop of this.props) {
      if (prop.kind !== 'goal' || !prop.active || prop.destroyed) continue;
      const shape = prop.shape;
      if (shape.kind !== 'circle') continue;

      const ramp = clamp01((this.exitOpenTime - 2) / 5);
      prop.params.reach = shape.radius + ramp * 110;
      if (ramp <= 0) continue;

      const dx = shape.x - ball.x;
      const dy = shape.y - ball.y;
      const dist = Math.hypot(dx, dy) || 1;
      let fx = dx / dist;
      let fy = dy / dist;

      // A straight pull is useless when the exit is behind a pillar or a divider:
      // it just presses the ball into the obstacle. If the line to the exit is
      // blocked, bias the pull upward so the ball is lifted over the obstruction
      // rather than held against it.
      const sight = this.raycast(ball.x, ball.y, fx, fy, dist, ball.radius * 0.7);
      if (sight.t >= 0 && sight.t < dist - 6) {
        fy -= 1.3;
        const len = Math.hypot(fx, fy) || 1;
        fx /= len;
        fy /= len;
      }

      // Strong enough to beat gravity, which a pull weaker than gravity cannot do
      // when the exit is above the ball.
      const accel = Math.max(1200, Math.abs(this.gravityY) * 1.7) * ramp;
      ball.vx += fx * accel * dt;
      ball.vy += fy * accel * dt;

      /**
       * Final guarantee: after a long wait the exit comes to the player.
       *
       * Some layouts put the exit behind a breakable wall or on a high catwalk.
       * That is good level design while the room is live, but once everything is
       * dead it is only a tax on players who route badly. Rather than leave any
       * possibility of a stuck run, the exit closes the distance itself.
       */
      if (this.exitOpenTime > 9) {
        // Toward the ball: (dx, dy) points from the ball to the exit, so the exit
        // moves along the negative of it.
        const drift = 90 * dt;
        shape.x = clamp(shape.x - (dx / dist) * drift, 20, this.width - 20);
        shape.y = clamp(shape.y - (dy / dist) * drift, 20, this.height - 20);
        prop.homeX = shape.x;
        prop.homeY = shape.y;
      }
    }
  }

  private clampBallToArena(): void {
    // The arena is always fully walled by generation, but a teleporter or a
    // launcher mis-tuning should never be able to lose the ball.
    const r = this.ball.radius;
    const margin = 240;
    if (
      this.ball.x < -margin ||
      this.ball.x > this.width + margin ||
      this.ball.y < -margin ||
      this.ball.y > this.height + margin
    ) {
      this.ball.x = clamp(this.ball.x, r, this.width - r);
      this.ball.y = clamp(this.ball.y, r, this.height - r);
      this.ball.vx *= 0.4;
      this.ball.vy = Math.abs(this.ball.vy) * -0.5 - 320;
    }
  }

  private resolveGravityZones(): void {
    this.activeGravityX = this.gravityX;
    this.activeGravityY = this.gravityY;
    // A flip is weaker than normal gravity so the player still falls eventually;
    // permanent free flight would remove the bouncing entirely.
    if (this.gravityFlipTimer > 0) this.activeGravityY = -this.gravityY * 0.75;
    const candidates = this.propGrid.queryCircle(this.ball.x, this.ball.y, this.ball.radius + 8);
    for (const prop of candidates) {
      if (prop.destroyed || prop.solid || prop.kind !== 'gravityzone' || !prop.active) continue;
      if (!this.pointInProp(prop, this.ball.x, this.ball.y)) continue;
      this.activeGravityX = prop.params.gx ?? 0;
      this.activeGravityY = prop.params.gy ?? -this.gravityY * 0.4;
    }
  }

  pointInProp(prop: Prop, x: number, y: number): boolean {
    this.contact.hit = false;
    const shape = prop.shape;
    switch (shape.kind) {
      case 'aabb':
        return Math.abs(x - shape.x) <= shape.halfW && Math.abs(y - shape.y) <= shape.halfH;
      case 'circle':
        return (x - shape.x) ** 2 + (y - shape.y) ** 2 <= shape.radius ** 2;
      default:
        return false;
    }
  }

  /* --------------------------------------------------------- ball damage -- */

  damageBall(
    amount: number,
    sourceKind: 'hazard' | 'enemy' | 'projectile' | 'field' | 'curse' | 'self',
    sourceId: number,
    x: number,
    y: number,
  ): boolean {
    const ball = this.ball;
    if (!ball.alive) return false;
    if (sourceKind !== 'curse' && (ball.iframes > 0 || ball.phase > 0)) return false;

    const payload = {
      amount,
      finalAmount: amount,
      sourceKind,
      sourceId,
      x,
      y,
      blocked: false,
      blockedBy: '',
    };
    this.bus.emit('ballDamagePre', payload);
    if (payload.blocked) {
      ball.iframes = Math.max(ball.iframes, this.currentStats.iframeDuration * 0.6);
      this.bus.emit('ballDamaged', payload);
      return false;
    }

    // Shield charges soak a whole hit each: a readable, countable resource.
    if (ball.shield > 0) {
      ball.shield--;
      payload.blocked = true;
      payload.blockedBy = 'shield';
      payload.finalAmount = 0;
      ball.iframes = Math.max(ball.iframes, this.currentStats.iframeDuration);
      this.requestEffect('shieldBreak', ball.x, ball.y, ball.radius * 3.4, 1);
      this.bus.emit('ballDamaged', payload);
      return false;
    }

    const dealt = Math.max(0, payload.finalAmount);
    ball.hp -= dealt;
    this.damageTakenThisRoom += dealt;
    ball.iframes = Math.max(ball.iframes, this.currentStats.iframeDuration);
    ball.flash = 1;
    this.bus.emit('ballDamaged', payload);

    if (ball.hp <= 0) {
      if (ball.reviveCharges > 0) {
        ball.reviveCharges--;
        ball.hp = Math.max(1, Math.round(ball.maxHp * 0.4));
        ball.iframes = Math.max(ball.iframes, 1.6);
        this.bus.emit('ballRevived', { chargesLeft: ball.reviveCharges });
        this.requestEffect('revive', ball.x, ball.y, 160, 1);
      } else {
        ball.hp = 0;
        ball.alive = false;
        this.bus.emit('ballDeath', { cause: sourceKind });
      }
    }
    return true;
  }

  healBall(amount: number): void {
    if (!this.ball.alive || amount <= 0) return;
    const before = this.ball.hp;
    this.ball.hp = Math.min(this.ball.maxHp, this.ball.hp + amount);
    const healed = this.ball.hp - before;
    if (healed > 0) this.bus.emit('ballHealed', { amount: healed });
  }

  applyBallForce(fx: number, fy: number, dt: number): void {
    this.ball.vx += fx * dt;
    this.ball.vy += fy * dt;
  }

  /* -------------------------------------------------------- enemy damage -- */

  damageEnemy(
    enemy: Enemy,
    amount: number,
    source: EnemyDamagePayload['source'],
    ctx: EnemyDamagePayload['ctx'],
    isCrit = false,
  ): number {
    if (enemy.dead || amount <= 0) return 0;
    const payload = this.enemyDamagePayload;
    payload.enemy = enemy;
    payload.amount = amount;
    payload.finalAmount = amount;
    payload.source = source;
    payload.ctx = ctx;
    payload.isCrit = isCrit;
    this.bus.emit('enemyDamaged', payload);

    // Marked enemies take amplified damage; stunned enemies take a flat bonus,
    // which rewards setting up rather than mashing.
    let dealt = Math.max(0, payload.finalAmount);
    if (enemy.status.markTime > 0) dealt *= 1 + enemy.status.mark;
    if (enemy.stun > 0) dealt *= 1.25;
    if (dealt <= 0) return 0;

    enemy.hp -= dealt;
    enemy.flash = 1;
    if (enemy.hp <= 0) {
      this.killEnemy(enemy, source, ctx);
    }
    return dealt;
  }

  killEnemy(enemy: Enemy, source: EnemyDamagePayload['source'], ctx: EnemyDamagePayload['ctx']): void {
    if (enemy.dead) return;
    enemy.dead = true;
    enemy.hp = 0;
    enemy.state = 'dying';
    enemy.killedByEnvironment = source === 'environment' || source === 'field';
    this.stats.enemiesKilled++;
    if (enemy.generation === 0 && !hasFlag(enemy, EnemyFlag.Boss)) this.killsThisRoom++;

    const def = getEnemyDef(enemy.defId);

    // On-death behaviours are part of the enemy's collision identity, so they
    // resolve before listeners see the kill and can chain further.
    if (hasFlag(enemy, EnemyFlag.Explosive)) {
      this.explode(
        enemy.x,
        enemy.y,
        def.params.blastRadius ?? 110,
        def.params.blastDamage ?? 30,
        ctx,
        'environment',
        enemy.id,
      );
    }
    if (hasFlag(enemy, EnemyFlag.Splitter) && enemy.generation < 2 && this.enemies.length < this.enemyBudget) {
      // An enemy splits into itself unless it names a different child, which is how
      // a spawner is prevented from duplicating its own spawning behaviour.
      const childDef = def.splitsInto ? getEnemyDef(def.splitsInto) : def;
      const splits = Math.max(2, def.params.splits ?? 2);
      const spread = def.params.spread ?? 200;
      for (let i = 0; i < splits; i++) {
        const a = (i / splits) * Math.PI * 2 + this.rng.range(0, 1);
        this.spawnEnemy(childDef, enemy.x + Math.cos(a) * 14, enemy.y + Math.sin(a) * 14, {
          generation: enemy.generation + 1,
          parentId: enemy.id,
          radiusScale: (def.params.childScale ?? 0.6) ** (enemy.generation + 1),
          healthScale: 0.34,
          vx: Math.cos(a) * spread,
          vy: Math.sin(a) * spread - 60,
        });
      }
    }

    this.spawnPickup('shard', enemy.x, enemy.y, enemy.reward);
    this.bus.emit('enemyKilled', { enemy, ctx, source, x: enemy.x, y: enemy.y });
    if (hasFlag(enemy, EnemyFlag.Boss) && enemy.parentId === 0) {
      this.bus.emit('bossDefeated', { defId: enemy.defId });
    }
  }

  /* ------------------------------------------------------------ primitives -- */

  /**
   * Radial damage with linear falloff. This is the single primitive behind
   * explosions, shockwaves, singularities and boss slams, so every one of those
   * shares the same readable behaviour.
   */
  damageArea(
    x: number,
    y: number,
    radius: number,
    damage: number,
    source: EnemyDamagePayload['source'],
    ctx: EnemyDamagePayload['ctx'],
    options: { excludeId?: number; knockbackPower?: number; falloff?: boolean; hurtsBall?: boolean } = {},
  ): number {
    let hits = 0;
    const list = this.enemyGrid.queryCircle(x, y, radius + 40);
    const candidates = list.length > 0 ? list : this.enemies;
    for (const enemy of candidates) {
      if (enemy.dead || enemy.id === options.excludeId) continue;
      const dist = Math.hypot(enemy.x - x, enemy.y - y);
      if (dist > radius + enemy.radius) continue;
      const scale = options.falloff === false ? 1 : 1 - clamp01((dist - enemy.radius) / Math.max(1, radius));
      const dealt = this.damageEnemy(enemy, damage * Math.max(0.25, scale), source, ctx);
      if (dealt > 0) hits++;
      if (options.knockbackPower) {
        const len = dist || 1;
        knockback(enemy, (enemy.x - x) / len, (enemy.y - y) / len, options.knockbackPower * Math.max(0.3, scale));
      }
    }
    if (options.hurtsBall) {
      const d = Math.hypot(this.ball.x - x, this.ball.y - y);
      if (d < radius) this.damageBall(damage * 0.4, 'field', options.excludeId ?? 0, x, y);
    }
    return hits;
  }

  /** Explosion = area damage + knockback + a visual/audio request. */
  explode(
    x: number,
    y: number,
    radius: number,
    damage: number,
    ctx: EnemyDamagePayload['ctx'],
    source: EnemyDamagePayload['source'] = 'explosion',
    excludeId?: number,
    hurtsBall = false,
  ): number {
    if (this.effectDepth > 6) return 0;
    this.effectDepth++;
    this.stats.explosions++;
    this.requestEffect('explosion', x, y, radius, 1);
    const hits = this.damageArea(x, y, radius, damage, source, ctx, {
      excludeId,
      knockbackPower: 260,
      hurtsBall,
    });
    this.effectDepth--;
    return hits;
  }

  /**
   * Chains damage between nearby enemies.
   *
   * Written as a primitive rather than a Lightning-upgrade special case, because
   * three separate upgrade families and one boss all want "jump between targets"
   * with different numbers.
   */
  arcChain(
    fromX: number,
    fromY: number,
    jumps: number,
    damage: number,
    range: number,
    ctx: EnemyDamagePayload['ctx'],
    firstTargetId?: number,
  ): number {
    if (this.effectDepth > 6) return 0;
    this.effectDepth++;
    this.stats.arcs++;
    const visited = new Set<number>();
    if (firstTargetId !== undefined) visited.add(firstTargetId);
    let x = fromX;
    let y = fromY;
    let hit = 0;
    for (let i = 0; i < jumps; i++) {
      const target = this.nearestEnemy(x, y, range, visited);
      if (!target) break;
      visited.add(target.id);
      this.requestEffect('arc', x, y, 0, 1, target.x, target.y);
      // Later jumps are weaker so a long chain is valuable but not infinite.
      this.damageEnemy(target, damage * (1 - i * 0.08), 'lightning', ctx);
      x = target.x;
      y = target.y;
      hit++;
    }
    this.effectDepth--;
    return hit;
  }

  nearestEnemy(x: number, y: number, maxDist: number, exclude?: Set<number>): Enemy | null {
    let best: Enemy | null = null;
    let bestDist = maxDist;
    const list = this.enemyGrid.queryCircle(x, y, maxDist);
    const candidates = list.length > 0 ? list : this.enemies;
    for (const enemy of candidates) {
      if (enemy.dead) continue;
      if (exclude && exclude.has(enemy.id)) continue;
      const dist = Math.hypot(enemy.x - x, enemy.y - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = enemy;
      }
    }
    return best;
  }

  enemiesInRadius(x: number, y: number, radius: number): Enemy[] {
    const out: Enemy[] = [];
    const list = this.enemyGrid.queryCircle(x, y, radius);
    const candidates = list.length > 0 ? list : this.enemies;
    for (const enemy of candidates) {
      if (enemy.dead) continue;
      if (Math.hypot(enemy.x - x, enemy.y - y) <= radius + enemy.radius) out.push(enemy);
    }
    return out;
  }

  spawnField(kind: FieldKind, x: number, y: number, radius: number, life: number, power: number, force = 0): Field {
    const field: Field = {
      id: nextFieldId++,
      kind,
      x,
      y,
      radius,
      life,
      maxLife: life,
      power,
      faction: kind === 'heal' ? 'player' : 'neutral',
      active: true,
      force,
      tickTimer: 0,
    };
    this.fields.push(field);
    this.bus.emit('fieldCreated', field);
    return field;
  }

  spawnProjectile(spec: ProjectileSpec): Projectile {
    const projectile: Projectile = {
      id: nextProjectileId++,
      kind: spec.kind,
      faction: spec.faction,
      x: spec.x,
      y: spec.y,
      vx: spec.vx,
      vy: spec.vy,
      radius: spec.radius,
      damage: spec.damage,
      life: spec.life,
      maxLife: spec.life,
      bounces: spec.bounces ?? -1,
      gravityScale: spec.gravityScale ?? 0,
      homing: spec.homing ?? 0,
      pierce: spec.pierce ?? 0,
      color: spec.color,
      active: true,
      isBall: spec.isBall ?? false,
      hitIds: [],
      scratch: {},
    };
    this.projectiles.push(projectile);
    this.bus.emit('projectileSpawned', projectile);
    return projectile;
  }

  spawnPickup(kind: PickupKind, x: number, y: number, value: number, payload = '', armTime = 0): Pickup | null {
    if (value <= 0 && kind === 'shard') return null;
    const pickup: Pickup = {
      id: nextPickupId++,
      kind,
      x,
      y,
      vx: this.rng.range(-70, 70),
      vy: this.rng.range(-180, -60),
      radius: kind === 'shard' ? 7 : 11,
      value,
      // Interactables must not expire: a shop the player is saving for has to
      // still be there when they can afford it.
      life: kind === 'shard' || kind === 'heal' ? 26 : 1e9,
      attract: 0,
      armTime,
      active: true,
      payload,
    };
    this.pickups.push(pickup);
    this.bus.emit('pickupSpawned', pickup);
    return pickup;
  }

  /** Fire-and-forget visual/audio request; the FX layer subscribes. */
  requestEffect(kind: string, x: number, y: number, radius: number, power: number, x2?: number, y2?: number): void {
    this.bus.emit('effectRequested', {
      kind,
      x,
      y,
      radius,
      power,
      ctx: null,
      depth: this.effectDepth,
      x2,
      y2,
    });
  }

  /* ------------------------------------------------------- sub-systems --- */

  private updateProjectiles(dt: number): void {
    const ball = this.ball;
    for (let i = 0; i < this.projectiles.length; i++) {
      const p = this.projectiles[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      if (p.gravityScale !== 0) p.vy += this.activeGravityY * p.gravityScale * dt;
      if (p.homing > 0) {
        const targetX = p.faction === 'hostile' ? ball.x : 0;
        const targetY = p.faction === 'hostile' ? ball.y : 0;
        let tx = targetX;
        let ty = targetY;
        if (p.faction !== 'hostile') {
          const target = this.nearestEnemy(p.x, p.y, 420);
          if (!target) {
            tx = p.x + p.vx;
            ty = p.y + p.vy;
          } else {
            tx = target.x;
            ty = target.y;
          }
        }
        const speed = Math.hypot(p.vx, p.vy) || 1;
        const desiredAngle = Math.atan2(ty - p.y, tx - p.x);
        const currentAngle = Math.atan2(p.vy, p.vx);
        let delta = desiredAngle - currentAngle;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        const turn = clamp(delta, -p.homing * dt, p.homing * dt);
        const a = currentAngle + turn;
        p.vx = Math.cos(a) * speed;
        p.vy = Math.sin(a) * speed;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Walls.
      if (p.x < 0 || p.x > this.width || p.y < 0 || p.y > this.height) {
        if (p.bounces > 0) {
          p.bounces--;
          if (p.x < 0 || p.x > this.width) p.vx *= -1;
          if (p.y < 0 || p.y > this.height) p.vy *= -1;
          p.x = clamp(p.x, 2, this.width - 2);
          p.y = clamp(p.y, 2, this.height - 2);
        } else {
          p.active = false;
          continue;
        }
      }

      if (p.faction === 'hostile') {
        const d = Math.hypot(p.x - ball.x, p.y - ball.y);
        if (d < p.radius + ball.radius) {
          if (this.damageBall(p.damage, 'projectile', p.id, p.x, p.y)) {
            this.requestEffect('projectileHit', p.x, p.y, p.radius * 3, 1);
          }
          p.active = false;
        }
      } else {
        const list = this.enemyGrid.queryCircle(p.x, p.y, p.radius + 30);
        const candidates = list.length > 0 ? list : this.enemies;
        for (const enemy of candidates) {
          if (enemy.dead || p.hitIds.includes(enemy.id)) continue;
          if (Math.hypot(enemy.x - p.x, enemy.y - p.y) > p.radius + enemy.radius) continue;
          this.damageEnemy(enemy, p.damage, 'projectile', null);
          p.hitIds.push(enemy.id);
          this.requestEffect('projectileHit', p.x, p.y, p.radius * 3, 1);
          if (p.pierce > 0) {
            p.pierce--;
          } else {
            p.active = false;
          }
          break;
        }
      }
    }
  }

  private updateFields(dt: number): void {
    for (let i = 0; i < this.fields.length; i++) {
      const field = this.fields[i];
      if (!field.active) continue;
      field.life -= dt;
      if (field.life <= 0) {
        field.active = false;
        continue;
      }
      field.tickTimer -= dt;
      if (field.tickTimer <= 0) {
        field.tickTimer = 0.25;
        switch (field.kind) {
          case 'fire':
            this.damageArea(field.x, field.y, field.radius, field.power * 0.25, 'field', null, { falloff: false });
            break;
          case 'shock':
            this.damageArea(field.x, field.y, field.radius, field.power * 0.2, 'field', null, { falloff: false });
            break;
          case 'void':
          case 'singularity':
            this.damageArea(field.x, field.y, field.radius, field.power * 0.3, 'field', null, {
              knockbackPower: -180,
            });
            break;
          case 'frost':
            for (const enemy of this.enemiesInRadius(field.x, field.y, field.radius)) {
              enemy.status.frost = Math.min(6, enemy.status.frost + 1);
              enemy.status.frostTime = Math.max(enemy.status.frostTime, 1.2);
            }
            break;
          case 'heal':
            if (Math.hypot(this.ball.x - field.x, this.ball.y - field.y) < field.radius) {
              this.healBall(field.power * 0.25);
            }
            break;
          case 'trail':
            this.damageArea(field.x, field.y, field.radius, field.power * 0.25, 'field', null, { falloff: false });
            break;
        }
      }
    }
  }

  private applyFieldForces(dt: number): void {
    for (const field of this.fields) {
      if (!field.active || field.force === 0) continue;
      const dx = field.x - this.ball.x;
      const dy = field.y - this.ball.y;
      const dist = Math.hypot(dx, dy);
      if (dist > field.radius * 2.4 || dist < 1) continue;
      const falloff = 1 - clamp01(dist / (field.radius * 2.4));
      const force = field.force * falloff * falloff;
      this.ball.vx += (dx / dist) * force * dt;
      this.ball.vy += (dy / dist) * force * dt;
    }
  }

  private updatePickups(dt: number, stats: ResolvedStats): void {
    const ball = this.ball;
    for (let i = 0; i < this.pickups.length; i++) {
      const pickup = this.pickups[i];
      if (!pickup.active) continue;
      pickup.life -= dt;
      if (pickup.life <= 0) {
        pickup.active = false;
        continue;
      }
      if (pickup.armTime > 0) pickup.armTime = Math.max(0, pickup.armTime - dt);
      const dx = ball.x - pickup.x;
      const dy = ball.y - pickup.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist < stats.magnetRadius) {
        // Attraction ramps up so collection reads as a sweep rather than a snap.
        pickup.attract = Math.min(1, pickup.attract + dt * 3.4);
        const pull = 900 * pickup.attract;
        pickup.vx += (dx / dist) * pull * dt;
        pickup.vy += (dy / dist) * pull * dt;
      } else {
        pickup.vy += 620 * dt;
        pickup.vx *= 1 - 1.4 * dt;
      }
      pickup.x += pickup.vx * dt;
      pickup.y += pickup.vy * dt;
      if (pickup.y > this.height - pickup.radius) {
        pickup.y = this.height - pickup.radius;
        pickup.vy *= -0.32;
        pickup.vx *= 0.8;
      }
      pickup.x = clamp(pickup.x, pickup.radius, this.width - pickup.radius);

      if (pickup.armTime <= 0 && dist < ball.radius + pickup.radius + 4) {
        pickup.active = false;
        this.bus.emit('pickupCollected', {
          kind: pickup.kind,
          value: pickup.value,
          x: pickup.x,
          y: pickup.y,
          payload: pickup.payload,
        });
      }
    }
  }

  private cleanup(): void {
    compact(this.projectiles, (p) => p.active);
    compact(this.pickups, (p) => p.active);
    compact(this.fields, (f) => f.active);
    // Dead enemies linger one step so kill listeners can read their position.
    compact(this.enemies, (e) => !e.dead);
    let needGridRebuild = false;
    compact(this.props, (p) => {
      if (p.destroyed) {
        needGridRebuild = true;
        return false;
      }
      return true;
    });
    if (needGridRebuild) this.rebuildPropGrid();
  }

  private checkCleared(): void {
    if (this.cleared) return;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      if (hasFlag(enemy, EnemyFlag.Boss) && enemy.parentId !== 0) continue;
      return;
    }
    this.cleared = true;
    for (const prop of this.props) {
      if (prop.kind === 'goal') prop.active = true;
    }
  }

  /* ---------------------------------------------- helpers for enemy logic -- */

  /**
   * Keeps an enemy inside the arena.
   *
   * Flying enemies steer toward the ball with no boundary of their own, so any
   * sustained sideways push - drifting, avoidance steering, knockback - eventually
   * carries them out of the room, where they are permanently unreachable and the
   * room can never be cleared. Soak runs found Motes thousands of units outside a
   * 1152x648 arena. Walkers were incidentally contained by ground resolution;
   * flyers had nothing.
   *
   * The bounce-back is damped rather than elastic so an enemy pressed into a corner
   * settles instead of vibrating.
   */
  containEnemy(enemy: Enemy): void {
    const margin = enemy.radius;
    if (enemy.x < margin) {
      enemy.x = margin;
      enemy.vx = Math.abs(enemy.vx) * 0.4;
    } else if (enemy.x > this.width - margin) {
      enemy.x = this.width - margin;
      enemy.vx = -Math.abs(enemy.vx) * 0.4;
    }
    if (enemy.y < margin) {
      enemy.y = margin;
      enemy.vy = Math.abs(enemy.vy) * 0.4;
    } else if (enemy.y > this.height - margin) {
      enemy.y = this.height - margin;
      enemy.vy = -Math.abs(enemy.vy) * 0.4;
    }
  }

  /**
   * Pushes an enemy out of any solid geometry it is overlapping.
   *
   * Necessary because enemies can end up inside props by several routes: a
   * splitter's children are thrown outward with velocity, knockback can shove one
   * into a wall, and a hazard can grow underneath one. An enemy embedded in a
   * solid prop is *unreachable* - the ball collides with the prop first - which
   * means the room can never be cleared. Balance runs found exactly this, with a
   * splitter fragment buried inside a bounce pad.
   */
  depenetrateEnemy(enemy: Enemy, dt = 0): void {
    const candidates = this.propGrid.queryCircle(enemy.x, enemy.y, enemy.radius + 6);
    let pushX = 0;
    let pushY = 0;
    let overlapping = false;

    /**
     * Pushes from every overlapping prop are accumulated and applied once.
     *
     * Resolving them one at a time lets the last push undo the first: an enemy
     * wedged where a pillar meets the floor gets ejected down out of the pillar,
     * then up out of the floor, back into the pillar, forever. Soak runs found
     * exactly that oscillation, leaving the enemy permanently inside geometry and
     * the room unclearable.
     */
    for (const prop of candidates) {
      if (!propIsSolid(prop)) continue;
      const contact = circleVsShape(enemy.x, enemy.y, enemy.radius, prop.shape, this.contact);
      if (!contact.hit || contact.depth <= 0) continue;
      overlapping = true;
      const push = contact.depth + 0.5;
      let nx = contact.nx;
      let ny = contact.ny;
      // Interior contacts eject along the shallowest axis, which for something
      // buried in the floor slab points downward - straight out of the arena. If
      // the chosen direction would leave the room, take the opposite one.
      if (
        enemy.x + nx * push < enemy.radius ||
        enemy.x + nx * push > this.width - enemy.radius ||
        enemy.y + ny * push < enemy.radius ||
        enemy.y + ny * push > this.height - enemy.radius
      ) {
        nx = -nx;
        ny = -ny;
      }
      pushX += nx * push;
      pushY += ny * push;
    }

    if (!overlapping) {
      enemy.scratch.wedged = 0;
      return;
    }

    enemy.x = clamp(enemy.x + pushX, enemy.radius, this.width - enemy.radius);
    enemy.y = clamp(enemy.y + pushY, enemy.radius, this.height - enemy.radius);
    syncEnemyShape(enemy);

    // Last resort: still stuck after half a second of pushing, so search outward
    // for genuinely open space. This is invisible in play and guarantees that no
    // enemy can ever be permanently unreachable.
    enemy.scratch.wedged = (enemy.scratch.wedged ?? 0) + dt;
    if (enemy.scratch.wedged > 0.5) {
      enemy.scratch.wedged = 0;
      const spot = this.findOpenSpot(enemy.x, enemy.y, enemy.radius);
      if (spot) {
        enemy.x = spot.x;
        enemy.y = spot.y;
        enemy.vx = 0;
        enemy.vy = 0;
        syncEnemyShape(enemy);
      }
    }
  }

  /** Spiral search for a position where a circle of `radius` fits in free space. */
  findOpenSpot(x: number, y: number, radius: number): { x: number; y: number } | null {
    for (let ring = 1; ring <= 8; ring++) {
      const distance = ring * (radius + 8);
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        const px = clamp(x + Math.cos(angle) * distance, radius, this.width - radius);
        const py = clamp(y + Math.sin(angle) * distance, radius, this.height - radius);
        if (!this.overlapsSolid(px, py, radius)) return { x: px, y: py };
      }
    }
    return null;
  }

  /** Simple ground resolution so walkers stand on platforms. */
  resolveEnemyGround(enemy: Enemy): boolean {
    let landed = false;
    const candidates = this.propGrid.queryCircle(enemy.x, enemy.y, enemy.radius + 8);
    for (const prop of candidates) {
      if (!propIsSolid(prop)) continue;
      const shape = prop.shape;
      if (shape.kind !== 'aabb' && shape.kind !== 'segment') continue;
      const top = shape.kind === 'aabb' ? shape.y - shape.halfH : Math.min(shape.y1, shape.y2);
      const left = shape.kind === 'aabb' ? shape.x - shape.halfW : Math.min(shape.x1, shape.x2);
      const right = shape.kind === 'aabb' ? shape.x + shape.halfW : Math.max(shape.x1, shape.x2);
      if (enemy.x < left - enemy.radius || enemy.x > right + enemy.radius) continue;
      const feet = enemy.y + enemy.radius;
      if (feet >= top && feet <= top + Math.max(18, Math.abs(enemy.vy) * 0.02 + 12)) {
        enemy.y = top - enemy.radius;
        landed = true;
      }
    }
    if (enemy.y + enemy.radius >= this.height) {
      enemy.y = this.height - enemy.radius;
      landed = true;
    }
    return landed;
  }

  /**
   * Obstacle avoidance for flying enemies.
   *
   * Flyers steer straight at the ball, which means a pillar between them and the
   * player traps them: they push into the face, de-penetration pushes them back,
   * and they hover there permanently out of reach. Soak runs found whole clusters
   * of Motes pinned to one side of a pillar with the ball on the other.
   *
   * When the direct line is blocked, the desired direction is blended toward the
   * wall's tangent so the flyer slides along it and around the obstacle. The chosen
   * side is fixed per enemy so a group does not oscillate as one.
   */
  steerAroundObstacle(enemy: Enemy, dirX: number, dirY: number, probe = 110): { x: number; y: number } {
    /**
     * Throttled: the raycast runs a few times a second per enemy, not on every one
     * of the 240 simulation steps. Casting per enemy per step is O(enemies x
     * geometry) at 240 Hz, which measurably dominated the frame in crowded rooms -
     * a soak run that took fourteen seconds took six minutes. The obstacle is not
     * moving fast enough for the difference to be visible.
     */
    const now = this.simTime;
    if ((enemy.scratch.avoidUntil ?? 0) > now) {
      const cachedX = enemy.scratch.avoidX;
      const cachedY = enemy.scratch.avoidY;
      if (cachedX !== undefined && cachedY !== undefined) return { x: cachedX, y: cachedY };
    }
    // Stagger recomputation across enemies so a swarm does not all cast on the
    // same step.
    enemy.scratch.avoidUntil = now + 0.1 + (enemy.id % 7) * 0.01;

    let outX = dirX;
    let outY = dirY;
    const hit = this.raycast(enemy.x, enemy.y, dirX, dirY, probe, enemy.radius * 0.9, false);
    if (hit.t >= 0) {
      // Perpendicular to the blocked direction, on this enemy's preferred side.
      const side = enemy.id % 2 === 0 ? 1 : -1;
      const tangentX = -dirY * side;
      const tangentY = dirX * side;
      // The closer the obstacle, the more the tangent dominates.
      const urgency = 1 - clamp01(hit.t / probe);
      const blend = 0.35 + urgency * 0.65;
      const x = dirX * (1 - blend) + tangentX * blend;
      const y = dirY * (1 - blend) + tangentY * blend;
      const len = Math.hypot(x, y) || 1;
      outX = x / len;
      outY = y / len;
    }
    enemy.scratch.avoidX = outX;
    enemy.scratch.avoidY = outY;
    return { x: outX, y: outY };
  }

  /** Ledge check so walkers turn around instead of walking into a pit. */
  wouldLeaveLedge(enemy: Enemy): boolean {
    const dir = enemy.scratch.dir || 1;
    const probeX = enemy.x + dir * (enemy.radius + 10);
    if (probeX < enemy.radius + 4 || probeX > this.width - enemy.radius - 4) return true;
    const probeY = enemy.y + enemy.radius + 12;
    if (probeY >= this.height) return false;
    const candidates = this.propGrid.queryCircle(probeX, probeY, 14);
    for (const prop of candidates) {
      if (!propIsSolid(prop)) continue;
      if (propIsHarmful(prop)) return true;
      const shape = prop.shape;
      if (shape.kind === 'aabb') {
        if (
          probeX >= shape.x - shape.halfW - 2 &&
          probeX <= shape.x + shape.halfW + 2 &&
          probeY >= shape.y - shape.halfH - 6 &&
          probeY <= shape.y + shape.halfH
        ) {
          return false;
        }
      } else if (shape.kind === 'segment') {
        const minX = Math.min(shape.x1, shape.x2) - 2;
        const maxX = Math.max(shape.x1, shape.x2) + 2;
        const yAt = (shape.y1 + shape.y2) / 2;
        if (probeX >= minX && probeX <= maxX && Math.abs(probeY - yAt) < 16) return false;
      }
    }
    return true;
  }

  blockedHorizontally(enemy: Enemy): boolean {
    const dir = Math.sign(enemy.vx) || 1;
    const probeX = enemy.x + dir * (enemy.radius + 4);
    if (probeX < enemy.radius || probeX > this.width - enemy.radius) return true;
    const candidates = this.propGrid.queryCircle(probeX, enemy.y, enemy.radius);
    for (const prop of candidates) {
      if (!propIsSolid(prop)) continue;
      const shape = prop.shape;
      if (shape.kind !== 'aabb') continue;
      if (
        probeX >= shape.x - shape.halfW &&
        probeX <= shape.x + shape.halfW &&
        enemy.y >= shape.y - shape.halfH - enemy.radius * 0.5 &&
        enemy.y <= shape.y + shape.halfH
      ) {
        return true;
      }
    }
    return false;
  }

  /** Picks a teleport destination that is inside the arena and away from the ball. */
  findBlinkTarget(enemy: Enemy, range: number): { x: number; y: number } {
    let bestX = enemy.x;
    let bestY = enemy.y;
    let bestScore = -Infinity;
    for (let i = 0; i < 8; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const d = this.rng.range(range * 0.45, range);
      const x = clamp(enemy.x + Math.cos(a) * d, enemy.radius + 24, this.width - enemy.radius - 24);
      const y = clamp(enemy.y + Math.sin(a) * d, enemy.radius + 24, this.height * 0.8);
      if (this.overlapsSolid(x, y, enemy.radius + 4)) continue;
      // Prefer distance from the ball, but not so far that the fight stalls.
      const distToBall = Math.hypot(x - this.ball.x, y - this.ball.y);
      const score = Math.min(distToBall, 420) - Math.abs(distToBall - 300) * 0.4;
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
    return { x: bestX, y: bestY };
  }

  overlapsSolid(x: number, y: number, radius: number): boolean {
    const candidates = this.propGrid.queryCircle(x, y, radius);
    for (const prop of candidates) {
      if (!propIsSolid(prop)) continue;
      const r = shapeBoundRadius(prop.shape);
      const cx = shapeCenterX(prop.shape);
      const cy = shapeCenterY(prop.shape);
      if (Math.hypot(cx - x, cy - y) > r + radius + 2) continue;
      if (this.narrowOverlap(x, y, radius, prop.shape)) return true;
    }
    return false;
  }

  private narrowOverlap(x: number, y: number, radius: number, shape: Shape): boolean {
    switch (shape.kind) {
      case 'aabb': {
        const dx = Math.max(Math.abs(x - shape.x) - shape.halfW, 0);
        const dy = Math.max(Math.abs(y - shape.y) - shape.halfH, 0);
        return dx * dx + dy * dy < radius * radius;
      }
      case 'circle':
        return Math.hypot(x - shape.x, y - shape.y) < radius + shape.radius;
      default:
        return Math.hypot(shapeCenterX(shape) - x, shapeCenterY(shape) - y) < radius + shapeBoundRadius(shape) * 0.7;
    }
  }

  /** Thornweaver support: grows a temporary spiked wall near the weaver. */
  growThorns(enemy: Enemy, life: number, damage: number): void {
    const angle = this.rng.range(0, Math.PI * 2);
    const dist = this.rng.range(90, 190);
    const x = clamp(enemy.x + Math.cos(angle) * dist, 60, this.width - 60);
    const y = clamp(enemy.y + Math.sin(angle) * dist, 60, this.height - 60);
    if (this.overlapsSolid(x, y, 30)) return;
    const vertical = this.rng.chance(0.5);
    this.addProp({
      kind: 'spike',
      shape: boxPoly(x, y, vertical ? 9 : 52, vertical ? 52 : 9, 0),
      material: 'moss',
      solid: true,
      bounceBonus: 0,
      contactDamage: damage,
      hp: 22,
      maxHp: 22,
      destroyed: false,
      flash: 0,
      motion: null,
      homeX: x,
      homeY: y,
      prevX: x,
      prevY: y,
      velX: 0,
      velY: 0,
      params: { life },
      active: true,
      timer: life,
      link: 0,
      tags: ['thorn', 'summoned'],
      reward: 0,
    });
    this.requestEffect('thornGrow', x, y, 60, 1);
  }

  updateBoss(enemy: Enemy, def: EnemyDef, dt: number): void {
    updateBossBehavior(this, enemy, def, dt);
  }

  /* ---------------------------------------------------------- prediction -- */

  /**
   * Predicts where the ball will next make contact, by integrating a copy of its
   * motion forward. Used for the impact reticle that teaches Perfect Bounce
   * timing, and for the optional trajectory preview.
   *
   * Moving geometry is treated as static for the prediction: being slightly
   * wrong about a crusher is acceptable, while a preview that jitters as
   * platforms move would be unreadable.
   */
  predict(maxTime = 1.6, samples = 26): void {
    const stats = this.currentStats;
    const step = maxTime / samples;
    let x = this.ball.x;
    let y = this.ball.y;
    let vx = this.ball.vx;
    let vy = this.ball.vy;
    this.predictedPath.length = 0;
    this.prediction.valid = false;

    for (let i = 0; i < samples; i++) {
      vx += this.activeGravityX * step;
      vy += this.activeGravityY * step;
      const speed = Math.hypot(vx, vy);
      if (speed > stats.maxSpeed) {
        vx = (vx / speed) * stats.maxSpeed;
        vy = (vy / speed) * stats.maxSpeed;
      }
      const dist = Math.hypot(vx * step, vy * step);
      if (dist > 0.01) {
        const dirX = (vx * step) / dist;
        const dirY = (vy * step) / dist;
        const hit = this.raycast(x, y, dirX, dirY, dist, this.ball.radius);
        if (hit.t >= 0) {
          this.prediction.valid = true;
          this.prediction.x = x + dirX * hit.t;
          this.prediction.y = y + dirY * hit.t;
          this.prediction.time = i * step + hit.t / Math.max(1, speed);
          this.prediction.nx = hit.nx;
          this.prediction.ny = hit.ny;
          this.predictedPath.push(this.prediction.x, this.prediction.y);
          return;
        }
      }
      x += vx * step;
      y += vy * step;
      this.predictedPath.push(x, y);
      if (x < -60 || x > this.width + 60 || y < -60 || y > this.height + 60) return;
    }
  }

  /**
   * Casts a ray (inflated by `radius`) against solid geometry and, optionally,
   * enemies. Returns the nearest hit distance, or t = -1.
   *
   * `includeEnemies` is false for queries that only care about level geometry, such
   * as an enemy checking whether a wall blocks its path. Testing every enemy there
   * makes the query quadratic in the enemy count for no benefit.
   */
  raycast(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    maxDist: number,
    radius = 0,
    includeEnemies = true,
  ): { t: number; nx: number; ny: number; enemy: Enemy | null; prop: Prop | null } {
    let bestT = -1;
    let bestProp: Prop | null = null;
    let bestEnemy: Enemy | null = null;

    const midX = x + dirX * maxDist * 0.5;
    const midY = y + dirY * maxDist * 0.5;
    const queryR = maxDist * 0.5 + radius + 8;

    for (const prop of this.propGrid.queryCircle(midX, midY, queryR)) {
      if (!propIsSolid(prop)) continue;
      const t = rayVsShape(x, y, dirX, dirY, maxDist, prop.shape, radius);
      if (t >= 0 && (bestT < 0 || t < bestT)) {
        bestT = t;
        bestProp = prop;
        bestEnemy = null;
      }
    }
    if (includeEnemies) {
      for (const enemy of this.enemies) {
        if (enemy.dead) continue;
        const t = rayVsShape(x, y, dirX, dirY, maxDist, enemy.shape, radius);
        if (t >= 0 && (bestT < 0 || t < bestT)) {
          bestT = t;
          bestEnemy = enemy;
          bestProp = null;
        }
      }
    }

    let nx = -dirX;
    let ny = -dirY;
    if (bestT >= 0) {
      const hx = x + dirX * bestT;
      const hy = y + dirY * bestT;
      const shape = bestProp ? bestProp.shape : bestEnemy ? bestEnemy.shape : null;
      if (shape) {
        const cx = shapeCenterX(shape);
        const cy = shapeCenterY(shape);
        const len = Math.hypot(hx - cx, hy - cy) || 1;
        nx = (hx - cx) / len;
        ny = (hy - cy) / len;
      }
    }
    return { t: bestT, nx, ny, enemy: bestEnemy, prop: bestProp };
  }

  /** Seconds until the predicted contact, or Infinity. Drives the timing ring. */
  timeToImpact(): number {
    if (!this.prediction.valid) return Infinity;
    const dist = Math.hypot(this.prediction.x - this.ball.x, this.prediction.y - this.ball.y);
    const speed = Math.hypot(this.ball.vx, this.ball.vy);
    return speed > 1 ? dist / speed : Infinity;
  }
}

/** Convenience: registers engine-level listeners a World always wants. */
export function installWorldDefaults(world: World): () => void {
  const off = world.bus.on(
    'enemyKilled',
    ({ enemy }) => {
      const stats = world.currentStats;
      if (stats.healOnKill > 0) world.healBall(stats.healOnKill);
      void enemy;
    },
    { order: ORDER.gameplay, group: 'world' },
  );
  return off;
}

export function tickDownExport(value: number, dt: number): number {
  return tickDown(value, dt);
}
