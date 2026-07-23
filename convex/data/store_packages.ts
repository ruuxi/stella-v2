import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, Infer, v } from "convex/values";
import {
  getUserIdOrNull,
  requireSensitiveUserIdAction,
  requireUserId,
} from "../auth";
import { requireBoundedString } from "../shared_validators";
import {
  store_package_category_validator,
  store_package_release_validator,
  store_package_validator,
  store_package_visibility_validator,
  store_publish_result_validator,
  store_release_advisory_review_validator,
  store_release_review_status_validator,
  store_release_commit_meta_validator,
  store_release_diff_ref_validator,
  store_release_git_artifact_validator,
  store_release_manifest_validator,
} from "../schema/store";
import { socialBadgeValidator } from "../schema/social";
import { runStoreReleaseReviewAdvisory } from "../lib/store_release_reviews";
import { generateStoreIconUrl } from "../lib/store_icon";
import {
  enforceActionRateLimit,
  enforceMutationRateLimit,
  RATE_STANDARD,
  RATE_VERY_EXPENSIVE,
} from "../lib/rate_limits";
import { normalizeStoreCategory } from "../lib/store_artifacts";
import { moderateStoreListingTextOrThrow } from "../lib/text_moderation";

type StorePublishResult = Infer<typeof store_publish_result_validator>;
type StoreReleaseDiffRef = Infer<typeof store_release_diff_ref_validator>;
type StoreReleaseGitArtifact = Infer<
  typeof store_release_git_artifact_validator
>;

const PACKAGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const MAX_RELEASE_NOTES_LENGTH = 4_000;
const MAX_BLUEPRINT_LENGTH = 750_000;
const MAX_DISPLAY_NAME = 120;
const MAX_DESCRIPTION = 4_000;
const MAX_SUMMARY = 500;
const MAX_ICON_URL = 2_048;
const MAX_AUTHORED_AT_COMMIT = 80;
const MAX_COMMITS_PER_RELEASE = 32;
const MAX_COMMIT_HASH_LENGTH = 80;
const MAX_COMMIT_SUBJECT_LENGTH = 500;
// Upload ceiling for the R2-backed diff blobs (squashed diff + per-commit
// bundle). Diffs are never stored inline on the release document.
const MAX_RELEASE_DIFF_UPLOAD_LENGTH = 5 * 1024 * 1024;
const MAX_GIT_ARTIFACT_OBJECTS = 20_000;
const MAX_GIT_OBJECT_BYTES = 25 * 1024 * 1024;

// ── arg validators ───────────────────────────────────────────────────────────

// Where a release is headed. "store" (default) lands in the manual
// approval queue and goes live in the public store once a Stella team
// member approves it. "circle" is the trusted-circle share path: the
// package stays unlisted (link-only, never listed in the store) and the
// release is live immediately — recipients are people the author picked
// in a community or DM, so there is no review gate.
export const store_release_audience_validator = v.union(
  v.literal("store"),
  v.literal("circle"),
);

const create_release_args_validator = {
  packageId: v.string(),
  audience: v.optional(store_release_audience_validator),
  releaseNotes: v.optional(v.string()),
  manifest: store_release_manifest_validator,
  blueprintMarkdown: v.string(),
  // Per-commit metadata only; diffs are uploaded to R2 by the client and
  // referenced via `commitsDiffRef`.
  commits: v.optional(v.array(store_release_commit_meta_validator)),
  commitsDiffRef: v.optional(store_release_diff_ref_validator),
  gitArtifact: v.optional(store_release_git_artifact_validator),
  // Squashed diff is always uploaded to R2 by the client; only the ref is sent.
  diffRef: v.optional(store_release_diff_ref_validator),
  iconUrl: v.optional(v.string()),
};

const create_first_release_args_validator = {
  ...create_release_args_validator,
  category: v.optional(store_package_category_validator),
  displayName: v.string(),
  description: v.optional(v.string()),
};

// ── helpers ──────────────────────────────────────────────────────────────────

const resolveCallerAuthor = async (
  ctx: {
    runMutation: (
      fn: typeof internal.social.profiles.ensureProfileForOwnerInternal,
      args: { ownerId: string },
    ) => Promise<{
      username: string;
      badge?: "verified" | "partner";
    }>;
  },
  ownerId: string,
): Promise<{
  authorUsername?: string;
  authorBadge?: "verified" | "partner";
}> => {
  try {
    const profile = await ctx.runMutation(
      internal.social.profiles.ensureProfileForOwnerInternal,
      { ownerId },
    );
    const username = profile.username.trim().toLowerCase();
    return {
      ...(username ? { authorUsername: username } : {}),
      ...(profile.badge ? { authorBadge: profile.badge } : {}),
    };
  } catch {
    return {};
  }
};

const buildPackageSearchText = (
  displayName: string,
  description: string,
): string => `${displayName} ${description}`.toLowerCase();

const normalizePackageId = (value: string) => {
  const normalized = value.trim().toLowerCase();
  requireBoundedString(normalized, "packageId", 64);
  if (!PACKAGE_ID_PATTERN.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "Package ID must use lowercase letters, numbers, hyphens, or underscores.",
    });
  }
  return normalized;
};

const normalizeRequiredText = (
  value: string,
  fieldName: string,
  maxLength: number,
) => {
  const normalized = value.trim();
  if (!normalized) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} is required`,
    });
  }
  requireBoundedString(normalized, fieldName, maxLength);
  return normalized;
};

const normalizeOptionalText = (
  value: string | undefined,
  fieldName: string,
  maxLength: number,
) => {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  requireBoundedString(normalized, fieldName, maxLength);
  return normalized;
};

const normalizeBlueprintMarkdown = (value: string) => {
  if (value.length === 0) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "blueprintMarkdown is required",
    });
  }
  requireBoundedString(value, "blueprintMarkdown", MAX_BLUEPRINT_LENGTH);
  return value;
};

const normalizeCommits = (
  commits: ReadonlyArray<{ hash: string; subject: string }> | undefined,
): Array<{ hash: string; subject: string }> | undefined => {
  if (!commits || commits.length === 0) return undefined;
  if (commits.length > MAX_COMMITS_PER_RELEASE) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Releases may include at most ${MAX_COMMITS_PER_RELEASE} reference commits.`,
    });
  }
  const seenHashes = new Set<string>();
  const normalized: Array<{ hash: string; subject: string }> = [];
  for (const commit of commits) {
    const hash = commit.hash.trim();
    requireBoundedString(hash, "commit.hash", MAX_COMMIT_HASH_LENGTH);
    if (!hash) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "commit.hash is required",
      });
    }
    if (seenHashes.has(hash)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Duplicate reference commit ${hash}`,
      });
    }
    seenHashes.add(hash);
    const subject = commit.subject.trim();
    requireBoundedString(subject, "commit.subject", MAX_COMMIT_SUBJECT_LENGTH);
    normalized.push({ hash, subject });
  }
  return normalized;
};

const normalizeStoreArtifactPath = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Unsafe Store artifact path: ${value}`,
    });
  }
  const segments = normalized.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Unsafe Store artifact path: ${value}`,
    });
  }
  return segments.join("/");
};

const normalizeGitSha = (value: string, fieldName: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} must be a 40-character Git SHA.`,
    });
  }
  return normalized;
};

