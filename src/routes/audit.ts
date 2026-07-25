import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { runAudit, type AuditResult } from "../audit/index.js";
import { AppError } from "../errors.js";
import { cacheKeyForUrl, parseTargetUrl } from "../lib/ssrf.js";
import type { Services } from "../services.js";

/**
 * Input validation. `url` is length-capped before parsing so a multi-megabyte
 * string cannot reach the URL parser, and `refresh` accepts the string forms a
 * query parameter arrives as.
 */
const auditInputSchema = z.object({
  url: z
    .string({ error: (issue) => (issue.input === undefined ? "url is required" : "url must be a string") })
    .trim()
    .min(1, "url must not be empty")
    .max(2048, "url must be at most 2048 characters"),
  refresh: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .optional()
    .transform((value) => value === true || value === "true" || value === "1"),
});

function validateInput(payload: unknown): { url: string; refresh: boolean } {
  const parsed = auditInputSchema.safeParse(payload ?? {});
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", {
      details: parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || undefined,
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

export interface AuditResponse extends AuditResult {
  cache: {
    hit: boolean;
    /** How long ago the cached audit was computed. 0 on a miss. */
    ageMs: number;
    /** Remaining lifetime of the cache entry. */
    expiresInMs: number;
    ttlMs: number;
  };
  requestId: string;
}

async function handleAudit(
  services: Services,
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<AuditResponse> {
  const { url, refresh } = validateInput(payload);

  // Parse before touching the cache: an invalid or blocked URL must fail the
  // same way whether or not something is cached under a similar key.
  const target = parseTargetUrl(url);
  const key = cacheKeyForUrl(target);
  const { config, cache, semaphore } = services;

  if (!refresh) {
    const cached = cache.get(key);
    if (cached) {
      request.log.info(
        { event: "audit.cache_hit", url: key, ageMs: cached.ageMs },
        "served audit from cache",
      );
      reply.header("x-cache", "HIT");
      reply.header("age", Math.floor(cached.ageMs / 1000).toString());
      return {
        ...cached.value,
        cache: {
          hit: true,
          ageMs: cached.ageMs,
          expiresInMs: cached.expiresInMs,
          ttlMs: cache.ttlMs,
        },
        requestId: request.id,
      };
    }
  }

  reply.header("x-cache", refresh ? "BYPASS" : "MISS");

  const result = await services.inFlight.run(key, async () =>
    semaphore.run(async () => {
      const startedAt = Date.now();
      request.log.info({ event: "audit.start", url: key }, "starting audit");

      // Belt and braces: the fetcher enforces its own budget, but a slow parse
      // of a pathological document must not outlive the request either.
      const audit = await withTimeout(
        runAudit(target.toString(), {
          timeoutMs: config.FETCH_TIMEOUT_MS,
          maxRedirects: config.MAX_REDIRECTS,
          maxBodyBytes: config.MAX_BODY_BYTES,
          allowPrivateAddresses: config.ALLOW_PRIVATE_ADDRESSES,
          userAgent: config.USER_AGENT,
        }),
        config.AUDIT_TIMEOUT_MS,
      );

      request.log.info(
        {
          event: "audit.complete",
          url: key,
          finalUrl: audit.url.final,
          status: audit.fetch.status,
          score: audit.summary.score,
          durationMs: Date.now() - startedAt,
        },
        "audit complete",
      );

      cache.set(key, audit);
      return audit;
    }),
  );

  return {
    ...result,
    cache: { hit: false, ageMs: 0, expiresInMs: cache.ttlMs, ttlMs: cache.ttlMs },
    requestId: request.id,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AppError("UPSTREAM_TIMEOUT", `Audit exceeded the ${timeoutMs}ms time budget`, {
          retryable: true,
        }),
      );
    }, timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function registerAuditRoutes(app: FastifyInstance, services: Services): void {
  // POST is the primary contract; GET exists so an audit is shareable as a
  // link and reachable from a browser address bar.
  app.post("/v1/audit", async (request, reply) => handleAudit(services, request, reply, request.body));

  app.get("/v1/audit", async (request, reply) => handleAudit(services, request, reply, request.query));
}
