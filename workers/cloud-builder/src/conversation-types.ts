/**
 * The conversation transcript's shared vocabulary: tuning constants, the wire
 * protocol's record and frame shapes, and the two interfaces that split the
 * work in half.
 *
 * The split, stated once: STORAGE owns SQLite, R2, the agent loop and the turn
 * lifecycle, and calls `broadcastRecord` after every committed append. The HUB
 * owns sockets, auth and fan-out, and never writes to SQLite. Nothing else in
 * `workers/cloud-builder` may hold a durable conversation fact.
 *
 * This module is the seam. It is written once and then frozen: both halves
 * import it, so an edit here is an edit to both.
 */

/**
 * 2 adds `spills.bytes`; 3 adds owner-transfer object tracking; 4 adds durable
 * append receipts so an acknowledged foreign write remains idempotent after
 * its hot journal rows roll into R2; 5 adds retired writer fences so a delayed
 * pre-rewind writer cannot recreate a removed suffix in the new epoch; 6 adds
 * atomic edit receipts for crash-safe rewind replay.
 */
export const JOURNAL_SCHEMA_VERSION = 7;
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Residency / rollover
// ---------------------------------------------------------------------------

export const HOT_MAX_ROWS = 2_000;
export const HOT_MAX_BYTES = 24 * 1024 * 1024;
export const HOT_TARGET_ROWS = 1_000;
export const HOT_TARGET_BYTES = 12 * 1024 * 1024;
export const DB_PRESSURE_AGGRESSIVE_BYTES = 64 * 1024 * 1024;
export const DB_PRESSURE_EMERGENCY_BYTES = 512 * 1024 * 1024;
export const DB_PRESSURE_AGGRESSIVE_ROWS = 500;
export const DB_PRESSURE_EMERGENCY_ROWS = 200;
/** Spill to R2 above this. The platform row cap is 2 MB; this leaves margin. */
export const MAX_ROW_BYTES = 1024 * 1024;
/** Platform allows 6 simultaneous outgoing connections; leave room for R2 retries. */
export const MAX_SEGMENTS_PER_READ = 4;

// ---------------------------------------------------------------------------
// Context window
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on the metadata pass that picks the context window. The token
 * budget itself is CLOUD_HISTORY_TOKEN_BUDGET in @stella/executor-cloud.
 */
export const CONTEXT_SCAN_ROW_CAP = 4_000;
/** How many spilled payloads one window will pull back from R2. */
export const CONTEXT_MAX_SPILL_HYDRATIONS = 3;
/** How far back repair-on-load scans for an unanswered tool call. */
export const REPAIR_SCAN_ROW_CAP = 400;

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------

export const INITIAL_WINDOW_RECORDS = 100;
export const MAX_RESUME_RECORDS = 2_000;
export const BACKFILL_BATCH_RECORDS = 200;
export const BACKFILL_BATCH_BYTES = 512 * 1024;
export const MAX_SOCKETS_PER_CONVERSATION = 16;
export const MAX_INCOMING_FRAME_BYTES = 64 * 1024;
export const SOCKET_STALE_MS = 90_000;
export const RE_AUTH_LEAD_MS = 60_000;
export const AUTH_GRACE_MS = 30_000;
export const RATE_BACKFILL_PER_MIN = 20;
export const RATE_CANCEL_PER_MIN = 10;
export const RATE_AUTH_PER_MIN = 10;
export const RATE_TOTAL_PER_MIN = 60;

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export const DELTA_FLUSH_MS = 100;
export const DELTA_FLUSH_BYTES = 2_048;
/** Per turn. Past this the hub emits `deltas_dropped` once and goes quiet. */
export const DELTA_BUDGET_BYTES = 262_144;
export const LIVE_PARTIAL_MAX_CHARS = 32_000;
/** Tool argument preview length on the advisory `tool` frame. */
export const TOOL_ARGS_PREVIEW_MAX = 400;

// ---------------------------------------------------------------------------
// Appends
// ---------------------------------------------------------------------------

