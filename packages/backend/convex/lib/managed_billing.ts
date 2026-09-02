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
  type ManagedDispatchBillingEnvelope,
  type ManagedDispatchCapturedUsage,
} from "./managed_dispatch";
import { hashSha256Hex } from "./crypto_utils";

type BillingMutationCtx = {
  runMutation: ActionCtx["runMutation"];
};

type BillingAdmissionCtx = BillingMutationCtx & {
  runQuery: ActionCtx["runQuery"];
};

type BillingSchedulerCtx = {
  scheduler: ActionCtx["scheduler"];
};

// Must stay comfortably below billing.ts' 60s managed execution lease.
const MANAGED_EXECUTION_HEARTBEAT_INTERVAL_MS = 15_000;

export type ManagedUsageLogArgs = {
  ownerId: string;
  /** Captured before provider dispatch; fences delayed scheduled metering. */
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

const toLogPayload = (args: ManagedUsageLogArgs) => ({
  ownerId: args.ownerId,
  ownerGeneration: args.ownerGeneration,
  agentType: args.agentType,
  model: args.model,
  durationMs: args.durationMs,
  success: args.success,
  ...(args.conversationId ? { conversationId: args.conversationId } : {}),
  ...(args.usage?.inputTokens !== undefined
    ? { inputTokens: args.usage.inputTokens }
    : {}),
  ...(args.usage?.outputTokens !== undefined
    ? { outputTokens: args.usage.outputTokens }
    : {}),
  ...(args.usage?.totalTokens !== undefined
    ? { totalTokens: args.usage.totalTokens }
    : {}),
  ...(args.usage?.cachedInputTokens !== undefined
    ? { cachedInputTokens: args.usage.cachedInputTokens }
    : {}),
  ...(args.usage?.cacheWriteInputTokens !== undefined
    ? { cacheWriteInputTokens: args.usage.cacheWriteInputTokens }
    : {}),
  ...(args.usage?.reasoningTokens !== undefined
    ? { reasoningTokens: args.usage.reasoningTokens }
    : {}),
  ...(args.costMicroCents !== undefined
    ? { costMicroCents: args.costMicroCents }
    : args.usage?.costMicroCents !== undefined
      ? { costMicroCents: args.usage.costMicroCents }
      : {}),
});

export async function checkManagedUsageLimit(
  ctx: BillingAdmissionCtx,
  ownerId: string,
  options?: {
    minimumRemainingMicroCents?: number;
  },
) {
  const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
    ctx,
    ownerId,
  );
  const result = await ctx.runMutation(
    internal.billing.enforceManagedUsageLimit,
    {
      ownerId,
      ownerGeneration,
      ...(options?.minimumRemainingMicroCents !== undefined
        ? { minimumRemainingMicroCents: options.minimumRemainingMicroCents }
        : {}),
    },
  );
  return { ...result, ownerGeneration };
}

export async function resolveManagedModelAccess(
  ctx: BillingAdmissionCtx,
  ownerId: string,
  options?: {
    isAnonymous?: boolean;
  },
): Promise<ManagedModelAccess> {
  const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
    ctx,
    ownerId,
  );
  const access = await ctx.runMutation(
    internal.billing.resolveManagedModelAccess,
    {
      ownerId,
      ownerGeneration,
      ...(options?.isAnonymous !== undefined
        ? { isAnonymous: options.isAnonymous }
        : {}),
    },
  );
  return { ...access, ownerGeneration };
}

/**
 * Last transaction-plane check before upstream managed-provider I/O.
 *
 * The generation was captured at admission; this closes the period spent
 * preparing a request, so a reset/delete that begins just before `fetch`
 * cannot let that request cross the provider boundary.
 */
export async function assertManagedUsageDispatchAllowed(
  ctx: BillingMutationCtx,
  args: { ownerId: string; ownerGeneration: string },
): Promise<void> {
  await ctx.runMutation(
    internal.billing.assertManagedUsageDispatchAllowedInternal,
    args,
  );
}

/**
 * Persist a logical request/body binding before constructing a physical
 * managed-provider attempt. The returned fingerprint is the receipt identity;
 * an identical replay gets the same value and changed canonical bytes fail.
 */
export async function bindManagedProviderRequest(
  ctx: BillingMutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    route: string;
    requestId: string;
    canonicalBody: string;
  },
): Promise<{ requestFingerprint: string; replayed: boolean }> {
  return await ctx.runMutation(
    internal.billing.bindManagedProviderRequestInternal,
    {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      route: args.route,
      requestId: args.requestId,
      bodyFingerprint: await hashSha256Hex(args.canonicalBody),
      now: Date.now(),
    },
  );
}

const managedDispatchAbortError = (message: string, cause?: unknown) => {
  const error = new Error(message);
  error.name = "AbortError";
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
};

/**
 * Durable per-physical-attempt barrier for user-owned managed provider I/O.
 * The billing claim is acquired before any additional row-specific fence, so
 * reset/delete/migration must wait while the final preparation and request are
 * live. A failed secondary fence settles the claim before propagating.
 */
