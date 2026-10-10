import type { AgentTool } from "@stella/runtime/kernel/agent-core/types.js";
import type { AgentActivityEntry } from "@stella/contracts/conversation-agent-activity";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { ManagedModelAudience } from "@stella/contracts/gateway/capability";
import type {
  CloudTurnLane,
  CloudTurnSource,
} from "@stella/contracts/turn-plane/turn-start";
import type { MintedTurnCapability } from "../capability-signer.js";
import type { CloudAgentControlReceipt } from "../cloud-agent-dispatch.js";
import type { TurnPhase } from "../conversation-types.js";
import type { LocalTerminalPhase } from "../local-turn-protocol.js";
import type { CloudCliTurnIdentity } from "@stella/contracts/cloud-orchestrator-cli";

export type WakeReport = { prompt: string; lifecycleReport?: string };

/**
 * Binding names/types come from Wrangler. Storage and dev-acceptance fields
 * remain optional here solely for rolling-deploy compatibility and production
 * configurations that omit acceptance probes.
 */
export type Env = Pick<
  Cloudflare.Env,
  | "BUILD_SESSIONS"
  | "ORCHESTRATOR_SESSIONS"
  | "OWNER_GATES"
  | "WORLDS"
  | "LOADER"
  | "BUILDER_SERVICE_SECRET"
> &
  Partial<
    Pick<
      Cloudflare.Env,
      | "AGENT_HOME"
      | "CONVERSATION_ARCHIVE"
      | "ENABLE_DEV_ACCEPTANCE_PROBES"
      | "STELLA_DEPLOYMENT_IDENTITY"
      | "MODEL_GATEWAY"
      | "MODEL_GATEWAY_CONTROL"
      | "MODEL_GATEWAY_OWNERS"
      | "MODEL_GATEWAY_URL"
      | "Sandbox"
      | "SANDBOX_IDLE_TIMEOUT_MS"
      | "CLOUD_BUILDER_PUBLIC_URL"
      | "CAPABILITY_SIGNING_KEY"
      | "CAPABILITY_SIGNING_KID"
      | "DB"
    >
  >;

/**
 * An admitted chat turn, exactly as persisted under `queued:*`. Every field
 * is derived by this DO at admission — from the verified caller, the owner
 * snapshot, and the validated request body — never copied from a caller.
 */
export type ChatTurnRequest = {
  kind: "chat";
  ownerId: string;
  /** Owner-data generation from the owner snapshot at admission. */
  ownerGeneration: string;
  conversationId: string;
  turnId: string;
  sessionId: string;
  prompt: string;
  /** The execution this turn was admitted with; its model capability pins it. */
  execution: CloudExecutionSelection;
  /** Managed-model audience from the owner snapshot at admission. */
  audience: ManagedModelAudience;
  /** Spend ceiling for this turn's model calls (`GATEWAY_BUDGET_UNLIMITED` allowed). */
  budgetMicroCents: number;
  lane: CloudTurnLane;
  source?: CloudTurnSource;
  title?: string;
  // Keeps the prompt out of the rendered transcript (lifecycle and scheduled
  // prompts are context, not something the user typed). Still model context.
  hiddenMessage?: boolean;
  // Resolves the client's optimistic echo against the durable prompt row, and
  // keys the admission receipt.
  clientMsgId: string;
  originUserMessageId?: string;
  // The client's UI locale (e.g. "es", "zh-Hans"), used for the reply-language
  // directive. Persisted per conversation so later turns without one (schedule
  // fires, agent-completion wakes) keep answering in the user's language.
  locale?: string;
  // Drive paths of attached files. Persisted as provider-only prompt metadata
  // so every client supplies exact references, including on history replay.
  // Images also hydrate through the capability-scoped attachment route.
  attachments?: string[];
  /**
   * Exact control receipt for a cloud-agent lifecycle wake. Kept structured
   * (and out of the model's tool arguments) so a thread id can never be
   * rebound to whichever mutable attempt happens to be current.
   */
  agentThreadControl?: CloudAgentControlReceipt;
  /** A computer's orchestrator controlling its cloud agent; the turn does that instead of answering. */
  piAgent?: import("@stella/contracts/turn-plane/turn-start").CloudPiAgentRequest;
  wakeReportSpillKey?: string;
  watchdogMs?: number;
  /** Worker-issued owner purge lease generation. */
  ownerPurgeGeneration?: string;
  ownerPurgeLeaseId?: string;
  /** Set by the DO when the turn is accepted; used to restore queue order. */
  queuedAt?: number;
};

/**
 * Durable admission intent, keyed by `clientMsgId`. Written before the
 * owner-fence register so a lost response replays against the exact same
 * turn id and lease instead of admitting the message twice.
 */
