/**
 * The owner's drive: file records and uploads. The bytes live in `DRIVE`.
 *
 * - **Keys:** every object sits under `drive/<sha256(owner)>/`, derived here
 *   and never taken from a caller, so one owner cannot name another's bytes.
 *   Byte-bearing rows point at immutable keys (an upload's final copy, or one
 *   produced-files write), so a stale signed PUT or a redelivered batch can
 *   only ever create its own orphan, never overwrite live bytes.
 * - **Uploads:** `drive.prepareUpload` hands out a presigned PUT to a staging
 *   key and records the claimed size; `drive.finalizeUpload` reads the real
 *   size from storage, copies the bytes out of the staging key (whose PUT
 *   cannot be revoked) and installs the row. Quotas come from the billing
 *   plan in this same object; usage is a `SUM()` over the rows.
 * - **Cleanup:** `drive_uploads` doubles as the durable cleanup queue. Any
 *   object that may exist without a row (a pending or rejected upload, a
 *   replaced or deleted file, a write that lost a race) is a row there, and
 *   `drive.cleanup` deletes it once no file row names its key.
 * - **Turns:** agent and tool writes, workspace hydration and chat
 *   attachments are server-internal operations (`drive.turn*`), called by
 *   the turn broker and the orchestrator under the turn's owner generation.
 *   The drive is the only durable home of these files: a cloud world holds a
 *   working copy of some of them and never stores it, so every agent write
 *   carries its bytes here — inline below `DRIVE_INLINE_FILE_LIMIT_BYTES`,
 *   staged through a presigned PUT (`drive.turnStage`) above it.
 */

import type {
  DeviceFileLocation,
  DriveFile,
  DriveFileRecord,
  DriveFileUrl,
} from "@stella/contracts/backend/drive";
import { DEVICE_FILE_COPY_LIMITS } from "@stella/contracts/device-files";
import { copyR2Object, presignR2Url, r2Signer, type R2Signer } from "../../r2-presign.js";
import { sha256Hex } from "../../hash.js";
import { array, number, object, optional, string } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDbReader, OwnerDomain } from "../registry.js";
import { billingPlan } from "./billing.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

type DriveQuota = { totalBytes: number; maxFiles: number; maxFileBytes: number };

const PLAN_QUOTAS: Record<"free" | "go" | "pro", DriveQuota> = {
  free: { totalBytes: 256 * MB, maxFiles: 200, maxFileBytes: 25 * MB },
  go: { totalBytes: 10 * GB, maxFiles: 1_000, maxFileBytes: 100 * MB },
  pro: { totalBytes: 50 * GB, maxFiles: 5_000, maxFileBytes: 250 * MB },
};
const UNLIMITED_QUOTA: DriveQuota = {
  totalBytes: 200 * GB,
  maxFiles: 200_000,
  maxFileBytes: 2_048 * MB,
};

/** Bytes above this are staged through a presigned PUT, never inlined. */
export const DRIVE_INLINE_FILE_LIMIT_BYTES = 8 * MB;
/** Inline bytes one produced-files report may carry. */
const DRIVE_INLINE_REQUEST_LIMIT_BYTES = 32 * MB;
const DRIVE_MAX_FILES_PER_REPORT = 50;

const MAX_PATH_LENGTH = 400;
const MAX_SEGMENT_LENGTH = 255;
const MAX_CONTENT_TYPE_LENGTH = 200;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

const DOWNLOAD_URL_EXPIRES_SECONDS = 900;
/** A presigned PUT must start within this; a slow body may take longer. */
const UPLOAD_URL_EXPIRES_SECONDS = 60 * 60;
/**
 * How long a prepared upload stays claimable before cleanup reclaims what it
 * left. Generous: a slow phone uploading a large file must not be cut off.
 */
const PENDING_UPLOAD_TTL_MS = 6 * 60 * 60_000;
/** A failed cleanup is retried once its lease expires. */
const CLEANUP_LEASE_MS = 5 * 60_000;
const CLEANUP_BATCH = 100;
/** Keep retired bytes alive for signed GETs already handed to a client. */
const REPLACEMENT_GRACE_MS = DOWNLOAD_URL_EXPIRES_SECONDS * 1_000;
/** Cleanup debt for an object being written must outlive the write. */
const WRITE_DEBT_GRACE_MS = 15 * 60_000;

/** What one turn hydrates; see `turnSync`. */
const SYNC_MAX_FILES = 100;
const SYNC_MAX_BYTES = 128 * MB;
const SYNC_URL_EXPIRES_SECONDS = 1_800;
const SYNC_MAX_INCLUDE = 25;
const SYNC_MAX_DELETIONS = 100;
const SYNC_MAX_PRESENCE = 500;
/** One staging call; each entry is one presigned PUT. */
const STAGE_MAX_FILES = 25;
/** A staged PUT must start within this; the turn uploads right away. */
const STAGE_URL_EXPIRES_SECONDS = 30 * 60;
/** Unclaimed staged bytes are reclaimed after this. */
const STAGE_TTL_MS = 2 * 60 * 60_000;
/** Conditional deletes one turn report may carry. */
const DELETE_MAX_FILES = 100;
/** One resident read; matches the world's own read ceiling. */
const READ_MAX_BYTES = 8 * MB;
/** How long a deletion stays replayable to a workspace that has not synced. */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60_000;
const TOMBSTONE_PRUNE_EVERY_MS = 24 * 60 * 60_000;

/** Chat-turn image attachments, bounded so the turn's prompt stays small. */
const ATTACHMENT_MAX_COUNT = 4;
const ATTACHMENT_MAX_BYTES = 3 * MB;
const ATTACHMENT_URL_EXPIRES_SECONDS = 120;
/** Reference images handed to the media provider. */
const REFERENCE_MAX_COUNT = 4;
const REFERENCE_URL_EXPIRES_SECONDS = 2 * 60 * 60;

export const DRIVE_CLEANUP_JOB = "drive.cleanup";
export const DRIVE_PRUNE_JOB = "drive.pruneTombstones";

export const DRIVE_MIGRATION = {
  id: "drive.1-init",
  statements: [
    `CREATE TABLE drive_files (
       path TEXT PRIMARY KEY,
       r2_key TEXT NOT NULL,
       name TEXT NOT NULL,
       size_bytes INTEGER NOT NULL,
       content_type TEXT NOT NULL,
       source TEXT NOT NULL,
       origin TEXT NOT NULL,
       write_key TEXT,
       upload_id TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE INDEX drive_files_updated_at ON drive_files (updated_at)`,
    `CREATE INDEX drive_files_r2_key ON drive_files (r2_key)`,
    `CREATE TABLE drive_uploads (
       upload_id TEXT PRIMARY KEY,
       path TEXT NOT NULL,
       r2_key TEXT NOT NULL,
       status TEXT NOT NULL,
       claimed_bytes INTEGER NOT NULL,
       created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       lease_id TEXT,
       lease_expires_at INTEGER
     )`,
    `CREATE INDEX drive_uploads_expires_at ON drive_uploads (expires_at)`,
    `CREATE TABLE drive_deletions (
       path TEXT PRIMARY KEY,
       deleted_at INTEGER NOT NULL
     )`,
    `CREATE INDEX drive_deletions_deleted_at ON drive_deletions (deleted_at)`,
  ],
};

export const DRIVE_DEVICE_FILES_MIGRATION = {
  id: "drive.2-device-files",
  statements: [
    `CREATE TABLE drive_device_files (
       device_id TEXT NOT NULL,
       source_path TEXT NOT NULL,
       device_name TEXT NOT NULL,
       drive_path TEXT,
       name TEXT NOT NULL,
       size_bytes INTEGER NOT NULL,
       content_type TEXT NOT NULL,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (device_id, source_path)
     )`,
    `CREATE INDEX drive_device_files_source ON drive_device_files (source_path, updated_at)`,
  ],
};

const MAX_DEVICE_FILE_SOURCE_CHARS = 4_000;
const MAX_DEVICE_FILES_PER_RECORD = 50;
const MAX_DEVICE_FILE_ROWS = 20_000;
const MAX_DEVICES_PER_SOURCE_PATH = 8;

type DeviceFileRow = {
  device_id: string;
  source_path: string;
  device_name: string;
  drive_path: string | null;
  name: string;
  size_bytes: number;
  content_type: string;
  updated_at: number;
};

type FileRow = {
  path: string;
  r2_key: string;
  name: string;
  size_bytes: number;
  content_type: string;
  source: string;
  origin: string;
  write_key: string | null;
  upload_id: string | null;
  created_at: number;
  updated_at: number;
};

type UploadRow = {
  upload_id: string;
  path: string;
  r2_key: string;
  status: "pending" | "cleanup";
  claimed_bytes: number;
  created_at: number;
  expires_at: number;
  lease_id: string | null;
  lease_expires_at: number | null;
};

