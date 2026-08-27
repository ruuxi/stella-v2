/**
 * The conversation transport: one WebSocket to the conversation's Durable
 * Object, which owns the transcript.
 *
 * Framework-free on purpose — no React here. This module's whole job is to
 * turn a lossy, reconnecting socket into an ordered, gapless record stream,
 * and to say plainly when it cannot.
 *
 * Three properties it is responsible for:
 *  - exactly once: `seq` is gapless by construction, so a replayed record is
 *    dropped by comparison and a missing one is fetched by `backfill`. There
 *    is no dedup heuristic anywhere.
 *  - never silently wrong: everything outside the server's window arrives as
 *    an explicit `gap` or `reset`, never as an absence.
 *  - client-quiet: the DO bills incoming frames 20:1 against free outgoing
 *    ones, so this client sends nothing on a healthy connection. No
 *    heartbeat, no acks, no send verb.
 */

import {
  BACKFILL_BATCH_RECORDS,
  INITIAL_WINDOW_RECORDS,
  MAX_BUFFERED_AHEAD,
  MAX_RESUME_RECORDS,
  PROTOCOL_VERSION,
  RATE_BACKFILL_PER_MIN,
  RE_AUTH_LEAD_MS,
  SOCKET_STALE_MS,
  TERMINAL_CLOSE_CODES,
  decodeServerFrame,
  isSubprotocolSafe,
  type JournalRecord,
  type ReadyFrame,
  type ServerFrame,
} from "./cloud-conversation-protocol";

export type SocketStatus =
  | "idle"
  | "connecting"
  | "live"
  | "offline"
  | "blocked";

export type SocketStatusEvent = {
  type: "status";
  status: SocketStatus;
  /** Readable, already user-safe. Never a provider or infrastructure string. */
  message?: string;
  /** False means the client has stopped retrying and needs an explicit retry. */
  retryable: boolean;
};

export type ConversationSocketEvent =
  | { type: "ready"; ready: ReadyFrame }
  | { type: "records"; records: JournalRecord[] }
  | {
      type: "older";
      records: JournalRecord[];
      complete?: boolean;
      fromSeq?: number;
      toSeq?: number;
    }
  | { type: "reset"; reason: string }
  | { type: "gap"; fromSeq: number; toSeq: number }
  | Extract<ServerFrame, { type: "delta" }>
  | Extract<ServerFrame, { type: "tool" }>
  | Extract<ServerFrame, { type: "deltas_dropped" }>
  | SocketStatusEvent;

export type ConversationSocketOptions = {
  conversationId: string;
  /** Builder origin, e.g. `https://stella-v2-cloud-builder-dev…workers.dev`. */
  baseUrl: string;
  /** Resolves the owner's Convex JWT. `forceRefresh` bypasses every cache. */
  getToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  /** Native lifecycle gate. Background sockets may lapse and reconnect later. */
  isActive?: () => boolean;
  onEvent: (event: ConversationSocketEvent) => void;
};

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 250;
/** Live this long continuously and the next drop starts from zero again. */
const BACKOFF_RESET_MS = 30_000;
/** How long a `ready` may claim records the server then does not send. */
const RESUME_GRACE_MS = 1_500;
/** Consecutive no-progress repairs before the transcript fails explicitly. */
const MAX_NO_PROGRESS_BACKFILLS = 3;
/** How long a liveness probe waits for the auto-response before giving up. */
const PROBE_TIMEOUT_MS = 5_000;
/**
 * Keepalive cadence. Under `SOCKET_STALE_MS` (90 s) with room for a missed
 * beat, and answered by the DO's hibernation auto-response — so it stamps the
 * server's liveness clock without waking the object.
 */
const KEEPALIVE_INTERVAL_MS = 30_000;

/** Readable text for the close codes the server can send us. */
const closeMessage = (code: number): string => {
  switch (code) {
    case 4400:
      return "Stella could not read this conversation request.";
    case 4401:
      return "Your session expired. Reconnecting…";
    case 4403:
      return "This conversation belongs to another account.";
    case 4404:
      return "This conversation is no longer available.";
    case 4409:
      return "Stella was updated. Reload to keep chatting.";
    case 4410:
      return "This conversation was deleted.";
    case 4413:
      return "This conversation contains data this app cannot safely load.";
    case 4429:
      return "Too many requests. Reconnecting…";
    case 4503:
      return "Too many devices are watching this conversation.";
    default:
      return "Lost the connection to Stella. Reconnecting…";
  }
};

