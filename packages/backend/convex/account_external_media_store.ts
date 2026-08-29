import { ConvexError, Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { assertOwnerMigrationWriteAllowed } from "./auth";
import {
  assertOwnerDataWriteAllowed,
  assertOwnerPurgeLease,
} from "./owner_lifecycle";
import {
  accountExternalMediaSourceKindValidator,
  accountExternalMediaStorageKindValidator,
} from "./schema/account_external_media";
import { requireConfiguredRawR2MediaTarget } from "./lib/raw_r2_media_target";

const MAX_OBJECTS_PER_UPLOAD = 8;
const MAX_OBJECTS_PER_SOURCE = 8;
const MAX_DELETE_BATCH = 24;
const MATERIALIZE_PER_KIND = 8;
const DEFAULT_EMOJI_PREFIX = "emoji-packs";

export const EXTERNAL_MEDIA_PRESIGNED_BARRIER_MS = 20 * 60_000;
export const EXTERNAL_MEDIA_SERVER_WRITE_BARRIER_MS = 2 * 60_000;

const externalObjectInputValidator = v.object({
  objectRole: v.string(),
  storageKind: accountExternalMediaStorageKindValidator,
  bucket: v.optional(v.string()),
  r2Key: v.string(),
  payloadSha256: v.string(),
  publicUrl: v.optional(v.string()),
});

const externalObjectRefValidator = v.object({
  id: v.id("account_external_media_objects"),
  storageKind: accountExternalMediaStorageKindValidator,
  bucket: v.optional(v.string()),
  r2Key: v.string(),
});

export type ExternalMediaObjectInput = Infer<
  typeof externalObjectInputValidator
>;
export type ExternalMediaSourceKind = Infer<
  typeof accountExternalMediaSourceKindValidator
>;
const sourceKey = (kind: ExternalMediaSourceKind, id: string): string =>
  `${kind}:${id}`;

const normalizePrefix = (value: string | undefined, fallback: string): string =>
  (value?.trim() || fallback).replace(/^\/+|\/+$/g, "");

const requireLegacyRawR2Target = (): {
  emojiPublicBase: URL;
  emojiBucket: string;
} => {
  const target = requireConfiguredRawR2MediaTarget(
    "Legacy external-media cleanup",
  );
  return {
    emojiPublicBase: new URL(target.publicBase),
    emojiBucket: target.bucket,
  };
};

const sha256Prefix = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
};

type OwnedRawR2PublicUrl =
  | { kind: "owned"; key: string }
  | { kind: "unmanaged" }
  | { kind: "malformed" };

const encodeCanonicalPathSegment = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const isSafeDecodedPathSegment = (value: string): boolean =>
  value.length > 0 &&
  value !== "." &&
  value !== ".." &&
  !value.includes("/") &&
  !value.includes("\\") &&
  !value.includes("%");

const parseCanonicalPathname = (pathname: string): string[] | null => {
  if (pathname === "/") return [];
  if (!pathname.startsWith("/") || pathname.endsWith("/")) return null;
  const decoded: string[] = [];
  for (const rawSegment of pathname.slice(1).split("/")) {
    if (!rawSegment) return null;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (
      !isSafeDecodedPathSegment(segment) ||
      encodeCanonicalPathSegment(segment) !== rawSegment
    ) {
      return null;
    }
    decoded.push(segment);
  }
  return decoded;
};

const parseTrustedPathSegments = (value: string): string[] | null => {
  if (!value) return null;
  const segments = value.split("/");
  return segments.every(isSafeDecodedPathSegment) ? segments : null;
};

const hasExactSegmentPrefix = (
  value: readonly string[],
  prefix: readonly string[],
): boolean =>
  value.length > prefix.length &&
  prefix.every((segment, index) => value[index] === segment);

