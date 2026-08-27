import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { decryptSecret } from "./data/secrets_crypto";
import { base64UrlDecode, bytesToHex } from "./lib/crypto_utils";
import { assertOwnerDataWriteAllowed } from "./owner_lifecycle";

// Each source object can fan out to MAX_OBJECT_VARIANTS destination reads. Keep
// this small enough that the valid worst case remains comfortably inside one
// Convex transaction's document/read budget.
const BATCH_SIZE = 8;
const MAX_KEYS_PER_OWNER = 64;
const MAX_OBJECT_VARIANTS = 64;
const MAX_LATEST_REPAIR = 32;
const MAX_SNAPSHOT_ID_LENGTH = 200;
const LEGACY_UPLOAD_AUTHORITY_FENCE_MS = 20 * 60_000;
const sha256HexPattern = /^[a-f0-9]{64}$/u;

const leaseArgs = {
  fromOwnerId: v.string(),
  toOwnerId: v.string(),
  leaseId: v.string(),
  leaseGeneration: v.number(),
  leaseNow: v.number(),
} as const;

type LeaseArgs = {
  fromOwnerId: string;
  toOwnerId: string;
  leaseId: string;
  leaseGeneration: number;
  leaseNow: number;
};

const resultValidator = v.object({
  hasMore: v.boolean(),
  retryAfterMs: v.optional(v.number()),
});

const migrationControlArgs = {
  fromOwnerId: v.string(),
  toOwnerId: v.string(),
  migrationId: v.string(),
  leaseId: v.string(),
  leaseGeneration: v.number(),
  fromOwnerGeneration: v.string(),
  toOwnerGeneration: v.string(),
  planRevision: v.number(),
  now: v.number(),
} as const;

type MigrationControlArgs = {
  fromOwnerId: string;
  toOwnerId: string;
  migrationId: string;
  leaseId: string;
  leaseGeneration: number;
  fromOwnerGeneration: string;
  toOwnerGeneration: string;
  planRevision: number;
  now: number;
};

const cleanupReservationsRef = makeFunctionReference<
  "action",
  MigrationControlArgs,
  { ready: boolean; retryAfterMs?: number }
>("account_deletion:cleanupOwnerBackupReservationsForMigrationInternal");

const advanceLegacyR2SweepRef = makeFunctionReference<
  "action",
  MigrationControlArgs,
  { ready: boolean; retryAfterMs?: number }
>("backup_legacy_r2_sweep:advanceMigrationLegacyR2SweepInternal");

const migrateBackupsBatchRef = makeFunctionReference<
  "mutation",
  LeaseArgs,
  { hasMore: boolean; retryAfterMs?: number }
>("backup_migration:migrateBackupsBatchInternal");

const blockMigration = (message: string): never => {
  // Backup migration commits bounded batches. No data-dependent backup error
  // may terminal-fail the enclosing ownership migration, because an earlier
  // batch may already have moved rows. A non-terminal error makes the outer
  // worker return to `pending`, keeping both principals fenced and repairable.
  throw new Error(`backup_migration_repair_required: ${message}`);
};

const assertOwnerGeneration = (
  row: { ownerGeneration?: string },
  expectedGeneration: string,
  label: string,
) => {
  if (
    row.ownerGeneration !== undefined &&
    row.ownerGeneration !== expectedGeneration
  ) {
    blockMigration(`${label} belongs to a stale owner generation.`);
  }
};

const requireMigrationLease = async (ctx: MutationCtx, args: LeaseArgs) => {
  const rows = await ctx.db
    .query("auth_owner_migrations")
    .withIndex("by_fromOwnerId_and_updatedAt", (q) =>
      q.eq("fromOwnerId", args.fromOwnerId),
    )
    .take(2);
  const migration = rows[0];
  if (
    rows.length !== 1 ||
    !migration ||
    migration.toOwnerId !== args.toOwnerId ||
    migration.status !== "running" ||
    migration.leaseId !== args.leaseId ||
    migration.leaseGeneration !== args.leaseGeneration ||
    (migration.leaseExpiresAt ?? 0) <= Math.max(args.leaseNow, Date.now()) ||
    !migration.fromOwnerGeneration ||
    !migration.toOwnerGeneration
  ) {
    throw new ConvexError({
      code: "STALE_OWNERSHIP_MIGRATION_LEASE",
      message: "Backup migration no longer owns the account-link lease.",
    });
  }
  await Promise.all([
    assertOwnerDataWriteAllowed(
      ctx,
      args.fromOwnerId,
      migration.fromOwnerGeneration,
    ),
    assertOwnerDataWriteAllowed(
      ctx,
      args.toOwnerId,
      migration.toOwnerGeneration,
    ),
  ]);
  return {
    migration,
    fromOwnerGeneration: migration.fromOwnerGeneration,
    toOwnerGeneration: migration.toOwnerGeneration,
  };
};

