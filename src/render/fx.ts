/**
 * Visual effects.
 *
 * The rule the brief sets is the one that matters: effects must never obscure
 * gameplay. So this system is built around three constraints rather than around
 * spectacle.
 *
 *  1. Fixed budgets. Particles live in a ring buffer, so a chain reaction degrades
 *     by recycling the oldest particle rather than by dropping frames.
 *  2. Additive light, not opaque cover. Impact effects are drawn with `lighter`
 *     compositing and short lifetimes so the arena underneath stays visible.
 *  3. Everything scales from one intensity value derived from the impact context,
 *     so feedback is proportional to what actually happened. A graze looks like a
 *     graze; a 1200 unit/second critical kill looks like an event.
 *
 * The whole layer is driven by gameplay events. Nothing in the simulation knows
 * this file exists.
 */

import { RingBuffer } from '../core/pool';
import { clamp01, TAU } from '../core/math';
import { Rng } from '../core/rng';
import type { EventBus } from '../core/events';
import type { GameEvents } from '../sim/gameEvents';
import { ORDER } from '../sim/gameEvents';
import { impactIntensity } from '../sim/impact';
import { getMaterial } from '../sim/materials';
import type { Settings } from '../meta/settings';
import { paletteFor } from '../meta/settings';

export interface Particle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  /** 0 = spark (line), 1 = dot, 2 = ring, 3 = shard */
  kind: number;
  gravity: number;
  drag: number;
  rotation: number;
  spin: number;
}

export interface Shockring {
  active: boolean;
  x: number;
  y: number;
  radius: number;
  targetRadius: number;
  life: number;
  maxLife: number;
  color: string;
  width: number;
}

export interface FloatingText {
  active: boolean;
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  text: string;
  color: string;
  size: number;
}

export interface Arc {
  active: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  life: number;
  maxLife: number;
  color: string;
  /** Deterministic jitter seed so the bolt shape is stable for its lifetime. */
  seed: number;
}

export interface ScreenFlash {
  strength: number;
  color: string;
}

export class FxSystem {
  readonly particles = new RingBuffer<Particle>(1400, () => ({
    active: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    life: 0,
    maxLife: 1,
    size: 2,
    color: '#fff',
    kind: 0,
    gravity: 0,
    drag: 1,
    rotation: 0,
    spin: 0,
  }));

  readonly rings = new RingBuffer<Shockring>(90, () => ({
    active: false,
    x: 0,
    y: 0,
    radius: 0,
    targetRadius: 40,
    life: 0,
    maxLife: 0.4,
    color: '#fff',
    width: 3,
  }));

  readonly texts = new RingBuffer<FloatingText>(80, () => ({
    active: false,
    x: 0,
    y: 0,
    vy: -40,
    life: 0,
    maxLife: 0.8,
    text: '',
    color: '#fff',
    size: 14,
  }));

  readonly arcs = new RingBuffer<Arc>(70, () => ({
    active: false,
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    life: 0,
    maxLife: 0.18,
    color: '#fff',
    seed: 0,
  }));

  flash: ScreenFlash = { strength: 0, color: '#ffffff' };
  /** Hit-stop request in seconds, consumed by the game loop. */
  pendingHitStop = 0;
  /** Camera shake request, consumed by the game loop. */
  pendingShake = 0;
  /** Camera zoom punch request. */
  pendingPunch = 0;

  private readonly rng = new Rng('fx');
  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  private get density(): number {
    return this.settings.particleDensity;
  }

  clear(): void {
    this.particles.clear();
    this.rings.clear();
    this.texts.clear();
    this.arcs.clear();
    this.flash.strength = 0;
  }

  /* ------------------------------------------------------------- emitters -- */

