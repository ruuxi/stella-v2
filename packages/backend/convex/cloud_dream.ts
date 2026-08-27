import { ConvexError, v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { assertOwnerMigrationWriteAllowed, requireUserId } from "./auth";
import {
  assertOwnerMemoryRuntimeEnabled,
  getOwnerMemoryPreference,
} from "./cloud_memory";
import {
  assertMemoryEpochOpen,
  LEGACY_MEMORY_EPOCH,
} from "./cloud_memory_lifecycle";
import { hashSha256Hex } from "./lib/crypto_utils";
import {
  CLOUD_DREAM_CLAIM_TTL_MS,
  assertCloudHomeSize,
  assertOpaqueCloudHomeId,
  assertSha256,
  dreamInboxId,
  dreamInboxR2Key,
} from "./lib/cloud_home_policy";
import {
  cloudDreamDispatchStatusValidator,
  cloudDreamInboxKindValidator,
  cloudDreamRunStatusValidator,
} from "./schema/cloud_agent_home";

const DREAM_INPUT_MAX_BYTES = 256 * 1024;
const DREAM_BATCH_DEFAULT = 24;
const DREAM_BATCH_MAX = 50;
const DREAM_SOURCE_KEY_MAX_CHARS = 384;
const DREAM_TITLE_MAX_CHARS = 240;
const DREAM_ERROR_MAX_CHARS = 2_000;
const AUTOMATIC_DREAM_PAYLOAD_MAX_CHARS = 16_000;
const AUTOMATIC_DREAM_PROMPT_MAX_CHARS = 4_000;
const AUTOMATIC_DREAM_RESULT_MAX_CHARS = 10_000;
const AUTOMATIC_DREAM_DISPATCH_LEASE_MS = 6 * 60_000;
const AUTOMATIC_DREAM_MAX_ATTEMPTS = 8;
const AUTOMATIC_DREAM_SWEEP_LIMIT = 20;
const AUTOMATIC_DREAM_RETRY_MAX_MS = 60 * 60_000;

type AutomaticDreamDispatchIdentity = {
  dispatchId: string;
  ownerId: string;
  ownerGeneration: string;
  memoryEpoch: string;
};

type AutomaticDreamClaim = AutomaticDreamDispatchIdentity & {
  conversationId: string;
  turnId: string;
  sourceKey: string;
  sourceRevision: number;
  title?: string;
  payloadJson: string;
  payloadSha256: string;
  attemptCount: number;
  leaseId: string;
  leaseExpiresAt: number;
};

const automaticDreamActionRef = makeFunctionReference<
  "action",
  AutomaticDreamDispatchIdentity,
  null
>("cloud_dream:runAutomaticDreamDispatchInternal");

const automaticDreamClaimRef = makeFunctionReference<
  "mutation",
  AutomaticDreamDispatchIdentity & { now: number },
  AutomaticDreamClaim | null
>("cloud_dream:claimAutomaticDreamDispatchInternal");

const automaticDreamFenceRef = makeFunctionReference<
  "mutation",
  AutomaticDreamDispatchIdentity & {
    leaseId: string;
    now: number;
    inboxId?: string;
    runId?: string;
  },
  null
>("cloud_dream:assertAutomaticDreamDispatchAllowedInternal");

const automaticDreamCompleteRef = makeFunctionReference<
  "mutation",
  AutomaticDreamDispatchIdentity & {
    leaseId: string;
    inboxId: string;
    runId: string;
    processedCount: number;
    now: number;
  },
  null
>("cloud_dream:completeAutomaticDreamDispatchInternal");

const automaticDreamRetryRef = makeFunctionReference<
  "mutation",
  AutomaticDreamDispatchIdentity & {
    leaseId: string;
    errorCode: string;
    now: number;
  },
  null
>("cloud_dream:retryAutomaticDreamDispatchInternal");

const inboxPrivateValidator = v.object({
  inboxId: v.string(),
  memoryEpoch: v.string(),
  kind: cloudDreamInboxKindValidator,
  sourceKey: v.string(),
  sourceRevision: v.number(),
  title: v.optional(v.string()),
  r2Key: v.string(),
  sha256: v.string(),
  sizeBytes: v.number(),
  priority: v.number(),
  usageCount: v.number(),
  lastUsageAt: v.optional(v.number()),
  updatedAt: v.number(),
});

const claimResultValidator = v.object({
  runId: v.string(),
  memoryEpoch: v.string(),
  status: cloudDreamRunStatusValidator,
  leaseId: v.string(),
  leaseExpiresAt: v.number(),
  entries: v.array(inboxPrivateValidator),
});

const automaticDreamClaimValidator = v.union(
  v.null(),
  v.object({
    dispatchId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    memoryEpoch: v.string(),
    conversationId: v.string(),
    turnId: v.string(),
    sourceKey: v.string(),
    sourceRevision: v.number(),
    title: v.optional(v.string()),
    payloadJson: v.string(),
    payloadSha256: v.string(),
    attemptCount: v.number(),
    leaseId: v.string(),
    leaseExpiresAt: v.number(),
  }),
);

const priorityForKind = (kind: Doc<"cloud_dream_inbox">["kind"]): number => {
  switch (kind) {
    case "thread_summary":
      return 0;
    case "memory_note":
      return 1;
    case "imported_memory":
      return 2;
    case "chronicle":
      return 3;
  }
};

const normalizeSourceKey = (value: string): string => {
  const normalized = value.normalize("NFC").trim();
  if (
    !normalized ||
    normalized.length > DREAM_SOURCE_KEY_MAX_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new ConvexError("Invalid Dream source key.");
  }
  return normalized;
};

const normalizeTitle = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length > DREAM_TITLE_MAX_CHARS) {
    throw new ConvexError("Dream input title is too long.");
  }
  return normalized;
};

