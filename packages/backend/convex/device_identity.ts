import { ConvexError, v } from "convex/values";
import {
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireSensitiveUserId } from "./auth";
import { enforceMutationRateLimit, RATE_STANDARD } from "./lib/rate_limits";

const MAX_SUCCESSION_HOPS = 8;

const MAX_MIGRATED_PAIRINGS = 64;

const sanitizeDeviceId = (value: string, label: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${label} is required`,
    });
  }
  return trimmed;
};

const loadSuccessor = async (
  ctx: QueryCtx,
  ownerId: string,
  previousDeviceId: string,
) =>
  await ctx.db
    .query("device_identity_successors")
    .withIndex("by_ownerId_and_previousDeviceId", (q) =>
      q.eq("ownerId", ownerId).eq("previousDeviceId", previousDeviceId),
    )
    .unique();

export const resolveCurrentDeviceId = async (
  ctx: QueryCtx,
  ownerId: string,
  deviceId: string,
): Promise<string> => {
  let current = deviceId;
  const seen = new Set<string>([current]);
  for (let hop = 0; hop < MAX_SUCCESSION_HOPS; hop += 1) {
    const successor = await loadSuccessor(ctx, ownerId, current);
    if (!successor) {
      return current;
    }

    if (seen.has(successor.deviceId)) {
      return current;
    }
    seen.add(successor.deviceId);
    current = successor.deviceId;
  }
  return current;
};

const migratePairedPhones = async (
  ctx: MutationCtx,
  ownerId: string,
  previousDeviceId: string,
  deviceId: string,
) => {
  const stale = await ctx.db
    .query("paired_mobile_devices")
    .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
      q.eq("ownerId", ownerId).eq("desktopDeviceId", previousDeviceId),
    )
    .take(MAX_MIGRATED_PAIRINGS);

  let migrated = 0;
  for (const row of stale) {
    const alreadyPaired = await ctx.db
      .query("paired_mobile_devices")
      .withIndex("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("desktopDeviceId", deviceId)
          .eq("mobileDeviceId", row.mobileDeviceId),
      )
      .unique();
    if (alreadyPaired) {

      await ctx.db.delete(row._id);
      continue;
    }
    await ctx.db.patch(row._id, { desktopDeviceId: deviceId });
    migrated += 1;
  }
  return migrated;
};

const migrateBridgeRegistration = async (
  ctx: MutationCtx,
  ownerId: string,
  previousDeviceId: string,
  deviceId: string,
) => {
  const stale = await ctx.db
    .query("mobile_bridge_registrations")
    .withIndex("by_ownerId_and_deviceId", (q) =>
      q.eq("ownerId", ownerId).eq("deviceId", previousDeviceId),
    )
    .unique();
  if (!stale) {
    return false;
  }

  const existing = await ctx.db
    .query("mobile_bridge_registrations")
    .withIndex("by_ownerId_and_deviceId", (q) =>
      q.eq("ownerId", ownerId).eq("deviceId", deviceId),
    )
    .unique();
  if (existing) {

    await ctx.db.delete(stale._id);
    return false;
  }

  await ctx.db.patch(stale._id, { deviceId });
  return true;
};

const migrateTunnel = async (
  ctx: MutationCtx,
  ownerId: string,
  previousDeviceId: string,
  deviceId: string,
) => {
  const existing = await ctx.db
    .query("cloudflare_tunnels")
    .withIndex("by_ownerId_and_deviceId", (q) =>
      q.eq("ownerId", ownerId).eq("deviceId", deviceId),
    )
    .unique();
  if (existing) {

    return false;
  }

  const stale = await ctx.db
    .query("cloudflare_tunnels")
    .withIndex("by_ownerId_and_deviceId", (q) =>
      q.eq("ownerId", ownerId).eq("deviceId", previousDeviceId),
    )
    .unique();
  if (!stale) {
    return false;
  }

  await ctx.db.patch(stale._id, { deviceId, updatedAt: Date.now() });
  return true;
};

export const adoptDeviceIdentitySuccession = mutation({
  args: {
    previousDeviceId: v.string(),
    deviceId: v.string(),
  },
  returns: v.object({
    ok: v.literal(true),
    migratedPairings: v.number(),
    migratedRegistration: v.boolean(),
    migratedTunnel: v.boolean(),
  }),
  handler: async (ctx: MutationCtx, args) => {
    const ownerId = await requireSensitiveUserId(ctx);
    const previousDeviceId = sanitizeDeviceId(
      args.previousDeviceId,
      "previousDeviceId",
    );
    const deviceId = sanitizeDeviceId(args.deviceId, "deviceId");

    if (previousDeviceId === deviceId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "previousDeviceId and deviceId must differ",
      });
    }

    await enforceMutationRateLimit(
      ctx,
      "device_identity_succession",
      ownerId,
      RATE_STANDARD,
      "Too many device identity rotations. Please wait and try again.",
    );

    const existing = await loadSuccessor(ctx, ownerId, previousDeviceId);
    if (existing) {
      if (existing.deviceId === deviceId) {
        return {
          ok: true as const,
          migratedPairings: 0,
          migratedRegistration: false,
          migratedTunnel: false,
        };
      }

      throw new ConvexError({
        code: "CONFLICT",
        message: "This device id has already been succeeded.",
      });
    }

    const migratedPairings = await migratePairedPhones(
      ctx,
      ownerId,
      previousDeviceId,
      deviceId,
    );
    const migratedRegistration = await migrateBridgeRegistration(
      ctx,
      ownerId,
      previousDeviceId,
      deviceId,
    );
    const migratedTunnel = await migrateTunnel(
      ctx,
      ownerId,
      previousDeviceId,
      deviceId,
    );

    await ctx.db.insert("device_identity_successors", {
      ownerId,
      previousDeviceId,
      deviceId,
      rotatedAt: Date.now(),
    });

    return {
      ok: true as const,
      migratedPairings,
      migratedRegistration,
      migratedTunnel,
    };
  },
});