// ── Normalization ────────────────────────────────────────────────────────

const invalid = (message: string) => new RpcError("BAD_REQUEST", message);

/**
 * A drive-relative POSIX path. Refuses absolute paths, drive letters, `.` and
 * `..` segments and control characters, so a path can never escape the
 * owner's prefix or the workspace folder it maps to.
 */
export const normalizeDrivePath = (raw: string): string => {
  const value = (raw ?? "").trim().replaceAll("\\", "/");
  if (!value) throw invalid("A drive path is required.");
  if (value.length > MAX_PATH_LENGTH) {
    throw invalid(`Drive paths must be ${MAX_PATH_LENGTH} characters or fewer.`);
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

const normalizeDrivePrefix = (raw: string | undefined): string => {
  const value = (raw ?? "").trim().replaceAll("\\", "/");
  if (!value || value === "/") return "";
  const normalized = normalizeDrivePath(value);
  return value.endsWith("/") ? `${normalized}/` : normalized;
};

const normalizeContentType = (raw: string | undefined): string => {
  const value = (raw ?? "").trim();
  if (
    !value ||
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

const fileNameFromPath = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

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
 * Where an agent's version of a file goes when the drive holds bytes the user
 * uploaded that this turn never read: same folder, same extension, side by
 * side, so the user decides which one wins.
 */
export const driveRevisionPath = (path: string): string => {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const revised =
    dot > 0 ? `${name.slice(0, dot)} (agent copy)${name.slice(dot)}` : `${name} (agent copy)`;
  return `${path.slice(0, slash + 1)}${revised}`;
};

// Sub-megabyte values round to "0 MB"; drop to KB below 1 MB, and say GB
// from 1 GB up so a plan's ceiling reads the way the plan states it.
const formatMb = (bytes: number): string =>
  bytes < MB
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : bytes < GB
      ? `${Math.round((bytes / MB) * 10) / 10} MB`
      : `${Math.round((bytes / GB) * 10) / 10} GB`;

// ── Storage ──────────────────────────────────────────────────────────────

const unavailable = () =>
  new RpcError("UNAVAILABLE", "The drive is unavailable right now. Try again shortly.", {
    retryAfterMs: 5_000,
  });

const bucketOf = (ctx: Pick<OwnerContext, "env">): R2Bucket => {
  const bucket = ctx.env.DRIVE;
  if (!bucket) throw unavailable();
  return bucket;
};

const signerOf = (ctx: Pick<OwnerContext, "env">): R2Signer => {
  const signer = r2Signer(ctx.env, ctx.env.R2_DRIVE_BUCKET);
  if (!signer) throw unavailable();
  return signer;
};

/** `drive/<sha256(owner)>/`: everything this owner's drive stores. */
export const driveOwnerPrefix = async (ownerId: string): Promise<string> =>
  `drive/${await sha256Hex(ownerId)}/`;

const signGet = async (
  signer: R2Signer,
  key: string,
  expiresInSeconds: number,
  now?: number,
): Promise<string> =>
  await presignR2Url(signer, {
    method: "GET",
    key,
    expiresInSeconds,
    ...(now !== undefined ? { now } : {}),
  });

// ── Rows ─────────────────────────────────────────────────────────────────

const getFile = (db: OwnerDbReader, path: string): FileRow | null =>
  db.one<FileRow>("SELECT * FROM drive_files WHERE path = ?", path);

const isKeyReferenced = (db: OwnerDbReader, r2Key: string): boolean =>
  db.one("SELECT 1 AS present FROM drive_files WHERE r2_key = ? LIMIT 1", r2Key) !== null;

const usage = (db: OwnerDbReader): { fileCount: number; totalBytes: number } => {
  const row = db.one<{ files: number; bytes: number | null }>(
    "SELECT COUNT(*) AS files, SUM(size_bytes) AS bytes FROM drive_files",
  );
  return { fileCount: row?.files ?? 0, totalBytes: row?.bytes ?? 0 };
};

const fileRecord = (row: FileRow): DriveFileRecord => ({
  path: row.path,
  name: row.name,
  sizeBytes: row.size_bytes,
  contentType: row.content_type,
  updatedAt: row.updated_at,
});

/**
 * Arm a job at `at` unless it is already due sooner. Scheduling under a fixed
 * id replaces the pending run, so a later time must never displace an
 * earlier one.
 */
const armJob = (ctx: OwnerContext, kind: string, at: number): void => {
  const pending = ctx.db.one<{ run_at: number }>(
    "SELECT run_at FROM owner_jobs WHERE id = ?",
    kind,
  );
  if (pending && pending.run_at <= at) return;
  ctx.jobs.schedule(kind, at, null, { id: kind });
};

/**
 * Durable cleanup for an object that may exist without a row. The object is
 * deleted after `notBefore` unless a file row names its key by then.
 */
const queueCleanup = (
  ctx: OwnerContext,
  entry: { path: string; r2Key: string; notBefore: number },
): string => {
  const id = `cleanup-${crypto.randomUUID()}`;
  ctx.db.run(
    `INSERT INTO drive_uploads (upload_id, path, r2_key, status, claimed_bytes, created_at, expires_at)
     VALUES (?, ?, ?, 'cleanup', 0, ?, ?)`,
    id,
    entry.path,
    entry.r2Key,
    ctx.now,
    entry.notBefore,
  );
  armJob(ctx, DRIVE_CLEANUP_JOB, entry.notBefore);
  return id;
};

/** A prepared upload that will never be finalized: its staging bytes become cleanup. */
const retirePendingUpload = (ctx: OwnerContext, row: UploadRow, now: number): void => {
  // The presigned PUT cannot be revoked, so the staging key is reclaimed no
  // sooner than the original abandonment horizon.
  const expiresAt = Math.max(row.expires_at, now);
  ctx.db.run(
    `UPDATE drive_uploads SET status = 'cleanup', expires_at = ?, lease_id = NULL, lease_expires_at = NULL
     WHERE upload_id = ?`,
    expiresAt,
    row.upload_id,
  );
  armJob(ctx, DRIVE_CLEANUP_JOB, expiresAt);
};

/**
 * The record that a path is gone, so a workspace holding a hydrated copy can
 * be told to drop it. One row per path, refreshed rather than duplicated.
 */
const recordTombstone = (ctx: OwnerContext, path: string, deletedAt: number): void => {
  ctx.db.run(
    `INSERT INTO drive_deletions (path, deleted_at) VALUES (?, ?)
     ON CONFLICT (path) DO UPDATE SET deleted_at = excluded.deleted_at`,
    path,
    deletedAt,
  );
  armJob(ctx, DRIVE_PRUNE_JOB, deletedAt + TOMBSTONE_TTL_MS);
};

/**
 * Delete a row, leave its tombstone and queue its bytes. `expectedR2Key`
 * makes the delete conditional on the row still naming those bytes.
 */
const deleteFileRow = (
  ctx: OwnerContext,
  path: string,
  now: number,
  expectedR2Key?: string,
): boolean => {
  const row = getFile(ctx.db, path);
  if (!row) return false;
  if (expectedR2Key !== undefined && row.r2_key !== expectedR2Key) return false;
  ctx.db.run("DELETE FROM drive_files WHERE path = ?", path);
  recordTombstone(ctx, path, now);
  queueCleanup(ctx, { path, r2Key: row.r2_key, notBefore: now + REPLACEMENT_GRACE_MS });
  return true;
};

// ── Quota ────────────────────────────────────────────────────────────────

type WriteCandidate = { path: string; sizeBytes: number };

type WriteVerdict = {
  accepted: WriteCandidate[];
  skipped: Array<{ path: string; reason: string }>;
};

/**
 * Per-file plan quota. Replacing a path charges only the difference, so
 * re-saving a file never walks an owner into their ceiling; the files that
 * fit are accepted and the rest come back with the reason to show.
 */
const partitionWrite = (
  ctx: Pick<OwnerContext, "db" | "env" | "now">,
  files: WriteCandidate[],
): WriteVerdict => {
  const { plan, unlimited } = billingPlan(ctx);
  const quota = unlimited ? UNLIMITED_QUOTA : PLAN_QUOTAS[plan];
  const planLabel = plan === "free" ? "Free" : plan;
  let { fileCount, totalBytes } = usage(ctx.db);
  const occurrences = new Map<string, number>();
  for (const file of files) occurrences.set(file.path, (occurrences.get(file.path) ?? 0) + 1);
  const accepted: WriteCandidate[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
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
    const prior = getFile(ctx.db, file.path)?.size_bytes ?? null;
    const nextFileCount = prior === null ? fileCount + 1 : fileCount;
    const nextTotalBytes = totalBytes - (prior ?? 0) + file.sizeBytes;
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
    accepted.push(file);
  }
  return { accepted, skipped };
};

const quotaExceeded = (message: string) =>
  new RpcError("FORBIDDEN", message, { reason: "quota_exceeded" });

// ── Calls ────────────────────────────────────────────────────────────────

const prepareUpload = async (
  ctx: OwnerContext,
  args: { path: string; sizeBytes: number; contentType?: string },
) => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "drive.upload",
    { count: 120, windowMs: 60_000 },
    "Too many drive uploads. Wait a moment and try again.",
  );
  const path = normalizeDrivePath(args.path);
  const sizeBytes = normalizeSize(args.sizeBytes);
  const verdict = partitionWrite(ctx, [{ path, sizeBytes }]);
  if (verdict.skipped.length > 0) throw quotaExceeded(verdict.skipped[0]!.reason);
  const signer = signerOf(ctx);
  const uploadId = crypto.randomUUID();
  // Every upload has its own key, so an old signed PUT can only recreate its
  // own orphan, never overwrite what a newer upload installed.
  const r2Key = `${await driveOwnerPrefix(ctx.ownerId)}uploads/${uploadId}/${path}`;
  const uploadUrl = await presignR2Url(signer, {
    method: "PUT",
    key: r2Key,
    expiresInSeconds: UPLOAD_URL_EXPIRES_SECONDS,
  });
  const now = Date.now();
  // The claim is what makes the client's size enforceable at finalize, and
  // what lets cleanup reclaim bytes that were never finalized.
  ctx.db.run(
    `INSERT INTO drive_uploads (upload_id, path, r2_key, status, claimed_bytes, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    uploadId,
    path,
    r2Key,
    sizeBytes,
    now,
    now + PENDING_UPLOAD_TTL_MS,
  );
  armJob(ctx, DRIVE_CLEANUP_JOB, now + PENDING_UPLOAD_TTL_MS);
  return { path, uploadId, uploadUrl, contentType: normalizeContentType(args.contentType) };
};

/**
 * Record a prepared upload from what storage holds, never from the claim.
 * Bytes past the claim are refused (the quota answered the claim), and the
 * row only ever names a server-made copy of the staging object.
 */
const finalizeUpload = async (
  ctx: OwnerContext,
  args: { path: string; uploadId: string; contentType?: string; source?: string },
): Promise<DriveFileRecord> => {
  const path = normalizeDrivePath(args.path);
  const uploadId = args.uploadId.trim();
  if (!uploadId) throw invalid("An upload id is required.");
  const pendingRow = (): UploadRow | null =>
    ctx.db.one<UploadRow>("SELECT * FROM drive_uploads WHERE upload_id = ?", uploadId);
  // A finalize whose response was lost answers from the row its upload installed.
  const replayOrMissing = (): DriveFileRecord => {
    const installed = getFile(ctx.db, path);
    if (installed?.upload_id === uploadId) return fileRecord(installed);
    throw new RpcError("NOT_FOUND", "That upload is no longer pending. Start the upload again.", {
      reason: "upload_not_found",
    });
  };
  const pending = pendingRow();
  if (!pending || pending.status !== "pending") return replayOrMissing();
  if (pending.path !== path) throw invalid("Upload id does not belong to that drive path.");

  const bucket = bucketOf(ctx);
  const signer = signerOf(ctx);
  const staged = await bucket.head(pending.r2_key);
  if (!staged) {
    throw new RpcError("NOT_FOUND", "That upload did not reach storage. Try uploading again.", {
      reason: "upload_not_found",
    });
  }
  const stagedBytes = staged.size;
  const refuse = (error: RpcError): never => {
    const current = pendingRow();
    if (current?.status === "pending") retirePendingUpload(ctx, current, Date.now());
    throw error;
  };
  if (stagedBytes > pending.claimed_bytes) {
    refuse(
      new RpcError(
        "CONFLICT",
        `That upload is ${formatMb(stagedBytes)}, larger than the ${formatMb(pending.claimed_bytes)} it was prepared for. Start the upload again.`,
        { reason: "upload_size_mismatch" },
      ),
    );
  }
  const preflight = partitionWrite(ctx, [{ path, sizeBytes: stagedBytes }]);
  if (preflight.accepted.length === 0) {
    refuse(quotaExceeded(preflight.skipped[0]?.reason ?? "Drive quota exceeded."));
  }

  // One key per finalize attempt: concurrent retries each copy to their own
  // key and only the commit winner is linked. Debt first, so a crash after
  // the copy still reclaims it.
  const finalKey = `${await driveOwnerPrefix(ctx.ownerId)}files/${uploadId}/${crypto.randomUUID()}/${path}`;
  const debtId = queueCleanup(ctx, { path, r2Key: finalKey, notBefore: ctx.now + WRITE_DEBT_GRACE_MS });
  try {
    await copyR2Object(signer, { from: pending.r2_key, to: finalKey });
  } catch {
    throw unavailable();
  }
  const copied = await bucket.head(finalKey);
  if (!copied || copied.size !== stagedBytes) {
    throw new RpcError("UNAVAILABLE", "Storage changed while the upload was being finalized. Retry it.");
  }

  // Commit: no awaits from here, so nothing interleaves with the checks.
  const now = Date.now();
  const current = pendingRow();
  if (!current || current.status !== "pending") return replayOrMissing();
  const verdict = partitionWrite({ db: ctx.db, env: ctx.env, now }, [{ path, sizeBytes: stagedBytes }]);
  if (verdict.accepted.length === 0) {
    refuse(quotaExceeded(verdict.skipped[0]?.reason ?? "Drive quota exceeded."));
  }
  const contentType = normalizeContentType(args.contentType ?? copied.httpMetadata?.contentType);
  const source = args.source === "agent" ? "agent" : "upload";
  const name = fileNameFromPath(path);
  const existing = getFile(ctx.db, path);
  if (existing) {
    ctx.db.run(
      `UPDATE drive_files SET r2_key = ?, name = ?, size_bytes = ?, content_type = ?, source = ?,
         origin = ?, upload_id = ?, write_key = NULL, updated_at = ?
       WHERE path = ?`,
      finalKey,
      name,
      stagedBytes,
      contentType,
      source,
      source === "upload" ? "upload" : existing.origin,
      uploadId,
      now,
      path,
    );
    if (existing.r2_key !== finalKey) {
      queueCleanup(ctx, { path, r2Key: existing.r2_key, notBefore: now + REPLACEMENT_GRACE_MS });
    }
  } else {
    ctx.db.run(
      `INSERT INTO drive_files (path, r2_key, name, size_bytes, content_type, source, origin,
         write_key, upload_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      path,
      finalKey,
      name,
      stagedBytes,
      contentType,
      source,
      source,
      uploadId,
      now,
      now,
    );
  }
  ctx.db.run("DELETE FROM drive_uploads WHERE upload_id = ?", debtId);
  // The staging key stays cleanup work until its unrevocable PUT has aged out.
  retirePendingUpload(ctx, current, now);
  return { path, name, sizeBytes: stagedBytes, contentType, updatedAt: now };
};

const fileUrl = async (ctx: OwnerContext, args: { path: string }): Promise<DriveFileUrl> => {
  const path = normalizeDrivePath(args.path);
  const row = getFile(ctx.db, path);
  if (!row) throw new RpcError("NOT_FOUND", "That file is not in your drive.");
  const now = Date.now();
  return {
    path,
    name: row.name,
    sizeBytes: row.size_bytes,
    contentType: row.content_type,
    url: await signGet(signerOf(ctx), row.r2_key, DOWNLOAD_URL_EXPIRES_SECONDS, now),
    expiresAt: now + DOWNLOAD_URL_EXPIRES_SECONDS * 1_000,
  };
};

const listFiles = (
  db: OwnerDbReader,
  args: { prefix?: string; limit?: number },
): DriveFile[] => {
  const prefix = normalizeDrivePrefix(args.prefix);
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(args.limit ?? DEFAULT_LIST_LIMIT)));
  const rows = prefix
    ? db.all<FileRow>(
        "SELECT * FROM drive_files WHERE path >= ? AND path < ? ORDER BY path LIMIT ?",
        prefix,
        `${prefix}￿`,
        limit,
      )
    : db.all<FileRow>("SELECT * FROM drive_files ORDER BY updated_at DESC, path LIMIT ?", limit);
  // The key namespace stays server-side; a signed URL is how bytes are read.
  return rows.map((row) => ({
    path: row.path,
    name: row.name,
    sizeBytes: row.size_bytes,
    contentType: row.content_type,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
};

const sourcePathOf = (raw: string): string => {
  const value = raw.trim();
  if (
    !value ||
    value.length > MAX_DEVICE_FILE_SOURCE_CHARS ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !(value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value))
  ) {
    throw invalid("A device file needs the absolute path it has on that computer.");
  }
  return value;
};

const recordDeviceFiles = (
  ctx: OwnerContext,
  args: {
    deviceId: string;
    deviceName?: string;
    files: Array<{ sourcePath: string; drivePath?: string; sizeBytes: number; contentType?: string }>;
  },
): { recorded: number } => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "drive.recordDeviceFiles",
    { count: 120, windowMs: 60_000 },
    "Too many device file records. Wait a moment and try again.",
  );
  const deviceId = args.deviceId.trim();
  if (!deviceId) throw invalid("A device id is required.");
  const deviceName =
    args.deviceName?.trim().slice(0, 200) ||
    ctx.db.one<{ name: string | null }>("SELECT name FROM devices WHERE device_id = ?", deviceId)?.name ||
    "";
  let recorded = 0;
  for (const file of args.files) {
    const sourcePath = sourcePathOf(file.sourcePath);
    const drivePath = file.drivePath ? normalizeDrivePath(file.drivePath) : null;
    if (drivePath && !getFile(ctx.db, drivePath)) {
      throw invalid("A device file's drive copy must already be in the drive.");
    }
    const name = sourcePath.slice(Math.max(sourcePath.lastIndexOf("/"), sourcePath.lastIndexOf("\\")) + 1);
    ctx.db.run(
      `INSERT INTO drive_device_files
         (device_id, source_path, device_name, drive_path, name, size_bytes, content_type, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, source_path) DO UPDATE SET
         device_name = excluded.device_name,
         drive_path = excluded.drive_path,
         name = excluded.name,
         size_bytes = excluded.size_bytes,
         content_type = excluded.content_type,
         updated_at = excluded.updated_at`,
      deviceId,
      sourcePath,
      deviceName,
      drivePath,
      name || sourcePath,
      normalizeSize(file.sizeBytes),
      normalizeContentType(file.contentType),
      ctx.now,
    );
    recorded += 1;
  }
  ctx.db.run(
    `DELETE FROM drive_device_files WHERE rowid IN (
       SELECT rowid FROM drive_device_files ORDER BY updated_at DESC LIMIT -1 OFFSET ?
     )`,
    MAX_DEVICE_FILE_ROWS,
  );
  return { recorded };
};

