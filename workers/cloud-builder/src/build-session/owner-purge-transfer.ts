// Owner purge, owner→owner product transfer, and the world push/pull route.
//
// Cut verbatim out of `src/index.ts`. Nothing here touches the `BuildSession`
// Durable Object instance, so there is no host interface: these are the
// top-level collaborators that the worker router and a handful of class
// methods call with an explicit `env`.
import type { DirectoryBackup } from "@cloudflare/sandbox";
import { sha256Hex } from "../hash.js";
import {
  checkpointBackupName,
  checkpointKey,
  worldName,
} from "../workspace.js";
import {
  collectCheckpointRecoveryReferences,
  createOwnerTransferBudget,
  isValidOwnerTransferPrefixPair,
  missingOwnerProductTransferBinding,
  replaceOwnerPrefix,
  takeOwnerTransferBatch,
  transferredBackupId,
  type OwnerProductTransferRequest,
  type OwnerTransferBudget,
} from "../owner-product-transfer.js";
import {
  createCoordinatorAttempt,
  ownerTransferOperationId,
  stableValueMarker,
  type DurableTurnStateWorkspaceTransfer,
  type DurableWorkspaceTransferPlan,
  type OwnerTransferControl,
  type OwnerTransferReservationEnvelope,
  type WorkspacePlanObservation,
} from "../owner-transfer-coordinator.js";
import {
  TurnStateProductTransferConflictError,
  advanceDurableTurnStateWorkspaceTransfer,
} from "../turn-state-product-transfer.js";
import {
  isOwnerAppBuildPrefix,
  ownerAppBuildPrefix,
  ownerAppBuildRoot,
} from "../app-build-artifacts.js";
import {
  HEADER_OWNER_FENCE_ID,
  type OwnerPurgeFence,
  type OwnerPurgeMode,
} from "../owner-fence-do.js";
import type { CloudHomeLeaseRunner } from "../cloud-home-routes.js";
import type {
  TurnStateTransferActivationResponse,
  TurnStateTransferDestinationStatus,
  TurnStateTransferExportResponse,
  TurnStateTransferRetireResponse,
} from "../turn-state-owner-routes.js";
import {
  verifyWorldCapability,
  worldCapabilityFromRequest,
} from "../world-capability.js";
import type { WorldListingEntry } from "../world/types.js";
import {
  boundedBodyStatus,
  bufferBoundedJsonRequest,
} from "../request-ingress.js";
import {
  R2TransferTransformTooLargeError,
  r2TransferBody,
  type R2TransferTransform,
} from "../r2-transfer-body.js";
import {
  nativeStateBackupName,
  nativeStateCheckpointPrefix,
  parseNativeStateCheckpointRecord,
} from "../native-state-checkpoint.js";
import type { Env } from "./shared/env.js";
import type {
  OwnerPurgeReport,
  OwnerPurgeRequest,
  OwnerTransferCoordinatorContext,
  WorkspaceBackupDebt,
  WorkspaceCheckpointImports,
} from "./shared/types.js";
import {
  OwnerProductTransferConfigurationError,
  OwnerProductTransferConflictError,
  OwnerPurgeFenceError,
} from "./shared/errors.js";
import {
  backupDebtKey,
  checkpointImportsKey,
  contentType,
  errorMessage,
  json,
  log,
  nativeBackupDebtKey,
  workspaceTransferReceiptsKey,
  BACKUP_ID_PATTERN,
  R2_SWEEP_MAX_PAGES,
  sweepR2Prefix,
} from "./shared/keys.js";

const ownerFenceStub = (env: Env, ownerId: string) =>
  env.OWNER_GATES.getByName(ownerId);

export const callOwnerFence = async (
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

export const withOwnerActivityLease = async <T>(
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

export const cloudHomeLeaseRunner =
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

export const transferControl = (
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

export const createTransferCoordinatorContext = async (args: {
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

export const callTransferCoordinator = async (
  coordinator: OwnerTransferCoordinatorContext,
  path: string,
  body: Record<string, unknown> = {},
): Promise<Response> =>
  await coordinator.stub.fetch(`https://owner-transfer-coordinator${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attempt: coordinator.attempt, ...body }),
  });

export const parseTransferReservationEnvelope = (
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

export const yieldTransferCoordinator = async (
  coordinator: OwnerTransferCoordinatorContext,
): Promise<void> => {
  await callTransferCoordinator(coordinator, "/yield").catch(() => undefined);
};

export const abortTransferCoordinator = async (
  coordinator: OwnerTransferCoordinatorContext,
  permanent: boolean,
): Promise<void> => {
  await callTransferCoordinator(coordinator, "/abort", { permanent }).catch(
    () => undefined,
  );
};

export const beginOwnerPurge = async (
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

/** The slug a hosted app route is keyed by. */
export const APP_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/**
 * A caller-supplied R2 prefix is a bucket-wipe primitive, so it is matched
 * against the two shapes this worker writes rather than merely checked for
 * non-emptiness. The interior form embeds a one-way owner hash and a
 * content-derived build id, so another owner's prefix cannot be smuggled in
 * through a path segment.
 */
export const LEGACY_BUILD_PREFIX_PATTERN = /^builds\/[A-Za-z0-9_-]{1,64}$/;
export const INTERIOR_BUILD_PREFIX_PATTERN =
  /^interiors\/[0-9a-f]{64}\/interior-[0-9a-f]{48}$/;

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

export const transferOwnerProductStorage = async (
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

export const purgeOwnerStorage = async (
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

export const boundedIngressRequest = async (
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

export const handleWorldRoute = async (
  request: Request,
  env: Env,
  world: string,
  action:
    | { kind: "export" }
    | { kind: "changes" }
    | { kind: "blob"; sha256: string }
    | { kind: "push" },
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
  if (action.kind === "changes") {
    if (request.method !== "GET")
      return json({ error: "Method not allowed." }, 405);
    const since = Number(new URL(request.url).searchParams.get("since"));
    if (!Number.isSafeInteger(since) || since < 0) {
      return json({ error: "Malformed world revision." }, 400);
    }
    return json(await stub.changesSince(since));
  }
  if (action.kind === "blob") {
    if (request.method !== "GET")
      return json({ error: "Method not allowed." }, 405);
    const blob = await stub.exportBlob(action.sha256);
    if (!blob) return json({ error: "World blob was not found." }, 404);
    return new Response(blob.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(blob.size),
        "cache-control": "private, no-store",
      },
    });
  }
  if (action.kind === "export") {
    if (request.method !== "GET")
      return json({ error: "Method not allowed." }, 405);
    const requested = new URL(request.url).searchParams.get("manifest");
    const manifestId = requested ?? (await stub.head()).manifestId;
    if (!(await stub.manifest(manifestId, { limit: 1 }))) {
      return json({ error: "World manifest was not found." }, 404);
    }
    const exported = await stub.exportTar(manifestId);
    return new Response(exported.body, {
      headers: {
        "content-type": "application/x-tar",
        "cache-control": "private, no-store",
        "x-stella-world-manifest": manifestId,
        "x-stella-world-revision": String(exported.revision),
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
