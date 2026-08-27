import { v } from "convex/values";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import { components } from "./_generated/api";
import { tokenIdentifierForBetterAuthUserId } from "./auth";
import { tables as betterAuthTables } from "./betterAuth/generatedTables";

const FINALIZER_LEASE_MS = 5 * 60_000;
const MAX_RETRY_MS = 15 * 60_000;
const AUTH_COMPONENT_PAGE_SIZE = 100;

export const BETTER_AUTH_ACCOUNT_DELETION_REGISTRY = {
  user: "owner-root",
  session: "owner-child",
  account: "owner-child",
  verification: "attributed-or-legacy-scan",
  twoFactor: "owner-child",
  oauthApplication: "owner-child",
  oauthAccessToken: "owner-child",
  oauthConsent: "owner-child",
  jwks: "global",
  rateLimit: "global",
} as const satisfies Record<
  keyof typeof betterAuthTables,
  "owner-root" | "owner-child" | "attributed-or-legacy-scan" | "global"
>;

type ComponentPage<T = Record<string, unknown>> = {
  page: T[];
  isDone: boolean;
  continueCursor: string;
};

type ComponentDeletePage = {
  isDone: boolean;
  continueCursor: string;
  count: number;
};

type AuthDeletionIdentity = {
  ownerId: string;
  operationId: string;
  generation: string;
};

const claimFinalizerRef = makeFunctionReference<
  "mutation",
  AuthDeletionIdentity & { leaseId: string; now: number },
  | { claimed: false }
  | {
      claimed: true;
      authUserId: string;
      authUserEmail?: string;
      authRowsCreatedBefore: number;
      legacyVerificationCursor?: string;
      legacyVerificationComplete: boolean;
    }
>("auth_account_deletion:claimAuthAccountDeletionFinalizerInternal");
const completeFinalizerRef = makeFunctionReference<
  "mutation",
  AuthDeletionIdentity & { leaseId: string },
  boolean
>("auth_account_deletion:completeAuthAccountDeletionFinalizerInternal");
const retryFinalizerRef = makeFunctionReference<
  "mutation",
  AuthDeletionIdentity & {
    leaseId: string;
    error: string;
    now: number;
  },
  boolean
>("auth_account_deletion:retryAuthAccountDeletionFinalizerInternal");
const finalizeDeletionRef = makeFunctionReference<
  "action",
  AuthDeletionIdentity,
  null
>("auth_account_deletion:finalizeAuthAccountDeletionInternal");
const listDueFinalizersRef = makeFunctionReference<
  "query",
  { now: number; limit?: number },
  AuthDeletionIdentity[]
>("auth_account_deletion:listDueAuthAccountDeletionFinalizersInternal");
const advanceLegacyVerificationRef = makeFunctionReference<
  "mutation",
  AuthDeletionIdentity & {
    leaseId: string;
    cursor?: string;
    complete: boolean;
    now: number;
  },
  boolean
>("auth_account_deletion:advanceLegacyVerificationSweepInternal");
const getDeletionPreparationRef = makeFunctionReference<
  "query",
  AuthDeletionIdentity & { authUserId: string },
  { authUserEmail?: string } | null
>("auth_account_deletion:getAuthAccountDeletionPreparationInternal");
const betterAuthDeleteManyRef = components.betterAuth.adapter
  .deleteMany as FunctionReference<
  "mutation",
  "internal",
  {
    input: {
      model: BetterAuthChildModel;
      where: Array<{ field: string; value: string }>;
    };
    paginationOpts: { cursor: string | null; numItems: number };
  },
  ComponentDeletePage
>;

const finalizerIdentityArgs = {
  ownerId: v.string(),
  operationId: v.string(),
  generation: v.string(),
} as const;

