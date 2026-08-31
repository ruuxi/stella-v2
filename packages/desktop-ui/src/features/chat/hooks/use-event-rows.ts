import { useLayoutEffect, useMemo, useRef } from "react";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import type { MessagePayload } from "@/features/chat/lib/event-transforms";
import {
  isAgentCompletedEvent,
  isAgentStartedEvent,
  isAssistantMessage,
  isUserMessage,
} from "@/features/chat/lib/event-transforms";
import type { MessageRecord } from "@stella/contracts/local-chat";
import { isOrchestratorReservedBuiltinAgentId } from "@stella/contracts/agent-runtime";
import { isOfficePreviewRef } from "@stella/contracts/office-preview";
import {
  collectTurnSourceDiffPayloads,
  deriveTurnInlineImagePayloads,
  deriveTurnResource,
} from "@/features/chat/lib/derive-turn-resource";
import {
  buildBackgroundTaskLifecycleIndex,
  followUpReplacesActivePredecessor,
  resolveBackgroundTaskCardLifecycle,
  type BackgroundTaskLifecycleIndex,
} from "@/features/chat/lib/background-task-lifecycle";
import type { AgentCompletionSection } from "@/features/chat/lib/agent-completion";
import { deriveTurnWebSearchResults } from "@/features/chat/lib/derive-turn-web-search";
import { deriveTurnMapArtifacts } from "@/features/chat/lib/derive-turn-map-artifacts";
import { filterMessagesForUiDisplay } from "@/features/chat/lib/message-display";
import { suppressCompletedDirectPreambleText } from "@/features/chat/lib/completed-direct-preambles";
import {
  stabilizeTurnRows,
  type StableTurnRowsState,
} from "@/features/chat/lib/stable-rows";
import { eventRowEqual } from "@/features/chat/lib/row-equality";
import { useDeveloperResourcePreviewsEnabled } from "@/shared/lib/developer-resource-previews";
import type {
  AssistantRowViewModel,
  EventRowViewModel,
  UserRowViewModel,
} from "@/features/chat/conversation-row-types";
import {
  getDisplayMessageText,
  getDisplayUserText,
  getAttachments,
  getChannelEnvelope,
} from "@/features/chat/lib/message-turn-display";
import {
  assistantScrollFollowKey,
  type AgentResponseTarget,
} from "@/features/chat/streaming/streaming-types";

const getMessagePayload = (
  event?: EventRecord | MessageRecord,
): MessagePayload | null => {
  if (!event?.payload || typeof event.payload !== "object") return null;
  return event.payload as MessagePayload;
};

const getOfficePreviewRef = (events: readonly EventRecord[]) => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (event.type !== "tool_result") continue;
    const payload = event.payload as { officePreviewRef?: unknown } | undefined;
    const previewRef = payload?.officePreviewRef;
    if (isOfficePreviewRef(previewRef)) return previewRef;
  }
  return undefined;
};

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