const locateDeviceFiles = (
  db: OwnerDbReader,
  args: { paths: string[] },
): { files: DeviceFileLocation[] } => {
  const files: DeviceFileLocation[] = [];
  const seen = new Set<string>();
  for (const raw of args.paths) {
    const sourcePath = raw.trim();
    if (!sourcePath || seen.has(sourcePath)) continue;
    seen.add(sourcePath);
    const rows = db.all<DeviceFileRow & { current_name: string | null }>(
      `SELECT f.*, d.name AS current_name FROM drive_device_files f
         LEFT JOIN devices d ON d.device_id = f.device_id
        WHERE f.source_path = ?
        ORDER BY f.updated_at DESC LIMIT ?`,
      sourcePath,
      MAX_DEVICES_PER_SOURCE_PATH,
    );
    for (const row of rows) {
      const usableCopy = row.drive_path ? getFile(db, row.drive_path) : null;
      files.push({
        sourcePath: row.source_path,
        deviceId: row.device_id,
        deviceName: row.current_name?.trim() || row.device_name || "another computer",
        drivePath: usableCopy ? usableCopy.path : null,
        name: row.name,
        sizeBytes: usableCopy ? usableCopy.size_bytes : row.size_bytes,
        contentType: usableCopy ? usableCopy.content_type : row.content_type,
        updatedAt: row.updated_at,
      });
    }
  }
  return { files };
};

