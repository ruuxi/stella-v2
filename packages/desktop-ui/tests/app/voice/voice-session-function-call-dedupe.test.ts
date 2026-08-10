import { afterEach, describe, expect, it, vi } from "vitest";

import { RealtimeVoiceSession } from "@/features/voice/services/realtime/voice-session";

type VoiceSessionTestAccess = {
  handleServerEvent: (event: Record<string, unknown>) => void;
  _state: "connected";
  transport: {
    send: (event: Record<string, unknown>) => void;
  };
};

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("RealtimeVoiceSession function call deduplication", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("executes and continues once when both completion events share a call ID", async () => {
    let resolveTool!: (value: { output: string }) => void;
    const executeTool = vi.fn(
      () =>
        new Promise<{ output: string }>((resolve) => {
          resolveTool = resolve;
        }),
    );
    vi.stubGlobal("window", {
      electronAPI: {
        localChat: { onUpdated: vi.fn(() => vi.fn()) },
        voice: { executeTool },
      },
    });

    const send = vi.fn();
    const session = new RealtimeVoiceSession();
    session.setConversationId("conversation-1");
    session.setInputActive(true);

    const testSession = session as unknown as VoiceSessionTestAccess;
    testSession.transport = { send };
    testSession._state = "connected";

    const functionCall = {
      type: "function_call",
      name: "spawn_agent",
      call_id: "call-1",
      arguments: JSON.stringify({ description: "Investigate" }),
    };

    testSession.handleServerEvent({
      type: "response.function_call_arguments.done",
      name: functionCall.name,
      call_id: functionCall.call_id,
      arguments: functionCall.arguments,
    });
    testSession.handleServerEvent({
      type: "response.output_item.done",
      item: functionCall,
    });

    await flushPromises();
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith({
      requestId: expect.any(String),
      conversationId: "conversation-1",
      callId: "call-1",
      name: "spawn_agent",
      args: { description: "Investigate" },
    });

    resolveTool({ output: "spawned" });
    await flushPromises();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-1",
        output: "spawned",
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, { type: "response.create" });
  });

  it("syncs agent completion without responding after voice is turned off", async () => {
    let notifyLocalChatUpdated!: () => void;
    const listMessages = vi.fn(async () => ({ messages: [] }));
    const listActivity = vi.fn(async () => ({
      activities: [
        {
          _id: "agent-completed-1",
          timestamp: 1,
          type: "agent-completed",
          payload: { result: "Investigation finished" },
        },
      ],
    }));
    vi.stubGlobal("window", {
      electronAPI: {
        localChat: {
          onUpdated: vi.fn((listener: () => void) => {
            notifyLocalChatUpdated = listener;
            return vi.fn();
          }),
          listMessages,
          listActivity,
        },
      },
    });

    const send = vi.fn();
    const session = new RealtimeVoiceSession();
    session.setConversationId("conversation-1");
    session.setInputActive(true);
    session.setInputActive(false);

    const testSession = session as unknown as VoiceSessionTestAccess;
    testSession.transport = { send };
    testSession._state = "connected";

    notifyLocalChatUpdated();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    expect(listMessages).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      maxVisibleMessages: 80,
    });
    expect(listActivity).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      limit: 80,
    });
    expect(send).toHaveBeenCalledWith({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: expect.stringContaining("Investigation finished"),
          },
        ],
      },
    });
    expect(send).not.toHaveBeenCalledWith({ type: "response.create" });
  });
});