const classifyOwnedRawR2PublicUrl = (args: {
  value: string;
  publicBase: URL;
  acceptedPrefixes: readonly string[];
  ownerKey: string;
}): OwnedRawR2PublicUrl => {
  let candidate: URL;
  try {
    candidate = new URL(args.value);
  } catch {
    return { kind: "malformed" };
  }
  if (
    candidate.protocol !== "https:" ||
    candidate.origin !== args.publicBase.origin
  ) {
    return { kind: "unmanaged" };
  }

  // URL parsing normalizes literal dot segments and backslashes. Require the
  // supplied spelling to survive parsing, then decode one segment at a time so
  // encoded separators and double-encoded traversal cannot become an R2 key.
  if (
    candidate.username ||
    candidate.password ||
    candidate.search ||
    candidate.hash ||
    args.value.includes("\\") ||
    candidate.href !== args.value
  ) {
    return { kind: "malformed" };
  }

  const baseSegments = parseCanonicalPathname(args.publicBase.pathname);
  const candidateSegments = parseCanonicalPathname(candidate.pathname);
  const ownerSegments = parseTrustedPathSegments(args.ownerKey);
  if (
    !baseSegments ||
    !candidateSegments ||
    !ownerSegments ||
    ownerSegments.length !== 1 ||
    !hasExactSegmentPrefix(candidateSegments, baseSegments)
  ) {
    return { kind: "malformed" };
  }

  const keySegments = candidateSegments.slice(baseSegments.length);
  for (const acceptedPrefix of args.acceptedPrefixes) {
    const prefixSegments = parseTrustedPathSegments(acceptedPrefix);
    if (!prefixSegments) continue;
    if (
      hasExactSegmentPrefix(keySegments, [...prefixSegments, ownerSegments[0]!])
    ) {
      return { kind: "owned", key: keySegments.join("/") };
    }
  }
  return { kind: "malformed" };
};

/** Returns only raw-R2 URLs that are provably under this owner's prefix. */
export const rawR2KeyFromOwnedPublicUrl = (args: {
  value: string;
  publicBase: URL;
  acceptedPrefixes: readonly string[];
  ownerKey: string;
}): string | null => {
  const result = classifyOwnedRawR2PublicUrl(args);
  return result.kind === "owned" ? result.key : null;
};

const assertObjectSet = (objects: ExternalMediaObjectInput[]): void => {
  if (objects.length === 0 || objects.length > MAX_OBJECTS_PER_UPLOAD) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "External media uploads must reserve a bounded non-empty object set.",
    });
  }
  const roles = new Set<string>();
  const keys = new Set<string>();
  for (const object of objects) {
    if (!object.objectRole.trim() || !object.r2Key.trim()) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "External media object role and R2 key are required.",
      });
    }
    if (object.storageKind === "raw-r2" && !object.bucket?.trim()) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Raw R2 media reservations require an exact bucket.",
      });
    }
    if (roles.has(object.objectRole) || keys.has(object.r2Key)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "External media reservation roles and keys must be unique.",
      });
    }
    roles.add(object.objectRole);
    keys.add(object.r2Key);
  }
};

const sameObject = (
  row: Doc<"account_external_media_objects">,
  object: ExternalMediaObjectInput,
): boolean =>
  row.objectRole === object.objectRole &&
  row.storageKind === object.storageKind &&
  row.bucket === object.bucket &&
  row.r2Key === object.r2Key &&
  row.payloadSha256 === object.payloadSha256 &&
  row.publicUrl === object.publicUrl;

export const reserveExternalMediaUploadInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    uploadId: v.string(),
    uploadExpiresAt: v.number(),
    objects: v.array(externalObjectInputValidator),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    assertObjectSet(args.objects);
    if (args.uploadExpiresAt <= args.now) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "External media upload barrier must be in the future.",
      });
    }
    const replay = await ctx.db
      .query("account_external_media_objects")
      .withIndex("by_ownerId_and_uploadId", (q) =>
        q.eq("ownerId", args.ownerId).eq("uploadId", args.uploadId),
      )
      .take(MAX_OBJECTS_PER_UPLOAD + 1);
    if (replay.length > 0) {
      if (
        replay.length !== args.objects.length ||
        replay.some(
          (row) =>
            row.ownerGeneration !== args.ownerGeneration ||
            row.uploadExpiresAt !== args.uploadExpiresAt ||
            row.state !== "reserved" ||
            !args.objects.some((object) => sameObject(row, object)),
        )
      ) {
        throw new ConvexError({
          code: "IDEMPOTENCY_CONFLICT",
          message:
            "External media upload replay did not match its reservation.",
        });
      }
      return null;
    }
    for (const object of args.objects) {
      await ctx.db.insert("account_external_media_objects", {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        uploadId: args.uploadId,
        objectRole: object.objectRole,
        storageKind: object.storageKind,
        ...(object.bucket ? { bucket: object.bucket } : {}),
        r2Key: object.r2Key,
        payloadSha256: object.payloadSha256,
        ...(object.publicUrl ? { publicUrl: object.publicUrl } : {}),
        state: "reserved",
        uploadExpiresAt: args.uploadExpiresAt,
        createdAt: args.now,
        updatedAt: args.now,
      });
    }
    return null;
  },
});

