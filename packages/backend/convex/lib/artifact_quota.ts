import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { SubscriptionPlan } from "./billing_plans";

const MEBIBYTE = 1024 * 1024;
const ARTIFACT_QUOTA_DEFAULT_MB: Readonly<Record<SubscriptionPlan, number>> = {
  free: 200,
  go: 1024,
  pro: 5120,
};
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);
const MAX_RECORDED_BUILDS = 2_000;

type ArtifactQuotaCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

const readPositiveNumberEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
};

export const artifactBytesFromMetricsJson = (metricsJson: string): number => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metricsJson) as unknown;
  } catch {
    throw new ConvexError("Build metrics must be valid JSON.");
  }
  const uploadedBytes =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).uploadedBytes
      : undefined;
  if (
    typeof uploadedBytes !== "number" ||
    !Number.isSafeInteger(uploadedBytes) ||
    uploadedBytes < 0
  ) {
    throw new ConvexError("Build metrics must include uploadedBytes.");
  }
  return uploadedBytes;
};

export const resolveOwnerArtifactQuotaBytes = async (
  ctx: ArtifactQuotaCtx,
  ownerId: string,
): Promise<number> => {
  const profile = await ctx.db
    .query("billing_profiles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
  const plan: SubscriptionPlan =
    profile &&
    ACTIVE_SUBSCRIPTION_STATUSES.has(profile.subscriptionStatus) &&
    profile.activePlan !== "free"
      ? profile.activePlan
      : "free";
  const quotaMb = readPositiveNumberEnv(
    `STELLA_APP_ARTIFACT_QUOTA_MB_${plan.toUpperCase()}`,
    ARTIFACT_QUOTA_DEFAULT_MB[plan],
  );
  return Math.floor(quotaMb * MEBIBYTE);
};

export const assertOwnerArtifactQuota = async (
  ctx: ArtifactQuotaCtx,
  args: { ownerId: string; additionalBytes: number },
): Promise<void> => {
  const [appBuilds, quotaBytes] = await Promise.all([
    ctx.db
      .query("cloud_app_builds")
      .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(MAX_RECORDED_BUILDS),
    resolveOwnerArtifactQuotaBytes(ctx, args.ownerId),
  ]);
  if (appBuilds.length === MAX_RECORDED_BUILDS) {
    throw new ConvexError({
      code: "ARTIFACT_QUOTA",
      message: "The app artifact quota is full.",
    });
  }
  const usedBytes = appBuilds.reduce(
    (total, build) =>
      total +
      (build.metricsJson ? artifactBytesFromMetricsJson(build.metricsJson) : 0),
    0,
  );
  if (usedBytes + args.additionalBytes > quotaBytes) {
    throw new ConvexError({
      code: "ARTIFACT_QUOTA",
      message: "The app artifact quota is full.",
    });
  }
};

export { ARTIFACT_QUOTA_DEFAULT_MB, MEBIBYTE };
