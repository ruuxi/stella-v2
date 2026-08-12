import { describe, expect, test } from "bun:test";
import { desktopBridgeEventMatchesActiveRun } from "../desktop-chat-event-policy";

const matches = (
  overrides: Partial<Parameters<typeof desktopBridgeEventMatchesActiveRun>[0]>,
) =>
  desktopBridgeEventMatchesActiveRun({
    conversationId: "conversation",
    requestId: "request-1",
    runId: "",
    eventConversationId: "conversation",
    eventRequestId: "request-1",
    eventRunId: "run-1",
    ...overrides,
  });

describe("desktopBridgeEventMatchesActiveRun", () => {
  test("uses request identity before the root run is known", () => {
    expect(matches({})).toBe(true);
    expect(matches({ eventRequestId: "stale-request" })).toBe(false);
  });

  test("follows the root run across consumed-steer request handoffs", () => {
    expect(
      matches({
        runId: "run-1",
        eventRunId: "run-1",
        eventRequestId: "request-2",
      }),
    ).toBe(true);
  });

  test("rejects another root run and another conversation", () => {
    expect(matches({ runId: "run-1", eventRunId: "run-2" })).toBe(false);
    expect(matches({ eventConversationId: "other" })).toBe(false);
  });
});
