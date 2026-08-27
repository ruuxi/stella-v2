// @ts-nocheck -- transitional: this store was v2's unchecked transpiled JS
// merged with stella-cloud's typed version; the mixed body is being retyped
// incrementally (tracked in docs/cloud-migration/RECONCILIATION.md).
import { Context, Effect, Layer } from "effect";
import type { AgentModelConfigSnapshot } from "@stella/contracts/agent-engine";
import {
  AGENT_IDS,
  type TaskLifecycleStatus,
} from "@stella/contracts/agent-runtime";
import type {
  EventRecord,
  ThreadActivityAssistantUpdate,
  ThreadActivityRecord,
  ThreadActivityUpdatedPayload,
  ThreadTranscript,
  ThreadTranscriptEntry,
  ThreadTranscriptUpdatedPayload,
} from "@stella/contracts/local-chat";
import {
  MAX_ACTIVE_RUNTIME_THREADS,
  normalizeRuntimeThreadId,
} from "../runtime-threads.js";
import { slugify } from "../shared/slug.js";
import { createDesktopDatabase } from "./database.js";
import type { SqliteDatabase } from "./shared.js";
import {
  DEFAULT_CONVERSATION_SETTING_KEY,
  MAX_EVENTS_PER_CONVERSATION,
  ORCHESTRATOR_ROSTER_CUSTOM_TYPE,
  RUNTIME_THREAD_SESSION_VERSION,
  type RuntimeThreadCompactionEntry,
  type RuntimeThreadCustomMessageEntry,
  type RuntimeThreadCustomMessageMutation,
  type RuntimeThreadMessageEntry,
  type RuntimeThreadSessionEntry,
  type RuntimeThreadMessage,
  type PersistedRuntimeThreadPayload,
  type LocalChatEventRecord,
  type LocalChatEventRow,
  RUNTIME_PRIVATE_TASK_LIFECYCLE_CUSTOM_TYPE,
  asFiniteNumber,
  asObject,
  asTrimmedString,
  eventTextFromPayload,
  generateLocalId,
  isUserContent,
  parseJsonRecord,
  parseRuntimeThreadPayload,
  toJsonString,
  toJsonValueString,
} from "./shared.js";
import { isUiHiddenChatMessagePayload } from "@stella/contracts/chat-event-visibility";
import { normalizeRetiredAgentType } from "@stella/contracts/agent-runtime";
import { ThreadSummaryStore } from "../memory/thread-summary-store.js";
import type { RuntimeThreadRecord } from "../runtime-threads.js";
import {
  CONTEXT_DELTA_CUSTOM_TYPE_PREFIX,
  PINNED_INSTRUCTION_ENTRY_ID_MARKER,
  RESIDENT_FOLD_ENTRY_ID_MARKER,
  isRetiredMemoryCustomMessage,
  parseResidentFold,
  residentIdentityForCustomMessage,
} from "../agent-runtime/resident-context.js";
import {
  estimateProviderPayloadTokens,
  getProviderPayloadImageStats,
} from "../agent-runtime/context-budget.js";
import {
  QUARANTINE_CUSTOM_TYPE,
  parseQuarantineRecord,
} from "../agent-runtime/provider-abort-containment.js";
/**
 * Upper bound on raw source events returned by one mobile sync delta.
 */
const CUTOFF_SCAN_CEILING = 4000;
const CUTOFF_SCAN_BATCH_MIN = 128;
const CUTOFF_SCAN_BATCH_MAX = 512;

/** Hard storage/transport envelope for authored Activity updates. */

export type SessionStoreOptions = {
  onThreadActivityUpdate?: (payload: ThreadActivityUpdatedPayload) => void;
  onThreadAssistantUpdate?: (payload: ThreadActivityUpdatedPayload) => void;
  onThreadTranscriptUpdate?: (payload: ThreadTranscriptUpdatedPayload) => void;
};

type EphemeralThreadMessage = RuntimeThreadMessage & { entryId: string };

type EphemeralThreadCapture = {
  captureId: string;
  seedMessages: EphemeralThreadMessage[];
  appendedMessages: EphemeralThreadMessage[];
};

export type VoiceToolCallReceipt =
  | {
      status: "started";
      operationId: string;
      startedAt: number;
    }
  | {
      status: "pending";
      operationId: string;
      startedAt: number;
    }
  | {
      status: "completed";
      operationId: string;
      startedAt: number;
      completionJson: string;
    };

type VisibleScanRow = {
  timestamp: number | null;
  id: string | null;
  payloadJson: string | null;
};
const MAX_VISIBLE_MESSAGE_WINDOW = 500;
/**
 * A transcript row is an index/preview, not a transport for an arbitrarily
 * large turn. Keep a symmetric head/tail sample so starts and terminal state
 * survive while SQLite remains the source for complete detail.
 */
export const EAGER_TOOL_EVENT_LIMIT = 32;
export const EAGER_TOOL_EVENT_PAYLOAD_BYTES = 4096;
const EAGER_TOOL_EVENT_SIDE_LIMIT = EAGER_TOOL_EVENT_LIMIT / 2;

const projectBoundedJsonValue = (value, depth, limits) => {
  if (
    value == null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= limits.stringChars
      ? value
      : `${value.slice(0, limits.stringChars)}…`;
  }
  if (depth <= 0) return "[detail omitted]";
  if (Array.isArray(value)) {
    const projected = value
      .slice(0, limits.arrayItems)
      .map((item) => projectBoundedJsonValue(item, depth - 1, limits));
    return projected;
  }
  if (typeof value === "object") {
    const projected = {};
    const allEntries = Object.entries(value);
    const entries = [
      ...allEntries.filter(
        ([key]) => key === "fileChanges" || key === "producedFiles",
      ),
      ...allEntries.filter(
        ([key]) => key !== "fileChanges" && key !== "producedFiles",
      ),
    ].slice(0, limits.objectKeys);
    for (const [key, item] of entries) {
      projected[key] =
        (key === "fileChanges" || key === "producedFiles") &&
        Array.isArray(item)
          ? item.slice(0, limits.arrayItems)
          : projectBoundedJsonValue(item, depth - 1, limits);
    }
    if (Object.keys(value).length > entries.length) {
      projected.__truncatedKeys = Object.keys(value).length - entries.length;
    }
    return projected;
  }
  return String(value);
};

const projectEagerEventPayload = (payload) => {
  if (!payload) return { payload, projected: false };
  const markProjected = (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? {
          ...value,
          __stellaEagerProjection: {
            truncated: true,
            fullDetailAvailable: true,
          },
        }
      : value;
  const fitsEnvelope = (value) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    EAGER_TOOL_EVENT_PAYLOAD_BYTES;
  try {
    if (fitsEnvelope(payload)) {
      return { payload, projected: false };
    }
  } catch {
    // Fall through to the defensive projection.
  }
  const projected = markProjected(
    projectBoundedJsonValue(payload, 5, {
      stringChars: 768,
      arrayItems: 10,
      objectKeys: 32,
    }),
  );
  try {
    if (fitsEnvelope(projected)) {
      return { payload: projected, projected: true };
    }
  } catch {
    // Fall through to the smallest projection.
  }
  const minimal = markProjected(
    projectBoundedJsonValue(payload, 3, {
      stringChars: 192,
      arrayItems: 4,
      objectKeys: 16,
    }),
  );
  try {
    if (fitsEnvelope(minimal)) {
      return { payload: minimal, projected: true };
    }
  } catch {
    // Fall through to the artifact-preserving fallback.
  }
  const artifactFallback = {};
  for (const key of ["fileChanges", "producedFiles"]) {
    if (Array.isArray(payload[key]) && payload[key].length > 0) {
      artifactFallback[key] = payload[key].slice(0, 1);
    }
  }
  if (Object.keys(artifactFallback).length > 0) {
    const projectedArtifacts = markProjected(artifactFallback);
    try {
      if (fitsEnvelope(projectedArtifacts)) {
        return { payload: projectedArtifacts, projected: true };
      }
    } catch {
      // Fall through to the constant-size marker.
    }
  }
  return {
    payload: {
      detailOmitted: true,
      __stellaEagerProjection: {
        truncated: true,
        fullDetailAvailable: true,
      },
    },
    projected: true,
  };
};

/** Keep invalidation pushes bounded without truncating authored chat text. */
const projectLocalChatUpdateEventWithMetadata = (event) => {
  if (
    !event?.payload ||
    event.type === "user_message" ||
    event.type === "assistant_message"
  ) {
    return { event, payloadProjected: false };
  }
  const projected = projectEagerEventPayload(event.payload);
  return {
    event: { ...event, payload: projected.payload },
    payloadProjected: projected.projected,
  };
};

export const projectLocalChatUpdateEvent = (event) => {
  return projectLocalChatUpdateEventWithMetadata(event).event;
};
const compareTimelineCursor = (a, b) => {
  // Sequence-aware: when both cursors carry a finite `sequence` (populated only
  // when the ordering-by-sequence flip is active), order by the dedicated
  // monotonic key. Falls back to the legacy (timestamp, id) tuple otherwise, so
  // the default path is byte-identical.
  if (
    typeof a.sequence === "number" &&
    Number.isFinite(a.sequence) &&
    typeof b.sequence === "number" &&
    Number.isFinite(b.sequence)
  ) {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return a.id.localeCompare(b.id);
  }
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.id.localeCompare(b.id);
};
/** Hard storage/transport envelope for authored Activity updates. */
export const AGENT_ASSISTANT_UPDATE_LIMITS = {
  activeThreads: 16,
  messagesPerThread: 3,
  messageChars: 1200,
  messageBytes: 4096,
  threadChars: 3600,
  threadBytes: 12288,
  totalChars: 7200,
  totalBytes: 16384,
  scanRowsPerMessage: 8,
};
/** One chat-transcript hit from `searchTranscripts`. */
export type TranscriptSearchHit = {
  conversationId: string;
  role: "user" | "assistant";
  atMs: number;
  text: string;
};

const DESKTOP_THREAD_ACTIVITY_HYDRATION_LIMIT = 500;
export class FtsSearchUnavailableError extends Error {
  index;
  name = "FtsSearchUnavailableError";
  constructor(index, message, options) {
    super(message, options);
    this.index = index;
  }
}
const throwFtsSearchUnavailable = (index, reason, cause = undefined) => {
  console.error(
    "[stella:recall:fts-degraded]",
    JSON.stringify({ index, reason }),
  );
  throw new FtsSearchUnavailableError(
    index,
    `Recall ${index} FTS unavailable: ${reason}`,
    cause === undefined ? undefined : { cause },
  );
};

type ThreadSessionEntryRow = {
  entryId: string;
  parentEntryId: string | null;
  entryType: string;
  timestampIso: string;
  createdAt: number;
  dataJson: string | null;
};

/** Renderer keeps ≤5 phrases per agent; persistence mirrors that cap. */
export type PersistedAgentRecord = {
  threadId: string;
  conversationId: string;
  /** Transcript ownership for this thread; absent only on pre-migration rows. */
  storageMode?: "cloud" | "local";
  /** Exact owner-data epoch for cloud lifecycle publication and replay. */
  ownerGeneration?: string;
  agentType: string;
  description: string;
  agentDepth: number;
  maxAgentDepth?: number;
  parentAgentId?: string;
  modelConfigSnapshot?: AgentModelConfigSnapshot;
  status: TaskLifecycleStatus;
  /** Persisted ownership epoch so lifecycle ids remain unique after restart. */
  attemptGeneration: number;
  /** Root run that owns the thread's latest lifecycle (send_input rebinds it). */
  rootRunId?: string;
  /** Accepted Manager terminal report, persisted before turn completion. */
  managerFinalReport?: string;
  /** Stable tool-call identity for the accepted terminal report. */
  managerFinalReportId?: string;
  /** Accepted report call identities used for replay deduplication. */
  managerReportIds?: string[];
  /** Durable suffix for unique intermediate report event ids. */
  managerReportSequence?: number;
  /** Latest attempt whose terminal state reached the durable cloud outbox. */
  cloudTerminalReceiptGeneration?: number;
  /** Latest attempt whose exact terminal lifecycle wake is durably delivered. */
  terminalLifecycleReceiptGeneration?: number;
  /** Durable child-report delivery ledger and parked-parent wake state. */
  descendantBoundaryState?: {
    consumedEventIds: string[];
    wakePending: boolean;
    finalParked?: boolean;
  };
  startedAt: number;
  completedAt: number | null;
  result?: string;
  error?: string;
  updatedAt: number;
};

export type CloudTranscriptOutboxKind = "begin" | "finish";

export type CloudTranscriptOutboxRecord = {
  id: string;
  kind: CloudTranscriptOutboxKind;
  conversationId: string;
  deviceId: string;
  /** Null only for a pre-migration row, which delivery retires fail-closed. */
  ownerGeneration: string | null;
  localTurnId: string;
  payloadJson: string;
  recoveryJson: string | null;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type CloudJournalOutboxRecord = {
  sequence: number;
  id: string;
  conversationId: string;
  deviceId: string;
  /** Null only for a pre-migration row, which delivery retires fail-closed. */
  ownerGeneration: string | null;
  appendId: string;
  payloadJson: string;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type CloudAgentControlStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled";

/** Latest server-issued control authority for one desktop-origin cloud agent. */
export type CloudAgentThreadControlRecord = {
  threadId: string;
  ownerGeneration: string;
  cloudConversationId: string;
  originConversationId: string;
  attemptGeneration: number;
  threadUpdatedAt: number;
  status: CloudAgentControlStatus;
  createdAt: number;
  updatedAt: number;
};

/** Immutable pre-network intent plus its optional exact server response. */
export type CloudAgentToolOperationRecord = {
  operationId: string;
  kind: "spawn" | "continue" | "cancel";
  fingerprint: string;
  ownerGeneration: string;
  requestJson: string;
  resultJson: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ComputerAgentCloudOutboxKind = "start" | "terminal" | "cancel";

export type ComputerAgentCloudOutboxRecord = {
  sequence: number;
  id: string;
  kind: ComputerAgentCloudOutboxKind;
  threadId: string;
  attemptGeneration: number;
  ownerScope: string | null;
  ownerGeneration: string | null;
  payloadJson: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type LegacyChatCloudImportCandidate = {
  conversationId: string;
  title: string;
  createdAt: number;
};

export type LegacyChatCloudImportRecord = {
  localConversationId: string;
  cloudConversationId: string | null;
  /** Null only for an untrusted pre-generation migration row. */
  ownerGeneration: string | null;
  nextTurnIndex: number;
  status: "pending" | "complete" | "skipped";
  detail: string | null;
  createdAt: number;
  updatedAt: number;
};

export type LegacyChatVisibleMessage = {
  id: string;
  type: "user_message" | "assistant_message";
  timestamp: number;
  payload: Record<string, unknown>;
};

type CloudTranscriptOutboxRow = {
  id: string;
  kind: CloudTranscriptOutboxKind;
  conversationId: string;
  deviceId: string;
  ownerGeneration: string | null;
  localTurnId: string;
  payloadJson: string;
  recoveryJson: string | null;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type CloudTranscriptOutboxWrite = Omit<
  CloudTranscriptOutboxRecord,
  | "ownerGeneration"
  | "attempts"
  | "lastError"
  | "deadLetteredAt"
  | "createdAt"
  | "updatedAt"
> & { ownerGeneration: string };

const sameCloudTranscriptOutboxWrite = (
  existing: CloudTranscriptOutboxRow,
  expected: CloudTranscriptOutboxWrite,
): boolean =>
  existing.id === expected.id &&
  existing.kind === expected.kind &&
  existing.conversationId === expected.conversationId &&
  existing.deviceId === expected.deviceId &&
  existing.ownerGeneration === expected.ownerGeneration &&
  existing.localTurnId === expected.localTurnId &&
  existing.payloadJson === expected.payloadJson &&
  existing.recoveryJson === expected.recoveryJson;

type CloudJournalOutboxRow = CloudJournalOutboxRecord;
type ComputerAgentCloudOutboxRow = ComputerAgentCloudOutboxRecord;

const parseJsonValue = <T>(value: string | null): T | undefined => {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const parseManagerReportIds = (value: string | null): string[] | undefined => {
  const parsed = parseJsonValue<unknown>(value);
  if (!Array.isArray(parsed)) return undefined;
  const ids = parsed.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return ids.length > 0 ? [...new Set(ids)] : undefined;
};

const parseDescendantBoundaryState = (
  value: string | null,
): PersistedAgentRecord["descendantBoundaryState"] => {
  const parsed = parseJsonValue<unknown>(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const consumedEventIds = Array.isArray(record.consumedEventIds)
    ? [
        ...new Set(
          record.consumedEventIds.filter(
            (entry): entry is string =>
              typeof entry === "string" && entry.trim().length > 0,
          ),
        ),
      ].slice(-256)
    : [];
  return {
    consumedEventIds,
    wakePending: record.wakePending === true,
    ...(record.finalParked === true ? { finalParked: true } : {}),
  };
};

const eventRoleForType = (type: string): string => {
  switch (type) {
    case "user_message":
      return "user";
    case "assistant_message":
      return "assistant";
    case "tool_request":
    case "tool_result":
      return "tool";
    default:
      return "system";
  }
};
const THREAD_CHECKPOINT_MARKER = "[[THREAD_CHECKPOINT]]";
// Hard cap on the text returned per transcript-search hit; the recall
// formatter windows it further around the first match.
const TRANSCRIPT_SEARCH_TEXT_CAP = 4_000;
// Step-1 candidate cap for the FTS-backed thread search. Generous (the
// result limit tops out at 25) so ordering parity with the LIKE scan is
// preserved in practice; `ORDER BY rank` keeps the most relevant candidates
// on the rare query where the cap binds.
const THREAD_SEARCH_FTS_CANDIDATE_CAP = 200;
// SQL-side truncation for unified Recall result/error excerpts: real final
// results average ~4k chars, so unbounded evidence would crowd out other hits.
export const RECALL_THREAD_RESULT_EXCERPT_CHARS = 1_600;
const RECALL_THREAD_ERROR_EXCERPT_CHARS = 300;
// English function words dropped from search queries before matching.
// Under OR-with-ranking semantics a stray stopword can never exclude a
// result, only pad the 6-token budget and inflate scores with rows that
// merely contain "the" — so the list errs toward inclusion.
const SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "from",
  "by",
  "about",
  "into",
  "over",
  "after",
  "before",
  "during",
  "between",
  "is",
  "am",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "doing",
  "have",
  "has",
  "had",
  "having",
  "will",
  "would",
  "can",
  "could",
  "should",
  "shall",
  "may",
  "might",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "it",
  "its",
  "they",
  "them",
  "their",
  "he",
  "him",
  "his",
  "she",
  "her",
  "that",
  "this",
  "these",
  "those",
  "there",
  "here",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "not",
  "no",
  "so",
  "if",
  "then",
  "than",
  "too",
  "very",
  "just",
  "also",
  "any",
  "some",
  "thing",
  "stuff",
  "one",
  "ago",
  "last",
  "recent",
]);
/**
 * Shared tokenizer for the OR-with-ranking searches (`searchThreads`,
 * `searchTranscripts`) and the recall formatter that scores their merged
 * results: whitespace split, stopwords dropped — unless the query is ALL
 * stopwords, which still searches with what it has rather than silently
 * degrading into a recency dump — capped at 12 tokens. The cap was 6, but
 * recall queries routinely enumerate candidates ("was it Apache Trail,
 * Tortilla Flat, Bush Highway/Saguaro Lake?") and truncating at 6 cut
 * exactly the tokens the right transcript rows contained.
 */
export const tokenizeSearchQuery = (query: string): string[] => {
  const rawTokens = (query ?? "")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const meaningful = rawTokens.filter(
    (token) => !SEARCH_STOPWORDS.has(token.toLowerCase()),
  );
  return (meaningful.length > 0 ? meaningful : rawTokens).slice(0, 12);
};
const toIsoTimestamp = (timestamp) => new Date(timestamp).toISOString();
const formatThreadCheckpointMessage = (summary, imageReceipts = []) =>
  [
    THREAD_CHECKPOINT_MARKER,
    "",
    summary.trim(),
    ...(imageReceipts.length > 0
      ? [
          "",
          '<image-receipts version="1">',
          JSON.stringify(imageReceipts),
          "</image-receipts>",
        ]
      : []),
  ].join("\n");
const previewFromTextAndImages = (content) => {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) =>
      block.type === "text" ? block.text : `[Image: ${block.mimeType}]`,
    )
    .join("\n")
    .trim();
};
const previewFromAssistantPayload = (payload) =>
  payload.content
    .flatMap((block) => {
      if (block.type === "text") {
        return block.text.trim() ? [block.text] : [];
      }
      if (block.type === "toolCall") {
        return [
          `[Tool call] ${block.name}\nargs: ${JSON.stringify(block.arguments ?? {})}`,
        ];
      }
      return [];
    })
    .join("\n\n")
    .trim();

const authoredTextFromAssistantPayload = (
  payload: Extract<PersistedRuntimeThreadPayload, { role: "assistant" }>,
): string =>
  payload.content
    .flatMap((block) =>
      block.type === "text" && block.text.trim() ? [block.text] : [],
    )
    .join("\n\n")
    .trim();

/** Human-readable assistant prose for Activity, including final answers. */
const activitySummaryTextFromAssistantPayload = (
  payload: Extract<PersistedRuntimeThreadPayload, { role: "assistant" }>,
): string => authoredTextFromAssistantPayload(payload);

const truncateAuthoredUpdate = (
  value: string,
  maxChars: number = AGENT_ASSISTANT_UPDATE_LIMITS.messageChars,
  maxBytes: number = AGENT_ASSISTANT_UPDATE_LIMITS.messageBytes,
): string => {
  const codePoints = [...value.trim()];
  let end = Math.min(codePoints.length, Math.max(0, maxChars));
  while (end > 0) {
    const candidate = codePoints.slice(0, end).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
    end -= 1;
  }
  return "";
};

const previewFromPayload = (payload: PersistedRuntimeThreadPayload): string => {
  if (payload.role === "assistant") {
    return previewFromAssistantPayload(payload);
  }
  if (payload.role === "toolResult") {
    const body = previewFromTextAndImages(payload.content);
    return [`[Tool result] ${payload.toolName}`, ...(body ? [body] : [])]
      .join("\n")
      .trim();
  }
  return previewFromTextAndImages(payload.content);
};
const buildFallbackThreadPayload = (message) => {
  if (message.payload) {
    return message.payload;
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content:
        message.content.trim().length > 0
          ? [{ type: "text", text: message.content }]
          : [],
      api: "openai-completions",
      provider: "stella",
      model: "history",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: message.timestamp,
    };
  }
  if (message.role === "toolResult") {
    const legacyIsError = /^\s*Error:\s*(?:\[TOOL_ERROR\])?/i.test(
      message.content,
    );
    return {
      role: "toolResult",
      toolCallId: message.toolCallId ?? "",
      toolName: "tool",
      content:
        message.content.trim().length > 0
          ? [{ type: "text", text: message.content }]
          : [],
      isError: legacyIsError,
      timestamp: message.timestamp,
    };
  }
  return {
    role: "user",
    content: message.content,
    timestamp: message.timestamp,
  };
};
const rowSizeTextEncoder = new TextEncoder();
// Tool results that include a screenshot (vision content block) routinely
// run 1–2 MB once the PNG is base64-encoded — that's a normal payload, not
// pathological. The previous 1.8 MB cap was below that threshold, so every
// computer-use snapshot result with an inline screenshot got dropped
// to a "too large to persist" placeholder, breaking the agent's context for
// the very next turn. SQLite handles multi-MB rows fine; bump high enough
// to fit a screenshot + element tree comfortably.
const THREAD_ROW_MAX_BYTES = 6_000_000;
const THREAD_ROW_MAX_TEXT_CHARS = 1_000;
const THREAD_ROW_PREVIEW_CHARS = 500;
const THREAD_EXACT_PAYLOAD_CHUNK_CHARS = 1_000_000;
const THREAD_EXACT_PAYLOAD_MARKER = "__stellaExactPayloadChunks";
const THREAD_CONTEXT_PRESSURE_MARKER = "__stellaContextPressure";
const isHighSurrogate = (codeUnit) => codeUnit >= 0xd800 && codeUnit <= 0xdbff;
const isLowSurrogate = (codeUnit) => codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
const payloadByteLength = (payload) =>
  rowSizeTextEncoder.encode(JSON.stringify(payload)).byteLength;
const customMessageByteLength = (
  message: Pick<
    RuntimeThreadCustomMessageEntry,
    "customType" | "content" | "display" | "eventId" | "lifecycleEvent"
  >,
): number => rowSizeTextEncoder.encode(JSON.stringify(message)).byteLength;

type ThreadLifecycleEventType = NonNullable<
  RuntimeThreadCustomMessageEntry["lifecycleEvent"]
>["type"];

const isThreadLifecycleEventType = (
  value: string,
): value is ThreadLifecycleEventType =>
  value === "agent-started" ||
  value === "agent-progress" ||
  value === "agent-completed" ||
  value === "agent-failed" ||
  value === "agent-canceled";

const jsonByteLength = (json) => rowSizeTextEncoder.encode(json).byteLength;
const chunkExactThreadEntryData = (exactData, boundedData) => {
  const exactDataJson = toJsonValueString(exactData);
  if (jsonByteLength(exactDataJson) <= THREAD_ROW_MAX_BYTES) {
    return { data: exactData };
  }
  const exactChunkEnds = [];
  for (let cursor = 0; cursor < exactDataJson.length; ) {
    let end = Math.min(
      exactDataJson.length,
      cursor + THREAD_EXACT_PAYLOAD_CHUNK_CHARS,
    );
    if (
      end < exactDataJson.length &&
      isHighSurrogate(exactDataJson.charCodeAt(end - 1)) &&
      isLowSurrogate(exactDataJson.charCodeAt(end))
    ) {
      end -= 1;
    }
    exactChunkEnds.push(end);
    cursor = end;
  }
  const data = {
    ...boundedData,
    [THREAD_EXACT_PAYLOAD_MARKER]: {
      version: 1,
      chunkCount: exactChunkEnds.length,
      byteLength: jsonByteLength(exactDataJson),
    },
  };
  if (jsonByteLength(toJsonValueString(data)) > THREAD_ROW_MAX_BYTES) {
    throw new Error(
      "Exact thread payload metadata exceeds the SQLite row limit.",
    );
  }
  return { data, exactDataJson, exactChunkEnds };
};
const truncatePreview = (
  value: string,
  maxChars = THREAD_ROW_PREVIEW_CHARS,
): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
const truncateTextBlockForStorage = (text, label = "Text") =>
  `[${label} truncated for storage (${text.length} chars). First ${Math.min(text.length, THREAD_ROW_PREVIEW_CHARS)} chars: ${truncatePreview(text)}]`;
const truncateToolOutputForStorage = (text) =>
  `This tool output was too large to persist in storage (${text.length} chars). If the user asks about this data, suggest re-running the tool. Preview: ${truncatePreview(text)}`;
const strippedImageStorageNote = (image) => {
  const sourcePath = image.sourcePath?.trim();
  if (sourcePath) {
    return {
      type: "text",
      text: `<image_reference>\n${sourcePath}\nUse the Read tool with file_path set to this absolute path to inspect the image.\n</image_reference>`,
    };
  }
  const sizeKb = Math.round(((image.data?.length ?? 0) * 0.75) / 1024);
  return {
    type: "text",
    text: `[image content block stripped for storage: mime=${image.mimeType ?? "image/png"} approx_kb=${sizeKb}]`,
  };
};
const payloadContainsImage = (payload) =>
  typeof payload?.content !== "string" &&
  Array.isArray(payload?.content) &&
  payload.content.some((block) => block?.type === "image");
const customMessageContainsImage = (message) =>
  Array.isArray(message?.content) &&
  message.content.some((block) => block?.type === "image");
const buildThreadContextPressure = (value) => {
  const images = getProviderPayloadImageStats({ messages: [value] });
  return {
    version: 1,
    estimatedTokens: estimateProviderPayloadTokens(
      { messages: [value] },
      Number.POSITIVE_INFINITY,
    ),
    imageCount: images.count,
    imageDecodedBytes: images.decodedBytes,
  };
};
const truncateObjectForStorage = (value, label) => {
  const json = JSON.stringify(value);
  return {
    __truncated: `${label} truncated for storage (${json.length} chars). Preview: ${truncatePreview(json)}`,
  };
};
const enforceThreadPayloadRowSizeLimit = (payload) => {
  if (payloadByteLength(payload) <= THREAD_ROW_MAX_BYTES) {
    return payload;
  }
  if (payload.role === "user") {
    const content =
      typeof payload.content === "string"
        ? truncateTextBlockForStorage(payload.content, "User content")
        : payload.content.map((block) =>
            block.type === "text" &&
            block.text.length > THREAD_ROW_MAX_TEXT_CHARS
              ? {
                  ...block,
                  text: truncateTextBlockForStorage(block.text, "User content"),
                }
              : block,
          );
    const candidate = { ...payload, content };
    if (payloadByteLength(candidate) <= THREAD_ROW_MAX_BYTES) {
      return candidate;
    }
    if (typeof content !== "string") {
      const withoutImageData = {
        ...payload,
        content: content.map((block) =>
          block.type === "image" ? strippedImageStorageNote(block) : block,
        ),
      };
      if (payloadByteLength(withoutImageData) <= THREAD_ROW_MAX_BYTES) {
        return withoutImageData;
      }
    }
    return {
      ...payload,
      content:
        typeof payload.content === "string"
          ? truncateTextBlockForStorage(payload.content, "User content")
          : [
              {
                type: "text",
                text: truncateTextBlockForStorage(
                  JSON.stringify(payload.content),
                  "User content",
                ),
              },
            ],
    };
  }
  if (payload.role === "assistant") {
    const compacted = {
      ...payload,
      content: payload.content.map((block) => {
        if (
          block.type === "text" &&
          block.text.length > THREAD_ROW_MAX_TEXT_CHARS
        ) {
          return { ...block, text: truncateTextBlockForStorage(block.text) };
        }
        if (
          block.type === "thinking" &&
          block.thinking.length > THREAD_ROW_MAX_TEXT_CHARS
        ) {
          return {
            ...block,
            thinking: truncateTextBlockForStorage(block.thinking, "Reasoning"),
          };
        }
        if (block.type === "toolCall") {
          const argsJson = JSON.stringify(block.arguments ?? {});
          if (argsJson.length > THREAD_ROW_MAX_TEXT_CHARS) {
            return {
              ...block,
              arguments: truncateObjectForStorage(
                block.arguments ?? {},
                `${block.name} arguments`,
              ),
            };
          }
        }
        return block;
      }),
    };
    if (payloadByteLength(compacted) <= THREAD_ROW_MAX_BYTES) {
      return compacted;
    }
    return {
      ...payload,
      content: [
        {
          type: "text",
          text: truncateTextBlockForStorage(
            JSON.stringify(payload.content),
            "Assistant message",
          ),
        },
      ],
    };
  }
  const compacted = {
    ...payload,
    content: payload.content.map((block) =>
      block.type === "text" && block.text.length > THREAD_ROW_MAX_TEXT_CHARS
        ? { ...block, text: truncateToolOutputForStorage(block.text) }
        : block,
    ),
  };
  if (payloadByteLength(compacted) <= THREAD_ROW_MAX_BYTES) {
    return compacted;
  }
  // Still too big — almost always because an inline image (vision content
  // block) ballooned the row. Drop the base64 payload of every image and
  // leave a small text breadcrumb in its place so the rest of the result
  // (and any other text blocks the model still needs) survives.
  const withoutImageData = {
    ...compacted,
    content: compacted.content.map((block) => {
      if (block.type !== "image") {
        return block;
      }
      return strippedImageStorageNote(block);
    }),
  };
  if (payloadByteLength(withoutImageData) <= THREAD_ROW_MAX_BYTES) {
    return withoutImageData;
  }
  return {
    ...payload,
    content: [
      {
        type: "text",
        text: truncateToolOutputForStorage(JSON.stringify(payload.content)),
      },
    ],
  };
};

const enforceCustomMessageRowSizeLimit = (
  message: Pick<
    RuntimeThreadCustomMessageEntry,
    "customType" | "content" | "display" | "eventId" | "lifecycleEvent"
  >,
): Pick<
  RuntimeThreadCustomMessageEntry,
  "customType" | "content" | "display" | "eventId" | "lifecycleEvent"
> => {
  if (customMessageByteLength(message) <= THREAD_ROW_MAX_BYTES) {
    return message;
  }
  const content =
    typeof message.content === "string"
      ? truncateTextBlockForStorage(message.content, "Custom message")
      : message.content.map((block) => {
          if (
            block.type === "text" &&
            block.text.length > THREAD_ROW_MAX_TEXT_CHARS
          ) {
            return {
              ...block,
              text: truncateTextBlockForStorage(block.text, "Custom message"),
            };
          }
          return block;
        });
  const compacted = {
    ...message,
    content,
  };
  if (customMessageByteLength(compacted) <= THREAD_ROW_MAX_BYTES) {
    return compacted;
  }
  const withoutImageData = {
    ...compacted,
    content:
      typeof compacted.content === "string"
        ? compacted.content
        : compacted.content.map((block) => {
            if (block.type !== "image") {
              return block;
            }
            const sizeKb = Math.round(
              ((block.data?.length ?? 0) * 0.75) / 1024,
            );
            return {
              type: "text",
              text: `[image content block stripped for storage: mime=${block.mimeType ?? "image/png"} approx_kb=${sizeKb}]`,
            };
          }),
  };
  if (customMessageByteLength(withoutImageData) <= THREAD_ROW_MAX_BYTES) {
    return withoutImageData;
  }
  return {
    ...message,
    content:
      typeof message.content === "string"
        ? truncateTextBlockForStorage(message.content, "Custom message")
        : [
            {
              type: "text",
              text: truncateTextBlockForStorage(
                JSON.stringify(message.content),
                "Custom message",
              ),
            },
          ],
  };
};
const THREAD_LIFECYCLE_EVENT_TYPES = new Set([
  "agent-started",
  "agent-progress",
  "agent-completed",
  "agent-failed",
  "agent-canceled",
]);
const parseStoredThreadLifecycleEvent = (value) => {
  const record = asObject(value);
  const id = asTrimmedString(record?._id);
  const type = asTrimmedString(record?.type);
  const timestamp = asFiniteNumber(record?.timestamp);
  if (
    !id ||
    !type ||
    !THREAD_LIFECYCLE_EVENT_TYPES.has(type) ||
    timestamp === null
  ) {
    return null;
  }
  const payload = asObject(record?.payload);
  return {
    _id: id,
    timestamp,
    type,
    ...(payload ? { payload } : {}),
  };
};
const parseThreadSessionEntry = (row) => {
  const data = parseJsonValue(row.dataJson);
  switch (row.entryType) {
    case "message": {
      const rawMessage =
        data && "message" in data
          ? parseRuntimeThreadPayload(JSON.stringify(data.message))
          : undefined;
      if (!rawMessage) {
        return null;
      }
      return {
        type: "message",
        id: row.entryId,
        parentId: row.parentEntryId,
        timestamp: row.timestampIso,
        message: rawMessage,
      };
    }
    case "compaction": {
      const summary =
        typeof data?.summary === "string" ? data.summary.trim() : "";
      const fromEntryId =
        typeof data?.fromEntryId === "string" ? data.fromEntryId.trim() : "";
      const toEntryId =
        typeof data?.toEntryId === "string" ? data.toEntryId.trim() : "";
      const firstKeptEntryId =
        typeof data?.firstKeptEntryId === "string"
          ? data.firstKeptEntryId.trim()
          : "";
      const tokensBefore =
        typeof data?.tokensBefore === "number" &&
        Number.isFinite(data.tokensBefore)
          ? data.tokensBefore
          : 0;
      const rawSummaryValidation =
        data?.summaryValidation &&
        typeof data.summaryValidation === "object" &&
        !Array.isArray(data.summaryValidation)
          ? (data.summaryValidation as Record<string, unknown>)
          : undefined;
      const summaryValidation =
        rawSummaryValidation?.version === 1 &&
        typeof rawSummaryValidation.middleTokens === "number" &&
        Number.isFinite(rawSummaryValidation.middleTokens) &&
        Number.isSafeInteger(rawSummaryValidation.middleTokens) &&
        rawSummaryValidation.middleTokens >= 0 &&
        (rawSummaryValidation.previousSummary === null ||
          typeof rawSummaryValidation.previousSummary === "string")
          ? {
              version: 1 as const,
              middleTokens: rawSummaryValidation.middleTokens,
              previousSummary: rawSummaryValidation.previousSummary as
                | string
                | null,
            }
          : undefined;
      if (!summary || (!(fromEntryId && toEntryId) && !firstKeptEntryId)) {
        return null;
      }
      return {
        type: "compaction",
        id: row.entryId,
        parentId: row.parentEntryId,
        timestamp: row.timestampIso,
        summary,
        ...(fromEntryId && toEntryId ? { fromEntryId, toEntryId } : {}),
        ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
        tokensBefore,
        ...(summaryValidation ? { summaryValidation } : {}),
        ...(data && "details" in data ? { details: data.details } : {}),
        ...(data?.fromHook === true ? { fromHook: true } : {}),
      };
    }
    case "custom_message": {
      const customType =
        typeof data?.customType === "string" ? data.customType.trim() : "";
      const content = data?.content;
      const display = data?.display === true;
      const eventId =
        typeof data?.eventId === "string" && data.eventId.trim()
          ? data.eventId.trim()
          : undefined;
      const rawLifecycleEvent = asObject(data?.lifecycleEvent);
      const lifecycleType = asTrimmedString(rawLifecycleEvent?.type);
      const lifecyclePayload = asObject(rawLifecycleEvent?.payload);
      const lifecycleEvent =
        isThreadLifecycleEventType(lifecycleType) &&
        asTrimmedString(lifecyclePayload?.agentId)
          ? {
              type: lifecycleType,
              payload: lifecyclePayload as Record<string, unknown>,
            }
          : undefined;
      if (!customType || !isUserContent(content)) {
        return null;
      }
      return {
        type: "custom_message",
        id: row.entryId,
        parentId: row.parentEntryId,
        timestamp: row.timestampIso,
        customType,
        content,
        display,
        ...(eventId ? { eventId } : {}),
        ...(lifecycleEvent ? { lifecycleEvent } : {}),
      } satisfies RuntimeThreadCustomMessageEntry;
    }
    case "lifecycle_event": {
      const event = parseStoredThreadLifecycleEvent(data?.event);
      if (!event) return null;
      return {
        type: "lifecycle_event",
        id: row.entryId,
        parentId: row.parentEntryId,
        timestamp: row.timestampIso,
        event,
      };
    }
    default:
      return null;
  }
};
const toThreadMessageRecord = (entry) => {
  if (entry.type === "message") {
    const payload = entry.message;
    return {
      entryId: entry.id,
      threadKey: "",
      timestamp: payload.timestamp,
      role: payload.role,
      content: previewFromPayload(payload),
      ...(payload.role === "toolResult"
        ? { toolCallId: payload.toolCallId }
        : {}),
      payload,
    };
  }
  if (entry.type === "custom_message") {
    return {
      entryId: entry.id,
      threadKey: "",
      timestamp: Date.parse(entry.timestamp) || Date.now(),
      role: "runtimeInternal",
      content: previewFromTextAndImages(entry.content),
      customMessage: {
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        ...(entry.eventId ? { eventId: entry.eventId } : {}),
        ...(entry.lifecycleEvent
          ? { lifecycleEvent: entry.lifecycleEvent }
          : {}),
      },
    };
  }
  return null;
};
const buildThreadPathEntries = (entries) => {
  if (entries.length === 0) {
    return [];
  }
  const byId = new Map();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }

  let leaf: RuntimeThreadSessionEntry | undefined = entries[entries.length - 1];
  const reversePath: RuntimeThreadSessionEntry[] = [];
  const visited = new Set<string>();
  while (leaf) {
    // Malformed imported history must not hang reconstruction. Falling back
    // to the durable insertion order also retains every legitimate legacy
    // sibling created by the former same-millisecond parent race.
    if (visited.has(leaf.id)) return entries;
    visited.add(leaf.id);
    reversePath.push(leaf);
    leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
  }
  if (reversePath.length !== entries.length) return entries;
  return reversePath.reverse();
};
const buildRawThreadMessages = (path) =>
  path
    .map((entry) => toThreadMessageRecord(entry))
    .filter((message) => message !== null);
/**
 * Validate a `pinnedUserInstruction` recovered from a persisted compaction
 * entry's `details` (written by `maybeCompactRuntimeThread`). Returns
 * `{ text }` or null when absent/malformed.
 */
const parsePinnedUserInstruction = (details) => {
  const pinned =
    details && typeof details === "object" && !Array.isArray(details)
      ? details.pinnedUserInstruction
      : undefined;
  const text =
    pinned && typeof pinned === "object" && typeof pinned.text === "string"
      ? pinned.text.trim()
      : "";
  return text ? { text } : null;
};

const parseCheckpointQuarantineKeys = (details) => {
  const keys =
    details && typeof details === "object" && !Array.isArray(details)
      ? details.quarantinedToolResultKeys
      : undefined;
  if (!Array.isArray(keys)) return [];
  return [
    ...new Set(
      keys.flatMap((key) =>
        typeof key === "string" && key.trim() ? [key.trim()] : [],
      ),
    ),
  ];
};

const parseImageReceipts = (details) => {
  const receipts =
    details && typeof details === "object" && !Array.isArray(details)
      ? details.imageReceipts
      : undefined;
  if (!Array.isArray(receipts)) return [];
  return receipts.flatMap((receipt) => {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      return [];
    }
    const id = typeof receipt.id === "string" ? receipt.id.trim() : "";
    const mimeType =
      typeof receipt.mimeType === "string" ? receipt.mimeType.trim() : "";
    const decodedBytes = Number(receipt.decodedBytes);
    const origin = receipt.origin;
    const artifact = receipt.artifact;
    if (
      !/^sha256:[a-f0-9]{64}$/.test(id) ||
      !mimeType.startsWith("image/") ||
      !Number.isFinite(decodedBytes) ||
      decodedBytes < 0 ||
      !origin ||
      typeof origin !== "object" ||
      !Number.isFinite(Number(origin.timestamp)) ||
      typeof origin.role !== "string" ||
      !artifact ||
      typeof artifact !== "object" ||
      !["durable", "non-durable"].includes(artifact.durability)
    ) {
      return [];
    }
    return [receipt];
  });
};

const normalizeCompactionOverlay = (compaction, rawMessages) => {
  const timestamp = Date.parse(compaction.timestamp) || Date.now();
  const residentFold = parseResidentFold(compaction.details);
  const replaceDerivedContext =
    compaction.details &&
    typeof compaction.details === "object" &&
    compaction.details.replaceDerivedContext === true;
  const pinnedUserInstruction = parsePinnedUserInstruction(compaction.details);
  const checkpointQuarantineKeys = parseCheckpointQuarantineKeys(
    compaction.details,
  );
  const imageReceipts = parseImageReceipts(compaction.details);
  if (compaction.fromEntryId && compaction.toEntryId) {
    return {
      id: compaction.id,
      summary: compaction.summary,
      fromEntryId: compaction.fromEntryId,
      toEntryId: compaction.toEntryId,
      timestamp,
      ...(replaceDerivedContext ? { replaceDerivedContext: true } : {}),
      ...(residentFold ? { residentFold } : {}),
      ...(pinnedUserInstruction ? { pinnedUserInstruction } : {}),
      ...(checkpointQuarantineKeys.length > 0
        ? { checkpointQuarantineKeys }
        : {}),
      ...(imageReceipts.length > 0 ? { imageReceipts } : {}),
    };
  }
  if (!compaction.firstKeptEntryId) {
    return null;
  }
  const firstKeptIndex = rawMessages.findIndex(
    (message) => message.entryId === compaction.firstKeptEntryId,
  );
  if (firstKeptIndex <= 0) {
    return null;
  }
  const fromEntryId = rawMessages[0]?.entryId;
  const toEntryId = rawMessages[firstKeptIndex - 1]?.entryId;
  if (!fromEntryId || !toEntryId) {
    return null;
  }
  return {
    id: compaction.id,
    summary: compaction.summary,
    fromEntryId,
    toEntryId,
    timestamp,
    ...(replaceDerivedContext ? { replaceDerivedContext: true } : {}),
    ...(residentFold ? { residentFold } : {}),
    ...(pinnedUserInstruction ? { pinnedUserInstruction } : {}),
    ...(checkpointQuarantineKeys.length > 0
      ? { checkpointQuarantineKeys }
      : {}),
    ...(imageReceipts.length > 0 ? { imageReceipts } : {}),
  };
};
const buildThreadCompactionOverlays = (path, rawMessages) =>
  path
    .filter((entry) => entry.type === "compaction")
    .map((entry) => normalizeCompactionOverlay(entry, rawMessages))
    .filter((entry) => entry !== null);
/**
 * Derived-context replacement half of the overlay application. The newest
 * applied overlay written by `maybeCompactRuntimeThread` re-establishes the
 * canonical resident context:
 *
 *   1. every older copy of a folded block (stale head docs, mid-thread
 *      re-appends that survived in the kept tail) and every accumulated
 *      `runtime.context_delta.*` notice from before the compaction is
 *      dropped from the materialized window;
 *   2. exactly one fresh copy of each folded block is emitted immediately
 *      before that overlay's checkpoint message — i.e. at the head of the
 *      rebuilt window, where compaction head-protection keeps it pinned.
 *
 * Copies appended AFTER the compaction (timestamp > overlay timestamp) are
 * genuine new deltas and are left in place. Purely derived from persisted
 * entries, so every store rebuild materializes the same canonical window.
 */
const applyResidentFold = (messages, overlay) => {
  const fold = overlay.residentFold ?? {
    docs: [],
    identities: new Set(),
  };
  const checkpointIndex = messages.findIndex(
    (message) => message.entryId === overlay.id,
  );
  if (checkpointIndex < 0) {
    return messages;
  }
  const swept = messages.filter((message) => {
    if (message.role !== "runtimeInternal" || !message.customMessage) {
      return true;
    }
    if (isRetiredMemoryCustomMessage(message.customMessage)) {
      return false;
    }
    if (message.timestamp > overlay.timestamp) {
      return true;
    }
    const customType = message.customMessage.customType;
    if (customType === ORCHESTRATOR_ROSTER_CUSTOM_TYPE) {
      return false;
    }
    if (
      typeof customType === "string" &&
      customType.startsWith(CONTEXT_DELTA_CUSTOM_TYPE_PREFIX)
    ) {
      return false;
    }
    const identity = residentIdentityForCustomMessage(message.customMessage);
    return !(identity && fold.identities.has(identity));
  });
  const insertIndex = swept.findIndex(
    (message) => message.entryId === overlay.id,
  );
  if (insertIndex < 0) {
    return swept;
  }
  const docMessages = fold.docs.map((doc, docIndex) => ({
    entryId: `${overlay.id}${RESIDENT_FOLD_ENTRY_ID_MARKER}${docIndex}`,
    threadKey: "",
    timestamp: overlay.timestamp,
    role: "runtimeInternal",
    content: previewFromTextAndImages([{ type: "text", text: doc.text }]),
    customMessage: {
      customType: doc.customType,
      content: [{ type: "text", text: doc.text }],
      display: false,
    },
  }));
  swept.splice(insertIndex, 0, ...docMessages);
  return swept;
};
const applyCompactionOverlays = (rawMessages, overlays) => {
  if (rawMessages.length === 0 || overlays.length === 0) {
    return rawMessages;
  }
  const ids = rawMessages.map((message) => message.entryId);
  let result = [];
  const appliedOverlays = [];
  let index = 0;
  while (index < rawMessages.length) {
    const matching = overlays.filter(
      (overlay) => overlay.fromEntryId === ids[index],
    );
    const overlay =
      matching.length > 1 ? matching[matching.length - 1] : matching[0];
    if (overlay) {
      const endIndex = ids.indexOf(overlay.toEntryId);
      if (endIndex >= index) {
        appliedOverlays.push(overlay);
        result.push({
          entryId: overlay.id,
          threadKey: "",
          timestamp: overlay.timestamp,
          role: "assistant",
          content: formatThreadCheckpointMessage(
            overlay.summary,
            overlay.imageReceipts,
          ),
          ...(overlay.checkpointQuarantineKeys
            ? {
                checkpointQuarantineKeys: overlay.checkpointQuarantineKeys,
              }
            : {}),
          ...(overlay.imageReceipts
            ? { checkpointImageReceipts: overlay.imageReceipts }
            : {}),
        });
        // Re-emit the pinned latest-user-instruction copy carried on the
        // overlay right after its checkpoint, so the current instruction
        // stays model-visible verbatim even though its original turn was
        // summarized into the middle. Synthetic entryId — span boundaries
        // never land on it (see thread-runtime split guards).
        if (overlay.pinnedUserInstruction) {
          result.push({
            entryId: `${overlay.id}${PINNED_INSTRUCTION_ENTRY_ID_MARKER}`,
            threadKey: "",
            timestamp: overlay.timestamp,
            role: "user",
            content: overlay.pinnedUserInstruction.text,
            payload: {
              role: "user",
              content: overlay.pinnedUserInstruction.text,
              timestamp: overlay.timestamp,
            },
          });
        }
        index = endIndex + 1;
        continue;
      }
    }
    result.push(rawMessages[index]);
    index += 1;
  }
  const foldOverlay = appliedOverlays
    .filter((overlay) => overlay.residentFold || overlay.replaceDerivedContext)
    .pop();
  if (foldOverlay) {
    result = applyResidentFold(result, foldOverlay);
  }
  return result;
};
const buildThreadMessagesFromEntries = (entries) => {
  const path = buildThreadPathEntries(entries);
  const rawMessages = buildRawThreadMessages(path);
  const overlays = buildThreadCompactionOverlays(path, rawMessages);
  return applyCompactionOverlays(rawMessages, overlays);
};
const isClaudeCodeAssistantPayload = (
  payload: PersistedRuntimeThreadPayload | undefined,
): payload is Extract<PersistedRuntimeThreadPayload, { role: "assistant" }> =>
  payload?.role === "assistant" &&
  payload.api === "anthropic-messages" &&
  payload.provider === "anthropic" &&
  payload.model === "claude-code";

const structuredToolResultObject = (
  payload: PersistedRuntimeThreadPayload | undefined,
): Record<string, unknown> | null => {
  if (payload?.role !== "toolResult" || payload.isError) return null;
  const text =
    typeof payload.content === "string"
      ? payload.content
      : payload.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n")
          .trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return asObject(parsed);
  } catch {
    return null;
  }
};

