import type { OwnerHomeContext } from "../owner-home-context.js";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import type {
  DevicesResponse,
  DispatchError,
  DispatchStatusResponse,
  DispatchSubmitRequest,
  DispatchSubmitResponse,
} from "@stella/contracts/turn-plane/placement";
import type {
  OwnerFenceLeaseNamespace,
  OwnerFenceLeaseRole,
} from "../owner-fence-store.js";

export type OwnerGateEnv = Pick<
  Cloudflare.Env,
  "BUILDER_SERVICE_SECRET" | "BACKUP_BUCKET" | "MODEL_GATEWAY_CONTROL"
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
  deferCloudSandboxCheck?: boolean;
  /** Test seam; defaults to `Date.now()`. */
  now?: number;
};

export type OwnerGateRefusalCode =
  | "owner_purged"
  | "sign_in_required"
  | "subscription_required"
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

export type DispatchRow = {
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
