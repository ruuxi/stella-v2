import { createHash } from "node:crypto";
import type { BackendClient } from "@stella/contracts/backend/client";
import {
  SOCKET_KEEPALIVE_PING,
  SOCKET_KEEPALIVE_PONG,
} from "@stella/contracts/backend/protocol";
import WebSocket from "ws";
import {
  DEVICE_PRESENCE_PING_INTERVAL_MS,
  DEVICE_PRESENCE_PROOF_PREFIX,
  DEVICE_PRESENCE_PROTOCOL_VERSION,
  DEVICE_PRESENCE_SUBPROTOCOL,
  DEVICE_TERMINAL_RESULT_MAX_BYTES,
  DISPATCH_OFFER_WINDOW_MS,
  DISPATCH_SUBMIT_PATH,
  PLACEMENT_PROTOCOL,
  TERMINAL_DISPATCH_STATES,
  devicePresencePath,
  dispatchCancelPath,
  dispatchPath,
  executionDeviceRegistration,
  type AgentMessageDeviceOutcome,
  type DeviceAvailability,
  type DevicePresenceDeviceFrame,
  type DevicePresenceServerFrame,
  type DispatchPayload,
  type DispatchSummary,
  type ExecutionCapability,
  type ExecutionKind,
  type ExecutionSubject,
  type ExecutionTargetMode,
} from "@stella/contracts/turn-plane/placement";
import { canonicalDispatchPayloadJson } from "@stella/contracts/turn-plane/pairing-proof";
import { getFileLogger } from "../observability/file-logger.js";
import {
  DeviceRequestServer,
  type ServeDeviceRequest,
} from "./device-request-server.js";
import { DeviceToolServer, type RunDeviceTool } from "./device-tool-server.js";
import type { SqliteDatabase } from "../kernel/storage/shared.js";
import {
  ExecutionPlacementInbox,
  type ExecutionPlacementInboxRow,
} from "./execution-placement-inbox.js";
import { ExecutionPlacementLeases } from "./execution-placement-leases.js";

// Existing importers still open the inbox through the bridge module.
export { ExecutionPlacementInbox };
import {
  forkDelayed,
  forkInterval,
  type HostTimerHandle,
} from "./effect-runtime.js";

/** A claim the gate does not answer inside the offer window lost its race. */
const CLAIM_RESPONSE_TIMEOUT_MS = DISPATCH_OFFER_WINDOW_MS + 1_000;
/** How long a `complete` frame waits for the owner gate's terminal echo. */
const COMPLETE_ACK_TIMEOUT_MS = 10_000;
/** Reconnect — and therefore re-authenticate — before the JWT expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const MIN_TOKEN_REFRESH_DELAY_MS = 30_000;
const HTTP_TIMEOUT_MS = 15_000;
const DISPATCH_WATCH_POLL_MS = 750;

type PlacementKind = ExecutionKind;
type PlacementCapability = ExecutionCapability;
type PlacementSubject = ExecutionSubject;

export type ExecutionPlacementDesktopSubmit = {
  idempotencyKey: string;
  kind: PlacementKind;
  subject: PlacementSubject;
  conversationId: string;
  parentTurnId?: string;
  threadId?: string;
  requestedTargetMode: ExecutionTargetMode;
  requestedExecutorDeviceId?: string;
  requiredCapabilities: PlacementCapability[];
  /** Exactly the bytes the executing device receives. */
  payload: DispatchPayload;
};

export type ExecutionPlacementAvailability = DeviceAvailability;

export type ExecutionPlacementRunResult = {
  status: "ok" | "error" | "canceled";
  finalText?: string;
  error?: string;
};

/**
 * The backend calls the bridge still needs: who the owner is, where the
 * owner gate lives, and this device's public key. Every placement verb is a
 * socket frame or an owner-gate route.
 */
export type ExecutionPlacementClient = Pick<BackendClient, "call">;

/** Minimal `ws` shape; the tests drive a real socket against a fake gate. */
export type ExecutionPlacementSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(
    event: "close",
    listener: (code: number, reason: unknown) => void,
  ): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
};

/**
 * The public half of the device identity. The Ed25519 private key stays with
 * whoever loaded the identity (Electron main or the headless host) and is only
 * reachable through `signPresenceProof`, so the bridge never holds key bytes.
 */
type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
};

type PlacementBridgeOptions = {
  client: ExecutionPlacementClient;
  database: SqliteDatabase;
  deviceIdentity: DeviceIdentity;
  /**
   * Signs the presence challenge
   * (`stella-device-presence\0<connectionId>\0<nonce>`, UTF-8) with the device
   * key and returns the Ed25519 signature as base64url. The owner gate checks
   * it against the public key this device registered.
   */
  signPresenceProof: (message: string) => Promise<string>;
  appVersion: string;
  deviceName?: string;
  platform?: string;
  /** The same Better Auth JWT the host presents to the backend. */
  getAuthToken?: () => string | null;
  getAvailability: () =>
    | ExecutionPlacementAvailability
    | Promise<ExecutionPlacementAvailability>;
  runExecution: (args: {
    dispatch: DispatchSummary;
    payload: Record<string, unknown>;
    ownerGeneration: string;
  }) => Promise<ExecutionPlacementRunResult>;
  cancelExecution: (args: {
    dispatchId: string;
    kind: PlacementKind;
    conversationId: string;
    /** The accepted payload, for an agent thread's own local id. */
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  /**
   * New input for an accepted agent run. Resolves whether the running agent
   * took it; `messageId` is stable across a retried steer.
   */
  steerExecution?: (args: {
    dispatchId: string;
    payload: Record<string, unknown>;
    messageId: string;
    text: string;
  }) => Promise<boolean>;
  /**
   * A `send_message` for an agent this computer runs on its own (no
   * dispatch): steer it if running, resume it if idle. `messageId` is stable
   * across redeliveries.
   */
  deliverAgentMessage?: (args: {
    threadId: string;
    messageId: string;
    text: string;
    ownerGeneration: string;
  }) => Promise<AgentMessageDeviceOutcome>;
  /**
   * Something tried to dispatch work here and this computer has not agreed to
   * accept any. The host shows the question on this machine's own screen and
   * calls `answerRemoteExecutionRequest` with what its user said.
   */
  onRemoteExecutionRequest?: (request: {
    requestedAt: number;
    requesterLabel?: string;
  }) => void;
  /**
   * Answer a paired phone's request (a file, an office preview, voice tools)
   * that the owner gate relayed over the presence socket. The app applies its
   * own access policy; absent, every request is refused.
   */
  serveDeviceRequest?: ServeDeviceRequest;
  /**
   * Run a cloud agent's tool call (or describe this computer) that the owner
   * gate relayed over the presence socket, with this computer's own tool
   * host. The gate only relays to a computer enabled for remote work;
   * absent, every call is refused.
   */
  runDeviceTool?: RunDeviceTool;
  log?: (level: "warn" | "error", message: string, error?: unknown) => void;
  now?: () => number;
  /** Test seam; production uses the accepted execution lease duration. */
  leaseRenewalGraceMs?: number;
  /** Test seam for deterministic claim-ACK retry/backoff coverage. */
  claimAckRetryBaseMs?: number;
  /** Test seams for the owner-gate transport. */
  createSocket?: (url: string, protocols: string[]) => ExecutionPlacementSocket;
  fetch?: typeof fetch;
};

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Stable, dispatch-scoped ID for the exact blocking local-agent run. */
export const placementLocalAgentThreadId = (dispatchId: string) =>
  `placement-agent:${sha256(dispatchId).slice(0, 32)}`;

/**
 * The local thread for a remote agent thread placed on this device. Every
 * attempt of that thread continues the same local thread, so a follow-up
 * keeps its history; the dispatch-scoped id above stays the attempt's fence.
 */
export const placementRemoteThreadAgentId = (threadId: string) =>
  `placement-agent:thread:${sha256(threadId).slice(0, 32)}`;

/** Stable, dispatch-scoped ID for the exact local automation/chat run. */
export const placementLocalChatRunId = (dispatchId: string) =>
  `placement-chat:${sha256(dispatchId).slice(0, 32)}`;

const parseRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Execution placement returned an invalid object.");
  }
  return value as Record<string, unknown>;
};

const parseDispatch = (value: unknown): DispatchSummary => {
  const row = parseRecord(value);
  if (
    typeof row.dispatchId !== "string" ||
    (row.kind !== "chat" && row.kind !== "agent") ||
    typeof row.conversationId !== "string" ||
    typeof row.state !== "string"
  ) {
    throw new Error("Execution placement returned an invalid dispatch.");
  }
  return row as unknown as DispatchSummary;
};

