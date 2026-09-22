/**
 * Authored room skeletons.
 *
 * Pure procedural geometry produces rooms that are *different* but not
 * *interesting*. Every room here is hand-designed around a specific bouncing
 * question, and the generator varies its parameters rather than inventing layouts
 * from noise. Adding a room means adding one entry to `ROOM_TEMPLATES`.
 *
 * A template returns geometry plus annotated slots. The generator decides what
 * goes in the slots based on the room archetype, so the same skeleton can serve
 * as a combat room, a treasure room or a puzzle.
 */

import type { Rng } from '../core/rng';
import type { MaterialId } from '../sim/materials';
import type { PropSpec } from '../sim/propFactory';
import {
  bouncePad,
  breakable,
  crystalCluster,
  launcher,
  movingPlatform,
  oneWayPlatform,
  pillar,
  platform,
  slope,
  spikes,
  temporaryPlatform,
  wall,
} from '../sim/propFactory';
import type { BiomeDef } from '../content/biomes';
import type { RoomArchetype } from '../content/ids';

export const ROOM_W = 1152;
export const ROOM_H = 648;

export type SlotKind = 'ground' | 'air' | 'perch' | 'reward' | 'risk';

export interface Slot {
  x: number;
  y: number;
  kind: SlotKind;
  /** Higher means the generator prefers it for the primary encounter. */
  weight: number;
}

export interface TemplateResult {
  props: PropSpec[];
  /** Ball entry point. */
  spawnX: number;
  spawnY: number;
  slots: Slot[];
  /** Suggested exit position. */
  goalX: number;
  goalY: number;
  /** Free-form notes surfaced by the debug room inspector. */
  notes: string;
}

export interface TemplateContext {
  rng: Rng;
  biome: BiomeDef;
  archetype: RoomArchetype;
  /** 0..1 difficulty within the run. */
  intensity: number;
  terrain: MaterialId;
  accent: MaterialId;
}

export interface RoomTemplate {
  id: string;
  name: string;
  /** The bouncing question this room asks. */
  question: string;
  /** Archetypes this skeleton suits. */
  archetypes: RoomArchetype[];
  /** Relative selection weight. */
  weight: number;
  /** Biomes this template is allowed in; empty means all. */
  biomes: string[];
  build: (ctx: TemplateContext) => TemplateResult;
}

/* --------------------------------------------------------------- helpers -- */

function floorSlab(terrain: MaterialId, gapStart?: number, gapEnd?: number): PropSpec[] {
  if (gapStart === undefined || gapEnd === undefined) {
    return [wall(ROOM_W / 2, ROOM_H - 18, ROOM_W / 2, 18, terrain)];
  }
  const out: PropSpec[] = [];
  if (gapStart > 0) out.push(wall(gapStart / 2, ROOM_H - 18, gapStart / 2, 18, terrain));
  if (gapEnd < ROOM_W) out.push(wall((gapEnd + ROOM_W) / 2, ROOM_H - 18, (ROOM_W - gapEnd) / 2, 18, terrain));
  return out;
}

function groundSlots(count: number, rng: Rng, y = ROOM_H - 60): Slot[] {
  const out: Slot[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    out.push({ x: ROOM_W * t + rng.range(-40, 40), y, kind: 'ground', weight: 1 });
  }
  return out;
}

/**
 * Airborne enemy positions.
 *
 * `minY` is kept below the height a single floor bounce reaches (about 210 units
 * of lift, so roughly y = 430 measured from the floor) plus the extra a wall chain
 * or a platform buys. Placing flying enemies higher than the ball can reach turns
 * an encounter into a stalemate.
 */
function airSlots(count: number, rng: Rng, minY = 215, maxY = ROOM_H * 0.62): Slot[] {
  const out: Slot[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    out.push({
      x: ROOM_W * t + rng.range(-60, 60),
      y: rng.range(minY, maxY),
      kind: 'air',
      weight: 1,
    });
  }
  return out;
}

/* ------------------------------------------------------------- templates -- */