export class SessionStore {
  private threadSummaryStoreInstance: ThreadSummaryStore | null = null;
  /**
   * Cloud turns keep their provider transcript in process memory until the
   * terminal batch is synchronously admitted to cloud_transcript_outbox.
   * Nothing in this map is restart recovery state: an orphaned durable begin
   * is intentionally recovered as an empty canceled finish.
   */
  private readonly ephemeralThreadCaptures = new Map<
    string,
    EphemeralThreadCapture
  >();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: SessionStoreOptions = {},
  ) {}

  #orderingBySequenceCache: boolean | null = null;
  /**
   * Whether chat timeline ordering keys on the monotonic `ordering_sequence`.
   * There is NO feature flag — sequence ordering is the default. This is the
   * SAFETY GATE for graceful degradation: it is true only when the column
   * exists AND every row is backfilled. If the unconditional startup migration
   * failed (disk/IO/busy) or is mid-backfill, the column is absent or has NULL
   * rows, and the store transparently falls back to the legacy `(created_at,
   * id)` ordering so queries keep working and no row is mis-placed/dropped —
   * rather than emitting `ORDER BY ordering_sequence` against a missing column
   * or a NULL that sorts to an end. Cached per store (the column only
   * transitions absent→present→complete once, before the store serves queries).
   */
  get orderingBySequence() {
    if (this.#orderingBySequenceCache === null) {
      let ok = false;
      try {
        const cols = this.db.prepare("PRAGMA table_info(message);").all();
        if (cols.some((col) => col.name === "ordering_sequence")) {
          const nullRow = this.db
            .prepare(
              `SELECT 1 AS present FROM message WHERE ordering_sequence IS NULL LIMIT 1`,
            )
            .get();
          ok = !nullRow;
        }
      } catch {
        ok = false;
      }
      this.#orderingBySequenceCache = ok;
    }
    return this.#orderingBySequenceCache;
  }
  /** SELECT fragment adding `ordering_sequence AS sequence`, only when active. */
  orderingSequenceSelect(alias?: string): string {
    if (!this.orderingBySequence) return "";
    const p = alias ? `${alias}.` : "";
    return `, ${p}ordering_sequence AS sequence`;
  }
  /**
   * ORDER BY fragment for a table (optional `alias`). Keys on the monotonic
   * `ordering_sequence` in the steady state; falls back to the legacy
   * `(created_at, id)` tuple when the sequence is unavailable/incomplete (see
   * orderingBySequence).
   */
  timelineOrderBy(alias?: string, direction?: "ASC" | "DESC"): string {
    const p = alias ? `${alias}.` : "";
    const dir = direction === "DESC" ? "DESC" : "ASC";
    return this.orderingBySequence
      ? `${p}ordering_sequence ${dir}, ${p}id ${dir}`
      : `${p}created_at ${dir}, ${p}id ${dir}`;
  }
  /**
   * Keyset comparison predicate for a table (optional `alias`) against a bound
   * cursor, e.g. ">=". Keys on `ordering_sequence` whenever the cursor carries
   * one. FALLBACK (version skew / defensive): when a cursor has no resolvable
   * sequence — an external cursor whose row was deleted (Rewind), or a row from
   * a peer on an older build that never carried a sequence — it degrades to the
   * legacy `(created_at, id)` value comparison, which still works on a bound
   * timestamp/id even when the row is gone. Returns { clause, params } so call
   * sites bind the right arity (1 for sequence, 2 for the legacy tuple).
   */
  timelineKeyset(
    alias: string | undefined,
    op: string,
    cursor: { timestamp: number; id: string; sequence?: number },
  ): { clause: string; params: unknown[] } {
    const p = alias ? `${alias}.` : "";
    if (
      this.orderingBySequence &&
      typeof cursor.sequence === "number" &&
      Number.isFinite(cursor.sequence)
    ) {
      return {
        clause: `${p}ordering_sequence ${op} ?`,
        params: [cursor.sequence],
      };
    }
    // Legacy (created_at, id) keyset. Outer bound is strict (> for >/>=, < for
    // </<=); the same-timestamp tie uses the exact operator.
    const outer = op === ">" || op === ">=" ? ">" : "<";
    return {
      clause: `(${p}created_at ${outer} ? OR (${p}created_at = ? AND ${p}id ${op} ?))`,
      params: [cursor.timestamp, cursor.timestamp, cursor.id],
    };
  }
  /** Lazily constructed durable delegated-thread summary store. */
  get threadSummaryStore() {
    if (!this.threadSummaryStoreInstance) {
      this.threadSummaryStoreInstance = new ThreadSummaryStore(this.db);
    }
    return this.threadSummaryStoreInstance;
  }

  private withTransaction<T>(
    work: () => T,
    mode: "deferred" | "immediate" = "deferred",
  ): T {
    this.db.exec(
      mode === "immediate" ? "BEGIN IMMEDIATE;" : "BEGIN TRANSACTION;",
    );
    try {
      const result = work();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  /** Reserve the WAL writer before a read-then-write decision. */
  withImmediateTransaction(work) {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      work();
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
  getSetting(key) {
    const row = this.db
      .prepare(
        `
      SELECT value
      FROM settings
      WHERE key = ?
    `,
      )
      .get(key);
    return typeof row?.value === "string" && row.value.length > 0
      ? row.value
      : null;
  }
  setSetting(key, value) {
    this.db
      .prepare(
        `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
      )
      .run(key, value, Date.now());
  }

  listLegacyChatCloudImportCandidates(
    limit = 100,
  ): LegacyChatCloudImportCandidate[] {
    const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    return this.db
      .prepare(
        `
      SELECT
        session.id AS conversationId,
        session.title AS title,
        session.created_at AS createdAt
      FROM session
      LEFT JOIN legacy_chat_cloud_import AS legacy_import
        ON legacy_import.local_conversation_id = session.id
      WHERE session.parent_id IS NULL
        AND (
          legacy_import.status IS NULL
          OR legacy_import.status = 'pending'
        )
        AND EXISTS (
          SELECT 1
          FROM message
          WHERE message.session_id = session.id
            AND message.type IN ('user_message', 'assistant_message')
        )
      ORDER BY session.created_at ASC, session.id ASC
      LIMIT ?
    `,
      )
      .all(normalizedLimit) as LegacyChatCloudImportCandidate[];
  }

  getLegacyChatCloudImport(
    localConversationIdInput: string,
  ): LegacyChatCloudImportRecord | null {
    const localConversationId = this.sanitizeConversationId(
      localConversationIdInput,
    );
    const row = this.db
      .prepare(
        `
      SELECT
        local_conversation_id AS localConversationId,
        cloud_conversation_id AS cloudConversationId,
        owner_generation AS ownerGeneration,
        next_turn_index AS nextTurnIndex,
        status,
        detail,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM legacy_chat_cloud_import
      WHERE local_conversation_id = ?
      LIMIT 1
    `,
      )
      .get(localConversationId) as LegacyChatCloudImportRecord | undefined;
    return row ?? null;
  }

  saveLegacyChatCloudImport(args: {
    localConversationId: string;
    cloudConversationId?: string | null;
    ownerGeneration?: string | null;
    nextTurnIndex: number;
    status: "pending" | "complete" | "skipped";
    detail?: string | null;
  }): void {
    const localConversationId = this.sanitizeConversationId(
      args.localConversationId,
    );
    const cloudConversationId = asTrimmedString(args.cloudConversationId);
    const ownerGeneration = asTrimmedString(args.ownerGeneration);
    const nextTurnIndex = Math.max(0, Math.floor(args.nextTurnIndex));
    const detail = asTrimmedString(args.detail);
    const now = Date.now();
    this.withTransaction(() => {
      const existing = this.db
        .prepare(
          `SELECT owner_generation AS ownerGeneration
             FROM legacy_chat_cloud_import
            WHERE local_conversation_id = ?
            LIMIT 1`,
        )
        .get(localConversationId) as
        | { ownerGeneration: string | null }
        | undefined;
      if (
        existing?.ownerGeneration &&
        ownerGeneration &&
        existing.ownerGeneration !== ownerGeneration
      ) {
        throw new Error(
          "Legacy chat import cannot be rebound to another owner generation.",
        );
      }
      this.db
        .prepare(
          `
        INSERT INTO legacy_chat_cloud_import (
          local_conversation_id,
          cloud_conversation_id,
          owner_generation,
          next_turn_index,
          status,
          detail,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(local_conversation_id) DO UPDATE SET
          cloud_conversation_id = excluded.cloud_conversation_id,
          owner_generation = COALESCE(
            legacy_chat_cloud_import.owner_generation,
            excluded.owner_generation
          ),
          next_turn_index = excluded.next_turn_index,
          status = excluded.status,
          detail = excluded.detail,
          updated_at = excluded.updated_at
      `,
        )
        .run(
          localConversationId,
          cloudConversationId || null,
          ownerGeneration || null,
          nextTurnIndex,
          args.status,
          detail || null,
          now,
          now,
        );
    }, "immediate");
  }

  listLegacyChatVisibleMessages(
    conversationIdInput: string,
  ): LegacyChatVisibleMessage[] {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const rows = this.db
      .prepare(
        `
      SELECT
        message.id,
        message.type,
        message.created_at AS timestamp,
        part.data_json AS payloadJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE message.session_id = ?
        AND message.type IN ('user_message', 'assistant_message')
      ORDER BY message.created_at ASC, message.id ASC
    `,
      )
      .all(conversationId) as Array<{
      id: string;
      type: "user_message" | "assistant_message";
      timestamp: number;
      payloadJson: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      timestamp: row.timestamp,
      payload: parseJsonRecord(row.payloadJson) ?? {},
    }));
  }

  getCloudAgentThreadControl(
    threadIdInput: string,
    ownerGenerationInput: string,
  ): CloudAgentThreadControlRecord | null {
    const threadId = asTrimmedString(threadIdInput);
    const ownerGeneration = asTrimmedString(ownerGenerationInput);
    if (!threadId || !ownerGeneration) return null;
    const row = this.db
      .prepare(
        `SELECT
           thread_id AS threadId,
           owner_generation AS ownerGeneration,
           cloud_conversation_id AS cloudConversationId,
           origin_conversation_id AS originConversationId,
           attempt_generation AS attemptGeneration,
           thread_updated_at AS threadUpdatedAt,
           status,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM cloud_agent_thread_controls
         WHERE thread_id = ? AND owner_generation = ?
         LIMIT 1`,
      )
      .get(threadId, ownerGeneration) as
      | CloudAgentThreadControlRecord
      | undefined;
    return row ?? null;
  }

  /**
   * Monotonic control receipt merge. Attempt generation is the primary ABA
   * clock. Within one attempt, terminal beats running even when wall clocks
   * are equal/regressed; a delayed running receipt can never resurrect it.
   */
  putCloudAgentThreadControl(record: {
    threadId: string;
    ownerGeneration: string;
    cloudConversationId: string;
    originConversationId: string;
    attemptGeneration: number;
    threadUpdatedAt: number;
    status: CloudAgentControlStatus;
  }): CloudAgentThreadControlRecord {
    const threadId = asTrimmedString(record.threadId);
    const ownerGeneration = asTrimmedString(record.ownerGeneration);
    const cloudConversationId = asTrimmedString(record.cloudConversationId);
    const originConversationId = asTrimmedString(record.originConversationId);
    if (
      !threadId ||
      !ownerGeneration ||
      !cloudConversationId ||
      !originConversationId ||
      !Number.isSafeInteger(record.attemptGeneration) ||
      record.attemptGeneration < 1 ||
      !Number.isSafeInteger(record.threadUpdatedAt) ||
      record.threadUpdatedAt < 0 ||
      !["running", "completed", "failed", "canceled"].includes(record.status)
    ) {
      throw new Error("Invalid cloud agent control receipt.");
    }
    return this.withTransaction(() => {
      const existing = this.getCloudAgentThreadControl(
        threadId,
        ownerGeneration,
      );
      if (
        existing &&
        (existing.cloudConversationId !== cloudConversationId ||
          existing.originConversationId !== originConversationId)
      ) {
        throw new Error(
          "Cloud agent control receipt cannot be rebound to another conversation.",
        );
      }

      let replace = !existing;
      if (existing) {
        if (record.attemptGeneration > existing.attemptGeneration) {
          replace = true;
        } else if (record.attemptGeneration < existing.attemptGeneration) {
          replace = false;
        } else if (record.status === existing.status) {
          replace = record.threadUpdatedAt >= existing.threadUpdatedAt;
        } else if (
          existing.status === "running" &&
          record.status !== "running"
        ) {
          replace = true;
        } else if (
          existing.status !== "running" &&
          record.status === "running"
        ) {
          replace = false;
        } else {
          throw new Error(
            "Cloud agent control receipt has conflicting terminal states.",
          );
        }
      }

      if (replace) {
        const now = Date.now();
        this.db
          .prepare(
            `INSERT INTO cloud_agent_thread_controls (
               thread_id,
               owner_generation,
               cloud_conversation_id,
               origin_conversation_id,
               attempt_generation,
               thread_updated_at,
               status,
               created_at,
               updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(thread_id, owner_generation) DO UPDATE SET
               attempt_generation = excluded.attempt_generation,
               thread_updated_at = excluded.thread_updated_at,
               status = excluded.status,
               updated_at = excluded.updated_at`,
          )
          .run(
            threadId,
            ownerGeneration,
            cloudConversationId,
            originConversationId,
            record.attemptGeneration,
            record.threadUpdatedAt,
            record.status,
            now,
            now,
          );
      }
      const stored = this.getCloudAgentThreadControl(threadId, ownerGeneration);
      if (!stored) throw new Error("Cloud agent control receipt was not stored.");
      return stored;
    }, "immediate");
  }

  getCloudAgentToolOperation(
    operationIdInput: string,
  ): CloudAgentToolOperationRecord | null {
    const operationId = asTrimmedString(operationIdInput);
    if (!operationId) return null;
    const row = this.db
      .prepare(
        `SELECT
           operation_id AS operationId,
           kind,
           fingerprint,
           owner_generation AS ownerGeneration,
           request_json AS requestJson,
           result_json AS resultJson,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM cloud_agent_tool_operations
         WHERE operation_id = ?
         LIMIT 1`,
      )
      .get(operationId) as CloudAgentToolOperationRecord | undefined;
    return row ?? null;
  }

  putCloudAgentToolOperation(record: {
    operationId: string;
    kind: CloudAgentToolOperationRecord["kind"];
    fingerprint: string;
    ownerGeneration: string;
    requestJson: string;
  }): CloudAgentToolOperationRecord {
    const operationId = asTrimmedString(record.operationId);
    const fingerprint = asTrimmedString(record.fingerprint);
    const ownerGeneration = asTrimmedString(record.ownerGeneration);
    if (
      !operationId ||
      !fingerprint ||
      !ownerGeneration ||
      !record.requestJson ||
      !["spawn", "continue", "cancel"].includes(record.kind)
    ) {
      throw new Error("Invalid cloud agent tool operation.");
    }
    return this.withTransaction(() => {
      const now = Date.now();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO cloud_agent_tool_operations (
             operation_id,
             kind,
             fingerprint,
             owner_generation,
             request_json,
             result_json,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          operationId,
          record.kind,
          fingerprint,
          ownerGeneration,
          record.requestJson,
          now,
          now,
        );
      const stored = this.getCloudAgentToolOperation(operationId);
      if (
        !stored ||
        stored.kind !== record.kind ||
        stored.fingerprint !== fingerprint ||
        stored.ownerGeneration !== ownerGeneration
      ) {
        throw new Error(
          "Cloud agent tool-call id was reused with different authority or intent.",
        );
      }
      return stored;
    }, "immediate");
  }

  updatePendingCloudAgentToolOperationRequest(
    operationIdInput: string,
    expectedRequestJson: string,
    replacementRequestJson: string,
  ): CloudAgentToolOperationRecord {
    const operationId = asTrimmedString(operationIdInput);
    if (!operationId || !expectedRequestJson || !replacementRequestJson) {
      throw new Error("Invalid cloud agent operation request replacement.");
    }
    return this.withTransaction(() => {
      const existing = this.getCloudAgentToolOperation(operationId);
      if (!existing) throw new Error("Cloud agent tool operation was not found.");
      if (existing.resultJson !== null) return existing;
      if (existing.requestJson !== expectedRequestJson) {
        throw new Error("Cloud agent operation request changed concurrently.");
      }
      this.db
        .prepare(
          `UPDATE cloud_agent_tool_operations
           SET request_json = ?, updated_at = ?
           WHERE operation_id = ? AND result_json IS NULL`,
        )
        .run(replacementRequestJson, Date.now(), operationId);
      const stored = this.getCloudAgentToolOperation(operationId);
      if (!stored) throw new Error("Cloud agent tool operation was not stored.");
      return stored;
    }, "immediate");
  }

  completeCloudAgentToolOperation(
    operationIdInput: string,
    resultJson: string,
  ): CloudAgentToolOperationRecord {
    const operationId = asTrimmedString(operationIdInput);
    if (!operationId || !resultJson) {
      throw new Error("Invalid cloud agent tool operation result.");
    }
    return this.withTransaction(() => {
      const existing = this.getCloudAgentToolOperation(operationId);
      if (!existing) throw new Error("Cloud agent tool operation was not found.");
      if (existing.resultJson && existing.resultJson !== resultJson) {
        throw new Error("Cloud agent tool operation returned conflicting results.");
      }
      if (existing.resultJson === null) {
        this.db
          .prepare(
            `UPDATE cloud_agent_tool_operations
             SET result_json = ?, updated_at = ?
             WHERE operation_id = ? AND result_json IS NULL`,
          )
          .run(resultJson, Date.now(), operationId);
      }
      const stored = this.getCloudAgentToolOperation(operationId);
      if (!stored) throw new Error("Cloud agent tool operation was not stored.");
      return stored;
    }, "immediate");
  }

  putCloudTranscriptOutbox(record: CloudTranscriptOutboxWrite): void {
    const now = Date.now();
    this.withTransaction(() => {
      const existing = this.db
        .prepare(
          `SELECT id,
                  kind,
                  conversation_id AS conversationId,
                  device_id AS deviceId,
                  owner_generation AS ownerGeneration,
                  local_turn_id AS localTurnId,
                  payload_json AS payloadJson,
                  recovery_json AS recoveryJson,
                  attempts,
                  last_error AS lastError,
                  dead_lettered_at AS deadLetteredAt,
                  created_at AS createdAt,
                  updated_at AS updatedAt
             FROM cloud_transcript_outbox
            WHERE id = ?
            LIMIT 1`,
        )
        .get(record.id) as CloudTranscriptOutboxRow | undefined;
      if (existing) {
        if (!sameCloudTranscriptOutboxWrite(existing, record)) {
          throw new Error(
            "Cloud transcript turn id was reused with different authority or payload.",
          );
        }
        return;
      }
      this.db
        .prepare(
          `
        INSERT INTO cloud_transcript_outbox (
          id,
          kind,
          conversation_id,
          device_id,
          owner_generation,
          local_turn_id,
          payload_json,
          recovery_json,
          attempts,
          last_error,
          dead_lettered_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
      `,
        )
        .run(
          record.id,
          record.kind,
          record.conversationId,
          record.deviceId,
          record.ownerGeneration,
          record.localTurnId,
          record.payloadJson,
          record.recoveryJson,
          now,
          now,
        );
    }, "immediate");
  }

  listCloudTranscriptOutbox(limit = 256): CloudTranscriptOutboxRecord[] {
    const normalizedLimit = Math.max(1, Math.floor(limit));
    return this.db
      .prepare(
        `
      SELECT
        id,
        kind,
        conversation_id AS conversationId,
        device_id AS deviceId,
        owner_generation AS ownerGeneration,
        local_turn_id AS localTurnId,
        payload_json AS payloadJson,
        recovery_json AS recoveryJson,
        attempts,
        last_error AS lastError,
        dead_lettered_at AS deadLetteredAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM cloud_transcript_outbox
      WHERE dead_lettered_at IS NULL
      ORDER BY attempts ASC, updated_at ASC, created_at ASC, id ASC
      LIMIT ?
    `,
      )
      .all(normalizedLimit) as CloudTranscriptOutboxRow[];
  }

  countCloudTranscriptOutbox(): number {
    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM cloud_transcript_outbox
      WHERE dead_lettered_at IS NULL
    `,
      )
      .get() as { count?: unknown } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  }

  markCloudTranscriptOutboxAttempt(id: string): void {
    this.db
      .prepare(
        `
      UPDATE cloud_transcript_outbox
      SET attempts = attempts + 1, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(Date.now(), id);
  }

  deleteCloudTranscriptOutbox(id: string): void {
    this.db.prepare("DELETE FROM cloud_transcript_outbox WHERE id = ?").run(id);
  }

  deadLetterCloudTranscriptOutbox(id: string, reason: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `
      UPDATE cloud_transcript_outbox
      SET
        payload_json = '{}',
        recovery_json = NULL,
        last_error = ?,
        dead_lettered_at = ?,
        updated_at = ?
      WHERE id = ?
    `,
      )
      .run(reason, now, now, id);
  }

  /**
   * Atomically redacts a rejected finish and persists the device-specific
   * notice that explains the missing cloud output. A crash can therefore
   * leave either the retryable finish or the notice, never a silent dead
   * letter with its notification target already erased.
   */
  deadLetterCloudTranscriptOutboxWithFailureNotice(args: {
    id: string;
    reason: string;
    conversationId: string;
    deviceId: string;
    localTurnId: string;
    userMessageId: string;
    message: string;
  }): void {
    const now = Date.now();
    const conversationId = this.sanitizeConversationId(args.conversationId);
    const eventId = `cloud-sync-error:${args.deviceId}:${args.localTurnId}`;
    const payload = {
      text: args.message.slice(0, 500),
      userMessageId: args.userMessageId,
      source: "cloud-sync-error",
    };
    this.withTransaction(() => {
      this.db
        .prepare(
          `
          UPDATE cloud_transcript_outbox
          SET
            payload_json = '{}',
            recovery_json = NULL,
            last_error = ?,
            dead_lettered_at = ?,
            updated_at = ?
          WHERE id = ?
        `,
        )
        .run(args.reason, now, now, args.id);
      this.upsertSession(conversationId, now);
      this.upsertEventMessage({
        sessionId: conversationId,
        eventId,
        type: "assistant_message",
        timestamp: now,
        deviceId: args.deviceId,
        requestId: args.userMessageId,
        payload,
      });
    }, "immediate");
  }

  replaceCloudTranscriptOutbox(
    acknowledgedId: string,
    replacement: CloudTranscriptOutboxWrite,
  ): void {
    const now = Date.now();
    this.withTransaction(() => {
      const selectById = this.db.prepare(
        `SELECT id,
                kind,
                conversation_id AS conversationId,
                device_id AS deviceId,
                owner_generation AS ownerGeneration,
                local_turn_id AS localTurnId,
                payload_json AS payloadJson,
                recovery_json AS recoveryJson,
                attempts,
                last_error AS lastError,
                dead_lettered_at AS deadLetteredAt,
                created_at AS createdAt,
                updated_at AS updatedAt
           FROM cloud_transcript_outbox
          WHERE id = ?
          LIMIT 1`,
      );
      const acknowledged = selectById.get(acknowledgedId) as
        | CloudTranscriptOutboxRow
        | undefined;
      const existingReplacement = selectById.get(replacement.id) as
        | CloudTranscriptOutboxRow
        | undefined;
      if (
        acknowledged &&
        (acknowledged.kind !== "begin" ||
          acknowledged.conversationId !== replacement.conversationId ||
          acknowledged.deviceId !== replacement.deviceId ||
          acknowledged.localTurnId !== replacement.localTurnId ||
          acknowledged.ownerGeneration !== replacement.ownerGeneration)
      ) {
        throw new Error(
          "Cloud transcript finish does not match its admitted begin authority.",
        );
      }
      if (existingReplacement) {
        if (!sameCloudTranscriptOutboxWrite(existingReplacement, replacement)) {
          throw new Error(
            "Cloud transcript finish id was reused with different authority or payload.",
          );
        }
      } else {
        if (!acknowledged) {
          throw new Error(
            "Cloud transcript finish has no matching admitted begin.",
          );
        }
        this.db
          .prepare(
            `
          INSERT INTO cloud_transcript_outbox (
            id,
            kind,
            conversation_id,
            device_id,
            owner_generation,
            local_turn_id,
            payload_json,
            recovery_json,
            attempts,
            last_error,
            dead_lettered_at,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
        `,
          )
          .run(
            replacement.id,
            replacement.kind,
            replacement.conversationId,
            replacement.deviceId,
            replacement.ownerGeneration,
            replacement.localTurnId,
            replacement.payloadJson,
            replacement.recoveryJson,
            now,
            now,
          );
      }
      this.db
        .prepare("DELETE FROM cloud_transcript_outbox WHERE id = ?")
        .run(acknowledgedId);
    }, "immediate");
  }

  putCloudJournalOutbox(record: {
    id: string;
    conversationId: string;
    deviceId: string;
    ownerGeneration: string;
    appendId: string;
    payloadJson: string;
  }): { replayed: boolean } {
    const ownerGeneration = asTrimmedString(record.ownerGeneration);
    if (!ownerGeneration || ownerGeneration.length > 512) {
      throw new Error("Cloud journal owner generation is invalid.");
    }
    return this.withTransaction(() => {
      const admitted = this.db
        .prepare(
          `SELECT payload_json AS payloadJson
             FROM cloud_journal_admission_receipts WHERE id = ?`,
        )
        .get(record.id) as { payloadJson?: unknown } | undefined;
      if (
        typeof admitted?.payloadJson === "string" &&
        admitted.payloadJson !== record.payloadJson
      ) {
        throw new Error("Cloud journal append id was reused with new payload.");
      }
      if (admitted) return { replayed: true };

      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO cloud_journal_admission_receipts (
             id, payload_json, created_at
           ) VALUES (?, ?, ?)`,
        )
        .run(record.id, record.payloadJson, now);
      this.db
        .prepare(
          `INSERT INTO cloud_journal_outbox (
             id, conversation_id, device_id, owner_generation, append_id, payload_json,
             attempts, last_error, dead_lettered_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
        )
        .run(
          record.id,
          record.conversationId,
          record.deviceId,
          ownerGeneration,
          record.appendId,
          record.payloadJson,
          now,
          now,
        );
      // One cheap indexed cleanup per admission keeps this operational dedupe
      // table bounded without coupling it to cloud delivery success.
      this.db
        .prepare(
          `DELETE FROM cloud_journal_admission_receipts
            WHERE created_at < ?`,
        )
        .run(now - 30 * 24 * 60 * 60_000);
      return { replayed: false };
    }, "immediate");
  }

  beginVoiceToolCallReceipt(args: {
    conversationId: string;
    callId: string;
    requestFingerprint: string;
    operationId: string;
    startedAt: number;
  }): VoiceToolCallReceipt {
    const conversationId = this.sanitizeConversationId(args.conversationId);
    const callId = asTrimmedString(args.callId);
    const requestFingerprint = asTrimmedString(args.requestFingerprint);
    const operationId = asTrimmedString(args.operationId);
    if (
      !callId ||
      !requestFingerprint ||
      !operationId ||
      !Number.isSafeInteger(args.startedAt) ||
      args.startedAt < 0
    ) {
      throw new Error("Voice tool receipt identity is invalid.");
    }
    return this.withTransaction(() => {
      const existing = this.db
        .prepare(
          `SELECT request_fingerprint AS requestFingerprint,
                  operation_id AS operationId,
                  started_at AS startedAt,
                  completion_json AS completionJson
             FROM voice_tool_call_receipts
            WHERE conversation_id = ? AND call_id = ?`,
        )
        .get(conversationId, callId) as
        | {
            requestFingerprint?: unknown;
            operationId?: unknown;
            startedAt?: unknown;
            completionJson?: unknown;
          }
        | undefined;
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new Error(
            "Voice tool call id was reused with different arguments.",
          );
        }
        const existingOperationId = asTrimmedString(existing.operationId);
        const existingStartedAt = asFiniteNumber(existing.startedAt);
        if (!existingOperationId || existingStartedAt === null) {
          throw new Error("Voice tool receipt is malformed.");
        }
        return typeof existing.completionJson === "string"
          ? {
              status: "completed" as const,
              operationId: existingOperationId,
              startedAt: existingStartedAt,
              completionJson: existing.completionJson,
            }
          : {
              status: "pending" as const,
              operationId: existingOperationId,
              startedAt: existingStartedAt,
            };
      }
      this.db
        .prepare(
          `INSERT INTO voice_tool_call_receipts (
             conversation_id, call_id, request_fingerprint, operation_id,
             started_at, completion_json, completed_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .run(
          conversationId,
          callId,
          requestFingerprint,
          operationId,
          args.startedAt,
          args.startedAt,
        );
      return {
        status: "started" as const,
        operationId,
        startedAt: args.startedAt,
      };
    }, "immediate");
  }

  completeVoiceToolCallReceipt(args: {
    conversationId: string;
    callId: string;
    requestFingerprint: string;
    completionJson: string;
  }): void {
    const conversationId = this.sanitizeConversationId(args.conversationId);
    const callId = asTrimmedString(args.callId);
    const requestFingerprint = asTrimmedString(args.requestFingerprint);
    if (!callId || !requestFingerprint || !args.completionJson) {
      throw new Error("Voice tool completion is invalid.");
    }
    this.withTransaction(() => {
      const existing = this.db
        .prepare(
          `SELECT request_fingerprint AS requestFingerprint,
                  completion_json AS completionJson
             FROM voice_tool_call_receipts
            WHERE conversation_id = ? AND call_id = ?`,
        )
        .get(conversationId, callId) as
        | { requestFingerprint?: unknown; completionJson?: unknown }
        | undefined;
      if (!existing || existing.requestFingerprint !== requestFingerprint) {
        throw new Error("Voice tool receipt does not own this completion.");
      }
      if (typeof existing.completionJson === "string") {
        if (existing.completionJson !== args.completionJson) {
          throw new Error(
            "Voice tool call was completed with a different result.",
          );
        }
        return;
      }
      const now = Date.now();
      this.db
        .prepare(
          `UPDATE voice_tool_call_receipts
              SET completion_json = ?, completed_at = ?, updated_at = ?
            WHERE conversation_id = ? AND call_id = ?
              AND completion_json IS NULL`,
        )
        .run(args.completionJson, now, now, conversationId, callId);
    }, "immediate");
  }

  listCloudJournalOutbox(limit = 256): CloudJournalOutboxRecord[] {
    return this.db
      .prepare(
        `SELECT
           sequence,
           id,
           conversation_id AS conversationId,
           device_id AS deviceId,
           owner_generation AS ownerGeneration,
           append_id AS appendId,
           payload_json AS payloadJson,
           attempts,
           last_error AS lastError,
           dead_lettered_at AS deadLetteredAt,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM cloud_journal_outbox
         WHERE dead_lettered_at IS NULL
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as CloudJournalOutboxRow[];
  }

  countCloudJournalOutbox(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM cloud_journal_outbox
          WHERE dead_lettered_at IS NULL`,
      )
      .get() as { count?: unknown } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  }

  markCloudJournalOutboxAttempt(id: string, error?: string): void {
    this.db
      .prepare(
        `UPDATE cloud_journal_outbox
            SET attempts = attempts + 1,
                last_error = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(error?.slice(0, 500) ?? null, Date.now(), id);
  }

  deleteCloudJournalOutbox(id: string): void {
    this.db.prepare("DELETE FROM cloud_journal_outbox WHERE id = ?").run(id);
  }

  deadLetterCloudJournalOutbox(id: string, reason: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE cloud_journal_outbox
            SET payload_json = '{}',
                last_error = ?,
                dead_lettered_at = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(reason.slice(0, 500), now, now, id);
  }

  putComputerAgentCloudOutbox(record: {
    id: string;
    kind: ComputerAgentCloudOutboxKind;
    threadId: string;
    attemptGeneration: number;
    ownerScope: string | null;
    ownerGeneration: string | null;
    payloadJson: string;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO computer_agent_cloud_outbox (
           id, kind, thread_id, attempt_generation, owner_scope,
           owner_generation, payload_json,
           attempts, next_attempt_at, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload_json = excluded.payload_json,
           next_attempt_at = MIN(
             computer_agent_cloud_outbox.next_attempt_at,
             excluded.next_attempt_at
           ),
           last_error = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.kind,
        record.threadId,
        record.attemptGeneration,
        record.ownerScope,
        record.ownerGeneration,
        record.payloadJson,
        now,
        now,
        now,
      );
  }

  listComputerAgentCloudOutbox(
    ownerScope: string,
    limit = 256,
  ): ComputerAgentCloudOutboxRecord[] {
    return this.db
      .prepare(
        `SELECT
           sequence,
           id,
           kind,
           thread_id AS threadId,
           attempt_generation AS attemptGeneration,
           owner_scope AS ownerScope,
           owner_generation AS ownerGeneration,
           payload_json AS payloadJson,
           attempts,
           next_attempt_at AS nextAttemptAt,
           last_error AS lastError,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM computer_agent_cloud_outbox
         WHERE owner_scope = ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(
        ownerScope,
        Math.max(1, Math.floor(limit)),
      ) as ComputerAgentCloudOutboxRow[];
  }

  countComputerAgentCloudOutbox(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM computer_agent_cloud_outbox`,
      )
      .get() as { count?: unknown } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  }

  markComputerAgentCloudOutboxRetry(args: {
    id: string;
    error: string;
    nextAttemptAt: number;
  }): void {
    this.db
      .prepare(
        `UPDATE computer_agent_cloud_outbox
            SET attempts = attempts + 1,
                next_attempt_at = ?,
                last_error = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        Math.max(Date.now(), Math.floor(args.nextAttemptAt)),
        args.error.slice(0, 500),
        Date.now(),
        args.id,
      );
  }

  resumeComputerAgentCloudOutbox(ownerScope: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE computer_agent_cloud_outbox
            SET next_attempt_at = MIN(next_attempt_at, ?),
                updated_at = ?
          WHERE owner_scope = ? AND next_attempt_at > ?`,
      )
      .run(now, now, ownerScope, now);
  }

  getComputerAgentCloudThreadOwnerScope(threadId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT owner_scope AS ownerScope
           FROM computer_agent_cloud_thread_owners
          WHERE thread_id = ?
          LIMIT 1`,
      )
      .get(threadId) as { ownerScope?: unknown } | undefined;
    return typeof row?.ownerScope === "string" && row.ownerScope.trim()
      ? row.ownerScope
      : null;
  }

  getComputerAgentCloudThreadAuthority(
    threadId: string,
  ): { ownerScope: string; ownerGeneration: string } | null {
    const row = this.db
      .prepare(
        `SELECT owner_scope AS ownerScope,
                owner_generation AS ownerGeneration
           FROM computer_agent_cloud_thread_owners
          WHERE thread_id = ?
          LIMIT 1`,
      )
      .get(threadId) as
      | { ownerScope?: unknown; ownerGeneration?: unknown }
      | undefined;
    return typeof row?.ownerScope === "string" &&
      row.ownerScope.trim() &&
      typeof row.ownerGeneration === "string" &&
      row.ownerGeneration.trim()
      ? {
          ownerScope: row.ownerScope,
          ownerGeneration: row.ownerGeneration,
        }
      : null;
  }

  hasUnscopedComputerAgentCloudOutbox(threadId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
             FROM computer_agent_cloud_outbox
            WHERE thread_id = ?
              AND (owner_scope IS NULL OR owner_generation IS NULL)
            LIMIT 1`,
        )
        .get(threadId),
    );
  }

  isComputerAgentCloudGenerationRetired(args: {
    threadId: string;
    ownerScope: string;
    ownerGeneration: string;
  }): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
             FROM computer_agent_cloud_retired_generations
            WHERE thread_id = ?
              AND owner_scope = ?
              AND owner_generation = ?
            LIMIT 1`,
        )
        .get(args.threadId, args.ownerScope, args.ownerGeneration),
    );
  }

  bindComputerAgentCloudThreadOwnerScope(
    threadId: string,
    ownerScope: string,
  ): string {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO computer_agent_cloud_thread_owners (
           thread_id, owner_scope, created_at, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO NOTHING`,
      )
      .run(threadId, ownerScope, now, now);
    return this.getComputerAgentCloudThreadOwnerScope(threadId) ?? ownerScope;
  }

  bindComputerAgentCloudThreadAuthority(
    threadId: string,
    ownerScope: string,
    ownerGeneration: string,
  ): { ownerScope: string; ownerGeneration: string } | null {
    const now = Date.now();
    return this.db.transaction(() => {
      if (
        this.isComputerAgentCloudGenerationRetired({
          threadId,
          ownerScope,
          ownerGeneration,
        })
      ) {
        return null;
      }
      const existing = this.db
        .prepare(
          `SELECT owner_scope AS ownerScope,
                  owner_generation AS ownerGeneration
             FROM computer_agent_cloud_thread_owners
            WHERE thread_id = ?`,
        )
        .get(threadId) as
        | { ownerScope?: unknown; ownerGeneration?: unknown }
        | undefined;
      if (
        existing &&
        (existing.ownerScope !== ownerScope ||
          typeof existing.ownerGeneration !== "string")
      ) {
        return null;
      }
      if (existing && existing.ownerGeneration !== ownerGeneration) {
        // A newly admitted epoch tombstones queued work from the prior epoch
        // before rebinding the mutable thread id. Persist the tombstone first
        // so a late retry cannot reverse the transition back to the old epoch.
        this.db
          .prepare(
            `INSERT OR IGNORE INTO computer_agent_cloud_retired_generations (
               thread_id, owner_scope, owner_generation, retired_at
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(threadId, ownerScope, existing.ownerGeneration, now);
        this.db
          .prepare(
            `DELETE FROM computer_agent_cloud_outbox
              WHERE thread_id = ?
                AND owner_scope = ?
                AND owner_generation = ?`,
          )
          .run(threadId, ownerScope, existing.ownerGeneration);
      }
      this.db
        .prepare(
          `INSERT INTO computer_agent_cloud_thread_owners (
             thread_id, owner_scope, owner_generation, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             owner_generation = excluded.owner_generation,
             updated_at = excluded.updated_at
           WHERE computer_agent_cloud_thread_owners.owner_scope = excluded.owner_scope`,
        )
        .run(threadId, ownerScope, ownerGeneration, now, now);
      return this.getComputerAgentCloudThreadAuthority(threadId);
    })();
  }

  retireComputerAgentCloudGeneration(args: {
    threadId: string;
    ownerScope: string;
    ownerGeneration: string;
  }): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO computer_agent_cloud_retired_generations (
             thread_id, owner_scope, owner_generation, retired_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(args.threadId, args.ownerScope, args.ownerGeneration, Date.now());
      this.db
        .prepare(
          `DELETE FROM computer_agent_cloud_outbox
            WHERE thread_id = ?
              AND owner_scope = ?
              AND owner_generation = ?`,
        )
        .run(args.threadId, args.ownerScope, args.ownerGeneration);
      this.db
        .prepare(
          `DELETE FROM computer_agent_cloud_thread_owners
            WHERE thread_id = ?
              AND owner_scope = ?
              AND owner_generation = ?`,
        )
        .run(args.threadId, args.ownerScope, args.ownerGeneration);
    })();
  }

  deleteComputerAgentCloudOutbox(id: string): void {
    this.db
      .prepare("DELETE FROM computer_agent_cloud_outbox WHERE id = ?")
      .run(id);
  }

  private sanitizeConversationId(value: unknown): string {
    const conversationId = asTrimmedString(value);
    if (!conversationId) {
      throw new Error("conversationId is required.");
    }
    return conversationId;
  }
  upsertSession(sessionId, updatedAt) {
    this.db
      .prepare(
        `
      INSERT INTO session (
        id,
        title,
        status,
        created_at,
        updated_at
      )
      VALUES (?, '', 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = CASE
          WHEN excluded.updated_at > updated_at THEN excluded.updated_at
          ELSE updated_at
        END
    `,
      )
      .run(sessionId, updatedAt, updatedAt);
  }
  getSession(sessionId) {
    const row = this.db
      .prepare(
        `
      SELECT
        id,
        sync_checkpoint_message_id AS syncCheckpointMessageId
      FROM session
      WHERE id = ?
      LIMIT 1
    `,
      )
      .get(sessionId);
    return row ?? null;
  }
  deriveImplicitThreadMetadata(threadKey) {
    const subagentMarker = "::subagent::";
    const subagentIndex = threadKey.indexOf(subagentMarker);
    if (subagentIndex > 0) {
      const conversationId = threadKey.slice(0, subagentIndex).trim();
      const remainder = threadKey.slice(subagentIndex + subagentMarker.length);
      const nextDelimiter = remainder.indexOf("::");
      const agentType =
        nextDelimiter > 0
          ? remainder.slice(0, nextDelimiter).trim()
          : "subagent";
      if (conversationId) {
        return {
          conversationId,
          agentType: agentType || "subagent",
        };
      }
    }
    return {
      conversationId: threadKey,
      agentType: "orchestrator",
    };
  }
  ensureImplicitThreadRow(threadKey) {
    const derived = this.deriveImplicitThreadMetadata(threadKey);
    const now = Date.now();
    this.upsertSession(derived.conversationId, now);
    this.db
      .prepare(
        `
      INSERT INTO runtime_threads (
        thread_key,
        conversation_id,
        agent_type,
        name,
        status,
        created_at,
        last_used_at,
        summary
      )
      VALUES (?, ?, ?, ?, 'evicted', ?, ?, NULL)
      ON CONFLICT(thread_key) DO NOTHING
    `,
      )
      .run(
        threadKey,
        derived.conversationId,
        derived.agentType,
        threadKey,
        now,
        now,
      );
    return derived;
  }
  replaceMessageParts(messageId, sessionId, parts) {
    this.db
      .prepare(
        `
      DELETE FROM part
      WHERE message_id = ?
    `,
      )
      .run(messageId);
    const stmt = this.db.prepare(`
      INSERT INTO part (
        id,
        session_id,
        message_id,
        ord,
        type,
        tool_call_id,
        data_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    parts.forEach((part, index) => {
      stmt.run(
        `${messageId}:part:${index}`,
        sessionId,
        messageId,
        index,
        part.type,
        part.toolCallId ?? null,
        toJsonValueString(part.data),
        part.createdAt,
      );
    });
  }
  upsertEventMessage(args) {
    this.db
      .prepare(
        `
      INSERT INTO message (
        id,
        session_id,
        thread_key,
        run_id,
        role,
        type,
        request_id,
        device_id,
        target_device_id,
        agent_type,
        data_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        role = excluded.role,
        type = excluded.type,
        request_id = excluded.request_id,
        device_id = excluded.device_id,
        target_device_id = excluded.target_device_id,
        data_json = excluded.data_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        args.eventId,
        args.sessionId,
        eventRoleForType(args.type),
        args.type,
        args.requestId ?? null,
        args.deviceId ?? null,
        args.targetDeviceId ?? null,
        toJsonString(
          args.channelEnvelope
            ? { channelEnvelope: args.channelEnvelope }
            : undefined,
        ),
        args.timestamp,
        args.timestamp,
      );
    this.replaceMessageParts(
      args.eventId,
      args.sessionId,
      args.payload
        ? [
            {
              type: "payload",
              data: args.payload,
              createdAt: args.timestamp,
            },
          ]
        : [],
    );
  }
  deserializeEventRow(row) {
    const meta = parseJsonRecord(row.channelEnvelopeJson);
    return {
      _id: row._id,
      timestamp: row.timestamp,
      ...(typeof row.sequence === "number" ? { sequence: row.sequence } : {}),
      type: row.type,
      ...(row.deviceId ? { deviceId: row.deviceId } : {}),
      ...(row.requestId ? { requestId: row.requestId } : {}),
      ...(row.targetDeviceId ? { targetDeviceId: row.targetDeviceId } : {}),
      ...(parseJsonRecord(row.payloadJson)
        ? { payload: parseJsonRecord(row.payloadJson) }
        : {}),
      ...(asObject(meta?.channelEnvelope)
        ? { channelEnvelope: asObject(meta?.channelEnvelope) }
        : {}),
    };
  }
  appendEvent(args) {
    const conversationId = this.sanitizeConversationId(args.conversationId);
    const type = asTrimmedString(args.type);
    if (!type) {
      throw new Error("type is required.");
    }
    const timestamp = asFiniteNumber(args.timestamp) ?? Date.now();
    const eventId =
      asTrimmedString(args.eventId) || `local-${generateLocalId()}`;
    const payload = asObject(args.payload) ?? undefined;
    const channelEnvelope = asObject(args.channelEnvelope) ?? undefined;
    const deviceId = asTrimmedString(args.deviceId) || undefined;
    const requestId = asTrimmedString(args.requestId) || undefined;
    const targetDeviceId = asTrimmedString(args.targetDeviceId) || undefined;
    this.withTransaction(() => {
      this.upsertSession(conversationId, timestamp);
      this.upsertEventMessage({
        sessionId: conversationId,
        eventId,
        type,
        timestamp,
        deviceId,
        requestId,
        targetDeviceId,
        payload,
        channelEnvelope,
      });
    });
    const sequenceRow = this.orderingBySequence
      ? this.db
          .prepare(
            `SELECT ordering_sequence AS sequence FROM message WHERE id = ? LIMIT 1`,
          )
          .get(eventId)
      : null;
    return {
      _id: eventId,
      timestamp,
      ...(typeof sequenceRow?.sequence === "number"
        ? { sequence: sequenceRow.sequence }
        : {}),
      type,
      ...(deviceId ? { deviceId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(targetDeviceId ? { targetDeviceId } : {}),
      ...(payload ? { payload } : {}),
      ...(channelEnvelope ? { channelEnvelope } : {}),
    };
  }
  hasEvent(conversationIdInput, eventIdInput, typeInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const eventId = asTrimmedString(eventIdInput);
    if (!eventId) return false;
    const type = asTrimmedString(typeInput);
    const row = this.db
      .prepare(
        type
          ? `SELECT 1 AS present FROM message
             WHERE session_id = ? AND id = ? AND type = ? LIMIT 1`
          : `SELECT 1 AS present FROM message
             WHERE session_id = ? AND id = ? LIMIT 1`,
      )
      .get(
        ...(type ? [conversationId, eventId, type] : [conversationId, eventId]),
      );
    return Boolean(row);
  }
  hasEventId(eventIdInput, typeInput) {
    const eventId = asTrimmedString(eventIdInput);
    if (!eventId) return false;
    const type = asTrimmedString(typeInput);
    const statement = this.db.prepare(
      type
        ? `SELECT 1 AS present FROM message WHERE id = ? AND type = ? LIMIT 1`
        : `SELECT 1 AS present FROM message WHERE id = ? LIMIT 1`,
    );
    return Boolean(
      type ? statement.get(eventId, type) : statement.get(eventId),
    );
  }
  /**
   * Shallow-merge a partial payload into an existing local-chat event's
   * stored payload. Returns the updated record (so callers can fire
   * `notifyLocalChatUpdated`), or null when the event/payload row is
   * missing. Used by the worker to attach post-run fields after the run finalizes.
   *
   * Atomicity: the SELECT, merge, and write all run inside a single
   * `withTransaction` block so a concurrent writer to the same eventId
   * can't slip a write between the read and the merge.
   *
   * Caveat: the write replaces every `part` row for the message via
   * `replaceMessageParts`, then re-inserts a single merged payload at
   * `ord: 0`. Today every chat event only stores its payload at ord 0,
   * but a future feature adding multi-part chat events would have its
   * non-ord:0 parts wiped by a subsequent `mergeEventPayload` call.
   * If that becomes a concern, switch to a part-level merge instead of
   * full replacement. The transaction below logs a tripwire warning
   * when it observes more than one existing part row for the target
   * message so we notice the moment a multi-part event type lands.
   */
  mergeEventPayload(args) {
    const conversationId = this.sanitizeConversationId(args.conversationId);
    const eventId = asTrimmedString(args.eventId);
    if (!eventId) {
      return null;
    }
    let updatedRecord = null;
    this.withTransaction(() => {
      const existingRow = this.db
        .prepare(
          `
          SELECT
            message.id AS _id,
            message.created_at AS timestamp${this.orderingSequenceSelect("message")},
            message.type AS type,
            message.device_id AS deviceId,
            message.request_id AS requestId,
            message.target_device_id AS targetDeviceId,
            part.data_json AS payloadJson,
            message.data_json AS channelEnvelopeJson
          FROM message
          LEFT JOIN part
            ON part.message_id = message.id
           AND part.ord = 0
          WHERE message.id = ?
            AND message.session_id = ?
        `,
        )
        .get(eventId, conversationId);
      if (!existingRow) {
        return;
      }
      // Tripwire: see JSDoc caveat. `replaceMessageParts` below is
      // destructive across all ords for this message id; if we ever
      // see >1 part row pre-merge it means a multi-part event type
      // has landed and this method silently dropped sibling parts.
      const existingPartCount =
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM part WHERE message_id = ?`)
          .get(eventId)?.n ?? 0;
      if (existingPartCount > 1) {
        console.warn(
          `[session-store] mergeEventPayload destructively replaced ${existingPartCount} parts for event ${eventId} (conversation ${conversationId}); only ord:0 will survive. A multi-part event type now exists — switch this method to a part-level merge.`,
        );
      }
      const existingPayload = parseJsonRecord(existingRow.payloadJson) ?? {};
      const mergedPayload = {
        ...existingPayload,
        ...args.patch,
      };
      const now = Date.now();
      this.db
        .prepare(
          `UPDATE message SET updated_at = ? WHERE id = ? AND session_id = ?`,
        )
        .run(now, eventId, conversationId);
      this.replaceMessageParts(eventId, conversationId, [
        {
          type: "payload",
          data: mergedPayload,
          createdAt: existingRow.timestamp,
        },
      ]);
      updatedRecord = {
        ...this.deserializeEventRow(existingRow),
        payload: mergedPayload,
      };
    });
    return updatedRecord;
  }
  getOrCreateDefaultConversationId() {
    const existing = this.getSetting(DEFAULT_CONVERSATION_SETTING_KEY);
    if (existing) {
      this.upsertSession(existing, Date.now());
      return existing;
    }
    const created = generateLocalId();
    const createdAt = Date.now();
    this.withTransaction(() => {
      this.upsertSession(created, createdAt);
      this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, created);
    });
    return created;
  }
  createNewDefaultConversationId() {
    let resolvedConversationId = "";
    this.withImmediateTransaction(() => {
      const activeConversationId = this.getSetting(
        DEFAULT_CONVERSATION_SETTING_KEY,
      );
      // "Empty" follows the durable UI-visibility contract: every
      // displayable user/assistant row occupies a chat, including an
      // attachment/context-only or malformed row with no title text.
      // Hidden workspace triggers and system/tool-only rows do not. A
      // conversation that has owned an agent is also excluded so a
      // task-only thread is never repurposed as a blank user chat.
      const reusable = this.db
        .prepare(
          `
          SELECT candidate.id
          FROM session AS candidate
          WHERE candidate.status = 'active'
            AND length(candidate.id) = 26
            AND candidate.id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
            AND NOT EXISTS (
              SELECT 1
              FROM runtime_agents AS agent
              WHERE agent.conversation_id = candidate.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM message AS visible_message
              INNER JOIN part AS visible_part
                ON visible_part.message_id = visible_message.id
               AND visible_part.ord = 0
              WHERE visible_message.session_id = candidate.id
                AND visible_message.type IN ('user_message', 'assistant_message')
                AND (
                  NOT json_valid(visible_part.data_json)
                  OR (
                    coalesce(json_extract(visible_part.data_json, '$.metadata.ui.visibility'), '') <> 'hidden'
                    AND coalesce(json_extract(visible_part.data_json, '$.metadata.trigger.kind'), '') <> 'workspace_creation_request'
                  )
                )
            )
          ORDER BY
            CASE WHEN candidate.id = ? THEN 0 ELSE 1 END,
            candidate.updated_at DESC,
            candidate.id DESC
          LIMIT 1
        `,
        )
        .get(activeConversationId ?? "");
      if (typeof reusable?.id === "string" && reusable.id) {
        resolvedConversationId = reusable.id;
        // Repeated New Chat on the active empty chat is a true no-op.
        if (reusable.id !== activeConversationId) {
          this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, reusable.id);
        }
        return;
      }
      const created = generateLocalId();
      const createdAt = Date.now();
      this.upsertSession(created, createdAt);
      this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, created);
      resolvedConversationId = created;
    });
    return resolvedConversationId;
  }
  /**
   * Point the durable "active conversation" pointer at `conversationId`.
   * This is the single durable source of truth the desktop restores from on
   * boot (renderer hard-reload and full restart alike); the renderer writes
   * it whenever the active conversation changes. Unlike
   * `createNewDefaultConversationId`, this never mints a new id — it records
   * the conversation the user is actually viewing.
   */
  setActiveDefaultConversationId(conversationIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const now = Date.now();
    this.withTransaction(() => {
      this.upsertSession(conversationId, now);
      this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, conversationId);
    });
  }
  /** Permanently remove one local conversation and its conversation-owned data. */
  deleteConversation(conversationIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const exists = this.db
      .prepare(`SELECT 1 FROM session WHERE id = ? LIMIT 1`)
      .get(conversationId);
    if (!exists) return false;
    const runningAgent = this.db
      .prepare(
        `SELECT 1
         FROM runtime_agents
         WHERE conversation_id = ? AND status = 'running'
         LIMIT 1`,
      )
      .get(conversationId);
    if (runningAgent) {
      throw new Error("A conversation with running tasks cannot be deleted.");
    }
    this.withTransaction(() => {
      this.db
        .prepare(
          `DELETE FROM agent_progress_summaries
                 WHERE agent_id IN (
                   SELECT thread_id FROM runtime_agents WHERE conversation_id = ?
                 )`,
        )
        .run(conversationId);
      this.db
        .prepare(`DELETE FROM runtime_agents WHERE conversation_id = ?`)
        .run(conversationId);
      this.db
        .prepare(`DELETE FROM runtime_threads WHERE conversation_id = ?`)
        .run(conversationId);
      this.db
        .prepare(
          `DELETE FROM runtime_conversation_state WHERE conversation_id = ?`,
        )
        .run(conversationId);
      this.db
        .prepare(`DELETE FROM settings WHERE key = ? AND value = ?`)
        .run(DEFAULT_CONVERSATION_SETTING_KEY, conversationId);
      this.db.prepare(`DELETE FROM session WHERE id = ?`).run(conversationId);
    });
    return true;
  }
  /**
   * Ordering cursor `(created_at, id)` for one event within a conversation.
   * Returns null when the event id is absent from the conversation.
   */
  getEventCursor(conversationIdInput, eventIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const eventId = asTrimmedString(eventIdInput);
    if (!eventId) return null;
    const row = this.db
      .prepare(
        `SELECT id AS _id, created_at AS timestamp${this.orderingSequenceSelect("")}
           FROM message
          WHERE session_id = ? AND id = ?
          LIMIT 1`,
      )
      .get(conversationId, eventId);
    if (!row) return null;
    return {
      id: row._id,
      timestamp: row.timestamp,
      ...(typeof row.sequence === "number" ? { sequence: row.sequence } : {}),
    };
  }
  /**
   * Mint a fresh, empty conversation id WITHOUT touching the durable
   * "active conversation" pointer or reusing an existing empty chat. Used
   * by the desktop Fork action, which needs a brand-new destination that
   * leaves the user's current chat (and the active pointer) untouched.
   */
  createConversation() {
    const created = generateLocalId();
    const createdAt = Date.now();
    this.withTransaction(() => {
      this.upsertSession(created, createdAt);
    });
    return created;
  }
  /**
   * Truncate a conversation at a message: permanently remove the event
   * identified by `eventId` AND every event at-or-after it in
   * `(created_at, id)` order. Backs the desktop "Rewind here" action.
   *
   * Deleting `message` rows cascades to their `part` rows
   * (FOREIGN KEY ... ON DELETE CASCADE) and refreshes the FTS mirror via
   * triggers. Best-effort: any background agents this conversation spawned
   * within the removed range (non-running only) are pruned too, so the
   * Activity surface doesn't keep dangling task cards for turns that no
   * longer exist. A running agent is left alone — the renderer stops the
   * active stream before rewinding.
   */
  truncateConversationAtEvent(conversationIdInput, eventIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const cursor = this.getEventCursor(conversationId, eventIdInput);
    if (!cursor) return { removed: 0 };
    let removed = 0;
    this.withImmediateTransaction(() => {
      // "At or after" the target event, in the ACTIVE ordering key — so Rewind
      // removes exactly the suffix the user sees, whether ordering by the
      // sequence (flip) or the legacy (created_at, id) tuple.
      const keyset = this.timelineKeyset("", ">=", cursor);
      const cutoffCondition = `session_id = ? AND ${keyset.clause}`;
      // The DELETE's own `changes` count is the number of removed rows —
      // no separate COUNT(*) pass over the same index range. (SQLite's
      // changes() counts only the directly-deleted `message` rows, not the
      // cascaded `part` rows, which is exactly the total we want.)
      const deleteResult = this.db
        .prepare(`DELETE FROM message WHERE ${cutoffCondition}`)
        .run(conversationId, ...keyset.params);
      removed = deleteResult?.changes ?? 0;
      const orphanThreadRows = this.db
        .prepare(
          `SELECT thread_id FROM runtime_agents
             WHERE conversation_id = ?
               AND status <> 'running'
               AND prompt_created_at IS NOT NULL
               AND prompt_created_at >= ?`,
        )
        .all(conversationId, cursor.timestamp);
      const orphanThreadIds = orphanThreadRows
        .map((row) => (typeof row.thread_id === "string" ? row.thread_id : ""))
        .filter((id) => id.length > 0);
      for (const threadId of orphanThreadIds) {
        this.db
          .prepare(`DELETE FROM agent_progress_summaries WHERE agent_id = ?`)
          .run(threadId);
        this.db
          .prepare(`DELETE FROM runtime_threads WHERE thread_key = ?`)
          .run(threadId);
        this.db
          .prepare(`DELETE FROM runtime_agents WHERE thread_id = ?`)
          .run(threadId);
      }
    });
    return { removed };
  }
  /**
   * Fork a conversation: copy every user/assistant message BEFORE
   * `eventId` (exclusive) into a brand-new conversation, preserving order
   * and timestamps, and return the new conversation id. Backs the desktop
   * "Fork to new chat" action; the source conversation is left untouched.
   *
   * Only `user_message` / `assistant_message` rows are copied — tool and
   * agent-lifecycle events are intentionally dropped so the branch carries
   * a clean transcript with no dangling agent/task references. Event ids
   * are re-minted (they are a globally-unique primary key) and each
   * assistant row's `userMessageId` back-reference is remapped onto the
   * copied user id so streaming/overlay correlation stays sound if the
   * fork is continued.
   */
  forkConversationBeforeEvent(conversationIdInput, eventIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const cursor = this.getEventCursor(conversationId, eventIdInput);
    if (!cursor) return null;
    // Copy every user/assistant message strictly BEFORE the target event, in
    // the ACTIVE ordering key.
    const forkKeyset = this.timelineKeyset("source", "<", cursor);
    const rows = this.db
      .prepare(
        `SELECT
           source.id AS _id,
           source.created_at AS timestamp,
           source.type AS type,
           source.device_id AS deviceId,
           source.request_id AS requestId,
           source.target_device_id AS targetDeviceId,
           part.data_json AS payloadJson,
           source.data_json AS channelEnvelopeJson
         FROM message AS source
         LEFT JOIN part
           ON part.message_id = source.id AND part.ord = 0
         WHERE source.session_id = ?
           AND source.type IN ('user_message', 'assistant_message')
           AND ${forkKeyset.clause}
         ORDER BY ${this.timelineOrderBy("source", "ASC")}`,
      )
      .all(conversationId, ...forkKeyset.params);
    const newConversationId = generateLocalId();
    const createdAt = Date.now();
    const idMap = new Map();
    this.withImmediateTransaction(() => {
      this.upsertSession(newConversationId, createdAt);
      for (const row of rows) {
        idMap.set(row._id, `local-${generateLocalId()}`);
      }
      for (const row of rows) {
        const newId = idMap.get(row._id);
        const meta = parseJsonRecord(row.channelEnvelopeJson);
        const channelEnvelope = asObject(meta?.channelEnvelope) ?? undefined;
        let payload = parseJsonRecord(row.payloadJson) ?? undefined;
        if (payload && row.type === "assistant_message") {
          const remappedUserId =
            typeof payload.userMessageId === "string"
              ? idMap.get(payload.userMessageId)
              : undefined;
          if (remappedUserId) {
            payload = { ...payload, userMessageId: remappedUserId };
          }
        }
        this.upsertEventMessage({
          sessionId: newConversationId,
          eventId: newId,
          type: row.type,
          timestamp: row.timestamp,
          deviceId: asTrimmedString(row.deviceId) || undefined,
          requestId: asTrimmedString(row.requestId) || undefined,
          targetDeviceId: asTrimmedString(row.targetDeviceId) || undefined,
          payload,
          channelEnvelope,
        });
      }
    });
    return { conversationId: newConversationId };
  }
  /** Cursor-paginated conversation history for the renderer's top bar. */
  listConversationSummaries(args = {}) {
    const requestedLimit = asFiniteNumber(args.limit);
    const limit = Math.min(100, Math.max(1, Math.floor(requestedLimit ?? 50)));
    const cursorUpdatedAt = asFiniteNumber(args.cursor?.updatedAt);
    const cursorConversationId = asTrimmedString(args.cursor?.conversationId);
    const hasCursor = cursorUpdatedAt !== null && Boolean(cursorConversationId);
    const rows = this.db
      .prepare(
        `
      WITH page AS (
        SELECT id, created_at, updated_at
        FROM session
        WHERE status = 'active'
          AND length(id) = 26
          AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
          ${
            hasCursor
              ? "AND (updated_at < ? OR (updated_at = ? AND id < ?))"
              : ""
          }
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      )
      SELECT
        page.id AS conversationId,
        page.created_at AS createdAt,
        page.updated_at AS updatedAt,
        latest.id AS latestMessageId,
        latest.created_at AS latestMessageAt,
        latest_part.data_json AS payloadJson
      FROM page
      LEFT JOIN message AS latest
        ON latest.id = (
          SELECT candidate.id
          FROM message AS candidate
          INNER JOIN part AS candidate_part
            ON candidate_part.message_id = candidate.id
           AND candidate_part.ord = 0
          WHERE candidate.session_id = page.id
            AND candidate.type IN ('user_message', 'assistant_message')
            AND CASE
              WHEN json_valid(candidate_part.data_json) THEN
                typeof(json_extract(candidate_part.data_json, '$.text')) = 'text'
                AND trim(json_extract(candidate_part.data_json, '$.text')) <> ''
                AND coalesce(json_extract(candidate_part.data_json, '$.metadata.ui.visibility'), '') <> 'hidden'
                AND coalesce(json_extract(candidate_part.data_json, '$.metadata.trigger.kind'), '') <> 'workspace_creation_request'
              ELSE 0
            END
          ORDER BY candidate.created_at DESC, candidate.id DESC
          LIMIT 1
        )
      LEFT JOIN part AS latest_part
        ON latest_part.message_id = latest.id
       AND latest_part.ord = 0
      ORDER BY page.updated_at DESC, page.id DESC
      `,
      )
      .all(
        ...(hasCursor
          ? [cursorUpdatedAt, cursorUpdatedAt, cursorConversationId, limit + 1]
          : [limit + 1]),
      );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const conversations = pageRows.map((row) => {
      const payload = parseJsonRecord(row.payloadJson);
      const rawText =
        !isUiHiddenChatMessagePayload(payload ?? null) &&
        typeof payload?.text === "string"
          ? payload.text
          : "";
      const title = rawText.replace(/\s+/g, " ").trim().slice(0, 240);
      return {
        conversationId: row.conversationId,
        title: title || "New chat",
        ...(row.latestMessageId
          ? { latestMessageId: row.latestMessageId }
          : {}),
        ...(typeof row.latestMessageAt === "number"
          ? { latestMessageAt: row.latestMessageAt }
          : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
    const last = conversations.at(-1);
    return {
      conversations,
      hasMore,
      ...(hasMore && last
        ? {
            nextCursor: {
              updatedAt: last.updatedAt,
              conversationId: last.conversationId,
            },
          }
        : {}),
    };
  }
  listEvents(conversationIdInput, maxItems = 200) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const normalizedLimit = Math.max(1, Math.floor(maxItems));
    const rows = this.db
      .prepare(
        `
      SELECT
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        recent.request_id AS requestId,
        recent.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        recent.data_json AS channelEnvelopeJson
      FROM (
        SELECT *
        FROM message
        WHERE session_id = ?
          AND type NOT IN ('thread_message', 'run_event', 'memory')
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `,
      )
      .all(conversationId, normalizedLimit);
    return rows.map((row) => this.deserializeEventRow(row));
  }
  /**
   * Provider-call ledger projected from the durable assistant messages in
   * runtime_thread_entries. This intentionally reads the canonical thread
   * history instead of maintaining a second write path that could drift or
   * double-count retries. Historical native calls become visible as soon as
   * this reader ships; synthetic `model: history` replay rows are excluded.
   */
  listModelUsage(args = {}) {
    const fromMs = asFiniteNumber(args.fromMs);
    const toMs = asFiniteNumber(args.toMs);
    const conversationId = asTrimmedString(args.conversationId);
    const threadId =
      typeof args.threadId === "string" && args.threadId.trim()
        ? normalizeRuntimeThreadId(args.threadId)
        : undefined;
    const normalizedLimit = Math.min(
      10000,
      Math.max(1, Math.floor(asFiniteNumber(args.limit) ?? 5000)),
    );
    // The first three clauses must stay textually in sync with the WHERE
    // of idx_runtime_thread_entries_usage (database-init.ts) so SQLite's
    // partial-index prover keeps this off the full-table-scan path.
    const clauses = [
      "entry.entry_type = 'message'",
      "json_extract(entry.data_json, '$.message.role') = 'assistant'",
      "json_type(entry.data_json, '$.message.usage') = 'object'",
      "COALESCE(json_extract(entry.data_json, '$.message.model'), '') != 'history'",
    ];
    const params = [];
    if (fromMs !== null) {
      clauses.push("entry.created_at >= ?");
      params.push(Math.floor(fromMs));
    }
    if (toMs !== null) {
      clauses.push("entry.created_at <= ?");
      params.push(Math.floor(toMs));
    }
    if (conversationId) {
      clauses.push("thread.conversation_id = ?");
      params.push(conversationId);
    }
    if (threadId) {
      clauses.push("thread.thread_key = ?");
      params.push(threadId);
    }
    params.push(normalizedLimit + 1);
    const rows = this.db
      .prepare(
        `
      SELECT
        entry.entry_id AS id,
        entry.created_at AS timestamp,
        thread.conversation_id AS conversationId,
        COALESCE(NULLIF(session.title, ''), thread.conversation_id) AS conversationTitle,
        thread.thread_key AS threadId,
        thread.name AS threadName,
        thread.agent_type AS agentType,
        agent.description AS agentDescription,
        agent.agent_depth AS agentDepth,
        agent.parent_agent_id AS parentAgentId,
        agent.root_run_id AS rootRunId,
        json_extract(entry.data_json, '$.message.provider') AS provider,
        json_extract(entry.data_json, '$.message.api') AS api,
        json_extract(entry.data_json, '$.message.model') AS model,
        json_extract(entry.data_json, '$.message.responseModel') AS responseModel,
        json_extract(entry.data_json, '$.message.usage.input') AS inputTokens,
        json_extract(entry.data_json, '$.message.usage.cacheRead') AS cacheReadTokens,
        json_extract(entry.data_json, '$.message.usage.cacheWrite') AS cacheWriteTokens,
        json_extract(entry.data_json, '$.message.usage.output') AS outputTokens,
        json_extract(entry.data_json, '$.message.usage.reasoning') AS reasoningTokens,
        json_extract(entry.data_json, '$.message.usage.totalTokens') AS totalTokens,
        json_extract(entry.data_json, '$.message.usage.cost.input') AS inputCostUsd,
        json_extract(entry.data_json, '$.message.usage.cost.cacheRead') AS cacheReadCostUsd,
        json_extract(entry.data_json, '$.message.usage.cost.cacheWrite') AS cacheWriteCostUsd,
        json_extract(entry.data_json, '$.message.usage.cost.output') AS outputCostUsd,
        json_extract(entry.data_json, '$.message.usage.cost.total') AS totalCostUsd,
        json_extract(entry.data_json, '$.message.stopReason') AS stopReason,
        json_extract(entry.data_json, '$.message.errorMessage') AS errorMessage
      FROM runtime_thread_entries entry
      JOIN runtime_threads thread ON thread.thread_key = entry.thread_key
      LEFT JOIN runtime_agents agent ON agent.thread_id = thread.thread_key
      LEFT JOIN session ON session.id = thread.conversation_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY entry.created_at DESC, entry.entry_id DESC
      LIMIT ?
    `,
      )
      .all(...params);
    const truncated = rows.length > normalizedLimit;
    return {
      records: rows.slice(0, normalizedLimit).map((row) => {
        const rowConversationId = asTrimmedString(row.conversationId);
        const agentType = asTrimmedString(row.agentType);
        const agentDescription = asTrimmedString(row.agentDescription);
        const agentDepth = asFiniteNumber(row.agentDepth);
        const parentAgentId = asTrimmedString(row.parentAgentId);
        const rootRunId = asTrimmedString(row.rootRunId);
        const responseModel = asTrimmedString(row.responseModel);
        const errorMessage = asTrimmedString(row.errorMessage);
        return {
          id: asTrimmedString(row.id),
          timestamp: asFiniteNumber(row.timestamp) ?? 0,
          conversationId: rowConversationId,
          conversationTitle:
            asTrimmedString(row.conversationTitle) || rowConversationId,
          threadId: asTrimmedString(row.threadId),
          threadName: asTrimmedString(row.threadName) || agentType,
          agentType: agentType || "unknown",
          ...(agentDescription ? { agentDescription } : {}),
          ...(agentDepth !== null ? { agentDepth } : {}),
          ...(parentAgentId ? { parentAgentId } : {}),
          ...(rootRunId ? { rootRunId } : {}),
          provider: asTrimmedString(row.provider) || "unknown",
          api: asTrimmedString(row.api) || "unknown",
          model: asTrimmedString(row.model) || "unknown",
          ...(responseModel ? { responseModel } : {}),
          inputTokens: asFiniteNumber(row.inputTokens) ?? 0,
          cacheReadTokens: asFiniteNumber(row.cacheReadTokens) ?? 0,
          cacheWriteTokens: asFiniteNumber(row.cacheWriteTokens) ?? 0,
          outputTokens: asFiniteNumber(row.outputTokens) ?? 0,
          reasoningTokens: asFiniteNumber(row.reasoningTokens) ?? 0,
          totalTokens: asFiniteNumber(row.totalTokens) ?? 0,
          inputCostUsd: asFiniteNumber(row.inputCostUsd) ?? 0,
          cacheReadCostUsd: asFiniteNumber(row.cacheReadCostUsd) ?? 0,
          cacheWriteCostUsd: asFiniteNumber(row.cacheWriteCostUsd) ?? 0,
          outputCostUsd: asFiniteNumber(row.outputCostUsd) ?? 0,
          totalCostUsd: asFiniteNumber(row.totalCostUsd) ?? 0,
          stopReason: asTrimmedString(row.stopReason) || "unknown",
          ...(errorMessage ? { errorMessage } : {}),
        };
      }),
      truncated,
    };
  }
  /** Resolve canonical lifecycle rows referenced by exact-thread custom
   * messages. The ids originate from that thread's durable entries, so this
   * point lookup preserves thread ownership without scanning or flattening
   * the root transcript. */
  listLifecycleEventsByIds(
    eventIdsInput: readonly string[],
  ): LocalChatEventRecord[] {
    const eventIds = [
      ...new Set(eventIdsInput.map(asTrimmedString).filter(Boolean)),
    ].slice(0, 500) as string[];
    if (eventIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `
      SELECT
        message.id AS _id,
        message.created_at AS timestamp,
        message.type AS type,
        message.device_id AS deviceId,
        message.request_id AS requestId,
        message.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        message.data_json AS channelEnvelopeJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE message.id IN (${eventIds.map(() => "?").join(", ")})
        AND message.type IN (
          'agent-started',
          'agent-progress',
          'agent-completed',
          'agent-failed',
          'agent-canceled'
        )
      ORDER BY message.created_at ASC, message.id ASC
    `,
      )
      .all(...eventIds) as LocalChatEventRow[];
    return rows.map((row) => this.deserializeEventRow(row));
  }

  /**
   * Return cross-conversation activity newer than `sinceMs` (plain ms
   * since the Unix epoch — same unit `message.created_at` is written
   * with by every `appendLocalChatEvent` call). Capped at `limit`
   * (default 80) of the most recent events and returned oldest→newest
   * so callers can fold them into a chronological brief.
   */
  listRecentActivitySince(args) {
    const sinceMs = Number.isFinite(args.sinceMs)
      ? Math.max(0, Math.floor(args.sinceMs))
      : 0;
    const normalizedLimit = Math.max(
      1,
      Math.min(Math.floor(args.limit ?? 80), 500),
    );
    const rows = this.db
      .prepare(
        `
      SELECT
        recent.session_id AS conversationId,
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        recent.request_id AS requestId,
        recent.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        recent.data_json AS channelEnvelopeJson
      FROM (
        SELECT *
        FROM message
        WHERE created_at >= ?
          AND type IN (
            'user_message',
            'assistant_message',
            'agent-started',
            'agent-progress',
            'agent-completed',
            'agent-failed',
            'agent-canceled',
            'tool_result'
          )
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `,
      )
      .all(sinceMs, normalizedLimit);
    return rows.map((row) => ({
      conversationId: row.conversationId,
      ...this.deserializeEventRow(row),
    }));
  }
  /**
   * Page strictly older events than a `(beforeTimestampMs, beforeId)` cursor.
   * Used by the chat home overview's "See all" dialog to walk SQLite for
   * additional history beyond the renderer's in-memory event window —
   * without that, the dialog can only ever show what's already loaded for
   * the live chat (capped at ~500 events).
   *
   * Mirrors `listEvents`'s exclusion of internal types (`thread_message`,
   * `run_event`, `memory`) so the rows roundtrip through the same
   * `EventRecord` shape downstream consumers already use.
   */
  listEventsBefore(conversationIdInput, opts) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const beforeTimestamp = Math.floor(opts.beforeTimestampMs);
    const beforeId = opts.beforeId ?? "";
    const normalizedLimit = Math.max(1, Math.floor(opts.limit ?? 50));
    const rows = this.db
      .prepare(
        `
      SELECT
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        recent.request_id AS requestId,
        recent.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        recent.data_json AS channelEnvelopeJson
      FROM (
        SELECT *
        FROM message
        WHERE session_id = ?
          AND type NOT IN ('thread_message', 'run_event', 'memory')
          AND (
            created_at < ?
            OR (created_at = ? AND id < ?)
          )
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `,
      )
      .all(
        conversationId,
        beforeTimestamp,
        beforeTimestamp,
        beforeId,
        normalizedLimit,
      );
    return rows.map((row) => this.deserializeEventRow(row));
  }
  /**
   * Window of visible chat messages with each assistant message's turn-
   * scoped tool/agent lifecycle events attached as `toolEvents`. This is
   * the read shape the chat UI consumes — pure event-log readers should
   * keep using `listEvents` / `listEventsBefore`.
   *
   * Two-step query: first locate the (timestamp, id) cutoff of the
   * `maxVisibleMessages`-th most-recent user/assistant row, then fetch all
   * tool/agent lifecycle events from the cutoff forward and group them by
   * turn (boundary = `user_message`). Mirrors the renderer's prior
   * `segmentToolEventsByAssistant` so the inline-artifact /
   * schedule-receipt projections that hung off the flat event stream keep
   * working without a flat event stream.
   *
   * `messages` is the ordered visible chat (oldest → newest). Trailing
   * tool/agent lifecycle events that landed after the last visible
   * `user_message` with no following assistant yet (typical for
   * fire-and-forget image submissions in-flight at fetch time) stay on
   * that user message's `toolEvents`, so the renderer can synthesize the
   * standalone artifact row it always has.
   */
  listMessages(conversationIdInput, args = {}) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const maxVisibleMessages = Math.max(
      1,
      Math.min(
        MAX_VISIBLE_MESSAGE_WINDOW,
        Math.floor(args.maxVisibleMessages ?? 200),
      ),
    );
    const cutoff = this.findVisibleMessageCutoff(
      conversationId,
      maxVisibleMessages,
    );
    const fetchCutoff = this.findTurnFetchCutoff(conversationId, cutoff);
    const rows = this.fetchTimelineRows(
      conversationId,
      fetchCutoff,
      null,
      null,
      null,
      null,
      ["user_message", "assistant_message"],
      true,
    );
    const projected = this.attachBoundedToolEvents(
      conversationId,
      this.assembleMessageWindow(rows),
      null,
    );
    const nextCursor = this.findLatestTimelineCursor(conversationId);
    return {
      ...this.trimMessageWindow(projected, cutoff),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
  /**
   * Same projection as `listMessages` but returns strictly-older messages
   * than `(beforeTimestampMs, beforeId)`. Drives the chat's "load older"
   * pagination — the cursor is the oldest message in the currently-loaded
   * window so successive calls walk the conversation backwards a page at
   * a time.
   */
  listMessagesBefore(conversationIdInput, args) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const maxVisibleMessages = Math.max(
      1,
      Math.min(
        MAX_VISIBLE_MESSAGE_WINDOW,
        Math.floor(args.maxVisibleMessages ?? 200),
      ),
    );
    const beforeTimestamp = Math.floor(args.beforeTimestampMs);
    const beforeId = args.beforeId;
    const before = this.resolveCursorSequence(conversationId, {
      timestamp: beforeTimestamp,
      id: beforeId,
    });
    const cutoff = this.findVisibleMessageCutoffBefore(
      conversationId,
      maxVisibleMessages,
      before,
    );
    const fetchCutoff = this.findTurnFetchCutoff(conversationId, cutoff);
    const rows = this.fetchTimelineRows(
      conversationId,
      fetchCutoff,
      before,
      null,
      null,
      null,
      ["user_message", "assistant_message"],
      true,
    );
    const projected = this.attachBoundedToolEvents(
      conversationId,
      this.assembleMessageWindow(rows),
      before,
    );
    return this.trimMessageWindow(projected, cutoff);
  }
  /**
   * Same projection as `listMessages`, but walks forward from a known mobile
   * cursor. The returned rows are the new user/assistant messages plus any
   * existing message rows whose turn gained new tool-derived artifacts after
   * the cursor.
   */
  listMessagesAfter(conversationIdInput, args) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const maxVisibleMessages = Math.max(
      1,
      Math.min(
        MAX_VISIBLE_MESSAGE_WINDOW,
        Math.floor(args.maxVisibleMessages ?? 200),
      ),
    );
    const after = this.resolveCursorSequence(conversationId, {
      timestamp: Math.floor(args.afterTimestampMs),
      id: args.afterId,
      ...(typeof args.afterSequence === "number"
        ? { sequence: args.afterSequence }
        : {}),
    });
    const pageEnd = this.findVisibleMessagePageEndAfter(
      conversationId,
      maxVisibleMessages,
      after,
    );
    // Stop immediately before the next turn anchor after the page. This keeps
    // the page bounded while still including tool/lifecycle rows belonging to
    // its final assistant message. With no newer visible message, leave the
    // upper bound open so artifact-only updates to the current turn continue
    // to refresh that already-loaded message.
    const until = pageEnd
      ? this.findVisibleMessageCursorAfter(conversationId, pageEnd)
      : null;
    const fetchCutoff = this.findTurnFetchCutoff(conversationId, after);
    // The renderer never needs the raw source-event stream: fetch just the
    // turn's few message anchors, then attach bounded event projections.
    // Mobile source events use their own strict cursor query. Starting that
    // bounded query at the turn anchor can spend its entire row budget on
    // events the mobile client already processed and then skip the remainder
    // when advancing its cursor.
    const includeSourceEvents = args.includeSourceEvents !== false;
    const messageRows = this.fetchTimelineRows(
      conversationId,
      fetchCutoff,
      null,
      null,
      null,
      until,
      ["user_message", "assistant_message"],
      true,
    );
    const sourceEvents = includeSourceEvents
      ? this.fetchTimelineRows(
          conversationId,
          null,
          null,
          after,
          CUTOFF_SCAN_CEILING,
          until,
        )
      : messageRows.filter(
          (event) =>
            compareTimelineCursor(
              {
                timestamp: event.timestamp,
                id: event._id,
                sequence: event.sequence,
              },
              after,
            ) > 0,
        );
    // Mobile advances its durable cursor over `sourceEvents`, so every event
    // before that cursor must participate in the delta projection. Applying
    // the desktop head/tail projection here would permanently skip artifacts
    // in the omitted middle of a busy turn. The source page itself is strictly
    // capped, and subsequent calls continue from its exact last row.
    const projectionRows = includeSourceEvents
      ? Array.from(
          new Map(
            [...messageRows, ...sourceEvents].map((event) => [
              event._id,
              event,
            ]),
          ).values(),
        ).sort((a, b) =>
          compareTimelineCursor(
            { timestamp: a.timestamp, id: a._id, sequence: a.sequence },
            { timestamp: b.timestamp, id: b._id, sequence: b.sequence },
          ),
        )
      : messageRows;
    const assembled = this.assembleMessageWindow(projectionRows);
    const projected = includeSourceEvents
      ? assembled
      : this.attachBoundedToolEvents(conversationId, assembled, until);
    const lastSourceEvent = includeSourceEvents ? sourceEvents.at(-1) : null;
    const nextCursor = lastSourceEvent
      ? {
          timestamp: lastSourceEvent.timestamp,
          id: lastSourceEvent._id,
          ...(typeof lastSourceEvent.sequence === "number"
            ? { sequence: lastSourceEvent.sequence }
            : {}),
        }
      : includeSourceEvents
        ? null
        : this.findLatestTimelineCursor(conversationId, until);
    return {
      ...this.limitChangedMessageWindow(projected, after, maxVisibleMessages),
      sourceEvents,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
  hasMobileSyncEventsAfter(
    conversationIdInput,
    afterTimestampMs,
    afterId,
    afterSequence,
  ) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const cursor = this.resolveCursorSequence(conversationId, {
      timestamp: Math.floor(afterTimestampMs),
      id: afterId,
      ...(typeof afterSequence === "number" ? { sequence: afterSequence } : {}),
    });
    const keyset = this.timelineKeyset("", ">", cursor);
    const row = this.db
      .prepare(
        `
      SELECT 1 AS found
      FROM message
      WHERE session_id = ?
        AND type IN ('user_message', 'assistant_message', 'tool_request', 'tool_result', 'agent-started', 'agent-progress', 'agent-completed', 'agent-failed', 'agent-canceled')
        AND ${keyset.clause}
      ORDER BY ${this.timelineOrderBy("", "ASC")}
      LIMIT 1
    `,
      )
      .get(conversationId, ...keyset.params);
    return row?.found === 1;
  }
  isMobileSyncCursorValid(
    conversationIdInput,
    cursorTimestampMs,
    cursorId,
    cursorSequence,
  ) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    if (typeof cursorId !== "string" || cursorId.length === 0) return false;
    const row = this.db
      .prepare(
        `SELECT created_at AS timestamp${this.orderingSequenceSelect()}
           FROM message
          WHERE session_id = ? AND id = ?
          LIMIT 1`,
      )
      .get(conversationId, cursorId);
    if (!row || row.timestamp !== Math.floor(cursorTimestampMs)) return false;
    return (
      typeof cursorSequence !== "number" ||
      !this.orderingBySequence ||
      row.sequence === Math.floor(cursorSequence)
    );
  }
  /**
   * Resolve lifecycle state only for task ids a cursor delta touched. This is
   * deliberately separate from `listMessages`: incremental mobile sync must
   * not scan/project the latest 100 transcript rows merely to recover an old
   * task's spawning anchor. Each matching start event loads only its own turn,
   * then later lifecycle events for that agent are folded onto that anchor.
   */
  listMobileTaskContext(conversationIdInput, agentIdsInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const agentIds = [
      ...new Set(agentIdsInput.map(asTrimmedString).filter(Boolean)),
    ].slice(0, 100);
    if (agentIds.length === 0) {
      return { messages: [], visibleMessageCount: 0 };
    }
    const placeholders = agentIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
      SELECT
        message.id AS _id,
        message.created_at AS timestamp,
        message.type AS type,
        message.device_id AS deviceId,
        message.request_id AS requestId,
        message.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        message.data_json AS channelEnvelopeJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE message.session_id = ?
        AND message.type IN ('agent-started', 'agent-progress', 'agent-completed', 'agent-failed', 'agent-canceled')
        AND json_extract(part.data_json, '$.agentId') IN (${placeholders})
      ORDER BY message.created_at ASC, message.id ASC
    `,
      )
      .all(conversationId, ...agentIds);
    const lifecycleEvents = rows.map((row) => this.deserializeEventRow(row));
    const eventsByAgent = new Map();
    for (const event of lifecycleEvents) {
      const agentId = asTrimmedString(event.payload?.agentId);
      if (!agentId) continue;
      const bucket = eventsByAgent.get(agentId);
      if (bucket) bucket.push(event);
      else eventsByAgent.set(agentId, [event]);
    }
    const anchorsById = new Map();
    for (const start of lifecycleEvents) {
      if (start.type !== "agent-started") continue;
      const agentId = asTrimmedString(start.payload?.agentId);
      if (!agentId) continue;
      const turnStart = this.findTurnFetchCutoff(conversationId, {
        timestamp: start.timestamp,
        id: start._id,
      });
      const nextTurn = this.findNextUserMessageAfter(conversationId, turnStart);
      const turn = this.assembleMessageWindow(
        this.fetchTimelineRows(conversationId, turnStart, nextTurn),
      );
      const anchor =
        turn.messages.find((message) =>
          message.toolEvents.some((event) => event._id === start._id),
        ) ?? turn.messages.find((message) => message.type === "user_message");
      if (!anchor) continue;
      const existing = anchorsById.get(anchor._id);
      const lifecycle = eventsByAgent.get(agentId) ?? [];
      const combined = [
        ...(existing?.toolEvents ?? anchor.toolEvents),
        ...lifecycle,
      ];
      const seen = new Set();
      const toolEvents = combined
        .filter((event) => {
          if (seen.has(event._id)) return false;
          seen.add(event._id);
          return true;
        })
        .sort(
          (a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id),
        );
      anchorsById.set(anchor._id, { ...anchor, toolEvents });
    }
    const messages = [...anchorsById.values()].sort(
      (a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id),
    );
    return {
      messages,
      visibleMessageCount: messages.filter(
        (message) => !isUiHiddenChatMessagePayload(message.payload ?? null),
      ).length,
    };
  }
  /** UI visibility is materialized and indexed by database-init triggers. */
  findVisibleMessageCutoff(conversationId, maxVisibleMessages) {
    return this.findVisibleMessageCutoffPaged(
      conversationId,
      maxVisibleMessages,
      null,
    );
  }
  findVisibleMessageCutoffBefore(conversationId, maxVisibleMessages, before) {
    return this.findVisibleMessageCutoffPaged(
      conversationId,
      maxVisibleMessages,
      before,
    );
  }
  findVisibleMessagePageEndAfter(
    conversationId,
    maxVisibleMessages,
    initialAfter,
  ) {
    const after = this.resolveCursorSequence(conversationId, initialAfter);
    const afterKeyset = this.timelineKeyset("message", ">", after);
    const rows = this.db
      .prepare(
        `SELECT message.created_at AS timestamp, message.id AS id${this.orderingSequenceSelect("message")}
         FROM message
         WHERE message.session_id = ?
           AND message.type IN ('user_message', 'assistant_message')
           AND message.ui_visible = 1
           AND ${afterKeyset.clause}
         ORDER BY ${this.timelineOrderBy("message", "ASC")}
         LIMIT ?`,
      )
      .all(conversationId, ...afterKeyset.params, maxVisibleMessages);
    const row = rows.at(-1);
    return typeof row?.timestamp === "number" && typeof row.id === "string"
      ? {
          timestamp: row.timestamp,
          id: row.id,
          ...(typeof row.sequence === "number"
            ? { sequence: row.sequence }
            : {}),
        }
      : null;
  }
  findVisibleMessageCursorAfter(conversationId, initialAfter) {
    const after = this.resolveCursorSequence(conversationId, initialAfter);
    const afterKeyset = this.timelineKeyset("message", ">", after);
    const row = this.db
      .prepare(
        `
        SELECT message.created_at AS timestamp, message.id AS id${this.orderingSequenceSelect("message")}
        FROM message
        WHERE message.session_id = ?
          AND message.type IN ('user_message', 'assistant_message')
          AND message.ui_visible = 1
          AND ${afterKeyset.clause}
        ORDER BY ${this.timelineOrderBy("message", "ASC")}
        LIMIT 1
      `,
      )
      .get(conversationId, ...afterKeyset.params);
    if (
      !row ||
      typeof row.timestamp !== "number" ||
      typeof row.id !== "string"
    ) {
      return null;
    }
    return {
      timestamp: row.timestamp,
      id: row.id,
      ...(typeof row.sequence === "number" ? { sequence: row.sequence } : {}),
    };
  }
  findVisibleMessageCutoffPaged(
    conversationId,
    maxVisibleMessages,
    initialBefore,
  ) {
    const before = this.resolveCursorSequence(conversationId, initialBefore);
    const beforeKeyset = before
      ? this.timelineKeyset("message", "<", before)
      : null;
    const params = [conversationId];
    if (beforeKeyset) params.push(...beforeKeyset.params);
    params.push(maxVisibleMessages - 1);
    const row = this.db
      .prepare(
        `SELECT message.created_at AS timestamp, message.id AS id${this.orderingSequenceSelect("message")}
         FROM message
         WHERE message.session_id = ?
           AND message.type IN ('user_message', 'assistant_message')
           AND message.ui_visible = 1
           ${beforeKeyset ? `AND ${beforeKeyset.clause}` : ""}
         ORDER BY ${this.timelineOrderBy("message", "DESC")}
         LIMIT 1 OFFSET ?`,
      )
      .get(...params);
    return typeof row?.timestamp === "number" && typeof row.id === "string"
      ? {
          timestamp: row.timestamp,
          id: row.id,
          ...(typeof row.sequence === "number"
            ? { sequence: row.sequence }
            : {}),
        }
      : null;
  }
  fetchTimelineRows(
    conversationId,
    cutoff,
    before = null,
    after = null,
    limit = undefined,
    until = null,
    eventTypes = null,
    visibleMessagesOnly = false,
  ) {
    const normalizedEventTypes = Array.isArray(eventTypes)
      ? [...new Set(eventTypes.map(asTrimmedString).filter(Boolean))]
      : [];
    const clauses = [
      "message.session_id = ?",
      normalizedEventTypes.length > 0
        ? `message.type IN (${normalizedEventTypes.map(() => "?").join(", ")})`
        : "message.type IN ('user_message', 'assistant_message', 'tool_request', 'tool_result', 'agent-started', 'agent-progress', 'agent-completed', 'agent-failed', 'agent-canceled')",
    ];
    const params = [conversationId, ...normalizedEventTypes];
    if (visibleMessagesOnly) clauses.push("message.ui_visible = 1");
    if (cutoff) {
      const k = this.timelineKeyset(
        "message",
        ">=",
        this.resolveCursorSequence(conversationId, cutoff),
      );
      clauses.push(k.clause);
      params.push(...k.params);
    }
    if (before) {
      const k = this.timelineKeyset(
        "message",
        "<",
        this.resolveCursorSequence(conversationId, before),
      );
      clauses.push(k.clause);
      params.push(...k.params);
    }
    if (after) {
      const k = this.timelineKeyset(
        "message",
        ">",
        this.resolveCursorSequence(conversationId, after),
      );
      clauses.push(k.clause);
      params.push(...k.params);
    }
    if (until) {
      const k = this.timelineKeyset(
        "message",
        "<",
        this.resolveCursorSequence(conversationId, until),
      );
      clauses.push(k.clause);
      params.push(...k.params);
    }
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : null;
    if (normalizedLimit !== null) {
      params.push(normalizedLimit);
    }
    const sql = `
      SELECT
        message.id AS _id,
        message.created_at AS timestamp${this.orderingSequenceSelect("message")},
        message.type AS type,
        message.device_id AS deviceId,
        message.request_id AS requestId,
        message.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        message.data_json AS channelEnvelopeJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE ${clauses.join(" AND ")}
      ORDER BY ${this.timelineOrderBy("message", "ASC")}
      ${normalizedLimit !== null ? "LIMIT ?" : ""}
    `;
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => this.deserializeEventRow(row));
  }
  findLatestTimelineCursor(conversationId, until = null) {
    const clauses = ["message.session_id = ?"];
    const params = [conversationId];
    if (until) {
      const k = this.timelineKeyset(
        "message",
        "<",
        this.resolveCursorSequence(conversationId, until),
      );
      clauses.push(k.clause);
      params.push(...k.params);
    }
    const row = this.db
      .prepare(
        `SELECT message.created_at AS timestamp, message.id AS id${this.orderingSequenceSelect("message")}
         FROM message
         WHERE ${clauses.join(" AND ")}
         ORDER BY ${this.timelineOrderBy("message", "DESC")}
         LIMIT 1`,
      )
      .get(...params);
    return typeof row?.timestamp === "number" && typeof row.id === "string"
      ? {
          timestamp: row.timestamp,
          id: row.id,
          ...(typeof row.sequence === "number"
            ? { sequence: row.sequence }
            : {}),
        }
      : null;
  }
  fetchBoundedToolEvents(conversationId, start, end) {
    const clauses = [
      "message.session_id = ?",
      "message.type IN ('tool_request', 'tool_result', 'agent-started', 'agent-progress', 'agent-completed', 'agent-failed', 'agent-canceled')",
    ];
    const params = [conversationId];
    if (start) {
      const k = this.timelineKeyset(
        "message",
        ">",
        this.resolveCursorSequence(conversationId, start),
      );
      clauses.push(k.clause);
      params.push(...k.params);
    }
    if (end) {
      const k = this.timelineKeyset(
        "message",
        "<",
        this.resolveCursorSequence(conversationId, end),
      );
      clauses.push(k.clause);
      params.push(...k.params);
    }
    const select = `
      SELECT
        message.id AS _id,
        message.created_at AS timestamp${this.orderingSequenceSelect("message")},
        message.type AS type,
        message.device_id AS deviceId,
        message.request_id AS requestId,
        message.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        message.data_json AS channelEnvelopeJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE ${clauses.join(" AND ")}`;
    const headProbeRows = this.db
      .prepare(
        `${select}
         ORDER BY ${this.timelineOrderBy("message", "ASC")}
         LIMIT ${EAGER_TOOL_EVENT_LIMIT + 1}`,
      )
      .all(...params);
    const eventCountTruncated = headProbeRows.length > EAGER_TOOL_EVENT_LIMIT;
    const headRows = eventCountTruncated
      ? headProbeRows.slice(0, EAGER_TOOL_EVENT_SIDE_LIMIT)
      : headProbeRows;
    const tailRows = eventCountTruncated
      ? this.db
          .prepare(
            `${select}
               ORDER BY ${this.timelineOrderBy("message", "DESC")}
               LIMIT ${EAGER_TOOL_EVENT_SIDE_LIMIT}`,
          )
          .all(...params)
      : [];
    const rowsById = new Map();
    for (const row of [...headRows, ...tailRows]) rowsById.set(row._id, row);
    let payloadProjected = false;
    const events = [...rowsById.values()]
      .map((row) => {
        const projected = projectLocalChatUpdateEventWithMetadata(
          this.deserializeEventRow(row),
        );
        payloadProjected ||= projected.payloadProjected;
        return projected.event;
      })
      .sort((a, b) =>
        compareTimelineCursor(
          { timestamp: a.timestamp, id: a._id, sequence: a.sequence },
          { timestamp: b.timestamp, id: b._id, sequence: b.sequence },
        ),
      );
    return {
      events,
      totalCount: eventCountTruncated ? events.length + 1 : events.length,
      eventCountTruncated,
      detailTruncated: eventCountTruncated || payloadProjected,
    };
  }
  attachBoundedToolEvents(conversationId, window, upperBound) {
    if (window.messages.length === 0) return window;
    const attachedById = new Map();
    let turn = [];
    const cursorFor = (message) => ({
      timestamp: message.timestamp,
      id: message._id,
      ...(typeof message.sequence === "number"
        ? { sequence: message.sequence }
        : {}),
    });
    const attachTurn = (messages, turnEnd) => {
      if (messages.length === 0) return;
      const user = messages.find((message) => message.type === "user_message");
      const assistants = messages.filter(
        (message) =>
          message.type === "assistant_message" &&
          !isUiHiddenChatMessagePayload(message.payload ?? null),
      );
      const anchors = assistants.length > 0 ? assistants : user ? [user] : [];
      anchors.forEach((anchor, index) => {
        const start = index === 0 && user ? cursorFor(user) : cursorFor(anchor);
        const end =
          index + 1 < anchors.length ? cursorFor(anchors[index + 1]) : turnEnd;
        const { events, totalCount, eventCountTruncated, detailTruncated } =
          this.fetchBoundedToolEvents(conversationId, start, end);
        attachedById.set(anchor._id, {
          ...anchor,
          toolEvents: events,
          toolEventSummary: {
            totalCount,
            loadedCount: events.length,
            truncated: detailTruncated,
            ...(eventCountTruncated ? { totalCountIsLowerBound: true } : {}),
          },
        });
      });
    };
    for (const message of window.messages) {
      if (message.type === "user_message" && turn.length > 0) {
        attachTurn(turn, cursorFor(message));
        turn = [];
      }
      turn.push(message);
    }
    attachTurn(turn, upperBound);
    return {
      ...window,
      messages: window.messages.map(
        (message) => attachedById.get(message._id) ?? message,
      ),
    };
  }
  listMessageToolEvents(conversationIdInput, args) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const anchor = this.resolveCursorSequence(conversationId, {
      timestamp: Math.floor(args.messageTimestampMs),
      id: args.messageId,
      ...(typeof args.messageSequence === "number"
        ? { sequence: args.messageSequence }
        : {}),
    });
    const anchorRow = this.db
      .prepare(
        `SELECT type FROM message WHERE session_id = ? AND id = ? LIMIT 1`,
      )
      .get(conversationId, anchor.id);
    const turnStart = this.findTurnFetchCutoff(conversationId, anchor);
    const previousAssistant =
      anchorRow?.type === "assistant_message"
        ? this.findPreviousVisibleAssistantAfter(
            conversationId,
            turnStart,
            anchor,
          )
        : null;
    const rangeStart = previousAssistant ? anchor : (turnStart ?? anchor);
    const rangeEnd =
      anchorRow?.type === "user_message"
        ? this.findNextUserMessageAfter(conversationId, anchor)
        : this.findVisibleMessageCursorAfter(conversationId, anchor);
    const after = args.afterId
      ? this.resolveCursorSequence(conversationId, {
          timestamp: Math.floor(args.afterTimestampMs ?? 0),
          id: args.afterId,
          ...(typeof args.afterSequence === "number"
            ? { sequence: args.afterSequence }
            : {}),
        })
      : rangeStart;
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 50)));
    const rows = this.fetchTimelineRows(
      conversationId,
      null,
      null,
      after,
      limit + 1,
      rangeEnd,
      [
        "tool_request",
        "tool_result",
        "agent-started",
        "agent-progress",
        "agent-completed",
        "agent-failed",
        "agent-canceled",
      ],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      events: page,
      hasMore: rows.length > limit,
      ...(last
        ? {
            nextCursor: {
              timestamp: last.timestamp,
              id: last._id,
              ...(typeof last.sequence === "number"
                ? { sequence: last.sequence }
                : {}),
            },
          }
        : {}),
    };
  }
  findPreviousVisibleAssistantAfter(conversationId, start, before) {
    if (!start || !before) return null;
    const startKeyset = this.timelineKeyset(
      "message",
      ">",
      this.resolveCursorSequence(conversationId, start),
    );
    const beforeKeyset = this.timelineKeyset(
      "message",
      "<",
      this.resolveCursorSequence(conversationId, before),
    );
    const row = this.db
      .prepare(
        `SELECT message.created_at AS timestamp, message.id AS id${this.orderingSequenceSelect("message")}
         FROM message
         WHERE message.session_id = ?
           AND message.type = 'assistant_message'
           AND message.ui_visible = 1
           AND ${startKeyset.clause}
           AND ${beforeKeyset.clause}
         ORDER BY ${this.timelineOrderBy("message", "DESC")}
         LIMIT 1`,
      )
      .get(conversationId, ...startKeyset.params, ...beforeKeyset.params);
    return typeof row?.timestamp === "number" && typeof row.id === "string"
      ? {
          timestamp: row.timestamp,
          id: row.id,
          ...(typeof row.sequence === "number"
            ? { sequence: row.sequence }
            : {}),
        }
      : null;
  }
  findTurnFetchCutoff(conversationId, cutoff) {
    if (!cutoff) return null;
    const resolved = this.resolveCursorSequence(conversationId, cutoff);
    const keyset = this.timelineKeyset("message", "<=", resolved);
    const row = this.db
      .prepare(
        `
      SELECT message.created_at AS timestamp, message.id AS id${this.orderingSequenceSelect("message")}
      FROM message
      WHERE message.session_id = ?
        AND message.type = 'user_message'
        AND message.ui_visible = 1
        AND ${keyset.clause}
      ORDER BY ${this.timelineOrderBy("message", "DESC")}
      LIMIT 1
    `,
      )
      .get(conversationId, ...keyset.params);
    if (typeof row?.timestamp !== "number" || typeof row.id !== "string") {
      return resolved;
    }
    return {
      timestamp: row.timestamp,
      id: row.id,
      ...(typeof row.sequence === "number" ? { sequence: row.sequence } : {}),
    };
  }
  findNextUserMessageAfter(conversationId, cursor) {
    if (!cursor) return null;
    const resolved = this.resolveCursorSequence(conversationId, cursor);
    const keyset = this.timelineKeyset("message", ">", resolved);
    const row = this.db
      .prepare(
        `
      SELECT message.created_at AS timestamp, message.id AS id${this.orderingSequenceSelect("message")}
      FROM message
      WHERE message.session_id = ?
        AND message.type = 'user_message'
        AND message.ui_visible = 1
        AND ${keyset.clause}
      ORDER BY ${this.timelineOrderBy("message", "ASC")}
      LIMIT 1
    `,
      )
      .get(conversationId, ...keyset.params);
    return typeof row?.timestamp === "number" && typeof row.id === "string"
      ? {
          timestamp: row.timestamp,
          id: row.id,
          ...(typeof row.sequence === "number"
            ? { sequence: row.sequence }
            : {}),
        }
      : null;
  }
  /**
   * Ensure a keyset cursor carries `sequence`. External cursors (mobile delta
   * `after`, pagination `before`) arrive as (timestamp, id); resolve the row's
   * ordering_sequence by id once so the keyset predicate can key on it. No-op
   * when the sequence is already present, or when the id no longer resolves (the
   * keyset then degrades to the legacy tuple — see timelineKeyset).
   */
  resolveCursorSequence(conversationId, cursor) {
    if (!cursor) return cursor;
    if (!this.orderingBySequence) return cursor;
    if (typeof cursor.sequence === "number") return cursor;
    if (typeof cursor.id !== "string" || cursor.id.length === 0) return cursor;
    const row = this.db
      .prepare(
        `SELECT ordering_sequence AS sequence FROM message
          WHERE session_id = ? AND id = ? LIMIT 1`,
      )
      .get(conversationId, cursor.id);
    return typeof row?.sequence === "number"
      ? { ...cursor, sequence: row.sequence }
      : cursor;
  }
  trimMessageWindow(window, cutoff) {
    if (!cutoff) return window;
    let visibleMessageCount = 0;
    const messages = window.messages.filter((message) => {
      const keep =
        compareTimelineCursor(
          {
            timestamp: message.timestamp,
            id: message._id,
            ...(this.orderingBySequence && typeof message.sequence === "number"
              ? { sequence: message.sequence }
              : {}),
          },
          cutoff,
        ) >= 0;
      if (keep && !isUiHiddenChatMessagePayload(message.payload ?? null)) {
        visibleMessageCount += 1;
      }
      return keep;
    });
    return { messages, visibleMessageCount };
  }
  limitMessageWindow(window, maxVisibleMessages) {
    const messages = [];
    let visibleMessageCount = 0;
    for (const message of window.messages) {
      messages.push(message);
      if (!isUiHiddenChatMessagePayload(message.payload ?? null)) {
        visibleMessageCount += 1;
      }
      if (visibleMessageCount >= maxVisibleMessages) {
        break;
      }
    }
    return { messages, visibleMessageCount };
  }
  limitChangedMessageWindow(window, after, maxVisibleMessages) {
    const messages = [];
    let visibleMessageCount = 0;
    for (const message of window.messages) {
      const messageChanged =
        compareTimelineCursor(
          {
            timestamp: message.timestamp,
            id: message._id,
            ...(this.orderingBySequence && typeof message.sequence === "number"
              ? { sequence: message.sequence }
              : {}),
          },
          after,
        ) > 0;
      const toolEventsChanged = message.toolEvents.some(
        (event) =>
          compareTimelineCursor(
            {
              timestamp: event.timestamp,
              id: event._id,
              ...(this.orderingBySequence && typeof event.sequence === "number"
                ? { sequence: event.sequence }
                : {}),
            },
            after,
          ) > 0,
      );
      if (!messageChanged && !toolEventsChanged) continue;
      messages.push(message);
      if (!isUiHiddenChatMessagePayload(message.payload ?? null)) {
        visibleMessageCount += 1;
      }
      if (visibleMessageCount >= maxVisibleMessages) {
        break;
      }
    }
    return { messages, visibleMessageCount };
  }
  /**
   * Walk fetched rows forward, group them into turns (boundary =
   * `user_message`), and attach every tool/agent lifecycle event in
   * a turn to the assistant message that most-recently preceded it:
   *
   *   - **most-recent preceding assistant** of the turn — orchestrator
   *     runs that emit a preamble → tools → post-tool answer render
   *     linearly with tool-derived artifacts on the preamble bubble
   *     (rather than collapsing every assistant in the turn into one
   *     row that owns every tool).
   *
   *   - **first assistant** of the turn for tools that fired BEFORE
   *     any assistant text (common for `image_gen` / `html` /
   *     `Schedule` called eagerly) — those tools defer until the first
   *     assistant arrives and attach to it, so inline image / schedule
   *     receipt / office preview / source-diff artifacts still surface
   *     on the assistant row.
   *
   *   - **user_message** of the turn when no assistant fires — fixes
   *     the prior port's silent drop of tools in turns where the
   *     agent's first action is a fire-and-forget tool. The renderer's
   *     trailing artifact paths already read from `user_message.toolEvents`,
   *     so they surface correctly.
   *
   * `visibleMessageCount` is the count of user/assistant rows whose
   * payload doesn't satisfy `isUiHiddenChatMessagePayload`. The chat
   * hook bases `hasOlderMessages` / `isLoadingOlder` on this rather
   * than raw `messages.length` so UI-hidden system reminders or
   * workspace-creation requests in the window don't make pagination
   * state latch against the wrong threshold.
   *
   * Mirror this in lockstep with `groupEventsIntoMessages` on the
   * renderer so cloud-mode and local-mode produce identical shapes.
   */
  assembleMessageWindow(rows) {
    const messages = [];
    let turnUserMessage = null;
    let currentAssistant = null;
    let pendingPreAssistantTools = [];
    let visibleMessageCount = 0;
    /**
     * Flush tools that arrived in the current turn without ever seeing
     * an assistant message — fall back to the user_message anchor so
     * inline artifacts on fire-and-forget turns
     * still render. Mirrors `groupEventsIntoMessages` on the renderer.
     */
    const finalizePreAssistantTools = () => {
      if (pendingPreAssistantTools.length > 0 && turnUserMessage) {
        turnUserMessage.toolEvents = [
          ...turnUserMessage.toolEvents,
          ...pendingPreAssistantTools,
        ];
      }
      pendingPreAssistantTools = [];
    };
    for (const row of rows) {
      if (row.type === "user_message") {
        finalizePreAssistantTools();
        const message = { ...row, toolEvents: [] };
        messages.push(message);
        turnUserMessage = message;
        currentAssistant = null;
        if (!isUiHiddenChatMessagePayload(row.payload ?? null)) {
          visibleMessageCount += 1;
        }
        continue;
      }
      if (row.type === "assistant_message") {
        const message = { ...row, toolEvents: [] };
        messages.push(message);
        const hidden = isUiHiddenChatMessagePayload(row.payload ?? null);
        // Tools that fired before any assistant in this turn attach to
        // the FIRST assistant (preserves the prior inline-artifact
        // behavior for tools called before any reply text). Tools that
        // fired between two assistants attach to whichever was most
        // recently seen — so an orchestrator run that does
        // preamble → tools → post-tool answer renders linearly with
        // tool-derived artifacts on the preamble bubble.
        if (!hidden && pendingPreAssistantTools.length > 0) {
          message.toolEvents = [
            ...message.toolEvents,
            ...pendingPreAssistantTools,
          ];
          pendingPreAssistantTools = [];
        }
        if (!hidden) {
          currentAssistant = message;
          visibleMessageCount += 1;
        }
        continue;
      }
      if (currentAssistant) {
        currentAssistant.toolEvents = [...currentAssistant.toolEvents, row];
      } else {
        pendingPreAssistantTools.push(row);
      }
    }
    finalizePreAssistantTools();
    return { messages, visibleMessageCount };
  }
  /**
   * Agent lifecycle events (`agent-started` / `agent-progress` /
   * `agent-completed` / `agent-failed` / `agent-canceled`) for the
   * conversation, ordered ASC by `(timestamp, _id)`.
   *
   * Task STATE no longer derives from these events (that's
   * `listThreadActivity`); the remaining consumers are file-derived
   * surfaces (per-agent file lists merge the `agent-completed` rollups)
   * and the inline chat cards' per-occurrence history.
   *
   * Optional `beforeTimestampMs` / `beforeId` cursor returns strictly-
   * older activity.
   */
  listActivity(conversationIdInput, args = {}) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const normalizedLimit = Math.max(1, Math.floor(args.limit ?? 500));
    const before =
      typeof args.beforeTimestampMs === "number"
        ? {
            timestamp: Math.floor(args.beforeTimestampMs),
            id: args.beforeId ?? "",
          }
        : null;
    const clauses = [
      "session_id = ?",
      "type IN ('agent-started', 'agent-progress', 'agent-completed', 'agent-failed', 'agent-canceled')",
    ];
    const params = [conversationId];
    if (before) {
      clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(before.timestamp, before.timestamp, before.id);
    }
    params.push(normalizedLimit);
    const rows = this.db
      .prepare(
        `
      SELECT
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        recent.request_id AS requestId,
        recent.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        recent.data_json AS channelEnvelopeJson
      FROM (
        SELECT *
        FROM message
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `,
      )
      .all(...params);
    const activities = rows.map((row) => this.deserializeEventRow(row));
    return { activities };
  }
  /**
   * File-carrying events (`tool_result` / `agent-completed` whose
   * payload has a non-empty `fileChanges` or `producedFiles` array)
   * for the conversation, ordered ASC by `(timestamp, _id)`.
   *
   * The Recent Files surfaces use this instead of scanning the full
   * event stream. The SQL pre-filter via `json_extract` +
   * `json_array_length` keeps the window genuinely scoped to events
   * that touch disk, so a `limit` of 500 buys 500 file events rather
   * than 500 arbitrary tool results that may or may not have produced
   * a file.
   *
   * Optional `beforeTimestampMs` / `beforeId` cursor pages strictly-
   * older file events for the ActivityHistoryDialog "files" section.
   */
  listFiles(conversationIdInput, args = {}) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const normalizedLimit = Math.max(1, Math.floor(args.limit ?? 500));
    const before =
      typeof args.beforeTimestampMs === "number"
        ? {
            timestamp: Math.floor(args.beforeTimestampMs),
            id: args.beforeId ?? "",
          }
        : null;
    const clauses = [
      "m.session_id = ?",
      "m.type IN ('tool_result', 'agent-completed')",
      "p.data_json IS NOT NULL",
      // `json_array_length` on a missing/non-array path returns NULL in
      // SQLite, and `NULL > 0` is `NULL` (falsy), so this naturally
      // excludes events without file changes without needing explicit
      // null guards.
      "(json_array_length(json_extract(p.data_json, '$.fileChanges')) > 0 OR json_array_length(json_extract(p.data_json, '$.producedFiles')) > 0)",
    ];
    const params = [conversationId];
    if (before) {
      clauses.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
      params.push(before.timestamp, before.timestamp, before.id);
    }
    params.push(normalizedLimit);
    const rows = this.db
      .prepare(
        `
      SELECT
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        recent.request_id AS requestId,
        recent.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        recent.data_json AS channelEnvelopeJson
      FROM (
        SELECT m.*
        FROM message m
        LEFT JOIN part p
          ON p.message_id = m.id
         AND p.ord = 0
        WHERE ${clauses.join(" AND ")}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `,
      )
      .all(...params);
    return { files: rows.map((row) => this.deserializeEventRow(row)) };
  }
  getEventCount(conversationIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM message
      WHERE session_id = ?
        AND type NOT IN ('thread_message', 'run_event', 'memory')
    `,
      )
      .get(conversationId);
    return typeof row?.count === "number" ? row.count : 0;
  }
  listSyncMessages(
    conversationIdInput,
    maxMessages = MAX_EVENTS_PER_CONVERSATION,
  ) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const normalizedLimit = Math.max(1, Math.floor(maxMessages));
    const rows = this.db
      .prepare(
        `
      SELECT
        message.id AS _id,
        message.created_at AS timestamp,
        message.type AS type,
        message.device_id AS deviceId,
        part.data_json AS payloadJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE message.session_id = ?
        AND message.type IN ('user_message', 'assistant_message')
      ORDER BY message.created_at DESC, message.id DESC
      LIMIT ?
    `,
      )
      .all(conversationId, CUTOFF_SCAN_CEILING);
    const messages = [];
    for (const row of rows) {
      const payload = parseJsonRecord(row.payloadJson);
      if (isUiHiddenChatMessagePayload(payload ?? null)) continue;
      const text = eventTextFromPayload(payload);
      if (!text) continue;
      const role = row.type === "user_message" ? "user" : "assistant";
      messages.push({
        localMessageId: row._id,
        role,
        text,
        timestamp: row.timestamp,
        ...(role === "user" && row.deviceId ? { deviceId: row.deviceId } : {}),
      });
      if (messages.length >= normalizedLimit) break;
    }
    return messages.reverse();
  }
  getSyncCheckpoint(conversationIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    return this.getSession(conversationId)?.syncCheckpointMessageId ?? null;
  }
  setSyncCheckpoint(conversationIdInput, localMessageIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const localMessageId = asTrimmedString(localMessageIdInput);
    if (!localMessageId) return;
    this.upsertSession(conversationId, Date.now());
    this.db
      .prepare(
        `
      UPDATE session
      SET sync_checkpoint_message_id = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(localMessageId, Date.now(), conversationId);
  }
  getThreadConversationId(threadKey) {
    const row = this.db
      .prepare(
        `
      SELECT conversation_id AS conversationId
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(threadKey);
    if (
      typeof row?.conversationId === "string" &&
      row.conversationId.trim().length > 0
    ) {
      return row.conversationId;
    }
    return this.ensureImplicitThreadRow(threadKey).conversationId;
  }
  getThreadSession(threadKey) {
    const row = this.db
      .prepare(
        `
      SELECT
        session_id AS sessionId,
        created_at AS createdAt,
        cwd,
        parent_session AS parentSession
      FROM runtime_thread_sessions
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(threadKey);
    return row ?? null;
  }
  ensureThreadSession(threadKey, conversationId, timestamp) {
    const existing = this.getThreadSession(threadKey);
    if (existing) {
      this.db
        .prepare(
          `
        UPDATE runtime_thread_sessions
        SET updated_at = ?
        WHERE thread_key = ?
      `,
        )
        .run(timestamp, threadKey);
      return existing;
    }
    const sessionId = generateLocalId();
    const cwd = "";
    this.upsertSession(conversationId, timestamp);
    this.db
      .prepare(
        `
      INSERT INTO runtime_thread_sessions (
        thread_key,
        session_id,
        version,
        cwd,
        parent_session,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, NULL, ?, ?)
    `,
      )
      .run(
        threadKey,
        sessionId,
        RUNTIME_THREAD_SESSION_VERSION,
        cwd,
        timestamp,
        timestamp,
      );
    return {
      sessionId,
      createdAt: timestamp,
      cwd,
      parentSession: null,
    };
  }
  getThreadLeafEntryId(threadKey) {
    const row = this.db
      .prepare(
        `
      SELECT entry_id AS entryId
      FROM runtime_thread_entries
      WHERE thread_key = ?
      ORDER BY insertion_sequence DESC, rowid DESC
      LIMIT 1
    `,
      )
      .get(threadKey);
    return typeof row?.entryId === "string" && row.entryId.trim().length > 0
      ? row.entryId
      : null;
  }
  appendThreadSessionEntry(args) {
    const entryId = generateLocalId();
    const parentEntryId = this.getThreadLeafEntryId(args.threadKey);
    const timestampIso = toIsoTimestamp(args.timestamp);
    this.db
      .prepare(
        `
      INSERT INTO runtime_thread_entries (
        entry_id,
        thread_key,
        session_id,
        parent_entry_id,
        entry_type,
        timestamp_iso,
        created_at,
        data_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        entryId,
        args.threadKey,
        args.sessionId,
        parentEntryId,
        args.entryType,
        timestampIso,
        args.timestamp,
        toJsonValueString(args.data),
      );
    if (args.exactDataJson && args.exactChunkEnds) {
      const insertChunk = this.db.prepare(
        `INSERT INTO runtime_thread_entry_payload_chunks (
           entry_id,
           thread_key,
           chunk_index,
           chunk_text
         ) VALUES (?, ?, ?, ?)`,
      );
      let offset = 0;
      for (
        let chunkIndex = 0;
        chunkIndex < args.exactChunkEnds.length;
        chunkIndex += 1
      ) {
        const end = args.exactChunkEnds[chunkIndex];
        insertChunk.run(
          entryId,
          args.threadKey,
          chunkIndex,
          args.exactDataJson.slice(offset, end),
        );
        offset = end;
      }
    }
    return entryId;
  }
  loadExactThreadEntryData(threadKey, entryIds) {
    if (entryIds && entryIds.length === 0) return new Map();
    const rows = [];
    const batches = entryIds
      ? Array.from({ length: Math.ceil(entryIds.length / 250) }, (_, index) =>
          entryIds.slice(index * 250, index * 250 + 250),
        )
      : [null];
    for (const batch of batches) {
      const entryFilter = batch
        ? ` AND chunks.entry_id IN (${batch.map(() => "?").join(", ")})`
        : "";
      rows.push(
        ...this.db
          .prepare(
            `SELECT chunks.entry_id AS entryId,
                    chunks.chunk_index AS chunkIndex,
                    chunks.chunk_text AS chunkText
             FROM runtime_thread_entry_payload_chunks chunks
             WHERE chunks.thread_key = ?${entryFilter}
             ORDER BY chunks.entry_id ASC, chunks.chunk_index ASC`,
          )
          .all(threadKey, ...(batch ?? [])),
      );
    }
    const chunksByEntryId = new Map();
    for (const row of rows) {
      if (
        typeof row.entryId !== "string" ||
        typeof row.chunkText !== "string" ||
        typeof row.chunkIndex !== "number"
      ) {
        continue;
      }
      const record = chunksByEntryId.get(row.entryId) ?? {
        chunks: [],
        contiguous: true,
      };
      if (row.chunkIndex !== record.chunks.length) {
        record.contiguous = false;
      }
      record.chunks.push(row.chunkText);
      chunksByEntryId.set(row.entryId, record);
    }
    return new Map(
      [...chunksByEntryId].map(([entryId, record]) => [
        entryId,
        {
          dataJson: record.chunks.join(""),
          chunkCount: record.chunks.length,
          contiguous: record.contiguous,
        },
      ]),
    );
  }
  parseThreadSessionEntryRows(threadKey, rows, exactDataByEntryId) {
    const exactData =
      exactDataByEntryId ??
      this.loadExactThreadEntryData(
        threadKey,
        rows
          .filter(
            (row) =>
              typeof row.dataJson === "string" &&
              row.dataJson.includes(`"${THREAD_EXACT_PAYLOAD_MARKER}"`),
          )
          .map((row) => row.entryId),
      );
    return rows
      .map((row) => {
        const exact = exactData.get(row.entryId);
        const bounded = exact ? parseJsonValue(row.dataJson) : null;
        const marker = bounded?.[THREAD_EXACT_PAYLOAD_MARKER];
        const expectedChunkCount =
          marker && typeof marker === "object"
            ? asFiniteNumber(marker.chunkCount)
            : null;
        const expectedByteLength =
          marker && typeof marker === "object"
            ? asFiniteNumber(marker.byteLength)
            : null;
        const hasCompleteExactData =
          exact?.contiguous === true &&
          expectedChunkCount === exact.chunkCount &&
          expectedByteLength === jsonByteLength(exact.dataJson);
        return parseThreadSessionEntry({
          ...row,
          dataJson: hasCompleteExactData ? exact.dataJson : row.dataJson,
        });
      })
      .filter((entry) => entry !== null);
  }
  loadThreadSessionEntries(threadKey, limit = undefined) {
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : undefined;
    const sql = `
      SELECT
        recent.entry_id AS entryId,
        recent.parent_entry_id AS parentEntryId,
        recent.entry_type AS entryType,
        recent.timestamp_iso AS timestampIso,
        recent.created_at AS createdAt,
        recent.data_json AS dataJson
      FROM (
        SELECT rowid AS entryRowId, *
        FROM runtime_thread_entries
        WHERE thread_key = ?
        ORDER BY insertion_sequence DESC, rowid DESC
        ${normalizedLimit ? "LIMIT ?" : ""}
      ) recent
      ORDER BY recent.insertion_sequence ASC, recent.entryRowId ASC
    `;
    const rows = normalizedLimit
      ? this.db.prepare(sql).all(threadKey, normalizedLimit)
      : this.db.prepare(sql).all(threadKey);
    return this.parseThreadSessionEntryRows(threadKey, rows);
  }
  findLatestRangeCompaction(threadKey) {
    const row = this.db
      .prepare(
        `
      SELECT
        compact.entry_id AS entryId,
        compact.parent_entry_id AS parentEntryId,
        compact.entry_type AS entryType,
        compact.timestamp_iso AS timestampIso,
        compact.created_at AS createdAt,
        compact.data_json AS dataJson,
        covered_from.insertion_sequence AS coveredFromSequence,
        covered_through.insertion_sequence AS coveredThroughSequence
      FROM runtime_thread_entries compact
      JOIN runtime_thread_entries covered_from
        ON covered_from.thread_key = compact.thread_key
       AND covered_from.entry_id = json_extract(compact.data_json, '$.fromEntryId')
      JOIN runtime_thread_entries covered_through
        ON covered_through.thread_key = compact.thread_key
       AND covered_through.entry_id = json_extract(compact.data_json, '$.toEntryId')
      WHERE compact.thread_key = ?
        AND compact.entry_type = 'compaction'
        AND json_type(compact.data_json, '$.fromEntryId') = 'text'
        AND json_type(compact.data_json, '$.toEntryId') = 'text'
      ORDER BY compact.insertion_sequence DESC, compact.rowid DESC
      LIMIT 1
    `,
      )
      .get(threadKey);
    const entry = row ? parseThreadSessionEntry(row) : null;
    return entry?.type === "compaction" &&
      entry.fromEntryId &&
      entry.toEntryId &&
      typeof row.coveredFromSequence === "number" &&
      typeof row.coveredThroughSequence === "number"
      ? {
          entry,
          coveredFromSequence: row.coveredFromSequence,
          coveredThroughSequence: row.coveredThroughSequence,
        }
      : null;
  }
  /**
   * Cheap compaction probe over bounded row metadata only. It never joins or
   * reconstructs `runtime_thread_entry_payload_chunks`; callers fall back to
   * full history only when a legacy/malformed active row lacks metadata.
   */
  getThreadContextPressureStats(threadKeyInput) {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const compaction = this.findLatestRangeCompaction(threadKey);
    const rangePredicate = compaction
      ? "AND (insertion_sequence < ? OR insertion_sequence > ?)"
      : "";
    const rangeArgs = compaction
      ? [compaction.coveredFromSequence, compaction.coveredThroughSequence]
      : [];
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS rowCount,
           SUM(CASE WHEN json_type(data_json, '$.${THREAD_CONTEXT_PRESSURE_MARKER}') = 'object' THEN 1 ELSE 0 END) AS knownRows,
           SUM(COALESCE(json_extract(data_json, '$.${THREAD_CONTEXT_PRESSURE_MARKER}.estimatedTokens'), 0)) AS estimatedTokens,
           SUM(COALESCE(json_extract(data_json, '$.${THREAD_CONTEXT_PRESSURE_MARKER}.imageCount'), 0)) AS imageCount,
           SUM(COALESCE(json_extract(data_json, '$.${THREAD_CONTEXT_PRESSURE_MARKER}.imageDecodedBytes'), 0)) AS imageDecodedBytes
         FROM runtime_thread_entries
         WHERE thread_key = ?
           AND entry_type IN ('message', 'custom_message')
           ${rangePredicate}`,
      )
      .get(threadKey, ...rangeArgs);
    const resolvedCoveredQuarantineKeys = new Set(
      compaction ? parseCheckpointQuarantineKeys(compaction.entry.details) : [],
    );
    const quarantineRows = this.db
      .prepare(
        `SELECT
           insertion_sequence AS insertionSequence,
           data_json AS dataJson
         FROM runtime_thread_entries
         WHERE thread_key = ?
           AND entry_type = 'custom_message'
           AND json_extract(data_json, '$.customType') = ?`,
      )
      .all(threadKey, QUARANTINE_CUSTOM_TYPE);
    let quarantineCount = 0;
    for (const quarantineRow of quarantineRows) {
      const insertionSequence = Number(quarantineRow?.insertionSequence);
      const coveredByCheckpoint =
        compaction !== null &&
        Number.isFinite(insertionSequence) &&
        insertionSequence >= compaction.coveredFromSequence &&
        insertionSequence <= compaction.coveredThroughSequence;
      if (!coveredByCheckpoint) {
        quarantineCount += 1;
        continue;
      }
      const stored = parseJsonRecord(quarantineRow?.dataJson);
      const record = parseQuarantineRecord(stored?.content);
      // A covered record is resolved only when the checkpoint explicitly says
      // its tool result was masked. Malformed or unacknowledged records remain
      // active so the full-history quarantine rebuild path still runs.
      if (!record || !resolvedCoveredQuarantineKeys.has(record.key)) {
        quarantineCount += 1;
      }
    }
    const rowCount = Number(row?.rowCount ?? 0);
    const knownRows = Number(row?.knownRows ?? 0);
    const checkpointChars = compaction
      ? compaction.entry.summary.length +
        JSON.stringify(compaction.entry.details?.imageReceipts ?? []).length
      : 0;
    return {
      complete: knownRows === rowCount,
      rowCount,
      estimatedTokens:
        Math.max(0, Number(row?.estimatedTokens ?? 0)) +
        Math.ceil(checkpointChars / 3),
      imageCount: Math.max(0, Number(row?.imageCount ?? 0)),
      imageDecodedBytes: Math.max(0, Number(row?.imageDecodedBytes ?? 0)),
      quarantineCount,
    };
  }
  loadThreadMessagesAfterCompaction(threadKey, compaction) {
    const loadRange = (predicate, sequence) =>
      this.parseThreadSessionEntryRows(
        threadKey,
        this.db
          .prepare(
            `
      SELECT
        entry_id AS entryId,
        parent_entry_id AS parentEntryId,
        entry_type AS entryType,
        timestamp_iso AS timestampIso,
        created_at AS createdAt,
        data_json AS dataJson
      FROM runtime_thread_entries
      WHERE thread_key = ?
        AND insertion_sequence ${predicate} ?
      ORDER BY insertion_sequence ASC, rowid ASC
    `,
          )
          .all(threadKey, sequence),
      );
    const headEntries = loadRange("<", compaction.coveredFromSequence);
    const tailEntries = loadRange(">", compaction.coveredThroughSequence);
    const rawHead = buildRawThreadMessages(buildThreadPathEntries(headEntries));
    const rawTail = buildRawThreadMessages(buildThreadPathEntries(tailEntries));
    const overlay = normalizeCompactionOverlay(compaction.entry, []);
    if (!overlay) return null;
    const messages = [
      ...rawHead,
      {
        entryId: overlay.id,
        threadKey: "",
        timestamp: overlay.timestamp,
        role: "assistant",
        content: formatThreadCheckpointMessage(
          overlay.summary,
          overlay.imageReceipts,
        ),
        ...(overlay.checkpointQuarantineKeys
          ? { checkpointQuarantineKeys: overlay.checkpointQuarantineKeys }
          : {}),
        ...(overlay.imageReceipts
          ? { checkpointImageReceipts: overlay.imageReceipts }
          : {}),
      },
      ...(overlay.pinnedUserInstruction
        ? [
            {
              entryId: `${overlay.id}${PINNED_INSTRUCTION_ENTRY_ID_MARKER}`,
              threadKey: "",
              timestamp: overlay.timestamp,
              role: "user",
              content: overlay.pinnedUserInstruction.text,
              payload: {
                role: "user",
                content: overlay.pinnedUserInstruction.text,
                timestamp: overlay.timestamp,
              },
            },
          ]
        : []),
      ...rawTail,
    ];
    return overlay.residentFold || overlay.replaceDerivedContext
      ? applyResidentFold(messages, overlay)
      : messages;
  }
  appendThreadMessage(message) {
    this.appendThreadMessages([message]);
  }
  appendThreadMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const threadKey = normalizeRuntimeThreadId(messages[0].threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const prepared = messages.map((message) => {
      if (normalizeRuntimeThreadId(message.threadKey) !== threadKey) {
        throw new Error(
          "All thread messages in a batch must use the same threadKey.",
        );
      }
      const fallbackPayload = buildFallbackThreadPayload(message);
      const boundedPayload = enforceThreadPayloadRowSizeLimit(fallbackPayload);
      const contextPressure = buildThreadContextPressure(fallbackPayload);
      // Image pressure must be measured from the same payload the live agent
      // can replay. Never let the 6MB row limiter silently replace image data
      // with text; automatically spill image-bearing payloads into exact
      // chunks even for non-orchestrator writers.
      const storage =
        message.preservePayloadExactly === true ||
        payloadContainsImage(fallbackPayload)
          ? chunkExactThreadEntryData(
              {
                message: fallbackPayload,
                [THREAD_CONTEXT_PRESSURE_MARKER]: contextPressure,
              },
              {
                message: boundedPayload,
                [THREAD_CONTEXT_PRESSURE_MARKER]: contextPressure,
              },
            )
          : {
              data: {
                message: boundedPayload,
                [THREAD_CONTEXT_PRESSURE_MARKER]: contextPressure,
              },
            };
      return {
        message,
        payload: fallbackPayload,
        storage,
      };
    });
    const capture = this.ephemeralThreadCaptures.get(threadKey);
    if (capture) {
      for (const { message, storage } of prepared) {
        const payload = storage.data.message;
        capture.appendedMessages.push({
          ...message,
          threadKey,
          role: payload.role,
          payload,
          entryId: `ephemeral:${capture.captureId}:${capture.appendedMessages.length}`,
        });
      }
      return;
    }
    const conversationId = this.getThreadConversationId(threadKey);
    const appended = [];
    this.withImmediateTransaction(() => {
      for (const { message, payload, storage } of prepared) {
        this.upsertSession(conversationId, message.timestamp);
        const threadSession = this.ensureThreadSession(
          threadKey,
          conversationId,
          message.timestamp,
        );
        const entryId = this.appendThreadSessionEntry({
          threadKey,
          sessionId: threadSession.sessionId,
          entryType: "message",
          timestamp: message.timestamp,
          data: storage.data,
          ...(storage.exactDataJson
            ? {
                exactDataJson: storage.exactDataJson,
                exactChunkEnds: storage.exactChunkEnds,
              }
            : {}),
        });
        appended.push({ entryId, message, payload });
      }
      this.touchThread(threadKey);
    });
    for (const { entryId, message, payload } of appended) {
      if (!entryId) continue;
      try {
        this.options.onThreadTranscriptUpdate?.({
          conversationId,
          transcriptUpdate: {
            source: "stella",
            threadId: threadKey,
            entryId,
            atMs: message.timestamp,
          },
        });
        if (payload.role === "assistant") {
          this.emitThreadAssistantUpdate(threadKey, message.timestamp);
        }
      } catch {
        // The transaction already committed. Notification failures must not
        // make the caller retry and duplicate a durably appended turn group.
      }
    }
  }

  appendThreadCustomMessage(message: {
    threadKey: string;
    timestamp: number;
    customType: string;
    content: RuntimeThreadCustomMessageEntry["content"];
    display: boolean;
    eventId?: string;
    lifecycleEvent?: RuntimeThreadCustomMessageEntry["lifecycleEvent"];
    preservePayloadExactly?: boolean;
  }): void {
    const threadKey = normalizeRuntimeThreadId(message.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const customType = message.customType.trim();
    if (!customType) {
      throw new Error("customType is required.");
    }
    const exactMessage = {
      customType,
      content: message.content,
      display: message.display,
      ...(message.eventId?.trim() ? { eventId: message.eventId.trim() } : {}),
      ...(message.lifecycleEvent
        ? { lifecycleEvent: message.lifecycleEvent }
        : {}),
    };
    const boundedMessage = enforceCustomMessageRowSizeLimit(exactMessage);
    const contextPressure = buildThreadContextPressure(exactMessage);
    const storage =
      message.preservePayloadExactly === true ||
      customMessageContainsImage(exactMessage)
        ? chunkExactThreadEntryData(
            {
              ...exactMessage,
              [THREAD_CONTEXT_PRESSURE_MARKER]: contextPressure,
            },
            {
              ...boundedMessage,
              [THREAD_CONTEXT_PRESSURE_MARKER]: contextPressure,
            },
          )
        : {
            data: {
              ...boundedMessage,
              [THREAD_CONTEXT_PRESSURE_MARKER]: contextPressure,
            },
          };
    const conversationId = this.getThreadConversationId(threadKey);
    let entryId = "";
    this.withImmediateTransaction(() => {
      this.upsertSession(conversationId, message.timestamp);
      const threadSession = this.ensureThreadSession(
        threadKey,
        conversationId,
        message.timestamp,
      );
      entryId = this.appendThreadSessionEntry({
        threadKey,
        sessionId: threadSession.sessionId,
        entryType: "custom_message",
        timestamp: message.timestamp,
        data: storage.data,
        ...(storage.exactDataJson
          ? {
              exactDataJson: storage.exactDataJson,
              exactChunkEnds: storage.exactChunkEnds,
            }
          : {}),
      });
      this.touchThread(threadKey);
    });
    // v2 does not emit a transcript update for custom-message appends (only
    // real messages and compaction); the cloud journal re-reads them.
  }
  appendThreadLifecycleEvent(message) {
    const threadKey = normalizeRuntimeThreadId(message.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const event = parseStoredThreadLifecycleEvent(message.event);
    if (!event) {
      throw new Error("A valid lifecycle event is required.");
    }
    const conversationId = this.getThreadConversationId(threadKey);
    this.withImmediateTransaction(() => {
      this.upsertSession(conversationId, event.timestamp);
      const threadSession = this.ensureThreadSession(
        threadKey,
        conversationId,
        event.timestamp,
      );
      this.appendThreadSessionEntry({
        threadKey,
        sessionId: threadSession.sessionId,
        entryType: "lifecycle_event",
        timestamp: event.timestamp,
        data: { event },
      });
      this.touchThread(threadKey);
    });
  }
  hasThreadLifecycleEvent(threadKeyInput, eventIdInput) {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    const eventId = asTrimmedString(eventIdInput);
    if (!threadKey || !eventId) {
      return false;
    }
    const row = this.db
      .prepare(
        `
      SELECT 1 AS present
      FROM runtime_thread_entries
      WHERE thread_key = ?
        AND entry_type = 'lifecycle_event'
        AND json_extract(data_json, '$.event._id') = ?
      LIMIT 1
    `,
      )
      .get(threadKey, eventId);
    return Boolean(row);
  }
  listThreadLifecycleEntries(threadKeyInput, limit = 300) {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const normalizedLimit = Math.min(
      500,
      Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 300)),
    );
    const rows = this.db
      .prepare(
        `
      SELECT entry_id AS entryId, data_json AS dataJson
      FROM (
        SELECT entry_id, data_json, insertion_sequence, rowid
        FROM runtime_thread_entries
        WHERE thread_key = ? AND entry_type = 'lifecycle_event'
        ORDER BY insertion_sequence DESC, rowid DESC
        LIMIT ?
      ) recent
      ORDER BY insertion_sequence ASC, rowid ASC
    `,
      )
      .all(threadKey, normalizedLimit);
    return rows.flatMap((row) => {
      const data = parseJsonValue(row.dataJson);
      const event = parseStoredThreadLifecycleEvent(data?.event);
      return event ? [{ entryId: row.entryId, event }] : [];
    });
  }
  loadThreadMessages(threadKeyInput, limit?) {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const capture = this.ephemeralThreadCaptures.get(threadKey);
    const latestCompaction =
      capture || limit ? null : this.findLatestRangeCompaction(threadKey);
    const messages = capture
      ? [...capture.seedMessages, ...capture.appendedMessages]
      : latestCompaction
        ? this.loadThreadMessagesAfterCompaction(threadKey, latestCompaction)
        : buildThreadMessagesFromEntries(
            this.loadThreadSessionEntries(threadKey, limit),
          );
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : undefined;
    return (normalizedLimit ? messages.slice(-normalizedLimit) : messages).map(
      (message) => ({
        ...(message.entryId ? { entryId: message.entryId } : {}),
        timestamp: message.timestamp,
        role: message.role,
        content: message.content,
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.payload ? { payload: message.payload } : {}),
        ...(message.customMessage
          ? { customMessage: message.customMessage }
          : {}),
        ...(message.checkpointQuarantineKeys
          ? {
              checkpointQuarantineKeys: message.checkpointQuarantineKeys,
            }
          : {}),
        ...(message.checkpointImageReceipts
          ? { checkpointImageReceipts: message.checkpointImageReceipts }
          : {}),
      }),
    );
  }

  /**
   * Raw durable projection for exact transcript consumers. Compaction
   * checkpoints/overlays are intentionally absent: buildRawThreadMessages
   * projects only message/custom-message entries from the authoritative
   * parent chain. The limit applies after projection so display-only storage
   * rows cannot crowd authored messages out of the window.
   */
  loadRawThreadMessagesWithEntryTypes(
    threadKeyInput: string,
    limit?: number,
  ): Array<RuntimeThreadMessage & { entryId: string }> {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) throw new Error("threadKey is required.");
    const capture = this.ephemeralThreadCaptures.get(threadKey);
    const raw = capture
      ? [...capture.seedMessages, ...capture.appendedMessages]
      : buildRawThreadMessages(
          buildThreadPathEntries(this.loadThreadSessionEntries(threadKey)),
        );
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : undefined;
    return normalizedLimit ? raw.slice(-normalizedLimit) : raw;
  }

  beginEphemeralThreadCapture(args: {
    threadKey: string;
    captureId: string;
    seedMessages?: Array<{
      timestamp?: number;
      role: string;
      content: string;
      toolCallId?: string;
      payload?: RuntimeThreadMessage["payload"];
      customMessage?: RuntimeThreadMessage["customMessage"];
    }>;
  }): void {
    const threadKey = normalizeRuntimeThreadId(args.threadKey);
    const captureId = args.captureId.trim();
    if (!threadKey || !captureId) {
      throw new Error("threadKey and captureId are required.");
    }
    const existing = this.ephemeralThreadCaptures.get(threadKey);
    if (existing && existing.captureId !== captureId) {
      throw new Error("A different ephemeral thread capture is active.");
    }
    if (existing) return;
    const seedMessages = (args.seedMessages ?? []).map((message, index) => {
      if (
        message.role !== "user" &&
        message.role !== "assistant" &&
        message.role !== "toolResult" &&
        message.role !== "runtimeInternal"
      ) {
        throw new Error("Ephemeral thread capture seed has an invalid role.");
      }
      const role = message.role as RuntimeThreadMessage["role"];
      return {
        threadKey,
        entryId: `ephemeral:${captureId}:seed:${index}`,
        timestamp:
          typeof message.timestamp === "number" &&
          Number.isFinite(message.timestamp)
            ? message.timestamp
            : 0,
        role,
        content: message.content,
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.payload ? { payload: message.payload } : {}),
        ...(message.customMessage
          ? { customMessage: message.customMessage }
          : {}),
      };
    });
    this.ephemeralThreadCaptures.set(threadKey, {
      captureId,
      seedMessages,
      appendedMessages: [],
    });
  }

  readEphemeralThreadCapture(args: {
    threadKey: string;
    captureId: string;
  }): Array<RuntimeThreadMessage & { entryId: string }> {
    const threadKey = normalizeRuntimeThreadId(args.threadKey);
    const capture = threadKey
      ? this.ephemeralThreadCaptures.get(threadKey)
      : undefined;
    if (!capture || capture.captureId !== args.captureId) {
      throw new Error("Ephemeral thread capture is not active.");
    }
    return capture.appendedMessages.map((message) => ({ ...message }));
  }

  endEphemeralThreadCapture(args: {
    threadKey: string;
    captureId: string;
  }): void {
    const threadKey = normalizeRuntimeThreadId(args.threadKey);
    const capture = threadKey
      ? this.ephemeralThreadCaptures.get(threadKey)
      : undefined;
    if (!capture) return;
    if (capture.captureId !== args.captureId) {
      throw new Error("Ephemeral thread capture belongs to another run.");
    }
    this.ephemeralThreadCaptures.delete(threadKey!);
  }

  getThreadEntryInsertionSequenceWatermark(threadKeyInput: string): number {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) throw new Error("threadKey is required.");
    const row = this.db
      .prepare(
        `
        SELECT MAX(insertion_sequence) AS watermark
        FROM runtime_thread_entries
        WHERE thread_key = ?
      `,
      )
      .get(threadKey) as { watermark?: unknown } | undefined;
    return typeof row?.watermark === "number" ? row.watermark : 0;
  }

  /**
   * Reads only entries appended after a durable insertion boundary. Cloud
   * transcript finalization uses this suffix instead of rescanning and
   * serializing the entire local thread on every turn.
   */
  loadRawThreadMessagesAfterInsertionSequence(
    threadKeyInput: string,
    afterInsertionSequence: number,
  ): Array<RuntimeThreadMessage & { entryId: string }> {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) throw new Error("threadKey is required.");
    const normalizedBoundary =
      Number.isFinite(afterInsertionSequence) && afterInsertionSequence >= 0
        ? Math.floor(afterInsertionSequence)
        : 0;
    const rows = this.db
      .prepare(
        `
        SELECT
          entry_id AS entryId,
          parent_entry_id AS parentEntryId,
          entry_type AS entryType,
          timestamp_iso AS timestampIso,
          created_at AS createdAt,
          data_json AS dataJson
        FROM runtime_thread_entries
        WHERE thread_key = ?
          AND insertion_sequence > ?
        ORDER BY insertion_sequence ASC, rowid ASC
      `,
      )
      .all(threadKey, normalizedBoundary) as ThreadSessionEntryRow[];
    const entries = rows
      .map((row) => parseThreadSessionEntry(row))
      .filter((entry): entry is RuntimeThreadSessionEntry => entry !== null);
    return buildRawThreadMessages(entries);
  }

  /** Exact-thread UI reads the original typed entries, not the compaction
   * overlay used to rebuild model context. The latter deliberately flattens
   * tool transport into a text checkpoint, which loses the block semantics
   * the read-only transcript needs to distinguish authored prose from tools. */
  loadRawThreadMessages(
    threadKey: string,
    limit?: number,
  ): Array<RuntimeThreadMessage & { entryId: string }> {
    return buildRawThreadMessages(
      buildThreadPathEntries(this.loadThreadSessionEntries(threadKey, limit)),
    );
  }

  /** Claude Code persists agent-management calls as typed Anthropic tool
   * blocks plus a typed JSON tool result. Project only the successful
   * spawn/follow-up pairs into lifecycle starts; every other generic tool
   * remains transport and is omitted from the read-only transcript. */
  private projectClaudeTaskStarts(
    messages: ReadonlyArray<RuntimeThreadMessage & { entryId: string }>,
  ): Map<string, EventRecord[]> {
    const startKey = (agentId: string, isFollowUp: boolean) =>
      `${agentId}\u001f${isFollowUp ? "follow-up" : "spawn"}`;
    const calls = new Map<
      string,
      {
        entryId: string;
        timestamp: number;
        name: "spawn_agent" | "spawn_manager" | "send_input";
        arguments: Record<string, unknown>;
      }
    >();
    const privateStartBudget = new Map<string, number>();
    const startsByEntryId = new Map<string, EventRecord[]>();
    for (const message of messages) {
      const privateLifecycle = message.customMessage?.lifecycleEvent;
      if (
        message.customMessage?.customType ===
          RUNTIME_PRIVATE_TASK_LIFECYCLE_CUSTOM_TYPE &&
        privateLifecycle?.type === "agent-started"
      ) {
        const agentId = asTrimmedString(privateLifecycle.payload.agentId);
        if (agentId) {
          const key = startKey(
            agentId,
            privateLifecycle.payload.isFollowUp === true,
          );
          privateStartBudget.set(key, (privateStartBudget.get(key) ?? 0) + 1);
        }
        continue;
      }
      const payload = message.payload;
      if (payload?.role === "assistant") {
        for (const block of payload.content) {
          if (
            block.type !== "toolCall" ||
            (block.name !== "spawn_agent" &&
              block.name !== "spawn_manager" &&
              block.name !== "send_input")
          ) {
            continue;
          }
          calls.set(block.id, {
            entryId: message.entryId,
            timestamp: message.timestamp,
            name: block.name,
            arguments: block.arguments ?? {},
          });
        }
        continue;
      }
      if (payload?.role !== "toolResult") continue;
      const call = calls.get(payload.toolCallId);
      const result = structuredToolResultObject(payload);
      if (!call || !result) continue;
      const agentId =
        asTrimmedString(result.thread_id) ||
        asTrimmedString(call.arguments.thread_id);
      if (!agentId) continue;
      const key = startKey(agentId, call.name === "send_input");
      const privateStarts = privateStartBudget.get(key) ?? 0;
      if (privateStarts > 0) {
        privateStartBudget.set(key, privateStarts - 1);
        continue;
      }
      const record = this.getAgentRecord(agentId);
      const description =
        asTrimmedString(call.arguments.description) ||
        record?.description ||
        "Task";
      const group = this.getThreadGroup(agentId);
      const event: EventRecord = {
        _id: `thread-tool:${call.entryId}:${payload.toolCallId}:agent-started`,
        timestamp: call.timestamp,
        type: "agent-started",
        payload: {
          agentId,
          description,
          agentType:
            record?.agentType ??
            (call.name === "spawn_manager"
              ? AGENT_IDS.MANAGER
              : AGENT_IDS.GENERAL),
          ...(call.name === "send_input"
            ? { isFollowUp: true, statusText: description }
            : {}),
          ...(group?.groupKey ? { groupKey: group.groupKey } : {}),
          ...(group?.groupLabel ? { groupLabel: group.groupLabel } : {}),
        },
      };
      const bucket = startsByEntryId.get(call.entryId);
      if (bucket) bucket.push(event);
      else startsByEntryId.set(call.entryId, [event]);
    }
    return startsByEntryId;
  }

  private applyThreadCustomMessageMutationLocked(
    threadKey: string,
    mutation: RuntimeThreadCustomMessageMutation,
  ): void {
    const row = this.db
      .prepare(
        `SELECT data_json AS dataJson, parent_entry_id AS parentEntryId
         FROM runtime_thread_entries
         WHERE thread_key = ? AND entry_id = ? AND entry_type = 'custom_message'
         LIMIT 1`,
      )
      .get(threadKey, mutation.entryId) as
      | { dataJson?: string | null; parentEntryId?: string | null }
      | undefined;
    if (!row) {
      throw new Error(
        `Resident startup-doc compaction plan lost entry ${mutation.entryId}.`,
      );
    }
    const data = parseJsonValue<Record<string, unknown>>(row.dataJson ?? null);
    const customType =
      typeof data?.customType === "string" ? data.customType.trim() : "";
    const currentContent = data?.content;
    if (
      customType !== mutation.expectedCustomType ||
      !isUserContent(currentContent) ||
      JSON.stringify(currentContent) !==
        JSON.stringify(mutation.expectedContent)
    ) {
      throw new Error(
        `Resident startup-doc entry ${mutation.entryId} changed after its compaction plan was built.`,
      );
    }
    if (mutation.action === "remove") {
      this.db
        .prepare(
          `UPDATE runtime_thread_entries
           SET parent_entry_id = ?
           WHERE thread_key = ? AND parent_entry_id = ?`,
        )
        .run(row.parentEntryId ?? null, threadKey, mutation.entryId);
      const result = this.db
        .prepare(
          `DELETE FROM runtime_thread_entries
           WHERE thread_key = ? AND entry_id = ? AND entry_type = 'custom_message'`,
        )
        .run(threadKey, mutation.entryId) as
        | { changes?: number | bigint }
        | undefined;
      if (Number(result?.changes ?? 0) !== 1) {
        throw new Error(
          `Resident startup-doc removal did not affect exactly one row: ${mutation.entryId}.`,
        );
      }
      return;
    }

    const eventId =
      typeof data?.eventId === "string" && data.eventId.trim()
        ? data.eventId.trim()
        : undefined;
    const rawLifecycleEvent = asObject(data?.lifecycleEvent);
    const lifecycleType = asTrimmedString(rawLifecycleEvent?.type);
    const lifecyclePayload = asObject(rawLifecycleEvent?.payload);
    const lifecycleEvent =
      isThreadLifecycleEventType(lifecycleType) &&
      asTrimmedString(lifecyclePayload?.agentId)
        ? {
            type: lifecycleType,
            payload: lifecyclePayload as Record<string, unknown>,
          }
        : undefined;
    const boundedMessage = enforceCustomMessageRowSizeLimit({
      customType,
      content: mutation.content,
      display: data?.display === true,
      ...(eventId ? { eventId } : {}),
      ...(lifecycleEvent ? { lifecycleEvent } : {}),
    });
    const result = this.db
      .prepare(
        `UPDATE runtime_thread_entries
         SET data_json = ?
         WHERE thread_key = ? AND entry_id = ? AND entry_type = 'custom_message'`,
      )
      .run(
        toJsonValueString({
          customType: boundedMessage.customType,
          content: boundedMessage.content,
          display: boundedMessage.display,
          ...(boundedMessage.eventId
            ? { eventId: boundedMessage.eventId }
            : {}),
          ...(boundedMessage.lifecycleEvent
            ? { lifecycleEvent: boundedMessage.lifecycleEvent }
            : {}),
        }),
        threadKey,
        mutation.entryId,
      ) as { changes?: number | bigint } | undefined;
    if (Number(result?.changes ?? 0) !== 1) {
      throw new Error(
        `Resident startup-doc replacement did not affect exactly one row: ${mutation.entryId}.`,
      );
    }
  }
  /**
   * Newest-first sample of recent user-role messages in a thread. Used by
   * write-time transcript decoration (`agent-runtime/transcript-decoration.js`)
   * to decide whether a freshly persisted user message needs a timestamp tag —
   * the same thirty-minute suppression window the retired local-events history
   * projection applied. Content is returned so callers can skip user-role rows
   * that are not actual user utterances (e.g. voice tool results persisted with
   * role "user" and a "[Tool result]" prefix).
   */
  listRecentThreadUserMessages(threadKeyInput, limit = 8) {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      return [];
    }
    const normalizedLimit = Math.min(50, Math.max(1, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `
      SELECT created_at AS createdAt, data_json AS dataJson
      FROM runtime_thread_entries
      WHERE thread_key = ?
        AND entry_type = 'message'
        AND json_extract(data_json, '$.message.role') = 'user'
      ORDER BY insertion_sequence DESC, rowid DESC
      LIMIT ?
    `,
      )
      .all(threadKey, normalizedLimit);
    const results = [];
    for (const row of rows) {
      const timestamp = Number(row.createdAt);
      if (!Number.isFinite(timestamp)) {
        continue;
      }
      let content = "";
      try {
        const parsed = JSON.parse(row.dataJson);
        const rawContent = parsed?.message?.content;
        if (typeof rawContent === "string") {
          content = rawContent;
        }
      } catch {
        // Malformed rows simply don't inform tagging.
      }
      results.push({ content, timestamp });
    }
    return results;
  }

  compactThread(args: {
    threadKey: string;
    summary: string;
    fromEntryId?: string;
    toEntryId?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    /** Exact inputs used for runtime summary acceptance. */
    summaryValidation?: {
      middleTokens: number;
      previousSummary?: string;
    };
    timestamp?: number;
    details?: unknown;
    fromHook?: boolean;
    residentStartupDocMutations?: readonly RuntimeThreadCustomMessageMutation[];
  }): void {
    const threadKey = normalizeRuntimeThreadId(args.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    // Cloud history is compacted by the Durable Object's bounded canonical
    // window. A background compaction scheduled during an ephemeral cloud turn
    // must never persist a summary of that cloud-only history into SQLite.
    if (this.ephemeralThreadCaptures.has(threadKey)) return;
    const summary = args.summary.trim();
    const fromEntryId = args.fromEntryId?.trim();
    const toEntryId = args.toEntryId?.trim();
    const firstKeptEntryId = args.firstKeptEntryId?.trim();
    if (!summary || (!(fromEntryId && toEntryId) && !firstKeptEntryId)) {
      throw new Error("summary and a compaction range are required.");
    }
    const timestamp = asFiniteNumber(args.timestamp) ?? Date.now();
    const residentStartupDocMutations = [
      ...(args.residentStartupDocMutations ?? []),
    ];
    const mutationEntryIds = new Set<string>();
    for (const mutation of residentStartupDocMutations) {
      const entryId = mutation.entryId.trim();
      if (!entryId || mutationEntryIds.has(entryId)) {
        throw new Error(
          "Resident startup-doc compaction plan must contain unique non-empty entry ids.",
        );
      }
      mutationEntryIds.add(entryId);
    }
    if (
      args.summaryValidation &&
      (!Number.isFinite(args.summaryValidation.middleTokens) ||
        !Number.isSafeInteger(args.summaryValidation.middleTokens) ||
        args.summaryValidation.middleTokens < 0)
    ) {
      throw new Error(
        "summaryValidation.middleTokens must be a finite non-negative safe integer.",
      );
    }
    const conversationId = this.getThreadConversationId(threadKey);
    let entryId = "";
    this.withImmediateTransaction(() => {
      const latestRangeCompaction = this.findLatestRangeCompaction(threadKey);
      const normalizedFromEntryId =
        latestRangeCompaction?.entry.fromEntryId ?? fromEntryId;
      const threadSession = this.ensureThreadSession(
        threadKey,
        conversationId,
        timestamp,
      );
      entryId = this.appendThreadSessionEntry({
        threadKey,
        sessionId: threadSession.sessionId,
        entryType: "compaction",
        timestamp,
        data: {
          summary,
          ...(normalizedFromEntryId && toEntryId
            ? {
                fromEntryId: normalizedFromEntryId,
                toEntryId,
              }
            : {}),
          ...(normalizedFromEntryId || toEntryId ? {} : { firstKeptEntryId }),
          tokensBefore: Math.max(0, Math.floor(args.tokensBefore)),
          ...(args.summaryValidation
            ? {
                summaryValidation: {
                  version: 1,
                  middleTokens: args.summaryValidation.middleTokens,
                  previousSummary:
                    args.summaryValidation.previousSummary ?? null,
                },
              }
            : {}),
          ...(args.details !== undefined ? { details: args.details } : {}),
          ...(args.fromHook ? { fromHook: true } : {}),
        },
      });
      for (const mutation of residentStartupDocMutations) {
        this.applyThreadCustomMessageMutationLocked(threadKey, mutation);
      }
      this.touchThread(threadKey);
    });
    // Single source-tagged transcript update for the cloud journal (nested
    // `transcriptUpdate` shape); the legacy flat emit is retired.
    if (entryId) {
      this.options.onThreadTranscriptUpdate?.({
        conversationId,
        transcriptUpdate: {
          source: "stella",
          threadId: threadKey,
          entryId,
          atMs: timestamp,
        },
      });
    }
  }
  /**
   * Delete a single trailing thread-message entry by id. Used by context-overflow
   * recovery to drop the content-less failed-overflow assistant marker so the forced
   * compaction preserves the real resume anchor (the tool result / user turn it
   * followed) instead of spending its tail budget on the marker. Only removes a leaf
   * entry (nothing references it as a parent) so the parent chain and the next
   * append's parent link stay consistent under concurrent writers. Returns true when
   * a row was removed.
   */
  removeThreadMessageEntry(threadKeyInput, entryIdInput) {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    const entryId = typeof entryIdInput === "string" ? entryIdInput.trim() : "";
    if (!threadKey || !entryId) {
      return false;
    }
    let removed = 0;
    this.withImmediateTransaction(() => {
      const deleteResult = this.db
        .prepare(
          `DELETE FROM runtime_thread_entries
             WHERE thread_key = ?
               AND entry_id = ?
               AND entry_type = 'message'
               AND NOT EXISTS (
                 SELECT 1 FROM runtime_thread_entries child
                 WHERE child.thread_key = ?
                   AND child.parent_entry_id = ?
               )`,
        )
        .run(threadKey, entryId, threadKey, entryId);
      removed = deleteResult?.changes ?? 0;
      if (removed > 0) {
        this.touchThread(threadKey);
      }
    });
    return removed > 0;
  }

  recordRunEvent(event) {
    const messageId = `run:${event.runId}:${event.seq ?? generateLocalId()}`;
    this.withTransaction(() => {
      this.upsertSession(event.conversationId, event.timestamp);
      this.db
        .prepare(
          `
        INSERT INTO message (
          id,
          session_id,
          thread_key,
          run_id,
          role,
          type,
          request_id,
          device_id,
          target_device_id,
          agent_type,
          data_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, NULL, ?, 'system', 'run_event', NULL, NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_id = excluded.session_id,
          run_id = excluded.run_id,
          agent_type = excluded.agent_type,
          data_json = excluded.data_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
        )
        .run(
          messageId,
          event.conversationId,
          event.runId,
          event.agentType,
          toJsonString({
            eventType: event.type,
            ...(event.seq == null ? {} : { seq: event.seq }),
          }),
          event.timestamp,
          event.timestamp,
        );
      this.replaceMessageParts(messageId, event.conversationId, [
        {
          type: "run_event",
          toolCallId: event.toolCallId,
          data: event,
          createdAt: event.timestamp,
        },
      ]);
    });
  }
  deserializeRuntimeThread(row) {
    return {
      threadId: row.threadId,
      conversationId: row.conversationId,
      name: row.name,
      agentType: row.agentType,
      status: row.status,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      ...(row.agentStatus ? { agentStatus: row.agentStatus } : {}),
      ...(typeof row.agentUpdatedAt === "number"
        ? { agentUpdatedAt: row.agentUpdatedAt }
        : {}),
      ...(row.description ? { description: row.description } : {}),
      ...(row.summary ? { summary: row.summary } : {}),
    };
  }
  static RUNTIME_THREAD_SELECT = `
      SELECT
        thread_key AS threadId,
        runtime_threads.conversation_id AS conversationId,
        runtime_threads.name AS name,
        runtime_threads.agent_type AS agentType,
        runtime_threads.status AS status,
        runtime_threads.created_at AS createdAt,
        runtime_threads.last_used_at AS lastUsedAt,
        runtime_threads.summary AS summary,
        runtime_agents.description AS description,
        runtime_agents.status AS agentStatus,
        runtime_agents.updated_at AS agentUpdatedAt
      FROM runtime_threads
      LEFT JOIN runtime_agents
        ON runtime_agents.thread_id = runtime_threads.thread_key
  `;
  listActiveThreads(conversationId) {
    // Active-thread eviction keeps this query bounded to the same cap.
    const rows = this.db
      .prepare(
        `
      ${SessionStore.RUNTIME_THREAD_SELECT}
      WHERE runtime_threads.conversation_id = ?
        AND runtime_threads.status = 'active'
      ORDER BY runtime_threads.last_used_at DESC
      LIMIT ?
    `,
      )
      .all(conversationId, MAX_ACTIVE_RUNTIME_THREADS);
    return rows.map((row) => this.deserializeRuntimeThread(row));
  }
  /**
   * Search EVERY delegated agent thread across ALL conversations —
   * including evicted ones — by key, name, summary, group label, and
   * agent description. Results from `conversationId` (the caller's
   * current conversation) sort ahead of other conversations' threads;
   * the record's own `conversationId` lets callers label which scope a
   * hit came from. A result must match at least one token and ranks by
   * how many tokens it matches (ties break newest-first). Strict AND
   * would make the verbose natural-language queries an LLM writes ("the
   * flight comparison from last week") return nothing — the one failure
   * this tool exists to prevent — so stopwords are dropped up front and
   * the rest is scored, not filtered. No query returns the most recent
   * work first. Orchestrator threads are excluded (they are the
   * conversations themselves, not work — transcript content is
   * `searchTranscripts`' job).
   *
   * Matching is backed by the `thread_search_fts` FTS5 index (see
   * database-init) so the lookup scales with match count instead of total
   * thread history, porter stemming matches word forms ("deploys" ~
   * "deploy"), and — the main quality win — the agent's final
   * `result`/`error` text is searchable, which no LIKE column ever was.
   * Missing or broken FTS is a surfaced retrieval failure. The LIKE scan is
   * available only when a caller deliberately opts into degraded mode.
   */
  searchThreads(args: {
    conversationId: string;
    query?: string;
    limit?: number;
    degradedMode?: "like";
  }): RuntimeThreadRecord[] {
    const limit = Math.max(1, Math.min(25, Math.floor(args.limit ?? 12)));
    const tokens = tokenizeSearchQuery(args.query);
    // No tokens means "most recent work" — a pure recency read of the base
    // table that the FTS index (matching only) has nothing to add to.
    if (tokens.length === 0) {
      return this.searchThreadsLike(args.conversationId, tokens, limit);
    }
    if (args.degradedMode === "like") {
      console.warn(
        "[stella:recall:fts-degraded]",
        JSON.stringify({ index: "threads", reason: "explicit LIKE mode" }),
      );
      return this.searchThreadsLike(args.conversationId, tokens, limit);
    }
    if (!this.threadFtsAvailable()) {
      return throwFtsSearchUnavailable("threads", "index table is missing");
    }
    try {
      return this.searchThreadsFts(args.conversationId, tokens, limit);
    } catch (error) {
      return throwFtsSearchUnavailable("threads", "MATCH query failed", error);
    }
  }
  hasThreadFts: boolean | undefined;
  threadFtsAvailable() {
    if (this.hasThreadFts === undefined) {
      try {
        this.hasThreadFts = Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_search_fts'",
            )
            .get(),
        );
      } catch {
        this.hasThreadFts = false;
      }
    }
    return this.hasThreadFts;
  }
  /**
   * Two-step FTS search: the index answers WHICH threads match, the base
   * tables answer everything else. Step 1 collects candidate thread keys
   * via MATCH; step 2 re-runs the exact LIKE-scan query shape over just
   * those candidates — same eligibility clauses, same ORDER BY (scope,
   * per-token LIKE match count, recency) — so ranking semantics are
   * byte-identical to the fallback. Stemmed-only hits (which the LIKE
   * CASEs score 0) rank after literal matches within their scope, ties
   * newest-first.
   */
  searchThreadsFts(conversationId, tokens, limit) {
    // Each token becomes a quoted FTS phrase (quoting neutralizes MATCH
    // operators in user text), OR'd to keep the any-token-matches semantics.
    const matchQuery = tokens
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(" OR ");
    const candidates = this.db
      .prepare(
        `
      SELECT thread_key AS threadKey
      FROM thread_search_fts
      WHERE thread_search_fts MATCH ?
      ORDER BY rank
      LIMIT ${THREAD_SEARCH_FTS_CANDIDATE_CAP}
    `,
      )
      .all(matchQuery);
    if (candidates.length === 0) return [];
    const candidateKeys = candidates.map((row) => row.threadKey);
    const escapeLike = (value) => value.replace(/([\\%_])/g, "\\$1");
    const tokenClause = `(
        thread_key LIKE ? ESCAPE '\\'
        OR runtime_threads.name LIKE ? ESCAPE '\\'
        OR runtime_threads.summary LIKE ? ESCAPE '\\'
        OR runtime_agents.description LIKE ? ESCAPE '\\'
      )`;
    // The index already enforced eligibility at write time, but the clauses
    // stay here so a stale index row can never resurrect an excluded thread.
    const where = [
      "runtime_threads.agent_type != 'orchestrator'",
      "thread_key != ?",
      "thread_key NOT LIKE '%::subagent::%'",
      `thread_key IN (${candidateKeys.map(() => "?").join(", ")})`,
    ].join("\n        AND ");
    const orderBy = `(runtime_threads.conversation_id = ?) DESC,
      (${tokens
        .map(() => `CASE WHEN ${tokenClause} THEN 1 ELSE 0 END`)
        .join(" + ")}) DESC,
      runtime_threads.last_used_at DESC`;
    const params = [conversationId, ...candidateKeys, conversationId];
    for (const token of tokens) {
      const pattern = `%${escapeLike(token)}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `
      ${SessionStore.RUNTIME_THREAD_SELECT}
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ?
    `,
      )
      .all(...params);
    return rows.map((row) => this.deserializeRuntimeThread(row));
  }
  searchThreadsLike(conversationId, tokens, limit) {
    const escapeLike = (value) => value.replace(/([\\%_])/g, "\\$1");
    const tokenClause = `(
        thread_key LIKE ? ESCAPE '\\'
        OR runtime_threads.name LIKE ? ESCAPE '\\'
        OR runtime_threads.summary LIKE ? ESCAPE '\\'
        OR runtime_agents.description LIKE ? ESCAPE '\\'
      )`;
    const where = [
      "runtime_threads.agent_type != 'orchestrator'",
      "thread_key != ?",
      // Implicit transcript rows (ephemeral workflow agents, internal
      // subagent sessions) are not orchestrator-resumable work — offering
      // them as results would hand the model dead "resumable" ids.
      "thread_key NOT LIKE '%::subagent::%'",
      ...(tokens.length > 0
        ? [`(${tokens.map(() => tokenClause).join("\n        OR ")})`]
        : []),
    ].join("\n        AND ");
    // Current-conversation hits outrank other conversations' regardless of
    // token score — the caller almost always means "my work" first, and the
    // cross-conversation tail is the fallback.
    const scopeOrder = `(runtime_threads.conversation_id = ?) DESC`;
    const orderBy =
      tokens.length > 0
        ? `${scopeOrder},
      (${tokens
        .map(() => `CASE WHEN ${tokenClause} THEN 1 ELSE 0 END`)
        .join(" + ")}) DESC,
      runtime_threads.last_used_at DESC`
        : `${scopeOrder},
      runtime_threads.last_used_at DESC`;
    const params = [conversationId];
    const pushTokenParams = () => {
      for (const token of tokens) {
        const pattern = `%${escapeLike(token)}%`;
        params.push(pattern, pattern, pattern, pattern);
      }
    };
    pushTokenParams(); // WHERE token binds,
    params.push(conversationId); // then the ORDER BY scope bind,
    pushTokenParams(); // then ORDER BY rebinds the same patterns.
    params.push(limit);
    const rows = this.db
      .prepare(
        `
      ${SessionStore.RUNTIME_THREAD_SELECT}
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ?
    `,
      )
      .all(...params);
    return rows.map((row) => this.deserializeRuntimeThread(row));
  }
  /**
   * Final result/error excerpts for a set of threads, keyed by thread id.
   * Recall's thread search renders these because `summary` is empty on
   * nearly every real thread — the agent's final `result` is the only
   * durable record of what a finished thread actually did.
   */
  listThreadResultExcerpts(threadIds) {
    const ids = [...new Set(threadIds)].slice(0, 64);
    const map = new Map();
    if (ids.length === 0) return map;
    const rows = this.db
      .prepare(
        `
      SELECT
        thread_id AS threadId,
        substr(result, 1, ${RECALL_THREAD_RESULT_EXCERPT_CHARS}) AS resultExcerpt,
        substr(error, 1, ${RECALL_THREAD_ERROR_EXCERPT_CHARS}) AS errorExcerpt
      FROM runtime_agents
      WHERE thread_id IN (${ids.map(() => "?").join(", ")})
    `,
      )
      .all(...ids);
    for (const row of rows) {
      map.set(row.threadId, {
        ...(row.resultExcerpt?.trim()
          ? { resultExcerpt: row.resultExcerpt }
          : {}),
        ...(row.errorExcerpt?.trim() ? { errorExcerpt: row.errorExcerpt } : {}),
      });
    }
    return map;
  }
  /**
   * Search what was actually SAID in chat: user/assistant message text
   * across ALL conversations (not just the caller's). This is the only
   * durable index over things the user merely mentioned in conversation —
   * no delegated result required — so it is what answers episodic
   * questions ("did I ever tell you…", "where did we…"). Same
   * OR-with-ranking token semantics as `searchThreads`: a hit must match
   * at least one non-stopword token, ranks by how many tokens it matches,
   * ties break newest-first. Matching runs against the extracted `$.text`
   * of each chat payload, never the raw JSON, so attachments/base64 and
   * metadata cannot produce false hits.
   *
   * Backed by the `message_text_fts` FTS5 index (see database-init) so the
   * lookup scales with match count, not history size, and porter stemming
   * matches word forms ("drive" ~ "drives"). Missing or broken FTS is a
   * surfaced retrieval failure; LIKE requires an explicit degraded-mode opt-in.
   */
  searchTranscripts(args: {
    query: string;
    limit?: number;
    degradedMode?: "like";
  }): TranscriptSearchHit[] {
    const limit = Math.max(1, Math.min(25, Math.floor(args.limit ?? 12)));
    const tokens = tokenizeSearchQuery(args.query);
    if (tokens.length === 0) return [];
    if (args.degradedMode === "like") {
      console.warn(
        "[stella:recall:fts-degraded]",
        JSON.stringify({ index: "transcripts", reason: "explicit LIKE mode" }),
      );
      return this.searchTranscriptsLike(tokens, limit);
    }
    if (!this.transcriptFtsAvailable()) {
      return throwFtsSearchUnavailable("transcripts", "index table is missing");
    }
    try {
      return this.searchTranscriptsFts(tokens, limit);
    } catch (error) {
      return throwFtsSearchUnavailable(
        "transcripts",
        "MATCH query failed",
        error,
      );
    }
  }
  hasTranscriptFts: boolean | undefined;
  transcriptFtsAvailable() {
    if (this.hasTranscriptFts === undefined) {
      try {
        this.hasTranscriptFts = Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_text_fts'",
            )
            .get(),
        );
      } catch {
        this.hasTranscriptFts = false;
      }
    }
    return this.hasTranscriptFts;
  }
  searchTranscriptsFts(tokens, limit) {
    // Each token becomes a quoted FTS phrase (quoting neutralizes MATCH
    // operators in user text), OR'd to keep the any-token-matches
    // semantics. The matched-token count for RANKING is computed with the
    // same LIKE test the scan used — but only over the FTS matches, never
    // the whole table — so ordering is unchanged: more matched tokens
    // first, ties newest-first.
    const matchQuery = tokens
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(" OR ");
    const escapeLike = (value) => value.replace(/([\\%_])/g, "\\$1");
    const tokenClause = `text LIKE ? ESCAPE '\\'`;
    const rows = this.db
      .prepare(
        `
      SELECT
        session_id AS conversationId,
        role,
        created_at AS atMs,
        substr(text, 1, ${TRANSCRIPT_SEARCH_TEXT_CAP}) AS text
      FROM message_text_fts
      WHERE message_text_fts MATCH ?
      ORDER BY
        (${tokens
          .map(() => `CASE WHEN ${tokenClause} THEN 1 ELSE 0 END`)
          .join(" + ")}) DESC,
        created_at DESC
      LIMIT ?
    `,
      )
      .all(
        matchQuery,
        ...tokens.map((token) => `%${escapeLike(token)}%`),
        limit,
      );
    return this.deserializeTranscriptHits(rows);
  }
  searchTranscriptsLike(tokens, limit) {
    const escapeLike = (value) => value.replace(/([\\%_])/g, "\\$1");
    const textExpr = `json_extract(part.data_json, '$.text')`;
    const tokenClause = `${textExpr} LIKE ? ESCAPE '\\'`;
    const rows = this.db
      .prepare(
        `
      SELECT
        message.session_id AS conversationId,
        message.role AS role,
        message.created_at AS atMs,
        substr(${textExpr}, 1, ${TRANSCRIPT_SEARCH_TEXT_CAP}) AS text
      FROM message
      JOIN part ON part.message_id = message.id
      WHERE message.role IN ('user', 'assistant')
        AND message.type IN ('user_message', 'assistant_message')
        AND ${textExpr} IS NOT NULL
        AND (${tokens.map(() => tokenClause).join("\n          OR ")})
      ORDER BY
        (${tokens
          .map(() => `CASE WHEN ${tokenClause} THEN 1 ELSE 0 END`)
          .join(" + ")}) DESC,
        message.created_at DESC
      LIMIT ?
    `,
      )
      .all(
        ...tokens.map((token) => `%${escapeLike(token)}%`), // WHERE binds,
        ...tokens.map((token) => `%${escapeLike(token)}%`), // ORDER BY rebinds.
        limit,
      );
    return this.deserializeTranscriptHits(rows);
  }
  deserializeTranscriptHits(rows) {
    return rows.flatMap((row) => {
      const text = typeof row.text === "string" ? row.text.trim() : "";
      if (!text) return [];
      return [
        {
          conversationId: row.conversationId,
          role: row.role === "assistant" ? "assistant" : "user",
          atMs: row.atMs,
          text,
        },
      ];
    });
  }
  /**
   * The chat messages immediately surrounding a `searchTranscripts` hit, in
   * chronological order (excluding the hit itself). Keyword search finds the
   * message that NAMES the thing; the messages around it are usually what
   * actually happened ("give me the address" → drove there → "damn i love
   * the car"), so recall renders a hit's neighbors as its evidence context.
   */
  listTranscriptNeighbors(args) {
    const before = Math.max(0, Math.min(8, Math.floor(args.before ?? 2)));
    const after = Math.max(0, Math.min(10, Math.floor(args.after ?? 2)));
    // The follow-through to a matched message ("give me the address" → drove
    // there → reaction) routinely lands tens of minutes later, so the
    // episode boundary is a time window, not just a message count.
    const windowMs = Math.max(60_000, args.windowMs ?? 2 * 60 * 60 * 1000);
    const textExpr = `json_extract(part.data_json, '$.text')`;
    const base = `
      SELECT
        message.session_id AS conversationId,
        message.role AS role,
        message.created_at AS atMs,
        substr(${textExpr}, 1, ${TRANSCRIPT_SEARCH_TEXT_CAP}) AS text
      FROM message
      JOIN part ON part.message_id = message.id
      WHERE message.session_id = ?
        AND message.role IN ('user', 'assistant')
        AND message.type IN ('user_message', 'assistant_message')
        AND ${textExpr} IS NOT NULL
    `;
    const rows = [
      ...(before > 0
        ? this.db
            .prepare(
              `${base} AND message.created_at < ? AND message.created_at >= ?
               ORDER BY message.created_at DESC LIMIT ?`,
            )
            .all(args.conversationId, args.atMs, args.atMs - windowMs, before)
        : []),
      ...(after > 0
        ? this.db
            .prepare(
              `${base} AND message.created_at > ? AND message.created_at <= ?
               ORDER BY message.created_at ASC LIMIT ?`,
            )
            .all(args.conversationId, args.atMs, args.atMs + windowMs, after)
        : []),
    ];
    return rows
      .flatMap((row) => {
        const text = typeof row.text === "string" ? row.text.trim() : "";
        if (!text) return [];
        return [
          {
            conversationId: row.conversationId,
            role: row.role === "assistant" ? "assistant" : "user",
            atMs: row.atMs,
            text,
          },
        ];
      })
      .sort((a, b) => a.atMs - b.atMs);
  }
  listActiveThreadsByAge(conversationId) {
    return this.db
      .prepare(
        `
      SELECT
        thread_key AS threadId,
        last_used_at AS lastUsedAt
      FROM runtime_threads
      WHERE conversation_id = ?
        AND status = 'active'
      ORDER BY last_used_at ASC, thread_key ASC
    `,
      )
      .all(conversationId);
  }
  evictOldestThread(conversationId) {
    const oldest = this.listActiveThreadsByAge(conversationId)[0];
    if (!oldest) return;
    this.db
      .prepare(
        `
      UPDATE runtime_threads
      SET status = 'evicted'
      WHERE conversation_id = ?
        AND status = 'active'
        AND thread_key = ?
    `,
      )
      .run(conversationId, oldest.threadId);
  }
  reactivateThread(conversationId, threadId) {
    if (
      this.listActiveThreadsByAge(conversationId).length >=
      MAX_ACTIVE_RUNTIME_THREADS
    ) {
      this.evictOldestThread(conversationId);
    }
    this.db
      .prepare(
        `
      UPDATE runtime_threads
      SET status = 'active'
      WHERE conversation_id = ?
        AND thread_key = ?
    `,
      )
      .run(conversationId, threadId);
  }
  threadKeyExists(key) {
    const row = this.db
      .prepare(
        `
      SELECT 1 AS hit
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(key);
    return Boolean(row);
  }
  /** Mint a globally unique thread key, suffixing collisions with -2, -3, …. */
  mintUniqueKey(base) {
    if (!this.threadKeyExists(base)) return base;
    for (let ordinal = 2; ; ordinal++) {
      const candidate = `${base}-${ordinal}`;
      if (!this.threadKeyExists(candidate)) return candidate;
    }
  }
  mintThreadKey(args) {
    const slug = slugify(args.nameHint ?? "");
    // `legacy-` is the seeded feature roster's id namespace
    // (store-mod-store.ts); a thread key landing there would merge unrelated
    // identities downstream.
    if (slug && !slug.startsWith("legacy-")) {
      return this.mintUniqueKey(slug);
    }
    // Fallback for descriptions that slug to nothing (emoji, non-Latin
    // scripts): the historical per-agent-type ordinal.
    const prefix = "task-";
    const rows = this.db
      .prepare(
        `
      SELECT thread_key AS threadId
      FROM runtime_threads
      WHERE agent_type = ?
    `,
      )
      .all(args.agentType);
    let nextOrdinal = 1;
    for (const row of rows) {
      if (!row.threadId.startsWith(prefix)) continue;
      const suffix = Number.parseInt(row.threadId.slice(prefix.length), 10);
      if (Number.isFinite(suffix) && suffix >= nextOrdinal) {
        nextOrdinal = suffix + 1;
      }
    }
    return this.mintUniqueKey(`${prefix}${nextOrdinal}`);
  }
  resolveOrCreateActiveThread(args) {
    const requestedThreadId = normalizeRuntimeThreadId(args.threadId ?? "");
    const existing = requestedThreadId
      ? this.db
          .prepare(
            `
        SELECT
          thread_key AS threadId,
          conversation_id AS conversationId,
          agent_type AS agentType,
          status
        FROM runtime_threads
        WHERE thread_key = ?
        LIMIT 1
      `,
          )
          .get(requestedThreadId)
      : undefined;
    if (existing) {
      if (
        existing.conversationId !== args.conversationId ||
        existing.agentType !== args.agentType
      ) {
        throw new Error(
          `Thread ${existing.threadId} belongs to a different conversation or agent type.`,
        );
      }
      if (existing.status !== "active") {
        this.reactivateThread(args.conversationId, existing.threadId);
      }
      this.touchThread(existing.threadId);
      return {
        threadId: existing.threadId,
        reused: true,
      };
    }
    if (
      this.listActiveThreadsByAge(args.conversationId).length >=
      MAX_ACTIVE_RUNTIME_THREADS
    ) {
      this.evictOldestThread(args.conversationId);
    }
    const threadId =
      requestedThreadId ??
      this.mintThreadKey({
        agentType: args.agentType,
        ...(args.nameHint ? { nameHint: args.nameHint } : {}),
      });
    const name =
      args.nameHint?.trim().replace(/\s+/g, " ").slice(0, 200) || threadId;
    const now = Date.now();
    this.upsertSession(args.conversationId, now);
    this.db
      .prepare(
        `
      INSERT INTO runtime_threads (
        thread_key,
        conversation_id,
        agent_type,
        name,
        status,
        created_at,
        last_used_at,
        summary
      )
      VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)
    `,
      )
      .run(threadId, args.conversationId, args.agentType, name, now, now);
    return {
      threadId,
      reused: false,
    };
  }
  touchThread(threadKey) {
    this.db
      .prepare(
        `
      UPDATE runtime_threads
      SET last_used_at = ?
      WHERE thread_key = ?
    `,
      )
      .run(Date.now(), threadKey);
  }
  getThreadExternalSessionId(threadKey) {
    this.ensureImplicitThreadRow(threadKey);
    const row = this.db
      .prepare(
        `
      SELECT external_session_id AS externalSessionId
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(threadKey);
    return typeof row?.externalSessionId === "string" &&
      row.externalSessionId.trim().length > 0
      ? row.externalSessionId.trim()
      : undefined;
  }
  setThreadExternalSessionId(threadKey, externalSessionId) {
    this.ensureImplicitThreadRow(threadKey);
    const normalized =
      typeof externalSessionId === "string" &&
      externalSessionId.trim().length > 0
        ? externalSessionId.trim()
        : null;
    this.db
      .prepare(
        `
      UPDATE runtime_threads
      SET external_session_id = ?, last_used_at = ?
      WHERE thread_key = ?
    `,
      )
      .run(normalized, Date.now(), threadKey);
  }

  /**
   * Engine-namespaced cursor for out-of-band runtime rows already delivered
   * to an external session. External engines resume from their own transcript
   * instead of re-reading Stella history, so Manager child reports and task
   * updates appended between turns are injected from this durable boundary.
   */
  getThreadExternalDeliveredEntryId(threadKey: string): string | undefined {
    this.ensureImplicitThreadRow(threadKey);
    const row = this.db
      .prepare(
        `
      SELECT external_delivered_entry_id AS externalDeliveredEntryId
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(threadKey) as { externalDeliveredEntryId?: unknown } | undefined;
    return typeof row?.externalDeliveredEntryId === "string" &&
      row.externalDeliveredEntryId.trim().length > 0
      ? row.externalDeliveredEntryId.trim()
      : undefined;
  }

  setThreadExternalDeliveredEntryId(
    threadKey: string,
    entryId: string | null | undefined,
  ): void {
    this.ensureImplicitThreadRow(threadKey);
    const normalized =
      typeof entryId === "string" && entryId.trim().length > 0
        ? entryId.trim()
        : null;
    this.db
      .prepare(
        `
      UPDATE runtime_threads
      SET external_delivered_entry_id = ?
      WHERE thread_key = ?
    `,
      )
      .run(normalized, threadKey);
  }

  updateThreadSummary(threadKey: string, summary: string): void {
    const trimmed = summary.trim();
    if (!trimmed) return;
    this.ensureImplicitThreadRow(threadKey);
    this.db
      .prepare(
        `
      UPDATE runtime_threads
      SET summary = ?, last_used_at = ?
      WHERE thread_key = ?
    `,
      )
      .run(trimmed, Date.now(), threadKey);
  }
  getThreadName(threadKey) {
    // Deliberately side-effect-free: callers probe arbitrary agent ids, and
    // creating implicit rows for
    // them would leak phantom threads into search results.
    const row = this.db
      .prepare(
        `
      SELECT name
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(threadKey);
    return typeof row?.name === "string" && row.name.length > 0
      ? row.name
      : undefined;
  }
  saveAgentRecord(record) {
    this.upsertSession(record.conversationId, record.updatedAt);
    const revisionRow = this.db
      .prepare(
        `
      INSERT INTO runtime_agents (
        thread_id,
        conversation_id,
        storage_mode,
        owner_generation,
        agent_type,
        description,
        prompt,
        prompt_created_at,
        agent_depth,
        max_agent_depth,
        parent_agent_id,
        model_config_json,
        tool_workspace_root,
        status,
        started_at,
        completed_at,
        result,
        error,
        updated_at,
        root_run_id,
        attempt_generation,
        manager_final_report,
        manager_final_report_id,
        manager_report_ids_json,
        manager_report_sequence,
        cloud_terminal_receipt_generation,
        terminal_lifecycle_receipt_generation,
        descendant_boundary_state_json,
        record_revision
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(thread_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        storage_mode = excluded.storage_mode,
        owner_generation = excluded.owner_generation,
        agent_type = excluded.agent_type,
        description = excluded.description,
        prompt = COALESCE(runtime_agents.prompt, excluded.prompt),
        prompt_created_at = COALESCE(runtime_agents.prompt_created_at, excluded.prompt_created_at),
        agent_depth = excluded.agent_depth,
        max_agent_depth = excluded.max_agent_depth,
        parent_agent_id = excluded.parent_agent_id,
        model_config_json = excluded.model_config_json,
        tool_workspace_root = excluded.tool_workspace_root,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        result = excluded.result,
        error = excluded.error,
        updated_at = excluded.updated_at,
        root_run_id = excluded.root_run_id,
        attempt_generation = excluded.attempt_generation,
        manager_final_report = excluded.manager_final_report,
        manager_final_report_id = excluded.manager_final_report_id,
        manager_report_ids_json = excluded.manager_report_ids_json,
        manager_report_sequence = excluded.manager_report_sequence,
        cloud_terminal_receipt_generation = excluded.cloud_terminal_receipt_generation,
        terminal_lifecycle_receipt_generation = excluded.terminal_lifecycle_receipt_generation,
        descendant_boundary_state_json = excluded.descendant_boundary_state_json,
        record_revision = runtime_agents.record_revision + 1
      WHERE excluded.attempt_generation >= runtime_agents.attempt_generation
        AND excluded.conversation_id = runtime_agents.conversation_id
        AND excluded.storage_mode = runtime_agents.storage_mode
        AND excluded.owner_generation IS runtime_agents.owner_generation
      RETURNING record_revision
    `,
      )
      .get(
        record.threadId,
        record.conversationId,
        record.storageMode ?? "local",
        record.ownerGeneration ?? null,
        record.agentType,
        record.description,
        record.prompt ?? null,
        record.promptCreatedAt ?? null,
        record.agentDepth,
        record.maxAgentDepth ?? null,
        record.parentAgentId ?? null,
        toJsonValueString(record.modelConfigSnapshot) ?? null,
        record.toolWorkspaceRoot ?? null,
        record.status,
        record.startedAt,
        record.completedAt ?? null,
        record.result ?? null,
        record.error ?? null,
        record.updatedAt,
        record.rootRunId ?? null,
        record.attemptGeneration ?? 0,
        record.managerFinalReport ?? null,
        record.managerFinalReportId ?? null,
        toJsonValueString(record.managerReportIds) ?? null,
        record.managerReportSequence ?? 0,
        record.cloudTerminalReceiptGeneration ?? null,
        record.terminalLifecycleReceiptGeneration ?? null,
        toJsonValueString(record.descendantBoundaryState) ?? null,
      );
    return revisionRow?.record_revision ?? null;
  }
  private listAgentAssistantMessagesByThread(
    targetsInput: readonly {
      threadId: string;
      startedAt: number;
      attemptGeneration?: number;
    }[],
    limit = AGENT_ASSISTANT_UPDATE_LIMITS.messagesPerThread,
  ) {
    const seen = new Set<string>();
    const targets = targetsInput
      .flatMap((target) => {
        const threadId = target.threadId.trim();
        if (!threadId || seen.has(threadId)) return [];
        seen.add(threadId);
        return [
          {
            threadId,
            startedAt: Math.max(0, Math.floor(target.startedAt)),
            attemptGeneration: Math.max(
              0,
              Math.floor(target.attemptGeneration ?? 0),
            ),
          },
        ];
      })
      .slice(0, AGENT_ASSISTANT_UPDATE_LIMITS.activeThreads);
    if (targets.length === 0) return new Map();
    const cappedLimit = Math.max(
      1,
      Math.min(
        AGENT_ASSISTANT_UPDATE_LIMITS.messagesPerThread,
        Math.floor(limit),
      ),
    );
    const scanLimit =
      cappedLimit * AGENT_ASSISTANT_UPDATE_LIMITS.scanRowsPerMessage;
    const byThread = new Map();
    let remainingChars = AGENT_ASSISTANT_UPDATE_LIMITS.totalChars;
    let remainingBytes = AGENT_ASSISTANT_UPDATE_LIMITS.totalBytes;
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex];
      const rows = this.db
        .prepare(
          `
          SELECT created_at AS atMs, insertion_sequence AS sequence, data_json AS dataJson
          FROM runtime_thread_entries
          WHERE thread_key = ?
            AND created_at >= ?
            AND entry_type = 'message'
            AND json_extract(data_json, '$.message.role') = 'assistant'
            AND COALESCE(json_extract(data_json, '$.message.stellaAttemptGeneration'), ?) = ?
          ORDER BY insertion_sequence DESC, rowid DESC
          LIMIT ?
        `,
        )
        .all(
          target.threadId,
          target.startedAt,
          target.attemptGeneration,
          target.attemptGeneration,
          scanLimit,
        );
      const candidates = [];
      for (const row of rows) {
        let payload;
        try {
          payload = JSON.parse(row.dataJson ?? "null")?.message;
        } catch {
          continue;
        }
        if (payload?.role !== "assistant") continue;
        const text = truncateAuthoredUpdate(
          authoredTextFromAssistantPayload(payload),
        );
        if (text)
          candidates.push({ text, atMs: row.atMs, sequence: row.sequence });
        if (candidates.length >= cappedLimit) break;
      }
      if (candidates.length === 0) continue;
      const targetsRemaining = Math.max(1, targets.length - targetIndex);
      let threadChars = 0;
      let threadBytes = 0;
      const selectedNewestFirst = [];
      for (const candidate of candidates) {
        const fairChars = Math.max(
          1,
          Math.floor(remainingChars / targetsRemaining),
        );
        const fairBytes = Math.max(
          1,
          Math.floor(remainingBytes / targetsRemaining),
        );
        const text = truncateAuthoredUpdate(
          candidate.text,
          Math.min(
            AGENT_ASSISTANT_UPDATE_LIMITS.messageChars,
            AGENT_ASSISTANT_UPDATE_LIMITS.threadChars - threadChars,
            fairChars,
          ),
          Math.min(
            AGENT_ASSISTANT_UPDATE_LIMITS.messageBytes,
            AGENT_ASSISTANT_UPDATE_LIMITS.threadBytes - threadBytes,
            fairBytes,
          ),
        );
        if (!text) continue;
        const chars = [...text].length;
        const bytes = Buffer.byteLength(text, "utf8");
        selectedNewestFirst.push({ ...candidate, text });
        threadChars += chars;
        threadBytes += bytes;
        remainingChars -= chars;
        remainingBytes -= bytes;
        if (remainingChars <= 0 || remainingBytes <= 0) break;
      }
      if (selectedNewestFirst.length > 0)
        byThread.set(target.threadId, selectedNewestFirst.reverse());
    }
    return byThread;
  }
  listAgentAssistantMessages(
    agentId,
    limit = AGENT_ASSISTANT_UPDATE_LIMITS.messagesPerThread,
  ) {
    const record = this.getAgentRecord(agentId.trim());
    if (
      !record ||
      record.status !== "running" ||
      record.agentType !== "general"
    )
      return [];
    return (
      this.listAgentAssistantMessagesByThread(
        [
          {
            threadId: record.threadId,
            startedAt: record.startedAt,
            attemptGeneration: record.attemptGeneration,
          },
        ],
        limit,
      ).get(record.threadId) ?? []
    ).map(({ text, atMs }) => ({ text, atMs }));
  }
  emitThreadAssistantUpdate(threadId, atMs) {
    if (!this.options.onThreadAssistantUpdate) return;
    const record = this.getAgentRecord(threadId);
    if (
      !record ||
      record.status !== "running" ||
      record.agentType !== "general" ||
      atMs < record.startedAt
    )
      return;
    const entries =
      this.listAgentAssistantMessagesByThread([
        {
          threadId: record.threadId,
          startedAt: record.startedAt,
          attemptGeneration: record.attemptGeneration,
        },
      ]).get(record.threadId) ?? [];
    const latest = entries[entries.length - 1];
    if (!latest) return;
    const assistantMessages = entries.map((entry) => entry.text);
    this.options.onThreadAssistantUpdate({
      conversationId: record.conversationId,
      assistantUpdate: {
        threadId: record.threadId,
        assistantMessages,
        reasoningSummaries: [...assistantMessages],
        latestMessage: latest.text,
        atMs: latest.atMs,
        atSequence: latest.sequence,
        attemptGeneration: record.attemptGeneration,
        ...(record.rootRunId ? { rootRunId: record.rootRunId } : {}),
      },
    });
  }
  getAgentRecord(threadId) {
    const row = this.db
      .prepare(
        `
      SELECT
        thread_id,
        conversation_id,
        storage_mode,
        owner_generation,
        agent_type,
        description,
        prompt,
        prompt_created_at,
        agent_depth,
        max_agent_depth,
        parent_agent_id,
        model_config_json,
        tool_workspace_root,
        status,
        started_at,
        completed_at,
        result,
        error,
        updated_at,
        root_run_id,
        attempt_generation,
        manager_final_report,
        manager_final_report_id,
        manager_report_ids_json,
        manager_report_sequence,
        cloud_terminal_receipt_generation,
        terminal_lifecycle_receipt_generation,
        descendant_boundary_state_json,
        record_revision
      FROM runtime_agents
      WHERE thread_id = ?
      LIMIT 1
    `,
      )
      .get(threadId) as
      | {
          thread_id: string;
          conversation_id: string;
          storage_mode: string;
          owner_generation: string | null;
          agent_type: string;
          description: string;
          agent_depth: number;
          max_agent_depth: number | null;
          parent_agent_id: string | null;
          model_config_json: string | null;
          status: PersistedAgentRecord["status"];
          started_at: number;
          completed_at: number | null;
          result: string | null;
          error: string | null;
          updated_at: number;
          root_run_id: string | null;
          attempt_generation: number;
          manager_final_report: string | null;
          manager_final_report_id: string | null;
          manager_report_ids_json: string | null;
          manager_report_sequence: number;
          cloud_terminal_receipt_generation: number | null;
          terminal_lifecycle_receipt_generation: number | null;
          descendant_boundary_state_json: string | null;
          record_revision: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    const modelConfigSnapshot = parseJsonValue<
      PersistedAgentRecord["modelConfigSnapshot"]
    >(row.model_config_json);
    const managerReportIds = parseManagerReportIds(row.manager_report_ids_json);
    const descendantBoundaryState = parseDescendantBoundaryState(
      row.descendant_boundary_state_json,
    );
    return {
      threadId: row.thread_id,
      conversationId: row.conversation_id,
      storageMode: row.storage_mode === "cloud" ? "cloud" : "local",
      ...(row.owner_generation
        ? { ownerGeneration: row.owner_generation }
        : {}),
      agentType: normalizeRetiredAgentType(row.agent_type),
      description: row.description,
      ...(row.prompt
        ? {
            prompt: row.prompt,
            promptCreatedAt:
              typeof row.prompt_created_at === "number"
                ? row.prompt_created_at
                : row.started_at,
          }
        : {}),
      agentDepth: row.agent_depth,
      ...(row.max_agent_depth == null
        ? {}
        : { maxAgentDepth: row.max_agent_depth }),
      ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
      ...(modelConfigSnapshot ? { modelConfigSnapshot } : {}),
      ...(row.tool_workspace_root
        ? { toolWorkspaceRoot: row.tool_workspace_root }
        : {}),
      status: row.status,
      attemptGeneration: row.attempt_generation ?? 0,
      recordRevision: row.record_revision ?? 0,
      ...(row.root_run_id ? { rootRunId: row.root_run_id } : {}),
      ...(row.manager_final_report
        ? { managerFinalReport: row.manager_final_report }
        : {}),
      ...(row.manager_final_report_id
        ? { managerFinalReportId: row.manager_final_report_id }
        : {}),
      ...(managerReportIds ? { managerReportIds } : {}),
      managerReportSequence: row.manager_report_sequence,
      ...(row.cloud_terminal_receipt_generation == null
        ? {}
        : {
            cloudTerminalReceiptGeneration:
              row.cloud_terminal_receipt_generation,
          }),
      ...(row.terminal_lifecycle_receipt_generation == null
        ? {}
        : {
            terminalLifecycleReceiptGeneration:
              row.terminal_lifecycle_receipt_generation,
          }),
      ...(descendantBoundaryState ? { descendantBoundaryState } : {}),
      startedAt: row.started_at,
      completedAt: row.completed_at,
      ...(row.result ? { result: row.result } : {}),
      ...(row.error ? { error: row.error } : {}),
      updatedAt: row.updated_at,
    };
  }
  listAgentRecordsByStatus(status) {
    const rows = this.db
      .prepare(
        `
      SELECT
        thread_id,
        conversation_id,
        storage_mode,
        owner_generation,
        agent_type,
        description,
        prompt,
        prompt_created_at,
        agent_depth,
        max_agent_depth,
        parent_agent_id,
        model_config_json,
        tool_workspace_root,
        status,
        started_at,
        completed_at,
        result,
        error,
        updated_at,
        root_run_id,
        attempt_generation,
        manager_final_report,
        manager_final_report_id,
        manager_report_ids_json,
        manager_report_sequence,
        cloud_terminal_receipt_generation,
        terminal_lifecycle_receipt_generation,
        descendant_boundary_state_json,
        record_revision
      FROM runtime_agents
      WHERE status = ?
      ORDER BY updated_at DESC, thread_id ASC
    `,
      )
      .all(status) as Array<{
      thread_id: string;
      conversation_id: string;
      storage_mode: string;
      owner_generation: string | null;
      agent_type: string;
      description: string;
      agent_depth: number;
      max_agent_depth: number | null;
      parent_agent_id: string | null;
      model_config_json: string | null;
      status: PersistedAgentRecord["status"];
      started_at: number;
      completed_at: number | null;
      result: string | null;
      error: string | null;
      updated_at: number;
      root_run_id: string | null;
      attempt_generation: number;
      manager_final_report: string | null;
      manager_final_report_id: string | null;
      manager_report_ids_json: string | null;
      manager_report_sequence: number;
      cloud_terminal_receipt_generation: number | null;
      terminal_lifecycle_receipt_generation: number | null;
      descendant_boundary_state_json: string | null;
      record_revision: number;
    }>;

    return rows.map((row) => {
      const modelConfigSnapshot = parseJsonValue<
        PersistedAgentRecord["modelConfigSnapshot"]
      >(row.model_config_json);
      const managerReportIds = parseManagerReportIds(
        row.manager_report_ids_json,
      );
      const descendantBoundaryState = parseDescendantBoundaryState(
        row.descendant_boundary_state_json,
      );
      return {
        threadId: row.thread_id,
        conversationId: row.conversation_id,
        storageMode: row.storage_mode === "cloud" ? "cloud" : "local",
        ...(row.owner_generation
          ? { ownerGeneration: row.owner_generation }
          : {}),
        agentType: normalizeRetiredAgentType(row.agent_type),
        description: row.description,
        ...(row.prompt
          ? {
              prompt: row.prompt,
              promptCreatedAt:
                typeof row.prompt_created_at === "number"
                  ? row.prompt_created_at
                  : row.started_at,
            }
          : {}),
        agentDepth: row.agent_depth,
        ...(row.max_agent_depth == null
          ? {}
          : { maxAgentDepth: row.max_agent_depth }),
        ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
        ...(modelConfigSnapshot ? { modelConfigSnapshot } : {}),
        ...(row.tool_workspace_root
          ? { toolWorkspaceRoot: row.tool_workspace_root }
          : {}),
        status: row.status,
        attemptGeneration: row.attempt_generation ?? 0,
        recordRevision: row.record_revision ?? 0,
        ...(row.root_run_id ? { rootRunId: row.root_run_id } : {}),
        ...(row.manager_final_report
          ? { managerFinalReport: row.manager_final_report }
          : {}),
        ...(row.manager_final_report_id
          ? { managerFinalReportId: row.manager_final_report_id }
          : {}),
        ...(managerReportIds ? { managerReportIds } : {}),
        managerReportSequence: row.manager_report_sequence,
        ...(row.cloud_terminal_receipt_generation == null
          ? {}
          : {
              cloudTerminalReceiptGeneration:
                row.cloud_terminal_receipt_generation,
            }),
        ...(row.terminal_lifecycle_receipt_generation == null
          ? {}
          : {
              terminalLifecycleReceiptGeneration:
                row.terminal_lifecycle_receipt_generation,
            }),
        ...(descendantBoundaryState ? { descendantBoundaryState } : {}),
        startedAt: row.started_at,
        completedAt: row.completed_at,
        ...(row.result ? { result: row.result } : {}),
        ...(row.error ? { error: row.error } : {}),
        updatedAt: row.updated_at,
      };
    });
  }
  /**
   * Authoritative Activity read: one row per background-agent thread in the
   * conversation, straight from `runtime_agents` (the single writer is the
   * LocalAgentManager's `persistTask`). Initial hydration is active work plus
   * a bounded recent terminal window; keyed pushes keep it current afterward.
   * SQLite retains every older record.
   */
  selectBoundedThreadActivityIds(conversationId, maxItems) {
    const activeRows = this.db
      .prepare(
        `SELECT thread_id
         FROM runtime_agents
         WHERE conversation_id = ?
           AND status IN ('pending', 'running')
         ORDER BY updated_at DESC, thread_id ASC
         LIMIT ?`,
      )
      .all(conversationId, maxItems);
    const remaining = maxItems - activeRows.length;
    const terminalRows =
      remaining > 0
        ? this.db
            .prepare(
              `SELECT thread_id
               FROM runtime_agents
               WHERE conversation_id = ?
                 AND status NOT IN ('pending', 'running')
               ORDER BY updated_at DESC, thread_id ASC
               LIMIT ?`,
            )
            .all(conversationId, remaining)
        : [];
    return [...activeRows, ...terminalRows]
      .map((row) => row.thread_id)
      .filter((threadId) => typeof threadId === "string");
  }

  listThreadActivity(conversationId, options = {}) {
    if (options.view === "mobile-summary") {
      const requestedMaxItems = Number.isFinite(options.maxItems)
        ? options.maxItems
        : 200;
      const maxItems = Math.min(
        500,
        Math.max(1, Math.floor(requestedMaxItems)),
      );
      const selectedThreadIds = this.selectBoundedThreadActivityIds(
        conversationId,
        maxItems,
      );
      if (selectedThreadIds.length === 0) return [];
      const selectedPlaceholders = selectedThreadIds.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `
        SELECT
          a.thread_id,
          a.conversation_id,
          a.agent_type,
          a.description,
          a.status,
          a.attempt_generation,
          a.record_revision,
          a.parent_agent_id,
          a.started_at,
          a.completed_at,
          substr(a.result, 1, 512) AS result,
          substr(a.error, 1, 512) AS error,
          a.updated_at,
          a.root_run_id
        FROM runtime_agents a
        WHERE a.thread_id IN (${selectedPlaceholders})
        ORDER BY a.started_at ASC, a.thread_id ASC
      `,
        )
        .all(...selectedThreadIds);
      return rows.map((row) => ({
        source: "stella",
        threadId: row.thread_id,
        conversationId: row.conversation_id,
        agentType: normalizeRetiredAgentType(row.agent_type),
        description: row.description,
        status: row.status,
        attemptGeneration: row.attempt_generation ?? 0,
        recordRevision: row.record_revision ?? 0,
        ...(row.root_run_id ? { rootRunId: row.root_run_id } : {}),
        ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
        startedAt: row.started_at,
        ...(row.completed_at == null ? {} : { completedAt: row.completed_at }),
        ...(row.result ? { result: row.result } : {}),
        ...(row.error ? { error: row.error } : {}),
        updatedAt: row.updated_at,
      }));
    }
    const requestedMaxItems = Number.isFinite(options.maxItems)
      ? options.maxItems
      : DESKTOP_THREAD_ACTIVITY_HYDRATION_LIMIT;
    const maxItems = Math.min(
      DESKTOP_THREAD_ACTIVITY_HYDRATION_LIMIT,
      Math.max(1, Math.floor(requestedMaxItems)),
    );
    const selectedThreadIds = this.selectBoundedThreadActivityIds(
      conversationId,
      maxItems,
    );
    if (selectedThreadIds.length === 0) return [];
    const selectedPlaceholders = selectedThreadIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
      SELECT
        a.thread_id,
        a.conversation_id,
        a.agent_type,
        a.description,
        a.status,
        a.attempt_generation,
        a.record_revision,
        a.parent_agent_id,
        a.model_config_json,
        a.started_at,
        a.completed_at,
        substr(a.result, 1, 2000) AS result,
        substr(a.error, 1, 2000) AS error,
        a.updated_at,
        a.root_run_id,
        t.group_key,
        t.group_label
      FROM runtime_agents a
      LEFT JOIN runtime_threads t ON t.thread_key = a.thread_id
      WHERE a.thread_id IN (${selectedPlaceholders})
      ORDER BY a.started_at ASC, a.thread_id ASC
    `,
      )
      .all(...selectedThreadIds);
    const assistantTargets = rows
      .filter((row) => normalizeRetiredAgentType(row.agent_type) === "general")
      .sort(
        (a, b) =>
          Number(b.status === "running") - Number(a.status === "running") ||
          b.updated_at - a.updated_at ||
          a.thread_id.localeCompare(b.thread_id),
      )
      .slice(0, AGENT_ASSISTANT_UPDATE_LIMITS.activeThreads)
      .map((row) => ({
        threadId: row.thread_id,
        startedAt: row.started_at,
        attemptGeneration: row.attempt_generation ?? 0,
        recordRevision: row.record_revision ?? 0,
      }));
    const assistantMessagesByThread =
      this.listAgentAssistantMessagesByThread(assistantTargets);
    return rows.map((row) => {
      const assistantEntries = assistantMessagesByThread.get(row.thread_id);
      const latestAssistantEntry =
        assistantEntries?.[assistantEntries.length - 1];
      const modelConfigSnapshot = parseJsonValue(row.model_config_json);
      return {
        source: "stella",
        threadId: row.thread_id,
        conversationId: row.conversation_id,
        agentType: normalizeRetiredAgentType(row.agent_type),
        description: row.description,
        status: row.status,
        attemptGeneration: row.attempt_generation ?? 0,
        recordRevision: row.record_revision ?? 0,
        ...(row.root_run_id ? { rootRunId: row.root_run_id } : {}),
        ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
        ...(modelConfigSnapshot ? { modelConfigSnapshot } : {}),
        ...(row.group_key ? { groupKey: row.group_key } : {}),
        ...(row.group_label ? { groupLabel: row.group_label } : {}),
        startedAt: row.started_at,
        ...(row.completed_at == null ? {} : { completedAt: row.completed_at }),
        ...(row.result ? { result: row.result } : {}),
        ...(row.error ? { error: row.error } : {}),
        ...(assistantEntries
          ? {
              assistantMessages: assistantEntries.map((entry) => entry.text),
              ...(latestAssistantEntry
                ? {
                    assistantMessagesUpdatedAt: latestAssistantEntry.atMs,
                    assistantMessagesUpdatedSequence:
                      latestAssistantEntry.sequence,
                  }
                : {}),
            }
          : {}),
        updatedAt: row.updated_at,
      };
    });
  }
  /** Bounded, read-only transcript projection for General/Manager detail UI. */
  listThreadTranscript(
    threadIdInput: string,
    limit = 300,
  ): ThreadTranscript | null {
    const threadId = normalizeRuntimeThreadId(threadIdInput);
    if (!threadId) return null;
    const record = this.getAgentRecord(threadId);
    if (
      !record ||
      (record.agentType !== AGENT_IDS.GENERAL &&
        record.agentType !== AGENT_IDS.MANAGER)
    ) {
      return null;
    }
    const cappedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rawMessages = this.loadRawThreadMessages(threadId, cappedLimit + 1);
    const hasClaudeCodeTransport =
      record.modelConfigSnapshot?.engine === "claude_code_local" ||
      rawMessages.some((message) =>
        isClaudeCodeAssistantPayload(message.payload),
      );
    const messages = rawMessages;
    const truncated = messages.length > cappedLimit;
    const selected = truncated ? messages.slice(-cappedLimit) : messages;
    const selectedRaw =
      rawMessages.length > cappedLimit
        ? rawMessages.slice(-cappedLimit)
        : rawMessages;
    const claudeTaskStarts = hasClaudeCodeTransport
      ? this.projectClaudeTaskStarts(selectedRaw)
      : new Map<string, EventRecord[]>();
    const lifecycleById = new Map(
      this.listLifecycleEventsByIds(
        selected.flatMap((message) => {
          const eventId = message.customMessage?.eventId;
          return message.customMessage?.customType ===
            "runtime.task_lifecycle" &&
            eventId &&
            !message.customMessage.lifecycleEvent
            ? [eventId]
            : [];
        }),
      ).map((event) => [event._id, event]),
    );
    const clip = (value: string, max = 4_000) =>
      value.length <= max ? value : `${value.slice(0, max)}…`;
    const entries = selected.flatMap<ThreadTranscriptEntry>(
      (message, index) => {
        const id = message.entryId ?? `${message.timestamp}:${index}`;
        if (message.payload?.role === "assistant") {
          const text = message.payload.content
            .flatMap((block) =>
              block.type === "text" && block.text.trim() ? [block.text] : [],
            )
            .join("\n\n")
            .trim();
          const taskStarts = claudeTaskStarts.get(id) ?? [];
          return [
            ...(text
              ? [
                  {
                    id,
                    timestamp: message.timestamp,
                    kind: "assistant" as const,
                    text: clip(text),
                  },
                ]
              : []),
            ...taskStarts.map((lifecycleEvent, taskIndex) => ({
              id: `${id}:task:${taskIndex}`,
              timestamp: message.timestamp,
              kind: "lifecycle" as const,
              lifecycleEvent,
            })),
          ];
        }
        if (message.payload?.role === "toolResult") {
          return [];
        }
        if (message.customMessage) {
          if (
            message.customMessage.customType !== "runtime.task_lifecycle" &&
            message.customMessage.customType !==
              RUNTIME_PRIVATE_TASK_LIFECYCLE_CUSTOM_TYPE
          ) {
            return [];
          }
          const eventId = message.customMessage.eventId;
          const lifecycleEvent = message.customMessage.lifecycleEvent
            ? {
                _id: eventId ?? `thread-private:${id}`,
                timestamp: message.timestamp,
                type: message.customMessage.lifecycleEvent.type,
                payload: message.customMessage.lifecycleEvent.payload,
              }
            : eventId
              ? lifecycleById.get(eventId)
              : undefined;
          if (!lifecycleEvent) return [];
          return [
            {
              id,
              timestamp: message.timestamp,
              kind: "lifecycle",
              lifecycleEvent: lifecycleEvent as EventRecord,
            },
          ];
        }
        const text = message.content.trim();
        if (!text) return [];
        return [
          {
            id,
            timestamp: message.timestamp,
            kind: message.role === "assistant" ? "assistant" : "user",
            text: clip(text),
          },
        ];
      },
    );
    return {
      threadId,
      conversationId: record.conversationId,
      agentType: record.agentType,
      description: record.description,
      status: record.status,
      entries,
      truncated,
    };
  }

  getThreadActivityMetadata(threadId) {
    const row = this.db
      .prepare(
        `
      SELECT group_key, group_label
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(threadId);
    if (!row) return null;
    return {
      ...(row.group_key ? { groupKey: row.group_key } : {}),
      ...(row.group_label ? { groupLabel: row.group_label } : {}),
    };
  }
  getOrchestratorReminderState(conversationId) {
    const row = this.db
      .prepare(
        `
      SELECT
        force_reminder_on_next_turn AS forceReminderOnNextTurn
      FROM runtime_conversation_state
      WHERE conversation_id = ?
      LIMIT 1
    `,
      )
      .get(conversationId);
    return {
      shouldInjectDynamicReminder: row?.forceReminderOnNextTurn === 1,
    };
  }
  forceOrchestratorReminderOnNextTurn(conversationId) {
    this.db
      .prepare(
        `
      INSERT INTO runtime_conversation_state (
        conversation_id,
        force_reminder_on_next_turn
      )
      VALUES (?, 1)
      ON CONFLICT(conversation_id) DO UPDATE SET
        force_reminder_on_next_turn = 1
    `,
      )
      .run(conversationId);
  }
  consumeOrchestratorReminder(conversationId) {
    this.db
      .prepare(
        `
      UPDATE runtime_conversation_state
      SET force_reminder_on_next_turn = 0
      WHERE conversation_id = ?
    `,
      )
      .run(conversationId);
  }
}

