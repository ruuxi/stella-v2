import { describe, expect, it } from "vitest";

import { createSupervisedScope } from "../kernel/shared/supervised-scope.js";
import {
  createToolExecutionSupervisor,
  TOOL_ABORT_JOIN_GRACE_MS,
} from "../kernel/agent-runtime/tool-lifecycle.js";
import type { RunResource } from "../kernel/agent-runtime/run-resources.js";

/**
 * Interruption proofs for run-owned tool execution (phase 2 batch 2).
 * Asserts real lifecycle behavior: child-signal derivation, cancel joins
 * tool cleanup, bounded abandonment, and the duplicate-execution guard.
 */

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("run-owned tool execution lifecycle", () => {
  it("derives the tool's signal from the loop signal and registers one resource per call", async () => {
    const resources: RunResource[] = [];
    const supervise = createToolExecutionSupervisor({
      supervise: (resource) => resources.push(resource),
    });

    const outer = new AbortController();
    let received: AbortSignal | undefined;
    const result = await supervise({
      toolCallId: "call-1",
      toolName: "exec_command",
      signal: outer.signal,
      run: async (signal) => {
        received = signal;
        return "ok";
      },
    });
    expect(result).toBe("ok");
    expect(resources).toHaveLength(1);
    expect(resources[0].label).toBe("tool:exec_command:call-1");
    // Child signal, not the loop signal itself.
    expect(received).toBeDefined();
    expect(received).not.toBe(outer.signal);
    await resources[0].settled; // settles with the body
  });

  it("forwards loop-signal aborts into the child with the reason, same tick", async () => {
    const supervise = createToolExecutionSupervisor({ supervise: () => {} });
    const outer = new AbortController();
    const reason = new Error("tool timed out");
    let received: AbortSignal | undefined;
    let sawAbort: unknown = null;

    const execution = supervise({
      toolCallId: "call-2",
      toolName: "exec_command",
      signal: outer.signal,
      run: (signal) =>
        new Promise((resolve) => {
          received = signal;
          signal?.addEventListener("abort", () => {
            sawAbort = signal.reason;
            resolve("torn down");
          });
        }),
    });
    await flush();
    outer.abort(reason);
    expect(received?.aborted).toBe(true);
    await expect(execution).resolves.toBe("torn down");
    expect(sawAbort).toBe(reason);
  });

  it("run-scope close interrupts the tool and joins its cleanup before resolving", async () => {
    const scope = createSupervisedScope("test:tool-interrupt");
    const supervise = createToolExecutionSupervisor({
      supervise: (resource) => scope.supervise(resource),
    });

    let cleanedUp = false;
    void supervise({
      toolCallId: "call-3",
      toolName: "exec_command",
      signal: undefined,
      run: (signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            // Simulate asynchronous teardown the close must wait for.
            setTimeout(() => {
              cleanedUp = true;
              resolve("done");
            }, 20);
          });
        }),
    }).catch(() => undefined);
    await flush();
    expect(scope.liveCount()).toBe(1);

    await scope.close("canceled");
    expect(cleanedUp).toBe(true);
    expect(scope.liveCount()).toBe(0);
  });

  it("releases an abort-ignoring tool after the abandonment grace", async () => {
    const scope = createSupervisedScope("test:tool-abandon");
    const supervise = createToolExecutionSupervisor({
      supervise: (resource) => scope.supervise(resource),
      abortJoinGraceMs: 50,
    });

    void supervise({
      toolCallId: "call-4",
      toolName: "stuck_tool",
      signal: undefined,
      run: () => new Promise(() => {}), // never settles, ignores abort
    }).catch(() => undefined);
    await flush();

    const closedAt = Date.now();
    await scope.close("canceled");
    const elapsed = Date.now() - closedAt;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(TOOL_ABORT_JOIN_GRACE_MS);
    expect(scope.liveCount()).toBe(0);
  });

  it("rejects a duplicate toolCallId while the first execution is live, and clears on settlement", async () => {
    const supervise = createToolExecutionSupervisor({ supervise: () => {} });
    let release: () => void = () => {};
    const first = supervise({
      toolCallId: "call-5",
      toolName: "exec_command",
      signal: undefined,
      run: () =>
        new Promise<string>((resolve) => {
          release = () => resolve("first");
        }),
    });
    await flush();

    await expect(
      supervise({
        toolCallId: "call-5",
        toolName: "exec_command",
        signal: undefined,
        run: async () => "second",
      }),
    ).rejects.toThrow("Tool call call-5 (exec_command) is already executing.");

    release();
    await expect(first).resolves.toBe("first");
    // Slot cleared: a fresh execution with the same id is legal again.
    await expect(
      supervise({
        toolCallId: "call-5",
        toolName: "exec_command",
        signal: undefined,
        run: async () => "third",
      }),
    ).resolves.toBe("third");
  });

  it("unsupervised mode passes the loop signal through untouched (parity)", async () => {
    const supervise = createToolExecutionSupervisor({});
    const outer = new AbortController();
    let received: AbortSignal | undefined;
    await supervise({
      toolCallId: "call-6",
      toolName: "exec_command",
      signal: outer.signal,
      run: async (signal) => {
        received = signal;
        return "ok";
      },
    });
    expect(received).toBe(outer.signal);
  });

  it("tool failures propagate to the caller and still settle the resource", async () => {
    const resources: RunResource[] = [];
    const supervise = createToolExecutionSupervisor({
      supervise: (resource) => resources.push(resource),
    });
    const failure = new Error("tool exploded");
    await expect(
      supervise({
        toolCallId: "call-7",
        toolName: "exec_command",
        signal: undefined,
        run: async () => {
          throw failure;
        },
      }),
    ).rejects.toThrow(failure);
    await resources[0].settled;
  });
});