// ── Server-internal input ────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw invalid("Expected an object.");
  return value;
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const optionalString = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length <= max ? value : undefined;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

// ── Turn writes (produced files, html, images) ───────────────────────────

/** One file a turn reports, as its executor or tool sends it. */
export type DriveFileReport = {
  path: string;
  name?: string;
  sizeBytes?: number;
  contentType?: string;
  /** The bytes, for a file below `DRIVE_INLINE_FILE_LIMIT_BYTES`. */
  contentBase64?: string;
  /** A `drive.turnStage` upload whose PUT has finished, for anything larger. */
  uploadId?: string;
  /** `updatedAt` of the row this turn hydrated: its claim that it read that version. */
  knownUpdatedAt?: number;
};

type NormalizedReport = {
  path: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  bytes: Uint8Array | null;
  uploadId: string | null;
  knownUpdatedAt: number | null;
};

type DriveSkip = { path: string; reason: string };
type DriveRename = { from: string; to: string; reason: string };

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/**
 * Validate a produced-files report. Every file carries its bytes: inline,
 * capped per file and per request, or as a staged upload for anything larger.
 * There is no metadata-only row: a cloud world never stores the drive, so a
 * row without bytes here would name a file that exists nowhere.
 */
const normalizeReport = (files: unknown): NormalizedReport[] => {
  if (!Array.isArray(files) || files.length === 0) throw invalid("files must be a non-empty array.");
  if (files.length > DRIVE_MAX_FILES_PER_REPORT) {
    throw invalid(`A produced-files report may carry at most ${DRIVE_MAX_FILES_PER_REPORT} files.`);
  }
  let inlineTotal = 0;
  const seen = new Set<string>();
  return files.map((entry) => {
    const file = record(entry);
    if (typeof file.path !== "string") throw invalid("Every reported file needs a path.");
    const path = normalizeDrivePath(file.path);
    if (seen.has(path)) {
      throw invalid(`${path} appears more than once in the same write. Send one version per path.`);
    }
    seen.add(path);
    const uploadId = optionalString(file.uploadId, 200)?.trim() || null;
    let bytes: Uint8Array | null = null;
    if (typeof file.contentBase64 === "string") {
      if (uploadId) throw invalid(`${path} carried both inline bytes and a staged upload.`);
      try {
        bytes = decodeBase64(file.contentBase64);
      } catch {
        throw invalid(`${path} carried malformed base64 content.`);
      }
      if (bytes.byteLength > DRIVE_INLINE_FILE_LIMIT_BYTES) {
        throw invalid(
          `${path} exceeds the ${formatMb(DRIVE_INLINE_FILE_LIMIT_BYTES)} inline limit. Stage it with drive.turnStage instead.`,
        );
      }
      inlineTotal += bytes.byteLength;
      if (inlineTotal > DRIVE_INLINE_REQUEST_LIMIT_BYTES) {
        throw invalid(
          `A produced-files report may carry at most ${formatMb(DRIVE_INLINE_REQUEST_LIMIT_BYTES)} of inline content.`,
        );
      }
    } else if (!uploadId) {
      throw invalid(`${path} carried neither its bytes nor a staged upload.`);
    }
    return {
      path,
      name: normalizeFileName(optionalString(file.name, 10_000), path),
      contentType: normalizeContentType(optionalString(file.contentType, 10_000)),
      sizeBytes: bytes ? bytes.byteLength : normalizeSize(file.sizeBytes ?? 0),
      bytes,
      uploadId,
      knownUpdatedAt: finiteNumber(file.knownUpdatedAt) ?? null,
    };
  });
};

/**
 * The key a batch is recorded under, scoped to the turn that reported it, so
 * a redelivery of one batch is told apart from a second writer.
 */
const driveWriteKey = (turnId: string, batchKey: unknown): string | undefined => {
  const value = typeof batchKey === "string" ? batchKey.trim() : "";
  return value ? `${turnId}:${value.slice(0, 64)}` : undefined;
};

type Baseline = Map<string, { origin: string; writeKey: string | null; updatedAt: number }>;

const renamedReason = (from: string, to: string): string =>
  `${from} is a file you uploaded that this turn did not read, so this version was saved as ${to}.`;

/**
 * Bytes the user uploaded are only replaceable by a turn that read them:
 * a turn proves it did by echoing the row's `updatedAt`. Anything else is
 * diverted to an "(agent copy)" sibling so both versions survive. Agent
 * output stays freely overwritable. A row that already records this exact
 * write is this batch's own footprint, not a version it never saw.
 */
const applyUploadWriteRule = (
  files: NormalizedReport[],
  baseline: Baseline,
  writeKey: string | undefined,
): { files: NormalizedReport[]; renamed: DriveRename[]; skipped: DriveSkip[] } => {
  const protectedByUpload = (path: string, knownUpdatedAt: number | null) => {
    const row = baseline.get(path);
    return (
      row !== undefined &&
      row.origin === "upload" &&
      row.updatedAt !== knownUpdatedAt &&
      !(writeKey !== undefined && row.writeKey === writeKey)
    );
  };
  const renamed: DriveRename[] = [];
  const skipped: DriveSkip[] = [];
  const resolved: NormalizedReport[] = [];
  for (const file of files) {
    if (!protectedByUpload(file.path, file.knownUpdatedAt)) {
      resolved.push(file);
      continue;
    }
    const to = driveRevisionPath(file.path);
    if (protectedByUpload(to, null)) {
      skipped.push({
        path: file.path,
        reason: `${file.path} and ${to} are both files you uploaded that this turn did not read, so it was not saved over either.`,
      });
      continue;
    }
    renamed.push({ from: file.path, to, reason: renamedReason(file.path, to) });
    resolved.push({ ...file, path: to, name: fileNameFromPath(to) });
  }
  return { files: resolved, renamed, skipped };
};