const listEscrows = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
): Promise<Array<Doc<"backup_key_escrows">>> => {
  const rows = await ctx.db
    .query("backup_key_escrows")
    .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
    .take(MAX_KEYS_PER_OWNER + 1);
  if (rows.length > MAX_KEYS_PER_OWNER) {
    blockMigration("A backup account contains too many encryption keys.");
  }
  return rows;
};

const assertEscrowGenerations = (
  rows: Array<Doc<"backup_key_escrows">>,
  generation: string,
  label: string,
) => {
  for (const row of rows) {
    if (
      !sha256HexPattern.test(row.keyFingerprint) ||
      (row.ownerGeneration !== undefined && row.ownerGeneration !== generation)
    ) {
      blockMigration(`${label} backup encryption-key authority is malformed.`);
    }
  }
};

const assertEscrowKeyMaterial = async (
  rows: Array<Doc<"backup_key_escrows">>,
) => {
  const rawKeyByFingerprint = new Map<string, string>();
  for (const row of rows) {
    let keyBytes: Uint8Array | null = null;
    try {
      const keyBase64Url = await decryptSecret(row.encryptedKey);
      keyBytes = new Uint8Array(base64UrlDecode(keyBase64Url));
    } catch {
      blockMigration(
        "A backup encryption-key escrow cannot be decrypted safely.",
      );
    }
    if (!keyBytes || keyBytes.byteLength !== 32) {
      blockMigration("A backup encryption-key escrow is not a 32-byte key.");
    }
    const exactBytes = Uint8Array.from(
      keyBytes ??
        blockMigration("A backup encryption-key escrow is not a 32-byte key."),
    );
    const digest = bytesToHex(
      new Uint8Array(await crypto.subtle.digest("SHA-256", exactBytes.buffer)),
    );
    if (digest !== row.keyFingerprint) {
      blockMigration(
        "A backup encryption-key escrow does not match its fingerprint.",
      );
    }
    const exactKey = bytesToHex(exactBytes);
    const prior = rawKeyByFingerprint.get(row.keyFingerprint);
    if (prior !== undefined && prior !== exactKey) {
      blockMigration(
        "Backup escrows reuse one fingerprint for different encryption keys.",
      );
    }
    rawKeyByFingerprint.set(row.keyFingerprint, exactKey);
  }
};

const uniqueFingerprint = (
  rows: Array<Doc<"backup_key_escrows">>,
  label: string,
): string | null => {
  const explicit = new Set(
    rows
      .filter((row) => row.isCurrent === true)
      .map((row) => row.keyFingerprint),
  );
  if (explicit.size > 1) {
    blockMigration(`${label} has multiple current backup encryption keys.`);
  }
  const explicitFingerprint = explicit.values().next().value as
    | string
    | undefined;
  if (explicitFingerprint) return explicitFingerprint;
  const fingerprints = new Set(rows.map((row) => row.keyFingerprint));
  if (fingerprints.size === 1) {
    return fingerprints.values().next().value as string;
  }
  if (fingerprints.size > 1) {
    blockMigration(
      `${label} has multiple backup keys but no unambiguous current upload key.`,
    );
  }
  return null;
};

const resolveLegacyFingerprint = (
  sourceEscrows: Array<Doc<"backup_key_escrows">>,
  destinationEscrows: Array<Doc<"backup_key_escrows">>,
  owner: "source" | "destination",
): string => {
  const rows = owner === "source" ? sourceEscrows : destinationEscrows;
  const fingerprints = new Set(rows.map((row) => row.keyFingerprint));
  if (fingerprints.size !== 1) {
    blockMigration(
      `A legacy ${owner} backup has ambiguous encryption-key ownership.`,
    );
  }
  return fingerprints.values().next().value as string;
};

