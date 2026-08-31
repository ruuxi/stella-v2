import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  ownerLifecycleStateValidator,
  ownerPurgeModeValidator,
  ownerPurgeStageValidator,
} from "./schema/owner_lifecycle";

export const LEGACY_OWNER_GENERATION = "legacy";
const PURGE_LEASE_MS = 9 * 60_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;

type OwnerLifecycleState = "open" | "resetting" | "deleting";
type OwnerPurgeMode = "reset" | "delete";
type OwnerPurgeStage = "core" | "cloud" | "complete";

const readOwnerLifecycle = async (ctx: Pick<QueryCtx, "db">, ownerId: string) =>
  await ctx.db
    .query("cloud_owner_lifecycles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();

const readOwnerPurgeJob = async (ctx: Pick<QueryCtx, "db">, ownerId: string) =>
  await ctx.db
    .query("cloud_owner_purge_jobs")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();

const recordAuthAccountDeletionFinalizer = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    authUserId: string;
    authUserEmail?: string;
    operationId: string;
    generation: string;
    now: number;
  },
): Promise<void> => {
  const authUserId = args.authUserId.trim();
  if (!authUserId || authUserId.length > 512) {
    throw new Error("Invalid Better Auth user deletion locator.");
  }
  const authUserEmail = args.authUserEmail?.trim();
  if (
    args.authUserEmail !== undefined &&
    (!authUserEmail || authUserEmail.length > 1_024)
  ) {
    throw new Error("Invalid Better Auth email deletion locator.");
  }
  const [byOwner, byAuthUser] = await Promise.all([
    ctx.db
      .query("auth_account_deletion_finalizers")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique(),
    ctx.db
      .query("auth_account_deletion_finalizers")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", authUserId))
      .unique(),
  ]);
  if (byOwner && byAuthUser && byOwner._id !== byAuthUser._id) {
    throw new Error("Conflicting Better Auth account deletion locator.");
  }
  const existing = byOwner ?? byAuthUser;
  if (existing) {
    if (
      existing.ownerId !== args.ownerId ||
      existing.authUserId !== authUserId ||
      existing.operationId !== args.operationId ||
      existing.generation !== args.generation ||
      (authUserEmail !== undefined &&
        existing.authUserEmail !== undefined &&
        existing.authUserEmail !== authUserEmail)
    ) {
      throw new Error("Better Auth account deletion locator changed.");
    }
    if (authUserEmail !== undefined && existing.authUserEmail === undefined) {
      await ctx.db.patch(existing._id, {
        authUserEmail,
        updatedAt: args.now,
      });
    }
    return;
  }
  await ctx.db.insert("auth_account_deletion_finalizers", {
    ownerId: args.ownerId,
    authUserId,
    authUserEmail,
    operationId: args.operationId,
    generation: args.generation,
    phase: "waiting_for_purge",
    authRowsCreatedBefore: args.now,
    legacyVerificationComplete: false,
    attempts: 0,
    nextAttemptAt: args.now,
    createdAt: args.now,
    updatedAt: args.now,
  });
};

const purgeActiveError = (state: Exclude<OwnerLifecycleState, "open">) =>
  new ConvexError({
    code: "OWNER_DATA_PURGE_ACTIVE",
    state,
    message:
      state === "deleting"
        ? "This account is being deleted."
        : "This account's data is being reset. Retry after the reset finishes.",
  });

const staleGenerationError = () =>
  new ConvexError({
    code: "OWNER_DATA_GENERATION_STALE",
    message: "This request started before the account data was reset.",
  });

/**
 * Transactional writer guard. Reading the lifecycle row in the same mutation
 * as the caller's write makes a concurrent reset insert/update an OCC conflict;
 * the retried mutation then sees the fence and cannot resurrect owner data.
 *
 * `expectedGeneration` closes the other edge: a delayed callback authorized in
 * the generation before a reset is rejected after the account reopens.
 */
