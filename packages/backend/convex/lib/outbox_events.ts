import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { DispatchSummary } from "@stella/contracts/turn-plane/placement";
import {
  OUTBOX_EVENT_VERSION,
  type OutboxEvent,
  type OutboxEventKind,
  type OutboxRejectReason,
  type TurnKind,
} from "@stella/contracts/turn-plane/outbox";

/**
 * Wire validation for `POST /api/cloud/outbox` events. Pure, so the same
 * checks run in Bun tests. Every accepted event is a well-typed `OutboxEvent`;
 * unknown fields are dropped, anything structurally wrong is a permanent
 * `invalid` rejection (the consumer acks and logs).
 */

export const OUTBOX_EVENT_KINDS: readonly OutboxEventKind[] = [
  "conversation.created",
  "conversation.index",
  "conversation.deleted",
  "turn.started",
  "turn.event",
  "thread.spawned",
  "thread.completed",
  "build.recorded",
  "interior-build.recorded",
  "dispatch.updated",
];

/**
 * Apply order inside one batch. Queue delivery may reorder, so a batch is
 * sorted parent-before-child. The sort is stable, so events of one kind keep
 * their delivery order.
 */
const KIND_PRIORITY: Record<OutboxEventKind, number> = {
  "conversation.created": 0,
  "turn.started": 1,
  "thread.spawned": 2,
  "conversation.index": 3,
  "turn.event": 4,
  "build.recorded": 5,
  "interior-build.recorded": 5,
  "thread.completed": 6,
  "conversation.deleted": 7,
  // Placement projection: keyed by dispatchId and revision-fenced, so it has
  // no parent in the batch and its position is only about stable ordering.
  "dispatch.updated": 8,
};

export const sortOutboxBatch = <T extends { kind: OutboxEventKind }>(
  events: readonly T[],
): T[] =>
  events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        KIND_PRIORITY[a.event.kind] - KIND_PRIORITY[b.event.kind] ||
        a.index - b.index,
    )
    .map((entry) => entry.event);

const MAX_ID = 512;
const MAX_KEY = 1_024;
const MAX_PROMPT = 64 * 1024;
const MAX_TEXT = 64 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown, max = MAX_ID): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
const isFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isNatural = (value: unknown, min = 0): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min;
/** `undefined` when absent, the id when valid, `null` when present but bad. */
const optionalId = (value: unknown): string | undefined | null =>
  value === undefined || value === null
    ? undefined
    : isId(value)
      ? value
      : null;

const EXECUTION_ENGINES = new Set(["stella", "anthropic", "openai-codex"]);
const REASONING_EFFORTS = new Set([
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const parseExecutionSelection = (
  value: unknown,
): CloudExecutionSelection => {
  if (
    !isRecord(value) ||
    typeof value.engine !== "string" ||
    !EXECUTION_ENGINES.has(value.engine) ||
    typeof value.provider !== "string" ||
    value.provider !== value.engine ||
    !isId(value.model, 256) ||
    typeof value.reasoningEffort !== "string" ||
    !REASONING_EFFORTS.has(value.reasoningEffort)
  ) {
    throw new Error("execution is invalid");
  }
  return {
    engine: value.engine,
    provider: value.provider,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
  } as CloudExecutionSelection;
};

const TURN_KINDS = new Set<TurnKind>(["chat", "agent", "app"]);
const TURN_LANES = new Set(["chat", "wake", "schedule", "agent", "build"]);
const TURN_SOURCES = new Set([
  "desktop",
  "web",
  "mobile",
  "schedule",
  "agent-thread",
  "placement",
  "probe",
]);
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "canceled",
  "waiting_for_user",
]);

const DISPATCH_KINDS = new Set(["chat", "agent"]);
const DISPATCH_INGRESSES = new Set([
  "desktop",
  "mobile",
  "browser",
  "cloud",
  "schedule",
]);
const DISPATCH_SUBJECTS = new Set(["portable", "computer", "cloud"]);
const DISPATCH_TARGET_MODES = new Set(["automatic", "cloud", "device"]);
const DISPATCH_PLACEMENTS = new Set(["computer", "cloud"]);
const DISPATCH_STATES = new Set([
  "offering",
  "computer_claimed",
  "computer_accepted",
  "computer_running",
  "cloud_committed",
  "cloud_running",
  "cancel_pending",
  "reconciliation_required",
  "blocked",
  "completed",
  "failed",
  "canceled",
]);

