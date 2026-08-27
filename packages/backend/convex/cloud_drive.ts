// The per-user cloud drive: Convex holds the file index, R2 holds the bytes.
//
// Every path here is owner-scoped twice over — the row is looked up through
// `by_ownerId_and_path`, and the R2 key is derived from a hash of the owner id
// rather than taken from the caller — so one owner can never name another
// owner's object even if a path validator is bypassed.

import { ConvexError, v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { CopyObjectCommand } from "@aws-sdk/client-s3";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { r2 } from "./r2_files";
import { enforceActionRateLimit } from "./lib/rate_limits";
import { hashSha256Hex } from "./lib/crypto_utils";
import type { SubscriptionPlan } from "./lib/billing_plans";
import {
  priorDriveObjectKeyForCleanup,
  shouldDeleteReplacedDriveObjectKey,
} from "./lib/cloud_drive_replacement";
import { deleteComponentR2ObjectsRef } from "./lib/component_r2_deletion";
import { assertOwnerMigrationWriteAllowed, requireUserId } from "./auth";
import {
  assertOwnerDataAccessActive,
  assertOwnerDataWriteAllowed,
} from "./owner_lifecycle";
import { resolveCurrentTurnToken } from "./cloud_apps";

const MB = 1024 * 1024;

type CloudDriveQuota = {
  /** Ceiling on the sum of every row's sizeBytes for one owner. */
  totalBytes: number;
  maxFiles: number;
  maxFileBytes: number;
};

const cloudDriveRowValidator = v.object({
  _id: v.id("cloud_drive_files"),
  _creationTime: v.number(),
  ownerId: v.string(),
  path: v.string(),
  r2Key: v.string(),
  name: v.string(),
  sizeBytes: v.number(),
  contentType: v.string(),
  source: v.string(),
  origin: v.optional(v.string()),
  writeKey: v.optional(v.string()),
  uploadId: v.optional(v.string()),
  updatedAt: v.number(),
  createdAt: v.number(),
});

const driveFileListEntryValidator = v.object({
  path: v.string(),
  name: v.string(),
  sizeBytes: v.number(),
  contentType: v.string(),
  source: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const driveFileRecordValidator = v.object({
  path: v.string(),
  name: v.string(),
  sizeBytes: v.number(),
  contentType: v.string(),
  updatedAt: v.number(),
});

const r2MetadataValidator = v.object({
  bucket: v.string(),
  bucketLink: v.string(),
  contentType: v.optional(v.string()),
  key: v.string(),
  lastModified: v.string(),
  link: v.string(),
  sha256: v.optional(v.string()),
  size: v.optional(v.number()),
  url: v.string(),
});

const CLOUD_DRIVE_PLAN_QUOTAS: Record<SubscriptionPlan, CloudDriveQuota> = {
  free: { totalBytes: 256 * MB, maxFiles: 200, maxFileBytes: 25 * MB },
  go: { totalBytes: 1_024 * MB, maxFiles: 1_000, maxFileBytes: 100 * MB },
  pro: { totalBytes: 5_120 * MB, maxFiles: 5_000, maxFileBytes: 250 * MB },
};

const UNLIMITED_CLOUD_DRIVE_QUOTA: CloudDriveQuota = {
  totalBytes: 204_800 * MB,
  maxFiles: 200_000,
  maxFileBytes: 2_048 * MB,
};

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

/** Mirrors `resolveCloudPlan` in cloud_apps.ts, against the drive ceilings. */
const resolveDrivePlan = async (
  ctx: Pick<MutationCtx, "db"> | Pick<QueryCtx, "db">,
  ownerId: string,
): Promise<{ plan: SubscriptionPlan; quota: CloudDriveQuota }> => {
  const profile = await ctx.db
    .query("billing_profiles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
  const plan: SubscriptionPlan =
    profile &&
    ACTIVE_SUBSCRIPTION_STATUSES.has(profile.subscriptionStatus) &&
    profile.activePlan !== "free"
      ? profile.activePlan
      : "free";
  return {
    plan,
    quota:
      profile?.usageMode === "unlimited"
        ? UNLIMITED_CLOUD_DRIVE_QUOTA
        : CLOUD_DRIVE_PLAN_QUOTAS[plan],
  };
};

/** C4: bytes above this are reported as metadata only, never inlined. */
export const DRIVE_INLINE_FILE_LIMIT_BYTES = 8 * MB;
/** C4: ceiling on the inline bytes one produced-files report may carry. */
export const DRIVE_INLINE_REQUEST_LIMIT_BYTES = 32 * MB;
export const DRIVE_MAX_FILES_PER_REPORT = 50;

const MAX_PATH_LENGTH = 400;
const MAX_SEGMENT_LENGTH = 255;
const MAX_CONTENT_TYPE_LENGTH = 200;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 100;
const DOWNLOAD_URL_EXPIRES_SECONDS = 900;

/**
 * C3+C2 coherence: what one turn hydrates into its sandbox before the agent
 * runs. The drive is the user's whole file namespace and the sandbox is a
 * cache of it, so the caps are what stop a large drive from turning every
 * turn into a multi-minute download. Files are chosen newest-first with the
 * prompt's own references and the user's uploads ahead of agent output, so
 * the file someone just attached is never the one the cap leaves behind.
 */
const DRIVE_SYNC_MAX_FILES = 100;
const DRIVE_SYNC_MAX_BYTES = 128 * MB;
/** Long enough for a slow hydrate of the full byte cap, and no longer. */
const DRIVE_SYNC_URL_EXPIRES_SECONDS = 1_800;
/** Paths a turn may name in its own prompt; anything past this is noise. */
const DRIVE_SYNC_MAX_INCLUDE = 25;
/** Tombstones one sync answers with; more than this and the cursor stalls. */
const DRIVE_SYNC_MAX_DELETIONS = 100;
/**
 * Hydrated paths one sync answers a presence question for. A workspace holding
 * more than this rotates through them across turns: the answer is what lets a
 * caller delete its copy of a path, so the bound costs latency on the paths it
 * does not reach this turn and nothing else.
 */
const DRIVE_SYNC_MAX_PRESENCE = 500;
/**
 * How long a deletion stays replayable to a workspace that has not synced.
 * A workspace idle longer than this can hold a copy of a file the user
 * deleted, so the sync says so (`deletedComplete: false`) rather than
 * pretending its tombstone list is the whole story.
 */
const DRIVE_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
/**
 * How long a presigned PUT stays claimable before the sweep reclaims whatever
 * it left behind. Generous: a slow phone uploading a large file over a bad
 * connection is the case this must not cut off.
 */
const PENDING_UPLOAD_TTL_MS = 6 * 60 * 60_000;
/** A failed cleanup is retried after its short lease expires. */
const DRIVE_CLEANUP_LEASE_MS = 5 * 60_000;
/** Durable orphan cleanup retries forever, with a bounded backoff. */
const DRIVE_ORPHAN_DELETE_RETRY_MAX_MS = 15 * 60_000;
/** Keep retired bytes alive for signed GETs already handed to a client. */
const DRIVE_REPLACEMENT_CLEANUP_GRACE_MS = DOWNLOAD_URL_EXPIRES_SECONDS * 1_000;

const invalid = (message: string) =>
  new ConvexError({ code: "INVALID_ARGUMENT", message });

const requireOwnerId = requireUserId;

const assertExpectedOwnerGenerationActive = async (
  ctx: Pick<ActionCtx, "runQuery">,
  ownerId: string,
  expectedGeneration: string,
): Promise<void> => {
  const current = await assertOwnerDataAccessActive(ctx, ownerId);
  if (current.generation !== expectedGeneration) {
    throw new ConvexError({
      code: "OWNER_DATA_GENERATION_STALE",
      message: "This request started before the account data was reset.",
    });
  }
};

/**
 * Normalize a drive-relative path (C3). Rejects absolute paths, Windows drive
 * letters, `.`/`..` segments, and control characters, so a path can never
 * escape the owner's R2 prefix or the sandbox workspace root it maps to.
 */
export const normalizeDrivePath = (raw: string): string => {
  const value = (raw ?? "").trim().replaceAll("\\", "/");
  if (!value) throw invalid("A drive path is required.");
  if (value.length > MAX_PATH_LENGTH) {
    throw invalid(
      `Drive paths must be ${MAX_PATH_LENGTH} characters or fewer.`,
    );
  }
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) {
    throw invalid("Drive paths must be relative to the drive root.");
  }
  const segments = value.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) throw invalid("A drive path is required.");
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw invalid("Drive paths may not contain '.' or '..' segments.");
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw invalid(
        `Each drive path segment must be ${MAX_SEGMENT_LENGTH} characters or fewer.`,
      );
    }
    if (/[\u0000-\u001f\u007f]/.test(segment)) {
      throw invalid("Drive paths may not contain control characters.");
    }
  }
  return segments.join("/");
};

/** Same rules as a path, but a trailing slash and an empty value are fine. */
const normalizeDrivePrefix = (raw: string | undefined): string => {
  const value = (raw ?? "").trim().replaceAll("\\", "/");
  if (!value || value === "/") return "";
  const trailingSlash = value.endsWith("/");
  const normalized = normalizeDrivePath(value);
  return trailingSlash ? `${normalized}/` : normalized;
};

const normalizeContentType = (raw: string | undefined): string => {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_CONTENT_TYPE;
  if (
    value.length > MAX_CONTENT_TYPE_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return DEFAULT_CONTENT_TYPE;
  }
  return value;
};

const normalizeSize = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalid("sizeBytes must be a non-negative number.");
  }
  return Math.floor(value);
};

const fileNameFromPath = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

/** A display name is never a path: separators and control bytes are stripped. */
const normalizeFileName = (raw: string | undefined, path: string): string => {
  const value = (raw ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_SEGMENT_LENGTH);
  return value || fileNameFromPath(path);
};

/**
 * Where an agent's version of a file goes when the drive already holds bytes
 * the user uploaded and this turn never read them. Same folder, same
 * extension, so the two sit side by side in the drive browser and the user
 * decides which one wins — the one thing that must not happen is the agent's
 * write landing on top of an upload it never saw.
 */
export const driveRevisionPath = (path: string): string => {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const revised =
    dot > 0
      ? `${name.slice(0, dot)} (agent copy)${name.slice(dot)}`
      : `${name} (agent copy)`;
  return `${path.slice(0, slash + 1)}${revised}`;
};

/** C3: bytes live under `drive/<sha256(ownerId)>/<path>`. */
export const driveObjectKey = async (
  ownerId: string,
  path: string,
): Promise<string> => `drive/${await hashSha256Hex(ownerId)}/${path}`;

/**
 * A signed upload may outlive the row that prepared it. Giving every upload an
 * immutable key ensures an old URL can only recreate its own orphan object; it
 * can never overwrite the bytes a newer upload installed at the same path.
 */
export const driveUploadObjectKey = async (
  ownerId: string,
  uploadId: string,
  path: string,
): Promise<string> =>
  `drive/${await hashSha256Hex(ownerId)}/uploads/${uploadId}/${path}`;

/**
 * Final upload bytes never share a key with the reusable presigned PUT. Each
 * finalize attempt gets a distinct immutable key, so two concurrent retries
 * cannot overwrite whichever attempt wins the row transaction.
 */
export const driveFinalUploadObjectKey = async (
  ownerId: string,
  uploadId: string,
  finalizationId: string,
  path: string,
): Promise<string> =>
  `drive/${await hashSha256Hex(ownerId)}/files/${uploadId}/${finalizationId}/${path}`;

/** Immutable object namespace for a delivered produced-files batch. */
export const driveProducedObjectKey = async (
  ownerId: string,
  writeId: string,
  path: string,
): Promise<string> =>
  `drive/${await hashSha256Hex(ownerId)}/writes/${await hashSha256Hex(writeId)}/${path}`;

/**
 * Drive folder a turn's workspace is allowed to write into — the server half
 * of `drivePrefixFor` in packages/executor-cloud/src/workspace-paths.ts. The
 * executor namespaces the paths it reports; this is what makes that
 * namespacing a boundary rather than a convention, so a turn in `app:orbit`
 * cannot reach `contracts/` with the turn token it already holds.
 *
 * An absent workspace is an orchestrator chat or legacy build turn, which maps
 * to the drive root exactly as `resolveWorkspace`'s fallback does.
 */
export const driveWritePrefixForWorkspace = (
  workspace: string | undefined,
): string => {
  const value = (workspace ?? "").trim();
  if (value === "stella") return "stella/";
  for (const kind of ["project", "app"] as const) {
    if (value.startsWith(`${kind}:`)) {
      const slug = value.slice(kind.length + 1).trim();
      if (slug) return `${kind}s/${slug}/`;
    }
  }
  return "";
};

