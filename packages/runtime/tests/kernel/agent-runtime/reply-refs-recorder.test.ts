import { describe, expect, it } from "vitest";
import { createRunEventRecorder } from "@stella/runtime/kernel/agent-runtime/run-events";

const createRecorder = () =>
  createRunEventRecorder({
    runId: "run-1",
    agentType: "orchestrator",
    userMessageId: "user-1",
    getResponseTarget: () => ({ type: "user_turn" }),
  });

describe("run event recorder reply refs", () => {
  it("strips the trailing refs fence from the user-facing text and carries the citations", () => {
    const recorder = createRecorder();
    const event = recorder.recordAssistantTextEnd(
      "Pricing research is done.\n\n```refs\n#142\nagent:pricing-research\n```\n",
    );
    expect(event?.text).toBe("Pricing research is done.");
    expect(event?.replyRefs).toEqual([
      { kind: "message", sequence: 142 },
      { kind: "agent", threadId: "pricing-research" },
    ]);
  });

  it("drops a message that was nothing but a refs block", () => {
    const recorder = createRecorder();
    expect(recorder.recordAssistantTextEnd("```refs\n#1\n```")).toBeNull();
  });
});
