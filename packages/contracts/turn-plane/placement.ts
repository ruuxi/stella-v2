import type { CloudExecutionSelection } from "../agent-engine.js";

/**
 * Execution placement on the owner gate.
 *
 * A dispatch is "run this prompt somewhere": on the owner's desktop when one
 * is present and capable, else in Stella's cloud. The per-owner Durable
 * Object (OwnerGate) owns the dispatch row, the device presence sockets, the
 * offer window, the claim/ack handoff, and the cloud fallback. Convex learns
 * about dispatches through `dispatch.*` outbox events and keeps only a
 * projection for the activity UI.
 *
 * Routes on the cloud-builder worker:
 *   POST /owners/me/dispatches                 submit (user JWT, or service secret + owner headers)
 *   GET  /owners/me/dispatches/:dispatchId     status (user JWT / service)
 *   POST /owners/me/dispatches/:dispatchId/cancel
 *   GET  /owners/me/devices/:deviceId/presence WebSocket (user JWT), the device presence socket
 *
 * Mobile submits carry the pairing proof headers the mobile app already
 * sends; the worker verifies them against the owner snapshot's paired
 * devices before forwarding with `ingress: "mobile"`.
 */

export const PLACEMENT_PROTOCOL = 1 as const;

export const DISPATCH_SUBMIT_PATH = "/owners/me/dispatches" as const;
export const dispatchPath = (dispatchId: string): string =>
  `${DISPATCH_SUBMIT_PATH}/${encodeURIComponent(dispatchId)}`;
export const dispatchCancelPath = (dispatchId: string): string =>
  `${dispatchPath(dispatchId)}/cancel`;
export const devicePresencePath = (deviceId: string): string =>
  `/owners/me/devices/${encodeURIComponent(deviceId)}/presence`;
/** `GET /owners/me/devices`: the owner's execution destinations with live presence. */
export const DEVICES_PATH = "/owners/me/devices" as const;

export type DeviceDestination = {
  deviceId: string;
  label?: string;
  remoteExecutionEnabled: boolean;
  online: boolean;
  presenceSessionId?: string;
  availability?: DeviceAvailability;
  lastSeenAt?: number;
};

export type DevicesResponse = {
  protocol: typeof PLACEMENT_PROTOCOL;
  devices: DeviceDestination[];
  cloud: { capabilities: ExecutionCapability[] };
};

export type ExecutionIngress =
  | "desktop"
  | "mobile"
  | "browser"
  | "cloud"
  | "schedule";
export type ExecutionSubject = "portable" | "computer" | "cloud";
export type ExecutionTargetMode = "automatic" | "cloud" | "device";
export type ExecutionKind = "chat" | "agent";
export type ExecutionCapability =
  | "chat"
  | "agent"
  | "computer-use"
  | "local-files"
  | "local-apps"
  | "attachments";

export const CLOUD_CAPABILITIES: readonly ExecutionCapability[] = [
  "chat",
  "agent",
  "attachments",
];

export type DispatchState =
  | "offering"
  | "computer_claimed"
  | "computer_accepted"
  | "computer_running"
  | "cloud_committed"
  | "cloud_running"
  | "cancel_pending"
  | "reconciliation_required"
  | "blocked"
  | "completed"
  | "failed"
  | "canceled";

export const TERMINAL_DISPATCH_STATES: readonly DispatchState[] = [
  "completed",
  "failed",
  "canceled",
  "blocked",
];

/** Timings, unchanged from the Convex implementation they replace. */
export const DISPATCH_OFFER_WINDOW_MS = 4_000;
export const DISPATCH_CLAIM_LEASE_MS = 30_000;
export const DISPATCH_ACCEPTED_LEASE_MS = 120_000;
export const DISPATCH_PAYLOAD_TTL_MS = 900_000;
export const DEVICE_PRESENCE_PING_INTERVAL_MS = 10_000;
export const DEVICE_PRESENCE_STALE_AFTER_MS = 60_000;

/** The prompt bytes a device or the cloud receives; hashed and order-sensitive. */
export type DispatchPayload = {
  schemaVersion: 1;
  prompt: string;
  conversationId: string;
  clientMsgId: string;
  userMessageEventId?: string;
  locale?: string;
  attachments?: string[];
  execution?: CloudExecutionSelection | null;
  /** Agent dispatches only. */
  description?: string;
};

export type DispatchSubmitRequest = {
  protocol: typeof PLACEMENT_PROTOCOL;
  idempotencyKey: string;
  kind: ExecutionKind;
  ingress: ExecutionIngress;
  subject: ExecutionSubject;
  targetMode?: ExecutionTargetMode;
  targetDeviceId?: string;
  /** Mobile: the paired phone; desktop/browser: the originating device. */
  requestingDeviceId?: string;
  conversationId: string;
  parentTurnId?: string;
  threadId?: string;
  requiredCapabilities: ExecutionCapability[];
  payload: DispatchPayload;
};

