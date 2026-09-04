import type { DirectoryBackup } from "@cloudflare/sandbox";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type {
  CloudBrowserResumeReceipt,
  CloudBrowserSuspension,
} from "@stella/contracts/cloud-browser";
import type { ManagedModelAudience } from "@stella/contracts/gateway/capability";
import type {
  TurnBrokerTurnStateCheckpointReceipt,
  TurnBrokerTurnStateCheckpointRequest,
} from "@stella/contracts/turn-credential-broker";
import type { InstanceSize } from "../../instance-size.js";
import type { OwnerTransferCoordinator } from "../../owner-transfer-coordinator-do.js";
import type {
  OwnerTransferCoordinatorAttempt,
  OwnerTransferReservationEnvelope,
} from "../../owner-transfer-coordinator.js";

export type Execution = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type TurnRequest = {
  // "agent" runs a spawned general agent against a persistent workspace;
  // absent/anything else is the legacy app-build turn.
  kind?: string;
  ownerId: string;
  appId: string;
  turnId: string;
  prompt: string;
  /** One short sentence describing the agent thread's work (agent turns). */
  description?: string;
  /** Who asked for this attempt; decides whether the session projects `thread.spawned`. */
  source?: string;
  /** Reliable-delivery id from the dispatcher; a replay names the same turn. */
  clientMsgId?: string;
  /** The parent chat turn whose tool call spawned this thread. */
  parentTurnId?: string;
  /** The direct parent agent thread, absent only for conversation spawns. */
  parentThreadId?: string;
  /** One for conversation children, two for their children. */
  agentDepth: number;
  /**
   * Desktop that owns this thread's delivery. Present means Convex's
   * projection wakes the parent conversation, so the session must not.
   */
  originDeviceId?: string;
  originConversationId?: string;
  preflightDelayMs?: number;
  watchdogMs?: number;
  /** Trusted control-plane continuation of a suspended browser tool call. */
  browserResume?: CloudBrowserResumeReceipt;
  conversationId?: string;
  sessionId?: string;
  threadId?: string;
  workspace?: "shared" | "new" | "fork";
  workspaceForkId?: string;
  /** Exact immutable route selected by Convex for this turn. */
  execution?: CloudExecutionSelection;
  /** Managed-model audience Convex resolved for the owner at dispatch. */
  audience: ManagedModelAudience;
  /** Spend ceiling for this turn's model calls (`GATEWAY_BUDGET_UNLIMITED` allowed). */
  budgetMicroCents: number;
  /** Convex owner-lifecycle generation captured before this dispatch. */
  ownerGeneration: string;
  /** Monotonic generation of this exact reused agent thread attempt. */
  attemptGeneration?: number;
  /** Trusted outer-router facts; never accepted from the dispatch body. */
  turnBrokerRoute?: {
    sessionId: string;
    endpoint: string;
  };
  /** Trusted outer-router facts for the agent-only signed preview proxy. */
  previewRoute?: {
    buildSessionName: string;
    baseUrl: string;
  };
  /** Worker-issued lease. Callers cannot choose this value. */
  ownerPurgeGeneration?: string;
  ownerPurgeLeaseId?: string;
  /**
   * The owner gate admitted this turn before dispatching it and releases it
   * itself if the dispatch fails. Set from a trusted internal header, never
   * from the body; the session still releases on its terminal paths.
   */
  gateAdmittedByCaller?: boolean;
};

export type BuildOwnerFenceLeaseReceipt = {
  schemaVersion: 1;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  leaseId: string;
  kind: "run" | "aux";
  phase: "registering" | "registered" | "unregister_pending";
  registrationGeneration?: string;
  slotKey?: string;
  createdAt: number;
  updatedAt: number;
};

export type BuildOwnerFenceLeaseSlot = {
  schemaVersion: 1;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  leaseId: string;
  kind: "run" | "aux";
};

export type AgentComputeRecoveryClaim = {
  schemaVersion: 1;
  turnId: string;
  attemptGeneration: number;
  sandboxId: string;
  createdAt: number;
};

export type AppTurnAdmissionClaim = {
  schemaVersion: 1;
  claimId: string;
  turnId: string;
  ownerGeneration: string;
  createdAt: number;
};