/**
 * The workspace a turn token speaks for. Lives here rather than in cloud_apps
 * because the drive route is its only reader.
 */
export const getTurnWorkspaceInternal = internalQuery({
  args: { turnId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      ownerId: v.string(),
      workspace: v.optional(v.string()),
      kind: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    if (!turn) return null;
    return {
      ownerId: turn.ownerId,
      ...(turn.workspace ? { workspace: turn.workspace } : {}),
      ...(turn.kind ? { kind: turn.kind } : {}),
    };
  },
});

/**
 * Does this turn read the drive before it runs? Only a spawned agent in the
 * `drive` workspace does: `materializeDriveFiles` is gated on that in
 * packages/executor-cloud/src/agent-turn.ts, because a `project:`, `app:` or
 * `stella` root is a checkout whose drive folder is an output mirror, and a
 * chat turn has no workspace at all.
 *
 * It is what tells "the agent overwrote a row it was never shown" apart from
 * "the agent wrote its own output again", which is the entire content of the
 * `replaced` notice.
 */
export const turnHydratesDrive = (turn: {
  workspace?: string;
  kind?: string;
}): boolean =>
  turn.kind === "agent" && driveWritePrefixForWorkspace(turn.workspace) === "";

// --- Row + usage helpers ---------------------------------------------------

const getDriveRow = async (
  ctx: Pick<MutationCtx, "db"> | Pick<QueryCtx, "db">,
  ownerId: string,
  path: string,
) =>
  await ctx.db
    .query("cloud_drive_files")
    .withIndex("by_ownerId_and_path", (q) =>
      q.eq("ownerId", ownerId).eq("path", path),
    )
    .unique();

const getUsageRow = async (
  ctx: Pick<MutationCtx, "db"> | Pick<QueryCtx, "db">,
  ownerId: string,
) =>
  await ctx.db
    .query("cloud_drive_usage")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();

const applyUsageDelta = async (
  ctx: MutationCtx,
  ownerId: string,
  fileCountDelta: number,
  byteDelta: number,
  now: number,
): Promise<void> => {
  const usage = await getUsageRow(ctx, ownerId);
  if (usage) {
    await ctx.db.patch(usage._id, {
      fileCount: Math.max(0, usage.fileCount + fileCountDelta),
      totalBytes: Math.max(0, usage.totalBytes + byteDelta),
      updatedAt: now,
    });
    return;
  }
  await ctx.db.insert("cloud_drive_usage", {
    ownerId,
    fileCount: Math.max(0, fileCountDelta),
    totalBytes: Math.max(0, byteDelta),
    updatedAt: now,
  });
};

/**
 * Persist external cleanup before the transaction forgets why an object is no
 * longer live. The upload table doubles as the durable cleanup queue so a
 * transient R2 failure can be retried without adding a second owner-data
 * registry. Sweep deletion is leased and the row disappears only after R2
 * confirms the delete.
 */
const queueDriveObjectCleanup = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    path: string;
    r2Key: string;
    notBefore: number;
    now: number;
  },
): Promise<void> => {
  const uploadId = `cleanup-${crypto.randomUUID()}`;
  await ctx.db.insert("cloud_drive_uploads", {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    uploadId,
    path: args.path,
    r2Key: args.r2Key,
    claimedBytes: 0,
    status: "cleanup",
    createdAt: args.now,
    expiresAt: args.notBefore,
  });
};

const turnPendingUploadIntoCleanup = async (
  ctx: MutationCtx,
  row: {
    _id: any;
    expiresAt: number;
  },
  now: number,
): Promise<void> => {
  await ctx.db.patch(row._id, {
    status: "cleanup",
    // A presigned PUT cannot be revoked. Never reclaim its staging key before
    // the original abandonment horizon, even after finalize rejects it.
    expiresAt: Math.max(row.expiresAt, now),
    cleanupLeaseId: undefined,
    cleanupLeaseExpiresAt: undefined,
  });
};

export const queueDriveObjectCleanupInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    path: v.string(),
    r2Key: v.string(),
    notBefore: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lifecycle = await assertOwnerDataWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    await queueDriveObjectCleanup(ctx, {
      ...args,
      ownerGeneration: lifecycle.generation,
    });
    return null;
  },
});

// Sub-megabyte values round to "0 MB", which reads as a bug in a sentence
// like "larger than the 0 MB it was prepared for". Drop to KB below 1 MB.
const formatMb = (bytes: number): string =>
  bytes < MB
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${Math.round((bytes / MB) * 10) / 10} MB`;

type DriveWriteCandidate = { path: string; sizeBytes: number };

export type DriveWriteVerdict = {
  plan: SubscriptionPlan;
  accepted: DriveWriteCandidate[];
  skipped: Array<{ path: string; reason: string }>;
};

/**
 * Plan-quota gate shared by the upload path and the produced-files route.
 * Replacing an existing path only charges the difference, so re-saving a file
 * never walks an owner into their ceiling.
 *
 * The verdict is per file, not per batch: one 40 MB file in a turn's report
 * must not strand the 4 KB summary next to it, so the files that fit are
 * accepted and the rest come back with the reason to show the user.
 */
const partitionDriveWrite = async (
  ctx: Pick<MutationCtx, "db"> | Pick<QueryCtx, "db">,
  ownerId: string,
  files: DriveWriteCandidate[],
): Promise<DriveWriteVerdict> => {
  const { plan, quota } = await resolveDrivePlan(ctx, ownerId);
  const usage = await getUsageRow(ctx, ownerId);
  let fileCount = usage?.fileCount ?? 0;
  let totalBytes = usage?.totalBytes ?? 0;
  const planLabel = plan === "free" ? "Free" : plan;
  const accepted: DriveWriteCandidate[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const occurrences = new Map<string, number>();
  for (const file of files) {
    occurrences.set(file.path, (occurrences.get(file.path) ?? 0) + 1);
  }
  // Bytes an earlier entry in this same batch already charged for a path, so a
  // report that lists one path twice replaces rather than double-charges.
  const charged = new Map<string, number>();
  for (const file of files) {
    if ((occurrences.get(file.path) ?? 0) > 1) {
      skipped.push({
        path: file.path,
        reason: `${file.path} appears more than once in the same write. Send one version per path.`,
      });
      continue;
    }
    if (file.sizeBytes > quota.maxFileBytes) {
      skipped.push({
        path: file.path,
        reason: `${file.path} is larger than the ${formatMb(quota.maxFileBytes)} per-file limit on your plan.`,
      });
      continue;
    }
    const priorCharge = charged.has(file.path)
      ? charged.get(file.path)!
      : ((await getDriveRow(ctx, ownerId, file.path))?.sizeBytes ?? null);
    const nextFileCount = priorCharge === null ? fileCount + 1 : fileCount;
    const nextTotalBytes = totalBytes - (priorCharge ?? 0) + file.sizeBytes;
    if (nextFileCount > quota.maxFiles) {
      skipped.push({
        path: file.path,
        reason: `Your drive is limited to ${quota.maxFiles} files on the ${planLabel} plan.`,
      });
      continue;
    }
    if (nextTotalBytes > quota.totalBytes) {
      skipped.push({
        path: file.path,
        reason: `Your drive is limited to ${formatMb(quota.totalBytes)} on the ${planLabel} plan.`,
      });
      continue;
    }
    fileCount = nextFileCount;
    totalBytes = nextTotalBytes;
    charged.set(file.path, file.sizeBytes);
    accepted.push(file);
  }
  return { plan, accepted, skipped };
};

// --- Internal surface ------------------------------------------------------

const driveWriteVerdictValidator = v.object({
  plan: v.string(),
  accepted: v.array(v.object({ path: v.string(), sizeBytes: v.number() })),
  skipped: v.array(v.object({ path: v.string(), reason: v.string() })),
});

export const checkDriveWriteInternal = internalQuery({
  args: {
    ownerId: v.string(),
    files: v.array(v.object({ path: v.string(), sizeBytes: v.number() })),
  },
  returns: driveWriteVerdictValidator,
  handler: async (ctx, args) =>
    await partitionDriveWrite(ctx, args.ownerId, args.files),
});

export const recordDriveFilesInternal = internalMutation({
  args: {
    ownerId: v.string(),
    turnAuthority: v.optional(
      v.object({ tokenHash: v.string(), turnId: v.string() }),
    ),
    files: v.array(
      v.object({
        path: v.string(),
        r2Key: v.string(),
        name: v.string(),
        sizeBytes: v.number(),
        contentType: v.string(),
        source: v.string(),
      }),
    ),
    // Identifies the write, not the file: every row this batch touches records
    // it, and the produced-files route reads it back to tell a retry of this
    // same batch apart from a second writer (see `applyUploadWriteRule`).
    writeKey: v.optional(v.string()),
    /** Generation captured by delayed upload/callback writers. */
    ownerGeneration: v.string(),
    now: v.number(),
  },
  returns: v.object({
    authorityAccepted: v.boolean(),
    files: v.array(
      v.object({
        path: v.string(),
        name: v.string(),
        sizeBytes: v.number(),
        contentType: v.string(),
        updatedAt: v.number(),
      }),
    ),
    skipped: v.array(v.object({ path: v.string(), reason: v.string() })),
    replacedR2Keys: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const lifecycle = await assertOwnerDataWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    await assertOwnerMigrationWriteAllowed(ctx, args.ownerId);
    if (
      args.turnAuthority &&
      !(
        await resolveCurrentTurnToken(
          ctx,
          {
            tokenHash: args.turnAuthority.tokenHash,
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            turnId: args.turnAuthority.turnId,
            now: args.now,
          },
          true,
        )
      )?.turn
    ) {
      // Immutable R2 PUTs happen before this final metadata transaction. A
      // Stop or token rotation that wins the race must reject every row while
      // retaining durable, leased cleanup debt for bytes that may already be
      // present. Throwing here would roll that debt back with the rejected row.
      for (const file of args.files) {
        if (file.source === "workspace") continue;
        await queueDriveObjectCleanup(ctx, {
          ownerId: args.ownerId,
          ownerGeneration: lifecycle.generation,
          path: file.path,
          r2Key: file.r2Key,
          notBefore: args.now,
          now: args.now,
        });
      }
      return {
        authorityAccepted: false,
        files: [],
        skipped: args.files.map((file) => ({
          path: file.path,
          reason: "The cloud turn ended before this file could be committed.",
        })),
        replacedR2Keys: [],
      };
    }
    // Re-check inside the transaction: the pre-check that gated the upload
    // raced against every other write this owner had in flight. Still per
    // file, so a race costs the file that no longer fits, not the batch.
    const verdict = await partitionDriveWrite(ctx, args.ownerId, args.files);
    const skipped = [...verdict.skipped];
    // `partitionDriveWrite` rejects every duplicate path, so one accepted
    // candidate maps to exactly one metadata/body record here. Never collapse
    // quota decisions to a Set of paths: that would re-admit a rejected twin.
    const acceptedByPath = new Map(
      verdict.accepted.map((file) => [file.path, file.sizeBytes]),
    );
    const files = args.files.filter(
      (file) => acceptedByPath.get(file.path) === file.sizeBytes,
    );
    const written: typeof files = [];
    const replacedR2Keys = new Set<string>();
    let fileCountDelta = 0;
    let byteDelta = 0;
    for (const file of files) {
      const existing = await getDriveRow(ctx, args.ownerId, file.path);
      if (existing) {
        // A "workspace" record is a claim about bytes that never left a
        // sandbox — it carries none of its own. Letting one land on a row
        // that does have bytes would repoint the row at a file nobody can
        // download while the real object sits untouched at the same key.
        if (file.source === "workspace" && existing.source !== "workspace") {
          skipped.push({
            path: file.path,
            reason: `${file.path} is too large to deliver, so the copy already in your drive was kept and this turn's version stayed in the workspace.`,
          });
          continue;
        }
        const priorR2Key = priorDriveObjectKeyForCleanup({
          priorR2Key: existing.r2Key,
          priorSource: existing.source,
          nextR2Key: file.r2Key,
        });
        byteDelta += file.sizeBytes - existing.sizeBytes;
        await ctx.db.patch(existing._id, {
          r2Key: file.r2Key,
          name: file.name,
          sizeBytes: file.sizeBytes,
          contentType: file.contentType,
          source: file.source,
          // Provenance only ever rises to "upload": the user putting bytes at
          // this path is what earns the overwrite protection, and an agent
          // edit afterwards must not spend it. A row written before the field
          // existed carries none, and its readers answer from `source` — so
          // the `source` standing here now, the one that fallback would have
          // resolved to, is frozen into the field before this write replaces
          // it. Without that the first agent edit of a pre-existing upload
          // silently converts it into an agent-owned file.
          origin:
            file.source === "upload"
              ? "upload"
              : (existing.origin ?? existing.source),
          // Names the write landing now, so a key from an earlier write cannot
          // outlive it and license a replay of that one.
          writeKey: args.writeKey,
          uploadId: undefined,
          updatedAt: args.now,
        });
        if (priorR2Key) {
          replacedR2Keys.add(priorR2Key);
          await queueDriveObjectCleanup(ctx, {
            ownerId: args.ownerId,
            ownerGeneration: lifecycle.generation,
            path: file.path,
            r2Key: priorR2Key,
            notBefore: args.now + DRIVE_REPLACEMENT_CLEANUP_GRACE_MS,
            now: args.now,
          });
        }
        written.push(file);
      } else {
        fileCountDelta += 1;
        byteDelta += file.sizeBytes;
        await ctx.db.insert("cloud_drive_files", {
          ownerId: args.ownerId,
          path: file.path,
          r2Key: file.r2Key,
          name: file.name,
          sizeBytes: file.sizeBytes,
          contentType: file.contentType,
          source: file.source,
          origin: file.source,
          ...(args.writeKey ? { writeKey: args.writeKey } : {}),
          createdAt: args.now,
          updatedAt: args.now,
        });
        written.push(file);
      }
    }
    // Every external PUT that did not become a row is durable cleanup work in
    // this same transaction. This closes the external-before-row gap when the
    // preflight quota verdict races another write or an overwrite rule rejects
    // one member of the batch after its immutable object has already landed.
    const writtenObjectKeys = new Set(written.map((file) => file.r2Key));
    for (const file of args.files) {
      if (file.source === "workspace" || writtenObjectKeys.has(file.r2Key)) {
        continue;
      }
      await queueDriveObjectCleanup(ctx, {
        ownerId: args.ownerId,
        ownerGeneration: lifecycle.generation,
        path: file.path,
        r2Key: file.r2Key,
        notBefore: args.now,
        now: args.now,
      });
    }
    await applyUsageDelta(
      ctx,
      args.ownerId,
      fileCountDelta,
      byteDelta,
      args.now,
    );
    return {
      authorityAccepted: true,
      files: written.map((file) => ({
        path: file.path,
        name: file.name,
        sizeBytes: file.sizeBytes,
        contentType: file.contentType,
        updatedAt: args.now,
      })),
      skipped,
      replacedR2Keys: [...replacedR2Keys],
    };
  },
});

