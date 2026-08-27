import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { microCentsToDollars, dollarsToMicroCents } from "./lib/billing_money";
import { clampIntToRange } from "./lib/number_utils";
import { getPlanConfig } from "./lib/billing_plans";

const DEFAULT_SAMPLE_LIMIT = 1_000;
const MAX_SAMPLE_LIMIT = 10_000;

type Subject = {
  usageMicroCents: number;
  requestCount: number;
};

const freeCohortValidator = v.object({
  sampleSize: v.number(),

  truncated: v.boolean(),

  activeSampleSize: v.number(),
  totalRequests: v.number(),
  totalUsd: v.number(),

  limitUsd: v.union(v.number(), v.null()),

  requestsPerDollar: v.union(v.number(), v.null()),

  medianRequestsPerDollar: v.union(v.number(), v.null()),
  p90RequestsPerDollar: v.union(v.number(), v.null()),
  exhaustedCount: v.number(),
  exhaustedPct: v.union(v.number(), v.null()),

  medianRequestsBeforeExhaustion: v.union(v.number(), v.null()),
  p90RequestsBeforeExhaustion: v.union(v.number(), v.null()),
});

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const roundRate = (value: number | null): number | null =>
  value === null ? null : round(value, 1);

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
