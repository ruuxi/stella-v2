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
  HEADER_BUILD_SESSION_NAME,
  HEADER_CONVERSATION_ID,
  HEADER_PREVIEW_BASE_URL,
  HEADER_TURN_BROKER_ENDPOINT,
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
import { worker } from "./build-session/worker-router.js";
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


export default worker;
