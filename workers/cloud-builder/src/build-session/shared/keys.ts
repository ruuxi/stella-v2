import { Effect } from "effect";
import { runToolEffect } from "@stella/runtime/kernel/tools/effect-runtime.js";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { ExecutionSession } from "@cloudflare/sandbox";
import type { CloudTurnSource } from "@stella/contracts/turn-plane/turn-start";
import type { TurnEventEvent } from "@stella/contracts/turn-plane/outbox";
import { classifyAgentFailureDiagnostic } from "../../agent-failure-diagnostic.js";
import { sha256Hex } from "../../hash.js";
import { inSubshell } from "../../shell-subshell.js";
import { sandboxLifecycleId } from "../../sandbox-lifecycle.js";
import {
  APP_BUILD_ROOT,
  WORLD_DRIVE_ROOT,
  WORLD_ROOT,
} from "../../workspace.js";
import type { OwnerGateRefusalCode } from "../../owner-gate.js";
import type { Env } from "./env.js";
import type { TurnRequest } from "./types.js";

/** Retry cadence for outbox events a queue outage refused. */
export const OUTBOX_DEBT_KEY = "outboxDebt";

export const OUTBOX_DEBT_MAX = 200;

export const OUTBOX_DEBT_RETRY_MS = 30_000;

/** Sources a `turn.started` event may carry; the agent lane has one extra. */
export const CLOUD_TURN_SOURCES: readonly CloudTurnSource[] = [
  "desktop",
  "web",
  "mobile",
  "schedule",
  "agent-thread",
  "placement",
  "probe",
];

/** HTTP status for each owner-gate refusal on the agent lane. */
export const OWNER_GATE_REFUSAL_STATUS: Record<OwnerGateRefusalCode, number> = {
  owner_purged: 410,
  sign_in_required: 403,
  owner_suspended: 403,
  generation_stale: 409,
  internal: 503,
};

/** Terminal event kind -> the status Convex projects onto the turn row. */
export const TERMINAL_EVENT_STATUS: Record<
  string,
  NonNullable<TurnEventEvent["terminalStatus"]>
> = {
  completed: "completed",
  failed: "failed",
  canceled: "canceled",
  waiting_for_user: "waiting_for_user",
};

export const turnDispatchIdentity = (
  turn: TurnRequest,
): Omit<
  TurnRequest,
  | "ownerPurgeGeneration"
  | "ownerPurgeLeaseId"
  | "gateAdmittedByCaller"
  | "audience"
  | "budgetMicroCents"
> => {
  const identity = { ...turn } as Partial<TurnRequest>;
  delete identity.ownerPurgeGeneration;
  delete identity.ownerPurgeLeaseId;
  // Who admitted the owner gate is a routing fact about one dispatch, not
  // part of the turn: the same attempt replayed through the public route and
  // through the orchestrator must still classify as a replay.
  delete identity.gateAdmittedByCaller;
  // The allowance is the owner gate's answer, not the caller's: the stored
  // turn carries the snapshot's values while a replayed dispatch still
  // carries the dispatcher's hints. Comparing them would turn every retry
  // after a plan change into an idempotency conflict.
  delete identity.audience;
  delete identity.budgetMicroCents;
  return identity as Omit<
    TurnRequest,
    | "ownerPurgeGeneration"
    | "ownerPurgeLeaseId"
    | "gateAdmittedByCaller"
    | "audience"
    | "budgetMicroCents"
  >;
};

/**
 * The owner-purge lease changes when an alarm borrows an auxiliary lease, so
 * it is intentionally excluded. Everything that can distinguish an ABA turn
 * (including its agent attempt generation) remains exact.
 */
export const exactTurnIdentityMatches = (
  current: TurnRequest | undefined,
  expected: TurnRequest,
): boolean =>
  current !== undefined &&
  current.ownerId === expected.ownerId &&
  current.ownerGeneration === expected.ownerGeneration &&
  current.turnId === expected.turnId &&
  current.kind === expected.kind &&
  current.appId === expected.appId &&
  current.conversationId === expected.conversationId &&
  current.sessionId === expected.sessionId &&
  current.threadId === expected.threadId &&
  current.attemptGeneration === expected.attemptGeneration &&
  JSON.stringify(current.browserResume ?? null) ===
    JSON.stringify(expected.browserResume ?? null);

export const BUILD_OWNER_FENCE_LEASE_RECEIPT_PREFIX =
  "buildOwnerFenceLeaseReceipt:";

export const BUILD_OWNER_FENCE_LEASE_SLOT_PREFIX = "ownerFenceLeaseSlot:";

export const OWNER_FENCE_LEASE_RETRY_MS = 30_000;

export const buildOwnerFenceLeaseReceiptKey = (leaseId: string): string =>
  `${BUILD_OWNER_FENCE_LEASE_RECEIPT_PREFIX}${leaseId}`;

export const isBuildOwnerFenceDurabilityKey = (key: string): boolean =>
  key.startsWith(BUILD_OWNER_FENCE_LEASE_RECEIPT_PREFIX) ||
  key.startsWith(BUILD_OWNER_FENCE_LEASE_SLOT_PREFIX);

export const agentComputeRecoveryClaimKey = (
  turnId: string,
  attemptGeneration: number,
): string => `agentComputeRecovery:${turnId}:${attemptGeneration}`;

export const APP_TURN_ADMISSION_CLAIM_KEY = "appTurnAdmissionClaim";

