import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  assertSensitiveSessionPolicy,
  isAnonymousIdentity,
  requireConnectedUserId,
  requireSensitiveUserId,
} from "./auth";
import {
  constantTimeEqual,
  hashSha256Hex,
  hmacSha256Hex,
} from "./lib/crypto_utils";
import {
  enforceMutationRateLimit,
  RATE_HOT_PATH,
  RATE_SENSITIVE,
  RATE_VERY_EXPENSIVE,
} from "./lib/rate_limits";

const MOBILE_PAIRING_SESSION_TTL_MS = 10 * 60_000;
const MOBILE_CONNECT_INTENT_TTL_MS = 90_000;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
const PAIR_SECRET_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const PAIR_SECRET_LENGTH = 48;
// Bounded reads keep these helpers safe even if (owner, desktop) accumulates
// historical rows over time. Pairing sessions are short-lived and paired
// devices are typically a handful per desktop, so these caps are generous.
const PAIRING_SESSION_SCAN_LIMIT = 50;
const PAIRED_DEVICE_SCAN_LIMIT = 100;
const CONNECT_INTENT_SCAN_LIMIT = 20;
export const MOBILE_BRIDGE_PAIR_PROOF_VERSION =
  "stella-mobile-bridge-pair-proof-v1";

const pairedDeviceValidator = v.object({
  mobileDeviceId: v.string(),
  displayName: v.optional(v.string()),
  platform: v.optional(v.string()),
  approvedAt: v.number(),
  lastSeenAt: v.number(),
});

const pairingSessionValidator = v.union(
  v.null(),
  v.object({
    pairingCode: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  }),
);

const phoneAccessStateValidator = v.object({
  activePairing: pairingSessionValidator,
  pairedDevices: v.array(pairedDeviceValidator),
});

const connectIntentValidator = v.union(
  v.null(),
  v.object({
    intentId: v.id("mobile_connect_intents"),
    mobileDeviceId: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  }),
);

const randomToken = (length: number, alphabet: string) => {
  let value = "";
  const maxUnbiasedByte = 256 - (256 % alphabet.length);

  while (value.length < length) {
    const remaining = length - value.length;
    const bytes = crypto.getRandomValues(
      new Uint8Array(Math.max(remaining * 2, 16)),
    );
    for (const byte of bytes) {
      if (byte >= maxUnbiasedByte) {
        continue;
      }
      value += alphabet[byte % alphabet.length];
      if (value.length === length) {
        break;
      }
    }
  }

  return value;
};

const randomPairingCode = () =>
  randomToken(PAIRING_CODE_LENGTH, PAIRING_CODE_ALPHABET);
const randomPairSecret = () =>
  randomToken(PAIR_SECRET_LENGTH, PAIR_SECRET_ALPHABET);

const loadMostRecentUnusedPairingSession = async (
  ctx: QueryCtx | MutationCtx,
  args: { ownerId: string; desktopDeviceId: string },
) => {
  // Pairing sessions accumulate historically; bound the scan and pick the
  // most recent unused row. Callers in mutation contexts apply the live
  // expiry check against `Date.now()` themselves so query handlers stay
  // deterministic.
  const sessions = await ctx.db
    .query("mobile_pairing_sessions")
    .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
      q.eq("ownerId", args.ownerId).eq("desktopDeviceId", args.desktopDeviceId),
    )
    .order("desc")
    .take(PAIRING_SESSION_SCAN_LIMIT);

  return (
    sessions
      .filter((session) => !session.usedAt)
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  );
};

const listActivePairedDevices = async (
  ctx: QueryCtx | MutationCtx,
  args: { ownerId: string; desktopDeviceId: string },
) => {
  const devices = await ctx.db
    .query("paired_mobile_devices")
    .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
      q.eq("ownerId", args.ownerId).eq("desktopDeviceId", args.desktopDeviceId),
    )
    .take(PAIRED_DEVICE_SCAN_LIMIT);

  return devices
    .filter((device) => device.revokedAt === undefined)
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
};

