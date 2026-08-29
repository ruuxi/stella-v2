import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  assertOwnerMigrationWriteAllowed,
  requireUserId,
  requireUserIdentity,
} from "./auth";
import {
  CLOUD_HOME_MAX_DOCUMENTS,
  CLOUD_HOME_WRITE_INTENT_TTL_MS,
  assertCloudHomeSize,
  assertIdempotencyKey,
  assertOpaqueCloudHomeId,
  assertSha256,
  legacyCloudMemoryName,
  memoryDocumentId,
  memoryVersionId,
  memoryVersionR2Key,
  normalizeCloudMemoryDocument,
  type CloudMemoryDocumentKind,
  type CloudMemoryWriter,
} from "./lib/cloud_home_policy";
import {
  cloudHomeWriteIntentStatusValidator,
  cloudMemoryDocumentKindValidator,
  cloudMemoryWriterValidator,
} from "./schema/cloud_agent_home";
import {
  assertMemoryEpochOpen,
  getMemoryImportDisposition,
  LEGACY_MEMORY_EPOCH,
} from "./cloud_memory_lifecycle";

const writeIntentResultValidator = v.object({
  intentId: v.string(),
  status: cloudHomeWriteIntentStatusValidator,
  ownerGeneration: v.string(),
  memoryEpoch: v.string(),
  documentId: v.string(),
  name: v.string(),
  displayPath: v.string(),
  kind: cloudMemoryDocumentKindValidator,
  baseRevision: v.number(),
  baseVersionId: v.optional(v.string()),
  versionId: v.string(),
  nextRevision: v.number(),
  r2Key: v.string(),
  sha256: v.string(),
  sizeBytes: v.number(),
  expiresAt: v.number(),
  conflictRevision: v.optional(v.number()),
  conflictVersionId: v.optional(v.string()),
});

const memoryHeadInternalValidator = v.object({
  documentId: v.string(),
  name: v.string(),
  displayPath: v.string(),
  kind: cloudMemoryDocumentKindValidator,
  source: v.string(),
  ownerGeneration: v.string(),
  memoryEpoch: v.string(),
  revision: v.number(),
  versionId: v.optional(v.string()),
  r2Key: v.string(),
  sha256: v.optional(v.string()),
  sizeBytes: v.number(),
  updatedAt: v.number(),
});

const memoryHeadPublicValidator = v.object({
  documentId: v.string(),
  name: v.string(),
  displayPath: v.string(),
  kind: cloudMemoryDocumentKindValidator,
  source: v.string(),
  revision: v.number(),
  versionId: v.optional(v.string()),
  sha256: v.optional(v.string()),
  sizeBytes: v.number(),
  updatedAt: v.number(),
});

const memoryPreferenceValidator = v.object({
  ownerGeneration: v.string(),
  memoryEpoch: v.string(),
  memoryEnabled: v.boolean(),
  revision: v.number(),
  updatedAt: v.number(),
});

const publicMemoryPreferenceValidator = v.object({
  subject: v.string(),
  ownerGeneration: v.string(),
  memoryEnabled: v.boolean(),
  revision: v.number(),
  updatedAt: v.number(),
});

const requireExpectedMemorySubject = async (
  ctx: QueryCtx | MutationCtx,
  expectedSubject: string,
) => {
  const identity = await requireUserIdentity(ctx);
  const expected = expectedSubject.trim();
  if (
    !expected ||
    expected !== expectedSubject ||
    expected.length > 1_024 ||
    identity.tokenIdentifier !== expected
  ) {
    throw new ConvexError({
      code: "SESSION_IDENTITY_MISMATCH",
      message: "The authenticated cloud session changed before this request.",
    });
  }
  return identity;
};

const readMemoryPreference = async (
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  ownerId: string,
  ownerGeneration: string,
) => {
  const row = await ctx.db
    .query("cloud_agent_home_preferences")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
  if (row && row.ownerGeneration !== ownerGeneration) {
    throw new ConvexError({
      code: "OWNER_DATA_GENERATION_STALE",
      message: "Cloud memory preference belongs to an older account reset.",
    });
  }
  return row
    ? {
        ownerGeneration,
        memoryEnabled: row.memoryEnabled,
        revision: row.revision,
        updatedAt: row.updatedAt,
      }
    : {
        ownerGeneration,
        memoryEnabled: true,
        revision: 0,
        updatedAt: 0,
      };
};

