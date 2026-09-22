/**
 * Minimal mutable 2D vector utilities.
 *
 * The simulation keeps positions/velocities as plain number fields on entities
 * to avoid per-frame allocation; these helpers exist for the cases where a
 * temporary vector genuinely improves readability.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export function vec(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function set(out: Vec2, x: number, y: number): Vec2 {
  out.x = x;
  out.y = y;
  return out;
}

export function copy(out: Vec2, from: Vec2): Vec2 {
  out.x = from.x;
  out.y = from.y;
  return out;
}

export function add(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  return out;
}

export function sub(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  return out;
}

export function scale(out: Vec2, a: Vec2, s: number): Vec2 {
  out.x = a.x * s;
  out.y = a.y * s;
  return out;
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function lengthSq(a: Vec2): number {
  return a.x * a.x + a.y * a.y;
}

export function normalize(out: Vec2, a: Vec2): Vec2 {
  const len = Math.hypot(a.x, a.y);
  if (len < 1e-9) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  out.x = a.x / len;
  out.y = a.y / len;
  return out;
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 2D analogue of the cross product (z component). */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

/** Reflect vector v about unit normal n. */
export function reflect(out: Vec2, v: Vec2, n: Vec2): Vec2 {
  const d = 2 * (v.x * n.x + v.y * n.y);
  out.x = v.x - d * n.x;
  out.y = v.y - d * n.y;
  return out;
}

export function rotate(out: Vec2, a: Vec2, radians: number): Vec2 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const x = a.x * c - a.y * s;
  const y = a.x * s + a.y * c;
  out.x = x;
  out.y = y;
  return out;
}

export function fromAngle(out: Vec2, radians: number, len = 1): Vec2 {
  out.x = Math.cos(radians) * len;
  out.y = Math.sin(radians) * len;
  return out;
}

export function angleOf(a: Vec2): number {
  return Math.atan2(a.y, a.x);
}
