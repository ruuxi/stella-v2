/**
 * Voice on pi-durable. The voice model hands what the user wants to the
 * conversation's orchestrator as a hidden turn and speaks its answer; the
 * call's tool activity reaches the voice overlay as the agent loops' events.
 * What was said is written into the transcript as model history, and a call
 * starts with what the conversation has said so far.
 */
import {
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
} from "@stella/contracts/agent-runtime";
import { piMessageText, type PiChatEvent } from "@stella/contracts/pi-chat";
import {
  NOTIFICATION_NAMES,
  type RuntimeAgentEventPayload,
  type RuntimeVoiceChatPayload,
} from "@stella/contracts/protocol";
import type { DesktopChats } from "@stella/agent/host/desktop-chats";
import type * as HostBus from "./host-bus.js";

const RESULT_PREVIEW_CHARS = 400;

export const piVoiceChat = async (
  chats: DesktopChats,
  hostBus: HostBus.Interface,
  payload: RuntimeVoiceChatPayload,
): Promise<string> => {
  let seq = 0;
  const emit = (event: Omit<RuntimeAgentEventPayload, "runId" | "seq">) =>
    hostBus.notify(NOTIFICATION_NAMES.VOICE_AGENT_EVENT, {
      requestId: payload.requestId,
      event: { ...event, runId: payload.requestId, seq: ++seq },
    });
  const observe = (events: PiChatEvent[]) => {
    for (const event of events) {
      if (event.type === "tool_execution_start") {
        emit({
          type: AGENT_STREAM_EVENT_TYPES.TOOL_START,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: event.args,
        });
      } else if (event.type === "tool_execution_end") {
        const result = event.entry?.model?.[0];
        const text = piMessageText(result);
        const isError = result?.role === "toolResult" && result.isError;
        emit({
          type: AGENT_STREAM_EVENT_TYPES.TOOL_END,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          ...(text ? { resultPreview: text.slice(0, RESULT_PREVIEW_CHARS) } : {}),
          ...(isError ? { isError: true, error: text.slice(0, RESULT_PREVIEW_CHARS) || "The tool failed." } : {}),
        });
      } else if (event.type === "auto_retry_start") {
        emit({
          type: AGENT_STREAM_EVENT_TYPES.STATUS,
          statusState: "provider-retry",
          statusText: `Retrying: ${event.errorMessage}`,
        });
      }
    }
  };
  const settled = await chats
    .automation(payload.conversationId, {
      requestId: `voice:${payload.requestId}`,
      prompt: payload.message,
      visible: false,
      observe,
    })
    .catch((error: unknown) => ({
      status: "error" as const,
      finalText: "" as const,
      error: error instanceof Error ? error.message : String(error),
    }));
  if (settled.status !== "ok") {
    emit({
      type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
      outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
      error: settled.error,
    });
    throw new Error(settled.error);
  }
  emit({
    type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
    outcome: AGENT_RUN_FINISH_OUTCOMES.COMPLETED,
    finalText: settled.finalText,
  });
  return settled.finalText || "Done.";
};
