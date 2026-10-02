import { ConvexError, v } from "convex/values";
import type { IdentityLevel } from "@stella/contracts/gateway/api";
import {
  internalAction,
  internalMutation,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { assertOwnerMigrationWriteAllowed } from "./auth";
import { internal } from "./_generated/api";
import { resolveBuilderEndpoint } from "./lib/builder_turns";
import { computeUsageCostMicroCents } from "./lib/billing_money";
import type { ManagedModelAudience } from "./agent/model";

/**
 * Convex's way to billing while some metered features still run here.
 * Billing lives in each owner's object on cloud-builder; this asks it what an
 * owner may spend and reports what they spent, over `/internal/billing/*`
 * with the builder service secret. It shrinks as media, voice, dictation and
 * search move to Cloudflare, and goes with them.
 */

export type BillingAccess = {
  plan: "free" | "go" | "pro";
  isAnonymous: boolean;
  identityLevel: IdentityLevel;
  unlimited: boolean;
  allowed: boolean;
  downgraded: boolean;
  audience: ManagedModelAudience;
  retryAfterMs: number;
  message: string;
  /** Spend available now; null when unlimited. */
  remainingMicroCents: number | null;
};

const BILLING_TIMEOUT_MS = 10_000;
const USAGE_RETRY_LIMIT = 8;

const callBilling = async <T>(action: string, body: Record<string, unknown>): Promise<T> => {
  const endpoint = resolveBuilderEndpoint();
  if (!endpoint) {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: "Billing is not configured (CLOUD_BUILDER_URL / BUILDER_SERVICE_SECRET).",
    });
  }
  let response: Response;
  try {
    response = await fetch(`${endpoint.url}/internal/billing/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
    });
  } catch {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: "Billing is temporarily unavailable. Try again.",
    });
  }
  if (!response.ok) {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: "Billing is temporarily unavailable. Try again.",
    });
  }
  return (await response.json()) as T;
};

/** What the owner may spend now. Actions only. */
export const fetchBillingAccess = (
  ownerId: string,
  options: { isAnonymous?: boolean } = {},
): Promise<BillingAccess> =>
  callBilling<BillingAccess>("access", {
    ownerId,
    ...(options.isAnonymous !== undefined ? { isAnonymous: options.isAnonymous } : {}),
  });

/** Report spend now. Actions only; idempotent on each record's id. */
export const recordBillingUsage = (
  ownerId: string,
  records: Array<{ id: string; costMicroCents: number }>,
): Promise<{ recorded: number; duplicate: number }> =>
  callBilling("usage", { ownerId, records });

/** Admin and test accounts: set a plan outside Stripe. */
export const setBillingPlan = (
  ownerId: string,
  input: { plan?: "free" | "go" | "pro"; usageMode?: "default" | "unlimited"; resetUsage?: boolean },
): Promise<{ ok: true }> => callBilling("plan", { ownerId, ...input });

/** Account deletion: end the owner's Stripe customer. */
export const closeBilling = (ownerId: string): Promise<{ ok: true }> =>
  callBilling("close", { ownerId });

/** Price token usage with the synced model prices. */
export const priceManagedUsage = async (
  ctx: Partial<Pick<ActionCtx, "runQuery">>,
  usage: {
    model: string;
    costMicroCents?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningTokens?: number;
  },
): Promise<number> => {
  if (usage.costMicroCents !== undefined) return Math.max(0, Math.floor(usage.costMicroCents));
  // Without a query context the package's baseline prices apply.
  const row = ctx.runQuery
    ? await ctx.runQuery(internal.model_prices.getManagedModelPrice, { model: usage.model })
    : null;
  return computeUsageCostMicroCents({
    model: usage.model,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(usage.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: usage.cacheWriteInputTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(row
      ? {
          price: {
            inputPerMillionUsd: row.inputPerMillionUsd,
            outputPerMillionUsd: row.outputPerMillionUsd,
            cacheReadPerMillionUsd: row.cacheReadPerMillionUsd,
            cacheWritePerMillionUsd: row.cacheWritePerMillionUsd,
            reasoningPerMillionUsd: row.reasoningPerMillionUsd,
          },
        }
      : {}),
  });
};

/**
 * Report spend once this mutation commits. The report retries with backoff;
 * its id makes every retry land once.
 */
export const scheduleBillingUsage = async (
  ctx: Pick<MutationCtx, "scheduler">,
  args: { ownerId: string; costMicroCents: number },
): Promise<void> => {
  const costMicroCents = Math.max(0, Math.floor(args.costMicroCents));
  if (costMicroCents <= 0) return;
  await ctx.scheduler.runAfter(0, internal.billing_bridge.recordUsageInternal, {
    ownerId: args.ownerId,
    id: crypto.randomUUID(),
    costMicroCents,
    attempt: 0,
  });
};

export const recordUsageInternal = internalAction({
  args: {
    ownerId: v.string(),
    id: v.string(),
    costMicroCents: v.number(),
    attempt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await recordBillingUsage(args.ownerId, [{ id: args.id, costMicroCents: args.costMicroCents }]);
    } catch (error) {
      if (args.attempt >= USAGE_RETRY_LIMIT) {
        console.error("[billing_bridge] usage report dropped", {
          ownerId: args.ownerId,
          id: args.id,
          costMicroCents: args.costMicroCents,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
      await ctx.scheduler.runAfter(
        Math.min(10 * 60_000, 2_000 * 2 ** args.attempt),
        internal.billing_bridge.recordUsageInternal,
        { ...args, attempt: args.attempt + 1 },
      );
    }
    return null;
  },
});

/**
 * The last check before a metered provider call: the owner's data generation
 * is still the admitted one, and no reset, deletion or account link is
 * moving it.
 */
export const assertDispatchAllowedInternal = internalMutation({
  args: { ownerId: v.string(), ownerGeneration: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    return null;
  },
});
