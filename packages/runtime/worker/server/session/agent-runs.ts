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
import type { AssistantWorkingMode } from "@stella/contracts/local-preferences";
import type { ImageCapTarget } from "../../../ai/utils/image-caps.js";
import { getAssistantWorkingMode } from "../../../kernel/preferences/local-preferences.js";
import { prepareStoredLocalChatPayload } from "../../../kernel/storage/local-chat-payload.js";
import type { LocalChatEventRecord } from "../../../kernel/storage/shared.js";
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
} from "../attachments.js";
import * as HostBus from "../host-bus.js";
import * as SessionConfig from "./config.js";
import * as SessionStorage from "./storage.js";
import * as RunEventBus from "./run-events.js";
import * as RunnerHandle from "./runner.js";
import type { AgentEventPayload } from "../types.js";

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
  }) => Promise<unknown>;
  readonly oneShotCompletion: (
    request: RuntimeOneShotCompletionRequest,
  ) => Promise<RuntimeOneShotCompletionResult>;
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
      streamStartedAtMs?: number;
      workingMode: AssistantWorkingMode;
      followedByToolCall?: boolean;
    }): LocalChatEventRecord | null => {
      const trimmedText = args.text.trim();
      if (!trimmedText) {
        return null;
      }

      const runtimeMetadata = {
        runtime: {
          workingMode: args.workingMode,
          ...(args.followedByToolCall ? { followedByToolCall: true } : {}),
          ...(args.responseTarget
            ? { responseTarget: args.responseTarget }
            : {}),
          ...(Number.isFinite(args.streamStartedAtMs)
            ? { streamStartedAtMs: args.streamStartedAtMs }
            : {}),
        },
      };

      const eventId = `assistant-msg-${args.runId}-${args.seq}`;
      return storage.appendChatEventAndNotify({
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

    const startChat: Interface["startChat"] = async (payload) => {
      const assistantWorkingMode: AssistantWorkingMode =
        getAssistantWorkingMode(config.get().stellaDataDirPath);
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
        promptMessages,
        windowScreenshotAttachment,
      } = buildChatPromptMessages({
        userPrompt: payload.userPrompt,
        selectedText:
          payload.selectedText ?? payload.chatContext?.selectedText ?? null,
        chatContext: payload.chatContext ?? null,
        explicitImageAttachmentCount: modelImageAttachments.length,
      });
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
      let userMessageEventAppended = false;
      const appendUserMessageEvent = (timestamp = userMessageTimestamp) => {
        if (userMessageEventAppended) {
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
              appSelectionLabel ||
              activityLabel ||
              quotedText ||
              windowPreviewImageUrl
                ? {
                    metadata: {
                      ...(payload.messageMetadata ?? {}),
                      ...(windowContextLabel ||
                      browserUrl ||
                      appSelectionLabel ||
                      activityLabel ||
                      quotedText ||
                      windowPreviewImageUrl
                        ? {
                            context: {
                              ...(payload.messageMetadata?.context ?? {}),
                              ...(windowContextLabel
                                ? {
                                    windowLabel: windowContextLabel,
                                  }
                                : {}),
                              ...(browserUrl
                                ? {
                                    browserUrl,
                                  }
                                : {}),
                              ...(windowPreviewImageUrl
                                ? {
                                    windowPreviewImageUrl,
                                  }
                                : {}),
                              ...(appSelectionLabel
                                ? {
                                    appSelectionLabel,
                                  }
                                : {}),
                              ...(appSelectionLabels?.length
                                ? {
                                    appSelectionLabels,
                                  }
                                : {}),
                              ...(activityLabel
                                ? {
                                    activityLabel,
                                  }
                                : {}),
                              ...(quotedText
                                ? {
                                    quotedText,
                                  }
                                : {}),
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
      if (payload.mode !== "follow_up") {
        appendUserMessageEvent();
      }

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
       * durable turn-complete receipt used to retire direct-mode preambles.
       */
      let lastAssistantMessageEvent: LocalChatEventRecord | null = null;
      /**
       * Worker-clock time of the CURRENT assistant segment's first stream
       * chunk, per run. Set on the first `onStream` chunk after a segment
       * boundary, consumed (and cleared) by `onAssistantMessage` so the
       * persisted row carries `metadata.runtime.streamStartedAtMs` — the
       * chronological anchor the renderer uses to place lifecycle cards
       * before/after this text block.
       */
      const segmentFirstChunkAtMsByRunId = new Map<string, number>();
      const mergedAttachments = [
        ...modelImageAttachments,
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
      const emitRunEvent = (event: AgentEventPayload) => runEvents.emit(event);
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
          attachments:
            mergedAttachments.length > 0 ? mergedAttachments : undefined,
          agentType: payload.agentType,
        },
        {
          onAssistantMessage: (ev) => {
            if (
              (ev.agentType ?? AGENT_IDS.ORCHESTRATOR) !==
              AGENT_IDS.ORCHESTRATOR
            ) {
              return;
            }
            const streamStartedAtMs = segmentFirstChunkAtMsByRunId.get(
              ev.runId,
            );
            segmentFirstChunkAtMsByRunId.delete(ev.runId);
            const assistantEvent = appendAssistantMessageForTurn({
              conversationId: payload.conversationId,
              text: ev.text,
              userMessageId: ev.userMessageId,
              runId: ev.runId,
              seq: ev.seq,
              timezone: payload.timezone,
              workingMode: assistantWorkingMode,
              ...(ev.followedByToolCall ? { followedByToolCall: true } : {}),
              responseTarget: ev.responseTarget,
              ...(streamStartedAtMs !== undefined ? { streamStartedAtMs } : {}),
            });
            if (assistantEvent) {
              lastAssistantMessageEvent = assistantEvent;
            }
            // Boundary marker on the same wire as `STREAM` chunks so the
            // renderer can reset its in-flight streaming buffer before
            // chunks for the next assistant message in this run arrive
            // (e.g. post-tool answer after a preamble). Without this the
            // buffer keeps growing across messages and the live stream
            // row replays the preamble text under the next message's
            // content.
            //
            // Use the recorder's own seq for this event (`ev.seq`) — the
            // renderer's per-conversation seq guard drops any event whose
            // seq is `<= previousSeq`. A `Date.now()`-style synthetic seq
            // here would clobber the cursor with a huge number and silently
            // drop every subsequent small-seq STREAM chunk in the run
            // (the post-tool answer would stop streaming live). For the
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
                conversationId: payload.conversationId,
                ...(targetRequestId ? { requestId: targetRequestId } : {}),
                userMessageId: ev.userMessageId,
                agentType: ev.agentType,
                workingMode: assistantWorkingMode,
                ...(assistantEvent
                  ? { assistantMessageEventId: assistantEvent._id }
                  : {}),
                assistantMessageText: ev.text,
                ...(ev.responseTarget
                  ? { responseTarget: ev.responseTarget }
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
                  conversationId: payload.conversationId,
                  uiVisibility: "visible",
                  workingMode: assistantWorkingMode,
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                });
              }
              return;
            }
            lastVisibleRunId = ev.runId;
            lastVisibleRequestId = requestId;
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.RUN_STARTED,
              conversationId: payload.conversationId,
              workingMode: assistantWorkingMode,
              ...(requestId ? { requestId } : {}),
            });
          },
          onUserMessage: (ev) => {
            if (ev.uiVisibility === "hidden") {
              return;
            }
            storage.appendChatEventAndNotify({
              conversationId: payload.conversationId,
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
                timezone: payload.timezone,
              }),
            });
          },
          onStream: (ev) => {
            if (ev.chunk && !segmentFirstChunkAtMsByRunId.has(ev.runId)) {
              segmentFirstChunkAtMsByRunId.set(ev.runId, Date.now());
            }
            if (hiddenSystemRunIds.has(ev.runId)) {
              if (lastVisibleRunId) {
                emitRunEvent({
                  ...ev,
                  runId: lastVisibleRunId,
                  seq: nextSyntheticSeq(),
                  type: AGENT_STREAM_EVENT_TYPES.STREAM,
                  conversationId: payload.conversationId,
                  workingMode: assistantWorkingMode,
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                });
              }
              return;
            }
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.STREAM,
              conversationId: payload.conversationId,
              workingMode: assistantWorkingMode,
              ...(requestId ? { requestId } : {}),
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
                  conversationId: payload.conversationId,
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
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
            });
          },
          onToolStart: (ev) => {
            if (hiddenSystemRunIds.has(ev.runId)) {
              return;
            }
            storage.appendChatEventAndNotify({
              conversationId: payload.conversationId,
              type: "tool_request",
              requestId: ev.toolCallId,
              payload: {
                toolName: ev.toolName,
                ...(ev.args ? { args: ev.args } : {}),
                ...(ev.agentType ? { agentType: ev.agentType } : {}),
              },
            });
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.TOOL_START,
              conversationId: payload.conversationId,
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
            storage.appendChatEventAndNotify({
              conversationId: payload.conversationId,
              type: "tool_result",
              requestId: ev.toolCallId,
              payload: {
                toolName: ev.toolName,
                result: details ?? ev.resultPreview,
                resultPreview: ev.resultPreview,
                ...(details ? details : {}),
                ...(ev.fileChanges?.length
                  ? { fileChanges: ev.fileChanges }
                  : {}),
                ...(ev.producedFiles?.length
                  ? { producedFiles: ev.producedFiles }
                  : {}),
                ...(ev.agentType ? { agentType: ev.agentType } : {}),
                // Attributes the tool result to a spawned agent's thread so
                // per-agent file lists (left sidebar Activity tray) can pick
                // up file changes live, before `agent-completed` rolls up.
                ...(ev.agentId ? { agentId: ev.agentId } : {}),
              },
            });
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.TOOL_END,
              conversationId: payload.conversationId,
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
                  conversationId: payload.conversationId,
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
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
              outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
              reason: ev.error,
              conversationId: payload.conversationId,
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
                    conversationId: payload.conversationId,
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
              conversationId: payload.conversationId,
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
              conversationId: payload.conversationId,
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
              // Mark only the last segment terminal. In direct mode the
              // renderer uses that receipt to remove earlier preamble text
              // after the successful turn has actually finished.
              lastAssistantMessageEvent = markAssistantTurnComplete({
                conversationId: payload.conversationId,
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
                  conversationId: payload.conversationId,
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                  rootRunId: lastVisibleRunId,
                });
              }
              return;
            }
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
              outcome: AGENT_RUN_FINISH_OUTCOMES.COMPLETED,
              conversationId: payload.conversationId,
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
                  conversationId: payload.conversationId,
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
            emitRunEvent({
              type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
              runId: ev.runId,
              seq: Number.MAX_SAFE_INTEGER,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
              agentType: ev.agentType,
              userMessageId: ev.userMessageId,
              outcome: AGENT_RUN_FINISH_OUTCOMES.CANCELED,
              reason: ev.reason,
              rootRunId: ev.runId,
            });
          },
        },
      );
      return { ...result, userMessageId };
    };

    const sendAgentInput: Interface["sendAgentInput"] = async (payload) => {
      const { conversationId, threadId, message } = payload;
      const requestId = `agent-input:${crypto.randomUUID()}`;
      const delivered = await (
        await runnerHandle.ensureInitialized()
      ).executeTool(
        "send_input",
        {
          thread_id: threadId,
          description: message,
          message,
        },
        {
          conversationId,
          deviceId: config.deviceId || "local",
          requestId,
          agentType: AGENT_IDS.ORCHESTRATOR,
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
      return await (
        await runnerHandle.ensureInitialized()
      ).runAutomationTurn({
        ...payload,
        ...(materializedImageAttachments.length > 0
          ? {
              attachments: materializedImageAttachments.map(
                ({ attachment }) => attachment,
              ),
            }
          : {}),
      });
    };

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
          siteBaseUrl: init.convexSiteUrl,
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
        },
      });
    };

    return { startChat, sendAgentInput, runAutomation, oneShotCompletion };
  }),
);