export const getBackgroundWork = (
  events: readonly EventRecord[],
):
  | {
      threadIds: string[];
      descriptions: Record<string, string>;
      spawnedAtMs: Record<string, number>;

      statusTexts: Record<string, string>;

      followUpThreadIds: string[];

      startEventIdsByThread: Record<string, string>;
      attemptGenerationsByThread: Record<string, number>;
      rootRunIdsByThread: Record<string, string>;
      cardId: string;
    }
  | undefined => {
  const threadIds: string[] = [];
  const descriptions: Record<string, string> = {};
  const statusTexts: Record<string, string> = {};
  const followUpThreadIds: string[] = [];
  const startEventIdsByThread: Record<string, string> = {};
  const attemptGenerationsByThread: Record<string, number> = {};
  const rootRunIdsByThread: Record<string, string> = {};

  const spawnedAtMs: Record<string, number> = {};
  for (const event of events) {
    if (!isAgentStartedEvent(event)) continue;

    const agentType = asNonEmptyString(event.payload.agentType);
    if (agentType && isOrchestratorReservedBuiltinAgentId(agentType)) {
      continue;
    }
    const agentId = asNonEmptyString(event.payload.agentId);
    if (!agentId) continue;
    if (!threadIds.includes(agentId)) threadIds.push(agentId);
    const description = asNonEmptyString(event.payload.description);
    const priorTimestamp = spawnedAtMs[agentId];
    const priorEventId = startEventIdsByThread[agentId];
    const candidateAttempt =
      typeof event.payload.attemptGeneration === "number" &&
      Number.isInteger(event.payload.attemptGeneration) &&
      event.payload.attemptGeneration >= 0
        ? event.payload.attemptGeneration
        : undefined;
    const priorAttempt = attemptGenerationsByThread[agentId];
    const isLatestOccurrence =
      priorTimestamp === undefined ||
      event.timestamp > priorTimestamp ||
      (event.timestamp === priorTimestamp &&
        (candidateAttempt !== undefined || priorAttempt !== undefined
          ? candidateAttempt !== undefined &&
            (priorAttempt === undefined || candidateAttempt > priorAttempt)
          : !priorEventId || event._id.localeCompare(priorEventId) > 0));
    if (isLatestOccurrence) {
      spawnedAtMs[agentId] = event.timestamp;
      startEventIdsByThread[agentId] = event._id;
      if (candidateAttempt !== undefined) {
        attemptGenerationsByThread[agentId] = candidateAttempt;
      } else {
        delete attemptGenerationsByThread[agentId];
      }
      if (description) descriptions[agentId] = description;
      const rootRunId = asNonEmptyString(event.payload.rootRunId);
      if (rootRunId) rootRunIdsByThread[agentId] = rootRunId;
      else delete rootRunIdsByThread[agentId];
      const previousFollowUpIndex = followUpThreadIds.indexOf(agentId);
      if (previousFollowUpIndex >= 0) {
        followUpThreadIds.splice(previousFollowUpIndex, 1);
      }
      delete statusTexts[agentId];

      if (event.payload.isFollowUp) {
        followUpThreadIds.push(agentId);
        const followUp = asNonEmptyString(event.payload.statusText);
        if (followUp) statusTexts[agentId] = followUp;
      }
    }
  }
  if (threadIds.length === 0) return undefined;
  const startEventIds = threadIds
    .map((threadId) => startEventIdsByThread[threadId])
    .filter((eventId): eventId is string => Boolean(eventId));
  return {
    threadIds,
    descriptions,
    spawnedAtMs,
    statusTexts,
    followUpThreadIds,
    startEventIdsByThread,
    attemptGenerationsByThread,
    rootRunIdsByThread,
    cardId: `agent-activity:${startEventIds.join("+")}`,
  };
};

export const getBackgroundWorks = (
  events: readonly EventRecord[],
): NonNullable<ReturnType<typeof getBackgroundWork>>[] => {
  const cards: NonNullable<ReturnType<typeof getBackgroundWork>>[] = [];

  const starts = events
    .filter(isAgentStartedEvent)
    .sort((a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id));
  for (const event of starts) {
    const card = getBackgroundWork([event]);
    if (card) cards.push(card);
  }
  return cards;
};

export const derivePausedThreadIds = (
  threadIds: readonly string[],
  spawnedAtMs: Record<string, number>,
  completedAtMsById: ReadonlyMap<string, number>,
  canceledAtMsById: ReadonlyMap<string, number>,
): string[] =>
  threadIds.filter((id) => {
    const canceledAt = canceledAtMsById.get(id);
    const spawnedAt = spawnedAtMs[id];
    if (
      canceledAt === undefined ||
      spawnedAt === undefined ||
      canceledAt < spawnedAt
    ) {
      return false;
    }
    const completedAt = completedAtMsById.get(id);
    return completedAt === undefined || canceledAt > completedAt;
  });

const getCwd = (events: readonly EventRecord[]): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "tool_request") continue;
    const payload = event.payload as { args?: unknown } | undefined;
    if (!payload?.args || typeof payload.args !== "object") continue;
    const args = payload.args as Record<string, unknown>;
    const cwd =
      asNonEmptyString(args.working_directory) ??
      asNonEmptyString(args.workdir) ??
      asNonEmptyString(args.cwd);
    if (cwd) return cwd;
  }
  return undefined;
};

