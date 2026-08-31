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
import { assistantMessageHasUsableOutput } from "./run-shared.js";
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
  RuntimeProviderLifecycleEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
} from "./types.js";
import type { RuntimeAgentEventPayload } from "@stella/contracts/protocol";

const logger = createRuntimeLogger("agent-runtime.events");

type PersistedAssistantContent = Extract<
  PersistedRuntimeThreadPayload,
  { role: "assistant" }
>["content"];

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
  /**
   * Wall-clock time of the first text delta of the assistant segment that is
   * currently generating, or null between segments.
   *
   * Assistant text no longer travels as per-chunk STREAM events, so this is
   * the only surviving reason to watch deltas at all: it is the chronological
   * anchor the renderer uses to order lifecycle cards against the finished
   * text block. It rides out on the assistant-message event as
   * `firstTextAtMs`; the worker used to derive the same value from the first
   * `onStream` chunk it forwarded.
   */
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
    // Consumed once; the next segment stamps a fresh anchor. Left set when the
    // segment produced no persistable text, so an empty flush cannot steal the
    // anchor from the text that follows it.
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

    /**
     * Observe one assistant text delta.
     *
     * Assistant text is delivered whole (one assistant-message event per
     * segment), so a delta produces no event and consumes no recorder seq.
     * All this does is stamp the segment's first-text time — see
     * `pendingSegmentFirstTextAtMs`. Per-chunk `run_event` rows are
     * deliberately not persisted any more: nothing ever read them back
     * (`run_event` rows are excluded from every history query) and they cost
     * one SQLite transaction per token.
     */
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

    recordProviderLifecycle(
      event:
        | import("./provider-stream-lifecycle.js").ProviderStreamLifecycleEvent
        | import("./provider-stream-lifecycle.js").ProviderStreamSettlementEvent,
    ): RuntimeProviderLifecycleEvent {
      return {
        runId,
        agentType,
        seq: nextSeq(),
        providerLifecyclePhase: event.phase,
        providerRequestIdSha256: event.requestIdSha256,
        providerPhysicalAttempt: event.physicalAttempt,
        providerStreamOrdinal: event.streamOrdinal,
        providerName: event.provider,
        providerModelId: event.modelId,
        ...(event.outcome ? { providerOutcome: event.outcome } : {}),
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
          // Structured side-channels (schedule receipts, image metadata, etc.)
          // live in `details`; previews must stay human-readable.
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

/**
 * Build the common runtime context block injected into hook payloads.
 *
 * Centralized so every hook emission inside the run loop carries a consistent
 * shape (conversationId, threadKey, runId, isUserTurn, uiVisibility) without
 * each call site reconstructing it. Hooks that don't care can ignore the
 * extras; hooks that do care don't have to root around for them.
 */
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
  // Progress payloads (exec_command results, pretty-printed objects) are
  // model-facing, not working-indicator copy.
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
  stellaDataDir,
  afterDurableMessagePersisted,
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
  stellaDataDir?: string;
  /** Crash-injection seam used to prove delivery acknowledgement ordering. */
  afterDurableMessagePersisted?: (
    payload: PersistedRuntimeThreadPayload,
  ) => void;
  onThreadPersistenceError?: (error: unknown, retry: () => void) => void;
}) => {
  // Stable run-level fields shared by every hook payload from this subscription.
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
      // Keep queued user-message ids consistent between recorder and hooks.
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
          afterDurableMessagePersisted?.(payload);
          if (
            payload.role === "toolResult" &&
            payload.toolName === "image_gen" &&
            conversationId
          ) {
            markImageOperationDelivered({
              stellaDataDir,
              conversationId,
              toolCallId: payload.toolCallId,
            });
          }
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

      // Observation-only; this fires after persistence and cannot replace the message.
      emitHook(
        hookEmitter,
        "message_end",
        { ...hookContext, agentType, message: event.message },
        hookFilter,
      );
      return;
    }

    if (event.type === "message_update") {
      // Assistant text is delivered whole on `message_end`; deltas only feed
      // the segment first-text anchor and the subagent Activity feed.
      if (event.assistantMessageEvent.type === "text_delta") {
        const chunk = event.assistantMessageEvent.delta;
        if (chunk) {
          recorder.noteAssistantTextChunk(chunk);
          onProgress?.(chunk);
        }
      } else if (event.assistantMessageEvent.type === "thinking_delta") {
        // Reasoning deltas stream to the per-agent reasoning section, not chat text.
        const chunk = event.assistantMessageEvent.delta;
        if (chunk) {
          const reasoningEvent = recorder.recordReasoning(chunk);
          callbacks?.onReasoning?.(reasoningEvent);
        }
      } else if (event.assistantMessageEvent.type === "thinking_end") {
        // Persisted on the assistant message; no user-facing event.
      }

      // Avoid per-token hook payload work when no hook consumes message updates.
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
    const trimmedContent: PersistedAssistantContent = [];
    for (const block of message.content) {
      if (block.type !== "text") {
        trimmedContent.push(block);
        continue;
      }
      const trimmed = block.text.trim();
      if (trimmed) {
        trimmedContent.push({ ...block, text: trimmed });
      }
    }
    // The retry ladder pops a no-usable-output assistant tail from the live
    // context before resuming, and nothing removes rows from the durable
    // transcript — so persisting one here orphans it: the store keeps a reply
    // the model no longer has, and the next rebuild (compaction, an external
    // writer, app restart) hands the provider two consecutive assistant
    // messages. Checking emptiness alone missed the thinking-only message a
    // reasoning model produces when it exhausts the output cap while
    // reasoning; this is the ladder's own predicate, so the two cannot drift.
    if (
      trimmedContent.length === 0 ||
      !assistantMessageHasUsableOutput({ ...message, content: trimmedContent })
    ) {
      return null;
    }
    return {
      ...message,
      content: trimmedContent,
    };
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
  // runtimeInternal messages are not universally durable; producers persist
  // durable cases at emit time, before queueing them into the agent loop.
  return null;
};
