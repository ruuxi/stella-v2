import { homeContextChanged } from "./lib/cloud_home_context_updates";
import { synchronizeMemoryPolicyChange } from "./lib/memory_policy_change";
import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { assertOwnerMigrationWriteAllowed, requireUserIdentity } from "./auth";
import {
  assertIdempotencyKey,
  assertOpaqueCloudHomeId,
} from "./lib/cloud_home_policy";
import {
  cloudMemoryImportDispositionValidator,
  cloudMemoryLifecycleStateValidator,
  cloudMemoryWipeStageValidator,
} from "./schema/cloud_agent_home";

export const LEGACY_MEMORY_EPOCH = "legacy";

const WIPE_JOB_LEASE_MS = 9 * 60_000;
const WIPE_RETRY_MAX_MS = 15 * 60_000;
const METADATA_BATCH_SIZE = 100;
const METADATA_STORE_COUNT = 3;
const MEMORY_WIPE_EXTERNAL_PROTOCOL_VERSION = 2;
const MEMORY_WIPE_EXTERNAL_TARGET_COUNT = 9;
const MEMORY_WIPE_EXTERNAL_PAGE_MAX = 250;
const MEMORY_WIPE_SCAN_CURSOR_MAX = 1_024;

type MemoryLifecycleState = "open" | "wiping";
type MemoryWipeStage = "sweeping" | "metadata" | "releasing" | "completed";
export type MemoryImportDisposition =
  | "automatic_allowed"
  | "explicit_required"
  | "explicit_allowed";

const runMemoryWipeRef = makeFunctionReference<
  "action",
  { ownerId: string; operationId: string },
  null
>("cloud_memory_lifecycle:runMemoryWipeInternal");

const readLifecycle = async (
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  ownerId: string,
) =>
  await ctx.db
    .query("cloud_memory_lifecycles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();

const readWipeJob = async (
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  ownerId: string,
) =>
  await ctx.db
    .query("cloud_memory_wipe_jobs")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();

const memoryWipeActiveError = () =>
  new ConvexError({
    code: "CLOUD_MEMORY_WIPE_ACTIVE",
    message: "Cloud memory is being permanently erased for this account.",
  });

const memoryEpochStaleError = () =>
  new ConvexError({
    code: "CLOUD_MEMORY_EPOCH_STALE",
    message: "This memory operation started before cloud memory was erased.",
  });

const validateEpoch = (value: string): string =>
  assertOpaqueCloudHomeId(value, "memory epoch");

const requireExpectedSubject = async (
  ctx: QueryCtx | MutationCtx | ActionCtx,
  expectedSubject: string,
) => {
  const identity = await requireUserIdentity(ctx);
  const expected = expectedSubject.trim();
  if (
    !expected ||
    expected !== expectedSubject ||
    expected.length > 1_024 ||
    expected !== identity.tokenIdentifier
  ) {
    throw new ConvexError({
      code: "SESSION_IDENTITY_MISMATCH",
      message: "The authenticated cloud session changed before this request.",
    });
  }
  return identity;
};

/**
 * Same-transaction memory fence used by every read/write plane. Querying the
 * lifecycle row also creates an OCC dependency against a concurrent wipe
 * begin, while `expectedEpoch` rejects delayed work after the next epoch opens.
 */
export const assertMemoryEpochOpen = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  ownerGeneration: string,
  expectedEpoch?: string,
): Promise<{ ownerGeneration: string; memoryEpoch: string }> => {
  const owner = await assertOwnerMigrationWriteAllowed(
    ctx,
    ownerId,
    ownerGeneration,
  );
  const lifecycle = await readLifecycle(ctx, ownerId);
  if (lifecycle && lifecycle.ownerGeneration !== owner.generation) {
    throw memoryEpochStaleError();
  }
  if (lifecycle?.state === "wiping") throw memoryWipeActiveError();
  const memoryEpoch = lifecycle?.epoch ?? LEGACY_MEMORY_EPOCH;
  if (
    expectedEpoch !== undefined &&
    validateEpoch(expectedEpoch) !== memoryEpoch
  ) {
    throw memoryEpochStaleError();
  }
  return { ownerGeneration: owner.generation, memoryEpoch };
};

/** Release/cleanup paths may run while wiping, but must still match the epoch. */
export const assertMemoryEpochCurrent = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  ownerGeneration: string,
  expectedEpoch: string,
): Promise<{ state: MemoryLifecycleState; memoryEpoch: string }> => {
  const owner = await assertOwnerMigrationWriteAllowed(
    ctx,
    ownerId,
    ownerGeneration,
  );
  const lifecycle = await readLifecycle(ctx, ownerId);
  if (lifecycle && lifecycle.ownerGeneration !== owner.generation) {
    throw memoryEpochStaleError();
  }
  const memoryEpoch = lifecycle?.epoch ?? LEGACY_MEMORY_EPOCH;
  if (validateEpoch(expectedEpoch) !== memoryEpoch)
    throw memoryEpochStaleError();
  return { state: lifecycle?.state ?? "open", memoryEpoch };
};

