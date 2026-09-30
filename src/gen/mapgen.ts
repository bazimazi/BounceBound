/**
 * Branching route generation.
 *
 * A run is a sequence of biome acts. Each act is a small directed graph the
 * player routes through, ending at that biome's boss. The graph is built by
 * tracing several paths from the entrance to the boss, which guarantees every
 * node is on at least one complete route - there are no dead ends and no
 * unreachable rewards.
 *
 * Route planning is only interesting if the choices differ *in kind*. The
 * archetype assignment therefore enforces contrast between siblings: where two
 * nodes are reachable from the same place, the generator actively avoids giving
 * them the same archetype, so a fork is always "safety or power" rather than
 * "combat or combat".
 *
 * Some nodes are deliberately hidden until adjacent. Unknown nodes are drawn from
 * a restricted pool that can never be a boss and never be strictly bad, so
 * gambling on a `?` is a real but fair decision.
 *
 * Acts are grouped into *tiers*. A tier with one biome is a straight descent; a
 * tier with two is a fork, and clearing the previous boss offers the entrances
 * of both. Unlocking a new biome therefore adds a route choice rather than making
 * every run longer - the run stays three or four acts, and new content widens it.
 */

import { Rng } from '../core/rng';
import { clamp } from '../core/math';
import type { BiomeId, RoomArchetype } from '../content/ids';

export interface MapNode {
  id: number;
  /** Depth within the act, 0 = entrance. */
  layer: number;
  /** Horizontal slot, used for layout. */
  column: number;
  archetype: RoomArchetype;
  biome: BiomeId;
  /** Global room index across the whole run, for scaling. */
  depth: number;
  /** Outgoing edges (node ids). */
  next: number[];
  /** Incoming edges. */
  prev: number[];
  /** Hidden until the player is adjacent. */
  hidden: boolean;
  visited: boolean;
  /** Seed for the room itself, fixed at map generation time. */
  roomSeed: string;
}

export interface ActMap {
  biome: BiomeId;
  /** Position in the descent. Acts sharing a tier are alternatives. */
  tier: number;
  nodes: MapNode[];
  entranceIds: number[];
  bossId: number;
  layers: number;
}

export interface RunMap {
  seed: string;
  acts: ActMap[];
  /** Flat lookup across all acts. */
  nodesById: Map<number, MapNode>;
  /** Every node on the map, including alternative acts the player will skip. */
  totalRooms: number;
  /** Rooms on any single route from the first entrance to the final boss. */
  pathLength: number;
  /** Number of tiers: how many bosses stand between the player and the end. */
  tiers: number;
}

const LAYERS_PER_ACT = 8;
const PATHS_PER_ACT = 4;

/**
 * Archetype pools by role.
 *
 * `filler` is what most nodes become; the others are quota-driven so that every
 * act reliably contains an economy option, a recovery option and a power spike
 * without those being guaranteed on any single route.
 */
const FILLER: RoomArchetype[] = ['combat', 'combat', 'trap', 'traversal', 'puzzle', 'challenge'];
const POWER: RoomArchetype[] = ['elite', 'treasure', 'gamble', 'miniboss'];
const SUPPORT: RoomArchetype[] = ['shop', 'respite', 'event'];
/**
 * Hidden nodes are drawn from a restricted pool: never a boss, never strictly
 * bad, and never a support room, so revealing a `?` cannot break the support
 * spacing rule that the rest of the act is built around.
 */
const HIDDEN_POOL: RoomArchetype[] = ['treasure', 'secret', 'combat', 'gamble', 'challenge', 'trap'];

/**
 * Meta unlocks that change the *shape* of a map. They are passed as a flat list
 * rather than read from the profile so a run can store exactly the set it was
 * generated with: buying an unlock between sessions must not reshape a map the
 * player is halfway through.
 */
export const MAP_GATES = ['room_miniboss', 'room_secret', 'more_events', 'map_clarity'] as const;

