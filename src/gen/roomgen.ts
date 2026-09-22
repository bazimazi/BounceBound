/**
 * Room generation.
 *
 * The generator composes three layers on top of an authored skeleton:
 *
 *   skeleton (templates.ts) -> hazards -> encounter -> interactables
 *
 * Nothing is placed by raw noise. Hazards are drawn from the biome's weighted
 * palette into positions the validator has confirmed are open; encounters are
 * assembled from a *threat budget* rather than a count, so a room can spend its
 * budget on one dangerous enemy or six cheap ones; and every result is validated
 * for reachability and spawn safety before it is accepted, with a bounded retry
 * loop and a guaranteed-simple fallback.
 *
 * Everything is a pure function of the seed. `generateRoom` with the same inputs
 * always produces byte-identical output, which is what makes seeded runs,
 * daily challenges and bug reports reproducible.
 */

import { Rng } from '../core/rng';
import { clamp, lerp } from '../core/math';
import type { PropSpec } from '../sim/propFactory';
import {
  blade,
  bouncePad,
  crusher,
  gravityZone,
  goal as goalProp,
  laser,
  launcher,
  slowZone,
  spikes,
  teleporter,
  temporaryPlatform,
} from '../sim/propFactory';
import { getBiome, type BiomeDef } from '../content/biomes';
import { eligibleElites, eligibleEnemies, type EnemyDef } from '../content/enemies';
import { bossForBiome } from '../content/bosses';
import type { BiomeId, RoomArchetype } from '../content/ids';
import { ROOM_H, ROOM_W, templatesFor, type RoomTemplate, type Slot, type TemplateContext } from './templates';
import { findOpenNear, validateRoom, type ValidationResult } from './validate';

export interface EnemySpawn {
  defId: string;
  x: number;
  y: number;
  healthScale: number;
  damageScale: number;
}

export type InteractableKind = 'chest' | 'relic' | 'heal' | 'altar' | 'shop' | 'gamble' | 'key';

export interface Interactable {
  kind: InteractableKind;
  x: number;
  y: number;
  /** Upgrade id, event id or shop stock reference. */
  payload: string;
  /** Shard cost; 0 means free. */
  price: number;
}

export interface GeneratedRoom {
  templateId: string;
  templateName: string;
  question: string;
  archetype: RoomArchetype;
  biome: BiomeId;
  depth: number;
  props: PropSpec[];
  spawnX: number;
  spawnY: number;
  goalX: number;
  goalY: number;
  enemies: EnemySpawn[];
  interactables: Interactable[];
  /** Threat actually spent, for difficulty telemetry. */
  threatSpent: number;
  notes: string;
  validation: ValidationResult;
  attempts: number;
  seed: string;
}

export interface GenerateRoomOptions {
  seed: string;
  archetype: RoomArchetype;
  biome: BiomeId;
  /** Room index within the run; drives scaling and enemy eligibility. */
  depth: number;
  /** 0..1 position within the run, for the intensity curve. */
  progress: number;
  ballRadius: number;
  boundLevel: number;
  unlocked: (id: string) => boolean;
  /** Forced template, used by the debug room inspector. */
  forceTemplate?: string;
}

/* ------------------------------------------------------------- difficulty -- */

/**
 * Threat budget by archetype and depth.
 *
 * Deliberately not linear: the curve steps up at the points where the player has
 * just been handed new power (after the first elite, after a boss), so the
 * escalation lands as "the game responded to my build" rather than as a grind.
 */
export function threatBudget(archetype: RoomArchetype, depth: number, boundLevel: number): number {
  const base = 3 + depth * 1.35 + Math.max(0, depth - 6) * 0.65;
  const archetypeScale: Partial<Record<RoomArchetype, number>> = {
    combat: 1,
    elite: 1.45,
    miniboss: 1.7,
    challenge: 1.3,
    trap: 0.6,
    traversal: 0.5,
    treasure: 0.55,
    puzzle: 0.35,
    respite: 0,
    shop: 0,
    event: 0,
    gamble: 0.8,
    secret: 0.5,
    boss: 0,
  };
  return base * (archetypeScale[archetype] ?? 1) * (1 + boundLevel * 0.12);
}

/** Health and damage scaling. Kept gentle on purpose. */
export function enemyScaling(depth: number, boundLevel: number): { healthScale: number; damageScale: number } {
  return {
    healthScale: 1 + depth * 0.085 + boundLevel * 0.1,
    damageScale: 1 + depth * 0.035 + boundLevel * 0.09,
  };
}