const toPrivateEntry = (row: Doc<"cloud_dream_inbox">) => ({
  inboxId: row.inboxId,
  memoryEpoch: row.memoryEpoch ?? LEGACY_MEMORY_EPOCH,
  kind: row.kind,
  sourceKey: row.sourceKey,
  sourceRevision: row.sourceRevision,
  ...(row.title ? { title: row.title } : {}),
  r2Key: row.r2Key,
  sha256: row.sha256,
  sizeBytes: row.sizeBytes,
  priority: row.priority,
  usageCount: row.usageCount,
  ...(row.lastUsageAt ? { lastUsageAt: row.lastUsageAt } : {}),
  updatedAt: row.updatedAt,
});

const clampAutomaticDreamText = (value: string, maxChars: number): string => {
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  const marker = "\n...[truncated]";
  return `${normalized.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
};

const completedReplyText = (payloadJson: string): string => {
  if (payloadJson.length > AUTOMATIC_DREAM_RESULT_MAX_CHARS * 4) return "";
  try {
    const value = JSON.parse(payloadJson) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const text = (value as Record<string, unknown>).text;
    return typeof text === "string"
      ? clampAutomaticDreamText(text, AUTOMATIC_DREAM_RESULT_MAX_CHARS)
      : "";
  } catch {
    return "";
  }
};

/**
 * Transactional companion to the authoritative completed-event write. There
 * is no post-callback crash window: either the event and this durable dispatch
 * both commit, or neither does. The worker receives deterministic, bounded
 * text only; automatic Dream never starts another model/provider request.
 */
export const enqueueAutomaticDreamForCompletedChat = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    turnId: string;
    prompt: string;
    terminalPayloadJson: string;
    now: number;
  },
): Promise<{ dispatchId: string; inserted: boolean } | null> => {
  const lifecycle = await assertMemoryEpochOpen(
    ctx,
    args.ownerId,
    args.ownerGeneration,
  );
  const preference = await getOwnerMemoryPreference(
    ctx,
    args.ownerId,
    lifecycle.ownerGeneration,
  );
  if (!preference.memoryEnabled) return null;
  const conversation = await ctx.db
    .query("cloud_conversations")
    .withIndex("by_conversationId", (q) =>
      q.eq("conversationId", args.conversationId),
    )
    .unique();
  if (
    !conversation ||
    conversation.ownerId !== args.ownerId ||
    conversation.deletedAt !== undefined
  ) {
    throw new ConvexError("Completed Dream source conversation was missing.");
  }
  const prompt = clampAutomaticDreamText(
    args.prompt,
    AUTOMATIC_DREAM_PROMPT_MAX_CHARS,
  );
  const reply = completedReplyText(args.terminalPayloadJson);
  const summary = [
    prompt ? `User request:\n${prompt}` : "",
    reply
      ? `Stella's completed response:\n${reply}`
      : "Stella completed the turn without a text response.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const payloadJson = JSON.stringify({
    schemaVersion: 1,
    kind: "completed_conversation_turn",
    conversationId: args.conversationId,
    turnId: args.turnId,
    summary,
  });
  if (payloadJson.length > AUTOMATIC_DREAM_PAYLOAD_MAX_CHARS) {
    throw new ConvexError("Automatic Dream payload exceeded its bound.");
  }
  const [identityHash, payloadSha256] = await Promise.all([
    hashSha256Hex(
      `automatic-dream-v1\0${args.conversationId}\0${args.turnId}`,
    ),
    hashSha256Hex(payloadJson),
  ]);
  const dispatchId = `dreamdispatch-${identityHash.slice(0, 40)}`;
  const sourceKey = `conversation:${args.conversationId}:turn:${args.turnId}`;
  const existing = await ctx.db
    .query("cloud_dream_dispatches")
    .withIndex("by_dispatchId", (q) => q.eq("dispatchId", dispatchId))
    .unique();
  if (existing) {
    if (
      existing.ownerId !== args.ownerId ||
      (existing.memoryEpoch ?? LEGACY_MEMORY_EPOCH) !== lifecycle.memoryEpoch ||
      existing.turnId !== args.turnId ||
      existing.conversationId !== args.conversationId ||
      existing.sourceKey !== sourceKey ||
      existing.sourceRevision !== 1 ||
      existing.payloadSha256 !== payloadSha256 ||
      existing.payloadJson !== payloadJson
    ) {
      throw new ConvexError({
        code: "CLOUD_DREAM_DISPATCH_CONFLICT",
        message: "Completed turn Dream identity changed.",
      });
    }
    return { dispatchId, inserted: false };
  }
  const title = clampAutomaticDreamText(conversation.title, 240) || undefined;
  await ctx.db.insert("cloud_dream_dispatches", {
    dispatchId,
    ownerId: args.ownerId,
    ownerGeneration: lifecycle.ownerGeneration,
    memoryEpoch: lifecycle.memoryEpoch,
    conversationId: args.conversationId,
    turnId: args.turnId,
    sourceKey,
    sourceRevision: 1,
    ...(title ? { title } : {}),
    payloadJson,
    payloadSha256,
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: args.now,
    createdAt: args.now,
    updatedAt: args.now,
  });
  await ctx.scheduler.runAfter(0, automaticDreamActionRef, {
    dispatchId,
    ownerId: args.ownerId,
    ownerGeneration: lifecycle.ownerGeneration,
    memoryEpoch: lifecycle.memoryEpoch,
  });
  return { dispatchId, inserted: true };
};

