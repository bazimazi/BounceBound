/**
 * The renderer.
 *
 * Visual identity: hard-edged geometric shapes on a deep, desaturated background,
 * with the ball as the only bright, fully saturated object on screen. That single
 * rule does most of the work - wherever the eye goes, the ball is there, and
 * everything else is legible by contrast against it.
 *
 * Readability rules enforced here, in priority order:
 *  1. The ball is always drawn last among gameplay objects and always has a glow,
 *     so it is never lost behind an effect.
 *  2. Hazards get a shape cue (hatching, spikes) as well as a colour cue, so the
 *     game is playable without colour discrimination.
 *  3. Dangerous enemy arcs are drawn as an explicit arc on the enemy's silhouette.
 *     "Which side can I hit" is a question the picture answers directly.
 *  4. The predicted impact point and its timing ring are drawn under everything
 *     else, as thin lines, because they are information rather than decoration.
 */

import { clamp, clamp01, TAU } from '../core/math';
import { getMaterial } from '../sim/materials';
import { EnemyFlag, type Enemy, type Field, type Pickup, type Projectile, type Prop } from '../sim/entities';
import { defencesIntact, hasFlag } from '../sim/enemyLogic';
import { propIsHarmful, propIsSolid } from '../sim/propLogic';
import type { Ball } from '../sim/ball';
import type { World } from '../sim/world';
import { comboFill, comboTier } from '../sim/combo';
import { getEnemyDef } from '../content/enemies';
import { getBiome, type BiomeDef } from '../content/biomes';
import { getBallClass } from '../content/balls';
import type { Settings } from '../meta/settings';
import { paletteFor, type SemanticPalette } from '../meta/settings';
import { Camera } from './camera';
import { FxSystem } from './fx';

export interface RenderContext {
  world: World;
  biome: BiomeDef;
  ballClassId: string;
  /** Interpolation alpha between simulation steps. */
  alpha: number;
  /** Real time, for idle animation. */
  time: number;
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  readonly camera = new Camera();
  readonly fx: FxSystem;
  private settings: Settings;
  private palette: SemanticPalette;
  /** Device pixel ratio actually in use. */
  private dpr = 1;
  viewWidth = 960;
  viewHeight = 540;

