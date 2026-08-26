/**
 * The conversation's socket surface: one hibernatable WebSocket fan-out per
 * conversation Durable Object.
 *
 * Three properties this file exists to hold, each of which is easy to lose:
 *
 * 1. IDLE COSTS NOTHING. No timer is ever armed unless a turn is streaming, no
 *    JSON heartbeat is exchanged (the platform's auto-response answers "ping"
 *    without waking the DO), and token expiry is enforced on the send path
 *    rather than by an alarm. A hibernated conversation with sixteen watchers
 *    bills nothing until something is actually said.
 *
 * 2. NO IN-MEMORY SOCKET REGISTRY. Everything a socket needs to be understood
 *    lives in its own `serializeAttachment`. A `Map<WebSocket, meta>` field
 *    would appear to work right up until the first eviction, after which every
 *    reconnected socket is anonymous and unauthorizable. `ctx.getWebSockets()`
 *    plus `deserializeAttachment()` is the only supported way to know who is
 *    listening.
 *
 * 3. BACKPRESSURE IS BOUNDED AT THE SOURCE. `bufferedAmount` does not exist on
 *    workerd's WebSocket, and client acks would be incoming frames (billed
 *    20:1 against a transport chosen because outgoing is free). So the agent
 *    loop never awaits a send, and delta volume is a function of turn duration
 *    — coalesced at DELTA_FLUSH_MS and capped by DELTA_BUDGET_BYTES per turn —
 *    not of listener count or model speed. A slow client cannot stall the loop.
 *
 * The durability rule the frames encode: a frame carrying `seq` is replayable,
 * a frame without one is advisory and may be dropped at any time. Losing every
 * `delta` for a turn costs a live preview; the committed `record` still carries
 * the full text.
 */

import {
  AUTH_GRACE_MS,
  BACKFILL_BATCH_BYTES,
  BACKFILL_BATCH_RECORDS,
  CLOSE_BAD_REQUEST,
  CLOSE_DELETED,
  CLOSE_FRAME_TOO_LARGE,
  CLOSE_FORBIDDEN,
  CLOSE_INTERNAL,
  CLOSE_NOT_FOUND,
  CLOSE_PROTOCOL_VERSION,
  CLOSE_RATE_LIMITED,
  CLOSE_TOO_MANY_SOCKETS,
  CLOSE_UNAUTHENTICATED,
  DELTA_BUDGET_BYTES,
  DELTA_FLUSH_BYTES,
  DELTA_FLUSH_MS,
  HEADER_ISSUER,
  INITIAL_WINDOW_RECORDS,
  LIVE_PARTIAL_MAX_CHARS,
  MAX_INCOMING_FRAME_BYTES,
  MAX_RESUME_RECORDS,
  MAX_SOCKETS_PER_CONVERSATION,
  PROTOCOL_VERSION,
  RATE_AUTH_PER_MIN,
  RATE_BACKFILL_PER_MIN,
  RATE_CANCEL_PER_MIN,
  RATE_TOTAL_PER_MIN,
  RE_AUTH_LEAD_MS,
  SOCKET_STALE_MS,
  STELLA_HEADER_PREFIX,
  registerConversationHubFactory,
  utf8Length,
  type ConversationHub,
  type ConversationHubDeps,
  type DeltaInput,
  type JournalHead,
  type JournalRecord,
  type LiveTurnSnapshot,
  type SocketIdentity,
  type ToolInput,
} from "./conversation-types.js";
import { verifyConvexToken } from "./auth-jwt.js";
import { sha256Hex } from "./hash.js";

// ---------------------------------------------------------------------------
// Wire frames
// ---------------------------------------------------------------------------

export type ReadyFrame = {
  type: "ready";
  protocol: number;
  conversationId: string;
  epoch: number;
  headSeq: number;
  /**
   * First seq delivered on this connect — the client's scrollback anchor, and
   * the point below which it must ask for a backfill to see more.
   */
  windowStartSeq: number;
  /** Lowest seq any future backfill can ever resolve. Below it is a `gap`. */
  floorSeq: number;
  title: string;
  activity: "idle" | "running";
  authExpiresAtMs: number;
  serverTimeMs: number;
  live: LiveTurnSnapshot | null;
};

export type RecordFrame = { type: "record" } & JournalRecord;

export type BackfillFrame = {
  type: "backfill";
  requestId: string;
  fromSeq: number;
  toSeq: number;
  complete: boolean;
  records: JournalRecord[];
};

export type GapFrame = {
  type: "gap";
  fromSeq: number;
  toSeq: number;
  reason: "compacted";
};

export type ResetFrame = { type: "reset"; reason: "epoch" | "window" };

export type DeltaFrame = {
  type: "delta";
  turnId: string;
  streamId: string;
  ordinal: number;
  kind: "text" | "thinking";
  text: string;
};

export type ToolFrame = { type: "tool" } & ToolInput;

export type DeltasDroppedFrame = {
  type: "deltas_dropped";
  turnId: string;
  streamId: string;
};

export type AuthExpiringFrame = { type: "auth.expiring"; atMs: number };

export type ErrorFrame = {
  type: "error";
  code: string;
  message: string;
  retryable: boolean;
  ref?: string;
};

export type ServerFrame =
  | ReadyFrame
  | RecordFrame
  | BackfillFrame
  | GapFrame
  | ResetFrame
  | DeltaFrame
  | ToolFrame
  | DeltasDroppedFrame
  | AuthExpiringFrame
  | ErrorFrame;

