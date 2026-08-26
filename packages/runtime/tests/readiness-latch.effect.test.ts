import { describe, expect, it } from "vitest";

import { createReadinessLatch } from "../kernel/shared/readiness-latch.js";

/**
 * Boot-readiness latch (phase 3 batch 5): waiters wake on open() instead of
 * polling, the wait bound never leaks a timer, and reset() re-arms the
 * latch for a restarted runner.
 */

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("readiness latch", () => {
  it("wakes parked waiters the moment the latch opens", async () => {
    const latch = createReadinessLatch();
    expect(latch.isOpen()).toBe(false);

    let outcome: string | null = null;
    void latch.awaitOpen(60_000).then((result) => {
      outcome = result;
    });
    await flush();
    expect(outcome).toBeNull();

    latch.open();
    await flush();
    expect(outcome).toBe("open");
    expect(latch.isOpen()).toBe(true);

    // Already-open fast path.
    await expect(latch.awaitOpen(60_000)).resolves.toBe("open");
  });

  it("resolves 'timeout' at the bound without opening the latch", async () => {
    const latch = createReadinessLatch();
    const startedAt = Date.now();
    await expect(latch.awaitOpen(40)).resolves.toBe("timeout");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
    expect(latch.isOpen()).toBe(false);

    // A later open still wakes fresh (unbounded) waiters.
    const wait = latch.awaitOpen();
    latch.open();
    await expect(wait).resolves.toBe("open");
  });

  it("reset() re-arms a fresh generation for a restarted runner", async () => {
    const latch = createReadinessLatch();
    latch.open();
    expect(latch.isOpen()).toBe(true);

    latch.reset();
    expect(latch.isOpen()).toBe(false);

    let outcome: string | null = null;
    void latch.awaitOpen(60_000).then((result) => {
      outcome = result;
    });
    await flush();
    expect(outcome).toBeNull();
    latch.open();
    await flush();
    expect(outcome).toBe("open");

    // Idempotence: double open / double reset are no-ops.
    latch.open();
    latch.reset();
    latch.reset();
    expect(latch.isOpen()).toBe(false);
  });
});
