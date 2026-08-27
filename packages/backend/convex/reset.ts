import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type Infer, v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { requireUserId } from "./auth";
import {
  ensureExternalOwnerPurge,
  quiesceOwnerExecutionPlacement,
  quiesceOwnerIntegrationCalls,
  stopOwnerSchedules,
} from "./cloud_purge";
import { enforceActionRateLimit, RATE_SENSITIVE } from "./lib/rate_limits";
import { purgeOwnerMigrationSourceDependencies } from "./lib/owner_migration_purge";
import { assertOwnerPurgeOperation } from "./owner_lifecycle";

const quiesceOwnerComposioProvisioningRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    operationId: string;
    generation: string;
    leaseId: string;
    mode: "reset" | "delete";
    now: number;
  },
  { ready: boolean; pending: string[]; retryAt: number | null }
>(
  "composio_session_dispatch:quiesceOwnerComposioSessionProvisioningForPurgeInternal",
);
const remainingOwnerComposioProvisioningRef = makeFunctionReference<
  "query",
  { ownerId: string },
  string[]
>(
  "composio_session_dispatch:remainingOwnerComposioSessionProvisioningInternal",
);
const purgeAbandonedLegacyR2SweepReceiptsRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    operationId: string;
    generation: string;
    leaseId: string;
    mode: "reset" | "delete";
  },
  { hasMore: boolean; deleted: number }
>("backup_legacy_r2_sweep_store:purgeOwnerAbandonedSweepReceiptsInternal");

const backupSweepRetryAfter = (error: unknown): number | undefined => {
  const data =
    error && typeof error === "object" && "data" in error
      ? error.data
      : undefined;
  if (
    !data ||
    typeof data !== "object" ||
    !("code" in data) ||
    data.code !== "BACKUP_LEGACY_SWEEP_PENDING" ||
    !("retryAfterMs" in data) ||
    typeof data.retryAfterMs !== "number" ||
    !Number.isFinite(data.retryAfterMs)
  ) {
    return undefined;
  }
  return Math.max(1_000, Math.floor(data.retryAfterMs));
};

/**
 * Per-mutation deletion batch size. Conservative because each `reset.*` call
 * runs inside a single Convex transaction and we want to stay well below the
 * read/write limits even when the caller chains many invocations.
 */
const BATCH = 200;

/** How many conversation ids we'll fetch in one paginated page. */
const CONVERSATION_PAGE = 200;

/**
 * Tables that hold owner-scoped data and can be drained per-table without
 * needing per-conversation traversal. Each entry maps to the index that lets
 * us look the rows up by `ownerId`.
 *
 * Kept here as a typed tuple so the orchestrator action can iterate over them
 * without losing the strong typing on `ctx.db.query` / `withIndex`.
 */
const OWNER_TABLES = [
  ["user_preferences", "by_ownerId_and_key"],
  ["devices", "by_ownerId"],
  ["mobile_pairing_sessions", "by_ownerId_and_desktopDeviceId"],
  ["paired_mobile_devices", "by_ownerId_and_desktopDeviceId"],
  ["mobile_connect_intents", "by_ownerId_and_desktopDeviceId_and_expiresAt"],
  ["mobile_bridge_registrations", "by_ownerId_and_deviceId"],
  ["mobile_bridge_registration_limits", "by_ownerId"],
  [
    "mobile_bridge_sessions",
    "by_ownerId_and_desktopDeviceId_and_mobileDeviceId",
  ],
  ["mobile_push_tokens", "by_ownerId"],
  ["device_identity_successors", "by_ownerId_and_previousDeviceId"],
  ["auth_session_policies", "by_ownerId"],
  ["auth_link_requests", "by_fromOwnerId_and_createdAt"],
  ["auth_browser_handoffs", "by_fromOwnerId"],
  ["user_counters", "by_ownerId"],
  ["x_oauth_states", "by_ownerId_and_expiresAt"],
  ["x_oauth_tokens", "by_ownerId"],
  ["connector_turn_payloads", "by_ownerId_and_createdAt"],
] as const;

type OwnerTable = (typeof OWNER_TABLES)[number][0];