export const getMemoryImportDisposition = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  ownerGeneration: string,
  expectedEpoch?: string,
): Promise<{
  memoryEpoch: string;
  importDisposition: MemoryImportDisposition;
  lastWipedEpoch?: string;
}> => {
  const memory = await assertMemoryEpochOpen(
    ctx,
    ownerId,
    ownerGeneration,
    expectedEpoch,
  );
  const lifecycle = await readLifecycle(ctx, ownerId);
  return {
    memoryEpoch: memory.memoryEpoch,
    importDisposition:
      lifecycle?.importDisposition ?? ("automatic_allowed" as const),
    ...(lifecycle?.lastWipedEpoch
      ? { lastWipedEpoch: lifecycle.lastWipedEpoch }
      : {}),
  };
};

const wipeStatusValidator = v.object({
  subject: v.string(),
  ownerGeneration: v.string(),
  state: cloudMemoryLifecycleStateValidator,
  memoryEpoch: v.string(),
  importDisposition: cloudMemoryImportDispositionValidator,
  lastWipedEpoch: v.optional(v.string()),
  job: v.union(
    v.null(),
    v.object({
      operationId: v.string(),
      stage: cloudMemoryWipeStageValidator,
      attempts: v.number(),
      nextRetryAt: v.number(),
      lastErrorCode: v.optional(v.string()),
      objectsDeleted: v.number(),
      rowsDeleted: v.number(),
      completedAt: v.optional(v.number()),
      updatedAt: v.number(),
    }),
  ),
});

const publicStatus = (
  subject: string,
  ownerGeneration: string,
  lifecycle: Awaited<ReturnType<typeof readLifecycle>>,
  job: Awaited<ReturnType<typeof readWipeJob>>,
) => ({
  subject,
  ownerGeneration,
  state: lifecycle?.state ?? ("open" as const),
  memoryEpoch: lifecycle?.epoch ?? LEGACY_MEMORY_EPOCH,
  importDisposition:
    lifecycle?.importDisposition ?? ("automatic_allowed" as const),
  ...(lifecycle?.lastWipedEpoch
    ? { lastWipedEpoch: lifecycle.lastWipedEpoch }
    : {}),
  job: job
    ? {
        operationId: job.operationId,
        stage: job.stage,
        attempts: job.attempts,
        nextRetryAt: job.nextRetryAt,
        ...(job.lastErrorCode ? { lastErrorCode: job.lastErrorCode } : {}),
        objectsDeleted: job.objectsDeleted,
        rowsDeleted: job.rowsDeleted,
        ...(job.completedAt !== undefined
          ? { completedAt: job.completedAt }
          : {}),
        updatedAt: job.updatedAt,
      }
    : null,
});

const readMemoryWipeStatus = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  expectedOwnerGeneration?: string,
) => {
  const owner = await assertOwnerMigrationWriteAllowed(
    ctx,
    ownerId,
    expectedOwnerGeneration,
  );
  const [lifecycle, job] = await Promise.all([
    readLifecycle(ctx, ownerId),
    readWipeJob(ctx, ownerId),
  ]);
  if (lifecycle && lifecycle.ownerGeneration !== owner.generation) {
    throw memoryEpochStaleError();
  }
  return publicStatus(ownerId, owner.generation, lifecycle, job);
};

