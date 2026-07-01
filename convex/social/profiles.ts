import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import { ConvexError, v } from "convex/values";
import {
  socialProfileValidator,
  ensureSocialProfileDoc,
  getSocialProfileByOwnerId,
  normalizeUsername,
} from "./shared";
import {
  requireBoundedString,
} from "../shared_validators";
import {
  getConnectedUserIdOrNull,
  requireConnectedUserId,
} from "../auth";
import {
  enforceMutationRateLimit,
  RATE_SETTINGS,
  RATE_STANDARD,
} from "../lib/rate_limits";
import { findBannedTerm } from "./censor";
import { socialBadgeValidator } from "../schema/social";
import type { Doc } from "../_generated/dataModel";

const optionalProfileValidator = v.union(v.null(), socialProfileValidator);

// Subscription statuses Stripe considers "currently entitled". Mirrors
// the set in `billing.ts` — kept local so this module doesn't import
// from billing and trip a cycle through `_generated/api`.
const ACTIVE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
]);

const PAID_PLAN_IDS = new Set(["go", "pro", "plus", "ultra", "max"]);

const hasActivePaidPlan = (
  profile: { activePlan?: string; subscriptionStatus?: string } | null,
): boolean => {
  if (!profile) return false;
  const plan = (profile.activePlan ?? "free").toLowerCase();
  const status = (profile.subscriptionStatus ?? "none").toLowerCase();
  return PAID_PLAN_IDS.has(plan) && ACTIVE_SUBSCRIPTION_STATUSES.has(status);
};

// Pure resolver: given an existing profile snapshot + billing state,
// what badge should the profile carry? Partner outranks verified and
// is sticky (only an admin can revoke). Verified is a live mirror of
// `hasActivePaidPlan`.
const resolveBadgeForProfile = (
  profile: Doc<"social_profiles">,
  hasPaidPlan: boolean,
): "verified" | "partner" | undefined => {
  if (profile.badge === "partner") return "partner";
  return hasPaidPlan ? "verified" : undefined;
};

// Push the profile's current username + badge onto every store
// package the user owns. Cheap because each user typically has a
// handful of packages, and listing queries sort on these denormalized
// fields rather than joining back through `social_profiles` /
// `billing_profiles` per row.
const syncStoreAuthorProfile = async (
  ctx: MutationCtx,
  ownerId: string,
  username: string,
  badge: "verified" | "partner" | undefined,
) => {
  const packages = await ctx.db
    .query("store_packages")
    .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
    .take(500);
  await Promise.all(
    packages.map((pkg) =>
      ctx.db.patch(pkg._id, {
        authorUsername: username,
        authorBadge: badge,
      }),
    ),
  );
};

export const ensureProfileInternal = internalMutation({
  args: {},
  returns: socialProfileValidator,
  handler: async (ctx) => {
    const ownerId = await requireConnectedUserId(ctx);
    return await ensureSocialProfileDoc(ctx, ownerId);
  },
});

export const ensureProfileForOwnerInternal = internalMutation({
  args: { ownerId: v.string() },
  returns: socialProfileValidator,
  handler: async (ctx, args) => {
    const profile = await ensureSocialProfileDoc(ctx, args.ownerId);
    await syncStoreAuthorProfile(
      ctx,
      args.ownerId,
      profile.username,
      profile.badge,
    );
    return profile;
  },
});

/**
 * Read the owner's billing state and update their social_profile badge
 * to match. Partner badges are preserved (only `setPartnerBadgeForOwnerInternal`
 * mutates them). Idempotent and cheap — billing flows call it
 * unconditionally on every subscription change.
 */
export const recomputeBadgeForOwnerInternal = internalMutation({
  args: { ownerId: v.string() },
  returns: v.union(socialBadgeValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = args.ownerId.trim();
    if (!ownerId) return null;
    const profile = await getSocialProfileByOwnerId(ctx, ownerId);
    // No social profile yet — nothing to denormalize onto. We'll set
    // the badge correctly the first time a profile gets created
    // (publishing to the store ensures one via
    // `ensureProfileForOwnerInternal`, which reads the current badge
    // from this profile row anyway, so we can no-op here).
    if (!profile) return null;
    const billing = await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();
    const nextBadge = resolveBadgeForProfile(profile, hasActivePaidPlan(billing));
    if (profile.badge === nextBadge) {
      return nextBadge ?? null;
    }
    await ctx.db.patch(profile._id, {
      badge: nextBadge,
      updatedAt: Date.now(),
    });
    await syncStoreAuthorProfile(ctx, ownerId, profile.username, nextBadge);
    return nextBadge ?? null;
  },
});

/**
 * Admin-only: grant or revoke the "partner" badge for an enterprise
 * owner. Granting wins over the live verified-from-billing badge;
 * revoking recomputes from current billing state.
 */
export const setPartnerBadgeForOwnerInternal = internalMutation({
  args: {
    ownerId: v.string(),
    granted: v.boolean(),
  },
  returns: v.object({
    ownerId: v.string(),
    badge: v.union(socialBadgeValidator, v.null()),
  }),
  handler: async (ctx, args) => {
    const ownerId = args.ownerId.trim();
    if (!ownerId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "ownerId is required",
      });
    }
    const profile = await ensureSocialProfileDoc(ctx, ownerId);
    const now = Date.now();
    if (args.granted) {
      if (profile.badge === "partner") {
        return { ownerId, badge: "partner" as const };
      }
      await ctx.db.patch(profile._id, {
        badge: "partner",
        partnerGrantedAt: now,
        updatedAt: now,
      });
      await syncStoreAuthorProfile(ctx, ownerId, profile.username, "partner");
      return { ownerId, badge: "partner" as const };
    }
    // Revoke: clear partner, then recompute from live billing state
    // so a paid subscriber drops back to "verified" cleanly.
    const billing = await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();
    const downgraded = hasActivePaidPlan(billing)
      ? ("verified" as const)
      : undefined;
    await ctx.db.patch(profile._id, {
      badge: downgraded,
      partnerGrantedAt: undefined,
      updatedAt: now,
    });
    await syncStoreAuthorProfile(ctx, ownerId, profile.username, downgraded);
    return { ownerId, badge: downgraded ?? null };
  },
});

