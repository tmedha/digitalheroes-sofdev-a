import { z } from "zod";

/**
 * Every knob the service exposes is read from the environment exactly once, at
 * boot, and validated. A bad value fails the process immediately rather than
 * surfacing as a confusing runtime error under load.
 */

const intFromEnv = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw.trim() === "" ? defaultValue : Number(raw)))
    .pipe(z.number().int().min(min).max(max));

const boolFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw.trim() === "") return defaultValue;
      return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
    })
    .pipe(z.boolean());

/**
 * How much of `X-Forwarded-For` to believe. Accepts a hop count, or a boolean.
 *
 * `true` means "trust the whole chain", which is a rate-limiting bypass: a
 * client sends `X-Forwarded-For: 1.2.3.4`, the platform proxy appends the real
 * address, and the leftmost entry the app then treats as the client is the
 * attacker-controlled one. Rotating that header would buy an unlimited budget.
 *
 * A hop count is the safe form. Behind exactly one proxy (Render, Fly, a single
 * nginx) use `1`: the address the trusted proxy actually observed is used, and
 * anything the client prepended is ignored. Use `false` when the process is
 * directly exposed, which is why that is the default.
 */
const trustProxyFromEnv = () =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === "") return false;
      const value = raw.trim().toLowerCase();
      if (["true", "yes", "on"].includes(value)) return true;
      if (["false", "no", "off"].includes(value)) return false;

      const hops = Number(value);
      if (Number.isInteger(hops) && hops >= 0 && hops <= 10) return hops;

      ctx.addIssue({
        code: "custom",
        message: `must be a boolean or a hop count between 0 and 10, received ${JSON.stringify(raw)}`,
      });
      return z.NEVER;
    });

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: intFromEnv(3000, 1, 65535),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** Proxy hops to trust in `X-Forwarded-For`. See `trustProxyFromEnv`. */
  TRUST_PROXY: trustProxyFromEnv(),

  /** How long a successful audit stays servable from cache. Part (b). */
  CACHE_TTL_MS: intFromEnv(5 * 60_000, 0, 24 * 60 * 60_000),
  /** Hard bound on cache size so memory cannot grow with unique URLs. */
  CACHE_MAX_ENTRIES: intFromEnv(500, 1, 100_000),

  /** Wall-clock budget for the whole outbound fetch, redirects included. */
  FETCH_TIMEOUT_MS: intFromEnv(8_000, 100, 60_000),
  /** Budget for an entire audit (fetch + parse + checks). */
  AUDIT_TIMEOUT_MS: intFromEnv(12_000, 100, 120_000),
  MAX_REDIRECTS: intFromEnv(5, 0, 20),
  /** Response bodies larger than this are rejected instead of buffered. */
  MAX_BODY_BYTES: intFromEnv(2_000_000, 1_024, 50_000_000),

  /** Outbound audits allowed to run at once. Part (a). */
  MAX_CONCURRENT_AUDITS: intFromEnv(8, 1, 512),
  /** Requests allowed to wait for a slot before we shed load with a 503. */
  MAX_QUEUED_AUDITS: intFromEnv(32, 0, 10_000),
  /** How long a request may sit in that queue before giving up. */
  QUEUE_TIMEOUT_MS: intFromEnv(5_000, 0, 60_000),

  /** Per-client rate limit. Part (c). */
  RATE_LIMIT_WINDOW_MS: intFromEnv(60_000, 1_000, 60 * 60_000),
  RATE_LIMIT_MAX: intFromEnv(30, 1, 1_000_000),

  /**
   * Off in production: allowing private/loopback targets turns the service into
   * an SSRF proxy into its own network. Tests flip it on to audit a fixture
   * server bound to 127.0.0.1.
   */
  ALLOW_PRIVATE_ADDRESSES: boolFromEnv(false),

  /** Sent as the User-Agent on outbound audit requests. */
  USER_AGENT: z.string().default("url-audit-service/1.0 (+https://github.com/)"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  const config = parsed.data;
  if (config.FETCH_TIMEOUT_MS > config.AUDIT_TIMEOUT_MS) {
    throw new Error(
      `Invalid environment configuration: FETCH_TIMEOUT_MS (${config.FETCH_TIMEOUT_MS}) must not exceed AUDIT_TIMEOUT_MS (${config.AUDIT_TIMEOUT_MS})`,
    );
  }
  return config;
}
