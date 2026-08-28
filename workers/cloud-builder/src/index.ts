import { DurableObject } from "cloudflare:workers";
import {
  getSandbox,
  Sandbox as SandboxBase,
  type DirectoryBackup,
  type ExecutionSession,
  type Sandbox as SandboxType,
} from "@cloudflare/sandbox";
import { OrchestratorSession } from "./orchestrator-session.js";
import { sha256BytesHex, sha256Hex } from "./hash.js";
import {
  checkpointBackupName,
  checkpointKey,
  instanceSizeKey,
  resolveWorkspace,
} from "./workspace.js";
import {
  INSTANCE_TIERS,
  asInstanceSize,
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
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { CLOUD_AGENT_TURN_RESULT_PATH } from "@stella/executor-cloud/agent-turn-result-file";
import {
  isCloudBrowserResumeReceipt,
  isCloudBrowserSuspension,
  type CloudBrowserResumeReceipt,
  type CloudBrowserSuspension,
} from "@stella/contracts/cloud-browser";
import { parseOwnerTransferRequest } from "./owner-transfer.js";
import { OwnerTransferArchiveConflictError } from "./owner-transfer.js";
import {
  OWNER_PRODUCT_TRANSFER_LEASE_MS,
  assertOwnerTransferReservation,
  collectCheckpointRecoveryReferences,
  createOwnerTransferBudget,
  isValidOwnerTransferPrefixPair,
  missingOwnerProductTransferBinding,
  ownerTransferLeaseConflicts,
  parseOwnerProductTransferRequest,
  replaceOwnerPrefix,
  resolveWorkspaceTransfer,
  takeOwnerTransferBatch,
  transferredBackupId,
  type OwnerProductTransferRequest,
  type OwnerTransferBudget,
  type OwnerWorkspaceTransfer,
  type WorkspaceTransferResolution,
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
  appBuildCallbackDisposition,
  isOwnerAppBuildPrefix,
  ownerAppBuildPrefix,
  ownerAppBuildRoot,
  retireTransientAppBuild,
} from "./app-build-artifacts.js";
import {
  normalizeOwnerGeneration,
  ownerGenerationMatches,
  ownerPurgeBeginDisposition,
  ownerPurgeReleaseDisposition,
} from "./owner-generation.js";
import { parseConversationEditRequest } from "./conversation-edit-protocol.js";
import {
  conversationEditErrorResponse,
  runConversationEdit,
} from "./conversation-edit-runner.js";
import {
  handleInternalCloudHomeRoute,
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
  startTurnExecution,
  type TurnExecution,
  type TurnExecutionContext,
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
} from "./turn-credential-broker.js";
import {
  handleTurnStateOwnerRoute,
  type TurnStateTransferActivationResponse,
  type TurnStateTransferDestinationStatus,
  type TurnStateTransferExportResponse,
  type TurnStateTransferManifest,
  type TurnStateTransferRetireResponse,
} from "./turn-state-owner-routes.js";
import {
  restoreTurnStateArchive,
  uploadTurnStateArchive,
  type TurnStateWorkspaceRoot,
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
  TurnBrokerTurnStateCheckpointReceipt,
  TurnBrokerTurnStateCheckpointRequest,
} from "@stella/contracts/turn-credential-broker";
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

export { Sandbox } from "@cloudflare/sandbox";
export { OrchestratorSession };
export { OwnerTransferCoordinator };

/**
 * The small rung of the instance ladder. Container size is declared per class
 * in wrangler.jsonc and cannot be chosen per request, so a second class over
 * the same image is the only way to run a cheap turn cheaply. Behaviorally
 * identical to `Sandbox`.
 */
export class SandboxSmall extends SandboxBase<Env> {}

type Env = {
  Sandbox: DurableObjectNamespace<SandboxType>;
  // Optional: a deployment without the binding runs every turn on `Sandbox`,
  // which is exactly the pre-ladder behavior.
  SANDBOX_SMALL?: DurableObjectNamespace<SandboxType>;
  BUILD_SESSIONS: DurableObjectNamespace<BuildSession>;
  ORCHESTRATOR_SESSIONS: DurableObjectNamespace<OrchestratorSession>;
  OWNER_TRANSFER_COORDINATORS: DurableObjectNamespace<OwnerTransferCoordinator>;
  /** Private Browser Run boundary. It alone owns Browser/R2 profile secrets. */
  BROWSER_GATEWAY?: Fetcher;
  APP_BUILDS: R2Bucket;
  APP_ROUTES: KVNamespace;
  BACKUP_BUCKET: R2Bucket;
  AGENT_HOME?: R2Bucket;
  // Rolled-over conversation segments and oversize-row spills. The DO reads it
  // through its own Env; this worker needs it only for the owner-level sweep
  // at `POST /owners/purge`.
  CONVERSATION_ARCHIVE?: R2Bucket;
  BUILDER_SERVICE_SECRET: string;
  TURN_TIMEOUT_MS: string;
  SANDBOX_IDLE_TIMEOUT_MS: string;
  APPS_HOST_BASE_URL: string;
  // The Convex site origin. Pinned issuer for every user JWT this worker
  // verifies, and the JWKS base. Optional in the type so a deployment that has
  // not set it fails closed on the socket routes instead of failing to boot —
  // but the socket surface is dead until it is present.
  STELLA_CONVEX_SITE_URL?: string;
  STELLA_CONVEX_CLOUD_URL?: string;
  /** Dev-only proof surface; production deployments omit or disable it. */
  ENABLE_DEV_ACCEPTANCE_PROBES?: string;
  STELLA_DEPLOYMENT_IDENTITY?: string;
};

/**
 * Clone credentials for a `project:` workspace, fetched fresh at turn start.
 * The token is a short-lived GitHub App installation token and is held in a
 * local for the length of one attempt: never a log line, never DO storage,
 * never an event payload — and never the turn-input file the agent can read
 * (see {@link projectCredentialsPath}).
 */
type ProjectHandoff = {
  remoteUrl: string;
  token?: string;
  defaultBranch: string;
  branch: string;
  setupScript?: string;
  /** Commit identity: the GitHub user who connected the installation. */
  authorName?: string;
  authorEmail?: string;
};

/**
 * Where the installation token is handed to the executor: a one-shot file the
 * executor reads and unlinks before it builds the agent's tool host, so no
 * agent tool ever runs while it exists. It sits above the workspace root
 * (`/workspace/<kind>`) so it is outside the checkpointed directory, and the
 * name is random so nothing can be waiting on a known path.
 *
 * Deliberately not an env var on the exec session: the executor's own
 * environment is inherited by every shell the agent spawns, and `unsetenv`
 * does not scrub `/proc/<pid>/environ`, so an env handoff stays readable for
 * the whole turn — which is the defect this avoids.
 */
const projectCredentialsPath = (): string =>
  `/workspace/.project-credentials-${crypto.randomUUID()}.json`;

const turnBrokerCredentialsPath = (): string =>
  `/workspace/.turn-broker-${crypto.randomUUID()}.json`;

/** An error whose message is safe to show the user verbatim. */
class AgentTurnError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "AgentTurnError";
  }
}

/** Exact Convex attempt/token authority was revoked or could not be proven. */
class AgentTurnAuthorityLostError extends Error {
  constructor() {
    super("Cloud agent attempt authority was lost.");
    this.name = "AgentTurnAuthorityLostError";
  }
}

/** Exact Convex app-turn/token authority was revoked or could not be proven. */
class AppTurnAuthorityLostError extends Error {
  constructor() {
    super("Cloud app attempt authority was lost.");
    this.name = "AppTurnAuthorityLostError";
  }
}

class ConvexCallbackError extends Error {
  constructor(
    readonly path: string,
    readonly status?: number,
  ) {
    super(
      status === undefined
        ? `Convex callback ${path} did not return a response.`
        : `Convex callback ${path} failed with ${status}.`,
    );
    this.name = "ConvexCallbackError";
  }
}

type Execution = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

type TurnRequest = {
  // "agent" runs a spawned general agent against a persistent workspace;
  // absent/anything else is the legacy app-build turn.
  kind?: string;
  ownerId: string;
  appId: string;
  turnId: string;
  prompt: string;
  turnToken: string;
  convexCallbackBase: string;
  autoActivate?: boolean;
  preflightDelayMs?: number;
  watchdogMs?: number;
  /** Trusted control-plane continuation of a suspended browser tool call. */
  browserResume?: CloudBrowserResumeReceipt;
  conversationId?: string;
  sessionId?: string;
  threadId?: string;
  workspace?: string;
  /** Exact immutable route selected by Convex for this turn. */
  execution?: CloudExecutionSelection;
  /** Convex owner-lifecycle generation captured before this dispatch. */
  ownerGeneration: string;
  /** Monotonic generation of this exact reused agent thread attempt. */
  attemptGeneration?: number;
  /** Trusted outer-router facts; never accepted from the dispatch body. */
  turnBrokerRoute?: {
    sessionId: string;
    endpoint: string;
  };
  /** Worker-issued lease. Callers cannot choose this value. */
  ownerPurgeGeneration?: string;
  ownerPurgeLeaseId?: string;
};

const turnDispatchIdentity = (
  turn: TurnRequest,
): Omit<TurnRequest, "ownerPurgeGeneration" | "ownerPurgeLeaseId"> => {
  const identity = { ...turn };
  delete identity.ownerPurgeGeneration;
  delete identity.ownerPurgeLeaseId;
  return identity;
};

/**
 * The owner-purge lease changes when an alarm borrows an auxiliary lease, so
 * it is intentionally excluded. Everything that can distinguish an ABA turn
 * (including its token and agent attempt generation) remains exact.
 */
const exactTurnIdentityMatches = (
  current: TurnRequest | undefined,
  expected: TurnRequest,
): boolean =>
  current !== undefined &&
  current.ownerId === expected.ownerId &&
  current.ownerGeneration === expected.ownerGeneration &&
  current.turnId === expected.turnId &&
  current.turnToken === expected.turnToken &&
  current.kind === expected.kind &&
  current.appId === expected.appId &&
  current.conversationId === expected.conversationId &&
  current.sessionId === expected.sessionId &&
  current.threadId === expected.threadId &&
  current.attemptGeneration === expected.attemptGeneration &&
  JSON.stringify(current.browserResume ?? null) ===
    JSON.stringify(expected.browserResume ?? null);

type OwnerPurgeMode = "temporary" | "permanent";
type OwnerPurgeFence = {
  /** Bound on the first trusted direct call into this owner-named DO. */
  ownerId?: string;
  generation: string;
  /** Convex lifecycle operation that created the current blocked fence. */
  beginRequestId?: string;
  /** Makes a durable retry of the last temporary release idempotent. */
  lastReleasedGeneration?: string;
  /** Released generation whose rejoin produced the current blocked fence. */
  rejoinedFromGeneration?: string;
  state: "open" | "blocked";
  mode?: OwnerPurgeMode;
  active: Record<
    string,
    {
      leaseId: string;
      sessionId: string;
      turnId: string;
      namespace: "build" | "orchestrator" | "activity";
      role: "run" | "aux" | "orchestrator" | "activity" | "transfer";
      /** Convex owner-lifecycle generation carried by the admitted activity. */
      ownerGeneration?: string;
      /** Fence generation returned when this exact lease was admitted. */
      reservationGeneration?: string;
      workspace?: string;
      /** Optional bounded lease used by cross-service control-plane work. */
      expiresAt?: number;
    }
  >;
};

type TransientAppBuildRoute = {
  key: string;
  ownerId: string;
  appId: string;
  buildId: string;
  artifactPrefix: string;
  previousRoute?: Record<string, unknown>;
};

type PendingAppBuildPublication = {
  turnId: string;
  phase: "callback" | "cleanup";
  artifactPrefix: string;
  callbackBody: Record<string, unknown>;
  completionSeq: number | "auto";
  completionResult: Record<string, unknown>;
  failureMessage?: string;
};

type TurnStateCheckpointOperation =
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

type BuilderFallbackTranscript = {
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

type AgentExecutionMarker = {
  schemaVersion: 1;
  turnId: string;
  attemptGeneration: number;
  sandboxId: string;
  size: InstanceSize;
  workspace: string;
  workspaceRoot: TurnStateWorkspaceRoot;
  startedAt: number;
};

class OwnerPurgeFenceError extends Error {
  constructor() {
    super("This owner's cloud activity is being purged.");
    this.name = "OwnerPurgeFenceError";
  }
}

class TurnStateOwnerCallError extends Error {
  constructor(readonly status: number) {
    super(`Turn state owner operation failed (${status}).`);
    this.name = "TurnStateOwnerCallError";
  }
}

type AgentExecutorResult = {
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
  // Present on `project:` turns: what the executor did with the repository,
  // plus the setup command it had to infer because the project had none.
  project?: {
    mode?: string;
    branch?: string;
    setupCommand?: string;
    setupSource?: string;
  };
};

type InteriorBuildOutput = {
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

const INTERIOR_BRIDGE_ABI = 1;
const INTERIOR_MIN_SHELL_VERSION = "0.0.0";
const INTERIOR_MAX_FILES = 2_000;
const INTERIOR_MAX_BYTES = 100 * 1024 * 1024;
const INTERIOR_MAX_FILE_BYTES = 25 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_ARTIFACT_PATH =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A terminal state that has been decided but may not have reached Convex yet.
 *
 * It is written to DO storage before the first delivery attempt so the alarm
 * can re-deliver exactly this, unchanged. Without it the success path was the
 * one terminal path with no retry, and it is the one carrying the only copy of
 * the agent's report.
 */
type PendingTerminal = {
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
};

/**
 * Durable handoff from a finished executor to Convex's waiting projection.
 * The descriptor is intentionally secret-free. It is committed before the
 * sandbox is destroyed so a Worker restart can redeliver the same interaction.
 */
type PendingBrowserSuspension = {
  schemaVersion: 1;
  turnId: string;
  attemptGeneration: number;
  suspension: CloudBrowserSuspension;
  payload: Record<string, unknown>;
  createdAt: number;
};

const PENDING_BROWSER_SUSPENSION_KEY = "pendingBrowserSuspension";

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

const OBSERVED_BROWSER_SUSPENSION_KEY = "observedBrowserSuspension";
const BROWSER_GATEWAY_RESPONSE_MAX_BYTES = 64 * 1024;

type AgentHistoryRow = {
  seq: number;
  role: string;
  payloadJson: string;
  turnId: string;
};

const AGENT_HISTORY_MAX_ROWS = 400;
const AGENT_HISTORY_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;

type ExecutorResult = {
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

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

class BrowserGatewayResponseTooLargeError extends Error {
  constructor() {
    super("Browser Gateway response exceeded its bound.");
    this.name = "BrowserGatewayResponseTooLargeError";
  }
}

/** Bound a service-binding response even when Content-Length is absent. */
const readBrowserGatewayResponseBody = async (
  response: Response,
): Promise<Uint8Array> => {
  const declared = response.headers.get("content-length");
  if (declared) {
    const parsed = Number(declared);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < 0 ||
      parsed > BROWSER_GATEWAY_RESPONSE_MAX_BYTES
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new BrowserGatewayResponseTooLargeError();
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > BROWSER_GATEWAY_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BrowserGatewayResponseTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const withInfrastructureDeadline = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const log = (
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) => {
  console[level](
    JSON.stringify({
      service: "stella-v2-cloud-builder",
      event,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
};

const authorized = (request: Request, env: Env): boolean =>
  request.headers.get("authorization") ===
  `Bearer ${env.BUILDER_SERVICE_SECRET}`;

/**
 * The single spelling of a conversation id, used as the Durable Object name.
 *
 * Four callers build these URLs — Convex (raw), the socket client, the runtime
 * journal writer, and the dev probe — and two of them percent-encode. Two
 * spellings of one id would address two DIFFERENT Durable Objects, which is a
 * split-brain no amount of downstream care recovers from. Decoding once here
 * makes every spelling converge; conversation ids are `crypto.randomUUID()`, so
 * decode is the identity for every id that exists today and this only closes
 * the latent case. A segment that is not valid percent-encoding is used as-is
 * rather than throwing — it cannot match a real conversation either way.
 */
const conversationName = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
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

const ORCHESTRATOR_INTERNAL_ORIGIN = "https://orchestrator-session";
const HEADER_CONVERSATION_ID = "x-stella-conversation-id";
const HEADER_BUILD_SESSION_NAME = "x-stella-build-session-name";
const HEADER_TURN_BROKER_ENDPOINT = "x-stella-turn-broker-endpoint";
const HEADER_OWNER_FENCE_ID = "x-stella-owner-fence-id";

type ConversationCaller = {
  ownerId: string;
  subject: string;
  sessionId: string;
  expiresAtMs: number;
  issuer: string;
};

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

const sessionName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);

const TOOL_WORKSPACE_ROOTS = new Set([
  "/workspace/drive",
  "/workspace/project",
  "/workspace/app",
  "/workspace/stella",
]);

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
    "if [ -e /workspace/.stella-tool-home ] || [ -L /workspace/.stella-tool-home ]; then test -d /workspace/.stella-tool-home && test ! -L /workspace/.stella-tool-home && test \"$(stat -c '%u:%g:%a' /workspace/.stella-tool-home)\" = 42424:42424:700; else mkdir /workspace/.stella-tool-home && chown 42424:42424 /workspace/.stella-tool-home && chmod 0700 /workspace/.stella-tool-home; fi",
    "test ! -L /home/stella-native-state",
    'test "$(readlink -f /home/stella-native-state)" = /home/stella-native-state',
    "test \"$(stat -c '%u:%g:%a' /home/stella-native-state)\" = 0:0:700",
    "test ! -L /home/stella-host-state",
    'test "$(readlink -f /home/stella-host-state)" = /home/stella-host-state',
    "test \"$(stat -c '%u:%g:%a' /home/stella-host-state)\" = 0:0:700",
  ].join("; ");
  const result = await session.exec(command);
  if (!result.success) {
    throw new Error("Cloud workspace mount boundary validation failed.");
  }
};

/**
 * Seed the first Stella interior, then re-establish the directory boundary.
 *
 * GNU `cp -a source/. destination/` preserves the source directory's mode on
 * the existing destination. The immutable renderer source is 0755, while a
 * cloud workspace root must remain 0750, so the copy can otherwise make the
 * executor and its fallback checkpoint reject the freshly seeded workspace.
 */
export const seedFirstStellaToolWorkspace = async (
  session: Pick<ExecutionSession, "exec">,
): Promise<void> => {
  const seeded = await strictSessionExec(session, [
    "/bin/sh",
    "-lc",
    "set -eu; cp -a /opt/stella/packages/desktop-ui/. /workspace/stella/; ln -s /opt/stella/node_modules /workspace/stella/node_modules; mkdir /workspace/stella/.stella; cp /opt/stella/interior-seed.json /workspace/stella/.stella/interior-source.json",
  ]);
  if (!seeded.success) {
    throw new Error("The Stella interior source seed could not be created.");
  }
  await normalizeToolWorkspaceRoot(session, "/workspace/stella");
};

const contentType = (path: string): string => {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".mjs"))
    return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".map")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".woff")) return "font/woff";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".ttf")) return "font/ttf";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".webmanifest")) return "application/manifest+json";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
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

/** Longer than the 30s callback timeout; covers an evicted isolate's last send. */
const OWNER_PURGE_STALE_LEASE_GRACE_MS = 35_000;
const backupDebtKey = (workspaceKey: string): string =>
  `${workspaceKey}:backup-debt`;
const turnStateCheckpointOperationKey = (requestId: string): string =>
  `turnStateCheckpointOperation:${requestId}`;
const builderFallbackTranscriptKey = (
  turnId: string,
  attemptGeneration: number,
): string => `builderFallbackTranscript:${turnId}:${attemptGeneration}`;
const agentExecutionMarkerKey = (
  turnId: string,
  attemptGeneration: number,
): string => `agentExecutionMarker:${turnId}:${attemptGeneration}`;
const turnStateBaseWorkspaceRevisionKey = (
  turnId: string,
  attemptGeneration: number,
): string => `turnStateBaseWorkspaceRevision:${turnId}:${attemptGeneration}`;
const asTurnStateWorkspaceRoot = (
  value: string | undefined,
): TurnStateWorkspaceRoot | null => {
  switch (value) {
    case "/workspace/drive":
    case "/workspace/project":
    case "/workspace/app":
    case "/workspace/stella":
      return value;
    default:
      return null;
  }
};
const parseLegacyWorkspaceBackup = (
  value: unknown,
  expectedDirectory: TurnStateWorkspaceRoot,
): DirectoryBackup | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "dir,id,localBucket" ||
    typeof record.id !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(record.id) ||
    record.dir !== expectedDirectory ||
    record.localBucket !== true
  ) {
    return null;
  }
  return record as unknown as DirectoryBackup;
};
const validTurnStateCheckpointReceipt = (
  value: unknown,
): value is TurnBrokerTurnStateCheckpointReceipt => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "operationId",
    "historyCursor",
    "workspaceSha256",
    "nativeSha256",
    "receipt",
    "replayed",
  ]);
  return (
    Object.keys(receipt).every((key) => allowed.has(key)) &&
    receipt.schemaVersion === 1 &&
    typeof receipt.operationId === "string" &&
    /^[0-9a-f]{64}$/u.test(receipt.operationId) &&
    typeof receipt.historyCursor === "string" &&
    /^(?:v1:empty|v1:[0-9a-f]{64})$/u.test(receipt.historyCursor) &&
    typeof receipt.workspaceSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(receipt.workspaceSha256) &&
    (receipt.nativeSha256 === undefined ||
      (typeof receipt.nativeSha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(receipt.nativeSha256))) &&
    typeof receipt.receipt === "string" &&
    /^[0-9a-f]{64}$/u.test(receipt.receipt) &&
    typeof receipt.replayed === "boolean"
  );
};

