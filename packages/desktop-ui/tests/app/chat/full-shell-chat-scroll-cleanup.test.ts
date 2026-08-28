import { describe, expect, it, vi } from "vitest";
import { createConversationScrollMemoryCleanup } from "@/shell/use-full-shell-chat";

describe("full shell chat scroll cleanup", () => {
  it("does not ask Legend for its scroll node after Legend has unmounted", () => {
    const scrollNode = { scrollTop: 312 };
    let legendMounted = true;
    const getScrollableNode = vi.fn(() => {
      if (!legendMounted) {
        throw new Error("Legend internal ref is no longer mounted");
      }
      return scrollNode;
    });
    const scrollMemory = new Map();
    const cleanup = createConversationScrollMemoryCleanup({
      conversationId: "conversation-a",
      list: { getScrollableNode },
      scrollMemory,
      getIsFollowing: () => false,
      isConversationOpen: () => true,
    });

    expect(getScrollableNode).toHaveBeenCalledTimes(1);
    legendMounted = false;

    expect(cleanup).not.toThrow();
    expect(getScrollableNode).toHaveBeenCalledTimes(1);
    expect(scrollMemory.get("conversation-a")).toEqual({
      scrollTop: 312,
      followingLatest: false,
    });
  });

  it("fails open when Legend is already tearing down during capture", () => {
    const getScrollableNode = vi.fn(() => {
      throw new Error("Legend internal ref is no longer mounted");
    });
    const scrollMemory = new Map();

    const cleanup = createConversationScrollMemoryCleanup({
      conversationId: "conversation-a",
      list: { getScrollableNode },
      scrollMemory,
      getIsFollowing: () => false,
      isConversationOpen: () => true,
    });

    expect(getScrollableNode).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toThrow();
    expect(scrollMemory.size).toBe(0);
  });
});