/**
 * SessionStore as a scoped Effect service (M5 kernel/storage pass).
 *
 * Ownership design: the sqlite handle is acquired into the layer's scope and
 * `db.close()` is the scope finalizer, so the handle provably cannot outlive
 * (or be leaked past) the graph built over it. Because the driver is
 * synchronous (bun:sqlite), every store method stays a synchronous call over
 * prepared statements — many callers run inside open transactions
 * (`withTransaction`), where an async hop would break atomicity. Effect-land
 * callers wrap store work with `withSessionStore`, which runs one synchronous
 * body (e.g. a persist-then-notify pair) as a single Effect.
 *
 * Surface 1 (`worker/server/session/storage.ts`) composes the same resource
 * shape over these exports today: it builds `createDesktopDatabase` +
 * `new ChatStore(db, …)` + `RunEventLog` inside its own `Layer.effect` and
 * registers `db.close()` via `Effect.addFinalizer` at the BOTTOM of the
 * session chain, so the close runs LAST on teardown (after the runner drains
 * compactions and `runEventLog.stop()` — the old `stopWorkerServices`
 * order). That layer stays byte-compatible with the class constructor and is
 * untouched here; this service is the storage-area-owned equivalent for
 * kernel-side Effect composition, with the identical finalizer contract.
 */
