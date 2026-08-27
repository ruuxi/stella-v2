/**
 * Shared "gate + meter" helper for the managed HTTP audio routes.
 *
 * Background: routes like dictation (STT), realtime voice session mint, and
 * the Inworld SDP exchange used to run their pre-checks as a sequence of
 * separate `ctx.runMutation` calls — usage-limit, then rate-limit, and for the
 * voice routes a capability gate too. Each `runMutation` from an action is its
 * own Convex transaction with its own commit, so a route paid for two-to-three
 * serial round-trips before it could even start the upstream provider request.
 * On a latency-sensitive path (stop-to-text dictation, time-to-first-audio for
 * voice) that overhead is pure dead time.
 *
 * `enforceManagedGate` collapses those pre-checks into a SINGLE transaction:
 * one action->mutation round-trip, one commit. Every gate is still enforced,
 * and each gate runs in the exact order the caller specifies, returning on the
 * first failure — so the HTTP status/body a client sees for an over-limit,
 * rate-limited, or off-plan request is byte-for-byte identical to the old
 * multi-mutation flow. The only thing that changes is how many commits happen.
 *
 * `runManagedGate` is the action-side wrapper: it maps a gate failure onto the
 * same `Response` the routes built by hand (429 rate-limit, 429 usage-limit,
 * 402 capability), so a route replaces ~15 lines of serial checks with one
 * call.
 *
 * Billing deliberately does not live in this gate module. Every paid physical
 * provider attempt owns one durable receipt, preventing an admitted request
 * from escaping or duplicating its charge across a crash or lifecycle fence.
 */
import { v } from "convex/values";
import {
  internalMutation,
  type ActionCtx,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import {
  runEnforceManagedUsageLimit,
  runResolveManagedModelAccess,
  type ManagedModelAccessResult,
} from "../billing";
import { assertOwnerMigrationWriteAllowed } from "../auth";
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

export type ManagedGateStep = "rate" | "capability" | "usage";

type GateFailure =
  | { ok: false; gate: "rate"; retryAfterMs: number }
  | { ok: false; gate: "capability"; denial: CapabilityDenial }
  | { ok: false; gate: "usage"; message: string; retryAfterMs: number };

type GateSuccess = {
  ok: true;
  access: ManagedModelAccessResult | null;
  /** Captured in the same transaction as the managed gate. */
  ownerGeneration: string;
};

export type ManagedGateResult = GateSuccess | GateFailure;

const managedModelAccessResultValidator = v.object({
  allowed: v.boolean(),
  plan: v.union(v.literal("free"), v.literal("go"), v.literal("pro")),
  unlimited: v.boolean(),
  downgraded: v.boolean(),
  modelAudience: v.union(
    v.literal("anonymous"),
    v.literal("free"),
    v.literal("go"),
    v.literal("pro"),
    v.literal("go_fallback"),
    v.literal("pro_fallback"),
  ),
  retryAfterMs: v.number(),
  message: v.string(),
});

const managedGateResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    access: v.union(v.null(), managedModelAccessResultValidator),
    ownerGeneration: v.string(),
  }),
  v.object({
    ok: v.literal(false),
    gate: v.literal("rate"),
    retryAfterMs: v.number(),
  }),
  v.object({
    ok: v.literal(false),
    gate: v.literal("capability"),
    denial: v.object({
      code: v.literal("CAPABILITY_REQUIRED"),
      capability: v.union(
        v.literal("image_generation"),
        v.literal("video_generation"),
        v.literal("audio_generation"),
        v.literal("three_d_generation"),
      ),
      audience: v.union(
        v.literal("anonymous"),
        v.literal("free"),
        v.literal("go"),
        v.literal("pro"),
      ),
      minimumPlan: v.union(
        v.null(),
        v.literal("anonymous"),
        v.literal("free"),
        v.literal("go"),
        v.literal("pro"),
      ),
      message: v.string(),
    }),
  }),
  v.object({
    ok: v.literal(false),
    gate: v.literal("usage"),
    message: v.string(),
    retryAfterMs: v.number(),
  }),
);

// Mirror of `capabilityAudienceFor` in `lib/managed_billing.ts`: fail closed
// onto the weakest plan for an audience we cannot place, rather than handing
// out a paid surface on a vocabulary drift.
const collapseAudience = (
  audience: ManagedModelAccessResult["modelAudience"],
): CapabilityAudience => toCapabilityAudience(audience) ?? "free";

/**
 * Runs the usage-limit + rate-limit (+ optional capability) gates for a
 * managed HTTP route in ONE transaction. Reads billing at most once per gate
 * that needs it; every gate is still enforced. Checks run in `order` and the
 * first failure short-circuits, so response precedence matches the legacy
 * serial flow exactly.
 */
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
  returns: managedGateResultValidator,
  handler: async (ctx: MutationCtx, args): Promise<ManagedGateResult> => {
    // Capture the lifecycle generation in the gate transaction. The action
    // carries this through final provider dispatch and asynchronous metering,
    // so an account reset cannot be followed by a delayed write into its
    // reopened generation.
    const { generation: ownerGeneration } =
      await assertOwnerMigrationWriteAllowed(ctx, args.ownerId);
    let access: ManagedModelAccessResult | null = null;
    const ensureAccess = async (): Promise<ManagedModelAccessResult> => {
      if (!access) {
        access = await runResolveManagedModelAccess(ctx, {
          ownerId: args.ownerId,
          ownerGeneration,
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
          ownerGeneration,
          ...(args.usage.minimumRemainingMicroCents !== undefined
            ? {
                minimumRemainingMicroCents:
                  args.usage.minimumRemainingMicroCents,
              }
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

    return { ok: true, access, ownerGeneration };
  },
});

export type ManagedGateSpec = {
  ownerId: string;
  /** Gate execution order; first failure wins. Preserves response precedence. */
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
  | {
      ok: true;
      access: ManagedModelAccessResult | null;
      ownerGeneration: string;
    }
  | { ok: false; response: Response };

/**
 * Action-side entry point. Runs the combined gate mutation and, on failure,
 * returns the exact `Response` the route would have built for that gate:
 *   - rate       -> 429 with `Retry-After` (same as `rateLimitResponse`)
 *   - usage      -> 429 `{ error: <limit message> }` (same as `errorResponse`)
 *   - capability -> 402 machine-readable denial (same as capability route)
 */
export const runManagedGate = async (
  ctx: { runMutation: ActionCtx["runMutation"] },
  origin: string | null,
  spec: ManagedGateSpec,
): Promise<ManagedGateOutcome> => {
  const result = await ctx.runMutation(
    internal.lib.gate_and_meter.enforceManagedGate,
    {
      ownerId: spec.ownerId,
      order: spec.order,
      ...(spec.isAnonymous !== undefined
        ? { isAnonymous: spec.isAnonymous }
        : {}),
      ...(spec.rateLimit ? { rateLimit: spec.rateLimit } : {}),
      ...(spec.capability ? { capability: spec.capability } : {}),
      ...(spec.usage ? { usage: spec.usage } : {}),
    },
  );

  if (result.ok) {
    return {
      ok: true,
      access: result.access,
      ownerGeneration: result.ownerGeneration,
    };
  }

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
      return {
        ok: false,
        response: errorResponse(429, result.message, origin),
      };
    default:
      return {
        ok: false,
        response: errorResponse(500, "Managed access gate failed.", origin),
      };
  }
};