export const isDriveObjectKeyReferencedInternal = internalQuery({
  args: {
    r2Key: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) =>
    Boolean(
      await ctx.db
        .query("cloud_drive_files")
        .withIndex("by_r2Key", (q) => q.eq("r2Key", args.r2Key))
        .first(),
    ),
});

export const getDriveFileInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.optional(v.string()),
    path: v.string(),
  },
  returns: v.union(cloudDriveRowValidator, v.null()),
  handler: async (ctx, args) => {
    if (args.ownerGeneration) {
      await assertOwnerDataWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    }
    return await getDriveRow(ctx, args.ownerId, args.path);
  },
});

export const listDriveFilesInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    prefix: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.array(driveFileListEntryValidator),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    return await listDriveRows(ctx, args.ownerId, args.prefix, args.limit);
  },
});

/**
 * Rows a turn may hydrate, with the R2 key the manifest signs. Separate from
 * `listDriveFilesInternal` because that one is the client shape and
 * deliberately drops `r2Key`.
 */
export const listDriveSyncRowsInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    prefix: v.optional(v.string()),
    limit: v.optional(v.number()),
    /**
     * Paths to answer for by point lookup whatever the listing window reached.
     *
     * The listing is a bounded window — for a drive workspace, the newest
     * `limit` rows by `updatedAt` — and the manifest is the only thing that
     * tells a turn a row exists at all. On a drive larger than the window an
     * older file is named nowhere, so the turn is not shown it, does not
     * hydrate it, and writes a fresh file over it. The paths the prompt named
     * are where that actually bites ("append the Q4 section to
     * reports/annual-2025.md"), and they are the one set small enough to
     * answer exactly.
     */
    paths: v.optional(v.array(v.string())),
  },
  returns: v.array(
    v.object({
      path: v.string(),
      r2Key: v.string(),
      sizeBytes: v.number(),
      contentType: v.string(),
      source: v.string(),
      origin: v.string(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const rows = await queryDriveRows(
      ctx,
      args.ownerId,
      args.prefix,
      args.limit,
    );
    const byPath = new Map(rows.map((row) => [row.path, row]));
    for (const path of (args.paths ?? []).slice(0, DRIVE_SYNC_MAX_INCLUDE)) {
      if (byPath.has(path)) continue;
      const row = await getDriveRow(ctx, args.ownerId, path);
      if (row) byPath.set(row.path, row);
    }
    return [...byPath.values()].map((row) => ({
      path: row.path,
      r2Key: row.r2Key,
      sizeBytes: row.sizeBytes,
      contentType: row.contentType,
      source: row.source,
      origin: row.origin ?? row.source,
      updatedAt: row.updatedAt,
    }));
  },
});

/**
 * Which of these exact paths the drive still holds a row for.
 *
 * Point lookups, deliberately, rather than a slice of `listDriveSyncRowsInternal`:
 * that listing is capped, so a path's absence from it means "not in the window
 * I read", which is indistinguishable from "not in the drive" and is not a
 * fact anyone may delete a file on. Absence here is a fact about the named
 * path.
 */
export const listDrivePresenceInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    paths: v.array(v.string()),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const present: string[] = [];
    for (const path of args.paths.slice(0, DRIVE_SYNC_MAX_PRESENCE)) {
      if (await getDriveRow(ctx, args.ownerId, path)) present.push(path);
    }
    return present;
  },
});

/**
 * The version of each named path as it stands right now. The produced-files
 * route compares this against the version the reporting turn says it read, so
 * an agent write can only land on a row the turn actually saw — plus the key
 * of the write that put the row in that state, which is how a redelivery of
 * that same write is told apart from a turn that never read the file.
 */
export const getDriveWriteBaselineInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    paths: v.array(v.string()),
  },
  returns: v.array(
    v.object({
      path: v.string(),
      source: v.string(),
      origin: v.string(),
      writeKey: v.optional(v.string()),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const baseline: Array<{
      path: string;
      source: string;
      origin: string;
      writeKey?: string;
      updatedAt: number;
    }> = [];
    for (const path of args.paths.slice(0, DRIVE_MAX_FILES_PER_REPORT * 2)) {
      const row = await getDriveRow(ctx, args.ownerId, path);
      if (!row) continue;
      baseline.push({
        path: row.path,
        source: row.source,
        origin: row.origin ?? row.source,
        ...(row.writeKey ? { writeKey: row.writeKey } : {}),
        updatedAt: row.updatedAt,
      });
    }
    return baseline;
  },
});

/**
 * The record that a path is gone. Written in the same transaction as the row
 * deletion so a workspace holding a hydrated copy can be told to drop it; one
 * row per path, refreshed rather than duplicated, so a path deleted and
 * re-created repeatedly cannot grow the table without bound.
 */
const recordDriveTombstone = async (
  ctx: MutationCtx,
  ownerId: string,
  path: string,
  deletedAt: number,
): Promise<void> => {
  const existing = await ctx.db
    .query("cloud_drive_deletions")
    .withIndex("by_ownerId_and_path", (q) =>
      q.eq("ownerId", ownerId).eq("path", path),
    )
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, { deletedAt });
    return;
  }
  await ctx.db.insert("cloud_drive_deletions", { ownerId, path, deletedAt });
};

export const deleteDriveFileRowInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    path: v.string(),
    expectedR2Key: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, args) => {
    const lifecycle = await assertOwnerDataWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    await assertOwnerMigrationWriteAllowed(ctx, args.ownerId);
    const row = await getDriveRow(ctx, args.ownerId, args.path);
    if (!row) return { deleted: false };
    if (args.expectedR2Key && row.r2Key !== args.expectedR2Key) {
      return { deleted: false };
    }
    await ctx.db.delete(row._id);
    await applyUsageDelta(ctx, args.ownerId, -1, -row.sizeBytes, args.now);
    await recordDriveTombstone(ctx, args.ownerId, args.path, args.now);
    if (row.source !== "workspace") {
      await queueDriveObjectCleanup(ctx, {
        ownerId: args.ownerId,
        ownerGeneration: lifecycle.generation,
        path: row.path,
        r2Key: row.r2Key,
        notBefore: args.now,
        now: args.now,
      });
    }
    return { deleted: true };
  },
});

/**
 * Deletions a workspace has not seen yet, oldest first from its cursor.
 *
 * A path that has a row again is deliberately not reported: it is live, the
 * manifest's `files` entry is the truth for it, and replaying its tombstone
 * would delete the copy this very turn is about to hydrate. That makes an
 * over-broad cursor harmless — the worst a replayed tombstone can do is
 * remove a workspace file that Convex says does not exist.
 *
 * `newestFirst` answers the other question: not "what has this workspace not
 * applied yet" but "what did the drive lose most recently", which needs no
 * cursor to be right. The caller's cursor comes out of the workspace, and a
 * workspace is written by the agent — so the ascending window is the fast path
 * and this is the one that does not depend on the caller telling the truth.
 * It is not a resume window, so it answers with no cursor.
 */
export const listDriveDeletionsInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    since: v.number(),
    limit: v.number(),
    newestFirst: v.optional(v.boolean()),
  },
  returns: v.object({
    deleted: v.array(v.object({ path: v.string(), deletedAt: v.number() })),
    /** Cursor to resume from when the window did not cover everything. */
    cursor: v.union(v.null(), v.number()),
  }),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const limit = Math.min(
      DRIVE_SYNC_MAX_DELETIONS,
      Math.max(1, Math.floor(args.limit)),
    );
    const query = ctx.db
      .query("cloud_drive_deletions")
      .withIndex("by_ownerId_and_deletedAt", (q) =>
        q.eq("ownerId", args.ownerId).gte("deletedAt", Math.max(0, args.since)),
      );
    if (args.newestFirst) {
      const recent = await query.order("desc").take(limit);
      const deleted: Array<{ path: string; deletedAt: number }> = [];
      for (const row of recent) {
        if (await getDriveRow(ctx, args.ownerId, row.path)) continue;
        deleted.push({ path: row.path, deletedAt: row.deletedAt });
      }
      return { deleted, cursor: null };
    }
    const rows = await query.take(limit + 1);
    const window = rows.slice(0, limit);
    const deleted: Array<{ path: string; deletedAt: number }> = [];
    for (const row of window) {
      if (await getDriveRow(ctx, args.ownerId, row.path)) continue;
      deleted.push({ path: row.path, deletedAt: row.deletedAt });
    }
    if (rows.length <= limit) return { deleted, cursor: null };
    // Resume where the window ended. Replaying a tombstone is a no-op, so
    // landing on the same millisecond twice is fine — but a whole window
    // inside one millisecond would never advance, so that one steps past it.
    const last = window[window.length - 1]!.deletedAt;
    return { deleted, cursor: last > args.since ? last : last + 1 };
  },
});

