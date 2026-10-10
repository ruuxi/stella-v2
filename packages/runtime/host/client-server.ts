import { randomUUID } from "node:crypto";
import { RPC_ERROR_CODES } from "@stella/contracts/protocol";
import {
  createRuntimeUnavailableError,
  RpcError,
  type JsonRpcPeer,
} from "@stella/contracts/protocol/rpc-peer";
import {
  RUNTIME_CLIENT_METHODS,
  type RuntimeClientAttachParams,
} from "@stella/contracts/protocol/runtime-client";
import { getFileLogger } from "../observability/file-logger.js";
import type { RuntimeServerIdentity } from "../worker/server-identity.js";
import {
  isRuntimeHostCall,
  readAttachmentId,
  RUNTIME_ATTACHMENT_STALE,
  RUNTIME_HOST_HANDLERS,
  RUNTIME_SERVER_MISMATCH,
  type FencedRuntimeAttachResult,
  type FencedRuntimeEventParams,
  type FencedRuntimeHostHandlerParams,
  type RuntimeAttachFence,
  type RuntimeHostHandler,
} from "./client-protocol.js";
import { forkDelayed, type HostTimerHandle } from "./effect-runtime.js";

/** What the client server needs from the runtime host. */
export type RuntimeClientServerHost = {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  ensureWorkerStarted(): Promise<unknown>;
  checkRuntimeStaleness(): Promise<void>;
  onAny(listener: (eventName: string, payload: unknown) => void): () => void;
};

export type RuntimeHostHandlers = Record<
  RuntimeHostHandler,
  (...args: unknown[]) => Promise<unknown>
>;

export type RuntimeClientServerOptions = {
  createHost: (
    params: RuntimeClientAttachParams,
    hostHandlers: RuntimeHostHandlers,
  ) => RuntimeClientServerHost;
  /** How long a host callback waits for a client to attach. */
  clientWaitMs?: number;
  /** A client asked the runtime to exit. */
  onShutdownRequested?: () => void;
  /**
   * The app is quitting: interrupt its work now and exit once it has
   * detached. Without this, a quit is handled as `onShutdownRequested`.
   */
  onQuitRequested?: () => Promise<void>;
  /**
   * This runtime's identity. When set, an attach naming another instance or
   * root is refused, and the attach result reports the `serverId`.
   */
  identity?: RuntimeServerIdentity;
};

const DEFAULT_CLIENT_WAIT_MS = 30_000;

/**
 * Callbacks with nothing to return: a missing app just means nobody sees
 * them, so they settle instead of rejecting (the host fires some unawaited).
 */
const BEST_EFFORT_HANDLERS = new Set<RuntimeHostHandler>([
  "displayUpdate",
  "showNotification",
  "showWindow",
  "focusWindow",
]);

const invalidParams = (message: string) =>
  new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, message);

const readAttachParams = (value: unknown): RuntimeClientAttachParams => {
  const params = value as Partial<RuntimeClientAttachParams> | null;
  const init = params?.initializeParams;
  if (
    !init ||
    typeof init.stellaAppDir !== "string" ||
    typeof init.stellaDataDirPath !== "string" ||
    typeof init.stellaWorkspacePath !== "string" ||
    typeof init.clientName !== "string"
  ) {
    throw invalidParams("runtime.attach needs initializeParams.");
  }
  return {
    initializeParams: init,
    ...(params.disableLocalScheduler === true
      ? { disableLocalScheduler: true }
      : {}),
  };
};

const readAttachFence = (value: unknown): RuntimeAttachFence => {
  const params = value as Record<string, unknown> | null;
  const attachmentId = readAttachmentId(params?.attachmentId);
  return {
    ...(attachmentId ? { attachmentId } : {}),
    ...(typeof params?.expectedServerId === "string"
      ? { expectedServerId: params.expectedServerId }
      : {}),
    ...(typeof params?.expectedRootHash === "string"
      ? { expectedRootHash: params.expectedRootHash }
      : {}),
  };
};

const sameRoot = (
  a: RuntimeClientAttachParams,
  b: RuntimeClientAttachParams,
): boolean =>
  a.initializeParams.stellaAppDir === b.initializeParams.stellaAppDir &&
  a.initializeParams.stellaDataDirPath === b.initializeParams.stellaDataDirPath &&
  a.initializeParams.stellaWorkspacePath ===
    b.initializeParams.stellaWorkspacePath;

