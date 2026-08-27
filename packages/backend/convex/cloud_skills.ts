import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { assertOwnerMigrationWriteAllowed, requireUserId } from "./auth";
import {
  CLOUD_HOME_WRITE_INTENT_TTL_MS,
  CLOUD_SKILL_MAX_FILES,
  CLOUD_SKILL_MAX_FILE_BYTES,
  CLOUD_SKILL_MAX_TOTAL_BYTES,
  assertIdempotencyKey,
  assertOpaqueCloudHomeId,
  assertSha256,
  cloudSkillId,
  cloudSkillVersionId,
  normalizeSkillFilePath,
  normalizeSkillId,
  skillFileR2Key,
  skillManifestR2Key,
} from "./lib/cloud_home_policy";
import { hashSha256Hex } from "./lib/crypto_utils";
import {
  cloudHomeWriteIntentStatusValidator,
  cloudSkillAuthorizationStateValidator,
  cloudSkillAvailabilityValidator,
  cloudSkillSourceValidator,
} from "./schema/cloud_agent_home";

const MAX_SKILLS_PER_OWNER = 50;
const MAX_SKILL_NAME_CHARS = 120;
const MAX_SKILL_DESCRIPTION_CHARS = 1_000;
const MAX_CONTENT_TYPE_CHARS = 120;
const MAX_ALLOWED_TOOL_NAMES = 64;

const skillFileInputValidator = v.object({
  path: v.string(),
  sha256: v.string(),
  sizeBytes: v.number(),
  contentType: v.string(),
});

const skillFilePrivateValidator = v.object({
  path: v.string(),
  r2Key: v.string(),
  sha256: v.string(),
  sizeBytes: v.number(),
  contentType: v.string(),
});

const skillWriteIntentResultValidator = v.object({
  intentId: v.string(),
  status: cloudHomeWriteIntentStatusValidator,
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
  files: v.array(skillFilePrivateValidator),
  expiresAt: v.number(),
  conflictRevision: v.optional(v.number()),
  conflictVersionId: v.optional(v.string()),
});

const skillCatalogEntryValidator = v.object({
  skillId: v.string(),
  slug: v.string(),
  name: v.string(),
  description: v.string(),
  source: cloudSkillSourceValidator,
  availability: cloudSkillAvailabilityValidator,
  revision: v.number(),
  versionId: v.string(),
  manifestSha256: v.string(),
  treeSha256: v.string(),
  fileCount: v.number(),
  totalSizeBytes: v.number(),
  allowedAgentTypes: v.array(
    v.union(v.literal("orchestrator"), v.literal("general")),
  ),
  allowedToolNames: v.array(v.string()),
  files: v.optional(v.array(skillFilePrivateValidator)),
  updatedAt: v.number(),
});

type SkillFile = {
  path: string;
  r2Key: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
};

const parseIntentFiles = (
  row: Doc<"cloud_skill_write_intents">,
): SkillFile[] => {
  const parsed = JSON.parse(row.filesJson) as unknown;
  if (!Array.isArray(parsed)) {
    throw new ConvexError("Stored skill manifest is invalid.");
  }
  return parsed as SkillFile[];
};

const intentResult = (row: Doc<"cloud_skill_write_intents">) => ({
  intentId: row.intentId,
  status: row.status,
  ownerGeneration: row.ownerGeneration,
  skillId: row.skillId,
  slug: row.slug,
  name: row.name,
  description: row.description,
  source: row.source,
  availability: row.availability,
  baseRevision: row.baseRevision,
  ...(row.baseVersionId ? { baseVersionId: row.baseVersionId } : {}),
  versionId: row.versionId,
  nextRevision: row.nextRevision,
  manifestR2Key: row.manifestR2Key,
  manifestSha256: row.manifestSha256,
  treeSha256: row.treeSha256,
  fileCount: row.fileCount,
  totalSizeBytes: row.totalSizeBytes,
  files: parseIntentFiles(row),
  expiresAt: row.expiresAt,
  ...(row.conflictRevision !== undefined
    ? { conflictRevision: row.conflictRevision }
    : {}),
  ...(row.conflictVersionId
    ? { conflictVersionId: row.conflictVersionId }
    : {}),
});

