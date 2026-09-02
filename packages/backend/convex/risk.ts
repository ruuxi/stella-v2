import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { NetworkClass } from "@stella/contracts/gateway/api";
import type { OwnerEnforcementStatus } from "@stella/contracts/gateway/usage";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { resolveIdentityLevel } from "./lib/identity_level";
import { calculateRiskScore, parseRiskWeights } from "./lib/risk";
import { readOwnerEnforcement } from "./owner_enforcement";
import { riskWindowValidator } from "./schema/abuse";

const RISK_WINDOWS = {
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
} as const;
const DISTINCT_VALUE_LIMIT = 32;
const RISK_RETENTION_MS = 48 * 60 * 60_000;
const RISK_ENFORCEMENT_MS = 24 * 60 * 60_000;
const RISK_CRON_BATCH_SIZE = 500;

type RiskWindow = keyof typeof RISK_WINDOWS;

type RiskSignalDelta = {
  requests?: number;
  chargedMicroCents?: number;
  mints?: number;
  hostingRequests?: number;
  ipHash?: string;
  conversationId?: string;
  failedRequests?: number;
  sybilFlags?: number;
};

const setOwnerEnforcementRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    status: OwnerEnforcementStatus;
    until?: number;
    reason: string;
    actor: string;
  },
  unknown
>("owner_enforcement:setOwnerEnforcementInternal");

const addDistinctValue = (
  values: string[],
  candidate: string | undefined,
): string[] => {
  const normalized = candidate?.trim();
  if (
    !normalized ||
    values.includes(normalized) ||
    values.length >= DISTINCT_VALUE_LIMIT
  ) {
    return values;
  }
  return [...values, normalized];
};

const nonNegativeInt = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;

const sameWindowBucket = (
  previousTimestamp: number,
  currentTimestamp: number,
  durationMs: number,
): boolean =>
  Math.floor(previousTimestamp / durationMs) ===
  Math.floor(currentTimestamp / durationMs);

const recordWindowRiskSignals = async (
  ctx: MutationCtx,
  ownerId: string,
  window: RiskWindow,
  delta: RiskSignalDelta,
  now: number,
): Promise<void> => {
  const existing = await ctx.db
    .query("owner_risk_signals")
    .withIndex("by_owner_window", (q) =>
      q.eq("ownerId", ownerId).eq("window", window),
    )
    .unique();
  const current =
    existing && sameWindowBucket(existing.updatedAt, now, RISK_WINDOWS[window])
      ? existing
      : null;
  const ipHashes = addDistinctValue(current?.ipHashes ?? [], delta.ipHash);
  const conversationIds = addDistinctValue(
    current?.conversationIds ?? [],
    delta.conversationId,
  );
  const fields = {
    ownerId,
    window,
    requests: (current?.requests ?? 0) + nonNegativeInt(delta.requests),
    chargedMicroCents:
      (current?.chargedMicroCents ?? 0) +
      nonNegativeInt(delta.chargedMicroCents),
    mints: (current?.mints ?? 0) + nonNegativeInt(delta.mints),
    hostingRequests:
      (current?.hostingRequests ?? 0) + nonNegativeInt(delta.hostingRequests),
    distinctIps: ipHashes.length,
    ipHashes,
    distinctConversations: conversationIds.length,
    conversationIds,
    failedRequests:
      (current?.failedRequests ?? 0) + nonNegativeInt(delta.failedRequests),
    sybilFlags: (current?.sybilFlags ?? 0) + nonNegativeInt(delta.sybilFlags),
    score: current?.score ?? 0,
    updatedAt: now,
  };
  if (existing) {
    await ctx.db.replace(existing._id, fields);
  } else {
    await ctx.db.insert("owner_risk_signals", fields);
  }
};

export const recordOwnerRiskSignals = async (
  ctx: MutationCtx,
  ownerId: string,
  delta: RiskSignalDelta,
  now: number,
): Promise<void> => {
  for (const window of Object.keys(RISK_WINDOWS) as RiskWindow[]) {
    await recordWindowRiskSignals(ctx, ownerId, window, delta, now);
  }
};

export const recordGatewayUsageRiskSignals = async (
  ctx: MutationCtx,
  event: {
    ownerId: string;
    chargedMicroCents: number;
    outcome: "succeeded" | "failed" | "aborted";
    networkClass?: NetworkClass;
    anonymous?: { ipHash?: string };
    conversationId?: string;
  },
  now: number,
): Promise<void> => {
  await recordOwnerRiskSignals(
    ctx,
    event.ownerId,
    {
      requests: 1,
      chargedMicroCents: event.chargedMicroCents,
      hostingRequests: event.networkClass === "hosting" ? 1 : 0,
      ipHash: event.anonymous?.ipHash,
      conversationId: event.conversationId,
      failedRequests: event.outcome === "failed" ? 1 : 0,
    },
    now,
  );
};

export const recordGatewayMintRiskSignalInternal = internalMutation({
  args: {
    ownerId: v.string(),
    mints: v.number(),
    sybilFlags: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordOwnerRiskSignals(
      ctx,
      args.ownerId,
      { mints: args.mints, sybilFlags: args.sybilFlags },
      args.now,
    );
    return null;
  },
});