/** Drop tombstones past the replay window. Called from the drive sweep. */
export const pruneDriveTombstonesInternal = internalMutation({
  args: { before: v.number(), limit: v.number() },
  returns: v.object({ pruned: v.number() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloud_drive_deletions")
      .withIndex("by_deletedAt", (q) => q.lt("deletedAt", args.before))
      .take(Math.min(500, Math.max(1, Math.floor(args.limit))));
    for (const row of rows) await ctx.db.delete(row._id);
    return { pruned: rows.length };
  },
});

/**
 * Point a row at what its key actually holds. The one repair the drive has
 * for the case where bytes landed at a row's deterministic key without the
 * write that was supposed to record them: the object cannot be un-written, so
 * the row and the usage totals are moved to it rather than the file being
 * destroyed to make the numbers agree. Usage still moves transactionally with
 * the row; it just does not refuse, because refusing here would mean deleting
 * bytes the owner can no longer replace.
 */
export const resyncDriveRowSizeInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    path: v.string(),
    r2Key: v.string(),
    sizeBytes: v.number(),
    now: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({
      path: v.string(),
      name: v.string(),
      sizeBytes: v.number(),
      contentType: v.string(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    await assertOwnerMigrationWriteAllowed(ctx, args.ownerId);
    const row = await getDriveRow(ctx, args.ownerId, args.path);
    if (!row || row.r2Key !== args.r2Key) return null;
    // Already describes these bytes: patching would only churn `updatedAt`,
    // which is the version token a turn echoes to prove it read the file.
    if (row.sizeBytes === args.sizeBytes) {
      return {
        path: row.path,
        name: row.name,
        sizeBytes: row.sizeBytes,
        contentType: row.contentType,
        updatedAt: row.updatedAt,
      };
    }
    await ctx.db.patch(row._id, {
      sizeBytes: args.sizeBytes,
      updatedAt: args.now,
    });
    await applyUsageDelta(
      ctx,
      args.ownerId,
      0,
      args.sizeBytes - row.sizeBytes,
      args.now,
    );
    return {
      path: row.path,
      name: row.name,
      sizeBytes: args.sizeBytes,
      contentType: row.contentType,
      updatedAt: args.now,
    };
  },
});

// --- Pending uploads -------------------------------------------------------
//
// R2's presigned PUT carries no content-length condition, so the size a client
// claims in `prepareDriveUpload` is a promise, not a constraint. Remembering
// the key we handed out is what makes the promise enforceable: finalize checks
// the real size against the claim, and anything never finalized is reclaimable
// by the sweep instead of sitting in the bucket forever, invisible to
// `cloud_drive_usage` and to `deleteMyDriveFile` (which can only reach objects
// that have a row).

const getPendingUploadRow = async (
  ctx: Pick<MutationCtx, "db"> | Pick<QueryCtx, "db">,
  ownerId: string,
  uploadId: string,
) =>
  await ctx.db
    .query("cloud_drive_uploads")
    .withIndex("by_ownerId_and_uploadId", (q) =>
      q.eq("ownerId", ownerId).eq("uploadId", uploadId),
    )
    .unique();

export const recordPendingUploadInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    uploadId: v.string(),
    path: v.string(),
    r2Key: v.string(),
    claimedBytes: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    await assertOwnerMigrationWriteAllowed(ctx, args.ownerId);
    const expectedKey = await driveUploadObjectKey(
      args.ownerId,
      args.uploadId,
      args.path,
    );
    if (expectedKey !== args.r2Key) {
      throw invalid(
        "Upload object key does not match its owner and generation.",
      );
    }
    const expiresAt = args.now + PENDING_UPLOAD_TTL_MS;
    const existing = await ctx.db
      .query("cloud_drive_uploads")
      .withIndex("by_uploadId", (q) => q.eq("uploadId", args.uploadId))
      .unique();
    if (existing) {
      if (
        existing.ownerId === args.ownerId &&
        existing.ownerGeneration === args.ownerGeneration &&
        existing.path === args.path &&
        existing.r2Key === args.r2Key &&
        existing.claimedBytes === args.claimedBytes
      ) {
        return null;
      }
      throw invalid("That upload generation is already in use.");
    }
    await ctx.db.insert("cloud_drive_uploads", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      uploadId: args.uploadId,
      path: args.path,
      r2Key: args.r2Key,
      claimedBytes: args.claimedBytes,
      status: "pending",
      createdAt: args.now,
      expiresAt,
    });
    return null;
  },
});

export const getPendingUploadInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    uploadId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      ownerGeneration: v.string(),
      uploadId: v.string(),
      path: v.string(),
      r2Key: v.string(),
      claimedBytes: v.number(),
      createdAt: v.number(),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const row = await getPendingUploadRow(ctx, args.ownerId, args.uploadId);
    if (
      !row ||
      row.status === "cleanup" ||
      !row.uploadId ||
      !row.ownerGeneration
    ) {
      return null;
    }
    return {
      ownerGeneration: row.ownerGeneration,
      uploadId: row.uploadId,
      path: row.path,
      r2Key: row.r2Key,
      claimedBytes: row.claimedBytes,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  },
});

export const clearPendingUploadInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    uploadId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const row = await getPendingUploadRow(ctx, args.ownerId, args.uploadId);
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

/**
 * Take a stale claim, but only the exact one the sweep read. A claim the
 * owner re-prepared while the sweep was reading is a live upload with fresh
 * bytes at the same key; the sweep must drop it rather than reclaim it.
 */
export const claimPendingUploadInternal = internalMutation({
  args: {
    ownerId: v.string(),
    uploadId: v.string(),
    r2Key: v.string(),
    leaseId: v.string(),
    eligibleBefore: v.number(),
    now: v.number(),
  },
  returns: v.object({ claimed: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await getPendingUploadRow(ctx, args.ownerId, args.uploadId);
    if (
      !row ||
      row.r2Key !== args.r2Key ||
      row.expiresAt > args.eligibleBefore ||
      (row.cleanupLeaseExpiresAt !== undefined &&
        row.cleanupLeaseExpiresAt > args.now)
    ) {
      return { claimed: false };
    }
    await ctx.db.patch(row._id, {
      cleanupLeaseId: args.leaseId,
      cleanupLeaseExpiresAt: args.now + DRIVE_CLEANUP_LEASE_MS,
    });
    return { claimed: true };
  },
});

/** Consume cleanup work only after the external delete (or live-row proof). */
export const finishPendingUploadCleanupInternal = internalMutation({
  args: {
    ownerId: v.string(),
    uploadId: v.string(),
    r2Key: v.string(),
    leaseId: v.string(),
  },
  returns: v.object({ finished: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await getPendingUploadRow(ctx, args.ownerId, args.uploadId);
    if (
      !row ||
      row.r2Key !== args.r2Key ||
      row.cleanupLeaseId !== args.leaseId
    ) {
      return { finished: false };
    }
    await ctx.db.delete(row._id);
    return { finished: true };
  },
});

export const listStalePendingUploadsInternal = internalQuery({
  args: { now: v.number(), limit: v.number() },
  returns: v.array(
    v.object({
      ownerId: v.string(),
      ownerGeneration: v.string(),
      uploadId: v.string(),
      path: v.string(),
      r2Key: v.string(),
      claimedBytes: v.number(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloud_drive_uploads")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", args.now))
      .take(Math.min(200, Math.max(1, Math.floor(args.limit))));
    return rows.flatMap((row) =>
      row.uploadId && row.ownerGeneration
        ? [
            {
              ownerId: row.ownerId,
              ownerGeneration: row.ownerGeneration,
              uploadId: row.uploadId,
              path: row.path,
              r2Key: row.r2Key,
              claimedBytes: row.claimedBytes,
              createdAt: row.createdAt,
            },
          ]
        : [],
    );
  },
});

const driveUploadFileValidator = v.object({
  path: v.string(),
  name: v.string(),
  sizeBytes: v.number(),
  contentType: v.string(),
  updatedAt: v.number(),
});

const driveUploadCommitValidator = v.union(
  v.object({
    status: v.union(v.literal("committed"), v.literal("replayed")),
    file: driveUploadFileValidator,
    replacedR2Key: v.optional(v.string()),
  }),
  v.object({
    status: v.union(
      v.literal("missing"),
      v.literal("size_mismatch"),
      v.literal("quota_exceeded"),
    ),
    message: v.string(),
    r2Key: v.optional(v.string()),
  }),
);

/** Atomically consumes one immutable upload generation and installs its row. */
export const commitDriveUploadInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    uploadId: v.string(),
    path: v.string(),
    stagingR2Key: v.string(),
    finalizationId: v.string(),
    finalR2Key: v.string(),
    sizeBytes: v.number(),
    contentType: v.string(),
    source: v.string(),
    now: v.number(),
  },
  returns: driveUploadCommitValidator,
  handler: async (ctx, args) => {
    const lifecycle = await assertOwnerDataWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    await assertOwnerMigrationWriteAllowed(ctx, args.ownerId);
    const existingFile = await getDriveRow(ctx, args.ownerId, args.path);
    const pending = await getPendingUploadRow(ctx, args.ownerId, args.uploadId);
    const expectedFinalKey = await driveFinalUploadObjectKey(
      args.ownerId,
      args.uploadId,
      args.finalizationId,
      args.path,
    );
    if (
      args.finalR2Key !== expectedFinalKey ||
      args.finalR2Key === args.stagingR2Key
    ) {
      throw invalid("Final upload object key is invalid.");
    }
    const fileProjection = (row: {
      path: string;
      name: string;
      sizeBytes: number;
      contentType: string;
      updatedAt: number;
    }) => ({
      path: row.path,
      name: row.name,
      sizeBytes: row.sizeBytes,
      contentType: row.contentType,
      updatedAt: row.updatedAt,
    });
    const queueFinalAttemptCleanup = async () => {
      if (existingFile?.r2Key === args.finalR2Key) return;
      await queueDriveObjectCleanup(ctx, {
        ownerId: args.ownerId,
        ownerGeneration: lifecycle.generation,
        path: args.path,
        r2Key: args.finalR2Key,
        notBefore: args.now,
        now: args.now,
      });
    };
    if (!pending || pending.status === "cleanup") {
      await queueFinalAttemptCleanup();
      if (existingFile?.uploadId === args.uploadId) {
        return {
          status: "replayed" as const,
          file: fileProjection(existingFile),
        };
      }
      return {
        status: "missing" as const,
        message: "That upload is no longer pending. Start the upload again.",
      };
    }
    if (
      pending.ownerGeneration !== args.ownerGeneration ||
      pending.path !== args.path ||
      pending.r2Key !== args.stagingR2Key
    ) {
      throw invalid("Upload generation does not match its pending claim.");
    }
    if (args.sizeBytes > pending.claimedBytes) {
      await turnPendingUploadIntoCleanup(ctx, pending, args.now);
      await queueFinalAttemptCleanup();
      return {
        status: "size_mismatch" as const,
        message: `That upload is ${formatMb(args.sizeBytes)}, larger than the ${formatMb(pending.claimedBytes)} it was prepared for. Start the upload again.`,
        r2Key: args.finalR2Key,
      };
    }
    const verdict = await partitionDriveWrite(ctx, args.ownerId, [
      { path: args.path, sizeBytes: args.sizeBytes },
    ]);
    if (verdict.accepted.length === 0) {
      await turnPendingUploadIntoCleanup(ctx, pending, args.now);
      await queueFinalAttemptCleanup();
      return {
        status: "quota_exceeded" as const,
        message: verdict.skipped[0]?.reason ?? "Drive quota exceeded.",
        r2Key: args.finalR2Key,
      };
    }
    let replacedR2Key: string | undefined;
    if (existingFile) {
      replacedR2Key =
        priorDriveObjectKeyForCleanup({
          priorR2Key: existingFile.r2Key,
          priorSource: existingFile.source,
          nextR2Key: args.finalR2Key,
        }) ?? undefined;
      await ctx.db.patch(existingFile._id, {
        r2Key: args.finalR2Key,
        name: fileNameFromPath(args.path),
        sizeBytes: args.sizeBytes,
        contentType: args.contentType,
        source: args.source,
        origin:
          args.source === "upload"
            ? "upload"
            : (existingFile.origin ?? existingFile.source),
        uploadId: args.uploadId,
        writeKey: undefined,
        updatedAt: args.now,
      });
      if (replacedR2Key) {
        await queueDriveObjectCleanup(ctx, {
          ownerId: args.ownerId,
          ownerGeneration: lifecycle.generation,
          path: args.path,
          r2Key: replacedR2Key,
          notBefore: args.now + DRIVE_REPLACEMENT_CLEANUP_GRACE_MS,
          now: args.now,
        });
      }
      await applyUsageDelta(
        ctx,
        args.ownerId,
        0,
        args.sizeBytes - existingFile.sizeBytes,
        args.now,
      );
    } else {
      await ctx.db.insert("cloud_drive_files", {
        ownerId: args.ownerId,
        path: args.path,
        r2Key: args.finalR2Key,
        name: fileNameFromPath(args.path),
        sizeBytes: args.sizeBytes,
        contentType: args.contentType,
        source: args.source,
        origin: args.source,
        uploadId: args.uploadId,
        createdAt: args.now,
        updatedAt: args.now,
      });
      await applyUsageDelta(ctx, args.ownerId, 1, args.sizeBytes, args.now);
    }
    // Keep the staging claim as durable cleanup work until its non-revocable
    // presigned PUT has aged out. The live row points only at the immutable
    // final key copied by the server.
    await turnPendingUploadIntoCleanup(ctx, pending, args.now);
    return {
      status: "committed" as const,
      file: {
        path: args.path,
        name: fileNameFromPath(args.path),
        sizeBytes: args.sizeBytes,
        contentType: args.contentType,
        updatedAt: args.now,
      },
      ...(replacedR2Key ? { replacedR2Key } : {}),
    };
  },
});

