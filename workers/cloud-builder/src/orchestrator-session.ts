/**
 * The cloud orchestrator: Stella's delegation-only agent loop running inside
 * a Durable Object — one DO per conversation, one turn at a time, ~token
 * cost only. No sandbox is ever created here; escalation is the spawn tool,
 * which dispatches a general agent into a BuildSession sandbox and returns
 * immediately.
 *
 * This object OWNS its conversation. The transcript lives in its SQLite (see
 * `journal.ts`) and is the single source of truth for message content; Convex
 * keeps only derived projections it alone can serve — the conversation index
 * and the search excerpts. There is no per-turn transcript round trip left:
 * the loop reads its context from local storage and writes produced messages
 * back incrementally as they are produced, so an eviction at minute four of a
 * five-minute turn no longer discards everything the turn did.
 *
 * What did NOT change, deliberately: the turn lifecycle. Accepted turns are
 * still durable under `queued:*` before the 202, the alarm still retries
 * terminal delivery, `terminal`/`terminalDelivered` still guarantee exactly
 * one terminal state, and `agent_events` still carries `started` + terminal to
 * Convex — that is what drives quota, Activity, and the turn row. Only the
 * transcript moved. The journal's `turns` table is a projection of that
 * machinery and is never consulted to decide whether a terminal event is owed.
 *
 * The loop itself is `packages/runtime`'s agent-core Agent — the same code
 * the desktop ships — with the tool set pinned in code below. Frontmatter
 * allowlists are agent-writable home data on desktop; in the cloud the
 * execution surface is never data-driven.
 */