export interface GenerateMapOptions {
  seed: string;
  /** Biomes in order, one act each; the run ends after the last one's boss. */
  biomes?: BiomeId[];
  /**
   * The descent as tiers of alternatives. Takes precedence over `biomes`; a tier
   * holding two biomes is a fork the player chooses between.
   */
  tiers?: BiomeId[][];
  boundLevel: number;
  /** Extra hidden nodes unlocked by meta progression. */
  extraHiddenChance?: number;
  /** Meta modifier: guarantees a shop in the first act. */
  guaranteeEarlyShop?: boolean;
  /** Map-shaping unlocks held. Omitted means all of them. */
  gates?: readonly string[];
}

export function generateMap(options: GenerateMapOptions): RunMap {
  const rng = new Rng(`${options.seed}:map`);
  const tiers = options.tiers ?? (options.biomes ?? ['verdant']).map((b) => [b]);
  const gates = new Set<string>(options.gates ?? MAP_GATES);
  const acts: ActMap[] = [];
  let nextId = 1;
  let depth = 0;

  for (let tier = 0; tier < tiers.length; tier++) {
    let layers = LAYERS_PER_ACT;
    for (const biome of tiers[tier]) {
      const act = buildAct({
        rng,
        biome,
        actIndex: tier,
        startId: nextId,
        startDepth: depth,
        seed: options.seed,
        boundLevel: options.boundLevel,
        extraHiddenChance: options.extraHiddenChance ?? 0,
        guaranteeShop: (options.guaranteeEarlyShop ?? false) && tier === 0,
        gates,
      });
      nextId += act.nodes.length;
      layers = act.layers;
      acts.push(act);
    }
    // Alternatives share a depth range: whichever the player picks, the room
    // after its boss is the same distance into the run.
    depth += layers;
  }

  const nodesById = new Map<number, MapNode>();
  let totalRooms = 0;
  for (const act of acts) {
    for (const node of act.nodes) {
      nodesById.set(node.id, node);
      totalRooms++;
    }
  }
  return { seed: options.seed, acts, nodesById, totalRooms, pathLength: depth, tiers: tiers.length };
}

interface BuildActOptions {
  rng: Rng;
  biome: BiomeId;
  actIndex: number;
  startId: number;
  startDepth: number;
  seed: string;
  boundLevel: number;
  extraHiddenChance: number;
  guaranteeShop: boolean;
  gates: Set<string>;
}

