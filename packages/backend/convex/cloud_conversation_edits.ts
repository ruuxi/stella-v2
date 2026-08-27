import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  type ActionCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { assertOwnerMigrationWriteAllowed, requireUserId } from "./auth";
import { hashSha256Hex } from "./lib/crypto_utils";
import { cloudExecutionSelectionValidator } from "./lib/cloud_execution";
import {
  assertOwnerDataAccessActive,
  assertOwnerPurgeOperation,
} from "./owner_lifecycle";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_EDIT_PASSES = 32;
const EXCERPT_DELETE_BATCH = 200;

const editKindValidator = v.union(v.literal("fork"), v.literal("rewind"));
const editStateValidator = v.union(
  v.literal("preparing"),
  v.literal("projecting"),
  v.literal("complete"),
  v.literal("failed"),
  v.literal("canceled"),
);
const activeTurnPolicyValidator = v.union(
  v.literal("conflict"),
  v.literal("cancel"),
);

const operationValidator = v.object({
  operationId: v.string(),
  ownerId: v.string(),
  ownerGeneration: v.string(),
  requestId: v.string(),
  fingerprint: v.string(),
  kind: editKindValidator,
  state: editStateValidator,
  sourceConversationId: v.string(),
  targetConversationId: v.optional(v.string()),
  throughSeq: v.number(),
  expectedEpoch: v.number(),
  expectedLastSeq: v.number(),
  activeTurnPolicy: v.optional(activeTurnPolicyValidator),
  title: v.optional(v.string()),
  sourceCreatedAt: v.optional(v.number()),
  targetCreatedAt: v.optional(v.number()),
  execution: v.optional(cloudExecutionSelectionValidator),
  sourceEpoch: v.optional(v.number()),
  previousEpoch: v.optional(v.number()),
  nextEpoch: v.optional(v.number()),
  resultLastSeq: v.optional(v.number()),
  lastPreview: v.optional(v.string()),
  lastRole: v.optional(v.string()),
  completedAt: v.optional(v.number()),
  projectionComplete: v.optional(v.boolean()),
  lastError: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

type OperationView = Omit<
  Doc<"cloud_conversation_edits">,
  "_id" | "_creationTime"
>;

type ForkWorkerResult = {
  complete: boolean;
  kind: "fork";
  operationId: string;
  sourceConversationId: string;
  targetConversationId: string;
  sourceEpoch: number;
  throughSeq: number;
  targetEpoch: number;
  lastSeq: number;
  lastPreview?: string;
  lastRole?: string;
  pendingAtSeq?: number;
};

type RewindWorkerResult = {
  complete: boolean;
  kind: "rewind";
  operationId: string;
  conversationId: string;
  previousEpoch: number;
  nextEpoch: number;
  lastSeq: number;
  lastPreview?: string;
  lastRole?: string;
  cancelRequested?: boolean;
};

type WorkerResult = ForkWorkerResult | RewindWorkerResult;

type ForkClientResult = {
  conversationId: string;
  sourceEpoch: number;
  throughSeq: number;
  targetEpoch: number;
  lastSeq: number;
  replayed: boolean;
};

type RewindClientResult = {
  conversationId: string;
  previousEpoch: number;
  nextEpoch: number;
  lastSeq: number;
  replayed: boolean;
};

const forkClientResultValidator = v.object({
  conversationId: v.string(),
  sourceEpoch: v.number(),
  throughSeq: v.number(),
  targetEpoch: v.number(),
  lastSeq: v.number(),
  replayed: v.boolean(),
});

const rewindClientResultValidator = v.object({
  conversationId: v.string(),
  previousEpoch: v.number(),
  nextEpoch: v.number(),
  lastSeq: v.number(),
  replayed: v.boolean(),
});

const invalidArgument = (message: string): never => {
  throw new ConvexError({ code: "INVALID_ARGUMENT", message });
};

const conflict = (message: string): never => {
  throw new ConvexError({ code: "CONFLICT", message });
};

const notFound = (): never => {
  // Deliberately identical for absent and cross-owner rows.
  throw new ConvexError({
    code: "NOT_FOUND",
    message: "Conversation not found.",
  });
};

const validateBoundary = (
  throughSeq: number,
  expectedEpoch: number,
  expectedLastSeq: number,
): void => {
  if (
    !Number.isSafeInteger(throughSeq) ||
    throughSeq < -1 ||
    !Number.isSafeInteger(expectedEpoch) ||
    expectedEpoch < 1 ||
    !Number.isSafeInteger(expectedLastSeq) ||
    expectedLastSeq < -1 ||
    throughSeq > expectedLastSeq
  ) {
    invalidArgument("Invalid conversation edit boundary.");
  }
};

const normalizeRequestId = (value: string): string => {
  const requestId = value.trim();
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    invalidArgument("requestId must be an opaque 8-128 character id.");
  }
  return requestId;
};

const operationView = (row: Doc<"cloud_conversation_edits">): OperationView => {
  const { _id: _discardId, _creationTime: _discardCreationTime, ...view } = row;
  return view;
};

const requireConversationOwner = async (
  ctx: Parameters<typeof assertOwnerMigrationWriteAllowed>[0],
  conversationId: string,
  ownerId: string,
): Promise<Doc<"cloud_conversations">> => {
  const row = await ctx.db
    .query("cloud_conversations")
    .withIndex("by_conversationId", (q) =>
      q.eq("conversationId", conversationId),
    )
    .unique();
  if (!row || row.ownerId !== ownerId || row.deletedAt !== undefined) {
    return notFound();
  }
  return row;
};

const readOperationByRequest = async (
  ctx: Parameters<typeof assertOwnerMigrationWriteAllowed>[0],
  ownerId: string,
  requestId: string,
) =>
  await ctx.db
    .query("cloud_conversation_edits")
    .withIndex("by_ownerId_and_requestId", (q) =>
      q.eq("ownerId", ownerId).eq("requestId", requestId),
    )
    .unique();

const readOperationById = async (
  ctx: Parameters<typeof assertOwnerMigrationWriteAllowed>[0],
  operationId: string,
) =>
  await ctx.db
    .query("cloud_conversation_edits")
    .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
    .unique();

const ensureReplayMatches = (
  row: Doc<"cloud_conversation_edits">,
  ownerGeneration: string,
  fingerprint: string,
): void => {
  if (row.ownerGeneration !== ownerGeneration) {
    conflict("This edit belongs to an earlier account-data generation.");
  }
  if (row.fingerprint !== fingerprint) {
    conflict("requestId was already used for a different conversation edit.");
  }
  if (row.state === "failed" || row.state === "canceled") {
    conflict(row.lastError || "This conversation edit cannot be resumed.");
  }
};

export const reserveForkInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    requestId: v.string(),
    fingerprint: v.string(),
    sourceConversationId: v.string(),
    throughSeq: v.number(),
    expectedEpoch: v.number(),
    expectedLastSeq: v.number(),
    now: v.number(),
  },
  returns: operationValidator,
  handler: async (ctx, args): Promise<OperationView> => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const existing = await readOperationByRequest(
      ctx,
      args.ownerId,
      args.requestId,
    );
    if (existing) {
      ensureReplayMatches(existing, args.ownerGeneration, args.fingerprint);
      return operationView(existing);
    }
    const source = await requireConversationOwner(
      ctx,
      args.sourceConversationId,
      args.ownerId,
    );
    const operationId = crypto.randomUUID();
    const targetConversationId = crypto.randomUUID();
    const row: OperationView = {
      operationId,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      requestId: args.requestId,
      fingerprint: args.fingerprint,
      kind: "fork",
      state: "preparing",
      sourceConversationId: args.sourceConversationId,
      targetConversationId,
      throughSeq: args.throughSeq,
      expectedEpoch: args.expectedEpoch,
      expectedLastSeq: args.expectedLastSeq,
      title: (source.title.trim() || "Conversation").slice(0, 256),
      sourceCreatedAt: source.createdAt,
      targetCreatedAt: args.now,
      ...(source.execution ? { execution: source.execution } : {}),
      createdAt: args.now,
      updatedAt: args.now,
    };
    await ctx.db.insert("cloud_conversation_edits", row);
    return row;
  },
});