const MAX_DISPATCH_REASON = 512;

/** Absent stays absent; present-but-malformed rejects the whole event. */
const requireOptionalId = (value: unknown): string | undefined => {
  const parsed = optionalId(value);
  if (parsed === null) throw new Error("dispatch is invalid");
  return parsed;
};

const requireOptionalText = (
  value: unknown,
  max: number,
): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isText(value, max)) throw new Error("dispatch is invalid");
  return value;
};

/** Throws (caught by the caller as a rejection) when the summary is malformed. */
const parseDispatchSummary = (value: unknown): DispatchSummary => {
  if (!isRecord(value)) throw new Error("dispatch is invalid");
  const optionals = {
    requestedExecutorDeviceId: requireOptionalId(
      value.requestedExecutorDeviceId,
    ),
    parentTurnId: requireOptionalId(value.parentTurnId),
    threadId: requireOptionalId(value.threadId),
    executorDeviceId: requireOptionalId(value.executorDeviceId),
    executorPresenceSessionId: requireOptionalId(
      value.executorPresenceSessionId,
    ),
    cancelRequestId: requireOptionalId(value.cancelRequestId),
    cloudTurnId: requireOptionalId(value.cloudTurnId),
    cloudThreadId: requireOptionalId(value.cloudThreadId),
    errorCode: requireOptionalId(value.errorCode),
    fallbackReason: requireOptionalText(
      value.fallbackReason,
      MAX_DISPATCH_REASON,
    ),
    cancelReason: requireOptionalText(value.cancelReason, MAX_DISPATCH_REASON),
    errorMessage: requireOptionalText(value.errorMessage, MAX_TEXT),
  };
  if (
    !isId(value.dispatchId, 128) ||
    !isId(value.idempotencyKey, 256) ||
    typeof value.kind !== "string" ||
    !DISPATCH_KINDS.has(value.kind) ||
    typeof value.ingress !== "string" ||
    !DISPATCH_INGRESSES.has(value.ingress) ||
    typeof value.subject !== "string" ||
    !DISPATCH_SUBJECTS.has(value.subject) ||
    (value.requestedTargetMode !== undefined &&
      (typeof value.requestedTargetMode !== "string" ||
        !DISPATCH_TARGET_MODES.has(value.requestedTargetMode))) ||
    !isId(value.conversationId) ||
    typeof value.state !== "string" ||
    !DISPATCH_STATES.has(value.state) ||
    (value.placement !== undefined &&
      (typeof value.placement !== "string" ||
        !DISPATCH_PLACEMENTS.has(value.placement))) ||
    !isNatural(value.revision) ||
    !isFinite(value.createdAt) ||
    !isFinite(value.updatedAt)
  ) {
    throw new Error("dispatch is invalid");
  }
  return {
    dispatchId: value.dispatchId,
    idempotencyKey: value.idempotencyKey,
    kind: value.kind as DispatchSummary["kind"],
    ingress: value.ingress as DispatchSummary["ingress"],
    subject: value.subject as DispatchSummary["subject"],
    ...(value.requestedTargetMode !== undefined
      ? {
          requestedTargetMode:
            value.requestedTargetMode as DispatchSummary["requestedTargetMode"],
        }
      : {}),
    ...(optionals.requestedExecutorDeviceId !== undefined
      ? { requestedExecutorDeviceId: optionals.requestedExecutorDeviceId }
      : {}),
    conversationId: value.conversationId,
    ...(optionals.parentTurnId !== undefined
      ? { parentTurnId: optionals.parentTurnId }
      : {}),
    ...(optionals.threadId !== undefined
      ? { threadId: optionals.threadId }
      : {}),
    state: value.state as DispatchSummary["state"],
    ...(value.placement !== undefined
      ? { placement: value.placement as DispatchSummary["placement"] }
      : {}),
    ...(optionals.executorDeviceId !== undefined
      ? { executorDeviceId: optionals.executorDeviceId }
      : {}),
    ...(optionals.executorPresenceSessionId !== undefined
      ? { executorPresenceSessionId: optionals.executorPresenceSessionId }
      : {}),
    revision: value.revision,
    ...(optionals.fallbackReason !== undefined
      ? { fallbackReason: optionals.fallbackReason }
      : {}),
    ...(optionals.cancelRequestId !== undefined
      ? { cancelRequestId: optionals.cancelRequestId }
      : {}),
    ...(optionals.cancelReason !== undefined
      ? { cancelReason: optionals.cancelReason }
      : {}),
    ...(optionals.errorCode !== undefined
      ? { errorCode: optionals.errorCode }
      : {}),
    ...(optionals.errorMessage !== undefined
      ? { errorMessage: optionals.errorMessage }
      : {}),
    ...(optionals.cloudTurnId !== undefined
      ? { cloudTurnId: optionals.cloudTurnId }
      : {}),
    ...(optionals.cloudThreadId !== undefined
      ? { cloudThreadId: optionals.cloudThreadId }
      : {}),
    createdAt: Math.floor(value.createdAt),
    updatedAt: Math.floor(value.updatedAt),
  };
};

