/**
 * Ownership migration for anonymous → real account linking.
 *
 * When an anonymous user signs in with a real identity, all owner-scoped
 * data must be transferred to the new ownerId. This module performs that
 * migration in batches to stay within Convex mutation limits.
 *
 * Each per-table migration is its own typed `internalMutation` so we keep the
 * `ctx.db.query` builder fully typed (no `as any` / `_id: any`). The
 * orchestrator action below walks the table list and re-invokes each batch
 * mutation until it returns `hasMore: false`.
 */

import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { FunctionReference } from "convex/server";
import { hashSha256Hex } from "./lib/crypto_utils";
import {
  canceledPendingUploadCleanupDelays,
  driveFileOwnershipPatch,
  importedAgentHomeDocumentName,
  importedAgentHomePrefix,
  importedDrivePath,
  importedInteriorPrefix,
  importedOwnerScopedKey,
  importedProjectSlug,
  isOwnershipMigrationBlockedMessage,
  mergeBillingUsageWindows,
  ownershipMigrationTransientStateDisposition,
  shouldAdvanceOwnerNamespaceStage,
  workspaceTransferResolutionsMatch,
} from "./lib/auth_migration_paths";

const BATCH_SIZE = 500;

const ownerArgs = { fromOwnerId: v.string(), toOwnerId: v.string() } as const;
const hasMoreReturn = v.object({ hasMore: v.boolean() });

const isFullPage = (rows: readonly unknown[]) => rows.length === BATCH_SIZE;
const OWNERSHIP_MIGRATION_BLOCKED_PREFIX = "ownership_migration_blocked:";

const blockOwnershipMigration = (reason: string): never => {
  throw new Error(`${OWNERSHIP_MIGRATION_BLOCKED_PREFIX} ${reason}`);
};

// ---------------------------------------------------------------------------
// Per-table batch mutations.
//
// Each one stays inside the schema's strong typing for `ctx.db.patch` so we
// don't need a `db.patch as unknown as ...` widening — the compiler proves
// that `{ ownerId }` is a valid partial patch for each table.
// ---------------------------------------------------------------------------