export const reserveRewindInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    requestId: v.string(),
    fingerprint: v.string(),
    conversationId: v.string(),
    throughSeq: v.number(),
    expectedEpoch: v.number(),
    expectedLastSeq: v.number(),
    activeTurnPolicy: activeTurnPolicyValidator,
    now: v.number(),
  },
  returns: operationValidator,
  handler: async (ctx, args): Promise<OperationView> => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const existing = await readOperationByRequest(
      ctx,
      args.ownerId,
      args.requestId,
    );
    if (existing) {
      ensureReplayMatches(existing, args.ownerGeneration, args.fingerprint);
      return operationView(existing);
    }
    await requireConversationOwner(ctx, args.conversationId, args.ownerId);
    const row: OperationView = {
      operationId: crypto.randomUUID(),
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      requestId: args.requestId,
      fingerprint: args.fingerprint,
      kind: "rewind",
      state: "preparing",
      sourceConversationId: args.conversationId,
      throughSeq: args.throughSeq,
      expectedEpoch: args.expectedEpoch,
      expectedLastSeq: args.expectedLastSeq,
      activeTurnPolicy: args.activeTurnPolicy,
      createdAt: args.now,
      updatedAt: args.now,
    };
    await ctx.db.insert("cloud_conversation_edits", row);
    return row;
  },
});

export const assertEditDispatchAllowedInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    operationId: v.string(),
  },
  returns: operationValidator,
  handler: async (ctx, args): Promise<OperationView> => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const row = await readOperationById(ctx, args.operationId);
    if (!row || row.ownerId !== args.ownerId) return notFound();
    if (row.ownerGeneration !== args.ownerGeneration) {
      conflict("This edit belongs to an earlier account-data generation.");
    }
    if (row.state === "failed" || row.state === "canceled") {
      conflict(row.lastError || "This conversation edit cannot continue.");
    }
    await requireConversationOwner(ctx, row.sourceConversationId, args.ownerId);
    return operationView(row);
  },
});

const forkWorkerResultValidator = v.object({
  complete: v.boolean(),
  kind: v.literal("fork"),
  operationId: v.string(),
  sourceConversationId: v.string(),
  targetConversationId: v.string(),
  sourceEpoch: v.number(),
  throughSeq: v.number(),
  targetEpoch: v.number(),
  lastSeq: v.number(),
  lastPreview: v.optional(v.string()),
  lastRole: v.optional(v.string()),
  pendingAtSeq: v.optional(v.number()),
});

const rewindWorkerResultValidator = v.object({
  complete: v.boolean(),
  kind: v.literal("rewind"),
  operationId: v.string(),
  conversationId: v.string(),
  previousEpoch: v.number(),
  nextEpoch: v.number(),
  lastSeq: v.number(),
  lastPreview: v.optional(v.string()),
  lastRole: v.optional(v.string()),
  cancelRequested: v.optional(v.boolean()),
});

