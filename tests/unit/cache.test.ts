import { describe, expect, it } from "vitest";
import { TtlCache } from "../../src/lib/cache.js";

/** Controllable clock so TTL behaviour is tested without real waiting. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("TtlCache", () => {
  it("returns a miss for an unknown key", () => {
    const cache = new TtlCache<string>({ ttlMs: 1000, maxEntries: 10 });
    expect(cache.get("absent")).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
  });

  it("serves a stored value within the window with age and remaining lifetime", () => {
    const clock = fakeClock();
    const cache = new TtlCache<string>({ ttlMs: 5_000, maxEntries: 10, now: clock.now });

    cache.set("k", "value");
    clock.advance(2_000);

    const hit = cache.get("k");
    expect(hit).toBeDefined();
    expect(hit?.value).toBe("value");
    expect(hit?.ageMs).toBe(2_000);
    expect(hit?.expiresInMs).toBe(3_000);
  });

  it("stops serving a value once the window elapses", () => {
    const clock = fakeClock();
    const cache = new TtlCache<string>({ ttlMs: 5_000, maxEntries: 10, now: clock.now });

    cache.set("k", "value");
    clock.advance(4_999);
    expect(cache.get("k")).toBeDefined();

    clock.advance(1);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.stats().expirations).toBe(1);
  });

  it("treats the expiry instant as expired rather than fresh", () => {
    const clock = fakeClock();
    const cache = new TtlCache<string>({ ttlMs: 1_000, maxEntries: 10, now: clock.now });
    cache.set("k", "v");
    clock.advance(1_000);
    expect(cache.get("k")).toBeUndefined();
  });

  it("caches nothing when the window is zero", () => {
    const cache = new TtlCache<string>({ ttlMs: 0, maxEntries: 10 });
    cache.set("k", "v");
    expect(cache.get("k")).toBeUndefined();
    expect(cache.stats().size).toBe(0);
  });

  it("evicts the least recently used entry when full", () => {
    const cache = new TtlCache<string>({ ttlMs: 60_000, maxEntries: 2 });

    cache.set("a", "1");
    cache.set("b", "2");
    cache.get("a"); // "a" is now the most recently used, so "b" should go first
    cache.set("c", "3");

    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.stats().evictions).toBe(1);
  });

  it("never exceeds its maximum size", () => {
    const cache = new TtlCache<number>({ ttlMs: 60_000, maxEntries: 50 });
    for (let i = 0; i < 500; i += 1) cache.set(`key-${i}`, i);
    expect(cache.stats().size).toBe(50);
  });

  it("overwrites rather than duplicates an existing key", () => {
    const cache = new TtlCache<string>({ ttlMs: 60_000, maxEntries: 10 });
    cache.set("k", "first");
    cache.set("k", "second");
    expect(cache.get("k")?.value).toBe("second");
    expect(cache.stats().size).toBe(1);
  });

  it("resets the window when a key is rewritten", () => {
    const clock = fakeClock();
    const cache = new TtlCache<string>({ ttlMs: 1_000, maxEntries: 10, now: clock.now });

    cache.set("k", "v1");
    clock.advance(900);
    cache.set("k", "v2");
    clock.advance(900);

    expect(cache.get("k")?.value).toBe("v2");
  });

  it("drops expired entries when pruned", () => {
    const clock = fakeClock();
    const cache = new TtlCache<string>({ ttlMs: 1_000, maxEntries: 10, now: clock.now });

    cache.set("a", "1");
    cache.set("b", "2");
    clock.advance(1_500);
    cache.set("c", "3");

    expect(cache.prune()).toBe(2);
    expect(cache.stats().size).toBe(1);
  });

  it("counts hits and misses", () => {
    const cache = new TtlCache<string>({ ttlMs: 60_000, maxEntries: 10 });
    cache.set("k", "v");
    cache.get("k");
    cache.get("k");
    cache.get("nope");

    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
  });

  it("removes a key on delete", () => {
    const cache = new TtlCache<string>({ ttlMs: 60_000, maxEntries: 10 });
    cache.set("k", "v");
    expect(cache.delete("k")).toBe(true);
    expect(cache.get("k")).toBeUndefined();
  });
});
