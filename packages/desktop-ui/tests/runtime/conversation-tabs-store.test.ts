import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_TABS_STORAGE_KEY,
  conversationTabs,
} from "@/features/chat/services/conversation-tabs-store";
import { uiState } from "@/platform/ui-state";

const conversationId = (suffix: string): string => `${"0".repeat(25)}${suffix}`;

beforeEach(() => {
  conversationTabs.reset();
});

afterEach(() => {
  conversationTabs.reset();
  vi.restoreAllMocks();
});

describe("conversationTabs", () => {
  it("opens, dedupes, and refreshes lightweight cached titles", () => {
    const first = conversationId("A");
    conversationTabs.openConversation(first, " First   message ");
    conversationTabs.openConversation(first, "Latest message");

    expect(conversationTabs.getSnapshot().tabs).toEqual([
      { conversationId: first, title: "Latest message" },
    ]);
  });

  it("ignores older message patches while allowing the latest row to update", () => {
    const first = conversationId("A");
    conversationTabs.openConversation(first, "Newest", {
      latestMessageAt: 200,
      latestMessageId: "message-b",
    });

    conversationTabs.updateTitle(first, "Stale patched row", {
      latestMessageAt: 100,
      latestMessageId: "message-a",
    });
    expect(conversationTabs.getSnapshot().tabs[0]?.title).toBe("Newest");

    conversationTabs.updateTitle(first, "Newest patched", {
      latestMessageAt: 200,
      latestMessageId: "message-b",
    });
    expect(conversationTabs.getSnapshot().tabs[0]).toMatchObject({
      title: "Newest patched",
      latestMessageAt: 200,
      latestMessageId: "message-b",
    });
  });

  it("closes the active tab to the right first, then the left", () => {
    const first = conversationId("A");
    const middle = conversationId("B");
    const last = conversationId("C");
    for (const id of [first, middle, last]) {
      conversationTabs.openConversation(id, id);
    }

    expect(
      conversationTabs.closeConversation(middle, middle).nextConversationId,
    ).toBe(last);
    expect(
      conversationTabs.closeConversation(last, last).nextConversationId,
    ).toBe(first);
  });

  it("keeps the active route unchanged when closing an inactive tab", () => {
    const active = conversationId("A");
    const inactive = conversationId("B");
    conversationTabs.openConversation(active);
    conversationTabs.openConversation(inactive);

    expect(conversationTabs.closeConversation(inactive, active)).toEqual({
      closed: true,
      nextConversationId: active,
    });
  });

  it("reorders without tracking a second active-conversation source", () => {
    const ids = [conversationId("A"), conversationId("B"), conversationId("C")];
    ids.forEach((id) => conversationTabs.openConversation(id));
    conversationTabs.reorderConversation(ids[0]!, 2);

    expect(
      conversationTabs.getSnapshot().tabs.map((tab) => tab.conversationId),
    ).toEqual([ids[1], ids[2], ids[0]]);
    expect(conversationTabs.getSnapshot()).not.toHaveProperty(
      "activeConversationId",
    );
  });

  it("persists only validated ids, order, and cached titles", () => {
    const first = conversationId("A");
    conversationTabs.openConversation("store-install:not-a-chat", "Synthetic");
    conversationTabs.openConversation(first, "Hello");

    expect(conversationTabs.getSnapshot().tabs).toHaveLength(1);
    expect(JSON.parse(uiState.getItem(CONVERSATION_TABS_STORAGE_KEY)!)).toEqual(
      {
        version: 1,
        tabs: [{ conversationId: first, title: "Hello" }],
      },
    );
  });

  it("restores valid persisted tabs and rejects malformed entries", () => {
    const first = conversationId("A");
    uiState.setItem(
      CONVERSATION_TABS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        tabs: [
          { conversationId: first, title: " Restored  title " },
          { conversationId: first, title: "Duplicate" },
          { conversationId: "not-a-conversation", title: "Invalid" },
        ],
      }),
    );

    conversationTabs.reloadPersisted();
    expect(conversationTabs.getSnapshot().tabs).toEqual([
      { conversationId: first, title: "Restored title" },
    ]);

    uiState.setItem(CONVERSATION_TABS_STORAGE_KEY, "{bad json");
    conversationTabs.reloadPersisted();
    expect(conversationTabs.getSnapshot().tabs).toEqual([]);
  });

  it("merges summary titles without opening inactive history rows", () => {
    const open = conversationId("A");
    const closed = conversationId("B");
    conversationTabs.openConversation(open);
    conversationTabs.mergeSummaries([
      {
        conversationId: open,
        title: "Current latest",
        createdAt: 1,
        updatedAt: 2,
      },
      {
        conversationId: closed,
        title: "History only",
        createdAt: 1,
        updatedAt: 2,
      },
    ]);

    expect(conversationTabs.getSnapshot().tabs).toEqual([
      { conversationId: open, title: "Current latest" },
    ]);
  });
});