/**
 * Publish metadata only after the worker has written and HEAD-verified the
 * exact immutable R2 input object. Source revisions make repeated completion
 * events idempotent and ensure an update that lands during a Dream pass stays
 * pending for the next pass.
 */
export const recordInboxObjectInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    memoryEpoch: v.string(),
    kind: cloudDreamInboxKindValidator,
    sourceKey: v.string(),
    sourceRevision: v.number(),
    title: v.optional(v.string()),
    r2Key: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
    now: v.number(),
  },
  returns: inboxPrivateValidator,
  handler: async (ctx, args) => {
    const lifecycle = await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
      args.memoryEpoch,
    );
    await assertOwnerMemoryRuntimeEnabled(
      ctx,
      args.ownerId,
      lifecycle.ownerGeneration,
    );
    const sourceKey = normalizeSourceKey(args.sourceKey);
    const title = normalizeTitle(args.title);
    if (!Number.isSafeInteger(args.sourceRevision) || args.sourceRevision < 1) {
      throw new ConvexError("Dream sourceRevision must be a positive integer.");
    }
    const sha256 = assertSha256(args.sha256);
    const sizeBytes = assertCloudHomeSize(
      args.sizeBytes,
      DREAM_INPUT_MAX_BYTES,
    );
    const inboxId = await dreamInboxId(args.ownerId, sourceKey);
    const expectedKey = await dreamInboxR2Key({
      ownerId: args.ownerId,
      ownerGeneration: lifecycle.ownerGeneration,
      inboxId,
      sourceRevision: args.sourceRevision,
      sha256,
    });
    if (args.r2Key !== expectedKey) {
      throw new ConvexError("Dream input object key does not match its owner.");
    }
    const existing = await ctx.db
      .query("cloud_dream_inbox")
      .withIndex("by_ownerId_and_sourceKey", (q) =>
        q.eq("ownerId", args.ownerId).eq("sourceKey", sourceKey),
      )
      .unique();
    if (existing) {
      if (
        (existing.memoryEpoch ?? LEGACY_MEMORY_EPOCH) !== lifecycle.memoryEpoch
      ) {
        throw new ConvexError({
          code: "CLOUD_MEMORY_EPOCH_STALE",
          message: "That Dream input belongs to an older memory epoch.",
        });
      }
      if (args.sourceRevision < existing.sourceRevision) {
        throw new ConvexError({
          code: "CLOUD_DREAM_SOURCE_STALE",
          message: "A newer Dream input revision already exists.",
          currentRevision: existing.sourceRevision,
        });
      }
      if (args.sourceRevision === existing.sourceRevision) {
        if (
          existing.kind !== args.kind ||
          existing.r2Key !== args.r2Key ||
          existing.sha256 !== sha256 ||
          existing.sizeBytes !== sizeBytes ||
          existing.title !== title
        ) {
          throw new ConvexError({
            code: "CLOUD_DREAM_SOURCE_CONFLICT",
            message: "That Dream source revision names different input.",
          });
        }
        return toPrivateEntry(existing);
      }
      await ctx.db.patch(existing._id, {
        ownerGeneration: lifecycle.ownerGeneration,
        memoryEpoch: lifecycle.memoryEpoch,
        kind: args.kind,
        sourceRevision: args.sourceRevision,
        ...(title ? { title } : { title: undefined }),
        r2Key: args.r2Key,
        sha256,
        sizeBytes,
        priority: priorityForKind(args.kind),
        claimedByRunId: undefined,
        claimExpiresAt: undefined,
        processedAt: undefined,
        updatedAt: args.now,
      });
      return toPrivateEntry({
        ...existing,
        ownerGeneration: lifecycle.ownerGeneration,
        memoryEpoch: lifecycle.memoryEpoch,
        kind: args.kind,
        sourceRevision: args.sourceRevision,
        ...(title ? { title } : { title: undefined }),
        r2Key: args.r2Key,
        sha256,
        sizeBytes,
        priority: priorityForKind(args.kind),
        claimedByRunId: undefined,
        claimExpiresAt: undefined,
        processedAt: undefined,
        updatedAt: args.now,
      });
    }
    const rowId = await ctx.db.insert("cloud_dream_inbox", {
      inboxId,
      ownerId: args.ownerId,
      ownerGeneration: lifecycle.ownerGeneration,
      memoryEpoch: lifecycle.memoryEpoch,
      kind: args.kind,
      sourceKey,
      sourceRevision: args.sourceRevision,
      ...(title ? { title } : {}),
      r2Key: args.r2Key,
      sha256,
      sizeBytes,
      priority: priorityForKind(args.kind),
      usageCount: 0,
      createdAt: args.now,
      updatedAt: args.now,
    });
    const created = await ctx.db.get(rowId);
    if (!created) throw new ConvexError("Dream input was not recorded.");
    return toPrivateEntry(created);
  },
});

const sortDreamCandidates = (
  rows: Doc<"cloud_dream_inbox">[],
): Doc<"cloud_dream_inbox">[] =>
  rows.sort(
    (a, b) =>
      b.usageCount - a.usageCount ||
      (b.lastUsageAt ?? 0) - (a.lastUsageAt ?? 0) ||
      a.priority - b.priority ||
      a.updatedAt - b.updatedAt ||
      a.inboxId.localeCompare(b.inboxId),
  );

