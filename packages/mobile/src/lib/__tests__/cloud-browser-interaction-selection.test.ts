import { describe, expect, test } from "bun:test";
import type { CloudBrowserInteractionSummary } from "../cloud-browser";
import { selectCurrentConversationBrowserInteraction } from "../cloud-browser-interaction-selection";

const interaction = (
  interactionId: string,
  createdAt: number,
  expiresAt: number,
): CloudBrowserInteractionSummary => ({
  schemaVersion: 1,
  interactionId,
  conversationId: "conversation:one",
  threadId: `thread:${interactionId}`,
  turnId: `turn:${interactionId}`,
  kind: "login_takeover",
  state: "pending",
  revision: 1,
  displayOrigin: "https://accounts.example",
  displayTitle: "Example",
  expiresAt,
  createdAt,
  updatedAt: createdAt,
});

describe("cloud browser interaction selection", () => {
  test("ignores expired rows and selects the newest live request", () => {
    const selected = selectCurrentConversationBrowserInteraction(
      [
        interaction("expired", 30, 99),
        interaction("older-live", 10, 200),
        interaction("newest-live", 20, 200),
      ],
      "conversation:one",
      100,
    );

    expect(selected?.interactionId).toBe("newest-live");
  });

  test("returns null when the conversation has no live request", () => {
    expect(
      selectCurrentConversationBrowserInteraction(
        [interaction("expired", 10, 100)],
        "conversation:one",
        100,
      ),
    ).toBeNull();
  });
});
