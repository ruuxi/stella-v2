import { RUNTIME_RUN_EVENT_TYPES } from "@stella/contracts/agent-runtime";
import {
  redactSensitiveText,
  sanitizeSensitiveData,
} from "@stella/contracts/sensitive-data";
import type { AgentEvent, AgentMessage } from "../agent-core/types.js";
import { createRuntimeLogger } from "../debug.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type {
  HookEvent,
  HookEventMap,
  HookRuntimeContext,
} from "../extensions/types.js";
import type { PersistedRuntimeThreadPayload } from "../storage/shared.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import {
  assistantMessageHasToolCall,
  extractAssistantText,
  getToolResultPreview,
  now,
} from "./shared.js";
import {
  persistThreadPayloadMessage,
  persistThreadPayloadMessages,
} from "./thread-memory.js";
import { markImageOperationDelivered } from "../tools/image-operation-store.js";
import type {
  RuntimeEndEvent,
  RuntimeErrorEvent,
  RuntimeAssistantMessageEvent,
  RuntimeInterruptedEvent,
  RuntimeReasoningEvent,
  RuntimeRunCallbacks,
  RuntimeRunStartedEvent,
  RuntimeStatusEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
} from "./types.js";
import type { RuntimeAgentEventPayload } from "@stella/contracts/protocol";

const logger = createRuntimeLogger("agent-runtime.events");

type RuntimeAgentLike = {
  state: {
    messages: AgentMessage[];
  };
  subscribe: (listener: (event: AgentEvent) => void) => () => void;
};

type RunRecorderArgs = {
  store: RuntimeStore;
  runId: string;
  conversationId: string;
  agentType: string;
  userMessageId: string;
  uiVisibility?: "visible" | "hidden";
  getResponseTarget?: () => RuntimeAgentEventPayload["responseTarget"];
};

export type RuntimeRunEventRecorder = ReturnType<typeof createRunEventRecorder>;

