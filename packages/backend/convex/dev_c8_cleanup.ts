import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  C8_DESTRUCTIVE_CONFIRMATION,
  C8_DEV_DEPLOYMENT,
  C8_DEV_CLOUD_URL,
  C8_DEV_SITE_URL,
  C8_RETIRED_WRITES_VALUE,
  assertC8CleanupDeployment,
  getC8WriterCutoverStatus,
} from "./lib/c8_retired_surface";
import { EXTERNAL_MEDIA_PRESIGNED_BARRIER_MS } from "./account_external_media_store";
import { requireConfiguredRawR2MediaTarget } from "./lib/raw_r2_media_target";

const MAX_BATCH = 32;
const MAX_EXTERNAL_LOCATORS_PER_SOURCE = 8;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const STORE_DIFF_PREFIX = "store/git-diffs/";
const STORE_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const STORE_PACKAGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;
const STORE_UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_STORE_DIFF_BYTES = 5 * 1024 * 1024;
const C8_CUTOVER_KEY = "c8-retired-writers" as const;
const C8_ARM_CONFIRMATION =
  "ARM C8 RETIRED WRITERS ON impartial-crab-34" as const;
const C8_WRITER_QUIET_BARRIER_MS = EXTERNAL_MEDIA_PRESIGNED_BARRIER_MS;

const cleanupPhaseValidator = v.union(
  v.literal("stella_session_file_ops"),
  v.literal("stella_session_files"),
  v.literal("stella_session_file_blobs"),
  v.literal("stella_session_turns"),
  v.literal("stella_session_members"),
  v.literal("stella_sessions"),
  v.literal("social_messages"),
  v.literal("social_room_members"),
  v.literal("social_rooms"),
  v.literal("social_relationships"),
  v.literal("social_profiles"),
  v.literal("retired_external_media_locators"),
  v.literal("store_package_releases"),
  v.literal("store_packages"),
  v.literal("pet_tag_membership"),
  v.literal("pet_tag_facets"),
  v.literal("pet_catalog"),
  v.literal("user_pets"),
  v.literal("user_pet_external_media_locators"),
  v.literal("emoji_packs.authorUsername"),
);

type CleanupPhase =
  | "stella_session_file_ops"
  | "stella_session_files"
  | "stella_session_file_blobs"
  | "stella_session_turns"
  | "stella_session_members"
  | "stella_sessions"
  | "social_messages"
  | "social_room_members"
  | "social_rooms"
  | "social_relationships"
  | "social_profiles"
  | "retired_external_media_locators"
  | "store_package_releases"
  | "store_packages"
  | "pet_tag_membership"
  | "pet_tag_facets"
  | "pet_catalog"
  | "user_pets"
  | "user_pet_external_media_locators"
  | "emoji_packs.authorUsername";

type RetiredTableName = Exclude<
  CleanupPhase,
  | "retired_external_media_locators"
  | "user_pet_external_media_locators"
  | "emoji_packs.authorUsername"
>;

export const C8_CLEANUP_PHASES: readonly CleanupPhase[] = [
  "stella_session_file_ops",
  "stella_session_files",
  "stella_session_file_blobs",
  "stella_session_turns",
  "stella_session_members",
  "stella_sessions",
  "social_messages",
  "social_room_members",
  "social_rooms",
  "social_relationships",
  "social_profiles",
  "retired_external_media_locators",
  "store_package_releases",
  "store_packages",
  "pet_tag_membership",
  "pet_tag_facets",
  "pet_catalog",
  "user_pets",
  "user_pet_external_media_locators",
  "emoji_packs.authorUsername",
] as const;

const databasePhaseValidator = v.union(
  v.literal("stella_session_file_ops"),
  v.literal("stella_session_files"),
  v.literal("stella_session_file_blobs"),
  v.literal("stella_session_turns"),
  v.literal("stella_session_members"),
  v.literal("stella_sessions"),
  v.literal("social_messages"),
  v.literal("social_room_members"),
  v.literal("social_rooms"),
  v.literal("social_relationships"),
  v.literal("social_profiles"),
  v.literal("store_packages"),
  v.literal("pet_tag_membership"),
  v.literal("pet_tag_facets"),
  v.literal("pet_catalog"),
  v.literal("emoji_packs.authorUsername"),
);

type DatabasePhase = Exclude<
  CleanupPhase,
  | "store_package_releases"
  | "user_pets"
  | "retired_external_media_locators"
  | "user_pet_external_media_locators"
>;