const startMemoryWipeForOwner = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    expectedOwnerGeneration: string;
    expectedMemoryEpoch: string;
    requestId: string;
  },
) => {
  const owner = await assertOwnerMigrationWriteAllowed(
    ctx,
    args.ownerId,
    args.expectedOwnerGeneration,
  );
  const requestId = assertIdempotencyKey(args.requestId);
  const expectedMemoryEpoch = validateEpoch(args.expectedMemoryEpoch);
  const [existingLifecycle, existingJob] = await Promise.all([
    readLifecycle(ctx, args.ownerId),
    readWipeJob(ctx, args.ownerId),
  ]);
  if (
    existingLifecycle &&
    existingLifecycle.ownerGeneration !== owner.generation
  ) {
    throw memoryEpochStaleError();
  }
  if (existingJob?.requestId === requestId) {
    if (existingJob.requestedEpoch !== expectedMemoryEpoch) {
      throw new ConvexError({
        code: "CLOUD_HOME_IDEMPOTENCY_CONFLICT",
        message: "That memory wipe request names a different memory epoch.",
      });
    }
    return publicStatus(
      args.ownerId,
      owner.generation,
      existingLifecycle,
      existingJob,
    );
  }
  if (existingLifecycle?.state === "wiping") throw memoryWipeActiveError();
  const currentEpoch = existingLifecycle?.epoch ?? LEGACY_MEMORY_EPOCH;
  if (currentEpoch !== expectedMemoryEpoch) throw memoryEpochStaleError();

  const now = Date.now();
  const operationId = `memorywipe-${crypto.randomUUID()}`;
  const nextEpoch = crypto.randomUUID();
  const lifecycleValues = {
    ownerId: args.ownerId,
    ownerGeneration: owner.generation,
    epoch: currentEpoch,
    state: "wiping" as const,
    operationId,
    updatedAt: now,
  };
  if (existingLifecycle) {
    await ctx.db.patch(existingLifecycle._id, lifecycleValues);
  } else {
    await ctx.db.insert("cloud_memory_lifecycles", {
      ...lifecycleValues,
      createdAt: now,
    });
  }
  const jobValues = {
    ownerId: args.ownerId,
    ownerGeneration: owner.generation,
    operationId,
    requestId,
    requestedEpoch: expectedMemoryEpoch,
    targetEpoch: currentEpoch,
    nextEpoch,
    stage: "sweeping" as const,
    externalGeneration: undefined,
    externalCursor: 0,
    externalStartAfter: undefined,
    metadataStoreIndex: 0,
    attempts: 0,
    nextRetryAt: now,
    leaseId: undefined,
    leaseExpiresAt: undefined,
    lastErrorCode: undefined,
    objectsDeleted: 0,
    rowsDeleted: 0,
    completedAt: undefined,
    updatedAt: now,
  };
  if (existingJob) await ctx.db.patch(existingJob._id, jobValues);
  else {
    await ctx.db.insert("cloud_memory_wipe_jobs", {
      ...jobValues,
      createdAt: now,
    });
  }
  await ctx.scheduler.runAfter(0, runMemoryWipeRef, {
    ownerId: args.ownerId,
    operationId,
  });
  return await readMemoryWipeStatus(ctx, args.ownerId, owner.generation);
};

export const getMyMemoryWipeStatus = query({
  args: { expectedSubject: v.string() },
  returns: wipeStatusValidator,
  handler: async (ctx, args) => {
    const identity = await requireExpectedSubject(ctx, args.expectedSubject);
    return await readMemoryWipeStatus(ctx, identity.tokenIdentifier);
  },
});

export const startMyMemoryWipe = action({
  args: {
    expectedOwnerGeneration: v.string(),
    expectedMemoryEpoch: v.string(),
    expectedSubject: v.string(),
    requestId: v.string(),
  },
  returns: wipeStatusValidator,
  handler: async (ctx, args) => {
    const identity = await requireExpectedSubject(ctx, args.expectedSubject);
    await synchronizeMemoryPolicyChange({
      kind: "wipe",
      ownerId: identity.tokenIdentifier,
      expectedOwnerGeneration: args.expectedOwnerGeneration,
      expectedMemoryEpoch: args.expectedMemoryEpoch,
      requestId: args.requestId,
    });
    return await ctx.runQuery(makeFunctionReference<"query", {
      ownerId: string; ownerGeneration: string;
    }, Awaited<ReturnType<typeof readMemoryWipeStatus>>>("cloud_memory_lifecycle:getMemoryWipeStatusInternal"), {
      ownerId: identity.tokenIdentifier, ownerGeneration: args.expectedOwnerGeneration,
    });
  },
});

export const getMemoryWipeStatusInternal = internalQuery({
  args: { ownerId: v.string(), ownerGeneration: v.string() },
  returns: wipeStatusValidator,
  handler: async (ctx, args) =>
    await readMemoryWipeStatus(ctx, args.ownerId, args.ownerGeneration),
});

export const assertMemoryEpochInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    memoryEpoch: v.string(),
  },
  returns: v.object({ memoryEpoch: v.string() }),
  handler: async (ctx, args) => {
    const memory = await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
      args.memoryEpoch,
    );
    return { memoryEpoch: memory.memoryEpoch };
  },
});

export const startMemoryWipeInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    expectedMemoryEpoch: v.string(),
    requestId: v.string(),
  },
  returns: wipeStatusValidator,
  handler: async (ctx, args) =>
    await startMemoryWipeForOwner(ctx, {
      ownerId: args.ownerId,
      expectedOwnerGeneration: args.ownerGeneration,
      expectedMemoryEpoch: args.expectedMemoryEpoch,
      requestId: args.requestId,
    }),
});

