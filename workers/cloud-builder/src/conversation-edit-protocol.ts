/**
 * Service-only protocol for canonical conversation edits.
 *
 * The public client talks to Convex. Convex derives the owner from auth,
 * captures the current owner-data generation, and sends one of these requests
 * to the builder with the service secret. The worker validates it again before
 * addressing either Durable Object.
 */

export const CONVERSATION_EDIT_LOCK_KEY = "conversationEditLock";
export const CONVERSATION_FORK_TARGET_KEY = "conversationForkTarget";

export const CONVERSATION_EDIT_LEASE_MS = 2 * 60_000;
export const CONVERSATION_EDIT_PAGE_ROWS = 96;
export const CONVERSATION_EDIT_PAGE_BYTES = 512 * 1024;
export const CONVERSATION_EDIT_PAGES_PER_PASS = 64;

const OPAQUE_ID = /^[A-Za-z0-9._:-]{8,256}$/;

export type ConversationEditLock = {
  kind: "fork-source" | "fork-target" | "rewind";
  operationId: string;
  ownerId: string;
  ownerGeneration: string;
  expectedEpoch: number;
  expectedLastSeq: number;
  throughSeq: number;
  expiresAt: number;
};

export type ForkTargetState = {
  operationId: string;
  ownerId: string;
  ownerGeneration: string;
  sourceConversationId: string;
  targetConversationId: string;
  sourceEpoch: number;
  sourceLastSeq: number;
  throughSeq: number;
  nextSeq: number;
  title: string;
  createdAt: number;
  state: "copying" | "complete";
  completedAt?: number;
};

export type ForkConversationEditRequest = {
  v: 1;
  kind: "fork";
  operationId: string;
  ownerId: string;
  ownerGeneration: string;
  sourceConversationId: string;
  targetConversationId: string;
  throughSeq: number;
  expectedEpoch: number;
  expectedLastSeq: number;
  title: string;
  sourceCreatedAt: number;
  targetCreatedAt: number;
};

export type RewindConversationEditRequest = {
  v: 1;
  kind: "rewind";
  operationId: string;
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  throughSeq: number;
  expectedEpoch: number;
  expectedLastSeq: number;
  activeTurnPolicy: "conflict" | "cancel";
};

export type ConversationEditRequest =
  | ForkConversationEditRequest
  | RewindConversationEditRequest;

export type ForkConversationEditResult = {
  complete: boolean;
  kind: "fork";
  operationId: string;
  sourceConversationId: string;
  targetConversationId: string;
  sourceEpoch: number;
  throughSeq: number;
  targetEpoch: number;
  lastSeq: number;
  lastPreview?: string;
  lastRole?: string;
  pendingAtSeq?: number;
};

export type RewindConversationEditResult = {
  complete: boolean;
  kind: "rewind";
  operationId: string;
  conversationId: string;
  previousEpoch: number;
  nextEpoch: number;
  lastSeq: number;
  lastPreview?: string;
  lastRole?: string;
  cancelRequested?: boolean;
};

export type ConversationEditResult =
  | ForkConversationEditResult
  | RewindConversationEditResult;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stringField = (value: unknown, max = 512): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};

const opaqueId = (value: unknown): string | null => {
  const parsed = stringField(value, 256);
  return parsed && OPAQUE_ID.test(parsed) ? parsed : null;
};

const safeInteger = (value: unknown, minimum: number): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : null;

/** Fail-closed parsing for the service-secret builder route. */
export const parseConversationEditRequest = (
  value: unknown,
): ConversationEditRequest | null => {
  const input = record(value);
  if (!input || input.v !== 1) return null;
  const operationId = opaqueId(input.operationId);
  const ownerId = stringField(input.ownerId);
  const ownerGeneration = stringField(input.ownerGeneration);
  const throughSeq = safeInteger(input.throughSeq, -1);
  const expectedEpoch = safeInteger(input.expectedEpoch, 1);
  const expectedLastSeq = safeInteger(input.expectedLastSeq, -1);
  if (
    !operationId ||
    !ownerId ||
    !ownerGeneration ||
    throughSeq === null ||
    expectedEpoch === null ||
    expectedLastSeq === null ||
    throughSeq > expectedLastSeq
  ) {
    return null;
  }
  if (input.kind === "fork") {
    const sourceConversationId = opaqueId(input.sourceConversationId);
    const targetConversationId = opaqueId(input.targetConversationId);
    const title = stringField(input.title, 256);
    const sourceCreatedAt = safeInteger(input.sourceCreatedAt, 0);
    const targetCreatedAt = safeInteger(input.targetCreatedAt, 0);
    if (
      !sourceConversationId ||
      !targetConversationId ||
      sourceConversationId === targetConversationId ||
      !title ||
      sourceCreatedAt === null ||
      targetCreatedAt === null
    ) {
      return null;
    }
    return {
      v: 1,
      kind: "fork",
      operationId,
      ownerId,
      ownerGeneration,
      sourceConversationId,
      targetConversationId,
      throughSeq,
      expectedEpoch,
      expectedLastSeq,
      title,
      sourceCreatedAt,
      targetCreatedAt,
    };
  }
  if (input.kind !== "rewind") return null;
  const conversationId = opaqueId(input.conversationId);
  const activeTurnPolicy =
    input.activeTurnPolicy === "cancel" ? "cancel" : "conflict";
  if (!conversationId) return null;
  return {
    v: 1,
    kind: "rewind",
    operationId,
    ownerId,
    ownerGeneration,
    conversationId,
    throughSeq,
    expectedEpoch,
    expectedLastSeq,
    activeTurnPolicy,
  };
};

export const sameConversationEditLock = (
  lock: ConversationEditLock,
  request: ConversationEditRequest,
): boolean =>
  lock.operationId === request.operationId &&
  lock.ownerId === request.ownerId &&
  lock.ownerGeneration === request.ownerGeneration &&
  lock.expectedEpoch === request.expectedEpoch &&
  lock.expectedLastSeq === request.expectedLastSeq &&
  lock.throughSeq === request.throughSeq &&
  (((lock.kind === "fork-source" || lock.kind === "fork-target") &&
    request.kind === "fork") ||
    (lock.kind === "rewind" && request.kind === "rewind"));

/**
 * A cancel-policy rewind may observe only the terminal/unwind rows written
 * while its own durable lock held. Conflict-policy rewinds and every unrelated
 * lease require the exact socket snapshot head.
 */
export const conversationRewindHeadMatches = (
  request: RewindConversationEditRequest,
  head: { epoch: number; lastSeq: number },
  lock: ConversationEditLock | null,
): boolean =>
  (head.epoch === request.expectedEpoch &&
    head.lastSeq === request.expectedLastSeq) ||
  Boolean(
    request.activeTurnPolicy === "cancel" &&
    lock &&
    sameConversationEditLock(lock, request) &&
    head.epoch === request.expectedEpoch &&
    head.lastSeq >= request.expectedLastSeq,
  );

export const rewindRuntimeAdmission = (
  request: RewindConversationEditRequest,
  state: {
    runtimeWork: boolean;
    queuedTurn: boolean;
    continuingOperation: boolean;
  },
): "proceed" | "turn-conflict" | "queued-conflict" | "cancel" => {
  if (!state.runtimeWork) return "proceed";
  if (state.continuingOperation) return "cancel";
  if (request.activeTurnPolicy === "conflict") return "turn-conflict";
  if (state.queuedTurn) return "queued-conflict";
  return "cancel";
};
