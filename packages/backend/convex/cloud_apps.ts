import type { ManagedModelAudience } from "@stella/contracts/gateway/capability";
import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { assertOwnerMigrationWriteAllowed } from "./auth";
import {
  completeCloudBrowserInteractionForResumeTurn,
  markBrowserResumeDispatchFailed,
  projectCloudBrowserSuspension,
} from "./cloud_browser";
import type { SubscriptionPlan } from "./lib/billing_plans";
import {
  DEFAULT_CLOUD_ANTHROPIC_EXECUTION,
  DEFAULT_CLOUD_CODEX_EXECUTION,
  DEFAULT_CLOUD_EXECUTION,
  normalizeCloudExecutionSelection,
  type CloudExecutionSelection,
} from "./lib/cloud_execution";
import { enforceMutationRateLimit } from "./lib/rate_limits";
import {
  assertOwnerDataAccessActive,
  assertOwnerDataWriteAllowed,
  assertOwnerPurgeOperation,
} from "./owner_lifecycle";

type OwnerModelAllowance = {
  audience: ManagedModelAudience;
  budgetMicroCents: number;
  maxRequests?: number;
  unlimited: boolean;
};

/**
 * The managed-model allowance a Builder turn capability is minted from.
 * Convex is the only party that knows the owner's plan and remaining managed
 * balance; the admitting Durable Object signs exactly these numbers into the
 * capability and the model gateway meters against them without calling back.
 */
const resolveOwnerModelAllowance = async (
  ctx: ActionCtx,
  ownerId: string,
  ownerGeneration: string,
): Promise<OwnerModelAllowance> =>
  (await ctx.runMutation(
    internal.gateway_capabilities.getOwnerModelAllowanceInternal,
    { ownerId, ownerGeneration },
  )) as OwnerModelAllowance;

export const ownerModelAllowanceFields = async (
  ctx: ActionCtx,
  ownerId: string,
  ownerGeneration: string,
): Promise<{ audience: ManagedModelAudience; budgetMicroCents: number }> => {
  const allowance = await resolveOwnerModelAllowance(
    ctx,
    ownerId,
    ownerGeneration,
  );
  return {
    audience: allowance.audience,
    budgetMicroCents: allowance.budgetMicroCents,
  };
};

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

export const resolveCloudPlan = async (
  ctx: Pick<MutationCtx, "db"> | Pick<QueryCtx, "db">,
  ownerId: string,
): Promise<{
  plan: SubscriptionPlan;
  usageMode: "default" | "unlimited";
}> => {
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
    usageMode: profile?.usageMode ?? "default",
  };
};
const getEngineSettingsRef = makeFunctionReference<
  "query",
  { ownerId: string },
  {
    chatEngine: string;
    execution: CloudExecutionSelection;
    connectedProviders: string[];
  }
>("cloud_engines:getEngineSettingsInternal");

export const resolveOwnerExecution = async (
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  ownerId: string,
): Promise<CloudExecutionSelection> => {
  const settings = (await ctx.runQuery(getEngineSettingsRef, { ownerId })) as {
    chatEngine: string;
    execution: CloudExecutionSelection;
    connectedProviders: string[];
  };
  const execution = normalizeCloudExecutionSelection(settings.execution);
  if (
    execution.engine !== "stella" &&
    !settings.connectedProviders.includes(execution.provider)
  ) {
    throw new ConvexError(
      execution.engine === "anthropic"
        ? "The selected Claude connection is unavailable. Reconnect it or choose another cloud engine."
        : "The selected ChatGPT connection is unavailable. Reconnect it or choose another cloud engine.",
    );
  }
  return execution;
};

const assertExecutionAvailable = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  selection: CloudExecutionSelection,
): Promise<CloudExecutionSelection> => {
  const execution = normalizeCloudExecutionSelection(selection);
  if (execution.engine === "stella") return execution;
  const credential = await ctx.db
    .query("cloud_llm_credentials")
    .withIndex("by_ownerId_and_provider_and_importedFromOwnerId", (q) =>
      q
        .eq("ownerId", ownerId)
        .eq("provider", execution.provider)
        .eq("importedFromOwnerId", undefined),
    )
    .unique();
  if (!credential) {
    throw new ConvexError(
      execution.engine === "anthropic"
        ? "Connect Claude before using that cloud execution route."
        : "Connect ChatGPT before using that cloud execution route.",
    );
  }
  return execution;
};

export const resolveOwnerExecutionInMutation = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
): Promise<CloudExecutionSelection> => {
  const settings = await ctx.db
    .query("cloud_engine_settings")
    .withIndex("by_ownerId_and_importedFromOwnerId", (q) =>
      q.eq("ownerId", ownerId).eq("importedFromOwnerId", undefined),
    )
    .unique();
  const execution = settings?.execution
    ? normalizeCloudExecutionSelection(settings.execution)
    : settings?.chatEngine === "anthropic"
      ? DEFAULT_CLOUD_ANTHROPIC_EXECUTION
      : settings?.chatEngine === "openai-codex"
        ? DEFAULT_CLOUD_CODEX_EXECUTION
        : DEFAULT_CLOUD_EXECUTION;
  return await assertExecutionAvailable(ctx, ownerId, execution);
};

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

export const CHAT_TITLE_MAX = 56;

export const failCloudTurnInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    turnId: v.string(),
    message: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    if (
      !turn ||
      turn.ownerId !== args.ownerId ||
      turn.ownerGeneration !== args.ownerGeneration ||
      turn.terminalKind
    )
      return null;
    const seq = await nextEventSeq(ctx, args.turnId);
    const payloadJson = JSON.stringify({ message: args.message });
    await ctx.db.insert("agent_events", {
      ownerId: turn.ownerId,
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      seq,
      kind: "failed",
      payloadJson,
      createdAt: args.now,
    });
    await ctx.db.patch(turn._id, {
      status: "failed",
      terminalKind: "failed",
      errorMessage: payloadJson,
      updatedAt: args.now,
    });
    return null;
  },
});

/**
 * Last transaction-plane barrier before provider I/O made on behalf of a
 * cloud turn. The capability the caller presented is the authority (signed,
 * turn-bound, expiring); this only closes the window after Convex has seen
 * the turn end. The turn row is a projection that may not have landed yet
 * for a turn that just started, so its absence is not a refusal.
 */
export const assertActiveTurnDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    turnId: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    if (!(await isTurnStillActive(ctx, args))) {
      throw new ConvexError({
        code: "TURN_NOT_ACTIVE",
        message: "Cloud turn is no longer active.",
      });
    }
    return null;
  },
});

