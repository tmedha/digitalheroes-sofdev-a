import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.js";
import { Semaphore } from "../../src/lib/semaphore.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("Semaphore", () => {
  it("runs a task and returns its value", async () => {
    const semaphore = new Semaphore({ maxConcurrent: 2, maxQueued: 4, queueTimeoutMs: 1_000 });
    await expect(semaphore.run(async () => "done")).resolves.toBe("done");
    expect(semaphore.stats().active).toBe(0);
  });

  it("never exceeds the configured concurrency", async () => {
    const semaphore = new Semaphore({ maxConcurrent: 3, maxQueued: 100, queueTimeoutMs: 5_000 });
    let active = 0;
    let peak = 0;

    const tasks = Array.from({ length: 30 }, () =>
      semaphore.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }),
    );

    await Promise.all(tasks);
    expect(peak).toBe(3);
    expect(semaphore.stats().active).toBe(0);
  });

  it("queues work beyond the concurrency limit rather than dropping it", async () => {
    const semaphore = new Semaphore({ maxConcurrent: 1, maxQueued: 4, queueTimeoutMs: 5_000 });
    const gate = deferred<void>();
    const order: number[] = [];

    const first = semaphore.run(async () => {
      order.push(1);
      await gate.promise;
    });
    const second = semaphore.run(async () => {
      order.push(2);
    });

    await tick();
    expect(order).toEqual([1]);
    expect(semaphore.stats().queued).toBe(1);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it("sheds load with a retryable 503 once the queue is full", async () => {
    const semaphore = new Semaphore({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 5_000 });
    const gate = deferred<void>();

    const running = semaphore.run(async () => gate.promise);
    const queued = semaphore.run(async () => "queued");
    await tick();

    // One slot is busy and the single queue place is taken.
    const rejected = semaphore.run(async () => "rejected");
    await expect(rejected).rejects.toBeInstanceOf(AppError);
    await expect(rejected).rejects.toMatchObject({
      code: "SERVICE_OVERLOADED",
      statusCode: 503,
      retryable: true,
    });

    gate.resolve();
    await Promise.all([running, queued]);
    expect(semaphore.stats().rejected).toBe(1);
  });

  it("times out a task that waits too long for a slot", async () => {
    const semaphore = new Semaphore({ maxConcurrent: 1, maxQueued: 10, queueTimeoutMs: 30 });
    const gate = deferred<void>();

    const running = semaphore.run(async () => gate.promise);
    const waiting = semaphore.run(async () => "never runs");

    await expect(waiting).rejects.toMatchObject({ code: "SERVICE_OVERLOADED" });
    expect(semaphore.stats().timedOut).toBe(1);

    gate.resolve();
    await running;
  });

  it("releases the slot when a task throws", async () => {
    const semaphore = new Semaphore({ maxConcurrent: 1, maxQueued: 2, queueTimeoutMs: 1_000 });

    await expect(
      semaphore.run(async () => {
        throw new Error("task failed");
      }),
    ).rejects.toThrow("task failed");

    expect(semaphore.stats().active).toBe(0);
    // The slot is genuinely free again, not leaked.
    await expect(semaphore.run(async () => "ok")).resolves.toBe("ok");
  });

  it("does not leave the queue stuck when a queued task rejects", async () => {
    const semaphore = new Semaphore({ maxConcurrent: 1, maxQueued: 5, queueTimeoutMs: 1_000 });
    const gate = deferred<void>();

    const first = semaphore.run(async () => gate.promise);
    const failing = semaphore.run(async () => {
      throw new Error("queued task failed");
    });
    const after = semaphore.run(async () => "ran after failure");

    gate.resolve();
    await first;
    await expect(failing).rejects.toThrow("queued task failed");
    await expect(after).resolves.toBe("ran after failure");
    expect(semaphore.stats().active).toBe(0);
  });
});
