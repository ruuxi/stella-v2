import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";

type TestDbCtx = Pick<MutationCtx, "db">;

const readyValues = (now: number, targetCount: number) => ({
  protocolVersion: 1,
  revision: 1,
  notBefore: now - 1,
  legacyRowFenceComplete: true,
  legacyRowFenceTargetIndex: targetCount,
  phase: "ready" as const,
  startAfter: undefined,
  verifyDirty: false,
  listedCount: 0,
  deletedCount: 0,
  protectedCount: 0,
  createdAt: now - 1,
  updatedAt: now,
});

export const seedReadyPurgeBackupSweep = async (
  ctx: TestDbCtx,
  args: {
    ownerId: string;
    operationId: string;
    generation: string;
    now?: number;
  },
) => {
  const now = args.now ?? Date.now();
  return await ctx.db.insert("backup_legacy_r2_sweeps", {
    ...readyValues(now, 2),
    scopeKey: `purge:${encodeURIComponent(args.ownerId)}:${args.operationId}`,
    kind: "purge",
    operationId: args.operationId,
    sourceOwnerId: args.ownerId,
    sourceOwnerGeneration: args.generation,
    goal: "empty",
    targetIndex: 2,
  });
};

export const seedReadyMigrationBackupSweep = async (
  ctx: TestDbCtx,
  args: {
    migrationId: Id<"auth_owner_migrations">;
    now?: number;
  },
) => {
  const migration = await ctx.db.get(args.migrationId);
  if (
    !migration ||
    !migration.fromOwnerGeneration ||
    !migration.toOwnerGeneration
  ) {
    throw new Error("Migration test fixture lacks exact owner generations.");
  }
  const now = args.now ?? Date.now();
  return await ctx.db.insert("backup_legacy_r2_sweeps", {
    ...readyValues(now, 4),
    scopeKey: `migration:${encodeURIComponent(migration.fromOwnerId)}:${String(migration._id)}`,
    kind: "migration",
    operationId: String(migration._id),
    sourceOwnerId: migration.fromOwnerId,
    sourceOwnerGeneration: migration.fromOwnerGeneration,
    destinationOwnerId: migration.toOwnerId,
    destinationOwnerGeneration: migration.toOwnerGeneration,
    planRevision: migration.planRevision ?? 1,
    goal: "preserve_refs",
    targetIndex: 4,
  });
};