/** True unless Convex has a row for the turn that says it is over. */
export const isTurnStillActive = async (
  ctx: Pick<QueryCtx, "db">,
  args: { ownerId: string; ownerGeneration: string; turnId: string },
): Promise<boolean> => {
  const turn = await ctx.db
    .query("agent_turns")
    .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
    .unique();
  if (!turn) return true;
  return (
    turn.ownerId === args.ownerId &&
    turn.ownerGeneration === args.ownerGeneration &&
    turn.status === "running" &&
    !turn.terminalKind
  );
};

// ---------------------------------------------------------------------------
// The conversation index. Everything below is a projection of the
// OrchestratorSession DO's journal: the DO is the only writer, Convex is the
// only place that can answer "list my conversations".
// ---------------------------------------------------------------------------

const PREVIEW_MAX_CHARS = 160;
/** One purge pass; the caller loops until `hasMore` is false. */
const PURGE_BATCH = 100;

/**
 * How long a purged conversation id stays fenced against resurrection.
 *
 * The only writer that can resurrect one is an index flush from a DO isolate
 * that was resident when the purge ran, and that flush is bounded by its own
 * ladder — three attempts of 15 s per POST, twenty batches, a 20 s drain
 * budget — and dies outright with the isolate that owns it. A DO that comes up
 * cold after a purge has an empty journal and no owner, so it has nothing to
 * flush. Thirty days is that window with room to spare, on a two-field row.
 */
const CONVERSATION_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000;

export const clip = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

/**
 * Fence a conversation id whose DO has confirmed its storage is gone.
 *
 * Exported as a plain helper rather than a mutation so account deletion can
 * write the fence in the SAME transaction that deletes the index row: between
 * the two there must be no instant in which neither exists, because that
 * instant is exactly what `upsertConversationIndexInternal`'s self-heal branch
 * reads. Idempotent — the delete action, the retry sweep and account deletion
 * all reach it, and a re-run must not add a second row.
 */
export const recordConversationTombstone = async (
  ctx: MutationCtx,
  conversationId: string,
  now: number,
): Promise<void> => {
  // `first()`, not `unique()`: neither this nor the fence read below may ever
  // throw. A duplicate row would be harmless — the fence answers the same
  // either way — and turning it into an exception would fail the transaction
  // that is deleting the index row, which is the one outcome that must not
  // happen.
  const existing = await ctx.db
    .query("cloud_conversation_tombstones")
    .withIndex("by_conversationId", (q) =>
      q.eq("conversationId", conversationId),
    )
    .first();
  if (existing) return;
  await ctx.db.insert("cloud_conversation_tombstones", {
    conversationId,
    purgedAt: now,
  });
};

export const conversationTombstoned = async (
  ctx: MutationCtx,
  conversationId: string,
): Promise<boolean> => {
  const row = await ctx.db
    .query("cloud_conversation_tombstones")
    .withIndex("by_conversationId", (q) =>
      q.eq("conversationId", conversationId),
    )
    .first();
  return row !== null;
};

const builderEndpoint = (): { url: string; secret: string } | null => {
  const url = process.env.CLOUD_BUILDER_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return url && secret ? { url, secret } : null;
};

const logCloud = (event: string, fields: Record<string, unknown>): void => {
  console.warn(
    JSON.stringify({ service: "convex-cloud-apps", event, ...fields }),
  );
};

export type ConversationIndexUpsertArgs = {
  conversationId: string;
  ownerId: string;
  ownerGeneration: string;
  epoch: number;
  lastSeq: number;
  updatedAt: number;
  createdAt?: number;
  title?: string;
  lastPreview?: string;
  lastRole?: string;
  activity?: string;
  force?: boolean;
};

export type ConversationIndexUpsertResult = {
  accepted: boolean;
  reason?: string;
  lastSeq: number;
  epoch: number;
};

/**
 * The DO's only write into Convex's half of a conversation (delivered as a
 * `conversation.index` outbox event).
 *
 * Fenced on `(epoch, lastSeq)`: a retried or reordered flush is dropped as
 * stale rather than moving the row backwards. `updatedAt` takes max() because
 * Convex owns it too — `resolveConversationId` stamps it so a brand-new
 * conversation sorts to the top before the DO has flushed anything.
 *
 * The reply always carries the row's CURRENT lastSeq, accepted or not, so a DO
 * that lost track of what it had synced can converge without a second call.
 */
export const upsertConversationIndex = async (
  ctx: MutationCtx,
  args: ConversationIndexUpsertArgs,
): Promise<ConversationIndexUpsertResult> => {
  await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
  const row = await ctx.db
    .query("cloud_conversations")
    .withIndex("by_conversationId", (q) =>
      q.eq("conversationId", args.conversationId),
    )
    .unique();

  if (!row) {
    // A missing row means one of two opposite things, and only the tombstone
    // table can tell them apart: the row was LOST (self-heal below), or it
    // was DELETED with its conversation (account deletion drops the index row
    // because it carries `ownerId`). Self-healing the second case re-creates
    // a deleted owner's conversation from a flush that a still-resident DO
    // started before the purge and retried after it. Ask before rebuilding.
    if (await conversationTombstoned(ctx, args.conversationId)) {
      logCloud("conversation_index_after_purge", {
        conversationId: args.conversationId,
      });
      return {
        accepted: false,
        reason: "purged",
        lastSeq: -1,
        epoch: 0,
      };
    }
    // Self-heal: a lost index row is rebuilt from what the DO mirrored into
    // its own `meta` on first contact. Requires `createdAt` — without it the
    // rebuilt row would sort wrong forever, and the DO always has it.
    if (args.createdAt === undefined) {
      return {
        accepted: false,
        reason: "unknown_conversation",
        lastSeq: -1,
        epoch: 0,
      };
    }
    await ctx.db.insert("cloud_conversations", {
      conversationId: args.conversationId,
      ownerId: args.ownerId,
      title: clip(args.title?.trim() || "Conversation", CHAT_TITLE_MAX),
      createdAt: args.createdAt,
      updatedAt: Math.max(args.updatedAt, args.createdAt),
      lastSeq: args.lastSeq,
      epoch: args.epoch,
      ...(args.lastPreview
        ? { lastPreview: clip(args.lastPreview, PREVIEW_MAX_CHARS) }
        : {}),
      ...(args.lastRole ? { lastRole: args.lastRole } : {}),
      ...(args.activity ? { activity: args.activity } : {}),
    });
    return {
      accepted: true,
      lastSeq: args.lastSeq,
      epoch: args.epoch,
    };
  }

  if (row.ownerId !== args.ownerId) {
    // A DO speaking for the wrong owner is a bug or an attack; either way it
    // never overwrites an index row.
    logCloud("conversation_index_owner_mismatch", {
      conversationId: args.conversationId,
    });
    return {
      accepted: false,
      reason: "owner_mismatch",
      lastSeq: row.lastSeq ?? -1,
      epoch: row.epoch ?? 0,
    };
  }
  if (row.deletedAt !== undefined) {
    // Tombstoned: a flush that was already in flight when the purge started
    // must not resurrect the row.
    return {
      accepted: false,
      reason: "deleted",
      lastSeq: row.lastSeq ?? -1,
      epoch: row.epoch ?? 0,
    };
  }
  const currentEpoch = row.epoch ?? 0;
  const currentSeq = row.lastSeq ?? -1;
  if (args.epoch < currentEpoch) {
    // A rewind advances the epoch to fence delayed flushes from the removed
    // suffix.
    return {
      accepted: false,
      reason: "stale_epoch",
      lastSeq: currentSeq,
      epoch: currentEpoch,
    };
  }
  if (
    args.force !== true &&
    args.epoch === currentEpoch &&
    args.lastSeq <= currentSeq
  ) {
    return {
      accepted: false,
      reason: "stale",
      lastSeq: currentSeq,
      epoch: currentEpoch,
    };
  }
  await ctx.db.patch(row._id, {
    epoch: args.epoch,
    lastSeq: args.lastSeq,
    updatedAt: Math.max(row.updatedAt, args.updatedAt),
    // A desktop-local turn reaches the DO directly rather than passing
    // through resolveConversationId. Its first accepted index flush is the
    // corresponding proof that this is no longer an intentional empty.
    ...(row.allowEmpty === true && args.lastSeq >= 0
      ? { allowEmpty: undefined }
      : {}),
    ...(args.lastPreview !== undefined
      ? { lastPreview: clip(args.lastPreview, PREVIEW_MAX_CHARS) }
      : {}),
    ...(args.lastRole !== undefined ? { lastRole: args.lastRole } : {}),
    ...(args.activity !== undefined ? { activity: args.activity } : {}),
    // Title stays Convex's: it is set from the first prompt at creation and
    // the DO has nothing better to say about it.
    ...(row.title.trim() === "" && args.title?.trim()
      ? { title: clip(args.title.trim(), CHAT_TITLE_MAX) }
      : {}),
  });
  return {
    accepted: true,
    lastSeq: args.lastSeq,
    epoch: args.epoch,
  };
};

