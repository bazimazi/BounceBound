import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { Rng } from '../src/core/rng';
import { FIXED_DT } from '../src/core/clock';
import {
  aabb,
  boxPoly,
  circle,
  circleVsAabb,
  circleVsCircle,
  circleVsPoly,
  circleVsSegment,
  makeContact,
  rayVsShape,
  regularPoly,
  segment,
} from '../src/sim/geometry';
import { classifySurface, getMaterial } from '../src/sim/materials';
import { World } from '../src/sim/world';
import { createBall, createInput, enforceMinimumBounce, performAirBounce } from '../src/sim/ball';
import { createBaseStats } from '../src/sim/stats';
import { wall, platform, spikes, bouncePad, breakable } from '../src/sim/propFactory';
import { ROOM_H, ROOM_W } from '../src/gen/templates';
import type { GameEvents } from '../src/sim/gameEvents';

function makeWorld(overrides: Partial<ReturnType<typeof createBaseStats>> = {}) {
  const stats = { ...createBaseStats(), ...overrides };
  const world = new World({
    width: ROOM_W,
    height: ROOM_H,
    bus: new EventBus<GameEvents>(),
    rng: new Rng('physics-test'),
    stats: () => stats,
    gravityY: stats.gravity,
  });
  world.ball = createBall(ROOM_W / 2, 100, stats);
  return { world, stats };
}

describe('collision primitives', () => {
  const contact = makeContact();

  it('detects and rejects circle vs box correctly', () => {
    const box = aabb(100, 100, 50, 20);
    expect(circleVsAabb(100, 70, 12, box, contact).hit).toBe(true);
    expect(circleVsAabb(100, 60, 12, box, contact).hit).toBe(false);
  });

  it('returns an outward normal for a box face contact', () => {
    const box = aabb(0, 0, 40, 10);
    circleVsAabb(0, -18, 12, box, contact);
    expect(contact.hit).toBe(true);
    expect(contact.ny).toBeLessThan(-0.9);
    expect(contact.depth).toBeGreaterThan(0);
  });

  it('ejects a circle whose centre is inside a box', () => {
    const box = aabb(0, 0, 40, 30);
    circleVsAabb(5, 2, 12, box, contact);
    expect(contact.hit).toBe(true);
    expect(contact.depth).toBeGreaterThan(12);
  });

  it('produces a radial normal at a box corner', () => {
    const box = aabb(0, 0, 20, 20);
    circleVsAabb(-28, -28, 12, box, contact);
    expect(contact.hit).toBe(true);
    // A corner contact must not read as a pure face normal.
    expect(Math.abs(contact.nx)).toBeGreaterThan(0.3);
    expect(Math.abs(contact.ny)).toBeGreaterThan(0.3);
  });

  it('handles circle vs circle', () => {
    expect(circleVsCircle(0, 0, 10, circle(15, 0, 10), contact).hit).toBe(true);
    expect(circleVsCircle(0, 0, 10, circle(30, 0, 10), contact).hit).toBe(false);
  });

  it('handles circle vs convex polygon including interior', () => {
    const hex = regularPoly(0, 0, 40, 6, 0);
    expect(circleVsPoly(0, 0, 8, hex, contact).hit).toBe(true);
    expect(circleVsPoly(44, 0, 8, hex, contact).hit).toBe(true);
    expect(circleVsPoly(90, 0, 8, hex, contact).hit).toBe(false);
  });

  it('gives a tip normal when clipping a triangle vertex', () => {
    const tri = regularPoly(0, 0, 40, 3, 0);
    circleVsPoly(46, 0, 10, tri, contact);
    expect(contact.hit).toBe(true);
    expect(contact.nx).toBeGreaterThan(0.5);
  });

  it('one-way segments only block from the normal side', () => {
    const surface = segment(-50, 0, 50, 0, true, 8);
    // Separate contact records: the query functions reuse the one they are given.
    const fromAbove = makeContact();
    const fromBelow = makeContact();
    circleVsSegment(0, -10, 12, surface, fromAbove, 0, 400);
    circleVsSegment(0, 10, 12, surface, fromBelow, 0, -400);
    expect(fromAbove.hit).toBe(true);
    expect(fromBelow.hit).toBe(false);
  });

  it('raycasts hit shapes in front and miss shapes behind', () => {
    const box = aabb(200, 0, 20, 20);
    expect(rayVsShape(0, 0, 1, 0, 400, box, 0)).toBeGreaterThan(0);
    expect(rayVsShape(0, 0, -1, 0, 400, box, 0)).toBe(-1);
  });

  it('raycast accounts for the ball radius', () => {
    const box = aabb(200, 40, 20, 20);
    const thin = rayVsShape(0, 0, 1, 0, 400, box, 0);
    const fat = rayVsShape(0, 0, 1, 0, 400, box, 30);
    expect(thin).toBe(-1);
    expect(fat).toBeGreaterThan(0);
  });

  it('classifies surfaces by normal', () => {
    expect(classifySurface(0, -1)).toBe('floor');
    expect(classifySurface(0, 1)).toBe('ceiling');
    expect(classifySurface(1, 0)).toBe('wall');
    expect(classifySurface(0.6, -0.6)).toBe('slope');
  });
});

