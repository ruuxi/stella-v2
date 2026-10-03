import type { CloudExecutionSelection } from "../agent-engine.js";
import type { ManagedModelAudience } from "../gateway/capability.js";
import type { OwnerEnforcement } from "../gateway/usage.js";
import type { IdentityLevel } from "../gateway/api.js";

/**
 * The owner snapshot is what the owner gate Durable Object admits turns
 * against. The gate builds it locally from its own domains (account, abuse,
 * billing, engines, devices) and the caller's verified claims.
 */

export const OWNER_SNAPSHOT_VERSION = 1 as const;

export type CloudPlanId = "free" | "go" | "pro";

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
  allowance: {
    audience: ManagedModelAudience;
    budgetMicroCents: number;
    maxRequests?: number;
  };
  /**
   * Owner default execution used when a turn does not pin one, filled by the
   * gate from the owner's engines domain.
   */
  execution: CloudExecutionSelection;
  /**
   * Paired mobile devices allowed to submit against this owner's desktops
   * (Stage 3 placement). `mobilePublicKey` is the phone's pairing key so the
   * worker can verify its proof headers without another round trip: the
   * pairing proof is an HMAC-SHA256, and this value is its key —
   * `sha256hex(pairSecret)`, the same `pairSecretHash` the devices domain
   * stores on the grant. Only active (non-revoked) grants appear.
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
   * before it mints a `credential` turn capability. Filled by the gate from
   * the owner's engines domain, like `execution`.
   */
  connectedEngines?: Array<"anthropic" | "openai-codex">;
  fetchedAt: number;
  ttlMs: number;
};
