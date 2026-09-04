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
  type CloudTurnStartRequest,
} from "@stella/contracts/turn-plane/turn-start";
import {
  OUTBOX_EVENT_VERSION,
  type BuildRecordedEvent,
  type InteriorBuildRecordedEvent,
  type OutboxEvent,
  type ThreadCompletedEvent,
  type TurnEventEvent,
} from "@stella/contracts/turn-plane/outbox";
import {
  HEADER_PRESENCE_DEVICE_ID,
  OwnerGate,
  parseOwnerSnapshot,
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
import { parseOwnerProductTransferRequest } from "./owner-product-transfer.js";
import {
  OWNER_TRANSFER_OPERATION_ID_PATTERN,
  createCoordinatorAttempt,
  parseOwnerTransferControl,
  stableValueMarker,
  type OwnerTransferCoordinatorAttempt,
} from "./owner-transfer-coordinator.js";
import { OwnerTransferCoordinator } from "./owner-transfer-coordinator-do.js";
import {
  isOwnerAppBuildPrefix,
  ownerAppBuildPrefix,
  retireTransientAppBuild,
} from "./app-build-artifacts.js";
import {
  HEADER_OWNER_FENCE_ID,
  type OwnerPurgeFence,
  type OwnerPurgeMode,
} from "./owner-fence-do.js";
import { normalizeOwnerGeneration } from "./owner-generation.js";
import { parseConversationEditRequest } from "./conversation-edit-protocol.js";
import {
  conversationEditErrorResponse,
  runConversationEdit,
} from "./conversation-edit-runner.js";
import { handleUserCloudHomeRoute } from "./cloud-home-routes.js";
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
import { type TurnStateTransferManifest } from "./turn-state-owner-routes.js";
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
  runResidentStellaLoop,
  turnComputePlanKey,
  type GeneralAgentTurnPlan,
  type GeneralAgentTurnResult,
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
import { issueWorldCapability } from "./world-capability.js";
import {
  CLOUD_BUILDER_BODY_LIMITS,
  boundedBodyStatus,
  publicJsonBodyLimit,
  serviceJsonBodyLimit,
} from "./request-ingress.js";
import {
  BoundedBodyError,
  readBoundedRequestText,
  readBoundedResponseBytes,
} from "./bounded-body.js";
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
  PendingAppBuildPublication,
  PendingBrowserSuspension,
  PendingTerminal,
  TurnRequest,
  TurnStateCheckpointOperation,
  WorkspaceBackupDebt,
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
  BACKUP_ID_PATTERN,
  R2_SWEEP_MAX_PAGES,
  sweepR2Prefix,
  AGENT_RECOVERY_PENDING_KEY,
  AGENT_TURN_HEARTBEAT_MS,
  AGENT_WATCHDOG_DEADLINE_KEY,
  APP_BUILD_CONTROL_PLANE_EXECUTION,
  APP_TURN_ADMISSION_CLAIM_KEY,
  BUILDER_FALLBACK_MAX_RETRIES,
  HEADER_CONVERSATION_ID,
  HEADER_PREVIEW_CAPABILITY,
  OBSERVED_BROWSER_SUSPENSION_KEY,
  ORCHESTRATOR_INTERNAL_ORIGIN,
  OUTBOX_DEBT_KEY,
  OUTBOX_DEBT_MAX,
  OUTBOX_DEBT_RETRY_MS,
  OWNER_PURGE_STALE_LEASE_GRACE_MS,
  PENDING_BROWSER_SUSPENSION_KEY,
  SHA256_HEX,
  TERMINAL_EVENT_STATUS,
  agentComputeRecoveryClaimKey,
  agentExecutionMarkerKey,
  agentRecoveryIdentity,
  builderFallbackRetryKey,
  builderFallbackTranscriptKey,
  contentType,
  conversationName,
  errorMessage,
  exactTurnIdentityMatches,
  exactTurnSandboxId,
  executionFailureFields,
  isBuildOwnerFenceDurabilityKey,
  json,
  log,
  nativeBackupDebtKey,
  nativeStateIntegrityKeyFor,
  nativeTransientBackupKey,
  normalizeToolWorkspaceRoot,
  pendingAppBuildPublicationKey,
  sessionName,
  turnDispatchIdentity,
  turnStateBaseWorkspaceRevisionKey,
  turnStateCheckpointOperationKey,
  withInfrastructureDeadline,
} from "./build-session/shared/keys.js";
import {
  APP_SLUG_PATTERN,
  INTERIOR_BUILD_PREFIX_PATTERN,
  LEGACY_BUILD_PREFIX_PATTERN,
  abortTransferCoordinator,
  beginOwnerPurge,
  boundedIngressRequest,
  callOwnerFence,
  callTransferCoordinator,
  cloudHomeLeaseRunner,
  createTransferCoordinatorContext,
  handleWorldRoute,
  parseTransferReservationEnvelope,
  purgeOwnerStorage,
  transferControl,
  transferOwnerProductStorage,
  withOwnerActivityLease,
  yieldTransferCoordinator,
} from "./build-session/owner-purge-transfer.js";
import {
  acknowledgeExactAgentTurnCancellation,
  acknowledgeExactCancellationFromAlarm,
  cancelExactAgentTurn,
  cancelForOwnerPurge,
  claimTerminalDecision,
  deliverBrowserSuspension,
  deliverExecutorLossTerminal,
  deliverTerminal,
  expireCurrentAgentTurn,
  handleSteer,
  wakeParentAgentOrConversation,
  wakeParentConversation,
} from "./build-session/terminal-delivery.js";
import {
  callOwnerFence as callOwnerFenceCore,
  agentControlPlane,
  appendThreadTranscript,
  assertAgentExecutionActive,
  assertAgentTurnIdentity,
  assertAppExecutionActive,
  assertAppTurnIdentity,
  assertTurnWritable,
  callOwnerTurnState,
  childAgentDispatchDependencies,
  cleanupOwnerPurgedTurnStorage,
  cleanupTransientWrites,
  controlPlaneCapability,
  convexCall,
  deleteTurnStoragePreservingExactCancellations,
  emitTurnEvent,
  enqueueOutboxDurable,
  event,
  fetchCanonicalAgentHistory,
  mintAgentTurnModelGateway,
  mutateExactTurn,
  outboxBase,
  ownerGateFor,
  ownsExactTurn,
  redeliverOrphan,
  registerTurn,
  releaseOwnerGate,
  retireTerminalAppTurnStorage,
  retryOutboxDebt,
  scheduleDurabilityAlarm,
  setExactTurnAlarm,
  settleAgentTransientBackup,
  settleTerminalTransientWrites,
  sweepNativeBackupDebt,
  trackTurn,
  unregisterTurn,
  unregisterTurnLease,
} from "./build-session/session-core.js";

