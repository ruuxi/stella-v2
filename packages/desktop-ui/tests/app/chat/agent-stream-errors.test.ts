import { describe, expect, it } from "vitest";

import { resolveAgentNotReadyToast } from "@/features/chat/streaming/agent-stream-errors";

describe("agent start errors", () => {
  it("keeps ordinary initialization waits concise", () => {
    expect(resolveAgentNotReadyToast(null)).toEqual({
      title: "Stella is still starting up",
      description: "Please try again in a moment.",
    });
  });

  it("surfaces and cleans an actual runner startup failure", () => {
    expect(
      resolveAgentNotReadyToast(
        "Error: createBackgroundExitWake is not defined",
      ),
    ).toEqual({
      title: "Stella could not start",
      description: "createBackgroundExitWake is not defined",
    });
  });

  it("redacts secrets in an actual runner startup failure", () => {
    const toast = resolveAgentNotReadyToast(
      "Error: runner failed with token=sk-supersecretvalue123",
    );

    expect(toast.description).toBe("runner failed with token=[redacted]");
  });
});