export type DriveTurnFilesResult = {
  inlineLimitBytes: number;
  files: Array<DriveFileRecord & { stored: boolean }>;
  skipped: DriveSkip[];
  renamed: DriveRename[];
  replaced: DriveSkip[];
};

/**
 * Resolve a report's staged uploads against their claims. A staged write
 * whose response was lost already installed its row, and the row carries the
 * upload id wherever the upload rule filed it, so a redelivery of the same
 * batch answers from that row instead of claiming the upload twice.
 */
const resolveStagedWrites = async (
  ctx: OwnerContext,
  files: NormalizedReport[],
  writeKey: string | undefined,
): Promise<{
  files: NormalizedReport[];
  staged: Map<string, UploadRow>;
  replayed: Array<DriveFileRecord & { stored: boolean }>;
  renamed: DriveRename[];
  skipped: DriveSkip[];
}> => {
  const staged = new Map<string, UploadRow>();
  const replayed: Array<DriveFileRecord & { stored: boolean }> = [];
  const renamed: DriveRename[] = [];
  const skipped: DriveSkip[] = [];
  const resolved: NormalizedReport[] = [];
  for (const file of files) {
    if (!file.uploadId) {
      resolved.push(file);
      continue;
    }
    const installed = ctx.db.one<FileRow>(
      "SELECT * FROM drive_files WHERE upload_id = ? LIMIT 1",
      file.uploadId,
    );
    if (installed && writeKey !== undefined && installed.write_key === writeKey) {
      replayed.push({ ...fileRecord(installed), stored: true });
      if (installed.path !== file.path) {
        renamed.push({ from: file.path, to: installed.path, reason: renamedReason(file.path, installed.path) });
      }
      continue;
    }
    const pending = ctx.db.one<UploadRow>("SELECT * FROM drive_uploads WHERE upload_id = ?", file.uploadId);
    if (
      !pending ||
      pending.status !== "pending" ||
      pending.path !== file.path ||
      file.sizeBytes > pending.claimed_bytes
    ) {
      skipped.push({
        path: file.path,
        reason: `${file.path} could not be saved to your drive because its upload was no longer waiting to be saved.`,
      });
      continue;
    }
    // Storage, not the report, says how many bytes arrived.
    const head = await bucketOf(ctx).head(pending.r2_key);
    if (!head || head.size !== file.sizeBytes) {
      retirePendingUpload(ctx, pending, Date.now());
      skipped.push({
        path: file.path,
        reason: `${file.path} did not reach your drive in full, so it was not saved.`,
      });
      continue;
    }
    staged.set(file.uploadId, pending);
    resolved.push(file);
  }
  return { files: resolved, staged, replayed, renamed, skipped };
};

/**
 * A turn's produced files: agent output, html canvases, generated images.
 * Inline bytes are written to immutable keys and staged uploads are copied out
 * of their client-writable staging keys, then the rows land together,
 * re-checked against the quota. Nothing landing at all is the caller's to
 * report as a failure (`files` empty, `skipped` not).
 */
