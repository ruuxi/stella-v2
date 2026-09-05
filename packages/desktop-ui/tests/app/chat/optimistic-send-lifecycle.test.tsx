// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageRecord } from "@stella/contracts/local-chat";

const stream = vi.hoisted(() => {
  let resolve: ((accepted: boolean) => void) | null = null;
  return {
    answerLanded: false,
    finish: (_event: { userMessageId?: string; outcome: "completed" | "error" | "canceled" }) => {},
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
    useLocalAgentStream: ({ onRunFinished }: { onRunFinished: typeof stream.finish }) => {
      stream.finish = onRunFinished;
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
        answerLanded: stream.answerLanded,
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

import { useAgentInputRouting } from "@/shell/use-agent-input-routing";

type Chat = ReturnType<typeof useStreamingChatCore>;

describe("optimistic send lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let chat: Chat;
  let routing: ReturnType<typeof useAgentInputRouting>;
  let persistedMessages: MessageRecord[];

  function Probe() {
    chat = useStreamingChatCore({
      conversationId: "conversation-1",
      locale: "en",
      persistedMessages,
    });
    routing = useAgentInputRouting({
      activeConversationId: "conversation-1",
      sendMessage: chat.sendMessage,
      enterChatSurfaceForInteraction: () => {},
    });
    return <span>{chat.optimisticEvents.length}</span>;
  }

  beforeEach(async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    stream.start.mockClear();
    stream.reset();
    stream.answerLanded = false;
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
    expect(chat.isStreaming).toBe(true);
    expect(chat.answerLanded).toBe(false);
    await expect(repeatedSend!).resolves.toBe(false);

    await act(async () => {
      stream.accept(false);
      await firstSend!;
    });

    expect(container.textContent).toBe("0");
    expect(onRestore).toHaveBeenCalledOnce();
    expect(chat.isStreaming).toBe(false);
  });

  it("notifies the sidebar when its optimistic row appears, before acceptance", async () => {
    const nudge = vi.fn();
    let send: Promise<boolean>;
    await act(async () => {
      send = routing.sendMessageWithContext("sidebar send", null, null, nudge);
    });
    expect(container.textContent).toBe("1");
    expect(nudge).toHaveBeenCalledOnce();
    expect(stream.start).toHaveBeenCalledOnce();

    await act(async () => {
      stream.accept(true);
      await send!;
    });
    expect(nudge).toHaveBeenCalledOnce();

    await act(async () => {
      expect(await routing.sendMessageWithContext("", null, null, nudge)).toBe(false);
    });
    expect(nudge).toHaveBeenCalledOnce();
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
    expect(chat.isStreaming).toBe(false);
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
  it("starts working on the next send even when the previous answer landed", async () => {
    stream.answerLanded = true;
    await act(async () => root.render(<Probe />));
    expect(chat.answerLanded).toBe(true);
    let send: Promise<boolean>;
    await act(async () => {
      send = chat.sendMessage({
        text: "next question",
        selectedText: null,
        chatContext: null,
        onClear: vi.fn(),
      });
    });
    expect(chat.isStreaming).toBe(true);
    expect(chat.answerLanded).toBe(false);
    await act(async () => {
      stream.accept(false);
      await send!;
    });
    expect(chat.isStreaming).toBe(false);
  });
  it("keeps an accepted send pending until cloud history acknowledges it without a local write", async () => {
    let send: Promise<boolean>;
    await act(async () => {
      send = chat.sendMessage({
        text: "cloud handoff",
        selectedText: null,
        chatContext: null,
        onClear: vi.fn(),
      });
    });
    await act(async () => {
      stream.start.mock.calls[0]?.[0].onUserMessageAccepted("dsp:handoff");
      stream.accept(true);
      await send!;
    });
    expect(chat.optimisticEvents.map(event => event._id)).toEqual(["dsp:handoff"]);
    await act(async () => chat.acknowledgeMessages([{
      _id: "dsp:handoff",
      type: "user_message",
      timestamp: 1,
      payload: { text: "cloud handoff" },
      toolEvents: [],
    }]));
    expect(persistedMessages).toEqual([]);
    expect(chat.optimisticEvents).toEqual([]);
  });
  it.each(["error", "canceled"] as const)("clears admission wait when the accepted run ends with %s", async outcome => {
    let send: Promise<boolean>;
    await act(async () => {
      send = chat.sendMessage({
        text: "failed admission", selectedText: null, chatContext: null, onClear: vi.fn(),
      });
    });
    await act(async () => {
      stream.start.mock.calls[0]?.[0].onUserMessageAccepted("dsp:failed");
      stream.accept(true);
      await send!;
    });
    expect(chat.optimisticEvents).toHaveLength(1);
    await act(async () => stream.finish({ userMessageId: "dsp:failed", outcome }));
    expect(chat.optimisticEvents).toEqual([]);
  });
  it.each([true, false])("reconciles a cloud dispatch id when the journal arrives first: %s", async canonicalFirst => {
    let send: Promise<boolean>;
    await act(async () => {
      send = chat.sendMessage({
        text: "same text", selectedText: null, chatContext: null, onClear: vi.fn(),
      });
      await Promise.resolve();
    });
    const args = stream.start.mock.calls[0]?.[0];
    const canonical: MessageRecord = {
      _id: "dsp:accepted", type: "user_message", timestamp: 1,
      payload: { text: "same text" }, toolEvents: [],
    };
    if (canonicalFirst) {
      persistedMessages = [canonical];
      await act(async () => root.render(<Probe />));
    }
    await act(async () => {
      args.onUserMessageAccepted("dsp:accepted");
      stream.accept(true);
      await send!;
    });
    if (!canonicalFirst) {
      expect(chat.optimisticEvents[0]?._id).toBe("dsp:accepted");
      persistedMessages = [canonical];
      await act(async () => root.render(<Probe />));
    }
    expect(chat.optimisticEvents).toHaveLength(0);

    // Matching text is a legitimate second send, not evidence of duplication.
    await act(async () => {
      send = chat.sendMessage({
        text: "same text", selectedText: null, chatContext: null, onClear: vi.fn(),
      });
      await Promise.resolve();
    });
    expect(chat.optimisticEvents).toHaveLength(1);
    await act(async () => {
      stream.start.mock.calls[1]?.[0].onUserMessageAccepted("dsp:second");
      stream.accept(true);
      await send!;
    });
    expect(chat.optimisticEvents[0]?._id).toBe("dsp:second");
    expect(persistedMessages[0]?._id).toBe("dsp:accepted");
  });

});
