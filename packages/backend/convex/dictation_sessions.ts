import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  runAcquireManagedProviderDispatch,
  runMarkManagedProviderDispatchMayHaveStarted,
  runPeekManagedModelAllowance,
} from "./billing";
import { dollarsToMicroCents } from "./lib/billing_money";
import { runEnforceManagedGate } from "./lib/gate_and_meter";
import type { ManagedDispatchBillingEnvelope } from "./lib/managed_dispatch";

const DICTATION_RATE_LIMIT = 30;
const DICTATION_RATE_WINDOW_MS = 60_000;
export const PCM_BYTES_PER_SECOND = 16_000 * 2;
export const SESSION_ID_PATTERN = /^muse_[0-9a-f-]{36}$/u;

export const MUSE_DICTATION_MODEL = "muse-voice-transcribe-1.0";
export const MUSE_STT_USD_PER_SECOND = 0.18 / 3600;
export const MUSE_MAX_SESSION_MS = 60 * 60_000;

export const sessionAuthority = (
  ownerId: string,
  ownerGeneration: string,
  sessionId: string,
) => ({
  ownerId,
  ownerGeneration,
  executionId: sessionId,
  attemptId: sessionId,
  leaseId: sessionId,
});
export const sessionBilling = (
  sessionId: string,
  fallbackCostMicroCents: number,
): ManagedDispatchBillingEnvelope => ({
  kind: "managed_usage",
  requestFingerprint: `dictation:${sessionId}`,
  agentType: "service:dictation",
  model: MUSE_DICTATION_MODEL,
  fallbackCostMicroCents,
});

/**
 * Gate, size, reserve, and mark one dictation session in a single
 * transaction. This sits on the critical path between the mic button and the
 * first transcribed word, so it is one round trip rather than four. It still
 * commits the reservation before the relay may open the provider session.
 */
export const prepare = internalMutation({
  args: { ownerId: v.string(), sessionId: v.string(), now: v.number() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      sessionId: v.string(),
      ownerGeneration: v.string(),
      providerDeadlineAt: v.number(),
      maxAudioBytes: v.number(),
    }),
    v.object({
      ok: v.literal(false),
      reason: v.literal("rate"),
      retryAfterMs: v.number(),
    }),
    v.object({
      ok: v.literal(false),
      reason: v.literal("usage"),
      message: v.string(),
    }),
    v.object({ ok: v.literal(false), reason: v.literal("unavailable") }),
  ),
  handler: async (ctx, args) => {
    if (!SESSION_ID_PATTERN.test(args.sessionId)) {
      throw new Error("Invalid dictation session id.");
    }
    const gate = await runEnforceManagedGate(ctx, {
      ownerId: args.ownerId,
      order: ["usage", "rate"],
      usage: {},
      rateLimit: {
        scope: "dictation_transcribe",
        key: args.ownerId,
        limit: DICTATION_RATE_LIMIT,
        windowMs: DICTATION_RATE_WINDOW_MS,
        blockMs: DICTATION_RATE_WINDOW_MS,
      },
    });
    if (!gate.ok) {
      if (gate.gate === "rate") {
        return {
          ok: false as const,
          reason: "rate" as const,
          retryAfterMs: gate.retryAfterMs,
        };
      }
      return {
        ok: false as const,
        reason: "usage" as const,
        message:
          gate.gate === "usage"
            ? gate.message
            : "Your Stella usage allowance is exhausted.",
      };
    }
    const { ownerGeneration } = gate;

    const remaining = (
      await runPeekManagedModelAllowance(ctx, {
        ownerId: args.ownerId,
        ownerGeneration,
      })
    ).remainingMicroCents;
    const costPerSecond = dollarsToMicroCents(MUSE_STT_USD_PER_SECOND);
    const maxSeconds =
      remaining === null
        ? MUSE_MAX_SESSION_MS / 1000
        : Math.min(
            MUSE_MAX_SESSION_MS / 1000,
            Math.floor(remaining / costPerSecond),
          );
    if (maxSeconds < 1) {
      return {
        ok: false as const,
        reason: "usage" as const,
        message: "Your Stella usage allowance is too low to start dictation.",
      };
    }

    const authority = sessionAuthority(
      args.ownerId,
      ownerGeneration,
      args.sessionId,
    );
    const billing = sessionBilling(args.sessionId, maxSeconds * costPerSecond);
    const timing = await runAcquireManagedProviderDispatch(ctx, {
      ...authority,
      billing,
      providerTimeoutMs: maxSeconds * 1000,
      now: args.now,
    });
    let marked: boolean;
    try {
      marked = await runMarkManagedProviderDispatchMayHaveStarted(ctx, {
        ...authority,
        billing,
        now: args.now,
      });
    } catch (error) {
      const data = error instanceof ConvexError ? error.data : null;
      if (
        data &&
        typeof data === "object" &&
        data.code === "USAGE_LIMIT_REACHED"
      ) {
        return {
          ok: false as const,
          reason: "usage" as const,
          message: String(data.message),
        };
      }
      throw error;
    }
    if (!marked) return { ok: false as const, reason: "unavailable" as const };
    return {
      ok: true as const,
      sessionId: args.sessionId,
      ownerGeneration,
      providerDeadlineAt: timing.providerDeadlineAt,
      maxAudioBytes: maxSeconds * PCM_BYTES_PER_SECOND,
    };
  },
});

export const remainingAllowance = internalQuery({
  args: { ownerId: v.string(), ownerGeneration: v.string() },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args) =>
    (await runPeekManagedModelAllowance(ctx, args)).remainingMicroCents,
});

export const receipt = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    sessionId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({ maxMs: v.number(), fallbackCostMicroCents: v.number() }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("billing_managed_dispatch_leases")
      .withIndex("by_attemptId", (q) => q.eq("attemptId", args.sessionId))
      .unique();
    if (!row) return null;
    if (
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration
    )
      throw new Error("Dictation settlement lost exact attempt authority.");
    if (
      row.billing?.kind !== "managed_usage" ||
      row.billing.agentType !== "service:dictation"
    )
      return null;
    return {
      maxMs: row.providerDeadlineAt - row.createdAt,
      fallbackCostMicroCents: row.billing.fallbackCostMicroCents,
    };
  },
});
