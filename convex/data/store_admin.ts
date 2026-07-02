import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import {
  store_package_category_validator,
  store_release_advisory_review_validator,
  store_release_commit_meta_validator,
} from "../schema/store";
import { isStoreAdminCtx, requireStoreAdmin } from "../lib/store_admin";
import { requireBoundedString } from "../shared_validators";

// ── Manual approval queue (Stella team only) ─────────────────────────────────
//
// Store submissions land as `store_package_releases` rows with
// `reviewStatus: "pending"` and are invisible to everyone but their owner
// until a Stella team member approves them here. Approval is what advances
// the package's published pointers (`latestReleaseNumber`/`latestReleaseId`)
// and, for first releases, flips the package from "private" to "public".

const MAX_PENDING_SUBMISSIONS_PAGE = 100;
const MAX_REJECTION_REASON_LENGTH = 2_000;

const pending_submission_validator = v.object({
  releaseId: v.id("store_package_releases"),
  ownerId: v.string(),
  packageId: v.string(),
  releaseNumber: v.number(),
  isFirstRelease: v.boolean(),
  displayName: v.string(),
  description: v.optional(v.string()),
  category: v.optional(store_package_category_validator),
  iconUrl: v.optional(v.string()),
  authorUsername: v.optional(v.string()),
  releaseNotes: v.optional(v.string()),
  blueprintMarkdown: v.string(),
  commits: v.optional(v.array(store_release_commit_meta_validator)),
  advisoryReview: v.optional(store_release_advisory_review_validator),
  submittedAt: v.number(),
});

/** Whether the caller may work the store approval queue. */
export const isStoreAdmin = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => isStoreAdminCtx(ctx),
});

/**
 * Pending submissions, oldest first, joined with their package's listing
 * metadata. The blueprint markdown IS the reviewable artifact — it's the
 * behaviour spec another user's Stella implements on install.
 */
export const listPendingSubmissions = query({
  args: {},
  returns: v.array(pending_submission_validator),
  handler: async (ctx) => {
    await requireStoreAdmin(ctx);
    const releases = await ctx.db
      .query("store_package_releases")
      .withIndex("by_reviewStatus_and_createdAt", (q) =>
        q.eq("reviewStatus", "pending"),
      )
      .order("asc")
      .take(MAX_PENDING_SUBMISSIONS_PAGE);
    const results = [];
    for (const release of releases) {
      const pkg = await ctx.db.get(release.packageRef);
      if (!pkg) continue;
      results.push({
        releaseId: release._id,
        ownerId: release.ownerId,
        packageId: release.packageId,
        releaseNumber: release.releaseNumber,
        isFirstRelease: release.releaseNumber === 1,
        displayName: pkg.displayName,
        ...(pkg.description ? { description: pkg.description } : {}),
        ...(pkg.category ? { category: pkg.category } : {}),
        ...(release.manifest.iconUrl || pkg.iconUrl
          ? { iconUrl: release.manifest.iconUrl ?? pkg.iconUrl }
          : {}),
        ...(pkg.authorUsername ? { authorUsername: pkg.authorUsername } : {}),
        ...(release.releaseNotes ? { releaseNotes: release.releaseNotes } : {}),
        blueprintMarkdown: release.blueprintMarkdown,
        ...(release.commits ? { commits: release.commits } : {}),
        ...(release.advisoryReview
          ? { advisoryReview: release.advisoryReview }
          : {}),
        submittedAt: release.createdAt,
      });
    }
    return results;
  },
});

/**
 * Approve a pending submission: the release becomes publicly readable,
 * the package's published pointers advance to it, and a first release
 * flips the package from "private" (queue holding state) to "public".
 */
export const approveSubmission = mutation({
  args: { releaseId: v.id("store_package_releases") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireStoreAdmin(ctx);
    const release = await ctx.db.get(args.releaseId);
    if (!release) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Submission not found.",
      });
    }
    if (release.reviewStatus !== "pending") {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Submission has already been reviewed.",
      });
    }
    const pkg = await ctx.db.get(release.packageRef);
    if (!pkg) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Package for this submission no longer exists.",
      });
    }

    const now = Date.now();
    await ctx.db.patch(release._id, {
      reviewStatus: "approved",
      reviewedAt: now,
    });

    const isFirstApproval = pkg.latestReleaseNumber < 1;
    if (release.releaseNumber > pkg.latestReleaseNumber) {
      await ctx.db.patch(pkg._id, {
        latestReleaseNumber: release.releaseNumber,
        latestReleaseId: release._id,
        updatedAt: now,
        ...(release.manifest.iconUrl && !pkg.iconUrl
          ? { iconUrl: release.manifest.iconUrl }
          : {}),
        // First approval publishes the package; later approvals leave
        // whatever visibility the owner has chosen alone.
        ...(isFirstApproval && pkg.visibility === "private"
          ? { visibility: "public" as const }
          : {}),
      });
    }
    return null;
  },
});

/**
 * Reject a pending submission. The optional reason is shown to the
 * submitter in their submission status. Nothing else changes — the
 * package keeps serving its current approved release (or stays private
 * if this was its first release).
 */
export const rejectSubmission = mutation({
  args: {
    releaseId: v.id("store_package_releases"),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireStoreAdmin(ctx);
    const release = await ctx.db.get(args.releaseId);
    if (!release) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Submission not found.",
      });
    }
    if (release.reviewStatus !== "pending") {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Submission has already been reviewed.",
      });
    }
    const reason = args.reason?.trim();
    if (reason) {
      requireBoundedString(reason, "reason", MAX_REJECTION_REASON_LENGTH);
    }
    await ctx.db.patch(release._id, {
      reviewStatus: "rejected",
      reviewedAt: Date.now(),
      ...(reason ? { reviewRejectionReason: reason } : {}),
    });
    return null;
  },
});
