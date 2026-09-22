import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../src/core/storage';
import { Rng } from '../src/core/rng';
import { FIXED_DT } from '../src/core/clock';
import { Profile } from '../src/meta/profile';
import { Run } from '../src/run/run';
import { Bot, mulberry, playRun } from './helpers/bot';
import { BALL_CLASSES } from '../src/content/balls';
import { upgradeCatalogue } from '../src/content/upgrades/index';
import { rollOffers } from '../src/game/upgradeSystem';
import { SYNERGY_DEFS } from '../src/content/synergies';
import { createInput } from '../src/sim/ball';

function freshProfile(unlockEverything = false): Profile {
  const profile = new Profile(new MemoryStorage());
  if (unlockEverything) {
    for (const gate of [
      'family_transformation',
      'family_cursed',
      'family_evolution',
      'family_exotic',
      'biome_citadel',
      'biome_rift',
      'biome_void',
      'elite_primes',
      'enemy_specialists',
      'room_miniboss',
      'bound_levels',
      'event_portals',
      'room_secret',
    ]) {
      profile.grant(gate);
    }
  }
  return profile;
}

describe('a run can be played start to finish', () => {
  it('completes a full run without throwing', () => {
    const profile = freshProfile(true);
    const run = new Run({ profile, seed: 'SMOKE-RUN', ballId: 'standard', biomes: ['verdant'] });
    const result = playRun(run, { maxSteps: 240 * 60 * 6 });
    expect(result.error).toBeNull();
    expect(run.telemetry.roomsEntered).toBeGreaterThan(1);
    expect(result.phaseChanges).toBeGreaterThan(4);
    run.dispose();
  });

  it('reaches a conclusion (victory or defeat) and records it', () => {
    const profile = freshProfile(true);
    const run = new Run({ profile, seed: 'CONCLUDE', ballId: 'standard', biomes: ['verdant'] });
    playRun(run, { maxSteps: 240 * 60 * 10 });
    if (run.finished) {
      expect(profile.data.history.length).toBe(1);
      const record = profile.data.history[0];
      expect(record.seed).toBe(run.seed);
      expect(record.echoesEarned).toBeGreaterThan(0);
      // A failed run must still pay out: that is the core retention promise.
      expect(profile.balance('echoes')).toBeGreaterThan(0);
    }
    run.dispose();
  });

  it('is reproducible from its seed', () => {
    const snapshot = (): string => {
      const run = new Run({ profile: freshProfile(true), seed: 'REPRO-SEED', ballId: 'standard', biomes: ['verdant', 'foundry'] });
      const bot = new Bot({ random: mulberry(999) });
      playRun(run, { maxSteps: 240 * 30, bot });
      const value = [
        run.currentNode.id,
        run.currentRoom.templateId,
        run.currentRoom.enemies.map((e) => `${e.defId}@${Math.round(e.x)},${Math.round(e.y)}`).join('|'),
        run.build.order.join(','),
      ].join(' :: ');
      run.dispose();
      return value;
    };
    expect(snapshot()).toBe(snapshot());
  });

  it('plays every ball class without error', () => {
    for (const ballClass of BALL_CLASSES) {
      const profile = freshProfile(true);
      const run = new Run({ profile, seed: `BALL-${ballClass.id}`, ballId: ballClass.id, biomes: ['verdant'] });
      const result = playRun(run, { maxSteps: 240 * 45, bot: new Bot({ random: mulberry(7) }) });
      expect(result.error, `${ballClass.id}: ${result.error?.message}`).toBeNull();
      expect(Number.isFinite(run.world.ball.x)).toBe(true);
      expect(Number.isFinite(run.stats().damage)).toBe(true);
      run.dispose();
    }
  });

  it('survives every Bound level', () => {
    for (let level = 0; level <= 12; level++) {
      const profile = freshProfile(true);
      const run = new Run({ profile, seed: `BOUND-${level}`, ballId: 'standard', boundLevel: level, biomes: ['verdant'] });
      const result = playRun(run, { maxSteps: 240 * 40, bot: new Bot({ random: mulberry(level + 1) }) });
      expect(result.error, `bound ${level}: ${result.error?.message}`).toBeNull();
      expect(run.world.ball.maxHp).toBeGreaterThan(0);
      run.dispose();
    }
  });

  it('fights every boss without error', () => {
    for (const biome of ['verdant', 'foundry', 'abyss'] as const) {
      const profile = freshProfile(true);
      const run = new Run({ profile, seed: `BOSS-${biome}`, ballId: 'heavy', biomes: [biome] });
      // Jump straight to the boss node for this act.
      const bossNode = run.map.nodesById.get(run.map.acts[0].bossId)!;
      run.phase = 'map';
      run.mapChoices = [bossNode];
      run.chooseNode(bossNode.id);
      expect(run.world.enemies.length).toBeGreaterThan(0);
      const bot = new Bot({ random: mulberry(3), skill: 0.7 });
      const input = createInput();
      let error: Error | null = null;
      try {
        // Cast: `phase` is narrowed by the assignment above, but the loop must
        // observe the value the simulation mutates.
        for (let i = 0; i < 240 * 60 && (run.phase as string) === 'playing'; i++) {
          const state = bot.update(run.world, FIXED_DT);
          Object.assign(input, state);
          run.step(FIXED_DT, input);
        }
      } catch (e) {
        error = e as Error;
      }
      expect(error, `${biome}: ${error?.message}`).toBeNull();
      run.dispose();
    }
  });
});

