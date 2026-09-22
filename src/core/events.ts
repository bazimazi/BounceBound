/**
 * Typed event bus.
 *
 * This is the seam that makes new content cheap: upgrades, achievements,
 * telemetry, audio and visual effects all subscribe to gameplay events rather
 * than being called from inside the simulation. Adding an upgrade means adding a
 * listener, never editing the collision code.
 *
 * Listeners run in ascending `order`. Some payloads are intentionally mutable so
 * that low-order listeners can modify an outcome (for example scaling impact
 * damage) before high-order listeners observe the final value.
 */

export type Listener<P> = (payload: P) => void;

interface Entry<P> {
  fn: Listener<P>;
  order: number;
  /** Non-null when the listener belongs to a removable group (e.g. a run). */
  group: string | null;
  once: boolean;
  removed: boolean;
}

export interface SubscribeOptions {
  /** Lower runs earlier. Default 0. */
  order?: number;
  /** Group label so a batch of listeners can be dropped together. */
  group?: string;
  once?: boolean;
}

export class EventBus<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Entry<never>[]>();
  private dispatchDepth = 0;
  private needsSweep = false;

  on<K extends keyof Events>(type: K, fn: Listener<Events[K]>, options: SubscribeOptions = {}): () => void {
    const entry: Entry<Events[K]> = {
      fn,
      order: options.order ?? 0,
      group: options.group ?? null,
      once: options.once ?? false,
      removed: false,
    };
    let list = this.listeners.get(type);
    if (!list) {
      list = [];
      this.listeners.set(type, list);
    }
    (list as unknown as Entry<Events[K]>[]).push(entry);
    list.sort((a, b) => a.order - b.order);
    return () => {
      entry.removed = true;
      this.needsSweep = true;
      if (this.dispatchDepth === 0) this.sweep();
    };
  }

  once<K extends keyof Events>(type: K, fn: Listener<Events[K]>, options: SubscribeOptions = {}): () => void {
    return this.on(type, fn, { ...options, once: true });
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): Events[K] {
    const list = this.listeners.get(type) as unknown as Entry<Events[K]>[] | undefined;
    if (!list || list.length === 0) return payload;
    this.dispatchDepth++;
    // Snapshot length: listeners added during dispatch do not see this event.
    const count = list.length;
    for (let i = 0; i < count; i++) {
      const entry = list[i];
      if (!entry || entry.removed) continue;
      if (entry.once) {
        entry.removed = true;
        this.needsSweep = true;
      }
      entry.fn(payload);
    }
    this.dispatchDepth--;
    if (this.dispatchDepth === 0 && this.needsSweep) this.sweep();
    return payload;
  }

  /** Drops every listener registered with the given group label. */
  clearGroup(group: string): void {
    for (const list of this.listeners.values()) {
      for (const entry of list) {
        if (entry.group === group) entry.removed = true;
      }
    }
    this.needsSweep = true;
    if (this.dispatchDepth === 0) this.sweep();
  }

  clearAll(): void {
    this.listeners.clear();
    this.needsSweep = false;
  }

  listenerCount(): number {
    let n = 0;
    for (const list of this.listeners.values()) n += list.length;
    return n;
  }

  private sweep(): void {
    for (const [type, list] of this.listeners) {
      let write = 0;
      for (let read = 0; read < list.length; read++) {
        if (!list[read].removed) list[write++] = list[read];
      }
      list.length = write;
      if (write === 0) this.listeners.delete(type);
    }
    this.needsSweep = false;
  }
}
