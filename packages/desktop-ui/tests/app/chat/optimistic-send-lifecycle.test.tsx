// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageRecord } from "@stella/contracts/local-chat";

const stream = vi.hoisted(() => {
  let resolve: ((accepted: boolean) => void) | null = null;
  return {
    start: vi.fn(
      () =>
        new Promise<boolean>((next) => {
          resolve = next;
        }),
    ),
    accept: (accepted: boolean) => resolve?.(accepted),
    reset: () => {
      resolve = null;
    },
  };
});

vi.mock("@/platform/electron/device-id", () => ({
  getOrCreateDeviceId: vi.fn(async () => "device-1"),
}));

vi.mock("@/platform/electron/platform", () => ({
  getPlatform: () => "desktop",
}));

vi.mock("@/context/chat-store-context", () => ({
  useChatStore: () => ({ isLocalStorage: true, storageMode: "cloud" }),
}));

vi.mock("@/features/chat/streaming/use-local-agent-stream", async () => {
  const React = await import("react");
  return {
    useLocalAgentStream: () => {
      const [pendingUserMessageId, setPendingUserMessageId] =
        React.useState<string | null>(null);
      return {
        taskDecorations: [],
        runtimeStatusText: null,
        activeToolCallId: null,
        activeToolName: null,
        latestCompletedTool: null,
        hasToolActivity: false,
        isToolActive: false,
        answerLanded: false,
        reasoningText: "",
        streamingAssistants: [],
        isStreaming: false,
        pendingUserMessageId,
        setPendingUserMessageId,
        startStream: stream.start,
        cancelCurrentStream: vi.fn(),
      };
    },
  };
});

import { useStreamingChatCore } from "@/features/chat/hooks/use-streaming-chat-core";

type Chat = ReturnType<typeof useStreamingChatCore>;

describe("optimistic send lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let chat: Chat;
  let persistedMessages: MessageRecord[];

  function Probe() {
    chat = useStreamingChatCore({
      conversationId: "conversation-1",
      locale: "en",
      persistedMessages,
    });
    return <span>{chat.optimisticEvents.length}</span>;
  }

  beforeEach(async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    stream.start.mockClear();
    stream.reset();
    persistedMessages = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Probe />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("acknowledges once before stream acceptance and restores on rejection", async () => {
    const onClear = vi.fn();
    const onOptimisticStart = vi.fn();
    const onRestore = vi.fn();
    let firstSend: Promise<boolean>;
    let repeatedSend: Promise<boolean>;

    await act(async () => {
      firstSend = chat.sendMessage({
        text: "hello",
        selectedText: null,
        chatContext: null,
        onClear,
        onOptimisticStart,
        onRestore,
      });
      repeatedSend = chat.sendMessage({
        text: "hello",
        selectedText: null,
        chatContext: null,
        onClear,
      });
      await Promise.resolve();
    });

    expect(container.textContent).toBe("1");
    expect(onClear).toHaveBeenCalledOnce();
    expect(onOptimisticStart).toHaveBeenCalledOnce();
    expect(stream.start).toHaveBeenCalledOnce();
    await expect(repeatedSend!).resolves.toBe(false);

    await act(async () => {
      stream.accept(false);
      await firstSend!;
    });

    expect(container.textContent).toBe("0");
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it("reconciles the accepted optimistic row by its canonical id", async () => {
    let send: Promise<boolean>;
    await act(async () => {
      send = chat.sendMessage({
        text: "persist me once",
        selectedText: null,
        chatContext: null,
        onClear: vi.fn(),
      });
      await Promise.resolve();
    });
    const userMessageId = stream.start.mock.calls[0]?.[0].userMessageEventId;
    expect(typeof userMessageId).toBe("string");
    expect(container.textContent).toBe("1");

    await act(async () => {
      stream.accept(true);
      await send!;
    });
    persistedMessages = [
      {
        _id: userMessageId,
        type: "user_message",
        timestamp: 1,
        payload: { text: "persist me once" },
        toolEvents: [],
      },
    ];
    await act(async () => root.render(<Probe />));

    expect(chat.optimisticEvents).toHaveLength(0);
    expect(persistedMessages).toHaveLength(1);
  });
});