const authorizeMemoryReimportForOwner = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    expectedOwnerGeneration: string;
    expectedMemoryEpoch: string;
    requestId: string;
  },
) => {
  const requestId = assertIdempotencyKey(args.requestId);
  const importState = await getMemoryImportDisposition(
    ctx,
    args.ownerId,
    args.expectedOwnerGeneration,
    args.expectedMemoryEpoch,
  );
  const lifecycle = await readLifecycle(ctx, args.ownerId);
  if (!lifecycle || importState.importDisposition === "automatic_allowed") {
    throw new ConvexError({
      code: "CLOUD_MEMORY_REIMPORT_NOT_REQUIRED",
      message: "This memory epoch does not require a reimport confirmation.",
    });
  }
  if (importState.importDisposition === "explicit_required") {
    await ctx.db.patch(lifecycle._id, {
      importDisposition: "explicit_allowed",
      importAuthorizationRequestId: requestId,
      importAuthorizedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  return await readMemoryWipeStatus(
    ctx,
    args.ownerId,
    args.expectedOwnerGeneration,
  );
};

export const authorizeMyMemoryReimport = mutation({
  args: {
    expectedSubject: v.string(),
    expectedOwnerGeneration: v.string(),
    expectedMemoryEpoch: v.string(),
    requestId: v.string(),
  },
  returns: wipeStatusValidator,
  handler: async (ctx, args) => {
    const identity = await requireExpectedSubject(ctx, args.expectedSubject);
    return await authorizeMemoryReimportForOwner(ctx, {
      ownerId: identity.tokenIdentifier,
      expectedOwnerGeneration: args.expectedOwnerGeneration,
      expectedMemoryEpoch: args.expectedMemoryEpoch,
      requestId: args.requestId,
    });
  },
});

export const authorizeMemoryReimportInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    expectedMemoryEpoch: v.string(),
    requestId: v.string(),
  },
  returns: wipeStatusValidator,
  handler: async (ctx, args) =>
    await authorizeMemoryReimportForOwner(ctx, {
      ownerId: args.ownerId,
      expectedOwnerGeneration: args.ownerGeneration,
      expectedMemoryEpoch: args.expectedMemoryEpoch,
      requestId: args.requestId,
    }),
});

const claimedJobValidator = v.object({
  ownerId: v.string(),
  ownerGeneration: v.string(),
  operationId: v.string(),
  targetEpoch: v.string(),
  nextEpoch: v.string(),
  stage: cloudMemoryWipeStageValidator,
  externalGeneration: v.optional(v.string()),
  externalCursor: v.number(),
  externalStartAfter: v.optional(v.string()),
  metadataStoreIndex: v.number(),
  leaseId: v.string(),
  leaseExpiresAt: v.number(),
});

export const claimMemoryWipeJobInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    leaseId: v.string(),
    now: v.number(),
  },
  returns: v.union(v.null(), claimedJobValidator),
  handler: async (ctx, args) => {
    const [lifecycle, job] = await Promise.all([
      readLifecycle(ctx, args.ownerId),
      readWipeJob(ctx, args.ownerId),
    ]);
    if (
      !lifecycle ||
      lifecycle.state !== "wiping" ||
      lifecycle.operationId !== args.operationId ||
      !job ||
      job.operationId !== args.operationId ||
      job.stage === "completed"
    ) {
      return null;
    }
    if (
      job.leaseId &&
      job.leaseId !== args.leaseId &&
      (job.leaseExpiresAt ?? 0) > args.now
    ) {
      return null;
    }
    const leaseExpiresAt = args.now + WIPE_JOB_LEASE_MS;
    await ctx.db.patch(job._id, {
      leaseId: args.leaseId,
      leaseExpiresAt,
      attempts: job.attempts + 1,
      nextRetryAt: leaseExpiresAt,
      lastErrorCode: undefined,
      updatedAt: args.now,
    });
    return {
      ownerId: job.ownerId,
      ownerGeneration: job.ownerGeneration,
      operationId: job.operationId,
      targetEpoch: job.targetEpoch,
      nextEpoch: job.nextEpoch,
      stage: job.stage,
      ...(job.externalGeneration
        ? { externalGeneration: job.externalGeneration }
        : {}),
      externalCursor: job.externalCursor,
      ...(job.externalStartAfter
        ? { externalStartAfter: job.externalStartAfter }
        : {}),
      metadataStoreIndex: job.metadataStoreIndex,
      leaseId: args.leaseId,
      leaseExpiresAt,
    };
  },
});

