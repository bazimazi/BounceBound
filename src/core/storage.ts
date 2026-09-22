/**
 * Durable key/value storage with corruption protection.
 *
 * Progress loss is the one bug a roguelite cannot afford, so writes go through a
 * small journalling scheme:
 *
 *   1. The new payload is written to a staging key with a checksum.
 *   2. The previous good payload is copied to a backup key.
 *   3. The staging key is promoted to the live key and staging is cleared.
 *
 * A crash at any point leaves either the old value or a recoverable staging
 * value, never a half-written live value. On load, a failed checksum falls back
 * to staging, then to backup, and only then reports total loss.
 */

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory fallback: used in tests and when localStorage is unavailable. */
export class MemoryStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export function detectStorage(): KeyValueStorage {
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__bb_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    // Private browsing / disabled storage: degrade to memory rather than crash.
  }
  return new MemoryStorage();
}

function checksum(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0) * 4294967296 + (h1 >>> 0)).toString(36);
}

interface Envelope {
  v: number;
  sum: string;
  at: number;
  data: unknown;
}

export type LoadOutcome = 'ok' | 'empty' | 'recovered-staging' | 'recovered-backup' | 'corrupt';

export interface LoadResult<T> {
  data: T | null;
  outcome: LoadOutcome;
  version: number;
}

export class PersistentStore<T> {
  private readonly liveKey: string;
  private readonly stageKey: string;
  private readonly backupKey: string;
  private readonly storage: KeyValueStorage;
  private readonly version: number;
  private readonly migrate: (data: unknown, fromVersion: number) => T | null;
  /** Set when the last load had to recover; surfaced to the player once. */
  lastOutcome: LoadOutcome = 'empty';

  constructor(options: {
    key: string;
    version: number;
    storage?: KeyValueStorage;
    migrate?: (data: unknown, fromVersion: number) => T | null;
  }) {
    this.liveKey = options.key;
    this.stageKey = `${options.key}::staging`;
    this.backupKey = `${options.key}::backup`;
    this.storage = options.storage ?? detectStorage();
    this.version = options.version;
    this.migrate = options.migrate ?? (() => null);
  }

  save(data: T): boolean {
    const envelope: Envelope = { v: this.version, sum: '', at: Date.now(), data };
    let body: string;
    try {
      body = JSON.stringify(envelope.data);
    } catch {
      return false;
    }
    envelope.sum = checksum(body);
    const text = JSON.stringify(envelope);
    try {
      this.storage.setItem(this.stageKey, text);
      const previous = this.storage.getItem(this.liveKey);
      if (previous) this.storage.setItem(this.backupKey, previous);
      this.storage.setItem(this.liveKey, text);
      this.storage.removeItem(this.stageKey);
      return true;
    } catch {
      // Quota exceeded or storage revoked mid-session.
      return false;
    }
  }

  load(): LoadResult<T> {
    const attempts: Array<{ key: string; outcome: LoadOutcome }> = [
      { key: this.liveKey, outcome: 'ok' },
      { key: this.stageKey, outcome: 'recovered-staging' },
      { key: this.backupKey, outcome: 'recovered-backup' },
    ];
    let sawAnything = false;
    for (const attempt of attempts) {
      const raw = this.storage.getItem(attempt.key);
      if (!raw) continue;
      sawAnything = true;
      const parsed = this.parse(raw);
      if (parsed) {
        this.lastOutcome = attempt.outcome;
        if (attempt.outcome !== 'ok') this.save(parsed.data);
        return { data: parsed.data, outcome: attempt.outcome, version: parsed.version };
      }
    }
    this.lastOutcome = sawAnything ? 'corrupt' : 'empty';
    return { data: null, outcome: this.lastOutcome, version: 0 };
  }

  private parse(raw: string): { data: T; version: number } | null {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return null;
    }
    if (!envelope || typeof envelope !== 'object' || envelope.data === undefined) return null;
    let body: string;
    try {
      body = JSON.stringify(envelope.data);
    } catch {
      return null;
    }
    if (envelope.sum && envelope.sum !== checksum(body)) return null;
    if (envelope.v === this.version) return { data: envelope.data as T, version: envelope.v };
    const migrated = this.migrate(envelope.data, envelope.v ?? 0);
    return migrated ? { data: migrated, version: envelope.v ?? 0 } : null;
  }

  /** Wipes every key this store owns. Used by the explicit reset action. */
  wipe(): void {
    this.storage.removeItem(this.liveKey);
    this.storage.removeItem(this.stageKey);
    this.storage.removeItem(this.backupKey);
  }

  exportText(): string {
    return this.storage.getItem(this.liveKey) ?? '';
  }

  importText(text: string): T | null {
    const parsed = this.parse(text);
    if (!parsed) return null;
    this.save(parsed.data);
    return parsed.data;
  }
}

/**
 * Coalesces frequent save requests into at most one write per interval, with a
 * guaranteed flush. Achievement and currency updates fire constantly during a
 * run; writing synchronously on each would stall frames.
 */
export class SaveScheduler {
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly flushFn: () => void, private readonly intervalMs = 1500) {}

  request(): void {
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.intervalMs);
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.flushFn();
  }

  get isDirty(): boolean {
    return this.dirty;
  }
}