export const getOwnerMemoryPreference = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  expectedGeneration?: string,
) => {
  const lifecycle = await assertOwnerMigrationWriteAllowed(
    ctx,
    ownerId,
    expectedGeneration,
  );
  return await readMemoryPreference(ctx, ownerId, lifecycle.generation);
};

export const assertOwnerMemoryRuntimeEnabled = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  expectedGeneration: string,
) => {
  const memory = await assertMemoryEpochOpen(
    ctx,
    ownerId,
    expectedGeneration,
  );
  const preference = await getOwnerMemoryPreference(
    ctx,
    ownerId,
    expectedGeneration,
  );
  if (!preference.memoryEnabled) {
    throw new ConvexError({
      code: "CLOUD_MEMORY_DISABLED",
      message: "Cloud memory is disabled for this account.",
    });
  }
  return { ...preference, memoryEpoch: memory.memoryEpoch };
};

export const getOwnerMemoryPreferenceInternal = internalQuery({
  args: { ownerId: v.string(), ownerGeneration: v.string() },
  returns: memoryPreferenceValidator,
  handler: async (ctx, args) => {
    const memory = await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    return {
      ...(await getOwnerMemoryPreference(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      )),
      memoryEpoch: memory.memoryEpoch,
    };
  },
});

export const getMyMemoryPreference = query({
  args: { expectedSubject: v.string() },
  returns: publicMemoryPreferenceValidator,
  handler: async (ctx, args) => {
    const identity = await requireExpectedMemorySubject(
      ctx,
      args.expectedSubject,
    );
    return {
      subject: identity.tokenIdentifier,
      ...(await getOwnerMemoryPreference(ctx, identity.tokenIdentifier)),
    };
  },
});

export const setMyMemoryEnabled = mutation({
  args: {
    memoryEnabled: v.boolean(),
    expectedSubject: v.string(),
    expectedOwnerGeneration: v.string(),
    expectedRevision: v.number(),
    requestId: v.string(),
  },
  returns: publicMemoryPreferenceValidator,
  handler: async (ctx, args) => {
    const identity = await requireExpectedMemorySubject(
      ctx,
      args.expectedSubject,
    );
    const ownerId = identity.tokenIdentifier;
    const lifecycle = await assertOwnerMigrationWriteAllowed(
      ctx,
      ownerId,
      args.expectedOwnerGeneration,
    );
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0) {
      throw new ConvexError("expectedRevision must be a non-negative integer.");
    }
    const requestId = assertIdempotencyKey(args.requestId);
    const existing = await ctx.db
      .query("cloud_agent_home_preferences")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (existing && existing.ownerGeneration !== lifecycle.generation) {
      throw new ConvexError({
        code: "OWNER_DATA_GENERATION_STALE",
        message: "Cloud memory preference belongs to an older account reset.",
      });
    }
    if (existing?.lastRequestId === requestId) {
      if (
        existing.lastRequestExpectedRevision !== args.expectedRevision ||
        existing.lastRequestMemoryEnabled !== args.memoryEnabled
      ) {
        throw new ConvexError({
          code: "CLOUD_HOME_IDEMPOTENCY_CONFLICT",
          message: "That memory preference request names different input.",
        });
      }
      return {
        subject: identity.tokenIdentifier,
        ownerGeneration: lifecycle.generation,
        memoryEnabled: existing.memoryEnabled,
        revision: existing.revision,
        updatedAt: existing.updatedAt,
      };
    }
    const currentRevision = existing?.revision ?? 0;
    if (currentRevision !== args.expectedRevision) {
      throw new ConvexError({
        code: "CLOUD_HOME_REVISION_CONFLICT",
        message: "Cloud memory preference changed before this request.",
        currentRevision,
        currentMemoryEnabled: existing?.memoryEnabled ?? true,
      });
    }
    const now = Date.now();
    const revision = currentRevision + 1;
    const values = {
      ownerId,
      ownerGeneration: lifecycle.generation,
      memoryEnabled: args.memoryEnabled,
      revision,
      lastRequestId: requestId,
      lastRequestExpectedRevision: args.expectedRevision,
      lastRequestMemoryEnabled: args.memoryEnabled,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, values);
    else await ctx.db.insert("cloud_agent_home_preferences", { ...values, createdAt: now });
    return {
      subject: identity.tokenIdentifier,
      ownerGeneration: lifecycle.generation,
      memoryEnabled: args.memoryEnabled,
      revision,
      updatedAt: now,
    };
  },
});

export const getOwnerCloudHomeAccessInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.object({ ownerGeneration: v.string() }),
  handler: async (ctx, args) => {
    const lifecycle = await assertOwnerMigrationWriteAllowed(ctx, args.ownerId);
    return { ownerGeneration: lifecycle.generation };
  },
});

const LEGACY_DOCUMENT_NAMES = new Map([
  ["profile.md", "memories/profile.md"],
  ["memory_map.md", "memories/memory_map.md"],
]);

const kindForLegacyName = (name: string): CloudMemoryDocumentKind => {
  const normalized = LEGACY_DOCUMENT_NAMES.get(name) ?? name;
  if (normalized === "MEMORY.md") return "memory";
  if (normalized === "memories/profile.md") return "profile";
  if (normalized === "memories/memory_map.md") return "memory_map";
  if (normalized === "core-memory.md") return "core_memory";
  if (normalized === "PERSONALITY.md") return "personality";
  if (normalized.startsWith("archive/")) return "archive";
  if (normalized.startsWith("imports/")) return "imported_markdown";
  return "user_markdown";
};

const normalizeStoredName = (name: string): string =>
  LEGACY_DOCUMENT_NAMES.get(name) ?? name;

const findDocument = async (
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  ownerId: string,
  name: string,
): Promise<Doc<"cloud_agent_home_docs"> | null> => {
  const exact = await ctx.db
    .query("cloud_agent_home_docs")
    .withIndex("by_ownerId_and_name", (q) =>
      q.eq("ownerId", ownerId).eq("name", name),
    )
    .unique();
  if (exact) return exact;
  const legacy = legacyCloudMemoryName(name);
  if (!legacy) return null;
  return await ctx.db
    .query("cloud_agent_home_docs")
    .withIndex("by_ownerId_and_name", (q) =>
      q.eq("ownerId", ownerId).eq("name", legacy),
    )
    .unique();
};

const toHead = async (
  row: Doc<"cloud_agent_home_docs">,
): Promise<{
  documentId: string;
  name: string;
  displayPath: string;
  kind: CloudMemoryDocumentKind;
  source: string;
  ownerGeneration: string;
  memoryEpoch: string;
  revision: number;
  versionId?: string;
  r2Key: string;
  sha256?: string;
  sizeBytes: number;
  updatedAt: number;
}> => {
  const name = normalizeStoredName(row.name);
  const kind = row.kind ?? kindForLegacyName(row.name);
  let normalized: ReturnType<typeof normalizeCloudMemoryDocument>;
  try {
    normalized = normalizeCloudMemoryDocument(name, kind);
  } catch {
    // Old imported rows from the first owner-transfer implementation used a
    // display-only name. Keep them readable through the private worker API,
    // but require a normalized path before any future write can advance them.
    normalized = {
      name,
      displayPath: `~/.stella/imported/${name}`,
      kind,
      maxBytes: 512 * 1024,
    };
  }
  return {
    documentId: row.documentId ?? (await memoryDocumentId(row.ownerId, name)),
    name,
    displayPath: row.displayPath ?? normalized.displayPath,
    kind,
    source: row.source ?? "legacy_local",
    ownerGeneration: row.ownerGeneration ?? "legacy",
    memoryEpoch: row.memoryEpoch ?? LEGACY_MEMORY_EPOCH,
    revision: row.revision ?? 1,
    ...(row.activeVersionId ? { versionId: row.activeVersionId } : {}),
    r2Key: row.r2Key,
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt,
  };
};