export type PendingAppBuildPublication = {
  turnId: string;
  /**
   * `"callback"` still names the step, but the step is now an outbox append —
   * a permanent Convex rejection is no longer visible here, so nothing falls
   * from it into cleanup. `"cleanup"` is reached only by a build that failed
   * after uploading bytes, and its job is to remove them and terminate.
   */
  phase: "callback" | "cleanup";
  artifactPrefix: string;
  /** Absent on a cleanup-only record: no build was ever recorded. */
  buildId?: string;
  callbackBody: Record<string, unknown>;
  completionSeq: number | "auto";
  completionResult: Record<string, unknown>;
  failureMessage?: string;
};

export type TurnStateCheckpointOperation =
  | {
      state: "pending";
      turnId: string;
      attemptGeneration: number;
      requestId: string;
      requestFingerprint: string;
      createdAt: number;
      baseWorkspaceRevision: number;
      /** Persisted immediately after owner prepare, before either R2 upload. */
      operationId?: string;
      payload?: TurnBrokerTurnStateCheckpointRequest;
    }
  | {
      state: "succeeded";
      turnId: string;
      attemptGeneration: number;
      requestId: string;
      requestFingerprint: string;
      createdAt: number;
      baseWorkspaceRevision: number;
      payload: TurnBrokerTurnStateCheckpointRequest;
      operationId: string;
      receipt: TurnBrokerTurnStateCheckpointReceipt;
    }
  | {
      state: "failed";
      turnId: string;
      attemptGeneration: number;
      requestId: string;
      requestFingerprint: string;
      createdAt: number;
      baseWorkspaceRevision: number;
      operationId?: string;
      payload?: TurnBrokerTurnStateCheckpointRequest;
      status: number;
    };

export type BuilderFallbackTranscript = {
  schemaVersion: 1;
  turnId: string;
  attemptGeneration: number;
  requestId: string;
  requestFingerprint: string;
  createdAt: number;
  payload: TurnBrokerTurnStateCheckpointRequest;
  messages: Array<{ ordinal: number; role: string; payloadJson: string }>;
  checkpointReceipt?: TurnBrokerTurnStateCheckpointReceipt;
  transcriptCommitted: boolean;
  workspacePublished: boolean;
};

export type AgentExecutionMarker = {
  schemaVersion: 1;
  turnId: string;
  attemptGeneration: number;
  sandboxId: string;
  size: InstanceSize;
  startedAt: number;
};

/**
 * What recovery already knows about a lost turn, if anything. The container
 * path recovers a transcript the executor handed up before it died; a resident
 * turn recovers one from its own journal. Absent both, the fallback synthesizes
 * the two rows a thread needs to stay readable.
 */
export type BuilderFallbackInput = {
  historyCursor?: string;
  messages?: Array<{ ordinal: number; role: string; payloadJson: string }>;
  nativeCheckpoint?: TurnBrokerTurnStateCheckpointRequest["nativeCheckpoint"];
};

export type AgentExecutorResult = {
  outcome?: "completed" | "suspended";
  ok: boolean;
  finalText?: string;
  error?: string;
  usage?: Record<string, unknown>;
  checkpointPolicy?: "preserve_prior" | "builder_fallback";
  checkpointMs?: number;
  turnStateCheckpoint?: TurnBrokerTurnStateCheckpointReceipt;
  suspension?: CloudBrowserSuspension;
  builderFallback?: {
    historyCursor: string;
    messages: Array<{ ordinal: number; role: string; payloadJson: string }>;
    nativeCheckpoint?: TurnBrokerTurnStateCheckpointRequest["nativeCheckpoint"];
  };
};

export type InteriorBuildOutput = {
  schemaVersion: 1;
  sourceRevision: string;
  baseRevision?: string;
  upstreamSeedRevision: string;
  outputRoot: string;
  entries: {
    full: "index.html";
    mini: "mini.html";
    overlay: "overlay.html";
    pet: "pet.html";
  };
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    contentType: string;
  }>;
  artifactSha256: string;
  size: number;
};