export const claimRunInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    memoryEpoch: v.string(),
    runId: v.string(),
    leaseId: v.string(),
    limit: v.optional(v.number()),
    now: v.number(),
  },
  returns: claimResultValidator,
  handler: async (ctx, args) => {
    const lifecycle = await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
      args.memoryEpoch,
    );
    await assertOwnerMemoryRuntimeEnabled(
      ctx,
      args.ownerId,
      lifecycle.ownerGeneration,
    );
    const runId = assertOpaqueCloudHomeId(args.runId, "Dream run id");
    const leaseId = assertOpaqueCloudHomeId(args.leaseId, "Dream lease id");
    const limit = Math.min(
      DREAM_BATCH_MAX,
      Math.max(1, Math.floor(args.limit ?? DREAM_BATCH_DEFAULT)),
    );
    const replay = await ctx.db
      .query("cloud_dream_runs")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (replay) {
      if (
        replay.ownerId !== args.ownerId ||
        replay.ownerGeneration !== args.ownerGeneration ||
        (replay.memoryEpoch ?? LEGACY_MEMORY_EPOCH) !==
          lifecycle.memoryEpoch ||
        replay.leaseId !== leaseId
      ) {
        throw new ConvexError("Dream run id is already in use.");
      }
      const entries = await ctx.db
        .query("cloud_dream_inbox")
        .withIndex("by_ownerId_and_claimedByRunId", (q) =>
          q.eq("ownerId", args.ownerId).eq("claimedByRunId", runId),
        )
        .take(DREAM_BATCH_MAX + 1);
      return {
        runId,
        memoryEpoch: lifecycle.memoryEpoch,
        status: replay.status,
        leaseId,
        leaseExpiresAt: replay.leaseExpiresAt,
        entries: entries.slice(0, DREAM_BATCH_MAX).map(toPrivateEntry),
      };
    }
    const active = await ctx.db
      .query("cloud_dream_runs")
      .withIndex("by_ownerId_and_status_and_leaseExpiresAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("status", "running")
          .gt("leaseExpiresAt", args.now),
      )
      .take(1);
    if (active.length > 0) {
      throw new ConvexError({
        code: "CLOUD_DREAM_BUSY",
        message: "Another Dream pass is already running.",
      });
    }

    const [unclaimed, expired] = await Promise.all([
      ctx.db
        .query("cloud_dream_inbox")
        .withIndex("by_owner_pending_claim_priority_updated", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("processedAt", undefined)
            .eq("claimExpiresAt", undefined),
        )
        .take(DREAM_BATCH_MAX),
      ctx.db
        .query("cloud_dream_inbox")
        .withIndex("by_owner_pending_claim_priority_updated", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("processedAt", undefined)
            .gt("claimExpiresAt", 0)
            .lte("claimExpiresAt", args.now),
        )
        .take(DREAM_BATCH_MAX),
    ]);
    const candidates = sortDreamCandidates([
      ...new Map(
        [...unclaimed, ...expired].map((row) => [row.inboxId, row]),
      ).values(),
    ])
      .filter(
        (row) =>
          (row.memoryEpoch ?? LEGACY_MEMORY_EPOCH) === lifecycle.memoryEpoch,
      )
      .slice(0, limit);
    const leaseExpiresAt = args.now + CLOUD_DREAM_CLAIM_TTL_MS;
    await ctx.db.insert("cloud_dream_runs", {
      runId,
      ownerId: args.ownerId,
      ownerGeneration: lifecycle.ownerGeneration,
      memoryEpoch: lifecycle.memoryEpoch,
      status: "running",
      leaseId,
      leaseExpiresAt,
      inputCount: candidates.length,
      processedCount: 0,
      createdAt: args.now,
      updatedAt: args.now,
    });
    for (const candidate of candidates) {
      await ctx.db.patch(candidate._id, {
        claimedByRunId: runId,
        claimExpiresAt: leaseExpiresAt,
        updatedAt: args.now,
      });
    }
    return {
      runId,
      memoryEpoch: lifecycle.memoryEpoch,
      status: "running" as const,
      leaseId,
      leaseExpiresAt,
      entries: candidates.map(toPrivateEntry),
    };
  },
});

export const renewRunLeaseInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    memoryEpoch: v.string(),
    runId: v.string(),
    leaseId: v.string(),
    now: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
      args.memoryEpoch,
    );
    await assertOwnerMemoryRuntimeEnabled(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const run = await ctx.db
      .query("cloud_dream_runs")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .unique();
    if (
      !run ||
      run.ownerId !== args.ownerId ||
      run.ownerGeneration !== args.ownerGeneration ||
      (run.memoryEpoch ?? LEGACY_MEMORY_EPOCH) !== args.memoryEpoch ||
      run.leaseId !== args.leaseId ||
      run.status !== "running" ||
      run.leaseExpiresAt < args.now
    ) {
      throw new ConvexError("Dream run lease is stale.");
    }
    const leaseExpiresAt = args.now + CLOUD_DREAM_CLAIM_TTL_MS;
    await ctx.db.patch(run._id, { leaseExpiresAt, updatedAt: args.now });
    const rows = await ctx.db
      .query("cloud_dream_inbox")
      .withIndex("by_ownerId_and_claimedByRunId", (q) =>
        q.eq("ownerId", args.ownerId).eq("claimedByRunId", args.runId),
      )
      .take(DREAM_BATCH_MAX + 1);
    for (const row of rows.slice(0, DREAM_BATCH_MAX)) {
      await ctx.db.patch(row._id, { claimExpiresAt: leaseExpiresAt });
    }
    return leaseExpiresAt;
  },
});

