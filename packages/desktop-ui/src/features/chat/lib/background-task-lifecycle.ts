import type { EventRecord } from "./event-transforms";
import {
  fallbackTaskDescription,
  isAgentCanceledEvent,
  isAgentCompletedEvent,
  isAgentFailedEvent,
  isAgentProgressEvent,
  isAgentStartedEvent,
} from "./event-transforms";
import {
  buildAgentCompletionSections,
  type AgentCompletionSection,
} from "./agent-completion";
import type { TaskToolActivity } from "@stella/contracts/agent-runtime";

export type BackgroundTaskCardStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled";

/**
 * Canonical state for one visible background-work occurrence. Identity is the
 * persisted `agent-started` event id, not the durable thread id: `send_input`
 * reuses a thread and can even start it more than once inside one root run.
 */
export type BackgroundTaskCardState = {
  cardId: string;
  startEventId: string;
  agentId: string;
  rootRunId?: string;
  attemptGeneration?: number;
  startedAtMs: number;
  title: string;
  agentType?: string;
  groupKey?: string;
  groupLabel?: string;
  isFollowUp: boolean;
  status: BackgroundTaskCardStatus;
  latestEventId: string;
  latestEventAtMs: number;
  progressText?: string;
  toolActivity?: TaskToolActivity;
  errorText?: string;
  terminalEventId?: string;
  completion?: AgentCompletionSection;
};

export type BackgroundTaskLifecycleIndex = {
  byStartEventId: ReadonlyMap<string, BackgroundTaskCardState>;
  startEventIdByLifecycleEventId: ReadonlyMap<string, string>;
};

export type ResolvedBackgroundTaskCardLifecycle = {
  completedThreadIds: string[];
  pausedThreadIds: string[];
  failedThreadIds: string[];
  progressTexts: Record<string, string>;
  toolActivities: Record<string, TaskToolActivity>;
  terminalEventIdsByThread: Record<string, string>;
  completionSections: AgentCompletionSection[];
};

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const correlationKey = (agentId: string, rootRunId?: string): string =>
  `${agentId}\u001f${rootRunId ?? "legacy"}`;

const attemptKey = (agentId: string, attemptGeneration: number): string =>
  `${agentId}\u001e${attemptGeneration}`;

/** Numeric attempt identity carried by new runtime lifecycle rows. */
export const lifecycleAttemptGeneration = (
  event: EventRecord,
): number | undefined => {
  const value = (event.payload as { attemptGeneration?: unknown } | undefined)
    ?.attemptGeneration;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
};

const lifecyclePhase = (event: EventRecord): number => {
  if (isAgentStartedEvent(event)) return 0;
  if (isAgentProgressEvent(event)) return 1;
  if (
    isAgentCompletedEvent(event) ||
    isAgentFailedEvent(event) ||
    isAgentCanceledEvent(event)
  ) {
    return 2;
  }
  return 1;
};

/** Attempt generation is authoritative when both rows carry it. Timestamp and
 * event id are the explicit compatibility fallback when either row is legacy. */
export const compareLifecycleEvents = (
  a: EventRecord,
  b: EventRecord,
): number => {
  const aAgentId = asNonEmptyString(
    (a.payload as { agentId?: unknown } | undefined)?.agentId,
  );
  const bAgentId = asNonEmptyString(
    (b.payload as { agentId?: unknown } | undefined)?.agentId,
  );
  if (aAgentId && aAgentId === bAgentId) {
    const aAttempt = lifecycleAttemptGeneration(a);
    const bAttempt = lifecycleAttemptGeneration(b);
    if (
      aAttempt !== undefined &&
      bAttempt !== undefined &&
      aAttempt !== bAttempt
    ) {
      return aAttempt - bAttempt;
    }
    if (aAttempt !== undefined && aAttempt === bAttempt) {
      const phase = lifecyclePhase(a) - lifecyclePhase(b);
      if (phase !== 0) return phase;
    }
  }
  return a.timestamp - b.timestamp || a._id.localeCompare(b._id);
};

/** Preserve cross-agent and legacy timeline slots while ordering each durable
 * thread's generation-aware packets by attempt. A previously persisted start
 * may have generation while its old terminal does not, so legacy packets must
 * remain on their timestamp/id fallback path instead of being moved wholesale
 * before or after generated packets. */
export const orderLifecycleEventsByAttempt = (
  events: readonly EventRecord[],
): EventRecord[] => {
  const legacyOrdered = [...events].sort(
    (a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id),
  );
  const generatedByAgent = new Map<string, EventRecord[]>();
  for (const event of legacyOrdered) {
    const agentId = asNonEmptyString(
      (event.payload as { agentId?: unknown } | undefined)?.agentId,
    );
    if (!agentId || lifecycleAttemptGeneration(event) === undefined) continue;
    const group = generatedByAgent.get(agentId) ?? [];
    group.push(event);
    generatedByAgent.set(agentId, group);
  }
  for (const group of generatedByAgent.values()) {
    group.sort(compareLifecycleEvents);
  }
  const cursorByAgent = new Map<string, number>();
  return legacyOrdered.map((event) => {
    const agentId = asNonEmptyString(
      (event.payload as { agentId?: unknown } | undefined)?.agentId,
    );
    if (!agentId || lifecycleAttemptGeneration(event) === undefined) {
      return event;
    }
    const cursor = cursorByAgent.get(agentId) ?? 0;
    cursorByAgent.set(agentId, cursor + 1);
    return generatedByAgent.get(agentId)?.[cursor] ?? event;
  });
};

