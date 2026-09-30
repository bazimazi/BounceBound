import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../src/core/storage';
import { Rng } from '../src/core/rng';
import { Profile } from '../src/meta/profile';
import { Run } from '../src/run/run';
import { sanitiseSnapshot } from '../src/run/runSave';
import { actOf, choicesFrom, generateMap, routeOutlook, type RunMap } from '../src/gen/mapgen';
import { planDescent } from '../src/content/biomes';
import { bossForBiome } from '../src/content/bosses';
import { eligibleElites, eligibleEnemies } from '../src/content/enemies';
import { UNLOCK_NODES } from '../src/content/unlocks';
import { upgradeCatalogue } from '../src/content/upgrades/index';
import { getUpgrade, rollOffers, type BuildQuery } from '../src/game/upgradeSystem';
import { BuildState } from '../src/game/build';
import { EventBus } from '../src/core/events';
import type { GameEvents } from '../src/sim/gameEvents';
import type { BiomeId } from '../src/content/ids';

function profileWith(...gates: string[]): Profile {
  const profile = new Profile(new MemoryStorage());
  for (const gate of gates) profile.grant(gate);
  return profile;
}

function emptyBuild(): BuildQuery {
  const build = new BuildState({
    bus: new EventBus<GameEvents>(),
    rng: new Rng('build'),
    world: () => {
      throw new Error('no world');
    },
    notify: () => {},
  });
  return build.query();
}

const FORKED: BiomeId[][] = [['verdant'], ['foundry', 'citadel'], ['abyss', 'rift'], ['void']];

describe('the descent', () => {
  it('is three straight depths on a fresh profile', () => {
    expect(planDescent(() => false)).toEqual([['verdant'], ['foundry'], ['abyss']]);
  });

  it('turns unlocked biomes into forks rather than extra acts', () => {
    const tiers = planDescent((id) => id === 'biome_citadel');
    expect(tiers).toEqual([['verdant'], ['foundry', 'citadel'], ['abyss']]);
  });

  it('adds the Unbound as a fourth and final depth', () => {
    const tiers = planDescent(() => true);
    expect(tiers).toEqual(FORKED);
  });

  it('offers both depths of a fork after the boss, and rejoins after either', () => {
    for (let seed = 0; seed < 20; seed++) {
      const map = generateMap({ seed: `fork-${seed}`, tiers: FORKED, boundLevel: 0 });
      const [first, foundry, citadel, abyss, rift, finale] = map.acts;
      expect(map.tiers).toBe(4);

      const afterFirst = choicesFrom(map, map.nodesById.get(first.bossId)!);
      const biomes = new Set(afterFirst.map((n) => actOf(map, n).biome));
      expect(biomes).toEqual(new Set(['foundry', 'citadel']));

      for (const act of [foundry, citadel]) {
        const next = choicesFrom(map, map.nodesById.get(act.bossId)!);
        expect(new Set(next.map((n) => actOf(map, n).biome))).toEqual(new Set(['abyss', 'rift']));
      }
      for (const act of [abyss, rift]) {
        const next = choicesFrom(map, map.nodesById.get(act.bossId)!);
        expect(next.every((n) => actOf(map, n) === finale)).toBe(true);
      }
      expect(choicesFrom(map, map.nodesById.get(finale.bossId)!)).toHaveLength(0);
    }
  });

  it('measures run length along one route, not across every alternative', () => {
    const map = generateMap({ seed: 'length', tiers: FORKED, boundLevel: 0 });
    expect(map.pathLength).toBe(32);
    expect(map.totalRooms).toBeGreaterThan(map.pathLength * 2);
    // Alternatives cover the same depth range.
    const depthsOf = (biome: BiomeId): number[] =>
      map.acts.find((a) => a.biome === biome)!.nodes.map((n) => n.depth);
    expect(Math.min(...depthsOf('foundry'))).toBe(Math.min(...depthsOf('citadel')));
    expect(Math.max(...depthsOf('abyss'))).toBe(Math.max(...depthsOf('rift')));
  });

  it('never meets the same boss twice on any route', () => {
    for (const route of [
      ['verdant', 'foundry', 'abyss'],
      ['verdant', 'citadel', 'abyss'],
      ['verdant', 'foundry', 'rift'],
      ['verdant', 'citadel', 'rift'],
    ] as BiomeId[][]) {
      const bosses = route.map((biome) => bossForBiome(biome).id);
      expect(new Set(bosses).size).toBe(route.length);
    }
  });
});

