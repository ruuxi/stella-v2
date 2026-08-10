/**
 * Measurement for the two trial allowances, which are denominated in
 * different units and so need different questions asked of them.
 *
 * The Free plan grants a lifetime *dollar* allowance, so the useful question
 * is how many requests a dollar buys and how many people ever exhaust it.
 * Anonymous access grants a *request* count, so the useful question is the
 * inverse: what does one anonymous request actually cost Stella, and what
 * would the configured cap cost at that rate. `projectedUsdAtRequestCap` is
 * the number that answers "is 1 request the right cap?".
 *
 * Internal only — this reads across every owner, so it must never be exposed
 * as a public query. Run it from the Convex dashboard or CLI:
 *
 *   bunx convex run billing_measurement:getTrialBudgetDistribution
 *   bunx convex run billing_measurement:getTrialBudgetDistribution '{"sampleLimit":5000}'
 *
 * Both cohorts are sampled with a bounded scan rather than a full table read,
 * so the numbers are a sample, not a census; `sampleSize` and `truncated`
 * report which one you got.
 */
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { microCentsToDollars, dollarsToMicroCents } from "./lib/billing_money";
import { clampIntToRange } from "./lib/number_utils";
import {
  getMaxAnonRequests,
  getMaxAnonRequestsPerIp,
} from "./lib/anonymous_usage";
import { getPlanConfig } from "./lib/billing_plans";

const DEFAULT_SAMPLE_LIMIT = 1_000;
const MAX_SAMPLE_LIMIT = 10_000;

/** One subject in a cohort: a Free account, or an anonymous device. */
type Subject = {
  usageMicroCents: number;
  requestCount: number;
};

/** Fields both cohorts report, whatever unit their allowance is in. */
const cohortBaseFields = {
  sampleSize: v.number(),
  /** True when the scan hit `sampleLimit` and more rows exist. */
  truncated: v.boolean(),
  /** Subjects with recorded spend — the only ones a rate can be drawn from. */
  activeSampleSize: v.number(),
  totalRequests: v.number(),
  totalUsd: v.number(),
};

