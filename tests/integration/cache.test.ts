import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../helpers/app.js";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server.js";

/**
 * Part (b): repeat audits inside the window must be served without refetching.
 * The fixture server counts requests, so "did not refetch" is asserted against
 * the origin rather than inferred from a header.
 */

let origin: FixtureServer;

beforeAll(async () => {
  origin = await startFixtureServer();
});

afterAll(async () => {
  await origin.close();
});

async function withApp(env: Record<string, string>, run: (harness: TestApp) => Promise<void>): Promise<void> {
  const harness = await createTestApp(env);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

const post = (harness: TestApp, url: string, extra: Record<string, unknown> = {}) =>
  harness.app.inject({ method: "POST", url: "/v1/audit", payload: { url, ...extra } });

describe("audit caching", () => {
  it("serves a repeat audit from cache without hitting the origin again", async () => {
    await withApp({ CACHE_TTL_MS: "60000" }, async (harness) => {
      const url = origin.url("/good");
      const before = origin.hits.get("/good") ?? 0;

      const first = await post(harness, url);
      expect(first.headers["x-cache"]).toBe("MISS");
      expect(first.json().cache.hit).toBe(false);

      const second = await post(harness, url);
      expect(second.headers["x-cache"]).toBe("HIT");
      expect(second.json().cache.hit).toBe(true);

      expect(origin.hits.get("/good")).toBe(before + 1);
    });
  });

  it("returns identical audit content on a cache hit", async () => {
    await withApp({ CACHE_TTL_MS: "60000" }, async (harness) => {
      const url = origin.url("/counter");
      const first = (await post(harness, url)).json();
      const second = (await post(harness, url)).json();

      // /counter changes its title on every request, so identical titles prove
      // the second response came from the cache rather than a refetch.
      expect(second.metadata.title).toBe(first.metadata.title);
      expect(second.auditedAt).toBe(first.auditedAt);
      expect(second.summary.score).toBe(first.summary.score);
    });
  });

  it("reports a growing age and shrinking remaining lifetime on hits", async () => {
    await withApp({ CACHE_TTL_MS: "60000" }, async (harness) => {
      const url = origin.url("/good");
      await post(harness, url);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const hit = (await post(harness, url)).json();
      expect(hit.cache.ageMs).toBeGreaterThan(0);
      expect(hit.cache.expiresInMs).toBeLessThan(60_000);
      expect(hit.cache.ttlMs).toBe(60_000);
    });
  });

  it("refetches once the configured window has elapsed", async () => {
    // A short window makes expiry observable without a long test.
    await withApp({ CACHE_TTL_MS: "150" }, async (harness) => {
      const url = origin.url("/counter");
      const first = (await post(harness, url)).json();

      await new Promise((resolve) => setTimeout(resolve, 200));

      const afterExpiry = await post(harness, url);
      expect(afterExpiry.headers["x-cache"]).toBe("MISS");
      expect(afterExpiry.json().metadata.title).not.toBe(first.metadata.title);
    });
  });

  it("honours a zero window by never caching", async () => {
    await withApp({ CACHE_TTL_MS: "0" }, async (harness) => {
      const url = origin.url("/good");
      await post(harness, url);
      const second = await post(harness, url);
      expect(second.headers["x-cache"]).toBe("MISS");
    });
  });

  it("bypasses and replaces the cached entry when refresh is set", async () => {
    await withApp({ CACHE_TTL_MS: "60000" }, async (harness) => {
      const url = origin.url("/counter");
      const first = (await post(harness, url)).json();

      const refreshed = await post(harness, url, { refresh: true });
      expect(refreshed.headers["x-cache"]).toBe("BYPASS");
      expect(refreshed.json().metadata.title).not.toBe(first.metadata.title);

      // The refreshed result is what subsequent cached reads return.
      const third = await post(harness, url);
      expect(third.headers["x-cache"]).toBe("HIT");
      expect(third.json().metadata.title).toBe(refreshed.json().metadata.title);
    });
  });

  it("keys the cache per URL, not globally", async () => {
    await withApp({ CACHE_TTL_MS: "60000" }, async (harness) => {
      await post(harness, origin.url("/good"));
      const other = await post(harness, origin.url("/bare"));
      expect(other.headers["x-cache"]).toBe("MISS");
    });
  });

  it("shares one cache entry across equivalent spellings of a URL", async () => {
    await withApp({ CACHE_TTL_MS: "60000" }, async (harness) => {
      await post(harness, origin.url("/good"));
      const withFragment = await post(harness, `${origin.url("/good")}#section`);
      expect(withFragment.headers["x-cache"]).toBe("HIT");
    });
  });

  it("does not treat different query strings as the same page", async () => {
    await withApp({ CACHE_TTL_MS: "60000" }, async (harness) => {
      await post(harness, `${origin.url("/good")}?variant=a`);
      const different = await post(harness, `${origin.url("/good")}?variant=b`);
      expect(different.headers["x-cache"]).toBe("MISS");
    });
  });

  it("evicts under memory pressure instead of growing without bound", async () => {
    await withApp({ CACHE_TTL_MS: "60000", CACHE_MAX_ENTRIES: "2" }, async (harness) => {
      await post(harness, `${origin.url("/good")}?n=1`);
      await post(harness, `${origin.url("/good")}?n=2`);
      await post(harness, `${origin.url("/good")}?n=3`);

      expect(harness.services.cache.stats().size).toBe(2);
      // The oldest entry was evicted, so it has to be refetched.
      expect((await post(harness, `${origin.url("/good")}?n=1`)).headers["x-cache"]).toBe("MISS");
    });
  });

  it("does not cache failed audits", async () => {
    await withApp({ CACHE_TTL_MS: "60000" }, async (harness) => {
      const first = await post(harness, origin.url("/json"));
      expect(first.statusCode).toBe(415);

      const second = await post(harness, origin.url("/json"));
      expect(second.statusCode).toBe(415);
      expect(harness.services.cache.stats().size).toBe(0);
    });
  });

  it("collapses concurrent audits of the same cold URL into one origin fetch", async () => {
    await withApp({ CACHE_TTL_MS: "60000" }, async (harness) => {
      const path = "/counter";
      const before = origin.hits.get(path) ?? 0;

      const responses = await Promise.all(Array.from({ length: 8 }, () => post(harness, origin.url(path))));

      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      // Without single-flight this would be 8 requests to the origin.
      expect(origin.hits.get(path)).toBe(before + 1);

      const titles = new Set(responses.map((response) => response.json().metadata.title));
      expect(titles.size).toBe(1);
    });
  });
});
