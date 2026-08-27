/**
 * The conversation socket's wire contract, client side.
 *
 * The server's copy of these shapes lives in
 * `workers/cloud-builder/src/conversation-types.ts`. This is a deliberate
 * second declaration rather than a shared package: the interior is a browser
 * bundle that must not take a build dependency on worker sources, and the
 * frames are small enough that a drifting field is caught by the decoder
 * below. Unknown advisory frames are dropped; durable rows with a valid raw
 * sequence become skipped sentinels so the ordered cursor can still advance.
 *
 * The one invariant to keep in mind while reading: a frame carrying `seq` is
 * durable and replayable; a frame without `seq` is advisory and lossy.
 */

export const PROTOCOL_VERSION = 1;

/** Newest records the server sends when the client asks for no `since`. */
export const INITIAL_WINDOW_RECORDS = 100;
/** Server cap on one resume; the client never asks for more in one request. */
export const MAX_RESUME_RECORDS = 2_000;
/** Server cap on one backfill response. */
export const BACKFILL_BATCH_RECORDS = 200;
/** Server's socket-liveness window; the client probes rather than assumes. */
export const SOCKET_STALE_MS = 90_000;
/**
 * How far ahead of expiry the token is refreshed. Mirrors the server constant,
 * but the CLIENT timer is the primary one: the server's `auth.expiring` rides
 * on the send path, so an idle socket is never warned and would lapse silently,
 * making the next wake or scheduled reply cost a reconnect.
 */
export const RE_AUTH_LEAD_MS = 60_000;
/** Server's per-socket backfill budget. The client stays under it locally. */
export const RATE_BACKFILL_PER_MIN = 20;
/** Longest a live (uncommitted) assistant bubble is allowed to grow. */
export const LIVE_PARTIAL_MAX_CHARS = 32_000;

/**
 * How many journal records one conversation view keeps in memory. Scrollback
 * is unbounded on the server; the renderer is not. Older records are dropped
 * from the head of the array and can be fetched again.
 */
export const MAX_CLIENT_RECORDS = 3_000;

/** Records buffered while a gap is being filled before we give up and resync. */
export const MAX_BUFFERED_AHEAD = 512;

export type SocketCloseCode =
  | 4400
  | 4401
  | 4403
  | 4404
  | 4409
  | 4410
  | 4413
  | 4429
  | 4503;

/**
 * Closes the client must never retry. `4401` is retryable exactly once — a
 * fresh token may fix it — and becomes terminal when the retry also fails.
 */
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  4400, 4403, 4404, 4409, 4410, 4413,
]);

export type JournalKind = "message" | "turn" | "card";

export type MessageRole = "user" | "assistant" | "toolResult";

export type TurnPhase =
  | "started"
  | "completed"
  | "failed"
  | "canceled"
  | "timeout";

/** A file a turn produced, as it arrives inside a `files` card. */
export type JournalFile = {
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  /** False when the bytes stayed in the workspace (file over the inline cap). */
  stored?: boolean;
};

export type JournalCard =
  | { type: "build"; buildId: string; appId?: string }
  | {
      type: "operation";
      operation: string;
      args?: Record<string, unknown>;
      result?: Record<string, unknown> | null;
    }
  | { type: "files"; files: JournalFile[] };

type JournalRecordBase = {
  seq: number;
  turnId: string;
  createdAtMs: number;
};

export type JournalMessageRecord = JournalRecordBase & {
  kind: "message";
  role: MessageRole;
  /** Render flag: no bubble. The row is still model context. */
  hidden: boolean;
  /** Ties a committed assistant row to the deltas that streamed it. */
  streamId?: string;
  /** Echo-resolution key for a prompt this client optimistically rendered. */
  clientMsgId?: string;
  payload: Record<string, unknown>;
};

export type JournalTurnRecord = JournalRecordBase & {
  kind: "turn";
  phase: TurnPhase;
  lane?: string;
  source?: string;
  /** User-facing text for every phase that is not `completed`. */
  notice?: string;
  wallClockMs?: number;
};

export type JournalCardRecord = JournalRecordBase & {
  kind: "card";
  card: JournalCard;
};

export type KnownJournalRecord =
  | JournalMessageRecord
  | JournalTurnRecord
  | JournalCardRecord;

