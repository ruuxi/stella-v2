import { describe, expect, test } from "vitest";
import type { CloudConversation } from "../../../src/features/cloud/cloud-api";
import { filterCloudConversationHistory } from "../../../src/features/cloud/cloud-conversation-list";

const conversation = (index: number): CloudConversation => ({
  conversationId: `conversation-${index}`,
  ownerId: "owner",
  title: index === 29 ? "Quarterly planning" : `Conversation ${index}`,
  lastPreview: index === 28 ? "Launch checklist" : undefined,
  createdAt: index,
  updatedAt: index,
});

describe("filterCloudConversationHistory", () => {
  const conversations = Array.from({ length: 30 }, (_, index) =>
    conversation(index),
  );

  test("does not hide loaded conversations behind a display cap", () => {
    expect(filterCloudConversationHistory(conversations, "")).toHaveLength(30);
  });

  test("matches title and preview across older loaded pages", () => {
    expect(
      filterCloudConversationHistory(conversations, "quarterly").map(
        (item) => item.conversationId,
      ),
    ).toEqual(["conversation-29"]);
    expect(
      filterCloudConversationHistory(conversations, "launch checklist").map(
        (item) => item.conversationId,
      ),
    ).toEqual(["conversation-28"]);
  });
});
