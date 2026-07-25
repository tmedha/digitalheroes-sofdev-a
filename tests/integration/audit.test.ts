import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../helpers/app.js";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server.js";

/**
 * End-to-end coverage of the audit endpoint against a real origin server.
 * Nothing is mocked — these exercise routing, validation, the fetch path, the
 * error funnel and the response contract together.
 */

let origin: FixtureServer;
let harness: TestApp;

beforeAll(async () => {
  origin = await startFixtureServer();
  harness = await createTestApp();
});

afterAll(async () => {
  await harness.close();
  await origin.close();
});

const audit = (url: string, extra: Record<string, unknown> = {}) =>
  harness.app.inject({ method: "POST", url: "/v1/audit", payload: { url, ...extra } });

describe("POST /v1/audit", () => {
  it("audits a well-optimised page and returns the documented contract", async () => {
    const response = await audit(origin.url("/good"));
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.url.requested).toBe(origin.url("/good"));
    expect(body.url.final).toBe(origin.url("/good"));
    expect(body.url.redirected).toBe(false);
    expect(body.fetch.status).toBe(200);
    expect(body.fetch.bytes).toBeGreaterThan(0);
    expect(body.fetch.contentType).toContain("text/html");
    expect(body.requestId).toEqual(expect.any(String));
    expect(body.auditedAt).toEqual(expect.any(String));

    expect(body.summary.score).toBeGreaterThanOrEqual(0);
    expect(body.summary.score).toBeLessThanOrEqual(100);
    expect(body.summary.passed + body.summary.warnings + body.summary.failed).toBe(body.checks.length);
    expect(body.summary.categories.length).toBeGreaterThan(0);

    for (const check of body.checks) {
      expect(check).toMatchObject({
        id: expect.any(String),
        category: expect.any(String),
        title: expect.any(String),
        status: expect.stringMatching(/^(pass|warn|fail)$/),
        detail: expect.any(String),
      });
    }
  });

  it("extracts the page's metadata", async () => {
    const body = (await audit(origin.url("/good"))).json();
    expect(body.metadata.title).toBe("Hand-made ceramic mugs from a small studio");
    expect(body.metadata.h1s).toEqual(["Hand-made ceramic mugs"]);
    expect(body.metadata.canonical).toBe("https://example.com/mugs");
    expect(body.metadata.openGraph["og:image"]).toBe("https://example.com/og.png");
    expect(body.metadata.structuredDataTypes).toEqual(["Product"]);
    expect(body.metadata.images.total).toBe(2);
    expect(body.metadata.images.missingAlt).toBe(0);
  });

  it("scores a page with headers and metadata far above a bare one", async () => {
    const good = (await audit(origin.url("/good"))).json();
    const bare = (await audit(origin.url("/bare"))).json();
    expect(good.summary.score).toBeGreaterThan(bare.summary.score);
    expect(bare.summary.failed).toBeGreaterThan(0);
  });

  it("reports failing security checks with the observed value", async () => {
    const body = (await audit(origin.url("/leaky-headers"))).json();
    const disclosure = body.checks.find(
      (check: { id: string }) => check.id === "security.version_disclosure",
    );
    expect(disclosure.status).toBe("warn");
    expect(disclosure.value).toContain("server");
  });

  it("sorts failures ahead of warnings and passes", async () => {
    const checks = (await audit(origin.url("/bare"))).json().checks as Array<{ status: string }>;
    const rank = { fail: 0, warn: 1, pass: 2 } as Record<string, number>;
    const ranks = checks.map((check) => rank[check.status] ?? 3);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("still audits a page that returns 5xx, and fails the status check", async () => {
    const response = await audit(origin.url("/server-error"));
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.fetch.status).toBe(500);
    const statusCheck = body.checks.find((check: { id: string }) => check.id === "fetch.status");
    expect(statusCheck.status).toBe("fail");
  });

  it("flags a noindex page as un-indexable", async () => {
    const body = (await audit(origin.url("/noindex"))).json();
    const robots = body.checks.find((check: { id: string }) => check.id === "seo.robots");
    expect(robots.status).toBe("fail");
  });

  it("follows redirects and reports the chain it took", async () => {
    const body = (await audit(origin.url("/redirect/3"))).json();
    expect(body.url.requested).toBe(origin.url("/redirect/3"));
    expect(body.url.final).toBe(origin.url("/good"));
    expect(body.url.redirected).toBe(true);
    expect(body.fetch.redirectCount).toBe(3);
    expect(body.url.redirects).toHaveLength(3);
    expect(body.url.redirects[0]).toMatchObject({ status: 302 });
  });

  it("resolves a relative redirect target", async () => {
    const body = (await audit(origin.url("/redirect-relative"))).json();
    expect(body.url.final).toBe(origin.url("/good"));
  });

  it("echoes a request ID on every response and honours an inbound one", async () => {
    const generated = await audit(origin.url("/good"));
    expect(generated.headers["x-request-id"]).toEqual(expect.any(String));

    const supplied = await harness.app.inject({
      method: "POST",
      url: "/v1/audit",
      headers: { "x-request-id": "trace-abc-123" },
      payload: { url: origin.url("/good") },
    });
    expect(supplied.headers["x-request-id"]).toBe("trace-abc-123");
    expect(supplied.json().requestId).toBe("trace-abc-123");
  });
});

