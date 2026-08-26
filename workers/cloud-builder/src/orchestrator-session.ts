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
import { isValidCloudSpawnModel } from "./cloud-spawn-model.js";
import { sha256Hex } from "./hash.js";
import {
  buildCloudSystemPrompt,
  CLOUD_PROMPT_SNAPSHOT_STORAGE_KEY,
  refreshCanonicalPrompts,
  type CanonicalPromptSnapshot,
} from "./cloud-prompt.js";
import { getResponseLanguageSystemPrompt } from "@stella/runtime/kernel/runner/locale-prompt.js";
import { createMemoryTools, createScheduleTool } from "./orchestrator-tools.js";
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
import { ConversationDeletedError, Journal } from "./journal.js";
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
  parseLocalTurnRenewal,
  parseLocalFinishRecords,
  parseLocalTerminalPhase,
  type LocalClientMessageReceipt,
  type ParsedLocalTurnRenewal,
  type LocalTerminalPhase,
} from "./local-turn-protocol.js";
import {
  conversationArchivePrefix,
  parseOwnerTransferRequest,
  retainedTurnBlocksOwnerTransfer,
  type OwnerTransferRequest,
} from "./owner-transfer.js";
import { parseVoiceJournalRecords } from "./journal-append-protocol.js";

type Env = {
  BUILD_SESSIONS: DurableObjectNamespace;
  BUILDER_SERVICE_SECRET: string;
  // The owner's memory documents. Optional so a deployment without the
  // binding degrades to a memoryless orchestrator instead of dead turns.
  AGENT_HOME?: R2Bucket;
  // Rolled-over transcript segments and oversize-row spills. Deliberately a
  // separate bucket from AGENT_HOME: different retention, and a prefix delete
  // here must never be able to reach the owner's memory documents.
  CONVERSATION_ARCHIVE?: R2Bucket;
  // Fallback Convex origin for index flushes and owner lookups that happen
  // outside a turn (a socket connecting to a DO that has never run one).
  STELLA_CONVEX_SITE_URL?: string;
};

export type ChatTurnRequest = {
  kind: "chat";
  ownerId: string;
  conversationId: string;
  turnId: string;
  sessionId: string;
  prompt: string;
  turnToken: string;
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
  /** Worker-issued owner purge lease generation. */
  ownerPurgeGeneration?: string;
  ownerPurgeLeaseId?: string;
  /** Set by the DO when the dispatch is accepted; used to restore queue order. */
  queuedAt?: number;
};

type OwnerFencedTurn = {
  ownerId: string;
  turnId: string;
  ownerPurgeGeneration?: string;
  ownerPurgeLeaseId?: string;
};

type LocalTurnLease = OwnerFencedTurn & {
  deviceId: string;
  localTurnId: string;
  leaseToken: string;
  expiresAt: number;
  beginFingerprint: string;
  finishFingerprint?: string;
  cancelRequested?: boolean;
  clientMsgId?: string;
};