const getPairedMobileDeviceRecord = async (
  ctx: QueryCtx | MutationCtx,
  args: {
    ownerId: string;
    desktopDeviceId: string;
    mobileDeviceId: string;
    includeRevoked?: boolean;
  },
) => {
  const records = await ctx.db
    .query("paired_mobile_devices")
    .withIndex("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", (q) =>
      q
        .eq("ownerId", args.ownerId)
        .eq("desktopDeviceId", args.desktopDeviceId)
        .eq("mobileDeviceId", args.mobileDeviceId),
    )
    .take(PAIRED_DEVICE_SCAN_LIMIT);

  const filtered = args.includeRevoked
    ? records
    : records.filter((record) => record.revokedAt === undefined);

  return (
    filtered.sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0] ??
    null
  );
};

export const verifyPairedMobileSecret = async (args: {
  pairSecret: string;
  pairSecretHash: string;
}) => {
  return constantTimeEqual(
    await hashSha256Hex(args.pairSecret),
    args.pairSecretHash,
  );
};

export const buildMobileBridgePairProofMessage = (args: {
  desktopDeviceId: string;
  mobileDeviceId: string;
  challenge: string;
  mobilePublicKey?: string;
  issuedAt: number;
}) =>
  [
    MOBILE_BRIDGE_PAIR_PROOF_VERSION,
    args.desktopDeviceId,
    args.mobileDeviceId,
    args.challenge,
    args.mobilePublicKey ?? "",
    String(args.issuedAt),
  ].join("\n");

export const verifyPairedMobileProof = async (args: {
  pairSecretHash: string;
  proof: string;
  desktopDeviceId: string;
  mobileDeviceId: string;
  challenge: string;
  mobilePublicKey?: string;
  issuedAt: number;
}) => {
  const expected = await hmacSha256Hex(
    args.pairSecretHash,
    buildMobileBridgePairProofMessage(args),
  );
  return constantTimeEqual(expected, args.proof.toLowerCase());
};

export const getPhoneAccessState = query({
  args: {
    desktopDeviceId: v.string(),
  },
  returns: phoneAccessStateValidator,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || isAnonymousIdentity(identity)) {
      return { activePairing: null, pairedDevices: [] };
    }
    // This query exposes the live pairing code; a revoked session must not
    // be able to read it. Return the signed-out shape instead of throwing so
    // UI subscriptions degrade gracefully.
    try {
      await assertSensitiveSessionPolicy(ctx, identity);
    } catch {
      return { activePairing: null, pairedDevices: [] };
    }
    const ownerId = identity.tokenIdentifier;
    const [activePairing, pairedDevices] = await Promise.all([
      loadMostRecentUnusedPairingSession(ctx, {
        ownerId,
        desktopDeviceId: args.desktopDeviceId,
      }),
      listActivePairedDevices(ctx, {
        ownerId,
        desktopDeviceId: args.desktopDeviceId,
      }),
    ]);

    return {
      activePairing: activePairing
        ? {
            pairingCode: activePairing.pairingCode,
            expiresAt: activePairing.expiresAt,
            createdAt: activePairing.createdAt,
          }
        : null,
      pairedDevices: pairedDevices.map((device) => ({
        mobileDeviceId: device.mobileDeviceId,
        ...(device.displayName ? { displayName: device.displayName } : {}),
        ...(device.platform ? { platform: device.platform } : {}),
        approvedAt: device.approvedAt,
        lastSeenAt: device.lastSeenAt,
      })),
    };
  },
});

