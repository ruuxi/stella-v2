import { CloudHomeStore } from "./cloud-home-store.js";
import { builtinCloudAppSkill } from "./builtin-cloud-app-skill.js";
import { OwnerHomeContextCache, type OwnerHomeContext } from "./owner-home-context.js";
import { chatTurnFingerprintSource, cloudChatHandoffKey, cloudChatTurnKey, type CloudChatHandoff, type CloudChatPreparation, type AdmittedCloudChat } from "./cloud-chat-admission.js";
import { turnStartErrorResponse } from "./turn-start-request.js";
import type { ModelGatewayControl } from "./managed-request-cancellation.js";
import { verifyUserToken } from "./auth-jwt.js";
import { OwnerStore } from "./owner-store/store.js";
import { ownerRegistry } from "./owner-store/domains.js";
import type { OwnerCaller, OwnerHost, OwnerPurgeMode, OwnerRegistry } from "./owner-store/registry.js";
import { createGateHost, parseDeviceAgentDispatchKey } from "./owner-store/gate-host.js";
import { RpcError, toBackendError } from "./owner-store/errors.js";
import { applyOwnerEventsToStore } from "./owner-store/owner-events.js";
import type { RpcResponse } from "@stella/contracts/backend/protocol";
import {
  HEADER_ANONYMOUS,
  HEADER_IDENTITY_LEVEL,
  HEADER_OWNER,
  HEADER_SESSION,
  HEADER_SUBJECT,
  HEADER_TOKEN_EXP,
  HEADER_TOKEN_IAT,
} from "./conversation-types.js";
/**
 * The owner gate: one Durable Object per owner, named by ownerId, that
 * answers "may this owner start a turn right now?" from its own tables.
 *
 * It is the owner's authority: the owner snapshot (generation, write fence,
 * identity, enforcement, plan and allowance, default execution, devices) is
 * built from its domains on every read. Its SQLite registry records running
 * turns for replay detection. Conversation and thread objects admit through it
 * and release on their terminal paths; a release that never arrives is bounded
 * by `TURN_TIMEOUT_MS` plus a grace, after which a running row is treated as
 * released, so a lost isolate can never wedge an owner permanently.
 *
 * Refusals are values, never thrown: an RPC caller maps them straight to the
 * turn-start error contract.
 */

import { DurableObject } from "cloudflare:workers";
import {
  GATEWAY_CAPABILITY_ISSUERS,
  GATEWAY_SESSION_CAPABILITY_TTL_MS,
  isManagedModelAudience,
} from "@stella/contracts/gateway/capability";
import { signCapability } from "@stella/contracts/gateway/jwt";
import type { GatewaySessionCapabilityResponse } from "@stella/contracts/gateway/api";
import {
  OWNER_SNAPSHOT_VERSION,
  type OwnerSnapshot,
} from "@stella/contracts/turn-plane/owner-snapshot";
import type { IdentityLevel } from "@stella/contracts/gateway/api";
import {
  beginOwnerPurge,
  callerSessionRevoked,
  noteCallerIdentity,
  readOwnerState,
} from "./owner-store/domains/account.js";
import {
  type BillingControlResult,
  type OwnerEnforcementState,
  type SessionCapabilityRequest,
  type GatewayUsageEvent,
} from "@stella/contracts/gateway/usage";
import type { BillingPlan } from "@stella/contracts/backend/billing";
import type { TelemetryEventV1 } from "@stella/contracts/telemetry";
import {
  applyGatewayUsage,
  applyStripeEvent,
  billingAccess,
  billingPaying,
  closeStripeCustomer,
  recordBillingIdentity,
  reserveSessionGrant,
  setAdminPlan,
  turnAllowance,
  type BillingAccess,
  type UsageBatchResult,
} from "./owner-store/domains/billing.js";
import {
  abuseState,
  admitSession,
  chargeAnonymousNetworks,
  enforcementForSnapshot,
  readEnforcement,
  recordGatewayUsageRisk,
  setEnforcement,
  type SetEnforcementInput,
} from "./owner-store/domains/abuse.js";
import { deleteTunnels, handleMobileRoute, snapshotDevices, type MobileRouteInput } from "./owner-store/domains/devices.js";
import { snapshotEngines } from "./owner-store/domains/engines.js";
import type { StripeEvent } from "./billing/stripe.js";
import { BillingConfigError } from "./billing/plans.js";
import { capabilitySigningKey } from "./capability-signer.js";
import {
  CLOUD_CAPABILITIES,
  DEVICE_PRESENCE_CLOSE,
  DEVICE_PRESENCE_MAX_FRAME_BYTES,
  DEVICE_PRESENCE_PING_INTERVAL_MS,
  DEVICE_PRESENCE_PROOF_PREFIX,
  DEVICE_PRESENCE_PROTOCOL_VERSION,
  DEVICE_PRESENCE_STALE_AFTER_MS,
  DEVICE_PRESENCE_SUBPROTOCOL,
  DISPATCH_ACCEPTED_LEASE_MS,
  DISPATCH_CLAIM_LEASE_MS,
  DISPATCH_OFFER_WINDOW_MS,
  DISPATCH_PAYLOAD_TTL_MS,
  PLACEMENT_PROTOCOL,
  type DeviceAvailability,
  type DeviceDestination,
  type DevicePresenceDeviceFrame,
  type DevicePresenceServerFrame,
  type DevicesResponse,
  type DispatchError,
  type DispatchPayload,
  type DispatchState,
  type DispatchStatusResponse,
  type DispatchSubmitRequest,
  type DispatchSubmitResponse,
  type DispatchSummary,
  type ExecutionCapability,
  type ExecutionIngress,
  type ExecutionKind,
  type ExecutionSubject,
  type ExecutionTargetMode,
} from "@stella/contracts/turn-plane/placement";
import {
  canonicalDispatchPayloadJson,
  sha256Hex,
} from "@stella/contracts/turn-plane/pairing-proof";
import type { OwnerEvent } from "@stella/contracts/turn-plane/owner-events";
import {
  TURN_OWNER_GENERATION_HEADER,
  TURN_PLANE_PROTOCOL,
  type CloudAgentTurnStartRequest,
  type CloudAgentTurnStartResponse,
  type CloudTurnStartRequest,
  type CloudTurnStartResponse,
} from "@stella/contracts/turn-plane/turn-start";
import {
  HEADER_GATE_ADMITTED,
  HEADER_TURN_AUTH_KIND,
} from "./turn-start-request.js";
import {
  MAX_DEVICE_ID_CHARS,
  MAX_DISPATCH_PAYLOAD_BYTES,
  MAX_OFFERS_PER_DISPATCH,
  cloudUnsupportedCapabilities,
  decideDispatchPlacement,
  dispatchError,
  isEligibleDevice,
  isTerminalDispatchState,
  type DevicePresenceState,
  type DeviceRegistration,
} from "./dispatch-policy.js";
import { OwnerFenceStore } from "./owner-fence-store.js";
import { OwnerModelGrantStore, type OwnerModelGrant, type OwnerModelGrantRevokeAllInput } from "./owner-model-grants.js";
import { OwnerMemoryPolicy, MemoryPolicyError } from "./memory-policy.js";
import { applyMemoryPolicyChange, readMemoryPolicy } from "./owner-store/domains/home.js";
import type { MemoryPolicy, MemoryPolicyChange } from "@stella/contracts/turn-plane/memory-policy";
import {
  HEADER_OWNER_FENCE_ID,
  createOwnerFenceHost,
} from "./owner-fence-do.js";
import type {
  OwnerFenceLeaseNamespace,
  OwnerFenceLeaseRole,
} from "./owner-fence-store.js";

export type OwnerGateEnv = Pick<
  Cloudflare.Env,
  | "BUILDER_SERVICE_SECRET"
  | "BACKUP_BUCKET"
  | "MODEL_GATEWAY_CONTROL"
> &
  Partial<
    Pick<
      Cloudflare.Env,
      | "AGENT_HOME"
      | "TURN_TIMEOUT_MS"
      | "ORCHESTRATOR_SESSIONS"
      | "BUILD_SESSIONS"
      | "CAPABILITY_SIGNING_KEY"
      | "CAPABILITY_SIGNING_KID"
      | "TELEMETRY"
      | "TELEMETRY_ENVIRONMENT"
    >
  >;


/** Trusted headers the Worker stamps on a forwarded presence upgrade. */
export const HEADER_PRESENCE_DEVICE_ID = "x-stella-device-id";

export type OwnerGateLane = "chat" | "agent";

export type OwnerGateAdmitInput = {
  lane: OwnerGateLane;
  turnId: string;
  conversationId: string;
  /**
   * Service callers pin the owner generation they dispatched with. A
   * mismatch after a forced snapshot refresh is `generation_stale`.
   */
  expectedGeneration?: string;
  /** Test seam; defaults to `Date.now()`. */
  now?: number;
};

export type OwnerGateRefusalCode =
  | "owner_purged"
  | "sign_in_required"
  | "owner_suspended"
  | "generation_stale"
  | "internal";

export type OwnerGateRefusal = {
  ok: false;
  code: OwnerGateRefusalCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
};

export type OwnerGateAdmission =
  | { ok: true; snapshot: OwnerSnapshot; replayed: boolean }
  | OwnerGateRefusal;

export type OwnerGateAdmissionWithLease =
  | {
      admission: Extract<OwnerGateAdmission, { ok: true }>;
      homeContext?: OwnerHomeContext;
      destinations?: DevicesResponse;
      lease: OwnerGateFenceLeaseOutcome;
    }
  | {
      admission: OwnerGateRefusal;
      lease: { status: "skipped"; reason: "admission_refused" };
    };

/** One exact owner-fence lease carried along with a snapshot read. */
export type OwnerGateFenceLeaseRequest = {
  leaseId: string;
  sessionId: string;
  turnId: string;
  ownerGeneration: string;
  namespace: OwnerFenceLeaseNamespace;
  role: OwnerFenceLeaseRole;
  /** The open-fence generation an exact replay expects to still hold. */
  generation?: string;
  expiresAt?: number;
};

export type OwnerGateFenceLeaseOutcome =
  | { status: "registered"; generation: string; expiresAt: number }
  /** The fence host refused, exactly as `POST /owner-fence/register` would. */
  | { status: "refused"; httpStatus: number; code?: string; error?: string }
  /** The snapshot did not authorize the caller, so no register was tried. */
  | { status: "skipped"; reason: "not_writable" | "generation_stale" };

export type OwnerGateSnapshotWithLease =
  | { snapshot: OwnerSnapshot; lease: OwnerGateFenceLeaseOutcome }
  | {
      snapshot: null;
      snapshotError: {
        code: "owner_purged" | "internal";
        message: string;
        retryable: boolean;
      };
      lease: { status: "skipped"; reason: "snapshot_unavailable" };
    };

/** Grace added to `TURN_TIMEOUT_MS` before a running row is presumed released. */
export const OWNER_GATE_RUNNING_GRACE_MS = 60_000;
/** A cloud start refused as unavailable (503) is retried once, after this. */
export const DISPATCH_CLOUD_RETRY_DELAY_MS = 1_000;
export const DISPATCH_CLOUD_MAX_ATTEMPTS = 2;
const DEFAULT_TURN_TIMEOUT_MS = 900_000;
const OWNER_MODEL_GRANT_FREEZE_TIMEOUT_MS = 5_000;
const CLOUD_CHAT_READER_PREPARE_TIMEOUT_MS = 1_000;

/** Reject with `message` after `ms`; the underlying work is not cancelled. */
const withTimeout = <T>(work: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
};