/** Final mutation-plane guard immediately before a PUT URL or server PUT. */
export const assertExternalMediaUploadDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    uploadId: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const rows = await ctx.db
      .query("account_external_media_objects")
      .withIndex("by_ownerId_and_uploadId", (q) =>
        q.eq("ownerId", args.ownerId).eq("uploadId", args.uploadId),
      )
      .take(MAX_OBJECTS_PER_UPLOAD + 1);
    if (
      rows.length === 0 ||
      rows.length > MAX_OBJECTS_PER_UPLOAD ||
      rows.some(
        (row) =>
          row.ownerGeneration !== args.ownerGeneration ||
          row.state !== "reserved" ||
          row.uploadExpiresAt <= args.now,
      )
    ) {
      throw new ConvexError({
        code: "EXTERNAL_MEDIA_UPLOAD_STALE",
        message: "The external media upload reservation is no longer writable.",
      });
    }
    return null;
  },
});

/** Guard for globally shared content-addressed uploads, which have no owner debt. */
export const assertExternalMediaDomainDispatchInternal = internalMutation({
  args: { ownerId: v.string(), ownerGeneration: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    return null;
  },
});

export const commitExternalMediaUpload = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    uploadId: string;
    sourceKind: ExternalMediaSourceKind;
    sourceId: string;
    objects: ExternalMediaObjectInput[];
    now: number;
  },
): Promise<void> => {
  await assertOwnerMigrationWriteAllowed(
    ctx,
    args.ownerId,
    args.ownerGeneration,
  );
  assertObjectSet(args.objects);
  const rows = await ctx.db
    .query("account_external_media_objects")
    .withIndex("by_ownerId_and_uploadId", (q) =>
      q.eq("ownerId", args.ownerId).eq("uploadId", args.uploadId),
    )
    .take(MAX_OBJECTS_PER_UPLOAD + 1);
  if (
    rows.length !== args.objects.length ||
    rows.some(
      (row) =>
        row.ownerGeneration !== args.ownerGeneration ||
        row.state !== "reserved" ||
        row.uploadExpiresAt <= args.now ||
        !args.objects.some((object) => sameObject(row, object)),
    )
  ) {
    throw new ConvexError({
      code: "EXTERNAL_MEDIA_UPLOAD_STALE",
      message: "The external media upload cannot be finalized.",
    });
  }
  const key = sourceKey(args.sourceKind, args.sourceId);
  for (const row of rows) {
    await ctx.db.patch(row._id, {
      state: "committed",
      sourceKind: args.sourceKind,
      sourceId: args.sourceId,
      sourceKey: key,
      updatedAt: args.now,
    });
  }
};

export const commitExternalMediaUploadByUrls = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    uploadId: string;
    sourceKind: "emoji_pack";
    sourceId: string;
    objects: Array<{ objectRole: string; publicUrl: string }>;
    now: number;
  },
): Promise<void> => {
  await assertOwnerMigrationWriteAllowed(
    ctx,
    args.ownerId,
    args.ownerGeneration,
  );
  if (
    args.objects.length === 0 ||
    args.objects.length > MAX_OBJECTS_PER_UPLOAD ||
    new Set(args.objects.map((object) => object.objectRole)).size !==
      args.objects.length
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "External media finalization has an invalid object set.",
    });
  }
  const rows = await ctx.db
    .query("account_external_media_objects")
    .withIndex("by_ownerId_and_uploadId", (q) =>
      q.eq("ownerId", args.ownerId).eq("uploadId", args.uploadId),
    )
    .take(MAX_OBJECTS_PER_UPLOAD + 1);
  if (
    rows.length !== args.objects.length ||
    rows.some(
      (row) =>
        row.ownerGeneration !== args.ownerGeneration ||
        row.state !== "reserved" ||
        row.uploadExpiresAt <= args.now ||
        !args.objects.some(
          (object) =>
            object.objectRole === row.objectRole &&
            object.publicUrl === row.publicUrl,
        ),
    )
  ) {
    throw new ConvexError({
      code: "EXTERNAL_MEDIA_UPLOAD_STALE",
      message: "The external media upload cannot be finalized.",
    });
  }
  const key = sourceKey(args.sourceKind, args.sourceId);
  for (const row of rows) {
    await ctx.db.patch(row._id, {
      state: "committed",
      sourceKind: args.sourceKind,
      sourceId: args.sourceId,
      sourceKey: key,
      updatedAt: args.now,
    });
  }
};

export const finalizeExternalMediaUploadInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    uploadId: v.string(),
    sourceKind: accountExternalMediaSourceKindValidator,
    sourceId: v.string(),
    objects: v.array(externalObjectInputValidator),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await commitExternalMediaUpload(ctx, args);
    return null;
  },
});

const insertLegacyLocator = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    sourceKind: ExternalMediaSourceKind;
    sourceId: string;
    role: string;
    storageKind: "raw-r2" | "component-r2";
    bucket?: string;
    r2Key: string;
    publicUrl?: string;
    payloadSha256: string;
    now: number;
  },
): Promise<void> => {
  const key = sourceKey(args.sourceKind, args.sourceId);
  const existing = await ctx.db
    .query("account_external_media_objects")
    .withIndex("by_ownerId_and_sourceKey", (q) =>
      q.eq("ownerId", args.ownerId).eq("sourceKey", key),
    )
    .take(MAX_OBJECTS_PER_SOURCE);
  if (existing.some((row) => row.objectRole === args.role)) return;
  await ctx.db.insert("account_external_media_objects", {
    ownerId: args.ownerId,
    ownerGeneration: "legacy",
    uploadId: `legacy:${key}`,
    objectRole: args.role,
    storageKind: args.storageKind,
    ...(args.bucket ? { bucket: args.bucket } : {}),
    r2Key: args.r2Key,
    payloadSha256: args.payloadSha256,
    ...(args.publicUrl ? { publicUrl: args.publicUrl } : {}),
    state: "committed",
    uploadExpiresAt: 0,
    sourceKind: args.sourceKind,
    sourceId: args.sourceId,
    sourceKey: key,
    createdAt: args.now,
    updatedAt: args.now,
  });
};

const deleteEmojiPackRow = async (
  ctx: MutationCtx,
  row: Doc<"emoji_packs">,
): Promise<void> => {
  const memberships = await ctx.db
    .query("emoji_pack_tag_membership")
    .withIndex("by_packRef", (q) => q.eq("packRef", row._id))
    .take(8);
  for (const membership of memberships) {
    if (row.visibility === "public") {
      const facet = await ctx.db
        .query("emoji_pack_tag_facets")
        .withIndex("by_tag", (q) => q.eq("tag", membership.tag))
        .unique();
      if (facet) {
        if (facet.count <= 1) await ctx.db.delete(facet._id);
        else await ctx.db.patch(facet._id, { count: facet.count - 1 });
      }
    }
    await ctx.db.delete(membership._id);
  }
  await ctx.db.delete(row._id);
};

const deleteSourceRow = async (
  ctx: MutationCtx,
  ownerId: string,
  kind: ExternalMediaSourceKind,
  id: string,
): Promise<void> => {
  if (kind !== "emoji_pack") return;
  const normalized = ctx.db.normalizeId("emoji_packs", id);
  const row = normalized ? await ctx.db.get(normalized) : null;
  if (row?.ownerId === ownerId) await deleteEmojiPackRow(ctx, row);
};

