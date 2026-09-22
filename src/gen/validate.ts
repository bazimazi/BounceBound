/**
 * Room validation.
 *
 * Procedural generation is only acceptable if it cannot produce an unfair room.
 * This module answers four questions before a room is ever played:
 *
 *  1. Is the ball's spawn point clear of geometry?
 *  2. Is every enemy and reward reachable from the spawn?
 *  3. Is the exit reachable?
 *  4. Is the spawn free of unavoidable damage?
 *
 * Reachability uses a flood fill over a grid of free space, with solids dilated
 * by the ball's radius. Dilation is what makes the answer meaningful: a 20-unit
 * gap is not a route for a 24-unit ball, and a naive point-based fill would
 * happily claim it was.
 *
 * The fill is connectivity-only and deliberately ignores gravity. A fully
 * enclosed arena plus guaranteed perpetual bouncing and air steering means that
 * anything in the same open region is genuinely reachable; the failure mode worth
 * catching is a *sealed pocket*, not a hard jump.
 */

import { circleVsShape, makeContact, type Shape } from '../sim/geometry';
import { propIsSolid } from '../sim/propLogic';
import type { PropSpec } from '../sim/propFactory';
import { ROOM_H, ROOM_W } from './templates';

export const GRID_CELL = 16;

export interface ValidationTarget {
  x: number;
  y: number;
  label: string;
}

export interface ValidationResult {
  ok: boolean
  /** Human-readable reasons, surfaced by the debug room inspector. */
  problems: string[];
  /** Fraction of the arena that is open space; very low means a cramped room. */
  openFraction: number;
  /** The reachable-region mask, reused by the generator for placement. */
  reachable: Uint8Array;
  cols: number;
  rows: number;
}

const contact = makeContact();

function buildSolidMask(props: PropSpec[], radius: number, cols: number, rows: number): Uint8Array {
  const mask = new Uint8Array(cols * rows);
  for (const prop of props) {
    // Treated as a live prop for the purposes of blocking: a temporary platform
    // is not a wall, and a trigger volume is not geometry.
    if (!prop.solid || prop.destroyed) continue;
    if (prop.kind === 'temporary' || prop.kind === 'breakable') continue;
    markShape(mask, prop.shape, radius, cols, rows);
  }
  return mask;
}

function markShape(mask: Uint8Array, shape: Shape, radius: number, cols: number, rows: number): void {
  // Conservative bounds, then an exact per-cell test inside them.
  let minX = 0;
  let minY = 0;
  let maxX = ROOM_W;
  let maxY = ROOM_H;
  if (shape.kind === 'aabb') {
    minX = shape.x - shape.halfW - radius;
    maxX = shape.x + shape.halfW + radius;
    minY = shape.y - shape.halfH - radius;
    maxY = shape.y + shape.halfH + radius;
  } else if (shape.kind === 'circle') {
    minX = shape.x - shape.radius - radius;
    maxX = shape.x + shape.radius + radius;
    minY = shape.y - shape.radius - radius;
    maxY = shape.y + shape.radius + radius;
  } else if (shape.kind === 'poly') {
    minX = shape.x - shape.boundRadius - radius;
    maxX = shape.x + shape.boundRadius + radius;
    minY = shape.y - shape.boundRadius - radius;
    maxY = shape.y + shape.boundRadius + radius;
  } else {
    minX = Math.min(shape.x1, shape.x2) - radius - shape.thickness;
    maxX = Math.max(shape.x1, shape.x2) + radius + shape.thickness;
    minY = Math.min(shape.y1, shape.y2) - radius - shape.thickness;
    maxY = Math.max(shape.y1, shape.y2) + radius + shape.thickness;
  }

  const c0 = Math.max(0, Math.floor(minX / GRID_CELL));
  const c1 = Math.min(cols - 1, Math.ceil(maxX / GRID_CELL));
  const r0 = Math.max(0, Math.floor(minY / GRID_CELL));
  const r1 = Math.min(rows - 1, Math.ceil(maxY / GRID_CELL));

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const x = c * GRID_CELL + GRID_CELL / 2;
      const y = r * GRID_CELL + GRID_CELL / 2;
      // A cell is blocked when a ball centred there would overlap the shape.
      if (circleVsShape(x, y, radius, shape, contact).hit) mask[r * cols + c] = 1;
    }
  }
}

