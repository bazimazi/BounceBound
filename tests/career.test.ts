import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../src/core/storage';
import { Profile } from '../src/meta/profile';
import { Run } from '../src/run/run';
import { UNLOCK_BY_ID } from '../src/content/unlocks';
import {
  MASTERY_TIERS,
  RANK_TRACK_END,
  masteryTier,
  rankReward,
  runExperience,
  xpToNextRank,
  type RunSummary,
} from '../src/content/career';
import { applyRunToContracts, contractText, dayKey, rollContracts } from '../src/content/contracts';

function freshProfile(): Profile {
  return new Profile(new MemoryStorage());
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    ballId: 'standard',
    victory: false,
    boundLevel: 0,
    roomsCleared: 5,
    enemiesKilled: 20,
    elitesKilled: 1,
    bossesKilled: 0,
    perfectBounces: 10,
    bestCombo: 12,
    propsDestroyed: 8,
    shardsEarned: 90,
    depth: 1,
    synergies: 0,
    ...overrides,
  };
}

describe('career rank', () => {
  it('pays every rank crossed, including several at once', () => {
    const profile = freshProfile();
    const needed = xpToNextRank(1) + xpToNextRank(2) + xpToNextRank(3);
    const ups = profile.addExperience(needed + 5);
    expect(ups.map((u) => u.rank)).toEqual([2, 3, 4]);
    expect(profile.career.rank).toBe(4);
    expect(profile.career.xp).toBe(5);
    // Rank 2 pays echoes, rank 3 a title, rank 4 a finish.
    expect(profile.balance('echoes')).toBeGreaterThan(0);
    expect(profile.career.titles).toContain('Drifter');
    expect(profile.career.finishes).toContain('ember');
    expect(profile.counter('careerRank')).toBe(4);
  });

  it('keeps paying past the authored track', () => {
    expect(rankReward(RANK_TRACK_END + 1).echoes).toBeGreaterThan(0);
    expect(xpToNextRank(RANK_TRACK_END + 20)).toBe(xpToNextRank(RANK_TRACK_END));
  });

  it('scales run experience with Bound and rewards a win', () => {
    const base = runExperience(summary()).reduce((sum, line) => sum + line.amount, 0);
    const bound = runExperience(summary({ boundLevel: 5 })).reduce((sum, line) => sum + line.amount, 0);
    const won = runExperience(summary({ victory: true })).reduce((sum, line) => sum + line.amount, 0);
    expect(base).toBeGreaterThan(0);
    expect(bound).toBeGreaterThan(base);
    expect(won).toBeGreaterThan(base + 100);
  });

  it('only lets a player wear titles and finishes they own', () => {
    const profile = freshProfile();
    profile.wearTitle('Bound Breaker');
    profile.wearFinish('prism');
    expect(profile.career.title).toBe('');
    expect(profile.career.finish).toBe('class');
  });
});

describe('ball mastery', () => {
  it('pays each tier once, with the Gilded finish at the top', () => {
    const profile = freshProfile();
    const ups = profile.addMastery('standard', MASTERY_TIERS[MASTERY_TIERS.length - 1]);
    expect(ups.map((u) => u.tier)).toEqual([1, 2, 3, 4, 5]);
    expect(profile.career.finishes).toContain('gilded');
    expect(profile.career.titles).toContain('Kernel Master');
    expect(profile.addMastery('standard', 5000)).toHaveLength(0);
    expect(masteryTier(profile.masteryOf('standard'))).toBe(5);
  });
});

describe('daily contracts', () => {
  it('rolls the same three for everyone on a given day, one per difficulty', () => {
    const a = rollContracts('2026-09-30', ['standard']);
    const b = rollContracts('2026-09-30', ['standard']);
    expect(a).toEqual(b);
    expect(a.contracts.map((c) => c.tier)).toEqual([0, 1, 2]);
    expect(new Set(a.contracts.map((c) => c.kind)).size).toBe(3);
    // A ball contract needs a second ball to choose between.
    expect(a.contracts.some((c) => c.kind === 'ballRooms')).toBe(false);
    expect(rollContracts('2026-10-01', ['standard'])).not.toEqual(a);
  });

  it('accumulates across runs and completes exactly once', () => {
    const day = rollContracts('2026-09-30', ['standard']);
    for (const contract of day.contracts) {
      contract.kind = 'kills';
      contract.target = 30;
    }
    expect(applyRunToContracts(day, summary({ enemiesKilled: 20 }))).toHaveLength(0);
    expect(applyRunToContracts(day, summary({ enemiesKilled: 20 }))).toHaveLength(3);
    expect(day.contracts.every((c) => c.done && c.progress === 30)).toBe(true);
    expect(applyRunToContracts(day, summary({ enemiesKilled: 20 }))).toHaveLength(0);
  });

  it('takes the best single run for record-style contracts', () => {
    const day = rollContracts('2026-09-30', ['standard']);
    const combo = day.contracts[0];
    combo.kind = 'combo';
    combo.target = 20;
    applyRunToContracts(day, summary({ bestCombo: 12 }));
    applyRunToContracts(day, summary({ bestCombo: 9 }));
    expect(combo.progress).toBe(12);
    expect(combo.done).toBe(false);
  });

  it('reads naturally in the singular', () => {
    const day = rollContracts('2026-09-30', ['standard']);
    const contract = { ...day.contracts[0], kind: 'bosses' as const, target: 1 };
    expect(contractText(contract, () => '')).toBe('Defeat 1 boss');
    expect(contractText({ ...contract, target: 3 }, () => '')).toBe('Defeat 3 bosses');
  });

  it('rolls over on a new day and keeps the day stable in between', () => {
    const profile = freshProfile();
    const today = profile.contractDay(new Date('2026-09-30T08:00:00Z'));
    expect(today.day).toBe('2026-09-30');
    expect(profile.contractDay(new Date('2026-09-30T23:00:00Z'))).toBe(today);
    expect(profile.contractDay(new Date('2026-10-01T01:00:00Z')).day).toBe('2026-10-01');
    expect(dayKey(new Date('2026-10-01T01:00:00Z'))).toBe('2026-10-01');
  });
});

