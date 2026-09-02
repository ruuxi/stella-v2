import type { IdentityLevel } from "@stella/contracts/gateway/api";
import { v } from "convex/values";
import { components } from "../_generated/api";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type IdentityReadCtx =
  | Pick<QueryCtx, "db" | "runQuery">
  | Pick<MutationCtx, "db" | "runQuery">;

export const identityLevelValidator = v.union(
  v.literal(0),
  v.literal(1),
  v.literal(2),
  v.literal(3),
);

const ACTIVE_PAID_STATUSES = new Set(["active", "trialing"]);
const SOCIAL_PROVIDERS = new Set(["google", "apple"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const betterAuthUserIdFromOwnerId = (ownerId: string): string | null => {
  const issuer = process.env.CONVEX_SITE_URL?.trim();
  if (!issuer) return null;
  const prefix = `${issuer}|`;
  if (!ownerId.startsWith(prefix)) return null;
  const userId = ownerId.slice(prefix.length).trim();
  return userId || null;
};

const readBetterAuthRows = async (
  ctx: IdentityReadCtx,
  userId: string,
): Promise<{ anonymous: boolean; social: boolean }> => {
  try {
    const [user, accounts]: [unknown, unknown] = await Promise.all([
      ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: "user",
        where: [{ field: "_id", value: userId }],
      }),
      ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "account",
        where: [{ field: "userId", value: userId }],
        paginationOpts: { cursor: null, numItems: 20 },
      }),
    ]);
    const anonymous = isRecord(user) && user.isAnonymous === true;
    const page = isRecord(accounts) ? accounts.page : null;
    const social =
      Array.isArray(page) &&
      page.some(
        (account) =>
          isRecord(account) &&
          typeof account.providerId === "string" &&
          SOCIAL_PROVIDERS.has(account.providerId),
      );
    return { anonymous, social };
  } catch {
    return { anonymous: false, social: false };
  }
};

export const resolveIdentityLevel = async (
  ctx: IdentityReadCtx,
  ownerId: string,
): Promise<IdentityLevel> => {
  const userId = betterAuthUserIdFromOwnerId(ownerId);
  const [auth, profile, credit] = await Promise.all([
    userId
      ? readBetterAuthRows(ctx, userId)
      : Promise.resolve({ anonymous: false, social: false }),
    ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (query) => query.eq("ownerId", ownerId))
      .unique(),
    ctx.db
      .query("billing_usage_credits")
      .withIndex("by_ownerId", (query) => query.eq("ownerId", ownerId))
      .unique(),
  ]);

  if (auth.anonymous) return 0;
  if (
    (profile !== null &&
      profile.activePlan !== "free" &&
      ACTIVE_PAID_STATUSES.has(profile.subscriptionStatus)) ||
    (credit?.balanceMicroCents ?? 0) > 0
  ) {
    return 3;
  }
  if (auth.social) return 2;
  return 1;
};