export const claimAuthAccountDeletionFinalizerInternal = internalMutation({
  args: { ...finalizerIdentityArgs, leaseId: v.string(), now: v.number() },
  returns: v.union(
    v.object({ claimed: v.literal(false) }),
    v.object({
      claimed: v.literal(true),
      authUserId: v.string(),
      authUserEmail: v.optional(v.string()),
      authRowsCreatedBefore: v.number(),
      legacyVerificationCursor: v.optional(v.string()),
      legacyVerificationComplete: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const [row, lifecycle, job] = await Promise.all([
      ctx.db
        .query("auth_account_deletion_finalizers")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .unique(),
      ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .unique(),
      ctx.db
        .query("cloud_owner_purge_jobs")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .unique(),
    ]);
    if (!row) return { claimed: false as const };
    if (
      row.operationId !== args.operationId ||
      row.generation !== args.generation ||
      row.phase !== "ready" ||
      lifecycle?.state !== "deleting" ||
      lifecycle.operationId !== args.operationId ||
      lifecycle.generation !== args.generation ||
      job?.mode !== "delete" ||
      job.operationId !== args.operationId ||
      job.generation !== args.generation ||
      job.stage !== "complete"
    ) {
      return { claimed: false as const };
    }
    if (
      row.nextAttemptAt > args.now &&
      (!row.leaseId || row.leaseId !== args.leaseId)
    ) {
      return { claimed: false as const };
    }
    if (
      row.leaseId &&
      row.leaseId !== args.leaseId &&
      (row.leaseExpiresAt ?? 0) > args.now
    ) {
      return { claimed: false as const };
    }
    await ctx.db.patch(row._id, {
      leaseId: args.leaseId,
      leaseExpiresAt: args.now + FINALIZER_LEASE_MS,
      nextAttemptAt: args.now + FINALIZER_LEASE_MS,
      updatedAt: args.now,
    });
    return {
      claimed: true as const,
      authUserId: row.authUserId,
      authUserEmail: row.authUserEmail,
      authRowsCreatedBefore: row.authRowsCreatedBefore,
      legacyVerificationCursor: row.legacyVerificationCursor,
      legacyVerificationComplete: row.legacyVerificationComplete,
    };
  },
});

export const completeAuthAccountDeletionFinalizerInternal = internalMutation({
  args: { ...finalizerIdentityArgs, leaseId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("auth_account_deletion_finalizers")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (
      !row ||
      row.operationId !== args.operationId ||
      row.generation !== args.generation ||
      row.leaseId !== args.leaseId
    ) {
      return false;
    }
    await ctx.db.delete(row._id);
    return true;
  },
});

export const retryAuthAccountDeletionFinalizerInternal = internalMutation({
  args: {
    ...finalizerIdentityArgs,
    leaseId: v.string(),
    error: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("auth_account_deletion_finalizers")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (
      !row ||
      row.operationId !== args.operationId ||
      row.generation !== args.generation ||
      row.leaseId !== args.leaseId
    ) {
      return false;
    }
    const attempts = row.attempts + 1;
    const delay = Math.min(
      MAX_RETRY_MS,
      Math.max(1_000, 2 ** Math.min(attempts, 9) * 1_000),
    );
    const ageMs = Math.max(0, args.now - row.createdAt);
    if (attempts >= 5 || ageMs >= 60 * 60_000) {
      console.warn("[auth_account_deletion] Durable auth cleanup debt", {
        operationId: row.operationId,
        attempts,
        ageMs,
      });
    }
    await ctx.db.patch(row._id, {
      attempts,
      nextAttemptAt: args.now + delay,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      lastError: args.error.slice(0, 2_000),
      updatedAt: args.now,
    });
    await ctx.scheduler.runAfter(delay, finalizeDeletionRef, {
      ownerId: args.ownerId,
      operationId: args.operationId,
      generation: args.generation,
    });
    return true;
  },
});

/**
 * Idempotent wake-up after Better Auth's ordinary synchronous route deleted its
 * core user rows. The durable locator must remain until the finalizer has also
 * confirmed that every optional Better Auth table is empty.
 */
export const acknowledgeAuthAccountDeletedInternal = internalMutation({
  args: { ownerId: v.string(), authUserId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("auth_account_deletion_finalizers")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (!row || row.authUserId !== args.authUserId) return false;
    const now = Date.now();
    if (!row.leaseExpiresAt || row.leaseExpiresAt <= now) {
      await ctx.db.patch(row._id, {
        nextAttemptAt: now,
        leaseId: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
    }
    await ctx.scheduler.runAfter(0, finalizeDeletionRef, {
      ownerId: row.ownerId,
      operationId: row.operationId,
      generation: row.generation,
    });
    return true;
  },
});

export const advanceLegacyVerificationSweepInternal = internalMutation({
  args: {
    ...finalizerIdentityArgs,
    leaseId: v.string(),
    cursor: v.optional(v.string()),
    complete: v.boolean(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("auth_account_deletion_finalizers")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (
      !row ||
      row.operationId !== args.operationId ||
      row.generation !== args.generation ||
      row.leaseId !== args.leaseId
    ) {
      return false;
    }
    await ctx.db.patch(row._id, {
      legacyVerificationCursor: args.complete ? undefined : args.cursor,
      legacyVerificationComplete: args.complete,
      updatedAt: args.now,
    });
    return true;
  },
});

type BetterAuthChildModel =
  | "account"
  | "verification"
  | "twoFactor"
  | "oauthApplication"
  | "oauthAccessToken"
  | "oauthConsent";

const deleteComponentPage = async (
  ctx: Pick<ActionCtx, "runMutation">,
  model: BetterAuthChildModel,
  field: string,
  value: string,
): Promise<ComponentDeletePage> =>
  (await ctx.runMutation(betterAuthDeleteManyRef, {
    input: { model, where: [{ field, value }] },
    paginationOpts: { cursor: null, numItems: AUTH_COMPONENT_PAGE_SIZE },
  })) as ComponentDeletePage;

const deleteOwnerAuthChildRowsPass = async (
  ctx: Pick<ActionCtx, "runMutation" | "runQuery">,
  args: { ownerId: string; authUserId: string; authUserEmail?: string },
): Promise<boolean> => {
  const sessions = (await ctx.runQuery(
    components.betterAuth.adapter.findMany,
    {
      model: "session",
      where: [{ field: "userId", value: args.authUserId }],
      paginationOpts: { cursor: null, numItems: AUTH_COMPONENT_PAGE_SIZE },
    },
  )) as ComponentPage<{ _id: string; token: string }>;
  let sessionsComplete = sessions.isDone;
  for (const session of sessions.page) {
    const tokenRows = await deleteComponentPage(
      ctx,
      "verification",
      "value",
      session.token,
    );
    if (!tokenRows.isDone) {
      sessionsComplete = false;
      continue;
    }
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: {
        model: "session",
        where: [{ field: "_id", value: session._id }],
      },
    });
  }

  const pages = await Promise.all([
    deleteComponentPage(ctx, "account", "userId", args.authUserId),
    deleteComponentPage(ctx, "twoFactor", "userId", args.authUserId),
    deleteComponentPage(ctx, "oauthApplication", "userId", args.authUserId),
    deleteComponentPage(ctx, "oauthAccessToken", "userId", args.authUserId),
    deleteComponentPage(ctx, "oauthConsent", "userId", args.authUserId),
    deleteComponentPage(ctx, "verification", "ownerId", args.ownerId),
    deleteComponentPage(ctx, "verification", "value", args.authUserId),
  ]);
  return sessionsComplete && pages.every((page) => page.isDone);
};

const legacyVerificationContainsLocator = (
  value: unknown,
  authUserId: string,
  email?: string,
): boolean => {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((entry) =>
      legacyVerificationContainsLocator(entry, authUserId, email),
    );
  }
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      (key === "userId" && nested === authUserId) ||
      (key === "email" && email !== undefined && nested === email)
    ) {
      return true;
    }
    if (legacyVerificationContainsLocator(nested, authUserId, email)) {
      return true;
    }
  }
  return false;
};