export type ClientFrame =
  | { type: "auth"; token: string }
  | { type: "backfill"; requestId: string; fromSeq: number; toSeq: number }
  | { type: "cancel"; turnId: string };

// ---------------------------------------------------------------------------
// Worker → DO handoff
// ---------------------------------------------------------------------------

/**
 * Identity headers the worker sets after verifying the JWT, and which it
 * strips from the client's own request first. They are trustworthy inside the
 * DO for the reason the rest of this worker's DO traffic is: a Durable Object
 * namespace is not publicly addressable.
 *
 * Defined on the shared seam (`conversation-types.ts`) rather than here: the
 * DO rebuilds the identity from them too, and storage must not have to import
 * this module to do it — the hub is wired by registry precisely so the two
 * sides stay independently deployable.
 */
export {
  HEADER_ISSUER,
  HEADER_OWNER,
  HEADER_SESSION,
  HEADER_SUBJECT,
  HEADER_TOKEN_EXP,
  STELLA_HEADER_PREFIX,
  parseSocketIdentity,
} from "./conversation-types.js";

export const SUBPROTOCOL = "stella.v1";
export const SUBPROTOCOL_TOKEN_PREFIX = "stella.token.";

/** Remove every client-supplied `x-stella-*` header before forwarding. */
export const stripStellaHeaders = (headers: Headers): void => {
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith(STELLA_HEADER_PREFIX)) {
      headers.delete(name);
    }
  }
};

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

const CLOSE_REASONS: Record<number, string> = {
  [CLOSE_BAD_REQUEST]: "bad_request",
  [CLOSE_UNAUTHENTICATED]: "unauthenticated",
  [CLOSE_FORBIDDEN]: "forbidden",
  [CLOSE_NOT_FOUND]: "not_found",
  [CLOSE_PROTOCOL_VERSION]: "protocol_version",
  [CLOSE_DELETED]: "deleted",
  [CLOSE_FRAME_TOO_LARGE]: "frame_too_large",
  [CLOSE_RATE_LIMITED]: "rate_limited",
  [CLOSE_TOO_MANY_SOCKETS]: "too_many_sockets",
  [CLOSE_INTERNAL]: "internal",
};

const closeReason = (code: number): string => CLOSE_REASONS[code] ?? "closed";

/**
 * Refuse a connection by completing the handshake and immediately closing with
 * a real code. An HTTP 4xx before the 101 would reach the browser as close code
 * 1006 with no detail, which a client cannot tell apart from a dropped network
 * — and "refresh your token" and "back off forever" are opposite responses.
 *
 * Deliberately a plain `accept()`, not `ctx.acceptWebSocket()`: a refusal must
 * not consume a hibernation slot, and at the worker layer there is no DO to
 * hibernate into at all.
 */
export const refuseUpgrade = (
  request: Request,
  code: number,
  message: string,
  options: { retryable?: boolean; ref?: string; errorCode?: string } = {},
): Response => {
  const pair = new WebSocketPair();
  const server = pair[1]!;
  server.accept();
  try {
    server.send(
      JSON.stringify({
        type: "error",
        code: options.errorCode ?? closeReason(code),
        message,
        retryable: options.retryable ?? false,
        ...(options.ref ? { ref: options.ref } : {}),
      } satisfies ErrorFrame),
    );
  } catch {
    // The peer is already gone; the close below is still the right answer.
  }
  try {
    server.close(code, closeReason(code));
  } catch {
    // Same.
  }
  // Echoing a subprotocol the client never offered fails the handshake in the
  // browser, which would replace our close code with an opaque 1006 — the
  // exact ambiguity this refusal path exists to remove.
  const { offered } = tokenFromSubprotocol(request);
  return new Response(null, {
    status: 101,
    webSocket: pair[0]!,
    headers: offered ? { "sec-websocket-protocol": SUBPROTOCOL } : {},
  });
};

export const isWebSocketUpgrade = (request: Request): boolean =>
  (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";

/** Pull the JWT out of `Sec-WebSocket-Protocol`. Never out of the query string. */
export const tokenFromSubprotocol = (
  request: Request,
): { token: string; offered: boolean } => {
  const raw = request.headers.get("sec-websocket-protocol") ?? "";
  let token = "";
  let offered = false;
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (value === SUBPROTOCOL) offered = true;
    else if (value.startsWith(SUBPROTOCOL_TOKEN_PREFIX)) {
      token = value.slice(SUBPROTOCOL_TOKEN_PREFIX.length);
    }
  }
  return { token, offered };
};

// ---------------------------------------------------------------------------
// Socket attachment
// ---------------------------------------------------------------------------

/**
 * Everything the DO must know about a socket after an eviction. Kept small on
 * purpose: it is rewritten on every INCOMING frame (never on outgoing ones, or
 * a chatty turn would pay a serialization per delta per socket).
 */
type SocketAttachment = {
  v: 1;
  ownerId: string;
  subject: string;
  sessionId: string;
  issuer: string;
  authExpiresAtMs: number;
  protocol: number;
  connectedAtMs: number;
  /** Rolling one-minute rate window. */
  rateWindowStartMs: number;
  rateTotal: number;
  rateBackfill: number;
  rateCancel: number;
  rateAuth: number;
};

