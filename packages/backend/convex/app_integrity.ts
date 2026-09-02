import type { AppIntegrityPurpose } from "@stella/contracts/app-integrity";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";

const appIntegrityPurposeValidator = v.union(
  v.literal("anonymous-sign-in"),
  v.literal("magic-link"),
);

const nonceConsumeResultValidator = v.union(
  v.literal("valid"),
  v.literal("missing"),
  v.literal("consumed"),
  v.literal("expired"),
  v.literal("purpose_mismatch"),
);

export type NonceConsumeResult =
  | "valid"
  | "missing"
  | "consumed"
  | "expired"
  | "purpose_mismatch";

export const issueAppIntegrityNonce = async (
  ctx: MutationCtx,
  args: {
    nonce: string;
    purpose: AppIntegrityPurpose;
    createdAt: number;
    expiresAt: number;
  },
): Promise<void> => {
  const existing = await ctx.db
    .query("app_integrity_nonces")
    .withIndex("by_nonce", (query) => query.eq("nonce", args.nonce))
    .unique();
  if (existing) {
    throw new Error("App integrity nonce collision.");
  }
  await ctx.db.insert("app_integrity_nonces", args);
};

export const issueAppIntegrityNonceInternal = internalMutation({
  args: {
    nonce: v.string(),
    purpose: appIntegrityPurposeValidator,
    createdAt: v.number(),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await issueAppIntegrityNonce(ctx, args);
    return null;
  },
});

export const consumeAppIntegrityNonce = async (
  ctx: MutationCtx,
  args: { nonce: string; purpose: AppIntegrityPurpose; now: number },
): Promise<NonceConsumeResult> => {
  const row = await ctx.db
    .query("app_integrity_nonces")
    .withIndex("by_nonce", (query) => query.eq("nonce", args.nonce))
    .unique();
  if (!row) return "missing";
  if (row.consumedAt !== undefined) return "consumed";

  // Burn every known nonce before returning a verdict. A proof that fails its
  // purpose, expiry, or platform checks cannot be repaired and replayed.
  await ctx.db.patch(row._id, { consumedAt: args.now });
  if (row.purpose !== args.purpose) return "purpose_mismatch";
  if (row.expiresAt <= args.now) return "expired";
  return "valid";
};

export const consumeAppIntegrityNonceInternal = internalMutation({
  args: {
    nonce: v.string(),
    purpose: appIntegrityPurposeValidator,
    now: v.number(),
  },
  returns: nonceConsumeResultValidator,
  handler: async (ctx, args) => await consumeAppIntegrityNonce(ctx, args),
});

const purgeExpiredNoncesRef: FunctionReference<
  "mutation",
  "internal",
  { now?: number; limit?: number },
  { deleted: number; hasMore: boolean }
> = makeFunctionReference(
  "app_integrity:purgeExpiredNoncesInternal",
) as unknown as FunctionReference<
  "mutation",
  "internal",
  { now?: number; limit?: number },
  { deleted: number; hasMore: boolean }
>;

export const purgeExpiredNoncesInternal = internalMutation({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const limit = Math.max(1, Math.min(500, Math.floor(args.limit ?? 200)));
    const rows = await ctx.db
      .query("app_integrity_nonces")
      .withIndex("by_expiresAt", (query) => query.lte("expiresAt", now))
      .take(limit);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    const hasMore = rows.length === limit;
    if (hasMore) {
      await ctx.scheduler.runAfter(0, purgeExpiredNoncesRef, {
        now,
        limit,
      });
    }
    return { deleted: rows.length, hasMore };
  },
});

const appAttestKeyValidator = v.object({
  keyId: v.string(),
  publicKey: v.string(),
  signCount: v.number(),
  createdAt: v.number(),
  lastUsedAt: v.number(),
});

export const getAppAttestKeyInternal = internalQuery({
  args: { keyId: v.string() },
  returns: v.union(v.null(), appAttestKeyValidator),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("app_attest_keys")
      .withIndex("by_keyId", (query) => query.eq("keyId", args.keyId))
      .unique();
    if (!row) return null;
    return {
      keyId: row.keyId,
      publicKey: row.publicKey,
      signCount: row.signCount,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    };
  },
});

export const storeAppAttestKeyInternal = internalMutation({
  args: {
    keyId: v.string(),
    publicKey: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("app_attest_keys")
      .withIndex("by_keyId", (query) => query.eq("keyId", args.keyId))
      .unique();
    if (existing) return false;
    await ctx.db.insert("app_attest_keys", {
      keyId: args.keyId,
      publicKey: args.publicKey,
      signCount: 0,
      createdAt: args.now,
      lastUsedAt: args.now,
    });
    return true;
  },
});

export const advanceAppAttestSignCountInternal = internalMutation({
  args: {
    keyId: v.string(),
    expectedSignCount: v.number(),
    signCount: v.number(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("app_attest_keys")
      .withIndex("by_keyId", (query) => query.eq("keyId", args.keyId))
      .unique();
    if (
      !row ||
      row.signCount !== args.expectedSignCount ||
      !Number.isSafeInteger(args.signCount) ||
      args.signCount <= row.signCount
    ) {
      return false;
    }
    await ctx.db.patch(row._id, {
      signCount: args.signCount,
      lastUsedAt: args.now,
    });
    return true;
  },
});
