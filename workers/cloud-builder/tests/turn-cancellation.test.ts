import { describe, expect, test } from "bun:test";
import {
  createTurnRetryCancellation,
  startTurnExecution,
} from "../src/turn-cancellation.js";

describe("Effect-owned cloud turn retry cancellation", () => {
  test("completes an ordinary fiber-backed retry delay", async () => {
    const cancellation = createTurnRetryCancellation();
    await cancellation.sleep(1);
    expect(cancellation.aborted).toBe(false);
  });

  test("wakes a retry delay with the original cancellation reason", async () => {
    const cancellation = createTurnRetryCancellation();
    const reason = new Error("exact turn canceled");
    const sleeping = cancellation.sleep(60_000);
    cancellation.abort(reason);
    await expect(sleeping).rejects.toBe(reason);
    expect(cancellation.aborted).toBe(true);
    expect(cancellation.reason).toBe(reason);
  });

  test("is idempotent and retains the first cancellation identity", async () => {
    const cancellation = createTurnRetryCancellation();
    const first = new Error("first cancel");
    cancellation.abort(first);
    cancellation.abort(new Error("late replacement"));
    expect(cancellation.aborted).toBe(true);
    expect(cancellation.reason).toBe(first);
    await expect(cancellation.sleep(1)).rejects.toBe(first);
  });

  test("does not acknowledge interruption until promise-native work has unwound", async () => {
    let releaseWork!: () => void;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    let observeStart!: () => void;
    const started = new Promise<void>((resolve) => {
      observeStart = resolve;
    });
    let finalized = false;
    let admittedAfterStop = false;
    let cleanupCalls = 0;
    const execution = startTurnExecution({
      work: async ({ assertActive }) => {
        observeStart();
        try {
          await workGate;
          assertActive();
          admittedAfterStop = true;
        } finally {
          finalized = true;
        }
      },
      onInterrupt: () => {
        cleanupCalls += 1;
        releaseWork();
      },
      cleanupTimeoutMs: 1_000,
    });

    await started;
    await execution.interrupt(new Error("stop"));

    expect(finalized).toBe(true);
    expect(admittedAfterStop).toBe(false);
    expect(cleanupCalls).toBe(1);
    await execution.join();
  });

  test("exposes the same abort signal used by turn-scoped platform I/O", async () => {
    let observedSignal: AbortSignal | undefined;
    let observeStart!: () => void;
    const started = new Promise<void>((resolve) => {
      observeStart = resolve;
    });
    const execution = startTurnExecution({
      work: async ({ signal }) => {
        observedSignal = signal;
        observeStart();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
      cleanupTimeoutMs: 1_000,
    });
    await started;
    expect(execution.signal).toBe(observedSignal);
    expect(execution.signal.aborted).toBe(false);

    const reason = new Error("stop broker I/O");
    await execution.interrupt(reason);
    expect(execution.signal.aborted).toBe(true);
    expect(execution.signal.reason).toBeInstanceOf(DOMException);
    expect(execution.cancellation.reason).toBe(reason);
  });

  test("a replayed Stop join waits for the same promise-native unwind", async () => {
    let releaseWork!: () => void;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    let observeStart!: () => void;
    const started = new Promise<void>((resolve) => {
      observeStart = resolve;
    });
    const execution = startTurnExecution({
      work: async () => {
        observeStart();
        await workGate;
      },
      cleanupTimeoutMs: 1_000,
    });

    await started;
    const firstStop = execution.interrupt(new Error("stop"));
    let replayJoined = false;
    const replay = execution.join().then(() => {
      replayJoined = true;
    });
    await Promise.resolve();
    expect(replayJoined).toBe(false);

    releaseWork();
    await Promise.all([firstStop, replay]);
    expect(replayJoined).toBe(true);
  });

  test("runs a final resource sweep after a late create settles", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let observeCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      observeCreate = resolve;
    });
    let resourceLive = false;
    let immediateSweeps = 0;
    let finalSweeps = 0;
    let observeImmediateSweep!: () => void;
    const immediateSweepStarted = new Promise<void>((resolve) => {
      observeImmediateSweep = resolve;
    });
    const execution = startTurnExecution({
      work: async ({ assertActive }) => {
        observeCreate();
        await createGate;
        // Models a platform createSession() that ignored cancellation and
        // materialized its resource after the first destroy call.
        resourceLive = true;
        assertActive();
      },
      onInterrupt: () => {
        immediateSweeps += 1;
        resourceLive = false;
        observeImmediateSweep();
      },
      afterInterrupt: () => {
        finalSweeps += 1;
        resourceLive = false;
      },
      cleanupTimeoutMs: 1_000,
    });

    await createStarted;
    const stopped = execution.interrupt(new Error("stop"));
    await immediateSweepStarted;
    expect(immediateSweeps).toBe(1);
    releaseCreate();
    await stopped;

    expect(finalSweeps).toBe(1);
    expect(resourceLive).toBe(false);
  });

  test("fails Stop visibly when underlying cleanup cannot be confirmed", async () => {
    let releaseWork!: () => void;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    let observeStart!: () => void;
    const started = new Promise<void>((resolve) => {
      observeStart = resolve;
    });
    const execution = startTurnExecution({
      work: async ({ assertActive }) => {
        observeStart();
        await workGate;
        assertActive();
      },
      cleanupTimeoutMs: 5,
    });

    await started;
    await expect(execution.interrupt(new Error("stop"))).rejects.toBeDefined();
    releaseWork();
    await execution.settled.catch(() => undefined);
  });
});
