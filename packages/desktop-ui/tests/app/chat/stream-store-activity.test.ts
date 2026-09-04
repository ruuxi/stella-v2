import { describe, expect, it } from "vitest";
import { initialStoreState, streamStoreReducer } from "@/features/chat/streaming/store";

describe("stream activity observations", () => {
  it("bails out after first activity and still clears a stale status", () => {
    let state = streamStoreReducer(initialStoreState, { type: "run-started", runId: "r", conversationId: "c" });
    const first = streamStoreReducer(state, { type: "tool-activity-observed", runId: "r" });
    expect(first).not.toBe(state);
    expect(first.runsById.r.hasToolActivity).toBe(true);
    state = first;
    for (let i = 0; i < 1000; i++) expect(streamStoreReducer(state, { type: "tool-activity-observed", runId: "r" })).toBe(state);
    state = streamStoreReducer(state, { type: "run-status", runId: "r", statusText: "Old status" });
    const cleared = streamStoreReducer(state, { type: "tool-activity-observed", runId: "r" });
    expect(cleared).not.toBe(state);
    expect(cleared.runsById.r.statusText).toBeNull();
  });

  it("retains an active tool's status and ignores missing/terminal runs", () => {
    let state = streamStoreReducer(initialStoreState, { type: "run-started", runId: "r", conversationId: "c" });
    state = streamStoreReducer(state, { type: "tool-start", runId: "r", conversationId: "c", toolCallId: "t", toolName: "Read", statusText: "Reading" });
    expect(streamStoreReducer(state, { type: "tool-activity-observed", runId: "r" })).toBe(state);
    expect(state.runsById.r.statusText).toBe("Reading");
    expect(streamStoreReducer(state, { type: "tool-activity-observed", runId: "missing" })).toBe(state);
    state = streamStoreReducer(state, { type: "run-finished", runId: "r", conversationId: "c", outcome: "completed" });
    expect(streamStoreReducer(state, { type: "tool-activity-observed", runId: "r" })).toBe(state);
  });
});