  spark(x: number, y: number, dirX: number, dirY: number, count: number, color: string, speed = 240, spread = 0.9): void {
    const n = Math.max(1, Math.round(count * this.density));
    for (let i = 0; i < n; i++) {
      const p = this.particles.next();
      const angle = Math.atan2(dirY, dirX) + this.rng.range(-spread, spread);
      const magnitude = speed * this.rng.range(0.35, 1.25);
      p.active = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * magnitude;
      p.vy = Math.sin(angle) * magnitude;
      p.maxLife = this.rng.range(0.14, 0.34);
      p.life = p.maxLife;
      p.size = this.rng.range(1.4, 3.2);
      p.color = color;
      p.kind = 0;
      p.gravity = 380;
      p.drag = 2.4;
    }
  }

  burst(x: number, y: number, count: number, color: string, speed = 200, size = 3): void {
    const n = Math.max(1, Math.round(count * this.density));
    for (let i = 0; i < n; i++) {
      const p = this.particles.next();
      const angle = this.rng.range(0, TAU);
      const magnitude = speed * this.rng.range(0.2, 1);
      p.active = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * magnitude;
      p.vy = Math.sin(angle) * magnitude;
      p.maxLife = this.rng.range(0.25, 0.65);
      p.life = p.maxLife;
      p.size = size * this.rng.range(0.6, 1.4);
      p.color = color;
      p.kind = 1;
      p.gravity = 120;
      p.drag = 1.6;
    }
  }

  debris(x: number, y: number, count: number, color: string, speed = 320): void {
    const n = Math.max(1, Math.round(count * this.density));
    for (let i = 0; i < n; i++) {
      const p = this.particles.next();
      const angle = this.rng.range(0, TAU);
      p.active = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * speed * this.rng.range(0.3, 1);
      p.vy = Math.sin(angle) * speed * this.rng.range(0.3, 1) - 80;
      p.maxLife = this.rng.range(0.5, 1.1);
      p.life = p.maxLife;
      p.size = this.rng.range(2.5, 5.5);
      p.color = color;
      p.kind = 3;
      p.gravity = 900;
      p.drag = 0.5;
      p.rotation = this.rng.range(0, TAU);
      p.spin = this.rng.range(-9, 9);
    }
  }

  ring(x: number, y: number, radius: number, color: string, life = 0.34, width = 3): void {
    const r = this.rings.next();
    r.active = true;
    r.x = x;
    r.y = y;
    r.radius = radius * 0.2;
    r.targetRadius = radius;
    r.maxLife = life;
    r.life = life;
    r.color = color;
    r.width = width;
  }

  text(x: number, y: number, value: string, color: string, size = 14): void {
    if (!this.settings.damageNumbers && /^[0-9]/.test(value)) return;
    const t = this.texts.next();
    t.active = true;
    t.x = x + this.rng.range(-6, 6);
    t.y = y;
    t.vy = -this.rng.range(45, 75);
    t.maxLife = 0.75;
    t.life = t.maxLife;
    t.text = value;
    t.color = color;
    t.size = size;
  }

  bolt(x1: number, y1: number, x2: number, y2: number, color: string): void {
    const a = this.arcs.next();
    a.active = true;
    a.x1 = x1;
    a.y1 = y1;
    a.x2 = x2;
    a.y2 = y2;
    a.maxLife = 0.2;
    a.life = a.maxLife;
    a.color = color;
    a.seed = this.rng.int(1, 100000);
  }

  screenFlash(strength: number, color: string): void {
    if (this.settings.reducedFlashing) return;
    if (strength > this.flash.strength) {
      this.flash.strength = Math.min(0.55, strength);
      this.flash.color = color;
    }
  }

  /* --------------------------------------------------------------- update -- */

