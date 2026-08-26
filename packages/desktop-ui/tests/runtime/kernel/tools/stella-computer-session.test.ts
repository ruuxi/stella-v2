import { describe, expect, it } from "vitest";

import {
  getStellaBrowserSessionId,
  getStellaComputerSessionId,
} from "@stella/runtime/kernel/tools/stella-computer-session";
import type { ToolContext } from "@stella/runtime/kernel/tools/types";

const rootContext = (runId: string): ToolContext => ({
  conversationId: "conversation-1",
  deviceId: "device-1",
  requestId: `request-${runId}`,
  runId,
  agentType: "orchestrator",
  stellaAppDir: "/tmp/stella",
});

describe("Stella browser session identity", () => {
  it("keeps root REPL kernels run-scoped but browser tabs conversation-scoped", () => {
    const first = rootContext("run-1");
    const second = rootContext("run-2");

    expect(getStellaComputerSessionId(first)).toBe("orchestrator-run-run-1");
    expect(getStellaComputerSessionId(second)).toBe("orchestrator-run-run-2");
    expect(getStellaBrowserSessionId(first)).toBe(
      "orchestrator-conversation-conversation-1",
    );
    expect(getStellaBrowserSessionId(second)).toBe(
      "orchestrator-conversation-conversation-1",
    );
  });

  it("keeps spawned-agent browser tabs isolated by durable agent identity", () => {
    const context: ToolContext = {
      ...rootContext("child-run-1"),
      agentId: "agent-1",
      agentType: "general",
      rootRunId: "run-1",
    };

    expect(getStellaBrowserSessionId(context)).toBe("general-task-agent-1");
  });
});
