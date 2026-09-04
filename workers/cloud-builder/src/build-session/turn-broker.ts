/**
 * The sandbox-facing turn broker: the route the executor's own HTTP client
 * talks to, the turn-state checkpoint it commits through, and the browser
 * gateway observation that makes a suspension resumable.
 *
 * Extracted verbatim from `BuildSession`; every former `this.` is the `host`
 * argument. See `src/build-session/host.ts` for why the host is structural.
 */
import {
  agentComputeKey,
  parsePersistedAgentCompute,
} from "../agent-compute-ladder.js";
import {
  parseTurnComputePlan,
  turnComputePlanKey,
} from "../general-agent-turn.js";
import { sha256BytesHex } from "../hash.js";
import {
  interiorBuildRequestKey,
  interiorBuildRequestRecord,
  parseInteriorBuildRequest,
} from "../interior-build-request.js";
import {
  nativeHistoryCursorFromRows,
  validNativeStateCheckpointMac,
} from "../native-state-checkpoint.js";
import { ThreadTranscriptError } from "../thread-transcript.js";
import type { ThreadMessageInput } from "../thread-transcript.js";
import {
  TurnBrokerBodyTooLargeError,
  claimTurnBrokerRequest,
  forwardTurnBrokerRequest,
  preflightTurnBrokerRequest,
  readTurnBrokerRequestBody,
  turnBrokerDenialResponse,
  turnBrokerSandboxResponseHeaders,
  turnBrokerStorageKey,
  turnBrokerTargetMatchesEngine,
} from "../turn-credential-broker.js";
import type {
  TurnBrokerLiveFence,
  TurnBrokerRecord,
  TurnBrokerTarget,
} from "../turn-credential-broker.js";
import { uploadTurnStateArchive } from "../turn-state-archive.js";
import {
  parseTurnStateCheckpointRequest,
  publicTurnStateCheckpointReceipt,
  replaceTurnStateArchiveSession,
} from "../turn-state-checkpoint.js";
import type {
  PreparedTurnStateOperation,
  ResolvedTurnState,
  TurnStateCandidate,
  TurnStateWorkspaceHead,
} from "../turn-state-registry.js";
import { worldName } from "../workspace.js";
import type { BuildSessionInternals } from "./host.js";
import {
  AgentTurnAuthorityLostError,
  AgentTurnError,
  BrowserGatewayResponseTooLargeError,
  OwnerPurgeFenceError,
  TurnStateOwnerCallError,
} from "./shared/errors.js";
import {
  OBSERVED_BROWSER_SUSPENSION_KEY,
  PENDING_BROWSER_SUSPENSION_KEY,
  errorMessage,
  exactTurnIdentityMatches,
  log,
  nativeStateIntegrityKeyFor,
  sessionName,
  turnStateBaseWorkspaceRevisionKey,
  turnStateCheckpointOperationKey,
} from "./shared/keys.js";
import type {
  ObservedBrowserSuspension,
  PendingBrowserSuspension,
  PendingTerminal,
  TurnRequest,
  TurnStateCheckpointOperation,
} from "./shared/types.js";
import { isCloudBrowserSuspension } from "@stella/contracts/cloud-browser";
import type { CloudBrowserSuspension } from "@stella/contracts/cloud-browser";
import { TURN_BROKER_RESPONSE_HEADERS } from "@stella/contracts/turn-credential-broker";
import type {
  TurnBrokerInteriorBuildRequestReceipt,
  TurnBrokerTurnStateCheckpointReceipt,
  TurnBrokerTurnStateCheckpointRequest,
} from "@stella/contracts/turn-credential-broker";

export type TurnBrokerHost = Pick<
  BuildSessionInternals,
  | "ctx"
  | "env"
  | "agentTurnExecutions"
  | "exactTurnCancellations"
  | "turnStateCheckpointRuns"
  | "appendThreadTranscript"
  | "assertAgentTurnIdentity"
  | "assertTurnWritable"
  | "callOwnerTurnState"
  | "controlPlaneCapability"
  | "currentSandbox"
  | "emitTurnEvent"
  | "executeTurnStateCheckpoint"
>;

/** Local copy of the artifact digest shape; see `app-build-artifacts.ts`. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** @see src/build-session/shared/keys.ts */
export { turnBrokerCredentialsPath } from "./shared/keys.js";