export const migrateConversationsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUserPreferencesBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);
    // (ownerId, key) is looked up with `.unique()` elsewhere. Preserve a
    // colliding source value under a deterministic imported key rather than
    // replacing the destination or silently deleting anonymous content.
    for (const row of rows) {
      const existing = await ctx.db
        .query("user_preferences")
        .withIndex("by_ownerId_and_key", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("key", row.key),
        )
        .unique();
      if (existing) {
        let importedKey: string | null = null;
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const candidate = importedOwnerScopedKey(
            row.key,
            String(row._id),
            attempt,
          );
          const occupied = await ctx.db
            .query("user_preferences")
            .withIndex("by_ownerId_and_key", (q) =>
              q.eq("ownerId", args.toOwnerId).eq("key", candidate),
            )
            .unique();
          if (!occupied) {
            importedKey = candidate;
            break;
          }
        }
        if (!importedKey) {
          blockOwnershipMigration(
            `No collision-safe imported key is available for preference "${row.key}".`,
          );
        }
        await ctx.db.patch(row._id, {
          ownerId: args.toOwnerId,
          key:
            importedKey ??
            blockOwnershipMigration(
              `No collision-safe imported key is available for preference "${row.key}".`,
            ),
        });
      } else {
        await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
      }
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateAuthSessionPoliciesBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("auth_session_policies")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);
    // `getSessionPolicyFromDb` reads this table with `.unique()` per owner;
    // if the target owner already has a policy row, merge (strictest
    // revocation marker wins) and drop the source row instead of creating a
    // duplicate that would make every sensitive-session check throw.
    for (const row of rows) {
      const existing = await ctx.db
        .query("auth_session_policies")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
        .unique();
      if (existing) {
        if (row.minIssuedAtSec > existing.minIssuedAtSec) {
          await ctx.db.patch(existing._id, {
            minIssuedAtSec: row.minIssuedAtSec,
            updatedAt: Math.max(existing.updatedAt, row.updatedAt),
          });
        }
        await ctx.db.delete(row._id);
      } else {
        await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
      }
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateSecretsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("secrets")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateSecretAccessAuditBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("secret_access_audit")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUserIntegrationsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    // (ownerId, provider) is looked up with `.unique()` elsewhere. There is no
    // lossless merge for two independent provider configurations, so preserve
    // both by failing closed instead of choosing one silently.
    for (const row of rows) {
      const existing = await ctx.db
        .query("user_integrations")
        .withIndex("by_ownerId_and_provider", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("provider", row.provider),
        )
        .unique();
      if (existing) {
        blockOwnershipMigration(
          `Both identities contain a ${row.provider} integration configuration.`,
        );
      }
      await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUsageLogsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("usage_logs")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateTransientChannelEventsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("transient_channel_events")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateTransientCleanupFailuresBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("transient_cleanup_failures")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateConnectorTurnPayloadsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("connector_turn_payloads")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateAgentsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("agents")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateMediaJobsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    for (const row of rows) {
      if (
        !["succeeded", "failed", "canceled"].includes(row.status) ||
        (row.submissionState !== undefined &&
          !["submitted", "failed", "canceled"].includes(row.submissionState))
      ) {
        blockOwnershipMigration(
          "A media job or its private submission is still in flight. Finish or cancel it before retrying account linking.",
        );
      }
      const existing = row.clientRequestKey
        ? await ctx.db
            .query("media_jobs")
            .withIndex("by_ownerId_and_clientRequestKey", (q) =>
              q
                .eq("ownerId", args.toOwnerId)
                .eq("clientRequestKey", row.clientRequestKey),
            )
            .unique()
        : null;
      // Preserve both historical jobs, but keep only the destination row as
      // the canonical reattachment target when owner linking collides.
      await ctx.db.patch(row._id, {
        ownerId: args.toOwnerId,
        ...(existing
          ? { clientRequestKey: undefined, clientRequestHash: undefined }
          : {}),
      });
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateMediaRequestCancellationsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("media_request_cancellations")
      .withIndex("by_ownerId_and_clientRequestKey", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    for (const row of rows) {
      const existing = await ctx.db
        .query("media_request_cancellations")
        .withIndex("by_ownerId_and_clientRequestKey", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("clientRequestKey", row.clientRequestKey),
        )
        .unique();
      if (existing) {
        await ctx.db.delete(row._id);
      } else {
        await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
      }
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateMediaJobLogsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("media_job_logs")
      .withIndex("by_ownerId_and_jobId", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUserCountersBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("user_counters")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

/**
 * Fashion is available to anonymous identities, so account linking must keep
 * its durable profile and shopping state. The staged order preserves checkout
 * references before cart rows move. Entity-key collisions merge the same
 * logical item instead of silently discarding either owner's quantity or
 * newest metadata.
 */
export const migrateFashionBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const checkout = (
      await ctx.db
        .query("fashion_checkout_sessions")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (checkout) {
      await ctx.db.patch(checkout._id, { ownerId: args.toOwnerId });
      return { hasMore: true };
    }
    const cart = (
      await ctx.db
        .query("fashion_cart_items")
        .withIndex("by_ownerId_and_addedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (cart) {
      const destination = await ctx.db
        .query("fashion_cart_items")
        .withIndex("by_ownerId_and_variantId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("variantId", cart.variantId),
        )
        .unique();
      if (destination) {
        await ctx.db.patch(destination._id, {
          quantity: destination.quantity + cart.quantity,
          addedAt: Math.min(destination.addedAt, cart.addedAt),
          ...(destination.checkoutSessionId
            ? {}
            : cart.checkoutSessionId
              ? { checkoutSessionId: cart.checkoutSessionId }
              : {}),
        });
        await ctx.db.delete(cart._id);
      } else {
        await ctx.db.patch(cart._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true };
    }
    const like = (
      await ctx.db
        .query("fashion_likes")
        .withIndex("by_ownerId_and_likedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (like) {
      const destination = await ctx.db
        .query("fashion_likes")
        .withIndex("by_ownerId_and_variantId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("variantId", like.variantId),
        )
        .unique();
      if (destination) {
        if (like.likedAt > destination.likedAt) {
          await ctx.db.patch(destination._id, {
            productId: like.productId,
            title: like.title,
            imageUrl: like.imageUrl,
            productUrl: like.productUrl,
            merchantOrigin: like.merchantOrigin,
            priceCents: like.priceCents,
            currency: like.currency,
            vendor: like.vendor,
            likedAt: like.likedAt,
          });
        }
        await ctx.db.delete(like._id);
      } else {
        await ctx.db.patch(like._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true };
    }
    const outfit = (
      await ctx.db
        .query("fashion_outfits")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (outfit) {
      await ctx.db.patch(outfit._id, { ownerId: args.toOwnerId });
      return { hasMore: true };
    }
    const profile = await ctx.db
      .query("fashion_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    if (profile) {
      const destination = await ctx.db
        .query("fashion_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
        .unique();
      if (destination) {
        const importedStyle =
          profile.stylePreferences &&
          profile.stylePreferences !== destination.stylePreferences
            ? [
                destination.stylePreferences,
                `Imported anonymous preferences: ${profile.stylePreferences}`,
              ]
                .filter(Boolean)
                .join("\n")
            : destination.stylePreferences;
        await ctx.db.patch(destination._id, {
          displayName: destination.displayName ?? profile.displayName,
          gender: destination.gender ?? profile.gender,
          sizes: { ...(profile.sizes ?? {}), ...(destination.sizes ?? {}) },
          stylePreferences: importedStyle,
          hasBodyPhoto: destination.hasBodyPhoto || profile.hasBodyPhoto,
          bodyPhotoMimeType:
            destination.bodyPhotoMimeType ?? profile.bodyPhotoMimeType,
          bodyPhotoUpdatedAt: Math.max(
            destination.bodyPhotoUpdatedAt ?? 0,
            profile.bodyPhotoUpdatedAt ?? 0,
          ),
          updatedAt: Math.max(destination.updatedAt, profile.updatedAt),
        });
        await ctx.db.delete(profile._id);
      } else {
        await ctx.db.patch(profile._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true };
    }
    return { hasMore: false };
  },
});

/** Store packages can be authored before sign-in; releases move first so the
 * package's latestReleaseId always continues to point at owned content. */
export const migrateStoreContentBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const release = (
      await ctx.db
        .query("store_package_releases")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (release) {
      await ctx.db.patch(release._id, { ownerId: args.toOwnerId });
      return { hasMore: true };
    }
    const pkg = (
      await ctx.db
        .query("store_packages")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (pkg) {
      const collision = await ctx.db
        .query("store_packages")
        .withIndex("by_ownerId_and_packageId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("packageId", pkg.packageId),
        )
        .unique();
      if (collision && collision._id !== pkg._id) {
        blockOwnershipMigration(
          `Both identities own store package "${pkg.packageId}". Resolve the duplicate before retrying account linking.`,
        );
      }
      await ctx.db.patch(pkg._id, { ownerId: args.toOwnerId });
      return { hasMore: true };
    }
    return { hasMore: false };
  },
});

export const migrateXTokensBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query("x_oauth_tokens")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    if (!token) return { hasMore: false };
    const destination = await ctx.db
      .query("x_oauth_tokens")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
      .unique();
    if (destination && destination._id !== token._id) {
      blockOwnershipMigration(
        "Both identities have an X account connection. Disconnect one before retrying account linking.",
      );
    }
    await ctx.db.patch(token._id, { ownerId: args.toOwnerId });
    return { hasMore: true };
  },
});

/**
 * Quota state merges conservatively: usage is summed and each window keeps
 * the later start, so linking cannot immediately expire the anonymous row and
 * reset its allowance.
 */
export const migrateUsageAccountingBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const rollup = (
      await ctx.db
        .query("usage_rollups")
        .withIndex("by_ownerId_and_bucketStartMs", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (rollup) {
      const destination = await ctx.db
        .query("usage_rollups")
        .withIndex("by_ownerId_and_bucketStartMs", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("bucketStartMs", rollup.bucketStartMs),
        )
        .unique();
      if (destination) {
        await ctx.db.patch(destination._id, {
          inputTokens: destination.inputTokens + rollup.inputTokens,
          outputTokens: destination.outputTokens + rollup.outputTokens,
          totalTokens: destination.totalTokens + rollup.totalTokens,
          requestCount: destination.requestCount + rollup.requestCount,
          toolCallCount: destination.toolCallCount + rollup.toolCallCount,
          updatedAt: Math.max(destination.updatedAt, rollup.updatedAt),
        });
        await ctx.db.delete(rollup._id);
      } else {
        await ctx.db.patch(rollup._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true };
    }
    const usage = await ctx.db
      .query("billing_usage_windows")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    if (usage) {
      const destination = await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
        .unique();
      if (destination) {
        await ctx.db.patch(
          destination._id,
          mergeBillingUsageWindows(usage, destination),
        );
        await ctx.db.delete(usage._id);
      } else {
        await ctx.db.patch(usage._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true };
    }
    const profile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    if (profile) {
      const isAnonymousFreeProfile =
        profile.activePlan === "free" &&
        (profile.usageMode === undefined || profile.usageMode === "default") &&
        profile.subscriptionStatus === "none" &&
        !profile.stripeCustomerId &&
        !profile.stripeSubscriptionId &&
        !profile.stripePriceId &&
        !profile.defaultPaymentMethodId &&
        !profile.paymentMethodBrand &&
        !profile.paymentMethodLast4 &&
        profile.currentPeriodStart === 0 &&
        profile.currentPeriodEnd === 0 &&
        profile.cancelAtPeriodEnd === false;
      if (!isAnonymousFreeProfile) {
        blockOwnershipMigration(
          "The anonymous identity unexpectedly owns paid billing state.",
        );
      }
      const destination = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
        .unique();
      if (destination) await ctx.db.delete(profile._id);
      else await ctx.db.patch(profile._id, { ownerId: args.toOwnerId });
      return { hasMore: true };
    }
    const voiceReceipt = (
      await ctx.db
        .query("billing_voice_usage_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (voiceReceipt) {
      const collision = await ctx.db
        .query("billing_voice_usage_receipts")
        .withIndex("by_ownerId_and_responseId", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("responseId", voiceReceipt.responseId),
        )
        .unique();
      if (collision) {
        blockOwnershipMigration(
          `A voice usage receipt collision exists for ${voiceReceipt.responseId}.`,
        );
      }
      await ctx.db.patch(voiceReceipt._id, { ownerId: args.toOwnerId });
      return { hasMore: true };
    }
    const mediaReceipt = (
      await ctx.db
        .query("billing_media_usage_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (mediaReceipt) {
      const collision = await ctx.db
        .query("billing_media_usage_receipts")
        .withIndex("by_ownerId_and_jobId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("jobId", mediaReceipt.jobId),
        )
        .unique();
      if (collision) {
        blockOwnershipMigration(
          `A media usage receipt collision exists for ${mediaReceipt.jobId}.`,
        );
      }
      await ctx.db.patch(mediaReceipt._id, { ownerId: args.toOwnerId });
      return { hasMore: true };
    }
    const voiceSession = (
      await ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (voiceSession) {
      if (
        voiceSession.endedAt === undefined ||
        ["minting", "active", "superseded_unreported_grace"].includes(
          voiceSession.status,
        )
      ) {
        blockOwnershipMigration(
          "A realtime voice billing lease is still active or awaiting its final usage report.",
        );
      }
      await ctx.db.patch(voiceSession._id, { ownerId: args.toOwnerId });
      return { hasMore: true };
    }
    return { hasMore: false };
  },
});

/** Stable mobile and tunnel registrations survive account linking. Ephemeral
 * pairing/session rows are deliberately handled by the blocking residue gate. */
export const migrateDeviceExtensionsForAccountLink = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const registration = (
      await ctx.db
        .query("mobile_bridge_registrations")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (registration) {
      const destination = await ctx.db
        .query("mobile_bridge_registrations")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("deviceId", registration.deviceId),
        )
        .unique();
      if (destination) {
        if (
          destination.desktopPublicKey &&
          registration.desktopPublicKey &&
          destination.desktopPublicKey !== registration.desktopPublicKey
        ) {
          blockOwnershipMigration(
            `Both identities have different bridge keys for desktop device ${registration.deviceId}.`,
          );
        }
        await ctx.db.patch(destination._id, {
          baseUrls: Array.from(
            new Set([...destination.baseUrls, ...registration.baseUrls]),
          ),
          updatedAt: Math.max(destination.updatedAt, registration.updatedAt),
          platform: destination.platform ?? registration.platform,
          desktopPublicKey:
            destination.desktopPublicKey ?? registration.desktopPublicKey,
        });
        await ctx.db.delete(registration._id);
      } else {
        await ctx.db.patch(registration._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true };
    }
    const paired = (
      await ctx.db
        .query("paired_mobile_devices")
        .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (paired) {
      const destination = await ctx.db
        .query("paired_mobile_devices")
        .withIndex("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("desktopDeviceId", paired.desktopDeviceId)
            .eq("mobileDeviceId", paired.mobileDeviceId),
        )
        .unique();
      if (destination) {
        if (destination.pairSecretHash !== paired.pairSecretHash) {
          blockOwnershipMigration(
            `Both identities have different mobile pairing secrets for ${paired.desktopDeviceId}/${paired.mobileDeviceId}.`,
          );
        }
        const newer =
          paired.lastSeenAt > destination.lastSeenAt ? paired : destination;
        await ctx.db.patch(destination._id, {
          pairSecretHash: newer.pairSecretHash,
          displayName: newer.displayName,
          platform: newer.platform,
          approvedAt: Math.min(destination.approvedAt, paired.approvedAt),
          lastSeenAt: Math.max(destination.lastSeenAt, paired.lastSeenAt),
          revokedAt:
            destination.revokedAt === undefined ||
            paired.revokedAt === undefined
              ? undefined
              : Math.max(destination.revokedAt, paired.revokedAt),
        });
        await ctx.db.delete(paired._id);
      } else {
        await ctx.db.patch(paired._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true };
    }
    const push = (
      await ctx.db
        .query("mobile_push_tokens")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .take(1)
    )[0];
    if (push) {
      const destination = await ctx.db
        .query("mobile_push_tokens")
        .withIndex("by_ownerId_and_mobileDeviceId", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("mobileDeviceId", push.mobileDeviceId),
        )
        .unique();
      const tokenHolders = await ctx.db
        .query("mobile_push_tokens")
        .withIndex("by_expoPushToken", (q) =>
          q.eq("expoPushToken", push.expoPushToken),
        )
        .take(8);
      if (
        tokenHolders.some(
          (holder) =>
            holder._id !== push._id && holder._id !== destination?._id,
        )
      ) {
        blockOwnershipMigration(
          "The anonymous push token is already bound to a different mobile device.",
        );
      }
      if (destination) {
        if (destination.expoPushToken !== push.expoPushToken) {
          blockOwnershipMigration(
            `Both identities have different push tokens for mobile device ${push.mobileDeviceId}.`,
          );
        }
        if (push.updatedAt > destination.updatedAt) {
          await ctx.db.patch(destination._id, {
            expoPushToken: push.expoPushToken,
            platform: push.platform,
            updatedAt: push.updatedAt,
          });
        }
        await ctx.db.delete(push._id);
      } else {
        await ctx.db.patch(push._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true };
    }
    const tunnel = (
      await ctx.db
        .query("cloudflare_tunnels")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .take(1)
    )[0];
    if (tunnel) {
      const destination = tunnel.deviceId
        ? await ctx.db
            .query("cloudflare_tunnels")
            .withIndex("by_ownerId_and_deviceId", (q) =>
              q.eq("ownerId", args.toOwnerId).eq("deviceId", tunnel.deviceId),
            )
            .unique()
        : null;
      if (destination) {
        blockOwnershipMigration(
          `Both identities own a Cloudflare tunnel for device ${tunnel.deviceId}.`,
        );
      }
      await ctx.db.patch(tunnel._id, { ownerId: args.toOwnerId });
      return { hasMore: true };
    }
    return { hasMore: false };
  },
});

export const migrateMediaWebhookEventsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("media_webhook_events")
      .withIndex("by_ownerId_and_receivedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

const CLOUD_PROJECTION_BATCH_SIZE = 200;
const OWNERSHIP_MIGRATION_LEASE_MS = 9 * 60_000;
const OWNERSHIP_MIGRATION_FAILED_RETRY_COOLDOWN_MS = 60_000;

const cloudTransferBatchReturn = v.array(
  v.object({
    conversationId: v.string(),
    deleted: v.boolean(),
    purged: v.boolean(),
  }),
);

export const prepareOwnershipMigration = internalMutation({
  args: ownerArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.fromOwnerId === args.toOwnerId) return null;
    const existing = await ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
        q.eq("fromOwnerId", args.fromOwnerId).eq("toOwnerId", args.toOwnerId),
      )
      .unique();
    if (!existing) {
      const now = Date.now();
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: args.fromOwnerId,
        toOwnerId: args.toOwnerId,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
    }
    if (!existing || existing.status === "pending") {
      // The wake-up is a transactional scheduler write. Publishing the source
      // fence and scheduling its worker cannot split across a hook crash.
      await ctx.scheduler.runAfter(
        0,
        internal.auth_migration.migrateOwnership,
        args,
      );
    }
    return null;
  },
});

export const getMyOwnershipMigrationStatus = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      status: v.union(
        v.literal("pending"),
        v.literal("running"),
        v.literal("failed"),
        v.literal("complete"),
      ),
      updatedAt: v.number(),
      error: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const rows = await ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_toOwnerId_and_updatedAt", (q) =>
        q.eq("toOwnerId", identity.tokenIdentifier),
      )
      .order("desc")
      .take(32);
    const row =
      rows.find(
        (candidate) =>
          candidate.status === "pending" || candidate.status === "running",
      ) ??
      rows.find((candidate) => candidate.status === "failed") ??
      rows[0];
    return row
      ? {
          status: row.status,
          updatedAt: row.updatedAt,
          ...(row.lastError ? { error: row.lastError } : {}),
        }
      : null;
  },
});

export const retryMyLatestFailedOwnershipMigration = mutation({
  args: {},
  returns: v.object({ scheduled: v.boolean() }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const failed = (
      await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_toOwnerId_and_status_and_updatedAt", (q) =>
          q.eq("toOwnerId", identity.tokenIdentifier).eq("status", "failed"),
        )
        .order("desc")
        .take(1)
    )[0];
    if (!failed) return { scheduled: false };
    const now = Date.now();
    await ctx.db.patch(failed._id, {
      status: "pending",
      leaseId: undefined,
      leaseExpiresAt: undefined,
      watchdogId: undefined,
      lastError: undefined,
      completedAt: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.auth_migration.migrateOwnership, {
      fromOwnerId: failed.fromOwnerId,
      toOwnerId: failed.toOwnerId,
    });
    return { scheduled: true };
  },
});

export const listCloudConversationTransferBatch = internalQuery({
  args: ownerArgs,
  returns: cloudTransferBatchReturn,
  handler: async (ctx, args) => {
    if (args.fromOwnerId === args.toOwnerId) return [];
    const conversations = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(1);
    return conversations.map((conversation) => ({
      conversationId: conversation.conversationId,
      deleted: conversation.deletedAt !== undefined,
      purged: conversation.purgedAt !== undefined,
    }));
  },
});

const cloudProductStageValidator = v.union(
  v.literal("owner-namespaces"),
  v.literal("apps"),
  v.literal("interior"),
  v.literal("projects"),
  v.literal("core"),
  v.literal("complete"),
);
type CloudProductStage =
  | "owner-namespaces"
  | "apps"
  | "interior"
  | "projects"
  | "core"
  | "complete";

const cloudProductWorkReturn = v.union(
  v.object({
    kind: v.literal("owner-namespaces"),
    driveImportedWorkspace: v.string(),
    driveImportedProjectId: v.string(),
    stellaImportedWorkspace: v.string(),
    stellaImportedProjectId: v.string(),
  }),
  v.object({
    kind: v.literal("app"),
    appId: v.string(),
    slug: v.string(),
    importedWorkspace: v.string(),
    importedProjectId: v.string(),
  }),
  v.object({ kind: v.literal("interior") }),
  v.object({
    kind: v.literal("project"),
    projectId: v.string(),
    fromWorkspace: v.string(),
    toWorkspace: v.string(),
    targetSlug: v.string(),
    importedWorkspace: v.string(),
  }),
  v.object({
    kind: v.literal("advance"),
    stage: cloudProductStageValidator,
    nextStage: cloudProductStageValidator,
  }),
  v.object({ kind: v.literal("core") }),
  v.object({ kind: v.literal("complete") }),
);

const importedWorkspacePlan = async (
  ctx: Pick<QueryCtx, "db">,
  args: {
    fromOwnerId: string;
    toOwnerId: string;
    sourceWorkspace: string;
    baseSlug: string;
    reuseProjectId?: string;
  },
): Promise<{ workspace: string; projectId: string }> => {
  const identity = await hashSha256Hex(
    `${args.fromOwnerId}:${args.sourceWorkspace}`,
  );
  const projectId =
    args.reuseProjectId ?? `prj-import-${identity.slice(0, 16)}`;
  if (!args.reuseProjectId) {
    const existing = await ctx.db
      .query("cloud_projects")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .unique();
    if (existing) {
      if (existing.ownerId !== args.toOwnerId) {
        throw new Error("Imported workspace project identity is already used.");
      }
      return { workspace: `project:${existing.slug}`, projectId };
    }
  }
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const slug = importedProjectSlug(args.baseSlug, identity, attempt);
    const occupied = await ctx.db
      .query("cloud_projects")
      .withIndex("by_ownerId_and_slug", (q) =>
        q.eq("ownerId", args.toOwnerId).eq("slug", slug),
      )
      .unique();
    if (!occupied) return { workspace: `project:${slug}`, projectId };
  }
  throw new Error("No collision-safe imported project workspace is available.");
};

/**
 * One bounded cloud-product unit per action pass. The migration row is the
 * cursor: it advances only after the worker copy and Convex rekey both return.
 */
export const getCloudProductTransferWork = internalQuery({
  args: ownerArgs,
  returns: cloudProductWorkReturn,
  handler: async (ctx, args) => {
    const migration = await ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
        q.eq("fromOwnerId", args.fromOwnerId).eq("toOwnerId", args.toOwnerId),
      )
      .unique();
    const stage: CloudProductStage =
      migration?.cloudProductStage ?? "owner-namespaces";
    if (stage === "owner-namespaces") {
      const [driveImport, stellaImport] = await Promise.all([
        importedWorkspacePlan(ctx, {
          ...args,
          sourceWorkspace: "drive",
          baseSlug: "anonymous-drive",
        }),
        importedWorkspacePlan(ctx, {
          ...args,
          sourceWorkspace: "stella",
          baseSlug: "anonymous-stella",
        }),
      ]);
      return {
        kind: "owner-namespaces",
        driveImportedWorkspace: driveImport.workspace,
        driveImportedProjectId: driveImport.projectId,
        stellaImportedWorkspace: stellaImport.workspace,
        stellaImportedProjectId: stellaImport.projectId,
      } as const;
    }
    if (stage === "apps") {
      const app = (
        await ctx.db
          .query("cloud_apps")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", args.fromOwnerId),
          )
          .take(1)
      )[0];
      if (app) {
        const imported = await importedWorkspacePlan(ctx, {
          ...args,
          sourceWorkspace: `app:${app.slug}`,
          baseSlug: `${app.slug}-workspace`,
        });
        return {
          kind: "app",
          appId: app.appId,
          slug: app.slug,
          importedWorkspace: imported.workspace,
          importedProjectId: imported.projectId,
        } as const;
      }
      return {
        kind: "advance",
        stage,
        nextStage: "interior",
      } as const;
    }
    if (stage === "interior") {
      const deployment = await ctx.db
        .query("cloud_interior_deployables")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .unique();
      const build = (
        await ctx.db
          .query("cloud_interior_builds")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", args.fromOwnerId),
          )
          .take(1)
      )[0];
      return deployment || build
        ? ({ kind: "interior" } as const)
        : ({
            kind: "advance",
            stage,
            nextStage: "projects",
          } as const);
    }
    if (stage === "projects") {
      const project = (
        await ctx.db
          .query("cloud_projects")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", args.fromOwnerId),
          )
          .take(1)
      )[0];
      if (!project) {
        return {
          kind: "advance",
          stage,
          nextStage: "core",
        } as const;
      }
      const collision = await ctx.db
        .query("cloud_projects")
        .withIndex("by_ownerId_and_slug", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("slug", project.slug),
        )
        .unique();
      let targetSlug = project.slug;
      if (collision) {
        let available: string | null = null;
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const candidate = importedProjectSlug(
            project.slug,
            project.projectId,
            attempt,
          );
          const occupied = await ctx.db
            .query("cloud_projects")
            .withIndex("by_ownerId_and_slug", (q) =>
              q.eq("ownerId", args.toOwnerId).eq("slug", candidate),
            )
            .unique();
          if (!occupied) {
            available = candidate;
            break;
          }
        }
        if (!available) {
          throw new Error(
            "No collision-safe destination slug is available for this project.",
          );
        }
        targetSlug = available;
      }
      const imported = await importedWorkspacePlan(ctx, {
        ...args,
        sourceWorkspace: `project:${project.slug}`,
        baseSlug: `${targetSlug}-checkpoint`,
        reuseProjectId: project.projectId,
      });
      return {
        kind: "project",
        projectId: project.projectId,
        fromWorkspace: `project:${project.slug}`,
        toWorkspace: `project:${targetSlug}`,
        targetSlug,
        importedWorkspace: imported.workspace,
      } as const;
    }
    if (stage === "core") return { kind: "core" } as const;
    return { kind: "complete" } as const;
  },
});

