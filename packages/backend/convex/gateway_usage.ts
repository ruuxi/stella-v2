import { v, type Infer } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import {
  anonymousIpBucketDeviceId,
  consumeDeviceAllowanceAuthorized,
} from "./ai_proxy_data";
import {
  isAnonDeviceHashSaltMissingError,
  logMissingSaltOnce,
} from "./http_shared/anon_device";
import { getMaxAnonRequestsPerIp } from "./lib/anonymous_usage";
import { recordGatewayUsageRiskSignals } from "./risk";
import { managedModelAudienceValidator } from "./schema/gateway";

/**
 * Abuse accounting for model-gateway usage: risk signals and the anonymous
 * per-network request bucket. Charges settle in each owner's billing ledger
 * on cloud-builder; the gateway sends the same batch here only for these
 * counts, which move with abuse protection.
 */

const gatewayUsageOutcomeValidator = v.union(
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("aborted"),
);

/** The subset of `GatewayUsageEvent` abuse accounting needs; the route projects onto it. */
export const gatewayUsageEventValidator = v.object({
  requestId: v.string(),
  capabilityId: v.string(),
  ownerId: v.string(),
  ownerGeneration: v.string(),
  audience: managedModelAudienceValidator,
  agentType: v.string(),
  conversationId: v.optional(v.string()),
  resolvedModel: v.string(),
  usage: v.object({
    inputTokens: v.number(),
    outputTokens: v.number(),
    cachedInputTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    costMicroCents: v.optional(v.number()),
    reported: v.boolean(),
  }),
  chargedMicroCents: v.number(),
  outcome: gatewayUsageOutcomeValidator,
  startedAt: v.number(),
  finishedAt: v.number(),
  billable: v.boolean(),
  networkClass: v.optional(
    v.union(
      v.literal("hosting"),
      v.literal("vpn"),
      v.literal("residential"),
      v.literal("mobile"),
      v.literal("edu"),
      v.literal("unknown"),
    ),
  ),
  deviceKeyHash: v.optional(v.string()),
  anonymous: v.optional(
    v.object({
      ipHash: v.optional(v.string()),
    }),
  ),
});

type GatewayUsageEventInput = Infer<typeof gatewayUsageEventValidator>;

/** Anonymous requests also count against their network's bucket. */
const consumeGatewayAnonymousAllowance = async (
  ctx: MutationCtx,
  event: GatewayUsageEventInput,
) => {
  const ipHash = event.anonymous?.ipHash?.trim();
  if (!ipHash) return;
  try {
    await consumeDeviceAllowanceAuthorized(ctx, {
      deviceId: anonymousIpBucketDeviceId(ipHash),
      maxRequests: getMaxAnonRequestsPerIp(),
    });
  } catch (error) {
    if (!isAnonDeviceHashSaltMissingError(error)) throw error;
    logMissingSaltOnce("gateway-usage");
  }
};

/** Idempotent on `requestId` through `gateway_usage_receipts`. */
export const ingestGatewayUsageBatchInternal = internalMutation({
  args: {
    events: v.array(gatewayUsageEventValidator),
    now: v.number(),
  },
  returns: v.object({
    accepted: v.array(v.string()),
    duplicate: v.array(v.string()),
    rejected: v.array(v.object({ requestId: v.string(), reason: v.string() })),
  }),
  handler: async (ctx, args) => {
    const accepted: string[] = [];
    const duplicate: string[] = [];
    const seen = new Set<string>();
    for (const event of args.events) {
      if (seen.has(event.requestId)) {
        duplicate.push(event.requestId);
        continue;
      }
      seen.add(event.requestId);
      const existing = await ctx.db
        .query("gateway_usage_receipts")
        .withIndex("by_requestId", (q) => q.eq("requestId", event.requestId))
        .unique();
      if (existing) {
        duplicate.push(event.requestId);
        continue;
      }
      await recordGatewayUsageRiskSignals(ctx, event, args.now);
      if (event.billable && event.outcome !== "failed" && event.audience === "anonymous") {
        await consumeGatewayAnonymousAllowance(ctx, event);
      }
      await ctx.db.insert("gateway_usage_receipts", {
        requestId: event.requestId,
        ownerId: event.ownerId,
        ownerGeneration: event.ownerGeneration,
        chargedMicroCents: Math.max(0, Math.floor(event.chargedMicroCents)),
        createdAt: args.now,
      });
      accepted.push(event.requestId);
    }
    return { accepted, duplicate, rejected: [] };
  },
});
