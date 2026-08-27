import {
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
} from "@stella/contracts/agent-runtime";

type StreamEventBase = {
  runId: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
  agentType?: string;
  rootRunId?: string;
  agentId?: string;
  description?: string;
  parentAgentId?: string;
  result?: unknown;
  error?: string;
  statusText?: string;
  groupKey?: string;
  groupLabel?: string;
  chunk?: string;
  finalText?: string;
  persisted?: boolean;
  outcome?: string;
  reason?: string;
  type?: string;
};

export type ActiveRunRecord = {
  runId: string;
  conversationId: string;
  requestId: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
};

export type LocalChatStreamCallbackOptions = {
  conversationId: string;
  requestId: string;
  senderWebContentsId: number;
  emitAgentEvent: (event: Record<string, unknown>, targetWebContentsId: number) => void;
  terminalRunIds: Set<string>;
  runOwners: Map<string, number>;
  runToRequestId: Map<string, string>;
  requestToRunId: Map<string, string>;
  activeRunByConversation: Map<string, ActiveRunRecord>;
  scheduleRunCleanup: (runId: string, requestId: string) => void;
  afterRunStarted?: (runId: string) => void;
  onMissingRootRunId?: (event: StreamEventBase) => void;
};

const withRequest = <T extends Record<string, unknown>>(
  event: T,
  conversationId: string,
  requestId: string,
) => ({
  ...event,
  conversationId,
  requestId,
});

export const createLocalChatStreamCallbacks = (
  options: LocalChatStreamCallbackOptions,
) => {
  const {
    conversationId,
    requestId,
    senderWebContentsId,
    emitAgentEvent,
    terminalRunIds,
    runOwners,
    runToRequestId,
    requestToRunId,
    activeRunByConversation,
    scheduleRunCleanup,
    afterRunStarted,
    onMissingRootRunId,
  } = options;

  const emit = (event: Record<string, unknown>) =>
    emitAgentEvent(event, senderWebContentsId);

  return {
    onRunStarted: (ev: StreamEventBase) => {
      if (ev.uiVisibility === "hidden") {
        return;
      }
      terminalRunIds.delete(ev.runId);
      runOwners.set(ev.runId, senderWebContentsId);
      runToRequestId.set(ev.runId, requestId);
      requestToRunId.set(requestId, ev.runId);
      activeRunByConversation.set(conversationId, {
        runId: ev.runId,
        conversationId,
        requestId,
        userMessageId: ev.userMessageId,
        uiVisibility: ev.uiVisibility,
      });
      emit({
        type: AGENT_STREAM_EVENT_TYPES.RUN_STARTED,
        runId: ev.runId,
        conversationId,
        requestId,
        ...(ev.userMessageId ? { userMessageId: ev.userMessageId } : {}),
        ...(ev.uiVisibility ? { uiVisibility: ev.uiVisibility } : {}),
        ...(ev.agentType ? { agentType: ev.agentType } : {}),
      });
      afterRunStarted?.(ev.runId);
    },
    onStream: (ev: StreamEventBase) =>
      emit(
        withRequest(
          { ...ev, type: AGENT_STREAM_EVENT_TYPES.STREAM },
          conversationId,
          requestId,
        ),
      ),
    onAssistantMessage: (ev: StreamEventBase) =>
      emit(
        withRequest(
          { ...ev, type: AGENT_STREAM_EVENT_TYPES.ASSISTANT_MESSAGE },
          conversationId,
          requestId,
        ),
      ),
    onStatus: (ev: StreamEventBase) =>
      emit(
        withRequest(
          { ...ev, type: AGENT_STREAM_EVENT_TYPES.STATUS },
          conversationId,
          requestId,
        ),
      ),
    onToolStart: (ev: StreamEventBase) =>
      emit(
        withRequest(
          { ...ev, type: AGENT_STREAM_EVENT_TYPES.TOOL_START },
          conversationId,
          requestId,
        ),
      ),
    onToolEnd: (ev: StreamEventBase) =>
      emit(
        withRequest(
          { ...ev, type: AGENT_STREAM_EVENT_TYPES.TOOL_END },
          conversationId,
          requestId,
        ),
      ),
    onRunFinished: (ev: StreamEventBase) => {
      if (terminalRunIds.has(ev.runId)) {
        return;
      }
      terminalRunIds.add(ev.runId);
      emit({
        type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
        runId: ev.runId,
        conversationId,
        requestId,
        agentType: ev.agentType,
        userMessageId: ev.userMessageId,
        finalText: ev.finalText,
        persisted: ev.persisted,
        error: ev.error,
        outcome: ev.outcome ?? AGENT_RUN_FINISH_OUTCOMES.ERROR,
        reason: ev.reason ?? ev.error,
      });
      scheduleRunCleanup(ev.runId, requestId);
    },
    onAgentEvent: (ev: StreamEventBase) => {
      if (!ev.rootRunId) {
        onMissingRootRunId?.(ev);
        return;
      }
      emit({
        type: ev.type,
        runId: ev.rootRunId,
        rootRunId: ev.rootRunId,
        conversationId,
        requestId,
        userMessageId: ev.userMessageId,
        agentId: ev.agentId,
        agentType: ev.agentType,
        description: ev.description,
        parentAgentId: ev.parentAgentId,
        result: ev.result,
        error: ev.error,
        statusText: ev.statusText,
        groupKey: ev.groupKey,
        groupLabel: ev.groupLabel,
      });
    },
    onAgentReasoning: (ev: StreamEventBase) => {
      if (!ev.agentId) {
        return;
      }
      const runId = ev.rootRunId ?? ev.runId;
      emit({
        type: AGENT_STREAM_EVENT_TYPES.AGENT_REASONING,
        runId,
        rootRunId: runId,
        conversationId,
        requestId,
        userMessageId: ev.userMessageId,
        agentId: ev.agentId,
        agentType: ev.agentType,
        chunk: ev.chunk,
      });
    },
  };
};
