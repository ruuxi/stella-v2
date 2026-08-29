import { defineTable } from "convex/server";
import { v } from "convex/values";

export const cloudMemoryDocumentKindValidator = v.union(
  v.literal("memory"),
  v.literal("profile"),
  v.literal("memory_map"),
  v.literal("core_memory"),
  v.literal("personality"),
  v.literal("imported_markdown"),
  v.literal("user_markdown"),
  v.literal("archive"),
);

export const cloudMemoryWriterValidator = v.union(
  v.literal("remember"),
  v.literal("desktop_sync"),
  v.literal("mobile_sync"),
  v.literal("user_edit"),
  v.literal("owner_migration"),
  v.literal("system_seed"),
);

export const cloudHomeWriteIntentStatusValidator = v.union(
  v.literal("prepared"),
  v.literal("committed"),
  v.literal("conflict"),
  v.literal("aborted"),
);

export const cloudMemoryLifecycleStateValidator = v.union(
  v.literal("open"),
  v.literal("wiping"),
);

export const cloudMemoryImportDispositionValidator = v.union(
  v.literal("automatic_allowed"),
  v.literal("explicit_required"),
  v.literal("explicit_allowed"),
);

export const cloudMemoryWipeStageValidator = v.union(
  v.literal("sweeping"),
  v.literal("metadata"),
  v.literal("releasing"),
  v.literal("completed"),
);

export const cloudSkillAvailabilityValidator = v.union(
  v.literal("orchestrator"),
  v.literal("general"),
  v.literal("both"),
);

export const cloudSkillSourceValidator = v.union(
  v.literal("bundled"),
  v.literal("desktop_sync"),
  v.literal("mobile_sync"),
  v.literal("cloud_created"),
  v.literal("owner_migration"),
);

