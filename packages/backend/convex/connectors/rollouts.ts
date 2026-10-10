import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { ROLLOUT_MODES, type ConnectorRollout, type RolloutMode } from "./routing";

const rolloutModeValidator = v.union(
  v.literal("composio_only"),
  v.literal("shadow"),
  v.literal("first_party_canary"),
  v.literal("first_party_preferred"),
  v.literal("first_party_only"),
  v.literal("disabled"),
);

const rolloutReturnValidator = v.object({
  connectorId: v.string(),
  mode: rolloutModeValidator,
  canaryPercent: v.optional(v.number()),
  saltVersion: v.optional(v.number()),
  allowedFallbacks: v.optional(v.array(v.string())),
  minimumClientVersion: v.optional(v.string()),
  routeVersion: v.number(),
});

const SAFE_CONNECTOR_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;

const toRollout = (row: {
  connectorId: string;
  mode: RolloutMode;
  canaryPercent?: number;
  saltVersion?: number;
  allowedFallbacks?: string[];
  minimumClientVersion?: string;
  routeVersion: number;
}): ConnectorRollout => ({
  connectorId: row.connectorId,
  mode: row.mode,
  canaryPercent: row.canaryPercent,
  saltVersion: row.saltVersion,
  allowedFallbacks: row.allowedFallbacks,
  minimumClientVersion: row.minimumClientVersion,
  routeVersion: row.routeVersion,
});

export const getConnectorRollout = internalQuery({
  args: { connectorId: v.string() },
  returns: v.union(v.null(), rolloutReturnValidator),
  handler: async (ctx, args) => {
    const connectorId = args.connectorId.trim().toLowerCase();
    const row = await ctx.db
      .query("connector_rollouts")
      .withIndex("by_connectorId", (q) => q.eq("connectorId", connectorId))
      .unique();
    return row ? toRollout(row) : null;
  },
});

export const listConnectorRollouts = internalQuery({
  args: {},
  returns: v.array(rolloutReturnValidator),
  handler: async (ctx) => {
    const rows = await ctx.db.query("connector_rollouts").take(500);
    return rows.map(toRollout);
  },
});

/**
 * Admin-only rollout write (invoked from the admin HTTP route). Bumps
 * `routeVersion` on every change so in-flight audit rows can be tied to the
 * exact route that produced them.
 */
export const setConnectorRollout = internalMutation({
  args: {
    connectorId: v.string(),
    mode: rolloutModeValidator,
    canaryPercent: v.optional(v.number()),
    saltVersion: v.optional(v.number()),
    allowedFallbacks: v.optional(v.array(v.string())),
    minimumClientVersion: v.optional(v.string()),
  },
  returns: rolloutReturnValidator,
  handler: async (ctx, args) => {
    const connectorId = args.connectorId.trim().toLowerCase();
    if (!SAFE_CONNECTOR_ID.test(connectorId)) {
      throw new Error("Invalid connector id");
    }
    if (
      args.canaryPercent !== undefined &&
      (args.canaryPercent < 0 || args.canaryPercent > 100)
    ) {
      throw new Error("canaryPercent must be between 0 and 100");
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("connector_rollouts")
      .withIndex("by_connectorId", (q) => q.eq("connectorId", connectorId))
      .unique();
    const routeVersion = (existing?.routeVersion ?? 0) + 1;
    const patch = {
      connectorId,
      mode: args.mode,
      canaryPercent: args.canaryPercent,
      saltVersion: args.saltVersion,
      allowedFallbacks: args.allowedFallbacks,
      minimumClientVersion: args.minimumClientVersion,
      routeVersion,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("connector_rollouts", patch);
    }
    return toRollout(patch);
  },
});
