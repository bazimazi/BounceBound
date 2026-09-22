/**
 * Collision geometry for the ball (always a circle) against static and kinematic
 * shapes.
 *
 * Everything the ball can touch is expressed as one of four shapes. Keeping the
 * set small means the collision solver stays exact and debuggable, while convex
 * polygons cover slopes, wedges, rotating blades and boss armour plates.
 *
 * All queries return the *deepest* contact as a normal pointing away from the
 * shape surface toward the circle, plus penetration depth and contact point.
 * That is all the impact pipeline needs to compute reflection, incidence angle
 * and surface classification.
 */

import { clamp, clamp01, closestPointOnSegmentT } from '../core/math';

export type ShapeKind = 'aabb' | 'circle' | 'poly' | 'segment';

export interface AabbShape {
  kind: 'aabb';
  x: number;
  y: number;
  halfW: number;
  halfH: number;
}

export interface CircleShape {
  kind: 'circle';
  x: number;
  y: number;
  radius: number;
}

/** Convex polygon in world space; vertices must be counter-clockwise. */
export interface PolyShape {
  kind: 'poly';
  x: number;
  y: number;
  /** Local-space vertices, rotated/translated lazily into `worldVerts`. */
  verts: number[];
  rotation: number;
  worldVerts: number[];
  /** Cached bounding radius from the origin for broad-phase rejection. */
  boundRadius: number;
  dirty: boolean;
}

/** Thin line surface. `oneWay` blocks only travel opposing its normal. */
export interface SegmentShape {
  kind: 'segment';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Unit normal; for one-way surfaces this is the passable-from side. */
  nx: number;
  ny: number;
  thickness: number;
  oneWay: boolean;
}

export type Shape = AabbShape | CircleShape | PolyShape | SegmentShape;

export interface Contact {
  hit: boolean;
  /** Unit normal pointing from the shape toward the circle centre. */
  nx: number;
  ny: number;
  /** Positive overlap distance. */
  depth: number;
  /** World-space contact point on the shape surface. */
  px: number;
  py: number;
}

/** Reusable contact record; collision queries never allocate. */
export function makeContact(): Contact {
  return { hit: false, nx: 0, ny: 0, depth: 0, px: 0, py: 0 };
}

export function aabb(x: number, y: number, halfW: number, halfH: number): AabbShape {
  return { kind: 'aabb', x, y, halfW, halfH };
}

export function circle(x: number, y: number, radius: number): CircleShape {
  return { kind: 'circle', x, y, radius };
}

export function poly(x: number, y: number, verts: number[], rotation = 0): PolyShape {
  let boundRadius = 0;
  for (let i = 0; i < verts.length; i += 2) {
    boundRadius = Math.max(boundRadius, Math.hypot(verts[i], verts[i + 1]));
  }
  const shape: PolyShape = {
    kind: 'poly',
    x,
    y,
    verts,
    rotation,
    worldVerts: new Array(verts.length).fill(0),
    boundRadius,
    dirty: true,
  };
  refreshPoly(shape);
  return shape;
}

/** Builds a regular polygon, used for gears, blades and crystal hazards. */
export function regularPoly(x: number, y: number, radius: number, sides: number, rotation = 0): PolyShape {
  const verts: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    verts.push(Math.cos(a) * radius, Math.sin(a) * radius);
  }
  return poly(x, y, verts, rotation);
}

export function boxPoly(x: number, y: number, halfW: number, halfH: number, rotation = 0): PolyShape {
  return poly(x, y, [-halfW, -halfH, halfW, -halfH, halfW, halfH, -halfW, halfH], rotation);
}

export function segment(x1: number, y1: number, x2: number, y2: number, oneWay = false, thickness = 4): SegmentShape {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  // Left-hand normal of the direction vector.
  return { kind: 'segment', x1, y1, x2, y2, nx: dy / len, ny: -dx / len, thickness, oneWay };
}