const openArena: RoomTemplate = {
  id: 'open_arena',
  name: 'Open Arena',
  question: 'Can you keep a chain going with nothing to help you?',
  archetypes: ['combat', 'elite', 'event', 'shop', 'respite', 'miniboss'],
  weight: 10,
  biomes: [],
  build: ({ rng, terrain, accent, intensity }) => {
    const props: PropSpec[] = [...floorSlab(terrain)];
    const ledgeY = rng.range(ROOM_H * 0.42, ROOM_H * 0.58);
    props.push(platform(rng.range(120, 190), ledgeY, rng.range(80, 130), accent));
    props.push(platform(ROOM_W - rng.range(120, 190), ledgeY + rng.range(-40, 40), rng.range(80, 130), accent));
    if (intensity > 0.35) {
      props.push(platform(ROOM_W / 2 + rng.range(-90, 90), rng.range(200, 280), rng.range(70, 110), accent));
    }
    return {
      props,
      spawnX: ROOM_W / 2,
      spawnY: 130,
      slots: [...groundSlots(3, rng), ...airSlots(2, rng)],
      goalX: ROOM_W - 90,
      goalY: ROOM_H - 80,
      notes: 'Baseline room. Deliberately sparse so enemy combinations are the content.',
    };
  },
};

const pillarHall: RoomTemplate = {
  id: 'pillar_hall',
  name: 'Pillar Hall',
  question: 'How many walls can you chain before you touch the floor?',
  archetypes: ['combat', 'elite', 'challenge', 'treasure'],
  weight: 9,
  biomes: [],
  build: ({ rng, terrain, accent }) => {
    const props: PropSpec[] = [...floorSlab(terrain)];
    const count = rng.int(3, 4);
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const x = ROOM_W * t;
      const h = rng.range(140, 250);
      props.push(wall(x, ROOM_H - 36 - h / 2, rng.range(18, 30), h / 2, terrain));
      if (rng.chance(0.5)) props.push(platform(x, ROOM_H - 46 - h, rng.range(44, 66), accent));
    }
    return {
      props,
      spawnX: rng.chance(0.5) ? 110 : ROOM_W - 110,
      spawnY: 120,
      slots: [
        ...groundSlots(3, rng),
        ...airSlots(2, rng, 230, 340),
        { x: ROOM_W / 2, y: ROOM_H * 0.32, kind: 'reward', weight: 2 },
      ],
      goalX: ROOM_W / 2,
      goalY: ROOM_H - 80,
      notes: 'Vertical walls at ball height: the natural home of Ricochet builds.',
    };
  },
};

const terraces: RoomTemplate = {
  id: 'terraces',
  name: 'Terraces',
  question: 'Do you descend under control, or fall and lose your combo?',
  archetypes: ['combat', 'traversal', 'treasure', 'puzzle'],
  weight: 8,
  biomes: [],
  build: ({ rng, terrain, accent }) => {
    const props: PropSpec[] = [...floorSlab(terrain)];
    const steps = rng.int(3, 4);
    const leftToRight = rng.chance(0.5);
    const slots: Slot[] = [];
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const x = leftToRight ? ROOM_W * t : ROOM_W * (1 - t);
      const y = 170 + (i / steps) * (ROOM_H * 0.5);
      const halfW = rng.range(90, 140);
      props.push(platform(x, y, halfW, i % 2 === 0 ? terrain : accent));
      slots.push({ x, y: y - 34, kind: 'perch', weight: 1.2 });
    }
    return {
      props,
      spawnX: leftToRight ? 100 : ROOM_W - 100,
      spawnY: 110,
      slots: [...slots, ...groundSlots(2, rng)],
      goalX: leftToRight ? ROOM_W - 90 : 90,
      goalY: ROOM_H - 80,
      notes: 'A descent with optional perches; punishes uncontrolled falling.',
    };
  },
};

