import { ConvexError, v } from "convex/values";
import {
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireSensitiveUserId } from "./auth";
import { scheduleOwnerSnapshotChanged } from "./lib/owner_snapshot_notify";
import { enforceMutationRateLimit, RATE_STANDARD } from "./lib/rate_limits";

/**
 * Desktop device identity succession.
 *
 * A desktop whose local keypair stops being readable cannot keep its identity:
 * it mints a fresh `deviceId` instead. Stable device profiles remain separate
 * from feature-scoped liveness such as mobile bridge leases.
 *
 * Every phone-facing record is keyed by that id (`paired_mobile_devices`,
 * `mobile_bridge_registrations`, `cloudflare_tunnels`), and the phone pins the
 * id it paired with. So a rotation used to strand the phone on a dead id — it
 * polled a device that would never register a bridge again, saw the desktop as
 * permanently offline, and only re-pairing recovered it.
 *
 * Succession fixes that without introducing a global liveness dependency: the
 * new identity is an ordinary, fully-valid device, and it simply inherits the
 * retired id's records. Both ids are owner-scoped and the caller holds an
 * authenticated account session, so no new trust is granted here.
 */

/** Bounded so a corrupted chain can never spin a query forever. */
const MAX_SUCCESSION_HOPS = 8;
/** Per-owner cap on rows touched in one migration; keeps the mutation bounded. */
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

/**
 * Follow the succession chain to the identity a retired device id now resolves
 * to. Returns the input unchanged when the id is current (the common case), so
 * callers can use this unconditionally.
 */
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
    // A cycle would mean corrupted data; stop rather than loop.
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
      // The phone re-paired against the new identity on its own; that row is
      // authoritative and this one is a leftover.
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
    // The new identity already re-registered; its lease is the live one.
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
    // The new identity already provisioned its own tunnel. Leave the retired
    // row in place: the Cloudflare-side tunnel still exists and tearing it down
    // needs an API call, which a mutation cannot make.
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

  // Inheriting the tunnel keeps the previously advertised hostname working, so
  // a phone holding a cached base URL stays pointed somewhere real.
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
      // The retired id already points somewhere else. Re-pointing it would let
      // a later rotation steal an earlier one's pairings, so refuse.
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
    // Every pairing grant in the owner snapshot now names the new desktop id;
    // the gate would otherwise verify mobile proofs against the retired one.
    if (migratedPairings > 0) {
      await scheduleOwnerSnapshotChanged(ctx, ownerId, "pairing");
    }

    return {
      ok: true as const,
      migratedPairings,
      migratedRegistration,
      migratedTunnel,
    };
  },
});