type LocalTurnFinishReceipt = {
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
const localTurnReceiptKey = (turnId: string): string =>
  `${LOCAL_TURN_RECEIPT_PREFIX}${turnId}`;
const localClientMessageKey = (clientMsgId: string): string =>
  `${LOCAL_CLIENT_MESSAGE_PREFIX}${clientMsgId}`;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

  private readonly journal: Journal;
  private readonly archive: ConversationArchive;
  private readonly index: ConversationIndex;
  private readonly hub: ConversationHub;

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
      if (this.journal.meta().conversation_id === "" && this.ctx.id.name) {
        this.journal.setConversationId(this.ctx.id.name);
      }
      const localLease =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (localLease) {
        this.live = {
          turnId: localLease.turnId,
          streamId: null,
          partialText: "",
          tools: [],
        };
        const alarmAt = await this.ctx.storage.getAlarm();
        if (alarmAt === null || alarmAt > localLease.expiresAt) {
          await this.ctx.storage.setAlarm(localLease.expiresAt);
        }
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  private async registerOwnerTurn(
    turn: OwnerFencedTurn,
    freshLease = false,
  ): Promise<string> {
    if (freshLease || !turn.ownerPurgeLeaseId) {
      turn.ownerPurgeLeaseId = crypto.randomUUID();
    }
    const response = await this.callOwnerFence(turn.ownerId, "register", {
      leaseId: turn.ownerPurgeLeaseId,
      sessionId: this.ctx.id.toString(),
      turnId: turn.turnId,
      namespace: "orchestrator",
      role: "orchestrator",
      ...(turn.ownerPurgeGeneration
        ? { generation: turn.ownerPurgeGeneration }
        : {}),
    });
    const body = (await response.json().catch(() => null)) as {
      generation?: string;
    } | null;
    if (!response.ok || !body?.generation) throw new OwnerPurgeFenceError();
    return body.generation;
  }

  private async assertOwnerTurn(turn: OwnerFencedTurn): Promise<void> {
    if (!turn.ownerPurgeGeneration || !turn.ownerPurgeLeaseId) {
      throw new OwnerPurgeFenceError();
    }
    const response = await this.callOwnerFence(turn.ownerId, "assert", {
      generation: turn.ownerPurgeGeneration,
      leaseId: turn.ownerPurgeLeaseId,
    });
    if (!response.ok) throw new OwnerPurgeFenceError();
  }

  private async unregisterOwnerTurn(turn: OwnerFencedTurn): Promise<void> {
    if (!turn.ownerPurgeGeneration || !turn.ownerPurgeLeaseId) return;
    await this.callOwnerFence(turn.ownerId, "unregister", {
      leaseId: turn.ownerPurgeLeaseId,
      sessionId: this.ctx.id.toString(),
      turnId: turn.turnId,
      generation: turn.ownerPurgeGeneration,
    }).catch(() => undefined);
  }

  private convexEndpoint(): { base: string; secret: string } | null {
    const base = (this.convexBase ?? this.env.STELLA_CONVEX_SITE_URL ?? "")
      .trim()
      .replace(/\/+$/, "");
    if (!base || !this.env.BUILDER_SERVICE_SECRET) return null;
    return { base, secret: this.env.BUILDER_SERVICE_SECRET };
  }

  /** Last dispatch's callback origin, so flushes work between turns too. */
  private convexBase?: string;

  /**
   * The DO never adopts its first connector as owner: `conversationId` would
   * become a bearer token and anyone who guessed a UUID would own the object.
   * Ownership comes from Convex, once, and is then immutable.
   */
  private lookupOwner(): Promise<ConversationOwnerRecord | null> {
    const bound = this.journal.meta();
    if (bound.owner_id) {
      return Promise.resolve({
        ownerId: bound.owner_id,
        createdAt: bound.created_at,
        title: bound.title,
      });
    }
    if (this.ownerLookup) return this.ownerLookup;
    const conversationId = this.conversationId();
    const endpoint = this.convexEndpoint();
    if (!conversationId || !endpoint) return Promise.resolve(null);
    const work = (async (): Promise<ConversationOwnerRecord | null> => {
      const response = await fetch(
        `${endpoint.base}/api/cloud/conversation-owner?conversationId=${encodeURIComponent(
          conversationId,
        )}`,
        {
          headers: { authorization: `Bearer ${endpoint.secret}` },
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
      if (!payload?.ownerId) return null;
      this.journal.bindOwner({ ...payload, conversationId });
      return payload;
    })().finally(() => {
      this.ownerLookup = null;
    });
    this.ownerLookup = work;
    return work;
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
    const turn = await this.ctx.storage.get<ChatTurnRequest>("turn");
    if (!turn || turn.turnId !== turnId) return;
    await this.fetch(
      new Request("https://orchestrator-session/cancel", { method: "POST" }),
    );
  }

  private enqueue(turn: ChatTurnRequest): void {
    // Failures surface through the turn's own terminal event; the queue
    // must survive them.
    this.queue = this.queue
      .then(() => this.runTurn(turn))
      .catch(() => undefined);
    this.ctx.waitUntil(this.queue);
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
      await this.ctx.storage.put(LOCAL_TURN_LEASE_KEY, current);
      const retryAt = Date.now() + LOCAL_TURN_CANCEL_GRACE_MS;
      const alarmAt = await this.ctx.storage.getAlarm();
      if (alarmAt === null || alarmAt > retryAt) {
        await this.ctx.storage.setAlarm(retryAt);
      }

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
          await this.ctx.storage.deleteAlarm().catch(() => undefined);
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
  ): Promise<Response> {
    return fetch(`${base.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  }

  private async event(
    turn: ChatTurnRequest,
    seq: number | "auto",
    kind: string,
    payload: unknown,
    terminal = false,
  ): Promise<void> {
    const response = await this.convexPost(
      turn.convexCallbackBase,
      "/api/cloud/events",
      {
        turnId: turn.turnId,
        sessionId: turn.sessionId,
        seq,
        kind,
        payload,
        terminal,
      },
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
    const localLease =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (localLease) {
      if (localLease.cancelRequested) {
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
        this.currentTurnAbort?.abort();
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
      this.currentTurnAbort?.abort();
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
        turnId?: string;
        generation?: string;
        leaseId?: string;
      };
      const current = await this.ctx.storage.get<ChatTurnRequest>("turn");
      const localLease =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      await this.ctx.storage.put("terminal", true);
      this.currentTurnAbort?.abort();
      this.currentAgent?.abort();
      const queued = await this.ctx.storage.list<ChatTurnRequest>({
        prefix: "queued:",
      });
      for (const [key, queuedTurn] of queued) {
        await this.ctx.storage.delete(key);
        await this.unregisterOwnerTurn(queuedTurn);
      }
      const turnId = body.turnId ?? current?.turnId ?? localLease?.turnId;
      const ownerId = body.ownerId ?? current?.ownerId ?? localLease?.ownerId;
      const generation =
        body.generation ??
        current?.ownerPurgeGeneration ??
        localLease?.ownerPurgeGeneration;
      const leaseId =
        body.leaseId ??
        current?.ownerPurgeLeaseId ??
        localLease?.ownerPurgeLeaseId;
      if (!turnId || !ownerId || !generation || !leaseId) {
        return json({ error: "Owner purge lease identity required." }, 400);
      }
      if (
        localLease &&
        localLease.turnId === turnId &&
        localLease.ownerId === ownerId &&
        localLease.ownerPurgeGeneration === generation &&
        localLease.ownerPurgeLeaseId === leaseId
      ) {
        try {
          if (this.journal.turnState(turnId)?.state !== "terminal") {
            const now = Date.now();
            const terminal = this.journal.appendTurn({
              turnId,
              writer: `desktop:${localLease.deviceId}`,
              writerKey: `turn:${turnId}:phase:canceled`,
              phase: "canceled",
              lane: "chat",
              source: "desktop",
              notice: TERMINAL_NOTICE.canceled,
              createdAt: now,
            });
            this.journal.setTurnSpan(turnId, terminal.seq);
            this.journal.setTurnTerminal(turnId, "canceled", now);
            this.publish(terminal.record);
          }
        } catch {
          // The purge remains authoritative; a best-effort terminal row must
          // never keep the owner's destructive operation blocked.
        }
        await this.ctx.storage.delete(LOCAL_TURN_LEASE_KEY);
        await this.ctx.storage.deleteAlarm().catch(() => undefined);
        this.live = null;
        this.hub.endTurn(turnId);
        await this.unregisterOwnerTurn(localLease);
        return json({
          canceled: true,
          turnId,
          unregistered: true,
          local: true,
        });
      }
      if (this.activeTurnId === turnId) {
        return json({ error: "Owner turn is still unwinding." }, 409);
      }
      const key = `ownerPurgeCancelAt:${leaseId}`;
      const startedAt = (await this.ctx.storage.get<number>(key)) ?? Date.now();
      await this.ctx.storage.put(key, startedAt);
      if (Date.now() - startedAt < OWNER_PURGE_STALE_LEASE_GRACE_MS) {
        return json({ error: "Reconciling stale owner turn lease." }, 409);
      }
      await this.ctx.storage.delete(key);
      await this.callOwnerFence(ownerId, "unregister", {
        leaseId,
        sessionId: this.ctx.id.toString(),
        turnId,
        generation,
      });
      return json({ canceled: true, turnId, unregistered: true });
    }
    if (url.pathname === "/cancel") {
      const stored = await this.ctx.storage.get<ChatTurnRequest>("turn");
      if (stored && !(await this.ctx.storage.get<boolean>("terminal"))) {
        const turn = { ...stored };
        try {
          turn.ownerPurgeGeneration = await this.registerOwnerTurn(turn, true);
          await this.assertOwnerTurn(turn);
          // `terminalOwed` travels with `terminal` in one put: it is what tells
          // the re-armed alarm below that a cancel — not a timeout — is the
          // terminal this turn reached.
          await this.ctx.storage.put({
            terminal: true,
            terminalOwed: {
              kind: "canceled",
              message: TERMINAL_NOTICE.canceled,
            } satisfies OwedTerminal,
          });
          this.currentTurnAbort?.abort();
          this.currentAgent?.abort();
          // Additive, for the same reason as in alarm(): the terminal journal
          // row is what stops a connected client's spinner, and it is
          // independent of whether the Convex event below is delivered.
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
            // Delivery failed; the re-armed alarm retries so the turn cannot
            // stay "running" forever.
            await this.ctx.storage.setAlarm(Date.now() + 30_000);
          }
          // Same debt as the watchdog path, and last for the same reason. A
          // stopped turn is still a turn the user had: it owes an excerpt and an
          // inbox drain. When the loop is still alive it does this itself on its
          // way out; this covers a cancel that arrives after an eviction, where
          // nothing else ever would.
          await this.finalizeTerminalTurn(turn);
        } catch (error) {
          if (!(error instanceof OwnerPurgeFenceError)) throw error;
        } finally {
          await this.unregisterOwnerTurn(turn);
        }
      }
      return json({ canceled: true });
    }
    if (url.pathname !== "/turn") return json({ error: "Not found." }, 404);
    const turn = (await request.json()) as ChatTurnRequest;
    turn.queuedAt ??= Date.now();
    try {
      delete turn.ownerPurgeGeneration;
      delete turn.ownerPurgeLeaseId;
      turn.ownerPurgeGeneration = await this.registerOwnerTurn(turn);
      await this.assertOwnerTurn(turn);
    } catch (error) {
      await this.unregisterOwnerTurn(turn);
      if (error instanceof OwnerPurgeFenceError) {
        return json({ error: "Owner cloud activity is being purged." }, 409);
      }
      throw error;
    }
    // Accept immediately and run in the background: holding the dispatch
    // POST open for the whole turn means a mid-turn transport failure makes
    // Convex mark a still-running turn failed. The turn is durable before
    // the 202: persisted under queued:*, with an alarm guaranteed so a
    // restarted DO always wakes to drain the queue.
    //
    // Both writes happen in one critical section. Apart, a turn completing
    // concurrently can read the queue before this `put` lands, find it empty,
    // and delete the alarm after this handler has already decided one exists —
    // leaving `queued:` durable with no wake signal, which is the same
    // stranding as a consumed alarm by another route.
    let heldForLocalTurn = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put(`queued:${turn.turnId}`, turn);
      const localLease =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      heldForLocalTurn = localLease !== undefined;
      if (localLease) {
        const alarmAt = await this.ctx.storage.getAlarm();
        if (alarmAt === null || alarmAt > localLease.expiresAt) {
          await this.ctx.storage.setAlarm(localLease.expiresAt);
        }
      } else if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(
          Date.now() + Math.max(1_000, turn.watchdogMs ?? CHAT_WATCHDOG_MS),
        );
      }
    });
    if (!heldForLocalTurn) this.enqueue(turn);
    return json({ accepted: true }, 202);
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
        this.ownerTransferRequest?.toOwnerId !== body.toOwnerId
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
      const pending =
        await this.ctx.storage.get<OwnerTransferRequest>(OWNER_TRANSFER_KEY);
      if (
        pending &&
        (pending.fromOwnerId !== body.fromOwnerId ||
          pending.toOwnerId !== body.toOwnerId)
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
          this.currentTurnAbort ||
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
    const archive = await this.archive.transferOwner(
      fromPrefix,
      toPrefix,
      body.toOwnerId,
    );
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
    this.ownerLookup = null;
    await this.ctx.storage.delete(OWNER_TRANSFER_KEY);
    log("info", "conversation_owner_transferred", {
      conversationId,
      fromOwnerId: body.fromOwnerId,
      toOwnerId: body.toOwnerId,
    });
    return json({ transferred: true, replayed: false });
  }

  // The in-flight loop, exposed so /cancel and the alarm can actually stop
  // token burn instead of only marking the turn terminal.
  private currentAgent?: Agent;
  // Aborts the live turn's retry ladder alongside `currentAgent.abort()`:
  // classification reads it to refuse retries after a cancel/timeout, and an
  // abort during retry backoff wakes the sleep instead of waiting it out.
  private currentTurnAbort?: AbortController;

  private async runTurn(turn: ChatTurnRequest): Promise<Response> {
    const localLease =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (localLease) {
      if (localLease.expiresAt <= Date.now()) {
        await this.expireLocalLease(localLease, false);
      } else {
        await this.armLocalLeaseAlarm(localLease.expiresAt);
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
    await this.ctx.storage.put({
      turn,
      terminal: false,
      terminalDelivered: false,
      terminalOwed: null,
      alarmAttempts: 0,
    });
    await this.ctx.storage.delete(`queued:${turn.turnId}`);
    this.convexBase = turn.convexCallbackBase;
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
    try {
      await this.assertOwnerTurn(turn);
      this.activeTurnId = turn.turnId;
      // Binding is safe from a turn dispatch and only from a turn dispatch:
      // Convex resolved the conversation and checked ownership before it minted
      // the turn token. A socket connector is never trusted this way — see
      // lookupOwner().
      this.bindConversation(turn);
      await this.event(turn, "auto", "started", {});

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
      this.journal.setTurnContext(
        turn.turnId,
        selection.startSeq,
        selection.endSeq,
      );
      void this.index
        .flush({ activity: "running", updatedAt: now })
        .catch(() => undefined);

      const agentHome = new AgentHome(this.env.AGENT_HOME, turn.ownerId);
      // Everything here is context, not correctness: a failed read degrades
      // the reply, it must not fail the turn.
      const [
        memoryDocuments,
        personalityOverride,
        canonicalPrompts,
        locale,
        attachmentImages,
      ] = await Promise.all([
        agentHome.readDocuments().catch((error) => {
          log("error", "agent_home_read_failed", {
            turnId: turn.turnId,
            message: errorMessage(error),
          });
          return [];
        }),
        agentHome.readPersonality(),
        this.loadCanonicalPrompts(base),
        this.resolveTurnLocale(turn),
        this.loadChatAttachmentImages(base, turn),
      ]);

      // The watchdog (or /cancel) may have fired during the setup awaits
      // above, before currentAgent exists for abort() to reach — re-check so
      // an already-terminal turn never starts the loop at all.
      if (await this.ctx.storage.get<boolean>("terminal")) {
        // The prompt row is already committed, so this turn has content worth
        // indexing even though the loop never ran. Returning without this is
        // how a canceled turn used to vanish from Recall permanently.
        await this.afterTerminal(turn);
        return json({ ok: false, canceled: true });
      }

      const executionSelection =
        turn.execution ?? LEGACY_UNBOUND_CLOUD_EXECUTION;
      const model = await createCloudRelayModel({
        siteUrl: base,
        turnToken: turn.turnToken,
        agentType: "orchestrator",
        execution: executionSelection,
      });
      const agent: Agent = new Agent({
        initialState: {
          systemPrompt: buildCloudSystemPrompt({
            canonicalBody: canonicalPrompts?.orchestratorBody ?? null,
            // The user's synced personality wins; the canonical default is
            // what a fresh desktop install would inject.
            personalityBody:
              personalityOverride ?? canonicalPrompts?.personalityBody ?? null,
            localeDirective: getResponseLanguageSystemPrompt(locale),
            residentSection: buildResidentMemorySection(memoryDocuments),
          }),
          model,
          thinkingLevel: resolveCloudThinkingLevel(
            model,
            executionSelection.reasoningEffort,
          ),
          tools: this.createTools(turn, agentHome),
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
      // instead of failing the whole turn on one blip. `abortSignal` is wired
      // to the cancel/watchdog paths so an aborted turn classifies as
      // canceled (never retried) and a cancel during backoff wakes the sleep.
      const turnAbort = new AbortController();
      this.currentTurnAbort = turnAbort;
      const retryState = { attemptsUsed: 0, retriesUsed: 0 };
      this.currentAgent = agent;
      let execution: { finalText: string; errorMessage?: string };
      try {
        execution = await executeAgentRunWithRetry({
          state: retryState,
          abortSignal: turnAbort.signal,
          execute: async (resume) => {
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
        this.currentTurnAbort = undefined;
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
        if (queued.size === 0) await this.ctx.storage.deleteAlarm();
      });
      log("info", "chat_turn_completed", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        wallClockMs: Math.round(performance.now() - started),
      });
      return json({ ok: true, text: finalText });
    } catch (error) {
      const message = errorMessage(error);
      log("error", "chat_turn_failed", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        message,
      });
      if (!(await this.ctx.storage.get<boolean>("terminal"))) {
        // Same pairing as `/cancel`: the alarm retries what is owed, so what
        // is owed becomes durable in the same write that says a terminal was
        // reached at all.
        await this.ctx.storage.put({
          terminal: true,
          terminalOwed: {
            kind: "failed",
            message: TERMINAL_NOTICE.failed,
          } satisfies OwedTerminal,
        });
        // The raw message is often a provider error blob or infrastructure
        // detail; it belongs in logs, never in the user's chat bubble — and
        // never in a frame either. `ref` in the socket's error frame is the
        // correlation key back to this log line.
        this.recordTerminal(turn, "failed", TERMINAL_NOTICE.failed);
        try {
          await this.event(
            turn,
            "auto",
            "failed",
            { message: TERMINAL_NOTICE.failed },
            true,
          );
          await this.ctx.storage.put("terminalDelivered", true);
        } catch {
          // Delivery failed; the re-armed alarm retries so the turn cannot
          // stay "running" forever.
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
        }
      }
      await this.afterTerminal(turn);
      return json({ error: "Cloud chat turn failed.", detail: message }, 502);
    } finally {
      this.live = null;
      this.hub.endTurn(turn.turnId);
      if (this.activeTurnId === turn.turnId) this.activeTurnId = null;
      await this.unregisterOwnerTurn(turn);
    }
  }

  /**
   * The canonical prompt snapshot, cached in durable storage and refreshed
   * by ETag at most every few minutes. Any failure returns whatever is
   * cached — a cold, unreachable start yields null and the compact fallback
   * prompt.
   */
  private async loadCanonicalPrompts(
    convexSiteBase: string,
  ): Promise<CanonicalPromptSnapshot | null> {
    try {
      const cached =
        (await this.ctx.storage.get<CanonicalPromptSnapshot>(
          CLOUD_PROMPT_SNAPSHOT_STORAGE_KEY,
        )) ?? null;
      const fresh = await refreshCanonicalPrompts(
        convexSiteBase,
        cached,
        Date.now(),
      );
      if (fresh && fresh !== cached) {
        await this.ctx.storage.put(CLOUD_PROMPT_SNAPSHOT_STORAGE_KEY, fresh);
      }
      return fresh;
    } catch {
      return null;
    }
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
  ): Promise<ImageContent[]> {
    const paths = (turn.attachments ?? []).slice(0, 4);
    if (paths.length === 0) return [];
    try {
      const response = await fetch(
        `${base.replace(/\/+$/, "")}/api/cloud/drive/attachments`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-stella-turn-token": turn.turnToken,
          },
          body: JSON.stringify({ turnId: turn.turnId, paths }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) return [];
      const payload = (await response.json()) as {
        attachments?: Array<{ path: string; contentType: string; url: string }>;
      };
      const images: ImageContent[] = [];
      for (const entry of payload.attachments ?? []) {
        try {
          const bytes = await fetch(entry.url, {
            signal: AbortSignal.timeout(20_000),
          });
          if (!bytes.ok) continue;
          images.push({
            type: "image",
            data: base64FromBytes(new Uint8Array(await bytes.arrayBuffer())),
            mimeType: entry.contentType,
          });
        } catch {
          // One unreadable attachment must not cost the others.
        }
      }
      return images;
    } catch (error) {
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
  ): Promise<string | undefined> {
    try {
      const carried = turn.locale?.trim();
      if (carried && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(carried)) {
        const stored = await this.ctx.storage.get<string>("locale");
        if (stored !== carried) {
          await this.ctx.storage.put("locale", carried);
        }
        return carried;
      }
      return await this.ctx.storage.get<string>("locale");
    } catch {
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
  // Service surfaces
  // ---------------------------------------------------------------------------

  /**
   * The dev probe. There are no tests by owner decision, so this is the
   * verification tool: it reads the journal exactly the way a client does,
   * including through R2 segments.
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
  ): Promise<{ ownerId: string } | Response> {
    const identity = parseSocketIdentity(request);
    if (!identity) return json({ error: "Unauthorized." }, 401);
    if (this.purged()) {
      return json(
        { code: "deleted", message: "This conversation was deleted." },
        410,
      );
    }
    const bound = this.journal.ownerId() || (await this.lookupOwner())?.ownerId;
    const activeLease = suppliedLeaseToken
      ? await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY)
      : undefined;
    if (
      !bound ||
      !localTurnLeaseAllowsIdentityTransition({
        boundOwnerId: bound,
        callerOwnerId: identity.ownerId,
        suppliedLeaseToken,
        activeLease,
      })
    ) {
      return json({ error: "Conversation not found." }, 404);
    }
    return { ownerId: bound };
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
    const { deviceId, localTurnId, leaseToken } = renewal;
    const turnId = makeLocalTurnId(deviceId, localTurnId);
    const previous = await this.ctx.storage.get<LocalTurnFinishReceipt>(
      localTurnReceiptKey(turnId),
    );
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
    if (existing.expiresAt <= Date.now()) {
      await this.expireLocalLease(existing, true);
      return json(
        {
          code: "turn_expired",
          message: "That local turn lease expired.",
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
      const owner = await this.localTurnOwner(request, renewal.leaseToken);
      if (owner instanceof Response) return owner;
      return this.handleLocalTurnRenewal(renewal, owner.ownerId);
    }
    const deviceId = body.deviceId?.trim() ?? "";
    const localTurnId = body.localTurnId?.trim() ?? "";
    const clientMsgId = body.clientMsgId?.trim();
    if (
      !LOCAL_DEVICE_ID_PATTERN.test(deviceId) ||
      !LOCAL_TURN_ID_PATTERN.test(localTurnId) ||
      (body.renewOnly !== undefined && typeof body.renewOnly !== "boolean") ||
      (clientMsgId !== undefined &&
        !LOCAL_CLIENT_MSG_ID_PATTERN.test(clientMsgId))
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const owner = await this.localTurnOwner(request);
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
      if (existing.expiresAt <= Date.now()) {
        await this.expireLocalLease(existing, true);
        return json(
          {
            code: "turn_expired",
            message: "That local turn lease expired.",
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
        return json({
          turnId,
          leaseToken: renewed.leaseToken,
          expiresAt: renewed.expiresAt,
          replayed: true,
          ...context,
        });
      } catch (error) {
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
      lease.ownerPurgeGeneration = await this.registerOwnerTurn(lease);
    } catch {
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
      ]);
      const cloudBusy =
        Boolean(cloudTurn && terminal !== true) ||
        Boolean(cloudTurn && terminalDelivered !== true) ||
        queued.size > 0;
      if (local || cloudBusy || this.purged()) return;
      if (clientMsgId) {
        const replay = classifyLocalClientMessageReplay(
          concurrentClientReceipt,
          {
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
      const records: Record<string, unknown> = {
        [LOCAL_TURN_LEASE_KEY]: lease,
      };
      if (clientMsgId) {
        records[localClientMessageKey(clientMsgId)] = {
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
      return json({
        turnId,
        leaseToken: lease.leaseToken,
        expiresAt: lease.expiresAt,
        replayed: false,
        ...context,
      });
    } catch (error) {
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
    const localTurnId = body.localTurnId?.trim() ?? "";
    const leaseToken = body.leaseToken?.trim() ?? "";
    const terminalPhase = parseLocalTerminalPhase(body.phase);
    const parsedRecords = parseLocalFinishRecords(
      body.records ?? [],
      LOCAL_TURN_FINISH_MAX_ROWS,
    );
    if (
      !LOCAL_DEVICE_ID_PATTERN.test(deviceId) ||
      !LOCAL_TURN_ID_PATTERN.test(localTurnId) ||
      !/^[a-f0-9]{64}$/.test(leaseToken) ||
      !terminalPhase ||
      !parsedRecords
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const owner = await this.localTurnOwner(request, leaseToken);
    if (owner instanceof Response) return owner;
    const turnId = makeLocalTurnId(deviceId, localTurnId);
    const { records: parsed, totalBytes } = parsedRecords;
    const finishFingerprint = await sha256Hex(
      JSON.stringify({
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
    if (lease.expiresAt <= Date.now()) {
      await this.expireLocalLease(lease, true);
      return json(
        {
          code: "turn_expired",
          message: "That local turn lease expired.",
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
    const bound = this.journal.ownerId() || (await this.lookupOwner())?.ownerId;
    if (!bound) return json({ error: "Conversation not found." }, 404);
    if (bound !== ownerId)
      return json({ error: "Conversation not found." }, 404);

    let body: {
      deviceId?: string;
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
    const localTurnId = body.localTurnId?.trim();
    const records = body.records;
    if (
      !deviceId ||
      !LOCAL_DEVICE_ID_PATTERN.test(deviceId) ||
      !localTurnId ||
      !LOCAL_TURN_ID_PATTERN.test(localTurnId) ||
      body.source !== "voice" ||
      !Array.isArray(records) ||
      records.length === 0
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
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
    const fingerprint = await sha256Hex(
      JSON.stringify({ deviceId, localTurnId, source, records }),
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
    const turnId = `${source}:${deviceId}:${localTurnId}`;
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
    let body: { sourceTurnId?: string; card?: ConversationCard };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "Malformed request." }, 400);
    }
    const sourceTurnId = body.sourceTurnId?.trim();
    const card = body.card;
    if (!sourceTurnId || !card?.type) {
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
    if (!this.journal.ownerId()) {
      try {
        await this.lookupOwner();
      } catch (error) {
        log("error", "conversation_card_owner_lookup_failed", {
          sourceTurnId,
          message: errorMessage(error),
        });
      }
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
   * - `tool_search`: searches the desktop's connector/tool registry, which
   *   does not exist in the DO.
   * - `spawn_manager`: the manager runtime coordinates local threads; cloud
   *   equivalents need a manager loop over BuildSessions first.
   */
  private createTools(
    turn: ChatTurnRequest,
    agentHome: AgentHome,
  ): AgentTool[] {
    const base = turn.convexCallbackBase;
    const toolContext = {
      ownerId: turn.ownerId,
      conversationId: turn.conversationId,
      agentHome,
      post: (path: string, body: unknown) => this.convexPost(base, path, body),
    };
    const spawn = async (body: Record<string, unknown>): Promise<string> => {
      const response = await this.convexPost(base, "/api/cloud/spawn", {
        ownerId: turn.ownerId,
        conversationId: turn.conversationId,
        parentTurnId: turn.turnId,
        ...body,
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        threadId?: string;
        error?: string;
      };
      if (!response.ok || payload.ok !== true || !payload.threadId) {
        throw new Error(payload.error ?? "Spawning the agent failed.");
      }
      return payload.threadId;
    };

    return [
      {
        name: "spawn_agent",
        label: "Spawn agent",
        description:
          "Spawn a sub-agent for a well-scoped background task. Returns immediately with a durable `thread_id`; the agent is NOT finished yet — you'll receive an [Agent completed] message on this conversation when it reports.",
        parameters: SPAWN_AGENT_PARAMETERS as unknown as TSchema,
        execute: async (_id, params) => {
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
          const threadId = await spawn({
            action: "spawn",
            description: args.description,
            prompt: args.prompt,
            workspace,
            ...(model && model !== "default" ? { model } : {}),
          });
          return {
            content: [
              {
                type: "text",
                text: `Spawned agent ${threadId} ("${args.description}") in workspace ${workspace}. It is not finished yet — an [Agent completed] message will arrive with its report.`,
              },
            ],
            details: { thread_id: threadId, workspace },
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
        execute: async (_id, params) => {
          const args = params as {
            thread_id: string;
            description: string;
            message: string;
          };
          const threadId = await spawn({
            action: "spawn",
            threadId: args.thread_id,
            description: args.description,
            prompt: args.message,
            workspace: "cloud",
          });
          return {
            content: [
              {
                type: "text",
                text: `Delivered to ${threadId}. It is working again — an [Agent completed] message will arrive with its report.`,
              },
            ],
            details: { thread_id: threadId },
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
        execute: async (_id, params) => {
          const args = params as { thread_id: string };
          // Resolve the exact active turn first, then let its BuildSession DO
          // atomically claim cancellation, stop the process, and deliver the
          // terminal event. A pre-dispatch pause is persisted by that DO and
          // consumed as soon as the delayed turn arrives.
          const response = await this.convexPost(base, "/api/cloud/spawn", {
            action: "cancel",
            ownerId: turn.ownerId,
            conversationId: turn.conversationId,
            threadId: args.thread_id,
          });
          if (!response.ok) {
            throw new Error(`Thread not found: ${args.thread_id}`);
          }
          const canceled = (await response.json()) as {
            status?: string;
            turnId?: string;
          };
          let alreadyTerminal =
            !canceled.turnId &&
            canceled.status !== undefined &&
            canceled.status !== "running";
          let cancellationPending = false;
          if (canceled.turnId) {
            const teardown = await this.env.BUILD_SESSIONS.getByName(
              args.thread_id,
            ).fetch("https://build-session/cancel", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                turnId: canceled.turnId,
                reason: "Paused by orchestrator.",
              }),
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
                  `${args.thread_id} was continued while it was being paused. Try again if the newer turn should also stop.`,
                );
              }
            }
            if (!teardown.ok && !alreadyTerminal) {
              throw new Error(`Could not pause ${args.thread_id}. Try again.`);
            }
          }
          return {
            content: [
              {
                type: "text",
                text: cancellationPending
                  ? `Pause requested for ${args.thread_id}. It is stopping now and can be resumed later with send_input.`
                  : alreadyTerminal
                    ? `${args.thread_id} had already stopped. Resume it later with send_input.`
                    : `Paused ${args.thread_id}. Resume it later with send_input.`,
              },
            ],
            details: { thread_id: args.thread_id, canceled: true },
          };
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
        execute: async (_id, params) => {
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
      ...createMemoryTools(toolContext),
      createScheduleTool(toolContext),
    ];
  }
}