export function createManagedUsageDispatchGuard(
  ctx: BillingMutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    executionId?: string;
    /** Keep a renewable DB lease across model-adjacent nested tool work. */
    spanExecution?: boolean;
    /** Immutable exact-attempt billing authority for fixed-cost provider I/O. */
    billing?: ManagedDispatchBillingEnvelope;
    /**
     * Optional cloud turn rechecked by the durable pre-I/O billing marker: the
     * turn capability already authenticated the caller, this only refuses once
     * Convex has seen the turn end. Not persisted as billing attribution.
     */
    turnAuthority?: { turnId: string };
    beforeDispatch?: () => Promise<void>;
  },
): ManagedDispatchGuard {
  const executionId = args.executionId ?? crypto.randomUUID();
  const runController = new AbortController();
  const executionLeaseId = crypto.randomUUID();
  let executionStarted = false;
  let executionFinished = false;
  let executionStart: Promise<void> | undefined;
  let executionMonitor: Promise<void> | undefined;
  let wakeExecutionMonitor: (() => void) | undefined;
  let executionLeaseExpiresAt = 0;
  let executionHardExpiresAt = 0;
  let executionAuthorityTimer: ReturnType<typeof setTimeout> | undefined;

  const abortRun = (error: unknown) => {
    if (!runController.signal.aborted) {
      runController.abort(
        error instanceof Error
          ? error
          : managedDispatchAbortError(
              "Managed provider execution lost dispatch authority.",
              error,
            ),
      );
    }
  };

  const armExecutionAuthorityTimer = () => {
    if (executionAuthorityTimer) clearTimeout(executionAuthorityTimer);
    if (!executionStarted || executionFinished) return;
    const deadlineAt = Math.min(
      executionLeaseExpiresAt,
      executionHardExpiresAt,
    );
    executionAuthorityTimer = setTimeout(
      () =>
        abortRun(
          managedDispatchAbortError(
            "Managed model/tool execution authority expired.",
          ),
        ),
      Math.max(1, deadlineAt - Date.now()),
    );
  };

  const ensureExecutionLease = async () => {
    if (!args.spanExecution || executionStarted) return;
    executionStart ??= (async () => {
      const timing = await ctx.runMutation(
        internal.billing.acquireManagedExecutionInternal,
        {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          executionId,
          leaseId: executionLeaseId,
          now: Date.now(),
        },
      );
      executionStarted = true;
      executionLeaseExpiresAt = timing.leaseExpiresAt;
      executionHardExpiresAt = timing.hardExpiresAt;
      armExecutionAuthorityTimer();
      executionMonitor = (async () => {
        while (!executionFinished && !runController.signal.aborted) {
          await Promise.race([
            new Promise<void>((resolve) =>
              setTimeout(resolve, MANAGED_EXECUTION_HEARTBEAT_INTERVAL_MS),
            ),
            new Promise<void>((resolve) => {
              wakeExecutionMonitor = resolve;
            }),
          ]);
          wakeExecutionMonitor = undefined;
          if (executionFinished || runController.signal.aborted) break;
          try {
            const renewed = await ctx.runMutation(
              internal.billing.heartbeatManagedExecutionInternal,
              {
                ownerId: args.ownerId,
                ownerGeneration: args.ownerGeneration,
                executionId,
                leaseId: executionLeaseId,
                now: Date.now(),
              },
            );
            if (!renewed) {
              throw new Error("Managed execution lease could not be renewed.");
            }
            executionLeaseExpiresAt = renewed.leaseExpiresAt;
            executionHardExpiresAt = renewed.hardExpiresAt;
            armExecutionAuthorityTimer();
          } catch (error) {
            abortRun(error);
          }
        }
      })();
    })().catch((error) => {
      abortRun(error);
      throw error;
    });
    await executionStart;
  };

  return {
    signal: runController.signal,
    beginDispatch: async (attemptBilling) => {
      if (executionFinished) {
        throw managedDispatchAbortError(
          "Managed provider execution is already terminal.",
        );
      }
      if (runController.signal.aborted) {
        throw runController.signal.reason instanceof Error
          ? runController.signal.reason
          : managedDispatchAbortError(
              "Managed provider execution was aborted.",
            );
      }
      await ensureExecutionLease();

      if (args.billing && attemptBilling) {
        throw new Error(
          "Managed provider billing descriptor was supplied twice.",
        );
      }
      const billing = attemptBilling ?? args.billing;
      const attemptId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const timing = await ctx
        .runMutation(internal.billing.acquireManagedProviderDispatchInternal, {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          executionId,
          attemptId,
          leaseId,
          ...(billing ? { billing } : {}),
          now: Date.now(),
        })
        .catch((error) => {
          abortRun(error);
          throw error;
        });

      const settle = async (outcome: ManagedDispatchOutcome) => {
        try {
          const settled = await ctx.runMutation(
            internal.billing.settleManagedProviderDispatchInternal,
            {
              ownerId: args.ownerId,
              ownerGeneration: args.ownerGeneration,
              executionId,
              attemptId,
              leaseId,
              outcome,
              now: Date.now(),
            },
          );
          if (!settled) {
            throw new Error("Managed provider dispatch lease disappeared.");
          }
        } catch (error) {
          abortRun(error);
          throw error;
        }
      };

      try {
        await args.beforeDispatch?.();
      } catch (error) {
        try {
          await settle("aborted");
        } finally {
          abortRun(error);
        }
        throw error;
      }

      return {
        signal: runController.signal,
        deadlineAt: timing.providerDeadlineAt,
        ...(billing || args.turnAuthority
          ? {
              markMayHaveDispatched: async () => {
                try {
                  if (billing) {
                    const marked = await ctx.runMutation(
                      internal.billing
                        .markManagedProviderDispatchMayHaveStartedInternal,
                      {
                        ownerId: args.ownerId,
                        ownerGeneration: args.ownerGeneration,
                        executionId,
                        attemptId,
                        leaseId,
                        billing,
                        ...(args.turnAuthority
                          ? { turnAuthority: args.turnAuthority }
                          : {}),
                        now: Date.now(),
                      },
                    );
                    if (!marked) {
                      throw new Error(
                        "Managed provider dispatch marker disappeared.",
                      );
                    }
                  } else {
                    await ctx.runMutation(
                      internal.cloud_apps.assertActiveTurnDispatchInternal,
                      {
                        ownerId: args.ownerId,
                        ownerGeneration: args.ownerGeneration,
                        turnId: args.turnAuthority!.turnId,
                        now: Date.now(),
                      },
                    );
                  }
                } catch (error) {
                  abortRun(error);
                  throw error;
                }
              },
            }
          : {}),
        ...(billing?.kind === MANAGED_USAGE_BILLING_KIND
          ? {
              requiresUsageCapture: true,
              captureUsage: async (usage: ManagedDispatchCapturedUsage) => {
                try {
                  const captured = await ctx.runMutation(
                    internal.billing
                      .captureManagedProviderDispatchUsageInternal,
                    {
                      ownerId: args.ownerId,
                      ownerGeneration: args.ownerGeneration,
                      executionId,
                      attemptId,
                      leaseId,
                      billing,
                      usage,
                      now: Date.now(),
                    },
                  );
                  if (!captured) {
                    throw new Error(
                      "Managed provider usage receipt disappeared.",
                    );
                  }
                } catch (error) {
                  abortRun(error);
                  throw error;
                }
              },
            }
          : {}),
        settle,
      };
    },
    finishExecution: async (outcome) => {
      if (!args.spanExecution || executionFinished) return;
      executionFinished = true;
      if (executionAuthorityTimer) clearTimeout(executionAuthorityTimer);
      wakeExecutionMonitor?.();
      await executionMonitor?.catch(() => undefined);
      if (!executionStarted) return;
      const settled = await ctx.runMutation(
        internal.billing.settleManagedExecutionInternal,
        {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          executionId,
          leaseId: executionLeaseId,
          outcome,
          now: Date.now(),
        },
      );
      if (!settled) {
        const error = new Error("Managed execution lease disappeared.");
        abortRun(error);
        throw error;
      }
    },
  };
}

