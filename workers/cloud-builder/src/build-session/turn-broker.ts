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
  nativeHistoryCursorFromRows,
  validNativeStateCheckpointMac,
} from "../native-state-checkpoint.js";
import { ThreadTranscriptError } from "../thread-transcript.js";
import type { ThreadMessageInput } from "../thread-transcript.js";
import {
  TurnBrokerBodyTooLargeError,
  claimTurnBrokerRequest,
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
  TurnStateRegistryBookkeepingError,
  isTurnStateAuthorityError,
} from "./shared/errors.js";
import {
  OBSERVED_BROWSER_SUSPENSION_KEY,
  PENDING_BROWSER_SUSPENSION_KEY,
  callOrchestratorCliTurnRoute,
  canonicalToolCallId,
  cloudBrowserSuspensionMarker,
  errorMessage,
  exactTurnIdentityMatches,
  log,
  nativeStateIntegrityKeyFor,
  nativeStateThreadHash,
  sessionName,
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
import {
  CLOUD_CLI_TURN_DO_PATHS,
  type CloudCliTurnEventsForward,
  type CloudCliTurnIdentity,
  type CloudCliTurnToolForward,
} from "@stella/contracts/cloud-orchestrator-cli";
import type { CloudBrowserSuspension } from "@stella/contracts/cloud-browser";
import { TURN_BROKER_RESPONSE_HEADERS } from "@stella/contracts/turn-credential-broker";
import { rpcErrorStatus, type RpcResponse } from "@stella/contracts/backend/protocol";
import { TURN_BROKER_DRIVE_PATHS } from "../turn-credential-broker.js";
import type { DriveTurnFilesResult } from "../owner-store/domains/drive.js";
import type {
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
  | "currentSandbox"
  | "emitTurnEvent"
  | "executeTurnStateCheckpoint"
>;

/** Local copy of the artifact digest shape; see `app-build-artifacts.ts`. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** @see src/build-session/shared/keys.ts */
export { turnBrokerCredentialsPath } from "./shared/keys.js";

/** Room for a full-page screenshot or a large evaluate/response-body result. */
const BROWSER_GATEWAY_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

const registryBookkeepingAfterCheckpoint = async <T>(
  historyCursor: string,
  manifestId: string | undefined,
  operation: () => Promise<T>,
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof AgentTurnAuthorityLostError ||
      error instanceof OwnerPurgeFenceError ||
      isTurnStateAuthorityError(error)
    ) {
      throw error;
    }
    throw new TurnStateRegistryBookkeepingError(
      historyCursor,
      manifestId,
      error,
    );
  }
};

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
    typeof resolved.threadRegistryPresent !== "boolean" ||
    typeof resolved.confirmationRequired !== "boolean" ||
    (!resolved.registryPresent &&
      (resolved.workspace !== undefined ||
        resolved.restore !== undefined ||
        resolved.threadRegistryPresent ||
        resolved.confirmationRequired)) ||
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
    (!/^[0-9a-f]{64}$/u.test(workspaceHead.manifestId) ||
      !/^(?:v1:empty|v1:[0-9a-f]{64})$/u.test(workspaceHead.historyCursor))
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
): Promise<TurnStateWorkspaceHead | undefined> => {
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
    !published ||
    // The orchestrator's native-only operation publishes no head.
    (turn.agentRole === "orchestrator"
      ? head !== undefined
      : !head ||
        head.historyCursor !== canonicalHistoryCursor ||
        !/^[0-9a-f]{64}$/u.test(head.manifestId)) ||
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
  threadCandidate: TurnStateCandidate | undefined,
  threadConfirmationRequired: boolean,
): Promise<void> => {
  if (threadConfirmationRequired) {
    const confirmed = await host.callOwnerTurnState<{
      thread?: {
        restore?: TurnStateCandidate;
        promoted?: unknown;
        replayed?: unknown;
      };
      confirmationReceipt?: unknown;
    }>(turn, "confirm-restore", {
      threadId: turn.threadId,
      canonicalHistoryCursor,
      ...(threadConfirmationRequired && threadCandidate
        ? { threadOperationId: threadCandidate.operationId }
        : {}),
    });
    if (
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
        ...(turn.agentRole === "orchestrator"
          ? { nativeOnly: true as const }
          : {}),
        createdAt: operation.createdAt,
        ...(operation.payload.nativeCheckpoint
          ? { nativeCheckpoint: operation.payload.nativeCheckpoint }
          : {}),
      },
    );
    if (!prepared || !/^[0-9a-f]{64}$/u.test(prepared.operationId)) {
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
  // The orchestrator's CLI thread never has the world on disk, so its
  // checkpoint is native state only: it never seals the shared world, names
  // no manifest, and its publication never creates or moves the owner's
  // workspace head. A head is what tells the next agent turn its workspace
  // is a restored checkpoint, so one seeded here would send that agent's
  // Drive hydration into a world that never held a drive ledger.
  const nativeOnly = turn.agentRole === "orchestrator";
  const manifestId = nativeOnly
    ? undefined
    : (
        await host.env.WORLDS.getByName(
          await worldName(turn.ownerId),
        ).checkpoint({ historyCursor: operation.payload.historyCursor })
      ).manifestId;

  const prepared = await registryBookkeepingAfterCheckpoint(
    operation.payload.historyCursor,
    manifestId,
    async () =>
      await host.callOwnerTurnState<PreparedTurnStateOperation>(
        turn,
        "prepare",
        {
          threadId: turn.threadId,
          attemptGeneration: turn.attemptGeneration,
          requestFingerprint: operation.requestFingerprint,
          historyCursor: operation.payload.historyCursor,
          ...(nativeOnly ? { nativeOnly: true } : { manifestId }),
          createdAt: operation.createdAt,
          ...(operation.payload.nativeCheckpoint
            ? { nativeCheckpoint: operation.payload.nativeCheckpoint }
            : {}),
        },
      ),
  );
  if (
    !prepared ||
    !/^[0-9a-f]{64}$/u.test(prepared.operationId) ||
    prepared.manifestId !== manifestId ||
    (operation.payload.nativeCheckpoint
      ? typeof prepared.objectKeys.native !== "string"
      : prepared.objectKeys.native !== undefined)
  ) {
    throw new TurnStateRegistryBookkeepingError(
      operation.payload.historyCursor,
      manifestId,
      new Error("Turn state preparation receipt was invalid."),
    );
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
        target: {
          kind: "native",
          threadHash: await nativeStateThreadHash(turn),
        },
      });
      await host.assertTurnWritable(turn);
      host.assertAgentTurnIdentity(turn);
      const archive = nativeUpload.archive;
      await registryBookkeepingAfterCheckpoint(
        operation.payload.historyCursor,
        manifestId,
        async () =>
          await host.callOwnerTurnState(turn, "mark-uploaded", {
            operationId: prepared.operationId,
            archive,
          }),
      );
    }

    await host.assertTurnWritable(turn);
    host.assertAgentTurnIdentity(turn);
    const committed = await registryBookkeepingAfterCheckpoint(
      operation.payload.historyCursor,
      manifestId,
      async () =>
        await host.callOwnerTurnState<{
          candidate: TurnStateCandidate;
          workspaceHead?: TurnStateWorkspaceHead;
          replayed: boolean;
        }>(turn, "commit", { operationId: prepared.operationId }),
    );
    const candidate = committed?.candidate;
    const workspaceHead = committed?.workspaceHead;
    if (
      !candidate ||
      candidate.schemaVersion !== 1 ||
      candidate.operationId !== prepared.operationId ||
      candidate.requestFingerprint !== operation.requestFingerprint ||
      candidate.historyCursor !== operation.payload.historyCursor ||
      candidate.createdAt !== operation.createdAt ||
      !/^[0-9a-f]{64}$/u.test(candidate.receipt) ||
      (manifestId === undefined
        ? candidate.workspace !== undefined || workspaceHead !== undefined
        : candidate.workspace?.historyCursor !==
            operation.payload.historyCursor ||
          candidate.workspace.manifestId !== manifestId ||
          workspaceHead?.historyCursor !== operation.payload.historyCursor ||
          workspaceHead.manifestId !== manifestId) ||
      JSON.stringify(candidate.native) !==
        JSON.stringify(nativeUpload?.archive) ||
      JSON.stringify(candidate.nativeCheckpoint) !==
        JSON.stringify(operation.payload.nativeCheckpoint)
    ) {
      throw new TurnStateRegistryBookkeepingError(
        operation.payload.historyCursor,
        manifestId,
        new Error("Turn state commit receipt was invalid."),
      );
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
  host: Pick<TurnBrokerHost, "ctx">,
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

export type ForwardedBrowserGatewayCommand =
  | Readonly<{ kind: "failure"; status: number }>
  | Readonly<{
      kind: "forwarded";
      status: number;
      statusText: string;
      headers: Headers;
      body: Uint8Array;
    }>;

/**
 * One turn command to the Browser Gateway under this turn's exact authority.
 *
 * Both requesters come through here: the container executor's broker route
 * and a resident turn's `browser` global. A suspended response is recorded as
 * an observation before anyone sees it, so the takeover it describes can only
 * become user-visible once the canonical transcript binds it to the outer
 * Code call (`bindObservedBrowserSuspensionToCanonicalCodeCall`).
 */
export const forwardBrowserGatewayCommand = async (
  host: Pick<TurnBrokerHost, "ctx" | "env">,
  turn: TurnRequest,
  args: {
    command: unknown;
    signal: AbortSignal;
    /** Idempotency identity of whoever asked: a broker request, or the command itself. */
    brokerRequestId: string;
    requestFingerprint: string;
  },
): Promise<ForwardedBrowserGatewayCommand> => {
  const failure = (status: number) => ({ kind: "failure", status }) as const;
  if (!host.env.BROWSER_GATEWAY) return failure(503);
  const command = args.command;
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return failure(400);
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
        signal: args.signal,
        redirect: "manual",
      },
    );
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => undefined);
      return failure(502);
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
        return failure(502);
      }
      const disposition = await observeBrowserGatewaySuspension(host, turn, {
        brokerRequestId: args.brokerRequestId,
        requestBodySha256: args.requestFingerprint,
        responseBodySha256: await sha256BytesHex(upstreamBody),
        suspension,
      });
      if (disposition === "conflict") {
        log("error", "browser_suspension_observation_conflict", {
          turnId: turn.turnId,
          threadId: turn.threadId,
        });
        return failure(409);
      }
      if (disposition === "inactive") {
        return failure(410);
      }
    }
    return {
      kind: "forwarded",
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
      body: upstreamBody,
    };
  } catch {
    log("error", "turn_broker_browser_gateway_failed", {
      turnId: turn.turnId,
      aborted: args.signal.aborted,
      errorCode: "BROWSER_GATEWAY_UPSTREAM_FAILURE",
    });
    return failure(args.signal.aborted ? 410 : 502);
  }
};

