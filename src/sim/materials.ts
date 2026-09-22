/**
 * Surface materials.
 *
 * Material is a gameplay input, not decoration. A ball that keeps its speed on
 * metal but loses it in moss changes how a room is routed, and several upgrade
 * families read material tags directly (Conductive surfaces for Lightning,
 * Frictionless for Momentum, Scorchable for Burning).
 */

export type MaterialId =
  | 'stone'
  | 'metal'
  | 'wood'
  | 'ice'
  | 'moss'
  | 'rubber'
  | 'crystal'
  | 'obsidian'
  | 'void'
  | 'flesh'
  | 'bone'
  | 'sand';

export type MaterialTag = 'conductive' | 'scorchable' | 'frictionless' | 'absorbent' | 'brittle' | 'unstable' | 'organic';

export interface Material {
  id: MaterialId;
  name: string;
  /** Fraction of the normal velocity component returned by a bounce. */
  restitution: number;
  /** Fraction of the tangential velocity component retained. 1 = frictionless. */
  tangentRetention: number;
  /** Multiplier on impact damage dealt to breakables resting on this surface. */
  impactScale: number;
  /** Base pitch for the procedural bounce sound, in semitones from A4. */
  pitch: number;
  /** Timbre selector for the synthesiser. */
  timbre: 'thud' | 'ping' | 'knock' | 'glass' | 'soft' | 'boom';
  color: string;
  edgeColor: string;
  tags: MaterialTag[];
}

const defs: Material[] = [
  {
    id: 'stone',
    name: 'Stone',
    restitution: 0.88,
    tangentRetention: 0.955,
    impactScale: 1,
    pitch: -8,
    timbre: 'thud',
    color: '#3b4358',
    edgeColor: '#5c6884',
    tags: [],
  },
  {
    id: 'metal',
    name: 'Plated Steel',
    restitution: 0.96,
    tangentRetention: 0.99,
    impactScale: 1.05,
    pitch: 7,
    timbre: 'ping',
    color: '#4a5570',
    edgeColor: '#8fa6c9',
    tags: ['conductive'],
  },
  {
    id: 'wood',
    name: 'Timber',
    restitution: 0.76,
    tangentRetention: 0.93,
    impactScale: 1.15,
    pitch: -3,
    timbre: 'knock',
    color: '#4c3a2c',
    edgeColor: '#7a5b40',
    tags: ['scorchable', 'brittle'],
  },
  {
    id: 'ice',
    name: 'Black Ice',
    restitution: 0.9,
    tangentRetention: 1.0,
    impactScale: 0.9,
    pitch: 12,
    timbre: 'glass',
    color: '#2f4f66',
    edgeColor: '#93d4ef',
    tags: ['frictionless', 'brittle'],
  },
  {
    id: 'moss',
    name: 'Deep Moss',
    restitution: 0.58,
    tangentRetention: 0.86,
    impactScale: 0.8,
    pitch: -12,
    timbre: 'soft',
    color: '#2c4433',
    edgeColor: '#4e7a52',
    tags: ['absorbent', 'scorchable', 'organic'],
  },
  {
    id: 'rubber',
    name: 'Kinetic Weave',
    restitution: 1.22,
    tangentRetention: 0.97,
    impactScale: 1,
    pitch: 2,
    timbre: 'boom',
    color: '#5a2f52',
    edgeColor: '#c065a8',
    tags: [],
  },
  {
    id: 'crystal',
    name: 'Resonant Crystal',
    restitution: 1.04,
    tangentRetention: 0.985,
    impactScale: 1.3,
    pitch: 16,
    timbre: 'glass',
    color: '#3a3a6b',
    edgeColor: '#9d8cf0',
    tags: ['conductive', 'brittle'],
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    restitution: 0.93,
    tangentRetention: 0.975,
    impactScale: 1.1,
    pitch: -5,
    timbre: 'glass',
    color: '#241f33',
    edgeColor: '#4a3f63',
    tags: [],
  },
  {
    id: 'void',
    name: 'Unstable Void',
    restitution: 1.0,
    tangentRetention: 0.99,
    impactScale: 1,
    pitch: -17,
    timbre: 'boom',
    color: '#150f22',
    edgeColor: '#6b4fd8',
    tags: ['unstable'],
  },
  {
    id: 'flesh',
    name: 'Carapace',
    restitution: 0.82,
    tangentRetention: 0.9,
    impactScale: 1,
    pitch: -10,
    timbre: 'soft',
    color: '#4a2a35',
    edgeColor: '#8a4457',
    tags: ['organic', 'scorchable'],
  },
  {
    id: 'bone',
    name: 'Calcified Bone',
    restitution: 0.9,
    tangentRetention: 0.96,
    impactScale: 1.2,
    pitch: 4,
    timbre: 'knock',
    color: '#4d4a40',
    edgeColor: '#b3ae94',
    tags: ['brittle', 'organic'],
  },
  {
    id: 'sand',
    name: 'Packed Sand',
    restitution: 0.66,
    tangentRetention: 0.88,
    impactScale: 0.85,
    pitch: -14,
    timbre: 'soft',
    color: '#4a4030',
    edgeColor: '#8c7850',
    tags: ['absorbent'],
  },
];

export const MATERIALS: Record<MaterialId, Material> = Object.fromEntries(
  defs.map((m) => [m.id, m]),
) as Record<MaterialId, Material>;

export const MATERIAL_IDS = defs.map((m) => m.id);

export function getMaterial(id: MaterialId): Material {
  return MATERIALS[id] ?? MATERIALS.stone;
}

export function materialHasTag(id: MaterialId, tag: MaterialTag): boolean {
  return getMaterial(id).tags.includes(tag);
}

export type SurfaceClass = 'floor' | 'wall' | 'ceiling' | 'slope';

/**
 * Classifies a contact by its normal. Upgrades like Wall Bounce and Ground
 * Bounce key off this, so the thresholds are deliberately generous: a 30-degree
 * slope still counts as a floor because that is how it plays.
 */
export function classifySurface(nx: number, ny: number): SurfaceClass {
  if (ny <= -0.72) return 'floor';
  if (ny >= 0.72) return 'ceiling';
  if (Math.abs(nx) >= 0.72) return 'wall';
  return 'slope';
}
