import { describe, expect, test } from "bun:test";
import {
  resolveConversationStorageMode,
  shouldPersistLocalChatTranscript,
} from "./conversation-storage-mode.js";
import {
  normalizeAutomationRunInput,
  normalizeChatRunInput,
} from "./orchestrator-policy.js";
import { createStellaRoute } from "../model-routing-stella.js";

describe("cloud-owned conversation storage", () => {
  test("defaults an ordinary runtime chat to cloud ownership", () => {
    expect(resolveConversationStorageMode(undefined)).toBe("cloud");
    expect(
      normalizeChatRunInput({
        conversationId: "conversation-1",
        userMessageId: "message-1",
        userPrompt: "Hello",
      }).storageMode,
    ).toBe("cloud");
    expect(shouldPersistLocalChatTranscript(undefined)).toBe(false);
    expect(shouldPersistLocalChatTranscript("cloud")).toBe(false);
  });

  test("keeps local ownership only when an operational caller asks explicitly", () => {
    expect(resolveConversationStorageMode("local")).toBe("local");
    expect(
      normalizeChatRunInput({
        conversationId: "conversation-1",
        userMessageId: "message-1",
        userPrompt: "Run a local automation",
        storageMode: "local",
      }).storageMode,
    ).toBe("local");
    expect(shouldPersistLocalChatTranscript("local")).toBe(true);
  });

  test("keeps connector automation cloud-owned with a stable message id", () => {
    expect(
      normalizeAutomationRunInput({
        conversationId: " cloud-conversation ",
        userPrompt: " connector prompt ",
        storageMode: "cloud",
        userMessageId: " connector:stable-id ",
      }),
    ).toMatchObject({
      conversationId: "cloud-conversation",
      userPrompt: "connector prompt",
      storageMode: "cloud",
      userMessageId: "connector:stable-id",
    });
  });

  test("does not treat a signed-out refresh callback as cloud authentication", () => {
    expect(
      createStellaRoute({
        site: {
          baseUrl: "https://stella.example",
          getAuthToken: () => null,
          hasConnectedAccount: () => false,
          refreshAuthToken: async () => "anonymous-token",
        },
        agentType: "orchestrator",
        modelId: "stella/default",
      }),
    ).toBeNull();
  });
});
