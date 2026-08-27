import {
  RPC_ERROR_CODES,
  type JsonRpcMessage,
} from "@stella/contracts/protocol";
import {
  JsonRpcPeer,
  RpcError,
  type JsonRpcPeer as JsonRpcPeerInstance,
} from "@stella/contracts/protocol/rpc-peer";

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (params: unknown) => Promise<void> | void;

export type WorkerPeerLike = {
  notify: (method: string, params?: unknown) => void;
  request: <TResult = unknown>(
    method: string,
    params?: unknown,
    options?: { retryOnDisconnect?: boolean },
  ) => Promise<TResult>;
  registerRequestHandler: (method: string, handler: RequestHandler) => void;
  registerNotificationHandler: (
    method: string,
    handler: NotificationHandler,
  ) => void;
  activeRequestHandlerCount?: () => number;
};

type PeerEvents = {
  "client-attached": void;
  "client-detached": void;
};

type PeerEventListener<K extends keyof PeerEvents> = (
  payload: PeerEvents[K],
) => void;

const NO_HOST_TIMEOUT_MS = 30_000;

export class WorkerPeerBroker {
  private readonly attachedPeers = new Set<JsonRpcPeer>();
  private readonly attachOrder: JsonRpcPeer[] = [];
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<
    string,
    NotificationHandler
  >();
  private readonly listeners = new Map<
    keyof PeerEvents,
    Set<PeerEventListener<keyof PeerEvents>>
  >();
  private waitForPeerResolvers: Array<() => void> = [];
  private activeRequestHandlers = 0;

  attach(peer: JsonRpcPeer) {
    this.attachedPeers.add(peer);
    this.attachOrder.push(peer);
    for (const [method, handler] of this.requestHandlers) {
      peer.registerRequestHandler(method, handler);
    }
    for (const [method, handler] of this.notificationHandlers) {
      peer.registerNotificationHandler(method, handler);
    }
    peer.on("closed", () => {
      this.detach(peer);
    });
    const resolvers = this.waitForPeerResolvers;
    this.waitForPeerResolvers = [];
    for (const resolve of resolvers) resolve();
    this.emit("client-attached", undefined);
  }

  detach(peer: JsonRpcPeer) {
    if (!this.attachedPeers.delete(peer)) return;
    const idx = this.attachOrder.indexOf(peer);
    if (idx >= 0) this.attachOrder.splice(idx, 1);
    this.emit("client-detached", undefined);
  }

  attachedCount(): number {
    return this.attachedPeers.size;
  }

  activeRequestHandlerCount(): number {
    return this.activeRequestHandlers;
  }

  on<K extends keyof PeerEvents>(
    eventName: K,
    listener: PeerEventListener<K>,
  ): () => void {
    let bucket = this.listeners.get(eventName);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(eventName, bucket);
    }
    bucket.add(listener as PeerEventListener<keyof PeerEvents>);
    return () => {
      bucket?.delete(listener as PeerEventListener<keyof PeerEvents>);
    };
  }

  private emit<K extends keyof PeerEvents>(
    eventName: K,
    payload: PeerEvents[K],
  ) {
    const bucket = this.listeners.get(eventName);
    if (!bucket) return;
    for (const listener of bucket) {
      try {
        (listener as PeerEventListener<K>)(payload);
      } catch {

      }
    }
  }

  registerRequestHandler(method: string, handler: RequestHandler) {
    const wrappedHandler: RequestHandler = async (params) => {
      this.activeRequestHandlers += 1;
      try {
        return await handler(params);
      } finally {
        this.activeRequestHandlers = Math.max(0, this.activeRequestHandlers - 1);
      }
    };
    this.requestHandlers.set(method, wrappedHandler);
    for (const peer of this.attachedPeers) {
      peer.registerRequestHandler(method, wrappedHandler);
    }
  }

  registerNotificationHandler(method: string, handler: NotificationHandler) {
    this.notificationHandlers.set(method, handler);
    for (const peer of this.attachedPeers) {
      peer.registerNotificationHandler(method, handler);
    }
  }

  notify(method: string, params?: unknown) {
    for (const peer of this.attachedPeers) {
      try {
        peer.notify(method, params);
      } catch {

      }
    }
  }

  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: { retryOnDisconnect?: boolean },
  ): Promise<TResult> {
    const deadline = Date.now() + NO_HOST_TIMEOUT_MS;
    while (true) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const peer = this.pickPeer() ?? (await this.waitForPeer(remainingMs));
      try {
        return await peer.request<TResult>(method, params);
      } catch (error) {
        const detached = !this.attachedPeers.has(peer);
        const disposed =
          error instanceof RpcError &&
          error.code === RPC_ERROR_CODES.INTERNAL_ERROR &&
          error.message === "RPC peer disposed.";
        if (
          options?.retryOnDisconnect !== true ||
          (!detached && !disposed) ||
          Date.now() >= deadline
        ) {
          throw error;
        }
      }
    }
  }

  private pickPeer(): JsonRpcPeer | null {
    for (let i = this.attachOrder.length - 1; i >= 0; i -= 1) {
      const peer = this.attachOrder[i];
      if (peer && this.attachedPeers.has(peer)) {
        return peer;
      }
    }
    return null;
  }

  private waitForPeer(timeoutMs: number): Promise<JsonRpcPeer> {
    return new Promise<JsonRpcPeer>((resolve, reject) => {
      const onAttach = () => {
        clearTimeout(timer);
        const peer = this.pickPeer();
        if (peer) {
          resolve(peer);
        } else {

          this.waitForPeerResolvers.push(onAttach);
        }
      };
      const timer = setTimeout(() => {
        const idx = this.waitForPeerResolvers.indexOf(onAttach);
        if (idx >= 0) this.waitForPeerResolvers.splice(idx, 1);
        reject(
          new RpcError(
            RPC_ERROR_CODES.RUNTIME_UNAVAILABLE,
            "No host connected to receive RPC request.",
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.waitForPeerResolvers.push(onAttach);
    });
  }

  dispose() {
    const peers = [...this.attachedPeers];
    this.attachedPeers.clear();
    this.attachOrder.length = 0;
    for (const peer of peers) {
      try {
        peer.dispose();
      } catch {

      }
    }
  }
}

export type { JsonRpcPeerInstance, JsonRpcMessage };
