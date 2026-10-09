import type { CloudExecutionSelection } from "../agent-engine.js";
import type { CloudOrchestratorCliTurnSpec } from "../cloud-orchestrator-cli.js";

/**
 * Turn starts on the cloud-builder worker.
 *
 *   POST {socketOrigin}/conversations/{conversationId}/turns
 *
 * Authentication is one of:
 *   - `Authorization: Bearer <Better Auth JWT>` (desktop, web shell, mobile);
 *   - `Authorization: Bearer <BUILDER_SERVICE_SECRET>` plus
 *     `x-stella-owner-id` and `x-stella-owner-generation` (service-originated
 *     turns: schedules, execution placement's cloud branch).
 *
 * The conversation Durable Object owns admission: idempotency on
 * `clientMsgId`, owner adoption for a fresh conversation, policy through the
 * owner gate, journaling the prompt, minting the turn capabilities, and
 * queueing the run.
 */

export const TURN_PLANE_PROTOCOL = 1 as const;

export const TURN_START_PATH_PREFIX = "/conversations" as const;
export const turnStartPath = (conversationId: string): string =>
  `${TURN_START_PATH_PREFIX}/${encodeURIComponent(conversationId)}/turns`;

export const TURN_OWNER_ID_HEADER = "x-stella-owner-id" as const;
export const TURN_OWNER_GENERATION_HEADER =
  "x-stella-owner-generation" as const;

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
  /** Report fixed with the terminal decision, never parsed from the wake prompt. */
  lifecycleReport?: string;
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

/**
 * The agent runtime a conversation runs on. `pi` is Stella's runtime on
 * pi-durable; absent is the established loop. Chosen by the turn that
 * creates the conversation and kept for its life.
 */
export type CloudAgentRuntime = "pi";

/**
 * A cloud agent a computer's pi-durable orchestrator runs in this
 * conversation, so it keeps working while the computer sleeps. The turn
 * starts it, messages it or pauses it instead of answering; the agent runs
 * on pi-durable in the conversation's object, and its report goes back to
 * that computer's orchestrator through the journal (an `agent-report`
 * card addressed to it).
 */
export type CloudPiAgentRequest = {
  op: "start" | "message" | "pause";
  /** The agent's thread id, chosen by the computer that started it. */
  threadId: string;
  /** For `start`: the agent's name. */
  description?: string;
  /** The computer whose orchestrator gets the agent's reports. */
  originDeviceId: string;
};

export const PI_AGENT_THREAD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export type CloudTurnStartRequest = {
  protocol: typeof TURN_PLANE_PROTOCOL;
  clientMsgId: string;
  /** Original renderer echo identity when placement assigns a new canonical id. */
  originUserMessageId?: string;
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
  /** Honored only on the turn that creates the conversation. */
  agentRuntime?: CloudAgentRuntime;
  /** The turn controls a computer's cloud agent instead of asking Stella (prompt: its brief or message). */
  piAgent?: CloudPiAgentRequest;
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
  | "owner_purged"
  | "generation_stale"
  | "execution_unavailable"
  /** Anonymous owners may not use this lane or helper; sign in to continue. */
  | "sign_in_required"
  | "subscription_required"
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
// An agent attempt in a container: the owner's own engines (Claude, Codex)
// and Claude Code's orchestrator turns. Dispatched object to object by the
// conversation and the owner's agent threads; an agent on Stella's models
// runs in its conversation instead, as a pi agent.
// ---------------------------------------------------------------------------

export type CloudAgentTurnSource =
  | "desktop"
  | "placement"
  | "browser-resume"
  | "agent-thread"
  /** The OrchestratorSession's own chat turn on the Claude Code CLI. */
  | "orchestrator";

export type CloudAgentTurnStartRequest = {
  protocol: typeof TURN_PLANE_PROTOCOL;
  kind: "agent";
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  threadId: string;
  /**
   * Root-spawned agents are depth 1; their children are depth 2. An
   * orchestrator turn is depth 0.
   */
  agentDepth: number;
  /** The BuildSession thread that spawned this one, absent for root spawns. */
  parentThreadId?: string;
  /** 1 for a fresh thread; N+1 for a continuation of an existing thread. */
  attemptGeneration: number;
  /**
   * Caller-minted turn id the session must adopt when present, so a row it
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
  /**
   * Present only on the OrchestratorSession's own chat turn for an
   * `anthropic` execution (see cloud-orchestrator-cli.ts). That dispatch has
   * `source: "orchestrator"`, `agentDepth: 0`, no parent thread,
   * `threadId: orchestratorCliThreadId(conversationId)` and the DO's chat
   * turn id as `turnId`; each chat turn is the next attempt of that thread.
   */
  agentRole?: "orchestrator";
  /** Present exactly when `agentRole` is `"orchestrator"`. */
  orchestratorCli?: CloudOrchestratorCliTurnSpec;
};

export type CloudAgentTurnStartResponse = {
  protocol: typeof TURN_PLANE_PROTOCOL;
  threadId: string;
  turnId: string;
  attemptGeneration: number;
  accepted: true;
  replayed: boolean;
};