export const commitForkInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    operationId: v.string(),
    result: forkWorkerResultValidator,
    now: v.number(),
  },
  returns: forkClientResultValidator,
  handler: async (ctx, args): Promise<ForkClientResult> => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const operation = await readOperationById(ctx, args.operationId);
    if (
      !operation ||
      operation.ownerId !== args.ownerId ||
      operation.kind !== "fork"
    ) {
      return notFound();
    }
    if (operation.ownerGeneration !== args.ownerGeneration) {
      conflict("This edit belongs to an earlier account-data generation.");
    }
    if (
      !args.result.complete ||
      args.result.operationId !== operation.operationId ||
      args.result.sourceConversationId !== operation.sourceConversationId ||
      args.result.targetConversationId !== operation.targetConversationId ||
      args.result.sourceEpoch !== operation.expectedEpoch ||
      args.result.throughSeq !== operation.throughSeq ||
      args.result.targetEpoch !== 1 ||
      args.result.lastSeq !== operation.throughSeq
    ) {
      conflict("Fork completion does not match its durable reservation.");
    }
    if (operation.state === "complete") {
      return {
        conversationId: operation.targetConversationId!,
        sourceEpoch: operation.sourceEpoch!,
        throughSeq: operation.throughSeq,
        targetEpoch: operation.nextEpoch!,
        lastSeq: operation.resultLastSeq!,
        replayed: true,
      };
    }
    const source = await requireConversationOwner(
      ctx,
      operation.sourceConversationId,
      args.ownerId,
    );
    const targetId = operation.targetConversationId!;
    const target = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", targetId))
      .unique();
    if (
      target &&
      (target.ownerId !== args.ownerId || target.deletedAt !== undefined)
    ) {
      conflict("Fork target identity is already in use.");
    }
    const createdAt = operation.targetCreatedAt ?? operation.createdAt;
    const published = {
      title: operation.title ?? source.title,
      updatedAt: args.now,
      lastSeq: args.result.lastSeq,
      epoch: args.result.targetEpoch,
      activity: "idle",
      allowEmpty: args.result.lastSeq < 0 ? true : undefined,
      lastPreview: args.result.lastPreview,
      lastRole: args.result.lastRole,
    };
    if (target) {
      await ctx.db.patch(target._id, published);
    } else {
      await ctx.db.insert("cloud_conversations", {
        conversationId: targetId,
        ownerId: args.ownerId,
        title: published.title,
        createdAt,
        updatedAt: published.updatedAt,
        lastSeq: published.lastSeq,
        epoch: published.epoch,
        activity: published.activity,
        ...(published.allowEmpty ? { allowEmpty: true } : {}),
        ...(operation.execution ? { execution: operation.execution } : {}),
        ...(published.lastPreview
          ? { lastPreview: published.lastPreview }
          : {}),
        ...(published.lastRole ? { lastRole: published.lastRole } : {}),
      });
    }
    await ctx.db.patch(operation._id, {
      state: "complete",
      sourceEpoch: args.result.sourceEpoch,
      nextEpoch: args.result.targetEpoch,
      resultLastSeq: args.result.lastSeq,
      lastPreview: args.result.lastPreview,
      lastRole: args.result.lastRole,
      projectionComplete: true,
      completedAt: args.now,
      updatedAt: args.now,
    });
    return {
      conversationId: targetId,
      sourceEpoch: args.result.sourceEpoch,
      throughSeq: operation.throughSeq,
      targetEpoch: args.result.targetEpoch,
      lastSeq: args.result.lastSeq,
      replayed: false,
    };
  },
});

export const commitRewindInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    operationId: v.string(),
    result: rewindWorkerResultValidator,
    now: v.number(),
  },
  returns: rewindClientResultValidator,
  handler: async (ctx, args): Promise<RewindClientResult> => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const operation = await readOperationById(ctx, args.operationId);
    if (
      !operation ||
      operation.ownerId !== args.ownerId ||
      operation.kind !== "rewind"
    ) {
      return notFound();
    }
    if (operation.ownerGeneration !== args.ownerGeneration) {
      conflict("This edit belongs to an earlier account-data generation.");
    }
    if (operation.state === "complete" || operation.state === "projecting") {
      return {
        conversationId: operation.sourceConversationId,
        previousEpoch: operation.previousEpoch!,
        nextEpoch: operation.nextEpoch!,
        lastSeq: operation.resultLastSeq!,
        replayed: true,
      };
    }
    if (
      !args.result.complete ||
      args.result.operationId !== operation.operationId ||
      args.result.conversationId !== operation.sourceConversationId ||
      args.result.previousEpoch !== operation.expectedEpoch ||
      args.result.lastSeq !== operation.throughSeq ||
      args.result.nextEpoch !== operation.expectedEpoch + 1
    ) {
      conflict("Rewind completion does not match its durable reservation.");
    }
    const conversation = await requireConversationOwner(
      ctx,
      operation.sourceConversationId,
      args.ownerId,
    );
    await ctx.db.patch(conversation._id, {
      epoch: args.result.nextEpoch,
      lastSeq: args.result.lastSeq,
      updatedAt: args.now,
      activity: "idle",
      lastPreview: args.result.lastPreview,
      lastRole: args.result.lastRole,
      ...(args.result.lastSeq < 0 ? { allowEmpty: true } : {}),
    });
    await ctx.db.patch(operation._id, {
      state: "projecting",
      previousEpoch: args.result.previousEpoch,
      nextEpoch: args.result.nextEpoch,
      resultLastSeq: args.result.lastSeq,
      lastPreview: args.result.lastPreview,
      lastRole: args.result.lastRole,
      projectionComplete: false,
      completedAt: args.now,
      updatedAt: args.now,
    });
    return {
      conversationId: operation.sourceConversationId,
      previousEpoch: args.result.previousEpoch,
      nextEpoch: args.result.nextEpoch,
      lastSeq: args.result.lastSeq,
      replayed: false,
    };
  },
});