/**
 * A terminal state that has been decided but may not have reached Convex yet.
 *
 * It is written to DO storage before the first delivery attempt so the alarm
 * can re-deliver exactly this, unchanged. Without it the success path was the
 * one terminal path with no retry, and it is the one carrying the only copy of
 * the agent's report.
 */
export type PendingTerminal = {
  /** Fences a stale payload against a successor turn on the same DO. */
  turnId: string;
  /** Fences ABA reuse of the same thread/turn-shaped durable receipt. */
  attemptGeneration: number;
  kind: "completed" | "failed" | "canceled";
  /** Optional turn-event kind when the thread status uses a coarser value. */
  eventKind?: "timeout";
  payload: Record<string, unknown>;
  /** Message for the thread's final state; a completed turn sends its report. */
  threadError?: string;
  /**
   * Cancellation is not complete until the sandbox process is gone. This flag
   * makes that requirement durable: if container teardown fails or the DO is
   * evicted mid-cancel, the alarm retries teardown before it delivers the
   * terminal state.
   */
  terminateSandbox?: boolean;
  /**
   * The turn-event ordinal this terminal reserved. Remembered with the
   * decision so a redelivery re-sends the same `turn.event` rather than
   * minting a second one Convex would have to reconcile.
   */
  eventSeq?: number;
  /**
   * When the thread was decided terminal. Fixed with the decision because the
   * parent's wake carries it in `agentThreadControl.threadUpdatedAt`, which is
   * part of that turn's idempotency fingerprint: a retry with a fresh clock
   * would be refused as a different message under the same id.
   */
  completedAt?: number;
};

/**
 * Durable handoff from a finished executor to Convex's waiting projection.
 * The descriptor is intentionally secret-free. It is committed before the
 * sandbox is destroyed so a Worker restart can redeliver the same interaction.
 */
export type PendingBrowserSuspension = {
  schemaVersion: 1;
  turnId: string;
  attemptGeneration: number;
  suspension: CloudBrowserSuspension;
  payload: Record<string, unknown>;
  createdAt: number;
};

/**
 * The Browser Gateway has already entered human control, but the trusted
 * executor has not yet returned the canonical outer Code tool-call binding.
 * Keeping this separate from `PendingBrowserSuspension` prevents an alarm
 * from exposing a takeover before the matching transcript checkpoint is
 * authoritative.
 */
export type ObservedBrowserSuspension = {
  schemaVersion: 1;
  turnId: string;
  attemptGeneration: number;
  brokerRequestId: string;
  requestBodySha256: string;
  responseBodySha256: string;
  suspension: CloudBrowserSuspension;
  observedAt: number;
};

export type ExecutorResult = {
  ok: true;
  runtimeTools: string[];
  metrics: {
    dependencyHydrationMs: number;
    productionBuildMs: number;
    activeCpuSeconds: number;
    peakMemoryBytes: number;
    workspaceDiskBytes: number;
  };
};

export type ConversationCaller = {
  ownerId: string;
  subject: string;
  sessionId: string;
  expiresAtMs: number;
  issuer: string;
  isAnonymous: boolean;
};

/**
 * Who may submit a dispatch, and as what.
 *
 * Three callers exist and they are told apart before anything is parsed: the
 * service secret (Convex schedules and cloud-originated work, any ingress), a
 * signed-in user whose request carries a mobile pairing proof (ingress
 * `mobile`, bound to the phone and the desktop the proof names), and a plain
 * signed-in user (ingress `desktop` or `browser` only — nothing else has a
 * device the worker can vouch for).
 */
export type DispatchCaller =
  | { kind: "service"; ownerId: string; ownerGeneration: string }
  | { kind: "user"; ownerId: string; isAnonymous: boolean }
  | {
      kind: "mobile";
      ownerId: string;
      isAnonymous: boolean;
      mobileDeviceId: string;
      desktopDeviceId: string;
    };

export type NativeTransientBackup = {
  backupId: string;
  checkpointKey: string;
  workspaceKey: string;
};

export type WorkspaceBackupDebt = { backupIds: string[] };