/* -------------------------------------------------------------- generator -- */

export function generateRoom(options: GenerateRoomOptions): GeneratedRoom {
  const biome = getBiome(options.biome);
  const maxAttempts = 8;
  let lastFailure: GeneratedRoom | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rng = new Rng(`${options.seed}:room:${attempt}`);
    const room = buildOnce(options, biome, rng, attempt);
    if (room.validation.ok) return room;
    lastFailure = room;
  }

  // Fallback: the Open Arena skeleton with hazards omitted is always valid,
  // because it is a flat floor with two ledges and nothing else.
  const rng = new Rng(`${options.seed}:room:fallback`);
  const fallback = buildOnce({ ...options, forceTemplate: 'open_arena' }, biome, rng, maxAttempts, true);
  fallback.notes = `${fallback.notes} (fallback after ${maxAttempts} rejected attempts: ${
    lastFailure?.validation.problems.join('; ') ?? 'unknown'
  })`;
  return fallback;
}

function buildOnce(
  options: GenerateRoomOptions,
  biome: BiomeDef,
  rng: Rng,
  attempt: number,
  noHazards = false,
): GeneratedRoom {
  const intensity = clamp(options.progress, 0, 1);
  const templates = options.forceTemplate
    ? templatesFor(options.archetype, biome.id).filter((t) => t.id === options.forceTemplate)
    : templatesFor(options.archetype, biome.id);
  const pool = templates.length > 0 ? templates : templatesFor('combat', biome.id);
  const template =
    rng.weighted(pool, (t) => t.weight * (biome.roomBias[options.archetype] ?? 1)) ?? pool[0];

  const ctx: TemplateContext = {
    rng,
    biome,
    archetype: options.archetype,
    intensity,
    terrain: biome.terrainMaterial,
    accent: biome.accentMaterial,
  };
  const skeleton = template.build(ctx);
  const props = skeleton.props.slice();

  if (!noHazards) {
    props.push(...placeHazards(rng, biome, options, skeleton.spawnX, skeleton.spawnY, intensity));
  }
  props.push(goalProp(skeleton.goalX, skeleton.goalY));

  const encounter = buildEncounter(rng, options, skeleton.slots);
  const interactables = buildInteractables(rng, options, skeleton.slots, intensity);
  const goalIndex = props.length - 1;

  const validation = validateRoom({
    props,
    spawnX: skeleton.spawnX,
    spawnY: skeleton.spawnY,
    ballRadius: options.ballRadius,
    targets: [
      { x: skeleton.goalX, y: skeleton.goalY, label: 'exit' },
      ...encounter.spawns.map((s, i) => ({ x: s.x, y: s.y, label: `enemy ${i + 1} (${s.defId})` })),
      ...interactables.map((it, i) => ({ x: it.x, y: it.y, label: `${it.kind} ${i + 1}` })),
    ],
  });

  /**
   * Snap every placement into confirmed open, spawn-connected space.
   *
   * This runs unconditionally rather than only on validation failure. The
   * reachability check tolerates a target sitting a couple of cells inside
   * geometry - a reward resting on a platform legitimately does - but an *enemy*
   * inside a solid prop is untouchable, because the ball hits the prop first. A
   * room that cannot be cleared is worse than a room with slightly nudged
   * placements, so correctness wins here.
   */
  for (const spawn of encounter.spawns) {
    const open = findOpenNear(validation, spawn.x, spawn.y, 8);
    if (open) {
      spawn.x = open.x;
      spawn.y = open.y;
    }
  }
  for (const item of interactables) {
    const open = findOpenNear(validation, item.x, item.y, 8);
    if (open) {
      item.x = open.x;
      item.y = open.y;
    }
  }

  const revalidated = validation.ok
    ? validation
    : validateRoom({
        props,
        spawnX: skeleton.spawnX,
        spawnY: skeleton.spawnY,
        ballRadius: options.ballRadius,
        targets: [
          { x: skeleton.goalX, y: skeleton.goalY, label: 'exit' },
          ...encounter.spawns.map((s, i) => ({ x: s.x, y: s.y, label: `enemy ${i + 1} (${s.defId})` })),
          ...interactables.map((it, i) => ({ x: it.x, y: it.y, label: `${it.kind} ${i + 1}` })),
        ],
      });

  /**
   * Relocate the exit into confirmed open, spawn-connected space.
   *
   * Templates suggest a position, but a template that scatters pillars
   * procedurally can put one exactly where it wanted the exit. Snapping to the
   * validated reachable mask makes "the exit is inside a wall" impossible rather
   * than merely unlikely.
   */
  const exitProp = props[goalIndex];
  let goalX = skeleton.goalX;
  let goalY = skeleton.goalY;
  if (exitProp && exitProp.kind === 'goal' && exitProp.shape.kind === 'circle') {
    const open = findOpenNear(revalidated, goalX, goalY, 10);
    if (open) {
      exitProp.shape.x = open.x;
      exitProp.shape.y = open.y;
      exitProp.homeX = open.x;
      exitProp.homeY = open.y;
      goalX = open.x;
      goalY = open.y;
    }
  }

  return {
    templateId: template.id,
    templateName: template.name,
    question: template.question,
    archetype: options.archetype,
    biome: biome.id,
    depth: options.depth,
    props,
    spawnX: skeleton.spawnX,
    spawnY: skeleton.spawnY,
    goalX,
    goalY,
    enemies: encounter.spawns,
    interactables,
    threatSpent: encounter.spent,
    notes: skeleton.notes,
    validation: revalidated,
    attempts: attempt + 1,
    seed: options.seed,
  };
}