const turnFiles = async (ctx: OwnerContext, raw: unknown): Promise<DriveTurnFilesResult> => {
  const input = record(raw);
  const turnId = optionalString(input.turnId, 512)?.trim();
  if (!turnId) throw invalid("turnId is required.");
  const hydratesDrive = input.hydratesDrive === true;
  const writeKey = driveWriteKey(turnId, input.batchKey);
  const reported = optionalString(input.source, 200)?.trim().slice(0, 40) || "agent";
  // "upload" sets a row's permanent provenance; only the user earns it.
  const source = reported === "upload" ? "agent" : reported;
  const stagedWrites = await resolveStagedWrites(ctx, normalizeReport(input.files), writeKey);
  let files = stagedWrites.files;
  const { staged } = stagedWrites;

  const baseline: Baseline = new Map();
  for (const path of new Set(files.flatMap((file) => [file.path, driveRevisionPath(file.path)]))) {
    const row = getFile(ctx.db, path);
    if (row) {
      baseline.set(path, { origin: row.origin, writeKey: row.write_key, updatedAt: row.updated_at });
    }
  }
  const rule = applyUploadWriteRule(files, baseline, writeKey);
  files = rule.files;
  const skipped: DriveSkip[] = [...stagedWrites.skipped, ...rule.skipped];
  const preflight = partitionWrite(ctx, files.map(({ path, sizeBytes }) => ({ path, sizeBytes })));
  skipped.push(...preflight.skipped);
  const acceptedSize = new Map(preflight.accepted.map((file) => [file.path, file.sizeBytes]));
  files = files.filter((file) => acceptedSize.get(file.path) === file.sizeBytes);

  // Writes over a row of earlier agent output the turn never read. Only a
  // turn that was shown the drive can be said to have skipped reading it.
  const replaced: DriveSkip[] = [];
  for (const file of hydratesDrive ? files : []) {
    const row = baseline.get(file.path);
    if (!row || row.origin === "upload") continue;
    if (row.updatedAt === file.knownUpdatedAt) continue;
    if (writeKey !== undefined && row.writeKey === writeKey) continue;
    replaced.push({
      path: file.path,
      reason: `${file.path} was already in your drive from an earlier turn, and this turn saved over it without opening it first.`,
    });
  }

  const prefix = await driveOwnerPrefix(ctx.ownerId);
  const entries: Array<NormalizedReport & { r2Key: string; debtId?: string }> = [];
  for (const file of files) {
    entries.push({
      ...file,
      r2Key: `${prefix}writes/${await sha256Hex(crypto.randomUUID())}/${file.path}`,
    });
  }
  if (entries.length > 0) {
    const bucket = bucketOf(ctx);
    // Debt first, so a crash after any write or copy still reclaims it.
    for (const entry of entries) {
      entry.debtId = queueCleanup(ctx, {
        path: entry.path,
        r2Key: entry.r2Key,
        notBefore: ctx.now + WRITE_DEBT_GRACE_MS,
      });
    }
    try {
      for (const entry of entries) {
        if (entry.bytes) {
          await bucket.put(entry.r2Key, entry.bytes, {
            httpMetadata: { contentType: entry.contentType },
          });
          continue;
        }
        // The staging key stays writable by its presigned PUT, so the row
        // only ever names a server-made copy of it.
        await copyR2Object(signerOf(ctx), {
          from: staged.get(entry.uploadId!)!.r2_key,
          to: entry.r2Key,
        });
        const copied = await bucket.head(entry.r2Key);
        if (!copied || copied.size !== entry.sizeBytes) throw unavailable();
      }
    } catch {
      // Every key written so far is debt that cleanup reclaims, and the
      // staged uploads are still pending, so the same report can be retried.
      throw unavailable();
    }
  }

  // Commit: no awaits from here. The quota is re-checked against whatever
  // landed while the bytes were being written; a file that no longer fits
  // costs only itself, and its object becomes cleanup.
  const now = Date.now();
  const verdict = partitionWrite(
    { db: ctx.db, env: ctx.env, now },
    entries.map(({ path, sizeBytes }) => ({ path, sizeBytes })),
  );
  skipped.push(...verdict.skipped);
  const fits = new Map(verdict.accepted.map((file) => [file.path, file.sizeBytes]));
  const written: typeof entries = [];
  for (const entry of entries) {
    if (fits.get(entry.path) !== entry.sizeBytes) continue;
    const existing = getFile(ctx.db, entry.path);
    if (existing) {
      ctx.db.run(
        `UPDATE drive_files SET r2_key = ?, name = ?, size_bytes = ?, content_type = ?, source = ?,
           origin = ?, write_key = ?, upload_id = ?, updated_at = ?
         WHERE path = ?`,
        entry.r2Key,
        entry.name,
        entry.sizeBytes,
        entry.contentType,
        source,
        // Provenance only rises to "upload"; an agent edit never spends it.
        existing.origin,
        writeKey ?? null,
        entry.uploadId,
        now,
        entry.path,
      );
      if (existing.r2_key !== entry.r2Key) {
        queueCleanup(ctx, {
          path: entry.path,
          r2Key: existing.r2_key,
          notBefore: now + REPLACEMENT_GRACE_MS,
        });
      }
    } else {
      ctx.db.run(
        `INSERT INTO drive_files (path, r2_key, name, size_bytes, content_type, source, origin,
           write_key, upload_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.path,
        entry.r2Key,
        entry.name,
        entry.sizeBytes,
        entry.contentType,
        source,
        source,
        writeKey ?? null,
        entry.uploadId,
        now,
        now,
      );
    }
    written.push(entry);
  }
  const linked = new Set(written.map((entry) => entry.r2Key));
  for (const entry of entries) {
    if (linked.has(entry.r2Key)) {
      ctx.db.run("DELETE FROM drive_uploads WHERE upload_id = ?", entry.debtId!);
    } else {
      ctx.db.run("UPDATE drive_uploads SET expires_at = ? WHERE upload_id = ?", now, entry.debtId!);
      armJob(ctx, DRIVE_CLEANUP_JOB, now);
    }
  }
  // A staged key is reclaimed once its PUT has aged out, landed or not.
  for (const pending of staged.values()) retirePendingUpload(ctx, pending, now);
  const landed = new Set(written.map((entry) => entry.path));
  return {
    inlineLimitBytes: DRIVE_INLINE_FILE_LIMIT_BYTES,
    files: [
      ...stagedWrites.replayed,
      ...written.map((entry) => ({
        path: entry.path,
        name: entry.name,
        sizeBytes: entry.sizeBytes,
        contentType: entry.contentType,
        updatedAt: now,
        stored: true,
      })),
    ],
    skipped,
    renamed: [...stagedWrites.renamed, ...rule.renamed],
    replaced: replaced.filter((entry) => landed.has(entry.path)),
  };
};

/**
 * Presigned PUTs for files too large to carry inline. Each one claims its
 * size against the quota now and is checked again when the report naming it
 * lands; the staged object is reclaimed whether or not that report ever comes.
 */
const turnStage = async (
  ctx: OwnerContext,
  raw: unknown,
): Promise<{
  uploads: Array<{ path: string; uploadId: string; url: string; expiresAt: number }>;
  skipped: DriveSkip[];
}> => {
  const input = record(raw);
  if (!optionalString(input.turnId, 512)?.trim()) throw invalid("turnId is required.");
  const files = Array.isArray(input.files) ? input.files : [];
  if (files.length === 0 || files.length > STAGE_MAX_FILES) {
    throw invalid(`A staging request carries 1 to ${STAGE_MAX_FILES} files.`);
  }
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "drive.turnStage",
    { count: 120, windowMs: 60_000 },
    "Too many drive uploads. Wait a moment and try again.",
  );
  const claims = files.map((entry) => {
    const file = record(entry);
    if (typeof file.path !== "string") throw invalid("Every staged file needs a path.");
    return { path: normalizeDrivePath(file.path), sizeBytes: normalizeSize(file.sizeBytes) };
  });
  const verdict = partitionWrite(ctx, claims);
  const signer = verdict.accepted.length > 0 ? signerOf(ctx) : null;
  const prefix = await driveOwnerPrefix(ctx.ownerId);
  const now = Date.now();
  const uploads: Array<{ path: string; uploadId: string; url: string; expiresAt: number }> = [];
  for (const claim of verdict.accepted) {
    const uploadId = crypto.randomUUID();
    const r2Key = `${prefix}uploads/${uploadId}/${claim.path}`;
    const url = await presignR2Url(signer!, {
      method: "PUT",
      key: r2Key,
      expiresInSeconds: STAGE_URL_EXPIRES_SECONDS,
      now,
    });
    ctx.db.run(
      `INSERT INTO drive_uploads (upload_id, path, r2_key, status, claimed_bytes, created_at, expires_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      uploadId,
      claim.path,
      r2Key,
      claim.sizeBytes,
      now,
      now + STAGE_TTL_MS,
    );
    uploads.push({
      path: claim.path,
      uploadId,
      url,
      expiresAt: now + STAGE_URL_EXPIRES_SECONDS * 1_000,
    });
  }
  if (uploads.length > 0) armJob(ctx, DRIVE_CLEANUP_JOB, now + STAGE_TTL_MS);
  return { uploads, skipped: verdict.skipped };
};

/**
 * A turn's deletions. A path is removed only while its row is still the
 * version the turn read: anything newer is somebody else's write, and a turn
 * deleting its own copy must not take that with it.
 */
const turnDelete = (
  ctx: OwnerContext,
  raw: unknown,
): { deleted: string[]; kept: DriveSkip[] } => {
  const input = record(raw);
  if (!optionalString(input.turnId, 512)?.trim()) throw invalid("turnId is required.");
  const files = Array.isArray(input.files) ? input.files : [];
  if (files.length === 0 || files.length > DELETE_MAX_FILES) {
    throw invalid(`A delete request carries 1 to ${DELETE_MAX_FILES} files.`);
  }
  const now = Date.now();
  const deleted: string[] = [];
  const kept: DriveSkip[] = [];
  for (const entry of files) {
    const file = record(entry);
    if (typeof file.path !== "string") throw invalid("Every deleted file needs a path.");
    const path = normalizeDrivePath(file.path);
    const knownUpdatedAt = finiteNumber(file.knownUpdatedAt);
    const row = getFile(ctx.db, path);
    if (!row) {
      deleted.push(path);
      continue;
    }
    if (knownUpdatedAt === undefined || row.updated_at !== knownUpdatedAt) {
      kept.push({
        path,
        reason: `${path} changed in your drive after this turn read it, so it was not deleted.`,
      });
      continue;
    }
    deleteFileRow(ctx, path, now, row.r2_key);
    deleted.push(path);
  }
  return { deleted, kept };
};

/** One drive row as the cloud file tools see it. */
export type DriveTurnEntry = {
  path: string;
  sizeBytes: number;
  contentType: string;
  origin: string;
  updatedAt: number;
};

const turnEntry = (row: FileRow): DriveTurnEntry => ({
  path: row.path,
  sizeBytes: row.size_bytes,
  contentType: row.content_type,
  origin: row.origin,
  updatedAt: row.updated_at,
});

/**
 * One path, as a file or as the folder its rows' paths imply. The drive is
 * flat; a folder is only ever the prefix of something in it.
 */
const turnStat = (
  db: OwnerDbReader,
  raw: unknown,
): { file: DriveTurnEntry | null; directory: boolean } => {
  const input = record(raw);
  if (typeof input.path !== "string") throw invalid("A drive path is required.");
  const path = normalizeDrivePath(input.path);
  const row = getFile(db, path);
  if (row) return { file: turnEntry(row), directory: false };
  const child = db.one<{ present: number }>(
    "SELECT 1 AS present FROM drive_files WHERE path > ? AND path < ? LIMIT 1",
    `${path}/`,
    `${path}/￿`,
  );
  return { file: null, directory: child !== null };
};

/** Rows under `prefix`, in path order, strictly after `after`. */
const turnList = (
  db: OwnerDbReader,
  raw: unknown,
): { files: DriveTurnEntry[]; more: boolean } => {
  const input = record(raw);
  const prefix =
    typeof input.prefix === "string" && input.prefix ? `${normalizeDrivePath(input.prefix)}/` : "";
  const after = typeof input.after === "string" ? input.after.slice(0, MAX_PATH_LENGTH + 1) : "";
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, Math.floor(finiteNumber(input.limit) ?? DEFAULT_LIST_LIMIT)),
  );
  const rows = prefix
    ? db.all<FileRow>(
        "SELECT * FROM drive_files WHERE path > ? AND path >= ? AND path < ? ORDER BY path LIMIT ?",
        after,
        prefix,
        `${prefix}￿`,
        limit + 1,
      )
    : db.all<FileRow>(
        "SELECT * FROM drive_files WHERE path > ? ORDER BY path LIMIT ?",
        after,
        limit + 1,
      );
  return { files: rows.slice(0, limit).map(turnEntry), more: rows.length > limit };
};

/** A byte range of one file, for the cloud file tools that never hydrate. */
const turnRead = async (
  ctx: OwnerContext,
  raw: unknown,
): Promise<DriveTurnEntry & { bytes: Uint8Array }> => {
  const input = record(raw);
  if (typeof input.path !== "string") throw invalid("A drive path is required.");
  const path = normalizeDrivePath(input.path);
  const row = getFile(ctx.db, path);
  if (!row) throw new RpcError("NOT_FOUND", "That file is not in your drive.");
  const offset = Math.max(0, Math.floor(finiteNumber(input.offset) ?? 0));
  const available = Math.max(0, row.size_bytes - offset);
  const requested = finiteNumber(input.length);
  if (requested !== undefined && requested > READ_MAX_BYTES) {
    throw invalid(`A drive read returns at most ${formatMb(READ_MAX_BYTES)}.`);
  }
  const length = Math.min(
    available,
    Math.max(0, Math.floor(requested ?? READ_MAX_BYTES)),
  );
  if (length === 0) return { ...turnEntry(row), bytes: new Uint8Array() };
  const object = await bucketOf(ctx).get(row.r2_key, { range: { offset, length } });
  if (!object) throw new RpcError("NOT_FOUND", "The drive's copy of that file is missing.");
  return { ...turnEntry(row), bytes: new Uint8Array(await object.arrayBuffer()) };
};

