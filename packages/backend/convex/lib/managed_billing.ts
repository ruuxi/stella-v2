import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { ManagedModelAudience } from "../agent/model";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";
import {
  buildCapabilityDenial,
  hasCapability,
  toCapabilityAudience,
  type Capability,
  type CapabilityAudience,
  type CapabilityDenial,
} from "../capability_contract";
import type { ManagedUsageSummary } from "./managed_usage";
import type {
  ManagedDispatchGuard,
  ManagedDispatchOutcome,
} from "../runtime_ai/managed";
import {
  MANAGED_USAGE_BILLING_KIND,
  PARALLEL_SEARCH_FAST_BILLING_KIND,
  type ManagedDispatchBillingEnvelope,
  type ManagedDispatchCapturedUsage,
} from "./managed_dispatch";
import { hashSha256Hex } from "./crypto_utils";
import {
  fetchBillingAccess,
  priceManagedUsage,
  recordBillingUsage,
  type BillingAccess,
} from "../billing_bridge";

/**
 * Plan checks and metering for Convex code that still spends on managed
 * providers (media, music, synthesis, search, emoji packs). Billing itself
 * lives in each owner's object on cloud-builder; this facade keeps the shape
 * its callers were written against and talks to it through the bridge.
 */

type BillingCtx = {
  runQuery: ActionCtx["runQuery"];
  runMutation: ActionCtx["runMutation"];
};

/** The dispatch guard prices captured usage when it can query; else baseline prices apply. */
type DispatchCtx = Pick<BillingCtx, "runMutation"> & Partial<Pick<BillingCtx, "runQuery">>;

/** The longest one physical provider attempt may run. */
const PROVIDER_ATTEMPT_MAX_MS = 10 * 60_000;

export type ManagedUsageLogArgs = {
  ownerId: string;
  /** Captured before provider dispatch. */
  ownerGeneration: string;
  agentType: string;
  model: string;
  durationMs: number;
  success: boolean;
  conversationId?: Id<"conversations">;
  usage?: ManagedUsageSummary | null;
  costMicroCents?: number;
};

export type ManagedModelAccess = {
  allowed: boolean;
  plan: "free" | "go" | "pro";
  unlimited: boolean;
  downgraded: boolean;
  modelAudience: ManagedModelAudience;
  retryAfterMs: number;
  message: string;
  /** Lifecycle generation admitted with this managed request. */
  ownerGeneration: string;
};

const toManagedModelAccess = (
  access: BillingAccess,
  ownerGeneration: string,
): ManagedModelAccess => ({
  allowed: access.allowed,
  plan: access.plan,
  unlimited: access.unlimited,
  downgraded: access.downgraded,
  modelAudience: access.audience,
  retryAfterMs: access.retryAfterMs,
  message: access.message,
  ownerGeneration,
});

export async function checkManagedUsageLimit(
  ctx: Pick<BillingCtx, "runQuery">,
  ownerId: string,
  options?: {
    minimumRemainingMicroCents?: number;
  },
) {
  const { generation: ownerGeneration } = await assertOwnerDataAccessActive(ctx, ownerId);
  const access = await fetchBillingAccess(ownerId);
  const minimum = options?.minimumRemainingMicroCents ?? 0;
  const enough =
    access.remainingMicroCents === null || access.remainingMicroCents >= minimum;
  return {
    allowed: access.allowed && enough,
    plan: access.plan,
    unlimited: access.unlimited,
    retryAfterMs: access.retryAfterMs,
    message:
      access.allowed && !enough
        ? "Not enough managed usage left for this request."
        : access.message,
    ownerGeneration,
  };
}

export async function resolveManagedModelAccess(
  ctx: Pick<BillingCtx, "runQuery">,
  ownerId: string,
  options?: {
    isAnonymous?: boolean;
  },
): Promise<ManagedModelAccess> {
  const { generation: ownerGeneration } = await assertOwnerDataAccessActive(ctx, ownerId);
  const access = await fetchBillingAccess(ownerId, {
    ...(options?.isAnonymous !== undefined ? { isAnonymous: options.isAnonymous } : {}),
  });
  return toManagedModelAccess(access, ownerGeneration);
}

/**
 * Last check before upstream managed-provider I/O: the owner's data
 * generation is still the one admitted, so a reset or deletion that began
 * while the request was prepared stops it.
 */
export async function assertManagedUsageDispatchAllowed(
  ctx: Pick<BillingCtx, "runQuery">,
  args: { ownerId: string; ownerGeneration: string },
): Promise<void> {
  const { generation } = await assertOwnerDataAccessActive(ctx, args.ownerId);
  if (generation !== args.ownerGeneration) {
    throw new ConvexError({
      code: "OWNER_GENERATION_STALE",
      message: "This account was reset while the request was being prepared.",
    });
  }
}