/** Recomputes world vertices after a move or rotation. */
export function refreshPoly(shape: PolyShape): void {
  const c = Math.cos(shape.rotation);
  const s = Math.sin(shape.rotation);
  const { verts, worldVerts } = shape;
  for (let i = 0; i < verts.length; i += 2) {
    const vx = verts[i];
    const vy = verts[i + 1];
    worldVerts[i] = shape.x + vx * c - vy * s;
    worldVerts[i + 1] = shape.y + vx * s + vy * c;
  }
  shape.dirty = false;
}

export function shapeCenterX(shape: Shape): number {
  return shape.kind === 'segment' ? (shape.x1 + shape.x2) / 2 : shape.x;
}

export function shapeCenterY(shape: Shape): number {
  return shape.kind === 'segment' ? (shape.y1 + shape.y2) / 2 : shape.y;
}

/** Conservative bounding radius used for broad-phase culling. */
export function shapeBoundRadius(shape: Shape): number {
  switch (shape.kind) {
    case 'aabb':
      return Math.hypot(shape.halfW, shape.halfH);
    case 'circle':
      return shape.radius;
    case 'poly':
      return shape.boundRadius;
    case 'segment':
      return Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) / 2 + shape.thickness;
  }
}

/**
 * Circle vs axis-aligned box. Handles the interior case (circle centre inside
 * the box) by ejecting along the shallowest axis, which keeps the ball from
 * getting trapped inside a moving platform that closed on top of it.
 */
export function circleVsAabb(cx: number, cy: number, r: number, box: AabbShape, out: Contact): Contact {
  out.hit = false;
  const dx = cx - box.x;
  const dy = cy - box.y;
  const clampedX = clamp(dx, -box.halfW, box.halfW);
  const clampedY = clamp(dy, -box.halfH, box.halfH);
  const inside = clampedX === dx && clampedY === dy;

  if (inside) {
    const overlapX = box.halfW - Math.abs(dx);
    const overlapY = box.halfH - Math.abs(dy);
    if (overlapX < overlapY) {
      const sx = dx >= 0 ? 1 : -1;
      out.nx = sx;
      out.ny = 0;
      out.depth = overlapX + r;
      out.px = box.x + sx * box.halfW;
      out.py = cy;
    } else {
      const sy = dy >= 0 ? 1 : -1;
      out.nx = 0;
      out.ny = sy;
      out.depth = overlapY + r;
      out.px = cx;
      out.py = box.y + sy * box.halfH;
    }
    out.hit = true;
    return out;
  }

  const nearestX = box.x + clampedX;
  const nearestY = box.y + clampedY;
  const offX = cx - nearestX;
  const offY = cy - nearestY;
  const distSq = offX * offX + offY * offY;
  if (distSq > r * r) return out;
  const dist = Math.sqrt(distSq);
  out.hit = true;
  out.depth = r - dist;
  if (dist > 1e-6) {
    out.nx = offX / dist;
    out.ny = offY / dist;
  } else {
    out.nx = 0;
    out.ny = -1;
  }
  out.px = nearestX;
  out.py = nearestY;
  return out;
}

export function circleVsCircle(cx: number, cy: number, r: number, other: CircleShape, out: Contact): Contact {
  out.hit = false;
  const dx = cx - other.x;
  const dy = cy - other.y;
  const sum = r + other.radius;
  const distSq = dx * dx + dy * dy;
  if (distSq > sum * sum) return out;
  const dist = Math.sqrt(distSq);
  out.hit = true;
  out.depth = sum - dist;
  if (dist > 1e-6) {
    out.nx = dx / dist;
    out.ny = dy / dist;
  } else {
    out.nx = 0;
    out.ny = -1;
  }
  out.px = other.x + out.nx * other.radius;
  out.py = other.y + out.ny * other.radius;
  return out;
}

/**
 * Circle vs convex polygon.
 *
 * Uses the closest-point-on-boundary approach rather than SAT so that corner
 * contacts produce a true radial normal. A ball clipping the tip of a spinning
 * blade should ricochet off the tip, not off the face plane the tip belongs to.
 */
