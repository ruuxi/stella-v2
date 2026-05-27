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
  store_release_commit_validator,
  store_release_manifest_validator,
  store_release_source_pack_ref_validator,
  store_release_source_pack_validator,
} from "../schema/store";
import { socialBadgeValidator } from "../schema/social";
import { enforceStoreReleaseReviewOrThrow } from "../lib/store_release_reviews";
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
type StoreReleaseSourcePackRef = Infer<
  typeof store_release_source_pack_ref_validator
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
const MAX_COMMIT_DIFF_LENGTH = 200_000;
const MAX_COMMITS_TOTAL_LENGTH = 1_500_000;
const MAX_COMMIT_HASH_LENGTH = 80;
const MAX_COMMIT_SUBJECT_LENGTH = 500;
const MAX_SOURCE_PACK_INLINE_LENGTH = 650_000;
const MAX_SOURCE_PACK_UPLOAD_LENGTH = 10 * 1024 * 1024;
const MAX_SOURCE_PACK_CHANGE_SETS = 32;

// ── arg validators ───────────────────────────────────────────────────────────

const create_release_args_validator = {
  packageId: v.string(),
  releaseNotes: v.optional(v.string()),
  manifest: store_release_manifest_validator,
  blueprintMarkdown: v.string(),
  sourcePack: v.optional(store_release_source_pack_validator),
  sourcePackRef: v.optional(store_release_source_pack_ref_validator),
  commits: v.optional(v.array(store_release_commit_validator)),
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
  commits:
    | ReadonlyArray<{ hash: string; subject: string; diff: string }>
    | undefined,
): Array<{ hash: string; subject: string; diff: string }> | undefined => {
  if (!commits || commits.length === 0) return undefined;
  if (commits.length > MAX_COMMITS_PER_RELEASE) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Releases may include at most ${MAX_COMMITS_PER_RELEASE} reference commits.`,
    });
  }
  let totalLength = 0;
  const seenHashes = new Set<string>();
  const normalized: Array<{ hash: string; subject: string; diff: string }> = [];
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
    requireBoundedString(commit.diff, "commit.diff", MAX_COMMIT_DIFF_LENGTH);
    totalLength += commit.diff.length;
    if (totalLength > MAX_COMMITS_TOTAL_LENGTH) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Total reference commit size exceeds ${MAX_COMMITS_TOTAL_LENGTH} characters`,
      });
    }
    normalized.push({ hash, subject, diff: commit.diff });
  }
  return normalized;
};

const textEncoder = new TextEncoder();

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

const sha256 = async (parts: Array<string | Uint8Array>): Promise<string> => {
  const chunks = parts.map((part) =>
    typeof part === "string" ? textEncoder.encode(part) : part,
  );
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

const hashSourceBlob = async (
  blob:
    | Infer<
        typeof store_release_source_pack_validator
      >["changeSets"][number]["changes"][number]["base"]
    | undefined,
): Promise<string | null> => {
  if (!blob) return null;
  if (blob.kind === "text") {
    return await sha256([
      "stella-source-blob-v1\0text\0",
      textEncoder.encode(blob.content),
    ]);
  }
  return await sha256([
    "stella-source-blob-v1\0binary\0",
    textEncoder.encode(blob.contentBase64),
  ]);
};

const normalizeSourcePackPath = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Unsafe source-pack path: ${value}`,
    });
  }
  const segments = normalized.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Unsafe source-pack path: ${value}`,
    });
  }
  return segments.join("/");
};

type StoreSourceChange = Infer<
  typeof store_release_source_pack_validator
>["changeSets"][number]["changes"][number];

const buildSourceRevisionId = async (args: {
  baseRevisionId: string;
  parentRevisionIds: string[];
  featureId?: string;
  description?: string;
  changes: Array<{
    path: string;
    baseHash: string | null;
    nextHash: string | null;
  }>;
}): Promise<string> =>
  await sha256([
    "stella-source-revision-v1\0",
    stableJson({
      baseRevisionId: args.baseRevisionId,
      parentRevisionIds: [...args.parentRevisionIds].sort(),
      featureId: args.featureId ?? null,
      description: args.description ?? null,
      changes: args.changes.map((change) => ({
        path: change.path,
        baseHash: change.baseHash,
        nextHash: change.nextHash,
      })),
    }),
  ]);