export const upsertConversationIndexInternal = internalMutation({
  args: {
    conversationId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    epoch: v.number(),
    lastSeq: v.number(),
    updatedAt: v.number(),
    createdAt: v.optional(v.number()),
    title: v.optional(v.string()),
    lastPreview: v.optional(v.string()),
    lastRole: v.optional(v.string()),
    activity: v.optional(v.string()),
    force: v.optional(v.boolean()),
  },
  returns: v.object({
    accepted: v.boolean(),
    reason: v.optional(v.string()),
    lastSeq: v.number(),
    epoch: v.number(),
  }),
  handler: async (ctx, args) => await upsertConversationIndex(ctx, args),
});

/**
 * Cards are journal rows, so they survive scrollback. A build card used to
 * exist only while its event row was inside the tail's take(100). Convex
 * writes them because Convex is where the build, operation, and thread
 * outcomes land; the DO orders them.
 *
 * Best-effort by design: a card is a receipt for work that already happened.
 * Losing one must never fail a turn, so this action logs and returns.
 */
export const postConversationCardInternal = internalAction({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.string(),
    sourceTurnId: v.string(),
    card: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertExpectedOwnerGenerationActive(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const builder = builderEndpoint();
    if (!builder) return null;
    try {
      // 429 means the DO is mid-reply and its inbox is full. The writer key is
      // `card:<sourceTurnId>:<type>`, so re-posting is exactly-once — retry a
      // couple of times rather than silently dropping a receipt the user is
      // waiting to see (the card is the whole payoff of a build).
      let response: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        response = await fetch(
          `${builder.url}/conversations/${encodeURIComponent(args.conversationId)}/cards`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${builder.secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              ownerId: args.ownerId,
              ownerGeneration: args.ownerGeneration,
              sourceTurnId: args.sourceTurnId,
              card: args.card,
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (response.status !== 429 && response.status < 500) break;
        if (attempt < 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, 2_000 * (attempt + 1)),
          );
        }
      }
      if (response && !response.ok) {
        logCloud("conversation_card_rejected", {
          conversationId: args.conversationId,
          sourceTurnId: args.sourceTurnId,
          status: response.status,
        });
      }
    } catch (error) {
      logCloud("conversation_card_failed", {
        conversationId: args.conversationId,
        sourceTurnId: args.sourceTurnId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  },
});

/**
 * The card a non-chat turn leaves behind. Chat turns leave none: their reply
 * is the journal's assistant row.
 */
const terminalCardFor = (
  turn: { kind?: string; appId?: string; conversationId?: string },
  kind: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | null => {
  if (kind !== "completed" || turn.kind === "chat") return null;
  if (typeof payload.buildId === "string") {
    return {
      type: "build",
      buildId: payload.buildId,
      ...(turn.appId ? { appId: turn.appId } : {}),
    };
  }
  if (typeof payload.operation === "string") {
    return {
      type: "operation",
      operation: payload.operation,
      args: payload.args ?? {},
      result: payload.result ?? null,
    };
  }
  return null;
};

const scheduleTerminalCard = async (
  ctx: MutationCtx,
  turn: {
    ownerId: string;
    kind?: string;
    appId?: string;
    conversationId?: string;
    turnId: string;
  },
  kind: string,
  payloadJson: string,
  ownerGeneration: string,
): Promise<void> => {
  if (!turn.conversationId) return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return;
  }
  const card = terminalCardFor(turn, kind, payload);
  if (!card) return;
  await ctx.scheduler.runAfter(
    0,
    internal.cloud_apps.postConversationCardInternal,
    {
      ownerId: turn.ownerId,
      ownerGeneration,
      conversationId: turn.conversationId,
      sourceTurnId: turn.turnId,
      card,
    },
  );
};

/**
 * Dev probe for the DO-resident transcript. There are no tests, so this is the
 * verification tool: `bunx convex run cloud_apps:getConversationProbeInternal
 * '{"conversationId":"..."}'`.
 */
export const getConversationProbeInternal = internalAction({
  args: { conversationId: v.string(), limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const builder = builderEndpoint();
    if (!builder) return { error: "Cloud builder is not configured." };
    const limit = Math.min(200, Math.max(1, Math.floor(args.limit ?? 50)));
    const response = await fetch(
      `${builder.url}/conversations/${encodeURIComponent(args.conversationId)}/journal?limit=${limit}`,
      {
        headers: { authorization: `Bearer ${builder.secret}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const text = await response.text();
    if (!response.ok)
      return { error: `journal ${response.status}`, body: text };
    try {
      return JSON.parse(text);
    } catch {
      return { error: "Journal response was not JSON.", body: text };
    }
  },
});

// ---------------------------------------------------------------------------
// Conversation deletion. The DO owns the transcript and its R2 segments, so
// deletion is a two-party handshake: Convex tombstones (which is what makes it
// disappear and stay gone), the DO purges its own storage, Convex records that
// it finished. Any step can be retried; none can be skipped.
// ---------------------------------------------------------------------------

type ConversationOwnerPurgeFence = {
  ownerId: string;
  operationId: string;
  generation: string;
};

const conversationOwnerPurgeFence = (args: {
  ownerId?: string;
  operationId?: string;
  generation?: string;
}): ConversationOwnerPurgeFence | null => {
  // `ownerId` alone is the ordinary signed-in/sweep ownership check. Only the
  // operation fields opt this call into the account-purge authority path.
  const supplied =
    args.operationId !== undefined || args.generation !== undefined;
  if (!supplied) return null;
  if (!args.ownerId || !args.operationId || !args.generation) {
    throw new ConvexError(
      "ownerId, operationId, and generation must be supplied together.",
    );
  }
  return {
    ownerId: args.ownerId,
    operationId: args.operationId,
    generation: args.generation,
  };
};

/**
 * Marks a conversation deleted: invisible, unwritable, and stripped of the
 * user's words on the spot. The storage purge is a separate, retried step.
 */
export const tombstoneConversation = async (
  ctx: MutationCtx,
  args: {
    conversationId: string;
    ownerId?: string;
    operationId?: string;
    generation?: string;
    now: number;
  },
): Promise<{ ok: boolean; ownerId: string }> => {
  const purgeFence = conversationOwnerPurgeFence(args);
  if (purgeFence) await assertOwnerPurgeOperation(ctx, purgeFence);
  const row = await ctx.db
    .query("cloud_conversations")
    .withIndex("by_conversationId", (q) =>
      q.eq("conversationId", args.conversationId),
    )
    .unique();
  if (!row || (args.ownerId && row.ownerId !== args.ownerId)) {
    throw new ConvexError("Conversation not found.");
  }
  if (row.deletedAt !== undefined) {
    return { ok: true, ownerId: row.ownerId };
  }
  // The tombstone keeps only what the purge needs: identity. The title and
  // preview are the user's words, and they go now rather than whenever the
  // DO gets around to answering.
  await ctx.db.patch(row._id, {
    deletedAt: args.now,
    title: "",
    lastPreview: undefined,
    lastRole: undefined,
    activity: undefined,
    updatedAt: args.now,
  });
  return { ok: true, ownerId: row.ownerId };
};

export const tombstoneConversationInternal = internalMutation({
  args: {
    conversationId: v.string(),
    /** Omitted by the sweeps, which already know the row. */
    ownerId: v.optional(v.string()),
    operationId: v.optional(v.string()),
    generation: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean(), ownerId: v.string() }),
  handler: async (ctx, args) => await tombstoneConversation(ctx, args),
});

/**
 * Drops every Convex row derived from one conversation, including turn/event
 * rows that carry prompts. Batched because a long conversation exceeds one
 * transaction.
 */
export const purgeConversationRowsInternal = internalMutation({
  args: {
    conversationId: v.string(),
    ownerId: v.optional(v.string()),
    operationId: v.optional(v.string()),
    generation: v.optional(v.string()),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const purgeFence = conversationOwnerPurgeFence(args);
    if (purgeFence) {
      await assertOwnerPurgeOperation(ctx, purgeFence);
      const conversation = await ctx.db
        .query("cloud_conversations")
        .withIndex("by_conversationId", (q) =>
          q.eq("conversationId", args.conversationId),
        )
        .unique();
      if (conversation && conversation.ownerId !== purgeFence.ownerId) {
        throw new ConvexError("Conversation not found.");
      }
    }
    // Spawned-agent control-plane rows belong to the conversation and go too.
    const threads = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_conversationId_and_updatedAt", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .take(10);
    for (const thread of threads) {
      if (purgeFence && thread.ownerId !== purgeFence.ownerId) {
        throw new ConvexError("Conversation not found.");
      }
      await ctx.db.delete(thread._id);
    }
    if (threads.length === 10) return { hasMore: true };

    const turns = await ctx.db
      .query("agent_turns")
      .withIndex("by_conversationId_and_createdAt", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .take(20);
    for (const turn of turns) {
      if (purgeFence && turn.ownerId !== purgeFence.ownerId) {
        throw new ConvexError("Conversation not found.");
      }
      const events = await ctx.db
        .query("agent_events")
        .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", turn.turnId))
        .take(PURGE_BATCH);
      for (const event of events) await ctx.db.delete(event._id);
      // Children first, and the turn only once its last child is gone.
      if (events.length === PURGE_BATCH) return { hasMore: true };
      await ctx.db.delete(turn._id);
    }
    return { hasMore: turns.length === 20 };
  },
});

export const finishConversationPurgeInternal = internalMutation({
  args: {
    conversationId: v.string(),
    ownerId: v.optional(v.string()),
    operationId: v.optional(v.string()),
    generation: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const purgeFence = conversationOwnerPurgeFence(args);
    if (purgeFence) await assertOwnerPurgeOperation(ctx, purgeFence);
    const row = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .unique();
    if (purgeFence && row && row.ownerId !== purgeFence.ownerId) {
      throw new ConvexError("Conversation not found.");
    }
    // The fence goes in first and unconditionally — before the `!row` bail and
    // in the same transaction as the stamp. It is what stops a late index flush
    // from resurrecting the conversation as a sidebar ghost pointing at storage
    // that no longer exists, and it must not depend on the index row still
    // being here: account deletion deletes that row, and a sweep can reach a
    // conversation whose row a concurrent account purge already took.
    await recordConversationTombstone(ctx, args.conversationId, args.now);
    if (!row) return null;
    // The index row also stays for a per-conversation delete, stripped of the
    // user's words by `tombstoneConversationInternal` at the start. `purgedAt`
    // is what tells the retry sweep this purge finished.
    await ctx.db.patch(row._id, { purgedAt: args.now });
    return null;
  },
});

/**
 * The whole purge, idempotent end to end: safe to re-run after any failure,
 * which is what the sweep cron relies on.
 */
export const purgeConversationInternal = internalAction({
  args: {
    conversationId: v.string(),
    ownerId: v.optional(v.string()),
    operationId: v.optional(v.string()),
    generation: v.optional(v.string()),
  },
  returns: v.object({ purged: v.boolean() }),
  handler: async (ctx, args): Promise<{ purged: boolean }> => {
    const purgeFence = conversationOwnerPurgeFence(args);
    await ctx.runMutation(internal.cloud_apps.tombstoneConversationInternal, {
      conversationId: args.conversationId,
      ...(args.ownerId ? { ownerId: args.ownerId } : {}),
      ...(purgeFence
        ? {
            operationId: purgeFence.operationId,
            generation: purgeFence.generation,
          }
        : {}),
      now: Date.now(),
    });
    let hasMore = true;
    while (hasMore) {
      const result: { hasMore: boolean } = await ctx.runMutation(
        internal.cloud_apps.purgeConversationRowsInternal,
        {
          conversationId: args.conversationId,
          ...(purgeFence ? purgeFence : {}),
        },
      );
      hasMore = result.hasMore;
    }
    const builder = builderEndpoint();
    if (!builder) {
      logCloud("conversation_purge_unconfigured", {
        conversationId: args.conversationId,
      });
      return { purged: false };
    }
    {
      let ok = false;
      try {
        const response = await fetch(
          `${builder.url}/conversations/${encodeURIComponent(args.conversationId)}/purge`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${builder.secret}`,
              "content-type": "application/json",
            },
            body: "{}",
            signal: AbortSignal.timeout(60_000),
          },
        );
        // The DO's own verdict decides this, never the status class. An
        // incomplete purge answers 202 `{purged:false}`: it could not delete
        // some of its R2 objects, so it deliberately kept its storage —
        // including the manifest naming those objects — and is waiting to be
        // asked again. `response.ok` is true for that, and treating it as
        // success is what stamps `purgedAt` on a conversation whose transcript
        // is still in DO SQLite and whose segments are still in R2, with
        // nothing left that will ever look at it again.
        //
        // A 404 is NOT "the DO never existed", however it reads: the namespace
        // creates the object on demand, so an id nothing ever addressed still
        // answers 200 `{purged:true}`. The only thing that 404s this route is a
        // request that never reached a purge handler — a stale
        // `CLOUD_BUILDER_URL`, a worker rolled back past the route, a rename.
        // Every one of those leaves the transcript and its R2 objects intact,
        // so it is a failure like any other: keep the tombstone and let the
        // sweep ask again.
        if (response.ok) {
          const verdict = (await response.json().catch(() => null)) as {
            purged?: boolean;
            pending?: number;
          } | null;
          ok = verdict?.purged === true;
          if (!ok) {
            logCloud("conversation_purge_incomplete", {
              conversationId: args.conversationId,
              status: response.status,
              pending: verdict?.pending ?? -1,
            });
          }
        } else {
          logCloud("conversation_purge_rejected", {
            conversationId: args.conversationId,
            status: response.status,
          });
        }
      } catch (error) {
        logCloud("conversation_purge_failed", {
          conversationId: args.conversationId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (!ok) {
        // The tombstone stays unpurged; `sweepDeletedConversationsInternal`
        // retries. Reporting success here would strand R2 segments with no
        // record of their keys — and would release account deletion's durable
        // gate on the strength of a purge that explicitly said it was not done.
        return { purged: false };
      }
    }
    await ctx.runMutation(internal.cloud_apps.finishConversationPurgeInternal, {
      conversationId: args.conversationId,
      ...(purgeFence ? purgeFence : {}),
      now: Date.now(),
    });
    return { purged: true };
  },
});

/** Tombstones awaiting a retried purge, oldest first. */
export const listUnpurgedConversationsInternal = internalQuery({
  args: { limit: v.number(), before: v.number() },
  returns: v.array(v.object({ conversationId: v.string() })),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_purgedAt_and_deletedAt", (q) =>
        q
          .eq("purgedAt", undefined)
          .gte("deletedAt", 1)
          .lte("deletedAt", args.before),
      )
      .take(Math.min(50, Math.max(1, args.limit)));
    return rows.map((row) => ({ conversationId: row.conversationId }));
  },
});

export const sweepDeletedConversationsInternal = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ attempted: v.number(), purged: v.number() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ attempted: number; purged: number }> => {
    const rows: Array<{ conversationId: string }> = await ctx.runQuery(
      internal.cloud_apps.listUnpurgedConversationsInternal,
      // A minute of grace: the delete action's own scheduled purge should get
      // first refusal, so the sweep is a retry and not a race.
      { limit: args.limit ?? 10, before: Date.now() - 60_000 },
    );
    let purged = 0;
    for (const row of rows) {
      const result: { purged: boolean } = await ctx.runAction(
        internal.cloud_apps.purgeConversationInternal,
        { conversationId: row.conversationId },
      );
      if (result.purged) purged += 1;
    }
    return { attempted: rows.length, purged };
  },
});