export const cloudAgentHomeSchema = {
  /**
   * Memory-only destructive lifecycle. `epoch` is opaque and monotonically
   * replaced (never ordered) after an object-first wipe. Absence is the legacy
   * open epoch, which lets this fence deploy before existing rows are upgraded.
   */
  cloud_memory_lifecycles: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    epoch: v.string(),
    state: cloudMemoryLifecycleStateValidator,
    operationId: v.optional(v.string()),
    importDisposition: v.optional(cloudMemoryImportDispositionValidator),
    lastWipedEpoch: v.optional(v.string()),
    importAuthorizationRequestId: v.optional(v.string()),
    importAuthorizedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

  /**
   * One crash-safe memory wipe receipt/job per owner. A completed row remains
   * as the idempotent receipt until a later request starts a new epoch wipe.
   */
  cloud_memory_wipe_jobs: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    operationId: v.string(),
    requestId: v.string(),
    requestedEpoch: v.string(),
    targetEpoch: v.string(),
    nextEpoch: v.string(),
    stage: cloudMemoryWipeStageValidator,
    externalGeneration: v.optional(v.string()),
    externalCursor: v.number(),
    /**
     * Exact R2 key after the last scanned object inside a filtered target.
     * Optional for rolling compatibility and cleared whenever the numeric
     * target cursor advances. This is scan position only, never an authority
     * or client-supplied deletion locator.
     */
    externalStartAfter: v.optional(v.string()),
    metadataStoreIndex: v.number(),
    attempts: v.number(),
    nextRetryAt: v.number(),
    leaseId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    lastErrorCode: v.optional(v.string()),
    objectsDeleted: v.number(),
    rowsDeleted: v.number(),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_stage_and_nextRetryAt", ["stage", "nextRetryAt"]),

  /**
   * Cloud-authoritative memory privacy switch. Absence means enabled for
   * backwards compatibility; once written, generation+revision CAS controls
   * startup injection and every Recall/Remember path.
   */
  cloud_agent_home_preferences: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    memoryEnabled: v.boolean(),
    revision: v.number(),
    lastRequestId: v.string(),
    lastRequestExpectedRevision: v.number(),
    lastRequestMemoryEnabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

  // Registry of the owner's memory documents. Immutable version bytes live in
  // R2 below agent-home/<sha256(ownerId)>/ and are read and written by the
  // orchestrator DO through its AGENT_HOME binding. Convex keeps the exact
  // generation-fenced locator, digest and active version, so Recall and the UI
  // never trust a bucket listing. Legacy mutable AgentHome rows may still use
  // a generation-scoped subdirectory until their one-way upgrade completes.
  cloud_agent_home_docs: defineTable({
    ownerId: v.string(),
    // Legacy rows contain only name/r2Key/sizeBytes/timestamps. The optional
    // fields below are lazily filled the first time the document is written
    // through the versioned cloud-home plane; keeping them optional makes the
    // schema safe to deploy before that migration has completed.
    name: v.string(),
    r2Key: v.string(),
    sizeBytes: v.number(),
    documentId: v.optional(v.string()),
    displayPath: v.optional(v.string()),
    kind: v.optional(cloudMemoryDocumentKindValidator),
    source: v.optional(v.string()),
    ownerGeneration: v.optional(v.string()),
    memoryEpoch: v.optional(v.string()),
    activeVersionId: v.optional(v.string()),
    revision: v.optional(v.number()),
    sha256: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_name", ["ownerId", "name"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_and_deletedAt_and_updatedAt", [
      "ownerId",
      "deletedAt",
      "updatedAt",
    ])
    .index("by_documentId", ["documentId"]),

  /** Immutable metadata for every published memory-document version. */
  cloud_agent_home_doc_versions: defineTable({
    versionId: v.string(),
    documentId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    memoryEpoch: v.optional(v.string()),
    name: v.string(),
    revision: v.number(),
    baseVersionId: v.optional(v.string()),
    r2Key: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
    writer: cloudMemoryWriterValidator,
    idempotencyKey: v.string(),
    createdAt: v.number(),
  })
    .index("by_versionId", ["versionId"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_ownerId_and_documentId_and_revision", [
      "ownerId",
      "documentId",
      "revision",
    ])
    .index("by_ownerId_and_idempotencyKey", ["ownerId", "idempotencyKey"]),

  /**
   * Durable half of the R2-first publication protocol. A writer reserves an
   * exact object key and digest, uploads those bytes, verifies them with HEAD,
   * then atomically advances the document head. A lost response can replay the
   * same idempotency key; a different payload under that key is rejected.
   */
  cloud_agent_home_write_intents: defineTable({
    intentId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    memoryEpoch: v.optional(v.string()),
    documentId: v.string(),
    name: v.string(),
    displayPath: v.string(),
    kind: cloudMemoryDocumentKindValidator,
    source: v.string(),
    baseRevision: v.number(),
    baseVersionId: v.optional(v.string()),
    versionId: v.string(),
    nextRevision: v.number(),
    r2Key: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
    writer: cloudMemoryWriterValidator,
    idempotencyKey: v.string(),
    status: cloudHomeWriteIntentStatusValidator,
    conflictRevision: v.optional(v.number()),
    conflictVersionId: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_intentId", ["intentId"])
    .index("by_ownerId_and_idempotencyKey", ["ownerId", "idempotencyKey"])
    .index("by_ownerId_and_status_and_updatedAt", [
      "ownerId",
      "status",
      "updatedAt",
    ])
    .index("by_status_and_expiresAt", ["status", "expiresAt"]),

  /**
   * Mirror head for one skill in the owner's canonical device skills root;
   * package bytes never live in Convex. There is no cloud-side enable or
   * authorize flag: the device root decides which skills exist.
   */
  cloud_skills: defineTable({
    skillId: v.string(),
    ownerId: v.string(),
    slug: v.string(),
    name: v.string(),
    description: v.string(),
    source: cloudSkillSourceValidator,
    availability: cloudSkillAvailabilityValidator,
    activeVersionId: v.optional(v.string()),
    revision: v.number(),
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_skillId", ["skillId"])
    .index("by_ownerId_and_slug", ["ownerId", "slug"])
    .index("by_ownerId_and_name", ["ownerId", "name"])
    .index("by_ownerId_and_deletedAt_and_updatedAt", [
      "ownerId",
      "deletedAt",
      "updatedAt",
    ]),

  /** Immutable package manifest for one skill revision. */
  cloud_skill_versions: defineTable({
    versionId: v.string(),
    skillId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    revision: v.number(),
    baseVersionId: v.optional(v.string()),
    manifestR2Key: v.string(),
    manifestSha256: v.string(),
    treeSha256: v.string(),
    fileCount: v.number(),
    totalSizeBytes: v.number(),
    source: cloudSkillSourceValidator,
    idempotencyKey: v.string(),
    createdAt: v.number(),
  })
    .index("by_versionId", ["versionId"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_ownerId_and_skillId_and_revision", [
      "ownerId",
      "skillId",
      "revision",
    ])
    .index("by_ownerId_and_idempotencyKey", ["ownerId", "idempotencyKey"]),

  /** R2-first publication reservation for an immutable skill package. */
  cloud_skill_write_intents: defineTable({
    intentId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    skillId: v.string(),
    slug: v.string(),
    name: v.string(),
    description: v.string(),
    source: cloudSkillSourceValidator,
    availability: cloudSkillAvailabilityValidator,
    baseRevision: v.number(),
    baseVersionId: v.optional(v.string()),
    versionId: v.string(),
    nextRevision: v.number(),
    manifestR2Key: v.string(),
    manifestSha256: v.string(),
    treeSha256: v.string(),
    fileCount: v.number(),
    totalSizeBytes: v.number(),
    filesJson: v.string(),
    idempotencyKey: v.string(),
    status: cloudHomeWriteIntentStatusValidator,
    conflictRevision: v.optional(v.number()),
    conflictVersionId: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_intentId", ["intentId"])
    .index("by_ownerId_and_idempotencyKey", ["ownerId", "idempotencyKey"])
    .index("by_ownerId_and_status_and_updatedAt", [
      "ownerId",
      "status",
      "updatedAt",
    ])
    .index("by_status_and_expiresAt", ["status", "expiresAt"]),

  /** Exact file allowlist for a skill version; no bucket listing is trusted. */
  cloud_skill_files: defineTable({
    ownerId: v.string(),
    skillId: v.string(),
    versionId: v.string(),
    path: v.string(),
    r2Key: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
    contentType: v.string(),
    createdAt: v.number(),
  })
    .index("by_ownerId_and_versionId_and_path", [
      "ownerId",
      "versionId",
      "path",
    ])
    .index("by_ownerId_and_skillId", ["ownerId", "skillId"]),
};