export const cleanupRewindProjectionInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    operationId: v.string(),
  },
  returns: v.object({ complete: v.boolean(), deleted: v.number() }),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const operation = await readOperationById(ctx, args.operationId);
    if (
      !operation ||
      operation.ownerId !== args.ownerId ||
      operation.kind !== "rewind"
    ) {
      return notFound();
    }
    if (operation.ownerGeneration !== args.ownerGeneration) {
      conflict("This edit belongs to an earlier account-data generation.");
    }
    if (operation.state === "complete") return { complete: true, deleted: 0 };
    if (operation.state !== "projecting") {
      conflict("The rewind journal transition has not completed.");
    }
    const rows = await ctx.db
      .query("cloud_message_excerpts")
      .withIndex("by_conversationId_and_ownerId_and_seqStart", (q) =>
        q
          .eq("conversationId", operation.sourceConversationId)
          .eq("ownerId", args.ownerId)
          .gt("seqStart", operation.throughSeq),
      )
      .take(EXCERPT_DELETE_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === EXCERPT_DELETE_BATCH) {
      return { complete: false, deleted: rows.length };
    }
    await ctx.db.patch(operation._id, {
      state: "complete",
      projectionComplete: true,
      updatedAt: Date.now(),
    });
    return { complete: true, deleted: rows.length };
  },
});

const reserveForkRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    requestId: string;
    fingerprint: string;
    sourceConversationId: string;
    throughSeq: number;
    expectedEpoch: number;
    expectedLastSeq: number;
    now: number;
  },
  OperationView
>("cloud_conversation_edits:reserveForkInternal");

const reserveRewindRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    requestId: string;
    fingerprint: string;
    conversationId: string;
    throughSeq: number;
    expectedEpoch: number;
    expectedLastSeq: number;
    activeTurnPolicy: "conflict" | "cancel";
    now: number;
  },
  OperationView
>("cloud_conversation_edits:reserveRewindInternal");

const dispatchFenceRef = makeFunctionReference<
  "mutation",
  { ownerId: string; ownerGeneration: string; operationId: string },
  OperationView
>("cloud_conversation_edits:assertEditDispatchAllowedInternal");

const commitForkRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    result: ForkWorkerResult;
    now: number;
  },
  ForkClientResult
>("cloud_conversation_edits:commitForkInternal");

const commitRewindRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    result: RewindWorkerResult;
    now: number;
  },
  RewindClientResult
>("cloud_conversation_edits:commitRewindInternal");

const cleanupRewindRef = makeFunctionReference<
  "mutation",
  { ownerId: string; ownerGeneration: string; operationId: string },
  { complete: boolean; deleted: number }
>("cloud_conversation_edits:cleanupRewindProjectionInternal");

const builderEndpoint = (): { url: string; secret: string } => {
  const url = process.env.CLOUD_BUILDER_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  if (!url || !secret) {
    throw new ConvexError({
      code: "UNAVAILABLE",
      message: "Cloud conversation editing is not configured.",
    });
  }
  return { url, secret };
};

const runWorkerPass = async (
  body: Record<string, unknown>,
): Promise<WorkerResult> => {
  const builder = builderEndpoint();
  const response = await fetch(
    `${builder.url}/internal/conversation-edits/run`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${builder.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    },
  );
  const payload = (await response.json().catch(() => null)) as
    | (WorkerResult & { code?: string; message?: string })
    | null;
  if (!response.ok && response.status !== 202) {
    throw new ConvexError({
      code: response.status === 409 ? "CONFLICT" : "UNAVAILABLE",
      message: payload?.message || "Cloud conversation editing failed.",
      upstreamCode: payload?.code,
    });
  }
  if (!payload || (payload.kind !== "fork" && payload.kind !== "rewind")) {
    throw new ConvexError({
      code: "UNAVAILABLE",
      message: "Cloud conversation editing returned an invalid response.",
    });
  }
  return payload;
};

