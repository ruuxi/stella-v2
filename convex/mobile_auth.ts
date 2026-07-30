import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { planLinkCompletion } from "./lib/mobile_auth_link";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;
const migrationStatusValidator = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("failed"),
  v.literal("complete"),
);

export const createPendingLinkRequest = internalMutation({
  args: {
    email: v.string(),
    requestId: v.string(),
    fromOwnerId: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("auth_link_requests", {
      email: args.email,
      requestId: args.requestId,
      status: "pending",
      ...(args.fromOwnerId ? { fromOwnerId: args.fromOwnerId } : {}),
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
    v.object({
      status: v.literal("expired"),
    }),
    v.object({
      status: v.literal("pending"),
    }),
    v.object({
      status: v.literal("completed"),
      ott: v.string(),
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
    if (record.status === "completed" && record.ott) {
      const migration = record.ownershipMigrationId
        ? await ctx.db.get(record.ownershipMigrationId)
        : null;
      const migrationStatus = record.ownershipMigrationId
        ? (migration?.status ?? "failed")
        : undefined;
      return {
        status: "completed" as const,
        ott: record.ott,
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
    ott: v.string(),
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
    if (record.status === "completed") {
      if (record.toOwnerId && record.toOwnerId !== args.toOwnerId) {
        return { ok: false as const, reason: "identity_mismatch" as const };
      }
      const migration = record.ownershipMigrationId
        ? await ctx.db.get(record.ownershipMigrationId)
        : null;
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

    const existingMigration =
      record.fromOwnerId && record.fromOwnerId !== args.toOwnerId
        ? await ctx.db
            .query("auth_owner_migrations")
            .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
              q
                .eq("fromOwnerId", record.fromOwnerId!)
                .eq("toOwnerId", args.toOwnerId),
            )
            .unique()
        : null;
    const plan = planLinkCompletion({
      requestStatus: record.status,
      ...(record.fromOwnerId ? { fromOwnerId: record.fromOwnerId } : {}),
      toOwnerId: args.toOwnerId,
      ...(existingMigration
        ? { existingMigrationStatus: existingMigration.status }
        : {}),
    });

    let ownershipMigrationId = existingMigration?._id;
    let migrationStatus = existingMigration?.status;
    if (plan.kind === "complete_with_migration") {
      if (!ownershipMigrationId) {
        const now = Date.now();
        ownershipMigrationId = await ctx.db.insert("auth_owner_migrations", {
          fromOwnerId: record.fromOwnerId!,
          toOwnerId: args.toOwnerId,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        });
        migrationStatus = "pending";
      }
      if (plan.schedule) {
        // Scheduler writes participate in this mutation's transaction. The
        // connected cookie cannot become poll-visible unless both the durable
        // migration marker and its wake-up have committed.
        await ctx.scheduler.runAfter(
          0,
          internal.auth_migration.migrateOwnership,
          {
            fromOwnerId: record.fromOwnerId!,
            toOwnerId: args.toOwnerId,
          },
        );
      }
    }

    await ctx.db.patch(record._id, {
      status: "completed",
      ott: args.ott,
      sessionCookie: args.sessionCookie,
      toOwnerId: args.toOwnerId,
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
