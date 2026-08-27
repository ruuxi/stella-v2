import { useEffect, type MutableRefObject } from "react";
import { AGENT_STREAM_EVENT_TYPES } from "@stella/contracts/agent-runtime";
import type { AgentStreamEvent } from "../streaming/streaming-types";

type ActiveRunSnapshot = {
  runId: string;
  conversationId: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
} | null;

export const shouldRetainResumedStreamingState = (args: {
  resumedRunId: string | null;
  resumedConversationId: string | null;
  replayEventCount: number;
  replayExhausted: boolean;
  currentActiveRun: Pick<NonNullable<ActiveRunSnapshot>, "runId" | "conversationId"> | null;
}): boolean => {
  if (!args.resumedRunId || !args.resumedConversationId) {
    return false;
  }
  if (args.replayEventCount > 0) {
    return true;
  }
  if (!args.replayExhausted) {
    return true;
  }
  return (
    args.currentActiveRun?.runId === args.resumedRunId &&
    args.currentActiveRun?.conversationId === args.resumedConversationId
  );
};

interface ResumeRefs {
  resumeSeqByConversationRef: MutableRefObject<Map<string, number>>;
  resumeSourceSeqByConversationRef: MutableRefObject<Map<string, number>>;
}

interface ResumeActions {
  ensureAgentStreamSubscription: () => void;
  applyResumeSnapshot: (args: {
    conversationId: string;
    activeRun: ActiveRunSnapshot;
  }) => void;
  handleAgentEvent: (event: AgentStreamEvent, source?: "live" | "replay") => void;

  clearReplayedStreamingState?: () => void;
}

interface UseResumeAgentRunOptions {
  activeConversationId: string | null;
  refs: ResumeRefs;
  actions: ResumeActions;
}

export function useResumeAgentRun({
  activeConversationId,
  refs,
  actions,
}: UseResumeAgentRunOptions) {
  const { resumeSeqByConversationRef, resumeSourceSeqByConversationRef } = refs;
  const {
    ensureAgentStreamSubscription,
    applyResumeSnapshot,
    handleAgentEvent,
    clearReplayedStreamingState,
  } = actions;

  useEffect(() => {
    if (!activeConversationId || !window.electronAPI) {
      return;
    }
    if (!window.electronAPI.agent.resumeConversationExecution) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let pending = false;

    const runResume = async () => {
      if (cancelled) return;
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      try {
        ensureAgentStreamSubscription();

        const lastSeq =
          resumeSeqByConversationRef.current.get(activeConversationId) ?? 0;
        const lastSourceSeq =
          resumeSourceSeqByConversationRef.current.get(activeConversationId) ??
          0;
        const replay = await window.electronAPI!.agent.resumeConversationExecution({
          conversationId: activeConversationId,
          lastSeq,
          lastSourceSeq,
        });
        if (cancelled) return;

        applyResumeSnapshot({
          conversationId: activeConversationId,
          activeRun: replay.activeRun,
        });

        for (const replayEvent of replay.events) {
          if (cancelled) return;
          handleAgentEvent(replayEvent, "replay");
        }

        const resumedRunId = replay.activeRun?.runId ?? null;
        const runFinishedInReplay =
          resumedRunId != null &&
          replay.events.some(
            (event) =>
              event.type === AGENT_STREAM_EVENT_TYPES.RUN_FINISHED &&
              event.runId === resumedRunId,
          );
        if (!replay.activeRun || runFinishedInReplay) {
          clearReplayedStreamingState?.();
        }
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to resume conversation execution:", error);
      } finally {
        inFlight = false;
        if (pending && !cancelled) {
          pending = false;
          void runResume();
        }
      }
    };

    void runResume();

    const unsubscribeAvailability =
      window.electronAPI?.agent?.onAvailability?.((snapshot) => {
        if (cancelled) return;
        if (!snapshot.connected) return;
        void runResume();
      }) ?? null;

    return () => {
      cancelled = true;
      unsubscribeAvailability?.();
    };
  }, [
    activeConversationId,
    applyResumeSnapshot,
    clearReplayedStreamingState,
    ensureAgentStreamSubscription,
    handleAgentEvent,
    resumeSeqByConversationRef,
    resumeSourceSeqByConversationRef,
  ]);
}
