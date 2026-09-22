/**
 * Achievements.
 *
 * These are the teaching layer. Each one names a thing the systems can do that a
 * player might not have noticed, and pays for trying it - which is why almost
 * none of them are "do X a lot" and almost all of them are "do X once, well".
 *
 * Several unlock ball classes. That connection is deliberate: the reward for
 * discovering a mechanic is a ball built around that mechanic.
 *
 * Progress is evaluated against a flat counter map maintained by the profile, so
 * adding an achievement usually means adding one counter increment at the site of
 * the event and one entry here.
 */

export type AchievementKind = 'run' | 'mastery' | 'discovery' | 'challenge';

export interface AchievementDef {
  id: string;
  name: string;
  /** What to do. Specific enough to attempt deliberately. */
  description: string;
  kind: AchievementKind;
  /** Counter key in the profile stats map. */
  counter: string;
  /** Threshold the counter must reach. */
  target: number;
  /** Content unlocked on completion. */
  grants?: string[];
  /** Echo reward. */
  echoes?: number;
  /** Hidden until unlocked, described only as a silhouette. */
  secret?: boolean;
  /** Vague hint shown for secret achievements. */
  hint?: string;
}

export const ACHIEVEMENT_DEFS: AchievementDef[] = [
  /* ------------------------------------------------------------- first steps -- */
  {
    id: 'first_blood',
    name: 'Contact',
    description: 'Destroy your first enemy by bouncing into it.',
    kind: 'run',
    counter: 'enemiesKilled',
    target: 1,
    echoes: 2,
  },
  {
    id: 'first_room',
    name: 'One Down',
    description: 'Clear a room.',
    kind: 'run',
    counter: 'roomsCleared',
    target: 1,
    echoes: 2,
  },
  {
    id: 'first_perfect',
    name: 'On Time',
    description: 'Land a perfect bounce.',
    kind: 'mastery',
    counter: 'perfectBounces',
    target: 1,
    echoes: 3,
  },
  {
    id: 'first_boss',
    name: 'Depth Cleared',
    description: 'Defeat any boss.',
    kind: 'run',
    counter: 'bossesDefeated',
    target: 1,
    grants: ['biome_citadel_hint'],
    echoes: 8,
  },

  /* ---------------------------------------------------------------- mastery -- */
  {
    id: 'perfect_200',
    name: 'Metronome',
    description: 'Land 200 perfect bounces across all runs.',
    kind: 'mastery',
    counter: 'perfectBounces',
    target: 200,
    grants: ['ball_chrono'],
    echoes: 14,
  },
  {
    id: 'combo_30',
    name: 'Unbroken',
    description: 'Reach a combo of 30 in a single room.',
    kind: 'mastery',
    counter: 'bestCombo',
    target: 30,
    grants: ['ball_light'],
    echoes: 12,
  },
  {
    id: 'combo_60',
    name: 'Resonant',
    description: 'Reach a combo of 60.',
    kind: 'mastery',
    counter: 'bestCombo',
    target: 60,
    grants: ['secret_resonance_hint'],
    echoes: 20,
  },
  {
    id: 'no_floor_room',
    name: 'Never Landed',
    description: 'Clear a room without touching the floor once.',
    kind: 'mastery',
    counter: 'airborneRoomClears',
    target: 1,
    grants: ['ball_phantom'],
    echoes: 15,
  },
  {
    id: 'wall_only_room',
    name: 'Off the Walls',
    description: 'Clear a room where every enemy died to an impact that came off a wall.',
    kind: 'mastery',
    counter: 'wallOnlyClears',
    target: 1,
    echoes: 16,
  },
  {
    id: 'environmental_elite',
    name: 'Let the Room Do It',
    description: 'Destroy an elite using only environmental damage.',
    kind: 'mastery',
    counter: 'environmentalElites',
    target: 1,
    echoes: 18,
  },
  {
    id: 'boss_no_floor',
    name: 'Above It All',
    description: 'Defeat a boss without touching the floor.',
    kind: 'challenge',
    counter: 'bossAirborneKills',
    target: 1,
    echoes: 30,
  },
  {
    id: 'flawless_boss',
    name: 'Untouched',
    description: 'Defeat a boss without taking any damage.',
    kind: 'challenge',
    counter: 'flawlessBosses',
    target: 1,
    grants: ['ball_glass'],
    echoes: 28,
  },
  {
    id: 'pacifist_room',
    name: 'Conscientious',
    description: 'Clear a room without ever hitting an enemy directly.',
    kind: 'mastery',
    counter: 'indirectClears',
    target: 1,
    echoes: 20,
  },

  /* -------------------------------------------------------------- destruction -- */
  {
    id: 'breaker_250',
    name: 'Demolition Licence',
    description: 'Destroy 250 breakable objects.',
    kind: 'run',
    counter: 'propsDestroyed',
    target: 250,
    grants: ['ball_heavy'],
    echoes: 12,
  },
  {
    id: 'explosive_40',
    name: 'Chain Reaction',
    description: 'Kill 40 enemies with explosions in a single run.',
    kind: 'run',
    counter: 'runExplosionKills',
    target: 40,
    grants: ['ball_volatile'],
    echoes: 14,
  },
  {
    id: 'shards_3000',
    name: 'Collector',
    description: 'Collect 3000 shards across all runs.',
    kind: 'run',
    counter: 'shardsCollected',
    target: 3000,
    grants: ['ball_magnetic'],
    echoes: 10,
  },
  {
    id: 'swarm_boss',
    name: 'Chorus',
    description: 'Defeat a boss with a Swarm build.',
    kind: 'run',
    counter: 'swarmBossKills',
    target: 1,
    grants: ['ball_splitter'],
    echoes: 16,
  },
  {
    id: 'half_health_run',
    name: 'Composed',
    description: 'Finish a run without ever dropping below half integrity.',
    kind: 'challenge',
    counter: 'compositeRuns',
    target: 1,
    echoes: 24,
  },

  /* -------------------------------------------------------------- buildcraft -- */
  {
    id: 'synergy_first',
    name: 'It Combines',
    description: 'Activate your first synergy.',
    kind: 'discovery',
    counter: 'synergiesFound',
    target: 1,
    echoes: 5,
  },
  {
    id: 'synergy_10',
    name: 'Architect of Builds',
    description: 'Discover 10 different synergies.',
    kind: 'discovery',
    counter: 'uniqueSynergies',
    target: 10,
    grants: ['synergy_hints'],
    echoes: 22,
  },
  {
    id: 'three_synergies',
    name: 'Overtuned',
    description: 'Have three synergies active at the same time.',
    kind: 'discovery',
    counter: 'tripleSynergyRuns',
    target: 1,
    echoes: 20,
  },
  {
    id: 'transformation_first',
    name: 'Rewritten',
    description: 'Acquire a transformation.',
    kind: 'discovery',
    counter: 'transformationsTaken',
    target: 1,
    echoes: 8,
  },
  {
    id: 'catalogue_40',
    name: 'Well Read',
    description: 'Discover 40 different upgrades.',
    kind: 'discovery',
    counter: 'uniqueUpgrades',
    target: 40,
    echoes: 18,
  },

  /* ------------------------------------------------------------------ depth -- */
  {
    id: 'reach_depth_3',
    name: 'Deeper',
    description: 'Reach the third depth.',
    kind: 'run',
    counter: 'deepestBiome',
    target: 3,
    echoes: 10,
  },
  {
    id: 'win_run',
    name: 'Unbound',
    description: 'Complete a full run.',
    kind: 'run',
    counter: 'runsWon',
    target: 1,
    grants: ['bound_levels'],
    echoes: 40,
  },
  {
    id: 'bound_5',
    name: 'Tightening',
    description: 'Complete a run at Bound 5 or higher.',
    kind: 'challenge',
    counter: 'bestBoundWin',
    target: 5,
    echoes: 45,
  },
  {
    id: 'bound_10',
    name: 'Fully Bound',
    description: 'Complete a run at Bound 10.',
    kind: 'challenge',
    counter: 'bestBoundWin',
    target: 10,
    grants: ['secret_origin_hint'],
    echoes: 80,
  },

  /* ----------------------------------------------------------------- secret -- */
  {
    id: 'secret_hollow',
    name: '???',
    description: 'Find a Hollow.',
    kind: 'discovery',
    counter: 'secretRoomsFound',
    target: 1,
    secret: true,
    hint: 'Some rooms are not drawn on the route.',
    echoes: 25,
  },
  {
    id: 'secret_origin',
    name: '???',
    description: 'Reach the first bounce.',
    kind: 'discovery',
    counter: 'originFound',
    target: 1,
    secret: true,
    hint: 'It is beneath the last depth, and it does not want visitors.',
    echoes: 100,
  },
];

export const ACHIEVEMENT_BY_ID: Record<string, AchievementDef> = Object.fromEntries(
  ACHIEVEMENT_DEFS.map((a) => [a.id, a]),
);

/** Counter keys that reset at the start of each run rather than accumulating. */
export const PER_RUN_COUNTERS = new Set([
  'runExplosionKills',
  'tripleSynergyRuns',
  'airborneRoomClears',
  'wallOnlyClears',
  'indirectClears',
  'environmentalElites',
  'bossAirborneKills',
  'flawlessBosses',
  'compositeRuns',
  'swarmBossKills',
]);
