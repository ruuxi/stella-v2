import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { constantTimeEqual, hashSha256Hex } from "./lib/crypto_utils";
import { requireBoundedString } from "./shared_validators";

export const MOBILE_BRIDGE_LEASE_MS = 150_000;
/**
 * The desktop re-registers on a short interval (and often fires two requests
 * back-to-back as its LAN and tunnel URLs become ready). Each register is a
 * full patch of the same row, which also invalidates every subscription that
 * reads it. `updatedAt` doubles as the lease heartbeat (`leaseExpiresAt =
 * updatedAt + MOBILE_BRIDGE_LEASE_MS`), so we still refresh it periodically --
 * but far less often than the client re-registers. When the registration
 * content is unchanged we only re-write once the row is older than this
 * interval, which collapses the redundant burst writes while keeping the lease
 * comfortably fresh (a third of the lease window).
 */
const MOBILE_BRIDGE_REGISTRATION_MIN_REFRESH_MS = MOBILE_BRIDGE_LEASE_MS / 3;
/**
 * Bridge sessions live for an hour (was 15 minutes) so a phone that persisted
 * its session across an app restart can reconnect without a fresh
 * challenge/mint round-trip. The secret is stored hashed, the desktop still
 * re-validates via `consumeSession`, and both ends expire the session
 * client-side at this same horizon.
 */
export const MOBILE_BRIDGE_SESSION_TTL_MS = 60 * 60_000;
/**
 * Hard caps on the `baseUrls` array stored on each registration row. The
 * array is unbounded by schema (`v.array(v.string())`); without these caps a
 * misbehaving client could grow the document until it hits the 1MB Convex
 * document limit and corrupts the row for every subsequent heartbeat.
 */
const MAX_BASE_URLS_PER_REGISTRATION = 8;
const MAX_BASE_URL_LENGTH = 2048;
const BRIDGE_SESSION_ID_BYTES = 18;
const BRIDGE_SESSION_SECRET_BYTES = 32;
const SESSION_CLEANUP_SCAN_LIMIT = 20;

/**
 * Trim, dedupe and cap the caller-provided list so the persisted array stays
 * tiny and predictable. Preserves caller order so the most recently
 * registered URL keeps priority for downstream consumers.
 */
const sanitizeBaseUrls = (raw: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    requireBoundedString(trimmed, "baseUrl", MAX_BASE_URL_LENGTH);
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_BASE_URLS_PER_REGISTRATION) break;
  }
  if (out.length === 0) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "baseUrls must contain at least one non-empty URL",
    });
  }
  return out;
};

const bridgeRegistrationValidator = v.object({
  deviceId: v.string(),
  baseUrls: v.array(v.string()),
  updatedAt: v.number(),
  leaseExpiresAt: v.number(),
  platform: v.optional(v.string()),
  desktopPublicKey: v.optional(v.string()),
  available: v.boolean(),
});

const bridgeSessionValidator = v.object({
  sessionId: v.string(),
  sessionSecret: v.string(),
  expiresAt: v.number(),
  desktopPublicKey: v.string(),
});

const consumedBridgeSessionValidator = v.union(
  v.null(),
  v.object({
    sessionId: v.string(),
    mobileDeviceId: v.string(),
    mobilePublicKey: v.string(),
    desktopPublicKey: v.string(),
    desktopChallenge: v.string(),
    expiresAt: v.number(),
  }),
);

const getLeaseExpiresAt = (updatedAt: number) =>
  updatedAt + MOBILE_BRIDGE_LEASE_MS;

const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const randomBase64Url = (byteLength: number) => {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64Url(bytes);
};

const loadLatestRegistration = async (ctx: QueryCtx, ownerId: string) => {
  const [registration] = await ctx.db
    .query("mobile_bridge_registrations")
    .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
    .order("desc")
    .take(1);
  return registration ?? null;
};