/** A stable fingerprint for one logical request and its exact body. */
export async function bindManagedProviderRequest(
  _ctx: unknown,
  args: {
    ownerId: string;
    ownerGeneration: string;
    route: string;
    requestId: string;
    canonicalBody: string;
  },
): Promise<{ requestFingerprint: string; replayed: boolean }> {
  return {
    requestFingerprint: await hashSha256Hex(
      `${args.ownerId}\0${args.route}\0${args.requestId}\0${await hashSha256Hex(args.canonicalBody)}`,
    ),
    replayed: false,
  };
}

const managedDispatchAbortError = (message: string) => {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
};

/**
 * Meters one user-owned managed provider call. A fixed-cost attempt is
 * charged once it may have reached the provider; a variable-cost attempt is
 * charged its captured usage, or its declared fallback when the outcome left
 * the provider's work unknown.
 */
export function createManagedUsageDispatchGuard(
  ctx: DispatchCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    executionId?: string;
    spanExecution?: boolean;
    billing?: ManagedDispatchBillingEnvelope;
    /** A cloud turn the call runs for: refused once that turn has ended. */
    turnAuthority?: { turnId: string };
    beforeDispatch?: () => Promise<void>;
  },
): ManagedDispatchGuard {
  const runController = new AbortController();
  let finished = false;
  // A refused fence aborts the whole execution, so callers see an abort
  // rather than an ordinary provider failure.
  const abortOnFailure = async <T>(check: () => Promise<T>): Promise<T> => {
    try {
      return await check();
    } catch (error) {
      if (!runController.signal.aborted) runController.abort(error);
      throw error;
    }
  };

  return {
    signal: runController.signal,
    beginDispatch: async (attemptBilling) => {
      if (finished) throw managedDispatchAbortError("Managed provider execution is already terminal.");
      if (runController.signal.aborted) throw managedDispatchAbortError("Managed provider execution was aborted.");
      if (args.billing && attemptBilling) {
        throw new Error("Managed provider billing descriptor was supplied twice.");
      }
      const billing = attemptBilling ?? args.billing;
      const attemptId = crypto.randomUUID();
      let mayHaveDispatched = false;
      let captured: ManagedDispatchCapturedUsage | null = null;
      // A reset or deletion since admission stops the attempt before any I/O.
      await abortOnFailure(() =>
        ctx.runMutation(internal.billing_bridge.assertDispatchAllowedInternal, {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
        }),
      );
      await args.beforeDispatch?.();

      const charge = async (costMicroCents: number) => {
        if (costMicroCents <= 0) return;
        await recordBillingUsage(args.ownerId, [{ id: `attempt:${attemptId}`, costMicroCents }]);
      };

      return {
        signal: runController.signal,
        deadlineAt: Date.now() + PROVIDER_ATTEMPT_MAX_MS,
        ...(billing || args.turnAuthority
          ? {
              markMayHaveDispatched: async () => {
                if (args.turnAuthority) {
                  const turnId = args.turnAuthority.turnId;
                  await abortOnFailure(() =>
                    ctx.runMutation(internal.cloud_apps.assertActiveTurnDispatchInternal, {
                      ownerId: args.ownerId,
                      ownerGeneration: args.ownerGeneration,
                      turnId,
                      now: Date.now(),
                    }),
                  );
                }
                mayHaveDispatched = true;
              },
            }
          : {}),
        ...(billing?.kind === MANAGED_USAGE_BILLING_KIND
          ? {
              requiresUsageCapture: true,
              captureUsage: async (usage: ManagedDispatchCapturedUsage) => {
                captured = usage;
              },
            }
          : {}),
        settle: async (outcome: ManagedDispatchOutcome) => {
          if (!billing) return;
          if (billing.kind === PARALLEL_SEARCH_FAST_BILLING_KIND) {
            if (mayHaveDispatched) await charge(billing.chargeMicroCents);
            return;
          }
          const usage = captured as ManagedDispatchCapturedUsage | null;
          if (usage) {
            await charge(
              await priceManagedUsage(ctx, {
                model: billing.model,
                ...(usage.costMicroCents !== undefined ? { costMicroCents: usage.costMicroCents } : {}),
                ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
                ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
                ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
                ...(usage.cacheWriteInputTokens !== undefined
                  ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
                  : {}),
                ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
              }),
            );
            return;
          }
          if (mayHaveDispatched && outcome !== "failed" && outcome !== "succeeded") {
            await charge(billing.fallbackCostMicroCents);
          }
        },
      };
    },
    finishExecution: async () => {
      finished = true;
    },
  };
}