type UseEventRowsOptions = {
  messages: MessageRecord[];
  maxItems?: number;
};

type UseEventRowsResult = {
  rows: EventRowViewModel[];
};

export const assistantRowHasNonBackgroundContent = (
  row: AssistantRowViewModel,
): boolean =>
  row.text.trim().length > 0 ||
  Boolean(row.officePreviewRef) ||
  Boolean(row.resourcePayload) ||
  (row.inlineImagePayloads?.length ?? 0) > 0 ||
  (row.webSearchResults?.length ?? 0) > 0 ||
  (row.mapArtifacts?.length ?? 0) > 0 ||
  (row.sourceDiffPayloads?.length ?? 0) > 0 ||
  Boolean(row.voiceSession) ||
  (row.agentCompletion?.sections.length ?? 0) > 0 ||
  Boolean(row.customSlot);

export const dedupeAgentCompletionRows = (
  rows: EventRowViewModel[],
  droppedRowIndices: Set<number>,
): void => {
  const completionKey = (section: AgentCompletionSection) =>
    section.completionEventId ??
    `${section.agentId}\u001f${section.completedAtMs}`;
  const latestCompletionOwner = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.kind !== "assistant" || !row.agentCompletion) return;
    for (const section of row.agentCompletion.sections) {
      latestCompletionOwner.set(completionKey(section), index);
    }
  });
  rows.forEach((row, index) => {
    if (row.kind !== "assistant" || !row.agentCompletion) return;
    const surviving = row.agentCompletion.sections.filter(
      (section) => latestCompletionOwner.get(completionKey(section)) === index,
    );
    if (surviving.length === row.agentCompletion.sections.length) return;
    if (surviving.length > 0) {
      row.agentCompletion = { sections: surviving };
      return;
    }
    const { agentCompletion: _omitCompletion, ...rest } = row;
    if (assistantRowHasNonBackgroundContent(rest) || rest.backgroundWork) {
      rows[index] = rest;
    } else {

      droppedRowIndices.add(index);
    }
  });
};

export const projectAgentCompletionSections = (
  toolEvents: readonly EventRecord[],
  lifecycleIndex: BackgroundTaskLifecycleIndex,
  agentId?: string,
): AgentCompletionSection[] => {
  const sections = new Map<string, AgentCompletionSection>();
  for (const event of toolEvents) {
    if (!isAgentCompletedEvent(event)) continue;
    const startEventId = lifecycleIndex.startEventIdByLifecycleEventId.get(
      event._id,
    );
    const section = startEventId
      ? lifecycleIndex.byStartEventId.get(startEventId)?.completion
      : undefined;
    if (!section) continue;
    if (agentId !== undefined && section.agentId !== agentId) continue;
    sections.set(section.completionEventId ?? event._id, section);
  }
  return [...sections.values()];
};

export const isIntraTurnAssistantRuntime = (
  runtime:
    | { followedByToolCall?: boolean; turnComplete?: boolean }
    | null
    | undefined,
): boolean =>
  runtime?.followedByToolCall === true && runtime?.turnComplete !== true;

const isImageOnlyInlineRow = (row: AssistantRowViewModel): boolean =>
  row.text.trim().length === 0 &&
  (row.inlineImagePayloads?.length ?? 0) > 0 &&
  !row.officePreviewRef &&
  !row.resourcePayload &&
  !row.sourceDiffPayloads?.length &&
  !row.voiceSession &&
  !row.backgroundWork &&
  !row.agentCompletion?.sections.length &&
  !row.customSlot;