const materializeRawRefs = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerKey: string;
    sourceKind: "emoji_pack";
    sourceId: string;
    refs: Array<{ role: string; url: string }>;
    prefix: string;
    fallbackPrefix: string;
    bucket: string;
    publicBase: URL;
    now: number;
  },
): Promise<number> => {
  let count = 0;
  for (const ref of args.refs) {
    const parsed = classifyOwnedRawR2PublicUrl({
      value: ref.url,
      publicBase: args.publicBase,
      acceptedPrefixes: Array.from(new Set([args.prefix, args.fallbackPrefix])),
      ownerKey: args.ownerKey,
    });
    if (parsed.kind === "unmanaged") continue;
    if (parsed.kind === "malformed") {
      throw new ConvexError({
        code: "EXTERNAL_MEDIA_LEGACY_REF_MALFORMED",
        message: `Legacy ${args.sourceKind} ${ref.role} URL is not a canonical owned R2 object. The source row was retained as deletion debt.`,
      });
    }
    await insertLegacyLocator(ctx, {
      ownerId: args.ownerId,
      sourceKind: args.sourceKind,
      sourceId: args.sourceId,
      role: ref.role,
      storageKind: "raw-r2",
      bucket: args.bucket,
      r2Key: parsed.key,
      publicUrl: ref.url,
      payloadSha256: "legacy-unknown",
      now: args.now,
    });
    count += 1;
  }
  return count;
};

/**
 * Bounded compatibility pass for rows created before durable reservations.
 * It never drops a recognizable external locator before the object is deleted.
 */
export const materializeLegacyExternalMediaInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
  },
  returns: v.object({ materialized: v.number(), deletedEmpty: v.number() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, {
      ...args,
      stage: "core",
      mode: "delete",
    });
    // Never infer an authority target from a production-looking default. A
    // dev/preview deployment with missing configuration must stop before it
    // reads legacy URLs, materializes deletion locators, or deletes rows.
    const { emojiPublicBase, emojiBucket } = requireLegacyRawR2Target();
    const now = Date.now();
    const ownerKey = await sha256Prefix(args.ownerId);
    const emojiPrefix = normalizePrefix(
      process.env.R2_EMOJI_PREFIX,
      DEFAULT_EMOJI_PREFIX,
    );
    let materialized = 0;
    let deletedEmpty = 0;

    const packs = await ctx.db
      .query("emoji_packs")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(MATERIALIZE_PER_KIND);
    for (const pack of packs) {
      const key = sourceKey("emoji_pack", pack._id);
      const existing = await ctx.db
        .query("account_external_media_objects")
        .withIndex("by_ownerId_and_sourceKey", (q) =>
          q.eq("ownerId", args.ownerId).eq("sourceKey", key),
        )
        .first();
      if (existing) continue;
      const refs = [
        ...pack.sheetUrls.map((url, index) => ({
          role: `sheet-${index + 1}`,
          url,
        })),
        ...(pack.coverUrl ? [{ role: "cover", url: pack.coverUrl }] : []),
      ];
      const inserted = await materializeRawRefs(ctx, {
        ownerId: args.ownerId,
        ownerKey,
        sourceKind: "emoji_pack",
        sourceId: pack._id,
        refs,
        prefix: emojiPrefix,
        fallbackPrefix: DEFAULT_EMOJI_PREFIX,
        bucket: emojiBucket,
        publicBase: emojiPublicBase,
        now,
      });
      materialized += inserted;
      if (inserted === 0) {
        await deleteEmojiPackRow(ctx, pack);
        deletedEmpty += 1;
      }
    }

    return { materialized, deletedEmpty };
  },
});

export const getOwnerExternalMediaPurgeBatchInternal = internalQuery({
  args: { ownerId: v.string(), now: v.number() },
  returns: v.object({
    targets: v.array(externalObjectRefValidator),
    activeReservation: v.optional(
      v.object({ uploadId: v.string(), uploadExpiresAt: v.number() }),
    ),
  }),
  handler: async (ctx, args) => {
    const expired = await ctx.db
      .query("account_external_media_objects")
      .withIndex("by_ownerId_and_state_and_uploadExpiresAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("state", "reserved")
          .lte("uploadExpiresAt", args.now),
      )
      .take(MAX_DELETE_BATCH);
    const committed =
      expired.length >= MAX_DELETE_BATCH
        ? []
        : await ctx.db
            .query("account_external_media_objects")
            .withIndex("by_ownerId_and_state_and_uploadExpiresAt", (q) =>
              q
                .eq("ownerId", args.ownerId)
                .eq("state", "committed")
                .lte("uploadExpiresAt", args.now),
            )
            .take(MAX_DELETE_BATCH - expired.length);
    const [activeReserved, activeCommitted] = await Promise.all([
      ctx.db
        .query("account_external_media_objects")
        .withIndex("by_ownerId_and_state_and_uploadExpiresAt", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("state", "reserved")
            .gt("uploadExpiresAt", args.now),
        )
        .first(),
      ctx.db
        .query("account_external_media_objects")
        .withIndex("by_ownerId_and_state_and_uploadExpiresAt", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("state", "committed")
            .gt("uploadExpiresAt", args.now),
        )
        .first(),
    ]);
    const active = [activeReserved, activeCommitted]
      .filter((row) => row !== null)
      .sort(
        (left, right) =>
          left.uploadExpiresAt - right.uploadExpiresAt ||
          left._creationTime - right._creationTime,
      )[0];
    const targets = [...expired, ...committed];
    return {
      targets: targets.map((row) => ({
        id: row._id,
        storageKind: row.storageKind,
        ...(row.bucket ? { bucket: row.bucket } : {}),
        r2Key: row.r2Key,
      })),
      ...(active
        ? {
            activeReservation: {
              uploadId: active.uploadId,
              uploadExpiresAt: active.uploadExpiresAt,
            },
          }
        : {}),
    };
  },
});

