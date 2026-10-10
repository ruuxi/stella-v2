import crypto from "node:crypto";
import { Context, Effect, Layer } from "effect";
import {
  METHOD_NAMES,
  type RuntimeAgentEventPayload,
  type RuntimeAttachmentRef,
  type RuntimeChatPayload,
  type RuntimePromptMessage,
  type RuntimeOneShotCompletionRequest,
  type RuntimeOneShotCompletionResult,
} from "@stella/contracts/protocol";
import {
  AGENT_IDS,
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
} from "@stella/contracts/agent-runtime";
import type { ImageCapTarget } from "../../../ai/utils/image-caps.js";
import type { RawReplyRef, ReplyRef } from "@stella/contracts/reply-refs";
import { prepareStoredLocalChatPayload } from "../../../kernel/storage/local-chat-payload.js";
import { RunAdmissionStore } from "../../../kernel/storage/run-admission.js";
import type { LocalChatEventRecord } from "../../../kernel/storage/shared.js";
import {
  resolveConversationStorageMode,
  shouldPersistLocalChatTranscript,
} from "../../../kernel/runner/conversation-storage-mode.js";
import { createRuntimeLogger } from "../../../kernel/debug.js";
import {
  approximateDataUrlBytes,
  attachPersistedImagePaths,
  buildSpilledAttachmentNotice,
  dataUrlBase64Length,
  INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES,
  MAX_INLINE_IMAGE_BASE64_BYTES,
  spillImageAttachmentsToDisk,
  type SpilledImageAttachment,
} from "../../chat-attachment-spill.js";
import {
  asTrimmedString,
  materializeImageAttachments,
  materializeFileAttachments,
} from "../attachments.js";
import * as HostBus from "../host-bus.js";
import * as SessionConfig from "./config.js";
import * as SessionStorage from "./storage.js";
import * as RunEventBus from "./run-events.js";
import * as RunnerHandle from "./runner.js";
import type { AgentEventPayload } from "../types.js";
import type { AgentCallbacks } from "../../../kernel/runner/types.js";
import { HOST_CHALLENGE_TOKEN_METHOD } from "../../../host/challenge-token-method.js";
import {
  createRemoteDeviceSigner,
  HOST_DEVICE_SIGNING_METHOD,
} from "../../../host/device-signing-method.js";

const logger = createRuntimeLogger("worker.server");

/**
 * The chat/agent-run domain: the startChat pipeline (attachment
 * materialization → prompt assembly → runner callbacks → run-event
 * emission), agent input delivery, automation turns, and one-shot
 * completions. The runner event callbacks stay plain synchronous closures —
 * the runner invokes them from non-Effect code mid-stream — capturing the
 * session's storage/run-event services.
 */
export interface Interface {
  readonly startChat: (
    payload: RuntimeChatPayload,
  ) => Promise<Record<string, unknown>>;
  /** Params are pre-validated by the handler (validation precedes the
   * runner-readiness guard, as before). */
  readonly sendAgentInput: (payload: {
    conversationId: string;
    threadId: string;
    message: string;
    metadata?: Record<string, unknown>;
  }) => Promise<{ delivered: true }>;
  readonly runAutomation: (payload: {
    conversationId: string;
    userPrompt: string;
    rejectIfBusy?: boolean;
    executionPlacementRunId?: string;
    ownerGeneration?: string;
    agentType?: string;
    modelOverride?: string;
    toolWorkspaceRoot?: string;
    attachments?: RuntimeAttachmentRef[];
    connectorDeliveryTarget?: {
      requestId: string;
      conversationId: string;
      provider?: string;
      externalMessageId?: string;
    };
    userMessageEventId?: string;
    /** A human typed this prompt on another device; see the protocol type. */
    userAuthoredPrompt?: boolean;
  }) => Promise<unknown>;
  /**
   * Turn a placed agent's attachments into real local files before the agent
   * starts. The host resolved each one to a short-lived signed drive GET; the
   * bytes land in this profile's conversation attachment cache and the agent
   * is handed absolute paths, which is the only form it can act on.
   */
  readonly materializeAgentAttachments: (payload: {
    conversationId: string;
    attachments?: RuntimeAttachmentRef[];
  }) => Promise<RuntimeAttachmentRef[]>;
  readonly oneShotCompletion: (
    request: RuntimeOneShotCompletionRequest,
  ) => Promise<RuntimeOneShotCompletionResult>;
  /**
   * Relaunch the chat runs a previous worker process left running, with
   * client callbacks rebuilt from each run's launch record. Runs post-ready,
   * once the runner is initialized.
   */
  readonly resumeInterruptedRuns: () => Promise<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/AgentRuns",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hostBus = yield* HostBus.Service;
    const config = yield* SessionConfig.Service;
    const storage = yield* SessionStorage.Service;
    const runEvents = yield* RunEventBus.Service;
    const runnerHandle = yield* RunnerHandle.Service;
    const admissions = new RunAdmissionStore(storage.db);
    /**
     * Admissions this worker process is still starting (attachment
     * materialization, queued behind an active run), keyed by
     * `[conversationId, admissionKey]`. A concurrent duplicate awaits the
     * original instead of reading a row that has no run yet.
     */
    const inFlightAdmissions = new Map<
      string,
      Promise<Record<string, unknown>>
    >();
    let deviceSignerPromise: ReturnType<typeof createRemoteDeviceSigner> | null =
      null;
    const getDeviceSigner = () => {
      const pending =
        deviceSignerPromise ??
        createRemoteDeviceSigner((input) =>
          hostBus.request(
            HOST_DEVICE_SIGNING_METHOD,
            { input },
            { retryOnDisconnect: true },
          ),
        );
      deviceSignerPromise = pending;
      void pending.catch(() => {
        if (deviceSignerPromise === pending) deviceSignerPromise = null;
      });
      return pending;
    };

