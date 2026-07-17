import { Cause, Schema } from "effect";
import { STELLA_RUNTIME_PROTOCOL_VERSION } from "@stella/contracts/protocol";

/**
 * Tagged failures for the worker RPC surface. The JSON-RPC peer serializes a
 * rejected handler as `error.message` (contracts protocol/rpc-peer.ts), so
 * every message here is byte-identical to the string the pre-Effect
 * `worker/server.ts` threw. Do not reword them.
 */

export class WorkerNotInitializedError extends Schema.TaggedErrorClass<WorkerNotInitializedError>()(
  "@stella/runtime/worker/WorkerNotInitializedError",
  {},
) {
  override get message() {
    return "Worker has not been initialized.";
  }
}

export class RunnerUnavailableError extends Schema.TaggedErrorClass<RunnerUnavailableError>()(
  "@stella/runtime/worker/RunnerUnavailableError",
  {},
) {
  override get message() {
    return "Runtime worker is not ready.";
  }
}

export class ChatStoreUnavailableError extends Schema.TaggedErrorClass<ChatStoreUnavailableError>()(
  "@stella/runtime/worker/ChatStoreUnavailableError",
  {},
) {
  override get message() {
    return "Chat store is not available.";
  }
}

export class VoiceUnavailableError extends Schema.TaggedErrorClass<VoiceUnavailableError>()(
  "@stella/runtime/worker/VoiceUnavailableError",
  {},
) {
  override get message() {
    return "Voice runtime service is not available.";
  }
}

export class SocialSessionsUnavailableError extends Schema.TaggedErrorClass<SocialSessionsUnavailableError>()(
  "@stella/runtime/worker/SocialSessionsUnavailableError",
  {},
) {
  override get message() {
    return "Social session service is unavailable.";
  }
}

export class ProtocolMismatchError extends Schema.TaggedErrorClass<ProtocolMismatchError>()(
  "@stella/runtime/worker/ProtocolMismatchError",
  { hostVersion: Schema.String },
) {
  override get message() {
    return `Runtime protocol mismatch: host=${this.hostVersion} worker=${STELLA_RUNTIME_PROTOCOL_VERSION}.`;
  }
}

/** Request-shape validation failures ("conversationId is required.", …). */
export class WorkerRequestError extends Schema.TaggedErrorClass<WorkerRequestError>()(
  "@stella/runtime/worker/WorkerRequestError",
  { message: Schema.String },
) {}

/** Union used by the session-guard table in rpc.ts. */
export type SessionMissingError =
  | WorkerNotInitializedError
  | RunnerUnavailableError
  | ChatStoreUnavailableError
  | VoiceUnavailableError
  | SocialSessionsUnavailableError;

/**
 * Recover the original failure from a Cause so the JSON-RPC adapter rethrows
 * the same object the handler failed with (tagged error, runner error, …).
 * `Cause.squash` returns the first checked failure, else the first defect —
 * both preserve the `message` the wire protocol serializes.
 */
export const causeToThrowable = (cause: Cause.Cause<unknown>): unknown =>
  Cause.squash(cause);