export const createRunEventRecorder = ({
  store,
  runId,
  conversationId,
  agentType,
  userMessageId,
  uiVisibility,
  getResponseTarget,
}: RunRecorderArgs) => {
  let seq = 0;
  let currentUserMessageId = userMessageId;
  let currentUiVisibility = uiVisibility;

  let pendingSegmentFirstTextAtMs: number | null = null;
  const queuedUserMessageStarts: Array<{
    userMessageId: string;
    onStart?: () => void;
    uiVisibility?: "visible" | "hidden";
  }> = [];
  const nextSeq = () => ++seq;
  const recordAssistantTextEnd = (
    text: string,
    timestamp: number = now(),
  ): RuntimeAssistantMessageEvent | null => {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return null;
    }
    const firstTextAtMs = pendingSegmentFirstTextAtMs;

    pendingSegmentFirstTextAtMs = null;
    const responseTarget = getResponseTarget?.();
    return {
      runId,
      agentType,
      seq: nextSeq(),
      userMessageId: currentUserMessageId,
      text: trimmedText,
      timestamp,
      ...(firstTextAtMs !== null ? { firstTextAtMs } : {}),
      ...(responseTarget ? { responseTarget } : {}),
      ...(currentUiVisibility ? { uiVisibility: currentUiVisibility } : {}),
    };
  };

  return {
    queueUserMessageId(
      nextUserMessageId: string,
      onStart?: () => void,
      nextUiVisibility?: "visible" | "hidden",
    ): void {
      const trimmed = nextUserMessageId.trim();
      if (trimmed) {
        queuedUserMessageStarts.push({
          userMessageId: trimmed,
          ...(onStart ? { onStart } : {}),
          ...(nextUiVisibility ? { uiVisibility: nextUiVisibility } : {}),
        });
      }
    },

    recordQueuedUserMessageStart(): RuntimeRunStartedEvent | null {
      const nextQueuedUserMessage = queuedUserMessageStarts.shift();
      if (!nextQueuedUserMessage) {
        return null;
      }
      nextQueuedUserMessage.onStart?.();
      currentUserMessageId = nextQueuedUserMessage.userMessageId;
      if (nextQueuedUserMessage.uiVisibility) {
        currentUiVisibility = nextQueuedUserMessage.uiVisibility;
      }
      const responseTarget = getResponseTarget?.();
      return {
        runId,
        agentType,
        seq: nextSeq(),
        userMessageId: currentUserMessageId,
        ...(responseTarget ? { responseTarget } : {}),
        ...(currentUiVisibility ? { uiVisibility: currentUiVisibility } : {}),
      };
    },

    recordAssistantMessageEnd(
      message: AgentMessage,
    ): RuntimeAssistantMessageEvent | null {
      const text = extractAssistantText(message).trim();
      const event = recordAssistantTextEnd(text, message.timestamp);
      if (event && assistantMessageHasToolCall(message)) {
        event.followedByToolCall = true;
      }
      return event;
    },
    recordAssistantTextEnd,

    recordRunStart(): void {
      store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId,
        agentType,
        type: RUNTIME_RUN_EVENT_TYPES.RUN_START,
      });
    },

    noteAssistantTextChunk(chunk: string): void {
      if (!chunk || pendingSegmentFirstTextAtMs !== null) {
        return;
      }
      pendingSegmentFirstTextAtMs = now();
    },

    recordReasoning(chunk: string): RuntimeReasoningEvent {
      const seq = nextSeq();
      const responseTarget = getResponseTarget?.();
      return {
        runId,
        agentType,
        seq,
        chunk: redactSensitiveText(chunk),
        userMessageId: currentUserMessageId,
        ...(responseTarget ? { responseTarget } : {}),
        ...(currentUiVisibility ? { uiVisibility: currentUiVisibility } : {}),
      };
    },

    recordStatus(
      statusText: string,
      statusState: RuntimeStatusEvent["statusState"] = "running",
    ): RuntimeStatusEvent {
      const seq = nextSeq();
      return {
        runId,
        agentType,
        seq,
        statusState,
        statusText: redactSensitiveText(statusText),
        ...(currentUiVisibility ? { uiVisibility: currentUiVisibility } : {}),
      };
    },

    recordToolStart(args: {
      toolCallId: string;
      toolName: string;
      statusText?: string;
      toolArgs: Record<string, unknown>;
    }): RuntimeToolStartEvent {
      const seq = nextSeq();
      const toolCallId = redactSensitiveText(args.toolCallId);
      const toolName = redactSensitiveText(args.toolName);
      const sanitizedArgs = sanitizeSensitiveData(args.toolArgs) as Record<
        string,
        unknown
      >;
      store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId,
        agentType,
        seq,
        type: RUNTIME_RUN_EVENT_TYPES.TOOL_START,
        toolCallId,
        toolName,
      });
      return {
        runId,
        agentType,
        seq,
        toolCallId,
        toolName,
        ...(args.statusText
          ? { statusText: redactSensitiveText(args.statusText) }
          : {}),
        args: sanitizedArgs,
        ...(currentUiVisibility ? { uiVisibility: currentUiVisibility } : {}),
      };
    },

    recordToolEnd(args: {
      toolCallId: string;
      toolName: string;
      result: unknown;
      details?: unknown;
      isError?: boolean;
    }): RuntimeToolEndEvent {
      const toolCallId = redactSensitiveText(args.toolCallId);
      const toolName = redactSensitiveText(args.toolName);
      const sanitizedResult = sanitizeSensitiveData(args.result);
      const sanitizedDetails = sanitizeSensitiveData(args.details);
      const resultPreview = redactSensitiveText(
        getToolResultPreview(
          toolName,

          sanitizedResult ?? sanitizedDetails,
        ),
      );
      const seq = nextSeq();
      store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId,
        agentType,
        seq,
        type: RUNTIME_RUN_EVENT_TYPES.TOOL_END,
        toolCallId,
        toolName,
        resultPreview,
        isError: args.isError === true,
      });
      return {
        runId,
        agentType,
        seq,
        toolCallId,
        toolName,
        resultPreview,
        isError: args.isError === true,
        ...(args.details !== undefined ? { details: sanitizedDetails } : {}),
        ...(currentUiVisibility ? { uiVisibility: currentUiVisibility } : {}),
      };
    },

    recordRunEnd(args: {
      finalText: string;
      responseTarget?: RuntimeEndEvent["responseTarget"];
    }): RuntimeEndEvent {
      const seq = nextSeq();
      store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId,
        agentType,
        seq,
        type: RUNTIME_RUN_EVENT_TYPES.RUN_END,
        finalText: args.finalText,
      });
      return {
        runId,
        agentType,
        seq,
        userMessageId: currentUserMessageId,
        finalText: args.finalText,
        persisted: true,
        ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
        ...(currentUiVisibility ? { uiVisibility: currentUiVisibility } : {}),
      };
    },

    recordError(error: string): RuntimeErrorEvent {
      const seq = nextSeq();
      store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId,
        agentType,
        seq,
        type: RUNTIME_RUN_EVENT_TYPES.ERROR,
        error,
        fatal: true,
      });
      return {
        runId,
        agentType,
        seq,
        error,
        fatal: true,
        ...(currentUiVisibility ? { uiVisibility: currentUiVisibility } : {}),
      };
    },

    recordInterrupted(reason: string): RuntimeInterruptedEvent {
      const seq = nextSeq();
      store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId,
        agentType,
        seq,
        type: "interrupted",
        error: reason,
        fatal: false,
      });
      return {
        runId,
        agentType,
        seq,
        userMessageId: currentUserMessageId,
        reason,
        ...(currentUiVisibility ? { uiVisibility: currentUiVisibility } : {}),
      };
    },
  };
};