    // Lazy loaders for the runner subgraph. one-shot-completion.ts and
    // chat-prompt-context.ts share ~80 files with runner.ts and are only
    // needed once a turn/review actually runs. The dynamic import()s are
    // also what let esbuild split them into their own chunk.
    let oneShotCompletionModule: Promise<
      typeof import("../../../kernel/agent-runtime/one-shot-completion.js")
    > | null = null;
    const loadOneShotCompletion = () =>
      (oneShotCompletionModule ??=
        import("../../../kernel/agent-runtime/one-shot-completion.js"));
    let chatPromptContextModule: Promise<
      typeof import("../../../kernel/chat-prompt-context.js")
    > | null = null;
    const loadChatPromptContext = () =>
      (chatPromptContextModule ??=
        import("../../../kernel/chat-prompt-context.js"));

    /**
     * Append a fresh persisted assistant row for one completed assistant
     * message within a run. A Pi orchestrator run may emit several
     * assistant messages (preamble, post-tool answer, …); each gets its
     * own row keyed by `(runId, seq)` so they render linearly in
     * chronological order rather than collapsing into a single
     * `assistant-for-<userMessageId>` row that overwrites itself.
     *
     * Returns the persisted event so callers can track the latest row.
     */
    const appendAssistantMessageForTurn = (args: {
      conversationId: string;
      text: string;
      userMessageId: string;
      runId: string;
      seq: number;
      timezone?: string;
      responseTarget?: RuntimeAgentEventPayload["responseTarget"];
      replyRefs?: RawReplyRef[];
      streamStartedAtMs?: number;
      followedByToolCall?: boolean;
    }): { event: LocalChatEventRecord; replyRefs: ReplyRef[] } | null => {
      const trimmedText = args.text.trim();
      if (!trimmedText) {
        return null;
      }

      // Citations the model wrote resolve against this conversation now, so
      // the stored row (and the `entry_ref` index written with it) never
      // points at a message or thread that does not exist. A lifecycle turn
      // that cited nothing still attaches to the agent it reports on.
      const fallbackAgentId =
        args.responseTarget && args.responseTarget.type !== "user_turn"
          ? args.responseTarget.agentId
          : undefined;
      const replyRefs = storage.chatStore.chat.resolveReplyRefs(
        args.conversationId,
        args.replyRefs ?? [],
        {
          excludeMessageId: args.userMessageId,
          ...(fallbackAgentId ? { fallbackAgentId } : {}),
        },
      );

      const runtimeMetadata = {
        runtime: {
          ...(args.followedByToolCall ? { followedByToolCall: true } : {}),
          ...(args.responseTarget
            ? { responseTarget: args.responseTarget }
            : {}),
          ...(replyRefs.length > 0 ? { replyRefs } : {}),
          ...(Number.isFinite(args.streamStartedAtMs)
            ? { streamStartedAtMs: args.streamStartedAtMs }
            : {}),
        },
      };

      const eventId = `assistant-msg-${args.runId}-${args.seq}`;
      const event = storage.appendChatEventAndNotify({
        conversationId: args.conversationId,
        eventId,
        type: "assistant_message",
        requestId: args.userMessageId,
        payload: prepareStoredLocalChatPayload({
          type: "assistant_message",
          payload: {
            text: trimmedText,
            userMessageId: args.userMessageId,
            metadata: runtimeMetadata,
          },
          timestamp: Date.now(),
          timezone: args.timezone,
        }),
      });
      return { event, replyRefs };
    };

    const markAssistantTurnComplete = (args: {
      conversationId: string;
      event: LocalChatEventRecord | null;
    }): LocalChatEventRecord | null => {
      if (!args.event?.payload) return args.event;
      const currentMetadata =
        args.event.payload.metadata &&
        typeof args.event.payload.metadata === "object"
          ? (args.event.payload.metadata as Record<string, unknown>)
          : {};
      const currentRuntime =
        currentMetadata.runtime && typeof currentMetadata.runtime === "object"
          ? (currentMetadata.runtime as Record<string, unknown>)
          : {};
      return storage.appendChatEventAndNotify({
        conversationId: args.conversationId,
        eventId: args.event._id,
        type: args.event.type,
        ...(args.event.requestId ? { requestId: args.event.requestId } : {}),
        timestamp: args.event.timestamp,
        payload: {
          ...args.event.payload,
          metadata: {
            ...currentMetadata,
            runtime: {
              ...currentRuntime,
              turnComplete: true,
            },
          },
        },
      });
    };