export async function assertManagedUsageAllowed(
  ctx: BillingAdmissionCtx,
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
 * Capability gating — "is this surface on your plan at all".
 *
 * Strictly layered on top of usage accounting, never a replacement for it:
 * a denial here does not touch the per-user media cost tracking in
 * `media_billing.ts`, and passing here says nothing about whether the
 * caller is still inside their spend window. Routes run both checks.
 */

/**
 * Fail closed on an audience we cannot place. `toCapabilityAudience`
 * returns `null` only for a value outside the managed union, which means
 * the audience vocabulary drifted — treat that as the weakest plan rather
 * than handing out Pro surfaces on a typo.
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
  ctx: BillingAdmissionCtx,
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
 * Throwing variant for Convex actions/mutations, which have no Response to
 * return. The `ConvexError` data is the same payload the HTTP routes put in
 * their 402 body, so the desktop parses one shape either way.
 */
export async function assertPaidMediaTier(
  ctx: BillingAdmissionCtx,
  ownerId: string,
  capability: Capability,
  options?: {
    isAnonymous?: boolean;
  },
): Promise<ManagedModelAccess> {
  const result = await resolveCapabilityAccess(
    ctx,
    ownerId,
    capability,
    options,
  );
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

export async function recordManagedUsage(
  ctx: BillingMutationCtx,
  args: ManagedUsageLogArgs,
) {
  return await ctx.runMutation(
    internal.billing.logManagedUsage,
    toLogPayload(args),
  );
}

export async function scheduleManagedUsage(
  ctx: BillingSchedulerCtx,
  args: ManagedUsageLogArgs,
) {
  await ctx.scheduler.runAfter(
    0,
    internal.billing.logManagedUsage,
    toLogPayload(args),
  );
}
