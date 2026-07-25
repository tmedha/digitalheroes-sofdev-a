import { AppError } from "../errors.js";

/**
 * Counting semaphore with a bounded wait queue. Part (a)'s concurrency limit.
 *
 * Two separate protections:
 *  - `maxConcurrent` caps outbound fetches, so a burst of traffic cannot open
 *    hundreds of sockets and exhaust file descriptors or upstream goodwill.
 *  - `maxQueued` + `queueTimeoutMs` shed load instead of queueing without
 *    bound. Under overload a fast 503 is more useful than a request that sits
 *    for a minute and then times out anyway.
 */

export interface SemaphoreOptions {
  maxConcurrent: number;
  maxQueued: number;
  queueTimeoutMs: number;
}

export interface SemaphoreStats {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
  rejected: number;
  timedOut: number;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
  settled: boolean;
}

export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private rejected = 0;
  private timedOut = 0;

  constructor(private readonly options: SemaphoreOptions) {}

  private acquire(): Promise<void> {
    if (this.active < this.options.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }

    if (this.waiters.length >= this.options.maxQueued) {
      this.rejected += 1;
      return Promise.reject(
        new AppError("SERVICE_OVERLOADED", "Service is at capacity, please retry shortly", {
          retryable: true,
          headers: { "retry-after": "1" },
        }),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: undefined, settled: false };

      if (this.options.queueTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          this.timedOut += 1;
          reject(
            new AppError("SERVICE_OVERLOADED", "Timed out waiting for an available audit slot", {
              retryable: true,
              headers: { "retry-after": "2" },
            }),
          );
        }, this.options.queueTimeoutMs);
        waiter.timer.unref();
      }

      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (!next) {
      this.active -= 1;
      return;
    }
    // Hand the slot straight to the waiter; `active` stays as-is.
    next.settled = true;
    if (next.timer) clearTimeout(next.timer);
    next.resolve();
  }

  /** Runs `task` while holding a slot, releasing it however the task ends. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  stats(): SemaphoreStats {
    return {
      active: this.active,
      queued: this.waiters.length,
      maxConcurrent: this.options.maxConcurrent,
      maxQueued: this.options.maxQueued,
      rejected: this.rejected,
      timedOut: this.timedOut,
    };
  }
}
