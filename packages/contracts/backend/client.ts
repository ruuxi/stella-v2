/**
 * The one client for the Stella backend, shared by desktop, mobile, the
 * website and the runtime. It has no framework dependency; each app wraps
 * `watch` in its own hook.
 *
 * Calls are plain HTTP. Views share one socket per client: identical
 * subscriptions (same view and arguments) share one server subscription and
 * fan out locally, a reconnect resubscribes everything, and a token refresh
 * happens in place when the server asks for one.
 */

import type {
  CallArgs,
  CallName,
  CallResult,
  ViewArgs,
  ViewName,
  ViewResult,
} from "./api.js";
import {
  LIVE_CLOSE,
  LIVE_PATH,
  LIVE_SUBPROTOCOL,
  LIVE_TOKEN_SUBPROTOCOL_PREFIX,
  rpcPath,
  type BackendError,
  type LiveClientFrame,
  type LiveServerFrame,
  type RpcResponse,
} from "./protocol.js";

export class BackendRequestError extends Error {
  readonly code: BackendError["code"];
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(error: BackendError) {
    super(error.message);
    this.name = "BackendRequestError";
    this.code = error.code;
    this.retryable = error.retryable;
    if (error.retryAfterMs !== undefined) this.retryAfterMs = error.retryAfterMs;
  }
}

/** `force` asks for a token newer than any cached one. */
export type TokenProvider = (options?: {
  force?: boolean;
}) => Promise<string | null>;

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

type SocketConstructor = new (url: string, protocols: string[]) => SocketLike;

export type BackendClientOptions = {
  /** Backend worker origin, e.g. `https://api.stella.sh`. */
  baseUrl: string;
  getToken: TokenProvider;
  fetch?: typeof fetch;
  WebSocket?: SocketConstructor;
  /** Upper bound on reconnect backoff. */
  maxReconnectDelayMs?: number;
  onConnectionChange?: (connected: boolean) => void;
};

type Listener = {
  onValue: (value: unknown) => void;
  onError?: (error: BackendRequestError) => void;
};

type Subscription = {
  id: string;
  view: string;
  args: unknown;
  listeners: Set<Listener>;
  hasValue: boolean;
  value: unknown;
};

const SOCKET_OPEN = 1;
const PING_INTERVAL_MS = 30_000;
const IDLE_CLOSE_DELAY_MS = 5_000;

const subscriptionKey = (view: string, args: unknown): string =>
  `${view}\u0000${stableStringify(args)}`;

/** JSON with sorted object keys, so `{a,b}` and `{b,a}` share a subscription. */
export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
};

const toError = (error: unknown): BackendRequestError =>
  error instanceof BackendRequestError
    ? error
    : new BackendRequestError({
        code: "UNAVAILABLE",
        message:
          error instanceof Error ? error.message : "The request failed.",
        retryable: true,
      });

export class BackendClient {
  private readonly baseUrl: string;
  private readonly getToken: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly SocketImpl: SocketConstructor | undefined;
  private readonly maxReconnectDelayMs: number;
  private readonly onConnectionChange?: (connected: boolean) => void;

  private readonly subscriptions = new Map<string, Subscription>();
  private readonly subscriptionsById = new Map<string, Subscription>();
  private nextSubscriptionId = 1;
  private socket: SocketLike | null = null;
  private connecting = false;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private forceTokenOnConnect = false;
  private disposed = false;

  constructor(options: BackendClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.getToken = options.getToken;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.SocketImpl =
      options.WebSocket ??
      (typeof WebSocket === "undefined"
        ? undefined
        : (WebSocket as unknown as SocketConstructor));
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
    this.onConnectionChange = options.onConnectionChange;
  }

  /** Run a backend function once. Throws `BackendRequestError`. */
  async call<K extends CallName>(
    name: K,
    args: CallArgs<K>,
  ): Promise<CallResult<K>> {
    let response = await this.postCall(name, args, false);
    if (response.status === 401) {
      response = await this.postCall(name, args, true);
    }
    let body: RpcResponse<CallResult<K>>;
    try {
      body = (await response.json()) as RpcResponse<CallResult<K>>;
    } catch {
      throw new BackendRequestError({
        code: response.status >= 500 ? "UNAVAILABLE" : "INTERNAL",
        message: `The backend returned an unreadable response (${response.status}).`,
        retryable: response.status >= 500,
      });
    }
    if (!body.ok) throw new BackendRequestError(body.error);
    return body.value;
  }

  /**
   * Subscribe to a view. `onValue` fires with the current value (immediately
   * if another subscriber already has it) and again on every change.
   * Returns the unsubscribe function.
   */
  watch<K extends ViewName>(
    view: K,
    args: ViewArgs<K>,
    onValue: (value: ViewResult<K>) => void,
    onError?: (error: BackendRequestError) => void,
  ): () => void {
    if (this.disposed) return () => {};
    const key = subscriptionKey(view, args);
    let subscription = this.subscriptions.get(key);
    if (!subscription) {
      subscription = {
        id: String(this.nextSubscriptionId++),
        view,
        args,
        listeners: new Set(),
        hasValue: false,
        value: undefined,
      };
      this.subscriptions.set(key, subscription);
      this.subscriptionsById.set(subscription.id, subscription);
      this.sendFrame({ t: "sub", id: subscription.id, view, args });
    }
    const listener: Listener = {
      onValue: onValue as (value: unknown) => void,
      ...(onError ? { onError } : {}),
    };
    subscription.listeners.add(listener);
    if (subscription.hasValue) onValue(subscription.value as ViewResult<K>);
    this.cancelIdleClose();
    this.ensureSocket();
    const owned = subscription;
    return () => {
      owned.listeners.delete(listener);
      if (owned.listeners.size > 0) return;
      this.subscriptions.delete(key);
      this.subscriptionsById.delete(owned.id);
      this.sendFrame({ t: "unsub", id: owned.id });
      if (this.subscriptions.size === 0) this.scheduleIdleClose();
    };
  }