export const completeRunInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    memoryEpoch: v.string(),
    runId: v.string(),
    leaseId: v.string(),
    processed: v.array(
      v.object({ inboxId: v.string(), sourceRevision: v.number() }),
    ),
    memoryVersionId: v.optional(v.string()),
    memoryMapVersionId: v.optional(v.string()),
    archiveVersionIds: v.optional(v.array(v.string())),
    now: v.number(),
  },
  returns: v.object({
    processedCount: v.number(),
    supersededCount: v.number(),
  }),
  handler: async (ctx, args) => {
    await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
      args.memoryEpoch,
    );
    await assertOwnerMemoryRuntimeEnabled(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const run = await ctx.db
      .query("cloud_dream_runs")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .unique();
    if (!run || run.ownerId !== args.ownerId) {
      throw new ConvexError("Dream run not found.");
    }
    if (run.status === "completed") {
      return {
        processedCount: run.processedCount,
        supersededCount: Math.max(0, run.inputCount - run.processedCount),
      };
    }
    if (
      run.status !== "running" ||
      run.ownerGeneration !== args.ownerGeneration ||
      (run.memoryEpoch ?? LEGACY_MEMORY_EPOCH) !== args.memoryEpoch ||
      run.leaseId !== args.leaseId ||
      run.leaseExpiresAt < args.now
    ) {
      throw new ConvexError("Dream run lease is stale.");
    }
    const expected = new Map(
      args.processed.map((entry) => [entry.inboxId, entry.sourceRevision]),
    );
    if (expected.size !== args.processed.length) {
      throw new ConvexError("Dream completion contains duplicate inbox ids.");
    }
    const claimed = await ctx.db
      .query("cloud_dream_inbox")
      .withIndex("by_ownerId_and_claimedByRunId", (q) =>
        q.eq("ownerId", args.ownerId).eq("claimedByRunId", args.runId),
      )
      .take(DREAM_BATCH_MAX + 1);
    let processedCount = 0;
    let supersededCount = 0;
    for (const row of claimed.slice(0, DREAM_BATCH_MAX)) {
      if (expected.get(row.inboxId) === row.sourceRevision) {
        await ctx.db.patch(row._id, {
          processedAt: args.now,
          claimedByRunId: undefined,
          claimExpiresAt: undefined,
          updatedAt: args.now,
        });
        processedCount += 1;
      } else {
        await ctx.db.patch(row._id, {
          claimedByRunId: undefined,
          claimExpiresAt: undefined,
          updatedAt: args.now,
        });
        supersededCount += 1;
      }
    }
    await ctx.db.patch(run._id, {
      status: "completed",
      processedCount,
      ...(args.memoryVersionId
        ? { memoryVersionId: args.memoryVersionId }
        : {}),
      ...(args.memoryMapVersionId
        ? { memoryMapVersionId: args.memoryMapVersionId }
        : {}),
      ...(args.archiveVersionIds
        ? { archiveVersionIds: args.archiveVersionIds.slice(0, 24) }
        : {}),
      updatedAt: args.now,
    });
    return { processedCount, supersededCount };
  },
});

export const failRunInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    memoryEpoch: v.string(),
    runId: v.string(),
    leaseId: v.string(),
    errorMessage: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
      args.memoryEpoch,
    );
    const run = await ctx.db
      .query("cloud_dream_runs")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .unique();
    if (!run || run.ownerId !== args.ownerId) return null;
    if (run.status !== "running") return null;
    if (
      run.ownerGeneration !== args.ownerGeneration ||
      (run.memoryEpoch ?? LEGACY_MEMORY_EPOCH) !== args.memoryEpoch ||
      run.leaseId !== args.leaseId
    ) {
      throw new ConvexError("Dream run lease is stale.");
    }
    const claimed = await ctx.db
      .query("cloud_dream_inbox")
      .withIndex("by_ownerId_and_claimedByRunId", (q) =>
        q.eq("ownerId", args.ownerId).eq("claimedByRunId", args.runId),
      )
      .take(DREAM_BATCH_MAX + 1);
    for (const row of claimed.slice(0, DREAM_BATCH_MAX)) {
      await ctx.db.patch(row._id, {
        claimedByRunId: undefined,
        claimExpiresAt: undefined,
        updatedAt: args.now,
      });
    }
    await ctx.db.patch(run._id, {
      status: "failed",
      errorMessage: args.errorMessage.slice(0, DREAM_ERROR_MAX_CHARS),
      updatedAt: args.now,
    });
    return null;
  },
});

export const recordUsageInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    memoryEpoch: v.string(),
    inboxId: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
      args.memoryEpoch,
    );
    await assertOwnerMemoryRuntimeEnabled(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const row = await ctx.db
      .query("cloud_dream_inbox")
      .withIndex("by_inboxId", (q) => q.eq("inboxId", args.inboxId))
      .unique();
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      (row.memoryEpoch ?? LEGACY_MEMORY_EPOCH) !== args.memoryEpoch
    ) {
      return null;
    }
    await ctx.db.patch(row._id, {
      usageCount: row.usageCount + 1,
      lastUsageAt: args.now,
      processedAt: undefined,
      updatedAt: args.now,
    });
    return null;
  },
});

const automaticDreamIdentityArgs = {
  dispatchId: v.string(),
  ownerId: v.string(),
  ownerGeneration: v.string(),
  memoryEpoch: v.string(),
} as const;

const readAutomaticDreamDispatch = async (
  ctx: MutationCtx,
  args: AutomaticDreamDispatchIdentity,
): Promise<Doc<"cloud_dream_dispatches"> | null> => {
  const row = await ctx.db
    .query("cloud_dream_dispatches")
    .withIndex("by_dispatchId", (q) => q.eq("dispatchId", args.dispatchId))
    .unique();
  if (
    !row ||
    row.ownerId !== args.ownerId ||
    row.ownerGeneration !== args.ownerGeneration ||
    (row.memoryEpoch ?? LEGACY_MEMORY_EPOCH) !== args.memoryEpoch
  ) {
    return null;
  }
  return row;
};

