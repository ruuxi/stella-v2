import { describe, expect, it, vi } from "vitest";
import { createRunEventRecorder } from "@stella/runtime/kernel/agent-runtime/run-events";

const createRecorder = () =>
  createRunEventRecorder({
    store: { recordRunEvent: vi.fn() } as never,
    runId: "run-1",
    conversationId: "conversation-1",
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

  it("leaves a reply without a fence untouched and omits the field", () => {
    const recorder = createRecorder();
    const event = recorder.recordAssistantTextEnd("Just a reply.");
    expect(event?.text).toBe("Just a reply.");
    expect(event?.replyRefs).toBeUndefined();
  });

  it("drops a message that was nothing but a refs block", () => {
    const recorder = createRecorder();
    expect(recorder.recordAssistantTextEnd("```refs\n#1\n```")).toBeNull();
  });
});