/**
 * A durable row whose sequence is understood but whose payload is not.
 *
 * This stays in the in-memory ordered store but is ignored by render
 * projections. Keeping it there lets contiguity, reconnect, backfill, and
 * scrollback all move past a kind introduced by a newer server instead of
 * requesting the same unrenderable gap forever.
 */
export type SkippedJournalRecord = JournalRecordBase & {
  kind: "skipped";
  /** Kind advertised by the newer server, when it was readable. */
  originalKind?: string;
};

export type JournalRecord = KnownJournalRecord | SkippedJournalRecord;

/** The turn that is streaming right now, as `ready` describes it. */
export type LiveTurnSnapshot = {
  turnId: string;
  /**
   * Synthesised when the server has no stream id yet — a turn can be running
   * with tool activity and no assistant text, and dropping the snapshot for
   * want of a key would lose the whole live state on reconnect.
   */
  streamId: string;
  partialText: string;
  tools: {
    toolCallId: string;
    name: string;
    label?: string;
    phase: "start" | "end";
    isError?: boolean;
  }[];
};

export type ReadyFrame = {
  type: "ready";
  protocol: number;
  conversationId: string;
  epoch: number;
  headSeq: number;
  /** First seq delivered on this connect — the scrollback anchor. */
  windowStartSeq: number;
  /** Lowest seq any backfill can ever resolve. Below it there is nothing. */
  floorSeq: number;
  title: string;
  activity: string;
  authExpiresAtMs: number;
  serverTimeMs: number;
  live: LiveTurnSnapshot | null;
};

export type ServerFrame =
  | ReadyFrame
  | ({ type: "record" } & JournalRecord)
  | {
      type: "backfill";
      requestId: string;
      fromSeq: number;
      toSeq: number;
      complete: boolean;
      records: JournalRecord[];
    }
  | { type: "gap"; fromSeq: number; toSeq: number; reason: string }
  | { type: "reset"; reason: "epoch" | "window" }
  | {
      type: "delta";
      turnId: string;
      streamId: string;
      ordinal: number;
      kind: "text" | "thinking";
      text: string;
    }
  | {
      type: "tool";
      turnId: string;
      toolCallId: string;
      name: string;
      label?: string;
      phase: "start" | "end";
      argsPreview?: string;
      isError?: boolean;
    }
  | { type: "deltas_dropped"; turnId: string; streamId: string }
  | { type: "auth.expiring"; atMs: number }
  | {
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
      ref?: string;
    };

export type ClientFrame =
  | { type: "auth"; token: string }
  | { type: "backfill"; requestId: string; fromSeq: number; toSeq: number }
  | { type: "cancel"; turnId: string };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const seqNum = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const MESSAGE_ROLES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "toolResult",
]);

const TURN_PHASES: ReadonlySet<string> = new Set([
  "started",
  "completed",
  "failed",
  "canceled",
  "timeout",
]);

/**
 * Decodes one journal record for rendering. Callers processing an ordered
 * stream must use `decodeSequencedJournalEntry`, which preserves the raw
 * sequence when this decoder cannot understand the payload.
 */
export const decodeRecord = (value: unknown): KnownJournalRecord | null => {
  const raw = asRecord(value);
  if (!raw) return null;
  const seq = seqNum(raw.seq);
  const turnId = str(raw.turnId);
  const kind = str(raw.kind);
  if (seq === undefined || turnId === undefined || !kind) return null;
  const createdAtMs = num(raw.createdAtMs) ?? 0;
  if (kind === "message") {
    const role = str(raw.role);
    const payload = asRecord(raw.payload);
    if (!role || !MESSAGE_ROLES.has(role) || !payload) return null;
    return {
      kind: "message",
      seq,
      turnId,
      createdAtMs,
      role: role as MessageRole,
      hidden: raw.hidden === true,
      ...(str(raw.streamId) ? { streamId: str(raw.streamId) as string } : {}),
      ...(str(raw.clientMsgId)
        ? { clientMsgId: str(raw.clientMsgId) as string }
        : {}),
      payload,
    };
  }
  if (kind === "turn") {
    const phase = str(raw.phase);
    if (!phase || !TURN_PHASES.has(phase)) return null;
    return {
      kind: "turn",
      seq,
      turnId,
      createdAtMs,
      phase: phase as TurnPhase,
      ...(str(raw.lane) ? { lane: str(raw.lane) as string } : {}),
      ...(str(raw.source) ? { source: str(raw.source) as string } : {}),
      ...(str(raw.notice) ? { notice: str(raw.notice) as string } : {}),
      ...(num(raw.wallClockMs) !== undefined
        ? { wallClockMs: num(raw.wallClockMs) as number }
        : {}),
    };
  }
  if (kind === "card") {
    const card = decodeCard(raw.card);
    if (!card) return null;
    return { kind: "card", seq, turnId, createdAtMs, card };
  }
  return null;
};

