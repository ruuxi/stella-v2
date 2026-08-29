import { describe, expect, it } from "vitest";
import {
  initialStoreState,
  streamStoreReducer,
} from "@/features/chat/streaming/store";
import {
  buildInlineWorkingIndicatorProps,
  getInlineWorkingIndicatorActive,
  WORKING_INDICATOR_HANDOFF_MS,
} from "@/features/chat/working-indicator-state";

const started = streamStoreReducer(initialStoreState, {
  type: "run-started",
  runId: "run-1",
  conversationId: "conv-1",
});

/**
 * With replies delivered whole there is no per-token signal to fade the
 * indicator against, so the hand-off is a state machine: the run's FINAL
 * assistant message sets `answerLanded`, the indicator plays a fixed exit, and
 * the reply is held for exactly that long so it lands where the indicator was.
 * A preamble is not the final message — a tool follows it — so these cases pin
 * the two ways a boundary is read.
 */
describe("working indicator handoff", () => {
  it("marks the run answered on a final assistant message boundary", () => {
    const next = streamStoreReducer(started, {
      type: "assistant-message-boundary",
      runId: "run-1",
      followedByToolCall: false,
    });
    expect(next.runsById["run-1"]?.answerLanded).toBe(true);
  });

  it("keeps the indicator up for a preamble followed by a tool call", () => {
    const next = streamStoreReducer(started, {
      type: "assistant-message-boundary",
      runId: "run-1",
      followedByToolCall: true,
    });
    expect(next.runsById["run-1"]?.answerLanded).toBe(false);
    expect(next.runsById["run-1"]?.pendingToolAfterPreamble).toBe(true);
  });

  it("clears answerLanded when a tool starts after a message", () => {
    const answered = streamStoreReducer(started, {
      type: "assistant-message-boundary",
      runId: "run-1",
      followedByToolCall: false,
    });
    const next = streamStoreReducer(answered, {
      type: "tool-start",
      runId: "run-1",
      conversationId: "conv-1",
      toolCallId: "tool-1",
      toolName: "Shell",
    });
    expect(next.runsById["run-1"]?.answerLanded).toBe(false);
  });

  it("deactivates on answerLanded while the run is still live", () => {
    expect(
      getInlineWorkingIndicatorActive({
        isStreaming: true,
        isToolActive: false,
        answerLanded: true,
      }),
    ).toBe(false);
    expect(
      getInlineWorkingIndicatorActive({
        isStreaming: true,
        isToolActive: false,
        answerLanded: false,
      }),
    ).toBe(true);
  });

  it("exits via handoff instead of exitImmediately once the answer lands", () => {
    const props = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isToolActive: false,
      answerLanded: true,
      runtimeStatusText: null,
    });
    expect(props.active).toBe(false);
    expect(props.handoff).toBe(true);
    expect(props.exitImmediately).toBeUndefined();
  });

  it("keeps the instant exit for terminal runs without an answer", () => {
    const props = buildInlineWorkingIndicatorProps({
      isStreaming: false,
      isToolActive: false,
      answerLanded: false,
      runtimeStatusText: null,
    });
    expect(props.active).toBe(false);
    expect(props.exitImmediately).toBe(true);
    expect(props.handoff).toBeUndefined();
  });

  // The CSS exit, the indicator's unmount delay, and the reply's hold are three
  // separate clocks that must agree, or the answer either flashes in behind the
  // indicator or leaves a gap. They all read this constant.
  it("pins the hold duration to the indicator exit duration", () => {
    expect(WORKING_INDICATOR_HANDOFF_MS).toBe(240);
  });
});