const riskSignalValidator = v.object({
  ownerId: v.string(),
  window: riskWindowValidator,
  requests: v.number(),
  chargedMicroCents: v.number(),
  mints: v.number(),
  hostingRequests: v.number(),
  distinctIps: v.number(),
  distinctConversations: v.number(),
  failedRequests: v.number(),
  sybilFlags: v.number(),
  score: v.number(),
  updatedAt: v.number(),
});

const projectRiskSignal = (row: {
  ownerId: string;
  window: RiskWindow;
  requests: number;
  chargedMicroCents: number;
  mints: number;
  hostingRequests: number;
  distinctIps: number;
  distinctConversations: number;
  failedRequests: number;
  sybilFlags: number;
  score: number;
  updatedAt: number;
}) => ({
  ownerId: row.ownerId,
  window: row.window,
  requests: row.requests,
  chargedMicroCents: row.chargedMicroCents,
  mints: row.mints,
  hostingRequests: row.hostingRequests,
  distinctIps: row.distinctIps,
  distinctConversations: row.distinctConversations,
  failedRequests: row.failedRequests,
  sybilFlags: row.sybilFlags,
  score: row.score,
  updatedAt: row.updatedAt,
});

export const getOwnerRiskSignalsInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(riskSignalValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("owner_risk_signals")
      .withIndex("by_owner_window", (q) => q.eq("ownerId", args.ownerId))
      .take(2);
    return rows.map(projectRiskSignal);
  },
});

export const listTopOwnerRiskSignalsInternal = internalQuery({
  args: {
    window: riskWindowValidator,
    by: v.union(
      v.literal("spend"),
      v.literal("requests"),
      v.literal("mints"),
      v.literal("score"),
    ),
  },
  returns: v.array(riskSignalValidator),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - RISK_WINDOWS[args.window];
    const query =
      args.by === "spend"
        ? ctx.db
            .query("owner_risk_signals")
            .withIndex("by_window_chargedMicroCents", (q) =>
              q.eq("window", args.window),
            )
        : args.by === "requests"
          ? ctx.db
              .query("owner_risk_signals")
              .withIndex("by_window_requests", (q) =>
                q.eq("window", args.window),
              )
          : args.by === "mints"
            ? ctx.db
                .query("owner_risk_signals")
                .withIndex("by_window_mints", (q) =>
                  q.eq("window", args.window),
                )
            : ctx.db
                .query("owner_risk_signals")
                .withIndex("by_window_score", (q) =>
                  q.eq("window", args.window),
                );
    return (
      await query
        .filter((q) => q.gte(q.field("updatedAt"), cutoff))
        .order("desc")
        .take(20)
    ).map(projectRiskSignal);
  },
});

export const recomputeRiskScoresInternal = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.object({
    scored: v.number(),
    deleted: v.number(),
    enforced: v.number(),
    hasMoreExpired: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const expired = await ctx.db
      .query("owner_risk_signals")
      .withIndex("by_updatedAt", (q) =>
        q.lt("updatedAt", now - RISK_RETENTION_MS),
      )
      .take(RISK_CRON_BATCH_SIZE);
    for (const row of expired) await ctx.db.delete(row._id);

    const recent = await ctx.db
      .query("owner_risk_signals")
      .withIndex("by_updatedAt", (q) =>
        q.gte("updatedAt", now - RISK_WINDOWS["24h"]),
      )
      .order("desc")
      .take(RISK_CRON_BATCH_SIZE);
    const weights = parseRiskWeights(process.env.STELLA_RISK_WEIGHTS_JSON);
    const ownerScores = new Map<string, number>();
    let scored = 0;
    for (const row of recent) {
      if (row.updatedAt < now - RISK_WINDOWS[row.window]) continue;
      const score = calculateRiskScore(row, row.window, weights);
      if (score !== row.score) await ctx.db.patch(row._id, { score });
      ownerScores.set(
        row.ownerId,
        Math.max(ownerScores.get(row.ownerId) ?? 0, score),
      );
      scored += 1;
    }

    let enforced = 0;
    for (const [ownerId, score] of ownerScores) {
      const status =
        score >= 80 ? "throttled" : score >= 60 ? "challenged" : null;
      if (!status || (await resolveIdentityLevel(ctx, ownerId)) >= 3) continue;
      const current = await readOwnerEnforcement(ctx, ownerId);
      if (
        current.status === "suspended" ||
        current.status === "throttled" ||
        (current.status === "challenged" && status === "challenged")
      ) {
        continue;
      }
      await ctx.runMutation(setOwnerEnforcementRef, {
        ownerId,
        status,
        until: now + RISK_ENFORCEMENT_MS,
        reason: `automated risk score ${score}`,
        actor: "risk-cron",
      });
      enforced += 1;
    }
    return {
      scored,
      deleted: expired.length,
      enforced,
      hasMoreExpired: expired.length === RISK_CRON_BATCH_SIZE,
    };
  },
});

export { RISK_ENFORCEMENT_MS, RISK_RETENTION_MS, RISK_WINDOWS };