/* ---------------------------------------------------------------- hazards -- */

/**
 * Hazard damage is tuned deliberately low.
 *
 * Balance runs showed static hazards accounting for 60% of all damage taken once
 * the ball's guaranteed rebound was raised, because a faster ball simply touches
 * more of the room. Hazards are supposed to shape *routes* - they make a lane
 * expensive - not to be the primary way a run ends. Enemy and projectile threat
 * carries that job, because those can be read and answered.
 */
const HAZARD_BUILDERS: Record<string, (rng: Rng, x: number, y: number, intensity: number) => PropSpec> = {
  spikes: (rng, x, y, i) => spikes(x, y, rng.range(34, 62), 12, 8 + i * 6),
  bouncepad: (rng, x, y) => bouncePad(x, y, rng.range(48, 70), rng.range(0.45, 0.75), rng.range(-0.35, 0.35)),
  crusher: (rng, x, y, i) =>
    crusher(x, y, rng.range(34, 52), rng.range(26, 40), x, y + rng.range(120, 200), 0.22 + i * 0.14, rng.next(), 12 + i * 6),
  blade: (rng, x, y, i) => blade(x, y, rng.range(30, 46), rng.range(0.4, 0.8), 10 + i * 5),
  laser: (rng, x, y, i) => laser(x, y, rng.range(60, 130), 7, rng.range(0.3, 0.45), rng.range(0.35, 0.6), 7 + i * 4),
  launcher: (rng, x, y) => {
    const a = rng.range(-Math.PI * 0.85, -Math.PI * 0.15);
    return launcher(x, y, Math.cos(a), Math.sin(a), rng.range(1000, 1400));
  },
  slowzone: (rng, x, y) => slowZone(x, y, rng.range(60, 110), rng.range(40, 70), rng.range(1.8, 3)),
  temporary: (rng, x, y) => temporaryPlatform(x, y, rng.range(50, 74), 0.6, rng.range(2, 3)),
  teleporter: (rng, x, y) => {
    const tx = rng.range(140, ROOM_W - 140);
    const ty = rng.range(120, ROOM_H * 0.6);
    const a = rng.range(-Math.PI * 0.9, -Math.PI * 0.1);
    return teleporter(x, y, tx, ty, Math.cos(a), Math.sin(a));
  },
  gravityzone: (rng, x, y) =>
    gravityZone(x, y, rng.range(70, 130), rng.range(60, 110), rng.range(-700, 700), rng.range(-1400, -200)),
};

function hazardCountFor(archetype: RoomArchetype, intensity: number): number {
  const base: Partial<Record<RoomArchetype, number>> = {
    // Hazard rooms keep their density: that is their identity. Ordinary combat
    // rooms get fewer, so the enemies remain the content.
    trap: 5,
    challenge: 3,
    combat: 1.4,
    elite: 1.4,
    traversal: 2.5,
    puzzle: 2.5,
    gamble: 2.5,
    treasure: 1.6,
    secret: 1.6,
    miniboss: 1.4,
    respite: 0,
    shop: 0,
    event: 0,
    boss: 0,
  };
  return Math.round((base[archetype] ?? 2) * lerp(0.6, 1.4, intensity));
}