const cloudBrowserSuspensionMarker = (
  suspension: CloudBrowserSuspension,
): string =>
  JSON.stringify([
    suspension.schemaVersion,
    suspension.outcome,
    suspension.interactionId,
    suspension.interactionRevision,
    suspension.interactionKind,
    suspension.toolCallId,
    suspension.requestDigest,
    suspension.profileId,
    suspension.profileEpoch,
    suspension.displayOrigin,
    suspension.displayTitle ?? null,
    suspension.expiresAt,
  ]);

const canonicalToolCallId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  new TextEncoder().encode(value).byteLength <= 256 &&
  !/[\u0000-\u001f\u007f]/u.test(value);

/**
 * Bind the Gateway's neutral request id to the one unresolved outer Code call
 * in the exact canonical checkpoint. This is the trust boundary that makes a
 * Gateway observation resumable after executor stdout/finalizer loss.
 */
export const bindObservedBrowserSuspensionToCanonicalCodeCall = async (args: {
  observation: ObservedBrowserSuspension;
  turnId: string;
  attemptGeneration: number;
  checkpoint: TurnBrokerTurnStateCheckpointReceipt;
  rows: Array<{ turnId: string; role: string; payloadJson: string }>;
  now?: number;
}): Promise<CloudBrowserSuspension | null> => {
  const { observation, checkpoint, rows } = args;
  const now = args.now ?? Date.now();
  if (
    observation.schemaVersion !== 1 ||
    observation.turnId !== args.turnId ||
    observation.attemptGeneration !== args.attemptGeneration ||
    !Number.isSafeInteger(observation.observedAt) ||
    observation.observedAt < 0 ||
    typeof observation.brokerRequestId !== "string" ||
    observation.brokerRequestId.length === 0 ||
    !SHA256_HEX.test(observation.requestBodySha256) ||
    !SHA256_HEX.test(observation.responseBodySha256) ||
    !isCloudBrowserSuspension(observation.suspension) ||
    observation.suspension.expiresAt <= now ||
    !validTurnStateCheckpointReceipt(checkpoint) ||
    rows.at(-1)?.turnId !== args.turnId ||
    (await nativeHistoryCursorFromRows(rows)) !== checkpoint.historyCursor
  ) {
    return null;
  }

  const currentRows = rows.filter((row) => row.turnId === args.turnId);
  if (currentRows.length === 0) return null;
  const parsedRows: Array<{
    row: (typeof currentRows)[number];
    payload: Record<string, unknown>;
  }> = [];
  for (const row of currentRows) {
    try {
      const payload = JSON.parse(row.payloadJson) as unknown;
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        (payload as Record<string, unknown>).role !== row.role
      ) {
        return null;
      }
      parsedRows.push({ row, payload: payload as Record<string, unknown> });
    } catch {
      return null;
    }
  }

  let assistantIndex = -1;
  for (let index = parsedRows.length - 1; index >= 0; index -= 1) {
    if (parsedRows[index]?.row.role === "assistant") {
      assistantIndex = index;
      break;
    }
  }
  if (
    assistantIndex < 0 ||
    parsedRows
      .slice(assistantIndex + 1)
      .some((entry) => entry.row.role !== "toolResult")
  ) {
    return null;
  }

  const assistantContent = parsedRows[assistantIndex]?.payload.content;
  if (!Array.isArray(assistantContent)) return null;
  const toolCalls: Array<{ id: string; name: string }> = [];
  for (const part of assistantContent) {
    if (
      !part ||
      typeof part !== "object" ||
      Array.isArray(part) ||
      (part as Record<string, unknown>).type !== "toolCall"
    ) {
      continue;
    }
    const candidate = part as Record<string, unknown>;
    if (
      !canonicalToolCallId(candidate.id) ||
      typeof candidate.name !== "string"
    ) {
      return null;
    }
    toolCalls.push({ id: candidate.id, name: candidate.name });
  }

  const resolved = new Set<string>();
  for (const entry of parsedRows.slice(assistantIndex + 1)) {
    if (
      entry.row.role !== "toolResult" ||
      !canonicalToolCallId(entry.payload.toolCallId)
    ) {
      return null;
    }
    resolved.add(entry.payload.toolCallId);
  }
  const unresolved = toolCalls.filter((call) => !resolved.has(call.id));
  if (unresolved.length !== 1 || unresolved[0]?.name !== "code") return null;

  const bound = {
    ...observation.suspension,
    toolCallId: unresolved[0].id,
  };
  return isCloudBrowserSuspension(bound) ? bound : null;
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
    "project",
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

  if (result.project !== undefined) {
    if (
      !result.project ||
      typeof result.project !== "object" ||
      Array.isArray(result.project)
    ) {
      return null;
    }
    const project = result.project as Record<string, unknown>;
    if (
      !Object.keys(project).every((key) =>
        ["mode", "branch", "setupCommand", "setupSource"].includes(key),
      ) ||
      Object.values(project).some(
        (entry) => entry !== undefined && typeof entry !== "string",
      )
    ) {
      return null;
    }
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
): Promise<string> => {
  const aborted = (): unknown => signals.find((signal) => signal.aborted)?.reason;
  while (true) {
    const reason = aborted();
    if (reason !== undefined) {
      throw reason instanceof Error
        ? reason
        : new Error("Agent result observation was canceled.");
    }
    const recorded = await readCloudAgentTurnResultText(session);
    const afterReadReason = aborted();
    if (afterReadReason !== undefined) {
      throw afterReadReason instanceof Error
        ? afterReadReason
        : new Error("Agent result observation was canceled.");
    }
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
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, 250);
      const listeners = signals.map((signal) => {
        const listener = () => {
          cleanup();
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Agent result observation was canceled."),
          );
        };
        signal.addEventListener("abort", listener, { once: true });
        return { signal, listener };
      });
      function cleanup() {
        clearTimeout(timer);
        for (const { signal, listener } of listeners) {
          signal.removeEventListener("abort", listener);
        }
      }
      function done() {
        cleanup();
        resolve();
      }
    });
  }
};

const nativeTransientBackupKey = (turnId: string): string =>
  `nativeTransientBackup:${turnId}`;
const nativeBackupDebtKey = (workspaceKey: string): string =>
  `${workspaceKey}:native-backup-debt`;
type NativeTransientBackup = {
  backupId: string;
  checkpointKey: string;
  workspaceKey: string;
};
const nativeStateIntegrityKeyFor = async (
  env: Pick<Env, "BUILDER_SERVICE_SECRET">,
  turn: Pick<TurnRequest, "ownerId" | "ownerGeneration" | "threadId">,
): Promise<string> =>
  await sha256Hex(
    [
      "stella-native-state-v2",
      env.BUILDER_SERVICE_SECRET,
      turn.ownerId,
      turn.ownerGeneration,
      turn.threadId,
    ].join("\u0000"),
  );
const transientBuildRouteKey = (turnId: string): string =>
  `transientBuildRoute:${turnId}`;
const AGENT_WATCHDOG_DEADLINE_KEY = "agentWatchdogDeadlineAt";
const AGENT_RECOVERY_PENDING_KEY = "agentRecoveryPending";
const agentRecoveryIdentity = (turn: TurnRequest): string =>
  `${turn.turnId}:${turn.attemptGeneration ?? 0}`;
const pendingAppBuildPublicationKey = (turnId: string): string =>
  `pendingAppBuildPublication:${turnId}`;
type WorkspaceBackupDebt = { backupIds: string[] };
const checkpointImportsKey = (workspaceKey: string): string =>
  `${workspaceKey}:checkpoint-imports`;
type WorkspaceCheckpointImport = {
  sourceWorkspaceKey: string;
  sourceWorkspace: string;
  descriptor?: DirectoryBackup;
  backupIds: string[];
  /** Finds pre-cleanup-debt backups during eventual account/workspace purge. */
  historicalBackupName: string;
  instanceSize?: string;
};
type WorkspaceCheckpointImports = {
  schemaVersion: 1;
  imports: WorkspaceCheckpointImport[];
};
/** Legacy eventual-KV receipt key, retained only so purge removes old rows. */
const workspaceTransferReceiptsKey = (workspaceKey: string): string =>
  `${workspaceKey}:owner-transfer-receipts`;

export class BuildSession extends DurableObject<Env> {
  private readonly runningTurns = new Map<string, Set<Promise<unknown>>>();
  /** Effect-supervised app-build work; owner purge interrupts before joining. */
  private readonly appTurnExecutions = new Map<
    string,
    TurnExecution<Response>
  >();
  /** Effect-supervised spawned-agent work; Stop never joins a raw promise. */
  private readonly agentTurnExecutions = new Map<string, TurnExecution<void>>();
  /**
   * Alarm recovery interrupts an exact run without destroying its disk. The
   * interrupt hooks consult this set, kill/join only the model-controlled
   * session, and leave the sandbox mounted for the trusted fallback archiver.
   */
  private readonly builderFallbackRecoveries = new Set<string>();
  /** Exact replay joins one in-flight archive build instead of racing scratch. */
  private readonly turnStateCheckpointRuns = new Map<
    string,
    Promise<TurnBrokerTurnStateCheckpointReceipt>
  >();
  private readonly exactTurnCancellations = new ExactTurnCancellationLedger(
    this.ctx.storage,
  );

