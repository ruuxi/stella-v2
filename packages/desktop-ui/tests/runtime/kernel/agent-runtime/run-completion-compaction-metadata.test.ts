import { beforeEach, describe, expect, it, vi } from "vitest";

const { compactRuntimeThreadHistoryMock } = vi.hoisted(() => ({
  compactRuntimeThreadHistoryMock: vi.fn(),
}));

vi.mock("@stella/runtime/kernel/agent-runtime/thread-memory", () => ({
  compactRuntimeThreadHistory: (...args: unknown[]) =>
    compactRuntimeThreadHistoryMock(...args),
  updateOrchestratorReminderState: vi.fn(),
}));

import { runCompactionWithHooks } from "@stella/runtime/kernel/agent-runtime/run-completion";

describe("run completion compaction metadata", () => {
  beforeEach(() => {
    compactRuntimeThreadHistoryMock.mockReset();
  });

  it("emits the persisted generated replacement when a hook summary is rejected", async () => {
    const generatedSummary = [
      "## Topic",
      "Generated replacement",
      "## Key Points",
      "The persisted checkpoint replaced malformed hook output.",
      "## Current State",
      "Compaction completed safely.",
      "## Open Items",
      "Independent review remains.",
    ].join("\n");
    compactRuntimeThreadHistoryMock.mockResolvedValue({
      compacted: true,
      summary: generatedSummary,
      fromOverride: false,
    });

    const emitted: Array<{ event: string; payload: Record<string, unknown> }> =
      [];
    const hookEmitter = {
      emit: vi.fn(async (event: string, payload: Record<string, unknown>) => {
        emitted.push({ event, payload });
        if (event === "before_compact") {
          return {
            compaction: {
              summary: "## Topic\nRejected hook output",
              preserveLastN: 7,
            },
          };
        }
        return undefined;
      }),
    };

    const result = await runCompactionWithHooks({
      opts: {
        agentType: "orchestrator",
        conversationId: "conversation-1",
        resolvedLlm: {} as never,
        store: {} as never,
        hookEmitter: hookEmitter as never,
      },
      threadKey: "conversation-1",
      runId: "run-1",
      messageCount: 50,
    });
    await vi.waitFor(() =>
      expect(emitted.some(({ event }) => event === "session_compact")).toBe(
        true,
      ),
    );

    expect(result).toMatchObject({ compacted: true, fromOverride: false });
    expect(compactRuntimeThreadHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        overrideSummary: "## Topic\nRejected hook output",
        preserveLastN: 7,
      }),
    );
    expect(
      emitted.find(({ event }) => event === "session_compact")?.payload,
    ).toMatchObject({
      summary: generatedSummary,
      preserveLastN: 7,
      fromHook: false,
    });
  });
});
