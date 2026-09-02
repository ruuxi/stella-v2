import { v } from "convex/values";
import type { NetworkClass } from "@stella/contracts/gateway/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { identityLevelValidator } from "./lib/identity_level";

type IdentityLevel = 0 | 1 | 2 | 3;
type OwnerOriginPlatform = "ios" | "android" | "web";

const higherIdentityLevel = (
  left: IdentityLevel,
  right: IdentityLevel,
): IdentityLevel => (left >= right ? left : right);

const networkClassValidator = v.union(
  v.literal("hosting"),
  v.literal("vpn"),
  v.literal("residential"),
  v.literal("mobile"),
  v.literal("edu"),
  v.literal("unknown"),
);

const ownerOriginPlatformValidator = v.union(
  v.literal("ios"),
  v.literal("android"),
  v.literal("web"),
);

export const recordOwnerOrigin = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    deviceKeyHash?: string;
    ipHash?: string;
    networkClass?: NetworkClass;
    emailDomain?: string;
    platform?: OwnerOriginPlatform;
    identityLevel: IdentityLevel;
    now: number;
  },
): Promise<void> => {
  const existing = await ctx.db
    .query("owner_origins")
    .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
    .unique();
  if (!existing) {
    await ctx.db.insert("owner_origins", {
      ownerId: args.ownerId,
      ...(args.deviceKeyHash ? { deviceKeyHash: args.deviceKeyHash } : {}),
      ...(args.ipHash ? { ipHash: args.ipHash } : {}),
      ...(args.networkClass ? { networkClass: args.networkClass } : {}),
      ...(args.emailDomain ? { emailDomain: args.emailDomain } : {}),
      ...(args.platform ? { platform: args.platform } : {}),
      identityLevel: args.identityLevel,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return;
  }
  const networkClass =
    !existing.networkClass &&
    args.networkClass &&
    (!existing.ipHash || existing.ipHash === args.ipHash)
      ? args.networkClass
      : undefined;
  await ctx.db.patch(existing._id, {
    ...(!existing.deviceKeyHash && args.deviceKeyHash
      ? { deviceKeyHash: args.deviceKeyHash }
      : {}),
    ...(!existing.ipHash && args.ipHash ? { ipHash: args.ipHash } : {}),
    ...(networkClass ? { networkClass } : {}),
    ...(!existing.emailDomain && args.emailDomain
      ? { emailDomain: args.emailDomain }
      : {}),
    ...(!existing.platform && args.platform ? { platform: args.platform } : {}),
    identityLevel: higherIdentityLevel(
      existing.identityLevel,
      args.identityLevel,
    ),
    updatedAt: args.now,
  });
};

export const recordOwnerOriginInternal = internalMutation({
  args: {
    ownerId: v.string(),
    deviceKeyHash: v.optional(v.string()),
    ipHash: v.optional(v.string()),
    networkClass: v.optional(networkClassValidator),
    emailDomain: v.optional(v.string()),
    platform: v.optional(ownerOriginPlatformValidator),
    identityLevel: identityLevelValidator,
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordOwnerOrigin(ctx, args);
    return null;
  },
});
