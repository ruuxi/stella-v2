/**
 * The owner gate: one Durable Object per owner, named by ownerId, that
 * answers "may this owner start a turn right now?" without a synchronous
 * Convex call on the turn's critical path.
 *
 * It holds exactly one control-plane read — the owner snapshot Convex serves
 * from `GET /api/gateway/owner-snapshot` (plan quotas, model allowance,
 * default execution, owner generation, write fence) — cached for the
 * snapshot's own `ttlMs`. Convex normally pushes the replacement snapshot
 * when billing or lifecycle state changes; a push without one marks the copy
 * stale for background refresh. Everything else it decides from its own SQLite:
 * rolling start windows (burst per 10 minutes, daily per 24 hours) and the
 * registry of running turns (per-lane concurrency, one running agent per
 * workspace). Conversation and thread objects admit through it and release
 * on their terminal paths; a release that never arrives is bounded by
 * `TURN_TIMEOUT_MS` plus a grace, after which a running row is treated as
 * released, so a lost isolate can never wedge an owner permanently.
 *
 * Refusals are values, never thrown: an RPC caller maps them straight to the
 * turn-start error contract. Only a snapshot that cannot be obtained at all
 * fails closed — as `internal`, retryable — and even then a snapshot cached
 * within three ttls is served while a single background refresh runs rather
 * than putting a Convex call on the turn path.
 */

import { DurableObject } from "cloudflare:workers";
import {
  isManagedModelAudience,
  type GatewayNativeCredentialProvider,
} from "@stella/contracts/gateway/capability";
import {
  CONVEX_OWNER_SNAPSHOT_PATH,
  OWNER_SNAPSHOT_VERSION,
  type CloudLaneQuota,
  type CloudPlanId,
  type OwnerSnapshot,
} from "@stella/contracts/turn-plane/owner-snapshot";
import {
  OWNER_ENFORCEMENT_STATUSES,
  type OwnerEnforcement,
} from "@stella/contracts/gateway/usage";
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
import type { OutboxEvent } from "@stella/contracts/turn-plane/outbox";
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
import { enqueueOutbox } from "./outbox.js";
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
  "STELLA_CONVEX_SITE_URL" | "BUILDER_SERVICE_SECRET" | "BACKUP_BUCKET"
> &
  Partial<
    Pick<
      Cloudflare.Env,
      | "TURN_TIMEOUT_MS"
      | "ORCHESTRATOR_SESSIONS"
      | "BUILD_SESSIONS"
      | "TURN_OUTBOX"
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
   * Agent lane: the workspace this run occupies. At most one running agent
   * per workspace — the one-sandbox-per-owner-world rule that Convex used to
   * enforce at spawn.
   */
  workspace?: string;
  /**
   * Service callers pin the owner generation they dispatched with. A
   * mismatch after a forced snapshot refresh is `generation_stale`.
   */
  expectedGeneration?: string;
  /**
   * `bypass` registers the run (so it counts for everyone else) without
   * consulting the windows or the concurrency ceiling. Used for turns the
   * user cannot retry — an agent-completion wake — and never for anything a
   * client can submit.
   */
  quota?: "enforce" | "bypass";
  /** Test seam; defaults to `Date.now()`. */
  now?: number;
};

export type OwnerGateRefusalCode =
  | "quota_burst"
  | "quota_daily"
  | "quota_concurrency"
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

export const OWNER_GATE_BURST_WINDOW_MS = 10 * 60_000;
export const OWNER_GATE_DAILY_WINDOW_MS = 24 * 60 * 60_000;
export const OWNER_GATE_CPU_MINUTES_PER_DAY: Readonly<
  Record<CloudPlanId, number>
> = {
  free: 45,
  go: 120,
  pro: 300,
};
/** Grace added to `TURN_TIMEOUT_MS` before a running row is presumed released. */
export const OWNER_GATE_RUNNING_GRACE_MS = 60_000;
/**
 * Synchronous fetches are limited to three seconds. Production saw the old
 * ten-second timeout turn into 8-18 second admissions, and a Convex call must
 * not hold the turn path when the gate already has a usable snapshot.
 */
export const OWNER_GATE_SNAPSHOT_TIMEOUT_MS = 3_000;
/** Background refreshes stay off the turn path and may wait longer for Convex. */
export const OWNER_GATE_BACKGROUND_SNAPSHOT_TIMEOUT_MS = 10_000;
/** A cloud start refused as unavailable (503) is retried once, after this. */
export const DISPATCH_CLOUD_RETRY_DELAY_MS = 1_000;
export const DISPATCH_CLOUD_MAX_ATTEMPTS = 2;
/**
 * Hard ceiling for stale-while-revalidate. Before it, the gate serves its
 * copy immediately; at or beyond it, admission waits for a bounded fetch and
 * fails closed if Convex is unavailable.
 */
