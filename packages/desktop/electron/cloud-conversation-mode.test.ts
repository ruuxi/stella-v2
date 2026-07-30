import { describe, expect, test } from "bun:test";
import {
  requireMatchingCloudConversationId,
  selectedCloudConversationId,
  withCloudConversationStorage,
} from "./cloud-conversation-mode.js";

describe("selectedCloudConversationId", () => {
  test("accepts only a non-empty renderer-selected cloud id", () => {
    expect(selectedCloudConversationId(" cloud-conversation ")).toBe(
      "cloud-conversation",
    );
    expect(selectedCloudConversationId("  ")).toBeNull();
    expect(selectedCloudConversationId(null)).toBeNull();
    expect(selectedCloudConversationId(undefined)).toBeNull();
  });
});

describe("requireMatchingCloudConversationId", () => {
  test("normalizes a request for the currently selected conversation", () => {
    expect(
      requireMatchingCloudConversationId(
        " cloud-conversation ",
        "cloud-conversation",
      ),
    ).toBe("cloud-conversation");
  });

  test("fails closed when selection is missing or has changed", () => {
    expect(() =>
      requireMatchingCloudConversationId("old-conversation", null),
    ).toThrow("Select a cloud conversation");
    expect(() =>
      requireMatchingCloudConversationId(
        "old-conversation",
        "new-conversation",
      ),
    ).toThrow("active cloud conversation changed");
  });
});

describe("desktop cloud conversation mode", () => {
  test("overrides legacy and anonymous renderer requests to cloud storage", () => {
    const localRequest = {
      conversationId: "conversation-1",
      userPrompt: "Hello",
      storageMode: "local" as const,
    };

    expect(withCloudConversationStorage(localRequest)).toEqual({
      conversationId: "conversation-1",
      userPrompt: "Hello",
      storageMode: "cloud",
    });
    expect(localRequest.storageMode).toBe("local");
  });
});