describe('a finished run moves the career', () => {
  it('pays experience and mastery even for a run that ends at once', () => {
    const profile = freshProfile();
    const run = new Run({ profile, seed: 'CAREER', ballId: 'standard' });
    run.telemetry.roomsCleared = 3;
    run.finish(false, 'hazard');
    expect(run.career).not.toBeNull();
    expect(run.career!.xpTotal).toBeGreaterThan(0);
    expect(profile.career.totalXp).toBe(run.career!.xpTotal);
    expect(profile.masteryOf('standard')).toBe(run.career!.xpTotal);
    run.dispose();
  });

  it('does not count an abandoned run as a composed finish', () => {
    const profile = freshProfile();
    const run = new Run({ profile, seed: 'COMPOSED', ballId: 'standard' });
    run.finish(false, 'abandoned');
    expect(profile.counter('compositeRuns')).toBe(0);
    run.dispose();
  });

  it('survives a profile round trip, and repairs a damaged career', () => {
    const storage = new MemoryStorage();
    const profile = new Profile(storage);
    profile.addExperience(500);
    profile.addMastery('standard', 200);
    profile.contractDay();
    profile.flush();
    const again = new Profile(storage);
    expect(again.career.rank).toBe(profile.career.rank);
    expect(again.masteryOf('standard')).toBe(200);
    expect(again.career.contracts?.contracts).toHaveLength(3);

    again.data.career = { rank: -4, xp: 'lots', titles: [7], finish: 'nope', mastery: { ghost: 5 } } as never;
    again.markDirty();
    again.flush();
    const repaired = new Profile(storage);
    expect(repaired.career.rank).toBe(1);
    expect(repaired.career.finish).toBe('class');
    expect(repaired.masteryOf('ghost')).toBe(0);
  });
});

describe('permanent bonuses and Bound penalties', () => {
  it('add to the base stat instead of replacing it', () => {
    // A regression guard: on a class that does not override a stat, Tempering's
    // +8 integrity used to set integrity to 8.
    const profile = freshProfile();
    profile.data.unlockRanks.core_integrity = 1;
    const run = new Run({ profile, seed: 'TEMPER', ballId: 'standard' });
    expect(run.stats().maxHealth).toBe(108);
    run.dispose();
  });

  it('scale the class value under Bound instead of overwriting it', () => {
    const run = new Run({ profile: freshProfile(), seed: 'BOUND', ballId: 'standard', boundLevel: 11 });
    expect(run.stats().maxHealth).toBeCloseTo(66, 0);
    expect(run.stats().airAccel).toBeGreaterThan(1000);
    run.dispose();
  });
});

describe('the Reliquary', () => {
  it('is paid in relics, not echoes', () => {
    const profile = freshProfile();
    const node = UNLOCK_BY_ID.relic_opening;
    profile.addCurrency('echoes', 1000);
    expect(profile.canPurchase(node).ok).toBe(false);
    profile.addCurrency('relics', node.cost);
    expect(profile.purchase(node.id)).toBe(true);
    expect(profile.balance('relics')).toBe(0);
    expect(profile.balance('echoes')).toBe(1000);
  });

  it('opens a run with an offer once Opening Hand is owned', () => {
    const profile = freshProfile();
    profile.grant('opening_hand');
    const run = new Run({ profile, seed: 'OPENING', ballId: 'standard' });
    expect(run.phase).toBe('reward');
    expect(run.reward?.title).toBe('Opening hand');
    run.takeUpgrade(run.reward!.upgrades[0].id);
    expect(run.phase).toBe('playing');
    run.dispose();
  });

  it('pays more for skipping with Salvage Rights', () => {
    const plain = freshProfile();
    plain.grant('opening_hand');
    const salvage = freshProfile();
    salvage.grant('opening_hand');
    salvage.grant('salvage_rights');
    const a = new Run({ profile: plain, seed: 'SALVAGE', ballId: 'standard' });
    const b = new Run({ profile: salvage, seed: 'SALVAGE', ballId: 'standard' });
    expect(b.reward!.skipShards).toBeGreaterThan(a.reward!.skipShards);
    a.dispose();
    b.dispose();
  });
});