const queryDriveRows = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  rawPrefix: string | undefined,
  rawLimit: number | undefined,
) => {
  const prefix = normalizeDrivePrefix(rawPrefix);
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, Math.floor(rawLimit ?? DEFAULT_LIST_LIMIT)),
  );
  return prefix
    ? await ctx.db
        .query("cloud_drive_files")
        .withIndex("by_ownerId_and_path", (q) =>
          q
            .eq("ownerId", ownerId)
            .gte("path", prefix)
            .lt("path", `${prefix}\uffff`),
        )
        .take(limit)
    : await ctx.db
        .query("cloud_drive_files")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .order("desc")
        .take(limit);
};

// r2Key stays server-side: the key namespace is not the client's business,
// and a signed URL is the only supported way to read bytes.
const listDriveRows = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  rawPrefix: string | undefined,
  rawLimit: number | undefined,
) => {
  const rows = await queryDriveRows(ctx, ownerId, rawPrefix, rawLimit);
  return rows.map((row) => ({
    path: row.path,
    name: row.name,
    sizeBytes: row.sizeBytes,
    contentType: row.contentType,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
};

// --- Public surface --------------------------------------------------------

/** One drive file as every write path answers with it. */
export type DriveFileRecord = {
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  updatedAt: number;
};

const checkDriveWriteRef = makeFunctionReference<
  "query",
  { ownerId: string; files: Array<{ path: string; sizeBytes: number }> },
  DriveWriteVerdict
>("cloud_drive:checkDriveWriteInternal");
const recordDriveFilesRef = makeFunctionReference<"mutation", any, any>(
  "cloud_drive:recordDriveFilesInternal",
);
const isDriveObjectKeyReferencedRef = makeFunctionReference<
  "query",
  { r2Key: string },
  boolean
>("cloud_drive:isDriveObjectKeyReferencedInternal");
const hasOwnerMigrationSourceFenceRef = makeFunctionReference<
  "query",
  { ownerId: string },
  boolean
>("auth:hasOwnerMigrationSourceFenceInternal");
const recordPendingUploadRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    uploadId: string;
    path: string;
    r2Key: string;
    claimedBytes: number;
    now: number;
  },
  null
>("cloud_drive:recordPendingUploadInternal");
const getPendingUploadRef = makeFunctionReference<
  "query",
  { ownerId: string; ownerGeneration: string; uploadId: string },
  {
    ownerGeneration: string;
    uploadId: string;
    path: string;
    r2Key: string;
    claimedBytes: number;
    createdAt: number;
    expiresAt: number;
  } | null
>("cloud_drive:getPendingUploadInternal");
const claimPendingUploadRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    uploadId: string;
    r2Key: string;
    leaseId: string;
    eligibleBefore: number;
    now: number;
  },
  { claimed: boolean }
>("cloud_drive:claimPendingUploadInternal");
const finishPendingUploadCleanupRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    uploadId: string;
    r2Key: string;
    leaseId: string;
  },
  { finished: boolean }
>("cloud_drive:finishPendingUploadCleanupInternal");
const listStalePendingUploadsRef = makeFunctionReference<
  "query",
  { now: number; limit: number },
  Array<{
    ownerId: string;
    ownerGeneration: string;
    uploadId: string;
    path: string;
    r2Key: string;
    claimedBytes: number;
    createdAt: number;
  }>
>("cloud_drive:listStalePendingUploadsInternal");
const commitDriveUploadRef = makeFunctionReference<"mutation", any, any>(
  "cloud_drive:commitDriveUploadInternal",
);
const queueDriveObjectCleanupRef = makeFunctionReference<"mutation", any, null>(
  "cloud_drive:queueDriveObjectCleanupInternal",
);
const cleanupCanceledPendingUploadRef = makeFunctionReference<
  "action",
  { r2Key: string; attempt?: number },
  { deleted: boolean }
>("cloud_drive:cleanupCanceledPendingUploadInternal");
const listDriveDeletionsRef = makeFunctionReference<
  "query",
  {
    ownerId: string;
    ownerGeneration: string;
    since: number;
    limit: number;
    newestFirst?: boolean;
  },
  {
    deleted: Array<{ path: string; deletedAt: number }>;
    cursor: number | null;
  }
>("cloud_drive:listDriveDeletionsInternal");
const pruneDriveTombstonesRef = makeFunctionReference<
  "mutation",
  { before: number; limit: number },
  { pruned: number }
>("cloud_drive:pruneDriveTombstonesInternal");
const resyncDriveRowSizeRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    path: string;
    r2Key: string;
    sizeBytes: number;
    now: number;
  },
  DriveFileRecord | null
>("cloud_drive:resyncDriveRowSizeInternal");
const getDriveFileRef = makeFunctionReference<
  "query",
  { ownerId: string; ownerGeneration?: string; path: string },
  any
>("cloud_drive:getDriveFileInternal");
const listDriveSyncRowsRef = makeFunctionReference<
  "query",
  {
    ownerId: string;
    ownerGeneration: string;
    prefix?: string;
    limit?: number;
    paths?: string[];
  },
  Array<{
    path: string;
    r2Key: string;
    sizeBytes: number;
    contentType: string;
    source: string;
    updatedAt: number;
  }>
>("cloud_drive:listDriveSyncRowsInternal");
const listDrivePresenceRef = makeFunctionReference<
  "query",
  { ownerId: string; ownerGeneration: string; paths: string[] },
  string[]
>("cloud_drive:listDrivePresenceInternal");
const listDriveFilesRef = makeFunctionReference<
  "query",
  {
    ownerId: string;
    ownerGeneration: string;
    prefix?: string;
    limit?: number;
  },
  any
>("cloud_drive:listDriveFilesInternal");
const deleteDriveFileRowRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    path: string;
    expectedR2Key?: string;
    now: number;
  },
  { deleted: boolean }
>("cloud_drive:deleteDriveFileRowInternal");

/**
 * Step one of a signed-in upload: gate on plan quota, then hand back a
 * presigned PUT for the owner's own key. The row is only written once
 * `finalizeDriveUpload` has confirmed the object landed.
 */
const prepareDriveUploadFor = async (
  ctx: ActionCtx,
  ownerId: string,
  ownerGeneration: string,
  args: { path: string; sizeBytes: number; contentType?: string },
): Promise<{
  path: string;
  uploadId: string;
  uploadUrl: string;
  contentType: string;
}> => {
  await assertExpectedOwnerGenerationActive(ctx, ownerId, ownerGeneration);
  const path = normalizeDrivePath(args.path);
  const sizeBytes = normalizeSize(args.sizeBytes);
  const verdict = await ctx.runQuery(checkDriveWriteRef, {
    ownerId,
    files: [{ path, sizeBytes }],
  });
  if (verdict.skipped.length > 0) {
    throw new ConvexError({
      code: "QUOTA_EXCEEDED",
      message: verdict.skipped[0]!.reason,
    });
  }
  const uploadId = crypto.randomUUID();
  const r2Key = await driveUploadObjectKey(ownerId, uploadId, path);
  const upload = await r2.generateUploadUrl(r2Key);
  // The claim is committed with the owner generation before the URL is handed
  // out. A reset racing this action therefore rejects the capability instead
  // of letting it write into the next generation's namespace.
  await ctx.runMutation(recordPendingUploadRef, {
    ownerId,
    ownerGeneration,
    uploadId,
    path,
    r2Key,
    claimedBytes: sizeBytes,
    now: Date.now(),
  });
  return {
    path,
    uploadId,
    uploadUrl: upload.url,
    contentType: normalizeContentType(args.contentType),
  };
};

export const prepareDriveUpload = action({
  args: {
    path: v.string(),
    sizeBytes: v.number(),
    contentType: v.optional(v.string()),
  },
  returns: v.object({
    path: v.string(),
    uploadId: v.string(),
    uploadUrl: v.string(),
    contentType: v.string(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const { generation } = await assertOwnerDataAccessActive(ctx, ownerId);
    await enforceActionRateLimit(
      ctx,
      "cloud_drive_upload",
      ownerId,
      { rate: 120, periodMs: 60_000 },
      "Too many drive uploads. Wait a moment and try again.",
    );
    return await prepareDriveUploadFor(ctx, ownerId, generation, args);
  },
});

export type DriveReconciliation =
  /** No row named these bytes: unreachable storage, reclaimed. */
  | { outcome: "orphaned" }
  /** The bytes broke the size they were prepared for; object and row removed. */
  | { outcome: "reclaimed" }
  /** A row named them, so the row was moved onto what is actually stored. */
  | { outcome: "adopted"; file: DriveFileRecord }
  /** A row named them and already describes them, or has moved on. */
  | { outcome: "untouched" };

/**
 * Settle an object whose write was refused after the bytes already landed.
 *
 * R2 keys are deterministic per path, so a PUT at a path the owner already
 * has has overwritten that file in place and the previous version cannot be
 * recovered. The rule that follows from that, and the only rule that makes
 * every reclamation path here safe:
 *
 *   bytes are deleted only when no row names them; a row is deleted only when
 *   the bytes at its key broke an explicit size claim.
 *
 * Everything else is repaired instead of destroyed — the row is moved onto
 * what is actually stored and the usage totals move with it, so the bucket
 * and the quota agree without a file having to disappear to make them.
 * `storedBytes` is what the object really holds (never the claim), and
 * `claimedBytes` is the size the write was prepared for.
 */
export const reconcileDriveObject = async (
  ctx: ActionCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    path: string;
    r2Key: string;
    storedBytes: number;
    claimedBytes: number;
  },
): Promise<DriveReconciliation> => {
  const { ownerId, ownerGeneration, path, r2Key } = args;
  await assertExpectedOwnerGenerationActive(ctx, ownerId, ownerGeneration);
  const queueCleanup = async () => {
    const now = Date.now();
    await ctx.runMutation(queueDriveObjectCleanupRef, {
      ownerId,
      ownerGeneration,
      path,
      r2Key,
      notBefore: now,
      now,
    });
  };
  const sourceOwnerIsFenced = await ctx.runQuery(
    hasOwnerMigrationSourceFenceRef,
    { ownerId },
  );
  if (sourceOwnerIsFenced) {
    const isStillReferenced = await ctx.runQuery(
      isDriveObjectKeyReferencedRef,
      { r2Key },
    );
    if (!shouldDeleteReplacedDriveObjectKey(isStillReferenced)) {
      return { outcome: "untouched" };
    }
    await queueCleanup();
    return { outcome: "orphaned" };
  }
  const row = (await ctx.runQuery(getDriveFileRef, {
    ownerId,
    ownerGeneration,
    path,
  })) as {
    r2Key: string;
  } | null;
  if (row?.r2Key !== r2Key) {
    const isStillReferenced = await ctx.runQuery(
      isDriveObjectKeyReferencedRef,
      { r2Key },
    );
    if (!shouldDeleteReplacedDriveObjectKey(isStillReferenced)) {
      return { outcome: "untouched" };
    }
    await queueCleanup();
    return { outcome: "orphaned" };
  }
  if (args.storedBytes > args.claimedBytes) {
    // The claim is what the quota gate was answered with, so bytes past it
    // were never accounted for and the owner is the one who wrote them over
    // their own file. The row is left dangling by the delete, so it goes too.
    const deleted = (await ctx.runMutation(deleteDriveFileRowRef, {
      ownerId,
      ownerGeneration,
      path,
      expectedR2Key: r2Key,
      now: Date.now(),
    })) as { deleted: boolean };
    return deleted ? { outcome: "reclaimed" } : { outcome: "untouched" };
  }
  const file = (await ctx.runMutation(resyncDriveRowSizeRef, {
    ownerId,
    ownerGeneration,
    path,
    r2Key,
    sizeBytes: args.storedBytes,
    now: Date.now(),
  })) as DriveFileRecord | null;
  return file ? { outcome: "adopted", file } : { outcome: "untouched" };
};

const copyDriveObject = async (
  stagingR2Key: string,
  finalR2Key: string,
): Promise<void> => {
  const copySource = [r2.config.bucket, ...stagingR2Key.split("/")]
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  await r2.client.send(
    new CopyObjectCommand({
      Bucket: r2.config.bucket,
      CopySource: copySource,
      Key: finalR2Key,
      MetadataDirective: "COPY",
    }),
  );
};

/**
 * The object's true byte length. The R2 component's stored metadata leaves
 * `size` undefined for this bucket, and a `HEAD` against a presigned GET is
 * refused because the signature covers the method — so the authoritative
 * reading is the `content-range` total of a one-byte ranged GET. Recording
 * zero here would mean uploads charge no quota at all and an oversized PUT
 * could never fail its claim, which is the whole point of the check below.
 */
const resolveObjectSize = async (
  ctx: ActionCtx,
  r2Key: string,
  metadataSize: number | undefined,
): Promise<number> => {
  if (
    typeof metadataSize === "number" &&
    Number.isFinite(metadataSize) &&
    metadataSize >= 0
  ) {
    return Math.floor(metadataSize);
  }
  const url = await r2.getUrl(r2Key, { expiresIn: 120 });
  const response = await fetch(url, { headers: { range: "bytes=0-0" } });
  const total = /\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? "");
  // R2 answers a range against a zero-length object with `bytes */0` and 416.
  if (response.status === 416 && total?.[1] === "0") return 0;
  if (!response.ok) {
    throw new ConvexError({
      code: "DRIVE_UPLOAD_FAILED",
      message: `Storage could not verify the uploaded object (${response.status}).`,
    });
  }
  if (response.status === 206 && total) return Number(total[1]);
  if (response.status === 200) {
    const length = Number(response.headers.get("content-length"));
    if (Number.isSafeInteger(length) && length >= 0) return length;
  }
  throw new ConvexError({
    code: "DRIVE_UPLOAD_FAILED",
    message: "Storage returned no authoritative object size.",
  });
};

