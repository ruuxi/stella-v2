import { v, type Infer } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import { assertSensitiveSessionPolicy, getConnectedUserIdOrNull } from "../auth";

type MigrationStatus = "pending" | "running" | "failed" | "complete";

export const ownershipMigrationStatusValidator = v.union(
  v.null(),
  v.object({
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("failed"),
      v.literal("complete"),
    ),
    updatedAt: v.number(),
    error: v.optional(v.string()),
  }),
);

export type OwnershipMigrationStatus = Infer<
  typeof ownershipMigrationStatusValidator
>;

/**
 * Whether the caller's latest account-link transfer still fences its
 * conversations. Clients hold conversation selection while this is true; a
 * failed transfer also offers a retry.
 */
export const ownershipMigrationBlocksSelection = (
  migration: OwnershipMigrationStatus,
): boolean =>
  migration?.status === "pending" ||
  migration?.status === "running" ||
  migration?.status === "failed";

/**
 * The caller's latest account-link transfer, as the destination owner. Shared
 * by `auth_migration:getMyOwnershipMigrationStatus` and the shell bootstrap
 * query so the two can never disagree about what blocks conversation
 * selection. Anonymous callers never receive a transfer, so they read null.
 */
export const readMyOwnershipMigrationStatus = async (
  ctx: QueryCtx,
): Promise<OwnershipMigrationStatus> => {
  const identity = await ctx.auth.getUserIdentity();
  const ownerId = await getConnectedUserIdOrNull(ctx);
  if (!ownerId) return null;
  await assertSensitiveSessionPolicy(ctx, identity);
  const latestForStatus = async (status: MigrationStatus) =>
    (
      await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_toOwnerId_and_status_and_updatedAt", (q) =>
          q.eq("toOwnerId", ownerId).eq("status", status),
        )
        .order("desc")
        .take(1)
    )[0];
  const [pending, running, failed, complete] = await Promise.all([
    latestForStatus("pending"),
    latestForStatus("running"),
    latestForStatus("failed"),
    latestForStatus("complete"),
  ]);
  const active =
    pending && running
      ? pending.updatedAt >= running.updatedAt
        ? pending
        : running
      : (pending ?? running);
  const row = active ?? failed ?? complete;
  return row
    ? {
        status: row.status,
        updatedAt: row.updatedAt,
        ...(row.lastError
          ? {
              error:
                row.status === "failed"
                  ? "Account linking stopped because source and destination data could not be merged safely."
                  : "Account data is still moving and will retry automatically.",
            }
          : {}),
      }
    : null;
};