const driveJson = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * A turn's drive request, served by the owner's object under the turn's own
 * identity and owner generation. The sandbox still sends the paths and bodies
 * the old control-plane routes took, and gets their answers: 200 with the result, 413
 * when a write landed nothing (with the per-file reasons), and the owner
 * object's error status otherwise.
 *
 * Only an agent turn hydrates the drive into its workspace, which is what
 * lets a write report that it replaced a file it never opened.
 */
export const serveTurnDriveRequest = async (
  env: Pick<Cloudflare.Env, "OWNER_GATES">,
  turn: Pick<TurnRequest, "ownerId" | "ownerGeneration" | "turnId" | "kind">,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> => {
  const write = path === TURN_BROKER_DRIVE_PATHS.files;
  if (!write && path !== TURN_BROKER_DRIVE_PATHS.sync) return brokerFailure(403);
  const response = (await env.OWNER_GATES.getByName(turn.ownerId).ownerInternal({
    name: write ? "drive.turnFiles" : "drive.turnSync",
    args: write
      ? {
          turnId: turn.turnId,
          hydratesDrive: turn.kind === "agent",
          source: body.source,
          batchKey: body.batchKey,
          files: body.files,
        }
      : {
          turnId: turn.turnId,
          include: body.include,
          since: body.since,
          have: body.have,
        },
    ownerGeneration: turn.ownerGeneration,
  })) as RpcResponse;
  if (!response.ok) {
    return driveJson(
      { error: response.error.message },
      rpcErrorStatus(response.error.code),
    );
  }
  if (write) {
    const result = response.value as DriveTurnFilesResult;
    if (result.files.length === 0 && result.skipped.length > 0) {
      return driveJson(
        {
          error: result.skipped[0]!.reason,
          skipped: result.skipped,
          renamed: result.renamed,
          files: [],
        },
        413,
      );
    }
  }
  return driveJson({ ok: true, ...(response.value as Record<string, unknown>) });
};

/**
 * A turn's web search, run and charged by the owner's object. The sandbox
 * sends `{query, category?}` and gets `{text, results}` back.
 */
export const serveTurnSearchRequest = async (
  env: Pick<Cloudflare.Env, "OWNER_GATES">,
  turn: Pick<TurnRequest, "ownerId" | "ownerGeneration">,
  body: Record<string, unknown>,
): Promise<Response> => {
  const response = (await env.OWNER_GATES.getByName(turn.ownerId).ownerInternal({
    name: "search.web",
    args: {
      query: body.query,
      ...(body.category !== undefined && body.category !== null
        ? { category: body.category }
        : {}),
    },
    ownerGeneration: turn.ownerGeneration,
  })) as RpcResponse;
  if (!response.ok) {
    return driveJson({ error: response.error.message }, rpcErrorStatus(response.error.code));
  }
  return driveJson(response.value);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Last event batch the conversation acknowledged, per exact attempt. */
const orchestratorEventBatchSeqKey = (turn: TurnRequest): string =>
  `orchestratorEventBatchSeq:${turn.turnId}:${turn.attemptGeneration}`;

/**
 * A conversation that could not take the frame right now. Not a broker
 * denial: the executor keeps its credential and may send again.
 */
const orchestratorUnavailable = (): Response =>
  Response.json(
    { error: "The conversation is unavailable. Try again." },
    { status: 503, headers: { "cache-control": "no-store" } },
  );

/**
 * The orchestrator CLI turn's two broker targets: a tool call the CLI made
 * through the executor's MCP host, and a batch of its stream events. Both
 * go to the conversation's OrchestratorSession, which owns the tools and the
 * journal. The identity on the forwarded frame is this session's own: the
 * stored turn whose exact attempt the claim's live fence just proved is
 * running. Nothing the executor sent names the turn.
 *
 * A conversation that answers 4xx no longer runs this attempt (or refused
 * the frame outright), so the broker is denied and the executor stops; a
 * 5xx, an edit lock or an unreachable object is answered 503 without the
 * denial, so the executor can retry (the DO de-duplicates tool calls by
 * `toolCallId` and batches by `batchSeq`).
 */
const forwardOrchestratorBrokerRequest = async (
  host: TurnBrokerHost,
  turn: TurnRequest,
  target: TurnBrokerTarget,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> => {
  if (!turn.conversationId || !turn.threadId) return brokerFailure(410);
  const identity: CloudCliTurnIdentity = {
    conversationId: turn.conversationId,
    threadId: turn.threadId,
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
  };
  let path: string;
  let forwarded: CloudCliTurnToolForward | CloudCliTurnEventsForward;
  let batchSeq: number | undefined;
  if (target.kind === "orchestrator-tool") {
    const { toolCallId, name, args } = body;
    if (
      typeof toolCallId !== "string" ||
      !toolCallId ||
      toolCallId.length > 256 ||
      typeof name !== "string" ||
      !name ||
      name.length > 128 ||
      !isRecord(args)
    ) {
      return brokerFailure(400);
    }
    path = CLOUD_CLI_TURN_DO_PATHS.tool;
    forwarded = { ...identity, toolCallId, name, args };
  } else {
    const seq = body.batchSeq;
    if (
      typeof seq !== "number" ||
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      !Array.isArray(body.events)
    ) {
      return brokerFailure(400);
    }
    // Batches are applied strictly in order. A replay of an acknowledged one
    // still goes through (the conversation acks it again); a gap never does.
    const acknowledged =
      (await host.ctx.storage.get<number>(orchestratorEventBatchSeqKey(turn))) ??
      0;
    if (seq > acknowledged + 1) return brokerFailure(409);
    batchSeq = seq;
    path = CLOUD_CLI_TURN_DO_PATHS.events;
    forwarded = {
      ...identity,
      batchSeq: seq,
      events: body.events as CloudCliTurnEventsForward["events"],
    };
  }
  let response: Response;
  try {
    response = await callOrchestratorCliTurnRoute(
      host.env,
      turn,
      path,
      forwarded,
      signal,
    );
  } catch (error) {
    if (signal.aborted) return brokerFailure(410);
    log("error", "orchestrator_cli_forward_failed", {
      turnId: turn.turnId,
      targetKind: target.kind,
      message: errorMessage(error),
    });
    return orchestratorUnavailable();
  }
  const text = await response.text().catch(() => "");
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    decoded = undefined;
  }
  if (!response.ok) {
    const editLocked =
      isRecord(decoded) && decoded.code === "conversation_edit_in_progress";
    if (response.status >= 500 || response.status === 429 || editLocked) {
      return orchestratorUnavailable();
    }
    log("info", "orchestrator_cli_forward_refused", {
      turnId: turn.turnId,
      targetKind: target.kind,
      status: response.status,
    });
    return brokerFailure(410);
  }
  if (target.kind === "orchestrator-tool") {
    // `CloudOrchestratorToolCallResponse`: both arms are HTTP 200.
    if (!isRecord(decoded) || typeof decoded.ok !== "boolean") {
      return orchestratorUnavailable();
    }
    return Response.json(decoded, {
      headers: { "cache-control": "no-store" },
    });
  }
  if (batchSeq !== undefined) {
    const key = orchestratorEventBatchSeqKey(turn);
    await host.ctx.storage.transaction(async (txn) => {
      if ((((await txn.get<number>(key)) ?? 0) as number) < batchSeq!) {
        await txn.put(key, batchSeq!);
      }
    });
  }
  return Response.json(isRecord(decoded) ? decoded : { ok: true }, {
    headers: { "cache-control": "no-store" },
  });
};

/**
 * The broker targets the BuildSession answers itself.
 *
 * `/api/cloud/events` and `/api/cloud/messages` are still the paths the
 * sandbox knows — that contract is stable and versioned with the executor —
 * but their destination moved here: the event stream gets an ordinal this
 * object assigns and the owner reads what it indexes, and the transcript is
 * committed to this thread's own table. Both are idempotent, which is what
 * lets the executor's unchanged single retry stay safe. The drive paths and
 * web search go to the owner's object (see `serveTurnDriveRequest` and
 * `serveTurnSearchRequest`); the claim's live fence already proved this
 * exact attempt is running.
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
  try {
    // The claim's live fence already bound this request to the turn; a
    // search body names only its query.
    if (target.kind === "search") {
      return await serveTurnSearchRequest(host.env, turn, body);
    }
    if (
      target.kind === "orchestrator-tool" ||
      target.kind === "orchestrator-events"
    ) {
      return await forwardOrchestratorBrokerRequest(
        host,
        turn,
        target,
        body,
        signal,
      );
    }
    if (typeof body.turnId !== "string" || body.turnId !== turn.turnId) {
      return brokerFailure(403);
    }
    if (target.kind === "drive") {
      return await serveTurnDriveRequest(host.env, turn, target.path, body);
    }
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
      brokerEngine !== "chatgpt") ||
    !turnBrokerTargetMatchesEngine(preflight.target, brokerEngine)
  ) {
    return brokerFailure(403);
  }
  // The conversation's tools and journal answer only its own CLI turn.
  if (
    (preflight.target.kind === "orchestrator-tool" ||
      preflight.target.kind === "orchestrator-events") &&
    turn.agentRole !== "orchestrator"
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

  const admission = await host.ctx.blockConcurrencyWhile(async () => {
    const [
      current,
      storedRecord,
      terminal,
      cancellation,
      sandboxId,
      computePlan,
      computeRecord,
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
    ]);
    if (!storedRecord) return { kind: "missing" as const };
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
      claimed.target.kind === "thread-messages" ||
      claimed.target.kind === "drive" ||
      claimed.target.kind === "search" ||
      claimed.target.kind === "orchestrator-tool" ||
      claimed.target.kind === "orchestrator-events"
    ) {
      // The turn's events and its thread transcript are this object's own
      // state now, and the drive and web search are the owner object's. The
      // sandbox still asks for them by their old control-plane paths — that is the
      // executor's stable contract — but the request stops here instead of
      // crossing to the control plane.
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
      ...(payload ? { payload } : {}),
    };
    await host.ctx.storage.put({
      [recordKey]: claimed.record,
      [operationKey]: operation,
    });
    return { kind: "checkpoint" as const, operation };
  });

  if (admission.kind === "missing") return brokerFailure(401);
  if (admission.kind === "denied") {
    return turnBrokerDenialResponse(admission.claimed);
  }
  if (admission.kind === "local") {
    return await handleBrokerLocalRequest(
      host,
      turn,
      admission.target,
      decoded,
      admission.signal,
    );
  }
  if (admission.kind === "forward") {
    if (admission.target.kind === "browser-gateway") {
      const forwarded = await forwardBrowserGatewayCommand(host, turn, {
        command: decoded,
        signal: admission.signal,
        brokerRequestId: preflight.requestId,
        requestFingerprint,
      });
      if (forwarded.kind === "failure") return brokerFailure(forwarded.status);
      const responseHeaders = turnBrokerSandboxResponseHeaders(
        forwarded.headers,
      );
      // Fetch has decoded the buffered bytes. Do not make the sandbox
      // decode them a second time or trust an upstream framing length.
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      responseHeaders.delete("transfer-encoding");
      responseHeaders.set("cache-control", "no-store");
      return new Response(forwarded.body, {
        status: forwarded.status,
        statusText: forwarded.statusText,
        headers: responseHeaders,
      });
    }
    return brokerFailure(403);
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
        current.createdAt === pendingOperation.createdAt
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
