/**
 * Measurement for the Free plan's lifetime allowance
 * (`STELLA_FREE_LIFETIME_LIMIT_USD`).
 *
 * The allowance is a dollar figure, which is the right unit for Stella but a
 * useless one for answering "is $0.50 generous or stingy?". This query
 * translates it back into requests: how many a dollar buys, how many people
 * get through before the allowance is gone, and how many exhaust it at all.
 *
 * Anonymous access is not measured here. Its allowance is a single request,
 * so there is no number to tune — the cap is the whole policy.
 *
 * Internal only — this reads across every owner, so it must never be exposed
 * as a public query. Run it from the Convex dashboard or CLI:
 *
 *   bunx convex run billing_measurement:getTrialBudgetDistribution
 *   bunx convex run billing_measurement:getTrialBudgetDistribution '{"sampleLimit":5000}'
 *
 * The cohort is sampled with a bounded scan rather than a full table read, so
 * the numbers are a sample, not a census; `sampleSize` and `truncated` report
 * which one you got.
 */
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { microCentsToDollars, dollarsToMicroCents } from "./lib/billing_money";
import { clampIntToRange } from "./lib/number_utils";
import { getPlanConfig } from "./lib/billing_plans";

const DEFAULT_SAMPLE_LIMIT = 1_000;
const MAX_SAMPLE_LIMIT = 10_000;

/** One Free account's cumulative, never-resetting totals. */
type Subject = {
  usageMicroCents: number;
  requestCount: number;
};

const freeCohortValidator = v.object({
  sampleSize: v.number(),
  /** True when the scan hit `sampleLimit` and more rows exist. */
  truncated: v.boolean(),
  /** Accounts with recorded spend — the only ones a rate can be drawn from. */
  activeSampleSize: v.number(),
  totalRequests: v.number(),
  totalUsd: v.number(),
  /** The lifetime allowance, or null when Free is left purely windowed. */
  limitUsd: v.union(v.number(), v.null()),
  /** Pooled: every request in the sample over every dollar in the sample. */
  requestsPerDollar: v.union(v.number(), v.null()),
  /** Per-account requests-per-dollar, so one heavy user cannot skew it. */
  medianRequestsPerDollar: v.union(v.number(), v.null()),
  p90RequestsPerDollar: v.union(v.number(), v.null()),
  exhaustedCount: v.number(),
  exhaustedPct: v.union(v.number(), v.null()),
  /** Requests logged by accounts that actually ran out of allowance. */
  medianRequestsBeforeExhaustion: v.union(v.number(), v.null()),
  p90RequestsBeforeExhaustion: v.union(v.number(), v.null()),
});

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const roundRate = (value: number | null): number | null =>
  value === null ? null : round(value, 1);

/**
 * Nearest-rank percentile on an ascending array. Nearest-rank (rather than
 * interpolation) keeps "p90 requests" an integer that corresponds to a real
 * user, which is what makes the number arguable in a pricing conversation.
 */
const percentile = (sorted: number[], fraction: number): number | null => {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  const index = clampIntToRange(rank - 1, 0, sorted.length - 1);
  return sorted[index] ?? null;
};

const ascending = (values: number[]) => [...values].sort((a, b) => a - b);

const summarizeFreeCohort = (args: {
  subjects: Subject[];
  limitUsd: number | null;
  truncated: boolean;
}) => {
  const { subjects, limitUsd, truncated } = args;
  const limitMicroCents =
    limitUsd === null ? null : dollarsToMicroCents(limitUsd);

  // Accounts with no recorded spend carry no rate information and would drag
  // every percentile to zero, so rates are drawn from the active set only.
  const active = subjects.filter((subject) => subject.usageMicroCents > 0);
  const totalMicroCents = active.reduce(
    (sum, subject) => sum + subject.usageMicroCents,
    0,
  );
  const totalRequests = active.reduce(
    (sum, subject) => sum + subject.requestCount,
    0,
  );
  const totalUsd = microCentsToDollars(totalMicroCents);

  const perAccountRates = ascending(
    active
      .map(
        (subject) =>
          subject.requestCount / microCentsToDollars(subject.usageMicroCents),
      )
      .filter((rate) => Number.isFinite(rate)),
  );

  const exhausted =
    limitMicroCents === null
      ? []
      : subjects.filter(
          (subject) => subject.usageMicroCents >= limitMicroCents,
        );
  const exhaustedRequests = ascending(
    exhausted.map((subject) => subject.requestCount),
  );

  return {
    sampleSize: subjects.length,
    truncated,
    activeSampleSize: active.length,
    totalRequests,
    totalUsd: round(totalUsd, 6),
    limitUsd,
    requestsPerDollar: totalUsd > 0 ? round(totalRequests / totalUsd, 1) : null,
    medianRequestsPerDollar: roundRate(percentile(perAccountRates, 0.5)),
    p90RequestsPerDollar: roundRate(percentile(perAccountRates, 0.9)),
    exhaustedCount: exhausted.length,
    exhaustedPct:
      subjects.length > 0
        ? round((exhausted.length / subjects.length) * 100, 1)
        : null,
    medianRequestsBeforeExhaustion: percentile(exhaustedRequests, 0.5),
    p90RequestsBeforeExhaustion: percentile(exhaustedRequests, 0.9),
  };
};

export const getTrialBudgetDistribution = internalQuery({
  args: {
    sampleLimit: v.optional(v.number()),
  },
  returns: v.object({
    sampleLimit: v.number(),
    free: freeCohortValidator,
  }),
  handler: async (ctx, args) => {
    const sampleLimit = clampIntToRange(
      args.sampleLimit ?? DEFAULT_SAMPLE_LIMIT,
      1,
      MAX_SAMPLE_LIMIT,
    );

    // Start from profiles so the plan filter happens before the per-owner
    // usage lookups rather than after.
    const profiles = await ctx.db
      .query("billing_profiles")
      .take(sampleLimit + 1);
    const truncated = profiles.length > sampleLimit;
    const freeProfiles = profiles
      .slice(0, sampleLimit)
      .filter(
        (profile) =>
          profile.activePlan === "free" && profile.usageMode !== "unlimited",
      );

    const subjects: Subject[] = [];
    for (const profile of freeProfiles) {
      const usage = await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", profile.ownerId))
        .unique();
      if (!usage) continue;
      subjects.push({
        usageMicroCents: Math.max(0, usage.totalUsageMicroCents),
        requestCount: Math.max(0, usage.totalRequestCount ?? 0),
      });
    }

    return {
      sampleLimit,
      free: summarizeFreeCohort({
        subjects,
        limitUsd: getPlanConfig("free").lifetimeLimitUsd ?? null,
        truncated,
      }),
    };
  },
});