const normalizeLegacyObject = async (
  ctx: MutationCtx,
  ownerId: string,
  generation: string,
  resolveKeyFingerprint: () => string,
): Promise<boolean> => {
  const row = (
    await ctx.db
      .query("backup_objects")
      .withIndex("by_ownerId_and_keyFingerprint_and_createdAt", (q) =>
        q.eq("ownerId", ownerId).eq("keyFingerprint", undefined),
      )
      .take(1)
  )[0];
  if (!row) return false;
  if (row.ownerGeneration !== undefined && row.ownerGeneration !== generation) {
    blockMigration(
      "A legacy backup object belongs to a stale account generation.",
    );
  }
  await ctx.db.patch(row._id, {
    ownerGeneration: generation,
    keyFingerprint: resolveKeyFingerprint(),
  });
  return true;
};

const normalizeLegacyManifest = async (
  ctx: MutationCtx,
  ownerId: string,
  generation: string,
  resolveKeyFingerprint: () => string,
): Promise<boolean> => {
  const row = (
    await ctx.db
      .query("backup_manifests")
      .withIndex("by_ownerId_and_keyFingerprint_and_createdAt", (q) =>
        q.eq("ownerId", ownerId).eq("keyFingerprint", undefined),
      )
      .take(1)
  )[0];
  if (!row) return false;
  if (row.ownerGeneration !== undefined && row.ownerGeneration !== generation) {
    blockMigration(
      "A legacy backup manifest belongs to a stale account generation.",
    );
  }
  await ctx.db.patch(row._id, {
    ownerGeneration: generation,
    keyFingerprint: resolveKeyFingerprint(),
  });
  return true;
};

const nextActiveUploadExpiry = async (
  ctx: MutationCtx,
  ownerId: string,
  now: number,
): Promise<number | null> => {
  const [object, manifest] = await Promise.all([
    ctx.db
      .query("backup_objects")
      .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
        q.eq("ownerId", ownerId).gt("uploadExpiresAt", now),
      )
      .take(1),
    ctx.db
      .query("backup_manifests")
      .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
        q.eq("ownerId", ownerId).gt("uploadExpiresAt", now),
      )
      .take(1),
  ]);
  const expiries = [
    object[0]?.uploadExpiresAt,
    manifest[0]?.uploadExpiresAt,
  ].filter((value): value is number => value !== undefined);
  return expiries.length === 0 ? null : Math.min(...expiries);
};

const fenceLegacyUploadAuthority = async (
  ctx: MutationCtx,
  ownerId: string,
  now: number,
): Promise<boolean> => {
  const [objects, manifests] = await Promise.all([
    ctx.db
      .query("backup_objects")
      .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
        q.eq("ownerId", ownerId).eq("uploadExpiresAt", undefined),
      )
      .take(BATCH_SIZE),
    ctx.db
      .query("backup_manifests")
      .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
        q.eq("ownerId", ownerId).eq("uploadExpiresAt", undefined),
      )
      .take(BATCH_SIZE),
  ]);
  if (objects.length === 0 && manifests.length === 0) return false;
  const uploadExpiresAt = now + LEGACY_UPLOAD_AUTHORITY_FENCE_MS;
  await Promise.all([
    ...objects.map((row) => ctx.db.patch(row._id, { uploadExpiresAt })),
    ...manifests.map((row) => ctx.db.patch(row._id, { uploadExpiresAt })),
  ]);
  return true;
};

const repairLatestRows = async (
  ctx: MutationCtx,
  ownerId: string,
  ownerGeneration: string,
  label: string,
) => {
  const latest = await ctx.db
    .query("backup_manifests")
    .withIndex("by_ownerId_and_isLatest", (q) =>
      q.eq("ownerId", ownerId).eq("isLatest", true),
    )
    .take(MAX_LATEST_REPAIR + 1);
  if (latest.length > MAX_LATEST_REPAIR) {
    blockMigration("Backup latest-snapshot metadata exceeds the repair bound.");
  }
  for (const row of latest) {
    assertOwnerGeneration(row, ownerGeneration, label);
  }
  if (latest.length > 1) {
    latest.sort(
      (left, right) =>
        right.createdAt - left.createdAt ||
        String(right._id).localeCompare(String(left._id)),
    );
  }
  const now = Date.now();
  await Promise.all(
    latest.map(async (row, index) => {
      const patch = {
        ...(row.ownerGeneration === undefined ? { ownerGeneration } : {}),
        ...(index > 0 ? { isLatest: false, updatedAt: now } : {}),
      };
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(row._id, patch);
      }
    }),
  );
};

