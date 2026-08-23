import { describe, expect, it } from "vitest";

import { createSupervisedScope } from "../kernel/shared/supervised-scope.js";
import {
  ENGINE_ABORT_JOIN_GRACE_MS,
  superviseExternalEngineTurn,
} from "../kernel/agent-runtime/external-engine-lifecycle.js";
import type { RunResource } from "../kernel/agent-runtime/run-resources.js";

/**
 * Interruption proofs for run-owned external engine turns (phase 2
 * batch 3). The engine process itself is session-scoped by design (resume
 * affinity); these tests pin the TURN-level ownership: relay-signal
 * derivation, cancel joining engine teardown, bounded abandonment, and
 * exact passthrough when unsupervised.
 */

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("run-owned external engine turn lifecycle", () => {
  it("passes the run signal through untouched when unsupervised (parity)", async () => {
    const outer = new AbortController();
    let received: AbortSignal | undefined;
    const result = await superviseExternalEngineTurn({
      supervise: undefined,
      engine: "claude-code",
      runId: "run-1",
      signal: outer.signal,
      run: async (signal) => {
        received = signal;
        return "done";
      },
    });
    expect(result).toBe("done");
    expect(received).toBe(outer.signal);
  });

  it("derives a relay signal and forwards run aborts with the reason, same tick", async () => {
    const resources: RunResource[] = [];
    const outer = new AbortController();
    const reason = new Error("user-cancel");
    let received: AbortSignal | undefined;
    let sawReason: unknown = null;

    const turn = superviseExternalEngineTurn({
      supervise: (resource) => resources.push(resource),
      engine: "claude-code",
      runId: "run-2",
      signal: outer.signal,
      run: (signal) =>
        new Promise((resolve) => {
          received = signal;
          signal?.addEventListener("abort", () => {
            sawReason = signal.reason;
            resolve("aborted-turn");
          });
        }),
    });
    await flush();
    expect(resources).toHaveLength(1);
    expect(resources[0].label).toBe("external-engine:claude-code:run-2");
    expect(received).not.toBe(outer.signal);

    outer.abort(reason);
    expect(received?.aborted).toBe(true);
    await expect(turn).resolves.toBe("aborted-turn");
    expect(sawReason).toBe(reason);
    await resources[0].settled;
  });

  it("scope close interrupts the engine turn and joins its teardown", async () => {
    const scope = createSupervisedScope("test:engine-interrupt");
    let toreDown = false;
    void superviseExternalEngineTurn({
      supervise: (resource) => scope.supervise(resource),
      engine: "codex",
      runId: "run-3",
      signal: undefined,
      run: (signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            // Simulate the kill ladder settling the pending step.
            setTimeout(() => {
              toreDown = true;
              resolve("teardown-complete");
            }, 20);
          });
        }),
    }).catch(() => undefined);
    await flush();
    expect(scope.liveCount()).toBe(1);

    await scope.close("canceled");
    expect(toreDown).toBe(true);
    expect(scope.liveCount()).toBe(0);
  });

  it("releases a wedged engine turn after the abandonment grace", async () => {
    const scope = createSupervisedScope("test:engine-abandon");
    void superviseExternalEngineTurn({
      supervise: (resource) => scope.supervise(resource),
      engine: "claude-code",
      runId: "run-4",
      signal: undefined,
      run: () => new Promise(() => {}),
      abortJoinGraceMs: 50,
    }).catch(() => undefined);
    await flush();

    const closedAt = Date.now();
    await scope.close("canceled");
    const elapsed = Date.now() - closedAt;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(ENGINE_ABORT_JOIN_GRACE_MS);
    expect(scope.liveCount()).toBe(0);
  });

  it("natural completion never aborts the relay (session process stays warm)", async () => {
    const resources: RunResource[] = [];
    let relayAborted = false;
    await superviseExternalEngineTurn({
      supervise: (resource) => resources.push(resource),
      engine: "claude-code",
      runId: "run-5",
      signal: undefined,
      run: async (signal) => {
        signal?.addEventListener("abort", () => {
          relayAborted = true;
        });
        return "ok";
      },
    });
    await resources[0].settled;
    expect(relayAborted).toBe(false);
  });

  it("engine failures propagate untouched and still settle the resource", async () => {
    const resources: RunResource[] = [];
    const failure = new Error("Claude Code exited with code 1");
    await expect(
      superviseExternalEngineTurn({
        supervise: (resource) => resources.push(resource),
        engine: "claude-code",
        runId: "run-6",
        signal: undefined,
        run: async () => {
          throw failure;
        },
      }),
    ).rejects.toThrow(failure);
    await resources[0].settled;
  });
});
