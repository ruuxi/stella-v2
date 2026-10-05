import { EventEmitter } from "node:events";
import {
  RPC_ERROR_CODES,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcSuccess,
} from "./index.js";

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (params: unknown) => Promise<void> | void;

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

export const createRuntimeUnavailableError = (
  message = "Runtime is not available.",
  data?: unknown,
) => new RpcError(RPC_ERROR_CODES.RUNTIME_UNAVAILABLE, message, data);

export const isRuntimeUnavailableError = (error: unknown): error is RpcError =>
  error instanceof RpcError && error.code === RPC_ERROR_CODES.RUNTIME_UNAVAILABLE;

const toError = (value: unknown, fallback: () => Error): Error =>
  value instanceof Error ? value : fallback();

export const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

export type RpcRequestOptions = {
  timeoutMs?: number | null;
  liveness?: {
    method: string;
    params?: unknown;
    intervalMs: number;
    unresponsiveMs: number;
  };
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  release: () => void;
};

export class JsonRpcPeer {
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private nextId = 1;
  private readonly events = new EventEmitter();
  private disposed = false;

  constructor(
    private readonly sendMessage: (message: JsonRpcMessage) => void,
    private readonly options: {
      requestTimeoutMs?: number;
      onError?: (error: unknown) => void;
    } = {},
  ) {}

  on(eventName: "closed", listener: () => void): () => void {
    this.events.on(eventName, listener);
    return () => {
      this.events.removeListener(eventName, listener);
    };
  }

  isClosed() {
    return this.disposed;
  }

  dispose(reason?: unknown) {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const rejection = toError(
      reason,
      () => new RpcError(RPC_ERROR_CODES.INTERNAL_ERROR, "RPC peer disposed."),
    );
    for (const [, pending] of this.pending) {
      pending.release();
      pending.reject(rejection);
    }
    this.pending.clear();
    this.events.emit("closed");
  }

  registerRequestHandler(method: string, handler: RequestHandler) {
    this.requestHandlers.set(method, handler);
  }

  registerNotificationHandler(method: string, handler: NotificationHandler) {
    this.notificationHandlers.set(method, handler);
  }

  notify(method: string, params?: unknown) {
    const message: JsonRpcNotification = { method, ...(params === undefined ? {} : { params }) };
    this.sendMessageSafely(message);
  }