const resolveRegistrationPlatform = async (
  ctx: QueryCtx,
  args: { ownerId: string; deviceId: string; platform?: string },
) => {
  if (args.platform) {
    return args.platform;
  }

  const device = await ctx.db
    .query("devices")
    .withIndex("by_ownerId_and_deviceId", (q) =>
      q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
    )
    .unique();
  return device?.platform ?? undefined;
};

export const upsertRegistration = internalMutation({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    baseUrls: v.array(v.string()),
    updatedAt: v.number(),
    platform: v.optional(v.string()),
    desktopPublicKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx: MutationCtx, args) => {
    const sanitizedBaseUrls = sanitizeBaseUrls(args.baseUrls);
    const existing = await ctx.db
      .query("mobile_bridge_registrations")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
      )
      .unique();

    if (existing) {
      // Skip redundant writes: when the caller-supplied content matches what is
      // already stored and the lease is still comfortably fresh, avoid the
      // patch entirely. This absorbs the desktop's back-to-back duplicate
      // registrations (and any no-op refreshes) without churning the row or
      // invalidating the subscriptions that read it. A content change or a
      // stale-enough lease always falls through to the patch below so the
      // registration stays authoritative and `updatedAt` keeps the lease live.
      const baseUrlsUnchanged =
        existing.baseUrls.length === sanitizedBaseUrls.length &&
        existing.baseUrls.every((url, i) => url === sanitizedBaseUrls[i]);
      const platformUnchanged =
        args.platform === undefined || args.platform === existing.platform;
      const desktopPublicKeyUnchanged =
        args.desktopPublicKey === undefined ||
        args.desktopPublicKey === existing.desktopPublicKey;
      const leaseStillFresh =
        args.updatedAt - existing.updatedAt <
        MOBILE_BRIDGE_REGISTRATION_MIN_REFRESH_MS;
      if (
        baseUrlsUnchanged &&
        platformUnchanged &&
        desktopPublicKeyUnchanged &&
        leaseStillFresh
      ) {
        return null;
      }

      await ctx.db.patch(existing._id, {
        baseUrls: sanitizedBaseUrls,
        updatedAt: args.updatedAt,
        ...(args.platform !== undefined ? { platform: args.platform } : {}),
        ...(args.desktopPublicKey !== undefined
          ? { desktopPublicKey: args.desktopPublicKey }
          : {}),
      });
      return null;
    }

    await ctx.db.insert("mobile_bridge_registrations", {
      ownerId: args.ownerId,
      deviceId: args.deviceId,
      baseUrls: sanitizedBaseUrls,
      updatedAt: args.updatedAt,
      ...(args.platform !== undefined ? { platform: args.platform } : {}),
      ...(args.desktopPublicKey !== undefined
        ? { desktopPublicKey: args.desktopPublicKey }
        : {}),
    });
    return null;
  },
});

export const clearRegistration = internalMutation({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx: MutationCtx, args) => {
    const existing = await ctx.db
      .query("mobile_bridge_registrations")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
      )
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return null;
  },
});

export const getLatestRegistrationForOwner = internalQuery({
  args: {
    ownerId: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(v.null(), bridgeRegistrationValidator),
  handler: async (ctx: QueryCtx, args) => {
    const registration = await loadLatestRegistration(ctx, args.ownerId);
    if (!registration) {
      return null;
    }

    const platform = await resolveRegistrationPlatform(ctx, {
      ownerId: args.ownerId,
      deviceId: registration.deviceId,
      platform: registration.platform,
    });

    return {
      deviceId: registration.deviceId,
      baseUrls: registration.baseUrls,
      updatedAt: registration.updatedAt,
      leaseExpiresAt: getLeaseExpiresAt(registration.updatedAt),
      ...(platform ? { platform } : {}),
      ...(registration.desktopPublicKey
        ? { desktopPublicKey: registration.desktopPublicKey }
        : {}),
      available: getLeaseExpiresAt(registration.updatedAt) > args.nowMs,
    };
  },
});

export const getRegistrationForOwnerDevice = internalQuery({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(v.null(), bridgeRegistrationValidator),
  handler: async (ctx: QueryCtx, args) => {
    const registration = await ctx.db
      .query("mobile_bridge_registrations")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
      )
      .unique();
    if (!registration) {
      return null;
    }

    const platform = await resolveRegistrationPlatform(ctx, {
      ownerId: args.ownerId,
      deviceId: registration.deviceId,
      platform: registration.platform,
    });

    return {
      deviceId: registration.deviceId,
      baseUrls: registration.baseUrls,
      updatedAt: registration.updatedAt,
      leaseExpiresAt: getLeaseExpiresAt(registration.updatedAt),
      ...(platform ? { platform } : {}),
      ...(registration.desktopPublicKey
        ? { desktopPublicKey: registration.desktopPublicKey }
        : {}),
      available: getLeaseExpiresAt(registration.updatedAt) > args.nowMs,
    };
  },
});