export const PENDING_BROWSER_SUSPENSION_KEY = "pendingBrowserSuspension";

export const OBSERVED_BROWSER_SUSPENSION_KEY = "observedBrowserSuspension";

export const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const withInfrastructureDeadline = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  return await runToolEffect(
    Effect.raceFirst(
      Effect.tryPromise({
        try: () => operation,
        catch: (error) => error,
      }),
      Effect.sleep(timeoutMs).pipe(
        Effect.flatMap(() => Effect.fail(new Error(message))),
      ),
    ),
  );
};

export const log = (
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

export const executionFailureFields = (
  stderr: string,
): { failureCode: string; stderrBytes: number } => ({
  failureCode: classifyAgentFailureDiagnostic(stderr),
  stderrBytes: new TextEncoder().encode(stderr).byteLength,
});

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
export const conversationName = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export const sessionName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);

export const contentType = (path: string): string => {
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

/** Longer than the 30s callback timeout; covers an evicted isolate's last send. */
export const OWNER_PURGE_STALE_LEASE_GRACE_MS = 35_000;

export const backupDebtKey = (workspaceKey: string): string =>
  `${workspaceKey}:backup-debt`;

export const turnStateCheckpointOperationKey = (requestId: string): string =>
  `turnStateCheckpointOperation:${requestId}`;

export const builderFallbackTranscriptKey = (
  turnId: string,
  attemptGeneration: number,
): string => `builderFallbackTranscript:${turnId}:${attemptGeneration}`;

export const agentExecutionMarkerKey = (
  turnId: string,
  attemptGeneration: number,
): string => `agentExecutionMarker:${turnId}:${attemptGeneration}`;

export const turnStateBaseWorkspaceRevisionKey = (
  turnId: string,
  attemptGeneration: number,
): string => `turnStateBaseWorkspaceRevision:${turnId}:${attemptGeneration}`;

export const nativeTransientBackupKey = (turnId: string): string =>
  `nativeTransientBackup:${turnId}`;

export const nativeBackupDebtKey = (workspaceKey: string): string =>
  `${workspaceKey}:native-backup-debt`;

export const nativeStateIntegrityKeyFor = async (
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

export const AGENT_WATCHDOG_DEADLINE_KEY = "agentWatchdogDeadlineAt";

/**
 * How many alarm passes a builder-fallback recovery may fail before the turn
 * is failed outright. Each pass boots the lost container again; unbounded,
 * a container whose disk can no longer be read kept a thread "running" and a
 * container restarting every thirty seconds indefinitely.
 */
export const BUILDER_FALLBACK_MAX_RETRIES = 10;

export const builderFallbackRetryKey = (
  turnId: string,
  attemptGeneration: number,
): string => `builderFallbackRetries:${turnId}:${attemptGeneration}`;

/**
 * How often a live agent turn re-arms its alarm when nothing else (a world
 * lease renewal) would. The alarm is the only thing that notices a turn whose
 * isolate was replaced under it — a deploy, an eviction — so without this a
 * resident turn lost that way sat as "running" until its full watchdog
 * deadline, holding the owner's agent lane for the whole wait.
 */
export const AGENT_TURN_HEARTBEAT_MS = 60_000;

export const AGENT_RECOVERY_PENDING_KEY = "agentRecoveryPending";

export const agentRecoveryIdentity = (turn: TurnRequest): string =>
  `${turn.turnId}:${turn.attemptGeneration ?? 0}`;

export const pendingAppBuildPublicationKey = (turnId: string): string =>
  `pendingAppBuildPublication:${turnId}`;

export const checkpointImportsKey = (workspaceKey: string): string =>
  `${workspaceKey}:checkpoint-imports`;

/** Legacy eventual-KV receipt key, retained only so purge removes old rows. */
export const workspaceTransferReceiptsKey = (workspaceKey: string): string =>
  `${workspaceKey}:owner-transfer-receipts`;

export const ORCHESTRATOR_INTERNAL_ORIGIN = "https://orchestrator-session";
export const HEADER_CONVERSATION_ID = "x-stella-conversation-id";
/** Digest shape every artifact and gateway observation must present. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * App-build turns are dispatched without a pinned execution — the art
 * director's model is Convex's own choice, resolved through `/api/cloud/model`
 * — but a turn capability's binding is not optional. This placeholder is what
 * the lane's control-plane capability carries. It is never minted for the
 * model-gateway audience, so it can never pin a model call.
 */
export const APP_BUILD_CONTROL_PLANE_EXECUTION = {
  engine: "stella",
  provider: "stella",
  model: "app-build",
  reasoningEffort: "default",
} as CloudExecutionSelection;

/** Header the outer Worker forwards a signed preview capability on. */
export const HEADER_PREVIEW_CAPABILITY = "x-stella-preview-capability";

export const exactTurnSandboxId = async (
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

/** Pages of 1000 keys per bucket prefix. 10M objects is not a real owner. */
export const R2_SWEEP_MAX_PAGES = 10_000;

/** `crypto.randomUUID()` in the sandbox SDK; anything else is not a backup. */
export const BACKUP_ID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/**
 * Delete every object under `prefix`. Bounded: `list` is cursor-paged at 1000
 * and each page is deleted before the next is fetched, so neither memory nor
 * the delete batch grows with the owner's history. `done: false` means the
 * sweep ran out of pages and the caller must ask again.
 */
export const sweepR2Prefix = async (
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
