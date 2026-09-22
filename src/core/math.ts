/** Small scalar/vector helpers shared by simulation and rendering. */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : clamp01((v - a) / (b - a));
}

export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, invLerp(inMin, inMax, v));
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) ** 3;
}

export function easeOutQuint(t: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) ** 5;
}

export function easeInQuad(t: number): number {
  const x = clamp01(t);
  return x * x;
}

/**
 * Frame-rate independent exponential approach. `rate` is the fraction of the
 * remaining distance covered per second at 60fps-equivalent smoothing.
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

export function sign(v: number): number {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

/** Shortest signed angular difference from a to b, in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function wrapAngle(a: number): number {
  let x = a % TAU;
  if (x < 0) x += TAU;
  return x;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/** Closest point on segment AB to P, returned as the parametric t in [0,1]. */
export function closestPointOnSegmentT(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-9) return 0;
  return clamp01(((px - ax) * abx + (py - ay) * aby) / lenSq);
}

export function roundTo(v: number, step: number): number {
  return Math.round(v / step) * step;
}

/** Formats large numbers compactly for HUD readouts (1.2K, 3.4M). */
export function formatNumber(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  if (abs >= 100 || Number.isInteger(v)) return `${Math.round(v)}`;
  return v.toFixed(1);
}