export const APPEND_MAX_ROWS = 256;
export const APPEND_MAX_BYTES = 4 * 1024 * 1024;
export const INBOX_MAX_ROWS = 200;
export const INBOX_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The per-conversation append budget, and the reason it exists.
 *
 * `POST /conversations/:id/journal` is a live user-authenticated write path.
 * Per-request caps bound one request; nothing bounds a loop of them, and a
 * Durable Object's storage is billed and ceilinged per object. These are the
 * two limits that make lifetime writes bounded: a fixed window that caps the
 * rate, and a lifetime ceiling on everything the conversation has stored —
 * resident rows plus archived segments, so rolling bytes into R2 does not
 * reset the count.
 *
 * The window is deliberately generous: it exists to stop a runaway client, not
 * to shape a plan. The ceiling is what a plan would parametrize.
 */
export const APPEND_WINDOW_MS = 60_000;
export const APPEND_WINDOW_MAX_REQUESTS = 60;
export const APPEND_WINDOW_MAX_BYTES = 16 * 1024 * 1024;
export const CONVERSATION_MAX_STORED_BYTES = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Excerpts / index
// ---------------------------------------------------------------------------

export const EXCERPT_TEXT_MAX = 4_000;
export const EXCERPT_USER_HALF_MAX = 1_200;
export const EXCERPT_FLUSH_BATCH = 50;
export const PREVIEW_MAX_CHARS = 160;

// ---------------------------------------------------------------------------
// JWKS (consumed by the hub's auth module)
// ---------------------------------------------------------------------------

export const JWKS_TTL_MS = 10 * 60_000;
export const JWKS_MIN_REFETCH_MS = 60_000;
export const CLOCK_SKEW_S = 60;

// ---------------------------------------------------------------------------
// Close codes
// ---------------------------------------------------------------------------

/**
 * The close *reason* is capped at 123 bytes by the protocol, so it carries the
 * code only. Human text goes in a preceding `error` frame, which is free.
 */
export const CLOSE_BAD_REQUEST = 4400;
export const CLOSE_UNAUTHENTICATED = 4401;
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_NOT_FOUND = 4404;
export const CLOSE_PROTOCOL_VERSION = 4409;
export const CLOSE_DELETED = 4410;
export const CLOSE_FRAME_TOO_LARGE = 4413;
export const CLOSE_RATE_LIMITED = 4429;
export const CLOSE_TOO_MANY_SOCKETS = 4503;
export const CLOSE_INTERNAL = 1011;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type JournalRecordKind = "message" | "turn" | "card";

export type MessageRole = "user" | "assistant" | "toolResult";

export type TurnPhase =
  | "started"
  | "completed"
  | "failed"
  | "canceled"
  | "timeout";

export type ConversationCard =
  | { type: "build"; buildId: string; appId?: string }
  | { type: "operation"; operation: string; args?: unknown; result?: unknown }
  | {
      type: "files";
      files: Array<{
        path: string;
        name: string;
        sizeBytes: number;
        contentType?: string;
        stored?: boolean;
      }>;
    };

export type JournalMessageRecord = {
  seq: number;
  kind: "message";
  turnId: string;
  createdAtMs: number;
  role: MessageRole;
  /** Render flag: no user bubble. Still model context. */
  hidden: boolean;
  /** Ties this committed row to the advisory deltas that preceded it. */
  streamId?: string;
  /** Prompt rows only: resolves the client's optimistic echo. */
  clientMsgId?: string;
  /** A serialized AgentMessage, or a `{ $spill: true }` stub for oversize rows. */
  payload: unknown;
};

export type JournalTurnRecord = {
  seq: number;
  kind: "turn";
  turnId: string;
  createdAtMs: number;
  phase: TurnPhase;
  lane?: string;
  source?: string;
  /** User-facing text for every non-completed phase. Never a provider string. */
  notice?: string;
  promptSeq?: number;
  wallClockMs?: number;
};

