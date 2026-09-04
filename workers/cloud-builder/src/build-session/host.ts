/**
 * The structural view of `BuildSession`'s internals that every extracted
 * module takes as its `host` argument.
 *
 * `ctx` and `env` are `protected` on `DurableObject` and every method on the
 * class is `private`, so `Pick<BuildSession, …>` cannot name them. Declaring
 * the surface once here — signatures copied verbatim from the class — and
 * casting once inside `BuildSession` (`private get self()`) keeps every member
 * private while letting the modules stay decoupled from each other.
 *
 * This file is types only: it must never be imported with a value import, or
 * esbuild would stop erasing it and couple every module back to `index.ts`.
 */
import type {
  PersistedAgentCompute,
  createAgentComputeLadder,
} from "../agent-compute-ladder.js";
import type { createAgentControlPlane } from "../agent-control-plane.js";
import type { SealedTurnTranscript } from "../agent-turn-journal.js";
import type { CloudAgentDispatchDependencies } from "../cloud-agent-dispatch.js";
import type {
  CloudHomeStore,
  CloudSkillCatalogSnapshot,
} from "../cloud-home-store.js";
import type {
  ExactTurnCancellation,
  ExactTurnCancellationLedger,
  ExactTurnCancellationRequest,
} from "../execution-placement-turn-cancellation.js";
import type {
  GeneralAgentTurnPlan,
  GeneralAgentTurnResult,
  TurnComputePlan,
  TurnDurability,
} from "../general-agent-turn.js";
import type { AppBuildSandbox } from "../index.js";
import type { InstanceSize } from "../instance-size.js";
import type { OwnerGate } from "../owner-gate.js";
import type { SandboxTarget, SandboxWorkload } from "../sandbox-lifecycle.js";
import type { ThreadMessageInput } from "../thread-transcript.js";
import type {
  TurnExecution,
  TurnExecutionContext,
} from "../turn-cancellation.js";
import type { TurnBrokerTarget } from "../turn-credential-broker.js";
import type {
  ResolvedTurnState,
  TurnStateCandidate,
  TurnStateWorkspaceHead,
} from "../turn-state-registry.js";
import type { Env } from "./shared/env.js";
import type {
  AgentExecutionMarker,
  AgentExecutorResult,
  BuildOwnerFenceLeaseReceipt,
  BuilderFallbackInput,
  BuilderFallbackTranscript,
  PendingAppBuildPublication,
  PendingBrowserSuspension,
  PendingTerminal,
  TurnRequest,
  TurnStateCheckpointOperation,
} from "./shared/types.js";
import type { ExecutionSession } from "@cloudflare/sandbox";
import type { CloudBrowserSuspension } from "@stella/contracts/cloud-browser";
import type {
  TurnBrokerTurnStateCheckpointReceipt,
  TurnBrokerTurnStateCheckpointRequest,
} from "@stella/contracts/turn-credential-broker";
import type { OutboxEvent } from "@stella/contracts/turn-plane/outbox";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import type { AgentHistoryRow } from "@stella/executor-cloud/agent-history";

export interface BuildSessionInternals {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  readonly runningTurns: Map<string, Set<Promise<unknown>>>;
  readonly appTurnExecutions: Map<string, TurnExecution<Response>>;
  readonly agentTurnExecutions: Map<string, TurnExecution<void>>;
  readonly controlPlaneCapabilities: Map<
    string,
    { token: string; expiresAt: number }
  >;
  readonly builderFallbackRecoveries: Set<string>;
  readonly residentAgentAborts: Map<string, () => void>;
  readonly turnStateCheckpointRuns: Map<
    string,
    Promise<TurnBrokerTurnStateCheckpointReceipt>
  >;
  readonly exactTurnCancellations: ExactTurnCancellationLedger;