export async function assertManagedUsageAllowed(
  ctx: Pick<BillingCtx, "runQuery">,
  ownerId: string,
  options?: {
    isAnonymous?: boolean;
  },
) {
  const result = await resolveManagedModelAccess(ctx, ownerId, options);
  if (!result.allowed) {
    throw new ConvexError({
      code: "USAGE_LIMIT_REACHED",
      message: result.message,
      retryAfterMs: result.retryAfterMs,
    });
  }
  return result;
}

/**
 * Capability gating ("is this surface on your plan at all"), layered on top
 * of usage accounting. Routes run both checks.
 *
 * An audience we cannot place fails closed onto the weakest plan.
 */
const capabilityAudienceFor = (
  audience: ManagedModelAudience,
): CapabilityAudience => toCapabilityAudience(audience) ?? "free";

export type CapabilityAccess =
  | { allowed: true; access: ManagedModelAccess; audience: CapabilityAudience }
  | {
      allowed: false;
      access: ManagedModelAccess;
      audience: CapabilityAudience;
      denial: CapabilityDenial;
    };

export async function resolveCapabilityAccess(
  ctx: Pick<BillingCtx, "runQuery">,
  ownerId: string,
  capability: Capability,
  options?: {
    isAnonymous?: boolean;
  },
): Promise<CapabilityAccess> {
  const access = await resolveManagedModelAccess(ctx, ownerId, options);
  const audience = capabilityAudienceFor(access.modelAudience);
  if (hasCapability(audience, capability)) {
    return { allowed: true, access, audience };
  }
  return {
    allowed: false,
    access,
    audience,
    denial: buildCapabilityDenial(capability, audience),
  };
}

/**
 * Throwing variant for actions, which have no Response to return. The
 * `ConvexError` data is the payload the HTTP routes put in their 402 body.
 */
export async function assertPaidMediaTier(
  ctx: Pick<BillingCtx, "runQuery">,
  ownerId: string,
  capability: Capability,
  options?: {
    isAnonymous?: boolean;
  },
): Promise<ManagedModelAccess> {
  const result = await resolveCapabilityAccess(ctx, ownerId, capability, options);
  if (!result.allowed) {
    throw new ConvexError({
      code: result.denial.code,
      message: result.denial.message,
      capability: result.denial.capability,
      audience: result.denial.audience,
      minimumPlan: result.denial.minimumPlan,
    });
  }
  return result.access;
}

const usageCost = (ctx: Pick<BillingCtx, "runQuery">, args: ManagedUsageLogArgs) =>
  priceManagedUsage(ctx, {
    model: args.model,
    ...(args.costMicroCents !== undefined
      ? { costMicroCents: args.costMicroCents }
      : args.usage?.costMicroCents !== undefined
        ? { costMicroCents: args.usage.costMicroCents }
        : {}),
    ...(args.usage?.inputTokens !== undefined ? { inputTokens: args.usage.inputTokens } : {}),
    ...(args.usage?.outputTokens !== undefined ? { outputTokens: args.usage.outputTokens } : {}),
    ...(args.usage?.cachedInputTokens !== undefined
      ? { cachedInputTokens: args.usage.cachedInputTokens }
      : {}),
    ...(args.usage?.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: args.usage.cacheWriteInputTokens }
      : {}),
    ...(args.usage?.reasoningTokens !== undefined ? { reasoningTokens: args.usage.reasoningTokens } : {}),
  });

/** Charge spend now. */
export async function recordManagedUsage(
  ctx: Pick<BillingCtx, "runQuery">,
  args: ManagedUsageLogArgs,
) {
  const costMicroCents = await usageCost(ctx, args);
  if (costMicroCents <= 0) return;
  await recordBillingUsage(args.ownerId, [{ id: crypto.randomUUID(), costMicroCents }]);
}

/** Charge spend in the background; the report retries until it lands. */
export async function scheduleManagedUsage(
  ctx: Pick<BillingCtx, "runQuery"> & { scheduler: ActionCtx["scheduler"] },
  args: ManagedUsageLogArgs,
) {
  const costMicroCents = await usageCost(ctx, args);
  if (costMicroCents <= 0) return;
  await ctx.scheduler.runAfter(0, internal.billing_bridge.recordUsageInternal, {
    ownerId: args.ownerId,
    id: crypto.randomUUID(),
    costMicroCents,
    attempt: 0,
  });
}
