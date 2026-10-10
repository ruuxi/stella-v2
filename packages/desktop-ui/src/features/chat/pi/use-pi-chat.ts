/**
 * What pi adds to the chat column while a conversation runs on pi-durable:
 * its transcript (for the rows the conversation's record does not hold yet),
 * the assistant message in flight, and the run's state. The record itself
 * (journal or chat log) is what the column shows, whatever the engine.
 * Sending goes through the usual composer path, whose `startStream` submits
 * to pi in this mode.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { piMessageText } from "@stella/contracts/pi-chat";
import {
  abortPiChat,
  piChatEnabled,
  piChatSnapshot,
  subscribePiChat,
  subscribePiChatEnabled,
  watchPiChat,
} from "./pi-chat-store";
import { piStreamingOverlay, projectPiChat } from "./pi-chat-records";

const NO_SUBSCRIPTION = () => () => {};

export const usePiChat = (conversationId: string | null) => {
  // The user's engine can move the chat onto or off pi while it is open.
  const enabled = useSyncExternalStore(subscribePiChatEnabled, piChatEnabled) && Boolean(conversationId);

  useEffect(() => {
    if (!enabled || !conversationId) return;
    return watchPiChat(conversationId);
  }, [enabled, conversationId]);

  const subscribe = useCallback(
    (listener: () => void) => (enabled && conversationId ? subscribePiChat(conversationId, listener) : () => {}),
    [enabled, conversationId],
  );
  const state = useSyncExternalStore(enabled ? subscribe : NO_SUBSCRIPTION, () => piChatSnapshot(conversationId));

  // Streamed text changes only `streaming`; the rows rebuild on new entries.
  const projection = useMemo(
    () => projectPiChat({ entries: state.entries, requestIds: state.requestIds }),
    [state.entries, state.requestIds],
  );
  const streamingAssistants = useMemo(
    () => piStreamingOverlay({ streaming: state.streaming }, projection.turn),
    [state.streaming, projection.turn],
  );

  const runningTool = useMemo(() => {
    const running = Object.entries(state.tools).filter(([, tool]) => tool.status === "running");
    const last = running[running.length - 1];
    return last ? { callId: last[0], name: last[1].name } : null;
  }, [state.tools]);

  const lastEntry = state.entries[state.entries.length - 1];
  const lastMessage = lastEntry?.model?.[0];
  const answerLanded =
    state.running &&
    lastEntry?.kind === "pi.assistant" &&
    lastMessage?.role === "assistant" &&
    lastMessage.stopReason === "stop" &&
    piMessageText(lastMessage).trim().length > 0;

  const cancel = useCallback(() => {
    if (conversationId) abortPiChat(conversationId);
  }, [conversationId]);

  return {
    enabled,
    projection,
    streamingAssistants,
    // A turn running elsewhere (placed in the cloud or on another computer) is running here too.
    isStreaming: state.running || state.queued.length > 0 || state.remote.length > 0,
    runtimeStatusText: state.retry
      ? `Retrying: ${state.retry.error}`
      : state.compacting
        ? "Compacting the conversation…"
        : null,
    isCompacting: state.compacting,
    activeToolCallId: runningTool?.callId ?? null,
    activeToolName: runningTool?.name ?? null,
    hasToolActivity: Object.keys(state.tools).length > 0,
    isToolActive: runningTool !== null,
    answerLanded,
    pendingUserMessageId: state.running ? (projection.turn.userMessageId ?? null) : null,
    failure: state.failure ?? null,
    cancelCurrentStream: cancel,
  };
};