export const claimAutomaticDreamDispatchInternal = internalMutation({
  args: { ...automaticDreamIdentityArgs, now: v.number() },
  returns: automaticDreamClaimValidator,
  handler: async (ctx, args): Promise<AutomaticDreamClaim | null> => {
    const lifecycle = await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
      args.memoryEpoch,
    );
    const row = await readAutomaticDreamDispatch(ctx, args);
    if (!row || row.status === "completed" || row.status === "abandoned") {
      return null;
    }
    const preference = await getOwnerMemoryPreference(
      ctx,
      args.ownerId,
      lifecycle.ownerGeneration,
    );
    if (!preference.memoryEnabled) {
      await ctx.db.patch(row._id, {
        status: "abandoned",
        nextAttemptAt: args.now,
        leaseId: undefined,
        leaseExpiresAt: undefined,
        lastErrorCode: "CLOUD_MEMORY_DISABLED",
        completedAt: args.now,
        updatedAt: args.now,
      });
      return null;
    }
    if (
      (row.status === "pending" || row.status === "retry_wait") &&
      row.nextAttemptAt > args.now
    ) {
      return null;
    }
    if (
      row.status === "running" &&
      (row.leaseExpiresAt ?? Number.POSITIVE_INFINITY) > args.now
    ) {
      return null;
    }
    const leaseId = `dreamdispatchlease-${crypto.randomUUID()}`;
    const leaseExpiresAt = args.now + AUTOMATIC_DREAM_DISPATCH_LEASE_MS;
    const attemptCount = row.attemptCount + 1;
    await ctx.db.patch(row._id, {
      status: "running",
      attemptCount,
      leaseId,
      leaseExpiresAt,
      lastErrorCode: undefined,
      updatedAt: args.now,
    });
    return {
      dispatchId: row.dispatchId,
      ownerId: row.ownerId,
      ownerGeneration: row.ownerGeneration,
      memoryEpoch: row.memoryEpoch ?? LEGACY_MEMORY_EPOCH,
      conversationId: row.conversationId,
      turnId: row.turnId,
      sourceKey: row.sourceKey,
      sourceRevision: row.sourceRevision,
      ...(row.title ? { title: row.title } : {}),
      payloadJson: row.payloadJson,
      payloadSha256: row.payloadSha256,
      attemptCount,
      leaseId,
      leaseExpiresAt,
    };
  },
});

/** Last transaction-plane check before either external Worker request. */
export const assertAutomaticDreamDispatchAllowedInternal = internalMutation({
  args: {
    ...automaticDreamIdentityArgs,
    leaseId: v.string(),
    now: v.number(),
    inboxId: v.optional(v.string()),
    runId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lifecycle = await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
      args.memoryEpoch,
    );
    const row = await readAutomaticDreamDispatch(ctx, args);
    if (
      !row ||
      row.status !== "running" ||
      row.leaseId !== args.leaseId ||
      (row.leaseExpiresAt ?? 0) < args.now
    ) {
      throw new ConvexError("Automatic Dream dispatch lease is stale.");
    }
    const preference = await getOwnerMemoryPreference(
      ctx,
      args.ownerId,
      lifecycle.ownerGeneration,
    );
    if (!preference.memoryEnabled) {
      await ctx.db.patch(row._id, {
        status: "abandoned",
        nextAttemptAt: args.now,
        leaseId: undefined,
        leaseExpiresAt: undefined,
        lastErrorCode: "CLOUD_MEMORY_DISABLED",
        completedAt: args.now,
        updatedAt: args.now,
      });
      throw new ConvexError({
        code: "CLOUD_MEMORY_DISABLED",
        message: "Cloud memory is disabled for this account.",
      });
    }
    const inboxId = args.inboxId
      ? assertOpaqueCloudHomeId(args.inboxId, "Dream inbox id")
      : undefined;
    const runId = args.runId
      ? assertOpaqueCloudHomeId(args.runId, "Dream run id")
      : undefined;
    await ctx.db.patch(row._id, {
      ...(inboxId ? { inboxId } : {}),
      ...(runId ? { runId } : {}),
      leaseExpiresAt: args.now + AUTOMATIC_DREAM_DISPATCH_LEASE_MS,
      updatedAt: args.now,
    });
    return null;
  },
});

export const completeAutomaticDreamDispatchInternal = internalMutation({
  args: {
    ...automaticDreamIdentityArgs,
    leaseId: v.string(),
    inboxId: v.string(),
    runId: v.string(),
    processedCount: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lifecycle = await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
      args.memoryEpoch,
    );
    const row = await readAutomaticDreamDispatch(ctx, args);
    if (!row) return null;
    if (row.status === "completed") return null;
    if (
      row.status !== "running" ||
      row.leaseId !== args.leaseId ||
      (row.leaseExpiresAt ?? 0) < args.now
    ) {
      throw new ConvexError("Automatic Dream dispatch lease is stale.");
    }
    const preference = await getOwnerMemoryPreference(
      ctx,
      args.ownerId,
      lifecycle.ownerGeneration,
    );
    if (!preference.memoryEnabled) {
      await ctx.db.patch(row._id, {
        status: "abandoned",
        nextAttemptAt: args.now,
        leaseId: undefined,
        leaseExpiresAt: undefined,
        lastErrorCode: "CLOUD_MEMORY_DISABLED",
        completedAt: args.now,
        updatedAt: args.now,
      });
      return null;
    }
    const inboxId = assertOpaqueCloudHomeId(args.inboxId, "Dream inbox id");
    const runId = assertOpaqueCloudHomeId(args.runId, "Dream run id");
    if (!Number.isSafeInteger(args.processedCount) || args.processedCount < 0) {
      throw new ConvexError("Automatic Dream processed count was invalid.");
    }
    await ctx.db.patch(row._id, {
      status: "completed",
      inboxId,
      runId,
      processedCount: args.processedCount,
      nextAttemptAt: args.now,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      lastErrorCode: undefined,
      completedAt: args.now,
      updatedAt: args.now,
    });
    return null;
  },
});

