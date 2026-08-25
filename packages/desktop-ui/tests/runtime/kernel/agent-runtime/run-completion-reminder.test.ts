import { beforeEach, describe, expect, it, vi } from "vitest";

const compactRuntimeThreadHistory = vi.hoisted(() => vi.fn());

vi.mock("@stella/runtime/kernel/agent-runtime/thread-memory.js", () => ({
  compactRuntimeThreadHistory,
}));

import { runCompactionWithHooks } from "@stella/runtime/kernel/agent-runtime/run-completion.js";

const run = async (args: {
  agentType: string;
  compacted: boolean;
  forceReminder: ReturnType<typeof vi.fn>;
}) => {
  compactRuntimeThreadHistory.mockResolvedValueOnce({
    compacted: args.compacted,
  });
  return runCompactionWithHooks({
    opts: {
      agentType: args.agentType,
      conversationId: "conv-1",
      store: {
        forceOrchestratorReminderOnNextTurn: args.forceReminder,
      },
    } as never,
    threadKey: "thread-1",
    runId: "run-1",
    messageCount: 10,
  });
};

describe("compaction-owned Other Threads reminders", () => {
  beforeEach(() => {
    compactRuntimeThreadHistory.mockReset();
  });

  it("arms one roster after successful orchestrator compaction", async () => {
    const forceReminder = vi.fn();

    await run({ agentType: "orchestrator", compacted: true, forceReminder });

    expect(forceReminder).toHaveBeenCalledOnce();
    expect(forceReminder).toHaveBeenCalledWith("conv-1");
  });

  it("does not arm on a no-op compaction or a child-agent compaction", async () => {
    const forceReminder = vi.fn();

    await run({ agentType: "orchestrator", compacted: false, forceReminder });
    await run({ agentType: "general", compacted: true, forceReminder });

    expect(forceReminder).not.toHaveBeenCalled();
  });
});
