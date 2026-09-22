/**
 * Boss definitions.
 *
 * A boss is not a large enemy. Each one takes a single property of the physics
 * and turns it into the whole fight:
 *
 *  - The Mirror owns *reflection*: it gives your own velocity back to you, and
 *    the only way in is through the gap in its rotating shell.
 *  - The Crusher owns *geometry*: it changes the shape of the arena, so the fight
 *    is about routing through a space that keeps shrinking.
 *  - The Architect owns *surfaces*: it removes the floor and rebuilds it, so the
 *    fight is about whether you can stay airborne on its terms.
 *
 * Health totals are deliberately modest. A boss that takes a long time to kill
 * while doing nothing new is a worse fight than a short one that demands a
 * different approach in every phase.
 */

import { EnemyFlag } from '../sim/entities';
import { registerEnemyDefs, type EnemyDef } from './enemies';
import type { BiomeId } from './ids';

const F = EnemyFlag;

export interface BossDef extends EnemyDef {
  /** Health fractions at which the boss changes phase, descending. */
  phaseThresholds: number[];
  /** Short phase names shown on the boss bar. */
  phaseNames: string[];
  /** Biome this boss terminates. */
  biome: BiomeId;
  /** Journal entry describing the intended read on the fight. */
  lore: string;
}

export const BOSS_DEFS: BossDef[] = [
  {
    id: 'boss_mirror',
    name: 'The Mirror',
    approach: 'It returns exactly what you give it. Enter through the gap in its shell, not through the plates.',
    lore: 'A sealed thing that learned only one trick: whatever arrives, leaves the same way.',
    ai: 'bossMirror',
    hp: 900,
    radius: 42,
    flags: F.Boss | F.Anchored | F.Armored,
    shape: 'diamond',
    material: 'ice',
    color: '#6f9fd8',
    accent: '#e8f8ff',
    contactDamage: 0,
    armorArc: 2.35,
    reward: 90,
    threat: 40,
    minDepth: 0,
    biomes: ['verdant'],
    biome: 'verdant',
    phaseThresholds: [0.66, 0.33],
    phaseNames: ['Sealed', 'Fracturing', 'Shattered'],
    params: {
      shellSpin: 0.55,
      volleyInterval: 3.4,
      volleyCount: 5,
      bulletSpeed: 300,
      bulletDamage: 11,
      echoCount: 2,
    },
    tags: ['boss'],
  },
  {
    id: 'boss_crusher',
    name: 'The Crusher',
    approach: 'It rewrites the arena. Read the pistons, keep a lane open, and strike the core while it is extended.',
    lore: 'Foundry machinery that kept working long after the thing it was built to shape ran out.',
    ai: 'bossCrusher',
    hp: 1150,
    radius: 46,
    flags: F.Boss | F.Anchored | F.Heavy,
    shape: 'quad',
    material: 'metal',
    color: '#8a6a3a',
    accent: '#ffd27a',
    contactDamage: 0,
    armorArc: 0,
    reward: 110,
    threat: 45,
    minDepth: 0,
    biomes: ['foundry'],
    biome: 'foundry',
    phaseThresholds: [0.7, 0.35],
    phaseNames: ['Calibrating', 'Overdriven', 'Runaway'],
    params: {
      slamInterval: 4.2,
      slamSpeed: 720,
      shockDamage: 16,
      vulnerableWindow: 2.2,
      bladeCount: 2,
    },
    tags: ['boss'],
  },
  {
    id: 'boss_architect',
    name: 'The Architect',
    approach: 'It decides where the floor is. Destroy its anchors while it rebuilds, and never plan past its next edit.',
    lore: 'It is not hostile. It is renovating, and you are inside the plan.',
    ai: 'bossArchitect',
    hp: 1050,
    radius: 40,
    flags: F.Boss | F.Anchored | F.RicochetGated,
    shape: 'hex',
    material: 'obsidian',
    color: '#7a5fc9',
    accent: '#d6c4ff',
    contactDamage: 0,
    armorArc: 0,
    reward: 120,
    threat: 45,
    minDepth: 0,
    biomes: ['abyss'],
    biome: 'abyss',
    phaseThresholds: [0.72, 0.38],
    phaseNames: ['Drafting', 'Revising', 'Demolition'],
    params: {
      editInterval: 5,
      anchorHp: 70,
      anchorCount: 3,
      platformLife: 6,
      turretInterval: 2.6,
    },
    tags: ['boss'],
  },
];

/** Boss parts are separate entities so each can be hit, armoured and destroyed. */
export const BOSS_PART_DEFS: EnemyDef[] = [
  {
    id: 'mirror_panel',
    name: 'Mirror Panel',
    approach: 'Reflects. Use it to reach the gap rather than trying to break it.',
    ai: 'bossPart',
    hp: 120,
    radius: 26,
    flags: F.Boss | F.Reflector | F.Anchored | F.Flying,
    shape: 'quad',
    material: 'ice',
    color: '#8fc4e8',
    accent: '#ffffff',
    contactDamage: 0,
    armorArc: 0,
    reward: 6,
    threat: 0,
    minDepth: 0,
    biomes: [],
    params: { reflectBoost: 1.16 },
    tags: ['bosspart'],
  },
  {
    id: 'mirror_echo',
    name: 'Echo',
    approach: 'A copy that gives nothing back. Only the original bleeds.',
    ai: 'bossPart',
    hp: 60,
    radius: 30,
    flags: F.Boss | F.Flying | F.Reflector,
    shape: 'diamond',
    material: 'ice',
    color: '#5f7fa8',
    accent: '#c8e4ff',
    contactDamage: 9,
    armorArc: 0,
    reward: 4,
    threat: 0,
    minDepth: 0,
    biomes: [],
    params: { reflectBoost: 1.05 },
    tags: ['bosspart'],
  },
  {
    id: 'crusher_piston',
    name: 'Piston',
    approach: 'Unbreakable. It is a schedule, not a target.',
    ai: 'bossPart',
    hp: 999999,
    radius: 34,
    flags: F.Boss | F.Anchored | F.Spiked | F.Platform,
    shape: 'quad',
    material: 'metal',
    color: '#6a5a44',
    accent: '#ffc46a',
    contactDamage: 18,
    armorArc: 0,
    reward: 0,
    threat: 0,
    minDepth: 0,
    biomes: [],
    params: {},
    tags: ['bosspart', 'invulnerable'],
  },
  {
    id: 'architect_anchor',
    name: 'Anchor',
    approach: 'Breaking one strips the Architect of a phase of construction.',
    ai: 'bossPart',
    hp: 70,
    radius: 20,
    flags: F.Boss | F.Anchored | F.Platform,
    shape: 'hex',
    material: 'crystal',
    color: '#a88fe8',
    accent: '#f0e8ff',
    contactDamage: 0,
    armorArc: 0,
    reward: 10,
    threat: 0,
    minDepth: 0,
    biomes: [],
    params: {},
    tags: ['bosspart'],
  },
];

registerEnemyDefs([...BOSS_DEFS, ...BOSS_PART_DEFS]);

export const BOSS_BY_ID: Record<string, BossDef> = Object.fromEntries(BOSS_DEFS.map((d) => [d.id, d]));

export function bossForBiome(biome: BiomeId): BossDef {
  return BOSS_DEFS.find((d) => d.biome === biome) ?? BOSS_DEFS[0];
}

export function isBossDef(id: string): boolean {
  return id in BOSS_BY_ID;
}