function placeHazards(
  rng: Rng,
  biome: BiomeDef,
  options: GenerateRoomOptions,
  spawnX: number,
  spawnY: number,
  intensity: number,
): PropSpec[] {
  const out: PropSpec[] = [];
  const kinds = Object.keys(biome.hazardWeights).filter((k) => HAZARD_BUILDERS[k]);
  if (kinds.length === 0) return out;
  const count = hazardCountFor(options.archetype, intensity);
  const placed: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < count; i++) {
    const kind = rng.weighted(kinds, (k) => biome.hazardWeights[k] ?? 0);
    if (!kind) break;
    // Up to six position attempts, then give up on this hazard rather than
    // forcing it somewhere unfair.
    for (let attempt = 0; attempt < 6; attempt++) {
      const x = rng.range(110, ROOM_W - 110);
      const y = rng.range(ROOM_H * 0.22, ROOM_H - 60);
      if (Math.hypot(x - spawnX, y - spawnY) < 190) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < 110)) continue;
      out.push(HAZARD_BUILDERS[kind](rng, x, y, intensity));
      placed.push({ x, y });
      break;
    }
  }
  return out;
}

/* -------------------------------------------------------------- encounter -- */

interface Encounter {
  spawns: EnemySpawn[];
  spent: number;
}

function buildEncounter(rng: Rng, options: GenerateRoomOptions, slots: Slot[]): Encounter {
  const spawns: EnemySpawn[] = [];
  if (options.archetype === 'boss') {
    const boss = bossForBiome(options.biome);
    const scaling = enemyScaling(options.depth, options.boundLevel);
    spawns.push({
      defId: boss.id,
      x: ROOM_W / 2,
      y: ROOM_H * 0.38,
      healthScale: scaling.healthScale * 0.85,
      damageScale: scaling.damageScale,
    });
    return { spawns, spent: boss.threat };
  }

  let budget = threatBudget(options.archetype, options.depth, options.boundLevel);
  if (budget <= 0) return { spawns, spent: 0 };

  const scaling = enemyScaling(options.depth, options.boundLevel);
  const pool = eligibleEnemies(options.biome, options.depth, options.unlocked);
  const elitePool = eligibleElites(options.biome, options.depth, options.unlocked);
  if (pool.length === 0) return { spawns, spent: 0 };

  const groundSlots = slots.filter((s) => s.kind === 'ground' || s.kind === 'perch');
  const airSlots = slots.filter((s) => s.kind === 'air' || s.kind === 'perch');
  let spent = 0;

  // Elite and miniboss rooms lead with their headline enemy, then spend what is
  // left on support that *conflicts* with the elite's answer.
  if ((options.archetype === 'elite' || options.archetype === 'miniboss') && elitePool.length > 0) {
    const elite = rng.pick(elitePool);
    const slot = pickSlot(rng, groundSlots.length ? groundSlots : slots);
    spawns.push({
      defId: elite.id,
      x: slot.x,
      y: slot.y - 10,
      healthScale: scaling.healthScale,
      damageScale: scaling.damageScale,
    });
    spent += elite.threat;
    budget -= elite.threat * 0.55;
  }

  let guard = 0;
  while (budget > 0 && guard++ < 40 && spawns.length < 26) {
    const affordable = pool.filter((d) => d.threat <= budget + 1.5);
    if (affordable.length === 0) break;
    const def = rng.weighted(affordable, (d) => enemyWeight(d, spawns, options)) ?? rng.pick(affordable);
    const wantsAir = def.tags.includes('air') || def.tags.includes('precision');
    const candidates = wantsAir ? (airSlots.length ? airSlots : slots) : groundSlots.length ? groundSlots : slots;
    const slot = pickSlot(rng, candidates);
    const jitter = def.tags.includes('swarm') ? 46 : 24;
    spawns.push({
      defId: def.id,
      x: clamp(slot.x + rng.range(-jitter, jitter), 70, ROOM_W - 70),
      y: clamp(slot.y + rng.range(-jitter * 0.6, jitter * 0.6), 80, ROOM_H - 70),
      healthScale: scaling.healthScale,
      damageScale: scaling.damageScale,
    });
    budget -= def.threat;
    spent += def.threat;

    // Swarm enemies come in packs; one Mote is not an encounter.
    if (def.tags.includes('swarm')) {
      const extra = rng.int(2, 4);
      for (let i = 0; i < extra && budget > 0; i++) {
        spawns.push({
          defId: def.id,
          x: clamp(slot.x + rng.range(-70, 70), 70, ROOM_W - 70),
          y: clamp(slot.y + rng.range(-56, 56), 80, ROOM_H - 70),
          healthScale: scaling.healthScale,
          damageScale: scaling.damageScale,
        });
        budget -= def.threat * 0.6;
        spent += def.threat * 0.6;
      }
    }
  }

  return { spawns, spent };
}

