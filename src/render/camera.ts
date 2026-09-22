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
 *  - Trauma-driven shake, decaying exponentially, scaled by a user setting and
 *    fully disableable.
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
  /** Base zoom that fits the room into the view. */
  private fitZoom = 1;
  private targetZoom = 1;
  private readonly rng = new Rng('camera');
  /** 0 disables shake entirely, from the accessibility setting. */
  shakeScale = 1;
  /** 0 disables lead and zoom pulses (reduced motion). */
  motionScale = 1;

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
    const magnitude = this.trauma * this.trauma * 22 * this.shakeScale;
    if (magnitude > 0.01) {
      this.shakeX = (this.rng.next() * 2 - 1) * magnitude;
      this.shakeY = (this.rng.next() * 2 - 1) * magnitude;
      this.roll = (this.rng.next() * 2 - 1) * this.trauma * 0.012 * this.shakeScale;
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
      this.roll = 0;
    }
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
