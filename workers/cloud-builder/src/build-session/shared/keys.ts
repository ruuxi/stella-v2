import { Effect } from "effect";
import { runToolEffect } from "@stella/runtime/kernel/tools/effect-runtime.js";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { ExecutionSession } from "@cloudflare/sandbox";
import type { CloudTurnSource } from "@stella/contracts/turn-plane/turn-start";
import type { TurnEventEvent } from "@stella/contracts/turn-plane/outbox";
import { classifyAgentFailureDiagnostic } from "../../agent-failure-diagnostic.js";
import { mintTurnCapability } from "../../capability-signer.js";
import { sha256Hex } from "../../hash.js";
import { inSubshell } from "../../shell-subshell.js";
import { sandboxLifecycleId } from "../../sandbox-lifecycle.js";
import { APP_BUILD_ROOT, WORLD_ROOT } from "../../workspace.js";
import type { OwnerGateRefusalCode } from "../../owner-gate.js";
import { AgentTurnAuthorityLostError } from "./errors.js";
import { isCloudBrowserSuspension } from "@stella/contracts/cloud-browser";
import type { CloudBrowserSuspension } from "@stella/contracts/cloud-browser";
import type { TurnBrokerTurnStateCheckpointReceipt } from "@stella/contracts/turn-credential-broker";
import { nativeHistoryCursorFromRows } from "../../native-state-checkpoint.js";
import type { Env } from "./env.js";
import type { ObservedBrowserSuspension, TurnRequest } from "./types.js";

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
/** Headers the outer Worker forwards a dispatched turn's routing on. */
export const HEADER_BUILD_SESSION_NAME = "x-stella-build-session-name";
export const HEADER_TURN_BROKER_ENDPOINT = "x-stella-turn-broker-endpoint";
export const HEADER_PREVIEW_BASE_URL = "x-stella-preview-base-url";
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
const FORK_WORKSPACE_ROOT = /^\/workspace\/forks\/fork-[0-9a-f-]{36}\/world$/u;

/** Establish the post-mount fixed boundary before any model-shaped process. */
export const normalizeToolWorkspaceRoot = async (
  session: Pick<ExecutionSession, "exec">,
  workspaceRoot: string,
): Promise<void> => {
  if (
    workspaceRoot !== WORLD_ROOT &&
    workspaceRoot !== APP_BUILD_ROOT &&
    !FORK_WORKSPACE_ROOT.test(workspaceRoot)
  ) {
    throw new Error("Invalid cloud workspace mount path.");
  }
  const command = [
    "set -eu",
    "test ! -L /workspace",
    'test "$(readlink -f /workspace)" = /workspace',
    "test \"$(stat -c '%u:%g:%a' /workspace)\" = 0:42424:750",
    `if [ -e '${workspaceRoot}' ] || [ -L '${workspaceRoot}' ]; then test -d '${workspaceRoot}' && test ! -L '${workspaceRoot}'; else mkdir -p '${workspaceRoot}'; fi`,
    `chown 42424:42424 '${workspaceRoot}'`,
    `chmod 0750 '${workspaceRoot}'`,
    `test "$(readlink -f '${workspaceRoot}')" = '${workspaceRoot}'`,
    `test "$(stat -c '%u:%g:%a' '${workspaceRoot}')" = 42424:42424:750`,
    ...(workspaceRoot !== APP_BUILD_ROOT
      ? [
          `if [ -e '${workspaceRoot}/drive' ] || [ -L '${workspaceRoot}/drive' ]; then test -d '${workspaceRoot}/drive' && test ! -L '${workspaceRoot}/drive'; else mkdir -m 0750 '${workspaceRoot}/drive' && chown 42424:42424 '${workspaceRoot}/drive'; fi`,
          `test "$(readlink -f '${workspaceRoot}/drive')" = '${workspaceRoot}/drive'`,
          `test "$(stat -c '%u:%g:%a' '${workspaceRoot}/drive')" = 42424:42424:750`,
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

/**
 * Where the broker credential is handed to the executor: a one-shot file that
 * sits in `/workspace`, above the checkpointed world, with a random name so
 * nothing can be waiting on a known path.
 *
 * Deliberately not an env var on the exec session: the executor's own
 * environment is inherited by every shell the agent spawns, and `unsetenv`
 * does not scrub `/proc/<pid>/environ`, so an env handoff stays readable for
 * the whole turn — which is the defect this avoids.
 */
export const turnBrokerCredentialsPath = (): string =>
  `/workspace/.turn-broker-${crypto.randomUUID()}.json`;

/**
 * Mint the model-gateway capability for one admitted agent turn. It is the
 * only credential the sandbox or resident loop presents for model calls:
 * turn-scoped, pinned to the admitted execution, budgeted, expiring, and
 * meaningless anywhere but the gateway. The reusable Convex turn token never
 * accompanies model traffic.
 */
export const mintAgentTurnModelGateway = async (
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

export const AGENT_HISTORY_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;

export const validBuilderFallbackMessages = (
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

export const validTurnStateCheckpointReceipt = (
  value: unknown,
): value is TurnBrokerTurnStateCheckpointReceipt => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const allowed = new Set(["operationId", "historyCursor", "manifestId"]);
  return (
    Object.keys(receipt).every((key) => allowed.has(key)) &&
    typeof receipt.operationId === "string" &&
    /^[0-9a-f]{64}$/u.test(receipt.operationId) &&
    typeof receipt.historyCursor === "string" &&
    /^(?:v1:empty|v1:[0-9a-f]{64})$/u.test(receipt.historyCursor) &&
    typeof receipt.manifestId === "string" &&
    /^[0-9a-f]{64}$/u.test(receipt.manifestId)
  );
};

export const cloudBrowserSuspensionMarker = (
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

export const canonicalToolCallId = (value: unknown): value is string =>
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