// ── Turn hydration (the workspace's view of the drive) ───────────────────

export type DriveSyncManifest = {
  prefix: string;
  files: Array<{
    path: string;
    relativePath: string;
    sizeBytes: number;
    contentType: string;
    source: string;
    origin: string;
    updatedAt: number;
    url: string;
  }>;
  /** In the drive, deliberately not hydrated, with the version it has. */
  skipped: Array<{ path: string; sizeBytes: number; reason: string; updatedAt: number; origin: string }>;
  /** Deletions since the caller's cursor; apply before materializing files. */
  deleted: Array<{ path: string; relativePath: string; deletedAt: number }>;
  /** Of the paths the caller holds (`have`), the ones the drive has no row for. */
  absent: string[];
  /** Cursor to send back as `since` on the next sync. */
  syncedAt: number;
  /** False when deletions older than the caller's cursor may be missing. */
  deletedComplete: boolean;
};

/** Explicit references first, then the user's own uploads, then newest first. */
const syncRank = (row: { path: string; origin: string }, wanted: Set<string>): number =>
  wanted.has(row.path) ? 0 : row.origin === "upload" ? 1 : 2;

const deletionsWindow = (
  db: OwnerDbReader,
  since: number,
  newestFirst: boolean,
): { deleted: Array<{ path: string; deletedAt: number }>; cursor: number | null } => {
  const rows = db.all<{ path: string; deleted_at: number }>(
    `SELECT path, deleted_at FROM drive_deletions WHERE deleted_at >= ?
     ORDER BY deleted_at ${newestFirst ? "DESC" : "ASC"} LIMIT ?`,
    Math.max(0, since),
    SYNC_MAX_DELETIONS + (newestFirst ? 0 : 1),
  );
  const window = rows.slice(0, SYNC_MAX_DELETIONS);
  // A path that has a row again is live; replaying its tombstone would
  // delete the copy this very turn is about to hydrate.
  const deleted = window
    .filter((row) => !getFile(db, row.path))
    .map((row) => ({ path: row.path, deletedAt: row.deleted_at }));
  if (newestFirst || rows.length <= SYNC_MAX_DELETIONS) return { deleted, cursor: null };
  // Resume where the window ended; a window inside one millisecond steps past it.
  const last = window[window.length - 1]!.deleted_at;
  return { deleted, cursor: last > since ? last : last + 1 };
};

/**
 * What a turn's workspace should hold before the agent runs: short-lived
 * GETs for the files that fit the turn's budget, the rows that did not,
 * deletions since the workspace's cursor, and which held paths are gone.
 */
const turnSync = async (ctx: OwnerContext, raw: unknown): Promise<DriveSyncManifest> => {
  const input = record(raw);
  const prefix = "";
  const now = Date.now();
  const wanted = new Set<string>();
  for (const candidate of stringList(input.include).slice(0, SYNC_MAX_INCLUDE)) {
    try {
      wanted.add(normalizeDrivePath(candidate));
    } catch {
      // A prompt is prose: most of what looks like a path is not one.
    }
  }
  const byPath = new Map<string, FileRow>();
  for (const row of ctx.db.all<FileRow>(
    "SELECT * FROM drive_files ORDER BY updated_at DESC LIMIT ?",
    MAX_LIST_LIMIT,
  )) {
    byPath.set(row.path, row);
  }
  // Named paths are looked up by name: on a drive larger than the window an
  // older file would otherwise be named nowhere and written over unseen.
  for (const path of wanted) {
    if (byPath.has(path)) continue;
    const row = getFile(ctx.db, path);
    if (row) byPath.set(path, row);
  }
  const rows = [...byPath.values()].filter((row) => row.path.startsWith(prefix));
  const files: DriveSyncManifest["files"] = [];
  const skipped: DriveSyncManifest["skipped"] = [];
  const ordered = rows.sort(
    (a, b) => syncRank(a, wanted) - syncRank(b, wanted) || b.updated_at - a.updated_at,
  );
  const signer = ordered.length > 0 ? signerOf(ctx) : null;
  let usedBytes = 0;
  for (const row of ordered) {
    if (files.length >= SYNC_MAX_FILES) {
      skipped.push({
        path: row.path,
        sizeBytes: row.size_bytes,
        reason: `only the ${SYNC_MAX_FILES} most relevant drive files are loaded into a turn`,
        updatedAt: row.updated_at,
        origin: row.origin,
      });
      continue;
    }
    if (usedBytes + row.size_bytes > SYNC_MAX_BYTES) {
      skipped.push({
        path: row.path,
        sizeBytes: row.size_bytes,
        reason: `it does not fit the ${formatMb(SYNC_MAX_BYTES)} a turn loads`,
        updatedAt: row.updated_at,
        origin: row.origin,
      });
      continue;
    }
    usedBytes += row.size_bytes;
    files.push({
      path: row.path,
      relativePath: row.path.slice(prefix.length),
      sizeBytes: row.size_bytes,
      contentType: row.content_type,
      source: row.source,
      origin: row.origin,
      updatedAt: row.updated_at,
      url: await signGet(signer!, row.r2_key, SYNC_URL_EXPIRES_SECONDS, now),
    });
  }

  // Presence is answered per named path, never inferred from the capped
  // listing: absence from a window is not absence from the drive.
  const listed = new Set([...files, ...skipped].map((entry) => entry.path));
  const asked = new Set<string>();
  for (const candidate of stringList(input.have).slice(0, SYNC_MAX_PRESENCE)) {
    let path: string;
    try {
      path = normalizeDrivePath(candidate);
    } catch {
      continue;
    }
    if (path.startsWith(prefix) && !listed.has(path)) asked.add(path);
  }
  const absent = [...asked].filter((path) => !getFile(ctx.db, path));

  // The caller's cursor rides in a workspace the agent can write, so the
  // answer also carries the most recent deletions, which need no cursor.
  const horizon = now - TOMBSTONE_TTL_MS;
  const since = finiteNumber(input.since);
  const cursor = since !== undefined && since > 0 ? Math.min(Math.floor(since), now) : 0;
  const ascending = deletionsWindow(ctx.db, Math.max(cursor, horizon), false);
  const recent = deletionsWindow(ctx.db, horizon, true);
  const seen = new Set<string>();
  const deleted: DriveSyncManifest["deleted"] = [];
  for (const entry of [...ascending.deleted, ...recent.deleted]) {
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
    syncedAt: ascending.cursor ?? now,
    deletedComplete: ascending.cursor === null && cursor >= horizon,
  };
};

/**
 * A chat turn's attached images, as short-lived GETs: images only, size
 * capped, by exact path.
 */
const turnAttachments = async (ctx: OwnerContext, raw: unknown) => {
  const paths = stringList(record(raw).paths).slice(0, ATTACHMENT_MAX_COUNT);
  const attachments: Array<{ path: string; contentType: string; sizeBytes: number; url: string }> = [];
  const skipped: DriveSkip[] = [];
  const now = Date.now();
  for (const path of paths) {
    const row = getFile(ctx.db, path);
    if (!row) {
      skipped.push({ path, reason: "not in the drive" });
      continue;
    }
    if (!row.content_type.toLowerCase().startsWith("image/")) {
      skipped.push({ path, reason: "not an image" });
      continue;
    }
    if (row.size_bytes > ATTACHMENT_MAX_BYTES) {
      skipped.push({ path, reason: "too large to inline" });
      continue;
    }
    attachments.push({
      path,
      contentType: row.content_type,
      sizeBytes: row.size_bytes,
      url: await signGet(signerOf(ctx), row.r2_key, ATTACHMENT_URL_EXPIRES_SECONDS, now),
    });
  }
  return { attachments, skipped };
};

/**
 * Reference images for the media provider, which cannot read the bucket.
 * `signedAt` lets a retried tool call sign the identical URLs, so its request
 * hash, and with it the provider job it reattaches to, stays the same.
 */
const signImages = async (ctx: OwnerContext, raw: unknown): Promise<{ urls: string[] }> => {
  const input = record(raw);
  const paths = stringList(input.paths)
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
  if (paths.length > REFERENCE_MAX_COUNT) {
    throw invalid(`referenceDrivePaths accepts at most ${REFERENCE_MAX_COUNT} paths.`);
  }
  const now = Date.now();
  const requested = finiteNumber(input.signedAt);
  // Never older than a URL could still be useful, never in the future.
  const signedAt =
    requested !== undefined && requested <= now && now - requested < REFERENCE_URL_EXPIRES_SECONDS * 500
      ? Math.floor(requested)
      : now;
  const urls: string[] = [];
  for (const path of paths) {
    const row = getFile(ctx.db, path);
    if (!row) throw invalid(`${path} is not in the user's drive.`);
    if (!row.content_type.toLowerCase().startsWith("image/")) {
      throw invalid(`${path} is not an image (${row.content_type}).`);
    }
    urls.push(await signGet(signerOf(ctx), row.r2_key, REFERENCE_URL_EXPIRES_SECONDS, signedAt));
  }
  return { urls };
};

