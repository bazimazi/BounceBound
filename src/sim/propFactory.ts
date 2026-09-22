/**
 * Prop construction helpers.
 *
 * Room templates, boss behaviours and upgrade effects all create props, so the
 * defaults live here rather than being repeated. Each helper names a *gameplay
 * role* rather than a shape, which keeps room templates readable as design
 * documents: `bouncePad(...)`, `crusher(...)`, `breakable(...)`.
 */

import { aabb, boxPoly, circle, poly, regularPoly, segment, type Shape } from './geometry';
import { createMotion } from './propLogic';
import type { Motion, Prop, PropKind } from './entities';
import type { MaterialId } from './materials';

export type PropSpec = Omit<Prop, 'id'>;

export interface PropOptions {
  material?: MaterialId;
  solid?: boolean;
  bounceBonus?: number;
  contactDamage?: number;
  hp?: number;
  motion?: Motion | null;
  params?: Record<string, number>;
  active?: boolean;
  timer?: number;
  link?: number;
  tags?: string[];
  reward?: number;
}

export function makeProp(kind: PropKind, shape: Shape, options: PropOptions = {}): PropSpec {
  const cx = shape.kind === 'segment' ? (shape.x1 + shape.x2) / 2 : shape.x;
  const cy = shape.kind === 'segment' ? (shape.y1 + shape.y2) / 2 : shape.y;
  const hp = options.hp ?? 0;
  return {
    kind,
    shape,
    material: options.material ?? 'stone',
    solid: options.solid ?? true,
    bounceBonus: options.bounceBonus ?? 0,
    contactDamage: options.contactDamage ?? 0,
    hp,
    maxHp: hp,
    destroyed: false,
    flash: 0,
    motion: options.motion ?? null,
    homeX: cx,
    homeY: cy,
    prevX: cx,
    prevY: cy,
    velX: 0,
    velY: 0,
    params: options.params ?? {},
    active: options.active ?? true,
    timer: options.timer ?? 0,
    link: options.link ?? 0,
    tags: options.tags ?? [],
    reward: options.reward ?? 0,
  };
}

/* ------------------------------------------------------------- structural -- */

export function wall(x: number, y: number, halfW: number, halfH: number, material: MaterialId = 'stone'): PropSpec {
  return makeProp('terrain', aabb(x, y, halfW, halfH), { material });
}

export function platform(x: number, y: number, halfW: number, material: MaterialId = 'stone', halfH = 10): PropSpec {
  return makeProp('platform', aabb(x, y, halfW, halfH), { material });
}

/** A surface that can be passed from below; essential for vertical routing. */
export function oneWayPlatform(x: number, y: number, halfW: number, material: MaterialId = 'wood'): PropSpec {
  return makeProp('oneway', segment(x - halfW, y, x + halfW, y, true, 8), { material, tags: ['oneway'] });
}

/**
 * Right-triangle ramp. Slopes matter more here than in most platformers: they
 * convert vertical momentum into horizontal momentum without losing energy,
 * which is the cheapest way for a room to offer a speed route.
 */
export function slope(x: number, y: number, halfW: number, halfH: number, flip = false, material: MaterialId = 'stone'): PropSpec {
  // Counter-clockwise winding, as required by the polygon collision test.
  const verts = flip
    ? [-halfW, halfH, halfW, halfH, halfW, -halfH]
    : [-halfW, halfH, halfW, halfH, -halfW, -halfH];
  return makeProp('terrain', poly(x, y, verts, 0), { material });
}

export function pillar(x: number, y: number, radius: number, material: MaterialId = 'stone'): PropSpec {
  return makeProp('terrain', circle(x, y, radius), { material });
}

/* --------------------------------------------------------------- reactive -- */

export function breakable(x: number, y: number, halfW: number, halfH: number, hp = 20, reward = 1): PropSpec {
  return makeProp('breakable', aabb(x, y, halfW, halfH), {
    material: 'wood',
    hp,
    reward,
    tags: ['breakable'],
  });
}

export function crystalCluster(x: number, y: number, radius: number, hp = 14, reward = 2): PropSpec {
  return makeProp('breakable', regularPoly(x, y, radius, 6, 0.3), {
    material: 'crystal',
    hp,
    reward,
    bounceBonus: 0.12,
    tags: ['breakable', 'crystal'],
  });
}

