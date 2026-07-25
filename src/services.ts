import type { AuditResult } from "./audit/index.js";
import type { Config } from "./config.js";
import { TtlCache } from "./lib/cache.js";
import { InFlightRegistry } from "./lib/in-flight.js";
import { RateLimiter } from "./lib/rate-limit.js";
import { Semaphore } from "./lib/semaphore.js";

/**
 * The stateful pieces of the service, constructed once per process and passed
 * explicitly to the routes. Explicit construction keeps tests from having to
 * reach into module singletons.
 */
export interface Services {
  config: Config;
  cache: TtlCache<AuditResult>;
  rateLimiter: RateLimiter;
  semaphore: Semaphore;
  inFlight: InFlightRegistry<AuditResult>;
  /** Stops background maintenance timers. */
  close: () => void;
}

/** How often expired cache entries and idle rate-limit clients are swept. */
const MAINTENANCE_INTERVAL_MS = 60_000;

export function createServices(config: Config): Services {
  const cache = new TtlCache<AuditResult>({
    ttlMs: config.CACHE_TTL_MS,
    maxEntries: config.CACHE_MAX_ENTRIES,
  });

  const rateLimiter = new RateLimiter({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX,
  });

  const semaphore = new Semaphore({
    maxConcurrent: config.MAX_CONCURRENT_AUDITS,
    maxQueued: config.MAX_QUEUED_AUDITS,
    queueTimeoutMs: config.QUEUE_TIMEOUT_MS,
  });

  // Both structures evict lazily on read; this sweep reclaims memory held by
  // keys that are never read again.
  const maintenance = setInterval(() => {
    cache.prune();
    rateLimiter.prune();
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref();

  return {
    config,
    cache,
    rateLimiter,
    semaphore,
    inFlight: new InFlightRegistry<AuditResult>(),
    close: () => clearInterval(maintenance),
  };
}
