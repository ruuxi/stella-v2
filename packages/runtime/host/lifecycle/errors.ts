import { Cause, Schema } from "effect";

/**
 * Tagged failures for the host-side worker lifecycle. The plain-Promise
 * facade in `host/lifecycle.ts` rethrows these across the Effect boundary,
 * so every escaping message is byte-identical to the string the pre-Effect
 * `host/lifecycle.ts` threw. Do not reword them.
 */

export class HostLockTimeoutError extends Schema.TaggedErrorClass<HostLockTimeoutError>()(
  "@stella/runtime/host/HostLockTimeoutError",
  { lockFile: Schema.String, timeoutMs: Schema.Number },
) {
  override get message() {
    return `Timed out acquiring runtime host lock at ${this.lockFile} after ${this.timeoutMs}ms.`;
  }
}

export class WorkerProtocolMismatchError extends Schema.TaggedErrorClass<WorkerProtocolMismatchError>()(
  "@stella/runtime/host/WorkerProtocolMismatchError",
  { socketPath: Schema.String },
) {
  override get message() {
    return `Runtime worker protocol mismatch while waiting for socket=${this.socketPath}.`;
  }
}

export class WorkerReadyTimeoutError extends Schema.TaggedErrorClass<WorkerReadyTimeoutError>()(
  "@stella/runtime/host/WorkerReadyTimeoutError",
  { socketPath: Schema.String },
) {
  override get message() {
    return `Timed out waiting for runtime worker to become ready (socket=${this.socketPath}).`;
  }
}

/**
 * Retry driver for the lockfile acquire loop: the lock is currently held (or
 * a takeover race was lost) and the attempt should recur on its Schedule.
 * Never escapes `acquireHostLock` — exhaustion maps to HostLockTimeoutError.
 */
export class HostLockBusyError extends Schema.TaggedErrorClass<HostLockBusyError>()(
  "@stella/runtime/host/HostLockBusyError",
  { lockFile: Schema.String },
) {}

/**
 * Retry driver for the readiness poll: the socket refused, timed out, or the
 * probe answered with an error. Never escapes `pollForWorkerReady` —
 * exhaustion maps to WorkerReadyTimeoutError.
 */
export class WorkerNotReadyError extends Schema.TaggedErrorClass<WorkerNotReadyError>()(
  "@stella/runtime/host/WorkerNotReadyError",
  { socketPath: Schema.String },
) {}

/**
 * Recover the original failure from a Cause so the Promise facade rejects
 * with the same object the Effect failed with (tagged error, spawn error, …).
 * Mirrors `worker/server/errors.ts` — `Cause.squash` preserves the `message`
 * every caller and log line observes.
 */
export const causeToThrowable = (cause: Cause.Cause<unknown>): unknown =>
  Cause.squash(cause);