const intentResult = (row: Doc<"cloud_agent_home_write_intents">) => ({
  intentId: row.intentId,
  status: row.status,
  ownerGeneration: row.ownerGeneration,
  memoryEpoch: row.memoryEpoch ?? LEGACY_MEMORY_EPOCH,
  documentId: row.documentId,
  name: row.name,
  displayPath: row.displayPath,
  kind: row.kind,
  baseRevision: row.baseRevision,
  ...(row.baseVersionId ? { baseVersionId: row.baseVersionId } : {}),
  versionId: row.versionId,
  nextRevision: row.nextRevision,
  r2Key: row.r2Key,
  sha256: row.sha256,
  sizeBytes: row.sizeBytes,
  expiresAt: row.expiresAt,
  ...(row.conflictRevision !== undefined
    ? { conflictRevision: row.conflictRevision }
    : {}),
  ...(row.conflictVersionId
    ? { conflictVersionId: row.conflictVersionId }
    : {}),
});

const assertReplayMatches = (
  row: Doc<"cloud_agent_home_write_intents">,
  args: {
    name: string;
    kind: CloudMemoryDocumentKind;
    source: string;
    baseRevision: number;
    sha256: string;
    sizeBytes: number;
    writer: CloudMemoryWriter;
  },
): void => {
  if (
    row.name !== args.name ||
    row.kind !== args.kind ||
    row.source !== args.source ||
    row.baseRevision !== args.baseRevision ||
    row.sha256 !== args.sha256 ||
    row.sizeBytes !== args.sizeBytes ||
    row.writer !== args.writer
  ) {
    throw new ConvexError({
      code: "CLOUD_HOME_IDEMPOTENCY_CONFLICT",
      message: "That cloud-home idempotency key names a different write.",
    });
  }
};

/**
 * Reserve an immutable R2 key and a document-head compare-and-swap. The
 * returned key is private worker data and is never exposed through a public
 * query. The worker uploads and HEAD-verifies exactly these bytes before
 * calling `commitWriteInternal`.
 */
