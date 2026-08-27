"use node";

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { purgeComposioSessionOnly } from "./composio_purge";
import { requireComposioConfig } from "./http_routes/native_oauth";

type CleanupClaim =
  | { kind: "absent" | "bound" | "outcome_unknown" }
  | { kind: "wait"; retryAt: number }
  | {
      kind: "cleanup";
      ownerId: string;
      ownerGeneration: string;
      integrationId: string;
      toolkit: string;
      composioUserId: string;
      sessionId: string;
    };

const claimCleanupRef = makeFunctionReference<
  "mutation",
  { attemptId: string; leaseId: string; now: number },
  CleanupClaim
>("composio_session_dispatch:claimComposioSessionProvisioningCleanupInternal");
const acknowledgeDeletedRef = makeFunctionReference<
  "mutation",
  { attemptId: string; leaseId: string; sessionId: string; now: number },
  boolean
>(
  "composio_session_dispatch:acknowledgeComposioSessionProvisioningDeletedInternal",
);
const recordFailureRef = makeFunctionReference<
  "mutation",
  {
    attemptId: string;
    leaseId: string;
    sessionId: string;
    now: number;
    reason: string;
  },
  number | null
>(
  "composio_session_dispatch:recordComposioSessionProvisioningCleanupFailureInternal",
);

/**
 * Restart-safe cleanup for an unbound session whose exact provider locator was
 * captured. The session is deleted and confirmed first so no outstanding link
 * can attach another account while the exact user/toolkit account set is being
 * revoked. Failure always leaves the locator and schedules another bounded
 * attempt; local acknowledgement requires both session 404 and a final empty
 * connected-account relist.
 */
export const cleanupComposioSessionProvisioningInternal = internalAction({
  args: { attemptId: v.string(), leaseId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = await ctx.runMutation(claimCleanupRef, {
      ...args,
      now: Date.now(),
    });
    if (claim.kind !== "cleanup") return null;

    const configured = requireComposioConfig();
    if (!configured.config) {
      await ctx.runMutation(recordFailureRef, {
        ...args,
        sessionId: claim.sessionId,
        now: Date.now(),
        reason: "Composio cleanup configuration is unavailable.",
      });
      return null;
    }
    try {
      await purgeComposioSessionOnly(
        ctx,
        {
          provider: claim.integrationId,
          toolkit: claim.toolkit,
          sessionId: claim.sessionId,
          composioUserId: claim.composioUserId,
        },
        configured.config,
      );
      await ctx.runMutation(acknowledgeDeletedRef, {
        ...args,
        sessionId: claim.sessionId,
        now: Date.now(),
      });
    } catch {
      await ctx.runMutation(recordFailureRef, {
        ...args,
        sessionId: claim.sessionId,
        now: Date.now(),
        reason: "Composio session cleanup remains unconfirmed.",
      });
    }
    return null;
  },
});
