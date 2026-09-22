/**
 * Enemy definitions.
 *
 * Every enemy exists to ask a *collision* question, never to be a bigger health
 * bar. Read the `approach` field of each entry as the design brief for that
 * enemy: if two enemies would be approached the same way, one of them is
 * redundant and should be cut.
 *
 * Difficulty scaling multiplies health and damage only gently. The real
 * escalation comes from combining enemies whose answers conflict - a Lodestone
 * dragging the ball toward a Bristler's spiked arc is far harder than either
 * alone, and costs the generator almost nothing.
 */

import { EnemyFlag } from '../sim/entities';
import type { MaterialId } from '../sim/materials';
import type { BiomeId } from './ids';

export type EnemyAi =
  | 'swarm'
  | 'walker'
  | 'charger'
  | 'hover'
  | 'turret'
  | 'anchored'
  | 'blinker'
  | 'orbiter'
  | 'lodestone'
  | 'mirror'
  | 'bomber'
  | 'splitter'
  | 'weaver'
  | 'bossMirror'
  | 'bossCrusher'
  | 'bossArchitect'
  | 'bossPart';

export type EnemyShapeKind = 'circle' | 'tri' | 'quad' | 'hex' | 'diamond';

export interface EnemyDef {
  id: string;
  name: string;
  /** The intended solution, shown in the journal once discovered. */
  approach: string;
  ai: EnemyAi;
  hp: number;
  radius: number;
  flags: number;
  shape: EnemyShapeKind;
  material: MaterialId;
  color: string;
  accent: string;
  contactDamage: number;
  /** Half-angle of the armoured/dangerous arc, in radians. 0 = none. */
  armorArc: number;
  /** Shards dropped. */
  reward: number;
  /** Encounter budget cost used by the room generator. */
  threat: number;
  /** Earliest room depth this enemy may appear at. */
  minDepth: number;
  /**
   * What a Splitter breaks into. Defaults to itself, which is what makes a
   * Cleaver split into smaller Cleavers. Set explicitly when an enemy should not
   * reproduce: a Brood Matron that split into more Matrons would multiply its own
   * spawner, and balance runs produced forty concurrent Motes from one kill.
   */
  splitsInto?: string;
  biomes: BiomeId[];
  /** Meta unlock id required before this enemy can be generated. */
  unlock?: string;
  params: Record<string, number>;
  tags: string[];
}

const F = EnemyFlag;

