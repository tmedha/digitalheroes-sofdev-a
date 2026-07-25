/**
 * Single-flight deduplication.
 *
 * The cache only helps once a result exists. Without this, N simultaneous
 * requests for a cold URL all miss the cache and all hit the origin — the
 * classic stampede, and the case where an audit service is most likely to look
 * like an attacker to the site it is auditing. Concurrent requests for the same
 * key share one execution and one result.
 */
export class InFlightRegistry<T> {
  private readonly pending = new Map<string, Promise<T>>();

  async run(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing;

    const promise = task().finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  get size(): number {
    return this.pending.size;
  }
}
