import { describe, expect, it, vi } from "vitest";
import {
  createRunCoordinator,
  ensureRunCoordinator,
  type RunCoordinatorHost,
} from "@stella/runtime/kernel/runner/run-coordinator";
import { executeOrQueueUserOrchestratorTurn } from "@stella/runtime/kernel/runner/orchestrator-dispatch";
import type { QueuedOrchestratorTurn } from "@stella/runtime/kernel/runner/types";

const flushMicrotasks = async (rounds = 6) => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
};

const createHost = (): RunCoordinatorHost => ({
  state: {
    activeOrchestratorRunId: null,
    activeOrchestratorConversationId: null,
    activeOrchestratorUiVisibility: "visible",
    activeOrchestratorSession: null,
    queuedOrchestratorTurns: [] as QueuedOrchestratorTurn[],
    runCoordinator: null,
  },
});

const gate = () => {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
};

describe("createRunCoordinator", () => {
  it("wakes and drains a queued turn from an idle lane (queued-message wakeup)", async () => {
    const host = createHost();
    const coordinator = createRunCoordinator(host);
    const turn = vi.fn(async () => {});

    coordinator.enqueueTurn({ priority: "user", execute: turn });
    await flushMicrotasks();

    expect(turn).toHaveBeenCalledOnce();
    expect(coordinator.pendingTurnCount()).toBe(0);
    expect(coordinator.isDraining()).toBe(false);
  });

  it("runs at most one drain and coalesces overlapping wakeups", async () => {
    const host = createHost();
    const coordinator = createRunCoordinator(host);
    let live = 0;
    let maxLive = 0;
    const order: string[] = [];
    const makeTurn = (id: string): QueuedOrchestratorTurn => ({
      priority: "system",
      execute: async () => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        order.push(id);
        // Storm of wakeups while the drain pass is live: all of them must
        // coalesce into the current pass instead of forking a second drain.
        coordinator.wake();
        coordinator.wake();
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        coordinator.wake();
        live -= 1;
      },
    });

    coordinator.enqueueTurn(makeTurn("a"));
    coordinator.enqueueTurn(makeTurn("b"));
    coordinator.enqueueTurn(makeTurn("c"));
    await vi.waitFor(() => {
      expect(order).toEqual(["a", "b", "c"]);
    });
    await vi.waitFor(() => {
      expect(coordinator.isDraining()).toBe(false);
    });

    expect(maxLive).toBe(1);
    expect(coordinator.drainPassCount()).toBe(1);
  });

  it("preserves user-before-system insertion order across a busy lane", async () => {
    const host = createHost();
    const coordinator = createRunCoordinator(host);
    coordinator.beginRun({
      runId: "run-1",
      conversationId: "conversation-1",
      uiVisibility: "visible",
    });

    const order: string[] = [];
    const turn = (id: string, priority: "user" | "system") => ({
      priority,
      execute: async () => {
        order.push(id);
      },
    });
    coordinator.enqueueTurn(turn("s1", "system"));
    coordinator.enqueueTurn(turn("u1", "user"));
    coordinator.enqueueTurn(turn("s2", "system"));
    coordinator.enqueueTurn(turn("u2", "user"));
    await flushMicrotasks();
    // Busy lane: nothing drains until the run releases.
    expect(order).toEqual([]);

    coordinator.releaseRun("run-1");
    coordinator.wake();
    await flushMicrotasks();

    expect(order).toEqual(["u1", "u2", "s1", "s2"]);
  });

  it("admits only one run and keeps terminal state truthful", () => {
    const host = createHost();
    const coordinator = createRunCoordinator(host);
    coordinator.beginRun({
      runId: "run-1",
      conversationId: "conversation-1",
      uiVisibility: "visible",
    });

    expect(() =>
      coordinator.beginRun({
        runId: "run-2",
        conversationId: "conversation-2",
        uiVisibility: "visible",
      }),
    ).toThrowError("The orchestrator is already running.");

    // A stale terminal callback must not clobber the active run.
    expect(coordinator.releaseRun("run-2")).toBe(false);
    expect(host.state.activeOrchestratorRunId).toBe("run-1");
    expect(coordinator.getActiveRun()).toEqual({
      runId: "run-1",
      conversationId: "conversation-1",
      uiVisibility: "visible",
    });

    host.state.activeOrchestratorSession = { runId: "run-1" };
    expect(coordinator.releaseRun("run-1")).toBe(true);
    expect(host.state.activeOrchestratorRunId).toBeNull();
    expect(host.state.activeOrchestratorConversationId).toBeNull();
    expect(host.state.activeOrchestratorUiVisibility).toBe("visible");
    expect(host.state.activeOrchestratorSession).toBeNull();
    expect(coordinator.getActiveRun()).toBeNull();
  });

  it("settles concurrent joined callers in queue order once the lane frees", async () => {
    const host = createHost();
    const coordinator = createRunCoordinator(host);
    coordinator.beginRun({
      runId: "run-1",
      conversationId: "conversation-1",
      uiVisibility: "visible",
    });

    const settled: string[] = [];
    const join = (id: string) =>
      executeOrQueueUserOrchestratorTurn({
        hasActiveRun: Boolean(host.state.activeOrchestratorRunId),
        queueOrchestratorTurn: (turn) => coordinator.enqueueTurn(turn),
        execute: async () => {
          settled.push(id);
          return id;
        },
      });

    const first = join("first");
    const second = join("second");
    await flushMicrotasks();
    expect(settled).toEqual([]);
    expect(coordinator.pendingTurnCount()).toBe(2);

    coordinator.releaseRun("run-1");
    coordinator.wake();

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(settled).toEqual(["first", "second"]);
  });

  it("shutdown interrupts the drain and joins the in-flight turn before settling", async () => {
    const host = createHost();
    const coordinator = createRunCoordinator(host);
    const firstTurn = gate();
    let firstStarted = false;
    const secondTurn = vi.fn(async () => {});

    coordinator.enqueueTurn({
      priority: "user",
      execute: async () => {
        firstStarted = true;
        await firstTurn.opened;
      },
    });
    coordinator.enqueueTurn({ priority: "user", execute: secondTurn });
    await vi.waitFor(() => {
      expect(firstStarted).toBe(true);
    });

    let shutdownSettled = false;
    const shutdown = coordinator.shutdown().then(() => {
      shutdownSettled = true;
    });
    await flushMicrotasks();
    // Teardown before terminal settlement: shutdown must join the live
    // turn, not abandon it.
    expect(shutdownSettled).toBe(false);

    firstTurn.release();
    await shutdown;
    expect(shutdownSettled).toBe(true);
    expect(coordinator.isDraining()).toBe(false);
    // The interrupt landed at the turn boundary: the second queued turn was
    // never admitted, and post-shutdown wakeups stay inert (no leaks).
    expect(secondTurn).not.toHaveBeenCalled();
    coordinator.wake();
    coordinator.enqueueTurn({ priority: "system", execute: secondTurn });
    await flushMicrotasks();
    expect(secondTurn).not.toHaveBeenCalled();
    await expect(coordinator.shutdown()).resolves.toBeUndefined();
  });

  it("a replacement coordinator drains the same lane state after shutdown (restart compatibility)", async () => {
    const host = createHost();
    const first = ensureRunCoordinator(host);
    expect(ensureRunCoordinator(host)).toBe(first);
    await first.shutdown();
    // Worker restart: state fields are the only carrier; a fresh coordinator
    // binds to the same lane shape and drains normally.
    host.state.runCoordinator = null;
    host.state.queuedOrchestratorTurns.length = 0;

    const second = ensureRunCoordinator(host);
    expect(second).not.toBe(first);
    const turn = vi.fn(async () => {});
    second.enqueueTurn({ priority: "user", execute: turn });
    await flushMicrotasks();
    expect(turn).toHaveBeenCalledOnce();
    await second.shutdown();
  });
});