/**
 * Reset rotates the owner's data generation, but it must not erase account
 * security or commercial entitlement state. In particular, deleting the
 * session-revocation watermark could make an old token valid again, while
 * deleting billing history/windows/profiles could grant fresh quota or sever
 * Stripe reconciliation. Billing is deliberately outside this generic table
 * registry; account deletion delegates it to `account_billing_purge.ts`.
 */
const RESET_OWNER_TABLES = OWNER_TABLES.filter(
  ([table]) => table !== "auth_session_policies",
);

type OwnerPurgeFence = {
  ownerId: string;
  operationId: string;
  generation: string;
};

const runOwnerReset = async (
  ctx: ActionCtx,
  fence: OwnerPurgeFence,
): Promise<void> => {
  const leaseId = crypto.randomUUID();
  const claim: {
    claimed: boolean;
    complete: boolean;
    mode: "reset" | "delete";
  } = await ctx.runMutation(
    internal.owner_lifecycle.claimOwnerPurgeStageInternal,
    {
      ...fence,
      stage: "core",
      leaseId,
      now: Date.now(),
    },
  );
  if (claim.complete) return;
  if (claim.mode !== "reset") {
    throw new Error("An account deletion superseded this reset.");
  }
  if (!claim.claimed) {
    const job: { stage: "core" | "cloud" | "complete" } | null =
      await ctx.runQuery(internal.owner_lifecycle.getOwnerPurgeJobInternal, {
        ownerId: fence.ownerId,
        operationId: fence.operationId,
      });
    if (job?.stage === "cloud") {
      await ctx.runAction(internal.cloud_purge.purgeOwnerCloudStack, fence);
      return;
    }
    throw new Error("Owner reset core stage is already leased.");
  }

  let retryStage: "core" | "cloud" = "core";
  try {
    // Hold every execution gate for the whole reset. The Convex lifecycle was
    // opened atomically with the durable job before this helper was entered.
    await ctx.runMutation(
      internal.stella_provider.relay_resume_store.beginOwnerRelayResumePurge,
      { ...fence, nowMs: Date.now() },
    );
    await ensureExternalOwnerPurge(ctx, { ...fence, mode: "reset" });
    await ctx.runMutation(
      internal.media_jobs.cancelOwnerMediaProviderDispatchesInternal,
      { ...fence, leaseId, mode: "reset", now: Date.now() },
    );
    await ctx.runAction(
      internal.media_image_submission.drainOwnerProviderCancellations,
      { ownerId: fence.ownerId, limit: 100 },
    );
    const mediaDispatches = await ctx.runMutation(
      internal.media_jobs.cancelOwnerMediaProviderDispatchesInternal,
      { ...fence, leaseId, mode: "reset", now: Date.now() },
    );
    if (!mediaDispatches.ready) {
      throw new Error(
        `Owner reset is waiting for media provider dispatch quiescence: ${mediaDispatches.pending.join(", ")}`,
      );
    }
    const voiceDispatches = await ctx.runMutation(
      internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
      { ...fence, leaseId, mode: "reset", now: Date.now() },
    );
    if (!voiceDispatches.ready) {
      throw new Error(
        `Owner reset is waiting for voice provider dispatch quiescence: ${voiceDispatches.pending.join(", ")}`,
      );
    }
    const managedDispatches = await ctx.runMutation(
      internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
      { ...fence, leaseId, mode: "reset", now: Date.now() },
    );
    if (!managedDispatches.ready) {
      throw new Error(
        `Owner reset is waiting for managed provider dispatch quiescence: ${managedDispatches.pending.join(", ")}`,
      );
    }
    const stripeDispatches = await ctx.runMutation(
      internal.stripe_operation_dispatch
        .quiesceOwnerStripeOperationsForPurgeInternal,
      { ...fence, leaseId, mode: "reset", now: Date.now() },
    );
    if (!stripeDispatches.ready) {
      throw new Error(
        `Owner reset is waiting for Stripe operation reconciliation: ${stripeDispatches.pending.join(", ")}`,
      );
    }
    const remoteTurns = await ctx.runMutation(
      internal.channels.connector_delivery
        .quiesceOwnerRemoteTurnsForPurgeInternal,
      { ...fence, leaseId, mode: "reset", now: Date.now() },
    );
    if (!remoteTurns.ready) {
      throw new Error(
        `Owner reset is waiting for remote-turn execution quiescence${remoteTurns.retryAfterAt === null ? "" : ` until ${remoteTurns.retryAfterAt}`}.`,
      );
    }
    const integrationCalls = await quiesceOwnerIntegrationCalls(
      ctx,
      fence.ownerId,
    );
    if (!integrationCalls.ready) {
      throw new Error(
        "Owner reset is waiting for a Code connected-tool dispatch lease to expire; its replay receipt was retained for retry.",
      );
    }
    const composioProvisioning = await ctx.runMutation(
      quiesceOwnerComposioProvisioningRef,
      { ...fence, leaseId, mode: "reset", now: Date.now() },
    );
    if (!composioProvisioning.ready) {
      throw new Error(
        `Owner reset is waiting for Composio session provisioning to reconcile: ${composioProvisioning.pending.join(", ")}`,
      );
    }
    await purgeOwnerMigrationSourceDependencies(ctx, {
      ...fence,
      leaseId,
      mode: "reset",
    });
    const authMigration = await ctx.runMutation(
      internal.auth_migration.quiesceAndMinimizeOwnerAuthMigrationsInternal,
      { ...fence, leaseId, mode: "reset" },
    );
    if (!authMigration.ready) {
      throw new Error(
        `Owner reset is waiting for auth migration quiescence: ${authMigration.pending.join(", ")}`,
      );
    }
    await stopOwnerSchedules(ctx, fence);
    const placement = await quiesceOwnerExecutionPlacement(ctx, fence);
    if (!placement.ready) {
      throw new Error(
        "Owner reset is waiting for accepted desktop/cloud execution to stop; device verification keys and dispatch locators were retained for retry.",
      );
    }
    const tts = await ctx.runAction(
      internal.account_tts_social_purge.purgeOwnerTtsResetInternal,
      { ...fence, leaseId },
    );
    if (!tts.ready) {
      throw new Error(
        `Owner reset is waiting for TTS quiescence: ${tts.pending.join(", ")}`,
      );
    }

    let cursor: string | null = null;
    while (true) {
      const page: { ids: Id<"conversations">[]; nextCursor: string | null } =
        await ctx.runQuery(internal.reset._listConversationIdsPage, {
          ownerId: fence.ownerId,
          cursor,
        });
      for (const conversationId of page.ids) {
        let hasMore = true;
        while (hasMore) {
          const result: { hasMore: boolean } = await ctx.runMutation(
            internal.reset._deleteConversationBatch,
            { ...fence, conversationId },
          );
          hasMore = result.hasMore;
        }
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    await Promise.all([
      ...RESET_OWNER_TABLES.map(async ([table]) => {
        let hasMore = true;
        while (hasMore) {
          const result: { hasMore: boolean } = await ctx.runMutation(
            internal.reset._deleteOwnerTableBatch,
            { ...fence, table },
          );
          hasMore = result.hasMore;
        }
      }),
      (async () => {
        const drain = async () => {
          let hasMore = true;
          while (hasMore) {
            const result: { hasMore: boolean } = await ctx.runMutation(
              internal.stella_provider.relay_resume_store
                .deleteOwnerRelayResumeBatch,
              { ...fence, nowMs: Date.now() },
            );
            hasMore = result.hasMore;
          }
        };
        await drain();
        await drain();
      })(),
      ctx.runAction(internal.cloudflare_tunnels.purgeOwnerTunnels, {
        ...fence,
        leaseId,
        mode: "reset",
      }),
      ctx.runAction(internal.data.canvas_shares_actions.purgeOwnerShares, {
        ownerUserId: fence.ownerId,
        operationId: fence.operationId,
        generation: fence.generation,
        leaseId,
        mode: "reset",
      }),
      ctx.runAction(internal.account_deletion.purgeOwnerBackupsInternal, {
        ...fence,
        leaseId,
        mode: "reset",
      }),
    ]);

    // Close the admission-to-dispatch edge for creators that reserved their
    // external locator just before the lifecycle fence became visible.
    await ctx.runAction(internal.cloudflare_tunnels.purgeOwnerTunnels, {
      ...fence,
      leaseId,
      mode: "reset",
    });
    await ctx.runAction(internal.data.canvas_shares_actions.purgeOwnerShares, {
      ownerUserId: fence.ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
      leaseId,
      mode: "reset",
    });
    while (true) {
      const swept = await ctx.runMutation(
        purgeAbandonedLegacyR2SweepReceiptsRef,
        { ...fence, leaseId, mode: "reset" },
      );
      if (!swept.hasMore) break;
    }

    const finalRemoteTurns = await ctx.runMutation(
      internal.channels.connector_delivery
        .quiesceOwnerRemoteTurnsForPurgeInternal,
      { ...fence, leaseId, mode: "reset", now: Date.now() },
    );
    if (!finalRemoteTurns.ready) {
      throw new Error(
        "Owner reset remote-turn execution debt reappeared after the conversation drain.",
      );
    }
    const [
      remainingResetCore,
      remainingTts,
      remainingVoice,
      remainingMedia,
      remainingComposioProvisioning,
      remainingStripeDispatches,
    ] = await Promise.all([
      ctx.runQuery(internal.reset.remainingOwnerResetStoresInternal, {
        ownerId: fence.ownerId,
      }),
      ctx.runQuery(
        internal.account_tts_social_purge.remainingOwnerTtsInternal,
        { ownerId: fence.ownerId },
      ),
      ctx.runQuery(
        internal.voice_dispatch.remainingOwnerVoiceProviderDispatchesInternal,
        { ownerId: fence.ownerId },
      ),
      ctx.runQuery(
        internal.media_jobs.remainingOwnerMediaProviderDispatchesInternal,
        { ownerId: fence.ownerId },
      ),
      ctx.runQuery(remainingOwnerComposioProvisioningRef, {
        ownerId: fence.ownerId,
      }),
      ctx.runQuery(
        internal.stripe_operation_dispatch
          .remainingOwnerStripeOperationDispatchesInternal,
        { ownerId: fence.ownerId, now: Date.now() },
      ),
    ]);
    const remainingCore = [
      ...remainingResetCore,
      ...remainingTts,
      ...remainingVoice,
      ...remainingMedia,
      ...remainingComposioProvisioning,
      ...remainingStripeDispatches,
    ];
    if (remainingCore.length > 0) {
      throw new Error(
        `Owner reset core purge is incomplete: ${remainingCore.join(", ")}`,
      );
    }
    const finalManagedDispatches = await ctx.runMutation(
      internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
      { ...fence, leaseId, mode: "reset", now: Date.now() },
    );
    if (!finalManagedDispatches.ready) {
      throw new Error(
        `Owner reset managed dispatch residue remains: ${finalManagedDispatches.pending.join(", ")}`,
      );
    }
    const finalStripeDispatches = await ctx.runMutation(
      internal.stripe_operation_dispatch
        .quiesceOwnerStripeOperationsForPurgeInternal,
      { ...fence, leaseId, mode: "reset", now: Date.now() },
    );
    if (!finalStripeDispatches.ready) {
      throw new Error(
        `Owner reset Stripe operation debt remains: ${finalStripeDispatches.pending.join(", ")}`,
      );
    }
    const remainingAuth = await ctx.runMutation(
      internal.auth_migration.remainingOwnerAuthMigrationResidueInternal,
      { ...fence, leaseId, mode: "reset" },
    );
    if (remainingAuth.length > 0) {
      throw new Error(
        `Owner reset auth purge is incomplete: ${remainingAuth.join(", ")}`,
      );
    }

    const advanced: boolean = await ctx.runMutation(
      internal.owner_lifecycle.advanceOwnerPurgeStageInternal,
      {
        ...fence,
        leaseId,
        stage: "core",
        nextStage: "cloud",
        now: Date.now(),
      },
    );
    if (!advanced) throw new Error("Owner reset core lease was superseded.");
    retryStage = "cloud";
    await ctx.runAction(internal.cloud_purge.purgeOwnerCloudStack, fence);
  } catch (error) {
    const retryAfterMs = backupSweepRetryAfter(error);
    await ctx.runMutation(
      internal.owner_lifecycle.scheduleOwnerPurgeRetryInternal,
      {
        ...fence,
        stage: retryStage,
        leaseId,
        error: error instanceof Error ? error.message : String(error),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        now: Date.now(),
      },
    );
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Public action - orchestrates full user data reset across many small mutations
// ---------------------------------------------------------------------------

export const resetAllUserData = action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);

    // Destructive: wipes the user's entire data set across many mutations.
    // A hijacked session shouldn't be able to fire-and-forget this multiple
    // times in parallel.
    await enforceActionRateLimit(
      ctx,
      "reset_all_user_data",
      ownerId,
      RATE_SENSITIVE,
      "Too many account reset attempts. Please wait a minute and try again.",
    );

    const lifecycle = await ctx.runMutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId,
        operationId: crypto.randomUUID(),
        mode: "reset",
        now: Date.now(),
      },
    );
    const fence: OwnerPurgeFence = {
      ownerId,
      operationId: lifecycle.operationId,
      generation: lifecycle.generation,
    };
    await runOwnerReset(ctx, fence);

    return null;
  },
});