describe('minimum bounce guarantee', () => {
  it('boosts weak floor rebounds but leaves walls alone', () => {
    const floor = enforceMinimumBounce(0, -20, 0, -1, 300);
    expect(floor.boosted).toBe(true);
    expect(-floor.vy).toBeGreaterThanOrEqual(300);

    const wallHit = enforceMinimumBounce(20, 0, 1, 0, 300);
    expect(wallHit.boosted).toBe(false);
    expect(wallHit.vx).toBe(20);
  });

  it('leaves already-strong rebounds untouched', () => {
    const result = enforceMinimumBounce(0, -900, 0, -1, 300);
    expect(result.boosted).toBe(false);
    expect(result.vy).toBe(-900);
  });
});

describe('ball simulation invariants', () => {
  it('never settles: the ball keeps leaving the floor indefinitely', () => {
    const { world } = makeWorld();
    world.addProps([wall(ROOM_W / 2, ROOM_H - 18, ROOM_W / 2, 18, 'moss')]);
    const input = createInput();
    let floorContacts = 0;
    world.bus.on('impact', (ctx) => {
      if (ctx.surface === 'floor') floorContacts++;
    });
    // Twelve seconds of doing nothing at all.
    for (let i = 0; i < 240 * 12; i++) world.step(FIXED_DT, input);
    expect(floorContacts).toBeGreaterThan(8);
    // And it is genuinely still airborne rather than vibrating in the floor.
    const speed = Math.hypot(world.ball.vx, world.ball.vy);
    expect(speed).toBeGreaterThan(80);
  });

  it('never tunnels through a thin platform at maximum speed', () => {
    const { world, stats } = makeWorld({ maxSpeed: 3000 });
    const platformY = ROOM_H - 200;
    world.addProps([platform(ROOM_W / 2, platformY, 400, 'metal', 6)]);
    const input = createInput();
    world.ball.x = ROOM_W / 2;
    world.ball.y = platformY - 300;
    world.ball.vy = 2900;
    world.ball.vx = 0;
    let crossed = false;
    for (let i = 0; i < 240 * 3; i++) {
      world.step(FIXED_DT, input);
      if (world.ball.y > platformY + 40) crossed = true;
    }
    expect(crossed).toBe(false);
    void stats;
  });

  it('stays inside the arena under extreme velocity', () => {
    const { world } = makeWorld({ maxSpeed: 4000 });
    const input = createInput();
    world.ball.vx = 3800;
    world.ball.vy = -3600;
    for (let i = 0; i < 240 * 6; i++) {
      world.step(FIXED_DT, input);
      expect(world.ball.x).toBeGreaterThan(-300);
      expect(world.ball.x).toBeLessThan(ROOM_W + 300);
      expect(world.ball.y).toBeGreaterThan(-300);
      expect(world.ball.y).toBeLessThan(ROOM_H + 300);
      expect(Number.isFinite(world.ball.x)).toBe(true);
    }
  });

  it('a bounce pad adds energy rather than removing it', () => {
    const { world } = makeWorld();
    world.addProps([bouncePad(ROOM_W / 2, ROOM_H - 40, 90, 0.7)]);
    const input = createInput();
    world.ball.x = ROOM_W / 2;
    world.ball.y = ROOM_H - 200;
    world.ball.vy = 700;
    world.ball.vx = 0;
    let outgoing = 0;
    world.bus.on('impactResolved', (ctx) => {
      if (ctx.prop?.kind === 'bouncepad') outgoing = Math.hypot(ctx.outVx, ctx.outVy);
    });
    for (let i = 0; i < 240; i++) world.step(FIXED_DT, input);
    expect(outgoing).toBeGreaterThan(700);
  });

  it('spikes damage the ball and still bounce it clear', () => {
    const { world } = makeWorld();
    world.addProps([spikes(ROOM_W / 2, ROOM_H - 40, 80, 16, 20)]);
    const input = createInput();
    world.ball.x = ROOM_W / 2;
    world.ball.y = ROOM_H - 200;
    world.ball.vy = 600;
    world.ball.iframes = 0;
    const startHp = world.ball.hp;
    // Sample across the window: the guaranteed rebound is strong enough that the
    // ball rises and falls again well inside one second, so the final velocity is
    // not evidence either way. What matters is that a rebound happened at all.
    let rebounded = false;
    for (let i = 0; i < 240; i++) {
      world.step(FIXED_DT, input);
      if (world.ball.vy < -400) rebounded = true;
    }
    expect(world.ball.hp).toBeLessThan(startHp);
    expect(rebounded).toBe(true);
  });

  it('breakables take velocity-scaled damage and drop shards', () => {
    const { world } = makeWorld();
    world.addProps([wall(ROOM_W / 2, ROOM_H - 18, ROOM_W / 2, 18), breakable(ROOM_W / 2, ROOM_H - 80, 30, 30, 8, 2)]);
    const input = createInput();
    world.ball.x = ROOM_W / 2;
    world.ball.y = 120;
    world.ball.vy = 900;
    let destroyed = false;
    world.bus.on('propDestroyed', () => { destroyed = true; });
    for (let i = 0; i < 240 * 4; i++) world.step(FIXED_DT, input);
    expect(destroyed).toBe(true);
  });

  it('impact damage scales with impact speed', () => {
    const measure = (speed: number): number => {
      const { world } = makeWorld();
      world.addProps([wall(ROOM_W / 2, ROOM_H - 18, ROOM_W / 2, 18)]);
      world.spawnEnemyById('husk', ROOM_W / 2, ROOM_H - 60);
      const input = createInput();
      let damage = 0;
      world.bus.on('impactResolved', (ctx) => {
        if (ctx.enemy && damage === 0) damage = ctx.damageDealt;
      });
      world.ball.x = ROOM_W / 2;
      world.ball.y = ROOM_H - 260;
      world.ball.vy = speed;
      world.ball.vx = 0;
      for (let i = 0; i < 240 && damage === 0; i++) world.step(FIXED_DT, input);
      return damage;
    };
    const slow = measure(200);
    const fast = measure(1300);
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(slow * 1.4);
  });

  it('a floor bounce lifts the ball into useful airspace', () => {
    const { world, stats } = makeWorld();
    world.addProps([wall(ROOM_W / 2, ROOM_H - 18, ROOM_W / 2, 18, 'moss')]);
    const input = createInput();
    // Start nearly at rest: the worst case for regaining height.
    world.ball.x = ROOM_W / 2;
    world.ball.y = ROOM_H - 120;
    world.ball.vx = 0;
    world.ball.vy = 40;

    let highest = world.ball.y;
    for (let i = 0; i < 240 * 4; i++) {
      world.step(FIXED_DT, input);
      highest = Math.min(highest, world.ball.y);
    }
    const floorTop = ROOM_H - 36;
    const lift = floorTop - highest;
    // The guaranteed rebound must reach a meaningful fraction of the arena, or the
    // ball becomes trapped on the floor and cannot reach anything above it.
    expect(lift).toBeGreaterThan(150);
    void stats;
  });

  it('diving suppresses the minimum rebound so the player can stay low', () => {
    const measureLift = (diving: boolean): number => {
      const { world } = makeWorld();
      world.addProps([wall(ROOM_W / 2, ROOM_H - 18, ROOM_W / 2, 18)]);
      const input = createInput();
      input.moveY = diving ? 1 : 0;
      world.ball.x = ROOM_W / 2;
      world.ball.y = ROOM_H - 120;
      world.ball.vx = 0;
      world.ball.vy = 60;
      let highest = world.ball.y;
      for (let i = 0; i < 240 * 3; i++) {
        world.step(FIXED_DT, input);
        highest = Math.min(highest, world.ball.y);
      }
      return ROOM_H - 36 - highest;
    };
    expect(measureLift(true)).toBeLessThan(measureLift(false) * 0.6);
  });

  it('pushes an enemy out of solid geometry so it can always be reached', () => {
    const { world } = makeWorld();
    world.addProps([wall(ROOM_W / 2, ROOM_H - 18, ROOM_W / 2, 18)]);
    const enemy = world.spawnEnemyById('mote', ROOM_W / 2, ROOM_H - 10);
    const input = createInput();
    for (let i = 0; i < 30; i++) world.step(FIXED_DT, input);
    // Must end up above the floor surface, not buried inside it or shoved out of
    // the arena by the ejection direction.
    expect(enemy.y + enemy.radius).toBeLessThanOrEqual(ROOM_H - 36 + 2);
    expect(enemy.y).toBeGreaterThan(0);
  });

  it('air bounce spends a charge and reverses downward motion', () => {
    const stats = createBaseStats();
    stats.airBounceCharges = 1;
    const ball = createBall(0, 0, stats);
    ball.vy = 800;
    expect(performAirBounce(ball, stats)).toBe(true);
    expect(ball.vy).toBeLessThan(0);
    expect(ball.airBounces).toBe(0);
    expect(performAirBounce(ball, stats)).toBe(false);
  });

  it('materials differ in the energy they return', () => {
    expect(getMaterial('rubber').restitution).toBeGreaterThan(getMaterial('moss').restitution);
    expect(getMaterial('ice').tangentRetention).toBeGreaterThan(getMaterial('moss').tangentRetention);
  });

  it('a spinning blade polygon still produces valid contacts', () => {
    const { world } = makeWorld();
    const spinner = boxPoly(ROOM_W / 2, ROOM_H / 2, 60, 12, 0.6);
    world.addProp({
      ...platform(0, 0, 1),
      shape: spinner,
      kind: 'blade',
      contactDamage: 5,
      homeX: ROOM_W / 2,
      homeY: ROOM_H / 2,
    });
    const input = createInput();
    let hits = 0;
    world.bus.on('impact', () => hits++);
    world.ball.x = ROOM_W / 2;
    world.ball.y = ROOM_H / 2 - 200;
    world.ball.vy = 800;
    for (let i = 0; i < 240 * 3; i++) world.step(FIXED_DT, input);
    expect(hits).toBeGreaterThan(0);
    expect(Number.isFinite(world.ball.x)).toBe(true);
  });
});

describe('impact context correctness', () => {
  it('reports incidence, surface and speeds consistently', () => {
    const { world } = makeWorld();
    world.addProps([wall(ROOM_W / 2, ROOM_H - 18, ROOM_W / 2, 18)]);
    const input = createInput();
    world.ball.x = ROOM_W / 2;
    world.ball.y = ROOM_H - 200;
    world.ball.vx = 0;
    world.ball.vy = 800;
    let seen: { incidence: number; surface: string; normalSpeed: number } | null = null;
    world.bus.on('impactResolved', (ctx) => {
      if (!seen) seen = { incidence: ctx.incidence, surface: ctx.surface, normalSpeed: ctx.normalSpeed };
    });
    for (let i = 0; i < 240 && !seen; i++) world.step(FIXED_DT, input);
    expect(seen).not.toBeNull();
    expect(seen!.surface).toBe('floor');
    // Straight down onto a flat floor is a near dead-on impact.
    expect(seen!.incidence).toBeLessThan(0.3);
    expect(seen!.normalSpeed).toBeGreaterThan(700);
  });
});