const chasm: RoomTemplate = {
  id: 'chasm',
  name: 'The Chasm',
  question: 'Is the reward under the pit worth the trip back out?',
  archetypes: ['combat', 'trap', 'treasure', 'gamble', 'challenge'],
  weight: 8,
  biomes: [],
  build: ({ rng, terrain, accent, intensity }) => {
    const gapHalf = rng.range(140, 210);
    const props: PropSpec[] = [...floorSlab(terrain, ROOM_W / 2 - gapHalf, ROOM_W / 2 + gapHalf)];
    // The pit floor is the reward, and it is spiked at the edges.
    props.push(wall(ROOM_W / 2, ROOM_H - 6, gapHalf, 6, accent));
    props.push(spikes(ROOM_W / 2 - gapHalf + 30, ROOM_H - 26, 26, 12, 12 + intensity * 10));
    props.push(spikes(ROOM_W / 2 + gapHalf - 30, ROOM_H - 26, 26, 12, 12 + intensity * 10));
    props.push(bouncePad(ROOM_W / 2, ROOM_H - 16, Math.min(70, gapHalf - 40), 0.7));
    props.push(platform(ROOM_W / 2 - gapHalf - 60, ROOM_H * 0.55, 70, accent));
    props.push(platform(ROOM_W / 2 + gapHalf + 60, ROOM_H * 0.55, 70, accent));
    return {
      props,
      spawnX: 110,
      spawnY: 120,
      slots: [
        ...groundSlots(2, rng),
        { x: ROOM_W / 2, y: ROOM_H - 70, kind: 'reward', weight: 3 },
        { x: ROOM_W / 2, y: ROOM_H * 0.4, kind: 'air', weight: 1 },
      ],
      goalX: ROOM_W - 100,
      goalY: ROOM_H - 80,
      notes: 'Risk geometry: the pad makes the exit possible but not free.',
    };
  },
};

const funnel: RoomTemplate = {
  id: 'funnel',
  name: 'Funnel',
  question: 'Can you use converging slopes to build speed instead of losing it?',
  archetypes: ['combat', 'elite', 'challenge', 'miniboss'],
  weight: 7,
  biomes: [],
  build: ({ rng, terrain, accent }) => {
    const props: PropSpec[] = [...floorSlab(terrain)];
    const h = rng.range(120, 180);
    props.push(slope(150, ROOM_H - 36 - h / 2, 150, h / 2, false, terrain));
    props.push(slope(ROOM_W - 150, ROOM_H - 36 - h / 2, 150, h / 2, true, terrain));
    props.push(platform(ROOM_W / 2, rng.range(220, 300), rng.range(90, 140), accent));
    return {
      props,
      spawnX: ROOM_W / 2,
      spawnY: 110,
      slots: [
        { x: ROOM_W / 2, y: ROOM_H - 70, kind: 'ground', weight: 2 },
        ...groundSlots(2, rng),
        ...airSlots(2, rng, 160, 300),
      ],
      goalX: ROOM_W / 2,
      goalY: ROOM_H - 80,
      notes: 'Slopes convert falls into horizontal speed: the momentum tutorial.',
    };
  },
};

const chambers: RoomTemplate = {
  id: 'chambers',
  name: 'Sealed Chambers',
  question: 'Which wall do you break, and does breaking it help or trap you?',
  archetypes: ['combat', 'puzzle', 'treasure', 'trap'],
  weight: 7,
  biomes: [],
  build: ({ rng, terrain, intensity }) => {
    const props: PropSpec[] = [...floorSlab(terrain)];
    const dividers = 2;
    const slots: Slot[] = [];
    const gapHeight = 118;
    for (let i = 1; i <= dividers; i++) {
      const x = (ROOM_W / (dividers + 1)) * i;
      const gapTop = rng.range(ROOM_H * 0.26, ROOM_H * 0.42);
      const gapBottom = gapTop + gapHeight;
      /**
       * Two ways through, always: thread the gap, or smash the panel.
       *
       * The solid section is only above the gap. Everything below it is breakable,
       * so a player who cannot line up the gap is never locked out of half the
       * room - they just pay for it in time. Balance runs with an earlier version,
       * where the lower section was solid and the breakable part was a short
       * segment, showed runs stalling permanently on the wrong side of a divider.
       */
      props.push(wall(x, gapTop / 2, 16, gapTop / 2, terrain));
      const panelTop = gapBottom;
      const panelBottom = ROOM_H - 36;
      props.push(
        breakable(x, (panelTop + panelBottom) / 2, 16, (panelBottom - panelTop) / 2, 22 + intensity * 20, 3),
      );
      slots.push({ x: x + 90, y: ROOM_H - 60, kind: 'ground', weight: 1.2 });
    }
    return {
      props,
      spawnX: 100,
      spawnY: 120,
      slots: [...slots, ...airSlots(2, rng, 230, 300), { x: ROOM_W - 120, y: 230, kind: 'reward', weight: 2 }],
      goalX: ROOM_W - 90,
      goalY: ROOM_H - 80,
      notes: 'Destructible geometry as a routing decision.',
    };
  },
};

