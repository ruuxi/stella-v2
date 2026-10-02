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
 * The plan and usage verdicts come from the owner's billing ledger on
 * cloud-builder (one bridge call, made by the action before the mutation);
 * the rate limit and the lifecycle generation stay in the one transaction.
 */
import { v, type ObjectType } from "convex/values";
import {
  internalMutation,
  type ActionCtx,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { assertOwnerMigrationWriteAllowed } from "../auth";
import { fetchBillingAccess } from "../billing_bridge";
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

export type GateFailure =
  | { ok: false; gate: "rate"; retryAfterMs: number }
  | { ok: false; gate: "capability"; denial: CapabilityDenial }
  | { ok: false; gate: "usage"; message: string; retryAfterMs: number };

export type ManagedModelAccessResult = {
  allowed: boolean;
  plan: "free" | "go" | "pro";
  unlimited: boolean;
  downgraded: boolean;
  modelAudience:
    | "anonymous"
    | "free"
    | "go"
    | "pro"
    | "go_fallback"
    | "pro_fallback";
  retryAfterMs: number;
  message: string;
};

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

const enforceManagedGateArgs = {
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
  /** The billing verdict the action fetched; required by capability and usage steps. */
  access: v.optional(managedModelAccessResultValidator),
  /** Spend available when the action fetched `access`; null when unlimited. */
  remainingMicroCents: v.optional(v.union(v.number(), v.null())),
};

/**
 * Runs the usage-limit + rate-limit (+ optional capability) gates for a
 * managed HTTP route in ONE transaction. Reads billing at most once per gate
 * that needs it; every gate is still enforced. Checks run in `order` and the
 * first failure short-circuits, so response precedence matches the legacy
 * serial flow exactly.
 */
export const runEnforceManagedGate = async (
  ctx: MutationCtx,
  args: ObjectType<typeof enforceManagedGateArgs>,
): Promise<ManagedGateResult> => {
  // Capture the lifecycle generation in the gate transaction. The action
  // carries this through final provider dispatch and asynchronous metering,
  // so an account reset cannot be followed by a delayed write into its
  // reopened generation.
  const { generation: ownerGeneration } =
    await assertOwnerMigrationWriteAllowed(ctx, args.ownerId);
  const access: ManagedModelAccessResult | null = args.access ?? null;

  for (const step of args.order) {
    if (step === "rate") {
      if (!args.rateLimit) continue;
      const rate = await runConsumeWebhookRateLimit(ctx, args.rateLimit);
      if (!rate.allowed) {
        return { ok: false, gate: "rate", retryAfterMs: rate.retryAfterMs };
      }
    } else if (step === "capability") {
      if (!args.capability) continue;
      if (!access) throw new Error("The capability gate needs a billing verdict.");
      const capability = args.capability as Capability;
      const audience = collapseAudience(access.modelAudience);
      if (!hasCapability(audience, capability)) {
        return {
          ok: false,
          gate: "capability",
          denial: buildCapabilityDenial(capability, audience),
        };
      }
    } else if (step === "usage") {
      if (!args.usage) continue;
      if (!access) throw new Error("The usage gate needs a billing verdict.");
      const minimum = args.usage.minimumRemainingMicroCents ?? 0;
      const remaining = args.remainingMicroCents ?? null;
      if (!access.allowed || (remaining !== null && remaining < minimum)) {
        return {
          ok: false,
          gate: "usage",
          message: access.allowed
            ? "Not enough managed usage left for this request."
            : access.message,
          retryAfterMs: access.retryAfterMs,
        };
      }
    }
  }

  return { ok: true, access, ownerGeneration };
};

export const enforceManagedGate = internalMutation({
  args: enforceManagedGateArgs,
  returns: managedGateResultValidator,
  handler: runEnforceManagedGate,
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
      /** Spend available at the gate (null: unlimited or not checked). */
      remainingMicroCents: number | null;
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
  const needsBilling =
    (spec.capability !== undefined && spec.order.includes("capability")) ||
    (spec.usage !== undefined && spec.order.includes("usage"));
  const billing = needsBilling
    ? await fetchBillingAccess(spec.ownerId, {
        ...(spec.isAnonymous !== undefined ? { isAnonymous: spec.isAnonymous } : {}),
      })
    : null;
  const result = await ctx.runMutation(
    internal.lib.gate_and_meter.enforceManagedGate,
    {
      ...(billing
        ? {
            access: {
              allowed: billing.allowed,
              plan: billing.plan,
              unlimited: billing.unlimited,
              downgraded: billing.downgraded,
              modelAudience: billing.audience,
              retryAfterMs: billing.retryAfterMs,
              message: billing.message,
            },
            remainingMicroCents: billing.remainingMicroCents,
          }
        : {}),
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
      remainingMicroCents: billing?.remainingMicroCents ?? null,
    };
  }
  return {
    ok: false,
    response: managedGateFailureResponse(
      result,
      origin,
      spec.capabilityOptions,
    ),
  };
};

/** The exact `Response` a route returns for a failed managed gate. */
export const managedGateFailureResponse = (
  result: GateFailure,
  origin: string | null,
  capabilityOptions?: ManagedGateSpec["capabilityOptions"],
): Response => {
  switch (result.gate) {
    case "rate":
      return withCors(rateLimitResponse(result.retryAfterMs), origin);
    case "capability":
      return capabilityRequiredResponse(
        result.denial,
        origin,
        capabilityOptions,
      );
    case "usage":
      return errorResponse(429, result.message, origin);
    default:
      return errorResponse(500, "Managed access gate failed.", origin);
  }
};