    /**
     * The client callbacks of one chat run: persist assistant/tool rows for
     * local transcripts, settle the run's admissions, and emit run events.
     * Built per `startChat`, and again from the run's stored launch record
     * when a durable run resumes in a new worker process
     * (`resumeInterruptedRuns`).
     */
    const createChatRunCallbacks = (ctx: {
      conversationId: string;
      userMessageId: string;
      requestId: string | undefined;
      timezone: string | undefined;
      persistLocalTranscript: boolean;
      appendUserMessageEvent: () => void;
      markAdmissionPlaced: (runId: string) => void;
    }): AgentCallbacks => {
      const {
        conversationId,
        userMessageId,
        requestId,
        timezone,
        persistLocalTranscript,
        appendUserMessageEvent,
        markAdmissionPlaced,
      } = ctx;
      // Settles every open admission on the run, including sends steered into
      // it as live follow-ups (they were placed on this same run id).
      const settleAdmissions = (
        runId: string | undefined,
        status: "done" | "unanswered",
      ) => {
        if (!runId) return;
        try {
          admissions.settleRun({
            conversationId,
            runId,
            status,
          });
        } catch (error) {
          logger.warn("startChat.admission-write-failed", {
            conversationId,
            runId,
            step: status,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      const createSyntheticSeq = () => {
        let seq = Date.now();
        return () => {
          seq += 1;
          return seq;
        };
      };
      const nextSyntheticSeq = createSyntheticSeq();
      const hiddenSystemRunIds = new Set<string>();
      let lastVisibleRunId = "";
      let lastVisibleRequestId = requestId;
      const hasActiveAgentForRootRun = (runId: string | undefined): boolean => {
        if (!runId) return false;
        return (
          runnerHandle
            .tryCurrent()
            ?.listActiveAgentRuns()
            .some((agentRun) => agentRun.runId === runId) ?? false
        );
      };
      /**
       * Tracks the most-recently persisted orchestrator assistant message for
       * this run. Successful completion patches this final segment with the
       * durable turn-complete receipt used to distinguish the run's final
       * segment from an interim assistant segment that handed off to a tool.
       */
      let lastAssistantMessageEvent: LocalChatEventRecord | null = null;
      const emitRunEvent = (event: AgentEventPayload) => runEvents.emit(event);
      return {
        durableClient: {
          ...(requestId ? { requestId } : {}),
          ...(timezone ? { timezone } : {}),
          persistLocalTranscript,
        },
        onAssistantMessage: (ev) => {
          if (
            (ev.agentType ?? AGENT_IDS.ORCHESTRATOR) !==
            AGENT_IDS.ORCHESTRATOR
          ) {
            return;
          }
          // Chronological anchor for this text block: the moment the
          // segment produced its first character. Assistant text no longer
          // streams chunk by chunk, so the runtime recorder stamps this on
          // the segment (`firstTextAtMs`) instead of the worker deriving it
          // from the first STREAM chunk it forwarded. Persisted as
          // `metadata.runtime.streamStartedAtMs`, which is what orders
          // lifecycle cards before and after the block. Falls back to now()
          // so an engine that never reports deltas still gets an anchor.
          const streamStartedAtMs = ev.firstTextAtMs ?? Date.now();
          const appended = persistLocalTranscript
            ? appendAssistantMessageForTurn({
                conversationId,
                text: ev.text,
                userMessageId: ev.userMessageId,
                runId: ev.runId,
                seq: ev.seq,
                timezone,
                ...(ev.followedByToolCall
                  ? { followedByToolCall: true }
                  : {}),
                responseTarget: ev.responseTarget,
                ...(ev.replyRefs ? { replyRefs: ev.replyRefs } : {}),
                streamStartedAtMs,
              })
            : null;
          const assistantEvent = appended?.event ?? null;
          if (assistantEvent) {
            lastAssistantMessageEvent = assistantEvent;
          }
          // Sole text-delivery event: one per completed assistant message
          // segment, carrying the full canonical text plus the persisted
          // row id. A run may emit several (preamble → post-tool answer),
          // and the renderer paints each whole.
          //
          // Use the recorder's own seq for this event (`ev.seq`) — the
          // renderer's per-conversation seq guard drops any event whose
          // seq is `<= previousSeq`. A `Date.now()`-style synthetic seq
          // here would clobber the cursor with a huge number and silently
          // drop every subsequent small-seq event in the run. For the
          // rare hidden→visible mirror path the boundary seq has to
          // belong to the visible run's cursor; fall back to a
          // synthetic value there since the visible recorder is not
          // reachable from this closure.
          const isHiddenRun = hiddenSystemRunIds.has(ev.runId);
          const targetRunId = isHiddenRun ? lastVisibleRunId : ev.runId;
          const targetRequestId = isHiddenRun
            ? lastVisibleRequestId
            : requestId;
          const boundarySeq = isHiddenRun ? nextSyntheticSeq() : ev.seq;
          if (targetRunId) {
            emitRunEvent({
              type: AGENT_STREAM_EVENT_TYPES.ASSISTANT_MESSAGE,
              runId: targetRunId,
              seq: boundarySeq,
              conversationId,
              ...(targetRequestId ? { requestId: targetRequestId } : {}),
              userMessageId: ev.userMessageId,
              agentType: ev.agentType,
              ...(assistantEvent
                ? { assistantMessageEventId: assistantEvent._id }
                : {}),
              assistantMessageText: ev.text,
              ...(ev.responseTarget
                ? { responseTarget: ev.responseTarget }
                : {}),
              ...(appended && appended.replyRefs.length > 0
                ? { replyRefs: appended.replyRefs }
                : {}),
              // Preamble → tool-call handoff: when this finalized message
              // ends with a tool call, the renderer keeps the working
              // indicator up across the gap until the tool starts, instead
              // of dismissing on the painted preamble text.
              ...(ev.followedByToolCall ? { followedByToolCall: true } : {}),
            });
          }
        },
        onRunStarted: (ev) => {
          if (ev.userMessageId === userMessageId) {
            appendUserMessageEvent();
          }
          const isHiddenRun = ev.uiVisibility === "hidden";
          if (isHiddenRun) {
            hiddenSystemRunIds.add(ev.runId);
            if (lastVisibleRunId && ev.responseTarget) {
              emitRunEvent({
                ...ev,
                runId: lastVisibleRunId,
                seq: nextSyntheticSeq(),
                type: AGENT_STREAM_EVENT_TYPES.RUN_STARTED,
                conversationId,
                uiVisibility: "visible",
                ...(lastVisibleRequestId
                  ? { requestId: lastVisibleRequestId }
                  : {}),
              });
            }
            return;
          }
          lastVisibleRunId = ev.runId;
          lastVisibleRequestId = requestId;
          if (ev.userMessageId === userMessageId) {
            markAdmissionPlaced(ev.runId);
          }
          emitRunEvent({
            ...ev,
            type: AGENT_STREAM_EVENT_TYPES.RUN_STARTED,
            conversationId,
            ...(requestId ? { requestId } : {}),
          });
        },
        onUserMessage: (ev) => {
          if (!persistLocalTranscript || ev.uiVisibility === "hidden") {
            return;
          }
          storage.appendChatEventAndNotify({
            conversationId,
            type: "user_message",
            requestId: ev.userMessageId,
            timestamp: ev.timestamp,
            payload: prepareStoredLocalChatPayload({
              type: "user_message",
              payload: {
                text: ev.text,
                metadata: {
                  ui: {
                    visibility: ev.uiVisibility ?? "visible",
                  },
                },
              },
              timestamp: ev.timestamp,
              timezone,
            }),
          });
        },
        onStatus: (ev) => {
          if (hiddenSystemRunIds.has(ev.runId)) {
            if (lastVisibleRunId) {
              emitRunEvent({
                ...ev,
                runId: lastVisibleRunId,
                seq: nextSyntheticSeq(),
                type: AGENT_STREAM_EVENT_TYPES.STATUS,
                conversationId,
                ...(lastVisibleRequestId
                  ? { requestId: lastVisibleRequestId }
                  : {}),
              });
            }
            return;
          }
          emitRunEvent({
            ...ev,
            type: AGENT_STREAM_EVENT_TYPES.STATUS,
            conversationId,
            ...(requestId ? { requestId } : {}),
          });
        },
        onProviderLifecycle: (ev) => {
          if (hiddenSystemRunIds.has(ev.runId)) return;
          emitRunEvent({
            ...ev,
            type: AGENT_STREAM_EVENT_TYPES.PROVIDER_LIFECYCLE,
            conversationId,
            ...(requestId ? { requestId } : {}),
          });
        },
        onToolStart: (ev) => {
          if (hiddenSystemRunIds.has(ev.runId)) {
            return;
          }
          if (persistLocalTranscript) {
            storage.appendChatEventAndNotify({
              conversationId,
              type: "tool_request",
              requestId: ev.toolCallId,
              payload: {
                toolName: ev.toolName,
                ...(ev.args ? { args: ev.args } : {}),
                ...(ev.agentType ? { agentType: ev.agentType } : {}),
              },
            });
          }
          emitRunEvent({
            ...ev,
            type: AGENT_STREAM_EVENT_TYPES.TOOL_START,
            conversationId,
            ...(requestId ? { requestId } : {}),
          });
        },
        onToolEnd: (ev) => {
          if (hiddenSystemRunIds.has(ev.runId)) {
            return;
          }
          const details =
            ev.details && typeof ev.details === "object"
              ? (ev.details as Record<string, unknown>)
              : undefined;
          if (persistLocalTranscript) {
            storage.appendChatEventAndNotify({
              conversationId,
              type: "tool_result",
              requestId: ev.toolCallId,
              payload: {
                toolName: ev.toolName,
                result: details ?? ev.resultPreview,
                resultPreview: ev.resultPreview,
                ...(details ? details : {}),
                ...(ev.agentType ? { agentType: ev.agentType } : {}),
                // Attributes the tool result to a spawned agent's thread so
                // per-agent file lists (left sidebar Activity tray) can pick
                // up file changes live, before `agent-completed` rolls up.
                ...(ev.agentId ? { agentId: ev.agentId } : {}),
              },
            });
          }
          emitRunEvent({
            ...ev,
            type: AGENT_STREAM_EVENT_TYPES.TOOL_END,
            conversationId,
            ...(requestId ? { requestId } : {}),
          });
        },
        onError: (ev) => {
          const isHiddenRun = hiddenSystemRunIds.has(ev.runId);
          hiddenSystemRunIds.delete(ev.runId);
          if (isHiddenRun) {
            if (lastVisibleRunId) {
              if (hasActiveAgentForRootRun(lastVisibleRunId)) {
                return;
              }
              emitRunEvent({
                ...ev,
                runId: lastVisibleRunId,
                seq: nextSyntheticSeq(),
                type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
                reason: ev.error,
                conversationId,
                ...(lastVisibleRequestId
                  ? { requestId: lastVisibleRequestId }
                  : {}),
                rootRunId: lastVisibleRunId,
              });
            }
            return;
          }
          if (
            (ev.agentType ?? AGENT_IDS.ORCHESTRATOR) ===
              AGENT_IDS.ORCHESTRATOR &&
            hasActiveAgentForRootRun(ev.runId)
          ) {
            return;
          }
          if (
            ev.fatal &&
            (ev.agentType ?? AGENT_IDS.ORCHESTRATOR) ===
              AGENT_IDS.ORCHESTRATOR
          ) {
            settleAdmissions(ev.runId, "unanswered");
          }
          emitRunEvent({
            ...ev,
            type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
            outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
            reason: ev.error,
            conversationId,
            ...(requestId ? { requestId } : {}),
            ...(ev.runId ? { rootRunId: ev.runId } : {}),
          });
        },
        onAgentEvent: (ev) => {
          if (!ev.rootRunId) {
            logger.warn("task-event-missing-root-run-id", {
              conversationId: ev.conversationId,
              agentId: ev.agentId,
              type: ev.type,
            });
            return;
          }
          if (
            ev.type === AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED &&
            ev.agentType === AGENT_IDS.GENERAL
          ) {
            const notificationText =
              ev.description?.trim() || "Task complete";
            void hostBus
              .request(METHOD_NAMES.HOST_NOTIFICATION_SHOW, {
                title: notificationText,
                body: "",
                sound: "Glass",
              })
              .catch((error) => {
                logger.debug("agent-completion-notification-failed", {
                  conversationId,
                  agentId: ev.agentId,
                  error:
                    error instanceof Error ? error.message : String(error),
                });
              });
          }
          emitRunEvent({
            type: ev.type,
            runId: ev.rootRunId,
            seq: nextSyntheticSeq(),
            conversationId,
            ...(requestId ? { requestId } : {}),
            userMessageId,
            agentId: ev.agentId,
            rootRunId: ev.rootRunId,
            agentType: ev.agentType,
            description: ev.description,
            parentAgentId: ev.parentAgentId,
            result: ev.result,
            error: ev.error,
            statusText: ev.statusText,
            ...(ev.toolActivity ? { toolActivity: ev.toolActivity } : {}),
            ...(ev.groupKey ? { groupKey: ev.groupKey } : {}),
            ...(ev.groupLabel ? { groupLabel: ev.groupLabel } : {}),
          });
        },
        onAgentReasoning: (ev) => {
          if (!ev.agentId) {
            return;
          }
          const runId = ev.rootRunId ?? ev.runId;
          emitRunEvent({
            type: AGENT_STREAM_EVENT_TYPES.AGENT_REASONING,
            runId,
            seq: nextSyntheticSeq(),
            conversationId,
            ...(requestId ? { requestId } : {}),
            userMessageId,
            agentId: ev.agentId,
            rootRunId: runId,
            agentType: ev.agentType,
            ...(ev.description ? { description: ev.description } : {}),
            chunk: ev.chunk,
          });
        },
        onEnd: (ev) => {
          const isHiddenRun = hiddenSystemRunIds.has(ev.runId);
          hiddenSystemRunIds.delete(ev.runId);
          if (
            (ev.agentType ?? AGENT_IDS.ORCHESTRATOR) ===
            AGENT_IDS.ORCHESTRATOR
          ) {
            // Each assistant message in the run was already persisted
            // by `onAssistantMessage` as its own row, so end-of-run no
            // longer writes a new row from `finalText` (doing so would
            // append a duplicate of the last message).
            // Mark only the last segment terminal so the renderer can
            // distinguish it from an interim segment followed by a tool.
            lastAssistantMessageEvent = markAssistantTurnComplete({
              conversationId,
              event: lastAssistantMessageEvent,
            });
          }
          if (isHiddenRun) {
            if (lastVisibleRunId) {
              emitRunEvent({
                ...ev,
                runId: lastVisibleRunId,
                seq: nextSyntheticSeq(),
                type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                outcome: AGENT_RUN_FINISH_OUTCOMES.COMPLETED,
                conversationId,
                ...(lastVisibleRequestId
                  ? { requestId: lastVisibleRequestId }
                  : {}),
                rootRunId: lastVisibleRunId,
              });
            }
            return;
          }
          if (
            (ev.agentType ?? AGENT_IDS.ORCHESTRATOR) ===
            AGENT_IDS.ORCHESTRATOR
          ) {
            settleAdmissions(ev.runId, "done");
          }
          emitRunEvent({
            ...ev,
            type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
            outcome: AGENT_RUN_FINISH_OUTCOMES.COMPLETED,
            conversationId,
            ...(requestId ? { requestId } : {}),
            ...(ev.runId ? { rootRunId: ev.runId } : {}),
          });
        },
        onInterrupted: (ev) => {
          const isHiddenRun = hiddenSystemRunIds.has(ev.runId);
          hiddenSystemRunIds.delete(ev.runId);
          if (isHiddenRun) {
            if (lastVisibleRunId) {
              emitRunEvent({
                type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                runId: lastVisibleRunId,
                seq: Number.MAX_SAFE_INTEGER,
                conversationId,
                ...(lastVisibleRequestId
                  ? { requestId: lastVisibleRequestId }
                  : {}),
                agentType: ev.agentType,
                outcome: AGENT_RUN_FINISH_OUTCOMES.CANCELED,
                reason: ev.reason,
                rootRunId: lastVisibleRunId,
              });
            }
            return;
          }
          settleAdmissions(ev.runId, "unanswered");
          emitRunEvent({
            type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
            runId: ev.runId,
            seq: Number.MAX_SAFE_INTEGER,
            conversationId,
            ...(requestId ? { requestId } : {}),
            agentType: ev.agentType,
            userMessageId: ev.userMessageId,
            outcome: AGENT_RUN_FINISH_OUTCOMES.CANCELED,
            reason: ev.reason,
            rootRunId: ev.runId,
          });
        },
      };
    };

    /**
     * The admitted half of `startChat`. `admissionKey` is set when the send
     * holds a `run_admission` claim; the runner callbacks move that claim to
     * `placed` (with its run) and settle it when the run ends.
     */
    const startAdmittedChat = async (
      payload: RuntimeChatPayload,
      admissionKey: string | undefined,
    ): Promise<Record<string, unknown>> => {
      const storageMode = resolveConversationStorageMode(payload.storageMode);
      const ownerGeneration = asTrimmedString(payload.ownerGeneration);
      if (storageMode === "cloud" && !ownerGeneration) {
        throw new Error("Cloud owner generation is required for this turn.");
      }
      const persistLocalTranscript =
        shouldPersistLocalChatTranscript(storageMode);
      const requestId =
        asTrimmedString(
          (payload as RuntimeChatPayload & { requestId?: string }).requestId,
        ) || undefined;
      // Resolve the provider/model this turn will run on so composer images
      // are sized to that provider's real limits (best-effort; falls back to
      // the safe conservative profile when no route resolves).
      let composerImageTarget: ImageCapTarget | undefined;
      try {
        composerImageTarget =
          (await (
            await runnerHandle.ensureInitialized()
          ).resolveImageTarget(payload.agentType)) ?? undefined;
      } catch {
        composerImageTarget = undefined;
      }
      const materializedImageAttachments = await materializeImageAttachments(
        payload.attachments,
        composerImageTarget,
      );
      const modelFileAttachments = await materializeFileAttachments({
        attachments: payload.attachments,
        stellaDataDirPath: config.get().stellaDataDirPath,
        conversationId: payload.conversationId,
      });
      let modelImageAttachments = materializedImageAttachments.map(
        ({ attachment }) => attachment,
      );
      let persistedImageAttachments: SpilledImageAttachment[] = [];
      if (modelImageAttachments.length > 0) {
        persistedImageAttachments = await spillImageAttachmentsToDisk({
          stellaDataDirPath: config.get().stellaDataDirPath,
          conversationId: payload.conversationId,
          attachments: modelImageAttachments,
        });
        modelImageAttachments = attachPersistedImagePaths(
          modelImageAttachments,
          persistedImageAttachments,
        );
      }
      const totalInlineImageBytes = modelImageAttachments.reduce(
        (total, attachment) => total + approximateDataUrlBytes(attachment.url),
        0,
      );
      let spilledImageAttachments: SpilledImageAttachment[] = [];
      const hasOverCapInlineImage = modelImageAttachments.some(
        (attachment) =>
          dataUrlBase64Length(attachment.url) > MAX_INLINE_IMAGE_BASE64_BYTES,
      );
      if (
        totalInlineImageBytes > INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES ||
        hasOverCapInlineImage
      ) {
        spilledImageAttachments = persistedImageAttachments;
        modelImageAttachments = [];
      }
      const { buildChatPromptMessages } = await loadChatPromptContext();
      const {
        visibleUserPrompt,
        windowContextLabel,
        browserUrl,
        appSelectionLabel,
        appSelectionLabels,
        activityLabel,
        quotedText,
        pastedTexts,
        promptMessages,
        windowScreenshotAttachment,
      } = buildChatPromptMessages({
        userPrompt: payload.userPrompt,
        selectedText:
          payload.selectedText ?? payload.chatContext?.selectedText ?? null,
        chatContext: payload.chatContext ?? null,
        explicitImageAttachmentCount: modelImageAttachments.length,
      });
      const journalDisplayContext = {
        ...(appSelectionLabel ? { appSelectionLabel } : {}),
        ...(appSelectionLabels?.length ? { appSelectionLabels } : {}),
        ...(activityLabel ? { activityLabel } : {}),
        ...(quotedText ? { quotedText } : {}),
        ...(pastedTexts?.length ? { pastedTexts } : {}),
      };
      const userMessageMetadata =
        Object.keys(journalDisplayContext).length > 0
          ? { context: journalDisplayContext }
          : undefined;
      let modelWindowScreenshotAttachment = windowScreenshotAttachment;
      if (modelWindowScreenshotAttachment) {
        const persistedWindowScreenshot = await spillImageAttachmentsToDisk({
          stellaDataDirPath: config.get().stellaDataDirPath,
          conversationId: payload.conversationId,
          attachments: [modelWindowScreenshotAttachment],
        });
        [modelWindowScreenshotAttachment] = attachPersistedImagePaths(
          [modelWindowScreenshotAttachment],
          persistedWindowScreenshot,
        );
      }
      const runPromptMessages: RuntimePromptMessage[] = [
        ...(promptMessages ?? []),
        ...(spilledImageAttachments.length > 0
          ? [
              {
                text: buildSpilledAttachmentNotice(spilledImageAttachments),
                uiVisibility: "hidden" as const,
                messageType: "message" as const,
                customType: "runtime.chat_context",
              },
            ]
          : []),
      ];
      const userMessageTimestamp =
        typeof payload.userMessageTimestamp === "number" &&
        Number.isFinite(payload.userMessageTimestamp)
          ? payload.userMessageTimestamp
          : Date.now();
      const windowPreviewImageUrl = windowScreenshotAttachment?.url;
      const userMessageId =
        payload.userMessageEventId ?? `local:${crypto.randomUUID()}`;
      // Placed from run start and again after handleLocalChat returns (the
      // steer path never sees a run start); write it once.
      let admissionPlaced = false;
      const markAdmissionPlaced = (runId: string) => {
        if (!admissionKey || !runId || admissionPlaced) return;
        try {
          admissions.markPlaced({
            conversationId: payload.conversationId,
            requestId: admissionKey,
            runId,
          });
          admissionPlaced = true;
        } catch (error) {
          logger.warn("startChat.admission-write-failed", {
            conversationId: payload.conversationId,
            requestId: admissionKey,
            step: "placed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      let userMessageEventAppended = false;
      const appendUserMessageEvent = (timestamp = userMessageTimestamp) => {
        if (!persistLocalTranscript || userMessageEventAppended) {
          return;
        }
        userMessageEventAppended = true;
        storage.appendChatEventAndNotify({
          conversationId: payload.conversationId,
          type: "user_message",
          eventId: userMessageId,
          deviceId: payload.deviceId,
          timestamp,
          payload: prepareStoredLocalChatPayload({
            type: "user_message",
            payload: {
              text: visibleUserPrompt,
              // Store the display copy preview-weight: full-resolution data
              // URLs are for the model request only — persisting them here
              // bloats the chat store and makes every render of the user
              // row decode the originals.
              ...(payload.attachments?.length
                ? {
                    attachments: payload.attachments.map(
                      ({ previewUrl, ...attachment }) => ({
                        ...attachment,
                        ...(previewUrl ? { url: previewUrl } : {}),
                      }),
                    ),
                  }
                : {}),
              ...(payload.platform ? { platform: payload.platform } : {}),
              ...(payload.timezone ? { timezone: payload.timezone } : {}),
              ...(payload.locale ? { locale: payload.locale } : {}),
              ...(payload.messageMetadata ||
              windowContextLabel ||
              browserUrl ||
              windowPreviewImageUrl ||
              userMessageMetadata
                ? {
                    metadata: {
                      ...(payload.messageMetadata ?? {}),
                      ...(windowContextLabel ||
                      browserUrl ||
                      windowPreviewImageUrl ||
                      userMessageMetadata
                        ? {
                            context: {
                              ...(payload.messageMetadata?.context ?? {}),
                              ...(windowContextLabel
                                ? { windowLabel: windowContextLabel }
                                : {}),
                              ...(browserUrl ? { browserUrl } : {}),
                              ...(windowPreviewImageUrl
                                ? { windowPreviewImageUrl }
                                : {}),
                              ...journalDisplayContext,
                            },
                          }
                        : {}),
                    },
                  }
                : {}),
              ...(payload.mode ? { mode: payload.mode } : {}),
            },
            timestamp,
            timezone: payload.timezone,
          }),
        });
      };
      if (persistLocalTranscript && payload.mode !== "follow_up") {
        appendUserMessageEvent();
      }

      const mergedAttachments = [
        ...modelImageAttachments,
        ...modelFileAttachments,
        ...(modelWindowScreenshotAttachment
          ? [modelWindowScreenshotAttachment]
          : []),
      ];
      logger.info("startChat.prompt-shape", {
        conversationId: payload.conversationId,
        visibleUserPrompt,
        windowContextLabel,
        appSelectionLabel,
        activityLabel,
        promptMessages: runPromptMessages.map((message, index) => ({
          index,
          uiVisibility: message.uiVisibility ?? "visible",
          textPreview: message.text.slice(0, 200),
        })),
        incomingAttachmentCount: payload.attachments?.length ?? 0,
        modelImageAttachmentCount: modelImageAttachments.length,
        mergedAttachmentCount: mergedAttachments.length,
        totalInlineImageBytes,
        spilledImageAttachmentCount: spilledImageAttachments.length,
        hasWindowScreenshotAttachment: Boolean(windowScreenshotAttachment),
      });
      const callbacks = createChatRunCallbacks({
        conversationId: payload.conversationId,
        userMessageId,
        requestId,
        timezone: payload.timezone,
        persistLocalTranscript,
        appendUserMessageEvent: () => appendUserMessageEvent(),
        markAdmissionPlaced,
      });
      const result = await (
        await runnerHandle.ensureInitialized()
      ).handleLocalChat(
        {
          conversationId: payload.conversationId,
          userMessageId,
          userPrompt: visibleUserPrompt,
          ...(runPromptMessages.length
            ? { promptMessages: runPromptMessages }
            : {}),
          ...(userMessageMetadata ? { userMessageMetadata } : {}),
          attachments:
            mergedAttachments.length > 0 ? mergedAttachments : undefined,
          agentType: payload.agentType,
          storageMode,
          ...(ownerGeneration ? { ownerGeneration } : {}),
        },
        callbacks,
      );
      markAdmissionPlaced(result.runId);
      return { ...result, userMessageId };
    };

    /**
     * Run admission is idempotent per send: the key is the client's stable
     * `userMessageEventId`, else its `requestId` (stable for mobile
     * `clientRequestId` sends). A retry of an admitted send returns the
     * original run (`deduplicated: true`) instead of appending the message
     * and starting a second run. The claim is taken before the first await,
     * so two racing calls in this process cannot both admit.
     */
    const startChat: Interface["startChat"] = async (payload) => {
      // The exact id the run and its callbacks write under (not trimmed), so
      // placement and settlement match the claimed row.
      const conversationId = payload.conversationId;
      const admissionKey =
        asTrimmedString(payload.userMessageEventId) ||
        asTrimmedString(payload.requestId);
      if (!asTrimmedString(conversationId) || !admissionKey) {
        return await startAdmittedChat(payload, undefined);
      }
      const inFlightKey = JSON.stringify([conversationId, admissionKey]);
      const inFlight = inFlightAdmissions.get(inFlightKey);
      if (inFlight) {
        logger.info("startChat.duplicate-admission", {
          conversationId,
          requestId: admissionKey,
          state: "in-flight",
        });
        return { ...(await inFlight), deduplicated: true };
      }
      let claimed = false;
      try {
        const claim = admissions.claim({
          conversationId,
          requestId: admissionKey,
        });
        if (!claim.admitted) {
          const { existing } = claim;
          if (existing.runId) {
            logger.info("startChat.duplicate-admission", {
              conversationId,
              requestId: admissionKey,
              state: existing.status,
              runId: existing.runId,
            });
            return {
              runId: existing.runId,
              ...(payload.userMessageEventId
                ? { userMessageId: payload.userMessageEventId }
                : {}),
              deduplicated: true,
            };
          }
          // Admitted by a worker that exited before placing it on a run.
          admissions.reopenUnplaced({ conversationId, requestId: admissionKey });
          logger.info("startChat.admission-reopened", {
            conversationId,
            requestId: admissionKey,
            previousStatus: existing.status,
          });
        }
        claimed = true;
      } catch (error) {
        // Admission bookkeeping must never cost the user's send.
        logger.warn("startChat.admission-write-failed", {
          conversationId,
          requestId: admissionKey,
          step: "claim",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!claimed) {
        return await startAdmittedChat(payload, undefined);
      }
      const pending = startAdmittedChat(payload, admissionKey);
      inFlightAdmissions.set(inFlightKey, pending);
      try {
        return await pending;
      } catch (error) {
        // No run owns the send (a placed claim is kept): free the key so the
        // client can retry it.
        try {
          admissions.release(conversationId, admissionKey);
        } catch {
          /* the next retry reopens an unplaced claim anyway */
        }
        throw error;
      } finally {
        inFlightAdmissions.delete(inFlightKey);
      }
    };

    const sendAgentInput: Interface["sendAgentInput"] = async (payload) => {
      const { conversationId, threadId, message } = payload;
      const requestId = `agent-input:${crypto.randomUUID()}`;
      const delivered = await (
        await runnerHandle.ensureInitialized()
      ).executeTool(
        "send_message",
        {
          thread_id: threadId,
          message,
        },
        {
          executionHost: "device",
          conversationId,
          deviceId: config.deviceId || "local",
          requestId,
          agentType: AGENT_IDS.ORCHESTRATOR,
          storageMode: "cloud",
          fromUser: true,
        },
      );
      if (delivered.error) {
        throw new Error(delivered.error);
      }
      return { delivered: true };
    };

    const runAutomation: Interface["runAutomation"] = async (payload) => {
      let automationImageTarget: ImageCapTarget | undefined;
      try {
        automationImageTarget =
          (await (
            await runnerHandle.ensureInitialized()
          ).resolveImageTarget(payload.agentType)) ?? undefined;
      } catch {
        automationImageTarget = undefined;
      }
      const materializedImageAttachments = await materializeImageAttachments(
        payload.attachments,
        automationImageTarget,
      );
      const modelFileAttachments = await materializeFileAttachments({
        attachments: payload.attachments,
        stellaDataDirPath: config.get().stellaDataDirPath,
        conversationId: payload.conversationId,
      });
      return await (
        await runnerHandle.ensureInitialized()
      ).runAutomationTurn({
        ...payload,
        ...(materializedImageAttachments.length > 0 || modelFileAttachments.length > 0
          ? {
              attachments: [
                ...materializedImageAttachments.map(({ attachment }) => attachment),
                ...modelFileAttachments,
              ],
            }
          : {}),
      });
    };

    const materializeAgentAttachments: Interface["materializeAgentAttachments"] =
      async (payload) =>
        payload.attachments?.length
          ? await materializeFileAttachments({
              attachments: payload.attachments,
              stellaDataDirPath: config.get().stellaDataDirPath,
              conversationId: payload.conversationId,
              includeImages: true,
            })
          : [];

    const oneShotCompletion: Interface["oneShotCompletion"] = async (
      request,
    ) => {
      const init = config.get();
      return await (
        await loadOneShotCompletion()
      ).runOneShotCompletion({
        request,
        runtime: {
          stellaAppDir: init.stellaAppDir,
          stellaDataDir: init.stellaDataDirPath,
          siteBaseUrl: init.backendUrl,
          getAuthToken: () => init.authToken,
          hasConnectedAccount: () => config.get().hasConnectedAccount ?? false,
          requestRuntimeAuthRefresh: async () => {
            try {
              return (await hostBus.request(
                METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH,
                { source: "stella_provider" },
                { retryOnDisconnect: true },
              )) as {
                authenticated: boolean;
                token: string | null;
                hasConnectedAccount: boolean;
              };
            } catch {
              return null;
            }
          },
          requestChallengeToken: async () => {
            const token = await hostBus
              .request(HOST_CHALLENGE_TOKEN_METHOD, undefined, {
                retryOnDisconnect: true,
              })
              .catch(() => null);
            return typeof token === "string" && token.trim()
              ? token.trim()
              : undefined;
          },
          getDeviceSigner,
        },
      });
    };

    const resumeInterruptedRuns: Interface["resumeInterruptedRuns"] =
      async () => {
        const runner = await runnerHandle.ensureInitialized();
        const { resumed, failed } =
          await runner.resumeInterruptedOrchestratorRuns({
            createCallbacks: (launch) => {
              const client = launch.client ?? {};
              return createChatRunCallbacks({
                conversationId: launch.conversationId,
                userMessageId: launch.userMessageId,
                requestId:
                  typeof client.requestId === "string"
                    ? client.requestId
                    : undefined,
                timezone:
                  typeof client.timezone === "string"
                    ? client.timezone
                    : undefined,
                persistLocalTranscript:
                  typeof client.persistLocalTranscript === "boolean"
                    ? client.persistLocalTranscript
                    : shouldPersistLocalChatTranscript(launch.storageMode),
                // The dead process appended the user row and placed the
                // admission; a resume only continues the run.
                appendUserMessageEvent: () => {},
                markAdmissionPlaced: () => {},
              });
            },
          });
        if (resumed.length > 0 || failed.length > 0) {
          logger.info("durable-runs.resume-pass", { resumed, failed });
        }
      };

    return {
      startChat,
      sendAgentInput,
      runAutomation,
      materializeAgentAttachments,
      oneShotCompletion,
      resumeInterruptedRuns,
    };
  }),
);
