import {
  CLOUD_CONVERSATION_BACKFILL_BATCH,
  CLOUD_CONVERSATION_INITIAL_WINDOW,
  CLOUD_CONVERSATION_MAX_BUFFERED_AHEAD,
  CLOUD_CONVERSATION_MAX_RESUME,
  CLOUD_CONVERSATION_PROTOCOL_VERSION,
  CLOUD_CONVERSATION_REAUTH_LEAD_MS,
  CLOUD_CONVERSATION_SOCKET_STALE_MS,
  decodeCloudConversationFrame,
  isCloudConversationTokenSubprotocolSafe,
  type CloudConversationReadyFrame,
  type CloudConversationServerFrame,
  type CloudJournalRecord,
} from "./cloud-conversation-protocol";

export type CloudConversationSocketStatus =
  | "idle"
  | "connecting"
  | "live"
  | "offline"
  | "blocked";

export type CloudConversationSocketEvent =
  | { type: "ready"; ready: CloudConversationReadyFrame }
  | { type: "records"; records: CloudJournalRecord[] }
  | { type: "older"; records: CloudJournalRecord[] }
  | { type: "reset"; reason: string }
  | { type: "gap"; fromSeq: number; toSeq: number }
  | Extract<CloudConversationServerFrame, { type: "delta" }>
  | Extract<CloudConversationServerFrame, { type: "tool" }>
  | Extract<CloudConversationServerFrame, { type: "deltas_dropped" }>
  | {
      type: "status";
      status: CloudConversationSocketStatus;
      message?: string;
      retryable: boolean;
    };

type SocketOptions = {
  conversationId: string;
  baseUrl: string;
  getToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  isActive: () => boolean;
  onEvent: (event: CloudConversationSocketEvent) => void;
};

const BASE_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 30_000;
const RESUME_GRACE_MS = 1_500;
const KEEPALIVE_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const TERMINAL_CODES = new Set([4403, 4404, 4409, 4410]);
const BACKFILLS_PER_MINUTE = 20;

class BackfillBudget {
  private tokens = BACKFILLS_PER_MINUTE;
  private refilledAt = Date.now();

  take(reserve: number): boolean {
    const now = Date.now();
    const gained =
      ((now - this.refilledAt) / 60_000) * BACKFILLS_PER_MINUTE;
    if (gained >= 1) {
      this.tokens = Math.min(BACKFILLS_PER_MINUTE, this.tokens + gained);
      this.refilledAt = now;
    }
    if (this.tokens < 1 + reserve) return false;
    this.tokens -= 1;
    return true;
  }
}

const closeMessage = (code: number): string => {
  if (code === 4401) return "Your session expired. Reconnecting…";
  if (code === 4403)
    return "This conversation belongs to another account.";
  if (code === 4404) return "This conversation is no longer available.";
  if (code === 4409) return "Stella was updated. Reload to keep chatting.";
  if (code === 4410) return "This conversation was deleted.";
  if (code === 4429) return "Too many requests. Reconnecting…";
  if (code === 4503)
    return "Too many devices are watching this conversation.";
  return "Lost the connection to Stella. Reconnecting…";
};

/**
 * Native WebSocket adapter for the conversation DO.
 *
 * It keeps an exact contiguous cursor, repairs holes before exposing records,
 * and does no transcript persistence. App lifecycle is injected through
 * `isActive`; the React hook calls `wake()` when AppState becomes active.
 */
export class CloudConversationSocket {
  private socket: WebSocket | null = null;
  private stopped = true;
  private connecting = false;
  private readyForCommands = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private reauthTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrameAtMs = 0;
  private lastSeq = -1;
  private epoch: number | null = null;
  private headSeq = -1;
  private floorSeq = 0;
  private ahead = new Map<number, CloudJournalRecord>();
  private gapPending = false;
  private requestCounter = 0;
  private olderRequests = new Set<string>();
  private readonly backfillBudget = new BackfillBudget();
  private authRetryUsed = false;
  private reauthPeriodMs = 0;
  private reauthInFlight = false;
  private readonly pendingCancels = new Set<string>();
  private readonly sentCancels = new Set<string>();
  private status: CloudConversationSocketStatus = "idle";

