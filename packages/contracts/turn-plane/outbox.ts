import type { CloudExecutionSelection } from "../agent-engine.js";
import type {
  CloudAgentWorkspace,
  CloudTurnLane,
  CloudTurnSource,
} from "./turn-start.js";

/**
 * The outbox is the only write path from the cloud-builder data plane to the
 * Convex control plane. Durable Objects append events to the `TURN_OUTBOX`
 * queue; the consumer batches them into `POST /api/cloud/outbox`.
 *
 * Every event carries a `key` that makes it idempotent on the Convex side.
 * Delivery is at-least-once and may reorder; projections must therefore be
 * fenced (epoch/seq) or keyed (turnId/eventSeq), never append-only.
 */

export const OUTBOX_EVENT_VERSION = 1 as const;
export const CONVEX_OUTBOX_PATH = "/api/cloud/outbox" as const;
export const OUTBOX_MAX_BATCH = 50;

type OutboxBase = {
  v: typeof OUTBOX_EVENT_VERSION;
  /** Idempotency key, unique per (kind, key). */
  key: string;
  ownerId: string;
  ownerGeneration: string;
  emittedAt: number;
};

export type ConversationCreatedEvent = OutboxBase & {
  kind: "conversation.created";
  conversationId: string;
  createdAt: number;
  title: string;
  execution?: CloudExecutionSelection;
};

/** Today's `/api/cloud/index` payload. Fenced on (epoch, lastSeq) in Convex. */
export type ConversationIndexEvent = OutboxBase & {
  kind: "conversation.index";
  conversationId: string;
  epoch: number;
  lastSeq: number;
  updatedAt: number;
  createdAt?: number;
  title?: string;
  lastPreview?: string;
  lastRole?: string;
  activity?: "idle" | "running";
  force?: boolean;
};

export type ConversationDeletedEvent = OutboxBase & {
  kind: "conversation.deleted";
  conversationId: string;
  deletedAt: number;
};

export type TurnKind = "chat" | "agent" | "app";

/** Replaces the `agent_turns` insert Convex used to do at dispatch. */
export type TurnStartedEvent = OutboxBase & {
  kind: "turn.started";
  turnId: string;
  turnKind: TurnKind;
  conversationId: string;
  sessionId: string;
  lane: CloudTurnLane | "agent" | "build";
  source?: CloudTurnSource;
  clientMsgId?: string;
  hidden?: boolean;
  threadId?: string;
  attemptGeneration?: number;
  agentType: string;
  execution: CloudExecutionSelection;
  prompt: string;
  createdAt: number;
};

/** Today's `/api/cloud/events` payload, with an explicit per-turn ordinal. */
export type TurnEventEvent = OutboxBase & {
  kind: "turn.event";
  turnId: string;
  attemptGeneration?: number;
  sessionId: string;
  /** Monotonic per turn attempt, assigned by the DO. */
  eventSeq: number;
  eventKind: string;
  payload: unknown;
  terminal: boolean;
  terminalStatus?: "completed" | "failed" | "canceled" | "waiting_for_user";
  errorMessage?: string;
  resultJson?: string;
  createdAt: number;
};

export type ThreadSpawnedEvent = OutboxBase & {
  kind: "thread.spawned";
  threadId: string;
  conversationId: string;
  parentTurnId: string;
  parentThreadId?: string;
  agentDepth: number;
  attemptGeneration: number;
  description: string;
  prompt: string;
  execution: CloudExecutionSelection;
  placement: "cloud";
  workspace?: CloudAgentWorkspace;
  workspaceForkId?: string;
  originDeviceId?: string;
  originConversationId?: string;
  createdAt: number;
};

export type ThreadCompletedEvent = OutboxBase & {
  kind: "thread.completed";
  threadId: string;
  turnId: string;
  attemptGeneration: number;
  status: "completed" | "failed" | "canceled" | "waiting_for_user";
  resultJson?: string;
  errorMessage?: string;
  completedAt: number;
};

export type BuildRecordedEvent = OutboxBase & {
  kind: "build.recorded";
  buildId: string;
  payload: unknown;
};

export type InteriorBuildRecordedEvent = OutboxBase & {
  kind: "interior-build.recorded";
  buildId: string;
  payload: unknown;
};

/**
 * Placement projection for the activity UI. Emitted by the owner gate on
 * every dispatch transition; `key` is `${dispatchId}:${revision}` and Convex
 * keeps the highest revision it has seen.
 */
export type DispatchUpdatedEvent = OutboxBase & {
  kind: "dispatch.updated";
  dispatchId: string;
  dispatch: import("./placement.js").DispatchSummary;
};

export type OutboxEvent =
  | DispatchUpdatedEvent
  | ConversationCreatedEvent
  | ConversationIndexEvent
  | ConversationDeletedEvent
  | TurnStartedEvent
  | TurnEventEvent
  | ThreadSpawnedEvent
  | ThreadCompletedEvent
  | BuildRecordedEvent
  | InteriorBuildRecordedEvent;

export type OutboxEventKind = OutboxEvent["kind"];

export type OutboxBatch = {
  v: typeof OUTBOX_EVENT_VERSION;
  events: OutboxEvent[];
};

export type OutboxRejectReason =
  | "owner_purged"
  | "owner_mismatch"
  | "generation_stale"
  | "stale_epoch"
  | "stale"
  | "unknown_turn"
  | "unknown_thread"
  | "invalid";

export type OutboxBatchResult = {
  applied: string[];
  duplicate: string[];
  /** Permanent rejections: the consumer acks them and logs. */
  rejected: Array<{
    kind: OutboxEventKind;
    key: string;
    reason: OutboxRejectReason;
  }>;
};

export const outboxEventId = (
  event: Pick<OutboxEvent, "kind" | "key">,
): string => `${event.kind}:${event.key}`;