export type { ObservedBrowserSuspension } from "./build-session/shared/types.js";
export { purgeNativeStateForWorkspace } from "./build-session/owner-purge-transfer.js";
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

export { bindObservedBrowserSuspensionToCanonicalCodeCall };
import {
  advanceAppBuildPublication,
  proxyVitePreview,
  publishInteriorCandidate,
  publishRequestedInteriorCandidate,
  runEcho,
  runTurn,
} from "./build-session/app-build.js";
import {
  armOwnerFenceLeaseReconciliationAlarm,
  hasOwnerFenceLeaseRetirementDebt,
  ownerFenceLeaseSlotKey,
  ownerFenceReceiptMatches,
  registerBuildOwnerFenceLease,
  retireBuildOwnerFenceLease,
  retryOwnerFenceLeaseRetirements,
} from "./build-session/owner-fence-leases.js";
import {
  acceptAgentTurn,
  admitAgentTurnThroughOwnerGate,
  admittedResidentPlacement,
  agentTurnAccepted,
  runAgentTurn,
  startAgentTurn,
  startAppTurn,
} from "./build-session/admission.js";

export { normalizeToolWorkspaceRoot } from "./build-session/shared/keys.js";

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

const HEADER_BUILD_SESSION_NAME = "x-stella-build-session-name";
const HEADER_TURN_BROKER_ENDPOINT = "x-stella-turn-broker-endpoint";
const HEADER_PREVIEW_BASE_URL = "x-stella-preview-base-url";
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