export type WorkspaceCheckpointImport = {
  sourceWorkspaceKey: string;
  sourceWorkspace: string;
  descriptor?: DirectoryBackup;
  backupIds: string[];
  /** Finds pre-cleanup-debt backups during eventual account/workspace purge. */
  historicalBackupName: string;
};

export type WorkspaceCheckpointImports = {
  schemaVersion: 1;
  imports: WorkspaceCheckpointImport[];
};

// ── Owner-scoped storage outside Convex ──────────────────────────────────────

/**
 * THE LIST. Every store outside Convex that holds data belonging to one owner,
 * how it is addressed, and what deletes it. `POST /owners/purge` walks exactly
 * this list; a store that is not here is a store account deletion does not
 * reach, so adding one to the system without adding it here is the defect.
 *
 *  id                | where                    | addressed by
 *  ------------------|--------------------------|--------------------------------
 *  agent-home        | R2 AGENT_HOME            | `agent-home/<sha256(owner)>/`
 *  conversations     | R2 CONVERSATION_ARCHIVE  | `conversations/<sha256(owner)>/`
 *  interiors         | R2 APP_BUILDS            | `interiors/<sha256(owner)>/`
 *                    |                          | (also catches orphan uploads)
 *  backups           | R2 BACKUP_BUCKET         | `backups/<backupId>/` — the id
 *                    |                          | is only in the KV descriptor
 *  builds            | R2 APP_BUILDS            | app
 *                    |                          | `builds/<ownerHash>/<buildId>/`
 *                    |                          | (legacy exact `builds/<buildId>/`)
 *                    |                          | or interior
 *                    |                          | `interiors/<ownerHash>/<buildId>/`
 *  checkpoints       | KV APP_ROUTES            | `ws:<sha256(owner:workspace)>`
 *                    |                          | and `…:size`
 *  native-checkpoints| KV + R2 BACKUP_BUCKET    | `ws:<hash>:native-state:<threadHash>`
 *                    |                          | plus its descriptor/name-derived backup
 *  routes            | KV APP_ROUTES            | `app:<slug>`, owner in the value
 *
 * Deliberately NOT here, with the reason:
 *  - OrchestratorSession DO SQLite and the R2 objects its manifest names are
 *    purged per conversation through `POST /conversations/:id/purge`, because
 *    only the DO can say its own storage is gone. The `conversations/` prefix
 *    sweep above is the backstop for segments whose index row was already lost.
 *  - Sandbox / SandboxSmall / BuildSession DOs hold no durable owner state:
 *    each is destroyed at the end of the turn that created it, and a workspace
 *    that must survive is a `backups/` archive, which IS here.
 *  - The per-user drive bucket is bound to Convex (the @convex-dev/r2
 *    component), not to this worker. Convex deletes it from its own file rows;
 *    see DRIVE in convex/cloud_purge.ts.
 *
 * The two hash prefixes are duplicated from their owners deliberately —
 * importing `ConversationArchive` or `AgentHome` here would pull a DO-shaped
 * module into the worker entry for two string literals. They must stay in step
 * with `archive.ts` (`conversations/<hash>/`) and `agent-home.ts:163`
 * (`agent-home/<hash>/`).
 */
export type OwnerPurgeRequest = {
  ownerId?: string;
  /** Convex lifecycle generation; distinct from the external purge fence. */
  ownerGeneration?: string;
  /** Issued by `/owners/purge/begin`; proves this owner is quiesced. */
  purgeGeneration?: string;
  /** App slugs whose hosted route row must go. */
  appSlugs?: string[];
  /** App/interior build artifactPrefix values in APP_BUILDS. */
  buildPrefixes?: string[];
  /** Private browser profiles that must be confirmed gone before row drain. */
  browserProfiles?: string[];
};

export type OwnerTransferCoordinatorContext = {
  operationId: string;
  planFingerprint: string;
  passId: string;
  attempt: OwnerTransferCoordinatorAttempt;
  stub: DurableObjectStub<OwnerTransferCoordinator>;
  reservation?: OwnerTransferReservationEnvelope;
};

export type OwnerPurgeReport = {
  ok: true;
  deleted: number;
  /** Stores this pass did not finish. Non-empty means "ask again". */
  pending: string[];
};
