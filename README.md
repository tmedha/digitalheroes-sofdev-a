# URL Audit Service

An HTTP service that fetches a URL and reports on its security headers, SEO and page metadata.

Built to run in production rather than to demo: input validation and SSRF protection, request timeouts at
every layer, bounded concurrency with load shedding, a configurable cache window, per-client rate limiting,
structured logs with request IDs, 187 tests, and CI that runs them on every push.

[![CI](https://github.com/tmedha/digitalheroes-sofdev-a/actions/workflows/ci.yml/badge.svg)](https://github.com/tmedha/digitalheroes-sofdev-a/actions/workflows/ci.yml)

**Live:** <https://url-audit-service-gnpg.onrender.com>
**Source:** <https://github.com/tmedha/digitalheroes-sofdev-a>

Try it: [audit example.com](https://url-audit-service-gnpg.onrender.com/?url=https://example.com), or

```bash
curl -X POST https://url-audit-service-gnpg.onrender.com/v1/audit \
  -H 'content-type: application/json' \
  -d '{"url": "https://example.com"}'
```

The free instance sleeps when idle, so the first request after a quiet period takes a few seconds to wake.

---

## Contents

- [Quick start](#quick-start)
- [API contract](#api-contract)
  - [POST /v1/audit](#post-v1audit)
  - [GET /v1/audit](#get-v1audit)
  - [GET /healthz](#get-healthz)
  - [GET /readyz](#get-readyz)
  - [Error responses](#error-responses)
  - [Response headers](#response-headers)
- [What gets checked](#what-gets-checked)
- [Configuration](#configuration)
- [How it behaves under load](#how-it-behaves-under-load)
- [Security](#security)
- [Testing](#testing)
- [Deploying](#deploying)
- [Design notes](#design-notes)
- [On the use of AI](#on-the-use-of-ai)

---

## Quick start

Requires Node 20.11 or newer.

```bash
npm install
npm run dev            # http://localhost:3000
```

```bash
curl -X POST http://localhost:3000/v1/audit \
  -H 'content-type: application/json' \
  -d '{"url": "https://example.com"}'
```

Opening `http://localhost:3000/` in a browser gives a small page for running an audit by hand.

| Script                  | Purpose                          |
| ----------------------- | -------------------------------- |
| `npm run dev`           | Development server with reload   |
| `npm run build`         | Compile TypeScript to `dist/`    |
| `npm start`             | Run the compiled server          |
| `npm test`              | Run the test suite               |
| `npm run test:coverage` | Run tests with a coverage report |
| `npm run typecheck`     | Typecheck without emitting       |
| `npm run lint`          | Lint                             |

---

## API contract

Base URL is the deployment root. All request and response bodies are JSON.

### POST /v1/audit

Audits a URL.

**Request**

```jsonc
{
  "url": "https://example.com", // required, 1–2048 chars, http(s), absolute
  "refresh": false, // optional, default false; bypass the cache
}
```

A bare hostname (`example.com`) is accepted and upgraded to `https://`. Fragments are stripped before
fetching. Anything that is not `http`/`https`, or that carries credentials (`https://user:pass@host/`), is
rejected.

**Response — `200 OK`**

```jsonc
{
  "url": {
    "requested": "https://example.com/",
    "final": "https://example.com/", // after redirects
    "redirected": false,
    "redirects": [
      // one entry per hop, in order
      { "from": "https://example.com/", "to": "https://www.example.com/", "status": 301 },
    ],
  },
  "fetch": {
    "status": 200,
    "statusText": "OK",
    "contentType": "text/html; charset=utf-8",
    "bytes": 1256,
    "durationMs": 210,
    "redirectCount": 0,
  },
  "summary": {
    "score": 72, // weighted 0–100 across all checks
    "grade": "C", // A >=90, B >=80, C >=70, D >=60, else F
    "passed": 14,
    "warnings": 6,
    "failed": 5,
    "categories": [{ "category": "security", "score": 55, "passed": 3, "warnings": 2, "failed": 3 }],
  },
  "checks": [
    // failures first, then warnings, then passes
    {
      "id": "security.csp", // stable identifier, safe to switch on
      "category": "security", // security | seo | metadata | accessibility | performance
      "title": "Content-Security-Policy",
      "status": "fail", // pass | warn | fail
      "detail": "No Content-Security-Policy header; the page has no defence-in-depth against injected scripts.",
      "value": null, // observed value, when there is one
      "weight": 3, // 1-3; contribution to the score
    },
  ],
  "metadata": {
    "title": "Example Domain",
    "titleLength": 14,
    "description": null,
    "descriptionLength": 0,
    "canonical": null,
    "robots": null,
    "viewport": "width=device-width, initial-scale=1",
    "lang": "en",
    "charset": "utf-8",
    "favicon": null,
    "h1s": ["Example Domain"],
    "headingCounts": { "h1": 1, "h2": 0, "h3": 0, "h4": 0, "h5": 0, "h6": 0 },
    "images": { "total": 0, "missingAlt": 0 },
    "links": { "total": 1, "internal": 0, "external": 1, "nofollow": 0 },
    "openGraph": {},
    "twitter": {},
    "structuredDataTypes": [],
    "wordCount": 28,
  },
  "security": {
    "https": true,
    "headers": {
      // null means the header was absent
      "strict-transport-security": null,
      "content-security-policy": null,
      "x-content-type-options": "nosniff",
      "x-frame-options": null,
      "referrer-policy": null,
      "permissions-policy": null,
      "cross-origin-opener-policy": null,
      "server": "nginx",
      "x-powered-by": null,
    },
  },
  "cache": {
    "hit": false,
    "ageMs": 0, // how long ago the audit was computed
    "expiresInMs": 300000,
    "ttlMs": 300000,
  },
  "auditedAt": "2026-07-25T10:14:03.284Z", // when computed, not when served
  "requestId": "8f14e45f-ceea-467a-9575-3f0d4a1b2c3d",
}
```

`auditedAt` is the time the audit was **computed**. On a cache hit it stays at the original value while
`cache.ageMs` grows — that pairing is how a client tells fresh data from cached.

### GET /v1/audit

Identical semantics, with the parameters in the query string. Useful for browsers and shareable links.

```
GET /v1/audit?url=https%3A%2F%2Fexample.com&refresh=true
```

`refresh` accepts `true`, `false`, `1` and `0`.

### GET /healthz

Liveness. Never rate limited, never touches the network.

```json
{ "status": "ok", "uptimeSeconds": 3421 }
```

### GET /readyz

Runtime statistics and the effective configuration — useful for confirming what a deployment is actually
running with.

```jsonc
{
  "status": "ok",
  "version": "1.0.0",
  "uptimeSeconds": 3421,
  "cache": {
    "size": 42,
    "maxEntries": 500,
    "ttlMs": 300000,
    "hits": 310,
    "misses": 88,
    "evictions": 0,
    "expirations": 46,
  },
  "concurrency": {
    "active": 2,
    "queued": 0,
    "maxConcurrent": 8,
    "maxQueued": 32,
    "rejected": 0,
    "timedOut": 0,
  },
  "rateLimit": { "trackedClients": 17, "windowMs": 60000, "max": 30 },
  "config": {
    "cacheTtlMs": 300000,
    "fetchTimeoutMs": 8000,
    "auditTimeoutMs": 12000,
    "maxConcurrentAudits": 8,
    "rateLimitMax": 30,
    "rateLimitWindowMs": 60000,
  },
}
```

### Error responses

Every error — validation, upstream, rate limit, internal — uses one envelope:

```jsonc
{
  "error": {
    "code": "VALIDATION_ERROR", // stable; switch on this
    "message": "Request validation failed",
    "details": [
      // present when there is field-level detail
      { "field": "url", "message": "url is required" },
    ],
    "retryable": false, // whether retrying the same request could succeed
    "requestId": "8f14e45f-ceea-467a-9575-3f0d4a1b2c3d",
  },
}
```

| Code                       | HTTP | Retryable | Meaning                                                                 |
| -------------------------- | ---- | --------- | ----------------------------------------------------------------------- |
| `VALIDATION_ERROR`         | 400  | no        | Missing, malformed or oversized input, or an unparseable body           |
| `BLOCKED_URL`              | 403  | no        | Non-http(s) scheme, embedded credentials, or a private/internal address |
| `NOT_FOUND`                | 404  | no        | No such route                                                           |
| `UNSUPPORTED_CONTENT_TYPE` | 415  | no        | The target returned something other than an HTML-like document          |
| `RATE_LIMITED`             | 429  | yes       | Client exceeded its rate limit; see `Retry-After`                       |
| `UPSTREAM_UNREACHABLE`     | 502  | yes       | DNS failure, connection refused, or an invalid redirect                 |
| `TOO_MANY_REDIRECTS`       | 502  | no        | Redirect chain exceeded `MAX_REDIRECTS`                                 |
| `RESPONSE_TOO_LARGE`       | 502  | no        | Body exceeded `MAX_BODY_BYTES`                                          |
| `SERVICE_OVERLOADED`       | 503  | yes       | Concurrency queue full or the wait timed out; see `Retry-After`         |
| `UPSTREAM_TIMEOUT`         | 504  | yes       | The target did not respond within the time budget                       |
| `INTERNAL_ERROR`           | 500  | no        | Unexpected failure; details are in the logs under `requestId`           |

A page that returns 4xx or 5xx is **not** an error — it is audited normally and the `fetch.status` check
fails. Errors are reserved for cases where no audit could be produced.

### Response headers

| Header                | On                  | Meaning                                                                       |
| --------------------- | ------------------- | ----------------------------------------------------------------------------- |
| `X-Request-Id`        | all                 | Request ID. Echoes an inbound `X-Request-Id` if supplied, otherwise generated |
| `X-Cache`             | audits              | `HIT`, `MISS`, or `BYPASS` when `refresh` was set                             |
| `Age`                 | cache hits          | Age of the cached audit, in seconds                                           |
| `RateLimit-Limit`     | rate-limited routes | Requests allowed per window                                                   |
| `RateLimit-Remaining` | rate-limited routes | Requests left in the current window                                           |
| `RateLimit-Reset`     | rate-limited routes | Seconds until the window rolls over                                           |
| `Retry-After`         | 429, 503            | Seconds to wait before retrying                                               |

---

## What gets checked

25 checks across five categories for a typical HTTPS page. Two are conditional: HSTS is only assessed on an
HTTPS origin, since browsers ignore the header over HTTP, and the redirect-chain check only appears when
there were redirects. Each check carries a weight of 1-3; the score is the weighted proportion of credit
earned, where a pass is full credit and a warning is half.

**Security** — HTTPS, HSTS (including whether `max-age` is long enough to matter), Content-Security-Policy
(a policy allowing `unsafe-inline`/`unsafe-eval` warns rather than passes), `X-Content-Type-Options`,
clickjacking protection (`X-Frame-Options` _or_ a CSP `frame-ancestors` directive), `Referrer-Policy`,
`Permissions-Policy`, and server/framework version disclosure.

**SEO** — HTTP status, title presence and length, meta description presence and length, exactly one `H1`,
canonical URL, `noindex` detection, and content volume.

**Metadata** — Open Graph (`og:title`, `og:description`, `og:image`), Twitter card, JSON-LD structured data
(including `@graph`), mobile viewport, and declared character encoding.

**Accessibility** — image `alt` coverage (an explicit `alt=""` is correct for decorative images and is not
counted as missing) and a document `lang` attribute.

**Performance** — response compression, redirect chain length, HTML document size, and response time.

Response time is measured from this server's network location, so it reflects the origin's latency to the
deployment region rather than to any particular user.

---

## Configuration

Everything is environment-driven, validated once at boot, and a bad value stops the process rather than
surfacing later as strange behaviour. See [`.env.example`](.env.example).

| Variable                  | Default                 | Purpose                                                                               |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `PORT`                    | `3000`                  | Listen port                                                                           |
| `HOST`                    | `0.0.0.0`               | Bind address                                                                          |
| `LOG_LEVEL`               | `info`                  | `fatal`…`trace`, or `silent`                                                          |
| `TRUST_PROXY`             | `false`                 | Proxy hops to trust in `X-Forwarded-For`. Use `1` behind one load balancer. See below |
| `CACHE_TTL_MS`            | `300000`                | **Cache window.** `0` disables caching                                                |
| `CACHE_MAX_ENTRIES`       | `500`                   | Cache size cap; LRU eviction beyond it                                                |
| `FETCH_TIMEOUT_MS`        | `8000`                  | Budget for the outbound fetch, covering all redirects and the body read               |
| `AUDIT_TIMEOUT_MS`        | `12000`                 | Budget for the whole audit. Must be >= `FETCH_TIMEOUT_MS`                             |
| `MAX_REDIRECTS`           | `5`                     | Redirect hop limit                                                                    |
| `MAX_BODY_BYTES`          | `2000000`               | Largest response body accepted                                                        |
| `MAX_CONCURRENT_AUDITS`   | `8`                     | Outbound audits running at once                                                       |
| `MAX_QUEUED_AUDITS`       | `32`                    | Requests allowed to wait for a slot before shedding load                              |
| `QUEUE_TIMEOUT_MS`        | `5000`                  | How long a request may wait in that queue                                             |
| `RATE_LIMIT_WINDOW_MS`    | `60000`                 | Rate limit window                                                                     |
| `RATE_LIMIT_MAX`          | `30`                    | Requests per window per client                                                        |
| `USER_AGENT`              | `url-audit-service/1.0` | Sent on outbound requests                                                             |
| `ALLOW_PRIVATE_ADDRESSES` | `false`                 | **Dangerous.** Permits auditing private addresses. Test fixtures only                 |

---

## How it behaves under load

**Caching.** A completed audit is cached under a normalised URL key for `CACHE_TTL_MS`. Repeat audits inside
that window are served without refetching, which the tests assert against the origin's request count rather
than by trusting a header. Host casing, default ports and fragments are normalised so trivially different
spellings share one entry; path and query stay significant because they change what is served. The cache is
bounded and evicts least-recently-used entries, so memory cannot grow with unique URLs. Failed audits are
never cached. `refresh: true` bypasses and replaces the entry.

**Stampede protection.** A cache only helps once a result exists. Concurrent requests for the same cold URL
are collapsed into a single origin fetch and share one result — otherwise a burst of traffic for an
uncached URL would arrive at the target site all at once, which is the moment an audit service most looks
like an attacker.

**Concurrency.** `MAX_CONCURRENT_AUDITS` bounds outbound fetches. Beyond that, requests queue; beyond
`MAX_QUEUED_AUDITS` they get an immediate `503` with `Retry-After` rather than joining an unbounded queue.
A request that waits longer than `QUEUE_TIMEOUT_MS` also gets a `503`. Under overload a fast, honest refusal
beats a request that occupies a socket for a minute and times out anyway.

**Timeouts.** Three nested budgets: the fetch (one wall-clock deadline covering every redirect hop and the
body read), the audit as a whole, and the queue wait. Nothing can hang indefinitely.

**Rate limiting.** Per client, keyed by `X-API-Key` when present and by client IP otherwise. It is enforced
in an `onRequest` hook — before validation and before any outbound work — so an over-limit client costs
almost nothing to reject. The window is a sliding counter, which avoids the fixed-window flaw where a client
spends a full quota just before a boundary and another immediately after, achieving twice the intended rate.
Health probes are exempt so a platform's checks can never be throttled.

Behind a proxy, `TRUST_PROXY` must be a **hop count**, not `true`. Trusting the whole `X-Forwarded-For`
chain is a rate-limit bypass: the client sends its own `X-Forwarded-For`, the platform proxy appends the
address it observed, and the leftmost entry — the one the app would treat as the client — is attacker
controlled, so rotating that header buys an unlimited budget. This was caught by probing the live
deployment, not in review. With a hop count the address the trusted proxy actually observed is used and
anything the client prepended is ignored: `1` for Render, Fly, Railway or a single nginx, and the default
`false` when the process is directly exposed.

**Logging.** One JSON object per line via pino, at `info`: `audit.start`, `audit.complete`,
`audit.cache_hit`, `rate_limit.exceeded`, `request.complete`, plus lifecycle events. Every line carries
`reqId`, so one user-reported failure maps to exactly one trace. An inbound `X-Request-Id` is honoured so
traces survive across services. `authorization`, `cookie` and `x-api-key` are redacted.

**Shutdown.** `SIGTERM`/`SIGINT` stop new connections, let in-flight requests finish, then exit — with a
10-second cap before forcing exit.

---

## Security

The service fetches URLs chosen by untrusted callers, which makes SSRF the central risk: without protection,
`http://169.254.169.254/` would hand back cloud credentials and `http://10.0.0.5:6379/` would reach internal
services.

- Only `http`/`https`. Credentials in URLs are rejected.
- Hostnames are resolved and every returned address is checked. Loopback, private, link-local (which covers
  the cloud metadata endpoint), unique-local, carrier-grade NAT, multicast and reserved ranges are all
  refused, for IPv4 and IPv6. If a hostname resolves to _any_ non-public address it is rejected outright, so
  a split-horizon DNS record cannot smuggle a request onto an internal address.
- Redirects are followed **manually**, and every hop is re-validated. `redirect: "follow"` would let a
  public URL redirect to `169.254.169.254` unchecked.
- Response bodies are streamed with a size cap and aborted the moment they exceed it; an oversized
  `Content-Length` is refused without downloading anything.
- Request bodies are capped at 16 KB — the only accepted payload is a URL.
- Errors never leak internals: unrecognised exceptions become a generic `INTERNAL_ERROR`, with the detail
  kept in the logs under the request ID.

`ALLOW_PRIVATE_ADDRESSES` disables the address check and exists solely so the test suite can audit a fixture
server on `127.0.0.1`. CI asserts that the shipped container refuses the metadata endpoint by default.

---

## Testing

```bash
npm test
npm run test:coverage
```

187 tests. The integration tests run the real application — real routes, hooks, error handling and network
path — against a fixture origin server on loopback. `fetch` is not mocked, so timeouts, redirect chains,
chunked bodies and size limits are exercised for real.

- **Unit** — cache TTL/LRU/stats, sliding-window rate limiting (including the boundary-burst case),
  semaphore concurrency and load shedding, SSRF classification across IPv4/IPv6 ranges, URL normalisation
  and cache keying, metadata extraction (including malformed markup and JSON-LD), every check's verdict, and
  score/grade calculation.
- **Integration** — the full response contract, validation failures, redirect following and limits,
  415/504/502 upstream handling, SSRF blocking end to end, cache hit/miss/expiry/bypass/eviction, stampede
  collapsing, rate limiting per API key and per IP, and concurrency load shedding.

Time-dependent components take an injectable clock, so TTL and rate-limit window behaviour is tested
deterministically rather than with sleeps.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every push and pull request: lint,
typecheck, tests with coverage on Node 22 and 24, a build, and a smoke test that boots the compiled output
and the container image and checks that SSRF protection is active by default.

---

## Deploying

The repository includes a [`render.yaml`](render.yaml) blueprint.

1. Push this repository to GitHub.
2. At [dashboard.render.com/blueprints](https://dashboard.render.com/blueprints), choose **New Blueprint
   Instance** and select the repository. Render reads `render.yaml`; no dashboard configuration is needed.
3. Deploy. The health check at `/healthz` gates the rollout, and `autoDeploy` ships subsequent pushes to
   `main`.

Note that Render's free tier sleeps after inactivity, so the first request after an idle period takes a few
seconds while the instance wakes.

A [`Dockerfile`](Dockerfile) is included for anywhere else: multi-stage, dev dependencies dropped from the
runtime image, non-root user, and a health check.

```bash
docker build -t url-audit-service .
docker run -p 3000:3000 url-audit-service
```

---

## Design notes

**Why no headless browser.** Real performance metrics need real Chrome, which means slow audits, a large
image and a host that can run it. Everything checked here is derivable from one HTTP response, which keeps
an audit fast and the service cheap to run. Lighthouse-style metrics would be a separate, queued service.

**Why an in-process cache.** One dependency-free instance. The `TtlCache` interface is narrow on purpose, so
a Redis-backed implementation could be substituted without touching callers when horizontal scaling makes a
shared cache worthwhile — at which point cache hits become shared across instances rather than per-instance.

**Why hand-written rate limiting and concurrency limiting.** Both are small, and owning them makes their
edge cases directly testable — the window-boundary burst, queue timeouts, slot release on failure — rather
than assumed from a plugin's defaults.

**Layering.** `runAudit` fetches and scores, and knows nothing about caching, rate limiting or HTTP. The
route composes those concerns. Services are constructed explicitly and passed in rather than reached for as
module singletons, which is what lets tests boot isolated instances with different configuration in the same
process.

**Weighted scoring.** A missing CSP and a missing Twitter card are not equally serious, so checks carry
weights and warnings earn half credit. Category scores are reported alongside the overall score, since a
site can be strong on SEO and weak on security.

---

## On the use of AI

AI was used deliberately on this project in two roles: broadening the test suite, and pressure-testing my
understanding of the concepts underneath it. Enumerating edge cases is exactly the work where an assistant
earns its keep — cataloguing the ways a hostile origin can misbehave (redirect loops, a redirect carrying no
`Location`, a body that streams past its declared length, a connection held open until the budget expires)
and turning each into a fixture and an assertion is mechanical once the shape is clear, and it is the first
thing to get cut by hand under time pressure. That breadth paid for itself twice, both times by catching
something review would not have: the suite surfaced a word-count bug that only manifests on minified HTML,
where adjacent tags with no whitespace between them were being glued into a single word; and probing the
deployed service turned up a rate-limit bypass, where trusting the entire `X-Forwarded-For` chain let a
client prepend its own address and rotate it for an unlimited budget. The second role was closer to a tutor
than an author — interrogating _why_ a sliding-window counter beats a fixed window at the boundary, why
redirects must be followed manually so every hop is re-checked against the SSRF guard rather than trusting
`redirect: "follow"`, and why a cache needs single-flight protection or a burst of traffic for one cold URL
arrives at the target site all at once. I set the scope, made the calls on what the service should and
should not do, and verified every claim against the running deployment rather than taking it on trust; AI
made it feasible to cover the edges properly and to understand each decision well enough to defend it.