const emitHook = <E extends HookEvent>(
  hookEmitter: HookEmitter | undefined,
  event: E,
  payload: HookEventMap[E]["payload"],
  filterContext: { tool?: string; agentType?: string },
) => {
  if (!hookEmitter) {
    return;
  }

  void hookEmitter.emit(event, payload, filterContext).catch(() => undefined);
};

const buildHookRuntimeContext = (args: {
  conversationId?: string;
  threadKey?: string;
  runId: string;
  uiVisibility?: "visible" | "hidden";
}): HookRuntimeContext => ({
  ...(args.conversationId ? { conversationId: args.conversationId } : {}),
  ...(args.threadKey ? { threadKey: args.threadKey } : {}),
  runId: args.runId,
  ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
  isUserTurn: args.uiVisibility !== "hidden",
});

const looksLikeMachineStatusText = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
  if (trimmed.includes("\n") && /[{[]/.test(trimmed)) return true;
  if (
    /^Wall time: [^\n]+ seconds\nProcess (?:running with session ID|exited with code) [^\n]+\nOriginal token count: \d+\n/.test(
      trimmed,
    )
  ) {
    return true;
  }
  return /"(?:session_id|exit_code|wall_time_seconds|original_token_count)"\s*:/.test(
    trimmed,
  );
};

const extractToolUpdateStatusText = (
  event: Extract<AgentEvent, { type: "tool_execution_update" }>,
): string | undefined => {
  const details =
    typeof event.partialResult.details === "object" &&
    event.partialResult.details !== null
      ? (event.partialResult.details as { statusText?: unknown })
      : null;
  if (typeof details?.statusText === "string" && details.statusText.trim()) {
    const explicit = details.statusText.trim();
    return looksLikeMachineStatusText(explicit) ? undefined : explicit;
  }
  const firstTextBlock = event.partialResult.content.find(
    (block) => block.type === "text" && block.text.trim().length > 0,
  );
  if (firstTextBlock?.type !== "text") {
    return undefined;
  }
  const text = firstTextBlock.text.trim();

  return looksLikeMachineStatusText(text) ? undefined : text;
};

export const subscribeRuntimeAgentEvents = ({
  agent,
  runId,
  agentType,
  recorder,
  callbacks,
  onProgress,
  displayEventHandler,
  hookEmitter,
  threadStore,
  threadKey,
  conversationId,
  uiVisibility,
  attemptGeneration,
  onThreadPersistenceError,
}: {
  agent: RuntimeAgentLike;
  runId: string;
  agentType: string;
  recorder: RuntimeRunEventRecorder;
  callbacks?: Partial<RuntimeRunCallbacks>;
  onProgress?: (chunk: string) => void;
  displayEventHandler?: (event: AgentEvent) => boolean;
  hookEmitter?: HookEmitter;
  threadStore?: RuntimeStore;
  threadKey?: string;
  conversationId?: string;
  uiVisibility?: "visible" | "hidden";
  attemptGeneration?: number;
  onThreadPersistenceError?: (error: unknown, retry: () => void) => void;
}) => {

  const hookContext = buildHookRuntimeContext({
    ...(conversationId ? { conversationId } : {}),
    ...(threadKey ? { threadKey } : {}),
    runId,
    ...(uiVisibility ? { uiVisibility } : {}),
  });
  const hookFilter = { agentType };

  return agent.subscribe((event) => {
    if (event.type === "agent_start") {
      emitHook(
        hookEmitter,
        "agent_start",
        { ...hookContext, agentType },
        hookFilter,
      );
      return;
    }

    if (event.type === "message_start") {

      if (event.message.role === "user") {
        const runStartedEvent = recorder.recordQueuedUserMessageStart();
        if (runStartedEvent) {
          callbacks?.onRunStarted?.(runStartedEvent);
        }
      }
      emitHook(
        hookEmitter,
        "message_start",
        { ...hookContext, agentType, message: event.message },
        hookFilter,
      );
      return;
    }

    if (event.type === "message_end") {
      if (threadStore && threadKey && agentType !== "orchestrator") {
        const payload = toPersistedThreadPayload(event.message);
        if (
          payload &&
          (payload.role !== "user" || agentType !== "orchestrator")
        ) {
          persistThreadPayloadMessage(threadStore, {
            threadKey,
            payload,
            runId,
            ...(typeof attemptGeneration === "number"
              ? { attemptGeneration }
              : {}),
          });
        }
      }

      if (event.message.role === "assistant") {
        const assistantMessageEvent = recorder.recordAssistantMessageEnd(
          event.message,
        );
        if (assistantMessageEvent) {
          callbacks?.onAssistantMessage?.(assistantMessageEvent);
        }
      }

      emitHook(
        hookEmitter,
        "message_end",
        { ...hookContext, agentType, message: event.message },
        hookFilter,
      );
      return;
    }

    if (event.type === "message_update") {

      if (event.assistantMessageEvent.type === "text_delta") {
        const chunk = event.assistantMessageEvent.delta;
        if (chunk) {
          recorder.noteAssistantTextChunk(chunk);
          onProgress?.(chunk);
        }
      } else if (event.assistantMessageEvent.type === "thinking_delta") {

        const chunk = event.assistantMessageEvent.delta;
        if (chunk) {
          const reasoningEvent = recorder.recordReasoning(chunk);
          callbacks?.onReasoning?.(reasoningEvent);
        }
      } else if (event.assistantMessageEvent.type === "thinking_end") {

      }

      if (hookEmitter && hookEmitter.has("message_update")) {
        emitHook(
          hookEmitter,
          "message_update",
          {
            ...hookContext,
            agentType,
            message: event.message,
            assistantMessageEvent: event.assistantMessageEvent,
          },
          hookFilter,
        );
      }
      return;
    }

    if (displayEventHandler?.(event)) {
      return;
    }

    if (event.type === "tool_execution_start") {
      logger.debug("tool.start", {
        runId,
        agentType,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
        statusText: event.statusText,
      });
      if (event.statusText) {
        callbacks?.onStatus?.(recorder.recordStatus(event.statusText));
      }
      const toolStartEvent = recorder.recordToolStart({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.statusText ? { statusText: event.statusText } : {}),
        toolArgs: (event.args as Record<string, unknown>) ?? {},
      });
      callbacks?.onToolStart?.(toolStartEvent);
      emitHook(
        hookEmitter,
        "tool_execution_start",
        {
          ...hookContext,
          agentType,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(event.statusText ? { statusText: event.statusText } : {}),
          args: (event.args as Record<string, unknown>) ?? {},
        },
        { agentType, tool: event.toolName },
      );
      return;
    }

    if (event.type === "tool_execution_end") {
      const toolEndEvent = recorder.recordToolEnd({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        details: event.result.details,
        isError: event.isError,
      });
      logger.debug("tool.end", {
        agentType,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        resultPreview: toolEndEvent.resultPreview.slice(0, 200),
      });
      callbacks?.onToolEnd?.(toolEndEvent);
      emitHook(
        hookEmitter,
        "tool_execution_end",
        {
          ...hookContext,
          agentType,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        },
        { agentType, tool: event.toolName },
      );
      return;
    }

    if (event.type === "tool_execution_update") {
      const statusText = extractToolUpdateStatusText(event);
      if (statusText) {
        callbacks?.onStatus?.(recorder.recordStatus(statusText));
      }
      emitHook(
        hookEmitter,
        "tool_execution_update",
        {
          ...hookContext,
          agentType,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: (event.args as Record<string, unknown>) ?? {},
          partialResult: event.partialResult,
        },
        { agentType, tool: event.toolName },
      );
      return;
    }

    if (event.type === "turn_start") {
      emitHook(
        hookEmitter,
        "turn_start",
        {
          ...hookContext,
          agentType,
          messageCount: agent.state.messages.length,
        },
        hookFilter,
      );
      return;
    }

    if (event.type === "turn_end") {
      if (threadStore && threadKey && agentType === "orchestrator") {
        const payloads = [event.message, ...event.toolResults]
          .map(toPersistedThreadPayload)
          .filter(
            (payload): payload is PersistedRuntimeThreadPayload =>
              payload !== null,
          );
        if (payloads.length > 0) {
          const persistCompletedGroup = () =>
            persistThreadPayloadMessages(threadStore, {
              threadKey,
              payloads,
              runId,
              ...(typeof attemptGeneration === "number"
                ? { attemptGeneration }
                : {}),
              preservePayloadExactly: true,
            });
          try {
            persistCompletedGroup();
          } catch (error) {
            logger.error("thread.turn-group-persistence-failed", {
              threadKey,
              runId,
              messageCount: payloads.length,
              error: error instanceof Error ? error.message : String(error),
            });
            onThreadPersistenceError?.(error, persistCompletedGroup);
          }
        }
      }
      const turnText =
        event.message?.role === "assistant"
          ? extractAssistantText(event.message)
          : "";
      emitHook(
        hookEmitter,
        "turn_end",
        { ...hookContext, agentType, assistantText: turnText },
        hookFilter,
      );
    }
  });
};

const toPersistedThreadPayload = (
  message: AgentMessage,
): PersistedRuntimeThreadPayload | null => {
  if (message.role === "assistant") {
    if (message.content.length === 0) {
      if (message.stopReason !== "error" && message.stopReason !== "aborted") {
        return null;
      }
      return {
        ...message,
        content: [{ type: "text", text: "" }],
      };
    }
    return message;
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      ...(typeof message.modelOutputTokens === "number"
        ? { modelOutputTokens: message.modelOutputTokens }
        : {}),
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }

  return null;
};