/**
 * Conversations the DO never flushed: a row created at dispatch whose turn
 * never reached the builder. Without this they accumulate as permanently empty
 * sidebar entries. Tombstoned rather than deleted outright, so the same purge
 * path clears whatever partial DO state may exist.
 */
export const sweepOrphanConversationsInternal = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ tombstoned: v.number() }),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const rows = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_allowEmpty_and_lastSeq_and_createdAt", (q) =>
        q
          .eq("allowEmpty", undefined)
          .eq("lastSeq", undefined)
          .lt("createdAt", cutoff),
      )
      .take(Math.min(100, Math.max(1, args.limit ?? 25)));
    let tombstoned = 0;
    for (const row of rows) {
      if (row.deletedAt !== undefined) continue;
      // A live turn keeps a conversation alive even with nothing flushed yet;
      // 24h of no activity says otherwise.
      if (row.updatedAt >= cutoff) continue;
      await ctx.db.patch(row._id, {
        deletedAt: Date.now(),
        title: "",
        lastPreview: undefined,
        lastRole: undefined,
        activity: undefined,
      });
      tombstoned += 1;
    }
    return { tombstoned };
  },
});

/**
 * Retires resurrection fences older than the window any in-flight index flush
 * can survive. Keeping them forever would be harmless for privacy — a
 * tombstone is a random id and a timestamp, with nothing left anywhere that
 * maps it to a person — but "we never delete it" is not a retention policy, and
 * an unbounded table with one row per deleted conversation is not a resting
 * state either.
 */