export const beginWriteInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    expectedMemoryEpoch: v.optional(v.string()),
    name: v.string(),
    kind: cloudMemoryDocumentKindValidator,
    source: v.string(),
    expectedRevision: v.number(),
    sha256: v.string(),
    sizeBytes: v.number(),
    writer: cloudMemoryWriterValidator,
    idempotencyKey: v.string(),
    now: v.number(),
  },
  returns: writeIntentResultValidator,
  handler: async (ctx, args) => {
    const lifecycle = await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
      args.expectedMemoryEpoch,
    );
    if (args.writer === "desktop_sync" || args.writer === "mobile_sync") {
      const importState = await getMemoryImportDisposition(
        ctx,
        args.ownerId,
        lifecycle.ownerGeneration,
        lifecycle.memoryEpoch,
      );
      if (importState.importDisposition === "explicit_required") {
        throw new ConvexError({
          code: "CLOUD_MEMORY_REIMPORT_CONFIRMATION_REQUIRED",
          message:
            "Local memory import requires explicit confirmation after a cloud wipe.",
        });
      }
    }
    if (args.writer === "remember") {
      const preference = await readMemoryPreference(
        ctx,
        args.ownerId,
        lifecycle.ownerGeneration,
      );
      if (!preference.memoryEnabled) {
        throw new ConvexError({
          code: "CLOUD_MEMORY_DISABLED",
          message: "Cloud memory is disabled for this account.",
        });
      }
    }
    const normalized = normalizeCloudMemoryDocument(args.name, args.kind);
    const source = args.source.trim() || "cloud";
    const sha256 = assertSha256(args.sha256);
    const sizeBytes = assertCloudHomeSize(args.sizeBytes, normalized.maxBytes);
    const idempotencyKey = assertIdempotencyKey(args.idempotencyKey);
    if (
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0
    ) {
      throw new ConvexError("expectedRevision must be a non-negative integer.");
    }
    const replay = await ctx.db
      .query("cloud_agent_home_write_intents")
      .withIndex("by_ownerId_and_idempotencyKey", (q) =>
        q.eq("ownerId", args.ownerId).eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (replay) {
      assertReplayMatches(replay, {
        name: normalized.name,
        kind: normalized.kind,
        source,
        baseRevision: args.expectedRevision,
        sha256,
        sizeBytes,
        writer: args.writer,
      });
      return intentResult(replay);
    }

    const existing = await findDocument(ctx, args.ownerId, normalized.name);
    const current = existing ? await toHead(existing) : null;
    if (current && current.memoryEpoch !== lifecycle.memoryEpoch) {
      throw new ConvexError({
        code: "CLOUD_MEMORY_EPOCH_STALE",
        message: "Cloud memory metadata belongs to an erased memory epoch.",
      });
    }
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== args.expectedRevision) {
      throw new ConvexError({
        code: "CLOUD_HOME_REVISION_CONFLICT",
        message: "The cloud memory document changed before this write began.",
        currentRevision,
        currentVersionId: current?.versionId ?? null,
      });
    }
    if (!existing) {
      const documents = await ctx.db
        .query("cloud_agent_home_docs")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .take(CLOUD_HOME_MAX_DOCUMENTS + 1);
      if (documents.length >= CLOUD_HOME_MAX_DOCUMENTS) {
        throw new ConvexError(
          `Cloud memory supports at most ${CLOUD_HOME_MAX_DOCUMENTS} documents.`,
        );
      }
    }

    const documentId =
      current?.documentId ??
      (await memoryDocumentId(args.ownerId, normalized.name));
    const versionId = await memoryVersionId({
      ownerId: args.ownerId,
      documentId,
      idempotencyKey,
      sha256,
    });
    const r2Key = await memoryVersionR2Key({
      ownerId: args.ownerId,
      ownerGeneration: lifecycle.ownerGeneration,
      documentId,
      versionId,
      sha256,
    });
    const intentId = `memintent-${crypto.randomUUID()}`;
    await ctx.db.insert("cloud_agent_home_write_intents", {
      intentId,
      ownerId: args.ownerId,
      ownerGeneration: lifecycle.ownerGeneration,
      memoryEpoch: lifecycle.memoryEpoch,
      documentId,
      name: normalized.name,
      displayPath: normalized.displayPath,
      kind: normalized.kind,
      source,
      baseRevision: currentRevision,
      ...(current?.versionId ? { baseVersionId: current.versionId } : {}),
      versionId,
      nextRevision: currentRevision + 1,
      r2Key,
      sha256,
      sizeBytes,
      writer: args.writer,
      idempotencyKey,
      status: "prepared",
      expiresAt: args.now + CLOUD_HOME_WRITE_INTENT_TTL_MS,
      createdAt: args.now,
      updatedAt: args.now,
    });
    const created = await ctx.db
      .query("cloud_agent_home_write_intents")
      .withIndex("by_intentId", (q) => q.eq("intentId", intentId))
      .unique();
    if (!created) throw new ConvexError("Cloud memory write was not reserved.");
    return intentResult(created);
  },
});