describe('route outlook', () => {
  it('counts what is still reachable, and the entrance sees the whole act', () => {
    const map = generateMap({ seed: 'outlook', biomes: ['verdant'], boundLevel: 0 });
    const act = map.acts[0];
    const entrance = map.nodesById.get(act.entranceIds[0])!;
    const outlook = routeOutlook(map, entrance);
    const shops = act.nodes.filter((n) => n.archetype === 'shop' && !n.hidden).length;
    expect(outlook.counts.shop ?? 0).toBe(shops);
    expect(outlook.roomsToBoss).toBe(act.layers - 1);
    for (const node of map.nodesById.values()) {
      if (node.archetype === 'boss') continue;
      const ahead = routeOutlook(map, node);
      expect(ahead.roomsToBoss).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('map-shaping unlocks', () => {
  const archetypesOf = (gates: string[]): string[] => {
    const out: string[] = [];
    for (let seed = 0; seed < 40; seed++) {
      const map = generateMap({ seed: `gates-${seed}`, biomes: ['verdant', 'foundry', 'abyss'], boundLevel: 0, gates });
      for (const node of map.nodesById.values()) out.push(node.archetype);
    }
    return out;
  };

  it('keeps Wardens and Hollows off the map until they are unlocked', () => {
    const locked = archetypesOf([]);
    expect(locked).not.toContain('miniboss');
    expect(locked).not.toContain('secret');
    const open = archetypesOf(['room_miniboss', 'room_secret']);
    expect(open).toContain('miniboss');
    expect(open).toContain('secret');
  });

  it('places a second altar per act with Stranger Encounters', () => {
    for (let seed = 0; seed < 20; seed++) {
      const map = generateMap({ seed: `events-${seed}`, biomes: ['verdant'], boundLevel: 0, gates: ['more_events'] });
      expect(map.acts[0].nodes.filter((n) => n.archetype === 'event').length).toBeGreaterThanOrEqual(2);
    }
  });

  it('hides fewer rooms with Cartography', () => {
    const hiddenCount = (gates: string[]): number => {
      let hidden = 0;
      for (let seed = 0; seed < 40; seed++) {
        const map = generateMap({ seed: `fog-${seed}`, biomes: ['verdant', 'foundry'], boundLevel: 0, gates });
        for (const node of map.nodesById.values()) if (node.hidden) hidden++;
      }
      return hidden;
    };
    expect(hiddenCount(['map_clarity'])).toBeLessThan(hiddenCount([]));
  });
});

describe('content unlocks gate real content', () => {
  it('keeps transformations, evolutions and exotic physics out of a fresh profile', () => {
    const build = emptyBuild();
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      for (const def of rollOffers({ rng: new Rng(`fresh-${i}`), build, count: 4, unlocked: () => false })) {
        seen.add(def.id);
      }
    }
    for (const id of seen) {
      const def = getUpgrade(id)!;
      expect(def.family === 'transformation' && def.rarity !== 'cursed', id).toBe(false);
      expect(def.evolvesFrom, id).toBeUndefined();
    }
    expect(seen.has('phase_bounce')).toBe(false);
    expect(seen.has('gravity_flip')).toBe(false);
  });

  it('opens transformations once Deep Catalogue is owned', () => {
    const build = emptyBuild();
    const unlocked = (id: string): boolean => id === 'family_transformation';
    let found = false;
    for (let i = 0; i < 400 && !found; i++) {
      const offers = rollOffers({ rng: new Rng(`deep-${i}`), build, count: 4, unlocked, allowCursed: false });
      found = offers.some((d) => d.family === 'transformation');
    }
    expect(found).toBe(true);
  });

  it('gates every family-level upgrade behind a node that exists', () => {
    const grants = new Set(UNLOCK_NODES.flatMap((n) => n.grants ?? []));
    for (const def of upgradeCatalogue()) {
      if (def.unlock) expect(grants.has(def.unlock), `${def.id} -> ${def.unlock}`).toBe(true);
    }
  });

  it('keeps Specialists and Primes out of rooms until unlocked', () => {
    const biomes: BiomeId[] = ['verdant', 'foundry', 'abyss', 'citadel', 'rift', 'void'];
    for (const biome of biomes) {
      const ids = [...eligibleEnemies(biome, 30, () => false), ...eligibleElites(biome, 30, () => false)].map((d) => d.id);
      for (const gated of ['blinker', 'mirrorling', 'thornweaver', 'plated_prime', 'brood_mother', 'void_sentinel']) {
        expect(ids).not.toContain(gated);
      }
    }
    expect(eligibleElites('foundry', 30, () => true).map((d) => d.id)).toContain('plated_prime');
  });

  it('never sells a node whose content is not built', () => {
    const profile = profileWith();
    profile.addCurrency('echoes', 100000);
    for (const node of UNLOCK_NODES.filter((n) => n.planned)) {
      expect(profile.canPurchase(node).ok).toBe(false);
    }
    const goals = profile.unlockGoals();
    expect(goals.some((g) => g.node.planned)).toBe(false);
    for (let i = 1; i < goals.length; i++) expect(goals[i].cost).toBeGreaterThanOrEqual(goals[i - 1].cost);
  });
});

describe('run progression', () => {
  it('reports full progress at the final boss', () => {
    const run = new Run({ profile: profileWith(), seed: 'PROGRESS', ballId: 'standard' });
    const last = run.map.acts[run.map.acts.length - 1];
    run.phase = 'map';
    run.mapChoices = [run.map.nodesById.get(last.bossId)!];
    run.chooseNode(last.bossId);
    expect(run.progress()).toBe(1);
    expect(run.currentAct().tier).toBe(2);
    run.dispose();
  });

  it('resumes onto the same map even after unlocks change the shape of new maps', () => {
    const profile = profileWith();
    const run = new Run({ profile, seed: 'RESHAPE', ballId: 'standard' });
    const layout = (map: RunMap): string[] => [...map.nodesById.values()].map((n) => `${n.id}:${n.archetype}:${n.next}`);
    const before = layout(run.map);
    const snapshot = sanitiseSnapshot(JSON.parse(JSON.stringify(run.captureSnapshot())))!;
    run.dispose();

    for (const gate of ['biome_citadel', 'room_miniboss', 'room_secret', 'more_events', 'map_clarity']) profile.grant(gate);
    const resumed = new Run({ profile, seed: snapshot.seed, ballId: snapshot.ballId, restore: snapshot });
    expect(layout(resumed.map)).toEqual(before);
    resumed.dispose();

    const fresh = new Run({ profile, seed: 'RESHAPE', ballId: 'standard' });
    expect(fresh.tiers[1]).toEqual(['foundry', 'citadel']);
    fresh.dispose();
  });

  it('pays a one-off bonus for reaching a new depth', () => {
    const profile = profileWith();
    const first = new Run({ profile, seed: 'MILESTONE', ballId: 'standard' });
    first.finish(false, 'hazard');
    expect(first.echoBreakdown.some((line) => line.label.startsWith('New depth'))).toBe(true);
    first.dispose();

    const second = new Run({ profile, seed: 'MILESTONE-2', ballId: 'standard' });
    second.finish(false, 'hazard');
    expect(second.echoBreakdown.some((line) => line.label.startsWith('New depth'))).toBe(false);
    second.dispose();
  });
});