function buildAct(options: BuildActOptions): ActMap {
  const { rng, biome } = options;
  const layers = LAYERS_PER_ACT;
  const grid: MapNode[][] = [];
  let id = options.startId;

  // Layer 0 has one or two entrances; the boss layer always has exactly one.
  const widths: number[] = [];
  widths.push(options.actIndex === 0 ? 1 : rng.int(1, 2));
  for (let layer = 1; layer < layers - 1; layer++) {
    widths.push(rng.int(2, layer === 1 ? 3 : 4));
  }
  widths.push(1);

  for (let layer = 0; layer < layers; layer++) {
    const row: MapNode[] = [];
    const width = widths[layer];
    for (let i = 0; i < width; i++) {
      row.push({
        id: id++,
        layer,
        column: width === 1 ? 1.5 : (i / (width - 1)) * 3,
        archetype: 'combat',
        biome,
        depth: options.startDepth + layer,
        next: [],
        prev: [],
        hidden: false,
        visited: false,
        roomSeed: '',
      });
    }
    grid.push(row);
  }

  // Trace paths from entrance to boss. Each path steps to a neighbouring column
  // in the next layer, which keeps the graph planar and readable.
  for (let p = 0; p < PATHS_PER_ACT; p++) {
    let current = grid[0][rng.int(0, grid[0].length - 1)];
    for (let layer = 1; layer < layers; layer++) {
      const row = grid[layer];
      // Prefer columns close to the current one so edges do not criss-cross.
      const target = rng.weighted(row, (node) => 1 / (1 + Math.abs(node.column - current.column) * 1.7)) ?? row[0];
      if (!current.next.includes(target.id)) current.next.push(target.id);
      if (!target.prev.includes(current.id)) target.prev.push(current.id);
      current = target;
    }
  }

  // Guarantee connectivity: any node with no outgoing edge (except the boss) gets
  // one, and any node with no incoming edge (except entrances) gets one.
  for (let layer = 0; layer < layers - 1; layer++) {
    for (const node of grid[layer]) {
      if (node.next.length === 0) {
        const row = grid[layer + 1];
        const target = rng.weighted(row, (n) => 1 / (1 + Math.abs(n.column - node.column))) ?? row[0];
        node.next.push(target.id);
        target.prev.push(node.id);
      }
    }
  }
  for (let layer = 1; layer < layers; layer++) {
    for (const node of grid[layer]) {
      if (node.prev.length === 0) {
        const row = grid[layer - 1];
        const source = rng.weighted(row, (n) => 1 / (1 + Math.abs(n.column - node.column))) ?? row[0];
        source.next.push(node.id);
        node.prev.push(source.id);
      }
    }
  }

  // Drop nodes that ended up with no incoming path at all (possible only in the
  // widest middle layers), so the map never shows an unreachable option.
  const nodes: MapNode[] = [];
  for (let layer = 0; layer < layers; layer++) {
    for (const node of grid[layer]) {
      if (layer > 0 && node.prev.length === 0) continue;
      nodes.push(node);
    }
  }

  assignArchetypes(nodes, grid, rng, options);

  for (const node of nodes) {
    node.roomSeed = `${options.seed}:${biome}:${node.id}`;
  }

  return {
    biome,
    tier: options.actIndex,
    nodes,
    entranceIds: grid[0].map((n) => n.id),
    bossId: grid[layers - 1][0].id,
    layers,
  };
}