export function bouncePad(x: number, y: number, halfW: number, power = 0.55, angle = 0): PropSpec {
  return makeProp('bouncepad', boxPoly(x, y, halfW, 9, angle), {
    material: 'rubber',
    bounceBonus: 0,
    params: { power },
    tags: ['pad'],
  });
}

export function launcher(x: number, y: number, dirX: number, dirY: number, power = 1250): PropSpec {
  return makeProp('launcher', circle(x, y, 20), {
    material: 'metal',
    params: { dirX, dirY, power },
    tags: ['launcher'],
  });
}

export function spikes(x: number, y: number, halfW: number, halfH: number, damage = 14): PropSpec {
  return makeProp('spike', boxPoly(x, y, halfW, halfH), {
    material: 'bone',
    contactDamage: damage,
    tags: ['hazard'],
  });
}

export function crusher(
  x: number,
  y: number,
  halfW: number,
  halfH: number,
  toX: number,
  toY: number,
  speed = 0.32,
  phase = 0,
  damage = 18,
): PropSpec {
  return makeProp('crusher', aabb(x, y, halfW, halfH), {
    material: 'metal',
    contactDamage: damage,
    motion: createMotion({ kind: 'patrol', ax: x, ay: y, bx: toX, by: toY, speed, phase, dwell: 0.3 }),
    tags: ['hazard', 'mover'],
  });
}

export function blade(x: number, y: number, radius: number, speed = 0.6, damage = 16): PropSpec {
  return makeProp('blade', regularPoly(x, y, radius, 3, 0), {
    material: 'metal',
    contactDamage: damage,
    motion: createMotion({ kind: 'spin', speed, amount: 1 }),
    tags: ['hazard', 'mover'],
  });
}

export function laser(x: number, y: number, halfW: number, halfH: number, onFraction = 0.4, speed = 0.45, damage = 12): PropSpec {
  return makeProp('laser', aabb(x, y, halfW, halfH), {
    material: 'crystal',
    solid: false,
    contactDamage: damage,
    motion: createMotion({ kind: 'cycle', speed, dwell: onFraction }),
    tags: ['hazard', 'timed'],
  });
}

export function movingPlatform(
  x: number,
  y: number,
  halfW: number,
  toX: number,
  toY: number,
  speed = 0.25,
  phase = 0,
  material: MaterialId = 'metal',
): PropSpec {
  return makeProp('platform', aabb(x, y, halfW, 10), {
    material,
    motion: createMotion({ kind: 'patrol', ax: x, ay: y, bx: toX, by: toY, speed, phase, dwell: 0.12 }),
    tags: ['mover'],
  });
}

export function temporaryPlatform(x: number, y: number, halfW: number, linger = 0.55, respawn = 2.4): PropSpec {
  return makeProp('temporary', aabb(x, y, halfW, 9), {
    material: 'void',
    params: { linger, respawn },
    tags: ['temporary'],
  });
}

export function teleporter(x: number, y: number, tx: number, ty: number, exitX = 0, exitY = -1): PropSpec {
  return makeProp('teleporter', circle(x, y, 22), {
    material: 'void',
    solid: false,
    params: { tx, ty, exitX, exitY },
    tags: ['warp'],
  });
}

export function gravityZone(x: number, y: number, halfW: number, halfH: number, gx: number, gy: number): PropSpec {
  return makeProp('gravityzone', aabb(x, y, halfW, halfH), {
    material: 'void',
    solid: false,
    params: { gx, gy },
    tags: ['zone'],
  });
}

export function slowZone(x: number, y: number, halfW: number, halfH: number, drag = 2.4): PropSpec {
  return makeProp('slowzone', aabb(x, y, halfW, halfH), {
    material: 'moss',
    solid: false,
    params: { drag },
    tags: ['zone'],
  });
}

/** The room exit. Becomes active when the room's clear condition is met. */
export function goal(x: number, y: number): PropSpec {
  return makeProp('goal', circle(x, y, 26), {
    material: 'crystal',
    solid: false,
    active: false,
    tags: ['goal'],
  });
}