  constructor(private readonly options: SocketOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.detachSocket("client");
    this.setStatus("idle", true);
  }

  retry(): void {
    this.attempt = 0;
    this.authRetryUsed = false;
    if (this.stopped) {
      this.start();
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting || this.socket?.readyState === WebSocket.CONNECTING) {
      return;
    }
    this.clearTimers();
    this.detachSocket("retry");
    void this.connect();
  }

  wake(): void {
    if (this.stopped || !this.options.isActive()) return;
    const socket = this.socket;
    if (this.connecting || socket?.readyState === WebSocket.CONNECTING) {
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.attempt = 0;
      this.clearTimers();
      this.detachSocket("wake");
      void this.connect();
      return;
    }
    if (Date.now() - this.lastFrameAtMs < CLOUD_CONVERSATION_SOCKET_STALE_MS) {
      return;
    }
    try {
      socket.send("ping");
    } catch {
      this.forceReconnect();
      return;
    }
    if (this.probeTimer) clearTimeout(this.probeTimer);
    const observedAt = this.lastFrameAtMs;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.lastFrameAtMs === observedAt) this.forceReconnect();
    }, PROBE_TIMEOUT_MS);
  }

  cancelTurn(turnId: string): boolean {
    const normalized = turnId.trim();
    if (!normalized) return false;
    this.pendingCancels.add(normalized);
    this.flushCancels();
    return true;
  }

  requestOlder(oldestHeldSeq: number): boolean {
    if (oldestHeldSeq <= this.floorSeq || !this.backfillBudget.take(4)) {
      return false;
    }
    const toSeq = oldestHeldSeq - 1;
    const fromSeq = Math.max(
      this.floorSeq,
      toSeq - CLOUD_CONVERSATION_BACKFILL_BATCH + 1,
    );
    const requestId = `o${++this.requestCounter}`;
    if (!this.send({ type: "backfill", requestId, fromSeq, toSeq })) {
      return false;
    }
    this.olderRequests.add(requestId);
    return true;
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `g${this.requestCounter}`;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.reauthTimer) clearTimeout(this.reauthTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.reconnectTimer = null;
    this.resumeTimer = null;
    this.keepaliveTimer = null;
    this.reauthTimer = null;
    this.probeTimer = null;
  }

  private detachSocket(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.readyForCommands = false;
    this.sentCancels.clear();
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(1000, reason);
    } catch {
      // Already closing.
    }
  }

  private setStatus(
    status: CloudConversationSocketStatus,
    retryable: boolean,
    message?: string,
  ): void {
    if (this.status === status && !message) return;
    this.status = status;
    this.options.onEvent({
      type: "status",
      status,
      retryable,
      ...(message ? { message } : {}),
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.socket) return;
    this.connecting = true;
    this.readyForCommands = false;
    this.setStatus("connecting", true);
    try {
      let token: string | null = null;
      try {
        token = await this.options.getToken({
          forceRefresh: this.attempt > 0,
        });
      } catch {
        token = null;
      }
      if (this.stopped || this.socket) return;
      if (!token || !isCloudConversationTokenSubprotocolSafe(token)) {
        this.scheduleReconnect("Waiting for your session…");
        return;
      }

      const url = new URL(
        `/conversations/${encodeURIComponent(
          this.options.conversationId,
        )}/socket`,
        this.options.baseUrl,
      );
      if (url.protocol === "http:") url.protocol = "ws:";
      if (url.protocol === "https:") url.protocol = "wss:";
      url.searchParams.set(
        "protocol",
        String(CLOUD_CONVERSATION_PROTOCOL_VERSION),
      );
      if (this.lastSeq >= 0) url.searchParams.set("since", String(this.lastSeq));
      if (this.epoch !== null) url.searchParams.set("epoch", String(this.epoch));

      let socket: WebSocket;
      try {
        // React Native implements the browser WebSocket constructor including
        // subprotocol arrays. The JWT stays out of the URL and HTTP logs.
        socket = new WebSocket(url.toString(), [
          "stella.v1",
          `stella.token.${token}`,
        ]);
      } catch {
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
        if (this.socket !== socket || typeof event.data !== "string") return;
        this.lastFrameAtMs = Date.now();
        if (event.data === "pong") return;
        const frame = decodeCloudConversationFrame(event.data);
        if (frame) this.handleFrame(frame);
      };
      socket.onerror = () => undefined;
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.readyForCommands = false;
        this.sentCancels.clear();
        this.handleClose(event.code);
      };
    } finally {
      this.connecting = false;
    }
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      const socket = this.socket;
      if (
        !this.options.isActive() ||
        !socket ||
        socket.readyState !== WebSocket.OPEN ||
        Date.now() - this.lastFrameAtMs < KEEPALIVE_MS
      ) {
        return;
      }
      try {
        socket.send("ping");
      } catch {
        // Close/reconnect owns recovery.
      }
    }, KEEPALIVE_MS);
  }

  private scheduleReauth(delayMs: number): void {
    if (this.reauthTimer) clearTimeout(this.reauthTimer);
    if (this.reauthPeriodMs <= 0) return;
    this.reauthTimer = setTimeout(() => {
      this.reauthTimer = null;
      if (this.options.isActive()) void this.reauthenticate();
      this.scheduleReauth(this.reauthPeriodMs);
    }, Math.max(1_000, delayMs));
  }

  private async reauthenticate(): Promise<void> {
    if (this.reauthInFlight) return;
    this.reauthInFlight = true;
    try {
      const token = await this.options.getToken({ forceRefresh: true });
      if (token && isCloudConversationTokenSubprotocolSafe(token)) {
        this.send({ type: "auth", token });
      }
    } catch {
      // The server's eventual 4401 takes the ordinary reconnect path.
    } finally {
      this.reauthInFlight = false;
    }
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

  private flushCancels(): void {
    if (!this.readyForCommands) return;
    for (const turnId of this.pendingCancels) {
      if (this.sentCancels.has(turnId)) continue;
      if (this.send({ type: "cancel", turnId })) {
        this.sentCancels.add(turnId);
      }
    }
  }

  private settleCancel(record: CloudJournalRecord): void {
    if (record.kind !== "turn" || record.phase === "started") return;
    this.pendingCancels.delete(record.turnId);
    this.sentCancels.delete(record.turnId);
  }

  private handleClose(code: number): void {
    this.clearTimers();
    this.gapPending = false;
    this.ahead.clear();
    this.olderRequests.clear();
    this.readyForCommands = false;
    this.sentCancels.clear();
    if (TERMINAL_CODES.has(code)) {
      this.stopped = true;
      this.setStatus("blocked", code === 4409, closeMessage(code));
      return;
    }
    if (code === 4401) {
      if (this.authRetryUsed) {
        this.stopped = true;
        this.setStatus(
          "blocked",
          true,
          "Stella could not verify your session. Sign in again.",
        );
        return;
      }
      this.authRetryUsed = true;
      this.attempt = Math.max(this.attempt, 1);
    }
    this.scheduleReconnect(code === 1000 ? undefined : closeMessage(code));
  }

  private scheduleReconnect(message?: string): void {
    if (this.stopped) return;
    this.setStatus("offline", true, message);
    const ceiling = Math.min(
      MAX_RECONNECT_MS,
      BASE_RECONNECT_MS * 2 ** Math.min(this.attempt, 10),
    );
    this.attempt += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, Math.random() * ceiling);
  }

  private forceReconnect(): void {
    this.detachSocket("resync");
    this.clearTimers();
    if (!this.stopped) void this.connect();
  }

  private reset(reason: string): void {
    this.lastSeq = -1;
    this.ahead.clear();
    this.gapPending = false;
    this.olderRequests.clear();
    this.options.onEvent({ type: "reset", reason });
  }

  private handleFrame(frame: CloudConversationServerFrame): void {
    if (frame.type === "ready") {
      const epochChanged = this.epoch !== null && this.epoch !== frame.epoch;
      const unbridgeable =
        this.lastSeq >= 0 && frame.windowStartSeq > this.lastSeq + 1;
      this.epoch = frame.epoch;
      this.headSeq = frame.headSeq;
      this.floorSeq = frame.floorSeq;
      this.authRetryUsed = false;
      if (epochChanged || unbridgeable) {
        this.reset(epochChanged ? "epoch" : "window");
      }
      const authWindow = frame.authExpiresAtMs - frame.serverTimeMs;
      if (authWindow > 0) {
        this.reauthPeriodMs = Math.max(
          30_000,
          authWindow - CLOUD_CONVERSATION_REAUTH_LEAD_MS,
        );
        this.scheduleReauth(this.reauthPeriodMs);
      }
      this.options.onEvent({ type: "ready", ready: frame });
      this.setStatus("live", true);
      this.readyForCommands = true;
      this.flushCancels();
      this.armResumeGrace();
      return;
    }
    if (frame.type === "record") {
      this.applyRecord(frame);
      return;
    }
    if (frame.type === "backfill") {
      for (const record of frame.records) this.settleCancel(record);
      if (this.olderRequests.delete(frame.requestId)) {
        this.options.onEvent({ type: "older", records: frame.records });
        return;
      }
      this.gapPending = false;
      const applied: CloudJournalRecord[] = [];
      for (const record of frame.records) this.collect(record, applied);
      this.flush(applied);
      if (!frame.complete && frame.records.length) {
        this.requestGap(frame.toSeq);
      } else if (this.ahead.size) {
        this.requestGap(Math.min(...this.ahead.keys()) - 1);
      }
      return;
    }
    if (frame.type === "gap") {
      this.options.onEvent({
        type: "gap",
        fromSeq: frame.fromSeq,
        toSeq: frame.toSeq,
      });
      return;
    }
    if (frame.type === "reset") {
      this.reset(frame.reason);
      return;
    }
    if (
      frame.type === "delta" ||
      frame.type === "tool" ||
      frame.type === "deltas_dropped"
    ) {
      this.options.onEvent(frame);
      return;
    }
    if (frame.type === "auth.expiring") {
      void this.reauthenticate();
      return;
    }
    if (frame.type === "error") {
      this.setStatus(
        this.status === "live" ? "live" : "offline",
        frame.retryable,
        frame.message,
      );
    }
  }

  private armResumeGrace(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    if (this.headSeq < 0 || this.lastSeq >= this.headSeq) return;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (this.lastSeq >= this.headSeq || this.gapPending) return;
      const fromSeq =
        this.lastSeq >= 0
          ? this.lastSeq + 1
          : Math.max(
              this.floorSeq,
              this.headSeq - CLOUD_CONVERSATION_INITIAL_WINDOW + 1,
            );
      this.requestGap(
        Math.min(this.headSeq, fromSeq + CLOUD_CONVERSATION_MAX_RESUME - 1),
      );
    }, RESUME_GRACE_MS);
  }

  private requestGap(throughSeq: number): void {
    if (this.gapPending) return;
    if (!this.backfillBudget.take(0)) return;
    const fromSeq = this.lastSeq + 1;
    const toSeq = Math.min(
      throughSeq,
      fromSeq + CLOUD_CONVERSATION_MAX_RESUME - 1,
    );
    if (
      toSeq < fromSeq ||
      !this.send({
        type: "backfill",
        requestId: this.nextRequestId(),
        fromSeq,
        toSeq,
      })
    ) {
      return;
    }
    this.gapPending = true;
  }

  private applyRecord(record: CloudJournalRecord): void {
    this.settleCancel(record);
    const applied: CloudJournalRecord[] = [];
    this.collect(record, applied);
    this.flush(applied);
  }

  private collect(
    record: CloudJournalRecord,
    applied: CloudJournalRecord[],
  ): void {
    if (this.lastSeq < 0) this.lastSeq = record.seq - 1;
    if (record.seq <= this.lastSeq) return;
    if (record.seq > this.lastSeq + 1) {
      if (this.ahead.size >= CLOUD_CONVERSATION_MAX_BUFFERED_AHEAD) {
        this.reset("window");
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

  private flush(records: CloudJournalRecord[]): void {
    if (!records.length) return;
    this.headSeq = Math.max(this.headSeq, this.lastSeq);
    this.options.onEvent({ type: "records", records });
    this.armResumeGrace();
  }
}