export const ENEMY_DEFS: EnemyDef[] = [
  {
    id: 'mote',
    name: 'Mote',
    approach: 'Dies to anything. Cluster them and let one impact cascade through the group.',
    ai: 'swarm',
    hp: 8,
    radius: 9,
    flags: F.Fragile | F.Flying,
    shape: 'circle',
    material: 'flesh',
    color: '#7fe0c0',
    accent: '#d6fff2',
    contactDamage: 0,
    armorArc: 0,
    reward: 1,
    threat: 1,
    minDepth: 0,
    biomes: ['verdant', 'foundry', 'abyss', 'citadel', 'rift', 'void'],
    params: { driftSpeed: 55, followStrength: 130 },
    tags: ['swarm'],
  },
  {
    id: 'husk',
    name: 'Husk',
    approach: 'Harmless to touch. Your tutorial target and your free bounce surface.',
    ai: 'walker',
    hp: 26,
    radius: 15,
    flags: 0,
    shape: 'circle',
    material: 'flesh',
    color: '#8c93b8',
    accent: '#c9cfe8',
    contactDamage: 0,
    armorArc: 0,
    reward: 2,
    threat: 2,
    minDepth: 0,
    biomes: ['verdant', 'foundry', 'abyss', 'citadel', 'rift', 'void'],
    params: { walkSpeed: 62 },
    tags: ['ground'],
  },
  {
    id: 'bristler',
    name: 'Bristler',
    approach: 'Spined along its back. Dropping on it costs you; come in from a flank instead.',
    ai: 'walker',
    hp: 34,
    radius: 17,
    flags: F.Spiked | F.Armored,
    shape: 'quad',
    material: 'bone',
    color: '#b4705a',
    accent: '#ffb38a',
    contactDamage: 12,
    // Spines point upward and stay there. An earlier version tracked the ball,
    // which sounded threatening and played terribly: the protected arc was always
    // between you and the target, so the enemy was not a puzzle with an answer,
    // it was a wall. A fixed arc is the whole lesson - the room has taught you
    // that falling onto things is not always the play.
    armorArc: 1.0,
    reward: 3,
    threat: 3,
    minDepth: 1,
    biomes: ['verdant', 'abyss', 'rift', 'void'],
    params: { walkSpeed: 54, fixedArmor: -1.5708 },
    tags: ['ground', 'directional'],
  },
  {
    id: 'plated',
    name: 'Platewright',
    approach: 'Its plate turns to face whatever last hit it. Every wound must come from a new direction.',
    ai: 'walker',
    hp: 62,
    radius: 19,
    flags: F.Armored | F.Anchored,
    shape: 'hex',
    material: 'metal',
    color: '#5f6f96',
    accent: '#a9c4ea',
    contactDamage: 0,
    armorArc: 1.25,
    reward: 5,
    threat: 5,
    minDepth: 2,
    biomes: ['foundry', 'citadel', 'rift'],
    params: { rotateToHit: 1, rotateSpeed: 5.5 },
    tags: ['armored', 'directional'],
  },
  {
    id: 'bloater',
    name: 'Bloater',
    approach: 'Detonates when killed. A free chain reaction if you line up its neighbours first.',
    ai: 'bomber',
    hp: 22,
    radius: 21,
    flags: F.Explosive,
    shape: 'circle',
    material: 'flesh',
    color: '#c2704f',
    accent: '#ffd9a0',
    contactDamage: 0,
    armorArc: 0,
    reward: 3,
    threat: 3,
    minDepth: 1,
    biomes: ['verdant', 'foundry', 'abyss', 'void'],
    params: { blastRadius: 118, blastDamage: 34, driftSpeed: 34 },
    tags: ['explosive', 'chain'],
  },
  {
    id: 'warden',
    name: 'Warden',
    approach: 'Its ward absorbs direct hits. Bounce off something else first, then strike.',
    ai: 'anchored',
    hp: 54,
    radius: 20,
    flags: F.RicochetGated,
    shape: 'diamond',
    material: 'crystal',
    color: '#6f62c9',
    accent: '#bdb2ff',
    contactDamage: 0,
    armorArc: 0,
    reward: 5,
    threat: 4,
    minDepth: 2,
    biomes: ['foundry', 'citadel', 'abyss', 'rift', 'void'],
    params: { hoverAmp: 26, hoverSpeed: 1.1 },
    tags: ['gated'],
  },
  {
    id: 'wisp',
    name: 'Wisp',
    approach: 'Stays airborne and out of your arc. You have to commit to a trajectory to reach it.',
    ai: 'hover',
    hp: 24,
    radius: 13,
    flags: F.Flying,
    shape: 'tri',
    material: 'flesh',
    color: '#8fd0f0',
    accent: '#e2f7ff',
    contactDamage: 8,
    armorArc: 0,
    reward: 3,
    threat: 3,
    minDepth: 1,
    biomes: ['verdant', 'abyss', 'citadel', 'rift', 'void'],
    params: { hoverHeight: 150, dodgeStrength: 210, dodgeRange: 150 },
    tags: ['air'],
  },
  {
    id: 'lodestone',
    name: 'Lodestone',
    approach: 'Drags you in. Fight the pull, or use it to reach somewhere you could not.',
    ai: 'lodestone',
    hp: 46,
    radius: 18,
    flags: F.Magnetic | F.Anchored,
    shape: 'hex',
    material: 'metal',
    color: '#4d7f8c',
    accent: '#9de3f0',
    contactDamage: 0,
    armorArc: 0,
    reward: 4,
    threat: 4,
    minDepth: 2,
    biomes: ['foundry', 'abyss', 'citadel', 'rift'],
    params: { pullRadius: 300, pullForce: 1750 },
    tags: ['field', 'routing'],
  },
  {
    id: 'bulwark',
    name: 'Bulwark',
    approach: 'Too heavy to move. It eats your momentum, but it is also a reliable platform.',
    ai: 'anchored',
    hp: 110,
    radius: 27,
    flags: F.Heavy | F.Anchored | F.Platform,
    shape: 'quad',
    material: 'obsidian',
    color: '#4a4459',
    accent: '#8b7fa8',
    contactDamage: 0,
    armorArc: 0,
    reward: 6,
    threat: 5,
    minDepth: 3,
    biomes: ['foundry', 'abyss', 'citadel', 'void'],
    params: { absorb: 0.55 },
    tags: ['heavy', 'platform'],
  },
  {
    id: 'mirrorling',
    name: 'Mirrorling',
    approach: 'Sends you back the way you came. Approach so that the return path is useful.',
    ai: 'mirror',
    hp: 40,
    radius: 16,
    flags: F.Reflector | F.Flying,
    shape: 'diamond',
    material: 'ice',
    color: '#6ba7c9',
    accent: '#d8f4ff',
    contactDamage: 0,
    armorArc: 0,
    reward: 4,
    threat: 4,
    minDepth: 3,
    biomes: ['abyss', 'citadel', 'rift', 'void'],
    params: { driftSpeed: 48, reflectBoost: 1.12 },
    tags: ['reflect'],
  },
  {
    id: 'glassling',
    name: 'Glassling',
    approach: 'Shatters instantly above 700u/s. Slower than that and it hardens for a moment.',
    ai: 'hover',
    hp: 70,
    radius: 14,
    flags: F.Fragile | F.Flying,
    shape: 'tri',
    material: 'crystal',
    color: '#a7e8ff',
    accent: '#ffffff',
    contactDamage: 0,
    armorArc: 0,
    reward: 5,
    threat: 4,
    minDepth: 3,
    biomes: ['abyss', 'citadel', 'rift', 'void'],
    params: { shatterSpeed: 700, hoverHeight: 190, hardenTime: 1.1 },
    tags: ['precision'],
  },
  {
    id: 'spitter',
    name: 'Spitter',
    approach: 'Rooted and shooting. Its bullets define the safe lanes, so plan the route first.',
    ai: 'turret',
    hp: 38,
    radius: 17,
    flags: F.Anchored,
    shape: 'quad',
    material: 'bone',
    color: '#9a6f4f',
    accent: '#ffcf9a',
    contactDamage: 0,
    armorArc: 0,
    reward: 4,
    threat: 4,
    minDepth: 2,
    biomes: ['verdant', 'foundry', 'citadel', 'rift', 'void'],
    params: { fireInterval: 1.9, bulletSpeed: 330, bulletDamage: 10, telegraph: 0.55, burst: 1 },
    tags: ['ranged'],
  },
  {
    id: 'blinker',
    name: 'Blinker',
    approach: 'Teleports away from danger on a fixed rhythm. Aim at where the rhythm puts it.',
    ai: 'blinker',
    hp: 44,
    radius: 15,
    flags: F.Flying,
    shape: 'diamond',
    material: 'void',
    color: '#8a5fd8',
    accent: '#e0c8ff',
    contactDamage: 10,
    armorArc: 0,
    reward: 5,
    threat: 5,
    minDepth: 4,
    biomes: ['citadel', 'rift', 'void'],
    params: { blinkInterval: 2.1, blinkRange: 230, telegraph: 0.45 },
    tags: ['prediction'],
  },
  {
    id: 'cleaver',
    name: 'Cleaver',
    approach: 'Splits in two when it dies, twice. Kill it where the fragments will be useful.',
    ai: 'splitter',
    hp: 58,
    radius: 22,
    flags: F.Splitter,
    shape: 'hex',
    material: 'bone',
    color: '#a8546a',
    accent: '#ffb0c0',
    contactDamage: 0,
    armorArc: 0,
    reward: 4,
    threat: 5,
    minDepth: 3,
    biomes: ['verdant', 'abyss', 'rift', 'void'],
    params: { splits: 2, childScale: 0.62, spread: 210 },
    tags: ['splitter'],
  },
  {
    id: 'thornweaver',
    name: 'Thornweaver',
    approach: 'Grows spined walls across your lanes. Kill it early or lose the room to its geometry.',
    ai: 'weaver',
    hp: 76,
    radius: 20,
    flags: F.Anchored,
    shape: 'hex',
    material: 'moss',
    color: '#4f8a4a',
    accent: '#b7f0a0',
    contactDamage: 0,
    armorArc: 0,
    reward: 6,
    threat: 6,
    minDepth: 4,
    biomes: ['verdant', 'abyss'],
    params: { growInterval: 3.4, thornLife: 7, thornDamage: 11 },
    tags: ['terrain'],
  },
  {
    id: 'gearhound',
    name: 'Gearhound',
    approach: 'Charges along the floor on a telegraph. Its charge is also the fastest ride in the room.',
    ai: 'charger',
    hp: 52,
    radius: 18,
    flags: F.Spiked | F.Armored | F.Springy,
    shape: 'quad',
    material: 'metal',
    color: '#8a6f3f',
    accent: '#ffd98a',
    contactDamage: 14,
    armorArc: 0.9,
    reward: 5,
    threat: 5,
    minDepth: 3,
    biomes: ['foundry', 'citadel', 'rift'],
    params: { chargeSpeed: 430, telegraph: 0.6, cooldown: 1.9, walkSpeed: 70 },
    tags: ['ground', 'directional'],
  },

  /* ------------------------------------------------------------- elites -- */
  {
    id: 'plated_prime',
    name: 'Platewright Prime',
    approach: 'Four plates, all facing outward. Only a fast multi-angle chain gets through.',
    ai: 'walker',
    hp: 210,
    radius: 26,
    flags: F.Armored | F.Anchored | F.Elite,
    shape: 'hex',
    material: 'metal',
    color: '#7b6fd0',
    accent: '#d6ccff',
    contactDamage: 0,
    armorArc: 1.5,
    reward: 20,
    threat: 14,
    minDepth: 4,
    biomes: ['foundry', 'citadel', 'rift'],
    params: { rotateToHit: 1, rotateSpeed: 3.2, shockOnHit: 1 },
    tags: ['elite', 'armored'],
  },
  {
    id: 'brood_mother',
    name: 'Brood Matron',
    approach: 'Endless Motes until the Matron falls. Cut the source, not the swarm.',
    ai: 'splitter',
    hp: 190,
    radius: 30,
    flags: F.Splitter | F.Elite,
    shape: 'circle',
    material: 'flesh',
    color: '#c05a8a',
    accent: '#ffc0e0',
    contactDamage: 0,
    armorArc: 0,
    reward: 22,
    threat: 15,
    minDepth: 5,
    biomes: ['verdant', 'abyss', 'void'],
    splitsInto: 'mote',
    params: { splits: 4, childScale: 1, spread: 250, spawnInterval: 3.2, broodCap: 5 },
    tags: ['elite', 'swarm'],
  },
  {
    id: 'void_sentinel',
    name: 'Void Sentinel',
    approach: 'Warded, teleporting and armed. Ricochet in, then commit before it blinks.',
    ai: 'blinker',
    hp: 260,
    radius: 27,
    flags: F.RicochetGated | F.Flying | F.Elite,
    shape: 'diamond',
    material: 'void',
    color: '#6f4fd8',
    accent: '#c9b0ff',
    contactDamage: 16,
    armorArc: 0,
    reward: 24,
    threat: 16,
    minDepth: 6,
    biomes: ['citadel', 'rift', 'void'],
    params: { blinkInterval: 1.7, blinkRange: 300, telegraph: 0.35, fireInterval: 2.4, bulletSpeed: 380, bulletDamage: 12 },
    tags: ['elite', 'gated'],
  },
];