export const OWNER_GATE_STALE_SNAPSHOT_TTLS = 3;
const DEFAULT_TURN_TIMEOUT_MS = 900_000;
const SNAPSHOT_KEY = "ownerSnapshot";
const CONCURRENCY_RETRY_MIN_MS = 1_000;
const CONCURRENCY_RETRY_MAX_MS = 30_000;

const DDL = [
  `CREATE TABLE IF NOT EXISTS starts (
     id   INTEGER PRIMARY KEY AUTOINCREMENT,
     lane TEXT    NOT NULL,
     at   INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS starts_lane_at ON starts(lane, at)`,
  `CREATE TABLE IF NOT EXISTS running (
     turn_id         TEXT    PRIMARY KEY,
     lane            TEXT    NOT NULL,
     conversation_id TEXT    NOT NULL,
     workspace       TEXT,
     started_at      INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS running_lane ON running(lane)`,
  `CREATE INDEX IF NOT EXISTS running_workspace ON running(workspace)`,
  `CREATE TABLE IF NOT EXISTS cpu_minutes (
     turn_id TEXT PRIMARY KEY,
     at      INTEGER NOT NULL,
     minutes REAL    NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS cpu_minutes_at ON cpu_minutes(at)`,
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

type CachedSnapshot = {
  snapshot: OwnerSnapshot;
  cachedAt: number;
  /** Convex announced a change but could not include a replacement. */
  stale?: true;
};

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

const isOwnerEnforcementStatus = (
  value: unknown,
): value is OwnerEnforcement["status"] =>
  OWNER_ENFORCEMENT_STATUSES.some((status) => status === value);

type ParsedLaneQuota = CloudLaneQuota & { cpuMinutesPerDay?: number };

const parseLaneQuota = (value: unknown): ParsedLaneQuota | null => {
  if (!isRecord(value)) return null;
  if (
    !isCount(value.burstStarts) ||
    !isCount(value.dailyTurns) ||
    !isCount(value.concurrent)
  ) {
    return null;
  }
  return {
    burstStarts: value.burstStarts,
    dailyTurns: value.dailyTurns,
    concurrent: value.concurrent,
    ...(isCount(value.cpuMinutesPerDay)
      ? { cpuMinutesPerDay: value.cpuMinutesPerDay }
      : {}),
  };
};

const agentCpuMinutesPerDay = (snapshot: OwnerSnapshot): number => {
  const quota: unknown = snapshot.quotas.agent;
  if (isRecord(quota) && isCount(quota.cpuMinutesPerDay)) {
    return quota.cpuMinutesPerDay;
  }
  return OWNER_GATE_CPU_MINUTES_PER_DAY[snapshot.plan];
};

const parseOwnerEnforcement = (value: unknown): OwnerEnforcement | null => {
  if (!isRecord(value)) return null;
  if (!isOwnerEnforcementStatus(value.status)) return null;
  if (
    value.until !== undefined &&
    (typeof value.until !== "number" || !Number.isFinite(value.until))
  ) {
    return null;
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    return null;
  }
  return {
    status: value.status,
    ...(value.until !== undefined ? { until: value.until } : {}),
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
  };
};

const NATIVE_ENGINES: readonly GatewayNativeCredentialProvider[] = [
  "anthropic",
  "openai-codex",
];

type PairedDevice = NonNullable<OwnerSnapshot["pairedDevices"]>[number];
type SnapshotDevice = NonNullable<OwnerSnapshot["devices"]>[number];

/**
 * `mobilePublicKey` is the phone's pairing key: the worker verifies a mobile
 * submit's proof against it, so a malformed entry must be dropped rather than
 * carried through as an unusable string.
 */
const parsePairedDevices = (value: readonly unknown[]): PairedDevice[] => {
  const paired: PairedDevice[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.mobileDeviceId !== "string" ||
      !entry.mobileDeviceId ||
      typeof entry.desktopDeviceId !== "string" ||
      !entry.desktopDeviceId
    ) {
      continue;
    }
    const key =
      typeof entry.mobilePublicKey === "string" && entry.mobilePublicKey.trim()
        ? entry.mobilePublicKey.trim()
        : undefined;
    paired.push({
      mobileDeviceId: entry.mobileDeviceId,
      desktopDeviceId: entry.desktopDeviceId,
      ...(key ? { mobilePublicKey: key } : {}),
    });
  }
  return paired;
};

/** A device with no public key can never prove a presence socket: drop it. */
const parseSnapshotDevices = (value: readonly unknown[]): SnapshotDevice[] => {
  const devices: SnapshotDevice[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.deviceId !== "string" ||
      !entry.deviceId ||
      entry.deviceId.length > MAX_DEVICE_ID_CHARS ||
      typeof entry.publicKey !== "string" ||
      !entry.publicKey ||
      typeof entry.remoteExecutionEnabled !== "boolean"
    ) {
      continue;
    }
    const label =
      typeof entry.label === "string" && entry.label.trim()
        ? entry.label.trim().slice(0, 128)
        : undefined;
    // The last capabilities Convex saw. Eligibility uses what the live socket
    // advertises instead; this is only what a never-connected device reports.
    const capabilities = Array.isArray(entry.capabilities)
      ? (entry.capabilities.filter((capability) =>
          CAPABILITY_VALUES.includes(capability as ExecutionCapability),
        ) as SnapshotDevice["capabilities"])
      : undefined;
    devices.push({
      deviceId: entry.deviceId,
      publicKey: entry.publicKey,
      remoteExecutionEnabled: entry.remoteExecutionEnabled,
      ...(label ? { label } : {}),
      ...(capabilities ? { capabilities } : {}),
    });
  }
  return devices;
};

