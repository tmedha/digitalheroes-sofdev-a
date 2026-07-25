import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../helpers/app.js";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server.js";

/** Part (c): rate limiting is per client and enforced before any work happens. */

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

describe("rate limiting", () => {
  it("rejects requests past the limit with a structured 429", async () => {
    await withApp({ RATE_LIMIT_MAX: "3", RATE_LIMIT_WINDOW_MS: "60000" }, async (harness) => {
      const send = () =>
        harness.app.inject({
          method: "POST",
          url: "/v1/audit",
          payload: { url: origin.url("/good") },
        });

      for (let i = 0; i < 3; i += 1) {
        expect((await send()).statusCode).toBe(200);
      }

      const limited = await send();
      expect(limited.statusCode).toBe(429);

      const body = limited.json();
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(body.error.retryable).toBe(true);
      expect(body.error.requestId).toEqual(expect.any(String));
      expect(limited.headers["retry-after"]).toBeDefined();
    });
  });

  it("advertises the limit, remaining allowance and reset on every response", async () => {
    await withApp({ RATE_LIMIT_MAX: "5" }, async (harness) => {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/audit",
        payload: { url: origin.url("/good") },
      });

      expect(response.headers["ratelimit-limit"]).toBe("5");
      expect(response.headers["ratelimit-remaining"]).toBe("4");
      expect(Number(response.headers["ratelimit-reset"])).toBeGreaterThan(0);
    });
  });

  it("counts each API key separately", async () => {
    await withApp({ RATE_LIMIT_MAX: "2" }, async (harness) => {
      const send = (apiKey: string) =>
        harness.app.inject({
          method: "POST",
          url: "/v1/audit",
          headers: { "x-api-key": apiKey },
          payload: { url: origin.url("/good") },
        });

      await send("tenant-a");
      await send("tenant-a");
      expect((await send("tenant-a")).statusCode).toBe(429);

      // A second tenant is unaffected by the first exhausting its budget.
      expect((await send("tenant-b")).statusCode).toBe(200);
    });
  });

  it("counts each client IP separately when no API key is supplied", async () => {
    await withApp({ RATE_LIMIT_MAX: "1", TRUST_PROXY: "true" }, async (harness) => {
      const send = (ip: string) =>
        harness.app.inject({
          method: "POST",
          url: "/v1/audit",
          headers: { "x-forwarded-for": ip },
          payload: { url: origin.url("/good") },
        });

      expect((await send("203.0.113.10")).statusCode).toBe(200);
      expect((await send("203.0.113.10")).statusCode).toBe(429);
      expect((await send("203.0.113.99")).statusCode).toBe(200);
    });
  });

  it("rejects over-limit requests without touching the origin", async () => {
    await withApp({ RATE_LIMIT_MAX: "1", CACHE_TTL_MS: "0" }, async (harness) => {
      const path = "/bare";
      const send = () =>
        harness.app.inject({ method: "POST", url: "/v1/audit", payload: { url: origin.url(path) } });

      await send();
      const hitsAfterFirst = origin.hits.get(path) ?? 0;

      expect((await send()).statusCode).toBe(429);
      // The rejected request must cost us no outbound work at all.
      expect(origin.hits.get(path)).toBe(hitsAfterFirst);
    });
  });

  it("applies the limit before validation, so junk input cannot be used to probe", async () => {
    await withApp({ RATE_LIMIT_MAX: "1" }, async (harness) => {
      await harness.app.inject({ method: "POST", url: "/v1/audit", payload: { url: origin.url("/good") } });
      const response = await harness.app.inject({ method: "POST", url: "/v1/audit", payload: {} });
      expect(response.statusCode).toBe(429);
    });
  });

  it("never rate limits platform health probes", async () => {
    await withApp({ RATE_LIMIT_MAX: "1" }, async (harness) => {
      await harness.app.inject({ method: "POST", url: "/v1/audit", payload: { url: origin.url("/good") } });

      for (let i = 0; i < 10; i += 1) {
        expect((await harness.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      }
    });
  });

  it("lets a blocked client back in once its window rolls over", async () => {
    await withApp({ RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "1000" }, async (harness) => {
      const send = () =>
        harness.app.inject({ method: "POST", url: "/v1/audit", payload: { url: origin.url("/good") } });

      expect((await send()).statusCode).toBe(200);
      expect((await send()).statusCode).toBe(429);

      await new Promise((resolve) => setTimeout(resolve, 2_100));
      expect((await send()).statusCode).toBe(200);
    });
  });
});

describe("concurrency limiting", () => {
  it("sheds load with a retryable 503 when the queue is saturated", async () => {
    await withApp(
      {
        MAX_CONCURRENT_AUDITS: "1",
        MAX_QUEUED_AUDITS: "1",
        QUEUE_TIMEOUT_MS: "5000",
        CACHE_TTL_MS: "0",
        FETCH_TIMEOUT_MS: "3000",
        AUDIT_TIMEOUT_MS: "4000",
      },
      async (harness) => {
        // Distinct URLs so single-flight deduplication does not merge them,
        // and a slow origin so they genuinely overlap.
        const responses = await Promise.all(
          Array.from({ length: 5 }, (_, index) =>
            harness.app.inject({
              method: "POST",
              url: "/v1/audit",
              payload: { url: origin.url(`/slow?ms=700&n=${index}`) },
            }),
          ),
        );

        const overloaded = responses.filter((response) => response.statusCode === 503);
        expect(overloaded.length).toBeGreaterThan(0);

        const body = overloaded[0]!.json();
        expect(body.error.code).toBe("SERVICE_OVERLOADED");
        expect(body.error.retryable).toBe(true);
        expect(overloaded[0]!.headers["retry-after"]).toBeDefined();
      },
    );
  });

  it("completes every request when the queue has room", async () => {
    await withApp(
      { MAX_CONCURRENT_AUDITS: "2", MAX_QUEUED_AUDITS: "50", CACHE_TTL_MS: "0" },
      async (harness) => {
        const responses = await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            harness.app.inject({
              method: "POST",
              url: "/v1/audit",
              payload: { url: origin.url(`/good?n=${index}`) },
            }),
          ),
        );

        expect(responses.every((response) => response.statusCode === 200)).toBe(true);
        expect(harness.services.semaphore.stats().active).toBe(0);
      },
    );
  });
});
