import { v } from "convex/values";
import { hashesMatch } from "./lib/handoff_crypto";
import {
  internalMutation,
  internalQuery,
} from "./_generated/server";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

/** How long after completion a handoff may still be claimed. */
const CLAIM_WINDOW_MS = 3 * 60_000;
/** Wrong-secret attempts before the row is destroyed. */
const MAX_CLAIM_ATTEMPTS = 5;

export const createPendingLinkRequest = internalMutation({
  args: {
    email: v.string(),
    requestId: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
    claimHash: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("auth_link_requests", {
      email: args.email,
      requestId: args.requestId,
      status: "pending",
      expiresAt: args.expiresAt,
      createdAt: args.createdAt,
      claimHash: args.claimHash,
    });
  },
});

/**
 * `nowMs` comes from the caller (the polling httpAction) so the expiry check
 * is deterministic — calling `Date.now()` in a query handler would
 * invalidate Convex's reactive cache for every subscriber on every read.
 */
export const getLinkRequestStatus = internalQuery({
  args: {
    requestId: v.string(),
    nowMs: v.number(),
  },
  handler: async (ctx, args) => {
    if (!REQUEST_ID_PATTERN.test(args.requestId)) {
      return null;
    }
    const record = await ctx.db
      .query("auth_link_requests")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!record) {
      return null;
    }
    if (args.nowMs > record.expiresAt) {
      return { status: "expired" as const };
    }
    if (record.status === "completed") {
      return { status: "completed" as const };
    }
    return { status: "pending" as const };
  },
});

export const completeLinkRequest = internalMutation({
  args: {
    requestId: v.string(),
    tokenEnc: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("auth_link_requests")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!record) {
      return { ok: false, reason: "not_found" };
    }
    if (record.status !== "pending") {
      return { ok: false, reason: "already_completed" };
    }
    if (Date.now() > record.expiresAt) {
      return { ok: false, reason: "expired" };
    }
    await ctx.db.patch(record._id, {
      status: "completed",
      completedAt: Date.now(),
      tokenEnc: args.tokenEnc,
    });
    return { ok: true };
  },
});

/**
 * Atomically verify the claim secret and consume the handoff.
 *
 * Single-use: the row is deleted on success, and destroyed after too many
 * wrong attempts. Returns the encrypted token for the caller to decrypt —
 * this mutation never sees plaintext.
 */
export const claimLinkRequest = internalMutation({
  args: {
    requestId: v.string(),
    claimHash: v.string(),
    nowMs: v.number(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("auth_link_requests")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!record) {
      return { ok: false as const };
    }

    const attempts = (record.claimAttempts ?? 0) + 1;
    if (attempts > MAX_CLAIM_ATTEMPTS) {
      await ctx.db.delete(record._id);
      return { ok: false as const };
    }

    const fresh =
      record.status === "completed" &&
      record.completedAt !== undefined &&
      args.nowMs <= record.completedAt + CLAIM_WINDOW_MS &&
      args.nowMs <= record.expiresAt;
    const matches = hashesMatch(record.claimHash, args.claimHash);

    if (!fresh || !matches || !record.tokenEnc) {
      await ctx.db.patch(record._id, { claimAttempts: attempts });
      return { ok: false as const };
    }

    // Single use: the handoff dies with the claim.
    await ctx.db.delete(record._id);
    return { ok: true as const, tokenEnc: record.tokenEnc };
  },
});

export const cleanupLinkRequest = internalMutation({
  args: {
    requestId: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("auth_link_requests")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (record) {
      await ctx.db.delete(record._id);
    }
  },
});
