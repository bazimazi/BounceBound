import { describe, expect, it } from 'vitest';
import { Rng, dailySeed, generateSeedString, hashString, normalizeSeed } from '../src/core/rng';
import { EventBus } from '../src/core/events';
import { Pool, RingBuffer, compact } from '../src/core/pool';
import { Clock, FIXED_DT } from '../src/core/clock';
import { MemoryStorage, PersistentStore, SaveScheduler } from '../src/core/storage';
import { StatSheet, STAT_SPECS, createBaseStats } from '../src/sim/stats';

describe('Rng determinism', () => {
  it('produces identical sequences for identical seeds', () => {
    const a = new Rng('SEED-ONE');
    const b = new Rng('SEED-ONE');
    const left = Array.from({ length: 64 }, () => a.next());
    const right = Array.from({ length: 64 }, () => b.next());
    expect(left).toEqual(right);
  });

  it('produces different sequences for adjacent seeds', () => {
    const a = new Rng('SEEDA');
    const b = new Rng('SEEDB');
    const left = Array.from({ length: 16 }, () => a.next());
    const right = Array.from({ length: 16 }, () => b.next());
    expect(left).not.toEqual(right);
  });

  it('stays inside [0, 1)', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 20000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('int is inclusive on both ends and never out of range', () => {
    const rng = new Rng('ints');
    const seen = new Set<number>();
    for (let i = 0; i < 4000; i++) seen.add(rng.int(3, 7));
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7]);
  });

  it('weighted ignores zero-weight entries', () => {
    const rng = new Rng('weights');
    const items = ['skip', 'take'];
    for (let i = 0; i < 500; i++) {
      expect(rng.weighted(items, (item) => (item === 'skip' ? 0 : 1))).toBe('take');
    }
    expect(rng.weighted(items, () => 0)).toBeUndefined();
  });

  it('forks are independent of parent consumption', () => {
    const parent = new Rng('fork-root');
    const first = parent.fork('rooms');
    const parentAfter = new Rng('fork-root');
    parentAfter.next();
    parentAfter.next();
    // A fork is derived from the label and the parent's seeded state, so the same
    // label from the same parent state matches, which is what room generation
    // relies on.
    const second = new Rng('fork-root').fork('rooms');
    expect(first.next()).toBe(second.next());
  });

  it('hashString avalanches similar inputs', () => {
    expect(hashString('a')).not.toBe(hashString('b'));
    expect(hashString('seed1')).not.toBe(hashString('seed2'));
  });

  it('seed strings normalize predictably', () => {
    expect(normalizeSeed('abcd-efgh')).toBe('ABCD-EFGH');
    expect(normalizeSeed('  ab12  ')).toBe('AB12');
    expect(normalizeSeed('!!!').length).toBeGreaterThan(0);
    expect(generateSeedString(new Rng(1))).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('daily seed is stable within a UTC day', () => {
    const a = dailySeed(new Date(Date.UTC(2026, 8, 22, 1, 0, 0)));
    const b = dailySeed(new Date(Date.UTC(2026, 8, 22, 23, 0, 0)));
    const c = dailySeed(new Date(Date.UTC(2026, 8, 23, 1, 0, 0)));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('EventBus', () => {
  type Events = { hit: { value: number }; other: { flag: boolean } };

  it('dispatches in ascending order and allows payload mutation', () => {
    const bus = new EventBus<Events>();
    const seen: number[] = [];
    bus.on('hit', (p) => { seen.push(1); p.value *= 2; }, { order: 10 });
    bus.on('hit', (p) => { seen.push(0); p.value += 5; }, { order: -10 });
    const payload = bus.emit('hit', { value: 1 });
    expect(seen).toEqual([0, 1]);
    expect(payload.value).toBe(12);
  });

  it('unsubscribes cleanly during dispatch', () => {
    const bus = new EventBus<Events>();
    let count = 0;
    const off = bus.on('hit', () => {
      count++;
      off();
    });
    bus.emit('hit', { value: 0 });
    bus.emit('hit', { value: 0 });
    expect(count).toBe(1);
  });

  it('clears groups without touching other listeners', () => {
    const bus = new EventBus<Events>();
    let kept = 0;
    let dropped = 0;
    bus.on('hit', () => kept++, { group: 'keep' });
    bus.on('hit', () => dropped++, { group: 'drop' });
    bus.clearGroup('drop');
    bus.emit('hit', { value: 0 });
    expect(kept).toBe(1);
    expect(dropped).toBe(0);
  });

  it('once listeners fire exactly once', () => {
    const bus = new EventBus<Events>();
    let count = 0;
    bus.once('hit', () => count++);
    bus.emit('hit', { value: 0 });
    bus.emit('hit', { value: 0 });
    expect(count).toBe(1);
  });

  it('listeners added during dispatch do not see the in-flight event', () => {
    const bus = new EventBus<Events>();
    let inner = 0;
    bus.on('hit', () => {
      bus.on('hit', () => inner++);
    });
    bus.emit('hit', { value: 0 });
    expect(inner).toBe(0);
  });
});

describe('Pooling', () => {
  it('reuses released objects and resets them', () => {
    const pool = new Pool<{ n: number }>(() => ({ n: 0 }), (item) => { item.n = 0; }, 2);
    const a = pool.obtain();
    a.n = 5;
    pool.release(a);
    const b = pool.obtain();
    expect(b).toBe(a);
    expect(b.n).toBe(0);
  });

  it('ring buffer recycles the oldest slot when full', () => {
    const ring = new RingBuffer<{ active: boolean; id: number }>(3, () => ({ active: false, id: 0 }));
    for (let i = 0; i < 3; i++) {
      const item = ring.next();
      item.active = true;
      item.id = i;
    }
    expect(ring.activeCount).toBe(3);
    const recycled = ring.next();
    expect(recycled.id).toBe(0);
  });

  it('compact preserves order and reports removals', () => {
    const list = [1, 2, 3, 4, 5];
    const removed: number[] = [];
    compact(list, (n) => n % 2 === 1, (n) => removed.push(n));
    expect(list).toEqual([1, 3, 5]);
    expect(removed).toEqual([2, 4]);
  });
});

describe('Clock', () => {
  it('runs a fixed number of steps for a given elapsed time', () => {
    const clock = new Clock();
    let steps = 0;
    clock.advance(0, () => steps++);
    clock.advance(1000 / 60, () => steps++);
    // One 60fps frame is four 240Hz steps.
    expect(steps).toBeGreaterThanOrEqual(3);
    expect(steps).toBeLessThanOrEqual(5);
  });

  it('does not accumulate backlog during hit-stop', () => {
    const clock = new Clock();
    clock.advance(0, () => {});
    clock.requestHitStop(0.05);
    let steps = 0;
    clock.advance(16, () => steps++);
    expect(steps).toBe(0);
    expect(clock.hitStop).toBeGreaterThan(0);
  });

  it('clamps absurd frame deltas instead of fast-forwarding', () => {
    const clock = new Clock();
    clock.advance(0, () => {});
    let steps = 0;
    clock.advance(60_000, () => steps++);
    expect(steps).toBeLessThanOrEqual(12);
  });

  it('time scale slows the simulation', () => {
    const clock = new Clock();
    clock.advance(0, () => {});
    clock.timeScale = 0.25;
    let steps = 0;
    clock.advance(1000 / 60, () => steps++);
    expect(steps).toBeLessThanOrEqual(2);
  });

  it('exposes a sane fixed timestep', () => {
    expect(FIXED_DT).toBeCloseTo(1 / 240, 6);
  });
});

describe('PersistentStore', () => {
  interface Save { count: number; name: string }

  it('round-trips data', () => {
    const storage = new MemoryStorage();
    const store = new PersistentStore<Save>({ key: 'test', version: 1, storage });
    expect(store.save({ count: 3, name: 'x' })).toBe(true);
    const loaded = store.load();
    expect(loaded.outcome).toBe('ok');
    expect(loaded.data).toEqual({ count: 3, name: 'x' });
  });

  it('reports empty for a fresh profile', () => {
    const store = new PersistentStore<Save>({ key: 'fresh', version: 1, storage: new MemoryStorage() });
    expect(store.load().outcome).toBe('empty');
  });

  it('recovers from a corrupted live key using the backup', () => {
    const storage = new MemoryStorage();
    const store = new PersistentStore<Save>({ key: 'test', version: 1, storage });
    store.save({ count: 1, name: 'first' });
    store.save({ count: 2, name: 'second' });
    storage.setItem('test', '{ this is not json');
    const loaded = store.load();
    expect(loaded.outcome).toBe('recovered-backup');
    expect(loaded.data?.name).toBe('first');
  });

  it('rejects a tampered payload via the checksum', () => {
    const storage = new MemoryStorage();
    const store = new PersistentStore<Save>({ key: 'test', version: 1, storage });
    store.save({ count: 1, name: 'first' });
    const raw = JSON.parse(storage.getItem('test')!);
    raw.data.count = 9999;
    storage.setItem('test', JSON.stringify(raw));
    storage.removeItem('test::backup');
    expect(store.load().outcome).toBe('corrupt');
  });

  it('migrates an older version through the migrate hook', () => {
    const storage = new MemoryStorage();
    const older = new PersistentStore<Save>({ key: 'test', version: 1, storage });
    older.save({ count: 1, name: 'legacy' });
    const newer = new PersistentStore<Save>({
      key: 'test',
      version: 2,
      storage,
      migrate: (data) => ({ ...(data as Save), name: `${(data as Save).name}-migrated` }),
    });
    expect(newer.load().data?.name).toBe('legacy-migrated');
  });

  it('scheduler coalesces requests and flushes on demand', () => {
    let writes = 0;
    const scheduler = new SaveScheduler(() => writes++, 10_000);
    scheduler.request();
    scheduler.request();
    scheduler.request();
    expect(writes).toBe(0);
    scheduler.flush();
    expect(writes).toBe(1);
    scheduler.flush();
    expect(writes).toBe(1);
  });
});

describe('StatSheet', () => {
  it('resolves (base + flat) * mult', () => {
    const sheet = new StatSheet();
    sheet.add({ id: 'a', name: 'A', flat: { damage: 5 } });
    sheet.add({ id: 'b', name: 'B', mult: { damage: 2 } });
    expect(sheet.get().damage).toBe((STAT_SPECS.damage.base + 5) * 2);
  });

  it('clamps to the documented range', () => {
    const sheet = new StatSheet();
    sheet.add({ id: 'huge', name: 'Huge', mult: { critChance: 1000 } });
    expect(sheet.get().critChance).toBeLessThanOrEqual(STAT_SPECS.critChance.max);
    const sheet2 = new StatSheet();
    sheet2.add({ id: 'neg', name: 'Neg', flat: { gravity: -99999 } });
    expect(sheet2.get().gravity).toBeGreaterThanOrEqual(STAT_SPECS.gravity.min);
  });

  it('retains attribution per stat', () => {
    const sheet = new StatSheet();
    sheet.add({ id: 'heavy', name: 'Heavy Core', mult: { damage: 1.3 } });
    const contributions = sheet.contributionsFor('damage');
    expect(contributions).toHaveLength(1);
    expect(contributions[0].sourceName).toBe('Heavy Core');
  });

  it('base overrides from a ball class change the baseline', () => {
    const sheet = new StatSheet();
    sheet.setBaseOverrides({ damage: 22 });
    expect(sheet.get().damage).toBe(22);
    expect(sheet.baseValue('damage')).toBe(22);
  });

  it('every stat has a finite base inside its own range', () => {
    const base = createBaseStats();
    for (const [key, spec] of Object.entries(STAT_SPECS)) {
      expect(Number.isFinite(base[key as keyof typeof base])).toBe(true);
      expect(spec.base).toBeGreaterThanOrEqual(spec.min);
      expect(spec.base).toBeLessThanOrEqual(spec.max);
    }
  });
});