const catwalks: RoomTemplate = {
  id: 'catwalks',
  name: 'Catwalks',
  question: 'Can you climb using one-way surfaces without losing your rhythm?',
  archetypes: ['traversal', 'combat', 'treasure', 'challenge'],
  weight: 7,
  biomes: [],
  build: ({ rng, terrain, accent }) => {
    const props: PropSpec[] = [...floorSlab(terrain)];
    const rows = rng.int(3, 4);
    const slots: Slot[] = [];
    for (let i = 0; i < rows; i++) {
      const y = ROOM_H - 130 - i * ((ROOM_H - 240) / rows);
      const side = i % 2 === 0;
      const x = side ? rng.range(200, 340) : ROOM_W - rng.range(200, 340);
      props.push(oneWayPlatform(x, y, rng.range(100, 160), accent));
      slots.push({ x, y: y - 40, kind: 'perch', weight: 1 });
    }
    props.push(launcher(rng.chance(0.5) ? 70 : ROOM_W - 70, ROOM_H - 60, rng.chance(0.5) ? 0.7 : -0.7, -0.7, 1150));
    return {
      props,
      spawnX: ROOM_W / 2,
      spawnY: ROOM_H - 120,
      slots: [...slots, ...groundSlots(2, rng)],
      goalX: ROOM_W / 2,
      goalY: 110,
      notes: 'Climb room: one-way platforms plus a launcher for the committed route.',
    };
  },
};

const machineHall: RoomTemplate = {
  id: 'machine_hall',
  name: 'Machine Hall',
  question: 'Can you read a schedule and still hit what you came for?',
  archetypes: ['trap', 'combat', 'elite', 'challenge'],
  weight: 7,
  biomes: ['foundry', 'citadel', 'rift', 'void'],
  build: ({ rng, terrain, accent, intensity }) => {
    const props: PropSpec[] = [...floorSlab(terrain)];
    const count = rng.int(2, 3);
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const x = ROOM_W * t;
      props.push(movingPlatform(x, ROOM_H * 0.42, 74, x, ROOM_H * 0.72, 0.18 + intensity * 0.12, i / count, accent));
    }
    props.push(platform(ROOM_W / 2, 190, 120, accent));
    return {
      props,
      spawnX: 110,
      spawnY: 120,
      slots: [...groundSlots(2, rng), { x: ROOM_W / 2, y: 150, kind: 'reward', weight: 2 }, ...airSlots(2, rng, 200, 340)],
      goalX: ROOM_W - 100,
      goalY: ROOM_H - 80,
      notes: 'Moving platforms transfer velocity, so timing is also a damage choice.',
    };
  },
};

const voidIslands: RoomTemplate = {
  id: 'void_islands',
  name: 'Provisional Ground',
  question: 'What do you do when every surface expires after you use it?',
  archetypes: ['traversal', 'challenge', 'combat', 'secret'],
  weight: 6,
  biomes: ['abyss', 'rift', 'void'],
  build: ({ rng, terrain }) => {
    const props: PropSpec[] = [...floorSlab(terrain, ROOM_W * 0.3, ROOM_W * 0.7)];
    const count = rng.int(4, 6);
    const slots: Slot[] = [];
    for (let i = 0; i < count; i++) {
      const x = rng.range(180, ROOM_W - 180);
      const y = rng.range(ROOM_H * 0.32, ROOM_H * 0.78);
      props.push(temporaryPlatform(x, y, rng.range(54, 78), 0.6, rng.range(2, 3.2)));
      slots.push({ x, y: y - 40, kind: 'air', weight: 1 });
    }
    return {
      props,
      spawnX: 110,
      spawnY: 130,
      slots: [...slots, { x: ROOM_W / 2, y: ROOM_H * 0.4, kind: 'reward', weight: 2 }],
      goalX: ROOM_W - 100,
      goalY: ROOM_H - 100,
      notes: 'Removes the assumption of permanent ground.',
    };
  },
};

