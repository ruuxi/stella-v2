import { describe, expect, test } from "bun:test";
import type { AgentCallbacks } from "./types.js";
import { resolveRuntimeMessageCallbacks } from "./orchestrator.js";

describe("detached lifecycle callbacks", () => {
  test("keeps a terminal lifecycle turn runnable without renderer callbacks", () => {
    const callbacks = resolveRuntimeMessageCallbacks(
      null,
      "runtime.task_lifecycle",
    );

    expect(callbacks).not.toBeNull();
    expect(() =>
      callbacks?.onError({
        runId: "detached-run",
        agentType: "orchestrator",
        seq: 1,
        error: "provider failed",
        fatal: true,
      }),
    ).not.toThrow();
    expect(() =>
      callbacks?.onEnd({
        runId: "detached-run",
        agentType: "orchestrator",
        seq: 2,
        finalText: "Agent result relayed.",
      }),
    ).not.toThrow();
  });

  test("does not invent detached callbacks for ordinary runtime messages", () => {
    expect(resolveRuntimeMessageCallbacks(null, "runtime.send_message")).toBe(
      null,
    );

    const existing: AgentCallbacks = {
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onEnd: () => {},
    };
    expect(
      resolveRuntimeMessageCallbacks(existing, "runtime.task_lifecycle"),
    ).toBe(existing);
  });
});
