import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { generateRoom, describeRoom, enemyScaling, threatBudget } from '../src/gen/roomgen';
import { ROOM_TEMPLATES, ROOM_H, ROOM_W, templatesFor } from '../src/gen/templates';
import { validateRoom } from '../src/gen/validate';
import { circleVsShape } from '../src/sim/geometry';
import { choicesFrom, generateMap } from '../src/gen/mapgen';
import { BIOME_DEFS } from '../src/content/biomes';
import { ENEMY_DEFS } from '../src/content/enemies';
import { BOSS_DEFS } from '../src/content/bosses';
import type { BiomeId, RoomArchetype } from '../src/content/ids';

const ALL_ARCHETYPES: RoomArchetype[] = [
  'combat',
  'elite',
  'trap',
  'traversal',
  'treasure',
  'challenge',
  'puzzle',
  'shop',
  'respite',
  'event',
  'gamble',
  'miniboss',
  'boss',
  'secret',
];

const unlockedAll = () => true;

describe('room templates', () => {
  it('every archetype has at least one usable template in every biome', () => {
    for (const biome of BIOME_DEFS) {
      for (const archetype of ALL_ARCHETYPES) {
        const direct = templatesFor(archetype, biome.id);
        const fallback = templatesFor('combat', biome.id);
        expect(direct.length + fallback.length).toBeGreaterThan(0);
      }
    }
  });

  it('templates place the spawn inside the arena', () => {
    for (const template of ROOM_TEMPLATES) {
      for (let seed = 0; seed < 12; seed++) {
        const result = template.build({
          rng: new Rng(`${template.id}:${seed}`),
          biome: BIOME_DEFS[0],
          archetype: 'combat',
          intensity: seed / 12,
          terrain: 'stone',
          accent: 'moss',
        });
        expect(result.spawnX).toBeGreaterThan(0);
        expect(result.spawnX).toBeLessThan(ROOM_W);
        expect(result.spawnY).toBeGreaterThan(0);
        expect(result.spawnY).toBeLessThan(ROOM_H);
        expect(result.props.length).toBeGreaterThan(0);
        expect(template.question.length).toBeGreaterThan(10);
      }
    }
  });

  it('every template documents the question it asks', () => {
    for (const template of ROOM_TEMPLATES) {
      expect(template.question.trim().length).toBeGreaterThan(0);
      expect(template.archetypes.length).toBeGreaterThan(0);
    }
  });
});

