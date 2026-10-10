import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { attachJsonRpcPeerToStreams } from "@stella/contracts/protocol/jsonl";
import { RPC_ERROR_CODES } from "@stella/contracts/protocol";
import {
  RpcError,
  createRuntimeUnavailableError,
  type JsonRpcPeer,
} from "@stella/contracts/protocol/rpc-peer";
import {
  RUNTIME_CLIENT_METHODS,
  STELLA_RUNTIME_CLIENT_PROTOCOL_VERSION,
  type RuntimeClientAttachParams,
} from "@stella/contracts/protocol/runtime-client";
import { resolveBundledRuntimeFile } from "../kernel/shared/runtime-paths.js";
import {
  isRuntimeHostHandler,
  RUNTIME_ATTACHMENT_STALE,
  RUNTIME_HOST_CALLS,
  RUNTIME_SERVER_MISMATCH,
  type FencedRuntimeAttachResult,
  type FencedRuntimeCallParams,
  type FencedRuntimeEventParams,
  type FencedRuntimeHostHandlerParams,
  type RuntimeAttachFence,
  type RuntimeHostCall,
  type RuntimeHostHandler,
} from "./client-protocol.js";
import { readRuntimeLaunchEnv } from "../worker/server-identity.js";
import {
  probeRunningWorker,
  removeStaleRuntimeArtifacts,
} from "../worker/lifecycle-server.js";
import { resolveRuntimePaths } from "../worker/runtime-paths.js";
import { Effect } from "effect";
import {
  forkDelayed,
  runHostEffect,
  type HostTimerHandle,
} from "./effect-runtime.js";
import { startOrAttachWorker, stopRunningWorker } from "./lifecycle.js";

export type RemoteRuntimeHostOptions = {
  initializeParams: RuntimeClientAttachParams["initializeParams"];
  /** The callbacks this app serves for the runtime host. */
  hostHandlers: Partial<
    Record<RuntimeHostHandler, (...args: never[]) => unknown>
  >;
  disableLocalScheduler?: boolean;
  /** The runtime entry to spawn; defaults to the bundled one. */
  workerEntryPath?: string;
  bunBinaryPath?: string;
};

/**
 * One socket to the runtime and the attachment it carries. Frames are only
 * applied while the connection is live: `retired` is set the moment it is
 * superseded, lost, or stopped, and every event and host callback must name
 * this connection's `attachmentId` (see the fencing note in
 * `client-protocol.ts`).
 */
type Connection = {
  peer: JsonRpcPeer;
  dispose: () => void;
  pid: number;
  attachmentId: string;
  /** The runtime instance this connection was fenced to, when known. */
  serverId: string | null;
  retired: boolean;
};

/** How many times one connect re-probes after the runtime was swapped under it. */
const SERVER_MISMATCH_RETRIES = 2;

/** At most one warning per drop reason per window, so a flood stays legible. */
const FENCE_LOG_WINDOW_MS = 10_000;

/** How long `stop({ shutdownRuntime })` waits for the runtime to exit. */
const RUNTIME_EXIT_TIMEOUT_MS = 15_000;

/** Backoff between reconnect attempts after the runtime goes away. */
const RECONNECT_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 5_000];

type RuntimeHostCalls = {
  [K in RuntimeHostCall]: (...args: any[]) => Promise<any>;
};

// The calls are installed per instance in the constructor.
export interface RemoteRuntimeHost extends RuntimeHostCalls {}

/**
 * The app's handle on the runtime process. It spawns the runtime or attaches
 * to the one already running, forwards host calls and events, and serves the
 * host's callbacks. When the runtime goes away (a restart, a crash) it
 * reconnects with backoff, spawning a fresh runtime if needed.
 *
 * Emits the host's events plus its own `runtime-connected` and
 * `runtime-disconnected` for the socket.
 */
export class RemoteRuntimeHost {
  private readonly events = new EventEmitter();
  private connection: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  private started = false;
  /** Detached by `stop()`: calls fail instead of reattaching until `start()`. */
  private stopped = false;
  private reconnectTimer: HostTimerHandle | null = null;
  private reconnectAttempt = 0;
  private readonly fenceLogAt = new Map<string, number>();
  private fenceDrops = 0;

