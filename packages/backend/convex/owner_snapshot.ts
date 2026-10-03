import { ConvexError, v } from "convex/values";
import {
  BUILDER_OWNER_SNAPSHOT_CHANGED_PATH,
  OWNER_SNAPSHOT_VERSION,
  type ControlPlaneOwnerSnapshot,
  type OwnerSnapshotChangedRequest,
} from "@stella/contracts/turn-plane/owner-snapshot";
import type { IdentityLevel } from "@stella/contracts/gateway/api";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { hasOwnerMigrationWriteFence, resolveOwnerAccountAction } from "./auth";
import { resolveBuilderEndpoint } from "./lib/builder_turns";
import { readOwnerDataAccessState } from "./owner_lifecycle";
import {
  identityLevelValidator,
  resolveIdentityLevel,
} from "./lib/identity_level";

/**
 * The owner snapshot: the one control-plane read the cloud-builder's owner
 * gate performs (`@stella/contracts/turn-plane/owner-snapshot`). Everything a
 * turn admission needs to know about an owner's identity — write fence,
 * generation and identity level — in one document the gate caches for
 * `ttlMs`; Convex pushes a fresh replacement on change. The gate overlays the
 * owner's own data (billing, enforcement, engines, devices) from its database.
 */

export const OWNER_SNAPSHOT_TTL_MS = 300_000;

export const ownerSnapshotValidator = v.object({
  v: v.literal(1),
  ownerId: v.string(),
  ownerGeneration: v.string(),
  isAnonymous: v.boolean(),
  identityLevel: identityLevelValidator,
  writable: v.boolean(),
  fetchedAt: v.number(),
  ttlMs: v.number(),
});

type OwnerSnapshotFields = {
  ownerId: string;
  ownerGeneration: string;
  isAnonymous: boolean;
  identityLevel: IdentityLevel;
  writable: boolean;
};

const ownerSnapshotFieldsValidator = v.object({
  ownerId: v.string(),
  ownerGeneration: v.string(),
  isAnonymous: v.boolean(),
  identityLevel: identityLevelValidator,
  writable: v.boolean(),
});

/** Reads every owner-gate field in one consistent query transaction. */
export const getOwnerSnapshotFieldsInternal = internalQuery({
  args: {
    ownerId: v.string(),
    isAnonymous: v.boolean(),
  },
  returns: ownerSnapshotFieldsValidator,
  handler: async (ctx, args): Promise<OwnerSnapshotFields> => {
    const ownerId = args.ownerId;
    const access = await readOwnerDataAccessState(ctx, ownerId);
    const migrationFenced = await hasOwnerMigrationWriteFence(ctx, ownerId);
    const identityLevel = args.isAnonymous
      ? 0
      : await resolveIdentityLevel(ctx, ownerId);
    const writable = access.allowed && !migrationFenced;
    return {
      ownerId,
      ownerGeneration: access.generation,
      isAnonymous: args.isAnonymous,
      identityLevel,
      writable,
    };
  },
});

/**
 * The query reads the complete snapshot in one transaction. This action is
 * only the action-to-query bridge used by HTTP routes and change pushes.
 */
export const getOwnerSnapshotInternal = internalAction({
  args: { ownerId: v.string() },
  returns: ownerSnapshotValidator,
  handler: async (ctx, args): Promise<ControlPlaneOwnerSnapshot> => {
    const account = await resolveOwnerAccountAction(ctx, args.ownerId);
    if (!account) {
      throw new ConvexError("Owner account is unknown.");
    }
    const fields: OwnerSnapshotFields = await ctx.runQuery(
      internal.owner_snapshot.getOwnerSnapshotFieldsInternal,
      {
        ownerId: args.ownerId,
        isAnonymous: account.isAnonymous,
      },
    );
    return {
      v: OWNER_SNAPSHOT_VERSION,
      ...fields,
      fetchedAt: Date.now(),
      ttlMs: OWNER_SNAPSHOT_TTL_MS,
    };
  },
});

const changeReasonValidator = v.union(
  v.literal("billing"),
  v.literal("generation"),
  v.literal("engine"),
  v.literal("pairing"),
  v.literal("device"),
  v.literal("enforcement"),
  v.literal("manual"),
);

/**
 * Best-effort snapshot push to the cloud-builder owner gate. Computing the
 * snapshot and posting it are both allowed to fail: the action logs the
 * reason, sends a snapshot-less stale marker when it can, and never throws.
 * Schedule it from the mutation that made the change so the push cannot
 * outrun the write it announces.
 */
export const notifyOwnerSnapshotChanged = internalAction({
  args: { ownerId: v.string(), reason: changeReasonValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const endpoint = resolveBuilderEndpoint();
    if (!endpoint) return null;
    let snapshot: ControlPlaneOwnerSnapshot | undefined;
    try {
      snapshot = await ctx.runAction(
        internal.owner_snapshot.getOwnerSnapshotInternal,
        { ownerId: args.ownerId },
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          service: "convex-owner-snapshot",
          event: "snapshot_changed_snapshot_failed",
          reason: args.reason,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    const body: OwnerSnapshotChangedRequest = {
      ownerId: args.ownerId,
      reason: args.reason,
      ...(snapshot ? { snapshot } : {}),
    };
    try {
      const response = await fetch(
        `${endpoint.url}${BUILDER_OWNER_SNAPSHOT_CHANGED_PATH}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${endpoint.secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        console.warn(
          JSON.stringify({
            service: "convex-owner-snapshot",
            event: "snapshot_changed_rejected",
            reason: args.reason,
            status: response.status,
          }),
        );
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          service: "convex-owner-snapshot",
          event: "snapshot_changed_failed",
          reason: args.reason,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return null;
  },
});