const assertClaimedJob = async (
  ctx: MutationCtx,
  args: { ownerId: string; operationId: string; leaseId: string },
) => {
  const [lifecycle, job] = await Promise.all([
    readLifecycle(ctx, args.ownerId),
    readWipeJob(ctx, args.ownerId),
  ]);
  if (
    !lifecycle ||
    lifecycle.state !== "wiping" ||
    lifecycle.operationId !== args.operationId ||
    !job ||
    job.operationId !== args.operationId ||
    job.leaseId !== args.leaseId ||
    job.stage === "completed"
  ) {
    throw memoryEpochStaleError();
  }
  return { lifecycle, job };
};

export const recordMemoryWipeExternalGenerationInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    leaseId: v.string(),
    previousGeneration: v.optional(v.string()),
    externalGeneration: v.string(),
    now: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const { job } = await assertClaimedJob(ctx, args);
    if (
      args.previousGeneration !== undefined &&
      job.externalGeneration !== args.previousGeneration
    ) {
      throw memoryEpochStaleError();
    }
    if (
      args.previousGeneration === undefined &&
      job.externalGeneration !== undefined &&
      job.externalGeneration !== args.externalGeneration
    ) {
      throw memoryEpochStaleError();
    }
    if (job.externalGeneration !== args.externalGeneration) {
      await ctx.db.patch(job._id, {
        externalGeneration: args.externalGeneration,
        updatedAt: args.now,
      });
    }
    return args.externalGeneration;
  },
});

export const advanceMemoryWipeSweepInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    leaseId: v.string(),
    protocolVersion: v.number(),
    targetCount: v.number(),
    expectedCursor: v.number(),
    expectedStartAfter: v.optional(v.string()),
    nextCursor: v.number(),
    nextStartAfter: v.optional(v.string()),
    deleted: v.number(),
    complete: v.boolean(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const { job } = await assertClaimedJob(ctx, args);
    if (
      job.stage !== "sweeping" ||
      job.externalCursor !== args.expectedCursor ||
      job.externalStartAfter !== args.expectedStartAfter
    ) {
      throw memoryEpochStaleError();
    }
    const validScanCursor = (value: string | undefined): boolean =>
      value === undefined ||
      (value.length > 0 && value.length <= MEMORY_WIPE_SCAN_CURSOR_MAX);
    const exactTerminal =
      args.nextCursor === MEMORY_WIPE_EXTERNAL_TARGET_COUNT &&
      args.nextStartAfter === undefined;
    const targetAdvanced = args.nextCursor === args.expectedCursor + 1;
    const targetContinues = args.nextCursor === args.expectedCursor;
    const scanAdvanced =
      args.nextStartAfter !== args.expectedStartAfter &&
      args.nextStartAfter !== undefined &&
      (args.expectedStartAfter === undefined ||
        args.nextStartAfter > args.expectedStartAfter);
    if (
      args.protocolVersion !== MEMORY_WIPE_EXTERNAL_PROTOCOL_VERSION ||
      args.targetCount !== MEMORY_WIPE_EXTERNAL_TARGET_COUNT ||
      !Number.isSafeInteger(args.deleted) ||
      args.deleted < 0 ||
      args.deleted > MEMORY_WIPE_EXTERNAL_PAGE_MAX ||
      !Number.isSafeInteger(args.nextCursor) ||
      args.nextCursor < 0 ||
      args.nextCursor > MEMORY_WIPE_EXTERNAL_TARGET_COUNT ||
      (!targetAdvanced && !targetContinues) ||
      !validScanCursor(args.expectedStartAfter) ||
      !validScanCursor(args.nextStartAfter) ||
      (targetAdvanced && args.nextStartAfter !== undefined) ||
      (targetContinues && !scanAdvanced && args.deleted === 0) ||
      args.complete !== exactTerminal
    ) {
      throw new ConvexError("Invalid memory wipe sweep receipt.");
    }
    await ctx.db.patch(job._id, {
      stage: args.complete ? "metadata" : "sweeping",
      externalCursor: args.nextCursor,
      externalStartAfter: args.nextStartAfter,
      objectsDeleted: job.objectsDeleted + args.deleted,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      nextRetryAt: args.now,
      updatedAt: args.now,
    });
    await ctx.scheduler.runAfter(0, runMemoryWipeRef, {
      ownerId: args.ownerId,
      operationId: args.operationId,
    });
    return args.complete;
  },
});