function assignArchetypes(nodes: MapNode[], grid: MapNode[][], rng: Rng, options: BuildActOptions): void {
  const layers = grid.length;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Fixed roles first.
  grid[layers - 1][0].archetype = 'boss';
  for (const entrance of grid[0]) entrance.archetype = 'combat';

  /**
   * `locked` holds every node whose archetype is a guarantee the rest of this
   * function must not break. An earlier version applied the support-adjacency and
   * hidden-node rules as post-passes, which could silently overwrite the
   * guaranteed pre-boss recovery room or the act's only shop. Constraints are now
   * enforced during placement instead.
   */
  const locked = new Set<number>([grid[layers - 1][0].id, ...grid[0].map((n) => n.id)]);
  const assigned = new Set<number>(locked);

  // The layer immediately before the boss always offers recovery on at least one
  // route, so a boss is never a coin flip on arriving at 6 integrity.
  const rest = rng.pick(grid[layers - 2]);
  rest.archetype = rng.chance(0.6) ? 'respite' : 'shop';
  locked.add(rest.id);
  assigned.add(rest.id);

  const quotas: Array<{ archetype: RoomArchetype; count: number; minLayer: number; maxLayer: number }> = [
    { archetype: 'shop', count: options.guaranteeShop ? 2 : 1, minLayer: 2, maxLayer: layers - 2 },
    { archetype: 'respite', count: 1, minLayer: 2, maxLayer: layers - 2 },
    { archetype: 'elite', count: options.actIndex === 0 ? 1 : 2, minLayer: 3, maxLayer: layers - 2 },
    { archetype: 'treasure', count: 1, minLayer: 1, maxLayer: layers - 2 },
    { archetype: 'event', count: options.gates.has('more_events') ? 2 : 1, minLayer: 1, maxLayer: layers - 2 },
  ];

  for (const quota of quotas) {
    const isSupport = SUPPORT.includes(quota.archetype);
    for (let i = 0; i < quota.count; i++) {
      let candidates = nodes.filter(
        (n) => !assigned.has(n.id) && n.layer >= quota.minLayer && n.layer <= quota.maxLayer,
      );
      // Two support rooms back to back on one route wastes one of them, so
      // support placement avoids neighbours of existing support rooms. If that
      // leaves nothing, the quota wins: having a shop matters more than spacing.
      if (isSupport) {
        const spaced = candidates.filter((n) => !adjacentToSupport(n, byId));
        if (spaced.length > 0) candidates = spaced;
      }
      if (candidates.length === 0) break;
      const chosen =
        rng.weighted(candidates, (n) => (siblingHas(n, quota.archetype, byId) ? 0.25 : 1)) ?? rng.pick(candidates);
      chosen.archetype = quota.archetype;
      assigned.add(chosen.id);
      if (isSupport) locked.add(chosen.id);
    }
  }

  // Fill the rest, biasing toward contrast with siblings. Wardens and Hollows only
  // exist once they have been unlocked.
  const power = options.gates.has('room_miniboss') ? POWER : POWER.filter((a) => a !== 'miniboss');
  const hiddenPool = options.gates.has('room_secret') ? HIDDEN_POOL : HIDDEN_POOL.filter((a) => a !== 'secret');
  const fillers: MapNode[] = [];
  for (const node of nodes) {
    if (assigned.has(node.id)) continue;
    const pool = node.layer >= 4 && rng.chance(0.24) ? power : FILLER;
    const chosen = rng.weighted(pool, (a) => (siblingHas(node, a, byId) ? 0.3 : 1)) ?? rng.pick(pool);
    node.archetype = chosen;
    assigned.add(node.id);
    fillers.push(node);
  }

  // Hide a few filler nodes to preserve a sense of the unknown. Only fillers, so
  // hiding can never consume a guaranteed room.
  // Cartography thins the fog; an obscuring Bound level thickens it past the cap.
  const hideCandidates = fillers.filter((n) => n.layer >= 2 && n.layer <= layers - 3);
  const hideShare = (options.gates.has('map_clarity') ? 0.1 : 0.22) + options.extraHiddenChance;
  const hideCap = options.extraHiddenChance > 0 ? 6 : 3;
  const hidden = rng.sample(hideCandidates, clamp(Math.round(hideCandidates.length * hideShare), 0, hideCap));
  for (const node of hidden) {
    node.hidden = true;
    node.archetype = rng.pick(hiddenPool);
  }
  // Once Hollow Places is unlocked, most acts hide one, so a `?` is worth a look.
  if (options.gates.has('room_secret') && hidden.length > 0 && !hidden.some((n) => n.archetype === 'secret')) {
    if (rng.chance(0.55)) rng.pick(hidden).archetype = 'secret';
  }
}

/** True when any parent or child of this node is already a support room. */
function adjacentToSupport(node: MapNode, byId: Map<number, MapNode>): boolean {
  for (const id of node.prev) {
    if (SUPPORT.includes(byId.get(id)?.archetype ?? 'combat')) return true;
  }
  for (const id of node.next) {
    if (SUPPORT.includes(byId.get(id)?.archetype ?? 'combat')) return true;
  }
  return false;
}

function siblingHas(node: MapNode, archetype: RoomArchetype, byId: Map<number, MapNode>): boolean {
  for (const parentId of node.prev) {
    const parent = byId.get(parentId);
    if (!parent) continue;
    for (const siblingId of parent.next) {
      if (siblingId === node.id) continue;
      if (byId.get(siblingId)?.archetype === archetype) return true;
    }
  }
  return false;
}

/* --------------------------------------------------------------- queries -- */

export function nodeById(map: RunMap, id: number): MapNode | undefined {
  return map.nodesById.get(id);
}

export function actOf(map: RunMap, node: MapNode): ActMap {
  return map.acts.find((a) => a.nodes.some((n) => n.id === node.id)) ?? map.acts[0];
}

