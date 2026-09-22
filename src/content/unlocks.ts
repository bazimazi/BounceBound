/**
 * The unlock tree.
 *
 * Spent in Echoes, earned from every run whether or not it ended well. The design
 * constraint from the brief is the important thing here: permanent progression
 * must *expand possibilities*, not flatten difficulty. So the tree is roughly
 * 70% "new things exist now" and 30% "small permanent edge", and the power nodes
 * are capped low enough that a fresh profile is never locked out of a win.
 *
 * For reference on the ceiling: every power node in this tree combined is worth
 * less than two good in-run upgrades. That is intentional. Skill and buildcraft
 * have to stay dominant or the whole loop rots into grinding.
 *
 * Content nodes gate things by id, which enemies, biomes, events and upgrades
 * already check. Adding a gated thing requires no changes here beyond one node.
 */

import type { StatModifiers } from '../sim/stats';

export type UnlockBranch = 'core' | 'abilities' | 'world' | 'adversaries' | 'trials' | 'secrets';

export interface UnlockNode {
  id: string;
  name: string;
  /** Written as a promise of new play, not as a stat line. */
  description: string;
  branch: UnlockBranch;
  cost: number;
  /** Prerequisite node ids. */
  requires: string[];
  /** Permanent stat bonuses applied at the start of every run. */
  modifiers?: StatModifiers;
  /** Content gate ids this node opens. */
  grants?: string[];
  /** Hidden until its prerequisites are met, to preserve the discovery curve. */
  secret?: boolean;
  /** Repeatable nodes (small bonuses) with a rank cap. */
  ranks?: number;
  /** Cost multiplier per rank beyond the first. */
  rankCostScale?: number;
}