const deleteMetadataPage = async (
  ctx: MutationCtx,
  ownerId: string,
  storeIndex: number,
) => {
  switch (storeIndex) {
    case 0:
      return await ctx.db
        .query("cloud_agent_home_docs")
        .withIndex("by_ownerId_and_name", (q) => q.eq("ownerId", ownerId))
        .take(METADATA_BATCH_SIZE);
    case 1:
      return await ctx.db
        .query("cloud_agent_home_doc_versions")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(METADATA_BATCH_SIZE);
    case 2:
      return await ctx.db
        .query("cloud_agent_home_write_intents")
        .withIndex("by_ownerId_and_idempotencyKey", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(METADATA_BATCH_SIZE);
    default:
      return [];
  }
};

export const deleteMemoryWipeMetadataBatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    leaseId: v.string(),
    storeIndex: v.number(),
    now: v.number(),
  },
  returns: v.object({ deleted: v.number(), metadataComplete: v.boolean() }),
  handler: async (ctx, args) => {
    const { job } = await assertClaimedJob(ctx, args);
    if (
      job.stage !== "metadata" ||
      job.metadataStoreIndex !== args.storeIndex ||
      !Number.isSafeInteger(args.storeIndex) ||
      args.storeIndex < 0 ||
      args.storeIndex > METADATA_STORE_COUNT
    ) {
      throw memoryEpochStaleError();
    }
    const rows = await deleteMetadataPage(ctx, args.ownerId, args.storeIndex);
    await Promise.all(rows.map((row) => ctx.db.delete(row._id)));
    const advance = rows.length < METADATA_BATCH_SIZE;
    const nextIndex = advance ? args.storeIndex + 1 : args.storeIndex;
    const metadataComplete = nextIndex >= METADATA_STORE_COUNT;
    await ctx.db.patch(job._id, {
      stage: metadataComplete ? "releasing" : "metadata",
      metadataStoreIndex: nextIndex,
      rowsDeleted: job.rowsDeleted + rows.length,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      nextRetryAt: args.now,
      updatedAt: args.now,
    });
    await ctx.scheduler.runAfter(0, runMemoryWipeRef, {
      ownerId: args.ownerId,
      operationId: args.operationId,
    });
    return { deleted: rows.length, metadataComplete };
  },
});

export const completeMemoryWipeInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    leaseId: v.string(),
    releasedExternalGeneration: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const { lifecycle, job } = await assertClaimedJob(ctx, args);
    if (
      job.stage !== "releasing" ||
      job.externalGeneration !== args.releasedExternalGeneration ||
      lifecycle.epoch !== job.targetEpoch
    ) {
      throw memoryEpochStaleError();
    }
    await ctx.db.patch(lifecycle._id, {
      epoch: job.nextEpoch,
      state: "open",
      operationId: undefined,
      importDisposition: "explicit_required",
      lastWipedEpoch: job.targetEpoch,
      importAuthorizationRequestId: undefined,
      importAuthorizedAt: undefined,
      updatedAt: args.now,
    });
    await ctx.db.patch(job._id, {
      stage: "completed",
      leaseId: undefined,
      leaseExpiresAt: undefined,
      nextRetryAt: args.now,
      lastErrorCode: undefined,
      completedAt: args.now,
      updatedAt: args.now,
    });
    await homeContextChanged(ctx, args.ownerId, lifecycle.ownerGeneration);
    return true;
  },
});

export const retryMemoryWipeInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    leaseId: v.string(),
    errorCode: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const [lifecycle, job] = await Promise.all([
      readLifecycle(ctx, args.ownerId),
      readWipeJob(ctx, args.ownerId),
    ]);
    if (
      !lifecycle ||
      lifecycle.state !== "wiping" ||
      lifecycle.operationId !== args.operationId ||
      !job ||
      job.operationId !== args.operationId ||
      job.leaseId !== args.leaseId ||
      job.stage === "completed"
    ) {
      return false;
    }
    const delay = Math.min(
      WIPE_RETRY_MAX_MS,
      Math.max(1_000, 2 ** Math.min(job.attempts, 9) * 1_000),
    );
    await ctx.db.patch(job._id, {
      leaseId: undefined,
      leaseExpiresAt: undefined,
      nextRetryAt: args.now + delay,
      lastErrorCode: args.errorCode.slice(0, 120),
      updatedAt: args.now,
    });
    await ctx.scheduler.runAfter(delay, runMemoryWipeRef, {
      ownerId: args.ownerId,
      operationId: args.operationId,
    });
    return true;
  },
});

const builderEndpoint = () => {
  const url = process.env.CLOUD_BUILDER_URL?.trim().replace(/\/+$/u, "");
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  if (!url || !secret) {
    throw new Error("MEMORY_WIPE_BUILDER_UNAVAILABLE");
  }
  return { url, secret };
};