const automaticDreamRetryDelay = (attemptCount: number): number =>
  Math.min(
    AUTOMATIC_DREAM_RETRY_MAX_MS,
    30_000 * 2 ** Math.max(0, Math.min(attemptCount - 1, 10)),
  );

export const retryAutomaticDreamDispatchInternal = internalMutation({
  args: {
    ...automaticDreamIdentityArgs,
    leaseId: v.string(),
    errorCode: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertMemoryEpochOpen(
      ctx,
      args.ownerId,
      args.ownerGeneration,
      args.memoryEpoch,
    );
    const row = await readAutomaticDreamDispatch(ctx, args);
    if (
      !row ||
      row.status !== "running" ||
      row.leaseId !== args.leaseId
    ) {
      return null;
    }
    const errorCode = args.errorCode.trim().slice(0, 80) || "UNEXPECTED";
    if (!/^[A-Z0-9_:-]+$/u.test(errorCode)) {
      throw new ConvexError("Automatic Dream error code was invalid.");
    }
    const abandoned = row.attemptCount >= AUTOMATIC_DREAM_MAX_ATTEMPTS;
    const retryAt = abandoned
      ? args.now
      : args.now + automaticDreamRetryDelay(row.attemptCount);
    await ctx.db.patch(row._id, {
      status: abandoned ? "abandoned" : "retry_wait",
      nextAttemptAt: retryAt,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      lastErrorCode: errorCode,
      updatedAt: args.now,
    });
    if (!abandoned) {
      await ctx.scheduler.runAfter(
        Math.max(0, retryAt - args.now),
        automaticDreamActionRef,
        {
          dispatchId: row.dispatchId,
          ownerId: row.ownerId,
          ownerGeneration: row.ownerGeneration,
          memoryEpoch: row.memoryEpoch ?? LEGACY_MEMORY_EPOCH,
        },
      );
    }
    return null;
  },
});

class AutomaticDreamWorkerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AutomaticDreamWorkerError";
  }
}

const automaticDreamWorkerEndpoint = (): { url: string; secret: string } => {
  const url = process.env.CLOUD_BUILDER_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  if (!url || !secret) {
    throw new AutomaticDreamWorkerError("WORKER_NOT_CONFIGURED");
  }
  return { url, secret };
};

const postAutomaticDreamWorker = async (
  endpoint: { url: string; secret: string },
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await fetch(`${endpoint.url}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    });
  } catch {
    throw new AutomaticDreamWorkerError("WORKER_UNAVAILABLE");
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new AutomaticDreamWorkerError(`WORKER_HTTP_${response.status}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AutomaticDreamWorkerError("WORKER_INVALID_RESPONSE");
  }
  return payload as Record<string, unknown>;
};

const automaticDreamFailureCode = (error: unknown): string =>
  error instanceof AutomaticDreamWorkerError ? error.code : "UNEXPECTED";

/**
 * Durable, deterministic automatic Dream pass. It never calls a model: the
 * accepted terminal event already contains the bounded source text. Every R2
 * operation happens inside the Worker's existing owner activity lease.
 */
export const runAutomaticDreamDispatchInternal = internalAction({
  args: automaticDreamIdentityArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = await ctx.runMutation(automaticDreamClaimRef, {
      ...args,
      now: Date.now(),
    });
    if (!claim) return null;
    try {
      if ((await hashSha256Hex(claim.payloadJson)) !== claim.payloadSha256) {
        throw new AutomaticDreamWorkerError("PAYLOAD_INTEGRITY_FAILED");
      }
      const payload = JSON.parse(claim.payloadJson) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new AutomaticDreamWorkerError("PAYLOAD_INVALID");
      }
      const endpoint = automaticDreamWorkerEndpoint();
      await ctx.runMutation(automaticDreamFenceRef, {
        ...args,
        leaseId: claim.leaseId,
        now: Date.now(),
      });
      const enqueued = await postAutomaticDreamWorker(
        endpoint,
        "/internal/cloud-home/dream/enqueue",
        {
          ownerId: claim.ownerId,
          ownerGeneration: claim.ownerGeneration,
          memoryEpoch: claim.memoryEpoch,
          kind: "thread_summary",
          sourceKey: claim.sourceKey,
          sourceRevision: claim.sourceRevision,
          ...(claim.title ? { title: claim.title } : {}),
          payload,
        },
      );
      const inboxId =
        typeof enqueued.inboxId === "string" ? enqueued.inboxId.trim() : "";
      if (!inboxId) {
        throw new AutomaticDreamWorkerError("ENQUEUE_INVALID_RESPONSE");
      }
      const runSuffix = `${claim.dispatchId.replace(/^dreamdispatch-/u, "")}-${claim.attemptCount}`;
      const runId = `dreamauto-${runSuffix}`;
      const runLeaseId = `dreamautolease-${runSuffix}`;
      await ctx.runMutation(automaticDreamFenceRef, {
        ...args,
        leaseId: claim.leaseId,
        now: Date.now(),
        inboxId,
        runId,
      });
      const result = await postAutomaticDreamWorker(
        endpoint,
        "/internal/cloud-home/dream/run",
        {
          ownerId: claim.ownerId,
          ownerGeneration: claim.ownerGeneration,
          memoryEpoch: claim.memoryEpoch,
          runId,
          leaseId: runLeaseId,
          limit: 24,
        },
      );
      const processedCount = result.processedCount;
      if (!Number.isSafeInteger(processedCount) || Number(processedCount) < 0) {
        throw new AutomaticDreamWorkerError("RUN_INVALID_RESPONSE");
      }
      await ctx.runMutation(automaticDreamCompleteRef, {
        ...args,
        leaseId: claim.leaseId,
        inboxId,
        runId,
        processedCount: Number(processedCount),
        now: Date.now(),
      });
    } catch (error) {
      await ctx
        .runMutation(automaticDreamRetryRef, {
          ...args,
          leaseId: claim.leaseId,
          errorCode: automaticDreamFailureCode(error),
          now: Date.now(),
        })
        .catch(() => undefined);
    }
    return null;
  },
});

