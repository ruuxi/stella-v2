import type {
  BackendError,
  BackendErrorCode,
} from "@stella/contracts/backend/protocol";

/** An error a backend function means to show its caller. */
export class RpcError extends Error {
  readonly code: BackendErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(
    code: BackendErrorCode,
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.retryable =
      options.retryable ??
      (code === "UNAVAILABLE" || code === "RATE_LIMITED");
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

/**
 * The client-facing shape of any thrown value. Anything that is not an
 * `RpcError` is a bug or an outage, and its message stays in the logs.
 */
export const toBackendError = (error: unknown): BackendError =>
  error instanceof RpcError
    ? {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.retryAfterMs !== undefined
          ? { retryAfterMs: error.retryAfterMs }
          : {}),
      }
    : {
        code: "INTERNAL",
        message: "Stella hit an error. Try again.",
        retryable: true,
      };