export const commitWriteInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    memoryEpoch: v.string(),
    intentId: v.string(),
    versionId: v.string(),
    r2Key: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
    now: v.number(),
  },
  returns: writeIntentResultValidator,
  handler: async (ctx, args) => {
    await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
      args.memoryEpoch,
    );
    const intentId = assertOpaqueCloudHomeId(args.intentId, "memory intent id");
    const intent = await ctx.db
      .query("cloud_agent_home_write_intents")
      .withIndex("by_intentId", (q) => q.eq("intentId", intentId))
      .unique();
    if (!intent || intent.ownerId !== args.ownerId) {
      throw new ConvexError("Memory write intent not found.");
    }
    if (
      intent.ownerGeneration !== args.ownerGeneration ||
      (intent.memoryEpoch ?? LEGACY_MEMORY_EPOCH) !== args.memoryEpoch ||
      intent.versionId !== args.versionId ||
      intent.r2Key !== args.r2Key ||
      intent.sha256 !== assertSha256(args.sha256) ||
      intent.sizeBytes !== args.sizeBytes
    ) {
      throw new ConvexError("Memory write receipt does not match its intent.");
    }
    if (intent.status === "committed" || intent.status === "conflict") {
      return intentResult(intent);
    }
    if (intent.status !== "prepared") {
      throw new ConvexError("Memory write intent is no longer active.");
    }
    if (intent.writer === "remember") {
      const preference = await readMemoryPreference(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
      if (!preference.memoryEnabled) {
        await ctx.db.patch(intent._id, {
          status: "aborted",
          updatedAt: args.now,
        });
        return intentResult({
          ...intent,
          status: "aborted",
          updatedAt: args.now,
        });
      }
    }
    if (intent.expiresAt < args.now) {
      await ctx.db.patch(intent._id, {
        status: "aborted",
        updatedAt: args.now,
      });
      return intentResult({
        ...intent,
        status: "aborted",
        updatedAt: args.now,
      });
    }

    const existing = await findDocument(ctx, args.ownerId, intent.name);
    const current = existing ? await toHead(existing) : null;
    if (current && current.memoryEpoch !== args.memoryEpoch) {
      throw new ConvexError({
        code: "CLOUD_MEMORY_EPOCH_STALE",
        message: "Cloud memory metadata belongs to an erased memory epoch.",
      });
    }
    if (
      (current?.revision ?? 0) !== intent.baseRevision ||
      (current?.versionId ?? undefined) !== intent.baseVersionId
    ) {
      const conflictRevision = current?.revision ?? 0;
      const conflictVersionId = current?.versionId;
      await ctx.db.patch(intent._id, {
        status: "conflict",
        conflictRevision,
        ...(conflictVersionId ? { conflictVersionId } : {}),
        updatedAt: args.now,
      });
      return intentResult({
        ...intent,
        status: "conflict",
        conflictRevision,
        ...(conflictVersionId ? { conflictVersionId } : {}),
        updatedAt: args.now,
      });
    }

    const duplicateVersion = await ctx.db
      .query("cloud_agent_home_doc_versions")
      .withIndex("by_versionId", (q) => q.eq("versionId", intent.versionId))
      .unique();
    if (duplicateVersion) {
      if (
        duplicateVersion.ownerId !== args.ownerId ||
        duplicateVersion.r2Key !== intent.r2Key ||
        duplicateVersion.sha256 !== intent.sha256
      ) {
        throw new ConvexError("Memory version id collision.");
      }
    } else {
      await ctx.db.insert("cloud_agent_home_doc_versions", {
        versionId: intent.versionId,
        documentId: intent.documentId,
        ownerId: intent.ownerId,
        ownerGeneration: intent.ownerGeneration,
        memoryEpoch: intent.memoryEpoch ?? LEGACY_MEMORY_EPOCH,
        name: intent.name,
        revision: intent.nextRevision,
        ...(intent.baseVersionId
          ? { baseVersionId: intent.baseVersionId }
          : {}),
        r2Key: intent.r2Key,
        sha256: intent.sha256,
        sizeBytes: intent.sizeBytes,
        writer: intent.writer,
        idempotencyKey: intent.idempotencyKey,
        createdAt: args.now,
      });
    }
    const headValues = {
      ownerId: intent.ownerId,
      name: intent.name,
      r2Key: intent.r2Key,
      sizeBytes: intent.sizeBytes,
      documentId: intent.documentId,
      displayPath: intent.displayPath,
      kind: intent.kind,
      source: intent.source,
      ownerGeneration: intent.ownerGeneration,
      memoryEpoch: intent.memoryEpoch ?? LEGACY_MEMORY_EPOCH,
      activeVersionId: intent.versionId,
      revision: intent.nextRevision,
      sha256: intent.sha256,
      deletedAt: undefined,
      updatedAt: args.now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, headValues);
    } else {
      await ctx.db.insert("cloud_agent_home_docs", {
        ...headValues,
        createdAt: args.now,
      });
    }
    await ctx.db.patch(intent._id, {
      status: "committed",
      updatedAt: args.now,
    });
    return intentResult({
      ...intent,
      status: "committed",
      updatedAt: args.now,
    });
  },
});

export const getOwnerDocumentHeadInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    name: v.string(),
    kind: cloudMemoryDocumentKindValidator,
  },
  returns: v.union(v.null(), memoryHeadInternalValidator),
  handler: async (ctx, args) => {
    const memory = await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const normalized = normalizeCloudMemoryDocument(args.name, args.kind);
    const row = await findDocument(ctx, args.ownerId, normalized.name);
    if (!row || row.deletedAt !== undefined) return null;
    const head = await toHead(row);
    if (head.memoryEpoch !== memory.memoryEpoch) {
      throw new ConvexError({
        code: "CLOUD_MEMORY_EPOCH_STALE",
        message: "Cloud memory metadata belongs to an erased memory epoch.",
      });
    }
    return head;
  },
});

export const listOwnerDocumentHeadsInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(memoryHeadInternalValidator),
  handler: async (ctx, args) => {
    const memory = await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const limit = Math.min(
      CLOUD_HOME_MAX_DOCUMENTS,
      Math.max(1, Math.floor(args.limit ?? CLOUD_HOME_MAX_DOCUMENTS)),
    );
    const rows = await ctx.db
      .query("cloud_agent_home_docs")
      .withIndex("by_ownerId_and_deletedAt_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("deletedAt", undefined),
      )
      .order("desc")
      .take(limit);
    const heads = await Promise.all(rows.map(toHead));
    if (heads.some((head) => head.memoryEpoch !== memory.memoryEpoch)) {
      throw new ConvexError({
        code: "CLOUD_MEMORY_EPOCH_STALE",
        message: "Cloud memory metadata belongs to an erased memory epoch.",
      });
    }
    return heads;
  },
});

/** Safe desktop/mobile catalog. Object locators remain private to the worker. */
export const listMyMemoryDocuments = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(memoryHeadPublicValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const owner = await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    const memory = await assertMemoryEpochOpen(
      ctx,
      ownerId,
      owner.generation,
    );
    const limit = Math.min(
      CLOUD_HOME_MAX_DOCUMENTS,
      Math.max(1, Math.floor(args.limit ?? CLOUD_HOME_MAX_DOCUMENTS)),
    );
    const rows = await ctx.db
      .query("cloud_agent_home_docs")
      .withIndex("by_ownerId_and_deletedAt_and_updatedAt", (q) =>
        q.eq("ownerId", ownerId).eq("deletedAt", undefined),
      )
      .order("desc")
      .take(limit);
    const heads = await Promise.all(rows.map(toHead));
    if (heads.some((head) => head.memoryEpoch !== memory.memoryEpoch)) {
      throw new ConvexError({
        code: "CLOUD_MEMORY_EPOCH_STALE",
        message: "Cloud memory metadata belongs to an erased memory epoch.",
      });
    }
    return heads.map(
      ({
        ownerGeneration: _ownerGeneration,
        memoryEpoch: _memoryEpoch,
        r2Key: _r2Key,
        ...head
      }) => head,
    );
  },
});

export const getMyMemoryDocument = query({
  args: {
    name: v.string(),
    kind: cloudMemoryDocumentKindValidator,
  },
  returns: v.union(v.null(), memoryHeadPublicValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const owner = await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    const memory = await assertMemoryEpochOpen(
      ctx,
      ownerId,
      owner.generation,
    );
    const normalized = normalizeCloudMemoryDocument(args.name, args.kind);
    const row = await findDocument(ctx, ownerId, normalized.name);
    if (!row || row.deletedAt !== undefined) return null;
    const resolved = await toHead(row);
    if (resolved.memoryEpoch !== memory.memoryEpoch) {
      throw new ConvexError({
        code: "CLOUD_MEMORY_EPOCH_STALE",
        message: "Cloud memory metadata belongs to an erased memory epoch.",
      });
    }
    const {
      ownerGeneration: _ownerGeneration,
      memoryEpoch: _memoryEpoch,
      r2Key: _r2Key,
      ...head
    } = resolved;
    return head;
  },
});