export function circleVsPoly(cx: number, cy: number, r: number, shape: PolyShape, out: Contact): Contact {
  out.hit = false;
  if (shape.dirty) refreshPoly(shape);
  const v = shape.worldVerts;
  const count = v.length / 2;
  if (count < 3) return out;

  let bestDistSq = Infinity;
  let bestX = 0;
  let bestY = 0;
  let inside = true;

  for (let i = 0; i < count; i++) {
    const ax = v[i * 2];
    const ay = v[i * 2 + 1];
    const j = (i + 1) % count;
    const bx = v[j * 2];
    const by = v[j * 2 + 1];

    // Counter-clockwise winding: a point is inside when it is left of every edge.
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0) inside = false;

    const t = closestPointOnSegmentT(cx, cy, ax, ay, bx, by);
    const px = ax + (bx - ax) * t;
    const py = ay + (by - ay) * t;
    const dSq = (cx - px) * (cx - px) + (cy - py) * (cy - py);
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestX = px;
      bestY = py;
    }
  }

  const dist = Math.sqrt(bestDistSq);
  if (!inside && dist > r) return out;
  out.hit = true;
  out.px = bestX;
  out.py = bestY;
  if (inside) {
    out.depth = r + dist;
    // Push out along the direction from the surface point to the centre, which
    // for an interior point means reversing.
    if (dist > 1e-6) {
      out.nx = (cx - bestX) / dist * -1;
      out.ny = (cy - bestY) / dist * -1;
    } else {
      out.nx = 0;
      out.ny = -1;
    }
  } else {
    out.depth = r - dist;
    if (dist > 1e-6) {
      out.nx = (cx - bestX) / dist;
      out.ny = (cy - bestY) / dist;
    } else {
      out.nx = 0;
      out.ny = -1;
    }
  }
  return out;
}

/**
 * Circle vs thin segment. `vx, vy` is the circle's velocity so one-way surfaces
 * can ignore contacts approaching from the passable side.
 */
export function circleVsSegment(
  cx: number,
  cy: number,
  r: number,
  shape: SegmentShape,
  out: Contact,
  vx = 0,
  vy = 0,
): Contact {
  out.hit = false;
  const t = closestPointOnSegmentT(cx, cy, shape.x1, shape.y1, shape.x2, shape.y2);
  const px = shape.x1 + (shape.x2 - shape.x1) * t;
  const py = shape.y1 + (shape.y2 - shape.y1) * t;
  const dx = cx - px;
  const dy = cy - py;
  const reach = r + shape.thickness * 0.5;
  const distSq = dx * dx + dy * dy;
  if (distSq > reach * reach) return out;
  const dist = Math.sqrt(distSq);

  let nx: number;
  let ny: number;
  if (dist > 1e-6) {
    nx = dx / dist;
    ny = dy / dist;
  } else {
    nx = shape.nx;
    ny = shape.ny;
  }

  if (shape.oneWay) {
    // Only collide when arriving from the normal side and moving into the plane.
    const side = (cx - px) * shape.nx + (cy - py) * shape.ny;
    const closing = vx * shape.nx + vy * shape.ny;
    if (side < 0 || closing > 0) return out;
    nx = shape.nx;
    ny = shape.ny;
  }

  out.hit = true;
  out.depth = reach - dist;
  out.nx = nx;
  out.ny = ny;
  out.px = px;
  out.py = py;
  return out;
}

/** Dispatches to the appropriate narrow-phase test. */
export function circleVsShape(
  cx: number,
  cy: number,
  r: number,
  shape: Shape,
  out: Contact,
  vx = 0,
  vy = 0,
): Contact {
  switch (shape.kind) {
    case 'aabb':
      return circleVsAabb(cx, cy, r, shape, out);
    case 'circle':
      return circleVsCircle(cx, cy, r, shape, out);
    case 'poly':
      return circleVsPoly(cx, cy, r, shape, out);
    case 'segment':
      return circleVsSegment(cx, cy, r, shape, out, vx, vy);
  }
}

