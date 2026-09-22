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
  totalRooms: number;
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

export interface GenerateMapOptions {
  seed: string;
  /** Biomes in order; the run ends after the last one's boss. */
  biomes: BiomeId[];
  boundLevel: number;
  /** Extra hidden nodes unlocked by meta progression. */
  extraHiddenChance?: number;
  /** Meta modifier: guarantees a shop in the first act. */
  guaranteeEarlyShop?: boolean;
}

export function generateMap(options: GenerateMapOptions): RunMap {
  const rng = new Rng(`${options.seed}:map`);
  const acts: ActMap[] = [];
  let nextId = 1;
  let depth = 0;

  for (let actIndex = 0; actIndex < options.biomes.length; actIndex++) {
    const biome = options.biomes[actIndex];
    const act = buildAct({
      rng,
      biome,
      actIndex,
      startId: nextId,
      startDepth: depth,
      seed: options.seed,
      boundLevel: options.boundLevel,
      extraHiddenChance: options.extraHiddenChance ?? 0,
      guaranteeShop: (options.guaranteeEarlyShop ?? false) && actIndex === 0,
    });
    nextId += act.nodes.length;
    depth += act.layers;
    acts.push(act);
  }

  const nodesById = new Map<number, MapNode>();
  let totalRooms = 0;
  for (const act of acts) {
    for (const node of act.nodes) {
      nodesById.set(node.id, node);
      totalRooms++;
    }
  }
  return { seed: options.seed, acts, nodesById, totalRooms };
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
    { archetype: 'event', count: 1, minLayer: 1, maxLayer: layers - 2 },
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

  // Fill the rest, biasing toward contrast with siblings.
  const fillers: MapNode[] = [];
  for (const node of nodes) {
    if (assigned.has(node.id)) continue;
    const pool = node.layer >= 4 && rng.chance(0.24) ? POWER : FILLER;
    const chosen = rng.weighted(pool, (a) => (siblingHas(node, a, byId) ? 0.3 : 1)) ?? rng.pick(pool);
    node.archetype = chosen;
    assigned.add(node.id);
    fillers.push(node);
  }

  // Hide a few filler nodes to preserve a sense of the unknown. Only fillers, so
  // hiding can never consume a guaranteed room.
  const hideCandidates = fillers.filter((n) => n.layer >= 2 && n.layer <= layers - 3);
  const hideCount = clamp(Math.round(hideCandidates.length * (0.22 + options.extraHiddenChance)), 0, 3);
  for (const node of rng.sample(hideCandidates, hideCount)) {
    if (locked.has(node.id)) continue;
    node.hidden = true;
    node.archetype = rng.pick(HIDDEN_POOL);
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
  // Boss cleared: advance to the next act's entrances.
  if (out.length === 0) {
    const actIndex = map.acts.findIndex((a) => a.nodes.some((n) => n.id === node.id));
    const nextAct = map.acts[actIndex + 1];
    if (nextAct) {
      for (const id of nextAct.entranceIds) {
        const entrance = map.nodesById.get(id);
        if (entrance) out.push(entrance);
      }
    }
  }
  return out.sort((a, b) => a.column - b.column);
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

export const ARCHETYPE_HINTS: Record<RoomArchetype, string> = {
  combat: 'A fight. Shards and an upgrade for clearing it.',
  elite: 'One dangerous enemy. Two upgrade choices if you win.',
  trap: 'Few enemies, hostile geometry. Good shards, high chance of chip damage.',
  traversal: 'A climb. Rewards control rather than damage.',
  treasure: 'A cache, usually placed somewhere awkward.',
  challenge: 'A specific constraint. Meeting it pays well.',
  puzzle: 'Geometry problem. No pressure, no healing either.',
  shop: 'Three pedestals. Hit one to buy it.',
  respite: 'Recover integrity. Nothing else here.',
  event: 'An altar. Always a trade, never a gift.',
  gamble: 'Two options, one of them lying.',
  miniboss: 'A Warden. Relic for the kill.',
  boss: 'The end of this depth. Learn it, do not out-stat it.',
  secret: 'Should not be on the map at all.',
};