export type JournalCardRecord = {
  seq: number;
  kind: "card";
  turnId: string;
  createdAtMs: number;
  card: ConversationCard;
};

export type JournalRecord =
  | JournalMessageRecord
  | JournalTurnRecord
  | JournalCardRecord;

// ---------------------------------------------------------------------------
// Reader surface the hub is given
// ---------------------------------------------------------------------------

export type JournalHead = {
  headSeq: number;
  /** Lowest seq still resident in SQLite. Below this, reads go to R2. */
  windowStartSeq: number;
  /** Lowest seq that exists at all — anything below is compacted or never was. */
  floorSeq: number;
  epoch: number;
  title: string;
  deleted: boolean;
  activity: "idle" | "running";
};

export type JournalRange = {
  records: JournalRecord[];
  /** False when the caller's range was cut short by a batch limit. */
  complete: boolean;
  /**
   * Set when part of the requested range no longer exists (compacted past the
   * archive, or never allocated). The hub turns this into a `gap` frame.
   */
  missingBelowSeq?: number;
};

export type LiveTurnSnapshot = {
  turnId: string;
  streamId: string | null;
  partialText: string;
  tools: Array<{
    toolCallId: string;
    name: string;
    label?: string;
    phase: "start" | "end";
    isError?: boolean;
  }>;
};

export type ConversationOwnerRecord = {
  ownerId: string;
  ownerGeneration: string;
  createdAt: number;
  title: string;
};

export interface JournalReader {
  head(): JournalHead;
  /** "" when the DO has never been bound to an owner. */
  ownerId(): string;
  bindOwner(record: ConversationOwnerRecord): void;
  readRange(
    fromSeq: number,
    toSeq: number,
    limit: number,
  ): Promise<JournalRange>;
  newest(limit: number): JournalRecord[];
  liveTurn(): LiveTurnSnapshot | null;
}

// ---------------------------------------------------------------------------
// Hub surface storage is given
// ---------------------------------------------------------------------------

/** What the worker proved about the caller before the DO was ever addressed. */
export type SocketIdentity = {
  ownerId: string;
  subject: string;
  sessionId?: string;
  /** Epoch millis at which the presented JWT stops being valid. */
  authExpiresAtMs: number;
};

/**
 * The proven-identity headers the worker attaches when it forwards a verified
 * caller to a conversation DO. They live here, on the shared seam, because both
 * sides of it read them: the worker writes them after verifying the JWT, and
 * the DO rebuilds the identity from them. A client-supplied header of the same
 * name is stripped at the worker before forwarding — that stripping is the
 * whole reason the DO is allowed to trust these.
 */
export const HEADER_OWNER = "x-stella-owner";
export const HEADER_SUBJECT = "x-stella-subject";
export const HEADER_SESSION = "x-stella-session";
export const HEADER_TOKEN_EXP = "x-stella-token-exp";
/**
 * The pinned Convex origin the worker verified against. It rides along so the
 * DO can verify a mid-life `auth` frame without needing its own copy of the
 * issuer configuration — the worker's isolate globals are not the DO's.
 */
export const HEADER_ISSUER = "x-stella-auth-issuer";
/** Every header under this prefix is stripped from the client's own request. */
export const STELLA_HEADER_PREFIX = "x-stella-";

/**
 * Rebuild the verified identity on the DO side. Returns null when the headers
 * are absent or malformed, which can only mean the route was reached without
 * passing through the worker's verification — refuse rather than guess.
 */
export const parseSocketIdentity = (
  request: Request,
): SocketIdentity | null => {
  const ownerId = request.headers.get(HEADER_OWNER)?.trim() ?? "";
  const subject = request.headers.get(HEADER_SUBJECT)?.trim() ?? "";
  const expires = Number(request.headers.get(HEADER_TOKEN_EXP) ?? "");
  if (!ownerId || !subject || !Number.isFinite(expires)) return null;
  return {
    ownerId,
    subject,
    sessionId: request.headers.get(HEADER_SESSION)?.trim() || undefined,
    authExpiresAtMs: expires,
  };
};