const normalizeSourcePack = async (
  sourcePack: Infer<typeof store_release_source_pack_validator> | undefined,
  options?: { maxLength?: number },
) => {
  if (!sourcePack) return undefined;
  if (sourcePack.changeSets.length > MAX_SOURCE_PACK_CHANGE_SETS) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Source packs may include at most ${MAX_SOURCE_PACK_CHANGE_SETS} change sets.`,
    });
  }
  const normalizedChangeSets = [];
  for (const changeSet of sourcePack.changeSets) {
    const seenPaths = new Set<string>();
    const changes: StoreSourceChange[] = [];
    for (const change of changeSet.changes) {
      const sourcePath = normalizeSourcePackPath(change.path);
      if (seenPaths.has(sourcePath)) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: `Duplicate source-pack path: ${sourcePath}`,
        });
      }
      seenPaths.add(sourcePath);
      if (change.baseHash && !change.base) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: `Source pack is missing base content for ${sourcePath}.`,
        });
      }
      if (change.nextHash && !change.next) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: `Source pack is missing incoming content for ${sourcePath}.`,
        });
      }
      const baseHash = await hashSourceBlob(change.base);
      const nextHash = await hashSourceBlob(change.next);
      if (baseHash !== change.baseHash) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: `Source-pack base hash mismatch for ${sourcePath}.`,
        });
      }
      if (nextHash !== change.nextHash) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: `Source-pack incoming hash mismatch for ${sourcePath}.`,
        });
      }
      changes.push({
        path: sourcePath,
        baseHash,
        nextHash,
        ...(change.base ? { base: change.base } : {}),
        ...(change.next ? { next: change.next } : {}),
      });
    }
    changes.sort((left, right) => left.path.localeCompare(right.path));
    const revisionId = await buildSourceRevisionId({
      baseRevisionId: changeSet.baseRevisionId,
      parentRevisionIds: changeSet.parentRevisionIds,
      ...(changeSet.featureId ? { featureId: changeSet.featureId } : {}),
      ...(changeSet.description ? { description: changeSet.description } : {}),
      changes,
    });
    if (revisionId !== changeSet.revisionId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Source-pack revision mismatch for ${changeSet.revisionId}.`,
      });
    }
    normalizedChangeSets.push({
      schemaVersion: 1 as const,
      baseRevisionId: changeSet.baseRevisionId,
      parentRevisionIds: changeSet.parentRevisionIds,
      revisionId,
      ...(changeSet.featureId ? { featureId: changeSet.featureId } : {}),
      ...(changeSet.description ? { description: changeSet.description } : {}),
      changes,
    });
  }
  const revisionId =
    normalizedChangeSets[normalizedChangeSets.length - 1]?.revisionId ??
    sourcePack.baseRevisionId;
  if (revisionId !== sourcePack.revisionId) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Source-pack final revision mismatch.",
    });
  }
  const normalizedSourcePack = {
    kind: "stella-source-pack" as const,
    schemaVersion: 1 as const,
    baseRevisionId: sourcePack.baseRevisionId,
    revisionId,
    ...(sourcePack.featureId ? { featureId: sourcePack.featureId } : {}),
    ...(sourcePack.description ? { description: sourcePack.description } : {}),
    changeSets: normalizedChangeSets,
  };
  requireBoundedString(
    JSON.stringify(normalizedSourcePack),
    "sourcePack",
    options?.maxLength ?? MAX_SOURCE_PACK_INLINE_LENGTH,
  );
  return normalizedSourcePack;
};

const normalizeSourcePackRef = (
  sourcePackRef:
    | Infer<typeof store_release_source_pack_ref_validator>
    | undefined,
) => {
  if (!sourcePackRef) return undefined;
  requireBoundedString(sourcePackRef.r2Key, "sourcePackRef.r2Key", 1000);
  requireBoundedString(sourcePackRef.sha256, "sourcePackRef.sha256", 80);
  if (!/^sha256:[0-9a-f]{64}$/.test(sourcePackRef.sha256)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "sourcePackRef.sha256 must be a sha256 digest.",
    });
  }
  if (
    !Number.isInteger(sourcePackRef.sizeBytes) ||
    sourcePackRef.sizeBytes <= MAX_SOURCE_PACK_INLINE_LENGTH
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "sourcePackRef.sizeBytes must be a positive uploaded size.",
    });
  }
  return sourcePackRef;
};

const requireSingleSourcePackStorage = (
  sourcePack: unknown,
  sourcePackRef: unknown,
) => {
  if (sourcePack && sourcePackRef) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Use either sourcePack or sourcePackRef, not both.",
    });
  }
};

const cleanupUploadedSourcePackRef = async (
  ctx: {
    runAction: (
      fn: typeof internal.data.store_source_packs.deleteSourcePackRef,
      args: {
        ownerId: string;
        packageId: string;
        ref: StoreReleaseSourcePackRef;
      },
    ) => Promise<unknown>;
  },
  args: {
    ownerId: string;
    packageId: string;
    sourcePackRef?: StoreReleaseSourcePackRef;
  },
): Promise<void> => {
  if (!args.sourcePackRef) return;
  await ctx
    .runAction(internal.data.store_source_packs.deleteSourcePackRef, {
      ownerId: args.ownerId,
      packageId: args.packageId,
      ref: args.sourcePackRef,
    })
    .catch((error) => {
      console.warn(
        "[store-packages] failed to clean rejected source-pack upload:",
        error,
      );
    });
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

export const getReadableReleaseForSourcePackInternal = internalQuery({
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
    if (
      !isDirectLinkAccessible(pkg.visibility) &&
      (!args.callerOwnerId || pkg.ownerId !== args.callerOwnerId)
    ) {
      return null;
    }
    return await getReleaseByPackageIdAndNumber(
      ctx,
      normalizedPackageId,
      releaseNumber,
    );
  },
});