/**
 * Ray vs shape, returning the distance along the ray or -1 for a miss.
 * Used by trajectory prediction and by line-of-sight checks for turrets.
 * The ray is inflated by `radius` so predictions match the ball's real path.
 */
export function rayVsShape(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  maxDist: number,
  shape: Shape,
  radius: number,
): number {
  switch (shape.kind) {
    case 'circle':
      return rayVsCircle(ox, oy, dx, dy, maxDist, shape.x, shape.y, shape.radius + radius);
    case 'aabb':
      return rayVsAabbExpanded(ox, oy, dx, dy, maxDist, shape, radius);
    case 'poly': {
      if (shape.dirty) refreshPoly(shape);
      return rayVsPolyline(ox, oy, dx, dy, maxDist, shape.worldVerts, true, radius);
    }
    case 'segment': {
      const verts = [shape.x1, shape.y1, shape.x2, shape.y2];
      return rayVsPolyline(ox, oy, dx, dy, maxDist, verts, false, radius + shape.thickness * 0.5);
    }
  }
}

function rayVsCircle(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  maxDist: number,
  cx: number,
  cy: number,
  r: number,
): number {
  const mx = ox - cx;
  const my = oy - cy;
  const b = mx * dx + my * dy;
  const c = mx * mx + my * my - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  return t <= maxDist ? t : -1;
}

/**
 * Slab test against the box expanded by the circle radius. The expansion makes
 * corners square rather than rounded, which very slightly over-predicts corner
 * hits; that is the safe direction for a trajectory preview.
 */
function rayVsAabbExpanded(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  maxDist: number,
  box: AabbShape,
  radius: number,
): number {
  const minX = box.x - box.halfW - radius;
  const maxX = box.x + box.halfW + radius;
  const minY = box.y - box.halfH - radius;
  const maxY = box.y + box.halfH + radius;
  let tMin = 0;
  let tMax = maxDist;

  if (Math.abs(dx) < 1e-9) {
    if (ox < minX || ox > maxX) return -1;
  } else {
    let t1 = (minX - ox) / dx;
    let t2 = (maxX - ox) / dx;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return -1;
  }

  if (Math.abs(dy) < 1e-9) {
    if (oy < minY || oy > maxY) return -1;
  } else {
    let t1 = (minY - oy) / dy;
    let t2 = (maxY - oy) / dy;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return -1;
  }
  return tMin;
}

/** Ray vs a chain of vertices, optionally closed into a loop. */
function rayVsPolyline(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  maxDist: number,
  verts: number[],
  closed: boolean,
  radius: number,
): number {
  const count = verts.length / 2;
  let best = -1;
  const edges = closed ? count : count - 1;
  for (let i = 0; i < edges; i++) {
    const j = (i + 1) % count;
    const t = rayVsThickSegment(
      ox,
      oy,
      dx,
      dy,
      maxDist,
      verts[i * 2],
      verts[i * 2 + 1],
      verts[j * 2],
      verts[j * 2 + 1],
      radius,
    );
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

/**
 * Ray vs capsule (segment inflated by radius): tests the infinite-line
 * intersection first, then the two end caps.
 */
function rayVsThickSegment(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  maxDist: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): number {
  const ex = bx - ax;
  const ey = by - ay;
  const denom = dx * ey - dy * ex;
  let best = -1;

  if (Math.abs(denom) > 1e-9) {
    // Offset the edge toward the ray origin by `radius` along its normal.
    const len = Math.hypot(ex, ey) || 1;
    let nx = ey / len;
    let ny = -ex / len;
    if ((ox - ax) * nx + (oy - ay) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const oax = ax + nx * radius;
    const oay = ay + ny * radius;
    const t = ((oax - ox) * ey - (oay - oy) * ex) / denom;
    const u = ((oax - ox) * dy - (oay - oy) * dx) / denom;
    if (t >= 0 && t <= maxDist && u >= 0 && u <= 1) best = t;
  }

  for (const cap of [[ax, ay], [bx, by]]) {
    const t = rayVsCircle(ox, oy, dx, dy, maxDist, cap[0], cap[1], radius);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}