  request<TResult = unknown>(
    method: string,
    params?: unknown,
    options: RpcRequestOptions = {},
  ): Promise<TResult> {
    if (this.disposed) {
      return Promise.reject(createRuntimeUnavailableError("RPC peer is closed."));
    }
    const id = this.nextId++;
    const timeoutMs =
      options.timeoutMs === undefined
        ? (this.options.requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS)
        : options.timeoutMs;
    const message: JsonRpcRequest = { id, method, ...(params === undefined ? {} : { params }) };
    return new Promise<TResult>((resolve, reject) => {
      const fail = (error: RpcError) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.release();
        reject(error);
      };
      const timeout =
        timeoutMs === null
          ? undefined
          : setTimeout(
              () =>
                fail(
                  new RpcError(RPC_ERROR_CODES.INTERNAL_ERROR, `RPC request timed out: ${method}`),
                ),
              timeoutMs,
            );
      const stopLiveness = options.liveness
        ? this.watchLiveness(method, options.liveness, fail)
        : undefined;
      this.pending.set(id, {
        resolve,
        reject,
        release: () => {
          if (timeout) clearTimeout(timeout);
          stopLiveness?.();
        },
      });
      try {
        this.sendMessageSafely(message);
      } catch (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.release();
        reject(error);
      }
    });
  }

  private watchLiveness(
    method: string,
    liveness: NonNullable<RpcRequestOptions["liveness"]>,
    fail: (error: RpcError) => void,
  ): () => void {
    const allowedMisses = Math.max(1, Math.ceil(liveness.unresponsiveMs / liveness.intervalMs));
    const probeTimeoutMs = Math.max(1, Math.floor(liveness.intervalMs / 2));
    let misses = 0;
    let probing = false;
    let stopped = false;
    const interval = setInterval(() => {
      if (probing || stopped || this.disposed) return;
      probing = true;
      this.request(liveness.method, liveness.params, { timeoutMs: probeTimeoutMs })
        .then(
          () => {
            misses = 0;
          },
          (error: unknown) => {
            if (!(error instanceof RpcError) || !/^RPC request timed out:/.test(error.message)) {
              misses = 0;
              return;
            }
            misses += 1;
            if (misses >= allowedMisses && !stopped) {
              fail(
                new RpcError(
                  RPC_ERROR_CODES.INTERNAL_ERROR,
                  `RPC peer stopped responding during ${method}: ${misses} ${liveness.method} checks in a row went unanswered.`,
                ),
              );
            }
          },
        )
        .finally(() => {
          probing = false;
        });
    }, liveness.intervalMs);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }

  private sendMessageSafely(message: JsonRpcMessage) {
    if (this.disposed) {
      throw createRuntimeUnavailableError("RPC peer is closed.");
    }
    try {
      this.sendMessage(message);
    } catch (error) {
      const safeError = toError(
        error,
        () => new RpcError(RPC_ERROR_CODES.INTERNAL_ERROR, String(error)),
      );
      if (!isRuntimeUnavailableError(safeError)) {
        this.options.onError?.(safeError);
      }
      this.dispose(safeError);
      throw safeError;
    }
  }

  async handleMessage(message: JsonRpcMessage) {
    if ("method" in message) {
      if ("id" in message) {
        await this.handleRequest(message);
        return;
      }
      await this.handleNotification(message);
      return;
    }

    if ("result" in message) {
      this.handleSuccess(message);
      return;
    }

    if ("error" in message) {
      this.handleFailure(message);
      return;
    }

    this.options.onError?.(
      new RpcError(
        RPC_ERROR_CODES.INVALID_REQUEST,
        "Malformed RPC response: expected result or error payload.",
        message,
      ),
    );
  }

  /**
   * Send a response to an inbound request, swallowing transport-send
   * failures. `handleMessage` is invoked as `void rpcPeer.handleMessage(...)`
   * (see jsonl.ts), so a throw from a mid-request transport close would
   * escape as an unhandled rejection. Route any send failure to onError
   * instead of letting it propagate.
   */
  private sendResponse(message: JsonRpcSuccess | JsonRpcFailure) {
    try {
      this.sendMessageSafely(message);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private async handleRequest(message: JsonRpcRequest) {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this.sendResponse({
        id: message.id,
        error: {
          code: RPC_ERROR_CODES.METHOD_NOT_FOUND,
          message: `Unknown method: ${message.method}`,
        },
      } satisfies JsonRpcFailure);
      return;
    }

    try {
      const result = await handler(message.params);
      this.sendResponse({
        id: message.id,
        result: result === undefined ? null : result,
      } satisfies JsonRpcSuccess);
    } catch (error) {
      const rpcError =
        error instanceof RpcError
          ? error
          : new RpcError(
              RPC_ERROR_CODES.INTERNAL_ERROR,
              error instanceof Error ? error.message : String(error),
            );
      this.sendResponse({
        id: message.id,
        error: {
          code: rpcError.code,
          message: rpcError.message,
          ...(rpcError.data === undefined ? {} : { data: rpcError.data }),
        },
      } satisfies JsonRpcFailure);
      this.options.onError?.(error);
    }
  }

  private async handleNotification(message: JsonRpcNotification) {
    const handler = this.notificationHandlers.get(message.method);
    if (!handler) {
      return;
    }
    try {
      await handler(message.params);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private handleSuccess(message: JsonRpcSuccess) {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    pending.release();
    this.pending.delete(message.id);
    pending.resolve(message.result);
  }

  private handleFailure(message: JsonRpcFailure) {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    pending.release();
    this.pending.delete(message.id);
    const safeError =
      message.error && typeof message.error === "object"
        ? message.error
        : {
            code: RPC_ERROR_CODES.INTERNAL_ERROR,
            message: "Malformed RPC error response.",
          };
    pending.reject(
      new RpcError(
        typeof safeError.code === "number"
          ? safeError.code
          : RPC_ERROR_CODES.INTERNAL_ERROR,
        typeof safeError.message === "string"
          ? safeError.message
          : "Malformed RPC error response.",
        "data" in safeError ? safeError.data : undefined,
      ),
    );
  }
}