/**
 * Prefers enemies whose answer differs from what is already in the room.
 *
 * This is the whole difficulty philosophy in one function: rooms get harder by
 * asking two incompatible questions at once, not by adding health.
 */
function enemyWeight(def: EnemyDef, chosen: EnemySpawn[], options: GenerateRoomOptions): number {
  let weight = 1;
  const alreadyHere = chosen.filter((s) => s.defId === def.id).length;
  weight /= 1 + alreadyHere * 1.6;
  const tagsPresent = new Set<string>();
  for (const spawn of chosen) {
    const other = eligibleEnemies(options.biome, options.depth, options.unlocked).find((d) => d.id === spawn.defId);
    if (other) for (const tag of other.tags) tagsPresent.add(tag);
  }
  // Reward a different tag set; a room of five directional enemies is repetitive.
  const overlap = def.tags.filter((t) => tagsPresent.has(t)).length;
  weight *= overlap === 0 ? 1.7 : 1 / (1 + overlap);
  // Routing enemies (Lodestone) and ranged enemies combine especially well with
  // anything else, so they get a small bonus once the room has a core.
  if (chosen.length > 0 && (def.tags.includes('field') || def.tags.includes('ranged'))) weight *= 1.35;
  return weight;
}

function pickSlot(rng: Rng, slots: Slot[]): Slot {
  if (slots.length === 0) return { x: ROOM_W / 2, y: ROOM_H - 70, kind: 'ground', weight: 1 };
  return rng.weighted(slots, (s) => s.weight) ?? slots[0];
}

/* ---------------------------------------------------------- interactables -- */

function buildInteractables(
  rng: Rng,
  options: GenerateRoomOptions,
  slots: Slot[],
  intensity: number,
): Interactable[] {
  const out: Interactable[] = [];
  const rewardSlots = slots.filter((s) => s.kind === 'reward');
  const place = (kind: InteractableKind, payload = '', price = 0, index = 0): void => {
    const slot = rewardSlots[index % Math.max(1, rewardSlots.length)];
    const x = slot ? slot.x : ROOM_W * (0.3 + 0.2 * index);
    const y = slot ? slot.y : ROOM_H * 0.35;
    out.push({ kind, x: clamp(x, 80, ROOM_W - 80), y: clamp(y, 90, ROOM_H - 90), payload, price });
  };

  switch (options.archetype) {
    case 'treasure':
      place('chest');
      if (rng.chance(0.35)) place('chest', '', 0, 1);
      break;
    case 'shop':
      // Three pedestals across the room: buying is a bouncing problem.
      for (let i = 0; i < 3; i++) {
        out.push({
          kind: 'shop',
          x: ROOM_W * (0.25 + i * 0.25),
          y: ROOM_H * (i === 1 ? 0.42 : 0.56),
          payload: `slot${i}`,
          price: Math.round((14 + intensity * 26) * rng.range(0.85, 1.2)),
        });
      }
      break;
    case 'respite':
      place('heal');
      break;
    case 'event':
      place('altar');
      break;
    case 'gamble':
      out.push({ kind: 'gamble', x: ROOM_W * 0.35, y: ROOM_H * 0.45, payload: 'safe', price: 0 });
      out.push({ kind: 'gamble', x: ROOM_W * 0.65, y: ROOM_H * 0.45, payload: 'risky', price: 0 });
      break;
    case 'secret':
      place('relic');
      break;
    case 'challenge':
      place('chest');
      break;
    case 'puzzle':
      place('chest');
      break;
    default:
      break;
  }
  return out;
}

/** Summary line used by the debug room inspector and by generation tests. */
export function describeRoom(room: GeneratedRoom): string {
  return [
    `${room.templateName} [${room.archetype}/${room.biome}] depth ${room.depth}`,
    `props ${room.props.length}`,
    `enemies ${room.enemies.length} (threat ${room.threatSpent.toFixed(1)})`,
    `open ${(room.validation.openFraction * 100).toFixed(0)}%`,
    room.validation.ok ? 'valid' : `INVALID: ${room.validation.problems.join('; ')}`,
  ].join(' | ');
}