const verificationMatchesLegacyOwner = (
  row: Record<string, unknown>,
  args: { ownerId: string; authUserId: string; authUserEmail?: string },
): boolean => {
  if (row.ownerId === args.ownerId || row.value === args.authUserId) {
    return true;
  }
  if (
    args.authUserEmail &&
    (row.identifier === args.authUserEmail || row.value === args.authUserEmail)
  ) {
    return true;
  }
  if (typeof row.value !== "string") return false;
  try {
    return legacyVerificationContainsLocator(
      JSON.parse(row.value) as unknown,
      args.authUserId,
      args.authUserEmail,
    );
  } catch {
    return false;
  }
};

const sweepLegacyVerificationPage = async (
  ctx: Pick<ActionCtx, "runMutation" | "runQuery">,
  args: {
    ownerId: string;
    authUserId: string;
    authUserEmail?: string;
    authRowsCreatedBefore: number;
    cursor?: string;
  },
): Promise<{ cursor?: string; complete: boolean }> => {
  const result = (await ctx.runQuery(
    components.betterAuth.adapter.findMany,
    {
      model: "verification",
      paginationOpts: {
        cursor: args.cursor ?? null,
        numItems: AUTH_COMPONENT_PAGE_SIZE,
      },
      sortBy: { field: "createdAt", direction: "asc" },
    },
  )) as ComponentPage<Record<string, unknown>>;
  let reachedPostFenceRow = false;
  for (const row of result.page) {
    const createdAt =
      typeof row._creationTime === "number" ? row._creationTime : Infinity;
    if (createdAt > args.authRowsCreatedBefore) {
      reachedPostFenceRow = true;
      break;
    }
    if (
      typeof row._id === "string" &&
      verificationMatchesLegacyOwner(row, args)
    ) {
      await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
        input: {
          model: "verification",
          where: [{ field: "_id", value: row._id }],
        },
      });
    }
  }
  const complete = result.isDone || reachedPostFenceRow;
  return {
    complete,
    ...(!complete ? { cursor: result.continueCursor } : {}),
  };
};