const coalesceInlineImageRows = (
  rows: EventRowViewModel[],
): EventRowViewModel[] => {
  const out: EventRowViewModel[] = [];
  for (const row of rows) {
    if (row.kind !== "assistant" || !isImageOnlyInlineRow(row)) {
      out.push(row);
      continue;
    }
    const prev = out[out.length - 1];
    if (
      prev?.kind === "assistant" &&
      prev.replyToUserMessageId === row.replyToUserMessageId &&
      !prev.officePreviewRef &&
      !prev.resourcePayload &&
      !prev.sourceDiffPayloads?.length &&
      !prev.backgroundWork &&
      !prev.agentCompletion?.sections.length &&
      !prev.customSlot
    ) {
      out[out.length - 1] = {
        ...prev,
        inlineImagePayloads: [
          ...(prev.inlineImagePayloads ?? []),
          ...(row.inlineImagePayloads ?? []),
        ],
      };
      continue;
    }
    out.push(row);
  }
  return out;
};

const isVoiceOnlyRow = (row: AssistantRowViewModel): boolean =>
  !!row.voiceSession &&
  row.text.trim().length === 0 &&
  !row.officePreviewRef &&
  !row.resourcePayload &&
  !row.inlineImagePayloads?.length &&
  !row.sourceDiffPayloads?.length &&
  !row.backgroundWork &&
  !row.agentCompletion?.sections.length &&
  !row.customSlot;

const coalesceVoiceSessionRows = (
  rows: EventRowViewModel[],
): EventRowViewModel[] => {
  const out: EventRowViewModel[] = [];
  for (const row of rows) {
    if (row.kind !== "assistant" || !isVoiceOnlyRow(row)) {
      out.push(row);
      continue;
    }
    const prev = out[out.length - 1];
    if (
      prev?.kind === "assistant" &&
      isVoiceOnlyRow(prev) &&
      prev.voiceSession &&
      row.voiceSession
    ) {
      out[out.length - 1] = {
        ...prev,
        voiceSession: {
          ...prev.voiceSession,
          durationMs:
            prev.voiceSession.durationMs + row.voiceSession.durationMs,
        },
      };
      continue;
    }
    out.push(row);
  }
  return out;
};