const ensureDestinationLatest = async (
  ctx: MutationCtx,
  ownerId: string,
  ownerGeneration: string,
) => {
  const [candidate, latest] = await Promise.all([
    ctx.db
      .query("backup_manifests")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(1),
    ctx.db
      .query("backup_manifests")
      .withIndex("by_ownerId_and_isLatest", (q) =>
        q.eq("ownerId", ownerId).eq("isLatest", true),
      )
      .take(MAX_LATEST_REPAIR + 1),
  ]);
  if (latest.length > MAX_LATEST_REPAIR) {
    blockMigration("Backup latest-snapshot metadata exceeds the repair bound.");
  }
  for (const row of [...candidate, ...latest]) {
    assertOwnerGeneration(
      row,
      ownerGeneration,
      "A destination latest backup snapshot",
    );
  }
  const selected = latest[0] ?? candidate[0];
  if (!selected) return;
  const now = Date.now();
  await Promise.all([
    ...(selected.isLatest
      ? []
      : [ctx.db.patch(selected._id, { isLatest: true, updatedAt: now })]),
    ...latest
      .filter((row) => row._id !== selected._id)
      .map((row) => ctx.db.patch(row._id, { isLatest: false, updatedAt: now })),
  ]);
};

const compatibleObjectVariant = (
  left: Doc<"backup_objects">,
  right: Doc<"backup_objects">,
) =>
  left.objectId === right.objectId &&
  left.keyFingerprint === right.keyFingerprint &&
  left.plaintextSha256 === right.plaintextSha256 &&
  left.plaintextSize === right.plaintextSize;

const compatibleManifestLocator = (
  left: Doc<"backup_manifests">,
  right: Doc<"backup_manifests">,
) =>
  left.keyFingerprint === right.keyFingerprint &&
  left.snapshotId === right.snapshotId &&
  left.originalSnapshotId === right.originalSnapshotId &&
  left.snapshotHash === right.snapshotHash &&
  left.sourceDeviceId === right.sourceDeviceId &&
  left.sourceHostname === right.sourceHostname &&
  left.manifestAlgorithm === right.manifestAlgorithm &&
  left.manifestCiphertextSha256 === right.manifestCiphertextSha256 &&
  left.manifestPlaintextSha256 === right.manifestPlaintextSha256 &&
  left.manifestPlaintextSize === right.manifestPlaintextSize &&
  left.manifestIvBase64Url === right.manifestIvBase64Url &&
  left.manifestAuthTagBase64Url === right.manifestAuthTagBase64Url &&
  left.entryCount === right.entryCount &&
  left.objectCount === right.objectCount &&
  left.version === right.version &&
  left.createdAt === right.createdAt;

