import type { CloudExecutionSelection } from "../agent-engine.js";

/**
 * Execution placement on the owner gate.
 *
 * A dispatch is "run this prompt somewhere": on the owner's desktop when one
 * is present and capable, else in Stella's cloud. The per-owner Durable
 * Object (OwnerGate) owns the dispatch row, the device presence sockets, the
 * offer window, the claim/ack handoff, and the cloud fallback.
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

/**
 * Whether a device has agreed to run work dispatched to it from elsewhere.
 *
 * Being listed and being willing are different facts, and this is the second
 * one. Signing in puts a computer in `devices`; nothing may be dispatched to
 * it until the owner has said yes once, either on that computer's own screen
 * when something first tries (`asking`) or from any signed-in session with the
 * enable control. Collapsing this into "is registered" would delete the only
 * step that stops a fresh sign-in from silently becoming a remote shell.
 *
 * - `unconfigured`: listed, never asked, never answered.
 * - `asking`: a consent prompt is open on that device's own screen.
 * - `enabled`: the owner said yes; dispatch may offer work to it.
 * - `declined`: the owner said no there; it stays listed and stays refused.
 */
export type DeviceRemoteExecution =
  | "unconfigured"
  | "asking"
  | "enabled"
  | "declined";

/**
 * A dispatch's `errorCode` when the only thing in the way is that the target
 * device has not agreed to run remote work. Distinct from offline and from
 * not-ready because it is the one case the owner can clear with a tap, and
 * because agent work treats it as worth waiting for.
 */
export const SELECTED_DEVICE_NEEDS_CONSENT =
  "SELECTED_DEVICE_NEEDS_CONSENT" as const;

export const DEVICE_REMOTE_EXECUTION_STATES: readonly DeviceRemoteExecution[] = [
  "unconfigured",
  "asking",
  "enabled",
  "declined",
];

export type DeviceDestination = {
  deviceId: string;
  label?: string;
  /**
   * `remoteExecution === "enabled"`. Kept as its own field because every
   * eligibility check reads it, and a boolean is what they mean: the four
   * states exist to explain *why* a device is refusing, not to be re-derived
   * at each call site.
   */
  remoteExecutionEnabled: boolean;
  remoteExecution: DeviceRemoteExecution;
  /** When the prompt on that device's screen was last raised. */
  remoteExecutionAskedAt?: number;
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

/**
 * The argument shape of the backend call `devices.register`, shared so the
 * desktop bridge that sends it and the backend that accepts it cannot drift
 * apart again. The bridge once sent `publicKey`/`label` against a validator
 * that wanted `devicePublicKey`/`deviceName`, and every registration failed
 * with an opaque server error.
 */
export type ExecutionDeviceRegistration = {
  deviceId: string;
  devicePublicKey: string;
  deviceName?: string;
  platform?: string;
  capabilities: ExecutionCapability[];
};

export const executionDeviceRegistration = (input: {
  deviceId: string;
  devicePublicKey: string;
  deviceName?: string | undefined;
  platform?: string | undefined;
  capabilities: readonly ExecutionCapability[];
}): ExecutionDeviceRegistration => ({
  deviceId: input.deviceId,
  devicePublicKey: input.devicePublicKey,
  ...(input.deviceName?.trim() ? { deviceName: input.deviceName.trim() } : {}),
  ...(input.platform?.trim() ? { platform: input.platform.trim() } : {}),
  capabilities: [...new Set(input.capabilities)].sort(),
});

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

/** Dispatch timings. */
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
  /**
   * Agent dispatches only: the owner's agent thread this attempt belongs to.
   * The device keeps one local thread per remote thread, so a follow-up
   * continues with its history.
   */
  threadId?: string;
  /**
   * Agent dispatches only: the requester's `spawn_agent` model selector. The
   * device runs the agent on it, or fails the agent saying why it can't.
   */
  model?: string;
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
  resultJson?: string;
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
  /** Anonymous owners may not dispatch agent work; sign in to continue. */
  | "sign_in_required"
  | "owner_suspended"
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
  | {
      type: "cancel";
      dispatchId: string;
      cancelRequestId: string;
      reason: string;
    }
  | {
      /** New input for an agent the device accepted and is running. */
      type: "steer";
      dispatchId: string;
      messageId: string;
      text: string;
    }
  | { type: "dispatch"; dispatch: DispatchSummary }
  | {
      /**
       * Something tried to dispatch work here and this device has not agreed
       * to accept any. The device asks on its own screen and answers with a
       * `consent` frame. The dispatch that triggered this does not wait on the
       * socket: a human tap is not on the offer window's timescale, so the
       * attempt is refused with `SELECTED_DEVICE_NEEDS_CONSENT` and agent work
       * retries while the prompt is up.
       */
      type: "consent.request";
      requestedAt: number;
      /** What asked, when the gate knows it, for the prompt's wording. */
      requesterLabel?: string;
    }
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
  | {
      /** Whether a `steer` reached the running agent. */
      type: "steer.ack";
      dispatchId: string;
      messageId: string;
      delivered: boolean;
    }
  | {
      /**
       * The answer to `consent.request`, given on this device's own screen.
       * It arrives on the proven presence socket, so the gate knows it came
       * from the machine being asked about and not merely from the account.
       */
      type: "consent";
      allow: boolean;
    }
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