const auditResultValidator = v.object({
  phase: cleanupPhaseValidator,
  scanned: v.number(),
  matched: v.number(),
  identifiers: v.array(v.string()),
  retainedSharedR2Objects: v.number(),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

const batchResultValidator = v.object({
  phase: databasePhaseValidator,
  dryRun: v.boolean(),
  scanned: v.number(),
  deletedRows: v.number(),
  deletedStorageObjects: v.number(),
  patchedRows: v.number(),
  identifiers: v.array(v.string()),
  hasMore: v.boolean(),
  continueCursor: v.optional(v.string()),
});

const storeR2RefValidator = v.object({
  role: v.union(v.literal("diff"), v.literal("commits-diff")),
  key: v.string(),
  sha256: v.string(),
  sizeBytes: v.number(),
});

const storeGitObjectDebtValidator = v.object({
  key: v.string(),
  sha: v.string(),
  type: v.union(v.literal("blob"), v.literal("tree"), v.literal("commit")),
  sizeBytes: v.number(),
});

const storeManifestValidator = v.object({
  policy: v.literal("retain-shared-stella-files-objects"),
  releaseId: v.id("store_package_releases"),
  ownerId: v.string(),
  packageId: v.string(),
  releaseNumber: v.number(),
  r2Refs: v.array(storeR2RefValidator),
  gitObjects: v.array(storeGitObjectDebtValidator),
});

type StoreManifest = {
  policy: "retain-shared-stella-files-objects";
  releaseId: Id<"store_package_releases">;
  ownerId: string;
  packageId: string;
  releaseNumber: number;
  r2Refs: Array<{
    role: "diff" | "commits-diff";
    key: string;
    sha256: string;
    sizeBytes: number;
  }>;
  gitObjects: Array<{
    key: string;
    sha: string;
    type: "blob" | "tree" | "commit";
    sizeBytes: number;
  }>;
};

const storeLocatorManifestValidator = v.object({
  policy: v.literal("retain-shared-stella-files-object"),
  reason: v.union(
    v.literal("store-release-locator"),
    v.literal("expired-source-less-store-diff"),
  ),
  locatorId: v.id("account_external_media_objects"),
  ownerId: v.string(),
  ownerGeneration: v.string(),
  uploadId: v.string(),
  objectRole: v.string(),
  storageKind: v.literal("component-r2"),
  r2Key: v.string(),
  payloadSha256: v.string(),
  state: v.union(v.literal("reserved"), v.literal("committed")),
  uploadExpiresAt: v.number(),
  sourceKind: v.optional(v.literal("store_release")),
  sourceId: v.optional(v.string()),
  sourceKey: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

type StoreLocatorManifest = {
  policy: "retain-shared-stella-files-object";
  reason: "store-release-locator" | "expired-source-less-store-diff";
  locatorId: Id<"account_external_media_objects">;
  ownerId: string;
  ownerGeneration: string;
  uploadId: string;
  objectRole: string;
  storageKind: "component-r2";
  r2Key: string;
  payloadSha256: string;
  state: "reserved" | "committed";
  uploadExpiresAt: number;
  sourceKind?: "store_release";
  sourceId?: string;
  sourceKey?: string;
  createdAt: number;
  updatedAt: number;
};

const userPetObjectManifestValidator = v.object({
  role: v.union(v.literal("spritesheet"), v.literal("preview")),
  bucket: v.string(),
  r2Key: v.string(),
  publicUrl: v.string(),
  locatorId: v.optional(v.id("account_external_media_objects")),
});

const userPetManifestValidator = v.object({
  policy: v.literal("delete-exact-development-raw-r2-before-row"),
  petRowId: v.id("user_pets"),
  ownerId: v.string(),
  petId: v.string(),
  updatedAt: v.number(),
  objects: v.array(userPetObjectManifestValidator),
});

type UserPetManifest = {
  policy: "delete-exact-development-raw-r2-before-row";
  petRowId: Id<"user_pets">;
  ownerId: string;
  petId: string;
  updatedAt: number;
  objects: Array<{
    role: "spritesheet" | "preview";
    bucket: string;
    r2Key: string;
    publicUrl: string;
    locatorId?: Id<"account_external_media_objects">;
  }>;
};

const userPetOrphanManifestValidator = v.object({
  policy: v.literal("delete-exact-development-raw-r2-before-locator"),
  locatorId: v.id("account_external_media_objects"),
  ownerId: v.string(),
  sourceId: v.string(),
  role: v.union(v.literal("spritesheet"), v.literal("preview")),
  bucket: v.string(),
  r2Key: v.string(),
  publicUrl: v.string(),
  uploadExpiresAt: v.number(),
  updatedAt: v.number(),
});

type UserPetOrphanManifest = {
  policy: "delete-exact-development-raw-r2-before-locator";
  locatorId: Id<"account_external_media_objects">;
  ownerId: string;
  sourceId: string;
  role: "spritesheet" | "preview";
  bucket: string;
  r2Key: string;
  publicUrl: string;
  uploadExpiresAt: number;
  updatedAt: number;
};

const validateLimit = (value: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > MAX_BATCH) {
    throw new ConvexError({
      code: "C8_CLEANUP_INVALID_BATCH",
      message: `c8 cleanup batches must contain between 1 and ${MAX_BATCH} rows.`,
    });
  }
  return value;
};

const assertDestructiveAuthority = (args: {
  dryRun: boolean;
  confirmation?: string;
}): void => {
  assertC8CleanupDeployment(process.env);
  if (!args.dryRun && args.confirmation !== C8_DESTRUCTIVE_CONFIRMATION) {
    throw new ConvexError({
      code: "C8_CLEANUP_CONFIRMATION_REQUIRED",
      message: "The exact c8 destructive confirmation is required.",
    });
  }
};

const phaseTable = (phase: CleanupPhase): RetiredTableName | null => {
  if (
    phase === "retired_external_media_locators" ||
    phase === "user_pet_external_media_locators" ||
    phase === "emoji_packs.authorUsername"
  ) {
    return null;
  }
  return phase;
};

const paginateTable = async <TableName extends RetiredTableName>(
  ctx: QueryCtx,
  table: TableName,
  args: { cursor: string | null; numItems: number },
) => await ctx.db.query(table).paginate(args);

const isExpiredSourceLessStoreDiff = (
  row: Doc<"account_external_media_objects">,
  now: number,
): boolean =>
  row.objectRole === "store-diff" &&
  row.storageKind === "component-r2" &&
  row.state === "reserved" &&
  row.sourceKind === undefined &&
  row.sourceId === undefined &&
  row.sourceKey === undefined &&
  row.uploadExpiresAt <= now;

const isRetiredStoreExternalLocator = (
  row: Doc<"account_external_media_objects">,
  now: number,
): boolean =>
  row.sourceKind === "store_release" || isExpiredSourceLessStoreDiff(row, now);

const isRetiredUserPetLocator = (
  row: Doc<"account_external_media_objects">,
): boolean => row.sourceKind === "user_pet";

export const getWriterCutoverStatusInternal = internalQuery({
  args: { deployment: v.literal(C8_DEV_DEPLOYMENT) },
  returns: v.object({
    deployment: v.literal(C8_DEV_DEPLOYMENT),
    cloudUrlMatches: v.boolean(),
    siteUrlMatches: v.boolean(),
    retiredWritesDisabled: v.boolean(),
  }),
  handler: async () => ({
    deployment: C8_DEV_DEPLOYMENT,
    ...getC8WriterCutoverStatus(process.env),
  }),
});

const cutoverStateValidator = v.object({
  key: v.literal(C8_CUTOVER_KEY),
  deployment: v.literal(C8_DEV_DEPLOYMENT),
  cloudUrl: v.literal(C8_DEV_CLOUD_URL),
  siteUrl: v.literal(C8_DEV_SITE_URL),
  markerValue: v.literal(C8_RETIRED_WRITES_VALUE),
  armedAt: v.number(),
  barrierMs: v.number(),
  barrierClosesAt: v.number(),
  closed: v.boolean(),
});

const readCutoverState = async (ctx: QueryCtx | MutationCtx) => {
  const rows = await ctx.db
    .query("c8_cleanup_cutover")
    .withIndex("by_key", (q) => q.eq("key", C8_CUTOVER_KEY))
    .take(2);
  if (rows.length !== 1) {
    throw new ConvexError({
      code: "C8_CLEANUP_CUTOVER_NOT_ARMED",
      message:
        "The durable c8 writer cutover singleton is missing or duplicated.",
    });
  }
  const row = rows[0]!;
  if (
    row.deployment !== C8_DEV_DEPLOYMENT ||
    row.cloudUrl !== C8_DEV_CLOUD_URL ||
    row.siteUrl !== C8_DEV_SITE_URL ||
    row.markerValue !== C8_RETIRED_WRITES_VALUE ||
    row.barrierMs < C8_WRITER_QUIET_BARRIER_MS
  ) {
    throw new ConvexError({
      code: "C8_CLEANUP_CUTOVER_MISMATCH",
      message:
        "The durable c8 writer cutover state is not the exact approved state.",
    });
  }
  return row;
};

const assertCleanupBarrierClosed = async (
  ctx: QueryCtx | MutationCtx,
): Promise<void> => {
  const row = await readCutoverState(ctx);
  if (Date.now() < row.armedAt + row.barrierMs) {
    throw new ConvexError({
      code: "C8_CLEANUP_QUIET_BARRIER_OPEN",
      message:
        "The server-enforced presigned-write quiet barrier is still open.",
    });
  }
};

/** Arms the one-way server clock only after the guarded writer build is live. */
export const armWriterCutoverInternal = internalMutation({
  args: {
    deployment: v.literal(C8_DEV_DEPLOYMENT),
    confirmation: v.literal(C8_ARM_CONFIRMATION),
  },
  returns: cutoverStateValidator,
  handler: async (ctx) => {
    assertC8CleanupDeployment(process.env);
    const now = Date.now();
    const existing = await ctx.db
      .query("c8_cleanup_cutover")
      .withIndex("by_key", (q) => q.eq("key", C8_CUTOVER_KEY))
      .take(2);
    if (existing.length > 1) {
      throw new ConvexError({
        code: "C8_CLEANUP_CUTOVER_DUPLICATED",
        message: "The c8 writer cutover singleton is duplicated.",
      });
    }
    let armedAt = now;
    let barrierMs = C8_WRITER_QUIET_BARRIER_MS;
    if (existing[0]) {
      const row = existing[0];
      if (
        row.deployment !== C8_DEV_DEPLOYMENT ||
        row.cloudUrl !== C8_DEV_CLOUD_URL ||
        row.siteUrl !== C8_DEV_SITE_URL ||
        row.markerValue !== C8_RETIRED_WRITES_VALUE
      ) {
        throw new ConvexError({
          code: "C8_CLEANUP_CUTOVER_MISMATCH",
          message: "The existing c8 writer cutover state is not approved.",
        });
      }
      armedAt = row.armedAt;
      barrierMs = Math.max(row.barrierMs, C8_WRITER_QUIET_BARRIER_MS);
      await ctx.db.patch(row._id, { barrierMs, updatedAt: now });
    } else {
      await ctx.db.insert("c8_cleanup_cutover", {
        key: C8_CUTOVER_KEY,
        deployment: C8_DEV_DEPLOYMENT,
        cloudUrl: C8_DEV_CLOUD_URL,
        siteUrl: C8_DEV_SITE_URL,
        markerValue: C8_RETIRED_WRITES_VALUE,
        armedAt,
        barrierMs,
        createdAt: now,
        updatedAt: now,
      });
    }
    return {
      key: C8_CUTOVER_KEY,
      deployment: C8_DEV_DEPLOYMENT,
      cloudUrl: C8_DEV_CLOUD_URL,
      siteUrl: C8_DEV_SITE_URL,
      markerValue: C8_RETIRED_WRITES_VALUE,
      armedAt,
      barrierMs,
      barrierClosesAt: armedAt + barrierMs,
      closed: now >= armedAt + barrierMs,
    };
  },
});

export const getDurableCutoverStateInternal = internalQuery({
  args: { deployment: v.literal(C8_DEV_DEPLOYMENT) },
  returns: cutoverStateValidator,
  handler: async (ctx) => {
    assertC8CleanupDeployment(process.env);
    const row = await readCutoverState(ctx);
    const now = Date.now();
    return {
      key: C8_CUTOVER_KEY,
      deployment: C8_DEV_DEPLOYMENT,
      cloudUrl: C8_DEV_CLOUD_URL,
      siteUrl: C8_DEV_SITE_URL,
      markerValue: C8_RETIRED_WRITES_VALUE,
      armedAt: row.armedAt,
      barrierMs: row.barrierMs,
      barrierClosesAt: row.armedAt + row.barrierMs,
      closed: now >= row.armedAt + row.barrierMs,
    };
  },
});

/** Bounded, cursor-based inventory used for both dry-run and final zero audit. */
export const auditPhaseInternal = internalQuery({
  args: {
    deployment: v.literal(C8_DEV_DEPLOYMENT),
    phase: cleanupPhaseValidator,
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  returns: auditResultValidator,
  handler: async (ctx, args) => {
    assertC8CleanupDeployment(process.env);
    const numItems = validateLimit(args.numItems);
    if (args.phase === "emoji_packs.authorUsername") {
      const page = await ctx.db.query("emoji_packs").paginate({
        cursor: args.cursor,
        numItems,
      });
      const matches = page.page.filter(
        (row) => row.authorUsername !== undefined,
      );
      return {
        phase: args.phase,
        scanned: page.page.length,
        matched: matches.length,
        identifiers: matches.map((row) => String(row._id)),
        retainedSharedR2Objects: 0,
        isDone: page.isDone,
        continueCursor: page.continueCursor,
      };
    }
    if (
      args.phase === "retired_external_media_locators" ||
      args.phase === "user_pet_external_media_locators"
    ) {
      const page = await ctx.db
        .query("account_external_media_objects")
        .paginate({ cursor: args.cursor, numItems });
      const now = Date.now();
      const matches = page.page.filter((row) =>
        args.phase === "retired_external_media_locators"
          ? isRetiredStoreExternalLocator(row, now)
          : isRetiredUserPetLocator(row),
      );
      return {
        phase: args.phase,
        scanned: page.page.length,
        matched: matches.length,
        identifiers: matches.map((row) => String(row._id)),
        retainedSharedR2Objects: matches.filter(
          (row) => row.storageKind === "component-r2",
        ).length,
        isDone: page.isDone,
        continueCursor: page.continueCursor,
      };
    }
    if (args.phase === "store_package_releases") {
      const page = await ctx.db.query("store_package_releases").paginate({
        cursor: args.cursor,
        numItems,
      });
      return {
        phase: args.phase,
        scanned: page.page.length,
        matched: page.page.length,
        identifiers: page.page.map((row) => String(row._id)),
        retainedSharedR2Objects: page.page.reduce(
          (total, row) =>
            total +
            (row.diffRef ? 1 : 0) +
            (row.commitsDiffRef ? 1 : 0) +
            (row.gitArtifact?.objects.length ?? 0),
          0,
        ),
        isDone: page.isDone,
        continueCursor: page.continueCursor,
      };
    }
    const table = phaseTable(args.phase);
    if (!table) throw new Error("unreachable c8 audit phase");
    const page = await paginateTable(ctx, table, {
      cursor: args.cursor,
      numItems,
    });
    return {
      phase: args.phase,
      scanned: page.page.length,
      matched: page.page.length,
      identifiers: page.page.map((row) => String(row._id)),
      retainedSharedR2Objects: 0,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

const assertTablesEmpty = async (
  ctx: QueryCtx | MutationCtx,
  tables: readonly RetiredTableName[],
  nextPhase: CleanupPhase,
): Promise<void> => {
  for (const table of tables) {
    if ((await ctx.db.query(table).first()) !== null) {
      throw new ConvexError({
        code: "C8_CLEANUP_OUT_OF_ORDER",
        message: `Cannot clean ${nextPhase} while ${table} still has rows.`,
      });
    }
  }
};

const tablesBefore = (phase: CleanupPhase): RetiredTableName[] => {
  const index = C8_CLEANUP_PHASES.indexOf(phase);
  return C8_CLEANUP_PHASES.slice(0, Math.max(0, index))
    .map(phaseTable)
    .filter((table): table is RetiredTableName => table !== null);
};

const deletePlainRows = async <TableName extends RetiredTableName>(
  ctx: MutationCtx,
  table: TableName,
  limit: number,
  dryRun: boolean,
) => {
  const rows = await ctx.db.query(table).take(limit);
  if (!dryRun) {
    for (const row of rows) await ctx.db.delete(row._id);
  }
  return rows;
};

const deleteStorageRows = async (
  ctx: MutationCtx,
  phase:
    | "stella_session_file_ops"
    | "stella_session_files"
    | "stella_session_file_blobs",
  limit: number,
  dryRun: boolean,
) => {
  const rows =
    phase === "stella_session_file_ops"
      ? await ctx.db.query("stella_session_file_ops").take(limit)
      : phase === "stella_session_files"
        ? await ctx.db.query("stella_session_files").take(limit)
        : await ctx.db.query("stella_session_file_blobs").take(limit);
  const storageIds = new Set<Id<"_storage">>();
  for (const row of rows) {
    if (row.storageId) storageIds.add(row.storageId);
  }
  if (!dryRun) {
    for (const storageId of storageIds) await ctx.storage.delete(storageId);
    for (const row of rows) await ctx.db.delete(row._id);
  }
  return { rows, storageIds: [...storageIds] };
};

/**
 * Deletes one bounded database batch. Store releases and user pets are
 * intentionally excluded because their external-reference policies require a
 * separate manifest/delete handshake.
 */
export const runDatabaseBatchInternal = internalMutation({
  args: {
    deployment: v.literal(C8_DEV_DEPLOYMENT),
    phase: databasePhaseValidator,
    limit: v.number(),
    dryRun: v.boolean(),
    confirmation: v.optional(v.literal(C8_DESTRUCTIVE_CONFIRMATION)),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: batchResultValidator,
  handler: async (ctx, args) => {
    assertDestructiveAuthority(args);
    if (!args.dryRun) await assertCleanupBarrierClosed(ctx);
    const limit = validateLimit(args.limit);
    const phase = args.phase as DatabasePhase;
    await assertTablesEmpty(ctx, tablesBefore(phase), phase);

    if (phase === "emoji_packs.authorUsername") {
      const page = await ctx.db.query("emoji_packs").paginate({
        cursor: args.cursor ?? null,
        numItems: limit,
      });
      const matches = page.page.filter(
        (row) => row.authorUsername !== undefined,
      );
      if (!args.dryRun) {
        for (const row of matches) {
          await ctx.db.patch(row._id, { authorUsername: undefined });
        }
      }
      return {
        phase,
        dryRun: args.dryRun,
        scanned: page.page.length,
        deletedRows: 0,
        deletedStorageObjects: 0,
        patchedRows: args.dryRun ? 0 : matches.length,
        identifiers: matches.map((row) => String(row._id)),
        hasMore: !page.isDone,
        continueCursor: page.continueCursor,
      };
    }

    if (
      phase === "stella_session_file_ops" ||
      phase === "stella_session_files" ||
      phase === "stella_session_file_blobs"
    ) {
      const result = await deleteStorageRows(ctx, phase, limit, args.dryRun);
      const hasMore = args.dryRun
        ? result.rows.length === limit
        : (await ctx.db.query(phase).first()) !== null;
      return {
        phase,
        dryRun: args.dryRun,
        scanned: result.rows.length,
        deletedRows: args.dryRun ? 0 : result.rows.length,
        deletedStorageObjects: args.dryRun ? 0 : result.storageIds.length,
        patchedRows: 0,
        identifiers: result.rows.map((row) => String(row._id)),
        hasMore,
      };
    }

    const table = phase as Exclude<
      DatabasePhase,
      | "stella_session_file_ops"
      | "stella_session_files"
      | "stella_session_file_blobs"
      | "emoji_packs.authorUsername"
    >;
    const rows = await deletePlainRows(ctx, table, limit, args.dryRun);
    const hasMore = args.dryRun
      ? rows.length === limit
      : (await ctx.db.query(table).first()) !== null;
    return {
      phase,
      dryRun: args.dryRun,
      scanned: rows.length,
      deletedRows: args.dryRun ? 0 : rows.length,
      deletedStorageObjects: 0,
      patchedRows: 0,
      identifiers: rows.map((row) => String(row._id)),
      hasMore,
    };
  },
});

const storeManifestForRelease = (
  release: Doc<"store_package_releases">,
): StoreManifest => {
  const r2Refs: StoreManifest["r2Refs"] = [];
  if (release.diffRef) {
    r2Refs.push({
      role: "diff",
      key: release.diffRef.r2Key,
      sha256: release.diffRef.sha256,
      sizeBytes: release.diffRef.sizeBytes,
    });
  }
  if (release.commitsDiffRef) {
    r2Refs.push({
      role: "commits-diff",
      key: release.commitsDiffRef.r2Key,
      sha256: release.commitsDiffRef.sha256,
      sizeBytes: release.commitsDiffRef.sizeBytes,
    });
  }
  const safeOwnerSegment =
    release.ownerId
      .trim()
      .replace(/[^a-zA-Z0-9._-]/gu, "_")
      .replace(/^_+|_+$/gu, "")
      .slice(0, 160) || "unknown";
  if (!STORE_PACKAGE_ID_PATTERN.test(release.packageId)) {
    throw new ConvexError({
      code: "C8_CLEANUP_UNSAFE_STORE_PACKAGE_ID",
      message: `Store release ${release._id} has an unsafe package ID.`,
    });
  }
  const expectedPrefix = `${STORE_DIFF_PREFIX}${safeOwnerSegment}/${release.packageId}/`;
  for (const ref of r2Refs) {
    const filename = ref.key.startsWith(expectedPrefix)
      ? ref.key.slice(expectedPrefix.length)
      : "";
    const suffix = ref.sha256.slice("sha256:".length, "sha256:".length + 16);
    const expectedSuffix = `-${suffix}.diff`;
    const uploadId = filename.endsWith(expectedSuffix)
      ? filename.slice(0, -expectedSuffix.length)
      : "";
    if (
      !STORE_SHA256_PATTERN.test(ref.sha256) ||
      !Number.isInteger(ref.sizeBytes) ||
      ref.sizeBytes < 1 ||
      ref.sizeBytes > MAX_STORE_DIFF_BYTES ||
      !STORE_UPLOAD_ID_PATTERN.test(uploadId) ||
      filename !== `${uploadId}${expectedSuffix}`
    ) {
      throw new ConvexError({
        code: "C8_CLEANUP_UNSAFE_STORE_R2_REF",
        message: `Store release ${release._id} has a noncanonical R2 reference.`,
      });
    }
  }
  const gitObjects = (release.gitArtifact?.objects ?? []).map((object) => {
    if (!GIT_SHA_PATTERN.test(object.sha)) {
      throw new ConvexError({
        code: "C8_CLEANUP_UNSAFE_GIT_OBJECT_REF",
        message: `Store release ${release._id} has an invalid Git object SHA.`,
      });
    }
    return {
      key: `store/git-objects/${object.sha.slice(0, 2)}/${object.sha.slice(2)}`,
      sha: object.sha,
      type: object.type,
      sizeBytes: object.sizeBytes,
    };
  });
  return {
    policy: "retain-shared-stella-files-objects",
    releaseId: release._id,
    ownerId: release.ownerId,
    packageId: release.packageId,
    releaseNumber: release.releaseNumber,
    r2Refs,
    gitObjects,
  };
};

const sha256Json = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const storeLocatorManifestForRow = async (
  ctx: QueryCtx | MutationCtx,
  row: Doc<"account_external_media_objects">,
  now: number,
): Promise<StoreLocatorManifest> => {
  if (
    row.storageKind !== "component-r2" ||
    row.bucket !== undefined ||
    row.state === "external_deleted" ||
    row.uploadExpiresAt > now ||
    !STORE_SHA256_PATTERN.test(row.payloadSha256)
  ) {
    throw new ConvexError({
      code: "C8_CLEANUP_UNSAFE_STORE_LOCATOR",
      message:
        "The Store locator is not an expired shared component-R2 reference.",
    });
  }
  const parts = row.r2Key.split("/");
  const expectedOwner =
    row.ownerId
      .trim()
      .replace(/[^a-zA-Z0-9._-]/gu, "_")
      .replace(/^_+|_+$/gu, "")
      .slice(0, 160) || "unknown";
  const filename = parts[4] ?? "";
  const expectedHashSuffix = row.payloadSha256.slice("sha256:".length, 23);
  const filenameMatch = filename.match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([0-9a-f]{16})\.diff$/u,
  );
  if (
    parts.length !== 5 ||
    parts[0] !== "store" ||
    parts[1] !== "git-diffs" ||
    parts[2] !== expectedOwner ||
    !STORE_PACKAGE_ID_PATTERN.test(parts[3] ?? "") ||
    !filenameMatch ||
    filenameMatch[2] !== expectedHashSuffix
  ) {
    throw new ConvexError({
      code: "C8_CLEANUP_UNSAFE_STORE_LOCATOR",
      message:
        "The Store locator key is not in the exact canonical owner/package grammar.",
    });
  }

  let reason: StoreLocatorManifest["reason"];
  if (row.sourceKind === "store_release") {
    if (
      !row.sourceId ||
      row.sourceKey !== `store_release:${row.sourceId}` ||
      !["diff", "commits-diff", "store-diff"].includes(row.objectRole)
    ) {
      throw new ConvexError({
        code: "C8_CLEANUP_UNSAFE_STORE_LOCATOR",
        message: "The Store release locator source binding is malformed.",
      });
    }
    const releaseId = ctx.db.normalizeId(
      "store_package_releases",
      row.sourceId,
    );
    const release = releaseId ? await ctx.db.get(releaseId) : null;
    if (release) {
      const refs = [release.diffRef, release.commitsDiffRef].filter(
        (ref): ref is NonNullable<typeof ref> => ref !== undefined,
      );
      if (
        release.ownerId !== row.ownerId ||
        release.packageId !== parts[3] ||
        !refs.some(
          (ref) => ref.r2Key === row.r2Key && ref.sha256 === row.payloadSha256,
        )
      ) {
        throw new ConvexError({
          code: "C8_CLEANUP_STORE_LOCATOR_RELEASE_MISMATCH",
          message: "The Store locator does not match its live release.",
        });
      }
    }
    reason = "store-release-locator";
  } else if (isExpiredSourceLessStoreDiff(row, now)) {
    reason = "expired-source-less-store-diff";
  } else {
    throw new ConvexError({
      code: "C8_CLEANUP_UNSAFE_STORE_LOCATOR",
      message: "The locator is not an approved retired Store locator.",
    });
  }

  return {
    policy: "retain-shared-stella-files-object",
    reason,
    locatorId: row._id,
    ownerId: row.ownerId,
    ownerGeneration: row.ownerGeneration,
    uploadId: row.uploadId,
    objectRole: row.objectRole,
    storageKind: "component-r2",
    r2Key: row.r2Key,
    payloadSha256: row.payloadSha256,
    state: row.state,
    uploadExpiresAt: row.uploadExpiresAt,
    ...(row.sourceKind === "store_release"
      ? { sourceKind: row.sourceKind }
      : {}),
    ...(row.sourceId ? { sourceId: row.sourceId } : {}),
    ...(row.sourceKey ? { sourceKey: row.sourceKey } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export const getStoreLocatorManifestPageInternal = internalQuery({
  args: {
    deployment: v.literal(C8_DEV_DEPLOYMENT),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  returns: v.object({
    manifests: v.array(
      v.object({
        manifest: storeLocatorManifestValidator,
        manifestSha256: v.string(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    assertC8CleanupDeployment(process.env);
    const page = await ctx.db.query("account_external_media_objects").paginate({
      cursor: args.cursor,
      numItems: validateLimit(args.numItems),
    });
    const now = Date.now();
    const manifests = [];
    for (const row of page.page) {
      if (!isRetiredStoreExternalLocator(row, now)) continue;
      const manifest = await storeLocatorManifestForRow(ctx, row, now);
      manifests.push({ manifest, manifestSha256: await sha256Json(manifest) });
    }
    return {
      manifests,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const deleteManifestedStoreLocatorInternal = internalMutation({
  args: {
    deployment: v.literal(C8_DEV_DEPLOYMENT),
    confirmation: v.literal(C8_DESTRUCTIVE_CONFIRMATION),
    locatorId: v.id("account_external_media_objects"),
    manifestSha256: v.string(),
    manifestPersisted: v.literal(true),
  },
  returns: v.object({
    locatorId: v.id("account_external_media_objects"),
    manifestSha256: v.string(),
    retainedSharedR2Objects: v.literal(1),
  }),
  handler: async (ctx, args) => {
    assertDestructiveAuthority({
      dryRun: false,
      confirmation: args.confirmation,
    });
    await assertCleanupBarrierClosed(ctx);
    await assertTablesEmpty(
      ctx,
      tablesBefore("retired_external_media_locators"),
      "retired_external_media_locators",
    );
    const row = await ctx.db.get(args.locatorId);
    if (!row) {
      throw new ConvexError({
        code: "C8_CLEANUP_STALE_MANIFEST",
        message: "The manifested Store locator no longer exists.",
      });
    }
    const manifest = await storeLocatorManifestForRow(ctx, row, Date.now());
    const actualSha256 = await sha256Json(manifest);
    if (actualSha256 !== args.manifestSha256) {
      throw new ConvexError({
        code: "C8_CLEANUP_STALE_MANIFEST",
        message:
          "The Store locator changed after its debt manifest was persisted.",
      });
    }
    await ctx.db.delete(row._id);
    return {
      locatorId: row._id,
      manifestSha256: actualSha256,
      retainedSharedR2Objects: 1 as const,
    };
  },
});

const rawPetPrefix = (): string =>
  (process.env.R2_PETS_PREFIX?.trim() || "user-pets").replace(
    /^\/+|\/+$/gu,
    "",
  );

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const parseUserPetRawObject = async (args: {
  ownerId: string;
  expectedPetId?: string;
  role: "spritesheet" | "preview";
  publicUrl: string;
  locator?: Doc<"account_external_media_objects">;
  now: number;
}) => {
  const { bucket, publicBase } = requireConfiguredRawR2MediaTarget({
    bucketEnv: "R2_PETS_BUCKET",
    purpose: "c8 user-pet cleanup",
  });
  const prefix = rawPetPrefix();
  const prefixParts = prefix.split("/");
  const ownerKey = (await sha256Hex(args.ownerId)).slice(0, 24);
  const publicPrefix = `${publicBase}/`;
  if (!args.publicUrl.startsWith(publicPrefix)) {
    throw new ConvexError({
      code: "C8_CLEANUP_UNSAFE_USER_PET_OBJECT",
      message:
        "The user-pet URL is outside the exact development public origin.",
    });
  }
  const r2Key = args.publicUrl.slice(publicPrefix.length);
  const parts = r2Key.split("/");
  const ownerIndex = prefixParts.length;
  const petIndex = ownerIndex + 1;
  const uploadIndex = ownerIndex + 2;
  const filenameIndex = ownerIndex + 3;
  const expectedFilename =
    args.role === "spritesheet" ? "spritesheet.webp" : "preview.webp";
  if (
    prefixParts.some((part, index) => !part || parts[index] !== part) ||
    parts.length !== prefixParts.length + 4 ||
    parts[ownerIndex] !== ownerKey ||
    !STORE_PACKAGE_ID_PATTERN.test(parts[petIndex] ?? "") ||
    (args.expectedPetId !== undefined &&
      parts[petIndex] !== args.expectedPetId) ||
    !STORE_UPLOAD_ID_PATTERN.test(parts[uploadIndex] ?? "") ||
    parts[filenameIndex] !== expectedFilename ||
    args.publicUrl !== `${publicBase}/${r2Key}`
  ) {
    throw new ConvexError({
      code: "C8_CLEANUP_UNSAFE_USER_PET_OBJECT",
      message:
        "The user-pet object is outside the exact owner/pet/upload grammar.",
    });
  }
  if (args.locator) {
    const locator = args.locator;
    if (
      locator.ownerId !== args.ownerId ||
      locator.objectRole !== args.role ||
      locator.storageKind !== "raw-r2" ||
      locator.bucket !== bucket ||
      locator.r2Key !== r2Key ||
      locator.publicUrl !== args.publicUrl ||
      locator.uploadExpiresAt > args.now ||
      locator.state === "external_deleted"
    ) {
      throw new ConvexError({
        code: "C8_CLEANUP_UNSAFE_USER_PET_OBJECT",
        message: "The user-pet locator does not match its exact raw-R2 object.",
      });
    }
  }
  return { bucket, r2Key, publicUrl: args.publicUrl };
};

const userPetManifestForRow = async (
  ctx: QueryCtx | MutationCtx,
  row: Doc<"user_pets">,
  now: number,
): Promise<UserPetManifest> => {
  const sourceKey = `user_pet:${row._id}`;
  const locators = await ctx.db
    .query("account_external_media_objects")
    .withIndex("by_ownerId_and_sourceKey", (q) =>
      q.eq("ownerId", row.ownerId).eq("sourceKey", sourceKey),
    )
    .take(MAX_EXTERNAL_LOCATORS_PER_SOURCE + 1);
  if (locators.length > MAX_EXTERNAL_LOCATORS_PER_SOURCE) {
    throw new ConvexError({
      code: "C8_CLEANUP_EXTERNAL_LOCATOR_OVERFLOW",
      message: "The user pet has too many external-media locators.",
    });
  }
  const refs = [
    { role: "spritesheet" as const, publicUrl: row.spritesheetUrl },
    ...(row.previewUrl
      ? [{ role: "preview" as const, publicUrl: row.previewUrl }]
      : []),
  ];
  if (locators.length !== 0 && locators.length !== refs.length) {
    throw new ConvexError({
      code: "C8_CLEANUP_USER_PET_LOCATOR_MISMATCH",
      message: "The user-pet locator inventory is incomplete.",
    });
  }
  if (
    new Set(locators.map((locator) => locator.objectRole)).size !==
    locators.length
  ) {
    throw new ConvexError({
      code: "C8_CLEANUP_USER_PET_LOCATOR_MISMATCH",
      message: "The user-pet locator inventory has duplicate object roles.",
    });
  }
  const objects: UserPetManifest["objects"] = [];
  for (const ref of refs) {
    const locator = locators.find(
      (candidate) => candidate.objectRole === ref.role,
    );
    if (locators.length > 0 && !locator) {
      throw new ConvexError({
        code: "C8_CLEANUP_USER_PET_LOCATOR_MISMATCH",
        message: "The user-pet locator inventory is missing an expected role.",
      });
    }
    if (
      locator &&
      (locator.sourceKind !== "user_pet" ||
        locator.sourceId !== String(row._id) ||
        locator.sourceKey !== sourceKey)
    ) {
      throw new ConvexError({
        code: "C8_CLEANUP_USER_PET_LOCATOR_MISMATCH",
        message: "The user-pet locator source binding is invalid.",
      });
    }
    const parsed = await parseUserPetRawObject({
      ownerId: row.ownerId,
      expectedPetId: row.petId,
      role: ref.role,
      publicUrl: ref.publicUrl,
      ...(locator ? { locator } : {}),
      now,
    });
    objects.push({
      role: ref.role,
      ...parsed,
      ...(locator ? { locatorId: locator._id } : {}),
    });
  }
  return {
    policy: "delete-exact-development-raw-r2-before-row",
    petRowId: row._id,
    ownerId: row.ownerId,
    petId: row.petId,
    updatedAt: row.updatedAt,
    objects,
  };
};

export const getUserPetManifestInternal = internalQuery({
  args: {
    deployment: v.literal(C8_DEV_DEPLOYMENT),
    petRowId: v.optional(v.id("user_pets")),
  },
  returns: v.union(
    v.null(),
    v.object({
      manifest: userPetManifestValidator,
      manifestSha256: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    assertC8CleanupDeployment(process.env);
    const row = args.petRowId
      ? await ctx.db.get(args.petRowId)
      : await ctx.db.query("user_pets").first();
    if (!row) return null;
    const manifest = await userPetManifestForRow(ctx, row, Date.now());
    return { manifest, manifestSha256: await sha256Json(manifest) };
  },
});

export const acknowledgeUserPetObjectsDeletedInternal = internalMutation({
  args: {
    deployment: v.literal(C8_DEV_DEPLOYMENT),
    confirmation: v.literal(C8_DESTRUCTIVE_CONFIRMATION),
    petRowId: v.id("user_pets"),
    manifestSha256: v.string(),
    manifestPersisted: v.literal(true),
  },
  returns: v.object({
    petRowId: v.id("user_pets"),
    manifestSha256: v.string(),
    deletedLocators: v.number(),
  }),
  handler: async (ctx, args) => {
    assertDestructiveAuthority({
      dryRun: false,
      confirmation: args.confirmation,
    });
    await assertCleanupBarrierClosed(ctx);
    await assertTablesEmpty(ctx, tablesBefore("user_pets"), "user_pets");
    const row = await ctx.db.get(args.petRowId);
    if (!row) {
      throw new ConvexError({
        code: "C8_CLEANUP_STALE_MANIFEST",
        message: "The manifested user-pet row no longer exists.",
      });
    }
    const manifest = await userPetManifestForRow(ctx, row, Date.now());
    const actualSha256 = await sha256Json(manifest);
    if (actualSha256 !== args.manifestSha256) {
      throw new ConvexError({
        code: "C8_CLEANUP_STALE_MANIFEST",
        message:
          "The user-pet row or locator inventory changed after deletion.",
      });
    }
    for (const object of manifest.objects) {
      if (object.locatorId) await ctx.db.delete(object.locatorId);
    }
    await ctx.db.delete(row._id);
    return {
      petRowId: row._id,
      manifestSha256: actualSha256,
      deletedLocators: manifest.objects.filter((object) => object.locatorId)
        .length,
    };
  },
});

const userPetOrphanManifestForRow = async (
  ctx: QueryCtx | MutationCtx,
  row: Doc<"account_external_media_objects">,
  now: number,
): Promise<UserPetOrphanManifest> => {
  if (
    row.sourceKind !== "user_pet" ||
    !row.sourceId ||
    row.sourceKey !== `user_pet:${row.sourceId}` ||
    (row.objectRole !== "spritesheet" && row.objectRole !== "preview") ||
    !row.publicUrl ||
    row.uploadExpiresAt > now
  ) {
    throw new ConvexError({
      code: "C8_CLEANUP_UNSAFE_USER_PET_ORPHAN",
      message: "The user-pet orphan locator is not safe to delete.",
    });
  }
  const normalized = ctx.db.normalizeId("user_pets", row.sourceId);
  if (normalized && (await ctx.db.get(normalized))) {
    throw new ConvexError({
      code: "C8_CLEANUP_OUT_OF_ORDER",
      message:
        "The user-pet source row must be deleted through its row manifest first.",
    });
  }
  const parsed = await parseUserPetRawObject({
    ownerId: row.ownerId,
    role: row.objectRole,
    publicUrl: row.publicUrl,
    locator: row,
    now,
  });
  return {
    policy: "delete-exact-development-raw-r2-before-locator",
    locatorId: row._id,
    ownerId: row.ownerId,
    sourceId: row.sourceId,
    role: row.objectRole,
    ...parsed,
    uploadExpiresAt: row.uploadExpiresAt,
    updatedAt: row.updatedAt,
  };
};

export const getUserPetOrphanManifestPageInternal = internalQuery({
  args: {
    deployment: v.literal(C8_DEV_DEPLOYMENT),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  returns: v.object({
    manifests: v.array(
      v.object({
        manifest: userPetOrphanManifestValidator,
        manifestSha256: v.string(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    assertC8CleanupDeployment(process.env);
    const page = await ctx.db.query("account_external_media_objects").paginate({
      cursor: args.cursor,
      numItems: validateLimit(args.numItems),
    });
    const manifests = [];
    const now = Date.now();
    for (const row of page.page) {
      if (!isRetiredUserPetLocator(row)) continue;
      const sourceId = row.sourceId
        ? ctx.db.normalizeId("user_pets", row.sourceId)
        : null;
      if (sourceId && (await ctx.db.get(sourceId))) continue;
      const manifest = await userPetOrphanManifestForRow(ctx, row, now);
      manifests.push({ manifest, manifestSha256: await sha256Json(manifest) });
    }
    return {
      manifests,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const acknowledgeUserPetOrphanDeletedInternal = internalMutation({
  args: {
    deployment: v.literal(C8_DEV_DEPLOYMENT),
    confirmation: v.literal(C8_DESTRUCTIVE_CONFIRMATION),
    locatorId: v.id("account_external_media_objects"),
    manifestSha256: v.string(),
    manifestPersisted: v.literal(true),
  },
  returns: v.object({
    locatorId: v.id("account_external_media_objects"),
    manifestSha256: v.string(),
  }),
  handler: async (ctx, args) => {
    assertDestructiveAuthority({
      dryRun: false,
      confirmation: args.confirmation,
    });
    await assertCleanupBarrierClosed(ctx);
    await assertTablesEmpty(
      ctx,
      tablesBefore("user_pet_external_media_locators"),
      "user_pet_external_media_locators",
    );
    const row = await ctx.db.get(args.locatorId);
    if (!row)
      throw new ConvexError({
        code: "C8_CLEANUP_STALE_MANIFEST",
        message: "The user-pet orphan locator no longer exists.",
      });
    const manifest = await userPetOrphanManifestForRow(ctx, row, Date.now());
    const actualSha256 = await sha256Json(manifest);
    if (actualSha256 !== args.manifestSha256) {
      throw new ConvexError({
        code: "C8_CLEANUP_STALE_MANIFEST",
        message: "The user-pet orphan locator changed after deletion.",
      });
    }
    await ctx.db.delete(row._id);
    return { locatorId: row._id, manifestSha256: actualSha256 };
  },
});

export const getNextStoreReleaseManifestInternal = internalQuery({
  args: { deployment: v.literal(C8_DEV_DEPLOYMENT) },
  returns: v.union(
    v.null(),
    v.object({ manifest: storeManifestValidator, manifestSha256: v.string() }),
  ),
  handler: async (ctx) => {
    assertC8CleanupDeployment(process.env);
    await assertTablesEmpty(
      ctx,
      tablesBefore("store_package_releases"),
      "store_package_releases",
    );
    const release = await ctx.db.query("store_package_releases").first();
    if (!release) return null;
    const manifest = storeManifestForRelease(release);
    return { manifest, manifestSha256: await sha256Json(manifest) };
  },
});

export const getStoreReleaseManifestPageInternal = internalQuery({
  args: {
    deployment: v.literal(C8_DEV_DEPLOYMENT),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  returns: v.object({
    manifests: v.array(
      v.object({
        manifest: storeManifestValidator,
        manifestSha256: v.string(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    assertC8CleanupDeployment(process.env);
    const page = await ctx.db.query("store_package_releases").paginate({
      cursor: args.cursor,
      numItems: validateLimit(args.numItems),
    });
    const manifests = [];
    for (const release of page.page) {
      const manifest = storeManifestForRelease(release);
      manifests.push({ manifest, manifestSha256: await sha256Json(manifest) });
    }
    return {
      manifests,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * Deletes a Store release only after the operator attests that its exact,
 * hash-bound shared-bucket debt manifest was fsynced outside Convex. No R2
 * object is listed or deleted here.
 */
export const deleteManifestedStoreReleaseInternal = internalMutation({
  args: {
    deployment: v.literal(C8_DEV_DEPLOYMENT),
    confirmation: v.literal(C8_DESTRUCTIVE_CONFIRMATION),
    releaseId: v.id("store_package_releases"),
    manifestSha256: v.string(),
    manifestPersisted: v.literal(true),
  },
  returns: v.object({
    releaseId: v.id("store_package_releases"),
    manifestSha256: v.string(),
    deletedLocators: v.number(),
    retainedSharedR2Objects: v.number(),
  }),
  handler: async (ctx, args) => {
    assertDestructiveAuthority({
      dryRun: false,
      confirmation: args.confirmation,
    });
    await assertCleanupBarrierClosed(ctx);
    await assertTablesEmpty(
      ctx,
      tablesBefore("store_package_releases"),
      "store_package_releases",
    );
    const release = await ctx.db.get(args.releaseId);
    if (!release) {
      throw new ConvexError({
        code: "C8_CLEANUP_STALE_MANIFEST",
        message: "The manifested Store release no longer exists.",
      });
    }
    const manifest = storeManifestForRelease(release);
    const actualSha256 = await sha256Json(manifest);
    if (actualSha256 !== args.manifestSha256) {
      throw new ConvexError({
        code: "C8_CLEANUP_STALE_MANIFEST",
        message: "The Store release changed after its debt manifest was read.",
      });
    }
    const sourceKey = `store_release:${release._id}`;
    const sourceLocators = await ctx.db
      .query("account_external_media_objects")
      .withIndex("by_ownerId_and_sourceKey", (q) =>
        q.eq("ownerId", release.ownerId).eq("sourceKey", sourceKey),
      )
      .take(1);
    if (sourceLocators.length > 0) {
      throw new ConvexError({
        code: "C8_CLEANUP_OUT_OF_ORDER",
        message:
          "The Store release still has a source-bound external-media locator.",
      });
    }
    for (const ref of manifest.r2Refs) {
      const keyRows = await ctx.db
        .query("account_external_media_objects")
        .withIndex("by_ownerId_and_r2Key", (q) =>
          q.eq("ownerId", release.ownerId).eq("r2Key", ref.key),
        )
        .take(1);
      if (keyRows.length > 0) {
        throw new ConvexError({
          code: "C8_CLEANUP_OUT_OF_ORDER",
          message:
            "The Store release still has an external-media locator for a retained key.",
        });
      }
    }
    await ctx.db.delete(release._id);
    return {
      releaseId: release._id,
      manifestSha256: actualSha256,
      deletedLocators: 0,
      retainedSharedR2Objects:
        manifest.r2Refs.length + manifest.gitObjects.length,
    };
  },
});