  update(dt: number): void {
    for (const p of this.particles.items) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      p.vy += p.gravity * dt;
      const drag = Math.exp(-p.drag * dt);
      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.spin * dt;
    }
    for (const r of this.rings.items) {
      if (!r.active) continue;
      r.life -= dt;
      if (r.life <= 0) {
        r.active = false;
        continue;
      }
      const t = 1 - r.life / r.maxLife;
      r.radius = r.targetRadius * (0.2 + 0.8 * (1 - (1 - t) ** 3));
    }
    for (const t of this.texts.items) {
      if (!t.active) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.active = false;
        continue;
      }
      t.y += t.vy * dt;
      t.vy *= Math.exp(-2.2 * dt);
    }
    for (const a of this.arcs.items) {
      if (!a.active) continue;
      a.life -= dt;
      if (a.life <= 0) a.active = false;
    }
    this.flash.strength = Math.max(0, this.flash.strength - dt * 2.6);
  }

  /* --------------------------------------------------------- event wiring -- */

  /**
   * Subscribes to gameplay events. This is the entire coupling between the
   * simulation and the presentation layer, which is what allows the simulation to
   * run headlessly in tests and in the balance simulator.
   */
  install(bus: EventBus<GameEvents>): void {
    const palette = () => paletteFor(this.settings.colorMode);

    bus.on(
      'impactResolved',
      (ctx) => {
        const intensity = impactIntensity(ctx);
        const material = getMaterial(ctx.material);
        const colors = palette();

        // Sparks always fire along the outgoing direction so the player reads
        // where the ball is going, not just that something happened.
        const outLen = Math.hypot(ctx.outVx, ctx.outVy) || 1;
        const count = 3 + intensity * 12;
        this.spark(ctx.px, ctx.py, ctx.outVx / outLen, ctx.outVy / outLen, count, material.edgeColor, 180 + intensity * 420);

        if (ctx.isPerfect) {
          this.ring(ctx.px, ctx.py, 54 + ctx.perfectQuality * 40, colors.perfect, 0.32, 3.5);
          this.screenFlash(0.1 + ctx.perfectQuality * 0.12, colors.perfect);
          this.pendingHitStop = Math.max(this.pendingHitStop, 0.045 + ctx.perfectQuality * 0.03);
          this.pendingPunch = Math.max(this.pendingPunch, 0.03);
        }
        if (ctx.isCrit) {
          this.ring(ctx.px, ctx.py, 70, colors.crit, 0.28, 2.5);
          this.burst(ctx.px, ctx.py, 10, colors.crit, 300, 2.6);
        }
        if (ctx.damageDealt > 0) {
          const label = ctx.isCrit ? `${Math.round(ctx.damageDealt)}!` : `${Math.round(ctx.damageDealt)}`;
          this.text(ctx.px, ctx.py - 12, label, ctx.isCrit ? colors.crit : '#ffffff', ctx.isCrit ? 17 : 13);
        }

        // Hit-stop only for impacts that are genuinely consequential; applying it
        // to every wall tap would make the game feel like it was stuttering.
        if (ctx.enemy || ctx.killed || intensity > 0.75) {
          this.pendingHitStop = Math.max(this.pendingHitStop, Math.min(0.075, 0.02 + intensity * 0.05) * this.settings.hitStop);
          this.pendingShake = Math.max(this.pendingShake, intensity * 0.55);
        } else {
          this.pendingShake = Math.max(this.pendingShake, intensity * 0.12);
        }

        for (const effect of ctx.effects) {
          if (effect === 'armor' || effect === 'ward' || effect === 'hardened') {
            this.ring(ctx.px, ctx.py, 40, colors.neutral, 0.22, 2);
            this.spark(ctx.px, ctx.py, ctx.nx, ctx.ny, 8, '#ffffff', 300, 1.4);
          }
          if (effect === 'breach') {
            this.ring(ctx.px, ctx.py, 90, colors.reward, 0.4, 4);
            this.text(ctx.px, ctx.py - 30, 'BREACH', colors.reward, 15);
          }
        }
      },
      { order: ORDER.feedback },
    );

    bus.on(
      'enemyKilled',
      ({ enemy, x, y }) => {
        const colors = palette();
        this.burst(x, y, 12 + Math.min(20, enemy.maxHp / 8), enemy.status.frostTime > 0 ? colors.perfect : '#ffd0a0', 260, 3);
        this.debris(x, y, 5, '#ffffff', 260);
        this.ring(x, y, enemy.radius * 3.2, colors.danger, 0.3, 2.5);
        this.pendingShake = Math.max(this.pendingShake, 0.25);
      },
      { order: ORDER.feedback },
    );

    bus.on(
      'propDestroyed',
      ({ prop }) => {
        const material = getMaterial(prop.material);
        const x = prop.shape.kind === 'segment' ? (prop.shape.x1 + prop.shape.x2) / 2 : prop.shape.x;
        const y = prop.shape.kind === 'segment' ? (prop.shape.y1 + prop.shape.y2) / 2 : prop.shape.y;
        this.debris(x, y, 10, material.edgeColor, 340);
        this.burst(x, y, 8, material.color, 180, 3);
        this.pendingShake = Math.max(this.pendingShake, 0.18);
      },
      { order: ORDER.feedback },
    );

    bus.on(
      'ballDamaged',
      (payload) => {
        const colors = palette();
        if (payload.blocked) {
          this.ring(payload.x, payload.y, 70, colors.shield, 0.3, 4);
          this.text(payload.x, payload.y - 20, payload.blockedBy === 'shield' ? 'BLOCKED' : 'ABSORBED', colors.shield, 14);
          return;
        }
        this.screenFlash(0.28, colors.danger);
        this.burst(payload.x, payload.y, 16, colors.danger, 300, 3.4);
        this.text(payload.x, payload.y - 18, `-${Math.round(payload.finalAmount)}`, colors.danger, 17);
        this.pendingShake = Math.max(this.pendingShake, 0.7);
        this.pendingHitStop = Math.max(this.pendingHitStop, 0.07 * this.settings.hitStop);
      },
      { order: ORDER.feedback },
    );

    bus.on(
      'ballHealed',
      ({ amount }) => {
        const colors = palette();
        this.text(0, 0, `+${Math.round(amount)}`, colors.safe, 15);
        this.flash.strength = Math.max(this.flash.strength, 0.06);
        this.flash.color = colors.safe;
      },
      { order: ORDER.feedback },
    );

    bus.on(
      'comboChanged',
      ({ value, multiplier }) => {
        if (value % 5 !== 0) return;
        const colors = palette();
        this.text(0, 0, `x${multiplier.toFixed(2)}`, colors.combo, 16);
      },
      { order: ORDER.feedback },
    );

    bus.on(
      'pickupCollected',
      ({ kind, x, y }) => {
        const colors = palette();
        if (kind === 'shard') {
          this.burst(x, y, 3, colors.reward, 90, 2);
        } else {
          this.ring(x, y, 60, colors.reward, 0.35, 3);
          this.burst(x, y, 14, colors.reward, 200, 3);
        }
      },
      { order: ORDER.feedback },
    );

    bus.on(
      'effectRequested',
      (request) => {
        const colors = palette();
        switch (request.kind) {
          case 'explosion':
            this.ring(request.x, request.y, request.radius, '#ffb066', 0.38, 4);
            this.burst(request.x, request.y, 18, '#ffd39a', 340, 3.4);
            this.screenFlash(0.12, '#ffb066');
            this.pendingShake = Math.max(this.pendingShake, 0.5);
            this.pendingHitStop = Math.max(this.pendingHitStop, 0.03 * this.settings.hitStop);
            break;
          case 'arc':
            if (request.x2 !== undefined && request.y2 !== undefined) {
              this.bolt(request.x, request.y, request.x2, request.y2, '#b0e0ff');
              this.burst(request.x2, request.y2, 5, '#dff4ff', 160, 2);
            }
            break;
          case 'shockwave':
            this.ring(request.x, request.y, request.radius, colors.neutral, 0.3, 3);
            break;
          case 'resonance':
            this.ring(request.x, request.y, request.radius, colors.combo, 0.34, 3);
            break;
          case 'singularity':
            this.ring(request.x, request.y, request.radius * 2, '#8a5fd8', 0.7, 5);
            this.screenFlash(0.16, '#8a5fd8');
            this.pendingShake = Math.max(this.pendingShake, 0.6);
            break;
          case 'implode':
            this.ring(request.x, request.y, request.radius, '#ff9ae0', 0.26, 2.5);
            break;
          case 'dash':
          case 'airBounce':
            this.ring(request.x, request.y, request.radius, colors.perfect, 0.24, 2.5);
            this.spark(request.x, request.y, 0, 1, 8, colors.perfect, 200, 2.6);
            break;
          case 'phase':
          case 'foldIn':
          case 'foldOut':
          case 'teleportIn':
          case 'teleportOut':
            this.ring(request.x, request.y, request.radius, '#c0a0ff', 0.3, 2.5);
            this.burst(request.x, request.y, 10, '#e0d0ff', 180, 2.6);
            break;
          case 'shieldBreak':
            this.ring(request.x, request.y, request.radius, colors.shield, 0.4, 5);
            this.screenFlash(0.14, colors.shield);
            break;
          case 'shieldRestore':
            this.ring(request.x, request.y, request.radius, colors.shield, 0.4, 3);
            break;
          case 'guard':
          case 'absorb':
            this.ring(request.x, request.y, request.radius, colors.shield, 0.26, 2);
            break;
          case 'revive':
            this.screenFlash(0.4, colors.safe);
            this.ring(request.x, request.y, request.radius, colors.safe, 0.8, 6);
            this.pendingShake = Math.max(this.pendingShake, 0.9);
            break;
          case 'bossPhase':
            this.screenFlash(0.3, colors.danger);
            this.ring(request.x, request.y, request.radius, colors.danger, 0.9, 6);
            this.pendingShake = Math.max(this.pendingShake, 1);
            this.pendingHitStop = Math.max(this.pendingHitStop, 0.16 * this.settings.hitStop);
            break;
          case 'crusherSlam':
            this.pendingShake = Math.max(this.pendingShake, 1);
            this.ring(request.x, request.y, 240, '#ffb066', 0.5, 6);
            break;
          case 'crusherWarn':
          case 'blinkTarget':
            this.ring(request.x, request.y, request.radius, colors.danger, Math.max(0.2, request.power), 2);
            break;
          case 'breach':
            this.ring(request.x, request.y, request.radius, colors.reward, 0.45, 4);
            break;
          case 'timeFreeze':
            this.screenFlash(0.1, colors.perfect);
            this.ring(request.x, request.y, request.radius, colors.perfect, 0.5, 2);
            break;
          case 'gravityFlip':
            this.ring(request.x, request.y, request.radius, '#ff7ae0', 0.5, 3);
            break;
          case 'thornGrow':
            this.burst(request.x, request.y, 10, '#b7f0a0', 160, 3);
            break;
          case 'blink':
            this.burst(request.x, request.y, 10, '#c9b0ff', 200, 2.4);
            break;
          default:
            this.ring(request.x, request.y, Math.max(24, request.radius), colors.neutral, 0.24, 2);
            break;
        }
      },
      { order: ORDER.feedback },
    );

    bus.on(
      'synergyActivated',
      () => {
        this.screenFlash(0.24, paletteFor(this.settings.colorMode).reward);
        this.pendingHitStop = Math.max(this.pendingHitStop, 0.1 * this.settings.hitStop);
      },
      { order: ORDER.feedback },
    );
  }

  /** Deterministic jitter for drawing a lightning bolt. */
  boltPoints(arc: Arc, segments = 6): number[] {
    const points: number[] = [arc.x1, arc.y1];
    const rng = new Rng(arc.seed);
    const dx = arc.x2 - arc.x1;
    const dy = arc.y2 - arc.y1;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    for (let i = 1; i < segments; i++) {
      const t = i / segments;
      const offset = rng.range(-1, 1) * length * 0.12 * Math.sin(t * Math.PI);
      points.push(arc.x1 + dx * t + nx * offset, arc.y1 + dy * t + ny * offset);
    }
    points.push(arc.x2, arc.y2);
    return points;
  }

  /** Alpha for a decaying effect, eased so the tail is not abrupt. */
  static fade(life: number, maxLife: number): number {
    return clamp01(life / maxLife) ** 0.7;
  }
}