const normalizeLabel = (
  value: string,
  label: string,
  maxChars: number,
): string => {
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maxChars) {
    throw new ConvexError(`${label} must be 1-${maxChars} characters.`);
  }
  return normalized;
};

const normalizeFiles = async (args: {
  ownerId: string;
  ownerGeneration: string;
  skillId: string;
  versionId: string;
  files: Array<{
    path: string;
    sha256: string;
    sizeBytes: number;
    contentType: string;
  }>;
  expectedTreeSha256: string;
}): Promise<{ files: SkillFile[]; totalSizeBytes: number }> => {
  if (args.files.length === 0 || args.files.length > CLOUD_SKILL_MAX_FILES) {
    throw new ConvexError(
      `A skill needs 1-${CLOUD_SKILL_MAX_FILES} regular files.`,
    );
  }
  const seen = new Set<string>();
  const normalized = await Promise.all(
    args.files.map(async (file): Promise<SkillFile> => {
      const path = normalizeSkillFilePath(file.path);
      if (seen.has(path)) {
        throw new ConvexError(`Duplicate skill file path: ${path}`);
      }
      seen.add(path);
      const sha256 = assertSha256(file.sha256);
      if (
        !Number.isSafeInteger(file.sizeBytes) ||
        file.sizeBytes < 0 ||
        file.sizeBytes > CLOUD_SKILL_MAX_FILE_BYTES
      ) {
        throw new ConvexError(
          `Skill file ${path} exceeds the per-file size limit.`,
        );
      }
      const contentType = file.contentType.trim();
      if (!contentType || contentType.length > MAX_CONTENT_TYPE_CHARS) {
        throw new ConvexError(
          `Skill file ${path} has an invalid content type.`,
        );
      }
      return {
        path,
        r2Key: await skillFileR2Key({
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          skillId: args.skillId,
          versionId: args.versionId,
          path,
        }),
        sha256,
        sizeBytes: file.sizeBytes,
        contentType,
      };
    }),
  );
  normalized.sort((a, b) => a.path.localeCompare(b.path));
  if (!seen.has("SKILL.md")) {
    throw new ConvexError("Every skill package must include SKILL.md.");
  }
  const totalSizeBytes = normalized.reduce(
    (total, file) => total + file.sizeBytes,
    0,
  );
  if (totalSizeBytes > CLOUD_SKILL_MAX_TOTAL_BYTES) {
    throw new ConvexError("Skill package exceeds the total size limit.");
  }
  const calculatedTree = await hashSha256Hex(
    normalized
      .map(
        (file) =>
          `${file.path}\0${file.sha256}\0${file.sizeBytes}\0${file.contentType}\n`,
      )
      .join(""),
  );
  if (calculatedTree !== assertSha256(args.expectedTreeSha256)) {
    throw new ConvexError(
      "Skill tree digest does not match its file manifest.",
    );
  }
  return { files: normalized, totalSizeBytes };
};

