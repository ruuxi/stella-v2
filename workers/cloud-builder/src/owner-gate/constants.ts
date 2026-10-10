import type { AgentMessageDeviceOutcome } from "@stella/contracts/turn-plane/placement";

/** Trusted headers the Worker stamps on a forwarded presence upgrade. */
export const HEADER_PRESENCE_DEVICE_ID = "x-stella-device-id";

/** Trusted headers the Worker stamps on a forwarded device request. */
export const HEADER_DEVICE_REQUEST_MOBILE_ID =
  "x-stella-device-request-mobile-id";
export const HEADER_DEVICE_REQUEST_ID = "x-stella-device-request-id";
export const HEADER_DEVICE_REQUEST_METHOD = "x-stella-device-request-method";

/** Grace added to `TURN_TIMEOUT_MS` before a running row is presumed released. */
export const OWNER_GATE_RUNNING_GRACE_MS = 60_000;
/**
 * Agent containers one owner may run at once. Every agent thread has a
 * container of its own (standard-2, about $0.057/h while it runs), so this is
 * what bounds an owner's container spend and keeps a runaway fan-out from
 * taking the account's container capacity: six small ones are about $0.34/h.
 * It is above any parallel spawn the orchestrator makes in practice, and an
 * agent that would be the seventh waits for one to finish
 * (`AGENT_CONTAINER_WAIT_MS`) rather than failing outright. The
 * orchestrator's own container does not count, so the user's chat is never
 * queued behind background work.
 */
export const OWNER_AGENT_CONTAINER_LIMIT = 6;
/** A cloud start refused as unavailable (503) is retried once, after this. */
export const DISPATCH_CLOUD_RETRY_DELAY_MS = 1_000;
export const DISPATCH_CLOUD_MAX_ATTEMPTS = 2;
export const DEFAULT_TURN_TIMEOUT_MS = 900_000;
export const OWNER_MODEL_GRANT_FREEZE_TIMEOUT_MS = 5_000;
export const CLOUD_CHAT_READER_PREPARE_TIMEOUT_MS = 1_000;

export const CLOUD_CHAT_READER_PREPARE_CACHE_MAX = 128;
/** How long a snapshot may be reused by its readers; it is rebuilt locally on every read. */
export const SNAPSHOT_TTL_MS = 30_000;

/** How long a steer waits for the device to confirm the agent took it. */
export const STEER_ACK_TIMEOUT_MS = 10_000;
export const LOCAL_AGENT_MESSAGE_ACK_TIMEOUT_MS = 8_000;
export const AGENT_MESSAGE_OUTCOMES: ReadonlySet<string> =
  new Set<AgentMessageDeviceOutcome>([
    "steered",
    "queued",
    "resumed",
    "not_found",
    "refused",
  ]);

/**
 * The floor under every re-arm. A deadline that is already past due would
 * otherwise schedule a wake a quarter-second out, which turns any deadline the
 * object cannot clear into a hot alarm loop.
 */
export const ALARM_MIN_DELAY_MS = 1_000;