/**
 * Step two: confirm the object exists in R2 and record the row from the size
 * R2 reports, not the size the client claimed. An object that outgrew its
 * claim is deleted here — the bucket must never hold bytes that no quota
 * counts — and anything else that goes wrong after the PUT is settled by
 * `reconcileDriveObject`, which repairs the accounting rather than deleting a
 * file the owner can no longer replace.
 */
const finalizeDriveUploadFor = async (
  ctx: ActionCtx,
  ownerId: string,
  ownerGeneration: string,
  args: {
    path: string;
    uploadId: string;
    contentType?: string;
    source?: string;
  },
): Promise<DriveFileRecord> => {
  await assertExpectedOwnerGenerationActive(ctx, ownerId, ownerGeneration);
  const path = normalizeDrivePath(args.path);
  const uploadId = args.uploadId.trim();
  if (!uploadId) throw invalid("An upload id is required.");
  const pending = await ctx.runQuery(getPendingUploadRef, {
    ownerId,
    ownerGeneration,
    uploadId,
  });
  if (!pending) {
    // The commit mutation consumes the claim. A lost action response may retry
    // finalize, so answer from the row only when this exact generation won.
    const installed = (await ctx.runQuery(getDriveFileRef, {
      ownerId,
      ownerGeneration,
      path,
    })) as {
      uploadId?: string;
      path: string;
      name: string;
      sizeBytes: number;
      contentType: string;
      updatedAt: number;
    } | null;
    if (installed?.uploadId === uploadId) {
      return {
        path: installed.path,
        name: installed.name,
        sizeBytes: installed.sizeBytes,
        contentType: installed.contentType,
        updatedAt: installed.updatedAt,
      };
    }
    throw new ConvexError({
      code: "UPLOAD_NOT_FOUND",
      message: "That upload is no longer pending. Start the upload again.",
    });
  }
  if (pending.ownerGeneration !== ownerGeneration) {
    throw new ConvexError({
      code: "OWNER_DATA_GENERATION_STALE",
      message: "This upload started before the account data was reset.",
    });
  }
  if (pending.path !== path) {
    throw invalid("Upload id does not belong to that drive path.");
  }
  const r2Key = pending.r2Key;
  try {
    await r2.syncMetadata(ctx, r2Key);
  } catch {
    throw new ConvexError({
      code: "UPLOAD_NOT_FOUND",
      message: "That upload did not reach storage. Try uploading again.",
    });
  }
  const metadata = await r2.getMetadata(ctx, r2Key);
  if (!metadata) {
    throw new ConvexError({
      code: "UPLOAD_NOT_FOUND",
      message: "That upload did not reach storage. Try uploading again.",
    });
  }
  const stagedSizeBytes = normalizeSize(
    await resolveObjectSize(ctx, r2Key, metadata.size),
  );
  // Copy out of the client-writable staging key before installing a row. A
  // random key per attempt also makes concurrent finalize retries harmless:
  // only the transaction winner is linked; every other copy becomes GC work.
  const finalizationId = crypto.randomUUID();
  const finalR2Key = await driveFinalUploadObjectKey(
    ownerId,
    uploadId,
    finalizationId,
    path,
  );
  const queueFinalCleanup = async (): Promise<void> => {
    const now = Date.now();
    await ctx
      .runMutation(queueDriveObjectCleanupRef, {
        ownerId,
        ownerGeneration,
        path,
        r2Key: finalR2Key,
        notBefore: now,
        now,
      })
      // If lifecycle rotation raced the copy, the normal generation-fenced
      // queue rightly refuses the write. The final key was never exposed or
      // linked, so a best-effort direct delete is safe; owner purge also owns
      // the whole hashed prefix as the durable fallback.
      .catch(async () => {
        // Generation rotation can make the owner-scoped queue unavailable.
        // Preserve the immutable key in a durable scheduled action instead of
        // trusting the component's asynchronous physical-delete retrier.
        await ctx.scheduler.runAfter(0, cleanupCanceledPendingUploadRef, {
          r2Key: finalR2Key,
        });
      });
  };
  try {
    await copyDriveObject(r2Key, finalR2Key);
    await r2.syncMetadata(ctx, finalR2Key);
  } catch (error) {
    await queueFinalCleanup();
    throw error;
  }
  let finalMetadata: Awaited<ReturnType<typeof r2.getMetadata>>;
  try {
    finalMetadata = await r2.getMetadata(ctx, finalR2Key);
  } catch (error) {
    await queueFinalCleanup();
    throw error;
  }
  if (!finalMetadata) {
    await queueFinalCleanup();
    throw new ConvexError({
      code: "DRIVE_UPLOAD_FAILED",
      message: "Storage could not verify the finalized upload.",
    });
  }
  let sizeBytes: number;
  try {
    sizeBytes = normalizeSize(
      await resolveObjectSize(ctx, finalR2Key, finalMetadata.size),
    );
  } catch (error) {
    await queueFinalCleanup();
    throw error;
  }
  // The copy must preserve the staged object exactly. Fail closed if storage
  // reports otherwise; neither size is trusted merely because the client said
  // it was the one prepared.
  if (sizeBytes !== stagedSizeBytes) {
    await queueFinalCleanup();
    throw new ConvexError({
      code: "DRIVE_UPLOAD_FAILED",
      message:
        "Storage changed while the upload was being finalized. Retry it.",
    });
  }
  let result:
    | {
        status: "committed" | "replayed";
        file: DriveFileRecord;
        replacedR2Key?: string;
      }
    | {
        status: "missing" | "size_mismatch" | "quota_exceeded";
        message: string;
        r2Key?: string;
      };
  try {
    result = (await ctx.runMutation(commitDriveUploadRef, {
      ownerId,
      ownerGeneration,
      uploadId,
      path,
      stagingR2Key: r2Key,
      finalizationId,
      finalR2Key,
      sizeBytes,
      contentType: normalizeContentType(
        args.contentType ?? finalMetadata.contentType,
      ),
      source: args.source === "agent" ? "agent" : "upload",
      now: Date.now(),
    })) as typeof result;
  } catch (error) {
    await queueFinalCleanup();
    throw error;
  }
  if ("file" in result) {
    return result.file;
  }
  throw new ConvexError({
    code:
      result.status === "size_mismatch"
        ? "UPLOAD_SIZE_MISMATCH"
        : result.status === "quota_exceeded"
          ? "QUOTA_EXCEEDED"
          : "UPLOAD_NOT_FOUND",
    message: result.message,
  });
};

