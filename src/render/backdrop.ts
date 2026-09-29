/**
 * The title-screen backdrop.
 *
 * Title screens in the games this borrows from (Peglin, Ball x Pit, Celeste) show
 * the game rather than describe it: something is already moving before you press
 * anything. So the menu sits over a small live scene - a handful of ball classes
 * bouncing across a lit floor with trails, squash and a bloom, on the same
 * parallax ridgelines the arena uses.
 *
 * This is decoration with its own tiny physics loop. It never touches the real
 * simulation or its seeded RNG, so it cannot perturb reproducibility.
 */

import { clamp, TAU } from '../core/math';
import { BALL_CLASSES } from '../content/balls';
import { darken, drawGlow, hash01, lighten, mix } from './paint';

interface DemoBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  accent: string;
  squash: number;
  squashAngle: number;
  spin: number;
  trail: Array<{ x: number; y: number }>;
}

interface Burst {
  x: number;
  y: number;
  life: number;
  color: string;
}

export class MenuBackdrop {
  private balls: DemoBall[] = [];
  private bursts: Burst[] = [];
  private width = 0;
  private height = 0;
  private time = 0;

  private seed(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const classes = BALL_CLASSES.slice(0, 5);
    this.balls = classes.map((ballClass, i) => ({
      x: width * (0.12 + i * 0.19),
      y: height * (0.2 + hash01(i + 3) * 0.3),
      vx: (hash01(i * 7 + 1) > 0.5 ? 1 : -1) * (120 + hash01(i * 5) * 160),
      vy: 0,
      r: 11 + hash01(i * 11) * 7,
      color: ballClass.color,
      accent: ballClass.accent,
      squash: 0,
      squashAngle: 0,
      spin: 0,
      trail: [],
    }));
  }

