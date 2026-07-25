import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { loadConfig, type Config } from "./config.js";
import { AppError, isAppError, toErrorResponse } from "./errors.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { LANDING_PAGE } from "./routes/landing.js";
import { createServices, type Services } from "./services.js";

export interface BuildServerOptions {
  config?: Config;
  services?: Services;
}

/** Requests exempt from rate limiting so platform health probes never 429. */
const RATE_LIMIT_EXEMPT = new Set(["/healthz", "/readyz", "/"]);

/**
 * Identifies the caller for rate-limiting purposes. An API key is preferred
 * when present because it survives NAT and proxies; otherwise we fall back to
 * the peer address, which Fastify derives from X-Forwarded-For when
 * `trustProxy` is on.
 */
function clientKeyFor(request: { headers: Record<string, unknown>; ip: string }): string {
  const apiKey = request.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim() !== "") return `key:${apiKey.trim()}`;
  return `ip:${request.ip}`;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const services = options.services ?? createServices(config);

  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    // Body limit is small on purpose: the only accepted payload is a URL.
    bodyLimit: 16 * 1024,
    // Fastify's built-in per-request logging is replaced by the single
    // structured access-log line emitted in the onResponse hook below.
    logController: new LogController({ disableRequestLogging: true }),
    // Honour an inbound request ID so a trace survives across services;
    // otherwise mint one. Either way it is echoed in logs and responses.
    genReqId: (request) => {
      const header = request.headers["x-request-id"];
      if (typeof header === "string" && header.trim() !== "") return header.trim().slice(0, 128);
      return randomUUID();
    },
    logger: {
      level: config.LOG_LEVEL,
      // Structured JSON on one line per event: greppable, and parseable by
      // every log platform without a custom pattern.
      formatters: {
        level: (label) => ({ level: label }),
      },
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-api-key']"],
        censor: "[redacted]",
      },
      serializers: {
        req: (request) => ({
          method: request.method,
          url: request.url,
          ip: request.ip,
        }),
        res: (reply) => ({ statusCode: reply.statusCode }),
      },
    },
  });

  app.decorate("services", services);

  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    // Lets a browser client read the request ID it should quote in a bug report.
    exposedHeaders: ["x-request-id", "x-cache", "retry-after", "ratelimit-remaining", "ratelimit-reset"],
  });

  // Every response carries its request ID, so a user-reported failure can be
  // traced to exactly one log line.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  // Rate limiting runs before validation and before any outbound work, so a
  // client that is over its budget costs us almost nothing. Part (c).
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || RATE_LIMIT_EXEMPT.has(request.url.split("?")[0] ?? "")) {
      return;
    }

    const clientKey = clientKeyFor(request);
    const result = services.rateLimiter.check(clientKey);

    reply.header("ratelimit-limit", result.limit.toString());
    reply.header("ratelimit-remaining", result.remaining.toString());
    reply.header("ratelimit-reset", Math.ceil(result.resetMs / 1000).toString());

    if (!result.allowed) {
      request.log.warn(
        { event: "rate_limit.exceeded", clientKey, limit: result.limit },
        "rate limit exceeded",
      );
      throw new AppError("RATE_LIMITED", "Rate limit exceeded, please slow down", {
        retryable: true,
        headers: { "retry-after": String(result.retryAfterSeconds ?? 1) },
        details: [
          {
            message: `A maximum of ${result.limit} requests per ${Math.round(
              services.rateLimiter.windowMs / 1000,
            )}s is allowed per client.`,
          },
        ],
      });
    }
  });

  // One access-log line per completed request, with the fields you actually
  // filter on during an incident.
  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        event: "request.complete",
        method: request.method,
        path: request.url,
        statusCode: reply.statusCode,
        durationMs: Number(reply.elapsedTime.toFixed(1)),
        cache: reply.getHeader("x-cache") ?? undefined,
      },
      "request complete",
    );
  });

  // Single funnel for every error, so clients only ever see the documented
  // envelope and internals are never leaked. Part (a).
  app.setErrorHandler((error, request, reply) => {
    const appError = normaliseError(error);

    if (appError.statusCode >= 500) {
      request.log.error({ event: "request.failed", code: appError.code, err: error }, appError.message);
    } else {
      request.log.warn(
        { event: "request.rejected", code: appError.code, reason: appError.message },
        "request rejected",
      );
    }

    for (const [name, value] of Object.entries(appError.headers ?? {})) {
      reply.header(name, value);
    }

    void reply.status(appError.statusCode).send(toErrorResponse(appError, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new AppError("NOT_FOUND", `Route ${request.method} ${request.url} does not exist`);
    void reply.status(error.statusCode).send(toErrorResponse(error, request.id));
  });

  app.get("/healthz", async () => ({ status: "ok", uptimeSeconds: Math.round(process.uptime()) }));

  app.get("/readyz", async () => ({
    status: "ok",
    version: process.env["npm_package_version"] ?? "1.0.0",
    uptimeSeconds: Math.round(process.uptime()),
    cache: services.cache.stats(),
    concurrency: services.semaphore.stats(),
    rateLimit: services.rateLimiter.stats(),
    config: {
      cacheTtlMs: config.CACHE_TTL_MS,
      fetchTimeoutMs: config.FETCH_TIMEOUT_MS,
      auditTimeoutMs: config.AUDIT_TIMEOUT_MS,
      maxConcurrentAudits: config.MAX_CONCURRENT_AUDITS,
      rateLimitMax: config.RATE_LIMIT_MAX,
      rateLimitWindowMs: config.RATE_LIMIT_WINDOW_MS,
    },
  }));

  app.get("/", async (_request, reply) => {
    void reply.type("text/html; charset=utf-8");
    return LANDING_PAGE;
  });

  registerAuditRoutes(app, services);

  return app;
}

/** Maps anything thrown anywhere in the stack onto the error vocabulary. */
function normaliseError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error && typeof error === "object" && "statusCode" in error) {
    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    const status = fastifyError.statusCode ?? 500;

    if (fastifyError.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return new AppError("VALIDATION_ERROR", "Content-Type must be application/json");
    }
    if (
      fastifyError.code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
      fastifyError.code === "FST_ERR_CTP_INVALID_JSON_BODY"
    ) {
      return new AppError("VALIDATION_ERROR", "Request body must be valid JSON");
    }
    if (status === 413) {
      return new AppError("VALIDATION_ERROR", "Request body is too large");
    }
    if (status >= 400 && status < 500) {
      return new AppError("VALIDATION_ERROR", fastifyError.message ?? "Invalid request");
    }
  }

  // Nothing recognisable: report a generic failure and keep the detail in the
  // logs, where the request ID ties it back to the caller's response.
  return new AppError("INTERNAL_ERROR", "An unexpected error occurred", { cause: error });
}

declare module "fastify" {
  interface FastifyInstance {
    services: Services;
  }
}
