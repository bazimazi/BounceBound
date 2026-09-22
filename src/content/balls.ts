/**
 * Ball classes.
 *
 * A ball class is not a stat preset. Each one is a different *game*: the Heavy
 * ball plays a positioning game, the Light ball plays a reaction game, the Chrono
 * ball plays a timing game. The stat overrides exist to support the class's
 * behaviour, not the other way round.
 *
 * Every class also ships a starting upgrade, which is the fastest way to teach
 * what it wants to do. A player who picks Volatile and immediately has Explosive
 * Impact learns the fantasy in the first room rather than the fifth.
 */

import type { StatModifiers } from '../sim/stats';
import type { ArchetypeId } from './ids';

export interface BallClassDef {
  id: string;
  name: string;
  /** One line of identity, shown on the selection card. */
  tagline: string;
  /** How it actually plays, two sentences maximum. */
  description: string;
  /** What it gives up. Always stated. */
  cost: string;
  /** Base stat overrides applied before any upgrades. */
  base: StatModifiers;
  /** Upgrade granted at the start of a run. */
  startingUpgrade?: string;
  /** Archetypes this class naturally leans into. */
  archetypes: ArchetypeId[];
  /** Visual identity. */
  color: string;
  accent: string;
  /** Meta unlock required; undefined means available from the first run. */
  unlock?: string;
  /** Displayed unlock requirement text before it is earned. */
  unlockHint?: string;
}