export const createPairingSession = mutation({
  args: {
    desktopDeviceId: v.string(),
  },
  returns: v.object({
    pairingCode: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
    pairingUrl: v.string(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSensitiveUserId(ctx);
    // Each pairing session writes a new row + cleanup work. Tight cap so a
    // hijacked session can't churn pairing codes.
    await enforceMutationRateLimit(
      ctx,
      "mobile_access_create_pairing_session",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many pairing requests. Please wait a minute and try again.",
    );
    const createdAt = Date.now();
    const existing = await loadMostRecentUnusedPairingSession(ctx, {
      ownerId,
      desktopDeviceId: args.desktopDeviceId,
    });
    if (existing && existing.expiresAt > createdAt) {
      return {
        pairingCode: existing.pairingCode,
        expiresAt: existing.expiresAt,
        createdAt: existing.createdAt,
        pairingUrl: `stella-mobile://stella?code=${encodeURIComponent(existing.pairingCode)}`,
      };
    }

    const expiresAt = createdAt + MOBILE_PAIRING_SESSION_TTL_MS;
    let pairingCode = randomPairingCode();

    // Regenerate on ANY existing row with this code (even expired/used ones):
    // historical rows are never deleted, and inserting a second row with the
    // same code would make the `.unique()` lookup in `completePairingSession`
    // throw for both.
    let codeIsFree = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const conflict = await ctx.db
        .query("mobile_pairing_sessions")
        .withIndex("by_pairingCode", (q) => q.eq("pairingCode", pairingCode))
        .first();
      if (!conflict) {
        codeIsFree = true;
        break;
      }
      pairingCode = randomPairingCode();
    }
    if (!codeIsFree) {
      throw new ConvexError({
        code: "RESOURCE_EXHAUSTED",
        message: "Could not allocate a pairing code. Please try again.",
      });
    }

    await ctx.db.insert("mobile_pairing_sessions", {
      ownerId,
      desktopDeviceId: args.desktopDeviceId,
      pairingCode,
      createdAt,
      expiresAt,
    });

    return {
      pairingCode,
      expiresAt,
      createdAt,
      pairingUrl: `stella-mobile://stella?code=${encodeURIComponent(pairingCode)}`,
    };
  },
});

export const revokePairedMobileDevice = mutation({
  args: {
    desktopDeviceId: v.string(),
    mobileDeviceId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireSensitiveUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "mobile_access_revoke_paired_mobile_device",
      ownerId,
      RATE_SENSITIVE,
      "Too many revocation requests. Please wait a minute and try again.",
    );
    const record = await getPairedMobileDeviceRecord(ctx, {
      ownerId,
      desktopDeviceId: args.desktopDeviceId,
      mobileDeviceId: args.mobileDeviceId,
    });
    if (!record) {
      return null;
    }
    await ctx.db.patch(record._id, { revokedAt: Date.now() });
    return null;
  },
});

export const watchIncomingConnectIntent = query({
  args: {
    desktopDeviceId: v.string(),
    // Optional legacy polling clock. When a caller passes a per-tick timestamp
    // it becomes part of the query args, so every poll is a unique
    // (uncacheable) subscription that re-executes on every tick instead of only
    // when the underlying intents change. Newer clients omit it and gate on the
    // returned `expiresAt` themselves, which lets Convex serve this reactive
    // subscription from cache. Kept optional so existing desktops keep working
    // unchanged during rollout.
    nowMs: v.optional(v.number()),
  },
  returns: connectIntentValidator,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || isAnonymousIdentity(identity)) {
      return null;
    }
    const ownerId = identity.tokenIdentifier;
    // Scan by the stable (ownerId, desktopDeviceId) prefix, newest first. When
    // a caller supplies `nowMs` we additionally bound the range to un-expired
    // intents for backward-compatible behavior; otherwise we return the
    // freshest unacknowledged intent and let the caller apply the live expiry
    // check against `expiresAt` (consistent with the pairing-session queries in
    // this module, which also delegate live expiry to their callers).
    const intents = await ctx.db
      .query("mobile_connect_intents")
      .withIndex("by_ownerId_and_desktopDeviceId_and_expiresAt", (q) => {
        const prefix = q
          .eq("ownerId", ownerId)
          .eq("desktopDeviceId", args.desktopDeviceId);
        return args.nowMs !== undefined
          ? prefix.gt("expiresAt", args.nowMs)
          : prefix;
      })
      .order("desc")
      .take(CONNECT_INTENT_SCAN_LIMIT);

    const intent =
      intents
        .filter((entry) => !entry.acknowledgedAt)
        .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;

    if (!intent) {
      return null;
    }

    return {
      intentId: intent._id,
      mobileDeviceId: intent.mobileDeviceId,
      createdAt: intent.createdAt,
      expiresAt: intent.expiresAt,
    };
  },
});

export const acknowledgeConnectIntent = mutation({
  args: {
    intentId: v.id("mobile_connect_intents"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "mobile_access_acknowledge_connect_intent",
      ownerId,
      RATE_HOT_PATH,
    );
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.ownerId !== ownerId || intent.acknowledgedAt) {
      return null;
    }
    await ctx.db.patch(args.intentId, { acknowledgedAt: Date.now() });
    return null;
  },
});