export const beginSkillWriteInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    slug: v.string(),
    name: v.string(),
    description: v.string(),
    source: cloudSkillSourceValidator,
    availability: cloudSkillAvailabilityValidator,
    expectedRevision: v.number(),
    manifestSha256: v.string(),
    treeSha256: v.string(),
    files: v.array(skillFileInputValidator),
    idempotencyKey: v.string(),
    now: v.number(),
  },
  returns: skillWriteIntentResultValidator,
  handler: async (ctx, args) => {
    const lifecycle = await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const slug = normalizeSkillId(args.slug);
    const name = normalizeLabel(args.name, "Skill name", MAX_SKILL_NAME_CHARS);
    const description = normalizeLabel(
      args.description,
      "Skill description",
      MAX_SKILL_DESCRIPTION_CHARS,
    );
    const manifestSha256 = assertSha256(args.manifestSha256);
    const treeSha256 = assertSha256(args.treeSha256);
    const idempotencyKey = assertIdempotencyKey(args.idempotencyKey);
    if (
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0
    ) {
      throw new ConvexError("expectedRevision must be a non-negative integer.");
    }

    const replay = await ctx.db
      .query("cloud_skill_write_intents")
      .withIndex("by_ownerId_and_idempotencyKey", (q) =>
        q.eq("ownerId", args.ownerId).eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (replay) {
      if (
        replay.slug !== slug ||
        replay.name !== name ||
        replay.description !== description ||
        replay.source !== args.source ||
        replay.availability !== args.availability ||
        replay.baseRevision !== args.expectedRevision ||
        replay.manifestSha256 !== manifestSha256 ||
        replay.treeSha256 !== treeSha256
      ) {
        throw new ConvexError({
          code: "CLOUD_SKILL_IDEMPOTENCY_CONFLICT",
          message: "That skill idempotency key names a different package.",
        });
      }
      const replayFiles = parseIntentFiles(replay);
      if (
        replayFiles.length !== args.files.length ||
        replayFiles.some((file, index) => {
          const input = [...args.files]
            .map((entry) => ({
              ...entry,
              path: normalizeSkillFilePath(entry.path),
              sha256: assertSha256(entry.sha256),
            }))
            .sort((a, b) => a.path.localeCompare(b.path))[index];
          return (
            !input ||
            file.path !== input.path ||
            file.sha256 !== input.sha256 ||
            file.sizeBytes !== input.sizeBytes ||
            file.contentType !== input.contentType.trim()
          );
        })
      ) {
        throw new ConvexError({
          code: "CLOUD_SKILL_IDEMPOTENCY_CONFLICT",
          message: "That skill idempotency key names different files.",
        });
      }
      return intentResult(replay);
    }

    const skillId = await cloudSkillId(args.ownerId, slug);
    const existing = await ctx.db
      .query("cloud_skills")
      .withIndex("by_skillId", (q) => q.eq("skillId", skillId))
      .unique();
    if (existing && existing.ownerId !== args.ownerId) {
      throw new ConvexError("Skill identity collision.");
    }
    const currentRevision = existing?.revision ?? 0;
    if (currentRevision !== args.expectedRevision) {
      throw new ConvexError({
        code: "CLOUD_SKILL_REVISION_CONFLICT",
        message: "The cloud skill changed before this upload began.",
        currentRevision,
        currentVersionId: existing?.activeVersionId ?? null,
      });
    }
    if (!existing) {
      const rows = await ctx.db
        .query("cloud_skills")
        .withIndex("by_ownerId_and_deletedAt_and_updatedAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("deletedAt", undefined),
        )
        .take(MAX_SKILLS_PER_OWNER + 1);
      if (rows.length >= MAX_SKILLS_PER_OWNER) {
        throw new ConvexError(
          `Cloud Skills supports at most ${MAX_SKILLS_PER_OWNER} installed skills.`,
        );
      }
    }

    const versionId = await cloudSkillVersionId({
      ownerId: args.ownerId,
      skillId,
      idempotencyKey,
      treeSha256,
    });
    const { files, totalSizeBytes } = await normalizeFiles({
      ownerId: args.ownerId,
      ownerGeneration: lifecycle.generation,
      skillId,
      versionId,
      files: args.files,
      expectedTreeSha256: treeSha256,
    });
    const intentId = `skillintent-${crypto.randomUUID()}`;
    const manifestR2Key = await skillManifestR2Key({
      ownerId: args.ownerId,
      ownerGeneration: lifecycle.generation,
      skillId,
      versionId,
    });
    await ctx.db.insert("cloud_skill_write_intents", {
      intentId,
      ownerId: args.ownerId,
      ownerGeneration: lifecycle.generation,
      skillId,
      slug,
      name,
      description,
      source: args.source,
      availability: args.availability,
      baseRevision: currentRevision,
      ...(existing?.activeVersionId
        ? { baseVersionId: existing.activeVersionId }
        : {}),
      versionId,
      nextRevision: currentRevision + 1,
      manifestR2Key,
      manifestSha256,
      treeSha256,
      fileCount: files.length,
      totalSizeBytes,
      filesJson: JSON.stringify(files),
      idempotencyKey,
      status: "prepared",
      expiresAt: args.now + CLOUD_HOME_WRITE_INTENT_TTL_MS,
      createdAt: args.now,
      updatedAt: args.now,
    });
    const created = await ctx.db
      .query("cloud_skill_write_intents")
      .withIndex("by_intentId", (q) => q.eq("intentId", intentId))
      .unique();
    if (!created) throw new ConvexError("Skill upload was not reserved.");
    return intentResult(created);
  },
});

