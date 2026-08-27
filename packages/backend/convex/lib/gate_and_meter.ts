import { v } from "convex/values";
import { internalMutation, type ActionCtx, type MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  runEnforceManagedUsageLimit,
  runResolveManagedModelAccess,
  type ManagedModelAccessResult,
} from "../billing";
import { runConsumeWebhookRateLimit } from "../rate_limits";
import {
  buildCapabilityDenial,
  hasCapability,
  toCapabilityAudience,
  type Capability,
  type CapabilityAudience,
  type CapabilityDenial,
} from "../capability_contract";
import { errorResponse, withCors } from "../http_shared/cors";
import { rateLimitResponse } from "../http_shared/webhook_controls";
import { capabilityRequiredResponse } from "../http_shared/capability";
import { scheduleManagedUsage, type ManagedUsageLogArgs } from "./managed_billing";

export type ManagedGateStep = "rate" | "capability" | "usage";

type GateFailure =
  | { ok: false; gate: "rate"; retryAfterMs: number }
  | { ok: false; gate: "capability"; denial: CapabilityDenial }
  | { ok: false; gate: "usage"; message: string; retryAfterMs: number };

type GateSuccess = { ok: true; access: ManagedModelAccessResult | null };

export type ManagedGateResult = GateSuccess | GateFailure;

const collapseAudience = (
  audience: ManagedModelAccessResult["modelAudience"],
): CapabilityAudience => toCapabilityAudience(audience) ?? "free";

export const enforceManagedGate = internalMutation({
  args: {
    ownerId: v.string(),
    order: v.array(
      v.union(v.literal("rate"), v.literal("capability"), v.literal("usage")),
    ),
    isAnonymous: v.optional(v.boolean()),
    rateLimit: v.optional(
      v.object({
        scope: v.string(),
        key: v.string(),
        limit: v.number(),
        windowMs: v.number(),
        blockMs: v.optional(v.number()),
      }),
    ),
    capability: v.optional(v.string()),
    usage: v.optional(
      v.object({
        minimumRemainingMicroCents: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx: MutationCtx, args): Promise<ManagedGateResult> => {
    let access: ManagedModelAccessResult | null = null;
    const ensureAccess = async (): Promise<ManagedModelAccessResult> => {
      if (!access) {
        access = await runResolveManagedModelAccess(ctx, {
          ownerId: args.ownerId,
          ...(args.isAnonymous !== undefined
            ? { isAnonymous: args.isAnonymous }
            : {}),
        });
      }
      return access;
    };

    for (const step of args.order) {
      if (step === "rate") {
        if (!args.rateLimit) continue;
        const rate = await runConsumeWebhookRateLimit(ctx, args.rateLimit);
        if (!rate.allowed) {
          return { ok: false, gate: "rate", retryAfterMs: rate.retryAfterMs };
        }
      } else if (step === "capability") {
        if (!args.capability) continue;
        const capability = args.capability as Capability;
        const resolved = await ensureAccess();
        const audience = collapseAudience(resolved.modelAudience);
        if (!hasCapability(audience, capability)) {
          return {
            ok: false,
            gate: "capability",
            denial: buildCapabilityDenial(capability, audience),
          };
        }
      } else if (step === "usage") {
        if (!args.usage) continue;
        const usage = await runEnforceManagedUsageLimit(ctx, {
          ownerId: args.ownerId,
          ...(args.usage.minimumRemainingMicroCents !== undefined
            ? { minimumRemainingMicroCents: args.usage.minimumRemainingMicroCents }
            : {}),
        });
        if (!usage.allowed) {
          return {
            ok: false,
            gate: "usage",
            message: usage.message,
            retryAfterMs: usage.retryAfterMs,
          };
        }
      }
    }

    return { ok: true, access };
  },
});

export type ManagedGateSpec = {
  ownerId: string;

  order: ManagedGateStep[];
  isAnonymous?: boolean;
  rateLimit?: {
    scope: string;
    key: string;
    limit: number;
    windowMs: number;
    blockMs?: number;
  };
  capability?: Capability;
  capabilityOptions?: { action?: string; docsUrl?: string };
  usage?: { minimumRemainingMicroCents?: number };
};

export type ManagedGateOutcome =
  | { ok: true; access: ManagedModelAccessResult | null }
  | { ok: false; response: Response };

export const runManagedGate = async (
  ctx: { runMutation: ActionCtx["runMutation"] },
  origin: string | null,
  spec: ManagedGateSpec,
): Promise<ManagedGateOutcome> => {
  const result = await ctx.runMutation(internal.lib.gate_and_meter.enforceManagedGate, {
    ownerId: spec.ownerId,
    order: spec.order,
    ...(spec.isAnonymous !== undefined ? { isAnonymous: spec.isAnonymous } : {}),
    ...(spec.rateLimit ? { rateLimit: spec.rateLimit } : {}),
    ...(spec.capability ? { capability: spec.capability } : {}),
    ...(spec.usage ? { usage: spec.usage } : {}),
  });

  if (result.ok) return { ok: true, access: result.access };

  switch (result.gate) {
    case "rate":
      return {
        ok: false,
        response: withCors(rateLimitResponse(result.retryAfterMs), origin),
      };
    case "capability":
      return {
        ok: false,
        response: capabilityRequiredResponse(
          result.denial,
          origin,
          spec.capabilityOptions,
        ),
      };
    case "usage":
      return { ok: false, response: errorResponse(429, result.message, origin) };
  }
};

export const meterManagedUsage = async (
  ctx: { scheduler: ActionCtx["scheduler"] },
  args: ManagedUsageLogArgs,
): Promise<void> => {
  try {
    await scheduleManagedUsage(ctx, args);
  } catch (error) {
    console.error(
      "[gate_and_meter] Failed to schedule managed usage accounting:",
      (error as Error).message,
    );
  }
};