export function useEventRows(opts: UseEventRowsOptions): UseEventRowsResult {
  const developerResourcePreviewsEnabled =
    useDeveloperResourcePreviewsEnabled();
  const { messages, maxItems } = opts;

  const displayMessages = useMemo(
    () => suppressCompletedDirectPreambleText(filterMessagesForUiDisplay(messages)),
    [messages],
  );

  const lifecycleCacheRef = useRef<{
    toolEventsByIndex: ReadonlyArray<readonly EventRecord[]>;
    result: BackgroundTaskLifecycleIndex;
  } | null>(null);
  const lifecycleIndex = useMemo<BackgroundTaskLifecycleIndex>(() => {
    const cache = lifecycleCacheRef.current;
    if (
      cache &&
      cache.toolEventsByIndex.length === messages.length &&
      messages.every((message, index) => {
        const prior = cache.toolEventsByIndex[index];
        return (
          prior === message.toolEvents ||
          (prior?.length === 0 && message.toolEvents.length === 0)
        );
      })
    ) {
      return cache.result;
    }
    const events: EventRecord[] = [];
    const toolEventsByIndex: Array<readonly EventRecord[]> = [];
    for (const message of messages) {
      toolEventsByIndex.push(message.toolEvents);
      for (const event of message.toolEvents) events.push(event);
    }
    const result = buildBackgroundTaskLifecycleIndex(events);
    lifecycleCacheRef.current = { toolEventsByIndex, result };
    return result;
  }, [messages]);

  const projectionCacheRef = useRef<{
    devFlag: boolean;
    byMessage: WeakMap<
      MessageRecord,
      { rows: EventRowViewModel[]; indexWithinTurn: number }
    >;
  }>({
    devFlag: developerResourcePreviewsEnabled,
    byMessage: new WeakMap(),
  });

  const allRows = useMemo<EventRowViewModel[]>(() => {
    const computed: EventRowViewModel[] = [];

    const assistantCountByUserMessageId = new Map<string, number>();

    const buildBackgroundWorks = (toolEvents: readonly EventRecord[]) =>
      getBackgroundWorks(toolEvents).map((base) => ({
        ...base,
        ...resolveBackgroundTaskCardLifecycle(
          base.threadIds,
          base.startEventIdsByThread,
          lifecycleIndex,
        ),
      }));

    const pushAdditionalBackgroundWorkRows = (
      produced: EventRowViewModel[],
      works: ReturnType<typeof buildBackgroundWorks>,
      baseId: string,
      replyToUserMessageId?: string,
    ) => {
      for (let index = 1; index < works.length; index += 1) {
        const backgroundWork = works[index];
        if (!backgroundWork) continue;
        const id = `${baseId}:agent-activity:${backgroundWork.cardId}`;
        produced.push({
          kind: "assistant",
          id,
          text: "",
          cacheKey: id,
          ...(replyToUserMessageId ? { replyToUserMessageId } : {}),
          backgroundWork,
        });
      }
    };

    const projectionCache = projectionCacheRef.current;
    if (projectionCache.devFlag !== developerResourcePreviewsEnabled) {
      projectionCache.devFlag = developerResourcePreviewsEnabled;
      projectionCache.byMessage = new WeakMap();
    }
    const cacheByMessage = projectionCache.byMessage;

    for (const message of displayMessages) {

      let indexWithinTurn = -1;
      let assistantReplyId: string | undefined;
      if (isAssistantMessage(message)) {
        const indexPayload = getMessagePayload(message);
        assistantReplyId =
          typeof indexPayload?.userMessageId === "string" &&
          indexPayload.userMessageId.length > 0
            ? indexPayload.userMessageId
            : undefined;
        if (assistantReplyId !== undefined) {
          indexWithinTurn =
            (assistantCountByUserMessageId.get(assistantReplyId) ?? 0) + 1;
          assistantCountByUserMessageId.set(assistantReplyId, indexWithinTurn);
        }
      }

      const cachedProjection = cacheByMessage.get(message);
      if (
        cachedProjection &&
        cachedProjection.indexWithinTurn === indexWithinTurn
      ) {
        for (const cachedRow of cachedProjection.rows) computed.push(cachedRow);
        continue;
      }

      const produced: EventRowViewModel[] = [];

      if (isUserMessage(message)) {
        const contextMetadata = getMessagePayload(message)?.metadata?.context;
        const windowLabel =
          typeof contextMetadata?.windowLabel === "string" &&
          contextMetadata.windowLabel.trim()
            ? contextMetadata.windowLabel.trim()
            : undefined;
        const windowPreviewImageUrl =
          typeof contextMetadata?.windowPreviewImageUrl === "string" &&
          contextMetadata.windowPreviewImageUrl.trim()
            ? contextMetadata.windowPreviewImageUrl.trim()
            : undefined;

        const appSelectionLabels = (() => {
          const plural = Array.isArray(contextMetadata?.appSelectionLabels)
            ? contextMetadata.appSelectionLabels
                .filter((label): label is string => typeof label === "string")
                .map((label) => label.trim())
                .filter((label) => label.length > 0)
            : [];
          if (plural.length > 0) return plural;
          const singular =
            typeof contextMetadata?.appSelectionLabel === "string" &&
            contextMetadata.appSelectionLabel.trim()
              ? contextMetadata.appSelectionLabel.trim()
              : undefined;
          return singular ? [singular] : [];
        })();
        const activityLabel =
          typeof contextMetadata?.activityLabel === "string" &&
          contextMetadata.activityLabel.trim()
            ? contextMetadata.activityLabel.trim()
            : undefined;
        const pastedTexts =
          Array.isArray(contextMetadata?.pastedTexts) &&
          contextMetadata.pastedTexts.length > 0
            ? contextMetadata.pastedTexts
            : undefined;
        const quotedText =
          typeof contextMetadata?.quotedText === "string" &&
          contextMetadata.quotedText.trim()
            ? contextMetadata.quotedText.trim()
            : undefined;
        const row: UserRowViewModel = {
          kind: "user",
          id: message._id,
          text: getDisplayUserText(message),
          timestampMs: message.timestamp,
          ...(windowLabel ? { windowLabel } : {}),
          ...(windowPreviewImageUrl ? { windowPreviewImageUrl } : {}),
          ...(appSelectionLabels.length > 0 ? { appSelectionLabels } : {}),
          ...(activityLabel ? { activityLabel } : {}),
          ...(pastedTexts ? { pastedTexts } : {}),
          ...(quotedText ? { quotedText } : {}),
          attachments: getAttachments(message),
          ...(getChannelEnvelope(message)
            ? { channelEnvelope: getChannelEnvelope(message) }
            : {}),
        };
        produced.push(row);

        const userBackgroundWorks = buildBackgroundWorks(message.toolEvents);
        const userBackgroundWork = userBackgroundWorks[0];
        if (userBackgroundWork) {
          const activityKey = `assistant-agent-activity-${message._id}`;
          produced.push({
            kind: "assistant",
            id: activityKey,
            text: "",
            cacheKey: activityKey,
            replyToUserMessageId: message._id,
            backgroundWork: userBackgroundWork,
            sourceMessageId: message._id,
            ...(typeof message.sequence === "number"
              ? { sourceMessageSequence: message.sequence }
              : {}),
            ...(message.toolEventSummary
              ? { toolEventSummary: message.toolEventSummary }
              : {}),
          });
          pushAdditionalBackgroundWorkRows(
            produced,
            userBackgroundWorks,
            activityKey,
            message._id,
          );
        }
      } else if (isAssistantMessage(message)) {
        const text = getDisplayMessageText(message);
        const payload = getMessagePayload(message);
        const replyToUserMessageId = assistantReplyId;

        const runtimeMetadata = (
          payload?.metadata as
            | {
                runtime?: {
                  responseTarget?: AgentResponseTarget;
                  followedByToolCall?: boolean;
                  turnComplete?: boolean;
                  heldForHandoff?: boolean;
                };
              }
            | undefined
        )?.runtime;
        if (runtimeMetadata?.heldForHandoff === true) {
          continue;
        }
        const responseTarget = runtimeMetadata?.responseTarget;

        const stableKey =
          replyToUserMessageId !== undefined
            ? assistantScrollFollowKey(replyToUserMessageId, indexWithinTurn)
            : message._id;
        const toolEvents = message.toolEvents;
        const resourcePayload = deriveTurnResource(
          toolEvents,
          text,
          getCwd(toolEvents),
          { developerResourcesEnabled: developerResourcePreviewsEnabled },
        );
        const inlineImagePayloads = deriveTurnInlineImagePayloads(toolEvents);
        const webSearchResults = deriveTurnWebSearchResults(toolEvents);
        const mapArtifacts = deriveTurnMapArtifacts(toolEvents);
        const sourceDiffPayloads = collectTurnSourceDiffPayloads(toolEvents, {
          developerResourcesEnabled: developerResourcePreviewsEnabled,
          assistantText: text,
        });
        const officePreviewRef = getOfficePreviewRef(toolEvents);
        const voiceSession = payload?.metadata?.voiceSession;
        const backgroundWorks = buildBackgroundWorks(toolEvents);
        const backgroundWork = backgroundWorks[0];
        const agentCompletionSections = projectAgentCompletionSections(
          toolEvents,
          lifecycleIndex,
        );
        const isIntraTurn = isIntraTurnAssistantRuntime(runtimeMetadata);
        const row: AssistantRowViewModel = {
          kind: "assistant",
          id: stableKey,

          text: voiceSession ? "" : text,
          timestampMs: message.timestamp,
          cacheKey: stableKey,
          sourceMessageId: message._id,
          ...(typeof message.sequence === "number"
            ? { sourceMessageSequence: message.sequence }
            : {}),
          ...(message.toolEventSummary
            ? { toolEventSummary: message.toolEventSummary }
            : {}),
          ...(isIntraTurn ? { isIntraTurn: true } : {}),
          ...(responseTarget ? { responseTarget } : {}),
          ...(replyToUserMessageId ? { replyToUserMessageId } : {}),
          ...(officePreviewRef ? { officePreviewRef } : {}),
          ...(resourcePayload ? { resourcePayload } : {}),
          ...(inlineImagePayloads.length > 0 ? { inlineImagePayloads } : {}),
          ...(webSearchResults.length > 0 ? { webSearchResults } : {}),
          ...(mapArtifacts.length > 0 ? { mapArtifacts } : {}),
          ...(sourceDiffPayloads.length > 0 ? { sourceDiffPayloads } : {}),
          ...(voiceSession ? { voiceSession } : {}),
          ...(backgroundWork ? { backgroundWork } : {}),
          ...(agentCompletionSections.length > 0
            ? { agentCompletion: { sections: agentCompletionSections } }
            : {}),
        };
        produced.push(row);
        pushAdditionalBackgroundWorkRows(
          produced,
          backgroundWorks,
          stableKey,
          replyToUserMessageId,
        );
      }

      const hasAgentActivityCard = produced.some(
        (producedRow) =>
          producedRow.kind === "assistant" &&
          (Boolean(producedRow.backgroundWork) ||
            (producedRow.agentCompletion?.sections.length ?? 0) > 0),
      );
      if (hasAgentActivityCard) {
        cacheByMessage.delete(message);
      } else {
        cacheByMessage.set(message, { rows: produced, indexWithinTurn });
      }
      for (const producedRow of produced) computed.push(producedRow);
    }

    const latestOwnerByThread = new Map<string, number>();
    computed.forEach((row, index) => {
      if (row.kind !== "assistant" || !row.backgroundWork) return;
      for (const id of row.backgroundWork.threadIds) {
        latestOwnerByThread.set(id, index);
      }
    });
    const ownerBackgroundWorkForThread = (id: string) => {
      const ownerIndex = latestOwnerByThread.get(id);
      if (ownerIndex === undefined) return undefined;
      const owner = computed[ownerIndex];
      if (owner?.kind !== "assistant" || !owner.backgroundWork)
        return undefined;
      return owner.backgroundWork;
    };
    const droppedRowIndices = new Set<number>();
    computed.forEach((row, index) => {
      if (row.kind !== "assistant" || !row.backgroundWork) return;
      const superseded: string[] = [];
      const duplicated = new Set<string>();
      const replaced = new Set<string>();
      for (const id of row.backgroundWork.threadIds) {
        if (latestOwnerByThread.get(id) === index) continue;
        const owner = ownerBackgroundWorkForThread(id);
        const ownerStartEventId = owner?.startEventIdsByThread[id];
        const selfStartEventId = row.backgroundWork.startEventIdsByThread[id];
        if (
          ownerStartEventId !== undefined &&
          selfStartEventId === ownerStartEventId
        ) {
          duplicated.add(id);
        } else if (
          ownerStartEventId &&
          selfStartEventId &&
          owner?.followUpThreadIds?.includes(id) &&
          followUpReplacesActivePredecessor(
            selfStartEventId,
            ownerStartEventId,
            lifecycleIndex,
          )
        ) {
          replaced.add(id);
        } else if (owner?.followUpThreadIds?.includes(id)) {

          superseded.push(id);
        } else {
          superseded.push(id);
        }
      }
      const removed = new Set([...duplicated, ...replaced]);
      if (removed.size === 0) {
        if (superseded.length > 0) {
          row.backgroundWork = {
            ...row.backgroundWork,
            supersededThreadIds: superseded,
          };
        }
        return;
      }
      const remainingThreadIds = row.backgroundWork.threadIds.filter(
        (id) => !removed.has(id),
      );
      if (remainingThreadIds.length === 0) {
        if (assistantRowHasNonBackgroundContent(row)) {
          const { backgroundWork: _omit, ...rest } = row;
          computed[index] = rest;
        } else {

          droppedRowIndices.add(index);
        }
        return;
      }
      const descriptions = { ...row.backgroundWork.descriptions };
      const spawnedAtMs = { ...(row.backgroundWork.spawnedAtMs ?? {}) };
      const statusTexts = { ...(row.backgroundWork.statusTexts ?? {}) };
      const progressTexts = { ...(row.backgroundWork.progressTexts ?? {}) };
      const toolActivities = { ...(row.backgroundWork.toolActivities ?? {}) };
      const startEventIdsByThread = {
        ...row.backgroundWork.startEventIdsByThread,
      };
      const attemptGenerationsByThread = {
        ...(row.backgroundWork.attemptGenerationsByThread ?? {}),
      };
      const rootRunIdsByThread = { ...row.backgroundWork.rootRunIdsByThread };
      const terminalEventIdsByThread = {
        ...(row.backgroundWork.terminalEventIdsByThread ?? {}),
      };
      for (const id of removed) {
        delete descriptions[id];
        delete spawnedAtMs[id];
        delete statusTexts[id];
        delete progressTexts[id];
        delete toolActivities[id];
        delete startEventIdsByThread[id];
        delete attemptGenerationsByThread[id];
        delete rootRunIdsByThread[id];
        delete terminalEventIdsByThread[id];
      }
      const remainingSuperseded = superseded.filter((id) =>
        remainingThreadIds.includes(id),
      );
      const followUpThreadIds = (
        row.backgroundWork.followUpThreadIds ?? []
      ).filter((id) => !removed.has(id));
      row.backgroundWork = {
        ...row.backgroundWork,
        threadIds: remainingThreadIds,
        completedThreadIds: row.backgroundWork.completedThreadIds.filter(
          (id) => !removed.has(id),
        ),
        ...(row.backgroundWork.pausedThreadIds
          ? {
              pausedThreadIds: row.backgroundWork.pausedThreadIds.filter(
                (id) => !removed.has(id),
              ),
            }
          : {}),
        ...(row.backgroundWork.failedThreadIds
          ? {
              failedThreadIds: row.backgroundWork.failedThreadIds.filter(
                (id) => !removed.has(id),
              ),
            }
          : {}),
        descriptions,
        spawnedAtMs,
        statusTexts,
        progressTexts,
        toolActivities,
        startEventIdsByThread,
        attemptGenerationsByThread,
        rootRunIdsByThread,
        terminalEventIdsByThread,
        completionSections: (
          row.backgroundWork.completionSections ?? []
        ).filter(
          (section) =>
            !section.startEventId ||
            !removed.has(section.agentId) ||
            startEventIdsByThread[section.agentId] === section.startEventId,
        ),
        cardId: `agent-activity:${remainingThreadIds
          .map((id) => startEventIdsByThread[id])
          .filter(Boolean)
          .join("+")}`,
        followUpThreadIds,
        ...(remainingSuperseded.length > 0
          ? { supersededThreadIds: remainingSuperseded }
          : {}),
      };
    });

    dedupeAgentCompletionRows(computed, droppedRowIndices);

    const deduped =
      droppedRowIndices.size > 0
        ? computed.filter((_, index) => !droppedRowIndices.has(index))
        : computed;

    return coalesceVoiceSessionRows(coalesceInlineImageRows(deduped));
  }, [developerResourcePreviewsEnabled, displayMessages, lifecycleIndex]);

  const rowsStableRef = useRef<StableTurnRowsState<EventRowViewModel> | null>(
    null,
  );

  const stableRowsState = useMemo(
    () => stabilizeTurnRows(allRows, rowsStableRef.current, eventRowEqual),
    [allRows],
  );

  useLayoutEffect(() => {
    rowsStableRef.current = stableRowsState;
  }, [stableRowsState]);

  const stableRows = stableRowsState.result;

  const slicedRows = useMemo(() => {
    if (typeof maxItems !== "number") return stableRows;
    const cap = Math.max(0, Math.floor(maxItems));
    if (cap <= 0) return [];
    if (stableRows.length <= cap) return stableRows;
    return stableRows.slice(stableRows.length - cap);
  }, [maxItems, stableRows]);

  return {
    rows: slicedRows,
  };
}