const migrateObjectBatch = async (
  ctx: MutationCtx,
  args: LeaseArgs,
  fromOwnerGeneration: string,
  toOwnerGeneration: string,
  availableFingerprints: ReadonlySet<string>,
): Promise<boolean> => {
  const rows = await ctx.db
    .query("backup_objects")
    .withIndex("by_ownerId_and_createdAt", (q) =>
      q.eq("ownerId", args.fromOwnerId),
    )
    .take(BATCH_SIZE);
  if (rows.length === 0) return false;
  for (const row of rows) {
    if (
      row.ownerGeneration !== undefined &&
      row.ownerGeneration !== fromOwnerGeneration
    ) {
      blockMigration("A backup object belongs to a stale account generation.");
    }
    const keyFingerprint =
      row.keyFingerprint ??
      blockMigration("A backup object lost its encryption-key group.");
    if (!availableFingerprints.has(keyFingerprint)) {
      blockMigration(
        `Backup object ${row.objectId} has no matching encryption-key escrow.`,
      );
    }
    const variants = await ctx.db
      .query("backup_objects")
      .withIndex("by_ownerId_and_keyFingerprint_and_objectId", (q) =>
        q
          .eq("ownerId", args.toOwnerId)
          .eq("keyFingerprint", keyFingerprint)
          .eq("objectId", row.objectId),
      )
      .take(MAX_OBJECT_VARIANTS + 1);
    if (variants.length > MAX_OBJECT_VARIANTS) {
      blockMigration("A backup object has too many ciphertext variants.");
    }
    for (const candidate of variants) {
      assertOwnerGeneration(
        candidate,
        toOwnerGeneration,
        `Backup object ${row.objectId}`,
      );
    }
    if (
      variants.some((candidate) => !compatibleObjectVariant(row, candidate))
    ) {
      blockMigration(
        `Backup object ${row.objectId} collides with incompatible destination metadata.`,
      );
    }
    const locatorRows = await ctx.db
      .query("backup_objects")
      .withIndex("by_ownerId_and_r2Key", (q) =>
        q.eq("ownerId", args.toOwnerId).eq("r2Key", row.r2Key),
      )
      .take(2);
    if (locatorRows.length > 1) {
      blockMigration(`Backup R2 locator ${row.r2Key} is not unique.`);
    }
    const locator = locatorRows[0];
    if (locator) {
      assertOwnerGeneration(
        locator,
        toOwnerGeneration,
        `Backup R2 locator ${row.r2Key}`,
      );
      if (
        locator.keyFingerprint !== keyFingerprint ||
        locator.objectId !== row.objectId
      ) {
        blockMigration(
          `Backup R2 locator ${row.r2Key} is already bound to another key-group object.`,
        );
      }
    }
    await Promise.all(
      variants
        .filter((candidate) => candidate.ownerGeneration === undefined)
        .map((candidate) =>
          ctx.db.patch(candidate._id, {
            ownerGeneration: toOwnerGeneration,
          }),
        ),
    );
    const exactLocator = variants.find(
      (candidate) => candidate.r2Key === row.r2Key,
    );
    if (exactLocator) {
      if (
        exactLocator.algorithm !== row.algorithm ||
        exactLocator.ciphertextSha256 !== row.ciphertextSha256 ||
        exactLocator.ivBase64Url !== row.ivBase64Url ||
        exactLocator.authTagBase64Url !== row.authTagBase64Url
      ) {
        blockMigration(
          `Backup object ${row.objectId} reuses an R2 locator with incompatible ciphertext metadata.`,
        );
      }
      await ctx.db.patch(exactLocator._id, {
        ownerGeneration: toOwnerGeneration,
        uploadExpiresAt: Math.max(
          exactLocator.uploadExpiresAt ?? 0,
          row.uploadExpiresAt ?? 0,
        ),
      });
      await ctx.db.delete(row._id);
    } else {
      if (variants.length >= MAX_OBJECT_VARIANTS) {
        blockMigration(
          `Backup object ${row.objectId} cannot retain another ciphertext variant.`,
        );
      }
      await ctx.db.patch(row._id, {
        ownerId: args.toOwnerId,
        ownerGeneration: toOwnerGeneration,
      });
    }
  }
  return true;
};

const importedSnapshotId = (
  original: string,
  rowId: Id<"backup_manifests">,
  attempt: number,
) => {
  const suffix = `~imported~${String(rowId)}${attempt === 0 ? "" : `~${attempt}`}`;
  const prefix = original.slice(
    0,
    Math.max(1, MAX_SNAPSHOT_ID_LENGTH - suffix.length),
  );
  return `${prefix}${suffix}`;
};