const BROWSER_GATEWAY_RESPONSE_MAX_BYTES = 64 * 1024;

export const AGENT_HISTORY_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;

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

export const resolveAgentTurnState = async (
  host: TurnBrokerHost,
  turn: TurnRequest,
  canonicalHistoryCursor: string,
  options: { allowMissingNative?: boolean } = {},
): Promise<ResolvedTurnState> => {
  const resolved = await host.callOwnerTurnState<ResolvedTurnState>(
    turn,
    "resolve",
    {
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
      !/^[0-9a-f]{64}$/u.test(workspaceHead.manifestId) ||
      !/^(?:v1:empty|v1:[0-9a-f]{64})$/u.test(workspaceHead.historyCursor) ||
      !Number.isSafeInteger(workspaceHead.revision) ||
      workspaceHead.revision <= 0 ||
      workspaceHead.revision !== resolved.baseWorkspaceRevision ||
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
      const integrityKey = await nativeStateIntegrityKeyFor(host.env, turn);
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
};

export const publishAgentTurnWorkspace = async (
  host: TurnBrokerHost,
  turn: TurnRequest,
  canonicalHistoryCursor: string,
  operationId: string,
): Promise<TurnStateWorkspaceHead> => {
  const published = await host.callOwnerTurnState<{
    workspaceHead?: TurnStateWorkspaceHead;
    publicationReceipt?: unknown;
    replayed?: unknown;
  }>(turn, "publish-workspace", {
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
    !/^[0-9a-f]{64}$/u.test(head.manifestId) ||
    !Number.isSafeInteger(head.revision) ||
    head.revision <= 0 ||
    typeof published.publicationReceipt !== "string" ||
    !/^[0-9a-f]{64}$/u.test(published.publicationReceipt) ||
    typeof published.replayed !== "boolean"
  ) {
    throw new Error("Turn state workspace publication was invalid.");
  }
  return head;
};

export const confirmAgentTurnStateRestore = async (
  host: TurnBrokerHost,
  turn: TurnRequest,
  canonicalHistoryCursor: string,
  workspaceHead: TurnStateWorkspaceHead | undefined,
  workspaceConfirmationRequired: boolean,
  threadCandidate: TurnStateCandidate | undefined,
  threadConfirmationRequired: boolean,
): Promise<void> => {
  if (workspaceConfirmationRequired || threadConfirmationRequired) {
    const confirmed = await host.callOwnerTurnState<{
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
          confirmed.workspace.restore.manifestId !== workspaceHead.manifestId ||
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
  await host.callOwnerTurnState(turn, "drain", { limit: 32 });
};

export const exactTurnStateCheckpointOperations = async (
  host: TurnBrokerHost,
  turn: TurnRequest,
): Promise<TurnStateCheckpointOperation[]> => {
  const listed = await host.ctx.storage.list<TurnStateCheckpointOperation>({
    prefix: "turnStateCheckpointOperation:",
    limit: 128,
  });
  const exact = [...listed.values()].filter(
    (operation) =>
      operation.turnId === turn.turnId &&
      operation.attemptGeneration === turn.attemptGeneration,
  );
  if (exact.length > 8) {
    throw new Error("Agent checkpoint recovery exceeded its operation bound.");
  }
  return exact;
};

export const abortUnpublishedTurnStateOperation = async (
  host: TurnBrokerHost,
  turn: TurnRequest,
  operation: TurnStateCheckpointOperation,
  canonicalHistoryCursor: string,
): Promise<void> => {
  if (!operation.payload) {
    // The broker claim was persisted before its body parsed, so no owner
    // prepare or R2 write could have occurred. Retire only the local claim.
    await host.ctx.storage.delete(
      turnStateCheckpointOperationKey(operation.requestId),
    );
    return;
  }
  let operationId = operation.operationId;
  if (operation.state === "failed" && !operationId) {
    // A pre-prepare validation denial has no owner registry/object state.
    await host.ctx.storage.delete(
      turnStateCheckpointOperationKey(operation.requestId),
    );
    return;
  }
  if (!operationId) {
    const prepared = await host.callOwnerTurnState<PreparedTurnStateOperation>(
      turn,
      "prepare",
      {
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
    await host.ctx.storage.transaction(async (transaction) => {
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
  const aborted = await host.callOwnerTurnState<{
    operationId?: unknown;
    abortReceipt?: unknown;
    replayed?: unknown;
  }>(turn, "abort-unpublished", {
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
};

const brokerFailure = (status: number): Response => {
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
};

const brokerCheckpointPending = (): Response => {
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
};

export const executeTurnStateCheckpoint = async (
  host: TurnBrokerHost,
  args: {
    turn: TurnRequest;
    operationKey: string;
    operation: Extract<TurnStateCheckpointOperation, { state: "pending" }> & {
      payload: TurnBrokerTurnStateCheckpointRequest;
    };
  },
): Promise<TurnBrokerTurnStateCheckpointReceipt> => {
  const { turn, operationKey, operation } = args;
  await host.assertTurnWritable(turn);
  host.assertAgentTurnIdentity(turn);
  const worldCheckpoint = await host.env.WORLDS.getByName(
    await worldName(turn.ownerId),
  ).checkpoint({ historyCursor: operation.payload.historyCursor });

  const prepared = await host.callOwnerTurnState<PreparedTurnStateOperation>(
    turn,
    "prepare",
    {
      threadId: turn.threadId,
      attemptGeneration: turn.attemptGeneration,
      requestFingerprint: operation.requestFingerprint,
      historyCursor: operation.payload.historyCursor,
      manifestId: worldCheckpoint.manifestId,
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
    prepared.manifestId !== worldCheckpoint.manifestId ||
    prepared.baseWorkspaceRevision !== operation.baseWorkspaceRevision ||
    (operation.payload.nativeCheckpoint
      ? typeof prepared.objectKeys.native !== "string"
      : prepared.objectKeys.native !== undefined)
  ) {
    throw new Error("Turn state preparation receipt was invalid.");
  }
  await host.ctx.storage.transaction(async (transaction) => {
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

  await host.assertTurnWritable(turn);
  host.assertAgentTurnIdentity(turn);
  const sandbox = await host.currentSandbox();
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
    commandTimeoutMs: Number(host.env.TURN_TIMEOUT_MS),
  });
  try {
    let nativeUpload:
      | Awaited<ReturnType<typeof uploadTurnStateArchive>>
      | undefined;
    if (prepared.objectKeys.native) {
      nativeUpload = await uploadTurnStateArchive({
        session,
        bucket: host.env.BACKUP_BUCKET,
        key: prepared.objectKeys.native,
        target: { kind: "native" },
      });
      await host.assertTurnWritable(turn);
      host.assertAgentTurnIdentity(turn);
      await host.callOwnerTurnState(turn, "mark-uploaded", {
        operationId: prepared.operationId,
        archive: nativeUpload.archive,
      });
    }

    await host.assertTurnWritable(turn);
    host.assertAgentTurnIdentity(turn);
    const committed = await host.callOwnerTurnState<{
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
      candidate.workspace.historyCursor !== operation.payload.historyCursor ||
      candidate.workspace.manifestId !== worldCheckpoint.manifestId ||
      JSON.stringify(candidate.native) !==
        JSON.stringify(nativeUpload?.archive) ||
      JSON.stringify(candidate.nativeCheckpoint) !==
        JSON.stringify(operation.payload.nativeCheckpoint) ||
      workspaceHead.operationId !== prepared.operationId ||
      workspaceHead.revision !== operation.baseWorkspaceRevision + 1 ||
      workspaceHead.historyCursor !== operation.payload.historyCursor ||
      workspaceHead.manifestId !== worldCheckpoint.manifestId
    ) {
      throw new Error("Turn state commit receipt was invalid.");
    }

    const receipt = publicTurnStateCheckpointReceipt(candidate, false);
    await host.ctx.storage.transaction(async (transaction) => {
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
};

const observeBrowserGatewaySuspension = async (
  host: TurnBrokerHost,
  turn: TurnRequest,
  input: {
    brokerRequestId: string;
    requestBodySha256: string;
    responseBodySha256: string;
    suspension: CloudBrowserSuspension;
  },
): Promise<"stored" | "replay" | "conflict" | "inactive"> => {
  const observation: ObservedBrowserSuspension = {
    schemaVersion: 1,
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
    ...input,
    observedAt: Date.now(),
  };
  return await host.ctx.storage.transaction(async (txn) => {
    const [current, terminal, pendingTerminal, pendingSuspension, existing] =
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
};

/**
 * The two broker targets the BuildSession answers itself.
 *
 * `/api/cloud/events` and `/api/cloud/messages` are still the paths the
 * sandbox knows — that contract is stable and versioned with the executor —
 * but their destination moved here: the event stream is projected through
 * the outbox with an ordinal this object assigns, and the transcript is
 * committed to this thread's own table. Both are idempotent, which is what
 * lets the executor's unchanged single retry stay safe.
 */
const handleBrokerLocalRequest = async (
  host: TurnBrokerHost,
  turn: TurnRequest,
  target: TurnBrokerTarget,
  decoded: unknown,
  signal: AbortSignal,
): Promise<Response> => {
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return brokerFailure(400);
  }
  const body = decoded as Record<string, unknown>;
  if (typeof body.turnId !== "string" || body.turnId !== turn.turnId) {
    return brokerFailure(403);
  }
  try {
    if (target.kind === "turn-event") {
      if (
        body.attemptGeneration !== undefined &&
        body.attemptGeneration !== turn.attemptGeneration
      ) {
        return brokerFailure(403);
      }
      if (typeof body.kind !== "string" || !body.kind.trim()) {
        return brokerFailure(400);
      }
      const seq = body.seq;
      if (
        seq !== "auto" &&
        (!Number.isSafeInteger(seq) || (seq as number) < 1)
      ) {
        return brokerFailure(400);
      }
      // A sandbox never decides a turn is over: terminal state is the
      // Durable Object's one decision, taken in `deliverTerminal`.
      if (body.terminal === true) return brokerFailure(403);
      await host.emitTurnEvent(turn, body.kind, body.payload, {
        ...(seq === "auto" ? {} : { eventSeq: seq as number }),
        signal,
      });
      return Response.json(
        { ok: true },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (
      typeof body.conversationId !== "string" ||
      body.conversationId !== turn.threadId ||
      !Array.isArray(body.messages)
    ) {
      return brokerFailure(400);
    }
    await host.assertTurnWritable(turn);
    signal.throwIfAborted();
    await host.appendThreadTranscript(
      turn,
      body.messages as ThreadMessageInput[],
    );
    return Response.json(
      { ok: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ThreadTranscriptError) {
      return brokerFailure(400);
    }
    if (
      error instanceof OwnerPurgeFenceError ||
      error instanceof AgentTurnAuthorityLostError
    ) {
      return brokerFailure(410);
    }
    log("error", "turn_broker_local_failed", {
      turnId: turn.turnId,
      targetKind: target.kind,
      message: errorMessage(error),
    });
    return brokerFailure(signal.aborted ? 410 : 502);
  }
};

export const handleTurnBroker = async (
  host: TurnBrokerHost,
  request: Request,
): Promise<Response> => {
  const turn = await host.ctx.storage.get<TurnRequest>("turn");
  if (
    !turn ||
    turn.kind !== "agent" ||
    !turn.threadId ||
    !turn.turnBrokerRoute ||
    !Number.isSafeInteger(turn.attemptGeneration)
  ) {
    return brokerFailure(401);
  }
  const recordKey = turnBrokerStorageKey({
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
  });
  const initialRecord = await host.ctx.storage.get<TurnBrokerRecord>(recordKey);
  if (!initialRecord) return brokerFailure(401);

  const preflight = await preflightTurnBrokerRequest({
    record: initialRecord,
    headers: request.headers,
    now: Date.now(),
  });
  if (!preflight.ok) return turnBrokerDenialResponse(preflight);
  if (request.method !== preflight.target.method) {
    return brokerFailure(403);
  }
  const brokerEngine = turn.execution?.engine;
  if (
    (brokerEngine !== "stella" &&
      brokerEngine !== "anthropic" &&
      brokerEngine !== "openai-codex") ||
    !turnBrokerTargetMatchesEngine(preflight.target, brokerEngine)
  ) {
    return brokerFailure(403);
  }

  let body: Uint8Array;
  try {
    body = await readTurnBrokerRequestBody(
      request,
      preflight.target.maxBodyBytes,
    );
  } catch (error) {
    if (error instanceof TurnBrokerBodyTooLargeError) {
      return brokerFailure(413);
    }
    return brokerFailure(400);
  }
  const requestFingerprint = await sha256BytesHex(body);

  try {
    await host.assertTurnWritable(turn);
    host.assertAgentTurnIdentity(turn);
  } catch {
    return brokerFailure(410);
  }

  const operationKey = turnStateCheckpointOperationKey(preflight.requestId);
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    ) as unknown;
  } catch {
    decoded = undefined;
  }
  const payload = parseTurnStateCheckpointRequest(decoded);
  const interiorRequest = parseInteriorBuildRequest(decoded);

  const admission = await host.ctx.blockConcurrencyWhile(async () => {
    const [
      current,
      storedRecord,
      terminal,
      cancellation,
      sandboxId,
      computePlan,
      computeRecord,
      baseWorkspaceRevision,
    ] = await Promise.all([
      host.ctx.storage.get<TurnRequest>("turn"),
      host.ctx.storage.get<TurnBrokerRecord>(recordKey),
      host.ctx.storage.get<boolean>("terminal"),
      host.exactTurnCancellations.matching({
        turnId: turn.turnId,
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        attemptGeneration: turn.attemptGeneration,
      }),
      host.ctx.storage.get<string>("sandboxId"),
      host.ctx.storage.get(
        turnComputePlanKey(turn.turnId, turn.attemptGeneration!),
      ),
      host.ctx.storage.get(
        agentComputeKey(turn.turnId, turn.attemptGeneration!),
      ),
      host.ctx.storage.get<number>(
        turnStateBaseWorkspaceRevisionKey(turn.turnId, turn.attemptGeneration!),
      ),
    ]);
    if (!storedRecord) return { kind: "missing" as const };
    if (
      !Number.isSafeInteger(baseWorkspaceRevision) ||
      baseWorkspaceRevision! < 0
    ) {
      return { kind: "missing-base" as const };
    }
    const running = host.agentTurnExecutions.get(turn.turnId);
    const identity = {
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
    };
    // A ladder turn's container is described by the compute record, which is
    // scoped to this exact attempt. The bare `sandboxId` key is not: a
    // predecessor attempt's leftover value would read as a live container
    // this attempt never reserved. Native turns keep reading that key, so
    // their fence is unchanged.
    const laddered =
      parseTurnComputePlan(computePlan, identity)?.plan.kind ===
      "resident_stella";
    const attachedSandbox = laddered
      ? parsePersistedAgentCompute(computeRecord, identity)?.sandboxId
      : sandboxId;
    const live: TurnBrokerLiveFence = {
      sessionId: turn.turnBrokerRoute!.sessionId,
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      active:
        exactTurnIdentityMatches(current, turn) &&
        Boolean(attachedSandbox) &&
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
    if (claimed.target.kind === "interior-build-request") {
      if (!interiorRequest) return { kind: "malformed" as const };
      await host.ctx.storage.put({
        [recordKey]: claimed.record,
        [interiorBuildRequestKey(turn.turnId, turn.attemptGeneration!)]:
          interiorBuildRequestRecord({
            request: interiorRequest,
            turnId: turn.turnId,
            attemptGeneration: turn.attemptGeneration!,
            now: Date.now(),
          }),
      });
      return { kind: "interior-build-request" as const };
    }
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
          await host.ctx.storage.get<TurnStateCheckpointOperation>(
            operationKey,
          ),
      };
    }
    if (
      claimed.target.kind === "turn-event" ||
      claimed.target.kind === "thread-messages"
    ) {
      // The turn's events and its thread transcript are this object's own
      // state now. The sandbox still asks for them by their old Convex
      // paths — that is the executor's stable contract — but the request
      // stops here instead of crossing to the control plane.
      await host.ctx.storage.put(recordKey, claimed.record);
      return {
        kind: "local" as const,
        target: claimed.target,
        signal: running!.signal,
      };
    }
    if (claimed.target.kind !== "builder-callback") {
      await host.ctx.storage.put(recordKey, claimed.record);
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
    await host.ctx.storage.put({
      [recordKey]: claimed.record,
      [operationKey]: operation,
    });
    return { kind: "checkpoint" as const, operation };
  });

  if (admission.kind === "missing") return brokerFailure(401);
  if (admission.kind === "missing-base") return brokerFailure(409);
  if (admission.kind === "denied") {
    return turnBrokerDenialResponse(admission.claimed);
  }
  if (admission.kind === "malformed") return brokerFailure(400);
  if (admission.kind === "local") {
    return await handleBrokerLocalRequest(
      host,
      turn,
      admission.target,
      decoded,
      admission.signal,
    );
  }
  if (admission.kind === "interior-build-request") {
    return Response.json(
      {
        schemaVersion: 1,
        requested: true,
      } satisfies TurnBrokerInteriorBuildRequestReceipt,
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (admission.kind === "forward") {
    if (admission.target.kind === "browser-gateway") {
      if (!host.env.BROWSER_GATEWAY) return brokerFailure(503);
      const command = decoded;
      if (!command || typeof command !== "object" || Array.isArray(command)) {
        return brokerFailure(400);
      }
      try {
        const upstream = await host.env.BROWSER_GATEWAY.fetch(
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
          return brokerFailure(502);
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
          (responsePayload as Record<string, unknown>).outcome === "suspended"
        ) {
          const responseRecord = responsePayload as Record<string, unknown>;
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
            return brokerFailure(502);
          }
          const disposition = await observeBrowserGatewaySuspension(
            host,
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
            return brokerFailure(409);
          }
          if (disposition === "inactive") {
            return brokerFailure(410);
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
        return brokerFailure(admission.signal.aborted ? 410 : 502);
      }
    }
    const convexOrigin = host.env.STELLA_CONVEX_SITE_URL?.trim();
    if (!convexOrigin) return brokerFailure(503);
    try {
      const upstream = await forwardTurnBrokerRequest({
        target: admission.target,
        body,
        incomingHeaders: request.headers,
        convexOrigin,
        controlPlaneCapability: await host.controlPlaneCapability(turn),
        signal: admission.signal,
      });
      return upstream;
    } catch {
      log("error", "turn_broker_forward_failed", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        targetKind: admission.target.kind,
        aborted: admission.signal.aborted,
        errorCode: "TURN_BROKER_UPSTREAM_FAILURE",
      });
      return brokerFailure(admission.signal.aborted ? 410 : 502);
    }
  }
  let pendingOperation: Extract<
    TurnStateCheckpointOperation,
    { state: "pending" }
  >;
  if (admission.kind === "replay") {
    const operation = admission.operation;
    if (operation?.state === "succeeded") {
      return Response.json(operation.receipt, {
        headers: { "cache-control": "no-store" },
      });
    }
    if (operation?.state === "failed") {
      return brokerFailure(operation.status);
    }
    if (!operation || operation.state !== "pending") {
      return brokerFailure(409);
    }
    pendingOperation = operation;
  } else {
    pendingOperation = admission.operation;
  }
  const failOperation = async (status: number): Promise<Response> => {
    await host.ctx.storage.transaction(async (transaction) => {
      const current =
        await transaction.get<TurnStateCheckpointOperation>(operationKey);
      if (
        current?.state === "pending" &&
        current.turnId === pendingOperation.turnId &&
        current.attemptGeneration === pendingOperation.attemptGeneration &&
        current.requestId === pendingOperation.requestId &&
        current.requestFingerprint === pendingOperation.requestFingerprint &&
        current.createdAt === pendingOperation.createdAt &&
        current.baseWorkspaceRevision === pendingOperation.baseWorkspaceRevision
      ) {
        await transaction.put(operationKey, {
          ...current,
          state: "failed",
          status,
        } satisfies TurnStateCheckpointOperation);
      }
    });
    return brokerFailure(status);
  };

  if (!payload) return await failOperation(400);
  if (
    (turn.execution?.engine === "anthropic") !==
    Boolean(payload.nativeCheckpoint)
  ) {
    return await failOperation(403);
  }
  if (payload.nativeCheckpoint) {
    const integrityKey = await nativeStateIntegrityKeyFor(host.env, turn);
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
    await host.ctx.storage.put(operationKey, exactOperation);
  } else if (
    JSON.stringify(pendingOperation.payload) !== JSON.stringify(payload)
  ) {
    return await failOperation(409);
  }

  let run = host.turnStateCheckpointRuns.get(operationKey);
  if (!run) {
    run = host.executeTurnStateCheckpoint({
      turn,
      operationKey,
      operation: exactOperation,
    });
    host.turnStateCheckpointRuns.set(operationKey, run);
    void run
      .finally(() => {
        if (host.turnStateCheckpointRuns.get(operationKey) === run) {
          host.turnStateCheckpointRuns.delete(operationKey);
        }
      })
      .catch(() => undefined);
  }
  try {
    const receipt = await run;
    return Response.json(receipt, {
      headers: { "cache-control": "no-store" },
    });
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
    return brokerCheckpointPending();
  }
};