export const sweepConversationTombstonesInternal = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - CONVERSATION_TOMBSTONE_RETENTION_MS;
    const rows = await ctx.db
      .query("cloud_conversation_tombstones")
      .withIndex("by_purgedAt", (q) => q.lt("purgedAt", cutoff))
      .take(Math.min(500, Math.max(1, args.limit ?? 200)));
    for (const row of rows) await ctx.db.delete(row._id);
    return { deleted: rows.length };
  },
});

/**
 * Definitive pre-admission failure is one transaction: the terminal turn and
 * the thread projection either both commit or neither does. No wake: a turn
 * that never reached the builder has no Durable Object above it to tell, and
 * the thread's terminal state is what Activity and the desktop's recovery
 * subscription read.
 */
export const failCloudAgentDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.string(),
    threadId: v.string(),
    turnId: v.string(),
    attemptGeneration: v.number(),
    message: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    if (
      !Number.isSafeInteger(args.attemptGeneration) ||
      args.attemptGeneration < 1
    ) {
      throw new ConvexError("Invalid attempt generation.");
    }
    const [turn, thread] = await Promise.all([
      ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
        .unique(),
      ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
        .unique(),
    ]);
    if (
      !turn ||
      !thread ||
      turn.ownerId !== args.ownerId ||
      turn.ownerGeneration !== args.ownerGeneration ||
      turn.threadId !== args.threadId ||
      turn.conversationId !== args.conversationId ||
      turn.attemptGeneration !== args.attemptGeneration ||
      thread.ownerId !== args.ownerId ||
      thread.ownerGeneration !== args.ownerGeneration ||
      thread.conversationId !== args.conversationId ||
      thread.attemptGeneration !== args.attemptGeneration
    ) {
      return null;
    }
    const payloadJson = JSON.stringify({ message: args.message });
    if (turn.terminalKind) {
      if (
        turn.terminalKind !== "failed" ||
        turn.status !== "failed" ||
        turn.errorMessage !== payloadJson
      ) {
        return null;
      }
    } else {
      const seq = await nextEventSeq(ctx, args.turnId);
      await ctx.db.insert("agent_events", {
        ownerId: turn.ownerId,
        turnId: turn.turnId,
        sessionId: turn.sessionId,
        seq,
        kind: "failed",
        payloadJson,
        createdAt: args.now,
      });
      await ctx.db.patch(turn._id, {
        status: "failed",
        terminalKind: "failed",
        errorMessage: payloadJson,
        updatedAt: args.now,
      });
    }
    await markBrowserResumeDispatchFailed(ctx, {
      turn,
      now: args.now,
      safeMessage: args.message,
    });
    if (thread.status !== "running") return null;
    await ctx.db.patch(thread._id, {
      status: "failed",
      errorMessage: args.message,
      updatedAt: args.now,
    });
    return null;
  },
});