  /** Close the socket and drop every subscription. */
  dispose(): void {
    this.disposed = true;
    this.subscriptions.clear();
    this.subscriptionsById.clear();
    this.clearTimers();
    this.closeSocket(1000, "client_disposed");
  }

  /** Reconnect now with a freshly fetched token (e.g. after sign-in). */
  reconnect(): void {
    this.forceTokenOnConnect = true;
    this.closeSocket(1000, "client_reconnect");
    this.reconnectAttempt = 0;
    this.ensureSocket();
  }

  private async postCall(
    name: string,
    args: unknown,
    force: boolean,
  ): Promise<Response> {
    const token = await this.getToken(force ? { force: true } : undefined);
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      return await this.fetchImpl(`${this.baseUrl}${rpcPath(name)}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ args: args ?? {} }),
      });
    } catch (error) {
      throw toError(error);
    }
  }

  private ensureSocket(): void {
    if (
      this.disposed ||
      this.socket ||
      this.connecting ||
      this.reconnectTimer ||
      this.subscriptions.size === 0 ||
      !this.SocketImpl
    ) {
      return;
    }
    this.connecting = true;
    const force = this.forceTokenOnConnect;
    this.forceTokenOnConnect = false;
    void this.getToken(force ? { force: true } : undefined)
      .then((token) => {
        this.connecting = false;
        if (this.disposed || this.subscriptions.size === 0) return;
        if (!token) {
          this.failAll({
            code: "UNAUTHENTICATED",
            message: "Sign in to load this.",
            retryable: false,
          });
          return;
        }
        this.openSocket(token);
      })
      .catch(() => {
        this.connecting = false;
        this.scheduleReconnect();
      });
  }

  private openSocket(token: string): void {
    const url = `${this.baseUrl.replace(/^http/, "ws")}${LIVE_PATH}`;
    let socket: SocketLike;
    try {
      socket = new this.SocketImpl!(url, [
        LIVE_SUBPROTOCOL,
        `${LIVE_TOKEN_SUBPROTOCOL_PREFIX}${token}`,
      ]);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.setConnected(true);
      for (const subscription of this.subscriptions.values()) {
        this.sendFrame({
          t: "sub",
          id: subscription.id,
          view: subscription.view,
          args: subscription.args,
        });
      }
      this.startPing();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleFrame(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPing();
      this.setConnected(false);
      if (this.disposed || this.subscriptions.size === 0) return;
      if (event.code === LIVE_CLOSE.unauthenticated) {
        this.forceTokenOnConnect = true;
      }
      if (event.code === LIVE_CLOSE.protocol) {
        this.failAll({
          code: "BAD_REQUEST",
          message: event.reason || "The live connection was refused.",
          retryable: false,
        });
        return;
      }
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // `onclose` follows and owns the reconnect.
    };
  }

  private handleFrame(data: unknown): void {
    let frame: LiveServerFrame;
    try {
      frame = JSON.parse(
        typeof data === "string" ? data : String(data),
      ) as LiveServerFrame;
    } catch {
      return;
    }
    if (frame.t === "value") {
      const subscription = this.subscriptionsById.get(frame.id);
      if (!subscription) return;
      subscription.hasValue = true;
      subscription.value = frame.value;
      for (const listener of [...subscription.listeners]) {
        listener.onValue(frame.value);
      }
      return;
    }
    if (frame.t === "error") {
      const subscription = this.subscriptionsById.get(frame.id);
      if (!subscription) return;
      const error = new BackendRequestError(frame.error);
      for (const listener of [...subscription.listeners]) {
        listener.onError?.(error);
      }
      return;
    }
    if (frame.t === "reauth") {
      void this.getToken({ force: true })
        .then((token) => {
          if (token) this.sendFrame({ t: "auth", token });
        })
        .catch(() => {
          // The server closes the socket at expiry; reconnect handles it.
        });
    }
  }

  private failAll(error: BackendError): void {
    const failure = new BackendRequestError(error);
    for (const subscription of this.subscriptions.values()) {
      for (const listener of [...subscription.listeners]) {
        listener.onError?.(failure);
      }
    }
  }

  private sendFrame(frame: LiveClientFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // A failed send means the socket is closing; `onclose` resubscribes.
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const base = Math.min(
      this.maxReconnectDelayMs,
      250 * 2 ** Math.min(this.reconnectAttempt, 10),
    );
    this.reconnectAttempt += 1;
    const delay = base / 2 + Math.random() * (base / 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, delay);
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.subscriptions.size === 0) this.closeSocket(1000, "idle");
    }, IDLE_CLOSE_DELAY_MS);
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(
      () => this.sendFrame({ t: "ping" }),
      PING_INTERVAL_MS,
    );
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopPing();
    this.cancelIdleClose();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.stopPing();
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(code, reason);
      } catch {
        // Already closed.
      }
    }
    this.setConnected(false);
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.onConnectionChange?.(connected);
  }
}
