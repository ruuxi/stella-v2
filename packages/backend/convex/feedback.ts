import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import {
  enforceMutationRateLimit,
  RATE_VERY_EXPENSIVE,
} from "./lib/rate_limits";

const FEEDBACK_MIN_LENGTH = 1;
export const FEEDBACK_MAX_LENGTH = 32_000;
const APP_VERSION_MAX_LENGTH = 64;
const PLATFORM_MAX_LENGTH = 64;

export const submitFeedback = mutation({
  args: {
    message: v.string(),
    appVersion: v.optional(v.string()),
    platform: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = args.message.trim();
    if (message.length < FEEDBACK_MIN_LENGTH) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Feedback can't be empty.",
      });
    }
    if (message.length > FEEDBACK_MAX_LENGTH) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Feedback is limited to ${FEEDBACK_MAX_LENGTH} characters.`,
      });
    }

    const identity = await ctx.auth.getUserIdentity();
    const rateKey = identity?.tokenIdentifier ?? "anonymous";
    await enforceMutationRateLimit(
      ctx,
      "feedback_submit",
      rateKey,
      RATE_VERY_EXPENSIVE,
      "Too many feedback submissions. Please try again in a minute.",
    );

    const appVersion = args.appVersion?.trim().slice(0, APP_VERSION_MAX_LENGTH);
    const platform = args.platform?.trim().slice(0, PLATFORM_MAX_LENGTH);

    await ctx.db.insert("user_feedback", {
      message,
      createdAt: Date.now(),
      ...(appVersion ? { appVersion } : {}),
      ...(platform ? { platform } : {}),
    });

    return null;
  },
});