/** Cron recovery for lost action responses, isolate restarts and stale leases. */
export const sweepAutomaticDreamDispatchesInternal = internalMutation({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const limit = Math.min(
      AUTOMATIC_DREAM_SWEEP_LIMIT,
      Math.max(1, Math.floor(args.limit ?? AUTOMATIC_DREAM_SWEEP_LIMIT)),
    );
    const [pending, retrying, stale] = await Promise.all([
      ctx.db
        .query("cloud_dream_dispatches")
        .withIndex("by_status_and_nextAttemptAt", (q) =>
          q.eq("status", "pending").lte("nextAttemptAt", now),
        )
        .take(limit),
      ctx.db
        .query("cloud_dream_dispatches")
        .withIndex("by_status_and_nextAttemptAt", (q) =>
          q.eq("status", "retry_wait").lte("nextAttemptAt", now),
        )
        .take(limit),
      ctx.db
        .query("cloud_dream_dispatches")
        .withIndex("by_status_and_leaseExpiresAt", (q) =>
          q.eq("status", "running").lte("leaseExpiresAt", now),
        )
        .take(limit),
    ]);
    const rows = [
      ...new Map(
        [...pending, ...retrying, ...stale].map((row) => [
          row.dispatchId,
          row,
        ]),
      ).values(),
    ].slice(0, limit);
    await Promise.all(
      rows.map((row) =>
        ctx.scheduler.runAfter(0, automaticDreamActionRef, {
          dispatchId: row.dispatchId,
          ownerId: row.ownerId,
          ownerGeneration: row.ownerGeneration,
          memoryEpoch: row.memoryEpoch ?? LEGACY_MEMORY_EPOCH,
        }),
      ),
    );
    return { scheduled: rows.length };
  },
});

export const getPendingStateInternal = internalQuery({
  args: { ownerId: v.string(), ownerGeneration: v.string() },
  returns: v.object({ hasPending: v.boolean(), newestUpdatedAt: v.number() }),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const rows = await ctx.db
      .query("cloud_dream_inbox")
      .withIndex("by_ownerId_and_processedAt_and_priority_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("processedAt", undefined),
      )
      .order("desc")
      .take(1);
    return {
      hasPending: rows.length > 0,
      newestUpdatedAt: rows[0]?.updatedAt ?? 0,
    };
  },
});

/** Safe account-settings status: no queue payloads or object locators. */
export const getMyDreamStatus = query({
  args: {},
  returns: v.object({
    hasPending: v.boolean(),
    lastRunStatus: v.optional(cloudDreamRunStatusValidator),
    lastRunAt: v.optional(v.number()),
    automaticPending: v.boolean(),
    lastAutomaticStatus: v.optional(cloudDreamDispatchStatusValidator),
    lastAutomaticAt: v.optional(v.number()),
    lastAutomaticAttemptCount: v.optional(v.number()),
    lastAutomaticErrorCode: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    const [pending, runs, ...dispatchesByStatus] = await Promise.all([
      ctx.db
        .query("cloud_dream_inbox")
        .withIndex(
          "by_ownerId_and_processedAt_and_priority_and_updatedAt",
          (q) => q.eq("ownerId", ownerId).eq("processedAt", undefined),
        )
        .take(1),
      ctx.db
        .query("cloud_dream_runs")
        .withIndex("by_ownerId_and_status_and_leaseExpiresAt", (q) =>
          q.eq("ownerId", ownerId),
        )
        .order("desc")
        .take(20),
      ...(
        [
          "pending",
          "running",
          "retry_wait",
          "completed",
          "abandoned",
        ] as const
      ).map((status) =>
        ctx.db
          .query("cloud_dream_dispatches")
          .withIndex("by_ownerId_and_status_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId).eq("status", status),
          )
          .order("desc")
          .take(1),
      ),
    ]);
    const latest = runs.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const latestAutomatic = dispatchesByStatus
      .flat()
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const automaticPending = dispatchesByStatus
      .slice(0, 3)
      .some((rows) => rows.length > 0);
    return {
      hasPending: pending.length > 0,
      ...(latest
        ? { lastRunStatus: latest.status, lastRunAt: latest.updatedAt }
        : {}),
      automaticPending,
      ...(latestAutomatic
        ? {
            lastAutomaticStatus: latestAutomatic.status,
            lastAutomaticAt: latestAutomatic.updatedAt,
            lastAutomaticAttemptCount: latestAutomatic.attemptCount,
            ...(latestAutomatic.lastErrorCode
              ? { lastAutomaticErrorCode: latestAutomatic.lastErrorCode }
              : {}),
          }
        : {}),
    };
  },
});