export const getProfileByOwnerIdInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: optionalProfileValidator,
  handler: async (ctx, args) => {
    return await getSocialProfileByOwnerId(ctx, args.ownerId);
  },
});

export const ensureProfile = mutation({
  args: {},
  returns: socialProfileValidator,
  handler: async (ctx) => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "social_ensure_profile",
      ownerId,
      RATE_STANDARD,
    );
    return await ensureSocialProfileDoc(ctx, ownerId);
  },
});

export const getMyProfile = query({
  args: {},
  returns: optionalProfileValidator,
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || (identity as Record<string, unknown>).isAnonymous === true) {
      return null;
    }
    return await getSocialProfileByOwnerId(ctx, identity.tokenIdentifier);
  },
});

/**
 * Public lookup by `@username` — used as the store author handle and on
 * profile cards. Returns only display fields: `ownerId` (the caller's auth
 * tokenIdentifier), read-state, and partner metadata stay server-side.
 * Friend requests resolve usernames server-side and never need the ownerId.
 */
const publicProfileValidator = v.object({
  username: v.string(),
  avatarUrl: v.optional(v.string()),
  badge: v.optional(socialBadgeValidator),
  createdAt: v.number(),
});

export const getProfileByUsername = query({
  args: { username: v.string() },
  returns: v.union(v.null(), publicProfileValidator),
  handler: async (ctx, args) => {
    const username = args.username.trim().toLowerCase();
    if (!username) return null;
    const profile = await ctx.db
      .query("social_profiles")
      .withIndex("by_username", (q) => q.eq("username", username))
      .unique();
    if (!profile) return null;
    return {
      username: profile.username,
      ...(profile.avatarUrl !== undefined
        ? { avatarUrl: profile.avatarUrl }
        : {}),
      ...(profile.badge !== undefined ? { badge: profile.badge } : {}),
      createdAt: profile.createdAt,
    };
  },
});

export const claimUsername = mutation({
  args: { username: v.string() },
  returns: socialProfileValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "social_claim_username",
      ownerId,
      RATE_SETTINGS,
      "Too many username updates. Please wait a moment and try again.",
    );
    const username = normalizeUsername(args.username);
    if (findBannedTerm(username) !== null) {
      throw new ConvexError({
        code: "PROFANITY_BLOCKED",
        message:
          "That username contains a banned word. Please pick a different one.",
      });
    }
    const profile = await ensureSocialProfileDoc(ctx, ownerId);
    if (profile.username === username) {
      return profile;
    }
    const collision = await ctx.db
      .query("social_profiles")
      .withIndex("by_username", (q) => q.eq("username", username))
      .unique();
    if (collision && collision.ownerId !== ownerId) {
      throw new ConvexError({
        code: "USERNAME_TAKEN",
        message: "That username is taken. Pick a different one.",
      });
    }
    await ctx.db.patch(profile._id, {
      username,
      updatedAt: Date.now(),
    });
    await syncStoreAuthorProfile(ctx, ownerId, username, profile.badge);
    const updated = await ctx.db.get(profile._id);
    if (!updated) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to update social profile",
      });
    }
    return updated;
  },
});

/**
 * Bulk-resolve public display info for an arbitrary set of owner ids. Used by
 * surfaces that render sender names/avatars for messages whose authors aren't
 * part of any small membership row set.
 */
export const getProfilesByOwnerIds = query({
  args: {
    ownerIds: v.array(v.string()),
  },
  returns: v.array(
    v.object({
      ownerId: v.string(),
      username: v.string(),
      avatarUrl: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const callerId = await getConnectedUserIdOrNull(ctx);
    if (!callerId) {
      return [];
    }
    const unique = [...new Set(args.ownerIds)].slice(0, 256);
    const profiles = await Promise.all(
      unique.map((ownerId) => getSocialProfileByOwnerId(ctx, ownerId)),
    );
    return profiles
      .filter((profile): profile is NonNullable<typeof profile> =>
        Boolean(profile),
      )
      .map((profile) => ({
        ownerId: profile.ownerId,
        username: profile.username,
        avatarUrl: profile.avatarUrl,
      }));
  },
});

export const updateMyAvatar = mutation({
  args: {
    avatarUrl: v.union(v.string(), v.null()),
  },
  returns: socialProfileValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "social_update_my_avatar",
      ownerId,
      RATE_SETTINGS,
      "Too many profile updates. Please wait a moment and try again.",
    );
    const profile = await ensureSocialProfileDoc(ctx, ownerId);

    const next = args.avatarUrl?.trim();
    const patch: { avatarUrl?: string | undefined; updatedAt: number } = {
      updatedAt: Date.now(),
    };
    if (next) {
      requireBoundedString(next, "avatarUrl", 2000);
      patch.avatarUrl = next;
    } else {
      patch.avatarUrl = undefined;
    }

    await ctx.db.patch(profile._id, patch);
    const updated = await ctx.db.get(profile._id);
    if (!updated) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to update social profile",
      });
    }
    return updated;
  },
});
