import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { attachJsonRpcPeerToStreams } from "@stella/contracts/protocol/jsonl";
import { RPC_ERROR_CODES } from "@stella/contracts/protocol";
import { RpcError, type JsonRpcPeer } from "@stella/contracts/protocol/rpc-peer";
import {
  RUNTIME_CLIENT_METHODS,
  STELLA_RUNTIME_CLIENT_PROTOCOL_VERSION,
  type RuntimeClientAttachParams,
  type RuntimeClientAttachResult,
  type RuntimeClientEventParams,
  type RuntimeClientHostHandlerParams,
} from "@stella/contracts/protocol/runtime-client";
import { resolveBundledRuntimeFile } from "../kernel/shared/runtime-paths.js";
import {
  isRuntimeHostHandler,
  RUNTIME_HOST_CALLS,
  type RuntimeHostCall,
  type RuntimeHostHandler,
} from "./client-protocol.js";
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

type Connection = { peer: JsonRpcPeer; dispose: () => void; pid: number };

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
  private reconnectTimer: HostTimerHandle | null = null;
  private reconnectAttempt = 0;

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
    await this.ensureConnected();
  }

  /**
   * Detach from the runtime. The runtime keeps running for the next app,
   * unless `shutdownRuntime` asks it to exit (a reset that deletes its
   * files); then this returns once it has released everything.
   */
  async stop(options: { shutdownRuntime?: boolean } = {}): Promise<void> {
    this.started = false;
    if (options.shutdownRuntime) await this.shutdownRuntime();
    this.reconnectTimer?.cancel();
    this.reconnectTimer = null;
    const connection = this.connection;
    this.connection = null;
    connection?.dispose();
    // A connect still in flight lands after this; drop it unless restarted.
    void this.connecting?.then(
      (late) => {
        if (this.started || this.connection !== late) return;
        this.connection = null;
        late.dispose();
      },
      () => undefined,
    );
    this.events.emit("runtime-disconnected", { reason: "stopped" });
  }

  private async shutdownRuntime(): Promise<void> {
    const connection = this.connection;
    if (!connection || connection.peer.isClosed()) return;
    await connection.peer
      .request(RUNTIME_CLIENT_METHODS.SHUTDOWN, {})
      .catch(() => undefined);
    // The runtime drops its pidfile last, after its databases are closed.
    const stellaAppDir = this.options.initializeParams.stellaAppDir;
    const deadline = Date.now() + RUNTIME_EXIT_TIMEOUT_MS;
    while (Date.now() < deadline && (await probeRunningWorker(stellaAppDir)) != null) {
      await runHostEffect(Effect.sleep(50));
    }
  }

  async call(method: RuntimeHostCall, args: unknown[]): Promise<any> {
    const connection = await this.ensureConnected();
    return await connection.peer.request(RUNTIME_CLIENT_METHODS.CALL, {
      method,
      args,
    });
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
    const attached = await startOrAttachWorker({
      stellaAppDir: this.options.initializeParams.stellaAppDir,
      workerEntryPath:
        this.options.workerEntryPath ??
        resolveBundledRuntimeFile("worker/entry.js"),
      ...(this.bunBinaryPath() ? { bunBinaryPath: this.bunBinaryPath() } : {}),
      expectedProtocolVersion: STELLA_RUNTIME_CLIENT_PROTOCOL_VERSION,
      // Under Electron, the runtime's child processes use this binary as
      // Node (ELECTRON_RUN_AS_NODE); a different binary respawns the runtime.
      ...(process.versions.electron ? { hostExecutablePath: process.execPath } : {}),
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
      dispose: handle.dispose,
      pid: attached.pid,
    };
    handle.peer.registerRequestHandler(
      RUNTIME_CLIENT_METHODS.HOST_HANDLER,
      (params) => this.runHostHandler(params),
    );
    handle.peer.registerNotificationHandler(
      RUNTIME_CLIENT_METHODS.EVENT,
      (params) => {
        const event = params as RuntimeClientEventParams;
        if (typeof event?.name === "string") {
          this.events.emit(event.name, event.payload);
        }
      },
    );
    handle.peer.on("closed", () => this.handleConnectionLost(connection));
    try {
      await handle.peer.request<RuntimeClientAttachResult>(
        RUNTIME_CLIENT_METHODS.ATTACH,
        {
          initializeParams: this.options.initializeParams,
          ...(this.options.disableLocalScheduler
            ? { disableLocalScheduler: true }
            : {}),
        } satisfies RuntimeClientAttachParams,
      );
    } catch (error) {
      handle.dispose();
      throw error;
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

  private bunBinaryPath(): string | undefined {
    return (
      this.options.bunBinaryPath ?? (process.env.STELLA_BUN_PATH?.trim() || undefined)
    );
  }

  private handleConnectionLost(connection: Connection): void {
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

  private async runHostHandler(value: unknown): Promise<unknown> {
    const params = value as RuntimeClientHostHandlerParams | null;
    const name = params?.name;
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