export const getPairedMobileDevice = internalQuery({
  args: {
    ownerId: v.string(),
    desktopDeviceId: v.string(),
    mobileDeviceId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      pairSecretHash: v.string(),
      displayName: v.optional(v.string()),
      platform: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const record = await getPairedMobileDeviceRecord(ctx, args);
    if (!record) {
      return null;
    }
    return {
      pairSecretHash: record.pairSecretHash,
      ...(record.displayName ? { displayName: record.displayName } : {}),
      ...(record.platform ? { platform: record.platform } : {}),
    };
  },
});

export const markPairedMobileSeen = internalMutation({
  args: {
    ownerId: v.string(),
    desktopDeviceId: v.string(),
    mobileDeviceId: v.string(),
    seenAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const record = await getPairedMobileDeviceRecord(ctx, args);
    if (!record) {
      return null;
    }
    await ctx.db.patch(record._id, { lastSeenAt: args.seenAt });
    return null;
  },
});

export const completePairingSession = internalMutation({
  args: {
    ownerId: v.string(),
    pairingCode: v.string(),
    mobileDeviceId: v.string(),
    displayName: v.optional(v.string()),
    platform: v.optional(v.string()),
  },
  returns: v.object({
    desktopDeviceId: v.string(),
    approvedAt: v.number(),
    pairSecret: v.string(),
  }),
  handler: async (ctx, args) => {
    const pairingSession = await ctx.db
      .query("mobile_pairing_sessions")
      .withIndex("by_pairingCode", (q) => q.eq("pairingCode", args.pairingCode))
      .unique();

    if (
      !pairingSession ||
      pairingSession.ownerId !== args.ownerId ||
      pairingSession.usedAt !== undefined ||
      pairingSession.expiresAt <= Date.now()
    ) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "This pairing code is unavailable.",
      });
    }

    const approvedAt = Date.now();
    const pairSecret = randomPairSecret();
    const pairSecretHash = await hashSha256Hex(pairSecret);
    const existing = await getPairedMobileDeviceRecord(ctx, {
      ownerId: args.ownerId,
      desktopDeviceId: pairingSession.desktopDeviceId,
      mobileDeviceId: args.mobileDeviceId,
      includeRevoked: true,
    });

    if (existing) {
      await ctx.db.patch(existing._id, {
        pairSecretHash,
        ...(args.displayName !== undefined
          ? { displayName: args.displayName }
          : {}),
        ...(args.platform !== undefined ? { platform: args.platform } : {}),
        lastSeenAt: approvedAt,
        revokedAt: undefined,
      });
    } else {
      await ctx.db.insert("paired_mobile_devices", {
        ownerId: args.ownerId,
        desktopDeviceId: pairingSession.desktopDeviceId,
        mobileDeviceId: args.mobileDeviceId,
        pairSecretHash,
        ...(args.displayName !== undefined
          ? { displayName: args.displayName }
          : {}),
        ...(args.platform !== undefined ? { platform: args.platform } : {}),
        approvedAt,
        lastSeenAt: approvedAt,
      });
    }

    await ctx.db.patch(pairingSession._id, { usedAt: approvedAt });

    return {
      desktopDeviceId: pairingSession.desktopDeviceId,
      approvedAt,
      pairSecret,
    };
  },
});

export const upsertConnectIntent = internalMutation({
  args: {
    ownerId: v.string(),
    desktopDeviceId: v.string(),
    mobileDeviceId: v.string(),
    createdAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("mobile_connect_intents")
      .withIndex("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("desktopDeviceId", args.desktopDeviceId)
          .eq("mobileDeviceId", args.mobileDeviceId),
      )
      .unique();

    const expiresAt = args.createdAt + MOBILE_CONNECT_INTENT_TTL_MS;
    if (existing) {
      await ctx.db.patch(existing._id, {
        createdAt: args.createdAt,
        expiresAt,
        acknowledgedAt: undefined,
      });
      return null;
    }

    await ctx.db.insert("mobile_connect_intents", {
      ownerId: args.ownerId,
      desktopDeviceId: args.desktopDeviceId,
      mobileDeviceId: args.mobileDeviceId,
      createdAt: args.createdAt,
      expiresAt,
    });
    return null;
  },
});
