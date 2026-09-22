/**
 * Deterministic random number generation.
 *
 * Every random decision in Bouncebound flows through an Rng instance derived from
 * the run seed, so a seed string fully reproduces a run's map, rooms, enemy
 * placement and reward offers. Rngs are forkable: each subsystem gets its own
 * stream so that consuming an extra number in (say) particle jitter can never
 * shift the layout of a room.
 */

/** FNV-1a style string hash producing a well-mixed 32-bit integer. */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Final avalanche so that similar strings produce very different seeds.
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

const SEED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  /** Number of values drawn; useful for debugging desyncs. */
  draws = 0;

  constructor(seed: number | string) {
    const s = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
    // sfc32 seeded from four decorrelated words.
    this.a = s >>> 0;
    this.b = (s ^ 0x9e3779b9) >>> 0;
    this.c = (Math.imul(s, 0x85ebca6b) ^ 0x165667b1) >>> 0;
    this.d = (Math.imul(s ^ 0xc2b2ae35, 0x27d4eb2f) || 1) >>> 0;
    for (let i = 0; i < 12; i++) this.next();
    this.draws = 0;
  }

  /** Raw uniform in [0, 1). */
  next(): number {
    this.draws++;
    // sfc32
    const t = (this.a + this.b | 0) + this.d | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with the given probability. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** -1 or 1. */
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /**
   * Weighted pick. `weight` may return 0 to exclude an item entirely.
   * Returns undefined when every candidate has zero weight.
   */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T | undefined {
    let total = 0;
    for (const item of items) {
      const w = weight(item);
      if (w > 0) total += w;
    }
    if (total <= 0) return undefined;
    let roll = this.next() * total;
    for (const item of items) {
      const w = weight(item);
      if (w <= 0) continue;
      roll -= w;
      if (roll <= 0) return item;
    }
    return items[items.length - 1];
  }

  /** Fisher-Yates in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
    return items;
  }

  /** Take `count` distinct items (or fewer if the pool is smaller). */
  sample<T>(items: readonly T[], count: number): T[] {
    const copy = items.slice();
    this.shuffle(copy);
    return copy.slice(0, Math.min(count, copy.length));
  }

  /** Approximately normal distribution via the central limit trick. */
  gaussian(mean = 0, stdDev = 1): number {
    const u = (this.next() + this.next() + this.next() + this.next() - 2) / 2;
    return mean + u * stdDev * 1.7320508;
  }

  /**
   * Derive an independent child stream. Same label + same parent seed always
   * yields the same child, so subsystems stay decoupled but reproducible.
   */
  fork(label: string): Rng {
    return new Rng((hashString(label) ^ Math.imul(this.a, 0x9e3779b1)) >>> 0);
  }

  /** Snapshot for save/restore of mid-run generator state. */
  saveState(): [number, number, number, number] {
    return [this.a, this.b, this.c, this.d];
  }

  loadState(state: [number, number, number, number]): void {
    this.a = state[0] >>> 0;
    this.b = state[1] >>> 0;
    this.c = state[2] >>> 0;
    this.d = state[3] >>> 0;
  }
}

/** Human-typable seed, e.g. "KQ7P-MX3T". */
export function generateSeedString(rng: Rng = new Rng(Date.now() ^ Math.floor(Math.random() * 0xffffffff))): string {
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-';
    out += SEED_ALPHABET[rng.int(0, SEED_ALPHABET.length - 1)];
  }
  return out;
}

/**
 * Canonicalises a player-entered seed.
 *
 * The body is never truncated below its meaningful length: seeds such as
 * DAILY20260922 and DAILY20260923 must stay distinct, and an earlier version that
 * clipped to 12 characters silently merged consecutive daily challenges.
 */
export function normalizeSeed(input: string): string {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  if (!cleaned) return generateSeedString();
  return cleaned.length > 4 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned;
}

/** Deterministic seed for a daily challenge (UTC day boundary). */
export function dailySeed(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const d = `${date.getUTCDate()}`.padStart(2, '0');
  return normalizeSeed(`DAILY${y}${m}${d}`);
}