const isTerminalState = (state: string) =>
  (TERMINAL_DISPATCH_STATES as readonly string[]).includes(state);

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

const fitWithinBytes = (
  value: string,
  render: (text: string, omittedChars: number) => string,
): string => {
  if (utf8Bytes(render(value, 0)) <= DEVICE_TERMINAL_RESULT_MAX_BYTES) {
    return render(value, 0);
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = render(value.slice(0, mid), value.length - mid);
    if (utf8Bytes(candidate) <= DEVICE_TERMINAL_RESULT_MAX_BYTES) low = mid;
    else high = mid - 1;
  }
  return render(value.slice(0, low), value.length - low);
};

const withOmissionNote = (text: string, omittedChars: number) =>
  omittedChars > 0
    ? `${text}\n\n[Report shortened for delivery: ${omittedChars} more characters exceeded the ${DEVICE_TERMINAL_RESULT_MAX_BYTES}-byte terminal record limit.]`
    : text;

const boundedResult = (value: string | undefined) =>
  value ? fitWithinBytes(value, withOmissionNote) : undefined;

const terminalResultJson = (finalText: string) =>
  fitWithinBytes(finalText, (text, omittedChars) =>
    JSON.stringify({ finalText: withOmissionNote(text, omittedChars) }),
  );

/** The owner gate refused this device's authority; only a fresh identity helps. */
const isOwnerLifecycleFenceError = (error: unknown) => {
  const record =
    error && typeof error === "object"
      ? (error as {
          code?: unknown;
          data?: { code?: unknown };
          message?: unknown;
        })
      : undefined;
  const code = record?.data?.code ?? record?.code;
  const message =
    typeof record?.message === "string"
      ? record.message
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    code === "owner_purged" ||
    code === "generation_stale" ||
    code === "OWNER_DATA_PURGE_ACTIVE" ||
    code === "OWNER_DATA_GENERATION_STALE" ||
    message.includes("owner_purged") ||
    message.includes("generation_stale") ||
    message.includes("OWNER_DATA_PURGE_ACTIVE") ||
    message.includes("OWNER_DATA_GENERATION_STALE")
  );
};

/** One owner-gate route refusal, carrying the contract's error code. */
export class PlacementRouteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(args: {
    code: string;
    status: number;
    message: string;
    retryable: boolean;
  }) {
    super(args.message);
    this.name = "PlacementRouteError";
    this.code = args.code;
    this.status = args.status;
    this.retryable = args.retryable;
  }
}

const socketOriginOf = (builderOrigin: string) =>
  builderOrigin.replace(/^http/u, "ws");

/** `exp` of a Better Auth JWT, in epoch milliseconds. */
const jwtExpiryMs = (token: string): number | null => {
  const segments = token.split(".");
  if (segments.length < 2 || !segments[1]) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return typeof claims.exp === "number" && Number.isFinite(claims.exp)
      ? claims.exp * 1000
      : null;
  } catch {
    return null;
  }
};

type PendingFrameWait<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: HostTimerHandle;
};

export type DispatchWatchHandle = { unsubscribe(): void };

type ServerFrameHandlers = {
  [Type in Exclude<DevicePresenceServerFrame["type"], "challenge">]: (
    frame: Extract<DevicePresenceServerFrame, { type: Type }>,
    socket: ExecutionPlacementSocket,
  ) => void | Promise<void>;
};

/**
 * Device presence + durable claim/ack runtime against the owner gate.
 *
 * One authenticated WebSocket carries every placement verb. The device proves
 * possession of its key once per connection (Ed25519 over the gate's nonce);
 * after that, `claim` / `ack` / `running` / `renew` / `complete` are plain
 * frames bound to the proven session. The SQLite inbox — not the socket — is
 * the durable boundary: a claim is acknowledged only once the payload is
 * committed locally, and from `ack` on this device owns the only copy.
 */
export class ExecutionPlacementBridge {
  readonly client: ExecutionPlacementClient;
  private readonly inbox: ExecutionPlacementInbox;
  private readonly fetchImpl: typeof fetch;
  private readonly leases: ExecutionPlacementLeases;
  private ownerId: string | null = null;
  private ownerGeneration: string | null = null;
  private builderOrigin: string | null = null;
  private presenceSessionId: string | null = null;
  private sessionReady = false;
  private started = false;
  private stopped = false;
  private lifecycleEpoch = 0;
  private socket: ExecutionPlacementSocket | null = null;
  private socketProven = false;
  private socketPingTimer: HostTimerHandle | null = null;
  private socketTokenTimer: HostTimerHandle | null = null;
  private advertisedAvailability = "";
  private stopTask: Promise<void> | null = null;
  private readonly offerTasks = new Set<Promise<void>>();
  private readonly offersInFlight = new Set<string>();
  private readonly executing = new Set<string>();
  private readonly executionTasks = new Map<string, Promise<void>>();
  private readonly terminalFlushes = new Map<string, Promise<void>>();
  private readonly pendingClaims = new Map<string, PendingFrameWait<number>>();
  private readonly pendingCompletes = new Map<
    string,
    PendingFrameWait<DispatchSummary>
  >();
  private readonly dispatchWatchers = new Map<
    string,
    Set<(dispatch: DispatchSummary) => void>
  >();

  private readonly deviceRequests: DeviceRequestServer;
  private readonly deviceTools: DeviceToolServer;

  constructor(private readonly options: PlacementBridgeOptions) {
    this.client = options.client;
    this.inbox = new ExecutionPlacementInbox(options.database);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.leases = new ExecutionPlacementLeases({
      now: () => this.now(),
      leaseRenewalGraceMs: options.leaseRenewalGraceMs,
      claimAckRetryBaseMs: options.claimAckRetryBaseMs,
    });
    this.deviceRequests = new DeviceRequestServer({
      serve: options.serveDeviceRequest,
      send: (frame) => this.send(frame),
      log: (message, error) => this.log("warn", message, error),
    });
    this.deviceTools = new DeviceToolServer({
      run: options.runDeviceTool,
      send: (frame) => this.send(frame),
      log: (message, error) => this.log("warn", message, error),
    });
  }

  get isRunning() {
    return this.started && !this.stopped;
  }