/**
 * Run a strict (`set -eu`) script without leaving those options behind in
 * the session's persistent shell. The subshell's exit status is the script's.
 * Defined in `shell-subshell.ts` so the checkpoint archive scripts share it
 * without importing this module.
 */
export { inSubshell };

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

  /** @see src/build-session/session-core.ts */
  private deleteTurnStoragePreservingExactCancellations(
    expectedTurn?: TurnRequest,
    deleteAlarm = false,
  ): Promise<boolean> {
    return deleteTurnStoragePreservingExactCancellations(
      this.self,
      expectedTurn,
      deleteAlarm,
    );
  }

  // ── The turn plane: owner gate, capabilities, outbox, transcript ───────
  //
  // Everything below replaces a synchronous Convex round trip that used to sit
  // on a turn's critical path. Admission is the owner gate's, authority is a
  // signed capability rather than a reusable token Convex has to look up, and
  // every projection Convex needs leaves through the outbox queue instead of
  // an HTTP callback with its own retry ladder.

  /** @see src/build-session/session-core.ts */
  private ownerGateFor(ownerId: string) {
    return ownerGateFor(this.self, ownerId);
  }

  /** @see src/build-session/session-core.ts */
  private childAgentDispatchDependencies(): CloudAgentDispatchDependencies {
    return childAgentDispatchDependencies(this.self);
  }

  /** @see src/build-session/session-core.ts */
  private releaseOwnerGate(turn: TurnRequest): Promise<void> {
    return releaseOwnerGate(this.self, turn);
  }

  /** @see src/build-session/session-core.ts */
  private controlPlaneCapability(turn: TurnRequest): Promise<string> {
    return controlPlaneCapability(this.self, turn);
  }

  /** @see src/build-session/session-core.ts */
  private convexCall(
    turn: TurnRequest,
    path: string,
    body: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Response> {
    return convexCall(this.self, turn, path, body, options);
  }

  /** @see src/build-session/session-core.ts */
  private agentControlPlane(
    turn: TurnRequest,
    attemptGeneration: number,
    sessionId: string,
  ): ReturnType<typeof createAgentControlPlane> {
    return agentControlPlane(this.self, turn, attemptGeneration, sessionId);
  }

  /** @see src/build-session/session-core.ts */
  private outboxBase(turn: TurnRequest, key: string) {
    return outboxBase(this.self, turn, key);
  }

  /** @see src/build-session/session-core.ts */
  private enqueueOutboxDurable(events: OutboxEvent[]): Promise<void> {
    return enqueueOutboxDurable(this.self, events);
  }

  /** @see src/build-session/session-core.ts */
  private retryOutboxDebt(): Promise<void> {
    return retryOutboxDebt(this.self);
  }

  /** @see src/build-session/session-core.ts */
  private emitTurnEvent(
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
    return emitTurnEvent(this.self, turn, eventKind, payload, options);
  }

  /** @see src/build-session/session-core.ts */
  private appendThreadTranscript(
    turn: TurnRequest,
    messages: readonly ThreadMessageInput[],
  ): Promise<void> {
    return appendThreadTranscript(this.self, turn, messages);
  }

  /** @see src/build-session/session-core.ts */
  private trackTurn<T>(turnId: string, work: Promise<T>): Promise<T> {
    return trackTurn(this.self, turnId, work);
  }

  /** @see src/build-session/admission.ts */
  private startAgentTurn(
    turn: TurnRequest,
    sandboxId: string | undefined,
  ): Promise<void> {
    return startAgentTurn(this.self, turn, sandboxId);
  }

  /** @see src/build-session/admission.ts */
  private startAppTurn(turn: TurnRequest): Promise<Response> {
    return startAppTurn(this.self, turn);
  }

  /** @see src/build-session/session-core.ts */
  private callOwnerFence(
    ownerId: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return callOwnerFenceCore(this.self, ownerId, path, body);
  }

  /** @see src/build-session/session-core.ts */
  private callOwnerTurnState<T>(
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
    return callOwnerTurnState(this.self, turn, path, body);
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
  /** @see src/build-session/admission.ts */
  private admittedResidentPlacement(turn: TurnRequest): Promise<boolean> {
    return admittedResidentPlacement(this.self, turn);
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

  /** @see src/build-session/session-core.ts */
  private registerTurn(turn: TurnRequest, freshLease = false): Promise<string> {
    return registerTurn(this.self, turn, freshLease);
  }

  /** @see src/build-session/owner-fence-leases.ts */
  private ownerFenceReceiptMatches(
    receipt: BuildOwnerFenceLeaseReceipt,
    target: Pick<TurnRequest, "ownerId" | "ownerGeneration" | "turnId">,
    leaseId: string,
  ): boolean {
    return ownerFenceReceiptMatches(this.self, receipt, target, leaseId);
  }

  /** @see src/build-session/owner-fence-leases.ts */
  private ownerFenceLeaseSlotKey(
    turn: TurnRequest,
    kind: BuildOwnerFenceLeaseReceipt["kind"],
  ): Promise<string> {
    return ownerFenceLeaseSlotKey(this.self, turn, kind);
  }

  /** @see src/build-session/owner-fence-leases.ts */
  private armOwnerFenceLeaseReconciliationAlarm(): Promise<void> {
    return armOwnerFenceLeaseReconciliationAlarm(this.self);
  }

  /** @see src/build-session/owner-fence-leases.ts */
  private hasOwnerFenceLeaseRetirementDebt(): Promise<boolean> {
    return hasOwnerFenceLeaseRetirementDebt(this.self);
  }

  /** @see src/build-session/owner-fence-leases.ts */
  private retryOwnerFenceLeaseRetirements(): Promise<void> {
    return retryOwnerFenceLeaseRetirements(this.self);
  }

  /** @see src/build-session/owner-fence-leases.ts */
  private registerBuildOwnerFenceLease(args: {
    turn: TurnRequest;
    kind: BuildOwnerFenceLeaseReceipt["kind"];
    role: "run" | "aux";
    slotKey?: string;
    leaseId?: string;
    mutateTurn?: boolean;
  }): Promise<{ generation: string; expiresAt: number; leaseId: string }> {
    return registerBuildOwnerFenceLease(this.self, args);
  }

  /** @see src/build-session/session-core.ts */
  private unregisterTurn(turn: TurnRequest): Promise<void> {
    return unregisterTurn(this.self, turn);
  }

  /** @see src/build-session/session-core.ts */
  private unregisterTurnLease(
    turn: TurnRequest,
    leaseId: string,
    generation?: string,
  ): Promise<boolean> {
    return unregisterTurnLease(this.self, turn, leaseId, generation);
  }

  /** @see src/build-session/owner-fence-leases.ts */
  private retireBuildOwnerFenceLease(
    receipt: BuildOwnerFenceLeaseReceipt,
    generation = receipt.registrationGeneration,
  ): Promise<boolean> {
    return retireBuildOwnerFenceLease(this.self, receipt, generation);
  }

  /** @see src/build-session/session-core.ts */
  private sweepNativeBackupDebt(workspaceKey: string): Promise<void> {
    return sweepNativeBackupDebt(this.self, workspaceKey);
  }

  /** @see src/build-session/session-core.ts */
  private settleAgentTransientBackup(turn: TurnRequest): Promise<boolean> {
    return settleAgentTransientBackup(this.self, turn);
  }

  /** @see src/build-session/session-core.ts */
  private cleanupTransientWrites(turn: TurnRequest): Promise<void> {
    return cleanupTransientWrites(this.self, turn);
  }

  /** @see src/build-session/session-core.ts */
  private cleanupOwnerPurgedTurnStorage(turn: TurnRequest): Promise<boolean> {
    return cleanupOwnerPurgedTurnStorage(this.self, turn);
  }

  /** @see src/build-session/session-core.ts */
  private settleTerminalTransientWrites(turn: TurnRequest): Promise<boolean> {
    return settleTerminalTransientWrites(this.self, turn);
  }

  /** @see src/build-session/session-core.ts */
  private retireTerminalAppTurnStorage(turn: TurnRequest): Promise<void> {
    return retireTerminalAppTurnStorage(this.self, turn);
  }

  private cancelForOwnerPurge(request: Request): Promise<Response> {
    return cancelForOwnerPurge(this.self, request);
  }

  /** @see src/build-session/session-core.ts */
  private redeliverOrphan(
    turn: TurnRequest,
    pending: PendingTerminal,
  ): Promise<void> {
    return redeliverOrphan(this.self, turn, pending);
  }

  /** @see src/build-session/session-core.ts */
  private assertTurnWritable(turn: TurnRequest): Promise<void> {
    return assertTurnWritable(this.self, turn);
  }

  /** @see src/build-session/session-core.ts */
  private assertAgentTurnIdentity(turn: TurnRequest): void {
    return assertAgentTurnIdentity(this.self, turn);
  }

  /** @see src/build-session/session-core.ts */
  private assertAppTurnIdentity(turn: TurnRequest): void {
    return assertAppTurnIdentity(this.self, turn);
  }

  /** @see src/build-session/session-core.ts */
  private fetchCanonicalAgentHistory(
    turn: TurnRequest,
    options: { excludeCurrentTurn: boolean; signal?: AbortSignal },
  ): AgentHistoryRow[] {
    return fetchCanonicalAgentHistory(this.self, turn, options);
  }

  /** @see src/build-session/session-core.ts */
  private assertAgentExecutionActive(
    turn: TurnRequest,
    execution: TurnExecutionContext,
  ): Promise<void> {
    return assertAgentExecutionActive(this.self, turn, execution);
  }

  /** @see src/build-session/session-core.ts */
  private assertAppExecutionActive(
    turn: TurnRequest,
    execution: TurnExecutionContext,
  ): Promise<void> {
    return assertAppExecutionActive(this.self, turn, execution);
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

  private deliverExecutorLossTerminal(
    turn: TurnRequest,
    text: { message: string; threadError: string },
  ): Promise<void> {
    return deliverExecutorLossTerminal(this.self, turn, text);
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

  /** @see src/build-session/session-core.ts */
  private scheduleDurabilityAlarm(): Promise<void> {
    return scheduleDurabilityAlarm(this.self);
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

  /** @see src/build-session/app-build.ts */
  private publishInteriorCandidate(
    turn: TurnRequest,
    sandbox: ReturnType<BuildSession["sandbox"]>,
    commandTimeoutMs: number,
    turnExecution: TurnExecutionContext,
  ): ReturnType<BuildSessionInternals["publishInteriorCandidate"]> {
    return publishInteriorCandidate(
      this.self,
      turn,
      sandbox,
      commandTimeoutMs,
      turnExecution,
    );
  }

  /** @see src/build-session/app-build.ts */
  private publishRequestedInteriorCandidate(args: {
    turn: TurnRequest;
    sandbox: ReturnType<BuildSession["sandbox"]>;
    commandTimeoutMs: number;
    turnExecution: TurnExecutionContext;
  }): ReturnType<BuildSessionInternals["publishRequestedInteriorCandidate"]> {
    return publishRequestedInteriorCandidate(this.self, args);
  }

  /** @see src/build-session/app-build.ts */
  private advanceAppBuildPublication(
    turn: TurnRequest,
    pending: PendingAppBuildPublication,
  ): Promise<"completed" | "failed" | "retrying" | "superseded"> {
    return advanceAppBuildPublication(this.self, turn, pending);
  }

  /** @see src/build-session/session-core.ts */
  private ownsExactTurn(turn: TurnRequest): Promise<boolean> {
    return ownsExactTurn(this.self, turn);
  }

  /** @see src/build-session/session-core.ts */
  private mutateExactTurn(
    turn: TurnRequest,
    operation: (txn: DurableObjectTransaction) => Promise<void>,
  ): Promise<boolean> {
    return mutateExactTurn(this.self, turn, operation);
  }

  /** @see src/build-session/session-core.ts */
  private setExactTurnAlarm(
    turn: TurnRequest,
    scheduledTime: number,
  ): Promise<boolean> {
    return setExactTurnAlarm(this.self, turn, scheduledTime);
  }

  /** @see src/build-session/session-core.ts */
  private event(
    turn: TurnRequest,
    seq: number | "auto",
    kind: string,
    payload: unknown,
    terminal = false,
    executionSignal?: AbortSignal,
  ): Promise<number> {
    return event(
      this.self,
      turn,
      seq,
      kind,
      payload,
      terminal,
      executionSignal,
    );
  }

  private claimTerminalDecision(
    turn: TurnRequest,
    pending: PendingTerminal,
    alarmAt?: number,
  ): Promise<boolean> {
    return claimTerminalDecision(this.self, turn, pending, alarmAt);
  }

  private deliverTerminal(
    turn: TurnRequest,
    pendingInput: PendingTerminal,
    options: { preservePendingTerminal?: boolean } = {},
  ): Promise<boolean> {
    return deliverTerminal(this.self, turn, pendingInput, options);
  }

  private wakeParentAgentOrConversation(
    turn: TurnRequest,
    completion: {
      status: "completed" | "failed" | "canceled";
      threadUpdatedAt: number;
      resultJson?: string;
      errorMessage?: string;
    },
  ): Promise<void> {
    return wakeParentAgentOrConversation(this.self, turn, completion);
  }

  private wakeParentConversation(
    turn: TurnRequest,
    completion: {
      status: "completed" | "failed" | "canceled";
      threadUpdatedAt: number;
      resultJson?: string;
      errorMessage?: string;
    },
  ): Promise<void> {
    return wakeParentConversation(this.self, turn, completion);
  }

  private deliverBrowserSuspension(
    turn: TurnRequest,
    pending: PendingBrowserSuspension,
  ): Promise<boolean> {
    return deliverBrowserSuspension(this.self, turn, pending);
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

  private acknowledgeExactAgentTurnCancellation(
    request: ExactTurnCancellationRequest,
  ): Promise<boolean> {
    return acknowledgeExactAgentTurnCancellation(this.self, request);
  }

  private acknowledgeExactCancellationFromAlarm(
    turn: TurnRequest,
    cancellation: ExactTurnCancellation,
  ): Promise<boolean> {
    return acknowledgeExactCancellationFromAlarm(this.self, turn, cancellation);
  }

  private expireCurrentAgentTurn(request: Request): Promise<Response> {
    return expireCurrentAgentTurn(this.self, request);
  }

  private cancelExactAgentTurn(
    request: ExactTurnCancellationRequest,
    reason: string,
  ): Promise<Response> {
    return cancelExactAgentTurn(this.self, request, reason);
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

  private handleSteer(request: Request): Promise<Response> {
    return handleSteer(this.self, request);
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
  /** @see src/build-session/admission.ts */
  private admitAgentTurnThroughOwnerGate(
    turn: TurnRequest,
  ): Promise<
    { ok: true; snapshot: OwnerSnapshot } | { ok: false; response: Response }
  > {
    return admitAgentTurnThroughOwnerGate(this.self, turn);
  }

  /** @see src/build-session/admission.ts */
  private agentTurnAccepted(
    turn: TurnRequest,
    replayed: boolean,
    extra: Record<string, unknown> = {},
  ): Response {
    return agentTurnAccepted(this.self, turn, replayed, extra);
  }

  /** @see src/build-session/admission.ts */
  private acceptAgentTurn(turn: TurnRequest): Promise<Response> {
    return acceptAgentTurn(this.self, turn);
  }

  /** @see src/build-session/app-build.ts */
  private runEcho(): Promise<Response> {
    return runEcho(this.self);
  }

  /** @see src/build-session/app-build.ts */
  private proxyVitePreview(request: Request): Promise<Response> {
    return proxyVitePreview(this.self, request);
  }

  /** @see src/build-session/admission.ts */
  private runAgentTurn(
    turn: TurnRequest,
    sandboxId: string | undefined,
    execution: TurnExecutionContext,
  ): Promise<void> {
    return runAgentTurn(this.self, turn, sandboxId, execution);
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
      Awaited<ReturnType<typeof materializeCloudSkillSnapshot>> | undefined =
      undefined;
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

  /** @see src/build-session/app-build.ts */
  private runTurn(
    turn: TurnRequest,
    turnExecution: TurnExecutionContext,
  ): Promise<Response> {
    return runTurn(this.self, turn, turnExecution);
  }
}

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
      if (!(
        LEGACY_BUILD_PREFIX_PATTERN.test(prefix) ||
        isOwnerAppBuildPrefix(prefix, ownerHash) ||
        (INTERIOR_BUILD_PREFIX_PATTERN.test(prefix) &&
          prefix.startsWith(`interiors/${ownerHash}/`))
      )) {
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