const freeCohortValidator = v.object({
  ...cohortBaseFields,
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

const anonymousCohortValidator = v.object({
  ...cohortBaseFields,
  /** The configured caps, echoed so the projections below can be read. */
  requestCap: v.number(),
  perIpRequestCap: v.number(),
  /** Pooled cost of a single anonymous request. */
  usdPerRequest: v.union(v.number(), v.null()),
  /** Per-device cost of a request, so one chatty device cannot skew it. */
  medianUsdPerRequest: v.union(v.number(), v.null()),
  p90UsdPerRequest: v.union(v.number(), v.null()),
  /** What a whole anonymous device has cost, start to finish. */
  medianUsdPerDevice: v.union(v.number(), v.null()),
  p90UsdPerDevice: v.union(v.number(), v.null()),
  /**
   * `requestCap` × the per-request cost — what the current cap is worth per
   * device at the typical rate, and at the p90 tail.
   */
  projectedUsdAtRequestCap: v.union(v.number(), v.null()),
  projectedP90UsdAtRequestCap: v.union(v.number(), v.null()),
});

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Dollar figures here are fractions of a cent; 6 places keeps them legible. */
const roundUsd = (value: number | null): number | null =>
  value === null ? null : round(value, 6);

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

/**
 * Subjects with no recorded spend carry no rate information and would drag
 * every percentile to zero, so rates are drawn from the active set only.
 */
const summarizeBase = (subjects: Subject[], truncated: boolean) => {
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
  return {
    active,
    totalRequests,
    totalUsd,
    base: {
      sampleSize: subjects.length,
      truncated,
      activeSampleSize: active.length,
      totalRequests,
      totalUsd: round(totalUsd, 6),
    },
  };
};

const summarizeFreeCohort = (args: {
  subjects: Subject[];
  limitUsd: number | null;
  truncated: boolean;
}) => {
  const { subjects, limitUsd, truncated } = args;
  const { active, totalRequests, totalUsd, base } = summarizeBase(
    subjects,
    truncated,
  );
  const limitMicroCents =
    limitUsd === null ? null : dollarsToMicroCents(limitUsd);

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
    ...base,
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

const summarizeAnonymousCohort = (args: {
  subjects: Subject[];
  requestCap: number;
  perIpRequestCap: number;
  truncated: boolean;
}) => {
  const { subjects, requestCap, perIpRequestCap, truncated } = args;
  const { active, totalRequests, totalUsd, base } = summarizeBase(
    subjects,
    truncated,
  );

  const perDeviceUsd = ascending(
    active.map((subject) => microCentsToDollars(subject.usageMicroCents)),
  );
  const perRequestUsd = ascending(
    active
      .filter((subject) => subject.requestCount > 0)
      .map(
        (subject) =>
          microCentsToDollars(subject.usageMicroCents) / subject.requestCount,
      )
      .filter((rate) => Number.isFinite(rate)),
  );

  const medianUsdPerRequest = percentile(perRequestUsd, 0.5);
  const p90UsdPerRequest = percentile(perRequestUsd, 0.9);

  return {
    ...base,
    requestCap,
    perIpRequestCap,
    usdPerRequest:
      totalRequests > 0 ? round(totalUsd / totalRequests, 6) : null,
    medianUsdPerRequest: roundUsd(medianUsdPerRequest),
    p90UsdPerRequest: roundUsd(p90UsdPerRequest),
    medianUsdPerDevice: roundUsd(percentile(perDeviceUsd, 0.5)),
    p90UsdPerDevice: roundUsd(percentile(perDeviceUsd, 0.9)),
    projectedUsdAtRequestCap:
      medianUsdPerRequest === null
        ? null
        : round(medianUsdPerRequest * requestCap, 6),
    projectedP90UsdAtRequestCap:
      p90UsdPerRequest === null
        ? null
        : round(p90UsdPerRequest * requestCap, 6),
  };
};

export const getTrialBudgetDistribution = internalQuery({
  args: {
    sampleLimit: v.optional(v.number()),
  },
  returns: v.object({
    sampleLimit: v.number(),
    free: freeCohortValidator,
    anonymousDevices: anonymousCohortValidator,
  }),
  handler: async (ctx, args) => {
    const sampleLimit = clampIntToRange(
      args.sampleLimit ?? DEFAULT_SAMPLE_LIMIT,
      1,
      MAX_SAMPLE_LIMIT,
    );

    // Free cohort. Start from profiles so the plan filter happens before the
    // per-owner usage lookups rather than after.
    const profiles = await ctx.db
      .query("billing_profiles")
      .take(sampleLimit + 1);
    const profilesTruncated = profiles.length > sampleLimit;
    const freeProfiles = profiles
      .slice(0, sampleLimit)
      .filter(
        (profile) =>
          profile.activePlan === "free" && profile.usageMode !== "unlimited",
      );
    const freeSubjects: Subject[] = [];
    for (const profile of freeProfiles) {
      const usage = await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", profile.ownerId))
        .unique();
      if (!usage) continue;
      freeSubjects.push({
        usageMicroCents: Math.max(0, usage.totalUsageMicroCents),
        requestCount: Math.max(0, usage.totalRequestCount ?? 0),
      });
    }

    // Anonymous cohort. `bucket: "ip"` rows are the shared network ceiling,
    // not people, so they are excluded. Rows written before the field existed
    // are overwhelmingly device buckets and are kept.
    const anonRows = await ctx.db
      .query("anon_device_usage")
      .take(sampleLimit + 1);
    const anonTruncated = anonRows.length > sampleLimit;
    const anonSubjects: Subject[] = anonRows
      .slice(0, sampleLimit)
      .filter((row) => row.bucket !== "ip")
      .map((row) => ({
        usageMicroCents: Math.max(0, row.usageMicroCents ?? 0),
        requestCount: Math.max(0, row.requestCount),
      }));

    return {
      sampleLimit,
      free: summarizeFreeCohort({
        subjects: freeSubjects,
        limitUsd: getPlanConfig("free").lifetimeLimitUsd ?? null,
        truncated: profilesTruncated,
      }),
      anonymousDevices: summarizeAnonymousCohort({
        subjects: anonSubjects,
        requestCap: getMaxAnonRequests(),
        perIpRequestCap: getMaxAnonRequestsPerIp(),
        truncated: anonTruncated,
      }),
    };
  },
});
