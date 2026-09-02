import type { CloudExecutionSelection } from "../agent-engine.js";

/**
 * Turn starts on the cloud-builder worker.
 *
 *   POST {socketOrigin}/conversations/{conversationId}/turns
 *
 * Authentication is one of:
 *   - `Authorization: Bearer <Better Auth JWT>` (desktop, web shell, mobile);
 *   - `Authorization: Bearer <BUILDER_SERVICE_SECRET>` plus
 *     `x-stella-owner-id` and `x-stella-owner-generation` (Convex-originated
 *     turns: schedules, execution placement's cloud branch).
 *
 * The conversation Durable Object owns admission: idempotency on
 * `clientMsgId`, owner adoption for a fresh conversation, quota through the
 * owner gate, journaling the prompt, minting the turn capabilities, and
 * queueing the run. Convex learns about the turn through the outbox.
 */

export const TURN_PLANE_PROTOCOL = 1 as const;

export const TURN_START_PATH_PREFIX = "/conversations" as const;
export const turnStartPath = (conversationId: string): string =>
  `${TURN_START_PATH_PREFIX}/${encodeURIComponent(conversationId)}/turns`;

export const TURN_OWNER_ID_HEADER = "x-stella-owner-id" as const;
export const TURN_OWNER_GENERATION_HEADER = "x-stella-owner-generation" as const;

/** Client-visible lanes. `wake` and `schedule` require service authentication. */
export type CloudTurnLane = "chat" | "wake" | "schedule";

export type CloudTurnSource =
  | "desktop"
  | "web"
  | "mobile"
  | "schedule"
  | "agent-thread"
  | "placement"
  | "probe";

export const CLIENT_MSG_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;
export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
export const TURN_PROMPT_MAX_CHARS = 8_000;
export const TURN_ATTACHMENTS_MAX = 4;
export const TURN_TITLE_MAX_CHARS = 120;

export type CloudAgentThreadControl = {
  threadId: string;
  attemptGeneration: number;
  threadUpdatedAt: number;
  status:
    | "running"
    | "waiting_for_user"
    | "resuming"
    | "completed"
    | "failed"
    | "canceled";
};

export type CloudTurnStartRequest = {
  protocol: typeof TURN_PLANE_PROTOCOL;
  clientMsgId: string;
  prompt: string;
  /** Absent means the owner's default execution from the owner snapshot. */
  execution?: CloudExecutionSelection;
  locale?: string;
  /** Drive paths, at most TURN_ATTACHMENTS_MAX. */
  attachments?: string[];
  lane?: CloudTurnLane;
  source?: CloudTurnSource;
  /** Title hint used only when the conversation is created by this turn. */
  title?: string;
  /** Service-only: the prompt row is journaled but hidden from the UI. */
  hiddenMessage?: boolean;
  /** Service-only: lifecycle control for `wake` turns. */
  agentThreadControl?: CloudAgentThreadControl;
};

export type CloudTurnStartResponse = {
  protocol: typeof TURN_PLANE_PROTOCOL;
  conversationId: string;
  turnId: string;
  accepted: true;
  replayed: boolean;
  createdConversation: boolean;
};

export type CloudTurnStartErrorCode =
  | "unauthorized"
  | "forbidden"
  | "owner_mismatch"
  | "bad_request"
  | "conversation_locked"
  | "idempotency_conflict"
  | "quota_burst"
  | "quota_daily"
  | "quota_concurrency"
  | "owner_purged"
  | "generation_stale"
  | "execution_unavailable"
  /** Anonymous owners may not use this lane or helper; sign in to continue. */
  | "sign_in_required"
  /** The owner's enforcement status refuses service. */
  | "owner_suspended"
  | "internal";

export type CloudTurnStartError = {
  error: {
    code: CloudTurnStartErrorCode;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  };
};

// ---------------------------------------------------------------------------
// Agent turns (BuildSession)
//
//   POST {socketOrigin}/sessions/{threadId}/turns
//
// Service-authenticated only (`Authorization: Bearer <BUILDER_SERVICE_SECRET>`):
// Convex starts these for desktop-dispatched cloud agents, execution
// placement's agent branch, and hosted-browser resumes. The orchestrator's
// own spawns never pass through Convex (OrchestratorSession -> BuildSession).
// Convex learns about the turn through `turn.started` / `thread.spawned`.
// ---------------------------------------------------------------------------

export const AGENT_TURN_START_PATH_PREFIX = "/sessions" as const;
export const agentTurnStartPath = (threadId: string): string =>
  `${AGENT_TURN_START_PATH_PREFIX}/${encodeURIComponent(threadId)}/turns`;

export type CloudAgentTurnSource =
  | "desktop"
  | "placement"
  | "browser-resume"
  | "agent-thread";

export type CloudAgentTurnStartRequest = {
  protocol: typeof TURN_PLANE_PROTOCOL;
  kind: "agent";
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  threadId: string;
  /** 1 for a fresh thread; N+1 for a continuation of an existing thread. */
  attemptGeneration: number;
  /**
   * Convex-minted turn id the session must adopt when present, so a row it
   * projected optimistically (desktop delivery) and the `turn.started` event
   * name the same turn. Absent means the session mints one.
   */
  turnId?: string;
  prompt: string;
  description: string;
  execution: CloudExecutionSelection;
  /** Allowance the session mints the turn capabilities from. */
  audience: string;
  budgetMicroCents: number;
  source: CloudAgentTurnSource;
  /** Reliable-delivery id; a replay returns the same turn. */
  clientMsgId?: string;
  parentTurnId?: string;
  originDeviceId?: string;
  originConversationId?: string;
  /** Hosted-browser resume receipt carried into the resumed attempt. */
  browserResume?: unknown;
};

export type CloudAgentTurnStartResponse = {
  protocol: typeof TURN_PLANE_PROTOCOL;
  threadId: string;
  turnId: string;
  attemptGeneration: number;
  accepted: true;
  replayed: boolean;
};
