import { describe, expect, test } from "bun:test";
import { AGENT_STREAM_EVENT_TYPES } from "@stella/contracts/agent-runtime";
import {
  connectorLocalFollowupDeliveryId,
  resolveConnectorTerminalFollowup,
} from "./connector-followup";

describe("connector follow-up delivery", () => {
  test("projects a terminal notice with a stable delivery id", () => {
    const event = {
      type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
      runId: "run-1",
      seq: 42,
      requestId: "request-1",
      conversationId: "conversation-1",
      finalText: "The background task is done.",
      responseTarget: {
        type: "agent_terminal_notice" as const,
        agentId: "agent-1",
        terminalState: "completed" as const,
      },
    };

    const first = resolveConnectorTerminalFollowup(event, "request-1");
    const replay = resolveConnectorTerminalFollowup(
      { ...event, seq: 99 },
      "request-1",
    );

    expect(first).toEqual(replay);
    expect(first?.text).toBe("The background task is done.");
    expect(first?.deliveryId).toMatch(/^connector-followup:[a-f0-9]{64}$/);
  });

  test("does not turn the initial user-facing terminal into a follow-up", () => {
    expect(
      resolveConnectorTerminalFollowup(
        {
          type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
          runId: "run-1",
          seq: 1,
          requestId: "request-1",
          finalText: "Initial answer",
          responseTarget: { type: "user_turn" },
        },
        "request-1",
      ),
    ).toBeNull();
  });

  test("local compatibility events also receive deterministic ids", () => {
    expect(
      connectorLocalFollowupDeliveryId("request-1", "event-1", "Follow-up"),
    ).toBe(
      connectorLocalFollowupDeliveryId("request-1", "event-1", "Follow-up"),
    );
  });
});