// ── Jobs and purge ───────────────────────────────────────────────────────

/**
 * Delete objects no row names: abandoned or rejected uploads, replaced and
 * deleted files, writes that lost a race. Leased, so a failed delete is
 * retried after the lease rather than forgotten.
 */
const runCleanup = async (ctx: OwnerContext): Promise<void> => {
  const now = ctx.now;
  const due = ctx.db.all<UploadRow>(
    `SELECT * FROM drive_uploads
     WHERE expires_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
     ORDER BY expires_at LIMIT ?`,
    now,
    now,
    CLEANUP_BATCH,
  );
  if (due.length > 0) {
    const leaseId = crypto.randomUUID();
    for (const row of due) {
      ctx.db.run(
        "UPDATE drive_uploads SET lease_id = ?, lease_expires_at = ? WHERE upload_id = ?",
        leaseId,
        now + CLEANUP_LEASE_MS,
        row.upload_id,
      );
    }
    // A pending claim past its horizon is an abandoned upload; one whose key
    // a row names (only possible by a bug) keeps its bytes.
    const doomed = due.filter((row) => !isKeyReferenced(ctx.db, row.r2_key));
    let deleted = true;
    if (doomed.length > 0) {
      try {
        await bucketOf(ctx).delete([...new Set(doomed.map((row) => row.r2_key))]);
      } catch {
        deleted = false;
      }
    }
    if (deleted) {
      for (const row of due) {
        ctx.db.run(
          "DELETE FROM drive_uploads WHERE upload_id = ? AND lease_id = ?",
          row.upload_id,
          leaseId,
        );
      }
    }
  }
  const next = ctx.db.one<{ at: number | null }>(
    `SELECT MIN(MAX(expires_at, COALESCE(lease_expires_at, 0))) AS at FROM drive_uploads`,
  )?.at;
  if (typeof next === "number") ctx.jobs.schedule(DRIVE_CLEANUP_JOB, Math.max(next, now + 1_000), null, { id: DRIVE_CLEANUP_JOB });
};

/** Drop tombstones past the replay window; a workspace that old resyncs blind. */
const pruneTombstones = (ctx: OwnerContext): void => {
  const now = ctx.now;
  ctx.db.run("DELETE FROM drive_deletions WHERE deleted_at < ?", now - TOMBSTONE_TTL_MS);
  const oldest = ctx.db.one<{ at: number | null }>("SELECT MIN(deleted_at) AS at FROM drive_deletions")?.at;
  if (typeof oldest === "number") {
    ctx.jobs.schedule(
      DRIVE_PRUNE_JOB,
      Math.max(oldest + TOMBSTONE_TTL_MS, now + TOMBSTONE_PRUNE_EVERY_MS),
      null,
      { id: DRIVE_PRUNE_JOB },
    );
  }
};

/** Reset or deletion: every row, then every object under the owner's prefix. */
const purgeDrive = async (ctx: OwnerContext): Promise<{ pending: boolean }> => {
  ctx.db.run("DELETE FROM drive_files");
  ctx.db.run("DELETE FROM drive_uploads");
  ctx.db.run("DELETE FROM drive_deletions");
  ctx.db.run("DELETE FROM drive_device_files");
  ctx.jobs.cancel(DRIVE_CLEANUP_JOB);
  ctx.jobs.cancel(DRIVE_PRUNE_JOB);
  const bucket = bucketOf(ctx);
  const listed = await bucket.list({ prefix: await driveOwnerPrefix(ctx.ownerId), limit: 1_000 });
  if (listed.objects.length > 0) {
    await bucket.delete(listed.objects.map((object) => object.key));
  }
  return { pending: listed.truncated };
};

// ── Registration ─────────────────────────────────────────────────────────

const pathArg = string({ min: 1, max: 4_000 });

export const driveDomain = {
  name: "drive",
  migrations: [DRIVE_MIGRATION, DRIVE_DEVICE_FILES_MIGRATION],
  calls: {
    "drive.prepareUpload": {
      scope: "owner",
      parse: object({
        path: pathArg,
        sizeBytes: number({ min: 0 }),
        contentType: optional(string({ max: 1_000 })),
      }),
      handler: prepareUpload,
    },
    "drive.finalizeUpload": {
      scope: "owner",
      parse: object({
        path: pathArg,
        uploadId: string({ min: 1, max: 200 }),
        contentType: optional(string({ max: 1_000 })),
        source: optional(string({ max: 200 })),
      }),
      handler: finalizeUpload,
    },
    "drive.fileUrl": {
      scope: "owner",
      parse: object({ path: pathArg }),
      handler: fileUrl,
    },
    "drive.delete": {
      scope: "owner",
      parse: object({ path: pathArg }),
      handler: (ctx: OwnerContext, args: { path: string }) => ({
        deleted: deleteFileRow(ctx, normalizeDrivePath(args.path), Date.now()),
      }),
    },
    // Same reader as the `drive.files` view. A tool call wants one answer, and
    // a device should not open a subscription to get it.
    "drive.list": {
      scope: "owner",
      parse: object({
        prefix: optional(string({ max: 4_000 })),
        limit: optional(number({ min: 1, max: 100_000 })),
      }),
      handler: (
        ctx: OwnerContext,
        args: { prefix?: string; limit?: number },
      ) => ({ files: listFiles(ctx.db, args) }),
    },
    "drive.recordDeviceFiles": {
      scope: "owner",
      parse: object({
        deviceId: string({ min: 1, max: 256 }),
        deviceName: optional(string({ max: 1_000 })),
        files: array(
          object({
            sourcePath: string({ min: 1, max: MAX_DEVICE_FILE_SOURCE_CHARS }),
            drivePath: optional(pathArg),
            sizeBytes: number({ min: 0 }),
            contentType: optional(string({ max: 1_000 })),
          }),
          { max: MAX_DEVICE_FILES_PER_RECORD },
        ),
      }),
      handler: recordDeviceFiles,
    },
    "drive.locateDeviceFiles": {
      scope: "owner",
      parse: object({
        paths: array(string({ min: 1, max: MAX_DEVICE_FILE_SOURCE_CHARS }), {
          max: DEVICE_FILE_COPY_LIMITS.maxLocatePaths,
        }),
      }),
      handler: (ctx: OwnerContext, args: { paths: string[] }) => locateDeviceFiles(ctx.db, args),
    },
  },
  views: {
    "drive.files": {
      parse: object({
        prefix: optional(string({ max: 4_000 })),
        limit: optional(number({ min: 1, max: 100_000 })),
      }),
      read: (ctx, args) => listFiles(ctx.db, args),
    },
  },
  internal: {
    /** What the drive holds against the plan's quota. */
    "drive.usage": (ctx: OwnerContext) => {
      const { plan, unlimited } = billingPlan(ctx);
      return { ...usage(ctx.db), plan, unlimited, quota: unlimited ? UNLIMITED_QUOTA : PLAN_QUOTAS[plan] };
    },
    // The cloud `drive` tool's list and fetch, called with no caller.
    "drive.list": (ctx: OwnerContext, raw: unknown) => {
      const input = record(raw);
      const limit = finiteNumber(input.limit);
      return {
        files: listFiles(ctx.db, {
          ...(typeof input.prefix === "string" ? { prefix: input.prefix.slice(0, 4_000) } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      };
    },
    "drive.fileUrl": (ctx: OwnerContext, raw: unknown) => {
      const input = record(raw);
      if (typeof input.path !== "string") throw invalid("A drive path is required.");
      return fileUrl(ctx, { path: input.path });
    },
    "drive.turnFiles": turnFiles,
    "drive.turnStage": turnStage,
    "drive.turnDelete": turnDelete,
    "drive.turnStat": (ctx: OwnerContext, raw: unknown) => turnStat(ctx.db, raw),
    "drive.turnList": (ctx: OwnerContext, raw: unknown) => turnList(ctx.db, raw),
    "drive.turnRead": turnRead,
    "drive.turnSync": turnSync,
    "drive.turnAttachments": turnAttachments,
    "drive.signImages": signImages,
  },
  jobs: {
    [DRIVE_CLEANUP_JOB]: { run: (ctx: OwnerContext) => runCleanup(ctx) },
    [DRIVE_PRUNE_JOB]: { run: (ctx: OwnerContext) => pruneTombstones(ctx) },
  },
  purge: (ctx: OwnerContext) => purgeDrive(ctx),
} satisfies OwnerDomain;

