// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageRecord } from "@stella/contracts/local-chat";

vi.mock("@/context/chat-store-context", () => ({
  useChatStore: () => ({ storageMode: "local" }),
}));

import {
  useConversationMessages,
  type ConversationMessagesState,
} from "@/features/chat/hooks/use-conversation-messages";
import { __testing } from "@/features/chat/services/local-message-timeline-store";

const makeMessage = (conversationId: string): MessageRecord => ({
  _id: `${conversationId}-message`,
  timestamp: 1_000,
  sequence: 1,
  type: "user_message",
  payload: { text: conversationId },
  toolEvents: [],
});

describe("useConversationMessages production timeline wiring", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ConversationMessagesState | null;
  let listMessages: ReturnType<typeof vi.fn>;

  function Harness({ conversationId }: { conversationId: string }) {
    latest = useConversationMessages(conversationId);
    return <output>{latest.messages.length}</output>;
  }

  const render = async (conversationId: string) => {
    await act(async () => {
      root.render(<Harness conversationId={conversationId} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    __testing.reset();
    latest = null;
    listMessages = vi.fn();
    window.electronAPI = {
      localChat: {
        listMessages,
        onUpdated: () => () => {},
      },
    } as never;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    __testing.reset();
    delete (window as { electronAPI?: unknown }).electronAPI;
    vi.useRealTimers();
  });

  it("backs off repeated production-store failures and publishes the recovered page", async () => {
    listMessages
      .mockRejectedValueOnce(new Error("transient read failure"))
      .mockRejectedValueOnce(new Error("second transient failure"))
      .mockResolvedValueOnce({
        messages: [makeMessage("retry")],
        visibleMessageCount: 1,
      });

    await render("retry");
    expect(listMessages).toHaveBeenCalledTimes(1);
    expect(latest?.messages).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(listMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    expect(listMessages).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(listMessages).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    expect(listMessages).toHaveBeenCalledTimes(3);
    expect(latest?.messages.map((message) => message._id)).toEqual([
      "retry-message",
    ]);
  });

  it("cancels the old retry when switching conversations and after unmount", async () => {
    listMessages.mockImplementation(
      async ({ conversationId }: { conversationId: string }) => {
        if (conversationId === "first") throw new Error("first failed");
        return {
          messages: [makeMessage(conversationId)],
          visibleMessageCount: 1,
        };
      },
    );

    await render("first");
    expect(listMessages).toHaveBeenCalledTimes(1);

    await render("second");
    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(latest?.messages.at(-1)?._id).toBe("second-message");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(listMessages).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
    expect(__testing.getDebugStats().activeEntries).toBe(0);
    expect(__testing.getDebugStats().pendingReads).toBe(0);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(listMessages).toHaveBeenCalledTimes(2);

    root = createRoot(container);
  });
});
