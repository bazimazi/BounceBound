/**
 * Camera.
 *
 * Rooms are single-screen arenas, so the camera's job is not to follow the ball
 * around a large level - it is to make a fixed space feel alive without ever
 * costing the player information. Three effects, all subordinate to readability:
 *
 *  - A small lead offset toward the ball, so the ball sits slightly off centre in
 *    the direction it is travelling. This buys a few dozen pixels of look-ahead.
 *  - A zoom pulse on heavy impacts, which sells weight.
 *  - Trauma-driven shake (offset = trauma^2 x smooth noise, per Eiserloh's
 *    "Juicing Your Cameras With Math"), decaying linearly, scaled by a user setting
 *    and fully disableable. Smooth noise rather than white noise: random offsets
 *    every frame read as jitter, a continuous wobble reads as impact.
 *  - A directional kick along the impact, which springs back. Nuclear Throne and
 *    Celeste both push the camera *with* the hit; it is what makes a collision
 *    feel like it had a direction rather than just a magnitude.
 *
 * Every effect is clamped so the whole arena always stays on screen. A camera
 * that hides a hazard is worse than no camera movement at all.
 */

import { clamp, damp, lerp } from '../core/math';
import { Rng } from '../core/rng';

export interface CameraLimits {
  roomWidth: number;
  roomHeight: number;
  viewWidth: number;
  viewHeight: number;
}

export class Camera {
  /** Centre in world space. */
  x = 0;
  y = 0;
  /** Current scale; 1 means the room exactly fills the view. */
  zoom = 1;
  /** Accumulated shake energy in [0, 1]. */
  trauma = 0;
  /** Shake offsets applied this frame, exposed for effects that must match. */
  shakeX = 0;
  shakeY = 0;
  /** Extra rotation from trauma, in radians. */
  roll = 0;
  /** Directional kick offset in screen pixels, sprung back toward zero. */
  kickX = 0;
  kickY = 0;
  private kickVX = 0;
  private kickVY = 0;
  /** Running clock for the shake noise. */
  private noiseTime = 0;
  private readonly noisePhase: number[];
  /** Base zoom that fits the room into the view. */
  private fitZoom = 1;
  private targetZoom = 1;
  private readonly rng = new Rng('camera');
  /** 0 disables shake entirely, from the accessibility setting. */
  shakeScale = 1;
  /** 0 disables lead and zoom pulses (reduced motion). */
  motionScale = 1;

  constructor() {
    this.noisePhase = Array.from({ length: 9 }, () => this.rng.range(0, Math.PI * 2));
  }

  configure(limits: CameraLimits): void {
    this.fitZoom = Math.min(limits.viewWidth / limits.roomWidth, limits.viewHeight / limits.roomHeight);
    this.zoom = this.fitZoom;
    this.targetZoom = this.fitZoom;
    this.x = limits.roomWidth / 2;
    this.y = limits.roomHeight / 2;
  }

  /** Requests a zoom pulse; `amount` is a fraction, e.g. 0.04 for a 4% punch. */
  punch(amount: number): void {
    if (this.motionScale <= 0) return;
    this.targetZoom = this.fitZoom * (1 + amount * this.motionScale);
  }

  /** Adds shake energy. Intensity is 0..1-ish; values above 1 are clamped. */
  shake(intensity: number): void {
    this.trauma = Math.min(1, this.trauma + intensity * 0.6);
  }

  /**
   * Pushes the view along a direction, in pixels. The kick is an impulse into a
   * stiff damped spring, so it snaps out and settles back within ~150ms.
   */
  kick(dirX: number, dirY: number, pixels: number): void {
    const scale = this.shakeScale * this.motionScale;
    if (scale <= 0) return;
    const len = Math.hypot(dirX, dirY) || 1;
    this.kickVX += (dirX / len) * pixels * 38 * scale;
    this.kickVY += (dirY / len) * pixels * 38 * scale;
  }