const cardTitle = (
  event: EventRecord & {
    payload: {
      agentId: string;
      description?: string;
      statusText?: string;
      groupLabel?: string;
      isFollowUp?: boolean;
    };
  },
): string => {
  const agentId = asNonEmptyString(event.payload.agentId) ?? "task";
  const followUpTitle = event.payload.isFollowUp
    ? asNonEmptyString(event.payload.statusText)
    : undefined;
  return (
    followUpTitle ??
    asNonEmptyString(event.payload.description) ??
    asNonEmptyString(event.payload.groupLabel) ??
    fallbackTaskDescription(agentId)
  );
};

const completionFor = (
  event: EventRecord,
  state: BackgroundTaskCardState,
): AgentCompletionSection | undefined => {
  const sections = buildAgentCompletionSections(
    [event],
    new Map([
      [
        state.agentId,
        {
          description: state.title,
          agentType: state.agentType,
          groupLabel: state.groupLabel,
        },
      ],
    ]),
  );
  const section = sections[0];
  if (!section) return undefined;
  return {
    ...section,
    startEventId: state.startEventId,
    completionEventId: event._id,
    ...(state.rootRunId ? { rootRunId: state.rootRunId } : {}),
    ...(state.attemptGeneration !== undefined
      ? { attemptGeneration: state.attemptGeneration }
      : {}),
  };
};

/**
 * Fold lifecycle events into spawn-anchored card state.
 *
 * Raw events are deduplicated by id before the fold because the live/SQLite
 * handoff can briefly project one event onto two messages. Terminal events
 * resolve to the latest `agent-started` in their `(agentId, rootRunId)`
 * stream. The start event remains the card's identity and insertion anchor;
 * completion time never becomes a second timeline anchor.
 */
