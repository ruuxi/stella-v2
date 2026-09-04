import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { emitCloudTurnTelemetry } from "./telemetry.js";
import {
  runToolEffect,
  sleepWithAbort,
} from "@stella/runtime/kernel/tools/effect-runtime.js";
import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";
import {
  getSandbox,
  type DirectoryBackup,
  type ExecutionSession,
  type Sandbox as SandboxType,
} from "@cloudflare/sandbox";
import { attachedToolPaths } from "@stella/executor-cloud/attached-tool-protocol";
import {
  AppBuildSandbox as AppBuildSandboxBase,
  ContainerProxy,
  GeneralAgentSandbox,
} from "./sandbox-egress-classes.js";
import { appBuildEgress, generalAgentEgress } from "./sandbox-egress-policy.js";
import { inSubshell } from "./shell-subshell.js";
import { worldMaterializationCommand } from "./world-materialization.js";
import { OrchestratorSession } from "./orchestrator-session.js";
import { deliverOutboxBatch, enqueueOutbox } from "./outbox.js";
import {
  HEADER_GATE_ADMITTED,
  HEADER_TURN_AUTH_KIND,
  parseCloudAgentTurnStartRequest,
  parseCloudTurnStartRequest,
  serviceOnlyTurnFields,
  turnStartErrorResponse,
  type TurnAuthKind,
} from "./turn-start-request.js";
import {
  CONVERSATION_ID_PATTERN,
  TURN_OWNER_GENERATION_HEADER,
  TURN_OWNER_ID_HEADER,
  TURN_PLANE_PROTOCOL,
  TURN_PROMPT_MAX_CHARS,
  type CloudAgentTurnStartRequest,
  type CloudAgentTurnStartResponse,
  type CloudTurnSource,
  type CloudTurnStartRequest,
} from "@stella/contracts/turn-plane/turn-start";
import {
  OUTBOX_EVENT_VERSION,
  type BuildRecordedEvent,
  type InteriorBuildRecordedEvent,
  type OutboxEvent,
  type ThreadCompletedEvent,
  type ThreadSpawnedEvent,
  type TurnEventEvent,
  type TurnStartedEvent,
} from "@stella/contracts/turn-plane/outbox";
import {
  HEADER_PRESENCE_DEVICE_ID,
  OwnerGate,
  parseOwnerSnapshot,
  snapshotAllowsExecutionEngine,
  type OwnerGateRefusalCode,
} from "./owner-gate.js";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import {
  ThreadTranscriptError,
  appendThreadMessages,
  ensureThreadTranscriptSchema,
  nextTurnEventSeq,
  purgeThreadTranscript,
  reserveTurnEventSeq,
  readThreadHistory,
  type ThreadMessageInput,
} from "./thread-transcript.js";
import {
  BUILDER_OWNER_SNAPSHOT_CHANGED_PATH,
  type OwnerSnapshotChangedRequest,
} from "@stella/contracts/turn-plane/owner-snapshot";
import {
  DEVICES_PATH,
  DISPATCH_SUBMIT_PATH,
  PLACEMENT_PROTOCOL,
  type DispatchSubmitRequest,
} from "@stella/contracts/turn-plane/placement";
import {
  buildMobilePairingChallenge,
  hasMobilePairingProofHeaders,
  readMobilePairingProofHeaders,
  sha256Hex as pairingSha256Hex,
  canonicalDispatchPayloadJson,
  verifyMobilePairingProof,
} from "@stella/contracts/turn-plane/pairing-proof";
import {
  dispatchErrorResponse,
  parseDispatchSubmitRequest,
} from "./dispatch-policy.js";
import { sha256BytesHex, sha256Hex } from "./hash.js";
import {
  APP_BUILD_ROOT,
  WORLD_DRIVE_ROOT,
  WORLD_ROOT,
  WORLD_STELLA_ROOT,
  agentTurnSessionId,
  checkpointBackupName,
  checkpointKey,
  worldSandboxId,
  worldName,
} from "./workspace.js";
import {
  INSTANCE_TIERS,
  initialInstanceSize,
  isOutOfMemoryFailure,
  type InstanceSize,
} from "./instance-size.js";
// Side-effect import: this is what registers the socket implementation with
// the conversation DO. Without it the DO falls back to NullConversationHub and
// every non-socket behaviour keeps working — which is the intended revert.
import "./conversation-hub.js";
import {
  HEADER_ISSUER,
  HEADER_OWNER,
  HEADER_SESSION,
  HEADER_SUBJECT,
  HEADER_TOKEN_EXP,
  SUBPROTOCOL,
  isWebSocketUpgrade,
  refuseUpgrade,
  stripStellaHeaders,
  tokenFromSubprotocol,
} from "./conversation-hub.js";
import {
  CLOSE_BAD_REQUEST,
  CLOSE_INTERNAL,
  CLOSE_UNAUTHENTICATED,
} from "./conversation-types.js";
import { verifyConvexToken } from "./auth-jwt.js";
import { handleMuseTranscribeSocket } from "./muse-transcribe-socket.js";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { GATEWAY_NETWORK_POLICY } from "@stella/contracts/gateway/api";
import {
  CONTROL_PLANE_CAPABILITY_AUDIENCE,
  isManagedModelAudience,
  type ManagedModelAudience,
} from "@stella/contracts/gateway/capability";
import {
  mintTurnCapabilities,
  mintTurnCapability,
} from "./capability-signer.js";
import { CLOUD_AGENT_TURN_RESULT_PATH } from "@stella/executor-cloud/agent-turn-result-file";
import type { AgentHistoryRow } from "@stella/executor-cloud/agent-history";
import {
  isCloudBrowserResumeReceipt,
  isCloudBrowserSuspension,
  type CloudBrowserResumeReceipt,
  type CloudBrowserSuspension,
} from "@stella/contracts/cloud-browser";
import { parseOwnerTransferRequest } from "./owner-transfer.js";
import { OwnerTransferArchiveConflictError } from "./owner-transfer.js";
import {
  collectCheckpointRecoveryReferences,
  createOwnerTransferBudget,
  isValidOwnerTransferPrefixPair,
  missingOwnerProductTransferBinding,
  parseOwnerProductTransferRequest,
  replaceOwnerPrefix,
  takeOwnerTransferBatch,
  transferredBackupId,
  type OwnerProductTransferRequest,
  type OwnerTransferBudget,
} from "./owner-product-transfer.js";
import {
  OWNER_TRANSFER_OPERATION_ID_PATTERN,
  createCoordinatorAttempt,
  ownerTransferOperationId,
  parseOwnerTransferControl,
  stableValueMarker,
  type DurableTurnStateWorkspaceTransfer,
  type DurableWorkspaceTransferPlan,
  type OwnerTransferControl,
  type OwnerTransferCoordinatorAttempt,
  type OwnerTransferReservationEnvelope,
  type WorkspacePlanObservation,
} from "./owner-transfer-coordinator.js";
import { OwnerTransferCoordinator } from "./owner-transfer-coordinator-do.js";
import {
  TurnStateProductTransferConflictError,
  advanceDurableTurnStateWorkspaceTransfer,
} from "./turn-state-product-transfer.js";
import {
  isOwnerAppBuildPrefix,
  ownerAppBuildPrefix,
  ownerAppBuildRoot,
  retireTransientAppBuild,
} from "./app-build-artifacts.js";
import {
  HEADER_OWNER_FENCE_ID,
  OWNER_FENCE_LEASE_TTL_MS,
  type OwnerPurgeFence,
  type OwnerPurgeMode,
} from "./owner-fence-do.js";
import { normalizeOwnerGeneration } from "./owner-generation.js";
import { parseConversationEditRequest } from "./conversation-edit-protocol.js";
import {
  conversationEditErrorResponse,
  runConversationEdit,
} from "./conversation-edit-runner.js";
import {
  handleUserCloudHomeRoute,
  type CloudHomeLeaseRunner,
} from "./cloud-home-routes.js";
import {
  CloudHomeStore,
  type CloudSkillCatalogSnapshot,
} from "./cloud-home-store.js";
import { materializeCloudSkillSnapshot } from "./cloud-skill-materializer.js";
import {
  MEMORY_WIPE_PROTOCOL_VERSION,
  MEMORY_WIPE_TARGET_COUNT,
  sweepMemoryWipePage,
} from "./memory-wipe.js";
import {
  EXACT_TURN_CANCELLATIONS_KEY,
  ExactTurnCancellationLedger,
  parseExactTurnCancellationRequest,
  type ExactTurnCancellation,
  type ExactTurnCancellationRequest,
} from "./execution-placement-turn-cancellation.js";
import { devAcceptanceProbesEnabled } from "./dev-acceptance-probes.js";
import { classifyAgentFailureDiagnostic } from "./agent-failure-diagnostic.js";
import { classifyNetwork } from "./network-class.js";
import { executorSessionEnvironment } from "./executor-session-env.js";
import { cloudModelRequestId } from "./cloud-model-request.js";
import {
  APP_BUILD_SESSION_ENV,
  CapturedSessionAbandonedError,
  capturedSessionExec,
  startStrictSessionProcess,
  strictSessionExec,
} from "./strict-session-process.js";
import {
  createTurnRetryCancellation,
  startTurnExecution,
  type TurnExecution,
  type TurnExecutionContext,
  type TurnRetryCancellation,
} from "./turn-cancellation.js";
import {
  TURN_BROKER_HEADERS,
  TURN_BROKER_RESPONSE_HEADERS,
} from "@stella/contracts/turn-credential-broker";
import {
  TURN_BROKER_MAX_TTL_MS,
  TurnBrokerBodyTooLargeError,
  claimTurnBrokerRequest,
  forwardTurnBrokerRequest,
  issueTurnBrokerCredential,
  preflightTurnBrokerRequest,
  readTurnBrokerRequestBody,
  revokeTurnBrokerCredential,
  turnBrokerDenialResponse,
  turnBrokerSandboxResponseHeaders,
  turnBrokerStorageKey,
  turnBrokerTargetMatchesEngine,
  validateTurnBrokerTarget,
  type TurnBrokerLiveFence,
  type TurnBrokerRecord,
  type TurnBrokerTarget,
} from "./turn-credential-broker.js";
import {
  type TurnStateTransferActivationResponse,
  type TurnStateTransferDestinationStatus,
  type TurnStateTransferExportResponse,
  type TurnStateTransferManifest,
  type TurnStateTransferRetireResponse,
} from "./turn-state-owner-routes.js";
import {
  restoreTurnStateArchive,
  uploadTurnStateArchive,
} from "./turn-state-archive.js";
import {
  parseTurnStateCheckpointRequest,
  publicTurnStateCheckpointReceipt,
  replaceTurnStateArchiveSession,
} from "./turn-state-checkpoint.js";
import type {
  PreparedTurnStateOperation,
  ResolvedTurnState,
  TurnStateArchive,
  TurnStateCandidate,
  TurnStateWorkspaceHead,
} from "./turn-state-registry.js";
import type {
  TurnBrokerInteriorBuildRequestReceipt,
  TurnBrokerTurnStateCheckpointReceipt,
  TurnBrokerTurnStateCheckpointRequest,
} from "@stella/contracts/turn-credential-broker";
import {
  exactInteriorBuildRequested,
  interiorBuildRequestKey,
  interiorBuildRequestRecord,
  parseInteriorBuildRequest,
  type InteriorBuildRequestRecord,
} from "./interior-build-request.js";
import {
  parseTurnComputePlan,
  requiresExactThreadCandidate,
  runGeneralAgentTurn,
  runResidentStellaLoop,
  turnComputePlan,
  turnComputePlanKey,
  type GeneralAgentTurnPlan,
  type GeneralAgentTurnResult,
  type TurnComputePlan,
  type TurnDurability,
} from "./general-agent-turn.js";
import {
  agentComputeKey,
  createAgentComputeLadder,
  parsePersistedAgentCompute,
  type PersistedAgentCompute,
} from "./agent-compute-ladder.js";
import {
  advanceSandboxDestroyDebt,
  clearSandboxDestroyDebt,
  createSandboxDestroyDebt,
  isSandboxDestroyDebtKey,
  isSandboxDestroyDue,
  listSandboxDestroyDebts,
  persistSandboxDestroyDebt,
  readSandboxDestroyDebt,
  sandboxDestroyDebtKey,
  SandboxLifecycleDeferredError,
  sandboxLifecycleFailureFields,
  sandboxLifecycleId,
  SANDBOX_WORKLOADS,
  type SandboxDestroyDebt,
  type SandboxTarget,
  type SandboxWorkload,
} from "./sandbox-lifecycle.js";
import {
  PREVIEW_ACCESS_MAX_TTL_MS,
  PREVIEW_ACCESS_STORAGE_KEY,
  issuePreviewAccessCapability,
  previewSafeRequestLogPath,
  resolvePreviewTunnelRequest,
  verifyPreviewAccessCapability,
  verifyPreviewAccessRouteCapability,
} from "./vite-preview-access.js";
import {
  issueWorldCapability,
  verifyWorldCapability,
  worldCapabilityFromRequest,
} from "./world-capability.js";
import type { WorldListingEntry } from "./world/types.js";
import {
  CLOUD_BUILDER_BODY_LIMITS,
  boundedBodyStatus,
  bufferBoundedJsonRequest,
  publicJsonBodyLimit,
  serviceJsonBodyLimit,
} from "./request-ingress.js";
import {
  BoundedBodyError,
  readBoundedRequestText,
  readBoundedResponseBytes,
} from "./bounded-body.js";
import {
  R2TransferTransformTooLargeError,
  r2TransferBody,
  type R2TransferTransform,
} from "./r2-transfer-body.js";
import { verifyServiceBearerRequest } from "./service-bearer.js";
import { evaluateCloudBuilderReadiness } from "./readiness.js";
import { createAgentSandboxAttachment } from "./agent-sandbox-attachment.js";
import {
  AgentTurnJournal,
  type SealedTurnTranscript,
} from "./agent-turn-journal.js";
import { createAgentControlPlane } from "./agent-control-plane.js";
import { createGeneralAgentDoLocalTools } from "./general-agent-do-local-tools.js";
import { createResidentGeneralAgentTools } from "./general-agent-tools.js";
import { createBuildSessionAgentControl } from "./build-session-agent-control.js";
import {
  rememberCloudAgentControlReceipt,
  steerCloudAgent,
  type CloudAgentDispatchDependencies,
} from "./cloud-agent-dispatch.js";
import { SteerMailbox, parseSteerMessage } from "./steer-mailbox.js";
import { createCloudCodeAgentTool } from "./cloud-code-tool.js";
import { CODE_TOOL_NAME } from "@stella/runtime/kernel/tools/defs/code-def.js";
import {
  EMPTY_NATIVE_HISTORY_CURSOR,
  NATIVE_STATE_DIRECTORY,
  emptyNativeStateCheckpointRecord,
  nativeHistoryCursorFromRows,
  nativeStateBackupName,
  nativeStateCheckpointKey,
  nativeStateCheckpointPrefix,
  nativeStateCheckpointReceipt,
  parseNativeStateCheckpointPayload,
  parseNativeStateCheckpointRecord,
  publicNativeStateCheckpointReceipt,
  resolveNativeStateCheckpoint,
  stageNativeStateCheckpoint,
  validNativeStateCheckpointMac,
  type NativeStateCheckpointRecord,
  type NativeStateCheckpointReceipt,
  type NativeStateCheckpointVersion,
} from "./native-state-checkpoint.js";

import type { BuildSessionInternals } from "./build-session/host.js";
import type { Env } from "./build-session/shared/env.js";
import type {
  AgentComputeRecoveryClaim,
  AgentExecutionMarker,
  AgentExecutorResult,
  AppTurnAdmissionClaim,
  BuildOwnerFenceLeaseReceipt,
  BuildOwnerFenceLeaseSlot,
  BuilderFallbackInput,
  BuilderFallbackTranscript,
  ConversationCaller,
  DispatchCaller,
  Execution,
  ExecutorResult,
  InteriorBuildOutput,
  NativeTransientBackup,
  ObservedBrowserSuspension,
  OwnerPurgeReport,
  OwnerPurgeRequest,
  OwnerTransferCoordinatorContext,
  PendingAppBuildPublication,
  PendingBrowserSuspension,
  PendingTerminal,
  TurnRequest,
  TurnStateCheckpointOperation,
  WorkspaceBackupDebt,
  WorkspaceCheckpointImports,
} from "./build-session/shared/types.js";
import {
  AgentTurnAuthorityLostError,
  AgentTurnError,
  AppTurnAuthorityLostError,
  BrowserGatewayResponseTooLargeError,
  OwnerProductTransferConfigurationError,
  OwnerProductTransferConflictError,
  OwnerPurgeFenceError,
  TurnStateOwnerCallError,
} from "./build-session/shared/errors.js";
import {
  AGENT_RECOVERY_PENDING_KEY,
  AGENT_TURN_HEARTBEAT_MS,
  AGENT_WATCHDOG_DEADLINE_KEY,
  APP_TURN_ADMISSION_CLAIM_KEY,
  BUILDER_FALLBACK_MAX_RETRIES,
  BUILD_OWNER_FENCE_LEASE_RECEIPT_PREFIX,
  BUILD_OWNER_FENCE_LEASE_SLOT_PREFIX,
  CLOUD_TURN_SOURCES,
  OBSERVED_BROWSER_SUSPENSION_KEY,
  OUTBOX_DEBT_KEY,
  OUTBOX_DEBT_MAX,
  OUTBOX_DEBT_RETRY_MS,
  OWNER_FENCE_LEASE_RETRY_MS,
  OWNER_GATE_REFUSAL_STATUS,
  OWNER_PURGE_STALE_LEASE_GRACE_MS,
  PENDING_BROWSER_SUSPENSION_KEY,
  TERMINAL_EVENT_STATUS,
  agentComputeRecoveryClaimKey,
  agentExecutionMarkerKey,
  agentRecoveryIdentity,
  backupDebtKey,
  buildOwnerFenceLeaseReceiptKey,
  builderFallbackRetryKey,
  builderFallbackTranscriptKey,
  checkpointImportsKey,
  contentType,
  conversationName,
  errorMessage,
  exactTurnIdentityMatches,
  executionFailureFields,
  isBuildOwnerFenceDurabilityKey,
  json,
  log,
  nativeBackupDebtKey,
  nativeStateIntegrityKeyFor,
  nativeTransientBackupKey,
  pendingAppBuildPublicationKey,
  sessionName,
  turnDispatchIdentity,
  turnStateBaseWorkspaceRevisionKey,
  turnStateCheckpointOperationKey,
  withInfrastructureDeadline,
  workspaceTransferReceiptsKey,
} from "./build-session/shared/keys.js";
import {
  AGENT_HISTORY_RESPONSE_MAX_BYTES,
  abortUnpublishedTurnStateOperation,
  bindObservedBrowserSuspensionToCanonicalCodeCall,
  cloudBrowserSuspensionMarker,
  confirmAgentTurnStateRestore,
  exactTurnStateCheckpointOperations,
  executeTurnStateCheckpoint,
  handleTurnBroker,
  publishAgentTurnWorkspace,
  resolveAgentTurnState,
  turnBrokerCredentialsPath,
  validTurnStateCheckpointReceipt,
} from "./build-session/turn-broker.js";

export type { ObservedBrowserSuspension } from "./build-session/shared/types.js";
export { bindObservedBrowserSuspensionToCanonicalCodeCall };

export { ContainerProxy };
export { OrchestratorSession };
export { OwnerTransferCoordinator };
export { OwnerGate };
export { WorldStore } from "./world-store.js";

/** Existing large general-agent namespace, retained migration-compatibly. */
export class Sandbox extends GeneralAgentSandbox<Env> {}
Sandbox.outbound = generalAgentEgress;

/**
 * The small rung of the instance ladder. Container size is declared per class
 * in wrangler.jsonc and cannot be chosen per request, so a second class over
 * the same image is the only way to run a cheap turn cheaply. Behaviorally
 * identical to `Sandbox`.
 */
export class SandboxSmall extends GeneralAgentSandbox<Env> {}
SandboxSmall.outbound = generalAgentEgress;

/** Permanently offline app-build namespace with baked dependencies. */
export class AppBuildSandbox extends AppBuildSandboxBase<Env> {}
AppBuildSandbox.outbound = appBuildEgress;

/** Container states in which a process sweep reaches a running process. */
const SANDBOX_RUNNING_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "healthy",
]);

/** Idle timeout for an unpinned shared world or app-build container. */
const sandboxSleepAfterMs = (
  env: Pick<Env, "SANDBOX_IDLE_TIMEOUT_MS">,
): number | undefined => {
  const value = Number(env.SANDBOX_IDLE_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

/**
 * One unpinned sandbox handle per exact tuple. Size selects the namespace as
 * much as the id does: the classes are separate namespaces, so a handle built
 * for the wrong size silently addresses a different container.
 */
const sandboxHandle = (env: Env, target: SandboxTarget) => {
  const namespace =
    target.workload === "app-build"
      ? env.APP_BUILD_SANDBOX
      : target.size === "small" && env.SANDBOX_SMALL
        ? env.SANDBOX_SMALL
        : env.Sandbox;
  const sleepAfter = sandboxSleepAfterMs(env);
  return getSandbox(namespace, target.sandboxId, {
    transport: "rpc",
    enableDefaultSession: false,
    keepAlive: false,
    ...(sleepAfter === undefined ? {} : { sleepAfter }),
    normalizeId: true,
    containerTimeouts: {
      instanceGetTimeoutMS: 60_000,
      portReadyTimeoutMS: 120_000,
    },
    labels: { service: "stella-v2", workload: target.workload },
  });
};

/** Every id this worker mints: a lifecycle fingerprint or a diagnostic echo. */
const RETIRE_SANDBOX_ID =
  /^(?:(?:world|app)-[0-9a-f]{40}|echo-[0-9a-f-]{36})$/u;

/**
 * Retire one container by its exact tuple, for the inventory reaper. There is
 * no per-instance stop in Wrangler or the public API and only the sandbox
 * object holds the container handle, so the reaper's adapter posts the tuple
 * here and the worker destroys it. Never guesses a namespace from the id.
 */
const retireSandboxInstance = async (
  env: Env,
  request: Request,
): Promise<Response> => {
  const raw = (await request.json().catch(() => null)) as unknown;
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const sandboxId = typeof body.sandboxId === "string" ? body.sandboxId : "";
  const size = body.size;
  const workload = body.workload;
  if (
    !RETIRE_SANDBOX_ID.test(sandboxId) ||
    (size !== "small" && size !== "large") ||
    typeof workload !== "string" ||
    !(SANDBOX_WORKLOADS as readonly string[]).includes(workload) ||
    (sandboxId.startsWith("world-") && workload !== "world") ||
    (!sandboxId.startsWith("world-") && workload !== "app-build")
  ) {
    return json({ ok: false, reason: "invalid_target" }, 400);
  }
  const target: SandboxTarget = {
    sandboxId,
    size,
    workload: workload as SandboxWorkload,
  };
  const sandbox = sandboxHandle(env, target);
  try {
    await withInfrastructureDeadline(
      sandbox.destroy(),
      30_000,
      "Sandbox destruction did not settle.",
    );
  } catch (error) {
    const failure = sandboxLifecycleFailureFields(error);
    log("error", "sandbox_operator_destroy_failed", {
      workload: target.workload,
      instanceSize: target.size,
      ...failure,
    });
    return json(
      {
        ok: false,
        reason: "destroy_failed",
        target,
        ...failure,
      },
      502,
    );
  }
  log("info", "sandbox_retired_by_operator", {
    workload: target.workload,
    instanceSize: target.size,
  });
  return json({ ok: true, target });
};

/**
 * App-build turns are dispatched without a pinned execution — the art
 * director's model is Convex's own choice, resolved through `/api/cloud/model`
 * — but a turn capability's binding is not optional. This placeholder is what
 * the lane's control-plane capability carries. It is never minted for the
 * model-gateway audience, so it can never pin a model call.
 */
const APP_BUILD_CONTROL_PLANE_EXECUTION = {
  engine: "stella",
  provider: "stella",
  model: "app-build",
  reasoningEffort: "default",
} as CloudExecutionSelection;

/**
 * Mint the model-gateway capability for one admitted agent turn. It is the
 * only credential the sandbox or resident loop presents for model calls:
 * turn-scoped, pinned to the admitted execution, budgeted, expiring, and
 * meaningless anywhere but the gateway. The reusable Convex turn token never
 * accompanies model traffic.
 */
const mintAgentTurnModelGateway = async (
  env: Pick<
    Env,
    "MODEL_GATEWAY_URL" | "CAPABILITY_SIGNING_KEY" | "CAPABILITY_SIGNING_KID"
  >,
  turn: TurnRequest,
  execution: CloudExecutionSelection,
): Promise<{ origin: string; capability: string; expiresAt: number }> => {
  const origin = env.MODEL_GATEWAY_URL?.trim() ?? "";
  if (!origin) throw new Error("Model gateway is not configured.");
  if (!turn.conversationId) throw new AgentTurnAuthorityLostError();
  const minted = await mintTurnCapability(env, {
    ownerId: turn.ownerId,
    ownerGeneration: turn.ownerGeneration,
    turnId: turn.turnId,
    conversationId: turn.conversationId,
    execution,
    audience: turn.audience,
    budgetMicroCents: turn.budgetMicroCents,
    agentTypes: ["general"],
  });
  return { origin, capability: minted.token, expiresAt: minted.expiresAt };
};

const INTERIOR_BRIDGE_ABI = 1;
const INTERIOR_MIN_SHELL_VERSION = "0.0.0";
const INTERIOR_MAX_FILES = 2_000;
const INTERIOR_MAX_BYTES = 100 * 1024 * 1024;
const INTERIOR_MAX_FILE_BYTES = 25 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_ARTIFACT_PATH =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// The user-authenticated conversation surfaces
//
// Every other route on this worker is server-to-server and gated by the shared
// service secret. These two are the exception: they carry a signed-in user's
// Convex JWT, which is NOT the service secret, so they are matched before that
// gate. Verification happens here rather than in the Durable Object so an
// unauthenticated connect never instantiates one, never takes a socket slot,
// and never touches the agent's thread.
// ---------------------------------------------------------------------------

const ORCHESTRATOR_INTERNAL_ORIGIN = "https://orchestrator-session";
const HEADER_CONVERSATION_ID = "x-stella-conversation-id";
const HEADER_BUILD_SESSION_NAME = "x-stella-build-session-name";
const HEADER_TURN_BROKER_ENDPOINT = "x-stella-turn-broker-endpoint";
const HEADER_PREVIEW_BASE_URL = "x-stella-preview-base-url";
const HEADER_PREVIEW_CAPABILITY = "x-stella-preview-capability";
/**
 * Verify the caller. `wantsSocket` decides only how a refusal is shaped: a
 * WebSocket client that gets an HTTP 4xx before the 101 sees close code 1006
 * and cannot tell "refresh your token" from "the network dropped" — opposite
 * responses — so refusals there complete the handshake and close with a real
 * code instead.
 */
const authenticateConversationCaller = async (
  request: Request,
  env: Env,
  wantsSocket: boolean,
  requestId: string,
): Promise<
  { ok: true; caller: ConversationCaller } | { ok: false; response: Response }
> => {
  const issuer = (env.STELLA_CONVEX_SITE_URL ?? "").trim().replace(/\/+$/, "");
  const deny = (
    closeCode: number,
    status: number,
    message: string,
    retryable: boolean,
  ): { ok: false; response: Response } => ({
    ok: false,
    response: wantsSocket
      ? refuseUpgrade(request, closeCode, message, {
          retryable,
          ref: requestId,
        })
      : json({ error: message, retryable, ref: requestId }, status),
  });

  if (!issuer) {
    // Fail closed and loudly. The alternative — treating a missing issuer as
    // "skip verification" — is how an auth check becomes optional in practice.
    log("error", "conversation_auth_unconfigured", { requestId });
    return deny(
      CLOSE_INTERNAL,
      503,
      "Stella can't open live conversations right now. Try again shortly.",
      true,
    );
  }

  let token = "";
  if (wantsSocket) {
    // The JWT rides in Sec-WebSocket-Protocol, never the query string:
    // browsers and React Native cannot set WebSocket request headers, and a
    // URL is the one part of a request that gets logged everywhere.
    const offer = tokenFromSubprotocol(request);
    if (!offer.offered) {
      return deny(CLOSE_BAD_REQUEST, 400, "Unsupported client.", false);
    }
    token = offer.token;
  } else {
    const header = request.headers.get("authorization") ?? "";
    if (header.startsWith("Bearer ")) token = header.slice(7).trim();
  }
  if (!token) {
    return deny(
      CLOSE_UNAUTHENTICATED,
      401,
      "Sign in to open this conversation.",
      false,
    );
  }

  const verified = await verifyConvexToken(token, issuer);
  if (!verified.ok) {
    // The reason is a log-only discriminator; the caller is told one thing.
    log("error", "conversation_auth_rejected", {
      requestId,
      reason: verified.reason,
    });
    return verified.retryable
      ? deny(
          CLOSE_INTERNAL,
          503,
          "Stella couldn't check your sign-in. Try again shortly.",
          true,
        )
      : deny(
          CLOSE_UNAUTHENTICATED,
          401,
          "Your sign-in expired. Sign in again to continue.",
          false,
        );
  }
  return { ok: true, caller: { ...verified.token, issuer } };
};

const refusesAnonymousNetwork = async (
  request: Request,
  env: Env,
): Promise<boolean> => {
  const networkClass = await classifyNetwork(request, env.ASN_POLICY);
  return GATEWAY_NETWORK_POLICY.anonymousRefused.some(
    (refused) => refused === networkClass,
  );
};

const forwardToConversation = async (
  request: Request,
  env: Env,
  conversationId: string,
  doPath: string,
  caller: ConversationCaller,
): Promise<Response> => {
  const source = new URL(request.url);
  const target = new URL(ORCHESTRATOR_INTERNAL_ORIGIN);
  target.pathname = doPath;
  target.search = source.search;
  const forwarded = new Request(target.toString(), request);
  // A client must never be able to assert its own identity to the DO. This
  // strip is one line and its absence is a full account-takeover, so it comes
  // before every header we then set.
  stripStellaHeaders(forwarded.headers);
  forwarded.headers.set(HEADER_OWNER, caller.ownerId);
  forwarded.headers.set(HEADER_SUBJECT, caller.subject);
  if (caller.sessionId) forwarded.headers.set(HEADER_SESSION, caller.sessionId);
  forwarded.headers.set(HEADER_TOKEN_EXP, String(caller.expiresAtMs));
  forwarded.headers.set(HEADER_ISSUER, caller.issuer);
  forwarded.headers.set(HEADER_CONVERSATION_ID, conversationId);
  forwarded.headers.delete("authorization");
  try {
    // The token has done its job. Keep the offer so the DO can echo a valid
    // subprotocol, but drop the bearer half so it cannot reach a log line.
    if (forwarded.headers.has("sec-websocket-protocol")) {
      forwarded.headers.set("sec-websocket-protocol", SUBPROTOCOL);
    }
  } catch {
    // Some runtimes guard Sec-* headers. Losing the scrub is acceptable —
    // the DO is inside the same trust boundary — but it is never fatal.
  }
  return await env.ORCHESTRATOR_SESSIONS.getByName(conversationId).fetch(
    forwarded,
  );
};

/**
 * `POST /conversations/:id/turns`: the one route both a signed-in user's JWT
 * and the service secret open. The Worker verifies the caller and does the
 * cheap refusals (shape, service-only fields); every admission decision is
 * the conversation Durable Object's. Identity reaches it on trusted headers
 * — never from the body, which cannot name an owner at all.
 */
const handleTurnStartRoute = async (
  request: Request,
  env: Env,
  segment: string,
  requestId: string,
): Promise<Response> => {
  const conversationId = conversationName(segment);
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    return turnStartErrorResponse(
      "bad_request",
      "conversationId must be 8-128 URL-safe characters.",
      false,
    );
  }
  let ownerId: string;
  let authKind: TurnAuthKind;
  let ownerGeneration: string | null = null;
  let tokenExpiresAtMs: number | null = null;
  if (await verifyServiceBearerRequest(request, env.BUILDER_SERVICE_SECRET)) {
    // Convex-originated: a schedule fire, placement's cloud branch, an
    // agent-completion wake. It names the owner it acts for and pins the
    // generation it read; the gate refuses a stale one.
    const headerOwner = request.headers.get(TURN_OWNER_ID_HEADER)?.trim() ?? "";
    ownerGeneration = normalizeOwnerGeneration(
      request.headers.get(TURN_OWNER_GENERATION_HEADER),
    );
    if (!headerOwner || headerOwner.length > 512 || !ownerGeneration) {
      return turnStartErrorResponse(
        "bad_request",
        `Service callers must send ${TURN_OWNER_ID_HEADER} and ${TURN_OWNER_GENERATION_HEADER}.`,
        false,
      );
    }
    ownerId = headerOwner;
    authKind = "service";
  } else {
    const auth = await authenticateConversationCaller(
      request,
      env,
      false,
      requestId,
    );
    if (!auth.ok) {
      // Re-shaped to the turn-start contract; the socket-oriented refusal
      // already logged the discriminator.
      const status = auth.response.status;
      await auth.response.body?.cancel().catch(() => undefined);
      return status === 503
        ? turnStartErrorResponse(
            "internal",
            "Stella couldn't check your sign-in. Try again shortly.",
            true,
          )
        : turnStartErrorResponse(
            "unauthorized",
            "Sign in to send messages.",
            false,
          );
    }
    if (
      auth.caller.isAnonymous &&
      (await refusesAnonymousNetwork(request, env))
    ) {
      return turnStartErrorResponse(
        "sign_in_required",
        "Sign in to Stella to continue from this network.",
        false,
      );
    }
    ownerId = auth.caller.ownerId;
    tokenExpiresAtMs = auth.caller.expiresAtMs;
    authKind = "user";
  }
  let text: string;
  try {
    text = await readBoundedRequestText(
      request,
      CLOUD_BUILDER_BODY_LIMITS.turn,
      { requireBody: true },
    );
  } catch (error) {
    const status = boundedBodyStatus(error);
    if (status === null) throw error;
    return turnStartErrorResponse(
      "bad_request",
      status === 413 ? "Request body is too large." : "Malformed request body.",
      false,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return turnStartErrorResponse(
      "bad_request",
      "Malformed JSON request.",
      false,
    );
  }
  const parsed = parseCloudTurnStartRequest(body);
  if (!parsed.ok) {
    return turnStartErrorResponse("bad_request", parsed.message, false);
  }
  if (authKind === "user") {
    const restricted = serviceOnlyTurnFields(parsed.request);
    if (restricted.length > 0) {
      return turnStartErrorResponse(
        "forbidden",
        `${restricted.join(", ")} require service authentication.`,
        false,
      );
    }
  }
  // Built from scratch rather than cloned: nothing of the caller's headers
  // may reach the DO, and the trusted identity is exactly these four.
  const headers = new Headers({ "content-type": "application/json" });
  headers.set(HEADER_OWNER, ownerId);
  headers.set(HEADER_TURN_AUTH_KIND, authKind);
  headers.set(HEADER_CONVERSATION_ID, conversationId);
  if (ownerGeneration)
    headers.set(TURN_OWNER_GENERATION_HEADER, ownerGeneration);
  if (tokenExpiresAtMs !== null) {
    headers.set(HEADER_TOKEN_EXP, String(tokenExpiresAtMs));
  }
  const response = await env.ORCHESTRATOR_SESSIONS.getByName(
    conversationId,
  ).fetch(`${ORCHESTRATOR_INTERNAL_ORIGIN}/turn`, {
    method: "POST",
    headers,
    body: text,
  });
  log("info", "conversation_turn_start", {
    requestId,
    authKind,
    lane: parsed.request.lane ?? "chat",
    status: response.status,
  });
  return response;
};

/**
 * `GET /owners/me/devices/:deviceId/presence`. The device's socket lands on
 * its owner's gate, which is where presence, offers, and claims all live —
 * the JWT proves the account, the Ed25519 proof inside the socket proves the
 * device.
 */
const forwardToDevicePresence = async (
  request: Request,
  env: Env,
  deviceId: string,
  caller: ConversationCaller,
): Promise<Response> => {
  const forwarded = new Request("https://owner-gate/presence", request);
  stripStellaHeaders(forwarded.headers);
  forwarded.headers.set(HEADER_OWNER, caller.ownerId);
  forwarded.headers.set(HEADER_TOKEN_EXP, String(caller.expiresAtMs));
  forwarded.headers.set(HEADER_PRESENCE_DEVICE_ID, deviceId);
  forwarded.headers.delete("authorization");
  try {
    forwarded.headers.set("sec-websocket-protocol", SUBPROTOCOL);
  } catch {
    // Some runtimes guard Sec-* headers. The DO is in the same trust boundary.
  }
  return await env.OWNER_GATES.getByName(caller.ownerId).fetch(forwarded);
};

const handleDispatchSubmitRoute = async (
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> => {
  let caller: DispatchCaller;
  if (await verifyServiceBearerRequest(request, env.BUILDER_SERVICE_SECRET)) {
    const ownerId = request.headers.get(TURN_OWNER_ID_HEADER)?.trim() ?? "";
    const ownerGeneration = normalizeOwnerGeneration(
      request.headers.get(TURN_OWNER_GENERATION_HEADER),
    );
    if (!ownerId || ownerId.length > 512 || !ownerGeneration) {
      return dispatchErrorResponse(
        "bad_request",
        `Service callers must send ${TURN_OWNER_ID_HEADER} and ${TURN_OWNER_GENERATION_HEADER}.`,
        false,
      );
    }
    caller = { kind: "service", ownerId, ownerGeneration };
  } else {
    const auth = await authenticateConversationCaller(
      request,
      env,
      false,
      requestId,
    );
    if (!auth.ok) {
      const status = auth.response.status;
      await auth.response.body?.cancel().catch(() => undefined);
      return status === 503
        ? dispatchErrorResponse(
            "internal",
            "Stella couldn't check your sign-in. Try again shortly.",
            true,
          )
        : dispatchErrorResponse(
            "unauthorized",
            "Sign in to run this somewhere.",
            false,
          );
    }
    caller = {
      kind: "user",
      ownerId: auth.caller.ownerId,
      isAnonymous: auth.caller.isAnonymous,
    };
  }
  if (
    caller.kind !== "service" &&
    caller.isAnonymous &&
    (await refusesAnonymousNetwork(request, env))
  ) {
    return dispatchErrorResponse(
      "sign_in_required",
      "Sign in to Stella to continue from this network.",
      false,
    );
  }
  let text: string;
  try {
    text = await readBoundedRequestText(
      request,
      CLOUD_BUILDER_BODY_LIMITS.turn,
      { requireBody: true },
    );
  } catch (error) {
    const status = boundedBodyStatus(error);
    if (status === null) throw error;
    return dispatchErrorResponse(
      "bad_request",
      status === 413 ? "Request body is too large." : "Malformed request body.",
      false,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return dispatchErrorResponse(
      "bad_request",
      "Malformed JSON request.",
      false,
    );
  }
  const parsed = parseDispatchSubmitRequest(body);
  if (!parsed.ok) {
    return dispatchErrorResponse("bad_request", parsed.message, false);
  }
  if (
    caller.kind !== "service" &&
    caller.isAnonymous &&
    parsed.request.kind === "agent"
  ) {
    return dispatchErrorResponse(
      "sign_in_required",
      "Sign in to Stella to use cloud agents.",
      false,
    );
  }
  let submitted: DispatchSubmitRequest = parsed.request;
  const gate = env.OWNER_GATES.getByName(caller.ownerId);

  if (caller.kind === "user" && hasMobilePairingProofHeaders(request.headers)) {
    // A phone has no device key the cloud can verify; the pairing key in the
    // owner snapshot is what stands in for one. The challenge is rebuilt from
    // the request the worker is about to act on, so a proof minted for other
    // bytes cannot authorize these.
    const fields = readMobilePairingProofHeaders(request.headers);
    if (!fields) {
      return dispatchErrorResponse(
        "forbidden",
        "This phone credential is incomplete.",
        false,
      );
    }
    let snapshot: OwnerSnapshot;
    try {
      snapshot = await gate.snapshot();
    } catch {
      return dispatchErrorResponse(
        "internal",
        "Stella can't check your pairing right now. Try again shortly.",
        true,
      );
    }
    const pairing = (snapshot.pairedDevices ?? []).find(
      (candidate) =>
        candidate.mobileDeviceId === fields.mobileDeviceId &&
        candidate.desktopDeviceId === fields.desktopDeviceId,
    );
    const payloadHash = await pairingSha256Hex(
      canonicalDispatchPayloadJson(submitted.payload),
    );
    const verified = await verifyMobilePairingProof({
      fields,
      publicKey: pairing?.mobilePublicKey,
      expectedChallenge: buildMobilePairingChallenge({
        idempotencyKey: submitted.idempotencyKey,
        conversationId: submitted.conversationId,
        payloadHash,
        kind: submitted.kind,
        subject: submitted.subject,
        ...(submitted.targetMode !== undefined
          ? { targetMode: submitted.targetMode }
          : {}),
        ...(submitted.targetDeviceId
          ? { targetDeviceId: submitted.targetDeviceId }
          : {}),
      }),
    });
    if (!verified.ok) {
      log("error", "dispatch_pairing_proof_rejected", {
        requestId,
        reason: verified.reason,
      });
      return dispatchErrorResponse(
        "forbidden",
        "This phone credential is invalid.",
        false,
      );
    }
    caller = {
      kind: "mobile",
      ownerId: caller.ownerId,
      isAnonymous: caller.isAnonymous,
      mobileDeviceId: verified.mobileDeviceId,
      desktopDeviceId: verified.desktopDeviceId,
    };
    submitted = {
      ...submitted,
      ingress: "mobile",
      requestingDeviceId: verified.mobileDeviceId,
    };
  } else if (
    caller.kind === "user" &&
    submitted.ingress !== "desktop" &&
    submitted.ingress !== "browser"
  ) {
    return dispatchErrorResponse(
      "forbidden",
      `${submitted.ingress} ingress requires service authentication or a paired phone credential.`,
      false,
    );
  }

  let result: Awaited<ReturnType<OwnerGate["submit"]>>;
  try {
    result = await gate.submit({
      request: submitted,
      ...(caller.kind === "service"
        ? { expectedGeneration: caller.ownerGeneration }
        : {}),
      ...(caller.kind === "mobile"
        ? { pairGrantDeviceId: caller.desktopDeviceId }
        : {}),
    });
  } catch (error) {
    log("error", "dispatch_submit_failed", {
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    return dispatchErrorResponse(
      "internal",
      "Stella can't place this right now. Try again shortly.",
      true,
    );
  }
  if (!result.ok) {
    return dispatchErrorResponse(
      result.error.code,
      result.error.message,
      result.error.retryable,
      result.error.retryAfterMs,
    );
  }
  log("info", "dispatch_submitted", {
    requestId,
    ingress: submitted.ingress,
    kind: submitted.kind,
    state: result.response.dispatch.state,
    replayed: result.response.replayed,
  });
  return Response.json(result.response, {
    status: result.response.replayed ? 200 : 201,
    headers: { "cache-control": "no-store" },
  });
};

/**
 * Status and cancel. Both are owner-bound: the gate is addressed by the owner
 * the caller proved, so a dispatch id from another account simply is not in
 * this object and answers `not_found`.
 */
const handleDispatchControlRoute = async (
  request: Request,
  env: Env,
  dispatchId: string,
  action: "status" | "cancel",
  requestId: string,
): Promise<Response> => {
  let ownerId: string;
  if (await verifyServiceBearerRequest(request, env.BUILDER_SERVICE_SECRET)) {
    ownerId = request.headers.get(TURN_OWNER_ID_HEADER)?.trim() ?? "";
    if (!ownerId || ownerId.length > 512) {
      return dispatchErrorResponse(
        "bad_request",
        `Service callers must send ${TURN_OWNER_ID_HEADER}.`,
        false,
      );
    }
  } else {
    const auth = await authenticateConversationCaller(
      request,
      env,
      false,
      requestId,
    );
    if (!auth.ok) {
      const status = auth.response.status;
      await auth.response.body?.cancel().catch(() => undefined);
      return status === 503
        ? dispatchErrorResponse(
            "internal",
            "Stella couldn't check your sign-in. Try again shortly.",
            true,
          )
        : dispatchErrorResponse("unauthorized", "Sign in to continue.", false);
    }
    ownerId = auth.caller.ownerId;
  }
  const gate = env.OWNER_GATES.getByName(ownerId);
  try {
    if (action === "status") {
      const status = await gate.dispatchStatus(dispatchId);
      return status.ok
        ? Response.json(status.response, {
            headers: { "cache-control": "no-store" },
          })
        : dispatchErrorResponse(
            status.error.code,
            status.error.message,
            status.error.retryable,
          );
    }
    let raw: { cancelRequestId?: unknown; reason?: unknown } | null = null;
    try {
      raw = JSON.parse(
        await readBoundedRequestText(
          request,
          CLOUD_BUILDER_BODY_LIMITS.tinyControl,
          { requireBody: true },
        ),
      ) as { cancelRequestId?: unknown; reason?: unknown };
    } catch (error) {
      const status = boundedBodyStatus(error);
      return dispatchErrorResponse(
        "bad_request",
        status === 413
          ? "Request body is too large."
          : "Malformed JSON request.",
        false,
      );
    }
    const cancelRequestId =
      typeof raw?.cancelRequestId === "string"
        ? raw.cancelRequestId.trim()
        : "";
    if (!cancelRequestId || cancelRequestId.length > 128) {
      return dispatchErrorResponse(
        "bad_request",
        "cancelRequestId is required.",
        false,
      );
    }
    const canceled = await gate.cancelDispatch({
      dispatchId,
      cancelRequestId,
      ...(typeof raw?.reason === "string" && raw.reason.trim()
        ? { reason: raw.reason.trim() }
        : {}),
    });
    return canceled.ok
      ? Response.json(canceled.response, {
          headers: { "cache-control": "no-store" },
        })
      : dispatchErrorResponse(
          canceled.error.code,
          canceled.error.message,
          canceled.error.retryable,
        );
  } catch (error) {
    log("error", "dispatch_control_failed", {
      requestId,
      action,
      message: error instanceof Error ? error.message : String(error),
    });
    return dispatchErrorResponse(
      "internal",
      "Stella can't reach this dispatch right now. Try again shortly.",
      true,
    );
  }
};

const exactTurnSandboxId = async (
  prefix: "app",
  turn: TurnRequest,
): Promise<string> =>
  await sandboxLifecycleId(prefix, {
    ownerId: turn.ownerId,
    ownerGeneration: turn.ownerGeneration,
    turnId: turn.turnId,
    attemptGeneration:
      turn.kind === "agent" ? (turn.attemptGeneration ?? 0) : 1,
  });

/**
 * The two directories a model-shaped process may own. `world` is the owner's
 * checkpointed tree; `app` is the throwaway build root of the legacy app-build
 * turn, which is never checkpointed.
 */
const TOOL_WORKSPACE_ROOTS = new Set([WORLD_ROOT, APP_BUILD_ROOT]);

/**
 * Run a strict (`set -eu`) script without leaving those options behind in
 * the session's persistent shell. The subshell's exit status is the script's.
 * Defined in `shell-subshell.ts` so the checkpoint archive scripts share it
 * without importing this module.
 */
export { inSubshell };

/** Establish the post-mount fixed boundary before any model-shaped process. */
export const normalizeToolWorkspaceRoot = async (
  session: Pick<ExecutionSession, "exec">,
  workspaceRoot: string,
): Promise<void> => {
  if (!TOOL_WORKSPACE_ROOTS.has(workspaceRoot)) {
    throw new Error("Invalid cloud workspace mount path.");
  }
  const command = [
    "set -eu",
    "test ! -L /workspace",
    'test "$(readlink -f /workspace)" = /workspace',
    "test \"$(stat -c '%u:%g:%a' /workspace)\" = 0:42424:750",
    `if [ -e '${workspaceRoot}' ] || [ -L '${workspaceRoot}' ]; then test -d '${workspaceRoot}' && test ! -L '${workspaceRoot}'; else mkdir '${workspaceRoot}'; fi`,
    `chown 42424:42424 '${workspaceRoot}'`,
    `chmod 0750 '${workspaceRoot}'`,
    `test "$(readlink -f '${workspaceRoot}')" = '${workspaceRoot}'`,
    `test "$(stat -c '%u:%g:%a' '${workspaceRoot}')" = 42424:42424:750`,
    ...(workspaceRoot === WORLD_ROOT
      ? [
          `if [ -e '${WORLD_DRIVE_ROOT}' ] || [ -L '${WORLD_DRIVE_ROOT}' ]; then test -d '${WORLD_DRIVE_ROOT}' && test ! -L '${WORLD_DRIVE_ROOT}'; else mkdir -m 0750 '${WORLD_DRIVE_ROOT}' && chown 42424:42424 '${WORLD_DRIVE_ROOT}'; fi`,
          `test "$(readlink -f '${WORLD_DRIVE_ROOT}')" = '${WORLD_DRIVE_ROOT}'`,
          `test "$(stat -c '%u:%g:%a' '${WORLD_DRIVE_ROOT}')" = 42424:42424:750`,
        ]
      : []),
    "if [ -e /workspace/.stella-tool-home ] || [ -L /workspace/.stella-tool-home ]; then test -d /workspace/.stella-tool-home && test ! -L /workspace/.stella-tool-home && test \"$(stat -c '%u:%g:%a' /workspace/.stella-tool-home)\" = 42424:42424:700; else mkdir /workspace/.stella-tool-home && chown 42424:42424 /workspace/.stella-tool-home && chmod 0700 /workspace/.stella-tool-home; fi",
    "test ! -L /home/stella-native-state",
    'test "$(readlink -f /home/stella-native-state)" = /home/stella-native-state',
    "test \"$(stat -c '%u:%g:%a' /home/stella-native-state)\" = 0:0:700",
    "test ! -L /home/stella-host-state",
    'test "$(readlink -f /home/stella-host-state)" = /home/stella-host-state',
    "test \"$(stat -c '%u:%g:%a' /home/stella-host-state)\" = 0:0:700",
  ].join("; ");
  // The session shell is persistent, so `set -eu` must stay inside a
  // subshell: leaked into the session it turns the next non-zero exit (for
  // one, the attached tool-host readiness probe) into a dead shell.
  const result = await session.exec(inSubshell(command));
  if (!result.success) {
    throw new Error("Cloud workspace mount boundary validation failed.");
  }
};

/**
 * Seed `world/stella` on first use, then re-establish the directory boundary.
 *
 * GNU `cp -a source/. destination/` preserves the source directory's mode on
 * the existing destination. The immutable renderer source is 0755, while a
 * cloud workspace root must remain 0750, so the copy can otherwise make the
 * executor and its fallback checkpoint reject the freshly seeded world.
 */
export const seedFirstStellaToolWorkspace = async (
  session: Pick<ExecutionSession, "exec">,
): Promise<void> => {
  const seeded = await strictSessionExec(session, [
    "/bin/sh",
    "-lc",
    `set -eu; test ! -e '${WORLD_STELLA_ROOT}'; mkdir '${WORLD_STELLA_ROOT}'; cp -a /opt/stella/packages/desktop-ui/. '${WORLD_STELLA_ROOT}/'; ln -s /opt/stella/node_modules '${WORLD_STELLA_ROOT}/node_modules'; mkdir '${WORLD_STELLA_ROOT}/.stella'; cp /opt/stella/interior-seed.json '${WORLD_STELLA_ROOT}/.stella/interior-source.json'; chown -R 42424:42424 '${WORLD_STELLA_ROOT}'; chmod 0750 '${WORLD_STELLA_ROOT}'`,
  ]);
  if (!seeded.success) {
    throw new Error("The Stella interior source seed could not be created.");
  }
  await normalizeToolWorkspaceRoot(session, WORLD_ROOT);
};

/**
 * Probe the optional Stella checkout without letting an expected absence
 * surface as a non-zero command result. Sandbox RPC treats any such result as
 * a terminated session, so every filesystem state is reported on stdout and
 * invalid existing entries are rejected here.
 */
export const stellaToolWorkspaceExists = async (
  session: Pick<ExecutionSession, "exec">,
): Promise<boolean> => {
  const result = await session.exec(
    `if [ -e '${WORLD_STELLA_ROOT}' ] || [ -L '${WORLD_STELLA_ROOT}' ]; then if [ -d '${WORLD_STELLA_ROOT}' ] && [ ! -L '${WORLD_STELLA_ROOT}' ]; then printf '%s\\n' present; else printf '%s\\n' invalid; fi; else printf '%s\\n' absent; fi`,
  );
  if (!result.success) {
    throw new Error("The Stella interior source could not be inspected.");
  }
  switch (result.stdout.trim()) {
    case "present":
      return true;
    case "absent":
      return false;
    case "invalid":
      throw new Error(
        "The Stella interior source path is not a safe directory.",
      );
    default:
      throw new Error("The Stella interior source returned an invalid state.");
  }
};

const requirePublicOrigin = (
  value: string | undefined,
  label: string,
): string => {
  try {
    const parsed = new URL(value?.trim() ?? "");
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("not an HTTPS origin");
    }
    return parsed.origin;
  } catch {
    throw new Error(`${label} must be configured as an HTTPS origin.`);
  }
};

const validBuilderFallbackMessages = (
  value: unknown,
): value is Array<{ ordinal: number; role: string; payloadJson: string }> => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_024) {
    return false;
  }
  let bytes = 0;
  return value.every((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const row = entry as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !== "ordinal,payloadJson,role" ||
      row.ordinal !== index ||
      typeof row.role !== "string" ||
      !["user", "assistant", "toolResult"].includes(row.role) ||
      typeof row.payloadJson !== "string"
    ) {
      return false;
    }
    bytes += new TextEncoder().encode(row.payloadJson).byteLength;
    if (bytes > AGENT_HISTORY_RESPONSE_MAX_BYTES) return false;
    try {
      const payload = JSON.parse(row.payloadJson) as { role?: unknown };
      return payload?.role === row.role;
    } catch {
      return false;
    }
  });
};
export const parseAgentExecutorResult = (
  value: unknown,
): AgentExecutorResult | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const allowed = new Set([
    "outcome",
    "ok",
    "finalText",
    "error",
    "usage",
    "checkpointPolicy",
    "checkpointMs",
    "turnStateCheckpoint",
    "suspension",
    "builderFallback",
  ]);
  const boundedOutput = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    new TextEncoder().encode(candidate).byteLength <= 4 * 1024 * 1024;
  if (
    !Object.keys(result).every((key) => allowed.has(key)) ||
    (result.outcome !== undefined &&
      result.outcome !== "completed" &&
      result.outcome !== "suspended") ||
    typeof result.ok !== "boolean" ||
    (result.finalText !== undefined && !boundedOutput(result.finalText)) ||
    (result.error !== undefined && !boundedOutput(result.error)) ||
    (result.usage !== undefined &&
      (!result.usage ||
        typeof result.usage !== "object" ||
        Array.isArray(result.usage))) ||
    (result.checkpointMs !== undefined &&
      (!Number.isSafeInteger(result.checkpointMs) ||
        Number(result.checkpointMs) < 0)) ||
    (result.checkpointPolicy !== undefined &&
      result.checkpointPolicy !== "preserve_prior" &&
      result.checkpointPolicy !== "builder_fallback")
  ) {
    return null;
  }

  if (result.outcome === "suspended") {
    if (
      result.ok !== false ||
      result.finalText !== "" ||
      result.error !== undefined ||
      !isCloudBrowserSuspension(result.suspension) ||
      result.checkpointPolicy !== undefined ||
      result.builderFallback !== undefined
    ) {
      return null;
    }
  } else if (result.suspension !== undefined) {
    return null;
  }

  if (result.checkpointPolicy === "builder_fallback") {
    if (
      !result.builderFallback ||
      typeof result.builderFallback !== "object" ||
      Array.isArray(result.builderFallback)
    ) {
      return null;
    }
    const fallback = result.builderFallback as Record<string, unknown>;
    if (
      !Object.keys(fallback).every((key) =>
        ["historyCursor", "messages", "nativeCheckpoint"].includes(key),
      ) ||
      typeof fallback.historyCursor !== "string" ||
      !validBuilderFallbackMessages(fallback.messages) ||
      !parseTurnStateCheckpointRequest({
        schemaVersion: 1,
        historyCursor: fallback.historyCursor,
        ...(fallback.nativeCheckpoint !== undefined
          ? { nativeCheckpoint: fallback.nativeCheckpoint }
          : {}),
      }) ||
      result.turnStateCheckpoint !== undefined
    ) {
      return null;
    }
  } else if (result.builderFallback !== undefined) {
    return null;
  }

  if (result.checkpointPolicy === "preserve_prior") {
    if (result.turnStateCheckpoint !== undefined) return null;
  } else if (
    result.checkpointPolicy !== "builder_fallback" &&
    !validTurnStateCheckpointReceipt(result.turnStateCheckpoint)
  ) {
    return null;
  }
  return result as AgentExecutorResult;
};

const readCloudAgentTurnResultText = async (
  session: Pick<ExecutionSession, "readFile">,
): Promise<string | undefined> => {
  try {
    const recorded = await session.readFile(CLOUD_AGENT_TURN_RESULT_PATH, {
      encoding: "base64",
    });
    const bytes = Uint8Array.from(atob(recorded.content), (character) =>
      character.charCodeAt(0),
    );
    try {
      if (bytes.byteLength > 4 * 1024 * 1024) return undefined;
      return new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(bytes);
    } finally {
      bytes.fill(0);
    }
  } catch {
    return undefined;
  }
};

export const waitForCloudAgentTurnResultText = async (
  session: Pick<ExecutionSession, "readFile">,
  signals: readonly AbortSignal[],
  cancellation?: TurnRetryCancellation,
): Promise<string> => {
  const abortError = (): Error | undefined => {
    if (cancellation?.aborted) {
      return cancellation.reason instanceof Error
        ? cancellation.reason
        : new Error("Agent result observation was canceled.");
    }
    const signal = signals.find((candidate) => candidate.aborted);
    if (!signal) return undefined;
    return signal.reason instanceof Error
      ? signal.reason
      : new Error("Agent result observation was canceled.");
  };
  const combinedSignal =
    signals.length > 0 ? AbortSignal.any([...signals]) : undefined;
  while (true) {
    const reason = abortError();
    if (reason) throw reason;
    const recorded = await readCloudAgentTurnResultText(session);
    const afterReadReason = abortError();
    if (afterReadReason) throw afterReadReason;
    if (recorded !== undefined) {
      // `writeFile()` can make the destination visible before every byte has
      // landed. Never let a partial-but-readable root result win the race and
      // trigger executor quiescence; wait until the same strict decoder used
      // after capture accepts the complete payload.
      try {
        if (
          parseAgentExecutorResult(JSON.parse(recorded) as unknown) !== null
        ) {
          return recorded;
        }
      } catch {
        // The executor is still publishing the file. Poll the fixed path again.
      }
    }
    const signalDelay = sleepWithAbort(250, combinedSignal, (activeSignal) =>
      activeSignal.reason instanceof Error
        ? activeSignal.reason
        : new Error("Agent result observation was canceled."),
    );
    await (cancellation
      ? Promise.race([signalDelay, cancellation.sleep(250)])
      : signalDelay);
  }
};

export class BuildSession extends DurableObject<Env> {
  private readonly runningTurns = new Map<string, Set<Promise<unknown>>>();
  /** Effect-supervised app-build work; owner purge interrupts before joining. */
  private readonly appTurnExecutions = new Map<
    string,
    TurnExecution<Response>
  >();
  /** Effect-supervised spawned-agent work; Stop never joins a raw promise. */
  private readonly agentTurnExecutions = new Map<string, TurnExecution<void>>();
  /** Per-isolate cache of this attempt's control-plane capability. */
  private readonly controlPlaneCapabilities = new Map<
    string,
    { token: string; expiresAt: number }
  >();
  /**
   * Alarm recovery interrupts an exact run without destroying its disk. The
   * interrupt hooks consult this set, kill/join only the model-controlled
   * session, and leave the sandbox mounted for the trusted fallback archiver.
   */
  private readonly builderFallbackRecoveries = new Set<string>();
  /**
   * Resident agent loops by turn id, so Stop can stop the loop itself rather
   * than only the container it may not have. An `Agent` ignores an
   * `AbortSignal`; the only way to stop one is to call its own `abort`.
   */
  private readonly residentAgentAborts = new Map<string, () => void>();
  /** Exact replay joins one in-flight archive build instead of racing scratch. */
  private readonly turnStateCheckpointRuns = new Map<
    string,
    Promise<TurnBrokerTurnStateCheckpointReceipt>
  >();
  private readonly exactTurnCancellations = new ExactTurnCancellationLedger(
    this.ctx.storage,
  );

  /**
   * The structural view of this instance handed to every extracted module in
   * `src/build-session/`. Every member stays `private`; the modules take
   * `Pick<BuildSessionInternals, …>` of this surface instead.
   *
   * @see src/build-session/host.ts
   */
  private get self(): BuildSessionInternals {
    return this as unknown as BuildSessionInternals;
  }

  /**
   * Normal turn cleanup must retain exact cancellation receipts. The key list
   * is captured while input is gated and the deletion is one transaction, so
   * a crash or concurrent Stop cannot open a tombstone-loss window. Sandbox
   * destroy debt is retained too: terminal delivery is never authority to
   * forget a container whose teardown has not been confirmed.
   */
  private async deleteTurnStoragePreservingExactCancellations(
    expectedTurn?: TurnRequest,
    deleteAlarm = false,
  ): Promise<boolean> {
    const deleted = await this.ctx.blockConcurrencyWhile(async () => {
      if (
        expectedTurn &&
        !exactTurnIdentityMatches(
          await this.ctx.storage.get<TurnRequest>("turn"),
          expectedTurn,
        )
      ) {
        return false;
      }
      const listed = [...(await this.ctx.storage.list<unknown>()).keys()];
      const hasDestroyDebt = listed.some(isSandboxDestroyDebtKey);
      const hasOwnerFenceDebt = listed.some(isBuildOwnerFenceDurabilityKey);
      // Projections a queue outage deferred outlive the turn that produced
      // them: Convex has no other way to learn a terminal state, and the
      // alarm that retries them must survive with the debt.
      const hasOutboxDebt = listed.includes(OUTBOX_DEBT_KEY);
      const keys = listed.filter(
        (key) =>
          key !== EXACT_TURN_CANCELLATIONS_KEY &&
          key !== OUTBOX_DEBT_KEY &&
          !isSandboxDestroyDebtKey(key) &&
          !isBuildOwnerFenceDurabilityKey(key),
      );
      let deleted = false;
      await this.ctx.storage.transaction(async (txn) => {
        if (
          expectedTurn &&
          !exactTurnIdentityMatches(
            await txn.get<TurnRequest>("turn"),
            expectedTurn,
          )
        ) {
          return;
        }
        if (keys.length > 0) await txn.delete(keys);
        if (
          deleteAlarm &&
          !hasDestroyDebt &&
          !hasOwnerFenceDebt &&
          !hasOutboxDebt
        ) {
          await txn.deleteAlarm();
        }
        deleted = true;
      });
      return deleted;
    });
    if (deleted) await this.scheduleDurabilityAlarm();
    return deleted;
  }

  // ── The turn plane: owner gate, capabilities, outbox, transcript ───────
  //
  // Everything below replaces a synchronous Convex round trip that used to sit
  // on a turn's critical path. Admission is the owner gate's, authority is a
  // signed capability rather than a reusable token Convex has to look up, and
  // every projection Convex needs leaves through the outbox queue instead of
  // an HTTP callback with its own retry ladder.

  private ownerGateFor(ownerId: string) {
    return this.env.OWNER_GATES.getByName(ownerId);
  }

  /** Shared dispatch dependencies used when this agent spawns a child. */
  private childAgentDispatchDependencies(): CloudAgentDispatchDependencies {
    return {
      env: this.env,
      ownerGateAdmit: async (input) =>
        await this.ownerGateFor(input.ownerId).admit({
          lane: "agent",
          turnId: input.turnId,
          conversationId: input.conversationId,
          expectedGeneration: input.expectedGeneration,
        }),
      releaseOwnerGate: async (input) => {
        await this.ownerGateFor(input.ownerId).release({
          turnId: input.turnId,
        });
      },
      enqueueOutbox: async (events) =>
        await this.enqueueOutboxDurable([...events]),
    };
  }

  /**
   * Give this turn's slot back to the owner gate. Idempotent by construction
   * (the gate deletes a row it may not have), and never fatal: a release that
   * cannot be delivered is bounded by the gate's own running-row expiry, so
   * failing the turn over it would trade a recoverable lag for a lost result.
   */
  private async releaseOwnerGate(turn: TurnRequest): Promise<void> {
    if (turn.kind !== "agent" || !turn.ownerId) return;
    try {
      await this.ownerGateFor(turn.ownerId).release({ turnId: turn.turnId });
    } catch (error) {
      log("error", "owner_gate_release_failed", {
        turnId: turn.turnId,
        message: errorMessage(error),
      });
    }
  }

  /**
   * The control-plane capability for this exact attempt.
   *
   * Minted here rather than stored: a bearer token that outlives the isolate
   * would have to be written to durable storage and rotated there, and the
   * signature costs less than the storage round trip would. Cached per
   * isolate until a minute before expiry so a long turn re-signs at most a
   * handful of times.
   *
   * It is the model-gateway capability's twin — same owner, generation, turn
   * binding, audience and budget — and differs only in `aud`, which is why it
   * must never leave this Durable Object.
   */
  private async controlPlaneCapability(turn: TurnRequest): Promise<string> {
    const attemptGeneration = turn.attemptGeneration ?? 1;
    const key = `${turn.turnId}:${attemptGeneration}`;
    const now = Date.now();
    const cached = this.controlPlaneCapabilities.get(key);
    if (cached && cached.expiresAt - 60_000 > now) return cached.token;
    const conversationId = turn.conversationId?.trim() ?? "";
    if (!conversationId) {
      throw turn.kind === "agent"
        ? new AgentTurnAuthorityLostError()
        : new AppTurnAuthorityLostError();
    }
    const minted = await mintTurnCapability(this.env, {
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      turnId: turn.turnId,
      conversationId,
      execution:
        turn.execution ??
        (turn.kind === "agent"
          ? undefined
          : APP_BUILD_CONTROL_PLANE_EXECUTION)!,
      audience: turn.audience,
      budgetMicroCents: turn.budgetMicroCents,
      agentTypes: ["general"],
      aud: CONTROL_PLANE_CAPABILITY_AUDIENCE,
    });
    this.controlPlaneCapabilities.set(key, {
      token: minted.token,
      expiresAt: minted.expiresAt,
    });
    return minted.token;
  }

  /**
   * The remaining synchronous Convex reads a turn still needs — the ones that
   * answer a question only the control plane can answer (web search, drive,
   * the app-build art director). Authority is this turn's control-plane
   * capability; the worker's shared secret is no longer sent from a turn path,
   * so a compromised turn cannot act as the worker.
   */
  private async convexCall(
    turn: TurnRequest,
    path: string,
    body: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Response> {
    const base = (this.env.STELLA_CONVEX_SITE_URL ?? "")
      .trim()
      .replace(/\/+$/, "");
    if (!base) throw new Error("Convex site URL is not configured.");
    const capability = await this.controlPlaneCapability(turn);
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    return await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    });
  }

  /**
   * The resident loop's control plane, wired to this object's own transcript
   * table and outbox. The capability is resolved lazily so a long turn does
   * not hold an expiring token captured at construction.
   */
  private agentControlPlane(
    turn: TurnRequest,
    attemptGeneration: number,
    sessionId: string,
  ): ReturnType<typeof createAgentControlPlane> {
    return createAgentControlPlane({
      convexSiteUrl: this.env.STELLA_CONVEX_SITE_URL,
      capability: () => this.controlPlaneCapability(turn),
      identity: {
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        threadId: turn.threadId!,
        turnId: turn.turnId,
        attemptGeneration,
        sessionId,
      },
      storage: this.ctx.storage,
      transport: {
        readHistory: (options) =>
          this.fetchCanonicalAgentHistory(turn, {
            excludeCurrentTurn: options.excludeCurrentTurn,
          }),
        appendMessages: (messages) =>
          this.appendThreadTranscript(turn, messages),
        emitEvent: async (args) => {
          await this.emitTurnEvent(turn, args.kind, args.payload, {
            terminal: args.terminal,
            ...(args.seq === "auto" ? {} : { eventSeq: args.seq }),
            ...(args.signal ? { signal: args.signal } : {}),
          });
        },
      },
    });
  }

  private outboxBase(turn: TurnRequest, key: string) {
    return {
      v: OUTBOX_EVENT_VERSION,
      key,
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      emittedAt: Date.now(),
    } as const;
  }

  /**
   * Append to the outbox, or remember the debt and let the alarm retry it.
   * A queue outage must not lose a projection Convex has no other way to
   * learn: the UI's thread rows, the turn's terminal state, a recorded build.
   */
  private async enqueueOutboxDurable(events: OutboxEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await enqueueOutbox(this.env, events);
      return;
    } catch (error) {
      log("error", "outbox_enqueue_deferred", {
        events: events.map((event) => `${event.kind}:${event.key}`),
        message: errorMessage(error),
      });
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      const debt =
        (await this.ctx.storage.get<OutboxEvent[]>(OUTBOX_DEBT_KEY)) ?? [];
      await this.ctx.storage.put(
        OUTBOX_DEBT_KEY,
        [...debt, ...events].slice(-OUTBOX_DEBT_MAX),
      );
      const retryAt = Date.now() + OUTBOX_DEBT_RETRY_MS;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > retryAt) {
        await this.ctx.storage.setAlarm(retryAt);
      }
    });
  }

  private async retryOutboxDebt(): Promise<void> {
    const debt = await this.ctx.storage.get<OutboxEvent[]>(OUTBOX_DEBT_KEY);
    if (!debt || debt.length === 0) return;
    try {
      await enqueueOutbox(this.env, debt);
      await this.ctx.storage.delete(OUTBOX_DEBT_KEY);
    } catch (error) {
      log("error", "outbox_debt_retry_failed", {
        events: debt.length,
        message: errorMessage(error),
      });
      const retryAt = Date.now() + OUTBOX_DEBT_RETRY_MS;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > retryAt) {
        await this.ctx.storage.setAlarm(retryAt);
      }
    }
  }

  /**
   * One `turn.event`. The ordinal is assigned here — Convex used to do it —
   * and persisted in this object's SQLite, so a restarted isolate continues
   * the sequence instead of colliding with events already projected. Callers
   * that own an idempotent retry pass their own `eventSeq` back in.
   */
  private async emitTurnEvent(
    turn: TurnRequest,
    eventKind: string,
    payload: unknown,
    options: {
      terminal?: boolean;
      eventSeq?: number;
      errorMessage?: string;
      resultJson?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<number> {
    options.signal?.throwIfAborted();
    await this.assertTurnWritable(turn);
    options.signal?.throwIfAborted();
    const attemptGeneration = turn.attemptGeneration ?? 1;
    let eventSeq: number;
    if (options.eventSeq === undefined) {
      eventSeq = nextTurnEventSeq(
        this.ctx.storage.sql,
        turn.turnId,
        attemptGeneration,
      );
    } else {
      eventSeq = options.eventSeq;
      reserveTurnEventSeq(
        this.ctx.storage.sql,
        turn.turnId,
        attemptGeneration,
        eventSeq,
      );
    }
    const terminal = options.terminal === true;
    const event: TurnEventEvent = {
      ...this.outboxBase(
        turn,
        `${turn.turnId}:${attemptGeneration}:${eventSeq}`,
      ),
      kind: "turn.event",
      turnId: turn.turnId,
      ...(turn.kind === "agent" ? { attemptGeneration } : {}),
      sessionId: turn.threadId ?? turn.sessionId ?? this.ctx.id.toString(),
      eventSeq,
      eventKind,
      payload,
      terminal,
      ...(terminal
        ? { terminalStatus: TERMINAL_EVENT_STATUS[eventKind] ?? "failed" }
        : {}),
      ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
      ...(options.resultJson ? { resultJson: options.resultJson } : {}),
      createdAt: Date.now(),
    };
    await this.enqueueOutboxDurable([event]);
    return eventSeq;
  }

  /**
   * Commit transcript rows to this thread's own table. A continuation reads
   * them back from SQLite, and re-appending the same ordinals is a no-op.
   */
  private async appendThreadTranscript(
    turn: TurnRequest,
    messages: readonly ThreadMessageInput[],
  ): Promise<void> {
    if (turn.kind !== "agent" || !turn.threadId) {
      throw new AgentTurnAuthorityLostError();
    }
    const attemptGeneration = turn.attemptGeneration ?? 1;
    appendThreadMessages(this.ctx.storage.sql, {
      turnId: turn.turnId,
      attemptGeneration,
      messages,
      now: Date.now(),
    });
  }

  private trackTurn<T>(turnId: string, work: Promise<T>): Promise<T> {
    const active = this.runningTurns.get(turnId) ?? new Set<Promise<unknown>>();
    const tracked = work.finally(() => {
      active.delete(tracked);
      if (active.size === 0) {
        this.runningTurns.delete(turnId);
      }
    });
    active.add(tracked);
    this.runningTurns.set(turnId, active);
    return tracked;
  }

  private startAgentTurn(
    turn: TurnRequest,
    sandboxId: string | undefined,
  ): Promise<void> {
    const existing = this.agentTurnExecutions.get(turn.turnId);
    if (existing) return existing.settled;
    const execution = startTurnExecution({
      work: (context) => this.runAgentTurn(turn, sandboxId, context),
      // Cleanup is part of fiber interruption and is bounded by the Effect
      // facade. A Stop ACK therefore means the exact command session and
      // container teardown completed (or the cancellation failed visibly).
      //
      // The resident loop is aborted first, the way `OrchestratorSession`
      // stops its own: the sweeps below cannot make an in-flight provider call
      // or tool return, and leaving the Agent running would let it start
      // container work behind a teardown that already ran.
      onInterrupt: () => {
        this.abortResidentAgent(turn);
        return this.builderFallbackRecoveries.has(turn.turnId)
          ? this.quiesceCurrentAgentSession(turn)
          : this.terminateCurrentAgentSession(turn);
      },
      // createSession() may ignore AbortSignal and resolve after the immediate
      // destroy. Sweep again after the underlying turn promise has unwound so
      // Stop can never ACK while that late session/container remains live.
      afterInterrupt: () => {
        this.abortResidentAgent(turn);
        return this.builderFallbackRecoveries.has(turn.turnId)
          ? this.quiesceCurrentAgentSession(turn)
          : this.terminateCurrentAgentSession(turn);
      },
    });
    this.agentTurnExecutions.set(turn.turnId, execution);
    const tracked = this.trackTurn(turn.turnId, execution.settled);
    const clear = () => {
      if (this.agentTurnExecutions.get(turn.turnId) === execution) {
        this.agentTurnExecutions.delete(turn.turnId);
      }
    };
    void tracked.then(clear, clear);
    return tracked;
  }

  /**
   * Stop the resident loop before either sweep runs. A turn with no resident
   * loop registered has nothing here, which is what makes this safe to call
   * unconditionally from both interrupt hooks.
   */
  private abortResidentAgent(turn: TurnRequest): void {
    const abort = this.residentAgentAborts.get(turn.turnId);
    if (!abort) return;
    try {
      abort();
    } catch (error) {
      log("error", "resident_agent_abort_failed", {
        turnId: turn.turnId,
        message: errorMessage(error),
      });
    }
  }

  private startAppTurn(turn: TurnRequest): Promise<Response> {
    const existing = this.appTurnExecutions.get(turn.turnId);
    if (existing) return existing.settled;
    const execution = startTurnExecution({
      work: (context) => this.runTurn(turn, context),
      // A pending platform createSession may materialize after the first
      // destroy. Interrupt closes the local admission latch; the second sweep
      // runs only after the underlying app-turn promise has unwound.
      onInterrupt: () => this.terminateCurrentAgentSession(turn),
      afterInterrupt: () => this.terminateCurrentAgentSession(turn),
    });
    this.appTurnExecutions.set(turn.turnId, execution);
    const tracked = this.trackTurn(turn.turnId, execution.settled);
    const clear = () => {
      if (this.appTurnExecutions.get(turn.turnId) === execution) {
        this.appTurnExecutions.delete(turn.turnId);
      }
    };
    void tracked.then(clear, clear);
    return tracked;
  }

  private ownerFence(ownerId: string) {
    return this.env.OWNER_GATES.getByName(ownerId);
  }

  private async callOwnerFence(
    ownerId: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return this.ownerFence(ownerId).fetch(
      `https://owner-gate/owner-fence/${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HEADER_OWNER_FENCE_ID]: ownerId,
        },
        body: JSON.stringify({ ...body, ownerId }),
      },
    );
  }

  private ownerTurnStateEnvelope(turn: TurnRequest): {
    schemaVersion: 1;
    ownerId: string;
    ownerGeneration: string;
    generation: string;
    leaseId: string;
    sessionId: string;
    turnId: string;
  } {
    if (
      !turn.ownerPurgeGeneration ||
      !turn.ownerPurgeLeaseId ||
      !turn.ownerGeneration
    ) {
      throw new OwnerPurgeFenceError();
    }
    return {
      schemaVersion: 1,
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      generation: turn.ownerPurgeGeneration,
      leaseId: turn.ownerPurgeLeaseId,
      sessionId: this.ctx.id.toString(),
      turnId: turn.turnId,
    };
  }

  private async callOwnerTurnState<T>(
    turn: TurnRequest,
    path:
      | "prepare"
      | "mark-uploaded"
      | "commit"
      | "publish-workspace"
      | "abort-unpublished"
      | "resolve"
      | "confirm-restore"
      | "drain",
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.callOwnerFence(
      turn.ownerId,
      `turn-state/${path}`,
      { ...body, ...this.ownerTurnStateEnvelope(turn) },
    );
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 256 * 1024) {
      throw new Error("Turn state owner response exceeded its bound.");
    }
    if (!response.ok) throw new TurnStateOwnerCallError(response.status);
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error("Turn state owner response was invalid.", {
        cause: error,
      });
    }
  }

  /** @see src/build-session/turn-broker.ts */
  private resolveAgentTurnState(
    turn: TurnRequest,
    canonicalHistoryCursor: string,
    options: { allowMissingNative?: boolean } = {},
  ): Promise<ResolvedTurnState> {
    return resolveAgentTurnState(
      this.self,
      turn,
      canonicalHistoryCursor,
      options,
    );
  }

  /** @see src/build-session/turn-broker.ts */
  private publishAgentTurnWorkspace(
    turn: TurnRequest,
    canonicalHistoryCursor: string,
    operationId: string,
  ): Promise<TurnStateWorkspaceHead> {
    return publishAgentTurnWorkspace(
      this.self,
      turn,
      canonicalHistoryCursor,
      operationId,
    );
  }

  /** @see src/build-session/turn-broker.ts */
  private confirmAgentTurnStateRestore(
    turn: TurnRequest,
    canonicalHistoryCursor: string,
    workspaceHead: TurnStateWorkspaceHead | undefined,
    workspaceConfirmationRequired: boolean,
    threadCandidate: TurnStateCandidate | undefined,
    threadConfirmationRequired: boolean,
  ): Promise<void> {
    return confirmAgentTurnStateRestore(
      this.self,
      turn,
      canonicalHistoryCursor,
      workspaceHead,
      workspaceConfirmationRequired,
      threadCandidate,
      threadConfirmationRequired,
    );
  }

  private async quiesceCurrentAgentSession(turn: TurnRequest): Promise<void> {
    const target = await this.ctx.storage.transaction(async (transaction) => {
      const [current, sandboxId, size] = await Promise.all([
        transaction.get<TurnRequest>("turn"),
        transaction.get<string>("sandboxId"),
        transaction.get<InstanceSize>("sandboxSize"),
      ]);
      if (!sandboxId || !exactTurnIdentityMatches(current, turn)) {
        throw new AgentTurnAuthorityLostError();
      }
      return { sandboxId, size: size ?? ("large" as const) };
    });
    const identity = {
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
    };
    const compute = parsePersistedAgentCompute(
      await this.ctx.storage.get(
        agentComputeKey(identity.turnId, identity.attemptGeneration),
      ),
      identity,
    );
    const sandbox = this.sandbox(target.sandboxId, target.size, "world");
    const executionSessionId =
      compute?.sessionId ?? agentTurnSessionId(turn.turnId);
    if (!(await this.sandboxContainerRunning(sandbox))) return;
    await sandbox.killAllProcesses(executionSessionId);
    await sandbox.deleteSession(executionSessionId).catch(() => undefined);
  }

  private async exactAgentExecutionMarker(
    turn: TurnRequest,
  ): Promise<AgentExecutionMarker | undefined> {
    const marker = await this.ctx.storage.get<AgentExecutionMarker>(
      agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!),
    );
    if (!marker) return undefined;
    if (
      marker.schemaVersion !== 1 ||
      marker.turnId !== turn.turnId ||
      marker.attemptGeneration !== turn.attemptGeneration ||
      !Number.isSafeInteger(marker.startedAt) ||
      marker.startedAt < 0 ||
      !marker.sandboxId ||
      (marker.size !== "small" && marker.size !== "large")
    ) {
      throw new Error("Agent execution recovery marker was invalid.");
    }
    return marker;
  }

  /**
   * Fence an admitted attachment whose isolate vanished before it could write
   * the execution marker. The claim and marker share one storage transaction:
   * either the restored world becomes archive-authoritative, or recovery owns
   * teardown, never both.
   */
  private async claimOrphanedAgentComputeRecovery(
    turn: TurnRequest,
  ): Promise<PersistedAgentCompute | undefined> {
    const attemptGeneration = turn.attemptGeneration!;
    const identity = { turnId: turn.turnId, attemptGeneration };
    const computeKey = agentComputeKey(turn.turnId, attemptGeneration);
    const markerKey = agentExecutionMarkerKey(turn.turnId, attemptGeneration);
    const claimKey = agentComputeRecoveryClaimKey(
      turn.turnId,
      attemptGeneration,
    );
    return await this.ctx.storage.transaction(async (txn) => {
      const [current, raw, marker, existingClaim] = await Promise.all([
        txn.get<TurnRequest>("turn"),
        txn.get(computeKey),
        txn.get<AgentExecutionMarker>(markerKey),
        txn.get<AgentComputeRecoveryClaim>(claimKey),
      ]);
      if (!exactTurnIdentityMatches(current, turn) || marker) return undefined;
      if (raw === undefined) return undefined;
      const compute = parsePersistedAgentCompute(raw, identity);
      if (!compute) {
        throw new Error("Agent compute recovery record was invalid.");
      }
      if (compute.phase === "resident") return undefined;
      const sandboxId = compute.sandboxId!;
      if (
        existingClaim &&
        (existingClaim.schemaVersion !== 1 ||
          existingClaim.turnId !== turn.turnId ||
          existingClaim.attemptGeneration !== attemptGeneration ||
          existingClaim.sandboxId !== sandboxId)
      ) {
        throw new Error("Agent compute recovery claim was invalid.");
      }
      if (!existingClaim) {
        await txn.put(claimKey, {
          schemaVersion: 1,
          turnId: turn.turnId,
          attemptGeneration,
          sandboxId,
          createdAt: Date.now(),
        } satisfies AgentComputeRecoveryClaim);
      }
      return compute;
    });
  }

  private async recoverOrphanedAgentCompute(
    turn: TurnRequest,
  ): Promise<"none" | "recovered" | "retry"> {
    let compute: PersistedAgentCompute | undefined;
    try {
      compute = await this.claimOrphanedAgentComputeRecovery(turn);
    } catch (error) {
      log("error", "agent_compute_recovery_claim_invalid", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message: errorMessage(error),
      });
      await this.setExactTurnAlarm(turn, Date.now() + 30_000);
      return "retry";
    }
    if (!compute) return "none";
    const target: SandboxTarget = {
      sandboxId: compute.sandboxId!,
      size: compute.instanceSize,
      workload: "world",
    };
    try {
      await this.releaseAgentSessionResources({
        ...target,
        workload: "world",
        sessionId: compute.sessionId!,
        daemonDirectory: compute.daemonDirectory!,
      });
    } catch (error) {
      log("error", "agent_compute_recovery_release_deferred", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        instanceSize: compute.instanceSize,
        ...sandboxLifecycleFailureFields(error),
      });
      return "retry";
    }
    const attemptGeneration = turn.attemptGeneration!;
    const computeKey = agentComputeKey(turn.turnId, attemptGeneration);
    const claimKey = agentComputeRecoveryClaimKey(
      turn.turnId,
      attemptGeneration,
    );
    let removed = false;
    await this.ctx.storage.transaction(async (txn) => {
      const [current, marker, raw, claim, sharedSandboxId] = await Promise.all([
        txn.get<TurnRequest>("turn"),
        txn.get<AgentExecutionMarker>(
          agentExecutionMarkerKey(turn.turnId, attemptGeneration),
        ),
        txn.get(computeKey),
        txn.get<AgentComputeRecoveryClaim>(claimKey),
        txn.get<string>("sandboxId"),
      ]);
      const latest = parsePersistedAgentCompute(raw, {
        turnId: turn.turnId,
        attemptGeneration,
      });
      if (
        !exactTurnIdentityMatches(current, turn) ||
        marker ||
        !latest ||
        latest.phase === "resident" ||
        latest.sandboxId !== compute!.sandboxId ||
        claim?.schemaVersion !== 1 ||
        claim.turnId !== turn.turnId ||
        claim.attemptGeneration !== attemptGeneration ||
        claim.sandboxId !== compute!.sandboxId
      ) {
        return;
      }
      await txn.delete([computeKey, claimKey]);
      if (sharedSandboxId === compute!.sandboxId) {
        await txn.delete(["sandboxId", "sandboxSize"]);
      }
      removed = true;
    });
    if (!removed) {
      await this.setExactTurnAlarm(turn, Date.now() + 1_000);
      return "retry";
    }
    log("info", "agent_compute_orphan_recovered", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      instanceSize: compute.instanceSize,
      phase: compute.phase,
    });
    return "recovered";
  }

  private async persistAgentExecutionMarker(
    turn: TurnRequest,
    marker: AgentExecutionMarker,
  ): Promise<void> {
    const claimKey = agentComputeRecoveryClaimKey(
      turn.turnId,
      turn.attemptGeneration!,
    );
    await this.ctx.storage.transaction(async (txn) => {
      const [current, claim] = await Promise.all([
        txn.get<TurnRequest>("turn"),
        txn.get<AgentComputeRecoveryClaim>(claimKey),
      ]);
      if (!exactTurnIdentityMatches(current, turn) || claim) {
        throw new AgentTurnAuthorityLostError();
      }
      await txn.put(
        agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!),
        marker,
      );
    });
  }

  private async clearUnattachedAgentSandboxTuple(
    turn: TurnRequest,
  ): Promise<void> {
    const attemptGeneration = turn.attemptGeneration!;
    const identity = { turnId: turn.turnId, attemptGeneration };
    await this.ctx.storage.transaction(async (txn) => {
      const [current, raw] = await Promise.all([
        txn.get<TurnRequest>("turn"),
        txn.get(agentComputeKey(turn.turnId, attemptGeneration)),
      ]);
      if (!exactTurnIdentityMatches(current, turn)) {
        throw new AgentTurnAuthorityLostError();
      }
      const compute = parsePersistedAgentCompute(raw, identity);
      if (!compute?.sandboxId) {
        await txn.delete(["sandboxId", "sandboxSize"]);
      }
    });
  }

  private async interruptAgentForBuilderFallback(
    turn: TurnRequest,
  ): Promise<void> {
    const running = this.agentTurnExecutions.get(turn.turnId);
    if (!running) {
      await this.quiesceCurrentAgentSession(turn);
      return;
    }
    this.builderFallbackRecoveries.add(turn.turnId);
    try {
      await running.interrupt(
        new Error("The Builder is recovering this turn's durable workspace."),
      );
    } finally {
      this.builderFallbackRecoveries.delete(turn.turnId);
    }
  }

  /** @see src/build-session/turn-broker.ts */
  private exactTurnStateCheckpointOperations(
    turn: TurnRequest,
  ): Promise<TurnStateCheckpointOperation[]> {
    return exactTurnStateCheckpointOperations(this.self, turn);
  }

  /** @see src/build-session/turn-broker.ts */
  private abortUnpublishedTurnStateOperation(
    turn: TurnRequest,
    operation: TurnStateCheckpointOperation,
    canonicalHistoryCursor: string,
  ): Promise<void> {
    return abortUnpublishedTurnStateOperation(
      this.self,
      turn,
      operation,
      canonicalHistoryCursor,
    );
  }

  private async recoverObservedBrowserSuspension(
    turn: TurnRequest,
    checkpoint: TurnBrokerTurnStateCheckpointReceipt,
    signal?: AbortSignal,
  ): Promise<CloudBrowserSuspension | null> {
    const observation = await this.ctx.storage.get<ObservedBrowserSuspension>(
      OBSERVED_BROWSER_SUSPENSION_KEY,
    );
    if (!observation) return null;
    const rows = this.fetchCanonicalAgentHistory(turn, {
      excludeCurrentTurn: false,
      ...(signal ? { signal } : {}),
    });
    return await bindObservedBrowserSuspensionToCanonicalCodeCall({
      observation,
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      checkpoint,
      rows,
    });
  }

  private async retainPendingBrowserSuspension(
    turn: TurnRequest,
    pending: PendingBrowserSuspension,
  ): Promise<boolean> {
    return await this.ctx.storage.transaction(async (txn) => {
      const [current, terminal, pendingTerminal, existingPending, observed] =
        await Promise.all([
          txn.get<TurnRequest>("turn"),
          txn.get<boolean>("terminal"),
          txn.get<PendingTerminal>("pendingTerminal"),
          txn.get<PendingBrowserSuspension>(PENDING_BROWSER_SUSPENSION_KEY),
          txn.get<ObservedBrowserSuspension>(OBSERVED_BROWSER_SUSPENSION_KEY),
        ]);
      if (
        !exactTurnIdentityMatches(current, turn) ||
        terminal ||
        pendingTerminal
      ) {
        return false;
      }
      if (existingPending) {
        return (
          existingPending.turnId === pending.turnId &&
          existingPending.attemptGeneration === pending.attemptGeneration &&
          cloudBrowserSuspensionMarker(existingPending.suspension) ===
            cloudBrowserSuspensionMarker(pending.suspension)
        );
      }
      if (
        !observed ||
        observed.turnId !== turn.turnId ||
        observed.attemptGeneration !== turn.attemptGeneration ||
        !isCloudBrowserSuspension(observed.suspension) ||
        cloudBrowserSuspensionMarker({
          ...observed.suspension,
          toolCallId: pending.suspension.toolCallId,
        }) !== cloudBrowserSuspensionMarker(pending.suspension)
      ) {
        return false;
      }
      await txn.put(PENDING_BROWSER_SUSPENSION_KEY, pending);
      await txn.delete(OBSERVED_BROWSER_SUSPENSION_KEY);
      await txn.delete(
        agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!),
      );
      await txn.setAlarm(Date.now() + 30_000);
      return true;
    });
  }

  private async ensureObservedBrowserSuspensionRecoveryJournal(
    turn: TurnRequest,
    operations: TurnStateCheckpointOperation[],
  ): Promise<BuilderFallbackTranscript | null> {
    const observation = await this.ctx.storage.get<ObservedBrowserSuspension>(
      OBSERVED_BROWSER_SUSPENSION_KEY,
    );
    if (!observation) return null;
    const candidates: Array<{
      operation: Extract<TurnStateCheckpointOperation, { state: "succeeded" }>;
      messages: NonNullable<
        TurnBrokerTurnStateCheckpointRequest["suspensionTranscript"]
      >;
    }> = [];
    for (const operation of operations) {
      if (
        operation.state !== "succeeded" ||
        !operation.payload.suspensionTranscript
      ) {
        continue;
      }
      const messages = operation.payload.suspensionTranscript;
      const bound = await bindObservedBrowserSuspensionToCanonicalCodeCall({
        observation,
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration!,
        checkpoint: operation.receipt,
        rows: messages.map((message) => ({
          ...message,
          turnId: turn.turnId,
        })),
      });
      if (bound) candidates.push({ operation, messages });
    }
    if (candidates.length > 1) {
      throw new Error(
        "Multiple suspended checkpoints matched the Browser Gateway wait.",
      );
    }
    const candidate = candidates[0];
    if (!candidate || !validBuilderFallbackMessages(candidate.messages)) {
      return null;
    }
    const { operation, messages } = candidate;
    const fallbackKey = builderFallbackTranscriptKey(
      turn.turnId,
      turn.attemptGeneration!,
    );
    const fallback: BuilderFallbackTranscript = {
      schemaVersion: 1,
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      requestId: operation.requestId,
      requestFingerprint: operation.requestFingerprint,
      createdAt: operation.createdAt,
      payload: operation.payload,
      messages: structuredClone(messages),
      checkpointReceipt: operation.receipt,
      transcriptCommitted: false,
      workspacePublished: false,
    };
    return await this.ctx.storage.transaction(async (transaction) => {
      const [currentTurn, currentObserved, currentOperation, existing] =
        await Promise.all([
          transaction.get<TurnRequest>("turn"),
          transaction.get<ObservedBrowserSuspension>(
            OBSERVED_BROWSER_SUSPENSION_KEY,
          ),
          transaction.get<TurnStateCheckpointOperation>(
            turnStateCheckpointOperationKey(operation.requestId),
          ),
          transaction.get<BuilderFallbackTranscript>(fallbackKey),
        ]);
      if (!exactTurnIdentityMatches(currentTurn, turn)) {
        throw new AgentTurnAuthorityLostError();
      }
      if (existing) {
        if (
          existing.requestId !== fallback.requestId ||
          existing.requestFingerprint !== fallback.requestFingerprint ||
          JSON.stringify(existing.messages) !==
            JSON.stringify(fallback.messages)
        ) {
          throw new Error("Browser suspension recovery journal conflicted.");
        }
        return existing;
      }
      if (
        !currentObserved ||
        currentObserved.turnId !== observation.turnId ||
        currentObserved.attemptGeneration !== observation.attemptGeneration ||
        currentObserved.responseBodySha256 !== observation.responseBodySha256 ||
        !currentOperation ||
        currentOperation.state !== "succeeded" ||
        currentOperation.requestFingerprint !== operation.requestFingerprint ||
        JSON.stringify(currentOperation.receipt) !==
          JSON.stringify(operation.receipt) ||
        JSON.stringify(currentOperation.payload) !==
          JSON.stringify(operation.payload)
      ) {
        throw new Error("Browser suspension recovery state changed.");
      }
      await transaction.put(fallbackKey, fallback);
      return fallback;
    });
  }

  /** Whether this exact attempt was admitted to the resident arm. */
  private async admittedResidentPlacement(turn: TurnRequest): Promise<boolean> {
    if (
      turn.kind !== "agent" ||
      !Number.isSafeInteger(turn.attemptGeneration) ||
      turn.attemptGeneration! < 1
    ) {
      return false;
    }
    const identity = {
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
    };
    const admitted = parseTurnComputePlan(
      await this.ctx.storage.get(
        turnComputePlanKey(identity.turnId, identity.attemptGeneration),
      ),
      identity,
    );
    return admitted?.plan.kind === "resident_stella";
  }

  /**
   * D9. Turn what a lost isolate left in the journal into rows a thread can
   * read.
   *
   * A call in the interrupted tail is answered, never replayed. Its receipt
   * lives only in the daemon process the archive below is about to kill, and
   * the interrupted result says exactly that much: the effect is unknown.
   */
  private async repairedResidentJournal(
    turn: TurnRequest,
    message: string,
  ): Promise<SealedTurnTranscript> {
    const now = Date.now();
    const journal = AgentTurnJournal.open({
      sql: this.ctx.storage.sql,
      identity: {
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration!,
      },
      terminal: {
        prompt: turn.prompt,
        provider: turn.execution?.provider ?? "stella",
        model: turn.execution?.model ?? "unknown",
        finalText: "",
        error: message,
        timestamp: now,
      },
      now,
    });
    return await journal.repairInterruptedTail({
      resolveInterruptedCall: async () => "interrupted",
      terminalMessage: message,
    });
  }

  /**
   * D9's resident arm. Nothing was ever attached, so there is no disk to
   * archive and no fallback publication to advance: the journal is the whole
   * durable record of the turn, and the thread is owed a repaired transcript
   * followed by a failure.
   */
  private async recoverResidentAgentTurn(turn: TurnRequest): Promise<void> {
    const message =
      "The agent stopped unexpectedly before it finished. Its reply was not completed.";
    if (!turn.threadId || !turn.turnBrokerRoute) return;
    // The journal cannot be sealed under a loop that is still appending to it.
    // A replacement isolate has nothing here, which is the common case.
    const running = this.agentTurnExecutions.get(turn.turnId);
    if (running) {
      await running.interrupt(new Error(message)).catch(() => undefined);
    }
    const recoveredPending: PendingTerminal = {
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      kind: "failed",
      payload: { message, reason: "resident_recovered" },
      threadError: message,
    };
    try {
      const repaired = await this.repairedResidentJournal(turn, message);
      await this.agentControlPlane(
        turn,
        turn.attemptGeneration!,
        turn.turnBrokerRoute.sessionId,
      ).appendAndVerifyTranscript(repaired);
    } catch (error) {
      log("error", "resident_agent_recovery_retry", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message: errorMessage(error),
      });
      await this.setExactTurnAlarm(turn, Date.now() + 30_000);
      return;
    }
    if (
      !(await this.claimTerminalDecision(
        turn,
        recoveredPending,
        Date.now() + 30_000,
      ))
    ) {
      await this.setExactTurnAlarm(turn, Date.now() + 1_000);
      return;
    }
    if (
      (await this.deliverTerminal(turn, recoveredPending)) &&
      (await this.ownsExactTurn(turn))
    ) {
      await this.deleteTurnStoragePreservingExactCancellations(turn, true);
    }
    log("info", "resident_agent_turn_recovered", {
      turnId: turn.turnId,
      threadId: turn.threadId,
    });
  }

  /**
   * `resolveInput` runs after quiescence, never before. A resident turn's rows
   * come from a journal the loop is still appending to until the interrupt
   * above has unwound it, and sealing that journal early would fail the very
   * loop whose rows recovery is trying to keep.
   */
  private async recoverAgentTurnAfterExecutorLoss(
    turn: TurnRequest,
    marker: AgentExecutionMarker,
    error: string,
    resolveInput?: () => Promise<BuilderFallbackInput>,
  ): Promise<TurnBrokerTurnStateCheckpointReceipt> {
    await this.interruptAgentForBuilderFallback(turn);
    return await this.reconcileAgentCheckpointAfterQuiescence(
      turn,
      marker,
      error,
      await resolveInput?.(),
    );
  }

  private async reconcileAgentCheckpointAfterQuiescence(
    turn: TurnRequest,
    marker: AgentExecutionMarker,
    error: string,
    input?: BuilderFallbackInput,
  ): Promise<TurnBrokerTurnStateCheckpointReceipt> {
    await this.assertTurnWritable(turn);
    this.assertAgentTurnIdentity(turn);

    const fallbackKey = builderFallbackTranscriptKey(
      turn.turnId,
      turn.attemptGeneration!,
    );
    const existingFallback =
      await this.ctx.storage.get<BuilderFallbackTranscript>(fallbackKey);
    if (existingFallback) {
      return await this.advanceBuilderFallback(turn, existingFallback);
    }

    const canonicalRows = this.fetchCanonicalAgentHistory(turn, {
      excludeCurrentTurn: false,
    });
    const canonicalCursor = await nativeHistoryCursorFromRows(canonicalRows);
    let operations = await this.exactTurnStateCheckpointOperations(turn);
    for (const operation of operations) {
      if (!operation.payload) {
        await this.ctx.storage.delete(
          turnStateCheckpointOperationKey(operation.requestId),
        );
        continue;
      }
      let pending:
        | (Extract<TurnStateCheckpointOperation, { state: "pending" }> & {
            payload: TurnBrokerTurnStateCheckpointRequest;
          })
        | undefined;
      if (operation.state === "pending") {
        pending = {
          ...operation,
          payload: operation.payload,
        };
      } else if (operation.state === "failed" && operation.operationId) {
        const operationKey = turnStateCheckpointOperationKey(
          operation.requestId,
        );
        pending = await this.ctx.storage.transaction(async (transaction) => {
          const current =
            await transaction.get<TurnStateCheckpointOperation>(operationKey);
          if (
            !current ||
            current.state !== "failed" ||
            current.turnId !== operation.turnId ||
            current.attemptGeneration !== operation.attemptGeneration ||
            current.requestFingerprint !== operation.requestFingerprint ||
            !current.operationId ||
            !current.payload
          ) {
            throw new Error("Failed checkpoint recovery operation changed.");
          }
          const resumed: Extract<
            TurnStateCheckpointOperation,
            { state: "pending" }
          > & { payload: TurnBrokerTurnStateCheckpointRequest } = {
            state: "pending",
            turnId: current.turnId,
            attemptGeneration: current.attemptGeneration,
            requestId: current.requestId,
            requestFingerprint: current.requestFingerprint,
            createdAt: current.createdAt,
            baseWorkspaceRevision: current.baseWorkspaceRevision,
            operationId: current.operationId,
            payload: current.payload,
          };
          await transaction.put(operationKey, resumed);
          return resumed;
        });
      }
      if (pending) {
        await this.executeTurnStateCheckpoint({
          turn,
          operationKey: turnStateCheckpointOperationKey(pending.requestId),
          operation: pending,
        });
      }
    }
    operations = await this.exactTurnStateCheckpointOperations(turn);
    const accepted = operations.filter(
      (
        operation,
      ): operation is Extract<
        TurnStateCheckpointOperation,
        { state: "succeeded" }
      > =>
        operation.state === "succeeded" &&
        operation.receipt.historyCursor === canonicalCursor,
    );
    if (accepted.length > 1) {
      throw new Error("Multiple agent checkpoints matched canonical history.");
    }
    if (accepted[0]) {
      await this.publishAgentTurnWorkspace(
        turn,
        canonicalCursor,
        accepted[0].operationId,
      );
      return accepted[0].receipt;
    }

    // A browser suspension can lose the executor after the durable archive
    // commit but before its direct transcript callback completes. The exact
    // checkpoint request carries that secret-free transcript, so replay it
    // through the same durable Builder journal before considering a synthetic
    // failure. This publishes the original archive/cursor; it never creates a
    // second workspace checkpoint.
    const browserRecovery =
      await this.ensureObservedBrowserSuspensionRecoveryJournal(
        turn,
        operations,
      );
    if (browserRecovery) {
      return await this.advanceBuilderFallback(turn, browserRecovery);
    }

    // A checkpoint whose transcript never became canonical must remain
    // invisible. Retire its pre-registered objects first so prepare can CAS a
    // fresh synthetic cursor over the same base revision without a permanent
    // pending-candidate wedge.
    for (const operation of operations) {
      await this.abortUnpublishedTurnStateOperation(
        turn,
        operation,
        canonicalCursor,
      );
    }
    const fallback = await this.ensureBuilderFallbackTranscript(turn, {
      ...(input ?? {}),
      error,
    });
    return await this.advanceBuilderFallback(turn, fallback);
  }

  private syntheticBuilderFallbackMessages(
    turn: TurnRequest,
    message: string,
    createdAt: number,
  ): Array<{ ordinal: number; role: string; payloadJson: string }> {
    const execution = turn.execution;
    const rows = [
      {
        role: "user",
        content: [{ type: "text", text: turn.prompt }],
        timestamp: createdAt,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: message }],
        timestamp: createdAt,
        api: "stella-cloud",
        provider: execution?.provider ?? "stella",
        model: execution?.model ?? "unknown",
        stopReason: "error",
        errorMessage: message,
      },
    ];
    return rows.map((row, ordinal) => ({
      ordinal,
      role: row.role,
      payloadJson: JSON.stringify(row),
    }));
  }

  private async ensureBuilderFallbackTranscript(
    turn: TurnRequest,
    input?: BuilderFallbackInput & { error?: string },
  ): Promise<BuilderFallbackTranscript> {
    const key = builderFallbackTranscriptKey(
      turn.turnId,
      turn.attemptGeneration!,
    );
    const validateExisting = (
      existing: BuilderFallbackTranscript,
    ): BuilderFallbackTranscript => {
      if (
        existing.schemaVersion !== 1 ||
        existing.turnId !== turn.turnId ||
        existing.attemptGeneration !== turn.attemptGeneration ||
        !validBuilderFallbackMessages(existing.messages) ||
        !Number.isSafeInteger(existing.createdAt) ||
        existing.createdAt < 0 ||
        !/^[0-9a-f]{64}$/u.test(existing.requestFingerprint)
      ) {
        throw new Error("Builder fallback journal was invalid.");
      }
      return existing;
    };
    const existing = await this.ctx.storage.get<BuilderFallbackTranscript>(key);
    if (existing) {
      return validateExisting(existing);
    }
    const baseWorkspaceRevision = await this.ctx.storage.get<number>(
      turnStateBaseWorkspaceRevisionKey(turn.turnId, turn.attemptGeneration!),
    );
    if (
      !Number.isSafeInteger(baseWorkspaceRevision) ||
      baseWorkspaceRevision! < 0
    ) {
      throw new Error("Builder fallback workspace base is missing.");
    }
    const createdAt = Date.now();
    const messages = input?.messages
      ? structuredClone(input.messages)
      : this.syntheticBuilderFallbackMessages(
          turn,
          input?.error ??
            "The agent stopped unexpectedly after making workspace changes.",
          createdAt,
        );
    if (!validBuilderFallbackMessages(messages)) {
      throw new Error("Builder fallback transcript was invalid.");
    }
    const historyCursor = await nativeHistoryCursorFromRows(
      messages.map((message) => ({ ...message, turnId: turn.turnId })),
    );
    if (input?.historyCursor && input.historyCursor !== historyCursor) {
      throw new Error("Builder fallback transcript cursor was invalid.");
    }
    if (input?.nativeCheckpoint) {
      const integrityKey = await nativeStateIntegrityKeyFor(this.env, turn);
      if (
        input.nativeCheckpoint.cursor !== historyCursor ||
        !(await validNativeStateCheckpointMac({
          checkpoint: input.nativeCheckpoint,
          threadId: turn.threadId!,
          integrityKey,
        }))
      ) {
        throw new Error("Builder fallback native checkpoint was invalid.");
      }
    }
    const payload: TurnBrokerTurnStateCheckpointRequest = {
      schemaVersion: 1,
      historyCursor,
      ...(input?.nativeCheckpoint
        ? { nativeCheckpoint: input.nativeCheckpoint }
        : {}),
    };
    const requestId = crypto.randomUUID();
    const requestFingerprint = await sha256Hex(
      JSON.stringify([
        1,
        turn.ownerGeneration,
        turn.turnId,
        turn.attemptGeneration,
        baseWorkspaceRevision,
        payload,
        messages,
      ]),
    );
    const fallback: BuilderFallbackTranscript = {
      schemaVersion: 1,
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      requestId,
      requestFingerprint,
      createdAt,
      payload,
      messages,
      transcriptCommitted: false,
      workspacePublished: false,
    };
    const operation: Extract<
      TurnStateCheckpointOperation,
      { state: "pending" }
    > = {
      state: "pending",
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      requestId,
      requestFingerprint,
      createdAt,
      baseWorkspaceRevision: baseWorkspaceRevision!,
      payload,
    };
    return await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<TurnRequest>("turn");
      if (!exactTurnIdentityMatches(current, turn)) {
        throw new AgentTurnAuthorityLostError();
      }
      const replay = await transaction.get<BuilderFallbackTranscript>(key);
      if (replay) {
        return validateExisting(replay);
      }
      await transaction.put({
        [key]: fallback,
        [turnStateCheckpointOperationKey(requestId)]: operation,
      });
      return fallback;
    });
  }

  private async advanceBuilderFallback(
    turn: TurnRequest,
    fallback: BuilderFallbackTranscript,
  ): Promise<TurnBrokerTurnStateCheckpointReceipt> {
    const fallbackKey = builderFallbackTranscriptKey(
      turn.turnId,
      turn.attemptGeneration!,
    );
    const storedFallback =
      await this.ctx.storage.get<BuilderFallbackTranscript>(fallbackKey);
    if (
      !storedFallback ||
      storedFallback.requestId !== fallback.requestId ||
      storedFallback.requestFingerprint !== fallback.requestFingerprint
    ) {
      throw new Error("Builder fallback journal changed before replay.");
    }
    fallback = storedFallback;
    const persistProgress = async (
      next: BuilderFallbackTranscript,
    ): Promise<BuilderFallbackTranscript> =>
      await this.ctx.storage.transaction(async (transaction) => {
        const [currentTurn, current] = await Promise.all([
          transaction.get<TurnRequest>("turn"),
          transaction.get<BuilderFallbackTranscript>(fallbackKey),
        ]);
        if (
          !exactTurnIdentityMatches(currentTurn, turn) ||
          !current ||
          current.requestId !== next.requestId ||
          current.requestFingerprint !== next.requestFingerprint ||
          (current.checkpointReceipt &&
            JSON.stringify(current.checkpointReceipt) !==
              JSON.stringify(next.checkpointReceipt)) ||
          (current.transcriptCommitted && !next.transcriptCommitted) ||
          (current.workspacePublished && !next.workspacePublished)
        ) {
          throw new Error("Builder fallback journal changed during replay.");
        }
        const merged: BuilderFallbackTranscript = {
          ...next,
          ...(current.checkpointReceipt
            ? { checkpointReceipt: current.checkpointReceipt }
            : {}),
          transcriptCommitted:
            current.transcriptCommitted || next.transcriptCommitted,
          workspacePublished:
            current.workspacePublished || next.workspacePublished,
        };
        await transaction.put(fallbackKey, merged);
        return merged;
      });
    const operationKey = turnStateCheckpointOperationKey(fallback.requestId);
    await this.quiesceCurrentAgentSession(turn);
    let receipt = fallback.checkpointReceipt;
    if (!receipt) {
      const operation =
        await this.ctx.storage.get<TurnStateCheckpointOperation>(operationKey);
      if (!operation)
        throw new Error("Builder fallback checkpoint is missing.");
      if (operation.state === "failed") {
        throw new Error("Builder fallback checkpoint permanently failed.");
      }
      if (operation.state === "succeeded") {
        receipt = operation.receipt;
      } else {
        receipt = await this.executeTurnStateCheckpoint({
          turn,
          operationKey,
          operation: {
            ...operation,
            payload: fallback.payload,
          },
        });
      }
      fallback = await persistProgress({
        ...fallback,
        checkpointReceipt: receipt,
      });
    }
    if (!fallback.transcriptCommitted) {
      // The rows are committed to this thread's own table; the projection
      // rides the outbox. Re-appending the same ordinals is a no-op, so the
      // replay this journal exists for cannot double-write the transcript.
      await this.appendThreadTranscript(turn, fallback.messages);
      const canonicalRows = this.fetchCanonicalAgentHistory(turn, {
        excludeCurrentTurn: false,
      });
      if (
        (await nativeHistoryCursorFromRows(canonicalRows)) !==
        fallback.payload.historyCursor
      ) {
        throw new Error("Builder fallback transcript was not canonical.");
      }
      fallback = await persistProgress({
        ...fallback,
        transcriptCommitted: true,
      });
    }
    if (!fallback.workspacePublished) {
      await this.publishAgentTurnWorkspace(
        turn,
        fallback.payload.historyCursor,
        receipt.operationId,
      );
      fallback = await persistProgress({
        ...fallback,
        workspacePublished: true,
      });
    }
    return receipt;
  }

  private async registerTurn(
    turn: TurnRequest,
    freshLease = false,
  ): Promise<string> {
    const kind = freshLease ? "aux" : "run";
    const slotKey = await this.ownerFenceLeaseSlotKey(turn, kind);
    const grant = await this.registerBuildOwnerFenceLease({
      turn,
      kind,
      slotKey,
      role: kind,
      mutateTurn: true,
    });
    return grant.generation;
  }

  private ownerFenceReceiptMatches(
    receipt: BuildOwnerFenceLeaseReceipt,
    target: Pick<TurnRequest, "ownerId" | "ownerGeneration" | "turnId">,
    leaseId: string,
  ): boolean {
    return (
      receipt.schemaVersion === 1 &&
      receipt.ownerId === target.ownerId &&
      receipt.ownerGeneration === target.ownerGeneration &&
      receipt.turnId === target.turnId &&
      receipt.leaseId === leaseId
    );
  }

  private async ownerFenceLeaseSlotKey(
    turn: TurnRequest,
    kind: BuildOwnerFenceLeaseReceipt["kind"],
  ): Promise<string> {
    const identity = await sha256Hex(
      JSON.stringify({
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration ?? 1,
        kind,
      }),
    );
    return `${BUILD_OWNER_FENCE_LEASE_SLOT_PREFIX}${identity}`;
  }

  private async armOwnerFenceLeaseReconciliationAlarm(): Promise<void> {
    const retryAt = Date.now() + OWNER_FENCE_LEASE_RETRY_MS;
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.getAlarm();
      if (current === null || current > retryAt) await txn.setAlarm(retryAt);
    });
  }

  private async hasOwnerFenceLeaseRetirementDebt(): Promise<boolean> {
    const receipts = await this.ctx.storage.list<BuildOwnerFenceLeaseReceipt>({
      prefix: BUILD_OWNER_FENCE_LEASE_RECEIPT_PREFIX,
      limit: 512,
    });
    return [...receipts.values()].some(
      (receipt) => receipt.phase === "unregister_pending",
    );
  }

  private async retryOwnerFenceLeaseRetirements(): Promise<void> {
    const receipts = await this.ctx.storage.list<BuildOwnerFenceLeaseReceipt>({
      prefix: BUILD_OWNER_FENCE_LEASE_RECEIPT_PREFIX,
      limit: 512,
    });
    for (const receipt of receipts.values()) {
      if (receipt.phase !== "unregister_pending") continue;
      await this.retireBuildOwnerFenceLease(receipt);
    }
    if (await this.hasOwnerFenceLeaseRetirementDebt()) {
      await this.armOwnerFenceLeaseReconciliationAlarm();
    }
  }

  private async registerBuildOwnerFenceLease(args: {
    turn: TurnRequest;
    kind: BuildOwnerFenceLeaseReceipt["kind"];
    role: "run" | "aux";
    slotKey?: string;
    leaseId?: string;
    mutateTurn?: boolean;
  }): Promise<{ generation: string; expiresAt: number; leaseId: string }> {
    let receipt!: BuildOwnerFenceLeaseReceipt;
    await this.ctx.storage.transaction(async (txn) => {
      const slot = args.slotKey
        ? await txn.get<BuildOwnerFenceLeaseSlot>(args.slotKey)
        : undefined;
      if (
        slot &&
        (slot.schemaVersion !== 1 ||
          slot.ownerId !== args.turn.ownerId ||
          slot.ownerGeneration !== args.turn.ownerGeneration ||
          slot.turnId !== args.turn.turnId ||
          slot.kind !== args.kind)
      ) {
        throw new OwnerPurgeFenceError();
      }
      const leaseId =
        args.leaseId ??
        (args.mutateTurn ? args.turn.ownerPurgeLeaseId : undefined) ??
        slot?.leaseId ??
        crypto.randomUUID();
      if (slot && slot.leaseId !== leaseId) throw new OwnerPurgeFenceError();
      const key = buildOwnerFenceLeaseReceiptKey(leaseId);
      const current = await txn.get<BuildOwnerFenceLeaseReceipt>(key);
      if (
        current &&
        (!this.ownerFenceReceiptMatches(current, args.turn, leaseId) ||
          current.kind !== args.kind)
      ) {
        throw new OwnerPurgeFenceError();
      }
      const now = Date.now();
      receipt = current ?? {
        schemaVersion: 1,
        ownerId: args.turn.ownerId,
        ownerGeneration: args.turn.ownerGeneration,
        turnId: args.turn.turnId,
        leaseId,
        kind: args.kind,
        phase: "registering",
        ...(args.slotKey ? { slotKey: args.slotKey } : {}),
        createdAt: now,
        updatedAt: now,
      };
      if (receipt.phase === "unregister_pending") {
        throw new OwnerPurgeFenceError();
      }
      const writes: Record<string, unknown> = { [key]: receipt };
      if (args.slotKey) {
        writes[args.slotKey] = {
          schemaVersion: 1,
          ownerId: args.turn.ownerId,
          ownerGeneration: args.turn.ownerGeneration,
          turnId: args.turn.turnId,
          leaseId,
          kind: args.kind,
        } satisfies BuildOwnerFenceLeaseSlot;
      }
      await txn.put(writes);
      if (args.mutateTurn) args.turn.ownerPurgeLeaseId = leaseId;
    });

    let response: Response;
    const expiresAt = Date.now() + OWNER_FENCE_LEASE_TTL_MS;
    try {
      response = await this.callOwnerFence(args.turn.ownerId, "register", {
        leaseId: receipt.leaseId,
        sessionId: this.ctx.id.toString(),
        turnId: args.turn.turnId,
        ownerGeneration: args.turn.ownerGeneration,
        role: args.role,
        expiresAt,
        ...(receipt.registrationGeneration
          ? { generation: receipt.registrationGeneration }
          : {}),
      });
    } catch (error) {
      log("error", "owner_fence_register_response_lost", {
        turnId: receipt.turnId,
        leaseId: receipt.leaseId,
        kind: receipt.kind,
        message: errorMessage(error),
      });
      throw new OwnerPurgeFenceError();
    }
    const body = (await response.json().catch(() => null)) as {
      generation?: string;
      expiresAt?: number;
      code?: unknown;
    } | null;
    if (!response.ok || !body?.generation) {
      const rawCode = typeof body?.code === "string" ? body.code : "";
      log("info", "agent_turn_owner_fence_registration_rejected", {
        turnId: args.turn.turnId,
        threadId: args.turn.threadId,
        attemptGeneration: args.turn.attemptGeneration,
        status: response.status,
        code: rawCode || "unknown",
        kind: args.kind,
      });
      throw new OwnerPurgeFenceError();
    }
    let committed = false;
    await this.ctx.storage.transaction(async (txn) => {
      const key = buildOwnerFenceLeaseReceiptKey(receipt.leaseId);
      const current = await txn.get<BuildOwnerFenceLeaseReceipt>(key);
      if (
        !current ||
        current.phase === "unregister_pending" ||
        !this.ownerFenceReceiptMatches(current, receipt, receipt.leaseId)
      ) {
        return;
      }
      receipt = {
        ...current,
        phase: "registered",
        registrationGeneration: body.generation,
        updatedAt: Date.now(),
      };
      await txn.put(key, receipt);
      committed = true;
    });
    if (!committed) {
      await this.callOwnerFence(receipt.ownerId, "unregister", {
        leaseId: receipt.leaseId,
        sessionId: this.ctx.id.toString(),
        turnId: receipt.turnId,
        ownerGeneration: receipt.ownerGeneration,
      }).catch(() => undefined);
      throw new OwnerPurgeFenceError();
    }
    if (args.mutateTurn) {
      args.turn.ownerPurgeLeaseId = receipt.leaseId;
      args.turn.ownerPurgeGeneration = body.generation;
    }
    return {
      generation: body.generation,
      expiresAt:
        typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
          ? body.expiresAt
          : expiresAt,
      leaseId: receipt.leaseId,
    };
  }

  private async unregisterTurn(turn: TurnRequest): Promise<void> {
    if (!turn.ownerPurgeLeaseId) return;
    const hasTransientWrites =
      Boolean(
        await this.ctx.storage.get<string>(`transientBuild:${turn.turnId}`),
      ) ||
      Boolean(
        await this.ctx.storage.get<NativeTransientBackup>(
          nativeTransientBackupKey(turn.turnId),
        ),
      ) ||
      (turn.kind === "agent" &&
        (Boolean(
          await this.ctx.storage.get<AgentExecutionMarker>(
            agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!),
          ),
        ) ||
          Boolean(
            await this.ctx.storage.get<BuilderFallbackTranscript>(
              builderFallbackTranscriptKey(
                turn.turnId,
                turn.attemptGeneration!,
              ),
            ),
          )));
    if (hasTransientWrites) {
      try {
        // A callback whose response was lost may already have committed the
        // row that names a build. Preserve it during ordinary operation. Once
        // purge changes the generation, the turn's lease stays active until
        // these otherwise-unnameable bytes are verifiably gone.
        await this.assertTurnWritable(turn);
        return;
      } catch (error) {
        if (!(error instanceof OwnerPurgeFenceError)) return;
        try {
          await this.cleanupTransientWrites(turn);
        } catch (cleanupError) {
          log("error", "owner_purge_transient_cleanup_failed", {
            turnId: turn.turnId,
            message: errorMessage(cleanupError),
          });
          return;
        }
      }
    }
    await this.unregisterTurnLease(
      turn,
      turn.ownerPurgeLeaseId,
      turn.ownerPurgeGeneration,
    );
  }

  private async unregisterTurnLease(
    turn: TurnRequest,
    leaseId: string,
    generation?: string,
  ): Promise<boolean> {
    const key = buildOwnerFenceLeaseReceiptKey(leaseId);
    let receipt = await this.ctx.storage.get<BuildOwnerFenceLeaseReceipt>(key);
    if (receipt && !this.ownerFenceReceiptMatches(receipt, turn, leaseId)) {
      throw new OwnerPurgeFenceError();
    }
    if (!receipt) {
      const now = Date.now();
      receipt = {
        schemaVersion: 1,
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        turnId: turn.turnId,
        leaseId,
        kind: "run",
        phase: "unregister_pending",
        ...(generation ? { registrationGeneration: generation } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await this.ctx.storage.put(key, receipt);
    }
    return await this.retireBuildOwnerFenceLease(receipt, generation);
  }

  private async retireBuildOwnerFenceLease(
    receipt: BuildOwnerFenceLeaseReceipt,
    generation = receipt.registrationGeneration,
  ): Promise<boolean> {
    const key = buildOwnerFenceLeaseReceiptKey(receipt.leaseId);
    let pending = receipt;
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<BuildOwnerFenceLeaseReceipt>(key);
      if (
        current &&
        !this.ownerFenceReceiptMatches(current, receipt, receipt.leaseId)
      ) {
        throw new OwnerPurgeFenceError();
      }
      pending = {
        ...(current ?? receipt),
        phase: "unregister_pending",
        updatedAt: Date.now(),
      };
      await txn.put(key, pending);
    });
    let response: Response;
    try {
      response = await this.callOwnerFence(pending.ownerId, "unregister", {
        leaseId: pending.leaseId,
        sessionId: this.ctx.id.toString(),
        turnId: pending.turnId,
        ownerGeneration: pending.ownerGeneration,
        ...(generation ? { generation } : {}),
      });
    } catch (error) {
      log("error", "owner_fence_unregister_deferred", {
        turnId: pending.turnId,
        leaseId: pending.leaseId,
        kind: pending.kind,
        message: errorMessage(error),
      });
      await this.armOwnerFenceLeaseReconciliationAlarm();
      return false;
    }
    if (!response.ok) {
      log("error", "owner_fence_unregister_deferred", {
        turnId: pending.turnId,
        leaseId: pending.leaseId,
        kind: pending.kind,
        status: response.status,
      });
      await this.armOwnerFenceLeaseReconciliationAlarm();
      return false;
    }
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<BuildOwnerFenceLeaseReceipt>(key);
      if (
        current &&
        this.ownerFenceReceiptMatches(current, pending, pending.leaseId)
      ) {
        await txn.delete(key);
      }
      if (pending.slotKey) {
        const slot = await txn.get<BuildOwnerFenceLeaseSlot>(pending.slotKey);
        if (slot?.leaseId === pending.leaseId) {
          await txn.delete(pending.slotKey);
        }
      }
    });
    return true;
  }

  private async appendNativeBackupDebt(
    workspaceKey: string,
    backupId: string,
  ): Promise<void> {
    if (!BACKUP_ID_PATTERN.test(backupId)) {
      throw new Error("Invalid transient native backup id.");
    }
    const debtKey = nativeBackupDebtKey(workspaceKey);
    const existing = (await this.env.APP_ROUTES.get<WorkspaceBackupDebt>(
      debtKey,
      "json",
    )) ?? { backupIds: [] };
    const backupIds = [...new Set([...existing.backupIds, backupId])];
    if (backupIds.length > 100) {
      throw new Error("Native backup cleanup debt is too large.");
    }
    await this.env.APP_ROUTES.put(
      debtKey,
      JSON.stringify({ backupIds } satisfies WorkspaceBackupDebt),
    );
  }

  private async sweepNativeBackupDebt(workspaceKey: string): Promise<void> {
    const debtKey = nativeBackupDebtKey(workspaceKey);
    const debt = await this.env.APP_ROUTES.get<WorkspaceBackupDebt>(
      debtKey,
      "json",
    );
    if (!debt?.backupIds.length) return;
    const referenced = new Set<string>();
    let cursor: string | undefined;
    let listingComplete = false;
    for (let page = 0; page < R2_SWEEP_MAX_PAGES; page += 1) {
      const listing = await this.env.APP_ROUTES.list({
        prefix: nativeStateCheckpointPrefix(workspaceKey),
        limit: 1_000,
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of listing.keys) {
        const raw = await this.env.APP_ROUTES.get<unknown>(entry.name, "json");
        const record = raw ? parseNativeStateCheckpointRecord(raw) : null;
        if (!record) continue;
        for (const version of [
          ...(record.committed ? [record.committed] : []),
          ...record.candidates,
        ]) {
          referenced.add(version.descriptor.id);
        }
      }
      if (listing.list_complete) {
        listingComplete = true;
        break;
      }
      cursor = listing.cursor;
      if (!cursor) break;
    }
    if (!listingComplete) {
      throw new Error("Native checkpoint reference listing was truncated.");
    }

    const remaining: string[] = [];
    for (const backupId of debt.backupIds) {
      if (!BACKUP_ID_PATTERN.test(backupId) || referenced.has(backupId)) {
        remaining.push(backupId);
        continue;
      }
      try {
        const swept = await sweepR2Prefix(
          this.env.BACKUP_BUCKET,
          `backups/${backupId}/`,
        );
        if (!swept.done) remaining.push(backupId);
      } catch {
        remaining.push(backupId);
      }
    }
    if (remaining.length > 0) {
      await this.env.APP_ROUTES.put(
        debtKey,
        JSON.stringify({ backupIds: remaining } satisfies WorkspaceBackupDebt),
      );
    } else {
      await this.env.APP_ROUTES.delete(debtKey);
    }
  }

  private async settleNativeTransientBackup(
    turn: TurnRequest,
  ): Promise<boolean> {
    const markerKey = nativeTransientBackupKey(turn.turnId);
    const marker = await this.ctx.storage.get<NativeTransientBackup>(markerKey);
    if (!marker) return true;
    if (
      !BACKUP_ID_PATTERN.test(marker.backupId) ||
      !marker.checkpointKey.startsWith(
        nativeStateCheckpointPrefix(marker.workspaceKey),
      )
    ) {
      log("error", "native_transient_backup_marker_invalid", {
        turnId: turn.turnId,
      });
      return false;
    }
    const raw = await this.env.APP_ROUTES.get<unknown>(
      marker.checkpointKey,
      "json",
    );
    const record = raw ? parseNativeStateCheckpointRecord(raw) : null;
    const referenced = record
      ? [
          ...(record.committed ? [record.committed] : []),
          ...record.candidates,
        ].some((version) => version.descriptor.id === marker.backupId)
      : false;
    try {
      if (!referenced) {
        await this.appendNativeBackupDebt(marker.workspaceKey, marker.backupId);
      }
      await this.ctx.storage.delete(markerKey);
      return true;
    } catch (error) {
      log("error", "native_transient_backup_settlement_failed", {
        turnId: turn.turnId,
        message: errorMessage(error),
      });
      return false;
    }
  }

  private async settleAgentTransientBackup(
    turn: TurnRequest,
  ): Promise<boolean> {
    return await this.settleNativeTransientBackup(turn);
  }

  private async cleanupTransientWrites(turn: TurnRequest): Promise<void> {
    const buildKey = `transientBuild:${turn.turnId}`;
    const nativeMarker = await this.ctx.storage.get<NativeTransientBackup>(
      nativeTransientBackupKey(turn.turnId),
    );
    const buildPrefix = await this.ctx.storage.get<string>(buildKey);
    if (nativeMarker) {
      if (!BACKUP_ID_PATTERN.test(nativeMarker.backupId)) {
        throw new Error("Transient native backup descriptor is invalid.");
      }
      const swept = await sweepR2Prefix(
        this.env.BACKUP_BUCKET,
        `backups/${nativeMarker.backupId}/`,
      );
      if (!swept.done) {
        throw new Error("Transient native backup cleanup was truncated.");
      }
      await this.ctx.storage.delete(nativeTransientBackupKey(turn.turnId));
    }
    if (buildPrefix) {
      const retired = await retireTransientAppBuild({
        sweep: async () =>
          await sweepR2Prefix(this.env.APP_BUILDS, `${buildPrefix}/`),
        clearRecovery: async () => {
          await this.ctx.storage.delete(buildKey);
        },
      });
      if (!retired) throw new Error("Transient build cleanup was truncated.");
    }
  }

  /** Shared by alarm and live-unwind owner-fence loss paths. */
  private async cleanupOwnerPurgedTurnStorage(
    turn: TurnRequest,
  ): Promise<boolean> {
    await this.cleanupTransientWrites(turn);
    if (!(await this.ownsExactTurn(turn))) return false;
    return await this.deleteTurnStoragePreservingExactCancellations(turn, true);
  }

  private async settleTerminalTransientWrites(
    turn: TurnRequest,
  ): Promise<boolean> {
    if (turn.kind === "agent") {
      return await this.settleAgentTransientBackup(turn);
    }
    try {
      await this.cleanupTransientWrites(turn);
      return true;
    } catch (error) {
      log("error", "terminal_transient_cleanup_failed", {
        turnId: turn.turnId,
        message: errorMessage(error),
      });
      return false;
    }
  }

  /**
   * Durable app-turn state is the only name for transient backup/build bytes.
   * Never erase it until every named prefix is empty; an alarm retains the
   * owner lease and retries cleanup after a partial R2 failure.
   */
  private async retireTerminalAppTurnStorage(turn: TurnRequest): Promise<void> {
    if (!(await this.ownsExactTurn(turn))) return;
    if (await this.settleTerminalTransientWrites(turn)) {
      await this.deleteTurnStoragePreservingExactCancellations(turn, true);
      return;
    }
    if (await this.ownsExactTurn(turn)) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  private async cancelForOwnerPurge(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      ownerId?: string;
      turnId?: string;
      generation?: string;
      leaseId?: string;
      ownerGeneration?: string;
    };
    const stored = await this.ctx.storage.get<TurnRequest>("turn");
    const turnId = body.turnId;
    const ownerId = body.ownerId;
    const generation = body.generation;
    const leaseId = body.leaseId;
    const ownerGeneration = body.ownerGeneration;
    if (!turnId || !ownerId || !generation || !leaseId || !ownerGeneration) {
      return json({ error: "Owner purge lease identity required." }, 400);
    }
    const leaseTurn: TurnRequest = {
      kind: "agent",
      ownerId,
      ownerGeneration,
      ownerPurgeGeneration: generation,
      ownerPurgeLeaseId: leaseId,
      appId: "agent",
      turnId,
      agentDepth: 1,
      prompt: "",
      audience: "free",
      budgetMicroCents: 0,
    };
    if (
      stored &&
      (stored.turnId !== turnId ||
        stored.ownerId !== ownerId ||
        stored.ownerGeneration !== ownerGeneration ||
        stored.ownerPurgeGeneration !== generation ||
        stored.ownerPurgeLeaseId !== leaseId)
    ) {
      // A delayed generation-N purge callback must never terminalize, destroy,
      // or erase a generation-N+1 attempt that reused this Durable Object. It
      // may still retire its own exact stale lease; leaving that lease active
      // would make the owner-purge coordinator retry this harmless callback
      // forever while the successor remains present.
      if (!(await this.unregisterTurnLease(leaseTurn, leaseId, generation))) {
        return json(
          { canceled: false, reason: "stale_owner_purge_identity", turnId },
          409,
        );
      }
      return json({
        canceled: false,
        reason: "stale_owner_purge_identity",
        turnId,
        unregistered: true,
      });
    }
    if (!stored) {
      // Registration can win and the isolate can die before a turn is durably
      // admitted. In that case there is no execution or transient state to
      // destroy; remove only the exact orphaned owner-fence lease. Never run
      // deleteAll() against a DO that may later admit a successor.
      const retired = await this.unregisterTurnLease(
        leaseTurn,
        leaseId,
        generation,
      );
      return retired
        ? json({ canceled: true, turnId, unregistered: true, orphan: true })
        : json({ error: "Owner lease retirement is pending." }, 409);
    }
    const turn = stored;

    await this.ctx.storage.put("terminal", true);
    await this.ctx.storage.deleteAlarm().catch(() => undefined);
    const turnExecution =
      this.agentTurnExecutions.get(turnId) ??
      this.appTurnExecutions.get(turnId);
    if (turnExecution) {
      try {
        // Close the local admission latch before teardown. Destroying only the
        // currently visible container is insufficient when createSession() is
        // still pending: that promise could resolve after destroy and recreate
        // executable work. interrupt() also boundedly joins that underlying
        // promise-native setup before purge can acknowledge the lease.
        await turnExecution.interrupt(
          new Error("Owner cloud activity is being purged."),
        );
      } catch {
        return json({ error: "Owner turn is still unwinding." }, 409);
      }
    } else {
      const target = await this.currentSandboxTarget();
      if (target) {
        try {
          if (turn.kind === "agent") {
            await this.terminateCurrentAgentSession(turn);
          } else {
            await this.destroySandboxDurably(target, "owner_purge");
          }
        } catch {
          return json({ error: "Owner turn is still unwinding." }, 409);
        }
      }
    }

    const running = [...(this.runningTurns.get(turnId) ?? [])];
    if (running.length > 0) {
      const settled = await Promise.race([
        Promise.allSettled(running).then(() => true),
        runToolEffect(
          Effect.sleep(OWNER_PURGE_STALE_LEASE_GRACE_MS).pipe(Effect.as(false)),
        ),
      ]);
      if (!settled) {
        return json({ error: "Owner turn is still unwinding." }, 409);
      }
    } else if (!turnExecution) {
      // No promise means this lease was recovered after isolate loss (or the
      // turn ended before clearing its durable registration). An outbound
      // callback dispatched by the old isolate may still be completing.
      const key = `ownerPurgeCancelAt:${leaseId}`;
      const startedAt = (await this.ctx.storage.get<number>(key)) ?? Date.now();
      await this.ctx.storage.put(key, startedAt);
      if (Date.now() - startedAt < OWNER_PURGE_STALE_LEASE_GRACE_MS) {
        return json({ error: "Reconciling stale owner turn lease." }, 409);
      }
      await this.ctx.storage.delete(key);
    }

    await this.cleanupTransientWrites(turn);
    await this.deleteTurnStoragePreservingExactCancellations(turn, true);
    // The thread transcript is this owner's private job state and lives in
    // SQL tables the key-value sweep above cannot see.
    purgeThreadTranscript(this.ctx.storage.sql);
    await this.releaseOwnerGate(turn);
    // Do not depend on a vanished run's `finally`: remove the exact durable
    // lease idempotently from the owner fence here.
    return (await this.unregisterTurnLease(turn, leaseId, generation))
      ? json({ canceled: true, turnId, unregistered: true })
      : json({ error: "Owner lease retirement is pending." }, 409);
  }

  private async redeliverOrphan(
    turn: TurnRequest,
    pending: PendingTerminal,
  ): Promise<void> {
    try {
      turn.ownerPurgeGeneration = await this.registerTurn(turn, true);
      await this.assertTurnWritable(turn);
      await this.deliverTerminal(turn, pending);
    } catch (error) {
      if (!(error instanceof OwnerPurgeFenceError)) throw error;
    } finally {
      await this.unregisterTurn(turn);
    }
  }

  private async assertTurnWritable(turn: TurnRequest): Promise<void> {
    if (
      !turn.ownerGeneration ||
      !turn.ownerPurgeGeneration ||
      !turn.ownerPurgeLeaseId
    ) {
      throw new OwnerPurgeFenceError();
    }
    const response = await this.callOwnerFence(turn.ownerId, "assert", {
      ownerGeneration: turn.ownerGeneration,
      generation: turn.ownerPurgeGeneration,
      leaseId: turn.ownerPurgeLeaseId,
    });
    if (!response.ok) throw new OwnerPurgeFenceError();
  }

  private async assertAgentTurnActive(turn: TurnRequest): Promise<void> {
    await this.assertTurnWritable(turn);
    if (
      !(await this.ownsExactTurn(turn)) ||
      (await this.ctx.storage.get<boolean>("terminal"))
    ) {
      throw new Error("The agent turn is no longer active.");
    }
  }

  /**
   * The turn's own identity, which is now the only authority there is.
   *
   * Convex used to be asked, on every side effect, whether this attempt was
   * still the live one (`/api/cloud/agent-turn-authority`, resolved against a
   * reusable turn token). That question is answered locally now: the owner
   * gate admitted the attempt, this object holds the attempt, and its
   * capability is signed and bound to it. What remains is the structural
   * check — a record that cannot name a thread and an attempt is not a turn.
   */
  private assertAgentTurnIdentity(turn: TurnRequest): void {
    if (
      turn.kind !== "agent" ||
      !turn.threadId ||
      !turn.conversationId ||
      !Number.isSafeInteger(turn.attemptGeneration) ||
      turn.attemptGeneration! < 1
    ) {
      throw new AgentTurnAuthorityLostError();
    }
  }

  /** The app-build lane's equivalent of `assertAgentTurnIdentity`. */
  private assertAppTurnIdentity(turn: TurnRequest): void {
    if (
      turn.kind === "agent" ||
      !turn.appId ||
      !turn.conversationId ||
      !turn.sessionId
    ) {
      throw new AppTurnAuthorityLostError();
    }
  }

  /**
   * This thread's transcript, from this object's own SQLite.
   *
   * It used to be a `GET /api/cloud/context` on the continuation's critical
   * path, which made Convex the authority for rows only this object ever
   * writes and put a control-plane round trip in front of every send_input.
   */
  private fetchCanonicalAgentHistory(
    turn: TurnRequest,
    options: { excludeCurrentTurn: boolean; signal?: AbortSignal },
  ): AgentHistoryRow[] {
    options.signal?.throwIfAborted();
    if (!turn.threadId) return [];
    return readThreadHistory(this.ctx.storage.sql, {
      ...(options.excludeCurrentTurn ? { excludeTurnId: turn.turnId } : {}),
    });
  }

  private async assertAgentExecutionActive(
    turn: TurnRequest,
    execution: TurnExecutionContext,
  ): Promise<void> {
    execution.assertActive();
    await this.assertAgentTurnActive(turn);
    this.assertAgentTurnIdentity(turn);
    // Stop can land while the durable owner/turn checks await remote storage.
    // Repeat the local fiber latch immediately before the caller's side effect.
    execution.assertActive();
  }

  private async assertAppTurnActive(turn: TurnRequest): Promise<void> {
    await this.assertTurnWritable(turn);
    if (
      !(await this.ownsExactTurn(turn)) ||
      (await this.ctx.storage.get<boolean>("terminal"))
    ) {
      throw new Error("The app-build turn is no longer active.");
    }
  }

  private async assertAppExecutionActive(
    turn: TurnRequest,
    execution: TurnExecutionContext,
  ): Promise<void> {
    execution.assertActive();
    await this.assertAppTurnActive(turn);
    // Owner purge can land while the durable fence read is in flight.
    execution.assertActive();
  }

  private sandbox(
    id: string,
    size: InstanceSize = "large",
    workload: SandboxWorkload = "app-build",
  ) {
    return sandboxHandle(this.env, { sandboxId: id, size, workload });
  }

  /**
   * Whether the sandbox's container is running right now, answered by the
   * sandbox object itself and never by the container. Every container RPC
   * (process kills included) starts the instance if it is not running, so a
   * teardown that asks the container anything boots the very thing it is
   * retiring. An unanswerable state counts as not running: `destroy()` is the
   * authoritative SIGKILL either way, and a skipped process sweep only costs
   * a native child the prompt stop it would otherwise get.
   */
  private async sandboxContainerRunning(
    sandbox: ReturnType<BuildSession["sandbox"]>,
  ): Promise<boolean> {
    const stateful = sandbox as typeof sandbox & {
      getState?: () => Promise<{ status?: unknown } | undefined>;
    };
    if (typeof stateful.getState !== "function") return false;
    try {
      const state = await withInfrastructureDeadline(
        stateful.getState(),
        10_000,
        "Sandbox state read did not settle.",
      );
      return SANDBOX_RUNNING_STATUSES.has(String(state?.status ?? ""));
    } catch (error) {
      log("error", "sandbox_state_read_failed", {
        ...sandboxLifecycleFailureFields(error),
      });
      return false;
    }
  }

  /**
   * Convert one exact sandbox target into durable teardown debt before the
   * first lifecycle RPC leaves this object.
   */
  private async destroySandboxDurably(
    target: SandboxTarget,
    event: string,
  ): Promise<void> {
    // Revocation precedes every container lifecycle RPC. A failed or delayed
    // destroy can never leave the signed proxy usable while retirement waits.
    await this.ctx.storage.delete(PREVIEW_ACCESS_STORAGE_KEY);
    const now = Date.now();
    let debt!: SandboxDestroyDebt;
    await this.ctx.storage.transaction(async (txn) => {
      debt =
        (await readSandboxDestroyDebt(txn, target)) ??
        createSandboxDestroyDebt(target, now);
      const debtKey = sandboxDestroyDebtKey(target);
      await txn.put(debtKey, debt);
      const existingAlarm = await txn.getAlarm();
      await txn.setAlarm(
        existingAlarm === null
          ? debt.nextAttemptAt
          : Math.min(existingAlarm, debt.nextAttemptAt),
      );
    });
    const sandbox = this.sandbox(
      target.sandboxId,
      target.size,
      target.workload,
    );
    try {
      await withInfrastructureDeadline(
        sandbox.destroy(),
        30_000,
        "Sandbox destruction did not settle.",
      );
    } catch (error) {
      const advanced = advanceSandboxDestroyDebt(debt, Date.now());
      await persistSandboxDestroyDebt(this.ctx.storage, advanced);
      log("error", "sandbox_destroy_deferred", {
        lifecycleReason: event,
        workload: target.workload,
        instanceSize: target.size,
        attemptCount: advanced.attemptCount,
        retryDelayMs: Math.max(0, advanced.nextAttemptAt - Date.now()),
        ...sandboxLifecycleFailureFields(error),
      });
      throw new SandboxLifecycleDeferredError();
    }
    await clearSandboxDestroyDebt(this.ctx.storage, debt);
    log("info", "sandbox_destroyed", {
      lifecycleReason: event,
      workload: target.workload,
      instanceSize: target.size,
      attempts: debt.attemptCount + 1,
    });
  }

  /** One more failed builder-fallback pass for this exact attempt; returns the total. */
  private async recordBuilderFallbackRetry(turn: TurnRequest): Promise<number> {
    const key = builderFallbackRetryKey(turn.turnId, turn.attemptGeneration!);
    const retries = ((await this.ctx.storage.get<number>(key)) ?? 0) + 1;
    await this.ctx.storage.put(key, retries);
    return retries;
  }

  /**
   * Fail a turn whose executor was lost and whose report cannot be recovered.
   * The exact terminal decision is claimed first, then the container is torn
   * down, then the terminal is delivered; a step that cannot complete re-arms
   * the alarm instead of leaving the thread without a terminal.
   */
  private async deliverExecutorLossTerminal(
    turn: TurnRequest,
    text: { message: string; threadError: string },
  ): Promise<void> {
    const recoveredPending: PendingTerminal = {
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      kind: "failed",
      payload: { message: text.message, reason: "executor_recovered" },
      threadError: text.threadError,
      terminateSandbox: true,
    };
    if (
      !(await this.claimTerminalDecision(
        turn,
        recoveredPending,
        Date.now() + 30_000,
      ))
    ) {
      await this.setExactTurnAlarm(turn, Date.now() + 1_000);
      return;
    }
    try {
      await this.terminateCurrentAgentSession(turn);
    } catch (error) {
      if (!(error instanceof SandboxLifecycleDeferredError)) {
        log("error", "recovered_agent_sandbox_termination_deferred", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          message: errorMessage(error),
        });
        return;
      }
      log("error", "recovered_agent_sandbox_termination_deferred", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        ...sandboxLifecycleFailureFields(error),
      });
    }
    const delivered = await this.deliverTerminal(turn, {
      ...recoveredPending,
      terminateSandbox: false,
    });
    if (delivered && (await this.ownsExactTurn(turn))) {
      if (await this.settleAgentTransientBackup(turn)) {
        await this.deleteTurnStoragePreservingExactCancellations(turn, true);
      } else {
        await this.setExactTurnAlarm(turn, Date.now() + 30_000);
      }
    }
  }

  /** Alarm-owned retry pass. Every target is exact; no id-only guessing. */
  private async retryDueSandboxDestroyDebts(now = Date.now()): Promise<void> {
    const debts = await listSandboxDestroyDebts(this.ctx.storage);
    for (const debt of debts) {
      if (!isSandboxDestroyDue(debt, now)) continue;
      await this.destroySandboxDurably(debt.target, "alarm_retry").catch(
        () => undefined,
      );
    }
  }

  /** Re-arm the earliest remaining debt without postponing another alarm. */
  private async scheduleSandboxDestroyDebtAlarm(): Promise<void> {
    const debts = await listSandboxDestroyDebts(this.ctx.storage);
    const next = debts.reduce<number | null>(
      (earliest, debt) =>
        earliest === null
          ? debt.nextAttemptAt
          : Math.min(earliest, debt.nextAttemptAt),
      null,
    );
    if (next === null) return;
    const existing = await this.ctx.storage.getAlarm();
    await this.ctx.storage.setAlarm(
      existing === null ? next : Math.min(existing, next),
    );
  }

  /** Keep the one DO alarm at the earliest lease, teardown, or receipt debt. */
  private async scheduleDurabilityAlarm(): Promise<void> {
    await this.scheduleSandboxDestroyDebtAlarm();
    if (await this.hasOwnerFenceLeaseRetirementDebt()) {
      await this.armOwnerFenceLeaseReconciliationAlarm();
    }
    // Deferred projections are durability debt like any other: without a wake
    // a queue outage would strand a terminal state Convex never hears about.
    const outboxDebt =
      await this.ctx.storage.get<OutboxEvent[]>(OUTBOX_DEBT_KEY);
    if (outboxDebt && outboxDebt.length > 0) {
      const retryAt = Date.now() + OUTBOX_DEBT_RETRY_MS;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > retryAt) {
        await this.ctx.storage.setAlarm(retryAt);
      }
    }
  }

  /**
   * The sandbox this DO is currently responsible for. Size matters as much as
   * id: the two container classes are separate namespaces, so destroying by
   * id alone against the wrong one silently leaves a live container behind.
   */
  private async currentSandboxTarget(): Promise<SandboxTarget | undefined> {
    const [storedSandboxId, storedSize, turn] = await Promise.all([
      this.ctx.storage.get<string>("sandboxId"),
      this.ctx.storage.get<InstanceSize>("sandboxSize"),
      this.ctx.storage.get<TurnRequest>("turn"),
    ]);
    if (
      turn?.kind === "agent" &&
      Number.isSafeInteger(turn.attemptGeneration) &&
      turn.attemptGeneration! >= 1
    ) {
      const identity = {
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration!,
      };
      const compute = parsePersistedAgentCompute(
        await this.ctx.storage.get(
          agentComputeKey(identity.turnId, identity.attemptGeneration),
        ),
        identity,
      );
      // A valid exact compute record is tuple authority as a whole. Resident
      // means no sandbox; attaching and later phases carry both exact id and
      // namespace-selecting size. Never combine either with a stale mirror.
      if (compute) {
        return compute.sandboxId
          ? {
              sandboxId: compute.sandboxId,
              size: compute.instanceSize,
              workload: "world",
            }
          : undefined;
      }
      return storedSandboxId
        ? {
            sandboxId: storedSandboxId,
            size: storedSize ?? "large",
            workload: "world",
          }
        : undefined;
    }
    return storedSandboxId
      ? {
          sandboxId: storedSandboxId,
          size: storedSize ?? "large",
          workload: "app-build",
        }
      : undefined;
  }

  private async currentSandbox() {
    const target = await this.currentSandboxTarget();
    return target
      ? this.sandbox(target.sandboxId, target.size, target.workload)
      : undefined;
  }

  /** Release one turn's processes, daemon, session, and bridge directory. */
  private async terminateCurrentAgentSession(turn: TurnRequest): Promise<void> {
    const target = await this.ctx.storage.transaction(async (txn) => {
      const markerKey =
        turn.kind === "agent" &&
        Number.isSafeInteger(turn.attemptGeneration) &&
        turn.attemptGeneration! >= 1
          ? agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!)
          : undefined;
      const computeIdentity =
        turn.kind === "agent" &&
        Number.isSafeInteger(turn.attemptGeneration) &&
        turn.attemptGeneration! >= 1
          ? {
              turnId: turn.turnId,
              attemptGeneration: turn.attemptGeneration!,
            }
          : undefined;
      const [current, storedSandboxId, storedSize, executionMarker, compute] =
        await Promise.all([
          txn.get<TurnRequest>("turn"),
          txn.get<string>("sandboxId"),
          txn.get<InstanceSize>("sandboxSize"),
          markerKey
            ? txn.get<AgentExecutionMarker>(markerKey)
            : Promise.resolve(undefined),
          computeIdentity
            ? txn
                .get(
                  agentComputeKey(
                    computeIdentity.turnId,
                    computeIdentity.attemptGeneration,
                  ),
                )
                .then((value) =>
                  parsePersistedAgentCompute(value, computeIdentity),
                )
            : Promise.resolve(null),
        ]);
      // The ladder's exact record wins over the eager-path mirrors.
      const sandboxId = compute ? compute.sandboxId : storedSandboxId;
      if (
        !sandboxId ||
        (!compute && !exactTurnIdentityMatches(current, turn))
      ) {
        return undefined;
      }
      const size = compute
        ? compute.instanceSize
        : (storedSize ?? ("large" as const));
      return {
        sandboxId,
        size,
        workload:
          turn.kind === "agent" ? ("world" as const) : ("app-build" as const),
        sessionId: compute?.sessionId ?? agentTurnSessionId(turn.turnId),
        daemonDirectory:
          compute?.daemonDirectory ??
          attachedToolPaths({
            turnId: turn.turnId,
            attemptGeneration: turn.attemptGeneration ?? 1,
          }).directory,
        executorAdmitted:
          executionMarker?.schemaVersion === 1 &&
          executionMarker.turnId === turn.turnId &&
          executionMarker.attemptGeneration === turn.attemptGeneration &&
          executionMarker.sandboxId === sandboxId &&
          executionMarker.size === size,
      };
    });
    if (!target) return;
    if (turn.kind !== "agent") return;
    await this.releaseAgentSessionResources({ ...target, workload: "world" });
  }

  private async releaseAgentSessionResources(target: {
    sandboxId: string;
    size: InstanceSize;
    workload: "world";
    sessionId: string;
    daemonDirectory: string;
  }): Promise<void> {
    const sandbox = this.sandbox(
      target.sandboxId,
      target.size,
      target.workload,
    );
    if (!(await this.sandboxContainerRunning(sandbox))) return;
    await withInfrastructureDeadline(
      sandbox.killAllProcesses(target.sessionId),
      30_000,
      "Agent process teardown did not settle.",
    ).catch(() => undefined);
    await withInfrastructureDeadline(
      sandbox.killProcess(
        `attached-daemon-${target.sessionId}`.slice(0, 64),
        "SIGKILL",
      ),
      10_000,
      "Attached daemon teardown did not settle.",
    ).catch(() => undefined);
    const session = await sandbox
      .getSession(target.sessionId)
      .catch(() => undefined);
    await session
      ?.exec(`rm -rf -- '${target.daemonDirectory.replace(/'/gu, `'"'"'`)}'`, {
        origin: "internal",
      })
      .catch(() => undefined);
    await sandbox.deleteSession(target.sessionId).catch(() => undefined);
  }

  /**
   * Build and publish an immutable Stella-interior candidate.
   *
   * The source tree is agent-controlled, so the immutable executor script
   * applies the first set of bounds and this Worker repeats all trust-boundary
   * checks while reading the output. The callback records a candidate only;
   * activation remains an authenticated user/control-plane operation.
   */
  private async publishInteriorCandidate(
    turn: TurnRequest,
    sandbox: ReturnType<BuildSession["sandbox"]>,
    commandTimeoutMs: number,
    turnExecution: TurnExecutionContext,
  ): Promise<{
    buildId: string;
    artifactPrefix: string;
    previewUrl: string;
    digest: string;
    size: number;
    sourceRevision: string;
    baseRevision?: string;
  }> {
    await this.assertAgentExecutionActive(turn, turnExecution);
    if (!turn.threadId) {
      throw new Error("Invalid Stella interior build context.");
    }
    let unrecordedArtifactPrefix: string | undefined;
    let callbackAttempted = false;
    const buildRoot = `/workspace/.stella-interior-build/${sessionName(turn.turnId)}`;
    const outputRoot = `${buildRoot}/dist`;
    turnExecution.assertActive();
    const session = await sandbox.createSession({
      id: sessionName(`interior-build-${turn.turnId}`),
      cwd: "/opt/stella",
      commandTimeoutMs,
      env: {
        STELLA_INTERIOR_SOURCE_ROOT: WORLD_STELLA_ROOT,
        STELLA_INTERIOR_OUTPUT_ROOT: outputRoot,
        VITE_CONVEX_URL: requirePublicOrigin(
          this.env.STELLA_CONVEX_CLOUD_URL,
          "STELLA_CONVEX_CLOUD_URL",
        ),
        VITE_CONVEX_SITE_URL: requirePublicOrigin(
          this.env.STELLA_CONVEX_SITE_URL,
          "STELLA_CONVEX_SITE_URL",
        ),
        VITE_STELLA_APPS_HOST: requirePublicOrigin(
          this.env.APPS_HOST_BASE_URL,
          "APPS_HOST_BASE_URL",
        ),
        VITE_STELLA_APPS_AUTH_HOST: requirePublicOrigin(
          this.env.TRUSTED_APPS_HOST_BASE_URL,
          "TRUSTED_APPS_HOST_BASE_URL",
        ),
        VITE_STELLA_PROTOCOL: "stella",
        USER: "stella-tools",
        LOGNAME: "stella-tools",
        HOME: "/workspace/.stella-tool-home",
        XDG_CONFIG_HOME: "/workspace/.stella-tool-home/.config",
        XDG_CACHE_HOME: "/workspace/.stella-tool-home/.cache",
        XDG_STATE_HOME: "/workspace/.stella-tool-home/.local/state",
      },
    });
    turnExecution.assertActive();
    try {
      turnExecution.assertActive();
      const preparedBuildRoot = await session.exec(
        inSubshell(
          [
            "set -eu",
            "test ! -L /workspace/.stella-interior-build 2>/dev/null || exit 1",
            "if [ -e /workspace/.stella-interior-build ]; then test -d /workspace/.stella-interior-build && test \"$(stat -c '%u:%g:%a' /workspace/.stella-interior-build)\" = 0:0:700; else mkdir /workspace/.stella-interior-build && chmod 0700 /workspace/.stella-interior-build; fi",
            `rm -rf '${buildRoot}'`,
            `mkdir '${buildRoot}'`,
            `chown 42424:42424 '${buildRoot}'`,
            `chmod 0700 '${buildRoot}'`,
          ].join("; "),
        ),
      );
      if (!preparedBuildRoot.success) {
        throw new Error(
          "The Stella interior build boundary could not be prepared.",
        );
      }
      const execution = (await strictSessionExec(
        session,
        ["bun", "packages/executor-cloud/src/interior-build.ts"],
        { timeout: commandTimeoutMs },
      )) as Execution;
      turnExecution.assertActive();
      if (!execution.success) {
        log("error", "interior_build_command_failed", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          ...executionFailureFields(execution.stderr),
        });
        throw new Error("The Stella interior production build failed.");
      }
      const output = JSON.parse(
        execution.stdout.trim().split("\n").at(-1) ?? "{}",
      ) as InteriorBuildOutput;
      if (
        output.schemaVersion !== 1 ||
        output.outputRoot !== outputRoot ||
        !/^sha256:[0-9a-f]{64}$/.test(output.sourceRevision) ||
        !/^sha256:[0-9a-f]{64}$/.test(output.upstreamSeedRevision) ||
        (output.baseRevision !== undefined &&
          !/^sha256:[0-9a-f]{64}$/.test(output.baseRevision)) ||
        !SHA256_HEX.test(output.artifactSha256) ||
        !Number.isSafeInteger(output.size) ||
        output.size < 0 ||
        output.size > INTERIOR_MAX_BYTES ||
        !Array.isArray(output.files) ||
        output.files.length === 0 ||
        output.files.length > INTERIOR_MAX_FILES ||
        output.entries?.full !== "index.html" ||
        output.entries?.mini !== "mini.html" ||
        output.entries?.overlay !== "overlay.html" ||
        output.entries?.pet !== "pet.html"
      ) {
        throw new Error(
          "The Stella interior builder returned invalid metadata.",
        );
      }

      const paths = new Set<string>();
      const portablePaths = new Set<string>();
      let declaredBytes = 0;
      for (const file of output.files) {
        if (
          typeof file.path !== "string" ||
          !SAFE_ARTIFACT_PATH.test(file.path) ||
          file.path.length > 1_024 ||
          paths.has(file.path) ||
          portablePaths.has(file.path.toLowerCase()) ||
          !Number.isSafeInteger(file.size) ||
          file.size < 0 ||
          file.size > INTERIOR_MAX_FILE_BYTES ||
          !SHA256_HEX.test(file.sha256)
        ) {
          throw new Error(
            "The Stella interior contains invalid artifact metadata.",
          );
        }
        paths.add(file.path);
        portablePaths.add(file.path.toLowerCase());
        declaredBytes += file.size;
        if (declaredBytes > INTERIOR_MAX_BYTES) {
          throw new Error("The Stella interior artifact is too large.");
        }
        const expectedContentType = contentType(file.path);
        if (file.contentType !== expectedContentType) {
          throw new Error(
            "The Stella interior content type manifest is invalid.",
          );
        }
      }
      const aggregateSource = JSON.stringify(
        output.files.map((file) => ({
          path: file.path,
          size: file.size,
          sha256: file.sha256,
        })),
      );
      if (
        declaredBytes !== output.size ||
        (await sha256Hex(aggregateSource)) !== output.artifactSha256 ||
        !Object.values(output.entries).every((entry) => paths.has(entry)) ||
        !output.files.some((file) => file.path.startsWith("assets/"))
      ) {
        throw new Error("The Stella interior artifact digest is invalid.");
      }

      const ownerHash = await sha256Hex(turn.ownerId);
      const buildId = `interior-${(
        await sha256Hex(
          `${turn.ownerId}\0${turn.turnId}\0${output.artifactSha256}`,
        )
      ).slice(0, 48)}`;
      const artifactPrefix = `interiors/${ownerHash}/${buildId}`;
      unrecordedArtifactPrefix = artifactPrefix;
      turnExecution.assertActive();
      await this.ctx.storage.put(
        `transientBuild:${turn.turnId}`,
        artifactPrefix,
      );
      turnExecution.assertActive();
      let appsHost: URL;
      try {
        appsHost = new URL(this.env.APPS_HOST_BASE_URL);
      } catch {
        throw new Error("The Stella apps host URL is invalid.");
      }
      if (
        appsHost.protocol !== "https:" ||
        appsHost.username ||
        appsHost.password ||
        appsHost.search ||
        appsHost.hash ||
        appsHost.pathname !== "/"
      ) {
        throw new Error("The Stella apps host URL is invalid.");
      }
      const assetBaseUrl = `${appsHost.origin}/interior-builds/${ownerHash}/${buildId}/`;
      const files = output.files.map((file) => ({
        path: file.path,
        url: `${assetBaseUrl}${file.path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        size: file.size,
        sha256: file.sha256,
        contentType: file.contentType,
      }));
      const manifest = {
        schemaVersion: 1,
        buildId,
        version: buildId,
        artifactPrefix,
        entries: output.entries,
        files,
        artifactSha256: output.artifactSha256,
        size: output.size,
        bridgeAbi: INTERIOR_BRIDGE_ABI,
        minShellVersion: INTERIOR_MIN_SHELL_VERSION,
      };
      const manifestJson = JSON.stringify(manifest);
      if (new TextEncoder().encode(manifestJson).byteLength > 240 * 1024) {
        throw new Error("The Stella interior artifact manifest is too large.");
      }
      const digest = `sha256:${output.artifactSha256}`;
      const manifestSha256 = `sha256:${await sha256Hex(manifestJson)}`;
      for (const file of output.files) {
        turnExecution.assertActive();
        const read = await session.readFile(`${outputRoot}/${file.path}`, {
          encoding: "base64",
        });
        turnExecution.assertActive();
        const bytes = Uint8Array.from(atob(read.content), (char) =>
          char.charCodeAt(0),
        );
        if (
          bytes.byteLength !== file.size ||
          (await sha256BytesHex(bytes)) !== file.sha256
        ) {
          throw new Error(
            `Interior artifact changed while reading ${file.path}.`,
          );
        }
        await this.assertAgentExecutionActive(turn, turnExecution);
        const objectKey = `${artifactPrefix}/${file.path}`;
        await this.env.APP_BUILDS.put(objectKey, bytes, {
          httpMetadata: {
            contentType: file.contentType,
            cacheControl: "public, max-age=31536000, immutable",
          },
          customMetadata: {
            buildId,
            ownerHash,
            kind: "stella-interior",
          },
        });
        try {
          await this.assertAgentExecutionActive(turn, turnExecution);
        } catch (error) {
          await this.env.APP_BUILDS.delete(objectKey).catch(() => undefined);
          throw error;
        }
      }

      // Re-check the DO fence after the expensive build/upload and before the
      // only durable control-plane effect. Uploaded bytes are immutable and
      // harmless if a successor won; no candidate row points to them.
      await this.assertAgentExecutionActive(turn, turnExecution);
      // Once the callback starts, a transport error is ambiguous: Convex may
      // have committed the immutable row before the response was lost. Keep
      // those bytes for bounded idempotent callback retries. Before this point
      // (partial upload, validation failure, or superseded turn), no row can
      // exist, so the prefix is safe to remove immediately.
      const callbackBody = {
        ownerId: turn.ownerId,
        buildId,
        turnId: turn.turnId,
        threadId: turn.threadId,
        ...(output.baseRevision ? { baseRevision: output.baseRevision } : {}),
        sourceRevision: output.sourceRevision,
        artifactPrefix,
        manifestJson,
        manifestSha256,
        digest,
        size: output.size,
        bridgeAbi: INTERIOR_BRIDGE_ABI,
        minShellVersion: INTERIOR_MIN_SHELL_VERSION,
      };
      callbackAttempted = true;
      turnExecution.assertActive();
      await this.assertTurnWritable(turn);
      turnExecution.assertActive();
      // The projection is the outbox's problem now: the bytes are already in
      // R2 under `artifactPrefix`, and the event that names them is durable
      // the moment it is queued (or recorded as debt and retried by the
      // alarm). There is nothing left here for a bespoke retry ladder to do.
      await this.enqueueOutboxDurable([
        {
          ...this.outboxBase(turn, buildId),
          kind: "interior-build.recorded",
          buildId,
          payload: callbackBody,
        } satisfies InteriorBuildRecordedEvent,
      ]);
      turnExecution.assertActive();
      turnExecution.assertActive();
      await this.ctx.storage.delete(`transientBuild:${turn.turnId}`);
      turnExecution.assertActive();

      // This builder-owned state is checkpointed with the source but excluded
      // from the next source digest. It supplies the next candidate's explicit
      // baseRevision, including across sandbox destruction/restoration.
      await session.writeFile(
        `${WORLD_STELLA_ROOT}/.stella/interior-source.json`,
        `${JSON.stringify({
          schemaVersion: 1,
          sourceRevision: output.sourceRevision,
          upstreamSeedRevision: output.upstreamSeedRevision,
          buildId,
        })}\n`,
      );
      turnExecution.assertActive();
      return {
        buildId,
        artifactPrefix,
        previewUrl: assetBaseUrl,
        digest,
        size: output.size,
        sourceRevision: output.sourceRevision,
        ...(output.baseRevision ? { baseRevision: output.baseRevision } : {}),
      };
    } catch (error) {
      if (unrecordedArtifactPrefix && !callbackAttempted) {
        const cleaned = await sweepR2Prefix(
          this.env.APP_BUILDS,
          `${unrecordedArtifactPrefix}/`,
        ).catch((cleanupError) => {
          log("error", "interior_orphan_cleanup_failed", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            artifactPrefix: unrecordedArtifactPrefix,
            message: errorMessage(cleanupError),
          });
          return undefined;
        });
        if (cleaned?.done) {
          await this.ctx.storage.delete(`transientBuild:${turn.turnId}`);
        }
      }
      throw error;
    } finally {
      await session
        .exec("rm -rf /workspace/.stella-interior-build")
        .catch(() => undefined);
      await sandbox.deleteSession(session.id).catch(() => undefined);
    }
  }

  /**
   * Interior builds are opt-in: the agent asks for one through the turn broker
   * during the turn, and this runs after the executor is gone because
   * `publishInteriorCandidate` quiesces the session it would still be using.
   */
  private async publishRequestedInteriorCandidate(args: {
    turn: TurnRequest;
    sandbox: ReturnType<BuildSession["sandbox"]>;
    commandTimeoutMs: number;
    turnExecution: TurnExecutionContext;
  }): Promise<
    | { outcome: "not_requested" }
    | { outcome: "abandoned" }
    | { outcome: "failed"; error: string }
    | {
        outcome: "published";
        candidate: Awaited<
          ReturnType<BuildSession["publishInteriorCandidate"]>
        >;
      }
  > {
    const { turn, turnExecution } = args;
    const requested = await this.ctx.storage.get<InteriorBuildRequestRecord>(
      interiorBuildRequestKey(turn.turnId, turn.attemptGeneration!),
    );
    if (
      !exactInteriorBuildRequested(
        requested,
        turn.turnId,
        turn.attemptGeneration!,
      )
    ) {
      return { outcome: "not_requested" };
    }
    await this.event(
      turn,
      "auto",
      "interior_build_started",
      {},
      false,
      turnExecution.signal,
    ).catch(() => undefined);
    try {
      const candidate = await this.publishInteriorCandidate(
        turn,
        args.sandbox,
        args.commandTimeoutMs,
        turnExecution,
      );
      await this.event(
        turn,
        "auto",
        "interior_candidate_created",
        {
          buildId: candidate.buildId,
          previewUrl: candidate.previewUrl,
          digest: candidate.digest,
          size: candidate.size,
          sourceRevision: candidate.sourceRevision,
          baseRevision: candidate.baseRevision,
          activated: false,
        },
        false,
        turnExecution.signal,
      ).catch(() => undefined);
      return { outcome: "published", candidate };
    } catch (error) {
      if (
        !(await this.ownsExactTurn(turn)) ||
        (await this.ctx.storage.get<boolean>("terminal"))
      ) {
        return { outcome: "abandoned" };
      }
      log("error", "interior_candidate_failed", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message: errorMessage(error),
      });
      await this.event(
        turn,
        "auto",
        "interior_build_failed",
        {
          message:
            "The updated Stella interior did not pass its production build.",
        },
        false,
        turnExecution.signal,
      ).catch(() => undefined);
      return {
        outcome: "failed",
        error:
          "The agent's source changes were kept, but the updated Stella interior did not pass its production build, so no candidate was created.",
      };
    }
  }

  private async scheduleAppBuildPublicationRetry(
    turn: TurnRequest,
    error: unknown,
  ): Promise<boolean> {
    let attempts = 0;
    let retryDelayMs = 0;
    const retained = await this.mutateExactTurn(turn, async (txn) => {
      attempts =
        ((await txn.get<number>("appBuildPublicationAttempts")) ?? 0) + 1;
      retryDelayMs = Math.min(
        15 * 60_000,
        5_000 * 2 ** Math.min(attempts - 1, 7),
      );
      await txn.put("appBuildPublicationAttempts", attempts);
      await txn.setAlarm(Date.now() + retryDelayMs);
    });
    if (!retained) return false;
    log("error", "app_build_publication_retrying", {
      turnId: turn.turnId,
      attempts,
      retryDelayMs,
      message: errorMessage(error),
    });
    return true;
  }

  /**
   * Replays the idempotent build callback after response loss. Permanent 4xx
   * rejection transitions to cleanup, where the public route and every R2
   * object are removed before the recovery marker can disappear.
   */
  private async advanceAppBuildPublication(
    turn: TurnRequest,
    pending: PendingAppBuildPublication,
  ): Promise<"completed" | "failed" | "retrying" | "superseded"> {
    const state = pending;
    if (state.phase === "callback" && state.buildId) {
      try {
        await this.enqueueOutboxDurable([
          {
            ...this.outboxBase(turn, state.buildId),
            kind: "build.recorded",
            buildId: state.buildId,
            payload: state.callbackBody,
          } satisfies BuildRecordedEvent,
        ]);
      } catch (error) {
        return (await this.scheduleAppBuildPublicationRetry(turn, error))
          ? "retrying"
          : "superseded";
      }
    }

    if (state.phase === "cleanup") {
      try {
        await this.cleanupTransientWrites(turn);
      } catch (error) {
        return (await this.scheduleAppBuildPublicationRetry(turn, error))
          ? "retrying"
          : "superseded";
      }
      try {
        await this.event(
          turn,
          state.completionSeq,
          "failed",
          {
            message:
              state.failureMessage ??
              "Stella hit a problem while publishing. Try again.",
          },
          true,
        );
      } catch (error) {
        return (await this.scheduleAppBuildPublicationRetry(turn, error))
          ? "retrying"
          : "superseded";
      }
      if (
        !(await this.mutateExactTurn(turn, async (txn) => {
          await txn.delete(pendingAppBuildPublicationKey(turn.turnId));
          await txn.put({ terminal: true, terminalDelivered: true });
        }))
      ) {
        return "superseded";
      }
      return "failed";
    }

    try {
      await this.event(
        turn,
        state.completionSeq,
        "completed",
        state.completionResult,
        true,
      );
    } catch (error) {
      return (await this.scheduleAppBuildPublicationRetry(turn, error))
        ? "retrying"
        : "superseded";
    }
    if (
      !(await this.mutateExactTurn(turn, async (txn) => {
        await txn.delete([
          pendingAppBuildPublicationKey(turn.turnId),
          `transientBuild:${turn.turnId}`,
          "appBuildPublicationAttempts",
        ]);
        await txn.put({ terminal: true, terminalDelivered: true });
      }))
    ) {
      return "superseded";
    }
    return "completed";
  }

  // The detached agent-turn promise and the alarm share this DO's storage;
  // a stale turn (superseded by a send_input continuation on the same
  // thread) must never mutate the successor's state or complete its thread.
  private async ownsExactTurn(turn: TurnRequest): Promise<boolean> {
    return exactTurnIdentityMatches(
      await this.ctx.storage.get<TurnRequest>("turn"),
      turn,
    );
  }

  private async mutateExactTurn(
    turn: TurnRequest,
    operation: (txn: DurableObjectTransaction) => Promise<void>,
  ): Promise<boolean> {
    return await this.ctx.storage.transaction(async (txn) => {
      if (!exactTurnIdentityMatches(await txn.get<TurnRequest>("turn"), turn)) {
        return false;
      }
      await operation(txn);
      return true;
    });
  }

  private async setExactTurnAlarm(
    turn: TurnRequest,
    scheduledTime: number,
  ): Promise<boolean> {
    return await this.mutateExactTurn(turn, async (txn) => {
      await txn.setAlarm(scheduledTime);
    });
  }

  /**
   * The positional shape every call site in this file already uses. `"auto"`
   * takes the next DO-assigned ordinal; an explicit number is an idempotent
   * retry of an ordinal this turn already reserved.
   */
  private event(
    turn: TurnRequest,
    seq: number | "auto",
    kind: string,
    payload: unknown,
    terminal = false,
    executionSignal?: AbortSignal,
  ): Promise<number> {
    return this.emitTurnEvent(turn, kind, payload, {
      terminal,
      ...(seq === "auto" ? {} : { eventSeq: seq }),
      ...(executionSignal ? { signal: executionSignal } : {}),
    });
  }

  /**
   * Atomically claim this DO's one terminal decision. Cancel, timeout and the
   * normal process unwind are separate async paths; a read-then-write fence
   * lets the loser overwrite the winner between awaits.
   */
  private async claimTerminalDecision(
    turn: TurnRequest,
    pending: PendingTerminal,
    alarmAt?: number,
  ): Promise<boolean> {
    return await this.ctx.storage.transaction(async (txn) => {
      const [currentTurn, terminalAlreadyDecided, decided] = await Promise.all([
        txn.get<TurnRequest>("turn"),
        txn.get<boolean>("terminal"),
        txn.get<PendingTerminal>("pendingTerminal"),
      ]);
      if (!exactTurnIdentityMatches(currentTurn, turn)) return false;
      if (
        terminalAlreadyDecided &&
        (!decided ||
          decided.turnId !== pending.turnId ||
          decided.kind !== pending.kind ||
          decided.eventKind !== pending.eventKind)
      ) {
        return false;
      }
      await txn.put({
        terminal: true,
        pendingTerminal: pending,
        alarmAttempts: 0,
      });
      await txn.delete(PENDING_BROWSER_SUSPENSION_KEY);
      await txn.delete(OBSERVED_BROWSER_SUSPENSION_KEY);
      if (alarmAt !== undefined) {
        await txn.setAlarm(alarmAt);
      }
      return true;
    });
  }

  /**
   * Decide a turn's terminal state and get it to Convex, durably.
   *
   * Delivery is two callbacks — the terminal event, then the thread's final
   * state — and either can fail on a transient Convex 5xx. Both are recorded
   * in DO storage before the first attempt and retried by a re-armed alarm:
   * the success path used to throw straight into the failure handler, which
   * reported "The agent hit a problem and stopped" over a completed,
   * checkpointed turn and discarded the agent's report with it.
   *
   * Redelivery is safe: Convex rejects every event after the first terminal
   * one (answering `terminalAccepted: false` rather than an error) and the
   * thread mutation is a no-op once the thread is terminal, so a retry can
   * never produce a second terminal state.
   *
   * Returns whether the state is known to have landed; storage (and its
   * alarm) must stay intact when it has not.
   */
  private async deliverTerminal(
    turn: TurnRequest,
    pendingInput: PendingTerminal,
    options: { preservePendingTerminal?: boolean } = {},
  ): Promise<boolean> {
    let pending = pendingInput;
    // Fencing: a stale turn may still deliver its own outcome (Convex sorts
    // out which one is terminal), but it must not write over the successor's
    // storage or arm the successor's alarm.
    const owns = await this.ownsExactTurn(turn);
    // The second callback is *thread*-scoped, and the only thing that fences
    // it Convex-side is the thread not being "running" — which a successor
    // continuation has just undone. So a stale payload replayed here (the
    // orphan in acceptAgentTurn) would complete the thread out from under the
    // turn now running on it: the user is told the agent stopped, and the
    // live turn's own report is later dropped as a duplicate. Read the
    // successor once, before either callback, so a mid-delivery takeover
    // cannot flip the decision halfway through.
    const successor = owns
      ? undefined
      : await this.ctx.storage.get<TurnRequest>("turn");
    const supersededThread =
      successor !== undefined &&
      !exactTurnIdentityMatches(successor, turn) &&
      successor.threadId === turn.threadId;
    if (
      (turn.kind === "agent" &&
        (!Number.isSafeInteger(turn.attemptGeneration) ||
          pending.attemptGeneration !== turn.attemptGeneration)) ||
      (turn.kind !== "agent" && pending.attemptGeneration !== 1)
    ) {
      log("error", "terminal_attempt_generation_mismatch", {
        turnId: turn.turnId,
        pendingAttemptGeneration: pending.attemptGeneration,
        turnAttemptGeneration: turn.attemptGeneration,
      });
      return false;
    }
    // Both are fixed before the decision is claimed, so a redelivery repeats
    // the same event ordinal and the same wake fingerprint instead of minting
    // new ones the control plane would have to reconcile.
    const decided: PendingTerminal = {
      ...pending,
      eventSeq:
        pending.eventSeq ??
        nextTurnEventSeq(
          this.ctx.storage.sql,
          turn.turnId,
          turn.attemptGeneration ?? 1,
        ),
      completedAt: pending.completedAt ?? Date.now(),
    };
    pending = decided;
    if (owns) {
      if (!(await this.claimTerminalDecision(turn, decided))) {
        const current =
          await this.ctx.storage.get<PendingTerminal>("pendingTerminal");
        log("info", "terminal_decision_superseded", {
          turnId: turn.turnId,
          attemptedKind: pending.kind,
          decidedKind: current?.kind,
        });
        return false;
      }
    }
    try {
      // Turn-scoped and unconditional: this is what gives the turn — orphaned
      // or not — its one terminal state, and Convex rejects a second one.
      await this.event(
        turn,
        pending.eventSeq ?? "auto",
        pending.eventKind ?? pending.kind,
        pending.payload,
        true,
      );
      if (turn.kind === "agent" && turn.threadId) {
        if (supersededThread) {
          log("info", "terminal_thread_completion_skipped", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            kind: pending.kind,
          });
        } else {
          const finalText =
            typeof pending.payload.finalText === "string"
              ? pending.payload.finalText
              : "";
          const completedAt = pending.completedAt ?? Date.now();
          const resultJson =
            pending.kind === "completed"
              ? JSON.stringify({ finalText })
              : undefined;
          const errorMessage =
            pending.kind === "completed"
              ? undefined
              : (pending.threadError ?? "The agent stopped.");
          await this.enqueueOutboxDurable([
            {
              ...this.outboxBase(
                turn,
                `${turn.threadId}:${turn.turnId}:${turn.attemptGeneration ?? 1}`,
              ),
              kind: "thread.completed",
              threadId: turn.threadId,
              turnId: turn.turnId,
              attemptGeneration: turn.attemptGeneration ?? 1,
              status: pending.kind,
              ...(resultJson ? { resultJson } : {}),
              ...(errorMessage ? { errorMessage } : {}),
              completedAt,
            } satisfies ThreadCompletedEvent,
          ]);
          // The projection above is how the UI learns the thread ended; it is
          // NOT how the parent conversation learns. Convex used to do both in
          // one mutation, so the wake rode on the callback's latency and its
          // retry ladder. The parent session lives one Durable Object away, so
          // it is woken directly and the outbox stays a pure projection.
          await this.wakeParentAgentOrConversation(turn, {
            status: pending.kind,
            threadUpdatedAt: completedAt,
            ...(resultJson ? { resultJson } : {}),
            ...(errorMessage ? { errorMessage } : {}),
          });
        }
      }
      if (owns) {
        await this.ctx.storage.transaction(async (txn) => {
          if (
            !exactTurnIdentityMatches(await txn.get<TurnRequest>("turn"), turn)
          ) {
            return;
          }
          await txn.put("terminalDelivered", true);
          if (!options.preservePendingTerminal) {
            await txn.delete("pendingTerminal");
          }
        });
      }
      // The owner's agent slot goes back the moment the outcome is durable —
      // every terminal path (normal unwind, watchdog, cancel, recovery)
      // funnels through here, so this is the one release that matters.
      await this.releaseOwnerGate(turn);
      return true;
    } catch (error) {
      log("error", "terminal_delivery_failed", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        kind: pending.kind,
        message: errorMessage(error),
      });
      if (!owns) return false;
      // No exponential ladder any more: delivery is an outbox append plus a
      // Durable Object call, both of which fail fast and locally. The one
      // fixed retry exists so a queue outage or a parent object that is
      // briefly unavailable does not strand a decided terminal.
      let attempts = 0;
      const retained = await this.ctx.storage.transaction(async (txn) => {
        if (
          !exactTurnIdentityMatches(await txn.get<TurnRequest>("turn"), turn)
        ) {
          return false;
        }
        attempts = ((await txn.get<number>("alarmAttempts")) ?? 0) + 1;
        await txn.put("alarmAttempts", attempts);
        await txn.setAlarm(Date.now() + 30_000);
        return true;
      });
      if (!retained) return false;
      if (attempts === 6 || attempts % 20 === 0) {
        log("error", "terminal_delivery_still_retrying", {
          turnId: turn.turnId,
          attempts,
          message: errorMessage(error),
        });
      }
      return false;
    }
  }

  private agentCompletionText(
    turn: TurnRequest,
    completion: {
      status: "completed" | "failed" | "canceled";
      resultJson?: string;
      errorMessage?: string;
    },
  ): string {
    let resultText = completion.errorMessage ?? "";
    if (completion.resultJson) {
      try {
        const parsed = JSON.parse(completion.resultJson) as {
          finalText?: unknown;
        };
        resultText =
          typeof parsed.finalText === "string" && parsed.finalText.trim()
            ? parsed.finalText
            : completion.resultJson;
      } catch {
        resultText = completion.resultJson;
      }
    }
    const label =
      completion.status === "completed"
        ? "[Agent completed]"
        : completion.status === "canceled"
          ? "[Agent canceled]"
          : "[Agent failed]";
    const description = turn.description?.trim() || turn.threadId;
    return `${label} ${description} (thread ${turn.threadId})\n\n${
      resultText || "No result was reported."
    }`.slice(0, TURN_PROMPT_MAX_CHARS);
  }

  private async wakeParentAgentOrConversation(
    turn: TurnRequest,
    completion: {
      status: "completed" | "failed" | "canceled";
      threadUpdatedAt: number;
      resultJson?: string;
      errorMessage?: string;
    },
  ): Promise<void> {
    if (turn.parentThreadId && turn.threadId) {
      const steered = await steerCloudAgent({
        env: this.env,
        threadId: turn.parentThreadId,
        message: {
          id: `wake:${turn.threadId}:${turn.attemptGeneration ?? 1}`.slice(
            0,
            256,
          ),
          kind:
            completion.status === "completed"
              ? "child_completed"
              : completion.status === "canceled"
                ? "child_canceled"
                : "child_failed",
          text: this.agentCompletionText(turn, completion),
          threadId: turn.threadId,
          attemptGeneration: turn.attemptGeneration ?? 1,
          createdAt: completion.threadUpdatedAt,
        },
      });
      if (steered.accepted) return;
    }
    await this.wakeParentConversation(turn, completion);
  }

  /**
   * Wake the conversation that spawned this thread with the agent's report.
   *
   * This is the one delivery a projection cannot do: the parent needs a turn,
   * not a row. It used to be a Convex mutation reached through the thread
   * completion callback, which meant the report's latency was the control
   * plane's and a lost callback lost the wake. The parent's Durable Object is
   * one hop away, so it is called directly with exactly the trusted headers
   * the public turn-start route stamps after it verifies a service caller.
   *
   * `clientMsgId` is derived from the thread and its attempt, and every field
   * the parent fingerprints (prompt, lane, source, hiddenMessage, control
   * receipt) is fixed with the terminal decision — so a redelivery is admitted
   * as a replay rather than refused as a different message under the same id.
   *
   * Desktop-origin threads are delivered by the originating device's own
   * subscription to Convex's projection; waking here as well would put the
   * same report in two orchestrators. The dispatcher always sets
   * `originConversationId` alongside `originDeviceId`.
   */
  private async wakeParentConversation(
    turn: TurnRequest,
    completion: {
      status: "completed" | "failed" | "canceled";
      threadUpdatedAt: number;
      resultJson?: string;
      errorMessage?: string;
    },
  ): Promise<void> {
    const conversationId = turn.conversationId?.trim() ?? "";
    if (turn.kind !== "agent" || !turn.threadId || !conversationId) return;
    if (turn.originDeviceId) {
      log("info", "thread_wake_skipped_desktop_origin", {
        threadId: turn.threadId,
        turnId: turn.turnId,
      });
      return;
    }
    const body: CloudTurnStartRequest = {
      protocol: TURN_PLANE_PROTOCOL,
      clientMsgId: `wake:${turn.threadId}:${turn.attemptGeneration ?? 1}`.slice(
        0,
        64,
      ),
      prompt: this.agentCompletionText(turn, completion),
      lane: "wake",
      source: "agent-thread",
      hiddenMessage: true,
      agentThreadControl: {
        threadId: turn.threadId,
        attemptGeneration: turn.attemptGeneration ?? 1,
        threadUpdatedAt: completion.threadUpdatedAt,
        status: completion.status,
      },
    };
    const response = await this.env.ORCHESTRATOR_SESSIONS.getByName(
      conversationId,
    ).fetch(`${ORCHESTRATOR_INTERNAL_ORIGIN}/turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HEADER_OWNER]: turn.ownerId,
        [HEADER_TURN_AUTH_KIND]: "service",
        [HEADER_CONVERSATION_ID]: conversationId,
        [TURN_OWNER_GENERATION_HEADER]: turn.ownerGeneration,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Agent completion wake was refused (${response.status}).`,
      );
    }
    await response.body?.cancel().catch(() => undefined);
  }

  /** Project a nonterminal human wait without keeping an executor alive. */
  private async deliverBrowserSuspension(
    turn: TurnRequest,
    pending: PendingBrowserSuspension,
  ): Promise<boolean> {
    if (
      pending.turnId !== turn.turnId ||
      pending.attemptGeneration !== turn.attemptGeneration ||
      !isCloudBrowserSuspension(pending.suspension)
    ) {
      return false;
    }
    try {
      await this.event(
        turn,
        "auto",
        "waiting_for_user",
        pending.payload,
        false,
      );
      return true;
    } catch (error) {
      log("error", "browser_suspension_delivery_failed", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        interactionId: pending.suspension.interactionId,
        message: errorMessage(error),
      });
      await this.setExactTurnAlarm(turn, Date.now() + 30_000);
      return false;
    }
  }

  async alarm(): Promise<void> {
    await this.retryDueSandboxDestroyDebts();
    await this.retryOwnerFenceLeaseRetirements();
    await this.retryOutboxDebt();
    try {
      await this.runScheduledTurnAlarm();
    } finally {
      // `setAlarm()` is shared by watchdogs, terminal delivery and container
      // retirement. Whatever the turn path did, outstanding teardown debt
      // must retain the earliest wake-up.
      await this.scheduleDurabilityAlarm();
    }
  }

  private async runScheduledTurnAlarm(): Promise<void> {
    const turn = await this.ctx.storage.get<TurnRequest>("turn");
    if (!turn) return;
    if (turn.kind === "agent" && this.agentTurnExecutions.has(turn.turnId)) {
      const [watchdogDeadlineAt, recoveryPending] = await Promise.all([
        this.ctx.storage.get<number>(AGENT_WATCHDOG_DEADLINE_KEY),
        this.ctx.storage.get<string>(AGENT_RECOVERY_PENDING_KEY),
      ]);
      if (
        recoveryPending !== agentRecoveryIdentity(turn) &&
        typeof watchdogDeadlineAt === "number" &&
        Number.isFinite(watchdogDeadlineAt) &&
        watchdogDeadlineAt > Date.now()
      ) {
        // setAlarm() can race an alarm delivery that Cloudflare has already
        // begun. That stale callback then observes the successor turn and,
        // without this durable deadline fence, mistakes its live executor for
        // an orphan. Re-arm the real watchdog; only its actual deadline may
        // enter crash recovery while the local Effect fiber is still alive.
        await this.setExactTurnAlarm(
          turn,
          Math.min(watchdogDeadlineAt, Date.now() + AGENT_TURN_HEARTBEAT_MS),
        );
        log("info", "agent_watchdog_alarm_rearmed", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          watchdogDeadlineAt,
        });
        return;
      }
      const running = this.agentTurnExecutions.get(turn.turnId);
      if (
        running &&
        typeof watchdogDeadlineAt === "number" &&
        Number.isFinite(watchdogDeadlineAt) &&
        watchdogDeadlineAt <= Date.now()
      ) {
        // The watchdog passed while this isolate still holds the run's fiber,
        // so the loop is hung, or stuck in a settlement it cannot finish.
        // Give it the bounded interrupt a Stop would, then drop the handle:
        // recovery below then treats the attempt the way it treats a replaced
        // isolate, instead of re-interrupting a fiber that never settles on
        // every alarm until the builder fallback gives up.
        log("error", "agent_watchdog_interrupting_hung_execution", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          watchdogDeadlineAt,
        });
        await running
          .interrupt(new Error("The agent ran out of time and was stopped."))
          .catch((error) => {
            log("error", "agent_watchdog_hung_execution_interrupt_failed", {
              turnId: turn.turnId,
              message: errorMessage(error),
            });
          });
        if (this.agentTurnExecutions.get(turn.turnId) === running) {
          this.agentTurnExecutions.delete(turn.turnId);
        }
      }
    }
    const hasTransientBuild = Boolean(
      await this.ctx.storage.get<string>(`transientBuild:${turn.turnId}`),
    );
    const hasPendingPublication = Boolean(
      await this.ctx.storage.get<PendingAppBuildPublication>(
        pendingAppBuildPublicationKey(turn.turnId),
      ),
    );
    if (
      (await this.ctx.storage.get<boolean>("terminalDelivered")) &&
      turn.kind !== "agent" &&
      !hasTransientBuild &&
      !hasPendingPublication
    )
      return;
    const alarmTurn = { ...turn };
    await this.trackTurn(turn.turnId, this.runAlarmWithLease(alarmTurn));
  }

  private async runAlarmWithLease(turn: TurnRequest): Promise<void> {
    const originalLeaseId = turn.ownerPurgeLeaseId;
    const originalGeneration = turn.ownerPurgeGeneration;
    let auxiliaryLeaseId: string | undefined;
    let auxiliaryGeneration: string | undefined;
    let retireOriginalLease = false;
    try {
      const useRunLeaseForRecovery =
        turn.kind === "agent" &&
        (Boolean(
          await this.ctx.storage.get(
            agentComputeKey(turn.turnId, turn.attemptGeneration!),
          ),
        ) ||
          Boolean(
            await this.ctx.storage.get<AgentExecutionMarker>(
              agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!),
            ),
          ) ||
          Boolean(
            await this.ctx.storage.get<BuilderFallbackTranscript>(
              builderFallbackTranscriptKey(
                turn.turnId,
                turn.attemptGeneration!,
              ),
            ),
          ) ||
          Boolean(
            await this.ctx.storage.get<ObservedBrowserSuspension>(
              OBSERVED_BROWSER_SUSPENSION_KEY,
            ),
          ));
      if (useRunLeaseForRecovery) {
        // Turn-state mutation is authorized only by the exact run lease bound
        // to this workspace. Renew/rejoin that lease after isolate loss; an
        // auxiliary lease deliberately cannot checkpoint user bytes.
        turn.ownerPurgeGeneration = await this.registerTurn(turn);
      } else {
        turn.ownerPurgeGeneration = await this.registerTurn(turn, true);
        auxiliaryLeaseId = turn.ownerPurgeLeaseId;
        auxiliaryGeneration = turn.ownerPurgeGeneration;
      }
      await this.assertTurnWritable(turn);
      await this.runAlarm(turn);
      retireOriginalLease = !(await this.ctx.storage.get<TurnRequest>("turn"));
    } catch (error) {
      if (error instanceof OwnerPurgeFenceError) {
        if (!(await this.ownsExactTurn(turn))) return;
        const target = await this.currentSandboxTarget();
        if (await this.ownsExactTurn(turn)) {
          if (target) {
            if (turn.kind === "agent") {
              await this.terminateCurrentAgentSession(turn);
            } else {
              await this.destroySandboxDurably(target, "owner_fence_alarm");
            }
          }
        }
        try {
          // Confirmed sandbox teardown may have produced world-unregister
          // debt. Preserve it (and any destroy tombstone) while deleting the
          // exact turn, otherwise a transient owner-fence failure would erase
          // the only names capable of freeing the slot on the next alarm.
          retireOriginalLease = await this.cleanupOwnerPurgedTurnStorage(turn);
        } catch (cleanupError) {
          log("error", "owner_purge_alarm_cleanup_failed", {
            turnId: turn.turnId,
            message: errorMessage(cleanupError),
          });
        }
        return;
      }
      throw error;
    } finally {
      if (auxiliaryLeaseId && auxiliaryGeneration) {
        // An auxiliary alarm lease never owns transient bytes. Release it
        // directly even when the original run lease must remain as the fence
        // for backup-debt persistence.
        await this.unregisterTurnLease(
          turn,
          auxiliaryLeaseId,
          auxiliaryGeneration,
        );
      }
      if (retireOriginalLease && originalLeaseId && originalGeneration) {
        await this.unregisterTurnLease(
          turn,
          originalLeaseId,
          originalGeneration,
        );
      }
    }
  }

  private async runAlarm(turn: TurnRequest): Promise<void> {
    if (!(await this.ownsExactTurn(turn))) return;
    let appPublication = await this.ctx.storage.get<PendingAppBuildPublication>(
      pendingAppBuildPublicationKey(turn.turnId),
    );
    const transientBuild = await this.ctx.storage.get<string>(
      `transientBuild:${turn.turnId}`,
    );
    if (!appPublication && transientBuild && turn.kind !== "agent") {
      // The watchdog/cancel may land during upload, before the callback replay
      // record exists. Fence further R2/KV writes first, then turn the bare
      // marker into durable cleanup work before any deleteAll can erase it.
      appPublication = {
        turnId: turn.turnId,
        phase: "cleanup",
        artifactPrefix: transientBuild,
        callbackBody: {},
        completionSeq: "auto",
        completionResult: {},
        failureMessage: "The app-build turn ended before publication.",
      };
      if (
        !(await this.mutateExactTurn(turn, async (txn) => {
          await txn.put({
            terminal: true,
            [pendingAppBuildPublicationKey(turn.turnId)]: appPublication!,
          });
        }))
      ) {
        return;
      }
    }
    if (appPublication?.turnId === turn.turnId) {
      const outcome = await this.advanceAppBuildPublication(
        turn,
        appPublication,
      );
      if (outcome !== "retrying" && (await this.ownsExactTurn(turn))) {
        const target = await this.currentSandboxTarget();
        if (await this.ownsExactTurn(turn)) {
          if (target) {
            await this.destroySandboxDurably(
              target,
              "app_publication_alarm",
            ).catch(() => undefined);
          }
        }
        await this.retireTerminalAppTurnStorage(turn);
      }
      return;
    }
    const browserSuspension =
      await this.ctx.storage.get<PendingBrowserSuspension>(
        PENDING_BROWSER_SUSPENSION_KEY,
      );
    if (browserSuspension) {
      if (
        browserSuspension.turnId !== turn.turnId ||
        browserSuspension.attemptGeneration !== turn.attemptGeneration
      ) {
        await this.mutateExactTurn(turn, async (txn) => {
          await txn.delete(PENDING_BROWSER_SUSPENSION_KEY);
        });
        return;
      }
      const target = await this.currentSandboxTarget();
      if (target) {
        await this.terminateCurrentAgentSession(turn).catch(() => undefined);
      }
      if (!(await this.ownsExactTurn(turn))) return;
      if (!(await this.deliverBrowserSuspension(turn, browserSuspension))) {
        return;
      }
      if (!(await this.settleAgentTransientBackup(turn))) {
        await this.setExactTurnAlarm(turn, Date.now() + 30_000);
        return;
      }
      await this.deleteTurnStoragePreservingExactCancellations(turn, true);
      return;
    }
    if (await this.ctx.storage.get<boolean>("terminalDelivered")) {
      const pending =
        await this.ctx.storage.get<PendingTerminal>("pendingTerminal");
      const exactCancellation =
        pending?.kind === "canceled" && pending.turnId === turn.turnId
          ? await this.exactTurnCancellations.matching({
              turnId: turn.turnId,
              ownerId: turn.ownerId,
              ownerGeneration: turn.ownerGeneration,
              attemptGeneration: turn.attemptGeneration,
            })
          : null;
      if (exactCancellation?.state === "pending") {
        if (
          !(await this.acknowledgeExactCancellationFromAlarm(
            turn,
            exactCancellation,
          ))
        ) {
          // Keep the durable terminal payload while another exact-run promise
          // is still joining. No age or state guess can advance the receipt.
          return;
        }
      }
      if (!(await this.settleTerminalTransientWrites(turn))) {
        await this.setExactTurnAlarm(turn, Date.now() + 30_000);
        return;
      }
      await this.deleteTurnStoragePreservingExactCancellations(turn);
      return;
    }
    // A terminal state already decided is not a timeout: the run finished, its
    // workspace is checkpointed, and the only thing left is getting the result
    // to Convex. Redelivering that is the whole point of the alarm here.
    const pending =
      await this.ctx.storage.get<PendingTerminal>("pendingTerminal");
    if (pending) {
      if (pending.turnId !== turn.turnId) {
        await this.mutateExactTurn(turn, async (txn) => {
          await txn.delete("pendingTerminal");
        });
      } else {
        let deliverable = pending;
        if (pending.terminateSandbox) {
          try {
            await this.terminateCurrentAgentSession(turn);
          } catch (error) {
            log("error", "pending_terminal_sandbox_termination_failed", {
              turnId: turn.turnId,
              ...sandboxLifecycleFailureFields(error),
            });
            await this.setExactTurnAlarm(turn, Date.now() + 30_000);
            return;
          }
          deliverable = { ...pending, terminateSandbox: false };
          if (
            !(await this.mutateExactTurn(turn, async (txn) => {
              await txn.put("pendingTerminal", deliverable);
            }))
          ) {
            return;
          }
        }
        const exactCancellation =
          deliverable.kind === "canceled"
            ? await this.exactTurnCancellations.matching({
                turnId: turn.turnId,
                ownerId: turn.ownerId,
                ownerGeneration: turn.ownerGeneration,
                attemptGeneration: turn.attemptGeneration,
              })
            : null;
        if (
          (await this.deliverTerminal(turn, deliverable, {
            preservePendingTerminal: exactCancellation?.state === "pending",
          })) &&
          (await this.ownsExactTurn(turn))
        ) {
          if (
            exactCancellation?.state === "pending" &&
            !(await this.acknowledgeExactCancellationFromAlarm(
              turn,
              exactCancellation,
            ))
          ) {
            return;
          }
          if (await this.settleTerminalTransientWrites(turn)) {
            await this.deleteTurnStoragePreservingExactCancellations(turn);
          } else {
            await this.setExactTurnAlarm(turn, Date.now() + 30_000);
          }
        }
        return;
      }
    }
    if (turn.kind === "agent") {
      const resident = await this.admittedResidentPlacement(turn);
      let marker: AgentExecutionMarker | undefined;
      try {
        marker = await this.exactAgentExecutionMarker(turn);
      } catch (error) {
        log("error", "agent_recovery_marker_invalid", {
          turnId: turn.turnId,
          message: errorMessage(error),
        });
        await this.setExactTurnAlarm(turn, Date.now() + 30_000);
        return;
      }
      if (marker) {
        const lost =
          "The agent stopped unexpectedly. Its workspace changes were saved, but its report could not be recovered.";
        let recoveredCheckpoint: TurnBrokerTurnStateCheckpointReceipt;
        try {
          recoveredCheckpoint = await this.recoverAgentTurnAfterExecutorLoss(
            turn,
            marker,
            lost,
            resident
              ? async () => {
                  const sealed = await this.repairedResidentJournal(turn, lost);
                  return {
                    historyCursor: sealed.historyCursor,
                    messages: sealed.rows.map((row) => ({
                      ordinal: row.ordinal,
                      role: row.role,
                      payloadJson: row.payloadJson,
                    })),
                  };
                }
              : undefined,
          );
        } catch (error) {
          const retries = await this.recordBuilderFallbackRetry(turn);
          log("error", "agent_builder_fallback_alarm_retry", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            retries,
            message: errorMessage(error),
          });
          if (retries < BUILDER_FALLBACK_MAX_RETRIES) {
            await this.setExactTurnAlarm(turn, Date.now() + 30_000);
            return;
          }
          // Every retry boots the lost container again to read its disk. A
          // recovery that keeps failing must end, or the thread stays
          // "running" forever while an alarm restarts a container every
          // thirty seconds for nobody.
          log("error", "agent_builder_fallback_abandoned", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            retries,
          });
          await this.deliverExecutorLossTerminal(turn, {
            message:
              "The agent stopped unexpectedly and its workspace could not be recovered afterwards. Its report was lost.",
            threadError:
              "The agent stopped unexpectedly and its workspace could not be recovered.",
          });
          return;
        }
        let recoveredSuspension: CloudBrowserSuspension | null;
        try {
          recoveredSuspension = await this.recoverObservedBrowserSuspension(
            turn,
            recoveredCheckpoint,
          );
        } catch (error) {
          log("error", "browser_suspension_recovery_retry", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            message: errorMessage(error),
          });
          await this.setExactTurnAlarm(turn, Date.now() + 30_000);
          return;
        }
        if (recoveredSuspension) {
          const pendingBrowserSuspension: PendingBrowserSuspension = {
            schemaVersion: 1,
            turnId: turn.turnId,
            attemptGeneration: turn.attemptGeneration!,
            suspension: recoveredSuspension,
            payload: {
              suspension: recoveredSuspension,
              usage: {},
              coldContainerStartMs: 0,
              restoreMs: 0,
              checkpointMs: 0,
              wallClockMs: Math.max(0, Date.now() - marker.startedAt),
              instanceType: INSTANCE_TIERS[marker.size].instanceType,
            },
            createdAt: Date.now(),
          };
          if (
            !(await this.retainPendingBrowserSuspension(
              turn,
              pendingBrowserSuspension,
            ))
          ) {
            await this.setExactTurnAlarm(turn, Date.now() + 1_000);
            return;
          }
          try {
            await this.terminateCurrentAgentSession(turn);
          } catch (error) {
            log("error", "browser_suspension_sandbox_termination_deferred", {
              turnId: turn.turnId,
              threadId: turn.threadId,
              message: errorMessage(error),
            });
            return;
          }
          if (
            (await this.deliverBrowserSuspension(
              turn,
              pendingBrowserSuspension,
            )) &&
            (await this.ownsExactTurn(turn))
          ) {
            if (await this.settleAgentTransientBackup(turn)) {
              await this.deleteTurnStoragePreservingExactCancellations(
                turn,
                true,
              );
            } else {
              await this.setExactTurnAlarm(turn, Date.now() + 30_000);
            }
          }
          log("info", "browser_suspension_recovered_after_executor_loss", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            interactionId: recoveredSuspension.interactionId,
          });
          return;
        }
        await this.deliverExecutorLossTerminal(turn, {
          message:
            "The agent stopped unexpectedly. Its workspace changes were saved, but its report could not be recovered.",
          threadError:
            "The agent stopped unexpectedly after saving its workspace changes.",
        });
        return;
      }
      const computeRecovery = await this.recoverOrphanedAgentCompute(turn);
      if (computeRecovery === "retry") return;
      if (resident) {
        await this.recoverResidentAgentTurn(turn);
        return;
      }
    }

    const sandboxId = await this.ctx.storage.get<string>("sandboxId");
    let timeoutPending: PendingTerminal = {
      turnId: turn.turnId,
      attemptGeneration: turn.kind === "agent" ? turn.attemptGeneration! : 1,
      kind: "failed",
      payload: {
        message:
          "This took longer than expected, so Stella stopped. Try again.",
        reason: "timeout",
      },
      threadError: "The agent ran out of time and was stopped.",
      terminateSandbox: true,
    };
    if (!(await this.claimTerminalDecision(turn, timeoutPending))) {
      // A normal completion or cancellation claimed the same instant. Let its
      // durable payload, rather than this timeout fallback, own the next alarm.
      await this.setExactTurnAlarm(turn, Date.now() + 1_000);
      return;
    }
    try {
      await this.terminateCurrentAgentSession(turn);
    } catch (error) {
      if (!(error instanceof SandboxLifecycleDeferredError)) {
        log("error", "timeout_sandbox_termination_failed", {
          turnId: turn.turnId,
          sandboxId,
          ...sandboxLifecycleFailureFields(error),
        });
        await this.setExactTurnAlarm(turn, Date.now() + 30_000);
        return;
      }
      log("error", "timeout_sandbox_termination_deferred", {
        turnId: turn.turnId,
        sandboxId,
        ...sandboxLifecycleFailureFields(error),
      });
    }
    timeoutPending = { ...timeoutPending, terminateSandbox: false };
    if (
      !(await this.mutateExactTurn(turn, async (txn) => {
        await txn.put("pendingTerminal", timeoutPending);
      }))
    ) {
      return;
    }
    log("error", "turn_timed_out", {
      turnId: turn.turnId,
      appId: turn.appId,
      sandboxId,
    });
    const delivered = await this.deliverTerminal(turn, timeoutPending);
    if (delivered && (await this.ownsExactTurn(turn))) {
      if (await this.settleTerminalTransientWrites(turn)) {
        await this.deleteTurnStoragePreservingExactCancellations(turn);
      } else {
        await this.setExactTurnAlarm(turn, Date.now() + 30_000);
      }
    }
  }

  private async acknowledgeExactAgentTurnCancellation(
    request: ExactTurnCancellationRequest,
  ): Promise<boolean> {
    return await this.ctx.blockConcurrencyWhile(
      async () => await this.exactTurnCancellations.acknowledge(request),
    );
  }

  /**
   * An alarm is itself tracked under the turn id. More than one tracked
   * promise therefore proves the original run (or another exact lifecycle
   * task) has not joined yet. A replacement isolate has no such promise and
   * may durably acknowledge the already-stopped cancellation after delivery.
   */
  private async acknowledgeExactCancellationFromAlarm(
    turn: TurnRequest,
    cancellation: ExactTurnCancellation,
  ): Promise<boolean> {
    if (cancellation.state === "acknowledged") return true;
    const active = this.runningTurns.get(cancellation.turnId)?.size ?? 0;
    if (active > 1) {
      await this.setExactTurnAlarm(turn, Date.now() + 30_000);
      return false;
    }
    if (await this.acknowledgeExactAgentTurnCancellation(cancellation)) {
      return true;
    }
    await this.setExactTurnAlarm(turn, Date.now() + 30_000);
    return false;
  }

  /**
   * Operator-only: expire the current agent turn now instead of at its
   * watchdog. Nothing here delivers a terminal directly. The watchdog deadline
   * is moved to now, a hung local fiber gets the bounded interrupt a Stop
   * would, and the alarm is re-armed so
   * the ordinary timeout path (which tolerates a container that will not die)
   * fails the thread. The optional body names the exact turn the operator
   * looked at, so a stale request cannot expire a successor.
   */
  private async expireCurrentAgentTurn(request: Request): Promise<Response> {
    const raw = (await request.json().catch(() => null)) as unknown;
    const body =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const turn = await this.ctx.storage.get<TurnRequest>("turn");
    if (
      !turn ||
      turn.kind !== "agent" ||
      !Number.isSafeInteger(turn.attemptGeneration) ||
      turn.attemptGeneration! < 1
    ) {
      return json({ expired: false, reason: "no_agent_turn" }, 404);
    }
    if (
      (body.turnId !== undefined && body.turnId !== turn.turnId) ||
      (body.attemptGeneration !== undefined &&
        body.attemptGeneration !== turn.attemptGeneration)
    ) {
      return json(
        {
          expired: false,
          reason: "stale_turn",
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration,
        },
        409,
      );
    }
    if (await this.ctx.storage.get<boolean>("terminalDelivered")) {
      return json(
        {
          expired: false,
          reason: "already_terminal",
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration,
        },
        409,
      );
    }
    const now = Date.now();
    await this.ctx.storage.put(AGENT_WATCHDOG_DEADLINE_KEY, now);
    const running = this.agentTurnExecutions.get(turn.turnId);
    if (running) {
      await running
        .interrupt(new Error("The agent turn was expired by an operator."))
        .catch((error) => {
          log("error", "agent_turn_expire_interrupt_failed", {
            turnId: turn.turnId,
            message: errorMessage(error),
          });
        });
      if (this.agentTurnExecutions.get(turn.turnId) === running) {
        this.agentTurnExecutions.delete(turn.turnId);
      }
    }
    await this.setExactTurnAlarm(turn, now);
    log("info", "agent_turn_expired_by_operator", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      attemptGeneration: turn.attemptGeneration,
      interruptedLocalExecution: Boolean(running),
    });
    return json({
      expired: true,
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration,
      interruptedLocalExecution: Boolean(running),
    });
  }

  /**
   * Placement and manual-pause cancellation share this exact boundary. A
   * request that has not reached the DO gets a durable pre-admission
   * tombstone; a current turn is acknowledged only after its sandbox is gone
   * and every in-isolate promise for that exact turn has joined.
   */
  private async cancelExactAgentTurn(
    request: ExactTurnCancellationRequest,
    reason: string,
  ): Promise<Response> {
    type Admission =
      | { response: Response }
      | {
          cancellation: ExactTurnCancellation;
          turn: TurnRequest;
          pending?: PendingTerminal;
        };
    const admission = await this.ctx.blockConcurrencyWhile(
      async (): Promise<Admission> => {
        const stored = await this.ctx.storage.get<TurnRequest>("turn");
        const exact = stored?.turnId === request.turnId ? stored : undefined;
        if (
          exact &&
          (exact.ownerId !== request.ownerId ||
            exact.ownerGeneration !== request.ownerGeneration ||
            exact.attemptGeneration !== request.attemptGeneration)
        ) {
          return {
            response: json(
              {
                canceled: false,
                reason: "stale_owner_generation",
                turnId: request.turnId,
              },
              409,
            ),
          };
        }
        const existing = await this.exactTurnCancellations.matching({
          turnId: request.turnId,
          ownerId: request.ownerId,
          ownerGeneration: request.ownerGeneration,
          attemptGeneration: request.attemptGeneration,
        });
        if (existing && existing.cancelRequestId !== request.cancelRequestId) {
          return {
            response: json(
              {
                canceled: false,
                reason: "cancellation_identity_conflict",
                turnId: request.turnId,
              },
              409,
            ),
          };
        }
        if (existing?.state === "acknowledged") {
          return {
            response: json({
              canceled: true,
              turnId: request.turnId,
              replayed: true,
            }),
          };
        }
        let pending: PendingTerminal | undefined;
        if (exact && (await this.ctx.storage.get<boolean>("terminal"))) {
          pending =
            await this.ctx.storage.get<PendingTerminal>("pendingTerminal");
          if (
            !pending ||
            pending.turnId !== request.turnId ||
            pending.kind !== "canceled"
          ) {
            // The outcome is immutable, but its callback may only be waiting
            // on a distant watchdog after an isolate/process failure. A Pause
            // cannot replace that decision; it can safely wake its idempotent
            // delivery so the thread converges instead of appearing live.
            await this.ctx.storage.setAlarm(Date.now());
            return {
              response: json(
                {
                  canceled: false,
                  reason: "terminal_already_decided",
                  turnId: request.turnId,
                },
                409,
              ),
            };
          }
        }
        const staged = await this.exactTurnCancellations.stage(request);
        if (staged.status === "conflict") {
          return {
            response: json(
              {
                canceled: false,
                reason: "cancellation_identity_conflict",
                turnId: request.turnId,
              },
              409,
            ),
          };
        }
        if (staged.status === "saturated") {
          return {
            response: json(
              {
                canceled: false,
                reason: "cancellation_ledger_saturated",
                turnId: request.turnId,
              },
              503,
            ),
          };
        }
        if (!("cancellation" in staged)) {
          return {
            response: json(
              { canceled: false, reason: "cancellation_not_staged" },
              503,
            ),
          };
        }
        if (staged.cancellation.state === "acknowledged") {
          return {
            response: json({
              canceled: true,
              turnId: request.turnId,
              replayed: true,
            }),
          };
        }
        if (!exact) {
          return {
            response: json(
              {
                canceled: true,
                turnId: request.turnId,
                pending: true,
                durable: true,
              },
              202,
            ),
          };
        }
        return { cancellation: staged.cancellation, turn: exact, pending };
      },
    );
    if ("response" in admission) return admission.response;

    const turn = { ...admission.turn };
    let pending = admission.pending ?? {
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      kind: "canceled" as const,
      payload: { message: "Stopped. Nothing was changed." },
      threadError:
        reason === "Paused by orchestrator."
          ? reason
          : "The agent was stopped.",
      terminateSandbox: true,
    };
    if (!admission.pending) {
      if (!(await this.claimTerminalDecision(turn, pending))) {
        const decided =
          await this.ctx.storage.get<PendingTerminal>("pendingTerminal");
        if (
          !decided ||
          decided.turnId !== turn.turnId ||
          decided.kind !== "canceled"
        ) {
          return json(
            {
              canceled: false,
              reason: "stale_turn",
              turnId: request.turnId,
            },
            409,
          );
        }
        pending = decided;
      }
    }

    const agentExecution = this.agentTurnExecutions.get(turn.turnId);
    try {
      // Interrupt first: this closes the exact turn's local admission latch
      // before sandbox teardown starts, so setup cannot recreate a session
      // after Stop destroyed the pre-existing/current container.
      if (agentExecution) {
        await agentExecution.interrupt(
          new Error(
            reason === "Paused by orchestrator."
              ? reason
              : "The agent turn was stopped.",
          ),
        );
      }
      if (pending.terminateSandbox) {
        // A restarted isolate has no live Effect fiber/finalizer, but may still
        // own the durable sandbox id. Teardown remains mandatory in that case.
        if (!agentExecution) {
          await this.terminateCurrentAgentSession(turn);
        }
        pending = { ...pending, terminateSandbox: false };
        if (
          !(await this.mutateExactTurn(turn, async (txn) => {
            await txn.put("pendingTerminal", pending);
          }))
        ) {
          return json(
            { canceled: false, reason: "stale_turn", turnId: turn.turnId },
            409,
          );
        }
      }
    } catch (error) {
      log("error", "cancel_sandbox_termination_failed", {
        turnId: turn.turnId,
        ...sandboxLifecycleFailureFields(error),
      });
      await this.setExactTurnAlarm(turn, Date.now() + 30_000);
      return json(
        {
          canceled: false,
          reason: "sandbox_termination_failed",
          turnId: turn.turnId,
        },
        502,
      );
    }

    let auxiliaryLeaseId: string | undefined;
    let auxiliaryGeneration: string | undefined;
    let terminalDelivered = false;
    try {
      turn.ownerPurgeGeneration = await this.registerTurn(turn, true);
      auxiliaryLeaseId = turn.ownerPurgeLeaseId;
      auxiliaryGeneration = turn.ownerPurgeGeneration;
      await this.assertTurnWritable(turn);
      log("info", "turn_canceled", {
        turnId: turn.turnId,
        appId: turn.appId,
      });
      terminalDelivered = await this.deliverTerminal(turn, pending, {
        preservePendingTerminal: true,
      });
    } catch (error) {
      if (!(error instanceof OwnerPurgeFenceError)) throw error;
    } finally {
      if (auxiliaryLeaseId && auxiliaryGeneration) {
        await this.unregisterTurnLease(
          turn,
          auxiliaryLeaseId,
          auxiliaryGeneration,
        );
      }
    }

    if (agentExecution) await agentExecution.join();
    if (!(await this.acknowledgeExactAgentTurnCancellation(request))) {
      return json(
        {
          canceled: false,
          reason: "cancellation_acknowledgement_lost",
          turnId: turn.turnId,
        },
        503,
      );
    }
    if (terminalDelivered) {
      const cleanupTurn = await this.ctx.storage.get<TurnRequest>("turn");
      if (cleanupTurn && exactTurnIdentityMatches(cleanupTurn, turn)) {
        try {
          // The joined executor can no longer produce a checkpoint. Reuse the
          // normal terminal-alarm retirement path immediately so its durable
          // execution marker does not survive until the old watchdog.
          await this.runAlarmWithLease({ ...cleanupTurn });
        } catch (error) {
          log("error", "cancel_terminal_cleanup_deferred", {
            turnId: turn.turnId,
            message: errorMessage(error),
          });
          await this.setExactTurnAlarm(cleanupTurn, Date.now() + 30_000);
        }
      }
    }
    return json({
      canceled: true,
      turnId: turn.turnId,
      joined: true,
    });
  }

  /** @see src/build-session/turn-broker.ts */
  private executeTurnStateCheckpoint(args: {
    turn: TurnRequest;
    operationKey: string;
    operation: Extract<TurnStateCheckpointOperation, { state: "pending" }> & {
      payload: TurnBrokerTurnStateCheckpointRequest;
    };
  }): Promise<TurnBrokerTurnStateCheckpointReceipt> {
    return executeTurnStateCheckpoint(this.self, args);
  }

  /** @see src/build-session/turn-broker.ts */
  private handleTurnBroker(request: Request): Promise<Response> {
    return handleTurnBroker(this.self, request);
  }

  private async handleSteer(request: Request): Promise<Response> {
    const message = parseSteerMessage(await request.json().catch(() => null));
    if (!message) return json({ error: "Invalid steer message." }, 400);
    return await this.ctx.blockConcurrencyWhile(async () => {
      const [turn, terminal] = await Promise.all([
        this.ctx.storage.get<TurnRequest>("turn"),
        this.ctx.storage.get<boolean>("terminal"),
      ]);
      if (
        !turn ||
        turn.kind !== "agent" ||
        !turn.threadId ||
        terminal !== false ||
        !Number.isSafeInteger(turn.attemptGeneration)
      ) {
        return json({ accepted: false, reason: "not_running" }, 409);
      }
      const mailbox = SteerMailbox.open(this.ctx.storage.sql);
      const result = mailbox.append(
        {
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration!,
        },
        message,
      );
      if (result === "conflict") {
        return json({ accepted: false, reason: "idempotency_conflict" }, 409);
      }
      if (result === "full") {
        return json({ accepted: false, reason: "mailbox_full" }, 503);
      }
      if (message.kind !== "input") {
        await rememberCloudAgentControlReceipt(this.ctx.storage, {
          threadId: message.threadId,
          attemptGeneration: message.attemptGeneration,
          threadUpdatedAt: message.createdAt,
          status:
            message.kind === "child_completed"
              ? "completed"
              : message.kind === "child_canceled"
                ? "canceled"
                : "failed",
        });
      }
      return json({
        accepted: true,
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration,
      });
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/turn-broker") {
      return await this.handleTurnBroker(request);
    }
    if (
      url.pathname === "/vite-preview" ||
      url.pathname.startsWith("/vite-preview/")
    ) {
      return await this.proxyVitePreview(request);
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405);
    }
    if (url.pathname === "/owner-purge-cancel") {
      return this.cancelForOwnerPurge(request);
    }
    if (url.pathname === "/expire-agent-turn") {
      return await this.expireCurrentAgentTurn(request);
    }
    if (url.pathname === "/steer") return await this.handleSteer(request);
    if (url.pathname === "/cancel") {
      const raw = await request.json().catch(() => null);
      const cancellation = parseExactTurnCancellationRequest(raw);
      if (!cancellation || cancellation.attemptGeneration === undefined) {
        return json(
          { canceled: false, reason: "exact_turn_identity_required" },
          400,
        );
      }
      const reason =
        raw &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        (raw as Record<string, unknown>).reason === "Paused by orchestrator."
          ? "Paused by orchestrator."
          : "The agent was stopped.";
      return await this.cancelExactAgentTurn(cancellation, reason);
    }
    if (url.pathname === "/echo") return this.runEcho();
    if (url.pathname !== "/turn") return json({ error: "Not found." }, 404);
    const raw = (await request.json().catch(() => null)) as unknown;
    // An agent attempt arrives in the turn-plane contract shape and is
    // validated by the same parser the public `/sessions/:id/turns` route
    // uses, so the orchestrator's direct dispatch and Convex's service call
    // are admitted by one rule rather than two. The app-build lane keeps its
    // own dispatch payload.
    let agentStart: CloudAgentTurnStartRequest | undefined;
    if (
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      (raw as { kind?: unknown }).kind === "agent"
    ) {
      const parsed = parseCloudAgentTurnStartRequest(raw);
      if (!parsed.ok) return json({ error: parsed.message }, 400);
      agentStart = parsed.request;
    }
    const turn = (
      agentStart
        ? {
            kind: "agent",
            ownerId: agentStart.ownerId,
            ownerGeneration: agentStart.ownerGeneration,
            appId: "agent",
            conversationId: agentStart.conversationId,
            threadId: agentStart.threadId,
            agentDepth: agentStart.agentDepth,
            turnId: agentStart.turnId ?? crypto.randomUUID(),
            attemptGeneration: agentStart.attemptGeneration,
            prompt: agentStart.prompt,
            description: agentStart.description,
            execution: agentStart.execution,
            audience: agentStart.audience as ManagedModelAudience,
            budgetMicroCents: agentStart.budgetMicroCents,
            source: agentStart.source,
            ...(agentStart.clientMsgId
              ? { clientMsgId: agentStart.clientMsgId }
              : {}),
            ...(agentStart.parentTurnId
              ? { parentTurnId: agentStart.parentTurnId }
              : {}),
            ...(agentStart.parentThreadId
              ? { parentThreadId: agentStart.parentThreadId }
              : {}),
            ...(agentStart.originDeviceId
              ? { originDeviceId: agentStart.originDeviceId }
              : {}),
            ...(agentStart.originConversationId
              ? { originConversationId: agentStart.originConversationId }
              : {}),
            ...(agentStart.browserResume !== undefined
              ? { browserResume: agentStart.browserResume }
              : {}),
          }
        : ((raw ?? {}) as TurnRequest)
    ) as TurnRequest;
    // These fields come only from the authenticated outer gateway. Delete any
    // body-shaped values first so a service caller cannot choose where the
    // sandbox sends its capability or which BuildSession identity it claims.
    delete turn.turnBrokerRoute;
    delete turn.previewRoute;
    delete turn.gateAdmittedByCaller;
    // Set by the OrchestratorSession, which admitted the owner gate itself
    // before dispatching and releases it if this call fails. Trusted because
    // only a Durable Object stub can reach `/turn`; the public route builds
    // its forwarded headers from scratch and never copies it.
    if (request.headers.get(HEADER_GATE_ADMITTED)?.trim() === "1") {
      turn.gateAdmittedByCaller = true;
    }
    const brokerSessionId =
      request.headers.get(HEADER_BUILD_SESSION_NAME)?.trim() ?? "";
    const brokerEndpoint =
      request.headers.get(HEADER_TURN_BROKER_ENDPOINT)?.trim() ?? "";
    const previewBaseUrl =
      request.headers.get(HEADER_PREVIEW_BASE_URL)?.trim() ?? "";
    if (turn?.kind === "agent" && (brokerSessionId || brokerEndpoint)) {
      try {
        const endpoint = new URL(brokerEndpoint);
        const localHttp =
          endpoint.protocol === "http:" &&
          (endpoint.hostname === "127.0.0.1" ||
            endpoint.hostname === "localhost");
        if (
          !brokerSessionId ||
          brokerSessionId.length > 512 ||
          (endpoint.protocol !== "https:" && !localHttp) ||
          endpoint.username ||
          endpoint.password ||
          endpoint.search ||
          endpoint.hash ||
          endpoint.pathname !==
            `/sessions/${encodeURIComponent(brokerSessionId)}/turn-broker`
        ) {
          throw new Error("invalid broker route");
        }
        turn.turnBrokerRoute = {
          sessionId: brokerSessionId,
          endpoint: endpoint.toString(),
        };
      } catch {
        return json({ error: "Trusted turn broker route is required." }, 400);
      }
    }
    if (turn?.kind !== "agent" && (brokerSessionId || previewBaseUrl)) {
      try {
        const base = new URL(previewBaseUrl);
        const localHttp =
          base.protocol === "http:" &&
          (base.hostname === "127.0.0.1" || base.hostname === "localhost");
        if (
          !brokerSessionId ||
          (base.protocol !== "https:" && !localHttp) ||
          base.username ||
          base.password ||
          base.search ||
          base.hash ||
          base.pathname !==
            `/internal/previews/${encodeURIComponent(brokerSessionId)}/`
        ) {
          throw new Error("invalid preview route");
        }
        turn.previewRoute = {
          buildSessionName: brokerSessionId,
          baseUrl: base.toString(),
        };
      } catch {
        return json({ error: "Trusted preview route is required." }, 400);
      }
    }
    const dispatchOwnerGeneration = normalizeOwnerGeneration(
      turn?.ownerGeneration,
    );
    if (
      !turn ||
      typeof turn.ownerId !== "string" ||
      !turn.ownerId.trim() ||
      typeof turn.turnId !== "string" ||
      !turn.turnId.trim() ||
      !dispatchOwnerGeneration
    ) {
      return json(
        { error: "ownerId, turnId, and ownerGeneration are required." },
        400,
      );
    }
    turn.ownerId = turn.ownerId.trim();
    turn.turnId = turn.turnId.trim();
    turn.ownerGeneration = dispatchOwnerGeneration;
    // The turn capability is minted from these; an unknown audience or a
    // non-finite budget can never reach the model gateway.
    if (
      !isManagedModelAudience(turn.audience) ||
      typeof turn.budgetMicroCents !== "number" ||
      !Number.isFinite(turn.budgetMicroCents)
    ) {
      return json(
        { error: "audience and budgetMicroCents are required." },
        400,
      );
    }
    if (
      turn.kind === "agent" &&
      turn.browserResume !== undefined &&
      !isCloudBrowserResumeReceipt(turn.browserResume)
    ) {
      return json({ error: "Browser resume receipt is invalid." }, 400);
    }
    if (
      turn.kind !== "agent" &&
      (typeof turn.appId !== "string" ||
        !turn.appId.trim() ||
        typeof turn.conversationId !== "string" ||
        !turn.conversationId.trim() ||
        typeof turn.sessionId !== "string" ||
        !turn.sessionId.trim())
    ) {
      return json(
        { error: "App turns require appId, conversationId, and sessionId." },
        400,
      );
    }
    if (turn.kind === "agent") {
      turn.threadId = turn.threadId!.trim();
    } else {
      turn.appId = turn.appId.trim();
      turn.conversationId = turn.conversationId!.trim();
      turn.sessionId = turn.sessionId!.trim();
    }
    const storedTurn = await this.ctx.storage.get<TurnRequest>("turn");
    if (storedTurn?.turnId === turn.turnId) {
      const [storedFingerprint, replayFingerprint] = await Promise.all([
        stableValueMarker(turnDispatchIdentity(storedTurn)),
        stableValueMarker(turnDispatchIdentity(turn)),
      ]);
      if (storedFingerprint !== replayFingerprint) {
        if (turn.kind === "agent") await this.releaseOwnerGate(turn);
        return json(
          {
            error: "Turn dispatch was replayed with different input.",
            turnId: turn.turnId,
          },
          409,
        );
      }
      try {
        // Reuse the one durable lease captured by the first admission. A lost
        // response must never register and then leak a second owner-purge
        // lease or overwrite the execution's stored lease identity.
        await this.assertTurnWritable(storedTurn);
        if (turn.kind === "agent") {
          this.assertAgentTurnIdentity(turn);
          if (this.agentTurnExecutions.has(turn.turnId)) {
            return this.agentTurnAccepted(turn, true, { inProgress: true });
          }
          const [executionMarker, fallbackJournal] = await Promise.all([
            this.exactAgentExecutionMarker(storedTurn),
            this.ctx.storage.get<BuilderFallbackTranscript>(
              builderFallbackTranscriptKey(
                storedTurn.turnId,
                storedTurn.attemptGeneration!,
              ),
            ),
          ]);
          if (executionMarker || fallbackJournal) {
            // The prior isolate admitted model-controlled work. Its sandbox
            // and durable checkpoint/publication journal are the authority;
            // never replace them with a failed terminal on a lost /turn ACK.
            await this.setExactTurnAlarm(storedTurn, Date.now());
            return json(
              { accepted: false, replayed: true, recoveryPending: true },
              425,
            );
          }
          const pending: PendingTerminal = {
            turnId: turn.turnId,
            attemptGeneration: turn.attemptGeneration!,
            kind: "failed",
            payload: {
              message:
                "The cloud worker restarted before this agent could finish. Try again.",
            },
            threadError:
              "The cloud worker restarted before this agent could finish.",
            terminateSandbox: true,
          };
          if (!(await this.claimTerminalDecision(storedTurn, pending))) {
            await this.releaseOwnerGate(turn);
            return json(
              { accepted: false, replayed: true, reason: "superseded" },
              409,
            );
          }
          await this.setExactTurnAlarm(storedTurn, Date.now());
          // 425 deliberately keeps the dispatcher's exact retry alive until
          // the alarm has terminated the orphan and delivered terminal.
          return json(
            { accepted: false, replayed: true, recoveryPending: true },
            425,
          );
        }
        this.assertAppTurnIdentity(storedTurn);
        const running = this.appTurnExecutions.get(turn.turnId);
        if (running) {
          return json(
            { accepted: true, replayed: true, inProgress: true },
            202,
          );
        }
        const pending: PendingTerminal = {
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration ?? 1,
          kind: "failed",
          payload: {
            message:
              "The cloud worker restarted before this change could finish. Try again.",
          },
          terminateSandbox: true,
        };
        if (!(await this.claimTerminalDecision(storedTurn, pending))) {
          return json(
            { accepted: false, replayed: true, reason: "superseded" },
            409,
          );
        }
        await this.setExactTurnAlarm(storedTurn, Date.now());
        return json(
          { accepted: false, replayed: true, recoveryPending: true },
          425,
        );
      } catch (error) {
        if (error instanceof OwnerPurgeFenceError) {
          return json({ error: "Owner cloud activity is being purged." }, 409);
        }
        if (error instanceof AgentTurnAuthorityLostError) {
          return json(
            { error: "Cloud agent attempt is no longer active." },
            409,
          );
        }
        if (error instanceof AppTurnAuthorityLostError) {
          return json({ error: "Cloud app attempt is no longer active." }, 409);
        }
        throw error;
      }
    }
    let admitted = false;
    if (turn.kind === "agent") {
      const gate = await this.admitAgentTurnThroughOwnerGate(turn);
      if (!gate.ok) return gate.response;
      admitted = true;
    }
    try {
      delete turn.ownerPurgeGeneration;
      delete turn.ownerPurgeLeaseId;
      turn.ownerPurgeGeneration = await this.registerTurn(turn);
      await this.assertTurnWritable(turn);
      if (turn.kind === "agent") {
        this.assertAgentTurnIdentity(turn);
        return await this.acceptAgentTurn(turn);
      }
      this.assertAppTurnIdentity(turn);
      return await this.startAppTurn(turn);
    } catch (error) {
      await this.unregisterTurn(turn);
      if (admitted) await this.releaseOwnerGate(turn);
      if (error instanceof OwnerPurgeFenceError) {
        return json({ error: "Owner cloud activity is being purged." }, 409);
      }
      if (error instanceof AgentTurnAuthorityLostError) {
        return json({ error: "Cloud agent attempt is no longer active." }, 409);
      }
      if (error instanceof AppTurnAuthorityLostError) {
        return json({ error: "Cloud app attempt is no longer active." }, 409);
      }
      throw error;
    }
  }

  // Accept the dispatch immediately and run the turn in the background: a
  // sandbox turn takes minutes, and holding the POST open that long means a
  // mid-turn transport failure makes Convex mark a still-running turn (and
  // its thread) failed while the agent goes on to finish. Outcomes reach
  // Convex only through events/threads-complete callbacks.
  /**
   * The placement this turn is admitted under, decided once and stored beside
   * it. A turn dispatched without an engine selection has nothing to place, so
   * it records nothing and keeps the container path it has always had.
   */
  private admittedComputePlan(turn: TurnRequest): TurnComputePlan | undefined {
    if (!turn.execution || !Number.isSafeInteger(turn.attemptGeneration)) {
      return undefined;
    }
    return turnComputePlan({
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      execution: turn.execution,
      browserResume: turn.browserResume !== undefined,
      // D1: resident is the default for Stella. An operator turns the ladder
      // off by setting this to "0", which demotes every Stella turn to the
      // eager container path without touching the loop.
      residentDisabled: this.env.RESIDENT_GENERAL_AGENT_TURNS === "0",
      now: Date.now(),
    });
  }

  /**
   * Owner-gate admission for one agent attempt, and the authority the
   * attempt runs under.
   *
   * Two callers reach `/turn`. The OrchestratorSession admitted the gate
   * itself before dispatching (it owns the release if the dispatch fails) and
   * says so on a trusted internal header; it only needs the snapshot. The
   * public `/sessions/:id/turns` route — Convex's desktop dispatch, execution
   * placement's agent branch, a hosted-browser resume — did not, so admission
   * happens here.
   *
   * Either way the snapshot, not the request, decides what the turn may
   * spend: `audience` and `budgetMicroCents` in the body are the dispatcher's
   * hints, and a dispatcher that lagged a plan change must not be able to
   * mint a capability richer than the owner's current allowance.
   */
  private async admitAgentTurnThroughOwnerGate(
    turn: TurnRequest,
  ): Promise<
    { ok: true; snapshot: OwnerSnapshot } | { ok: false; response: Response }
  > {
    const gate = this.ownerGateFor(turn.ownerId);
    let snapshot: OwnerSnapshot;
    if (turn.gateAdmittedByCaller) {
      try {
        snapshot = await gate.snapshot();
      } catch (error) {
        log("error", "agent_turn_snapshot_unavailable", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          message: errorMessage(error),
        });
        return {
          ok: false,
          response: json(
            {
              error:
                "Stella can't check your plan right now. Try again shortly.",
            },
            503,
          ),
        };
      }
      if (snapshot.ownerGeneration !== turn.ownerGeneration) {
        return {
          ok: false,
          response: json(
            { error: "This cloud owner generation is no longer current." },
            409,
          ),
        };
      }
      if (snapshot.enforcement?.status === "suspended") {
        return {
          ok: false,
          response: Response.json(
            {
              error: "This account can't use Stella's cloud right now.",
              code: "owner_suspended",
              retryable: false,
            },
            { status: 403, headers: { "cache-control": "no-store" } },
          ),
        };
      }
      if (!snapshot.writable) {
        return {
          ok: false,
          response: json(
            { error: "This account's cloud data is no longer available." },
            410,
          ),
        };
      }
      if (snapshot.isAnonymous) {
        return {
          ok: false,
          response: Response.json(
            {
              error: "Sign in to Stella to use cloud agents.",
              code: "sign_in_required",
              retryable: false,
            },
            { status: 403, headers: { "cache-control": "no-store" } },
          ),
        };
      }
    } else {
      const admission = await gate.admit({
        lane: "agent",
        turnId: turn.turnId,
        conversationId: turn.conversationId ?? "",
        expectedGeneration: turn.ownerGeneration,
      });
      if (!admission.ok) {
        return {
          ok: false,
          response: Response.json(
            {
              error: admission.message,
              code: admission.code,
              retryable: admission.retryable,
              ...(admission.retryAfterMs !== undefined
                ? { retryAfterMs: admission.retryAfterMs }
                : {}),
            },
            {
              status: OWNER_GATE_REFUSAL_STATUS[admission.code],
              headers: { "cache-control": "no-store" },
            },
          ),
        };
      }
      snapshot = admission.snapshot;
    }
    if (
      turn.execution &&
      !snapshotAllowsExecutionEngine(snapshot, turn.execution.engine)
    ) {
      if (!turn.gateAdmittedByCaller) await this.releaseOwnerGate(turn);
      return {
        ok: false,
        response: json(
          {
            error:
              turn.execution.engine === "anthropic"
                ? "Connect Claude before using that cloud execution route."
                : "Connect ChatGPT before using that cloud execution route.",
          },
          409,
        ),
      };
    }
    // The snapshot is the authority for both, overriding the dispatcher.
    turn.audience = snapshot.allowance.audience;
    turn.budgetMicroCents = snapshot.allowance.budgetMicroCents;
    try {
      // Both capabilities for this attempt, from the same admitted facts. The
      // control-plane half is cached here because it never leaves the object;
      // the model half is re-minted when the attempt actually starts, so its
      // 30-minute lifetime covers the run rather than the wait before it.
      const minted = await mintTurnCapabilities(this.env, {
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        turnId: turn.turnId,
        conversationId: turn.conversationId ?? "",
        execution: turn.execution!,
        audience: turn.audience,
        budgetMicroCents: turn.budgetMicroCents,
        agentTypes: ["general"],
      });
      this.controlPlaneCapabilities.set(
        `${turn.turnId}:${turn.attemptGeneration ?? 1}`,
        {
          token: minted.controlPlane.token,
          expiresAt: minted.controlPlane.expiresAt,
        },
      );
    } catch (error) {
      if (!turn.gateAdmittedByCaller) await this.releaseOwnerGate(turn);
      log("error", "agent_turn_capability_mint_failed", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message: errorMessage(error),
      });
      return {
        ok: false,
        response: json(
          { error: "Stella can't authorize this agent right now. Try again." },
          503,
        ),
      };
    }
    return { ok: true, snapshot };
  }

  /** The 202 body every accepted agent attempt answers with. */
  private agentTurnAccepted(
    turn: TurnRequest,
    replayed: boolean,
    extra: Record<string, unknown> = {},
  ): Response {
    const body: CloudAgentTurnStartResponse = {
      protocol: TURN_PLANE_PROTOCOL,
      threadId: turn.threadId ?? "",
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration ?? 1,
      accepted: true,
      replayed,
    };
    return json({ ...body, ...extra }, 202);
  }

  /**
   * What Convex learns when an agent attempt is admitted. `thread.spawned`
   * projects the thread row for a first attempt — but only when this object
   * admitted the spawn: the orchestrator emits its own for the spawns it
   * dispatches, and two would race for the same key.
   */
  private async projectAgentTurnStart(turn: TurnRequest): Promise<void> {
    const attemptGeneration = turn.attemptGeneration ?? 1;
    const createdAt = Date.now();
    const source = CLOUD_TURN_SOURCES.includes(turn.source as CloudTurnSource)
      ? (turn.source as CloudTurnSource)
      : undefined;
    const events: OutboxEvent[] = [
      {
        ...this.outboxBase(turn, turn.turnId),
        kind: "turn.started",
        turnId: turn.turnId,
        turnKind: "agent",
        conversationId: turn.conversationId ?? "",
        sessionId: turn.threadId ?? "",
        lane: "agent",
        ...(source ? { source } : {}),
        ...(turn.clientMsgId ? { clientMsgId: turn.clientMsgId } : {}),
        threadId: turn.threadId ?? "",
        attemptGeneration,
        agentType: "general",
        execution: turn.execution!,
        prompt: turn.prompt,
        createdAt,
      } satisfies TurnStartedEvent,
    ];
    if (attemptGeneration === 1 && !turn.gateAdmittedByCaller) {
      events.push({
        ...this.outboxBase(turn, `${turn.threadId}:${attemptGeneration}`),
        kind: "thread.spawned",
        threadId: turn.threadId ?? "",
        conversationId: turn.conversationId ?? "",
        parentTurnId: turn.parentTurnId ?? turn.turnId,
        ...(turn.parentThreadId ? { parentThreadId: turn.parentThreadId } : {}),
        agentDepth: turn.agentDepth,
        attemptGeneration,
        description: turn.description ?? "",
        prompt: turn.prompt,
        execution: turn.execution!,
        placement: "cloud",
        ...(turn.originDeviceId ? { originDeviceId: turn.originDeviceId } : {}),
        ...(turn.originConversationId
          ? { originConversationId: turn.originConversationId }
          : {}),
        createdAt,
      } satisfies ThreadSpawnedEvent);
    }
    await this.enqueueOutboxDurable(events);
  }

  private async acceptAgentTurn(turn: TurnRequest): Promise<Response> {
    type Admission =
      | { response: Response }
      | {
          kind: "pre_canceled";
          cancellation: ExactTurnCancellation;
          ownsStorage: boolean;
        }
      | {
          kind: "start";
          sandboxId?: string;
          orphan?: PendingTerminal;
          orphanTurn?: TurnRequest;
        };
    const sharedWorldSandboxId = await worldSandboxId(turn.ownerId);
    const admission = await this.ctx.blockConcurrencyWhile(
      async (): Promise<Admission> => {
        const current = await this.ctx.storage.get<TurnRequest>("turn");
        if (current?.kind === "agent") {
          const exactReplay = exactTurnIdentityMatches(current, turn);
          if (current.turnId !== turn.turnId) {
            const currentCancellation =
              await this.exactTurnCancellations.matching({
                turnId: current.turnId,
                ownerId: current.ownerId,
                ownerGeneration: current.ownerGeneration,
                attemptGeneration: current.attemptGeneration,
              });
            if (currentCancellation?.state === "pending") {
              return {
                response: json(
                  {
                    accepted: false,
                    reason: "cancellation_join_pending",
                    currentTurnId: current.turnId,
                  },
                  409,
                ),
              };
            }
          }
          const currentAttempt = current.attemptGeneration;
          const [executionMarker, fallbackJournal, observedSuspension] =
            Number.isSafeInteger(currentAttempt)
              ? await Promise.all([
                  this.ctx.storage.get<AgentExecutionMarker>(
                    agentExecutionMarkerKey(current.turnId, currentAttempt!),
                  ),
                  this.ctx.storage.get<BuilderFallbackTranscript>(
                    builderFallbackTranscriptKey(
                      current.turnId,
                      currentAttempt!,
                    ),
                  ),
                  this.ctx.storage.get<ObservedBrowserSuspension>(
                    OBSERVED_BROWSER_SUSPENSION_KEY,
                  ),
                ])
              : [undefined, undefined, undefined];
          const pendingBrowserSuspension =
            await this.ctx.storage.get<PendingBrowserSuspension>(
              PENDING_BROWSER_SUSPENSION_KEY,
            );
          const locallyRunning = this.agentTurnExecutions.has(current.turnId);
          if (
            locallyRunning ||
            executionMarker ||
            fallbackJournal ||
            observedSuspension ||
            pendingBrowserSuspension
          ) {
            if (!locallyRunning) {
              await this.ctx.storage.setAlarm(Date.now() + 1_000);
            }
            return {
              response: exactReplay
                ? this.agentTurnAccepted(turn, true, {
                    recovering: !locallyRunning,
                  })
                : json(
                    {
                      accepted: false,
                      reason: "previous_turn_recovering",
                      currentTurnId: current.turnId,
                    },
                    409,
                  ),
            };
          }
        }
        const cancellation = await this.exactTurnCancellations.matching({
          turnId: turn.turnId,
          ownerId: turn.ownerId,
          ownerGeneration: turn.ownerGeneration,
          attemptGeneration: turn.attemptGeneration,
        });
        if (cancellation) {
          const ownsStorage = !current || current.turnId === turn.turnId;
          if (ownsStorage && cancellation.state === "pending") {
            await this.ctx.storage.put({
              turn,
              turnId: turn.turnId,
              terminal: false,
              terminalDelivered: false,
              alarmAttempts: 0,
              alarmReconcile: false,
            });
          }
          return {
            kind: "pre_canceled",
            cancellation,
            ownsStorage,
          };
        }
        const computePlan = this.admittedComputePlan(turn);
        const resident = computePlan?.plan.kind === "resident_stella";
        // A resident turn still starts without compute. If it attaches, it
        // uses the same owner-world container as the eager path.
        const sandboxId = resident ? undefined : sharedWorldSandboxId;
        // A predecessor whose terminal state never reached Convex left it
        // here. Taking over the DO takes the alarm with it, so this is its last
        // chance; the stale delivery below cannot mutate this successor.
        const orphan =
          await this.ctx.storage.get<PendingTerminal>("pendingTerminal");
        const orphanTurn = orphan
          ? await this.ctx.storage.get<TurnRequest>("turn")
          : undefined;
        await this.ctx.storage.put({
          ...(sandboxId ? { sandboxId } : {}),
          ...(computePlan
            ? {
                [turnComputePlanKey(turn.turnId, turn.attemptGeneration!)]:
                  computePlan,
              }
            : {}),
          turn,
          turnId: turn.turnId,
          terminal: false,
          terminalDelivered: false,
          alarmAttempts: 0,
          alarmReconcile: false,
        });
        await this.ctx.storage.delete([
          "pendingTerminal",
          PENDING_BROWSER_SUSPENSION_KEY,
          OBSERVED_BROWSER_SUSPENSION_KEY,
          AGENT_RECOVERY_PENDING_KEY,
        ]);
        return {
          kind: "start",
          ...(sandboxId ? { sandboxId } : {}),
          orphan,
          orphanTurn,
        };
      },
    );
    if ("response" in admission) {
      await this.unregisterTurn(turn);
      // A refusal gives the slot straight back; an accepted replay keeps it,
      // because the attempt it names is still the one running.
      if (!admission.response.ok) await this.releaseOwnerGate(turn);
      return admission.response;
    }
    if (admission.kind === "pre_canceled") {
      if (admission.cancellation.state === "pending") {
        const delivered = await this.deliverTerminal(turn, {
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration!,
          kind: "canceled",
          payload: { message: "Stopped. Nothing was changed." },
          threadError: "The agent was stopped.",
        });
        if (delivered) {
          if (
            !(await this.acknowledgeExactAgentTurnCancellation(
              admission.cancellation,
            ))
          ) {
            await this.unregisterTurn(turn);
            return json(
              {
                accepted: false,
                canceled: true,
                reason: "cancellation_acknowledgement_lost",
              },
              503,
            );
          }
          if (admission.ownsStorage && (await this.ownsExactTurn(turn))) {
            await this.deleteTurnStoragePreservingExactCancellations(
              turn,
              true,
            );
          }
        }
      }
      await this.unregisterTurn(turn);
      await this.releaseOwnerGate(turn);
      return this.agentTurnAccepted(turn, false, {
        canceled: true,
        preAdmission: true,
        durable: true,
      });
    }
    const { orphan, orphanTurn } = admission;
    const { sandboxId } = admission;
    if (
      orphan &&
      orphanTurn &&
      orphan.turnId === orphanTurn.turnId &&
      orphan.turnId !== turn.turnId
    ) {
      this.ctx.waitUntil(
        this.trackTurn(
          orphanTurn.turnId,
          this.redeliverOrphan(orphanTurn, orphan),
        ).catch(() => undefined),
      );
    }
    const watchdogDeadlineAt =
      Date.now() + Math.max(1_000, turn.watchdogMs ?? 15 * 60_000);
    await this.mutateExactTurn(turn, async (txn) => {
      await txn.put(AGENT_WATCHDOG_DEADLINE_KEY, watchdogDeadlineAt);
      await txn.setAlarm(
        Math.min(watchdogDeadlineAt, Date.now() + AGENT_TURN_HEARTBEAT_MS),
      );
    });
    // Projected before the run starts: Convex has to know the attempt exists
    // even if this isolate dies in the next millisecond, and the outbox is
    // ordered behind a durable debt if the queue refuses.
    await this.projectAgentTurnStart(turn);
    this.ctx.waitUntil(
      this.startAgentTurn(turn, sandboxId).catch(() => undefined),
    );
    return this.agentTurnAccepted(turn, false);
  }

  private async runEcho(): Promise<Response> {
    // Every diagnostic run gets its own lifecycle identity as well; a delayed
    // destroy alarm from one echo can never target the next echo's container.
    const sandboxId = `echo-${crypto.randomUUID()}`;
    const sandbox = this.sandbox(sandboxId);
    await this.ctx.storage.put("sandboxId", sandboxId);
    try {
      const session = await sandbox.createSession({
        id: sessionName(`echo-${crypto.randomUUID()}`),
        cwd: "/opt/stella",
        commandTimeoutMs: Number(this.env.TURN_TIMEOUT_MS),
      });
      const execution = await session.exec(
        "bun packages/executor-cloud/src/cli.ts --stub",
        { timeout: Number(this.env.TURN_TIMEOUT_MS) },
      );
      await sandbox.deleteSession(session.id).catch(() => undefined);
      if (!execution.success) {
        return json(
          {
            error: "Executor echo failed.",
            code: `executor.${classifyAgentFailureDiagnostic(execution.stderr)}`,
          },
          502,
        );
      }
      return json({
        ok: true,
        executor: JSON.parse(
          execution.stdout.trim().split("\n").at(-1) ?? "{}",
        ),
      });
    } catch {
      return json(
        { error: "Sandbox echo failed.", code: "sandbox.echo_failed" },
        502,
      );
    } finally {
      await this.destroySandboxDurably(
        { sandboxId, size: "large", workload: "app-build" },
        "echo_terminal",
      ).catch(() => undefined);
      await this.deleteTurnStoragePreservingExactCancellations(undefined, true);
    }
  }

  /**
   * Agent-only Vite access. The outer Worker routes by BuildSession name; this
   * object re-verifies the signed exact turn/sandbox scope and the durable
   * active nonce before a single byte reaches the raw tunnel.
   */
  private async proxyVitePreview(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "Method not allowed." }, 405);
    }
    const capability = request.headers.get(HEADER_PREVIEW_CAPABILITY) ?? "";
    const [turn, sandboxId, terminal, activeRecord] = await Promise.all([
      this.ctx.storage.get<TurnRequest>("turn"),
      this.ctx.storage.get<string>("sandboxId"),
      this.ctx.storage.get<boolean>("terminal"),
      this.ctx.storage.get(PREVIEW_ACCESS_STORAGE_KEY),
    ]);
    if (
      !turn ||
      turn.kind === "agent" ||
      terminal === true ||
      !sandboxId ||
      !turn.previewRoute
    ) {
      return json({ error: "Preview is no longer active." }, 410);
    }
    const verified = await verifyPreviewAccessCapability({
      capability,
      secret: this.env.BUILDER_SERVICE_SECRET,
      expected: {
        buildSessionName: turn.previewRoute.buildSessionName,
        turnId: turn.turnId,
        sandboxId,
      },
      activeRecord,
      now: Date.now(),
    });
    if (!verified.ok) {
      return json(
        { error: "Preview access was rejected.", code: verified.code },
        verified.code === "expired" || verified.code === "inactive" ? 410 : 403,
      );
    }
    const incoming = new URL(request.url);
    const target = resolvePreviewTunnelRequest({
      tunnelUrl: verified.tunnelUrl,
      proxyPathname: incoming.pathname,
      search: incoming.search,
    });
    if (!target) {
      return json({ error: "Preview path was rejected." }, 400);
    }
    const headers = new Headers();
    for (const name of ["accept", "accept-language", "range"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => undefined);
      return json({ error: "Preview redirect was rejected." }, 502);
    }
    const responseHeaders = new Headers({
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    });
    for (const name of ["content-type", "content-length", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  // A spawned general agent's turn: restore its workspace, run the real
  // runtime headless in the sandbox, checkpoint, report. The executor
  // streams its own progress events with the turn token; this method owns
  // workspace persistence and the terminal event. Runs detached from the
  // dispatch request (see acceptAgentTurn).
  /**
   * The one place a turn's admitted placement is acted on.
   *
   * The plan is read back rather than re-derived: a config flip between
   * admission and here would otherwise re-place a turn whose container was
   * (or was not) already reserved, and both cancellation sweeps destroy by
   * that reservation.
   */
  private async runAgentTurn(
    turn: TurnRequest,
    sandboxId: string | undefined,
    execution: TurnExecutionContext,
  ): Promise<void> {
    const identity = {
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration ?? 0,
    };
    const admitted = parseTurnComputePlan(
      await this.ctx.storage.get(
        turnComputePlanKey(identity.turnId, identity.attemptGeneration),
      ),
      identity,
    );
    await runGeneralAgentTurn({
      plan:
        admitted?.plan ??
        ({
          kind: "native_sandbox",
          ...(turn.execution ? { execution: turn.execution } : {}),
          reason: "unplaced",
        } as const),
      context: execution,
      resident: (plan) => this.runResidentAgentTurn(turn, plan, execution),
      native: async () => {
        // Admission mints the id for every plan that keeps the container
        // path, so an absent one here means this isolate is running a turn
        // whose reservation another attempt owns.
        if (!sandboxId) throw new AgentTurnAuthorityLostError();
        await this.runContainerAgentTurn(turn, sandboxId, execution);
      },
    });
  }

  /**
   * Resolve what a lazy attach has to put on disk.
   *
   * The container path does this before it boots. A resident turn cannot: the
   * whole point is that a chat-only turn never pays for it. So it runs at
   * attach time instead, against the same owner fence and with the same
   * refusal when a predecessor's publication is still being repaired.
   */
  private async resolveAgentWorldRestore(
    turn: TurnRequest,
    execution: TurnExecutionContext,
    history: AgentHistoryRow[],
  ): Promise<{
    turnStateWorkspaceRestore?: TurnStateWorkspaceHead;
    turnStateWorkspaceRestoreConfirmationRequired: boolean;
    turnStateThreadRestore?: TurnStateCandidate;
    turnStateThreadRestoreConfirmationRequired: boolean;
  }> {
    const canonicalHistoryCursor = await nativeHistoryCursorFromRows(history);
    let resolved = await this.resolveAgentTurnState(
      turn,
      canonicalHistoryCursor,
    );
    execution.assertActive();
    if (resolved.workspacePublication) {
      if (!resolved.workspacePublication.publishable) {
        throw new AgentTurnError(
          "This workspace is still recovering a previous agent turn. Try again shortly.",
        );
      }
      this.assertAgentTurnIdentity(turn);
      await this.publishAgentTurnWorkspace(
        turn,
        canonicalHistoryCursor,
        resolved.workspacePublication.operationId,
      );
      execution.assertActive();
      resolved = await this.resolveAgentTurnState(turn, canonicalHistoryCursor);
      execution.assertActive();
      if (resolved.workspacePublication) {
        throw new AgentTurnError(
          "This workspace is still recovering a previous agent turn. Try again shortly.",
        );
      }
    }
    if (resolved.registryPresent && !resolved.workspace) {
      throw new AgentTurnError(
        "This workspace's saved state is incomplete. Try again after Stella finishes recovering it.",
      );
    }
    await this.ctx.storage.put(
      turnStateBaseWorkspaceRevisionKey(turn.turnId, turn.attemptGeneration!),
      resolved.baseWorkspaceRevision,
    );
    execution.assertActive();
    return {
      ...(resolved.workspace
        ? { turnStateWorkspaceRestore: resolved.workspace }
        : {}),
      turnStateWorkspaceRestoreConfirmationRequired:
        resolved.workspaceConfirmationRequired,
      ...(resolved.restore ? { turnStateThreadRestore: resolved.restore } : {}),
      turnStateThreadRestoreConfirmationRequired: resolved.confirmationRequired,
    };
  }

  /**
   * Issue the daemon's broker capability exactly the way the container
   * executor gets it: a root-owned file above the world root, with the durable
   * record written before the container can present it. The raw turn token
   * never crosses this boundary.
   */
  private async prepareAgentBrokerHandoff(args: {
    turn: TurnRequest;
    session: ExecutionSession;
    commandTimeoutMs: number;
    workspaceRestored: boolean;
  }): Promise<{
    turnId: string;
    attemptGeneration: number;
    threadId: string;
    prompt: string;
    workspaceRestored: boolean;
    turnBroker: { credentialsPath: string };
    world: { origin: string; name: string; capability: string };
  }> {
    const { turn } = args;
    if (!turn.turnBrokerRoute || !turn.threadId) {
      throw new AgentTurnAuthorityLostError();
    }
    const brokerIdentity = {
      sessionId: turn.turnBrokerRoute.sessionId,
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
    };
    const issued = await issueTurnBrokerCredential({
      identity: brokerIdentity,
      endpoint: turn.turnBrokerRoute.endpoint,
      now: Date.now(),
      ttlMs: Math.max(
        1,
        Math.min(TURN_BROKER_MAX_TTL_MS, args.commandTimeoutMs),
      ),
    });
    await this.ctx.storage.put(
      turnBrokerStorageKey(brokerIdentity),
      issued.record,
    );
    const credentialsPath = turnBrokerCredentialsPath();
    await args.session.writeFile(
      credentialsPath,
      JSON.stringify(issued.handoff),
    );
    const protectedHandoff = await args.session.exec(
      `chmod 600 ${credentialsPath}`,
    );
    if (!protectedHandoff.success) {
      throw new Error("Turn broker handoff could not be protected.");
    }
    const name = await worldName(turn.ownerId);
    const worldCapability = await issueWorldCapability({
      secret: this.env.BUILDER_SERVICE_SECRET,
      worldName: name,
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      now: Date.now(),
      ttlMs: Math.max(1, Math.min(30 * 60_000, args.commandTimeoutMs)),
    });
    return {
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      threadId: turn.threadId,
      prompt: turn.prompt,
      workspaceRestored: args.workspaceRestored,
      turnBroker: { credentialsPath },
      world: {
        origin: this.env.CLOUD_BUILDER_PUBLIC_URL.replace(/\/+$/u, ""),
        name,
        capability: worldCapability,
      },
    };
  }

  /**
   * A Stella turn whose agent loop runs right here.
   *
   * No container exists until a tool needs one. What that buys is on the
   * turn's critical path: a chat-only reply costs one Convex history read and
   * the model call, with no cold start, no squashfs restore, and nothing to
   * tear down when the user stops it.
   */
  private async runResidentAgentTurn(
    turn: TurnRequest,
    plan: Extract<GeneralAgentTurnPlan, { kind: "resident_stella" }>,
    execution: TurnExecutionContext,
  ): Promise<GeneralAgentTurnResult> {
    const requestStarted = performance.now();
    const commandTimeoutMs = Number(this.env.TURN_TIMEOUT_MS);
    await this.assertAgentExecutionActive(turn, execution);
    if (!turn.threadId || !turn.turnBrokerRoute) {
      throw new AgentTurnAuthorityLostError();
    }
    const attemptGeneration = turn.attemptGeneration!;
    const identity = { turnId: turn.turnId, attemptGeneration };
    // These fields mirror the currently attached resource for alarm cleanup.
    // Clear a predecessor before this resident attempt can attach; an exact
    // replay with a compute record keeps the mirror for its existing session.
    await this.clearUnattachedAgentSandboxTuple(turn);
    await this.event(
      turn,
      "auto",
      "started",
      { threadId: turn.threadId },
      false,
      execution.signal,
    );
    execution.assertActive();

    const control = this.agentControlPlane(
      turn,
      attemptGeneration,
      turn.turnBrokerRoute.sessionId,
    );

    const sandboxId = await worldSandboxId(turn.ownerId);
    const world = this.env.WORLDS.getByName(await worldName(turn.ownerId));
    const proposedSize: InstanceSize = !this.env.SANDBOX_SMALL
      ? "large"
      : initialInstanceSize({ prompt: turn.prompt });
    const instanceSize = proposedSize;
    const sessionId = agentTurnSessionId(turn.turnId);
    const daemonDirectory = attachedToolPaths(identity).directory;
    let attachedWorkspaceRestore: TurnStateWorkspaceHead | undefined;
    let residentHistory: AgentHistoryRow[] = [];
    let residentSandbox: ReturnType<BuildSession["sandbox"]> | undefined;
    const attachment = createAgentSandboxAttachment({
      context: execution,
      attachWorld: async ({
        instanceSize: size,
        sessionId: attachedSessionId,
      }) => {
        await this.ctx.storage.put({ sandboxId, sandboxSize: size });
        residentSandbox = this.sandbox(sandboxId, size, "world");
        // The thread before this turn — exactly what the container path
        // resolves against. Read here rather than at admission so a
        // chat-only resident turn never pays for it. Resolving against an
        // empty history instead named the wrong cursor on every follow-up:
        // the previous turn's checkpoint could never be published or
        // restored, and each attach refused as "still recovering".
        residentHistory = this.residentAttachHistory(turn, execution);
        const restore = await this.resolveAgentWorldRestore(
          turn,
          execution,
          residentHistory,
        );
        attachedWorkspaceRestore = restore.turnStateWorkspaceRestore;
        const attached = await this.attachAgentWorld({
          turn,
          execution,
          sandbox: residentSandbox,
          size,
          history: residentHistory,
          commandTimeoutMs,
          sessionId: attachedSessionId,
          ...restore,
        });
        // D9's fork. Only a confirmed world is worth archiving, so the marker
        // lands after the restore: an eviction before this point releases the
        // incomplete session, and one after it recovers by archiving the disk
        // the way a lost container executor already does.
        await this.persistAgentExecutionMarker(turn, {
          schemaVersion: 1,
          turnId: turn.turnId,
          attemptGeneration,
          sandboxId,
          size,
          startedAt: Date.now(),
        });
        return attached;
      },
      prepareBrokerHandoff: async ({ session }) =>
        await this.prepareAgentBrokerHandoff({
          turn,
          session,
          commandTimeoutMs,
          workspaceRestored: Boolean(attachedWorkspaceRestore),
        }),
      // The daemon runs on the sessionless facade, exactly as the eager
      // container path runs its executor: a background process started
      // through the `agent-run` session is a child of that session's
      // persistent shell and dies with it, and that shell is also where the
      // restore scripts, the readiness probe and every bridged call run.
      startDaemon: async (command, options) => {
        if (!residentSandbox) {
          throw new Error("The resident sandbox has not been attached.");
        }
        return await residentSandbox.startProcess(command, {
          cwd: options.cwd,
          env: executorSessionEnvironment(),
          processId: options.processId,
        });
      },
      release: async (target) => {
        await this.releaseAgentSessionResources({
          sandboxId: target.sandboxId,
          size: target.instanceSize,
          sessionId: target.sessionId,
          daemonDirectory: target.daemonDirectory,
          workload: "world",
        });
      },
      destroy: async (target) => {
        await this.destroySandboxDurably(
          {
            sandboxId: target.sandboxId,
            size: target.instanceSize,
            workload: "world",
          },
          "agent_oom_resize",
        );
      },
      // Without this the attachment's own diagnostics (a daemon that exited
      // before listening, or stopped answering mid-turn, with its stderr)
      // were thrown away, and a dead workspace bridge looked like a bare
      // "connection refused" to everyone downstream.
      emitEvent: (kind, payload) => {
        void this.event(
          turn,
          "auto",
          kind,
          payload,
          false,
          execution.signal,
        ).catch(() => undefined);
      },
    });

    const ladder = createAgentComputeLadder({
      ...identity,
      sandboxId,
      sessionId,
      daemonDirectory,
      initialInstanceSize: instanceSize,
      selectInstanceSize: async (initial) =>
        await world.selectContainerSize(initial),
      rememberInstanceSize: async (size) => {
        await world.rememberContainerSize(size);
      },
      store: {
        read: async () =>
          parsePersistedAgentCompute(
            await this.ctx.storage.get(
              agentComputeKey(turn.turnId, attemptGeneration),
            ),
            identity,
          ),
        write: async (record: PersistedAgentCompute) => {
          await this.ctx.storage.put(
            agentComputeKey(turn.turnId, attemptGeneration),
            record,
          );
        },
      },
      attachment,
      context: execution,
      emitEvent: (kind, payload) => {
        void this.event(
          turn,
          "auto",
          kind,
          payload,
          false,
          execution.signal,
        ).catch(() => undefined);
      },
    });

    const agentControl = createBuildSessionAgentControl({
      storage: this.ctx.storage,
      env: this.env,
      dispatch: this.childAgentDispatchDependencies(),
      parent: {
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        conversationId: turn.conversationId!,
        turnId: turn.turnId,
        threadId: turn.threadId!,
        agentDepth: turn.agentDepth,
        execution: plan.execution,
      },
    });
    const doLocal = createGeneralAgentDoLocalTools({
      control,
      agentControl,
      world: this.env.WORLDS.getByName(await worldName(turn.ownerId)),
      requestInteriorBuild: () => ladder.requestInteriorBuild(),
      now: () => Date.now(),
      signal: execution.signal,
    });
    // `code` runs in a Dynamic Worker the DO loads on demand, the same
    // executor the cloud orchestrator uses, so a resident agent evaluates
    // JavaScript without reserving a container. Only the DO-local tools are
    // reachable from inside code, and only the read-only ones among them; a
    // deployment without the loader keeps the model-visible refusal instead.
    const jsSandbox = this.env.LOADER
      ? new Map([
          [
            CODE_TOOL_NAME,
            await createCloudCodeAgentTool({
              loader: this.env.LOADER,
              tools: [...doLocal.values()],
              executionScope: `${turn.ownerGeneration}:${turn.threadId}:${turn.turnId}:${attemptGeneration}`,
            }),
          ],
        ])
      : undefined;

    let computeReleased = false;
    try {
      execution.assertActive();
      const modelGateway = await mintAgentTurnModelGateway(
        this.env,
        turn,
        plan.execution,
      );
      execution.assertActive();
      const modelGatewayBinding = this.env.MODEL_GATEWAY;
      if (!modelGatewayBinding) {
        throw new Error("Model gateway is not configured.");
      }
      const result = await runResidentStellaLoop({
        turn: {
          kind: "agent",
          identity: {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            threadId: turn.threadId,
            turnId: turn.turnId,
            attemptGeneration,
          },
          prompt: turn.prompt,
          brokerRoute: turn.turnBrokerRoute,
          execution: plan.execution,
          audience: turn.audience,
          budgetMicroCents: turn.budgetMicroCents,
          watchdogMs: turn.watchdogMs ?? 15 * 60_000,
        },
        execution: plan.execution,
        context: execution,
        control,
        modelGateway: {
          origin: modelGateway.origin,
          capability: modelGateway.capability,
          fetch: (input, init) => modelGatewayBinding.fetch(input, init),
        },
        sql: this.ctx.storage.sql,
        tools: createResidentGeneralAgentTools(doLocal, ladder, jsSandbox, {
          agentDepth: turn.agentDepth,
        }),
        steer: {
          drain: async () =>
            SteerMailbox.open(this.ctx.storage.sql).drain({
              turnId: turn.turnId,
              attemptGeneration,
            }),
          acknowledge: (ids) =>
            SteerMailbox.open(this.ctx.storage.sql).acknowledge(
              { turnId: turn.turnId, attemptGeneration },
              ids,
            ),
        },
        workspacePrompt: { office: false },
        now: () => Date.now(),
        onAgentStarted: (abort) => {
          this.residentAgentAborts.set(turn.turnId, abort);
        },
        commit: async (sealed, finalText) =>
          await this.commitResidentTurnDurability({
            turn,
            execution,
            ladder,
            sealed,
            finalText,
            control,
            commandTimeoutMs,
          }),
      });
      computeReleased = true;
      await this.finishResidentAgentTurn(turn, ladder, result, requestStarted);
      return result;
    } finally {
      this.residentAgentAborts.delete(turn.turnId);
      // The sweep for an exceptional exit only. A turn that reached its
      // completion sequence has already released what attached.
      if (!computeReleased) await ladder.teardown().catch(() => undefined);
    }
  }

  /**
   * A completed resident turn releases its compute before its terminal is
   * delivered. Delivery deletes the exact compute record with the rest of the
   * turn's storage; after that, cleanup would no longer know which session and
   * daemon directory belong to the turn. Failure paths use the same order.
   */
  private async finishResidentAgentTurn(
    turn: TurnRequest,
    ladder: Pick<ReturnType<typeof createAgentComputeLadder>, "teardown">,
    result: GeneralAgentTurnResult,
    requestStarted: number,
  ): Promise<void> {
    await this.releaseResidentCompute(turn, ladder);
    await this.deliverResidentTerminal(turn, result, requestStarted);
  }

  /** Release resident compute without withholding the turn terminal. */
  private async releaseResidentCompute(
    turn: TurnRequest,
    ladder: Pick<ReturnType<typeof createAgentComputeLadder>, "teardown">,
  ): Promise<void> {
    try {
      await ladder.teardown();
    } catch (error) {
      log("error", "resident_compute_release_failed", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message: errorMessage(error),
      });
    }
  }

  /**
   * D6, sequenced by the code that owns `turn-state-archive`.
   *
   * A turn that never attached commits its transcript and nothing else. One
   * that did — including a resident turn that asked for the interior build and
   * so attaches after the loop — commits the archive first, because a
   * canonical cursor must never name a workspace revision that was never
   * uploaded.
   */
  private async commitResidentTurnDurability(args: {
    turn: TurnRequest;
    execution: TurnExecutionContext;
    ladder: ReturnType<typeof createAgentComputeLadder>;
    sealed: SealedTurnTranscript;
    /** The turn's final assistant text; delivered files derive from its links. */
    finalText: string;
    control: ReturnType<typeof createAgentControlPlane>;
    commandTimeoutMs: number;
  }): Promise<Exclude<TurnDurability, { kind: "none" }>> {
    const { turn, execution, ladder, sealed, control } = args;
    await ladder.attachForInteriorBuild();
    execution.assertActive();
    if (!ladder.attached()) {
      return {
        kind: "transcript_only",
        transcript: await control.appendAndVerifyTranscript(sealed),
      };
    }
    const sandbox = await this.currentSandbox();
    if (!sandbox) throw new AgentTurnAuthorityLostError();
    const interior = await this.publishRequestedInteriorCandidate({
      turn,
      sandbox,
      commandTimeoutMs: args.commandTimeoutMs,
      turnExecution: execution,
    });
    if (interior.outcome === "failed") {
      throw new AgentTurnError(interior.error);
    }
    await ladder.quiesce(extractLocalFileLinkPaths(args.finalText));
    execution.assertActive();
    const checkpoint = await this.runResidentTurnStateCheckpoint({
      turn,
      historyCursor: sealed.historyCursor,
    });
    const transcript = await control.appendAndVerifyTranscript(sealed);
    await this.publishResidentTurnWorkspace(turn, execution, checkpoint);
    return {
      kind: "workspace_manifest",
      transcript,
      historyCursor: checkpoint.historyCursor,
      manifestId: checkpoint.manifestId,
    };
  }

  /** What a lazy resident attach restores against: the thread before this turn. */
  private residentAttachHistory(
    turn: TurnRequest,
    execution: TurnExecutionContext,
  ): AgentHistoryRow[] {
    return this.fetchCanonicalAgentHistory(turn, {
      excludeCurrentTurn: true,
      signal: execution.signal,
    });
  }

  /**
   * Publish the checkpoint an attached resident turn just committed, the way
   * the container path does at its own completion. Left as a candidate, it
   * could only be published by the thread's next turn, and only while that
   * turn's history cursor still matched; a chat-only turn in between moved
   * the cursor and left every later attach refusing as "still recovering".
   * The transcript is already verified canonical, so the receipt's cursor is
   * the one cloud history names.
   */
  private async publishResidentTurnWorkspace(
    turn: TurnRequest,
    execution: TurnExecutionContext,
    checkpoint: TurnBrokerTurnStateCheckpointReceipt,
  ): Promise<void> {
    execution.assertActive();
    this.assertAgentTurnIdentity(turn);
    await this.publishAgentTurnWorkspace(
      turn,
      checkpoint.historyCursor,
      checkpoint.operationId,
    );
    execution.assertActive();
  }

  /**
   * Run the deterministic turn-state operation for an attached resident turn.
   *
   * The container path reaches the same code through a broker request, whose
   * id makes a replay idempotent. A resident turn is its own requester, so the
   * id is derived from the exact attempt instead: an alarm replay resumes this
   * operation rather than manufacturing a second archive.
   */
  private async runResidentTurnStateCheckpoint(args: {
    turn: TurnRequest;
    historyCursor: string;
  }): Promise<TurnBrokerTurnStateCheckpointReceipt> {
    const { turn } = args;
    const attemptGeneration = turn.attemptGeneration!;
    const requestId = await sha256Hex(
      `resident-turn-state:${turn.turnId}:${attemptGeneration}`,
    );
    const operationKey = turnStateCheckpointOperationKey(requestId);
    const baseWorkspaceRevision = await this.ctx.storage.get<number>(
      turnStateBaseWorkspaceRevisionKey(turn.turnId, attemptGeneration),
    );
    if (!Number.isSafeInteger(baseWorkspaceRevision)) {
      throw new AgentTurnError(
        "Stella could not establish this workspace's revision for the turn. Try again.",
      );
    }
    const existing =
      await this.ctx.storage.get<TurnStateCheckpointOperation>(operationKey);
    if (existing?.state === "succeeded") return existing.receipt;
    const payload: TurnBrokerTurnStateCheckpointRequest = {
      schemaVersion: 1,
      historyCursor: args.historyCursor,
    };
    const operation: Extract<
      TurnStateCheckpointOperation,
      { state: "pending" }
    > & { payload: TurnBrokerTurnStateCheckpointRequest } = {
      state: "pending",
      turnId: turn.turnId,
      attemptGeneration,
      requestId,
      requestFingerprint: await sha256Hex(JSON.stringify(payload)),
      createdAt: existing?.createdAt ?? Date.now(),
      baseWorkspaceRevision: baseWorkspaceRevision!,
      payload,
    };
    await this.ctx.storage.put(operationKey, operation);
    const inFlight = this.turnStateCheckpointRuns.get(requestId);
    if (inFlight) return await inFlight;
    const run = this.executeTurnStateCheckpoint({
      turn,
      operationKey,
      operation,
    });
    this.turnStateCheckpointRuns.set(requestId, run);
    try {
      return await run;
    } finally {
      this.turnStateCheckpointRuns.delete(requestId);
    }
  }

  /**
   * The resident arm's terminal event. Same envelope the container path
   * delivers, minus the fields a resident turn genuinely does not have: there
   * is no cold start and no restore to report when nothing booted.
   */
  private async deliverResidentTerminal(
    turn: TurnRequest,
    result: GeneralAgentTurnResult,
    requestStarted: number,
  ): Promise<void> {
    const wallClockMs = Math.round(performance.now() - requestStarted);
    const compute = result.compute;
    const shared = {
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        llmCalls: result.usage.llmCalls,
      },
      coldContainerStartMs:
        compute.kind === "sandbox" ? compute.coldStartMs : 0,
      restoreMs: compute.kind === "sandbox" ? compute.restoreMs : 0,
      checkpointMs: 0,
      wallClockMs,
      ...(compute.kind === "sandbox"
        ? { instanceType: INSTANCE_TIERS[compute.instanceSize].instanceType }
        : {}),
    };
    const pending: PendingTerminal = result.ok
      ? {
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration!,
          kind: "completed",
          payload: { finalText: result.finalText, ...shared },
        }
      : {
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration!,
          kind: "failed",
          payload: {
            message:
              result.outcome === "failed"
                ? result.error
                : "The agent stopped and could not continue.",
          },
          threadError:
            result.outcome === "failed"
              ? result.error
              : "The agent stopped and could not continue.",
        };
    const delivered = await this.deliverTerminal(turn, pending);
    if (delivered && (await this.ownsExactTurn(turn))) {
      await this.deleteTurnStoragePreservingExactCancellations(turn, true);
    }
    log("info", "agent_turn_finished", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      ok: result.ok,
      wallClockMs,
    });
    emitCloudTurnTelemetry(this.ctx, this.env, {
      type: "cloud.turn",
      workload: "agent",
      phase: result.ok ? "completed" : "failed",
      wallClockMs,
      coldContainerStartMs: shared.coldContainerStartMs,
      restoreMs: shared.restoreMs,
      checkpointMs: 0,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      llmCalls: result.usage.llmCalls,
      ...(shared.instanceType ? { instanceType: shared.instanceType } : {}),
    });
  }

  private async runContainerAgentTurn(
    turn: TurnRequest,
    sandboxId: string,
    execution: TurnExecutionContext,
  ): Promise<void> {
    const commandTimeoutMs = Number(this.env.TURN_TIMEOUT_MS);
    const requestStarted = performance.now();
    let sandbox = this.sandbox(sandboxId, "large", "world");
    const sessionId = agentTurnSessionId(turn.turnId);
    const daemonDirectory = attachedToolPaths({
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
    }).directory;
    const world = this.env.WORLDS.getByName(await worldName(turn.ownerId));
    log("info", "agent_turn_started", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      sessionId: this.ctx.id.toString(),
    });
    try {
      await this.assertAgentExecutionActive(turn, execution);
      await this.event(
        turn,
        "auto",
        "started",
        { threadId: turn.threadId },
        false,
        execution.signal,
      );
      execution.assertActive();

      // Thread transcript for send_input continuations: the DO fetches it
      // (service secret) and hands it to the executor, which holds only the
      // turn token. Fetched once, before any sandbox exists, so an escalation
      // retry does not pay for it twice.
      const history = this.fetchCanonicalAgentHistory(turn, {
        excludeCurrentTurn: true,
        signal: execution.signal,
      });
      execution.assertActive();

      const canonicalHistoryCursor = await nativeHistoryCursorFromRows(history);
      let resolvedTurnState = await this.resolveAgentTurnState(
        turn,
        canonicalHistoryCursor,
      );
      execution.assertActive();
      if (resolvedTurnState.workspacePublication) {
        if (!resolvedTurnState.workspacePublication.publishable) {
          throw new AgentTurnError(
            "This workspace is still recovering a previous agent turn. Try again shortly.",
          );
        }
        this.assertAgentTurnIdentity(turn);
        await this.publishAgentTurnWorkspace(
          turn,
          canonicalHistoryCursor,
          resolvedTurnState.workspacePublication.operationId,
        );
        execution.assertActive();
        resolvedTurnState = await this.resolveAgentTurnState(
          turn,
          canonicalHistoryCursor,
        );
        execution.assertActive();
        if (resolvedTurnState.workspacePublication) {
          throw new AgentTurnError(
            "This workspace is still recovering a previous agent turn. Try again shortly.",
          );
        }
      }
      const turnStateWorkspaceRestore = resolvedTurnState.workspace;
      const turnStateThreadRestore = resolvedTurnState.restore;
      if (resolvedTurnState.registryPresent && !turnStateWorkspaceRestore) {
        throw new AgentTurnError(
          "This workspace's saved state is incomplete. Try again after Stella finishes recovering it.",
        );
      }
      if (
        resolvedTurnState.threadRegistryPresent &&
        !turnStateThreadRestore &&
        requiresExactThreadCandidate(turn.execution)
      ) {
        throw new AgentTurnError(
          "This agent's saved session no longer matches its cloud conversation. Start a new agent thread to continue safely.",
        );
      }
      await this.ctx.storage.put(
        turnStateBaseWorkspaceRevisionKey(turn.turnId, turn.attemptGeneration!),
        resolvedTurnState.baseWorkspaceRevision,
      );
      execution.assertActive();

      // The mirror snapshot is pinned once for the logical turn, before either
      // sandbox attempt. An OOM retry therefore cannot silently pick up a
      // device-side skill edit that landed halfway through the turn.
      const cloudSkillHome = this.env.AGENT_HOME
        ? new CloudHomeStore(this.env.AGENT_HOME, {
            base: this.env.STELLA_CONVEX_SITE_URL,
            // Owner-scoped control-plane reads and writes, authorized by this
            // turn rather than by the worker's shared secret.
            bearer: await this.controlPlaneCapability(turn),
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            assertExternalWrite: async () =>
              await this.assertAgentExecutionActive(turn, execution),
          })
        : undefined;
      const cloudSkillCatalog = cloudSkillHome
        ? await cloudSkillHome.loadSkillCatalog("general")
        : undefined;
      execution.assertActive();

      // Without the small class bound there is only one rung, so start (and
      // stay) on the large one rather than pretending to size anything.
      const proposedSize: InstanceSize = !this.env.SANDBOX_SMALL
        ? "large"
        : initialInstanceSize({ prompt: turn.prompt });
      let size = await world.selectContainerSize(proposedSize);
      await this.ctx.storage.put("sandboxSize", size);
      execution.assertActive();
      sandbox = this.sandbox(sandboxId, size, "world");
      let escalated = false;
      let attempt = await this.runAgentAttempt({
        turn,
        execution,
        sandbox,
        size,
        turnStateWorkspaceRestore,
        turnStateWorkspaceRestoreConfirmationRequired:
          resolvedTurnState.workspaceConfirmationRequired,
        turnStateThreadRestore,
        turnStateThreadRestoreConfirmationRequired:
          resolvedTurnState.confirmationRequired,
        history,
        cloudSkillHome,
        cloudSkillCatalog,
        commandTimeoutMs,
        sessionId,
      });
      execution.assertActive();

      // One escalation, one retry. The failed attempt's sandbox is discarded
      // rather than checkpointed — an OOM-killed workspace is not a state
      // worth persisting — so the retry restores the same checkpoint the
      // first attempt did.
      if (
        attempt.oom &&
        size === "small" &&
        (await this.ownsExactTurn(turn)) &&
        !(await this.ctx.storage.get<boolean>("terminal"))
      ) {
        await this.ctx.storage.delete(
          agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!),
        );
        await this.destroySandboxDurably(
          { sandboxId, size, workload: "world" },
          "agent_oom_resize",
        );
        execution.assertActive();
        size = "large";
        escalated = true;
        await world.rememberContainerSize("large");
        await this.ctx.storage.put({
          sandboxId,
          sandboxSize: size,
        });
        execution.assertActive();
        await this.assertAgentExecutionActive(turn, execution);
        // The watchdog budget was spent on the attempt that died; without a
        // fresh one the retry is guaranteed to be cut off mid-run and the
        // escalation buys nothing.
        const watchdogDeadlineAt =
          Date.now() + Math.max(1_000, turn.watchdogMs ?? 15 * 60_000);
        await this.ctx.storage.put(
          AGENT_WATCHDOG_DEADLINE_KEY,
          watchdogDeadlineAt,
        );
        await this.ctx.storage.setAlarm(
          Math.min(watchdogDeadlineAt, Date.now() + AGENT_TURN_HEARTBEAT_MS),
        );
        execution.assertActive();
        log("info", "agent_turn_resized", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          instanceType: INSTANCE_TIERS[size].instanceType,
        });
        await this.event(
          turn,
          "auto",
          "resized",
          {
            reason: "out_of_memory",
            instanceType: INSTANCE_TIERS[size].instanceType,
          },
          false,
          execution.signal,
        ).catch(() => undefined);
        execution.assertActive();
        sandbox = this.sandbox(sandboxId, size, "world");
        attempt = await this.runAgentAttempt({
          turn,
          execution,
          sandbox,
          size,
          turnStateWorkspaceRestore,
          turnStateWorkspaceRestoreConfirmationRequired:
            resolvedTurnState.workspaceConfirmationRequired,
          turnStateThreadRestore,
          turnStateThreadRestoreConfirmationRequired:
            resolvedTurnState.confirmationRequired,
          history,
          cloudSkillHome,
          cloudSkillCatalog,
          commandTimeoutMs,
          sessionId,
        });
        execution.assertActive();
      }
      const { coldContainerStartMs, restoreMs } = attempt;
      let result = attempt.result;
      let builderFallbackUsed = false;
      let interiorCandidate:
        | Awaited<ReturnType<BuildSession["publishInteriorCandidate"]>>
        | undefined;

      // A stale turn (alarm fired, or a successor continuation took over
      // this thread's DO) must not checkpoint over the successor's restore
      // or report on the shared thread.
      if (
        !(await this.ownsExactTurn(turn)) ||
        (await this.ctx.storage.get<boolean>("terminal"))
      ) {
        await this.releaseAgentSessionResources({
          sandboxId,
          size,
          workload: "world",
          sessionId,
          daemonDirectory,
        }).catch(() => undefined);
        log("info", "agent_turn_superseded", {
          turnId: turn.turnId,
          threadId: turn.threadId,
        });
        return;
      }

      if (result.checkpointPolicy === "builder_fallback") {
        try {
          const marker = await this.exactAgentExecutionMarker(turn);
          if (!marker) {
            throw new Error("Agent execution recovery marker was missing.");
          }
          await this.quiesceCurrentAgentSession(turn);
          const fallbackReceipt =
            await this.reconcileAgentCheckpointAfterQuiescence(
              turn,
              marker,
              result.error ??
                "The agent stopped unexpectedly after making workspace changes.",
              result.builderFallback,
            );
          const recoveredSuspension =
            await this.recoverObservedBrowserSuspension(
              turn,
              fallbackReceipt,
              execution.signal,
            );
          if (recoveredSuspension) {
            // The executor process/finalizer was lost after the Gateway wait,
            // checkpoint, and transcript all committed. Reconstruct only the
            // secret-free result; the canonical transcript supplies the outer
            // Code id and the durable Gateway observation supplies the rest.
            result = {
              outcome: "suspended",
              ok: false,
              finalText: "",
              usage: result.usage ?? {},
              checkpointMs: result.checkpointMs ?? 0,
              turnStateCheckpoint: fallbackReceipt,
              suspension: recoveredSuspension,
            };
            builderFallbackUsed = false;
          } else {
            builderFallbackUsed = true;
            result = {
              ...result,
              checkpointPolicy: undefined,
              turnStateCheckpoint: fallbackReceipt,
            };
          }
        } catch (error) {
          // The journal and sandbox disk are retained. Alarm replay resumes
          // the same operation/request ids; it never manufactures a second
          // archive after a lost checkpoint/transcript/publication response.
          log("error", "agent_builder_fallback_deferred", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            message: errorMessage(error),
          });
          await this.setExactTurnAlarm(turn, Date.now() + 1_000);
          return;
        }
      }

      if (result.ok) {
        const interior = await this.publishRequestedInteriorCandidate({
          turn,
          sandbox,
          commandTimeoutMs,
          turnExecution: execution,
        });
        if (interior.outcome === "abandoned") {
          await this.releaseAgentSessionResources({
            sandboxId,
            size,
            workload: "world",
            sessionId,
            daemonDirectory,
          }).catch(() => undefined);
          return;
        }
        if (interior.outcome === "published") {
          interiorCandidate = interior.candidate;
        }
        if (interior.outcome === "failed") {
          result = { ...result, ok: false, error: interior.error };
        }
      }

      // The executor's broker receipt proves that the deterministic workspace
      // (and optional native) archive pair committed before the transcript was
      // accepted. There is deliberately no second SDK backup here: that would
      // reintroduce random-address orphan bytes and split the atomic boundary.
      const checkpointMs =
        Number.isSafeInteger(result.checkpointMs) && result.checkpointMs! >= 0
          ? result.checkpointMs!
          : 0;
      let checkpointError: string | undefined;
      const checkpoint = result.turnStateCheckpoint;
      if (result.checkpointPolicy !== "preserve_prior") {
        if (!validTurnStateCheckpointReceipt(checkpoint)) {
          checkpointError =
            "The executor did not return a valid turn-state receipt.";
        } else {
          try {
            await this.assertAgentExecutionActive(turn, execution);
            const canonicalRows = this.fetchCanonicalAgentHistory(turn, {
              excludeCurrentTurn: false,
              signal: execution.signal,
            });
            execution.assertActive();
            if (
              (await nativeHistoryCursorFromRows(canonicalRows)) !==
              checkpoint.historyCursor
            ) {
              throw new Error(
                "The checkpoint transcript was not canonical in cloud history.",
              );
            }
            await this.publishAgentTurnWorkspace(
              turn,
              checkpoint.historyCursor,
              checkpoint.operationId,
            );
            execution.assertActive();
            const published = await this.resolveAgentTurnState(
              turn,
              checkpoint.historyCursor,
              { allowMissingNative: builderFallbackUsed },
            );
            if (
              published.workspacePublication ||
              !published.workspace ||
              !published.restore ||
              published.workspace.operationId !== checkpoint.operationId ||
              published.workspace.manifestId !== checkpoint.manifestId ||
              published.restore.workspace.manifestId !== checkpoint.manifestId
            ) {
              throw new Error(
                "The canonical turn state did not match its checkpoint receipt.",
              );
            }
          } catch (error) {
            // Transcript acceptance already makes this cursor canonical. A
            // response lost during promotion is restart-safe: the next turn's
            // registry-first resolve performs the same exact promotion. Keep
            // the committed receipt visible, but do not manufacture a second
            // archive or fall back to a legacy pointer.
            if (
              error instanceof TurnStateOwnerCallError &&
              error.status >= 500
            ) {
              log("error", "turn_state_promotion_deferred", {
                turnId: turn.turnId,
                message: errorMessage(error),
              });
              // Do not terminalize or destroy the only sandbox while the
              // canonical transcript points at an unpublished workspace.
              // The durable checkpoint operation + execution marker let the
              // alarm replay this exact publication after response loss.
              throw error;
            } else {
              checkpointError = errorMessage(error);
            }
          }
        }
      }
      if (
        !(await this.ownsExactTurn(turn)) ||
        (await this.ctx.storage.get<boolean>("terminal"))
      ) {
        await this.releaseAgentSessionResources({
          sandboxId,
          size,
          workload: "world",
          sessionId,
          daemonDirectory,
        }).catch(() => undefined);
        return;
      }
      if (checkpointError) {
        log("error", "agent_turn_state_invalid", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          message: checkpointError,
        });
        await this.event(
          turn,
          "auto",
          "checkpoint_failed",
          {
            message:
              "Stella could not validate the durable workspace receipt for this turn.",
          },
          false,
          execution.signal,
        ).catch(() => undefined);
        execution.assertActive();
        if (result.ok) {
          result = {
            ...result,
            ok: false,
            error:
              "Stella could not validate the durable workspace receipt for this turn. Please retry before continuing this agent.",
            finalText:
              `${result.finalText ?? ""}\n\nHeads up: Stella could not validate the durable workspace receipt for this turn. Please retry before continuing this agent.`.trim(),
          };
        } else if (result.outcome === "suspended") {
          // A human wait is resumable only from the exact checkpoint whose
          // transcript ends at the browser tool call. Never expose a takeover
          // for a turn whose continuation receipt cannot be reconstructed.
          result = {
            outcome: "completed",
            ok: false,
            error:
              "Stella couldn't hand this sign-in over to you safely. Please try again.",
          };
        }
      }

      if (
        result.outcome === "suspended" &&
        result.suspension &&
        validTurnStateCheckpointReceipt(result.turnStateCheckpoint)
      ) {
        const verifiedSuspension = await this.recoverObservedBrowserSuspension(
          turn,
          result.turnStateCheckpoint,
          execution.signal,
        );
        if (
          !verifiedSuspension ||
          cloudBrowserSuspensionMarker(verifiedSuspension) !==
            cloudBrowserSuspensionMarker(result.suspension)
        ) {
          log("error", "browser_suspension_checkpoint_mismatch", {
            turnId: turn.turnId,
            threadId: turn.threadId,
          });
          result = {
            outcome: "completed",
            ok: false,
            error:
              "Stella couldn't hand this sign-in over to you safely. Please try again.",
            turnStateCheckpoint: result.turnStateCheckpoint,
          };
        } else {
          result = { ...result, suspension: verifiedSuspension };
        }
      }

      const wallClockMs = Math.round(performance.now() - requestStarted);
      if (result.outcome === "suspended" && result.suspension) {
        const pendingBrowserSuspension: PendingBrowserSuspension = {
          schemaVersion: 1,
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration!,
          suspension: result.suspension,
          payload: {
            suspension: result.suspension,
            usage: result.usage,
            coldContainerStartMs,
            restoreMs,
            checkpointMs,
            wallClockMs,
            instanceType: INSTANCE_TIERS[size].instanceType,
          },
          createdAt: Date.now(),
        };
        // Stop/timeout and suspension are competing decisions. Commit the
        // secret-free wait descriptor only while no terminal path has won,
        // and remove the execution marker in the same transaction so alarm
        // recovery cannot mistake this intentionally exited executor for a
        // crashed one.
        const retained = await this.retainPendingBrowserSuspension(
          turn,
          pendingBrowserSuspension,
        );
        await this.releaseAgentSessionResources({
          sandboxId,
          size,
          workload: "world",
          sessionId,
          daemonDirectory,
        }).catch(() => undefined);
        if (!retained) return;

        const delivered = await this.deliverBrowserSuspension(
          turn,
          pendingBrowserSuspension,
        );
        if (delivered && (await this.ownsExactTurn(turn))) {
          if (await this.settleAgentTransientBackup(turn)) {
            await this.deleteTurnStoragePreservingExactCancellations(
              turn,
              true,
            );
          } else {
            await this.setExactTurnAlarm(turn, Date.now() + 30_000);
          }
        }
        log("info", "agent_turn_suspended_for_browser_handoff", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          interactionId: result.suspension.interactionId,
          wallClockMs,
        });
        emitCloudTurnTelemetry(this.ctx, this.env, {
          type: "cloud.turn",
          workload: "agent",
          phase: "suspended",
          wallClockMs,
          coldContainerStartMs,
          restoreMs,
          checkpointMs,
          ...(typeof result.usage?.inputTokens === "number"
            ? { inputTokens: result.usage.inputTokens }
            : {}),
          ...(typeof result.usage?.outputTokens === "number"
            ? { outputTokens: result.usage.outputTokens }
            : {}),
          ...(typeof result.usage?.llmCalls === "number"
            ? { llmCalls: result.usage.llmCalls }
            : {}),
          instanceType: INSTANCE_TIERS[size].instanceType,
        });
        return;
      }

      let pending: PendingTerminal;
      if (result.ok) {
        pending = {
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration!,
          kind: "completed",
          payload: {
            finalText: result.finalText ?? "",
            usage: result.usage,
            coldContainerStartMs,
            restoreMs,
            checkpointMs,
            wallClockMs,
            instanceType: INSTANCE_TIERS[size].instanceType,
            ...(interiorCandidate ? { interiorCandidate } : {}),
          },
        };
      } else {
        let message = result.error ?? "The agent failed.";
        if (checkpointError) {
          message = `${message} Do not continue this agent until the turn is retried.`;
        }
        pending = {
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration!,
          kind: "failed",
          payload: { message },
          threadError: message,
        };
      }
      const delivered = await this.deliverTerminal(turn, pending);
      await this.releaseAgentSessionResources({
        sandboxId,
        size,
        workload: "world",
        sessionId,
        daemonDirectory,
      }).catch(() => undefined);
      // Storage is the redelivery's only memory: clear it once the terminal
      // state is in Convex, and leave it — with the alarm deliverTerminal
      // re-armed — when it is not.
      if (delivered && (await this.ownsExactTurn(turn))) {
        if (await this.settleAgentTransientBackup(turn)) {
          await this.deleteTurnStoragePreservingExactCancellations(turn, true);
        } else {
          await this.setExactTurnAlarm(turn, Date.now() + 30_000);
        }
      }
      log("info", "agent_turn_finished", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        ok: result.ok,
        wallClockMs,
      });
      emitCloudTurnTelemetry(this.ctx, this.env, {
        type: "cloud.turn",
        workload: "agent",
        phase: result.ok ? "completed" : "failed",
        wallClockMs,
        coldContainerStartMs,
        restoreMs,
        checkpointMs,
        ...(typeof result.usage?.inputTokens === "number"
          ? { inputTokens: result.usage.inputTokens }
          : {}),
        ...(typeof result.usage?.outputTokens === "number"
          ? { outputTokens: result.usage.outputTokens }
          : {}),
        ...(typeof result.usage?.llmCalls === "number"
          ? { llmCalls: result.usage.llmCalls }
          : {}),
        instanceType: INSTANCE_TIERS[size].instanceType,
      });
    } catch (error) {
      const message = errorMessage(error);
      if (this.builderFallbackRecoveries.has(turn.turnId)) {
        // Alarm recovery owns the exact kill/join/archive sequence. Destroying
        // the sandbox here would discard the only surviving workspace bytes
        // between quiescence and the deterministic Builder checkpoint.
        log("info", "agent_turn_yielded_to_builder_fallback", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          message,
        });
        return;
      }
      let executionMarker: AgentExecutionMarker | undefined;
      try {
        executionMarker = await this.exactAgentExecutionMarker(turn);
      } catch (markerError) {
        log("error", "agent_recovery_marker_invalid", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          message: errorMessage(markerError),
        });
        await this.setExactTurnAlarm(turn, Date.now() + 30_000);
        return;
      }
      if (
        executionMarker &&
        !(
          error instanceof CapturedSessionAbandonedError &&
          error.disposition === "compute_released"
        ) &&
        !(error instanceof AgentTurnAuthorityLostError) &&
        !(error instanceof OwnerPurgeFenceError) &&
        (await this.ownsExactTurn(turn)) &&
        !(await this.ctx.storage.get<boolean>("terminal"))
      ) {
        // A model-controlled process was admitted. Retain the disk and let
        // the alarm resume the durable fallback journal after this promise
        // has fully unwound; snapshotting from this catch could race a late
        // descendant or a platform exec promise that has not joined yet.
        log("error", "agent_turn_recovery_scheduled", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          message,
        });
        await this.mutateExactTurn(turn, async (txn) => {
          await txn.put(
            AGENT_RECOVERY_PENDING_KEY,
            agentRecoveryIdentity(turn),
          );
          await txn.setAlarm(Date.now() + 1_000);
        });
        return;
      }
      if (await this.ctx.storage.get<boolean>("terminal")) return;
      try {
        await this.terminateCurrentAgentSession(turn);
      } catch (releaseError) {
        log("error", "agent_session_release_deferred", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          message: errorMessage(releaseError),
        });
        await this.claimTerminalDecision(
          turn,
          {
            turnId: turn.turnId,
            attemptGeneration: turn.attemptGeneration!,
            kind: "failed",
            payload: {
              message: "The agent hit a problem and stopped. Try again.",
            },
            threadError: "The agent hit a problem and stopped. Try again.",
            terminateSandbox: true,
          },
          Date.now() + 30_000,
        );
        return;
      }
      const failureCode = classifyAgentFailureDiagnostic(message);
      log("error", "agent_turn_failed", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message,
        failureCode,
      });
      if (error instanceof AgentTurnAuthorityLostError) {
        // Rotation/reset may have admitted another physical executor under the
        // same logical turn id. Never project this stale isolate's unwind as a
        // terminal outcome or delete shared DO state; its sandbox is already
        // gone and the authoritative attempt owns recovery.
        log("info", "agent_turn_authority_lost", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          attemptGeneration: turn.attemptGeneration,
        });
        return;
      }
      // Fencing: a stale unwind (successor accepted on this thread's DO, or
      // the alarm already owns terminal delivery) must not fail the thread,
      // kill the successor's watchdog, or wipe shared storage.
      if (!(await this.ownsExactTurn(turn))) return;
      if (await this.ctx.storage.get<boolean>("terminal")) return;
      if (error instanceof OwnerPurgeFenceError) {
        try {
          await this.cleanupOwnerPurgedTurnStorage(turn);
        } catch (cleanupError) {
          log("error", "owner_purge_agent_cleanup_failed", {
            turnId: turn.turnId,
            message: errorMessage(cleanupError),
          });
        }
        return;
      }
      // Raw infrastructure errors stay in logs; only messages written for a
      // person reach the thread and the event.
      const friendly =
        error instanceof AgentTurnError
          ? error.userMessage
          : devAcceptanceProbesEnabled(this.env)
            ? `The agent hit a problem and stopped. Try again. [diagnostic: turn.${failureCode}]`
            : "The agent hit a problem and stopped. Try again.";
      const delivered = await this.deliverTerminal(turn, {
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration!,
        kind: "failed",
        payload: { message: friendly },
        threadError: friendly,
      });
      // Undelivered leaves storage and the re-armed alarm in place, so the
      // turn cannot stay "running" forever.
      if (delivered && (await this.ownsExactTurn(turn))) {
        if (await this.settleAgentTransientBackup(turn)) {
          await this.deleteTurnStoragePreservingExactCancellations(turn, true);
        } else {
          await this.setExactTurnAlarm(turn, Date.now() + 30_000);
        }
      }
    } finally {
      await this.unregisterTurn(turn);
    }
  }

  /**
   * Bring a container up with this owner's world on disk: create the command
   * session, restore the canonical archives (or seed a first world), verify
   * the packaged renderer still matches, and confirm the restore with the
   * owner fence.
   *
   * Shared by the eager container path and the compute ladder's lazy attach,
   * which is the whole point: a mid-turn attach has to land on exactly the
   * disk an eager boot would have produced, or the two placements would
   * disagree about what a checkpoint means. It deliberately does not emit
   * `sandbox_ready` — the eager path reports a boot, the ladder reports an
   * attach, and the payloads differ.
   */
  private async attachAgentWorld(args: {
    turn: TurnRequest;
    execution: TurnExecutionContext;
    sandbox: ReturnType<BuildSession["sandbox"]>;
    size: InstanceSize;
    turnStateWorkspaceRestore?: TurnStateWorkspaceHead;
    turnStateWorkspaceRestoreConfirmationRequired: boolean;
    turnStateThreadRestore?: TurnStateCandidate;
    turnStateThreadRestoreConfirmationRequired: boolean;
    history: AgentHistoryRow[];
    commandTimeoutMs: number;
    sessionId: string;
  }): Promise<{
    session: ExecutionSession;
    coldContainerStartMs: number;
    restoreMs: number;
  }> {
    const { turn, execution: turnExecution, sandbox } = args;
    const coldStarted = performance.now();
    await this.assertAgentExecutionActive(turn, turnExecution);
    const session = await sandbox.createSession({
      id: args.sessionId,
      cwd: "/opt/stella",
      commandTimeoutMs: args.commandTimeoutMs,
      env: executorSessionEnvironment(),
    });
    turnExecution.assertActive();
    const coldContainerStartMs = Math.round(performance.now() - coldStarted);

    // Sandbox disk is a projection of the world object, never its owner.
    let restoreMs = 0;
    await normalizeToolWorkspaceRoot(session, WORLD_ROOT);
    turnExecution.assertActive();
    const restoreStarted = performance.now();
    const name = await worldName(turn.ownerId);
    const world = this.env.WORLDS.getByName(name);
    const head = await world.head();
    const capability = await issueWorldCapability({
      secret: this.env.BUILDER_SERVICE_SECRET,
      worldName: name,
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      now: Date.now(),
      ttlMs: Math.max(1, Math.min(30 * 60_000, args.commandTimeoutMs)),
    });
    const origin = this.env.CLOUD_BUILDER_PUBLIC_URL.replace(/\/+$/u, "");
    const exportUrl = `${origin}/internal/worlds/${name}/export?manifest=${encodeURIComponent(head.manifestId)}`;
    const materialized = await session.exec(
      worldMaterializationCommand({
        worldRoot: WORLD_ROOT,
        manifestId: head.manifestId,
        exportUrl,
        capability,
      }),
      { origin: "internal", timeout: args.commandTimeoutMs },
    );
    if (!materialized.success)
      throw new AgentTurnError("Stella could not materialize this world.");
    turnExecution.assertActive();
    restoreMs = Math.round(performance.now() - restoreStarted);

    // `world/stella` is a real, buildable renderer checkout from the immutable
    // image, never an empty directory the model has to invent. Once it exists
    // its recorded seed has to still match the image, or a self-update would
    // be built on top of a renderer Stella no longer ships.
    const stellaPresent = await stellaToolWorkspaceExists(session);
    turnExecution.assertActive();
    if (!stellaPresent) {
      await seedFirstStellaToolWorkspace(session);
      turnExecution.assertActive();
    } else {
      const readJson = async (filePath: string) => {
        const read = await session.readFile(filePath, { encoding: "base64" });
        turnExecution.assertActive();
        return JSON.parse(atob(read.content)) as Record<string, unknown>;
      };
      const [interiorState, imageSeed] = await Promise.all([
        readJson(`${WORLD_STELLA_ROOT}/.stella/interior-source.json`),
        readJson("/opt/stella/interior-seed.json"),
      ]);
      const interiorSeedRevision =
        typeof interiorState.upstreamSeedRevision === "string"
          ? interiorState.upstreamSeedRevision
          : interiorState.buildId === undefined &&
              typeof interiorState.sourceRevision === "string"
            ? interiorState.sourceRevision
            : null;
      if (
        !interiorSeedRevision ||
        typeof imageSeed.sourceRevision !== "string" ||
        interiorSeedRevision !== imageSeed.sourceRevision
      ) {
        throw new AgentTurnError(
          "Stella's packaged renderer changed since this world was created. Its existing customizations need an upstream migration before another self-update can be built.",
        );
      }
    }
    if (args.turnStateThreadRestore?.native) {
      const nativeRestoreStarted = performance.now();
      turnExecution.assertActive();
      await restoreTurnStateArchive({
        session,
        bucket: this.env.BACKUP_BUCKET,
        archive: args.turnStateThreadRestore.native,
        target: { kind: "native" },
      });
      turnExecution.assertActive();
      restoreMs += Math.round(performance.now() - nativeRestoreStarted);
    }
    turnExecution.assertActive();
    if (args.turnStateWorkspaceRestore || args.turnStateThreadRestore) {
      await this.confirmAgentTurnStateRestore(
        turn,
        await nativeHistoryCursorFromRows(args.history),
        args.turnStateWorkspaceRestore,
        args.turnStateWorkspaceRestoreConfirmationRequired,
        args.turnStateThreadRestore,
        args.turnStateThreadRestoreConfirmationRequired,
      );
      turnExecution.assertActive();
    }
    return { session, coldContainerStartMs, restoreMs };
  }

  /**
   * One sandbox attempt at an agent turn: boot, restore the workspace, hand
   * the executor its input, run it. Kept separate from {@link runAgentTurn}
   * so an OOM escalation can repeat it on a bigger instance without
   * duplicating any of the turn's lifecycle or fencing.
   */
  private async runAgentAttempt(args: {
    turn: TurnRequest;
    execution: TurnExecutionContext;
    sandbox: ReturnType<BuildSession["sandbox"]>;
    size: InstanceSize;
    /** Latest canonical owner world manifest, shared across all threads. */
    turnStateWorkspaceRestore?: TurnStateWorkspaceHead;
    turnStateWorkspaceRestoreConfirmationRequired: boolean;
    /** Canonical transcript/native state for this exact thread only. */
    turnStateThreadRestore?: TurnStateCandidate;
    turnStateThreadRestoreConfirmationRequired: boolean;
    history: AgentHistoryRow[];
    cloudSkillHome?: CloudHomeStore;
    cloudSkillCatalog?: CloudSkillCatalogSnapshot;
    commandTimeoutMs: number;
    sessionId: string;
  }): Promise<{
    result: AgentExecutorResult;
    oom: boolean;
    coldContainerStartMs: number;
    restoreMs: number;
  }> {
    const { turn, execution: turnExecution, sandbox } = args;
    const world = await this.attachAgentWorld(args);
    const { session, coldContainerStartMs, restoreMs } = world;
    await this.event(
      turn,
      "auto",
      "sandbox_ready",
      {
        coldContainerStartMs,
        restoreMs,
        restored: Boolean(args.turnStateWorkspaceRestore),
        instanceType: INSTANCE_TIERS[args.size].instanceType,
      },
      false,
      turnExecution.signal,
    );
    let cloudSkills:
      | Awaited<ReturnType<typeof materializeCloudSkillSnapshot>>
      | undefined = undefined;
    if (args.cloudSkillHome && args.cloudSkillCatalog) {
      turnExecution.assertActive();
      cloudSkills = await materializeCloudSkillSnapshot({
        home: args.cloudSkillHome,
        snapshot: args.cloudSkillCatalog,
        session,
        assertActive: () => turnExecution.assertActive(),
      });
      turnExecution.assertActive();
    }

    // The native CLI's resumable session lives in the root-only backup mount.
    // Its full-tree attestation is bound to this builder-derived owner/thread
    // key, consumed before any model or tool process starts.
    const nativeStateIntegrityKey = await nativeStateIntegrityKeyFor(
      this.env,
      turn,
    );
    turnExecution.assertActive();

    if (!turn.turnBrokerRoute) {
      throw new AgentTurnAuthorityLostError();
    }
    const brokerIdentity = {
      sessionId: turn.turnBrokerRoute.sessionId,
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
    };
    const issuedBroker = await issueTurnBrokerCredential({
      identity: brokerIdentity,
      endpoint: turn.turnBrokerRoute.endpoint,
      now: Date.now(),
      ttlMs: Math.max(
        1,
        Math.min(TURN_BROKER_MAX_TTL_MS, args.commandTimeoutMs),
      ),
    });
    const brokerRecordKey = turnBrokerStorageKey(brokerIdentity);
    await this.ctx.storage.put(brokerRecordKey, issuedBroker.record);
    turnExecution.assertActive();
    const brokerCredentialsPath = turnBrokerCredentialsPath();
    let credentialsPath: string | undefined;
    let projectInput: Record<string, unknown> | undefined;
    let execution: Execution | undefined;
    let capturedExecutionError: unknown;
    let recordedExecutorResultText: string | undefined;
    let recordedResultProcessQuiesced = false;
    try {
      await session.writeFile(
        brokerCredentialsPath,
        JSON.stringify(issuedBroker.handoff),
      );
      const protectedBrokerHandoff = await session.exec(
        `chmod 600 ${brokerCredentialsPath}`,
      );
      if (!protectedBrokerHandoff.success) {
        throw new Error("Turn broker handoff could not be protected.");
      }
      turnExecution.assertActive();

      // The sandbox reaches the model gateway directly with a turn capability
      // minted here. Minting happens after the broker handoff is protected
      // and right before the executor is admitted, so the capability's
      // lifetime tracks the attempt as closely as possible.
      if (!turn.execution) throw new AgentTurnAuthorityLostError();
      const modelGateway = await mintAgentTurnModelGateway(
        this.env,
        turn,
        turn.execution,
      );
      turnExecution.assertActive();

      // turn-input.json sits above the world root on purpose: the
      // checkpoint only covers the root, so nothing here reaches a durable
      // backup. The executor unlinks it before any model or tool process
      // exists, so the capability never becomes readable by agent shells.
      turnExecution.assertActive();
      await session.writeFile(
        "/workspace/turn-input.json",
        JSON.stringify({
          kind: "agent",
          ownerId: turn.ownerId,
          ownerGeneration: turn.ownerGeneration,
          conversationId: turn.conversationId,
          threadId: turn.threadId,
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration,
          prompt: turn.prompt,
          workspaceRestored: Boolean(args.turnStateWorkspaceRestore),
          nativeStateIntegrityKey,
          turnBroker: { credentialsPath: brokerCredentialsPath },
          world: {
            origin: this.env.CLOUD_BUILDER_PUBLIC_URL.replace(/\/+$/u, ""),
            name: await worldName(turn.ownerId),
            capability: await issueWorldCapability({
              secret: this.env.BUILDER_SERVICE_SECRET,
              worldName: await worldName(turn.ownerId),
              turnId: turn.turnId,
              attemptGeneration: turn.attemptGeneration!,
              now: Date.now(),
              ttlMs: Math.max(1, Math.min(30 * 60_000, args.commandTimeoutMs)),
            }),
          },
          modelGateway: {
            origin: modelGateway.origin,
            capability: modelGateway.capability,
          },
          history: args.history,
          ...(turn.browserResume ? { browserResume: turn.browserResume } : {}),
          ...(cloudSkills ? { skills: cloudSkills } : {}),
          ...(turn.execution ? { execution: turn.execution } : {}),
        }),
      );
      turnExecution.assertActive();
      // Remove any result left by a lost predecessor before this exact
      // executor is admitted. The file sits in root-owned /workspace, outside
      // every checkpointed/model-writable workspace root.
      await session
        .deleteFile(CLOUD_AGENT_TURN_RESULT_PATH)
        .catch(() => undefined);
      turnExecution.assertActive();
      const markerKey = agentExecutionMarkerKey(
        turn.turnId,
        turn.attemptGeneration!,
      );
      turnExecution.assertActive();
      log("info", "agent_executor_admission_started", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        attemptGeneration: turn.attemptGeneration,
      });
      const executorProcessId = sessionName(
        `agent-executor-${turn.turnId}-${turn.attemptGeneration}`,
      );
      const resultPollCancellation = createTurnRetryCancellation();
      const captureOutcome = capturedSessionExec(
        sandbox,
        ["bun", "packages/executor-cloud/src/cli.ts", "--agent-turn"],
        args.commandTimeoutMs,
        {
          cwd: "/opt/stella",
          env: executorSessionEnvironment(),
          // The root-only result file is authoritative. Bound the optional
          // stdout transfer well below the durable execution-marker alarm so
          // this invocation can recover the file before alarm fallback runs.
          resultTimeoutMs: 10_000,
          processId: executorProcessId,
          signal: turnExecution.signal,
          onAbandon: async ({ phase, processId }) => {
            if (phase === "process_unsettled") {
              try {
                // An exact tree-aware kill is sufficient to stop every
                // model-controlled writer. Keep the session for the durable
                // Builder fallback, which performs its own final session
                // teardown before reading the workspace.
                await withInfrastructureDeadline(
                  sandbox.killProcess(processId, "SIGKILL"),
                  35_000,
                  "Captured session process kill did not settle.",
                );
                return "session_quiesced" as const;
              } catch {
                // A kill ambiguity must not reach Builder fallback. Fence a
                // generic terminal result before rotating the sandbox lifetime;
                // alarm replay will only retry teardown/delivery, never archive
                // a newly recreated empty container.
              }
            }
            const teardownPending: PendingTerminal = {
              turnId: turn.turnId,
              attemptGeneration: turn.attemptGeneration!,
              kind: "failed",
              payload: {
                message: "The agent hit a problem and stopped. Try again.",
              },
              threadError: "The agent hit a problem and stopped. Try again.",
              terminateSandbox: true,
            };
            await this.claimTerminalDecision(
              turn,
              teardownPending,
              Date.now() + 1_000,
            );
            await this.terminateCurrentAgentSession(turn);
            await this.ctx.storage
              .transaction(async (transaction) => {
                if (
                  exactTurnIdentityMatches(
                    await transaction.get<TurnRequest>("turn"),
                    turn,
                  )
                ) {
                  await transaction.delete(markerKey);
                }
              })
              .catch((error) => {
                log("error", "agent_execution_marker_cleanup_deferred", {
                  turnId: turn.turnId,
                  threadId: turn.threadId,
                  message: errorMessage(error),
                });
              });
            return "compute_released" as const;
          },
          onStarted: async () => {
            // The durable marker means the trusted executor that can spawn
            // model-controlled children exists, not merely that its sandbox
            // and turn input are ready. This keeps cancellation and fallback
            // recovery from resolving a process RPC for a command that never
            // crossed the sessionless process boundary.
            turnExecution.assertActive();
            const marker = await this.ctx.storage.transaction(
              async (transaction): Promise<AgentExecutionMarker> => {
                const [current, currentSandboxId, currentSize] =
                  await Promise.all([
                    transaction.get<TurnRequest>("turn"),
                    transaction.get<string>("sandboxId"),
                    transaction.get<InstanceSize>("sandboxSize"),
                  ]);
                if (
                  !exactTurnIdentityMatches(current, turn) ||
                  !currentSandboxId ||
                  currentSize !== args.size
                ) {
                  throw new AgentTurnAuthorityLostError();
                }
                const value: AgentExecutionMarker = {
                  schemaVersion: 1,
                  turnId: turn.turnId,
                  attemptGeneration: turn.attemptGeneration!,
                  sandboxId: currentSandboxId,
                  size: args.size,
                  startedAt: Date.now(),
                };
                await transaction.put(markerKey, value);
                return value;
              },
            );
            if (marker.turnId !== turn.turnId) {
              throw new AgentTurnAuthorityLostError();
            }
            turnExecution.assertActive();
            log("info", "agent_executor_process_started", {
              turnId: turn.turnId,
              threadId: turn.threadId,
              attemptGeneration: turn.attemptGeneration,
            });
          },
        },
      ).then(
        (capturedExecution) =>
          ({
            kind: "execution" as const,
            execution: capturedExecution,
          }) as const,
        (error: unknown) =>
          ({ kind: "execution_error" as const, error }) as const,
      );
      const resultFileOutcome = waitForCloudAgentTurnResultText(
        session,
        [turnExecution.signal],
        resultPollCancellation,
      ).then(
        (resultText) => ({ kind: "result_file" as const, resultText }) as const,
        (error: unknown) =>
          ({ kind: "result_file_error" as const, error }) as const,
      );
      const firstOutcome = await Promise.race([
        captureOutcome,
        resultFileOutcome,
      ]);
      resultPollCancellation.abort(
        new Error("Agent process observation already settled."),
      );
      if (firstOutcome.kind === "execution") {
        execution = firstOutcome.execution;
        recordedResultProcessQuiesced = true;
      } else if (firstOutcome.kind === "execution_error") {
        capturedExecutionError = firstOutcome.error;
        recordedResultProcessQuiesced = !(
          firstOutcome.error instanceof CapturedSessionAbandonedError
        );
      } else if (firstOutcome.kind === "result_file_error") {
        throw firstOutcome.error;
      } else {
        recordedExecutorResultText = firstOutcome.resultText;
        const captureAfterFile = await Promise.race([
          captureOutcome,
          runToolEffect(
            Effect.sleep(1_000).pipe(
              Effect.as({ kind: "capture_pending" as const }),
            ),
          ),
        ]);
        if (captureAfterFile.kind === "execution") {
          execution = captureAfterFile.execution;
          recordedResultProcessQuiesced = true;
        } else if (captureAfterFile.kind === "execution_error") {
          capturedExecutionError = captureAfterFile.error;
          recordedResultProcessQuiesced =
            !(
              captureAfterFile.error instanceof CapturedSessionAbandonedError
            ) || captureAfterFile.error.disposition === "session_quiesced";
        } else {
          // The executor writes this file only after its checkpoint and
          // transcript work has completed. If Cloudflare's process registry is
          // still waiting, stop that exact process tree before accepting the
          // root-only result.
          await withInfrastructureDeadline(
            sandbox.killProcess(executorProcessId, "SIGKILL"),
            10_000,
            "Completed agent executor could not be quiesced.",
          );
          recordedResultProcessQuiesced = true;
        }
      }
      turnExecution.assertActive();
    } catch (error) {
      capturedExecutionError = error;
    } finally {
      recordedExecutorResultText ??=
        await readCloudAgentTurnResultText(session);
      await session
        .deleteFile(CLOUD_AGENT_TURN_RESULT_PATH)
        .catch(() => undefined);
      // The executor unlinks this the moment it has read it; this is the
      // backstop for an executor that died before it got that far, so the
      // token cannot outlive the process that needed it.
      if (credentialsPath) {
        await session.deleteFile(credentialsPath).catch(() => undefined);
      }
      await session.deleteFile(brokerCredentialsPath).catch(() => undefined);
      await this.ctx.storage.transaction(async (txn) => {
        const current = await txn.get<TurnBrokerRecord>(brokerRecordKey);
        if (
          current?.capabilityHash === issuedBroker.record.capabilityHash &&
          current.state === "active"
        ) {
          await txn.put(
            brokerRecordKey,
            revokeTurnBrokerCredential(current, Date.now()),
          );
        }
      });
    }
    let recordedExecutorResult: AgentExecutorResult | null = null;
    if (recordedExecutorResultText) {
      try {
        recordedExecutorResult = parseAgentExecutorResult(
          JSON.parse(recordedExecutorResultText) as unknown,
        );
      } catch {
        recordedExecutorResult = null;
      }
    }
    if (
      recordedExecutorResult &&
      recordedResultProcessQuiesced &&
      !turnExecution.signal.aborted
    ) {
      log("info", "agent_executor_result_file_recovered", {
        turnId: turn.turnId,
        threadId: turn.threadId,
      });
      return {
        result: recordedExecutorResult,
        oom: false,
        coldContainerStartMs,
        restoreMs,
      };
    }
    if (capturedExecutionError) {
      throw capturedExecutionError;
    }
    if (!execution) {
      throw new Error("Captured agent executor returned no process result.");
    }
    if (execution.success) {
      try {
        const parsed =
          recordedExecutorResult ??
          parseAgentExecutorResult(
            JSON.parse(
              execution.stdout.trim().split("\n").at(-1) ?? "{}",
            ) as unknown,
          );
        if (!parsed) throw new Error("invalid agent executor result");
        return {
          result: parsed,
          oom: false,
          coldContainerStartMs,
          restoreMs,
        };
      } catch {
        return {
          result: {
            ok: false,
            error: "The agent's report was unreadable.",
            checkpointPolicy: "builder_fallback",
          },
          oom: false,
          coldContainerStartMs,
          restoreMs,
        };
      }
    }
    const oom = isOutOfMemoryFailure({
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
    });
    const failureCode = classifyAgentFailureDiagnostic(execution.stderr);
    log("error", "agent_executor_failed", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      oom,
      instanceType: INSTANCE_TIERS[args.size].instanceType,
      failureCode,
    });
    return {
      result: {
        ok: false,
        error: oom
          ? "The agent ran out of memory and stopped. Try again with a smaller slice of the work."
          : devAcceptanceProbesEnabled(this.env)
            ? `The agent hit a problem and stopped. Try again. [diagnostic: executor.${failureCode}]`
            : "The agent hit a problem and stopped. Try again.",
        checkpointPolicy: oom ? "preserve_prior" : "builder_fallback",
      },
      oom,
      coldContainerStartMs,
      restoreMs,
    };
  }

  private async runTurn(
    turn: TurnRequest,
    turnExecution: TurnExecutionContext,
  ): Promise<Response> {
    const commandTimeoutMs = Number(this.env.TURN_TIMEOUT_MS);
    const firstSandboxId = await exactTurnSandboxId("app", turn);
    const first = this.sandbox(firstSandboxId);
    turnExecution.assertActive();
    const claim: AppTurnAdmissionClaim = {
      schemaVersion: 1,
      claimId: crypto.randomUUID(),
      turnId: turn.turnId,
      ownerGeneration: turn.ownerGeneration,
      createdAt: Date.now(),
    };
    const staged = await this.ctx.storage.transaction(async (txn) => {
      const [currentTurn, terminal] = await Promise.all([
        txn.get<TurnRequest>("turn"),
        txn.get<boolean>("terminal"),
      ]);
      if (
        (currentTurn && !exactTurnIdentityMatches(currentTurn, turn)) ||
        (currentTurn && terminal)
      ) {
        return false;
      }
      await txn.put({
        [APP_TURN_ADMISSION_CLAIM_KEY]: claim,
        turn,
        turnId: turn.turnId,
        terminal: false,
      });
      return true;
    });
    if (!staged) {
      throw new AppTurnAuthorityLostError();
    }

    // Cross-DO and Convex I/O deliberately run outside any concurrency gate.
    // Stop or a successor may land while either is in flight; the exact claim
    // below is the only thing that can authorize the container side effect.
    let committed = false;
    try {
      await this.assertTurnWritable(turn);
      this.assertAppTurnIdentity(turn);
      turnExecution.assertActive();
      committed = await this.ctx.storage.transaction(async (txn) => {
        const [currentTurn, currentClaim, terminal] = await Promise.all([
          txn.get<TurnRequest>("turn"),
          txn.get<AppTurnAdmissionClaim>(APP_TURN_ADMISSION_CLAIM_KEY),
          txn.get<boolean>("terminal"),
        ]);
        if (
          terminal ||
          !exactTurnIdentityMatches(currentTurn, turn) ||
          currentClaim?.schemaVersion !== 1 ||
          currentClaim.claimId !== claim.claimId ||
          currentClaim.turnId !== turn.turnId ||
          currentClaim.ownerGeneration !== turn.ownerGeneration
        ) {
          return false;
        }
        await txn.put("sandboxId", firstSandboxId);
        await txn.delete(APP_TURN_ADMISSION_CLAIM_KEY);
        await txn.setAlarm(
          Date.now() + Math.max(1_000, turn.watchdogMs ?? 15 * 60_000),
        );
        return true;
      });
    } finally {
      if (!committed) {
        await this.ctx.storage.transaction(async (txn) => {
          const [currentTurn, currentClaim, terminal] = await Promise.all([
            txn.get<TurnRequest>("turn"),
            txn.get<AppTurnAdmissionClaim>(APP_TURN_ADMISSION_CLAIM_KEY),
            txn.get<boolean>("terminal"),
          ]);
          if (currentClaim?.claimId !== claim.claimId) return;
          await txn.delete(APP_TURN_ADMISSION_CLAIM_KEY);
          // A failed remote validation should restore pre-admission emptiness.
          // A Stop has already made the staged turn durable and keeps it so
          // cancellation acknowledgement/recovery can finish exactly once.
          if (exactTurnIdentityMatches(currentTurn, turn) && !terminal) {
            await txn.delete(["turn", "turnId", "terminal"]);
          }
        });
      }
    }
    if (!committed) throw new AppTurnAuthorityLostError();
    turnExecution.assertActive();
    let seq = 0;
    const requestStarted = performance.now();
    log("info", "turn_started", {
      turnId: turn.turnId,
      appId: turn.appId,
      sessionId: this.ctx.id.toString(),
    });
    try {
      await this.assertAppExecutionActive(turn, turnExecution);
      await this.event(
        turn,
        seq++,
        "started",
        { appId: turn.appId },
        false,
        turnExecution.signal,
      );
      turnExecution.assertActive();
      if (turn.preflightDelayMs) {
        await scheduler.wait(turn.preflightDelayMs);
        turnExecution.assertActive();
      }
      if (await this.ctx.storage.get<boolean>("terminal")) {
        throw new Error("Turn was canceled or timed out before execution.");
      }
      const coldStarted = performance.now();
      turnExecution.assertActive();
      const session = await first.createSession({
        id: sessionName(`build-${turn.turnId}`),
        cwd: "/opt/stella",
        commandTimeoutMs,
        env: { ...APP_BUILD_SESSION_ENV },
      });
      turnExecution.assertActive();
      await normalizeToolWorkspaceRoot(session, "/workspace/app");
      turnExecution.assertActive();
      const coldContainerStartMs = Math.round(performance.now() - coldStarted);
      await this.event(
        turn,
        seq++,
        "sandbox_ready",
        { coldContainerStartMs },
        false,
        turnExecution.signal,
      );
      turnExecution.assertActive();

      const modelStarted = performance.now();
      const modelResponse = await this.convexCall(
        turn,
        "/api/cloud/model",
        {
          prompt: turn.prompt,
          ownerId: turn.ownerId,
          ownerGeneration: turn.ownerGeneration,
          requestId: await cloudModelRequestId(turn.turnId),
        },
        { signal: turnExecution.signal },
      );
      turnExecution.assertActive();
      const modelPayload = (await modelResponse.json()) as {
        spec?: unknown;
        usage?: Record<string, unknown>;
        error?: string;
      };
      turnExecution.assertActive();
      if (!modelResponse.ok || !modelPayload.spec) {
        throw new Error(
          modelPayload.error ?? `Model relay failed (${modelResponse.status}).`,
        );
      }
      const appTitle =
        typeof (modelPayload.spec as { title?: unknown })?.title === "string"
          ? (modelPayload.spec as { title: string }).title
              .trim()
              .slice(0, 32) || undefined
          : undefined;
      await this.event(
        turn,
        seq++,
        "model_completed",
        {
          ...modelPayload.usage,
          roundTripMs: Math.round(performance.now() - modelStarted),
        },
        false,
        turnExecution.signal,
      );
      turnExecution.assertActive();
      await session.writeFile(
        "/workspace/turn-input.json",
        JSON.stringify({ prompt: turn.prompt, spec: modelPayload.spec }),
      );
      turnExecution.assertActive();
      const execution = (await strictSessionExec(
        session,
        ["bun", "packages/executor-cloud/src/cli.ts", "--app-turn"],
        { timeout: commandTimeoutMs },
      )) as Execution;
      turnExecution.assertActive();
      if (!execution.success) {
        log("error", "executor_failed", {
          turnId: turn.turnId,
          appId: turn.appId,
          ...executionFailureFields(execution.stderr),
        });
        throw new Error("Stella hit a problem while building. Try again.");
      }
      const executor = JSON.parse(
        execution.stdout.trim().split("\n").at(-1) ?? "{}",
      ) as ExecutorResult;
      await this.event(
        turn,
        seq++,
        "app_built",
        {
          runtimeTools: executor.runtimeTools,
          ...executor.metrics,
        },
        false,
        turnExecution.signal,
      );
      turnExecution.assertActive();

      const viteStarted = performance.now();
      const vite = await startStrictSessionProcess(
        session,
        ["/usr/local/bin/vite", "--host", "0.0.0.0", "--port", "5173"],
        { cwd: "/workspace/app" },
      );
      turnExecution.assertActive();
      await vite.waitForPort(5173, {
        path: "/",
        status: 200,
        timeout: 120_000,
      });
      turnExecution.assertActive();
      const tunnel = await first.tunnels.get(5173);
      turnExecution.assertActive();
      const firstPreviewMs = Math.round(performance.now() - viteStarted);
      if (!turn.previewRoute) {
        throw new Error("Trusted preview route is unavailable.");
      }
      const previewAccess = await issuePreviewAccessCapability({
        identity: {
          buildSessionName: turn.previewRoute.buildSessionName,
          turnId: turn.turnId,
          sandboxId: firstSandboxId,
        },
        tunnelUrl: tunnel.url,
        secret: this.env.BUILDER_SERVICE_SECRET,
        now: Date.now(),
        ttlMs: Math.min(
          PREVIEW_ACCESS_MAX_TTL_MS,
          Math.max(1_000, turn.watchdogMs ?? 15 * 60_000),
        ),
      });
      await this.ctx.storage.put(
        PREVIEW_ACCESS_STORAGE_KEY,
        previewAccess.activeRecord,
      );
      turnExecution.assertActive();
      // Exercise the exact signed route the agent would use. The tunnel URL
      // remains only in the active DO record and is never emitted to the UI.
      const signedPreviewUrl = `${turn.previewRoute.baseUrl}${previewAccess.capability}/`;
      const previewVerification = await this.proxyVitePreview(
        new Request(signedPreviewUrl, {
          headers: {
            [HEADER_PREVIEW_CAPABILITY]: previewAccess.capability,
          },
        }),
      );
      await previewVerification.body?.cancel().catch(() => undefined);
      if (!previewVerification.ok) {
        await this.ctx.storage.delete(PREVIEW_ACCESS_STORAGE_KEY);
        throw new Error("The signed agent preview did not become ready.");
      }
      await this.event(
        turn,
        seq++,
        "live_preview",
        {
          access: "agent_only",
          firstPreviewMs,
        },
        false,
        turnExecution.signal,
      );
      turnExecution.assertActive();

      await this.assertAppExecutionActive(turn, turnExecution);
      // The build is already in the publishing sandbox. Stop and join the
      // entire model-controlled session before a fresh trusted session reads
      // dist; the old cross-sandbox SDK backup added no durability, but could
      // orphan opaque random-address R2 bytes before returning its UUID.
      await first.killAllProcesses(session.id);
      await first.deleteSession(session.id).catch(() => undefined);
      turnExecution.assertActive();
      const publishSession = await first.createSession({
        id: sessionName(`publish-${turn.turnId}`),
        cwd: "/workspace/app",
        commandTimeoutMs,
      });
      turnExecution.assertActive();
      await normalizeToolWorkspaceRoot(publishSession, "/workspace/app");
      turnExecution.assertActive();
      const verify = await strictSessionExec(publishSession, [
        "/bin/sh",
        "-lc",
        "test -f dist/index.html && test -d dist/assets",
      ]);
      turnExecution.assertActive();
      if (!verify.success)
        throw new Error(
          "Built workspace did not contain the production build.",
        );
      await this.event(
        turn,
        seq++,
        "workspace_verified",
        { writersQuiesced: true },
        false,
        turnExecution.signal,
      );
      turnExecution.assertActive();

      const files = await publishSession.listFiles("/workspace/app/dist", {
        recursive: true,
      });
      turnExecution.assertActive();
      const buildId = crypto.randomUUID();
      const ownerHash = await sha256Hex(turn.ownerId);
      turnExecution.assertActive();
      const artifactPrefix = ownerAppBuildPrefix(ownerHash, buildId);
      await this.ctx.storage.put(
        `transientBuild:${turn.turnId}`,
        artifactPrefix,
      );
      turnExecution.assertActive();
      const slug = `orbit-${turn.appId.slice(-8)}`;
      let uploadedBytes = 0;
      for (const file of files.files.filter((entry) => entry.type === "file")) {
        const relative = file.absolutePath
          .replace(/^\/workspace\/app\/dist\/?/, "")
          .replace(/^dist\/?/, "");
        const read = await publishSession.readFile(file.absolutePath, {
          encoding: "base64",
        });
        const bytes = Uint8Array.from(atob(read.content), (char) =>
          char.charCodeAt(0),
        );
        uploadedBytes += bytes.byteLength;
        await this.assertAppExecutionActive(turn, turnExecution);
        const objectKey = `${artifactPrefix}/${relative}`;
        await this.env.APP_BUILDS.put(objectKey, bytes, {
          httpMetadata: { contentType: contentType(relative) },
          customMetadata: { buildId, appId: turn.appId, ownerHash },
        });
        try {
          await this.assertAppExecutionActive(turn, turnExecution);
        } catch (error) {
          await this.env.APP_BUILDS.delete(objectKey).catch(() => undefined);
          throw error;
        }
      }
      const contextSource = `window.__STELLA_APP_CONTEXT__={...${JSON.stringify(
        {
          appId: turn.appId,
          convexSiteUrl: this.env.STELLA_CONVEX_SITE_URL,
        },
      )},bridge:window.parent!==window};\n`;
      uploadedBytes += new TextEncoder().encode(contextSource).byteLength;
      await this.assertAppExecutionActive(turn, turnExecution);
      const contextObjectKey = `${artifactPrefix}/stella-context.js`;
      await this.env.APP_BUILDS.put(contextObjectKey, contextSource, {
        httpMetadata: { contentType: "text/javascript; charset=utf-8" },
        customMetadata: { buildId, appId: turn.appId, ownerHash },
      });
      try {
        await this.assertAppExecutionActive(turn, turnExecution);
      } catch (error) {
        await this.env.APP_BUILDS.delete(contextObjectKey).catch(
          () => undefined,
        );
        throw error;
      }
      const previewUrl = `${this.env.APPS_HOST_BASE_URL.replace(/\/+$/, "")}/apps/${slug}/`;
      const metrics = {
        coldContainerStartMs,
        backupRestoreMs: 0,
        firstPreviewMs,
        checkpointMs: 0,
        uploadedBytes,
        wallClockMs: Math.round(performance.now() - requestStarted),
        ...executor.metrics,
        model: modelPayload.usage,
        capacity: {
          instanceType: "standard-4",
          vCpu: 4,
          memoryBytes: 12 * 1024 ** 3,
          diskBytes: 20 * 1024 ** 3,
        },
      };
      const callbackBody = {
        buildId,
        appId: turn.appId,
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        turnId: turn.turnId,
        artifactPrefix,
        previewUrl,
        metrics,
        slug,
        title: appTitle,
      };
      const result = {
        turnId: turn.turnId,
        appId: turn.appId,
        buildId,
        previewUrl,
        metrics,
      };
      const pendingPublication: PendingAppBuildPublication = {
        turnId: turn.turnId,
        phase: "callback",
        artifactPrefix,
        buildId,
        callbackBody,
        completionSeq: seq++,
        completionResult: result,
      };
      // Persist before the first callback byte leaves this isolate. A lost
      // response replays the same buildId/body instead of leaking or deleting
      // a build Convex may already reference.
      await this.assertAppExecutionActive(turn, turnExecution);
      await this.ctx.storage.put(
        pendingAppBuildPublicationKey(turn.turnId),
        pendingPublication,
      );
      turnExecution.assertActive();
      const publication = await this.advanceAppBuildPublication(
        turn,
        pendingPublication,
      );
      await this.destroySandboxDurably(
        {
          sandboxId: firstSandboxId,
          size: "large",
          workload: "app-build",
        },
        "app_build_terminal",
      );
      if (publication === "retrying") {
        return json(
          { ok: true, accepted: true, publicationPending: true, ...result },
          202,
        );
      }
      await this.retireTerminalAppTurnStorage(turn);
      if (publication === "failed") {
        return json({ error: "Cloud app publication failed.", buildId }, 502);
      }
      log("info", "turn_completed", {
        turnId: turn.turnId,
        appId: turn.appId,
        buildId,
        wallClockMs: metrics.wallClockMs,
        activeCpuSeconds: metrics.activeCpuSeconds,
        uploadedBytes,
      });
      emitCloudTurnTelemetry(this.ctx, this.env, {
        type: "cloud.turn",
        workload: "app-build",
        phase: "completed",
        wallClockMs: metrics.wallClockMs,
        coldContainerStartMs: metrics.coldContainerStartMs,
        uploadedBytes,
        activeCpuMs: Math.max(
          0,
          Math.round((metrics.activeCpuSeconds ?? 0) * 1_000),
        ),
        ...(typeof modelPayload.usage?.inputTokens === "number"
          ? { inputTokens: modelPayload.usage.inputTokens }
          : {}),
        ...(typeof modelPayload.usage?.outputTokens === "number"
          ? { outputTokens: modelPayload.usage.outputTokens }
          : {}),
        ...(typeof modelPayload.usage?.llmCalls === "number"
          ? { llmCalls: modelPayload.usage.llmCalls }
          : {}),
        instanceType: metrics.capacity.instanceType,
      });
      return json({ ok: true, ...result });
    } catch (error) {
      const failureCode =
        error instanceof OwnerPurgeFenceError
          ? "OWNER_PURGE_FENCE"
          : error instanceof AppTurnAuthorityLostError
            ? "APP_TURN_AUTHORITY_LOST"
            : "APP_BUILD_FAILED";
      const failureMessage = "Stella hit a problem while building. Try again.";
      const transientBuild = await this.ctx.storage.get<string>(
        `transientBuild:${turn.turnId}`,
      );
      if (transientBuild) {
        const existing = await this.ctx.storage.get<PendingAppBuildPublication>(
          pendingAppBuildPublicationKey(turn.turnId),
        );
        const cleanupPending: PendingAppBuildPublication = existing ?? {
          turnId: turn.turnId,
          phase: "cleanup",
          artifactPrefix: transientBuild,
          callbackBody: {},
          completionSeq: seq++,
          completionResult: {},
          failureMessage,
        };
        await this.ctx.storage.put(
          pendingAppBuildPublicationKey(turn.turnId),
          cleanupPending,
        );
        const cleanup = await this.advanceAppBuildPublication(
          turn,
          cleanupPending,
        );
        await this.destroySandboxDurably(
          {
            sandboxId: firstSandboxId,
            size: "large",
            workload: "app-build",
          },
          "app_build_cleanup",
        ).catch(() => undefined);
        if (cleanup === "retrying") {
          return json(
            {
              ok: true,
              accepted: true,
              cleanupPending: true,
            },
            202,
          );
        }
        await this.retireTerminalAppTurnStorage(turn);
        return json(
          { error: "Cloud app turn failed.", code: failureCode },
          502,
        );
      }
      if (
        !(error instanceof OwnerPurgeFenceError) &&
        !(await this.ctx.storage.get<boolean>("terminal"))
      ) {
        await this.ctx.storage.put("terminal", true);
        await this.event(
          turn,
          seq++,
          "failed",
          { message: failureMessage },
          true,
        ).catch(() => undefined);
      }
      await this.destroySandboxDurably(
        {
          sandboxId: firstSandboxId,
          size: "large",
          workload: "app-build",
        },
        "app_build_failed",
      ).catch(() => undefined);
      await this.retireTerminalAppTurnStorage(turn);
      log("error", "turn_failed", {
        turnId: turn.turnId,
        appId: turn.appId,
        errorCode: failureCode,
      });
      return json({ error: "Cloud app turn failed.", code: failureCode }, 502);
    } finally {
      await this.unregisterTurn(turn);
    }
  }
}

const ownerFenceStub = (env: Env, ownerId: string) =>
  env.OWNER_GATES.getByName(ownerId);

const callOwnerFence = async (
  env: Env,
  ownerId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> =>
  ownerFenceStub(env, ownerId).fetch(`https://owner-gate/owner-fence/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HEADER_OWNER_FENCE_ID]: ownerId,
    },
    body: JSON.stringify({ ...body, ownerId }),
  });

const withOwnerActivityLease = async <T>(
  env: Env,
  ownerId: string,
  ownerGeneration: string,
  activityId: string,
  operation: (generation: string, leaseId: string) => Promise<T>,
): Promise<T> => {
  const sessionId = `activity-${activityId}`;
  const turnId = activityId;
  const leaseId = crypto.randomUUID();
  // Activity leases cannot be canceled by owner purge, so every one needs a
  // durable crash expiry. Thirty minutes leaves ample room for large world
  // operations while guaranteeing an evicted isolate cannot wedge the owner.
  const expiresAt = Date.now() + 30 * 60_000;
  const registered = await callOwnerFence(env, ownerId, "register", {
    leaseId,
    sessionId,
    turnId,
    ownerGeneration,
    namespace: "activity",
    role: "activity",
    expiresAt,
  });
  const registration = (await registered.json().catch(() => null)) as {
    generation?: string;
  } | null;
  if (!registered.ok || !registration?.generation) {
    throw new OwnerPurgeFenceError();
  }
  try {
    return await operation(registration.generation, leaseId);
  } finally {
    await callOwnerFence(env, ownerId, "unregister", {
      leaseId,
      sessionId,
      turnId,
      ownerGeneration,
      generation: registration.generation,
    }).catch(() => undefined);
  }
};

const cloudHomeLeaseRunner =
  (env: Env): CloudHomeLeaseRunner =>
  async (ownerId, ownerGeneration, activityId, operation) =>
    await withOwnerActivityLease(
      env,
      ownerId,
      ownerGeneration,
      activityId,
      async (generation, leaseId) =>
        await operation(async () => {
          const asserted = await callOwnerFence(env, ownerId, "assert", {
            ownerGeneration,
            generation,
            leaseId,
          });
          if (!asserted.ok) throw new OwnerPurgeFenceError();
        }),
    );

const transferControl = (
  request: OwnerTransferControl,
): OwnerTransferControl => ({
  migrationId: request.migrationId,
  leaseId: request.leaseId,
  leaseGeneration: request.leaseGeneration,
  stage: request.stage,
  planRevision: request.planRevision,
  fromOwnerGeneration: request.fromOwnerGeneration,
  toOwnerGeneration: request.toOwnerGeneration,
});

const createTransferCoordinatorContext = async (args: {
  env: Env;
  control: OwnerTransferControl;
  fromOwnerId: string;
  toOwnerId: string;
  operationScope: string;
  plan: unknown;
}): Promise<OwnerTransferCoordinatorContext> => {
  const marker = await stableValueMarker(args.plan);
  const planFingerprint = marker.slice("sha256:".length);
  const operationId = await ownerTransferOperationId(
    args.control,
    args.operationScope,
  );
  const passId = crypto.randomUUID();
  const attempt = await createCoordinatorAttempt({
    control: args.control,
    operationId,
    planFingerprint,
    fromOwnerId: args.fromOwnerId,
    toOwnerId: args.toOwnerId,
    passId,
  });
  return {
    operationId,
    planFingerprint,
    passId,
    attempt,
    stub: args.env.OWNER_TRANSFER_COORDINATORS.getByName(
      `owner-transfer-${operationId}`,
    ),
  };
};

const callTransferCoordinator = async (
  coordinator: OwnerTransferCoordinatorContext,
  path: string,
  body: Record<string, unknown> = {},
): Promise<Response> =>
  await coordinator.stub.fetch(`https://owner-transfer-coordinator${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attempt: coordinator.attempt, ...body }),
  });

const parseTransferReservationEnvelope = (
  value: unknown,
  operationId: string,
): OwnerTransferReservationEnvelope | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const source = row.source;
  const destination = row.destination;
  const validSide = (
    side: unknown,
  ): side is { leaseId: string; generation: string } =>
    Boolean(side) &&
    typeof side === "object" &&
    !Array.isArray(side) &&
    typeof (side as Record<string, unknown>).leaseId === "string" &&
    ((side as Record<string, unknown>).leaseId as string).length > 0 &&
    ((side as Record<string, unknown>).leaseId as string).length <= 512 &&
    typeof (side as Record<string, unknown>).generation === "string" &&
    ((side as Record<string, unknown>).generation as string).length > 0 &&
    ((side as Record<string, unknown>).generation as string).length <= 512;
  if (
    Object.keys(row).sort().join(",") !==
      "destination,expiresAt,sessionId,source,turnId" ||
    typeof row.sessionId !== "string" ||
    !row.sessionId ||
    row.sessionId.length > 512 ||
    row.turnId !== `owner-transfer:${operationId}` ||
    !Number.isSafeInteger(row.expiresAt) ||
    (row.expiresAt as number) <= Date.now() ||
    !validSide(source) ||
    !validSide(destination)
  ) {
    return null;
  }
  return {
    sessionId: row.sessionId,
    turnId: row.turnId,
    expiresAt: row.expiresAt as number,
    source,
    destination,
  };
};

const yieldTransferCoordinator = async (
  coordinator: OwnerTransferCoordinatorContext,
): Promise<void> => {
  await callTransferCoordinator(coordinator, "/yield").catch(() => undefined);
};

const abortTransferCoordinator = async (
  coordinator: OwnerTransferCoordinatorContext,
  permanent: boolean,
): Promise<void> => {
  await callTransferCoordinator(coordinator, "/abort", { permanent }).catch(
    () => undefined,
  );
};

const beginOwnerPurge = async (
  env: Env,
  ownerId: string,
  mode: OwnerPurgeMode,
  requestId: string,
  expectedGeneration?: string,
): Promise<{ generation: string; rejoined?: true }> => {
  let response = await callOwnerFence(env, ownerId, "begin", {
    mode,
    requestId,
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  });
  if (!response.ok) throw new Error("Owner purge fence could not be created.");
  let state = (await response.json()) as {
    generation?: string;
    active?: OwnerPurgeFence["active"];
    rejoined?: boolean;
  };
  if (!state.generation) throw new Error("Owner purge fence was unreadable.");
  const generation = state.generation;
  const rejoined = state.rejoined === true;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const active = Object.values(state.active ?? {});
    if (active.length === 0) {
      return { generation, ...(rejoined ? { rejoined: true } : {}) };
    }
    await Promise.all(
      active.map(
        async ({ leaseId, sessionId, turnId, namespace, ownerGeneration }) => {
          if (namespace === "activity") return;
          try {
            const target =
              namespace === "orchestrator"
                ? env.ORCHESTRATOR_SESSIONS
                : env.BUILD_SESSIONS;
            const id = target.idFromString(sessionId);
            await target
              .get(id)
              .fetch("https://build-session/owner-purge-cancel", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  ownerId,
                  turnId,
                  ownerGeneration: ownerGeneration ?? "legacy",
                  generation,
                  leaseId,
                }),
              });
          } catch (error) {
            log("error", "owner_purge_turn_cancel_failed", {
              sessionId,
              message: errorMessage(error),
            });
          }
        },
      ),
    );
    await scheduler.wait(250);
    response = await callOwnerFence(env, ownerId, "assert-blocked", {
      generation,
    });
    if (!response.ok)
      throw new Error("Owner purge fence changed unexpectedly.");
    state = (await response.json()) as typeof state;
  }
  throw new Error("Owner cloud turns did not quiesce before purge.");
};

/** Pages of 1000 keys per bucket prefix. 10M objects is not a real owner. */
const R2_SWEEP_MAX_PAGES = 10_000;
/** `crypto.randomUUID()` in the sandbox SDK; anything else is not a backup. */
const BACKUP_ID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** The slug a hosted app route is keyed by. */
const APP_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/**
 * A caller-supplied R2 prefix is a bucket-wipe primitive, so it is matched
 * against the two shapes this worker writes rather than merely checked for
 * non-emptiness. The interior form embeds a one-way owner hash and a
 * content-derived build id, so another owner's prefix cannot be smuggled in
 * through a path segment.
 */
const LEGACY_BUILD_PREFIX_PATTERN = /^builds\/[A-Za-z0-9_-]{1,64}$/;
const INTERIOR_BUILD_PREFIX_PATTERN =
  /^interiors\/[0-9a-f]{64}\/interior-[0-9a-f]{48}$/;

/**
 * Delete every object under `prefix`. Bounded: `list` is cursor-paged at 1000
 * and each page is deleted before the next is fetched, so neither memory nor
 * the delete batch grows with the owner's history. `done: false` means the
 * sweep ran out of pages and the caller must ask again.
 */
const sweepR2Prefix = async (
  bucket: R2Bucket,
  prefix: string,
): Promise<{ deleted: number; done: boolean }> => {
  let deleted = 0;
  let cursor: string | undefined;
  for (let page = 0; page < R2_SWEEP_MAX_PAGES; page += 1) {
    const listing = await bucket.list({
      prefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    const keys = listing.objects.map((object) => object.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    if (!listing.truncated) return { deleted, done: true };
    cursor = listing.cursor;
  }
  return { deleted, done: false };
};

/**
 * Backfill for checkpoints written before cleanup debt existed. The sandbox
 * SDK stores `{name}` in `backups/<uuid>/meta.json`; our name is derived from
 * the owner/workspace checkpoint key, so a full metadata scan can attribute
 * old random backup ids without guessing or deleting another owner's data.
 */
const sweepBackupsByName = async (
  bucket: R2Bucket,
  name: string,
): Promise<{ deleted: number; done: boolean }> => {
  const backupIds = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < R2_SWEEP_MAX_PAGES; page += 1) {
    const listing = await bucket.list({
      prefix: "backups/",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of listing.objects) {
      const match = object.key.match(/^backups\/([0-9a-f-]{36})\/meta\.json$/i);
      if (!match || !BACKUP_ID_PATTERN.test(match[1]!)) continue;
      const metadata = await bucket.get(object.key);
      if (!metadata) continue;
      const parsed = (await metadata.json().catch(() => null)) as {
        name?: string | null;
      } | null;
      if (parsed?.name === name) backupIds.add(match[1]!);
    }
    if (!listing.truncated) {
      let deleted = 0;
      for (const backupId of backupIds) {
        const swept = await sweepR2Prefix(bucket, `backups/${backupId}/`);
        deleted += swept.deleted;
        if (!swept.done) return { deleted, done: false };
      }
      return { deleted, done: true };
    }
    cursor = listing.cursor;
  }
  return { deleted: 0, done: false };
};

export const purgeNativeStateForWorkspace = async (
  env: Pick<Env, "APP_ROUTES" | "BACKUP_BUCKET">,
  workspaceKey: string,
): Promise<{ deleted: number; keys: number }> => {
  const prefix = nativeStateCheckpointPrefix(workspaceKey);
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < R2_SWEEP_MAX_PAGES; page += 1) {
    const listing = await env.APP_ROUTES.list({
      prefix,
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    });
    keys.push(...listing.keys.map((entry) => entry.name));
    if (listing.list_complete) {
      cursor = undefined;
      break;
    }
    cursor = listing.cursor;
  }
  if (cursor) throw new Error("Native checkpoint listing was truncated.");

  let deleted = 0;
  const debtKey = nativeBackupDebtKey(workspaceKey);
  const debt = await env.APP_ROUTES.get<WorkspaceBackupDebt>(debtKey, "json");
  for (const backupId of debt?.backupIds ?? []) {
    if (!BACKUP_ID_PATTERN.test(backupId)) {
      throw new Error("Native backup debt descriptor is invalid.");
    }
    const swept = await sweepR2Prefix(
      env.BACKUP_BUCKET,
      `backups/${backupId}/`,
    );
    deleted += swept.deleted;
    if (!swept.done) throw new Error("Native backup debt purge was truncated.");
  }
  for (const key of keys) {
    const raw = await env.APP_ROUTES.get<unknown>(key, "json");
    const record = raw ? parseNativeStateCheckpointRecord(raw) : null;
    const backupIds = new Set<string>();
    if (record) {
      for (const version of [
        ...(record.committed ? [record.committed] : []),
        ...record.candidates,
      ]) {
        backupIds.add(version.descriptor.id);
      }
    }
    for (const backupId of backupIds) {
      if (!BACKUP_ID_PATTERN.test(backupId)) {
        throw new Error("Native checkpoint backup descriptor is invalid.");
      }
      const swept = await sweepR2Prefix(
        env.BACKUP_BUCKET,
        `backups/${backupId}/`,
      );
      deleted += swept.deleted;
      if (!swept.done)
        throw new Error("Native checkpoint purge was truncated.");
    }
    // Also catches createBackup -> descriptor-persist crash or a malformed KV
    // record. The name is a one-way derivative of this exact native key.
    const historical = await sweepBackupsByName(
      env.BACKUP_BUCKET,
      await nativeStateBackupName(key),
    );
    deleted += historical.deleted;
    if (!historical.done) {
      throw new Error("Historical native checkpoint purge was truncated.");
    }
    await env.APP_ROUTES.delete(key);
  }
  await env.APP_ROUTES.delete(debtKey);
  return { deleted, keys: keys.length };
};

const requireTransferReservation = (
  coordinator: OwnerTransferCoordinatorContext,
): OwnerTransferReservationEnvelope => {
  const reservation = coordinator.reservation;
  if (!reservation || reservation.expiresAt <= Date.now()) {
    throw new OwnerProductTransferConflictError(
      "The durable ownership-transfer reservation expired.",
      "transfer_busy",
    );
  }
  return reservation;
};

const turnStateTransferIdentity = (args: {
  coordinator: OwnerTransferCoordinatorContext;
  fromOwnerId: string;
  fromOwnerGeneration: string;
  toOwnerId: string;
  toOwnerGeneration: string;
  side: "source" | "destination";
}): Record<string, unknown> => {
  const reservation = requireTransferReservation(args.coordinator);
  const lease =
    args.side === "source" ? reservation.source : reservation.destination;
  return {
    schemaVersion: 1,
    ownerId: args.side === "source" ? args.fromOwnerId : args.toOwnerId,
    ownerGeneration:
      args.side === "source"
        ? args.fromOwnerGeneration
        : args.toOwnerGeneration,
    generation: lease.generation,
    leaseId: lease.leaseId,
    sessionId: reservation.sessionId,
    turnId: reservation.turnId,
    transferOperationId: args.coordinator.operationId,
    fromOwnerId: args.fromOwnerId,
    fromOwnerGeneration: args.fromOwnerGeneration,
    toOwnerId: args.toOwnerId,
    toOwnerGeneration: args.toOwnerGeneration,
  };
};

const callTurnStateTransferRoute = async <T>(args: {
  env: Env;
  coordinator: OwnerTransferCoordinatorContext;
  fromOwnerId: string;
  fromOwnerGeneration: string;
  toOwnerId: string;
  toOwnerGeneration: string;
  side: "source" | "destination";
  path:
    | "transfer-status"
    | "transfer-export"
    | "transfer-stage"
    | "transfer-activate"
    | "transfer-retire";
  body?: Record<string, unknown>;
}): Promise<{ response: Response; body: T }> => {
  const ownerId = args.side === "source" ? args.fromOwnerId : args.toOwnerId;
  const response = await callOwnerFence(
    args.env,
    ownerId,
    `turn-state/${args.path}`,
    {
      ...turnStateTransferIdentity(args),
      ...(args.body ?? {}),
    },
  );
  const parsed = (await response
    .clone()
    .json()
    .catch(() => null)) as T | null;
  if (!response.ok || !parsed) {
    const code =
      parsed && typeof parsed === "object"
        ? String((parsed as Record<string, unknown>).code ?? "")
        : "";
    if (response.status < 500) {
      throw new OwnerProductTransferConflictError(
        "The atomic workspace transfer conflicted with current state.",
        code === "owner_purge_permanent"
          ? "owner_purge_permanent"
          : code === "owner_purge_temporary"
            ? "owner_purge_temporary"
            : code === "transfer_busy" ||
                code === "owner_transfer_fence_changed"
              ? "transfer_busy"
              : "destination_checkpoint_changed",
      );
    }
    throw new Error("Atomic workspace transfer is temporarily unavailable.");
  }
  return { response, body: parsed };
};

const coordinatorWorkspacePlan = async (
  coordinator: OwnerTransferCoordinatorContext,
  workspacePlanId: string,
): Promise<DurableWorkspaceTransferPlan | null> => {
  const response = await callTransferCoordinator(
    coordinator,
    "/workspace/get",
    {
      workspacePlanId,
    },
  );
  const body = (await response.json().catch(() => null)) as {
    plan?: DurableWorkspaceTransferPlan | null;
  } | null;
  if (!response.ok || body?.plan === undefined) {
    throw new Error("The durable workspace transfer plan was unreadable.");
  }
  return body.plan;
};

const updateCoordinatorTurnState = async (
  coordinator: OwnerTransferCoordinatorContext,
  path:
    | "/workspace/turn-state/exported"
    | "/workspace/turn-state/staged"
    | "/workspace/turn-state/activated"
    | "/workspace/turn-state/retired",
  body: Record<string, unknown>,
): Promise<DurableTurnStateWorkspaceTransfer> => {
  const response = await callTransferCoordinator(coordinator, path, body);
  const result = (await response.json().catch(() => null)) as {
    turnState?: DurableTurnStateWorkspaceTransfer;
  } | null;
  if (!response.ok || !result?.turnState) {
    throw new OwnerProductTransferConflictError(
      "The durable atomic workspace transfer state changed.",
      response.status === 409
        ? "destination_checkpoint_changed"
        : "transfer_busy",
    );
  }
  return result.turnState;
};

const OWNER_TRANSFER_SOURCE_METADATA = "stellaTransferSource";
const OWNER_TRANSFER_METADATA_TRANSFORM_MAX_BYTES = 64 * 1024;

const transferSourceMarker = async (
  sourceKey: string,
  sourceEtag: string,
): Promise<string> =>
  await sha256Hex(`owner-transfer-source:${sourceKey}:${sourceEtag}`);

const isTransferredSource = (
  destination: R2Object | null,
  marker: string,
): boolean =>
  destination?.customMetadata?.[OWNER_TRANSFER_SOURCE_METADATA] === marker;

/**
 * Move one bounded page. Each source object is deleted only after R2 confirms
 * its deterministic destination carries this exact source object's marker.
 * Callers choose a product-visible imported namespace before this mover runs;
 * a second per-object fallback would no longer match the Convex metadata or
 * checkpoint manifest, so an unexpected collision fails closed with both
 * objects untouched.
 */
const moveR2PrefixPreservingDestination = async (
  bucket: R2Bucket,
  sourcePrefix: string,
  destinationPrefix: string,
  budget: OwnerTransferBudget,
  transform?: {
    matches: (destinationKey: string) => boolean;
    run: R2TransferTransform;
  },
): Promise<boolean> => {
  if (!isValidOwnerTransferPrefixPair(sourcePrefix, destinationPrefix)) {
    throw new OwnerProductTransferConflictError(
      "The owner transfer requested an invalid storage-prefix mapping.",
    );
  }
  if (budget.remaining <= 0) return false;
  const listing = await bucket.list({
    prefix: sourcePrefix,
    limit: budget.remaining,
  });
  const batch = takeOwnerTransferBatch(listing.objects, budget);
  for (const listed of batch) {
    const canonicalKey = replaceOwnerPrefix(
      listed.key,
      sourcePrefix,
      destinationPrefix,
    );
    if (!canonicalKey) {
      throw new Error("Owner transfer prefix mapping failed.");
    }
    const source = await bucket.get(listed.key);
    if (!source) continue;
    const marker = await transferSourceMarker(listed.key, source.etag);
    let transferBody: Awaited<ReturnType<typeof r2TransferBody>>;
    try {
      transferBody = await r2TransferBody({
        source,
        destinationKey: canonicalKey,
        ...(transform?.matches(canonicalKey)
          ? {
              transform: transform.run,
              transformMaxBytes: OWNER_TRANSFER_METADATA_TRANSFORM_MAX_BYTES,
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof R2TransferTransformTooLargeError) {
        throw new OwnerProductTransferConflictError(
          "Owner transfer metadata exceeded its bounded transform limit.",
        );
      }
      throw error;
    }
    const options: R2PutOptions = {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: transferBody.contentType
        ? { contentType: transferBody.contentType }
        : source.httpMetadata,
      customMetadata: {
        ...(source.customMetadata ?? {}),
        [OWNER_TRANSFER_SOURCE_METADATA]: marker,
      },
    };

    const ensureCopy = async (destinationKey: string): Promise<boolean> => {
      const existing = await bucket.head(destinationKey);
      if (isTransferredSource(existing, marker)) return true;
      if (existing) return false;
      await bucket.put(destinationKey, transferBody.body, options);
      return isTransferredSource(await bucket.head(destinationKey), marker);
    };

    const copied = await ensureCopy(canonicalKey);
    if (!copied) {
      const objectRef = (await sha256Hex(listed.key)).slice(0, 16);
      throw new OwnerProductTransferConflictError(
        `The resolved owner transfer destination contains unrelated data (ref ${objectRef}).`,
      );
    }
    await bucket.delete(listed.key);
  }
  return !listing.truncated;
};

const advanceTurnStateWorkspaceTransfer = async (args: {
  env: Env;
  coordinator: OwnerTransferCoordinatorContext;
  workspacePlanId: string;
  plan: DurableWorkspaceTransferPlan;
  sourcePresent: boolean;
  fromOwnerId: string;
  fromOwnerGeneration: string;
  toOwnerId: string;
  toOwnerGeneration: string;
}): Promise<{ complete: boolean; plan: DurableWorkspaceTransferPlan }> => {
  const route = {
    env: args.env,
    coordinator: args.coordinator,
    fromOwnerId: args.fromOwnerId,
    fromOwnerGeneration: args.fromOwnerGeneration,
    toOwnerId: args.toOwnerId,
    toOwnerGeneration: args.toOwnerGeneration,
  };
  try {
    return await advanceDurableTurnStateWorkspaceTransfer({
      plan: args.plan,
      sourcePresent: args.sourcePresent,
      operations: {
        exportPage: async (cursor, limit) =>
          (
            await callTurnStateTransferRoute<TurnStateTransferExportResponse>({
              ...route,
              side: "source",
              path: "transfer-export",
              body: { cursor, limit },
            })
          ).body,
        stageEntry: async (manifest, entry) => {
          await callTurnStateTransferRoute({
            ...route,
            side: "destination",
            path: "transfer-stage",
            body: { manifest, entry },
          });
        },
        activate: async (manifest) =>
          (
            await callTurnStateTransferRoute<TurnStateTransferActivationResponse>(
              {
                ...route,
                side: "destination",
                path: "transfer-activate",
                body: { manifest },
              },
            )
          ).body,
        persistExported: async (manifest) =>
          await updateCoordinatorTurnState(
            args.coordinator,
            "/workspace/turn-state/exported",
            { workspacePlanId: args.workspacePlanId, manifest },
          ),
        persistStaged: async (progress) =>
          await updateCoordinatorTurnState(
            args.coordinator,
            "/workspace/turn-state/staged",
            { workspacePlanId: args.workspacePlanId, ...progress },
          ),
        persistActivated: async (activation) =>
          await updateCoordinatorTurnState(
            args.coordinator,
            "/workspace/turn-state/activated",
            { workspacePlanId: args.workspacePlanId, ...activation },
          ),
      },
    });
  } catch (error) {
    if (error instanceof TurnStateProductTransferConflictError) {
      throw new OwnerProductTransferConflictError(
        error.message,
        "destination_checkpoint_changed",
      );
    }
    throw error;
  }
};

const moveWorldCheckpoint = async (
  env: Env,
  fromOwnerId: string,
  toOwnerId: string,
  budget: OwnerTransferBudget,
  coordinator: OwnerTransferCoordinatorContext,
): Promise<{ complete: boolean }> => {
  const fromKey = await checkpointKey(fromOwnerId);
  const toKey = await checkpointKey(toOwnerId);
  const workspacePlanId = await sha256Hex(
    `world-owner-transfer-v1\0${fromKey}\0${toKey}`,
  );
  const existingPlan = await coordinatorWorkspacePlan(
    coordinator,
    workspacePlanId,
  );
  type CheckpointState = {
    descriptor?: DirectoryBackup;
    debt: WorkspaceBackupDebt;
  };
  const readState = async (key: string): Promise<CheckpointState> => ({
    descriptor:
      (await env.APP_ROUTES.get<DirectoryBackup>(key, "json")) ?? undefined,
    debt: (await env.APP_ROUTES.get<WorkspaceBackupDebt>(
      backupDebtKey(key),
      "json",
    )) ?? { backupIds: [] },
  });
  const stateMarker = async (state: CheckpointState): Promise<string> =>
    !state.descriptor && state.debt.backupIds.length === 0
      ? "absent"
      : await stableValueMarker({
          descriptor: state.descriptor ?? null,
          backupIds: [...state.debt.backupIds].sort(),
        });
  const [sourceState, destinationState] = await Promise.all([
    readState(fromKey),
    readState(toKey),
  ]);
  const fromDescriptor = sourceState.descriptor;
  const fromDebt = sourceState.debt;
  const sourceIds = new Set<string>();
  if (fromDescriptor?.id) sourceIds.add(fromDescriptor.id);
  for (const id of fromDebt.backupIds) sourceIds.add(id);
  for (const sourceId of sourceIds) {
    if (!BACKUP_ID_PATTERN.test(sourceId)) {
      throw new Error("Workspace backup descriptor is invalid.");
    }
  }
  const hasSourceState = Boolean(fromDescriptor) || sourceIds.size > 0;
  let sourceTurnStatePresent = Boolean(existingPlan?.turnState);
  let sourceTurnStateFingerprint: string | null =
    existingPlan?.turnState?.manifest.fingerprint ?? null;
  if (!existingPlan) {
    const sourceProbe = (
      await callTurnStateTransferRoute<TurnStateTransferExportResponse>({
        env,
        coordinator,
        fromOwnerId,
        fromOwnerGeneration: coordinator.attempt.fromOwnerGeneration,
        toOwnerId,
        toOwnerGeneration: coordinator.attempt.toOwnerGeneration,
        side: "source",
        path: "transfer-export",
        body: { cursor: 0, limit: 1 },
      })
    ).body;
    sourceTurnStatePresent = sourceProbe.manifest.count > 0;
    sourceTurnStateFingerprint = sourceTurnStatePresent
      ? sourceProbe.manifest.fingerprint
      : null;
  }
  const destinationTurnState = (
    await callTurnStateTransferRoute<TurnStateTransferDestinationStatus>({
      env,
      coordinator,
      fromOwnerId,
      fromOwnerGeneration: coordinator.attempt.fromOwnerGeneration,
      toOwnerId,
      toOwnerGeneration: coordinator.attempt.toOwnerGeneration,
      side: "destination",
      path: "transfer-status",
    })
  ).body;
  const destinationStateMarker = (
    legacyMarker: string,
    status: TurnStateTransferDestinationStatus,
  ): string => {
    if (status.state === "empty") return legacyMarker;
    const exactOwned =
      existingPlan?.turnState !== undefined &&
      (status.state === "staging" || status.state === "activated");
    return exactOwned ? legacyMarker : `strong:${status.state}`;
  };
  const expectedState = async (
    key: string,
    destination: CheckpointState,
  ): Promise<CheckpointState> => {
    const copiedIds = new Map<string, string>();
    for (const sourceId of sourceIds) {
      copiedIds.set(
        sourceId,
        await transferredBackupId(fromKey, key, sourceId),
      );
    }
    const destinationName = checkpointBackupName(key);
    const transferredDebt = fromDebt.backupIds.map(
      (id) => copiedIds.get(id) ?? id,
    );
    return {
      descriptor: fromDescriptor?.id
        ? {
            ...fromDescriptor,
            id: copiedIds.get(fromDescriptor.id)!,
          }
        : destination.descriptor,
      debt: {
        backupIds: [
          ...new Set([...destination.debt.backupIds, ...transferredDebt]),
        ],
      },
    };
  };
  const expectedDestinationState = await expectedState(toKey, destinationState);
  const observation: WorkspacePlanObservation = {
    workspacePlanId,
    sourceHasState: hasSourceState || sourceTurnStatePresent,
    sourceStateMarker:
      existingPlan?.sourceStateMarker ??
      (await stableValueMarker({
        legacy: await stateMarker(sourceState),
        turnState: sourceTurnStateFingerprint,
      })),
    destinationMarker: destinationStateMarker(
      await stateMarker(destinationState),
      destinationTurnState,
    ),
    expectedDestinationMarker: await stateMarker(expectedDestinationState),
  };
  const planResponse = await callTransferCoordinator(
    coordinator,
    "/workspace/plan",
    { observation },
  );
  const planBody = (await planResponse.json().catch(() => null)) as {
    plan?: DurableWorkspaceTransferPlan;
    code?: string;
    message?: string;
  } | null;
  if (!planResponse.ok || !planBody?.plan?.state) {
    throw new OwnerProductTransferConflictError(
      planBody?.message ?? "The durable workspace transfer plan was rejected.",
      planBody?.code === "destination_checkpoint_changed" ||
      planBody?.code === "owner_purge_permanent" ||
      planBody?.code === "owner_purge_temporary" ||
      planBody?.code === "transfer_busy"
        ? planBody.code
        : "owner_transfer_conflict",
    );
  }
  if (planBody.plan.state === "retired") return { complete: true };
  let durablePlan = planBody.plan;
  const resolvedKey = toKey;
  const resolvedExpectedState = expectedDestinationState;
  const destinationName = checkpointBackupName(resolvedKey);

  const turnStateProgress = await advanceTurnStateWorkspaceTransfer({
    env,
    coordinator,
    workspacePlanId,
    plan: durablePlan,
    sourcePresent: sourceTurnStatePresent,
    fromOwnerId,
    fromOwnerGeneration: coordinator.attempt.fromOwnerGeneration,
    toOwnerId,
    toOwnerGeneration: coordinator.attempt.toOwnerGeneration,
  });
  durablePlan = turnStateProgress.plan;
  if (!turnStateProgress.complete) return { complete: false };

  if (durablePlan.state === "planned") {
    const copiedIds = new Map<string, string>();
    for (const sourceId of sourceIds) {
      const destinationId = await transferredBackupId(
        fromKey,
        resolvedKey,
        sourceId,
      );
      copiedIds.set(sourceId, destinationId);
      const complete = await moveR2PrefixPreservingDestination(
        env.BACKUP_BUCKET,
        `backups/${sourceId}/`,
        `backups/${destinationId}/`,
        budget,
        {
          matches: (destinationKey) => destinationKey.endsWith("/meta.json"),
          run: async (sourceBody) => {
            let metadata: Record<string, unknown> | null = null;
            try {
              const decoded = new TextDecoder("utf-8", {
                fatal: true,
                ignoreBOM: false,
              }).decode(sourceBody);
              const parsed = JSON.parse(decoded) as unknown;
              metadata =
                parsed && typeof parsed === "object" && !Array.isArray(parsed)
                  ? (parsed as Record<string, unknown>)
                  : null;
            } catch {
              metadata = null;
            }
            return {
              body: JSON.stringify({
                ...(metadata ?? {}),
                name: destinationName,
              }),
              contentType: "application/json",
            };
          },
        },
      );
      if (!complete) return { complete: false };
    }
    if (resolvedExpectedState.descriptor) {
      await env.APP_ROUTES.put(
        resolvedKey,
        JSON.stringify(resolvedExpectedState.descriptor),
      );
    }
    if (resolvedExpectedState.debt.backupIds.length > 0) {
      await env.APP_ROUTES.put(
        backupDebtKey(resolvedKey),
        JSON.stringify(resolvedExpectedState.debt),
      );
    }
    const writtenMarker = await stateMarker(await readState(resolvedKey));
    if (writtenMarker !== durablePlan.expectedResolvedDestinationMarker) {
      throw new OwnerProductTransferConflictError(
        "The destination checkpoint did not match the durable transfer plan.",
      );
    }
    const copied = await callTransferCoordinator(
      coordinator,
      "/workspace/copied",
      { workspacePlanId },
    );
    if (!copied.ok) {
      throw new Error("The durable workspace copy receipt was not committed.");
    }
    durablePlan = (
      (await copied
        .clone()
        .json()
        .catch(() => null)) as {
        plan?: DurableWorkspaceTransferPlan;
      } | null
    )?.plan ?? { ...durablePlan, state: "copied" };
  }

  if (durablePlan.turnState?.phase === "activated") {
    const activationReceipt = durablePlan.turnState.activationReceipt;
    if (!activationReceipt) {
      throw new Error("Atomic workspace activation receipt was missing.");
    }
    const retirement = (
      await callTurnStateTransferRoute<TurnStateTransferRetireResponse>({
        env,
        coordinator,
        fromOwnerId,
        fromOwnerGeneration: coordinator.attempt.fromOwnerGeneration,
        toOwnerId,
        toOwnerGeneration: coordinator.attempt.toOwnerGeneration,
        side: "source",
        path: "transfer-retire",
        body: {
          manifest: durablePlan.turnState.manifest,
          activationReceipt,
        },
      })
    ).body;
    if (
      retirement.manifestFingerprint !==
        durablePlan.turnState.manifest.fingerprint ||
      retirement.activationReceipt !== activationReceipt
    ) {
      throw new Error("Atomic workspace retirement receipt was invalid.");
    }
    if (retirement.pending) return { complete: false };
    if (!retirement.emptyReceipt) {
      throw new Error("Atomic workspace source empty receipt was missing.");
    }
    durablePlan.turnState = await updateCoordinatorTurnState(
      coordinator,
      "/workspace/turn-state/retired",
      {
        workspacePlanId,
        manifestFingerprint: retirement.manifestFingerprint,
        activationReceipt,
        emptyReceipt: retirement.emptyReceipt,
      },
    );
  }

  // Native resume authority is HMAC-bound to the source owner/generation.
  // Never copy it under a new owner key: retire it bytes-first instead.
  await purgeNativeStateForWorkspace(env, fromKey);
  await env.APP_ROUTES.delete(fromKey);
  await env.APP_ROUTES.delete(backupDebtKey(fromKey));
  const retired = await callTransferCoordinator(
    coordinator,
    "/workspace/retired",
    { workspacePlanId },
  );
  if (!retired.ok) {
    throw new Error(
      "The durable workspace retirement receipt was not committed.",
    );
  }
  return { complete: true };
};

const transferOwnerProductStorage = async (
  env: Env,
  request: OwnerProductTransferRequest,
  coordinator: OwnerTransferCoordinatorContext,
): Promise<
  | { complete: true; fromOwnerHash: string; toOwnerHash: string }
  | { complete: false }
> => {
  const budget = createOwnerTransferBudget();
  const fromOwnerHash = await sha256Hex(request.fromOwnerId);
  const toOwnerHash = await sha256Hex(request.toOwnerId);
  if (
    missingOwnerProductTransferBinding(request, {
      agentHome: Boolean(env.AGENT_HOME),
    })
  ) {
    throw new OwnerProductTransferConfigurationError(
      "The AGENT_HOME binding is required for this ownership transfer.",
    );
  }
  // Validate globally keyed routes before moving any checkpoint/object state.
  // A corrupt slug collision is permanent; discovering it after the source
  // workspace was retired would turn a clean failure into a partial move.
  for (const slug of request.appSlugs) {
    const route = await env.APP_ROUTES.get<Record<string, unknown>>(
      `app:${slug}`,
      "json",
    );
    if (
      route &&
      route.ownerId !== request.fromOwnerId &&
      route.ownerId !== request.toOwnerId
    ) {
      throw new OwnerProductTransferConflictError(
        `Hosted route "${slug}" belongs to another owner.`,
      );
    }
  }
  if (request.agentHome) {
    // Anonymous memory remains a separate imported document set. The
    // orchestrator reads this owner-scoped subtree as startup context, while
    // the connected account's canonical MEMORY/profile files stay untouched.
    const complete = await moveR2PrefixPreservingDestination(
      env.AGENT_HOME!,
      `agent-home/${fromOwnerHash}/`,
      `agent-home/${toOwnerHash}/__stella_imported__/${fromOwnerHash}/`,
      budget,
    );
    if (!complete) return { complete: false };
  }
  if (request.interiors) {
    // Build manifests are rewritten to this deterministic imported namespace
    // by Convex after the object copy. Keeping the entire source tree separate
    // avoids per-object collision fallbacks that no build row can address.
    const complete = await moveR2PrefixPreservingDestination(
      env.APP_BUILDS,
      `interiors/${fromOwnerHash}/`,
      `interiors/${toOwnerHash}/__stella_imported__/${fromOwnerHash}/`,
      budget,
    );
    if (!complete) return { complete: false };
  }
  // Build rows can outlive their app route, so the canonical owner root is
  // always transferred. `appSlugs` only scopes the globally keyed route
  // records that Convex proved belong to this migration.
  const buildsComplete = await moveR2PrefixPreservingDestination(
    env.APP_BUILDS,
    `${ownerAppBuildRoot(fromOwnerHash)}/`,
    `${ownerAppBuildRoot(toOwnerHash)}/`,
    budget,
  );
  if (!buildsComplete) return { complete: false };
  if (request.world) {
    const moved = await moveWorldCheckpoint(
      env,
      request.fromOwnerId,
      request.toOwnerId,
      budget,
      coordinator,
    );
    if (!moved.complete) return { complete: false };
  }
  for (const slug of request.appSlugs) {
    const key = `app:${slug}`;
    const route = await env.APP_ROUTES.get<Record<string, unknown>>(
      key,
      "json",
    );
    if (!route) continue;
    if (route.ownerId === request.fromOwnerId) {
      let artifactPrefix = route.artifactPrefix;
      if (artifactPrefix !== undefined) {
        if (
          typeof artifactPrefix !== "string" ||
          typeof route.buildId !== "string" ||
          !isOwnerAppBuildPrefix(artifactPrefix, fromOwnerHash) ||
          artifactPrefix !== ownerAppBuildPrefix(fromOwnerHash, route.buildId)
        ) {
          throw new OwnerProductTransferConflictError(
            `Hosted route "${slug}" has an invalid source artifact prefix.`,
          );
        }
        artifactPrefix = ownerAppBuildPrefix(toOwnerHash, route.buildId);
      }
      await env.APP_ROUTES.put(
        key,
        JSON.stringify({
          ...route,
          ownerId: request.toOwnerId,
          ...(artifactPrefix !== undefined ? { artifactPrefix } : {}),
          updatedAt: Date.now(),
        }),
      );
    }
  }
  return { complete: true, fromOwnerHash, toOwnerHash };
};

const purgeOwnerStorage = async (
  env: Env,
  ownerId: string,
  request: OwnerPurgeRequest,
): Promise<OwnerPurgeReport> => {
  const pending: string[] = [];
  let deleted = 0;
  const fail = (store: string, error: unknown): void => {
    pending.push(store);
    log("error", "owner_storage_purge_step_failed", {
      store,
      message: errorMessage(error),
    });
  };

  const ownerHash = await sha256Hex(ownerId);
  const prefixTargets: {
    store: string;
    bucket: R2Bucket | undefined;
    prefix: string;
  }[] = [
    {
      store: "agent-home",
      bucket: env.AGENT_HOME,
      prefix: `agent-home/${ownerHash}/`,
    },
    {
      store: "conversations",
      bucket: env.CONVERSATION_ARCHIVE,
      prefix: `conversations/${ownerHash}/`,
    },
    {
      // Every interior prefix is owner-addressable. Sweep the whole namespace
      // so uploads stranded before an idempotent candidate callback cannot
      // survive account deletion merely because no Convex row named them.
      store: "interiors",
      bucket: env.APP_BUILDS,
      prefix: `interiors/${ownerHash}/`,
    },
    {
      // New mini-app builds are owner-addressable before the callback exists,
      // so a crash orphan is still discoverable by account reset/deletion.
      store: "app-builds",
      bucket: env.APP_BUILDS,
      prefix: `${ownerAppBuildRoot(ownerHash)}/`,
    },
  ];
  for (const target of prefixTargets) {
    // An unbound bucket is a deployment that has no such store, not a store
    // that failed to empty.
    if (!target.bucket) continue;
    try {
      const swept = await sweepR2Prefix(target.bucket, target.prefix);
      deleted += swept.deleted;
      if (!swept.done) pending.push(target.store);
    } catch (error) {
      fail(target.store, error);
    }
  }

  // The world checkpoint. The archive is named only by the descriptor, so the
  // descriptor is deleted last: a crash between the two leaves a KV key
  // pointing at bytes that are already gone (harmless — restore fails and the
  // world starts cold), never bytes with nothing left that names them.
  await (async (): Promise<void> => {
    const store = "checkpoint:world";
    try {
      const key = await checkpointKey(ownerId);
      const nativePurge = await purgeNativeStateForWorkspace(env, key);
      deleted += nativePurge.deleted + nativePurge.keys;
      const descriptor = await env.APP_ROUTES.get<DirectoryBackup>(key, "json");
      const debtKey = backupDebtKey(key);
      const debt = await env.APP_ROUTES.get<WorkspaceBackupDebt>(
        debtKey,
        "json",
      );
      const importsKey = checkpointImportsKey(key);
      const imports = await env.APP_ROUTES.get<WorkspaceCheckpointImports>(
        importsKey,
        "json",
      );
      const recovery = collectCheckpointRecoveryReferences({
        ...(descriptor?.id ? { descriptorId: descriptor.id } : {}),
        debtBackupIds: debt?.backupIds,
        historicalBackupName: checkpointBackupName(key),
        imports: (imports?.imports ?? []).map((imported) => ({
          ...(imported.descriptor?.id
            ? { descriptorId: imported.descriptor.id }
            : {}),
          backupIds: imported.backupIds,
          historicalBackupName: imported.historicalBackupName,
        })),
      });
      let backupSweepFailed = false;
      for (const backupId of recovery.backupIds) {
        if (!BACKUP_ID_PATTERN.test(backupId)) {
          pending.push(`${store}:invalid-backup`);
          backupSweepFailed = true;
          continue;
        }
        const swept = await sweepR2Prefix(
          env.BACKUP_BUCKET,
          `backups/${backupId}/`,
        );
        deleted += swept.deleted;
        if (!swept.done) {
          pending.push(store);
          backupSweepFailed = true;
        }
      }
      if (backupSweepFailed) return;
      let historicalSweepFailed = false;
      for (const historicalName of recovery.historicalBackupNames) {
        const historical = await sweepBackupsByName(
          env.BACKUP_BUCKET,
          historicalName,
        );
        deleted += historical.deleted;
        if (!historical.done) {
          pending.push(`${store}:historical-backups`);
          historicalSweepFailed = true;
        }
      }
      if (historicalSweepFailed) return;
      await env.APP_ROUTES.delete(key);
      await env.APP_ROUTES.delete(debtKey);
      await env.APP_ROUTES.delete(importsKey);
      await env.APP_ROUTES.delete(workspaceTransferReceiptsKey(key));
      // Counted only when there was something to delete: `deleted` is read off
      // the log to see how much an account actually held, and a fixed number
      // of unconditional KV deletes would drown that.
      if (descriptor) deleted += 1;
    } catch (error) {
      fail(store, error);
    }
  })();

  // Hosted app routes. Deleting the row is strictly stronger than suspending
  // it, and the ownership check keeps a slug that has since been reissued to
  // someone else out of this owner's deletion.
  for (const slug of request.appSlugs ?? []) {
    if (typeof slug !== "string" || !APP_SLUG_PATTERN.test(slug)) {
      pending.push("route:unparseable");
      continue;
    }
    const store = `route:${slug}`;
    try {
      const route = await env.APP_ROUTES.get<{ ownerId?: string }>(
        `app:${slug}`,
        "json",
      );
      if (route && route.ownerId !== ownerId) continue;
      await env.APP_ROUTES.delete(`app:${slug}`);
      if (route) deleted += 1;
    } catch (error) {
      fail(store, error);
    }
  }

  // Build artifacts: the owner's app code and assets, still served by the
  // apps host until they are gone.
  const interiorOwnerPrefix = `interiors/${ownerHash}/`;
  for (const prefix of request.buildPrefixes ?? []) {
    if (
      typeof prefix !== "string" ||
      !(
        LEGACY_BUILD_PREFIX_PATTERN.test(prefix) ||
        isOwnerAppBuildPrefix(prefix, ownerHash) ||
        (INTERIOR_BUILD_PREFIX_PATTERN.test(prefix) &&
          prefix.startsWith(interiorOwnerPrefix))
      )
    ) {
      pending.push("build:unparseable");
      continue;
    }
    try {
      const swept = await sweepR2Prefix(env.APP_BUILDS, `${prefix}/`);
      deleted += swept.deleted;
      if (!swept.done) pending.push(`build:${prefix}`);
    } catch (error) {
      fail(`build:${prefix}`, error);
    }
  }

  return { ok: true, deleted, pending: Array.from(new Set(pending)) };
};

const boundedIngressRequest = async (
  request: Request,
  maxBytes: number,
): Promise<Request | Response> => {
  try {
    return await bufferBoundedJsonRequest(request, maxBytes);
  } catch (error) {
    const status = boundedBodyStatus(error);
    if (status === null) throw error;
    return json(
      {
        code: status === 413 ? "request_too_large" : "bad_request",
        message:
          status === 413
            ? "Request body is too large."
            : "Malformed JSON request.",
      },
      status,
    );
  }
};

const parseWorldPushListing = (value: unknown): WorldListingEntry[] | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = (value as Record<string, unknown>).entries;
  if (!Array.isArray(entries) || entries.length > 200_000) return null;
  const parsed: WorldListingEntry[] = [];
  for (const value of entries) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const row = value as Record<string, unknown>;
    if (
      typeof row.path !== "string" ||
      (row.kind !== "file" && row.kind !== "dir" && row.kind !== "symlink") ||
      !Number.isSafeInteger(row.mode) ||
      !Number.isSafeInteger(row.mtime) ||
      !Number.isSafeInteger(row.size) ||
      Number(row.size) < 0 ||
      (row.kind === "file" &&
        (typeof row.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(row.sha256))) ||
      (row.kind === "symlink" && typeof row.target !== "string")
    )
      return null;
    parsed.push({
      path: row.path,
      kind: row.kind,
      mode: Number(row.mode),
      mtime: Number(row.mtime),
      size: Number(row.size),
      ...(typeof row.sha256 === "string" ? { sha256: row.sha256 } : {}),
      ...(typeof row.target === "string" ? { target: row.target } : {}),
    });
  }
  return parsed;
};

const handleWorldRoute = async (
  request: Request,
  env: Env,
  world: string,
  action: "export" | "push",
): Promise<Response> => {
  const authorization = await verifyWorldCapability({
    secret: env.BUILDER_SERVICE_SECRET,
    capability: worldCapabilityFromRequest(request),
    worldName: world,
    now: Date.now(),
  }).catch(() => ({ ok: false as const }));
  if (!authorization.ok)
    return json({ error: "World capability was rejected." }, 403);
  const stub = env.WORLDS.getByName(world);
  if (action === "export") {
    if (request.method !== "GET")
      return json({ error: "Method not allowed." }, 405);
    const manifestId = new URL(request.url).searchParams.get("manifest");
    if (!manifestId || !(await stub.manifest(manifestId, { limit: 1 }))) {
      return json({ error: "World manifest was not found." }, 404);
    }
    return new Response(await stub.exportTar(manifestId), {
      headers: {
        "content-type": "application/x-tar",
        "cache-control": "private, no-store",
        "x-stella-world-manifest": manifestId,
      },
    });
  }
  if (request.method !== "POST")
    return json({ error: "Method not allowed." }, 405);
  const blobSha = request.headers.get("x-stella-world-blob-sha256");
  if (blobSha) {
    if (!/^[0-9a-f]{64}$/u.test(blobSha) || !request.body)
      return json({ error: "Malformed world blob upload." }, 400);
    const upload = await stub.beginBlob();
    const reader = request.body.getReader();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      for (
        let offset = 0;
        offset < part.value.byteLength;
        offset += 8 * 1024 * 1024
      ) {
        await stub.appendBlob(
          upload.uploadId,
          part.value.subarray(offset, offset + 8 * 1024 * 1024),
        );
      }
    }
    await stub.finishBlob(upload.uploadId, { sha256: blobSha });
    return json({ ok: true });
  }
  const listing = parseWorldPushListing(await request.json().catch(() => null));
  if (!listing) return json({ error: "Malformed world listing." }, 400);
  const delta = await stub.diff(listing);
  const changed = new Set(delta.changed);
  const pushed = await stub.pushDiff({
    entries: listing.filter((entry) => changed.has(entry.path)),
    deleted: delta.deleted,
  });
  return json({ ok: pushed.missingBlobs.length === 0, ...pushed });
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    log("info", "request_started", {
      requestId,
      method: request.method,
      path: previewSafeRequestLogPath(url.pathname),
    });
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, service: "stella-v2-cloud-builder" });
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      const readiness = evaluateCloudBuilderReadiness(env);
      return json(
        {
          ok: readiness.ready,
          service: "stella-v2-cloud-builder",
          checks: {
            missing: readiness.missing,
            invalid: readiness.invalid,
          },
        },
        readiness.ready ? 200 : 503,
      );
    }

    const worldRoute =
      /^\/internal\/worlds\/([0-9a-f]{64}:[0-9a-f]{64})\/(export|push)$/u.exec(
        url.pathname,
      );
    if (worldRoute) {
      return await handleWorldRoute(
        request,
        env,
        worldRoute[1]!,
        worldRoute[2] === "export" ? "export" : "push",
      );
    }

    const vitePreviewMatch = url.pathname.match(
      /^\/internal\/previews\/([A-Za-z0-9._~-]{1,128})\/(pv1\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{43})(\/.*)?$/,
    );
    if (vitePreviewMatch) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "Method not allowed." }, 405);
      }
      const routing = await verifyPreviewAccessRouteCapability({
        capability: vitePreviewMatch[2]!,
        secret: env.BUILDER_SERVICE_SECRET,
        expectedBuildSessionName: vitePreviewMatch[1]!,
        now: Date.now(),
      }).catch(() => ({ ok: false as const, code: "bad_signature" as const }));
      if (!routing.ok) {
        return json({ error: "Preview access was rejected." }, 403);
      }
      const forwardedHeaders = new Headers();
      for (const name of ["accept", "accept-language", "range"]) {
        const value = request.headers.get(name);
        if (value) forwardedHeaders.set(name, value);
      }
      forwardedHeaders.set(HEADER_PREVIEW_CAPABILITY, vitePreviewMatch[2]!);
      const suffix = vitePreviewMatch[3] || "/";
      return await env.BUILD_SESSIONS.getByName(vitePreviewMatch[1]!).fetch(
        `https://build-session/vite-preview${suffix}${url.search}`,
        {
          method: request.method,
          headers: forwardedHeaders,
        },
      );
    }

    // ── User-authenticated routes ─────────────────────────────────────────
    // These MUST stay above the service-secret gate below: a signed-in user
    // presents a Convex JWT, not the shared secret, so matching them after the
    // gate would 401 every client. Both verify the JWT themselves and forward
    // the proven identity to the DO in x-stella-* headers, stripping whatever
    // the client sent under those names first.
    if (url.pathname === "/dictation/socket") {
      if (request.method !== "GET" || !isWebSocketUpgrade(request)) {
        return json({ error: "This endpoint speaks WebSocket only." }, 426);
      }
      const auth = await authenticateConversationCaller(
        request,
        env,
        true,
        requestId,
      );
      if (!auth.ok) return auth.response;
      return await handleMuseTranscribeSocket({
        request,
        env,
        ownerId: auth.caller.ownerId,
        waitUntil: (promise) => ctx.waitUntil(promise),
      });
    }
    const presenceMatch = url.pathname.match(
      /^\/owners\/me\/devices\/([A-Za-z0-9._~-]{1,256})\/presence$/,
    );
    if (presenceMatch) {
      if (request.method !== "GET" || !isWebSocketUpgrade(request)) {
        return json({ error: "This endpoint speaks WebSocket only." }, 426);
      }
      const auth = await authenticateConversationCaller(
        request,
        env,
        true,
        requestId,
      );
      if (!auth.ok) return auth.response;
      return await forwardToDevicePresence(
        request,
        env,
        presenceMatch[1]!,
        auth.caller,
      );
    }
    if (request.method === "GET" && url.pathname === DEVICES_PATH) {
      const auth = await authenticateConversationCaller(
        request,
        env,
        false,
        requestId,
      );
      if (!auth.ok) return auth.response;
      try {
        return Response.json(
          await env.OWNER_GATES.getByName(auth.caller.ownerId).devices(),
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        log("error", "owner_devices_failed", {
          requestId,
          message: error instanceof Error ? error.message : String(error),
        });
        return Response.json(
          {
            protocol: PLACEMENT_PROTOCOL,
            error: "Stella can't list your computers right now.",
          },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
    }
    // Placement. `POST` accepts the service secret as well as a user JWT, so
    // it sits here with the other self-authenticating routes rather than
    // behind the shared-secret gate below.
    if (request.method === "POST" && url.pathname === DISPATCH_SUBMIT_PATH) {
      return await handleDispatchSubmitRoute(request, env, requestId);
    }
    // Dispatch ids carry a colon (`dsp:<uuid>`), and every client builds this
    // path with `encodeURIComponent`, so the segment arrives as `dsp%3A…`.
    // The class admits the escape and the handler decodes it; a pattern that
    // rejected `%` let every status poll fall through to the service gate.
    const dispatchMatch = url.pathname.match(
      /^\/owners\/me\/dispatches\/([A-Za-z0-9._:~%-]{1,96})(\/cancel)?$/,
    );
    if (dispatchMatch) {
      const cancel = Boolean(dispatchMatch[2]);
      if (cancel ? request.method !== "POST" : request.method !== "GET") {
        return json({ error: "Method not allowed." }, 405);
      }
      return await handleDispatchControlRoute(
        request,
        env,
        decodeURIComponent(dispatchMatch[1]!),
        cancel ? "cancel" : "status",
        requestId,
      );
    }
    const socketMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/socket$/,
    );
    if (socketMatch) {
      const conversationId = conversationName(socketMatch[1]!);
      if (request.method !== "GET" || !isWebSocketUpgrade(request)) {
        return json({ error: "This endpoint speaks WebSocket only." }, 426);
      }
      const auth = await authenticateConversationCaller(
        request,
        env,
        true,
        requestId,
      );
      if (!auth.ok) return auth.response;
      return await forwardToConversation(
        request,
        env,
        conversationId,
        "/socket",
        auth.caller,
      );
    }
    const turnStartMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/turns$/,
    );
    if (request.method === "POST" && turnStartMatch) {
      return await handleTurnStartRoute(
        request,
        env,
        turnStartMatch[1]!,
        requestId,
      );
    }
    const historyMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/history$/,
    );
    if (request.method === "GET" && historyMatch) {
      const auth = await authenticateConversationCaller(
        request,
        env,
        false,
        requestId,
      );
      if (!auth.ok) return auth.response;
      return await forwardToConversation(
        request,
        env,
        conversationName(historyMatch[1]!),
        "/history",
        auth.caller,
      );
    }
    const journalAppendMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/journal$/,
    );
    if (request.method === "POST" && journalAppendMatch) {
      const auth = await authenticateConversationCaller(
        request,
        env,
        false,
        requestId,
      );
      if (!auth.ok) return auth.response;
      const bodyLimit = publicJsonBodyLimit(request.method, url.pathname)!;
      const bounded = await boundedIngressRequest(request, bodyLimit);
      if (bounded instanceof Response) return bounded;
      return await forwardToConversation(
        bounded,
        env,
        conversationName(journalAppendMatch[1]!),
        "/journal",
        auth.caller,
      );
    }
    const localTurnMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/local-turns\/(begin|finish)$/,
    );
    if (request.method === "POST" && localTurnMatch) {
      const timingStartedAt = performance.now();
      const auth = await authenticateConversationCaller(
        request,
        env,
        false,
        requestId,
      );
      if (!auth.ok) return auth.response;
      const authMs = Math.round(performance.now() - timingStartedAt);
      const bodyLimit = publicJsonBodyLimit(request.method, url.pathname)!;
      const bounded = await boundedIngressRequest(request, bodyLimit);
      if (bounded instanceof Response) return bounded;
      const forwardStartedAt = performance.now();
      const response = await forwardToConversation(
        bounded,
        env,
        conversationName(localTurnMatch[1]!),
        `/local-turns/${localTurnMatch[2]!}`,
        auth.caller,
      );
      log("info", "conversation_local_turn_request_timing", {
        requestId,
        operation: localTurnMatch[2]!,
        status: response.status,
        authMs,
        durableObjectMs: Math.round(performance.now() - forwardStartedAt),
        totalMs: Math.round(performance.now() - timingStartedAt),
      });
      return response;
    }
    if (url.pathname.startsWith("/cloud-home/")) {
      const auth = await authenticateConversationCaller(
        request,
        env,
        false,
        requestId,
      );
      if (!auth.ok) return auth.response;
      const response = await handleUserCloudHomeRoute({
        request,
        env,
        ownerId: auth.caller.ownerId,
        // `ownerId` is the full Convex tokenIdentifier; the raw JWT `sub` is
        // deliberately insufficient for a cross-issuer session fence.
        subject: auth.caller.ownerId,
        withLease: cloudHomeLeaseRunner(env),
      });
      if (response) return response;
    }

    // ── Service-secret gate ───────────────────────────────────────────────
    // Sandbox-originated broker calls authenticate with their one-time
    // capability inside the exact BuildSession. They intentionally sit above
    // the service-secret gate; no other route shares this exception.
    const publicTurnBrokerMatch = url.pathname.match(
      /^\/sessions\/([A-Za-z0-9._~-]{1,128})\/turn-broker$/,
    );
    if (publicTurnBrokerMatch) {
      const brokerSessionId = publicTurnBrokerMatch[1]!;
      const response = await env.BUILD_SESSIONS.getByName(
        brokerSessionId,
      ).fetch(new Request("https://build-session/turn-broker", request));
      if (devAcceptanceProbesEnabled(env)) {
        const diagnosticTarget = validateTurnBrokerTarget(
          request.headers.get(TURN_BROKER_HEADERS.targetMethod),
          request.headers.get(TURN_BROKER_HEADERS.targetPath),
        );
        // The outer Worker sees only the broker's already-scrubbed response.
        // Record an allowlisted target kind and numeric status for preview
        // acceptance without reading token-bearing data or the response body.
        log("info", "turn_broker_public_response", {
          threadId: brokerSessionId,
          targetKind: diagnosticTarget?.kind ?? "rejected",
          status: response.status,
        });
      }
      return response;
    }
    // Everything past this check is server-to-server. Nothing may fall
    // through it without another explicit authentication boundary.
    if (
      !(await verifyServiceBearerRequest(request, env.BUILDER_SERVICE_SECRET))
    ) {
      return json({ error: "Unauthorized." }, 401);
    }
    const serviceBodyLimit = serviceJsonBodyLimit(request.method, url.pathname);
    if (serviceBodyLimit !== null) {
      const bounded = await boundedIngressRequest(request, serviceBodyLimit);
      if (bounded instanceof Response) return bounded;
      request = bounded;
    }
    if (
      request.method === "POST" &&
      [
        "/internal/interactions/status",
        "/internal/interactions/live-view",
        "/internal/interactions/session-transfer-capability",
        "/internal/interactions/session-transfer",
        "/internal/interactions/decision",
        "/internal/owners/profile/reset",
      ].includes(url.pathname)
    ) {
      if (!env.BROWSER_GATEWAY) {
        return json(
          { code: "unavailable", message: "Cloud browser is unavailable." },
          503,
        );
      }
      if (
        !/^application\/json(?:\s*;|$)/iu.test(
          request.headers.get("content-type") ?? "",
        )
      ) {
        return json(
          { code: "bad_request", message: "JSON request required." },
          415,
        );
      }
      const body = await request.arrayBuffer();
      if (body.byteLength === 0 || body.byteLength > 64 * 1024) {
        return json(
          { code: "bad_request", message: "Malformed request." },
          400,
        );
      }
      try {
        const upstream = await env.BROWSER_GATEWAY.fetch(
          `https://browser-gateway${url.pathname}`,
          {
            method: "POST",
            redirect: "manual",
            headers: { "content-type": "application/json" },
            body,
          },
        );
        if (upstream.status >= 300 && upstream.status < 400) {
          await upstream.body?.cancel().catch(() => undefined);
          return json(
            {
              code: "upstream_failure",
              message: "Cloud browser response was invalid.",
            },
            502,
          );
        }
        let upstreamBody: Uint8Array;
        try {
          upstreamBody = await readBoundedResponseBytes(upstream, 64 * 1024);
        } catch (error) {
          if (!(error instanceof BoundedBodyError)) throw error;
          return json(
            {
              code: "upstream_failure",
              message: "Cloud browser response was invalid.",
            },
            502,
          );
        }
        return new Response(upstreamBody, {
          status: upstream.status,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
          },
        });
      } catch {
        log("error", "browser_gateway_control_failed", {
          requestId,
          path: url.pathname,
          errorCode: "BROWSER_GATEWAY_UPSTREAM_FAILURE",
        });
        return json(
          {
            code: "upstream_failure",
            message: "Cloud browser request failed.",
          },
          502,
        );
      }
    }
    if (
      request.method === "POST" &&
      url.pathname === "/internal/owners/activity/register"
    ) {
      const body = (await request.json().catch(() => null)) as {
        ownerId?: unknown;
        activityId?: unknown;
        ownerGeneration?: unknown;
      } | null;
      const ownerId =
        typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
      const activityId =
        typeof body?.activityId === "string" ? body.activityId.trim() : "";
      const ownerGeneration =
        normalizeOwnerGeneration(body?.ownerGeneration) ?? "";
      if (
        !ownerId ||
        ownerId.length > 512 ||
        !activityId ||
        activityId.length > 512 ||
        !ownerGeneration ||
        ownerGeneration.length > 512
      ) {
        return json(
          { code: "bad_request", message: "Malformed request." },
          400,
        );
      }
      const leaseId = crypto.randomUUID();
      const sessionId = `control-plane:${activityId}`;
      const turnId = activityId;
      const expiresAt = Date.now() + 9 * 60_000;
      const registered = await callOwnerFence(env, ownerId, "register", {
        leaseId,
        sessionId,
        turnId,
        ownerGeneration,
        namespace: "activity",
        role: "activity",
        expiresAt,
      });
      const registration = (await registered.json().catch(() => null)) as {
        generation?: string;
      } | null;
      if (!registered.ok || !registration?.generation) {
        return json(
          {
            code: "owner_purge",
            message: "Account data is being deleted or reset.",
          },
          409,
        );
      }
      return json({
        ownerId,
        ownerGeneration,
        generation: registration.generation,
        leaseId,
        sessionId,
        turnId,
        expiresAt,
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/internal/owners/activity/unregister"
    ) {
      const body = (await request.json().catch(() => null)) as {
        ownerId?: unknown;
        ownerGeneration?: unknown;
        generation?: unknown;
        leaseId?: unknown;
        sessionId?: unknown;
        turnId?: unknown;
      } | null;
      const ownerId =
        typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
      const generation =
        typeof body?.generation === "string" ? body.generation.trim() : "";
      const ownerGeneration =
        normalizeOwnerGeneration(body?.ownerGeneration) ?? "";
      const leaseId =
        typeof body?.leaseId === "string" ? body.leaseId.trim() : "";
      const sessionId =
        typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      const turnId = typeof body?.turnId === "string" ? body.turnId.trim() : "";
      if (
        !ownerId ||
        !ownerGeneration ||
        !generation ||
        !leaseId ||
        !sessionId ||
        !turnId
      ) {
        return json(
          { code: "bad_request", message: "Malformed request." },
          400,
        );
      }
      const unregistered = await callOwnerFence(env, ownerId, "unregister", {
        generation,
        ownerGeneration,
        leaseId,
        sessionId,
        turnId,
      });
      return unregistered.ok
        ? json({ unregistered: true })
        : json(
            {
              code: "owner_purge",
              message: "Account activity lease could not be released.",
            },
            409,
          );
    }
    if (
      request.method === "POST" &&
      url.pathname === "/internal/conversation-edits/run"
    ) {
      const edit = parseConversationEditRequest(
        await request.json().catch(() => null),
      );
      if (!edit) {
        return json(
          { code: "bad_request", message: "Malformed conversation edit." },
          400,
        );
      }
      try {
        const result = await withOwnerActivityLease(
          env,
          edit.ownerId,
          edit.ownerGeneration,
          `conversation-edit:${edit.operationId}`,
          async () => await runConversationEdit(env, edit),
        );
        return json(result, result.complete ? 200 : 202);
      } catch (error) {
        return conversationEditErrorResponse(error);
      }
    }
    const ownerTransferMatch = url.pathname.match(
      /^\/internal\/conversations\/([^/]+)\/transfer-owner$/,
    );
    if (request.method === "POST" && ownerTransferMatch) {
      const conversationId = ownerTransferMatch[1]!;
      const rawBody = await request.text();
      const transfer = parseOwnerTransferRequest(
        await new Response(rawBody).json().catch(() => null),
      );
      if (!transfer) {
        return json(
          { code: "bad_request", message: "Malformed request." },
          400,
        );
      }
      const coordinator = await createTransferCoordinatorContext({
        env,
        control: transferControl(transfer),
        fromOwnerId: transfer.fromOwnerId,
        toOwnerId: transfer.toOwnerId,
        operationScope: `conversation:${conversationId}`,
        plan: { kind: "conversation", conversationId },
      });
      try {
        const reserved = await callTransferCoordinator(coordinator, "/reserve");
        const reservation = (await reserved
          .clone()
          .json()
          .catch(() => null)) as {
          status?: string;
          result?: unknown;
        } | null;
        if (!reserved.ok) return reserved;
        if (
          reservation?.status === "copy_complete" ||
          reservation?.status === "acknowledged"
        ) {
          const replay = reservation.result as Record<string, unknown> | null;
          return replay?.transferred === true
            ? json(replay)
            : json(
                {
                  code: "owner_transfer_failed",
                  message:
                    "The durable conversation transfer receipt is invalid.",
                },
                502,
              );
        }
        const forwarded = await env.ORCHESTRATOR_SESSIONS.getByName(
          conversationName(conversationId),
        ).fetch("https://orchestrator-session/internal/transfer-owner", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: rawBody,
        });
        const verdict = (await forwarded
          .clone()
          .json()
          .catch(() => null)) as {
          transferred?: unknown;
          code?: unknown;
        } | null;
        if (forwarded.ok && verdict?.transferred === true) {
          const result = {
            transferred: true,
            transferOperationId: coordinator.operationId,
            transferPlanFingerprint: coordinator.planFingerprint,
            ackRequired: true,
          };
          const copied = await callTransferCoordinator(coordinator, "/copied", {
            result,
          });
          if (!copied.ok) {
            return copied;
          }
          return json(result);
        }
        if (
          forwarded.status === 409 &&
          (verdict?.code === "owner_mismatch" ||
            verdict?.code === "owner_transfer_conflict")
        ) {
          await abortTransferCoordinator(coordinator, true);
        } else {
          await yieldTransferCoordinator(coordinator);
        }
        return forwarded;
      } catch (error) {
        await yieldTransferCoordinator(coordinator);
        log("error", "conversation_owner_transfer_failed", {
          requestId,
          operationRef: coordinator.operationId.slice(0, 16),
          message: errorMessage(error),
        });
        return json(
          {
            code: "transfer_unavailable",
            message:
              "Conversation ownership transfer is temporarily unavailable.",
            retryAfterMs: 5_000,
          },
          503,
        );
      }
    }
    if (
      request.method === "POST" &&
      url.pathname === "/internal/owners/transfer-product-state"
    ) {
      const transfer = parseOwnerProductTransferRequest(
        await request.json().catch(() => null),
      );
      if (!transfer) {
        return json(
          { code: "bad_request", message: "Malformed request." },
          400,
        );
      }
      const coordinator = await createTransferCoordinatorContext({
        env,
        control: transferControl(transfer),
        fromOwnerId: transfer.fromOwnerId,
        toOwnerId: transfer.toOwnerId,
        operationScope: `product:${await stableValueMarker({
          agentHome: transfer.agentHome,
          interiors: transfer.interiors,
          world: transfer.world,
          appSlugs: transfer.appSlugs,
        })}`,
        plan: {
          kind: "product",
          agentHome: transfer.agentHome,
          interiors: transfer.interiors,
          world: transfer.world,
          appSlugs: transfer.appSlugs,
        },
      });
      try {
        const reserved = await callTransferCoordinator(coordinator, "/reserve");
        const reservation = (await reserved
          .clone()
          .json()
          .catch(() => null)) as {
          status?: string;
          result?: unknown;
          reservation?: unknown;
        } | null;
        if (!reserved.ok) return reserved;
        if (
          reservation?.status === "copy_complete" ||
          reservation?.status === "acknowledged"
        ) {
          const replay = reservation.result as Record<string, unknown> | null;
          return replay?.transferred === true
            ? json(replay)
            : json(
                {
                  code: "owner_transfer_failed",
                  message: "The durable product transfer receipt is invalid.",
                },
                502,
              );
        }
        coordinator.reservation =
          parseTransferReservationEnvelope(
            reservation?.reservation,
            coordinator.operationId,
          ) ?? undefined;
        if (!coordinator.reservation) {
          await yieldTransferCoordinator(coordinator);
          return json(
            {
              code: "transfer_unavailable",
              message: "The durable product transfer reservation is invalid.",
              retryAfterMs: 5_000,
            },
            503,
          );
        }
        const result = await transferOwnerProductStorage(
          env,
          transfer,
          coordinator,
        );
        if (!result.complete) {
          await yieldTransferCoordinator(coordinator);
          return json(
            {
              transferred: false,
              code: "copy_in_progress",
              message: "Owner product state copy is still in progress.",
              retryAfterMs: 1_000,
            },
            202,
          );
        }
        const response = {
          transferred: true,
          ...result,
          transferOperationId: coordinator.operationId,
          transferPlanFingerprint: coordinator.planFingerprint,
          ackRequired: true,
        };
        const copied = await callTransferCoordinator(coordinator, "/copied", {
          result: response,
        });
        if (!copied.ok) {
          return copied;
        }
        return json(response);
      } catch (error) {
        if (error instanceof OwnerProductTransferConfigurationError) {
          await yieldTransferCoordinator(coordinator);
          return json(
            {
              code: "missing_binding",
              message: error.message,
              retryAfterMs: 60_000,
            },
            503,
          );
        }
        if (error instanceof OwnerProductTransferConflictError) {
          const retryable =
            error.code === "owner_purge_temporary" ||
            error.code === "transfer_busy";
          log("info", "owner_product_transfer_conflict", {
            requestId,
            operationRef: coordinator.operationId.slice(0, 16),
            code: error.code,
          });
          if (retryable) {
            await yieldTransferCoordinator(coordinator);
          } else {
            await abortTransferCoordinator(coordinator, true);
          }
          return json(
            {
              code: error.code,
              message: error.message,
              ...(retryable ? { retryAfterMs: 5_000 } : {}),
            },
            409,
          );
        }
        await yieldTransferCoordinator(coordinator);
        log("error", "owner_product_transfer_failed", {
          requestId,
          operationRef: coordinator.operationId.slice(0, 16),
          message: errorMessage(error),
        });
        return json(
          {
            code: "transfer_unavailable",
            message: "Owner product state transfer failed.",
            retryAfterMs: 5_000,
          },
          503,
        );
      }
    }
    if (
      request.method === "POST" &&
      url.pathname === "/internal/owners/transfer-ack"
    ) {
      const body = (await request.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const control = body ? parseOwnerTransferControl(body) : null;
      const fromOwnerId =
        typeof body?.fromOwnerId === "string" ? body.fromOwnerId.trim() : "";
      const toOwnerId =
        typeof body?.toOwnerId === "string" ? body.toOwnerId.trim() : "";
      const operationId =
        typeof body?.transferOperationId === "string"
          ? body.transferOperationId
          : "";
      const planFingerprint =
        typeof body?.transferPlanFingerprint === "string"
          ? body.transferPlanFingerprint
          : "";
      if (
        !control ||
        !fromOwnerId ||
        !toOwnerId ||
        fromOwnerId === toOwnerId ||
        fromOwnerId.length > 512 ||
        toOwnerId.length > 512 ||
        !OWNER_TRANSFER_OPERATION_ID_PATTERN.test(operationId) ||
        !OWNER_TRANSFER_OPERATION_ID_PATTERN.test(planFingerprint)
      ) {
        return json(
          { code: "bad_request", message: "Malformed request." },
          400,
        );
      }
      const attempt = await createCoordinatorAttempt({
        control,
        operationId,
        planFingerprint,
        fromOwnerId,
        toOwnerId,
      });
      return await env.OWNER_TRANSFER_COORDINATORS.getByName(
        `owner-transfer-${operationId}`,
      ).fetch("https://owner-transfer-coordinator/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attempt }),
      });
    }
    if (request.method === "POST" && url.pathname === "/m0/echo") {
      return env.BUILD_SESSIONS.getByName("m0-echo").fetch(
        "https://build-session/echo",
        {
          method: "POST",
        },
      );
    }
    const turnMatch = url.pathname.match(/^\/sessions\/([^/]+)\/turns$/);
    if (request.method === "POST" && turnMatch) {
      const buildSessionName = turnMatch[1]!;
      if (!/^[A-Za-z0-9._~-]{1,128}$/.test(buildSessionName)) {
        return json({ error: "Invalid build session name." }, 400);
      }
      const turnBrokerEndpoint = new URL(
        `/sessions/${encodeURIComponent(buildSessionName)}/turn-broker`,
        url.origin,
      ).toString();
      const previewBaseUrl = new URL(
        `/internal/previews/${encodeURIComponent(buildSessionName)}/`,
        url.origin,
      ).toString();
      const text = await request.text();
      // Convex's desktop dispatch, execution placement's agent branch and a
      // hosted-browser resume all arrive here. Refuse a malformed agent body
      // at the edge rather than instantiating the session for it; the session
      // repeats the same parse, because it trusts nothing it did not check.
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return json({ error: "Malformed JSON request." }, 400);
      }
      if (
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        (payload as { kind?: unknown }).kind === "agent"
      ) {
        const parsed = parseCloudAgentTurnStartRequest(payload);
        if (!parsed.ok) return json({ error: parsed.message }, 400);
        if (parsed.request.threadId !== buildSessionName) {
          return json(
            { error: "threadId must match the session in the path." },
            400,
          );
        }
      }
      // Built from scratch: nothing the caller sent may reach the session
      // under a trusted name, including the orchestrator's gate-admitted
      // marker — a turn that comes through this route is admitted there.
      return env.BUILD_SESSIONS.getByName(buildSessionName).fetch(
        "https://build-session/turn",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [HEADER_BUILD_SESSION_NAME]: buildSessionName,
            [HEADER_TURN_BROKER_ENDPOINT]: turnBrokerEndpoint,
            [HEADER_PREVIEW_BASE_URL]: previewBaseUrl,
          },
          body: text,
        },
      );
    }
    // Convex learned an owner's plan, generation, engines or pairing changed.
    // A complete push pre-warms the gate; a snapshot-less push marks it stale.
    if (
      request.method === "POST" &&
      url.pathname === BUILDER_OWNER_SNAPSHOT_CHANGED_PATH
    ) {
      const body = (await request
        .json()
        .catch(() => null)) as Partial<OwnerSnapshotChangedRequest> | null;
      const ownerId =
        typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
      if (!ownerId || ownerId.length > 512) {
        return json({ error: "ownerId is required." }, 400);
      }
      const gate = env.OWNER_GATES.getByName(ownerId);
      if (body?.snapshot !== undefined) {
        const snapshot = parseOwnerSnapshot(body.snapshot, ownerId);
        if (!snapshot) {
          return json({ error: "snapshot is malformed." }, 400);
        }
        await gate.replaceSnapshot(snapshot);
      } else {
        await gate.invalidate();
      }
      log("info", "owner_snapshot_changed", {
        requestId,
        reason: typeof body?.reason === "string" ? body.reason : "unknown",
        pushedSnapshot: body?.snapshot !== undefined,
      });
      return json({ ok: true });
    }
    const chatCancelMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/cancel$/,
    );
    if (request.method === "POST" && chatCancelMatch) {
      return env.ORCHESTRATOR_SESSIONS.getByName(
        conversationName(chatCancelMatch[1]!),
      ).fetch("https://orchestrator-session/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Exact placement turn + cancellation identity must survive the
        // gateway. Dropping this body regresses to conversation-wide Stop and
        // can cancel a newer turn after a delayed retry.
        body: await request.text(),
      });
    }
    // Convex-driven writes into a conversation's journal, plus the operator
    // surfaces. Pure pass-throughs: the DO owns every decision, this worker
    // only proves the caller holds the service secret.
    const conversationAdminMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/(cards|purge)$/,
    );
    if (request.method === "POST" && conversationAdminMatch) {
      return env.ORCHESTRATOR_SESSIONS.getByName(
        conversationName(conversationAdminMatch[1]!),
      ).fetch(`https://orchestrator-session/${conversationAdminMatch[2]!}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await request.text(),
      });
    }
    const devAcceptanceProbeMatch = url.pathname.match(
      /^\/internal\/dev-acceptance\/conversations\/([^/]+)\/probe$/,
    );
    if (request.method === "POST" && devAcceptanceProbeMatch) {
      // Hide the route entirely unless this exact deployment was built as a
      // non-production acceptance target. The DO repeats this gate and checks
      // the disposable owner/conversation markers before any side effect.
      if (!devAcceptanceProbesEnabled(env)) {
        return json({ error: "Not found." }, 404);
      }
      return env.ORCHESTRATOR_SESSIONS.getByName(
        conversationName(devAcceptanceProbeMatch[1]!),
      ).fetch("https://orchestrator-session/internal/dev-acceptance/probe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-acceptance-service-secret": env.BUILDER_SERVICE_SECRET,
        },
        body: await request.text(),
      });
    }
    // The journal probe reads the canonical journal exactly the way a client
    // does, including through R2 segments.
    const journalProbeMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/journal$/,
    );
    if (request.method === "GET" && journalProbeMatch) {
      const probe = new URL("https://orchestrator-session/journal");
      probe.search = url.search;
      return env.ORCHESTRATOR_SESSIONS.getByName(
        conversationName(journalProbeMatch[1]!),
      ).fetch(probe.toString(), { method: "GET" });
    }
    const steerMatch = url.pathname.match(/^\/sessions\/([^/]+)\/steer$/);
    if (request.method === "POST" && steerMatch) {
      return env.BUILD_SESSIONS.getByName(steerMatch[1]!).fetch(
        "https://build-session/steer",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        },
      );
    }
    const cancelMatch = url.pathname.match(/^\/sessions\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      return env.BUILD_SESSIONS.getByName(cancelMatch[1]!).fetch(
        "https://build-session/cancel",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        },
      );
    }
    // Operator surface for a thread stuck "running": expire its watchdog now.
    // The DO interrupts a hung local fiber and re-arms its alarm so the
    // ordinary timeout path delivers the terminal
    // while the container's teardown stays alarm-owned debt.
    const expireMatch = url.pathname.match(/^\/sessions\/([^/]+)\/expire$/);
    if (request.method === "POST" && expireMatch) {
      return env.BUILD_SESSIONS.getByName(expireMatch[1]!).fetch(
        "https://build-session/expire-agent-turn",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        },
      );
    }
    // Operator surface for a container the inventory says is live but no
    // Durable Object still owns. Wrangler cannot stop one instance and only the
    // sandbox object holds the container handle, so retirement is a keep-alive
    // release plus destroy on the exact tuple, by name.
    if (
      request.method === "POST" &&
      url.pathname === "/internal/sandboxes/retire"
    ) {
      return await retireSandboxInstance(env, request);
    }
    // Owner-level object storage sweep, the storage half of account deletion.
    // Convex holds no credential for any bucket here and cannot enumerate this
    // worker's KV, so everything outside Convex is reached from this one route.
    // See the store table above `OwnerPurgeRequest` for the list it walks and
    // why each entry needs the shape it has.
    //
    // Contract with the caller (convex/cloud_purge.ts):
    //   - It is idempotent. Every step is "delete if present".
    //   - It never reports success it did not achieve: anything it could not
    //     finish comes back in `pending`, and the caller keeps the Convex rows
    //     that name those bytes until a later pass returns `pending: []`.
    //   - The named stores (`appSlugs` and legacy/interior
    //     `buildPrefixes`) cannot all be derived from the owner id, so Convex
    //     reads them off the rows and sends them here BEFORE deleting those
    //     rows. New app builds are additionally swept by their owner-hash root
    //     above, which catches uploads that never acquired a Convex row.
    // Retire ONE superseded build's artifacts. Deliberately not the owner
    // purge: that route fences the owner, refuses while turns run, and walks
    // every store. Activating a new app build must not touch anything else.
    if (
      request.method === "POST" &&
      url.pathname === "/internal/apps/builds/retire"
    ) {
      const body = (await request.json().catch(() => null)) as {
        ownerId?: unknown;
        artifactPrefix?: unknown;
      } | null;
      const ownerId = typeof body?.ownerId === "string" ? body.ownerId : "";
      const prefix =
        typeof body?.artifactPrefix === "string" ? body.artifactPrefix : "";
      if (!ownerId || !prefix) {
        return json({ error: "ownerId and artifactPrefix required." }, 400);
      }
      const ownerHash = await sha256Hex(ownerId);
      if (
        !(
          LEGACY_BUILD_PREFIX_PATTERN.test(prefix) ||
          isOwnerAppBuildPrefix(prefix, ownerHash) ||
          (INTERIOR_BUILD_PREFIX_PATTERN.test(prefix) &&
            prefix.startsWith(`interiors/${ownerHash}/`))
        )
      ) {
        return json({ error: "artifactPrefix does not belong to owner." }, 403);
      }
      try {
        const swept = await sweepR2Prefix(env.APP_BUILDS, `${prefix}/`);
        return json({ ok: true, deleted: swept.deleted, done: swept.done });
      } catch (error) {
        return json({ error: errorMessage(error) }, 503);
      }
    }
    if (request.method === "POST" && url.pathname === "/owners/purge/begin") {
      const body = (await request.json()) as {
        ownerId?: string;
        mode?: OwnerPurgeMode;
        requestId?: string;
        expectedGeneration?: string;
      };
      const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
      const requestId = normalizeOwnerGeneration(body.requestId);
      if (!ownerId || !requestId) {
        return json({ error: "ownerId and requestId required." }, 400);
      }
      try {
        return json(
          await beginOwnerPurge(
            env,
            ownerId,
            body.mode === "permanent" ? "permanent" : "temporary",
            requestId,
            body.expectedGeneration,
          ),
        );
      } catch (error) {
        return json({ error: errorMessage(error) }, 409);
      }
    }
    if (request.method === "POST" && url.pathname === "/owners/purge/release") {
      const body = (await request.json()) as {
        ownerId?: string;
        purgeGeneration?: string;
      };
      const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
      if (!ownerId || !body.purgeGeneration) {
        return json({ error: "ownerId and purgeGeneration required." }, 400);
      }
      const released = await callOwnerFence(env, ownerId, "release", {
        generation: body.purgeGeneration,
      });
      return released;
    }
    if (request.method === "POST" && url.pathname === "/owners/memory-wipe") {
      const body = (await request.json().catch(() => null)) as {
        ownerId?: unknown;
        ownerGeneration?: unknown;
        operationId?: unknown;
        memoryEpoch?: unknown;
        purgeGeneration?: unknown;
        protocolVersion?: unknown;
        cursor?: unknown;
        startAfter?: unknown;
      } | null;
      const ownerId =
        typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
      const ownerGeneration = normalizeOwnerGeneration(body?.ownerGeneration);
      const operationId = normalizeOwnerGeneration(body?.operationId);
      const memoryEpoch = normalizeOwnerGeneration(body?.memoryEpoch);
      const purgeGeneration = normalizeOwnerGeneration(body?.purgeGeneration);
      const cursor = body?.cursor;
      if (
        !ownerId ||
        ownerId.length > 512 ||
        !ownerGeneration ||
        !operationId ||
        !memoryEpoch ||
        !purgeGeneration ||
        body?.protocolVersion !== MEMORY_WIPE_PROTOCOL_VERSION ||
        !Number.isSafeInteger(cursor) ||
        (cursor as number) < 0 ||
        (cursor as number) > MEMORY_WIPE_TARGET_COUNT ||
        (body?.startAfter !== undefined &&
          (typeof body.startAfter !== "string" ||
            body.startAfter.length === 0 ||
            body.startAfter.length > 1_024))
      ) {
        return json({ error: "Malformed memory wipe request." }, 400);
      }
      const fenced = await callOwnerFence(env, ownerId, "assert-blocked", {
        generation: purgeGeneration,
      });
      const fenceState = (await fenced.json().catch(() => null)) as {
        active?: OwnerPurgeFence["active"];
        beginRequestId?: unknown;
      } | null;
      if (
        !fenced.ok ||
        fenceState?.beginRequestId !== `memory-wipe:${operationId}`
      ) {
        return json({ error: "Memory wipe fence is not active." }, 409);
      }
      if (Object.keys(fenceState.active ?? {}).length > 0) {
        return json({ error: "Owner cloud activity is still active." }, 409);
      }
      if (!env.AGENT_HOME) {
        return json({ error: "Cloud home storage is unavailable." }, 503);
      }
      try {
        const result = await sweepMemoryWipePage(env.AGENT_HOME, {
          ownerId,
          ownerGeneration,
          cursor: cursor as number,
          ...(typeof body?.startAfter === "string"
            ? { startAfter: body.startAfter }
            : {}),
        });
        log("info", "cloud_memory_wipe_page", {
          ownerId,
          operationId,
          memoryEpoch,
          cursor: result.cursor,
          deleted: result.deleted,
          complete: result.complete,
        });
        return json(result, result.complete ? 200 : 202);
      } catch {
        log("error", "cloud_memory_wipe_page_failed", {
          ownerId,
          operationId,
          cursor,
          // R2 failures can contain internal URLs or object locators. Keep the
          // durable retry observable without copying provider detail to logs.
          errorCode: "MEMORY_WIPE_STORAGE_FAILURE",
        });
        return json({ error: "Cloud memory storage wipe failed." }, 502);
      }
    }
    if (request.method === "POST" && url.pathname === "/owners/purge") {
      const body = (await request.json()) as OwnerPurgeRequest;
      const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
      const browserProfiles = body.browserProfiles ?? [];
      const ownerGeneration = normalizeOwnerGeneration(body.ownerGeneration);
      if (!ownerId || !body.purgeGeneration) {
        return json({ error: "ownerId and purgeGeneration required." }, 400);
      }
      if (
        !Array.isArray(browserProfiles) ||
        browserProfiles.length > 1 ||
        browserProfiles.some((profile) => profile !== "default") ||
        new Set(browserProfiles).size !== browserProfiles.length ||
        (browserProfiles.length > 0 && !ownerGeneration)
      ) {
        return json({ error: "Malformed browser profile purge request." }, 400);
      }
      const fenced = await callOwnerFence(env, ownerId, "assert-blocked", {
        generation: body.purgeGeneration,
      });
      if (!fenced.ok) {
        return json({ error: "Owner is not fenced for this purge." }, 409);
      }
      const fenceState = (await fenced.json()) as {
        active?: OwnerPurgeFence["active"];
      };
      if (Object.keys(fenceState.active ?? {}).length > 0) {
        return json({ error: "Owner cloud turns are still active." }, 409);
      }
      let turnStateDeleted = 0;
      let turnStatePending = false;
      try {
        const turnStatePurge = await callOwnerFence(
          env,
          ownerId,
          "turn-state/purge",
          {
            schemaVersion: 1,
            generation: body.purgeGeneration,
          },
        );
        const result = (await turnStatePurge.json().catch(() => null)) as {
          deleted?: unknown;
          pending?: unknown;
        } | null;
        if (
          !turnStatePurge.ok ||
          !result ||
          !Number.isSafeInteger(result.deleted) ||
          (result.deleted as number) < 0 ||
          typeof result.pending !== "boolean"
        ) {
          turnStatePending = true;
        } else {
          turnStateDeleted = result.deleted as number;
          turnStatePending = result.pending;
        }
      } catch (error) {
        turnStatePending = true;
        log("error", "owner_storage_purge_step_failed", {
          store: "turn-state",
          message: errorMessage(error),
        });
      }
      let browserProfilesDeleted = 0;
      const browserProfilePending: string[] = [];
      if (browserProfiles.includes("default")) {
        const browserPurgeRequestId = crypto.randomUUID();
        if (!env.BROWSER_GATEWAY) {
          browserProfilePending.push("browser-profile:default");
        } else {
          try {
            const browserPurge = await env.BROWSER_GATEWAY.fetch(
              "https://browser-gateway/internal/owners/purge",
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  schemaVersion: 1,
                  ownerId,
                  requestId: browserPurgeRequestId,
                }),
              },
            );
            const result = (await browserPurge.json().catch(() => null)) as {
              schemaVersion?: unknown;
              requestId?: unknown;
              profileId?: unknown;
              purged?: unknown;
            } | null;
            if (
              !browserPurge.ok ||
              result?.schemaVersion !== 1 ||
              result.requestId !== browserPurgeRequestId ||
              result.profileId !== "default" ||
              result.purged !== true
            ) {
              browserProfilePending.push("browser-profile:default");
            } else {
              browserProfilesDeleted = 1;
            }
          } catch {
            browserProfilePending.push("browser-profile:default");
            log("error", "owner_storage_purge_step_failed", {
              store: "browser-profile:default",
              errorCode: "BROWSER_GATEWAY_UPSTREAM_FAILURE",
            });
          }
        }
      }
      const legacyReport = await purgeOwnerStorage(env, ownerId, body);
      const report: OwnerPurgeReport = {
        ok: true,
        deleted:
          legacyReport.deleted + turnStateDeleted + browserProfilesDeleted,
        pending: Array.from(
          new Set([
            ...legacyReport.pending,
            ...(turnStatePending ? ["turn-state"] : []),
            ...browserProfilePending,
          ]),
        ),
      };
      log("info", "owner_storage_purged", {
        requestId,
        deleted: report.deleted,
        pending: report.pending,
      });
      return json(report);
    }
    if (request.method === "POST" && url.pathname === "/routes/activate") {
      const body = (await request.json()) as {
        slug: string;
        appId: string;
        ownerId: string;
        ownerGeneration: string;
        buildId: string;
        artifactPrefix: string;
      };
      const ownerGeneration = normalizeOwnerGeneration(body.ownerGeneration);
      let expectedArtifactPrefix: string;
      try {
        if (
          typeof body.ownerId !== "string" ||
          !body.ownerId ||
          body.ownerId.length > 512 ||
          typeof body.appId !== "string" ||
          !body.appId ||
          body.appId.length > 512 ||
          typeof body.slug !== "string" ||
          !APP_SLUG_PATTERN.test(body.slug) ||
          typeof body.buildId !== "string" ||
          typeof body.artifactPrefix !== "string" ||
          !ownerGeneration
        ) {
          throw new Error("Invalid route activation.");
        }
        expectedArtifactPrefix = ownerAppBuildPrefix(
          await sha256Hex(body.ownerId),
          body.buildId,
        );
      } catch {
        return json({ error: "Malformed app route." }, 400);
      }
      if (body.artifactPrefix !== expectedArtifactPrefix) {
        return json({ error: "App route artifact owner does not match." }, 400);
      }
      try {
        await withOwnerActivityLease(
          env,
          body.ownerId,
          ownerGeneration,
          requestId,
          async (generation, leaseId) => {
            await env.APP_ROUTES.put(
              `app:${body.slug}`,
              JSON.stringify({
                slug: body.slug,
                appId: body.appId,
                ownerId: body.ownerId,
                buildId: body.buildId,
                artifactPrefix: body.artifactPrefix,
                suspended: false,
                updatedAt: Date.now(),
              }),
            );
            const fenced = await callOwnerFence(env, body.ownerId, "assert", {
              generation,
              leaseId,
              ownerGeneration,
            });
            if (!fenced.ok) throw new OwnerPurgeFenceError();
          },
        );
      } catch (error) {
        if (error instanceof OwnerPurgeFenceError) {
          return json({ error: "Owner cloud activity is being purged." }, 409);
        }
        throw error;
      }
      log("info", "route_activated", {
        requestId,
        slug: body.slug,
        appId: body.appId,
        buildId: body.buildId,
      });
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/routes/suspend") {
      const body = (await request.json()) as {
        slug: string;
        appId: string;
        ownerId: string;
        ownerGeneration: string;
      };
      const ownerGeneration = normalizeOwnerGeneration(body.ownerGeneration);
      if (
        typeof body.ownerId !== "string" ||
        !body.ownerId ||
        body.ownerId.length > 512 ||
        typeof body.appId !== "string" ||
        !body.appId ||
        body.appId.length > 512 ||
        typeof body.slug !== "string" ||
        !APP_SLUG_PATTERN.test(body.slug) ||
        !ownerGeneration
      ) {
        return json({ error: "Malformed app route." }, 400);
      }
      const route = await env.APP_ROUTES.get<Record<string, unknown>>(
        `app:${body.slug}`,
        "json",
      );
      if (
        !route ||
        route.appId !== body.appId ||
        route.ownerId !== body.ownerId
      ) {
        return json({ error: "App route not found." }, 404);
      }
      try {
        await withOwnerActivityLease(
          env,
          body.ownerId,
          ownerGeneration,
          requestId,
          async (generation, leaseId) => {
            await env.APP_ROUTES.put(
              `app:${body.slug}`,
              JSON.stringify({
                ...route,
                suspended: true,
                updatedAt: Date.now(),
              }),
            );
            const fenced = await callOwnerFence(env, body.ownerId, "assert", {
              generation,
              leaseId,
              ownerGeneration,
            });
            if (!fenced.ok) throw new OwnerPurgeFenceError();
          },
        );
      } catch (error) {
        if (error instanceof OwnerPurgeFenceError) {
          return json({ error: "Owner cloud activity is being purged." }, 409);
        }
        throw error;
      }
      log("info", "route_suspended", {
        requestId,
        slug: body.slug,
        appId: body.appId,
      });
      return json({ ok: true });
    }
    return json({ error: "Not found." }, 404);
  },

  /**
   * The outbox consumer. Every batch is one `POST /api/cloud/outbox`; the
   * verdict decides ack versus retry (see `deliverOutboxBatch`), and after
   * `max_retries` the queue parks the batch on the dead-letter queue.
   */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const delivery = await deliverOutboxBatch(batch, env);
    log(delivery.disposition === "retried" ? "error" : "info", "outbox_batch", {
      queue: batch.queue,
      ...delivery,
    });
  },
} satisfies ExportedHandler<Env>;
