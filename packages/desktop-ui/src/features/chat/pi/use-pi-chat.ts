/**
 * The chat column's view of a conversation running on pi-durable: the
 * timeline rows, the assistant message in flight, and the run's state, in
 * the shapes `useFullShellChat` selects between. Sending goes through the
 * usual composer path, whose `startStream` submits to pi in this mode.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { piMessageText } from "@stella/contracts/pi-chat";
import { provideLineageSource } from "@/features/chat/services/lineage-messages-store";
import {
  abortPiChat,
  loadOlderPiChat,
  piChatEnabled,
  piChatLoading,
  piChatSnapshot,
  subscribePiChat,
  subscribePiChatEnabled,
  watchPiChat,
} from "./pi-chat-store";
import { piReplyFileEvents, piStreamingOverlay, projectPiChat } from "./pi-chat-records";

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
  const loading = useSyncExternalStore(enabled ? subscribe : NO_SUBSCRIPTION, () => {
    const { loading, loadingOlder, synced } = piChatLoading(conversationId);
    return (loading ? 1 : 0) | (loadingOlder ? 2 : 0) | (synced ? 4 : 0);
  });

  // Streamed text changes only `streaming`; the rows rebuild on new entries.
  const projection = useMemo(
    () => projectPiChat({ entries: state.entries, requestIds: state.requestIds }),
    [state.entries, state.requestIds],
  );
  const replyFiles = useMemo(() => piReplyFileEvents(state.entries), [state.entries]);
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

  // The focus view of a message or an agent is derived from the loaded
  // transcript: the spawn turn, and the replies that relay its reports.
  const hasOlder = state.hasOlder;
  const isLoadingOlder = (loading & 2) === 2;
  useEffect(() => {
    if (!enabled || !conversationId) return;
    provideLineageSource(conversationId, {
      messages: projection.messages,
      hasOlder,
      isLoadingOlder,
      loadOlder: () => loadOlderPiChat(conversationId),
    });
    return () => provideLineageSource(conversationId, null);
  }, [conversationId, enabled, hasOlder, isLoadingOlder, projection.messages]);

  const cancel = useCallback(() => {
    if (conversationId) abortPiChat(conversationId);
  }, [conversationId]);
  const loadOlder = useCallback(() => {
    if (conversationId) void loadOlderPiChat(conversationId);
  }, [conversationId]);

  return {
    enabled,
    messages: projection.messages,
    /** Replies that link files, for the Files panel. */
    replyFiles,
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
    hasOlderMessages: state.hasOlder,
    isInitialLoading: (loading & 1) === 1 && state.entries.length === 0,
    /** This watch's snapshot is in: the transcript is current, not one left from an earlier watch. */
    isSynced: enabled && (loading & 4) === 4,
    isLoadingOlder,
    loadOlderMessages: loadOlder,
  };
};