const migrateManifestBatch = async (
  ctx: MutationCtx,
  args: LeaseArgs,
  fromOwnerGeneration: string,
  toOwnerGeneration: string,
  availableFingerprints: ReadonlySet<string>,
): Promise<boolean> => {
  const rows = await ctx.db
    .query("backup_manifests")
    .withIndex("by_ownerId_and_createdAt", (q) =>
      q.eq("ownerId", args.fromOwnerId),
    )
    .take(BATCH_SIZE);
  if (rows.length === 0) return false;
  const destinationLatest = await ctx.db
    .query("backup_manifests")
    .withIndex("by_ownerId_and_isLatest", (q) =>
      q.eq("ownerId", args.toOwnerId).eq("isLatest", true),
    )
    .take(1);
  let hasDestinationLatest = destinationLatest.length > 0;
  for (const row of rows) {
    if (
      row.ownerGeneration !== undefined &&
      row.ownerGeneration !== fromOwnerGeneration
    ) {
      blockMigration(
        "A backup manifest belongs to a stale account generation.",
      );
    }
    const keyFingerprint =
      row.keyFingerprint ??
      blockMigration("A backup manifest lost its encryption-key group.");
    if (!availableFingerprints.has(keyFingerprint)) {
      blockMigration(
        `Backup snapshot ${row.snapshotId} has no matching encryption-key escrow.`,
      );
    }
    const locatorRows = await ctx.db
      .query("backup_manifests")
      .withIndex("by_ownerId_and_manifestR2Key", (q) =>
        q.eq("ownerId", args.toOwnerId).eq("manifestR2Key", row.manifestR2Key),
      )
      .take(2);
    if (locatorRows.length > 1) {
      blockMigration(
        `Backup manifest R2 locator ${row.manifestR2Key} is not unique.`,
      );
    }
    const exactLocator = locatorRows[0];
    if (exactLocator) {
      assertOwnerGeneration(
        exactLocator,
        toOwnerGeneration,
        `Backup manifest R2 locator ${row.manifestR2Key}`,
      );
      if (!compatibleManifestLocator(row, exactLocator)) {
        blockMigration(
          `Backup manifest R2 locator ${row.manifestR2Key} has incompatible metadata.`,
        );
      }
      const promoteLatest = row.isLatest && !hasDestinationLatest;
      await ctx.db.patch(exactLocator._id, {
        ownerGeneration: toOwnerGeneration,
        uploadExpiresAt: Math.max(
          exactLocator.uploadExpiresAt ?? 0,
          row.uploadExpiresAt ?? 0,
        ),
        ...(promoteLatest ? { isLatest: true, updatedAt: Date.now() } : {}),
      });
      await ctx.db.delete(row._id);
      hasDestinationLatest ||= promoteLatest || exactLocator.isLatest;
      continue;
    }
    let snapshotId = row.snapshotId;
    const collision = await ctx.db
      .query("backup_manifests")
      .withIndex("by_ownerId_and_snapshotId", (q) =>
        q.eq("ownerId", args.toOwnerId).eq("snapshotId", snapshotId),
      )
      .unique();
    if (collision) {
      assertOwnerGeneration(
        collision,
        toOwnerGeneration,
        `Backup snapshot ${snapshotId}`,
      );
      let resolved: string | null = null;
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const candidate = importedSnapshotId(row.snapshotId, row._id, attempt);
        const occupied = await ctx.db
          .query("backup_manifests")
          .withIndex("by_ownerId_and_snapshotId", (q) =>
            q.eq("ownerId", args.toOwnerId).eq("snapshotId", candidate),
          )
          .unique();
        if (occupied) {
          assertOwnerGeneration(
            occupied,
            toOwnerGeneration,
            `Imported backup snapshot ${candidate}`,
          );
        }
        if (!occupied) {
          resolved = candidate;
          break;
        }
      }
      if (!resolved) {
        blockMigration(
          `No collision-safe imported snapshot id is available for ${row.snapshotId}.`,
        );
      }
      snapshotId =
        resolved ??
        blockMigration(
          `No collision-safe imported snapshot id is available for ${row.snapshotId}.`,
        );
    }
    const keepLatest = row.isLatest && !hasDestinationLatest;
    await ctx.db.patch(row._id, {
      ownerId: args.toOwnerId,
      ownerGeneration: toOwnerGeneration,
      snapshotId,
      ...(snapshotId !== row.snapshotId
        ? { originalSnapshotId: row.originalSnapshotId ?? row.snapshotId }
        : {}),
      isLatest: keepLatest,
      updatedAt: Date.now(),
    });
    hasDestinationLatest ||= keepLatest;
  }
  return true;
};