describe('room generation', () => {
  it('produces valid rooms across a wide sweep of seeds, biomes and archetypes', () => {
    const failures: string[] = [];
    let generated = 0;
    for (const biome of BIOME_DEFS) {
      for (const archetype of ALL_ARCHETYPES) {
        for (let seed = 0; seed < 6; seed++) {
          const room = generateRoom({
            seed: `sweep-${biome.id}-${archetype}-${seed}`,
            archetype,
            biome: biome.id,
            depth: seed * 3,
            progress: seed / 6,
            ballRadius: 12,
            boundLevel: seed % 4,
            unlocked: unlockedAll,
          });
          generated++;
          if (!room.validation.ok) failures.push(describeRoom(room));
        }
      }
    }
    expect(generated).toBeGreaterThan(400);
    expect(failures).toEqual([]);
  });

  it('is fully deterministic for a given seed', () => {
    const options = {
      seed: 'determinism-check',
      archetype: 'combat' as RoomArchetype,
      biome: 'foundry' as BiomeId,
      depth: 5,
      progress: 0.5,
      ballRadius: 12,
      boundLevel: 2,
      unlocked: unlockedAll,
    };
    const a = generateRoom(options);
    const b = generateRoom(options);
    expect(a.templateId).toBe(b.templateId);
    expect(a.enemies).toEqual(b.enemies);
    expect(a.props.length).toBe(b.props.length);
    expect(a.interactables).toEqual(b.interactables);
    expect(a.spawnX).toBe(b.spawnX);
  });

  it('never places a hazard on top of the spawn', () => {
    for (let seed = 0; seed < 80; seed++) {
      const room = generateRoom({
        seed: `hazard-${seed}`,
        archetype: 'trap',
        biome: 'foundry',
        depth: 8,
        progress: 0.8,
        ballRadius: 12,
        boundLevel: 3,
        unlocked: unlockedAll,
      });
      for (const prop of room.props) {
        if (prop.contactDamage <= 0) continue;
        const cx = prop.shape.kind === 'segment' ? (prop.shape.x1 + prop.shape.x2) / 2 : prop.shape.x;
        const cy = prop.shape.kind === 'segment' ? (prop.shape.y1 + prop.shape.y2) / 2 : prop.shape.y;
        expect(Math.hypot(cx - room.spawnX, cy - room.spawnY)).toBeGreaterThan(120);
      }
    }
  });

  it('scales the encounter with depth but keeps health inflation gentle', () => {
    const shallow = threatBudget('combat', 1, 0);
    const deep = threatBudget('combat', 14, 0);
    expect(deep).toBeGreaterThan(shallow * 3);

    const early = enemyScaling(1, 0);
    const late = enemyScaling(20, 0);
    // A 20-room run must not turn a 26 health Husk into a wall.
    expect(late.healthScale).toBeLessThan(3);
    expect(late.damageScale).toBeLessThan(2);
    expect(early.healthScale).toBeLessThan(late.healthScale);
  });

  it('support rooms contain no enemies', () => {
    for (const archetype of ['shop', 'respite', 'event'] as RoomArchetype[]) {
      for (let seed = 0; seed < 10; seed++) {
        const room = generateRoom({
          seed: `support-${archetype}-${seed}`,
          archetype,
          biome: 'verdant',
          depth: 6,
          progress: 0.5,
          ballRadius: 12,
          boundLevel: 0,
          unlocked: unlockedAll,
        });
        expect(room.enemies).toHaveLength(0);
        expect(room.interactables.length).toBeGreaterThan(0);
      }
    }
  });

  it('boss rooms contain exactly one boss and its arena', () => {
    for (const biome of BIOME_DEFS) {
      const room = generateRoom({
        seed: `boss-${biome.id}`,
        archetype: 'boss',
        biome: biome.id,
        depth: 8,
        progress: 1,
        ballRadius: 12,
        boundLevel: 0,
        unlocked: unlockedAll,
      });
      expect(room.enemies).toHaveLength(1);
      expect(BOSS_DEFS.some((b) => b.id === room.enemies[0].defId)).toBe(true);
    }
  });

  it('rooms scale with ball radius without becoming invalid', () => {
    for (const radius of [8, 12, 17, 24, 30]) {
      const room = generateRoom({
        seed: `radius-${radius}`,
        archetype: 'combat',
        biome: 'abyss',
        depth: 6,
        progress: 0.6,
        ballRadius: radius,
        boundLevel: 0,
        unlocked: unlockedAll,
      });
      expect(room.validation.ok).toBe(true);
    }
  });

  it('never places an enemy inside solid geometry', () => {
    // An enemy buried in a prop is unreachable, because the ball collides with the
    // prop first, so the room can never be cleared.
    const contact = { hit: false, nx: 0, ny: 0, depth: 0, px: 0, py: 0 };
    const offenders: string[] = [];
    for (const biome of BIOME_DEFS) {
      for (const archetype of ['combat', 'elite', 'trap', 'challenge', 'treasure'] as RoomArchetype[]) {
        for (let seed = 0; seed < 5; seed++) {
          const room = generateRoom({
            seed: `embed-${biome.id}-${archetype}-${seed}`,
            archetype,
            biome: biome.id,
            depth: 6,
            progress: 0.6,
            ballRadius: 12,
            boundLevel: 0,
            unlocked: unlockedAll,
          });
          for (const spawn of room.enemies) {
            for (const prop of room.props) {
              if (!prop.solid || prop.kind === 'temporary' || prop.kind === 'breakable') continue;
              // Test against the ball's radius: the enemy must sit somewhere the
              // ball could actually occupy.
              if (circleVsShape(spawn.x, spawn.y, 12, prop.shape, contact).hit) {
                offenders.push(`${room.templateId}/${archetype}: ${spawn.defId} inside ${prop.kind}`);
              }
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('respects enemy depth gating', () => {
    const room = generateRoom({
      seed: 'shallow',
      archetype: 'combat',
      biome: 'verdant',
      depth: 0,
      progress: 0,
      ballRadius: 12,
      boundLevel: 0,
      unlocked: unlockedAll,
    });
    for (const spawn of room.enemies) {
      const def = ENEMY_DEFS.find((d) => d.id === spawn.defId);
      expect(def).toBeDefined();
      expect(def!.minDepth).toBeLessThanOrEqual(0);
    }
  });
});

describe('room validation', () => {
  it('rejects a spawn embedded in geometry', () => {
    const result = validateRoom({
      props: [
        {
          kind: 'terrain',
          shape: { kind: 'aabb', x: 100, y: 100, halfW: 80, halfH: 80 },
          material: 'stone',
          solid: true,
          bounceBonus: 0,
          contactDamage: 0,
          hp: 0,
          maxHp: 0,
          destroyed: false,
          flash: 0,
          motion: null,
          homeX: 100,
          homeY: 100,
          prevX: 100,
          prevY: 100,
          velX: 0,
          velY: 0,
          params: {},
          active: true,
          timer: 0,
          link: 0,
          tags: [],
          reward: 0,
        },
      ],
      spawnX: 100,
      spawnY: 100,
      ballRadius: 12,
      targets: [],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('spawn');
  });

  it('detects a target sealed behind solid geometry', () => {
    const box = (x: number, y: number, halfW: number, halfH: number) => ({
      kind: 'terrain' as const,
      shape: { kind: 'aabb' as const, x, y, halfW, halfH },
      material: 'stone' as const,
      solid: true,
      bounceBonus: 0,
      contactDamage: 0,
      hp: 0,
      maxHp: 0,
      destroyed: false,
      flash: 0,
      motion: null,
      homeX: x,
      homeY: y,
      prevX: x,
      prevY: y,
      velX: 0,
      velY: 0,
      params: {},
      active: true,
      timer: 0,
      link: 0,
      tags: [],
      reward: 0,
    });
    // A sealed box in the corner with a target inside it.
    const result = validateRoom({
      props: [
        box(200, 200, 100, 8),
        box(200, 360, 100, 8),
        box(108, 280, 8, 88),
        box(292, 280, 8, 88),
      ],
      spawnX: ROOM_W - 100,
      spawnY: 100,
      ballRadius: 12,
      targets: [{ x: 200, y: 280, label: 'sealed reward' }],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('unreachable');
  });
});

describe('map generation', () => {
  it('every node is reachable and every non-boss node leads somewhere', () => {
    for (let seed = 0; seed < 40; seed++) {
      const map = generateMap({
        seed: `map-${seed}`,
        biomes: ['verdant', 'foundry', 'abyss'],
        boundLevel: seed % 5,
      });
      for (const act of map.acts) {
        const reachable = new Set<number>(act.entranceIds);
        // Breadth-first from the entrances.
        const queue = [...act.entranceIds];
        while (queue.length > 0) {
          const id = queue.shift()!;
          const node = map.nodesById.get(id)!;
          for (const next of node.next) {
            if (reachable.has(next)) continue;
            reachable.add(next);
            queue.push(next);
          }
        }
        for (const node of act.nodes) {
          expect(reachable.has(node.id)).toBe(true);
          if (node.archetype !== 'boss') {
            expect(choicesFrom(map, node).length).toBeGreaterThan(0);
          }
        }
        expect(reachable.has(act.bossId)).toBe(true);
      }
    }
  });

  it('each act ends in exactly one boss', () => {
    const map = generateMap({ seed: 'boss-count', biomes: ['verdant', 'foundry'], boundLevel: 0 });
    for (const act of map.acts) {
      const bosses = act.nodes.filter((n) => n.archetype === 'boss');
      expect(bosses).toHaveLength(1);
      expect(bosses[0].id).toBe(act.bossId);
    }
  });

  it('guarantees a recovery option immediately before every boss', () => {
    for (let seed = 0; seed < 25; seed++) {
      const map = generateMap({ seed: `respite-${seed}`, biomes: ['verdant', 'foundry'], boundLevel: 0 });
      for (const act of map.acts) {
        const boss = map.nodesById.get(act.bossId)!;
        const parents = boss.prev.map((id) => map.nodesById.get(id)!);
        const penultimate = act.nodes.filter((n) => n.layer === boss.layer - 1);
        expect(penultimate.some((n) => n.archetype === 'respite' || n.archetype === 'shop')).toBe(true);
        expect(parents.length).toBeGreaterThan(0);
      }
    }
  });

  it('every act contains an economy option', () => {
    for (let seed = 0; seed < 25; seed++) {
      const map = generateMap({ seed: `shop-${seed}`, biomes: ['verdant', 'foundry', 'abyss'], boundLevel: 0 });
      for (const act of map.acts) {
        expect(act.nodes.some((n) => n.archetype === 'shop')).toBe(true);
      }
    }
  });

  it('is deterministic for a given seed', () => {
    const a = generateMap({ seed: 'same', biomes: ['verdant', 'foundry'], boundLevel: 1 });
    const b = generateMap({ seed: 'same', biomes: ['verdant', 'foundry'], boundLevel: 1 });
    expect(a.acts.map((act) => act.nodes.map((n) => `${n.id}:${n.archetype}:${n.next.join(',')}`))).toEqual(
      b.acts.map((act) => act.nodes.map((n) => `${n.id}:${n.archetype}:${n.next.join(',')}`)),
    );
  });

  it('does not chain two support rooms back to back', () => {
    const support = new Set(['shop', 'respite', 'event']);
    for (let seed = 0; seed < 30; seed++) {
      const map = generateMap({ seed: `chain-${seed}`, biomes: ['verdant', 'foundry'], boundLevel: 0 });
      for (const node of map.nodesById.values()) {
        if (!support.has(node.archetype)) continue;
        for (const nextId of node.next) {
          const next = map.nodesById.get(nextId)!;
          expect(support.has(next.archetype)).toBe(false);
        }
      }
    }
  });
});