export const buildBackgroundTaskLifecycleIndex = (
  events: ReadonlyArray<EventRecord>,
): BackgroundTaskLifecycleIndex => {
  const unique = new Map<string, EventRecord>();
  for (const event of events) unique.set(event._id, event);
  const ordered = orderLifecycleEventsByAttempt([...unique.values()]);

  const mutableByStart = new Map<string, BackgroundTaskCardState>();
  const startByAttempt = new Map<string, string>();
  const latestStartByCorrelation = new Map<string, string>();
  const latestStartByAgent = new Map<string, string>();
  const latestLegacyStartByCorrelation = new Map<string, string>();
  const latestLegacyStartByAgent = new Map<string, string>();
  const pendingProgressByAttempt = new Map<string, string>();
  const pendingProgressByCorrelation = new Map<string, string>();
  const startByLifecycleEvent = new Map<string, string>();

  const resolveStart = (
    agentId: string,
    rootRunId?: string,
    attemptGeneration?: number,
  ): string | undefined => {
    if (attemptGeneration !== undefined) {
      return (
        startByAttempt.get(attemptKey(agentId, attemptGeneration)) ??
        (rootRunId
          ? latestLegacyStartByCorrelation.get(
              correlationKey(agentId, rootRunId),
            )
          : latestLegacyStartByAgent.get(agentId))
      );
    }
    return rootRunId
      ? latestStartByCorrelation.get(correlationKey(agentId, rootRunId))
      : latestStartByAgent.get(agentId);
  };

  for (const event of ordered) {
    if (isAgentStartedEvent(event)) {
      const agentId = asNonEmptyString(event.payload.agentId);
      if (!agentId) continue;
      const rootRunId = asNonEmptyString(event.payload.rootRunId);
      const attemptGeneration = lifecycleAttemptGeneration(event);
      const key = correlationKey(agentId, rootRunId);
      const pending =
        (attemptGeneration !== undefined
          ? pendingProgressByAttempt.get(attemptKey(agentId, attemptGeneration))
          : undefined) ?? pendingProgressByCorrelation.get(key);
      const state: BackgroundTaskCardState = {
        cardId: `agent-start:${event._id}`,
        startEventId: event._id,
        agentId,
        ...(rootRunId ? { rootRunId } : {}),
        ...(attemptGeneration !== undefined ? { attemptGeneration } : {}),
        startedAtMs: event.timestamp,
        title: cardTitle(event),
        ...(asNonEmptyString(event.payload.agentType)
          ? { agentType: asNonEmptyString(event.payload.agentType) }
          : {}),
        ...(asNonEmptyString(event.payload.groupKey)
          ? { groupKey: asNonEmptyString(event.payload.groupKey) }
          : {}),
        ...(asNonEmptyString(event.payload.groupLabel)
          ? { groupLabel: asNonEmptyString(event.payload.groupLabel) }
          : {}),
        isFollowUp: event.payload.isFollowUp === true,
        status: "running",
        latestEventId: event._id,
        latestEventAtMs: event.timestamp,
        ...(pending ? { progressText: pending } : {}),
      };
      mutableByStart.set(event._id, state);
      if (attemptGeneration !== undefined) {
        startByAttempt.set(attemptKey(agentId, attemptGeneration), event._id);
        pendingProgressByAttempt.delete(attemptKey(agentId, attemptGeneration));
      } else {
        latestLegacyStartByCorrelation.set(key, event._id);
        latestLegacyStartByAgent.set(agentId, event._id);
      }
      latestStartByCorrelation.set(key, event._id);
      latestStartByAgent.set(agentId, event._id);
      startByLifecycleEvent.set(event._id, event._id);
      pendingProgressByCorrelation.delete(key);
      continue;
    }

    const payload = event.payload as
      | {
          agentId?: unknown;
          rootRunId?: unknown;
          statusText?: unknown;
          toolActivity?: TaskToolActivity;
        }
      | undefined;
    const agentId = asNonEmptyString(payload?.agentId);
    if (!agentId) continue;
    const rootRunId = asNonEmptyString(payload?.rootRunId);
    const attemptGeneration = lifecycleAttemptGeneration(event);
    const key = correlationKey(agentId, rootRunId);

    if (isAgentProgressEvent(event)) {
      const text = asNonEmptyString(event.payload.statusText);
      const startEventId = resolveStart(agentId, rootRunId, attemptGeneration);
      const state = startEventId ? mutableByStart.get(startEventId) : undefined;
      if (!state) {
        if (text) {
          if (attemptGeneration !== undefined) {
            pendingProgressByAttempt.set(
              attemptKey(agentId, attemptGeneration),
              text,
            );
          } else {
            pendingProgressByCorrelation.set(key, text);
          }
        }
        continue;
      }
      startByLifecycleEvent.set(event._id, state.startEventId);
      // A late progress packet must never revive a settled card.
      if (state.status !== "running") continue;
      state.latestEventId = event._id;
      state.latestEventAtMs = event.timestamp;
      if (text) state.progressText = text;
      if (event.payload.toolActivity) {
        state.toolActivity = event.payload.toolActivity;
      } else {
        delete state.toolActivity;
      }
      continue;
    }

    const terminalKind = isAgentCompletedEvent(event)
      ? "completed"
      : isAgentFailedEvent(event)
        ? "failed"
        : isAgentCanceledEvent(event)
          ? "canceled"
          : null;
    if (!terminalKind) continue;
    const startEventId = resolveStart(agentId, rootRunId, attemptGeneration);
    const state = startEventId ? mutableByStart.get(startEventId) : undefined;
    if (
      !state ||
      (attemptGeneration === undefined && event.timestamp < state.startedAtMs)
    ) {
      continue;
    }
    startByLifecycleEvent.set(event._id, state.startEventId);
    state.latestEventId = event._id;
    state.latestEventAtMs = event.timestamp;
    state.terminalEventId = event._id;
    if (terminalKind === "completed") {
      state.status = "completed";
      state.completion = completionFor(event, state);
      delete state.errorText;
    } else if (terminalKind === "failed") {
      state.status = "failed";
      state.errorText = asNonEmptyString(
        (event.payload as { error?: unknown } | undefined)?.error,
      );
      delete state.completion;
    } else {
      state.status = "canceled";
      state.errorText = asNonEmptyString(
        (event.payload as { error?: unknown } | undefined)?.error,
      );
      delete state.completion;
    }
  }

  return {
    byStartEventId: mutableByStart,
    startEventIdByLifecycleEventId: startByLifecycleEvent,
  };
};

/** Project canonical lifecycle state onto one spawn/group card descriptor. */
export const resolveBackgroundTaskCardLifecycle = (
  threadIds: readonly string[],
  startEventIdsByThread: Readonly<Record<string, string>>,
  index: BackgroundTaskLifecycleIndex,
): ResolvedBackgroundTaskCardLifecycle => {
  const resolved: ResolvedBackgroundTaskCardLifecycle = {
    completedThreadIds: [],
    pausedThreadIds: [],
    failedThreadIds: [],
    progressTexts: {},
    toolActivities: {},
    terminalEventIdsByThread: {},
    completionSections: [],
  };
  for (const threadId of threadIds) {
    const startEventId = startEventIdsByThread[threadId];
    const state = startEventId
      ? index.byStartEventId.get(startEventId)
      : undefined;
    if (!state) continue;
    if (state.progressText)
      resolved.progressTexts[threadId] = state.progressText;
    if (state.toolActivity)
      resolved.toolActivities[threadId] = state.toolActivity;
    if (state.terminalEventId) {
      resolved.terminalEventIdsByThread[threadId] = state.terminalEventId;
    }
    if (state.status === "completed") {
      resolved.completedThreadIds.push(threadId);
      if (state.completion) resolved.completionSections.push(state.completion);
    } else if (state.status === "canceled") {
      resolved.pausedThreadIds.push(threadId);
    } else if (state.status === "failed") {
      resolved.failedThreadIds.push(threadId);
    }
  }
  return resolved;
};