// ── internal release writers ─────────────────────────────────────────────────

export const createFirstReleaseRecord = internalMutation({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
    category: v.optional(store_package_category_validator),
    displayName: v.string(),
    description: v.optional(v.string()),
    releaseNotes: v.optional(v.string()),
    manifest: store_release_manifest_validator,
    blueprintMarkdown: v.string(),
    sourcePack: v.optional(store_release_source_pack_validator),
    sourcePackRef: v.optional(store_release_source_pack_ref_validator),
    commits: v.optional(v.array(store_release_commit_validator)),
    iconUrl: v.optional(v.string()),
    authorUsername: v.optional(v.string()),
    authorBadge: v.optional(socialBadgeValidator),
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
    const packageRef = await ctx.db.insert("store_packages", {
      ownerId: args.ownerId,
      packageId: args.packageId,
      category,
      displayName: args.displayName,
      ...(description ? { description } : {}),
      searchText: buildPackageSearchText(args.displayName, description),
      latestReleaseNumber: 0,
      visibility: "public",
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
      ...(args.sourcePack ? { sourcePack: args.sourcePack } : {}),
      ...(args.sourcePackRef ? { sourcePackRef: args.sourcePackRef } : {}),
      ...(args.commits && args.commits.length > 0
        ? { commits: args.commits }
        : {}),
      createdAt: now,
    });

    await ctx.db.patch(packageRef, {
      latestReleaseNumber: 1,
      latestReleaseId: releaseRef,
      updatedAt: now,
    });

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
    releaseNotes: v.optional(v.string()),
    manifest: store_release_manifest_validator,
    blueprintMarkdown: v.string(),
    sourcePack: v.optional(store_release_source_pack_validator),
    sourcePackRef: v.optional(store_release_source_pack_ref_validator),
    commits: v.optional(v.array(store_release_commit_validator)),
    iconUrl: v.optional(v.string()),
    authorUsername: v.optional(v.string()),
    authorBadge: v.optional(socialBadgeValidator),
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

    const nextReleaseNumber = pkg.latestReleaseNumber + 1;
    const now = Date.now();
    const releaseRef = await ctx.db.insert("store_package_releases", {
      ownerId: args.ownerId,
      packageRef: pkg._id,
      packageId: args.packageId,
      releaseNumber: nextReleaseNumber,
      releaseNotes: args.releaseNotes,
      manifest: args.manifest,
      blueprintMarkdown: args.blueprintMarkdown,
      ...(args.sourcePack ? { sourcePack: args.sourcePack } : {}),
      ...(args.sourcePackRef ? { sourcePackRef: args.sourcePackRef } : {}),
      ...(args.commits && args.commits.length > 0
        ? { commits: args.commits }
        : {}),
      createdAt: now,
    });

    await ctx.db.patch(pkg._id, {
      latestReleaseNumber: nextReleaseNumber,
      latestReleaseId: releaseRef,
      updatedAt: now,
      ...(args.iconUrl ? { iconUrl: args.iconUrl } : {}),
      ...(args.authorUsername ? { authorUsername: args.authorUsername } : {}),
      // Always patch authorBadge — undefined clears a stale badge if
      // the author has since canceled their subscription.
      authorBadge: args.authorBadge,
    });

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
    const indexed = args.category
      ? ctx.db
          .query("store_packages")
          .withIndex("by_category_and_updatedAt", (q) =>
            q.eq("category", args.category!),
          )
      : ctx.db.query("store_packages").withIndex("by_updatedAt");
    const result = await indexed.order("desc").paginate({
      cursor: args.paginationOpts.cursor,
      numItems,
    });
    return {
      ...result,
      page: result.page.filter(
        (pkg) => effectiveVisibility(pkg.visibility) === "public",
      ),
    };
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
    if (!isDirectLinkAccessible(pkg.visibility)) {
      const callerId = await ctx.auth.getUserIdentity();
      if (!callerId || pkg.ownerId !== callerId.tokenIdentifier) return [];
    }
    return await ctx.db
      .query("store_package_releases")
      .withIndex("by_packageId_and_releaseNumber", (q) =>
        q.eq("packageId", normalizedPackageId),
      )
      .order("desc")
      .take(200);
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
    if (!isDirectLinkAccessible(pkg.visibility)) {
      const callerId = await ctx.auth.getUserIdentity();
      if (!callerId || pkg.ownerId !== callerId.tokenIdentifier) return null;
    }
    return await getReleaseByPackageIdAndNumber(
      ctx,
      normalizedPackageId,
      releaseNumber,
    );
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
    await ctx.db.patch(pkg._id, {
      visibility: args.visibility,
      updatedAt: Date.now(),
    });
    return null;
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
    const releases = await ctx.db
      .query("store_package_releases")
      .withIndex("by_packageRef_and_releaseNumber", (q) =>
        q.eq("packageRef", pkg._id),
      )
      .take(1024);
    for (const release of releases) {
      await ctx.db.delete(release._id);
    }
    await ctx.db.delete(pkg._id);
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
    requireSingleSourcePackStorage(args.sourcePack, args.sourcePackRef);
    const sourcePack = await normalizeSourcePack(args.sourcePack);
    const sourcePackRef = normalizeSourcePackRef(args.sourcePackRef);
    const commits = normalizeCommits(args.commits);
    try {
      let sourcePackForReview = sourcePack;
      // User-authored display fields go through the cheap moderation
      // classifier before we hit the heavier security review or write
      // anything to the catalog. Synchronous fail-closed is fine here —
      // this is a one-shot deliberate publish, not a chat send.
      await moderateStoreListingTextOrThrow({
        displayName,
        ...(description ? { description } : {}),
      });
      if (sourcePackRef) {
        sourcePackForReview = await normalizeSourcePack(
          await ctx.runAction(
            internal.data.store_source_packs.validateSourcePackRef,
            {
              ownerId,
              packageId,
              ref: sourcePackRef,
            },
          ),
          { maxLength: MAX_SOURCE_PACK_UPLOAD_LENGTH },
        );
      }
      await enforceStoreReleaseReviewOrThrow(ctx, {
        ownerId,
        packageId,
        displayName,
        description: description ?? "",
        releaseSummary: releaseNotes,
        artifactBody: blueprintMarkdown,
        ...(commits ? { commits } : {}),
        ...(sourcePackForReview ? { sourcePack: sourcePackForReview } : {}),
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
          displayName,
          ...(description ? { description } : {}),
          releaseNotes,
          manifest: releaseManifest,
          blueprintMarkdown,
          ...(sourcePack ? { sourcePack } : {}),
          ...(sourcePackRef ? { sourcePackRef } : {}),
          ...(commits ? { commits } : {}),
          ...(args.category ? { category: args.category } : {}),
          ...(iconUrl ? { iconUrl } : {}),
          ...(author.authorUsername
            ? { authorUsername: author.authorUsername }
            : {}),
          ...(author.authorBadge ? { authorBadge: author.authorBadge } : {}),
        },
      );
    } catch (error) {
      await cleanupUploadedSourcePackRef(ctx, {
        ownerId,
        packageId,
        ...(sourcePackRef ? { sourcePackRef } : {}),
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
    requireSingleSourcePackStorage(args.sourcePack, args.sourcePackRef);
    const sourcePack = await normalizeSourcePack(args.sourcePack);
    const sourcePackRef = normalizeSourcePackRef(args.sourcePackRef);
    const commits = normalizeCommits(args.commits);
    try {
      let sourcePackForReview = sourcePack;
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
      if (sourcePackRef) {
        sourcePackForReview = await normalizeSourcePack(
          await ctx.runAction(
            internal.data.store_source_packs.validateSourcePackRef,
            {
              ownerId,
              packageId,
              ref: sourcePackRef,
            },
          ),
          { maxLength: MAX_SOURCE_PACK_UPLOAD_LENGTH },
        );
      }
      await enforceStoreReleaseReviewOrThrow(ctx, {
        ownerId,
        packageId,
        displayName: pkg.displayName,
        description: pkg.description ?? "",
        releaseSummary: releaseNotes,
        artifactBody: blueprintMarkdown,
        ...(commits ? { commits } : {}),
        ...(sourcePackForReview ? { sourcePack: sourcePackForReview } : {}),
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
          releaseNotes,
          manifest: releaseManifest,
          blueprintMarkdown,
          ...(sourcePack ? { sourcePack } : {}),
          ...(sourcePackRef ? { sourcePackRef } : {}),
          ...(commits ? { commits } : {}),
          ...(iconUrl ? { iconUrl } : {}),
          ...(author.authorUsername
            ? { authorUsername: author.authorUsername }
            : {}),
          ...(author.authorBadge ? { authorBadge: author.authorBadge } : {}),
        },
      );
    } catch (error) {
      await cleanupUploadedSourcePackRef(ctx, {
        ownerId,
        packageId,
        ...(sourcePackRef ? { sourcePackRef } : {}),
      });
      throw error;
    }
  },
});