  draw(ctx: CanvasRenderingContext2D, width: number, height: number, dt: number, reducedMotion: boolean): void {
    if (this.balls.length === 0 || Math.abs(width - this.width) > 40 || Math.abs(height - this.height) > 40) {
      this.seed(width, height);
    }
    this.width = width;
    this.height = height;
    const step = reducedMotion ? 0 : clamp(dt, 0, 1 / 20);
    this.time += step;
    const floor = height * 0.86;

    // Sky
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#0a0e1c');
    sky.addColorStop(0.6, '#111a30');
    sky.addColorStop(1, '#0b0f1a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, '#3a6fd8', width * 0.5, height * 0.18, Math.max(width, height) * 0.7, 0.22);
    drawGlow(ctx, '#ff7ab0', width * 0.85, height * 0.75, Math.max(width, height) * 0.45, 0.08);
    ctx.restore();

    // Ridgelines
    const layers: Array<[string, number, number, number]> = [
      ['#172241', 0.5, 0.55, 4],
      ['#121a33', 0.34, 0.7, 9],
      ['#0d1326', 0.2, 0.9, 16],
    ];
    for (const [index, [color, heightScale, opacity, speed]] of layers.entries()) {
      ctx.fillStyle = color;
      ctx.globalAlpha = opacity;
      const points = 18;
      const span = width + 200;
      const stepX = span / points;
      const scroll = (this.time * speed) % stepX;
      ctx.beginPath();
      ctx.moveTo(-100, floor + 2);
      for (let i = 0; i <= points + 1; i++) {
        const k = i + Math.floor((this.time * speed) / stepX);
        const peak = (0.35 + hash01(k * 3.1 + index * 50) * 0.65) * height * heightScale;
        ctx.lineTo(-100 + i * stepX - scroll, floor - (k % 2 === 0 ? peak : peak * 0.6));
      }
      ctx.lineTo(width + 100, floor + 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Floor: a lit edge over a dark slab, with a perspective grid receding.
    ctx.fillStyle = '#0a0f1c';
    ctx.fillRect(0, floor, width, height - floor);
    ctx.strokeStyle = '#6aa8f0';
    ctx.globalAlpha = 0.1;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = -12; i <= 12; i++) {
      ctx.moveTo(width / 2 + i * 40, floor);
      ctx.lineTo(width / 2 + i * 160, height);
    }
    for (let j = 1; j < 5; j++) {
      const y = floor + (height - floor) * (j / 5) ** 1.6;
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = '#8fc3ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, floor);
    ctx.lineTo(width, floor);
    ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // Motes
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#9cc4ff';
    for (let i = 0; i < 40; i++) {
      const a = hash01(i * 3.7 + 1);
      const b = hash01(i * 9.1 + 2);
      const x = ((a * width + Math.sin(this.time * 0.3 + i) * 20) % width + width) % width;
      const y = (((b * floor - this.time * (6 + b * 12)) % floor) + floor) % floor;
      ctx.globalAlpha = 0.15 + 0.3 * (0.5 + 0.5 * Math.sin(this.time * (1 + a * 2) + i));
      ctx.fillRect(x, y, 1.5 + a, 1.5 + a);
    }
    ctx.restore();

    // Physics: gravity, a floor that always returns the ball high, soft walls.
    for (const ball of this.balls) {
      if (step > 0) {
        ball.vy += 1300 * step;
        ball.x += ball.vx * step;
        ball.y += ball.vy * step;
        ball.spin += (ball.vx / ball.r) * step;
        if (ball.y + ball.r > floor) {
          ball.y = floor - ball.r;
          const target = 700 + hash01(Math.floor(this.time * 3) + ball.r) * 380;
          ball.vy = -Math.max(target, Math.abs(ball.vy) * 0.7);
          ball.squash = 1;
          ball.squashAngle = Math.PI / 2;
          this.bursts.push({ x: ball.x, y: floor, life: 0.35, color: ball.accent });
        }
        if (ball.x < ball.r || ball.x > width - ball.r) {
          ball.x = clamp(ball.x, ball.r, width - ball.r);
          ball.vx = -ball.vx;
          ball.squash = 0.7;
          ball.squashAngle = 0;
        }
        ball.squash = Math.max(0, ball.squash - step * 5);
        ball.trail.unshift({ x: ball.x, y: ball.y });
        if (ball.trail.length > 18) ball.trail.pop();
      }
    }

    // Floor impact rings
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const burst of this.bursts) {
      burst.life -= step;
      const t = 1 - burst.life / 0.35;
      ctx.globalAlpha = Math.max(0, 1 - t) * 0.8;
      ctx.strokeStyle = burst.color;
      ctx.lineWidth = 3 * (1 - t) + 0.5;
      ctx.beginPath();
      ctx.ellipse(burst.x, burst.y, 10 + t * 60, 3 + t * 10, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
    this.bursts = this.bursts.filter((b) => b.life > 0);

    for (const ball of this.balls) {
      // Floor shadow shrinks with height.
      const height01 = clamp((floor - ball.y) / (floor * 0.8), 0, 1);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.ellipse(ball.x, floor + 3, ball.r * (1.3 - height01 * 0.7), ball.r * 0.28 * (1 - height01 * 0.6), 0, 0, TAU);
      ctx.fill();

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      const trailColor = mix(ball.color, ball.accent, 0.5);
      for (let i = 1; i < ball.trail.length; i++) {
        const t = 1 - i / ball.trail.length;
        ctx.globalAlpha = t * t * 0.4;
        ctx.strokeStyle = trailColor;
        ctx.lineWidth = ball.r * 2 * (0.15 + t * 0.75);
        ctx.beginPath();
        ctx.moveTo(ball.trail[i - 1].x, ball.trail[i - 1].y);
        ctx.lineTo(ball.trail[i].x, ball.trail[i].y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      drawGlow(ctx, ball.accent, ball.x, ball.y, ball.r * 4.5, 0.55);
      ctx.restore();

      ctx.save();
      ctx.translate(ball.x, ball.y);
      const speed = Math.hypot(ball.vx, ball.vy);
      const stretch = clamp(speed / 1500, 0, 1) * 0.2;
      const angle = Math.atan2(ball.vy, ball.vx);
      ctx.rotate(angle);
      ctx.scale(1 + stretch, 1 - stretch * 0.6);
      ctx.rotate(-angle);
      if (ball.squash > 0) {
        ctx.rotate(ball.squashAngle);
        ctx.scale(1 - ball.squash * 0.4, 1 + ball.squash * 0.3);
        ctx.rotate(-ball.squashAngle);
      }
      const shade = ctx.createRadialGradient(-ball.r * 0.35, -ball.r * 0.4, ball.r * 0.05, 0, 0, ball.r);
      shade.addColorStop(0, lighten(ball.color, 0.65));
      shade.addColorStop(0.55, ball.color);
      shade.addColorStop(1, darken(ball.color, 0.3));
      ctx.fillStyle = shade;
      ctx.beginPath();
      ctx.arc(0, 0, ball.r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = ball.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      ctx.ellipse(-ball.r * 0.36, -ball.r * 0.42, ball.r * 0.26, ball.r * 0.16, -0.6, 0, TAU);
      ctx.fill();
      ctx.rotate(ball.spin);
      ctx.strokeStyle = ball.accent;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(-ball.r * 0.55, 0);
      ctx.lineTo(ball.r * 0.55, 0);
      ctx.stroke();
      ctx.restore();
    }

    // Vignette
    const vignette = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.max(width, height) * 0.75);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
  }
}
