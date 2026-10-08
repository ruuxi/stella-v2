/**
 * The chat column's view of a conversation running on pi-durable: the
 * timeline rows, the assistant message in flight, and the run's state, in
 * the shapes `useFullShellChat` selects between. Sending goes through the
 * usual composer path, whose `startStream` submits to pi in this mode.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { piMessageText } from "@stella/contracts/pi-chat";
import {
  abortPiChat,
  loadOlderPiChat,
  piChatEnabled,
  piChatLoading,
  piChatSnapshot,
  subscribePiChat,
  watchPiChat,
} from "./pi-chat-store";
import { piStreamingOverlay, projectPiChat } from "./pi-chat-records";

const NO_SUBSCRIPTION = () => () => {};

export const usePiChat = (conversationId: string | null) => {
  const enabled = piChatEnabled() && Boolean(conversationId);

  useEffect(() => {
    if (!enabled || !conversationId) return;
    return watchPiChat(conversationId);
  }, [enabled, conversationId]);

  const subscribe = useCallback(
    (listener: () => void) => (enabled && conversationId ? subscribePiChat(conversationId, listener) : () => {}),
    [enabled, conversationId],
  );
  const state = useSyncExternalStore(enabled ? subscribe : NO_SUBSCRIPTION, () => piChatSnapshot(conversationId));
  const loading = useSyncExternalStore(enabled ? subscribe : NO_SUBSCRIPTION, () => {
    const { loading, loadingOlder } = piChatLoading(conversationId);
    return loading ? (loadingOlder ? 3 : 1) : loadingOlder ? 2 : 0;
  });

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
  const loadOlder = useCallback(() => {
    if (conversationId) void loadOlderPiChat(conversationId);
  }, [conversationId]);

  return {
    enabled,
    messages: projection.messages,
    streamingAssistants,
    isStreaming: state.running || state.queued.length > 0,
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
    hasOlderMessages: state.hasOlder,
    isInitialLoading: (loading & 1) === 1 && state.entries.length === 0,
    isLoadingOlder: (loading & 2) === 2,
    loadOlderMessages: loadOlder,
  };
};