/** Choices available from a node; empty means the act (or run) is complete. */
export function choicesFrom(map: RunMap, node: MapNode): MapNode[] {
  const out: MapNode[] = [];
  for (const id of node.next) {
    const next = map.nodesById.get(id);
    if (next) out.push(next);
  }
  if (out.length > 0) return out.sort((a, b) => a.column - b.column);

  // Boss cleared: advance to the entrances of every act in the next tier. At a
  // fork that is two biomes' entrances, kept grouped by act so the choice reads
  // as "which depth" first and "which door" second.
  const tier = actOf(map, node).tier;
  for (const act of map.acts) {
    if (act.tier !== tier + 1) continue;
    const entrances: MapNode[] = [];
    for (const id of act.entranceIds) {
      const entrance = map.nodesById.get(id);
      if (entrance) entrances.push(entrance);
    }
    out.push(...entrances.sort((a, b) => a.column - b.column));
  }
  return out;
}

/** Every node reachable forward from `node` within its act, including itself. */
export function reachableFrom(map: RunMap, node: MapNode): Set<number> {
  const out = new Set<number>();
  const queue = [node.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const next of map.nodesById.get(id)?.next ?? []) queue.push(next);
  }
  return out;
}

export interface RouteOutlook {
  /** Known room types still reachable from here in this act, by count. */
  counts: Partial<Record<RoomArchetype, number>>;
  /** Reachable rooms that are still hidden. */
  unknown: number;
  /** Rooms left before the boss, counting this one. */
  roomsToBoss: number;
}

/**
 * What a route commits the player to. Everything reachable from `node` inside its
 * act is counted, so a fork reads as "this side still has an Exchange and a
 * Wellspring" rather than only as the room immediately ahead.
 */
export function routeOutlook(map: RunMap, node: MapNode): RouteOutlook {
  const counts: Partial<Record<RoomArchetype, number>> = {};
  let unknown = 0;
  for (const id of reachableFrom(map, node)) {
    const other = map.nodesById.get(id);
    if (!other || other.archetype === 'boss') continue;
    if (other.hidden) unknown++;
    else counts[other.archetype] = (counts[other.archetype] ?? 0) + 1;
  }
  const act = actOf(map, node);
  const bossLayer = map.nodesById.get(act.bossId)?.layer ?? node.layer;
  return { counts, unknown, roomsToBoss: Math.max(1, bossLayer - node.layer) };
}

/**
 * What the player is shown about a node. Hidden nodes reveal themselves once the
 * player is standing next to them, which rewards route planning without removing
 * surprise.
 */
export function describeNode(node: MapNode, adjacent: boolean): { label: string; known: boolean } {
  if (node.hidden && !adjacent) return { label: 'Unknown', known: false };
  return { label: ARCHETYPE_LABELS[node.archetype] ?? node.archetype, known: true };
}

export const ARCHETYPE_LABELS: Record<RoomArchetype, string> = {
  combat: 'Skirmish',
  elite: 'Elite',
  trap: 'Hazard',
  traversal: 'Ascent',
  treasure: 'Cache',
  challenge: 'Trial',
  puzzle: 'Mechanism',
  shop: 'Exchange',
  respite: 'Wellspring',
  event: 'Encounter',
  gamble: 'Wager',
  miniboss: 'Warden',
  boss: 'Boss',
  secret: 'Hollow',
};

/** Route labels are kept to a few words: a map should be scanned, not read. */
export const ARCHETYPE_HINTS: Record<RoomArchetype, string> = {
  combat: 'Fight. Upgrade.',
  elite: 'One bad enemy. Two upgrades.',
  trap: 'Hostile geometry. Upgrade and shards.',
  traversal: 'A climb. Upgrade and a breather.',
  treasure: 'A cache, awkwardly placed.',
  challenge: 'A constraint. Rarer upgrade.',
  puzzle: 'Geometry. Upgrade and a reroll.',
  shop: 'Three pedestals. Hit to buy.',
  respite: 'Recover integrity.',
  event: 'An altar. Always a trade.',
  gamble: 'Two options. One lies.',
  miniboss: 'A Warden. Relic drop.',
  boss: 'End of the depth.',
  secret: 'Should not be here.',
};