export type ParsedOutboxEvent =
  | { ok: true; event: OutboxEvent }
  | { ok: false; kind: string; key: string; reason: OutboxRejectReason };

export const parseOutboxEvent = (raw: unknown): ParsedOutboxEvent => {
  const record = isRecord(raw) ? raw : {};
  const kind = typeof record.kind === "string" ? record.kind : "";
  const key = isId(record.key, MAX_KEY) ? record.key : "";
  const reject = (): ParsedOutboxEvent => ({
    ok: false,
    kind,
    key,
    reason: "invalid",
  });
  if (
    !kind ||
    !key ||
    !(OUTBOX_EVENT_KINDS as readonly string[]).includes(kind) ||
    record.v !== OUTBOX_EVENT_VERSION ||
    !isId(record.ownerId) ||
    !isId(record.ownerGeneration) ||
    !isFinite(record.emittedAt)
  ) {
    return reject();
  }
  const base = {
    v: OUTBOX_EVENT_VERSION,
    key,
    ownerId: record.ownerId,
    ownerGeneration: record.ownerGeneration,
    emittedAt: record.emittedAt,
  } as const;
  const eventKind = kind as OutboxEventKind;
  try {
    switch (eventKind) {
      case "conversation.created": {
        if (
          !isId(record.conversationId) ||
          !isFinite(record.createdAt) ||
          !isText(record.title, MAX_TEXT)
        ) {
          return reject();
        }
        return {
          ok: true,
          event: {
            ...base,
            kind: eventKind,
            conversationId: record.conversationId,
            createdAt: record.createdAt,
            title: record.title,
            ...(record.execution !== undefined && record.execution !== null
              ? { execution: parseExecutionSelection(record.execution) }
              : {}),
          },
        };
      }
      case "conversation.index": {
        if (
          !isId(record.conversationId) ||
          !isFinite(record.epoch) ||
          !isFinite(record.lastSeq) ||
          !isFinite(record.updatedAt)
        ) {
          return reject();
        }
        const activity =
          record.activity === undefined
            ? undefined
            : record.activity === "idle" || record.activity === "running"
              ? record.activity
              : null;
        if (activity === null) return reject();
        return {
          ok: true,
          event: {
            ...base,
            kind: eventKind,
            conversationId: record.conversationId,
            epoch: Math.floor(record.epoch),
            lastSeq: Math.floor(record.lastSeq),
            updatedAt: Math.floor(record.updatedAt),
            ...(isFinite(record.createdAt)
              ? { createdAt: Math.floor(record.createdAt) }
              : {}),
            ...(isText(record.title, MAX_TEXT) ? { title: record.title } : {}),
            ...(isText(record.lastPreview, MAX_TEXT)
              ? { lastPreview: record.lastPreview }
              : {}),
            ...(isId(record.lastRole, 64) ? { lastRole: record.lastRole } : {}),
            ...(activity ? { activity } : {}),
            ...(record.force === true ? { force: true } : {}),
          },
        };
      }
      case "conversation.deleted": {
        if (!isId(record.conversationId) || !isFinite(record.deletedAt)) {
          return reject();
        }
        return {
          ok: true,
          event: {
            ...base,
            kind: eventKind,
            conversationId: record.conversationId,
            deletedAt: record.deletedAt,
          },
        };
      }
      case "turn.started": {
        if (
          !isId(record.turnId) ||
          typeof record.turnKind !== "string" ||
          !TURN_KINDS.has(record.turnKind as TurnKind) ||
          !isId(record.conversationId) ||
          !isId(record.sessionId) ||
          typeof record.lane !== "string" ||
          !TURN_LANES.has(record.lane) ||
          (record.source !== undefined &&
            (typeof record.source !== "string" ||
              !TURN_SOURCES.has(record.source))) ||
          (record.clientMsgId !== undefined &&
            !isId(record.clientMsgId, 256)) ||
          (record.hidden !== undefined && typeof record.hidden !== "boolean") ||
          (record.threadId !== undefined && !isId(record.threadId)) ||
          (record.attemptGeneration !== undefined &&
            !isNatural(record.attemptGeneration, 1)) ||
          !isId(record.agentType, 128) ||
          !isText(record.prompt, MAX_PROMPT) ||
          !isFinite(record.createdAt)
        ) {
          return reject();
        }
        return {
          ok: true,
          event: {
            ...base,
            kind: eventKind,
            turnId: record.turnId,
            turnKind: record.turnKind as TurnKind,
            conversationId: record.conversationId,
            sessionId: record.sessionId,
            lane: record.lane as
              | "chat"
              | "wake"
              | "schedule"
              | "agent"
              | "build",
            ...(record.source !== undefined
              ? { source: record.source as never }
              : {}),
            ...(record.clientMsgId !== undefined
              ? { clientMsgId: record.clientMsgId }
              : {}),
            ...(record.hidden !== undefined ? { hidden: record.hidden } : {}),
            ...(record.threadId !== undefined
              ? { threadId: record.threadId }
              : {}),
            ...(record.attemptGeneration !== undefined
              ? { attemptGeneration: record.attemptGeneration }
              : {}),
            agentType: record.agentType,
            execution: parseExecutionSelection(record.execution),
            prompt: record.prompt,
            createdAt: record.createdAt,
          },
        };
      }
      case "turn.event": {
        if (
          !isId(record.turnId) ||
          (record.attemptGeneration !== undefined &&
            !isNatural(record.attemptGeneration, 1)) ||
          !isId(record.sessionId) ||
          !isNatural(record.eventSeq) ||
          !isId(record.eventKind, 128) ||
          typeof record.terminal !== "boolean" ||
          (record.terminalStatus !== undefined &&
            (typeof record.terminalStatus !== "string" ||
              !TERMINAL_STATUSES.has(record.terminalStatus))) ||
          (record.errorMessage !== undefined &&
            !isText(record.errorMessage, MAX_TEXT)) ||
          (record.resultJson !== undefined &&
            !isText(record.resultJson, MAX_RESULT_BYTES)) ||
          !isFinite(record.createdAt)
        ) {
          return reject();
        }
        return {
          ok: true,
          event: {
            ...base,
            kind: eventKind,
            turnId: record.turnId,
            ...(record.attemptGeneration !== undefined
              ? { attemptGeneration: record.attemptGeneration }
              : {}),
            sessionId: record.sessionId,
            eventSeq: record.eventSeq,
            eventKind: record.eventKind,
            payload: record.payload,
            terminal: record.terminal,
            ...(record.terminalStatus !== undefined
              ? { terminalStatus: record.terminalStatus as never }
              : {}),
            ...(record.errorMessage !== undefined
              ? { errorMessage: record.errorMessage }
              : {}),
            ...(record.resultJson !== undefined
              ? { resultJson: record.resultJson }
              : {}),
            createdAt: record.createdAt,
          },
        };
      }
      case "thread.spawned": {
        const originDeviceId = optionalId(record.originDeviceId);
        const originConversationId = optionalId(record.originConversationId);
        const parentThreadId = optionalId(record.parentThreadId);
        const workspace = optionalId(record.workspace);
        if (
          !isId(record.threadId) ||
          !isId(record.conversationId) ||
          !isId(record.parentTurnId) ||
          parentThreadId === null ||
          !isNatural(record.agentDepth, 1) ||
          record.agentDepth > 2 ||
          (record.agentDepth === 1 && parentThreadId !== undefined) ||
          (record.agentDepth === 2 && parentThreadId === undefined) ||
          !isNatural(record.attemptGeneration, 1) ||
          !isText(record.description, MAX_TEXT) ||
          !isText(record.prompt, MAX_PROMPT) ||
          record.placement !== "cloud" ||
          originDeviceId === null ||
          originConversationId === null ||
          workspace === null ||
          Boolean(originDeviceId) !== Boolean(originConversationId) ||
          !isFinite(record.createdAt)
        ) {
          return reject();
        }
        return {
          ok: true,
          event: {
            ...base,
            kind: eventKind,
            threadId: record.threadId,
            conversationId: record.conversationId,
            parentTurnId: record.parentTurnId,
            ...(parentThreadId ? { parentThreadId } : {}),
            agentDepth: record.agentDepth,
            attemptGeneration: record.attemptGeneration,
            description: record.description,
            prompt: record.prompt,
            execution: parseExecutionSelection(record.execution),
            placement: "cloud",
            ...(workspace ? { workspace } : {}),
            ...(originDeviceId ? { originDeviceId } : {}),
            ...(originConversationId ? { originConversationId } : {}),
            createdAt: record.createdAt,
          },
        };
      }
      case "thread.completed": {
        if (
          !isId(record.threadId) ||
          !isId(record.turnId) ||
          !isNatural(record.attemptGeneration, 1) ||
          typeof record.status !== "string" ||
          !TERMINAL_STATUSES.has(record.status) ||
          (record.resultJson !== undefined &&
            !isText(record.resultJson, MAX_RESULT_BYTES)) ||
          (record.errorMessage !== undefined &&
            !isText(record.errorMessage, MAX_TEXT)) ||
          !isFinite(record.completedAt)
        ) {
          return reject();
        }
        return {
          ok: true,
          event: {
            ...base,
            kind: eventKind,
            threadId: record.threadId,
            turnId: record.turnId,
            attemptGeneration: record.attemptGeneration,
            status: record.status as never,
            ...(record.resultJson !== undefined
              ? { resultJson: record.resultJson }
              : {}),
            ...(record.errorMessage !== undefined
              ? { errorMessage: record.errorMessage }
              : {}),
            completedAt: record.completedAt,
          },
        };
      }
      case "dispatch.updated": {
        if (!isId(record.dispatchId, 128)) return reject();
        const dispatch = parseDispatchSummary(record.dispatch);
        if (dispatch.dispatchId !== record.dispatchId) return reject();
        // The gate keys the event `${dispatchId}:${revision}`; a receipt that
        // did not describe this exact revision would make replay unsafe.
        if (key !== `${dispatch.dispatchId}:${dispatch.revision}`) {
          return reject();
        }
        return {
          ok: true,
          event: {
            ...base,
            kind: eventKind,
            dispatchId: dispatch.dispatchId,
            dispatch,
          },
        };
      }
      case "build.recorded":
      case "interior-build.recorded": {
        if (!isId(record.buildId) || !isRecord(record.payload)) return reject();
        return {
          ok: true,
          event: {
            ...base,
            kind: eventKind,
            buildId: record.buildId,
            payload: record.payload,
          } as OutboxEvent,
        };
      }
    }
  } catch {
    return reject();
  }
  return reject();
};
