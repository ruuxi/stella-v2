import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { prepareOwnershipMigrationForOwners } from "./auth_migration";
import { assertOwnerDataWriteAllowed } from "./owner_lifecycle";
import { tokenIdentifierForBetterAuthUserId } from "./auth";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;
const migrationStatusValidator = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("failed"),
  v.literal("complete"),
);

export const createBrowserSocialHandoff = internalMutation({
  args: {
    requestId: v.string(),
    provider: v.literal("google"),
    fromOwnerId: v.string(),
    returnOrigin: v.string(),
    returnTo: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({
      ok: v.literal(false),
      reason: v.literal("owner_fenced"),
    }),
  ),
  handler: async (ctx, args) => {
    if (!REQUEST_ID_PATTERN.test(args.requestId)) {
      throw new Error("Invalid browser auth handoff id.");
    }
    let fromOwnerGeneration: string;
    try {
      ({ generation: fromOwnerGeneration } = await assertOwnerDataWriteAllowed(
        ctx,
        args.fromOwnerId,
      ));
    } catch {
      return { ok: false as const, reason: "owner_fenced" as const };
    }
    await ctx.db.insert("auth_browser_handoffs", {
      ...args,
      fromOwnerGeneration,
      status: "pending",
    });
    return { ok: true as const };
  },
});

export const consumeBrowserSocialHandoff = internalMutation({
  args: { requestId: v.string(), nowMs: v.number() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      returnOrigin: v.string(),
      returnTo: v.string(),
    }),
    v.object({
      ok: v.literal(false),
      reason: v.union(
        v.literal("not_found"),
        v.literal("expired"),
        v.literal("consumed"),
        v.literal("owner_fenced"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    if (!REQUEST_ID_PATTERN.test(args.requestId)) {
      return { ok: false as const, reason: "not_found" as const };
    }
    const record = await ctx.db
      .query("auth_browser_handoffs")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!record) {
      return { ok: false as const, reason: "not_found" as const };
    }
    if (record.status === "consumed") {
      return { ok: false as const, reason: "consumed" as const };
    }
    if (args.nowMs >= record.expiresAt) {
      return { ok: false as const, reason: "expired" as const };
    }
    if (!record.fromOwnerGeneration) {
      return { ok: false as const, reason: "owner_fenced" as const };
    }
    try {
      await assertOwnerDataWriteAllowed(
        ctx,
        record.fromOwnerId,
        record.fromOwnerGeneration,
      );
    } catch {
      return { ok: false as const, reason: "owner_fenced" as const };
    }
    await ctx.db.patch(record._id, {
      status: "consumed",
      consumedAt: args.nowMs,
    });
    return {
      ok: true as const,
      returnOrigin: record.returnOrigin,
      returnTo: record.returnTo,
    };
  },
});

export const cleanupBrowserSocialHandoff = internalMutation({
  args: { requestId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!REQUEST_ID_PATTERN.test(args.requestId)) return null;
    const record = await ctx.db
      .query("auth_browser_handoffs")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (record) await ctx.db.delete(record._id);
    return null;
  },
});

export const createPendingLinkRequest = internalMutation({
  args: {
    email: v.string(),
    requestId: v.string(),
    fromOwnerId: v.optional(v.string()),
    fromAuthUserId: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (
      args.fromAuthUserId &&
      (!args.fromOwnerId ||
        tokenIdentifierForBetterAuthUserId(args.fromAuthUserId) !==
          args.fromOwnerId)
    ) {
      throw new Error("Anonymous auth locator does not match its owner.");
    }
    const fromOwnerGeneration = args.fromOwnerId
      ? (await assertOwnerDataWriteAllowed(ctx, args.fromOwnerId)).generation
      : undefined;
    await ctx.db.insert("auth_link_requests", {
      email: args.email,
      requestId: args.requestId,
      status: "pending",
      ...(args.fromOwnerId ? { fromOwnerId: args.fromOwnerId } : {}),
      ...(args.fromAuthUserId
        ? { fromAuthUserId: args.fromAuthUserId }
        : {}),
      ...(fromOwnerGeneration ? { fromOwnerGeneration } : {}),
      expiresAt: args.expiresAt,
      createdAt: args.createdAt,
    });
    return null;
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
  returns: v.union(
    v.null(),
    v.object({ status: v.literal("expired") }),
    v.object({ status: v.literal("pending") }),
    v.object({
      status: v.literal("completed"),
      sessionCookie: v.optional(v.string()),
      migrationStatus: v.optional(migrationStatusValidator),
      migrationError: v.optional(v.string()),
    }),
  ),
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
      if (!record.toOwnerId || !record.toOwnerGeneration) {
        return null;
      }
      try {
        await assertOwnerDataWriteAllowed(
          ctx,
          record.toOwnerId,
          record.toOwnerGeneration,
        );
        if (record.fromOwnerId) {
          if (!record.fromOwnerGeneration) return null;
          await assertOwnerDataWriteAllowed(
            ctx,
            record.fromOwnerId,
            record.fromOwnerGeneration,
          );
        }
      } catch {
        return null;
      }
      const migration = record.ownershipMigrationId
        ? await ctx.db.get(record.ownershipMigrationId)
        : null;
      const migrationStatus = record.ownershipMigrationId
        ? (migration?.status ?? "failed")
        : undefined;
      return {
        status: "completed" as const,
        ...(record.sessionCookie
          ? { sessionCookie: record.sessionCookie }
          : {}),
        ...(migrationStatus ? { migrationStatus } : {}),
        ...(migration?.lastError
          ? { migrationError: migration.lastError }
          : record.ownershipMigrationId && !migration
            ? {
                migrationError:
                  "Ownership migration marker is missing. Retry sign-in.",
              }
            : {}),
      };
    }
    return { status: "pending" as const };
  },
});

