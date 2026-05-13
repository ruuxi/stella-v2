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

const optionalProfileValidator = v.union(v.null(), socialProfileValidator);

const syncStoreAuthorProfile = async (
  ctx: MutationCtx,
  ownerId: string,
  username: string,
) => {
  const packages = await ctx.db
    .query("store_packages")
    .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
    .take(500);
  await Promise.all(
    packages.map((pkg) =>
      ctx.db.patch(pkg._id, {
        authorUsername: username,
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
    await syncStoreAuthorProfile(ctx, args.ownerId, profile.username);
    return profile;
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
 * Public lookup by `@username`. Returned shape is the full profile validator
 * minus internal fields — same identifier the user types into the friend-add
 * input, used as the store author handle, and renders on profile cards.
 */
export const getProfileByUsername = query({
  args: { username: v.string() },
  returns: optionalProfileValidator,
  handler: async (ctx, args) => {
    const username = args.username.trim().toLowerCase();
    if (!username) return null;
    return await ctx.db
      .query("social_profiles")
      .withIndex("by_username", (q) => q.eq("username", username))
      .unique();
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
    await syncStoreAuthorProfile(ctx, ownerId, username);
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