export type AgentThreadCompletionStatus =
  | "completed"
  | "failed"
  | "canceled"
  | "waiting_for_user";

export type AgentThreadCompletionResult =
  | {
      applied: true;
      conversationId: string;
      originDelivery: boolean;
      /** The conversation turn that spawned the thread, when recorded. */
      parentTurnId?: string;
    }
  | {
      applied: false;
      reason: "unknown_thread" | "owner_mismatch" | "stale" | "duplicate";
    };

/**
 * Projects a BuildSession's terminal verdict onto its thread row (delivered
 * as a `thread.completed` outbox event). The wake of the parent orchestrator
 * is no longer Convex's job — the BuildSession tells the OrchestratorSession
 * directly — so this is purely the projection the UI, Activity, and the
 * desktop's recovery subscription read.
 *
 * Fenced on `attemptGeneration`: a late verdict for an attempt a continuation
 * has already replaced is an idempotent no-op, never a demotion of the newer
 * attempt. A verdict for an attempt Convex has not seen yet (its
 * `thread.spawned` is still in flight) is applied and carries the generation
 * forward, so delivery order cannot lose a completion.
 */
export const completeAgentThread = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    threadId: string;
    turnId: string;
    attemptGeneration: number;
    status: AgentThreadCompletionStatus;
    resultJson?: string;
    errorMessage?: string;
    now: number;
  },
): Promise<AgentThreadCompletionResult> => {
  if (
    !Number.isSafeInteger(args.attemptGeneration) ||
    args.attemptGeneration < 1
  ) {
    throw new ConvexError("Invalid attempt generation.");
  }
  const thread = await ctx.db
    .query("cloud_agent_threads")
    .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
    .unique();
  if (!thread) return { applied: false, reason: "unknown_thread" };
  if (thread.ownerId !== args.ownerId) {
    return { applied: false, reason: "owner_mismatch" };
  }
  if (
    thread.ownerGeneration !== undefined &&
    thread.ownerGeneration !== args.ownerGeneration
  ) {
    return { applied: false, reason: "stale" };
  }
  const currentAttempt = thread.attemptGeneration ?? 0;
  if (args.attemptGeneration < currentAttempt) {
    return { applied: false, reason: "stale" };
  }
  if (
    args.attemptGeneration === currentAttempt &&
    thread.status !== "running" &&
    thread.status !== "resuming"
  ) {
    // The first verdict for an attempt wins; a second one (or a repeat of the
    // same one) is at-least-once delivery, not a change of mind.
    return { applied: false, reason: "duplicate" };
  }
  await ctx.db.patch(thread._id, {
    status: args.status,
    attemptGeneration: args.attemptGeneration,
    resultJson: args.resultJson,
    errorMessage: args.errorMessage,
    ...(args.status === "waiting_for_user" ? { sandboxLeaseExpiresAt: 0 } : {}),
    updatedAt: args.now,
  });
  return {
    applied: true,
    conversationId: thread.conversationId,
    originDelivery: Boolean(
      thread.originDeviceId && thread.originConversationId,
    ),
    ...(thread.parentTurnId ? { parentTurnId: thread.parentTurnId } : {}),
  };
};

const OUTPUT_FILE_CARD_MAX = 20;

/**
 * Files a thread produced, newest description wins. Bounded on both axes: a
 * thread's turns and each turn's events, because this runs inside the
 * completion mutation and must not be able to blow its read budget.
 */
export const collectThreadOutputFiles = async (
  ctx: MutationCtx,
  threadId: string,
): Promise<Array<Record<string, unknown>>> => {
  const turns = await ctx.db
    .query("agent_turns")
    .withIndex("by_threadId_and_createdAt", (q) => q.eq("threadId", threadId))
    .order("desc")
    .take(3);
  const byPath = new Map<string, Record<string, unknown>>();
  for (const turn of turns.reverse()) {
    const events = await ctx.db
      .query("agent_events")
      .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", turn.turnId))
      .order("desc")
      .take(100);
    for (const event of events.reverse()) {
      if (event.kind !== "output_files") continue;
      let payload: { files?: unknown };
      try {
        payload = JSON.parse(event.payloadJson) as { files?: unknown };
      } catch {
        continue;
      }
      if (!Array.isArray(payload.files)) continue;
      for (const entry of payload.files) {
        const file = entry as { path?: unknown };
        if (typeof file.path !== "string" || !file.path) continue;
        // A turn can emit `output_files` more than once for the same path; the
        // later emission describes the same file's final state.
        byPath.set(file.path, entry as Record<string, unknown>);
      }
    }
  }
  return [...byPath.values()].slice(0, OUTPUT_FILE_CARD_MAX);
};

