import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/lib/rate-limit.js";

function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("RateLimiter", () => {
  it("allows requests up to the limit and rejects the next one", () => {
    const limiter = new RateLimiter({ windowMs: 60_000, max: 3 });

    expect(limiter.check("client").allowed).toBe(true);
    expect(limiter.check("client").allowed).toBe(true);
    expect(limiter.check("client").allowed).toBe(true);

    const rejected = limiter.check("client");
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts down the remaining allowance", () => {
    const limiter = new RateLimiter({ windowMs: 60_000, max: 5 });
    expect(limiter.check("client").remaining).toBe(4);
    expect(limiter.check("client").remaining).toBe(3);
    expect(limiter.check("client").remaining).toBe(2);
  });

  it("keeps clients independent of one another", () => {
    const limiter = new RateLimiter({ windowMs: 60_000, max: 2 });

    limiter.check("alice");
    limiter.check("alice");
    expect(limiter.check("alice").allowed).toBe(false);

    // Bob's budget is untouched by Alice exhausting hers.
    expect(limiter.check("bob").allowed).toBe(true);
  });

  it("lets a blocked client through again after the window passes", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ windowMs: 60_000, max: 2, now: clock.now });

    limiter.check("client");
    limiter.check("client");
    expect(limiter.check("client").allowed).toBe(false);

    clock.advance(120_001);
    expect(limiter.check("client").allowed).toBe(true);
  });

  it("smooths the window boundary instead of allowing a double burst", () => {
    // A fixed-window limiter would allow max at the end of one window and max
    // again immediately after the boundary, i.e. 2x the intended rate.
    const clock = fakeClock();
    const limiter = new RateLimiter({ windowMs: 10_000, max: 10, now: clock.now });

    for (let i = 0; i < 10; i += 1) expect(limiter.check("client").allowed).toBe(true);

    // Just past the boundary the previous window's count still weighs almost
    // fully, so the client gets nowhere near a fresh allowance.
    clock.advance(10_100);
    let allowedJustAfterBoundary = 0;
    for (let i = 0; i < 10; i += 1) {
      if (limiter.check("client").allowed) allowedJustAfterBoundary += 1;
    }
    expect(allowedJustAfterBoundary).toBeLessThanOrEqual(1);

    // Most of the way through the new window the old count has decayed.
    clock.advance(8_000);
    expect(limiter.check("client").allowed).toBe(true);
  });

  it("reports a retry-after that covers the remaining window", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ windowMs: 30_000, max: 1, now: clock.now });

    limiter.check("client");
    clock.advance(10_000);

    const result = limiter.check("client");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(20);
  });

  it("forgets clients idle for two full windows", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ windowMs: 1_000, max: 5, now: clock.now });

    limiter.check("client");
    expect(limiter.stats().trackedClients).toBe(1);

    clock.advance(2_001);
    expect(limiter.prune()).toBe(1);
    expect(limiter.stats().trackedClients).toBe(0);
  });

  it("clears state on reset", () => {
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1 });
    limiter.check("client");
    expect(limiter.check("client").allowed).toBe(false);

    limiter.reset("client");
    expect(limiter.check("client").allowed).toBe(true);
  });
});