const ownerNamespaceBlockerReturn = v.union(v.null(), v.string());

/**
 * Preflight the bounded anonymous namespace before any metadata is re-owned.
 * A pending upload is an incomplete protocol row, not durable product state;
 * core migration cancels it and schedules guarded object cleanup. Agent-home
 * bytes are moved by cloud-builder, while Drive files keep their exact
 * immutable @convex-dev/r2 keys and only their Convex rows change owner.
 */
export const getOwnerNamespaceTransferBlocker = internalQuery({
  args: ownerArgs,
  returns: ownerNamespaceBlockerReturn,
  handler: async (ctx, args) => {
    const pendingUpload = (
      await ctx.db
        .query("cloud_drive_uploads")
        .withIndex("by_ownerId_and_path", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (pendingUpload) {
      const disposition =
        ownershipMigrationTransientStateDisposition("cloud_drive_upload");
      if (disposition === "block") {
        return `A Drive upload for "${pendingUpload.path}" cannot be migrated safely.`;
      }
    }
    return null;
  },
});

export const advanceCloudProductTransferStage = internalMutation({
  args: {
    ...ownerArgs,
    leaseId: v.string(),
    stage: cloudProductStageValidator,
    nextStage: cloudProductStageValidator,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const migration = await ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
        q.eq("fromOwnerId", args.fromOwnerId).eq("toOwnerId", args.toOwnerId),
      )
      .unique();
    if (!migration || migration.leaseId !== args.leaseId) return false;
    const current = migration.cloudProductStage ?? "owner-namespaces";
    if (current !== args.stage) return current === args.nextStage;
    await ctx.db.patch(migration._id, { cloudProductStage: args.nextStage });
    return true;
  },
});

export const claimOwnershipMigration = internalMutation({
  args: {
    ...ownerArgs,
    leaseId: v.string(),
    now: v.number(),
  },
  returns: v.object({
    claimed: v.boolean(),
    terminal: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
        q.eq("fromOwnerId", args.fromOwnerId).eq("toOwnerId", args.toOwnerId),
      )
      .unique();
    if (existing?.status === "complete") {
      return { claimed: false, terminal: true };
    }
    if (
      existing?.status === "failed" &&
      existing.updatedAt + OWNERSHIP_MIGRATION_FAILED_RETRY_COOLDOWN_MS >
        args.now
    ) {
      return { claimed: false, terminal: true };
    }
    if (
      existing?.leaseId &&
      (existing.leaseExpiresAt ?? 0) > args.now &&
      existing.leaseId !== args.leaseId
    ) {
      return { claimed: false, terminal: false };
    }
    const leaseExpiresAt = args.now + OWNERSHIP_MIGRATION_LEASE_MS;
    const watchdogId = await ctx.scheduler.runAfter(
      OWNERSHIP_MIGRATION_LEASE_MS + 5_000,
      internal.auth_migration.migrateOwnership,
      {
        fromOwnerId: args.fromOwnerId,
        toOwnerId: args.toOwnerId,
      },
    );
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "running",
        leaseId: args.leaseId,
        leaseExpiresAt,
        watchdogId,
        lastError: undefined,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: args.fromOwnerId,
        toOwnerId: args.toOwnerId,
        status: "running",
        leaseId: args.leaseId,
        leaseExpiresAt,
        watchdogId,
        createdAt: args.now,
        updatedAt: args.now,
      });
    }
    // Crash recovery is scheduled while the lease acquisition transaction is
    // still durable. It cannot overlap healthy work because the lease outlives
    // every bounded pass; after a crash it is the wake that claims the expired
    // row and resumes.
    return { claimed: true, terminal: false };
  },
});

export const cleanupOwnershipMigration = internalMutation({
  args: {
    migrationId: v.id("auth_owner_migrations"),
    terminalAt: v.number(),
  },
  returns: v.null(),
  handler: async (_ctx, _args) => {
    // Completed rows are permanent source-identity revocation tombstones.
    // Older deployments may already have scheduled this callback, so retain
    // the no-op export until every queued invocation has drained.
    return null;
  },
});

export const finishOwnershipMigrationPass = internalMutation({
  args: {
    ...ownerArgs,
    leaseId: v.string(),
    outcome: v.union(
      v.literal("pending"),
      v.literal("failed"),
      v.literal("complete"),
    ),
    retryAfterMs: v.optional(v.number()),
    error: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
        q.eq("fromOwnerId", args.fromOwnerId).eq("toOwnerId", args.toOwnerId),
      )
      .unique();
    if (!row || row.leaseId !== args.leaseId) return null;
    if (args.outcome === "pending") {
      await ctx.db.patch(row._id, {
        status: "pending",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        watchdogId: undefined,
        lastError: args.error,
        updatedAt: args.now,
      });
      if (row.watchdogId) await ctx.scheduler.cancel(row.watchdogId);
      await ctx.scheduler.runAfter(
        Math.min(60_000, Math.max(1_000, args.retryAfterMs ?? 5_000)),
        internal.auth_migration.migrateOwnership,
        {
          fromOwnerId: args.fromOwnerId,
          toOwnerId: args.toOwnerId,
        },
      );
      return null;
    }
    if (row.watchdogId) await ctx.scheduler.cancel(row.watchdogId);
    await ctx.db.patch(row._id, {
      status: args.outcome,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      watchdogId: undefined,
      lastError: args.error,
      ...(args.outcome === "complete" ? { completedAt: args.now } : {}),
      updatedAt: args.now,
    });
    // Complete markers remain as source-identity revocation tombstones. A
    // stale anonymous JWT must never regain write access after residue audit.
    return null;
  },
});