import { DurableObject } from "cloudflare:workers";
import { Agent } from "@stella/runtime/kernel/agent-core/agent.js";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
} from "@stella/runtime/kernel/agent-core/types.js";
import type { ImageContent } from "@stella/runtime/ai/types.js";
import {
  AGENT_RUN_MAX_ATTEMPTS,
  executeAgentRunWithRetry,
  prepareTransientResumeTail,
} from "@stella/runtime/kernel/agent-runtime/run-retry.js";
import {
  assertTurnExecutionActive,
  startTurnExecution,
  type TurnExecution,
  type TurnRetryCancellation,
} from "./turn-cancellation.js";
import {
  assistantMessageHasUsableOutput,
  buildDefaultTransformContext,
  getAgentCompletion,
} from "@stella/runtime/kernel/agent-runtime/run-shared.js";
import { normalizeSafePublicUrl } from "@stella/runtime/kernel/tools/url-guard.js";
import { fetchReadableText } from "@stella/runtime/kernel/tools/web-fetch-core.js";
import {
  containsSecretLikeToken,
  sanitizeToolVisibleText,
} from "@stella/runtime/kernel/tools/safety.js";
import {
  WEB_TOOL_DESCRIPTION,
  WEB_TOOL_NAME,
  WEB_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/web-def.js";
import type { TSchema } from "@sinclair/typebox";
import {
  createCloudRelayModel,
  resolveCloudThinkingLevel,
} from "@stella/executor-cloud/relay-model";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { CLOUD_HISTORY_TOKEN_BUDGET } from "@stella/executor-cloud/prune-history";
import { AgentHome, buildResidentMemorySection } from "./agent-home.js";
import type { CloudSkillCatalogSnapshot } from "./cloud-home-store.js";
import {
  buildCloudSkillCatalogPrompt,
  createCloudSkillTools,
} from "./cloud-skill-tools.js";
import { isValidCloudSpawnModel } from "./cloud-spawn-model.js";
import { sha256Hex } from "./hash.js";
import {
  authorizeDevAcceptanceProbe,
  DEV_ACCEPTANCE_PROBE_STATE_KEY,
  DEV_ACCEPTANCE_PROVIDER_DISPATCH_COUNT_KEY,
  devAcceptanceProbesEnabled,
  recordDevAcceptanceProbeReceipt,
  type DevAcceptanceProbeState,
} from "./dev-acceptance-probes.js";
import {
  buildCloudSystemPrompt,
  CanonicalPromptUnavailableError,
  CLOUD_PROMPT_SNAPSHOT_STORAGE_KEY,
  refreshCanonicalPrompts,
  type CanonicalPromptSnapshot,
} from "./cloud-prompt.js";
import { getResponseLanguageSystemPrompt } from "@stella/runtime/kernel/runner/locale-prompt.js";
import { createMemoryTools, createScheduleTool } from "./orchestrator-tools.js";
import {
  createCloudCodeAgentTool,
  type CloudCodeSourceAgentTool,
} from "./cloud-code-tool.js";
import { createCloudIntegrationTools } from "./cloud-integration-tools.js";
import {
  APPEND_MAX_BYTES,
  APPEND_MAX_ROWS,
  APPEND_WINDOW_MAX_BYTES,
  APPEND_WINDOW_MAX_REQUESTS,
  APPEND_WINDOW_MS,
  BACKFILL_BATCH_RECORDS,
  CONVERSATION_MAX_STORED_BYTES,
  CLOSE_DELETED,
  CLOSE_UNAUTHENTICATED,
  CONTEXT_MAX_SPILL_HYDRATIONS,
  EXCERPT_TEXT_MAX,
  EXCERPT_USER_HALF_MAX,
  INBOX_MAX_BYTES,
  INBOX_MAX_ROWS,
  INITIAL_WINDOW_RECORDS,
  LIVE_PARTIAL_MAX_CHARS,
  MAX_ROW_BYTES,
  TOOL_ARGS_PREVIEW_MAX,
  createConversationHub,
  parseSocketIdentity,
  utf8Length,
  type ConversationCard,
  type ConversationHub,
  type ConversationOwnerRecord,
  type JournalHead,
  type JournalRange,
  type JournalReader,
  type JournalRecord,
  type LiveTurnSnapshot,
  type MessageRole,
  type SocketIdentity,
  type TurnPhase,
} from "./conversation-types.js";
import {
  ConversationDeletedError,
  Journal,
  JournalContextIntegrityError,
  JournalHeadConflictError,
  type JournalRow,
} from "./journal.js";
import { ConversationArchive } from "./archive.js";
import {
  ConversationIndex,
  REINDEX_BUDGET_MS,
  REINDEX_MAX_BATCHES,
} from "./index-flush.js";
import {
  LOCAL_CLIENT_MSG_ID_PATTERN,
  LOCAL_DEVICE_ID_PATTERN,
  LOCAL_TURN_ID_PATTERN,
  classifyLocalClientMessageReplay,
  localTurnLeaseAllowsIdentityTransition,
  localClientMessageFingerprintSource,
  localTurnId as makeLocalTurnId,
  parseExpectedOwnerGeneration,
  parseLocalTurnRenewal,
  parseLocalFinishRecords,
  parseLocalTerminalPhase,
  type LocalClientMessageReceipt,
  type ParsedLocalTurnRenewal,
  type LocalTerminalPhase,
} from "./local-turn-protocol.js";
import {
  OwnerTransferArchiveConflictError,
  conversationArchivePrefix,
  parseOwnerTransferRequest,
  retainedTurnBlocksOwnerTransfer,
  type OwnerTransferRequest,
} from "./owner-transfer.js";
import {
  mayReusePendingOwnerLookup,
  normalizeOwnerGeneration,
} from "./owner-generation.js";
import { parseVoiceJournalRecords } from "./journal-append-protocol.js";
import {
  CONVERSATION_EDIT_LEASE_MS,
  CONVERSATION_EDIT_LOCK_KEY,
  CONVERSATION_EDIT_PAGE_BYTES,
  CONVERSATION_EDIT_PAGE_ROWS,
  conversationRewindHeadMatches,
  CONVERSATION_FORK_TARGET_KEY,
  parseConversationEditRequest,
  rewindRuntimeAdmission,
  sameConversationEditLock,
  type ConversationEditLock,
  type ConversationEditRequest,
  type ForkConversationEditRequest,
  type ForkConversationEditResult,
  type ForkTargetState,
  type RewindConversationEditRequest,
  type RewindConversationEditResult,
} from "./conversation-edit-protocol.js";
import {
  ExactTurnCancellationLedger,
  parseExactTurnCancellationRequest,
  type ExactTurnCancellation,
  type ExactTurnCancellationRequest,
} from "./execution-placement-turn-cancellation.js";

type Env = {
  BUILD_SESSIONS: DurableObjectNamespace;
  LOADER: WorkerLoader;
  BUILDER_SERVICE_SECRET: string;
  // The owner's authoritative cloud home. Kept optional at the binding type
  // boundary for rolling deploys, but a chat turn without it fails closed.
  AGENT_HOME?: R2Bucket;
  // Rolled-over transcript segments and oversize-row spills. Deliberately a
  // separate bucket from AGENT_HOME: different retention, and a prefix delete
  // here must never be able to reach the owner's memory documents.
  CONVERSATION_ARCHIVE?: R2Bucket;
  // Fallback Convex origin for index flushes and owner lookups that happen
  // outside a turn (a socket connecting to a DO that has never run one).
  STELLA_CONVEX_SITE_URL?: string;
  /** Dev-only, omitted from production deployments. */
  ENABLE_DEV_ACCEPTANCE_PROBES?: string;
  /** Exact non-production target identity checked by every probe request. */
  STELLA_DEPLOYMENT_IDENTITY?: string;
};

export type ChatTurnRequest = {
  kind: "chat";
  ownerId: string;
  conversationId: string;
  turnId: string;
  sessionId: string;
  prompt: string;
  turnToken: string;
  /** Convex owner-data generation captured when this turn was admitted. */
  ownerGeneration: string;
  convexCallbackBase: string;
  watchdogMs?: number;
  // Resolved and persisted by Convex. Optional only while an older queued
  // dispatch drains during rolling deployment.
  execution?: CloudExecutionSelection;
  // Transcript metadata Convex holds and the journal needs. All optional so a
  // dispatch from an older Convex deployment still runs, just with a plainer
  // rendered record.
  lane?: string;
  source?: string;
  title?: string;
  conversationCreatedAt?: number;
  // Keeps the prompt out of the rendered transcript (lifecycle and scheduled
  // prompts are context, not something the user typed). Still model context.
  hiddenMessage?: boolean;
  // Resolves the client's optimistic echo against the durable prompt row.
  clientMsgId?: string;
  // The client's UI locale (e.g. "es", "zh-Hans"), used for the reply-language
  // directive. Persisted per conversation so later turns without one (schedule
  // fires, agent-completion wakes) keep answering in the user's language.
  locale?: string;
  // Drive paths of attached images. The DO hydrates them into image content
  // blocks on this turn's prompt via the turn-token-scoped attachment route;
  // the prompt text separately names the paths (the composer's preamble), so
  // later turns can still reach the files through the drive.
  attachments?: string[];
  /**
   * Exact server-issued control receipt for a cloud-agent lifecycle wake.
   * Kept structured (and out of the model's tool arguments) so a thread id
   * can never be rebound to whichever mutable attempt happens to be current.
   */
  agentThreadControl?: CloudAgentControlReceipt;
  /** Worker-issued owner purge lease generation. */
  ownerPurgeGeneration?: string;
  ownerPurgeLeaseId?: string;
  /** Set by the DO when the dispatch is accepted; used to restore queue order. */
  queuedAt?: number;
};

type CloudAgentControlStatus = "running" | "completed" | "failed" | "canceled";

type CloudAgentControlReceipt = {
  threadId: string;
  attemptGeneration: number;
  threadUpdatedAt: number;
  status: CloudAgentControlStatus;
};

type CloudAgentToolKind = "spawn_agent" | "send_input" | "pause_agent";

type CloudAgentToolOutcome = {
  kind: CloudAgentToolKind;
  fingerprint: string;
  control: CloudAgentControlReceipt;
  disposition?: "paused" | "pending" | "already_terminal";
};

type ChatTurnAdmissionReceipt = {
  schemaVersion?: 1;
  fingerprint: string;
  ownerId?: string;
  ownerGeneration?: string;
  turnId?: string;
  leaseId?: string;
  phase?: "registering" | "accepted";
  queuedAt?: number;
  acceptedAt?: number;
  createdAt?: number;
  updatedAt?: number;
};

type OwnerFencedTurn = {
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  ownerPurgeGeneration?: string;
  ownerPurgeLeaseId?: string;
};

type OwnerFenceLeaseReceipt = {
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

type OwnerFenceRunSlot = {
  schemaVersion: 1;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  leaseId: string;
};

type LocalTurnLease = OwnerFencedTurn & {
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

type LocalTurnFinishReceipt = {
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

const OWNER_TRANSFER_KEY = "conversationOwnerTransfer";

// Current Convex dispatches always include an execution selection that was
// persisted with the turn token. Missing execution is rolling-deploy
// compatibility for old queued turns only; those legacy tokens are bound to
// the original concrete model and cannot authorize the new opaque default.
const LEGACY_UNBOUND_CLOUD_EXECUTION: CloudExecutionSelection = {
  engine: "stella",
  provider: "stella",
  model: "stella/anthropic/claude-sonnet-4.6",
  reasoningEffort: "default",
};

class OwnerPurgeFenceError extends Error {}
class OwnerFenceLeaseConflictError extends Error {}
class OwnerFenceRegistrationUncertainError extends Error {}

const CHAT_WATCHDOG_MS = 5 * 60_000;
const OWNER_PURGE_STALE_LEASE_GRACE_MS = 35_000;
const LOCAL_TURN_LEASE_MS = 30 * 60_000;
const LOCAL_TURN_CANCEL_GRACE_MS = 45_000;
const LOCAL_TURN_BEGIN_MAX_BYTES = 64 * 1024 * 1024;
const LOCAL_TURN_FINISH_MAX_ROWS = 1_024;
const LOCAL_TURN_FINISH_MAX_BYTES = APPEND_WINDOW_MAX_BYTES;
const LOCAL_TURN_LEASE_KEY = "localTurnLease";
const LOCAL_TURN_RECEIPT_PREFIX = "localTurnReceipt:";
const LOCAL_CLIENT_MESSAGE_PREFIX = "localClientMessage:";
const CHAT_TURN_ADMISSION_PREFIX = "chatTurnAdmission:";
const CLOUD_AGENT_CONTROL_PREFIX = "cloudAgentControl:";
const CLOUD_AGENT_TOOL_OUTCOME_PREFIX = "cloudAgentToolOutcome:";
const OWNER_FENCE_LEASE_RECEIPT_PREFIX = "ownerFenceLeaseReceipt:";
const OWNER_FENCE_RUN_SLOT_PREFIX = "ownerFenceRunSlot:";
const OWNER_FENCE_ID_HEADER = "x-stella-owner-fence-id";
const localTurnReceiptKey = (turnId: string): string =>
  `${LOCAL_TURN_RECEIPT_PREFIX}${turnId}`;
const localClientMessageKey = (clientMsgId: string): string =>
  `${LOCAL_CLIENT_MESSAGE_PREFIX}${clientMsgId}`;
const chatTurnAdmissionKey = (turnId: string): string =>
  `${CHAT_TURN_ADMISSION_PREFIX}${turnId}`;
const cloudAgentControlKey = (threadId: string): string =>
  `${CLOUD_AGENT_CONTROL_PREFIX}${threadId}`;
const cloudAgentToolOutcomeKey = (turnId: string, toolCallId: string): string =>
  `${CLOUD_AGENT_TOOL_OUTCOME_PREFIX}${turnId}:${toolCallId}`;
const ownerFenceLeaseReceiptKey = (leaseId: string): string =>
  `${OWNER_FENCE_LEASE_RECEIPT_PREFIX}${leaseId}`;

const isDurableChatTurnAdmissionIntent = (
  receipt: ChatTurnAdmissionReceipt,
): boolean =>
  receipt.schemaVersion === 1 &&
  typeof receipt.ownerId === "string" &&
  typeof receipt.ownerGeneration === "string" &&
  typeof receipt.turnId === "string" &&
  typeof receipt.leaseId === "string" &&
  (receipt.phase === "registering" || receipt.phase === "accepted") &&
  Number.isFinite(receipt.queuedAt) &&
  Number.isFinite(receipt.createdAt) &&
  Number.isFinite(receipt.updatedAt);

const isLegacyAcceptedChatTurnReceipt = (
  receipt: ChatTurnAdmissionReceipt,
): boolean =>
  receipt.schemaVersion === undefined &&
  typeof receipt.fingerprint === "string" &&
  Number.isFinite(receipt.acceptedAt);

const localTurnRetirementDeadline = (lease: LocalTurnLease): number => {
  if (!lease.cancelRequested) return lease.expiresAt;
  return Number.isFinite(lease.cancelDeadlineAt) && lease.cancelDeadlineAt! > 0
    ? lease.cancelDeadlineAt!
    : Number.POSITIVE_INFINITY;
};

const chatTurnFingerprintSource = (turn: ChatTurnRequest): string =>
  JSON.stringify({
    kind: turn.kind,
    ownerId: turn.ownerId,
    ownerGeneration: turn.ownerGeneration,
    conversationId: turn.conversationId,
    turnId: turn.turnId,
    sessionId: turn.sessionId,
    prompt: turn.prompt,
    turnToken: turn.turnToken,
    convexCallbackBase: turn.convexCallbackBase,
    watchdogMs: turn.watchdogMs,
    execution: turn.execution
      ? {
          engine: turn.execution.engine,
          provider: turn.execution.provider,
          model: turn.execution.model,
          reasoningEffort: turn.execution.reasoningEffort,
        }
      : undefined,
    lane: turn.lane,
    source: turn.source,
    title: turn.title,
    conversationCreatedAt: turn.conversationCreatedAt,
    hiddenMessage: turn.hiddenMessage,
    clientMsgId: turn.clientMsgId,
    locale: turn.locale,
    attachments: turn.attachments,
    agentThreadControl: turn.agentThreadControl
      ? {
          threadId: turn.agentThreadControl.threadId,
          attemptGeneration: turn.agentThreadControl.attemptGeneration,
          threadUpdatedAt: turn.agentThreadControl.threadUpdatedAt,
          status: turn.agentThreadControl.status,
        }
      : undefined,
  });

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const staleOwnerGenerationResponse = (): Response =>
  json(
    {
      code: "OWNER_DATA_GENERATION_STALE",
      message: "This cloud owner generation is no longer current.",
    },
    409,
  );

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const normalizeCloudAgentControlReceipt = (
  value: unknown,
): CloudAgentControlReceipt | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CloudAgentControlReceipt>;
  const threadId =
    typeof candidate.threadId === "string" ? candidate.threadId.trim() : "";
  const status = candidate.status;
  if (
    !threadId ||
    threadId.length > 256 ||
    !Number.isSafeInteger(candidate.attemptGeneration) ||
    candidate.attemptGeneration! < 1 ||
    !Number.isSafeInteger(candidate.threadUpdatedAt) ||
    candidate.threadUpdatedAt! < 0 ||
    !["running", "completed", "failed", "canceled"].includes(status ?? "")
  ) {
    return null;
  }
  return {
    threadId,
    attemptGeneration: candidate.attemptGeneration!,
    threadUpdatedAt: candidate.threadUpdatedAt!,
    status: status as CloudAgentControlStatus,
  };
};

const advanceCloudAgentControlReceipt = (
  existing: CloudAgentControlReceipt | null,
  receipt: CloudAgentControlReceipt,
): CloudAgentControlReceipt => {
  if (!existing) return receipt;
  if (receipt.attemptGeneration < existing.attemptGeneration) return existing;
  if (receipt.attemptGeneration > existing.attemptGeneration) return receipt;

  // Time is correlation data, not a logical revision: two Convex mutations
  // can share a millisecond, and a regressed wall clock must not strand a
  // completed attempt as running. Within one generation the state machine is
  // authoritative — running may advance to one immutable terminal status,
  // while a delayed running receipt can never resurrect that attempt.
  const existingTerminal = existing.status !== "running";
  const receiptTerminal = receipt.status !== "running";
  if (!existingTerminal && receiptTerminal) return receipt;
  if (existingTerminal && !receiptTerminal) return existing;
  if (existingTerminal && receiptTerminal) {
    if (receipt.status !== existing.status) {
      throw new Error("A terminal cloud agent attempt cannot be rewritten.");
    }
    return receipt.threadUpdatedAt > existing.threadUpdatedAt
      ? receipt
      : existing;
  }
  return receipt.threadUpdatedAt > existing.threadUpdatedAt
    ? receipt
    : existing;
};

const sameCloudAgentControlReceipt = (
  left: CloudAgentControlReceipt,
  right: CloudAgentControlReceipt,
): boolean =>
  left.threadId === right.threadId &&
  left.attemptGeneration === right.attemptGeneration &&
  left.threadUpdatedAt === right.threadUpdatedAt &&
  left.status === right.status;

const log = (
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) => {
  console[level](
    JSON.stringify({
      service: "stella-v2-cloud-builder",
      event,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
};

// The model has no clock. It rides with the message rather than in the system
// prompt on purpose: the cache breakpoint covers system + tool definitions, so
// a per-turn timestamp up there is byte-unique every turn and every prefix
// after it misses. This copy is never persisted — the journal's prompt row is
// written before the loop starts and carries the user's own text (the loop's
// first produced message is dropped), so replayed history stays clock-free and
// cacheable too.
const withClock = (prompt: string, now: Date): string =>
  `<current-time>${now.toISOString()}</current-time>\n\n${prompt}`;

// workerd has no Buffer; chunked so String.fromCharCode never sees an
// argument list long enough to overflow the stack.
const base64FromBytes = (bytes: Uint8Array): string => {
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
};

/**
 * Degrades an oversize payload in place. Used only on the synchronous
 * loop-persist path, where an R2 round trip is impossible: the Agent's event
 * sink is fire-and-forget, so an `await` there would silently drop the row.
 * The async append paths spill to R2 instead and keep the full bytes.
 */
const truncateMessage = (
  message: AgentMessage,
  limit: number,
): AgentMessage => {
  const record = message as { role?: string; content?: unknown };
  if (!Array.isArray(record.content)) return message;
  const budget = Math.max(1_000, Math.floor(limit / 2));
  let used = 0;
  const content: unknown[] = [];
  for (const block of record.content) {
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string") {
      // Non-text blocks (images, tool calls) are structural: dropping a
      // toolCall would orphan its result, so they always travel.
      content.push(block);
      continue;
    }
    if (used >= budget) continue;
    const room = budget - used;
    used += text.length;
    content.push(
      text.length <= room
        ? block
        : { ...(block as object), text: `${text.slice(0, room)}\n[truncated]` },
    );
  }
  return { ...(message as object), content } as AgentMessage;
};

/** How many tool entries the live snapshot keeps. Newest win. */
const LIVE_TOOL_LIMIT = 24;

/**
 * The user-facing text for each non-completed terminal, in one place: the
 * watchdog's retry ladder has to deliver the same words the transcript already
 * shows, and two copies of a sentence is how they stop matching.
 */
const TERMINAL_NOTICE = {
  timeout: "This took longer than expected, so Stella stopped. Try again.",
  canceled: "Stopped.",
  failed: "Stella hit a problem answering this. Try again.",
} as const;

const CLOUD_CONTEXT_NOTICE =
  "Stella couldn't load the required cloud context safely. Try again.";

type CloudContextComponent =
  | "canonical_prompt"
  | "canonical_history"
  | "agent_home_memory"
  | "agent_home_personality"
  | "skill_catalog";

class CloudContextBlockedError extends Error {
  readonly code = "CLOUD_CONTEXT_UNAVAILABLE";

  constructor(
    readonly component: CloudContextComponent,
    readonly reason: string,
  ) {
    super("Required cloud context is unavailable or failed integrity checks.");
    this.name = "CloudContextBlockedError";
  }
}

const requireCloudContext = async <T>(
  component: CloudContextComponent,
  operation: Promise<T>,
): Promise<T> => {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof CloudContextBlockedError) throw error;
    if (error instanceof CanonicalPromptUnavailableError) {
      throw new CloudContextBlockedError(error.component, error.reason);
    }
    throw new CloudContextBlockedError(component, "read_failed");
  }
};

const cloudContextFailure = (
  error: unknown,
): {
  code: "CLOUD_CONTEXT_UNAVAILABLE";
  component: CloudContextComponent;
  repairSeq?: number;
} | null => {
  if (error instanceof JournalContextIntegrityError) {
    return {
      code: error.code,
      component: error.component,
      repairSeq: error.seq,
    };
  }
  if (error instanceof CloudContextBlockedError) {
    return { code: error.code, component: error.component };
  }
  if (error instanceof CanonicalPromptUnavailableError) {
    return { code: error.code, component: error.component };
  }
  return null;
};

const terminalNotice = (kind: string): string =>
  (TERMINAL_NOTICE as Record<string, string>)[kind] ?? TERMINAL_NOTICE.failed;

/**
 * A terminal state that is written to the transcript but not yet accepted by
 * Convex. It is what the re-armed alarm retries: the alarm is the retry vehicle
 * for EVERY terminal kind, and without a record of which one is owed it can
 * only ever report the one it invents itself.
 */
type OwedTerminal = {
  kind: TurnPhase;
  message: string;
  /**
   * The event body to deliver, when the terminal carries more than a notice.
   * A completed turn owes its reply text — retrying it as `{message}` would
   * deliver an empty completion and lose what the model actually said.
   */
  payload?: Record<string, unknown>;
};

/** Correlates a committed assistant row with the deltas that preceded it. */
const newStreamId = (): string =>
  `as_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

const previewArgs = (args: unknown): string => {
  try {
    return JSON.stringify(args ?? {}).slice(0, TOOL_ARGS_PREVIEW_MAX);
  } catch {
    return "";
  }
};

const SPAWN_AGENT_PARAMETERS = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description:
        "One short, user-friendly sentence summarizing what this work is about.",
    },
    prompt: {
      type: "string",
      description:
        "Detailed instructions for the sub-agent. This is the agent's only context.",
    },
    workspace: {
      type: "string",
      description:
        'Where the work runs, chosen by what the task operates on: "cloud" (the user\'s general Stella cloud workspace — the default), "computer" (their local machine), "project:<name>", "stella", or "app:<slug>". Omit for work with no file subject.',
    },
    model: {
      type: "string",
      description:
        'Optional route for this one spawn. Omit to inherit this conversation exactly. Use "claude[/model]", "codex[/model]", or a canonical "stella/..." model. Append :low, :medium, :high, or :xhigh to preserve an explicitly requested reasoning effort.',
    },
  },
  required: ["description", "prompt"],
} as const;

export class OrchestratorSession extends DurableObject<Env> {
  // Serializes turns: Convex can dispatch a wake turn while a user turn is
  // still streaming; the second waits its turn instead of interleaving.
  private queue: Promise<unknown> = Promise.resolve();
  /** Exact promises let Stop join only its target, never a newer queued turn. */
  private readonly turnExecutions = new Map<string, TurnExecution<Response>>();
  /** Fresh voice writes hold an owner fence and are joined by owner purge. */
  private readonly ownerFencedAppends = new Map<
    string,
    { lease: OwnerFencedTurn; settled: Promise<void> }
  >();

  private readonly journal: Journal;
  private readonly archive: ConversationArchive;
  private readonly index: ConversationIndex;
  private readonly hub: ConversationHub;
  private readonly exactTurnCancellations: ExactTurnCancellationLedger;
  /** Isolate identity only; the raw value is never persisted or returned. */
  private readonly devAcceptanceBootId = crypto.randomUUID();

  /**
   * Work that must finish before a turn is called terminal but that cannot run
   * on the Agent's synchronous event sink — today, promoting an oversize row's
   * payload into R2.
   */
  private background: Promise<unknown> = Promise.resolve();

  /** In-memory only. Rebuilt every turn; nothing durable depends on it. */
  private live: LiveTurnSnapshot | null = null;

  /**
   * The turn whose `runTurn` body is executing in THIS isolate, and the last
   * turn whose post-terminal work ran.
   *
   * Together they route `afterTerminal` to exactly one caller. `/cancel` and
   * the watchdog can mark a turn terminal from outside the loop, and the
   * post-terminal work — the search excerpt, the card-inbox drain, rollover —
   * must run for those turns too. But it must never run while the loop is
   * still unwinding: a drain there could splice a foreign row between a tool
   * call and its result, and rollover mid-turn is forbidden outright. So the
   * loop finalizes its own turn whenever it is alive to do it, and those two
   * paths only step in for a turn no loop will return to (an eviction, or a
   * cancel that arrived after the isolate lost the run).
   */
  private activeTurnId: string | null = null;
  private finalizedTurnId: string | null = null;

  /**
   * This object has been purged, whatever its journal now says.
   *
   * `handlePurge` ends in `deleteAll()` plus a fresh `bootstrap()`, so the
   * durable tombstone is gone and `journal.isDeleted()` reads false again the
   * moment it returns. Any request that checked the tombstone before the purge
   * and was still awaiting something when it landed would otherwise resume
   * against that empty journal and write rows — and R2 objects — into a
   * conversation Convex has already recorded as deleted, where no purge, sweep
   * or manifest will ever name them again. The durable tombstone fences the
   * window before `deleteAll()`; this fences the window after it.
   */
  private sealed = false;

  private ownerLookup: Promise<ConversationOwnerRecord | null> | null = null;
  private ownerTransferWork: Promise<Response> | null = null;
  private ownerTransferRequest: OwnerTransferRequest | null = null;
  /** Serializes `/turn` admission through durable replay classification. */
  private turnAdmissionTail: Promise<void> = Promise.resolve();
  /** Persisted with accepted turns so cold-start index flushes stay fenced. */
  private ownerGeneration?: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.exactTurnCancellations = new ExactTurnCancellationLedger(ctx.storage);
    this.journal = new Journal(ctx, log);
    this.archive = new ConversationArchive(
      env.CONVERSATION_ARCHIVE,
      this.journal,
      log,
    );
    this.index = new ConversationIndex(
      this.journal,
      log,
      () => this.convexEndpoint(),
      {
        purged: () => this.purged(),
        onPurged: () => this.sealPurged("convex_fence"),
      },
    );
    this.hub = createConversationHub({
      ctx,
      reader: this.reader(),
      lookupOwner: () => this.lookupOwner(),
      cancelTurn: (turnId) => this.cancelTurn(turnId),
      onConnect: () => this.flushIndexIfLagging(),
      conversationId: () => this.conversationId(),
      log,
    });
    // Set in the constructor rather than at accept time: whether an
    // auto-response survives DO eviction is not something the docs settle, and
    // setting it on every cold start makes the question moot. This is what
    // keeps an idle conversation free — a JSON heartbeat would wake the object
    // on every beat and bill the incoming frame at 20:1.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    // Accepted turns are persisted under queued:* before the 202 goes out;
    // an isolate restart wipes the in-memory queue, so re-enqueue whatever
    // survived — otherwise an accepted turn (and its Convex "running" row)
    // would be silently lost forever.
    this.ctx.blockConcurrencyWhile(async () => {
      // The schema has to exist before anything can read or write a turn.
      await this.journal.bootstrap();
      this.ownerGeneration = await this.ctx.storage.get<string>(
        "ownerDataGeneration",
      );
      if (this.journal.meta().conversation_id === "" && this.ctx.id.name) {
        this.journal.setConversationId(this.ctx.id.name);
      }
      const localLease =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (localLease) {
        await this.restoreLocalLease(localLease);
      } else {
        for (const turn of await this.queuedTurns()) this.enqueue(turn);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Identity and Convex endpoint
  // -------------------------------------------------------------------------

  private conversationId(): string {
    return this.journal.meta().conversation_id || this.ctx.id.name || "";
  }

  private async callOwnerFence(
    ownerId: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const ownerHash = await sha256Hex(ownerId);
    return this.env.BUILD_SESSIONS.getByName(`owner-purge-${ownerHash}`).fetch(
      `https://build-session/owner-fence/${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [OWNER_FENCE_ID_HEADER]: ownerId,
        },
        body: JSON.stringify({ ...body, ownerId }),
      },
    );
  }

  private ownerFenceReceiptMatches(
    receipt: OwnerFenceLeaseReceipt,
    target: Pick<OwnerFencedTurn, "ownerId" | "ownerGeneration" | "turnId">,
    leaseId: string,
  ): boolean {
    return (
      receipt.schemaVersion === 1 &&
      receipt.ownerId === target.ownerId &&
      receipt.ownerGeneration === target.ownerGeneration &&
      receipt.turnId === target.turnId &&
      receipt.leaseId === leaseId
    );
  }

  private async ownerFenceRunSlotKey(turn: OwnerFencedTurn): Promise<string> {
    const identityHash = await sha256Hex(
      JSON.stringify({
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        turnId: turn.turnId,
      }),
    );
    return `${OWNER_FENCE_RUN_SLOT_PREFIX}${identityHash}`;
  }

  private async armOwnerFenceLeaseReconciliationAlarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const retryAt = Date.now() + 30_000;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > retryAt) {
        await this.ctx.storage.setAlarm(retryAt);
      }
    });
  }

  private async hasOwnerFenceLeaseRetirementDebt(): Promise<boolean> {
    const receipts = await this.ctx.storage.list<OwnerFenceLeaseReceipt>({
      prefix: OWNER_FENCE_LEASE_RECEIPT_PREFIX,
      limit: 100,
    });
    return [...receipts.values()].some(
      (receipt) => receipt.phase === "unregister_pending",
    );
  }

  private async retryOwnerFenceLeaseRetirements(): Promise<void> {
    const receipts = await this.ctx.storage.list<OwnerFenceLeaseReceipt>({
      prefix: OWNER_FENCE_LEASE_RECEIPT_PREFIX,
      limit: 100,
    });
    for (const receipt of receipts.values()) {
      if (receipt.phase !== "unregister_pending") continue;
      await this.retireOwnerFenceLeaseReceipt(receipt);
    }
    if (await this.hasOwnerFenceLeaseRetirementDebt()) {
      await this.armOwnerFenceLeaseReconciliationAlarm();
    }
  }

  /**
   * Retire one exact durable lease receipt. The pending state is written before
   * the cross-DO request, so a lost response is replayable after isolate loss.
   */
  private async retireOwnerFenceLeaseReceipt(
    receipt: OwnerFenceLeaseReceipt,
    generation = receipt.registrationGeneration,
  ): Promise<boolean> {
    const receiptKey = ownerFenceLeaseReceiptKey(receipt.leaseId);
    let pending = receipt;
    await this.ctx.blockConcurrencyWhile(async () => {
      const current =
        await this.ctx.storage.get<OwnerFenceLeaseReceipt>(receiptKey);
      if (
        current &&
        !this.ownerFenceReceiptMatches(current, receipt, receipt.leaseId)
      ) {
        throw new OwnerPurgeFenceError();
      }
      pending = {
        ...(current ?? receipt),
        phase: "unregister_pending",
        updatedAt: Date.now(),
      };
      await this.ctx.storage.put(receiptKey, pending);
    });

    let response: Response;
    try {
      response = await this.callOwnerFence(pending.ownerId, "unregister", {
        ownerGeneration: pending.ownerGeneration,
        leaseId: pending.leaseId,
        sessionId: this.ctx.id.toString(),
        turnId: pending.turnId,
        ...(generation ? { generation } : {}),
      });
    } catch (error) {
      log("error", "owner_fence_unregister_deferred", {
        turnId: pending.turnId,
        leaseId: pending.leaseId,
        message: errorMessage(error),
      });
      await this.armOwnerFenceLeaseReconciliationAlarm();
      return false;
    }
    if (!response.ok) {
      log("error", "owner_fence_unregister_deferred", {
        turnId: pending.turnId,
        leaseId: pending.leaseId,
        status: response.status,
      });
      await this.armOwnerFenceLeaseReconciliationAlarm();
      return false;
    }

    await this.ctx.blockConcurrencyWhile(async () => {
      const current =
        await this.ctx.storage.get<OwnerFenceLeaseReceipt>(receiptKey);
      if (
        current &&
        this.ownerFenceReceiptMatches(current, pending, pending.leaseId)
      ) {
        await this.ctx.storage.delete(receiptKey);
      }
      if (pending.runSlotKey) {
        const slot = await this.ctx.storage.get<OwnerFenceRunSlot>(
          pending.runSlotKey,
        );
        if (slot?.leaseId === pending.leaseId) {
          await this.ctx.storage.delete(pending.runSlotKey);
        }
      }
    });
    return true;
  }

  private async registerOwnerTurn(
    turn: OwnerFencedTurn,
    freshLease = false,
    operationFingerprint?: string,
  ): Promise<string> {
    const runSlotKey = freshLease
      ? undefined
      : await this.ownerFenceRunSlotKey(turn);
    let receipt!: OwnerFenceLeaseReceipt;
    await this.ctx.blockConcurrencyWhile(async () => {
      const slot = runSlotKey
        ? await this.ctx.storage.get<OwnerFenceRunSlot>(runSlotKey)
        : undefined;
      if (
        slot &&
        (slot.schemaVersion !== 1 ||
          slot.ownerId !== turn.ownerId ||
          slot.ownerGeneration !== turn.ownerGeneration ||
          slot.turnId !== turn.turnId)
      ) {
        throw new OwnerPurgeFenceError();
      }
      const leaseId = freshLease
        ? crypto.randomUUID()
        : (turn.ownerPurgeLeaseId ?? slot?.leaseId ?? crypto.randomUUID());
      const receiptKey = ownerFenceLeaseReceiptKey(leaseId);
      const current =
        await this.ctx.storage.get<OwnerFenceLeaseReceipt>(receiptKey);
      if (current && !this.ownerFenceReceiptMatches(current, turn, leaseId)) {
        throw new OwnerPurgeFenceError();
      }
      if (
        current?.operationFingerprint &&
        operationFingerprint &&
        current.operationFingerprint !== operationFingerprint
      ) {
        throw new OwnerFenceLeaseConflictError();
      }
      const now = Date.now();
      receipt = current
        ? {
            ...current,
            ...(operationFingerprint && !current.operationFingerprint
              ? { operationFingerprint }
              : {}),
          }
        : {
            schemaVersion: 1,
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            turnId: turn.turnId,
            leaseId,
            kind: freshLease ? "aux" : "run",
            phase: "registering",
            ...(turn.ownerPurgeGeneration
              ? { registrationGeneration: turn.ownerPurgeGeneration }
              : {}),
            ...(runSlotKey ? { runSlotKey } : {}),
            ...(operationFingerprint ? { operationFingerprint } : {}),
            createdAt: now,
            updatedAt: now,
          };
      turn.ownerPurgeLeaseId = leaseId;
      if (receipt.registrationGeneration) {
        turn.ownerPurgeGeneration = receipt.registrationGeneration;
      }
      const writes: Record<string, unknown> = { [receiptKey]: receipt };
      if (runSlotKey) {
        writes[runSlotKey] = {
          schemaVersion: 1,
          ownerId: turn.ownerId,
          ownerGeneration: turn.ownerGeneration,
          turnId: turn.turnId,
          leaseId,
        } satisfies OwnerFenceRunSlot;
      }
      // The exact lease id is durable before owner-fence/register can commit.
      await this.ctx.storage.put(writes);
    });

    if (receipt.phase === "unregister_pending") {
      if (!(await this.retireOwnerFenceLeaseReceipt(receipt))) {
        throw new OwnerPurgeFenceError();
      }
      delete turn.ownerPurgeLeaseId;
      delete turn.ownerPurgeGeneration;
      return await this.registerOwnerTurn(
        turn,
        freshLease,
        operationFingerprint,
      );
    }
    if (receipt.phase === "registered" && receipt.registrationGeneration) {
      turn.ownerPurgeLeaseId = receipt.leaseId;
      turn.ownerPurgeGeneration = receipt.registrationGeneration;
      return receipt.registrationGeneration;
    }

    let response: Response;
    try {
      response = await this.callOwnerFence(turn.ownerId, "register", {
        ownerGeneration: receipt.ownerGeneration,
        leaseId: receipt.leaseId,
        sessionId: this.ctx.id.toString(),
        turnId: receipt.turnId,
        namespace: "orchestrator",
        role: "orchestrator",
        ...(receipt.registrationGeneration
          ? { generation: receipt.registrationGeneration }
          : {}),
      });
    } catch {
      // The remote Durable Object may have committed before the response was
      // lost. Preserve the exact intent so replay uses the same lease id.
      throw new OwnerFenceRegistrationUncertainError();
    }
    const body = (await response.json().catch(() => null)) as {
      generation?: string;
    } | null;
    if (!response.ok || !body?.generation) throw new OwnerPurgeFenceError();

    let committed = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      const receiptKey = ownerFenceLeaseReceiptKey(receipt.leaseId);
      const current =
        await this.ctx.storage.get<OwnerFenceLeaseReceipt>(receiptKey);
      if (
        !current ||
        current.phase === "unregister_pending" ||
        !this.ownerFenceReceiptMatches(current, receipt, receipt.leaseId)
      ) {
        return;
      }
      receipt = {
        ...current,
        phase: "registered",
        registrationGeneration: body.generation,
        updatedAt: Date.now(),
      };
      await this.ctx.storage.put(receiptKey, receipt);
      committed = true;
    });
    if (!committed) {
      // A concurrent purge retired the local intent while register was in
      // flight. Best-effort exact rollback; the purge still owns retry.
      await this.callOwnerFence(receipt.ownerId, "unregister", {
        ownerGeneration: receipt.ownerGeneration,
        leaseId: receipt.leaseId,
        sessionId: this.ctx.id.toString(),
        turnId: receipt.turnId,
        generation: body.generation,
      }).catch(() => undefined);
      throw new OwnerPurgeFenceError();
    }
    turn.ownerPurgeLeaseId = receipt.leaseId;
    turn.ownerPurgeGeneration = body.generation;
    return body.generation;
  }

  private async assertOwnerTurn(turn: OwnerFencedTurn): Promise<void> {
    if (!turn.ownerPurgeGeneration || !turn.ownerPurgeLeaseId) {
      throw new OwnerPurgeFenceError();
    }
    const response = await this.callOwnerFence(turn.ownerId, "assert", {
      ownerGeneration: turn.ownerGeneration,
      generation: turn.ownerPurgeGeneration,
      leaseId: turn.ownerPurgeLeaseId,
    });
    if (!response.ok) throw new OwnerPurgeFenceError();
  }

  private async assertOwnerFenceLeaseReceiptActive(
    turn: OwnerFencedTurn,
  ): Promise<void> {
    if (!turn.ownerPurgeGeneration || !turn.ownerPurgeLeaseId) {
      throw new OwnerPurgeFenceError();
    }
    const receipt = await this.ctx.storage.get<OwnerFenceLeaseReceipt>(
      ownerFenceLeaseReceiptKey(turn.ownerPurgeLeaseId),
    );
    if (
      !receipt ||
      receipt.phase !== "registered" ||
      receipt.registrationGeneration !== turn.ownerPurgeGeneration ||
      !this.ownerFenceReceiptMatches(receipt, turn, turn.ownerPurgeLeaseId)
    ) {
      throw new OwnerPurgeFenceError();
    }
  }

  private async retireOwnerFenceLeaseByIdentity(
    turn: Pick<OwnerFencedTurn, "ownerId" | "ownerGeneration" | "turnId">,
    leaseId: string,
    generation?: string,
  ): Promise<boolean> {
    const receiptKey = ownerFenceLeaseReceiptKey(leaseId);
    let receipt =
      await this.ctx.storage.get<OwnerFenceLeaseReceipt>(receiptKey);
    if (receipt && !this.ownerFenceReceiptMatches(receipt, turn, leaseId)) {
      log("error", "owner_fence_unregister_identity_conflict", {
        turnId: turn.turnId,
        leaseId,
      });
      return false;
    }
    if (!receipt) {
      // Rolling-deploy repair for a lease admitted before the durable receipt.
      const now = Date.now();
      const possibleRunSlotKey = await this.ownerFenceRunSlotKey(turn);
      const possibleRunSlot =
        await this.ctx.storage.get<OwnerFenceRunSlot>(possibleRunSlotKey);
      const runSlotKey =
        possibleRunSlot?.leaseId === leaseId ? possibleRunSlotKey : undefined;
      receipt = {
        schemaVersion: 1,
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        turnId: turn.turnId,
        leaseId,
        kind: runSlotKey ? "run" : "aux",
        phase: "unregister_pending",
        ...(generation ? { registrationGeneration: generation } : {}),
        ...(runSlotKey ? { runSlotKey } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await this.ctx.storage.put(receiptKey, receipt);
    }
    return await this.retireOwnerFenceLeaseReceipt(receipt, generation);
  }

  private async unregisterOwnerTurn(turn: OwnerFencedTurn): Promise<boolean> {
    const leaseId = turn.ownerPurgeLeaseId;
    if (!leaseId) return true;
    return await this.retireOwnerFenceLeaseByIdentity(
      turn,
      leaseId,
      turn.ownerPurgeGeneration,
    );
  }

  private convexEndpoint(): {
    base: string;
    secret: string;
    ownerGeneration: string;
  } | null {
    const base = (this.convexBase ?? this.env.STELLA_CONVEX_SITE_URL ?? "")
      .trim()
      .replace(/\/+$/, "");
    if (!base || !this.env.BUILDER_SERVICE_SECRET || !this.ownerGeneration) {
      return null;
    }
    return {
      base,
      secret: this.env.BUILDER_SERVICE_SECRET,
      ownerGeneration: this.ownerGeneration,
    };
  }

  /** Last dispatch's callback origin, so flushes work between turns too. */
  private convexBase?: string;

  /**
   * The DO never adopts its first connector as owner: `conversationId` would
   * become a bearer token and anyone who guessed a UUID would own the object.
   * Ownership comes from Convex, once, and is then immutable.
   */
  private lookupOwner(
    forceGenerationRefresh = false,
  ): Promise<ConversationOwnerRecord | null> {
    const bound = this.journal.meta();
    if (!forceGenerationRefresh && bound.owner_id && this.ownerGeneration) {
      return Promise.resolve({
        ownerId: bound.owner_id,
        ownerGeneration: this.ownerGeneration,
        createdAt: bound.created_at,
        title: bound.title,
      });
    }
    if (
      mayReusePendingOwnerLookup(forceGenerationRefresh) &&
      this.ownerLookup
    ) {
      return this.ownerLookup;
    }
    const conversationId = this.conversationId();
    const base = (this.convexBase ?? this.env.STELLA_CONVEX_SITE_URL ?? "")
      .trim()
      .replace(/\/+$/, "");
    const secret = this.env.BUILDER_SERVICE_SECRET;
    if (!conversationId || !base || !secret) return Promise.resolve(null);
    const work = (async (): Promise<ConversationOwnerRecord | null> => {
      const response = await fetch(
        `${base}/api/cloud/conversation-owner?conversationId=${encodeURIComponent(
          conversationId,
        )}`,
        {
          headers: { authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (response.status === 404) {
        // Convex has never heard of this id, so nothing legitimate addressed
        // this object. Leave no state behind: otherwise anyone who guesses a
        // UUID mints a permanent empty DO. Only a definite 404 does this — a
        // misconfigured endpoint returns null far above without touching
        // storage, and a bound DO never reaches this code at all.
        await this.resetUnknownConversation();
        return null;
      }
      if (!response.ok) {
        throw new Error(
          `Conversation owner lookup failed (${response.status}).`,
        );
      }
      const payload = (await response.json()) as ConversationOwnerRecord;
      const ownerId =
        typeof payload?.ownerId === "string" ? payload.ownerId.trim() : "";
      const ownerGeneration = normalizeOwnerGeneration(
        payload?.ownerGeneration,
      );
      if (!ownerId || !ownerGeneration) return null;
      const record = { ...payload, ownerId, ownerGeneration };
      this.ownerGeneration = ownerGeneration;
      await this.ctx.storage.put("ownerDataGeneration", ownerGeneration);
      this.journal.bindOwner({ ...record, conversationId });
      return record;
    })();
    // A fresh admission lookup deliberately remains outside the shared cache:
    // a concurrent socket lookup may have captured the lifecycle generation
    // before Convex rotated it.
    if (forceGenerationRefresh) return work;
    const shared = work.finally(() => {
      if (this.ownerLookup === shared) this.ownerLookup = null;
    });
    this.ownerLookup = shared;
    return shared;
  }

  /**
   * Wipe an object that Convex says does not exist, then put the schema back so
   * the instance stays usable if a real dispatch arrives later. Refuses if the
   * journal holds anything: an owner-bound conversation whose index row was
   * lost must be recovered or purged deliberately, never wiped by a read.
   */
  private async resetUnknownConversation(): Promise<void> {
    const meta = this.journal.meta();
    if (meta.owner_id || meta.next_seq > 0) return;
    try {
      await this.ctx.storage.deleteAll();
      await this.journal.bootstrap();
      if (this.ctx.id.name) this.journal.setConversationId(this.ctx.id.name);
      log("info", "conversation_unknown_reset", {
        conversationId: this.ctx.id.name ?? "",
      });
    } catch (error) {
      // Never fatal: the caller's job is to refuse the connect, and it does
      // that whether or not the wipe succeeded.
      log("error", "conversation_unknown_reset_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private reader(): JournalReader {
    return {
      head: (): JournalHead =>
        this.journal.head(this.live ? "running" : "idle"),
      ownerId: () => this.journal.ownerId(),
      bindOwner: (record) =>
        this.journal.bindOwner({
          ...record,
          conversationId: this.conversationId(),
        }),
      readRange: (fromSeq, toSeq, limit): Promise<JournalRange> =>
        this.archive.readRange(
          fromSeq,
          toSeq,
          Math.min(limit, BACKFILL_BATCH_RECORDS),
        ),
      newest: (limit): JournalRecord[] =>
        this.journal.newest(Math.min(limit, INITIAL_WINDOW_RECORDS)),
      liveTurn: () => this.live,
    };
  }

  private flushIndexIfLagging(): void {
    if (!this.index.lagging()) return;
    void this.index
      .flush({
        activity: this.live ? "running" : "idle",
        updatedAt: Date.now(),
      })
      .catch(() => undefined);
  }

  /**
   * Publishes a committed row. Broadcast is best-effort by construction: the
   * row is durable first, the frame is sent second, and a crash in between
   * costs a frame, not a fact. The client's gap detection closes it.
   */
  private publish(record: JournalRecord | null | undefined): void {
    if (!record) return;
    try {
      this.hub.broadcastRecord(record);
    } catch (error) {
      log("error", "conversation_broadcast_failed", {
        seq: record.seq,
        message: errorMessage(error),
      });
    }
  }

  private async cancelTurn(turnId: string): Promise<void> {
    const localLease =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (localLease?.turnId === turnId) {
      await this.cancelLocalTurn(localLease);
      return;
    }
    const current = await this.ctx.storage.get<ChatTurnRequest>("turn");
    const queued = await this.ctx.storage.get<ChatTurnRequest>(
      `queued:${turnId}`,
    );
    const target = current?.turnId === turnId ? current : queued;
    if (!target) return;
    const response = await this.cancelExactChatTurn({
      turnId,
      cancelRequestId: `interactive:${turnId}`.slice(0, 128),
      ownerId: target.ownerId,
      ownerGeneration: target.ownerGeneration,
    });
    if (!response.ok) {
      throw new Error(
        `Exact turn cancellation failed with ${response.status}.`,
      );
    }
  }

  private enqueue(turn: ChatTurnRequest): void {
    if (this.turnExecutions.has(turn.turnId)) return;
    // Failures surface through the turn's own terminal event; the queue
    // must survive them.
    const preceding = this.queue;
    const execution = startTurnExecution({
      work: ({ cancellation, signal }) =>
        preceding.then(() => this.runTurn(turn, cancellation, signal)),
      onInterrupt: () => {
        // Agent.abort() is idempotent. Once prompt() has synchronously entered
        // its loop this reaches the provider/tool AbortController; before that
        // point the turn latch and the admission checks below are authoritative.
        if (this.activeTurnId === turn.turnId) this.currentAgent?.abort();
      },
    });
    this.turnExecutions.set(turn.turnId, execution);
    const clear = () => {
      if (this.turnExecutions.get(turn.turnId) === execution) {
        this.turnExecutions.delete(turn.turnId);
      }
    };
    void execution.settled.then(clear, clear);
    this.queue = execution.settled.catch(() => undefined);
    this.ctx.waitUntil(this.queue);
  }

  /**
   * Exact placement Stop boundary. Target inspection and durable staging share
   * one critical section, so an unknown/queued turn cannot arrive later and run.
   * A current turn is acknowledged only after its exact execution promise has
   * settled; a newer current turn is never touched.
   */
  private async cancelExactChatTurn(
    request: ExactTurnCancellationRequest,
  ): Promise<Response> {
    type Target =
      | { kind: "unknown" }
      | { kind: "queued"; turn: ChatTurnRequest }
      | {
          kind: "current";
          turn: ChatTurnRequest;
          terminalKind?: string;
        };
    type Admission =
      | { response: Response }
      | { staged: ExactTurnCancellation; target: Target };

    const admission = await this.ctx.blockConcurrencyWhile(
      async (): Promise<Admission> => {
        const current = await this.ctx.storage.get<ChatTurnRequest>("turn");
        const queued = await this.ctx.storage.get<ChatTurnRequest>(
          `queued:${request.turnId}`,
        );
        const exact = current?.turnId === request.turnId ? current : queued;
        if (
          exact &&
          (exact.ownerId !== request.ownerId ||
            exact.ownerGeneration !== request.ownerGeneration)
        ) {
          return {
            response: json(
              {
                canceled: false,
                reason: "stale_owner_generation",
                turnId: request.turnId,
              },
              409,
            ),
          };
        }

        let terminalKind: string | undefined;
        if (
          current?.turnId === request.turnId &&
          (await this.ctx.storage.get<boolean>("terminal"))
        ) {
          const owed = await this.ctx.storage.get<OwedTerminal | null>(
            "terminalOwed",
          );
          const journalState = this.journal.turnState(request.turnId);
          terminalKind =
            owed?.kind ??
            (journalState?.state === "terminal"
              ? (journalState.terminal_kind ?? undefined)
              : undefined);
          if (terminalKind !== "canceled") {
            return {
              response: json(
                {
                  canceled: false,
                  reason: "terminal_already_decided",
                  turnId: request.turnId,
                },
                409,
              ),
            };
          }
        }

        const result = await this.exactTurnCancellations.stage(request);
        if (result.status === "conflict") {
          return {
            response: json(
              {
                canceled: false,
                reason: "cancellation_identity_conflict",
                turnId: request.turnId,
              },
              409,
            ),
          };
        }
        if (result.status === "saturated") {
          return {
            response: json(
              {
                canceled: false,
                reason: "cancellation_ledger_saturated",
                turnId: request.turnId,
              },
              503,
            ),
          };
        }
        if (!("cancellation" in result)) {
          return {
            response: json(
              { canceled: false, reason: "cancellation_not_staged" },
              503,
            ),
          };
        }
        const target: Target =
          current?.turnId === request.turnId
            ? { kind: "current", turn: current, terminalKind }
            : queued
              ? { kind: "queued", turn: queued }
              : { kind: "unknown" };
        return { staged: result.cancellation, target };
      },
    );

    if ("response" in admission) return admission.response;
    const { staged, target } = admission;
    if (staged.state === "acknowledged") {
      return json({ canceled: true, turnId: request.turnId, replayed: true });
    }
    if (target.kind === "unknown" || target.kind === "queued") {
      return json(
        {
          canceled: true,
          turnId: request.turnId,
          pending: true,
          durable: true,
        },
        202,
      );
    }
    if (target.terminalKind === "canceled") {
      const execution = this.turnExecutions.get(request.turnId);
      if (this.activeTurnId === request.turnId && !execution) {
        return json(
          {
            canceled: false,
            reason: "exact_turn_join_unavailable",
            turnId: request.turnId,
          },
          503,
        );
      }
      if (execution) await execution.join();
      await this.acknowledgeExactTurnCancellation(request);
      return json({
        canceled: true,
        turnId: request.turnId,
        replayed: true,
        joined: true,
      });
    }
    return await this.cancelCurrentChatTurn(target.turn, request);
  }

  private async acknowledgeExactTurnCancellation(
    request: ExactTurnCancellationRequest,
  ): Promise<boolean> {
    return await this.ctx.blockConcurrencyWhile(
      async () => await this.exactTurnCancellations.acknowledge(request),
    );
  }

  private async cancelCurrentChatTurn(
    turn: ChatTurnRequest,
    request: ExactTurnCancellationRequest,
  ): Promise<Response> {
    const execution = this.turnExecutions.get(turn.turnId);
    if (this.activeTurnId === turn.turnId && !execution) {
      return json(
        {
          canceled: false,
          reason: "exact_turn_join_unavailable",
          turnId: turn.turnId,
        },
        503,
      );
    }
    const stored = await this.ctx.storage.get<ChatTurnRequest>("turn");
    if (
      !stored ||
      stored.turnId !== request.turnId ||
      stored.ownerId !== request.ownerId ||
      stored.ownerGeneration !== request.ownerGeneration
    ) {
      return json(
        {
          canceled: false,
          reason: "stale_turn",
          turnId: request.turnId,
          currentTurnId: stored?.turnId ?? null,
        },
        409,
      );
    }

    const exactTurn = { ...stored };
    try {
      exactTurn.ownerPurgeGeneration = await this.registerOwnerTurn(
        exactTurn,
        true,
      );
      await this.assertOwnerTurn(exactTurn);
      await this.ctx.storage.put({
        terminal: true,
        terminalOwed: {
          kind: "canceled",
          message: TERMINAL_NOTICE.canceled,
        } satisfies OwedTerminal,
      });
      await execution?.interrupt(new Error("The chat turn was stopped."));
      this.recordTerminal(exactTurn, "canceled", TERMINAL_NOTICE.canceled);
      try {
        await this.event(
          exactTurn,
          "auto",
          "canceled",
          { message: TERMINAL_NOTICE.canceled },
          true,
        );
        await this.ctx.storage.put("terminalDelivered", true);
      } catch {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      }
      await this.finalizeTerminalTurn(exactTurn);
      if (execution) await execution.join();
      if (!(await this.acknowledgeExactTurnCancellation(request))) {
        throw new Error("Exact turn cancellation acknowledgement was lost.");
      }
      return json({
        canceled: true,
        turnId: request.turnId,
        joined: true,
      });
    } catch (error) {
      if (error instanceof OwnerPurgeFenceError) {
        return json(
          {
            canceled: false,
            reason: "owner_fence_closed",
            turnId: request.turnId,
          },
          409,
        );
      }
      throw error;
    } finally {
      await this.unregisterOwnerTurn(exactTurn);
    }
  }

  private async queuedTurns(): Promise<ChatTurnRequest[]> {
    const queued = await this.ctx.storage.list<ChatTurnRequest>({
      prefix: "queued:",
    });
    return [...queued.values()].sort(
      (left, right) =>
        (left.queuedAt ?? Number.MAX_SAFE_INTEGER) -
          (right.queuedAt ?? Number.MAX_SAFE_INTEGER) ||
        left.turnId.localeCompare(right.turnId),
    );
  }

  private async withTurnAdmissionLock<T>(work: () => Promise<T>): Promise<T> {
    const preceding = this.turnAdmissionTail;
    let release!: () => void;
    this.turnAdmissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async restoreLocalLease(lease: LocalTurnLease): Promise<void> {
    this.live = {
      turnId: lease.turnId,
      streamId: null,
      partialText: "",
      tools: [],
    };
    if (
      lease.cancelRequested &&
      (!Number.isFinite(lease.cancelDeadlineAt) || lease.cancelDeadlineAt! <= 0)
    ) {
      // A deployment-era or crash-recovered cancellation without a deadline
      // gets a full new desktop ACK grace. It must never fall back to the
      // older provider lease expiry and retire immediately.
      lease.cancelDeadlineAt = Date.now() + LOCAL_TURN_CANCEL_GRACE_MS;
      await this.ctx.storage.put(LOCAL_TURN_LEASE_KEY, lease);
    }
    const retirementAt = localTurnRetirementDeadline(lease);
    const alarmAt = await this.ctx.storage.getAlarm();
    if (
      lease.cancelRequested
        ? alarmAt !== retirementAt
        : alarmAt === null || alarmAt > retirementAt
    ) {
      await this.ctx.storage.setAlarm(retirementAt);
    }
  }

  private async armLocalLeaseAlarm(expiresAt: number): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > expiresAt) {
        await this.ctx.storage.setAlarm(expiresAt);
      }
    });
  }

  private async storeLocalTurnReceipt(
    lease: LocalTurnLease,
    receipt: LocalTurnFinishReceipt,
  ): Promise<void> {
    const records: Record<string, unknown> = {
      [localTurnReceiptKey(lease.turnId)]: receipt,
    };
    if (lease.clientMsgId) {
      records[localClientMessageKey(lease.clientMsgId)] = {
        ownerGeneration: lease.ownerGeneration,
        clientMsgId: lease.clientMsgId,
        beginFingerprint: lease.beginFingerprint,
        turnId: lease.turnId,
        phase: receipt.phase,
      } satisfies LocalClientMessageReceipt;
    }
    await this.ctx.storage.put(records);
  }

  private async cancelLocalTurn(
    lease: LocalTurnLease,
    forceRelease = false,
  ): Promise<boolean> {
    let claimed: LocalTurnLease | undefined;
    let terminalRecord: JournalRecord | undefined;
    await this.ctx.blockConcurrencyWhile(async () => {
      const current =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (
        !current ||
        current.turnId !== lease.turnId ||
        current.leaseToken !== lease.leaseToken
      ) {
        return;
      }
      const state = this.journal.turnState(current.turnId);
      const wasExternallyCanceled = current.cancelRequested === true;
      current.cancelRequested = true;
      if (
        !Number.isFinite(current.cancelDeadlineAt) ||
        current.cancelDeadlineAt! <= 0
      ) {
        current.cancelDeadlineAt = Date.now() + LOCAL_TURN_CANCEL_GRACE_MS;
      }
      const cancelDeadlineAt = current.cancelDeadlineAt!;
      await this.ctx.storage.put(LOCAL_TURN_LEASE_KEY, current);
      // Replace (rather than retain) an earlier watchdog. alarm() must never
      // interpret an unrelated/old alarm as the end of the desktop ACK grace.
      await this.ctx.storage.setAlarm(cancelDeadlineAt);

      let phase =
        state?.state === "terminal"
          ? (parseLocalTerminalPhase(state.terminal_kind) ?? "canceled")
          : "canceled";
      let terminalSeq = this.journal.head("idle").headSeq;
      let externallyCanceled = wasExternallyCanceled;
      if (state?.state !== "terminal") {
        const now = Date.now();
        const terminal = this.journal.appendTurn({
          turnId: current.turnId,
          writer: `desktop:${current.deviceId}`,
          writerKey: `turn:${current.turnId}:phase:canceled`,
          phase: "canceled",
          lane: "chat",
          source: "desktop",
          notice: TERMINAL_NOTICE.canceled,
          createdAt: now,
        });
        terminalSeq = terminal.seq;
        terminalRecord = terminal.record;
        phase = "canceled";
        externallyCanceled = true;
        this.journal.setTurnSpan(current.turnId, terminal.seq);
        this.journal.setTurnTerminal(current.turnId, "canceled", now);
      }
      const receipt: LocalTurnFinishReceipt = {
        ownerGeneration: current.ownerGeneration,
        turnId: current.turnId,
        deviceId: current.deviceId,
        localTurnId: current.localTurnId,
        leaseToken: current.leaseToken,
        phase,
        firstSeq: terminalSeq,
        lastSeq: terminalSeq,
        epoch: this.journal.meta().epoch,
        ...(externallyCanceled
          ? { externallyCanceled: true }
          : current.finishFingerprint
            ? { finishFingerprint: current.finishFingerprint }
            : {}),
      };
      await this.storeLocalTurnReceipt(current, receipt);
      claimed = current;
    });
    if (!claimed) return false;
    if (terminalRecord) this.publish(terminalRecord);
    this.live = null;
    this.hub.endTurn(claimed.turnId);
    // Keep the single-writer fence during a short cancellation handshake.
    // The desktop runtime's control heartbeat observes the terminal receipt,
    // aborts its provider, and replays a canceled finish, whose receipt path
    // releases immediately. If the desktop is gone, the alarm force-releases
    // after the bounded grace instead of admitting conflicting work at the
    // instant another client presses Stop.
    if (forceRelease) {
      await this.unregisterOwnerTurn(claimed);
      await this.releaseLocalLeaseAndResume(claimed);
    }
    this.recordExcerpt(claimed.turnId);
    const now = Date.now();
    await this.index
      .flush({ activity: "idle", updatedAt: now })
      .catch(() => undefined);
    try {
      this.drainInbox();
    } catch (error) {
      log("error", "conversation_local_turn_cancel_drain_failed", {
        turnId: claimed.turnId,
        message: errorMessage(error),
      });
    }
    await this.archive.maybeRollover(now).catch((error) => {
      log("error", "conversation_local_turn_cancel_rollover_failed", {
        turnId: claimed!.turnId,
        message: errorMessage(error),
      });
    });
    return true;
  }

  private async releaseLocalLeaseAndResume(
    lease: LocalTurnLease,
    resumeQueued = true,
  ): Promise<void> {
    let queued: ChatTurnRequest[] = [];
    await this.ctx.blockConcurrencyWhile(async () => {
      const current =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (
        !current ||
        current.turnId !== lease.turnId ||
        current.leaseToken !== lease.leaseToken
      ) {
        return;
      }
      await this.ctx.storage.delete(LOCAL_TURN_LEASE_KEY);
      if (resumeQueued) {
        queued = await this.queuedTurns();
        if (queued.length === 0) {
          if (await this.hasOwnerFenceLeaseRetirementDebt()) {
            const retryAt = Date.now() + 30_000;
            const alarmAt = await this.ctx.storage.getAlarm();
            if (alarmAt === null || alarmAt > retryAt) {
              await this.ctx.storage.setAlarm(retryAt);
            }
          } else {
            await this.ctx.storage.deleteAlarm().catch(() => undefined);
          }
        }
      }
    });
    for (const turn of queued) this.enqueue(turn);
    if (queued.length > 0) await this.ensureQueueAlarm();
  }

  private convexPost(
    base: string,
    path: string,
    body: unknown,
    ownerGeneration?: string,
    options?: { turnToken?: string; signal?: AbortSignal },
  ): Promise<Response> {
    const callbackBody =
      ownerGeneration &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), ownerGeneration }
        : body;
    return fetch(`${base.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(options?.turnToken
          ? { "x-stella-turn-token": options.turnToken }
          : {}),
      },
      body: JSON.stringify(callbackBody),
      signal: options?.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  }

  private async event(
    turn: ChatTurnRequest,
    seq: number | "auto",
    kind: string,
    payload: unknown,
    terminal = false,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.convexPost(
      turn.convexCallbackBase,
      "/api/cloud/events",
      {
        ownerId: turn.ownerId,
        turnId: turn.turnId,
        sessionId: turn.sessionId,
        tokenHash: await sha256Hex(turn.turnToken),
        seq,
        kind,
        payload,
        terminal,
      },
      turn.ownerGeneration,
      signal ? { signal } : undefined,
    );
    if (!response.ok) {
      throw new Error(`Convex event callback failed with ${response.status}.`);
    }
  }

  /**
   * What this turn still owes Convex, for a caller that did not terminate it
   * itself. `terminalOwed` is the authority — it is written in the same durable
   * put as `terminal` by every path that terminates a turn. The journal's
   * recorded kind is the fallback, and covers exactly one case: a turn that
   * went terminal under a build that predates the key.
   */
  private async owedTerminal(
    turn: ChatTurnRequest,
  ): Promise<OwedTerminal | null> {
    const owed = await this.ctx.storage.get<OwedTerminal | null>(
      "terminalOwed",
    );
    if (owed) return owed;
    if (!(await this.ctx.storage.get<boolean>("terminal"))) return null;
    const recorded = this.journal.turnState(turn.turnId);
    const kind =
      recorded?.state === "terminal" && recorded.terminal_kind
        ? recorded.terminal_kind
        : "failed";
    return { kind: kind as TurnPhase, message: terminalNotice(kind) };
  }

  /**
   * The wake guarantee, made true rather than nearly true: for as long as any
   * turn is durable under `queued:`, this object has a pending alarm.
   *
   * `/turn` establishes it; every path that ENDS an alarm has to restore it.
   * Firing is one of those paths — Cloudflare consumes the alarm when it
   * delivers it and never re-arms — so a watchdog that fires while a second
   * turn sits queued leaves that turn with no wake signal at all. The
   * in-memory queue still drains it, right up until the isolate is evicted;
   * after that nothing in Cloudflare or Convex ever wakes this object on its
   * own, and a turn that was accepted with a 202 and an `agent_turns` row
   * reading "running" is stranded until a user happens to open the
   * conversation, which may be days later or never.
   *
   * Arms only when nothing is pending, and never deletes: a live watchdog or a
   * 30 s terminal-delivery rung must not be shortened or dropped by a call to
   * this. The critical section is what makes the read and the write one step
   * against `/turn` and against the completed path's `deleteAlarm`.
   */
  private async ensureQueueAlarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.getAlarm()) !== null) return;
      const queued = await this.ctx.storage.list<ChatTurnRequest>({
        prefix: "queued:",
        limit: 1,
      });
      const next = [...queued.values()][0];
      if (!next) return;
      await this.ctx.storage.setAlarm(
        Date.now() + Math.max(1_000, next.watchdogMs ?? CHAT_WATCHDOG_MS),
      );
      log("info", "chat_queue_alarm_rearmed", {
        turnId: next.turnId,
        conversationId: next.conversationId,
      });
    });
  }

  private async expireLocalLease(
    lease: LocalTurnLease,
    resumeQueued: boolean,
  ): Promise<void> {
    const current =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (
      !current ||
      current.turnId !== lease.turnId ||
      current.leaseToken !== lease.leaseToken
    ) {
      return;
    }
    const priorState = this.journal.turnState(lease.turnId);
    const phase =
      priorState?.state === "terminal"
        ? (parseLocalTerminalPhase(priorState.terminal_kind) ?? "timeout")
        : "timeout";
    let terminalSeq = this.journal.head("idle").headSeq;
    try {
      if (priorState?.state !== "terminal") {
        const now = Date.now();
        const row = this.journal.appendTurn({
          turnId: lease.turnId,
          writer: `desktop:${lease.deviceId}`,
          writerKey: `turn:${lease.turnId}:phase:timeout`,
          phase: "timeout",
          lane: "chat",
          source: "desktop",
          notice: TERMINAL_NOTICE.timeout,
          createdAt: now,
        });
        terminalSeq = row.seq;
        this.journal.setTurnSpan(lease.turnId, row.seq);
        this.journal.setTurnTerminal(lease.turnId, "timeout", now);
        this.publish(row.record);
      }
    } catch (error) {
      log("error", "conversation_local_turn_timeout_failed", {
        turnId: lease.turnId,
        message: errorMessage(error),
      });
      throw error;
    }
    const receipt: LocalTurnFinishReceipt = {
      ownerGeneration: lease.ownerGeneration,
      turnId: lease.turnId,
      deviceId: lease.deviceId,
      localTurnId: lease.localTurnId,
      leaseToken: lease.leaseToken,
      phase,
      firstSeq: terminalSeq,
      lastSeq: terminalSeq,
      epoch: this.journal.meta().epoch,
    };
    await this.storeLocalTurnReceipt(lease, receipt);
    await this.unregisterOwnerTurn(lease);
    await this.releaseLocalLeaseAndResume(lease, resumeQueued);
    this.live = null;
    this.hub.endTurn(lease.turnId);
    this.recordExcerpt(lease.turnId);
    const now = Date.now();
    await this.index
      .flush({ activity: "idle", updatedAt: now })
      .catch(() => undefined);
    try {
      this.drainInbox();
    } catch (error) {
      log("error", "conversation_local_turn_timeout_drain_failed", {
        turnId: lease.turnId,
        message: errorMessage(error),
      });
    }
    await this.archive.maybeRollover(now).catch((error) => {
      log("error", "conversation_local_turn_timeout_rollover_failed", {
        turnId: lease.turnId,
        message: errorMessage(error),
      });
    });
  }

  async alarm(): Promise<void> {
    // A turn can finish after its remote lease was removed but before the
    // unregister response arrived. Reconcile that durable debt before using
    // this wake-up for the conversation lifecycle.
    await this.retryOwnerFenceLeaseRetirements();
    const localLease =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (localLease) {
      if (localLease.cancelRequested) {
        const deadline = localLease.cancelDeadlineAt;
        if (!Number.isFinite(deadline) || deadline! <= 0) {
          // Migration/failure-safe path for a cancellation written before the
          // deadline field existed: grant a full fresh grace, never release now.
          localLease.cancelDeadlineAt = Date.now() + LOCAL_TURN_CANCEL_GRACE_MS;
          await this.ctx.storage.put(LOCAL_TURN_LEASE_KEY, localLease);
          await this.ctx.storage.setAlarm(localLease.cancelDeadlineAt);
          return;
        }
        if (Date.now() < deadline!) {
          await this.ctx.storage.setAlarm(deadline!);
          return;
        }
        await this.cancelLocalTurn(localLease, true);
      } else if (localLease.expiresAt <= Date.now()) {
        await this.expireLocalLease(localLease, true);
      } else {
        await this.armLocalLeaseAlarm(localLease.expiresAt);
      }
      return;
    }
    const turn = await this.ctx.storage.get<ChatTurnRequest>("turn");
    if (!turn || (await this.ctx.storage.get<boolean>("terminalDelivered"))) {
      // Nothing owed for the turn under `turn` — but this firing still spent
      // the alarm, and the queue may not be empty. Both of these are reachable
      // with work outstanding: `!turn` is a first-ever dispatch whose watchdog
      // beat `runTurn` to the claim, and `terminalDelivered` is the ordinary
      // watchdog of a turn that finished while a later one was queued behind
      // it.
      await this.ensureQueueAlarm();
      return;
    }
    const alarmTurn = { ...turn };
    try {
      alarmTurn.ownerPurgeGeneration = await this.registerOwnerTurn(
        alarmTurn,
        true,
      );
      await this.assertOwnerTurn(alarmTurn);
      await this.runAlarm(alarmTurn);
    } catch (error) {
      if (error instanceof OwnerPurgeFenceError) {
        this.currentTurnCancellation?.abort();
        this.currentAgent?.abort();
        return;
      }
      throw error;
    } finally {
      await this.unregisterOwnerTurn(alarmTurn);
    }
  }

  private async runAlarm(turn: ChatTurnRequest): Promise<void> {
    // The alarm is two jobs sharing one wake-up: the watchdog, and the retry
    // ladder every other terminal path re-arms when its Convex delivery fails.
    // Only the first job may terminate a turn. Running the timeout path over a
    // turn that is already canceled or failed writes a SECOND terminal row —
    // `recordTerminal` keys on the phase, so it is a distinct row, not a
    // replay — and the clients group on the last row per turn, so the user who
    // pressed Stop is told the turn timed out instead.
    let owed = await this.owedTerminal(turn);
    if (!owed) {
      await this.ctx.storage.put("terminal", true);
      // Marking the turn terminal is not enough — the loop would keep burning
      // metered relay calls for output runTurn will discard.
      this.currentTurnCancellation?.abort();
      this.currentAgent?.abort();
      log("error", "chat_turn_timed_out", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
      });
      // Additive: the journal row a socket client needs to stop showing a
      // spinner. It is written whether or not the Convex event below lands —
      // the two deliveries are independent, and this one has no retry ladder
      // because it cannot fail transiently.
      this.recordTerminal(turn, "timeout", TERMINAL_NOTICE.timeout);
      owed = { kind: "timeout", message: TERMINAL_NOTICE.timeout };
      await this.ctx.storage.put("terminalOwed", owed);
    }
    try {
      await this.event(
        turn,
        "auto",
        owed.kind,
        owed.payload ?? { message: owed.message },
        true,
      );
      await this.ctx.storage.put("terminalDelivered", true);
    } catch (error) {
      // Single-shot delivery would strand the turn "running" on one
      // transient Convex failure; retry via a re-armed alarm.
      const attempts =
        ((await this.ctx.storage.get<number>("alarmAttempts")) ?? 0) + 1;
      if (attempts <= 5) {
        await this.ctx.storage.put("alarmAttempts", attempts);
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      } else {
        await this.ctx.storage.put("terminalDelivered", true);
        log("error", "terminal_delivery_abandoned", {
          turnId: turn.turnId,
          message: errorMessage(error),
        });
      }
    }
    // Before the projection work, not after it. Every exit above has now
    // either re-armed the alarm for its own retry or consumed it for good, so
    // this is the first moment the queue can be honestly re-fenced — and
    // `finalizeTerminalTurn` below is the window the finding turns on: an
    // index flush (a Convex round trip with a 30 s timeout) and a possible R2
    // segment cut, during which the isolate can be evicted or redeployed. Arm
    // first and that eviction costs a wake-up; arm after and it costs the
    // queued turn.
    await this.ensureQueueAlarm();
    // Last, so the terminal event is never held up by projection work — but
    // unconditionally, on the delivered and the re-armed path alike. A
    // timed-out turn owes the same post-terminal work as a completed one:
    // without it the whole turn, including everything the model produced
    // before the watchdog fired, is absent from Recall forever, and any card
    // staged while it ran sits in the inbox until the user happens to send
    // another message in that conversation.
    await this.finalizeTerminalTurn(turn);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.pathname.startsWith("/internal/edit/")
    ) {
      return this.handleConversationEditRoute(url.pathname, request);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/internal/transfer-owner"
    ) {
      return this.handleOwnerTransfer(request);
    }
    const ownerTransfer =
      await this.ctx.storage.get<OwnerTransferRequest>(OWNER_TRANSFER_KEY);
    if (ownerTransfer) {
      return json(
        {
          code: "owner_transfer_in_progress",
          message: "Conversation ownership is being updated.",
        },
        409,
      );
    }
    if (url.pathname === "/socket") return this.handleSocket(request);
    if (request.method === "GET") {
      if (url.pathname === "/history") {
        return this.handleCanonicalHistory(request);
      }
      if (url.pathname === "/journal") return this.handleJournalProbe(url);
      return json({ error: "Not found." }, 404);
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405);
    }
    const conversationEdit = await this.activeConversationEditLock();
    if (
      conversationEdit &&
      url.pathname !== "/cancel" &&
      url.pathname !== "/purge" &&
      url.pathname !== "/owner-purge-cancel"
    ) {
      return json(
        {
          code: "conversation_edit_in_progress",
          message: "This conversation is being edited. Try again shortly.",
          retryAfterMs: 1_000,
        },
        409,
      );
    }
    if (url.pathname === "/internal/dev-acceptance/probe") {
      return this.handleDevAcceptanceProbe(request);
    }
    if (url.pathname === "/local-turns/begin") {
      return this.handleLocalTurnBegin(request);
    }
    if (url.pathname === "/local-turns/finish") {
      return this.handleLocalTurnFinish(request);
    }
    if (url.pathname === "/journal") return this.handleJournalAppend(request);
    if (url.pathname === "/cards") return this.handleCard(request);
    if (url.pathname === "/purge") return this.handlePurge();
    if (url.pathname === "/reindex") return this.handleReindex();
    if (url.pathname === "/owner-purge-cancel") {
      const body = (await request.json().catch(() => ({}))) as {
        ownerId?: string;
        ownerGeneration?: string;
        turnId?: string;
        generation?: string;
        leaseId?: string;
      };
      const turnId = body.turnId?.trim() ?? "";
      const ownerId = body.ownerId?.trim() ?? "";
      const ownerGeneration = body.ownerGeneration?.trim() ?? "";
      const generation = body.generation?.trim() ?? "";
      const leaseId = body.leaseId?.trim() ?? "";
      if (!turnId || !ownerId || !ownerGeneration || !generation || !leaseId) {
        return json({ error: "Owner purge lease identity required." }, 400);
      }
      const leaseReceipt = await this.ctx.storage.get<OwnerFenceLeaseReceipt>(
        ownerFenceLeaseReceiptKey(leaseId),
      );
      const callbackIdentity = { ownerId, ownerGeneration, turnId };
      const receiptMatches = Boolean(
        leaseReceipt &&
          this.ownerFenceReceiptMatches(
            leaseReceipt,
            callbackIdentity,
            leaseId,
          ),
      );
      if (leaseReceipt && !receiptMatches) {
        return json({ error: "Owner purge lease identity is stale." }, 409);
      }
      const matchesExactLease = (candidate: OwnerFencedTurn): boolean =>
        candidate.turnId === turnId &&
        candidate.ownerId === ownerId &&
        candidate.ownerGeneration === ownerGeneration &&
        candidate.ownerPurgeLeaseId === leaseId;
      const [current, localLease, queuedTurn] = await Promise.all([
        this.ctx.storage.get<ChatTurnRequest>("turn"),
        this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY),
        this.ctx.storage.get<ChatTurnRequest>(`queued:${turnId}`),
      ]);
      const ownerFencedAppend = this.ownerFencedAppends.get(leaseId);
      // A durable old receipt authorizes retiring only that exact old lease;
      // it never authorizes touching an ABA successor that reused the turn id.
      const hasAbaSuccessor = [
        current,
        localLease,
        queuedTurn,
        ownerFencedAppend?.lease,
      ].some(
        (candidate) =>
          candidate?.turnId === turnId && !matchesExactLease(candidate),
      );
      if (hasAbaSuccessor && receiptMatches && leaseReceipt) {
        if (
          !(await this.retireOwnerFenceLeaseReceipt(leaseReceipt, generation))
        ) {
          return json(
            { error: "Owner purge lease retirement is pending." },
            409,
          );
        }
        return json({
          canceled: false,
          reason: "stale_owner_purge_identity",
          turnId,
          unregistered: true,
        });
      }
      if (hasAbaSuccessor) {
        return json({ error: "Owner purge lease identity is stale." }, 409);
      }
      const currentMatches = Boolean(current && matchesExactLease(current));
      const localMatches = Boolean(localLease && matchesExactLease(localLease));
      const queuedMatches = Boolean(
        queuedTurn && matchesExactLease(queuedTurn),
      );
      const appendMatches = Boolean(
        ownerFencedAppend && matchesExactLease(ownerFencedAppend.lease),
      );

      if (
        receiptMatches &&
        leaseReceipt &&
        !currentMatches &&
        !localMatches &&
        !queuedMatches &&
        !appendMatches
      ) {
        // register may commit remotely before the caller persists its domain
        // row. The receipt is the exact local recovery identity for that gap.
        if (
          !(await this.retireOwnerFenceLeaseReceipt(leaseReceipt, generation))
        ) {
          return json(
            { error: "Owner purge lease retirement is pending." },
            409,
          );
        }
        return json({
          canceled: true,
          turnId,
          unregistered: true,
          orphan: true,
        });
      }

      if (localMatches && localLease) {
        try {
          await this.cancelLocalTurn(localLease, false);
        } catch {
          return json({ error: "Owner local turn is still unwinding." }, 409);
        }
        const retained =
          await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
        if (
          retained?.turnId === turnId &&
          retained.leaseToken === localLease.leaseToken
        ) {
          return json(
            {
              error:
                "Waiting for the desktop provider to acknowledge cancellation.",
              retryAfterMs: 1_000,
            },
            409,
          );
        }
      }
      const completedLocal = await this.ctx.storage.get<LocalTurnFinishReceipt>(
        localTurnReceiptKey(turnId),
      );
      if (
        completedLocal?.turnId === turnId &&
        completedLocal.ownerGeneration === ownerGeneration &&
        completedLocal.externallyCanceled
      ) {
        if (
          !(await this.retireOwnerFenceLeaseByIdentity(
            callbackIdentity,
            leaseId,
            generation,
          ))
        ) {
          return json(
            { error: "Owner purge lease retirement is pending." },
            409,
          );
        }
        return json({
          canceled: true,
          turnId,
          unregistered: true,
          local: true,
        });
      }
      if (appendMatches && ownerFencedAppend) {
        // Voice writes have no provider to abort, but their generation-fenced
        // R2/SQLite work must finish and drop its owner lease before purge can
        // report quiescence.
        await ownerFencedAppend.settled;
        if (
          !(await this.retireOwnerFenceLeaseByIdentity(
            callbackIdentity,
            leaseId,
            generation,
          ))
        ) {
          return json(
            { error: "Owner purge lease retirement is pending." },
            409,
          );
        }
        return json({
          canceled: true,
          turnId,
          unregistered: true,
          voice: true,
        });
      }
      if (queuedMatches && queuedTurn) {
        if (!(await this.unregisterOwnerTurn(queuedTurn))) {
          return json(
            { error: "Owner purge lease retirement is pending." },
            409,
          );
        }
        await this.ctx.storage.delete(`queued:${turnId}`);
        // A queued turn owns no provider or callback yet; deleting its exact
        // durable key and lease is already quiescent.
        if (!currentMatches) {
          return json({ canceled: true, turnId, unregistered: true });
        }
      }

      if (currentMatches) {
        await this.ctx.storage.put("terminal", true);
        this.currentTurnCancellation?.abort();
        this.currentAgent?.abort();
      }
      const execution = currentMatches
        ? this.turnExecutions.get(turnId)
        : undefined;
      if (execution) {
        try {
          // The durable terminal bit fences callbacks; interrupting the Effect
          // supervisor also closes the local admission latch and boundedly
          // joins any promise-native setup/provider/tool work. Without this,
          // an owner purge during pre-Agent setup could return 409 after merely
          // calling abort() on no Agent at all, then let setup keep mutating the
          // conversation until a later assertion happened to notice.
          await execution.interrupt(
            new Error("Owner cloud activity is being purged."),
          );
        } catch {
          return json({ error: "Owner turn is still unwinding." }, 409);
        }
      }
      if (this.activeTurnId === turnId) {
        return json({ error: "Owner turn is still unwinding." }, 409);
      }
      if (!execution) {
        const key = `ownerPurgeCancelAt:${leaseId}`;
        const startedAt =
          (await this.ctx.storage.get<number>(key)) ?? Date.now();
        await this.ctx.storage.put(key, startedAt);
        if (Date.now() - startedAt < OWNER_PURGE_STALE_LEASE_GRACE_MS) {
          return json({ error: "Reconciling stale owner turn lease." }, 409);
        }
        await this.ctx.storage.delete(key);
      }
      if (
        !(await this.retireOwnerFenceLeaseByIdentity(
          callbackIdentity,
          leaseId,
          generation,
        ))
      ) {
        return json({ error: "Owner purge lease retirement is pending." }, 409);
      }
      return json({ canceled: true, turnId, unregistered: true });
    }
    if (url.pathname === "/cancel") {
      const cancellation = parseExactTurnCancellationRequest(
        await request.json().catch(() => null),
      );
      if (!cancellation) {
        // Legacy conversation-wide cancellation is intentionally retired. It
        // cannot prove which turn it owns and must never stop a newer one.
        return json(
          { canceled: false, reason: "exact_turn_identity_required" },
          400,
        );
      }
      return await this.cancelExactChatTurn(cancellation);
    }
    if (url.pathname !== "/turn") return json({ error: "Not found." }, 404);
    const turn = (await request.json()) as ChatTurnRequest;
    const ownerGeneration = turn.ownerGeneration?.trim();
    if (!ownerGeneration || !/^\S{1,512}$/.test(ownerGeneration)) {
      return json({ error: "ownerGeneration required" }, 400);
    }
    turn.ownerGeneration = ownerGeneration;
    if (turn.agentThreadControl !== undefined) {
      const control = normalizeCloudAgentControlReceipt(
        turn.agentThreadControl,
      );
      if (!control || turn.source !== "agent-thread") {
        return json({ error: "Invalid cloud agent control receipt." }, 400);
      }
      turn.agentThreadControl = control;
    }
    // These fields are issued only by this DO. A caller cannot choose queue
    // order or replay an owner-purge lease from a previous admission.
    delete turn.queuedAt;
    delete turn.ownerPurgeGeneration;
    delete turn.ownerPurgeLeaseId;
    const admissionFingerprint = await sha256Hex(
      chatTurnFingerprintSource(turn),
    );
    return await this.withTurnAdmissionLock(async () => {
      const [receipt, queued, current] = await Promise.all([
        this.ctx.storage.get<ChatTurnAdmissionReceipt>(
          chatTurnAdmissionKey(turn.turnId),
        ),
        this.ctx.storage.get<ChatTurnRequest>(`queued:${turn.turnId}`),
        this.ctx.storage.get<ChatTurnRequest>("turn"),
      ]);
      let admissionIntent: ChatTurnAdmissionReceipt | undefined;
      if (receipt) {
        if (receipt.fingerprint !== admissionFingerprint) {
          return json(
            {
              code: "idempotency_conflict",
              message: "That turn id was already used for a different turn.",
            },
            409,
          );
        }
        if (isLegacyAcceptedChatTurnReceipt(receipt)) {
          return json({ accepted: true, replayed: true }, 202);
        }
        if (
          !isDurableChatTurnAdmissionIntent(receipt) ||
          receipt.ownerId !== turn.ownerId ||
          receipt.ownerGeneration !== turn.ownerGeneration ||
          receipt.turnId !== turn.turnId
        ) {
          return json(
            {
              code: "idempotency_conflict",
              message: "That turn id has malformed admission authority.",
            },
            409,
          );
        }
        if (receipt.phase === "accepted") {
          return json({ accepted: true, replayed: true }, 202);
        }
        // The intent is keyed only by turn id, so even an owner-generation
        // ABA retry reaches this exact identity before it can derive another
        // generation-scoped run slot or mint a second owner-fence lease.
        turn.ownerPurgeLeaseId = receipt.leaseId;
        turn.queuedAt = receipt.queuedAt;
        admissionIntent = receipt;
      }

      // Rolling-deploy compatibility: turns accepted before the admission
      // receipt existed are still classified from their exact durable request.
      // Check both sides of the queued -> current swap because a crash may
      // leave the same turn visible in both records.
      const legacyMatches = [queued, current].filter(
        (candidate): candidate is ChatTurnRequest =>
          candidate?.turnId === turn.turnId,
      );
      if (!admissionIntent && legacyMatches.length > 0) {
        const legacyFingerprints = await Promise.all(
          legacyMatches.map((candidate) =>
            sha256Hex(chatTurnFingerprintSource(candidate)),
          ),
        );
        if (
          legacyFingerprints.some(
            (fingerprint) => fingerprint !== admissionFingerprint,
          )
        ) {
          return json(
            {
              code: "idempotency_conflict",
              message: "That turn id was already used for a different turn.",
            },
            409,
          );
        }
        await this.ctx.storage.put(chatTurnAdmissionKey(turn.turnId), {
          fingerprint: admissionFingerprint,
          acceptedAt: legacyMatches[0]?.queuedAt ?? Date.now(),
        } satisfies ChatTurnAdmissionReceipt);
        return json({ accepted: true, replayed: true }, 202);
      }

      if (!admissionIntent) {
        const now = Date.now();
        const leaseId = crypto.randomUUID();
        turn.queuedAt = now;
        turn.ownerPurgeLeaseId = leaseId;
        admissionIntent = {
          schemaVersion: 1,
          fingerprint: admissionFingerprint,
          ownerId: turn.ownerId,
          ownerGeneration: turn.ownerGeneration,
          turnId: turn.turnId,
          leaseId,
          phase: "registering",
          queuedAt: now,
          createdAt: now,
          updatedAt: now,
        };
        // Persist the full request/owner/lease binding before the external
        // register boundary. A crash at any later prequeue point can only
        // resume this intent; changed payload or generation is a conflict.
        await this.ctx.storage.put(
          chatTurnAdmissionKey(turn.turnId),
          admissionIntent,
        );
      }

      try {
        turn.ownerPurgeGeneration = await this.registerOwnerTurn(
          turn,
          false,
          admissionFingerprint,
        );
        await this.assertOwnerTurn(turn);
      } catch (error) {
        if (error instanceof OwnerFenceLeaseConflictError) {
          return json(
            {
              code: "idempotency_conflict",
              message: "That turn id was already used for a different turn.",
            },
            409,
          );
        }
        if (error instanceof OwnerFenceRegistrationUncertainError) {
          return json(
            {
              code: "owner_fence_registration_uncertain",
              message:
                "Starting that turn is still being reconciled. Try again.",
            },
            503,
          );
        }
        await this.unregisterOwnerTurn(turn);
        if (error instanceof OwnerPurgeFenceError) {
          return json({ error: "Owner cloud activity is being purged." }, 409);
        }
        throw error;
      }

      // Accept immediately and run in the background. The exact request
      // receipt, queued turn, and owner generation commit together before the
      // 202, so a lost response/restart can replay without registering a new
      // owner fence or overwriting the original lease/payload.
      let heldForLocalTurn = false;
      let editConflict = false;
      await this.ctx.blockConcurrencyWhile(async () => {
        const editLock = await this.activeConversationEditLock();
        if (editLock) {
          editConflict = true;
          return;
        }
        // Owner-purge cancellation marks the durable lease receipt retiring in
        // this same DO. Recheck inside the admission critical section so a
        // register/assert winner cannot persist after its orphan was retired.
        await this.assertOwnerFenceLeaseReceiptActive(turn);
        if (turn.ownerPurgeLeaseId !== admissionIntent!.leaseId) {
          throw new OwnerPurgeFenceError();
        }
        this.ownerGeneration = turn.ownerGeneration;
        await this.ctx.storage.put({
          [`queued:${turn.turnId}`]: turn,
          [chatTurnAdmissionKey(turn.turnId)]: {
            ...admissionIntent,
            phase: "accepted",
            acceptedAt: turn.queuedAt!,
            updatedAt: Date.now(),
          } satisfies ChatTurnAdmissionReceipt,
          ownerDataGeneration: turn.ownerGeneration,
        });
        const localLease =
          await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
        heldForLocalTurn = localLease !== undefined;
        if (localLease) {
          const retirementAt = localTurnRetirementDeadline(localLease);
          const alarmAt = await this.ctx.storage.getAlarm();
          if (alarmAt === null || alarmAt > retirementAt) {
            await this.ctx.storage.setAlarm(retirementAt);
          }
        } else if ((await this.ctx.storage.getAlarm()) === null) {
          await this.ctx.storage.setAlarm(
            Date.now() + Math.max(1_000, turn.watchdogMs ?? CHAT_WATCHDOG_MS),
          );
        }
      });
      if (editConflict) {
        await this.unregisterOwnerTurn(turn);
        return json(
          {
            code: "conversation_edit_in_progress",
            message: "This conversation is being edited. Try again shortly.",
            retryAfterMs: 1_000,
          },
          409,
        );
      }
      if (!heldForLocalTurn) this.enqueue(turn);
      return json({ accepted: true, replayed: false }, 202);
    });
  }

  private async handleOwnerTransfer(request: Request): Promise<Response> {
    const body = parseOwnerTransferRequest(
      await request.json().catch(() => null),
    );
    if (!body) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    if (this.ownerTransferWork) {
      if (
        this.ownerTransferRequest?.fromOwnerId !== body.fromOwnerId ||
        this.ownerTransferRequest?.toOwnerId !== body.toOwnerId ||
        this.ownerTransferRequest?.migrationId !== body.migrationId ||
        this.ownerTransferRequest?.stage !== body.stage ||
        this.ownerTransferRequest?.planRevision !== body.planRevision ||
        this.ownerTransferRequest?.fromOwnerGeneration !==
          body.fromOwnerGeneration ||
        this.ownerTransferRequest?.toOwnerGeneration !== body.toOwnerGeneration
      ) {
        return json(
          {
            code: "owner_transfer_conflict",
            message: "A different ownership update is already in progress.",
          },
          409,
        );
      }
      return await this.ownerTransferWork;
    }
    this.ownerTransferRequest = body;
    const work = this.runOwnerTransfer(body).finally(() => {
      if (this.ownerTransferWork === work) {
        this.ownerTransferWork = null;
        this.ownerTransferRequest = null;
      }
    });
    this.ownerTransferWork = work;
    return await work;
  }

  private async runOwnerTransfer(
    body: OwnerTransferRequest,
  ): Promise<Response> {
    const admission = await this.ctx.blockConcurrencyWhile(async () => {
      const [pending, editLock] = await Promise.all([
        this.ctx.storage.get<OwnerTransferRequest>(OWNER_TRANSFER_KEY),
        this.ctx.storage.get<ConversationEditLock>(CONVERSATION_EDIT_LOCK_KEY),
      ]);
      if (editLock && editLock.expiresAt > Date.now()) {
        return {
          response: json(
            {
              code: "conversation_edit_in_progress",
              message: "A conversation fork or rewind is still in progress.",
              retryAfterMs: Math.min(
                5_000,
                Math.max(250, editLock.expiresAt - Date.now()),
              ),
            },
            409,
          ),
          pending: false,
        };
      }
      if (
        pending &&
        (pending.fromOwnerId !== body.fromOwnerId ||
          pending.toOwnerId !== body.toOwnerId ||
          pending.migrationId !== body.migrationId ||
          pending.stage !== body.stage ||
          pending.planRevision !== body.planRevision ||
          pending.fromOwnerGeneration !== body.fromOwnerGeneration ||
          pending.toOwnerGeneration !== body.toOwnerGeneration)
      ) {
        return {
          response: json(
            {
              code: "owner_transfer_conflict",
              message: "A different ownership update is already in progress.",
            },
            409,
          ),
          pending: false,
        };
      }
      const currentOwnerId = this.journal.ownerId();
      if (currentOwnerId === body.toOwnerId) {
        this.ownerGeneration = body.toOwnerGeneration;
        this.ownerLookup = null;
        await this.ctx.storage.put(
          "ownerDataGeneration",
          body.toOwnerGeneration,
        );
        await this.ctx.storage.delete(OWNER_TRANSFER_KEY);
        return {
          response: json({ transferred: true, replayed: true }),
          pending: false,
        };
      }
      if (currentOwnerId && currentOwnerId !== body.fromOwnerId) {
        return {
          response: json(
            {
              code: "owner_mismatch",
              message: "The conversation belongs to a different owner.",
            },
            409,
          ),
          pending: false,
        };
      }
      if (!pending) {
        const [turn, terminal, localLease, queued] = await Promise.all([
          this.ctx.storage.get<ChatTurnRequest>("turn"),
          this.ctx.storage.get<boolean>("terminal"),
          this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY),
          this.ctx.storage.list({ prefix: "queued:", limit: 1 }),
        ]);
        if (
          retainedTurnBlocksOwnerTransfer(turn !== undefined, terminal) ||
          localLease ||
          queued.size > 0 ||
          this.live ||
          this.activeTurnId ||
          this.currentAgent ||
          this.currentTurnCancellation ||
          this.journal.inboxSize().rows > 0
        ) {
          return {
            response: json(
              {
                code: "turn_in_progress",
                message: "A conversation turn is still running.",
                retryAfterMs: 5_000,
              },
              409,
            ),
            pending: false,
          };
        }
        await this.ctx.storage.put(OWNER_TRANSFER_KEY, body);
        this.hub.closeAll(CLOSE_UNAUTHENTICATED);
      } else if (body.leaseGeneration >= pending.leaseGeneration) {
        // The migration watchdog may hand the same durable operation to a new
        // lease generation. The coordinator rejects stale/same-generation
        // impostors before forwarding, so persist the current receipt here.
        await this.ctx.storage.put(OWNER_TRANSFER_KEY, body);
      }
      return { response: null, pending: true };
    });
    if (admission.response) return admission.response;

    const conversationId = this.conversationId();
    if (!conversationId) {
      await this.ctx.storage.delete(OWNER_TRANSFER_KEY);
      return json(
        { code: "conversation_missing", message: "Conversation not found." },
        404,
      );
    }
    const [fromPrefix, toPrefix] = await Promise.all([
      conversationArchivePrefix(body.fromOwnerId, conversationId),
      conversationArchivePrefix(body.toOwnerId, conversationId),
    ]);
    let archive: { complete: boolean; pending: number };
    try {
      archive = await this.archive.transferOwner(
        fromPrefix,
        toPrefix,
        body.toOwnerId,
      );
    } catch (error) {
      if (error instanceof OwnerTransferArchiveConflictError) {
        return json(
          { code: "owner_transfer_conflict", message: error.message },
          409,
        );
      }
      throw error;
    }
    if (!archive.complete) {
      return json({ transferred: false, pendingObjects: archive.pending }, 202);
    }
    if (!this.journal.transferOwner(body.fromOwnerId, body.toOwnerId)) {
      return json(
        {
          code: "owner_mismatch",
          message: "The conversation belongs to a different owner.",
        },
        409,
      );
    }
    this.ownerGeneration = body.toOwnerGeneration;
    this.ownerLookup = null;
    await this.ctx.storage.put("ownerDataGeneration", body.toOwnerGeneration);
    await this.ctx.storage.delete(OWNER_TRANSFER_KEY);
    log("info", "conversation_owner_transferred", {
      conversationId,
      fromOwnerRef: fromPrefix.split("/")[1]?.slice(0, 16),
      toOwnerRef: toPrefix.split("/")[1]?.slice(0, 16),
    });
    return json({ transferred: true, replayed: false });
  }

  // The in-flight loop, exposed so /cancel and the alarm can actually stop
  // token burn instead of only marking the turn terminal.
  private currentAgent?: Agent;
  // Aborts the live turn's retry ladder alongside `currentAgent.abort()`:
  // classification reads it to refuse retries after a cancel/timeout, and an
  // abort during retry backoff wakes the sleep instead of waiting it out.
  private currentTurnCancellation?: TurnRetryCancellation;

  private async finishPreCanceledTurn(
    turn: ChatTurnRequest,
    cancellation: ExactTurnCancellation,
  ): Promise<Response> {
    try {
      const now = Date.now();
      await this.ctx.storage.put({
        turn,
        terminal: true,
        terminalDelivered: false,
        terminalOwed: {
          kind: "canceled",
          message: TERMINAL_NOTICE.canceled,
        } satisfies OwedTerminal,
        alarmAttempts: 0,
      });
      await this.ctx.storage.delete(`queued:${turn.turnId}`);
      this.convexBase = turn.convexCallbackBase;
      this.ownerGeneration = turn.ownerGeneration;
      this.bindConversation(turn);
      this.journal.upsertTurn({
        turnId: turn.turnId,
        sessionId: turn.sessionId,
        ownerId: turn.ownerId,
        lane: turn.lane,
        source: turn.source,
        clientMsgId: turn.clientMsgId,
        state: "running",
        now,
      });
      const prompt = this.journal.appendMessage({
        turnId: turn.turnId,
        writer: "orchestrator",
        writerKey: `turn:${turn.turnId}:prompt`,
        role: "user",
        hidden: turn.hiddenMessage === true,
        clientMsgId: turn.clientMsgId,
        createdAt: now,
        message: {
          role: "user",
          content: [{ type: "text", text: turn.prompt }],
          timestamp: now,
          ...(turn.source ? { source: turn.source } : {}),
        } as AgentMessage,
      });
      this.journal.setTurnSpan(turn.turnId, prompt.seq);
      this.publish(prompt.record);
      this.recordTerminal(turn, "canceled", TERMINAL_NOTICE.canceled);
      try {
        await this.event(
          turn,
          "auto",
          "canceled",
          { message: TERMINAL_NOTICE.canceled },
          true,
        );
        await this.ctx.storage.put("terminalDelivered", true);
      } catch {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      }
      await this.afterTerminal(turn);
      if (!(await this.acknowledgeExactTurnCancellation(cancellation))) {
        throw new Error("Pre-admission cancellation acknowledgement was lost.");
      }
      log("info", "chat_turn_pre_admission_canceled", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
      });
      return json({ ok: false, canceled: true, preAdmission: true });
    } finally {
      await this.unregisterOwnerTurn(turn);
    }
  }

  private async runTurn(
    turn: ChatTurnRequest,
    turnCancellation: TurnRetryCancellation,
    executionSignal: AbortSignal,
  ): Promise<Response> {
    const localLease =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (localLease) {
      const retirementAt = localTurnRetirementDeadline(localLease);
      if (retirementAt <= Date.now()) {
        if (localLease.cancelRequested) {
          await this.cancelLocalTurn(localLease, true);
        } else {
          await this.expireLocalLease(localLease, false);
        }
      } else {
        await this.armLocalLeaseAlarm(retirementAt);
        log("info", "chat_turn_waiting_for_local_turn", {
          turnId: turn.turnId,
          localTurnId: localLease.turnId,
          conversationId: turn.conversationId,
        });
        return json({ ok: false, queued: true }, 202);
      }
    }
    // Queued turns survive DO eviction and may predate the worker generation
    // that introduced owner leases. Acquire (or re-acquire) before touching
    // the journal; a blocked owner drops the queued turn without callbacks,
    // because the reset/account purge is about to delete its Convex row too.
    try {
      turn.ownerPurgeGeneration = await this.registerOwnerTurn(turn);
      await this.assertOwnerTurn(turn);
      if (turn.agentThreadControl) {
        await this.rememberCloudAgentControlReceipt(turn.agentThreadControl);
      }
    } catch (error) {
      await this.ctx.storage.delete(`queued:${turn.turnId}`);
      await this.unregisterOwnerTurn(turn);
      if (error instanceof OwnerPurgeFenceError) {
        log("info", "chat_turn_dropped_owner_purge", {
          turnId: turn.turnId,
          ownerId: turn.ownerId,
        });
        return json({ ok: false, purging: true });
      }
      throw error;
    }
    // A dispatch that raced the deletion of its own conversation. Running it
    // would rebuild the transcript the purge just destroyed, in an object no
    // later purge will visit.
    if (this.purged()) {
      await this.ctx.storage.delete(`queued:${turn.turnId}`);
      await this.unregisterOwnerTurn(turn);
      log("info", "chat_turn_dropped_deleted", { turnId: turn.turnId });
      return json({ ok: false, deleted: true });
    }
    // Exactly-once, defensively. The queued key below closes the restart path;
    // this closes the remaining one — a duplicated dispatch of the same
    // turnId, which would otherwise replay the whole loop and burn a second
    // turn's tokens against one accepted turn. The dequeue happens here too:
    // a turn nothing will ever run again must not be re-enqueued by every
    // future cold start.
    if (this.journal.turnState(turn.turnId)?.state === "terminal") {
      log("info", "chat_turn_duplicate_ignored", { turnId: turn.turnId });
      await this.ctx.storage.delete(`queued:${turn.turnId}`);
      await this.unregisterOwnerTurn(turn);
      return json({ ok: false, duplicate: true });
    }
    // A prior turn that never delivered its terminal event (isolate restart
    // mid-run) would otherwise stay "running" in Convex forever.
    const stale = await this.ctx.storage.get<ChatTurnRequest>("turn");
    if (
      stale &&
      stale.turnId !== turn.turnId &&
      !(await this.ctx.storage.get<boolean>("terminalDelivered"))
    ) {
      await this.event(
        stale,
        "auto",
        "failed",
        { message: "Stella was interrupted answering this. Try again." },
        true,
      ).catch(() => undefined);
      // Additive: the same terminal fact, in the transcript the clients read.
      this.recordTerminal(
        stale,
        "failed",
        "Stella was interrupted answering this. Try again.",
      );
      // The interrupted turn's rows are real content and this is the last
      // moment anything knows they belong to a finished turn. Only the excerpt
      // is built here: the flush, the drain and rollover all belong to a turn
      // BOUNDARY, and this one is about to be reopened by the turn below.
      this.recordExcerpt(stale.turnId);
    }
    // Claim first, dequeue second, and never the other way round. Between the
    // two writes is the only moment a restart can see this turn twice; before
    // the swap it saw it not at all, which is unrecoverable — an accepted turn
    // in neither durable record is a user message that never reaches the
    // transcript and a Convex row stuck "running" forever. Seeing it twice
    // costs a re-run of a turn that has produced nothing yet.
    //
    // The stale-turn recovery above deliberately sits outside the window: it
    // blocks on a Convex round trip of up to 30 s, and it needs the previous
    // turn to still be under `turn` in order to recover it at all.
    let preCanceled: ExactTurnCancellation | null = null;
    await this.ctx.blockConcurrencyWhile(async () => {
      // This check and the queued -> current swap share the same critical
      // section as `/cancel`'s durable tombstone. Either Stop wins and this turn
      // never launches, or the turn becomes the exact current owner Stop joins.
      preCanceled = await this.exactTurnCancellations.matching({
        turnId: turn.turnId,
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
      });
      if (preCanceled) return;
      await this.ctx.storage.put({
        turn,
        terminal: false,
        terminalDelivered: false,
        terminalOwed: null,
        alarmAttempts: 0,
      });
      await this.ctx.storage.delete(`queued:${turn.turnId}`);
    });
    if (preCanceled) {
      return await this.finishPreCanceledTurn(turn, preCanceled);
    }
    this.convexBase = turn.convexCallbackBase;
    this.ownerGeneration = turn.ownerGeneration;
    this.journal.upsertTurn({
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      ownerId: turn.ownerId,
      lane: turn.lane,
      source: turn.source,
      clientMsgId: turn.clientMsgId,
      state: "running",
      now: Date.now(),
    });
    await this.ctx.storage.setAlarm(
      Date.now() + Math.max(1_000, turn.watchdogMs ?? CHAT_WATCHDOG_MS),
    );
    const started = performance.now();
    log("info", "chat_turn_started", {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      sessionId: turn.sessionId,
    });
    // Claimed inside the try so the matching `finally` always releases it: a
    // turn id stuck here would stop the watchdog from ever finalizing a turn.
    const assertExactTurnActive = async (): Promise<void> => {
      assertTurnExecutionActive(turnCancellation, executionSignal);
      const [stored, terminal] = await Promise.all([
        this.ctx.storage.get<ChatTurnRequest>("turn"),
        this.ctx.storage.get<boolean>("terminal"),
      ]);
      assertTurnExecutionActive(turnCancellation, executionSignal);
      if (
        terminal ||
        stored?.turnId !== turn.turnId ||
        stored.ownerId !== turn.ownerId ||
        stored.ownerGeneration !== turn.ownerGeneration
      ) {
        throw new Error("The chat turn is no longer active.");
      }
    };
    this.currentTurnCancellation = turnCancellation;
    try {
      await this.assertOwnerTurn(turn);
      await assertExactTurnActive();
      this.activeTurnId = turn.turnId;
      // Binding is safe from a turn dispatch and only from a turn dispatch:
      // Convex resolved the conversation and checked ownership before it minted
      // the turn token. A socket connector is never trusted this way — see
      // lookupOwner().
      this.bindConversation(turn);
      await this.event(turn, "auto", "started", {}, false, executionSignal);
      await assertExactTurnActive();

      const base = turn.convexCallbackBase.replace(/\/+$/, "");

      // Repair BEFORE the prompt row exists. An eviction, a cancel or a
      // watchdog abort can leave the tail as an assistant message with
      // unanswered tool calls, which the provider rejects on the next
      // request — a permanently bricked conversation. Closing it after the
      // prompt row would put a user message between the call and its result,
      // which is exactly as poisonous.
      const now = Date.now();
      for (const repaired of this.journal.repairTail(now)) {
        this.publish(repaired.record);
      }
      // Foreign rows that arrived while the previous turn was running land at
      // this clean boundary rather than splicing into a tool-call pair.
      this.drainInbox();

      const promptRow = this.journal.appendMessage({
        turnId: turn.turnId,
        writer: "orchestrator",
        writerKey: `turn:${turn.turnId}:prompt`,
        role: "user",
        hidden: turn.hiddenMessage === true,
        clientMsgId: turn.clientMsgId,
        createdAt: now,
        message: {
          role: "user",
          content: [{ type: "text", text: turn.prompt }],
          timestamp: now,
          ...(turn.source ? { source: turn.source } : {}),
        } as AgentMessage,
      });
      this.journal.setTurnSpan(turn.turnId, promptRow.seq);
      this.publish(promptRow.record);

      const startedRow = this.journal.appendTurn({
        turnId: turn.turnId,
        writer: "orchestrator",
        writerKey: `turn:${turn.turnId}:phase:started`,
        phase: "started",
        lane: turn.lane ?? "chat",
        source: turn.source,
        promptSeq: promptRow.seq,
        createdAt: now,
      });
      this.journal.setTurnSpan(turn.turnId, startedRow.seq);
      this.publish(startedRow.record);
      this.live = {
        turnId: turn.turnId,
        streamId: null,
        partialText: "",
        tools: [],
      };

      // The window is chosen from resident rows only, and rollover guarantees
      // the resident floor sits below the last turn's context start — so a
      // normal turn never touches R2.
      const selection = this.journal.selectWindow(
        turn.turnId,
        CLOUD_HISTORY_TOKEN_BUDGET,
      );
      const history = await this.hydrateWindow(selection);
      await assertExactTurnActive();
      this.journal.setTurnContext(
        turn.turnId,
        selection.startSeq,
        selection.endSeq,
      );
      void this.index
        .flush({ activity: "running", updatedAt: now })
        .catch(() => undefined);

      const agentHome = new AgentHome(
        this.env.AGENT_HOME,
        turn.ownerId,
        turn.ownerGeneration,
        {
          base,
          serviceSecret: this.env.BUILDER_SERVICE_SECRET,
          ownerGeneration: turn.ownerGeneration,
          // The orchestrator turn holds this activity lease until its terminal
          // finally block. Reassert it immediately before each R2 PUT so reset
          // cannot finish its owner-prefix sweep ahead of an in-flight writer.
          assertExternalWrite: async () => {
            await this.assertOwnerTurn(turn);
            await assertExactTurnActive();
          },
        },
      );
      // Resolve the owner's control-plane preference before any Agent Home
      // content. Disabled means no resident-memory/personality read and no
      // memory tools; unavailable or corrupt authoritative context blocks the
      // turn instead of producing a normal-looking memoryless reply.
      const memoryPreference = await requireCloudContext(
        "agent_home_memory",
        agentHome.getMemoryPreference(),
      );
      const memoryEnabled = memoryPreference.memoryEnabled;
      const [
        memoryDocuments,
        personalityOverride,
        canonicalPrompts,
        locale,
        attachmentImages,
        skillCatalog,
      ] = await Promise.all([
        // prettier-ignore
        memoryEnabled
          ? requireCloudContext(
              "agent_home_memory",
              agentHome.readDocuments(),
            )
          : Promise.resolve([]),
        memoryEnabled
          ? requireCloudContext(
              "agent_home_personality",
              agentHome.readPersonality(),
            )
          : Promise.resolve(null),
        requireCloudContext(
          "canonical_prompt",
          this.loadCanonicalPromptsForTurn(base, executionSignal),
        ),
        this.resolveTurnLocale(turn, () =>
          assertTurnExecutionActive(turnCancellation, executionSignal),
        ),
        this.loadChatAttachmentImages(base, turn, executionSignal),
        requireCloudContext(
          "skill_catalog",
          agentHome.loadSkillCatalog("orchestrator"),
        ),
      ]);
      log("info", "cloud_memory_preference_loaded", {
        turnId: turn.turnId,
        ownerGeneration: memoryPreference.ownerGeneration,
        memoryEnabled,
        revision: memoryPreference.revision,
      });
      const assertMemoryPreferenceUnchanged = async (): Promise<void> => {
        const current = await requireCloudContext(
          "agent_home_memory",
          agentHome.getMemoryPreference(),
        );
        if (
          current.ownerGeneration !== memoryPreference.ownerGeneration ||
          current.memoryEnabled !== memoryPreference.memoryEnabled ||
          current.revision !== memoryPreference.revision
        ) {
          throw new CloudContextBlockedError(
            "agent_home_memory",
            "preference_changed",
          );
        }
      };
      // Preference changes invalidate this turn before its policy-bearing
      // system prompt can reach a provider. Retry starts a fresh turn with the
      // new preference; later physical retry attempts recheck below as well.
      await assertMemoryPreferenceUnchanged();

      // The watchdog (or /cancel) may have fired during the setup awaits
      // above, before currentAgent exists for abort() to reach — re-check so
      // an already-terminal turn never starts the loop at all.
      try {
        await assertExactTurnActive();
      } catch (error) {
        if (
          turnCancellation.aborted ||
          (await this.ctx.storage.get<boolean>("terminal"))
        ) {
          // The prompt row is already committed, so this turn has content
          // worth indexing even though the loop never ran. Returning without
          // this is how a canceled turn used to vanish from Recall permanently.
          await this.afterTerminal(turn);
          return json({ ok: false, canceled: true });
        }
        throw error;
      }

      const executionSelection =
        turn.execution ?? LEGACY_UNBOUND_CLOUD_EXECUTION;
      await assertExactTurnActive();
      const model = await createCloudRelayModel({
        siteUrl: base,
        turnToken: turn.turnToken,
        agentType: "orchestrator",
        execution: executionSelection,
        signal: executionSignal,
      });
      await assertExactTurnActive();
      // No await is allowed between this local latch and constructing the
      // Agent. The next async admission boundary repeats the same check.
      assertTurnExecutionActive(turnCancellation, executionSignal);
      const agent: Agent = new Agent({
        initialState: {
          systemPrompt: buildCloudSystemPrompt({
            canonicalBody: canonicalPrompts.orchestratorBody,
            // The user's synced personality wins; the canonical default is
            // what a fresh desktop install would inject.
            personalityBody:
              personalityOverride ?? canonicalPrompts.personalityBody,
            localeDirective: getResponseLanguageSystemPrompt(locale),
            residentSection: buildResidentMemorySection(memoryDocuments),
            skillSection: buildCloudSkillCatalogPrompt(skillCatalog),
            memoryEnabled,
          }),
          model,
          thinkingLevel: resolveCloudThinkingLevel(
            model,
            executionSelection.reasoningEffort,
          ),
          tools: this.createTools(turn, agentHome, skillCatalog, memoryEnabled),
          messages: history,
        },
        sessionId: turn.conversationId,
        getApiKey: () => turn.turnToken,
        toolExecution: "sequential",
        toolInactivityTimeoutMs: 60_000,
        // Re-prune and strip stale images before EVERY provider call, exactly
        // as the desktop loop does. The journal window selected above is the
        // turn's base; without this per-call guard a tool-heavy turn (web
        // results at ~20KB each) grows unchecked toward the model's declared
        // window with only the pre-turn budget as slack.
        transformContext: buildDefaultTransformContext({ model }),
        // The outer ladder below owns empty completions and physical request
        // attempts — the same division of labor as the desktop runtime
        // (`createRuntimeAgent`), which disables the loop's built-in
        // double-call for the same reason.
        degenerateResponseRetries: 0,
        providerRequestLimit: AGENT_RUN_MAX_ATTEMPTS,
      });

      // Incremental persistence: every produced message is committed as it is
      // produced. A DO eviction at minute four of a five-minute turn used to
      // discard everything the turn had done; now it loses at most the message
      // still streaming. This is only safe because repairTail() above closes
      // whatever tool calls such an eviction leaves open.
      //
      // The handler is synchronous on purpose. The Agent's event sink is
      // fire-and-forget — a returned promise is dropped — so an `await` here
      // would silently lose rows. SQLite in a DO is synchronous, which is what
      // makes that constraint costless.
      let producedIndex = 0;
      let streamId: string | null = null;
      let persistError: string | undefined;
      const unsubscribe = agent.subscribe((event: AgentEvent) => {
        // Agent.abort() can race one last provider callback. The subscriber is
        // synchronous, so this in-memory latch is the only check that can sit
        // directly in front of every journal append/broadcast without opening
        // another await-sized TOCTOU window.
        if (turnCancellation.aborted || executionSignal.aborted) return;
        try {
          this.onAgentEvent(turn, event, {
            nextIndex: () => producedIndex++,
            streamId: () => streamId,
            setStreamId: (value) => {
              streamId = value;
            },
          });
        } catch (error) {
          // A failed transcript write must fail the turn: the model's
          // in-memory history would otherwise diverge from what the user is
          // shown, and the next turn would read a history the user never saw.
          persistError ??= errorMessage(error);
          agent.abort();
        }
      });

      // The desktop runtime's transient ladder, verbatim: resume the same
      // in-memory context after a retryable provider/transport failure
      // instead of failing the whole turn on one blip. The Effect cancellation
      // latch is wired to the cancel/watchdog paths so an aborted turn classifies as
      // canceled (never retried) and a cancel during backoff wakes the sleep.
      const retryState = { attemptsUsed: 0, retriesUsed: 0 };
      this.currentAgent = agent;
      let execution: { finalText: string; errorMessage?: string };
      try {
        execution = await executeAgentRunWithRetry({
          state: retryState,
          isCanceled: () => turnCancellation.aborted,
          sleep: (milliseconds) => turnCancellation.sleep(milliseconds),
          execute: async (resume) => {
            await assertExactTurnActive();
            await assertMemoryPreferenceUnchanged();
            await assertExactTurnActive();
            // A conservative durable dispatch boundary: increment immediately
            // before entering the Agent/provider call. Context failures happen
            // above this line, so an unchanged counter proves zero dispatch.
            await this.noteDevAcceptanceProviderDispatch();
            // Stop cannot interleave between this synchronous latch and
            // Agent.prompt/continue entering _runLoop and creating its own
            // provider/tool controller.
            assertTurnExecutionActive(turnCancellation, executionSignal);
            if (resume) {
              await agent.continue();
            } else if (attachmentImages.length > 0) {
              await agent.prompt(
                withClock(turn.prompt, new Date()),
                attachmentImages,
              );
            } else {
              await agent.prompt(withClock(turn.prompt, new Date()));
            }
            const completion = getAgentCompletion(agent);
            return { ...completion, finalText: completion.finalText.trim() };
          },
          prepareResume: (reason, classification) => {
            const prepared = prepareTransientResumeTail(
              agent.state.messages,
              classification,
            );
            if (prepared) {
              log("info", "chat_turn_transient_retry", {
                turnId: turn.turnId,
                conversationId: turn.conversationId,
                category: classification.category,
                message: reason,
              });
            }
            return prepared;
          },
          onRetry: (info) => {
            log("info", "chat_turn_retry_scheduled", {
              turnId: turn.turnId,
              conversationId: turn.conversationId,
              category: info.category,
              retryNumber: info.retryNumber,
              nextAttempt: info.nextAttempt,
              delayMs: info.delayMs,
            });
          },
        });
      } finally {
        this.currentAgent = undefined;
      }
      unsubscribe();
      // Oversize-row promotion, the only work the sync handler defers.
      await this.background.catch(() => undefined);
      if (persistError) {
        throw new Error(`Persisting the reply failed: ${persistError}`);
      }

      if (await this.ctx.storage.get<boolean>("terminal")) {
        // Canceled or timed out mid-loop; the terminal event and its journal
        // record are already written by whichever path marked it terminal.
        // The post-terminal work is not: that path deliberately leaves it to
        // the loop, which is the only caller that knows the loop has stopped
        // and that a drain or a rollover is therefore safe.
        await this.afterTerminal(turn);
        return json({ ok: false, canceled: true });
      }

      // Everything the loop produced is already committed, row by row, above.
      const finalText = execution.finalText;
      if (execution.errorMessage) {
        throw new Error(execution.errorMessage);
      }
      const wallClockMs = Math.round(performance.now() - started);
      // `terminal` and what is owed, in ONE durable write BEFORE delivery —
      // the same ordering the cancel and failed paths use. The watchdog reads
      // `terminal` to decide whether a turn is still owed one, so writing it
      // after the Convex round trip left a window (widened by the retry
      // ladder, which pushes completions toward the deadline) where an alarm
      // firing mid-delivery declared a finished turn timed out, and clients
      // group on the last row per turn — so the user saw "timed out" over a
      // reply that had actually arrived.
      await this.ctx.storage.put({
        terminal: true,
        terminalOwed: {
          kind: "completed",
          message: "",
          payload: { text: finalText, wallClockMs },
        } satisfies OwedTerminal,
      });
      this.recordTerminal(turn, "completed", undefined, wallClockMs);
      try {
        await this.event(
          turn,
          "auto",
          "completed",
          { text: finalText, wallClockMs },
          true,
        );
        await this.ctx.storage.put("terminalDelivered", true);
      } catch {
        // Same pairing as the other terminal paths: the re-armed alarm
        // redelivers exactly what `terminalOwed` says is owed, reply text
        // included, instead of stranding a completed turn as "running".
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      }
      await this.afterTerminal(turn);
      // Keep the alarm alive while queued turns remain: it is the wake
      // guarantee that lets a restarted DO drain the durable queue. The read
      // and the delete are one step against `/turn`'s enqueue — otherwise a
      // turn accepted between them is left durable under `queued:` with the
      // alarm it was promised already deleted.
      await this.ctx.blockConcurrencyWhile(async () => {
        const queued = await this.ctx.storage.list({
          prefix: "queued:",
          limit: 1,
        });
        if (queued.size === 0) {
          if (await this.hasOwnerFenceLeaseRetirementDebt()) {
            const retryAt = Date.now() + 30_000;
            const alarmAt = await this.ctx.storage.getAlarm();
            if (alarmAt === null || alarmAt > retryAt) {
              await this.ctx.storage.setAlarm(retryAt);
            }
          } else {
            await this.ctx.storage.deleteAlarm();
          }
        }
      });
      log("info", "chat_turn_completed", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        wallClockMs: Math.round(performance.now() - started),
      });
      return json({ ok: true, text: finalText });
    } catch (error) {
      const message = errorMessage(error);
      const contextFailure = cloudContextFailure(error);
      const terminalNotice = contextFailure
        ? CLOUD_CONTEXT_NOTICE
        : TERMINAL_NOTICE.failed;
      const terminalPayload = contextFailure
        ? {
            message: terminalNotice,
            code: contextFailure.code,
            component: contextFailure.component,
          }
        : { message: terminalNotice };
      log("error", "chat_turn_failed", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        message,
      });
      if (contextFailure) {
        log("error", "cloud_context_blocked", {
          turnId: turn.turnId,
          conversationId: turn.conversationId,
          code: contextFailure.code,
          component: contextFailure.component,
          ...(contextFailure.repairSeq !== undefined
            ? { corruptSeq: contextFailure.repairSeq }
            : {}),
        });
      }
      if (!(await this.ctx.storage.get<boolean>("terminal"))) {
        // Same pairing as `/cancel`: the alarm retries what is owed, so what
        // is owed becomes durable in the same write that says a terminal was
        // reached at all.
        await this.ctx.storage.put({
          terminal: true,
          terminalOwed: {
            kind: "failed",
            message: terminalNotice,
            payload: terminalPayload,
          } satisfies OwedTerminal,
        });
        // The raw message is often a provider error blob or infrastructure
        // detail; it belongs in logs, never in the user's chat bubble — and
        // never in a frame either. `ref` in the socket's error frame is the
        // correlation key back to this log line.
        this.recordTerminal(turn, "failed", terminalNotice);
        try {
          await this.event(turn, "auto", "failed", terminalPayload, true);
          await this.ctx.storage.put("terminalDelivered", true);
        } catch {
          // Delivery failed; the re-armed alarm retries so the turn cannot
          // stay "running" forever.
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
        }
      }
      await this.observeDevAcceptanceContextFailure(contextFailure).catch(
        (probeError) => {
          log("error", "dev_acceptance_context_fault_repair_failed", {
            message: errorMessage(probeError),
          });
        },
      );
      await this.afterTerminal(turn);
      return json(
        contextFailure
          ? {
              error: "Cloud chat turn failed.",
              code: contextFailure.code,
              component: contextFailure.component,
            }
          : { error: "Cloud chat turn failed.", detail: message },
        502,
      );
    } finally {
      this.live = null;
      this.hub.endTurn(turn.turnId);
      if (this.activeTurnId === turn.turnId) this.activeTurnId = null;
      if (this.currentTurnCancellation === turnCancellation) {
        this.currentTurnCancellation = undefined;
      }
      await this.unregisterOwnerTurn(turn);
    }
  }

  /**
   * The canonical prompt snapshot, cached in durable storage and refreshed
   * by ETag at most every few minutes. A refresh failure may use only a
   * revalidated last-known-good cache; a cold/corrupt cache throws before the
   * relay model is constructed.
   */
  private async loadCanonicalPrompts(
    convexSiteBase: string,
    signal?: AbortSignal,
  ): Promise<CanonicalPromptSnapshot> {
    signal?.throwIfAborted();
    const cached = await this.ctx.storage.get<unknown>(
      CLOUD_PROMPT_SNAPSHOT_STORAGE_KEY,
    );
    signal?.throwIfAborted();
    const loaded = await refreshCanonicalPrompts(
      convexSiteBase,
      cached ?? null,
      Date.now(),
      signal,
    );
    signal?.throwIfAborted();
    if (
      loaded.disposition === "fresh" ||
      loaded.disposition === "cache_not_modified"
    ) {
      await this.ctx.storage.put(
        CLOUD_PROMPT_SNAPSHOT_STORAGE_KEY,
        loaded.snapshot,
      );
      signal?.throwIfAborted();
    }
    if (loaded.disposition === "cache_recovery") {
      log("error", "canonical_prompt_cache_recovery", {
        revision: loaded.snapshot.revision,
        refreshErrorCode: loaded.refreshErrorCode ?? "unknown",
      });
    }
    return loaded.snapshot;
  }

  /**
   * Hydrate the turn's attached drive images into image content blocks.
   * Turn-token scoped: the route only signs images the token's owner holds,
   * image-typed and size-capped. Failure of any piece degrades to a turn
   * without pixels — the prompt text still names the paths.
   */
  private async loadChatAttachmentImages(
    base: string,
    turn: ChatTurnRequest,
    signal?: AbortSignal,
  ): Promise<ImageContent[]> {
    const paths = (turn.attachments ?? []).slice(0, 4);
    if (paths.length === 0) return [];
    try {
      signal?.throwIfAborted();
      const response = await fetch(
        `${base.replace(/\/+$/, "")}/api/cloud/drive/attachments`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-stella-turn-token": turn.turnToken,
          },
          body: JSON.stringify({ turnId: turn.turnId, paths }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
            : AbortSignal.timeout(20_000),
        },
      );
      signal?.throwIfAborted();
      if (!response.ok) return [];
      const payload = (await response.json()) as {
        attachments?: Array<{ path: string; contentType: string; url: string }>;
      };
      const images: ImageContent[] = [];
      for (const entry of payload.attachments ?? []) {
        try {
          signal?.throwIfAborted();
          const bytes = await fetch(entry.url, {
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
              : AbortSignal.timeout(20_000),
          });
          signal?.throwIfAborted();
          if (!bytes.ok) continue;
          const content = new Uint8Array(await bytes.arrayBuffer());
          signal?.throwIfAborted();
          images.push({
            type: "image",
            data: base64FromBytes(content),
            mimeType: entry.contentType,
          });
        } catch {
          signal?.throwIfAborted();
          // One unreadable attachment must not cost the others.
        }
      }
      return images;
    } catch (error) {
      signal?.throwIfAborted();
      log("error", "chat_attachment_hydration_failed", {
        turnId: turn.turnId,
        message: errorMessage(error),
      });
      return [];
    }
  }

  /**
   * The conversation's reply-language locale: a turn that carries one
   * updates the stored value; turns without one (schedule fires,
   * agent-completion wakes) reuse it, so the language never flips back to
   * English mid-conversation.
   */
  private async resolveTurnLocale(
    turn: ChatTurnRequest,
    assertActive?: () => void,
  ): Promise<string | undefined> {
    assertActive?.();
    try {
      const carried = turn.locale?.trim();
      if (carried && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(carried)) {
        const stored = await this.ctx.storage.get<string>("locale");
        assertActive?.();
        if (stored !== carried) {
          assertActive?.();
          await this.ctx.storage.put("locale", carried);
          assertActive?.();
        }
        return carried;
      }
      const stored = await this.ctx.storage.get<string>("locale");
      assertActive?.();
      return stored;
    } catch {
      assertActive?.();
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Turn plumbing
  // ---------------------------------------------------------------------------

  private bindConversation(turn: ChatTurnRequest): void {
    this.journal.setConversationId(turn.conversationId);
    const meta = this.journal.meta();
    if (!meta.owner_id) {
      this.journal.bindOwner({
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        createdAt: turn.conversationCreatedAt ?? Date.now(),
        title: turn.title ?? "",
        conversationId: turn.conversationId,
      });
    } else if (meta.owner_id !== turn.ownerId) {
      throw new Error("This conversation belongs to a different owner.");
    }
    if (turn.title) this.journal.setTitle(turn.title);
  }

  private onAgentEvent(
    turn: ChatTurnRequest,
    event: AgentEvent,
    cursor: {
      nextIndex: () => number;
      streamId: () => string | null;
      setStreamId: (value: string | null) => void;
    },
  ): void {
    switch (event.type) {
      case "message_start": {
        if ((event.message as { role?: string }).role !== "assistant") break;
        const id = newStreamId();
        cursor.setStreamId(id);
        if (this.live) {
          this.live.streamId = id;
          this.live.partialText = "";
        }
        break;
      }
      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (delta.type !== "text_delta" && delta.type !== "thinking_delta")
          break;
        let id = cursor.streamId();
        if (!id) {
          id = newStreamId();
          cursor.setStreamId(id);
          if (this.live) this.live.streamId = id;
        }
        if (delta.type === "text_delta" && this.live) {
          // Bounded: a runaway generation must not grow the DO's memory, and
          // the committed row carries the full text regardless.
          this.live.partialText = (this.live.partialText + delta.delta).slice(
            -LIVE_PARTIAL_MAX_CHARS,
          );
        }
        this.hub.broadcastDelta({
          turnId: turn.turnId,
          streamId: id,
          kind: delta.type === "text_delta" ? "text" : "thinking",
          text: delta.delta,
        });
        break;
      }
      case "message_end": {
        const index = cursor.nextIndex();
        this.persistProduced(turn, event.message, index, cursor.streamId());
        if ((event.message as { role?: string }).role === "assistant") {
          cursor.setStreamId(null);
          if (this.live) {
            this.live.streamId = null;
            this.live.partialText = "";
          }
        }
        break;
      }
      case "tool_execution_start": {
        if (this.live) {
          this.live.tools.push({
            toolCallId: event.toolCallId,
            name: event.toolName,
            phase: "start",
          });
          if (this.live.tools.length > LIVE_TOOL_LIMIT) this.live.tools.shift();
        }
        this.hub.broadcastTool({
          turnId: turn.turnId,
          toolCallId: event.toolCallId,
          name: event.toolName,
          phase: "start",
          argsPreview: previewArgs(event.args),
        });
        break;
      }
      case "tool_execution_end": {
        const entry = this.live?.tools.find(
          (tool) => tool.toolCallId === event.toolCallId,
        );
        if (entry) {
          entry.phase = "end";
          entry.isError = event.isError;
        }
        this.hub.broadcastTool({
          turnId: turn.turnId,
          toolCallId: event.toolCallId,
          name: event.toolName,
          phase: "end",
          isError: event.isError,
        });
        break;
      }
      default:
        break;
    }
  }

  private persistProduced(
    turn: ChatTurnRequest,
    message: AgentMessage,
    index: number,
    streamId: string | null,
  ): void {
    const role = (message as { role?: string }).role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult")
      return;
    // The loop's first produced message is the prompt's clock-stamped copy.
    // The durable prompt row is already written and deliberately clock-free,
    // so replayed history stays byte-stable and cacheable.
    if (index === 0 && role === "user") return;
    // An assistant message with no usable output is never persisted: ONE such
    // row poisons every future Anthropic request for this conversation. The
    // predicate is the retry ladder's own — a message it would pop from the
    // live context on resume must never have reached the journal, or the
    // transcript keeps a reply the model no longer has and the next turn
    // rebuilds history with two consecutive assistant messages. This covers
    // the errored placeholder (empty text) and the thinking-only completion
    // that hit the output cap while reasoning.
    if (!assistantMessageHasUsableOutput(message)) return;
    let stored = message;
    let payloadJson = JSON.stringify(message);
    if (utf8Length(payloadJson) > MAX_ROW_BYTES) {
      // No R2 round trip is available here: the Agent's event sink drops
      // returned promises, so an oversize loop row is truncated in place with
      // an explicit marker rather than silently lost. Nothing in the pinned
      // tool set can currently produce a message this large.
      stored = truncateMessage(message, MAX_ROW_BYTES);
      payloadJson = JSON.stringify(stored);
      log("error", "conversation_row_truncated", {
        turnId: turn.turnId,
        role,
        bytes: utf8Length(JSON.stringify(message)),
      });
    }
    const appended = this.journal.appendMessage({
      turnId: turn.turnId,
      writer: "orchestrator",
      writerKey: `turn:${turn.turnId}:msg:${index}`,
      role: role as MessageRole,
      message: stored,
      payloadJson,
      ...(role === "assistant" && streamId ? { streamId } : {}),
    });
    this.journal.setTurnSpan(turn.turnId, appended.seq);
    this.publish(appended.record);
  }

  /**
   * Pulls back what the window needs from R2, and degrades the rest honestly.
   * A tool result keeps its `toolCallId` through the degradation so it never
   * orphans the call it answers.
   */
  private async hydrateWindow(
    selection: ReturnType<Journal["selectWindow"]>,
  ): Promise<AgentMessage[]> {
    if (selection.spilled.length === 0) return selection.messages;
    const messages = selection.messages.slice();
    const now = Date.now();
    let hydrated = 0;
    // Newest first: the most recent oversize payload is the one the model is
    // most likely to need.
    for (const entry of [...selection.spilled].reverse()) {
      if (hydrated < CONTEXT_MAX_SPILL_HYDRATIONS) {
        const payload = await this.archive
          .readSpill(entry.spillKey)
          .catch(() => null);
        if (payload) {
          messages[entry.index] = payload as AgentMessage;
          hydrated += 1;
          continue;
        }
      } else {
        // Over budget, permanently: stop paying to consider this row again.
        this.journal.markModelSkip(entry.seq);
      }
      messages[entry.index] = this.journal.omittedPlaceholder(
        entry.role,
        now,
        entry.toolCallId,
      );
    }
    return messages;
  }

  /**
   * The transcript's copy of a terminal state. Idempotent by writer key and
   * never throwing: it is a projection of the `terminal` / `terminalDelivered`
   * storage keys, which remain the authority, and a failure here must not be
   * able to disturb the delivery ladder that owns them.
   */
  private recordTerminal(
    turn: ChatTurnRequest,
    phase: TurnPhase,
    notice?: string,
    wallClockMs?: number,
  ): void {
    try {
      const now = Date.now();
      const row = this.journal.appendTurn({
        turnId: turn.turnId,
        writer: "orchestrator",
        writerKey: `turn:${turn.turnId}:phase:${phase}`,
        phase,
        lane: turn.lane ?? "chat",
        source: turn.source,
        notice,
        wallClockMs,
        createdAt: now,
      });
      this.journal.setTurnSpan(turn.turnId, row.seq);
      this.journal.setTurnTerminal(turn.turnId, phase, now);
      this.publish(row.record);
    } catch (error) {
      log("error", "conversation_terminal_record_failed", {
        turnId: turn.turnId,
        phase,
        message: errorMessage(error),
      });
    } finally {
      this.live = null;
      this.hub.endTurn(turn.turnId);
    }
  }

  /**
   * The turn's contribution to the search projection. Idempotent — the excerpt
   * is keyed by turn and rewritten in place — so a later rebuild that sees more
   * rows simply wins. Never throws: Recall is a projection, and losing one
   * excerpt must not be able to disturb a turn's terminal handling.
   */
  private recordExcerpt(turnId: string): void {
    try {
      const excerpt = this.journal.buildExcerpt(
        turnId,
        EXCERPT_USER_HALF_MAX,
        EXCERPT_TEXT_MAX,
        Date.now(),
      );
      if (excerpt) this.journal.putExcerpt(excerpt);
    } catch (error) {
      log("error", "conversation_excerpt_failed", {
        turnId,
        message: errorMessage(error),
      });
    }
  }

  /**
   * Everything that must happen after a turn is terminal, and that must never
   * be able to make a delivered turn look failed. Rollover in particular runs
   * only here: never mid-turn, never on a read path.
   *
   * Reached from EVERY terminal path, not just the completed one — a canceled
   * or timed-out turn is still a turn the user had, and it owes an excerpt and
   * an inbox drain exactly like a completed one. Callers that are not the loop
   * must go through `finalizeTerminalTurn`.
   */
  private async afterTerminal(turn: ChatTurnRequest): Promise<void> {
    this.finalizedTurnId = turn.turnId;
    this.recordExcerpt(turn.turnId);
    const now = Date.now();
    await this.index
      .flush({ activity: "idle", updatedAt: now })
      .catch(() => undefined);
    try {
      this.drainInbox();
    } catch (error) {
      // The per-row failures are already handled inside; this covers the
      // enclosing reads. Nothing here may throw: the alarm calls this too, and
      // a rejection there re-runs the whole watchdog handler.
      log("error", "conversation_inbox_drain_aborted", {
        turnId: turn.turnId,
        message: errorMessage(error),
      });
    }
    await this.archive.maybeRollover(now);
  }

  /**
   * `afterTerminal` for a caller that is not the loop — the watchdog and
   * `/cancel`. It skips a turn it has already finalized, so a retrying alarm
   * does not re-cut segments.
   *
   * The excerpt is written even when the loop is still unwinding: it is
   * synchronous, it touches only `turn_excerpts`, and the loop rewrites it in
   * place on its way out. Writing it now is what makes the Recall record
   * survive an eviction that lands between the abort and the loop's exit —
   * where nothing would ever run again. The rest genuinely must wait for the
   * loop: an inbox drain there could splice a foreign row between a tool call
   * and its result, and rollover mid-turn is forbidden outright.
   */
  private async finalizeTerminalTurn(turn: ChatTurnRequest): Promise<void> {
    if (this.finalizedTurnId === turn.turnId) return;
    this.recordExcerpt(turn.turnId);
    if (this.activeTurnId === turn.turnId) return;
    await this.afterTerminal(turn);
  }

  /**
   * Deleted, by either fence: the durable tombstone, or the in-memory seal that
   * outlives the `deleteAll()` which destroys it. Every write path asks this
   * rather than the journal directly.
   */
  private purged(): boolean {
    return this.sealed || this.journal.isDeleted();
  }

  /**
   * Raise the in-memory seal from outside `handlePurge`.
   *
   * The only caller is the index flush learning from Convex that this
   * conversation id is fenced as purged — which is the one fact this isolate
   * cannot derive for itself. A DO restarted after its purge has an empty
   * journal and a false `sealed`, and there is no request that would ever tell
   * it otherwise. This is a stop, not a delete: no storage is touched, because
   * an object in this state has none of the user's data left to remove.
   */
  private sealPurged(reason: string): void {
    if (this.sealed) return;
    this.sealed = true;
    log("error", "conversation_sealed_after_purge", {
      conversationId: this.conversationId(),
      reason,
    });
    // Called from inside a flush's retry ladder, where a throw would be caught
    // as a transport failure and retried. The seal is the point; disconnecting
    // stale tabs is a courtesy.
    try {
      this.hub.closeAll(CLOSE_DELETED);
    } catch (error) {
      log("error", "conversation_seal_close_failed", {
        message: errorMessage(error),
      });
    }
  }

  private async turnRunning(): Promise<boolean> {
    if (await this.activeConversationEditLock()) return true;
    const localLease =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (localLease) return true;
    const [turn, queued] = await Promise.all([
      this.ctx.storage.get<ChatTurnRequest>("turn"),
      this.ctx.storage.list<ChatTurnRequest>({
        prefix: "queued:",
        limit: 1,
      }),
    ]);
    if (queued.size > 0) return true;
    if (!turn) return false;
    return !(await this.ctx.storage.get<boolean>("terminal"));
  }

  /**
   * Moves staged foreign rows into the journal at a clean boundary. Every row
   * is dropped from the inbox whether or not it applied, so a poison row can
   * never wedge the drain.
   */
  private drainInbox(): void {
    for (;;) {
      const rows = this.journal.takeInbox(50);
      if (rows.length === 0) return;
      for (const row of rows) {
        try {
          if (row.kind === "card") {
            this.publish(
              this.journal.appendCard({
                turnId: row.turn_id,
                writer: row.writer,
                writerKey: row.writer_key,
                card: JSON.parse(row.payload_json) as ConversationCard,
                createdAt: row.created_at,
              }).record,
            );
          } else if (row.kind === "turn") {
            const detail = JSON.parse(row.payload_json) as {
              phase: TurnPhase;
              lane?: string;
              source?: string;
              notice?: string;
            };
            this.publish(
              this.journal.appendTurn({
                turnId: row.turn_id,
                writer: row.writer,
                writerKey: row.writer_key,
                phase: detail.phase,
                lane: detail.lane,
                source: detail.source,
                notice: detail.notice,
                createdAt: row.created_at,
              }).record,
            );
          } else {
            this.publish(
              this.journal.appendMessage({
                turnId: row.turn_id,
                writer: row.writer,
                writerKey: row.writer_key,
                role: (row.role ?? "user") as MessageRole,
                hidden: row.hidden === 1,
                message: JSON.parse(row.payload_json) as AgentMessage,
                payloadJson: row.payload_json,
                createdAt: row.created_at,
              }).record,
            );
          }
        } catch (error) {
          log("error", "conversation_inbox_drain_failed", {
            writerKey: row.writer_key,
            message: errorMessage(error),
          });
        } finally {
          this.journal.dropInbox(row.id);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Socket delegation
  // ---------------------------------------------------------------------------

  private async handleSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Expected a WebSocket upgrade." }, 426);
    }
    // These headers are trustable because a Durable Object namespace is not
    // publicly addressable: only the worker can produce this request, and it
    // strips any client-supplied x-stella-* before forwarding. Their absence
    // means the request did not come through that path.
    const identity = parseSocketIdentity(request);
    if (!identity) return json({ error: "Unauthorized." }, 401);
    // No tombstone pre-check here. A plain 4xx before the 101 reaches a browser
    // as close code 1006 with no detail, so "deleted" would be indistinguishable
    // from a network fault. The hub completes the handshake and closes 4410 with
    // a readable `error` frame first.
    return this.hub.upgrade(request, identity);
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.hub.onMessage(ws, message);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    await this.hub.onClose(ws, code, reason, wasClean);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.hub.onError(ws, error);
  }

  // ---------------------------------------------------------------------------
  // Canonical fork / rewind
  // ---------------------------------------------------------------------------

  private async activeConversationEditLock(): Promise<ConversationEditLock | null> {
    const lock =
      (await this.ctx.storage.get<ConversationEditLock>(
        CONVERSATION_EDIT_LOCK_KEY,
      )) ?? null;
    if (!lock) return null;
    if (lock.expiresAt > Date.now()) return lock;
    await this.ctx.storage.delete(CONVERSATION_EDIT_LOCK_KEY);
    return null;
  }

  private async bindConversationEditOwner(
    request: ConversationEditRequest,
    createdAt: number,
    title: string,
  ): Promise<Response | null> {
    const meta = this.journal.meta();
    if (meta.owner_id && meta.owner_id !== request.ownerId) {
      return json(
        { code: "not_found", message: "Conversation not found." },
        404,
      );
    }
    if (!meta.owner_id) {
      if (meta.next_seq !== 0) {
        return json(
          {
            code: "owner_missing",
            message: "Conversation ownership is unavailable.",
          },
          409,
        );
      }
      this.journal.bindOwner({
        ownerId: request.ownerId,
        ownerGeneration: request.ownerGeneration,
        createdAt,
        title,
        conversationId: this.conversationId(),
      });
    }
    this.ownerGeneration = request.ownerGeneration;
    await this.ctx.storage.put("ownerDataGeneration", request.ownerGeneration);
    return null;
  }

  private async conversationHasRuntimeWork(): Promise<boolean> {
    const [turn, terminal, localLease, queued] = await Promise.all([
      this.ctx.storage.get<ChatTurnRequest>("turn"),
      this.ctx.storage.get<boolean>("terminal"),
      this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY),
      this.ctx.storage.list({ prefix: "queued:", limit: 1 }),
    ]);
    return Boolean(
      retainedTurnBlocksOwnerTransfer(turn !== undefined, terminal) ||
        localLease ||
        queued.size > 0 ||
        this.live ||
        this.activeTurnId ||
        this.currentAgent ||
        this.currentTurnCancellation ||
        this.journal.inboxSize().rows > 0,
    );
  }

  private async validConversationEditBoundary(
    throughSeq: number,
    headSeq: number,
  ): Promise<boolean> {
    if (throughSeq < -1 || throughSeq > headSeq) return false;
    if (throughSeq === headSeq) return true;
    const next = await this.archive.exportRawPage(
      throughSeq + 1,
      throughSeq + 1,
      1,
      CONVERSATION_EDIT_PAGE_BYTES,
    );
    const row = next.rows[0];
    return Boolean(
      row &&
        row.seq === throughSeq + 1 &&
        row.kind === "message" &&
        row.role === "user" &&
        row.hidden === 0,
    );
  }

  private async handleConversationEditRoute(
    path: string,
    request: Request,
  ): Promise<Response> {
    const raw = (await request.json().catch(() => null)) as
      | (Record<string, unknown> & {
          fromSeq?: unknown;
          rows?: unknown;
          nextSeq?: unknown;
        })
      | null;
    const parsed = parseConversationEditRequest(raw);
    if (!parsed) {
      return json(
        { code: "bad_request", message: "Malformed conversation edit." },
        400,
      );
    }
    if (path.includes("fork-") && parsed.kind !== "fork") {
      return json(
        { code: "bad_request", message: "Wrong edit operation." },
        400,
      );
    }
    if (path.endsWith("/rewind") && parsed.kind !== "rewind") {
      return json(
        { code: "bad_request", message: "Wrong edit operation." },
        400,
      );
    }
    try {
      switch (path) {
        case "/internal/edit/fork-source/acquire":
          return await this.acquireForkSource(
            parsed as ForkConversationEditRequest,
          );
        case "/internal/edit/fork-source/export":
          return await this.exportForkSource(
            parsed as ForkConversationEditRequest,
            raw?.fromSeq,
          );
        case "/internal/edit/fork-source/release":
          return await this.releaseForkSource(
            parsed as ForkConversationEditRequest,
          );
        case "/internal/edit/fork-target/begin":
          return await this.beginForkTarget(
            parsed as ForkConversationEditRequest,
            raw,
          );
        case "/internal/edit/fork-target/import":
          return await this.importForkTarget(
            parsed as ForkConversationEditRequest,
            raw,
          );
        case "/internal/edit/fork-target/status":
          return await this.forkTargetStatus(
            parsed as ForkConversationEditRequest,
          );
        case "/internal/edit/fork-target/complete":
          return await this.completeForkTarget(
            parsed as ForkConversationEditRequest,
          );
        case "/internal/edit/fork-target/release":
          return await this.releaseForkTarget(
            parsed as ForkConversationEditRequest,
          );
        case "/internal/edit/rewind":
          return await this.rewindConversation(
            parsed as RewindConversationEditRequest,
          );
        default:
          return json({ error: "Not found." }, 404);
      }
    } catch (error) {
      if (error instanceof JournalHeadConflictError) {
        return json(
          {
            code: "head_conflict",
            message: error.message,
            epoch: error.epoch,
            lastSeq: error.lastSeq,
          },
          409,
        );
      }
      log("error", "conversation_edit_failed", {
        path,
        operationId: parsed.operationId,
        message: errorMessage(error),
      });
      return json(
        { code: "conversation_edit_failed", message: errorMessage(error) },
        503,
      );
    }
  }

  private async acquireForkSource(
    request: ForkConversationEditRequest,
  ): Promise<Response> {
    if (this.conversationId() !== request.sourceConversationId) {
      return json(
        { code: "not_found", message: "Conversation not found." },
        404,
      );
    }
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      const ownerTransfer =
        await this.ctx.storage.get<OwnerTransferRequest>(OWNER_TRANSFER_KEY);
      if (ownerTransfer) {
        return json(
          {
            code: "owner_transfer_in_progress",
            message: "Conversation ownership is being updated.",
          },
          409,
        );
      }
      const ownerError = await this.bindConversationEditOwner(
        request,
        request.sourceCreatedAt,
        request.title,
      );
      if (ownerError) return ownerError;
      const existing = await this.activeConversationEditLock();
      if (
        existing &&
        (existing.kind !== "fork-source" ||
          !sameConversationEditLock(existing, request))
      ) {
        return json(
          {
            code: "conversation_edit_in_progress",
            message: "Another conversation edit is already running.",
          },
          409,
        );
      }
      if (!existing && (await this.conversationHasRuntimeWork())) {
        return json(
          {
            code: "turn_in_progress",
            message:
              "Wait for Stella to finish before forking this conversation.",
            retryAfterMs: 1_000,
          },
          409,
        );
      }
      const head = this.journal.head();
      if (
        head.epoch !== request.expectedEpoch ||
        head.headSeq !== request.expectedLastSeq
      ) {
        return json(
          {
            code: "head_conflict",
            message: "The conversation changed before it could be forked.",
            epoch: head.epoch,
            lastSeq: head.headSeq,
          },
          409,
        );
      }
      const lock: ConversationEditLock = {
        kind: "fork-source",
        operationId: request.operationId,
        ownerId: request.ownerId,
        ownerGeneration: request.ownerGeneration,
        expectedEpoch: request.expectedEpoch,
        expectedLastSeq: request.expectedLastSeq,
        throughSeq: request.throughSeq,
        expiresAt: Date.now() + CONVERSATION_EDIT_LEASE_MS,
      };
      await this.ctx.storage.put(CONVERSATION_EDIT_LOCK_KEY, lock);
      return null;
    });
    if (result) return result;
    await this.archive.prepareForEdit();
    if (
      !(await this.validConversationEditBoundary(
        request.throughSeq,
        request.expectedLastSeq,
      ))
    ) {
      await this.ctx.storage.delete(CONVERSATION_EDIT_LOCK_KEY);
      return json(
        {
          code: "invalid_boundary",
          message: "Fork at a user-message boundary.",
        },
        409,
      );
    }
    return json({
      acquired: true,
      sourceEpoch: request.expectedEpoch,
      sourceLastSeq: request.expectedLastSeq,
    });
  }

  private async requireForkSourceLock(
    request: ForkConversationEditRequest,
  ): Promise<ConversationEditLock | Response> {
    const lock = await this.activeConversationEditLock();
    if (
      !lock ||
      lock.kind !== "fork-source" ||
      !sameConversationEditLock(lock, request)
    ) {
      return json(
        {
          code: "fork_lease_lost",
          message: "The fork snapshot lease expired.",
        },
        409,
      );
    }
    const head = this.journal.head();
    if (
      head.epoch !== request.expectedEpoch ||
      head.headSeq !== request.expectedLastSeq
    ) {
      return json(
        {
          code: "head_conflict",
          message: "The fork source changed.",
          epoch: head.epoch,
          lastSeq: head.headSeq,
        },
        409,
      );
    }
    lock.expiresAt = Date.now() + CONVERSATION_EDIT_LEASE_MS;
    await this.ctx.storage.put(CONVERSATION_EDIT_LOCK_KEY, lock);
    return lock;
  }

  private async exportForkSource(
    request: ForkConversationEditRequest,
    fromValue: unknown,
  ): Promise<Response> {
    const lock = await this.requireForkSourceLock(request);
    if (lock instanceof Response) return lock;
    const fromSeq =
      typeof fromValue === "number" && Number.isSafeInteger(fromValue)
        ? fromValue
        : -2;
    if (fromSeq < 0 || fromSeq > request.throughSeq) {
      return json(
        { code: "bad_request", message: "Invalid fork cursor." },
        400,
      );
    }
    const page = await this.archive.exportRawPage(
      fromSeq,
      request.throughSeq,
      CONVERSATION_EDIT_PAGE_ROWS,
      CONVERSATION_EDIT_PAGE_BYTES,
      async () => {
        const renewed = await this.requireForkSourceLock(request);
        if (renewed instanceof Response) {
          throw new Error("The fork source lease expired. Retry the request.");
        }
      },
    );
    return json(page);
  }

  private async releaseForkSource(
    request: ForkConversationEditRequest,
  ): Promise<Response> {
    const lock = await this.activeConversationEditLock();
    if (
      lock?.kind === "fork-source" &&
      sameConversationEditLock(lock, request)
    ) {
      await this.ctx.storage.delete(CONVERSATION_EDIT_LOCK_KEY);
    }
    return json({ released: true });
  }

  private forkTargetMatches(
    state: ForkTargetState,
    request: ForkConversationEditRequest,
  ): boolean {
    return (
      state.operationId === request.operationId &&
      state.ownerId === request.ownerId &&
      state.ownerGeneration === request.ownerGeneration &&
      state.sourceConversationId === request.sourceConversationId &&
      state.targetConversationId === request.targetConversationId &&
      state.throughSeq === request.throughSeq &&
      state.sourceEpoch === request.expectedEpoch &&
      state.sourceLastSeq === request.expectedLastSeq
    );
  }

  private forkTargetLock(
    request: ForkConversationEditRequest,
  ): ConversationEditLock {
    return {
      kind: "fork-target",
      operationId: request.operationId,
      ownerId: request.ownerId,
      ownerGeneration: request.ownerGeneration,
      expectedEpoch: request.expectedEpoch,
      expectedLastSeq: request.expectedLastSeq,
      throughSeq: request.throughSeq,
      expiresAt: Date.now() + CONVERSATION_EDIT_LEASE_MS,
    };
  }

  private async requireForkTargetLock(
    request: ForkConversationEditRequest,
  ): Promise<ConversationEditLock | Response> {
    const lock = await this.activeConversationEditLock();
    if (
      !lock ||
      lock.kind !== "fork-target" ||
      !sameConversationEditLock(lock, request)
    ) {
      return json(
        {
          code: "fork_lease_lost",
          message: "The fork target lease expired. Retry the same request.",
        },
        409,
      );
    }
    lock.expiresAt = Date.now() + CONVERSATION_EDIT_LEASE_MS;
    await this.ctx.storage.put(CONVERSATION_EDIT_LOCK_KEY, lock);
    return lock;
  }

  private async beginForkTarget(
    request: ForkConversationEditRequest,
    raw: Record<string, unknown> | null,
  ): Promise<Response> {
    if (this.conversationId() !== request.targetConversationId) {
      return json(
        { code: "not_found", message: "Fork target not found." },
        404,
      );
    }
    const sourceEpoch = raw?.sourceEpoch;
    const sourceLastSeq = raw?.sourceLastSeq;
    if (
      sourceEpoch !== request.expectedEpoch ||
      sourceLastSeq !== request.expectedLastSeq
    ) {
      return json(
        { code: "source_conflict", message: "Fork source changed." },
        409,
      );
    }
    return await this.ctx.blockConcurrencyWhile(async () => {
      const ownerTransfer =
        await this.ctx.storage.get<OwnerTransferRequest>(OWNER_TRANSFER_KEY);
      if (ownerTransfer) {
        return json(
          {
            code: "owner_transfer_in_progress",
            message: "Conversation ownership is being updated.",
          },
          409,
        );
      }
      const activeLock = await this.activeConversationEditLock();
      if (
        activeLock &&
        (activeLock.kind !== "fork-target" ||
          !sameConversationEditLock(activeLock, request))
      ) {
        return json(
          {
            code: "conversation_edit_in_progress",
            message: "Another conversation edit is already running.",
          },
          409,
        );
      }
      const existing = await this.ctx.storage.get<ForkTargetState>(
        CONVERSATION_FORK_TARGET_KEY,
      );
      if (existing) {
        if (!this.forkTargetMatches(existing, request)) {
          return json(
            {
              code: "target_conflict",
              message: "Fork target is already in use.",
            },
            409,
          );
        }
        await this.ctx.storage.put(
          CONVERSATION_EDIT_LOCK_KEY,
          this.forkTargetLock(request),
        );
        return json({ begun: true, replayed: true });
      }
      const meta = this.journal.meta();
      if (
        meta.next_seq !== 0 ||
        (meta.owner_id !== "" && meta.owner_id !== request.ownerId) ||
        (meta.conversation_id !== "" &&
          meta.conversation_id !== request.targetConversationId)
      ) {
        return json(
          { code: "target_conflict", message: "Fork target is not empty." },
          409,
        );
      }
      const ownerError = await this.bindConversationEditOwner(
        request,
        request.targetCreatedAt,
        request.title,
      );
      if (ownerError) return ownerError;
      const state: ForkTargetState = {
        operationId: request.operationId,
        ownerId: request.ownerId,
        ownerGeneration: request.ownerGeneration,
        sourceConversationId: request.sourceConversationId,
        targetConversationId: request.targetConversationId,
        sourceEpoch: request.expectedEpoch,
        sourceLastSeq: request.expectedLastSeq,
        throughSeq: request.throughSeq,
        nextSeq: 0,
        title: request.title,
        createdAt: request.targetCreatedAt,
        state: "copying",
      };
      await this.ctx.storage.put({
        [CONVERSATION_FORK_TARGET_KEY]: state,
        [CONVERSATION_EDIT_LOCK_KEY]: this.forkTargetLock(request),
      });
      return json({ begun: true, replayed: false });
    });
  }

  private parseForkRows(value: unknown): JournalRow[] | null {
    if (!Array.isArray(value) || value.length > CONVERSATION_EDIT_PAGE_ROWS) {
      return null;
    }
    const rows: JournalRow[] = [];
    for (const valueRow of value) {
      if (
        !valueRow ||
        typeof valueRow !== "object" ||
        Array.isArray(valueRow)
      ) {
        return null;
      }
      const row = valueRow as Partial<JournalRow>;
      if (
        !Number.isSafeInteger(row.seq) ||
        typeof row.kind !== "string" ||
        typeof row.turn_id !== "string" ||
        typeof row.writer !== "string" ||
        typeof row.writer_key !== "string" ||
        !Number.isSafeInteger(row.created_at) ||
        !Number.isSafeInteger(row.bytes) ||
        typeof row.payload_json !== "string" ||
        !Number.isSafeInteger(row.hidden) ||
        !Number.isSafeInteger(row.model_skip) ||
        !Number.isSafeInteger(row.open_calls) ||
        !Number.isSafeInteger(row.tokens)
      ) {
        return null;
      }
      rows.push(row as JournalRow);
    }
    return rows;
  }

  private async importForkTarget(
    request: ForkConversationEditRequest,
    raw: Record<string, unknown> | null,
  ): Promise<Response> {
    const lock = await this.requireForkTargetLock(request);
    if (lock instanceof Response) return lock;
    const state = await this.ctx.storage.get<ForkTargetState>(
      CONVERSATION_FORK_TARGET_KEY,
    );
    if (!state || !this.forkTargetMatches(state, request)) {
      return json(
        { code: "target_conflict", message: "Fork target is unavailable." },
        409,
      );
    }
    if (state.state === "complete")
      return json({ imported: true, replayed: true });
    const rows = this.parseForkRows(raw?.rows);
    if (!rows || rows.length === 0) {
      return json({ code: "bad_request", message: "Fork page is empty." }, 400);
    }
    const firstSeq = rows[0]!.seq;
    const currentNext = this.journal.meta().next_seq;
    if (firstSeq !== currentNext) {
      return json(
        {
          code: "fork_cursor_conflict",
          message: "Fork page does not match the target cursor.",
          nextSeq: currentNext,
        },
        409,
      );
    }
    const mappedSpills = new Map<string, string>();
    for (const row of rows) {
      if (!row.spill_key) continue;
      let targetKey = mappedSpills.get(row.spill_key);
      if (!targetKey) {
        const beforeCopy = await this.requireForkTargetLock(request);
        if (beforeCopy instanceof Response) return beforeCopy;
        targetKey = await this.archive.copyForkSpill(
          row.spill_key,
          request.operationId,
        );
        const afterCopy = await this.requireForkTargetLock(request);
        if (afterCopy instanceof Response) return afterCopy;
        mappedSpills.set(row.spill_key, targetKey);
      }
      row.spill_key = targetKey;
    }
    const imported = this.journal.importForkRows(
      rows,
      request.operationId,
      request.ownerId,
    );
    if (!imported) {
      return json({ code: "bad_request", message: "Fork page is empty." }, 400);
    }
    const nextSeq = imported.lastSeq + 1;
    if (raw?.nextSeq !== nextSeq || nextSeq > request.throughSeq + 1) {
      throw new Error("Fork source and target cursors diverged.");
    }
    state.nextSeq = nextSeq;
    await this.ctx.storage.put(CONVERSATION_FORK_TARGET_KEY, state);
    return json({
      imported: true,
      nextSeq,
      complete: nextSeq > request.throughSeq,
    });
  }

  private async forkTargetStatus(
    request: ForkConversationEditRequest,
  ): Promise<Response> {
    const lock = await this.requireForkTargetLock(request);
    if (lock instanceof Response) return lock;
    const state = await this.ctx.storage.get<ForkTargetState>(
      CONVERSATION_FORK_TARGET_KEY,
    );
    if (!state || !this.forkTargetMatches(state, request)) {
      return json(
        { code: "target_conflict", message: "Fork target is unavailable." },
        409,
      );
    }
    const meta = this.journal.meta();
    const preview =
      state.state === "complete" ? this.journal.lastPreview(160) : null;
    return json({
      state: state.state,
      nextSeq: meta.next_seq,
      targetEpoch: meta.epoch,
      lastSeq: meta.next_seq - 1,
      ...(preview ? { lastPreview: preview.text, lastRole: preview.role } : {}),
    });
  }

  private async completeForkTarget(
    request: ForkConversationEditRequest,
  ): Promise<Response> {
    const lock = await this.requireForkTargetLock(request);
    if (lock instanceof Response) return lock;
    const state = await this.ctx.storage.get<ForkTargetState>(
      CONVERSATION_FORK_TARGET_KEY,
    );
    if (!state || !this.forkTargetMatches(state, request)) {
      return json(
        { code: "target_conflict", message: "Fork target is unavailable." },
        409,
      );
    }
    const meta = this.journal.meta();
    if (meta.next_seq !== request.throughSeq + 1) {
      return json(
        { code: "fork_incomplete", message: "Fork target is still copying." },
        409,
      );
    }
    // The source prefix may span many cold R2 segments. Import is deliberately
    // gapless into SQLite first; cut it back to the normal hot window before
    // the target becomes discoverable so a large fork does not stay resident.
    await this.archive.maybeRollover(Date.now());
    state.state = "complete";
    state.nextSeq = meta.next_seq;
    state.completedAt = Date.now();
    await this.ctx.storage.put(CONVERSATION_FORK_TARGET_KEY, state);
    return json({ complete: true });
  }

  private async releaseForkTarget(
    request: ForkConversationEditRequest,
  ): Promise<Response> {
    const lock = await this.activeConversationEditLock();
    if (
      lock?.kind === "fork-target" &&
      sameConversationEditLock(lock, request)
    ) {
      await this.ctx.storage.delete(CONVERSATION_EDIT_LOCK_KEY);
    }
    return json({ released: true });
  }

  private async requestRewindCancellation(): Promise<void> {
    const queued = await this.ctx.storage.list({ prefix: "queued:", limit: 1 });
    if (queued.size > 0) {
      throw new Error("Queued turns must be canceled before rewinding.");
    }
    const localLease =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (localLease) await this.cancelLocalTurn(localLease);
    const turn = await this.ctx.storage.get<ChatTurnRequest>("turn");
    if (turn && !(await this.ctx.storage.get<boolean>("terminal"))) {
      await this.cancelTurn(turn.turnId);
    }
  }

  private async renewRewindLock(
    request: RewindConversationEditRequest,
  ): Promise<void> {
    const lock = await this.activeConversationEditLock();
    if (
      !lock ||
      lock.kind !== "rewind" ||
      !sameConversationEditLock(lock, request)
    ) {
      throw new Error("The rewind lease expired. Retry the same request.");
    }
    lock.expiresAt = Date.now() + CONVERSATION_EDIT_LEASE_MS;
    await this.ctx.storage.put(CONVERSATION_EDIT_LOCK_KEY, lock);
  }

  private async finalizeRewindSideEffects(
    request: RewindConversationEditRequest,
    now: number,
  ): Promise<void> {
    this.live = null;
    this.hub.closeAll(1012);
    const lock = await this.activeConversationEditLock();
    if (lock?.kind === "rewind" && sameConversationEditLock(lock, request)) {
      await this.ctx.storage.delete(CONVERSATION_EDIT_LOCK_KEY);
    }
    await this.index
      .flush({ activity: "idle", updatedAt: now })
      .catch(() => undefined);
    await this.archive.drainPurge().catch((error) => {
      log("error", "conversation_rewind_cleanup_deferred", {
        operationId: request.operationId,
        message: errorMessage(error),
      });
    });
  }

  private async rewindConversation(
    request: RewindConversationEditRequest,
  ): Promise<Response> {
    if (this.conversationId() !== request.conversationId) {
      return json(
        { code: "not_found", message: "Conversation not found." },
        404,
      );
    }
    const meta = this.journal.meta();
    const replay =
      this.journal.conversationEditReceipt<RewindConversationEditResult>(
        request.operationId,
        "rewind",
      );
    if (replay) {
      if (meta.owner_id !== request.ownerId) {
        return json(
          { code: "not_found", message: "Conversation not found." },
          404,
        );
      }
      await this.finalizeRewindSideEffects(request, Date.now());
      return json({ ...replay, replayed: true });
    }
    const admission = await this.ctx.blockConcurrencyWhile(async () => {
      const ownerTransfer =
        await this.ctx.storage.get<OwnerTransferRequest>(OWNER_TRANSFER_KEY);
      if (ownerTransfer) {
        return {
          ok: false,
          response: json(
            {
              code: "owner_transfer_in_progress",
              message: "Conversation ownership is being updated.",
            },
            409,
          ),
        } as const;
      }
      const ownerError = await this.bindConversationEditOwner(
        request,
        meta.created_at,
        meta.title || "Conversation",
      );
      if (ownerError) return { ok: false, response: ownerError } as const;
      const head = this.journal.head();
      const existingLock = await this.activeConversationEditLock();
      if (
        !conversationRewindHeadMatches(
          request,
          { epoch: head.epoch, lastSeq: head.headSeq },
          existingLock,
        )
      ) {
        return {
          ok: false,
          response: json(
            {
              code: "head_conflict",
              message: "The conversation changed before it could be rewound.",
              epoch: head.epoch,
              lastSeq: head.headSeq,
            },
            409,
          ),
        } as const;
      }
      if (existingLock && !sameConversationEditLock(existingLock, request)) {
        return {
          ok: false,
          response: json(
            {
              code: "conversation_edit_in_progress",
              message: "Another edit is running.",
            },
            409,
          ),
        } as const;
      }
      const queued = await this.ctx.storage.list({
        prefix: "queued:",
        limit: 1,
      });
      const runtimeWork = await this.conversationHasRuntimeWork();
      const runtimeAdmission = rewindRuntimeAdmission(request, {
        runtimeWork,
        queuedTurn: queued.size > 0,
        continuingOperation: existingLock !== null,
      });
      if (runtimeAdmission === "turn-conflict") {
        return {
          ok: false,
          response: json(
            {
              code: "turn_in_progress",
              message: "Wait for Stella to finish before rewinding.",
              retryAfterMs: 1_000,
            },
            409,
          ),
        } as const;
      }
      if (runtimeAdmission === "queued-conflict") {
        return {
          ok: false,
          response: json(
            {
              code: "queued_turn_conflict",
              message: "Cancel queued turns before rewinding.",
            },
            409,
          ),
        } as const;
      }
      const lock: ConversationEditLock = {
        kind: "rewind",
        operationId: request.operationId,
        ownerId: request.ownerId,
        ownerGeneration: request.ownerGeneration,
        expectedEpoch: request.expectedEpoch,
        expectedLastSeq: request.expectedLastSeq,
        throughSeq: request.throughSeq,
        expiresAt: Date.now() + CONVERSATION_EDIT_LEASE_MS,
      };
      await this.ctx.storage.put(CONVERSATION_EDIT_LOCK_KEY, lock);
      return { ok: true, head, runtimeWork } as const;
    });
    if (!admission.ok) return admission.response;
    const { head, runtimeWork } = admission;
    if (runtimeWork) {
      await this.requestRewindCancellation();
      return json({
        complete: false,
        kind: "rewind",
        operationId: request.operationId,
        conversationId: request.conversationId,
        previousEpoch: request.expectedEpoch,
        nextEpoch: request.expectedEpoch,
        lastSeq: request.expectedLastSeq,
        cancelRequested: true,
      } satisfies RewindConversationEditResult);
    }
    if (
      !(await this.validConversationEditBoundary(
        request.throughSeq,
        head.headSeq,
      ))
    ) {
      await this.ctx.storage.delete(CONVERSATION_EDIT_LOCK_KEY);
      return json(
        {
          code: "invalid_boundary",
          message: "Rewind at a user-message boundary.",
        },
        409,
      );
    }

    const now = Date.now();
    const plan = await this.archive.prepareTruncate(
      request.throughSeq,
      request.expectedEpoch + 1,
      now,
      () => this.renewRewindLock(request),
    );
    const result: RewindConversationEditResult & { replayed: boolean } = {
      complete: true,
      kind: "rewind",
      operationId: request.operationId,
      conversationId: request.conversationId,
      previousEpoch: request.expectedEpoch,
      nextEpoch: request.expectedEpoch + 1,
      lastSeq: request.throughSeq,
      ...(plan.lastPreview
        ? {
            lastPreview: plan.lastPreview.text,
            lastRole: plan.lastPreview.role,
          }
        : {}),
      replayed: false,
    };
    await this.renewRewindLock(request);
    await this.journal.applyTruncate({
      operationId: request.operationId,
      throughSeq: request.throughSeq,
      expectedEpoch: request.expectedEpoch,
      expectedLastSeq: head.headSeq,
      replacementSegment: plan.replacementSegment,
      removedSegmentFirstSeqs: plan.removedSegmentFirstSeqs,
      purgeKeys: plan.purgeKeys,
      retiredWriterKeys: plan.retiredWriterKeys,
      retiredTurnIds: plan.removedTurnIds,
      retiredAt: now,
      resultJson: JSON.stringify(result),
    });
    await this.finalizeRewindSideEffects(request, now);
    return json(result);
  }

  // ---------------------------------------------------------------------------
  // Service surfaces
  // ---------------------------------------------------------------------------

  private async devAcceptanceProbeSnapshot(
    operation: "status" | "self_abort" | "arm_fault",
    replayed: boolean,
    receiptSha256: string,
  ): Promise<Record<string, unknown>> {
    const state = await this.ctx.storage.get<DevAcceptanceProbeState>(
      DEV_ACCEPTANCE_PROBE_STATE_KEY,
    );
    const historyFault = this.journal.acceptanceContextFaultStatus();
    return {
      version: 1,
      operation,
      replayed,
      bootIdSha256: await sha256Hex(this.devAcceptanceBootId),
      durableObjectIdSha256: await sha256Hex(this.ctx.id.toString()),
      providerDispatchCount:
        (await this.ctx.storage.get<number>(
          DEV_ACCEPTANCE_PROVIDER_DISPATCH_COUNT_KEY,
        )) ?? 0,
      receiptSha256,
      fault: state?.promptFaultArmed
        ? { kind: "canonical_prompt", armed: true }
        : historyFault
          ? {
              kind: "canonical_history",
              armed: true,
              corruptSeq: historyFault.seq,
              originalPayloadSha256: historyFault.original_payload_sha256,
              corruptPayloadSha256: historyFault.corrupt_payload_sha256,
              observedFailures: historyFault.observed_failures,
              repairAfterFailures: historyFault.repair_after_failures,
            }
          : null,
    };
  }

  /**
   * Strict dev-only product-proof control. The public Worker has already
   * checked the service secret, and the DO checks it again along with the
   * deployment, owner generation, and exact disposable conversation marker.
   */
  private async handleDevAcceptanceProbe(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    const authorization = await authorizeDevAcceptanceProbe({
      env: this.env,
      suppliedServiceSecret: request.headers.get(
        "x-stella-acceptance-service-secret",
      ),
      body,
      meta: {
        ownerId: this.journal.ownerId(),
        ownerGeneration: this.ownerGeneration,
        conversationId: this.conversationId(),
        title: this.journal.meta().title,
      },
    });
    if (!authorization.ok) {
      return json({ error: "Not found." }, authorization.status);
    }
    const current = await this.ctx.storage.get<DevAcceptanceProbeState>(
      DEV_ACCEPTANCE_PROBE_STATE_KEY,
    );
    const receipt = recordDevAcceptanceProbeReceipt({
      current,
      authorization,
      now: Date.now(),
    });
    if (receipt.status === "conflict") {
      return json(
        {
          code: "acceptance_probe_conflict",
          message: "Acceptance probe identity conflicts with durable state.",
        },
        409,
      );
    }
    const replayed = receipt.status === "replayed";
    if (!replayed && authorization.request.operation === "arm_fault") {
      const fault = authorization.request.fault;
      if (!fault) return json({ error: "Not found." }, 404);
      if (receipt.state.usedFaults?.includes(fault)) {
        return json(
          {
            code: "acceptance_probe_consumed",
            message: "This one-shot acceptance fault was already used.",
          },
          409,
        );
      }
      if (authorization.request.fault === "canonical_prompt") {
        if (
          receipt.state.promptFaultArmed ||
          this.journal.acceptanceContextFaultStatus()
        ) {
          return json(
            {
              code: "acceptance_probe_busy",
              message: "A bounded acceptance fault is already armed.",
            },
            409,
          );
        }
        receipt.state.promptFaultArmed = true;
      } else {
        if (receipt.state.promptFaultArmed) {
          return json(
            {
              code: "acceptance_probe_busy",
              message: "A bounded acceptance fault is already armed.",
            },
            409,
          );
        }
        const existing = this.journal.acceptanceContextFaultStatus();
        if (existing) {
          if (existing.run_id_sha256 !== authorization.runIdSha256) {
            return json(
              {
                code: "acceptance_probe_busy",
                message: "A bounded acceptance fault is already armed.",
              },
              409,
            );
          }
        } else {
          const candidate = this.journal.acceptanceContextFaultCandidate();
          if (!candidate) {
            return json(
              {
                code: "acceptance_probe_unavailable",
                message: "No eligible canonical context row is available.",
              },
              409,
            );
          }
          this.journal.armAcceptanceContextFault({
            runIdSha256: authorization.runIdSha256,
            seq: candidate.seq,
            expectedPayloadJson: candidate.payloadJson,
            originalPayloadSha256: await sha256Hex(candidate.payloadJson),
            corruptPayloadSha256: await sha256Hex(
              '{"stellaAcceptanceContextFault":',
            ),
            createdAt: Date.now(),
          });
        }
      }
      receipt.state.usedFaults = [...(receipt.state.usedFaults ?? []), fault];
    }
    await this.ctx.storage.put(DEV_ACCEPTANCE_PROBE_STATE_KEY, receipt.state);
    log("info", "dev_acceptance_probe", {
      operation: authorization.request.operation,
      requestIdSha256: authorization.requestIdSha256,
      runIdSha256: authorization.runIdSha256,
      ownerIdSha256: authorization.ownerIdSha256,
      conversationIdSha256: authorization.conversationIdSha256,
      replayed,
    });
    const snapshot = await this.devAcceptanceProbeSnapshot(
      authorization.request.operation,
      replayed,
      authorization.fingerprintSha256,
    );
    if (!replayed && authorization.request.operation === "self_abort") {
      // Give the 202 response a chance to leave the isolate, then force a real
      // DO restart. The durable receipt makes a retried request a no-op.
      this.ctx.waitUntil(
        scheduler.wait(50).then(() => {
          this.ctx.abort("controlled dev acceptance restart");
        }),
      );
      return json({ ...snapshot, selfAbortScheduled: true }, 202);
    }
    return json(snapshot);
  }

  private async noteDevAcceptanceProviderDispatch(): Promise<void> {
    if (!devAcceptanceProbesEnabled(this.env)) return;
    const state = await this.ctx.storage.get<DevAcceptanceProbeState>(
      DEV_ACCEPTANCE_PROBE_STATE_KEY,
    );
    if (!state) return;
    const current =
      (await this.ctx.storage.get<number>(
        DEV_ACCEPTANCE_PROVIDER_DISPATCH_COUNT_KEY,
      )) ?? 0;
    await this.ctx.storage.put(
      DEV_ACCEPTANCE_PROVIDER_DISPATCH_COUNT_KEY,
      current + 1,
    );
  }

  private async loadCanonicalPromptsForTurn(
    convexSiteBase: string,
    signal?: AbortSignal,
  ): Promise<CanonicalPromptSnapshot> {
    signal?.throwIfAborted();
    if (devAcceptanceProbesEnabled(this.env)) {
      const state = await this.ctx.storage.get<DevAcceptanceProbeState>(
        DEV_ACCEPTANCE_PROBE_STATE_KEY,
      );
      signal?.throwIfAborted();
      if (state?.promptFaultArmed) {
        state.promptFaultArmed = false;
        signal?.throwIfAborted();
        await this.ctx.storage.put(DEV_ACCEPTANCE_PROBE_STATE_KEY, state);
        signal?.throwIfAborted();
        log("info", "dev_acceptance_fault_consumed", {
          kind: "canonical_prompt",
          runIdSha256: state.runIdSha256,
        });
        throw new CloudContextBlockedError(
          "canonical_prompt",
          "dev_acceptance_fault",
        );
      }
    }
    return this.loadCanonicalPrompts(convexSiteBase, signal);
  }

  private async observeDevAcceptanceContextFailure(
    contextFailure: ReturnType<typeof cloudContextFailure>,
  ): Promise<void> {
    if (
      contextFailure?.component !== "canonical_history" ||
      !devAcceptanceProbesEnabled(this.env)
    ) {
      return;
    }
    const state = await this.ctx.storage.get<DevAcceptanceProbeState>(
      DEV_ACCEPTANCE_PROBE_STATE_KEY,
    );
    if (!state) return;
    const observation = this.journal.observeAcceptanceContextFault(
      state.runIdSha256,
    );
    if (!observation) return;
    log("info", "dev_acceptance_context_fault_observed", {
      runIdSha256: state.runIdSha256,
      corruptSeq: observation.seq,
      observedFailures: observation.observedFailures,
      repaired: observation.repaired,
      originalPayloadSha256: observation.originalPayloadSha256,
      corruptPayloadSha256: observation.corruptPayloadSha256,
    });
  }

  /**
   * The journal probe reads the canonical journal exactly the way a client
   * does, including through R2 segments.
   */
  private async handleJournalProbe(url: URL): Promise<Response> {
    const requested = Number(url.searchParams.get("limit") ?? "50");
    const limit = Math.min(
      Number.isFinite(requested) && requested > 0 ? requested : 50,
      BACKFILL_BATCH_RECORDS,
    );
    const head = this.journal.head(this.live ? "running" : "idle");
    const beforeSeq = url.searchParams.get("beforeSeq");
    const to =
      beforeSeq !== null && Number.isFinite(Number(beforeSeq))
        ? Number(beforeSeq) - 1
        : head.headSeq;
    const from = Math.max(0, to - limit + 1);
    const range = await this.archive.readRange(from, to, limit);
    const meta = this.journal.meta();
    // The wake state, so the invariant "an accepted turn always has a pending
    // alarm" is observable rather than merely asserted: `queued` non-empty with
    // `alarmAt` null is a stranded turn, and there is no other way to see it
    // from outside the object.
    const queued = await this.ctx.storage.list<ChatTurnRequest>({
      prefix: "queued:",
    });
    return json({
      head,
      alarmAt: await this.ctx.storage.getAlarm(),
      queued: [...queued.values()].map((entry) => entry.turnId),
      sealed: this.purged(),
      indexSyncedSeq: meta.index_synced_seq,
      pendingExcerpts: this.journal.unsyncedExcerptCount(),
      hot: this.journal.hotStats(),
      inbox: this.journal.inboxSize(),
      databaseBytes: this.journal.databaseSize(),
      storedBytes: this.journal.storedBytes(),
      spillObjects: this.journal.allSpillKeys().length,
      purgePending: this.journal.purgePending(),
      complete: range.complete,
      records: range.records,
    });
  }

  private async localTurnOwner(
    request: Request,
    suppliedLeaseToken?: string,
    expectedOwnerGeneration?: string,
  ): Promise<{ ownerId: string; ownerGeneration: string } | Response> {
    const identity = parseSocketIdentity(request);
    if (!identity) return json({ error: "Unauthorized." }, 401);
    if (this.purged()) {
      return json(
        { code: "deleted", message: "This conversation was deleted." },
        410,
      );
    }
    // A new local turn is a new write capability, so it must refresh Convex's
    // generation even when this DO already has an owner cached. Renewal of an
    // admitted exact lease keeps the generation that lease was fenced with.
    const isNewAdmission = suppliedLeaseToken === undefined;
    const ownerRecord = await this.lookupOwner(isNewAdmission);
    // A forced refresh returning null is an authoritative refusal (for
    // example, Convex returned 404 or an invalid owner payload). Cached DO
    // owner/generation fields must never turn that refusal into a new write
    // capability. Exact renewals instead remain bound to their admitted lease.
    if (isNewAdmission && !ownerRecord) {
      return json({ error: "Conversation not found." }, 404);
    }
    const bound = this.journal.ownerId() || ownerRecord?.ownerId;
    const activeLease = suppliedLeaseToken
      ? await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY)
      : undefined;
    const ownerGeneration =
      activeLease?.ownerGeneration ??
      ownerRecord?.ownerGeneration ??
      this.ownerGeneration;
    if (
      !bound ||
      !ownerGeneration ||
      !localTurnLeaseAllowsIdentityTransition({
        boundOwnerId: bound,
        callerOwnerId: identity.ownerId,
        suppliedLeaseToken,
        activeLease,
      })
    ) {
      return json({ error: "Conversation not found." }, 404);
    }
    if (
      expectedOwnerGeneration !== undefined &&
      expectedOwnerGeneration !== ownerGeneration
    ) {
      return staleOwnerGenerationResponse();
    }
    return { ownerId: bound, ownerGeneration };
  }

  private async localTurnHistory(turnId: string): Promise<{
    history: string[];
    contextStartSeq: number;
    contextEndSeq: number;
  }> {
    const selection = this.journal.selectWindow(
      turnId,
      CLOUD_HISTORY_TOKEN_BUDGET,
    );
    const messages = await this.hydrateWindow(selection);
    return {
      history: messages.map((message) => JSON.stringify(message)),
      contextStartSeq: selection.startSeq,
      contextEndSeq: selection.endSeq,
    };
  }

  private async handleCanonicalHistory(request: Request): Promise<Response> {
    const owner = await this.localTurnOwner(request);
    if (owner instanceof Response) return owner;
    // No lease is acquired and no journal state is mutated. The empty
    // exclusion key cannot match a real turn id, so this is the same bounded,
    // spill-hydrated canonical window used to seed a local cloud turn.
    return json(await this.localTurnHistory(""));
  }

  /**
   * Completes the durable half of begin. Every writer key is stable, so a
   * retry after an isolate died between storing the lease and returning the
   * response repairs the same rows instead of creating another prompt.
   */
  private async initializeLocalTurn(
    lease: LocalTurnLease,
    userMessage: AgentMessage,
    userMessageJson: string,
  ): Promise<{
    history: string[];
    contextStartSeq: number;
    contextEndSeq: number;
  }> {
    for (const repaired of this.journal.repairTail(Date.now())) {
      this.publish(repaired.record);
    }
    this.drainInbox();
    const context = await this.localTurnHistory(lease.turnId);
    const current =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (
      !current ||
      current.turnId !== lease.turnId ||
      current.leaseToken !== lease.leaseToken ||
      current.cancelRequested ||
      this.journal.turnState(lease.turnId)?.state === "terminal"
    ) {
      throw new Error("Local turn lease is no longer active.");
    }
    const now = Date.now();
    this.journal.upsertTurn({
      turnId: lease.turnId,
      sessionId: `desktop-${lease.deviceId}`.slice(0, 64),
      ownerId: lease.ownerId,
      lane: "chat",
      source: "desktop",
      ...(lease.clientMsgId ? { clientMsgId: lease.clientMsgId } : {}),
      state: "running",
      now,
    });
    this.journal.setTurnContext(
      lease.turnId,
      context.contextStartSeq,
      context.contextEndSeq,
    );
    const sizedPrompt = await this.prepareOversize(
      "user",
      userMessage,
      userMessageJson,
      `turn:${lease.turnId}:prompt`,
    );
    await this.assertOwnerTurn(lease);
    const admitted =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (
      !admitted ||
      admitted.turnId !== lease.turnId ||
      admitted.leaseToken !== lease.leaseToken ||
      admitted.ownerGeneration !== lease.ownerGeneration ||
      admitted.cancelRequested
    ) {
      throw new OwnerPurgeFenceError();
    }
    const promptRow = this.journal.appendMessage({
      turnId: lease.turnId,
      writer: `desktop:${lease.deviceId}`,
      writerKey: `turn:${lease.turnId}:prompt`,
      role: "user",
      message: sizedPrompt.message,
      payloadJson: sizedPrompt.payloadJson,
      ...(sizedPrompt.spillKey ? { spillKey: sizedPrompt.spillKey } : {}),
      ...(lease.clientMsgId ? { clientMsgId: lease.clientMsgId } : {}),
      createdAt: now,
    });
    this.journal.setTurnSpan(lease.turnId, promptRow.seq);
    if (promptRow.inserted) this.publish(promptRow.record);
    const startedRow = this.journal.appendTurn({
      turnId: lease.turnId,
      writer: `desktop:${lease.deviceId}`,
      writerKey: `turn:${lease.turnId}:phase:started`,
      phase: "started",
      lane: "chat",
      source: "desktop",
      promptSeq: promptRow.seq,
      createdAt: now,
    });
    this.journal.setTurnSpan(lease.turnId, startedRow.seq);
    if (startedRow.inserted) this.publish(startedRow.record);
    if (this.journal.meta().title.trim() === "") {
      const text = (
        (userMessage as { content?: Array<{ type?: string; text?: string }> })
          .content ?? []
      )
        .filter(
          (block) => block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join(" ")
        .trim();
      if (text) {
        this.journal.setTitle(
          text.length > 56 ? `${text.slice(0, 53)}…` : text,
        );
      }
    }
    this.live = {
      turnId: lease.turnId,
      streamId: null,
      partialText: "",
      tools: [],
    };
    void this.index
      .flush({ activity: "running", updatedAt: now })
      .catch(() => undefined);
    return context;
  }

  private async handleLocalTurnRenewal(
    renewal: ParsedLocalTurnRenewal,
    ownerId: string,
  ): Promise<Response> {
    const { deviceId, expectedOwnerGeneration, localTurnId, leaseToken } =
      renewal;
    const turnId = makeLocalTurnId(deviceId, localTurnId);
    const previous = await this.ctx.storage.get<LocalTurnFinishReceipt>(
      localTurnReceiptKey(turnId),
    );
    if (
      previous?.turnId === turnId &&
      previous.ownerGeneration !== expectedOwnerGeneration
    ) {
      return staleOwnerGenerationResponse();
    }
    if (previous?.turnId === turnId) {
      return json(
        {
          code: "turn_finished",
          message: "That local turn has already finished.",
          turnId,
          phase: previous.phase,
        },
        409,
      );
    }

    const existing =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (!existing) {
      return json(
        {
          code: "lease_mismatch",
          message: "That local turn no longer owns this conversation.",
        },
        409,
      );
    }
    if (existing.ownerGeneration !== expectedOwnerGeneration) {
      return staleOwnerGenerationResponse();
    }
    if (localTurnRetirementDeadline(existing) <= Date.now()) {
      if (existing.cancelRequested) {
        await this.cancelLocalTurn(existing, true);
      } else {
        await this.expireLocalLease(existing, true);
      }
      return json(
        {
          code: existing.cancelRequested ? "turn_finished" : "turn_expired",
          message: existing.cancelRequested
            ? "That local turn was canceled."
            : "That local turn lease expired.",
          turnId: existing.turnId,
        },
        409,
      );
    }
    if (
      existing.turnId !== turnId ||
      existing.deviceId !== deviceId ||
      existing.localTurnId !== localTurnId ||
      existing.ownerId !== ownerId ||
      existing.leaseToken !== leaseToken
    ) {
      return json(
        {
          code: "lease_mismatch",
          message: "That local turn no longer owns this conversation.",
        },
        409,
      );
    }

    let renewed: LocalTurnLease | undefined;
    await this.ctx.blockConcurrencyWhile(async () => {
      const current =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (
        !current ||
        current.turnId !== turnId ||
        current.deviceId !== deviceId ||
        current.localTurnId !== localTurnId ||
        current.ownerId !== ownerId ||
        current.ownerGeneration !== expectedOwnerGeneration ||
        current.leaseToken !== leaseToken ||
        current.cancelRequested ||
        current.expiresAt <= Date.now() ||
        this.journal.turnState(turnId)?.state === "terminal"
      ) {
        return;
      }
      current.expiresAt = Date.now() + LOCAL_TURN_LEASE_MS;
      await this.ctx.storage.put(LOCAL_TURN_LEASE_KEY, current);
      const alarmAt = await this.ctx.storage.getAlarm();
      if (alarmAt === null || alarmAt > current.expiresAt) {
        await this.ctx.storage.setAlarm(current.expiresAt);
      }
      renewed = current;
    });
    if (!renewed) {
      return json(
        {
          code: "turn_finished",
          message: "That local turn is no longer running.",
          turnId,
        },
        409,
      );
    }
    await this.armLocalLeaseAlarm(renewed.expiresAt);
    try {
      await this.assertOwnerTurn(renewed);
    } catch {
      return json(
        { code: "owner_purge", message: "Cloud activity is being reset." },
        409,
      );
    }
    return json({
      turnId,
      leaseToken: renewed.leaseToken,
      expiresAt: renewed.expiresAt,
      replayed: true,
      renewed: true,
      history: [],
    });
  }

  private async handleLocalTurnBegin(request: Request): Promise<Response> {
    let body: {
      deviceId?: string;
      expectedOwnerGeneration?: string;
      localTurnId?: string;
      userMessageJson?: string;
      clientMsgId?: string;
      leaseToken?: string;
      renewOnly?: boolean;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    if (body.renewOnly === true) {
      const renewal = parseLocalTurnRenewal(body);
      if (!renewal) {
        return json(
          { code: "bad_request", message: "Malformed request." },
          400,
        );
      }
      const owner = await this.localTurnOwner(
        request,
        renewal.leaseToken,
        renewal.expectedOwnerGeneration,
      );
      if (owner instanceof Response) return owner;
      return this.handleLocalTurnRenewal(renewal, owner.ownerId);
    }
    const deviceId = body.deviceId?.trim() ?? "";
    const expectedOwnerGeneration = parseExpectedOwnerGeneration(
      body.expectedOwnerGeneration,
    );
    const localTurnId = body.localTurnId?.trim() ?? "";
    const clientMsgId = body.clientMsgId?.trim();
    if (
      !LOCAL_DEVICE_ID_PATTERN.test(deviceId) ||
      !expectedOwnerGeneration ||
      !LOCAL_TURN_ID_PATTERN.test(localTurnId) ||
      (body.renewOnly !== undefined && typeof body.renewOnly !== "boolean") ||
      (clientMsgId !== undefined &&
        !LOCAL_CLIENT_MSG_ID_PATTERN.test(clientMsgId))
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const owner = await this.localTurnOwner(
      request,
      undefined,
      expectedOwnerGeneration,
    );
    if (owner instanceof Response) return owner;
    const userMessageJson = body.userMessageJson ?? "";
    if (
      !userMessageJson ||
      utf8Length(userMessageJson) > LOCAL_TURN_BEGIN_MAX_BYTES
    ) {
      return json(
        { code: "too_large", message: "That message is too large." },
        413,
      );
    }
    let userMessage: AgentMessage;
    try {
      userMessage = JSON.parse(userMessageJson) as AgentMessage;
    } catch {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    if (
      (userMessage as { role?: unknown }).role !== "user" ||
      !Array.isArray((userMessage as { content?: unknown }).content)
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }

    const turnId = makeLocalTurnId(deviceId, localTurnId);
    const beginFingerprint = await sha256Hex(
      localClientMessageFingerprintSource(clientMsgId ?? "", userMessage),
    );
    const clientReceipt = clientMsgId
      ? await this.ctx.storage.get<LocalClientMessageReceipt>(
          localClientMessageKey(clientMsgId),
        )
      : undefined;
    const clientReplay = clientMsgId
      ? classifyLocalClientMessageReplay(clientReceipt, {
          ownerGeneration: expectedOwnerGeneration,
          clientMsgId,
          beginFingerprint,
          turnId,
        })
      : "new";
    if (clientReplay === "conflict") {
      return json(
        {
          code: "idempotency_conflict",
          message:
            "That client message id was already used for a different message.",
        },
        409,
      );
    }
    if (clientReplay === "duplicate") {
      return json(
        {
          code: "turn_finished",
          message: "That client message was already admitted.",
          turnId: clientReceipt?.turnId,
          ...(clientReceipt?.phase ? { phase: clientReceipt.phase } : {}),
        },
        409,
      );
    }
    const previous = await this.ctx.storage.get<LocalTurnFinishReceipt>(
      localTurnReceiptKey(turnId),
    );
    if (
      previous?.turnId === turnId &&
      previous.ownerGeneration !== expectedOwnerGeneration
    ) {
      return staleOwnerGenerationResponse();
    }
    if (previous?.turnId === turnId) {
      return json(
        {
          code: "turn_finished",
          message: "That local turn has already finished.",
          turnId,
          phase: previous.phase,
        },
        409,
      );
    }

    const existing =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (existing) {
      if (existing.ownerGeneration !== expectedOwnerGeneration) {
        return staleOwnerGenerationResponse();
      }
      if (localTurnRetirementDeadline(existing) <= Date.now()) {
        if (existing.cancelRequested) {
          await this.cancelLocalTurn(existing, true);
        } else {
          await this.expireLocalLease(existing, true);
        }
        return json(
          {
            code: existing.cancelRequested ? "turn_finished" : "turn_expired",
            message: existing.cancelRequested
              ? "That local turn was canceled."
              : "That local turn lease expired.",
            turnId: existing.turnId,
          },
          409,
        );
      }
      if (
        existing.turnId !== turnId ||
        existing.deviceId !== deviceId ||
        existing.localTurnId !== localTurnId
      ) {
        return json(
          {
            code: "turn_in_progress",
            message: "Another turn is already running in this conversation.",
            retryAfterMs: 3_000,
          },
          409,
        );
      }
      if (existing.beginFingerprint !== beginFingerprint) {
        return json(
          {
            code: "idempotency_conflict",
            message:
              "That local turn id was already used for a different message.",
          },
          409,
        );
      }
      let renewed: LocalTurnLease | undefined;
      await this.ctx.blockConcurrencyWhile(async () => {
        const current =
          await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
        if (
          !current ||
          current.turnId !== turnId ||
          current.ownerGeneration !== expectedOwnerGeneration ||
          current.leaseToken !== existing.leaseToken ||
          current.beginFingerprint !== beginFingerprint ||
          current.cancelRequested ||
          current.expiresAt <= Date.now() ||
          this.journal.turnState(turnId)?.state === "terminal"
        ) {
          return;
        }
        current.expiresAt = Date.now() + LOCAL_TURN_LEASE_MS;
        await this.ctx.storage.put(LOCAL_TURN_LEASE_KEY, current);
        const alarmAt = await this.ctx.storage.getAlarm();
        if (alarmAt === null || alarmAt > current.expiresAt) {
          await this.ctx.storage.setAlarm(current.expiresAt);
        }
        renewed = current;
      });
      if (!renewed) {
        return json(
          {
            code: "turn_finished",
            message: "That local turn is no longer running.",
            turnId,
          },
          409,
        );
      }
      await this.armLocalLeaseAlarm(renewed.expiresAt);
      try {
        await this.assertOwnerTurn(renewed);
      } catch {
        return json(
          { code: "owner_purge", message: "Cloud activity is being reset." },
          409,
        );
      }
      try {
        const context = await this.initializeLocalTurn(
          renewed,
          userMessage,
          userMessageJson,
        );
        await this.assertOwnerTurn(renewed);
        const finalLease =
          await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
        if (
          !finalLease ||
          finalLease.turnId !== renewed.turnId ||
          finalLease.leaseToken !== renewed.leaseToken ||
          finalLease.ownerGeneration !== expectedOwnerGeneration ||
          finalLease.cancelRequested
        ) {
          throw new OwnerPurgeFenceError();
        }
        return json({
          turnId,
          leaseToken: renewed.leaseToken,
          expiresAt: renewed.expiresAt,
          replayed: true,
          ...context,
        });
      } catch (error) {
        if (error instanceof OwnerPurgeFenceError) {
          return json(
            { code: "owner_purge", message: "Cloud activity is being reset." },
            409,
          );
        }
        log("error", "conversation_local_turn_begin_replay_failed", {
          turnId,
          message: errorMessage(error),
        });
        return json(
          {
            code: "begin_failed",
            message: "Starting that local turn failed. Try again.",
          },
          503,
        );
      }
    }

    if (
      this.journal.storedBytes() + utf8Length(userMessageJson) >
      CONVERSATION_MAX_STORED_BYTES
    ) {
      return json(
        {
          code: "conversation_full",
          message:
            "This conversation has reached its size limit. Start a new conversation to keep going.",
        },
        413,
      );
    }

    const lease: LocalTurnLease = {
      ownerId: owner.ownerId,
      ownerGeneration: owner.ownerGeneration,
      turnId,
      deviceId,
      localTurnId,
      leaseToken:
        crypto.randomUUID().replaceAll("-", "") +
        crypto.randomUUID().replaceAll("-", ""),
      expiresAt: Date.now() + LOCAL_TURN_LEASE_MS,
      beginFingerprint,
      ...(clientMsgId ? { clientMsgId } : {}),
    };
    try {
      lease.ownerPurgeGeneration = await this.registerOwnerTurn(
        lease,
        false,
        beginFingerprint,
      );
    } catch (error) {
      if (error instanceof OwnerFenceLeaseConflictError) {
        return json(
          {
            code: "idempotency_conflict",
            message:
              "That local turn id was already used for a different message.",
          },
          409,
        );
      }
      if (error instanceof OwnerFenceRegistrationUncertainError) {
        return json(
          {
            code: "owner_fence_registration_uncertain",
            message: "Starting that turn is still being reconciled. Try again.",
          },
          503,
        );
      }
      return json(
        { code: "owner_purge", message: "Cloud activity is being reset." },
        409,
      );
    }

    let acquired = false;
    let racedClientReplay: "duplicate" | "conflict" | null = null;
    await this.ctx.blockConcurrencyWhile(async () => {
      const [
        local,
        concurrentClientReceipt,
        cloudTurn,
        terminal,
        terminalDelivered,
        queued,
        editLock,
      ] = await Promise.all([
        this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY),
        clientMsgId
          ? this.ctx.storage.get<LocalClientMessageReceipt>(
              localClientMessageKey(clientMsgId),
            )
          : Promise.resolve(undefined),
        this.ctx.storage.get<ChatTurnRequest>("turn"),
        this.ctx.storage.get<boolean>("terminal"),
        this.ctx.storage.get<boolean>("terminalDelivered"),
        this.ctx.storage.list<ChatTurnRequest>({
          prefix: "queued:",
          limit: 1,
        }),
        this.activeConversationEditLock(),
      ]);
      const cloudBusy =
        Boolean(cloudTurn && terminal !== true) ||
        Boolean(cloudTurn && terminalDelivered !== true) ||
        queued.size > 0;
      if (local || cloudBusy || editLock || this.purged()) return;
      if (clientMsgId) {
        const replay = classifyLocalClientMessageReplay(
          concurrentClientReceipt,
          {
            ownerGeneration: expectedOwnerGeneration,
            clientMsgId,
            beginFingerprint,
            turnId,
          },
        );
        if (replay === "conflict") {
          racedClientReplay = "conflict";
          return;
        }
        if (replay !== "new") {
          racedClientReplay = "duplicate";
          return;
        }
      }
      await this.assertOwnerFenceLeaseReceiptActive(lease);
      const records: Record<string, unknown> = {
        [LOCAL_TURN_LEASE_KEY]: lease,
      };
      if (clientMsgId) {
        records[localClientMessageKey(clientMsgId)] = {
          ownerGeneration: expectedOwnerGeneration,
          clientMsgId,
          beginFingerprint,
          turnId,
        } satisfies LocalClientMessageReceipt;
      }
      await this.ctx.storage.put(records);
      const alarmAt = await this.ctx.storage.getAlarm();
      if (alarmAt === null || alarmAt > lease.expiresAt) {
        await this.ctx.storage.setAlarm(lease.expiresAt);
      }
      acquired = true;
    });
    if (!acquired) {
      await this.unregisterOwnerTurn(lease);
      if (racedClientReplay === "conflict") {
        return json(
          {
            code: "idempotency_conflict",
            message:
              "That client message id was already used for a different message.",
          },
          409,
        );
      }
      if (racedClientReplay === "duplicate") {
        return json(
          {
            code: "turn_finished",
            message: "That client message was already admitted.",
          },
          409,
        );
      }
      return json(
        {
          code: "turn_in_progress",
          message: "Another turn is already running in this conversation.",
          retryAfterMs: 3_000,
        },
        409,
      );
    }

    try {
      const context = await this.initializeLocalTurn(
        lease,
        userMessage,
        userMessageJson,
      );
      await this.assertOwnerTurn(lease);
      const finalLease =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (
        !finalLease ||
        finalLease.turnId !== lease.turnId ||
        finalLease.leaseToken !== lease.leaseToken ||
        finalLease.ownerGeneration !== expectedOwnerGeneration ||
        finalLease.cancelRequested
      ) {
        throw new OwnerPurgeFenceError();
      }
      return json({
        turnId,
        leaseToken: lease.leaseToken,
        expiresAt: lease.expiresAt,
        replayed: false,
        ...context,
      });
    } catch (error) {
      if (error instanceof OwnerPurgeFenceError) {
        return json(
          { code: "owner_purge", message: "Cloud activity is being reset." },
          409,
        );
      }
      log("error", "conversation_local_turn_begin_failed", {
        turnId,
        message: errorMessage(error),
      });
      return json(
        {
          code: "begin_failed",
          message: "Starting that local turn failed. Try again.",
        },
        503,
      );
    }
  }

  private async handleLocalTurnFinish(request: Request): Promise<Response> {
    let body: {
      deviceId?: string;
      expectedOwnerGeneration?: string;
      localTurnId?: string;
      leaseToken?: string;
      records?: Array<{
        ordinal?: number;
        role?: string;
        payloadJson?: string;
      }>;
      phase?: string;
      notice?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const deviceId = body.deviceId?.trim() ?? "";
    const expectedOwnerGeneration = parseExpectedOwnerGeneration(
      body.expectedOwnerGeneration,
    );
    const localTurnId = body.localTurnId?.trim() ?? "";
    const leaseToken = body.leaseToken?.trim() ?? "";
    const terminalPhase = parseLocalTerminalPhase(body.phase);
    const parsedRecords = parseLocalFinishRecords(
      body.records ?? [],
      LOCAL_TURN_FINISH_MAX_ROWS,
    );
    if (
      !LOCAL_DEVICE_ID_PATTERN.test(deviceId) ||
      !expectedOwnerGeneration ||
      !LOCAL_TURN_ID_PATTERN.test(localTurnId) ||
      !/^[a-f0-9]{64}$/.test(leaseToken) ||
      !terminalPhase ||
      !parsedRecords
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const owner = await this.localTurnOwner(
      request,
      leaseToken,
      expectedOwnerGeneration,
    );
    if (owner instanceof Response) return owner;
    const turnId = makeLocalTurnId(deviceId, localTurnId);
    const { records: parsed, totalBytes } = parsedRecords;
    const finishFingerprint = await sha256Hex(
      JSON.stringify({
        expectedOwnerGeneration,
        phase: terminalPhase,
        notice: body.notice?.trim() ?? "",
        records: parsed.map(({ ordinal, role, payloadJson }) => ({
          ordinal,
          role,
          payloadJson,
        })),
      }),
    );
    const previous = await this.ctx.storage.get<LocalTurnFinishReceipt>(
      localTurnReceiptKey(turnId),
    );
    if (
      previous?.turnId === turnId &&
      previous.ownerGeneration !== expectedOwnerGeneration
    ) {
      return staleOwnerGenerationResponse();
    }
    if (
      previous?.turnId === turnId &&
      previous.deviceId === deviceId &&
      previous.localTurnId === localTurnId &&
      previous.leaseToken === leaseToken
    ) {
      if (previous.externallyCanceled) {
        if (terminalPhase !== "canceled") {
          return json(
            {
              code: "turn_canceled",
              message: "That local turn was already canceled.",
              turnId,
            },
            409,
          );
        }
      } else if (!previous.finishFingerprint) {
        return json(
          {
            code: "turn_expired",
            message: "That local turn lease expired.",
            turnId,
          },
          409,
        );
      } else if (previous.finishFingerprint !== finishFingerprint) {
        return json(
          {
            code: "idempotency_conflict",
            message:
              "That local turn was already finished with different records.",
          },
          409,
        );
      }
      const replayLease =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (
        replayLease?.turnId === turnId &&
        replayLease.leaseToken === leaseToken
      ) {
        this.live = null;
        this.hub.endTurn(turnId);
        await this.unregisterOwnerTurn(replayLease);
        await this.releaseLocalLeaseAndResume(replayLease);
      }
      return json({ ...previous, replayed: true });
    }

    if (totalBytes > LOCAL_TURN_FINISH_MAX_BYTES) {
      return json(
        {
          code: "too_large",
          message: "That's more history than one request can carry.",
        },
        413,
      );
    }
    if (
      this.journal.storedBytes() + totalBytes >
      CONVERSATION_MAX_STORED_BYTES
    ) {
      return json(
        {
          code: "conversation_full",
          message:
            "This conversation has reached its size limit. Start a new conversation to keep going.",
        },
        413,
      );
    }

    let lease =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (
      !lease ||
      lease.ownerId !== owner.ownerId ||
      lease.ownerGeneration !== expectedOwnerGeneration ||
      lease.turnId !== turnId ||
      lease.deviceId !== deviceId ||
      lease.localTurnId !== localTurnId ||
      lease.leaseToken !== leaseToken
    ) {
      return json(
        {
          code: "lease_mismatch",
          message: "That local turn no longer owns this conversation.",
        },
        409,
      );
    }
    if (localTurnRetirementDeadline(lease) <= Date.now()) {
      if (lease.cancelRequested) {
        await this.cancelLocalTurn(lease, true);
      } else {
        await this.expireLocalLease(lease, true);
      }
      return json(
        {
          code: lease.cancelRequested ? "turn_finished" : "turn_expired",
          message: lease.cancelRequested
            ? "That local turn was canceled."
            : "That local turn lease expired.",
          turnId,
        },
        409,
      );
    }
    let claimedLease: LocalTurnLease | undefined;
    let idempotencyConflict = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      const current =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (
        !current ||
        current.ownerId !== owner.ownerId ||
        current.ownerGeneration !== expectedOwnerGeneration ||
        current.turnId !== turnId ||
        current.deviceId !== deviceId ||
        current.localTurnId !== localTurnId ||
        current.leaseToken !== leaseToken ||
        current.expiresAt <= Date.now() ||
        current.cancelRequested
      ) {
        return;
      }
      if (
        current.finishFingerprint &&
        current.finishFingerprint !== finishFingerprint
      ) {
        idempotencyConflict = true;
        return;
      }
      current.finishFingerprint = finishFingerprint;
      current.expiresAt = Date.now() + LOCAL_TURN_LEASE_MS;
      await this.ctx.storage.put(LOCAL_TURN_LEASE_KEY, current);
      const alarmAt = await this.ctx.storage.getAlarm();
      if (alarmAt === null || alarmAt > current.expiresAt) {
        await this.ctx.storage.setAlarm(current.expiresAt);
      }
      claimedLease = current;
    });
    if (idempotencyConflict) {
      return json(
        {
          code: "idempotency_conflict",
          message:
            "That local turn was already finished with different records.",
        },
        409,
      );
    }
    if (!claimedLease) {
      return json(
        {
          code: "lease_mismatch",
          message: "That local turn no longer owns this conversation.",
        },
        409,
      );
    }
    lease = claimedLease;
    try {
      await this.assertOwnerTurn(lease);
    } catch {
      return json(
        { code: "owner_purge", message: "Cloud activity is being reset." },
        409,
      );
    }

    const prepared: Array<{
      ordinal: number;
      role: "assistant" | "toolResult";
      message: AgentMessage;
      payloadJson: string;
      spillKey?: string;
    }> = [];
    for (const record of parsed) {
      const sized = await this.prepareOversize(
        record.role,
        record.message,
        record.payloadJson,
        `turn:${turnId}:msg:${record.ordinal}`,
      );
      prepared.push({
        ...record,
        message: sized.message,
        payloadJson: sized.payloadJson,
        ...(sized.spillKey ? { spillKey: sized.spillKey } : {}),
      });
    }

    const current =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (
      this.purged() ||
      !current ||
      current.turnId !== turnId ||
      current.leaseToken !== leaseToken ||
      current.ownerGeneration !== expectedOwnerGeneration ||
      current.cancelRequested ||
      current.finishFingerprint !== finishFingerprint
    ) {
      return json(
        {
          code: "lease_mismatch",
          message: "That local turn no longer owns this conversation.",
        },
        409,
      );
    }

    const budgetArgs = {
      bytes: totalBytes,
      windowMs: APPEND_WINDOW_MS,
      maxRequests: APPEND_WINDOW_MAX_REQUESTS,
      maxBytes: APPEND_WINDOW_MAX_BYTES,
    };
    const budget = this.journal.appendBudget({
      ...budgetArgs,
      now: Date.now(),
      commit: false,
    });
    if (!budget.allowed) {
      return json(
        {
          code: "rate_limited",
          message:
            "That's more history than this conversation can take right now.",
          retryAfterMs: budget.retryAfterMs,
        },
        429,
      );
    }

    let firstSeq: number | null = null;
    let lastSeq = -1;
    const terminalAt = Date.now();
    try {
      this.journal.appendBudget({
        ...budgetArgs,
        now: terminalAt,
        commit: true,
      });
      for (const record of prepared) {
        const row = this.journal.appendMessage({
          turnId,
          writer: `desktop:${deviceId}`,
          writerKey: `turn:${turnId}:msg:${record.ordinal}`,
          role: record.role,
          message: record.message,
          payloadJson: record.payloadJson,
          ...(record.spillKey ? { spillKey: record.spillKey } : {}),
          createdAt: terminalAt,
        });
        if (firstSeq === null) firstSeq = row.seq;
        lastSeq = row.seq;
        this.journal.setTurnSpan(turnId, row.seq);
        if (row.inserted) this.publish(row.record);
      }
      const terminal = this.journal.appendTurn({
        turnId,
        writer: `desktop:${deviceId}`,
        writerKey: `turn:${turnId}:phase:${terminalPhase}`,
        phase: terminalPhase,
        lane: "chat",
        source: "desktop",
        ...(body.notice?.trim()
          ? { notice: body.notice.trim().slice(0, 500) }
          : {}),
        createdAt: terminalAt,
      });
      if (firstSeq === null) firstSeq = terminal.seq;
      lastSeq = terminal.seq;
      this.journal.setTurnSpan(turnId, terminal.seq);
      this.journal.setTurnTerminal(turnId, terminalPhase, terminalAt);
      if (terminal.inserted) this.publish(terminal.record);
    } catch (error) {
      log("error", "conversation_local_turn_finish_failed", {
        turnId,
        message: errorMessage(error),
      });
      return json(
        {
          code: "finish_failed",
          message: "Saving that local turn failed. Try again.",
        },
        503,
      );
    }

    const receipt: LocalTurnFinishReceipt = {
      ownerGeneration: lease.ownerGeneration,
      turnId,
      deviceId,
      localTurnId,
      leaseToken,
      phase: terminalPhase,
      firstSeq: firstSeq ?? lastSeq,
      lastSeq,
      epoch: this.journal.meta().epoch,
      finishFingerprint,
    };
    await this.storeLocalTurnReceipt(lease, receipt);
    this.live = null;
    this.hub.endTurn(turnId);
    await this.unregisterOwnerTurn(lease);
    await this.releaseLocalLeaseAndResume(lease);
    this.recordExcerpt(turnId);
    await this.index
      .flush({ activity: "idle", updatedAt: terminalAt })
      .catch(() => undefined);
    try {
      this.drainInbox();
    } catch (error) {
      log("error", "conversation_local_turn_finish_drain_failed", {
        turnId,
        message: errorMessage(error),
      });
    }
    await this.archive.maybeRollover(terminalAt).catch((error) => {
      log("error", "conversation_local_turn_finish_rollover_failed", {
        turnId,
        message: errorMessage(error),
      });
    });
    return json({ ...receipt, replayed: false });
  }

  /**
   * Realtime voice records, written into the cloud conversation without
   * pretending the voice provider owns the text-turn lease. The authenticated
   * owner comparison preserves lane scope, and the strict parser below accepts
   * message records only — no caller can manufacture turn lifecycle rows.
   */
  private async handleJournalAppend(request: Request): Promise<Response> {
    const ownerId = request.headers.get("x-stella-owner") ?? "";
    if (!ownerId) return json({ error: "Unauthorized." }, 401);
    if (this.purged()) {
      return json(
        { code: "deleted", message: "This conversation was deleted." },
        410,
      );
    }
    let body: {
      deviceId?: string;
      expectedOwnerGeneration?: unknown;
      localTurnId?: string;
      source?: unknown;
      records?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const deviceId = body.deviceId?.trim();
    const expectedOwnerGeneration = parseExpectedOwnerGeneration(
      body.expectedOwnerGeneration,
    );
    const localTurnId = body.localTurnId?.trim();
    const records = body.records;
    if (
      !deviceId ||
      !LOCAL_DEVICE_ID_PATTERN.test(deviceId) ||
      !expectedOwnerGeneration ||
      !localTurnId ||
      !LOCAL_TURN_ID_PATTERN.test(localTurnId) ||
      body.source !== "voice" ||
      !Array.isArray(records) ||
      records.length === 0
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const ownerRecord = await this.lookupOwner(true);
    // Voice append is a fresh owner write. A definite missing/invalid Convex
    // owner response must not fall back to the DO's cached binding or cached
    // lifecycle generation, including on idempotent receipt replay.
    if (!ownerRecord) {
      return json({ error: "Conversation not found." }, 404);
    }
    const bound = this.journal.ownerId() || ownerRecord.ownerId;
    if (!bound) return json({ error: "Conversation not found." }, 404);
    if (bound !== ownerId)
      return json({ error: "Conversation not found." }, 404);
    const currentOwnerGeneration = ownerRecord.ownerGeneration;
    if (currentOwnerGeneration !== expectedOwnerGeneration) {
      return json(
        {
          code: "owner_generation_stale",
          message: "This cloud owner generation is no longer current.",
        },
        409,
      );
    }
    if (records.length > APPEND_MAX_ROWS) {
      return json(
        {
          code: "too_many_records",
          message: "That's more history than one request can carry.",
        },
        413,
      );
    }
    const parsedRecords = parseVoiceJournalRecords(records);
    if (!parsedRecords) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    let totalBytes = 0;
    for (const record of parsedRecords)
      totalBytes += utf8Length(record.payloadJson);
    if (totalBytes > APPEND_MAX_BYTES) {
      return json(
        {
          code: "too_large",
          message: "That's more history than one request can carry.",
        },
        413,
      );
    }
    const source = "voice" as const;
    const receiptKey = `${source}:${deviceId}:${localTurnId}`;
    const turnId = `${source}:${deviceId}:${localTurnId}`;
    const appendLease: OwnerFencedTurn = {
      ownerId: bound,
      ownerGeneration: expectedOwnerGeneration,
      turnId,
    };
    try {
      appendLease.ownerPurgeGeneration = await this.registerOwnerTurn(
        appendLease,
        true,
      );
    } catch {
      return json(
        { code: "owner_purge", message: "Cloud activity is being reset." },
        409,
      );
    }
    let settleAppend!: () => void;
    const appendSettled = new Promise<void>((resolve) => {
      settleAppend = resolve;
    });
    const activeAppend = { lease: appendLease, settled: appendSettled };
    const appendLeaseId = appendLease.ownerPurgeLeaseId;
    if (!appendLeaseId) {
      await this.unregisterOwnerTurn(appendLease);
      return json(
        { code: "owner_purge", message: "Cloud activity is being reset." },
        409,
      );
    }
    this.ownerFencedAppends.set(appendLeaseId, activeAppend);
    try {
      const fingerprint = await sha256Hex(
        JSON.stringify({
          deviceId,
          expectedOwnerGeneration,
          localTurnId,
          source,
          records,
        }),
      );
      const receiptResponse = (): Response | null => {
        const receipt = this.journal.appendReceipt(receiptKey);
        if (!receipt) return null;
        if (receipt.fingerprint !== fingerprint) {
          return json(
            {
              code: "idempotency_conflict",
              message: "That append id was already used for different history.",
            },
            409,
          );
        }
        return json({
          firstSeq: receipt.first_seq,
          lastSeq: receipt.last_seq,
          epoch: receipt.epoch,
          replayed: true,
        });
      };
      const replay = receiptResponse();
      if (replay) return replay;
      // The lifetime ceiling. Resident bytes alone would not bound this —
      // rollover moves them to R2, and an oversize row spills there directly —
      // so `storedBytes` counts archived segments and spill objects too, and a
      // conversation cannot grow forever by pushing its bytes out of SQLite.
      const storedBytes = this.journal.storedBytes();
      if (storedBytes + totalBytes > CONVERSATION_MAX_STORED_BYTES) {
        log("error", "conversation_storage_ceiling", {
          conversationId: this.conversationId(),
          storedBytes,
        });
        return json(
          {
            code: "conversation_full",
            message:
              "This conversation has reached its size limit. Start a new conversation to keep going.",
          },
          413,
        );
      }
      // Per-request caps bound one request; the window bounds a loop of them.
      // Tested here, before any R2 spill, so a runaway client is refused before
      // it can make the DO do work — and charged only once the rows are
      // committed, below, so a 409 against a running turn never eats the
      // allowance the client needs in order to retry.
      const budgetArgs = {
        bytes: totalBytes,
        windowMs: APPEND_WINDOW_MS,
        maxRequests: APPEND_WINDOW_MAX_REQUESTS,
        maxBytes: APPEND_WINDOW_MAX_BYTES,
      };
      const probe = this.journal.appendBudget({
        ...budgetArgs,
        now: Date.now(),
        commit: false,
      });
      if (!probe.allowed) {
        return json(
          {
            code: "rate_limited",
            message:
              "That's more history than this conversation can take right now.",
            retryAfterMs: probe.retryAfterMs,
          },
          429,
        );
      }
      // The running-turn refusal, taken twice for two different reasons. This
      // one is about cost: the spilling below writes to R2, and the check that
      // can refuse this request must not sit behind it — a client that keeps
      // asking while a turn runs would otherwise pay for every one of those
      // objects with a 409 and, because the window is charged only on the
      // committed path, no rate accounting at all.
      if (await this.turnRunning()) {
        return json(
          {
            code: "turn_in_progress",
            message: "Stella is mid-reply — try again in a moment.",
            retryAfterMs: 3_000,
          },
          409,
        );
      }
      // Everything that can await — parsing, oversize spilling — happens BEFORE
      // the second running-turn check, so that check and the appends form one
      // uninterrupted block. An await between them would reopen the input gate
      // and let a turn start in the gap, which is the one ordering that can
      // splice a foreign row between a tool call and its result.
      const now = Date.now();
      const prepared: Array<{
        kind: "message";
        writerKey: string;
        role: MessageRole;
        hidden: boolean;
        message: AgentMessage;
        payloadJson: string;
        spillKey?: string;
      }> = [];
      for (let ordinal = 0; ordinal < parsedRecords.length; ordinal += 1) {
        const record = parsedRecords[ordinal]!;
        const writerKey = `${source}:${deviceId}:${localTurnId}:${ordinal}`;
        const sized = await this.prepareOversize(
          record.role,
          record.message,
          record.payloadJson,
          writerKey,
        );
        prepared.push({
          kind: "message",
          writerKey,
          role: record.role,
          hidden: record.hidden,
          message: sized.message,
          payloadJson: sized.payloadJson,
          ...(sized.spillKey ? { spillKey: sized.spillKey } : {}),
        });
      }

      try {
        // Registration keeps generation rotation waiting; this second check
        // catches a purge that closed the fence while R2 oversize preparation
        // was in flight, before the SQLite transaction can append anything.
        await this.assertOwnerTurn(appendLease);
      } catch {
        return json(
          { code: "owner_purge", message: "Cloud activity is being reset." },
          409,
        );
      }

      let firstSeq: number | null = null;
      let lastSeq = -1;
      const publishAfterCommit: JournalRecord[] = [];
      let finalResponse: Response | null = null;
      let appendFailure: unknown;
      // Everything below is one input-gate critical section. The storage reads
      // may yield, but `blockConcurrencyWhile` prevents a queued text turn or an
      // owner transfer from being admitted between the final checks and the
      // synchronous journal transaction.
      await this.ctx.blockConcurrencyWhile(async () => {
        if (
          await this.ctx.storage.get<OwnerTransferRequest>(OWNER_TRANSFER_KEY)
        ) {
          finalResponse = json(
            {
              code: "owner_transfer_in_progress",
              message: "Conversation ownership is being updated.",
              retryAfterMs: 3_000,
            },
            409,
          );
          return;
        }
        if (await this.turnRunning()) {
          finalResponse = json(
            {
              code: "turn_in_progress",
              message: "Stella is mid-reply — try again in a moment.",
              retryAfterMs: 3_000,
            },
            409,
          );
          return;
        }
        if (this.purged()) {
          finalResponse = json(
            { code: "deleted", message: "This conversation was deleted." },
            410,
          );
          return;
        }
        const racedReplay = receiptResponse();
        if (racedReplay) {
          finalResponse = racedReplay;
          return;
        }
        try {
          // Synchronous, and inside the same uninterrupted block as the appends:
          // this is the request the window is actually paying for.
          this.journal.appendBudget({ ...budgetArgs, now, commit: true });
          const writer = `${source}:${deviceId}`;
          // Registered in the projection so a foreign turn is also a legal
          // rollover boundary; without it a chatty desktop could wedge every cut
          // point behind rows no cut is allowed to land on.
          this.journal.transactionSync(() => {
            this.journal.upsertTurn({
              turnId,
              sessionId: `${source}-${deviceId}`.slice(0, 64),
              ownerId: bound,
              lane: "chat",
              source,
              state: "terminal",
              now,
            });
            for (const entry of prepared) {
              const appended = this.journal.appendMessage({
                turnId,
                writer,
                writerKey: entry.writerKey,
                role: entry.role,
                hidden: entry.hidden,
                message: entry.message,
                payloadJson: entry.payloadJson,
                ...(entry.spillKey ? { spillKey: entry.spillKey } : {}),
                createdAt: now,
              });
              if (firstSeq === null) firstSeq = appended.seq;
              lastSeq = appended.seq;
              this.journal.setTurnSpan(turnId, appended.seq);
              if (appended.inserted) publishAfterCommit.push(appended.record);
            }
            this.journal.setTurnTerminal(turnId, "completed", now);
            this.journal.putAppendReceipt({
              writerKey: receiptKey,
              fingerprint,
              firstSeq: firstSeq ?? lastSeq,
              lastSeq,
              epoch: this.journal.meta().epoch,
              createdAt: now,
            });
          });
        } catch (error) {
          appendFailure = error;
        }
      });
      if (finalResponse) return finalResponse;
      if (appendFailure) {
        if (appendFailure instanceof ConversationDeletedError) {
          return json(
            { code: "deleted", message: "This conversation was deleted." },
            410,
          );
        }
        log("error", "conversation_desktop_append_failed", {
          deviceId,
          localTurnId,
          message: errorMessage(appendFailure),
        });
        return json(
          {
            code: "append_failed",
            message: "Saving that to the cloud conversation failed. Try again.",
          },
          503,
        );
      }
      for (const record of publishAfterCommit) this.publish(record);
      void this.index
        .flush({ activity: "idle", updatedAt: now })
        .catch(() => undefined);
      // Rollover, at the one boundary this route can offer. `afterTerminal` used
      // to be its only trigger, so a conversation written only through here —
      // every desktop-mirrored conversation, once that trigger is wired — never
      // evaluated HOT_MAX_ROWS at all and grew with its lifetime writes. The
      // running-turn re-check is not redundant with the one above: the appends
      // between them yield, and rollover mid-turn is forbidden.
      if (!(await this.turnRunning())) {
        await this.archive.maybeRollover(Date.now());
      }
      return json({
        firstSeq: firstSeq ?? lastSeq,
        lastSeq,
        epoch: this.journal.meta().epoch,
        replayed: false,
      });
    } finally {
      await this.unregisterOwnerTurn(appendLease);
      if (this.ownerFencedAppends.get(appendLeaseId) === activeAppend) {
        this.ownerFencedAppends.delete(appendLeaseId);
      }
      settleAppend();
    }
  }

  /**
   * Oversize rows go to R2 rather than throwing a >2 MB INSERT. Assistant
   * messages are truncated instead of spilled: a placeholder for an assistant
   * message would drop its toolCall blocks and orphan every result that
   * follows, which is the one degradation the provider rejects outright.
   */
  private async prepareOversize(
    role: MessageRole,
    message: AgentMessage,
    payloadJson: string,
    writerKey: string,
  ): Promise<{
    message: AgentMessage;
    payloadJson: string;
    spillKey?: string;
  }> {
    if (utf8Length(payloadJson) <= MAX_ROW_BYTES) {
      return { message, payloadJson };
    }
    if (role !== "assistant") {
      const spillKey = await this.archive
        .writeSpill(writerKey, payloadJson)
        .catch(() => null);
      if (spillKey) return { message, payloadJson, spillKey };
    }
    const truncated = truncateMessage(message, MAX_ROW_BYTES);
    const truncatedJson = JSON.stringify(truncated);
    if (utf8Length(truncatedJson) > MAX_ROW_BYTES) {
      throw new Error("Oversize message spill failed.");
    }
    return { message: truncated, payloadJson: truncatedJson };
  }

  /**
   * Cards written by Convex on a non-chat terminal (build, operation) and on
   * agent-thread completion (files). As journal rows they survive scrollback,
   * which an `agent_events` row inside a `take(100)` window never did.
   */
  private async handleCard(request: Request): Promise<Response> {
    let body: {
      ownerId?: string;
      ownerGeneration?: string;
      sourceTurnId?: string;
      card?: ConversationCard;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "Malformed request." }, 400);
    }
    const sourceTurnId = body.sourceTurnId?.trim();
    const ownerId = body.ownerId?.trim();
    const ownerGeneration = body.ownerGeneration?.trim();
    const card = body.card;
    if (!ownerId || !ownerGeneration || !sourceTurnId || !card?.type) {
      return json({ error: "Malformed request." }, 400);
    }
    if (this.purged()) {
      return json({ error: "This conversation was deleted." }, 410);
    }
    // A build- or operation-only conversation reaches this handler having never
    // run an orchestrator turn, so `meta.owner_id` is still empty and an index
    // flush would be a no-op. Bind first: without it the row keeps `lastSeq`
    // null and the orphan sweep eventually deletes a conversation that has real
    // content. Failure is not fatal — the card still lands and the next socket
    // connect binds and flushes.
    try {
      const owner = await this.lookupOwner(true);
      if (
        !owner ||
        owner.ownerId !== ownerId ||
        owner.ownerGeneration !== ownerGeneration
      ) {
        return json({ error: "Conversation generation is stale." }, 409);
      }
    } catch (error) {
      log("error", "conversation_card_owner_lookup_failed", {
        sourceTurnId,
        message: errorMessage(error),
      });
      return json({ error: "Conversation owner is unavailable." }, 409);
    }
    const writerKey = `card:${sourceTurnId}:${card.type}`;
    const payloadJson = JSON.stringify(card);
    const now = Date.now();
    if (utf8Length(payloadJson) > MAX_ROW_BYTES) {
      return json({ error: "Card payload is too large." }, 413);
    }
    try {
      // The owner lookup above yields, so the tombstone is re-read here for the
      // same reason the append route re-reads it.
      if (this.purged()) {
        return json({ error: "This conversation was deleted." }, 410);
      }
      if (await this.activeConversationEditLock()) {
        return json(
          {
            code: "conversation_edit_in_progress",
            message: "This conversation is being edited. Try again shortly.",
            retryAfterMs: 1_000,
          },
          409,
        );
      }
      if (await this.turnRunning()) {
        const size = this.journal.inboxSize();
        if (size.rows >= INBOX_MAX_ROWS || size.bytes >= INBOX_MAX_BYTES) {
          return json(
            {
              code: "inbox_full",
              message: "Stella is mid-reply — try again in a moment.",
              retryAfterMs: 5_000,
            },
            429,
          );
        }
        this.journal.stageInbox({
          writer: "convex",
          writerKey,
          kind: "card",
          turnId: sourceTurnId,
          payloadJson,
          now,
        });
        return json({ staged: true });
      }
      const appended = this.journal.appendCard({
        turnId: sourceTurnId,
        writer: "convex",
        writerKey,
        card,
        createdAt: now,
      });
      this.publish(appended.record);
      void this.index
        .flush({ activity: "idle", updatedAt: now })
        .catch(() => undefined);
      // Same reason as the journal route: a build- or operation-only
      // conversation runs no orchestrator turn, so this is the only place its
      // resident set is ever measured.
      if (!(await this.turnRunning())) {
        await this.archive.maybeRollover(Date.now());
      }
      return json({ seq: appended.seq });
    } catch (error) {
      log("error", "conversation_card_failed", {
        sourceTurnId,
        message: errorMessage(error),
      });
      return json({ error: "Recording that card failed." }, 503);
    }
  }

  /**
   * Tombstone, quiesce, snapshot, drain, then destroy — in that order and no
   * other. `deleteAll()` destroys the segment manifest, which is the only
   * record of the R2 keys; running it before the drain leaves the user's
   * deleted transcript in R2 forever with nothing left that can find it.
   *
   * The two middle steps are what make the snapshot complete rather than
   * merely current. A rollover or a spill that was already in flight when the
   * tombstone landed registers its key AFTER this handler would otherwise have
   * read the manifest — and an object named by nobody survives `deleteAll()`
   * with no per-conversation path left that can ever reach it. So: the
   * tombstone stops new writes starting, `quiesce()` waits out the ones
   * already running, and only then is the key list taken.
   *
   * Incomplete drains report `purged: false` and are retried by Convex's cron
   * rather than by a DO alarm: the alarm belongs to the turn lifecycle, and
   * borrowing it here would put a deletion bug inside the terminal-delivery
   * ladder. The 202 is load-bearing on the Convex side —
   * `purgeConversationInternal` reads this body's `purged`, never the status
   * class, precisely because `response.ok` is true for it.
   */
  private async handlePurge(): Promise<Response> {
    const now = Date.now();
    this.journal.markDeleted(now);
    this.sealed = true;
    this.archive.seal();
    this.hub.closeAll(CLOSE_DELETED);
    await this.archive.quiesce();
    // `segments` and `spills` outlive the drain — only the queue rows are
    // removed — so what has already been offered has to be remembered here, or
    // the re-check below would re-delete every key on every purge.
    const enqueued = new Set<string>();
    const enqueueNewKeys = (): number => {
      const keys = [
        ...this.journal.allSegmentKeys(),
        ...this.journal.allSpillKeys(),
      ].filter((key) => !enqueued.has(key));
      for (const key of keys) enqueued.add(key);
      this.journal.enqueuePurge(keys, now);
      return keys.length;
    };
    enqueueNewKeys();
    let { pending } = await this.archive.drainPurge();
    // The drain itself awaits, and a tombstone is a fence rather than a lock.
    // Re-reading the manifest costs two queries and is what turns "nothing can
    // have been added behind us" from an argument into a check.
    if (pending === 0 && enqueueNewKeys() > 0) {
      pending = (await this.archive.drainPurge()).pending;
    }
    if (pending > 0) {
      log("error", "conversation_purge_incomplete", {
        conversationId: this.conversationId(),
        pending,
      });
      return json({ purged: false, pending }, 202);
    }
    const purgedId = this.conversationId();
    await this.ctx.storage.deleteAll();
    // The queue and its wake signal, explicitly and last.
    //
    // `deleteAll()` swept the queue that existed when this handler started; a
    // dispatch delivered while it was awaiting writes a fresh `queued:` key
    // behind it. In this isolate the seal drops that turn — but the seal is
    // in-memory, and a cold start after an eviction would re-enqueue it and run
    // a turn against the empty journal of a conversation Convex has already
    // recorded as deleted. Dropping the key is the durable half of the seal.
    //
    // The alarm goes with it rather than being left to `deleteAll()`: nothing
    // is queued any more, so there is no wake to guarantee, and an alarm
    // surviving here wakes a destroyed conversation on a timer for no work.
    await this.ctx.blockConcurrencyWhile(async () => {
      const stragglers = await this.ctx.storage.list({ prefix: "queued:" });
      for (const key of stragglers.keys()) await this.ctx.storage.delete(key);
      await this.ctx.storage.deleteAlarm();
      if (stragglers.size > 0) {
        log("info", "conversation_purge_dropped_queued", {
          conversationId: this.ctx.id.name ?? "",
          dropped: stragglers.size,
        });
      }
    });
    // `deleteAll()` drops the tables, but THIS instance keeps serving: its
    // `Journal` was bootstrapped in the constructor and every method still
    // issues SQL. Without re-running the DDL the next request to reach this
    // object — a stale tab's socket upgrade, the dev probe, a retried sweep —
    // dies on `no such table: segments` and the worker answers 500 until the
    // platform happens to evict the object. Re-bootstrapping leaves an empty,
    // unbound journal, which is what turns those requests back into the
    // refusal they are supposed to be: `lookupOwner` finds no Convex row and
    // the socket closes 4404 "That conversation no longer exists."
    await this.journal.bootstrap();
    if (this.ctx.id.name) this.journal.setConversationId(this.ctx.id.name);
    log("info", "conversation_purged", { conversationId: purgedId });
    return json({ purged: true });
  }

  /**
   * Rebuilds the Convex search projection from this object. The excerpts are
   * mirrored locally precisely so this never has to read an R2 segment.
   *
   * Every excerpt is replayed, not the first batch: this is the documented way
   * to regenerate a lost `cloud_message_excerpts`, and a rebuild that silently
   * covered the oldest 50 turns would make that claim false. The reply says
   * how many turns are still owed, and answers 202 rather than 200 when the
   * budget ran out before the backlog did — re-run it to continue.
   */
  private async handleReindex(): Promise<Response> {
    if (this.purged()) {
      return json({ error: "This conversation was deleted." }, 410);
    }
    const result = await this.index.flush({
      activity: this.live ? "running" : "idle",
      updatedAt: Date.now(),
      force: true,
      maxBatches: REINDEX_MAX_BATCHES,
      budgetMs: REINDEX_BUDGET_MS,
    });
    const complete = result.pendingExcerpts === 0;
    return json(
      {
        reindexed: result.accepted,
        complete,
        pendingExcerpts: result.pendingExcerpts,
      },
      complete ? 200 : 202,
    );
  }

  /**
   * Advances the durable control receipt for one reusable cloud-agent thread.
   * Attempt generation is the primary ABA fence; updatedAt orders state within
   * an attempt. Older server responses are harmless, while two different
   * states claiming the same exact revision fail closed as protocol damage.
   */
  private async rememberCloudAgentControlReceipt(
    value: unknown,
  ): Promise<CloudAgentControlReceipt> {
    const receipt = normalizeCloudAgentControlReceipt(value);
    if (!receipt) {
      throw new Error("Cloud agent returned an invalid control receipt.");
    }
    const key = cloudAgentControlKey(receipt.threadId);
    const rawExisting = await this.ctx.storage.get<unknown>(key);
    const existing = normalizeCloudAgentControlReceipt(rawExisting);
    if (rawExisting !== undefined && !existing) {
      throw new Error("Cloud agent control state is corrupt.");
    }
    const advanced = advanceCloudAgentControlReceipt(existing, receipt);
    if (advanced !== existing) await this.ctx.storage.put(key, advanced);
    return advanced;
  }

  private async readCloudAgentToolOutcome(
    turn: ChatTurnRequest,
    toolCallId: string,
    kind: CloudAgentToolKind,
    fingerprint: string,
  ): Promise<CloudAgentToolOutcome | null> {
    const raw = await this.ctx.storage.get<unknown>(
      cloudAgentToolOutcomeKey(turn.turnId, toolCallId),
    );
    if (raw === undefined) return null;
    if (!raw || typeof raw !== "object") {
      throw new Error("Cloud agent tool outcome is corrupt.");
    }
    const candidate = raw as Partial<CloudAgentToolOutcome>;
    const control = normalizeCloudAgentControlReceipt(candidate.control);
    if (
      candidate.kind !== kind ||
      typeof candidate.fingerprint !== "string" ||
      !candidate.fingerprint ||
      !control ||
      (candidate.disposition !== undefined &&
        !["paused", "pending", "already_terminal"].includes(
          candidate.disposition,
        ))
    ) {
      throw new Error("Cloud agent tool outcome is corrupt.");
    }
    if (candidate.fingerprint !== fingerprint) {
      throw new Error("That cloud agent tool call was replayed differently.");
    }
    const controlKey = cloudAgentControlKey(control.threadId);
    const rawCurrent = await this.ctx.storage.get<unknown>(controlKey);
    const current = normalizeCloudAgentControlReceipt(rawCurrent);
    if (rawCurrent !== undefined && !current) {
      throw new Error("Cloud agent control state is corrupt.");
    }
    const advanced = advanceCloudAgentControlReceipt(current, control);
    if (advanced !== current) await this.ctx.storage.put(controlKey, advanced);
    return {
      kind,
      fingerprint,
      control,
      ...(candidate.disposition ? { disposition: candidate.disposition } : {}),
    };
  }

  private async commitCloudAgentToolOutcome(
    turn: ChatTurnRequest,
    toolCallId: string,
    kind: CloudAgentToolKind,
    fingerprint: string,
    value: unknown,
    disposition?: CloudAgentToolOutcome["disposition"],
  ): Promise<CloudAgentToolOutcome> {
    const existingOutcome = await this.readCloudAgentToolOutcome(
      turn,
      toolCallId,
      kind,
      fingerprint,
    );
    if (existingOutcome) return existingOutcome;
    const receipt = normalizeCloudAgentControlReceipt(value);
    if (!receipt) {
      throw new Error("Cloud agent returned an invalid control receipt.");
    }
    const controlKey = cloudAgentControlKey(receipt.threadId);
    const rawExisting = await this.ctx.storage.get<unknown>(controlKey);
    const existing = normalizeCloudAgentControlReceipt(rawExisting);
    if (rawExisting !== undefined && !existing) {
      throw new Error("Cloud agent control state is corrupt.");
    }
    const control = advanceCloudAgentControlReceipt(existing, receipt);
    // One durable write closes the response-loss window: after this point a
    // retry finds the exact tool outcome before consulting mutable status.
    const outcome: CloudAgentToolOutcome = {
      kind,
      fingerprint,
      control: receipt,
      ...(disposition ? { disposition } : {}),
    };
    await this.ctx.storage.put({
      [controlKey]: control,
      [cloudAgentToolOutcomeKey(turn.turnId, toolCallId)]: outcome,
    });
    return outcome;
  }

  private async requireCloudAgentControlReceipt(
    threadIdValue: string,
    expected: "running" | "terminal" | "any",
  ): Promise<CloudAgentControlReceipt> {
    const threadId = threadIdValue.trim();
    if (!threadId || threadId.length > 256) {
      throw new Error("A valid cloud agent thread id is required.");
    }
    const raw = await this.ctx.storage.get<unknown>(
      cloudAgentControlKey(threadId),
    );
    const receipt = normalizeCloudAgentControlReceipt(raw);
    if (!receipt || receipt.threadId !== threadId) {
      throw new Error(
        `No exact control receipt is available for ${threadId}. Wait for its latest lifecycle update and try again.`,
      );
    }
    const statusMatches =
      expected === "any"
        ? true
        : expected === "running"
          ? receipt.status === "running"
          : receipt.status !== "running";
    if (!statusMatches) {
      throw new Error(
        expected === "running"
          ? `${threadId} is not currently running.`
          : `${threadId} is still working. Wait for its terminal lifecycle update before continuing it.`,
      );
    }
    return receipt;
  }

  /**
   * The cloud orchestrator's pinned tool catalog. Code-pinned on purpose —
   * frontmatter allowlists are agent-writable home data on desktop; in the
   * cloud the execution surface is never data-driven.
   *
   * Desktop orchestrator tools deliberately ABSENT here, each blocked on a
   * concrete constraint rather than silently omitted (the cloud persona
   * overlay tells the model the same list):
   * - `Read`: reads the local filesystem; cloud files live in the drive and
   *   reach the model via image attachments or a spawned drive agent.
   * - `html`: renders into the desktop Canvas tab; the cloud chat surface
   *   has no canvas host yet.
   * - `image_gen`: the managed pipeline delivers local artifact paths and a
   *   desktop card; needs drive-backed artifacts before it can exist here.
   * - `view_image`: local-path reader; the attachment hydration route covers
   *   the chat need (images ride the prompt as blocks).
   * - `map`: renders a desktop map card; no cloud card renderer.
   * - Mutating connector actions: cloud has no durable user-approval resume
   *   loop yet. The pinned tool_search/MCP facade below admits only canonical,
   *   native actions approved by both provider metadata and Stella's versioned
   *   admin review, and revalidates both authorities server-side.
   * - `spawn_manager`: the manager runtime coordinates local threads; cloud
   *   equivalents need a manager loop over BuildSessions first.
   */
  private createTools(
    turn: ChatTurnRequest,
    agentHome: AgentHome,
    skillCatalog: CloudSkillCatalogSnapshot,
    memoryEnabled: boolean,
  ): AgentTool[] {
    const base = turn.convexCallbackBase;
    const toolContext = {
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      conversationId: turn.conversationId,
      agentHome,
      post: (path: string, body: unknown, signal?: AbortSignal) =>
        this.convexPost(base, path, body, turn.ownerGeneration, {
          turnToken: turn.turnToken,
          ...(signal ? { signal } : {}),
        }),
    };
    const spawn = async (
      body: Record<string, unknown>,
      toolCallId: string,
      signal?: AbortSignal,
    ): Promise<CloudAgentControlReceipt> => {
      const clientMsgId = await sha256Hex(
        `cloud-spawn\0${turn.ownerGeneration}\0${turn.turnId}\0${toolCallId}`,
      );
      const response = await this.convexPost(
        base,
        "/api/cloud/spawn",
        {
          ownerId: turn.ownerId,
          conversationId: turn.conversationId,
          parentTurnId: turn.turnId,
          clientMsgId,
          ...body,
        },
        turn.ownerGeneration,
        { turnToken: turn.turnToken, ...(signal ? { signal } : {}) },
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        threadId?: string;
        attemptGeneration?: number;
        threadUpdatedAt?: number;
        status?: string;
        error?: string;
      };
      if (!response.ok || payload.ok !== true || !payload.threadId) {
        throw new Error(payload.error ?? "Spawning the agent failed.");
      }
      const control = normalizeCloudAgentControlReceipt({
        threadId: payload.threadId,
        attemptGeneration: payload.attemptGeneration,
        threadUpdatedAt: payload.threadUpdatedAt,
        status: payload.status,
      });
      if (!control) {
        throw new Error("Cloud agent returned an invalid control receipt.");
      }
      return control;
    };

    const toolFingerprint = async (
      kind: CloudAgentToolKind,
      semanticInput: unknown,
    ): Promise<string> =>
      await sha256Hex(
        JSON.stringify([
          "cloud-agent-tool/v1",
          turn.ownerGeneration,
          turn.turnId,
          kind,
          semanticInput,
        ]),
      );
    const pauseResult = (
      control: CloudAgentControlReceipt,
      disposition: NonNullable<CloudAgentToolOutcome["disposition"]>,
    ) => ({
      content: [
        {
          type: "text" as const,
          text:
            disposition === "pending"
              ? `Pause requested for ${control.threadId}. It is stopping now and can be resumed later with send_input.`
              : disposition === "already_terminal"
                ? `${control.threadId} had already stopped. Resume it later with send_input.`
                : `Paused ${control.threadId}. Resume it later with send_input.`,
        },
      ],
      details: {
        thread_id: control.threadId,
        canceled: true,
        attempt_generation: control.attemptGeneration,
        thread_updated_at: control.threadUpdatedAt,
      },
    });

    const tools: CloudCodeSourceAgentTool[] = [
      {
        name: "spawn_agent",
        label: "Spawn agent",
        description:
          "Spawn a sub-agent for a well-scoped background task. Returns immediately with a durable `thread_id`; the agent is NOT finished yet — you'll receive an [Agent completed] message on this conversation when it reports.",
        parameters: SPAWN_AGENT_PARAMETERS as unknown as TSchema,
        execute: async (toolCallId, params, signal) => {
          const args = params as {
            description: string;
            prompt: string;
            workspace?: string;
            model?: string;
          };
          const requestedWorkspace = args.workspace?.trim() || "cloud";
          const workspace =
            requestedWorkspace === "drive" ? "cloud" : requestedWorkspace;
          if (workspace === "computer") {
            throw new Error(
              "The user's computer isn't reachable from cloud chat yet. Run this on their machine from the desktop app, or use workspace \"cloud\" for hosted work.",
            );
          }
          const model = args.model?.trim();
          if (model && model !== "default" && !isValidCloudSpawnModel(model)) {
            throw new Error(
              'Cloud spawn model must be "claude[/model]", "codex[/model]", or a canonical "stella/..." model, optionally followed by :low, :medium, :high, or :xhigh.',
            );
          }
          const fingerprint = await toolFingerprint("spawn_agent", {
            description: args.description,
            prompt: args.prompt,
            workspace,
            model: model && model !== "default" ? model : null,
          });
          let outcome = await this.readCloudAgentToolOutcome(
            turn,
            toolCallId,
            "spawn_agent",
            fingerprint,
          );
          if (!outcome) {
            const admitted = await spawn(
              {
                action: "spawn",
                description: args.description,
                prompt: args.prompt,
                workspace,
                ...(model && model !== "default" ? { model } : {}),
              },
              toolCallId,
              signal,
            );
            outcome = await this.commitCloudAgentToolOutcome(
              turn,
              toolCallId,
              "spawn_agent",
              fingerprint,
              admitted,
            );
          }
          const control = outcome.control;
          return {
            content: [
              {
                type: "text",
                text: `Spawned agent ${control.threadId} ("${args.description}") in workspace ${workspace}. It is not finished yet — an [Agent completed] message will arrive with its report.`,
              },
            ],
            details: {
              thread_id: control.threadId,
              workspace,
              attempt_generation: control.attemptGeneration,
              thread_updated_at: control.threadUpdatedAt,
            },
          };
        },
      },
      {
        name: "send_input",
        label: "Send input",
        description:
          "Send a follow-up message to an existing sub-agent thread after it has finished. The thread's workspace and conversation history are restored.",
        parameters: {
          type: "object",
          properties: {
            thread_id: {
              type: "string",
              description: "Durable thread id to continue or revise.",
            },
            description: {
              type: "string",
              description:
                "One short, user-friendly sentence summarizing what this work is about.",
            },
            message: {
              type: "string",
              description: "Follow-up instruction to deliver to the agent.",
            },
          },
          required: ["thread_id", "description", "message"],
        } as unknown as TSchema,
        execute: async (toolCallId, params, signal) => {
          const args = params as {
            thread_id: string;
            description: string;
            message: string;
          };
          const threadId = args.thread_id.trim();
          const fingerprint = await toolFingerprint("send_input", {
            threadId,
            description: args.description,
            message: args.message,
          });
          let outcome = await this.readCloudAgentToolOutcome(
            turn,
            toolCallId,
            "send_input",
            fingerprint,
          );
          if (!outcome) {
            const prior = await this.requireCloudAgentControlReceipt(
              threadId,
              "terminal",
            );
            const admitted = await spawn(
              {
                action: "spawn",
                threadId: prior.threadId,
                expectedAttemptGeneration: prior.attemptGeneration,
                expectedThreadUpdatedAt: prior.threadUpdatedAt,
                description: args.description,
                prompt: args.message,
                workspace: "cloud",
              },
              toolCallId,
              signal,
            );
            outcome = await this.commitCloudAgentToolOutcome(
              turn,
              toolCallId,
              "send_input",
              fingerprint,
              admitted,
            );
          }
          const control = outcome.control;
          return {
            content: [
              {
                type: "text",
                text: `Delivered to ${control.threadId}. It is working again — an [Agent completed] message will arrive with its report.`,
              },
            ],
            details: {
              thread_id: control.threadId,
              attempt_generation: control.attemptGeneration,
              thread_updated_at: control.threadUpdatedAt,
            },
          };
        },
      },
      {
        name: "pause_agent",
        label: "Pause agent",
        description:
          "Stop a running sub-agent. The thread can be resumed later with send_input.",
        parameters: {
          type: "object",
          properties: {
            thread_id: {
              type: "string",
              description: "Durable thread id to pause.",
            },
            reason: {
              type: "string",
              description: "Optional explanation for why.",
            },
          },
          required: ["thread_id"],
        } as unknown as TSchema,
        execute: async (toolCallId, params, signal) => {
          const args = params as { thread_id: string; reason?: string };
          const threadId = args.thread_id.trim();
          const fingerprint = await toolFingerprint("pause_agent", {
            threadId,
            reason: args.reason?.trim() || null,
          });
          const replay = await this.readCloudAgentToolOutcome(
            turn,
            toolCallId,
            "pause_agent",
            fingerprint,
          );
          if (replay) {
            return pauseResult(replay.control, replay.disposition ?? "paused");
          }
          const control = await this.requireCloudAgentControlReceipt(
            threadId,
            "any",
          );
          const cancelRequestId = await sha256Hex(
            JSON.stringify([
              "pause_agent",
              turn.turnId,
              control.threadId,
              toolCallId,
            ]),
          );
          // Resolve the exact active turn first, then let its BuildSession DO
          // atomically claim cancellation, stop the process, and deliver the
          // terminal event. A pre-dispatch pause is persisted by that DO and
          // consumed as soon as the delayed turn arrives.
          const response = await this.convexPost(
            base,
            "/api/cloud/spawn",
            {
              action: "cancel",
              ownerId: turn.ownerId,
              conversationId: turn.conversationId,
              threadId: control.threadId,
              expectedAttemptGeneration: control.attemptGeneration,
              expectedThreadUpdatedAt: control.threadUpdatedAt,
              cancelRequestId,
            },
            turn.ownerGeneration,
            { turnToken: turn.turnToken, ...(signal ? { signal } : {}) },
          );
          if (!response.ok) {
            throw new Error(`Could not pause ${control.threadId}. Try again.`);
          }
          const canceled = (await response.json()) as {
            status?: string;
            turnId?: string;
            attemptGeneration?: number;
            threadUpdatedAt?: number;
            alreadyCanceled?: boolean;
            currentControl?: unknown;
          };
          const canceledControl = normalizeCloudAgentControlReceipt({
            threadId: control.threadId,
            attemptGeneration: canceled.attemptGeneration,
            threadUpdatedAt: canceled.threadUpdatedAt,
            status: canceled.status,
          });
          if (!canceledControl) {
            throw new Error("Cloud agent returned an invalid control receipt.");
          }
          const currentAfterCancel = normalizeCloudAgentControlReceipt(
            canceled.currentControl,
          );
          if (!currentAfterCancel) {
            throw new Error("Cloud agent returned an invalid current control.");
          }
          await this.rememberCloudAgentControlReceipt(currentAfterCancel);
          if (canceledControl.attemptGeneration !== control.attemptGeneration) {
            throw new Error(
              `${control.threadId} was continued while it was being paused. Try again if the newer turn should also stop.`,
            );
          }
          if (
            currentAfterCancel.attemptGeneration !==
              control.attemptGeneration ||
            (canceled.alreadyCanceled === true
              ? currentAfterCancel.status === "running"
              : !sameCloudAgentControlReceipt(currentAfterCancel, control))
          ) {
            throw new Error(
              `${control.threadId} was continued while it was being paused. Try again if the newer turn should also stop.`,
            );
          }
          let alreadyTerminal =
            !canceled.turnId && currentAfterCancel.status !== "running";
          let cancellationPending = false;
          let finalControl = currentAfterCancel;
          if (canceled.turnId) {
            const teardown = await this.env.BUILD_SESSIONS.getByName(
              control.threadId,
            ).fetch("https://build-session/cancel", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ownerId: turn.ownerId,
                ownerGeneration: turn.ownerGeneration,
                turnId: canceled.turnId,
                attemptGeneration: canceledControl.attemptGeneration,
                cancelRequestId,
                reason: "Paused by orchestrator.",
              }),
              ...(signal ? { signal } : {}),
            });
            const teardownResult = (await teardown
              .json()
              .catch(() => ({}))) as {
              pending?: boolean;
              reason?: string;
            };
            cancellationPending =
              teardown.status === 202 && teardownResult.pending === true;
            if (teardown.status === 409) {
              if (teardownResult.reason === "terminal_already_decided") {
                alreadyTerminal = true;
              } else {
                throw new Error(
                  `${control.threadId} was continued while it was being paused. Try again if the newer turn should also stop.`,
                );
              }
            }
            if (!teardown.ok && !alreadyTerminal) {
              throw new Error(
                `Could not pause ${control.threadId}. Try again.`,
              );
            }
            if (teardown.ok) {
              const committed = await this.convexPost(
                base,
                "/api/cloud/spawn",
                {
                  action: "cancel_ack",
                  ownerId: turn.ownerId,
                  conversationId: turn.conversationId,
                  threadId: control.threadId,
                  turnId: canceled.turnId,
                  attemptGeneration: canceledControl.attemptGeneration,
                  cancelRequestId,
                },
                turn.ownerGeneration,
                { turnToken: turn.turnToken, ...(signal ? { signal } : {}) },
              );
              if (!committed.ok) {
                throw new Error(
                  `Could not record the pause for ${control.threadId}. Try again.`,
                );
              }
              const committedPayload = (await committed.json()) as {
                threadId?: string;
                attemptGeneration?: number;
                threadUpdatedAt?: number;
                status?: string;
                currentControl?: unknown;
              };
              const acknowledgedTarget = normalizeCloudAgentControlReceipt({
                threadId: committedPayload.threadId,
                attemptGeneration: committedPayload.attemptGeneration,
                threadUpdatedAt: committedPayload.threadUpdatedAt,
                status: committedPayload.status,
              });
              const acknowledgedCurrent = normalizeCloudAgentControlReceipt(
                committedPayload.currentControl,
              );
              if (!acknowledgedTarget || !acknowledgedCurrent) {
                throw new Error(
                  "Cloud agent returned an invalid control receipt.",
                );
              }
              await this.rememberCloudAgentControlReceipt(acknowledgedCurrent);
              if (
                acknowledgedTarget.attemptGeneration !==
                  canceledControl.attemptGeneration ||
                acknowledgedCurrent.attemptGeneration !==
                  canceledControl.attemptGeneration ||
                acknowledgedCurrent.status === "running"
              ) {
                throw new Error(
                  `${control.threadId} was continued while it was being paused. Try again if the newer turn should also stop.`,
                );
              }
              finalControl = acknowledgedCurrent;
            }
          }
          if (finalControl.status === "running") {
            throw new Error(
              `Could not record the pause for ${control.threadId}. Try again.`,
            );
          }
          const disposition: NonNullable<CloudAgentToolOutcome["disposition"]> =
            cancellationPending
              ? "pending"
              : alreadyTerminal
                ? "already_terminal"
                : "paused";
          const outcome = await this.commitCloudAgentToolOutcome(
            turn,
            toolCallId,
            "pause_agent",
            fingerprint,
            finalControl,
            disposition,
          );
          return pauseResult(
            outcome.control,
            outcome.disposition ?? disposition,
          );
        },
      },
      // The desktop `web` tool's exact surface (web-def) and fetch pipeline
      // (web-fetch-core, with per-redirect-hop SSRF re-validation). workerd
      // has no resolver hook, so the guard runs literal-only here; Cloudflare's
      // own egress policy backstops DNS-rebinding names.
      {
        name: WEB_TOOL_NAME,
        label: "Web",
        description: WEB_TOOL_DESCRIPTION,
        parameters: WEB_TOOL_PARAMETERS as unknown as TSchema,
        codeEligibility: "read_only",
        execute: async (_id, params, signal) => {
          const args = params as {
            query?: string;
            url?: string;
            category?: string;
            prompt?: string;
          };
          const query = args.query?.trim() ?? "";
          const url = args.url?.trim() ?? "";
          if (!query && !url) {
            throw new Error("Either query or url is required.");
          }
          if (query && url) {
            throw new Error("Pass either query or url, not both.");
          }
          if (url) {
            const prompt = args.prompt?.trim() || undefined;
            const text = await fetchReadableText(
              { url, ...(prompt ? { prompt } : {}) },
              {
                guardUrl: (candidate) => normalizeSafePublicUrl(candidate),
                // Same two protections the desktop tool applies: refuse a URL
                // carrying a credential (exfiltration via a model-chosen
                // query string), and redact secrets out of fetched page text
                // before it becomes model-visible and lands in the transcript.
                checkSecretLikeToken: containsSecretLikeToken,
                sanitize: sanitizeToolVisibleText,
                userAgent: "Stella/1.0 (Cloud)",
                ...(signal ? { signal } : {}),
              },
            );
            return {
              content: [{ type: "text", text }],
              details: { mode: "fetch", url },
            };
          }
          const response = await this.convexPost(
            base,
            "/api/cloud/web-search",
            {
              query,
              ownerId: turn.ownerId,
              ...(args.category?.trim()
                ? { category: args.category.trim() }
                : {}),
            },
            turn.ownerGeneration,
            { turnToken: turn.turnToken, ...(signal ? { signal } : {}) },
          );
          if (!response.ok) {
            throw new Error(`Web search failed (${response.status}).`);
          }
          const payload = (await response.json()) as { text: string };
          return {
            content: [
              { type: "text", text: payload.text || "No results found." },
            ],
            details: { mode: "search", query, ...payload },
          };
        },
      },
      ...(memoryEnabled ? createMemoryTools(toolContext) : []),
      createScheduleTool(toolContext),
      ...createCloudIntegrationTools(toolContext),
      ...(agentHome.available
        ? createCloudSkillTools(agentHome.cloudStore(), skillCatalog)
        : []),
    ];
    return [
      createCloudCodeAgentTool({
        loader: this.env.LOADER,
        tools,
        executionScope: `${turn.ownerGeneration}:${turn.conversationId}:${turn.turnId}`,
      }),
      ...tools,
    ];
  }
}