export const completeLinkRequest = internalMutation({
  args: {
    requestId: v.string(),
    sessionCookie: v.string(),
    toOwnerId: v.string(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      replayed: v.boolean(),
      migrationStatus: v.optional(migrationStatusValidator),
    }),
    v.object({
      ok: v.literal(false),
      reason: v.union(
        v.literal("not_found"),
        v.literal("expired"),
        v.literal("identity_mismatch"),
        v.literal("owner_fenced"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("auth_link_requests")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!record) {
      return { ok: false as const, reason: "not_found" as const };
    }
    let toOwnerGeneration: string;
    try {
      ({ generation: toOwnerGeneration } = await assertOwnerDataWriteAllowed(
        ctx,
        args.toOwnerId,
        record.status === "completed" ? record.toOwnerGeneration : undefined,
      ));
      if (record.fromOwnerId) {
        if (!record.fromOwnerGeneration) {
          return { ok: false as const, reason: "owner_fenced" as const };
        }
        await assertOwnerDataWriteAllowed(
          ctx,
          record.fromOwnerId,
          record.fromOwnerGeneration,
        );
      }
    } catch {
      return { ok: false as const, reason: "owner_fenced" as const };
    }
    if (record.status === "completed") {
      if (!record.toOwnerId || record.toOwnerId !== args.toOwnerId) {
        return { ok: false as const, reason: "identity_mismatch" as const };
      }
      const migration = record.ownershipMigrationId
        ? await ctx.db.get(record.ownershipMigrationId)
        : null;
      if (
        record.fromOwnerId &&
        (!migration ||
          migration.fromOwnerId !== record.fromOwnerId ||
          migration.toOwnerId !== record.toOwnerId)
      ) {
        return { ok: false as const, reason: "identity_mismatch" as const };
      }
      return {
        ok: true as const,
        replayed: true,
        ...(record.ownershipMigrationId
          ? { migrationStatus: migration?.status ?? ("failed" as const) }
          : {}),
      };
    }
    if (Date.now() > record.expiresAt) {
      return { ok: false as const, reason: "expired" as const };
    }

    let ownershipMigrationId: Id<"auth_owner_migrations"> | undefined;
    let migrationStatus:
      | "pending"
      | "running"
      | "failed"
      | "complete"
      | undefined;
    if (record.fromOwnerId) {
      // This helper publishes the canonical owner-lifecycle generation fence,
      // creates or reuses the single source-bound migration, and schedules its
      // worker in this same transaction. The connected cookie is not visible
      // to polling unless that complete owner binding commits successfully.
      ownershipMigrationId = await prepareOwnershipMigrationForOwners(ctx, {
        fromOwnerId: record.fromOwnerId,
        toOwnerId: args.toOwnerId,
        ...(record.fromAuthUserId
          ? { sourceAuthUserId: record.fromAuthUserId }
          : {}),
      });
      const migration = await ctx.db.get(ownershipMigrationId);
      if (!migration) {
        throw new Error("Ownership migration marker was not persisted.");
      }
      migrationStatus = migration.status;
    }

    await ctx.db.patch(record._id, {
      status: "completed",
      sessionCookie: args.sessionCookie,
      toOwnerId: args.toOwnerId,
      toOwnerGeneration,
      ...(ownershipMigrationId ? { ownershipMigrationId } : {}),
    });
    return {
      ok: true as const,
      replayed: false,
      ...(migrationStatus ? { migrationStatus } : {}),
    };
  },
});

export const cleanupLinkRequest = internalMutation({
  args: {
    requestId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("auth_link_requests")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (record) {
      await ctx.db.delete(record._id);
    }
    return null;
  },
});
