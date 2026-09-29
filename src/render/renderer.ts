/**
 * The renderer.
 *
 * Visual identity: hard-edged geometric shapes on a deep, desaturated background,
 * with the ball as the brightest, most saturated object on screen. That single
 * rule does most of the work - wherever the eye goes, the ball is there, and
 * everything else is legible by contrast against it.
 *
 * Readability rules enforced here, in priority order:
 *  1. The ball is always drawn last among gameplay objects and always has the
 *     strongest glow, so it is never lost behind an effect.
 *  2. Hazards get a shape cue (hatching, spikes) as well as a colour cue, so the
 *     game is playable without colour discrimination.
 *  3. Dangerous enemy arcs are drawn as an explicit arc on the enemy's silhouette.
 *     "Which side can I hit" is a question the picture answers directly.
 *  4. The predicted impact point and its timing ring are drawn under everything
 *     else, as thin lines, because they are information rather than decoration.
 *
 * On top of those rules sits the "juice" layer, borrowed from the usual places:
 * squash and stretch on the ball (Celeste), a white pop and jelly squash on every
 * enemy hit (Nuclear Throne, Vlambeer), staggered pop-in on room entry, eyes that
 * track the ball so enemies read as creatures rather than circles (Peglin, Ball x
 * Pit), additive bloom from pre-rendered glow sprites, and a lit arena - the ball
 * casts a pool of light onto the grid around it. All of it is presentation only:
 * nothing here writes to the simulation.
 */

import { clamp, clamp01, damp, TAU } from '../core/math';
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
import {
  alpha,
  darken,
  DISPLAY_FONT,
  drawGlow,
  easeInOutCubic,
  easeOutBack,
  easeOutCubic,
  hash01,
  lighten,
  mix,
  traceStar,
  UI_FONT,
} from './paint';

export interface RenderContext {
  world: World;
  biome: BiomeDef;
  ballClassId: string;
  /** Interpolation alpha between simulation steps. */
  alpha: number;
  /** Real time, for idle animation. */
  time: number;
}

/** Per-enemy presentation state the simulation has no reason to carry. */
interface EnemyVisual {
  /** Real time at which the enemy should start popping in. */
  born: number;
  lastHp: number;
  /** Trailing health shown behind the real value, fighting-game style. */
  ghostHp: number;
  ghostHold: number;
}