export const BALL_CLASSES: BallClassDef[] = [
  {
    id: 'standard',
    name: 'Kernel',
    tagline: 'The honest one.',
    description:
      'Balanced weight, dependable rebound, no surprises. Everything in the game is tuned against this baseline.',
    cost: 'No specialisation to lean on.',
    base: {},
    archetypes: ['precision', 'ricochet'],
    color: '#e8f0ff',
    accent: '#7fb0ff',
  },
  {
    id: 'heavy',
    name: 'Anvil',
    tagline: 'Arrives once, arrives properly.',
    description:
      'Massive impacts and a huge health pool. You cannot change your mind mid-arc, so every launch is a commitment.',
    cost: 'Sluggish steering and a low speed cap.',
    base: {
      radius: 17,
      mass: 2.6,
      maxHealth: 150,
      damage: 16,
      gravity: 2500,
      airAccel: 1950,
      maxSpeed: 1150,
      knockback: 1.8,
      steerAuthorityAtSpeed: 0.42,
    },
    startingUpgrade: 'ground_slam',
    archetypes: ['demolition', 'bulwark'],
    color: '#c8b48a',
    accent: '#ffcf70',
    unlock: 'ball_heavy',
    unlockHint: 'Destroy 250 breakable objects.',
  },
  {
    id: 'light',
    name: 'Filament',
    tagline: 'Too fast to be careful with.',
    description:
      'Tiny, quick and extremely responsive. You can thread gaps nothing else can, and correct a mistake in mid-air.',
    cost: 'Very little integrity, and low damage per contact.',
    base: {
      radius: 8,
      mass: 0.5,
      maxHealth: 62,
      damage: 7,
      gravity: 1850,
      airAccel: 4000,
      maxSpeed: 1700,
      airBounceCharges: 1,
      steerAuthorityAtSpeed: 0.8,
      critChance: 0.1,
    },
    startingUpgrade: 'perfect_focus',
    archetypes: ['precision', 'trickster', 'glass'],
    color: '#a0ffe8',
    accent: '#ffffff',
    unlock: 'ball_light',
    unlockHint: 'Reach a combo of 30 in a single room.',
  },
  {
    id: 'volatile',
    name: 'Cinder',
    tagline: 'Combustion as a movement system.',
    description:
      'Every fourth impact detonates on its own, and blasts push you as well as them. You route with your own explosions.',
    cost: 'Your own blasts can hurt you.',
    base: { radius: 13, maxHealth: 88, damage: 11, explosionRadius: 70, explosionDamage: 14 },
    startingUpgrade: 'explosive_impact',
    archetypes: ['demolition'],
    color: '#ff9a5a',
    accent: '#ffe08a',
    unlock: 'ball_volatile',
    unlockHint: 'Kill 40 enemies with explosions in one run.',
  },
  {
    id: 'magnetic',
    name: 'Lodestar',
    tagline: 'The room comes to you.',
    description:
      'Pulls shards and light enemies toward you constantly, and sticks to conductive surfaces long enough to redirect.',
    cost: 'The pull works on hazards too, in a sense: you are always in the middle of things.',
    base: { radius: 13, maxHealth: 105, magnetRadius: 280, lightningDamage: 6, lightningJumps: 1, damage: 10 },
    startingUpgrade: 'magnetism',
    archetypes: ['lightning', 'control'],
    color: '#8ad8ff',
    accent: '#d8f4ff',
    unlock: 'ball_magnetic',
    unlockHint: 'Collect 3000 shards across all runs.',
  },
  {
    id: 'chrono',
    name: 'Cadence',
    tagline: 'Time is the only stat that matters.',
    description:
      'Time slows sharply as you approach any surface, and perfect bounces slow it further. Built to be played on the beat.',
    cost: 'Low damage and a narrow health pool; you win by executing, not by hitting hard.',
    base: {
      radius: 11,
      maxHealth: 80,
      damage: 8,
      timeSlowPower: 0.5,
      perfectWindow: 0.18,
      perfectPower: 1.6,
      comboDecayRate: 0.7,
    },
    startingUpgrade: 'time_dilation',
    archetypes: ['control', 'precision'],
    color: '#b8a0ff',
    accent: '#f0e8ff',
    unlock: 'ball_chrono',
    unlockHint: 'Land 200 perfect bounces.',
  },
  {
    id: 'phantom',
    name: 'Revenant',
    tagline: 'Solid only when it chooses to be.',
    description:
      'Phases briefly after every perfect bounce, passing through enemies and hazards. Position is negotiable.',
    cost: 'While phased you cannot bounce either, so falls are real.',
    base: { radius: 11, maxHealth: 78, damage: 10, phaseDuration: 0.35, perfectWindow: 0.15, iframeDuration: 0.7 },
    startingUpgrade: 'phase_bounce',
    archetypes: ['trickster', 'glass'],
    color: '#9a8aff',
    accent: '#e0d8ff',
    unlock: 'ball_phantom',
    unlockHint: 'Clear a room without touching the floor.',
  },
  {
    id: 'splitter',
    name: 'Chorus',
    tagline: 'Never arrives alone.',
    description:
      'Starts with companion balls that bounce independently and inherit a share of your damage. A crowd fighting a crowd.',
    cost: 'Your own contacts are weak; the swarm does the work.',
    base: { radius: 11, maxHealth: 92, damage: 6, extraBalls: 2, critChance: 0.1 },
    startingUpgrade: 'splitting_impact',
    archetypes: ['swarm', 'parasite'],
    color: '#ffb0d8',
    accent: '#fff0f8',
    unlock: 'ball_splitter',
    unlockHint: 'Defeat a boss with a Swarm build.',
  },
  {
    id: 'glass',
    name: 'Prism',
    tagline: 'One mistake, total.',
    description:
      'Devastating damage and a critical chance no other class approaches. Also the shortest health bar in the game.',
    cost: 'Two hits will usually end the run.',
    base: {
      radius: 10,
      maxHealth: 34,
      damage: 22,
      critChance: 0.25,
      critMult: 2.6,
      maxSpeed: 1550,
      iframeDuration: 0.85,
    },
    startingUpgrade: 'critical_impact',
    archetypes: ['glass', 'precision'],
    color: '#ffe0f0',
    accent: '#ff7ab0',
    unlock: 'ball_glass',
    unlockHint: 'Finish a run without ever being reduced below half integrity.',
  },
];

export const BALL_BY_ID: Record<string, BallClassDef> = Object.fromEntries(BALL_CLASSES.map((b) => [b.id, b]));

export function getBallClass(id: string): BallClassDef {
  return BALL_BY_ID[id] ?? BALL_CLASSES[0];
}

export function availableBalls(unlocked: (id: string) => boolean): BallClassDef[] {
  return BALL_CLASSES.filter((b) => !b.unlock || unlocked(b.unlock));
}
