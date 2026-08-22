import { internalMutation, internalQuery, query } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { v } from "convex/values";
import { requireUserId } from "../../auth";

/**
 * One-time OAuth authorization transactions (state + PKCE). Generalizes the
 * good properties of the X OAuth state table into a provider-neutral form:
 * hashed state, encrypted verifier, expiry, and consume-before-exchange with a
 * compare-and-set status transition.
 */

export const CONNECT_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const EXPIRED_CLEANUP_BATCH = 16;

const attemptStatusValidator = v.union(
  v.literal("pending"),
  v.literal("exchanging"),
  v.literal("succeeded"),
  v.literal("denied"),
  v.literal("failed"),
  v.literal("expired"),
);

export const createConnectAttempt = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    connectorId: v.string(),
    scopeGroupIds: v.array(v.string()),
    stateHash: v.string(),
    encryptedVerifier: v.string(),
    keyVersion: v.number(),
    returnSurface: v.string(),
    registrationVersion: v.optional(v.number()),
    clientSecretVersion: v.optional(v.number()),
    accountOrigin: v.optional(v.string()),
    providerAccountIdIntent: v.optional(v.string()),
    expiresAt: v.number(),
  },
  returns: v.id("oauth_connect_attempts"),
  handler: async (ctx, args) => {
    const now = Date.now();
    // Opportunistically drop a bounded number of this owner's expired rows.
    const expiredOwnRows = await ctx.db
      .query("oauth_connect_attempts")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", args.ownerId))
      .take(EXPIRED_CLEANUP_BATCH);
    await Promise.all(
      expiredOwnRows
        .filter((row) => row.expiresAt <= now && row.status !== "pending")
        .map((row) => ctx.db.delete(row._id)),
    );

    return await ctx.db.insert("oauth_connect_attempts", {
      ownerId: args.ownerId,
      provider: args.provider,
      connectorId: args.connectorId,
      scopeGroupIds: args.scopeGroupIds,
      stateHash: args.stateHash,
      encryptedVerifier: args.encryptedVerifier,
      keyVersion: args.keyVersion,
      returnSurface: args.returnSurface,
      registrationVersion: args.registrationVersion,
      clientSecretVersion: args.clientSecretVersion,
      accountOrigin: args.accountOrigin,
      providerAccountIdIntent: args.providerAccountIdIntent,
      status: "pending",
      expiresAt: args.expiresAt,
      createdAt: now,
    });
  },
});

/**
 * Atomically consume an attempt by its state hash BEFORE any token exchange.
 * Returns the attempt payload exactly once; a replayed or expired state yields
 * null. Expired rows are transitioned to `expired` on read.
 */
export const consumeConnectAttempt = internalMutation({
  args: { stateHash: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      attemptId: v.id("oauth_connect_attempts"),
      ownerId: v.string(),
      provider: v.string(),
      connectorId: v.string(),
      scopeGroupIds: v.array(v.string()),
      encryptedVerifier: v.string(),
      keyVersion: v.number(),
      registrationVersion: v.optional(v.number()),
      clientSecretVersion: v.optional(v.number()),
      accountOrigin: v.optional(v.string()),
      providerAccountIdIntent: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const candidate = await ctx.db
      .query("oauth_connect_attempts")
      .withIndex("by_stateHash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (!candidate) return null;
    if (candidate.status !== "pending") return null; // replay / already consumed
    if (candidate.expiresAt <= now) {
      await ctx.db.patch(candidate._id, { status: "expired" });
      return null;
    }
    await ctx.db.patch(candidate._id, {
      status: "exchanging",
      consumedAt: now,
    });
    return {
      attemptId: candidate._id,
      ownerId: candidate.ownerId,
      provider: candidate.provider,
      connectorId: candidate.connectorId,
      scopeGroupIds: candidate.scopeGroupIds,
      encryptedVerifier: candidate.encryptedVerifier,
      keyVersion: candidate.keyVersion,
      registrationVersion: candidate.registrationVersion,
      clientSecretVersion: candidate.clientSecretVersion,
      accountOrigin: candidate.accountOrigin,
      providerAccountIdIntent: candidate.providerAccountIdIntent,
    };
  },
});

export const finalizeConnectAttempt = internalMutation({
  args: {
    attemptId: v.id("oauth_connect_attempts"),
    status: v.union(
      v.literal("succeeded"),
      v.literal("denied"),
      v.literal("failed"),
      v.literal("expired"),
    ),
    resolvedAccountId: v.optional(v.string()),
    errorCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.attemptId);
    if (!row) return null;
    await ctx.db.patch(args.attemptId, {
      status: args.status,
      resolvedAccountId: args.resolvedAccountId,
      errorCode: args.errorCode,
    });
    return null;
  },
});

/**
 * Authenticated status poll for the connect flow. Returns no secret material —
 * only the terminal status, the connector/provider, a classified error code and
 * the resolved account id on success.
 */
export const getConnectAttemptStatus = query({
  args: { attemptId: v.id("oauth_connect_attempts") },
  returns: v.union(
    v.null(),
    v.object({
      status: attemptStatusValidator,
      connectorId: v.string(),
      provider: v.string(),
      resolvedAccountId: v.optional(v.string()),
      errorCode: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const row = await ctx.db.get(args.attemptId);
    if (!row || row.ownerId !== ownerId) return null;
    return {
      status: row.status,
      connectorId: row.connectorId,
      provider: row.provider,
      resolvedAccountId: row.resolvedAccountId,
      errorCode: row.errorCode,
    };
  },
});

export const purgeExpiredConnectAttempts = internalMutation({
  args: { batchSize: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const batchSize = Math.min(
      Math.max(Math.floor(args.batchSize ?? 200), 1),
      1000,
    );
    const now = Date.now();
    const expired = await ctx.db
      .query("oauth_connect_attempts")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
    const hasMore = expired.length === batchSize;
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.connectors.oauth.attempts.purgeExpiredConnectAttempts,
        { batchSize },
      );
    }
    return { deleted: expired.length, hasMore };
  },
});