export type ChatTurnAdmissionReceipt = {
  schemaVersion: 2;
  fingerprint: string;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  leaseId: string;
  phase: "registering" | "accepted";
  /** This admission bound a previously unowned conversation. */
  createdConversation: boolean;
  queuedAt: number;
  acceptedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type OwnerFencedTurn = {
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  ownerPurgeGeneration?: string;
  ownerPurgeLeaseId?: string;
};

export type OwnerFenceLeaseReceipt = {
  schemaVersion: 1;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  leaseId: string;
  kind: "run" | "aux";
  phase: "registering" | "registered" | "unregister_pending";
  /** The open-fence generation returned when this lease was registered. */
  registrationGeneration?: string;
  /** Present only for replayable run admission. */
  runSlotKey?: string;
  /** Binds pre-persistence replay to the exact admitted request. */
  operationFingerprint?: string;
  createdAt: number;
  updatedAt: number;
};

export type OwnerFenceRunSlot = {
  schemaVersion: 1;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  leaseId: string;
};

export type OwnerFenceRegisterRequest = {
  ownerGeneration: string;
  leaseId: string;
  sessionId: string;
  turnId: string;
  namespace: "orchestrator";
  role: "orchestrator";
  generation?: string;
};

/**
 * Carries one exact `register` to the owner fence. `{ generation }` is a
 * committed lease and `null` a definite refusal; a throw means the response
 * was lost and the remote may have committed, so the receipt stays replayable.
 */
export type OwnerFenceRegisterTransport = (
  ownerId: string,
  body: OwnerFenceRegisterRequest,
) => Promise<{ generation: string } | null>;

export type LocalTurnLease = OwnerFencedTurn & {
  deviceId: string;
  localTurnId: string;
  leaseToken: string;
  expiresAt: number;
  beginFingerprint: string;
  finishFingerprint?: string;
  cancelRequested?: boolean;
  /** Earliest time an unresponsive desktop lease may be force-retired. */
  cancelDeadlineAt?: number;
  clientMsgId?: string;
};

export type LocalTurnFinishReceipt = {
  ownerGeneration: string;
  turnId: string;
  deviceId: string;
  localTurnId: string;
  leaseToken: string;
  phase: LocalTerminalPhase;
  firstSeq: number;
  lastSeq: number;
  epoch: number;
  finishFingerprint?: string;
  externallyCanceled?: boolean;
};

/** How an agent thread's attempt ended, as its terminal events carry it. */
export type PiThreadOutcome = {
  status: "completed" | "failed" | "canceled";
  resultJson?: string;
  errorMessage?: string;
  /** What its run saved to the owner's drive and linked in its answer. */
  files?: import("../pi-runtime.js").PiDeliveredFile[];
};

/** One attempt of an agent thread whose agent runs here, until it settles. */
type PiThreadAttemptRecord = {
  turnId: string;
  attemptGeneration: number;
  /** pi has it: its agent was started or messaged under its call key. */
  handedOff?: true;
  /** A pause was asked for: a report without text settles it as canceled. */
  pausing?: true;
  /** The decided outcome, kept while it is delivered. */
  terminal?: PiThreadOutcome & { completedAt: number };
};

/** An agent thread whose attempts run as a pi agent here (`startPiThread`). */
export type PiThreadRecord = {
  ownerId: string;
  ownerGeneration: string;
  threadId: string;
  description: string;
  /** A computer's dispatch: the agent threads deliver its reports there, so nothing wakes here. */
  originDeviceId?: string;
  /** Attempts not settled yet, oldest first. */
  attempts: PiThreadAttemptRecord[];
  /** Every attempt through this generation has settled. */
  settledThrough: number;
};

export type BrainHandoff = {
  turnId: string;
  ownerId: string;
  ownerGeneration: string;
  deviceId: string;
  clientMsgId: string;
  prompt: string;
};

/** The running agents pi has here, and those the owner's agent threads have. */
export type AgentsView = {
  pi: AgentActivityEntry[];
  owner: AgentActivityEntry[];
};

/** An execution Stella's own loop runs here; `anthropic` runs on Claude Code. */
export type HarnessExecution = Exclude<
  CloudExecutionSelection,
  { engine: "anthropic" }
>;

export type ChatTurnResumeRecord = { turnId: string; count: number };
export type PersistedChatTurnModelCapability = {
  turnId: string;
  capability: MintedTurnCapability;
};

/** What a forwarded CLI tool call runs against; see `cliRuntimes`. */
export type CliTurnRuntime = {
  identity: CloudCliTurnIdentity;
  turn: ChatTurnRequest;
  tools: AgentTool[];
  /** The turn's execution signal: Stop and the watchdog abort tool work. */
  signal: AbortSignal;
  /** Sequential, as Stella's own loop runs tools. */
  toolChain: Promise<unknown>;
};

export type CloudContextComponent =
  | "canonical_prompt"
  | "canonical_history"
  | "agent_home_memory"
  | "agent_home_personality"
  | "skill_catalog";

/**
 * A terminal state that is written to the transcript but not yet accepted by
 * the owner. It is what the re-armed alarm retries: the alarm is the retry vehicle
 * for EVERY terminal kind, and without a record of which one is owed it can
 * only ever report the one it invents itself.
 */
export type OwedTerminal = {
  kind: TurnPhase;
  message: string;
  /**
   * The event body to deliver, when the terminal carries more than a notice.
   * A completed turn owes its reply text — retrying it as `{message}` would
   * deliver an empty completion and lose what the model actually said.
   */
  payload?: Record<string, unknown>;
  /**
   * The per-turn ordinal assigned to the terminal event when the terminal was
   * decided. A retried enqueue reuses it, so the owner sees one terminal event
   * however many times the alarm has to resend it.
   */
  eventSeq?: number;
};