describe("GET /v1/audit", () => {
  it("accepts the URL as a query parameter", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/audit?url=${encodeURIComponent(origin.url("/good"))}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().url.final).toBe(origin.url("/good"));
  });

  it("accepts refresh as a query string boolean", async () => {
    const url = origin.url("/good");
    await harness.app.inject({ method: "GET", url: `/v1/audit?url=${encodeURIComponent(url)}` });
    const refreshed = await harness.app.inject({
      method: "GET",
      url: `/v1/audit?url=${encodeURIComponent(url)}&refresh=true`,
    });
    expect(refreshed.headers["x-cache"]).toBe("BYPASS");
  });
});

describe("input validation", () => {
  it("rejects a missing url with a structured error", async () => {
    const response = await harness.app.inject({ method: "POST", url: "/v1/audit", payload: {} });
    expect(response.statusCode).toBe(400);

    const body = response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.requestId).toEqual(expect.any(String));
    expect(body.error.retryable).toBe(false);
    expect(body.error.details[0]).toMatchObject({ field: "url", message: expect.any(String) });
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a non-string", 42],
    ["a URL longer than the cap", `https://example.com/${"a".repeat(2100)}`],
  ])("rejects %s", async (_label, url) => {
    const response = await harness.app.inject({ method: "POST", url: "/v1/audit", payload: { url } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a malformed body", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/audit",
      headers: { "content-type": "application/json" },
      payload: "{ not json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("normalises a bare hostname to https", async () => {
    // Resolution will fail offline, but the input must survive validation and
    // reach the fetch stage rather than being rejected as malformed.
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/audit",
      payload: { url: "this-host-does-not-exist.invalid" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("UPSTREAM_UNREACHABLE");
  });

  it.each(["file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)"])(
    "blocks the non-http URL %s",
    async (url) => {
      const response = await harness.app.inject({ method: "POST", url: "/v1/audit", payload: { url } });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("BLOCKED_URL");
    },
  );

  it("blocks URLs containing credentials", async () => {
    const response = await audit("https://user:secret@example.com/");
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("BLOCKED_URL");
  });
});

describe("upstream failure handling", () => {
  it("returns 504 when the origin is too slow", async () => {
    const slow = await createTestApp({ FETCH_TIMEOUT_MS: "300", AUDIT_TIMEOUT_MS: "1000" });
    try {
      const response = await slow.app.inject({
        method: "POST",
        url: "/v1/audit",
        payload: { url: origin.url("/slow?ms=5000") },
      });
      expect(response.statusCode).toBe(504);

      const body = response.json();
      expect(body.error.code).toBe("UPSTREAM_TIMEOUT");
      expect(body.error.retryable).toBe(true);
    } finally {
      await slow.close();
    }
  });

  it("returns 502 when the redirect limit is exceeded", async () => {
    const response = await audit(origin.url("/redirect-loop"));
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("TOO_MANY_REDIRECTS");
  });

  it("respects a lower redirect limit", async () => {
    const strict = await createTestApp({ MAX_REDIRECTS: "1" });
    try {
      const response = await strict.app.inject({
        method: "POST",
        url: "/v1/audit",
        payload: { url: origin.url("/redirect/3") },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json().error.code).toBe("TOO_MANY_REDIRECTS");
    } finally {
      await strict.close();
    }
  });

  it("refuses to follow a redirect that leaves http(s), re-checking every hop", async () => {
    const response = await audit(origin.url("/redirect-to-file"));
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("BLOCKED_URL");
  });

  it("reports a redirect with no Location as unreachable", async () => {
    const response = await audit(origin.url("/redirect-no-location"));
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("UPSTREAM_UNREACHABLE");
  });

  it("returns 415 for a non-HTML document", async () => {
    const response = await audit(origin.url("/json"));
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe("UNSUPPORTED_CONTENT_TYPE");
  });

  it("returns 415 when no content type is declared", async () => {
    const response = await audit(origin.url("/no-content-type"));
    expect(response.statusCode).toBe(415);
  });

  it("refuses an oversized body declared by content-length", async () => {
    const response = await audit(origin.url("/large-declared"));
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("RESPONSE_TOO_LARGE");
  });

  it("aborts a body that streams past the limit without declaring a length", async () => {
    const small = await createTestApp({ MAX_BODY_BYTES: "50000" });
    try {
      const response = await small.app.inject({
        method: "POST",
        url: "/v1/audit",
        payload: { url: origin.url("/large-streamed") },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json().error.code).toBe("RESPONSE_TOO_LARGE");
    } finally {
      await small.close();
    }
  });

  it("returns 502 when the host cannot be resolved", async () => {
    const response = await audit("https://definitely-not-a-real-domain-xyz.invalid/");
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("UPSTREAM_UNREACHABLE");
  });
});

describe("SSRF protection with the guard enabled", () => {
  it("blocks loopback and internal targets", async () => {
    // The default test config allows loopback so the fixture origin is
    // reachable; this app is configured the way production runs.
    const guarded = await createTestApp({ ALLOW_PRIVATE_ADDRESSES: "false" });
    try {
      for (const url of [
        origin.url("/good"),
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/",
        "http://192.168.1.1/admin",
        "http://localhost:8080/",
      ]) {
        const response = await guarded.app.inject({ method: "POST", url: "/v1/audit", payload: { url } });
        expect(response.statusCode, `expected ${url} to be blocked`).toBe(403);
        expect(response.json().error.code).toBe("BLOCKED_URL");
      }
    } finally {
      await guarded.close();
    }
  });
});

describe("service endpoints", () => {
  it("reports health without requiring any dependency", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
  });

  it("exposes runtime stats and effective configuration on /readyz", async () => {
    const body = (await harness.app.inject({ method: "GET", url: "/readyz" })).json();
    expect(body.cache).toMatchObject({ size: expect.any(Number), ttlMs: expect.any(Number) });
    expect(body.concurrency).toMatchObject({ maxConcurrent: expect.any(Number) });
    expect(body.config.cacheTtlMs).toBe(harness.config.CACHE_TTL_MS);
  });

  it("serves the landing page", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("URL Audit Service");
  });

  it("returns a structured 404 for an unknown route", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    expect(response.json().error.requestId).toEqual(expect.any(String));
  });
});
