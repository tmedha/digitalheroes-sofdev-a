/**
 * Per-client rate limiting. Part (c).
 *
 * Sliding-window counter: each client keeps the count for the current window
 * and the previous one, and the previous count is weighted by how far into the
 * current window we are. That costs two integers per client but avoids the
 * fixed-window edge case where a client can spend its full quota at the end of
 * one window and again at the start of the next, doubling the intended rate.
 */

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Injectable clock; tests advance time without sleeping. */
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  /** Requests left in the current window, floored at 0. */
  remaining: number;
  /** ms until the window rolls over. */
  resetMs: number;
  /** Present only when `allowed` is false. */
  retryAfterSeconds?: number;
}

interface ClientState {
  windowStart: number;
  currentCount: number;
  previousCount: number;
}

export class RateLimiter {
  private readonly clients = new Map<string, ClientState>();
  private readonly now: () => number;

  readonly windowMs: number;
  readonly max: number;

  constructor(options: RateLimitOptions) {
    this.windowMs = options.windowMs;
    this.max = options.max;
    this.now = options.now ?? Date.now;
  }

  check(clientKey: string): RateLimitResult {
    const now = this.now();
    const state = this.clients.get(clientKey) ?? {
      windowStart: now,
      currentCount: 0,
      previousCount: 0,
    };

    const elapsed = now - state.windowStart;
    if (elapsed >= this.windowMs * 2) {
      // Idle for two full windows: nothing worth carrying forward.
      state.windowStart = now;
      state.currentCount = 0;
      state.previousCount = 0;
    } else if (elapsed >= this.windowMs) {
      state.windowStart = state.windowStart + this.windowMs;
      state.previousCount = state.currentCount;
      state.currentCount = 0;
    }

    const positionInWindow = (now - state.windowStart) / this.windowMs;
    const weighted = state.previousCount * (1 - positionInWindow) + state.currentCount;
    const resetMs = Math.max(0, state.windowStart + this.windowMs - now);

    if (weighted >= this.max) {
      this.clients.set(clientKey, state);
      return {
        allowed: false,
        limit: this.max,
        remaining: 0,
        resetMs,
        retryAfterSeconds: Math.max(1, Math.ceil(resetMs / 1000)),
      };
    }

    state.currentCount += 1;
    this.clients.set(clientKey, state);

    return {
      allowed: true,
      limit: this.max,
      remaining: Math.max(0, Math.floor(this.max - weighted - 1)),
      resetMs,
    };
  }

  /** Drops clients idle for two windows, so the map cannot grow unbounded. */
  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, state] of this.clients) {
      if (now - state.windowStart >= this.windowMs * 2) {
        this.clients.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  reset(clientKey?: string): void {
    if (clientKey === undefined) this.clients.clear();
    else this.clients.delete(clientKey);
  }

  stats(): { trackedClients: number; windowMs: number; max: number } {
    return { trackedClients: this.clients.size, windowMs: this.windowMs, max: this.max };
  }
}
