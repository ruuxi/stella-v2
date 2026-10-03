import type { CloudExecutionSelection } from "../agent-engine.js";
import type {
  CloudAgentWorkspace,
  CloudTurnLane,
  CloudTurnSource,
} from "./turn-start.js";

/**
 * What the turn plane tells the owner's object about its conversations and
 * agent turns: the conversation list, the agent-thread index, browser waits
 * and the terminal receipts mobile polls. The orchestrator, BuildSession and
 * conversation objects deliver these straight to `OwnerGate.applyOwnerEvents`.
 *
 * Every event carries a `key`; a producer that cannot reach the owner keeps
 * the batch and retries it, so applying is idempotent and fenced (epoch/seq,
 * attempt generation), never append-only.
 */

export const OWNER_EVENT_VERSION = 1 as const;

type OwnerEventBase = {
  v: typeof OWNER_EVENT_VERSION;
  /** Idempotency key, unique per (kind, key). */
  key: string;
  ownerId: string;
  ownerGeneration: string;
  emittedAt: number;
};

export type ConversationCreatedEvent = OwnerEventBase & {
  kind: "conversation.created";
  conversationId: string;
  createdAt: number;
  title: string;
  execution?: CloudExecutionSelection;
};

/** The conversation's list row, fenced on (epoch, lastSeq). */
export type ConversationIndexEvent = OwnerEventBase & {
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

export type ConversationDeletedEvent = OwnerEventBase & {
  kind: "conversation.deleted";
  conversationId: string;
  deletedAt: number;
};

export type TurnKind = "chat" | "agent" | "app";

export type TurnStartedEvent = OwnerEventBase & {
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

/** One turn event, with an explicit per-turn ordinal. */
export type TurnEventEvent = OwnerEventBase & {
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

export type ThreadSpawnedEvent = OwnerEventBase & {
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

export type ThreadCompletedEvent = OwnerEventBase & {
  kind: "thread.completed";
  threadId: string;
  turnId: string;
  attemptGeneration: number;
  status: "completed" | "failed" | "canceled" | "waiting_for_user";
  resultJson?: string;
  errorMessage?: string;
  completedAt: number;
};

export type OwnerEvent =
  | ConversationCreatedEvent
  | ConversationIndexEvent
  | ConversationDeletedEvent
  | TurnStartedEvent
  | TurnEventEvent
  | ThreadSpawnedEvent
  | ThreadCompletedEvent;

export type OwnerEventKind = OwnerEvent["kind"];

/**
 * The turn events the owner's object reads: terminal states, browser waits
 * (`waiting_for_user`) and produced files. Streaming events stay in the
 * conversation's own journal.
 */
export const ownerReadsTurnEvent = (
  event: Pick<TurnEventEvent, "terminal" | "eventKind">,
): boolean =>
  event.terminal ||
  event.eventKind === "waiting_for_user" ||
  event.eventKind === "output_files";

/** Whether delivering this event to the owner changes anything. */
export const ownerReadsEvent = (event: OwnerEvent): boolean =>
  event.kind !== "turn.event" || ownerReadsTurnEvent(event);