const mergeEscrows = async (
  ctx: MutationCtx,
  args: LeaseArgs,
  fromOwnerGeneration: string,
  toOwnerGeneration: string,
) => {
  const [source, destination] = await Promise.all([
    listEscrows(ctx, args.fromOwnerId),
    listEscrows(ctx, args.toOwnerId),
  ]);
  assertEscrowGenerations(source, fromOwnerGeneration, "Source account");
  assertEscrowGenerations(
    destination,
    toOwnerGeneration,
    "Destination account",
  );
  const destinationCurrent = uniqueFingerprint(
    destination,
    "The destination account",
  );
  const sourceCurrent = destinationCurrent
    ? null
    : uniqueFingerprint(source, "The source account");
  const currentFingerprint = destinationCurrent ?? sourceCurrent;
  const groups = new Map<string, Array<Doc<"backup_key_escrows">>>();
  for (const row of [...destination, ...source]) {
    const group = groups.get(row.keyFingerprint) ?? [];
    group.push(row);
    groups.set(row.keyFingerprint, group);
  }
  if (groups.size > MAX_KEYS_PER_OWNER) {
    blockMigration("The linked account would contain too many backup keys.");
  }
  for (const [fingerprint, rows] of groups) {
    const canonical =
      rows.find((row) => row.ownerId === args.toOwnerId) ?? rows[0];
    await ctx.db.patch(canonical._id, {
      ownerId: args.toOwnerId,
      ownerGeneration: toOwnerGeneration,
      isCurrent: fingerprint === currentFingerprint,
      updatedAt: Date.now(),
    });
    for (const duplicate of rows) {
      if (duplicate._id !== canonical._id) {
        await ctx.db.delete(duplicate._id);
      }
    }
  }
};

/**
 * Losslessly re-owns finalized encrypted backups during anonymous -> account
 * linking. R2 keys are immutable: only Convex ownership/generation metadata is
 * moved. Old PUT authorities must expire before the first row changes, while
 * unfinalized reservations are physically deleted by the preceding action.
 */