export type TurnEventProjectionArgs = {
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  attemptGeneration?: number;
  sessionId: string;
  /** Caller-assigned per-turn position; absent means "append". */
  seq?: number;
  /** The DO's per-attempt ordinal (outbox identity). */
  eventSeq?: number;
  kind: string;
  payloadJson: string;
  terminal: boolean;
  connectedAccount?: boolean;
  now: number;
};

export type TurnEventProjectionResult =
  | {
      ok: true;
      inserted: boolean;
      terminalAccepted: boolean;
      duplicate: boolean;
    }
  | {
      ok: false;
      reason:
        | "unknown_turn"
        | "owner_mismatch"
        | "generation_stale"
        | "not_active"
        | "invalid";
    };

/**
 * Projects one executor event (delivered as a `turn.event` outbox event, or
 * written by Convex's own cancellation/operation paths).
 *
 * Identity is (turnId, attemptGeneration, eventSeq): a redelivery is a
 * duplicate, never a second row. Terminal events are idempotent per attempt —
 * the first terminal for a turn closes it and every later one, whatever it
 * says, is a duplicate. A hosted-browser wait (`waiting_for_user`, not
 * terminal) additionally projects the interaction row and parks the thread.
 */
export const appendTurnEventProjection = async (
  ctx: MutationCtx,
  args: TurnEventProjectionArgs,
): Promise<TurnEventProjectionResult> => {
  const turn = await ctx.db
    .query("agent_turns")
    .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
    .unique();
  if (!turn) return { ok: false, reason: "unknown_turn" };
  if (turn.ownerId !== args.ownerId) {
    return { ok: false, reason: "owner_mismatch" };
  }
  if (turn.ownerGeneration !== args.ownerGeneration) {
    return { ok: false, reason: "generation_stale" };
  }
  if (turn.sessionId !== args.sessionId)
    return { ok: false, reason: "invalid" };
  const duplicate = {
    ok: true as const,
    inserted: false,
    terminalAccepted: false,
    duplicate: true,
  };
  if (args.eventSeq !== undefined) {
    const existing = await ctx.db
      .query("agent_events")
      .withIndex("by_turnId_and_attemptGeneration_and_eventSeq", (q) =>
        q
          .eq("turnId", args.turnId)
          .eq("attemptGeneration", args.attemptGeneration)
          .eq("eventSeq", args.eventSeq),
      )
      .first();
    if (existing) return duplicate;
  } else if (args.seq !== undefined) {
    const existing = await ctx.db
      .query("agent_events")
      .withIndex("by_turnId_and_seq", (q) =>
        q.eq("turnId", args.turnId).eq("seq", args.seq!),
      )
      .first();
    if (existing) return duplicate;
  }
  const isBrowserSuspension =
    args.kind === "waiting_for_user" && args.terminal === false;
  if (isBrowserSuspension) {
    if (
      turn.kind !== "agent" ||
      !turn.threadId ||
      !Number.isSafeInteger(args.attemptGeneration) ||
      args.attemptGeneration !== turn.attemptGeneration
    ) {
      return { ok: false, reason: "invalid" };
    }
    // The projection does its own liveness check after the exact-replay
    // check, so a re-emitted wait for an already parked turn is a duplicate
    // rather than a refusal.
    const projected = await projectCloudBrowserSuspension(ctx, {
      turn,
      payloadJson: args.payloadJson,
      connectedAccount: args.connectedAccount === true,
      now: args.now,
    });
    if (projected.replayed) return duplicate;
    await ctx.db.insert("agent_events", {
      ownerId: turn.ownerId,
      turnId: args.turnId,
      sessionId: turn.sessionId,
      seq: args.seq ?? (await nextEventSeq(ctx, args.turnId)),
      ...(args.attemptGeneration !== undefined
        ? { attemptGeneration: args.attemptGeneration }
        : {}),
      ...(args.eventSeq !== undefined ? { eventSeq: args.eventSeq } : {}),
      kind: args.kind,
      payloadJson: args.payloadJson,
      createdAt: args.now,
    });
    return {
      ok: true,
      inserted: true,
      terminalAccepted: false,
      duplicate: false,
    };
  }
  // Closed turns accept nothing more: a second terminal is a redelivery of the
  // verdict, and a straggling progress event describes a past the UI has
  // already rendered as finished.
  if (turn.terminalKind) return duplicate;
  if (turn.status !== "running" && turn.status !== "resuming") {
    return { ok: false, reason: "not_active" };
  }
  if (turn.kind === "agent") {
    if (
      !turn.threadId ||
      !Number.isSafeInteger(args.attemptGeneration) ||
      args.attemptGeneration! < 1 ||
      turn.attemptGeneration !== args.attemptGeneration
    ) {
      return { ok: false, reason: "not_active" };
    }
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", turn.threadId!))
      .unique();
    // The thread row is itself a projection (`thread.spawned`) and may land
    // after this event; only a row that contradicts the turn refuses it.
    if (
      thread &&
      (thread.ownerId !== args.ownerId ||
        thread.ownerGeneration !== args.ownerGeneration ||
        (thread.attemptGeneration ?? 0) > args.attemptGeneration! ||
        (thread.attemptGeneration === args.attemptGeneration &&
          thread.status !== "running" &&
          thread.status !== "resuming"))
    ) {
      return { ok: false, reason: "not_active" };
    }
  }
  if (turn.browserResume) {
    await completeCloudBrowserInteractionForResumeTurn(ctx, {
      turn,
      now: args.now,
    });
  }
  await ctx.db.insert("agent_events", {
    ownerId: turn.ownerId,
    turnId: args.turnId,
    sessionId: turn.sessionId,
    seq: args.seq ?? (await nextEventSeq(ctx, args.turnId)),
    ...(args.attemptGeneration !== undefined
      ? { attemptGeneration: args.attemptGeneration }
      : {}),
    ...(args.eventSeq !== undefined ? { eventSeq: args.eventSeq } : {}),
    kind: args.kind,
    payloadJson: args.payloadJson,
    createdAt: args.now,
  });
  if (turn.status === "resuming") {
    await ctx.db.patch(turn._id, { status: "running", updatedAt: args.now });
  }
  if (args.terminal) {
    await ctx.db.patch(turn._id, {
      status: ["completed", "failed", "canceled", "timeout"].includes(args.kind)
        ? args.kind
        : "failed",
      terminalKind: args.kind,
      resultJson: args.kind === "completed" ? args.payloadJson : undefined,
      errorMessage: args.kind === "completed" ? undefined : args.payloadJson,
      updatedAt: args.now,
    });
    await scheduleTerminalCard(
      ctx,
      turn,
      args.kind,
      args.payloadJson,
      args.ownerGeneration,
    );
  }
  return {
    ok: true,
    inserted: true,
    terminalAccepted: args.terminal,
    duplicate: false,
  };
};