const runToCompletion = async (
  ctx: ActionCtx,
  ownerId: string,
  ownerGeneration: string,
  operation: OperationView,
): Promise<WorkerResult> => {
  for (let pass = 0; pass < MAX_EDIT_PASSES; pass += 1) {
    await ctx.runMutation(dispatchFenceRef, {
      ownerId,
      ownerGeneration,
      operationId: operation.operationId,
    });
    const body: Record<string, unknown> =
      operation.kind === "fork"
        ? {
            v: 1,
            kind: "fork",
            operationId: operation.operationId,
            ownerId,
            ownerGeneration,
            sourceConversationId: operation.sourceConversationId,
            targetConversationId: operation.targetConversationId,
            throughSeq: operation.throughSeq,
            expectedEpoch: operation.expectedEpoch,
            expectedLastSeq: operation.expectedLastSeq,
            title: operation.title,
            sourceCreatedAt: operation.sourceCreatedAt,
            targetCreatedAt: operation.targetCreatedAt,
          }
        : {
            v: 1,
            kind: "rewind",
            operationId: operation.operationId,
            ownerId,
            ownerGeneration,
            conversationId: operation.sourceConversationId,
            throughSeq: operation.throughSeq,
            expectedEpoch: operation.expectedEpoch,
            expectedLastSeq: operation.expectedLastSeq,
            activeTurnPolicy: operation.activeTurnPolicy ?? "conflict",
          };
    const result = await runWorkerPass(body);
    if (result.complete) return result;
  }
  throw new ConvexError({
    code: "UNAVAILABLE",
    message:
      "The conversation edit is still copying. Retry the same requestId.",
  });
};

const finishRewindProjection = async (
  ctx: ActionCtx,
  ownerId: string,
  ownerGeneration: string,
  operationId: string,
): Promise<void> => {
  for (;;) {
    const result = await ctx.runMutation(cleanupRewindRef, {
      ownerId,
      ownerGeneration,
      operationId,
    });
    if (result.complete) return;
  }
};

export const forkMyConversation = action({
  args: {
    sourceConversationId: v.string(),
    throughSeq: v.number(),
    expectedEpoch: v.number(),
    expectedLastSeq: v.number(),
    requestId: v.string(),
  },
  returns: forkClientResultValidator,
  handler: async (ctx, args): Promise<ForkClientResult> => {
    validateBoundary(args.throughSeq, args.expectedEpoch, args.expectedLastSeq);
    const requestId = normalizeRequestId(args.requestId);
    const ownerId = await requireUserId(ctx);
    const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
      ctx,
      ownerId,
    );
    const fingerprint = await hashSha256Hex(
      JSON.stringify([
        "fork",
        args.sourceConversationId,
        args.throughSeq,
        args.expectedEpoch,
        args.expectedLastSeq,
      ]),
    );
    const operation = await ctx.runMutation(reserveForkRef, {
      ownerId,
      ownerGeneration,
      requestId,
      fingerprint,
      sourceConversationId: args.sourceConversationId,
      throughSeq: args.throughSeq,
      expectedEpoch: args.expectedEpoch,
      expectedLastSeq: args.expectedLastSeq,
      now: Date.now(),
    });
    if (operation.state === "complete") {
      return {
        conversationId: operation.targetConversationId!,
        sourceEpoch: operation.sourceEpoch!,
        throughSeq: operation.throughSeq,
        targetEpoch: operation.nextEpoch!,
        lastSeq: operation.resultLastSeq!,
        replayed: true,
      };
    }
    const worker = await runToCompletion(
      ctx,
      ownerId,
      ownerGeneration,
      operation,
    );
    if (worker.kind !== "fork") {
      return conflict("Cloud worker returned the wrong edit kind.");
    }
    return await ctx.runMutation(commitForkRef, {
      ownerId,
      ownerGeneration,
      operationId: operation.operationId,
      result: worker,
      now: Date.now(),
    });
  },
});

