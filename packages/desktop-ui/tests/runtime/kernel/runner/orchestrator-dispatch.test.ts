import { describe, expect, it, vi } from "vitest";
import { executeOrQueueSystemOrchestratorTurn } from "@stella/runtime/kernel/runner/orchestrator-dispatch";
import type { QueuedOrchestratorTurn } from "@stella/runtime/kernel/runner/types";

describe("executeOrQueueSystemOrchestratorTurn", () => {
  it("executes immediately when no orchestrator run is active", async () => {
    const execute = vi.fn(async () => undefined);
    const queueOrchestratorTurn = vi.fn();

    await executeOrQueueSystemOrchestratorTurn({
      hasActiveRun: false,
      queueOrchestratorTurn,
      execute,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(queueOrchestratorTurn).not.toHaveBeenCalled();
  });

  it("settles only after a busy-parent completion turn executes", async () => {
    let queuedTurn: QueuedOrchestratorTurn | undefined;
    const execute = vi.fn(async () => undefined);
    const settled = vi.fn();

    const delivery = executeOrQueueSystemOrchestratorTurn({
      hasActiveRun: true,
      queueOrchestratorTurn: (turn) => {
        queuedTurn = turn;
      },
      execute,
    }).then(settled);

    await Promise.resolve();
    expect(queuedTurn?.priority).toBe("system");
    expect(execute).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();

    await queuedTurn?.execute();
    await delivery;

    expect(execute).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
  });

  it("rejects and never executes when canceled before delivery", async () => {
    let queuedTurn: QueuedOrchestratorTurn | undefined;
    const execute = vi.fn(async () => undefined);
    const delivery = executeOrQueueSystemOrchestratorTurn({
      hasActiveRun: true,
      queueOrchestratorTurn: (turn) => {
        queuedTurn = turn;
      },
      execute,
    });
    const rejection = expect(delivery).rejects.toThrow("runtime stopped");

    queuedTurn?.cancel?.(new Error("runtime stopped"));
    await rejection;
    await queuedTurn?.execute();

    expect(execute).not.toHaveBeenCalled();
  });
});