  constructor(canvas: HTMLCanvasElement, settings: Settings, fx: FxSystem) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    this.settings = settings;
    this.palette = paletteFor(settings.colorMode);
    this.fx = fx;
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.palette = paletteFor(settings.colorMode);
    this.camera.shakeScale = settings.reducedMotion ? 0 : settings.screenShake;
    this.camera.motionScale = settings.reducedMotion ? 0 : 1;
  }

  /** Resizes the backing store to the CSS size, accounting for device pixels. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const width = Math.max(320, Math.round(rect.width));
    const height = Math.max(180, Math.round(rect.height));
    if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
    }
    this.dpr = dpr;
    this.viewWidth = width;
    this.viewHeight = height;
  }

  configureFor(world: World): void {
    this.camera.configure({
      roomWidth: world.width,
      roomHeight: world.height,
      viewWidth: this.viewWidth,
      viewHeight: this.viewHeight,
    });
  }

  /* ----------------------------------------------------------------- frame -- */

  draw(render: RenderContext): void {
    const ctx = this.ctx;
    const { world, biome } = render;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground(biome, world, render.time);

    ctx.save();
    this.camera.apply(ctx, this.viewWidth, this.viewHeight);

    this.drawArenaFrame(world, biome);
    this.drawFields(world);
    this.drawPrediction(world);
    this.drawProps(world, biome, render.time);
    this.drawPickups(world, render.time);
    this.drawEnemies(world, render.time);
    this.drawProjectiles(world);
    this.drawParticles();
    this.drawArcs();
    this.drawBall(world.ball, render);
    this.drawFloatingText(world);

    ctx.restore();

    this.drawVignette();
    this.drawScreenFlash();
  }

  private drawBackground(biome: BiomeDef, world: World, time: number): void {
    const ctx = this.ctx;
    const gradient = ctx.createLinearGradient(0, 0, 0, this.viewHeight);
    gradient.addColorStop(0, biome.palette.skyTop);
    gradient.addColorStop(1, biome.palette.skyBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);

    const limits = {
      roomWidth: world.width,
      roomHeight: world.height,
      viewWidth: this.viewWidth,
      viewHeight: this.viewHeight,
    };

    // Two parallax layers of angular silhouettes. Deliberately low contrast: the
    // background exists to give the biome an identity, not to compete with the
    // arena for attention.
    ctx.save();
    for (const [depth, color, scale] of [
      [0.04, biome.palette.far, 1],
      [0.09, biome.palette.mid, 0.66],
    ] as Array<[number, string, number]>) {
      const offset = this.camera.parallax(depth, limits);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.5;
      const count = 7;
      for (let i = 0; i < count; i++) {
        const w = this.viewWidth / count;
        const x = i * w + offset.x;
        const seed = Math.sin(i * 12.9898 + depth * 78.233) * 43758.5453;
        const h = (0.24 + (seed - Math.floor(seed)) * 0.3) * this.viewHeight * scale;
        const drift = this.settings.reducedMotion ? 0 : Math.sin(time * 0.12 + i) * 4;
        ctx.beginPath();
        ctx.moveTo(x, this.viewHeight);
        ctx.lineTo(x + w * 0.5, this.viewHeight - h + drift);
        ctx.lineTo(x + w, this.viewHeight);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** The arena boundary: a hard frame so the play space is unambiguous. */
  private drawArenaFrame(world: World, biome: BiomeDef): void {
    const ctx = this.ctx;
    ctx.fillStyle = biome.palette.fog;
    ctx.fillRect(0, 0, world.width, world.height);

    ctx.strokeStyle = biome.palette.terrainEdge;
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, world.width - 3, world.height - 3);
    ctx.globalAlpha = 1;

    // A faint grid gives the eye a reference for judging angles and distances,
    // which matters a great deal when the core skill is predicting a bounce.
    ctx.strokeStyle = biome.palette.terrainEdge;
    ctx.globalAlpha = 0.055;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 96; x < world.width; x += 96) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, world.height);
    }
    for (let y = 96; y < world.height; y += 96) {
      ctx.moveTo(0, y);
      ctx.lineTo(world.width, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* ----------------------------------------------------------------- props -- */

  private drawProps(world: World, biome: BiomeDef, time: number): void {
    const ctx = this.ctx;
    for (const prop of world.props) {
      if (prop.destroyed) continue;
      if (prop.kind === 'goal') {
        this.drawGoal(prop, world, time);
        continue;
      }
      const material = getMaterial(prop.material);
      const harmful = propIsHarmful(prop);
      const solid = propIsSolid(prop);
      const inactive = (prop.kind === 'temporary' || prop.kind === 'door') && !prop.active;

      ctx.save();
      if (inactive) ctx.globalAlpha = 0.2;
      if (prop.kind === 'laser' && !prop.active) ctx.globalAlpha = 0.16;

      const fill = prop.flash > 0 ? '#ffffff' : material.color;
      const stroke = harmful ? this.palette.danger : material.edgeColor;

      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = harmful ? 2.5 : 1.5;
      this.tracePropPath(prop);
      if (!solid && !harmful) {
        // Trigger volumes are drawn as outlines only, so they never read as ground.
        ctx.globalAlpha *= 0.22;
        ctx.fill();
        ctx.globalAlpha /= 0.22;
        ctx.setLineDash([8, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fill();
        ctx.stroke();
      }

      // Breakable props show remaining integrity as a fill bar rather than a
      // number, because it has to be readable at a glance mid-bounce.
      if (prop.maxHp > 0 && prop.hp < prop.maxHp && prop.shape.kind === 'aabb') {
        const fraction = clamp01(prop.hp / prop.maxHp);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(prop.shape.x - prop.shape.halfW, prop.shape.y - prop.shape.halfH, prop.shape.halfW * 2 * (1 - fraction), prop.shape.halfH * 2);
      }

      if (harmful && this.settings.dangerOutlines) this.drawHazardCue(prop);
      if (prop.kind === 'launcher') this.drawLauncherCue(prop);
      if (prop.kind === 'bouncepad') this.drawPadCue(prop);
      if (prop.kind === 'teleporter') this.drawWarpCue(prop, time);
      if (prop.kind === 'gravityzone') this.drawGravityCue(prop, time);
      ctx.restore();
      void biome;
    }
  }

  private tracePropPath(prop: Prop): void {
    const ctx = this.ctx;
    const shape = prop.shape;
    ctx.beginPath();
    switch (shape.kind) {
      case 'aabb':
        ctx.rect(shape.x - shape.halfW, shape.y - shape.halfH, shape.halfW * 2, shape.halfH * 2);
        break;
      case 'circle':
        ctx.arc(shape.x, shape.y, shape.radius, 0, TAU);
        break;
      case 'poly': {
        const v = shape.worldVerts;
        ctx.moveTo(v[0], v[1]);
        for (let i = 2; i < v.length; i += 2) ctx.lineTo(v[i], v[i + 1]);
        ctx.closePath();
        break;
      }
      case 'segment': {
        const half = shape.thickness * 0.5 + 1;
        const dx = shape.x2 - shape.x1;
        const dy = shape.y2 - shape.y1;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * half;
        const ny = (dx / len) * half;
        ctx.moveTo(shape.x1 + nx, shape.y1 + ny);
        ctx.lineTo(shape.x2 + nx, shape.y2 + ny);
        ctx.lineTo(shape.x2 - nx, shape.y2 - ny);
        ctx.lineTo(shape.x1 - nx, shape.y1 - ny);
        ctx.closePath();
        break;
      }
    }
  }

  /** Diagonal hatching: a shape cue for danger that survives colour blindness. */
  private drawHazardCue(prop: Prop): void {
    const ctx = this.ctx;
    const shape = prop.shape;
    const cx = shape.kind === 'segment' ? (shape.x1 + shape.x2) / 2 : shape.x;
    const cy = shape.kind === 'segment' ? (shape.y1 + shape.y2) / 2 : shape.y;
    const extent = shape.kind === 'aabb' ? Math.max(shape.halfW, shape.halfH) : shape.kind === 'circle' ? shape.radius : shape.kind === 'poly' ? shape.boundRadius : 30;
    ctx.save();
    this.tracePropPath(prop);
    ctx.clip();
    ctx.strokeStyle = this.palette.danger;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let offset = -extent * 2; offset < extent * 2; offset += 9) {
      ctx.moveTo(cx + offset, cy - extent * 1.6);
      ctx.lineTo(cx + offset + extent * 1.6, cy + extent * 1.6);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawLauncherCue(prop: Prop): void {
    const ctx = this.ctx;
    if (prop.shape.kind !== 'circle') return;
    const dx = prop.params.dirX ?? 0;
    const dy = prop.params.dirY ?? -1;
    const len = Math.hypot(dx, dy) || 1;
    ctx.strokeStyle = this.palette.reward;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(prop.shape.x, prop.shape.y);
    ctx.lineTo(prop.shape.x + (dx / len) * 34, prop.shape.y + (dy / len) * 34);
    ctx.stroke();
    // Arrow head, so the launch direction is unmistakable.
    const angle = Math.atan2(dy, dx);
    const tipX = prop.shape.x + (dx / len) * 34;
    const tipY = prop.shape.y + (dy / len) * 34;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX + Math.cos(angle + 2.6) * 10, tipY + Math.sin(angle + 2.6) * 10);
    ctx.lineTo(tipX + Math.cos(angle - 2.6) * 10, tipY + Math.sin(angle - 2.6) * 10);
    ctx.closePath();
    ctx.fillStyle = this.palette.reward;
    ctx.fill();
  }

  private drawPadCue(prop: Prop): void {
    const ctx = this.ctx;
    if (prop.shape.kind !== 'poly') return;
    const v = prop.shape.worldVerts;
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const t = (i + 1) / 4;
      const x = v[0] + (v[2] - v[0]) * t;
      const y = v[1] + (v[3] - v[1]) * t;
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - 9);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawWarpCue(prop: Prop, time: number): void {
    const ctx = this.ctx;
    if (prop.shape.kind !== 'circle') return;
    ctx.strokeStyle = '#c0a0ff';
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const phase = (time * 0.6 + i / 3) % 1;
      ctx.globalAlpha = 1 - phase;
      ctx.beginPath();
      ctx.arc(prop.shape.x, prop.shape.y, prop.shape.radius * (0.3 + phase * 0.9), 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Destination marker, so a teleporter is a tool rather than a surprise.
    const tx = prop.params.tx;
    const ty = prop.params.ty;
    if (tx !== undefined && ty !== undefined) {
      ctx.setLineDash([4, 8]);
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(prop.shape.x, prop.shape.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tx, ty, 14, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  private drawGravityCue(prop: Prop, time: number): void {
    const ctx = this.ctx;
    if (prop.shape.kind !== 'aabb') return;
    const gx = prop.params.gx ?? 0;
    const gy = prop.params.gy ?? -1;
    const len = Math.hypot(gx, gy) || 1;
    ctx.strokeStyle = '#ff7ae0';
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = 2;
    const spacing = 34;
    const drift = this.settings.reducedMotion ? 0 : (time * 40) % spacing;
    for (let x = -prop.shape.halfW + 12; x < prop.shape.halfW; x += spacing) {
      for (let y = -prop.shape.halfH + 12; y < prop.shape.halfH; y += spacing) {
        const px = prop.shape.x + x;
        const py = prop.shape.y + y + ((gy < 0 ? -drift : drift) % spacing);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + (gx / len) * 11, py + (gy / len) * 11);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawGoal(prop: Prop, world: World, time: number): void {
    const ctx = this.ctx;
    if (prop.shape.kind !== 'circle') return;
    const open = prop.active;
    const radius = Math.max(prop.params.reach ?? 0, prop.shape.radius);
    ctx.save();
    ctx.globalAlpha = open ? 1 : 0.25;
    ctx.strokeStyle = open ? this.palette.safe : this.palette.neutral;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(prop.shape.x, prop.shape.y, prop.shape.radius, 0, TAU);
    ctx.stroke();

    if (open) {
      // The collection radius is drawn explicitly: the player should never wonder
      // whether they were close enough.
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.arc(prop.shape.x, prop.shape.y, radius, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const pulse = this.settings.reducedMotion ? 0.5 : (Math.sin(time * 4) + 1) / 2;
      ctx.fillStyle = this.palette.safe;
      ctx.globalAlpha = 0.25 + pulse * 0.4;
      ctx.beginPath();
      ctx.arc(prop.shape.x, prop.shape.y, prop.shape.radius * 0.5, 0, TAU);
      ctx.fill();
    } else {
      // Closed exit shows the remaining requirement rather than nothing at all.
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = this.palette.neutral;
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const remaining = world.enemies.filter((e) => !e.dead && !(hasFlag(e, EnemyFlag.Boss) && e.parentId !== 0)).length;
      ctx.fillText(`${remaining} left`, prop.shape.x, prop.shape.y + 4);
    }
    ctx.restore();
  }

  /* --------------------------------------------------------------- enemies -- */

  private drawEnemies(world: World, time: number): void {
    const ctx = this.ctx;
    for (const enemy of world.enemies) {
      if (enemy.dead) continue;
      const def = getEnemyDef(enemy.defId);
      const shape = enemy.shape;
      const flashing = enemy.flash > 0;

      ctx.save();

      // Telegraph: a charging or about-to-fire enemy is outlined in danger colour
      // and scaled slightly, which is the clearest possible "something is coming".
      const telegraphing = enemy.state === 'telegraph';
      if (telegraphing) {
        const pulse = (Math.sin(time * 26) + 1) / 2;
        ctx.strokeStyle = this.palette.danger;
        ctx.globalAlpha = 0.35 + pulse * 0.45;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y, enemy.radius + 8, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      ctx.fillStyle = flashing ? '#ffffff' : def.color;
      ctx.strokeStyle = def.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (shape.kind === 'circle') {
        ctx.arc(shape.x, shape.y, shape.radius, 0, TAU);
      } else {
        const v = shape.worldVerts;
        ctx.moveTo(v[0], v[1]);
        for (let i = 2; i < v.length; i += 2) ctx.lineTo(v[i], v[i + 1]);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();

      // Status tints are drawn as thin rings rather than recolouring the body, so
      // the enemy stays identifiable while affected.
      this.drawStatusRings(enemy);

      // The dangerous or armoured arc, drawn on the silhouette.
      if (enemy.armorArc > 0 && defencesIntact(enemy)) {
        const dangerous = hasFlag(enemy, EnemyFlag.Spiked);
        ctx.strokeStyle = dangerous ? this.palette.danger : this.palette.neutral;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y, enemy.radius + 4, enemy.armorAngle - enemy.armorArc, enemy.armorAngle + enemy.armorArc);
        ctx.stroke();
        if (dangerous && this.settings.dangerOutlines) {
          // Spikes: a shape cue on top of the colour cue.
          const spikes = 5;
          ctx.beginPath();
          for (let i = 0; i < spikes; i++) {
            const a = enemy.armorAngle - enemy.armorArc + (i / (spikes - 1)) * enemy.armorArc * 2;
            const inner = enemy.radius + 4;
            const outer = enemy.radius + 13;
            ctx.moveTo(enemy.x + Math.cos(a) * inner, enemy.y + Math.sin(a) * inner);
            ctx.lineTo(enemy.x + Math.cos(a) * outer, enemy.y + Math.sin(a) * outer);
          }
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
      } else if (!defencesIntact(enemy)) {
        // A breached defence is announced: this is the window the player earned.
        ctx.strokeStyle = this.palette.reward;
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y, enemy.radius + 7, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (hasFlag(enemy, EnemyFlag.RicochetGated) && defencesIntact(enemy)) {
        ctx.strokeStyle = this.palette.shield;
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y, enemy.radius + 10, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      if (hasFlag(enemy, EnemyFlag.Magnetic)) {
        const radius = def.params.pullRadius ?? 280;
        ctx.strokeStyle = def.accent;
        ctx.globalAlpha = 0.16;
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 12]);
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y, radius, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      if (enemy.stun > 0) {
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y - enemy.radius - 12, 3, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Health bar, only when damaged and only for things worth tracking.
      if (enemy.hp < enemy.maxHp && enemy.maxHp > 20) {
        const w = enemy.radius * 2.2;
        const fraction = clamp01(enemy.hp / enemy.maxHp);
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(enemy.x - w / 2, enemy.y - enemy.radius - 10, w, 3.5);
        ctx.fillStyle = hasFlag(enemy, EnemyFlag.Elite) ? this.palette.reward : this.palette.danger;
        ctx.fillRect(enemy.x - w / 2, enemy.y - enemy.radius - 10, w * fraction, 3.5);
      }

      ctx.restore();
    }
  }

  private drawStatusRings(enemy: Enemy): void {
    const ctx = this.ctx;
    const statuses: Array<[boolean, string]> = [
      [enemy.status.burnTime > 0, '#ff8a4a'],
      [enemy.status.frostTime > 0, '#8ad8ff'],
      [enemy.status.poisonTime > 0, '#a0ff70'],
      [enemy.status.shockTime > 0, '#c0d0ff'],
      [enemy.status.markTime > 0, this.palette.reward],
    ];
    let offset = 0;
    for (const [active, color] of statuses) {
      if (!active) continue;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(enemy.x, enemy.y, enemy.radius + 2 + offset, 0, TAU);
      ctx.stroke();
      offset += 3;
    }
    ctx.globalAlpha = 1;
  }

  /* ------------------------------------------------------------------ ball -- */

  private drawBall(ball: Ball, render: RenderContext): void {
    const ctx = this.ctx;
    const ballClass = getBallClass(render.ballClassId);

    // Trail: the clearest signal of where the ball has just been, and the main
    // reason a fast ball stays trackable.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const sample of ball.trail) {
      if (sample.age === Infinity || sample.age > 0.3) continue;
      const t = 1 - sample.age / 0.3;
      ctx.globalAlpha = t * t * 0.5;
      ctx.fillStyle = sample.perfect ? this.palette.perfect : ballClass.color;
      ctx.beginPath();
      ctx.arc(sample.x, sample.y, ball.radius * (0.28 + t * 0.6), 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    ctx.translate(ball.x, ball.y);

    // Squash and stretch along the impact normal. Subtle, but it is what makes a
    // collision feel like a collision rather than a change of sign.
    if (ball.squash > 0.01 && !this.settings.reducedMotion) {
      ctx.rotate(ball.squashAngle);
      const squash = ball.squash * 0.35;
      ctx.scale(1 - squash, 1 + squash * 0.7);
      ctx.rotate(-ball.squashAngle);
    }

    const flashing = ball.flash > 0.01;
    const phasing = ball.phase > 0;
    const invulnerable = ball.iframes > 0;

    // Glow. The ball is the only object in the game with a glow, which is what
    // keeps it the visual protagonist.
    const glow = ctx.createRadialGradient(0, 0, ball.radius * 0.4, 0, 0, ball.radius * 3.2);
    glow.addColorStop(0, `${ballClass.accent}66`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, ball.radius * 3.2, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = phasing ? 0.45 : 1;
    ctx.fillStyle = flashing ? '#ffffff' : ballClass.color;
    ctx.beginPath();
    ctx.arc(0, 0, ball.radius, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = phasing ? '#c0a0ff' : ballClass.accent;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // A rotation mark so spin is visible; without it a circle reads as static.
    ctx.rotate(ball.rotation);
    ctx.strokeStyle = ballClass.accent;
    ctx.globalAlpha = (phasing ? 0.4 : 0.8);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-ball.radius * 0.55, 0);
    ctx.lineTo(ball.radius * 0.55, 0);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();

    // Shields are drawn as discrete arcs: a countable resource should look countable.
    if (ball.shield > 0) {
      ctx.save();
      ctx.strokeStyle = this.palette.shield;
      ctx.lineWidth = 3;
      const segments = Math.min(8, ball.shield);
      for (let i = 0; i < segments; i++) {
        const start = (i / segments) * TAU + render.time * 0.6;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, ball.radius + 8, start, start + TAU / segments - 0.22);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (invulnerable && !this.settings.reducedFlashing) {
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = 0.25 + Math.sin(render.time * 30) * 0.2;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.radius + 4, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // Air resources as pips above the ball: dashes and air bounces.
    this.drawAirPips(ball);
  }

  private drawAirPips(ball: Ball): void {
    const ctx = this.ctx;
    const total = ball.airBounces + ball.airDashes;
    if (total <= 0) return;
    ctx.save();
    const y = ball.y - ball.radius - 14;
    const spacing = 8;
    const startX = ball.x - ((total - 1) * spacing) / 2;
    let index = 0;
    for (let i = 0; i < ball.airBounces; i++, index++) {
      ctx.fillStyle = this.palette.perfect;
      ctx.beginPath();
      ctx.arc(startX + index * spacing, y, 2.6, 0, TAU);
      ctx.fill();
    }
    for (let i = 0; i < ball.airDashes; i++, index++) {
      ctx.fillStyle = this.palette.reward;
      ctx.fillRect(startX + index * spacing - 2.2, y - 2.2, 4.4, 4.4);
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------ prediction -- */

  /**
   * The predicted impact point and its timing ring.
   *
   * This is the single most important piece of information design in the game: it
   * is what makes the Perfect Bounce learnable. The ring shrinks toward the
   * contact point, and the player presses when it closes. Without it the timing
   * window is invisible, and the core skill would be guesswork.
   */
  private drawPrediction(world: World): void {
    if (this.settings.trajectory === 'off') return;
    const ctx = this.ctx;
    const prediction = world.prediction;

    if (this.settings.trajectory === 'full' && world.predictedPath.length >= 4) {
      ctx.save();
      ctx.strokeStyle = this.palette.neutral;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 7]);
      ctx.beginPath();
      ctx.moveTo(world.predictedPath[0], world.predictedPath[1]);
      for (let i = 2; i < world.predictedPath.length; i += 2) {
        ctx.lineTo(world.predictedPath[i], world.predictedPath[i + 1]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    if (!prediction.valid) return;
    ctx.save();
    // Contact marker: a short line along the surface, not a blob, so it does not
    // hide what is being hit.
    ctx.strokeStyle = this.palette.perfect;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 2;
    const tangentX = -prediction.ny;
    const tangentY = prediction.nx;
    ctx.beginPath();
    ctx.moveTo(prediction.x - tangentX * 14, prediction.y - tangentY * 14);
    ctx.lineTo(prediction.x + tangentX * 14, prediction.y + tangentY * 14);
    ctx.stroke();

    if (this.settings.impactTiming) {
      const ttc = world.timeToImpact();
      const window = world.currentStats.perfectWindow;
      // The ring is sized so that it reaches the surface exactly when the timing
      // window opens: when the ring touches the marker, press.
      const horizon = Math.max(window * 3, 0.24);
      if (Number.isFinite(ttc) && ttc < horizon) {
        const t = clamp01(ttc / horizon);
        const radius = 10 + t * 60;
        const inWindow = ttc <= window;
        ctx.globalAlpha = inWindow ? 0.95 : 0.45;
        ctx.strokeStyle = inWindow ? this.palette.perfect : this.palette.neutral;
        ctx.lineWidth = inWindow ? 3 : 1.8;
        ctx.beginPath();
        ctx.arc(prediction.x, prediction.y, radius, 0, TAU);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* --------------------------------------------------------------- effects -- */

  private drawFields(world: World): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const field of world.fields) {
      if (!field.active) continue;
      const t = clamp01(field.life / field.maxLife);
      const color = fieldColor(field);
      const gradient = ctx.createRadialGradient(field.x, field.y, 0, field.x, field.y, field.radius);
      gradient.addColorStop(0, `${color}${toHexAlpha(0.45 * t)}`);
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(field.x, field.y, field.radius, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // Damaging fields also get a hard outline so they are not mistaken for glow.
    for (const field of world.fields) {
      if (!field.active || field.kind === 'heal') continue;
      ctx.strokeStyle = this.palette.danger;
      ctx.globalAlpha = 0.25 * clamp01(field.life / field.maxLife);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(field.x, field.y, field.radius, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawProjectiles(world: World): void {
    const ctx = this.ctx;
    for (const projectile of world.projectiles) {
      if (!projectile.active) continue;
      const hostile = projectile.faction === 'hostile';
      ctx.save();
      ctx.fillStyle = projectile.color;
      ctx.strokeStyle = hostile ? this.palette.danger : this.palette.safe;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(projectile.x, projectile.y, projectile.radius, 0, TAU);
      ctx.fill();
      ctx.stroke();
      // A motion streak makes fast bullets readable at 60fps.
      const speed = Math.hypot(projectile.vx, projectile.vy);
      if (speed > 120) {
        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = projectile.color;
        ctx.lineWidth = projectile.radius * 1.2;
        ctx.beginPath();
        ctx.moveTo(projectile.x, projectile.y);
        ctx.lineTo(projectile.x - (projectile.vx / speed) * 16, projectile.y - (projectile.vy / speed) * 16);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawPickups(world: World, time: number): void {
    const ctx = this.ctx;
    for (const pickup of world.pickups) {
      if (!pickup.active) continue;
      const armed = pickup.armTime <= 0;
      ctx.save();
      ctx.globalAlpha = armed ? 1 : 0.4;
      if (pickup.kind === 'shard') {
        ctx.fillStyle = this.palette.reward;
        ctx.translate(pickup.x, pickup.y);
        ctx.rotate(time * 3 + pickup.id);
        ctx.beginPath();
        ctx.moveTo(0, -pickup.radius);
        ctx.lineTo(pickup.radius * 0.7, 0);
        ctx.lineTo(0, pickup.radius);
        ctx.lineTo(-pickup.radius * 0.7, 0);
        ctx.closePath();
        ctx.fill();
      } else {
        const bob = this.settings.reducedMotion ? 0 : Math.sin(time * 2.4 + pickup.id) * 4;
        ctx.translate(pickup.x, pickup.y + bob);
        const color = pickup.kind === 'heal' ? this.palette.safe : this.palette.reward;
        ctx.fillStyle = color;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, pickup.radius, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.globalAlpha *= 0.4;
        ctx.beginPath();
        ctx.arc(0, 0, pickup.radius + 6 + Math.sin(time * 4 + pickup.id) * 2, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.fx.particles.items) {
      if (!p.active) continue;
      const alpha = FxSystem.fade(p.life, p.maxLife);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      if (p.kind === 0) {
        const speed = Math.hypot(p.vx, p.vy) || 1;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - (p.vx / speed) * p.size * 4, p.y - (p.vy / speed) * p.size * 4);
        ctx.stroke();
      } else if (p.kind === 3) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, TAU);
        ctx.fill();
      }
    }
    for (const r of this.fx.rings.items) {
      if (!r.active) continue;
      ctx.globalAlpha = FxSystem.fade(r.life, r.maxLife) * 0.85;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawArcs(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const arc of this.fx.arcs.items) {
      if (!arc.active) continue;
      const points = this.fx.boltPoints(arc);
      ctx.globalAlpha = FxSystem.fade(arc.life, arc.maxLife);
      ctx.strokeStyle = arc.color;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawFloatingText(world: World): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    for (const t of this.fx.texts.items) {
      if (!t.active) continue;
      // Texts emitted with no position (heals, combo) follow the ball.
      const x = t.x === 0 && t.y === 0 ? world.ball.x : t.x;
      const y = t.x === 0 && t.y === 0 ? world.ball.y - 34 - (1 - t.life / t.maxLife) * 26 : t.y;
      ctx.globalAlpha = FxSystem.fade(t.life, t.maxLife);
      ctx.font = `700 ${t.size}px system-ui, sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.strokeText(t.text, x, y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, x, y);
    }
    ctx.restore();
  }

  private drawVignette(): void {
    const ctx = this.ctx;
    const gradient = ctx.createRadialGradient(
      this.viewWidth / 2,
      this.viewHeight / 2,
      Math.min(this.viewWidth, this.viewHeight) * 0.45,
      this.viewWidth / 2,
      this.viewHeight / 2,
      Math.max(this.viewWidth, this.viewHeight) * 0.78,
    );
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);
  }

  private drawScreenFlash(): void {
    const flash = this.fx.flash;
    if (flash.strength <= 0.001) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = flash.strength;
    ctx.fillStyle = flash.color;
    ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);
    ctx.restore();
  }

  /** Exposed for the HUD and debug overlays, which draw in screen space. */
  get context(): CanvasRenderingContext2D {
    return this.ctx;
  }

  get devicePixelRatio(): number {
    return this.dpr;
  }

  get semanticPalette(): SemanticPalette {
    return this.palette;
  }

  comboVisual(world: World): { fill: number; tier: number } {
    return { fill: comboFill(world.combo), tier: comboTier(world.combo.value) };
  }

  biomeOf(id: string): BiomeDef {
    return getBiome(id as never);
  }
}

function fieldColor(field: Field): string {
  switch (field.kind) {
    case 'fire':
      return '#ff8a4a';
    case 'frost':
      return '#8ad8ff';
    case 'shock':
      return '#c0d0ff';
    case 'void':
    case 'singularity':
      return '#8a5fd8';
    case 'heal':
      return '#5ce8a0';
    case 'trail':
      return '#ffb066';
    default:
      return '#ffffff';
  }
}

function toHexAlpha(alpha: number): string {
  return Math.round(clamp(alpha, 0, 1) * 255)
    .toString(16)
    .padStart(2, '0');
}

/** Re-exported for the HUD, which needs the same projectile/pickup colours. */
export { fieldColor };
export type { Pickup, Projectile, Prop };
