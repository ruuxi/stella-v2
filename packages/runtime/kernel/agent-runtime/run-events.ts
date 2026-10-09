import {
  redactSensitiveText,
  sanitizeSensitiveData,
} from "@stella/contracts/sensitive-data";
import type { AgentMessage } from "../agent-core/types.js";
import {
  assistantMessageHasToolCall,
  extractAssistantText,
  getToolResultPreview,
  now,
} from "./shared.js";
import type {
  RuntimeEndEvent,
  RuntimeErrorEvent,
  RuntimeAssistantMessageEvent,
  RuntimeInterruptedEvent,
  RuntimeReasoningEvent,
  RuntimeRunStartedEvent,
  RuntimeStatusEvent,
  RuntimeProviderLifecycleEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
} from "./types.js";
import type { RuntimeAgentEventPayload } from "@stella/contracts/protocol";
import { splitReplyRefs } from "@stella/contracts/reply-refs";

type RunRecorderArgs = {
  runId: string;
  agentType: string;
  userMessageId: string;
  uiVisibility?: "visible" | "hidden";
  getResponseTarget?: () => RuntimeAgentEventPayload["responseTarget"];
};

export type RuntimeRunEventRecorder = ReturnType<typeof createRunEventRecorder>;

export const createRunEventRecorder = ({
  runId,
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
    // The reply-refs fence is model-facing: it leaves here as structured
    // citations and never reaches a user-visible copy of the text. The
    // model's own thread history is persisted from the raw AgentMessage, so
    // it still sees the block it wrote.
    const { text: visibleText, refs: replyRefs } = splitReplyRefs(text);
    const trimmedText = visibleText.trim();
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
      ...(replyRefs.length > 0 ? { replyRefs } : {}),
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

    /**
     * Observe one assistant text delta.
     *
     * Assistant text is delivered whole (one assistant-message event per
     * segment), so a delta produces no event and consumes no recorder seq.
     * All this does is stamp the segment's first-text time — see
     * `pendingSegmentFirstTextAtMs`.
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
