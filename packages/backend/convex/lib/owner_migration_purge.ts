import { makeFunctionReference } from "convex/server";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { linkedSourcePurgeOperationId } from "./auth_migration_paths";

export type OwnerMigrationPurgeFence = {
  ownerId: string;
  operationId: string;
  generation: string;
  leaseId: string;
  mode: "reset" | "delete";
};

type SourceDependencies = {
  sourceOwnerIds: string[];
  sourceDependencies: Array<{
    ownerId: string;
    authUserId?: string;
    authUserEmail?: string;
  }>;
  waitingSourceOwnerIds: string[];
  hasMore: boolean;
};

type BegunDeletePurge = {
  operationId: string;
  generation: string;
  mode: "reset" | "delete";
  stage: "core" | "cloud" | "complete";
};

const MAX_SOURCE_PURGES_PER_RUN = 8;
const MAX_DEPENDENCY_PASSES = 16;

// This helper is imported by account_deletion.ts itself. A typed string
// reference avoids making that module's generated API type recursively depend
// on its own action initializer.
const purgeOwnerCloudDataRef = makeFunctionReference<
  "action",
  { ownerId: string; operationId: string; generation: string },
  null
>("account_deletion:purgeOwnerCloudData");

/**
 * Permanently purge unfinished source owners before a destination reset or
 * deletion minimizes their A -> B migration locators.
 *
 * The auth-migration mutation retains each mapping as dependency debt until
 * the child's durable delete job is exactly complete. This action helper only
 * begins bounded child work; any conflict/failure leaves both the destination
 * fence and the mapping in place for the normal owner-purge retry sweep.
 */
export const purgeOwnerMigrationSourceDependencies = async (
  ctx: ActionCtx,
  fence: OwnerMigrationPurgeFence,
): Promise<void> => {
  let sourcePurges = 0;
  for (let pass = 0; pass < MAX_DEPENDENCY_PASSES; pass += 1) {
    const dependencies: SourceDependencies = await ctx.runMutation(
      internal.auth_migration.drainOwnerAuthMigrationSourceDependenciesInternal,
      fence,
    );
    if (dependencies.waitingSourceOwnerIds.length > 0) {
      throw new Error(
        "Owner purge is waiting for a linked source-owner purge to complete.",
      );
    }
    if (dependencies.sourceOwnerIds.length === 0) {
      if (!dependencies.hasMore) return;
      continue;
    }

    const sourceLocators = new Map(
      dependencies.sourceDependencies.map((dependency) => [
        dependency.ownerId,
        dependency,
      ]),
    );
    for (const sourceOwnerId of dependencies.sourceOwnerIds) {
      if (sourceOwnerId === fence.ownerId) {
        throw new Error(
          "Owner purge found a cyclic auth-migration source dependency.",
        );
      }
      if (sourcePurges >= MAX_SOURCE_PURGES_PER_RUN) {
        throw new Error(
          "Owner purge reached its linked source-owner work budget; durable retry is required.",
        );
      }
      sourcePurges += 1;

      await ctx.runMutation(
        internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
        {
          ...fence,
          stage: "core",
          now: Date.now(),
        },
      );
      const childOperationId = await linkedSourcePurgeOperationId(
        fence.operationId,
        sourceOwnerId,
      );
      const child: BegunDeletePurge = await ctx.runMutation(
        internal.owner_lifecycle.beginOwnerDataPurgeInternal,
        {
          ownerId: sourceOwnerId,
          operationId: childOperationId,
          mode: "delete",
          ...(sourceLocators.get(sourceOwnerId)?.authUserId
            ? {
                authUserId: sourceLocators.get(sourceOwnerId)!.authUserId,
                authUserEmail:
                  sourceLocators.get(sourceOwnerId)!.authUserEmail,
              }
            : {}),
          now: Date.now(),
        },
      );
      if (child.mode !== "delete") {
        throw new Error(
          "Linked source owner could not be fenced for permanent deletion.",
        );
      }
      await ctx.runAction(purgeOwnerCloudDataRef, {
        ownerId: sourceOwnerId,
        operationId: child.operationId,
        generation: child.generation,
      });
    }
  }
  throw new Error(
    "Owner purge could not exhaust linked auth-migration dependencies within its bounded pass budget.",
  );
};