export const assertOwnerDataWriteAllowed = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  expectedGeneration?: string,
): Promise<{ generation: string }> => {
  const lifecycle = await readOwnerLifecycle(ctx, ownerId);
  if (!lifecycle) {
    if (
      expectedGeneration !== undefined &&
      expectedGeneration !== LEGACY_OWNER_GENERATION
    ) {
      throw staleGenerationError();
    }
    return { generation: LEGACY_OWNER_GENERATION };
  }
  if (lifecycle.state !== "open") throw purgeActiveError(lifecycle.state);
  if (
    expectedGeneration !== undefined &&
    expectedGeneration !== lifecycle.generation
  ) {
    throw staleGenerationError();
  }
  return { generation: lifecycle.generation };
};

const ownerDataAccessStateValidator = v.object({
  allowed: v.boolean(),
  state: ownerLifecycleStateValidator,
  generation: v.string(),
});

export const getOwnerDataAccessStateInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: ownerDataAccessStateValidator,
  handler: async (ctx, args) => {
    const lifecycle = await readOwnerLifecycle(ctx, args.ownerId);
    if (!lifecycle) {
      return {
        allowed: true,
        state: "open" as const,
        generation: LEGACY_OWNER_GENERATION,
      };
    }
    return {
      allowed: lifecycle.state === "open",
      state: lifecycle.state,
      generation: lifecycle.generation,
    };
  },
});

/** Action-side admission seam used before credentials, billing, or upstream IO. */
export const assertOwnerDataAccessActive = async (
  ctx: Pick<ActionCtx, "runQuery">,
  ownerId: string,
): Promise<{ generation: string }> => {
  const state: {
    allowed: boolean;
    state: OwnerLifecycleState;
    generation: string;
  } = await ctx.runQuery(
    internal.owner_lifecycle.getOwnerDataAccessStateInternal,
    { ownerId },
  );
  if (!state.allowed)
    throw purgeActiveError(state.state as "resetting" | "deleting");
  return { generation: state.generation };
};

/**
 * Last transaction-plane check before an action performs upstream IO.
 *
 * Provider actions call this after all potentially slow preparation and
 * immediately before fetch. The generation argument binds the dispatch to the
 * admission snapshot, while the lifecycle read gives the mutation a
 * serializable ordering against reset/account-deletion transitions.
 */
export const assertOwnerDataDispatchAllowedInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    return null;
  },
});

/**
 * Opens (or idempotently rejoins) a destructive operation. Delete upgrades a
 * reset and can never be downgraded. The lifecycle and retry job are written in
 * one transaction, so there is no published fence without a durable owner of
 * the work and no job that runs before writes are blocked.
 */
export const beginOwnerDataPurgeInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    mode: ownerPurgeModeValidator,
    /** Set only by Better Auth's authenticated delete-user hook. */
    authUserId: v.optional(v.string()),
    /** Email-keyed verification rows require this crash-safe locator too. */
    authUserEmail: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.object({
    operationId: v.string(),
    generation: v.string(),
    mode: ownerPurgeModeValidator,
    stage: ownerPurgeStageValidator,
  }),
  handler: async (ctx, args) => {
    const lifecycle = await readOwnerLifecycle(ctx, args.ownerId);
    const existingJob = await readOwnerPurgeJob(ctx, args.ownerId);

    let operationId = args.operationId;
    let generation: string = crypto.randomUUID();
    let mode: OwnerPurgeMode = args.mode;
    let stage: OwnerPurgeStage = "core";
    let reuseActiveJob = false;

    if (lifecycle && lifecycle.state !== "open") {
      operationId = lifecycle.operationId ?? args.operationId;
      generation = lifecycle.generation;
      mode = lifecycle.state === "deleting" ? "delete" : args.mode;
      if (lifecycle.state === "deleting" && args.mode === "reset") {
        throw purgeActiveError("deleting");
      }
      if (
        existingJob &&
        existingJob.operationId === operationId &&
        existingJob.generation === generation
      ) {
        stage = existingJob.stage;
        reuseActiveJob = true;
      }
      if (args.mode === "delete" && lifecycle.state === "resetting") {
        // Account deletion has a broader core drain than reset, so an upgrade
        // restarts at that idempotent stage under the same blocking generation.
        mode = "delete";
        stage = "core";
        reuseActiveJob = false;
        await ctx.db.patch(lifecycle._id, {
          state: "deleting",
          updatedAt: args.now,
        });
      }
    } else if (lifecycle) {
      await ctx.db.patch(lifecycle._id, {
        generation,
        state: args.mode === "delete" ? "deleting" : "resetting",
        operationId,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: args.ownerId,
        generation,
        state: args.mode === "delete" ? "deleting" : "resetting",
        operationId,
        createdAt: args.now,
        updatedAt: args.now,
      });
    }

    if (args.authUserId) {
      if (mode !== "delete") {
        throw new Error(
          "A Better Auth deletion locator requires permanent delete mode.",
        );
      }
      await recordAuthAccountDeletionFinalizer(ctx, {
        ownerId: args.ownerId,
        authUserId: args.authUserId,
        authUserEmail: args.authUserEmail,
        operationId,
        generation,
        now: args.now,
      });
    }

    // A duplicate begin is a join, not a lease-steal/retry reset. Leave the
    // active job byte-for-byte intact unless deletion explicitly upgraded a
    // reset above.
    if (reuseActiveJob && existingJob) {
      return {
        operationId,
        generation,
        mode: existingJob.mode,
        stage: existingJob.stage,
      };
    }

    const jobValues = {
      operationId,
      generation,
      mode,
      stage,
      attempts:
        existingJob?.operationId === operationId ? existingJob.attempts : 0,
      nextRetryAt: args.now,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      externalGeneration:
        existingJob?.operationId === operationId
          ? existingJob.externalGeneration
          : undefined,
      remoteTurnConversationCursor:
        existingJob?.operationId === operationId &&
        existingJob.generation === generation
          ? existingJob.remoteTurnConversationCursor
          : undefined,
      remoteTurnConversationScanComplete:
        existingJob?.operationId === operationId &&
        existingJob.generation === generation
          ? existingJob.remoteTurnConversationScanComplete
          : undefined,
      lastError: undefined,
      updatedAt: args.now,
    };
    if (existingJob) {
      await ctx.db.patch(existingJob._id, jobValues);
    } else {
      await ctx.db.insert("cloud_owner_purge_jobs", {
        ownerId: args.ownerId,
        ...jobValues,
        createdAt: args.now,
      });
    }

    return { operationId, generation, mode, stage };
  },
});

export const getOwnerPurgeJobInternal = internalQuery({
  args: { ownerId: v.string(), operationId: v.optional(v.string()) },
  returns: v.union(
    v.null(),
    v.object({
      operationId: v.string(),
      generation: v.string(),
      mode: ownerPurgeModeValidator,
      stage: ownerPurgeStageValidator,
      attempts: v.number(),
      nextRetryAt: v.number(),
      leaseId: v.optional(v.string()),
      leaseExpiresAt: v.optional(v.number()),
      externalGeneration: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const job = await readOwnerPurgeJob(ctx, args.ownerId);
    if (!job || (args.operationId && job.operationId !== args.operationId)) {
      return null;
    }
    return {
      operationId: job.operationId,
      generation: job.generation,
      mode: job.mode,
      stage: job.stage,
      attempts: job.attempts,
      nextRetryAt: job.nextRetryAt,
      ...(job.leaseId ? { leaseId: job.leaseId } : {}),
      ...(job.leaseExpiresAt ? { leaseExpiresAt: job.leaseExpiresAt } : {}),
      ...(job.externalGeneration
        ? { externalGeneration: job.externalGeneration }
        : {}),
    };
  },
});

/** Records the worker-side fence generation under the same owner operation. */
export const recordOwnerExternalPurgeGenerationInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    externalGeneration: v.string(),
    now: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const job = await readOwnerPurgeJob(ctx, args.ownerId);
    if (
      !job ||
      job.operationId !== args.operationId ||
      job.generation !== args.generation ||
      job.stage === "complete"
    ) {
      throw staleGenerationError();
    }
    if (
      job.externalGeneration &&
      job.externalGeneration !== args.externalGeneration
    ) {
      throw new ConvexError({
        code: "OWNER_EXTERNAL_FENCE_MISMATCH",
        message: "The cloud owner fence generation changed during purge.",
      });
    }
    if (!job.externalGeneration) {
      await ctx.db.patch(job._id, {
        externalGeneration: args.externalGeneration,
        updatedAt: args.now,
      });
    }
    return job.externalGeneration ?? args.externalGeneration;
  },
});