function floodFill(solid: Uint8Array, cols: number, rows: number, startCol: number, startRow: number): Uint8Array {
  const reachable = new Uint8Array(cols * rows);
  const start = startRow * cols + startCol;
  if (solid[start]) {
    // Spawn is embedded; find the nearest open cell so the report still explains
    // what else is wrong rather than bailing out with a single problem.
    let found = -1;
    for (let radius = 1; radius < Math.max(cols, rows) && found < 0; radius++) {
      for (let dr = -radius; dr <= radius && found < 0; dr++) {
        for (let dc = -radius; dc <= radius && found < 0; dc++) {
          const r = startRow + dr;
          const c = startCol + dc;
          if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
          if (!solid[r * cols + c]) found = r * cols + c;
        }
      }
    }
    if (found < 0) return reachable;
    return floodFill(solid, cols, rows, found % cols, Math.floor(found / cols));
  }

  const queue = new Int32Array(cols * rows);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  reachable[start] = 1;
  while (head < tail) {
    const index = queue[head++];
    const c = index % cols;
    const r = (index - c) / cols;
    for (let i = 0; i < 4; i++) {
      const nc = c + (i === 0 ? 1 : i === 1 ? -1 : 0);
      const nr = r + (i === 2 ? 1 : i === 3 ? -1 : 0);
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = nr * cols + nc;
      if (reachable[ni] || solid[ni]) continue;
      reachable[ni] = 1;
      queue[tail++] = ni;
    }
  }
  return reachable;
}

function cellOf(x: number, y: number, cols: number, rows: number): { c: number; r: number } {
  return {
    c: Math.min(cols - 1, Math.max(0, Math.floor(x / GRID_CELL))),
    r: Math.min(rows - 1, Math.max(0, Math.floor(y / GRID_CELL))),
  };
}

export interface ValidateOptions {
  props: PropSpec[];
  spawnX: number;
  spawnY: number;
  ballRadius: number;
  targets: ValidationTarget[];
  /** Minimum distance from spawn to any damaging prop. */
  spawnSafeRadius?: number;
}

export function validateRoom(options: ValidateOptions): ValidationResult {
  const cols = Math.ceil(ROOM_W / GRID_CELL);
  const rows = Math.ceil(ROOM_H / GRID_CELL);
  const problems: string[] = [];
  const radius = options.ballRadius;

  const solid = buildSolidMask(options.props, radius, cols, rows);
  const spawnCell = cellOf(options.spawnX, options.spawnY, cols, rows);
  if (solid[spawnCell.r * cols + spawnCell.c]) problems.push('spawn point is inside geometry');

  const reachable = floodFill(solid, cols, rows, spawnCell.c, spawnCell.r);

  let open = 0;
  let reach = 0;
  for (let i = 0; i < solid.length; i++) {
    if (!solid[i]) open++;
    if (reachable[i]) reach++;
  }
  const openFraction = open / solid.length;
  if (openFraction < 0.34) problems.push(`room is too cramped (${(openFraction * 100).toFixed(0)}% open)`);
  if (open > 0 && reach / open < 0.6) problems.push('large parts of the room are sealed off from the spawn');

  for (const target of options.targets) {
    const cell = cellOf(target.x, target.y, cols, rows);
    if (!isNearReachable(reachable, solid, cols, rows, cell.c, cell.r)) {
      problems.push(`${target.label} is unreachable`);
    }
  }

  // No unavoidable damage: the player must never spawn already inside a hazard.
  const safe = options.spawnSafeRadius ?? 130;
  for (const prop of options.props) {
    if (prop.contactDamage <= 0) continue;
    const cx = prop.shape.kind === 'segment' ? (prop.shape.x1 + prop.shape.x2) / 2 : prop.shape.x;
    const cy = prop.shape.kind === 'segment' ? (prop.shape.y1 + prop.shape.y2) / 2 : prop.shape.y;
    if (Math.hypot(cx - options.spawnX, cy - options.spawnY) < safe) {
      problems.push(`hazard too close to spawn (${prop.kind})`);
      break;
    }
  }

  return { ok: problems.length === 0, problems, openFraction, reachable, cols, rows };
}

/**
 * A target counts as reachable if its own cell or any cell within a short radius
 * is reachable. Flying enemies legitimately sit inside geometry-adjacent cells,
 * and a reward resting on a platform occupies a blocked cell by definition.
 */
function isNearReachable(
  reachable: Uint8Array,
  solid: Uint8Array,
  cols: number,
  rows: number,
  col: number,
  row: number,
  span = 3,
): boolean {
  for (let dr = -span; dr <= span; dr++) {
    for (let dc = -span; dc <= span; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
      const i = r * cols + c;
      if (reachable[i] && !solid[i]) return true;
    }
  }
  return false;
}

/** Finds an open position near a desired point, for nudging placements. */
export function findOpenNear(
  result: ValidationResult,
  x: number,
  y: number,
  maxRadiusCells = 6,
): { x: number; y: number } | null {
  const { cols, rows, reachable } = result;
  const start = cellOf(x, y, cols, rows);
  for (let radius = 0; radius <= maxRadiusCells; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
        const r = start.r + dr;
        const c = start.c + dc;
        if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
        if (reachable[r * cols + c]) {
          return { x: c * GRID_CELL + GRID_CELL / 2, y: r * GRID_CELL + GRID_CELL / 2 };
        }
      }
    }
  }
  return null;
}