export const resumeOwnerResetInternal = internalAction({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await runOwnerReset(ctx, args);
    return null;
  },
});

/** Data-retention cleanup for a Better Auth anonymous user that still exists. */
export const resetOwnerDataInternal = internalAction({
  args: { ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lifecycle = await ctx.runMutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId: args.ownerId,
        operationId: crypto.randomUUID(),
        mode: "reset",
        now: Date.now(),
      },
    );
    const fence: OwnerPurgeFence = {
      ownerId: args.ownerId,
      operationId: lifecycle.operationId,
      generation: lifecycle.generation,
    };
    await runOwnerReset(ctx, fence);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ownerResidueCheck = async (
  name: string,
  read: () => Promise<unknown | null>,
): Promise<string | null> => ((await read()) === null ? null : name);

/**
 * Strict readback for the reset-owned core surfaces. Account/security and
 * billing rows intentionally retained by reset are excluded; account deletion
 * delegates billing removal/readback to `account_billing_purge.ts`.
 */
export const remainingOwnerResetStoresInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx: QueryCtx, { ownerId }) => {
    const checks = await Promise.all([
      ownerResidueCheck("conversations", () =>
        ctx.db
          .query("conversations")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("user_preferences", () =>
        ctx.db
          .query("user_preferences")
          .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId))
          .first(),
      ),
      ownerResidueCheck("devices", () =>
        ctx.db
          .query("devices")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .first(),
      ),
      ownerResidueCheck("backup_key_escrows", () =>
        ctx.db
          .query("backup_key_escrows")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .first(),
      ),
      ownerResidueCheck("backup_objects", () =>
        ctx.db
          .query("backup_objects")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("backup_manifests", () =>
        ctx.db
          .query("backup_manifests")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("backup_upload_reservations", () =>
        ctx.db
          .query("backup_upload_reservations")
          .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("backup_legacy_r2_sweeps_source", () =>
        ctx.db
          .query("backup_legacy_r2_sweeps")
          .withIndex("by_sourceOwnerId_and_kind", (q) =>
            q.eq("sourceOwnerId", ownerId).eq("kind", "migration"),
          )
          .first(),
      ),
      ownerResidueCheck("backup_legacy_r2_sweeps_destination", () =>
        ctx.db
          .query("backup_legacy_r2_sweeps")
          .withIndex("by_destinationOwnerId_and_kind", (q) =>
            q.eq("destinationOwnerId", ownerId).eq("kind", "migration"),
          )
          .first(),
      ),
      ownerResidueCheck("mobile_pairing_sessions", () =>
        ctx.db
          .query("mobile_pairing_sessions")
          .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("paired_mobile_devices", () =>
        ctx.db
          .query("paired_mobile_devices")
          .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("mobile_connect_intents", () =>
        ctx.db
          .query("mobile_connect_intents")
          .withIndex("by_ownerId_and_desktopDeviceId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("mobile_bridge_registrations", () =>
        ctx.db
          .query("mobile_bridge_registrations")
          .withIndex("by_ownerId_and_deviceId", (q) => q.eq("ownerId", ownerId))
          .first(),
      ),
      ownerResidueCheck("mobile_bridge_registration_limits", () =>
        ctx.db
          .query("mobile_bridge_registration_limits")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .first(),
      ),
      ownerResidueCheck("mobile_bridge_sessions", () =>
        ctx.db
          .query("mobile_bridge_sessions")
          .withIndex("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("mobile_push_tokens", () =>
        ctx.db
          .query("mobile_push_tokens")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .first(),
      ),
      ownerResidueCheck("device_identity_successors", () =>
        ctx.db
          .query("device_identity_successors")
          .withIndex("by_ownerId_and_previousDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("auth_link_requests.fromOwnerId", () =>
        ctx.db
          .query("auth_link_requests")
          .withIndex("by_fromOwnerId_and_createdAt", (q) =>
            q.eq("fromOwnerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("auth_link_requests.toOwnerId", () =>
        ctx.db
          .query("auth_link_requests")
          .withIndex("by_toOwnerId_and_createdAt", (q) =>
            q.eq("toOwnerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("auth_browser_handoffs", () =>
        ctx.db
          .query("auth_browser_handoffs")
          .withIndex("by_fromOwnerId", (q) => q.eq("fromOwnerId", ownerId))
          .first(),
      ),
      ownerResidueCheck("user_counters", () =>
        ctx.db
          .query("user_counters")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .first(),
      ),
      ownerResidueCheck("x_oauth_states", () =>
        ctx.db
          .query("x_oauth_states")
          .withIndex("by_ownerId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("x_oauth_tokens", () =>
        ctx.db
          .query("x_oauth_tokens")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .first(),
      ),
      ownerResidueCheck("connector_turn_payloads", () =>
        ctx.db
          .query("connector_turn_payloads")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("stella_relay_billing_receipts", () =>
        ctx.db
          .query("stella_relay_billing_receipts")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("stella_relay_cancellation_intents", () =>
        ctx.db
          .query("stella_relay_cancellation_intents")
          .withIndex("by_ownerId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("stella_relay_response_leases", () =>
        ctx.db
          .query("stella_relay_response_leases")
          .withIndex("by_ownerId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("stella_relay_response_streams", () =>
        ctx.db
          .query("stella_relay_response_streams")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("cloudflare_tunnels", () =>
        ctx.db
          .query("cloudflare_tunnels")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .first(),
      ),
      ownerResidueCheck("canvas_shares", () =>
        ctx.db
          .query("canvas_shares")
          .withIndex("by_ownerUserId", (q) => q.eq("ownerUserId", ownerId))
          .first(),
      ),
    ]);
    return checks.filter((name): name is string => name !== null);
  },
});

export const _listConversationIdsPage = internalQuery({
  args: {
    ownerId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    ids: v.array(v.id("conversations")),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { ownerId, cursor }) => {
    const page = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .paginate({ cursor, numItems: CONVERSATION_PAGE });
    return {
      ids: page.page.map((c) => c._id),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const _deleteConversationBatch = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    conversationId: v.id("conversations"),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const { conversationId } = args;
    const conv = await ctx.db.get(conversationId);
    if (!conv || conv.ownerId !== args.ownerId) return { hasMore: false };
    // Conversation rows are the authority/locator for remote execution. Even
    // if a future orchestrator accidentally skips the explicit quiescence
    // phase, fail closed before deleting *any* event while an owner-bound or
    // legacy attempt is active or waiting through its transport grace period.
    // The conversation-local lookups are required for pre-schema rows that do
    // not have an ownerId at all; owner-wide indexes alone cannot see them.
    const [
      activeRemoteTurn,
      cancellingRemoteTurn,
      activeConversationRemoteTurn,
      cancellingConversationRemoteTurn,
    ] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_ownerId_activeAttemptState", (q) =>
          q.eq("ownerId", args.ownerId).eq("activeAttemptState", "active"),
        )
        .first(),
      ctx.db
        .query("events")
        .withIndex("by_ownerId_activeAttemptState", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("activeAttemptState", "cancel_requested"),
        )
        .first(),
      ctx.db
        .query("events")
        .withIndex("by_conversationId_activeAttemptState", (q) =>
          q
            .eq("conversationId", conversationId)
            .eq("activeAttemptState", "active"),
        )
        .first(),
      ctx.db
        .query("events")
        .withIndex("by_conversationId_activeAttemptState", (q) =>
          q
            .eq("conversationId", conversationId)
            .eq("activeAttemptState", "cancel_requested"),
        )
        .first(),
    ]);
    if (
      activeRemoteTurn ||
      cancellingRemoteTurn ||
      activeConversationRemoteTurn ||
      cancellingConversationRemoteTurn
    ) {
      throw new Error(
        "Remote-turn execution must be quiescent before conversation deletion.",
      );
    }
    // Phase A: drain `events` for this conversation in tight batches. We
    // process events first so they always disappear before the conversation
    // row itself.
    const events = await ctx.db
      .query("events")
      .withIndex("by_conversationId_and_timestamp", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    if (events.length > 0) {
      await Promise.all(events.map((e) => ctx.db.delete(e._id)));
      return { hasMore: true };
    }

    // Phase B: drain ONE thread's messages per call. Doing this per-thread
    // keeps the per-mutation read/write count bounded by `BATCH` even if a
    // conversation has hundreds of threads with thousands of messages each.
    const [thread] = await ctx.db
      .query("threads")
      .withIndex("by_conversationId_and_lastUsedAt", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(1);
    if (thread) {
      const messages = await ctx.db
        .query("thread_messages")
        .withIndex("by_threadId_and_ordinal", (q) =>
          q.eq("threadId", thread._id),
        )
        .take(BATCH);
      if (messages.length > 0) {
        await Promise.all(messages.map((m) => ctx.db.delete(m._id)));
        return { hasMore: true };
      }
      // No more messages for this thread — delete the thread row and let the
      // caller invoke us again to advance to the next thread / conversation
      // tear-down phase.
      await ctx.db.delete(thread._id);
      return { hasMore: true };
    }

    // Phase B': connector_turn_payloads is a child table keyed by
    // conversationId. Drain it before deleting the conversation row so we
    // don't leave dangling FK references.
    const turnPayloads = await ctx.db
      .query("connector_turn_payloads")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    if (turnPayloads.length > 0) {
      await Promise.all(turnPayloads.map((row) => ctx.db.delete(row._id)));
      return { hasMore: true };
    }

    // Phase B'': attachments reference both the conversation and a
    // `_storage` blob. Delete the blob alongside each row so reset doesn't
    // leave dangling FK references or leak storage objects.
    const attachments = await ctx.db
      .query("attachments")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    if (attachments.length > 0) {
      await Promise.all(
        attachments.map(async (row) => {
          await ctx.storage.delete(row.storageKey);
          await ctx.db.delete(row._id);
        }),
      );
      return { hasMore: true };
    }

    // Phase B''': pending_device_selections is a child table keyed by
    // conversationId. Drain it before deleting the conversation row so we
    // don't leave dangling FK references.
    const pendingSelections = await ctx.db
      .query("pending_device_selections")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    if (pendingSelections.length > 0) {
      await Promise.all(pendingSelections.map((row) => ctx.db.delete(row._id)));
      // The unique constraint means this almost always returns 0 or 1, so
      // we don't need a `hasMore: true` round-trip here.
    }

    // Phase C: events + threads are gone — delete the conversation row and
    // decrement the denormalized counter so quota checks stay accurate.
    await ctx.db.delete(conversationId);
    const counter = await ctx.db
      .query("user_counters")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", conv.ownerId))
      .unique();
    if (counter) {
      const next = Math.max(0, (counter.conversationCount ?? 0) - 1);
      await ctx.db.patch(counter._id, {
        conversationCount: next,
        updatedAt: Date.now(),
      });
    }
    return { hasMore: false };
  },
});

const ownerTableValidator = v.union(
  v.literal("user_preferences"),
  v.literal("devices"),
  v.literal("mobile_pairing_sessions"),
  v.literal("paired_mobile_devices"),
  v.literal("mobile_connect_intents"),
  v.literal("mobile_bridge_registrations"),
  v.literal("mobile_bridge_registration_limits"),
  v.literal("mobile_bridge_sessions"),
  v.literal("mobile_push_tokens"),
  v.literal("device_identity_successors"),
  v.literal("auth_session_policies"),
  v.literal("auth_link_requests"),
  v.literal("auth_browser_handoffs"),
  v.literal("user_counters"),
  v.literal("x_oauth_states"),
  v.literal("x_oauth_tokens"),
  v.literal("connector_turn_payloads"),
);

// Static guard: keeps `ownerTableValidator` and `OWNER_TABLES` in sync. If
// a table is added/removed from one but not the other this file stops
// type-checking. Matches both directions so neither side can drift.
type _OwnerTableMatchesValidator =
  OwnerTable extends Infer<typeof ownerTableValidator>
    ? Infer<typeof ownerTableValidator> extends OwnerTable
      ? true
      : never
    : never;
const _ownerTablesInSync: _OwnerTableMatchesValidator = true;
void _ownerTablesInSync;

/**
 * Deletes one batch of rows from a single owner-scoped table. The orchestrator
 * action loops on `hasMore` and walks `OWNER_TABLES` so that each invocation
 * stays inside one mutation transaction.
 */
export const _deleteOwnerTableBatch = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    table: ownerTableValidator,
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const deleted = await deleteOneOwnerTableBatch(
      ctx,
      args.ownerId,
      args.table,
    );
    return { hasMore: deleted === BATCH };
  },
});

/**
 * Per-table dispatch that keeps the typed `ctx.db.query` / `withIndex`
 * builder. Adding a new owner-scoped table here is a single switch case
 * addition (plus an entry in `OWNER_TABLES`).
 */
async function deleteOneOwnerTableBatch(
  ctx: MutationCtx,
  ownerId: string,
  table: OwnerTable,
): Promise<number> {
  let ids: Id<OwnerTable>[] = [];
  switch (table) {
    case "user_preferences": {
      const rows = await ctx.db
        .query("user_preferences")
        .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "devices": {
      const rows = await ctx.db
        .query("devices")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "mobile_pairing_sessions": {
      const rows = await ctx.db
        .query("mobile_pairing_sessions")
        .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerTable>[];
      break;
    }
    case "paired_mobile_devices": {
      const rows = await ctx.db
        .query("paired_mobile_devices")
        .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerTable>[];
      break;
    }
    case "mobile_connect_intents": {
      const rows = await ctx.db
        .query("mobile_connect_intents")
        .withIndex("by_ownerId_and_desktopDeviceId_and_expiresAt", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerTable>[];
      break;
    }
    case "mobile_bridge_registrations": {
      const rows = await ctx.db
        .query("mobile_bridge_registrations")
        .withIndex("by_ownerId_and_deviceId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerTable>[];
      break;
    }
    case "mobile_bridge_registration_limits": {
      const rows = await ctx.db
        .query("mobile_bridge_registration_limits")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerTable>[];
      break;
    }
    case "mobile_bridge_sessions": {
      const rows = await ctx.db
        .query("mobile_bridge_sessions")
        .withIndex("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerTable>[];
      break;
    }
    case "mobile_push_tokens": {
      const rows = await ctx.db
        .query("mobile_push_tokens")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerTable>[];
      break;
    }
    case "device_identity_successors": {
      const rows = await ctx.db
        .query("device_identity_successors")
        .withIndex("by_ownerId_and_previousDeviceId", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "auth_session_policies": {
      const rows = await ctx.db
        .query("auth_session_policies")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "auth_link_requests": {
      // A completed handoff can name the same account as either principal.
      // Read both indexes, deduplicate, and cap the combined write set.
      const [fromRows, toRows] = await Promise.all([
        ctx.db
          .query("auth_link_requests")
          .withIndex("by_fromOwnerId_and_createdAt", (q) =>
            q.eq("fromOwnerId", ownerId),
          )
          .take(BATCH),
        ctx.db
          .query("auth_link_requests")
          .withIndex("by_toOwnerId_and_createdAt", (q) =>
            q.eq("toOwnerId", ownerId),
          )
          .take(BATCH),
      ]);
      ids = [
        ...new Map(
          [...fromRows, ...toRows].map((row) => [String(row._id), row._id]),
        ).values(),
      ].slice(0, BATCH) as Id<OwnerTable>[];
      break;
    }
    case "auth_browser_handoffs": {
      const rows = await ctx.db
        .query("auth_browser_handoffs")
        .withIndex("by_fromOwnerId", (q) => q.eq("fromOwnerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "user_counters": {
      const rows = await ctx.db
        .query("user_counters")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "x_oauth_states": {
      const rows = await ctx.db
        .query("x_oauth_states")
        .withIndex("by_ownerId_and_expiresAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "x_oauth_tokens": {
      const rows = await ctx.db
        .query("x_oauth_tokens")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "connector_turn_payloads": {
      const rows = await ctx.db
        .query("connector_turn_payloads")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
  }
  await Promise.all(ids.map((id) => ctx.db.delete(id)));
  return ids.length;
}