/**
 * Structural validation of what Convex served. A malformed snapshot is a
 * deployment skew, not an owner refusal: it is reported as a fetch failure so
 * the cached copy (if any) keeps serving while someone fixes the drift.
 */
export const parseOwnerSnapshot = (
  value: unknown,
  ownerId: string,
): OwnerSnapshot | null => {
  if (!isRecord(value)) return null;
  if (value.v !== OWNER_SNAPSHOT_VERSION) return null;
  if (value.ownerId !== ownerId) return null;
  if (typeof value.ownerGeneration !== "string" || !value.ownerGeneration) {
    return null;
  }
  if (typeof value.writable !== "boolean") return null;
  if (typeof value.isAnonymous !== "boolean") return null;
  const identityLevel = value.identityLevel;
  if (
    identityLevel !== 0 &&
    identityLevel !== 1 &&
    identityLevel !== 2 &&
    identityLevel !== 3
  ) {
    return null;
  }
  const enforcement =
    value.enforcement === undefined
      ? undefined
      : parseOwnerEnforcement(value.enforcement);
  if (value.enforcement !== undefined && !enforcement) return null;
  const plan = value.plan;
  if (plan !== "free" && plan !== "go" && plan !== "pro") return null;
  if (typeof value.unlimited !== "boolean") return null;
  if (!isRecord(value.quotas)) return null;
  const chat = parseLaneQuota(value.quotas.chat);
  const agent = parseLaneQuota(value.quotas.agent);
  if (!chat || !agent) return null;
  if (!isRecord(value.allowance)) return null;
  if (!isManagedModelAudience(value.allowance.audience)) return null;
  if (
    typeof value.allowance.budgetMicroCents !== "number" ||
    !Number.isFinite(value.allowance.budgetMicroCents)
  ) {
    return null;
  }
  if (
    value.allowance.maxRequests !== undefined &&
    !isCount(value.allowance.maxRequests)
  ) {
    return null;
  }
  const execution = value.execution;
  if (!isRecord(execution)) return null;
  const pair = `${String(execution.engine)}/${String(execution.provider)}`;
  if (
    (pair !== "stella/stella" &&
      pair !== "anthropic/anthropic" &&
      pair !== "openai-codex/openai-codex") ||
    typeof execution.model !== "string" ||
    !execution.model.trim() ||
    typeof execution.reasoningEffort !== "string" ||
    !execution.reasoningEffort
  ) {
    return null;
  }
  let connectedEngines: GatewayNativeCredentialProvider[] | undefined;
  if (value.connectedEngines !== undefined) {
    if (!Array.isArray(value.connectedEngines)) return null;
    connectedEngines = [];
    for (const engine of value.connectedEngines) {
      if (!NATIVE_ENGINES.includes(engine as GatewayNativeCredentialProvider)) {
        return null;
      }
      connectedEngines.push(engine as GatewayNativeCredentialProvider);
    }
  }
  if (
    typeof value.fetchedAt !== "number" ||
    !Number.isFinite(value.fetchedAt) ||
    typeof value.ttlMs !== "number" ||
    !Number.isFinite(value.ttlMs) ||
    value.ttlMs <= 0
  ) {
    return null;
  }
  return {
    v: OWNER_SNAPSHOT_VERSION,
    ownerId,
    ownerGeneration: value.ownerGeneration,
    writable: value.writable,
    isAnonymous: value.isAnonymous,
    identityLevel,
    ...(enforcement ? { enforcement } : {}),
    plan: plan as CloudPlanId,
    unlimited: value.unlimited,
    quotas: { chat, agent },
    allowance: {
      audience: value.allowance.audience,
      budgetMicroCents: value.allowance.budgetMicroCents,
      ...(value.allowance.maxRequests !== undefined
        ? { maxRequests: value.allowance.maxRequests }
        : {}),
    },
    execution: {
      engine: execution.engine,
      provider: execution.provider,
      model: execution.model,
      reasoningEffort: execution.reasoningEffort,
    } as OwnerSnapshot["execution"],
    ...(connectedEngines ? { connectedEngines } : {}),
    ...(Array.isArray(value.pairedDevices)
      ? { pairedDevices: parsePairedDevices(value.pairedDevices) }
      : {}),
    ...(Array.isArray(value.devices)
      ? { devices: parseSnapshotDevices(value.devices) }
      : {}),
    fetchedAt: value.fetchedAt,
    ttlMs: value.ttlMs,
  };
};

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

