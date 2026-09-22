/**
 * Biome definitions.
 *
 * A biome is a *rules change*, not a repaint. Each one alters something the ball
 * physically cares about - gravity, the friction of the dominant material, which
 * hazards appear - so a build that was comfortable in the Verdant Ruins has to be
 * re-piloted in the Frozen Abyss. The palette and audio identity exist to make
 * that rules change instantly legible.
 */

import type { MaterialId } from '../sim/materials';
import type { BiomeId, RoomArchetype } from './ids';

export interface BiomePalette {
  /** Background gradient, far to near. */
  skyTop: string;
  skyBottom: string;
  /** Distant parallax silhouette. */
  far: string;
  mid: string;
  /** Default terrain fill and edge. */
  terrain: string;
  terrainEdge: string;
  /** Accent used by hazards and highlights. */
  accent: string;
  /** Ambient particle colour. */
  dust: string;
  fog: string;
}

export interface BiomeDef {
  id: BiomeId;
  name: string;
  /** One line shown on the biome transition card. */
  tagline: string;
  /** How this biome changes play, shown in the journal. */
  rules: string;
  /** Gravity multiplier applied to the ball's gravity stat. */
  gravityScale: number;
  /** Lateral gravity, used by the Rift. */
  gravityLateralScale: number;
  /** Dominant terrain material; changes bounce and friction feel. */
  terrainMaterial: MaterialId;
  /** Secondary material used for platforms and accents. */
  accentMaterial: MaterialId;
  /** Hazard prop kinds weighted for this biome's trap rooms. */
  hazardWeights: Record<string, number>;
  /** Extra weight applied to these room archetypes. */
  roomBias: Partial<Record<RoomArchetype, number>>;
  palette: BiomePalette;
  /** Base musical key offset in semitones and tempo, for the synth layer. */
  musicRoot: number;
  musicTempo: number;
  /** Ambient hum frequency, distinct per biome. */
  ambientHz: number;
  /** Depth range (room index) where this biome appears. */
  order: number;
  /** Meta unlock required to route here. */
  unlock?: string;
}