/**
 * A refilling budget for outgoing `backfill` frames. The server closes a
 * socket that exceeds its own limit, so the client stays under it rather than
 * discovering it: scrollback keeps a reserve so a gap can always be filled.
 */
class BackfillBudget {
  private tokens = RATE_BACKFILL_PER_MIN;
  private refilledAt = Date.now();

  private refill(): void {
    const now = Date.now();
    const gained = ((now - this.refilledAt) / 60_000) * RATE_BACKFILL_PER_MIN;
    if (gained >= 1) {
      this.tokens = Math.min(RATE_BACKFILL_PER_MIN, this.tokens + gained);
      this.refilledAt = now;
    }
  }

  take(reserve: number): boolean {
    this.refill();
    if (this.tokens < 1 + reserve) return false;
    this.tokens -= 1;
    return true;
  }
}

export class ConversationSocket {
  private readonly options: ConversationSocketOptions;
  private socket: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private reauthTimer: ReturnType<typeof setTimeout> | null = null;
  /** Observed token window minus the lead, learned from `ready`. */
  private reauthPeriodMs = 0;
  private liveSinceMs = 0;
  private lastFrameAtMs = 0;
  private status: SocketStatus = "idle";

  /** Highest contiguous seq applied. -1 until the first record lands. */
  private lastSeq = -1;
  private epoch: number | null = null;
  private headSeq = -1;
  private windowStartSeq = 0;
  /** Lowest seq that still exists anywhere. Below it, backfill cannot help. */
  private floorSeq = 0;
  private readonly ahead = new Map<number, JournalRecord>();
  private gapPending = false;
  private noProgressBackfills = 0;
  private requestCounter = 0;
  private readonly olderRequests = new Map<
    string,
    {
      fromSeq: number;
      toSeq: number;
      nextSeq: number;
      records: JournalRecord[];
    }
  >();
  private readonly budget = new BackfillBudget();
  /** One free reconnect after a 4401 — a fresh token usually fixes it. */
  private authRetryUsed = false;
  private reauthInFlight = false;
  private connecting = false;

