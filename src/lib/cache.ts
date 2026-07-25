/**
 * Bounded TTL cache with LRU eviction, used to serve repeat audits of the same
 * URL without refetching. The TTL window is configuration, not a constant, so
 * operators can tune freshness against upstream load. Part (b).
 *
 * In-process by design: one instance per node, no external dependency. The
 * interface is deliberately narrow so a Redis-backed implementation could be
 * dropped in without touching callers.
 */

export interface CacheEntry<T> {
  value: T;
  /** ms since epoch when the entry was written. */
  storedAt: number;
  /** ms since epoch when the entry stops being servable. */
  expiresAt: number;
}

export interface CacheHit<T> {
  value: T;
  /** How long the entry has been in the cache. */
  ageMs: number;
  /** How much of its TTL window remains. */
  expiresInMs: number;
}

export interface CacheStats {
  size: number;
  maxEntries: number;
  ttlMs: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
}

export interface TtlCacheOptions {
  ttlMs: number;
  maxEntries: number;
  /** Injectable clock; tests advance time without sleeping. */
  now?: () => number;
}

export class TtlCache<T> {
  /** Map preserves insertion order, which is what makes LRU cheap here. */
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  readonly ttlMs: number;
  readonly maxEntries: number;

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? Date.now;
  }

  get(key: string): CacheHit<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }

    const now = this.now();
    if (now >= entry.expiresAt) {
      this.entries.delete(key);
      this.expirations += 1;
      this.misses += 1;
      return undefined;
    }

    // Re-insert to mark as most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;

    return {
      value: entry.value,
      ageMs: now - entry.storedAt,
      expiresInMs: entry.expiresAt - now,
    };
  }

  set(key: string, value: T): void {
    // A zero TTL disables caching outright; storing the entry would let the
    // very next request read it back within the same millisecond.
    if (this.ttlMs <= 0) return;

    const now = this.now();
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: now, expiresAt: now + this.ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Drops expired entries. Called on a timer so abandoned keys do not linger. */
  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key);
        removed += 1;
        this.expirations += 1;
      }
    }
    return removed;
  }

  stats(): CacheStats {
    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }
}
