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
import { processIncomingMessage } from "./channels/message_pipeline";
import { verifyPairedMobileSecret } from "./mobile_access";

const MAX_MESSAGE_CHARS = 12_000;
const MAX_DEVICE_ID_LENGTH = 256;

const normalizeDeviceId = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_DEVICE_ID_LENGTH);
};

/**
 * Public chat action invoked by the Stella mobile React client.
 *
 * Replaces the older `/api/mobile/chat` HTTP long-poll: the mobile
 * client now subscribes reactively to `mobile_replies.watchDesktopReply`
 * for `requestId` after this action returns. When the desktop completes
 * the turn and publishes its reply, the mobile subscription notifies
 * the phone, the phone renders the text, then deletes the row via
 * `mobile_replies.acknowledgeDesktopReply`.
 *
 * Returns:
 *   - `{ kind: "sync", text }` — message was answered synchronously by
 *     `processIncomingMessage` (rare; e.g. a device-selection prompt
 *     reply that doesn't need a desktop turn).
 *   - `{ kind: "pending", requestId }` — deferred to the user's
 *     desktop; mobile subscribes to `requestId` for the reply.
 *   - `{ kind: "unavailable", text }` — pipeline could not produce a
 *     reply (no desktop, no fallback available).
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

    const message = args.message.slice(0, MAX_MESSAGE_CHARS).trim();
    const mobileDeviceId = normalizeDeviceId(args.mobileDeviceId);
    if (!message) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Message is required.",
      });
    }
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

    const result = await processIncomingMessage({
      ctx,
      ownerId,
      provider: "stella_app",
      externalUserId: mobileDeviceId,
      text: message,
      targetDeviceId: desktopDeviceId,
      preEnsureOwnerConnection: true,
      deliveryMeta: {
        mobileOwnerId: ownerId,
        ...(args.model?.trim() ? { mobileModel: args.model.trim() } : {}),
      },
    });

    if (!result) {
      return {
        kind: "unavailable" as const,
        text: "Could not send your message. Please try again.",
      };
    }

    if (result.deferred && result.requestId) {
      return { kind: "pending" as const, requestId: result.requestId };
    }

    if (result.unavailable) {
      return { kind: "unavailable" as const, text: result.text };
    }

    if (result.text) {
      return { kind: "sync" as const, text: result.text };
    }

    return {
      kind: "unavailable" as const,
      text: "Your desktop is offline right now. Open Stella on your desktop and try again.",
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