const ownerFenceRequest = (path: string, body: unknown, headers?: Record<string, string>): Request =>
  new Request(`https://owner-gate/owner-fence/${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
const CLOUD_CHAT_READER_PREPARE_CACHE_MAX = 128;
/** How long a snapshot may be reused by its readers; it is rebuilt locally on every read. */
const SNAPSHOT_TTL_MS = 30_000;
const DDL = [
  `CREATE TABLE IF NOT EXISTS running (
     turn_id         TEXT    PRIMARY KEY,
     lane            TEXT    NOT NULL,
     conversation_id TEXT    NOT NULL,
     started_at      INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS running_lane ON running(lane)`,
  // One row per device that has ever proven itself here. `connected` goes
  // false on close rather than deleting the row, so an offline device still
  // reports its last availability to `GET /owners/me/devices`.
  `CREATE TABLE IF NOT EXISTS device_presence (
     device_id           TEXT    PRIMARY KEY,
     presence_session_id TEXT    NOT NULL,
     connection_id       TEXT    NOT NULL,
     connected           INTEGER NOT NULL,
     ready               INTEGER NOT NULL,
     chat_slots          INTEGER NOT NULL,
     agent_slots         INTEGER NOT NULL,
     capabilities        TEXT    NOT NULL,
     protocol_version    INTEGER NOT NULL,
     last_seen_at        INTEGER NOT NULL,
     updated_at          INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS dispatches (
     dispatch_id                  TEXT    PRIMARY KEY,
     idempotency_key              TEXT    NOT NULL,
     owner_generation             TEXT    NOT NULL,
     kind                         TEXT    NOT NULL,
     ingress                      TEXT    NOT NULL,
     subject                      TEXT    NOT NULL,
     requested_target_mode        TEXT,
     requested_executor_device_id TEXT,
     conversation_id              TEXT    NOT NULL,
     parent_turn_id               TEXT,
     thread_id                    TEXT,
     requesting_device_id         TEXT,
     pair_grant_device_id         TEXT,
     required_capabilities        TEXT    NOT NULL,
     routing_fingerprint          TEXT    NOT NULL,
     state                        TEXT    NOT NULL,
     placement                    TEXT,
     executor_device_id           TEXT,
     executor_presence_session_id TEXT,
     on_no_eligible_computer      TEXT    NOT NULL,
     revision                     INTEGER NOT NULL,
     fallback_reason              TEXT,
     cancel_request_id            TEXT,
     cancel_reason                TEXT,
     error_code                   TEXT,
     error_message                TEXT,
     result_json                  TEXT,
     cloud_turn_id                TEXT,
     cloud_thread_id              TEXT,
     payload_json                 TEXT,
     payload_hash                 TEXT    NOT NULL,
     payload_expires_at           INTEGER,
     offer_deadline_at            INTEGER,
     lease_expires_at             INTEGER,
     started_at                   INTEGER,
     cloud_attempts               INTEGER NOT NULL DEFAULT 0,
     cloud_retry_at               INTEGER,
     gate_held                    INTEGER NOT NULL,
     created_at                   INTEGER NOT NULL,
     updated_at                   INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS cloud_dispatch_terminals (
     turn_id TEXT NOT NULL, owner_generation TEXT NOT NULL,
     outcome TEXT NOT NULL, result_json TEXT, error_message TEXT,
     created_at INTEGER NOT NULL, PRIMARY KEY (turn_id, owner_generation)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dispatches_idempotency
     ON dispatches(idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS dispatches_state ON dispatches(state)`,
  `CREATE TABLE IF NOT EXISTS dispatch_offers (
     dispatch_id         TEXT    NOT NULL,
     device_id           TEXT    NOT NULL,
     presence_session_id TEXT    NOT NULL,
     status              TEXT    NOT NULL,
     expires_at          INTEGER NOT NULL,
     created_at          INTEGER NOT NULL,
     updated_at          INTEGER NOT NULL,
     PRIMARY KEY (dispatch_id, device_id)
   )`,
  `CREATE INDEX IF NOT EXISTS dispatch_offers_device
     ON dispatch_offers(device_id, status)`,
];

/** How long a steer waits for the device to confirm the agent took it. */
const STEER_ACK_TIMEOUT_MS = 10_000;

/** How the snapshot fetch failed. `owner_purged` is definite; the rest are not. */
export class OwnerGateSnapshotError extends Error {
  constructor(
    readonly code: "owner_purged" | "internal",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OwnerGateSnapshotError";
  }
}

const log = (
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) => {
  console[level](
    JSON.stringify({
      service: "stella-v2-cloud-builder",
      component: "owner-gate",
      event,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** True when the snapshot lets a turn pin this execution's engine. */
export const snapshotAllowsExecutionEngine = (
  snapshot: Pick<OwnerSnapshot, "connectedEngines">,
  engine: OwnerSnapshot["execution"]["engine"],
): boolean =>
  engine === "stella" || (snapshot.connectedEngines ?? []).includes(engine);

const refuse = (
  code: OwnerGateRefusalCode,
  message: string,
  retryable: boolean,
  retryAfterMs?: number,
): OwnerGateRefusal => ({
  ok: false,
  code,
  message,
  retryable,
  ...(retryAfterMs !== undefined
    ? { retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)) }
    : {}),
});

// ---------------------------------------------------------------------------
// Device presence and placement
// ---------------------------------------------------------------------------

/**
 * Everything a presence socket needs to be understood after a hibernation
 * eviction. There is deliberately no in-memory socket map: `getWebSockets()`
 * plus `deserializeAttachment()` is the only thing that survives eviction.
 */
type PresenceAttachment = {
  v: 1;
  deviceId: string;
  authExpiresAtMs: number;
  connectionId: string;
  nonce: string;
  presenceSessionId?: string;
  availability?: DeviceAvailability;
  phase: "challenged" | "begun" | "connected";
  lastSeenAtMs: number;
};

const presenceTag = (deviceId: string): string => `device:${deviceId}`;

/** The exact bytes a device signs to prove it holds the registered key. */
export const devicePresenceProofMessage = (args: {
  connectionId: string;
  nonce: string;
}): string =>
  `${DEVICE_PRESENCE_PROOF_PREFIX}\0${args.connectionId}\0${args.nonce}`;

const decodeBase64 = (value: string): Uint8Array | null => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

/**
 * Ed25519 over the SPKI public key the owner snapshot registered. Any failure
 * — malformed material, unknown curve, bad signature — is one answer: the
 * proof is rejected. Telling them apart would only help an attacker.
 */
export const verifyDevicePresenceProof = async (args: {
  publicKey: string;
  message: string;
  signature: string;
}): Promise<boolean> => {
  const publicKeyBytes = decodeBase64(args.publicKey);
  const signatureBytes = decodeBase64(args.signature);
  if (
    !publicKeyBytes ||
    !signatureBytes ||
    publicKeyBytes.byteLength > 256 ||
    signatureBytes.byteLength !== 64
  ) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      exactBuffer(publicKeyBytes),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      exactBuffer(signatureBytes),
      new TextEncoder().encode(args.message),
    );
  } catch {
    return false;
  }
};

const CAPABILITY_VALUES: readonly ExecutionCapability[] = [
  "chat",
  "agent",
  "computer-use",
  "local-files",
  "local-apps",
  "attachments",
];

const withReleasedClientSelectability = (availability: DeviceAvailability) => {
  const selectable = availability.ready ? 1 : 0;
  return { ...availability, chatSlots: selectable, agentSlots: selectable };
};

const parseAvailability = (value: unknown): DeviceAvailability | null => {
  if (!isRecord(value)) return null;
  if (typeof value.ready !== "boolean") return null;
  if (!Array.isArray(value.capabilities) || value.capabilities.length > 16) {
    return null;
  }
  const capabilities: ExecutionCapability[] = [];
  for (const capability of value.capabilities) {
    if (!CAPABILITY_VALUES.includes(capability as ExecutionCapability)) {
      return null;
    }
    if (!capabilities.includes(capability as ExecutionCapability)) {
      capabilities.push(capability as ExecutionCapability);
    }
  }
  return {
    ready: value.ready,
    capabilities,
  };
};

type PresenceRow = {
  device_id: string;
  presence_session_id: string;
  connection_id: string;
  connected: number;
  ready: number;
  capabilities: string;
  protocol_version: number;
  last_seen_at: number;
};

const presenceState = (row: PresenceRow): DevicePresenceState => ({
  deviceId: row.device_id,
  presenceSessionId: row.presence_session_id,
  connected: row.connected === 1,
  ready: row.ready === 1,
  capabilities: JSON.parse(row.capabilities) as ExecutionCapability[],
  protocolVersion: row.protocol_version,
  lastSeenAt: row.last_seen_at,
});

type DispatchRow = {
  dispatch_id: string;
  idempotency_key: string;
  owner_generation: string;
  kind: string;
  ingress: string;
  subject: string;
  requested_target_mode: string | null;
  requested_executor_device_id: string | null;
  conversation_id: string;
  parent_turn_id: string | null;
  thread_id: string | null;
  requesting_device_id: string | null;
  pair_grant_device_id: string | null;
  required_capabilities: string;
  routing_fingerprint: string;
  state: string;
  placement: string | null;
  executor_device_id: string | null;
  executor_presence_session_id: string | null;
  on_no_eligible_computer: string;
  revision: number;
  fallback_reason: string | null;
  cancel_request_id: string | null;
  cancel_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  result_json?: string | null;
  cloud_turn_id: string | null;
  cloud_thread_id: string | null;
  payload_json: string | null;
  payload_hash: string;
  payload_expires_at: number | null;
  offer_deadline_at: number | null;
  lease_expires_at: number | null;
  started_at: number | null;
  cloud_attempts: number;
  cloud_retry_at: number | null;
  gate_held: number;
  created_at: number;
  updated_at: number;
};

const optional = <T>(value: T | null | undefined, key: string) =>
  value === null || value === undefined || value === "" ? {} : { [key]: value };

export const dispatchSummary = (row: DispatchRow): DispatchSummary => ({
  dispatchId: row.dispatch_id,
  idempotencyKey: row.idempotency_key,
  kind: row.kind as ExecutionKind,
  ingress: row.ingress as ExecutionIngress,
  subject: row.subject as ExecutionSubject,
  ...(optional(row.requested_target_mode, "requestedTargetMode") as {
    requestedTargetMode?: ExecutionTargetMode;
  }),
  ...optional(row.requested_executor_device_id, "requestedExecutorDeviceId"),
  conversationId: row.conversation_id,
  ...optional(row.parent_turn_id, "parentTurnId"),
  ...optional(row.thread_id, "threadId"),
  state: row.state as DispatchState,
  ...(optional(row.placement, "placement") as {
    placement?: "computer" | "cloud";
  }),
  ...optional(row.executor_device_id, "executorDeviceId"),
  ...optional(row.executor_presence_session_id, "executorPresenceSessionId"),
  revision: row.revision,
  ...optional(row.fallback_reason, "fallbackReason"),
  ...optional(row.cancel_request_id, "cancelRequestId"),
  ...optional(row.cancel_reason, "cancelReason"),
  ...optional(row.error_code, "errorCode"),
  ...optional(row.error_message, "errorMessage"),
  ...optional(row.result_json, "resultJson"),
  ...optional(row.cloud_turn_id, "cloudTurnId"),
  ...optional(row.cloud_thread_id, "cloudThreadId"),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export type OwnerGateSubmitInput = {
  request: DispatchSubmitRequest;
  /** Service callers pin the generation they dispatched with. */
  expectedGeneration?: string;
  /** Mobile only: the paired desktop the verified proof names. */
  pairGrantDeviceId?: string;
  now?: number;
};

export type OwnerGateCancelInput = {
  dispatchId: string;
  cancelRequestId: string;
  reason?: string;
  now?: number;
};

export type OwnerGateDispatchResult =
  | { ok: true; response: DispatchSubmitResponse }
  | { ok: false; error: DispatchError["error"] };

export type OwnerGateStatusResult =
  | { ok: true; response: DispatchStatusResponse }
  | { ok: false; error: DispatchError["error"] };

const fail = (
  code: DispatchError["error"]["code"],
  message: string,
  retryable: boolean,
  retryAfterMs?: number,
): { ok: false; error: DispatchError["error"] } => ({
  ok: false,
  error: dispatchError(code, message, retryable, retryAfterMs).error,
});

/**
 * The caller the Worker verified, rebuilt from the `x-stella-*` headers it
 * stamps after stripping the client's own. Null when any part is missing.
 */
const trustedOwnerCaller = (request: Request): OwnerCaller | null => {
  const ownerId = request.headers.get(HEADER_OWNER)?.trim() ?? "";
  const subject = request.headers.get(HEADER_SUBJECT)?.trim() ?? "";
  const sessionId = request.headers.get(HEADER_SESSION)?.trim() ?? "";
  const expiresAtMs = Number(request.headers.get(HEADER_TOKEN_EXP));
  const identityLevel = Number(request.headers.get(HEADER_IDENTITY_LEVEL) ?? NaN);
  const issuedAtMs = Number(request.headers.get(HEADER_TOKEN_IAT) ?? NaN);
  if (!ownerId || !subject || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return null;
  }
  return {
    ownerId,
    subject,
    sessionId,
    expiresAtMs,
    isAnonymous: request.headers.get(HEADER_ANONYMOUS) === "1",
    ...(identityLevel === 0 || identityLevel === 1 || identityLevel === 2 || identityLevel === 3
      ? { identityLevel }
      : {}),
    ...(Number.isSafeInteger(issuedAtMs) ? { issuedAtMs } : {}),
  };
};

export class OwnerGate extends DurableObject<OwnerGateEnv> {
  private schemaReady = false;
  /** Steers waiting for their device's `steer.ack`, by dispatch and message. */
  private readonly steerAcks = new Map<string, (delivered: boolean) => void>();
  private ownerStoreState?: OwnerStore;
  private ownerHostState?: OwnerHost;
  /** The domains this object serves. Test fixtures substitute their own. */
  protected backendRegistry(): OwnerRegistry {
    return ownerRegistry;
  }
  private ownerHost(): OwnerHost {
    return this.ownerHostState ??= createGateHost({
      ownerId: () => this.ownerId(),
      env: this.env as unknown as Cloudflare.Env,
      snapshot: () => this.snapshot(),
      admit: (input) => this.admit(input),
      release: (input) => this.release(input),
      submit: (input) => this.submit(input),
      cancelDispatch: (input) => this.cancelDispatch(input),
      steerDispatch: (input) => this.steerDispatch(input),
      devices: () => this.devices(),
      homeChanged: (ownerGeneration, revision) =>
        this.homeContextCache().changed(ownerGeneration, revision),
      changeMemoryPolicy: (change) => this.changeMemoryPolicyForCall(change),
      fence: (path, body) => this.ownerFenceCall(path, body),
      applyOwnerEvents: (events) => this.applyOwnerEvents(events),
      purgeOwner: (mode, requestId) => this.purgeOwnerPass(mode, requestId),
      log,
    });
  }
  /** The owner's database: backend calls, live views and jobs. */
  ownerStore(): OwnerStore {
    return this.ownerStoreState ??= new OwnerStore({
      ctx: this.ctx,
      env: this.env as unknown as Cloudflare.Env,
      ownerId: () => this.ownerId(),
      registry: this.backendRegistry(),
      host: this.ownerHost(),
      verifyToken: async (token) => {
        const verified = await verifyUserToken(token, this.env as unknown as Cloudflare.Env);
        return verified.ok ? verified.token : null;
      },
      log,
    });
  }

  /**
   * Turn-plane events for this owner (see `src/owner-events.ts`): the
   * conversation and agent-thread index, browser waits, and the terminal
   * receipts mobile polls. Events from another owner or an owner generation
   * since reset are dropped. Throws only when the producer should retry.
   */
  async applyOwnerEvents(events: OwnerEvent[]): Promise<void> {
    const ownerId = this.ownerId();
    let generation: string | null = null;
    try {
      generation = (await this.snapshot()).ownerGeneration;
    } catch {
      // Without a snapshot the events still land; a reset is rare and its
      // fences catch anything that matters.
    }
    const current = events.filter(
      (event) =>
        event.ownerId === ownerId &&
        (generation === null || event.ownerGeneration === generation),
    );
    const store = this.ownerStore();
    const effects = applyOwnerEventsToStore(store.context(null), current);
    store.flush();
    // A deleted conversation schedules its purge job.
    await this.scheduleAlarm(Date.now());
    for (const event of current) {
      if (event.kind !== "turn.event" || !event.terminal) continue;
      const outcome = event.terminalStatus;
      if (outcome !== "completed" && outcome !== "failed" && outcome !== "canceled") continue;
      await this.recordCloudDispatchTerminal({
        ownerGeneration: event.ownerGeneration,
        turnId: event.turnId,
        outcome,
        ...(event.resultJson ? { resultJson: event.resultJson } : {}),
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
      });
    }
    for (const card of effects.cards) await this.ownerHost().postConversationCard(card);
  }

  /**
   * `POST /api/rpc/<name>` for owner-scoped functions, verified by the Worker.
   * A token from before the owner's last sign-out-everywhere is refused; any
   * other notes the identity it claims.
   */
  async ownerRpc(input: { name: string; args: unknown; caller: OwnerCaller }): Promise<RpcResponse> {
    const store = this.ownerStore();
    const { db } = store.context(input.caller);
    if (callerSessionRevoked(db, input.caller)) {
      return {
        ok: false,
        error: toBackendError(new RpcError("UNAUTHENTICATED", "You were signed out. Sign in again to continue.")),
      };
    }
    noteCallerIdentity(db, input.caller);
    const response = await store.call(input.name, input.args, input.caller);
    await this.scheduleAlarm(Date.now());
    return response;
  }

  /**
   * A server-internal operation (agent tools, Worker routes, the turn
   * broker), refused unless `ownerGeneration` is the owner's current one.
   */
  async ownerInternal(input: {
    name: string;
    args: unknown;
    ownerGeneration: string;
  }): Promise<RpcResponse> {
    let current: string;
    try {
      current = (await this.snapshot()).ownerGeneration;
    } catch (error) {
      log("error", "owner_internal_snapshot_failed", {
        name: input.name,
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        error: toBackendError(new RpcError("UNAVAILABLE", "Owner state is unavailable.")),
      };
    }
    if (current !== input.ownerGeneration) {
      return {
        ok: false,
        error: toBackendError(
          new RpcError("CONFLICT", "This request is from before your cloud data was reset.", {
            reason: "owner_generation_stale",
          }),
        ),
      };
    }
    const response = await this.ownerStore().internalCall(input.name, input.args);
    await this.scheduleAlarm(Date.now());
    return response;
  }

  /** Cloud home's control operations (`memory.*`, `skills.*`) for `CloudHomeStore`. */
  async homeControl(input: {
    op: string;
    body: { ownerGeneration: string } & Record<string, unknown>;
  }): Promise<RpcResponse> {
    return await this.ownerInternal({
      name: input.op,
      args: input.body,
      ownerGeneration: input.body.ownerGeneration,
    });
  }

  /**
   * Run every domain's purge hook for a reset or account deletion. Returns
   * the domains that still have work and need another call.
   */
  async purgeOwnerData(input: { mode: OwnerPurgeMode }): Promise<{ pending: string[] }> {
    const pending: string[] = [];
    for (const [domain, purge] of this.backendRegistry().purges) {
      const result = await this.billingWrite((ctx) => purge(ctx, input.mode));
      if (result.pending) pending.push(domain);
    }
    return { pending };
  }

  // ── Billing ─────────────────────────────────────────────────────────────

  /** Run a write on the owner's database outside a backend call, then push views and arm jobs. */
  private async billingWrite<T>(write: (ctx: ReturnType<OwnerStore["context"]>) => T | Promise<T>): Promise<T> {
    const store = this.ownerStore();
    try {
      return await write(store.context(null));
    } finally {
      store.flush();
      await this.scheduleAlarm(Date.now());
    }
  }

  /**
   * A session capability for a client runtime, asked for by the model
   * gateway. The abuse domain rules on admission (step-up, sybil pressure,
   * suspension, the anonymous request chunk); this ledger reserves the
   * budget, and this Worker signs the capability.
   */
  async issueSessionCapability(
    request: SessionCapabilityRequest,
  ): Promise<BillingControlResult<GatewaySessionCapabilityResponse>> {
    const now = Date.now();
    const paying = billingPaying(this.ownerStore().context(null, now));
    let snapshot: OwnerSnapshot;
    try {
      snapshot = await this.snapshot({ now });
    } catch {
      return { ok: false, status: null, code: null, retryable: true };
    }
    const admission = await this.billingWrite((ctx) => admitSession(ctx, { ...request, paying, snapshot }));
    if (!admission.ok) return admission;
    const { ownerGeneration, isAnonymous, identityLevel, maxRequests } = admission.body;
    const jti = crypto.randomUUID();
    const expiresAt =
      (Math.floor(now / 1000) + Math.ceil(GATEWAY_SESSION_CAPABILITY_TTL_MS / 1000)) * 1000;
    const grant = await this.billingWrite((ctx) => {
      recordBillingIdentity(ctx, { isAnonymous, identityLevel });
      return reserveSessionGrant(ctx, { jti, expiresAt });
    });
    const signed = await signCapability(
      {
        iss: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
        sub: this.ownerId(),
        jti,
        gen: ownerGeneration,
        dpk: request.deviceKeyHash,
        kind: "session",
        audience: grant.audience,
        budgetMicroCents: grant.budgetMicroCents,
        ...(maxRequests !== undefined ? { maxRequests } : {}),
      },
      await capabilitySigningKey(this.env),
      { ttlMs: GATEWAY_SESSION_CAPABILITY_TTL_MS, now },
    );
    return {
      ok: true,
      body: {
        capability: signed.token,
        expiresAt: signed.claims.exp * 1000,
        audience: grant.audience,
        budgetMicroCents: grant.budgetMicroCents,
        identityLevel: grant.identityLevel,
        ...(maxRequests !== undefined ? { maxRequests } : {}),
      },
    };
  }

  /** The gateway's settled usage for this owner. */
  async applyGatewayUsage(events: GatewayUsageEvent[]): Promise<UsageBatchResult> {
    const result = await this.billingWrite((ctx) => {
      const settled = applyGatewayUsage(ctx, events);
      const accepted = events.filter((event) => settled.accepted.includes(event.requestId));
      recordGatewayUsageRisk(ctx, accepted, billingAccess(ctx).identityLevel);
      return settled;
    });
    const accepted = events.filter((event) => result.accepted.includes(event.requestId));
    await chargeAnonymousNetworks(this.env as Cloudflare.Env, accepted, Date.now()).catch((error: unknown) => {
      log("error", "anon_network_allowance_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    await this.reportCharges(accepted);
    return result;
  }

  /** The owner's enforcement, for the model gateway's bootstrap read (`BillingControl`). */
  async ownerEnforcement(): Promise<OwnerEnforcementState> {
    return readEnforcement(this.ownerStore().context(null));
  }

  /** Set the owner's enforcement (admin). Pushes it to the model gateway. */
  async setOwnerEnforcement(input: SetEnforcementInput): Promise<OwnerEnforcementState> {
    return await this.billingWrite((ctx) => setEnforcement(ctx, input));
  }

  /** Enforcement, risk score and risk windows (admin lookup). */
  async abuseState(): Promise<ReturnType<typeof abuseState>> {
    return abuseState(this.ownerStore().context(null));
  }

  /**
   * Charged model calls to analytics, under this owner's pseudonym: what
   * the old usage ledger used to log. Best effort.
   */
  private async reportCharges(events: GatewayUsageEvent[]): Promise<void> {
    const telemetry = this.env.TELEMETRY as
      | { ingestForOwner(ownerId: string, events: TelemetryEventV1[]): Promise<void> }
      | undefined;
    const charged = events.filter((event) => event.billable && event.outcome !== "failed");
    if (!telemetry || charged.length === 0) return;
    const environment = this.env.TELEMETRY_ENVIRONMENT === "production" ? "production" : "development";
    await telemetry
      .ingestForOwner(
        this.ownerId(),
        charged.map((event) => ({
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          occurredAtMs: event.finishedAt,
          project: "stella",
          environment,
          source: "cloud-builder",
          event: {
            type: "inference.completed",
            provider: event.provider,
            model: event.resolvedModel,
            agentType: event.agentType,
            durationMs: Math.max(0, event.finishedAt - event.startedAt),
            success: event.outcome === "succeeded",
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            ...(event.usage.cachedInputTokens !== undefined
              ? { cachedInputTokens: event.usage.cachedInputTokens }
              : {}),
            ...(event.usage.cacheWriteTokens !== undefined
              ? { cacheWriteInputTokens: event.usage.cacheWriteTokens }
              : {}),
            ...(event.usage.reasoningTokens !== undefined
              ? { reasoningTokens: event.usage.reasoningTokens }
              : {}),
            totalTokens: event.usage.inputTokens + event.usage.outputTokens,
            costMicroCents: event.chargedMicroCents,
          },
        })),
      )
      .catch((error: unknown) => {
        log("error", "billing_telemetry_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** A verified Stripe event addressed to this owner. */
  async applyStripeEvent(event: StripeEvent): Promise<void> {
    await this.billingWrite((ctx) => applyStripeEvent(ctx, event));
  }

  /** What this owner may spend now. */
  async billingAccess(identity?: { isAnonymous: boolean }): Promise<BillingAccess> {
    if (!identity) return billingAccess(this.ownerStore().context(null));
    return await this.billingWrite((ctx) => {
      recordBillingIdentity(ctx, identity);
      return billingAccess(ctx);
    });
  }

  /** Admin and test accounts: set the plan outside Stripe. */
  async setBillingPlan(input: {
    plan?: BillingPlan;
    usageMode?: "default" | "unlimited";
    resetUsage?: boolean;
  }): Promise<void> {
    await this.billingWrite((ctx) => setAdminPlan(ctx, input));
  }

  /** Account deletion: end the Stripe customer and its subscription. */
  async closeBilling(): Promise<void> {
    await closeStripeCustomer(this.ownerStore().context(null));
  }

  // ── Devices ─────────────────────────────────────────────────────────────

  /** `/api/mobile/*` for phones and the desktop's bridge, verified by the Worker. */
  async mobileRoute(input: MobileRouteInput): Promise<{ status: number; json: string }> {
    const result = await this.billingWrite((ctx) => handleMobileRoute(ctx, input));
    return { status: result.status, json: JSON.stringify(result.body) };
  }

  /** Account deletion: delete the owner's Cloudflare tunnels. */
  async closeDevices(): Promise<void> {
    await this.billingWrite((ctx) => deleteTunnels(ctx, { idleOnly: false }));
  }

  /**
   * Account deletion, before the auth user row goes: close the owner for
   * good, end Stripe and the tunnels, then run the first delete pass of the
   * `account.purge` job now. A pass that leaves stores pending is retried by
   * the job.
   */
  async closeOwner(): Promise<{ pending: string[] }> {
    await this.billingWrite((ctx) => beginOwnerPurge(ctx, "delete"));
    await this.closeBilling();
    await this.closeDevices();
    await this.ownerStore().runDueJobs();
    const store = this.ownerStore();
    const { purge } = readOwnerState(store.context(null).db);
    store.flush();
    return { pending: purge ? ["owner"] : [] };
  }

  /** One reset or deletion pass across every store; see src/owner-purge.ts. */
  private async purgeOwnerPass(mode: OwnerPurgeMode, requestId: string): Promise<{ pending: string[] }> {
    const { runOwnerPurge } = await import("./owner-purge.js");
    return await runOwnerPurge({
      env: this.env as unknown as import("./build-session/shared/env.js").Env,
      ownerId: this.ownerId(),
      mode,
      requestId,
      purgeOwnerData: () => this.purgeOwnerData({ mode }),
    });
  }
  private gatewayOwnerPreparation?: Promise<void>;
  private memoryPolicyState?: OwnerMemoryPolicy;
  private homeContextState?: OwnerHomeContextCache;
  private homeContextCache() { return this.homeContextState ??= new OwnerHomeContextCache(this.ctx.storage); }
  async homeContext(ownerGeneration: string, fenceGeneration: string): Promise<OwnerHomeContext> {
    return await this.homeContextCache().load({
      ownerGeneration,
      builtins: (await builtinCloudAppSkill()).versionId,
      assertPolicy: policy => this.memoryPolicy().assert(policy, fenceGeneration),
      fetch: async () => {
        if (!this.env.AGENT_HOME) throw new Error("Cloud home bucket unavailable");
        const store = new CloudHomeStore(this.env.AGENT_HOME, {
          ownerId: this.ownerId(), ownerGeneration,
          control: (op, body) => this.homeControl({ op, body }),
        });
        const [memory, skills] = await Promise.all([store.getMemoryContext(), store.loadSkillCatalog("orchestrator")]);
        return { memory, skills };
      },
    });
  }

  private ownerModelGrantState?: OwnerModelGrantStore;
  // A prepared reader nonce is advisory and only usable by the turn that
  // started its wake. Later turns must read the durable registration, since an
  // Orchestrator restart can replace that nonce.
  private cloudChatReaderPreparationState?: Map<string, Promise<void>>;
  private cloudChatReaderPreparedState?: Set<string>;
  private modelGrants(): OwnerModelGrantStore {
    return this.ownerModelGrantState ??= new OwnerModelGrantStore(this.ctx, this.ownerId());
  }

  private prepareCloudChatReader(
    sessions: NonNullable<OwnerGateEnv["ORCHESTRATOR_SESSIONS"]>,
    conversationId: string,
  ): Promise<string | undefined> {
    const preparations = this.cloudChatReaderPreparationState ??=
      new Map<string, Promise<void>>();
    const prepared = this.cloudChatReaderPreparedState ??= new Set<string>();
    if (prepared.has(conversationId)) return Promise.resolve(undefined);
    const existing = preparations.get(conversationId);
    // The first caller owns the nonce from a shared wake. Other concurrent
    // callers wait for the wake but resolve their reader from durable state.
    if (existing) return existing.then(() => undefined);
    const preparation = withTimeout(
      (sessions.getByName(conversationId) as unknown as {
        prepareCloudChatReader(): Promise<unknown>;
      }).prepareCloudChatReader(),
      CLOUD_CHAT_READER_PREPARE_TIMEOUT_MS,
      "Cloud chat reader preparation timed out.",
    ).then(readerId =>
      typeof readerId === "string" && readerId.length > 0 && readerId.length <= 512
        ? readerId
        : undefined,
    ).catch(() => undefined);
    const completion = preparation.then(readerId => {
      if (readerId === undefined) return;
      if (prepared.size >= CLOUD_CHAT_READER_PREPARE_CACHE_MAX) {
        const oldest = prepared.values().next().value;
        if (oldest !== undefined) prepared.delete(oldest);
      }
      prepared.add(conversationId);
    }).finally(() => {
      if (preparations.get(conversationId) === completion) preparations.delete(conversationId);
    });
    preparations.set(conversationId, completion);
    return preparation;
  }

  private async revokeModelReaders(args: Omit<OwnerModelGrantRevokeAllInput, "freeze">): Promise<void> {
    const sessions = this.env.ORCHESTRATOR_SESSIONS;
    await this.modelGrants().revokeAll({ ...args, freeze: async request => {
      if (!sessions) throw new Error("Conversation execution is not configured.");
      await withTimeout(
        sessions.getByName(request.conversationId).freezeOwnerModelGrants(request),
        OWNER_MODEL_GRANT_FREEZE_TIMEOUT_MS,
        "Owner model grant freeze timed out.",
      );
    } });
  }

  /** One owner-fence host call from this object; `fetch()` routes external ones. */
  private ownerFenceCall(path: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
    return createOwnerFenceHost({ ctx: this.ctx, env: this.env }).fetch(path, ownerFenceRequest(path, body, headers));
  }

  async registerConversationReader(args: {
    ownerId: string; ownerGeneration: string; conversationId: string; readerId: string;
  }): Promise<void> {
    if (args.ownerId !== this.ownerId()) throw new MemoryPolicyError("OWNER_MISMATCH", 403);
    await this.modelGrants().registerReader({ conversationId: args.conversationId, readerId: args.readerId });
  }

  async acquireModelGrant(args: {
    ownerId: string; ownerGeneration: string; conversationId: string; readerId: string;
    turnId: string; leaseId: string; fenceGeneration: string; policy: MemoryPolicy;
  }): Promise<OwnerModelGrant> {
    if (args.ownerId !== this.ownerId() || args.ownerGeneration !== args.policy.ownerGeneration)
      throw new MemoryPolicyError("OWNER_MISMATCH", 403);
    const sessions = this.env.ORCHESTRATOR_SESSIONS;
    if (!sessions) throw new Error("Conversation execution is not configured.");
    const response = await this.ownerFenceCall("assert", {
      ownerId: args.ownerId, ownerGeneration: args.ownerGeneration,
      generation: args.fenceGeneration, leaseId: args.leaseId, turnId: args.turnId,
      sessionId: sessions.idFromName(args.conversationId).toString(),
    });
    if (!response.ok) throw new MemoryPolicyError("OWNER_FENCE_CHANGED");
    const lease: unknown = await response.json();
    if (!lease || typeof lease !== "object" || !("expiresAt" in lease) ||
        typeof lease.expiresAt !== "number" || !Number.isFinite(lease.expiresAt))
      throw new MemoryPolicyError("OWNER_FENCE_CHANGED");
    return await this.issueModelGrant({ ...args, expiresAt: lease.expiresAt });
  }

  private async issueModelGrant(args: {
    ownerId: string; ownerGeneration: string; conversationId: string; readerId: string;
    turnId: string; leaseId: string; fenceGeneration: string; policy: MemoryPolicy; expiresAt: number;
  }): Promise<OwnerModelGrant> {
    return await this.memoryPolicy().authorizeGrant(args.policy, args.fenceGeneration, async () => {
      const lease = new OwnerFenceStore(this.ctx.storage.sql).activeLease(args.leaseId);
      const sessions = this.env.ORCHESTRATOR_SESSIONS;
      if (!lease || !sessions || lease.ownerId !== args.ownerId || lease.ownerGeneration !== args.ownerGeneration ||
          lease.turnId !== args.turnId || lease.sessionId !== sessions.idFromName(args.conversationId).toString() ||
          lease.reservationGeneration !== args.fenceGeneration || lease.expiresAt !== args.expiresAt ||
          lease.namespace !== "orchestrator" || lease.role !== "orchestrator")
        throw new MemoryPolicyError("OWNER_FENCE_CHANGED");
      await this.modelGrants().registerReader({ conversationId: args.conversationId, readerId: args.readerId });
      const result = await this.modelGrants().issueGrant({
        ownerId: args.ownerId, ownerGeneration: args.ownerGeneration, conversationId: args.conversationId,
        readerId: args.readerId, turnId: args.turnId, leaseId: args.leaseId,
        fenceGeneration: args.fenceGeneration, memoryPolicy: args.policy, expiresAt: args.expiresAt,
        grantId: `${args.leaseId}:${args.readerId}:${args.expiresAt}`,
      });
      if (result.status !== "issued" && result.status !== "replayed")
        throw new MemoryPolicyError("OWNER_MODEL_GRANT_UNAVAILABLE", 503);
      return result.grant;
    });
  }

  /**
   * The memory policy's transport is this object's own `home_state`. A
   * refusal from the home domain is definitive (400); anything else leaves
   * the change pending for the alarm to retry.
   */
  private memoryPolicy(): OwnerMemoryPolicy {
    return this.memoryPolicyState ??= new OwnerMemoryPolicy(
      this.ctx, this.ownerId(), {
        read: async (ownerGeneration) => {
          try {
            return readMemoryPolicy(this.ownerStore().context(null).db, ownerGeneration);
          } catch (error) {
            throw new MemoryPolicyError(error instanceof RpcError ? error.reason ?? error.code : "MEMORY_POLICY_UNAVAILABLE", 503);
          }
        },
        apply: async (change) => {
          try {
            await this.billingWrite((ctx) => applyMemoryPolicyChange(ctx, change));
          } catch (error) {
            if (error instanceof RpcError && !error.retryable) {
              throw new MemoryPolicyError(error.reason ?? error.code, 400, error.message);
            }
            throw new MemoryPolicyError("MEMORY_POLICY_UNAVAILABLE", 503);
          }
        },
      }, {
        issuanceOpen: () => this.modelGrants().issuanceOpen(),
        revokeReaders: change => this.revokeModelReaders({
          operationId: change.requestId, ownerGeneration: change.expectedOwnerGeneration,
          reason: change.kind === "wipe" ? "memory_wipe" : "memory_policy_change",
        }),
      },
    );
  }

  /** `memory.setEnabled` / `memory.startWipe`: a policy change, refusals as `RpcError`. */
  private async changeMemoryPolicyForCall(change: MemoryPolicyChange): Promise<void> {
    const result = await this.changeMemoryPolicy(change);
    if (result.ok) return;
    throw result.code === "BAD_REQUEST"
      ? new RpcError("BAD_REQUEST", result.message)
      : result.status === 400
      ? new RpcError("CONFLICT", result.message, { reason: result.code, retryable: false })
      : result.status === 503
        ? new RpcError("UNAVAILABLE", "Cloud memory settings are still being applied. Try again.", { reason: result.code })
        : new RpcError("CONFLICT", "Cloud memory settings are still being applied. Try again.", {
            reason: result.code,
            retryable: true,
            retryAfterMs: 2_000,
          });
  }

  async changeMemoryPolicy(change: MemoryPolicyChange): Promise<
    { ok: true } | { ok: false; code: string; status: number; message: string }
  > {
    try {
      await this.memoryPolicy().change(change);
      return { ok: true };
    } catch (error) {
      return { ok: false,
        code: error instanceof MemoryPolicyError ? error.code : "MEMORY_POLICY_UNAVAILABLE",
        status: error instanceof MemoryPolicyError ? error.status : 503,
        message: error instanceof MemoryPolicyError ? error.message : "MEMORY_POLICY_UNAVAILABLE" };
    }
  }

  async assertMemoryPolicy(policy: MemoryPolicy, fenceGeneration: string, leaseId: string, turnId?: string): Promise<void> {
    const invokedAt = Date.now();
    const startedAt = performance.now();
    const response = await this.ownerFenceCall("assert", {
      ownerId: this.ownerId(), ownerGeneration: policy.ownerGeneration, generation: fenceGeneration, leaseId,
    });
    if (!response.ok) throw new MemoryPolicyError("OWNER_FENCE_CHANGED");
    const fenceMs = performance.now() - startedAt;
    await this.memoryPolicy().assert(policy, fenceGeneration);
    log("info", "owner_memory_assertion_timing", {
      turnId, invokedAt, fenceMs, policyMs: performance.now() - startedAt - fenceMs,
      totalMs: performance.now() - startedAt,
    });
  }

  /** The owner this object gates. The namespace is addressed by name only. */
  private ownerId(): string {
    const name = this.ctx.id.name ?? "";
    if (!name)
      throw new Error("Owner gate objects must be addressed by owner id.");
    return name;
  }

  /**
   * Start the owner-scoped gateway cache warm-up while this gate performs its
   * required durable admission. It is intentionally one-shot per DO instance:
   * preparation is advisory and a failure must never delay or refuse a turn.
   */
  private prepareGatewayOwner(): void {
    if (this.gatewayOwnerPreparation) return;
    const control = this.env.MODEL_GATEWAY_CONTROL;
    if (!control) return;
    const ownerId = this.ownerId();
    const preparation = Promise.resolve().then(() =>
      (control as ModelGatewayControl & Fetcher).prepareOwner({ ownerId }))
      .catch(error => {
        log("error", "owner_gateway_preparation_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    this.gatewayOwnerPreparation = preparation;
    this.ctx.waitUntil(preparation);
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    const startedAt = performance.now();
    for (const statement of DDL) this.ctx.storage.sql.exec(statement);
    // Existing owner objects predate durable desktop completion receipts.
    const dispatchColumns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(dispatches)").toArray();
    if (!dispatchColumns.some((column) => column.name === "result_json")) {
      this.ctx.storage.sql.exec("ALTER TABLE dispatches ADD COLUMN result_json TEXT");
    }
    this.schemaReady = true;
    const schemaMs = Math.round(performance.now() - startedAt);
    log("info", "owner_gate_wake_timing", {
      schemaMs,
      totalMs: schemaMs,
    });
  }

  private turnTimeoutMs(): number {
    const parsed = Number(this.env.TURN_TIMEOUT_MS ?? "");
    return Number.isSafeInteger(parsed) && parsed > 0
      ? parsed
      : DEFAULT_TURN_TIMEOUT_MS;
  }

  /**
   * The owner snapshot, built from this object's own tables on every read:
   * generation and writability from `account`, identity as the owner's last
   * verified token claimed it, enforcement from `abuse`, plan and turn
   * allowance from `billing`, execution from `engines`, devices from
   * `devices`. `refresh` is accepted for callers that still pass it.
   */
  async snapshot(
    options: { refresh?: boolean; now?: number } = {},
  ): Promise<OwnerSnapshot> {
    const now = options.now ?? Date.now();
    const store = this.ownerStore();
    const ctx = store.context(null, now);
    try {
      const state = readOwnerState(ctx.db);
      const enforcement = enforcementForSnapshot(ctx);
      const owned: OwnerSnapshot = {
        v: OWNER_SNAPSHOT_VERSION,
        ownerId: this.ownerId(),
        ownerGeneration: state.generation,
        writable: state.writable && enforcement?.status !== "suspended",
        isAnonymous: state.isAnonymous,
        identityLevel: state.identityLevel,
        ...(enforcement ? { enforcement } : {}),
        plan: "free",
        allowance: {
          audience: state.isAnonymous ? "anonymous" : "free",
          budgetMicroCents: 0,
        },
        ...snapshotDevices(ctx.db),
        ...snapshotEngines(ctx.db),
        fetchedAt: now,
        ttlMs: SNAPSHOT_TTL_MS,
      };
      let billing: ReturnType<typeof turnAllowance>;
      try {
        recordBillingIdentity(ctx, {
          isAnonymous: state.isAnonymous,
          identityLevel: state.identityLevel,
        });
        billing = turnAllowance(ctx);
      } catch (error) {
        if (!(error instanceof BillingConfigError)) throw error;
        // Unconfigured billing serves a zero allowance: turns fail closed
        // until it is set.
        log("error", "billing_unconfigured", { message: error.message });
        return owned;
      }
      return {
        ...owned,
        plan: billing.plan,
        identityLevel: billing.identityLevel,
        allowance: billing.allowance,
      };
    } finally {
      store.flush();
    }
  }

  /** Record the identity a Worker-verified token claims, for the snapshot. */
  async noteIdentity(input: { isAnonymous: boolean; identityLevel?: IdentityLevel }): Promise<void> {
    const store = this.ownerStore();
    try {
      noteCallerIdentity(store.context(null).db, input);
    } finally {
      store.flush();
    }
  }

  /**
   * The snapshot read and one exact owner-fence `register` in a single round
   * trip, for a caller that would otherwise make them back to back. The
   * register runs only when the snapshot still authorizes the caller's
   * generation, so a stale or fenced-off caller never leaves a lease behind,
   * and it runs through the same fence host `POST /owner-fence/register`
   * uses: the lease protocol is unchanged, only the transport is. A snapshot
   * that cannot be obtained is returned as a value rather than thrown, so the
   * caller can tell "nothing was registered" from a lost response.
   */
  async snapshotWithFenceLease(input: {
    lease: OwnerGateFenceLeaseRequest;
    now?: number;
  }): Promise<OwnerGateSnapshotWithLease> {
    const now = input.now ?? Date.now();
    let snapshot: OwnerSnapshot;
    try {
      snapshot = await this.snapshot({ now });
    } catch (error) {
      const failure =
        error instanceof OwnerGateSnapshotError
          ? error
          : new OwnerGateSnapshotError(
              "internal",
              error instanceof Error ? error.message : String(error),
              true,
            );
      return {
        snapshot: null,
        snapshotError: {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        },
        lease: { status: "skipped", reason: "snapshot_unavailable" },
      };
    }
    if (!snapshot.writable) {
      return { snapshot, lease: { status: "skipped", reason: "not_writable" } };
    }
    if (snapshot.ownerGeneration !== input.lease.ownerGeneration) {
      return {
        snapshot,
        lease: { status: "skipped", reason: "generation_stale" },
      };
    }
    return { snapshot, lease: await this.registerFenceLease(input.lease) };
  }

  /** Admission policy and the colocated fence share one transport, not weaker checks. */
  async admitWithFenceLease(input: {
    admission: OwnerGateAdmitInput;
    lease: OwnerGateFenceLeaseRequest;
    includeHomeContext?: boolean;
  }): Promise<OwnerGateAdmissionWithLease> {
    if (input.admission.turnId !== input.lease.turnId) {
      return {
        admission: refuse(
          "internal",
          "Admission and lease turn ids differ.",
          false,
        ),
        lease: { status: "skipped", reason: "admission_refused" },
      };
    }
    const admission = await this.admit(input.admission);
    if (!admission.ok) {
      return {
        admission,
        lease: { status: "skipped", reason: "admission_refused" },
      };
    }
    if (admission.snapshot.ownerGeneration !== input.lease.ownerGeneration) {
      return {
        admission,
        lease: { status: "skipped", reason: "generation_stale" },
      };
    }
    const lease = await this.registerFenceLease(input.lease);
    if (input.includeHomeContext && lease.status === "registered") {
      // A context failure must not hide a successfully registered lease. The
      // caller owns its receipt and may retry preparation through the normal path.
      const [homeContext, destinations] = await Promise.all([
        this.homeContext(input.lease.ownerGeneration, lease.generation).catch(() => undefined),
        this.devices().catch(() => undefined),
      ]);
      return { admission, lease, ...(homeContext ? { homeContext } : {}), ...(destinations ? { destinations } : {}) };
    }
    return { admission, lease };
  }

  private async registerFenceLease(
    lease: OwnerGateFenceLeaseRequest,
  ): Promise<OwnerGateFenceLeaseOutcome> {
    const ownerId = this.ownerId();
    const response = await this.ownerFenceCall(
      "register",
      { ...lease, ownerId },
      { [HEADER_OWNER_FENCE_ID]: ownerId },
    );
    const body = (await response.json().catch(() => null)) as {
      generation?: unknown;
      expiresAt?: unknown;
      code?: unknown;
      error?: unknown;
    } | null;
    if (
      response.ok &&
      typeof body?.generation === "string" &&
      typeof body.expiresAt === "number"
    ) {
      return {
        status: "registered",
        generation: body.generation,
        expiresAt: body.expiresAt,
      };
    }
    return {
      status: "refused",
      httpStatus: response.status,
      ...(typeof body?.code === "string" ? { code: body.code } : {}),
      ...(typeof body?.error === "string" ? { error: body.error } : {}),
    };
  }

  private prune(now: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM running WHERE started_at < ?`,
      now - (this.turnTimeoutMs() + OWNER_GATE_RUNNING_GRACE_MS),
    );
  }

  async admit(input: OwnerGateAdmitInput): Promise<OwnerGateAdmission> {
    this.ensureSchema();
    const now = input.now ?? Date.now();
    const turnId = input.turnId?.trim() ?? "";
    if (!turnId || (input.lane !== "chat" && input.lane !== "agent")) {
      return refuse(
        "internal",
        "Owner gate admission requires a lane and turn id.",
        false,
      );
    }
    let snapshot: OwnerSnapshot;
    try {
      snapshot = await this.snapshot({ now });
      if (
        input.expectedGeneration &&
        input.expectedGeneration !== snapshot.ownerGeneration
      ) {
        // The cache can lag a rotation whose push was lost. One forced
        // refresh separates "stale cache" from "stale caller".
        snapshot = await this.snapshot({ refresh: true, now });
      }
    } catch (error) {
      const failure =
        error instanceof OwnerGateSnapshotError
          ? error
          : new OwnerGateSnapshotError(
              "internal",
              error instanceof Error ? error.message : String(error),
              true,
            );
      log("error", "owner_gate_snapshot_unavailable", {
        ownerId: this.ownerId(),
        code: failure.code,
        message: failure.message,
      });
      return failure.code === "owner_purged"
        ? refuse(
            "owner_purged",
            "This account's cloud data is no longer available.",
            false,
          )
        : refuse(
            "internal",
            "Stella can't check your account right now. Try again shortly.",
            true,
          );
    }
    if (
      input.expectedGeneration &&
      input.expectedGeneration !== snapshot.ownerGeneration
    ) {
      return refuse(
        "generation_stale",
        "This cloud owner generation is no longer current.",
        false,
      );
    }
    if (snapshot.enforcement?.status === "suspended") {
      return refuse(
        "owner_suspended",
        "This account can't use Stella's cloud right now.",
        false,
      );
    }
    if (!snapshot.writable) {
      return refuse(
        "owner_purged",
        "This account's cloud data is being reset or deleted.",
        false,
      );
    }
    if (input.lane === "agent" && snapshot.isAnonymous) {
      return refuse(
        "sign_in_required",
        "Sign in to Stella to use cloud agents.",
        false,
      );
    }
    this.prune(now);
    const existing = this.ctx.storage.sql
      .exec<{
        lane: string;
      }>(`SELECT lane FROM running WHERE turn_id = ?`, turnId)
      .toArray();
    if (existing.length > 0) {
      return { ok: true, snapshot, replayed: true };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO running (turn_id, lane, conversation_id, started_at)
       VALUES (?, ?, ?, ?)`,
      turnId,
      input.lane,
      input.conversationId ?? "",
      now,
    );
    return { ok: true, snapshot, replayed: false };
  }

  /** Idempotent: a release for a turn the gate no longer tracks is a no-op. */
  async release(input: { turnId: string }): Promise<void> {
    this.ensureSchema();
    const turnId = input.turnId?.trim() ?? "";
    if (!turnId) return;
    this.ctx.storage.sql.exec(`DELETE FROM running WHERE turn_id = ?`, turnId);
  }

  /** Diagnostics for tests and operators; never on a turn's path. */
  async status(now = Date.now()): Promise<{
    running: Array<{
      turnId: string;
      lane: string;
      conversationId: string;
      startedAt: number;
    }>;
  }> {
    this.ensureSchema();
    this.prune(now);
    const running = this.ctx.storage.sql
      .exec<{
        turn_id: string;
        lane: string;
        conversation_id: string;
        started_at: number;
      }>(
        `SELECT turn_id, lane, conversation_id, started_at FROM running ORDER BY started_at ASC`,
      )
      .toArray()
      .map((row) => ({
        turnId: row.turn_id,
        lane: row.lane,
        conversationId: row.conversation_id,
        startedAt: row.started_at,
      }));
    return { running };
  }

  // ── Device presence sockets ───────────────────────────────────────────
  //
  // One hibernatable socket per device, tagged by device id. The device
  // proves possession of the key the owner snapshot registered before it is
  // told anything: a socket that never sends a valid `proof` is anonymous,
  // receives no offer, and counts as no presence at all.

  private sockets(deviceId?: string): WebSocket[] {
    try {
      return deviceId
        ? this.ctx.getWebSockets(presenceTag(deviceId))
        : this.ctx.getWebSockets();
    } catch {
      return [];
    }
  }

  private attachment(socket: WebSocket): PresenceAttachment | null {
    try {
      const value = socket.deserializeAttachment() as PresenceAttachment | null;
      return value && value.v === 1 ? value : null;
    } catch {
      return null;
    }
  }

  private send(socket: WebSocket, frame: DevicePresenceServerFrame): void {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // The peer is gone; the close path cleans up.
    }
  }

  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Already gone.
    }
  }

  /** The one connected, proven socket for a device, if it has one. */
  private connectedSocket(deviceId: string): WebSocket | null {
    for (const socket of this.sockets(deviceId)) {
      const attachment = this.attachment(socket);
      if (attachment?.phase === "connected") return socket;
    }
    return null;
  }

  /** `body` is `request`'s parsed JSON when the path can change authority. */
  private async fetchOwnerFence(path: string, request: Request, body: unknown): Promise<Response> {
    if (path !== "begin") return createOwnerFenceHost({ ctx: this.ctx, env: this.env }).fetch(path, request);
    // Owner admission and revocation share this section. Reader freeze RPCs
    // only touch local conversation state; they never call back into OwnerGate.
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const operationId = await sha256Hex(JSON.stringify({ path, body }));
        const response = await createOwnerFenceHost({ ctx: this.ctx, env: this.env,
          beforeAuthorityChange: async change => {
            await this.modelGrants().beginFenceBarrier({ operationId, path: change.path, body: change.body });
            await this.revokeModelReaders({ operationId, reason: "owner_purge" });
          },
        }).fetch(path, request);
        // A definite result closes this exact replay marker, including a
        // successful replay after the fence commit outlived the previous caller.
        if (response.ok || response.status < 500) await this.modelGrants().completeFenceBarrier(operationId);
        return { ok: true as const, response };
      } catch (error) { return { ok: false as const, error }; }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.response;
  }

  /**
   * `GET /owners/me/devices/:deviceId/presence`, forwarded by the Worker with
   * the owner and device it verified. Answers the 101 immediately and sends
   * the challenge; nothing else is disclosed until the proof lands.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/owner-fence/")) {
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed." }, { status: 405 });
      }
      const path = url.pathname.slice("/owner-fence/".length);
      const body: unknown = path === "begin" || path === "register" || path === "unregister"
        ? await request.clone().json() : undefined;
      const unregister = path === "unregister" ? body : undefined;
      const response = await this.fetchOwnerFence(path, request, body);
      if (response.ok && unregister && typeof unregister === "object" &&
          "turnId" in unregister && typeof unregister.turnId === "string" &&
          "leaseId" in unregister && typeof unregister.leaseId === "string") {
        if ("ownerGeneration" in unregister && typeof unregister.ownerGeneration === "string") {
          await this.modelGrants().retireExactTurnLease({ ownerGeneration: unregister.ownerGeneration,
            turnId: unregister.turnId, leaseId: unregister.leaseId });
        }
        const dispatchId = await this.ctx.storage.get<string>(cloudChatTurnKey(unregister.turnId));
        const handoff = dispatchId ? await this.ctx.storage.get<CloudChatHandoff>(cloudChatHandoffKey(dispatchId)) : undefined;
        const identity = handoff?.phase === "registered" ? handoff.authority : handoff;
        if (dispatchId && identity?.turnId === unregister.turnId && identity.leaseId === unregister.leaseId) {
          await this.ctx.storage.put(cloudChatHandoffKey(dispatchId), { phase: "retired", turnId: identity.turnId, leaseId: identity.leaseId } satisfies CloudChatHandoff);
          await this.release({ turnId: identity.turnId });
          this.ctx.storage.sql.exec("UPDATE dispatches SET gate_held = 0 WHERE dispatch_id = ?", dispatchId);
        }
      }
      return response;
    }
    if (url.pathname === "/live") {
      if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
        return Response.json({ error: "This endpoint speaks WebSocket only." }, { status: 426 });
      }
      const caller = trustedOwnerCaller(request);
      if (!caller || caller.ownerId !== this.ownerId()) {
        return Response.json({ error: "Missing verified identity." }, { status: 401 });
      }
      const store = this.ownerStore();
      const { db } = store.context(caller);
      if (callerSessionRevoked(db, caller)) {
        return Response.json({ error: "You were signed out." }, { status: 401 });
      }
      noteCallerIdentity(db, caller);
      const response = store.acceptLive(caller);
      await this.scheduleAlarm(Date.now());
      return response;
    }
    if (url.pathname !== "/presence") {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return Response.json(
        { error: "This endpoint speaks WebSocket only." },
        { status: 426 },
      );
    }
    const ownerId = request.headers.get("x-stella-owner")?.trim() ?? "";
    const deviceId =
      request.headers.get(HEADER_PRESENCE_DEVICE_ID)?.trim() ?? "";
    const authExpiresAtMs = Number(request.headers.get("x-stella-token-exp"));
    const now = Date.now();
    if (
      !ownerId ||
      ownerId !== this.ownerId() ||
      !deviceId ||
      deviceId.length > MAX_DEVICE_ID_CHARS ||
      !Number.isFinite(authExpiresAtMs) ||
      authExpiresAtMs <= now
    ) {
      return Response.json(
        { error: "Missing verified device identity." },
        { status: 401 },
      );
    }
    this.ensureSchema();
    const pair = new WebSocketPair();
    const server = pair[1]!;
    const attachment: PresenceAttachment = {
      v: 1,
      deviceId,
      authExpiresAtMs,
      connectionId: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      phase: "challenged",
      lastSeenAtMs: now,
    };
    this.ctx.acceptWebSocket(server, [presenceTag(deviceId)]);
    server.serializeAttachment(attachment);
    this.send(server, {
      type: "challenge",
      connectionId: attachment.connectionId,
      nonce: attachment.nonce,
      pingIntervalMs: DEVICE_PRESENCE_PING_INTERVAL_MS,
      staleAfterMs: DEVICE_PRESENCE_STALE_AFTER_MS,
    });
    await this.scheduleAlarm(now);
    return new Response(null, {
      status: 101,
      webSocket: pair[0]!,
      headers: { "sec-websocket-protocol": DEVICE_PRESENCE_SUBPROTOCOL },
    });
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (this.ownerStore().isLiveSocket(socket)) {
      await this.ownerStore().onLiveMessage(socket, message);
      await this.scheduleAlarm(Date.now());
      return;
    }
    const text =
      typeof message === "string"
        ? message
        : new TextDecoder().decode(new Uint8Array(message));
    if (
      new TextEncoder().encode(text).byteLength >
      DEVICE_PRESENCE_MAX_FRAME_BYTES
    ) {
      this.closeSocket(
        socket,
        DEVICE_PRESENCE_CLOSE.protocol,
        "frame_too_large",
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
      return;
    }
    if (!isRecord(parsed)) {
      this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
      return;
    }
    const attachment = this.attachment(socket);
    if (!attachment) {
      this.closeSocket(
        socket,
        DEVICE_PRESENCE_CLOSE.unauthorized,
        "unauthorized",
      );
      return;
    }
    this.ensureSchema();
    const now = Date.now();
    if (attachment.authExpiresAtMs <= now) {
      await this.dropSocket(
        socket,
        attachment,
        DEVICE_PRESENCE_CLOSE.stale,
        "stale",
        now,
      );
      return;
    }
    const frame = parsed as DevicePresenceDeviceFrame;
    try {
      await this.handleDeviceFrame(socket, attachment, frame, now);
    } catch (error) {
      log("error", "device_presence_frame_failed", {
        ownerId: this.ownerId(),
        deviceId: attachment.deviceId,
        type: String((frame as { type?: unknown }).type ?? ""),
        message: error instanceof Error ? error.message : String(error),
      });
      this.send(socket, {
        type: "error",
        code: "internal",
        message: "Stella could not process that frame.",
        retryable: true,
      });
    }
  }

  private async handleDeviceFrame(
    socket: WebSocket,
    attachment: PresenceAttachment,
    frame: DevicePresenceDeviceFrame,
    now: number,
  ): Promise<void> {
    if (frame.type === "begin") {
      if (attachment.phase !== "challenged") {
        this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
        return;
      }
      const presenceSessionId =
        typeof frame.presenceSessionId === "string"
          ? frame.presenceSessionId.trim()
          : "";
      const availability = parseAvailability(frame.availability);
      if (
        !presenceSessionId ||
        presenceSessionId.length > 128 ||
        frame.protocolVersion !== DEVICE_PRESENCE_PROTOCOL_VERSION ||
        !availability
      ) {
        this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
        return;
      }
      attachment.presenceSessionId = presenceSessionId;
      attachment.availability = availability;
      attachment.phase = "begun";
      attachment.lastSeenAtMs = now;
      socket.serializeAttachment(attachment);
      return;
    }
    if (frame.type === "proof") {
      if (attachment.phase !== "begun" || !attachment.presenceSessionId) {
        this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
        return;
      }
      const signature =
        typeof frame.signature === "string" ? frame.signature.trim() : "";
      let snapshot: OwnerSnapshot;
      try {
        snapshot = await this.snapshot({ now });
      } catch {
        this.closeSocket(
          socket,
          DEVICE_PRESENCE_CLOSE.internal,
          "presence_unavailable",
        );
        return;
      }
      const device = (snapshot.devices ?? []).find(
        (candidate) => candidate.deviceId === attachment.deviceId,
      );
      const verified =
        Boolean(device) &&
        Boolean(signature) &&
        (await verifyDevicePresenceProof({
          publicKey: device!.publicKey,
          message: devicePresenceProofMessage({
            connectionId: attachment.connectionId,
            nonce: attachment.nonce,
          }),
          signature,
        }));
      if (!verified) {
        log("error", "device_presence_proof_rejected", {
          ownerId: this.ownerId(),
          deviceId: attachment.deviceId,
          registered: Boolean(device),
        });
        this.closeSocket(
          socket,
          DEVICE_PRESENCE_CLOSE.proofRejected,
          "device_proof_rejected",
        );
        return;
      }
      // The proof is what earns the device its slot, so the older socket for
      // the same device only loses it here — a failed handshake can never
      // evict a working one.
      for (const other of this.sockets(attachment.deviceId)) {
        if (other === socket) continue;
        this.closeSocket(other, DEVICE_PRESENCE_CLOSE.replaced, "replaced");
      }
      attachment.phase = "connected";
      attachment.lastSeenAtMs = now;
      socket.serializeAttachment(attachment);
      this.writePresence(attachment, now, true);
      this.send(socket, {
        type: "connected",
        presenceSessionId: attachment.presenceSessionId,
        serverTimeMs: now,
      });
      await this.scheduleAlarm(now);
      return;
    }
    if (attachment.phase !== "connected" || !attachment.presenceSessionId) {
      this.closeSocket(
        socket,
        DEVICE_PRESENCE_CLOSE.unauthorized,
        "unauthorized",
      );
      return;
    }
    attachment.lastSeenAtMs = now;
    if (frame.type === "ping") {
      socket.serializeAttachment(attachment);
      this.touchPresence(attachment.deviceId, now);
      this.send(socket, { type: "pong", serverTimeMs: now });
      return;
    }
    if (frame.type === "availability") {
      const availability = parseAvailability(frame.availability);
      if (!availability) {
        this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
        return;
      }
      attachment.availability = availability;
      socket.serializeAttachment(attachment);
      this.writePresence(attachment, now, true);
      return;
    }
    socket.serializeAttachment(attachment);
    await this.handleExecutorFrame(socket, attachment, frame, now);
  }

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    if (this.ownerStore().isLiveSocket(socket)) {
      this.ownerStore().onLiveClose(socket);
      return;
    }
    const attachment = this.attachment(socket);
    const now = Date.now();
    if (attachment?.phase === "connected") {
      this.markDisconnected(attachment, now);
    }
    this.closeSocket(socket, code >= 3000 && code <= 4999 ? code : 1000, "");
    await this.scheduleAlarm(now);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    if (this.ownerStore().isLiveSocket(socket)) {
      this.ownerStore().onLiveClose(socket);
      return;
    }
    const attachment = this.attachment(socket);
    const now = Date.now();
    if (attachment?.phase === "connected") {
      this.markDisconnected(attachment, now);
    }
    this.closeSocket(socket, 1011, "socket_error");
  }

  private async dropSocket(
    socket: WebSocket,
    attachment: PresenceAttachment,
    code: number,
    reason: string,
    now: number,
  ): Promise<void> {
    if (attachment.phase === "connected") {
      this.markDisconnected(attachment, now);
    }
    this.closeSocket(socket, code, reason);
    await this.scheduleAlarm(now);
  }

  private writePresence(
    attachment: PresenceAttachment,
    now: number,
    connected: boolean,
  ): void {
    const availability = attachment.availability ?? {
      ready: false,
      capabilities: [],
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO device_presence (
         device_id, presence_session_id, connection_id, connected, ready,
         chat_slots, agent_slots, capabilities, protocol_version,
         last_seen_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         presence_session_id = excluded.presence_session_id,
         connection_id = excluded.connection_id,
         connected = excluded.connected,
         ready = excluded.ready,
         chat_slots = excluded.chat_slots,
         agent_slots = excluded.agent_slots,
         capabilities = excluded.capabilities,
         protocol_version = excluded.protocol_version,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`,
      attachment.deviceId,
      attachment.presenceSessionId ?? "",
      attachment.connectionId,
      connected ? 1 : 0,
      availability.ready ? 1 : 0,
      // Retained only for compatibility with existing SQLite tables.
      0,
      0,
      JSON.stringify(availability.capabilities),
      DEVICE_PRESENCE_PROTOCOL_VERSION,
      now,
      now,
    );
  }

  private touchPresence(deviceId: string, now: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE device_presence SET last_seen_at = ?, updated_at = ? WHERE device_id = ?`,
      now,
      now,
      deviceId,
    );
  }

  /**
   * A device that goes away keeps its row (so the destinations list can say
   * "offline" rather than "unknown") but is immediately ineligible.
   */
  private markDisconnected(attachment: PresenceAttachment, now: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE device_presence
         SET connected = 0, ready = 0, updated_at = ?
       WHERE device_id = ? AND connection_id = ?`,
      now,
      attachment.deviceId,
      attachment.connectionId,
    );
  }

  private presenceRow(deviceId: string): DevicePresenceState | undefined {
    const row = this.ctx.storage.sql
      .exec<PresenceRow>(
        `SELECT device_id, presence_session_id, connection_id, connected, ready,
                chat_slots, agent_slots, capabilities, protocol_version, last_seen_at
           FROM device_presence WHERE device_id = ?`,
        deviceId,
      )
      .toArray()[0];
    return row ? presenceState(row) : undefined;
  }

  private selectedDeviceRefusal(args: {
    deviceId: string | null;
    now: number;
  }): { fallbackReason: string; errorCode: string; errorMessage: string } | null {
    const presence = args.deviceId ? this.presenceRow(args.deviceId) : undefined;
    if (
      !args.deviceId ||
      !presence?.connected ||
      presence.lastSeenAt + DEVICE_PRESENCE_STALE_AFTER_MS <= args.now
    ) {
      return {
        fallbackReason: "selected-device-offline",
        errorCode: "SELECTED_DEVICE_OFFLINE",
        errorMessage: "The selected computer is offline.",
      };
    }
    if (!presence.ready) {
      return {
        fallbackReason: "selected-device-unavailable",
        errorCode: "SELECTED_DEVICE_UNAVAILABLE",
        errorMessage:
          "The selected computer is online but isn't accepting work right now. It may still be starting up, be signed out, have cloud sync off, or not allow work from other devices.",
      };
    }
    return null;
  }

  /** `GET /owners/me/devices`: registered destinations joined with presence. */
  async devices(now = Date.now()): Promise<DevicesResponse> {
    this.ensureSchema();
    const snapshot = await this.snapshot({ now });
    const devices: DeviceDestination[] = [];
    for (const device of snapshot.devices ?? []) {
      const presence = this.presenceRow(device.deviceId);
      const online = Boolean(
        presence?.connected &&
        presence.lastSeenAt + DEVICE_PRESENCE_STALE_AFTER_MS > now,
      );
      devices.push({
        deviceId: device.deviceId,
        ...(device.label ? { label: device.label } : {}),
        remoteExecutionEnabled: device.remoteExecutionEnabled,
        online,
        ...(presence
          ? {
              presenceSessionId: presence.presenceSessionId,
              availability: withReleasedClientSelectability({
                ready: online && presence.ready,
                capabilities: presence.capabilities,
              }),
              lastSeenAt: presence.lastSeenAt,
            }
          : {}),
      });
    }
    return {
      protocol: PLACEMENT_PROTOCOL,
      devices,
      cloud: { capabilities: [...CLOUD_CAPABILITIES] },
    };
  }

  // ── Placement ─────────────────────────────────────────────────────────

  private dispatchRow(dispatchId: string): DispatchRow | undefined {
    return this.ctx.storage.sql
      .exec<DispatchRow>(
        `SELECT * FROM dispatches WHERE dispatch_id = ?`,
        dispatchId,
      )
      .toArray()[0];
  }

  private notifyExecutor(row: DispatchRow): void {
    if (!row.executor_device_id) return;
    const socket = this.connectedSocket(row.executor_device_id);
    if (!socket) return;
    this.send(socket, { type: "dispatch", dispatch: dispatchSummary(row) });
  }

  /** Every transition goes through here: one revision bump. */
  private async patchDispatch(
    row: DispatchRow,
    patch: Record<string, string | number | null>,
    now: number,
    options: { notifyExecutor?: boolean } = {},
  ): Promise<DispatchRow> {
    const columns = Object.keys(patch);
    const assignments = [
      ...columns.map((column) => `${column} = ?`),
      "revision = revision + 1",
      "updated_at = ?",
    ];
    this.ctx.storage.sql.exec(
      `UPDATE dispatches SET ${assignments.join(", ")} WHERE dispatch_id = ?`,
      ...columns.map((column) => patch[column] ?? null),
      now,
      row.dispatch_id,
    );
    const next = this.dispatchRow(row.dispatch_id)!;
    if (options.notifyExecutor !== false) this.notifyExecutor(next);
    if (
      !isTerminalDispatchState(row.state as DispatchState) &&
      isTerminalDispatchState(next.state as DispatchState)
    ) {
      await this.reportDeviceAgentSettled(next);
    }
    return next;
  }

  /**
   * A device attempt of an owner agent thread ended: hand the outcome to the
   * thread ledger, which records it and wakes a cloud requester.
   */
  private async reportDeviceAgentSettled(row: DispatchRow): Promise<void> {
    const key = row.kind === "agent" ? parseDeviceAgentDispatchKey(row.idempotency_key) : null;
    if (!key) return;
    const response = await this.ownerStore().internalCall("agentThreads.deviceSettled", {
      turnId: key.turnId,
      requeue: key.requeue,
      state: row.state,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.result_json ? { resultJson: row.result_json } : {}),
      ...(row.error_message ? { errorMessage: row.error_message } : {}),
    });
    if (!response.ok) {
      log("error", "device_agent_settle_failed", {
        dispatchId: row.dispatch_id,
        message: response.error.message,
      });
    }
  }

  private openOffers(dispatchId: string): Array<{
    device_id: string;
    presence_session_id: string;
  }> {
    return this.ctx.storage.sql
      .exec<{ device_id: string; presence_session_id: string }>(
        `SELECT device_id, presence_session_id FROM dispatch_offers
          WHERE dispatch_id = ? AND status = 'open'`,
        dispatchId,
      )
      .toArray();
  }

  private withdrawOffers(
    dispatchId: string,
    keepDeviceId: string | null,
    reason: string,
    now: number,
  ): void {
    for (const offer of this.openOffers(dispatchId)) {
      if (keepDeviceId && offer.device_id === keepDeviceId) continue;
      this.ctx.storage.sql.exec(
        `UPDATE dispatch_offers SET status = 'withdrawn', updated_at = ?
          WHERE dispatch_id = ? AND device_id = ?`,
        now,
        dispatchId,
        offer.device_id,
      );
      const socket = this.connectedSocket(offer.device_id);
      if (socket) {
        this.send(socket, { type: "offer.withdrawn", dispatchId, reason });
      }
    }
  }

  private eligibleDevices(args: {
    snapshot: OwnerSnapshot;
    deviceIds: readonly string[];
    kind: ExecutionKind;
    requiredCapabilities: readonly ExecutionCapability[];
    now: number;
  }): DevicePresenceState[] {
    const registrations = new Map<string, DeviceRegistration>();
    for (const device of args.snapshot.devices ?? []) {
      registrations.set(device.deviceId, device);
    }
    const eligible: DevicePresenceState[] = [];
    for (const deviceId of args.deviceIds) {
      const presence = this.presenceRow(deviceId);
      if (
        isEligibleDevice({
          presence,
          device: registrations.get(deviceId),
          kind: args.kind,
          requiredCapabilities: args.requiredCapabilities,
          now: args.now,
          staleAfterMs: DEVICE_PRESENCE_STALE_AFTER_MS,
        })
      ) {
        eligible.push(presence!);
      }
      if (eligible.length >= MAX_OFFERS_PER_DISPATCH) break;
    }
    return eligible;
  }

  /**
   * The devices an offer for this dispatch may reach, before eligibility is
   * consulted. One function so a submit and a re-offer after a release can
   * never disagree about who the work was ever for.
   */
  private offerCandidateIds(
    row: Pick<
      DispatchRow,
      | "ingress"
      | "requesting_device_id"
      | "pair_grant_device_id"
      | "requested_target_mode"
      | "requested_executor_device_id"
    >,
    snapshot: OwnerSnapshot,
  ): string[] {
    if (row.ingress === "mobile" && row.requesting_device_id) {
      return [
        ...new Set(
          (snapshot.pairedDevices ?? [])
            .filter(
              (pairing) =>
                pairing.mobileDeviceId === row.requesting_device_id &&
                (!row.pair_grant_device_id ||
                  pairing.desktopDeviceId === row.pair_grant_device_id),
            )
            .map((pairing) => pairing.desktopDeviceId),
        ),
      ];
    }
    if (
      (row.ingress === "desktop" ||
        row.ingress === "browser" ||
        row.ingress === "schedule" ||
        // A cloud agent spawned onto a named device (agent threads only;
        // the public submit route never admits cloud ingress).
        row.ingress === "cloud") &&
      row.requested_target_mode === "device" &&
      row.requested_executor_device_id
    ) {
      return [row.requested_executor_device_id];
    }
    return [];
  }

  private openOffer(
    dispatchId: string,
    device: DevicePresenceState,
    expiresAt: number,
    now: number,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO dispatch_offers (
         dispatch_id, device_id, presence_session_id, status, expires_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'open', ?, ?, ?)
       ON CONFLICT(dispatch_id, device_id) DO UPDATE SET
         presence_session_id = excluded.presence_session_id,
         status = 'open',
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      dispatchId,
      device.deviceId,
      device.presenceSessionId,
      expiresAt,
      now,
      now,
    );
  }

  private pushOffer(
    row: DispatchRow,
    deviceId: string,
    offerExpiresAt: number,
  ): void {
    const socket = this.connectedSocket(deviceId);
    if (!socket) return;
    this.send(socket, {
      type: "offer",
      dispatch: dispatchSummary(row),
      payloadJson: row.payload_json ?? "",
      payloadHash: row.payload_hash,
      offerExpiresAt,
    });
  }

  private async releaseGate(row: DispatchRow): Promise<void> {
    if (row.gate_held !== 1) return;
    const handoff = await this.ctx.storage.get<CloudChatHandoff>(cloudChatHandoffKey(row.dispatch_id));
    await this.release({ turnId: handoff?.phase === "registered" ? handoff.authority.turnId : handoff?.turnId ?? row.dispatch_id });
    this.ctx.storage.sql.exec(
      `UPDATE dispatches SET gate_held = 0 WHERE dispatch_id = ?`,
      row.dispatch_id,
    );
    row.gate_held = 0;
  }

  /**
   * The one legal local-to-cloud transition. Callers must prove the local
   * executor has not acknowledged durable ownership before entering here: an
   * accepted dispatch is never rerouted, it is reconciled.
   */
  private async resolveUnaccepted(
    row: DispatchRow,
    now: number,
    fallbackReason: string,
  ): Promise<DispatchRow> {
    if (row.state !== "offering" && row.state !== "computer_claimed") {
      return row;
    }
    this.withdrawOffers(row.dispatch_id, null, fallbackReason, now);
    if (row.on_no_eligible_computer === "cloud") {
      const committed = await this.patchDispatch(
        row,
        {
          state: "cloud_committed",
          placement: "cloud",
          executor_device_id: null,
          executor_presence_session_id: null,
          offer_deadline_at: null,
          lease_expires_at: now + DISPATCH_ACCEPTED_LEASE_MS,
          fallback_reason: fallbackReason,
        },
        now,
      );
      return await this.runCloudBranch(committed, now);
    }
    const explicitDevice = row.requested_target_mode === "device";
    const refusal = explicitDevice
      ? this.selectedDeviceRefusal({
          deviceId: row.requested_executor_device_id,
          now,
        })
      : null;
    const blocked = await this.patchDispatch(
      row,
      {
        state: "blocked",
        executor_device_id: null,
        executor_presence_session_id: null,
        offer_deadline_at: null,
        lease_expires_at: null,
        payload_json: null,
        payload_expires_at: null,
        fallback_reason: refusal
          ? refusal.fallbackReason
          : explicitDevice
            ? "selected-device-unavailable"
            : "no-eligible-paired-computer",
        error_code: refusal
          ? refusal.errorCode
          : explicitDevice
            ? "SELECTED_DEVICE_UNAVAILABLE"
            : "COMPUTER_REQUIRED_UNAVAILABLE",
        error_message: refusal
          ? refusal.errorMessage
          : explicitDevice
            ? "The selected computer did not accept the request."
            : "This work requires your paired computer, but no eligible computer is reachable.",
      },
      now,
    );
    await this.releaseGate(blocked);
    return blocked;
  }

  // ── The cloud branch ──────────────────────────────────────────────────

  private cloudPayload(row: DispatchRow): DispatchPayload | null {
    if (!row.payload_json) return null;
    try {
      return JSON.parse(row.payload_json) as DispatchPayload;
    } catch {
      return null;
    }
  }

  /**
   * Start the dispatch in Stella's cloud: a chat turn on the conversation
   * object, an agent attempt on a fresh build session. Both are addressed as
   * Durable Objects — this gate is already inside the service boundary, so
   * the trusted headers are stamped directly rather than routed back through
   * the Worker.
   */
  private async runCloudBranch(
    row: DispatchRow,
    now: number,
  ): Promise<DispatchRow> {
    if (row.state !== "cloud_committed") return row;
    const required = JSON.parse(
      row.required_capabilities,
    ) as ExecutionCapability[];
    const unsupported = cloudUnsupportedCapabilities(required);
    if (unsupported.length > 0) {
      const failed = await this.patchDispatch(
        row,
        {
          state: "failed",
          payload_json: null,
          payload_expires_at: null,
          lease_expires_at: null,
          error_code: "CLOUD_CAPABILITY_UNAVAILABLE",
          error_message: `The cloud sandbox cannot provide the required device capability: ${unsupported.join(", ")}.`,
        },
        now,
      );
      await this.releaseGate(failed);
      return failed;
    }
    const payload = this.cloudPayload(row);
    if (!payload) {
      const failed = await this.patchDispatch(
        row,
        {
          state: "failed",
          lease_expires_at: null,
          error_code: "CLOUD_PAYLOAD_UNAVAILABLE",
          error_message: "The dispatch payload is no longer available.",
        },
        now,
      );
      await this.releaseGate(failed);
      return failed;
    }
    this.ctx.storage.sql.exec(
      `UPDATE dispatches SET cloud_attempts = cloud_attempts + 1,
                             cloud_retry_at = NULL
        WHERE dispatch_id = ?`,
      row.dispatch_id,
    );
    const attempting = this.dispatchRow(row.dispatch_id) ?? row;
    try {
      return row.kind === "chat"
        ? await this.startCloudChat(attempting, payload, now)
        : await this.startCloudAgent(attempting, payload, now);
    } catch (error) {
      // Do not guess that an ambiguous transport failure means the cloud did
      // not start. The dispatch stays `cloud_committed`; its lease resolves
      // to `reconciliation_required` rather than to a second start.
      log("error", "dispatch_cloud_start_unresolved", {
        dispatchId: row.dispatch_id,
        kind: row.kind,
        message: error instanceof Error ? error.message : String(error),
      });
      return this.dispatchRow(row.dispatch_id) ?? row;
    }
  }

  /**
   * The cloud said no. A fence or shape refusal is the dispatch's own
   * terminal error, reported with the builder's code so the client sees the
   * same reason it would have seen submitting the turn directly. Only a 503
   * — the builder unavailable, not the request refused — is worth one retry.
   */
  private async cloudRefusal(
    row: DispatchRow,
    response: Response,
    now: number,
  ): Promise<DispatchRow> {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: unknown; message?: unknown };
    } | null;
    const code =
      typeof body?.error?.code === "string" ? body.error.code : "internal";
    const message =
      typeof body?.error?.message === "string"
        ? body.error.message
        : `The cloud refused this dispatch (${response.status}).`;
    if (
      response.status === 503 &&
      row.cloud_attempts < DISPATCH_CLOUD_MAX_ATTEMPTS
    ) {
      const retrying = await this.patchDispatch(
        row,
        {
          cloud_retry_at: now + DISPATCH_CLOUD_RETRY_DELAY_MS,
          lease_expires_at: now + DISPATCH_ACCEPTED_LEASE_MS,
          error_code: code,
          error_message: message,
        },
        now,
        { notifyExecutor: false },
      );
      await this.scheduleAlarm(now);
      return retrying;
    }
    const failed = await this.patchDispatch(
      row,
      {
        state: "failed",
        payload_json: null,
        payload_expires_at: null,
        lease_expires_at: null,
        error_code: code,
        error_message: message,
      },
      now,
    );
    await this.releaseGate(failed);
    return failed;
  }

  private async startCloudChat(
    row: DispatchRow,
    payload: DispatchPayload,
    now: number,
  ): Promise<DispatchRow> {
    // The DO name is the authenticated owner identity for this dispatch.
    // Begin only read-only gateway preparation before durable handoff work.
    this.prepareGatewayOwner();
    const sessions = this.env.ORCHESTRATOR_SESSIONS;
    if (!sessions)
      throw new Error("Orchestrator session namespace is not bound.");
    // Start the nonce-only cold wake alongside owner admission and home
    // preparation. It cannot authorize a request or mutate policy state.
    const preparedReader = this.prepareCloudChatReader(
      sessions,
      row.conversation_id,
    );
    const request: CloudTurnStartRequest = {
      protocol: TURN_PLANE_PROTOCOL,
      clientMsgId: row.dispatch_id,
      ...(payload.userMessageEventId ? { originUserMessageId: payload.userMessageEventId } : {}),
      prompt: payload.prompt,
      lane: "chat",
      source: row.ingress === "schedule" ? "schedule" : "placement",
      ...(payload.locale ? { locale: payload.locale } : {}),
      ...(payload.attachments ? { attachments: payload.attachments } : {}),
      ...(payload.execution ? { execution: payload.execution } : {}),
    };
    const handoffKey = cloudChatHandoffKey(row.dispatch_id);
    let handoff = await this.ctx.storage.get<CloudChatHandoff>(handoffKey);
    // Old unresolved dispatches may already have a conversation-created turn.
    // Only a new dispatch starts the owner-created identity protocol.
    if (!handoff && row.cloud_attempts === 1) {
      const allocating: CloudChatHandoff = { phase: "allocating", turnId: crypto.randomUUID(), leaseId: crypto.randomUUID() };
      await this.ctx.storage.transaction(async txn => {
        await txn.put(handoffKey, allocating);
        await txn.put(cloudChatTurnKey(allocating.turnId), row.dispatch_id);
      });
      handoff = allocating;
    }
    let preparation: CloudChatPreparation = {};
    if (handoff?.phase === "retired") return this.cloudRefusal(row,
      turnStartErrorResponse("owner_purged", "This cloud admission was retired.", false), now);
    if (handoff?.phase === "allocating") {
      const startedAt = performance.now();
      const result = await this.admitWithFenceLease({
        admission: { lane: "chat", turnId: handoff.turnId, conversationId: row.conversation_id, expectedGeneration: row.owner_generation },
        lease: { leaseId: handoff.leaseId, turnId: handoff.turnId, ownerGeneration: row.owner_generation,
          sessionId: sessions.idFromName(row.conversation_id).toString(), namespace: "orchestrator", role: "orchestrator" },
        includeHomeContext: true,
      });
      if (!result.admission.ok) return this.cloudRefusal(row, turnStartErrorResponse(
        result.admission.code, result.admission.message, result.admission.retryable, result.admission.retryAfterMs,
      ), now);
      this.ctx.storage.sql.exec("UPDATE dispatches SET gate_held = 1 WHERE dispatch_id = ?", row.dispatch_id);
      row.gate_held = 1;
      if (result.lease.status !== "registered") return this.cloudRefusal(row,
        turnStartErrorResponse("owner_purged", "This account's cloud admission is unavailable.", false), now);
      const authority: AdmittedCloudChat = {
        version: 1, ownerId: this.ownerId(), ownerGeneration: row.owner_generation,
        conversationId: row.conversation_id, clientMsgId: request.clientMsgId,
        turnId: handoff.turnId, leaseId: handoff.leaseId, fenceGeneration: result.lease.generation,
        admittedAt: Date.now(), snapshot: result.admission.snapshot,
        fingerprint: await sha256Hex(chatTurnFingerprintSource(this.ownerId(), row.conversation_id, request)),
      };
      if ("homeContext" in result && result.homeContext) {
        const preparedReaderId = await preparedReader;
        const reader = preparedReaderId
          ? { readerId: preparedReaderId }
          : await this.modelGrants().latestReader(row.conversation_id);
        if (reader) {
        authority.ownerModelGrant = await this.issueModelGrant({
          ownerId: authority.ownerId, ownerGeneration: authority.ownerGeneration,
          conversationId: authority.conversationId, readerId: reader.readerId,
          turnId: authority.turnId, leaseId: authority.leaseId, fenceGeneration: authority.fenceGeneration,
          policy: result.homeContext.memory.preference, expiresAt: result.lease.expiresAt,
        });
        }
      }
      handoff = { phase: "registered", authority };
      const latest = await this.ctx.storage.get<CloudChatHandoff>(handoffKey);
      if (latest?.phase === "retired") {
        await this.release({ turnId: authority.turnId });
        return this.cloudRefusal(row, turnStartErrorResponse("owner_purged", "This cloud admission was retired.", false), now);
      }
      await this.ctx.storage.put(handoffKey, handoff);
      preparation = {
        ...("homeContext" in result ? { homeContext: result.homeContext } : {}),
        ...("destinations" in result ? { destinations: result.destinations } : {}),
      };
      log("info", "owner_chat_admission_timing", { dispatchId: row.dispatch_id, turnId: authority.turnId,
        totalMs: Math.round(performance.now() - startedAt) });
    }
    if (handoff?.phase === "registered") {
      const current = this.dispatchRow(row.dispatch_id);
      if (!current || current.state !== "cloud_committed") {
        await this.retireCloudChatHandoff(handoff.authority);
        await this.releaseGate(this.dispatchRow(row.dispatch_id) ?? row);
        return this.dispatchRow(row.dispatch_id) ?? row;
      }
      // Stop can target the exact turn even while its admission RPC is in
      // flight, including before the conversation has imported the handoff.
      this.ctx.storage.sql.exec("UPDATE dispatches SET cloud_turn_id = ? WHERE dispatch_id = ?", handoff.authority.turnId, row.dispatch_id);
    }
    const response = handoff?.phase === "registered"
      ? await sessions.getByName(row.conversation_id).startAdmittedChat(request, handoff.authority, preparation)
      : await sessions
      .getByName(row.conversation_id)
      .fetch("https://orchestrator-session/turn", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-owner": this.ownerId(),
          [HEADER_TURN_AUTH_KIND]: "service",
          "x-stella-conversation-id": row.conversation_id,
          [TURN_OWNER_GENERATION_HEADER]: row.owner_generation,
        },
        body: JSON.stringify(request),
      });
    if (!response.ok) {
      // A definite refusal cannot own an executing turn. An uncertain 5xx
      // keeps the same registered identity for retry or purge reconciliation.
      if (handoff?.phase === "registered" && response.status >= 400 && response.status < 500) {
        await this.retireCloudChatHandoff(handoff.authority);
      }
      return await this.cloudRefusal(row, response, now);
    }
    const started = (await response.json()) as CloudTurnStartResponse;
    if (handoff?.phase === "registered" && started.turnId !== handoff.authority.turnId) throw new Error("Cloud admission response identity changed.");
    const current = this.dispatchRow(row.dispatch_id);
    if (current && current.state !== "cloud_committed") return current;
    return await this.patchDispatch(
      row,
      {
        state: "cloud_running",
        placement: "cloud",
        cloud_turn_id: started.turnId,
        cloud_retry_at: null,
        error_code: null,
        error_message: null,
        payload_json: null,
        payload_expires_at: null,
        lease_expires_at: null,
        started_at: now,
      },
      now,
    );
  }

  private async retireCloudChatHandoff(a: AdmittedCloudChat): Promise<void> {
    const sessions = this.env.ORCHESTRATOR_SESSIONS;
    if (!sessions) throw new Error("Orchestrator sessions unavailable.");
    const retired = await this.ownerFenceCall("unregister", {
      ownerId: a.ownerId, ownerGeneration: a.ownerGeneration, leaseId: a.leaseId,
      turnId: a.turnId, sessionId: sessions.idFromName(a.conversationId).toString(), generation: a.fenceGeneration,
    });
    if (!retired.ok) throw new Error("Cloud admission retirement is pending.");
    await this.modelGrants().retireExactTurnLease({
      ownerGeneration: a.ownerGeneration,
      conversationId: a.conversationId,
      turnId: a.turnId,
      leaseId: a.leaseId,
    });
    await this.ctx.storage.put(cloudChatHandoffKey(a.clientMsgId), { phase: "retired", turnId: a.turnId, leaseId: a.leaseId } satisfies CloudChatHandoff);
  }

  private async startCloudAgent(
    row: DispatchRow,
    payload: DispatchPayload,
    now: number,
  ): Promise<DispatchRow> {
    const sessions = this.env.BUILD_SESSIONS;
    if (!sessions) throw new Error("Build session namespace is not bound.");
    const snapshot = await this.snapshot({ now });
    // A fresh thread per placed agent: the gate cannot read a durable
    // thread's attempt generation, and guessing one would resume the wrong
    // attempt.
    const threadId = `thr-${crypto.randomUUID().slice(0, 18)}`;
    const request: CloudAgentTurnStartRequest = {
      protocol: TURN_PLANE_PROTOCOL,
      kind: "agent",
      ownerId: this.ownerId(),
      ownerGeneration: row.owner_generation,
      conversationId: row.conversation_id,
      threadId,
      agentDepth: 1,
      attemptGeneration: 1,
      // The session adopts the dispatch id as its turn id, so the release it
      // sends on the terminal path frees exactly the slot this gate admitted.
      turnId: row.dispatch_id,
      prompt: payload.prompt,
      description: payload.description ?? "Placed agent run",
      execution: payload.execution ?? snapshot.execution,
      audience: snapshot.allowance.audience,
      budgetMicroCents: snapshot.allowance.budgetMicroCents,
      source: "placement",
      clientMsgId: row.dispatch_id,
      ...(row.parent_turn_id ? { parentTurnId: row.parent_turn_id } : {}),
    };
    const response = await sessions
      .getByName(threadId)
      .fetch("https://build-session/turn", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The gate admitted this attempt already and owns its release.
          [HEADER_GATE_ADMITTED]: "1",
        },
        body: JSON.stringify(request),
      });
    if (!response.ok) return await this.cloudRefusal(row, response, now);
    const started = (await response.json()) as CloudAgentTurnStartResponse;
    return await this.patchDispatch(
      row,
      {
        state: "cloud_running",
        placement: "cloud",
        cloud_turn_id: started.turnId ?? row.dispatch_id,
        cloud_retry_at: null,
        error_code: null,
        error_message: null,
        cloud_thread_id: started.threadId ?? threadId,
        payload_json: null,
        payload_expires_at: null,
        lease_expires_at: null,
        started_at: now,
      },
      now,
    );
  }

  // ── Submit, status, cancel ────────────────────────────────────────────

  /**
   * The owner checks a dispatch needs even when it takes no admission: the
   * write fence and the generation the caller pinned. Same verdicts `admit`
   * would have produced, without consuming a start or a slot.
   */
  private async submitSnapshot(
    expectedGeneration: string | undefined,
    now: number,
  ): Promise<
    | { ok: true; snapshot: OwnerSnapshot }
    | { ok: false; error: DispatchError["error"] }
  > {
    let snapshot: OwnerSnapshot;
    try {
      snapshot = await this.snapshot({ now });
      if (
        expectedGeneration &&
        expectedGeneration !== snapshot.ownerGeneration
      ) {
        // The cache can lag a rotation whose push was lost. One forced
        // refresh separates "stale cache" from "stale caller".
        snapshot = await this.snapshot({ refresh: true, now });
      }
    } catch (error) {
      const purged =
        error instanceof OwnerGateSnapshotError &&
        error.code === "owner_purged";
      log("error", "dispatch_snapshot_unavailable", {
        ownerId: this.ownerId(),
        message: error instanceof Error ? error.message : String(error),
      });
      return purged
        ? fail(
            "owner_purged",
            "This account's cloud data is no longer available.",
            false,
          )
        : fail(
            "internal",
            "Stella can't check your plan right now. Try again shortly.",
            true,
          );
    }
    if (expectedGeneration && expectedGeneration !== snapshot.ownerGeneration) {
      return fail(
        "generation_stale",
        "This cloud owner generation is no longer current.",
        false,
      );
    }
    if (snapshot.enforcement?.status === "suspended") {
      return fail(
        "owner_suspended",
        "This account can't use Stella's cloud right now.",
        false,
      );
    }
    if (!snapshot.writable) {
      return fail(
        "owner_purged",
        "This account's cloud data is being reset or deleted.",
        false,
      );
    }
    return { ok: true, snapshot };
  }

  /**
   * Admit a dispatch and route it. The Worker has already authenticated the
   * caller and (for mobile) verified its pairing proof; everything from the
   * idempotency check down is decided here, from this object's own state.
   */
  async submit(input: OwnerGateSubmitInput): Promise<OwnerGateDispatchResult> {
    const receivedAt = Date.now();
    const startedAt = performance.now();
    this.ensureSchema();
    const now = input.now ?? Date.now();
    const request = input.request;
    const payloadJson = canonicalDispatchPayloadJson(request.payload);
    if (
      new TextEncoder().encode(payloadJson).byteLength >
      MAX_DISPATCH_PAYLOAD_BYTES
    ) {
      return fail(
        "bad_request",
        "Dispatch payload exceeds the durable payload limit.",
        false,
      );
    }
    const payloadHash = await sha256Hex(payloadJson);
    const targetMode = request.targetMode ?? "automatic";
    const requestingDeviceId = request.requestingDeviceId?.trim() || undefined;
    const pairGrantDeviceId = input.pairGrantDeviceId?.trim() || undefined;
    const requiredCapabilities = [...request.requiredCapabilities];
    // Every routing fact a replay must match. A different one under the same
    // key is a different request wearing its name.
    const fingerprint = JSON.stringify([
      request.kind,
      request.ingress,
      request.subject,
      targetMode,
      request.targetDeviceId ?? "",
      request.conversationId,
      request.parentTurnId ?? "",
      request.threadId ?? "",
      requestingDeviceId ?? "",
      pairGrantDeviceId ?? "",
      requiredCapabilities,
      payloadHash,
    ]);
    const existing = this.ctx.storage.sql
      .exec<DispatchRow>(
        `SELECT * FROM dispatches WHERE idempotency_key = ?`,
        request.idempotencyKey,
      )
      .toArray()[0];
    if (existing) {
      if (existing.routing_fingerprint !== fingerprint) {
        return fail(
          "conflict",
          "This idempotency key was already used for different execution bytes or routing metadata.",
          false,
        );
      }
      return {
        ok: true,
        response: {
          protocol: PLACEMENT_PROTOCOL,
          dispatch: dispatchSummary(existing),
          replayed: true,
        },
      };
    }
    const dispatchId = `dsp:${crypto.randomUUID()}`;
    // A chat dispatch is never admitted here. Wherever it ends up, exactly
    // one admission governs it: the conversation object's own, when the
    // cloud branch starts the turn — and a run that lands on the owner's own
    // computer costs the cloud windows nothing at all, which is what the
    // implementation this replaces did too. An agent dispatch is the
    // opposite: this gate admits it under the dispatch id and the build
    // session consumes that admission rather than taking a second one.
    let snapshot: OwnerSnapshot;
    let gateHeld = false;
    if (request.kind === "agent") {
      const admission = await this.admit({
        lane: "agent",
        turnId: dispatchId,
        conversationId: request.conversationId,
        ...(input.expectedGeneration
          ? { expectedGeneration: input.expectedGeneration }
          : {}),
        now,
      });
      if (!admission.ok) {
        return fail(
          admission.code,
          admission.message,
          admission.retryable,
          admission.retryAfterMs,
        );
      }
      snapshot = admission.snapshot;
      gateHeld = true;
    } else {
      const resolved = await this.submitSnapshot(input.expectedGeneration, now);
      if (!resolved.ok) return resolved;
      snapshot = resolved.snapshot;
    }
    const refuse = async (
      code: DispatchError["error"]["code"],
      message: string,
    ): Promise<OwnerGateDispatchResult> => {
      if (gateHeld) await this.release({ turnId: dispatchId });
      return fail(code, message, false);
    };
    const decision = decideDispatchPlacement({
      ingress: request.ingress,
      subject: request.subject,
      targetMode,
    });
    let candidates: DevicePresenceState[] = [];
    if (decision.kind === "offer") {
      if (
        request.ingress === "mobile" &&
        Boolean(requestingDeviceId) !== Boolean(pairGrantDeviceId)
      ) {
        return await refuse(
          "bad_request",
          "Mobile execution admission requires both sides of a verified desktop pairing.",
        );
      }
      if (
        targetMode === "device" &&
        request.ingress === "mobile" &&
        request.targetDeviceId !== pairGrantDeviceId
      ) {
        return await refuse(
          "forbidden",
          "The selected computer does not match the verified pairing.",
        );
      }
      candidates = this.eligibleDevices({
        snapshot,
        deviceIds: this.offerCandidateIds(
          {
            ingress: request.ingress,
            requesting_device_id: requestingDeviceId ?? null,
            pair_grant_device_id: pairGrantDeviceId ?? null,
            requested_target_mode: targetMode,
            requested_executor_device_id: request.targetDeviceId ?? null,
          },
          snapshot,
        ),
        kind: request.kind,
        requiredCapabilities,
        now,
      });
    }
    if (
      decision.kind === "commit" &&
      decision.placement === "computer" &&
      !requestingDeviceId
    ) {
      return await refuse(
        "bad_request",
        "A desktop dispatch must name the device that will run it.",
      );
    }

    let state: DispatchState;
    let placement: "computer" | "cloud" | null = null;
    let executorDeviceId: string | null = null;
    let executorSessionId: string | null = null;
    let onNoEligibleComputer: "cloud" | "blocked" =
      request.subject === "computer" ? "blocked" : "cloud";
    let fallbackReason: string | null = null;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let offerDeadlineAt: number | null = null;
    let leaseExpiresAt: number | null = null;

    if (decision.kind === "commit") {
      placement = decision.placement;
      fallbackReason = decision.reason;
      if (decision.placement === "cloud") {
        state = "cloud_committed";
        leaseExpiresAt = now + DISPATCH_ACCEPTED_LEASE_MS;
      } else {
        state = "computer_accepted";
        executorDeviceId = requestingDeviceId!;
        executorSessionId =
          this.presenceRow(requestingDeviceId!)?.presenceSessionId ?? null;
        leaseExpiresAt = now + DISPATCH_ACCEPTED_LEASE_MS;
      }
    } else if (decision.kind === "blocked") {
      state = "blocked";
      onNoEligibleComputer = "blocked";
      fallbackReason = decision.reason;
      errorCode = "COMPUTER_REQUIRED_UNAVAILABLE";
      errorMessage =
        "This work requires a computer, but this execution surface cannot safely provide one.";
    } else {
      onNoEligibleComputer = decision.onNoEligibleComputer;
      if (candidates.length > 0) {
        state = "offering";
        fallbackReason = decision.reason;
        offerDeadlineAt = now + DISPATCH_OFFER_WINDOW_MS;
      } else if (decision.onNoEligibleComputer === "cloud") {
        state = "cloud_committed";
        placement = "cloud";
        fallbackReason = "no-eligible-paired-computer";
        leaseExpiresAt = now + DISPATCH_ACCEPTED_LEASE_MS;
      } else {
        state = "blocked";
        const explicitDevice = targetMode === "device";
        const refusal = explicitDevice
          ? this.selectedDeviceRefusal({
              deviceId: request.targetDeviceId ?? null,
              now,
            })
          : null;
        fallbackReason = refusal
          ? refusal.fallbackReason
          : explicitDevice
            ? "selected-device-unavailable"
            : "no-eligible-paired-computer";
        errorCode = refusal
          ? refusal.errorCode
          : explicitDevice
            ? "SELECTED_DEVICE_UNAVAILABLE"
            : "COMPUTER_REQUIRED_UNAVAILABLE";
        errorMessage = refusal
          ? refusal.errorMessage
          : explicitDevice
            ? "The selected computer is online but isn't accepting work right now. It may still be starting up, be signed out, have cloud sync off, or not allow work from other devices."
            : "This work requires your paired computer, but no eligible computer is reachable.";
      }
    }

    const terminal = state === "blocked";
    // The payload is deleted the moment a computer durably accepts it: after
    // that the desktop's own inbox is the only copy and this object must
    // never be able to serve it a second time.
    const keepsPayload = !terminal && state !== "computer_accepted";
    this.ctx.storage.sql.exec(
      `INSERT INTO dispatches (
         dispatch_id, idempotency_key, owner_generation, kind, ingress, subject,
         requested_target_mode, requested_executor_device_id, conversation_id,
         parent_turn_id, thread_id, requesting_device_id, pair_grant_device_id,
         required_capabilities, routing_fingerprint, state, placement,
         executor_device_id, executor_presence_session_id,
         on_no_eligible_computer, revision, fallback_reason, cancel_request_id,
         cancel_reason, error_code, error_message, cloud_turn_id,
         cloud_thread_id, payload_json, payload_hash, payload_expires_at,
         offer_deadline_at, lease_expires_at, started_at, gate_held,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 1, ?, NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      dispatchId,
      request.idempotencyKey,
      snapshot.ownerGeneration,
      request.kind,
      request.ingress,
      request.subject,
      targetMode,
      request.targetDeviceId ?? null,
      request.conversationId,
      request.parentTurnId ?? null,
      request.threadId ?? null,
      requestingDeviceId ?? null,
      pairGrantDeviceId ?? null,
      JSON.stringify(requiredCapabilities),
      fingerprint,
      state,
      placement,
      executorDeviceId,
      executorSessionId,
      onNoEligibleComputer,
      fallbackReason,
      errorCode,
      errorMessage,
      keepsPayload ? payloadJson : null,
      payloadHash,
      keepsPayload ? now + DISPATCH_PAYLOAD_TTL_MS : null,
      offerDeadlineAt,
      leaseExpiresAt,
      gateHeld && !terminal ? 1 : 0,
      now,
      now,
    );
    let row = this.dispatchRow(dispatchId)!;
    if (terminal) {
      if (gateHeld) await this.release({ turnId: dispatchId });
    } else if (state === "computer_accepted" && executorDeviceId) {
      this.notifyExecutor(row);
    } else if (state === "offering" && offerDeadlineAt !== null) {
      for (const candidate of candidates) {
        this.openOffer(dispatchId, candidate, offerDeadlineAt, now);
        this.pushOffer(row, candidate.deviceId, offerDeadlineAt);
      }
    } else if (state === "cloud_committed") {
      log("info", "dispatch_cloud_route_timing", {
        dispatchId, originUserMessageId: request.payload.userMessageEventId,
        receivedAt, conversationDispatchAt: Date.now(),
        preparationMs: Math.round(performance.now() - startedAt),
      });
      row = await this.runCloudBranch(row, now);
    }
    await this.scheduleAlarm(now);
    return {
      ok: true,
      response: {
        protocol: PLACEMENT_PROTOCOL,
        dispatch: dispatchSummary(row),
        replayed: false,
      },
    };
  }

  /** Queue delivery may race the admission response. Retain the exact turn
   * receipt so the next status read can reconcile either delivery order. */
  async recordCloudDispatchTerminal(input: {
    ownerGeneration: string; turnId: string;
    outcome: "completed" | "failed" | "canceled";
    resultJson?: string; errorMessage?: string;
  }): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO cloud_dispatch_terminals
       (turn_id, owner_generation, outcome, result_json, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.turnId, input.ownerGeneration, input.outcome,
      input.resultJson ?? null, input.errorMessage ?? null, Date.now(),
    );
    const dispatch = this.ctx.storage.sql.exec<{ dispatch_id: string }>(
      `SELECT dispatch_id FROM dispatches
       WHERE cloud_turn_id = ? AND owner_generation = ? AND placement = 'cloud'`,
      input.turnId, input.ownerGeneration,
    ).toArray()[0];
    if (dispatch) await this.dispatchStatus(dispatch.dispatch_id);
  }

  async dispatchStatus(dispatchId: string): Promise<OwnerGateStatusResult> {
    this.ensureSchema();
    let row = this.dispatchRow(dispatchId.trim());
    if (!row) return fail("not_found", "Dispatch not found.", false);
    const receipt = row.placement === "cloud" && row.cloud_turn_id
      ? this.ctx.storage.sql.exec<{
          outcome: "completed" | "failed" | "canceled";
          result_json: string | null; error_message: string | null;
        }>(
          `SELECT outcome, result_json, error_message FROM cloud_dispatch_terminals
           WHERE turn_id = ? AND owner_generation = ?`,
          row.cloud_turn_id, row.owner_generation,
        ).toArray()[0]
      : undefined;
    if (receipt && !isTerminalDispatchState(row.state as DispatchState)) {
      row = await this.patchDispatch(row, {
        state: receipt.outcome,
        error_message: receipt.error_message,
        payload_json: null, payload_expires_at: null, lease_expires_at: null,
      }, Date.now());
      await this.releaseGate(row);
      await this.scheduleAlarm(Date.now());
    }
    return {
      ok: true,
      response: {
        protocol: PLACEMENT_PROTOCOL,
        dispatch: {
          ...dispatchSummary(row),
          ...(receipt?.result_json ? { resultJson: receipt.result_json } : {}),
        },
      },
    };
  }

  /**
   * Stop, from the owner's side. Work a computer has not durably accepted is
   * canceled outright; work that is running somewhere becomes
   * `cancel_pending` and is settled by the terminal the executing side sends.
   */
  /**
   * Hand new input to an agent a device accepted and is running, and wait
   * for the device to say whether the agent took it. `unreachable` means no
   * live socket for that device; `not_running` that the run already ended.
   */
  async steerDispatch(input: {
    dispatchId: string;
    messageId: string;
    text: string;
  }): Promise<{ delivered: boolean; reason?: "not_running" | "unreachable" }> {
    this.ensureSchema();
    const row = this.dispatchRow(input.dispatchId.trim());
    if (
      !row ||
      row.kind !== "agent" ||
      !row.executor_device_id ||
      (row.state !== "computer_accepted" && row.state !== "computer_running")
    ) {
      return { delivered: false, reason: "not_running" };
    }
    const socket = this.connectedSocket(row.executor_device_id);
    if (!socket) return { delivered: false, reason: "unreachable" };
    const key = `${row.dispatch_id}:${input.messageId}`;
    const acknowledged = withTimeout(
      new Promise<boolean>((resolve) => {
        this.steerAcks.set(key, (delivered) => {
          this.steerAcks.delete(key);
          resolve(delivered);
        });
      }),
      STEER_ACK_TIMEOUT_MS,
      "steer acknowledgement timed out",
    ).catch(() => {
      this.steerAcks.delete(key);
      return false;
    });
    this.send(socket, {
      type: "steer",
      dispatchId: row.dispatch_id,
      messageId: input.messageId,
      text: input.text,
    });
    return (await acknowledged)
      ? { delivered: true }
      : { delivered: false, reason: "not_running" };
  }

  async cancelDispatch(
    input: OwnerGateCancelInput,
  ): Promise<OwnerGateStatusResult> {
    this.ensureSchema();
    const now = input.now ?? Date.now();
    const row = this.dispatchRow(input.dispatchId.trim());
    if (!row) return fail("not_found", "Dispatch not found.", false);
    const cancelRequestId = input.cancelRequestId.trim().slice(0, 128);
    if (!cancelRequestId) {
      return fail("bad_request", "cancelRequestId is required.", false);
    }
    if (row.cancel_request_id && row.cancel_request_id !== cancelRequestId) {
      return fail(
        "conflict",
        "A different cancellation request already owns this dispatch.",
        false,
      );
    }
    if (isTerminalDispatchState(row.state as DispatchState)) {
      return {
        ok: true,
        response: {
          protocol: PLACEMENT_PROTOCOL,
          dispatch: dispatchSummary(row),
        },
      };
    }
    const reason = input.reason?.trim().slice(0, 512) ?? "";
    const unaccepted =
      row.state === "offering" || row.state === "computer_claimed";
    const cloudNeverStarted =
      row.state === "cloud_committed" && !row.cloud_turn_id;
    this.withdrawOffers(row.dispatch_id, null, "canceled", now);
    const next = await this.patchDispatch(
      row,
      {
        state: unaccepted || cloudNeverStarted ? "canceled" : "cancel_pending",
        cancel_request_id: cancelRequestId,
        ...(reason ? { cancel_reason: reason } : {}),
        ...(unaccepted || cloudNeverStarted
          ? {
              payload_json: null,
              payload_expires_at: null,
              offer_deadline_at: null,
              lease_expires_at: null,
              executor_device_id: null,
              executor_presence_session_id: null,
            }
          : {}),
      },
      now,
      { notifyExecutor: false },
    );
    if (unaccepted || cloudNeverStarted) {
      await this.releaseGate(next);
    } else if (next.placement === "computer" && next.executor_device_id) {
      const socket = this.connectedSocket(next.executor_device_id);
      if (socket) {
        this.send(socket, {
          type: "cancel",
          dispatchId: next.dispatch_id,
          cancelRequestId,
          reason: reason || "The turn was stopped.",
        });
      }
    } else if (next.placement === "cloud" && next.cloud_turn_id) {
      await this.cancelCloudDispatch(next, cancelRequestId, reason);
    }
    await this.scheduleAlarm(now);
    return {
      ok: true,
      response: {
        protocol: PLACEMENT_PROTOCOL,
        dispatch: dispatchSummary(next),
      },
    };
  }

  private async cancelCloudDispatch(
    row: DispatchRow,
    cancelRequestId: string,
    reason: string,
  ): Promise<void> {
    const body = {
      turnId: row.cloud_turn_id,
      cancelRequestId,
      ownerId: this.ownerId(),
      ownerGeneration: row.owner_generation,
      ...(row.kind === "agent" ? { attemptGeneration: 1 } : {}),
      ...(reason ? { reason } : {}),
    };
    try {
      if (row.kind === "chat") {
        await this.env.ORCHESTRATOR_SESSIONS?.getByName(
          row.conversation_id,
        ).fetch("https://orchestrator-session/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } else if (row.cloud_thread_id) {
        await this.env.BUILD_SESSIONS?.getByName(row.cloud_thread_id).fetch(
          "https://build-session/cancel",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
      }
    } catch (error) {
      // The dispatch stays `cancel_pending`; the executing side's terminal
      // still settles it, and the operator sees why the stop did not land.
      log("error", "dispatch_cloud_cancel_failed", {
        dispatchId: row.dispatch_id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Executor frames ───────────────────────────────────────────────────

  private async handleExecutorFrame(
    socket: WebSocket,
    attachment: PresenceAttachment,
    frame: DevicePresenceDeviceFrame,
    now: number,
  ): Promise<void> {
    const dispatchId =
      "dispatchId" in frame && typeof frame.dispatchId === "string"
        ? frame.dispatchId.trim()
        : "";
    if (!dispatchId) {
      this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
      return;
    }
    const row = this.dispatchRow(dispatchId);
    if (!row) {
      this.send(socket, {
        type: "error",
        code: "not_found",
        message: "Dispatch not found.",
        retryable: false,
      });
      return;
    }
    const deny = (code: string, message: string) =>
      this.send(socket, { type: "error", code, message, retryable: false });
    if (frame.type === "steer.ack") {
      if (row.executor_device_id === attachment.deviceId) {
        this.steerAcks.get(`${dispatchId}:${frame.messageId}`)?.(
          frame.delivered === true,
        );
      }
      return;
    }
    if (frame.type === "claim") {
      await this.handleClaim(socket, attachment, row, frame, now);
      return;
    }
    // Everything past a claim is bound to the exact proven session that holds
    // it: a second device, or the same device after a reconnect, cannot move
    // work it does not own.
    if (
      row.executor_device_id !== attachment.deviceId ||
      row.executor_presence_session_id !== attachment.presenceSessionId
    ) {
      deny("forbidden", "This runtime session does not own the dispatch.");
      return;
    }
    if (frame.type === "release") {
      if (row.state !== "computer_claimed") {
        deny(
          "conflict",
          "A durably accepted execution cannot be released or rerouted.",
        );
        return;
      }
      const released = await this.patchDispatch(
        row,
        {
          state: "offering",
          executor_device_id: null,
          executor_presence_session_id: null,
          lease_expires_at: null,
        },
        now,
        { notifyExecutor: false },
      );
      // Its own offer is spent, and a claim already withdrew everyone else's,
      // so the dispatch takes the fallback the policy chose rather than
      // re-offering the work to the computer that just declined it.
      this.ctx.storage.sql.exec(
        `UPDATE dispatch_offers SET status = 'withdrawn', updated_at = ?
          WHERE dispatch_id = ? AND device_id = ?`,
        now,
        released.dispatch_id,
        attachment.deviceId,
      );
      await this.resolveUnaccepted(
        released,
        now,
        `computer-claim-released:${(frame.reason ?? "").slice(0, 160)}`,
      );
      return;
    }
    if (frame.type === "ack") {
      if (
        row.state === "computer_accepted" ||
        row.state === "computer_running" ||
        row.state === "reconciliation_required"
      ) {
        return;
      }
      if (
        row.state !== "computer_claimed" ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= now
      ) {
        deny("conflict", "Claim expired before durable local acceptance.");
        return;
      }
      await this.patchDispatch(
        row,
        {
          state: "computer_accepted",
          placement: "computer",
          // The desktop's local inbox is now the only copy.
          payload_json: null,
          payload_expires_at: null,
          lease_expires_at: now + DISPATCH_ACCEPTED_LEASE_MS,
        },
        now,
      );
      return;
    }
    if (frame.type === "running") {
      if (
        row.state !== "computer_accepted" &&
        row.state !== "computer_running" &&
        row.state !== "reconciliation_required"
      ) {
        deny("conflict", "Only an accepted computer execution can start.");
        return;
      }
      await this.patchDispatch(
        row,
        {
          state: "computer_running",
          started_at: row.started_at ?? now,
          lease_expires_at: now + DISPATCH_ACCEPTED_LEASE_MS,
        },
        now,
      );
      return;
    }
    if (frame.type === "renew") {
      if (
        row.state !== "computer_accepted" &&
        row.state !== "computer_running" &&
        row.state !== "cancel_pending" &&
        row.state !== "reconciliation_required"
      ) {
        deny("conflict", "Execution is not renewable.");
        return;
      }
      await this.patchDispatch(
        row,
        {
          state:
            row.state === "reconciliation_required"
              ? row.started_at
                ? "computer_running"
                : "computer_accepted"
              : row.state,
          lease_expires_at: now + DISPATCH_ACCEPTED_LEASE_MS,
        },
        now,
      );
      return;
    }
    if (frame.type === "complete") {
      const outcome = frame.outcome;
      if (
        outcome !== "completed" &&
        outcome !== "failed" &&
        outcome !== "canceled"
      ) {
        deny("bad_request", "A completion needs a terminal outcome.");
        return;
      }
      if (isTerminalDispatchState(row.state as DispatchState)) {
        this.notifyExecutor(row);
        return;
      }
      if (
        row.state !== "computer_accepted" &&
        row.state !== "computer_running" &&
        row.state !== "cancel_pending" &&
        row.state !== "reconciliation_required"
      ) {
        deny(
          "conflict",
          "Execution is not owned by an accepted computer claim.",
        );
        return;
      }
      const terminal = await this.patchDispatch(
        row,
        {
          state: outcome,
          result_json: typeof frame.resultJson === "string" ? frame.resultJson : null,
          payload_json: null,
          payload_expires_at: null,
          lease_expires_at: null,
          ...(frame.errorCode
            ? { error_code: frame.errorCode.slice(0, 128) }
            : {}),
          ...(frame.errorMessage
            ? { error_message: frame.errorMessage.slice(0, 1024) }
            : {}),
        },
        now,
      );
      await this.releaseGate(terminal);
      await this.scheduleAlarm(now);
      return;
    }
    this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
  }

  private async handleClaim(
    socket: WebSocket,
    attachment: PresenceAttachment,
    row: DispatchRow,
    frame: Extract<DevicePresenceDeviceFrame, { type: "claim" }>,
    now: number,
  ): Promise<void> {
    const claimRequestId =
      typeof frame.claimRequestId === "string"
        ? frame.claimRequestId.trim().slice(0, 128)
        : "";
    if (!claimRequestId) {
      this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
      return;
    }
    const sameClaim =
      row.state === "computer_claimed" &&
      row.executor_device_id === attachment.deviceId &&
      row.executor_presence_session_id === attachment.presenceSessionId &&
      row.cancel_request_id === null;
    if (sameClaim) {
      this.send(socket, {
        type: "claimed",
        dispatchId: row.dispatch_id,
        claimExpiresAt: row.lease_expires_at ?? now,
        replayed: true,
      });
      return;
    }
    if (
      row.state !== "offering" ||
      row.offer_deadline_at === null ||
      row.offer_deadline_at <= now
    ) {
      this.send(socket, {
        type: "error",
        code: "conflict",
        message: "Execution offer is no longer claimable.",
        retryable: false,
      });
      return;
    }
    const offered = this.openOffers(row.dispatch_id).some(
      (offer) =>
        offer.device_id === attachment.deviceId &&
        offer.presence_session_id === attachment.presenceSessionId,
    );
    if (!offered) {
      this.send(socket, {
        type: "error",
        code: "forbidden",
        message: "This runtime session was not offered the execution.",
        retryable: false,
      });
      return;
    }
    const snapshot = await this.snapshot({ now });
    const required = JSON.parse(
      row.required_capabilities,
    ) as ExecutionCapability[];
    const eligible = this.eligibleDevices({
      snapshot,
      deviceIds: [attachment.deviceId],
      kind: row.kind as ExecutionKind,
      requiredCapabilities: required,
      now,
    });
    if (eligible.length === 0) {
      this.send(socket, {
        type: "error",
        code: "conflict",
        message: "This runtime is no longer eligible for the execution.",
        retryable: false,
      });
      return;
    }
    this.ctx.storage.sql.exec(
      `UPDATE dispatch_offers SET status = 'claimed', updated_at = ?
        WHERE dispatch_id = ? AND device_id = ?`,
      now,
      row.dispatch_id,
      attachment.deviceId,
    );
    this.withdrawOffers(row.dispatch_id, attachment.deviceId, "claimed", now);
    const claimExpiresAt = now + DISPATCH_CLAIM_LEASE_MS;
    await this.patchDispatch(
      row,
      {
        state: "computer_claimed",
        executor_device_id: attachment.deviceId,
        executor_presence_session_id: attachment.presenceSessionId ?? "",
        lease_expires_at: claimExpiresAt,
      },
      now,
      { notifyExecutor: false },
    );
    this.send(socket, {
      type: "claimed",
      dispatchId: row.dispatch_id,
      claimExpiresAt,
      replayed: false,
    });
    await this.scheduleAlarm(now);
  }

  // ── Alarms ────────────────────────────────────────────────────────────

  private async scheduleAlarm(
    now: number,
    options: {
      fenceDeadline?: number | null;
      preserveExisting?: boolean;
    } = {},
  ): Promise<void> {
    this.ensureSchema();
    let next = options.fenceDeadline ?? Number.POSITIVE_INFINITY;
    if (await this.memoryPolicy().pending() || await this.modelGrants().pendingFenceBarrier())
      next = Math.min(next, now + 5_000);
    next = Math.min(next, this.ownerStore().nextDeadline());
    for (const socket of this.sockets()) {
      const attachment = this.attachment(socket);
      if (!attachment) continue;
      next = Math.min(
        next,
        attachment.lastSeenAtMs + DEVICE_PRESENCE_STALE_AFTER_MS,
        attachment.authExpiresAtMs,
      );
    }
    const deadline = this.ctx.storage.sql
      .exec<{ at: number | null }>(
        `SELECT MIN(at) AS at FROM (
           SELECT offer_deadline_at AS at FROM dispatches
             WHERE state = 'offering' AND offer_deadline_at IS NOT NULL
           UNION ALL
           SELECT lease_expires_at AS at FROM dispatches
             WHERE lease_expires_at IS NOT NULL
               AND state IN ('computer_claimed', 'computer_accepted',
                             'computer_running', 'cloud_committed',
                             'cancel_pending')
           UNION ALL
           SELECT cloud_retry_at AS at FROM dispatches
             WHERE state = 'cloud_committed' AND cloud_retry_at IS NOT NULL
           UNION ALL
           SELECT payload_expires_at AS at FROM dispatches
             WHERE payload_json IS NOT NULL AND payload_expires_at IS NOT NULL
         )`,
      )
      .toArray()[0]?.at;
    if (typeof deadline === "number") next = Math.min(next, deadline);
    if (options.preserveExisting !== false) {
      const existingAlarm = await this.ctx.storage.getAlarm();
      if (existingAlarm !== null) next = Math.min(next, existingAlarm);
    }
    if (!Number.isFinite(next)) return;
    try {
      await this.ctx.storage.setAlarm(Math.max(now + 250, next));
    } catch {
      // Alarms are unavailable in some test harnesses; leases still expire on
      // the next call that reads them.
    }
  }

  async alarm(): Promise<void> {
    this.ensureSchema();
    const now = Date.now();
    const ownerFenceHost = createOwnerFenceHost({
      ctx: this.ctx,
      env: this.env,
    });
    let fenceDeadline: number | null = null;
    let fenceAlarmCompleted = false;
    try {
      const pendingFence = await this.modelGrants().pendingFenceBarrier();
      if (pendingFence) {
        await this.fetchOwnerFence(pendingFence.path, ownerFenceRequest(pendingFence.path, pendingFence.body), pendingFence.body).catch((error: unknown) => {
          log("error", "owner_grant_fence_retry_pending", { message: error instanceof Error ? error.message : "Owner fence replay failed." });
        });
      }
      fenceDeadline = await ownerFenceHost.alarm(now);
      fenceAlarmCompleted = true;
      await this.expirePresence(now);
      await this.expireDispatches(now);
      await this.ownerStore().onAlarm(now);
      await this.memoryPolicy().retry().catch((error: unknown) => {
        log("error", "memory_policy_retry_pending", {
          message: error instanceof Error ? error.message : "Memory policy retry failed.",
        });
      });
    } finally {
      if (!fenceAlarmCompleted) {
        fenceDeadline = await ownerFenceHost.nextDeadline();
      }
      await this.scheduleAlarm(now, {
        fenceDeadline,
        preserveExisting: false,
      });
    }
  }

  private async expirePresence(now: number): Promise<void> {
    for (const socket of this.sockets()) {
      const attachment = this.attachment(socket);
      if (!attachment) continue;
      if (attachment.authExpiresAtMs <= now) {
        await this.dropSocket(
          socket,
          attachment,
          DEVICE_PRESENCE_CLOSE.stale,
          "stale",
          now,
        );
        continue;
      }
      if (attachment.lastSeenAtMs + DEVICE_PRESENCE_STALE_AFTER_MS <= now) {
        await this.dropSocket(
          socket,
          attachment,
          DEVICE_PRESENCE_CLOSE.stale,
          "stale",
          now,
        );
      }
    }
  }

  /**
   * Leases, in one pass. An accepted or running computer dispatch whose lease
   * lapses becomes `reconciliation_required` and stays there: rerouting work
   * a computer has taken durable ownership of would run it twice.
   */
  private async expireDispatches(now: number): Promise<void> {
    const expired = this.ctx.storage.sql
      .exec<DispatchRow>(
        `SELECT * FROM dispatches
          WHERE (state = 'offering' AND offer_deadline_at IS NOT NULL
                 AND offer_deadline_at <= ?)
             OR (state = 'cloud_committed' AND cloud_retry_at IS NOT NULL
                 AND cloud_retry_at <= ?)
             OR (state IN ('computer_claimed', 'computer_accepted',
                           'computer_running', 'cloud_committed',
                           'cancel_pending')
                 AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             OR (payload_json IS NOT NULL AND payload_expires_at IS NOT NULL
                 AND payload_expires_at <= ?)
          ORDER BY updated_at ASC
          LIMIT 64`,
        now,
        now,
        now,
        now,
      )
      .toArray();
    for (const row of expired) {
      const offerLapsed =
        row.state === "offering" &&
        row.offer_deadline_at !== null &&
        row.offer_deadline_at <= now;
      const leaseLapsed =
        row.lease_expires_at !== null && row.lease_expires_at <= now;
      if (offerLapsed) {
        await this.resolveUnaccepted(
          row,
          now,
          "computer-offer-expired-unaccepted",
        );
        continue;
      }
      // A start the builder refused as unavailable, retried once. This is the
      // one case where `cloud_committed` is known not to have started, so
      // replaying it cannot double-run a turn.
      if (
        row.state === "cloud_committed" &&
        row.cloud_retry_at !== null &&
        row.cloud_retry_at <= now
      ) {
        await this.runCloudBranch(row, now);
        continue;
      }
      if (row.state === "computer_claimed" && leaseLapsed) {
        await this.resolveUnaccepted(row, now, "computer-claim-expired");
        continue;
      }
      if (
        leaseLapsed &&
        (row.state === "computer_accepted" ||
          row.state === "computer_running" ||
          row.state === "cloud_committed" ||
          row.state === "cancel_pending")
      ) {
        await this.patchDispatch(
          row,
          {
            state: "reconciliation_required",
            lease_expires_at: null,
            fallback_reason: `${row.state}-lease-expired`,
          },
          now,
          { notifyExecutor: false },
        );
        continue;
      }
      if (row.payload_json !== null) {
        this.ctx.storage.sql.exec(
          `UPDATE dispatches SET payload_json = NULL, payload_expires_at = NULL
            WHERE dispatch_id = ?`,
          row.dispatch_id,
        );
      }
    }
  }
}