const crystalGarden: RoomTemplate = {
  id: 'crystal_garden',
  name: 'Crystal Garden',
  question: 'Can one impact cascade through the whole room?',
  archetypes: ['treasure', 'combat', 'respite', 'secret'],
  weight: 6,
  biomes: [],
  build: ({ rng, terrain, accent }) => {
    const props: PropSpec[] = [...floorSlab(terrain)];
    const clusters = rng.int(6, 10);
    for (let i = 0; i < clusters; i++) {
      const x = rng.range(120, ROOM_W - 120);
      const y = rng.range(ROOM_H * 0.35, ROOM_H - 70);
      props.push(crystalCluster(x, y, rng.range(15, 26), 12, 2));
    }
    props.push(platform(ROOM_W / 2, ROOM_H * 0.34, 130, accent));
    return {
      props,
      spawnX: ROOM_W / 2,
      spawnY: 120,
      slots: [...groundSlots(2, rng), { x: ROOM_W / 2, y: ROOM_H * 0.28, kind: 'reward', weight: 3 }],
      goalX: ROOM_W - 100,
      goalY: ROOM_H - 80,
      notes: 'Dense breakables: the clearest possible demonstration of a chain build.',
    };
  },
};

const ringRun: RoomTemplate = {
  id: 'ring_run',
  name: 'Ring Run',
  question: 'Can you orbit the room without ever going back to the floor?',
  archetypes: ['challenge', 'combat', 'traversal', 'elite'],
  weight: 6,
  biomes: [],
  build: ({ rng, terrain, accent }) => {
    const props: PropSpec[] = [...floorSlab(terrain)];
    const cx = ROOM_W / 2;
    const cy = ROOM_H * 0.5;
    const radius = rng.range(170, 215);
    const count = rng.int(5, 7);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      props.push(pillar(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, rng.range(26, 38), terrain));
    }
    props.push(pillar(cx, cy, rng.range(36, 50), accent));
    props.push(bouncePad(cx - radius - 70, ROOM_H - 46, 60, 0.6));
    props.push(bouncePad(cx + radius + 70, ROOM_H - 46, 60, 0.6));
    return {
      props,
      spawnX: cx,
      spawnY: 110,
      slots: [
        { x: cx - radius, y: cy, kind: 'air', weight: 1.4 },
        { x: cx + radius, y: cy, kind: 'air', weight: 1.4 },
        ...groundSlots(2, rng),
        { x: cx, y: cy - radius - 40, kind: 'reward', weight: 2 },
      ],
      goalX: cx,
      goalY: ROOM_H - 80,
      notes: 'Round pillars: every contact is a genuine angle decision.',
    };
  },
};

const bossArena: RoomTemplate = {
  id: 'boss_arena',
  name: 'Boss Arena',
  question: 'Everything you learned, at once.',
  archetypes: ['boss'],
  weight: 1,
  biomes: [],
  build: ({ terrain, accent }) => {
    const props: PropSpec[] = [...floorSlab(terrain)];
    props.push(platform(150, ROOM_H * 0.62, 100, accent));
    props.push(platform(ROOM_W - 150, ROOM_H * 0.62, 100, accent));
    props.push(bouncePad(ROOM_W / 2 - 220, ROOM_H - 46, 64, 0.6));
    props.push(bouncePad(ROOM_W / 2 + 220, ROOM_H - 46, 64, 0.6));
    return {
      props,
      spawnX: ROOM_W / 2,
      spawnY: ROOM_H - 140,
      slots: [{ x: ROOM_W / 2, y: ROOM_H * 0.4, kind: 'ground', weight: 5 }],
      goalX: ROOM_W / 2,
      goalY: ROOM_H - 90,
      notes: 'Deliberately simple: the boss supplies the complexity.',
    };
  },
};

export const ROOM_TEMPLATES: RoomTemplate[] = [
  openArena,
  pillarHall,
  terraces,
  chasm,
  funnel,
  chambers,
  catwalks,
  machineHall,
  voidIslands,
  crystalGarden,
  ringRun,
  bossArena,
];

export function templatesFor(archetype: RoomArchetype, biome: string): RoomTemplate[] {
  return ROOM_TEMPLATES.filter(
    (t) => t.archetypes.includes(archetype) && (t.biomes.length === 0 || t.biomes.includes(biome)),
  );
}

export function templateById(id: string): RoomTemplate | undefined {
  return ROOM_TEMPLATES.find((t) => t.id === id);
}
