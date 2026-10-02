import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { dollarsToMicroCents } from "./lib/billing_money";
import { runEnforceManagedGate } from "./lib/gate_and_meter";

const DICTATION_RATE_LIMIT = 30;
const DICTATION_RATE_WINDOW_MS = 60_000;
export const PCM_BYTES_PER_SECOND = 16_000 * 2;
export const SESSION_ID_PATTERN = /^muse_[0-9a-f-]{36}$/u;

export const MUSE_DICTATION_MODEL = "muse-voice-transcribe-1.0";
export const MUSE_STT_USD_PER_SECOND = 0.18 / 3600;
export const MUSE_MAX_SESSION_MS = 60 * 60_000;

/**
 * Gate and size one dictation session in a single transaction, from the
 * billing verdict the route fetched. This sits on the critical path between
 * the mic button and the first transcribed word, so it is one round trip.
 * The session's spend is capped by its audio allowance and charged once on
 * settle.
 */
export const prepare = internalMutation({
  args: {
    ownerId: v.string(),
    sessionId: v.string(),
    now: v.number(),
    allowed: v.boolean(),
    message: v.string(),
    retryAfterMs: v.number(),
    /** Spend available now; null when unlimited. */
    remainingMicroCents: v.union(v.number(), v.null()),
  },
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
      access: {
        allowed: args.allowed,
        plan: "free",
        unlimited: args.remainingMicroCents === null,
        downgraded: false,
        modelAudience: "free",
        retryAfterMs: args.retryAfterMs,
        message: args.message,
      },
      remainingMicroCents: args.remainingMicroCents,
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

    const remaining = args.remainingMicroCents;
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

    return {
      ok: true as const,
      sessionId: args.sessionId,
      ownerGeneration,
      providerDeadlineAt: args.now + maxSeconds * 1000,
      maxAudioBytes: maxSeconds * PCM_BYTES_PER_SECOND,
    };
  },
});