  /**
   * Normal turn cleanup must retain exact cancellation receipts. The key list
   * is captured while input is gated and the deletion is one transaction, so
   * a crash or concurrent Stop cannot open a tombstone-loss window. Owner
   * purge intentionally continues to use deleteAll().
   */
  private async deleteTurnStoragePreservingExactCancellations(
    expectedTurn?: TurnRequest,
    deleteAlarm = false,
  ): Promise<boolean> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      if (
        expectedTurn &&
        !exactTurnIdentityMatches(
          await this.ctx.storage.get<TurnRequest>("turn"),
          expectedTurn,
        )
      ) {
        return false;
      }
      const keys = [...(await this.ctx.storage.list<unknown>()).keys()].filter(
        (key) => key !== EXACT_TURN_CANCELLATIONS_KEY,
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
        if (deleteAlarm) await txn.deleteAlarm();
        deleted = true;
      });
      return deleted;
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

  private startAgentTurn(turn: TurnRequest, sandboxId: string): Promise<void> {
    const existing = this.agentTurnExecutions.get(turn.turnId);
    if (existing) return existing.settled;
    const execution = startTurnExecution({
      work: (context) => this.runAgentTurn(turn, sandboxId, context),
      // Cleanup is part of fiber interruption and is bounded by the Effect
      // facade. A Stop ACK therefore means the exact command session and
      // container teardown completed (or the cancellation failed visibly).
      onInterrupt: () =>
        this.builderFallbackRecoveries.has(turn.turnId)
          ? this.quiesceCurrentAgentSession(turn)
          : this.terminateCurrentAgentSandbox(turn),
      // createSession() may ignore AbortSignal and resolve after the immediate
      // destroy. Sweep again after the underlying turn promise has unwound so
      // Stop can never ACK while that late session/container remains live.
      afterInterrupt: () =>
        this.builderFallbackRecoveries.has(turn.turnId)
          ? this.quiesceCurrentAgentSession(turn)
          : this.terminateCurrentAgentSandbox(turn),
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

  private startAppTurn(turn: TurnRequest): Promise<Response> {
    const existing = this.appTurnExecutions.get(turn.turnId);
    if (existing) return existing.settled;
    const execution = startTurnExecution({
      work: (context) => this.runTurn(turn, context),
      // A pending platform createSession may materialize after the first
      // destroy. Interrupt closes the local admission latch; the second sweep
      // runs only after the underlying app-turn promise has unwound.
      onInterrupt: () => this.terminateCurrentAgentSandbox(turn),
      afterInterrupt: () => this.terminateCurrentAgentSandbox(turn),
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

  private async ownerFence(ownerId: string) {
    const ownerHash = await sha256Hex(ownerId);
    return this.env.BUILD_SESSIONS.getByName(`owner-purge-${ownerHash}`);
  }

  private async callOwnerFence(
    ownerId: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return (await this.ownerFence(ownerId)).fetch(
      `https://build-session/owner-fence/${path}`,
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

  private async resolveAgentTurnState(
    turn: TurnRequest,
    workspace: string,
    canonicalHistoryCursor: string,
    options: { allowMissingNative?: boolean } = {},
  ): Promise<ResolvedTurnState> {
    const resolved = await this.callOwnerTurnState<ResolvedTurnState>(
      turn,
      "resolve",
      {
        workspace,
        threadId: turn.threadId,
        canonicalHistoryCursor,
        // Builder validates the engine-specific native half below. Keeping the
        // owner lookup permissive is what lets a pre-registry legacy thread be
        // migrated without treating absence as a canonical empty checkpoint.
        requireNative: false,
      },
    );
    if (
      !resolved ||
      typeof resolved !== "object" ||
      typeof resolved.registryPresent !== "boolean" ||
      typeof resolved.workspaceConfirmationRequired !== "boolean" ||
      !Number.isSafeInteger(resolved.baseWorkspaceRevision) ||
      resolved.baseWorkspaceRevision < 0 ||
      typeof resolved.threadRegistryPresent !== "boolean" ||
      typeof resolved.confirmationRequired !== "boolean" ||
      (!resolved.registryPresent &&
        (resolved.workspace !== undefined ||
          resolved.restore !== undefined ||
          resolved.workspaceConfirmationRequired ||
          resolved.threadRegistryPresent ||
          resolved.confirmationRequired ||
          resolved.baseWorkspaceRevision !== 0)) ||
      (resolved.workspaceConfirmationRequired && !resolved.workspace) ||
      (resolved.workspacePublication !== undefined &&
        (!resolved.registryPresent ||
          typeof resolved.workspacePublication !== "object" ||
          !/^[0-9a-f]{64}$/u.test(resolved.workspacePublication.operationId) ||
          typeof resolved.workspacePublication.publishable !== "boolean")) ||
      (resolved.confirmationRequired && !resolved.restore)
    ) {
      throw new Error("Turn state resolve receipt was invalid.");
    }
    const workspaceHead = resolved.workspace;
    if (
      workspaceHead &&
      (workspaceHead.schemaVersion !== 1 ||
        !/^[0-9a-f]{64}$/u.test(workspaceHead.operationId) ||
        !/^[0-9a-f]{64}$/u.test(workspaceHead.requestFingerprint) ||
        !/^[0-9a-f]{64}$/u.test(workspaceHead.originThreadHash) ||
        typeof workspaceHead.originHistoryCursor !== "string" ||
        !/^(?:v1:empty|v1:[0-9a-f]{64})$/u.test(
          workspaceHead.originHistoryCursor,
        ) ||
        !/^[0-9a-f]{64}$/u.test(workspaceHead.receipt) ||
        !Number.isSafeInteger(workspaceHead.revision) ||
        workspaceHead.revision <= 0 ||
        workspaceHead.revision !== resolved.baseWorkspaceRevision ||
        workspaceHead.archive.kind !== "workspace" ||
        !Number.isSafeInteger(workspaceHead.createdAt) ||
        workspaceHead.createdAt < 0)
    ) {
      throw new Error("Canonical workspace head was invalid.");
    }
    const candidate = resolved.restore;
    if (candidate) {
      if (
        candidate.schemaVersion !== 1 ||
        !/^[0-9a-f]{64}$/u.test(candidate.operationId) ||
        !/^[0-9a-f]{64}$/u.test(candidate.requestFingerprint) ||
        !/^[0-9a-f]{64}$/u.test(candidate.receipt) ||
        candidate.historyCursor !== canonicalHistoryCursor ||
        !Number.isSafeInteger(candidate.createdAt) ||
        candidate.createdAt < 0
      ) {
        throw new Error("Canonical turn state candidate was invalid.");
      }
      if (
        turn.execution?.engine === "anthropic" &&
        !(
          options.allowMissingNative &&
          !candidate.native &&
          !candidate.nativeCheckpoint
        )
      ) {
        if (!candidate.native || !candidate.nativeCheckpoint) {
          throw new AgentTurnError(
            "This agent's saved native session no longer matches its cloud conversation. Start a new agent thread to continue safely.",
          );
        }
        const integrityKey = await nativeStateIntegrityKeyFor(this.env, turn);
        if (
          candidate.nativeCheckpoint.cursor !== canonicalHistoryCursor ||
          !(await validNativeStateCheckpointMac({
            checkpoint: candidate.nativeCheckpoint,
            threadId: turn.threadId!,
            integrityKey,
          }))
        ) {
          throw new AgentTurnError(
            "Stella couldn't validate this agent's saved native session. Try again.",
          );
        }
      }
    }
    return resolved;
  }

  private async publishAgentTurnWorkspace(
    turn: TurnRequest,
    workspace: string,
    canonicalHistoryCursor: string,
    operationId: string,
  ): Promise<TurnStateWorkspaceHead> {
    const published = await this.callOwnerTurnState<{
      workspaceHead?: TurnStateWorkspaceHead;
      publicationReceipt?: unknown;
      replayed?: unknown;
    }>(turn, "publish-workspace", {
      workspace,
      threadId: turn.threadId,
      canonicalHistoryCursor,
      operationId,
    });
    const head = published?.workspaceHead;
    if (
      !head ||
      head.schemaVersion !== 1 ||
      head.operationId !== operationId ||
      head.originHistoryCursor !== canonicalHistoryCursor ||
      !/^[0-9a-f]{64}$/u.test(head.originThreadHash) ||
      !/^[0-9a-f]{64}$/u.test(head.receipt) ||
      !Number.isSafeInteger(head.revision) ||
      head.revision <= 0 ||
      head.archive.kind !== "workspace" ||
      typeof published.publicationReceipt !== "string" ||
      !/^[0-9a-f]{64}$/u.test(published.publicationReceipt) ||
      typeof published.replayed !== "boolean"
    ) {
      throw new Error("Turn state workspace publication was invalid.");
    }
    return head;
  }

  private async confirmAgentTurnStateRestore(
    turn: TurnRequest,
    workspace: string,
    canonicalHistoryCursor: string,
    workspaceHead: TurnStateWorkspaceHead | undefined,
    workspaceConfirmationRequired: boolean,
    threadCandidate: TurnStateCandidate | undefined,
    threadConfirmationRequired: boolean,
  ): Promise<void> {
    if (workspaceConfirmationRequired || threadConfirmationRequired) {
      const confirmed = await this.callOwnerTurnState<{
        workspace?: {
          restore?: TurnStateWorkspaceHead;
          promoted?: unknown;
          replayed?: unknown;
        };
        thread?: {
          restore?: TurnStateCandidate;
          promoted?: unknown;
          replayed?: unknown;
        };
        confirmationReceipt?: unknown;
      }>(turn, "confirm-restore", {
        workspace,
        threadId: turn.threadId,
        canonicalHistoryCursor,
        ...(workspaceConfirmationRequired && workspaceHead
          ? { workspaceOperationId: workspaceHead.operationId }
          : {}),
        ...(threadConfirmationRequired && threadCandidate
          ? { threadOperationId: threadCandidate.operationId }
          : {}),
      });
      if (
        (workspaceConfirmationRequired &&
          (!workspaceHead ||
            confirmed?.workspace?.restore?.operationId !==
              workspaceHead.operationId ||
            confirmed.workspace.restore.receipt !== workspaceHead.receipt ||
            typeof confirmed.workspace.promoted !== "boolean" ||
            typeof confirmed.workspace.replayed !== "boolean")) ||
        (threadConfirmationRequired &&
          (!threadCandidate ||
            confirmed?.thread?.restore?.operationId !==
              threadCandidate.operationId ||
            confirmed.thread.restore.historyCursor !== canonicalHistoryCursor ||
            confirmed.thread.restore.receipt !== threadCandidate.receipt ||
            typeof confirmed.thread.promoted !== "boolean" ||
            typeof confirmed.thread.replayed !== "boolean")) ||
        typeof confirmed?.confirmationReceipt !== "string" ||
        !/^[0-9a-f]{64}$/u.test(confirmed.confirmationReceipt)
      ) {
        throw new Error("Turn state restore confirmation was invalid.");
      }
    }
    // Deletion begins only after both archives were restored and verified and
    // the exact candidate was atomically promoted. A lost drain response is
    // safe: retirement rows remain authoritative until DELETE+HEAD succeeds.
    await this.callOwnerTurnState(turn, "drain", {
      workspace,
      limit: 32,
    });
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
    const sandbox = this.sandbox(target.sandboxId, target.size);
    const executionSessionId = sessionName(
      `agent-run-${turn.turnId}-${target.size}`,
    );
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
    const workspace = resolveWorkspace(turn.workspace);
    if (
      marker.schemaVersion !== 1 ||
      marker.turnId !== turn.turnId ||
      marker.attemptGeneration !== turn.attemptGeneration ||
      !workspace ||
      marker.workspace !== workspace.canonical ||
      marker.workspaceRoot !== workspace.mountPath ||
      !asTurnStateWorkspaceRoot(marker.workspaceRoot) ||
      !Number.isSafeInteger(marker.startedAt) ||
      marker.startedAt < 0 ||
      !marker.sandboxId ||
      (marker.size !== "small" && marker.size !== "large")
    ) {
      throw new Error("Agent execution recovery marker was invalid.");
    }
    return marker;
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

  private async exactTurnStateCheckpointOperations(
    turn: TurnRequest,
  ): Promise<TurnStateCheckpointOperation[]> {
    const listed = await this.ctx.storage.list<TurnStateCheckpointOperation>({
      prefix: "turnStateCheckpointOperation:",
      limit: 128,
    });
    const exact = [...listed.values()].filter(
      (operation) =>
        operation.turnId === turn.turnId &&
        operation.attemptGeneration === turn.attemptGeneration,
    );
    if (exact.length > 8) {
      throw new Error(
        "Agent checkpoint recovery exceeded its operation bound.",
      );
    }
    return exact;
  }

  private async abortUnpublishedTurnStateOperation(
    turn: TurnRequest,
    workspace: string,
    operation: TurnStateCheckpointOperation,
    canonicalHistoryCursor: string,
  ): Promise<void> {
    if (!operation.payload) {
      // The broker claim was persisted before its body parsed, so no owner
      // prepare or R2 write could have occurred. Retire only the local claim.
      await this.ctx.storage.delete(
        turnStateCheckpointOperationKey(operation.requestId),
      );
      return;
    }
    let operationId = operation.operationId;
    if (operation.state === "failed" && !operationId) {
      // A pre-prepare validation denial has no owner registry/object state.
      await this.ctx.storage.delete(
        turnStateCheckpointOperationKey(operation.requestId),
      );
      return;
    }
    if (!operationId) {
      const prepared =
        await this.callOwnerTurnState<PreparedTurnStateOperation>(
          turn,
          "prepare",
          {
            workspace,
            threadId: turn.threadId,
            attemptGeneration: turn.attemptGeneration,
            requestFingerprint: operation.requestFingerprint,
            historyCursor: operation.payload.historyCursor,
            baseWorkspaceRevision: operation.baseWorkspaceRevision,
            createdAt: operation.createdAt,
            ...(operation.payload.nativeCheckpoint
              ? { nativeCheckpoint: operation.payload.nativeCheckpoint }
              : {}),
          },
        );
      if (
        !prepared ||
        !/^[0-9a-f]{64}$/u.test(prepared.operationId) ||
        prepared.baseWorkspaceRevision !== operation.baseWorkspaceRevision
      ) {
        throw new Error("Turn state abort preparation receipt was invalid.");
      }
      operationId = prepared.operationId;
      const operationKey = turnStateCheckpointOperationKey(operation.requestId);
      await this.ctx.storage.transaction(async (transaction) => {
        const current =
          await transaction.get<TurnStateCheckpointOperation>(operationKey);
        if (
          !current ||
          current.state !== "pending" ||
          current.turnId !== operation.turnId ||
          current.attemptGeneration !== operation.attemptGeneration ||
          current.requestFingerprint !== operation.requestFingerprint ||
          (current.operationId !== undefined &&
            current.operationId !== prepared.operationId)
        ) {
          throw new Error("Turn state abort operation changed.");
        }
        await transaction.put(operationKey, {
          ...current,
          operationId: prepared.operationId,
        } satisfies TurnStateCheckpointOperation);
      });
    }
    const aborted = await this.callOwnerTurnState<{
      operationId?: unknown;
      abortReceipt?: unknown;
      replayed?: unknown;
    }>(turn, "abort-unpublished", {
      workspace,
      threadId: turn.threadId,
      operationId,
      baseWorkspaceRevision: operation.baseWorkspaceRevision,
      candidateHistoryCursor: operation.payload.historyCursor,
      canonicalHistoryCursor,
    });
    if (
      aborted?.operationId !== operationId ||
      typeof aborted.replayed !== "boolean" ||
      typeof aborted.abortReceipt !== "string" ||
      !/^[0-9a-f]{64}$/u.test(aborted.abortReceipt)
    ) {
      throw new Error("Unpublished turn-state abort receipt was invalid.");
    }
  }

  private async recoverObservedBrowserSuspension(
    turn: TurnRequest,
    checkpoint: TurnBrokerTurnStateCheckpointReceipt,
    signal?: AbortSignal,
  ): Promise<CloudBrowserSuspension | null> {
    const observation =
      await this.ctx.storage.get<ObservedBrowserSuspension>(
        OBSERVED_BROWSER_SUSPENSION_KEY,
      );
    if (!observation) return null;
    const rows = await this.fetchCanonicalAgentHistory(turn, {
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
          txn.get<PendingBrowserSuspension>(
            PENDING_BROWSER_SUSPENSION_KEY,
          ),
          txn.get<ObservedBrowserSuspension>(
            OBSERVED_BROWSER_SUSPENSION_KEY,
          ),
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
    const observation =
      await this.ctx.storage.get<ObservedBrowserSuspension>(
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
      const bound =
        await bindObservedBrowserSuspensionToCanonicalCodeCall({
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
          JSON.stringify(existing.messages) !== JSON.stringify(fallback.messages)
        ) {
          throw new Error("Browser suspension recovery journal conflicted.");
        }
        return existing;
      }
      if (
        !currentObserved ||
        currentObserved.turnId !== observation.turnId ||
        currentObserved.attemptGeneration !==
          observation.attemptGeneration ||
        currentObserved.responseBodySha256 !==
          observation.responseBodySha256 ||
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

  private async recoverAgentTurnAfterExecutorLoss(
    turn: TurnRequest,
    marker: AgentExecutionMarker,
    error: string,
    input?: {
      historyCursor?: string;
      messages?: Array<{ ordinal: number; role: string; payloadJson: string }>;
      nativeCheckpoint?: TurnBrokerTurnStateCheckpointRequest["nativeCheckpoint"];
    },
  ): Promise<TurnBrokerTurnStateCheckpointReceipt> {
    await this.interruptAgentForBuilderFallback(turn);
    return await this.reconcileAgentCheckpointAfterQuiescence(
      turn,
      marker,
      error,
      input,
    );
  }

  private async reconcileAgentCheckpointAfterQuiescence(
    turn: TurnRequest,
    marker: AgentExecutionMarker,
    error: string,
    input?: {
      historyCursor?: string;
      messages?: Array<{ ordinal: number; role: string; payloadJson: string }>;
      nativeCheckpoint?: TurnBrokerTurnStateCheckpointRequest["nativeCheckpoint"];
    },
  ): Promise<TurnBrokerTurnStateCheckpointReceipt> {
    await this.assertTurnWritable(turn);
    await this.assertConvexAgentTurnAuthority(turn);

    const fallbackKey = builderFallbackTranscriptKey(
      turn.turnId,
      turn.attemptGeneration!,
    );
    const existingFallback =
      await this.ctx.storage.get<BuilderFallbackTranscript>(fallbackKey);
    if (existingFallback) {
      return await this.advanceBuilderFallback(
        turn,
        marker.workspace,
        marker.workspaceRoot,
        existingFallback,
      );
    }

    const canonicalRows = await this.fetchCanonicalAgentHistory(turn, {
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
          workspace: marker.workspace,
          workspaceRoot: marker.workspaceRoot,
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
        marker.workspace,
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
      return await this.advanceBuilderFallback(
        turn,
        marker.workspace,
        marker.workspaceRoot,
        browserRecovery,
      );
    }

    // A checkpoint whose transcript never became canonical must remain
    // invisible. Retire its pre-registered objects first so prepare can CAS a
    // fresh synthetic cursor over the same base revision without a permanent
    // pending-candidate wedge.
    for (const operation of operations) {
      await this.abortUnpublishedTurnStateOperation(
        turn,
        marker.workspace,
        operation,
        canonicalCursor,
      );
    }
    const fallback = await this.ensureBuilderFallbackTranscript(turn, {
      ...(input ?? {}),
      error,
    });
    return await this.advanceBuilderFallback(
      turn,
      marker.workspace,
      marker.workspaceRoot,
      fallback,
    );
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
    input?: {
      historyCursor?: string;
      messages?: Array<{ ordinal: number; role: string; payloadJson: string }>;
      nativeCheckpoint?: TurnBrokerTurnStateCheckpointRequest["nativeCheckpoint"];
      error?: string;
    },
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
    workspace: string,
    workspaceRoot: TurnStateWorkspaceRoot,
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
          workspace,
          workspaceRoot,
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
      const append = async (): Promise<Response> =>
        await fetch(
          `${turn.convexCallbackBase.replace(/\/+$/, "")}/api/cloud/messages`,
          {
            method: "POST",
            headers: {
              "x-stella-turn-token": turn.turnToken,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              conversationId: turn.threadId,
              turnId: turn.turnId,
              messages: fallback.messages,
            }),
          },
        );
      let response = await append();
      if (!response.ok) response = await append();
      if (!response.ok) {
        throw new Error(
          `Builder fallback transcript persist failed (${response.status}).`,
        );
      }
      const canonicalRows = await this.fetchCanonicalAgentHistory(turn, {
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
        workspace,
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
    if (freshLease || !turn.ownerPurgeLeaseId) {
      turn.ownerPurgeLeaseId = crypto.randomUUID();
    }
    const leasedWorkspace =
      !freshLease && turn.kind === "agent"
        ? resolveWorkspace(turn.workspace)?.canonical
        : undefined;
    const response = await this.callOwnerFence(turn.ownerId, "register", {
      leaseId: turn.ownerPurgeLeaseId,
      sessionId: this.ctx.id.toString(),
      turnId: turn.turnId,
      ownerGeneration: turn.ownerGeneration,
      role: freshLease ? "aux" : "run",
      ...(leasedWorkspace ? { workspace: leasedWorkspace } : {}),
      ...(turn.ownerPurgeGeneration
        ? { generation: turn.ownerPurgeGeneration }
        : {}),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        code?: unknown;
      } | null;
      const rawCode = typeof payload?.code === "string" ? payload.code : "";
      const code = [
        "owner_purge_permanent",
        "owner_purge_temporary",
        "workspace_busy",
        "transfer_busy",
        "bad_request",
      ].includes(rawCode)
        ? rawCode
        : "unknown";
      log("info", "agent_turn_owner_fence_registration_rejected", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        attemptGeneration: turn.attemptGeneration,
        status: response.status,
        code,
      });
      throw new OwnerPurgeFenceError();
    }
    const body = (await response.json()) as { generation?: string };
    if (!body.generation) throw new OwnerPurgeFenceError();
    return body.generation;
  }

  private async unregisterTurn(turn: TurnRequest): Promise<void> {
    if (!turn.ownerPurgeGeneration || !turn.ownerPurgeLeaseId) return;
    const hasTransientWrites =
      Boolean(
        await this.ctx.storage.get<string>(`transientBackup:${turn.turnId}`),
      ) ||
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
    generation: string,
  ): Promise<void> {
    await this.callOwnerFence(turn.ownerId, "unregister", {
      leaseId,
      sessionId: this.ctx.id.toString(),
      turnId: turn.turnId,
      ownerGeneration: turn.ownerGeneration,
      generation,
    }).catch(() => undefined);
  }

  private async appendWorkspaceBackupDebt(
    workspaceKey: string,
    backupId: string,
  ): Promise<void> {
    if (!BACKUP_ID_PATTERN.test(backupId)) {
      throw new Error("Invalid transient workspace backup id.");
    }
    const debtKey = backupDebtKey(workspaceKey);
    const existing = (await this.env.APP_ROUTES.get<WorkspaceBackupDebt>(
      debtKey,
      "json",
    )) ?? { backupIds: [] };
    const backupIds = [...new Set([...existing.backupIds, backupId])];
    if (backupIds.length > 100) {
      throw new Error("Workspace backup cleanup debt is too large.");
    }
    await this.env.APP_ROUTES.put(
      debtKey,
      JSON.stringify({ backupIds } satisfies WorkspaceBackupDebt),
    );
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

  /**
   * Move the only random identifier for an unswept attempt backup out of DO
   * storage before terminal deleteAll(). The workspace debt is durable and is
   * retried by the normal checkpoint/purge sweep paths.
   */
  private async settleWorkspaceTransientBackup(
    turn: TurnRequest,
  ): Promise<boolean> {
    const backupKey = `transientBackup:${turn.turnId}`;
    const workspaceKeyKey = `transientBackupWorkspace:${turn.turnId}`;
    const backupId = await this.ctx.storage.get<string>(backupKey);
    if (!backupId) {
      await this.ctx.storage.delete(workspaceKeyKey);
      return true;
    }
    const workspaceKey = await this.ctx.storage.get<string>(workspaceKeyKey);
    if (!workspaceKey) {
      log("error", "transient_backup_debt_workspace_missing", {
        turnId: turn.turnId,
        backupId,
      });
      return false;
    }
    try {
      await this.appendWorkspaceBackupDebt(workspaceKey, backupId);
      await this.ctx.storage.delete([backupKey, workspaceKeyKey]);
      return true;
    } catch (error) {
      log("error", "transient_backup_debt_persist_failed", {
        turnId: turn.turnId,
        backupId,
        message: errorMessage(error),
      });
      return false;
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
    if (!(await this.settleWorkspaceTransientBackup(turn))) return false;
    return await this.settleNativeTransientBackup(turn);
  }

  private async cleanupTransientWrites(turn: TurnRequest): Promise<void> {
    const backupKey = `transientBackup:${turn.turnId}`;
    const buildKey = `transientBuild:${turn.turnId}`;
    const backupId = await this.ctx.storage.get<string>(backupKey);
    const nativeMarker = await this.ctx.storage.get<NativeTransientBackup>(
      nativeTransientBackupKey(turn.turnId),
    );
    const buildPrefix = await this.ctx.storage.get<string>(buildKey);
    const routeKey = transientBuildRouteKey(turn.turnId);
    const transientRoute =
      await this.ctx.storage.get<TransientAppBuildRoute>(routeKey);
    if (backupId) {
      const swept = await sweepR2Prefix(
        this.env.BACKUP_BUCKET,
        `backups/${backupId}/`,
      );
      if (!swept.done)
        throw new Error("Transient backup cleanup was truncated.");
      await this.ctx.storage.delete([
        backupKey,
        `transientBackupWorkspace:${turn.turnId}`,
      ]);
    }
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
      if (transientRoute) {
        const route = await this.env.APP_ROUTES.get<Record<string, unknown>>(
          transientRoute.key,
          "json",
        );
        if (
          route?.ownerId === transientRoute.ownerId &&
          route.appId === transientRoute.appId &&
          route.buildId === transientRoute.buildId &&
          route.artifactPrefix === transientRoute.artifactPrefix
        ) {
          const previous = transientRoute.previousRoute;
          if (
            previous?.ownerId === transientRoute.ownerId &&
            previous.appId === transientRoute.appId
          ) {
            await this.env.APP_ROUTES.put(
              transientRoute.key,
              JSON.stringify(previous),
            );
          } else {
            await this.env.APP_ROUTES.delete(transientRoute.key);
          }
        }
      }
      const retired = await retireTransientAppBuild({
        sweep: async () =>
          await sweepR2Prefix(this.env.APP_BUILDS, `${buildPrefix}/`),
        clearRecovery: async () => {
          await this.ctx.storage.delete([buildKey, routeKey]);
        },
      });
      if (!retired) throw new Error("Transient build cleanup was truncated.");
    } else if (transientRoute) {
      await this.ctx.storage.delete(routeKey);
    }
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
      const retired = await this.callOwnerFence(ownerId, "unregister", {
        leaseId,
        sessionId: this.ctx.id.toString(),
        turnId,
        ownerGeneration,
        generation,
      });
      if (!retired.ok) {
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
      await this.callOwnerFence(ownerId, "unregister", {
        leaseId,
        sessionId: this.ctx.id.toString(),
        turnId,
        ownerGeneration,
        generation,
      });
      return json({ canceled: true, turnId, unregistered: true, orphan: true });
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
      await (await this.currentSandbox())?.destroy().catch(() => undefined);
    }

    const running = [...(this.runningTurns.get(turnId) ?? [])];
    if (running.length > 0) {
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const graceExpired = new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(
          () => resolve(false),
          OWNER_PURGE_STALE_LEASE_GRACE_MS,
        );
      });
      const settled = await Promise.race([
        Promise.allSettled(running).then(() => true),
        graceExpired,
      ]);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
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
    await this.ctx.storage.deleteAll();
    // Do not depend on a vanished run's `finally`: remove the exact durable
    // lease idempotently from the owner fence here.
    await this.callOwnerFence(ownerId, "unregister", {
      leaseId,
      sessionId: this.ctx.id.toString(),
      turnId,
      ownerGeneration,
      generation,
    });
    return json({ canceled: true, turnId, unregistered: true });
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

  private async assertConvexAgentTurnAuthority(
    turn: TurnRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      turn.kind !== "agent" ||
      !turn.threadId ||
      !Number.isSafeInteger(turn.attemptGeneration) ||
      turn.attemptGeneration! < 1
    ) {
      throw new AgentTurnAuthorityLostError();
    }
    let response: Response;
    try {
      response = await fetch(
        `${turn.convexCallbackBase.replace(/\/+$/, "")}/api/cloud/agent-turn-authority`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            tokenHash: await sha256Hex(turn.turnToken),
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            threadId: turn.threadId,
            turnId: turn.turnId,
            attemptGeneration: turn.attemptGeneration,
          }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        },
      );
    } catch {
      log("error", "agent_turn_authority_rejected", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        attemptGeneration: turn.attemptGeneration,
        reason: "request_failed",
      });
      throw new AgentTurnAuthorityLostError();
    }
    if (!response.ok) {
      log("info", "agent_turn_authority_rejected", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        attemptGeneration: turn.attemptGeneration,
        reason: "http_rejected",
        status: response.status,
      });
      throw new AgentTurnAuthorityLostError();
    }
    const payload = (await response.json().catch(() => null)) as {
      authoritative?: unknown;
    } | null;
    if (payload?.authoritative !== true) {
      log("info", "agent_turn_authority_rejected", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        attemptGeneration: turn.attemptGeneration,
        reason: "payload_rejected",
        status: response.status,
      });
      throw new AgentTurnAuthorityLostError();
    }
  }

  private async fetchCanonicalAgentHistory(
    turn: TurnRequest,
    options: { excludeCurrentTurn: boolean; signal?: AbortSignal },
  ): Promise<AgentHistoryRow[]> {
    if (!turn.threadId) return [];
    const contextUrl = new URL(
      `${turn.convexCallbackBase.replace(/\/+$/, "")}/api/cloud/context`,
    );
    contextUrl.searchParams.set("conversationId", turn.threadId);
    contextUrl.searchParams.set("ownerId", turn.ownerId);
    contextUrl.searchParams.set("ownerGeneration", turn.ownerGeneration);
    if (options.excludeCurrentTurn) {
      contextUrl.searchParams.set("excludeTurnId", turn.turnId);
    }
    const response = await fetch(contextUrl, {
      headers: {
        authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
      },
      signal: options.signal,
    });
    if (!response.ok) {
      throw new AgentTurnError(
        "Stella couldn't load this agent's conversation history. Try again.",
      );
    }
    const text = await response.text();
    if (
      new TextEncoder().encode(text).byteLength >
      AGENT_HISTORY_RESPONSE_MAX_BYTES
    ) {
      throw new AgentTurnError(
        "This agent's conversation history is too large to load safely.",
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new AgentTurnError(
        "Stella couldn't validate this agent's conversation history. Try again.",
      );
    }
    const messages =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { messages?: unknown }).messages
        : undefined;
    if (
      !Array.isArray(messages) ||
      messages.length > AGENT_HISTORY_MAX_ROWS ||
      !messages.every(
        (row) =>
          row !== null &&
          typeof row === "object" &&
          !Array.isArray(row) &&
          typeof (row as AgentHistoryRow).seq === "number" &&
          typeof (row as AgentHistoryRow).role === "string" &&
          typeof (row as AgentHistoryRow).payloadJson === "string" &&
          typeof (row as AgentHistoryRow).turnId === "string",
      )
    ) {
      throw new AgentTurnError(
        "Stella couldn't validate this agent's conversation history. Try again.",
      );
    }
    return messages as AgentHistoryRow[];
  }

  private async assertConvexAppTurnAuthority(turn: TurnRequest): Promise<void> {
    if (
      turn.kind === "agent" ||
      !turn.appId ||
      !turn.conversationId ||
      !turn.sessionId ||
      !turn.turnToken ||
      !turn.convexCallbackBase
    ) {
      throw new AppTurnAuthorityLostError();
    }
    let response: Response;
    try {
      response = await fetch(
        `${turn.convexCallbackBase.replace(/\/+$/, "")}/api/cloud/app-turn-authority`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            tokenHash: await sha256Hex(turn.turnToken),
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            conversationId: turn.conversationId,
            appId: turn.appId,
            turnId: turn.turnId,
            sessionId: turn.sessionId,
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw new AppTurnAuthorityLostError();
    }
    if (!response.ok) throw new AppTurnAuthorityLostError();
    const payload = (await response.json().catch(() => null)) as {
      authoritative?: unknown;
    } | null;
    if (payload?.authoritative !== true) {
      throw new AppTurnAuthorityLostError();
    }
  }

  private async assertAgentExecutionActive(
    turn: TurnRequest,
    execution: TurnExecutionContext,
  ): Promise<void> {
    execution.assertActive();
    await this.assertAgentTurnActive(turn);
    await this.assertConvexAgentTurnAuthority(turn, execution.signal);
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

  private async ownerFenceFetch(
    path: string,
    request: Request,
  ): Promise<Response> {
    const turnStateRoute = path.startsWith("turn-state/");
    const body = (turnStateRoute ? {} : await request.json()) as {
      ownerId?: string;
      generation?: string;
      expectedGeneration?: string;
      requestId?: string;
      leaseId?: string;
      ownerGeneration?: string;
      mode?: OwnerPurgeMode;
      sessionId?: string;
      turnId?: string;
      namespace?: "build" | "orchestrator" | "activity";
      role?: "run" | "aux" | "orchestrator" | "activity" | "transfer";
      workspace?: string;
      expiresAt?: number;
    };
    const current = (await this.ctx.storage.get<OwnerPurgeFence>(
      "ownerPurgeFence",
    )) ?? {
      generation: crypto.randomUUID(),
      state: "open",
      active: {},
    };
    const scopedOwnerId =
      (turnStateRoute
        ? request.headers.get(HEADER_OWNER_FENCE_ID)
        : body.ownerId
      )?.trim() ?? "";
    if (
      !scopedOwnerId ||
      scopedOwnerId.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(scopedOwnerId) ||
      (current.ownerId !== undefined && current.ownerId !== scopedOwnerId)
    ) {
      return json({ error: "Owner fence identity does not match." }, 409);
    }
    if (current.ownerId === undefined) {
      current.ownerId = scopedOwnerId;
      await this.ctx.storage.put("ownerPurgeFence", current);
    }
    let prunedExpiredLease = false;
    const now = Date.now();
    for (const [leaseId, lease] of Object.entries(current.active)) {
      if (lease.expiresAt !== undefined && lease.expiresAt <= now) {
        delete current.active[leaseId];
        prunedExpiredLease = true;
      }
    }
    if (prunedExpiredLease) {
      await this.ctx.storage.put("ownerPurgeFence", current);
    }
    if (turnStateRoute) {
      const response = await handleTurnStateOwnerRoute({
        path,
        request,
        scopedOwnerId,
        fence: {
          ownerId: scopedOwnerId,
          generation: current.generation,
          state: current.state,
          active: current.active,
        },
        storage: this.ctx.storage,
        bucket: this.env.BACKUP_BUCKET,
        nativeIntegritySecret: this.env.BUILDER_SERVICE_SECRET,
      });
      if (response) return response;
    }
    if (path === "register") {
      const ownerGeneration = normalizeOwnerGeneration(body.ownerGeneration);
      const activeLeases = Object.values(current.active);
      const workspaceBusy =
        body.role === "run" &&
        body.workspace &&
        activeLeases.some(
          (lease) =>
            lease.role === "run" &&
            lease.workspace === body.workspace &&
            lease.leaseId !== body.leaseId,
        );
      const isTransferControlActivity =
        body.role === "activity" &&
        (body.turnId?.startsWith("owner-product-transfer:") ||
          body.turnId?.startsWith("owner-transfer:"));
      const transferBusy =
        body.role === "transfer"
          ? activeLeases.some((lease) =>
              lease.role === "transfer"
                ? ownerTransferLeaseConflicts(lease, body)
                : !(
                    lease.role === "activity" &&
                    (lease.turnId.startsWith("owner-product-transfer:") ||
                      lease.turnId.startsWith("owner-transfer:"))
                  ),
            )
          : activeLeases.some((lease) => lease.role === "transfer") &&
            !isTransferControlActivity;
      const invalidTransferExpiry =
        body.role === "transfer" &&
        (typeof body.expiresAt !== "number" ||
          !Number.isFinite(body.expiresAt) ||
          body.expiresAt <= now ||
          body.expiresAt > now + OWNER_PRODUCT_TRANSFER_LEASE_MS);
      if (current.state !== "open") {
        return json(
          {
            code:
              current.mode === "permanent"
                ? "owner_purge_permanent"
                : "owner_purge_temporary",
            error: "Owner purge is active.",
          },
          409,
        );
      }
      if (workspaceBusy || transferBusy) {
        return json(
          {
            code: workspaceBusy ? "workspace_busy" : "transfer_busy",
            error: "Owner activity is busy.",
          },
          409,
        );
      }
      if (
        (body.generation !== undefined &&
          body.generation !== current.generation) ||
        !body.leaseId ||
        !body.sessionId ||
        !body.turnId ||
        !ownerGeneration ||
        invalidTransferExpiry
      ) {
        return json(
          { code: "bad_request", error: "Invalid owner lease." },
          400,
        );
      }
      current.active[body.leaseId] = {
        leaseId: body.leaseId,
        sessionId: body.sessionId,
        turnId: body.turnId,
        ownerGeneration,
        reservationGeneration: current.generation,
        namespace:
          body.namespace === "orchestrator"
            ? "orchestrator"
            : body.namespace === "activity"
              ? "activity"
              : "build",
        role:
          body.role === "run"
            ? "run"
            : body.role === "orchestrator"
              ? "orchestrator"
              : body.role === "transfer"
                ? "transfer"
                : body.role === "activity"
                  ? "activity"
                  : "aux",
        ...(body.workspace ? { workspace: body.workspace } : {}),
        ...(typeof body.expiresAt === "number" &&
        Number.isFinite(body.expiresAt) &&
        body.expiresAt > now
          ? { expiresAt: body.expiresAt }
          : {}),
      };
      await this.ctx.storage.put("ownerPurgeFence", current);
      return json({ generation: current.generation });
    }
    if (path === "unregister") {
      if (!body.leaseId || !body.sessionId || !body.turnId) {
        return json({ error: "Invalid owner lease." }, 400);
      }
      const active = current.active[body.leaseId];
      if (!active) return json({ ok: true, alreadyUnregistered: true });
      if (
        active.sessionId !== body.sessionId ||
        active.turnId !== body.turnId ||
        (active.ownerGeneration !== undefined &&
          !ownerGenerationMatches(active.ownerGeneration, body.ownerGeneration))
      ) {
        return json({ error: "Owner lease identity does not match." }, 409);
      }
      delete current.active[body.leaseId];
      await this.ctx.storage.put("ownerPurgeFence", current);
      return json({ ok: true });
    }
    if (path === "assert") {
      return current.state === "open" &&
        body.generation === current.generation &&
        Boolean(
          body.leaseId &&
            ownerGenerationMatches(
              current.active[body.leaseId]?.ownerGeneration,
              body.ownerGeneration,
            ),
        )
        ? json({ ok: true })
        : json({ error: "Owner purge fence changed." }, 409);
    }
    if (path === "assert-transfer") {
      const lease = body.leaseId ? current.active[body.leaseId] : undefined;
      const assertion = assertOwnerTransferReservation(lease, body, current);
      if (assertion.ok) {
        // A purge that began after this reservation must wait for transfer
        // acknowledgement (or its bounded expiry). Normal turn assertions
        // still fail as soon as the purge fence closes.
        return json({ ok: true, generation: current.generation });
      }
      return json(
        {
          code: assertion.code,
          error: "Ownership-transfer reservation is no longer active.",
        },
        409,
      );
    }
    if (path === "assert-blocked") {
      return current.state === "blocked" &&
        body.generation === current.generation
        ? json({
            ok: true,
            active: current.active,
            ...(current.beginRequestId
              ? { beginRequestId: current.beginRequestId }
              : {}),
          })
        : json({ error: "Owner purge generation is not active." }, 409);
    }
    if (path === "begin") {
      const requestedMode =
        body.mode === "permanent" ? "permanent" : "temporary";
      const disposition = ownerPurgeBeginDisposition({
        state: current.state,
        mode: current.mode,
        generation: current.generation,
        beginRequestId: current.beginRequestId,
        lastReleasedGeneration: current.lastReleasedGeneration,
        rejoinedFromGeneration: current.rejoinedFromGeneration,
        requestId: body.requestId,
        expectedGeneration: body.expectedGeneration,
        requestedMode,
      });
      if (disposition.action === "reject") {
        return json({ error: "Owner purge generation cannot be joined." }, 409);
      }
      if (disposition.action === "start") {
        current.generation = crypto.randomUUID();
        current.beginRequestId = normalizeOwnerGeneration(body.requestId)!;
        current.state = "blocked";
        current.mode = disposition.mode;
        if (disposition.rejoined) {
          current.rejoinedFromGeneration = normalizeOwnerGeneration(
            body.expectedGeneration,
          )!;
        } else {
          delete current.rejoinedFromGeneration;
        }
      } else if (disposition.upgradeToPermanent) {
        current.mode = "permanent";
      }
      await this.ctx.storage.put("ownerPurgeFence", current);
      return json({
        generation: current.generation,
        mode: current.mode,
        active: current.active,
        ...(disposition.rejoined ? { rejoined: true } : {}),
      });
    }
    if (path === "release") {
      const disposition = ownerPurgeReleaseDisposition({
        state: current.state,
        mode: current.mode,
        generation: current.generation,
        lastReleasedGeneration: current.lastReleasedGeneration,
        requestedGeneration: body.generation,
        activeLeaseCount: Object.keys(current.active).length,
      });
      if (disposition === "already-released") {
        return json({
          ok: true,
          generation: current.generation,
          alreadyReleased: true,
        });
      }
      if (disposition !== "release") {
        return json({ error: "Owner purge fence cannot be released." }, 409);
      }
      current.lastReleasedGeneration = current.generation;
      current.generation = crypto.randomUUID();
      current.state = "open";
      delete current.beginRequestId;
      delete current.mode;
      delete current.rejoinedFromGeneration;
      await this.ctx.storage.put("ownerPurgeFence", current);
      return json({ ok: true, generation: current.generation });
    }
    return json({ error: "Not found." }, 404);
  }

  private sandbox(id: string, size: InstanceSize = "large") {
    const namespace =
      size === "small" && this.env.SANDBOX_SMALL
        ? this.env.SANDBOX_SMALL
        : this.env.Sandbox;
    return getSandbox(namespace, id, {
      transport: "rpc",
      enableDefaultSession: false,
      keepAlive: true,
      normalizeId: true,
      containerTimeouts: {
        instanceGetTimeoutMS: 60_000,
        portReadyTimeoutMS: 120_000,
      },
      labels: { service: "stella-v2", workload: "app-build" },
    });
  }

  /**
   * The sandbox this DO is currently responsible for. Size matters as much as
   * id: the two container classes are separate namespaces, so destroying by
   * id alone against the wrong one silently leaves a live container behind.
   */
  private async currentSandbox() {
    const sandboxId = await this.ctx.storage.get<string>("sandboxId");
    if (!sandboxId) return undefined;
    const size =
      (await this.ctx.storage.get<InstanceSize>("sandboxSize")) ?? "large";
    return this.sandbox(sandboxId, size);
  }

  /**
   * Stop the command session first, then destroy its container. `destroy()` is
   * the authoritative boundary, while the explicit process kill makes a
   * native Claude Code/Codex child stop promptly instead of waiting for the
   * container teardown handshake.
   */
  private async terminateCurrentAgentSandbox(turn: TurnRequest): Promise<void> {
    const target = await this.ctx.storage.transaction(async (txn) => {
      const markerKey =
        turn.kind === "agent" &&
        Number.isSafeInteger(turn.attemptGeneration) &&
        turn.attemptGeneration! >= 1
          ? agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!)
          : undefined;
      const [current, sandboxId, storedSize, executionMarker] =
        await Promise.all([
          txn.get<TurnRequest>("turn"),
          txn.get<string>("sandboxId"),
          txn.get<InstanceSize>("sandboxSize"),
          markerKey
            ? txn.get<AgentExecutionMarker>(markerKey)
            : Promise.resolve(undefined),
        ]);
      if (!sandboxId || !exactTurnIdentityMatches(current, turn)) {
        return undefined;
      }
      const size = storedSize ?? ("large" as const);
      return {
        sandboxId,
        size,
        executorAdmitted:
          executionMarker?.schemaVersion === 1 &&
          executionMarker.turnId === turn.turnId &&
          executionMarker.attemptGeneration === turn.attemptGeneration &&
          executionMarker.sandboxId === sandboxId &&
          executionMarker.size === size,
      };
    });
    if (!target) return;
    const sandbox = this.sandbox(target.sandboxId, target.size);
    if (turn.kind === "agent" && target.executorAdmitted) {
      const size = target.size;
      const executionSessionId = sessionName(
        `agent-run-${turn.turnId}-${size}`,
      );
      await withInfrastructureDeadline(
        sandbox.killAllProcesses(executionSessionId),
        30_000,
        "Agent process teardown did not settle.",
      ).catch((error) => {
        log("error", "agent_process_kill_failed", {
          turnId: turn.turnId,
          sessionId: executionSessionId,
          message: errorMessage(error),
        });
      });
    }
    await withInfrastructureDeadline(
      sandbox.destroy(),
      30_000,
      "Agent sandbox destruction did not settle.",
    );
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
    workspaceRoot: string,
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
    if (workspaceRoot !== "/workspace/stella" || !turn.threadId) {
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
        STELLA_INTERIOR_SOURCE_ROOT: workspaceRoot,
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
        [
          "set -eu",
          "test ! -L /workspace/.stella-interior-build 2>/dev/null || exit 1",
          "if [ -e /workspace/.stella-interior-build ]; then test -d /workspace/.stella-interior-build && test \"$(stat -c '%u:%g:%a' /workspace/.stella-interior-build)\" = 0:0:700; else mkdir /workspace/.stella-interior-build && chmod 0700 /workspace/.stella-interior-build; fi",
          `rm -rf '${buildRoot}'`,
          `mkdir '${buildRoot}'`,
          `chown 42424:42424 '${buildRoot}'`,
          `chmod 0700 '${buildRoot}'`,
        ].join("; "),
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
          stderr: execution.stderr.slice(-4_000),
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
      let callbackSucceeded = false;
      let callbackError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          turnExecution.assertActive();
          await this.callback(
            turn,
            "/api/cloud/interior-builds",
            callbackBody,
            turnExecution.signal,
          );
          turnExecution.assertActive();
          callbackSucceeded = true;
          break;
        } catch (error) {
          callbackError = error;
          if (attempt < 2) {
            await turnExecution.cancellation.sleep(500 * 2 ** attempt);
          }
        }
      }
      if (!callbackSucceeded) {
        throw callbackError instanceof Error
          ? callbackError
          : new Error("Stella interior candidate callback failed.");
      }
      turnExecution.assertActive();
      await this.ctx.storage.delete(`transientBuild:${turn.turnId}`);
      turnExecution.assertActive();

      // This builder-owned state is checkpointed with the source but excluded
      // from the next source digest. It supplies the next candidate's explicit
      // baseRevision, including across sandbox destruction/restoration.
      await session.writeFile(
        `${workspaceRoot}/.stella/interior-source.json`,
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

  private async callback(
    turn: TurnRequest,
    path: string,
    body: unknown,
    executionSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    executionSignal?.throwIfAborted();
    await this.assertTurnWritable(turn);
    executionSignal?.throwIfAborted();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Convex callback body must be a JSON object.");
    }
    let response: Response;
    try {
      response = await fetch(
        `${turn.convexCallbackBase.replace(/\/+$/, "")}${path}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...(body as Record<string, unknown>),
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            // Service authentication identifies this worker; the token hash
            // identifies the immutable executor attempt it speaks for. Convex
            // resolves it transactionally so rotation revokes a resident DO.
            tokenHash: await sha256Hex(turn.turnToken),
          }),
          signal: executionSignal
            ? AbortSignal.any([executionSignal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new ConvexCallbackError(path);
    }
    if (!response.ok) {
      throw new ConvexCallbackError(path, response.status);
    }
    executionSignal?.throwIfAborted();
    await this.assertTurnWritable(turn);
    executionSignal?.throwIfAborted();
    return response
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);
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
    let state = pending;
    if (state.phase === "callback") {
      try {
        await this.callback(turn, "/api/cloud/builds", state.callbackBody);
      } catch (error) {
        const disposition =
          error instanceof ConvexCallbackError
            ? appBuildCallbackDisposition(error.status)
            : "retry";
        if (disposition === "retry") {
          return (await this.scheduleAppBuildPublicationRetry(turn, error))
            ? "retrying"
            : "superseded";
        }
        state = {
          ...state,
          phase: "cleanup",
          failureMessage: errorMessage(error),
        };
        if (
          !(await this.mutateExactTurn(turn, async (txn) => {
            await txn.put(pendingAppBuildPublicationKey(turn.turnId), state);
          }))
        ) {
          return "superseded";
        }
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
          { message: "Stella hit a problem while publishing. Try again." },
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
          transientBuildRouteKey(turn.turnId),
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

  private event(
    turn: TurnRequest,
    seq: number | "auto",
    kind: string,
    payload: unknown,
    terminal = false,
    executionSignal?: AbortSignal,
  ) {
    return this.callback(
      turn,
      "/api/cloud/events",
      {
        turnId: turn.turnId,
        ...(turn.kind === "agent"
          ? { attemptGeneration: turn.attemptGeneration }
          : {}),
        sessionId: turn.threadId ?? this.ctx.id.toString(),
        seq,
        kind,
        payload,
        terminal,
      },
      executionSignal,
    );
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
    pending: PendingTerminal,
    options: { preservePendingTerminal?: boolean } = {},
  ): Promise<boolean> {
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
    if (owns) {
      if (!(await this.claimTerminalDecision(turn, pending))) {
        const decided =
          await this.ctx.storage.get<PendingTerminal>("pendingTerminal");
        log("info", "terminal_decision_superseded", {
          turnId: turn.turnId,
          attemptedKind: pending.kind,
          decidedKind: decided?.kind,
        });
        return false;
      }
    }
    try {
      // Turn-scoped and unconditional: this is what gives the turn — orphaned
      // or not — its one terminal state, and Convex rejects a second one.
      await this.event(
        turn,
        "auto",
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
          await this.callback(turn, "/api/cloud/threads/complete", {
            threadId: turn.threadId,
            turnId: turn.turnId,
            attemptGeneration: turn.attemptGeneration,
            status: pending.kind,
            ...(pending.kind === "completed"
              ? { resultJson: JSON.stringify({ finalText }) }
              : { errorMessage: pending.threadError ?? "The agent stopped." }),
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
      return true;
    } catch (error) {
      log("error", "terminal_delivery_failed", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        kind: pending.kind,
        message: errorMessage(error),
      });
      if (!owns) return false;
      let attempts = 0;
      let retryDelayMs = 0;
      const retained = await this.ctx.storage.transaction(async (txn) => {
        if (
          !exactTurnIdentityMatches(await txn.get<TurnRequest>("turn"), turn)
        ) {
          return false;
        }
        attempts = ((await txn.get<number>("alarmAttempts")) ?? 0) + 1;
        retryDelayMs = Math.min(
          15 * 60_000,
          30_000 * 2 ** Math.min(attempts - 1, 5),
        );
        await txn.put("alarmAttempts", attempts);
        await txn.setAlarm(Date.now() + retryDelayMs);
        return true;
      });
      if (!retained) return false;
      if (attempts === 6 || attempts % 20 === 0) {
        log("error", "terminal_delivery_still_retrying", {
          turnId: turn.turnId,
          attempts,
          retryDelayMs,
          message: errorMessage(error),
        });
      }
      return false;
    }
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
        await this.setExactTurnAlarm(turn, watchdogDeadlineAt);
        log("info", "agent_watchdog_alarm_rearmed", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          watchdogDeadlineAt,
        });
        return;
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
        const sandbox = await this.currentSandbox();
        if (await this.ownsExactTurn(turn)) {
          await sandbox?.destroy().catch(() => undefined);
        }
        try {
          await this.cleanupTransientWrites(turn);
          if (!(await this.ownsExactTurn(turn))) return;
          retireOriginalLease = await this.ctx.blockConcurrencyWhile(
            async () => {
              if (!(await this.ownsExactTurn(turn))) return false;
              await this.ctx.storage.deleteAll();
              return true;
            },
          );
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
        const sandbox = await this.currentSandbox();
        if (await this.ownsExactTurn(turn)) {
          await sandbox?.destroy().catch(() => undefined);
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
      const sandbox = await this.currentSandbox();
      await sandbox?.destroy().catch(() => undefined);
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
            await this.terminateCurrentAgentSandbox(turn);
          } catch (error) {
            log("error", "pending_terminal_sandbox_termination_failed", {
              turnId: turn.turnId,
              message: errorMessage(error),
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
        let recoveredCheckpoint: TurnBrokerTurnStateCheckpointReceipt;
        try {
          recoveredCheckpoint = await this.recoverAgentTurnAfterExecutorLoss(
            turn,
            marker,
            "The agent stopped unexpectedly. Its workspace changes were saved, but its report could not be recovered.",
          );
        } catch (error) {
          log("error", "agent_builder_fallback_alarm_retry", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            message: errorMessage(error),
          });
          await this.setExactTurnAlarm(turn, Date.now() + 30_000);
          return;
        }
        let recoveredSuspension: CloudBrowserSuspension | null;
        try {
          recoveredSuspension =
            await this.recoverObservedBrowserSuspension(
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
            await this.terminateCurrentAgentSandbox(turn);
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
        const recoveredPending: PendingTerminal = {
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration!,
          kind: "failed",
          payload: {
            message:
              "The agent stopped unexpectedly. Its workspace changes were saved, but its report could not be recovered.",
            reason: "executor_recovered",
          },
          threadError:
            "The agent stopped unexpectedly after saving its workspace changes.",
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
          await this.terminateCurrentAgentSandbox(turn);
        } catch (error) {
          log("error", "recovered_agent_sandbox_termination_deferred", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            message: errorMessage(error),
          });
          return;
        }
        const delivered = await this.deliverTerminal(turn, {
          ...recoveredPending,
          terminateSandbox: false,
        });
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
      await this.terminateCurrentAgentSandbox(turn);
      timeoutPending = { ...timeoutPending, terminateSandbox: false };
      if (
        !(await this.mutateExactTurn(turn, async (txn) => {
          await txn.put("pendingTerminal", timeoutPending);
        }))
      ) {
        return;
      }
    } catch (error) {
      log("error", "timeout_sandbox_termination_failed", {
        turnId: turn.turnId,
        sandboxId,
        message: errorMessage(error),
      });
      await this.setExactTurnAlarm(turn, Date.now() + 30_000);
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
          await this.terminateCurrentAgentSandbox(turn);
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
        message: errorMessage(error),
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
          // execution marker and original workspace run lease do not survive
          // until the old watchdog. That otherwise rejects every fresh thread
          // for this workspace as `workspace_busy` after Stop already ACKed.
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

  private brokerFailure(status: number): Response {
    return Response.json(
      { error: "Turn broker authority is unavailable." },
      {
        status,
        headers: {
          "cache-control": "no-store",
          [TURN_BROKER_RESPONSE_HEADERS.denial]: "1",
        },
      },
    );
  }

  private brokerCheckpointPending(): Response {
    return Response.json(
      { error: "Turn state checkpoint is still resolving." },
      {
        status: 425,
        headers: {
          "cache-control": "no-store",
          [TURN_BROKER_RESPONSE_HEADERS.replayPending]: "1",
        },
      },
    );
  }

  private async executeTurnStateCheckpoint(args: {
    turn: TurnRequest;
    workspace: string;
    workspaceRoot: TurnStateWorkspaceRoot;
    operationKey: string;
    operation: Extract<TurnStateCheckpointOperation, { state: "pending" }> & {
      payload: TurnBrokerTurnStateCheckpointRequest;
    };
  }): Promise<TurnBrokerTurnStateCheckpointReceipt> {
    const { turn, workspace, workspaceRoot, operationKey, operation } = args;
    await this.assertTurnWritable(turn);
    await this.assertConvexAgentTurnAuthority(turn);

    const prepared = await this.callOwnerTurnState<PreparedTurnStateOperation>(
      turn,
      "prepare",
      {
        workspace,
        threadId: turn.threadId,
        attemptGeneration: turn.attemptGeneration,
        requestFingerprint: operation.requestFingerprint,
        historyCursor: operation.payload.historyCursor,
        baseWorkspaceRevision: operation.baseWorkspaceRevision,
        createdAt: operation.createdAt,
        ...(operation.payload.nativeCheckpoint
          ? { nativeCheckpoint: operation.payload.nativeCheckpoint }
          : {}),
      },
    );
    if (
      !prepared ||
      !/^[0-9a-f]{64}$/u.test(prepared.operationId) ||
      prepared.baseWorkspaceRevision !== operation.baseWorkspaceRevision ||
      typeof prepared.objectKeys?.workspace !== "string" ||
      (operation.payload.nativeCheckpoint
        ? typeof prepared.objectKeys.native !== "string"
        : prepared.objectKeys.native !== undefined)
    ) {
      throw new Error("Turn state preparation receipt was invalid.");
    }
    await this.ctx.storage.transaction(async (transaction) => {
      const current =
        await transaction.get<TurnStateCheckpointOperation>(operationKey);
      if (
        !current ||
        current.state !== "pending" ||
        current.turnId !== operation.turnId ||
        current.attemptGeneration !== operation.attemptGeneration ||
        current.requestId !== operation.requestId ||
        current.requestFingerprint !== operation.requestFingerprint ||
        current.createdAt !== operation.createdAt ||
        current.baseWorkspaceRevision !== operation.baseWorkspaceRevision ||
        (current.operationId !== undefined &&
          current.operationId !== prepared.operationId)
      ) {
        throw new Error("Turn state preparation operation changed.");
      }
      if (current.operationId === undefined) {
        await transaction.put(operationKey, {
          ...current,
          operationId: prepared.operationId,
        } satisfies TurnStateCheckpointOperation);
      }
    });

    await this.assertTurnWritable(turn);
    await this.assertConvexAgentTurnAuthority(turn);
    const sandbox = await this.currentSandbox();
    if (!sandbox) throw new AgentTurnAuthorityLostError();
    const archiveSessionId = sessionName(
      `turn-state-${turn.turnId}-${operation.requestId}`,
    );
    // An isolate may disappear after the archive command completed but before
    // its response was observed. Replace only this deterministic helper
    // session; global process cleanup would kill the awaiting agent executor.
    const session = await replaceTurnStateArchiveSession({
      sandbox,
      sessionId: archiveSessionId,
      commandTimeoutMs: Number(this.env.TURN_TIMEOUT_MS),
    });
    try {
      const workspaceUpload = await uploadTurnStateArchive({
        session,
        bucket: this.env.BACKUP_BUCKET,
        key: prepared.objectKeys.workspace,
        target: { kind: "workspace", workspaceRoot },
      });
      await this.assertTurnWritable(turn);
      await this.assertConvexAgentTurnAuthority(turn);
      await this.callOwnerTurnState(turn, "mark-uploaded", {
        operationId: prepared.operationId,
        archive: workspaceUpload.archive,
      });

      let nativeUpload:
        | Awaited<ReturnType<typeof uploadTurnStateArchive>>
        | undefined;
      if (prepared.objectKeys.native) {
        nativeUpload = await uploadTurnStateArchive({
          session,
          bucket: this.env.BACKUP_BUCKET,
          key: prepared.objectKeys.native,
          target: { kind: "native" },
        });
        await this.assertTurnWritable(turn);
        await this.assertConvexAgentTurnAuthority(turn);
        await this.callOwnerTurnState(turn, "mark-uploaded", {
          operationId: prepared.operationId,
          archive: nativeUpload.archive,
        });
      }

      await this.assertTurnWritable(turn);
      await this.assertConvexAgentTurnAuthority(turn);
      const committed = await this.callOwnerTurnState<{
        candidate: TurnStateCandidate;
        workspaceHead: TurnStateWorkspaceHead;
        replayed: boolean;
      }>(turn, "commit", { operationId: prepared.operationId });
      const candidate = committed?.candidate;
      const workspaceHead = committed?.workspaceHead;
      if (
        !candidate ||
        !workspaceHead ||
        candidate.schemaVersion !== 1 ||
        candidate.operationId !== prepared.operationId ||
        candidate.requestFingerprint !== operation.requestFingerprint ||
        candidate.historyCursor !== operation.payload.historyCursor ||
        candidate.createdAt !== operation.createdAt ||
        !/^[0-9a-f]{64}$/u.test(candidate.receipt) ||
        JSON.stringify(candidate.workspace) !==
          JSON.stringify(workspaceUpload.archive) ||
        JSON.stringify(candidate.native) !==
          JSON.stringify(nativeUpload?.archive) ||
        JSON.stringify(candidate.nativeCheckpoint) !==
          JSON.stringify(operation.payload.nativeCheckpoint) ||
        workspaceHead.operationId !== prepared.operationId ||
        workspaceHead.revision !== operation.baseWorkspaceRevision + 1 ||
        JSON.stringify(workspaceHead.archive) !==
          JSON.stringify(workspaceUpload.archive) ||
        !/^[0-9a-f]{64}$/u.test(workspaceHead.receipt)
      ) {
        throw new Error("Turn state commit receipt was invalid.");
      }

      const receipt = publicTurnStateCheckpointReceipt(candidate, false);
      await this.ctx.storage.transaction(async (transaction) => {
        const current =
          await transaction.get<TurnStateCheckpointOperation>(operationKey);
        if (
          !current ||
          current.state !== "pending" ||
          current.turnId !== operation.turnId ||
          current.attemptGeneration !== operation.attemptGeneration ||
          current.requestId !== operation.requestId ||
          current.requestFingerprint !== operation.requestFingerprint ||
          current.createdAt !== operation.createdAt ||
          current.baseWorkspaceRevision !== operation.baseWorkspaceRevision ||
          current.operationId !== prepared.operationId ||
          JSON.stringify(current.payload) !== JSON.stringify(operation.payload)
        ) {
          throw new Error("Turn state checkpoint operation changed.");
        }
        await transaction.put(operationKey, {
          ...operation,
          state: "succeeded",
          operationId: prepared.operationId,
          receipt,
        } satisfies TurnStateCheckpointOperation);
      });
      return receipt;
    } finally {
      await sandbox.deleteSession(session.id).catch(() => undefined);
    }
  }

  private async observeBrowserGatewaySuspension(
    turn: TurnRequest,
    input: {
      brokerRequestId: string;
      requestBodySha256: string;
      responseBodySha256: string;
      suspension: CloudBrowserSuspension;
    },
  ): Promise<"stored" | "replay" | "conflict" | "inactive"> {
    const observation: ObservedBrowserSuspension = {
      schemaVersion: 1,
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      ...input,
      observedAt: Date.now(),
    };
    return await this.ctx.storage.transaction(async (txn) => {
      const [current, terminal, pendingTerminal, pendingSuspension, existing] =
        await Promise.all([
          txn.get<TurnRequest>("turn"),
          txn.get<boolean>("terminal"),
          txn.get<PendingTerminal>("pendingTerminal"),
          txn.get<PendingBrowserSuspension>(
            PENDING_BROWSER_SUSPENSION_KEY,
          ),
          txn.get<ObservedBrowserSuspension>(
            OBSERVED_BROWSER_SUSPENSION_KEY,
          ),
        ]);
      if (
        !exactTurnIdentityMatches(current, turn) ||
        terminal ||
        pendingTerminal ||
        pendingSuspension
      ) {
        return "inactive" as const;
      }
      if (existing) {
        const identical =
          existing.schemaVersion === 1 &&
          existing.turnId === observation.turnId &&
          existing.attemptGeneration === observation.attemptGeneration &&
          existing.brokerRequestId === observation.brokerRequestId &&
          existing.requestBodySha256 === observation.requestBodySha256 &&
          existing.responseBodySha256 === observation.responseBodySha256 &&
          isCloudBrowserSuspension(existing.suspension) &&
          cloudBrowserSuspensionMarker(existing.suspension) ===
            cloudBrowserSuspensionMarker(observation.suspension);
        return identical ? ("replay" as const) : ("conflict" as const);
      }
      await txn.put(OBSERVED_BROWSER_SUSPENSION_KEY, observation);
      return "stored" as const;
    });
  }

  private async handleTurnBroker(request: Request): Promise<Response> {
    const turn = await this.ctx.storage.get<TurnRequest>("turn");
    if (
      !turn ||
      turn.kind !== "agent" ||
      !turn.threadId ||
      !turn.turnBrokerRoute ||
      !Number.isSafeInteger(turn.attemptGeneration)
    ) {
      return this.brokerFailure(401);
    }
    const recordKey = turnBrokerStorageKey({
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
    });
    const initialRecord =
      await this.ctx.storage.get<TurnBrokerRecord>(recordKey);
    if (!initialRecord) return this.brokerFailure(401);

    const preflight = await preflightTurnBrokerRequest({
      record: initialRecord,
      headers: request.headers,
      now: Date.now(),
    });
    if (!preflight.ok) return turnBrokerDenialResponse(preflight);
    if (request.method !== preflight.target.method) {
      return this.brokerFailure(403);
    }
    const brokerEngine = turn.execution?.engine;
    if (
      (brokerEngine !== "stella" &&
        brokerEngine !== "anthropic" &&
        brokerEngine !== "openai-codex") ||
      !turnBrokerTargetMatchesEngine(preflight.target, brokerEngine)
    ) {
      return this.brokerFailure(403);
    }

    let body: Uint8Array;
    try {
      body = await readTurnBrokerRequestBody(
        request,
        preflight.target.maxBodyBytes,
      );
    } catch (error) {
      if (error instanceof TurnBrokerBodyTooLargeError) {
        return this.brokerFailure(413);
      }
      return this.brokerFailure(400);
    }
    const requestFingerprint = await sha256BytesHex(body);

    try {
      await this.assertTurnWritable(turn);
      await this.assertConvexAgentTurnAuthority(turn);
    } catch {
      return this.brokerFailure(410);
    }

    const workspace = resolveWorkspace(turn.workspace);
    if (!workspace || workspace.kind === "computer") {
      return this.brokerFailure(403);
    }
    const workspaceRoot = asTurnStateWorkspaceRoot(workspace.mountPath);
    if (!workspaceRoot) return this.brokerFailure(403);
    const operationKey = turnStateCheckpointOperationKey(preflight.requestId);
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          body,
        ),
      ) as unknown;
    } catch {
      decoded = undefined;
    }
    const payload = parseTurnStateCheckpointRequest(decoded);

    const admission = await this.ctx.blockConcurrencyWhile(async () => {
      const [
        current,
        storedRecord,
        terminal,
        cancellation,
        sandboxId,
        baseWorkspaceRevision,
      ] = await Promise.all([
        this.ctx.storage.get<TurnRequest>("turn"),
        this.ctx.storage.get<TurnBrokerRecord>(recordKey),
        this.ctx.storage.get<boolean>("terminal"),
        this.exactTurnCancellations.matching({
          turnId: turn.turnId,
          ownerId: turn.ownerId,
          ownerGeneration: turn.ownerGeneration,
          attemptGeneration: turn.attemptGeneration,
        }),
        this.ctx.storage.get<string>("sandboxId"),
        this.ctx.storage.get<number>(
          turnStateBaseWorkspaceRevisionKey(
            turn.turnId,
            turn.attemptGeneration!,
          ),
        ),
      ]);
      if (!storedRecord) return { kind: "missing" as const };
      if (
        !Number.isSafeInteger(baseWorkspaceRevision) ||
        baseWorkspaceRevision! < 0
      ) {
        return { kind: "missing-base" as const };
      }
      const running = this.agentTurnExecutions.get(turn.turnId);
      const live: TurnBrokerLiveFence = {
        sessionId: turn.turnBrokerRoute!.sessionId,
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration!,
        active:
          exactTurnIdentityMatches(current, turn) &&
          Boolean(sandboxId) &&
          running?.cancellation.aborted === false,
        canceled: Boolean(cancellation),
        terminal: terminal === true,
      };
      const claimed = await claimTurnBrokerRequest({
        record: storedRecord,
        live,
        headers: request.headers,
        now: Date.now(),
        bodyBytes: body.byteLength,
        bodySha256: requestFingerprint,
      });
      if (!claimed.ok) return { kind: "denied" as const, claimed };
      if (claimed.disposition === "replay") {
        if (claimed.target.kind === "browser-gateway") {
          return {
            kind: "forward" as const,
            target: claimed.target,
            signal: running!.signal,
          };
        }
        return {
          kind: "replay" as const,
          operation:
            await this.ctx.storage.get<TurnStateCheckpointOperation>(
              operationKey,
            ),
        };
      }
      if (claimed.target.kind !== "builder-callback") {
        await this.ctx.storage.put(recordKey, claimed.record);
        return {
          kind: "forward" as const,
          target: claimed.target,
          signal: running!.signal,
        };
      }
      const operation: Extract<
        TurnStateCheckpointOperation,
        { state: "pending" }
      > = {
        state: "pending",
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration!,
        requestId: preflight.requestId,
        requestFingerprint,
        createdAt: Date.now(),
        baseWorkspaceRevision: baseWorkspaceRevision!,
        ...(payload ? { payload } : {}),
      };
      await this.ctx.storage.put({
        [recordKey]: claimed.record,
        [operationKey]: operation,
      });
      return { kind: "checkpoint" as const, operation };
    });

    if (admission.kind === "missing") return this.brokerFailure(401);
    if (admission.kind === "missing-base") return this.brokerFailure(409);
    if (admission.kind === "denied") {
      return turnBrokerDenialResponse(admission.claimed);
    }
    if (admission.kind === "forward") {
      if (admission.target.kind === "browser-gateway") {
        if (!this.env.BROWSER_GATEWAY) return this.brokerFailure(503);
        const command = decoded;
        if (
          !command ||
          typeof command !== "object" ||
          Array.isArray(command)
        ) {
          return this.brokerFailure(400);
        }
        try {
          const upstream = await this.env.BROWSER_GATEWAY.fetch(
            "https://browser-gateway/internal/turn/command",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "cache-control": "no-store",
              },
              body: JSON.stringify({
                schemaVersion: 1,
                authority: {
                  ownerId: turn.ownerId,
                  ownerGeneration: turn.ownerGeneration,
                  conversationId: turn.conversationId,
                  threadId: turn.threadId,
                  turnId: turn.turnId,
                  attemptGeneration: turn.attemptGeneration,
                },
                command,
              }),
              signal: admission.signal,
              redirect: "manual",
            },
          );
          if (upstream.status >= 300 && upstream.status < 400) {
            await upstream.body?.cancel().catch(() => undefined);
            return this.brokerFailure(502);
          }
          const upstreamBody = await readBrowserGatewayResponseBody(upstream);
          let responsePayload: unknown;
          try {
            responsePayload = JSON.parse(
              new TextDecoder("utf-8", {
                fatal: true,
                ignoreBOM: false,
              }).decode(upstreamBody),
            ) as unknown;
          } catch {
            responsePayload = undefined;
          }
          if (
            responsePayload &&
            typeof responsePayload === "object" &&
            !Array.isArray(responsePayload) &&
            (responsePayload as Record<string, unknown>).outcome ===
              "suspended"
          ) {
            const responseRecord = responsePayload as Record<
              string,
              unknown
            >;
            const commandRecord = command as Record<string, unknown>;
            const suspension = responseRecord.suspension;
            const commandRequestId = commandRecord.requestId;
            if (
              !upstream.ok ||
              Object.keys(responseRecord).sort().join(",") !==
                "outcome,schemaVersion,suspension" ||
              responseRecord.schemaVersion !== 1 ||
              Object.keys(commandRecord).sort().join(",") !==
                "action,params,requestId,schemaVersion" ||
              commandRecord.schemaVersion !== 1 ||
              !canonicalToolCallId(commandRequestId) ||
              !isCloudBrowserSuspension(suspension) ||
              suspension.toolCallId !== commandRequestId
            ) {
              return this.brokerFailure(502);
            }
            const disposition = await this.observeBrowserGatewaySuspension(
              turn,
              {
                brokerRequestId: preflight.requestId,
                requestBodySha256: requestFingerprint,
                responseBodySha256: await sha256BytesHex(upstreamBody),
                suspension,
              },
            );
            if (disposition === "conflict") {
              log("error", "browser_suspension_observation_conflict", {
                turnId: turn.turnId,
                threadId: turn.threadId,
              });
              return this.brokerFailure(409);
            }
            if (disposition === "inactive") {
              return this.brokerFailure(410);
            }
          }
          const responseHeaders = turnBrokerSandboxResponseHeaders(
            upstream.headers,
          );
          // Fetch has decoded the buffered bytes. Do not make the sandbox
          // decode them a second time or trust an upstream framing length.
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
          responseHeaders.delete("transfer-encoding");
          responseHeaders.set("cache-control", "no-store");
          return new Response(upstreamBody, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders,
          });
        } catch {
          log("error", "turn_broker_browser_gateway_failed", {
            turnId: turn.turnId,
            aborted: admission.signal.aborted,
            errorCode: "BROWSER_GATEWAY_UPSTREAM_FAILURE",
          });
          return this.brokerFailure(admission.signal.aborted ? 410 : 502);
        }
      }
      const expectedConvexOrigin = this.env.STELLA_CONVEX_SITE_URL?.trim();
      if (!expectedConvexOrigin) return this.brokerFailure(503);
      try {
        const upstream = await forwardTurnBrokerRequest({
          target: admission.target,
          body,
          incomingHeaders: request.headers,
          convexCallbackBase: turn.convexCallbackBase,
          expectedConvexOrigin,
          rawTurnToken: turn.turnToken,
          engine: brokerEngine,
          signal: admission.signal,
        });
        if (
          admission.target.kind === "model-resolution" &&
          devAcceptanceProbesEnabled(this.env)
        ) {
          // Status-only preview evidence. The response body may contain
          // account/provider detail and the request carries a raw turn
          // capability, so neither is ever copied into this diagnostic.
          log("info", "turn_broker_model_resolution_response", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            status: upstream.status,
          });
        }
        return upstream;
      } catch {
        log("error", "turn_broker_forward_failed", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          targetKind: admission.target.kind,
          aborted: admission.signal.aborted,
          errorCode: "TURN_BROKER_UPSTREAM_FAILURE",
        });
        return this.brokerFailure(admission.signal.aborted ? 410 : 502);
      }
    }
    let pendingOperation: Extract<
      TurnStateCheckpointOperation,
      { state: "pending" }
    >;
    if (admission.kind === "replay") {
      const operation = admission.operation;
      if (operation?.state === "succeeded") {
        return Response.json(
          { ...operation.receipt, replayed: true },
          { headers: { "cache-control": "no-store" } },
        );
      }
      if (operation?.state === "failed") {
        return this.brokerFailure(operation.status);
      }
      if (!operation || operation.state !== "pending") {
        return this.brokerFailure(409);
      }
      pendingOperation = operation;
    } else {
      pendingOperation = admission.operation;
    }
    const failOperation = async (status: number): Promise<Response> => {
      await this.ctx.storage.transaction(async (transaction) => {
        const current =
          await transaction.get<TurnStateCheckpointOperation>(operationKey);
        if (
          current?.state === "pending" &&
          current.turnId === pendingOperation.turnId &&
          current.attemptGeneration === pendingOperation.attemptGeneration &&
          current.requestId === pendingOperation.requestId &&
          current.requestFingerprint === pendingOperation.requestFingerprint &&
          current.createdAt === pendingOperation.createdAt &&
          current.baseWorkspaceRevision ===
            pendingOperation.baseWorkspaceRevision
        ) {
          await transaction.put(operationKey, {
            ...current,
            state: "failed",
            status,
          } satisfies TurnStateCheckpointOperation);
        }
      });
      return this.brokerFailure(status);
    };

    if (!payload) return await failOperation(400);
    if (
      (turn.execution?.engine === "anthropic") !==
      Boolean(payload.nativeCheckpoint)
    ) {
      return await failOperation(403);
    }
    if (payload.nativeCheckpoint) {
      const integrityKey = await nativeStateIntegrityKeyFor(this.env, turn);
      if (
        !(await validNativeStateCheckpointMac({
          checkpoint: payload.nativeCheckpoint,
          threadId: turn.threadId,
          integrityKey,
        }))
      ) {
        return await failOperation(403);
      }
    }

    const exactOperation = {
      ...pendingOperation,
      payload,
    } satisfies Extract<TurnStateCheckpointOperation, { state: "pending" }> & {
      payload: TurnBrokerTurnStateCheckpointRequest;
    };
    if (!pendingOperation.payload) {
      await this.ctx.storage.put(operationKey, exactOperation);
    } else if (
      JSON.stringify(pendingOperation.payload) !== JSON.stringify(payload)
    ) {
      return await failOperation(409);
    }

    let run = this.turnStateCheckpointRuns.get(operationKey);
    if (!run) {
      run = this.executeTurnStateCheckpoint({
        turn,
        workspace: workspace.canonical,
        workspaceRoot,
        operationKey,
        operation: exactOperation,
      });
      this.turnStateCheckpointRuns.set(operationKey, run);
      void run
        .finally(() => {
          if (this.turnStateCheckpointRuns.get(operationKey) === run) {
            this.turnStateCheckpointRuns.delete(operationKey);
          }
        })
        .catch(() => undefined);
    }
    try {
      const receipt = await run;
      return Response.json(
        admission.kind === "replay" ? { ...receipt, replayed: true } : receipt,
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      const status =
        error instanceof TurnStateOwnerCallError && error.status < 500
          ? error.status
          : error instanceof AgentTurnAuthorityLostError ||
              error instanceof OwnerPurgeFenceError
            ? 410
            : undefined;
      if (status) return await failOperation(status);
      log("error", "turn_state_checkpoint_deferred", {
        turnId: turn.turnId,
        requestId: preflight.requestId,
        message: errorMessage(error),
      });
      return this.brokerCheckpointPending();
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/turn-broker") {
      return await this.handleTurnBroker(request);
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405);
    }
    if (url.pathname.startsWith("/owner-fence/")) {
      return this.ownerFenceFetch(
        url.pathname.slice("/owner-fence/".length),
        request,
      );
    }
    if (url.pathname === "/owner-purge-cancel") {
      return this.cancelForOwnerPurge(request);
    }
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
    const turn = (await request.json()) as TurnRequest;
    // These fields come only from the authenticated outer gateway. Delete any
    // body-shaped values first so a service caller cannot choose where the
    // sandbox sends its capability or which BuildSession identity it claims.
    if (turn && typeof turn === "object") delete turn.turnBrokerRoute;
    const brokerSessionId =
      request.headers.get(HEADER_BUILD_SESSION_NAME)?.trim() ?? "";
    const brokerEndpoint =
      request.headers.get(HEADER_TURN_BROKER_ENDPOINT)?.trim() ?? "";
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
    if (
      turn.kind === "agent" &&
      (typeof turn.threadId !== "string" ||
        !turn.threadId.trim() ||
        typeof turn.turnToken !== "string" ||
        !turn.turnToken.trim() ||
        typeof turn.convexCallbackBase !== "string" ||
        !turn.convexCallbackBase.trim() ||
        !Number.isSafeInteger(turn.attemptGeneration) ||
        turn.attemptGeneration! < 1)
    ) {
      return json(
        {
          error:
            "Agent turns require threadId, turnToken, callback base, and attemptGeneration.",
        },
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
        !turn.sessionId.trim() ||
        typeof turn.turnToken !== "string" ||
        !turn.turnToken.trim() ||
        typeof turn.convexCallbackBase !== "string" ||
        !turn.convexCallbackBase.trim())
    ) {
      return json(
        {
          error:
            "App turns require appId, conversationId, sessionId, turnToken, and callback base.",
        },
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
          await this.assertConvexAgentTurnAuthority(turn);
          if (this.agentTurnExecutions.has(turn.turnId)) {
            return json(
              { accepted: true, replayed: true, inProgress: true },
              202,
            );
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
            return json(
              { accepted: false, replayed: true, reason: "superseded" },
              409,
            );
          }
          await this.setExactTurnAlarm(storedTurn, Date.now());
          // 425 deliberately keeps Convex's pre-published exact retry alive
          // until the alarm has terminated the orphan and delivered terminal.
          return json(
            { accepted: false, replayed: true, recoveryPending: true },
            425,
          );
        }
        await this.assertConvexAppTurnAuthority(storedTurn);
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
    try {
      delete turn.ownerPurgeGeneration;
      delete turn.ownerPurgeLeaseId;
      turn.ownerPurgeGeneration = await this.registerTurn(turn);
      await this.assertTurnWritable(turn);
      if (turn.kind === "agent") {
        await this.assertConvexAgentTurnAuthority(turn);
        return this.acceptAgentTurn(turn);
      }
      await this.assertConvexAppTurnAuthority(turn);
      return await this.startAppTurn(turn);
    } catch (error) {
      await this.unregisterTurn(turn);
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
          sandboxId: string;
          orphan?: PendingTerminal;
          orphanTurn?: TurnRequest;
        };
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
                ? json(
                    {
                      accepted: true,
                      replayed: true,
                      recovering: !locallyRunning,
                    },
                    202,
                  )
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
        const sandboxId = sessionName(`agent-${turn.turnId}`);
        // A predecessor whose terminal state never reached Convex left it
        // here. Taking over the DO takes the alarm with it, so this is its last
        // chance; the stale delivery below cannot mutate this successor.
        const orphan =
          await this.ctx.storage.get<PendingTerminal>("pendingTerminal");
        const orphanTurn = orphan
          ? await this.ctx.storage.get<TurnRequest>("turn")
          : undefined;
        await this.ctx.storage.put({
          sandboxId,
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
        return { kind: "start", sandboxId, orphan, orphanTurn };
      },
    );
    if ("response" in admission) {
      await this.unregisterTurn(turn);
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
      return json(
        {
          accepted: true,
          canceled: true,
          preAdmission: true,
          durable: true,
        },
        202,
      );
    }
    const { sandboxId, orphan, orphanTurn } = admission;
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
      await txn.setAlarm(watchdogDeadlineAt);
    });
    this.ctx.waitUntil(
      this.startAgentTurn(turn, sandboxId).catch(() => undefined),
    );
    return json({ accepted: true }, 202);
  }

  private async runEcho(): Promise<Response> {
    const sandboxId = `m0-${this.ctx.id.toString().slice(0, 24)}`;
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
          { error: "Executor echo failed", detail: execution.stderr },
          502,
        );
      }
      return json({
        ok: true,
        executor: JSON.parse(
          execution.stdout.trim().split("\n").at(-1) ?? "{}",
        ),
      });
    } catch (error) {
      return json(
        { error: "Sandbox echo failed", detail: errorMessage(error) },
        502,
      );
    } finally {
      await sandbox.destroy().catch(() => undefined);
      await this.ctx.storage.deleteAll();
    }
  }

  // A spawned general agent's turn: restore its workspace, run the real
  // runtime headless in the sandbox, checkpoint, report. The executor
  // streams its own progress events with the turn token; this method owns
  // workspace persistence and the terminal event. Runs detached from the
  // dispatch request (see acceptAgentTurn).
  private async runAgentTurn(
    turn: TurnRequest,
    sandboxId: string,
    execution: TurnExecutionContext,
  ): Promise<void> {
    const commandTimeoutMs = Number(this.env.TURN_TIMEOUT_MS);
    const workspace = resolveWorkspace(turn.workspace);
    const requestStarted = performance.now();
    let sandbox = this.sandbox(sandboxId);
    log("info", "agent_turn_started", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      workspace: workspace?.canonical ?? turn.workspace,
      sessionId: this.ctx.id.toString(),
    });
    try {
      await this.assertAgentExecutionActive(turn, execution);
      if (!workspace || !workspace.mountPath) {
        throw new AgentTurnError(
          workspace?.kind === "computer"
            ? "The user's computer isn't reachable from the cloud. This has to run on their own machine."
            : `Stella doesn't recognize the workspace "${turn.workspace ?? ""}", so there was nothing to work in.`,
        );
      }
      const workspaceRoot = asTurnStateWorkspaceRoot(workspace.mountPath);
      if (!workspaceRoot) {
        throw new AgentTurnError(
          "Stella couldn't validate this cloud workspace mount. Try again.",
        );
      }
      const workspaceKey = await checkpointKey(
        turn.ownerId,
        workspace.canonical,
      );
      execution.assertActive();
      await this.event(
        turn,
        "auto",
        "started",
        {
          threadId: turn.threadId,
          workspace: workspace.canonical,
        },
        false,
        execution.signal,
      );
      execution.assertActive();

      // Thread transcript for send_input continuations: the DO fetches it
      // (service secret) and hands it to the executor, which holds only the
      // turn token. Fetched once, before any sandbox exists, so an escalation
      // retry does not pay for it twice.
      const history = await this.fetchCanonicalAgentHistory(turn, {
        excludeCurrentTurn: true,
        signal: execution.signal,
      });
      execution.assertActive();

      const canonicalHistoryCursor = await nativeHistoryCursorFromRows(history);
      let resolvedTurnState = await this.resolveAgentTurnState(
        turn,
        workspace.canonical,
        canonicalHistoryCursor,
      );
      execution.assertActive();
      if (resolvedTurnState.workspacePublication) {
        if (!resolvedTurnState.workspacePublication.publishable) {
          throw new AgentTurnError(
            "This workspace is still recovering a previous agent turn. Try again shortly.",
          );
        }
        await this.assertConvexAgentTurnAuthority(turn);
        await this.publishAgentTurnWorkspace(
          turn,
          workspace.canonical,
          canonicalHistoryCursor,
          resolvedTurnState.workspacePublication.operationId,
        );
        execution.assertActive();
        resolvedTurnState = await this.resolveAgentTurnState(
          turn,
          workspace.canonical,
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
      if (resolvedTurnState.threadRegistryPresent && !turnStateThreadRestore) {
        throw new AgentTurnError(
          "This agent's saved session no longer matches its cloud conversation. Start a new agent thread to continue safely.",
        );
      }
      await this.ctx.storage.put(
        turnStateBaseWorkspaceRevisionKey(turn.turnId, turn.attemptGeneration!),
        resolvedTurnState.baseWorkspaceRevision,
      );
      execution.assertActive();

      // Migration-only compatibility seed. New checkpoints never write this
      // KV/SDK format; registry state always wins. Once the deterministic
      // strong workspace seed is committed, this fallback is retired.
      let legacyWorkspaceDescriptor: DirectoryBackup | null = null;
      let legacyNativeDescriptor: DirectoryBackup | null = null;
      let legacyNativeKey: string | undefined;
      if (!turnStateWorkspaceRestore) {
        const rawLegacyWorkspace = await this.env.APP_ROUTES.get<unknown>(
          workspaceKey,
          "json",
        );
        if (rawLegacyWorkspace) {
          legacyWorkspaceDescriptor = parseLegacyWorkspaceBackup(
            rawLegacyWorkspace,
            workspaceRoot,
          );
          if (!legacyWorkspaceDescriptor) {
            throw new AgentTurnError(
              "Stella couldn't validate this workspace's legacy checkpoint. Try again.",
            );
          }
        }
      }
      if (
        !turnStateThreadRestore &&
        !resolvedTurnState.threadRegistryPresent &&
        turn.execution?.engine === "anthropic" &&
        turn.threadId
      ) {
        legacyNativeKey = await nativeStateCheckpointKey(
          workspaceKey,
          turn.threadId,
        );
        const rawNativeRecord = await this.env.APP_ROUTES.get<unknown>(
          legacyNativeKey,
          "json",
        );
        if (rawNativeRecord) {
          const record = parseNativeStateCheckpointRecord(rawNativeRecord);
          if (!record) {
            throw new AgentTurnError(
              "Stella couldn't validate this agent's saved native session. Try again.",
            );
          }
          const legacy = resolveNativeStateCheckpoint(
            record,
            canonicalHistoryCursor,
          );
          legacyNativeDescriptor = legacy.restore?.descriptor ?? null;
          if (
            canonicalHistoryCursor !== EMPTY_NATIVE_HISTORY_CURSOR &&
            !legacyNativeDescriptor
          ) {
            throw new AgentTurnError(
              "This agent's saved native session no longer matches its cloud conversation. Start a new agent thread to continue safely.",
            );
          }
        } else if (canonicalHistoryCursor !== EMPTY_NATIVE_HISTORY_CURSOR) {
          throw new AgentTurnError(
            "This agent's native session is missing for its existing cloud conversation. Start a new agent thread to continue safely.",
          );
        }
        execution.assertActive();
      }

      // Clone credentials are minted per turn and expire on their own; they
      // are held in this local only and handed to the executor through a
      // one-shot file it deletes before the agent can run.
      const projectContext =
        workspace.kind === "project" && workspace.slug
          ? await this.fetchProjectCredentials(
              turn,
              workspace.slug,
              execution.signal,
            )
          : undefined;
      execution.assertActive();
      const project = projectContext?.handoff;

      // Authorization is pinned once for the logical turn, before either
      // sandbox attempt. An OOM retry therefore cannot silently pick up a
      // newly authorized or revoked skill version halfway through the turn.
      const cloudSkillHome = this.env.AGENT_HOME
        ? new CloudHomeStore(this.env.AGENT_HOME, {
            base: turn.convexCallbackBase,
            serviceSecret: this.env.BUILDER_SERVICE_SECRET,
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

      // Read once here rather than per attempt: it decides the starting rung
      // (a cold repository has to clone and install) and an escalation retry
      // restores the same checkpoint the first attempt did.
      const descriptor = legacyWorkspaceDescriptor;
      // Without the small class bound there is only one rung, so start (and
      // stay) on the large one rather than pretending to size anything. A
      // workspace that has already been seen to need more memory overrides the
      // heuristic — that memory is what stops the OOM-escalate cycle from
      // repeating on every turn.
      const remembered =
        asInstanceSize(projectContext?.instanceSize) ??
        asInstanceSize(
          await this.env.APP_ROUTES.get(instanceSizeKey(workspaceKey)),
        );
      execution.assertActive();
      let size: InstanceSize = !this.env.SANDBOX_SMALL
        ? "large"
        : (remembered ??
          initialInstanceSize({
            workspaceKind: workspace.kind,
            prompt: turn.prompt,
            restored: Boolean(turnStateWorkspaceRestore || descriptor),
          }));
      await this.ctx.storage.put("sandboxSize", size);
      execution.assertActive();
      sandbox = this.sandbox(sandboxId, size);
      let escalated = false;
      let attempt = await this.runAgentAttempt({
        turn,
        execution,
        sandbox,
        size,
        workspaceRoot,
        descriptor,
        nativeDescriptor: legacyNativeDescriptor,
        turnStateWorkspaceRestore,
        turnStateWorkspaceRestoreConfirmationRequired:
          resolvedTurnState.workspaceConfirmationRequired,
        turnStateThreadRestore,
        turnStateThreadRestoreConfirmationRequired:
          resolvedTurnState.confirmationRequired,
        history,
        project,
        cloudSkillHome,
        cloudSkillCatalog,
        commandTimeoutMs,
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
        await sandbox.destroy().catch(() => undefined);
        execution.assertActive();
        size = "large";
        escalated = true;
        const escalatedId = sessionName(`agent-${turn.turnId}-lg`);
        await this.ctx.storage.put({
          sandboxId: escalatedId,
          sandboxSize: size,
        });
        execution.assertActive();
        // What this turn just learned, written before the retry so it survives
        // however the retry ends: this workspace does not fit on the small
        // rung. Every workspace kind learns here — `project:` additionally
        // records it in Convex below, where the user can see it. The TTL lets
        // a workspace that has since become light drift back down.
        await this.assertAgentExecutionActive(turn, execution);
        const sizeKey = instanceSizeKey(workspaceKey);
        await this.env.APP_ROUTES.put(sizeKey, size, {
          expirationTtl: 30 * 86_400,
        }).catch(() => undefined);
        try {
          await this.assertAgentExecutionActive(turn, execution);
        } catch (error) {
          await this.env.APP_ROUTES.delete(sizeKey).catch(() => undefined);
          throw error;
        }
        // The watchdog budget was spent on the attempt that died; without a
        // fresh one the retry is guaranteed to be cut off mid-run and the
        // escalation buys nothing.
        const watchdogDeadlineAt =
          Date.now() + Math.max(1_000, turn.watchdogMs ?? 15 * 60_000);
        await this.ctx.storage.put(
          AGENT_WATCHDOG_DEADLINE_KEY,
          watchdogDeadlineAt,
        );
        await this.ctx.storage.setAlarm(watchdogDeadlineAt);
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
        sandbox = this.sandbox(escalatedId, size);
        attempt = await this.runAgentAttempt({
          turn,
          execution,
          sandbox,
          size,
          workspaceRoot,
          descriptor,
          nativeDescriptor: legacyNativeDescriptor,
          turnStateWorkspaceRestore,
          turnStateWorkspaceRestoreConfirmationRequired:
            resolvedTurnState.workspaceConfirmationRequired,
          turnStateThreadRestore,
          turnStateThreadRestoreConfirmationRequired:
            resolvedTurnState.confirmationRequired,
          history,
          project,
          cloudSkillHome,
          cloudSkillCatalog,
          commandTimeoutMs,
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
        await sandbox.destroy().catch(() => undefined);
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

      if (result.ok && workspace.kind === "stella") {
        await this.event(
          turn,
          "auto",
          "interior_build_started",
          { sourceWorkspace: workspace.canonical },
          false,
          execution.signal,
        ).catch(() => undefined);
        try {
          interiorCandidate = await this.publishInteriorCandidate(
            turn,
            sandbox,
            workspaceRoot,
            commandTimeoutMs,
            execution,
          );
          await this.event(
            turn,
            "auto",
            "interior_candidate_created",
            {
              buildId: interiorCandidate.buildId,
              previewUrl: interiorCandidate.previewUrl,
              digest: interiorCandidate.digest,
              size: interiorCandidate.size,
              sourceRevision: interiorCandidate.sourceRevision,
              baseRevision: interiorCandidate.baseRevision,
              activated: false,
            },
            false,
            execution.signal,
          ).catch(() => undefined);
        } catch (error) {
          if (
            !(await this.ownsExactTurn(turn)) ||
            (await this.ctx.storage.get<boolean>("terminal"))
          ) {
            await sandbox.destroy().catch(() => undefined);
            return;
          }
          const buildError = errorMessage(error);
          log("error", "interior_candidate_failed", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            message: buildError,
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
            execution.signal,
          ).catch(() => undefined);
          result = {
            ...result,
            ok: false,
            error:
              "The agent's source changes were kept, but the updated Stella interior did not pass its production build, so no candidate was created.",
          };
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
        } else if (
          !builderFallbackUsed &&
          (turn.execution?.engine === "anthropic") !==
            Boolean(checkpoint.nativeSha256)
        ) {
          checkpointError =
            "The turn-state receipt did not match the execution engine.";
        } else {
          try {
            await this.assertAgentExecutionActive(turn, execution);
            const canonicalRows = await this.fetchCanonicalAgentHistory(turn, {
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
              workspace.canonical,
              checkpoint.historyCursor,
              checkpoint.operationId,
            );
            execution.assertActive();
            const published = await this.resolveAgentTurnState(
              turn,
              workspace.canonical,
              checkpoint.historyCursor,
              { allowMissingNative: builderFallbackUsed },
            );
            if (
              published.workspacePublication ||
              !published.workspace ||
              !published.restore ||
              published.workspace.operationId !== checkpoint.operationId ||
              published.workspace.archive.sha256 !==
                checkpoint.workspaceSha256 ||
              published.restore.receipt !== checkpoint.receipt ||
              published.restore.native?.sha256 !== checkpoint.nativeSha256
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
        await sandbox.destroy().catch(() => undefined);
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
              "Stella could not validate the durable workspace receipt for this browser handoff. Please retry before continuing this agent.",
          };
        }
      }

      if (
        result.outcome === "suspended" &&
        result.suspension &&
        validTurnStateCheckpointReceipt(result.turnStateCheckpoint)
      ) {
        const verifiedSuspension =
          await this.recoverObservedBrowserSuspension(
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
              "Stella could not validate this browser handoff. Please retry the turn.",
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
        await sandbox.destroy().catch(() => undefined);
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
      // What this turn learned about the project: the setup command it had to
      // infer, and the instance size it actually needed. Recording them is
      // what stops the next turn from rediscovering both the slow way.
      if (workspace.kind === "project") {
        const setupScript =
          result.project?.setupSource === "inferred"
            ? result.project.setupCommand
            : undefined;
        if (setupScript || escalated || !checkpointError) {
          await this.callback(turn, "/api/cloud/projects/setup", {
            ownerId: turn.ownerId,
            slug: workspace.slug,
            workspace: workspace.canonical,
            ...(setupScript ? { setupScript } : {}),
            ...(escalated ? { instanceSize: size } : {}),
            ...(checkpointError ? {} : { checkpointedAt: Date.now() }),
          }).catch(() => undefined);
        }
      }
      await sandbox.destroy().catch(() => undefined);
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
          error.disposition === "sandbox_destroyed"
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
        await withInfrastructureDeadline(
          sandbox.destroy(),
          30_000,
          "Agent sandbox destruction did not settle.",
        );
      } catch (destroyError) {
        log("error", "agent_sandbox_destruction_deferred", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          message: errorMessage(destroyError),
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
          await this.cleanupTransientWrites(turn);
          await this.ctx.blockConcurrencyWhile(async () => {
            if (!(await this.ownsExactTurn(turn))) return;
            await this.ctx.storage.deleteAlarm().catch(() => undefined);
            await this.ctx.storage.deleteAll();
          });
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
    workspaceRoot: TurnStateWorkspaceRoot;
    /** The workspace's last checkpoint, or null on its first turn. */
    descriptor: DirectoryBackup | null;
    /** Root-private Claude state selected by the canonical transcript. */
    nativeDescriptor: DirectoryBackup | null;
    /** Latest canonical owner/workspace archive, shared across all threads. */
    turnStateWorkspaceRestore?: TurnStateWorkspaceHead;
    turnStateWorkspaceRestoreConfirmationRequired: boolean;
    /** Canonical transcript/native state for this exact thread only. */
    turnStateThreadRestore?: TurnStateCandidate;
    turnStateThreadRestoreConfirmationRequired: boolean;
    history: AgentHistoryRow[];
    project?: ProjectHandoff;
    cloudSkillHome?: CloudHomeStore;
    cloudSkillCatalog?: CloudSkillCatalogSnapshot;
    commandTimeoutMs: number;
  }): Promise<{
    result: AgentExecutorResult;
    oom: boolean;
    coldContainerStartMs: number;
    restoreMs: number;
  }> {
    const {
      turn,
      execution: turnExecution,
      sandbox,
      workspaceRoot,
      descriptor,
    } = args;
    const coldStarted = performance.now();
    await this.assertAgentExecutionActive(turn, turnExecution);
    const session = await sandbox.createSession({
      id: sessionName(`agent-run-${turn.turnId}-${args.size}`),
      cwd: "/opt/stella",
      commandTimeoutMs: args.commandTimeoutMs,
      env: executorSessionEnvironment(workspaceRoot),
    });
    turnExecution.assertActive();
    const coldContainerStartMs = Math.round(performance.now() - coldStarted);

    // Sandbox disk is a cache: restore the workspace's last checkpoint, or
    // start it empty on first use.
    let restoreMs = 0;
    if (args.turnStateWorkspaceRestore) {
      const restoreStarted = performance.now();
      turnExecution.assertActive();
      await restoreTurnStateArchive({
        session,
        bucket: this.env.BACKUP_BUCKET,
        archive: args.turnStateWorkspaceRestore.archive,
        target: { kind: "workspace", workspaceRoot },
      });
      turnExecution.assertActive();
      restoreMs = Math.round(performance.now() - restoreStarted);
      await normalizeToolWorkspaceRoot(session, workspaceRoot);
      turnExecution.assertActive();
    } else if (descriptor) {
      const restoreStarted = performance.now();
      turnExecution.assertActive();
      await sandbox.restoreBackup(descriptor);
      turnExecution.assertActive();
      restoreMs = Math.round(performance.now() - restoreStarted);
      await normalizeToolWorkspaceRoot(session, workspaceRoot);
      turnExecution.assertActive();
    } else if (workspaceRoot === "/workspace/stella") {
      // A first Stella workspace is a real, buildable renderer checkout from
      // the immutable image—not an empty directory the model has to invent.
      // All paths are fixed image/mount contract constants; no user value is
      // interpolated into this seeding command.
      turnExecution.assertActive();
      await normalizeToolWorkspaceRoot(session, workspaceRoot);
      await seedFirstStellaToolWorkspace(session);
      turnExecution.assertActive();
    } else {
      turnExecution.assertActive();
      await normalizeToolWorkspaceRoot(session, workspaceRoot);
      turnExecution.assertActive();
    }
    if (
      workspaceRoot === "/workspace/stella" &&
      (args.turnStateWorkspaceRestore || descriptor)
    ) {
      const readJson = async (filePath: string) => {
        const read = await session.readFile(filePath, { encoding: "base64" });
        turnExecution.assertActive();
        return JSON.parse(atob(read.content)) as Record<string, unknown>;
      };
      const [workspaceState, imageSeed] = await Promise.all([
        readJson("/workspace/stella/.stella/interior-source.json"),
        readJson("/opt/stella/interior-seed.json"),
      ]);
      const workspaceSeedRevision =
        typeof workspaceState.upstreamSeedRevision === "string"
          ? workspaceState.upstreamSeedRevision
          : workspaceState.buildId === undefined &&
              typeof workspaceState.sourceRevision === "string"
            ? workspaceState.sourceRevision
            : null;
      if (
        !workspaceSeedRevision ||
        typeof imageSeed.sourceRevision !== "string" ||
        workspaceSeedRevision !== imageSeed.sourceRevision
      ) {
        throw new AgentTurnError(
          "Stella's packaged renderer changed since this cloud workspace was created. Its existing customizations need an upstream migration before another self-update can be built.",
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
    } else if (args.nativeDescriptor) {
      const nativeRestoreStarted = performance.now();
      turnExecution.assertActive();
      await sandbox.restoreBackup(args.nativeDescriptor);
      turnExecution.assertActive();
      restoreMs += Math.round(performance.now() - nativeRestoreStarted);
    }
    turnExecution.assertActive();
    if (args.turnStateWorkspaceRestore || args.turnStateThreadRestore) {
      await this.confirmAgentTurnStateRestore(
        turn,
        resolveWorkspace(turn.workspace)!.canonical,
        await nativeHistoryCursorFromRows(args.history),
        args.turnStateWorkspaceRestore,
        args.turnStateWorkspaceRestoreConfirmationRequired,
        args.turnStateThreadRestore,
        args.turnStateThreadRestoreConfirmationRequired,
      );
      turnExecution.assertActive();
    }
    await this.event(
      turn,
      "auto",
      "sandbox_ready",
      {
        coldContainerStartMs,
        restoreMs,
        restored: Boolean(args.turnStateWorkspaceRestore || descriptor),
        instanceType: INSTANCE_TIERS[args.size].instanceType,
      },
      false,
      turnExecution.signal,
    );
    turnExecution.assertActive();

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

      // The installation token is the one thing that does not go into
      // turn-input.json: that file survives the whole turn one directory above
      // the agent's cwd, so anything in it is one `cat ../turn-input.json` away
      // from a prompt-injected agent. It gets its own file instead, and the
      // executor deletes that file before it builds the agent's tool host.
      if (args.project) {
        const { token, ...handoff } = args.project;
        projectInput = handoff;
        if (token) {
          credentialsPath = projectCredentialsPath();
          turnExecution.assertActive();
          await session.writeFile(credentialsPath, JSON.stringify({ token }));
          turnExecution.assertActive();
          projectInput = { ...handoff, credentialsPath };
        }
      }

      // turn-input.json sits above the workspace root on purpose: the
      // checkpoint only covers the root, so nothing here reaches a durable
      // backup.
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
          workspace: turn.workspace ?? "cloud",
          workspaceRestored: Boolean(
            args.turnStateWorkspaceRestore || descriptor,
          ),
          nativeStateIntegrityKey,
          turnBroker: { credentialsPath: brokerCredentialsPath },
          history: args.history,
          ...(turn.browserResume ? { browserResume: turn.browserResume } : {}),
          ...(cloudSkills ? { skills: cloudSkills } : {}),
          ...(projectInput ? { project: projectInput } : {}),
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
      const resultPollController = new AbortController();
      const captureOutcome = capturedSessionExec(
        sandbox,
        ["bun", "packages/executor-cloud/src/cli.ts", "--agent-turn"],
        args.commandTimeoutMs,
        {
          cwd: "/opt/stella",
          env: executorSessionEnvironment(workspaceRoot),
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
            await withInfrastructureDeadline(
              sandbox.destroy(),
              30_000,
              "Captured session sandbox destruction did not settle.",
            );
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
            return "sandbox_destroyed" as const;
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
                  workspace: resolveWorkspace(turn.workspace)!.canonical,
                  workspaceRoot,
                  startedAt: Date.now(),
                };
                await transaction.put(markerKey, value);
                return value;
              },
            );
            if (
              marker.workspaceRoot !== workspaceRoot ||
              marker.turnId !== turn.turnId
            ) {
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
      const resultFileOutcome = waitForCloudAgentTurnResultText(session, [
        resultPollController.signal,
        turnExecution.signal,
      ]).then(
        (resultText) =>
          ({ kind: "result_file" as const, resultText }) as const,
        (error: unknown) =>
          ({ kind: "result_file_error" as const, error }) as const,
      );
      const firstOutcome = await Promise.race([
        captureOutcome,
        resultFileOutcome,
      ]);
      resultPollController.abort(
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
          new Promise<{ kind: "capture_pending" }>((resolve) =>
            setTimeout(() => resolve({ kind: "capture_pending" }), 1_000),
          ),
        ]);
        if (captureAfterFile.kind === "execution") {
          execution = captureAfterFile.execution;
          recordedResultProcessQuiesced = true;
        } else if (captureAfterFile.kind === "execution_error") {
          capturedExecutionError = captureAfterFile.error;
          recordedResultProcessQuiesced =
            !(captureAfterFile.error instanceof CapturedSessionAbandonedError) ||
            captureAfterFile.error.disposition === "session_quiesced";
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

  /**
   * Short-lived clone credentials for a `project:` workspace. The response is
   * never logged and never persisted: it is read into the caller's local and
   * handed straight to the sandbox.
   */
  private async fetchProjectCredentials(
    turn: TurnRequest,
    slug: string,
    executionSignal?: AbortSignal,
  ): Promise<{ handoff?: ProjectHandoff; instanceSize?: string }> {
    let payload: {
      provider?: string;
      remoteUrl?: string | null;
      token?: string | null;
      defaultBranch?: string;
      setupScript?: string;
      instanceSize?: string;
      authorName?: string;
      authorEmail?: string;
      error?: string;
    };
    try {
      const response = await fetch(
        `${turn.convexCallbackBase.replace(/\/+$/, "")}/api/cloud/projects/credentials`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            slug,
            threadId: turn.threadId,
          }),
          signal: executionSignal
            ? AbortSignal.any([executionSignal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        log("error", "project_credentials_failed", {
          turnId: turn.turnId,
          slug,
          status: response.status,
        });
        throw new AgentTurnError(
          "Stella couldn't get access to that project's repository. Reconnect the project and try again.",
        );
      }
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      if (error instanceof AgentTurnError) throw error;
      throw new AgentTurnError(
        "Stella couldn't reach that project's repository. Try again in a moment.",
      );
    }
    const instanceSize = payload.instanceSize?.trim();
    // Stella-hosted projects have no remote at all: the restored workspace is
    // the git home, so there is nothing to clone and no token to hand over.
    if (payload.provider === "stella" || !payload.remoteUrl) {
      return { ...(instanceSize ? { instanceSize } : {}) };
    }
    if (!payload.token) {
      throw new AgentTurnError(
        "That project's repository isn't connected to Stella's GitHub app yet, so the agent can't reach it.",
      );
    }
    const defaultBranch = payload.defaultBranch?.trim() || "main";
    return {
      handoff: {
        remoteUrl: payload.remoteUrl,
        token: payload.token,
        defaultBranch,
        // Agents work directly on the default branch, like a person at a
        // clone: each turn's sandbox is its own working copy, and the remote
        // reconciles concurrent work through ordinary fetch/rebase/push.
        branch: defaultBranch,
        ...(payload.setupScript ? { setupScript: payload.setupScript } : {}),
        ...(payload.authorName && payload.authorEmail
          ? {
              authorName: payload.authorName,
              authorEmail: payload.authorEmail,
            }
          : {}),
      },
      ...(instanceSize ? { instanceSize } : {}),
    };
  }

  private async runTurn(
    turn: TurnRequest,
    turnExecution: TurnExecutionContext,
  ): Promise<Response> {
    const commandTimeoutMs = Number(this.env.TURN_TIMEOUT_MS);
    const firstSandboxId = sessionName(`turn-${turn.turnId}`);
    const first = this.sandbox(firstSandboxId);
    await this.ctx.blockConcurrencyWhile(async () => {
      turnExecution.assertActive();
      const turnTokenHash = await sha256Hex(turn.turnToken);
      turnExecution.assertActive();
      await this.assertTurnWritable(turn);
      await this.assertConvexAppTurnAuthority(turn);
      turnExecution.assertActive();
      await this.ctx.storage.put({
        sandboxId: firstSandboxId,
        turn,
        turnTokenHash,
        turnId: turn.turnId,
        terminal: false,
      });
      await this.ctx.storage.setAlarm(
        Date.now() + Math.max(1_000, turn.watchdogMs ?? 15 * 60_000),
      );
      turnExecution.assertActive();
    });
    let seq = 0;
    const requestStarted = performance.now();
    log("info", "turn_started", {
      turnId: turn.turnId,
      appId: turn.appId,
      sessionId: this.ctx.id.toString(),
      autoActivate: turn.autoActivate !== false,
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
      const modelResponse = await fetch(
        `${turn.convexCallbackBase.replace(/\/+$/, "")}/api/cloud/model`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            prompt: turn.prompt,
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            requestId: await cloudModelRequestId(turn.turnId),
          }),
          signal: turnExecution.signal,
        },
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
          stderr: execution.stderr.slice(-4_000),
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
      await this.event(
        turn,
        seq++,
        "live_preview",
        {
          url: tunnel.url,
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
          convexSiteUrl: turn.convexCallbackBase,
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
      if (turn.autoActivate !== false) {
        await this.assertAppExecutionActive(turn, turnExecution);
        const previousRoute = await this.env.APP_ROUTES.get<
          Record<string, unknown>
        >(`app:${slug}`, "json");
        turnExecution.assertActive();
        if (
          previousRoute &&
          (previousRoute.ownerId !== turn.ownerId ||
            previousRoute.appId !== turn.appId)
        ) {
          throw new Error("The hosted app route belongs to another app.");
        }
        await this.ctx.storage.put<TransientAppBuildRoute>(
          transientBuildRouteKey(turn.turnId),
          {
            key: `app:${slug}`,
            ownerId: turn.ownerId,
            appId: turn.appId,
            buildId,
            artifactPrefix,
            ...(previousRoute ? { previousRoute } : {}),
          },
        );
        turnExecution.assertActive();
        await this.env.APP_ROUTES.put(
          `app:${slug}`,
          JSON.stringify({
            appId: turn.appId,
            ownerId: turn.ownerId,
            buildId,
            artifactPrefix,
            suspended: false,
            updatedAt: Date.now(),
          }),
        );
        try {
          await this.assertAppExecutionActive(turn, turnExecution);
        } catch (error) {
          const currentRoute = await this.env.APP_ROUTES.get<
            Record<string, unknown>
          >(`app:${slug}`, "json");
          if (
            currentRoute?.ownerId === turn.ownerId &&
            currentRoute.appId === turn.appId &&
            currentRoute.buildId === buildId &&
            currentRoute.artifactPrefix === artifactPrefix
          ) {
            if (previousRoute) {
              await this.env.APP_ROUTES.put(
                `app:${slug}`,
                JSON.stringify(previousRoute),
              );
            } else {
              await this.env.APP_ROUTES.delete(`app:${slug}`);
            }
          }
          throw error;
        }
      }
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
        autoActivate: turn.autoActivate !== false,
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
      await first.destroy();
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
      return json({ ok: true, ...result });
    } catch (error) {
      const message = errorMessage(error);
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
          failureMessage: message,
        };
        await this.ctx.storage.put(
          pendingAppBuildPublicationKey(turn.turnId),
          cleanupPending,
        );
        const cleanup = await this.advanceAppBuildPublication(
          turn,
          cleanupPending,
        );
        const sandboxId = await this.ctx.storage.get<string>("sandboxId");
        if (sandboxId) {
          await this.sandbox(sandboxId)
            .destroy()
            .catch(() => undefined);
        }
        await first.destroy().catch(() => undefined);
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
        return json({ error: "Cloud app turn failed.", detail: message }, 502);
      }
      if (
        !(error instanceof OwnerPurgeFenceError) &&
        !(await this.ctx.storage.get<boolean>("terminal"))
      ) {
        await this.ctx.storage.put("terminal", true);
        // Only deliberately-written messages ("Stella …") reach the chat
        // bubble; raw provider/infra errors stay in the log line below.
        const friendly = message.startsWith("Stella")
          ? message
          : "Stella hit a problem while building. Try again.";
        await this.event(
          turn,
          seq++,
          "failed",
          { message: friendly },
          true,
        ).catch(() => undefined);
      }
      const sandboxId = await this.ctx.storage.get<string>("sandboxId");
      if (sandboxId)
        await this.sandbox(sandboxId)
          .destroy()
          .catch(() => undefined);
      await first.destroy().catch(() => undefined);
      await this.retireTerminalAppTurnStorage(turn);
      log("error", "turn_failed", {
        turnId: turn.turnId,
        appId: turn.appId,
        message,
      });
      return json({ error: "Cloud app turn failed.", detail: message }, 502);
    } finally {
      await this.unregisterTurn(turn);
    }
  }
}

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
type OwnerPurgeRequest = {
  ownerId?: string;
  /** Convex lifecycle generation; distinct from the external purge fence. */
  ownerGeneration?: string;
  /** Issued by `/owners/purge/begin`; proves this owner is quiesced. */
  purgeGeneration?: string;
  /** Canonical workspace strings whose checkpoint + learned size must go. */
  workspaces?: string[];
  /** App slugs whose hosted route row must go. */
  appSlugs?: string[];
  /** App/interior build artifactPrefix values in APP_BUILDS. */
  buildPrefixes?: string[];
  /** Private browser profiles that must be confirmed gone before row drain. */
  browserProfiles?: string[];
};

const ownerFenceStub = async (env: Env, ownerId: string) =>
  env.BUILD_SESSIONS.getByName(`owner-purge-${await sha256Hex(ownerId)}`);

const callOwnerFence = async (
  env: Env,
  ownerId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> =>
  (await ownerFenceStub(env, ownerId)).fetch(
    `https://build-session/owner-fence/${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HEADER_OWNER_FENCE_ID]: ownerId,
      },
      body: JSON.stringify({ ...body, ownerId }),
    },
  );

const withOwnerActivityLease = async <T>(
  env: Env,
  ownerId: string,
  ownerGeneration: string,
  activityId: string,
  operation: (generation: string, leaseId: string) => Promise<T>,
  workspace?: string,
): Promise<T> => {
  const sessionId = `activity-${activityId}`;
  const turnId = activityId;
  const leaseId = crypto.randomUUID();
  // Activity leases cannot be canceled by owner purge, so every one needs a
  // durable crash expiry. Thirty minutes leaves ample room for large workspace
  // operations while guaranteeing an evicted isolate cannot wedge the owner.
  const expiresAt = Date.now() + 30 * 60_000;
  const registered = await callOwnerFence(env, ownerId, "register", {
    leaseId,
    sessionId,
    turnId,
    ownerGeneration,
    namespace: "activity",
    role: workspace ? "run" : "activity",
    expiresAt,
    ...(workspace ? { workspace } : {}),
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

type OwnerTransferCoordinatorContext = {
  operationId: string;
  planFingerprint: string;
  passId: string;
  attempt: OwnerTransferCoordinatorAttempt;
  stub: DurableObjectStub<OwnerTransferCoordinator>;
  reservation?: OwnerTransferReservationEnvelope;
};

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

type OwnerPurgeReport = {
  ok: true;
  deleted: number;
  /** Stores this pass did not finish. Non-empty means "ask again". */
  pending: string[];
};

/** Pages of 1000 keys per bucket prefix. 10M objects is not a real owner. */
const R2_SWEEP_MAX_PAGES = 10_000;
/** `crypto.randomUUID()` in the sandbox SDK; anything else is not a backup. */
const BACKUP_ID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** The slug an app route is keyed by; same shape `resolveWorkspace` accepts. */
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

class OwnerProductTransferConflictError extends Error {
  constructor(
    message: string,
    readonly code:
      | "owner_transfer_conflict"
      | "destination_checkpoint_changed"
      | "owner_purge_permanent"
      | "owner_purge_temporary"
      | "transfer_busy" = "owner_transfer_conflict",
  ) {
    super(message);
    this.name = "OwnerProductTransferConflictError";
  }
}
class OwnerProductTransferConfigurationError extends Error {}

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
  sourceWorkspace: string;
  destinationWorkspace: string;
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
    sourceWorkspace: args.sourceWorkspace,
    destinationWorkspace: args.destinationWorkspace,
  };
};

const callTurnStateTransferRoute = async <T>(args: {
  env: Env;
  coordinator: OwnerTransferCoordinatorContext;
  fromOwnerId: string;
  fromOwnerGeneration: string;
  toOwnerId: string;
  toOwnerGeneration: string;
  sourceWorkspace: string;
  destinationWorkspace: string;
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
  transform?: (
    source: R2ObjectBody,
    destinationKey: string,
  ) => Promise<
    | { body: ReadableStream | ArrayBuffer | string; contentType?: string }
    | undefined
  >,
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
    const replacement = transform
      ? await transform(source, canonicalKey)
      : undefined;
    const body = replacement?.body ?? (await source.arrayBuffer());
    const options: R2PutOptions = {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: replacement?.contentType
        ? { contentType: replacement.contentType }
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
      await bucket.put(destinationKey, body, options);
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
    sourceWorkspace: args.plan.resolution.from,
    destinationWorkspace: args.plan.resolution.resolvedTo,
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

const moveWorkspaceCheckpoint = async (
  env: Env,
  fromOwnerId: string,
  toOwnerId: string,
  transfer: OwnerWorkspaceTransfer,
  budget: OwnerTransferBudget,
  coordinator: OwnerTransferCoordinatorContext,
): Promise<{
  complete: boolean;
  resolution?: WorkspaceTransferResolution;
}> => {
  const fromKey = await checkpointKey(fromOwnerId, transfer.from);
  const toKey = await checkpointKey(toOwnerId, transfer.to);
  const importedKey = transfer.importedTo
    ? await checkpointKey(toOwnerId, transfer.importedTo)
    : undefined;
  const workspacePlanId = await sha256Hex(
    `workspace-owner-transfer-v1\0${fromKey}\0${toKey}\0${importedKey ?? ""}`,
  );
  const existingPlan = await coordinatorWorkspacePlan(
    coordinator,
    workspacePlanId,
  );
  type CheckpointState = {
    descriptor?: DirectoryBackup;
    debt: WorkspaceBackupDebt;
    size: string | null;
  };
  const readState = async (key: string): Promise<CheckpointState> => ({
    descriptor:
      (await env.APP_ROUTES.get<DirectoryBackup>(key, "json")) ?? undefined,
    debt: (await env.APP_ROUTES.get<WorkspaceBackupDebt>(
      backupDebtKey(key),
      "json",
    )) ?? { backupIds: [] },
    size: await env.APP_ROUTES.get(instanceSizeKey(key)),
  });
  const stateMarker = async (state: CheckpointState): Promise<string> =>
    !state.descriptor &&
    state.debt.backupIds.length === 0 &&
    state.size === null
      ? "absent"
      : await stableValueMarker({
          descriptor: state.descriptor ?? null,
          backupIds: [...state.debt.backupIds].sort(),
          size: state.size,
        });
  const [sourceState, requestedState, importedState] = await Promise.all([
    readState(fromKey),
    readState(toKey),
    importedKey ? readState(importedKey) : Promise.resolve(undefined),
  ]);
  const fromDescriptor = sourceState.descriptor;
  const fromDebt = sourceState.debt;
  const sourceSize = sourceState.size;
  const sourceIds = new Set<string>();
  if (fromDescriptor?.id) sourceIds.add(fromDescriptor.id);
  for (const id of fromDebt.backupIds) sourceIds.add(id);
  for (const sourceId of sourceIds) {
    if (!BACKUP_ID_PATTERN.test(sourceId)) {
      throw new Error("Workspace backup descriptor is invalid.");
    }
  }
  const hasSourceState =
    Boolean(fromDescriptor) || sourceIds.size > 0 || sourceSize !== null;
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
        sourceWorkspace: transfer.from,
        destinationWorkspace: transfer.to,
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
  const destinationTurnStateStatus = async (
    destinationWorkspace: string,
  ): Promise<TurnStateTransferDestinationStatus> =>
    (
      await callTurnStateTransferRoute<TurnStateTransferDestinationStatus>({
        env,
        coordinator,
        fromOwnerId,
        fromOwnerGeneration: coordinator.attempt.fromOwnerGeneration,
        toOwnerId,
        toOwnerGeneration: coordinator.attempt.toOwnerGeneration,
        sourceWorkspace: transfer.from,
        destinationWorkspace,
        side: "destination",
        path: "transfer-status",
      })
    ).body;
  const [requestedTurnState, importedTurnState] = await Promise.all([
    destinationTurnStateStatus(transfer.to),
    transfer.importedTo
      ? destinationTurnStateStatus(transfer.importedTo)
      : Promise.resolve(undefined),
  ]);
  const destinationStateMarker = (
    legacyMarker: string,
    destinationWorkspace: string,
    status: TurnStateTransferDestinationStatus | undefined,
  ): string => {
    if (!status || status.state === "empty") return legacyMarker;
    const exactOwned =
      existingPlan?.turnState !== undefined &&
      existingPlan.resolution.resolvedTo === destinationWorkspace &&
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
      size: destination.size ?? sourceSize,
    };
  };
  const [expectedRequestedState, expectedImportedState] = await Promise.all([
    expectedState(toKey, requestedState),
    importedKey && importedState
      ? expectedState(importedKey, importedState)
      : Promise.resolve(undefined),
  ]);
  const observation: WorkspacePlanObservation = {
    workspacePlanId,
    transfer,
    sourceHasState: hasSourceState || sourceTurnStatePresent,
    sourceStateMarker:
      existingPlan?.sourceStateMarker ??
      (await stableValueMarker({
        legacy: await stateMarker(sourceState),
        turnState: sourceTurnStateFingerprint,
      })),
    requestedDestinationMarker: destinationStateMarker(
      await stateMarker(requestedState),
      transfer.to,
      requestedTurnState,
    ),
    ...(importedState
      ? {
          importedDestinationMarker: destinationStateMarker(
            await stateMarker(importedState),
            transfer.importedTo!,
            importedTurnState,
          ),
        }
      : {}),
    expectedRequestedMarker: await stateMarker(expectedRequestedState),
    ...(expectedImportedState
      ? { expectedImportedMarker: await stateMarker(expectedImportedState) }
      : {}),
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
  const resolution = planBody?.plan?.resolution;
  if (!planResponse.ok || !resolution || !planBody?.plan?.state) {
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
  if (planBody.plan.state === "retired") {
    return { complete: true, resolution };
  }
  let durablePlan = planBody.plan;
  const resolvedKey = resolution.imported ? importedKey : toKey;
  const resolvedState = resolution.imported ? importedState : requestedState;
  const resolvedExpectedState = resolution.imported
    ? expectedImportedState
    : expectedRequestedState;
  if (!resolvedKey || !resolvedState || !resolvedExpectedState) {
    throw new OwnerProductTransferConflictError(
      "The durable workspace transfer selected an invalid destination.",
    );
  }
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
        async (source, destinationKey) => {
          if (!destinationKey.endsWith("/meta.json")) return undefined;
          const metadata = (await source.json().catch(() => null)) as Record<
            string,
            unknown
          > | null;
          return {
            body: JSON.stringify({
              ...(metadata ?? {}),
              name: destinationName,
            }),
            contentType: "application/json",
          };
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
    if (resolvedExpectedState.size !== null) {
      await env.APP_ROUTES.put(
        instanceSizeKey(resolvedKey),
        resolvedExpectedState.size,
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
        sourceWorkspace: resolution.from,
        destinationWorkspace: resolution.resolvedTo,
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
  await env.APP_ROUTES.delete(instanceSizeKey(fromKey));
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
  return { complete: true, resolution };
};

const transferOwnerProductStorage = async (
  env: Env,
  request: OwnerProductTransferRequest,
  coordinator: OwnerTransferCoordinatorContext,
): Promise<
  | {
      complete: true;
      fromOwnerHash: string;
      toOwnerHash: string;
      workspaceResolutions: WorkspaceTransferResolution[];
    }
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
  const workspaceResolutions: WorkspaceTransferResolution[] = [];
  for (const workspace of request.workspaces) {
    const result = await moveWorkspaceCheckpoint(
      env,
      request.fromOwnerId,
      request.toOwnerId,
      workspace,
      budget,
      coordinator,
    );
    if (!result.complete) return { complete: false };
    if (result.resolution) workspaceResolutions.push(result.resolution);
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
  return {
    complete: true,
    fromOwnerHash,
    toOwnerHash,
    workspaceResolutions,
  };
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

  // Workspace checkpoints. The archive is named only by the descriptor, so the
  // descriptor is deleted last: a crash between the two leaves a KV key
  // pointing at bytes that are already gone (harmless — restore fails and the
  // workspace starts cold), never bytes with nothing left that names them.
  for (const raw of request.workspaces ?? []) {
    const workspace = resolveWorkspace(raw);
    // `computer` runs on the user's own machine and has no checkpoint here.
    if (workspace?.kind === "computer") continue;
    // Anything else this worker cannot parse is reported, never skipped: a
    // silently dropped name is a checkpoint that survives deletion while the
    // purge reports success, which is the exact failure this route guards.
    if (!workspace) {
      pending.push("checkpoint:unparseable");
      continue;
    }
    const store = `checkpoint:${workspace.canonical}`;
    try {
      const key = await checkpointKey(ownerId, workspace.canonical);
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
      if (backupSweepFailed) continue;
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
      if (historicalSweepFailed) continue;
      await env.APP_ROUTES.delete(key);
      await env.APP_ROUTES.delete(debtKey);
      await env.APP_ROUTES.delete(importsKey);
      await env.APP_ROUTES.delete(workspaceTransferReceiptsKey(key));
      // The learned instance size describes the deleted workspace's work, not
      // whatever reuses the slug next.
      await env.APP_ROUTES.delete(instanceSizeKey(key));
      // Counted only when there was something to delete: `deleted` is read off
      // the log to see how much an account actually held, and a fixed number
      // of unconditional KV deletes per workspace would drown that.
      if (descriptor) deleted += 1;
    } catch (error) {
      fail(store, error);
    }
  }

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    log("info", "request_started", {
      requestId,
      method: request.method,
      path: url.pathname,
    });
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, service: "stella-v2-cloud-builder" });
    }

    // ── User-authenticated routes ─────────────────────────────────────────
    // These MUST stay above the service-secret gate below: a signed-in user
    // presents a Convex JWT, not the shared secret, so matching them after the
    // gate would 401 every client. Both verify the JWT themselves and forward
    // the proven identity to the DO in x-stella-* headers, stripping whatever
    // the client sent under those names first.
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
      return await forwardToConversation(
        request,
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
        conversationName(localTurnMatch[1]!),
        `/local-turns/${localTurnMatch[2]!}`,
        auth.caller,
      );
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
    if (!authorized(request, env)) return json({ error: "Unauthorized." }, 401);
    if (
      request.method === "POST" &&
      [
        "/internal/interactions/status",
        "/internal/interactions/live-view",
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
        const upstreamBody = await upstream.arrayBuffer();
        if (upstreamBody.byteLength > 64 * 1024) {
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
    if (url.pathname.startsWith("/internal/cloud-home/")) {
      const response = await handleInternalCloudHomeRoute({
        request,
        env,
        withLease: cloudHomeLeaseRunner(env),
      });
      if (response) return response;
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
          workspaces: transfer.workspaces,
          appSlugs: transfer.appSlugs,
        })}`,
        plan: {
          kind: "product",
          agentHome: transfer.agentHome,
          interiors: transfer.interiors,
          workspaces: transfer.workspaces,
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
      return env.BUILD_SESSIONS.getByName(buildSessionName).fetch(
        "https://build-session/turn",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [HEADER_BUILD_SESSION_NAME]: buildSessionName,
            [HEADER_TURN_BROKER_ENDPOINT]: turnBrokerEndpoint,
          },
          body: await request.text(),
        },
      );
    }
    // The orchestrator loop: one DO per conversation, no sandbox.
    const chatTurnMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/turns$/,
    );
    if (request.method === "POST" && chatTurnMatch) {
      return env.ORCHESTRATOR_SESSIONS.getByName(
        conversationName(chatTurnMatch[1]!),
      ).fetch("https://orchestrator-session/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await request.text(),
      });
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
      /^\/conversations\/([^/]+)\/(cards|purge|reindex)$/,
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
    // Deleting a workspace deletes its checkpoint. Without this a new
    // project reusing a deleted project's slug hashes to the same key and
    // restores the deleted project's files on its first turn.
    if (request.method === "POST" && url.pathname === "/workspaces/purge") {
      const body = (await request.json()) as {
        ownerId?: string;
        ownerGeneration?: string;
        workspace?: string;
      };
      const workspace = resolveWorkspace(body.workspace);
      if (
        !body.ownerId ||
        !body.ownerGeneration ||
        !workspace ||
        workspace.kind === "computer"
      ) {
        return json(
          {
            error: "ownerId, ownerGeneration, and a cloud workspace required.",
          },
          400,
        );
      }
      const key = await checkpointKey(body.ownerId, workspace.canonical);
      try {
        await withOwnerActivityLease(
          env,
          body.ownerId,
          body.ownerGeneration,
          requestId,
          async (generation, leaseId) => {
            const turnStatePurge = await callOwnerFence(
              env,
              body.ownerId!,
              "turn-state/purge-workspace",
              {
                schemaVersion: 1,
                ownerGeneration: body.ownerGeneration,
                generation,
                leaseId,
                sessionId: `activity-${requestId}`,
                turnId: requestId,
                workspace: workspace.canonical,
              },
            );
            const turnStateResult = (await turnStatePurge
              .clone()
              .json()
              .catch(() => null)) as { pending?: unknown } | null;
            if (!turnStatePurge.ok || turnStateResult?.pending !== false) {
              throw new Error("Atomic workspace purge is still pending.");
            }
            await purgeNativeStateForWorkspace(env, key);
            const descriptor = await env.APP_ROUTES.get<DirectoryBackup>(
              key,
              "json",
            );
            const debtKey = backupDebtKey(key);
            const debt = await env.APP_ROUTES.get<WorkspaceBackupDebt>(
              debtKey,
              "json",
            );
            const importsKey = checkpointImportsKey(key);
            const imports =
              await env.APP_ROUTES.get<WorkspaceCheckpointImports>(
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
            for (const backupId of recovery.backupIds) {
              if (!BACKUP_ID_PATTERN.test(backupId)) {
                throw new Error("Workspace backup descriptor is invalid.");
              }
              const swept = await sweepR2Prefix(
                env.BACKUP_BUCKET,
                `backups/${backupId}/`,
              );
              if (!swept.done) {
                throw new Error("Workspace backup purge was truncated.");
              }
            }
            for (const historicalName of recovery.historicalBackupNames) {
              const historical = await sweepBackupsByName(
                env.BACKUP_BUCKET,
                historicalName,
              );
              if (!historical.done) {
                throw new Error(
                  "Historical workspace backup scan was truncated.",
                );
              }
            }
            // Bytes first; these keys are the only recovery names.
            await env.APP_ROUTES.delete(key);
            await env.APP_ROUTES.delete(debtKey);
            await env.APP_ROUTES.delete(importsKey);
            await env.APP_ROUTES.delete(workspaceTransferReceiptsKey(key));
            await env.APP_ROUTES.delete(instanceSizeKey(key));
          },
          workspace.canonical,
        );
      } catch (error) {
        if (error instanceof OwnerPurgeFenceError) {
          return json({ error: "Owner cloud activity is being purged." }, 409);
        }
        log("error", "workspace_checkpoint_purge_failed", {
          requestId,
          workspace: workspace.canonical,
          message: errorMessage(error),
        });
        return json({ error: "Workspace checkpoint purge failed." }, 502);
      }
      log("info", "workspace_checkpoint_purged", {
        requestId,
        workspace: workspace.canonical,
      });
      return json({ ok: true });
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
    //   - The named stores (`workspaces`, `appSlugs`, and legacy/interior
    //     `buildPrefixes`) cannot all be derived from the owner id, so Convex
    //     reads them off the rows and sends them here BEFORE deleting those
    //     rows. New app builds are additionally swept by their owner-hash root
    //     above, which catches uploads that never acquired a Convex row.
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
} satisfies ExportedHandler<Env>;