export const getAuthAccountDeletionPreparationInternal = internalQuery({
  args: {
    ...finalizerIdentityArgs,
    authUserId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({ authUserEmail: v.optional(v.string()) }),
  ),
  handler: async (ctx, args) => {
    const [lifecycle, job, finalizer] = await Promise.all([
      ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .unique(),
      ctx.db
        .query("cloud_owner_purge_jobs")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .unique(),
      ctx.db
        .query("auth_account_deletion_finalizers")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .unique(),
    ]);
    if (
      lifecycle?.state !== "deleting" ||
      lifecycle.operationId !== args.operationId ||
      lifecycle.generation !== args.generation ||
      job?.mode !== "delete" ||
      job.operationId !== args.operationId ||
      job.generation !== args.generation ||
      finalizer?.authUserId !== args.authUserId ||
      finalizer.operationId !== args.operationId ||
      finalizer.generation !== args.generation
    ) {
      return null;
    }
    return { authUserEmail: finalizer.authUserEmail };
  },
});

/**
 * Prepares Better Auth's synchronous delete-user route so its subsequent
 * internal adapter cascade has no unbounded owner-child query left to run.
 * Larger accounts abort the route and converge through the durable finalizer.
 */
export const prepareAuthAccountDeletionForRouteInternal = internalAction({
  args: {
    ...finalizerIdentityArgs,
    authUserId: v.string(),
  },
  returns: v.object({ ready: v.boolean() }),
  handler: async (ctx, args) => {
    const locator: { authUserEmail?: string } | null = await ctx.runQuery(
      getDeletionPreparationRef,
      args,
    );
    if (!locator) return { ready: false };
    return {
      ready: await deleteOwnerAuthChildRowsPass(ctx, {
        ownerId: args.ownerId,
        authUserId: args.authUserId,
        authUserEmail: locator.authUserEmail,
      }),
    };
  },
});