export const migrateBackupsBatchInternal = internalMutation({
  args: leaseArgs,
  returns: resultValidator,
  handler: async (ctx, args) => {
    const { fromOwnerGeneration, toOwnerGeneration } =
      await requireMigrationLease(ctx, args);

    const [sourceReservation, destinationReservation] = await Promise.all([
      ctx.db
        .query("backup_upload_reservations")
        .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1),
      ctx.db
        .query("backup_upload_reservations")
        .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
          q.eq("ownerId", args.toOwnerId),
        )
        .take(1),
    ]);
    const reservation = sourceReservation[0] ?? destinationReservation[0];
    if (reservation) {
      return {
        hasMore: true,
        retryAfterMs: Math.max(1_000, reservation.uploadExpiresAt - Date.now()),
      };
    }

    const now = Date.now();
    const [fencedLegacySource, fencedLegacyDestination] = await Promise.all([
      fenceLegacyUploadAuthority(ctx, args.fromOwnerId, now),
      fenceLegacyUploadAuthority(ctx, args.toOwnerId, now),
    ]);
    if (fencedLegacySource || fencedLegacyDestination) {
      return {
        hasMore: true,
        retryAfterMs: LEGACY_UPLOAD_AUTHORITY_FENCE_MS,
      };
    }
    const [sourceActiveExpiry, destinationActiveExpiry] = await Promise.all([
      nextActiveUploadExpiry(ctx, args.fromOwnerId, now),
      nextActiveUploadExpiry(ctx, args.toOwnerId, now),
    ]);
    const activeExpiries = [sourceActiveExpiry, destinationActiveExpiry].filter(
      (value): value is number => value !== null,
    );
    if (activeExpiries.length > 0) {
      const activeExpiry = Math.min(...activeExpiries);
      return {
        hasMore: true,
        retryAfterMs: Math.max(1_000, activeExpiry - now),
      };
    }

    const [sourceEscrows, destinationEscrows] = await Promise.all([
      listEscrows(ctx, args.fromOwnerId),
      listEscrows(ctx, args.toOwnerId),
    ]);
    assertEscrowGenerations(
      sourceEscrows,
      fromOwnerGeneration,
      "Source account",
    );
    assertEscrowGenerations(
      destinationEscrows,
      toOwnerGeneration,
      "Destination account",
    );
    // A matching fingerprint is not enough authority to discard one escrow.
    // Decrypt and bind every key before the first ownership patch so corrupt
    // or adversarial duplicate rows cannot cause irreversible key loss after a
    // partially-completed migration.
    await assertEscrowKeyMaterial([...sourceEscrows, ...destinationEscrows]);
    // Validate the merged current-key invariant before the first bounded
    // ownership patch. This avoids entering a repair loop after rows have
    // transferred while their decrypting escrows remain on the source owner.
    const destinationCurrent = uniqueFingerprint(
      destinationEscrows,
      "The destination account",
    );
    if (!destinationCurrent) {
      uniqueFingerprint(sourceEscrows, "The source account");
    }
    if (
      new Set(
        [...sourceEscrows, ...destinationEscrows].map(
          (escrow) => escrow.keyFingerprint,
        ),
      ).size > MAX_KEYS_PER_OWNER
    ) {
      blockMigration("The linked account would contain too many backup keys.");
    }

    await Promise.all([
      repairLatestRows(
        ctx,
        args.fromOwnerId,
        fromOwnerGeneration,
        "A source latest backup snapshot",
      ),
      repairLatestRows(
        ctx,
        args.toOwnerId,
        toOwnerGeneration,
        "A destination latest backup snapshot",
      ),
    ]);

    if (
      await normalizeLegacyObject(ctx, args.toOwnerId, toOwnerGeneration, () =>
        resolveLegacyFingerprint(
          sourceEscrows,
          destinationEscrows,
          "destination",
        ),
      )
    ) {
      return { hasMore: true };
    }
    if (
      await normalizeLegacyManifest(
        ctx,
        args.toOwnerId,
        toOwnerGeneration,
        () =>
          resolveLegacyFingerprint(
            sourceEscrows,
            destinationEscrows,
            "destination",
          ),
      )
    ) {
      return { hasMore: true };
    }
    if (
      await normalizeLegacyObject(
        ctx,
        args.fromOwnerId,
        fromOwnerGeneration,
        () =>
          resolveLegacyFingerprint(sourceEscrows, destinationEscrows, "source"),
      )
    ) {
      return { hasMore: true };
    }
    if (
      await normalizeLegacyManifest(
        ctx,
        args.fromOwnerId,
        fromOwnerGeneration,
        () =>
          resolveLegacyFingerprint(sourceEscrows, destinationEscrows, "source"),
      )
    ) {
      return { hasMore: true };
    }

    const availableFingerprints = new Set(
      [...sourceEscrows, ...destinationEscrows].map(
        (escrow) => escrow.keyFingerprint,
      ),
    );

    if (
      await migrateObjectBatch(
        ctx,
        args,
        fromOwnerGeneration,
        toOwnerGeneration,
        availableFingerprints,
      )
    ) {
      return { hasMore: true };
    }
    if (
      await migrateManifestBatch(
        ctx,
        args,
        fromOwnerGeneration,
        toOwnerGeneration,
        availableFingerprints,
      )
    ) {
      return { hasMore: true };
    }
    await ensureDestinationLatest(ctx, args.toOwnerId, toOwnerGeneration);
    await mergeEscrows(ctx, args, fromOwnerGeneration, toOwnerGeneration);
    return { hasMore: false };
  },
});

/** One crash-safe account-link pass: cleanup abandoned PUTs, then re-own data. */
export const migrateBackupsForOwnershipPassInternal = internalAction({
  args: migrationControlArgs,
  returns: v.object({
    ready: v.boolean(),
    retryAfterMs: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    // Publish the source+destination writer barrier immediately. Reservation
    // cleanup continues during the same 20-minute quiescence window, but no
    // ownership mutation is reachable until the raw legacy prefixes have also
    // completed a clean verification pass.
    const legacySweep = await ctx.runAction(advanceLegacyR2SweepRef, args);
    const cleanup = await ctx.runAction(cleanupReservationsRef, args);
    if (!legacySweep.ready || !cleanup.ready) {
      const retryAfterMs = Math.min(
        legacySweep.retryAfterMs ?? Number.POSITIVE_INFINITY,
        cleanup.retryAfterMs ?? Number.POSITIVE_INFINITY,
      );
      return {
        ready: false,
        retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : 1_000,
      };
    }
    const migrated = await ctx.runMutation(migrateBackupsBatchRef, {
      fromOwnerId: args.fromOwnerId,
      toOwnerId: args.toOwnerId,
      leaseId: args.leaseId,
      leaseGeneration: args.leaseGeneration,
      leaseNow: Date.now(),
    });
    if (migrated.hasMore) {
      return { ready: false, retryAfterMs: migrated.retryAfterMs ?? 1_000 };
    }
    return { ready: true };
  },
});