/** What storage hands the hub per delta; the hub coalesces and numbers them. */
export type DeltaInput = {
  turnId: string;
  streamId: string;
  kind: "text" | "thinking";
  text: string;
};

export type ToolInput = {
  turnId: string;
  toolCallId: string;
  name: string;
  label?: string;
  phase: "start" | "end";
  argsPreview?: string;
  isError?: boolean;
};

export interface ConversationHub {
  upgrade(request: Request, identity: SocketIdentity): Promise<Response>;
  onMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
  onClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void>;
  onError(ws: WebSocket, error: unknown): Promise<void>;
  /** Called after every committed journal append. Must never throw. */
  broadcastRecord(record: JournalRecord): void;
  /** Advisory, lossy, never persisted. Must never throw and never await. */
  broadcastDelta(delta: DeltaInput): void;
  /** Advisory tool lifecycle. Same rules as broadcastDelta. */
  broadcastTool(tool: ToolInput): void;
  /** A turn reached a terminal phase: drop any retained delta budget/state. */
  endTurn(turnId: string): void;
  closeAll(code: number): void;
}

export type ConversationLogger = (
  level: "info" | "error",
  event: string,
  fields?: Record<string, unknown>,
) => void;

export interface ConversationHubDeps {
  ctx: DurableObjectState;
  reader: JournalReader;
  /**
   * Service-secret lookup of the conversation's owner, single-flighted by the
   * caller. Returns null when Convex has no such conversation — the hub must
   * then close 4404 rather than adopt the connector as owner.
   */
  lookupOwner: () => Promise<ConversationOwnerRecord | null>;
  cancelTurn: (turnId: string) => Promise<void>;
  /** Storage flushes a lagging Convex index projection on first connect. */
  onConnect: () => void;
  conversationId: () => string;
  log: ConversationLogger;
}

export type ConversationHubFactory = (
  deps: ConversationHubDeps,
) => ConversationHub;

/**
 * A hub that accepts nothing. It is what runs before the socket half of this
 * migration lands, and what runs if that half is ever reverted: the DO keeps
 * its transcript and its turn lifecycle either way, and clients fall back to
 * the Convex event projection. Deliberately not an error — a missing socket
 * layer must degrade, never break turns.
 */
export class NullConversationHub implements ConversationHub {
  async upgrade(): Promise<Response> {
    return Response.json(
      {
        error: "Live conversation streaming isn't available yet.",
        code: "socket_unavailable",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  async onMessage(): Promise<void> {}
  async onClose(): Promise<void> {}
  async onError(): Promise<void> {}
  broadcastRecord(): void {}
  broadcastDelta(): void {}
  broadcastTool(): void {}
  endTurn(): void {}
  closeAll(): void {}
}

let hubFactory: ConversationHubFactory | null = null;

/**
 * The one wiring point between the two halves. The socket module registers
 * itself at import time; `index.ts` importing that module is what turns the
 * hub on. Registration rather than a direct import so each half can land,
 * typecheck and deploy on its own.
 */
export const registerConversationHubFactory = (
  factory: ConversationHubFactory,
): void => {
  hubFactory = factory;
};

export const createConversationHub = (
  deps: ConversationHubDeps,
): ConversationHub =>
  hubFactory ? hubFactory(deps) : new NullConversationHub();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * UTF-8 byte length without allocating a copy. Every budget in this module is
 * denominated in bytes, and a JS string length undercounts CJK by 3x — which
 * is exactly the transcript that would blow the row cap.
 */
export const utf8Length = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
};

/** Stub written in place of an oversize payload; the bytes live at spill_key. */
export type SpillStub = {
  $spill: true;
  role: string;
  bytes: number;
  /** UI-safe projection; full model payload remains at `spill_key`. */
  content?: Array<{ type: "text"; text: string }>;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

export const isSpillStub = (value: unknown): value is SpillStub =>
  typeof value === "object" &&
  value !== null &&
  (value as { $spill?: unknown }).$spill === true;