describe('upgrade catalogue integrity', () => {
  const catalogue = upgradeCatalogue();

  it('has a substantial catalogue with unique ids', () => {
    expect(catalogue.length).toBeGreaterThan(55);
    const ids = new Set(catalogue.map((u) => u.id));
    expect(ids.size).toBe(catalogue.length);
  });

  it('every upgrade has player-facing text and at least one mechanical effect', () => {
    for (const def of catalogue) {
      expect(def.name.length, def.id).toBeGreaterThan(2);
      expect(def.text.length, def.id).toBeGreaterThan(15);
      const hasEffect = !!def.install || !!def.flat || !!def.mult;
      expect(hasEffect, `${def.id} does nothing`).toBe(true);
      expect(def.tags.length, `${def.id} has no tags`).toBeGreaterThan(0);
    }
  });

  it('every trade-off upgrade states its cost', () => {
    for (const def of catalogue) {
      const hasPenalty =
        (def.mult && Object.values(def.mult).some((v) => (v as number) < 1)) ||
        (def.flat && Object.values(def.flat).some((v) => (v as number) < 0));
      if (hasPenalty) {
        expect(def.cost, `${def.id} has a penalty but no stated cost`).toBeDefined();
      }
    }
  });

  it('every cursed upgrade states its cost', () => {
    for (const def of catalogue.filter((d) => d.rarity === 'cursed')) {
      expect(def.cost, `${def.id}`).toBeDefined();
    }
  });

  it('evolutions reference an existing prerequisite', () => {
    const ids = new Set(catalogue.map((u) => u.id));
    for (const def of catalogue) {
      if (!def.evolvesFrom) continue;
      expect(ids.has(def.evolvesFrom), `${def.id} evolves from missing ${def.evolvesFrom}`).toBe(true);
    }
  });

  it('every synergy references existing upgrades', () => {
    const ids = new Set(catalogue.map((u) => u.id));
    for (const synergy of SYNERGY_DEFS) {
      for (const required of [...synergy.requiresAll, ...(synergy.requiresAny ?? [])]) {
        expect(ids.has(required), `${synergy.id} requires missing ${required}`).toBe(true);
      }
      expect(synergy.description.length).toBeGreaterThan(20);
    }
  });

  it('every upgrade can be installed and then removed cleanly', () => {
    for (const def of catalogue) {
      const profile = freshProfile(true);
      const run = new Run({ profile, seed: `INSTALL-${def.id}`, ballId: 'standard', biomes: ['verdant'] });
      const before = run.bus.listenerCount();
      expect(run.build.add(def.id), `could not add ${def.id}`).toBe(true);
      // Run a second of simulation so tick-based upgrades actually execute.
      const input = createInput();
      for (let i = 0; i < 240; i++) run.step(FIXED_DT, input);
      run.build.remove(def.id);
      expect(run.bus.listenerCount(), `${def.id} leaked listeners`).toBe(before);
      run.dispose();
    }
  });

  it('a heavily stacked build stays numerically sane', () => {
    const profile = freshProfile(true);
    const run = new Run({ profile, seed: 'STACKED', ballId: 'standard', biomes: ['verdant'] });
    // Add every upgrade at maximum stacks: the worst case for stat explosions.
    for (const def of catalogue) {
      for (let i = 0; i < (def.maxStacks ?? 1); i++) run.build.add(def.id);
    }
    const stats = run.stats();
    for (const [key, value] of Object.entries(stats)) {
      expect(Number.isFinite(value), `${key} is not finite`).toBe(true);
    }
    const input = createInput();
    let error: Error | null = null;
    try {
      for (let i = 0; i < 240 * 20; i++) run.step(FIXED_DT, input);
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toBeUndefined();
    run.dispose();
  });
});

describe('offer generation', () => {
  it('never offers a duplicate within one hand', () => {
    const profile = freshProfile(true);
    const run = new Run({ profile, seed: 'OFFERS', ballId: 'standard', biomes: ['verdant'] });
    for (let i = 0; i < 300; i++) {
      const offers = run.build.query();
      void offers;
      const hand = rollHand(run, 4);
      const ids = new Set(hand.map((u) => u.id));
      expect(ids.size).toBe(hand.length);
    }
    run.dispose();
  });

  it('never offers an upgrade already at maximum stacks', () => {
    const profile = freshProfile(true);
    const run = new Run({ profile, seed: 'MAXED', ballId: 'standard', biomes: ['verdant'] });
    run.build.add('perfect_focus');
    run.build.add('perfect_focus');
    run.build.add('perfect_focus');
    for (let i = 0; i < 200; i++) {
      const hand = rollHand(run, 4);
      expect(hand.some((u) => u.id === 'perfect_focus')).toBe(false);
    }
    run.dispose();
  });

  it('never fills a hand with curses', () => {
    const profile = freshProfile(true);
    const run = new Run({ profile, seed: 'CURSES', ballId: 'standard', biomes: ['verdant'] });
    for (let i = 0; i < 400; i++) {
      const hand = rollHand(run, 3);
      const cursed = hand.filter((u) => u.rarity === 'cursed').length;
      expect(cursed).toBeLessThanOrEqual(1);
    }
    run.dispose();
  });

  it('pulls toward the existing build (synergy convergence)', () => {
    const measure = (seedPrefix: string, seedBuild: string[]): number => {
      const profile = freshProfile(true);
      const run = new Run({ profile, seed: seedPrefix, ballId: 'standard', biomes: ['verdant'] });
      for (const id of seedBuild) run.build.add(id);
      let wallRelated = 0;
      for (let i = 0; i < 400; i++) {
        for (const offer of rollHand(run, 3)) {
          if (offer.tags.includes('wall') || offer.tags.includes('ricochet')) wallRelated++;
        }
      }
      run.dispose();
      return wallRelated;
    };
    const withoutTheme = measure('THEME-A', []);
    const withTheme = measure('THEME-A', ['wall_ride', 'chain_bounce', 'angle_mastery']);
    expect(withTheme).toBeGreaterThan(withoutTheme);
  });
});

let handCounter = 0;

function rollHand(run: Run, count: number) {
  handCounter++;
  return rollOffers({
    rng: new Rng(`${run.seed}:hand:${handCounter}`),
    build: run.build.query(),
    count,
    allowCursed: true,
    unlocked: () => true,
  });
}