const builderJson = async (
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
) => {
  const builder = builderEndpoint();
  const response = await fetch(`${builder.url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${builder.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) throw new Error("MEMORY_WIPE_EXTERNAL_UNAVAILABLE");
  return payload;
};

const ensureExternalFence = async (
  ctx: ActionCtx,
  job: {
    ownerId: string;
    operationId: string;
    leaseId: string;
    externalGeneration?: string;
  },
): Promise<string> => {
  const payload = (await builderJson(
    "/owners/purge/begin",
    {
      ownerId: job.ownerId,
      mode: "temporary",
      requestId: `memory-wipe:${job.operationId}`,
      ...(job.externalGeneration
        ? { expectedGeneration: job.externalGeneration }
        : {}),
    },
    120_000,
  )) as { generation?: unknown; rejoined?: unknown } | null;
  if (!payload || typeof payload.generation !== "string") {
    throw new Error("MEMORY_WIPE_EXTERNAL_PROTOCOL");
  }
  if (payload.generation !== job.externalGeneration) {
    await ctx.runMutation(
      makeFunctionReference<
        "mutation",
        {
          ownerId: string;
          operationId: string;
          leaseId: string;
          previousGeneration?: string;
          externalGeneration: string;
          now: number;
        },
        string
      >("cloud_memory_lifecycle:recordMemoryWipeExternalGenerationInternal"),
      {
        ownerId: job.ownerId,
        operationId: job.operationId,
        leaseId: job.leaseId,
        ...(job.externalGeneration
          ? { previousGeneration: job.externalGeneration }
          : {}),
        externalGeneration: payload.generation,
        now: Date.now(),
      },
    );
  }
  return payload.generation;
};

const safeActionErrorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "";
  return /^MEMORY_WIPE_[A-Z_]+$/u.test(message)
    ? message
    : "MEMORY_WIPE_INTERNAL_FAILURE";
};

export const runMemoryWipeInternal = internalAction({
  args: { ownerId: v.string(), operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const leaseId = `memorywipelease-${crypto.randomUUID()}`;
    const job = await ctx.runMutation(
      makeFunctionReference<
        "mutation",
        {
          ownerId: string;
          operationId: string;
          leaseId: string;
          now: number;
        },
        {
          ownerId: string;
          ownerGeneration: string;
          operationId: string;
          targetEpoch: string;
          nextEpoch: string;
          stage: MemoryWipeStage;
          externalGeneration?: string;
          externalCursor: number;
          externalStartAfter?: string;
          metadataStoreIndex: number;
          leaseId: string;
          leaseExpiresAt: number;
        } | null
      >("cloud_memory_lifecycle:claimMemoryWipeJobInternal"),
      { ...args, leaseId, now: Date.now() },
    );
    if (!job) return null;
    try {
      const externalGeneration = await ensureExternalFence(ctx, job);
      if (job.stage === "sweeping") {
        const payload = (await builderJson(
          "/owners/memory-wipe",
          {
            ownerId: job.ownerId,
            ownerGeneration: job.ownerGeneration,
            operationId: job.operationId,
            memoryEpoch: job.targetEpoch,
            purgeGeneration: externalGeneration,
            protocolVersion: MEMORY_WIPE_EXTERNAL_PROTOCOL_VERSION,
            cursor: job.externalCursor,
            ...(job.externalStartAfter
              ? { startAfter: job.externalStartAfter }
              : {}),
          },
          120_000,
        )) as {
          protocolVersion?: unknown;
          targetCount?: unknown;
          complete?: unknown;
          cursor?: unknown;
          startAfter?: unknown;
          deleted?: unknown;
        } | null;
        const nextStartAfter =
          typeof payload?.startAfter === "string"
            ? payload.startAfter
            : undefined;
        if (
          !payload ||
          payload.protocolVersion !== MEMORY_WIPE_EXTERNAL_PROTOCOL_VERSION ||
          payload.targetCount !== MEMORY_WIPE_EXTERNAL_TARGET_COUNT ||
          typeof payload.complete !== "boolean" ||
          !Number.isSafeInteger(payload.cursor) ||
          (payload.cursor as number) < job.externalCursor ||
          (payload.cursor as number) > MEMORY_WIPE_EXTERNAL_TARGET_COUNT ||
          (payload.startAfter !== undefined &&
            (typeof payload.startAfter !== "string" ||
              payload.startAfter.length === 0 ||
              payload.startAfter.length > MEMORY_WIPE_SCAN_CURSOR_MAX)) ||
          !Number.isSafeInteger(payload.deleted) ||
          (payload.deleted as number) < 0 ||
          (payload.deleted as number) > MEMORY_WIPE_EXTERNAL_PAGE_MAX ||
          payload.complete !==
            ((payload.cursor as number) === MEMORY_WIPE_EXTERNAL_TARGET_COUNT &&
              nextStartAfter === undefined)
        ) {
          throw new Error("MEMORY_WIPE_EXTERNAL_PROTOCOL");
        }
        await ctx.runMutation(
          makeFunctionReference<
            "mutation",
            {
              ownerId: string;
              operationId: string;
              leaseId: string;
              protocolVersion: number;
              targetCount: number;
              expectedCursor: number;
              expectedStartAfter?: string;
              nextCursor: number;
              nextStartAfter?: string;
              deleted: number;
              complete: boolean;
              now: number;
            },
            boolean
          >("cloud_memory_lifecycle:advanceMemoryWipeSweepInternal"),
          {
            ownerId: job.ownerId,
            operationId: job.operationId,
            leaseId,
            protocolVersion: MEMORY_WIPE_EXTERNAL_PROTOCOL_VERSION,
            targetCount: MEMORY_WIPE_EXTERNAL_TARGET_COUNT,
            expectedCursor: job.externalCursor,
            ...(job.externalStartAfter
              ? { expectedStartAfter: job.externalStartAfter }
              : {}),
            nextCursor: payload.cursor as number,
            ...(nextStartAfter ? { nextStartAfter } : {}),
            deleted: payload.deleted as number,
            complete: payload.complete,
            now: Date.now(),
          },
        );
        return null;
      }
      if (job.stage === "metadata") {
        await ctx.runMutation(
          makeFunctionReference<
            "mutation",
            {
              ownerId: string;
              operationId: string;
              leaseId: string;
              storeIndex: number;
              now: number;
            },
            { deleted: number; metadataComplete: boolean }
          >("cloud_memory_lifecycle:deleteMemoryWipeMetadataBatchInternal"),
          {
            ownerId: job.ownerId,
            operationId: job.operationId,
            leaseId,
            storeIndex: job.metadataStoreIndex,
            now: Date.now(),
          },
        );
        return null;
      }
      if (job.stage === "releasing") {
        await builderJson(
          "/owners/purge/release",
          { ownerId: job.ownerId, purgeGeneration: externalGeneration },
          30_000,
        );
        await ctx.runMutation(
          makeFunctionReference<
            "mutation",
            {
              ownerId: string;
              operationId: string;
              leaseId: string;
              releasedExternalGeneration: string;
              now: number;
            },
            boolean
          >("cloud_memory_lifecycle:completeMemoryWipeInternal"),
          {
            ownerId: job.ownerId,
            operationId: job.operationId,
            leaseId,
            releasedExternalGeneration: externalGeneration,
            now: Date.now(),
          },
        );
      }
    } catch (error) {
      const errorCode = safeActionErrorCode(error);
      console.error(
        JSON.stringify({
          service: "cloud-memory-wipe",
          event: "memory_wipe_retry_scheduled",
          ownerId: args.ownerId,
          operationId: args.operationId,
          errorCode,
        }),
      );
      await ctx.runMutation(
        makeFunctionReference<
          "mutation",
          {
            ownerId: string;
            operationId: string;
            leaseId: string;
            errorCode: string;
            now: number;
          },
          boolean
        >("cloud_memory_lifecycle:retryMemoryWipeInternal"),
        { ...args, leaseId, errorCode, now: Date.now() },
      );
    }
    return null;
  },
});

export const listDueMemoryWipesInternal = internalQuery({
  args: { now: v.number(), limit: v.optional(v.number()) },
  returns: v.array(v.object({ ownerId: v.string(), operationId: v.string() })),
  handler: async (ctx, args) => {
    const limit = Math.min(20, Math.max(1, Math.floor(args.limit ?? 10)));
    const rows = [];
    for (const stage of ["sweeping", "metadata", "releasing"] as const) {
      if (rows.length >= limit) break;
      rows.push(
        ...(await ctx.db
          .query("cloud_memory_wipe_jobs")
          .withIndex("by_stage_and_nextRetryAt", (q) =>
            q.eq("stage", stage).lte("nextRetryAt", args.now),
          )
          .take(limit - rows.length)),
      );
    }
    return rows.map((row) => ({
      ownerId: row.ownerId,
      operationId: row.operationId,
    }));
  },
});

export const sweepDueMemoryWipesInternal = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ attempted: v.number() }),
  handler: async (ctx, args) => {
    const jobs = await ctx.runQuery(
      makeFunctionReference<
        "query",
        { now: number; limit?: number },
        Array<{ ownerId: string; operationId: string }>
      >("cloud_memory_lifecycle:listDueMemoryWipesInternal"),
      { now: Date.now(), ...(args.limit ? { limit: args.limit } : {}) },
    );
    await Promise.all(
      jobs.map((job) => ctx.scheduler.runAfter(0, runMemoryWipeRef, job)),
    );
    return { attempted: jobs.length };
  },
});