export const BIOME_DEFS: BiomeDef[] = [
  {
    id: 'verdant',
    name: 'Verdant Ruins',
    tagline: 'Something grew over the machines and kept the shape.',
    rules: 'Moss absorbs your momentum. Stone is honest. Nothing here is trying to be clever.',
    gravityScale: 1,
    gravityLateralScale: 0,
    terrainMaterial: 'stone',
    accentMaterial: 'moss',
    hazardWeights: { spikes: 3, bouncepad: 3, crusher: 1, laser: 0.4, blade: 0.6, slowzone: 2 },
    roomBias: { combat: 1.3, traversal: 1.1, respite: 1.2 },
    palette: {
      skyTop: '#101a19',
      skyBottom: '#1b2c24',
      far: '#1f3a2c',
      mid: '#274934',
      terrain: '#2f3f45',
      terrainEdge: '#58796a',
      accent: '#8fe06a',
      dust: '#a8e0a0',
      fog: '#14241d',
    },
    musicRoot: 0,
    musicTempo: 96,
    ambientHz: 58,
    order: 0,
  },
  {
    id: 'foundry',
    name: 'Clockwork Foundry',
    tagline: 'The machines never stopped. They just ran out of instructions.',
    rules: 'Steel keeps your speed. Everything moves on a schedule - learn the schedule.',
    gravityScale: 1.05,
    gravityLateralScale: 0,
    terrainMaterial: 'metal',
    accentMaterial: 'wood',
    hazardWeights: { crusher: 3, blade: 3, laser: 2.2, launcher: 2, spikes: 1.4, bouncepad: 1.6 },
    roomBias: { trap: 1.6, elite: 1.2, puzzle: 1.3 },
    palette: {
      skyTop: '#14100c',
      skyBottom: '#2a1f14',
      far: '#33241a',
      mid: '#453021',
      terrain: '#3d4453',
      terrainEdge: '#8a9ab8',
      accent: '#ffb347',
      dust: '#ffcf8a',
      fog: '#1c150f',
    },
    musicRoot: -2,
    musicTempo: 112,
    ambientHz: 72,
    order: 1,
  },
  {
    id: 'abyss',
    name: 'Frozen Abyss',
    tagline: 'Cold enough that friction forgot its job.',
    rules: 'Ice returns all of your sideways speed. Control is the scarce resource, not power.',
    gravityScale: 0.88,
    gravityLateralScale: 0,
    terrainMaterial: 'ice',
    accentMaterial: 'obsidian',
    hazardWeights: { spikes: 2.4, blade: 1.6, crusher: 1.4, temporary: 2.4, slowzone: 0.6, bouncepad: 2 },
    roomBias: { traversal: 1.5, challenge: 1.3, treasure: 1.1 },
    palette: {
      skyTop: '#0a1220',
      skyBottom: '#122236',
      far: '#183149',
      mid: '#1f4260',
      terrain: '#254358',
      terrainEdge: '#7fd0f0',
      accent: '#7fe8ff',
      dust: '#c8f0ff',
      fog: '#0d1a2a',
    },
    musicRoot: 3,
    musicTempo: 88,
    ambientHz: 49,
    order: 2,
  },
  {
    id: 'citadel',
    name: 'Storm Citadel',
    tagline: 'A building that decided it was weather.',
    rules: 'Conductive surfaces everywhere. Arc effects reach further, and so do the turrets.',
    gravityScale: 1,
    gravityLateralScale: 0,
    terrainMaterial: 'metal',
    accentMaterial: 'crystal',
    hazardWeights: { laser: 3.2, launcher: 2.4, blade: 1.8, crusher: 1.2, spikes: 1.6, teleporter: 1.4 },
    roomBias: { elite: 1.4, combat: 1.2, gamble: 1.2 },
    palette: {
      skyTop: '#0d0f1e',
      skyBottom: '#1a1f3a',
      far: '#232a52',
      mid: '#2e3768',
      terrain: '#333a55',
      terrainEdge: '#9db0ff',
      accent: '#b9a0ff',
      dust: '#d8d0ff',
      fog: '#12142a',
    },
    musicRoot: -4,
    musicTempo: 124,
    ambientHz: 66,
    order: 3,
    unlock: 'biome_citadel',
  },
  {
    id: 'rift',
    name: 'Gravity Rift',
    tagline: 'Down is a local convention.',
    rules: 'Gravity is weaker and pulls sideways in places. Your whole routing instinct is wrong here.',
    gravityScale: 0.72,
    gravityLateralScale: 0.35,
    terrainMaterial: 'obsidian',
    accentMaterial: 'void',
    hazardWeights: { teleporter: 3, temporary: 2.6, spikes: 1.6, blade: 1.4, launcher: 2, gravityzone: 3.4 },
    roomBias: { puzzle: 1.6, traversal: 1.4, secret: 1.4 },
    palette: {
      skyTop: '#12091c',
      skyBottom: '#241236',
      far: '#33184c',
      mid: '#43215f',
      terrain: '#2e2440',
      terrainEdge: '#a678ff',
      accent: '#ff7ae0',
      dust: '#e0a8ff',
      fog: '#190c26',
    },
    musicRoot: 5,
    musicTempo: 104,
    ambientHz: 41,
    order: 4,
    unlock: 'biome_rift',
  },
  {
    id: 'void',
    name: 'The Unbound',
    tagline: 'The place the bouncing was always heading.',
    rules: 'Surfaces are provisional. Everything you land on is a decision about how long it lasts.',
    gravityScale: 0.95,
    gravityLateralScale: 0.15,
    terrainMaterial: 'void',
    accentMaterial: 'crystal',
    hazardWeights: { temporary: 4, teleporter: 2.4, blade: 2, spikes: 2, laser: 2, gravityzone: 2 },
    roomBias: { elite: 1.5, challenge: 1.6, secret: 1.6 },
    palette: {
      skyTop: '#06060c',
      skyBottom: '#100d1c',
      far: '#1a1430',
      mid: '#241b44',
      terrain: '#1a1628',
      terrainEdge: '#7a5fd8',
      accent: '#ff5f9e',
      dust: '#b090ff',
      fog: '#0a0812',
    },
    musicRoot: -7,
    musicTempo: 132,
    ambientHz: 36,
    order: 5,
    unlock: 'biome_void',
  },
];

export const BIOME_BY_ID: Record<BiomeId, BiomeDef> = Object.fromEntries(
  BIOME_DEFS.map((b) => [b.id, b]),
) as Record<BiomeId, BiomeDef>;

export function getBiome(id: BiomeId): BiomeDef {
  return BIOME_BY_ID[id] ?? BIOME_DEFS[0];
}

/** Biomes available for a run, respecting meta unlocks, in progression order. */
export function availableBiomes(unlocked: (id: string) => boolean): BiomeDef[] {
  return BIOME_DEFS.filter((b) => !b.unlock || unlocked(b.unlock)).sort((a, b) => a.order - b.order);
}
