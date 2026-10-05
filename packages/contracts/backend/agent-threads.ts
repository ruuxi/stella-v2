import type { CloudExecutionSelection } from "../agent-engine.js";

/**
 * Agent threads: every background agent the owner has, cloud or desktop,
 * indexed in the owner's object for Activity, the running pill, reports and
 * the originating desktop's delivery.
 */

export type AgentThreadPlacement = "cloud" | "computer";

export type AgentThreadSummary = {
  /** The account this row belongs to; clients drop rows for any other. */
  ownerId: string;
  threadId: string;
  conversationId: string;
  parentTurnId?: string;
  parentThreadId?: string;
  /** The paired device running this thread for someone else, if any. */
  executorDeviceId?: string;
  description: string;
  placement: AgentThreadPlacement;
  agentType: string;
  status: string;
  attemptGeneration: number;
  resultJson?: string;
  errorMessage?: string;
  /** Progress of the running attempt; absent once the thread is terminal. */
  activity?: AgentThreadActivity;
  createdAt: number;
  updatedAt: number;
};

export type AgentThreadLookup = AgentThreadSummary & {
  originDeviceId?: string;
  originDeviceLabel?: string;
  executorDeviceLabel?: string;
};

/** A thread the originating desktop has yet to persist locally. */
export type DeviceAgentThread = AgentThreadSummary & {
  originDeviceId: string;
  originConversationId: string;
  ownerGeneration: string;
};

/**
 * The exact state a desktop holds for a cloud thread it dispatched. Every
 * follow-up names it, so a request built from a stale view fails instead of
 * acting on a newer attempt.
 */
export type AgentThreadControl = {
  threadId: string;
  conversationId: string;
  attemptGeneration: number;
  threadUpdatedAt: number;
  status: string;
  waitingForDevice?: boolean;
};

/**
 * The running attempt's own progress, as last reported by whatever is
 * executing it. The thread row's `updatedAt` only moves at attempt
 * boundaries, so without this a running thread read through the ledger is
 * indistinguishable from a wedged one.
 */
export type AgentThreadActivity = {
  lastActivityAt: number;
  label?: string;
  activeToolCount?: number;
};

/**
 * What a caller is told when its agent was accepted but its device could not
 * take the work yet. Shared so the cloud and a desktop describe the same
 * queued agent the same way instead of one of them calling it "running".
 */
export const DEVICE_AGENT_QUEUED_NOTE =
  "That device is offline or isn't accepting work right now, so this agent is queued. It retries automatically for up to 60 minutes.";

type Origin = { originDeviceId: string; originConversationId: string };

export type AgentThreadCalls = {
  "agentThreads.page": {
    args: {
      conversationId: string;
      before?: { updatedAt: number; threadId: string };
      limit?: number;
    };
    result: { threads: AgentThreadSummary[]; hasMore: boolean };
  };
  /**
   * Start a remote agent for a desktop: in the cloud, or on another of the
   * owner's devices when `targetDeviceId` names one. `clientMsgId` makes a
   * retried request return the original thread. Without `conversationId` the
   * agent reports into the owner's newest conversation.
   */
  "agentThreads.spawnFromDesktop": {
    args: Origin & {
      ownerGeneration: string;
      clientMsgId: string;
      description: string;
      prompt: string;
      conversationId?: string;
      execution?: CloudExecutionSelection;
      targetDeviceId?: string;
      /** Device target: the `spawn_agent` model that device runs the agent on. */
      model?: string;
    };
    result: AgentThreadControl;
  };
  "agentThreads.lookup": {
    args: { conversationId: string; threadId: string };
    result: AgentThreadLookup | null;
  };
  /** Send a follow-up to a finished desktop-dispatched cloud thread. */
  "agentThreads.continueFromDesktop": {
    args: Origin & {
      ownerGeneration: string;
      threadId: string;
      expectedAttemptGeneration: number;
      expectedTerminalUpdatedAt: number;
      description: string;
      prompt: string;
      controlRequestId: string;
    };
    result: AgentThreadControl;
  };
  /** Stop a running desktop-dispatched cloud thread. Idempotent per request id. */
  "agentThreads.cancel": {
    args: Origin & {
      ownerGeneration: string;
      threadId: string;
      expectedAttemptGeneration: number;
      expectedThreadUpdatedAt: number;
      controlRequestId: string;
    };
    result: { canceled: boolean; control: AgentThreadControl };
  };
  /** The desktop has durably stored this terminal result. */
  "agentThreads.acknowledgeDelivery": {
    args: {
      threadId: string;
      originDeviceId: string;
      ownerGeneration: string;
      attemptGeneration: number;
      terminalUpdatedAt: number;
    };
    result: { acknowledged: boolean; superseded: boolean };
  };
  /** A desktop agent ("computer" placement) started or resumed. */
  "computerThreads.start": {
    args: {
      threadId: string;
      ownerGeneration: string;
      conversationId: string;
      originDeviceId: string;
      description: string;
      agentType: string;
      attemptGeneration: number;
    };
    result: { threadId: string };
  };
  "computerThreads.complete": {
    args: {
      threadId: string;
      ownerGeneration: string;
      originDeviceId: string;
      attemptGeneration: number;
      status: "completed" | "failed" | "canceled";
      result?: string;
      error?: string;
    };
    result: { updated: boolean; status: string };
  };
  "computerThreads.cancel": {
    args: {
      threadId: string;
      ownerGeneration: string;
      originDeviceId: string;
      attemptGeneration: number;
      reason?: string;
    };
    result: { canceled: boolean; status: string };
  };
  "computerThreads.get": {
    args: { threadId: string; originDeviceId: string; ownerGeneration: string };
    result: ComputerThreadRecord | null;
  };
};

export type ComputerThreadRecord = {
  threadId: string;
  status: "running" | "completed" | "error" | "canceled";
  description: string;
  attemptGeneration: number;
  startedAt: number;
  completedAt: number | null;
  result: string | null;
  error: string | null;
};

/** Why `computerThreads.start` refused, in `BackendError.reason`. */
export type ComputerThreadStartRejection =
  | "conversation_not_found"
  | "thread_identity_conflict"
  | "attempt_replay_conflict"
  | "attempt_stale"
  | "attempt_not_next"
  | "initial_attempt_invalid";

export type AgentThreadViews = {
  "agentThreads.recent": { args: { limit?: number }; result: AgentThreadSummary[] };
  "agentThreads.running": {
    args: { conversationId: string };
    result: AgentThreadSummary[];
  };
  /** One conversation's newest threads; raise `limit` to reach older ones. */
  "agentThreads.forConversation": {
    args: { conversationId: string; limit?: number };
    result: { threads: AgentThreadSummary[]; hasMore: boolean };
  };
  "agentThreads.get": {
    args: { conversationId: string; threadId: string };
    result: AgentThreadSummary | null;
  };
  /** Threads this desktop dispatched or ran that it hasn't acknowledged yet. */
  "agentThreads.forDevice": {
    args: { originDeviceId: string; ownerGeneration: string; limit?: number };
    result: DeviceAgentThread[];
  };
};

export const RUNNING_AGENT_THREADS_LIMIT = 64;
export const AGENT_THREAD_PAGE_MAX = 50;
export const CONVERSATION_AGENT_THREADS_MAX = 500;
export const AGENT_PROMPT_MAX_CHARS = 8_000;