  constructor(options: ConversationSocketOptions) {
    this.options = options;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close(1000, "client");
      } catch {
        // Already closing; nothing to do.
      }
    }
    this.setStatus("idle", { retryable: true });
  }

  /** Explicit user retry after the client stopped on its own. */
  retryNow(): void {
    this.attempt = 0;
    this.authRetryUsed = false;
    this.noProgressBackfills = 0;
    if (this.stopped) {
      this.start();
      return;
    }
    if (
      this.connecting ||
      (this.socket &&
        (this.socket.readyState === WebSocket.OPEN ||
          this.socket.readyState === WebSocket.CONNECTING))
    ) {
      return;
    }
    this.clearTimers();
    this.connect();
  }

  /** The cursor a caller needs to know how far back it can already see. */
  get cursor(): {
    lastSeq: number;
    windowStartSeq: number;
    headSeq: number;
    floorSeq: number;
  } {
    return {
      lastSeq: this.lastSeq,
      windowStartSeq: this.windowStartSeq,
      headSeq: this.headSeq,
      floorSeq: this.floorSeq,
    };
  }

  /**
   * Ask for a range strictly below what the caller already holds. Scrollback,
   * never gap repair — the reply arrives as an `older` event and does not move
   * the head cursor.
   */
  requestOlder(oldestHeldSeq: number): boolean {
    if (oldestHeldSeq <= this.floorSeq) return false;
    const toSeq = oldestHeldSeq - 1;
    const fromSeq = Math.max(this.floorSeq, toSeq - BACKFILL_BATCH_RECORDS + 1);
    if (!this.budget.take(4)) return false;
    const requestId = this.nextRequestId("o");
    if (!this.send({ type: "backfill", requestId, fromSeq, toSeq })) {
      return false;
    }
    this.olderRequests.set(requestId, {
      fromSeq,
      toSeq,
      nextSeq: fromSeq,
      records: [],
    });
    return true;
  }

  cancelTurn(turnId: string): boolean {
    return this.send({ type: "cancel", turnId });
  }

  /**
   * Nudge after the environment says the world may have changed (network back,
   * tab visible). A closed socket reconnects immediately; an open one that has
   * heard nothing for a while is probed with the DO's auto-response, which
   * answers without waking it.
   */
  wake(): void {
    if (this.stopped) return;
    const socket = this.socket;
    if (this.connecting || socket?.readyState === WebSocket.CONNECTING) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.attempt = 0;
      this.clearTimers();
      this.connect();
      return;
    }
    if (Date.now() - this.lastFrameAtMs < SOCKET_STALE_MS) return;
    try {
      socket.send("ping");
    } catch {
      this.forceReconnect();
      return;
    }
    if (this.probeTimer) clearTimeout(this.probeTimer);
    const probedAt = this.lastFrameAtMs;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.lastFrameAtMs === probedAt) this.forceReconnect();
    }, PROBE_TIMEOUT_MS);
  }

  // ---------------------------------------------------------------- internals

  private nextRequestId(prefix: string): string {
    this.requestCounter += 1;
    return `${prefix}${this.requestCounter}`;
  }

  private setStatus(
    status: SocketStatus,
    detail: { message?: string; retryable: boolean },
  ): void {
    if (
      this.status === status &&
      status !== "blocked" &&
      detail.message === undefined
    ) {
      return;
    }
    this.status = status;
    this.options.onEvent({
      type: "status",
      status,
      ...(detail.message ? { message: detail.message } : {}),
      retryable: detail.retryable,
    });
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.reauthTimer) clearTimeout(this.reauthTimer);
    this.reconnectTimer = null;
    this.resumeTimer = null;
    this.probeTimer = null;
    this.keepaliveTimer = null;
    this.reauthTimer = null;
  }

  /**
   * Refresh the token before it lapses, on the client's own clock.
   *
   * The server's `auth.expiring` is only a backstop: it is emitted on the send
   * path, so a socket that happens to be idle across the token's lifetime is
   * never warned, lapses, and turns the next wake or scheduled reply into a
   * 4401 and a reconnect. The period is learned from `ready` rather than
   * hardcoded, so a deployment that changes the JWT lifetime needs no client
   * change.
   *
   * Backgrounded clients deliberately do NOT refresh — letting an unwatched
   * socket lapse and reconnect on demand is what keeps an idle conversation
   * free. The cost while foregrounded is ~12 frames an hour, which is the
   * protocol's own budget for this.
   */
  private scheduleReauth(delayMs: number): void {
    if (this.reauthTimer) clearTimeout(this.reauthTimer);
    if (this.reauthPeriodMs <= 0) return;
    this.reauthTimer = setTimeout(
      () => {
        this.reauthTimer = null;
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        if (this.options.isActive?.() ?? true) {
          void this.reauthenticate();
        }
        this.scheduleReauth(this.reauthPeriodMs);
      },
      Math.max(1_000, delayMs),
    );
  }

  /**
   * A slow keepalive, and the only reason the server can tell a live socket
   * from an abandoned one.
   *
   * The DO answers `ping` from its hibernation auto-response, so this never
   * wakes the object and never reaches application code — but it does stamp
   * `getWebSocketAutoResponseTimestamp`, which is what the socket-cap reaper
   * ranks on. Without it every socket looks equally stale and a 17th tab would
   * evict a live one.
   *
   * Foreground only: a backgrounded client is meant to let its socket lapse and
   * reconnect on demand, which is what keeps an idle conversation free. The
   * interval is comfortably under `SOCKET_STALE_MS` so one dropped beat is not
   * mistaken for a dead peer.
   */
  private startKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (!(this.options.isActive?.() ?? true)) return;
      // Any recent traffic already refreshed the timestamp; a streaming turn
      // must not also pay for a beat.
      if (Date.now() - this.lastFrameAtMs < KEEPALIVE_INTERVAL_MS) return;
      try {
        socket.send("ping");
      } catch {
        // The close handler owns reconnection; a failed beat is not an event.
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.setStatus("connecting", { retryable: true });
    let token: string | null = null;
    try {
      token = await this.options.getToken({ forceRefresh: this.attempt > 0 });
    } catch {
      token = null;
    }
    if (this.stopped) {
      this.connecting = false;
      return;
    }
    if (!token || !isSubprotocolSafe(token)) {
      // Signing in produces a token; retrying is the only sane response, and
      // the backoff keeps a signed-out client from spinning.
      this.connecting = false;
      this.scheduleReconnect("Waiting for your session…");
      return;
    }

    const url = new URL(
      `/conversations/${encodeURIComponent(this.options.conversationId)}/socket`,
      this.options.baseUrl,
    );
    // Convex already hands out a `ws:`/`wss:` origin; these two lines only
    // cover a caller that passed the http form. Blanket-forcing `wss:` would
    // break a local `ws://localhost` builder.
    if (url.protocol === "http:") url.protocol = "ws:";
    else if (url.protocol === "https:") url.protocol = "wss:";
    url.searchParams.set("protocol", String(PROTOCOL_VERSION));
    // `since` is a cursor, not a lower bound: the server replays
    // `(since, headSeq]`, and `since >= headSeq` sends nothing at all. Omitting
    // it entirely is what asks for a fresh newest-window.
    if (this.lastSeq >= 0) url.searchParams.set("since", String(this.lastSeq));
    if (this.epoch !== null) url.searchParams.set("epoch", String(this.epoch));

    let socket: WebSocket;
    try {
      socket = new WebSocket(url.toString(), [
        "stella.v1",
        `stella.token.${token}`,
      ]);
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.lastFrameAtMs = Date.now();

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.lastFrameAtMs = Date.now();
      this.startKeepalive();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.lastFrameAtMs = Date.now();
      if (typeof event.data !== "string") return;
      // The DO's hibernation auto-response answers "ping" with a bare "pong".
      if (event.data === "pong") return;
      const frame = decodeServerFrame(event.data);
      if (frame) this.handleFrame(frame);
    };
    socket.onerror = () => {
      // Browsers deliberately give no detail here; `onclose` carries the code.
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.handleClose(event.code);
    };
    this.connecting = false;
  }

  private send(frame: object): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private forceReconnect(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onopen = null;
      try {
        socket.close(1000, "resync");
      } catch {
        // Already closing.
      }
    }
    this.clearTimers();
    if (!this.stopped) this.connect();
  }

  private handleClose(code: number): void {
    this.clearTimers();
    this.gapPending = false;
    this.noProgressBackfills = 0;
    this.ahead.clear();
    this.olderRequests.clear();
    if (Date.now() - this.liveSinceMs > BACKOFF_RESET_MS && this.liveSinceMs) {
      this.attempt = 0;
    }
    this.liveSinceMs = 0;

    if (TERMINAL_CLOSE_CODES.has(code)) {
      this.stopped = true;
      this.setStatus("blocked", {
        message: closeMessage(code),
        retryable: code === 4409,
      });
      return;
    }
    if (code === 4401) {
      if (this.authRetryUsed) {
        this.stopped = true;
        this.setStatus("blocked", {
          message: "Stella could not verify your session. Sign in again.",
          retryable: true,
        });
        return;
      }
      this.authRetryUsed = true;
      this.attempt = Math.max(this.attempt, 1);
    }
    this.scheduleReconnect(code === 1000 ? undefined : closeMessage(code));
  }

  private scheduleReconnect(message?: string): void {
    if (this.stopped) return;
    this.setStatus("offline", {
      ...(message ? { message } : {}),
      retryable: true,
    });
    const ceiling = Math.min(
      MAX_BACKOFF_MS,
      BASE_BACKOFF_MS * 2 ** Math.min(this.attempt, 10),
    );
    // Full jitter: every client picks a different point in the window, so a
    // DO that just evicted does not get every watcher back at the same ms.
    const delay = Math.random() * ceiling;
    this.attempt += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case "ready":
        this.handleReady(frame);
        return;
      case "record":
        this.applyRecord(frame);
        return;
      case "backfill":
        this.handleBackfill(frame);
        return;
      case "gap":
        this.options.onEvent({
          type: "gap",
          fromSeq: frame.fromSeq,
          toSeq: frame.toSeq,
        });
        return;
      case "reset":
        this.resetStream(frame.reason);
        return;
      case "delta":
      case "tool":
      case "deltas_dropped":
        this.options.onEvent(frame);
        return;
      case "auth.expiring":
        void this.reauthenticate();
        return;
      case "error":
        // Advisory: the close frame (if any) carries the outcome. Surface the
        // text so a non-fatal server complaint is still visible.
        this.setStatus(this.status === "live" ? "live" : "offline", {
          message: frame.message,
          retryable: frame.retryable,
        });
        return;
    }
  }

  private handleReady(ready: ReadyFrame): void {
    this.liveSinceMs = Date.now();
    this.authRetryUsed = false;
    this.reauthInFlight = false;
    this.headSeq = ready.headSeq;
    this.windowStartSeq = ready.windowStartSeq;
    this.floorSeq = ready.floorSeq;

    // `serverTimeMs`, not `Date.now()`: a client with a skewed clock would
    // otherwise refresh far too early (harmless) or far too late (a lapsed
    // socket), and the server told us its own time precisely so this does not
    // have to trust ours.
    const window = ready.authExpiresAtMs - ready.serverTimeMs;
    if (window > 0) {
      this.reauthPeriodMs = Math.max(30_000, window - RE_AUTH_LEAD_MS);
      this.scheduleReauth(this.reauthPeriodMs);
    }

    const epochChanged = this.epoch !== null && this.epoch !== ready.epoch;
    // A window that starts above our cursor cannot be bridged by any number of
    // backfills — the rows between are gone. Say so rather than render a hole.
    const unbridgeable =
      this.lastSeq >= 0 && ready.windowStartSeq > this.lastSeq + 1;
    this.epoch = ready.epoch;
    if (epochChanged || unbridgeable) {
      this.resetStream(epochChanged ? "epoch" : "window");
    }

    this.options.onEvent({ type: "ready", ready });
    this.setStatus("live", { retryable: true });
    this.armResumeGrace();
  }

  /**
   * `ready` names a head; records follow. If they do not — a dropped replay,
   * a server that expects the client to ask — one backfill closes it. Without
   * this the view would sit silently behind forever, which is the one failure
   * mode a gapless counter cannot detect on its own.
   */
  private armResumeGrace(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    if (this.headSeq < 0 || this.lastSeq >= this.headSeq) return;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (this.lastSeq >= this.headSeq) return;
      // A gap repair already covers the hole; a second request would only
      // duplicate it and spend the client's backfill budget.
      if (this.gapPending) return;
      const fromSeq =
        this.lastSeq >= 0
          ? this.lastSeq + 1
          : Math.max(this.floorSeq, this.headSeq - INITIAL_WINDOW_RECORDS + 1);
      const toSeq = Math.min(this.headSeq, fromSeq + MAX_RESUME_RECORDS - 1);
      if (toSeq < fromSeq) return;
      if (!this.budget.take(0)) return;
      this.gapPending = true;
      this.send({
        type: "backfill",
        requestId: this.nextRequestId("g"),
        fromSeq,
        toSeq,
      });
    }, RESUME_GRACE_MS);
  }

  private resetStream(reason: string): void {
    this.lastSeq = -1;
    this.ahead.clear();
    this.gapPending = false;
    this.noProgressBackfills = 0;
    this.olderRequests.clear();
    this.options.onEvent({ type: "reset", reason });
  }

  private async reauthenticate(): Promise<void> {
    if (this.reauthInFlight) return;
    this.reauthInFlight = true;
    try {
      const token = await this.options.getToken({ forceRefresh: true });
      // A failed refresh is not an error to show: the server closes 4401 when
      // the old token lapses and the reconnect path handles it.
      if (token && isSubprotocolSafe(token)) this.send({ type: "auth", token });
    } catch {
      // Same reasoning.
    } finally {
      this.reauthInFlight = false;
    }
  }

  private handleBackfill(
    frame: Extract<ServerFrame, { type: "backfill" }>,
  ): void {
    const olderRequest = this.olderRequests.get(frame.requestId);
    if (olderRequest) {
      this.olderRequests.delete(frame.requestId);
      const records = [
        ...olderRequest.records,
        ...frame.records.filter((record) => record.seq >= olderRequest.nextSeq),
      ];
      const lastSeq = records.at(-1)?.seq ?? olderRequest.nextSeq - 1;
      if (!frame.complete && lastSeq < olderRequest.toSeq) {
        const requestId = this.nextRequestId("o");
        const fromSeq = lastSeq + 1;
        if (
          this.budget.take(4) &&
          this.send({
            type: "backfill",
            requestId,
            fromSeq,
            toSeq: olderRequest.toSeq,
          })
        ) {
          this.olderRequests.set(requestId, {
            ...olderRequest,
            nextSeq: fromSeq,
            records,
          });
          return;
        }
      }
      this.options.onEvent({
        type: "older",
        records,
        complete:
          frame.complete &&
          (records.length === 0 || records.at(-1)!.seq >= olderRequest.toSeq),
        fromSeq: records[0]?.seq ?? frame.fromSeq,
        toSeq: Math.min(olderRequest.toSeq, records.at(-1)?.seq ?? frame.toSeq),
      });
      return;
    }
    this.gapPending = false;
    const before = this.lastSeq;
    const applied: JournalRecord[] = [];
    for (const record of frame.records) this.collect(record, applied);
    this.flush(applied);
    const throughSeq = this.ahead.size
      ? Math.min(frame.toSeq, Math.min(...this.ahead.keys()) - 1)
      : frame.toSeq;
    const unresolved = this.lastSeq < throughSeq;
    if (!unresolved) {
      this.noProgressBackfills = 0;
      return;
    }

    if (this.lastSeq > before) {
      this.noProgressBackfills = 0;
    } else {
      this.noProgressBackfills += 1;
      if (this.noProgressBackfills >= MAX_NO_PROGRESS_BACKFILLS) {
        this.failGapRecovery();
        return;
      }
    }
    // A partial response may already have discovered an interior hole and sent
    // its repair from `collect`. Otherwise retry the still-unresolved prefix.
    // Empty/incomplete replies take this same bounded path instead of silently
    // clearing `gapPending` and abandoning the canonical range.
    if (!this.gapPending && !this.requestGap(throughSeq)) {
      this.failGapRecovery();
    }
  }

  private failGapRecovery(): void {
    const socket = this.socket;
    this.socket = null;
    this.stopped = true;
    this.clearTimers();
    this.gapPending = false;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onopen = null;
      try {
        socket.close(1000, "incomplete-history");
      } catch {
        // Already closing; the explicit status below is the user-visible fact.
      }
    }
    this.setStatus("blocked", {
      message:
        "Stella couldn't recover part of this conversation. Retry to load it safely.",
      retryable: true,
    });
  }

  private applyRecord(record: JournalRecord): void {
    const applied: JournalRecord[] = [];
    this.collect(record, applied);
    this.flush(applied);
  }

  /** Places one record in order, buffering anything that arrived early. */
  private collect(record: JournalRecord, applied: JournalRecord[]): void {
    if (this.lastSeq < 0) {
      // `ready.windowStartSeq` names the first record promised on a fresh view.
      // Trusting whichever record happened to arrive first would silently skip
      // a missing/corrupt prefix and make that later seq look contiguous.
      this.lastSeq = this.windowStartSeq - 1;
    }
    if (record.seq <= this.lastSeq) return;
    if (record.seq > this.lastSeq + 1) {
      if (this.ahead.size >= MAX_BUFFERED_AHEAD) {
        // The hole is bigger than the client is willing to hold open. Drop
        // everything and resync from scratch rather than grow without bound.
        this.resetStream("window");
        this.forceReconnect();
        return;
      }
      this.ahead.set(record.seq, record);
      this.requestGap(record.seq - 1);
      return;
    }
    applied.push(record);
    this.lastSeq = record.seq;
    for (;;) {
      const next = this.ahead.get(this.lastSeq + 1);
      if (!next) break;
      this.ahead.delete(next.seq);
      applied.push(next);
      this.lastSeq = next.seq;
    }
  }

  private flush(applied: JournalRecord[]): void {
    if (!applied.length) return;
    this.headSeq = Math.max(this.headSeq, this.lastSeq);
    this.options.onEvent({ type: "records", records: applied });
    // Re-arm rather than cancel. The opening replay is capped at
    // MAX_RESUME_RECORDS, so a client returning from a long absence can be
    // handed a burst that still stops short of the head — cancelling on the
    // first record would leave it silently behind until the next turn happened
    // to produce a gap. Re-arming debounces: the timer fires only once the
    // burst has stopped, and only if `lastSeq` is still below `headSeq`.
    this.armResumeGrace();
  }

  private requestGap(throughSeq: number): boolean {
    if (this.gapPending) return true;
    const fromSeq = this.lastSeq + 1;
    const toSeq = Math.min(throughSeq, fromSeq + MAX_RESUME_RECORDS - 1);
    if (toSeq < fromSeq) return true;
    if (!this.budget.take(0)) return false;
    if (
      !this.send({
        type: "backfill",
        requestId: this.nextRequestId("g"),
        fromSeq,
        toSeq,
      })
    ) {
      return false;
    }
    this.gapPending = true;
    return true;
  }
}