export const rewindMyConversation = action({
  args: {
    conversationId: v.string(),
    throughSeq: v.number(),
    expectedEpoch: v.number(),
    expectedLastSeq: v.number(),
    requestId: v.string(),
    activeTurnPolicy: activeTurnPolicyValidator,
  },
  returns: rewindClientResultValidator,
  handler: async (ctx, args): Promise<RewindClientResult> => {
    validateBoundary(args.throughSeq, args.expectedEpoch, args.expectedLastSeq);
    const requestId = normalizeRequestId(args.requestId);
    const ownerId = await requireUserId(ctx);
    const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
      ctx,
      ownerId,
    );
    const fingerprint = await hashSha256Hex(
      JSON.stringify([
        "rewind",
        args.conversationId,
        args.throughSeq,
        args.expectedEpoch,
        args.expectedLastSeq,
        args.activeTurnPolicy,
      ]),
    );
    const operation = await ctx.runMutation(reserveRewindRef, {
      ownerId,
      ownerGeneration,
      requestId,
      fingerprint,
      conversationId: args.conversationId,
      throughSeq: args.throughSeq,
      expectedEpoch: args.expectedEpoch,
      expectedLastSeq: args.expectedLastSeq,
      activeTurnPolicy: args.activeTurnPolicy,
      now: Date.now(),
    });
    if (operation.state === "complete" || operation.state === "projecting") {
      await finishRewindProjection(
        ctx,
        ownerId,
        ownerGeneration,
        operation.operationId,
      );
      return {
        conversationId: operation.sourceConversationId,
        previousEpoch: operation.previousEpoch!,
        nextEpoch: operation.nextEpoch!,
        lastSeq: operation.resultLastSeq!,
        replayed: true,
      };
    }
    const worker = await runToCompletion(
      ctx,
      ownerId,
      ownerGeneration,
      operation,
    );
    if (worker.kind !== "rewind") {
      return conflict("Cloud worker returned the wrong edit kind.");
    }
    const result = await ctx.runMutation(commitRewindRef, {
      ownerId,
      ownerGeneration,
      operationId: operation.operationId,
      result: worker,
      now: Date.now(),
    });
    await finishRewindProjection(
      ctx,
      ownerId,
      ownerGeneration,
      operation.operationId,
    );
    return result;
  },
});

export const authorizeEditTargetPurgeInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    editOperationId: v.string(),
    targetConversationId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, {
      ownerId: args.ownerId,
      operationId: args.operationId,
      generation: args.generation,
    });
    const edit = await readOperationById(ctx, args.editOperationId);
    return Boolean(
      edit &&
      edit.ownerId === args.ownerId &&
      edit.kind === "fork" &&
      edit.targetConversationId === args.targetConversationId,
    );
  },
});

const authorizeEditTargetPurgeRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    operationId: string;
    generation: string;
    editOperationId: string;
    targetConversationId: string;
  },
  boolean
>("cloud_conversation_edits:authorizeEditTargetPurgeInternal");

const finishConversationPurgeRef = makeFunctionReference<
  "mutation",
  {
    conversationId: string;
    ownerId: string;
    operationId: string;
    generation: string;
    now: number;
  },
  null
>("cloud_apps:finishConversationPurgeInternal");

/** Purges an unpublished fork target using its owner-indexed control-plane locator. */
export const purgeConversationEditTargetInternal = internalAction({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    editOperationId: v.string(),
    targetConversationId: v.string(),
  },
  returns: v.object({ purged: v.boolean() }),
  handler: async (ctx, args): Promise<{ purged: boolean }> => {
    const authorized = await ctx.runMutation(authorizeEditTargetPurgeRef, args);
    if (!authorized) return { purged: false };
    const builder = builderEndpoint();
    const response = await fetch(
      `${builder.url}/conversations/${encodeURIComponent(args.targetConversationId)}/purge`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${builder.secret}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    if (!response.ok) return { purged: false };
    const payload = (await response.json().catch(() => null)) as {
      purged?: boolean;
    } | null;
    if (payload?.purged !== true) return { purged: false };
    await ctx.runMutation(finishConversationPurgeRef, {
      conversationId: args.targetConversationId,
      ownerId: args.ownerId,
      operationId: args.operationId,
      generation: args.generation,
      now: Date.now(),
    });
    return { purged: true };
  },
});