export const createSession = internalMutation({
  args: {
    ownerId: v.string(),
    desktopDeviceId: v.string(),
    mobileDeviceId: v.string(),
    desktopChallenge: v.string(),
    desktopPublicKey: v.string(),
    mobilePublicKey: v.string(),
    createdAt: v.number(),
  },
  returns: bridgeSessionValidator,
  handler: async (ctx: MutationCtx, args) => {
    const previous = await ctx.db
      .query("mobile_bridge_sessions")
      .withIndex("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("desktopDeviceId", args.desktopDeviceId)
          .eq("mobileDeviceId", args.mobileDeviceId),
      )
      .take(SESSION_CLEANUP_SCAN_LIMIT);
    await Promise.all(
      previous
        .filter((session) => session.expiresAt <= args.createdAt)
        .map((session) => ctx.db.delete(session._id)),
    );

    const sessionId = randomBase64Url(BRIDGE_SESSION_ID_BYTES);
    const sessionSecret = randomBase64Url(BRIDGE_SESSION_SECRET_BYTES);
    const expiresAt = args.createdAt + MOBILE_BRIDGE_SESSION_TTL_MS;
    await ctx.db.insert("mobile_bridge_sessions", {
      ownerId: args.ownerId,
      desktopDeviceId: args.desktopDeviceId,
      mobileDeviceId: args.mobileDeviceId,
      sessionId,
      sessionSecretHash: await hashSha256Hex(sessionSecret),
      desktopChallenge: args.desktopChallenge,
      desktopPublicKey: args.desktopPublicKey,
      mobilePublicKey: args.mobilePublicKey,
      createdAt: args.createdAt,
      expiresAt,
      lastSeenAt: args.createdAt,
    });
    return {
      sessionId,
      sessionSecret,
      expiresAt,
      desktopPublicKey: args.desktopPublicKey,
    };
  },
});

export const consumeSession = internalMutation({
  args: {
    ownerId: v.string(),
    desktopDeviceId: v.string(),
    sessionId: v.string(),
    sessionSecret: v.string(),
    desktopChallenge: v.string(),
    nowMs: v.number(),
  },
  returns: consumedBridgeSessionValidator,
  handler: async (ctx: MutationCtx, args) => {
    const session = await ctx.db
      .query("mobile_bridge_sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (
      !session ||
      session.ownerId !== args.ownerId ||
      session.desktopDeviceId !== args.desktopDeviceId ||
      session.desktopChallenge !== args.desktopChallenge ||
      session.expiresAt <= args.nowMs
    ) {
      return null;
    }

    const secretOk = constantTimeEqual(
      await hashSha256Hex(args.sessionSecret),
      session.sessionSecretHash,
    );
    if (!secretOk) {
      return null;
    }

    await ctx.db.patch(session._id, { lastSeenAt: args.nowMs });
    return {
      sessionId: session.sessionId,
      mobileDeviceId: session.mobileDeviceId,
      mobilePublicKey: session.mobilePublicKey,
      desktopPublicKey: session.desktopPublicKey,
      desktopChallenge: session.desktopChallenge,
      expiresAt: session.expiresAt,
    };
  },
});