export const finalizeAuthAccountDeletionInternal = internalAction({
  args: finalizerIdentityArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const leaseId = crypto.randomUUID();
    const claim = await ctx.runMutation(claimFinalizerRef, {
      ...args,
      leaseId,
      now: Date.now(),
    });
    if (!claim.claimed) return null;
    try {
      if (
        tokenIdentifierForBetterAuthUserId(claim.authUserId) !== args.ownerId
      ) {
        throw new Error("Better Auth deletion locator owner mismatch.");
      }
      const user = (await ctx.runQuery(
        components.betterAuth.adapter.findOne,
        {
        model: "user",
          where: [{ field: "_id", value: claim.authUserId }],
        },
      )) as { _id: string; email?: string } | null;
      const authUserEmail = user?.email ?? claim.authUserEmail;
      const childrenComplete = await deleteOwnerAuthChildRowsPass(ctx, {
        ownerId: args.ownerId,
        authUserId: claim.authUserId,
        authUserEmail,
      });
      if (!childrenComplete) {
        throw new Error(
          "Better Auth child deletion has additional bounded pages.",
        );
      }

      if (!claim.legacyVerificationComplete) {
        const legacy = await sweepLegacyVerificationPage(ctx, {
          ownerId: args.ownerId,
          authUserId: claim.authUserId,
          authUserEmail,
          authRowsCreatedBefore: claim.authRowsCreatedBefore,
          cursor: claim.legacyVerificationCursor,
        });
        const advanced = await ctx.runMutation(advanceLegacyVerificationRef, {
          ...args,
          leaseId,
          cursor: legacy.cursor,
          complete: legacy.complete,
          now: Date.now(),
        });
        if (!advanced) {
          throw new Error("Better Auth legacy verification lease changed.");
        }
        if (!legacy.complete) {
          throw new Error(
            "Better Auth legacy verification sweep has another bounded page.",
          );
        }
      }

      await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
        input: {
          model: "user",
          where: [{ field: "_id", value: claim.authUserId }],
        },
      });
      const postDeleteChildrenComplete = await deleteOwnerAuthChildRowsPass(
        ctx,
        {
          ownerId: args.ownerId,
          authUserId: claim.authUserId,
          authUserEmail,
        },
      );
      const remaining = await ctx.runQuery(
        components.betterAuth.adapter.findOne,
        {
        model: "user",
          where: [{ field: "_id", value: claim.authUserId }],
        },
      );
      if (remaining || !postDeleteChildrenComplete) {
        throw new Error(
          "Better Auth user and child deletion was not confirmed.",
        );
      }
      const completed = await ctx.runMutation(completeFinalizerRef, {
        ...args,
        leaseId,
      });
      if (!completed) {
        throw new Error("Better Auth deletion finalizer lease changed.");
      }
    } catch (error) {
      await ctx.runMutation(retryFinalizerRef, {
        ...args,
        leaseId,
        error: error instanceof Error ? error.message : String(error),
        now: Date.now(),
      });
    }
    return null;
  },
});

export const listDueAuthAccountDeletionFinalizersInternal = internalQuery({
  args: { now: v.number(), limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      ownerId: v.string(),
      operationId: v.string(),
      generation: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const limit = Math.min(20, Math.max(1, Math.floor(args.limit ?? 10)));
    const rows = await ctx.db
      .query("auth_account_deletion_finalizers")
      .withIndex("by_phase_and_nextAttemptAt", (q) =>
        q.eq("phase", "ready").lte("nextAttemptAt", args.now),
      )
      .take(limit);
    return rows.map((row) => ({
      ownerId: row.ownerId,
      operationId: row.operationId,
      generation: row.generation,
    }));
  },
});

export const sweepAuthAccountDeletionFinalizersInternal = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ attempted: v.number() }),
  handler: async (ctx, args) => {
    const rows = await ctx.runQuery(listDueFinalizersRef, {
      now: Date.now(),
      limit: args.limit,
    });
    await Promise.all(
      rows.map((row) => ctx.scheduler.runAfter(0, finalizeDeletionRef, row)),
    );
    return { attempted: rows.length };
  },
});