export const UNLOCK_NODES: UnlockNode[] = [
  /* ------------------------------------------------------------------ core -- */
  {
    id: 'core_reserves',
    name: 'Reserves',
    description: 'Start every run with a small stock of shards, so the first Exchange is never wasted.',
    branch: 'core',
    cost: 8,
    requires: [],
    grants: ['start_shards'],
    ranks: 3,
    rankCostScale: 1.6,
  },
  {
    id: 'core_integrity',
    name: 'Tempering',
    description: 'A little more integrity to work with from the first room.',
    branch: 'core',
    cost: 10,
    requires: [],
    modifiers: { maxHealth: 8 },
    ranks: 3,
    rankCostScale: 1.7,
  },
  {
    id: 'core_reroll',
    name: 'Second Thoughts',
    description: 'An extra reroll on upgrade offers, every run.',
    branch: 'core',
    cost: 14,
    requires: [],
    modifiers: { rerolls: 1 },
    ranks: 2,
    rankCostScale: 2,
  },
  {
    id: 'core_choices',
    name: 'Broader Offers',
    description: 'Upgrade offers show a fourth option. More of the catalogue reaches you.',
    branch: 'core',
    cost: 34,
    requires: ['core_reroll'],
    modifiers: { upgradeChoices: 1 },
  },
  {
    id: 'core_fortune',
    name: 'Fortune',
    description: 'Rare and legendary upgrades surface noticeably more often.',
    branch: 'core',
    cost: 26,
    requires: ['core_reserves'],
    modifiers: { luck: 0.5 },
    ranks: 2,
    rankCostScale: 1.9,
  },

  /* ------------------------------------------------------------- abilities -- */
  {
    id: 'ability_transformations',
    name: 'Deep Catalogue',
    description: 'Transformations begin appearing: run-defining effects that rewrite a rule instead of a number.',
    branch: 'abilities',
    cost: 18,
    requires: [],
    grants: ['family_transformation'],
  },
  {
    id: 'ability_curses',
    name: 'Willing Bargains',
    description: 'Cursed upgrades become available. Large power, stated cost, your decision.',
    branch: 'abilities',
    cost: 16,
    requires: [],
    grants: ['family_cursed'],
  },
  {
    id: 'ability_evolutions',
    name: 'Refinement',
    description: 'Upgrades can evolve into later tiers that change their mechanic rather than scaling it.',
    branch: 'abilities',
    cost: 22,
    requires: ['ability_transformations'],
    grants: ['family_evolution'],
  },
  {
    id: 'ability_exotic',
    name: 'Exotic Physics',
    description: 'Phasing, folding and gravity inversion enter the pool.',
    branch: 'abilities',
    cost: 30,
    requires: ['ability_evolutions'],
    grants: ['family_exotic', 'upgrade_gravity_flip', 'upgrade_short_teleport'],
  },
  {
    id: 'ability_synergy_sense',
    name: 'Synergy Sense',
    description: 'Offers mark upgrades that would complete a synergy you are one piece away from.',
    branch: 'abilities',
    cost: 24,
    requires: ['ability_transformations'],
    grants: ['synergy_hints'],
  },

  /* ----------------------------------------------------------------- world -- */
  {
    id: 'world_citadel',
    name: 'Storm Citadel',
    description: 'Opens a fourth depth: conductive architecture where arcs reach much further.',
    branch: 'world',
    cost: 28,
    requires: [],
    grants: ['biome_citadel'],
  },
  {
    id: 'world_rift',
    name: 'Gravity Rift',
    description: 'Opens a fifth depth where gravity is weaker and, in places, sideways.',
    branch: 'world',
    cost: 40,
    requires: ['world_citadel'],
    grants: ['biome_rift'],
  },
  {
    id: 'world_void',
    name: 'The Unbound',
    description: 'Opens the final depth, where surfaces are provisional and the run ends properly.',
    branch: 'world',
    cost: 60,
    requires: ['world_rift'],
    grants: ['biome_void'],
  },
  {
    id: 'world_events',
    name: 'Stranger Encounters',
    description: 'More altars and stranger trades appear on your routes.',
    branch: 'world',
    cost: 15,
    requires: [],
    grants: ['event_portals', 'more_events'],
  },
  {
    id: 'world_secrets',
    name: 'Hollow Places',
    description: 'Hidden rooms start appearing on the map, holding things that are not sold anywhere.',
    branch: 'world',
    cost: 32,
    requires: ['world_events'],
    grants: ['room_secret'],
  },
  {
    id: 'world_foresight',
    name: 'Cartography',
    description: 'Unknown nodes on the route are less frequent, and their neighbours are always legible.',
    branch: 'world',
    cost: 20,
    requires: ['world_events'],
    grants: ['map_clarity'],
  },

  /* ----------------------------------------------------------- adversaries -- */
  {
    id: 'adversary_elites',
    name: 'Primes',
    description: 'Elite variants begin appearing: the same fights, asking much harder questions.',
    branch: 'adversaries',
    cost: 14,
    requires: [],
    grants: ['elite_primes'],
  },
  {
    id: 'adversary_specialists',
    name: 'Specialists',
    description: 'Blinkers, Mirrorlings and Thornweavers join the roster.',
    branch: 'adversaries',
    cost: 20,
    requires: [],
    grants: ['enemy_specialists'],
  },
  {
    id: 'adversary_wardens',
    name: 'Wardens',
    description: 'Mini-boss rooms appear mid-depth, holding relics.',
    branch: 'adversaries',
    cost: 26,
    requires: ['adversary_elites'],
    grants: ['room_miniboss'],
  },
  {
    id: 'adversary_alt_bosses',
    name: 'Other Occupants',
    description: 'Each depth can be held by a different boss than the one you know.',
    branch: 'adversaries',
    cost: 44,
    requires: ['adversary_wardens'],
    grants: ['boss_variants'],
  },

  /* ---------------------------------------------------------------- trials -- */
  {
    id: 'trial_bound',
    name: 'Bound Levels',
    description: 'Voluntary difficulty. Each level adds one named modifier and pays more of everything.',
    branch: 'trials',
    cost: 12,
    requires: [],
    grants: ['bound_levels'],
  },
  {
    id: 'trial_daily',
    name: 'Daily Seed',
    description: 'A fixed seed each day, identical for everyone, with its own record.',
    branch: 'trials',
    cost: 18,
    requires: ['trial_bound'],
    grants: ['mode_daily'],
  },
  {
    id: 'trial_bossrush',
    name: 'Boss Rush',
    description: 'Every boss you have beaten, back to back, with upgrades between them.',
    branch: 'trials',
    cost: 34,
    requires: ['trial_daily'],
    grants: ['mode_bossrush'],
  },
  {
    id: 'trial_endless',
    name: 'Endless Descent',
    description: 'Depth without an end. Escalates until it wins.',
    branch: 'trials',
    cost: 42,
    requires: ['trial_bossrush'],
    grants: ['mode_endless'],
  },

  /* --------------------------------------------------------------- secrets -- */
  {
    id: 'secret_resonance',
    name: 'Resonance',
    description: 'Something responds to very long combos. It has not explained itself yet.',
    branch: 'secrets',
    cost: 50,
    requires: ['ability_exotic'],
    grants: ['secret_resonance'],
    secret: true,
  },
  {
    id: 'secret_origin',
    name: 'The First Bounce',
    description: 'A room that should not be on any route, reachable only one way.',
    branch: 'secrets',
    cost: 70,
    requires: ['world_void', 'secret_resonance'],
    grants: ['secret_origin'],
    secret: true,
  },
];

export const UNLOCK_BY_ID: Record<string, UnlockNode> = Object.fromEntries(UNLOCK_NODES.map((n) => [n.id, n]));

export const BRANCH_NAMES: Record<UnlockBranch, string> = {
  core: 'Core',
  abilities: 'Abilities',
  world: 'World',
  adversaries: 'Adversaries',
  trials: 'Trials',
  secrets: 'Secrets',
};

/** Cost of the next rank of a node, given how many are already purchased. */
export function nodeCost(node: UnlockNode, ranksOwned: number): number {
  if (ranksOwned <= 0) return node.cost;
  const scale = node.rankCostScale ?? 1.5;
  return Math.round(node.cost * scale ** ranksOwned);
}

export function maxRanks(node: UnlockNode): number {
  return node.ranks ?? 1;
}

/** Visible nodes: a secret node stays hidden until its prerequisites are met. */
export function visibleNodes(owned: (id: string) => boolean): UnlockNode[] {
  return UNLOCK_NODES.filter((node) => !node.secret || node.requires.every((req) => owned(req)));
}