  constructor(private readonly options: RemoteRuntimeHostOptions) {
    this.events.setMaxListeners(0);
    for (const method of RUNTIME_HOST_CALLS) {
      this[method] = (...args: unknown[]) => this.call(method, args);
    }
  }

  on(eventName: string, listener: (payload: any) => void): () => void {
    this.events.on(eventName, listener);
    return () => {
      this.events.removeListener(eventName, listener);
    };
  }

  async start(): Promise<void> {
    this.started = true;
    this.stopped = false;
    await this.ensureConnected();
  }

  /**
   * Detach from the runtime. The runtime keeps running for the next app,
   * unless `shutdownRuntime` asks it to exit (quit, or a reset that deletes
   * its files); then this returns once it has released everything, or after
   * `exitTimeoutMs` with the runtime still finishing its own bounded exit.
   */
  async stop(
    options: {
      shutdownRuntime?: boolean;
      /** The app is quitting: the runtime interrupts its turns and exits once detached. */
      quit?: boolean;
      exitTimeoutMs?: number;
    } = {},
  ): Promise<void> {
    this.started = false;
    this.stopped = true;
    const shutdownRequested = options.shutdownRuntime
      ? await this.requestRuntimeShutdown(options.quit === true)
      : false;
    this.reconnectTimer?.cancel();
    this.reconnectTimer = null;
    const connection = this.connection;
    this.connection = null;
    if (connection) connection.retired = true;
    connection?.dispose();
    // A connect still in flight lands after this; drop it unless restarted.
    void this.connecting?.then(
      (late) => {
        if (this.started || this.connection !== late) return;
        this.connection = null;
        late.retired = true;
        late.dispose();
      },
      () => undefined,
    );
    this.events.emit("runtime-disconnected", { reason: "stopped" });
    // Detached first: a quitting runtime exits once its app has gone.
    if (shutdownRequested) {
      await this.waitForRuntimeExit(
        options.exitTimeoutMs ?? RUNTIME_EXIT_TIMEOUT_MS,
      );
    }
  }

  private async requestRuntimeShutdown(quit: boolean): Promise<boolean> {
    const connection = this.connection;
    if (!connection || connection.peer.isClosed()) return false;
    await connection.peer
      .request(RUNTIME_CLIENT_METHODS.SHUTDOWN, quit ? { mode: "quit" } : {})
      .catch(() => undefined);
    return true;
  }

  private async waitForRuntimeExit(exitTimeoutMs: number): Promise<void> {
    // The runtime drops its pidfile last, after its databases are closed.
    const stellaAppDir = this.options.initializeParams.stellaAppDir;
    const deadline = Date.now() + exitTimeoutMs;
    while (Date.now() < deadline && (await probeRunningWorker(stellaAppDir)) != null) {
      await runHostEffect(Effect.sleep(50));
    }
  }

  async call(method: RuntimeHostCall, args: unknown[]): Promise<any> {
    // A late call (a window still polling while the app quits) must not
    // reattach: a reattached app would hold the quitting runtime open.
    if (this.stopped) {
      throw createRuntimeUnavailableError("Stella's runtime has been stopped.");
    }
    const connection = await this.ensureConnected();
    return await connection.peer.request(RUNTIME_CLIENT_METHODS.CALL, {
      method,
      args,
      attachmentId: connection.attachmentId,
    } satisfies FencedRuntimeCallParams);
  }

  private async ensureConnected(): Promise<Connection> {
    const live = this.connection;
    if (live && !live.peer.isClosed()) return live;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return await this.connecting;
  }