export const getOwnerExternalMediaMigrationCleanupBatchInternal = internalQuery(
  {
    args: { ownerId: v.string(), now: v.number() },
    returns: v.object({
      targets: v.array(externalObjectRefValidator),
      activeReservation: v.optional(
        v.object({ uploadId: v.string(), uploadExpiresAt: v.number() }),
      ),
    }),
    handler: async (ctx, args) => {
      const targets = await ctx.db
        .query("account_external_media_objects")
        .withIndex("by_ownerId_and_state_and_uploadExpiresAt", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("state", "reserved")
            .lte("uploadExpiresAt", args.now),
        )
        .take(MAX_DELETE_BATCH);
      const [activeReserved, activeCommitted] = await Promise.all([
        ctx.db
          .query("account_external_media_objects")
          .withIndex("by_ownerId_and_state_and_uploadExpiresAt", (q) =>
            q
              .eq("ownerId", args.ownerId)
              .eq("state", "reserved")
              .gt("uploadExpiresAt", args.now),
          )
          .first(),
        ctx.db
          .query("account_external_media_objects")
          .withIndex("by_ownerId_and_state_and_uploadExpiresAt", (q) =>
            q
              .eq("ownerId", args.ownerId)
              .eq("state", "committed")
              .gt("uploadExpiresAt", args.now),
          )
          .first(),
      ]);
      const active = [activeReserved, activeCommitted]
        .filter((row) => row !== null)
        .sort(
          (left, right) =>
            left.uploadExpiresAt - right.uploadExpiresAt ||
            left._creationTime - right._creationTime,
        )[0];
      return {
        targets: targets.map((row) => ({
          id: row._id,
          storageKind: row.storageKind,
          ...(row.bucket ? { bucket: row.bucket } : {}),
          r2Key: row.r2Key,
        })),
        ...(active
          ? {
              activeReservation: {
                uploadId: active.uploadId,
                uploadExpiresAt: active.uploadExpiresAt,
              },
            }
          : {}),
      };
    },
  },
);

const assertExternalMediaMigrationLease = async (
  ctx: MutationCtx,
  args: {
    fromOwnerId: string;
    toOwnerId: string;
    migrationId: string;
    leaseId: string;
    leaseGeneration: number;
    fromOwnerGeneration: string;
    toOwnerGeneration: string;
    planRevision: number;
    now: number;
  },
): Promise<void> => {
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
    migration._id !== args.migrationId ||
    migration.toOwnerId !== args.toOwnerId ||
    migration.status !== "running" ||
    migration.leaseId !== args.leaseId ||
    migration.leaseGeneration !== args.leaseGeneration ||
    (migration.leaseExpiresAt ?? 0) <= args.now ||
    migration.fromOwnerGeneration !== args.fromOwnerGeneration ||
    migration.toOwnerGeneration !== args.toOwnerGeneration ||
    (migration.planRevision ?? 1) !== args.planRevision
  ) {
    throw new ConvexError({
      code: "STALE_OWNERSHIP_MIGRATION_LEASE",
      message: "External-media cleanup no longer owns the migration lease.",
    });
  }
  await Promise.all([
    assertOwnerDataWriteAllowed(
      ctx,
      args.fromOwnerId,
      args.fromOwnerGeneration,
    ),
    assertOwnerDataWriteAllowed(ctx, args.toOwnerId, args.toOwnerGeneration),
  ]);
};