const normalizeGitArtifact = (
  gitArtifact: StoreReleaseGitArtifact | undefined,
): StoreReleaseGitArtifact | undefined => {
  if (!gitArtifact) return undefined;
  const baseCommit = normalizeGitSha(
    gitArtifact.baseCommit,
    "gitArtifact.baseCommit",
  );
  const featureCommit = normalizeGitSha(
    gitArtifact.featureCommit,
    "gitArtifact.featureCommit",
  );
  if (gitArtifact.objects.length === 0) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Git artifacts must include at least one object.",
    });
  }
  if (gitArtifact.objects.length > MAX_GIT_ARTIFACT_OBJECTS) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Git artifacts may include at most ${MAX_GIT_ARTIFACT_OBJECTS} objects.`,
    });
  }
  const seenObjects = new Set<string>();
  const objects = gitArtifact.objects.map((object, index) => {
    const sha = normalizeGitSha(
      object.sha,
      `gitArtifact.objects[${index}].sha`,
    );
    if (seenObjects.has(sha)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Duplicate Git object ${sha}.`,
      });
    }
    seenObjects.add(sha);
    if (
      !Number.isInteger(object.sizeBytes) ||
      object.sizeBytes <= 0 ||
      object.sizeBytes > MAX_GIT_OBJECT_BYTES
    ) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Git object ${sha} has an invalid size.`,
      });
    }
    return {
      sha,
      type: object.type,
      sizeBytes: object.sizeBytes,
    };
  });
  if (!seenObjects.has(featureCommit)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Git artifacts must include the feature commit object.",
    });
  }
  const security = gitArtifact.security
    ? {
        redactedPaths: gitArtifact.security.redactedPaths
          .map((path) => normalizeStoreArtifactPath(path))
          .slice(0, 500),
        omittedPaths: gitArtifact.security.omittedPaths
          .map((path) => normalizeStoreArtifactPath(path))
          .slice(0, 500),
        warnings: gitArtifact.security.warnings
          .map((warning) => warning.trim())
          .filter(Boolean)
          .map((warning) => warning.slice(0, 500))
          .slice(0, 100),
      }
    : undefined;
  return {
    kind: "git-object-artifact" as const,
    schemaVersion: 1 as const,
    baseCommit,
    featureCommit,
    objects,
    ...(security ? { security } : {}),
  };
};

const normalizeDiffRef = (
  diffRef: StoreReleaseDiffRef | undefined,
): StoreReleaseDiffRef | undefined => {
  if (!diffRef) return undefined;
  requireBoundedString(diffRef.r2Key, "diffRef.r2Key", 1000);
  requireBoundedString(diffRef.sha256, "diffRef.sha256", 80);
  if (!/^sha256:[0-9a-f]{64}$/.test(diffRef.sha256)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "diffRef.sha256 must be a sha256 digest.",
    });
  }
  if (
    !Number.isInteger(diffRef.sizeBytes) ||
    diffRef.sizeBytes <= 0 ||
    diffRef.sizeBytes > MAX_RELEASE_DIFF_UPLOAD_LENGTH
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "diffRef.sizeBytes must be a positive uploaded diff size.",
    });
  }
  return diffRef;
};

const requireSourceBackedRelease = (args: {
  gitArtifact: StoreReleaseGitArtifact | undefined;
  diffRef: StoreReleaseDiffRef | undefined;
}): StoreReleaseDiffRef => {
  if (args.gitArtifact && args.diffRef) return args.diffRef;
  throw new ConvexError({
    code: "INVALID_ARGUMENT",
    message: "Store releases must include a git artifact and squashed diff.",
  });
};

// `commits` (metadata) and `commitsDiffRef` (the R2 diff bundle) are written
// as a pair: the inline list tells us which commits exist; the ref carries
// their diffs. Reject a release that supplies one without the other.
const requireCommitsStorage = (
  commits: ReadonlyArray<unknown> | undefined,
  commitsDiffRef: StoreReleaseDiffRef | undefined,
) => {
  if (Boolean(commits?.length) !== Boolean(commitsDiffRef)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "commits and commitsDiffRef must be provided together.",
    });
  }
};

const cleanupUploadedDiffRef = async (
  ctx: {
    runAction: (
      fn: typeof internal.data.store_git_artifacts.deleteDiffRef,
      args: {
        ownerId: string;
        packageId: string;
        ref: StoreReleaseDiffRef;
      },
    ) => Promise<unknown>;
  },
  args: {
    ownerId: string;
    packageId: string;
    diffRef?: StoreReleaseDiffRef;
    commitsDiffRef?: StoreReleaseDiffRef;
  },
): Promise<void> => {
  const refs = [args.diffRef, args.commitsDiffRef].filter(
    (ref): ref is StoreReleaseDiffRef => Boolean(ref),
  );
  for (const ref of refs) {
    await ctx
      .runAction(internal.data.store_git_artifacts.deleteDiffRef, {
        ownerId: args.ownerId,
        packageId: args.packageId,
        ref,
      })
      .catch((error) => {
        console.warn(
          "[store-packages] failed to clean rejected diff upload:",
          error,
        );
      });
  }
};

const normalizeReleaseNumber = (value: number) => {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "releaseNumber must be a positive integer",
    });
  }
  return value;
};

const normalizeManifest = (manifest: {
  category?:
    | "apps-games"
    | "productivity"
    | "customization"
    | "skills-agents"
    | "integrations"
    | "other";
  summary?: string;
  iconUrl?: string;
  authoredAtCommit?: string;
}) => {
  const summary = normalizeOptionalText(
    manifest.summary,
    "manifest.summary",
    MAX_SUMMARY,
  );
  const iconUrl = normalizeOptionalText(
    manifest.iconUrl,
    "manifest.iconUrl",
    MAX_ICON_URL,
  );
  const authoredAtCommit = normalizeOptionalText(
    manifest.authoredAtCommit,
    "manifest.authoredAtCommit",
    MAX_AUTHORED_AT_COMMIT,
  );
  return {
    ...(manifest.category
      ? { category: normalizeStoreCategory(manifest.category) }
      : {}),
    ...(summary ? { summary } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(authoredAtCommit ? { authoredAtCommit } : {}),
  };
};

// ── package lookups ──────────────────────────────────────────────────────────

const getOwnedPackageByPackageId = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  packageId: string,
) => {
  return await ctx.db
    .query("store_packages")
    .withIndex("by_ownerId_and_packageId", (q) =>
      q.eq("ownerId", ownerId).eq("packageId", packageId),
    )
    .unique();
};

const getPackageByPackageId = async (
  ctx: QueryCtx | MutationCtx,
  packageId: string,
) => {
  return await ctx.db
    .query("store_packages")
    .withIndex("by_packageId", (q) => q.eq("packageId", packageId))
    .unique();
};

const getReleaseByPackageIdAndNumber = async (
  ctx: QueryCtx | MutationCtx,
  packageId: string,
  releaseNumber: number,
) => {
  return await ctx.db
    .query("store_package_releases")
    .withIndex("by_packageId_and_releaseNumber", (q) =>
      q.eq("packageId", packageId).eq("releaseNumber", releaseNumber),
    )
    .unique();
};

// ── internal queries (used by runtime Store operations) ──────────────────────

export const listPackagesForOwnerInternal = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("store_packages")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .order("desc")
      .take(200);
  },
});

export const getPackageByPackageIdInternal = internalQuery({
  args: { ownerId: v.string(), packageId: v.string() },
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    return await getOwnedPackageByPackageId(
      ctx,
      args.ownerId,
      normalizedPackageId,
    );
  },
});

export const getAnyPackageByPackageIdInternal = internalQuery({
  args: { packageId: v.string() },
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    return await getPackageByPackageId(ctx, normalizedPackageId);
  },
});

export const listReleasesForPackageInternal = internalQuery({
  args: { ownerId: v.string(), packageId: v.string() },
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    const pkg = await getOwnedPackageByPackageId(
      ctx,
      args.ownerId,
      normalizedPackageId,
    );
    if (!pkg) return [];
    return await ctx.db
      .query("store_package_releases")
      .withIndex("by_packageId_and_releaseNumber", (q) =>
        q.eq("packageId", normalizedPackageId),
      )
      .order("desc")
      .take(200);
  },
});

export const getReleaseByPackageIdAndNumberInternal = internalQuery({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
    releaseNumber: v.number(),
  },
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    const pkg = await getOwnedPackageByPackageId(
      ctx,
      args.ownerId,
      normalizedPackageId,
    );
    if (!pkg) return null;
    return await getReleaseByPackageIdAndNumber(
      ctx,
      normalizedPackageId,
      normalizeReleaseNumber(args.releaseNumber),
    );
  },
});

export const getReadableReleaseForArtifactInternal = internalQuery({
  args: {
    packageId: v.string(),
    releaseNumber: v.number(),
    callerOwnerId: v.optional(v.string()),
  },
  returns: v.union(store_package_release_validator, v.null()),
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    const releaseNumber = normalizeReleaseNumber(args.releaseNumber);
    const pkg = await getPackageByPackageId(ctx, normalizedPackageId);
    if (!pkg) return null;
    const isOwner =
      args.callerOwnerId !== undefined && pkg.ownerId === args.callerOwnerId;
    if (!isDirectLinkAccessible(pkg.visibility) && !isOwner) {
      return null;
    }
    const release = await getReleaseByPackageIdAndNumber(
      ctx,
      normalizedPackageId,
      releaseNumber,
    );
    if (!release) return null;
    // Pending/rejected releases are only installable by their owner.
    if (!isOwner && !isReleaseApproved(release)) return null;
    return release;
  },
});

// ── internal release writers ─────────────────────────────────────────────────

export const createFirstReleaseRecord = internalMutation({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
    audience: v.optional(store_release_audience_validator),
    category: v.optional(store_package_category_validator),
    displayName: v.string(),
    description: v.optional(v.string()),
    releaseNotes: v.optional(v.string()),
    manifest: store_release_manifest_validator,
    blueprintMarkdown: v.string(),
    commits: v.optional(v.array(store_release_commit_meta_validator)),
    commitsDiffRef: v.optional(store_release_diff_ref_validator),
    gitArtifact: v.optional(store_release_git_artifact_validator),
    diffRef: v.optional(store_release_diff_ref_validator),
    iconUrl: v.optional(v.string()),
    authorUsername: v.optional(v.string()),
    authorBadge: v.optional(socialBadgeValidator),
    advisoryReview: v.optional(store_release_advisory_review_validator),
  },
  handler: async (ctx, args) => {
    const existing = await getPackageByPackageId(ctx, args.packageId);
    if (existing) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "That package ID is already in use.",
      });
    }

    const now = Date.now();
    const category = normalizeStoreCategory(
      args.category ?? args.manifest.category,
    );
    const description = args.description ?? "";
    const isCircleRelease = args.audience === "circle";
    // Store path: the package is created "private" and flips to "public"
    // when the Stella team approves the first release. Until then it is
    // only visible to its owner.
    // Circle path: the package is created "unlisted" (direct-link only,
    // never listed in the store) and the release goes live immediately —
    // the audience is a trusted circle the author picked, not the public.
    const packageRef = await ctx.db.insert("store_packages", {
      ownerId: args.ownerId,
      packageId: args.packageId,
      category,
      displayName: args.displayName,
      ...(description ? { description } : {}),
      searchText: buildPackageSearchText(args.displayName, description),
      latestReleaseNumber: isCircleRelease ? 1 : 0,
      visibility: isCircleRelease ? "unlisted" : "private",
      createdAt: now,
      updatedAt: now,
      ...(args.iconUrl ? { iconUrl: args.iconUrl } : {}),
      ...(args.authorUsername ? { authorUsername: args.authorUsername } : {}),
      ...(args.authorBadge ? { authorBadge: args.authorBadge } : {}),
    });

    const releaseRef = await ctx.db.insert("store_package_releases", {
      ownerId: args.ownerId,
      packageRef,
      packageId: args.packageId,
      releaseNumber: 1,
      releaseNotes: args.releaseNotes,
      manifest: args.manifest,
      blueprintMarkdown: args.blueprintMarkdown,
      ...(args.commits && args.commits.length > 0
        ? { commits: args.commits }
        : {}),
      ...(args.commitsDiffRef ? { commitsDiffRef: args.commitsDiffRef } : {}),
      ...(args.gitArtifact ? { gitArtifact: args.gitArtifact } : {}),
      ...(args.diffRef ? { diffRef: args.diffRef } : {}),
      createdAt: now,
      reviewStatus: isCircleRelease ? "approved" : "pending",
      ...(isCircleRelease ? { reviewedAt: now } : {}),
      ...(args.advisoryReview ? { advisoryReview: args.advisoryReview } : {}),
    });

    if (isCircleRelease) {
      // Circle releases are live at creation, so the published pointers
      // advance here instead of at approval time.
      await ctx.db.patch(packageRef, { latestReleaseId: releaseRef });
    }

    // Store path: `latestReleaseNumber`/`latestReleaseId` stay at their
    // zero state until approval — they are the "published" pointers.
    const pkg = await ctx.db.get(packageRef);
    const release = await ctx.db.get(releaseRef);
    if (!pkg || !release) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to load created store package release records",
      });
    }

    return { package: pkg, release };
  },
});

export const createUpdateReleaseRecord = internalMutation({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
    audience: v.optional(store_release_audience_validator),
    releaseNotes: v.optional(v.string()),
    manifest: store_release_manifest_validator,
    blueprintMarkdown: v.string(),
    commits: v.optional(v.array(store_release_commit_meta_validator)),
    commitsDiffRef: v.optional(store_release_diff_ref_validator),
    gitArtifact: v.optional(store_release_git_artifact_validator),
    diffRef: v.optional(store_release_diff_ref_validator),
    iconUrl: v.optional(v.string()),
    authorUsername: v.optional(v.string()),
    authorBadge: v.optional(socialBadgeValidator),
    advisoryReview: v.optional(store_release_advisory_review_validator),
  },
  handler: async (ctx, args) => {
    const pkg = await getOwnedPackageByPackageId(
      ctx,
      args.ownerId,
      args.packageId,
    );
    if (!pkg) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Store package not found",
      });
    }

    const isCircleRelease = args.audience === "circle";
    if (isCircleRelease && effectiveVisibility(pkg.visibility) !== "unlisted") {
      // Instant (unreviewed) updates are only allowed for packages that
      // live entirely on the trusted-circle path. Anything the public
      // store serves (or that is queued for it) must go through review.
      throw new ConvexError({
        code: "FORBIDDEN",
        message:
          "This add-on is in the public store, so updates need Stella team review. Share the update to the Store instead.",
      });
    }

    // Number after the highest EXISTING release (pending ones included),
    // not `latestReleaseNumber + 1` — the latest pointer only advances on
    // approval, so stacked pending submissions must not collide.
    const newestRelease = await ctx.db
      .query("store_package_releases")
      .withIndex("by_packageRef_and_releaseNumber", (q) =>
        q.eq("packageRef", pkg._id),
      )
      .order("desc")
      .first();
    const nextReleaseNumber =
      Math.max(pkg.latestReleaseNumber, newestRelease?.releaseNumber ?? 0) + 1;
    const now = Date.now();
    const releaseRef = await ctx.db.insert("store_package_releases", {
      ownerId: args.ownerId,
      packageRef: pkg._id,
      packageId: args.packageId,
      releaseNumber: nextReleaseNumber,
      releaseNotes: args.releaseNotes,
      manifest: args.manifest,
      blueprintMarkdown: args.blueprintMarkdown,
      ...(args.commits && args.commits.length > 0
        ? { commits: args.commits }
        : {}),
      ...(args.commitsDiffRef ? { commitsDiffRef: args.commitsDiffRef } : {}),
      ...(args.gitArtifact ? { gitArtifact: args.gitArtifact } : {}),
      ...(args.diffRef ? { diffRef: args.diffRef } : {}),
      createdAt: now,
      reviewStatus: isCircleRelease ? "approved" : "pending",
      ...(isCircleRelease ? { reviewedAt: now } : {}),
      ...(args.advisoryReview ? { advisoryReview: args.advisoryReview } : {}),
    });

    if (isCircleRelease) {
      // Circle releases go live immediately: advance the published
      // pointers the same way `data/store_admin.approveSubmission` does.
      await ctx.db.patch(pkg._id, {
        latestReleaseNumber: nextReleaseNumber,
        latestReleaseId: releaseRef,
        updatedAt: now,
        ...(args.manifest.iconUrl && !pkg.iconUrl
          ? { iconUrl: args.manifest.iconUrl }
          : {}),
      });
    }

    // Store path: the package's published surface (latest pointers,
    // updatedAt, icon/author refresh) is intentionally NOT touched here —
    // that happens when the Stella team approves the release in
    // `data/store_admin`. Installers keep seeing the current approved
    // release until then.

    const updatedPackage = await ctx.db.get(pkg._id);
    const release = await ctx.db.get(releaseRef);
    if (!updatedPackage || !release) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to load updated store package release records",
      });
    }

    return { package: updatedPackage, release };
  },
});

// ── owner-scoped reads ───────────────────────────────────────────────────────

export const listPackages = query({
  args: {},
  returns: v.array(store_package_validator),
  handler: async (ctx) => {
    const ownerId = await getUserIdOrNull(ctx);
    if (!ownerId) return [];
    return await ctx.db
      .query("store_packages")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(200);
  },
});

// ── public discovery ─────────────────────────────────────────────────────────

const PUBLIC_BROWSE_PAGE_SIZE = 40;
const PUBLIC_SEARCH_MAX_RESULTS = 60;

const effectiveVisibility = (
  visibility: "public" | "unlisted" | "private" | undefined,
): "public" | "unlisted" | "private" => visibility ?? "public";

const isDirectLinkAccessible = (
  visibility: "public" | "unlisted" | "private" | undefined,
): boolean => {
  const tier = effectiveVisibility(visibility);
  return tier === "public" || tier === "unlisted";
};

// Legacy releases (no `reviewStatus`) predate the manual approval queue
// and were published live, so they count as approved.
const isReleaseApproved = (release: {
  reviewStatus?: "pending" | "approved" | "rejected";
}): boolean =>
  release.reviewStatus === undefined || release.reviewStatus === "approved";

export const listPublicPackages = query({
  args: {
    category: v.optional(store_package_category_validator),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(store_package_validator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(
        v.literal("SplitRecommended"),
        v.literal("SplitRequired"),
        v.null(),
      ),
    ),
  }),
  handler: async (ctx, args) => {
    const numItems = Math.min(
      Math.max(args.paginationOpts.numItems, 1),
      PUBLIC_BROWSE_PAGE_SIZE,
    );
    // Visibility is part of the index range so non-public rows are never
    // scanned. Legacy rows with `visibility: undefined` are handled by
    // `backfillPackageVisibility` (run once after deploy), matching how
    // `listNewPublicPackages` and the promoted list already query.
    const indexed = args.category
      ? ctx.db
          .query("store_packages")
          .withIndex("by_visibility_and_category_and_updatedAt", (q) =>
            q.eq("visibility", "public").eq("category", args.category!),
          )
      : ctx.db
          .query("store_packages")
          .withIndex("by_visibility_and_updatedAt", (q) =>
            q.eq("visibility", "public"),
          );
    return await indexed.order("desc").paginate({
      cursor: args.paginationOpts.cursor,
      numItems,
    });
  },
});

/**
 * One-shot backfill: stamps `visibility: "public"` onto legacy rows that
 * predate the field (its absence has always meant public). Run with
 * `npx convex run data/store_packages:backfillPackageVisibility` after
 * deploying the index switch in `listPublicPackages`.
 */
export const backfillPackageVisibility = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("store_packages")
      .paginate({ cursor: args.cursor ?? null, numItems: 100 });
    for (const pkg of page.page) {
      if (pkg.visibility === undefined) {
        await ctx.db.patch(pkg._id, { visibility: "public" });
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.data.store_packages.backfillPackageVisibility,
        { cursor: page.continueCursor },
      );
    }
    return null;
  },
});

/**
 * "New on the Store" — public packages ordered by creation time
 * descending. Distinct from `listPublicPackages` (which orders by
 * `updatedAt` and surfaces re-releases as recent activity), so a "New"
 * section actually shows fresh packages rather than older packages
 * that just pushed an update.
 */
export const listNewPublicPackages = query({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.array(store_package_validator),
  handler: async (ctx, args) => {
    const limit = Math.min(
      Math.max(args.limit ?? 12, 1),
      PUBLIC_BROWSE_PAGE_SIZE,
    );
    // Scan a bit more than the requested limit so dropped non-public
    // rows don't shrink the result below the cap. We over-fetch by
    // 2x with a floor so a small handful of unlisted/private rows
    // mixed into the head don't visibly thin the New section.
    return (
      await ctx.db
        .query("store_packages")
        .withIndex("by_visibility_and_createdAt", (q) =>
          q.eq("visibility", "public"),
        )
        .order("desc")
        .take(Math.max(limit * 2, 24))
    )
      .filter((pkg) => effectiveVisibility(pkg.visibility) === "public")
      .slice(0, limit);
  },
});

/**
 * Active promoted listings, most recently boosted first.
 *
 * No UI surface uses this yet — exposing it now so the ad surface
 * (and the eventual "Sponsored" rail in the For You feed) can ship
 * without backend churn. `promotedUntil` is filtered client-side
 * since Convex query ranges across two fields would need a more
 * specific compound index.
 */
export const listPromotedPublicPackages = query({
  args: {
    nowMs: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.array(store_package_validator),
  handler: async (ctx, args) => {
    const limit = Math.min(
      Math.max(args.limit ?? 6, 1),
      PUBLIC_BROWSE_PAGE_SIZE,
    );
    const rows = await ctx.db
      .query("store_packages")
      .withIndex("by_visibility_and_promoted_and_promotedAt", (q) =>
        q.eq("visibility", "public").eq("promoted", true),
      )
      .order("desc")
      .take(Math.max(limit * 2, 12));
    return rows
      .filter((pkg) => {
        if (effectiveVisibility(pkg.visibility) !== "public") return false;
        if (pkg.promoted !== true) return false;
        if (pkg.promotedUntil !== undefined && pkg.promotedUntil < args.nowMs) {
          return false;
        }
        return true;
      })
      .slice(0, limit);
  },
});

export const getPublicPackage = query({
  args: { packageId: v.string() },
  returns: v.union(store_package_validator, v.null()),
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    const record = await getPackageByPackageId(ctx, normalizedPackageId);
    if (!record) return null;
    if (isDirectLinkAccessible(record.visibility)) return record;
    const callerId = await ctx.auth.getUserIdentity();
    if (callerId && record.ownerId === callerId.tokenIdentifier) {
      return record;
    }
    return null;
  },
});

export const getPublicPackagesByIds = query({
  args: { packageIds: v.array(v.string()) },
  returns: v.array(store_package_validator),
  handler: async (ctx, args) => {
    if (args.packageIds.length === 0) return [];
    const uniqueIds = Array.from(
      new Set(args.packageIds.map((id) => normalizePackageId(id))),
    ).slice(0, 200);
    const records = await Promise.all(
      uniqueIds.map((id) => getPackageByPackageId(ctx, id)),
    );
    const callerIdentity = await ctx.auth.getUserIdentity();
    const callerOwnerId = callerIdentity?.tokenIdentifier;
    return records
      .filter((record): record is NonNullable<typeof record> => record !== null)
      .filter(
        (record) =>
          isDirectLinkAccessible(record.visibility) ||
          (callerOwnerId !== undefined && record.ownerId === callerOwnerId),
      );
  },
});

export const listPublicReleases = query({
  args: { packageId: v.string() },
  returns: v.array(store_package_release_validator),
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    const pkg = await getPackageByPackageId(ctx, normalizedPackageId);
    if (!pkg) return [];
    const callerId = await ctx.auth.getUserIdentity();
    const isOwner = callerId?.tokenIdentifier === pkg.ownerId;
    if (!isDirectLinkAccessible(pkg.visibility) && !isOwner) {
      return [];
    }
    const releases = await ctx.db
      .query("store_package_releases")
      .withIndex("by_packageId_and_releaseNumber", (q) =>
        q.eq("packageId", normalizedPackageId),
      )
      .order("desc")
      .take(200);
    // Pending/rejected releases stay owner-only until approved.
    return isOwner ? releases : releases.filter(isReleaseApproved);
  },
});

export const getPublicRelease = query({
  args: { packageId: v.string(), releaseNumber: v.number() },
  returns: v.union(store_package_release_validator, v.null()),
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    const releaseNumber = normalizeReleaseNumber(args.releaseNumber);
    const pkg = await getPackageByPackageId(ctx, normalizedPackageId);
    if (!pkg) return null;
    const callerId = await ctx.auth.getUserIdentity();
    const isOwner = callerId?.tokenIdentifier === pkg.ownerId;
    if (!isDirectLinkAccessible(pkg.visibility) && !isOwner) {
      return null;
    }
    const release = await getReleaseByPackageIdAndNumber(
      ctx,
      normalizedPackageId,
      releaseNumber,
    );
    if (!release) return null;
    // Pending/rejected releases stay owner-only until approved.
    if (!isOwner && !isReleaseApproved(release)) return null;
    return release;
  },
});

export const searchPublicPackages = query({
  args: {
    query: v.string(),
    category: v.optional(store_package_category_validator),
  },
  returns: v.array(store_package_validator),
  handler: async (ctx, args) => {
    const needle = args.query.trim().toLowerCase();
    if (!needle) return [];
    return (
      await ctx.db
        .query("store_packages")
        .withSearchIndex("search_text", (q) => {
          let base = q.search("searchText", needle);
          base = base.eq("visibility", "public");
          return args.category ? base.eq("category", args.category) : base;
        })
        .take(PUBLIC_SEARCH_MAX_RESULTS)
    ).filter((pkg) => effectiveVisibility(pkg.visibility) === "public");
  },
});

export const listPackagesByAuthorUsername = query({
  args: { username: v.string() },
  returns: v.array(store_package_validator),
  handler: async (ctx, args) => {
    const username = args.username.trim().toLowerCase();
    if (!username) return [];
    const profile = await ctx.db
      .query("social_profiles")
      .withIndex("by_username", (q) => q.eq("username", username))
      .unique();
    if (!profile) return [];
    const owned = await ctx.db
      .query("store_packages")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", profile.ownerId),
      )
      .order("desc")
      .take(200);
    return owned.filter(
      (pkg) => effectiveVisibility(pkg.visibility) === "public",
    );
  },
});

export const listMyPackages = query({
  args: {},
  returns: v.array(store_package_validator),
  handler: async (ctx) => {
    const ownerId = await getUserIdOrNull(ctx);
    if (!ownerId) return [];
    return await ctx.db
      .query("store_packages")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(200);
  },
});

export const setPackageVisibility = mutation({
  args: {
    packageId: v.string(),
    visibility: store_package_visibility_validator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const normalizedPackageId = normalizePackageId(args.packageId);
    const pkg = await getOwnedPackageByPackageId(
      ctx,
      ownerId,
      normalizedPackageId,
    );
    if (!pkg) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Add-on not found",
      });
    }
    if (effectiveVisibility(pkg.visibility) === args.visibility) {
      return null;
    }
    // A package with no approved release can't be made discoverable —
    // that would bypass the manual review queue. `latestReleaseNumber`
    // only advances when a release is approved (legacy packages are >= 1).
    if (args.visibility !== "private" && pkg.latestReleaseNumber < 1) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message:
          "This add-on is awaiting review by the Stella team and can't be made public yet.",
      });
    }
    await ctx.db.patch(pkg._id, {
      visibility: args.visibility,
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ── submitter-facing review status ──────────────────────────────────────────

const store_submission_status_validator = v.object({
  releaseId: v.id("store_package_releases"),
  packageId: v.string(),
  displayName: v.string(),
  iconUrl: v.optional(v.string()),
  releaseNumber: v.number(),
  isFirstRelease: v.boolean(),
  status: store_release_review_status_validator,
  rejectionReason: v.optional(v.string()),
  submittedAt: v.number(),
  reviewedAt: v.optional(v.number()),
});

/**
 * The caller's store submissions (releases that went through the manual
 * review queue), newest first. Legacy releases published before the
 * queue existed are omitted — they were never "submissions".
 */
export const listMySubmissions = query({
  args: {},
  returns: v.array(store_submission_status_validator),
  handler: async (ctx) => {
    const ownerId = await getUserIdOrNull(ctx);
    if (!ownerId) return [];
    const releases = await ctx.db
      .query("store_package_releases")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(100);
    const packageCache = new Map<
      string,
      { displayName: string; iconUrl?: string } | null
    >();
    const results: Array<Infer<typeof store_submission_status_validator>> = [];
    for (const release of releases) {
      if (release.reviewStatus === undefined) continue;
      let pkg = packageCache.get(release.packageId);
      if (pkg === undefined) {
        const record = await ctx.db.get(release.packageRef);
        pkg = record
          ? {
              displayName: record.displayName,
              ...(record.iconUrl ? { iconUrl: record.iconUrl } : {}),
            }
          : null;
        packageCache.set(release.packageId, pkg);
      }
      if (!pkg) continue;
      results.push({
        releaseId: release._id,
        packageId: release.packageId,
        displayName: pkg.displayName,
        ...(pkg.iconUrl ? { iconUrl: pkg.iconUrl } : {}),
        releaseNumber: release.releaseNumber,
        isFirstRelease: release.releaseNumber === 1,
        status: release.reviewStatus,
        ...(release.reviewRejectionReason
          ? { rejectionReason: release.reviewRejectionReason }
          : {}),
        submittedAt: release.createdAt,
        ...(release.reviewedAt !== undefined
          ? { reviewedAt: release.reviewedAt }
          : {}),
      });
    }
    return results;
  },
});

export const deletePackage = mutation({
  args: { packageId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const normalizedPackageId = normalizePackageId(args.packageId);
    const pkg = await getOwnedPackageByPackageId(
      ctx,
      ownerId,
      normalizedPackageId,
    );
    if (!pkg) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Add-on not found",
      });
    }
    await ctx.db.delete(pkg._id);
    await ctx.scheduler.runAfter(
      0,
      internal.data.store_packages.deletePackageReleasesBatch,
      { packageRef: pkg._id },
    );
    return null;
  },
});

// Release documents carry blueprints up to MAX_BLUEPRINT_LENGTH, so a small
// batch keeps each delete transaction comfortably under the read limit.
const DELETE_RELEASES_BATCH_SIZE = 8;

export const deletePackageReleasesBatch = internalMutation({
  args: { packageRef: v.id("store_packages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const releases = await ctx.db
      .query("store_package_releases")
      .withIndex("by_packageRef_and_releaseNumber", (q) =>
        q.eq("packageRef", args.packageRef),
      )
      .take(DELETE_RELEASES_BATCH_SIZE);
    await Promise.all(
      releases.map((release) =>
        ctx.db.delete("store_package_releases", release._id),
      ),
    );
    if (releases.length === DELETE_RELEASES_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.data.store_packages.deletePackageReleasesBatch,
        { packageRef: args.packageRef },
      );
    }
    return null;
  },
});

export const getPackage = query({
  args: { packageId: v.string() },
  returns: v.union(store_package_validator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = await getUserIdOrNull(ctx);
    if (!ownerId) return null;
    const normalizedPackageId = normalizePackageId(args.packageId);
    return await getOwnedPackageByPackageId(ctx, ownerId, normalizedPackageId);
  },
});

export const listReleases = query({
  args: { packageId: v.string() },
  returns: v.array(store_package_release_validator),
  handler: async (ctx, args) => {
    const ownerId = await getUserIdOrNull(ctx);
    if (!ownerId) return [];
    const normalizedPackageId = normalizePackageId(args.packageId);
    const pkg = await getOwnedPackageByPackageId(
      ctx,
      ownerId,
      normalizedPackageId,
    );
    if (!pkg) return [];
    return await ctx.db
      .query("store_package_releases")
      .withIndex("by_packageId_and_releaseNumber", (q) =>
        q.eq("packageId", normalizedPackageId),
      )
      .order("desc")
      .take(200);
  },
});

export const getRelease = query({
  args: { packageId: v.string(), releaseNumber: v.number() },
  returns: v.union(store_package_release_validator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = await getUserIdOrNull(ctx);
    if (!ownerId) return null;
    const normalizedPackageId = normalizePackageId(args.packageId);
    const releaseNumber = normalizeReleaseNumber(args.releaseNumber);
    const pkg = await getOwnedPackageByPackageId(
      ctx,
      ownerId,
      normalizedPackageId,
    );
    if (!pkg) return null;
    return await getReleaseByPackageIdAndNumber(
      ctx,
      normalizedPackageId,
      releaseNumber,
    );
  },
});

// ── install tracking ────────────────────────────────────────────────────────

/**
 * Increment the public install counter for a package. Called by the
 * desktop install flow after a blueprint install completes successfully.
 * Idempotent across retries within a short window via the standard rate
 * limiter; we don't dedupe per-user since the counter intentionally
 * tracks attempts, not unique installers.
 */
export const recordPackageInstall = mutation({
  args: { packageId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await getUserIdOrNull(ctx);
    await enforceMutationRateLimit(
      ctx,
      "store_record_install",
      ownerId ?? "anonymous",
      RATE_STANDARD,
    );
    const normalizedPackageId = normalizePackageId(args.packageId);
    const pkg = await getPackageByPackageId(ctx, normalizedPackageId);
    if (!pkg) return null;
    if (!isDirectLinkAccessible(pkg.visibility) && pkg.ownerId !== ownerId) {
      return null;
    }
    await ctx.db.patch(pkg._id, {
      installCount: (pkg.installCount ?? 0) + 1,
    });
    return null;
  },
});

// ── publish actions ──────────────────────────────────────────────────────────

export const createFirstRelease = action({
  args: create_first_release_args_validator,
  returns: store_publish_result_validator,
  handler: async (ctx, args): Promise<StorePublishResult> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    await enforceActionRateLimit(
      ctx,
      "store_package_create_first_release",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many store package releases. Please wait before publishing again.",
    );
    const packageId = normalizePackageId(args.packageId);
    const displayName = normalizeRequiredText(
      args.displayName,
      "displayName",
      MAX_DISPLAY_NAME,
    );
    const description = normalizeOptionalText(
      args.description,
      "description",
      MAX_DESCRIPTION,
    );
    const releaseNotes = normalizeOptionalText(
      args.releaseNotes,
      "releaseNotes",
      MAX_RELEASE_NOTES_LENGTH,
    );
    const manifest = normalizeManifest(args.manifest);
    const blueprintMarkdown = normalizeBlueprintMarkdown(
      args.blueprintMarkdown,
    );
    const gitArtifact = normalizeGitArtifact(args.gitArtifact);
    const diffRef = normalizeDiffRef(args.diffRef);
    const commitsDiffRef = normalizeDiffRef(args.commitsDiffRef);
    const squashedDiffRef = requireSourceBackedRelease({
      gitArtifact,
      diffRef,
    });
    const commits = normalizeCommits(args.commits);
    requireCommitsStorage(commits, commitsDiffRef);
    try {
      // User-authored display fields go through the cheap moderation
      // classifier before we hit the heavier security review or write
      // anything to the catalog. Synchronous fail-closed is fine here —
      // this is a one-shot deliberate publish, not a chat send.
      await moderateStoreListingTextOrThrow({
        displayName,
        ...(description ? { description } : {}),
      });
      const diffForReview = await ctx.runAction(
        internal.data.store_git_artifacts.validateDiffRef,
        {
          ownerId,
          packageId,
          ref: squashedDiffRef,
        },
      );
      const reviewCommits = commitsDiffRef
        ? await ctx.runAction(
            internal.data.store_git_artifacts.validateCommitsDiffRef,
            {
              ownerId,
              packageId,
              ref: commitsDiffRef,
            },
          )
        : gitArtifact && diffForReview
          ? [
              {
                hash: gitArtifact.featureCommit,
                subject: "Squashed Store feature diff",
                diff: diffForReview,
              },
            ]
          : undefined;
      // Advisory only — the release lands in the manual approval queue
      // regardless; this verdict is attached for the human reviewer.
      // Circle releases skip it: there is no reviewer to advise, and the
      // share is meant to be instant.
      const advisoryReview =
        args.audience === "circle"
          ? undefined
          : await runStoreReleaseReviewAdvisory(ctx, {
              ownerId,
              packageId,
              displayName,
              description: description ?? "",
              releaseSummary: releaseNotes,
              artifactBody: blueprintMarkdown,
              ...(reviewCommits ? { commits: reviewCommits } : {}),
            });

      const author = await resolveCallerAuthor(ctx, ownerId);
      const iconUrl =
        manifest.iconUrl ??
        (await generateStoreIconUrl({
          displayName,
          description: description ?? "",
          category: normalizeStoreCategory(args.category ?? manifest.category),
        }));
      const releaseManifest = {
        ...manifest,
        ...(iconUrl ? { iconUrl } : {}),
      };
      return await ctx.runMutation(
        internal.data.store_packages.createFirstReleaseRecord,
        {
          ownerId,
          packageId,
          ...(args.audience ? { audience: args.audience } : {}),
          displayName,
          ...(description ? { description } : {}),
          releaseNotes,
          manifest: releaseManifest,
          blueprintMarkdown,
          ...(commits ? { commits } : {}),
          ...(commitsDiffRef ? { commitsDiffRef } : {}),
          ...(gitArtifact ? { gitArtifact } : {}),
          ...(diffRef ? { diffRef } : {}),
          ...(args.category ? { category: args.category } : {}),
          ...(iconUrl ? { iconUrl } : {}),
          ...(author.authorUsername
            ? { authorUsername: author.authorUsername }
            : {}),
          ...(author.authorBadge ? { authorBadge: author.authorBadge } : {}),
          advisoryReview,
        },
      );
    } catch (error) {
      await cleanupUploadedDiffRef(ctx, {
        ownerId,
        packageId,
        ...(diffRef ? { diffRef } : {}),
        ...(commitsDiffRef ? { commitsDiffRef } : {}),
      });
      throw error;
    }
  },
});

export const createUpdateRelease = action({
  args: create_release_args_validator,
  returns: store_publish_result_validator,
  handler: async (ctx, args): Promise<StorePublishResult> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    await enforceActionRateLimit(
      ctx,
      "store_package_create_update_release",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many store package releases. Please wait before publishing again.",
    );
    const packageId = normalizePackageId(args.packageId);
    const releaseNotes = normalizeOptionalText(
      args.releaseNotes,
      "releaseNotes",
      MAX_RELEASE_NOTES_LENGTH,
    );
    const manifest = normalizeManifest(args.manifest);
    const blueprintMarkdown = normalizeBlueprintMarkdown(
      args.blueprintMarkdown,
    );
    const gitArtifact = normalizeGitArtifact(args.gitArtifact);
    const diffRef = normalizeDiffRef(args.diffRef);
    const commitsDiffRef = normalizeDiffRef(args.commitsDiffRef);
    const squashedDiffRef = requireSourceBackedRelease({
      gitArtifact,
      diffRef,
    });
    const commits = normalizeCommits(args.commits);
    requireCommitsStorage(commits, commitsDiffRef);
    try {
      const pkg: Awaited<ReturnType<typeof getOwnedPackageByPackageId>> =
        await ctx.runQuery(
          internal.data.store_packages.getPackageByPackageIdInternal,
          { ownerId, packageId },
        );
      if (!pkg) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "Store package not found",
        });
      }
      const diffForReview = await ctx.runAction(
        internal.data.store_git_artifacts.validateDiffRef,
        {
          ownerId,
          packageId,
          ref: squashedDiffRef,
        },
      );
      const reviewCommits = commitsDiffRef
        ? await ctx.runAction(
            internal.data.store_git_artifacts.validateCommitsDiffRef,
            {
              ownerId,
              packageId,
              ref: commitsDiffRef,
            },
          )
        : gitArtifact && diffForReview
          ? [
              {
                hash: gitArtifact.featureCommit,
                subject: "Squashed Store feature diff",
                diff: diffForReview,
              },
            ]
          : undefined;
      // Advisory only — the release lands in the manual approval queue
      // regardless; this verdict is attached for the human reviewer.
      // Circle releases skip it: there is no reviewer to advise, and the
      // share is meant to be instant.
      const advisoryReview =
        args.audience === "circle"
          ? undefined
          : await runStoreReleaseReviewAdvisory(ctx, {
              ownerId,
              packageId,
              displayName: pkg.displayName,
              description: pkg.description ?? "",
              releaseSummary: releaseNotes,
              artifactBody: blueprintMarkdown,
              ...(reviewCommits ? { commits: reviewCommits } : {}),
            });

      const author = await resolveCallerAuthor(ctx, ownerId);
      const iconUrl =
        manifest.iconUrl ??
        pkg.iconUrl ??
        (await generateStoreIconUrl({
          displayName: pkg.displayName,
          description: pkg.description ?? "",
          category: normalizeStoreCategory(pkg.category ?? manifest.category),
        }));
      const releaseManifest = {
        ...manifest,
        ...(iconUrl ? { iconUrl } : {}),
      };
      return await ctx.runMutation(
        internal.data.store_packages.createUpdateReleaseRecord,
        {
          ownerId,
          packageId,
          ...(args.audience ? { audience: args.audience } : {}),
          releaseNotes,
          manifest: releaseManifest,
          blueprintMarkdown,
          ...(commits ? { commits } : {}),
          ...(commitsDiffRef ? { commitsDiffRef } : {}),
          ...(gitArtifact ? { gitArtifact } : {}),
          ...(diffRef ? { diffRef } : {}),
          ...(iconUrl ? { iconUrl } : {}),
          ...(author.authorUsername
            ? { authorUsername: author.authorUsername }
            : {}),
          ...(author.authorBadge ? { authorBadge: author.authorBadge } : {}),
          advisoryReview,
        },
      );
    } catch (error) {
      await cleanupUploadedDiffRef(ctx, {
        ownerId,
        packageId,
        ...(diffRef ? { diffRef } : {}),
        ...(commitsDiffRef ? { commitsDiffRef } : {}),
      });
      throw error;
    }
  },
});