/** Convex-internal writer for one turn event (ops probes, tests). */
export const appendEventInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    turnId: v.string(),
    attemptGeneration: v.optional(v.number()),
    sessionId: v.string(),
    seq: v.number(),
    // Executors that can't coordinate a shared counter let Convex assign
    // max(seq)+1. Auto-seq events skip the duplicate check by construction.
    autoSeq: v.optional(v.boolean()),
    kind: v.string(),
    payloadJson: v.string(),
    terminal: v.boolean(),
    connectedAccount: v.optional(v.boolean()),
    now: v.number(),
  },
  returns: v.object({ inserted: v.boolean(), terminalAccepted: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const result = await appendTurnEventProjection(ctx, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      turnId: args.turnId,
      ...(args.attemptGeneration !== undefined
        ? { attemptGeneration: args.attemptGeneration }
        : {}),
      sessionId: args.sessionId,
      ...(args.autoSeq ? {} : { seq: args.seq }),
      kind: args.kind,
      payloadJson: args.payloadJson,
      terminal: args.terminal,
      ...(args.connectedAccount !== undefined
        ? { connectedAccount: args.connectedAccount }
        : {}),
      now: args.now,
    });
    if (!result.ok) {
      throw new ConvexError(
        result.reason === "not_active"
          ? "Cloud turn is no longer active."
          : "Unknown cloud turn.",
      );
    }
    return {
      inserted: result.inserted,
      terminalAccepted: result.terminalAccepted,
    };
  },
});

export type RecordBuildArgs = {
  buildId: string;
  appId: string;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  artifactPrefix: string;
  previewUrl: string;
  metricsJson: string;
  slug: string;
  title?: string;
  now: number;
};

export const deleteSupersededBuildInternal = internalMutation({
  args: {
    ownerId: v.string(),
    appId: v.string(),
    buildId: v.string(),
    artifactPrefix: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const build = await ctx.db
      .query("cloud_app_builds")
      .withIndex("by_buildId", (q) => q.eq("buildId", args.buildId))
      .unique();
    if (
      !build ||
      build.ownerId !== args.ownerId ||
      build.appId !== args.appId ||
      build.status !== "retiring" ||
      build.artifactPrefix !== args.artifactPrefix
    ) {
      return false;
    }
    await ctx.db.delete(build._id);
    return true;
  },
});

export const claimSupersededBuildRetirementInternal = internalMutation({
  args: {
    ownerId: v.string(),
    appId: v.string(),
    buildId: v.string(),
    artifactPrefix: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const build = await ctx.db
      .query("cloud_app_builds")
      .withIndex("by_buildId", (q) => q.eq("buildId", args.buildId))
      .unique();
    if (
      !build ||
      build.ownerId !== args.ownerId ||
      build.appId !== args.appId ||
      build.artifactPrefix !== args.artifactPrefix ||
      (build.status !== "superseded" && build.status !== "retiring")
    ) {
      return false;
    }
    if (build.status === "superseded") {
      await ctx.db.patch(build._id, {
        status: "retiring",
        updatedAt: Date.now(),
      });
    }
    return true;
  },
});

export const scanFailureSpikes = internalMutation({
  args: {
    thresholdOverride: v.optional(v.number()),
    windowMsOverride: v.optional(v.number()),
  },
  returns: v.object({
    failureCount: v.number(),
    threshold: v.number(),
    alerted: v.boolean(),
    resolved: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const threshold = Math.max(1, Math.floor(args.thresholdOverride ?? 3));
    const windowMs = Math.min(
      24 * 60 * 60_000,
      Math.max(60_000, Math.floor(args.windowMsOverride ?? 15 * 60_000)),
    );
    const windowStartedAt = now - windowMs;
    const turns = await ctx.db
      .query("agent_turns")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", windowStartedAt))
      .take(500);
    const failures = turns.filter(
      (turn) => turn.status === "failed" || turn.status === "timeout",
    );
    const open = await ctx.db
      .query("cloud_failure_alerts")
      .withIndex("by_status_and_createdAt", (q) => q.eq("status", "open"))
      .order("desc")
      .first();
    if (failures.length >= threshold) {
      if (!open || open.windowEndedAt < windowStartedAt) {
        const summary = `${failures.length} cloud turns failed or timed out in ${Math.round(windowMs / 60_000)} minutes.`;
        await ctx.db.insert("cloud_failure_alerts", {
          windowStartedAt,
          windowEndedAt: now,
          failureCount: failures.length,
          threshold,
          status: "open",
          summary,
          createdAt: now,
          updatedAt: now,
        });
        console.error(
          JSON.stringify({
            service: "convex-cloud-apps",
            event: "failure_spike_opened",
            failureCount: failures.length,
            threshold,
            windowMs,
          }),
        );
        return {
          failureCount: failures.length,
          threshold,
          alerted: true,
          resolved: false,
        };
      }
      return {
        failureCount: failures.length,
        threshold,
        alerted: false,
        resolved: false,
      };
    }
    if (open) {
      await ctx.db.patch(open._id, {
        status: "resolved",
        resolvedAt: now,
        updatedAt: now,
      });
      console.info(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "failure_spike_resolved",
          alertId: open._id,
          failureCount: failures.length,
        }),
      );
      return {
        failureCount: failures.length,
        threshold,
        alerted: false,
        resolved: true,
      };
    }
    return {
      failureCount: failures.length,
      threshold,
      alerted: false,
      resolved: false,
    };
  },
});

export const listFailureAlertsInternal = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) =>
    await ctx.db
      .query("cloud_failure_alerts")
      .withIndex("by_createdAt")
      .order("desc")
      .take(25),
});

export const probeCloudRateLimitInternal = internalMutation({
  args: { key: v.string() },
  returns: v.object({ allowed: v.boolean() }),
  handler: async (ctx, args) => {
    await enforceMutationRateLimit(
      ctx,
      "cloud_apps_start",
      `ops-probe:${args.key}`,
      { rate: 4, periodMs: 10 * 60_000 },
      "Cloud start-rate probe was limited as expected.",
    );
    return { allowed: true };
  },
});

export const getBenchmarkTurn = internalQuery({
  args: { turnId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    if (!turn) return null;
    const events = await ctx.db
      .query("agent_events")
      .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", args.turnId))
      .take(100);
    return { turn, events };
  },
});

const nextEventSeq = async (
  ctx: Pick<MutationCtx, "db">,
  turnId: string,
): Promise<number> => {
  // Read the max seq from the index tail: a bounded ascending scan caps out
  // once a turn exceeds the window and every later event collides on one seq.
  const last = await ctx.db
    .query("agent_events")
    .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", turnId))
    .order("desc")
    .first();
  return (last?.seq ?? -1) + 1;
};
