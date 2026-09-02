import type { CloudExecutionSelection } from "../agent-engine.js";
import type { ManagedModelAudience } from "../gateway/capability.js";
import type { OwnerEnforcement } from "../gateway/usage.js";
import type { IdentityLevel } from "../gateway/api.js";

/**
 * The owner snapshot is the one control-plane read the owner gate Durable
 * Object performs. Convex serves it; the gate caches it for `ttlMs` and Convex
 * pushes a replacement when owner state changes.
 */

export const OWNER_SNAPSHOT_VERSION = 1 as const;

export const CONVEX_OWNER_SNAPSHOT_PATH =
  "/api/gateway/owner-snapshot" as const;
/** cloud-builder route Convex calls (service secret) when an owner's plan changes. */
export const BUILDER_OWNER_SNAPSHOT_CHANGED_PATH =
  "/internal/owners/snapshot-changed" as const;

export type CloudPlanId = "free" | "go" | "pro";

export type CloudLaneQuota = {
  /** Starts allowed per 10-minute window. */
  burstStarts: number;
  /** Turns allowed per rolling 24 hours. */
  dailyTurns: number;
  /** Concurrently running turns (agents: concurrently running threads). */
  concurrent: number;
};

export type OwnerSnapshot = {
  v: typeof OWNER_SNAPSHOT_VERSION;
  ownerId: string;
  ownerGeneration: string;
  /** Owner purged, write-fenced, or suspended: the gate refuses every admission. */
  writable: boolean;
  /**
   * Anonymous (signed-out) owner. The chat lane is admitted under the
   * anonymous allowance; the agent lane, app builds, and every helper that
   * spends outside the model gateway answer `sign_in_required`.
   */
  isAnonymous: boolean;
  /** Identity ladder rung (0 anonymous … 3 paying); drives allowance shares. */
  identityLevel: IdentityLevel;
  /** Enforcement status; absent means `ok`. Suspended also sets `writable: false`. */
  enforcement?: OwnerEnforcement;
  plan: CloudPlanId;
  unlimited: boolean;
  quotas: {
    chat: CloudLaneQuota;
    agent: CloudLaneQuota;
  };
  allowance: {
    audience: ManagedModelAudience;
    budgetMicroCents: number;
    maxRequests?: number;
  };
  /** Owner default execution used when a turn does not pin one. */
  execution: CloudExecutionSelection;
  /**
   * Paired mobile devices allowed to submit against this owner's desktops
   * (Stage 3 placement). `mobilePublicKey` is the phone's pairing key so the
   * worker can verify its proof headers without a Convex round trip: the
   * pairing proof is an HMAC-SHA256, and this value is its key —
   * `sha256hex(pairSecret)`, the same `pairSecretHash` Convex stores on the
   * grant. Only active (non-revoked) grants appear.
   */
  pairedDevices?: Array<{
    mobileDeviceId: string;
    desktopDeviceId: string;
    mobilePublicKey?: string;
  }>;
  /**
   * The owner's execution devices (desktops) for placement: their device
   * public key (verifies the presence socket proof), whether remote execution
   * is enabled, and the capabilities they last advertised.
   */
  devices?: Array<{
    deviceId: string;
    /** Ed25519 key the desktop registered; verifies the presence-socket proof. */
    publicKey: string;
    remoteExecutionEnabled: boolean;
    label?: string;
    capabilities?: Array<
      | "chat"
      | "agent"
      | "computer-use"
      | "local-files"
      | "local-apps"
      | "attachments"
    >;
  }>;
  /**
   * Engines the owner has a live connected credential for. Lets the gate
   * refuse (or fall back from) an execution whose engine cannot be honoured
   * before it mints a `credential` turn capability.
   */
  connectedEngines?: Array<"anthropic" | "openai-codex">;
  fetchedAt: number;
  ttlMs: number;
};

export type OwnerSnapshotChangedRequest = {
  ownerId: string;
  /**
   * A push with a snapshot replaces the gate's cached copy. A push without
   * one marks the existing copy stale so the gate refreshes it in the
   * background on its next read.
   */
  snapshot?: OwnerSnapshot;
  reason:
    | "billing"
    | "generation"
    | "engine"
    | "pairing"
    /** A device was registered, removed, or had remote execution toggled. */
    | "device"
    /** Enforcement status changed (suspend, throttle, clear). */
    | "enforcement"
    | "manual";
};