  deleteTurnStoragePreservingExactCancellations(
    expectedTurn?: TurnRequest,
    deleteAlarm?: boolean,
  ): Promise<boolean>;
  ownerGateFor(ownerId: string): DurableObjectStub<OwnerGate>;
  childAgentDispatchDependencies(): CloudAgentDispatchDependencies;
  releaseOwnerGate(turn: TurnRequest): Promise<void>;
  controlPlaneCapability(turn: TurnRequest): Promise<string>;
  convexCall(
    turn: TurnRequest,
    path: string,
    body: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Response>;
  agentControlPlane(
    turn: TurnRequest,
    attemptGeneration: number,
    sessionId: string,
  ): ReturnType<typeof createAgentControlPlane>;
  outboxBase(
    turn: TurnRequest,
    key: string,
  ): {
    readonly v: 1;
    readonly key: string;
    readonly ownerId: string;
    readonly ownerGeneration: string;
    readonly emittedAt: number;
  };
  enqueueOutboxDurable(events: OutboxEvent[]): Promise<void>;
  retryOutboxDebt(): Promise<void>;
  emitTurnEvent(
    turn: TurnRequest,
    eventKind: string,
    payload: unknown,
    options?: {
      terminal?: boolean;
      eventSeq?: number;
      errorMessage?: string;
      resultJson?: string;
      signal?: AbortSignal;
    },
  ): Promise<number>;
  appendThreadTranscript(
    turn: TurnRequest,
    messages: readonly ThreadMessageInput[],
  ): Promise<void>;
  trackTurn<T>(turnId: string, work: Promise<T>): Promise<T>;
  startAgentTurn(
    turn: TurnRequest,
    sandboxId: string | undefined,
  ): Promise<void>;
  abortResidentAgent(turn: TurnRequest): void;
  startAppTurn(turn: TurnRequest): Promise<Response>;
  callOwnerFence(
    ownerId: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response>;
  callOwnerTurnState<T>(
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
  ): Promise<T>;
  resolveAgentTurnState(
    turn: TurnRequest,
    canonicalHistoryCursor: string,
    options?: { allowMissingNative?: boolean },
  ): Promise<ResolvedTurnState>;
  publishAgentTurnWorkspace(
    turn: TurnRequest,
    canonicalHistoryCursor: string,
    operationId: string,
  ): Promise<TurnStateWorkspaceHead>;
  confirmAgentTurnStateRestore(
    turn: TurnRequest,
    canonicalHistoryCursor: string,
    workspaceHead: TurnStateWorkspaceHead | undefined,
    workspaceConfirmationRequired: boolean,
    threadCandidate: TurnStateCandidate | undefined,
    threadConfirmationRequired: boolean,
  ): Promise<void>;
  quiesceCurrentAgentSession(turn: TurnRequest): Promise<void>;
  exactAgentExecutionMarker(
    turn: TurnRequest,
  ): Promise<AgentExecutionMarker | undefined>;
  claimOrphanedAgentComputeRecovery(
    turn: TurnRequest,
  ): Promise<PersistedAgentCompute | undefined>;
  recoverOrphanedAgentCompute(
    turn: TurnRequest,
  ): Promise<"none" | "recovered" | "retry">;
  persistAgentExecutionMarker(
    turn: TurnRequest,
    marker: AgentExecutionMarker,
  ): Promise<void>;
  clearUnattachedAgentSandboxTuple(turn: TurnRequest): Promise<void>;
  interruptAgentForBuilderFallback(turn: TurnRequest): Promise<void>;
  exactTurnStateCheckpointOperations(
    turn: TurnRequest,
  ): Promise<TurnStateCheckpointOperation[]>;
  abortUnpublishedTurnStateOperation(
    turn: TurnRequest,
    operation: TurnStateCheckpointOperation,
    canonicalHistoryCursor: string,
  ): Promise<void>;
  recoverObservedBrowserSuspension(
    turn: TurnRequest,
    checkpoint: TurnBrokerTurnStateCheckpointReceipt,
    signal?: AbortSignal,
  ): Promise<CloudBrowserSuspension | null>;
  retainPendingBrowserSuspension(
    turn: TurnRequest,
    pending: PendingBrowserSuspension,
  ): Promise<boolean>;
  ensureObservedBrowserSuspensionRecoveryJournal(
    turn: TurnRequest,
    operations: TurnStateCheckpointOperation[],
  ): Promise<BuilderFallbackTranscript | null>;
  admittedResidentPlacement(turn: TurnRequest): Promise<boolean>;
  repairedResidentJournal(
    turn: TurnRequest,
    message: string,
  ): Promise<SealedTurnTranscript>;
  recoverResidentAgentTurn(turn: TurnRequest): Promise<void>;
  recoverAgentTurnAfterExecutorLoss(
    turn: TurnRequest,
    marker: AgentExecutionMarker,
    error: string,
    resolveInput?: () => Promise<BuilderFallbackInput>,
  ): Promise<TurnBrokerTurnStateCheckpointReceipt>;
  reconcileAgentCheckpointAfterQuiescence(
    turn: TurnRequest,
    marker: AgentExecutionMarker,
    error: string,
    input?: BuilderFallbackInput,
  ): Promise<TurnBrokerTurnStateCheckpointReceipt>;
  syntheticBuilderFallbackMessages(
    turn: TurnRequest,
    message: string,
    createdAt: number,
  ): Array<{ ordinal: number; role: string; payloadJson: string }>;
  ensureBuilderFallbackTranscript(
    turn: TurnRequest,
    input?: BuilderFallbackInput & { error?: string },
  ): Promise<BuilderFallbackTranscript>;
  advanceBuilderFallback(
    turn: TurnRequest,
    fallback: BuilderFallbackTranscript,
  ): Promise<TurnBrokerTurnStateCheckpointReceipt>;
  registerTurn(turn: TurnRequest, freshLease?: boolean): Promise<string>;
  ownerFenceReceiptMatches(
    receipt: BuildOwnerFenceLeaseReceipt,
    target: Pick<TurnRequest, "ownerId" | "ownerGeneration" | "turnId">,
    leaseId: string,
  ): boolean;
  ownerFenceLeaseSlotKey(
    turn: TurnRequest,
    kind: BuildOwnerFenceLeaseReceipt["kind"],
  ): Promise<string>;
  armOwnerFenceLeaseReconciliationAlarm(): Promise<void>;
  hasOwnerFenceLeaseRetirementDebt(): Promise<boolean>;
  retryOwnerFenceLeaseRetirements(): Promise<void>;
  registerBuildOwnerFenceLease(args: {
    turn: TurnRequest;
    kind: BuildOwnerFenceLeaseReceipt["kind"];
    role: "run" | "aux";
    slotKey?: string;
    leaseId?: string;
    mutateTurn?: boolean;
  }): Promise<{ generation: string; expiresAt: number; leaseId: string }>;
  unregisterTurn(turn: TurnRequest): Promise<void>;
  unregisterTurnLease(
    turn: TurnRequest,
    leaseId: string,
    generation?: string,
  ): Promise<boolean>;
  retireBuildOwnerFenceLease(
    receipt: BuildOwnerFenceLeaseReceipt,
    generation?: string | undefined,
  ): Promise<boolean>;
  sweepNativeBackupDebt(workspaceKey: string): Promise<void>;
  settleAgentTransientBackup(turn: TurnRequest): Promise<boolean>;
  cleanupTransientWrites(turn: TurnRequest): Promise<void>;
  cleanupOwnerPurgedTurnStorage(turn: TurnRequest): Promise<boolean>;
  settleTerminalTransientWrites(turn: TurnRequest): Promise<boolean>;
  retireTerminalAppTurnStorage(turn: TurnRequest): Promise<void>;
  cancelForOwnerPurge(request: Request): Promise<Response>;
  redeliverOrphan(turn: TurnRequest, pending: PendingTerminal): Promise<void>;
  assertTurnWritable(turn: TurnRequest): Promise<void>;
  assertAgentTurnIdentity(turn: TurnRequest): void;
  assertAppTurnIdentity(turn: TurnRequest): void;
  fetchCanonicalAgentHistory(
    turn: TurnRequest,
    options: { excludeCurrentTurn: boolean; signal?: AbortSignal },
  ): AgentHistoryRow[];
  assertAgentExecutionActive(
    turn: TurnRequest,
    execution: TurnExecutionContext,
  ): Promise<void>;
  assertAppExecutionActive(
    turn: TurnRequest,
    execution: TurnExecutionContext,
  ): Promise<void>;
  sandbox(
    id: string,
    size?: InstanceSize,
    workload?: SandboxWorkload,
  ): AppBuildSandbox;
  sandboxContainerRunning(
    sandbox: ReturnType<BuildSessionInternals["sandbox"]>,
  ): Promise<boolean>;
  destroySandboxDurably(target: SandboxTarget, event: string): Promise<void>;
  recordBuilderFallbackRetry(turn: TurnRequest): Promise<number>;
  deliverExecutorLossTerminal(
    turn: TurnRequest,
    text: { message: string; threadError: string },
  ): Promise<void>;
  retryDueSandboxDestroyDebts(now?: number): Promise<void>;
  scheduleSandboxDestroyDebtAlarm(): Promise<void>;
  scheduleDurabilityAlarm(): Promise<void>;
  currentSandboxTarget(): Promise<SandboxTarget | undefined>;
  currentSandbox(): Promise<AppBuildSandbox | undefined>;
  terminateCurrentAgentSession(turn: TurnRequest): Promise<void>;
  releaseAgentSessionResources(target: {
    sandboxId: string;
    size: InstanceSize;
    workload: "world";
    sessionId: string;
    daemonDirectory: string;
  }): Promise<void>;
  publishInteriorCandidate(
    turn: TurnRequest,
    sandbox: ReturnType<BuildSessionInternals["sandbox"]>,
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
  }>;
  publishRequestedInteriorCandidate(args: {
    turn: TurnRequest;
    sandbox: ReturnType<BuildSessionInternals["sandbox"]>;
    commandTimeoutMs: number;
    turnExecution: TurnExecutionContext;
  }): Promise<
    | { outcome: "not_requested" }
    | { outcome: "abandoned" }
    | { outcome: "failed"; error: string }
    | {
        outcome: "published";
        candidate: Awaited<
          ReturnType<BuildSessionInternals["publishInteriorCandidate"]>
        >;
      }
  >;
  scheduleAppBuildPublicationRetry(
    turn: TurnRequest,
    error: unknown,
  ): Promise<boolean>;
  advanceAppBuildPublication(
    turn: TurnRequest,
    pending: PendingAppBuildPublication,
  ): Promise<"completed" | "failed" | "retrying" | "superseded">;
  ownsExactTurn(turn: TurnRequest): Promise<boolean>;
  mutateExactTurn(
    turn: TurnRequest,
    operation: (txn: DurableObjectTransaction) => Promise<void>,
  ): Promise<boolean>;
  setExactTurnAlarm(turn: TurnRequest, scheduledTime: number): Promise<boolean>;
  event(
    turn: TurnRequest,
    seq: number | "auto",
    kind: string,
    payload: unknown,
    terminal?: boolean,
    executionSignal?: AbortSignal,
  ): Promise<number>;
  claimTerminalDecision(
    turn: TurnRequest,
    pending: PendingTerminal,
    alarmAt?: number,
  ): Promise<boolean>;
  deliverTerminal(
    turn: TurnRequest,
    pendingInput: PendingTerminal,
    options?: { preservePendingTerminal?: boolean },
  ): Promise<boolean>;
  agentCompletionText(
    turn: TurnRequest,
    completion: {
      status: "completed" | "failed" | "canceled";
      resultJson?: string;
      errorMessage?: string;
    },
  ): string;
  wakeParentAgentOrConversation(
    turn: TurnRequest,
    completion: {
      status: "completed" | "failed" | "canceled";
      threadUpdatedAt: number;
      resultJson?: string;
      errorMessage?: string;
    },
  ): Promise<void>;
  wakeParentConversation(
    turn: TurnRequest,
    completion: {
      status: "completed" | "failed" | "canceled";
      threadUpdatedAt: number;
      resultJson?: string;
      errorMessage?: string;
    },
  ): Promise<void>;
  deliverBrowserSuspension(
    turn: TurnRequest,
    pending: PendingBrowserSuspension,
  ): Promise<boolean>;
  alarm(): Promise<void>;
  runScheduledTurnAlarm(): Promise<void>;
  runAlarmWithLease(turn: TurnRequest): Promise<void>;
  runAlarm(turn: TurnRequest): Promise<void>;
  acknowledgeExactAgentTurnCancellation(
    request: ExactTurnCancellationRequest,
  ): Promise<boolean>;
  acknowledgeExactCancellationFromAlarm(
    turn: TurnRequest,
    cancellation: ExactTurnCancellation,
  ): Promise<boolean>;
  expireCurrentAgentTurn(request: Request): Promise<Response>;
  cancelExactAgentTurn(
    request: ExactTurnCancellationRequest,
    reason: string,
  ): Promise<Response>;
  brokerFailure(status: number): Response;
  brokerCheckpointPending(): Response;
  executeTurnStateCheckpoint(args: {
    turn: TurnRequest;
    operationKey: string;
    operation: Extract<TurnStateCheckpointOperation, { state: "pending" }> & {
      payload: TurnBrokerTurnStateCheckpointRequest;
    };
  }): Promise<TurnBrokerTurnStateCheckpointReceipt>;
  observeBrowserGatewaySuspension(
    turn: TurnRequest,
    input: {
      brokerRequestId: string;
      requestBodySha256: string;
      responseBodySha256: string;
      suspension: CloudBrowserSuspension;
    },
  ): Promise<"stored" | "replay" | "conflict" | "inactive">;
  handleBrokerLocalRequest(
    turn: TurnRequest,
    target: TurnBrokerTarget,
    decoded: unknown,
    signal: AbortSignal,
  ): Promise<Response>;
  handleTurnBroker(request: Request): Promise<Response>;
  handleSteer(request: Request): Promise<Response>;
  fetch(request: Request): Promise<Response>;
  admittedComputePlan(turn: TurnRequest): TurnComputePlan | undefined;
  admitAgentTurnThroughOwnerGate(
    turn: TurnRequest,
  ): Promise<
    { ok: true; snapshot: OwnerSnapshot } | { ok: false; response: Response }
  >;
  agentTurnAccepted(
    turn: TurnRequest,
    replayed: boolean,
    extra?: Record<string, unknown>,
  ): Response;
  projectAgentTurnStart(turn: TurnRequest): Promise<void>;
  acceptAgentTurn(turn: TurnRequest): Promise<Response>;
  runEcho(): Promise<Response>;
  proxyVitePreview(request: Request): Promise<Response>;
  runAgentTurn(
    turn: TurnRequest,
    sandboxId: string | undefined,
    execution: TurnExecutionContext,
  ): Promise<void>;
  resolveAgentWorldRestore(
    turn: TurnRequest,
    execution: TurnExecutionContext,
    history: AgentHistoryRow[],
  ): Promise<{
    turnStateWorkspaceRestore?: TurnStateWorkspaceHead;
    turnStateWorkspaceRestoreConfirmationRequired: boolean;
    turnStateThreadRestore?: TurnStateCandidate;
    turnStateThreadRestoreConfirmationRequired: boolean;
  }>;
  prepareAgentBrokerHandoff(args: {
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
  }>;
  runResidentAgentTurn(
    turn: TurnRequest,
    plan: Extract<GeneralAgentTurnPlan, { kind: "resident_stella" }>,
    execution: TurnExecutionContext,
  ): Promise<GeneralAgentTurnResult>;
  finishResidentAgentTurn(
    turn: TurnRequest,
    ladder: Pick<ReturnType<typeof createAgentComputeLadder>, "teardown">,
    result: GeneralAgentTurnResult,
    requestStarted: number,
  ): Promise<void>;
  releaseResidentCompute(
    turn: TurnRequest,
    ladder: Pick<ReturnType<typeof createAgentComputeLadder>, "teardown">,
  ): Promise<void>;
  commitResidentTurnDurability(args: {
    turn: TurnRequest;
    execution: TurnExecutionContext;
    ladder: ReturnType<typeof createAgentComputeLadder>;
    sealed: SealedTurnTranscript;
    /** The turn's final assistant text; delivered files derive from its links. */
    finalText: string;
    control: ReturnType<typeof createAgentControlPlane>;
    commandTimeoutMs: number;
  }): Promise<Exclude<TurnDurability, { kind: "none" }>>;
  residentAttachHistory(
    turn: TurnRequest,
    execution: TurnExecutionContext,
  ): AgentHistoryRow[];
  publishResidentTurnWorkspace(
    turn: TurnRequest,
    execution: TurnExecutionContext,
    checkpoint: TurnBrokerTurnStateCheckpointReceipt,
  ): Promise<void>;
  runResidentTurnStateCheckpoint(args: {
    turn: TurnRequest;
    historyCursor: string;
  }): Promise<TurnBrokerTurnStateCheckpointReceipt>;
  deliverResidentTerminal(
    turn: TurnRequest,
    result: GeneralAgentTurnResult,
    requestStarted: number,
  ): Promise<void>;
  runContainerAgentTurn(
    turn: TurnRequest,
    sandboxId: string,
    execution: TurnExecutionContext,
  ): Promise<void>;
  attachAgentWorld(args: {
    turn: TurnRequest;
    execution: TurnExecutionContext;
    sandbox: ReturnType<BuildSessionInternals["sandbox"]>;
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
  }>;
  runAgentAttempt(args: {
    turn: TurnRequest;
    execution: TurnExecutionContext;
    sandbox: ReturnType<BuildSessionInternals["sandbox"]>;
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
  }>;
  runTurn(
    turn: TurnRequest,
    turnExecution: TurnExecutionContext,
  ): Promise<Response>;
}