/**
 * Decodes a durable journal row without ever discarding a valid raw cursor.
 * Unknown future kinds and malformed known payloads become a skipped sentinel
 * so gap repair remains monotonic across rolling client/server upgrades.
 */
export const decodeSequencedJournalEntry = (
  value: unknown,
): JournalRecord | null => {
  const raw = asRecord(value);
  const seq = seqNum(raw?.seq);
  if (!raw || seq === undefined) return null;
  const decoded = decodeRecord(raw);
  if (decoded) return decoded;
  const originalKind = str(raw.kind);
  return {
    kind: "skipped",
    seq,
    turnId: str(raw.turnId) ?? "",
    createdAtMs: num(raw.createdAtMs) ?? 0,
    ...(originalKind ? { originalKind } : {}),
  };
};

const decodeCard = (value: unknown): JournalCard | null => {
  const raw = asRecord(value);
  const type = str(raw?.type);
  if (!raw || !type) return null;
  if (type === "build") {
    const buildId = str(raw.buildId);
    if (!buildId) return null;
    return {
      type: "build",
      buildId,
      ...(str(raw.appId) ? { appId: str(raw.appId) as string } : {}),
    };
  }
  if (type === "operation") {
    const operation = str(raw.operation);
    if (!operation) return null;
    return {
      type: "operation",
      operation,
      ...(asRecord(raw.args)
        ? { args: asRecord(raw.args) as Record<string, unknown> }
        : {}),
      ...(asRecord(raw.result)
        ? { result: asRecord(raw.result) as Record<string, unknown> }
        : {}),
    };
  }
  if (type === "files") {
    if (!Array.isArray(raw.files)) return null;
    const files: JournalFile[] = [];
    for (const entry of raw.files) {
      const file = asRecord(entry);
      const path = str(file?.path);
      if (!file || !path) continue;
      files.push({
        path,
        name: str(file.name) ?? path.split("/").pop() ?? path,
        sizeBytes: num(file.sizeBytes) ?? 0,
        contentType: str(file.contentType) ?? "application/octet-stream",
        ...(file.stored === false ? { stored: false } : {}),
      });
    }
    if (!files.length) return null;
    return { type: "files", files };
  }
  return null;
};

/** Text a rendered bubble shows for one `AgentMessage` payload. */
export const messageText = (payload: Record<string, unknown>): string => {
  const content = payload.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    const block = asRecord(entry);
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
};

/** True when an assistant payload is nothing but tool calls. */
export const hasToolCalls = (payload: Record<string, unknown>): boolean =>
  Array.isArray(payload.content) &&
  payload.content.some((entry) => asRecord(entry)?.type === "toolCall");

/**
 * Decodes a server frame. Unknown `type` values decode to `null` so a server
 * that learns a new frame does not break an older client.
 */