const readAttachment = (ws: WebSocket): SocketAttachment | null => {
  try {
    const raw = ws.deserializeAttachment() as SocketAttachment | null;
    if (!raw || raw.v !== 1 || typeof raw.ownerId !== "string") return null;
    return raw;
  } catch {
    return null;
  }
};

const rollRateWindow = (attachment: SocketAttachment, nowMs: number): void => {
  if (nowMs - attachment.rateWindowStartMs < 60_000) return;
  attachment.rateWindowStartMs = nowMs;
  attachment.rateTotal = 0;
  attachment.rateBackfill = 0;
  attachment.rateCancel = 0;
  attachment.rateAuth = 0;
};

// ---------------------------------------------------------------------------
// Live streaming state (in-memory, advisory, never durable)
// ---------------------------------------------------------------------------

const MAX_TRACKED_TURNS = 4;
const MAX_TRACKED_STREAMS = 32;
const MAX_TRACKED_TOOLS = 16;

type StreamState = {
  turnId: string;
  streamId: string;
  kind: "text" | "thinking";
  ordinal: number;
  pending: string;
  pendingBytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Replayed to a client that joins mid-turn. Capped; never grows past it. */
  live: string;
  liveTruncated: boolean;
};

type TurnStreamState = {
  turnId: string;
  spentBytes: number;
  dropped: boolean;
  streamIds: Set<string>;
  tools: Map<string, ToolInput>;
  latestStreamId: string | null;
};

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

class ConversationHubImpl implements ConversationHub {
  private readonly streams = new Map<string, StreamState>();
  private readonly turns = new Map<string, TurnStreamState>();
  /**
   * Which expiry we have already warned a socket about. Weak on purpose: after
   * an eviction the socket object is new, the entry is gone, and the worst
   * consequence is one redundant (free) `auth.expiring` frame.
   */
  private readonly warned = new WeakMap<WebSocket, number>();