export const commitCloudConversationTransferBatch = internalMutation({
  args: {
    ...ownerArgs,
    conversationId: v.string(),
  },
  returns: v.object({
    complete: v.boolean(),
    progressed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const conversation = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .unique();
    if (!conversation || conversation.ownerId === args.toOwnerId) {
      return { complete: true, progressed: false };
    }
    if (conversation.ownerId !== args.fromOwnerId) {
      throw new Error("Cloud conversation ownership changed unexpectedly.");
    }

    const turn = (
      await ctx.db
        .query("agent_turns")
        .withIndex("by_conversationId_and_ownerId_and_createdAt", (q) =>
          q
            .eq("conversationId", args.conversationId)
            .eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (turn) {
      const tokens = await ctx.db
        .query("cloud_turn_tokens")
        .withIndex("by_turnId_and_ownerId", (q) =>
          q.eq("turnId", turn.turnId).eq("ownerId", args.fromOwnerId),
        )
        .take(CLOUD_PROJECTION_BATCH_SIZE);
      const invocations = await ctx.db
        .query("cloud_app_op_invocations")
        .withIndex("by_ownerId_and_turnId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId).eq("turnId", turn.turnId),
        )
        .take(CLOUD_PROJECTION_BATCH_SIZE);
      await Promise.all([
        ...tokens.map((token) =>
          ctx.db.patch(token._id, { ownerId: args.toOwnerId }),
        ),
        ...invocations.map((invocation) =>
          ctx.db.patch(invocation._id, { ownerId: args.toOwnerId }),
        ),
      ]);
      if (
        tokens.length < CLOUD_PROJECTION_BATCH_SIZE &&
        invocations.length < CLOUD_PROJECTION_BATCH_SIZE
      ) {
        await ctx.db.patch(turn._id, { ownerId: args.toOwnerId });
      }
      return { complete: false, progressed: true };
    }

    const thread = (
      await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_conversationId_and_ownerId_and_updatedAt", (q) =>
          q
            .eq("conversationId", args.conversationId)
            .eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (thread) {
      const messages = await ctx.db
        .query("cloud_thread_messages")
        .withIndex("by_conversationId_and_ownerId_and_seq", (q) =>
          q
            .eq("conversationId", thread.threadId)
            .eq("ownerId", args.fromOwnerId),
        )
        .take(CLOUD_PROJECTION_BATCH_SIZE);
      await Promise.all(
        messages.map((message) =>
          ctx.db.patch(message._id, { ownerId: args.toOwnerId }),
        ),
      );
      if (messages.length < CLOUD_PROJECTION_BATCH_SIZE) {
        await ctx.db.patch(thread._id, { ownerId: args.toOwnerId });
      }
      return { complete: false, progressed: true };
    }

    const legacyMessages = await ctx.db
      .query("cloud_messages")
      .withIndex("by_conversationId_and_ownerId_and_seq", (q) =>
        q
          .eq("conversationId", args.conversationId)
          .eq("ownerId", args.fromOwnerId),
      )
      .take(CLOUD_PROJECTION_BATCH_SIZE);
    if (legacyMessages.length > 0) {
      await Promise.all(
        legacyMessages.map((message) =>
          ctx.db.patch(message._id, { ownerId: args.toOwnerId }),
        ),
      );
      return { complete: false, progressed: true };
    }

    const excerpts = await ctx.db
      .query("cloud_message_excerpts")
      .withIndex("by_conversationId_and_ownerId_and_seqStart", (q) =>
        q
          .eq("conversationId", args.conversationId)
          .eq("ownerId", args.fromOwnerId),
      )
      .take(CLOUD_PROJECTION_BATCH_SIZE);
    if (excerpts.length > 0) {
      await Promise.all(
        excerpts.map((excerpt) =>
          ctx.db.patch(excerpt._id, { ownerId: args.toOwnerId }),
        ),
      );
      return { complete: false, progressed: true };
    }

    const schedules = await ctx.db
      .query("cloud_scheduled_turns")
      .withIndex("by_conversationId_and_ownerId_and_updatedAt", (q) =>
        q
          .eq("conversationId", args.conversationId)
          .eq("ownerId", args.fromOwnerId),
      )
      .take(CLOUD_PROJECTION_BATCH_SIZE);
    if (schedules.length > 0) {
      await Promise.all(
        schedules.map((schedule) =>
          ctx.db.patch(schedule._id, { ownerId: args.toOwnerId }),
        ),
      );
      return { complete: false, progressed: true };
    }

    await ctx.db.patch(conversation._id, { ownerId: args.toOwnerId });
    return { complete: true, progressed: true };
  },
});

export const commitDeletedCloudConversationTransfer = internalMutation({
  args: {
    ...ownerArgs,
    conversationId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .unique();
    if (!conversation || conversation.ownerId === args.toOwnerId) return true;
    if (
      conversation.ownerId !== args.fromOwnerId ||
      conversation.deletedAt === undefined ||
      conversation.purgedAt === undefined
    ) {
      return false;
    }
    await ctx.db.patch(conversation._id, { ownerId: args.toOwnerId });
    return true;
  },
});

const cloudProductBatchReturn = v.object({
  hasMore: v.boolean(),
  progressed: v.boolean(),
});

const importedWorkspaceProjectValidator = v.object({
  projectId: v.string(),
  workspace: v.string(),
  name: v.string(),
});
type ImportedWorkspaceProject = {
  projectId: string;
  workspace: string;
  name: string;
};

const ensureImportedWorkspaceProject = async (
  ctx: MutationCtx,
  ownerId: string,
  imported: ImportedWorkspaceProject,
): Promise<void> => {
  const slug = imported.workspace.startsWith("project:")
    ? imported.workspace.slice("project:".length)
    : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) {
    blockOwnershipMigration("Worker returned an invalid imported workspace.");
  }
  const byId = await ctx.db
    .query("cloud_projects")
    .withIndex("by_projectId", (q) => q.eq("projectId", imported.projectId))
    .unique();
  if (byId) {
    if (byId.ownerId !== ownerId || byId.slug !== slug) {
      blockOwnershipMigration(
        "Imported workspace project identity changed during account linking.",
      );
    }
    return;
  }
  const bySlug = await ctx.db
    .query("cloud_projects")
    .withIndex("by_ownerId_and_slug", (q) =>
      q.eq("ownerId", ownerId).eq("slug", slug),
    )
    .unique();
  if (bySlug) {
    blockOwnershipMigration(
      "Imported workspace project slug changed during account linking.",
    );
  }
  const now = Date.now();
  await ctx.db.insert("cloud_projects", {
    projectId: imported.projectId,
    ownerId,
    slug,
    name: imported.name.slice(0, 80),
    provider: "stella",
    defaultBranch: "main",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
};

export const commitOwnerNamespaceTransfer = internalMutation({
  args: {
    ...ownerArgs,
    leaseId: v.string(),
    fromOwnerHash: v.string(),
    toOwnerHash: v.string(),
    importedProjects: v.array(importedWorkspaceProjectValidator),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const migration = await ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
        q.eq("fromOwnerId", args.fromOwnerId).eq("toOwnerId", args.toOwnerId),
      )
      .unique();
    if (!migration || migration.leaseId !== args.leaseId) return false;
    const stage = migration.cloudProductStage ?? "owner-namespaces";
    if (stage !== "owner-namespaces") return stage === "apps";
    for (const imported of args.importedProjects) {
      await ensureImportedWorkspaceProject(ctx, args.toOwnerId, imported);
    }
    const documents = await ctx.db
      .query("cloud_agent_home_docs")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(20);
    for (const document of documents) {
      const name = importedAgentHomeDocumentName(
        document.name,
        String(document._id),
      );
      await ctx.db.patch(document._id, {
        ownerId: args.toOwnerId,
        name,
        r2Key: document.r2Key.replace(
          `agent-home/${args.fromOwnerHash}/`,
          importedAgentHomePrefix(args.fromOwnerHash, args.toOwnerHash),
        ),
      });
    }
    const remainingDocuments = await ctx.db
      .query("cloud_agent_home_docs")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(1);
    if (!shouldAdvanceOwnerNamespaceStage(remainingDocuments.length)) {
      return true;
    }
    const driveFiles = await ctx.db
      .query("cloud_drive_files")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(20);
    for (const driveFile of driveFiles) {
      const destination = await ctx.db
        .query("cloud_drive_files")
        .withIndex("by_ownerId_and_path", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("path", driveFile.path),
        )
        .unique();
      let path = driveFile.path;
      if (destination) {
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const candidate = importedDrivePath(
            driveFile.path,
            String(driveFile._id),
            attempt,
          );
          const occupied = await ctx.db
            .query("cloud_drive_files")
            .withIndex("by_ownerId_and_path", (q) =>
              q.eq("ownerId", args.toOwnerId).eq("path", candidate),
            )
            .unique();
          if (!occupied) {
            path = candidate;
            break;
          }
        }
        if (path === driveFile.path) {
          blockOwnershipMigration(
            `No imported Drive path is available for "${driveFile.path}".`,
          );
        }
      }
      await ctx.db.patch(driveFile._id, {
        ...driveFileOwnershipPatch(args.toOwnerId),
        path,
        ...(destination
          ? {
              name:
                path.split("/")[path.split("/").length - 1] ?? driveFile.name,
            }
          : {}),
      });
    }
    const remainingDriveFiles = await ctx.db
      .query("cloud_drive_files")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(1);
    if (shouldAdvanceOwnerNamespaceStage(remainingDriveFiles.length)) {
      await ctx.db.patch(migration._id, { cloudProductStage: "apps" });
    }
    return true;
  },
});

export const commitCloudAppTransferBatch = internalMutation({
  args: {
    ...ownerArgs,
    appId: v.string(),
    importedProject: v.optional(importedWorkspaceProjectValidator),
  },
  returns: cloudProductBatchReturn,
  handler: async (ctx, args) => {
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (!app || app.ownerId === args.toOwnerId) {
      return { hasMore: false, progressed: false };
    }
    if (app.ownerId !== args.fromOwnerId) {
      throw new Error("Cloud app ownership changed unexpectedly.");
    }
    if (args.importedProject) {
      await ensureImportedWorkspaceProject(
        ctx,
        args.toOwnerId,
        args.importedProject,
      );
    }
    const sourceBuild = (
      await ctx.db
        .query("cloud_app_builds")
        .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId).eq("appId", app.appId),
        )
        .take(1)
    )[0];
    if (sourceBuild) {
      await ctx.db.patch(sourceBuild._id, { ownerId: args.toOwnerId });
      return { hasMore: true, progressed: true };
    }
    const operation = await ctx.db
      .query("cloud_app_operations")
      .withIndex("by_ownerId_and_appId", (q) =>
        q.eq("ownerId", args.fromOwnerId).eq("appId", app.appId),
      )
      .unique();
    if (operation) {
      await ctx.db.patch(operation._id, { ownerId: args.toOwnerId });
      return { hasMore: true, progressed: true };
    }
    const invocation = (
      await ctx.db
        .query("cloud_app_op_invocations")
        .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId).eq("appId", app.appId),
        )
        .take(1)
    )[0];
    if (invocation) {
      await ctx.db.patch(invocation._id, { ownerId: args.toOwnerId });
      return { hasMore: true, progressed: true };
    }
    const storage = (
      await ctx.db
        .query("cloud_app_storage")
        .withIndex("by_ownerId_and_appId_and_updatedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId).eq("appId", app.appId),
        )
        .take(1)
    )[0];
    if (storage) {
      const userId =
        storage.userId === args.fromOwnerId ? args.toOwnerId : storage.userId;
      const collision = await ctx.db
        .query("cloud_app_storage")
        .withIndex("by_appId_and_userId_and_key", (q) =>
          q
            .eq("appId", storage.appId)
            .eq("userId", userId)
            .eq("key", storage.key),
        )
        .unique();
      if (collision && collision._id !== storage._id) {
        let importedKey: string | null = null;
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const candidate = importedOwnerScopedKey(
            storage.key,
            String(storage._id),
            attempt,
            128,
          );
          const occupied = await ctx.db
            .query("cloud_app_storage")
            .withIndex("by_appId_and_userId_and_key", (q) =>
              q
                .eq("appId", storage.appId)
                .eq("userId", userId)
                .eq("key", candidate),
            )
            .unique();
          if (!occupied) {
            importedKey = candidate;
            break;
          }
        }
        if (!importedKey) {
          blockOwnershipMigration(
            `No imported app-storage key is available for "${storage.key}".`,
          );
        }
        await ctx.db.patch(storage._id, {
          ownerId: args.toOwnerId,
          userId,
          key: importedKey!,
        });
      } else {
        await ctx.db.patch(storage._id, { ownerId: args.toOwnerId, userId });
      }
      return { hasMore: true, progressed: true };
    }
    await ctx.db.patch(app._id, { ownerId: args.toOwnerId });
    return { hasMore: false, progressed: true };
  },
});