export const acknowledgeExternalMediaMigrationCleanupInternal =
  internalMutation({
    args: {
      fromOwnerId: v.string(),
      toOwnerId: v.string(),
      migrationId: v.string(),
      leaseId: v.string(),
      leaseGeneration: v.number(),
      fromOwnerGeneration: v.string(),
      toOwnerGeneration: v.string(),
      planRevision: v.number(),
      now: v.number(),
      refs: v.array(externalObjectRefValidator),
    },
    returns: v.number(),
    handler: async (ctx, args) => {
      await assertExternalMediaMigrationLease(ctx, args);
      if (args.refs.length > MAX_DELETE_BATCH) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: "External-media migration acknowledgement is too large.",
        });
      }
      let acknowledged = 0;
      for (const ref of args.refs) {
        const row = await ctx.db.get(ref.id);
        if (
          !row ||
          row.ownerId !== args.fromOwnerId ||
          row.state !== "reserved" ||
          row.uploadExpiresAt > args.now ||
          row.storageKind !== ref.storageKind ||
          row.bucket !== ref.bucket ||
          row.r2Key !== ref.r2Key
        ) {
          continue;
        }
        await ctx.db.delete(row._id);
        acknowledged += 1;
      }
      return acknowledged;
    },
  });

export const hasOwnerExternalMediaReservationsInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) =>
    (await ctx.db
      .query("account_external_media_objects")
      .withIndex("by_ownerId_and_state_and_uploadExpiresAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "reserved"),
      )
      .first()) !== null,
});

export const acknowledgeOwnerExternalMediaDeletedInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    refs: v.array(externalObjectRefValidator),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, {
      ownerId: args.ownerId,
      operationId: args.operationId,
      generation: args.generation,
      stage: "core",
      leaseId: args.leaseId,
      mode: "delete",
    });
    if (args.refs.length > MAX_DELETE_BATCH) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "External media deletion acknowledgement is too large.",
      });
    }
    const touchedSources = new Map<
      string,
      { kind: ExternalMediaSourceKind; id: string }
    >();
    let acknowledged = 0;
    for (const ref of args.refs) {
      const row = await ctx.db.get(ref.id);
      const now = Date.now();
      if (
        !row ||
        row.ownerId !== args.ownerId ||
        row.uploadExpiresAt > now ||
        row.storageKind !== ref.storageKind ||
        row.bucket !== ref.bucket ||
        row.r2Key !== ref.r2Key
      ) {
        continue;
      }
      if (row.sourceKey && row.sourceKind && row.sourceId) {
        await ctx.db.patch(row._id, {
          state: "external_deleted",
          updatedAt: Date.now(),
        });
        touchedSources.set(row.sourceKey, {
          kind: row.sourceKind,
          id: row.sourceId,
        });
      } else {
        await ctx.db.delete(row._id);
      }
      acknowledged += 1;
    }
    for (const [key, source] of touchedSources) {
      const rows = await ctx.db
        .query("account_external_media_objects")
        .withIndex("by_ownerId_and_sourceKey", (q) =>
          q.eq("ownerId", args.ownerId).eq("sourceKey", key),
        )
        .take(MAX_OBJECTS_PER_SOURCE + 1);
      if (
        rows.length === 0 ||
        rows.length > MAX_OBJECTS_PER_SOURCE ||
        rows.some((row) => row.state !== "external_deleted")
      ) {
        continue;
      }
      await deleteSourceRow(ctx, args.ownerId, source.kind, source.id);
      for (const row of rows) await ctx.db.delete(row._id);
    }
    return acknowledged;
  },
});

export const remainingOwnerExternalMediaRowsInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const [pack, locator] = await Promise.all([
      ctx.db
        .query("emoji_packs")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("account_external_media_objects")
        .withIndex("by_ownerId_and_uploadId", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
    ]);
    return [
      ...(pack ? [`emoji_pack:${pack.packId}`] : []),
      ...(locator
        ? [
            `external_media_${locator.state}:${locator.uploadId}:${locator.objectRole}`,
          ]
        : []),
    ];
  },
});