/** Seconds of the room-entry iris. */
const IRIS_TIME = 0.55;
/** Trail samples older than this are not drawn. */
const TRAIL_AGE = 0.3;

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

  private readonly enemyVisuals = new Map<number, EnemyVisual>();
  private lastRoomTime = Number.POSITIVE_INFINITY;
  private lastWorld: World | null = null;
  private lastTime = 0;
  private frameDt = 1 / 60;
  private vignette: { w: number; h: number; gradient: CanvasGradient } | null = null;

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
    this.vignette = null;
  }

  configureFor(world: World): void {
    this.camera.configure({
      roomWidth: world.width,
      roomHeight: world.height,
      viewWidth: this.viewWidth,
      viewHeight: this.viewHeight,
    });
  }

  private get motion(): boolean {
    return !this.settings.reducedMotion;
  }

  /* ----------------------------------------------------------------- frame -- */

  draw(render: RenderContext): void {
    const ctx = this.ctx;
    const { world, biome } = render;

    this.frameDt = clamp(render.time - this.lastTime, 0, 0.1);
    this.lastTime = render.time;
    // A new room (or a new run) resets presentation state: pop-ins replay, health
    // ghosts start fresh.
    if (world !== this.lastWorld || world.roomTime < this.lastRoomTime - 1e-6) {
      this.enemyVisuals.clear();
    }
    this.lastWorld = world;
    this.lastRoomTime = world.roomTime;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    this.drawBackground(biome, world, render.time);

    ctx.save();
    this.camera.apply(ctx, this.viewWidth, this.viewHeight);

    this.drawArenaFrame(world, biome, render);
    this.drawFields(world, render.time);
    this.drawPrediction(world, render.time);
    this.drawPropShadows(world);
    this.drawProps(world, biome, render.time);
    this.drawPickups(world, render.time);
    this.drawEnemies(world, render.time);
    this.drawProjectiles(world);
    this.drawParticles();
    this.drawArcs();
    this.drawBall(world.ball, render);
    this.drawFloatingText(world);

    ctx.restore();

    this.drawVignette(world);
    this.drawScreenFlash();
    this.drawCallouts();
    this.drawIris(world);
  }

  /* ------------------------------------------------------------ background -- */

  private drawBackground(biome: BiomeDef, world: World, time: number): void {
    const ctx = this.ctx;
    const w = this.viewWidth;
    const h = this.viewHeight;
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, biome.palette.skyTop);
    gradient.addColorStop(1, biome.palette.skyBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    const limits = { roomWidth: world.width, roomHeight: world.height, viewWidth: w, viewHeight: h };

    // A large, slow light source in the biome's accent colour. It gives the
    // background a direction of light that the terrain shading agrees with.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const drift = this.motion ? Math.sin(time * 0.07) * w * 0.05 : 0;
    drawGlow(ctx, biome.palette.accent, w * 0.72 + drift, h * 0.08, Math.max(w, h) * 0.75, 0.16);
    ctx.restore();

    // Three parallax ridgelines. Deliberately low contrast: the background exists
    // to give the biome an identity, not to compete with the arena for attention.
    ctx.save();
    const layers: Array<[number, string, number, number]> = [
      [0.03, biome.palette.far, 0.46, 0.5],
      [0.07, biome.palette.mid, 0.32, 0.55],
      [0.12, darken(biome.palette.mid, 0.25), 0.2, 0.7],
    ];
    for (const [layerIndex, [depth, color, heightScale, opacity]] of layers.entries()) {
      const offset = this.camera.parallax(depth, limits);
      ctx.fillStyle = color;
      ctx.globalAlpha = opacity;
      const points = 16;
      const step = (w + 160) / points;
      const base = h + 2;
      ctx.beginPath();
      ctx.moveTo(-80 + offset.x, base);
      for (let i = 0; i <= points; i++) {
        const seed = hash01(i * 7.31 + layerIndex * 101.7 + biome.order * 13.1);
        const peak = (0.35 + seed * 0.65) * h * heightScale;
        const sway = this.motion ? Math.sin(time * 0.1 + i * 0.9 + layerIndex) * 3 : 0;
        const x = -80 + i * step + offset.x;
        // Alternate peaks and shoulders so the silhouette is angular, not wavy.
        const y = base - (i % 2 === 0 ? peak : peak * 0.62) + sway + offset.y * 0.5;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w + 80 + offset.x, base);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Ambient motes: slow, sparse, drifting upward. They are the difference
    // between a backdrop and a place.
    const motes = Math.round(34 * clamp(this.settings.particleDensity, 0.2, 1.5));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = biome.palette.dust;
    for (let i = 0; i < motes; i++) {
      const a = hash01(i * 3.7 + 1);
      const b = hash01(i * 9.1 + 2);
      const speed = 6 + b * 14;
      const depth = 0.02 + a * 0.1;
      const offset = this.camera.parallax(depth, limits);
      const t = this.motion ? time : 0;
      const x = ((a * w + Math.sin(t * 0.3 + i) * 18 + offset.x) % w + w) % w;
      const y = (((b * h - t * speed + offset.y) % h) + h) % h;
      const twinkle = this.motion ? 0.5 + 0.5 * Math.sin(t * (1 + a * 2) + i) : 0.7;
      ctx.globalAlpha = 0.12 + twinkle * 0.3 * (0.4 + a);
      const size = 0.8 + a * 1.8;
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
    }
    ctx.restore();
  }

  /** The arena: a lit floor plane with a hard frame, so the play space is unambiguous. */
  private drawArenaFrame(world: World, biome: BiomeDef, render: RenderContext): void {
    const ctx = this.ctx;
    const fog = ctx.createLinearGradient(0, 0, 0, world.height);
    fog.addColorStop(0, lighten(biome.palette.fog, 0.04));
    fog.addColorStop(1, darken(biome.palette.fog, 0.2));
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, world.width, world.height);

    // A faint grid gives the eye a reference for judging angles and distances,
    // which matters a great deal when the core skill is predicting a bounce.
    ctx.strokeStyle = biome.palette.terrainEdge;
    ctx.globalAlpha = 0.05;
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

    // Grid intersections near the ball light up. The ball is the light source of
    // the arena, which ties the protagonist to the space it moves through.
    const ball = world.ball;
    const ballClass = getBallClass(render.ballClassId);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, ballClass.accent, ball.x, ball.y, 300, 0.16);
    ctx.fillStyle = ballClass.accent;
    const reach = 230;
    const x0 = Math.max(96, Math.ceil((ball.x - reach) / 96) * 96);
    const y0 = Math.max(96, Math.ceil((ball.y - reach) / 96) * 96);
    for (let x = x0; x <= ball.x + reach && x < world.width; x += 96) {
      for (let y = y0; y <= ball.y + reach && y < world.height; y += 96) {
        const d = Math.hypot(x - ball.x, y - ball.y);
        if (d > reach) continue;
        ctx.globalAlpha = (1 - d / reach) ** 2 * 0.55;
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
    ctx.restore();

    // The frame: a wide soft stroke under a thin hard one reads as a lit edge.
    ctx.strokeStyle = biome.palette.terrainEdge;
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 9;
    ctx.strokeRect(1.5, 1.5, world.width - 3, world.height - 3);
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(1.5, 1.5, world.width - 3, world.height - 3);
    ctx.globalAlpha = 1;
  }

  /* ----------------------------------------------------------------- props -- */

  /** Solid geometry casts a soft offset shadow, which lifts it off the backdrop. */
  private drawPropShadows(world: World): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.translate(5, 8);
    for (const prop of world.props) {
      if (prop.destroyed || prop.kind === 'goal' || !propIsSolid(prop)) continue;
      if ((prop.kind === 'temporary' || prop.kind === 'door') && !prop.active) continue;
      this.tracePropPath(prop);
      ctx.fill();
    }
    ctx.restore();
  }

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

      const stroke = harmful ? this.palette.danger : material.edgeColor;
      ctx.fillStyle = this.propFill(prop, material.color);
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
        if (solid && !harmful) this.drawTopHighlight(prop, material.edgeColor);
      }

      // Hit flash as a white wash rather than a hard swap, so large floors blink
      // rather than strobe.
      if (prop.flash > 0) {
        ctx.save();
        ctx.globalAlpha *= clamp01(prop.flash) * 0.65;
        ctx.fillStyle = '#ffffff';
        this.tracePropPath(prop);
        ctx.fill();
        ctx.restore();
      }

      // Breakable props show remaining integrity as a fill bar rather than a
      // number, because it has to be readable at a glance mid-bounce.
      if (prop.maxHp > 0 && prop.hp < prop.maxHp && prop.shape.kind === 'aabb') {
        const fraction = clamp01(prop.hp / prop.maxHp);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(prop.shape.x - prop.shape.halfW, prop.shape.y - prop.shape.halfH, prop.shape.halfW * 2 * (1 - fraction), prop.shape.halfH * 2);
      }

      if (harmful) this.drawHazardGlow(prop, time);
      if (harmful && this.settings.dangerOutlines) this.drawHazardCue(prop, time);
      if (prop.kind === 'launcher') this.drawLauncherCue(prop, time);
      if (prop.kind === 'bouncepad') this.drawPadCue(prop, time);
      if (prop.kind === 'teleporter') this.drawWarpCue(prop, time);
      if (prop.kind === 'gravityzone') this.drawGravityCue(prop, time);
      ctx.restore();
      void biome;
    }
  }

  /** Solid fills are lit from above: lighter at the top edge, darker below. */
  private propFill(prop: Prop, color: string): string | CanvasGradient {
    const shape = prop.shape;
    const ctx = this.ctx;
    if (shape.kind === 'aabb' && shape.halfH > 2) {
      const gradient = ctx.createLinearGradient(0, shape.y - shape.halfH, 0, shape.y + shape.halfH);
      gradient.addColorStop(0, lighten(color, 0.14));
      gradient.addColorStop(Math.min(0.5, 14 / (shape.halfH * 2)), color);
      gradient.addColorStop(1, darken(color, 0.3));
      return gradient;
    }
    if (shape.kind === 'circle') {
      const gradient = ctx.createRadialGradient(
        shape.x - shape.radius * 0.35,
        shape.y - shape.radius * 0.4,
        shape.radius * 0.1,
        shape.x,
        shape.y,
        shape.radius * 1.1,
      );
      gradient.addColorStop(0, lighten(color, 0.22));
      gradient.addColorStop(1, darken(color, 0.28));
      return gradient;
    }
    return color;
  }

  /** A bright rim along the top of a platform: "this is a surface you land on". */
  private drawTopHighlight(prop: Prop, edge: string): void {
    const shape = prop.shape;
    if (shape.kind !== 'aabb') return;
    const ctx = this.ctx;
    const left = shape.x - shape.halfW + 1;
    const right = shape.x + shape.halfW - 1;
    const top = shape.y - shape.halfH + 1;
    ctx.save();
    ctx.strokeStyle = lighten(edge, 0.35);
    ctx.lineWidth = 2;
    ctx.globalAlpha *= 0.85;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(right, top);
    ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha *= 0.25;
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.restore();
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

  /** Hazards breathe a danger-coloured glow, so they read as live rather than painted. */
  private drawHazardGlow(prop: Prop, time: number): void {
    const ctx = this.ctx;
    const pulse = this.motion && !this.settings.reducedFlashing ? 0.5 + 0.5 * Math.sin(time * 5 + prop.id) : 0.5;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = this.palette.danger;
    ctx.globalAlpha *= 0.12 + pulse * 0.16;
    ctx.lineWidth = 7;
    this.tracePropPath(prop);
    ctx.stroke();
    ctx.restore();
  }

  /** Diagonal hatching: a shape cue for danger that survives colour blindness. */
  private drawHazardCue(prop: Prop, time: number): void {
    const ctx = this.ctx;
    const shape = prop.shape;
    const cx = shape.kind === 'segment' ? (shape.x1 + shape.x2) / 2 : shape.x;
    const cy = shape.kind === 'segment' ? (shape.y1 + shape.y2) / 2 : shape.y;
    const extent = shape.kind === 'aabb' ? Math.max(shape.halfW, shape.halfH) : shape.kind === 'circle' ? shape.radius : shape.kind === 'poly' ? shape.boundRadius : 30;
    // The hatching crawls slowly, like a warning stripe on a moving belt.
    const crawl = this.motion ? (time * 14) % 9 : 0;
    ctx.save();
    this.tracePropPath(prop);
    ctx.clip();
    ctx.strokeStyle = this.palette.danger;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let offset = -extent * 2; offset < extent * 2; offset += 9) {
      ctx.moveTo(cx + offset + crawl, cy - extent * 1.6);
      ctx.lineTo(cx + offset + crawl + extent * 1.6, cy + extent * 1.6);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawLauncherCue(prop: Prop, time: number): void {
    const ctx = this.ctx;
    if (prop.shape.kind !== 'circle') return;
    const dx = prop.params.dirX ?? 0;
    const dy = prop.params.dirY ?? -1;
    const len = Math.hypot(dx, dy) || 1;
    // The arrow pulses outward along its direction: it is inviting, not static.
    const push = this.motion ? ((time * 1.6) % 1) * 8 : 0;
    const reach = 34 + push;
    ctx.strokeStyle = this.palette.reward;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(prop.shape.x, prop.shape.y);
    ctx.lineTo(prop.shape.x + (dx / len) * reach, prop.shape.y + (dy / len) * reach);
    ctx.stroke();
    // Arrow head, so the launch direction is unmistakable.
    const angle = Math.atan2(dy, dx);
    const tipX = prop.shape.x + (dx / len) * reach;
    const tipY = prop.shape.y + (dy / len) * reach;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX + Math.cos(angle + 2.6) * 10, tipY + Math.sin(angle + 2.6) * 10);
    ctx.lineTo(tipX + Math.cos(angle - 2.6) * 10, tipY + Math.sin(angle - 2.6) * 10);
    ctx.closePath();
    ctx.fillStyle = this.palette.reward;
    ctx.fill();
  }

  private drawPadCue(prop: Prop, time: number): void {
    const ctx = this.ctx;
    if (prop.shape.kind !== 'poly') return;
    const v = prop.shape.worldVerts;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const t = (i + 1) / 4;
      const x = v[0] + (v[2] - v[0]) * t;
      const y = v[1] + (v[3] - v[1]) * t;
      const lift = this.motion ? Math.max(0, Math.sin(time * 6 - i * 0.8)) * 5 : 0;
      ctx.moveTo(x, y - lift);
      ctx.lineTo(x, y - 9 - lift);
    }
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawWarpCue(prop: Prop, time: number): void {
    const ctx = this.ctx;
    if (prop.shape.kind !== 'circle') return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, '#c0a0ff', prop.shape.x, prop.shape.y, prop.shape.radius * 1.8, 0.35);
    ctx.restore();
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
      ctx.lineDashOffset = this.motion ? -time * 24 : 0;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(prop.shape.x, prop.shape.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tx, ty, 14, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
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
    const drift = this.motion ? (time * 40) % spacing : 0;
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

  /**
   * The exit. Closed, it is a dim dashed ring with a count; open, it is a portal:
   * counter-rotating arcs, a bright core and motes spiralling inward. The whole
   * point of an open exit is that it pulls the eye.
   */
  private drawGoal(prop: Prop, world: World, time: number): void {
    const ctx = this.ctx;
    if (prop.shape.kind !== 'circle') return;
    const open = prop.active;
    const r = prop.shape.radius;
    const cx = prop.shape.x;
    const cy = prop.shape.y;
    const radius = Math.max(prop.params.reach ?? 0, r);
    const t = this.motion ? time : 0;
    ctx.save();

    if (!open) {
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = this.palette.neutral;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 7]);
      ctx.lineDashOffset = t * 8;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      // Closed exit shows the remaining requirement rather than nothing at all.
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = this.palette.neutral;
      ctx.font = `15px ${DISPLAY_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const remaining = world.enemies.filter((e) => !e.dead && !(hasFlag(e, EnemyFlag.Boss) && e.parentId !== 0)).length;
      ctx.fillText(`${remaining}`, cx, cy - 4);
      ctx.font = `600 9px ${UI_FONT}`;
      ctx.fillText('LEFT', cx, cy + 10);
      ctx.textBaseline = 'alphabetic';
      ctx.restore();
      return;
    }

    const safe = this.palette.safe;
    // The collection radius is drawn explicitly: the player should never wonder
    // whether they were close enough.
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = safe;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.stroke();

    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1;
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    drawGlow(ctx, safe, cx, cy, r * 2.4, 0.45 + pulse * 0.2);

    ctx.strokeStyle = safe;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const rr = r * (1 - i * 0.24);
      const spin = t * (1.6 + i * 0.9) * (i % 2 === 0 ? 1 : -1);
      ctx.lineWidth = 3.2 - i * 0.7;
      ctx.globalAlpha = 0.85 - i * 0.18;
      for (let k = 0; k < 2; k++) {
        const start = spin + k * Math.PI;
        ctx.beginPath();
        ctx.arc(cx, cy, rr, start, start + Math.PI * 0.62);
        ctx.stroke();
      }
    }

    // Motes spiral inward.
    ctx.fillStyle = lighten(safe, 0.4);
    for (let i = 0; i < 10; i++) {
      const phase = (t * 0.7 + i / 10) % 1;
      const angle = i * 2.4 + t * 2.2 + phase * 3;
      const dist = r * 1.9 * (1 - phase);
      ctx.globalAlpha = Math.sin(phase * Math.PI) * 0.9;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, 1.2 + (1 - phase) * 1.8, 0, TAU);
      ctx.fill();
    }

    ctx.globalAlpha = 0.55 + pulse * 0.35;
    ctx.fillStyle = safe;
    ctx.beginPath();
    ctx.arc(cx, cy, r * (0.34 + pulse * 0.06), 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /* --------------------------------------------------------------- enemies -- */

  private enemyVisual(enemy: Enemy, index: number, world: World, time: number): EnemyVisual {
    let visual = this.enemyVisuals.get(enemy.id);
    if (!visual) {
      // Enemies present when the room opens pop in one after another; enemies
      // spawned mid-fight pop in immediately.
      const stagger = world.roomTime < 0.3 ? 0.18 + index * 0.05 : 0;
      visual = { born: time + stagger, lastHp: enemy.hp, ghostHp: enemy.hp, ghostHold: 0 };
      this.enemyVisuals.set(enemy.id, visual);
    }
    if (enemy.hp < visual.lastHp - 1e-6) visual.ghostHold = 0.4;
    if (enemy.hp > visual.ghostHp) visual.ghostHp = enemy.hp;
    visual.lastHp = enemy.hp;
    if (visual.ghostHold > 0) visual.ghostHold -= this.frameDt;
    else visual.ghostHp = damp(visual.ghostHp, enemy.hp, 7, this.frameDt);
    return visual;
  }

  private drawEnemies(world: World, time: number): void {
    const ctx = this.ctx;
    const ball = world.ball;
    let index = 0;
    for (const enemy of world.enemies) {
      if (enemy.dead) continue;
      const def = getEnemyDef(enemy.defId);
      const shape = enemy.shape;
      const flash = clamp01(enemy.flash);
      const visual = this.enemyVisual(enemy, index++, world, time);
      const boss = hasFlag(enemy, EnemyFlag.Boss);
      const elite = hasFlag(enemy, EnemyFlag.Elite);

      const age = time - visual.born;
      if (age < 0 && this.motion) continue;
      const spawn = this.motion ? easeOutBack(clamp01(age / 0.34), 2.2) : 1;

      // Squash: a jelly pop on every hit, an anticipation crouch while winding
      // up, and a slow idle breath so nothing is ever perfectly still.
      const telegraphing = enemy.state === 'telegraph';
      let sx = spawn;
      let sy = spawn;
      if (this.motion) {
        const breath = Math.sin(time * 2.6 + enemy.id * 1.7) * 0.025;
        sx *= 1 - breath + flash * 0.22;
        sy *= 1 + breath - flash * 0.16;
        if (telegraphing) {
          const crouch = 0.07 + Math.sin(time * 26) * 0.02;
          sx *= 1 + crouch;
          sy *= 1 - crouch;
        }
      }

      ctx.save();

      // Telegraph: a charging or about-to-fire enemy is outlined in danger colour,
      // which is the clearest possible "something is coming".
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

      ctx.translate(enemy.x, enemy.y);
      ctx.scale(sx, sy);
      ctx.translate(-enemy.x, -enemy.y);

      // Soft contact shadow, then the lit body.
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      this.traceEnemy(enemy, 4, 6);
      ctx.fill();

      const r = enemy.radius;
      const body = ctx.createRadialGradient(enemy.x - r * 0.35, enemy.y - r * 0.45, r * 0.08, enemy.x, enemy.y, r * 1.25);
      body.addColorStop(0, lighten(def.color, 0.38));
      body.addColorStop(0.55, def.color);
      body.addColorStop(1, darken(def.color, 0.38));
      ctx.fillStyle = body;
      ctx.strokeStyle = def.accent;
      ctx.lineWidth = 2;
      this.traceEnemy(enemy, 0, 0);
      ctx.fill();
      ctx.stroke();
      if (flash > 0) {
        ctx.globalAlpha = Math.min(1, flash * 1.4);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // Rim light on the upper edge, the same direction as the terrain lighting.
      if (shape.kind === 'circle') {
        ctx.strokeStyle = alpha('#ffffff', 0.35);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y, r - 2, Math.PI * 1.1, Math.PI * 1.6);
        ctx.stroke();
      }

      this.drawEyes(enemy, ball, time, boss, telegraphing);

      ctx.restore();
      ctx.save();

      // Status tints are drawn as thin rings rather than recolouring the body, so
      // the enemy stays identifiable while affected.
      this.drawStatusRings(enemy);

      // The dangerous or armoured arc, drawn on the silhouette.
      if (enemy.armorArc > 0 && defencesIntact(enemy)) {
        const dangerous = hasFlag(enemy, EnemyFlag.Spiked);
        ctx.strokeStyle = dangerous ? this.palette.danger : this.palette.neutral;
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y, enemy.radius + 4, enemy.armorAngle - enemy.armorArc, enemy.armorAngle + enemy.armorArc);
        ctx.stroke();
        ctx.lineCap = 'butt';
        if (dangerous && this.settings.dangerOutlines) {
          // Spikes: a shape cue on top of the colour cue.
          const spikes = 5;
          ctx.fillStyle = this.palette.danger;
          for (let i = 0; i < spikes; i++) {
            const a = enemy.armorAngle - enemy.armorArc + (i / (spikes - 1)) * enemy.armorArc * 2;
            const inner = enemy.radius + 4;
            const outer = enemy.radius + 14;
            ctx.beginPath();
            ctx.moveTo(enemy.x + Math.cos(a - 0.12) * inner, enemy.y + Math.sin(a - 0.12) * inner);
            ctx.lineTo(enemy.x + Math.cos(a) * outer, enemy.y + Math.sin(a) * outer);
            ctx.lineTo(enemy.x + Math.cos(a + 0.12) * inner, enemy.y + Math.sin(a + 0.12) * inner);
            ctx.closePath();
            ctx.fill();
          }
        }
      } else if (!defencesIntact(enemy)) {
        // A breached defence is announced: this is the window the player earned.
        ctx.strokeStyle = this.palette.reward;
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 5]);
        ctx.lineDashOffset = this.motion ? -time * 30 : 0;
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y, enemy.radius + 7, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
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

      // Elites wear a slowly turning crown of dashes: worth noticing, worth more.
      if (elite && !boss) {
        ctx.strokeStyle = this.palette.reward;
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 7]);
        ctx.lineDashOffset = this.motion ? time * 14 : 0;
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y, enemy.radius + 15, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
        ctx.globalAlpha = 1;
      }

      if (hasFlag(enemy, EnemyFlag.Magnetic)) {
        const radius = def.params.pullRadius ?? 280;
        ctx.strokeStyle = def.accent;
        ctx.globalAlpha = 0.16;
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 12]);
        ctx.lineDashOffset = this.motion ? time * 30 : 0;
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y, radius, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
        ctx.globalAlpha = 1;
      }

      if (enemy.stun > 0) {
        // Stun: three orbiting stars, the universal "dazed".
        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < 3; i++) {
          const a = (this.motion ? time * 5 : 0) + (i * TAU) / 3;
          const ox = Math.cos(a) * enemy.radius * 0.7;
          const oy = Math.sin(a) * enemy.radius * 0.22;
          ctx.globalAlpha = 0.55 + 0.35 * Math.sin(a);
          traceStar(ctx, enemy.x + ox, enemy.y - enemy.radius - 10 + oy, 4.5, 1.6, 0);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // Health bar, only when damaged and only for things worth tracking. A
      // trailing ghost shows how much the last hit took.
      if (enemy.hp < enemy.maxHp && enemy.maxHp > 20 && !boss) {
        const w = Math.max(26, enemy.radius * 2.2);
        const x = enemy.x - w / 2;
        const y = enemy.y - enemy.radius - 12;
        const fraction = clamp01(enemy.hp / enemy.maxHp);
        const ghost = clamp01(visual.ghostHp / enemy.maxHp);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x - 1, y - 1, w + 2, 6);
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 0.8;
        ctx.fillRect(x, y, w * ghost, 4);
        ctx.globalAlpha = 1;
        ctx.fillStyle = elite ? this.palette.reward : this.palette.danger;
        ctx.fillRect(x, y, w * fraction, 4);
      }

      ctx.restore();
    }
  }

  private traceEnemy(enemy: Enemy, ox: number, oy: number): void {
    const ctx = this.ctx;
    const shape = enemy.shape;
    ctx.beginPath();
    if (shape.kind === 'circle') {
      ctx.arc(shape.x + ox, shape.y + oy, shape.radius, 0, TAU);
    } else {
      const v = shape.worldVerts;
      ctx.moveTo(v[0] + ox, v[1] + oy);
      for (let i = 2; i < v.length; i += 2) ctx.lineTo(v[i] + ox, v[i + 1] + oy);
      ctx.closePath();
    }
  }

  /**
   * Eyes that follow the ball. The cheapest possible characterisation, and it
   * carries information: an enemy that is looking at you is an enemy that is
   * about to do something about it. Angry brows while winding up, crosses while
   * stunned, a squint on the frame it is hit.
   */
  private drawEyes(enemy: Enemy, ball: Ball, time: number, boss: boolean, angry: boolean): void {
    const r = enemy.radius;
    if (r < 9) return;
    const ctx = this.ctx;
    const dx = ball.x - enemy.x;
    const dy = ball.y - enemy.y;
    const d = Math.hypot(dx, dy) || 1;
    const lookX = dx / d;
    const lookY = dy / d;
    const eyeR = r * (boss ? 0.2 : 0.25);
    const spacing = r * (boss ? 0.3 : 0.36);
    const cx = enemy.x + lookX * r * 0.16;
    const cy = enemy.y - r * 0.08 + lookY * r * 0.1;
    const stunned = enemy.stun > 0;
    const hit = enemy.flash > 0.45;
    const blinkPhase = (time * 0.45 + hash01(enemy.id) * 4) % 4;
    const blinking = this.motion && blinkPhase < 0.1;

    ctx.save();
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      const ex = cx + side * spacing;
      const ey = cy;
      if (stunned || hit || blinking) {
        ctx.strokeStyle = '#0b0e16';
        ctx.lineWidth = Math.max(1.5, eyeR * 0.45);
        ctx.beginPath();
        if (stunned) {
          const k = eyeR * 0.7;
          ctx.moveTo(ex - k, ey - k);
          ctx.lineTo(ex + k, ey + k);
          ctx.moveTo(ex + k, ey - k);
          ctx.lineTo(ex - k, ey + k);
        } else {
          ctx.moveTo(ex - eyeR, ey);
          ctx.lineTo(ex + eyeR, ey);
        }
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = '#f4f7ff';
      ctx.beginPath();
      ctx.arc(ex, ey, eyeR, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#0b0e16';
      ctx.beginPath();
      ctx.arc(ex + lookX * eyeR * 0.42, ey + lookY * eyeR * 0.42, eyeR * (angry ? 0.42 : 0.55), 0, TAU);
      ctx.fill();
      if (angry || boss) {
        ctx.strokeStyle = '#0b0e16';
        ctx.lineWidth = Math.max(1.5, eyeR * 0.4);
        ctx.beginPath();
        // Inner end low, outer end high: a scowl, not a worry.
        ctx.moveTo(ex - side * eyeR * 1.1, ey - eyeR * 0.75);
        ctx.lineTo(ex + side * eyeR * 0.9, ey - eyeR * 1.45);
        ctx.stroke();
      }
    }
    ctx.restore();
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
    const speed = Math.hypot(ball.vx, ball.vy);
    const tier = comboTier(render.world.combo.value);
    const baseTrail = mix(ballClass.color, ballClass.accent, 0.45);
    const trailColor = tier >= 2 ? mix(baseTrail, this.palette.combo, Math.min(0.75, (tier - 1) * 0.22)) : baseTrail;

    // Trail: a continuous ribbon that tapers with age, drawn additively. It is the
    // clearest signal of where the ball has just been, and the main reason a fast
    // ball stays trackable.
    this.drawTrail(ball, trailColor);

    // Speed lines once the ball is genuinely fast: a velocity cue that survives a
    // still frame.
    if (speed > 950 && this.motion) {
      const k = clamp01((speed - 950) / 700);
      const dirX = ball.vx / speed;
      const dirY = ball.vy / speed;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) {
        const lateral = (hash01(i + Math.floor(render.time * 30)) - 0.5) * ball.radius * 3;
        const back = ball.radius * (1.6 + hash01(i * 3 + Math.floor(render.time * 30)) * 2);
        const ox = ball.x - dirX * back - dirY * lateral;
        const oy = ball.y - dirY * back + dirX * lateral;
        ctx.globalAlpha = 0.35 * k;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(ox - dirX * (18 + k * 30), oy - dirY * (18 + k * 30));
        ctx.stroke();
      }
      ctx.restore();
    }

    const flashing = ball.flash > 0.01;
    const phasing = ball.phase > 0;
    const invulnerable = ball.iframes > 0;
    const r = ball.radius;

    // Glow. The ball's glow is the brightest thing in the arena, which is what
    // keeps it the visual protagonist.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const perfectHeat = clamp01(ball.perfectStreak / 5);
    drawGlow(ctx, ballClass.accent, ball.x, ball.y, r * 4.2, 0.5 + perfectHeat * 0.3 + ball.flash * 0.3);
    if (perfectHeat > 0) drawGlow(ctx, this.palette.perfect, ball.x, ball.y, r * 6, perfectHeat * 0.35);
    ctx.restore();

    ctx.save();
    ctx.translate(ball.x, ball.y);

    if (this.motion) {
      // Stretch along the velocity while flying, squash along the normal on
      // impact. Together they are what make a collision feel like a collision
      // rather than a change of sign.
      const stretch = clamp01(speed / 1500) * 0.24;
      if (stretch > 0.01) {
        const angle = Math.atan2(ball.vy, ball.vx);
        ctx.rotate(angle);
        ctx.scale(1 + stretch, 1 - stretch * 0.6);
        ctx.rotate(-angle);
      }
      if (ball.squash > 0.01) {
        const squash = ball.squash * 0.5;
        ctx.rotate(ball.squashAngle);
        ctx.scale(1 - squash, 1 + squash * 0.7);
        ctx.rotate(-ball.squashAngle);
      }
    }

    ctx.globalAlpha = phasing ? 0.45 : 1;
    const shade = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.05, 0, 0, r * 1.05);
    shade.addColorStop(0, lighten(ballClass.color, 0.65));
    shade.addColorStop(0.55, ballClass.color);
    shade.addColorStop(1, darken(ballClass.color, 0.3));
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    if (flashing) {
      ctx.globalAlpha = (phasing ? 0.45 : 1) * clamp01(ball.flash);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.globalAlpha = phasing ? 0.45 : 1;
    }

    ctx.strokeStyle = phasing ? '#c0a0ff' : ballClass.accent;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Specular highlight: fixed to the light, not to the spin.
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.36, -r * 0.42, r * 0.26, r * 0.16, -0.6, 0, TAU);
    ctx.fill();

    // A rotation mark so spin is visible; without it a circle reads as static.
    ctx.rotate(ball.rotation);
    ctx.strokeStyle = ballClass.accent;
    ctx.globalAlpha = phasing ? 0.4 : 0.8;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-r * 0.55, 0);
    ctx.lineTo(r * 0.55, 0);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();

    // Armed: the press registered and the window is open. Whiffed: it closed
    // without a contact. Both are shown on the ball itself, because that is where
    // the player is looking when they press.
    if (ball.armState === 'armed') {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = this.palette.perfect;
      ctx.lineWidth = 2.5;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, r + 5, 0, TAU);
      ctx.stroke();
      ctx.restore();
    } else if (ball.armState === 'whiffed') {
      ctx.save();
      ctx.strokeStyle = this.palette.neutral;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, r + 5, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // Shields are drawn as discrete arcs: a countable resource should look countable.
    if (ball.shield > 0) {
      ctx.save();
      ctx.strokeStyle = this.palette.shield;
      ctx.lineWidth = 3;
      const segments = Math.min(8, ball.shield);
      for (let i = 0; i < segments; i++) {
        const start = (i / segments) * TAU + render.time * 0.6;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, r + 9, start, start + TAU / segments - 0.22);
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
      ctx.arc(ball.x, ball.y, r + 4, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // Air resources as pips above the ball: dashes and air bounces.
    this.drawAirPips(ball);
  }

  /**
   * The trail as one tapered ribbon: a polygon whose width follows sample age,
   * filled with a gradient from head to tail, plus a thin hot core. Drawing it as
   * one shape (rather than a stroke per segment) avoids the beaded look additive
   * overlaps give, and it is cheaper.
   */
  private drawTrail(ball: Ball, color: string): void {
    const ctx = this.ctx;
    const points: Array<{ x: number; y: number; t: number }> = [{ x: ball.x, y: ball.y, t: 1 }];
    let perfect = false;
    const samples = ball.trail.filter((s) => s.age <= TRAIL_AGE).sort((a, b) => a.age - b.age);
    for (const sample of samples) {
      const last = points[points.length - 1];
      // A teleport or respawn is a break in the trail, not a streak across the room.
      if (Math.hypot(sample.x - last.x, sample.y - last.y) > 140) break;
      points.push({ x: sample.x, y: sample.y, t: 1 - sample.age / TRAIL_AGE });
      if (sample.perfect && sample.age < 0.16) perfect = true;
    }
    if (points.length < 3) return;
    const tint = perfect ? this.palette.perfect : color;
    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      let dx = next.x - prev.x;
      let dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const half = ball.radius * (0.08 + points[i].t * 0.82);
      left.push(points[i].x - dy * half, points[i].y + dx * half);
      right.push(points[i].x + dy * half, points[i].y - dx * half);
    }
    const head = points[0];
    const tail = points[points.length - 1];
    const gradient = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y);
    gradient.addColorStop(0, alpha(tint, 0.6));
    gradient.addColorStop(0.45, alpha(tint, 0.22));
    gradient.addColorStop(1, alpha(tint, 0));

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(left[0], left[1]);
    for (let i = 2; i < left.length; i += 2) ctx.lineTo(left[i], left[i + 1]);
    for (let i = right.length - 2; i >= 0; i -= 2) ctx.lineTo(right[i], right[i + 1]);
    ctx.closePath();
    ctx.fill();

    const core = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y);
    core.addColorStop(0, 'rgba(255,255,255,0.5)');
    core.addColorStop(0.4, 'rgba(255,255,255,0)');
    ctx.strokeStyle = core;
    ctx.lineWidth = ball.radius * 0.45;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(head.x, head.y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
    ctx.restore();
  }

  private drawAirPips(ball: Ball): void {
    const ctx = this.ctx;
    const total = ball.airBounces + ball.airDashes;
    if (total <= 0) return;
    ctx.save();
    const y = ball.y - ball.radius - 15;
    const spacing = 9;
    const startX = ball.x - ((total - 1) * spacing) / 2;
    let index = 0;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < ball.airBounces; i++, index++) {
      ctx.fillStyle = this.palette.perfect;
      ctx.beginPath();
      ctx.arc(startX + index * spacing, y, 3, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
    for (let i = 0; i < ball.airDashes; i++, index++) {
      ctx.fillStyle = this.palette.reward;
      ctx.beginPath();
      const x = startX + index * spacing;
      ctx.moveTo(x, y - 3.6);
      ctx.lineTo(x + 3.6, y);
      ctx.lineTo(x, y + 3.6);
      ctx.lineTo(x - 3.6, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------ prediction -- */

  /**
   * The predicted impact point and its timing ring.
   *
   * This is the single most important piece of information design in the game: it
   * is what makes the Perfect Bounce learnable. The ring shrinks toward the
   * contact point like an osu! approach circle, and the player presses when it
   * closes. Without it the timing window is invisible, and the core skill would
   * be guesswork.
   */
  private drawPrediction(world: World, time: number): void {
    if (this.settings.trajectory === 'off') return;
    const ctx = this.ctx;
    const prediction = world.prediction;

    if (this.settings.trajectory === 'full' && world.predictedPath.length >= 4) {
      ctx.save();
      ctx.strokeStyle = this.palette.neutral;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 7]);
      ctx.lineDashOffset = this.motion ? -time * 40 : 0;
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
    ctx.lineCap = 'round';
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
        // The target circle: what the approach ring is closing onto.
        ctx.globalAlpha = inWindow ? 0.9 : 0.35;
        ctx.strokeStyle = this.palette.perfect;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(prediction.x, prediction.y, 10, 0, TAU);
        ctx.stroke();
        if (inWindow) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          drawGlow(ctx, this.palette.perfect, prediction.x, prediction.y, 34, 0.75);
          ctx.restore();
        }
        ctx.globalAlpha = inWindow ? 0.95 : 0.3 + (1 - t) * 0.35;
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

  private drawFields(world: World, time: number): void {
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

    // Damaging fields also get a hard, slowly turning outline so they are not
    // mistaken for glow.
    for (const field of world.fields) {
      if (!field.active || field.kind === 'heal') continue;
      ctx.strokeStyle = this.palette.danger;
      ctx.globalAlpha = 0.3 * clamp01(field.life / field.maxLife);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([10, 8]);
      ctx.lineDashOffset = this.motion ? time * 20 : 0;
      ctx.beginPath();
      ctx.arc(field.x, field.y, field.radius, 0, TAU);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.globalAlpha = 1;
  }

  private drawProjectiles(world: World): void {
    const ctx = this.ctx;
    for (const projectile of world.projectiles) {
      if (!projectile.active) continue;
      const hostile = projectile.faction === 'hostile';
      ctx.save();
      // A motion streak makes fast bullets readable at 60fps.
      const speed = Math.hypot(projectile.vx, projectile.vy);
      if (speed > 120) {
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = projectile.color;
        ctx.lineCap = 'round';
        ctx.lineWidth = projectile.radius * 1.3;
        ctx.beginPath();
        ctx.moveTo(projectile.x, projectile.y);
        ctx.lineTo(projectile.x - (projectile.vx / speed) * 20, projectile.y - (projectile.vy / speed) * 20);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(ctx, projectile.color, projectile.x, projectile.y, projectile.radius * 3.4, 0.55);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = projectile.color;
      ctx.strokeStyle = hostile ? this.palette.danger : this.palette.safe;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(projectile.x, projectile.y, projectile.radius, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(projectile.x, projectile.y, projectile.radius * 0.45, 0, TAU);
      ctx.fill();
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
        ctx.globalCompositeOperation = 'lighter';
        const twinkle = this.motion ? 0.5 + 0.5 * Math.sin(time * 7 + pickup.id * 1.3) : 0.6;
        drawGlow(ctx, this.palette.reward, pickup.x, pickup.y, pickup.radius * 3, 0.35 + twinkle * 0.25);
        ctx.globalCompositeOperation = 'source-over';
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
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.beginPath();
        ctx.moveTo(0, -pickup.radius);
        ctx.lineTo(pickup.radius * 0.35, -pickup.radius * 0.1);
        ctx.lineTo(0, 0);
        ctx.closePath();
        ctx.fill();
      } else {
        const bob = this.motion ? Math.sin(time * 2.4 + pickup.id) * 4 : 0;
        ctx.translate(pickup.x, pickup.y + bob);
        const color = pickup.kind === 'heal' ? this.palette.safe : this.palette.reward;
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(ctx, color, 0, 0, pickup.radius * 3.2, 0.5);
        ctx.globalCompositeOperation = 'source-over';
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
      const life = clamp01(p.life / p.maxLife);
      const fade = FxSystem.fade(p.life, p.maxLife);
      ctx.globalAlpha = fade;
      ctx.fillStyle = p.color;
      if (p.kind === 0) {
        const speed = Math.hypot(p.vx, p.vy) || 1;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * (0.5 + life * 0.5);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - (p.vx / speed) * p.size * 4, p.y - (p.vy / speed) * p.size * 4);
        ctx.stroke();
      } else if (p.kind === 3) {
        // Debris is solid, not light: drawn normally so it reads as matter.
        ctx.globalCompositeOperation = 'source-over';
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        const s = p.size * (0.5 + life * 0.5);
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.restore();
        ctx.globalCompositeOperation = 'lighter';
      } else if (p.kind === 4) {
        // Flare: grows fast, then collapses to a point.
        const grow = easeOutCubic((1 - life) / 0.35);
        const length = p.size * (0.4 + 0.6 * grow) * (0.35 + 0.65 * life);
        ctx.globalAlpha = life;
        drawGlow(ctx, p.color, p.x, p.y, length * 0.9, 0.9);
        ctx.fillStyle = '#ffffff';
        traceStar(ctx, p.x, p.y, length, length * 0.12, p.rotation);
        ctx.fill();
      } else if (p.kind === 5) {
        drawGlow(ctx, p.color, p.x, p.y, p.size * (0.3 + life * 0.7), fade);
      } else {
        // Dots shrink as well as fade, so bursts collapse rather than dissolve.
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.35 + life * 0.65), 0, TAU);
        ctx.fill();
      }
    }
    for (const r of this.fx.rings.items) {
      if (!r.active) continue;
      const life = clamp01(r.life / r.maxLife);
      ctx.globalAlpha = FxSystem.fade(r.life, r.maxLife) * 0.85;
      ctx.strokeStyle = r.color;
      // Rings thin out as they expand, like a real shockwave losing energy.
      ctx.lineWidth = r.width * (0.35 + life * 0.9);
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
    ctx.lineJoin = 'round';
    for (const arc of this.fx.arcs.items) {
      if (!arc.active) continue;
      const points = this.fx.boltPoints(arc);
      ctx.globalAlpha = FxSystem.fade(arc.life, arc.maxLife);
      ctx.strokeStyle = arc.color;
      ctx.lineWidth = 7;
      ctx.globalAlpha *= 0.35;
      ctx.beginPath();
      ctx.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
      ctx.stroke();
      ctx.globalAlpha = FxSystem.fade(arc.life, arc.maxLife);
      ctx.lineWidth = 3;
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
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const t of this.fx.texts.items) {
      if (!t.active) continue;
      // Texts emitted with no position (heals, combo) follow the ball.
      const follow = t.x === 0 && t.y === 0;
      const x = follow ? world.ball.x : t.x;
      const y = follow ? world.ball.y - 34 - (1 - t.life / t.maxLife) * 26 : t.y;
      const age = t.maxLife - t.life;
      // Pop: overshoot to 1.5x in 60ms, settle by 160ms.
      let scale = 1;
      if (this.motion) {
        if (age < 0.06) scale = 0.5 + (age / 0.06) * 1.0;
        else if (age < 0.16) scale = 1.5 - ((age - 0.06) / 0.1) * 0.5;
      }
      const life = t.life / t.maxLife;
      ctx.globalAlpha = life < 0.35 ? life / 0.35 : 1;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(this.motion ? t.tilt : 0);
      ctx.scale(scale, scale);
      ctx.font = t.heavy ? `${t.size}px ${DISPLAY_FONT}` : `700 ${t.size}px ${UI_FONT}`;
      ctx.lineWidth = Math.max(3, t.size * 0.26);
      ctx.strokeStyle = 'rgba(6,8,14,0.85)';
      ctx.strokeText(t.text, 0, 0);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * Screen-space callouts. They slam in at 2.4x and settle (a 160ms ease-out),
   * sit on a dark band so they read over anything, then lift and fade.
   */
  private drawCallouts(): void {
    const ctx = this.ctx;
    const w = this.viewWidth;
    const h = this.viewHeight;
    const scaleUi = this.settings.uiScale;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const c of this.fx.callouts.items) {
      if (!c.active || c.delay > 0) continue;
      const age = c.maxLife - c.life;
      const outT = clamp01((0.35 - c.life) / 0.35);
      const slam = this.motion ? 1 + (1 - easeOutCubic(age / 0.16)) * 1.4 : 1;
      const lift = this.motion ? outT * 18 : 0;
      const opacity = clamp01(age / 0.06) * (1 - outT);
      const size = c.size * scaleUi;
      const y = h * c.anchor - lift;

      // Band: wipes open from the centre.
      const band = easeOutCubic(age / 0.22);
      ctx.globalAlpha = opacity * 0.55;
      const bandGradient = ctx.createLinearGradient(0, 0, w, 0);
      bandGradient.addColorStop(0, 'rgba(0,0,0,0)');
      bandGradient.addColorStop(0.5, 'rgba(4,6,12,0.9)');
      bandGradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = bandGradient;
      const bandW = w * 0.9 * band;
      ctx.fillRect(w / 2 - bandW / 2, y - size * 0.72, bandW, size * 1.44 + (c.sub ? size * 0.3 : 0));
      ctx.globalAlpha = opacity;
      ctx.fillStyle = c.color;
      ctx.fillRect(w / 2 - bandW * 0.3, y - size * 0.72, bandW * 0.6, 2);
      ctx.fillRect(w / 2 - bandW * 0.3, y + size * 0.72 + (c.sub ? size * 0.3 : 0) - 2, bandW * 0.6, 2);

      ctx.save();
      ctx.translate(w / 2, y);
      ctx.scale(slam, slam);
      ctx.font = `${size}px ${DISPLAY_FONT}`;
      ctx.lineWidth = size * 0.14;
      ctx.strokeStyle = 'rgba(4,6,12,0.9)';
      ctx.strokeText(c.text, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = opacity * 0.5;
      ctx.fillStyle = c.color;
      ctx.fillText(c.text, 0, 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = opacity;
      ctx.fillStyle = lighten(c.color, 0.25);
      ctx.fillText(c.text, 0, 0);
      if (c.sub) {
        ctx.font = `700 ${Math.round(size * 0.26)}px ${UI_FONT}`;
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = opacity * 0.8;
        ctx.fillText(c.sub.split('').join(' '), 0, size * 0.62);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  private drawVignette(world: World): void {
    const ctx = this.ctx;
    const w = this.viewWidth;
    const h = this.viewHeight;
    if (!this.vignette || this.vignette.w !== w || this.vignette.h !== h) {
      const gradient = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.78);
      gradient.addColorStop(0, 'rgba(0,0,0,0)');
      gradient.addColorStop(1, 'rgba(0,0,0,0.55)');
      this.vignette = { w, h, gradient };
    }
    ctx.fillStyle = this.vignette.gradient;
    ctx.fillRect(0, 0, w, h);

    // A high combo tints the frame edges in the combo colour: the screen itself
    // tells you the run is hot.
    const tier = comboTier(world.combo.value);
    if (tier >= 3) {
      const heat = (tier - 2) / 3;
      const edge = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.5, w / 2, h / 2, Math.max(w, h) * 0.8);
      edge.addColorStop(0, 'rgba(0,0,0,0)');
      edge.addColorStop(1, alpha(this.palette.combo, 0.16 * heat * (0.6 + 0.4 * comboFill(world.combo))));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = edge;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
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

  /**
   * Room entry: an iris opens on the ball. It tells the player where they are
   * before anything else happens, and it hides the frame where the room swaps.
   */
  private drawIris(world: World): void {
    const t = world.roomTime / IRIS_TIME;
    if (t >= 1) return;
    const ctx = this.ctx;
    const w = this.viewWidth;
    const h = this.viewHeight;
    ctx.save();
    if (!this.motion) {
      ctx.globalAlpha = 1 - clamp01(t);
      ctx.fillStyle = '#05070c';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
      return;
    }
    const centre = this.camera.worldToScreen(world.ball.x, world.ball.y, w, h);
    const maxR = Math.hypot(Math.max(centre.x, w - centre.x), Math.max(centre.y, h - centre.y));
    const r = Math.max(0, easeInOutCubic(t) * maxR);
    ctx.fillStyle = '#05070c';
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.arc(centre.x, centre.y, r, 0, TAU);
    ctx.fill('evenodd');
    ctx.strokeStyle = this.palette.perfect;
    ctx.globalAlpha = 0.6 * (1 - t);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, r, 0, TAU);
    ctx.stroke();
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

function toHexAlpha(value: number): string {
  return Math.round(clamp(value, 0, 1) * 255)
    .toString(16)
    .padStart(2, '0');
}

/** Re-exported for the HUD, which needs the same projectile/pickup colours. */
export { fieldColor };
export type { Pickup, Projectile, Prop };