  /** Sum of three incommensurate sines: cheap, smooth, never visibly periodic. */
  private noise(channel: number, t: number): number {
    const p = this.noisePhase;
    const o = channel * 3;
    return Math.sin(t * 1.0 + p[o]) * 0.5 + Math.sin(t * 2.31 + p[o + 1]) * 0.3 + Math.sin(t * 4.77 + p[o + 2]) * 0.2;
  }

  update(
    dt: number,
    ball: { x: number; y: number; vx: number; vy: number },
    limits: CameraLimits,
  ): void {
    // Lead toward the ball, capped so the arena never leaves the frame.
    const leadStrength = 0.09 * this.motionScale;
    const maxLead = 46 * this.motionScale;
    const targetX = limits.roomWidth / 2 + clamp((ball.x - limits.roomWidth / 2) * leadStrength + ball.vx * 0.02, -maxLead, maxLead);
    const targetY = limits.roomHeight / 2 + clamp((ball.y - limits.roomHeight / 2) * leadStrength + ball.vy * 0.015, -maxLead, maxLead);
    this.x = damp(this.x, targetX, 6, dt);
    this.y = damp(this.y, targetY, 6, dt);

    this.targetZoom = damp(this.targetZoom, this.fitZoom, 7, dt);
    this.zoom = damp(this.zoom, this.targetZoom, 12, dt);

    // Trauma decays quickly: shake that outlives its cause reads as a bug.
    this.trauma = Math.max(0, this.trauma - dt * 2.4);
    this.noiseTime += dt * 34;
    const shake = this.trauma * this.trauma;
    const magnitude = shake * 20 * this.shakeScale;
    if (magnitude > 0.01) {
      this.shakeX = this.noise(0, this.noiseTime) * magnitude;
      this.shakeY = this.noise(1, this.noiseTime + 17) * magnitude;
      this.roll = this.noise(2, this.noiseTime * 0.8 + 41) * shake * 0.035 * this.shakeScale;
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
      this.roll = 0;
    }

    // Critically-damped-ish spring for the kick: stiffness 900, damping 48.
    const step = Math.min(dt, 1 / 30);
    this.kickVX += (-900 * this.kickX - 48 * this.kickVX) * step;
    this.kickVY += (-900 * this.kickY - 48 * this.kickVY) * step;
    this.kickX += this.kickVX * step;
    this.kickY += this.kickVY * step;
    this.shakeX += this.kickX;
    this.shakeY += this.kickY;
  }

  /** Applies the camera transform to a canvas context. */
  apply(ctx: CanvasRenderingContext2D, viewWidth: number, viewHeight: number): void {
    ctx.translate(viewWidth / 2 + this.shakeX, viewHeight / 2 + this.shakeY);
    if (this.roll !== 0) ctx.rotate(this.roll);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x, -this.y);
  }

  /** Converts a screen point to world space, for mouse aiming. */
  screenToWorld(sx: number, sy: number, viewWidth: number, viewHeight: number): { x: number; y: number } {
    return {
      x: (sx - viewWidth / 2 - this.shakeX) / this.zoom + this.x,
      y: (sy - viewHeight / 2 - this.shakeY) / this.zoom + this.y,
    };
  }

  /** Converts a world point to screen space, ignoring roll. */
  worldToScreen(wx: number, wy: number, viewWidth: number, viewHeight: number): { x: number; y: number } {
    return {
      x: (wx - this.x) * this.zoom + viewWidth / 2 + this.shakeX,
      y: (wy - this.y) * this.zoom + viewHeight / 2 + this.shakeY,
    };
  }

  /** Parallax offset for a background layer at the given depth (0 = far). */
  parallax(depth: number, limits: CameraLimits): { x: number; y: number } {
    const dx = (this.x - limits.roomWidth / 2) * depth;
    const dy = (this.y - limits.roomHeight / 2) * depth;
    return { x: -dx * this.motionScale, y: -dy * this.motionScale };
  }

  get baseZoom(): number {
    return this.fitZoom;
  }

  /** Blended zoom used by transitions. */
  setTransitionZoom(t: number): void {
    this.zoom = lerp(this.fitZoom * 0.92, this.fitZoom, t);
  }
}
