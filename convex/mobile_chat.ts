import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import {
  assertSensitiveSessionPolicyAction,
  isAnonymousIdentity,
} from "./auth";
import {
  enforceActionRateLimit,
  RATE_STANDARD,
} from "./lib/rate_limits";
import { verifyPairedMobileSecret } from "./mobile_access";

const MAX_DEVICE_ID_LENGTH = 256;

const normalizeDeviceId = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_DEVICE_ID_LENGTH);
};

/**
 * Legacy public chat action retained for older mobile builds.
 * Current mobile Computer chat goes over the authenticated desktop bridge
 * and this action deliberately does not enqueue or persist message content.
 */
export const sendChat = action({
  args: {
    message: v.string(),
    mobileDeviceId: v.string(),
    desktopDeviceId: v.string(),
    pairSecret: v.string(),
    model: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ kind: v.literal("sync"), text: v.string() }),
    v.object({ kind: v.literal("pending"), requestId: v.string() }),
    v.object({ kind: v.literal("unavailable"), text: v.string() }),
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || isAnonymousIdentity(identity)) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Sign in with an account to message your computer.",
      });
    }
    await assertSensitiveSessionPolicyAction(ctx, identity);

    const ownerId = identity.tokenIdentifier;
    await enforceActionRateLimit(
      ctx,
      "mobile_chat_send",
      ownerId,
      RATE_STANDARD,
      "Slow down a moment and try again.",
    );

    const mobileDeviceId = normalizeDeviceId(args.mobileDeviceId);
    if (!mobileDeviceId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "mobileDeviceId is required.",
      });
    }
    const desktopDeviceId = normalizeDeviceId(args.desktopDeviceId);
    const pairSecret = args.pairSecret.trim();
    if (!desktopDeviceId || !pairSecret) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Pair this phone with your desktop again.",
      });
    }

    const pairedDevice = await ctx.runQuery(
      internal.mobile_access.getPairedMobileDevice,
      {
        ownerId,
        desktopDeviceId,
        mobileDeviceId,
      },
    );
    if (
      !pairedDevice ||
      !(await verifyPairedMobileSecret({
        pairSecret,
        pairSecretHash: pairedDevice.pairSecretHash,
      }))
    ) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Pair this phone with your desktop again.",
      });
    }

    await ctx.runMutation(internal.mobile_access.markPairedMobileSeen, {
      ownerId,
      desktopDeviceId,
      mobileDeviceId,
      seenAt: Date.now(),
    });

    return {
      kind: "unavailable" as const,
      text: "Update Stella mobile to message your desktop through the secure desktop bridge.",
    };
  },
});

/**
 * Cancel a previously-deferred remote turn (the `pending` requestId returned
 * by `sendChat`). Patches the request row to `cancelled`; the local device's
 * remote-turn bridge subscribes to a dedicated cancel feed and aborts the
 * active orchestrator run when it sees the matching requestId.
 *
 * Idempotent and best-effort: if the desktop already published a reply the
 * cancel becomes a no-op. Auth mirrors `sendChat` — same pair-secret check
 * so an unrelated device can't cancel someone else's turn.
 */
export const cancelChat = action({
  args: {
    requestId: v.string(),
    mobileDeviceId: v.string(),
    desktopDeviceId: v.string(),
    pairSecret: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || isAnonymousIdentity(identity)) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Sign in with an account to message your computer.",
      });
    }
    await assertSensitiveSessionPolicyAction(ctx, identity);

    const ownerId = identity.tokenIdentifier;
    await enforceActionRateLimit(
      ctx,
      "mobile_chat_cancel",
      ownerId,
      RATE_STANDARD,
      "Slow down a moment and try again.",
    );

    const requestId = args.requestId.trim();
    const mobileDeviceId = normalizeDeviceId(args.mobileDeviceId);
    const desktopDeviceId = normalizeDeviceId(args.desktopDeviceId);
    const pairSecret = args.pairSecret.trim();
    if (!requestId || !mobileDeviceId || !desktopDeviceId || !pairSecret) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Missing pairing information.",
      });
    }

    const pairedDevice = await ctx.runQuery(
      internal.mobile_access.getPairedMobileDevice,
      {
        ownerId,
        desktopDeviceId,
        mobileDeviceId,
      },
    );
    if (
      !pairedDevice ||
      !(await verifyPairedMobileSecret({
        pairSecret,
        pairSecretHash: pairedDevice.pairSecretHash,
      }))
    ) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Pair this phone with your desktop again.",
      });
    }

    await ctx.runMutation(api.channels.connector_delivery.cancelRemoteTurn, {
      requestId,
    });

    return null;
  },
});
