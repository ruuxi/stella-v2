import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { emitCloudTurnTelemetry } from "./telemetry.js";
import {
  runToolEffect,
  sleepWithAbort,
} from "@stella/runtime/kernel/tools/effect-runtime.js";
import {
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
import { mintTurnCapability } from "./capability-signer.js";
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
  turnComputePlanKey,
  type GeneralAgentTurnPlan,
  type GeneralAgentTurnResult,
} from "./general-agent-turn.js";
import {
  agentComputeKey,
  createAgentComputeLadder,
  parsePersistedAgentCompute,
  type PersistedAgentCompute,
} from "./agent-compute-ladder.js";
import {
  isSandboxDestroyDebtKey,
  sandboxLifecycleId,
  type SandboxTarget,
  type SandboxWorkload,
} from "./sandbox-lifecycle.js";
import {
  PREVIEW_ACCESS_MAX_TTL_MS,
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
import type { SealedTurnTranscript } from "./agent-turn-journal.js";
import { createAgentControlPlane } from "./agent-control-plane.js";
import {
  rememberCloudAgentControlReceipt,
  steerCloudAgent,
  type CloudAgentDispatchDependencies,
} from "./cloud-agent-dispatch.js";
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
  bindObservedBrowserSuspensionToCanonicalCodeCall,
  builderFallbackTranscriptKey,
  cloudBrowserSuspensionMarker,
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
  sessionName,
  turnDispatchIdentity,
  turnStateBaseWorkspaceRevisionKey,
  turnStateCheckpointOperationKey,
  validBuilderFallbackMessages,
  validTurnStateCheckpointReceipt,
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
  abortUnpublishedTurnStateOperation,
  confirmAgentTurnStateRestore,
  exactTurnStateCheckpointOperations,
  executeTurnStateCheckpoint,
  handleTurnBroker,
  publishAgentTurnWorkspace,
  resolveAgentTurnState,
  turnBrokerCredentialsPath,
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
import {
  deliverResidentTerminal,
  finishResidentAgentTurn,
  publishResidentTurnWorkspace,
  recoverResidentAgentTurn,
  repairedResidentJournal,
  residentAttachHistory,
  runResidentAgentTurn,
} from "./build-session/resident-turn.js";
import {
  advanceBuilderFallback,
  ensureBuilderFallbackTranscript,
  reconcileAgentCheckpointAfterQuiescence,
  recoverAgentTurnAfterExecutorLoss,
  recoverObservedBrowserSuspension,
  retainPendingBrowserSuspension,
  runAlarm,
  runAlarmWithLease,
  runScheduledTurnAlarm,
} from "./build-session/alarms-recovery.js";
import {
  currentSandbox,
  currentSandboxTarget,
  destroySandboxDurably,
  releaseAgentSessionResources,
  retireSandboxInstance,
  retryDueSandboxDestroyDebts,
  sandbox,
  sandboxContainerRunning,
  scheduleSandboxDestroyDebtAlarm,
  terminateCurrentAgentSession,
} from "./build-session/session-sandbox.js";
import {
  attachAgentWorld,
  clearUnattachedAgentSandboxTuple,
  exactAgentExecutionMarker,
  interruptAgentForBuilderFallback,
  persistAgentExecutionMarker,
  quiesceCurrentAgentSession,
  runAgentAttempt,
  runContainerAgentTurn,
} from "./build-session/container-turn.js";
export {
  parseAgentExecutorResult,
  seedFirstStellaToolWorkspace,
  stellaToolWorkspaceExists,
  waitForCloudAgentTurnResultText,
} from "./build-session/container-turn.js";

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

  /** @see src/build-session/container-turn.ts */
  private quiesceCurrentAgentSession(turn: TurnRequest): Promise<void> {
    return quiesceCurrentAgentSession(this.self, turn);
  }

  /** @see src/build-session/container-turn.ts */
  private exactAgentExecutionMarker(
    turn: TurnRequest,
  ): Promise<AgentExecutionMarker | undefined> {
    return exactAgentExecutionMarker(this.self, turn);
  }

  /** @see src/build-session/container-turn.ts */
  private persistAgentExecutionMarker(
    turn: TurnRequest,
    marker: AgentExecutionMarker,
  ): Promise<void> {
    return persistAgentExecutionMarker(this.self, turn, marker);
  }

  /** @see src/build-session/container-turn.ts */
  private clearUnattachedAgentSandboxTuple(turn: TurnRequest): Promise<void> {
    return clearUnattachedAgentSandboxTuple(this.self, turn);
  }

  /** @see src/build-session/container-turn.ts */
  private interruptAgentForBuilderFallback(turn: TurnRequest): Promise<void> {
    return interruptAgentForBuilderFallback(this.self, turn);
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

  /** @see src/build-session/alarms-recovery.ts */
  private recoverObservedBrowserSuspension(
    turn: TurnRequest,
    checkpoint: TurnBrokerTurnStateCheckpointReceipt,
    signal?: AbortSignal,
  ): Promise<CloudBrowserSuspension | null> {
    return recoverObservedBrowserSuspension(
      this.self,
      turn,
      checkpoint,
      signal,
    );
  }

  /** @see src/build-session/alarms-recovery.ts */
  private retainPendingBrowserSuspension(
    turn: TurnRequest,
    pending: PendingBrowserSuspension,
  ): Promise<boolean> {
    return retainPendingBrowserSuspension(this.self, turn, pending);
  }

  /** Whether this exact attempt was admitted to the resident arm. */
  /** @see src/build-session/admission.ts */
  private admittedResidentPlacement(turn: TurnRequest): Promise<boolean> {
    return admittedResidentPlacement(this.self, turn);
  }

  /** @see src/build-session/resident-turn.ts */
  private repairedResidentJournal(
    turn: TurnRequest,
    message: string,
  ): Promise<SealedTurnTranscript> {
    return repairedResidentJournal(this.self, turn, message);
  }

  /** @see src/build-session/resident-turn.ts */
  private recoverResidentAgentTurn(turn: TurnRequest): Promise<void> {
    return recoverResidentAgentTurn(this.self, turn);
  }

  /** @see src/build-session/alarms-recovery.ts */
  private recoverAgentTurnAfterExecutorLoss(
    turn: TurnRequest,
    marker: AgentExecutionMarker,
    error: string,
    resolveInput?: () => Promise<BuilderFallbackInput>,
  ): Promise<TurnBrokerTurnStateCheckpointReceipt> {
    return recoverAgentTurnAfterExecutorLoss(
      this.self,
      turn,
      marker,
      error,
      resolveInput,
    );
  }

  /** @see src/build-session/alarms-recovery.ts */
  private reconcileAgentCheckpointAfterQuiescence(
    turn: TurnRequest,
    marker: AgentExecutionMarker,
    error: string,
    input?: BuilderFallbackInput,
  ): Promise<TurnBrokerTurnStateCheckpointReceipt> {
    return reconcileAgentCheckpointAfterQuiescence(
      this.self,
      turn,
      marker,
      error,
      input,
    );
  }

  /** @see src/build-session/alarms-recovery.ts */
  private ensureBuilderFallbackTranscript(
    turn: TurnRequest,
    input?: BuilderFallbackInput & { error?: string },
  ): Promise<BuilderFallbackTranscript> {
    return ensureBuilderFallbackTranscript(this.self, turn, input);
  }

  /** @see src/build-session/alarms-recovery.ts */
  private advanceBuilderFallback(
    turn: TurnRequest,
    fallback: BuilderFallbackTranscript,
  ): Promise<TurnBrokerTurnStateCheckpointReceipt> {
    return advanceBuilderFallback(this.self, turn, fallback);
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

  /** @see src/build-session/session-sandbox.ts */
  private sandbox(
    id: string,
    size: InstanceSize = "large",
    workload: SandboxWorkload = "app-build",
  ) {
    return sandbox(this.self, id, size, workload);
  }

  /** @see src/build-session/session-sandbox.ts */
  private sandboxContainerRunning(
    sandbox: ReturnType<BuildSession["sandbox"]>,
  ): Promise<boolean> {
    return sandboxContainerRunning(this.self, sandbox);
  }

  /** @see src/build-session/session-sandbox.ts */
  private destroySandboxDurably(
    target: SandboxTarget,
    event: string,
  ): Promise<void> {
    return destroySandboxDurably(this.self, target, event);
  }

  private deliverExecutorLossTerminal(
    turn: TurnRequest,
    text: { message: string; threadError: string },
  ): Promise<void> {
    return deliverExecutorLossTerminal(this.self, turn, text);
  }

  /** @see src/build-session/session-sandbox.ts */
  private retryDueSandboxDestroyDebts(now = Date.now()): Promise<void> {
    return retryDueSandboxDestroyDebts(this.self, now);
  }

  /** @see src/build-session/session-sandbox.ts */
  private scheduleSandboxDestroyDebtAlarm(): Promise<void> {
    return scheduleSandboxDestroyDebtAlarm(this.self);
  }

  /** @see src/build-session/session-core.ts */
  private scheduleDurabilityAlarm(): Promise<void> {
    return scheduleDurabilityAlarm(this.self);
  }

  /** @see src/build-session/session-sandbox.ts */
  private currentSandboxTarget(): Promise<SandboxTarget | undefined> {
    return currentSandboxTarget(this.self);
  }

  /** @see src/build-session/session-sandbox.ts */
  private currentSandbox() {
    return currentSandbox(this.self);
  }

  /** @see src/build-session/session-sandbox.ts */
  private terminateCurrentAgentSession(turn: TurnRequest): Promise<void> {
    return terminateCurrentAgentSession(this.self, turn);
  }

  /** @see src/build-session/session-sandbox.ts */
  private releaseAgentSessionResources(target: {
    sandboxId: string;
    size: InstanceSize;
    workload: "world";
    sessionId: string;
    daemonDirectory: string;
  }): Promise<void> {
    return releaseAgentSessionResources(this.self, target);
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

  /** @see src/build-session/alarms-recovery.ts */
  private runScheduledTurnAlarm(): Promise<void> {
    return runScheduledTurnAlarm(this.self);
  }

  /** @see src/build-session/alarms-recovery.ts */
  private runAlarmWithLease(turn: TurnRequest): Promise<void> {
    return runAlarmWithLease(this.self, turn);
  }

  /** @see src/build-session/alarms-recovery.ts */
  private runAlarm(turn: TurnRequest): Promise<void> {
    return runAlarm(this.self, turn);
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

  /** @see src/build-session/resident-turn.ts */
  private runResidentAgentTurn(
    turn: TurnRequest,
    plan: Extract<GeneralAgentTurnPlan, { kind: "resident_stella" }>,
    execution: TurnExecutionContext,
  ): Promise<GeneralAgentTurnResult> {
    return runResidentAgentTurn(this.self, turn, plan, execution);
  }

  /** @see src/build-session/resident-turn.ts */
  private finishResidentAgentTurn(
    turn: TurnRequest,
    ladder: Pick<ReturnType<typeof createAgentComputeLadder>, "teardown">,
    result: GeneralAgentTurnResult,
    requestStarted: number,
  ): Promise<void> {
    return finishResidentAgentTurn(
      this.self,
      turn,
      ladder,
      result,
      requestStarted,
    );
  }

  /** @see src/build-session/resident-turn.ts */
  private residentAttachHistory(
    turn: TurnRequest,
    execution: TurnExecutionContext,
  ): AgentHistoryRow[] {
    return residentAttachHistory(this.self, turn, execution);
  }

  /** @see src/build-session/resident-turn.ts */
  private publishResidentTurnWorkspace(
    turn: TurnRequest,
    execution: TurnExecutionContext,
    checkpoint: TurnBrokerTurnStateCheckpointReceipt,
  ): Promise<void> {
    return publishResidentTurnWorkspace(this.self, turn, execution, checkpoint);
  }

  /** @see src/build-session/resident-turn.ts */
  private deliverResidentTerminal(
    turn: TurnRequest,
    result: GeneralAgentTurnResult,
    requestStarted: number,
  ): Promise<void> {
    return deliverResidentTerminal(this.self, turn, result, requestStarted);
  }

  /** @see src/build-session/container-turn.ts */
  private runContainerAgentTurn(
    turn: TurnRequest,
    sandboxId: string,
    execution: TurnExecutionContext,
  ): Promise<void> {
    return runContainerAgentTurn(this.self, turn, sandboxId, execution);
  }

  /** @see src/build-session/container-turn.ts */
  private attachAgentWorld(
    args: Parameters<typeof attachAgentWorld>[1],
  ): ReturnType<typeof attachAgentWorld> {
    return attachAgentWorld(this.self, args);
  }

  /** @see src/build-session/container-turn.ts */
  private runAgentAttempt(
    args: Parameters<typeof runAgentAttempt>[1],
  ): ReturnType<typeof runAgentAttempt> {
    return runAgentAttempt(this.self, args);
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