export const ENEMY_BY_ID: Record<string, EnemyDef> = Object.fromEntries(ENEMY_DEFS.map((d) => [d.id, d]));

/**
 * Registers additional definitions (bosses, future content packs) into the same
 * lookup the simulation uses. Keeping one registry means boss parts, summons and
 * regular enemies all flow through identical spawn and damage code.
 */
export function registerEnemyDefs(defs: EnemyDef[]): void {
  for (const def of defs) {
    ENEMY_BY_ID[def.id] = def;
  }
}

export function getEnemyDef(id: string): EnemyDef {
  const def = ENEMY_BY_ID[id];
  if (!def) throw new Error(`Unknown enemy definition: ${id}`);
  return def;
}

/** Enemies eligible for a given biome and depth, excluding elites and bosses. */
export function eligibleEnemies(biome: BiomeId, depth: number, unlocked: (id: string) => boolean): EnemyDef[] {
  return ENEMY_DEFS.filter(
    (def) =>
      !def.tags.includes('elite') &&
      def.biomes.includes(biome) &&
      def.minDepth <= depth &&
      (!def.unlock || unlocked(def.unlock)),
  );
}

export function eligibleElites(biome: BiomeId, depth: number, unlocked: (id: string) => boolean): EnemyDef[] {
  return ENEMY_DEFS.filter(
    (def) =>
      def.tags.includes('elite') &&
      def.biomes.includes(biome) &&
      def.minDepth <= depth &&
      (!def.unlock || unlocked(def.unlock)),
  );
}