  constructor(private readonly deps: ConversationHubDeps) {
    // Idempotent, and setting it in the hub's constructor — which runs in the
    // DO's constructor — means the answer to "does auto-response survive
    // eviction?" never has to be known: a rehydrated DO sets it again before
    // it can service a single frame.
    try {
      this.deps.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("ping", "pong"),
      );
    } catch (error) {
      this.deps.log("error", "conversation_autoresponse_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Upgrade ──────────────────────────────────────────────────────────────

  async upgrade(request: Request, identity: SocketIdentity): Promise<Response> {
    const conversationId = this.deps.conversationId();
    if (!isWebSocketUpgrade(request)) {
      return Response.json(
        { error: "This endpoint speaks WebSocket only." },
        { status: 426, headers: { "cache-control": "no-store" } },
      );
    }
    const url = new URL(request.url);
    const protocolParam = url.searchParams.get("protocol");
    if (protocolParam !== null && Number(protocolParam) !== PROTOCOL_VERSION) {
      return refuseUpgrade(
        request,
        CLOSE_PROTOCOL_VERSION,
        "This app is out of date. Reload to keep chatting.",
      );
    }

    let head = this.deps.reader.head();
    if (head.deleted) {
      return refuseUpgrade(
        request,
        CLOSE_DELETED,
        "This conversation was deleted.",
      );
    }

    // The DO never adopts its first connector as owner: a conversation id would
    // otherwise be a bearer token, and anyone who guessed or leaked a UUID
    // would own the object. Unbound means asking Convex, which is the only
    // authority for who a conversation belongs to.
    let ownerId = this.deps.reader.ownerId();
    if (!ownerId) {
      let record: Awaited<ReturnType<typeof this.deps.lookupOwner>>;
      try {
        record = await this.deps.lookupOwner();
      } catch (error) {
        this.deps.log("error", "conversation_owner_lookup_failed", {
          conversationId,
          message: error instanceof Error ? error.message : String(error),
        });
        return refuseUpgrade(
          request,
          CLOSE_INTERNAL,
          "Stella couldn't open this conversation. Try again.",
          { retryable: true },
        );
      }
      if (!record) {
        return refuseUpgrade(
          request,
          CLOSE_NOT_FOUND,
          "That conversation no longer exists.",
        );
      }
      this.deps.reader.bindOwner(record);
      ownerId = record.ownerId;
      head = this.deps.reader.head();
    }
    if (ownerId !== identity.ownerId) {
      // 404, not 403: a distinct code would confirm to a prober that the
      // conversation exists and merely belongs to somebody else.
      return refuseUpgrade(
        request,
        CLOSE_NOT_FOUND,
        "That conversation no longer exists.",
      );
    }

    if (!this.reserveSocketSlot()) {
      return refuseUpgrade(
        request,
        CLOSE_TOO_MANY_SOCKETS,
        "Too many devices are watching this conversation. Close one and try again.",
        { retryable: true },
      );
    }

    // Tagged by a hash of the owner, not the owner: the raw `${issuer}|${sub}`
    // can exceed the 256-char tag limit and is PII-shaped in logs. The tag
    // exists so a service-secret route can kill every socket belonging to one
    // user immediately.
    const tag = `o:${(await sha256Hex(ownerId)).slice(0, 32)}`;

    // The LAST await in this method. Everything after it runs to completion
    // synchronously, so no `broadcastRecord` can interleave and deliver a
    // `record` ahead of `ready`.
    const opening = await this.openingWindow(
      head,
      url.searchParams.get("since"),
      url.searchParams.get("epoch"),
    );

    // Final, exact gate. `reserveSocketSlot` did the reaping, but two connects
    // can both pass it and then both wait on the same R2 read above; only a
    // check with no await between it and `acceptWebSocket` actually holds the
    // cap.
    if (
      this.deps.ctx.getWebSockets().length >= MAX_SOCKETS_PER_CONVERSATION
    ) {
      return refuseUpgrade(
        request,
        CLOSE_TOO_MANY_SOCKETS,
        "Too many devices are watching this conversation. Close one and try again.",
        { retryable: true },
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0]!;
    const server = pair[1]!;
    const now = Date.now();
    const attachment: SocketAttachment = {
      v: 1,
      ownerId,
      subject: identity.subject,
      sessionId: identity.sessionId ?? "",
      issuer: request.headers.get(HEADER_ISSUER)?.trim() ?? "",
      authExpiresAtMs: identity.authExpiresAtMs,
      protocol: PROTOCOL_VERSION,
      connectedAtMs: now,
      rateWindowStartMs: now,
      rateTotal: 0,
      rateBackfill: 0,
      rateCancel: 0,
      rateAuth: 0,
    };

    this.deps.ctx.acceptWebSocket(server, [tag]);
    server.serializeAttachment(attachment);
    // A socket that connects with less than RE_AUTH_LEAD_MS of token left would
    // otherwise be warned by the very first send — which is `ready`, so the
    // client would receive `auth.expiring` before it had been told anything at
    // all. `ready.authExpiresAtMs` carries the same fact in the right order;
    // the warning is cleared again below so the next broadcast still backstops.
    this.warned.set(server, attachment.authExpiresAtMs);

    const fresh = this.deps.reader.head();
    // A resume that had to decompress an R2 segment held an await open, and a
    // turn may have committed rows while it did. Those rows are in SQLite and
    // readable without awaiting, so close the hole here rather than making
    // every client discover it as a gap.
    const records = opening.records;
    let delivered = records.length > 0 ? records[records.length - 1]!.seq : -1;
    if (delivered >= 0 && fresh.headSeq > delivered) {
      for (const record of this.deps.reader.newest(INITIAL_WINDOW_RECORDS)) {
        if (record.seq <= delivered) continue;
        // Contiguity is the client's whole gap-detection contract; if the
        // top-up cannot extend the window without a hole, stop and let the
        // client ask for the rest by seq.
        if (record.seq !== delivered + 1) break;
        records.push(record);
        delivered = record.seq;
      }
    }

    this.sendFrame(server, {
      type: "ready",
      protocol: PROTOCOL_VERSION,
      conversationId,
      epoch: fresh.epoch,
      headSeq: fresh.headSeq,
      windowStartSeq: records[0]?.seq ?? fresh.headSeq + 1,
      floorSeq: fresh.floorSeq,
      title: fresh.title,
      activity: fresh.activity,
      authExpiresAtMs: attachment.authExpiresAtMs,
      serverTimeMs: now,
      live: this.liveSnapshot(),
    });
    if (opening.reset) {
      this.sendFrame(server, { type: "reset", reason: opening.reset });
    }
    if (opening.gap) this.sendFrame(server, opening.gap);
    for (const record of records) {
      this.sendFrame(server, { type: "record", ...record });
    }
    this.warned.delete(server);

    // Storage flushes a lagging Convex index projection here: a connect is the
    // only signal that arrives for a conversation whose last index write 5xx'd
    // and whose next turn may never come.
    try {
      this.deps.onConnect();
    } catch (error) {
      this.deps.log("error", "conversation_on_connect_failed", {
        conversationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    this.deps.log("info", "conversation_socket_opened", {
      conversationId,
      headSeq: fresh.headSeq,
      delivered: records.length,
      reset: opening.reset ?? undefined,
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": SUBPROTOCOL },
    });
  }

  /**
   * Free a slot if one can be freed, and report whether the newcomer fits.
   * Reaping is lazy — on this path and on real events only — because a sweep
   * timer would be exactly the kind of idle cost hibernation exists to avoid.
   */
  private reserveSocketSlot(): boolean {
    let sockets = this.deps.ctx.getWebSockets();
    if (sockets.length < MAX_SOCKETS_PER_CONVERSATION) return true;
    const now = Date.now();

    // Reaping is MINIMAL and ordered, not a sweep. A client's keepalive `ping`
    // is the only liveness signal there is, and a backgrounded client is told
    // not to send one — so "no recent ping" does not prove a socket is dead.
    // Closing every silent socket would let one new tab kill fifteen live ones.
    // Instead: rank by staleness, close oldest-first, and stop the moment the
    // newcomer fits.
    const candidates = sockets
      .map((ws) => {
        const seen = this.deps.ctx.getWebSocketAutoResponseTimestamp(ws);
        return {
          ws,
          lastAliveMs:
            seen?.getTime() ?? readAttachment(ws)?.connectedAtMs ?? now,
        };
      })
      .filter((entry) => now - entry.lastAliveMs > SOCKET_STALE_MS)
      .sort((a, b) => a.lastAliveMs - b.lastAliveMs);

    let freed = 0;
    const needed = sockets.length - MAX_SOCKETS_PER_CONVERSATION + 1;
    for (const entry of candidates) {
      if (freed >= needed) break;
      try {
        entry.ws.close(1001, "stale");
        freed += 1;
      } catch {
        // Already gone; it frees a slot either way.
        freed += 1;
      }
    }
    sockets = this.deps.ctx.getWebSockets();
    return sockets.length < MAX_SOCKETS_PER_CONVERSATION;
  }

  private async openingWindow(
    head: JournalHead,
    sinceRaw: string | null,
    epochRaw: string | null,
  ): Promise<{
    records: JournalRecord[];
    reset: "epoch" | "window" | null;
    gap: GapFrame | null;
  }> {
    const newest = () => ({
      records: this.deps.reader.newest(INITIAL_WINDOW_RECORDS),
      reset: null as "epoch" | "window" | null,
      gap: null as GapFrame | null,
    });
    if (sinceRaw === null) return newest();
    const since = Number(sinceRaw);
    if (!Number.isFinite(since) || !Number.isInteger(since) || since < -1) {
      return newest();
    }
    if (epochRaw !== null && Number(epochRaw) !== head.epoch) {
      return { ...newest(), reset: "epoch" };
    }
    // The client claims a seq we never allocated: its cache belongs to a
    // previous incarnation of this object.
    if (since > head.headSeq) return { ...newest(), reset: "epoch" };
    if (since + 1 < head.floorSeq) return { ...newest(), reset: "window" };
    if (since >= head.headSeq) {
      return { records: [], reset: null, gap: null };
    }
    const range = await this.deps.reader.readRange(
      since + 1,
      head.headSeq,
      MAX_RESUME_RECORDS,
    );
    const gap =
      range.missingBelowSeq !== undefined && range.missingBelowSeq > since + 1
        ? ({
            type: "gap",
            fromSeq: since + 1,
            toSeq: range.missingBelowSeq - 1,
            reason: "compacted",
          } satisfies GapFrame)
        : null;
    return { records: range.records, reset: null, gap };
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  private rawSend(ws: WebSocket, payload: string): void {
    try {
      ws.send(payload);
    } catch {
      // A closing socket throws on send. There is nothing to do and nothing
      // to report: the client will reconnect and resume from its own cursor.
    }
  }

  private sendFrame(ws: WebSocket, frame: ServerFrame): void {
    this.sendSerialized(ws, JSON.stringify(frame));
  }

  /**
   * The single enforcement point for token expiry. Doing it here rather than on
   * a timer is what keeps an idle conversation free: expiry can only ever
   * revoke a send that was about to happen, never grant one, and a socket that
   * is sending nothing needs no supervision.
   */
  private sendSerialized(ws: WebSocket, payload: string): void {
    const attachment = readAttachment(ws);
    if (!attachment) {
      try {
        ws.close(CLOSE_INTERNAL, closeReason(CLOSE_INTERNAL));
      } catch {
        // Already gone.
      }
      return;
    }
    const now = Date.now();
    if (now > attachment.authExpiresAtMs + AUTH_GRACE_MS) {
      this.rawSend(
        ws,
        JSON.stringify({
          type: "error",
          code: "token_expired",
          message: "Your session needs a refresh. Reconnecting…",
          retryable: true,
        } satisfies ErrorFrame),
      );
      try {
        ws.close(CLOSE_UNAUTHENTICATED, "token_expired");
      } catch {
        // Already gone.
      }
      return;
    }
    if (
      now > attachment.authExpiresAtMs - RE_AUTH_LEAD_MS &&
      this.warned.get(ws) !== attachment.authExpiresAtMs
    ) {
      this.warned.set(ws, attachment.authExpiresAtMs);
      this.rawSend(
        ws,
        JSON.stringify({
          type: "auth.expiring",
          atMs: attachment.authExpiresAtMs,
        } satisfies AuthExpiringFrame),
      );
    }
    this.rawSend(ws, payload);
  }

  /** Serialized once, not once per listener: a delta frame is up to 2 KB. */
  private broadcast(frame: ServerFrame): void {
    const sockets = this.deps.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const payload = JSON.stringify(frame);
    for (const ws of sockets) this.sendSerialized(ws, payload);
  }

  // ── Records ──────────────────────────────────────────────────────────────

  broadcastRecord(record: JournalRecord): void {
    try {
      // The committed row supersedes whatever was previewed for its stream:
      // drop the pending deltas rather than racing them against it.
      if (record.kind === "message" && record.streamId) {
        this.discardStream(record.streamId);
      }
      if (record.kind === "turn" && record.phase === "started") {
        this.turnState(record.turnId);
      }
      this.broadcast({ type: "record", ...record });
      // Storage also calls endTurn explicitly. Doing it here as well costs
      // nothing (it is idempotent) and means a missed call upstream leaks a
      // delta budget and a timer rather than being invisible until a long
      // conversation starts dropping previews for no apparent reason.
      if (record.kind === "turn" && record.phase !== "started") {
        this.endTurn(record.turnId);
      }
    } catch (error) {
      this.deps.log("error", "conversation_broadcast_failed", {
        conversationId: this.deps.conversationId(),
        seq: record.seq,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Deltas ───────────────────────────────────────────────────────────────

  broadcastDelta(delta: DeltaInput): void {
    try {
      const turn = this.turnState(delta.turnId);
      const stream = this.streamState(delta);
      turn.latestStreamId = delta.streamId;
      this.appendLive(stream, delta.text);

      // Nobody is watching: keep the preview for a future joiner, but never
      // arm a timer or buffer bytes for an audience that does not exist.
      if (this.deps.ctx.getWebSockets().length === 0) return;

      if (turn.dropped) return;
      const bytes = utf8Length(delta.text);
      if (turn.spentBytes + bytes > DELTA_BUDGET_BYTES) {
        turn.dropped = true;
        this.flushStream(stream);
        this.broadcast({
          type: "deltas_dropped",
          turnId: delta.turnId,
          streamId: delta.streamId,
        });
        return;
      }
      turn.spentBytes += bytes;
      stream.pending += delta.text;
      stream.pendingBytes += bytes;
      if (stream.pendingBytes >= DELTA_FLUSH_BYTES) {
        this.flushStream(stream);
        return;
      }
      if (stream.timer === null) {
        stream.timer = setTimeout(() => {
          stream.timer = null;
          this.flushStream(stream);
        }, DELTA_FLUSH_MS);
      }
    } catch (error) {
      this.deps.log("error", "conversation_delta_failed", {
        turnId: delta.turnId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  broadcastTool(tool: ToolInput): void {
    try {
      const turn = this.turnState(tool.turnId);
      if (tool.phase === "end") turn.tools.delete(tool.toolCallId);
      else {
        if (turn.tools.size >= MAX_TRACKED_TOOLS) {
          const oldest = turn.tools.keys().next();
          if (!oldest.done) turn.tools.delete(oldest.value);
        }
        turn.tools.set(tool.toolCallId, tool);
      }
      this.broadcast({ type: "tool", ...tool });
    } catch (error) {
      this.deps.log("error", "conversation_tool_frame_failed", {
        turnId: tool.turnId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  endTurn(turnId: string): void {
    try {
      const turn = this.turns.get(turnId);
      if (!turn) return;
      for (const streamId of turn.streamIds) this.discardStream(streamId);
      this.turns.delete(turnId);
    } catch {
      // Teardown of advisory state can never be allowed to fail a turn.
    }
  }

  private turnState(turnId: string): TurnStreamState {
    const existing = this.turns.get(turnId);
    if (existing) return existing;
    while (this.turns.size >= MAX_TRACKED_TURNS) {
      const oldest = this.turns.keys().next();
      if (oldest.done) break;
      this.endTurn(oldest.value);
    }
    const created: TurnStreamState = {
      turnId,
      spentBytes: 0,
      dropped: false,
      streamIds: new Set(),
      tools: new Map(),
      latestStreamId: null,
    };
    this.turns.set(turnId, created);
    return created;
  }

  private streamState(delta: DeltaInput): StreamState {
    const existing = this.streams.get(delta.streamId);
    if (existing) return existing;
    while (this.streams.size >= MAX_TRACKED_STREAMS) {
      const oldest = this.streams.keys().next();
      if (oldest.done) break;
      this.discardStream(oldest.value);
    }
    const created: StreamState = {
      turnId: delta.turnId,
      streamId: delta.streamId,
      kind: delta.kind,
      ordinal: 0,
      pending: "",
      pendingBytes: 0,
      timer: null,
      live: "",
      liveTruncated: false,
    };
    this.streams.set(delta.streamId, created);
    this.turnState(delta.turnId).streamIds.add(delta.streamId);
    return created;
  }

  /**
   * Keeps the HEAD of the reply rather than the tail: a mid-turn joiner reads
   * a preview from the beginning, and the committed record — which carries the
   * whole thing — is what replaces it moments later.
   */
  private appendLive(stream: StreamState, text: string): void {
    if (stream.liveTruncated) return;
    const room = LIVE_PARTIAL_MAX_CHARS - stream.live.length;
    if (room <= 0) {
      stream.liveTruncated = true;
      return;
    }
    if (text.length <= room) {
      stream.live += text;
      return;
    }
    stream.live += text.slice(0, room);
    stream.liveTruncated = true;
  }

  private flushStream(stream: StreamState): void {
    if (stream.timer !== null) {
      clearTimeout(stream.timer);
      stream.timer = null;
    }
    if (stream.pending.length === 0) return;
    const text = stream.pending;
    stream.pending = "";
    stream.pendingBytes = 0;
    stream.ordinal += 1;
    this.broadcast({
      type: "delta",
      turnId: stream.turnId,
      streamId: stream.streamId,
      ordinal: stream.ordinal,
      kind: stream.kind,
      text,
    });
  }

  private discardStream(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    if (stream.timer !== null) {
      clearTimeout(stream.timer);
      stream.timer = null;
    }
    this.streams.delete(streamId);
    this.turns.get(stream.turnId)?.streamIds.delete(streamId);
  }

  /**
   * Storage is authoritative for whether a turn is live. The hub only fills in
   * what storage cannot know across an eviction: the streamed preview and the
   * open tool calls, both of which are in-memory by design.
   */
  private liveSnapshot(): LiveTurnSnapshot | null {
    const live = this.deps.reader.liveTurn();
    if (!live) return null;
    const turn = this.turns.get(live.turnId);
    const streamId = live.streamId ?? turn?.latestStreamId ?? null;
    const stream = streamId ? this.streams.get(streamId) : undefined;
    const partialText =
      live.partialText || (stream ? stream.live + stream.pending : "");
    const tools =
      live.tools.length > 0 ? live.tools : [...(turn?.tools.values() ?? [])];
    return { turnId: live.turnId, streamId, partialText, tools };
  }

  // ── Incoming ─────────────────────────────────────────────────────────────

  async onMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      await this.handleMessage(ws, message);
    } catch (error) {
      this.deps.log("error", "conversation_socket_message_failed", {
        conversationId: this.deps.conversationId(),
        message: error instanceof Error ? error.message : String(error),
      });
      this.closeWith(
        ws,
        CLOSE_INTERNAL,
        "Something went wrong on that request. Reconnecting…",
        true,
      );
    }
  }

  private async handleMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // "ping" never arrives here — the platform auto-response answers it
    // without waking the object. Anything binary is not part of this protocol.
    if (typeof message !== "string") {
      this.closeWith(ws, CLOSE_BAD_REQUEST, "Unsupported message.");
      return;
    }
    // Char count first because it is free and, since UTF-8 bytes are never
    // fewer than chars, it rejects every oversized frame without scanning one.
    if (
      message.length > MAX_INCOMING_FRAME_BYTES ||
      utf8Length(message) > MAX_INCOMING_FRAME_BYTES
    ) {
      this.closeWith(ws, CLOSE_FRAME_TOO_LARGE, "That request was too large.");
      return;
    }
    const attachment = readAttachment(ws);
    if (!attachment) {
      this.closeWith(
        ws,
        CLOSE_INTERNAL,
        "This connection lost its session. Reconnecting…",
        true,
      );
      return;
    }
    const now = Date.now();
    rollRateWindow(attachment, now);
    attachment.rateTotal += 1;
    if (attachment.rateTotal > RATE_TOTAL_PER_MIN) {
      this.closeWith(
        ws,
        CLOSE_RATE_LIMITED,
        "Too many requests. Reconnecting in a moment.",
        true,
      );
      return;
    }

    let frame: ClientFrame;
    try {
      frame = JSON.parse(message) as ClientFrame;
    } catch {
      this.closeWith(ws, CLOSE_BAD_REQUEST, "Unreadable message.");
      return;
    }
    if (typeof frame !== "object" || frame === null) {
      this.closeWith(ws, CLOSE_BAD_REQUEST, "Unreadable message.");
      return;
    }

    switch (frame.type) {
      case "auth": {
        attachment.rateAuth += 1;
        if (attachment.rateAuth > RATE_AUTH_PER_MIN) {
          this.closeWith(
            ws,
            CLOSE_RATE_LIMITED,
            "Too many sign-in refreshes. Reconnecting in a moment.",
            true,
          );
          return;
        }
        ws.serializeAttachment(attachment);
        await this.handleAuth(ws, attachment, frame.token);
        return;
      }
      case "backfill": {
        attachment.rateBackfill += 1;
        if (attachment.rateBackfill > RATE_BACKFILL_PER_MIN) {
          this.closeWith(
            ws,
            CLOSE_RATE_LIMITED,
            "Too many history requests. Reconnecting in a moment.",
            true,
          );
          return;
        }
        ws.serializeAttachment(attachment);
        await this.handleBackfill(ws, frame);
        return;
      }
      case "cancel": {
        attachment.rateCancel += 1;
        if (attachment.rateCancel > RATE_CANCEL_PER_MIN) {
          this.closeWith(
            ws,
            CLOSE_RATE_LIMITED,
            "Too many stop requests. Reconnecting in a moment.",
            true,
          );
          return;
        }
        ws.serializeAttachment(attachment);
        await this.handleCancel(ws, frame);
        return;
      }
      default:
        this.closeWith(ws, CLOSE_BAD_REQUEST, "Unsupported message.");
    }
  }

  private async handleAuth(
    ws: WebSocket,
    attachment: SocketAttachment,
    token: unknown,
  ): Promise<void> {
    if (typeof token !== "string" || token.length === 0) {
      this.closeWith(ws, CLOSE_BAD_REQUEST, "Missing sign-in token.");
      return;
    }
    if (!attachment.issuer) {
      this.deps.log("error", "conversation_reauth_no_issuer", {
        conversationId: this.deps.conversationId(),
      });
      this.closeWith(
        ws,
        CLOSE_INTERNAL,
        "Stella couldn't refresh this session. Reconnecting…",
        true,
      );
      return;
    }
    const verified = await verifyConvexToken(token, attachment.issuer);
    if (!verified.ok) {
      this.deps.log("error", "conversation_reauth_rejected", {
        conversationId: this.deps.conversationId(),
        reason: verified.reason,
      });
      this.closeWith(
        ws,
        verified.retryable ? CLOSE_INTERNAL : CLOSE_UNAUTHENTICATED,
        verified.retryable
          ? "Stella couldn't refresh this session. Reconnecting…"
          : "Your session needs a refresh. Reconnecting…",
        true,
      );
      return;
    }
    // A socket must never change identity mid-life. Anything else would let a
    // second user's token silently inherit an already-authorized stream.
    if (
      verified.token.subject !== attachment.subject ||
      verified.token.ownerId !== attachment.ownerId
    ) {
      this.closeWith(ws, CLOSE_FORBIDDEN, "That sign-in doesn't match.");
      return;
    }
    attachment.authExpiresAtMs = verified.token.expiresAtMs;
    ws.serializeAttachment(attachment);
    this.warned.delete(ws);
  }

  private async handleBackfill(
    ws: WebSocket,
    frame: { requestId?: unknown; fromSeq?: unknown; toSeq?: unknown },
  ): Promise<void> {
    const requestId =
      typeof frame.requestId === "string" ? frame.requestId.slice(0, 64) : "";
    const fromRaw = Number(frame.fromSeq);
    const toRaw = Number(frame.toSeq);
    if (!requestId || !Number.isInteger(fromRaw) || !Number.isInteger(toRaw)) {
      this.closeWith(ws, CLOSE_BAD_REQUEST, "Malformed history request.");
      return;
    }
    const head = this.deps.reader.head();
    let from = Math.max(0, fromRaw);
    const to = Math.min(toRaw, head.headSeq);
    if (from > to) {
      this.sendFrame(ws, {
        type: "backfill",
        requestId,
        fromSeq: from,
        toSeq: to,
        complete: true,
        records: [],
      });
      return;
    }
    if (from < head.floorSeq) {
      this.sendFrame(ws, {
        type: "gap",
        fromSeq: from,
        toSeq: Math.min(to, head.floorSeq - 1),
        reason: "compacted",
      });
      from = head.floorSeq;
      if (from > to) {
        this.sendFrame(ws, {
          type: "backfill",
          requestId,
          fromSeq: from,
          toSeq: to,
          complete: true,
          records: [],
        });
        return;
      }
    }
    const range = await this.deps.reader.readRange(
      from,
      to,
      BACKFILL_BATCH_RECORDS,
    );
    if (range.missingBelowSeq !== undefined && range.missingBelowSeq > from) {
      this.sendFrame(ws, {
        type: "gap",
        fromSeq: from,
        toSeq: range.missingBelowSeq - 1,
        reason: "compacted",
      });
    }
    // The frame is capped here regardless of what the reader returns: a
    // batch limit expressed only in rows says nothing about a transcript of
    // large tool results.
    const records: JournalRecord[] = [];
    let bytes = 0;
    let truncated = false;
    for (const record of range.records) {
      const size = utf8Length(JSON.stringify(record));
      // Always emit at least one record even if it alone blows the budget:
      // a batch that can return nothing is a client that retries forever.
      if (records.length > 0 && bytes + size > BACKFILL_BATCH_BYTES) {
        truncated = true;
        break;
      }
      bytes += size;
      records.push(record);
    }
    const last = records.length > 0 ? records[records.length - 1]!.seq : to;
    this.sendFrame(ws, {
      type: "backfill",
      requestId,
      fromSeq: from,
      toSeq: last,
      complete: range.complete && !truncated,
      records,
    });
  }

  private async handleCancel(
    ws: WebSocket,
    frame: { turnId?: unknown },
  ): Promise<void> {
    const turnId =
      typeof frame.turnId === "string" ? frame.turnId.slice(0, 128) : "";
    if (!turnId) {
      this.closeWith(ws, CLOSE_BAD_REQUEST, "Malformed stop request.");
      return;
    }
    try {
      await this.deps.cancelTurn(turnId);
    } catch (error) {
      this.deps.log("error", "conversation_cancel_failed", {
        conversationId: this.deps.conversationId(),
        turnId,
        message: error instanceof Error ? error.message : String(error),
      });
      this.sendFrame(ws, {
        type: "error",
        code: "cancel_failed",
        message: "Stella couldn't stop that. Try again.",
        retryable: true,
      });
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async onClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    wasClean: boolean,
  ): Promise<void> {
    // Completes the closing handshake from our side. 1006 is synthetic and
    // 1001–1015 are reserved for the protocol itself, so anything that is not
    // one of ours (3000–4999) goes back as a plain 1000.
    try {
      ws.close(code >= 3000 && code <= 4999 ? code : 1000, "");
    } catch {
      // Already closed; the accounting below is the only thing left to do.
    }
    this.warned.delete(ws);
    if (!wasClean) {
      this.deps.log("info", "conversation_socket_closed", {
        conversationId: this.deps.conversationId(),
        code,
        clean: false,
      });
    }
  }

  async onError(ws: WebSocket, error: unknown): Promise<void> {
    this.warned.delete(ws);
    this.deps.log("error", "conversation_socket_error", {
      conversationId: this.deps.conversationId(),
      message: error instanceof Error ? error.message : String(error),
    });
  }

  closeAll(code: number): void {
    for (const ws of this.deps.ctx.getWebSockets()) {
      this.closeWith(
        ws,
        code,
        code === CLOSE_DELETED
          ? "This conversation was deleted."
          : "This connection was closed.",
      );
    }
    for (const streamId of [...this.streams.keys()]) {
      this.discardStream(streamId);
    }
    this.turns.clear();
  }

  /**
   * Human text always goes in an `error` frame first; the close reason is
   * capped at 123 bytes and carries the code only. No raw provider or
   * infrastructure string ever reaches either one.
   */
  private closeWith(
    ws: WebSocket,
    code: number,
    message: string,
    retryable = false,
  ): void {
    this.rawSend(
      ws,
      JSON.stringify({
        type: "error",
        code: closeReason(code),
        message,
        retryable,
      } satisfies ErrorFrame),
    );
    try {
      ws.close(code, closeReason(code));
    } catch {
      // Already gone.
    }
    this.warned.delete(ws);
  }
}

// Importing this module is what turns the socket layer on; without it the DO
// falls back to NullConversationHub and keeps every non-socket behaviour.
registerConversationHubFactory((deps: ConversationHubDeps) =>
  new ConversationHubImpl(deps),
);

export const createConversationHubImpl = (
  deps: ConversationHubDeps,
): ConversationHub => new ConversationHubImpl(deps);