const parseAvailability = (value: unknown): DeviceAvailability | null => {
  if (!isRecord(value)) return null;
  if (typeof value.ready !== "boolean") return null;
  if (!isCount(value.chatSlots) || !isCount(value.agentSlots)) return null;
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
    chatSlots: Math.min(value.chatSlots, 64),
    agentSlots: Math.min(value.agentSlots, 64),
    capabilities,
  };
};

type PresenceRow = {
  device_id: string;
  presence_session_id: string;
  connection_id: string;
  connected: number;
  ready: number;
  chat_slots: number;
  agent_slots: number;
  capabilities: string;
  protocol_version: number;
  last_seen_at: number;
};

const presenceState = (row: PresenceRow): DevicePresenceState => ({
  deviceId: row.device_id,
  presenceSessionId: row.presence_session_id,
  connected: row.connected === 1,
  ready: row.ready === 1,
  chatSlots: row.chat_slots,
  agentSlots: row.agent_slots,
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

export class OwnerGate extends DurableObject<OwnerGateEnv> {
  private schemaReady = false;
  private snapshotInflight: Promise<OwnerSnapshot> | null = null;

  /** The owner this object gates. The namespace is addressed by name only. */
  private ownerId(): string {
    const name = this.ctx.id.name ?? "";
    if (!name)
      throw new Error("Owner gate objects must be addressed by owner id.");
    return name;
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    const startedAt = performance.now();
    for (const statement of DDL) this.ctx.storage.sql.exec(statement);
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
   * One GET to Convex. Split out so tests replace the transport without
   * touching the caching and failure policy around it.
   */
  protected async fetchSnapshot(
    ownerId: string,
    timeoutMs: number,
  ): Promise<OwnerSnapshot> {
    const base = (this.env.STELLA_CONVEX_SITE_URL ?? "")
      .trim()
      .replace(/\/+$/, "");
    const secret = this.env.BUILDER_SERVICE_SECRET;
    if (!base || !secret) {
      throw new OwnerGateSnapshotError(
        "internal",
        "Owner snapshot endpoint is not configured.",
        true,
      );
    }
    let response: Response;
    try {
      response = await fetch(
        `${base}${CONVEX_OWNER_SNAPSHOT_PATH}?ownerId=${encodeURIComponent(ownerId)}`,
        {
          headers: {
            authorization: `Bearer ${secret}`,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (error) {
      throw new OwnerGateSnapshotError(
        "internal",
        `Owner snapshot fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    if (response.status === 404 || response.status === 410) {
      throw new OwnerGateSnapshotError(
        "owner_purged",
        "This owner no longer exists.",
        false,
      );
    }
    if (!response.ok) {
      throw new OwnerGateSnapshotError(
        "internal",
        `Owner snapshot fetch returned ${response.status}.`,
        true,
      );
    }
    const parsed = parseOwnerSnapshot(
      await response.json().catch(() => null),
      ownerId,
    );
    if (!parsed) {
      throw new OwnerGateSnapshotError(
        "internal",
        "Owner snapshot response was malformed.",
        true,
      );
    }
    return parsed;
  }

  /**
   * Serves any cached copy below the hard ceiling without waiting on Convex.
   * Copies beyond `ttlMs`, plus copies marked stale by a snapshot-less push,
   * start one shared background refresh. This stale-while-revalidate rule
   * keeps the synchronous control plane off the turn path after production
   * showed ten-second fetches stalling admissions. With no usable copy, or
   * with `refresh: true`, the refresh stays synchronous and uses the three
   * second bound. Background refreshes use a ten-second bound because they do
   * not hold admission. When one reports a definite "owner gone", it removes
   * the exact cached record that started the refresh so later reads fail
   * closed.
   */
  async snapshot(
    options: { refresh?: boolean; now?: number } = {},
  ): Promise<OwnerSnapshot> {
    const now = options.now ?? Date.now();
    const cached = await this.ctx.storage.get<CachedSnapshot>(SNAPSHOT_KEY);
    const ageMs = cached ? now - cached.cachedAt : 0;
    const belowHardCeiling =
      cached && ageMs < cached.snapshot.ttlMs * OWNER_GATE_STALE_SNAPSHOT_TTLS;
    if (!options.refresh && cached && belowHardCeiling) {
      if (cached.stale || ageMs >= cached.snapshot.ttlMs) {
        if (ageMs >= cached.snapshot.ttlMs) {
          log("info", "owner_snapshot_served_stale", {
            ownerId: this.ownerId(),
            ageMs,
          });
        }
        this.refreshSnapshotInBackground(now);
      }
      return cached.snapshot;
    }
    try {
      return await this.refreshSnapshot(now, OWNER_GATE_SNAPSHOT_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof OwnerGateSnapshotError && !error.retryable) {
        throw error;
      }
      if (cached && belowHardCeiling) {
        log("error", "owner_snapshot_refresh_failed", {
          ownerId: this.ownerId(),
          ageMs,
          message: error instanceof Error ? error.message : String(error),
        });
        if (ageMs >= cached.snapshot.ttlMs) {
          log("info", "owner_snapshot_served_stale", {
            ownerId: this.ownerId(),
            ageMs,
          });
        }
        return cached.snapshot;
      }
      throw error instanceof OwnerGateSnapshotError
        ? error
        : new OwnerGateSnapshotError(
            "internal",
            error instanceof Error ? error.message : String(error),
            true,
          );
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
    const ownerId = this.ownerId();
    const response = await createOwnerFenceHost({
      ctx: this.ctx,
      env: this.env,
    }).fetch(
      "register",
      new Request("https://owner-gate/owner-fence/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HEADER_OWNER_FENCE_ID]: ownerId,
        },
        body: JSON.stringify({ ...input.lease, ownerId }),
      }),
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
        snapshot,
        lease: {
          status: "registered",
          generation: body.generation,
          expiresAt: body.expiresAt,
        },
      };
    }
    return {
      snapshot,
      lease: {
        status: "refused",
        httpStatus: response.status,
        ...(typeof body?.code === "string" ? { code: body.code } : {}),
        ...(typeof body?.error === "string" ? { error: body.error } : {}),
      },
    };
  }

  private refreshSnapshotInBackground(now: number): void {
    if (this.snapshotInflight) return;
    void this.refreshSnapshot(
      now,
      OWNER_GATE_BACKGROUND_SNAPSHOT_TIMEOUT_MS,
    ).catch((error) => {
      log("error", "owner_snapshot_refresh_failed", {
        ownerId: this.ownerId(),
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private refreshSnapshot(
    now: number,
    timeoutMs: number,
  ): Promise<OwnerSnapshot> {
    if (this.snapshotInflight) return this.snapshotInflight;
    const work = (async () => {
      const cachedBeforeRefresh =
        await this.ctx.storage.get<CachedSnapshot>(SNAPSHOT_KEY);
      try {
        const snapshot = await this.fetchSnapshot(this.ownerId(), timeoutMs);
        return (await this.storeSnapshot(snapshot, now)).snapshot;
      } catch (error) {
        if (
          cachedBeforeRefresh &&
          error instanceof OwnerGateSnapshotError &&
          !error.retryable
        ) {
          const current =
            await this.ctx.storage.get<CachedSnapshot>(SNAPSHOT_KEY);
          if (
            current?.cachedAt === cachedBeforeRefresh.cachedAt &&
            current.snapshot.fetchedAt ===
              cachedBeforeRefresh.snapshot.fetchedAt &&
            current.snapshot.ownerGeneration ===
              cachedBeforeRefresh.snapshot.ownerGeneration
          ) {
            await this.ctx.storage.delete(SNAPSHOT_KEY);
          }
        }
        throw error;
      }
    })().finally(() => {
      if (this.snapshotInflight === work) this.snapshotInflight = null;
    });
    this.snapshotInflight = work;
    return work;
  }

  private async storeSnapshot(
    snapshot: OwnerSnapshot,
    cachedAt: number,
  ): Promise<{ snapshot: OwnerSnapshot; stored: boolean }> {
    const cached = await this.ctx.storage.get<CachedSnapshot>(SNAPSHOT_KEY);
    const olderFetchedAt =
      cached && snapshot.fetchedAt < cached.snapshot.fetchedAt;
    const ambiguousGenerationAtSameTime =
      cached &&
      snapshot.fetchedAt === cached.snapshot.fetchedAt &&
      snapshot.ownerGeneration !== cached.snapshot.ownerGeneration;
    if (cached && (olderFetchedAt || ambiguousGenerationAtSameTime)) {
      log("info", "owner_snapshot_replacement_ignored", {
        ownerId: this.ownerId(),
        cachedGeneration: cached.snapshot.ownerGeneration,
        cachedFetchedAt: cached.snapshot.fetchedAt,
        pushedGeneration: snapshot.ownerGeneration,
        pushedFetchedAt: snapshot.fetchedAt,
      });
      return { snapshot: cached.snapshot, stored: false };
    }
    await this.ctx.storage.put(SNAPSHOT_KEY, {
      snapshot,
      cachedAt,
    } satisfies CachedSnapshot);
    return { snapshot, stored: true };
  }

  /**
   * Convex pushed a complete replacement. A lower `fetchedAt`, or a different
   * generation at the same timestamp, cannot overwrite the cached copy. A
   * stored replacement clears the stale mark and pre-warms the next turn.
   */
  async replaceSnapshot(snapshot: OwnerSnapshot): Promise<void> {
    if (snapshot.ownerId !== this.ownerId()) {
      throw new Error("Pushed owner snapshot does not match this owner gate.");
    }
    const result = await this.storeSnapshot(snapshot, Date.now());
    if (result.stored) {
      log("info", "owner_snapshot_replaced", {
        ownerId: this.ownerId(),
        generation: result.snapshot.ownerGeneration,
        fetchedAt: result.snapshot.fetchedAt,
      });
    }
  }

  /**
   * A snapshot-less Convex push marks the cached copy stale instead of
   * deleting it. The next read serves the copy and refreshes in the
   * background, because invalidation must not put Convex back on the turn
   * path. With no cached copy, the next read still fetches synchronously.
   */
  async invalidate(): Promise<void> {
    const cached = await this.ctx.storage.get<CachedSnapshot>(SNAPSHOT_KEY);
    if (cached) {
      await this.ctx.storage.put(SNAPSHOT_KEY, {
        ...cached,
        stale: true,
      } satisfies CachedSnapshot);
    }
    log("info", "owner_snapshot_invalidated", { ownerId: this.ownerId() });
  }

  private prune(now: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM starts WHERE at < ?`,
      now - OWNER_GATE_DAILY_WINDOW_MS,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM running WHERE started_at < ?`,
      now - (this.turnTimeoutMs() + OWNER_GATE_RUNNING_GRACE_MS),
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM cpu_minutes WHERE at < ?`,
      now - OWNER_GATE_DAILY_WINDOW_MS,
    );
  }

  private cpuMinutesUsed(now: number): number {
    const row = this.ctx.storage.sql
      .exec<{
        minutes: number | null;
      }>(
        `SELECT SUM(minutes) AS minutes FROM cpu_minutes WHERE at > ?`,
        now - OWNER_GATE_DAILY_WINDOW_MS,
      )
      .one();
    return typeof row.minutes === "number" && Number.isFinite(row.minutes)
      ? Math.max(0, row.minutes)
      : 0;
  }

  /**
   * When one more start fits a window: the moment enough of the oldest
   * starts in it expire. `starts` is ascending; with `count >= limit`, the
   * `(count - limit + 1)`th oldest start leaving the window frees a slot.
   */
  private windowRefusal(
    lane: OwnerGateLane,
    windowMs: number,
    limit: number,
    now: number,
  ): number | null {
    const rows = this.ctx.storage.sql
      .exec<{
        at: number;
      }>(
        `SELECT at FROM starts WHERE lane = ? AND at > ? ORDER BY at ASC`,
        lane,
        now - windowMs,
      )
      .toArray();
    if (rows.length < limit) return null;
    const frees = rows[rows.length - limit]?.at ?? now;
    return Math.max(1, frees + windowMs - now);
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
            "Stella can't check your plan right now. Try again shortly.",
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
    const quota = snapshot.quotas[input.lane];
    const enforce = input.quota !== "bypass";
    if (enforce && !snapshot.unlimited) {
      if (
        input.lane === "agent" &&
        this.cpuMinutesUsed(now) >= agentCpuMinutesPerDay(snapshot)
      ) {
        return refuse(
          "quota_daily",
          "Daily cloud agent time is used up.",
          true,
        );
      }
      const burst = this.windowRefusal(
        input.lane,
        OWNER_GATE_BURST_WINDOW_MS,
        quota.burstStarts,
        now,
      );
      if (burst !== null) {
        return refuse(
          "quota_burst",
          "You're sending messages faster than your plan allows. Try again in a few minutes.",
          true,
          burst,
        );
      }
      const daily = this.windowRefusal(
        input.lane,
        OWNER_GATE_DAILY_WINDOW_MS,
        quota.dailyTurns,
        now,
      );
      if (daily !== null) {
        return refuse(
          "quota_daily",
          "You've reached today's limit for your plan.",
          true,
          daily,
        );
      }
    }
    if (enforce) {
      const running = this.ctx.storage.sql
        .exec<{
          started_at: number;
        }>(
          `SELECT started_at FROM running WHERE lane = ? ORDER BY started_at ASC`,
          input.lane,
        )
        .toArray();
      if (running.length >= quota.concurrent) {
        const oldest = running[0]?.started_at ?? now;
        const frees =
          oldest + this.turnTimeoutMs() + OWNER_GATE_RUNNING_GRACE_MS - now;
        return refuse(
          "quota_concurrency",
          input.lane === "agent"
            ? "Your plan's agents are all busy. Wait for one to finish."
            : "Another turn is still running. Wait for it to finish.",
          true,
          Math.min(
            CONCURRENCY_RETRY_MAX_MS,
            Math.max(CONCURRENCY_RETRY_MIN_MS, frees),
          ),
        );
      }
    }
    const workspace = input.workspace?.trim() || null;
    if (input.lane === "agent" && workspace) {
      const busy = this.ctx.storage.sql
        .exec<{
          turn_id: string;
          started_at: number;
        }>(
          `SELECT turn_id, started_at FROM running WHERE lane = 'agent' AND workspace = ?`,
          workspace,
        )
        .toArray();
      if (busy.length > 0) {
        const frees =
          (busy[0]?.started_at ?? now) +
          this.turnTimeoutMs() +
          OWNER_GATE_RUNNING_GRACE_MS -
          now;
        return refuse(
          "quota_concurrency",
          "Another agent is already running in this workspace. Wait for it to finish.",
          true,
          Math.min(
            CONCURRENCY_RETRY_MAX_MS,
            Math.max(CONCURRENCY_RETRY_MIN_MS, frees),
          ),
        );
      }
    }
    // A bypassed admission (an agent-completion wake) occupies a running
    // slot so concurrency stays truthful, but it is not a start the user
    // chose: it must not eat their burst or daily windows.
    if (enforce) {
      this.ctx.storage.sql.exec(
        `INSERT INTO starts (lane, at) VALUES (?, ?)`,
        input.lane,
        now,
      );
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO running (turn_id, lane, conversation_id, workspace, started_at)
       VALUES (?, ?, ?, ?, ?)`,
      turnId,
      input.lane,
      input.conversationId ?? "",
      workspace,
      now,
    );
    return { ok: true, snapshot, replayed: false };
  }

  /** Idempotent: a release for a turn the gate no longer tracks is a no-op. */
  async release(input: { turnId: string; now?: number }): Promise<void> {
    this.ensureSchema();
    const turnId = input.turnId?.trim() ?? "";
    if (!turnId) return;
    const running = this.ctx.storage.sql
      .exec<{
        lane: string;
        started_at: number;
      }>(`SELECT lane, started_at FROM running WHERE turn_id = ?`, turnId)
      .toArray()[0];
    if (running?.lane === "agent") {
      const now = input.now ?? Date.now();
      const minutes = Math.max(0, now - running.started_at) / 60_000;
      if (minutes > 0) {
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO cpu_minutes (turn_id, at, minutes) VALUES (?, ?, ?)`,
          turnId,
          now,
          minutes,
        );
      }
    }
    this.ctx.storage.sql.exec(`DELETE FROM running WHERE turn_id = ?`, turnId);
  }

  /** Diagnostics for tests and operators; never on a turn's path. */
  async status(now = Date.now()): Promise<{
    running: Array<{
      turnId: string;
      lane: string;
      conversationId: string;
      workspace: string | null;
      startedAt: number;
    }>;
    starts: { chat: number; agent: number };
  }> {
    this.ensureSchema();
    this.prune(now);
    const running = this.ctx.storage.sql
      .exec<{
        turn_id: string;
        lane: string;
        conversation_id: string;
        workspace: string | null;
        started_at: number;
      }>(
        `SELECT turn_id, lane, conversation_id, workspace, started_at FROM running ORDER BY started_at ASC`,
      )
      .toArray()
      .map((row) => ({
        turnId: row.turn_id,
        lane: row.lane,
        conversationId: row.conversation_id,
        workspace: row.workspace,
        startedAt: row.started_at,
      }));
    const count = (lane: OwnerGateLane): number =>
      this.ctx.storage.sql
        .exec<{
          n: number;
        }>(
          `SELECT COUNT(*) AS n FROM starts WHERE lane = ? AND at > ?`,
          lane,
          now - OWNER_GATE_DAILY_WINDOW_MS,
        )
        .one().n;
    return { running, starts: { chat: count("chat"), agent: count("agent") } };
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
      return await createOwnerFenceHost({
        ctx: this.ctx,
        env: this.env,
      }).fetch(url.pathname.slice("/owner-fence/".length), request);
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
    const attachment = this.attachment(socket);
    const now = Date.now();
    if (attachment?.phase === "connected") {
      this.markDisconnected(attachment, now);
    }
    this.closeSocket(socket, code >= 3000 && code <= 4999 ? code : 1000, "");
    await this.scheduleAlarm(now);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
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
      chatSlots: 0,
      agentSlots: 0,
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
      availability.chatSlots,
      availability.agentSlots,
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

  private adjustSlots(
    deviceId: string,
    kind: ExecutionKind,
    delta: number,
    now: number,
  ): void {
    const column = kind === "chat" ? "chat_slots" : "agent_slots";
    this.ctx.storage.sql.exec(
      `UPDATE device_presence
         SET ${column} = MAX(0, ${column} + ?), updated_at = ?
       WHERE device_id = ?`,
      delta,
      now,
      deviceId,
    );
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
              availability: {
                ready: online && presence.ready,
                chatSlots: presence.chatSlots,
                agentSlots: presence.agentSlots,
                capabilities: presence.capabilities,
              },
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

  private async emitDispatchUpdated(row: DispatchRow): Promise<void> {
    const event: OutboxEvent = {
      v: 1,
      kind: "dispatch.updated",
      key: `${row.dispatch_id}:${row.revision}`,
      ownerId: this.ownerId(),
      ownerGeneration: row.owner_generation,
      emittedAt: Date.now(),
      dispatchId: row.dispatch_id,
      dispatch: dispatchSummary(row),
    };
    try {
      await enqueueOutbox(this.env, [event]);
    } catch (error) {
      // The projection is for the activity UI; a queue outage must never take
      // a dispatch transition down with it.
      log("error", "dispatch_projection_deferred", {
        dispatchId: row.dispatch_id,
        revision: row.revision,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private notifyExecutor(row: DispatchRow): void {
    if (!row.executor_device_id) return;
    const socket = this.connectedSocket(row.executor_device_id);
    if (!socket) return;
    this.send(socket, { type: "dispatch", dispatch: dispatchSummary(row) });
  }

  /** Every transition goes through here: one revision bump, one projection. */
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
    await this.emitDispatchUpdated(next);
    if (options.notifyExecutor !== false) this.notifyExecutor(next);
    return next;
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
      (row.ingress === "desktop" || row.ingress === "browser") &&
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
    await this.release({ turnId: row.dispatch_id });
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
    if (row.state === "computer_claimed" && row.executor_device_id) {
      this.adjustSlots(
        row.executor_device_id,
        row.kind as ExecutionKind,
        1,
        now,
      );
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
        fallback_reason: explicitDevice
          ? "selected-device-unavailable"
          : "no-eligible-paired-computer",
        error_code: explicitDevice
          ? "SELECTED_DEVICE_UNAVAILABLE"
          : "COMPUTER_REQUIRED_UNAVAILABLE",
        error_message: explicitDevice
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
   * The cloud said no. A quota, fence, or shape refusal is the dispatch's own
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
    const sessions = this.env.ORCHESTRATOR_SESSIONS;
    if (!sessions)
      throw new Error("Orchestrator session namespace is not bound.");
    const request: CloudTurnStartRequest = {
      protocol: TURN_PLANE_PROTOCOL,
      clientMsgId: row.dispatch_id,
      prompt: payload.prompt,
      lane: "chat",
      source: row.ingress === "schedule" ? "schedule" : "placement",
      ...(payload.locale ? { locale: payload.locale } : {}),
      ...(payload.attachments ? { attachments: payload.attachments } : {}),
      ...(payload.execution ? { execution: payload.execution } : {}),
    };
    // No gate-admitted header, deliberately: the conversation object's own
    // admission is the only one a chat turn ever takes, so burst, daily, and
    // concurrency are applied there and a refusal comes back as this
    // dispatch's terminal error.
    const response = await sessions
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
    if (!response.ok) return await this.cloudRefusal(row, response, now);
    const started = (await response.json()) as CloudTurnStartResponse;
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
    // Convex implementation this replaces did too. An agent dispatch is the
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
        fallbackReason = explicitDevice
          ? "selected-device-unavailable"
          : "no-eligible-paired-computer";
        errorCode = explicitDevice
          ? "SELECTED_DEVICE_UNAVAILABLE"
          : "COMPUTER_REQUIRED_UNAVAILABLE";
        errorMessage = explicitDevice
          ? "The selected computer is offline, busy, or unavailable."
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
    await this.emitDispatchUpdated(row);
    if (terminal) {
      if (gateHeld) await this.release({ turnId: dispatchId });
    } else if (state === "computer_accepted" && executorDeviceId) {
      this.adjustSlots(executorDeviceId, request.kind, -1, now);
      this.notifyExecutor(row);
    } else if (state === "offering" && offerDeadlineAt !== null) {
      for (const candidate of candidates) {
        this.openOffer(dispatchId, candidate, offerDeadlineAt, now);
        this.pushOffer(row, candidate.deviceId, offerDeadlineAt);
      }
    } else if (state === "cloud_committed") {
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

  async dispatchStatus(dispatchId: string): Promise<OwnerGateStatusResult> {
    this.ensureSchema();
    const row = this.dispatchRow(dispatchId.trim());
    if (!row) return fail("not_found", "Dispatch not found.", false);
    return {
      ok: true,
      response: {
        protocol: PLACEMENT_PROTOCOL,
        dispatch: dispatchSummary(row),
      },
    };
  }

  /**
   * Stop, from the owner's side. Work a computer has not durably accepted is
   * canceled outright; work that is running somewhere becomes
   * `cancel_pending` and is settled by the terminal the executing side sends.
   */
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
    if (row.state === "computer_claimed" && row.executor_device_id) {
      this.adjustSlots(
        row.executor_device_id,
        row.kind as ExecutionKind,
        1,
        now,
      );
    }
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
      this.adjustSlots(
        row.executor_device_id,
        row.kind as ExecutionKind,
        1,
        now,
      );
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
      if (isTerminalDispatchState(row.state as DispatchState)) return;
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
      this.adjustSlots(attachment.deviceId, row.kind as ExecutionKind, 1, now);
      const terminal = await this.patchDispatch(
        row,
        {
          state: outcome,
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
        { notifyExecutor: false },
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
    this.adjustSlots(attachment.deviceId, row.kind as ExecutionKind, -1, now);
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
    let next = options.fenceDeadline ?? Number.POSITIVE_INFINITY;
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
      fenceDeadline = await ownerFenceHost.alarm(now);
      fenceAlarmCompleted = true;
      await this.expirePresence(now);
      await this.expireDispatches(now);
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