export interface SessionStoreServiceShape {
  readonly db: SqliteDatabase;
  readonly store: SessionStore;
}

export class SessionStoreService extends Context.Service<
  SessionStoreService,
  SessionStoreServiceShape
>()("@stella/runtime/storage/SessionStore") {}

/**
 * Build the scoped SessionStore service: open the desktop database, own the
 * handle in the layer scope, close it as the scope finalizer (on success,
 * failure, and interruption).
 */
export const sessionStoreLayer = (config: {
  stellaDataDirPath: string;
  options?: SessionStoreOptions;
}) =>
  Layer.effect(
    SessionStoreService,
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => createDesktopDatabase(config.stellaDataDirPath)),
        (handle) =>
          Effect.sync(() => {
            handle.close();
          }),
      );
      return { db, store: new SessionStore(db, config.options) };
    }),
  );

/**
 * Run one synchronous body against the store as a single Effect. Failures
 * carry the ORIGINAL thrown error object so parity strings survive
 * `Cause.squash` at the facade boundary. Persist-then-notify pairs (the
 * store's transactional write followed by its `onThreadTranscriptUpdate` /
 * `onThreadAssistantUpdate` callbacks) execute inside one such body, so the
 * observable order — persist committed, then notify, same tick — is exactly
 * the pre-Effect order.
 */
export const withSessionStore = <A>(
  body: (store: SessionStore) => A,
): Effect.Effect<A, unknown, SessionStoreService> =>
  Effect.gen(function* () {
    const { store } = yield* SessionStoreService;
    return yield* Effect.try({
      try: () => body(store),
      catch: (error) => error,
    });
  });