export const finalizeDriveUpload = action({
  args: {
    path: v.string(),
    uploadId: v.string(),
    contentType: v.optional(v.string()),
    source: v.optional(v.string()),
  },
  returns: v.object({
    path: v.string(),
    name: v.string(),
    sizeBytes: v.number(),
    contentType: v.string(),
    updatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const { generation } = await assertOwnerDataAccessActive(ctx, ownerId);
    return await finalizeDriveUploadFor(ctx, ownerId, generation, args);
  },
});

/**
 * Dev-only probe: drives a real upload end to end for a given owner — the
 * same prepare/PUT/finalize the signed-in client performs, so the presigned
 * URL, the pending claim, the size check and the quota verdict are all the
 * production ones. `putBytes` overrides what is actually PUT so an oversized
 * body can be checked against the claim it was prepared for.
 */
export const driveUploadProbeInternal = internalAction({
  args: {
    ownerId: v.string(),
    path: v.string(),
    content: v.string(),
    claimedBytes: v.optional(v.number()),
    contentType: v.optional(v.string()),
    skipFinalize: v.optional(v.boolean()),
  },
  returns: v.union(
    v.object({
      ok: v.literal(false),
      stage: v.literal("put"),
      status: v.number(),
    }),
    v.object({
      ok: v.literal(true),
      stage: v.literal("put"),
      putBytes: v.number(),
    }),
    v.object({
      ok: v.literal(true),
      stage: v.literal("finalized"),
      file: driveFileRecordValidator,
    }),
    v.object({
      ok: v.literal(false),
      stage: v.literal("finalize"),
      error: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const { generation } = await assertOwnerDataAccessActive(ctx, args.ownerId);
    const bytes = new TextEncoder().encode(args.content);
    const prepared = await prepareDriveUploadFor(
      ctx,
      args.ownerId,
      generation,
      {
        path: args.path,
        sizeBytes: args.claimedBytes ?? bytes.byteLength,
        contentType: args.contentType,
      },
    );
    const put = await fetch(prepared.uploadUrl, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": prepared.contentType },
    });
    if (!put.ok)
      return { ok: false, stage: "put", status: put.status } as const;
    if (args.skipFinalize) {
      return {
        ok: true,
        stage: "put",
        putBytes: bytes.byteLength,
      } as const;
    }
    try {
      const file = await finalizeDriveUploadFor(ctx, args.ownerId, generation, {
        path: args.path,
        uploadId: prepared.uploadId,
        contentType: args.contentType,
      });
      return { ok: true, stage: "finalized", file } as const;
    } catch (error) {
      const data = (error as { data?: unknown }).data;
      return {
        ok: false,
        stage: "finalize",
        error:
          typeof data === "string"
            ? data
            : data === undefined
              ? String(error)
              : JSON.stringify(data),
      } as const;
    }
  },
});

/**
 * Reclaim presigned uploads that were never finalized. Run from a cron: an
 * abandoned PUT is otherwise permanent — it has no row, so `deleteMyDriveFile`
 * cannot reach it and `cloud_drive_usage` never counted it.
 *
 * What it may touch is deliberately narrow. A claim whose bytes landed at a
 * path the owner already has is not an orphan: it is a re-upload of a real
 * file whose finalize was lost, and the version that came before it is gone
 * either way. So the sweep finishes that upload — the row moves onto the
 * bytes and the usage totals move with it — and only ever deletes bytes that
 * no row names. The claim is taken with a compare-and-delete so an upload the
 * owner re-prepared while the sweep was reading is left to its own finalize.
 */
export const sweepStaleDriveUploadsInternal = internalAction({
  args: {
    limit: v.optional(v.number()),
    /**
     * Expiry horizon for the claims this run considers. The cron leaves it
     * alone; a dev probe raises it to reach a claim it just made rather than
     * waiting out the six-hour TTL. Deliberately separate from `now`, which
     * still drives the tombstone prune — a probe must not be able to move the
     * retention window.
     */
    staleBefore: v.optional(v.number()),
  },
  returns: v.object({
    examined: v.number(),
    reclaimed: v.number(),
    adopted: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const stale = (await ctx.runQuery(listStalePendingUploadsRef, {
      now: args.staleBefore ?? now,
      limit: args.limit ?? 100,
    })) as Array<{
      ownerId: string;
      ownerGeneration: string;
      uploadId: string;
      path: string;
      r2Key: string;
      claimedBytes: number;
      createdAt: number;
    }>;
    let reclaimed = 0;
    let adopted = 0;
    for (const row of stale) {
      const leaseId = crypto.randomUUID();
      const claim = (await ctx.runMutation(claimPendingUploadRef, {
        ownerId: row.ownerId,
        uploadId: row.uploadId,
        r2Key: row.r2Key,
        leaseId,
        eligibleBefore: args.staleBefore ?? now,
        now,
      })) as { claimed: boolean };
      if (!claim.claimed) continue;
      const isStillReferenced = await ctx.runQuery(
        isDriveObjectKeyReferencedRef,
        { r2Key: row.r2Key },
      );
      if (!isStillReferenced) {
        const deletion = await ctx.runAction(deleteComponentR2ObjectsRef, {
          objects: [{ locatorId: row.uploadId, r2Key: row.r2Key }],
        });
        if (deletion.confirmedLocatorIds.includes(row.uploadId)) {
          reclaimed += 1;
        } else {
          console.error(
            JSON.stringify({
              service: "convex-cloud-drive",
              event: "drive_object_cleanup_failed",
              uploadId: row.uploadId,
            }),
          );
          // Keep the leased row. A later sweep retries once its lease expires.
          continue;
        }
      }
      await ctx.runMutation(finishPendingUploadCleanupRef, {
        ownerId: row.ownerId,
        uploadId: row.uploadId,
        r2Key: row.r2Key,
        leaseId,
      });
    }
    // Same housekeeping pass, same cadence: a tombstone past the replay window
    // can no longer reach a workspace that would act on it.
    await ctx.runMutation(pruneDriveTombstonesRef, {
      before: now - DRIVE_TOMBSTONE_TTL_MS,
      limit: 500,
    });
    return { examined: stale.length, reclaimed, adopted };
  },
});

export const listMyDriveFiles = query({
  args: { prefix: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.array(driveFileListEntryValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    await assertOwnerDataWriteAllowed(ctx, ownerId);
    return await listDriveRows(ctx, ownerId, args.prefix, args.limit);
  },
});

export const getMyDriveUsage = query({
  args: {},
  returns: v.object({
    plan: v.string(),
    fileCount: v.number(),
    totalBytes: v.number(),
    maxFiles: v.number(),
    maxTotalBytes: v.number(),
    maxFileBytes: v.number(),
  }),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    await assertOwnerDataWriteAllowed(ctx, ownerId);
    const { plan, quota } = await resolveDrivePlan(ctx, ownerId);
    const usage = await getUsageRow(ctx, ownerId);
    return {
      plan,
      fileCount: usage?.fileCount ?? 0,
      totalBytes: usage?.totalBytes ?? 0,
      maxFiles: quota.maxFiles,
      maxTotalBytes: quota.totalBytes,
      maxFileBytes: quota.maxFileBytes,
    };
  },
});

/** Short-lived signed GET for one of the caller's own drive files. */
export const getMyDriveFileUrl = action({
  args: { path: v.string() },
  returns: v.object({
    path: v.string(),
    name: v.string(),
    sizeBytes: v.number(),
    contentType: v.string(),
    url: v.string(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const { generation } = await assertOwnerDataAccessActive(ctx, ownerId);
    const path = normalizeDrivePath(args.path);
    const row = (await ctx.runQuery(getDriveFileRef, {
      ownerId,
      ownerGeneration: generation,
      path,
    })) as {
      r2Key: string;
      name: string;
      sizeBytes: number;
      contentType: string;
    } | null;
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That file is not in your drive.",
      });
    }
    return {
      path,
      name: row.name,
      sizeBytes: row.sizeBytes,
      contentType: row.contentType,
      url: await r2.getUrl(row.r2Key, {
        expiresIn: DOWNLOAD_URL_EXPIRES_SECONDS,
      }),
      expiresAt: Date.now() + DOWNLOAD_URL_EXPIRES_SECONDS * 1_000,
    };
  },
});

export const deleteMyDriveFile = action({
  args: { path: v.string() },
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const { generation } = await assertOwnerDataAccessActive(ctx, ownerId);
    const path = normalizeDrivePath(args.path);
    // Row deletion, usage accounting, tombstone, and durable object cleanup
    // enqueue happen in one transaction. No action-plane read is allowed to
    // race a replacement and then delete the replacement's row.
    return (await ctx.runMutation(deleteDriveFileRowRef, {
      ownerId,
      ownerGeneration: generation,
      path,
      now: Date.now(),
    })) as { deleted: boolean };
  },
});

// --- Route-side helpers (C4) ----------------------------------------------

export type DriveFileReport = {
  path: string;
  name?: string;
  sizeBytes?: number;
  contentType?: string;
  contentBase64?: string;
  /**
   * `updatedAt` of the drive row this turn hydrated for this path. The turn's
   * claim that it read the version it is about to replace; absent means it
   * never saw one.
   */
  knownUpdatedAt?: number;
};

export type NormalizedDriveFile = {
  path: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  bytes: Uint8Array | null;
  knownUpdatedAt: number | null;
};

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/**
 * Validate a produced-files report (C4). Files carrying bytes are capped at
 * 8 MB each and 32 MB per request; anything larger reports metadata only and
 * stays in the workspace.
 */
export const normalizeDriveFileReport = (
  files: DriveFileReport[],
): NormalizedDriveFile[] => {
  if (!Array.isArray(files) || files.length === 0) {
    throw invalid("files must be a non-empty array.");
  }
  if (files.length > DRIVE_MAX_FILES_PER_REPORT) {
    throw invalid(
      `A produced-files report may carry at most ${DRIVE_MAX_FILES_PER_REPORT} files.`,
    );
  }
  let inlineTotal = 0;
  const seenPaths = new Set<string>();
  return files.map((file) => {
    const path = normalizeDrivePath(file.path);
    if (seenPaths.has(path)) {
      throw invalid(
        `${path} appears more than once in the same write. Send one version per path.`,
      );
    }
    seenPaths.add(path);
    let bytes: Uint8Array | null = null;
    if (
      typeof file.contentBase64 === "string" &&
      file.contentBase64.length > 0
    ) {
      try {
        bytes = decodeBase64(file.contentBase64);
      } catch {
        throw invalid(`${path} carried malformed base64 content.`);
      }
      if (bytes.byteLength > DRIVE_INLINE_FILE_LIMIT_BYTES) {
        throw invalid(
          `${path} exceeds the ${formatMb(DRIVE_INLINE_FILE_LIMIT_BYTES)} inline limit. Report it without contentBase64.`,
        );
      }
      inlineTotal += bytes.byteLength;
      if (inlineTotal > DRIVE_INLINE_REQUEST_LIMIT_BYTES) {
        throw invalid(
          `A produced-files report may carry at most ${formatMb(DRIVE_INLINE_REQUEST_LIMIT_BYTES)} of inline content.`,
        );
      }
    }
    return {
      path,
      name: normalizeFileName(file.name, path),
      contentType: normalizeContentType(file.contentType),
      sizeBytes: bytes ? bytes.byteLength : normalizeSize(file.sizeBytes ?? 0),
      bytes,
      knownUpdatedAt:
        typeof file.knownUpdatedAt === "number" &&
        Number.isFinite(file.knownUpdatedAt)
          ? file.knownUpdatedAt
          : null,
    };
  });
};

/**
 * Store one produced file's bytes at the owner's key. A presigned PUT (rather
 * than `r2.store`) so re-running a turn overwrites the object in place instead
 * of colliding with the component's metadata row.
 */
export const putDriveObject = async (
  ownerId: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
  immutableKey?: string,
  signal?: AbortSignal,
): Promise<string> => {
  signal?.throwIfAborted();
  const r2Key = immutableKey ?? (await driveObjectKey(ownerId, path));
  const upload = await r2.generateUploadUrl(r2Key);
  const response = await fetch(upload.url, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: bytes as BodyInit,
    signal,
  });
  signal?.throwIfAborted();
  if (!response.ok) {
    throw new ConvexError({
      code: "DRIVE_UPLOAD_FAILED",
      message: `Storing ${path} failed (${response.status}).`,
    });
  }
  return r2Key;
};

/**
 * Account linking cancels incomplete source-owner upload claims. The signed
 * URL itself cannot be revoked, so auth_migration schedules this both after
 * the cancellation commit and after URL expiry. Never delete a key that a
 * finalized Drive row (including one already re-owned) still references.
 */
export const cleanupCanceledPendingUploadInternal = internalAction({
  args: { r2Key: v.string(), attempt: v.optional(v.number()) },
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, args) => {
    const attempt = Number.isSafeInteger(args.attempt)
      ? Math.max(0, Math.min(args.attempt ?? 0, 30))
      : 0;
    const retryDelay = Math.min(
      DRIVE_ORPHAN_DELETE_RETRY_MAX_MS,
      2 ** Math.min(attempt, 9) * 1_000,
    );
    // Publish the next exact retry before any read or provider I/O. A process
    // crash, response loss, or final component-retrier failure therefore
    // cannot erase the last copy of this immutable object locator.
    const retryId = await ctx.scheduler.runAfter(
      retryDelay,
      cleanupCanceledPendingUploadRef,
      { r2Key: args.r2Key, attempt: attempt + 1 },
    );
    const cancelRetry = async () => {
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
    };
    try {
      const isStillReferenced = await ctx.runQuery(
        isDriveObjectKeyReferencedRef,
        { r2Key: args.r2Key },
      );
      if (!shouldDeleteReplacedDriveObjectKey(isStillReferenced)) {
        await cancelRetry();
        return { deleted: false };
      }
      const locatorId = crypto.randomUUID();
      const deletion = await ctx.runAction(deleteComponentR2ObjectsRef, {
        objects: [{ locatorId, r2Key: args.r2Key }],
      });
      if (!deletion.confirmedLocatorIds.includes(locatorId)) {
        return { deleted: false };
      }
      await cancelRetry();
      return { deleted: true };
    } catch {
      // The already-published retry owns the raw key. Never return provider
      // errors or bucket details through this internal cleanup surface.
      return { deleted: false };
    }
  },
});

// --- Workspace hydration (C2 <-> C3) ---------------------------------------
//
// The drive and the sandbox checkpoint used to be two disjoint stores: bytes
// the user uploaded lived only in R2, bytes the agent wrote lived only in the
// checkpoint until they were reported. A turn that cannot see the file the
// user just attached is a turn that will helpfully write a new one over it.
//
// This is the read half of the loop. Read scope is the same folder the write
// boundary allows (`driveWritePrefixForWorkspace`), so hydration never widens
// what a turn token reaches — a turn in `app:orbit` still cannot see
// `contracts/`.

export type DriveSyncEntry = {
  path: string;
  /** Path under the workspace's drive folder — where it lands on disk. */
  relativePath: string;
  sizeBytes: number;
  contentType: string;
  source: string;
  /** Where the file came from, whoever wrote it last (see the schema). */
  origin: string;
  updatedAt: number;
  url: string;
};

/**
 * A path that is no longer in the drive, for a workspace that may still hold
 * a hydrated copy of it. `relativePath` is where that copy sits under the
 * workspace's drive folder, so applying one is a delete and nothing else.
 */
export type DriveSyncTombstone = {
  path: string;
  relativePath: string;
  deletedAt: number;
};

export type DriveSyncManifest = {
  prefix: string;
  files: DriveSyncEntry[];
  /**
   * In the drive, deliberately not hydrated. Named so the agent can say so —
   * and versioned, because "not hydrated this turn" is not "not in the
   * workspace": on a drive past the per-turn budget these are mostly rows an
   * earlier turn already put on disk, and the caller can only tell which by
   * matching this version against what its ledger recorded holding.
   */
  skipped: Array<{
    path: string;
    sizeBytes: number;
    reason: string;
    updatedAt: number;
    origin: string;
  }>;
  /** Deletions since the caller's cursor; apply before materializing files. */
  deleted: DriveSyncTombstone[];
  /**
   * Of the paths the caller said it is holding (`have`), the ones the drive
   * has no row for. Answered per path, so it is safe to delete a copy of one;
   * a path the caller asked about that is not here was not answered for and
   * must be left alone.
   */
  absent: string[];
  /** Cursor to send back as `since` on the next sync for this workspace. */
  syncedAt: number;
  /** False when deletions older than the caller's cursor may be missing. */
  deletedComplete: boolean;
};

/**
 * Order the drive presents itself to a turn in. Explicit references win —
 * "summarize uploads/report.pdf" must hydrate that file whatever else is in
 * the drive — then the user's own uploads, then everything else newest-first,
 * which for agent output means the files the last turns produced.
 *
 * Ranked on `origin`, not `source`: an upload the agent has since edited is
 * still the user's file, and demoting it here is what would push it out of
 * the byte budget and leave the next turn free to write over it unseen.
 */
const driveSyncRank = (
  row: { path: string; origin: string },
  wanted: Set<string>,
): number => {
  if (wanted.has(row.path)) return 0;
  return row.origin === "upload" ? 1 : 2;
};

