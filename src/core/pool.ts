/**
 * Object pools.
 *
 * Chain reactions in Bouncebound can spawn hundreds of particles, projectiles
 * and damage numbers in a single frame. Pooling keeps the garbage collector out
 * of the frame budget, which matters because a GC pause during a combo is
 * immediately visible as a stutter.
 */

export class Pool<T> {
  private free: T[] = [];
  private readonly create: () => T;
  private readonly reset: (item: T) => void;
  /** Peak simultaneous live objects; surfaced by the debug overlay. */
  peakLive = 0;
  private live = 0;

  constructor(create: () => T, reset: (item: T) => void, prefill = 0) {
    this.create = create;
    this.reset = reset;
    for (let i = 0; i < prefill; i++) this.free.push(create());
  }

  obtain(): T {
    this.live++;
    if (this.live > this.peakLive) this.peakLive = this.live;
    const item = this.free.pop();
    return item !== undefined ? item : this.create();
  }

  release(item: T): void {
    this.live = Math.max(0, this.live - 1);
    this.reset(item);
    this.free.push(item);
  }

  get available(): number {
    return this.free.length;
  }

  get liveCount(): number {
    return this.live;
  }
}

/**
 * A fixed-capacity array of pooled items with an `active` flag, iterated by
 * index. Used for particles and other high-churn effects where even the pool's
 * push/pop bookkeeping is worth avoiding.
 *
 * When capacity is reached the oldest slot is recycled, so effects degrade
 * gracefully under extreme load instead of growing without bound.
 */
export class RingBuffer<T extends { active: boolean }> {
  readonly items: T[];
  private cursor = 0;

  constructor(capacity: number, create: () => T) {
    this.items = new Array(capacity);
    for (let i = 0; i < capacity; i++) this.items[i] = create();
  }

  /** Returns the next slot to write into, recycling the oldest if full. */
  next(): T {
    const capacity = this.items.length;
    for (let i = 0; i < capacity; i++) {
      const idx = (this.cursor + i) % capacity;
      if (!this.items[idx].active) {
        this.cursor = (idx + 1) % capacity;
        return this.items[idx];
      }
    }
    const item = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % capacity;
    return item;
  }

  get activeCount(): number {
    let n = 0;
    for (let i = 0; i < this.items.length; i++) if (this.items[i].active) n++;
    return n;
  }

  clear(): void {
    for (let i = 0; i < this.items.length; i++) this.items[i].active = false;
    this.cursor = 0;
  }
}

/**
 * Removes inactive entries from an array in place without allocating.
 * Order is preserved so that deterministic iteration order is maintained.
 */
export function compact<T>(list: T[], isAlive: (item: T) => boolean, onRemove?: (item: T) => void): void {
  let write = 0;
  for (let read = 0; read < list.length; read++) {
    const item = list[read];
    if (isAlive(item)) {
      list[write++] = item;
    } else if (onRemove) {
      onRemove(item);
    }
  }
  list.length = write;
}
