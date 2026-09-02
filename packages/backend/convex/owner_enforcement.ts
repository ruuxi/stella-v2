import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { GATEWAY_OWNER_ENFORCEMENT_PATH } from "@stella/contracts/gateway/api";
import type {
  GatewayOwnerEnforcementRequest,
  OwnerEnforcement,
  OwnerEnforcementStatus,
} from "@stella/contracts/gateway/usage";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { scheduleOwnerSnapshotChanged } from "./lib/owner_snapshot_notify";
import {
  ownerEnforcementStatusValidator,
  ownerEnforcementValidator,
  managedModelAudienceValidator,
} from "./schema/gateway";

const MODEL_GATEWAY_URL_ENV = "MODEL_GATEWAY_URL";
const GATEWAY_SERVICE_SECRET_ENV = "GATEWAY_SERVICE_SECRET";
const MAX_PUSH_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 60_000;

const getOwnerEnforcementStateRef = makeFunctionReference<
  "query",
  { ownerId: string },
  { enforcement: OwnerEnforcement; updatedAt: number | null }
>("owner_enforcement:getOwnerEnforcementStateInternal");

const pushOwnerEnforcementRef = makeFunctionReference<
  "action",
  { ownerId: string; expectedUpdatedAt: number; attempt: number },
  null
>("owner_enforcement:pushOwnerEnforcementToGateway");

const postAlertRef = makeFunctionReference<
  "action",
  {
    text: string;
    fields?: Record<string, string | number>;
  },
  null
>("alerts:postAlertInternal");

const readOwnerEnforcementRow = async (
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  ownerId: string,
) =>
  await ctx.db
    .query("owner_enforcement")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();

export const readOwnerEnforcement = async (
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  ownerId: string,
): Promise<OwnerEnforcement> => {
  const row = await readOwnerEnforcementRow(ctx, ownerId);
  if (!row || row.status === "ok") return { status: "ok" };
  if (row.until !== undefined && row.until <= Date.now()) {
    return { status: "ok" };
  }
  return {
    status: row.status,
    ...(row.until !== undefined ? { until: row.until } : {}),
    ...(row.reason.trim() ? { reason: row.reason } : {}),
  };
};

export const getOwnerEnforcementStateInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.object({
    enforcement: ownerEnforcementValidator,
    updatedAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const row = await readOwnerEnforcementRow(ctx, args.ownerId);
    return {
      enforcement: await readOwnerEnforcement(ctx, args.ownerId),
      updatedAt: row?.updatedAt ?? null,
    };
  },
});

export const getOwnerGatewayAdminStateInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.object({
    enforcement: ownerEnforcementValidator,
    unreleasedGrants: v.array(
      v.object({
        jti: v.string(),
        ownerGeneration: v.string(),
        deviceKeyHash: v.string(),
        audience: managedModelAudienceValidator,
        budgetMicroCents: v.number(),
        maxRequests: v.optional(v.number()),
        issuedAt: v.number(),
        expiresAt: v.number(),
        settledMicroCents: v.number(),
        settledRequests: v.number(),
      }),
    ),
    usageReceipts: v.array(
      v.object({
        requestId: v.string(),
        ownerGeneration: v.string(),
        chargedMicroCents: v.number(),
        createdAt: v.number(),
      }),
    ),
    riskSignals: v.array(
      v.object({
        ownerId: v.string(),
        window: v.union(v.literal("1h"), v.literal("24h")),
        requests: v.number(),
        chargedMicroCents: v.number(),
        mints: v.number(),
        hostingRequests: v.number(),
        distinctIps: v.number(),
        distinctConversations: v.number(),
        failedRequests: v.number(),
        sybilFlags: v.number(),
        score: v.number(),
        updatedAt: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const [enforcement, grants, receipts, riskSignals] = await Promise.all([
      readOwnerEnforcement(ctx, args.ownerId),
      ctx.db
        .query("gateway_capability_grants")
        .withIndex("by_owner_released", (q) =>
          q.eq("ownerId", args.ownerId).eq("released", false),
        )
        .order("desc")
        .take(100),
      ctx.db
        .query("gateway_usage_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .order("desc")
        .take(50),
      ctx.db
        .query("owner_risk_signals")
        .withIndex("by_owner_window", (q) => q.eq("ownerId", args.ownerId))
        .take(2),
    ]);
    return {
      enforcement,
      unreleasedGrants: grants.map((grant) => ({
        jti: grant.jti,
        ownerGeneration: grant.ownerGeneration,
        deviceKeyHash: grant.deviceKeyHash,
        audience: grant.audience,
        budgetMicroCents: grant.budgetMicroCents,
        ...(grant.maxRequests !== undefined
          ? { maxRequests: grant.maxRequests }
          : {}),
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt,
        settledMicroCents: grant.settledMicroCents,
        settledRequests: grant.settledRequests,
      })),
      usageReceipts: receipts.map((receipt) => ({
        requestId: receipt.requestId,
        ownerGeneration: receipt.ownerGeneration,
        chargedMicroCents: receipt.chargedMicroCents,
        createdAt: receipt.createdAt,
      })),
      riskSignals: riskSignals.map((signal) => ({
        ownerId: signal.ownerId,
        window: signal.window,
        requests: signal.requests,
        chargedMicroCents: signal.chargedMicroCents,
        mints: signal.mints,
        hostingRequests: signal.hostingRequests,
        distinctIps: signal.distinctIps,
        distinctConversations: signal.distinctConversations,
        failedRequests: signal.failedRequests,
        sybilFlags: signal.sybilFlags,
        score: signal.score,
        updatedAt: signal.updatedAt,
      })),
    };
  },
});

export const setOwnerEnforcementInternal = internalMutation({
  args: {
    ownerId: v.string(),
    status: ownerEnforcementStatusValidator,
    until: v.optional(v.number()),
    reason: v.string(),
    actor: v.string(),
  },
  returns: v.object({
    ownerId: v.string(),
    enforcement: ownerEnforcementValidator,
    updatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const ownerId = args.ownerId.trim();
    const reason = args.reason.trim();
    const actor = args.actor.trim();
    if (!ownerId || !reason || !actor) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "ownerId, reason, and actor are required.",
      });
    }
    if (args.until !== undefined && !Number.isFinite(args.until)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "until must be a finite timestamp.",
      });
    }
    const updatedAt = Date.now();
    const existing = await readOwnerEnforcementRow(ctx, ownerId);
    const previousStatus: OwnerEnforcementStatus = existing?.status ?? "ok";
    const fields = {
      ownerId,
      status: args.status,
      ...(args.until !== undefined ? { until: args.until } : {}),
      reason,
      actor,
      updatedAt,
    };
    if (existing) {
      await ctx.db.replace(existing._id, fields);
    } else {
      await ctx.db.insert("owner_enforcement", fields);
    }
    await scheduleOwnerSnapshotChanged(ctx, ownerId, "enforcement");
    if (previousStatus !== args.status) {
      await ctx.scheduler.runAfter(0, postAlertRef, {
        text: "Owner enforcement status changed",
        fields: {
          ownerId,
          from: previousStatus,
          to: args.status,
          actor,
          reason,
          ...(args.until !== undefined ? { until: args.until } : {}),
        },
      });
    }
    await ctx.scheduler.runAfter(0, pushOwnerEnforcementRef, {
      ownerId,
      expectedUpdatedAt: updatedAt,
      attempt: 1,
    });
    if (args.until !== undefined && args.until > updatedAt) {
      await ctx.scheduler.runAfter(
        args.until - updatedAt + 1,
        pushOwnerEnforcementRef,
        { ownerId, expectedUpdatedAt: updatedAt, attempt: 1 },
      );
    }
    return {
      ownerId,
      enforcement: await readOwnerEnforcement(ctx, ownerId),
      updatedAt,
    };
  },
});

export const pushOwnerEnforcementToGateway = internalAction({
  args: {
    ownerId: v.string(),
    expectedUpdatedAt: v.number(),
    attempt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state: { enforcement: OwnerEnforcement; updatedAt: number | null } =
      await ctx.runQuery(getOwnerEnforcementStateRef, {
        ownerId: args.ownerId,
      });
    if (state.updatedAt !== args.expectedUpdatedAt) return null;

    const gatewayUrl = process.env[MODEL_GATEWAY_URL_ENV]?.trim();
    const secret = process.env[GATEWAY_SERVICE_SECRET_ENV]?.trim();
    let failure = "gateway enforcement push is not configured";
    if (gatewayUrl && secret) {
      try {
        const body: GatewayOwnerEnforcementRequest = {
          ownerId: args.ownerId,
          enforcement: state.enforcement,
          updatedAt: args.expectedUpdatedAt,
        };
        const response = await fetch(
          `${gatewayUrl.replace(/\/+$/, "")}${GATEWAY_OWNER_ENFORCEMENT_PATH}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (response.ok) return null;
        failure = `gateway returned ${response.status}`;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }

    const attempt = Math.max(1, Math.floor(args.attempt));
    if (attempt < MAX_PUSH_ATTEMPTS) {
      const delayMs = Math.min(
        MAX_RETRY_DELAY_MS,
        1_000 * 2 ** Math.max(0, attempt - 1),
      );
      await ctx.scheduler.runAfter(delayMs, pushOwnerEnforcementRef, {
        ownerId: args.ownerId,
        expectedUpdatedAt: args.expectedUpdatedAt,
        attempt: attempt + 1,
      });
    } else {
      console.error(
        JSON.stringify({
          service: "convex-owner-enforcement",
          event: "gateway_push_failed",
          ownerId: args.ownerId,
          attempt,
          failure,
        }),
      );
    }
    return null;
  },
});

export type { OwnerEnforcementStatus };