export const buildDriveSyncManifest = async (
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  ownerId: string,
  ownerGeneration: string,
  prefix: string,
  include: string[],
  since?: number,
  /** Paths the caller's workspace is holding a hydrated copy of. */
  have: string[] = [],
  signal?: AbortSignal,
): Promise<DriveSyncManifest> => {
  signal?.throwIfAborted();
  const now = Date.now();
  const wanted = new Set<string>();
  for (const raw of include.slice(0, DRIVE_SYNC_MAX_INCLUDE)) {
    try {
      wanted.add(normalizeDrivePath(raw));
    } catch {
      // A prompt is prose: most of what looks like a path is not one.
    }
  }
  // The referenced paths are fetched by name rather than hoped for inside the
  // window: the listing is capped at MAX_LIST_LIMIT and, for a drive
  // workspace, ordered newest-first, so on a larger drive "append the Q4
  // section to reports/annual-2025.md" would otherwise not name that row
  // anywhere in the answer — and a row the manifest does not name is a row the
  // turn never learns exists, hydrates nothing for, and writes a fresh file
  // over. Ranking them first (see `driveSyncRank`) only settles what happens
  // to rows the listing already found.
  const rows = (await ctx.runQuery(listDriveSyncRowsRef, {
    ownerId,
    ownerGeneration,
    ...(prefix ? { prefix } : {}),
    limit: MAX_LIST_LIMIT,
    ...(wanted.size > 0 ? { paths: [...wanted] } : {}),
  })) as Array<{
    path: string;
    r2Key: string;
    sizeBytes: number;
    contentType: string;
    source: string;
    origin: string;
    updatedAt: number;
  }>;
  signal?.throwIfAborted();
  // Prefix-scoped whatever route the row arrived by: `paths` is caller data,
  // and a turn in `app:orbit` may not reach `contracts/`.
  const inScope = rows.filter((row) => row.path.startsWith(prefix));
  const files: DriveSyncEntry[] = [];
  const skipped: DriveSyncManifest["skipped"] = [];
  // "workspace" rows are metadata for bytes that never left a sandbox;
  // presigning one hands out a URL with nothing behind it. They are still the
  // owner's files, so they are named rather than dropped — a path missing
  // from the manifest entirely is one the agent will happily write over.
  for (const row of inScope) {
    if (row.source !== "workspace") continue;
    skipped.push({
      path: row.path,
      sizeBytes: row.sizeBytes,
      reason:
        "it was too large to deliver, so its bytes are in the workspace from the turn that made it rather than in the drive",
      updatedAt: row.updatedAt,
      origin: row.origin,
    });
  }
  const ordered = inScope
    .filter((row) => row.source !== "workspace")
    .sort(
      (a, b) =>
        driveSyncRank(a, wanted) - driveSyncRank(b, wanted) ||
        b.updatedAt - a.updatedAt,
    );

  let usedBytes = 0;
  for (const row of ordered) {
    signal?.throwIfAborted();
    // Per file, not a hard stop: one 200 MB video must not cost the turn the
    // twenty small documents queued behind it.
    if (files.length >= DRIVE_SYNC_MAX_FILES) {
      skipped.push({
        path: row.path,
        sizeBytes: row.sizeBytes,
        reason: `only the ${DRIVE_SYNC_MAX_FILES} most relevant drive files are loaded into a turn`,
        updatedAt: row.updatedAt,
        origin: row.origin,
      });
      continue;
    }
    if (usedBytes + row.sizeBytes > DRIVE_SYNC_MAX_BYTES) {
      skipped.push({
        path: row.path,
        sizeBytes: row.sizeBytes,
        reason: `it does not fit the ${formatMb(DRIVE_SYNC_MAX_BYTES)} a turn loads`,
        updatedAt: row.updatedAt,
        origin: row.origin,
      });
      continue;
    }
    usedBytes += row.sizeBytes;
    const url = await r2.getUrl(row.r2Key, {
      expiresIn: DRIVE_SYNC_URL_EXPIRES_SECONDS,
    });
    signal?.throwIfAborted();
    files.push({
      path: row.path,
      relativePath: row.path.slice(prefix.length),
      sizeBytes: row.sizeBytes,
      contentType: row.contentType,
      source: row.source,
      origin: row.origin,
      updatedAt: row.updatedAt,
      url,
    });
  }

  // What the caller may stop holding, answered per path rather than inferred
  // from what this manifest happens to name.
  //
  // `rows` above is capped at MAX_LIST_LIMIT, so on a drive larger than that
  // window a live row is simply not in `files` or `skipped` — and a caller
  // that read absence from the manifest as deletion would unlink a file the
  // user still has, deterministically and forever, since the same rows fall
  // outside the window on every later sync. So the caller names what it is
  // holding and this answers for exactly those paths by point lookup. Paths
  // the manifest already names are live by construction and cost no read; a
  // path beyond the per-sync bound is left unanswered, which the caller reads
  // as "keep it".
  //
  // Scoped to the same prefix as the rest of the answer: `absent` is an
  // existence oracle, and a turn in `app:orbit` may not ask it about
  // `contracts/`.
  const listed = new Set<string>([
    ...files.map((entry) => entry.path),
    ...skipped.map((entry) => entry.path),
  ]);
  const asked: string[] = [];
  const askedSeen = new Set<string>();
  for (const raw of have.slice(0, DRIVE_SYNC_MAX_PRESENCE)) {
    let candidate: string;
    try {
      candidate = normalizeDrivePath(raw);
    } catch {
      continue;
    }
    if (!candidate.startsWith(prefix)) continue;
    if (listed.has(candidate) || askedSeen.has(candidate)) continue;
    askedSeen.add(candidate);
    asked.push(candidate);
  }
  const present =
    asked.length > 0
      ? new Set(
          (await ctx.runQuery(listDrivePresenceRef, {
            ownerId,
            ownerGeneration,
            paths: asked,
          })) as string[],
        )
      : new Set<string>();
  signal?.throwIfAborted();
  const absent = asked.filter((candidate) => !present.has(candidate));

  // Deletions the caller's workspace has not applied yet. A workspace that
  // has never synced (or synced before the replay window) gets whatever is
  // still retained plus `deletedComplete: false`, because a checkpoint older
  // than the window can hold a copy of a file no tombstone survives for.
  const horizon = now - DRIVE_TOMBSTONE_TTL_MS;
  // Clamped to the clock: the caller's cursor is a value this service issued
  // on an earlier sync, so one from a future it has not reached was written by
  // something other than a sync. Believing it would ask for deletions after
  // the end of time and answer `deletedComplete` for a window nothing was read
  // from.
  const cursor =
    typeof since === "number" && Number.isFinite(since) && since > 0
      ? Math.min(Math.floor(since), now)
      : 0;
  const tombstones = (await ctx.runQuery(listDriveDeletionsRef, {
    ownerId,
    ownerGeneration,
    since: Math.max(cursor, horizon),
    limit: DRIVE_SYNC_MAX_DELETIONS,
  })) as {
    deleted: Array<{ path: string; deletedAt: number }>;
    cursor: number | null;
  };
  signal?.throwIfAborted();
  // The cursor above rides in the caller's workspace, where the agent can
  // write it: a turn that leaves itself a far-future `syncedAt` (and drops the
  // hydration ledger the executor cross-checks it against) would otherwise
  // move this window past every deletion that follows, forever, and keep a
  // file the user deleted readable in the sandbox — R8 with its own mechanism
  // turned off. So the answer always carries the drive's most recent
  // deletions as well, which is a question about the drive rather than about
  // the caller. The ascending window still does the work that needs a cursor:
  // walking a backlog larger than one answer can carry.
  const recent = (await ctx.runQuery(listDriveDeletionsRef, {
    ownerId,
    ownerGeneration,
    since: horizon,
    limit: DRIVE_SYNC_MAX_DELETIONS,
    newestFirst: true,
  })) as { deleted: Array<{ path: string; deletedAt: number }> };
  signal?.throwIfAborted();
  const seen = new Set<string>();
  const deleted: DriveSyncTombstone[] = [];
  for (const entry of [...tombstones.deleted, ...recent.deleted]) {
    if (!entry.path.startsWith(prefix) || seen.has(entry.path)) continue;
    seen.add(entry.path);
    deleted.push({
      path: entry.path,
      relativePath: entry.path.slice(prefix.length),
      deletedAt: entry.deletedAt,
    });
  }
  return {
    prefix,
    files,
    skipped,
    deleted,
    absent,
    // A truncated window leaves the cursor where the window ended, so the
    // next sync picks up the rest instead of stepping over it. Replaying a
    // tombstone twice is a no-op, so resuming at the same millisecond is safe.
    syncedAt: tombstones.cursor ?? now,
    deletedComplete: tombstones.cursor === null && cursor >= horizon,
  };
};

// Dev probe: exercises register -> list -> signed URL -> delete without a
// signed-in client. Run with `bunx convex run`.
export const driveProbeInternal = internalAction({
  args: { ownerId: v.string(), path: v.optional(v.string()) },
  returns: v.object({
    path: v.string(),
    registered: v.boolean(),
    listed: v.boolean(),
    downloadable: v.boolean(),
    deleted: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { generation } = await assertOwnerDataAccessActive(ctx, args.ownerId);
    const path = normalizeDrivePath(args.path ?? "probe/drive-probe.txt");
    const bytes = new TextEncoder().encode(`stella drive probe ${Date.now()}`);
    const r2Key = await putDriveObject(
      args.ownerId,
      path,
      bytes,
      "text/plain; charset=utf-8",
    );
    const recorded = (await ctx.runMutation(recordDriveFilesRef, {
      ownerId: args.ownerId,
      ownerGeneration: generation,
      files: [
        {
          path,
          r2Key,
          name: fileNameFromPath(path),
          sizeBytes: bytes.byteLength,
          contentType: "text/plain; charset=utf-8",
          source: "agent",
        },
      ],
      now: Date.now(),
    })) as { files: unknown[]; replacedR2Keys: string[] };
    const listed = (await ctx.runQuery(listDriveFilesRef, {
      ownerId: args.ownerId,
      ownerGeneration: generation,
      prefix: path,
    })) as Array<{ path: string }>;
    const url = await r2.getUrl(r2Key, { expiresIn: 60 });
    const download = await fetch(url);
    const body = download.ok ? await download.text() : "";
    const removed = (await ctx.runMutation(deleteDriveFileRowRef, {
      ownerId: args.ownerId,
      ownerGeneration: generation,
      path,
      now: Date.now(),
    })) as { deleted: boolean };
    return {
      path,
      registered: recorded.files.length === 1,
      listed: listed.some((row) => row.path === path),
      downloadable: body.startsWith("stella drive probe"),
      deleted: removed.deleted,
    };
  },
});

// Dev-only probe: resolves an existing drive file down the same signed-URL
// path `getMyDriveFileUrl` serves to the UI, and reports what actually came
// back over the wire.
export const driveFetchProbeInternal = internalAction({
  args: { ownerId: v.string(), path: v.string() },
  returns: v.object({
    found: v.boolean(),
    contentType: v.string(),
    sizeBytes: v.number(),
    fetchedBytes: v.number(),
    httpStatus: v.number(),
    zipMagic: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const path = normalizeDrivePath(args.path);
    const row = (await ctx.runQuery(getDriveFileRef, {
      ownerId: args.ownerId,
      path,
    })) as {
      r2Key: string;
      sizeBytes: number;
      contentType: string;
    } | null;
    if (!row) {
      return {
        found: false,
        contentType: "",
        sizeBytes: 0,
        fetchedBytes: 0,
        httpStatus: 0,
        zipMagic: false,
      };
    }
    const url = await r2.getUrl(row.r2Key, {
      expiresIn: DOWNLOAD_URL_EXPIRES_SECONDS,
    });
    const response = await fetch(url);
    const bytes = response.ok
      ? new Uint8Array(await response.arrayBuffer())
      : new Uint8Array();
    return {
      found: true,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      fetchedBytes: bytes.byteLength,
      httpStatus: response.status,
      // Every OOXML file is a zip; "PK\x03\x04" proves real bytes came back
      // rather than an error page with a 200.
      zipMagic:
        bytes[0] === 0x50 &&
        bytes[1] === 0x4b &&
        bytes[2] === 0x03 &&
        bytes[3] === 0x04,
    };
  },
});

/** Dev-only probe: what R2 reports for an owner's object, unfiltered. */
export const driveMetadataProbeInternal = internalAction({
  args: {
    ownerId: v.string(),
    path: v.string(),
    sync: v.optional(v.boolean()),
  },
  returns: v.object({
    r2Key: v.string(),
    metadata: v.union(r2MetadataValidator, v.null()),
  }),
  handler: async (ctx, args) => {
    const r2Key = await driveObjectKey(
      args.ownerId,
      normalizeDrivePath(args.path),
    );
    if (args.sync !== false)
      await r2.syncMetadata(ctx, r2Key).catch(() => undefined);
    return { r2Key, metadata: await r2.getMetadata(ctx, r2Key) };
  },
});