export type DispatchSummary = {
  dispatchId: string;
  idempotencyKey: string;
  kind: ExecutionKind;
  ingress: ExecutionIngress;
  subject: ExecutionSubject;
  requestedTargetMode?: ExecutionTargetMode;
  requestedExecutorDeviceId?: string;
  conversationId: string;
  parentTurnId?: string;
  threadId?: string;
  state: DispatchState;
  placement?: "computer" | "cloud";
  executorDeviceId?: string;
  executorPresenceSessionId?: string;
  revision: number;
  fallbackReason?: string;
  cancelRequestId?: string;
  cancelReason?: string;
  errorCode?: string;
  errorMessage?: string;
  /** Cloud placement: the admitted turn (chat) or thread turn (agent). */
  cloudTurnId?: string;
  cloudThreadId?: string;
  createdAt: number;
  updatedAt: number;
};

export type DispatchSubmitResponse = {
  protocol: typeof PLACEMENT_PROTOCOL;
  dispatch: DispatchSummary;
  replayed: boolean;
};

export type DispatchStatusResponse = {
  protocol: typeof PLACEMENT_PROTOCOL;
  dispatch: DispatchSummary;
};

export type DispatchCancelRequest = {
  protocol: typeof PLACEMENT_PROTOCOL;
  cancelRequestId: string;
  reason?: string;
};

export type DispatchErrorCode =
  | "unauthorized"
  | "forbidden"
  | "bad_request"
  | "conflict"
  | "not_found"
  | "owner_purged"
  | "generation_stale"
  | "capability_unavailable"
  | "quota_burst"
  | "quota_daily"
  | "quota_concurrency"
  | "internal";

export type DispatchError = {
  error: {
    code: DispatchErrorCode;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  };
};

// ---------------------------------------------------------------------------
// Device presence socket
// ---------------------------------------------------------------------------

export const DEVICE_PRESENCE_SUBPROTOCOL = "stella.v1" as const;
export const DEVICE_PRESENCE_PROTOCOL_VERSION = 1 as const;
export const DEVICE_PRESENCE_MAX_FRAME_BYTES = 64 * 1024;

export type DeviceAvailability = {
  ready: boolean;
  chatSlots: number;
  agentSlots: number;
  capabilities: ExecutionCapability[];
};

/** Server -> device. */
export type DevicePresenceServerFrame =
  | {
      type: "challenge";
      connectionId: string;
      nonce: string;
      pingIntervalMs: number;
      staleAfterMs: number;
    }
  | { type: "connected"; presenceSessionId: string; serverTimeMs: number }
  | {
      type: "offer";
      dispatch: DispatchSummary;
      payloadJson: string;
      payloadHash: string;
      offerExpiresAt: number;
    }
  | { type: "offer.withdrawn"; dispatchId: string; reason: string }
  | {
      type: "claimed";
      dispatchId: string;
      claimExpiresAt: number;
      replayed: boolean;
    }
  | { type: "cancel"; dispatchId: string; cancelRequestId: string; reason: string }
  | { type: "dispatch"; dispatch: DispatchSummary }
  | { type: "pong"; serverTimeMs: number }
  | { type: "error"; code: string; message: string; retryable: boolean };

/** Device -> server. Every frame after `proof` is bound to the proven session. */
export type DevicePresenceDeviceFrame =
  | {
      type: "begin";
      presenceSessionId: string;
      protocolVersion: typeof DEVICE_PRESENCE_PROTOCOL_VERSION;
      availability: DeviceAvailability;
    }
  | {
      /** Ed25519 signature over `stella-device-presence\0${connectionId}\0${nonce}` by the device key. */
      type: "proof";
      signature: string;
    }
  | { type: "availability"; availability: DeviceAvailability }
  | { type: "claim"; dispatchId: string; claimRequestId: string }
  | { type: "release"; dispatchId: string; reason?: string }
  | { type: "ack"; dispatchId: string }
  | { type: "running"; dispatchId: string }
  | { type: "renew"; dispatchId: string }
  | {
      type: "complete";
      dispatchId: string;
      outcome: "completed" | "failed" | "canceled";
      resultJson?: string;
      errorCode?: string;
      errorMessage?: string;
    }
  | { type: "ping" };

export const DEVICE_PRESENCE_PROOF_PREFIX = "stella-device-presence" as const;

/** Close codes on the device socket. */
export const DEVICE_PRESENCE_CLOSE = {
  replaced: 4001,
  stale: 4002,
  proofRejected: 4403,
  unauthorized: 4401,
  protocol: 4000,
  internal: 4500,
} as const;