  /** The owner gate this bridge is bound to, once identity has resolved. */
  get ownerGateOrigin(): string | null {
    return this.builderOrigin;
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private log(level: "warn" | "error", message: string, error?: unknown) {
    this.options.log?.(level, message, error);
  }

  private requireSession() {
    if (!this.ownerId || !this.ownerGeneration || !this.presenceSessionId) {
      throw new Error("Execution placement session is not initialized.");
    }
    return {
      ownerId: this.ownerId,
      ownerGeneration: this.ownerGeneration,
      presenceSessionId: this.presenceSessionId,
    };
  }

  private requireOwnerGate() {
    const origin = this.builderOrigin;
    if (!origin) {
      throw new Error("Execution placement owner gate is unavailable.");
    }
    return origin;
  }

  private isLiveEpoch(epoch: number) {
    return this.started && !this.stopped && epoch === this.lifecycleEpoch;
  }

  // -------------------------------------------------------------------------
  // Owner-gate routes
  // -------------------------------------------------------------------------

  private async ownerGateRequest(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<Response> {
    const origin = this.requireOwnerGate();
    const token = this.options.getAuthToken?.()?.trim();
    if (!token) {
      throw new PlacementRouteError({
        code: "unauthorized",
        status: 0,
        message: "This computer is not signed in to Stella.",
        retryable: true,
      });
    }
    return await this.fetchImpl(`${origin}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  }

  private async throwRouteError(response: Response): Promise<never> {
    let code = "internal";
    let message = `The owner gate refused this request (${response.status}).`;
    let retryable = response.status >= 500 || response.status === 429;
    try {
      const body = (await response.json()) as {
        error?: { code?: unknown; message?: unknown; retryable?: unknown };
      } | null;
      const error = body?.error;
      if (error && typeof error === "object") {
        if (typeof error.code === "string") code = error.code;
        if (typeof error.message === "string" && error.message.trim()) {
          message = error.message.trim();
        }
        if (typeof error.retryable === "boolean") retryable = error.retryable;
      }
    } catch {
      // A terse body keeps the status-derived defaults.
    }
    throw new PlacementRouteError({
      code,
      status: response.status,
      message,
      retryable,
    });
  }

  /**
   * Desktop-originated dispatch. The owner gate decides placement; when it
   * commits to this computer the response already names it, and the payload
   * this process submitted becomes the inbox row without a second copy ever
   * crossing the network.
   */
  async submitDesktopExecution(
    args: ExecutionPlacementDesktopSubmit,
  ): Promise<DispatchSummary> {
    if (!this.isRunning || !this.sessionReady) {
      throw new Error("Execution placement is not ready on this computer.");
    }
    const requestedExecutorDeviceId =
      args.requestedExecutorDeviceId?.trim() || undefined;
    const requiredCapabilities = [
      ...new Set<PlacementCapability>([
        args.kind,
        ...args.requiredCapabilities,
      ]),
    ].sort();
    const body = {
      protocol: PLACEMENT_PROTOCOL,
      idempotencyKey: args.idempotencyKey.trim(),
      kind: args.kind,
      ingress: "desktop" as const,
      subject: args.subject,
      targetMode: args.requestedTargetMode,
      ...(requestedExecutorDeviceId
        ? { targetDeviceId: requestedExecutorDeviceId }
        : {}),
      requestingDeviceId: this.options.deviceIdentity.deviceId,
      conversationId: args.conversationId.trim(),
      ...(args.parentTurnId?.trim()
        ? { parentTurnId: args.parentTurnId.trim() }
        : {}),
      ...(args.threadId?.trim() ? { threadId: args.threadId.trim() } : {}),
      requiredCapabilities,
      payload: args.payload,
    };
    const requestAt = Date.now();
    const requestStarted = performance.now();
    const response = await this.ownerGateRequest(DISPATCH_SUBMIT_PATH, {
      method: "POST",
      body,
    });
    if (!response.ok) await this.throwRouteError(response);
    const dispatch = parseDispatch(parseRecord(await response.json()).dispatch);
    getFileLogger()?.process("chat.dispatch-response", {
      originUserMessageId: args.payload.userMessageEventId,
      dispatchId: dispatch.dispatchId,
      requestAt,
      responseMs: Math.round(performance.now() - requestStarted),
    });
    this.notifyDispatchWatchers(dispatch);
    await this.adoptCommittedDispatch(dispatch, args.payload);
    return dispatch;
  }

  /** One status read of a dispatch this owner owns. */
  async getDispatchStatus(dispatchId: string): Promise<DispatchSummary | null> {
    const response = await this.ownerGateRequest(dispatchPath(dispatchId), {
      method: "GET",
    });
    if (response.status === 404) return null;
    if (!response.ok) await this.throwRouteError(response);
    const dispatch = parseDispatch(parseRecord(await response.json()).dispatch);
    this.notifyDispatchWatchers(dispatch);
    return dispatch;
  }

  async cancelDispatch(args: {
    dispatchId: string;
    cancelRequestId: string;
    reason?: string;
  }): Promise<DispatchSummary> {
    const response = await this.ownerGateRequest(
      dispatchCancelPath(args.dispatchId),
      {
        method: "POST",
        body: {
          protocol: PLACEMENT_PROTOCOL,
          cancelRequestId: args.cancelRequestId,
          ...(args.reason ? { reason: args.reason } : {}),
        },
      },
    );
    if (!response.ok) await this.throwRouteError(response);
    const dispatch = parseDispatch(parseRecord(await response.json()).dispatch);
    this.notifyDispatchWatchers(dispatch);
    return dispatch;
  }

  /**
   * Follows one dispatch to its terminal state. `dispatch` frames arrive over
   * the presence socket for dispatches this device requested; the poll is the
   * failsafe for a socket that is down.
   */
  watchDispatch(
    dispatchId: string,
    onStatus: (dispatch: DispatchSummary) => void,
  ): DispatchWatchHandle {
    let active = true;
    const listeners =
      this.dispatchWatchers.get(dispatchId) ??
      new Set<(dispatch: DispatchSummary) => void>();
    const listener = (dispatch: DispatchSummary) => {
      if (active) onStatus(dispatch);
    };
    listeners.add(listener);
    this.dispatchWatchers.set(dispatchId, listeners);
    const poll = forkInterval(DISPATCH_WATCH_POLL_MS, () => {
      if (!active) return;
      void this.getDispatchStatus(dispatchId)
        .then((dispatch) => {
          if (dispatch && isTerminalState(dispatch.state)) handle.unsubscribe();
        })
        .catch(() => undefined);
    });
    const handle: DispatchWatchHandle = {
      unsubscribe: () => {
        if (!active) return;
        active = false;
        poll.cancel();
        const current = this.dispatchWatchers.get(dispatchId);
        current?.delete(listener);
        if (current && current.size === 0) {
          this.dispatchWatchers.delete(dispatchId);
        }
      },
    };
    return handle;
  }

  private notifyDispatchWatchers(dispatch: DispatchSummary) {
    const listeners = this.dispatchWatchers.get(dispatch.dispatchId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(dispatch);
      } catch (error) {
        this.log("warn", "A dispatch status observer failed.", error);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Presence socket
  // -------------------------------------------------------------------------

  /**
   * The platform answers this without waking the owner's object, which is
   * what lets it hibernate between heartbeats. The gate reads the time of the
   * last answer as this device's last-seen time.
   */
  private sendKeepalive(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || !this.socketProven) return;
    try {
      socket.send(SOCKET_KEEPALIVE_PING);
    } catch (error) {
      this.log("warn", "A device presence keepalive could not be sent.", error);
    }
  }

  private send(frame: DevicePresenceDeviceFrame): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    if (
      frame.type !== "begin" &&
      frame.type !== "proof" &&
      !this.socketProven
    ) {
      return false;
    }
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      this.log("warn", "A device presence frame could not be sent.", error);
      return false;
    }
  }

  private closeSocket(code = 1000, reason = "desktop_stopped") {
    this.leases.cancelReconnect();
    this.socketPingTimer?.cancel();
    this.socketPingTimer = null;
    this.socketTokenTimer?.cancel();
    this.socketTokenTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.socketProven = false;
    this.advertisedAvailability = "";
    if (socket && socket.readyState < 2) socket.close(code, reason);
  }

  private scheduleReconnect() {
    if (
      this.stopped ||
      !this.started ||
      !this.sessionReady ||
      !this.builderOrigin
    ) {
      return;
    }
    this.leases.scheduleReconnect(() => this.openSocket());
  }

  private openSocket() {
    if (
      this.stopped ||
      !this.started ||
      !this.sessionReady ||
      !this.builderOrigin ||
      this.socket
    ) {
      return;
    }
    const token = this.options.getAuthToken?.()?.trim();
    if (!token) {
      this.scheduleReconnect();
      return;
    }
    const session = this.requireSession();
    const url = `${socketOriginOf(this.builderOrigin)}${devicePresencePath(
      this.options.deviceIdentity.deviceId,
    )}`;
    const create =
      this.options.createSocket ??
      ((target: string, protocols: string[]) =>
        new WebSocket(
          target,
          protocols,
        ) as unknown as ExecutionPlacementSocket);
    let socket: ExecutionPlacementSocket;
    try {
      socket = create(url, [
        DEVICE_PRESENCE_SUBPROTOCOL,
        `stella.token.${token}`,
      ]);
    } catch (error) {
      this.log("warn", "The device presence socket could not open.", error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.socketProven = false;
    // A JWT that dies mid-connection cannot be replaced in place: the gate
    // authenticates on the handshake, so re-authentication is a reconnect.
    const expiresAt = jwtExpiryMs(token);
    if (expiresAt !== null) {
      const delay = Math.max(
        MIN_TOKEN_REFRESH_DELAY_MS,
        expiresAt - TOKEN_REFRESH_MARGIN_MS - this.now(),
      );
      this.socketTokenTimer?.cancel();
      this.socketTokenTimer = forkDelayed(delay, () => {
        if (this.socket !== socket) return;
        this.leases.resetReconnectBackoff();
        socket.close(1000, "token_refresh");
      });
    }

    socket.on("message", (data: unknown) => {
      let frame: DevicePresenceServerFrame;
      try {
        const text =
          typeof data === "string"
            ? data
            : Buffer.from(data as ArrayBufferLike).toString("utf8");
        if (text === SOCKET_KEEPALIVE_PONG) return;
        const value = JSON.parse(text) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        frame = value as DevicePresenceServerFrame;
      } catch {
        socket.close(4000, "bad_frame");
        return;
      }
      if (frame.type === "challenge") {
        const connectionId =
          typeof frame.connectionId === "string" ? frame.connectionId : "";
        const nonce = typeof frame.nonce === "string" ? frame.nonce : "";
        if (!connectionId || !nonce) {
          socket.close(4000, "bad_frame");
          return;
        }
        void this.proveConnection(socket, session.presenceSessionId, {
          connectionId,
          nonce,
        }).catch((error) => {
          this.log("warn", "The device presence handshake failed.", error);
          socket.close(4500, "handshake_failed");
        });
        return;
      }
      void this.handleServerFrame(socket, frame).catch((error) =>
        this.log("error", "A device presence frame failed.", error),
      );
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.socketProven = false;
      this.advertisedAvailability = "";
      this.socketPingTimer?.cancel();
      this.socketPingTimer = null;
      this.socketTokenTimer?.cancel();
      this.socketTokenTimer = null;
      this.rejectPendingWaits("The device presence socket closed.");
      this.scheduleReconnect();
    });
    socket.on("error", (error: unknown) => {
      this.log("warn", "The device presence socket disconnected.", error);
    });
  }

  /** `begin` announces the session and availability; `proof` signs the nonce. */
  private async proveConnection(
    socket: ExecutionPlacementSocket,
    presenceSessionId: string,
    challenge: { connectionId: string; nonce: string },
  ) {
    const availability = await this.currentAvailability();
    if (this.socket !== socket || socket.readyState !== 1) return;
    const begin: DevicePresenceDeviceFrame = {
      type: "begin",
      presenceSessionId,
      protocolVersion: DEVICE_PRESENCE_PROTOCOL_VERSION,
      availability,
    };
    socket.send(JSON.stringify(begin));
    // `stella-device-presence\0<connectionId>\0<nonce>`: NUL-separated so no
    // connection can borrow another connection's nonce by concatenation.
    const message = [
      DEVICE_PRESENCE_PROOF_PREFIX,
      challenge.connectionId,
      challenge.nonce,
    ].join("\u0000");
    let signature: string;
    try {
      signature = await this.options.signPresenceProof(message);
    } catch (error) {
      // An unsigned connection is never proven: the gate closes it and the
      // ordinary reconnect path retries, rather than the bridge dying here.
      this.log("warn", "The device presence proof could not be signed.", error);
      return;
    }
    const proof: DevicePresenceDeviceFrame = { type: "proof", signature };
    if (this.socket !== socket || socket.readyState !== 1) return;
    socket.send(JSON.stringify(proof));
    this.advertisedAvailability = JSON.stringify(availability);
  }

  /**
   * One handler per server frame type. `challenge` is the handshake and is
   * answered by `openSocket` itself; every other frame reaches its handler
   * only while its socket is still the live one.
   */
  private readonly serverFrameHandlers: ServerFrameHandlers = {
    connected: async () => {
      this.socketProven = true;
      this.leases.resetReconnectBackoff();
      this.socketPingTimer?.cancel();
      this.socketPingTimer = forkInterval(
        DEVICE_PRESENCE_PING_INTERVAL_MS,
        () => {
          this.sendKeepalive();
        },
      );
      await this.resumeAfterConnect();
    },
    offer: (frame) => {
      const task = this.handleOffer(frame).catch((error) =>
        this.log("error", "Execution placement offer handling failed.", error),
      );
      this.offerTasks.add(task);
      void task.finally(() => this.offerTasks.delete(task));
    },
    "offer.withdrawn": (frame) => {
      this.settleClaim(frame.dispatchId, {
        error: new Error(`The offer was withdrawn (${frame.reason}).`),
      });
    },
    claimed: (frame) => {
      this.settleClaim(frame.dispatchId, {
        claimExpiresAt: frame.claimExpiresAt,
      });
    },
    cancel: async (frame) => {
      const local = this.inbox.get(frame.dispatchId);
      if (local) await this.cancelAccepted(local);
    },
    steer: async (frame) => {
      await this.steerAccepted(frame.dispatchId, frame.messageId, frame.text);
    },
    "agent-message": async (frame) => {
      await this.deliverAgentMessage(frame);
    },
    "consent.request": (frame) => {
      // Only raise the question. This computer answers when its own user
      // does, and the attempt that triggered the ask has already been told
      // to come back later, so there is nothing here to keep waiting on.
      this.options.onRemoteExecutionRequest?.({
        requestedAt: frame.requestedAt,
        ...(frame.requesterLabel
          ? { requesterLabel: frame.requesterLabel }
          : {}),
      });
    },
    dispatch: async (frame) => {
      await this.applyDispatchUpdate(frame.dispatch);
    },
    request: (frame) => {
      this.deviceRequests.handle(frame);
    },
    "request.cancel": (frame) => {
      this.deviceRequests.cancel(frame.requestId);
    },
    "tool.call": (frame) => {
      this.deviceTools.handle(frame);
    },
    "tool.cancel": (frame) => {
      this.deviceTools.cancel(frame.requestId);
    },
    error: (frame, socket) => {
      this.log(
        "warn",
        `The owner gate refused a presence frame (${frame.code}): ${frame.message}`,
      );
      if (!frame.retryable) socket.close(4000, frame.code);
    },
    pong: () => {},
  };

  private async handleServerFrame(
    socket: ExecutionPlacementSocket,
    frame: DevicePresenceServerFrame,
  ) {
    if (this.socket !== socket) return;
    if (!Object.hasOwn(this.serverFrameHandlers, frame.type)) return;
    const handler = this.serverFrameHandlers[
      frame.type as keyof ServerFrameHandlers
    ] as (
      frame: DevicePresenceServerFrame,
      socket: ExecutionPlacementSocket,
    ) => void | Promise<void>;
    await handler(frame, socket);
  }

  /** Hand a steer to the accepted agent run it names, then report back. */
  private async steerAccepted(
    dispatchId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    const local = this.inbox.get(dispatchId);
    let delivered = false;
    if (local?.kind === "agent" && this.options.steerExecution) {
      try {
        delivered = await this.options.steerExecution({
          dispatchId,
          payload: parseRecord(JSON.parse(local.payloadJson)),
          messageId,
          text,
        });
      } catch (error) {
        this.log("warn", "Execution placement steer was not delivered.", error);
      }
    }
    this.send({ type: "steer.ack", dispatchId, messageId, delivered });
  }

  /** Hand a message to one of this computer's own agents, then report back. */
  private async deliverAgentMessage(
    frame: Extract<DevicePresenceServerFrame, { type: "agent-message" }>,
  ): Promise<void> {
    const { messageId, threadId } = frame;
    if (typeof messageId !== "string" || typeof threadId !== "string") return;
    let outcome: AgentMessageDeviceOutcome = "refused";
    if (
      typeof frame.text === "string" &&
      frame.ownerGeneration === this.ownerGeneration &&
      this.options.deliverAgentMessage
    ) {
      try {
        outcome = await this.options.deliverAgentMessage({
          threadId,
          messageId,
          text: frame.text,
          ownerGeneration: frame.ownerGeneration,
        });
      } catch (error) {
        this.log("warn", "An agent message was not delivered.", error);
      }
    }
    this.send({ type: "agent-message.ack", messageId, threadId, outcome });
  }

  private settleClaim(
    dispatchId: string,
    outcome: { claimExpiresAt?: number; error?: Error },
  ) {
    const pending = this.pendingClaims.get(dispatchId);
    if (!pending) return;
    this.pendingClaims.delete(dispatchId);
    pending.timer.cancel();
    if (outcome.error) pending.reject(outcome.error);
    else pending.resolve(outcome.claimExpiresAt ?? 0);
  }

  private rejectPendingWaits(reason: string) {
    for (const [dispatchId, pending] of [...this.pendingClaims]) {
      this.pendingClaims.delete(dispatchId);
      pending.timer.cancel();
      pending.reject(new Error(reason));
    }
    for (const [dispatchId, pending] of [...this.pendingCompletes]) {
      this.pendingCompletes.delete(dispatchId);
      pending.timer.cancel();
      pending.reject(new Error(reason));
    }
  }

  private waitForClaim(dispatchId: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const timer = forkDelayed(CLAIM_RESPONSE_TIMEOUT_MS, () => {
        this.pendingClaims.delete(dispatchId);
        reject(new Error("The owner gate did not answer this claim."));
      });
      this.pendingClaims.set(dispatchId, { resolve, reject, timer });
    });
  }

  private waitForCompletion(dispatchId: string): Promise<DispatchSummary> {
    return new Promise<DispatchSummary>((resolve, reject) => {
      const timer = forkDelayed(COMPLETE_ACK_TIMEOUT_MS, () => {
        this.pendingCompletes.delete(dispatchId);
        reject(new Error("The owner gate did not acknowledge the outcome."));
      });
      this.pendingCompletes.set(dispatchId, { resolve, reject, timer });
    });
  }

  private async applyDispatchUpdate(value: unknown) {
    let dispatch: DispatchSummary;
    try {
      dispatch = parseDispatch(value);
    } catch (error) {
      this.log("warn", "Ignored a malformed dispatch frame.", error);
      return;
    }
    this.notifyDispatchWatchers(dispatch);
    const pending = this.pendingCompletes.get(dispatch.dispatchId);
    if (pending && isTerminalState(dispatch.state)) {
      this.pendingCompletes.delete(dispatch.dispatchId);
      pending.timer.cancel();
      pending.resolve(dispatch);
      return;
    }
    const local = this.inbox.get(dispatch.dispatchId);
    if (!local) return;
    if (dispatch.state === "cancel_pending") {
      await this.cancelAccepted(local);
      return;
    }
    if (isTerminalState(dispatch.state)) {
      if (local.state === "terminal_pending" && !local.cancelRpcPending) {
        this.inbox.markTerminal(dispatch.dispatchId, dispatch, this.now());
        void this.heartbeat();
      }
      return;
    }
    if (
      dispatch.placement === "computer" &&
      (dispatch.state === "computer_accepted" ||
        dispatch.state === "computer_running") &&
      !this.executing.has(dispatch.dispatchId) &&
      !local.cancelRpcPending
    ) {
      this.launchLocal(local, dispatch);
    }
  }

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  private async currentAvailability(): Promise<DeviceAvailability> {
    const availability = await this.options.getAvailability();
    return {
      ready: availability.ready,
      capabilities: [...new Set(availability.capabilities)].sort(),
    };
  }

  /**
   * Answer this computer's own "accept work from your other devices?" prompt.
   *
   * Sent on the presence socket when there is one, because that socket is
   * already proven with the device key and so carries the fact that the answer
   * came from this machine. With the socket down it falls back to the backend
   * call, which is authorized by the account alone — weaker, but the honest
   * alternative is losing the answer the user just gave.
   */
  async answerRemoteExecutionRequest(allow: boolean): Promise<void> {
    if (this.socketProven && this.send({ type: "consent", allow })) return;
    await this.client.call("devices.setRemoteExecution", {
      deviceId: this.options.deviceIdentity.deviceId,
      enabled: allow,
    });
  }

  /** Publishes availability only when it actually changed. */
  private async publishAvailability() {
    if (!this.socketProven) return;
    const availability = await this.currentAvailability();
    const serialized = JSON.stringify(availability);
    if (serialized === this.advertisedAvailability) return;
    if (this.send({ type: "availability", availability })) {
      this.advertisedAvailability = serialized;
    }
  }

  // -------------------------------------------------------------------------
  // Identity and lifecycle
  // -------------------------------------------------------------------------

  private async readIdentity() {
    const identity = parseRecord(
      await this.client.call("devices.identity", {
        deviceId: this.options.deviceIdentity.deviceId,
      }),
    );
    if (
      typeof identity.ownerId !== "string" ||
      typeof identity.ownerGeneration !== "string"
    ) {
      throw new Error("Execution placement identity is incompatible.");
    }
    const builderOrigin =
      typeof identity.builderOrigin === "string"
        ? identity.builderOrigin.replace(/\/+$/u, "")
        : "";
    if (!/^https?:\/\//u.test(builderOrigin)) {
      throw new Error("Execution placement has no owner gate configured.");
    }
    return {
      ownerId: identity.ownerId,
      ownerGeneration: identity.ownerGeneration,
      builderOrigin,
    };
  }

  /** One idempotent registration of this device's key and capabilities. */
  private async registerDevice() {
    const availability = await this.options.getAvailability();
    await this.client.call(
      "devices.register",
      executionDeviceRegistration({
        deviceId: this.options.deviceIdentity.deviceId,
        devicePublicKey: this.options.deviceIdentity.publicKey,
        deviceName: this.options.deviceName,
        platform: this.options.platform,
        capabilities: availability.capabilities,
      }),
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopTask) {
      throw new Error("A stopped execution placement bridge cannot restart.");
    }
    this.stopped = false;
    const epoch = ++this.lifecycleEpoch;
    const identity = await this.readIdentity();
    if (this.stopped || epoch !== this.lifecycleEpoch) {
      throw new Error("Execution placement stopped while starting.");
    }
    this.ownerId = identity.ownerId;
    this.ownerGeneration = identity.ownerGeneration;
    this.builderOrigin = identity.builderOrigin;
    const session = this.inbox.openSession({
      ownerId: identity.ownerId,
      ownerGeneration: identity.ownerGeneration,
      now: this.now(),
    });
    this.presenceSessionId = session.presenceSessionId;
    await this.stageRestartCancellations();
    this.started = true;
    const cancellationsAcknowledged = await this.retryPendingCancellations();
    if (!cancellationsAcknowledged) {
      // Stay alive only as a cancellation reconciler. No presence socket
      // exists until a later heartbeat has joined every exact run.
      this.leases.startHeartbeat(() => {
        void this.heartbeat();
      });
      return;
    }
    await this.registerDevice();
    if (this.stopped || epoch !== this.lifecycleEpoch) {
      throw new Error("Execution placement stopped while registering.");
    }
    this.sessionReady = true;
    this.openSocket();
    await this.reconcileInbox();
    this.leases.startHeartbeat(() => {
      void this.heartbeat();
    });
  }

  async stop(): Promise<void> {
    if (this.stopTask) return await this.stopTask;
    // A call nobody can answer any more stops here too.
    this.deviceTools.stopAll();
    const task = this.stopAndQuiesce();
    this.stopTask = task;
    try {
      await task;
    } catch (error) {
      // The durable cancellation outbox remains pending. Let the host retry
      // this same stopped bridge; it must not create a replacement first.
      if (this.stopTask === task) this.stopTask = null;
      throw error;
    }
  }

  private async stopAndQuiesce(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.sessionReady = false;
    this.leases.stopHeartbeat();
    this.leases.cancelReconnect();
    this.leases.clearLeaseHistory();
    this.dispatchWatchers.clear();

    // No replacement bridge may take over presence until every continuation
    // already admitted by this instance has crossed the stop fence.
    await this.leases.joinHeartbeat();
    await Promise.allSettled([...this.offerTasks]);

    const now = this.now();
    for (const row of this.inbox.listAllUnfinished()) {
      if (["claimed", "accepted", "running"].includes(row.state)) {
        this.inbox.stageCancellation(row.dispatchId, {
          outcome: "canceled",
          errorCode: "LOCAL_EXECUTION_BRIDGE_STOPPED",
          errorMessage:
            "The desktop execution bridge stopped before the local run settled.",
          orphanOnAck:
            row.ownerGeneration !== this.ownerGeneration ||
            row.presenceSessionId !== this.presenceSessionId,
          now,
        });
      }
    }

    const cancellationResults = await Promise.all(
      this.inbox
        .listCancellationPending()
        .map((row) => this.retryCancellation(row.dispatchId)),
    );
    const cancellationsAcknowledged = cancellationResults.every(Boolean);
    if (cancellationsAcknowledged) {
      await Promise.allSettled([...this.executionTasks.values()]);
    }
    await Promise.allSettled(this.leases.cancellationsInFlight());

    for (const row of this.inbox.listAllUnfinished()) {
      if (row.state === "terminal_pending" && !row.cancelRpcPending) {
        await this.flushTerminal(row).catch((error) =>
          this.log(
            "warn",
            "Execution placement terminal receipt during stop was deferred.",
            error,
          ),
        );
      }
    }
    // Closing the proven socket is the drain: the gate marks this device
    // offline and re-places anything it still owns.
    this.closeSocket(1000, "desktop_stopped");
    this.rejectPendingWaits("The execution placement bridge stopped.");
    this.lifecycleEpoch += 1;
    if (!cancellationsAcknowledged) {
      throw new Error(
        "Execution placement stopped with an unacknowledged local cancellation.",
      );
    }
  }

  /**
   * A new bridge instance has no in-memory Promise that can still own a
   * pre-crash execution. Persist that ambiguity before presence is announced,
   * then let the exact-run cancellation outbox join it. A gate-side Stop that
   * already won keeps the truthful canceled outcome.
   */
  private async stageRestartCancellations() {
    const now = this.now();
    for (const row of this.inbox.listAllUnfinished()) {
      if (
        row.cancelRpcPending ||
        !["claimed", "accepted", "running"].includes(row.state)
      ) {
        continue;
      }
      let remoteCanceled = false;
      try {
        const remote = await this.getDispatchStatus(row.dispatchId);
        remoteCanceled =
          remote?.state === "cancel_pending" || remote?.state === "canceled";
      } catch (error) {
        // The local execution is still ambiguous even if the status read is
        // unavailable. Fail closed and reconcile its terminal meaning later.
        this.log(
          "warn",
          "Execution placement restart status reconciliation was deferred.",
          error,
        );
      }
      this.inbox.stageCancellation(row.dispatchId, {
        outcome: remoteCanceled ? "canceled" : "failed",
        ...(remoteCanceled
          ? { errorMessage: "Canceled by the user." }
          : {
              errorCode: "LOCAL_EXECUTION_INTERRUPTED",
              errorMessage:
                "The desktop restarted after local execution ownership was recorded.",
            }),
        now,
      });
    }
  }

  private async refreshIdentityAfterFence() {
    if (this.stopped || !this.started) return;
    const identity = await this.readIdentity();
    if (
      identity.ownerId === this.ownerId &&
      identity.ownerGeneration === this.ownerGeneration
    ) {
      this.builderOrigin = identity.builderOrigin;
      if (!this.sessionReady) {
        const cancellationsAcknowledged =
          await this.retryPendingCancellations();
        if (!cancellationsAcknowledged) {
          throw new Error(
            "Execution placement session recovery is waiting for local cancellation acknowledgement.",
          );
        }
        await Promise.allSettled([...this.executionTasks.values()]);
        await this.registerDevice();
        this.sessionReady = true;
        this.openSocket();
        await this.reconcileInbox();
      }
      return;
    }

    this.closeSocket(1000, "owner_rotated");
    this.leases.clearLeaseHistory();
    this.sessionReady = false;
    this.lifecycleEpoch += 1;
    await Promise.allSettled([...this.offerTasks]);
    this.ownerId = identity.ownerId;
    this.ownerGeneration = identity.ownerGeneration;
    this.builderOrigin = identity.builderOrigin;
    const nextSession = this.inbox.openSession({
      ownerId: identity.ownerId,
      ownerGeneration: identity.ownerGeneration,
      now: this.now(),
    });
    this.presenceSessionId = nextSession.presenceSessionId;
    const cancellationsAcknowledged = await this.retryPendingCancellations();
    if (!cancellationsAcknowledged) {
      throw new Error(
        "Execution placement owner rotation is waiting for local cancellation acknowledgement.",
      );
    }
    await Promise.allSettled([...this.executionTasks.values()]);
    await this.registerDevice();
    this.sessionReady = true;
    this.openSocket();
    await this.reconcileInbox();
  }

  // -------------------------------------------------------------------------
  // Heartbeat: lease renewal, claim-ACK retry, terminal receipts
  // -------------------------------------------------------------------------

  private heartbeat(): Promise<void> {
    return this.leases.heartbeat(() =>
      !this.started || this.stopped ? null : this.runHeartbeat(),
    );
  }

  private async runHeartbeat() {
    let identityRefreshNeeded = false;
    await this.retryPendingCancellations();
    if (!this.sessionReady) {
      await this.refreshIdentityAfterFence();
      return;
    }
    const active = this.inbox.listUnfinished(this.requireSession());
    try {
      await this.publishAvailability();
    } catch (error) {
      identityRefreshNeeded = true;
      this.log("warn", "Execution placement availability failed.", error);
    }
    const now = this.now();
    for (const row of active) {
      if (this.stopped) break;
      if (row.cancelRpcPending) {
        try {
          await this.renew(row);
          this.leases.clearRenewalFailure(row.dispatchId);
        } catch (error) {
          identityRefreshNeeded = true;
          this.log(
            "warn",
            "Execution placement cancellation lease renewal failed.",
            error,
          );
        }
        continue;
      }
      if (row.state === "claimed") {
        this.leases.clearRenewalFailure(row.dispatchId);
        if (this.leases.claimAckRetryIsDue(row.dispatchId)) {
          let remote: DispatchSummary | null = null;
          try {
            remote = await this.getDispatchStatus(row.dispatchId);
          } catch (error) {
            this.leases.noteClaimAckFailure(row.dispatchId);
            this.log(
              "warn",
              "Execution placement claim-ACK status retry was deferred.",
              error,
            );
            continue;
          }
          if (
            !remote ||
            remote.placement === "cloud" ||
            isTerminalState(remote.state)
          ) {
            this.leases.clearClaimAckRetry(row.dispatchId);
            this.inbox.markOrphaned(row.dispatchId, now);
          } else {
            this.launchLocal(row, remote);
          }
        }
        continue;
      }
      if (row.state === "terminal_pending") {
        this.leases.clearRenewalFailure(row.dispatchId);
        await this.flushTerminal(row).catch((error) =>
          this.log(
            "warn",
            "Execution placement terminal receipt retry was deferred.",
            error,
          ),
        );
        continue;
      }
      try {
        await this.renew(row);
        this.leases.clearRenewalFailure(row.dispatchId);
      } catch (error) {
        identityRefreshNeeded = true;
        const leaseLost = this.leases.noteRenewalFailure(row.dispatchId, now);
        this.log("warn", "Execution placement lease renewal failed.", error);
        if (isOwnerLifecycleFenceError(error) || leaseLost) {
          await this.cancelForLostLease(row);
        }
      }
    }
    this.inbox.pruneTerminal(now - 7 * 86_400_000);
    if (identityRefreshNeeded) {
      await this.refreshIdentityAfterFence().catch((error) =>
        this.log(
          "warn",
          "Execution placement identity refresh was deferred.",
          error,
        ),
      );
    }
  }

  private async cancelForLostLease(row: ExecutionPlacementInboxRow) {
    this.leases.clearRenewalFailure(row.dispatchId);
    this.inbox.stageCancellation(row.dispatchId, {
      outcome: "canceled",
      errorCode: "LOCAL_EXECUTION_LEASE_EXPIRED",
      errorMessage:
        "The desktop stopped executing because its server lease could not be renewed.",
      now: this.now(),
    });
    await this.retryCancellation(row.dispatchId);
  }

  private async retryPendingCancellations() {
    let acknowledged = true;
    for (const row of this.inbox.listCancellationPending()) {
      if (!(await this.retryCancellation(row.dispatchId))) acknowledged = false;
    }
    return acknowledged;
  }

  private retryCancellation(dispatchId: string): Promise<boolean> {
    return this.leases.retryCancellation(dispatchId, async () => {
      const row = this.inbox.get(dispatchId);
      if (!row?.cancelRpcPending) return true;
      try {
        let payload: Record<string, unknown> | undefined;
        try {
          payload = parseRecord(JSON.parse(row.payloadJson));
        } catch {
          payload = undefined;
        }
        await this.options.cancelExecution({
          dispatchId: row.dispatchId,
          kind: row.kind,
          conversationId: row.conversationId,
          ...(payload ? { payload } : {}),
        });
      } catch (error) {
        this.log(
          "warn",
          "Execution placement local cancellation RPC was deferred.",
          error,
        );
        return false;
      }
      const afterLocalCancel = this.inbox.get(row.dispatchId);
      if (!afterLocalCancel?.cancelRpcPending) return true;
      if (
        afterLocalCancel.ownerId !== this.ownerId ||
        afterLocalCancel.ownerGeneration !== this.ownerGeneration ||
        afterLocalCancel.presenceSessionId !== this.presenceSessionId
      ) {
        // Owner rotation already retired the presence session that owned this
        // handoff. The durable local cancel joined the effect, so orphan the
        // old receipt instead of speaking for a session the gate forgot.
        this.inbox.acknowledgeCancellation(
          afterLocalCancel.dispatchId,
          this.now(),
        );
        return true;
      }
      if (afterLocalCancel.state === "claimed") {
        // Never acknowledged: hand the dispatch straight back so the gate can
        // re-place it instead of waiting out the claim lease.
        if (
          !this.send({
            type: "release",
            dispatchId: afterLocalCancel.dispatchId,
            reason: "local execution canceled before claim acceptance",
          })
        ) {
          this.log(
            "warn",
            "Execution placement pre-acceptance claim release was deferred.",
          );
          return false;
        }
        this.inbox.acknowledgeClaimRelease(
          afterLocalCancel.dispatchId,
          this.now(),
        );
        this.leases.clearClaimAckRetry(afterLocalCancel.dispatchId);
        return true;
      }
      this.inbox.acknowledgeCancellation(
        afterLocalCancel.dispatchId,
        this.now(),
      );
      const acknowledged = this.inbox.get(afterLocalCancel.dispatchId);
      if (acknowledged?.state === "terminal_pending") {
        await this.flushTerminal(acknowledged).catch((error) =>
          this.log(
            "warn",
            "Execution placement cancellation receipt was deferred.",
            error,
          ),
        );
      }
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Offers, claims, and the local run
  // -------------------------------------------------------------------------

  private async handleOffer(frame: {
    dispatch: DispatchSummary;
    payloadJson: string;
    payloadHash: string;
    offerExpiresAt: number;
  }) {
    if (!this.started || this.stopped) return;
    const epoch = this.lifecycleEpoch;
    let dispatch: DispatchSummary;
    try {
      dispatch = parseDispatch(frame.dispatch);
    } catch (error) {
      this.log("warn", "Ignored a malformed offer.", error);
      return;
    }
    if (
      this.executing.has(dispatch.dispatchId) ||
      this.offersInFlight.has(dispatch.dispatchId) ||
      this.inbox.get(dispatch.dispatchId)
    ) {
      return;
    }
    this.offersInFlight.add(dispatch.dispatchId);
    try {
      await this.claimOffer(frame, dispatch, epoch);
    } finally {
      this.offersInFlight.delete(dispatch.dispatchId);
    }
  }

  private async claimOffer(
    frame: { payloadJson: string; payloadHash: string },
    dispatch: DispatchSummary,
    epoch: number,
  ) {
    if (typeof frame.payloadJson !== "string" || !frame.payloadJson) return;
    if (sha256(frame.payloadJson) !== frame.payloadHash) {
      this.log("warn", "Refused an offer whose payload hash did not match.");
      return;
    }
    const availability = await this.currentAvailability();
    if (!this.isLiveEpoch(epoch)) return;
    if (!availability.ready) return;

    const claimRequestId = `claim:${this.presenceSessionId}:${dispatch.dispatchId}`;
    const claimed = this.waitForClaim(dispatch.dispatchId);
    if (
      !this.send({
        type: "claim",
        dispatchId: dispatch.dispatchId,
        claimRequestId,
      })
    ) {
      this.settleClaim(dispatch.dispatchId, {
        error: new Error("The presence socket was not connected."),
      });
      await claimed.catch(() => undefined);
      return;
    }
    let claimExpiresAt: number;
    try {
      claimExpiresAt = await claimed;
    } catch (error) {
      this.log("warn", "Execution placement claim lost its race.", error);
      return;
    }
    const session = this.requireSession();
    try {
      this.inbox.persistClaim({
        ...session,
        claimToken: claimRequestId,
        claimed: {
          dispatch,
          payloadJson: frame.payloadJson,
          payloadHash: frame.payloadHash,
          claimExpiresAt,
        },
        now: this.now(),
      });
    } catch (error) {
      // The payload lives only in the offer until it is committed here. If the
      // transaction failed, hand it straight back rather than acknowledging.
      this.send({
        type: "release",
        dispatchId: dispatch.dispatchId,
        reason: "local inbox transaction failed",
      });
      throw error;
    }
    const local = this.inbox.get(dispatch.dispatchId)!;
    if (!this.isLiveEpoch(epoch)) {
      this.inbox.stageCancellation(dispatch.dispatchId, {
        outcome: "canceled",
        errorCode: "LOCAL_EXECUTION_BRIDGE_STOPPED",
        errorMessage:
          "The desktop execution bridge stopped before claim acceptance.",
        now: this.now(),
      });
      await this.retryCancellation(dispatch.dispatchId);
      return;
    }
    this.launchLocal(local, dispatch);
  }

  /**
   * Desktop ingress commits to this computer without an offer round-trip: the
   * gate answers `computer_accepted` and drops its copy of the payload at that
   * moment, so the payload this process submitted must become the inbox row
   * here — it is the only copy left. A gate that answers `computer_claimed`
   * instead still gets an `ack` first.
   */
  private async adoptCommittedDispatch(
    dispatch: DispatchSummary,
    payload: DispatchPayload,
  ) {
    if (
      dispatch.executorDeviceId !== this.options.deviceIdentity.deviceId ||
      (dispatch.state !== "computer_claimed" &&
        dispatch.state !== "computer_accepted")
    ) {
      return;
    }
    if (
      this.executing.has(dispatch.dispatchId) ||
      this.inbox.get(dispatch.dispatchId)
    ) {
      return;
    }
    const payloadJson = canonicalDispatchPayloadJson(payload);
    const session = this.requireSession();
    this.inbox.persistClaim({
      ...session,
      claimToken: `desktop:${dispatch.dispatchId}`,
      claimed: {
        dispatch,
        payloadJson,
        payloadHash: sha256(payloadJson),
        claimExpiresAt: this.now() + CLAIM_RESPONSE_TIMEOUT_MS,
      },
      now: this.now(),
    });
    if (dispatch.state === "computer_accepted") {
      // The gate already recorded acceptance; a second `ack` would be a
      // protocol error, so the row goes straight to accepted.
      this.inbox.markAccepted(dispatch.dispatchId, dispatch, this.now());
    }
    this.launchLocal(this.inbox.get(dispatch.dispatchId)!, dispatch);
  }

  /** Re-drives every unfinished row after a reconnect. */
  private async resumeAfterConnect() {
    await this.publishAvailability().catch((error) =>
      this.log("warn", "Execution placement availability failed.", error),
    );
    if (!this.sessionReady) return;
    for (const row of this.inbox.listUnfinished(this.requireSession())) {
      if (row.cancelRpcPending) {
        await this.retryCancellation(row.dispatchId);
        continue;
      }
      if (row.state === "terminal_pending") {
        await this.flushTerminal(row).catch((error) =>
          this.log(
            "warn",
            "Execution placement terminal receipt after reconnect was deferred.",
            error,
          ),
        );
        continue;
      }
      if (row.state === "running") {
        this.send({ type: "running", dispatchId: row.dispatchId });
      }
    }
  }

  private async reconcileInbox() {
    const session = this.requireSession();
    for (const row of this.inbox.listUnfinished(session)) {
      if (row.cancelRpcPending) {
        await this.retryCancellation(row.dispatchId);
        continue;
      }
      let remote: DispatchSummary | null = null;
      try {
        remote = await this.getDispatchStatus(row.dispatchId);
      } catch (error) {
        this.log("warn", "Execution inbox reconciliation was deferred.", error);
        continue;
      }
      if (!remote || remote.placement === "cloud") {
        if (["claimed", "accepted", "running"].includes(row.state)) {
          this.inbox.stageCancellation(row.dispatchId, {
            outcome: "canceled",
            errorCode: "LOCAL_EXECUTION_NO_LONGER_OWNED",
            errorMessage:
              "The server no longer assigned this execution to the desktop.",
            orphanOnAck: true,
            now: this.now(),
          });
          await this.retryCancellation(row.dispatchId);
        } else {
          this.inbox.markOrphaned(row.dispatchId, this.now());
        }
        continue;
      }
      if (isTerminalState(remote.state)) {
        if (["claimed", "accepted", "running"].includes(row.state)) {
          this.inbox.stageCancellation(row.dispatchId, {
            outcome: "canceled",
            errorCode: "LOCAL_EXECUTION_REMOTE_TERMINAL",
            errorMessage:
              "The server reached a terminal state before local reconciliation.",
            orphanOnAck: true,
            now: this.now(),
          });
          await this.retryCancellation(row.dispatchId);
        } else {
          this.inbox.markTerminal(row.dispatchId, remote, this.now());
        }
        continue;
      }
      if (remote.state === "cancel_pending") {
        // A cancellation can arrive while the desktop is down. Recover it
        // before classifying an in-flight local row as an interrupted failure,
        // and let it override a not-yet-accepted terminal receipt.
        await this.launchLocal(row, remote);
      } else if (row.state === "terminal_pending") {
        void this.flushTerminal(row).catch(() => undefined);
      } else if (row.state === "running") {
        // The process boundary erased the Promise that owned this run. Never
        // replay it: cancel any surviving worker run and report the ambiguity.
        this.inbox.stageCancellation(row.dispatchId, {
          outcome: "failed",
          errorCode: "LOCAL_EXECUTION_INTERRUPTED",
          errorMessage:
            "The desktop restarted after local execution began; Stella did not replay it because effects may already have occurred.",
          now: this.now(),
        });
        await this.retryCancellation(row.dispatchId);
      } else {
        this.launchLocal(row, remote);
      }
    }
  }

  private launchLocal(
    row: ExecutionPlacementInboxRow,
    remote: DispatchSummary,
  ): Promise<void> | undefined {
    if (this.executing.has(row.dispatchId) || this.stopped) return;
    this.executing.add(row.dispatchId);
    const epoch = this.lifecycleEpoch;
    const task = this.resumeLocal(row, remote, epoch);
    this.executionTasks.set(row.dispatchId, task);
    const clear = () => {
      if (this.executionTasks.get(row.dispatchId) === task) {
        this.executionTasks.delete(row.dispatchId);
        this.executing.delete(row.dispatchId);
      }
      void this.heartbeat();
    };
    void task.then(clear, clear);
    return task;
  }

  private async resumeLocal(
    row: ExecutionPlacementInboxRow,
    remote: DispatchSummary,
    epoch: number,
  ) {
    try {
      if (row.cancelRpcPending) {
        await this.retryCancellation(row.dispatchId);
        return;
      }
      if (remote.state === "cancel_pending") {
        await this.cancelAccepted(row);
        return;
      }
      if (row.state === "claimed") {
        // The payload is committed locally; taking ownership is one frame.
        if (!this.send({ type: "ack", dispatchId: row.dispatchId })) {
          this.leases.noteClaimAckFailure(row.dispatchId);
          return;
        }
        const accepted: DispatchSummary = {
          ...remote,
          state: "computer_accepted",
          placement: "computer",
          executorDeviceId: this.options.deviceIdentity.deviceId,
        };
        this.inbox.markAccepted(row.dispatchId, accepted, this.now());
        this.leases.clearClaimAckRetry(row.dispatchId);
        remote = accepted;
        row = this.inbox.get(row.dispatchId)!;
        if (!this.isLiveEpoch(epoch)) {
          this.inbox.stageCancellation(row.dispatchId, {
            outcome: "canceled",
            errorCode: "LOCAL_EXECUTION_BRIDGE_STOPPED",
            errorMessage:
              "The desktop execution bridge stopped after claim acceptance.",
            now: this.now(),
          });
          await this.retryCancellation(row.dispatchId);
          return;
        }
        if (row.cancelRpcPending) {
          await this.retryCancellation(row.dispatchId);
          return;
        }
      }
      if (row.state === "terminal_pending") {
        await this.flushTerminal(row).catch((error) =>
          this.log(
            "warn",
            "Execution placement terminal receipt was deferred.",
            error,
          ),
        );
        return;
      }
      this.inbox.markRunning(row.dispatchId, this.now());
      this.send({ type: "running", dispatchId: row.dispatchId });
      void this.publishAvailability().catch(() => undefined);
      row = this.inbox.get(row.dispatchId)!;
      if (!this.isLiveEpoch(epoch)) {
        this.inbox.stageCancellation(row.dispatchId, {
          outcome: "canceled",
          errorCode: "LOCAL_EXECUTION_BRIDGE_STOPPED",
          errorMessage:
            "The desktop execution bridge stopped before local launch.",
          now: this.now(),
        });
        await this.retryCancellation(row.dispatchId);
        return;
      }
      if (row.cancelRpcPending) {
        await this.retryCancellation(row.dispatchId);
        return;
      }
      let payload: Record<string, unknown>;
      try {
        payload = parseRecord(JSON.parse(row.payloadJson));
      } catch {
        this.inbox.markTerminalPending(row.dispatchId, {
          outcome: "failed",
          errorCode: "LOCAL_PAYLOAD_INVALID",
          errorMessage: "The durably accepted local payload was invalid.",
          now: this.now(),
        });
        await this.flushTerminal(this.inbox.get(row.dispatchId)!).catch(
          () => undefined,
        );
        return;
      }
      const result = await this.options.runExecution({
        dispatch: remote,
        payload,
        ownerGeneration: row.ownerGeneration,
      });
      const cancellation = this.inbox.get(row.dispatchId);
      if (
        cancellation?.cancelRpcPending ||
        cancellation?.state === "terminal" ||
        (cancellation?.state === "terminal_pending" &&
          cancellation.terminalOutcome === "canceled")
      ) {
        if (cancellation.state === "terminal_pending") {
          await this.flushTerminal(cancellation).catch(() => undefined);
        }
        return;
      }
      const canceled = result.status === "canceled";
      const failed = result.status === "error";
      const resultJson =
        result.status === "ok"
          ? terminalResultJson(result.finalText ?? "")
          : undefined;
      this.inbox.markTerminalPending(row.dispatchId, {
        outcome: canceled ? "canceled" : failed ? "failed" : "completed",
        ...(resultJson ? { resultJson } : {}),
        ...(failed ? { errorCode: "LOCAL_EXECUTION_FAILED" } : {}),
        ...((failed || canceled) && (result.error || result.finalText)
          ? { errorMessage: boundedResult(result.error || result.finalText) }
          : {}),
        now: this.now(),
      });
      await this.flushTerminal(this.inbox.get(row.dispatchId)!).catch((error) =>
        this.log(
          "warn",
          "Execution placement terminal receipt was deferred.",
          error,
        ),
      );
    } catch (error) {
      const current = this.inbox.get(row.dispatchId);
      if (
        current?.state === "claimed" &&
        !current.cancelRpcPending &&
        this.isLiveEpoch(epoch)
      ) {
        this.leases.noteClaimAckFailure(row.dispatchId);
        this.log(
          "warn",
          "Execution placement claim acknowledgement was deferred.",
          error,
        );
        return;
      }
      this.log("error", "Accepted local execution failed.", error);
      if (
        current &&
        !current.cancelRpcPending &&
        current.state !== "terminal_pending" &&
        current.state !== "terminal"
      ) {
        // A thrown execution call may be an ambiguous worker-transport result:
        // the effect can still exist even though the caller lost its response.
        // Cancel/reconcile that exact owner before reporting a failed receipt.
        this.inbox.stageCancellation(row.dispatchId, {
          outcome: "failed",
          errorCode: "LOCAL_EXECUTION_FAILED",
          errorMessage:
            error instanceof Error
              ? error.message.slice(0, 2_000)
              : "Local execution failed.",
          now: this.now(),
        });
        await this.retryCancellation(row.dispatchId);
      }
    }
  }

  private async renew(row: ExecutionPlacementInboxRow) {
    if (!this.send({ type: "renew", dispatchId: row.dispatchId })) {
      throw new Error("The presence socket is not connected.");
    }
  }

  private async cancelAccepted(row: ExecutionPlacementInboxRow) {
    if (row.state === "terminal" || row.state === "orphaned") return;
    this.inbox.stageCancellation(row.dispatchId, {
      outcome: "canceled",
      errorMessage: "Canceled by the user.",
      now: this.now(),
    });
    await this.retryCancellation(row.dispatchId);
  }

  /**
   * Reports one terminal outcome. The row stays `terminal_pending` until the
   * gate echoes a terminal `dispatch` frame (or a status read confirms one),
   * so a dropped socket replays the same receipt instead of losing it.
   *
   * Single-flight per dispatch: the local run and the cancellation path can
   * both reach a settled row, and the gate must see one receipt, not two.
   */
  private flushTerminal(row: ExecutionPlacementInboxRow): Promise<void> {
    const existing = this.terminalFlushes.get(row.dispatchId);
    if (existing) return existing;
    const task = this.flushTerminalOnce(row);
    this.terminalFlushes.set(row.dispatchId, task);
    const clear = () => {
      if (this.terminalFlushes.get(row.dispatchId) === task) {
        this.terminalFlushes.delete(row.dispatchId);
      }
    };
    void task.then(clear, clear);
    return task;
  }

  private async flushTerminalOnce(row: ExecutionPlacementInboxRow) {
    const current = this.inbox.get(row.dispatchId);
    if (
      !current ||
      current.cancelRpcPending ||
      current.state !== "terminal_pending" ||
      !current.terminalOutcome
    ) {
      return;
    }
    row = current;
    const outcome = current.terminalOutcome;
    const acknowledged = this.waitForCompletion(row.dispatchId);
    if (
      !this.send({
        type: "complete",
        dispatchId: row.dispatchId,
        outcome,
        ...(row.resultJson ? { resultJson: row.resultJson } : {}),
        ...(row.errorCode ? { errorCode: row.errorCode } : {}),
        ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
      })
    ) {
      const pending = this.pendingCompletes.get(row.dispatchId);
      this.pendingCompletes.delete(row.dispatchId);
      pending?.timer.cancel();
      pending?.reject(new Error("The presence socket is not connected."));
      await acknowledged.catch(() => undefined);
      throw new Error(
        "The terminal receipt could not be delivered to the owner gate.",
      );
    }
    let dispatch: DispatchSummary | null = null;
    try {
      dispatch = await acknowledged;
    } catch {
      // The gate may have committed the outcome without echoing it. One status
      // read settles the row; anything else replays on the next heartbeat.
      dispatch = await this.getDispatchStatus(row.dispatchId).catch(() => null);
      if (dispatch && !isTerminalState(dispatch.state)) dispatch = null;
    }
    if (!dispatch) {
      throw new Error(
        "The owner gate has not acknowledged the terminal receipt yet.",
      );
    }
    this.inbox.markTerminal(row.dispatchId, dispatch, this.now());
    void this.publishAvailability().catch(() => undefined);
  }
}

export const createExecutionPlacementBridge = (
  options: PlacementBridgeOptions,
) => new ExecutionPlacementBridge(options);