export const commitCloudInteriorTransferBatch = internalMutation({
  args: {
    ...ownerArgs,
    fromOwnerHash: v.string(),
    toOwnerHash: v.string(),
  },
  returns: cloudProductBatchReturn,
  handler: async (ctx, args) => {
    const sourceBuild = (
      await ctx.db
        .query("cloud_interior_builds")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    const sourceDeployment = await ctx.db
      .query("cloud_interior_deployables")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    const destinationDeployment = await ctx.db
      .query("cloud_interior_deployables")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
      .unique();
    if (sourceBuild) {
      const sourcePrefix = `interiors/${args.fromOwnerHash}/`;
      const destinationPrefix = importedInteriorPrefix(
        args.fromOwnerHash,
        args.toOwnerHash,
      );
      await ctx.db.patch(sourceBuild._id, {
        ownerId: args.toOwnerId,
        ...(destinationDeployment
          ? { deployableId: destinationDeployment.deployableId }
          : {}),
        artifactPrefix: sourceBuild.artifactPrefix.replace(
          sourcePrefix,
          destinationPrefix,
        ),
        artifactManifestJson: sourceBuild.artifactManifestJson
          .split(sourcePrefix)
          .join(destinationPrefix),
      });
      return { hasMore: true, progressed: true };
    }
    if (!sourceDeployment) {
      return { hasMore: false, progressed: false };
    }
    if (destinationDeployment) {
      await ctx.db.delete(sourceDeployment._id);
    } else {
      await ctx.db.patch(sourceDeployment._id, {
        ownerId: args.toOwnerId,
        ownerHash: args.toOwnerHash,
      });
    }
    return { hasMore: false, progressed: true };
  },
});

export const commitCloudProjectTransfer = internalMutation({
  args: {
    ...ownerArgs,
    projectId: v.string(),
    targetSlug: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const project = await ctx.db
      .query("cloud_projects")
      .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (!project || project.ownerId === args.toOwnerId) return true;
    if (project.ownerId !== args.fromOwnerId) {
      throw new Error("Cloud project ownership changed unexpectedly.");
    }
    const collision = await ctx.db
      .query("cloud_projects")
      .withIndex("by_ownerId_and_slug", (q) =>
        q.eq("ownerId", args.toOwnerId).eq("slug", args.targetSlug),
      )
      .unique();
    if (collision) return false;
    await ctx.db.patch(project._id, {
      ownerId: args.toOwnerId,
      slug: args.targetSlug,
      ...(args.targetSlug === project.slug
        ? {}
        : { name: `${project.name} (imported)` }),
    });
    return true;
  },
});

export const migrateCloudProductCoreBatch = internalMutation({
  args: ownerArgs,
  returns: cloudProductBatchReturn,
  handler: async (ctx, args) => {
    const driveFile = (
      await ctx.db
        .query("cloud_drive_files")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (driveFile) {
      const collision = await ctx.db
        .query("cloud_drive_files")
        .withIndex("by_ownerId_and_path", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("path", driveFile.path),
        )
        .unique();
      let path = driveFile.path;
      if (collision) {
        let available: string | null = null;
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const candidate = importedDrivePath(
            driveFile.path,
            String(driveFile._id),
            attempt,
          );
          const occupied = await ctx.db
            .query("cloud_drive_files")
            .withIndex("by_ownerId_and_path", (q) =>
              q.eq("ownerId", args.toOwnerId).eq("path", candidate),
            )
            .unique();
          if (!occupied) {
            available = candidate;
            break;
          }
        }
        if (!available) {
          throw new Error(
            "No collision-safe destination path is available for a drive file.",
          );
        }
        path = available;
      }
      await ctx.db.patch(driveFile._id, {
        ownerId: args.toOwnerId,
        path,
        ...(collision
          ? {
              name:
                path.split("/")[path.split("/").length - 1] ?? driveFile.name,
            }
          : {}),
      });
      return { hasMore: true, progressed: true };
    }
    const upload = (
      await ctx.db
        .query("cloud_drive_uploads")
        .withIndex("by_ownerId_and_path", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (upload) {
      if (
        ownershipMigrationTransientStateDisposition("cloud_drive_upload") ===
        "discard"
      ) {
        await ctx.db.delete(upload._id);
        for (const delay of canceledPendingUploadCleanupDelays(
          Date.now(),
          upload.expiresAt,
        )) {
          await ctx.scheduler.runAfter(
            delay,
            internal.cloud_drive.cleanupCanceledPendingUploadInternal,
            { r2Key: upload.r2Key },
          );
        }
        console.info(
          `[auth_migration] Canceled incomplete Drive upload ${upload._id}.`,
        );
        return { hasMore: true, progressed: true };
      }
      blockOwnershipMigration("A pending Drive upload could not be canceled.");
    }
    const deletion = (
      await ctx.db
        .query("cloud_drive_deletions")
        .withIndex("by_ownerId_and_deletedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (deletion) {
      const collision = await ctx.db
        .query("cloud_drive_deletions")
        .withIndex("by_ownerId_and_path", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("path", deletion.path),
        )
        .unique();
      if (collision) {
        if (deletion.deletedAt > collision.deletedAt) {
          await ctx.db.patch(collision._id, {
            deletedAt: deletion.deletedAt,
          });
        }
        await ctx.db.delete(deletion._id);
      } else {
        await ctx.db.patch(deletion._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true, progressed: true };
    }
    const usage = await ctx.db
      .query("cloud_drive_usage")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    if (usage) {
      const destination = await ctx.db
        .query("cloud_drive_usage")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
        .unique();
      if (destination) {
        await ctx.db.patch(destination._id, {
          fileCount: destination.fileCount + usage.fileCount,
          totalBytes: destination.totalBytes + usage.totalBytes,
          updatedAt: Math.max(destination.updatedAt, usage.updatedAt),
        });
        await ctx.db.delete(usage._id);
      } else {
        await ctx.db.patch(usage._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true, progressed: true };
    }
    const credential = (
      await ctx.db
        .query("cloud_llm_credentials")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .take(1)
    )[0];
    if (credential) {
      const destination = await ctx.db
        .query("cloud_llm_credentials")
        .withIndex("by_ownerId_and_provider_and_importedFromOwnerId", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("provider", credential.provider)
            .eq("importedFromOwnerId", undefined),
        )
        .unique();
      if (destination) {
        await ctx.db.patch(credential._id, {
          ownerId: args.toOwnerId,
          importedFromOwnerId: args.fromOwnerId,
          refreshLeaseId: undefined,
          refreshLeaseExpiresAt: undefined,
          label: `${credential.label} (imported from anonymous)`,
        });
      } else {
        await ctx.db.patch(credential._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true, progressed: true };
    }
    const connect = (
      await ctx.db
        .query("cloud_engine_connects")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .take(1)
    )[0];
    if (connect) {
      if (
        ownershipMigrationTransientStateDisposition("cloud_engine_connect") ===
        "discard"
      ) {
        await ctx.db.delete(connect._id);
        console.info(
          `[auth_migration] Canceled incomplete cloud-engine connect ${connect._id}.`,
        );
        return { hasMore: true, progressed: true };
      }
      blockOwnershipMigration(
        "A pending cloud-engine connection could not be canceled.",
      );
    }
    const engineSettings = await ctx.db
      .query("cloud_engine_settings")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    if (engineSettings) {
      const destination = await ctx.db
        .query("cloud_engine_settings")
        .withIndex("by_ownerId_and_importedFromOwnerId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("importedFromOwnerId", undefined),
        )
        .unique();
      if (destination) {
        await ctx.db.patch(engineSettings._id, {
          ownerId: args.toOwnerId,
          importedFromOwnerId: args.fromOwnerId,
        });
      } else {
        await ctx.db.patch(engineSettings._id, {
          ownerId: args.toOwnerId,
        });
      }
      return { hasMore: true, progressed: true };
    }
    const installation = (
      await ctx.db
        .query("cloud_github_installations")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (installation) {
      await ctx.db.patch(installation._id, { ownerId: args.toOwnerId });
      return { hasMore: true, progressed: true };
    }
    const installState = (
      await ctx.db
        .query("cloud_github_install_states")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .take(1)
    )[0];
    if (installState) {
      if (
        ownershipMigrationTransientStateDisposition(
          "cloud_github_install_state",
        ) === "discard"
      ) {
        await ctx.db.delete(installState._id);
        console.info(
          `[auth_migration] Canceled incomplete GitHub connect ${installState._id}.`,
        );
        return { hasMore: true, progressed: true };
      }
      blockOwnershipMigration(
        "A pending GitHub connection could not be canceled.",
      );
    }
    const appStorage = (
      await ctx.db
        .query("cloud_app_storage")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (appStorage) {
      const userId =
        appStorage.userId === args.fromOwnerId
          ? args.toOwnerId
          : appStorage.userId;
      const collision = await ctx.db
        .query("cloud_app_storage")
        .withIndex("by_appId_and_userId_and_key", (q) =>
          q
            .eq("appId", appStorage.appId)
            .eq("userId", userId)
            .eq("key", appStorage.key),
        )
        .unique();
      if (collision && collision._id !== appStorage._id) {
        let importedKey: string | null = null;
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const candidate = importedOwnerScopedKey(
            appStorage.key,
            String(appStorage._id),
            attempt,
            128,
          );
          const occupied = await ctx.db
            .query("cloud_app_storage")
            .withIndex("by_appId_and_userId_and_key", (q) =>
              q
                .eq("appId", appStorage.appId)
                .eq("userId", userId)
                .eq("key", candidate),
            )
            .unique();
          if (!occupied) {
            importedKey = candidate;
            break;
          }
        }
        if (!importedKey) {
          blockOwnershipMigration(
            `No imported app-storage key is available for "${appStorage.key}".`,
          );
        }
        await ctx.db.patch(appStorage._id, {
          ownerId: args.toOwnerId,
          userId,
          key: importedKey!,
        });
      } else {
        await ctx.db.patch(appStorage._id, {
          ownerId: args.toOwnerId,
          userId,
        });
      }
      return { hasMore: true, progressed: true };
    }
    const turn = (
      await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (turn) {
      const tokens = await ctx.db
        .query("cloud_turn_tokens")
        .withIndex("by_turnId_and_ownerId", (q) =>
          q.eq("turnId", turn.turnId).eq("ownerId", args.fromOwnerId),
        )
        .take(CLOUD_PROJECTION_BATCH_SIZE);
      const invocation = (
        await ctx.db
          .query("cloud_app_op_invocations")
          .withIndex("by_ownerId_and_turnId_and_createdAt", (q) =>
            q.eq("ownerId", args.fromOwnerId).eq("turnId", turn.turnId),
          )
          .take(1)
      )[0];
      if (tokens.length > 0) {
        await Promise.all(
          tokens.map((token) =>
            ctx.db.patch(token._id, { ownerId: args.toOwnerId }),
          ),
        );
      }
      if (invocation) {
        await ctx.db.patch(invocation._id, { ownerId: args.toOwnerId });
      }
      if (tokens.length < CLOUD_PROJECTION_BATCH_SIZE && !invocation) {
        await ctx.db.patch(turn._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true, progressed: true };
    }
    const thread = (
      await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (thread) {
      const messages = await ctx.db
        .query("cloud_thread_messages")
        .withIndex("by_conversationId_and_ownerId_and_seq", (q) =>
          q
            .eq("conversationId", thread.threadId)
            .eq("ownerId", args.fromOwnerId),
        )
        .take(CLOUD_PROJECTION_BATCH_SIZE);
      if (messages.length > 0) {
        await Promise.all(
          messages.map((message) =>
            ctx.db.patch(message._id, { ownerId: args.toOwnerId }),
          ),
        );
      }
      if (messages.length < CLOUD_PROJECTION_BATCH_SIZE) {
        await ctx.db.patch(thread._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true, progressed: true };
    }
    const ownerOnlyTables = [
      "cloud_message_excerpts",
      "cloud_thread_messages",
      "cloud_turn_tokens",
      "cloud_scheduled_turns",
    ] as const;
    for (const table of ownerOnlyTables) {
      if (table === "cloud_message_excerpts") {
        const row = (
          await ctx.db
            .query(table)
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.fromOwnerId),
            )
            .take(1)
        )[0];
        if (row) {
          await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
          return { hasMore: true, progressed: true };
        }
      } else if (table === "cloud_thread_messages") {
        const row = (
          await ctx.db
            .query(table)
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
            .take(1)
        )[0];
        if (row) {
          await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
          return { hasMore: true, progressed: true };
        }
      } else if (table === "cloud_turn_tokens") {
        const row = (
          await ctx.db
            .query(table)
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
            .take(1)
        )[0];
        if (row) {
          await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
          return { hasMore: true, progressed: true };
        }
      } else {
        const row = (
          await ctx.db
            .query(table)
            .withIndex("by_ownerId_and_updatedAt", (q) =>
              q.eq("ownerId", args.fromOwnerId),
            )
            .take(1)
        )[0];
        if (row) {
          await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
          return { hasMore: true, progressed: true };
        }
      }
    }
    return { hasMore: false, progressed: false };
  },
});

const ownershipResidueReturn = v.object({
  kind: v.union(v.literal("clear"), v.literal("retry"), v.literal("blocked")),
  table: v.optional(v.string()),
});

/**
 * Final fail-closed proof. Safe, anonymous-usable tables return `retry` so a
 * row created by a stale client between drain passes is migrated. Tables that
 * should require a connected account, or that represent an in-flight external
 * protocol, return `blocked`; the migration stays visible and requires an
 * explicit retry after the state is resolved.
 */
export const auditOwnershipMigrationResidue = internalQuery({
  args: ownerArgs,
  returns: ownershipResidueReturn,
  handler: async (ctx, args) => {
    const ownerId = args.fromOwnerId;
    const blockedChecks = [
      [
        "cloud_drive_uploads",
        await ctx.db
          .query("cloud_drive_uploads")
          .withIndex("by_ownerId_and_path", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "slack_oauth_states",
        await ctx.db
          .query("slack_oauth_states")
          .withIndex("by_ownerId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "x_oauth_states",
        await ctx.db
          .query("x_oauth_states")
          .withIndex("by_ownerId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "link_codes",
        await ctx.db
          .query("link_codes")
          .withIndex("by_ownerId_and_provider", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_engine_connects",
        await ctx.db
          .query("cloud_engine_connects")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_github_install_states",
        await ctx.db
          .query("cloud_github_install_states")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "mobile_bridge_sessions",
        await ctx.db
          .query("mobile_bridge_sessions")
          .withIndex("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "mobile_pairing_sessions",
        await ctx.db
          .query("mobile_pairing_sessions")
          .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "mobile_connect_intents",
        await ctx.db
          .query("mobile_connect_intents")
          .withIndex("by_ownerId_and_desktopDeviceId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "billing_usage_credits",
        await ctx.db
          .query("billing_usage_credits")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "billing_usage_credit_purchases",
        await ctx.db
          .query("billing_usage_credit_purchases")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "billing_stripe_events",
        await ctx.db
          .query("billing_stripe_events")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "billing_invoice_payments",
        await ctx.db
          .query("billing_invoice_payments")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "media_private_blob_cleanup",
        await ctx.db
          .query("media_private_blob_cleanup")
          .withIndex("by_ownerId_and_state", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "media_private_payload_manifests",
        await ctx.db
          .query("media_private_payload_manifests")
          .withIndex("by_ownerId_and_state", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "media_private_payload_chunks",
        await ctx.db
          .query("media_private_payload_chunks")
          .withIndex("by_ownerId_and_manifestId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "media_provider_cancellations",
        await ctx.db
          .query("media_provider_cancellations")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "media_owner_purges",
        await ctx.db
          .query("media_owner_purges")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "stella_relay_response_streams",
        await ctx.db
          .query("stella_relay_response_streams")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "stella_relay_response_leases",
        await ctx.db
          .query("stella_relay_response_leases")
          .withIndex("by_ownerId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "stella_relay_cancellation_intents",
        await ctx.db
          .query("stella_relay_cancellation_intents")
          .withIndex("by_ownerId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "stella_relay_owner_purges",
        await ctx.db
          .query("stella_relay_owner_purges")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "backup_key_escrows",
        await ctx.db
          .query("backup_key_escrows")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "backup_objects",
        await ctx.db
          .query("backup_objects")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "backup_manifests",
        await ctx.db
          .query("backup_manifests")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "user_pets",
        await ctx.db
          .query("user_pets")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "emoji_packs",
        await ctx.db
          .query("emoji_packs")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "canvas_shares",
        await ctx.db
          .query("canvas_shares")
          .withIndex("by_ownerUserId", (q) => q.eq("ownerUserId", ownerId))
          .take(1),
      ],
      [
        "social_profiles",
        await ctx.db
          .query("social_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "social_relationships",
        await ctx.db
          .query("social_relationships")
          .withIndex("by_requesterOwnerId_and_status", (q) =>
            q.eq("requesterOwnerId", ownerId),
          )
          .take(1),
      ],
      [
        "social_relationships.addresseeOwnerId",
        await ctx.db
          .query("social_relationships")
          .withIndex("by_addresseeOwnerId_and_status", (q) =>
            q.eq("addresseeOwnerId", ownerId),
          )
          .take(1),
      ],
      [
        "social_rooms",
        await ctx.db
          .query("social_rooms")
          .withIndex("by_createdByOwnerId_and_updatedAt", (q) =>
            q.eq("createdByOwnerId", ownerId),
          )
          .take(1),
      ],
      [
        "social_room_members",
        await ctx.db
          .query("social_room_members")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "social_messages",
        await ctx.db
          .query("social_messages")
          .withIndex("by_senderOwnerId_and_createdAt", (q) =>
            q.eq("senderOwnerId", ownerId),
          )
          .take(1),
      ],
      [
        "stella_session_members",
        await ctx.db
          .query("stella_session_members")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "stella_sessions.hostOwnerId",
        await ctx.db
          .query("stella_sessions")
          .withIndex("by_hostOwnerId_and_status", (q) =>
            q.eq("hostOwnerId", ownerId),
          )
          .take(1),
      ],
      [
        "stella_sessions.createdByOwnerId",
        await ctx.db
          .query("stella_sessions")
          .withIndex("by_createdByOwnerId_and_updatedAt", (q) =>
            q.eq("createdByOwnerId", ownerId),
          )
          .take(1),
      ],
      [
        "stella_session_turns",
        await ctx.db
          .query("stella_session_turns")
          .withIndex("by_requestedByOwnerId_and_createdAt", (q) =>
            q.eq("requestedByOwnerId", ownerId),
          )
          .take(1),
      ],
      [
        "stella_session_file_ops",
        await ctx.db
          .query("stella_session_file_ops")
          .withIndex("by_actorOwnerId_and_createdAt", (q) =>
            q.eq("actorOwnerId", ownerId),
          )
          .take(1),
      ],
    ] as const;
    for (const [table, rows] of blockedChecks) {
      if (rows.length > 0) return { kind: "blocked", table } as const;
    }

    const retryChecks = [
      [
        "conversations",
        await ctx.db
          .query("conversations")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_conversations",
        await ctx.db
          .query("cloud_conversations")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "user_preferences",
        await ctx.db
          .query("user_preferences")
          .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "usage_logs",
        await ctx.db
          .query("usage_logs")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "usage_rollups",
        await ctx.db
          .query("usage_rollups")
          .withIndex("by_ownerId_and_bucketStartMs", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "billing_usage_windows",
        await ctx.db
          .query("billing_usage_windows")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "billing_profiles",
        await ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "fashion_profiles",
        await ctx.db
          .query("fashion_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "fashion_outfits",
        await ctx.db
          .query("fashion_outfits")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "fashion_likes",
        await ctx.db
          .query("fashion_likes")
          .withIndex("by_ownerId_and_likedAt", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "fashion_cart_items",
        await ctx.db
          .query("fashion_cart_items")
          .withIndex("by_ownerId_and_addedAt", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "fashion_checkout_sessions",
        await ctx.db
          .query("fashion_checkout_sessions")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "store_packages",
        await ctx.db
          .query("store_packages")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "store_package_releases",
        await ctx.db
          .query("store_package_releases")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "x_oauth_tokens",
        await ctx.db
          .query("x_oauth_tokens")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "mobile_bridge_registrations",
        await ctx.db
          .query("mobile_bridge_registrations")
          .withIndex("by_ownerId_and_deviceId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "paired_mobile_devices",
        await ctx.db
          .query("paired_mobile_devices")
          .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "mobile_push_tokens",
        await ctx.db
          .query("mobile_push_tokens")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloudflare_tunnels",
        await ctx.db
          .query("cloudflare_tunnels")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "media_jobs",
        await ctx.db
          .query("media_jobs")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_apps",
        await ctx.db
          .query("cloud_apps")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_app_builds",
        await ctx.db
          .query("cloud_app_builds")
          .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_app_operations",
        await ctx.db
          .query("cloud_app_operations")
          .withIndex("by_ownerId_and_appId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_app_op_invocations",
        await ctx.db
          .query("cloud_app_op_invocations")
          .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_projects",
        await ctx.db
          .query("cloud_projects")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_drive_files",
        await ctx.db
          .query("cloud_drive_files")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_agent_home_docs",
        await ctx.db
          .query("cloud_agent_home_docs")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_scheduled_turns",
        await ctx.db
          .query("cloud_scheduled_turns")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "devices",
        await ctx.db
          .query("devices")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "device_presence",
        await ctx.db
          .query("device_presence")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "channel_connections",
        await ctx.db
          .query("channel_connections")
          .withIndex("by_ownerId_and_provider", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "auth_session_policies",
        await ctx.db
          .query("auth_session_policies")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "secrets",
        await ctx.db
          .query("secrets")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "secret_access_audit",
        await ctx.db
          .query("secret_access_audit")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "user_integrations",
        await ctx.db
          .query("user_integrations")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "transient_channel_events",
        await ctx.db
          .query("transient_channel_events")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "transient_cleanup_failures",
        await ctx.db
          .query("transient_cleanup_failures")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "connector_turn_payloads",
        await ctx.db
          .query("connector_turn_payloads")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "agents",
        await ctx.db
          .query("agents")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "user_counters",
        await ctx.db
          .query("user_counters")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "billing_voice_usage_receipts",
        await ctx.db
          .query("billing_voice_usage_receipts")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "billing_media_usage_receipts",
        await ctx.db
          .query("billing_media_usage_receipts")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "billing_voice_sessions",
        await ctx.db
          .query("billing_voice_sessions")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "media_job_logs",
        await ctx.db
          .query("media_job_logs")
          .withIndex("by_ownerId_and_jobId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "media_request_cancellations",
        await ctx.db
          .query("media_request_cancellations")
          .withIndex("by_ownerId_and_clientRequestKey", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "media_webhook_events",
        await ctx.db
          .query("media_webhook_events")
          .withIndex("by_ownerId_and_receivedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_drive_usage",
        await ctx.db
          .query("cloud_drive_usage")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_drive_deletions",
        await ctx.db
          .query("cloud_drive_deletions")
          .withIndex("by_ownerId_and_deletedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_llm_credentials",
        await ctx.db
          .query("cloud_llm_credentials")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_engine_settings",
        await ctx.db
          .query("cloud_engine_settings")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_github_installations",
        await ctx.db
          .query("cloud_github_installations")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_interior_builds",
        await ctx.db
          .query("cloud_interior_builds")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_interior_deployables",
        await ctx.db
          .query("cloud_interior_deployables")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "agent_turns",
        await ctx.db
          .query("agent_turns")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_agent_threads",
        await ctx.db
          .query("cloud_agent_threads")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_thread_messages",
        await ctx.db
          .query("cloud_thread_messages")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_messages",
        await ctx.db
          .query("cloud_messages")
          .withIndex("by_ownerId_and_seq", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_turn_tokens",
        await ctx.db
          .query("cloud_turn_tokens")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_message_excerpts",
        await ctx.db
          .query("cloud_message_excerpts")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_app_storage",
        await ctx.db
          .query("cloud_app_storage")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
    ] as const;
    for (const [table, rows] of retryChecks) {
      if (rows.length > 0) return { kind: "retry", table } as const;
    }
    return { kind: "clear" } as const;
  },
});

/** Bound on how many duplicate-default conversations we'll consider. */
const DEDUPLICATE_DEFAULT_BATCH = 200;

/**
 * Deduplicate default conversations after migration.
 * If the target user already has a default conversation, un-default the
 * migrated ones to avoid constraint violations.
 */
export const deduplicateDefaultConversation = internalMutation({
  args: {
    toOwnerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const defaults = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_isDefault", (q) =>
        q.eq("ownerId", args.toOwnerId).eq("isDefault", true),
      )
      .take(DEDUPLICATE_DEFAULT_BATCH);

    if (defaults.length <= 1) return null;

    defaults.sort((a, b) => a.createdAt - b.createdAt);
    const promises = [];
    for (let i = 1; i < defaults.length; i++) {
      promises.push(ctx.db.patch(defaults[i]._id, { isDefault: false }));
    }
    await Promise.all(promises);

    return null;
  },
});

/**
 * After ownership migration, both the source and destination owner may have
 * a `user_counters` row. Collapse them by summing the conversation counts
 * into the oldest row and deleting the duplicates so future quota lookups
 * find a single row via `unique()`.
 */
export const deduplicateUserCounters = internalMutation({
  args: { toOwnerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("user_counters")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
      .take(64);

    if (rows.length <= 1) return null;

    rows.sort((a, b) => a._creationTime - b._creationTime);
    const [primary, ...duplicates] = rows;
    const totalCount = rows.reduce(
      (sum, row) => sum + (row.conversationCount ?? 0),
      0,
    );
    await ctx.db.patch(primary._id, {
      conversationCount: totalCount,
      updatedAt: Date.now(),
    });
    await Promise.all(duplicates.map((row) => ctx.db.delete(row._id)));
    return null;
  },
});

/**
 * Tables whose batches are independent of every other table — drainable in
 * parallel from the orchestrator. `devices` / `device_presence` /
 * `channel_connections` are NOT here: they go through
 * `migrateDevicesForAccountLink` because that mutation enforces the
 * devices→presence→connections write order to keep partial migrations
 * consistent.
 */
const PARALLEL_TABLE_MUTATIONS = [
  internal.auth_migration.migrateConversationsBatch,
  internal.auth_migration.migrateUserPreferencesBatch,
  internal.auth_migration.migrateAuthSessionPoliciesBatch,
  internal.auth_migration.migrateSecretsBatch,
  internal.auth_migration.migrateSecretAccessAuditBatch,
  internal.auth_migration.migrateUserIntegrationsBatch,
  internal.auth_migration.migrateUsageLogsBatch,
  internal.auth_migration.migrateTransientChannelEventsBatch,
  internal.auth_migration.migrateTransientCleanupFailuresBatch,
  internal.auth_migration.migrateConnectorTurnPayloadsBatch,
  internal.auth_migration.migrateAgentsBatch,
  internal.auth_migration.migrateMediaJobsBatch,
  internal.auth_migration.migrateMediaRequestCancellationsBatch,
  internal.auth_migration.migrateMediaJobLogsBatch,
  internal.auth_migration.migrateMediaWebhookEventsBatch,
  internal.auth_migration.migrateUserCountersBatch,
  internal.auth_migration.migrateFashionBatch,
  internal.auth_migration.migrateStoreContentBatch,
  internal.auth_migration.migrateXTokensBatch,
  internal.auth_migration.migrateUsageAccountingBatch,
  internal.auth_migration.migrateDeviceExtensionsForAccountLink,
] as const;

type OwnerBatchMutation = FunctionReference<
  "mutation",
  "internal",
  { fromOwnerId: string; toOwnerId: string },
  { hasMore: boolean }
>;

const cloudBuilderEndpoint = (): { url: string; secret: string } | null => {
  const url = process.env.CLOUD_BUILDER_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return url && secret ? { url, secret } : null;
};

type CloudOwnerActivityLease = {
  ownerId: string;
  generation: string;
  leaseId: string;
  sessionId: string;
  turnId: string;
};

const registerCloudOwnerActivityLease = async (args: {
  ownerId: string;
  activityId: string;
}): Promise<
  | { kind: "ack"; lease: CloudOwnerActivityLease }
  | { kind: "retry"; reason: string }
  | { kind: "permanent"; reason: string }
> => {
  const builder = cloudBuilderEndpoint();
  if (!builder) {
    return {
      kind: "retry",
      reason: "Cloud builder endpoint is not configured.",
    };
  }
  try {
    const response = await fetch(
      `${builder.url}/internal/owners/activity/register`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${builder.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const body = (await response.json().catch(() => null)) as {
      code?: unknown;
      message?: unknown;
      ownerId?: unknown;
      generation?: unknown;
      leaseId?: unknown;
      sessionId?: unknown;
      turnId?: unknown;
    } | null;
    const reason =
      typeof body?.message === "string"
        ? body.message
        : `Cloud owner activity lease returned ${response.status}.`;
    if (
      response.ok &&
      typeof body?.ownerId === "string" &&
      typeof body.generation === "string" &&
      typeof body.leaseId === "string" &&
      typeof body.sessionId === "string" &&
      typeof body.turnId === "string"
    ) {
      return {
        kind: "ack",
        lease: {
          ownerId: body.ownerId,
          generation: body.generation,
          leaseId: body.leaseId,
          sessionId: body.sessionId,
          turnId: body.turnId,
        },
      };
    }
    if (response.status === 409 && body?.code === "owner_purge") {
      return { kind: "permanent", reason };
    }
    return { kind: "retry", reason };
  } catch (error) {
    return {
      kind: "retry",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

const releaseCloudOwnerActivityLease = async (
  lease: CloudOwnerActivityLease,
): Promise<void> => {
  const builder = cloudBuilderEndpoint();
  if (!builder) return;
  await fetch(`${builder.url}/internal/owners/activity/unregister`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${builder.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(lease),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined);
};

const requestCloudConversationOwnerTransfer = async (args: {
  conversationId: string;
  fromOwnerId: string;
  toOwnerId: string;
}): Promise<
  | { kind: "ack" }
  | { kind: "retry"; reason: string; retryAfterMs: number }
  | { kind: "permanent"; reason: string }
> => {
  const builder = cloudBuilderEndpoint();
  if (!builder) {
    return {
      kind: "retry",
      reason: "Cloud builder endpoint is not configured.",
      retryAfterMs: 60_000,
    };
  }
  const response = await fetch(
    `${builder.url}/internal/conversations/${encodeURIComponent(args.conversationId)}/transfer-owner`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${builder.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        fromOwnerId: args.fromOwnerId,
        toOwnerId: args.toOwnerId,
      }),
      signal: AbortSignal.timeout(150_000),
    },
  );
  const verdict = (await response.json().catch(() => null)) as {
    transferred?: unknown;
    code?: unknown;
    message?: unknown;
    retryAfterMs?: unknown;
  } | null;
  const code = typeof verdict?.code === "string" ? verdict.code : "";
  const reason =
    typeof verdict?.message === "string"
      ? verdict.message
      : `Cloud conversation ownership transfer returned ${response.status}.`;
  const retryAfterMs =
    typeof verdict?.retryAfterMs === "number" &&
    Number.isFinite(verdict.retryAfterMs)
      ? Math.min(60_000, Math.max(1_000, verdict.retryAfterMs))
      : 5_000;
  if (response.ok && verdict?.transferred === true) return { kind: "ack" };
  if (
    response.status === 202 ||
    (response.status === 409 &&
      (code === "turn_in_progress" || code === "owner_transfer_in_progress"))
  ) {
    return { kind: "retry", reason, retryAfterMs };
  }
  if (
    response.status === 409 &&
    (code === "owner_mismatch" || code === "owner_transfer_conflict")
  ) {
    return { kind: "permanent", reason };
  }
  if (response.status === 400 || (response.status === 409 && code !== "")) {
    return { kind: "permanent", reason };
  }
  // A mixed Convex/worker rollout can temporarily expose no transfer route.
  // Treat 404 as deployment skew, not proof that user data is unrecoverable.
  if (response.status === 404) {
    return { kind: "retry", reason, retryAfterMs: 60_000 };
  }
  return { kind: "retry", reason, retryAfterMs };
};

type CloudProductTransferPayload = {
  fromOwnerId: string;
  toOwnerId: string;
  agentHome: boolean;
  interiors: boolean;
  workspaces: Array<{ from: string; to: string; importedTo?: string }>;
  appSlugs: string[];
};

type WorkspaceTransferResolution = {
  from: string;
  requestedTo: string;
  resolvedTo: string;
  imported: boolean;
};

const requestCloudProductOwnerTransfer = async (
  args: CloudProductTransferPayload,
): Promise<
  | {
      kind: "ack";
      fromOwnerHash: string;
      toOwnerHash: string;
      workspaceResolutions: WorkspaceTransferResolution[];
    }
  | { kind: "retry"; reason: string; retryAfterMs: number }
  | { kind: "permanent"; reason: string }
> => {
  const builder = cloudBuilderEndpoint();
  if (!builder) {
    return {
      kind: "retry",
      reason: "Cloud builder endpoint is not configured.",
      retryAfterMs: 60_000,
    };
  }
  try {
    const response = await fetch(
      `${builder.url}/internal/owners/transfer-product-state`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${builder.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(150_000),
      },
    );
    const body = (await response.json().catch(() => null)) as {
      transferred?: unknown;
      fromOwnerHash?: unknown;
      toOwnerHash?: unknown;
      workspaceResolutions?: unknown;
      code?: unknown;
      message?: unknown;
      retryAfterMs?: unknown;
    } | null;
    const reason =
      typeof body?.message === "string"
        ? body.message
        : `Cloud product ownership transfer returned ${response.status}.`;
    const retryAfterMs =
      typeof body?.retryAfterMs === "number" &&
      Number.isFinite(body.retryAfterMs)
        ? Math.min(60_000, Math.max(1_000, body.retryAfterMs))
        : 5_000;
    if (
      response.ok &&
      body?.transferred === true &&
      typeof body.fromOwnerHash === "string" &&
      typeof body.toOwnerHash === "string" &&
      Array.isArray(body.workspaceResolutions)
    ) {
      const workspaceResolutions: WorkspaceTransferResolution[] = [];
      for (const raw of body.workspaceResolutions) {
        if (!raw || typeof raw !== "object") {
          return {
            kind: "retry",
            reason: "Cloud product transfer returned an invalid workspace map.",
            retryAfterMs: 5_000,
          };
        }
        const entry = raw as Record<string, unknown>;
        if (
          typeof entry.from !== "string" ||
          typeof entry.requestedTo !== "string" ||
          typeof entry.resolvedTo !== "string" ||
          typeof entry.imported !== "boolean"
        ) {
          return {
            kind: "retry",
            reason: "Cloud product transfer returned an invalid workspace map.",
            retryAfterMs: 5_000,
          };
        }
        workspaceResolutions.push({
          from: entry.from,
          requestedTo: entry.requestedTo,
          resolvedTo: entry.resolvedTo,
          imported: entry.imported,
        });
      }
      const [expectedFromOwnerHash, expectedToOwnerHash] = await Promise.all([
        hashSha256Hex(args.fromOwnerId),
        hashSha256Hex(args.toOwnerId),
      ]);
      if (
        body.fromOwnerHash !== expectedFromOwnerHash ||
        body.toOwnerHash !== expectedToOwnerHash ||
        !workspaceTransferResolutionsMatch(
          args.workspaces,
          workspaceResolutions,
        )
      ) {
        return {
          kind: "retry",
          reason:
            "Cloud product transfer returned a workspace mapping that does not match the requested import plan.",
          retryAfterMs: 60_000,
        };
      }
      return {
        kind: "ack",
        fromOwnerHash: body.fromOwnerHash,
        toOwnerHash: body.toOwnerHash,
        workspaceResolutions,
      };
    }
    if (
      response.status === 400 ||
      (response.status === 409 && body?.code === "owner_transfer_conflict")
    ) {
      return { kind: "permanent", reason };
    }
    return { kind: "retry", reason, retryAfterMs };
  } catch (error) {
    return {
      kind: "retry",
      reason: error instanceof Error ? error.message : String(error),
      retryAfterMs: 5_000,
    };
  }
};

/**
 * Orchestrate the full ownership migration across all tables. Called
 * asynchronously via scheduler when an anonymous user links to a real
 * account.
 *
 * Tables whose drain is independent run concurrently (`Promise.all`) so a
 * tenant with data in many tables doesn't pay the sum of every per-table
 * round-trip. The devices/presence/connections migration runs first and
 * sequentially because `migrateDevicesForAccountLink` enforces a strict
 * order across those three tables.
 */
export const migrateOwnership = internalAction({
  args: {
    fromOwnerId: v.string(),
    toOwnerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.fromOwnerId === args.toOwnerId) return null;

    const leaseId = crypto.randomUUID();
    const claim = await ctx.runMutation(
      internal.auth_migration.claimOwnershipMigration,
      {
        ...args,
        leaseId,
        now: Date.now(),
      },
    );
    if (!claim.claimed) {
      return null;
    }

    let outcome: "pending" | "failed" | "complete" = "pending";
    let retryAfterMs = 5_000;
    let migrationError: string | undefined;
    try {
      const cloudConversations: Array<{
        conversationId: string;
        deleted: boolean;
        purged: boolean;
      }> = await ctx.runQuery(
        internal.auth_migration.listCloudConversationTransferBatch,
        args,
      );
      const conversation = cloudConversations[0];
      if (conversation) {
        if (conversation.deleted) {
          if (!conversation.purged) {
            await ctx.runAction(internal.cloud_apps.purgeConversationInternal, {
              conversationId: conversation.conversationId,
              ownerId: args.fromOwnerId,
            });
          } else {
            await ctx.runMutation(
              internal.auth_migration.commitDeletedCloudConversationTransfer,
              {
                ...args,
                conversationId: conversation.conversationId,
              },
            );
          }
          retryAfterMs = 1_000;
        } else {
          // Even an empty conversation may already have bound its Durable
          // Object when a client opened a socket. Always rekey the DO before
          // flipping the Convex index; lastSeq cannot prove no DO exists.
          // Hold both owner purge fences through the Convex projection commit.
          // Without this, account deletion can begin after the DO rekeys but
          // before the index flips, miss the conversation, and then race a stale
          // commit that resurrects data under the deleted account.
          const heldLeases: CloudOwnerActivityLease[] = [];
          const activityId = `owner-transfer:${leaseId}:${conversation.conversationId}`;
          try {
            for (const ownerId of [args.fromOwnerId, args.toOwnerId]) {
              const registration = await registerCloudOwnerActivityLease({
                ownerId,
                activityId,
              });
              if (registration.kind === "permanent") {
                outcome = "failed";
                migrationError = registration.reason;
                break;
              }
              if (registration.kind === "retry") {
                migrationError = registration.reason;
                retryAfterMs = 60_000;
                break;
              }
              heldLeases.push(registration.lease);
            }
            if (heldLeases.length === 2 && outcome !== "failed") {
              let acknowledged = false;
              const verdict = await requestCloudConversationOwnerTransfer({
                conversationId: conversation.conversationId,
                fromOwnerId: args.fromOwnerId,
                toOwnerId: args.toOwnerId,
              });
              if (verdict.kind === "permanent") {
                outcome = "failed";
                migrationError = verdict.reason;
              } else if (verdict.kind === "retry") {
                migrationError = verdict.reason;
                retryAfterMs = verdict.retryAfterMs;
              } else {
                acknowledged = true;
              }
              if (acknowledged && outcome !== "failed") {
                await ctx.runMutation(
                  internal.auth_migration.commitCloudConversationTransferBatch,
                  {
                    ...args,
                    conversationId: conversation.conversationId,
                  },
                );
                retryAfterMs = 1_000;
              }
            }
          } finally {
            await Promise.all(
              heldLeases.map((held) => releaseCloudOwnerActivityLease(held)),
            );
          }
        }
      } else {
        const work = await ctx.runQuery(
          internal.auth_migration.getCloudProductTransferWork,
          args,
        );
        if (work.kind === "advance") {
          await ctx.runMutation(
            internal.auth_migration.advanceCloudProductTransferStage,
            {
              ...args,
              leaseId,
              stage: work.stage,
              nextStage: work.nextStage,
            },
          );
          retryAfterMs = 1_000;
        } else if (work.kind === "core") {
          const result = await ctx.runMutation(
            internal.auth_migration.migrateCloudProductCoreBatch,
            args,
          );
          if (!result.hasMore) {
            await ctx.runMutation(
              internal.auth_migration.advanceCloudProductTransferStage,
              {
                ...args,
                leaseId,
                stage: "core",
                nextStage: "complete",
              },
            );
          }
          retryAfterMs = 1_000;
        } else if (work.kind !== "complete") {
          const namespaceBlocker =
            work.kind === "owner-namespaces"
              ? await ctx.runQuery(
                  internal.auth_migration.getOwnerNamespaceTransferBlocker,
                  args,
                )
              : null;
          if (namespaceBlocker) {
            outcome = "failed";
            migrationError = namespaceBlocker;
          }
          const payload: CloudProductTransferPayload = {
            ...args,
            agentHome: work.kind === "owner-namespaces",
            interiors: work.kind === "interior",
            workspaces:
              work.kind === "owner-namespaces"
                ? [
                    {
                      from: "drive",
                      to: "drive",
                      importedTo: work.driveImportedWorkspace,
                    },
                    {
                      from: "stella",
                      to: "stella",
                      importedTo: work.stellaImportedWorkspace,
                    },
                  ]
                : work.kind === "app"
                  ? [
                      {
                        from: `app:${work.slug}`,
                        to: `app:${work.slug}`,
                        importedTo: work.importedWorkspace,
                      },
                    ]
                  : work.kind === "project"
                    ? [
                        {
                          from: work.fromWorkspace,
                          to: work.toWorkspace,
                          importedTo: work.importedWorkspace,
                        },
                      ]
                    : [],
            appSlugs: work.kind === "app" ? [work.slug] : [],
          };
          const heldLeases: CloudOwnerActivityLease[] = [];
          const activityId = `owner-product-transfer:${leaseId}:${work.kind}`;
          try {
            for (const ownerId of namespaceBlocker
              ? []
              : [args.fromOwnerId, args.toOwnerId]) {
              const registration = await registerCloudOwnerActivityLease({
                ownerId,
                activityId,
              });
              if (registration.kind === "permanent") {
                outcome = "failed";
                migrationError = registration.reason;
                break;
              }
              if (registration.kind === "retry") {
                migrationError = registration.reason;
                retryAfterMs = 60_000;
                break;
              }
              heldLeases.push(registration.lease);
            }
            if (heldLeases.length === 2 && outcome !== "failed") {
              const verdict = await requestCloudProductOwnerTransfer(payload);
              if (verdict.kind === "permanent") {
                outcome = "failed";
                migrationError = verdict.reason;
              } else if (verdict.kind === "retry") {
                migrationError = verdict.reason;
                retryAfterMs = verdict.retryAfterMs;
              } else if (work.kind === "owner-namespaces") {
                const importedProjects: ImportedWorkspaceProject[] = [];
                const driveResolution = verdict.workspaceResolutions.find(
                  (entry) => entry.from === "drive",
                );
                if (driveResolution?.imported) {
                  importedProjects.push({
                    projectId: work.driveImportedProjectId,
                    workspace: driveResolution.resolvedTo,
                    name: "Anonymous Drive workspace (imported)",
                  });
                }
                const stellaResolution = verdict.workspaceResolutions.find(
                  (entry) => entry.from === "stella",
                );
                if (stellaResolution?.imported) {
                  importedProjects.push({
                    projectId: work.stellaImportedProjectId,
                    workspace: stellaResolution.resolvedTo,
                    name: "Anonymous Stella workspace (imported)",
                  });
                }
                await ctx.runMutation(
                  internal.auth_migration.commitOwnerNamespaceTransfer,
                  {
                    ...args,
                    leaseId,
                    fromOwnerHash: verdict.fromOwnerHash,
                    toOwnerHash: verdict.toOwnerHash,
                    importedProjects,
                  },
                );
                retryAfterMs = 1_000;
              } else if (work.kind === "app") {
                const resolution = verdict.workspaceResolutions.find(
                  (entry) => entry.from === `app:${work.slug}`,
                );
                await ctx.runMutation(
                  internal.auth_migration.commitCloudAppTransferBatch,
                  {
                    ...args,
                    appId: work.appId,
                    ...(resolution?.imported
                      ? {
                          importedProject: {
                            projectId: work.importedProjectId,
                            workspace: resolution.resolvedTo,
                            name: `${work.slug} app workspace (imported)`,
                          },
                        }
                      : {}),
                  },
                );
                retryAfterMs = 1_000;
              } else if (work.kind === "interior") {
                await ctx.runMutation(
                  internal.auth_migration.commitCloudInteriorTransferBatch,
                  {
                    ...args,
                    fromOwnerHash: verdict.fromOwnerHash,
                    toOwnerHash: verdict.toOwnerHash,
                  },
                );
                retryAfterMs = 1_000;
              } else {
                const resolution = verdict.workspaceResolutions.find(
                  (entry) => entry.from === work.fromWorkspace,
                );
                const resolvedWorkspace =
                  resolution?.resolvedTo ?? work.toWorkspace;
                const resolvedTargetSlug = resolvedWorkspace.startsWith(
                  "project:",
                )
                  ? resolvedWorkspace.slice("project:".length)
                  : "";
                if (!resolvedTargetSlug) {
                  outcome = "failed";
                  migrationError =
                    "The worker returned an invalid project workspace mapping.";
                } else {
                  const committed = await ctx.runMutation(
                    internal.auth_migration.commitCloudProjectTransfer,
                    {
                      ...args,
                      projectId: work.projectId,
                      targetSlug: resolvedTargetSlug,
                    },
                  );
                  if (!committed) {
                    outcome = "failed";
                    migrationError =
                      "The destination project slug changed during ownership transfer.";
                  } else {
                    retryAfterMs = 1_000;
                  }
                }
              }
            }
          } finally {
            await Promise.all(
              heldLeases.map((held) => releaseCloudOwnerActivityLease(held)),
            );
          }
        } else {
          const deviceMigration = await ctx.runMutation(
            internal.auth_migration.migrateDevicesForAccountLink,
            {
              fromOwnerId: args.fromOwnerId,
              toOwnerId: args.toOwnerId,
            },
          );
          const independentMigrations = await Promise.all(
            PARALLEL_TABLE_MUTATIONS.map((mutation) =>
              ctx.runMutation(mutation as OwnerBatchMutation, {
                fromOwnerId: args.fromOwnerId,
                toOwnerId: args.toOwnerId,
              }),
            ),
          );
          if (
            deviceMigration.hasMore ||
            independentMigrations.some((result) => result.hasMore)
          ) {
            retryAfterMs = 1_000;
          } else {
            // These depend on all source-owner rows having drained.
            await Promise.all([
              ctx.runMutation(
                internal.auth_migration.deduplicateDefaultConversation,
                {
                  toOwnerId: args.toOwnerId,
                },
              ),
              ctx.runMutation(internal.auth_migration.deduplicateUserCounters, {
                toOwnerId: args.toOwnerId,
              }),
            ]);
            const residue = await ctx.runQuery(
              internal.auth_migration.auditOwnershipMigrationResidue,
              args,
            );
            if (residue.kind === "retry") {
              retryAfterMs = 1_000;
              migrationError = `Source-owner state reappeared in ${residue.table ?? "an anonymous-usable table"}; another bounded pass is required.`;
            } else if (residue.kind === "blocked") {
              outcome = "failed";
              migrationError = `Account linking is blocked by unresolved ${residue.table ?? "connected-only or in-flight"} state on the anonymous identity.`;
            } else {
              outcome = "complete";
              console.log(
                `[auth_migration] Completed ownership migration from ${args.fromOwnerId} to ${args.toOwnerId}`,
              );
            }
          }
        }
      }
    } catch (error) {
      migrationError = error instanceof Error ? error.message : String(error);
      if (isOwnershipMigrationBlockedMessage(migrationError)) {
        outcome = "failed";
        migrationError = migrationError
          .slice(OWNERSHIP_MIGRATION_BLOCKED_PREFIX.length)
          .trim();
        console.error(
          `[auth_migration] Ownership migration blocked: ${migrationError}`,
        );
      } else {
        retryAfterMs = 5_000;
        console.error(
          `[auth_migration] Ownership migration pass will retry: ${migrationError}`,
        );
      }
    }
    await ctx.runMutation(
      internal.auth_migration.finishOwnershipMigrationPass,
      {
        ...args,
        leaseId,
        outcome,
        retryAfterMs,
        ...(migrationError ? { error: migrationError.slice(0, 1_000) } : {}),
        now: Date.now(),
      },
    );
    return null;
  },
});

/**
 * Migrate devices, device_presence and channel_connections rows for an
 * account-link in bounded batches. Each invocation processes at most
 * `BATCH_SIZE` rows per table and returns `hasMore` so the caller
 * (`migrateOwnership`) can re-invoke until all three tables are drained,
 * staying within Convex mutation transaction limits even for owners with
 * many devices/presence rows/connections.
 *
 * Migration order is preserved across batches: presence migrates after
 * devices and connections after presence, so a partial migration never
 * leaves the system with a connection that points to the old owner while
 * devices have already moved.
 */
export const migrateDevicesForAccountLink = internalMutation({
  args: {
    fromOwnerId: v.string(),
    toOwnerId: v.string(),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    // --- devices (stable profile rows) ---
    const deviceRows = await ctx.db
      .query("devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);

    if (deviceRows.length > 0) {
      for (const row of deviceRows) {
        const existing = await ctx.db
          .query("devices")
          .withIndex("by_ownerId_and_deviceId", (q) =>
            q.eq("ownerId", args.toOwnerId).eq("deviceId", row.deviceId),
          )
          .unique();

        if (existing) {
          await ctx.db.delete(row._id);
        } else {
          await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
        }
      }
      // A non-empty page means another pass is required even when the page
      // was short: the next pass is what advances to device_presence. Using
      // `=== BATCH_SIZE` here can report the whole staged migration complete
      // after a partial device page and strand every later stage.
      return { hasMore: true };
    }

    // --- device_presence (high-churn) ---
    const presenceRows = await ctx.db
      .query("device_presence")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);

    if (presenceRows.length > 0) {
      for (const row of presenceRows) {
        const existing = await ctx.db
          .query("device_presence")
          .withIndex("by_ownerId_and_deviceId", (q) =>
            q.eq("ownerId", args.toOwnerId).eq("deviceId", row.deviceId),
          )
          .unique();

        if (existing) {
          await ctx.db.delete(row._id);
        } else {
          await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
        }
      }
      // As above, the empty follow-up pass is the durable stage boundary that
      // lets the mutation proceed to channel_connections.
      return { hasMore: true };
    }

    // --- channel_connections ---
    const connectionRows = await ctx.db
      .query("channel_connections")
      .withIndex("by_ownerId_and_provider", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);

    for (const row of connectionRows) {
      const existing = await ctx.db
        .query("channel_connections")
        .withIndex("by_ownerId_and_provider_and_externalUserId", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("provider", row.provider)
            .eq("externalUserId", row.externalUserId),
        )
        .unique();
      if (existing) {
        blockOwnershipMigration(
          `Both identities contain the ${row.provider} connector account ${row.externalUserId}.`,
        );
      }
      await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
    }
    // Require one final empty pass before declaring the staged drain complete.
    return { hasMore: connectionRows.length > 0 };
  },
});