  private async connect(): Promise<Connection> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.connectOnce();
      } catch (error) {
        // The runtime that answered the probe was replaced before the attach
        // landed on the peer socket. Probe again: the attach pipeline sees
        // whichever runtime owns the socket now.
        if (!isServerMismatch(error) || attempt >= SERVER_MISMATCH_RETRIES) {
          throw error;
        }
        console.warn(
          "[runtime-client] Runtime changed between probe and attach; re-probing.",
        );
      }
    }
  }

  private async connectOnce(): Promise<Connection> {
    const stellaAppDir = this.options.initializeParams.stellaAppDir;
    const attached = await startOrAttachWorker({
      stellaAppDir,
      workerEntryPath:
        this.options.workerEntryPath ??
        resolveBundledRuntimeFile("worker/entry.js"),
      ...(this.bunBinaryPath() ? { bunBinaryPath: this.bunBinaryPath() } : {}),
      expectedProtocolVersion: STELLA_RUNTIME_CLIENT_PROTOCOL_VERSION,
      // Under Electron, the runtime's child processes use this binary as
      // Node (ELECTRON_RUN_AS_NODE); a different binary respawns the runtime.
      ...(process.versions.electron ? { hostExecutablePath: process.execPath } : {}),
      // Adopt only a runtime that proves it is this root's, the pidfile's,
      // and booted with the environment this app shares with it.
      verifyIdentity: { launchEnv: readRuntimeLaunchEnv(process.env) },
    });
    const handle = attachJsonRpcPeerToStreams({
      input: attached.socket,
      output: attached.socket,
      onError: (error) => {
        console.error("[runtime-client] RPC error:", error);
      },
    });
    const connection: Connection = {
      peer: handle.peer,
      // Ending the socket is what tells the runtime this app has detached.
      dispose: () => {
        handle.dispose();
        attached.socket.end();
      },
      pid: attached.identity?.pid ?? attached.pid,
      attachmentId: randomUUID(),
      serverId: attached.identity?.serverId ?? null,
      retired: false,
    };
    handle.peer.registerRequestHandler(
      RUNTIME_CLIENT_METHODS.HOST_HANDLER,
      (params) => this.runHostHandler(connection, params),
    );
    handle.peer.registerNotificationHandler(
      RUNTIME_CLIENT_METHODS.EVENT,
      (params) => {
        const event = params as FencedRuntimeEventParams;
        if (typeof event?.name !== "string") return;
        if (!this.acceptsFrame(connection, event.attachmentId, `event:${event.name}`)) {
          return;
        }
        this.events.emit(event.name, event.payload);
      },
    );
    handle.peer.on("closed", () => this.handleConnectionLost(connection));
    const fence: RuntimeAttachFence = {
      attachmentId: connection.attachmentId,
      expectedRootHash: attached.paths.rootHash,
      ...(connection.serverId ? { expectedServerId: connection.serverId } : {}),
    };
    try {
      const result = await handle.peer.request<FencedRuntimeAttachResult>(
        RUNTIME_CLIENT_METHODS.ATTACH,
        {
          initializeParams: this.options.initializeParams,
          ...(this.options.disableLocalScheduler
            ? { disableLocalScheduler: true }
            : {}),
          ...fence,
        } satisfies RuntimeClientAttachParams & RuntimeAttachFence,
      );
      // The runtime must echo the instance and attachment this client
      // fenced to; anything else is a route this client did not ask for.
      if (
        (connection.serverId &&
          result.serverId !== undefined &&
          result.serverId !== connection.serverId) ||
        (result.attachmentId !== undefined &&
          result.attachmentId !== connection.attachmentId)
      ) {
        throw new RpcError(
          RPC_ERROR_CODES.INVALID_PARAMS,
          `${RUNTIME_SERVER_MISMATCH}: attached to runtime ${String(result.serverId)} / attachment ${String(result.attachmentId)}, expected ${String(connection.serverId)} / ${connection.attachmentId}.`,
        );
      }
    } catch (error) {
      connection.retired = true;
      handle.dispose();
      throw error;
    }
    if (connection.retired) {
      // Lost while attaching; handleConnectionLost already ran.
      throw new RpcError(
        RPC_ERROR_CODES.RUNTIME_UNAVAILABLE,
        "The Stella runtime connection closed while attaching.",
      );
    }
    const previous = this.connection;
    if (previous && previous !== connection) {
      previous.retired = true;
      previous.dispose();
    }
    this.connection = connection;
    this.reconnectAttempt = 0;
    this.events.emit("runtime-connected", undefined);
    void this.call("health", []).then(
      (snapshot) => this.events.emit("runtime-ready", snapshot),
      () => undefined,
    );
    return connection;
  }

  /**
   * Whether a frame from `connection` naming `attachmentId` may be applied.
   * Frames on a retired connection (superseded, lost, or stopped), after
   * stop(), or naming another attachment are dropped and logged. A frame without an attachment comes
   * from a runtime that predates fencing (the identity handshake replaces
   * those on connect) and is judged by its connection alone.
   */
  private acceptsFrame(
    connection: Connection,
    attachmentId: string | undefined,
    label: string,
  ): boolean {
    let reason: string | null = null;
    if (connection.retired) {
      reason = "retired-connection";
    } else if (!this.started) {
      // stop() ran while this connection was still attaching.
      reason = "client-stopped";
    } else if (
      attachmentId !== undefined &&
      attachmentId !== connection.attachmentId
    ) {
      reason = "attachment-mismatch";
    }
    if (!reason) return true;
    this.noteFenceDrop(reason, label, connection, attachmentId);
    return false;
  }

  private noteFenceDrop(
    reason: string,
    label: string,
    connection: Connection,
    attachmentId: string | undefined,
  ): void {
    this.fenceDrops += 1;
    const now = Date.now();
    const last = this.fenceLogAt.get(reason) ?? 0;
    if (now - last < FENCE_LOG_WINDOW_MS) return;
    this.fenceLogAt.set(reason, now);
    console.warn(
      `[runtime-client] Dropped stale runtime frame (${reason}): ${label} attachment=${String(attachmentId)} connection=${connection.attachmentId} server=${String(connection.serverId)} totalDropped=${this.fenceDrops}`,
    );
  }

  private bunBinaryPath(): string | undefined {
    return (
      this.options.bunBinaryPath ?? (process.env.STELLA_BUN_PATH?.trim() || undefined)
    );
  }

  private handleConnectionLost(connection: Connection): void {
    connection.retired = true;
    if (this.connection !== connection) return;
    this.connection = null;
    this.events.emit("runtime-disconnected", {
      reason: "Stella is reconnecting to its runtime.",
    });
    if (this.started) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.started) return;
    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
      ]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = forkDelayed(delay, () => {
      this.reconnectTimer = null;
      if (!this.started) return;
      this.ensureConnected().catch((error) => {
        console.warn(
          "[runtime-client] Reconnect failed:",
          error instanceof Error ? error.message : error,
        );
        this.scheduleReconnect();
      });
    });
  }

  private async runHostHandler(
    connection: Connection,
    value: unknown,
  ): Promise<unknown> {
    const params = value as FencedRuntimeHostHandlerParams | null;
    const name = params?.name;
    if (
      !this.acceptsFrame(
        connection,
        params?.attachmentId,
        `hostHandler:${String(name)}`,
      )
    ) {
      throw new RpcError(
        RPC_ERROR_CODES.INVALID_PARAMS,
        `${RUNTIME_ATTACHMENT_STALE}: ${String(name)} was sent to a route this app no longer serves.`,
      );
    }
    const handler = isRuntimeHostHandler(name)
      ? this.options.hostHandlers[name]
      : undefined;
    if (!handler) {
      throw new RpcError(
        RPC_ERROR_CODES.METHOD_NOT_FOUND,
        `This app does not serve ${String(name)}.`,
      );
    }
    const args = Array.isArray(params?.args) ? params.args : [];
    return await (handler as (...args: unknown[]) => unknown)(...args);
  }
}

const isServerMismatch = (error: unknown): boolean =>
  error instanceof Error && error.message.includes(RUNTIME_SERVER_MISMATCH);

/**
 * Permanently retire a runtime root the app no longer uses (a moved
 * install): stop its runtime and remove its control files, so nothing is
 * left running under the old identity.
 */
export const retireRuntimeRoot = async (
  stellaAppDir: string,
): Promise<{ stopped: boolean; pid: number | null }> => {
  const result = await stopRunningWorker(stellaAppDir, { graceMs: 1_500 });
  const remainingPid = await probeRunningWorker(stellaAppDir);
  if (remainingPid != null) {
    throw new Error(
      `Runtime ${remainingPid} did not stop while retiring ${JSON.stringify(stellaAppDir)}.`,
    );
  }
  await removeStaleRuntimeArtifacts(stellaAppDir);
  await rm(resolveRuntimePaths(stellaAppDir).rootDir, {
    recursive: true,
    force: true,
  });
  return result;
};