export const commitSkillWriteInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    intentId: v.string(),
    versionId: v.string(),
    manifestR2Key: v.string(),
    manifestSha256: v.string(),
    treeSha256: v.string(),
    now: v.number(),
  },
  returns: skillWriteIntentResultValidator,
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const intentId = assertOpaqueCloudHomeId(args.intentId, "skill intent id");
    const intent = await ctx.db
      .query("cloud_skill_write_intents")
      .withIndex("by_intentId", (q) => q.eq("intentId", intentId))
      .unique();
    if (!intent || intent.ownerId !== args.ownerId) {
      throw new ConvexError("Skill write intent not found.");
    }
    if (
      intent.ownerGeneration !== args.ownerGeneration ||
      intent.versionId !== args.versionId ||
      intent.manifestR2Key !== args.manifestR2Key ||
      intent.manifestSha256 !== assertSha256(args.manifestSha256) ||
      intent.treeSha256 !== assertSha256(args.treeSha256)
    ) {
      throw new ConvexError("Skill write receipt does not match its intent.");
    }
    if (intent.status === "committed" || intent.status === "conflict") {
      return intentResult(intent);
    }
    if (intent.status !== "prepared") {
      throw new ConvexError("Skill write intent is no longer active.");
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
    const skill = await ctx.db
      .query("cloud_skills")
      .withIndex("by_skillId", (q) => q.eq("skillId", intent.skillId))
      .unique();
    if (
      (skill?.revision ?? 0) !== intent.baseRevision ||
      (skill?.activeVersionId ?? undefined) !== intent.baseVersionId
    ) {
      const conflictRevision = skill?.revision ?? 0;
      const conflictVersionId = skill?.activeVersionId;
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

    const existingVersion = await ctx.db
      .query("cloud_skill_versions")
      .withIndex("by_versionId", (q) => q.eq("versionId", intent.versionId))
      .unique();
    if (existingVersion) {
      if (
        existingVersion.ownerId !== args.ownerId ||
        existingVersion.manifestR2Key !== intent.manifestR2Key ||
        existingVersion.treeSha256 !== intent.treeSha256
      ) {
        throw new ConvexError("Skill version id collision.");
      }
    } else {
      await ctx.db.insert("cloud_skill_versions", {
        versionId: intent.versionId,
        skillId: intent.skillId,
        ownerId: intent.ownerId,
        ownerGeneration: intent.ownerGeneration,
        revision: intent.nextRevision,
        ...(intent.baseVersionId
          ? { baseVersionId: intent.baseVersionId }
          : {}),
        manifestR2Key: intent.manifestR2Key,
        manifestSha256: intent.manifestSha256,
        treeSha256: intent.treeSha256,
        fileCount: intent.fileCount,
        totalSizeBytes: intent.totalSizeBytes,
        source: intent.source,
        idempotencyKey: intent.idempotencyKey,
        createdAt: args.now,
      });
      for (const file of parseIntentFiles(intent)) {
        await ctx.db.insert("cloud_skill_files", {
          ownerId: intent.ownerId,
          skillId: intent.skillId,
          versionId: intent.versionId,
          ...file,
          createdAt: args.now,
        });
      }
    }
    const headValues = {
      skillId: intent.skillId,
      ownerId: intent.ownerId,
      slug: intent.slug,
      name: intent.name,
      description: intent.description,
      source: intent.source,
      availability: intent.availability,
      activeVersionId: intent.versionId,
      revision: intent.nextRevision,
      enabled: true,
      deletedAt: undefined,
      updatedAt: args.now,
    };
    if (skill) {
      await ctx.db.patch(skill._id, headValues);
    } else {
      await ctx.db.insert("cloud_skills", {
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

const normalizeAgentTypes = (
  values: Array<"orchestrator" | "general">,
): Array<"orchestrator" | "general"> => {
  const unique = [...new Set(values)];
  if (unique.length === 0 || unique.length > 2) {
    throw new ConvexError("Select at least one supported skill agent type.");
  }
  return unique.sort();
};

const normalizeToolNames = (values: string[]): string[] => {
  if (values.length > MAX_ALLOWED_TOOL_NAMES) {
    throw new ConvexError("Too many skill tool authorizations.");
  }
  const normalized = [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ];
  if (
    normalized.some(
      (value) => value.length > 80 || !/^[A-Za-z0-9_.:-]+$/u.test(value),
    )
  ) {
    throw new ConvexError("Invalid skill tool authorization.");
  }
  return normalized.sort();
};

export const authorizeMySkill = mutation({
  args: {
    skillId: v.string(),
    versionId: v.string(),
    expectedOwnerGeneration: v.string(),
    expectedAuthorizationRevision: v.number(),
    allowedAgentTypes: v.array(
      v.union(v.literal("orchestrator"), v.literal("general")),
    ),
    allowedToolNames: v.array(v.string()),
  },
  returns: v.object({ authorizationRevision: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await assertOwnerMigrationWriteAllowed(
      ctx,
      ownerId,
      args.expectedOwnerGeneration,
    );
    const skill = await ctx.db
      .query("cloud_skills")
      .withIndex("by_skillId", (q) => q.eq("skillId", args.skillId))
      .unique();
    if (
      !skill ||
      skill.ownerId !== ownerId ||
      skill.deletedAt !== undefined ||
      skill.activeVersionId !== args.versionId
    ) {
      throw new ConvexError("Skill version not found.");
    }
    const authorization = await ctx.db
      .query("cloud_skill_authorizations")
      .withIndex("by_ownerId_and_skillId", (q) =>
        q.eq("ownerId", ownerId).eq("skillId", skill.skillId),
      )
      .unique();
    const currentRevision = authorization?.authorizationRevision ?? 0;
    if (currentRevision !== args.expectedAuthorizationRevision) {
      throw new ConvexError({
        code: "CLOUD_SKILL_AUTHORIZATION_CONFLICT",
        message: "Skill authorization changed on another client.",
        currentRevision,
      });
    }
    const allowedAgentTypes = normalizeAgentTypes(args.allowedAgentTypes);
    if (
      allowedAgentTypes.some(
        (agentType) =>
          skill.availability !== "both" && skill.availability !== agentType,
      )
    ) {
      throw new ConvexError(
        "Skill authorization exceeds the package's declared availability.",
      );
    }
    const allowedToolNames = normalizeToolNames(args.allowedToolNames);
    const now = Date.now();
    const nextRevision = currentRevision + 1;
    const values = {
      ownerId,
      skillId: skill.skillId,
      versionId: args.versionId,
      state: "active" as const,
      allowedAgentTypes,
      allowedToolNames,
      authorizationRevision: nextRevision,
      approvedAt: now,
      revokedAt: undefined,
      updatedAt: now,
    };
    if (authorization) {
      await ctx.db.patch(authorization._id, values);
    } else {
      await ctx.db.insert("cloud_skill_authorizations", {
        ...values,
        createdAt: now,
      });
    }
    return { authorizationRevision: nextRevision };
  },
});

export const revokeMySkill = mutation({
  args: {
    skillId: v.string(),
    expectedOwnerGeneration: v.string(),
    expectedAuthorizationRevision: v.number(),
  },
  returns: v.object({ authorizationRevision: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await assertOwnerMigrationWriteAllowed(
      ctx,
      ownerId,
      args.expectedOwnerGeneration,
    );
    const authorization = await ctx.db
      .query("cloud_skill_authorizations")
      .withIndex("by_ownerId_and_skillId", (q) =>
        q.eq("ownerId", ownerId).eq("skillId", args.skillId),
      )
      .unique();
    if (
      !authorization ||
      authorization.authorizationRevision !== args.expectedAuthorizationRevision
    ) {
      throw new ConvexError({
        code: "CLOUD_SKILL_AUTHORIZATION_CONFLICT",
        message: "Skill authorization changed on another client.",
        currentRevision: authorization?.authorizationRevision ?? 0,
      });
    }
    const now = Date.now();
    const authorizationRevision = authorization.authorizationRevision + 1;
    await ctx.db.patch(authorization._id, {
      state: "revoked",
      authorizationRevision,
      revokedAt: now,
      updatedAt: now,
    });
    return { authorizationRevision };
  },
});

export const setMySkillEnabled = mutation({
  args: {
    skillId: v.string(),
    enabled: v.boolean(),
    expectedOwnerGeneration: v.string(),
    expectedRevision: v.number(),
  },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await assertOwnerMigrationWriteAllowed(
      ctx,
      ownerId,
      args.expectedOwnerGeneration,
    );
    const skill = await ctx.db
      .query("cloud_skills")
      .withIndex("by_skillId", (q) => q.eq("skillId", args.skillId))
      .unique();
    if (!skill || skill.ownerId !== ownerId || skill.deletedAt !== undefined) {
      throw new ConvexError("Skill not found.");
    }
    if (
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0 ||
      skill.revision !== args.expectedRevision
    ) {
      throw new ConvexError({
        code: "CLOUD_SKILL_REVISION_CONFLICT",
        message: "The cloud skill changed on another client.",
        currentRevision: skill.revision,
      });
    }
    const revision = skill.revision + 1;
    await ctx.db.patch(skill._id, {
      enabled: args.enabled,
      revision,
      updatedAt: Date.now(),
    });
    return { revision };
  },
});

const buildCatalogEntry = async (
  ctx: QueryCtx,
  authorization: Doc<"cloud_skill_authorizations">,
  agentType: "orchestrator" | "general",
  includeFiles: boolean,
) => {
  if (!authorization.allowedAgentTypes.includes(agentType)) return null;
  const skill = await ctx.db
    .query("cloud_skills")
    .withIndex("by_skillId", (q) => q.eq("skillId", authorization.skillId))
    .unique();
  if (
    !skill ||
    skill.ownerId !== authorization.ownerId ||
    skill.deletedAt !== undefined ||
    !skill.enabled ||
    !skill.activeVersionId ||
    skill.activeVersionId !== authorization.versionId ||
    !(skill.availability === "both" || skill.availability === agentType)
  ) {
    return null;
  }
  const version = await ctx.db
    .query("cloud_skill_versions")
    .withIndex("by_versionId", (q) => q.eq("versionId", skill.activeVersionId!))
    .unique();
  if (!version || version.ownerId !== authorization.ownerId) return null;
  const files = includeFiles
    ? await ctx.db
        .query("cloud_skill_files")
        .withIndex("by_ownerId_and_versionId_and_path", (q) =>
          q
            .eq("ownerId", authorization.ownerId)
            .eq("versionId", version.versionId),
        )
        .take(CLOUD_SKILL_MAX_FILES + 1)
    : [];
  if (files.length > CLOUD_SKILL_MAX_FILES) {
    throw new ConvexError("Skill file manifest exceeds its declared bound.");
  }
  return {
    skillId: skill.skillId,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    availability: skill.availability,
    revision: skill.revision,
    versionId: version.versionId,
    manifestSha256: version.manifestSha256,
    treeSha256: version.treeSha256,
    fileCount: version.fileCount,
    totalSizeBytes: version.totalSizeBytes,
    allowedAgentTypes: authorization.allowedAgentTypes,
    allowedToolNames: authorization.allowedToolNames,
    ...(includeFiles
      ? {
          files: files.map((file) => ({
            path: file.path,
            r2Key: file.r2Key,
            sha256: file.sha256,
            sizeBytes: file.sizeBytes,
            contentType: file.contentType,
          })),
        }
      : {}),
    updatedAt: skill.updatedAt,
  };
};

export const listAuthorizedSkillsInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    agentType: v.union(v.literal("orchestrator"), v.literal("general")),
    includeFiles: v.optional(v.boolean()),
  },
  returns: v.array(skillCatalogEntryValidator),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const authorizations = await ctx.db
      .query("cloud_skill_authorizations")
      .withIndex("by_ownerId_and_state_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "active"),
      )
      .order("desc")
      .take(MAX_SKILLS_PER_OWNER);
    const entries = await Promise.all(
      authorizations.map((authorization) =>
        buildCatalogEntry(
          ctx,
          authorization,
          args.agentType,
          args.includeFiles === true,
        ),
      ),
    );
    return entries.filter((entry): entry is NonNullable<typeof entry> =>
      Boolean(entry),
    );
  },
});

/** Public catalog intentionally omits every R2 object locator. */
export const listMySkills = query({
  args: { clientScope: v.string() },
  returns: v.array(
    v.object({
      skillId: v.string(),
      ownerGeneration: v.string(),
      slug: v.string(),
      name: v.string(),
      description: v.string(),
      source: cloudSkillSourceValidator,
      availability: cloudSkillAvailabilityValidator,
      revision: v.number(),
      versionId: v.optional(v.string()),
      manifestSha256: v.optional(v.string()),
      treeSha256: v.optional(v.string()),
      fileCount: v.optional(v.number()),
      totalSizeBytes: v.optional(v.number()),
      enabled: v.boolean(),
      authorizationState: v.optional(cloudSkillAuthorizationStateValidator),
      authorizationVersionId: v.optional(v.string()),
      authorizationRevision: v.optional(v.number()),
      allowedAgentTypes: v.optional(
        v.array(v.union(v.literal("orchestrator"), v.literal("general"))),
      ),
      allowedToolNames: v.optional(v.array(v.string())),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    // This value exists only to partition the Convex client cache across
    // account transitions. Authorization is derived exclusively from ctx.auth.
    if (!args.clientScope.trim() || args.clientScope.length > 512) {
      throw new ConvexError("Cloud Home client scope was invalid.");
    }
    const ownerId = await requireUserId(ctx);
    const lifecycle = await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    const skills = await ctx.db
      .query("cloud_skills")
      .withIndex("by_ownerId_and_deletedAt_and_updatedAt", (q) =>
        q.eq("ownerId", ownerId).eq("deletedAt", undefined),
      )
      .order("desc")
      .take(MAX_SKILLS_PER_OWNER);
    return await Promise.all(
      skills.map(async (skill) => {
        const [authorization, version] = await Promise.all([
          ctx.db
            .query("cloud_skill_authorizations")
            .withIndex("by_ownerId_and_skillId", (q) =>
              q.eq("ownerId", ownerId).eq("skillId", skill.skillId),
            )
            .unique(),
          skill.activeVersionId
            ? ctx.db
                .query("cloud_skill_versions")
                .withIndex("by_versionId", (q) =>
                  q.eq("versionId", skill.activeVersionId!),
                )
                .unique()
            : Promise.resolve(null),
        ]);
        const ownedVersion = version?.ownerId === ownerId ? version : null;
        return {
          skillId: skill.skillId,
          ownerGeneration: lifecycle.generation,
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          source: skill.source,
          availability: skill.availability,
          revision: skill.revision,
          ...(skill.activeVersionId
            ? { versionId: skill.activeVersionId }
            : {}),
          ...(ownedVersion
            ? {
                manifestSha256: ownedVersion.manifestSha256,
                treeSha256: ownedVersion.treeSha256,
                fileCount: ownedVersion.fileCount,
                totalSizeBytes: ownedVersion.totalSizeBytes,
              }
            : {}),
          enabled: skill.enabled,
          ...(authorization
            ? {
                authorizationState: authorization.state,
                authorizationVersionId: authorization.versionId,
                authorizationRevision: authorization.authorizationRevision,
                allowedAgentTypes: authorization.allowedAgentTypes,
                allowedToolNames: authorization.allowedToolNames,
              }
            : {}),
          updatedAt: skill.updatedAt,
        };
      }),
    );
  },
});