export const decodeServerFrame = (data: string): ServerFrame | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const raw = asRecord(parsed);
  const type = str(raw?.type);
  if (!raw || !type) return null;
  switch (type) {
    case "ready": {
      const conversationId = str(raw.conversationId);
      if (!conversationId) return null;
      return {
        type: "ready",
        protocol: num(raw.protocol) ?? PROTOCOL_VERSION,
        conversationId,
        epoch: num(raw.epoch) ?? 0,
        headSeq: num(raw.headSeq) ?? -1,
        windowStartSeq: num(raw.windowStartSeq) ?? 0,
        floorSeq: num(raw.floorSeq) ?? 0,
        title: str(raw.title) ?? "",
        activity: str(raw.activity) ?? "idle",
        authExpiresAtMs: num(raw.authExpiresAtMs) ?? 0,
        serverTimeMs: num(raw.serverTimeMs) ?? Date.now(),
        live: decodeLive(raw.live),
      };
    }
    case "record": {
      const record = decodeSequencedJournalEntry(raw);
      return record ? { type: "record", ...record } : null;
    }
    case "backfill": {
      const requestId = str(raw.requestId);
      if (!requestId || !Array.isArray(raw.records)) return null;
      const records: JournalRecord[] = [];
      for (const entry of raw.records) {
        const record = decodeSequencedJournalEntry(entry);
        if (record) records.push(record);
      }
      return {
        type: "backfill",
        requestId,
        fromSeq: num(raw.fromSeq) ?? 0,
        toSeq: num(raw.toSeq) ?? 0,
        complete: raw.complete !== false,
        records,
      };
    }
    case "gap":
      return {
        type: "gap",
        fromSeq: num(raw.fromSeq) ?? 0,
        toSeq: num(raw.toSeq) ?? 0,
        reason: str(raw.reason) ?? "compacted",
      };
    case "reset":
      return {
        type: "reset",
        reason: raw.reason === "epoch" ? "epoch" : "window",
      };
    case "delta": {
      const turnId = str(raw.turnId);
      const streamId = str(raw.streamId);
      const text = str(raw.text);
      if (!turnId || !streamId || text === undefined) return null;
      return {
        type: "delta",
        turnId,
        streamId,
        ordinal: num(raw.ordinal) ?? 0,
        kind: raw.kind === "thinking" ? "thinking" : "text",
        text,
      };
    }
    case "tool": {
      const turnId = str(raw.turnId);
      const toolCallId = str(raw.toolCallId);
      const name = str(raw.name);
      if (!turnId || !toolCallId || !name) return null;
      return {
        type: "tool",
        turnId,
        toolCallId,
        name,
        ...(str(raw.label) ? { label: str(raw.label) as string } : {}),
        phase: raw.phase === "end" ? "end" : "start",
        ...(str(raw.argsPreview)
          ? { argsPreview: str(raw.argsPreview) as string }
          : {}),
        ...(raw.isError === true ? { isError: true } : {}),
      };
    }
    case "deltas_dropped": {
      const turnId = str(raw.turnId);
      const streamId = str(raw.streamId);
      if (!turnId || !streamId) return null;
      return { type: "deltas_dropped", turnId, streamId };
    }
    case "auth.expiring":
      return { type: "auth.expiring", atMs: num(raw.atMs) ?? 0 };
    case "error":
      return {
        type: "error",
        code: str(raw.code) ?? "unknown",
        message: str(raw.message) ?? "Something went wrong.",
        retryable: raw.retryable !== false,
        ...(str(raw.ref) ? { ref: str(raw.ref) as string } : {}),
      };
    default:
      return null;
  }
};

const decodeLive = (value: unknown): LiveTurnSnapshot | null => {
  const raw = asRecord(value);
  const turnId = str(raw?.turnId);
  if (!raw || !turnId) return null;
  // The server sends `streamId: null` for a turn that is running but has not
  // produced assistant text yet. That snapshot still carries the tool state
  // the working label reads, so it gets a synthetic key rather than a drop.
  const streamId = str(raw.streamId) ?? `live:${turnId}`;
  const tools: LiveTurnSnapshot["tools"] = [];
  if (Array.isArray(raw.tools)) {
    for (const entry of raw.tools) {
      const tool = asRecord(entry);
      const toolCallId = str(tool?.toolCallId);
      const name = str(tool?.name);
      if (!tool || !toolCallId || !name) continue;
      tools.push({
        toolCallId,
        name,
        ...(str(tool.label) ? { label: str(tool.label) as string } : {}),
        phase: tool.phase === "end" ? "end" : "start",
        ...(tool.isError === true ? { isError: true } : {}),
      });
    }
  }
  return {
    turnId,
    streamId,
    partialText: (str(raw.partialText) ?? "").slice(0, LIVE_PARTIAL_MAX_CHARS),
    tools,
  };
};

/**
 * RFC 6455 subprotocol values must be RFC 7230 tokens. A Convex JWT is
 * base64url with `.` separators, all of which are legal — but a token that
 * somehow is not would throw a `SyntaxError` out of the `WebSocket`
 * constructor, which is a crash rather than a readable failure.
 */
const TOKEN_CHARSET = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

export const isSubprotocolSafe = (token: string): boolean =>
  token.length > 0 && TOKEN_CHARSET.test(token);