/**
 * Rebinds a reset job after the worker proves it is reopening the exact fence
 * generation that this operation previously released. The previous-generation
 * CAS prevents an unrelated worker fence from being adopted after an ABA.
 */
export const rebindOwnerExternalPurgeGenerationInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    previousExternalGeneration: v.string(),
    externalGeneration: v.string(),
    now: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const job = await readOwnerPurgeJob(ctx, args.ownerId);
    if (
      !job ||
      job.operationId !== args.operationId ||
      job.generation !== args.generation ||
      job.stage === "complete" ||
      job.externalGeneration !== args.previousExternalGeneration
    ) {
      throw staleGenerationError();
    }
    await ctx.db.patch(job._id, {
      externalGeneration: args.externalGeneration,
      updatedAt: args.now,
    });
    return args.externalGeneration;
  },
});

export const claimOwnerPurgeStageInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    stage: ownerPurgeStageValidator,
    leaseId: v.string(),
    now: v.number(),
  },
  returns: v.object({
    claimed: v.boolean(),
    complete: v.boolean(),
    mode: ownerPurgeModeValidator,
  }),
  handler: async (ctx, args) => {
    const [lifecycle, job] = await Promise.all([
      readOwnerLifecycle(ctx, args.ownerId),
      readOwnerPurgeJob(ctx, args.ownerId),
    ]);
    if (
      !lifecycle ||
      lifecycle.state === "open" ||
      lifecycle.operationId !== args.operationId ||
      lifecycle.generation !== args.generation ||
      !job ||
      job.operationId !== args.operationId ||
      job.generation !== args.generation
    ) {
      throw staleGenerationError();
    }
    if (job.stage === "complete") {
      return { claimed: false, complete: true, mode: job.mode };
    }
    if (job.stage !== args.stage) {
      return { claimed: false, complete: false, mode: job.mode };
    }
    if (
      job.leaseId &&
      job.leaseId !== args.leaseId &&
      (job.leaseExpiresAt ?? 0) > args.now
    ) {
      return { claimed: false, complete: false, mode: job.mode };
    }
    const leaseExpiresAt = args.now + PURGE_LEASE_MS;
    await ctx.db.patch(job._id, {
      leaseId: args.leaseId,
      leaseExpiresAt,
      attempts: job.attempts + 1,
      // A killed action gets picked up by the cron once its lease expires.
      nextRetryAt: leaseExpiresAt,
      lastError: undefined,
      updatedAt: args.now,
    });
    return { claimed: true, complete: false, mode: job.mode };
  },
});

export const advanceOwnerPurgeStageInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    stage: ownerPurgeStageValidator,
    nextStage: ownerPurgeStageValidator,
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await readOwnerPurgeJob(ctx, args.ownerId);
    if (
      !job ||
      job.operationId !== args.operationId ||
      job.generation !== args.generation ||
      job.stage !== args.stage ||
      job.leaseId !== args.leaseId
    ) {
      return false;
    }
    await ctx.db.patch(job._id, {
      stage: args.nextStage,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      nextRetryAt: args.now,
      lastError: undefined,
      updatedAt: args.now,
    });
    return true;
  },
});

export const scheduleOwnerPurgeRetryInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    stage: ownerPurgeStageValidator,
    leaseId: v.string(),
    error: v.string(),
    retryAfterMs: v.optional(v.number()),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await readOwnerPurgeJob(ctx, args.ownerId);
    if (
      !job ||
      job.operationId !== args.operationId ||
      job.generation !== args.generation ||
      job.stage !== args.stage ||
      job.leaseId !== args.leaseId ||
      job.stage === "complete"
    ) {
      return false;
    }
    const delay = Math.min(
      MAX_RETRY_DELAY_MS,
      Math.max(1_000, Math.floor(args.retryAfterMs ?? 5_000)),
    );
    await ctx.db.patch(job._id, {
      stage: args.stage,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      nextRetryAt: args.now + delay,
      lastError: args.error.slice(0, 2_000),
      updatedAt: args.now,
    });
    await ctx.scheduler.runAfter(
      delay,
      internal.owner_lifecycle.resumeOwnerPurgeJobInternal,
      { ownerId: args.ownerId, operationId: args.operationId },
    );
    return true;
  },
});

export const finishOwnerCloudPurgeInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    nextGeneration: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const [lifecycle, job] = await Promise.all([
      readOwnerLifecycle(ctx, args.ownerId),
      readOwnerPurgeJob(ctx, args.ownerId),
    ]);
    if (
      !lifecycle ||
      lifecycle.operationId !== args.operationId ||
      lifecycle.generation !== args.generation ||
      lifecycle.state === "open" ||
      !job ||
      job.operationId !== args.operationId ||
      job.generation !== args.generation ||
      job.stage !== "cloud" ||
      job.leaseId !== args.leaseId
    ) {
      return false;
    }
    await ctx.db.patch(job._id, {
      stage: "complete",
      leaseId: undefined,
      leaseExpiresAt: undefined,
      nextRetryAt: args.now,
      lastError: undefined,
      updatedAt: args.now,
    });
    if (job.mode === "reset") {
      await ctx.db.patch(lifecycle._id, {
        generation: args.nextGeneration,
        state: "open",
        operationId: undefined,
        updatedAt: args.now,
      });
    } else {
      // Better Auth's beforeDelete hook may have lost its action response and
      // aborted before removing the component user. Completion publishes a
      // durable finalizer immediately; the minute sweep is its crash backup.
      const finalizer = await ctx.db
        .query("auth_account_deletion_finalizers")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .unique();
      if (
        finalizer?.operationId === args.operationId &&
        finalizer.generation === args.generation
      ) {
        await ctx.db.patch(finalizer._id, {
          phase: "ready",
          nextAttemptAt: args.now,
          updatedAt: args.now,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.auth_account_deletion.finalizeAuthAccountDeletionInternal,
          {
            ownerId: args.ownerId,
            operationId: args.operationId,
            generation: args.generation,
          },
        );
      }
    }
    // Delete mode intentionally keeps the lifecycle tombstone blocked.
    return true;
  },
});

/** Required by every destructive mutation in the purge implementation. */
export const assertOwnerPurgeOperation = async (
  ctx: MutationCtx,
  args: { ownerId: string; operationId: string; generation: string },
): Promise<void> => {
  const [lifecycle, job] = await Promise.all([
    readOwnerLifecycle(ctx, args.ownerId),
    readOwnerPurgeJob(ctx, args.ownerId),
  ]);
  if (
    !lifecycle ||
    lifecycle.state === "open" ||
    lifecycle.operationId !== args.operationId ||
    lifecycle.generation !== args.generation ||
    !job ||
    job.operationId !== args.operationId ||
    job.generation !== args.generation ||
    job.stage === "complete"
  ) {
    throw staleGenerationError();
  }
};

/**
 * Stronger completion/release fence for stage owners. Operation generations
 * alone deliberately survive a reset -> delete upgrade; the lease and mode do
 * not. Requiring all of them prevents an already-running reset action from
 * reopening an external or relay gate after account deletion supersedes it.
 */
export const assertOwnerPurgeLease = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    operationId: string;
    generation: string;
    stage: OwnerPurgeStage;
    leaseId: string;
    mode: OwnerPurgeMode;
  },
): Promise<void> => {
  const [lifecycle, job] = await Promise.all([
    readOwnerLifecycle(ctx, args.ownerId),
    readOwnerPurgeJob(ctx, args.ownerId),
  ]);
  const expectedState = args.mode === "delete" ? "deleting" : "resetting";
  if (
    !lifecycle ||
    lifecycle.state !== expectedState ||
    lifecycle.operationId !== args.operationId ||
    lifecycle.generation !== args.generation ||
    !job ||
    job.operationId !== args.operationId ||
    job.generation !== args.generation ||
    job.mode !== args.mode ||
    job.stage !== args.stage ||
    job.leaseId !== args.leaseId
  ) {
    throw staleGenerationError();
  }
};

export const assertOwnerPurgeLeaseInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    stage: ownerPurgeStageValidator,
    leaseId: v.string(),
    mode: ownerPurgeModeValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, args);
    return null;
  },
});

/**
 * Exact lease assertion plus renewal before bounded external I/O. Without the
 * renewal, a worker could validate an already-near-expiry lease and then race
 * a reclaim while its provider request was still in flight.
 */
export const renewOwnerPurgeLeaseInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    stage: ownerPurgeStageValidator,
    leaseId: v.string(),
    mode: ownerPurgeModeValidator,
    now: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, args);
    const job = await readOwnerPurgeJob(ctx, args.ownerId);
    if (!job) throw staleGenerationError();
    const leaseExpiresAt = args.now + PURGE_LEASE_MS;
    await ctx.db.patch(job._id, {
      leaseExpiresAt,
      nextRetryAt: leaseExpiresAt,
      updatedAt: args.now,
    });
    return leaseExpiresAt;
  },
});

export const listDueOwnerPurgeJobsInternal = internalQuery({
  args: { now: v.number(), limit: v.optional(v.number()) },
  returns: v.array(v.object({ ownerId: v.string(), operationId: v.string() })),
  handler: async (ctx, args) => {
    const limit = Math.min(20, Math.max(1, Math.floor(args.limit ?? 10)));
    const core = await ctx.db
      .query("cloud_owner_purge_jobs")
      .withIndex("by_stage_and_nextRetryAt", (q) =>
        q.eq("stage", "core").lte("nextRetryAt", args.now),
      )
      .take(limit);
    const cloud =
      core.length >= limit
        ? []
        : await ctx.db
            .query("cloud_owner_purge_jobs")
            .withIndex("by_stage_and_nextRetryAt", (q) =>
              q.eq("stage", "cloud").lte("nextRetryAt", args.now),
            )
            .take(limit - core.length);
    return [...core, ...cloud].map((job) => ({
      ownerId: job.ownerId,
      operationId: job.operationId,
    }));
  },
});

export const resumeOwnerPurgeJobInternal = internalAction({
  args: { ownerId: v.string(), operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job: {
      operationId: string;
      generation: string;
      mode: OwnerPurgeMode;
      stage: OwnerPurgeStage;
    } | null = await ctx.runQuery(
      internal.owner_lifecycle.getOwnerPurgeJobInternal,
      args,
    );
    if (!job || job.stage === "complete") return null;
    try {
      if (job.stage === "core") {
        if (job.mode === "reset") {
          await ctx.runAction(internal.reset.resumeOwnerResetInternal, {
            ownerId: args.ownerId,
            operationId: job.operationId,
            generation: job.generation,
          });
        } else {
          await ctx.runAction(internal.account_deletion.purgeOwnerCloudData, {
            ownerId: args.ownerId,
            operationId: job.operationId,
            generation: job.generation,
          });
        }
      } else {
        await ctx.runAction(internal.cloud_purge.purgeOwnerCloudStack, {
          ownerId: args.ownerId,
          operationId: job.operationId,
          generation: job.generation,
        });
      }
    } catch (error) {
      // The claimed stage action owns lease-checked retry publication. If it
      // failed before claiming, its existing nextRetryAt remains due for this
      // sweep; an outer catch must never clear another worker's reclaimed lease.
      console.error(
        JSON.stringify({
          service: "owner-lifecycle",
          event: "purge_resume_failed",
          ownerId: args.ownerId,
          operationId: job.operationId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return null;
  },
});

export const sweepDueOwnerPurgeJobsInternal = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ attempted: v.number() }),
  handler: async (ctx, args) => {
    const jobs: Array<{ ownerId: string; operationId: string }> =
      await ctx.runQuery(
        internal.owner_lifecycle.listDueOwnerPurgeJobsInternal,
        { now: Date.now(), limit: args.limit },
      );
    await Promise.all(
      jobs.map((job) =>
        ctx.scheduler.runAfter(
          0,
          internal.owner_lifecycle.resumeOwnerPurgeJobInternal,
          job,
        ),
      ),
    );
    return { attempted: jobs.length };
  },
});