/**
 * The runtime side of the client protocol. It owns the runtime host: the
 * first client to attach creates and starts it, and it keeps running while
 * clients come and go. Host events go to every attached client; host
 * callbacks go to the newest one, and wait for a client when none is
 * attached (an app restart).
 */
export class RuntimeClientServer {
  private readonly connections = new Set<JsonRpcPeer>();
  /** Attached clients, oldest first. The newest serves host callbacks. */
  private readonly clients: JsonRpcPeer[] = [];
  /** The live attachment of each attached connection. */
  private readonly attachments = new Map<JsonRpcPeer, string>();
  private readonly clientWaiters = new Set<() => void>();
  private host: RuntimeClientServerHost | null = null;
  private hostParams: RuntimeClientAttachParams | null = null;
  private hostReady: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: RuntimeClientServerOptions) {}

  /** Take one connection from the transport. */
  attach(peer: JsonRpcPeer): void {
    if (this.closed) {
      peer.dispose();
      return;
    }
    this.connections.add(peer);
    peer.registerRequestHandler(RUNTIME_CLIENT_METHODS.ATTACH, (params) =>
      this.handleAttach(peer, params),
    );
    peer.registerRequestHandler(RUNTIME_CLIENT_METHODS.CALL, (params) =>
      this.handleCall(peer, params),
    );
    peer.registerRequestHandler(RUNTIME_CLIENT_METHODS.SHUTDOWN, async (params) => {
      if (!this.clients.includes(peer)) {
        throw invalidParams("Attach before stopping the runtime.");
      }
      const quit = (params as { mode?: unknown } | null)?.mode === "quit";
      if (quit && this.options.onQuitRequested) {
        await this.options.onQuitRequested();
        return { ok: true };
      }
      // After the reply goes out.
      setImmediate(() => this.options.onShutdownRequested?.());
      return { ok: true };
    });
    peer.on("closed", () => {
      this.connections.delete(peer);
      const index = this.clients.indexOf(peer);
      if (index >= 0) this.clients.splice(index, 1);
      this.attachments.delete(peer);
    });
  }

  attachedClientCount(): number {
    return this.clients.length;
  }

  /** Stop the host, then drop every connection. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const host = this.host;
    this.host = null;
    this.hostReady = null;
    await host?.stop().catch(() => undefined);
    for (const peer of [...this.connections]) peer.dispose();
    for (const wake of this.clientWaiters) wake();
  }

  private async handleAttach(
    peer: JsonRpcPeer,
    value: unknown,
  ): Promise<FencedRuntimeAttachResult> {
    const params = readAttachParams(value);
    const fence = readAttachFence(value);
    const identity = this.options.identity;
    if (identity) {
      const wrongServer =
        fence.expectedServerId !== undefined &&
        fence.expectedServerId !== identity.serverId;
      const wrongRoot =
        fence.expectedRootHash !== undefined &&
        fence.expectedRootHash !== identity.rootHash;
      if (wrongServer || wrongRoot) {
        getFileLogger()?.process("runtime.attach-refused", {
          reason: wrongServer ? "server" : "root",
          expectedServerId: fence.expectedServerId,
          expectedRootHash: fence.expectedRootHash,
          serverId: identity.serverId,
          rootHash: identity.rootHash,
        });
        throw invalidParams(
          `${RUNTIME_SERVER_MISMATCH}: this is runtime ${identity.serverId} (root ${identity.rootHash}); the client expected ${
            fence.expectedServerId ?? "any instance"
          } (root ${fence.expectedRootHash ?? "any"}).`,
        );
      }
    }
    if (this.hostParams && !sameRoot(this.hostParams, params)) {
      throw invalidParams(
        "This runtime serves a different Stella root; attach to that root's runtime.",
      );
    }
    // Bind (or rebind) this connection's attachment before it can receive
    // anything: every frame sent here from now on names it.
    const attachmentId = fence.attachmentId ?? randomUUID();
    const previousAttachment = this.attachments.get(peer);
    if (previousAttachment && previousAttachment !== attachmentId) {
      getFileLogger()?.process("runtime.attachment-replaced", {
        previousAttachment,
        attachmentId,
      });
    }
    this.attachments.set(peer, attachmentId);
    // A client is a callback target before the host starts: starting reads
    // the device identity through it.
    if (!this.clients.includes(peer)) this.clients.push(peer);
    for (const wake of this.clientWaiters) wake();
    this.clientWaiters.clear();

    const hostCreated = !this.host;
    if (!this.host) this.startHost(params);
    try {
      await this.hostReady;
    } catch (error) {
      throw new RpcError(
        RPC_ERROR_CODES.INTERNAL_ERROR,
        `The Stella runtime failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!hostCreated) void this.host?.checkRuntimeStaleness().catch(() => undefined);
    return {
      pid: process.pid,
      hostCreated,
      attachmentId,
      ...(identity ? { serverId: identity.serverId } : {}),
    };
  }

  private startHost(params: RuntimeClientAttachParams): void {
    const host = this.options.createHost(params, this.hostHandlers());
    this.host = host;
    this.hostParams = params;
    host.onAny((name, payload) => {
      for (const client of this.clients) {
        try {
          client.notify(RUNTIME_CLIENT_METHODS.EVENT, {
            name,
            payload,
            attachmentId: this.attachments.get(client),
          } satisfies FencedRuntimeEventParams);
        } catch {
          // A closing client drops its events; it reattaches and resyncs.
        }
      }
    });
    const ready = (async () => {
      await host.start();
      await host.ensureWorkerStarted();
    })();
    this.hostReady = ready;
    // A host that failed to start is discarded, so the next attach retries.
    ready.catch(async () => {
      if (this.host !== host) return;
      this.host = null;
      this.hostParams = null;
      this.hostReady = null;
      await host.stop().catch(() => undefined);
    });
  }

  private async handleCall(peer: JsonRpcPeer, value: unknown): Promise<unknown> {
    if (!this.clients.includes(peer)) {
      throw invalidParams("Attach before calling the runtime.");
    }
    const params = value as {
      method?: unknown;
      args?: unknown;
      attachmentId?: unknown;
    } | null;
    // A call naming an attachment that is no longer this connection's live
    // one was issued for a route that has since been replaced.
    const callAttachment = readAttachmentId(params?.attachmentId);
    const liveAttachment = this.attachments.get(peer);
    if (callAttachment && callAttachment !== liveAttachment) {
      getFileLogger()?.process("runtime.stale-call-dropped", {
        method: String(params?.method),
        attachmentId: callAttachment,
        liveAttachment,
      });
      throw invalidParams(
        `${RUNTIME_ATTACHMENT_STALE}: attachment ${callAttachment} is not live on this connection.`,
      );
    }
    if (!isRuntimeHostCall(params?.method)) {
      throw new RpcError(
        RPC_ERROR_CODES.METHOD_NOT_FOUND,
        `Unknown runtime call: ${String(params?.method)}`,
      );
    }
    const args = Array.isArray(params.args) ? params.args : [];
    await this.hostReady;
    const host = this.host as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    > | null;
    const method = host?.[params.method];
    if (!host || typeof method !== "function") {
      throw createRuntimeUnavailableError("The Stella runtime is not running.");
    }
    return await method.apply(host, args);
  }

  private hostHandlers(): RuntimeHostHandlers {
    const handlers = {} as RuntimeHostHandlers;
    for (const name of RUNTIME_HOST_HANDLERS) {
      handlers[name] = BEST_EFFORT_HANDLERS.has(name)
        ? async (...args: unknown[]) =>
            await this.requestClient(name, args).catch(() => undefined)
        : async (...args: unknown[]) => await this.requestClient(name, args);
    }
    return handlers;
  }

  /** Run one host callback on the newest client, waiting for one if needed. */
  private async requestClient(
    name: RuntimeHostHandler,
    args: unknown[],
  ): Promise<unknown> {
    const client = await this.waitForClient();
    return await client.request(RUNTIME_CLIENT_METHODS.HOST_HANDLER, {
      name,
      args,
      attachmentId: this.attachments.get(client),
    } satisfies FencedRuntimeHostHandlerParams);
  }

  private async waitForClient(): Promise<JsonRpcPeer> {
    const deadline = Date.now() + (this.options.clientWaitMs ?? DEFAULT_CLIENT_WAIT_MS);
    while (!this.closed) {
      const client = this.clients.at(-1);
      if (client && !client.isClosed()) return client;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => {
        let timer: HostTimerHandle | null = null;
        const wake = () => {
          timer?.cancel();
          this.clientWaiters.delete(wake);
          resolve();
        };
        this.clientWaiters.add(wake);
        timer = forkDelayed(remaining, wake);
      });
    }
    throw createRuntimeUnavailableError("The Stella app is not running.");
  }
}
