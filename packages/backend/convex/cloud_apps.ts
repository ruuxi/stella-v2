import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  makeFunctionReference,
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  enforceActionRateLimit,
  enforceMutationRateLimit,
} from "./lib/rate_limits";
import type { SubscriptionPlan } from "./lib/billing_plans";
import {
  cloudExecutionSelectionValidator,
  DEFAULT_CLOUD_ANTHROPIC_EXECUTION,
  DEFAULT_CLOUD_CODEX_EXECUTION,
  DEFAULT_CLOUD_EXECUTION,
  normalizeCloudExecutionSelection,
  type CloudExecutionSelection,
} from "./lib/cloud_execution";
import {
  assertOwnerMigrationWriteAllowed,
  getUserIdentityOrNull,
  hasOwnerMigrationSourceFence,
  requireUserId,
} from "./auth";
import { appSdkSessionOwnsCurrentApp } from "./lib/app_sdk_session";
import { sessionIdentityMatchesExpectedSubject } from "./lib/session_identity";
import {
  CLOUD_SANDBOX_LEASE_MS,
  cloudAgentSandboxLeaseExpiresAt,
  cloudSandboxThreadIsActive,
} from "./lib/computer_agent_thread";
import { executionPlacementValidator } from "./schema/execution_placement";
import {
  assertOwnerDataAccessActive,
  assertOwnerDataWriteAllowed,
  assertOwnerPurgeOperation,
  LEGACY_OWNER_GENERATION,
} from "./owner_lifecycle";
import { hashSha256Hex } from "./lib/crypto_utils";
import { normalizeChatAttachmentPaths } from "./lib/chat_attachments";
import { createManagedUsageDispatchGuard } from "./lib/managed_billing";
import { runManagedDispatchAttempt } from "./runtime_ai/managed";
import {
  browserSuspensionReplayMatches,
  completeCloudBrowserInteractionForResumeTurn,
  markBrowserResumeDispatchFailed,
  projectCloudBrowserSuspension,
} from "./cloud_browser";
import { cloudBrowserResumeReceiptValidator } from "./schema/cloud_browser";

type CloudPlanQuota = {
  dailyTurns: number;
  concurrentTurns: number;
  burstStarts: number;
};

const CLOUD_PLAN_QUOTAS: Record<SubscriptionPlan, CloudPlanQuota> = {
  free: { dailyTurns: 3, concurrentTurns: 1, burstStarts: 4 },
  go: { dailyTurns: 10, concurrentTurns: 1, burstStarts: 6 },
  pro: { dailyTurns: 25, concurrentTurns: 2, burstStarts: 10 },
};

const UNLIMITED_CLOUD_QUOTA: CloudPlanQuota = {
  dailyTurns: 200,
  concurrentTurns: 6,
  burstStarts: 40,
};

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

/**
 * The operation-vs-build classifier is a bounded Stella routing decision, not
 * user-visible model output. It is lifecycle-leased provider overhead and must
 * never silently consume user quota or write user usage logs.
 */
export const CLOUD_APP_ROUTE_MODEL_BILLING_POLICY =
  "stella_control_plane_overhead" as const;

const resolveCloudPlan = async (
  ctx: Pick<MutationCtx, "db"> | Pick<QueryCtx, "db">,
  ownerId: string,
): Promise<{ plan: SubscriptionPlan; quota: CloudPlanQuota }> => {
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
    quota:
      profile?.usageMode === "unlimited"
        ? UNLIMITED_CLOUD_QUOTA
        : CLOUD_PLAN_QUOTAS[plan],
  };
};

const benchmarkPrompt =
  "Build a polished responsive habit tracker named Orbit. It needs a warm editorial visual style, a daily progress ring, four useful habit cards, and an encouraging focus panel. Make it feel like a real product, not a generic dashboard.";

const createTurnRef = makeFunctionReference<
  "mutation",
  {
    turnId: string;
    sessionId: string;
    ownerId: string;
    conversationId?: string;
    appId: string;
    prompt: string;
    ownerGeneration: string;
    now: number;
  },
  null
>("cloud_apps:createTurnInternal");
const getAppRef = makeFunctionReference<"query", { appId: string }, any>(
  "cloud_apps:getAppInternal",
);
const getBuildRef = makeFunctionReference<"query", { buildId: string }, any>(
  "cloud_apps:getBuildInternal",
);
const activateBuildRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:activateBuildInternal",
);
const checkQuotaRef = makeFunctionReference<
  "query",
  { ownerId: string },
  { allowed: boolean; reason?: string }
>("cloud_apps:checkQuotaInternal");
const runCloudTurnRef = makeFunctionReference<"action", any, any>(
  "cloud_apps:runCloudTurnInternal",
);
const routeCloudTurnRef = makeFunctionReference<"action", any, any>(
  "cloud_apps:routeCloudTurnInternal",
);
const failCloudTurnRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:failCloudTurnInternal",
);
const isCloudBuildTurnDispatchableRef = makeFunctionReference<
  "query",
  {
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    appId: string;
    turnId: string;
    sessionId: string;
  },
  boolean
>("cloud_apps:isCloudBuildTurnDispatchableInternal");
const isCloudBuildTurnAttemptAuthoritativeRef = makeFunctionReference<
  "query",
  {
    tokenHash: string;
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    appId: string;
    turnId: string;
    sessionId: string;
    now: number;
  },
  boolean
>("cloud_apps:isCloudBuildTurnAttemptAuthoritativeInternal");
const getOpsManifestRef = makeFunctionReference<
  "query",
  { appId: string },
  any
>("cloud_apps:getOperationsManifestInternal");
const createOpInvocationRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:createOpInvocationInternal",
);
const reserveBuildLaneRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:reserveBuildLaneInternal",
);
const expireOpInvocationRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:expireOpInvocationInternal",
);
const assertCloudRouteDispatchRef = makeFunctionReference<
  "mutation",
  { ownerId: string; ownerGeneration: string; turnId: string },
  null
>("cloud_apps:assertCloudRouteDispatchAllowedInternal");
const runOrchestratorTurnRef = makeFunctionReference<"action", any, any>(
  "cloud_apps:runOrchestratorTurnInternal",
);
const isCloudChatTurnDispatchableRef = makeFunctionReference<
  "query",
  {
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    turnId: string;
    sessionId: string;
  },
  boolean
>("cloud_apps:isCloudChatTurnDispatchableInternal");
const isCloudChatTurnAttemptAuthoritativeRef = makeFunctionReference<
  "query",
  {
    tokenHash: string;
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    turnId: string;
    sessionId: string;
    now: number;
  },
  boolean
>("cloud_apps:isCloudChatTurnAttemptAuthoritativeInternal");
type CloudAgentThreadControl = {
  status: string;
  runningTurnId: string | null;
  alreadyCanceled: boolean;
  attemptGeneration: number;
  threadUpdatedAt: number;
  currentControl?: {
    threadId: string;
    status: string;
    attemptGeneration: number;
    threadUpdatedAt: number;
  };
};
type AgentThreadControlReceipt = {
  threadId: string;
  attemptGeneration: number;
  threadUpdatedAt: number;
  status:
    | "running"
    | "waiting_for_user"
    | "resuming"
    | "completed"
    | "failed"
    | "canceled";
};
const agentThreadControlReceiptValidator = v.object({
  threadId: v.string(),
  attemptGeneration: v.number(),
  threadUpdatedAt: v.number(),
  status: v.union(
    v.literal("running"),
    v.literal("waiting_for_user"),
    v.literal("resuming"),
    v.literal("completed"),
    v.literal("failed"),
    v.literal("canceled"),
  ),
});
const getCloudAgentThreadControlRef = makeFunctionReference<
  "query",
  {
    ownerId: string;
    ownerGeneration: string;
    threadId: string;
    conversationId?: string;
    originDeviceId?: string;
    originConversationId?: string;
    controlRequestId?: string;
  },
  CloudAgentThreadControl | null
>("cloud_apps:getCloudAgentThreadControlInternal");
const runCloudAgentTurnRef = makeFunctionReference<"action", any, any>(
  "cloud_apps:runCloudAgentTurnInternal",
);
const storeTurnTokenRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:storeTurnTokenInternal",
);
const ensureTurnTokenForDispatchRef = makeFunctionReference<
  "mutation",
  any,
  boolean
>("cloud_apps:ensureTurnTokenForDispatchInternal");
const failCloudAgentDispatchRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:failCloudAgentDispatchInternal",
);
const completeAgentThreadRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:completeAgentThreadInternal",
);
const cancelCloudAgentTurnRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:cancelCloudAgentTurnInternal",
);
const isCloudAgentTurnDispatchableRef = makeFunctionReference<
  "query",
  {
    ownerId: string;
    ownerGeneration: string;
    threadId: string;
    turnId: string;
    attemptGeneration: number;
  },
  boolean
>("cloud_apps:isCloudAgentTurnDispatchableInternal");
const isCloudAgentTurnAttemptAuthoritativeRef = makeFunctionReference<
  "query",
  {
    tokenHash: string;
    ownerId: string;
    ownerGeneration: string;
    threadId: string;
    turnId: string;
    attemptGeneration: number;
    now: number;
  },
  boolean
>("cloud_apps:isCloudAgentTurnAttemptAuthoritativeInternal");
const getEngineSettingsRef = makeFunctionReference<
  "query",
  { ownerId: string },
  {
    chatEngine: string;
    execution: CloudExecutionSelection;
    connectedProviders: string[];
  }
>("cloud_engines:getEngineSettingsInternal");

const resolveOwnerExecution = async (
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

/**
 * Rolling compatibility for cloud orchestrators that still send the old
 * string-only spawn override. New clients send the full `execution` object.
 */
const parseLegacySpawnExecution = (
  value: string | undefined,
): CloudExecutionSelection | undefined => {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "default") return undefined;
  const effortMatch = /:(default|none|minimal|low|medium|high|xhigh)$/.exec(
    trimmed,
  );
  const reasoningEffort =
    (effortMatch?.[1] as CloudExecutionSelection["reasoningEffort"]) ??
    "default";
  const route = effortMatch
    ? trimmed.slice(0, -effortMatch[0].length)
    : trimmed;
  if (route === "claude") {
    return { ...DEFAULT_CLOUD_ANTHROPIC_EXECUTION, reasoningEffort };
  }
  const pinned =
    /^claude\/((?:[A-Za-z0-9][A-Za-z0-9._-]{0,191}|[A-Za-z0-9][A-Za-z0-9._-]{0,187}\[1m\]))$/.exec(
      route,
    );
  if (pinned) {
    return {
      ...DEFAULT_CLOUD_ANTHROPIC_EXECUTION,
      model: pinned[1]!,
      reasoningEffort,
    };
  }
  if (route === "codex") {
    return { ...DEFAULT_CLOUD_CODEX_EXECUTION, reasoningEffort };
  }
  const codexPinned = /^codex\/([A-Za-z0-9][A-Za-z0-9._-]{0,191})$/.exec(route);
  if (codexPinned) {
    return {
      ...DEFAULT_CLOUD_CODEX_EXECUTION,
      model: codexPinned[1]!,
      reasoningEffort,
    };
  }
  if (route.startsWith("stella/")) {
    return normalizeCloudExecutionSelection({
      ...DEFAULT_CLOUD_EXECUTION,
      model: route,
      reasoningEffort,
    });
  }
  throw new ConvexError(
    'Cloud spawn model must be "claude[/model]", "codex[/model]", or a canonical "stella/..." model.',
  );
};

const assertExecutionAvailable = async (
  ctx: Pick<MutationCtx, "db">,
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

const resolveOwnerExecutionInMutation = async (
  ctx: Pick<MutationCtx, "db">,
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

const TURN_TOKEN_TTL_MS = 30 * 60_000;
const TURN_TOKEN_ATTEMPT_ROW_LIMIT = 32;
const THREAD_CONTEXT_ROW_LIMIT = 400;
// One active turn can contribute at most 1,024 rows. Scanning that turn plus
// the 400-row context suffix makes excludeTurnId deterministic without an
// unbounded collect.
const THREAD_CONTEXT_SCAN_LIMIT = 1_424;
const THREAD_CONTEXT_MAX_BYTES = 4 * 1024 * 1024;
const THREAD_MESSAGE_MAX_BYTES = 512 * 1024;
const THREAD_TURN_MESSAGE_LIMIT = 1_024;
const THREAD_TURN_MESSAGE_MAX_BYTES = 4 * 1024 * 1024;
const THREAD_MESSAGE_ROLES = new Set(["user", "assistant", "toolResult"]);

// The build lane's quota counts builds: "build", the pre-routing "auto"
// (which may become a build), and legacy rows from before lanes existed.
// Chat, wake, agent, and operation turns share the same table but draw from
// their own budgets. Counting queries the per-lane index — a mixed-lane
// window is defeatable, since chat rows outnumber builds by up to 20x and
// crowd them out of any fixed-size take().
const BUILD_LANES: Array<string | undefined> = ["build", "auto", undefined];

const listRecentBuildTurns = async (
  ctx: Pick<MutationCtx, "db"> | Pick<QueryCtx, "db">,
  ownerId: string,
  limitPerLane: number,
): Promise<Array<{ turnId: string; status: string }>> => {
  const cutoff = Date.now() - 86_400_000;
  const perLane = await Promise.all(
    BUILD_LANES.map((lane) =>
      ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_lane_and_createdAt", (q) =>
          q.eq("ownerId", ownerId).eq("lane", lane).gte("createdAt", cutoff),
        )
        .order("desc")
        .take(limitPerLane),
    ),
  );
  return perLane.flat();
};

const hashToken = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const assertThreadMessagePayload = (
  role: string,
  payloadJson: string,
): void => {
  if (!THREAD_MESSAGE_ROLES.has(role)) {
    throw new ConvexError("Invalid agent thread message role.");
  }
  if (utf8ByteLength(payloadJson) > THREAD_MESSAGE_MAX_BYTES) {
    throw new ConvexError("Agent thread message is too large.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new ConvexError("Agent thread message is invalid JSON.");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    (payload as { role?: unknown }).role !== role
  ) {
    throw new ConvexError(
      "Agent thread message payload does not match its role.",
    );
  }
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

// Allocates the next seq and inserts one AgentMessage row into a spawned
// agent's THREAD transcript. Callers hold the mutation transaction, so
// max(seq)+1 is race-free. User conversations do not come through here — their
// transcript is the DO's journal.
const appendThreadMessage = async (
  ctx: MutationCtx,
  args: {
    threadId: string;
    ownerId: string;
    turnId: string;
    ordinal: number;
    role: string;
    payloadJson: string;
    now: number;
  },
): Promise<number> => {
  const replay = await ctx.db
    .query("cloud_thread_messages")
    .withIndex("by_turnId_and_ordinal", (q) =>
      q.eq("turnId", args.turnId).eq("ordinal", args.ordinal),
    )
    .unique();
  if (replay) {
    if (
      replay.conversationId !== args.threadId ||
      replay.ownerId !== args.ownerId ||
      replay.role !== args.role ||
      replay.payloadJson !== args.payloadJson
    ) {
      throw new ConvexError("Agent thread message replay does not match.");
    }
    return replay.seq;
  }
  const last = await ctx.db
    .query("cloud_thread_messages")
    .withIndex("by_conversationId_and_seq", (q) =>
      q.eq("conversationId", args.threadId),
    )
    .order("desc")
    .first();
  const seq = (last?.seq ?? -1) + 1;
  await ctx.db.insert("cloud_thread_messages", {
    conversationId: args.threadId,
    ownerId: args.ownerId,
    seq,
    ordinal: args.ordinal,
    role: args.role,
    payloadJson: args.payloadJson,
    turnId: args.turnId,
    createdAt: args.now,
  });
  return seq;
};

const CHAT_TITLE_MAX = 56;

// Resolves the conversation a turn lands in, creating one (titled from the
// first prompt) when the caller has none. Ownership is checked here so every
// entry point inherits it.
//
// Returns the identity fields too, not just the id: `{conversationId, ownerId,
// createdAt}` is the one slice a per-conversation DO cannot reconstruct for
// itself (Cloudflare has no "list DOs in a namespace"), so it travels with the
// dispatch and the DO mirrors it into `meta`. Without `createdAt` the DO's
// index flush cannot re-create a lost row and Convex refuses it as
// `unknown_conversation`.
const resolveConversationId = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    conversationId?: string;
    title: string;
    execution?: CloudExecutionSelection;
    ownerGeneration?: string;
    now: number;
  },
): Promise<{
  documentId: Id<"cloud_conversations">;
  conversationId: string;
  title: string;
  createdAt: number;
  execution?: CloudExecutionSelection;
}> => {
  if (args.conversationId) {
    const requestedConversationId = args.conversationId;
    const conversation = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", requestedConversationId),
      )
      .unique();
    if (
      !conversation ||
      conversation.ownerId !== args.ownerId ||
      conversation.deletedAt !== undefined
    ) {
      // A tombstoned conversation reads as absent: its DO is purging or
      // already purged, so accepting a turn here would resurrect an index row
      // in front of a transcript that no longer exists.
      throw new ConvexError("Conversation not found.");
    }
    // `updatedAt` is display ordering, and it is Convex's field, not the DO's:
    // a brand-new conversation has to sort to the top of the sidebar before
    // its first journal flush. The DO's index flush takes max() on it, so this
    // patch can never move the row backwards.
    const firstTurnTitle =
      conversation.title.trim() === "" && args.title.trim() !== ""
        ? args.title.length > CHAT_TITLE_MAX
          ? `${args.title.slice(0, CHAT_TITLE_MAX - 3)}…`
          : args.title
        : conversation.title;
    await ctx.db.patch(conversation._id, {
      updatedAt: args.now,
      ...(firstTurnTitle !== conversation.title
        ? { title: firstTurnTitle }
        : {}),
      ...(conversation.allowEmpty === true ? { allowEmpty: undefined } : {}),
      ...(args.execution ? { execution: args.execution } : {}),
    });
    return {
      documentId: conversation._id,
      conversationId: requestedConversationId,
      title: firstTurnTitle,
      createdAt: conversation.createdAt,
      execution: args.execution ?? conversation.execution,
    };
  }
  const conversationId = crypto.randomUUID();
  const title =
    args.title.length > CHAT_TITLE_MAX
      ? `${args.title.slice(0, CHAT_TITLE_MAX - 3)}…`
      : args.title;
  const documentId = await ctx.db.insert("cloud_conversations", {
    conversationId,
    ownerId: args.ownerId,
    ...(args.execution ? { execution: args.execution } : {}),
    title,
    createdAt: args.now,
    updatedAt: args.now,
  });
  return {
    documentId,
    conversationId,
    title,
    createdAt: args.now,
    execution: args.execution,
  };
};

/**
 * The one implementation of "start a chat-lane turn" (contract C1). Every
 * caller — the signed-in composer, scheduled turns, desktop-dispatched cloud
 * work, and the agent-completion wake — goes through here so the transcript,
 * the turn token, and the orchestrator dispatch can never drift apart.
 *
 * `hiddenMessage` keeps the prompt out of the rendered transcript (lifecycle
 * and scheduled prompts are context, not something the user typed);
 * `hiddenTurn` additionally marks the turn row so the UI renders no user
 * bubble for it. The assistant reply stays visible in both cases.
 *
 * The prompt is NOT written to a transcript here. The conversation DO appends
 * it as the turn's first journal row, from the same dispatch that starts the
 * turn — one writer, one order, no second authority for message content.
 */
// BCP-47-shaped, e.g. "es" or "zh-Hans". Anything else is dropped rather
// than rejected — locale is a hint, never a reason to fail a send.
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const normalizeLocale = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && LOCALE_PATTERN.test(trimmed) ? trimmed : undefined;
};

const startChatTurn = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    conversationId?: string;
    prompt: string;
    lane?: string;
    source?: string;
    title?: string;
    hiddenMessage?: boolean;
    hiddenTurn?: boolean;
    clientMsgId?: string;
    locale?: string;
    attachments?: string[];
    execution?: CloudExecutionSelection;
    ownerGeneration?: string;
    chatIntentFingerprint?: string;
    /** Server-issued receipt carried into a lifecycle wake. The conversation
     * DO persists it outside model-visible tool arguments. */
    agentThreadControl?: AgentThreadControlReceipt;
    now: number;
  },
): Promise<{ conversationId: string; turnId: string }> => {
  const lifecycle = await assertOwnerDataWriteAllowed(
    ctx,
    args.ownerId,
    args.ownerGeneration,
  );
  const explicitExecution = args.execution
    ? await assertExecutionAvailable(ctx, args.ownerId, args.execution)
    : undefined;
  const conversation = await resolveConversationId(ctx, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
    title: args.title ?? args.prompt,
    ...(explicitExecution ? { execution: explicitExecution } : {}),
    now: args.now,
  });
  const execution = explicitExecution
    ? explicitExecution
    : conversation.execution
      ? await assertExecutionAvailable(
          ctx,
          args.ownerId,
          conversation.execution,
        )
      : await resolveOwnerExecutionInMutation(ctx, args.ownerId);
  if (!conversation.execution) {
    await ctx.db.patch(conversation.documentId, { execution });
  }
  if (Boolean(args.clientMsgId) !== Boolean(args.chatIntentFingerprint)) {
    throw new ConvexError(
      "Reliable chat admission is missing its payload fence.",
    );
  }
  const conversationId = conversation.conversationId;
  const turnId = crypto.randomUUID();
  const sessionId = `chat-${conversationId.slice(0, 8)}`;
  await ctx.db.insert("agent_turns", {
    turnId,
    sessionId,
    ownerId: args.ownerId,
    conversationId,
    prompt: args.prompt,
    status: "running",
    lane: args.lane ?? "chat",
    kind: "chat",
    agentType: "orchestrator",
    ...(args.source ? { source: args.source } : {}),
    ...(args.hiddenTurn ? { hidden: true } : {}),
    ...(args.clientMsgId ? { clientMsgId: args.clientMsgId } : {}),
    ownerGeneration: lifecycle.generation,
    ...(args.chatIntentFingerprint
      ? { chatIntentFingerprint: args.chatIntentFingerprint }
      : {}),
    execution,
    createdAt: args.now,
    updatedAt: args.now,
  });
  const turnToken =
    crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
  // The token hash is written by runOrchestratorTurnInternal immediately
  // before it dispatches, so the hash always exists before the DO can present
  // the raw token. Hashing is SubtleCrypto, which belongs in the action.
  await ctx.scheduler.runAfter(0, runOrchestratorTurnRef, {
    ownerId: args.ownerId,
    conversationId,
    turnId,
    sessionId,
    prompt: args.prompt,
    turnToken,
    ownerGeneration: lifecycle.generation,
    execution,
    // The DO writes the prompt row; these are the flags it needs to write it
    // the way the old Convex insert did.
    ...(args.hiddenMessage ? { hiddenMessage: true } : {}),
    ...(args.source ? { source: args.source } : {}),
    ...(args.clientMsgId ? { clientMsgId: args.clientMsgId } : {}),
    // Transcript metadata the journal needs and only Convex holds: the lane
    // labels the turn record, and title/createdAt seed `meta` so the DO's index
    // flush can re-create a lost index row instead of being refused.
    lane: args.lane ?? "chat",
    title: conversation.title,
    conversationCreatedAt: conversation.createdAt,
    ...(normalizeLocale(args.locale)
      ? { locale: normalizeLocale(args.locale) }
      : {}),
    ...(args.attachments?.length ? { attachments: args.attachments } : {}),
    ...(args.agentThreadControl
      ? { agentThreadControl: args.agentThreadControl }
      : {}),
    ...(process.env.CONVEX_SITE_URL?.trim()
      ? { convexCallbackBase: process.env.CONVEX_SITE_URL.trim() }
      : {}),
  });
  return { conversationId, turnId };
};

// Client-minted, so it is validated like any other client string before it is
// used as a dedupe key.
const CLIENT_MSG_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;
const CLIENT_CREATE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const normalizeClientMsgId = (
  value: string | undefined,
): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!CLIENT_MSG_ID_PATTERN.test(trimmed)) {
    throw new ConvexError("That message could not be sent. Try again.");
  }
  return trimmed;
};

const normalizeClientCreateId = (value: string): string => {
  const trimmed = value.trim();
  if (!CLIENT_CREATE_ID_PATTERN.test(trimmed)) {
    throw new ConvexError("That conversation could not be created. Try again.");
  }
  return trimmed;
};

type ChatIntentAuthority =
  | "composer-direct"
  | "composer-placement"
  | "chat-internal"
  | "chat-placement";

/**
 * Stable semantic payload for a client-minted chat/build id. Fixed field order
 * and explicit nulls are the v1 contract. Time and placement-attempt leases are
 * excluded so an exact commit-before-response retry can use a successor lease.
 */
const chatIntentFingerprint = async (args: {
  authority: ChatIntentAuthority;
  conversationId?: string;
  appId?: string;
  prompt: string;
  source?: string;
  hiddenMessage?: boolean;
  hiddenTurn?: boolean;
  locale?: string;
  attachments?: readonly string[];
  execution?: CloudExecutionSelection;
}): Promise<string> =>
  await hashSha256Hex(
    JSON.stringify({
      version: "chat-intent/v1",
      authority: args.authority,
      requestedConversationId: args.conversationId ?? null,
      requestedAppId: args.appId ?? null,
      prompt: args.prompt,
      source: args.source ?? null,
      hiddenMessage: args.hiddenMessage === true,
      hiddenTurn: args.hiddenTurn === true,
      locale: args.locale ?? null,
      attachments: [...(args.attachments ?? [])],
      requestedExecution: args.execution
        ? {
            engine: args.execution.engine,
            provider: args.execution.provider,
            model: args.execution.model,
            reasoningEffort: args.execution.reasoningEffort,
          }
        : null,
    }),
  );

const cloudConversationProjectionValidator = v.object({
  conversationId: v.string(),
  ownerId: v.string(),
  title: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const cloudConversationListProjectionValidator = v.object({
  conversationId: v.string(),
  ownerId: v.string(),
  title: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
  lastPreview: v.optional(v.string()),
  lastRole: v.optional(v.string()),
  activity: v.optional(v.string()),
});

const cloudConversationPageValidator = paginationResultValidator(
  cloudConversationListProjectionValidator,
);

const cloudAgentThreadProjectionValidator = v.object({
  threadId: v.string(),
  ownerId: v.string(),
  conversationId: v.string(),
  parentTurnId: v.optional(v.string()),
  description: v.string(),
  placement: executionPlacementValidator,
  agentType: v.string(),
  status: v.string(),
  resultJson: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const cloudAgentThreadPageValidator = paginationResultValidator(
  cloudAgentThreadProjectionValidator,
);

const cloudAppRowValidator = v.object({
  _id: v.id("cloud_apps"),
  _creationTime: v.number(),
  appId: v.string(),
  ownerId: v.string(),
  slug: v.string(),
  title: v.string(),
  status: v.string(),
  activeBuildId: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const cloudAppBuildRowValidator = v.object({
  _id: v.id("cloud_app_builds"),
  _creationTime: v.number(),
  buildId: v.string(),
  appId: v.string(),
  ownerId: v.string(),
  turnId: v.optional(v.string()),
  status: v.string(),
  artifactPrefix: v.optional(v.string()),
  previewUrl: v.optional(v.string()),
  slug: v.optional(v.string()),
  metricsJson: v.optional(v.string()),
  callbackTitle: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const publicCloudAppValidator = v.object({
  appId: v.string(),
  ownerId: v.string(),
  slug: v.string(),
  title: v.string(),
  status: v.string(),
  activeBuildId: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const publicCloudBuildValidator = v.object({
  buildId: v.string(),
  appId: v.string(),
  ownerId: v.string(),
  status: v.string(),
  artifactPrefix: v.optional(v.string()),
  previewUrl: v.optional(v.string()),
  slug: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const projectCloudApp = (row: Doc<"cloud_apps">) => ({
  appId: row.appId,
  ownerId: row.ownerId,
  slug: row.slug,
  title: row.title,
  status: row.status,
  ...(row.activeBuildId === undefined
    ? {}
    : { activeBuildId: row.activeBuildId }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const projectCloudBuild = (row: Doc<"cloud_app_builds">) => ({
  buildId: row.buildId,
  appId: row.appId,
  ownerId: row.ownerId,
  status: row.status,
  ...(row.artifactPrefix === undefined
    ? {}
    : { artifactPrefix: row.artifactPrefix }),
  ...(row.previewUrl === undefined ? {} : { previewUrl: row.previewUrl }),
  ...(row.slug === undefined ? {} : { slug: row.slug }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const projectCloudConversation = (row: {
  conversationId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}) => ({
  conversationId: row.conversationId,
  ownerId: row.ownerId,
  title: row.title,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const projectCloudConversationListItem = (row: {
  conversationId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastPreview?: string;
  lastRole?: string;
  activity?: string;
}) => ({
  ...projectCloudConversation(row),
  ...(row.lastPreview !== undefined ? { lastPreview: row.lastPreview } : {}),
  ...(row.lastRole !== undefined ? { lastRole: row.lastRole } : {}),
  ...(row.activity !== undefined ? { activity: row.activity } : {}),
});

const projectCloudAgentThread = (row: Doc<"cloud_agent_threads">) => ({
  threadId: row.threadId,
  ownerId: row.ownerId,
  conversationId: row.conversationId,
  ...(row.parentTurnId === undefined ? {} : { parentTurnId: row.parentTurnId }),
  description: row.description,
  placement: row.placement,
  agentType: row.agentType,
  status: row.status,
  ...(row.resultJson === undefined ? {} : { resultJson: row.resultJson }),
  ...(row.errorMessage === undefined ? {} : { errorMessage: row.errorMessage }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * A retried send must not become a second turn. The composer mints one id per
 * message and replays it on retry; if a turn already carries it, that turn is
 * the answer — before any quota is charged, because the first attempt already
 * paid.
 */
const findTurnByClientMsgId = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    clientMsgId: string;
    requestedConversationId?: string;
    intentFingerprint: string;
    allowedKinds: readonly ("chat" | "build")[];
  },
): Promise<{
  conversationId: string;
  appId?: string;
  turnId: string;
} | null> => {
  const existing = await ctx.db
    .query("agent_turns")
    .withIndex("by_ownerId_and_clientMsgId", (q) =>
      q.eq("ownerId", args.ownerId).eq("clientMsgId", args.clientMsgId),
    )
    .take(2);
  if (existing.length > 1) {
    throw new ConvexError(
      "That reliable message id has conflicting prior deliveries.",
    );
  }
  const turn = existing[0];
  if (!turn) return null;
  const exactConversationAuthority =
    args.requestedConversationId === undefined ||
    turn.conversationId === args.requestedConversationId;
  if (
    !turn.conversationId ||
    !args.allowedKinds.includes(turn.kind as "chat" | "build") ||
    turn.ownerGeneration !== args.ownerGeneration ||
    turn.chatIntentFingerprint !== args.intentFingerprint ||
    !exactConversationAuthority
  ) {
    throw new ConvexError(
      "That reliable message id was already used for a different request.",
    );
  }
  return {
    conversationId: turn.conversationId,
    ...(turn.appId ? { appId: turn.appId } : {}),
    turnId: turn.turnId,
  };
};

type ExecutionPlacementAttempt = {
  dispatchId: string;
  attemptId: string;
  attemptGeneration: number;
};

const executionPlacementAttemptValidator = v.object({
  dispatchId: v.string(),
  attemptId: v.string(),
  attemptGeneration: v.number(),
});

const assertExecutionPlacementAdmission = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    kind: "chat" | "agent";
    clientMsgId?: string;
    parentTurnId?: string;
    threadId?: string;
    placementAttempt?: ExecutionPlacementAttempt;
  },
) => {
  const attempt = args.placementAttempt;
  if (!attempt) return;
  const dispatch = await ctx.db
    .query("execution_dispatches")
    .withIndex("by_dispatchId", (q) => q.eq("dispatchId", attempt.dispatchId))
    .unique();
  const matches =
    Number.isSafeInteger(attempt.attemptGeneration) &&
    attempt.attemptGeneration > 0 &&
    args.clientMsgId === attempt.dispatchId &&
    dispatch?.ownerId === args.ownerId &&
    dispatch.ownerGeneration === args.ownerGeneration &&
    dispatch.kind === args.kind &&
    dispatch.conversationId === args.conversationId &&
    (args.kind === "chat" ||
      (dispatch.parentTurnId === args.parentTurnId &&
        dispatch.threadId === args.threadId)) &&
    dispatch.placement === "cloud" &&
    dispatch.state === "cloud_committed" &&
    dispatch.cloudAttemptId === attempt.attemptId &&
    dispatch.attemptGeneration === attempt.attemptGeneration;
  if (!matches) {
    throw new ConvexError({
      code: "EXECUTION_PLACEMENT_FENCE_CLOSED",
      message:
        "This execution placement attempt no longer owns cloud admission.",
    });
  }
};

const canceledPlacementResolutionValidator = v.union(
  v.null(),
  v.object({ status: v.literal("canceled") }),
  v.object({
    status: v.literal("turn"),
    kind: v.union(v.literal("chat"), v.literal("agent")),
    conversationId: v.string(),
    threadId: v.optional(v.string()),
    turnId: v.string(),
    attemptGeneration: v.optional(v.number()),
  }),
);

/**
 * Serializes cancellation against placement-only cloud admission. Both this
 * mutation and the fenced admission mutation read the same dispatch and stable
 * turn-id range, so either the turn commits first and is returned for external
 * cancellation, or cancellation terminalizes first and later admission fails.
 */
export const resolveCanceledExecutionPlacementAdmissionInternal =
  internalMutation({
    args: {
      ownerId: v.string(),
      ownerGeneration: v.string(),
      dispatchId: v.string(),
      attemptId: v.optional(v.string()),
      attemptGeneration: v.number(),
      now: v.number(),
    },
    returns: canceledPlacementResolutionValidator,
    handler: async (ctx, args) => {
      const dispatch = await ctx.db
        .query("execution_dispatches")
        .withIndex("by_dispatchId", (q) => q.eq("dispatchId", args.dispatchId))
        .unique();
      if (
        !dispatch ||
        dispatch.ownerId !== args.ownerId ||
        dispatch.ownerGeneration !== args.ownerGeneration ||
        dispatch.placement !== "cloud" ||
        dispatch.state !== "cancel_pending"
      ) {
        return null;
      }
      const turns = await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_clientMsgId", (q) =>
          q.eq("ownerId", args.ownerId).eq("clientMsgId", args.dispatchId),
        )
        .take(2);
      const turn = turns.length === 1 ? turns[0] : undefined;
      const exactTurn =
        turn !== undefined &&
        turn.ownerId === args.ownerId &&
        turn.ownerGeneration === args.ownerGeneration &&
        turn.kind === dispatch.kind &&
        turn.conversationId === dispatch.conversationId &&
        turn.clientMsgId === args.dispatchId &&
        (dispatch.cloudTurnId === undefined ||
          turn.turnId === dispatch.cloudTurnId) &&
        (dispatch.kind === "chat" ||
          (Boolean(turn.threadId) &&
            (dispatch.threadId === undefined ||
              turn.threadId === dispatch.threadId) &&
            Number.isSafeInteger(turn.attemptGeneration) &&
            turn.attemptGeneration! > 0));
      if (exactTurn && turn) {
        return {
          status: "turn" as const,
          kind: turn.kind as "chat" | "agent",
          conversationId: turn.conversationId!,
          ...(turn.threadId ? { threadId: turn.threadId } : {}),
          turnId: turn.turnId,
          ...(turn.attemptGeneration !== undefined
            ? { attemptGeneration: turn.attemptGeneration }
            : {}),
        };
      }
      // A row exists for this reliable dispatch id but does not name the exact
      // canceled placement. Never reinterpret duplicate/stale residue as
      // proof that admission won, and never terminalize the placement as if no
      // turn existed: reconciliation must retain the cancel_pending record for
      // an operator-safe retry.
      if (turns.length > 0) return null;
      if (
        !args.attemptId ||
        dispatch.cloudAttemptId !== args.attemptId ||
        dispatch.attemptGeneration !== args.attemptGeneration
      ) {
        return null;
      }
      await ctx.db.patch(dispatch._id, {
        state: "canceled",
        cloudAttemptId: undefined,
        cloudAttemptLeaseExpiresAt: undefined,
        terminalAt: args.now,
        revision: dispatch.revision + 1,
        updatedAt: args.now,
      });
      const payload = await ctx.db
        .query("execution_dispatch_payloads")
        .withIndex("by_dispatchId", (q) => q.eq("dispatchId", args.dispatchId))
        .unique();
      if (payload) await ctx.db.delete(payload._id);
      return { status: "canceled" as const };
    },
  });

const MAX_DISPATCHED_PROMPT_CHARS = 8_000;
const LEGACY_SANDBOX_ADMISSION_SCAN_LIMIT = 256;

/**
 * Contract C1: the shared chat-turn entry for non-composer callers
 * (scheduled turns, desktop dispatch). Draws on the same per-owner chat
 * budget as the composer so a robot caller cannot outspend a human one.
 */
export const startCloudChatTurnInternal = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.optional(v.string()),
    prompt: v.string(),
    hidden: v.optional(v.boolean()),
    hiddenMessage: v.optional(v.boolean()),
    hiddenTurn: v.optional(v.boolean()),
    source: v.optional(v.string()),
    clientMsgId: v.optional(v.string()),
    /** Drive paths of the turn's attachments; the DO hydrates them. */
    attachments: v.optional(v.array(v.string())),
    placementAttempt: v.optional(executionPlacementAttemptValidator),
    execution: v.optional(cloudExecutionSelectionValidator),
    ownerGeneration: v.string(),
    now: v.number(),
  },
  returns: v.object({ conversationId: v.string(), turnId: v.string() }),
  handler: async (ctx, args) => {
    const lifecycle = await assertOwnerDataWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    await assertOwnerMigrationWriteAllowed(ctx, args.ownerId);
    const prompt = args.prompt.trim();
    if (!prompt || prompt.length > MAX_DISPATCHED_PROMPT_CHARS) {
      throw new ConvexError(
        `A cloud chat turn needs 1–${MAX_DISPATCHED_PROMPT_CHARS} characters.`,
      );
    }
    const clientMsgId = normalizeClientMsgId(args.clientMsgId);
    const hiddenMessage = args.hiddenMessage ?? args.hidden === true;
    const hiddenTurn = args.hiddenTurn ?? args.hidden === true;
    const requestedExecution = args.execution
      ? normalizeCloudExecutionSelection(args.execution)
      : undefined;
    const normalizedAttachments = normalizeChatAttachmentPaths(
      args.attachments ?? [],
    );
    const intentFingerprint = clientMsgId
      ? await chatIntentFingerprint({
          authority: args.placementAttempt ? "chat-placement" : "chat-internal",
          conversationId: args.conversationId,
          prompt,
          source: args.source,
          hiddenMessage,
          hiddenTurn,
          attachments: normalizedAttachments,
          execution: requestedExecution,
        })
      : undefined;
    if (clientMsgId) {
      const replayed = await findTurnByClientMsgId(ctx, {
        ownerId: args.ownerId,
        ownerGeneration: lifecycle.generation,
        clientMsgId,
        requestedConversationId: args.conversationId,
        intentFingerprint: intentFingerprint!,
        allowedKinds: ["chat"],
      });
      if (replayed) return replayed;
    }
    await assertExecutionPlacementAdmission(ctx, {
      ownerId: args.ownerId,
      ownerGeneration: lifecycle.generation,
      conversationId: args.conversationId ?? "",
      kind: "chat",
      ...(clientMsgId ? { clientMsgId } : {}),
      ...(args.placementAttempt
        ? { placementAttempt: args.placementAttempt }
        : {}),
    });
    // Account linking creates this fence synchronously before the authenticated
    // session changes owners. Refuse every new source-owner turn while the
    // transfer is unresolved so a stale scheduled fire or already-running
    // caller cannot recreate anonymous conversations after the migration's
    // final residue check.
    const ownerMigrations = await ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_fromOwnerId_and_updatedAt", (q) =>
        q.eq("fromOwnerId", args.ownerId),
      )
      .order("desc")
      .take(8);
    if (ownerMigrations.length > 0) {
      throw new ConvexError(
        "This identity is being linked to an account. Retry the turn after the transfer finishes.",
      );
    }
    // Scheduled fires already passed their own per-owner daily budget in
    // cloud_schedule.ts; charging them here too would let a robot caller
    // exhaust the human's composer allowance.
    const scheduled = args.source === "schedule";
    if (!scheduled) {
      const { quota } = await resolveCloudPlan(ctx, args.ownerId);
      await enforceMutationRateLimit(
        ctx,
        "cloud_chat_start",
        args.ownerId,
        { rate: quota.burstStarts * 5, periodMs: 10 * 60_000 },
        "Too many cloud turns in a row. Wait a moment and try again.",
      );
      await enforceMutationRateLimit(
        ctx,
        "cloud_chat_daily",
        args.ownerId,
        { rate: quota.dailyTurns * 20, periodMs: 24 * 60 * 60_000 },
        "You've reached today's cloud chat limit. Try again tomorrow.",
      );
    }
    return await startChatTurn(ctx, {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      prompt,
      source: args.source,
      hiddenMessage,
      hiddenTurn,
      ...(clientMsgId ? { clientMsgId } : {}),
      ...(normalizedAttachments.length
        ? { attachments: normalizedAttachments }
        : {}),
      ...(requestedExecution ? { execution: requestedExecution } : {}),
      ownerGeneration: lifecycle.generation,
      ...(intentFingerprint
        ? { chatIntentFingerprint: intentFingerprint }
        : {}),
      now: args.now,
    });
  },
});

export const createTurnInternal = internalMutation({
  args: {
    turnId: v.string(),
    sessionId: v.string(),
    ownerId: v.string(),
    conversationId: v.optional(v.string()),
    appId: v.string(),
    prompt: v.string(),
    ownerGeneration: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (!app) {
      await ctx.db.insert("cloud_apps", {
        appId: args.appId,
        ownerId: args.ownerId,
        slug: "orbit-habits",
        title: "Orbit",
        status: "building",
        createdAt: args.now,
        updatedAt: args.now,
      });
    }
    await ctx.db.insert("agent_turns", {
      turnId: args.turnId,
      sessionId: args.sessionId,
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      appId: args.appId,
      prompt: args.prompt,
      status: "running",
      createdAt: args.now,
      updatedAt: args.now,
    });
    return null;
  },
});

export const getAppInternal = internalQuery({
  args: { appId: v.string() },
  returns: v.union(cloudAppRowValidator, v.null()),
  handler: (ctx, args) =>
    ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique(),
});

export const getBuildInternal = internalQuery({
  args: { buildId: v.string() },
  returns: v.union(cloudAppBuildRowValidator, v.null()),
  handler: (ctx, args) =>
    ctx.db
      .query("cloud_app_builds")
      .withIndex("by_buildId", (q) => q.eq("buildId", args.buildId))
      .unique(),
});

export const checkQuotaInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.object({ allowed: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const dayStart = Date.now() - 24 * 60 * 60 * 1_000;
    const turns = await ctx.db
      .query("agent_turns")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).gte("createdAt", dayStart),
      )
      .take(10);
    if (turns.some((turn) => turn.status === "running")) {
      return {
        allowed: false,
        reason:
          "Your plan allows one active build at a time. Wait for it to finish or cancel it.",
      };
    }
    if (turns.length >= 10) {
      return {
        allowed: false,
        reason:
          "Daily cloud-build quota reached. Try again after the rolling 24-hour window resets.",
      };
    }
    return { allowed: true };
  },
});

const requireOwnerId = requireUserId;

/**
 * Prove that the Convex connection has switched to the same immutable Better
 * Auth owner currently visible to the renderer. The expected subject is part
 * of the query key, so an account transition cannot reuse the prior owner's
 * conversation-list snapshot while the socket is still authenticating.
 */
export const confirmMySessionIdentity = query({
  args: {
    expectedSubject: v.string(),
    identityRevision: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.identityRevision)) return false;
    const identity = await getUserIdentityOrNull(ctx);
    if (!identity) return false;
    return sessionIdentityMatchesExpectedSubject(
      identity.subject,
      args.expectedSubject,
    );
  },
});

/**
 * Returns the lifecycle authority used to fence cloud-conversation state.
 *
 * Unlike execution placement, ordinary hosted chat is available to the
 * Better Auth anonymous owner created during onboarding. Keep this query in
 * the conversation domain so anonymous chat never has to call a
 * connected-account-only device-placement endpoint.
 */
export const getMyCloudConversationIdentity = query({
  args: {},
  returns: v.object({
    ownerId: v.string(),
    ownerGeneration: v.string(),
  }),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const lifecycle = await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    return {
      ownerId,
      ownerGeneration: lifecycle.generation,
    };
  },
});

/**
 * Creates the durable identity for a conversation without starting a model
 * turn. The client key makes a lost mutation response safe to retry; the
 * server-generated UUID remains the only identity used to address the DO.
 */
export const createMyConversation = mutation({
  args: {
    clientCreateId: v.string(),
    expectedOwnerGeneration: v.string(),
    title: v.optional(v.string()),
    execution: v.optional(cloudExecutionSelectionValidator),
  },
  returns: cloudConversationProjectionValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    await assertOwnerDataWriteAllowed(
      ctx,
      ownerId,
      args.expectedOwnerGeneration,
    );
    const clientCreateId = normalizeClientCreateId(args.clientCreateId);
    const existing = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_ownerId_and_clientCreateId", (q) =>
        q.eq("ownerId", ownerId).eq("clientCreateId", clientCreateId),
      )
      .unique();
    if (existing) {
      if (existing.deletedAt !== undefined) {
        throw new ConvexError("Conversation not found.");
      }
      return projectCloudConversation(existing);
    }
    const ownerMigrations = await ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_fromOwnerId_and_updatedAt", (q) =>
        q.eq("fromOwnerId", ownerId),
      )
      .order("desc")
      .take(8);
    if (ownerMigrations.length > 0) {
      throw new ConvexError(
        "This identity is being linked to an account. Retry after the transfer finishes.",
      );
    }

    await enforceMutationRateLimit(
      ctx,
      "cloud_conversation_create",
      ownerId,
      { rate: 30, periodMs: 10 * 60_000 },
      "Too many conversations created at once. Wait a moment and try again.",
    );
    const execution = args.execution
      ? await assertExecutionAvailable(ctx, ownerId, args.execution)
      : undefined;
    const now = Date.now();
    const rawTitle = args.title?.trim() ?? "";
    const title =
      rawTitle.length > CHAT_TITLE_MAX
        ? `${rawTitle.slice(0, CHAT_TITLE_MAX - 3)}…`
        : rawTitle;
    const conversation = {
      conversationId: crypto.randomUUID(),
      ownerId,
      clientCreateId,
      allowEmpty: true,
      ...(execution ? { execution } : {}),
      title,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert("cloud_conversations", conversation);
    return projectCloudConversation(conversation);
  },
});

export const getMyConversation = query({
  args: { conversationId: v.string() },
  returns: v.union(cloudConversationProjectionValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const row = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .unique();
    if (!row || row.ownerId !== ownerId || row.deletedAt !== undefined) {
      return null;
    }
    return projectCloudConversation(row);
  },
});

export const listMyConversations = query({
  args: {},
  returns: v.array(cloudConversationListProjectionValidator),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const rows = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_ownerId_and_deletedAt_and_updatedAt", (q) =>
        q.eq("ownerId", ownerId).eq("deletedAt", undefined),
      )
      .order("desc")
      .take(25);
    return rows.map(projectCloudConversationListItem);
  },
});

const MAX_CONVERSATIONS_PER_PAGE = 50;

/**
 * Deterministic database watermark for one sidebar-history walk. Convex may
 * cache a query with identical args, so a wall-clock-only result can remain
 * unchanged across reopen and strand rows beyond the bounded recent overlay.
 * Reading the newest live owner row makes conversation changes invalidate the
 * snapshot; the client freezes that exact updatedAt while the popover is open.
 */
export const getMyConversationHistorySnapshot = query({
  args: {},
  returns: v.object({ snapshotUpdatedAt: v.number() }),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const newest = await ctx.db
      .query("cloud_conversations")
      .withIndex(
        "by_ownerId_and_deletedAt_and_updatedAt_and_conversationId",
        (q) => q.eq("ownerId", ownerId).eq("deletedAt", undefined),
      )
      .order("desc")
      .first();
    return { snapshotUpdatedAt: newest?.updatedAt ?? 0 };
  },
});

/**
 * Owner-scoped sidebar history. The first page is the newest conversations;
 * each cursor fetches the next-older slice without ever scanning tombstones.
 *
 * `listMyConversations` intentionally remains as the small reactive boot
 * snapshot used by root/mini selection. This query is the discoverability
 * path: a user can keep paging until every live conversation is reopenable.
 */
export const listMyConversationsPage = query({
  args: {
    snapshotUpdatedAt: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: cloudConversationPageValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    if (
      !Number.isSafeInteger(args.snapshotUpdatedAt) ||
      args.snapshotUpdatedAt < 0
    ) {
      throw new ConvexError("Invalid conversation history snapshot.");
    }
    const numItems = Math.min(
      Math.max(args.paginationOpts.numItems, 1),
      MAX_CONVERSATIONS_PER_PAGE,
    );
    const result = await ctx.db
      .query("cloud_conversations")
      .withIndex(
        "by_ownerId_and_deletedAt_and_updatedAt_and_conversationId",
        (q) =>
          q
            .eq("ownerId", ownerId)
            .eq("deletedAt", undefined)
            .lte("updatedAt", args.snapshotUpdatedAt),
      )
      .order("desc")
      .paginate({
        cursor: args.paginationOpts.cursor,
        numItems,
      });
    return {
      ...result,
      page: result.page.map(projectCloudConversationListItem),
    };
  },
});

export const listMyApps = query({
  args: {},
  returns: v.array(publicCloudAppValidator),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const rows = await ctx.db
      .query("cloud_apps")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(50);
    return rows.map(projectCloudApp);
  },
});

/**
 * Where the client learns how to reach its conversation DO. Derived from
 * CLOUD_BUILDER_URL so no new build-time client key is needed (no VITE_ var,
 * no Expo `extra` entry) and mobile gets it for free. Authenticated: the
 * origin is only useful to someone who already holds a token for it, and
 * unauthenticated discovery hands an attacker a map.
 */
export const getCloudRealtimeConfig = query({
  args: {},
  returns: v.object({
    /** Absent when the deployment has no builder: clients stay on polling. */
    httpOrigin: v.union(v.string(), v.null()),
    socketOrigin: v.union(v.string(), v.null()),
    protocol: v.number(),
  }),
  handler: async (ctx) => {
    await requireOwnerId(ctx);
    const raw = process.env.CLOUD_BUILDER_URL?.trim().replace(/\/+$/, "");
    if (!raw) return { httpOrigin: null, socketOrigin: null, protocol: 1 };
    return {
      httpOrigin: raw,
      socketOrigin: raw.replace(/^http/, "ws"),
      protocol: 1,
    };
  },
});

export const listMyAppBuilds = query({
  args: { appId: v.string() },
  returns: v.array(publicCloudBuildValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (!app || app.ownerId !== ownerId)
      throw new ConvexError("App not found.");
    const builds = await ctx.db
      .query("cloud_app_builds")
      .withIndex("by_appId_and_createdAt", (q) => q.eq("appId", args.appId))
      .order("desc")
      .take(5);
    return builds.map(projectCloudBuild);
  },
});

export const getMyCloudLimits = query({
  args: {},
  returns: v.object({
    plan: v.string(),
    dailyTurns: v.number(),
    concurrentTurns: v.number(),
  }),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const { plan, quota } = await resolveCloudPlan(ctx, ownerId);
    return {
      plan,
      dailyTurns: quota.dailyTurns,
      concurrentTurns: quota.concurrentTurns,
    };
  },
});

type CloudComposerTurnArgs = {
  ownerId: string;
  ownerGeneration?: string;
  prompt: string;
  conversationId?: string;
  appId?: string;
  clientMsgId?: string;
  locale?: string;
  attachments?: string[];
  execution?: CloudExecutionSelection;
  placementAttempt?: ExecutionPlacementAttempt;
  now: number;
};

const startCloudComposerTurn = async (
  ctx: MutationCtx,
  args: CloudComposerTurnArgs,
): Promise<{ conversationId: string; appId?: string; turnId: string }> => {
  const ownerId = args.ownerId;
  const prompt = args.prompt.trim();
  if (!prompt || prompt.length > 4_000) {
    throw new ConvexError("Describe the app in 1–4,000 characters.");
  }
  // Lifecycle/ownership is fenced before even an idempotent response is
  // returned. A stale generation may not adopt residue from its predecessor.
  const lifecycle = await assertOwnerDataWriteAllowed(
    ctx,
    ownerId,
    args.ownerGeneration,
  );
  await assertOwnerMigrationWriteAllowed(ctx, ownerId, lifecycle.generation);
  const clientMsgId = normalizeClientMsgId(args.clientMsgId);
  const normalizedLocale = normalizeLocale(args.locale);
  const normalizedAttachments = normalizeChatAttachmentPaths(
    args.attachments ?? [],
  );
  const requestedExecution = args.execution
    ? normalizeCloudExecutionSelection(args.execution)
    : undefined;
  const intentFingerprint = clientMsgId
    ? await chatIntentFingerprint({
        authority: args.placementAttempt
          ? "composer-placement"
          : "composer-direct",
        conversationId: args.conversationId,
        appId: args.appId,
        prompt,
        locale: normalizedLocale,
        attachments: normalizedAttachments,
        execution: requestedExecution,
      })
    : undefined;
  // Ahead of every quota and rate check: an exact replay is not a new request,
  // and charging it would punish the user for a dropped response.
  if (clientMsgId) {
    const replayed = await findTurnByClientMsgId(ctx, {
      ownerId,
      ownerGeneration: lifecycle.generation,
      clientMsgId,
      requestedConversationId: args.conversationId,
      intentFingerprint: intentFingerprint!,
      allowedKinds: ["chat", "build"],
    });
    if (replayed) return replayed;
  }
  await assertExecutionPlacementAdmission(ctx, {
    ownerId,
    ownerGeneration: lifecycle.generation,
    conversationId: args.conversationId ?? "",
    kind: "chat",
    ...(clientMsgId ? { clientMsgId } : {}),
    ...(args.placementAttempt
      ? { placementAttempt: args.placementAttempt }
      : {}),
  });
  const { plan, quota } = await resolveCloudPlan(ctx, ownerId);

  // Resolve the target app first: turns aimed at an active app that has
  // registered operations enter the routed lane, which never reserves build
  // quota up front (the router re-checks it if the model chooses a build).
  let targetApp: {
    appId: string;
    ownerId: string;
    status: string;
    title?: string;
  } | null = null;
  let inferredAppId: string | undefined;
  let wantsNewApp = false;
  if (args.appId) {
    const requestedAppId = args.appId;
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", requestedAppId))
      .unique();
    if (!app || app.ownerId !== ownerId)
      throw new ConvexError("App not found.");
    targetApp = app;
  } else {
    // No explicit target: infer it from the message so the normal chat
    // composer needs no app picker. Naming an app targets it; with exactly
    // one app, follow-ups target it unless the user asks for something new.
    const myApps = await ctx.db
      .query("cloud_apps")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(20);
    const active = myApps.filter((app) => app.status === "active");
    const escapeRegExp = (value: string) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = active.filter(
      (app) =>
        app.title !== "New app" &&
        new RegExp(
          `(^|[^A-Za-z0-9])${escapeRegExp(app.title)}([^A-Za-z0-9]|$)`,
          "i",
        ).test(prompt),
    );
    wantsNewApp =
      /\bnew app\b/i.test(prompt) ||
      /\b(?:make|build|create)\b[\s\S]{0,60}\bapp\b/i.test(prompt);
    if (named.length === 1) {
      targetApp = named[0]!;
      inferredAppId = named[0]!.appId;
    } else if (!wantsNewApp && named.length === 0 && active.length === 1) {
      targetApp = active[0]!;
      inferredAppId = active[0]!.appId;
    }
  }
  const opsManifest =
    targetApp && targetApp.status === "active"
      ? await ctx.db
          .query("cloud_app_operations")
          .withIndex("by_appId", (q) => q.eq("appId", targetApp!.appId))
          .unique()
      : null;
  const routed = opsManifest !== null;
  // No app targeted and no clear ask for one: this is plain chat. It runs
  // as the orchestrator loop in the builder DO — token cost only, no
  // sandbox, no app row. Only an explicit "make/build/create an app"
  // fallthrough still enters the legacy build lane with a fresh app.
  const chatLane = !routed && !targetApp && !wantsNewApp;

  if (chatLane) {
    await enforceMutationRateLimit(
      ctx,
      "cloud_chat_start",
      ownerId,
      { rate: quota.burstStarts * 5, periodMs: 10 * 60_000 },
      "You're sending messages quickly. Wait a moment and try again.",
    );
    await enforceMutationRateLimit(
      ctx,
      "cloud_chat_daily",
      ownerId,
      { rate: quota.dailyTurns * 20, periodMs: 24 * 60 * 60_000 },
      "You've reached today's cloud chat limit. Try again tomorrow.",
    );
  } else if (routed) {
    await enforceMutationRateLimit(
      ctx,
      "cloud_ops_start",
      ownerId,
      { rate: quota.burstStarts * 5, periodMs: 10 * 60_000 },
      "Too many app requests in a row. Wait a moment and try again.",
    );
    await enforceMutationRateLimit(
      ctx,
      "cloud_ops_daily",
      ownerId,
      { rate: quota.dailyTurns * 20, periodMs: 24 * 60 * 60_000 },
      "You've reached today's limit for quick app changes. Try again tomorrow.",
    );
  } else {
    await enforceMutationRateLimit(
      ctx,
      "cloud_apps_start",
      ownerId,
      { rate: quota.burstStarts, periodMs: 10 * 60_000 },
      "You're sending requests quickly. Give Stella a few minutes, then try again.",
    );
    const buildTurns = await listRecentBuildTurns(
      ctx,
      ownerId,
      quota.dailyTurns + 1,
    );
    const running = buildTurns.filter((turn) => turn.status === "running");
    if (running.length >= quota.concurrentTurns) {
      throw new ConvexError(
        "Stella is still working on an earlier change. Wait for it to finish, then try again.",
      );
    }
    if (buildTurns.length >= quota.dailyTurns) {
      throw new ConvexError(
        `You've used all ${quota.dailyTurns} app updates included with the ${
          plan === "free" ? "Free" : plan
        } plan today. Try again tomorrow.`,
      );
    }
  }

  const now = args.now;
  if (chatLane) {
    return await startChatTurn(ctx, {
      ownerId,
      conversationId: args.conversationId,
      prompt,
      ...(clientMsgId ? { clientMsgId } : {}),
      ...(normalizedLocale ? { locale: normalizedLocale } : {}),
      ...(normalizedAttachments.length
        ? { attachments: normalizedAttachments }
        : {}),
      ...(requestedExecution ? { execution: requestedExecution } : {}),
      ownerGeneration: lifecycle.generation,
      ...(intentFingerprint
        ? { chatIntentFingerprint: intentFingerprint }
        : {}),
      now,
    });
  }

  const explicitExecution = requestedExecution
    ? await assertExecutionAvailable(ctx, ownerId, requestedExecution)
    : undefined;
  const conversation = await resolveConversationId(ctx, {
    ownerId,
    conversationId: args.conversationId,
    title: prompt,
    ...(explicitExecution ? { execution: explicitExecution } : {}),
    now,
  });
  const execution = explicitExecution
    ? explicitExecution
    : conversation.execution
      ? await assertExecutionAvailable(ctx, ownerId, conversation.execution)
      : await resolveOwnerExecutionInMutation(ctx, ownerId);
  if (!conversation.execution) {
    await ctx.db.patch(conversation.documentId, { execution });
  }
  const { conversationId } = conversation;
  const turnId = crypto.randomUUID();
  const turnToken =
    crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");

  let appId = args.appId ?? inferredAppId;
  let isNewApp = false;
  if (appId) {
    if (!targetApp) throw new ConvexError("App not found.");
  } else {
    appId = `app-${crypto.randomUUID()}`;
    isNewApp = true;
    // Provisional name only — the real app name arrives with the first
    // finished build and replaces this everywhere it is shown.
    await ctx.db.insert("cloud_apps", {
      appId,
      ownerId,
      slug: `orbit-${appId.slice(-8)}`,
      title: "New app",
      status: "building",
      createdAt: now,
      updatedAt: now,
    });
  }

  const sessionId = routed
    ? `ops-${turnId.slice(0, 8)}`
    : `cloud-${turnId.slice(0, 8)}`;
  await ctx.db.insert("agent_turns", {
    turnId,
    sessionId,
    ownerId,
    conversationId,
    appId,
    prompt,
    status: "running",
    lane: routed ? "auto" : "build",
    kind: "build",
    ...(clientMsgId ? { clientMsgId } : {}),
    ownerGeneration: lifecycle.generation,
    ...(intentFingerprint ? { chatIntentFingerprint: intentFingerprint } : {}),
    execution,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(
    0,
    routed ? routeCloudTurnRef : runCloudTurnRef,
    {
      ownerId,
      conversationId,
      appId,
      turnId,
      sessionId,
      prompt,
      turnToken,
      ownerGeneration: lifecycle.generation,
      execution,
      ...(!routed && process.env.CONVEX_SITE_URL?.trim()
        ? { convexCallbackBase: process.env.CONVEX_SITE_URL.trim() }
        : {}),
    },
  );
  return { conversationId, appId, turnId };
};

const cloudComposerTurnArgsValidator = {
  prompt: v.string(),
  conversationId: v.optional(v.string()),
  appId: v.optional(v.string()),
  /** Per-message id from the composer; makes a retried send idempotent. */
  clientMsgId: v.optional(v.string()),
  /** Client UI locale for the reply-language directive (e.g. "es"). */
  locale: v.optional(v.string()),
  /** Drive paths of attached images the turn should see as image blocks. */
  attachments: v.optional(v.array(v.string())),
  /** Exact route for this conversation from this turn forward. */
  execution: v.optional(cloudExecutionSelectionValidator),
};

const cloudComposerTurnResultValidator = v.object({
  conversationId: v.string(),
  appId: v.optional(v.string()),
  turnId: v.string(),
});

export const startCloudChat = mutation({
  args: {
    ...cloudComposerTurnArgsValidator,
    expectedOwnerGeneration: v.string(),
  },
  returns: cloudComposerTurnResultValidator,
  handler: async (ctx, args) => {
    const { expectedOwnerGeneration, ...composerArgs } = args;
    return await startCloudComposerTurn(ctx, {
      ...composerArgs,
      ownerId: await requireOwnerId(ctx),
      ownerGeneration: expectedOwnerGeneration,
      now: Date.now(),
    });
  },
});

/**
 * Browser placement entry. It shares the signed-in/anonymous composer router
 * byte-for-byte, but admission is fenced to one current placement attempt
 * before quota, app inference, turn insertion, or scheduling can occur.
 */
export const startCloudComposerTurnInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    ...cloudComposerTurnArgsValidator,
    placementAttempt: executionPlacementAttemptValidator,
    now: v.number(),
  },
  returns: cloudComposerTurnResultValidator,
  handler: async (ctx, args) => await startCloudComposerTurn(ctx, args),
});

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

export const runCloudTurnInternal = internalAction({
  args: {
    ownerId: v.string(),
    conversationId: v.string(),
    appId: v.string(),
    turnId: v.string(),
    sessionId: v.string(),
    prompt: v.string(),
    turnToken: v.string(),
    ownerGeneration: v.string(),
    execution: v.optional(cloudExecutionSelectionValidator),
    convexCallbackBase: v.optional(v.string()),
    dispatchAttempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const builderSecret = process.env.BUILDER_SERVICE_SECRET?.trim();
    const failure = "Stella couldn't start on this. Try again in a moment.";
    const dispatchAttempt = args.dispatchAttempt ?? 0;
    const pinnedCallbackBase =
      args.convexCallbackBase?.trim() ?? process.env.CONVEX_SITE_URL?.trim();
    // Publish the exact successor before any other await. A fetch timeout or
    // lost 202 response is ambiguous: the BuildSession may already have
    // durably admitted this exact turn, so only an idempotent replay may
    // decide whether dispatch is complete.
    const retryId = await ctx.scheduler.runAfter(45_000, runCloudTurnRef, {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      appId: args.appId,
      turnId: args.turnId,
      sessionId: args.sessionId,
      prompt: args.prompt,
      turnToken: args.turnToken,
      ownerGeneration: args.ownerGeneration,
      ...(args.execution ? { execution: args.execution } : {}),
      ...(pinnedCallbackBase ? { convexCallbackBase: pinnedCallbackBase } : {}),
      dispatchAttempt: dispatchAttempt + 1,
    });
    try {
      await assertExpectedOwnerGenerationActive(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    } catch (error) {
      const data =
        error && typeof error === "object" && "data" in error
          ? (error as { data?: unknown }).data
          : undefined;
      const definitelyStale =
        data !== null &&
        typeof data === "object" &&
        (data as { code?: unknown }).code === "OWNER_DATA_GENERATION_STALE";
      if (definitelyStale) {
        await ctx.scheduler.cancel(retryId).catch(() => undefined);
      }
      console.warn(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: definitelyStale
            ? "build_dispatch_authority_lost"
            : "build_dispatch_authority_retrying",
          turnId: args.turnId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
    if (!builderUrl || !builderSecret || !pinnedCallbackBase) {
      await ctx.runMutation(failCloudTurnRef, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        turnId: args.turnId,
        message: failure,
        now: Date.now(),
      });
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    let dispatchable: boolean;
    try {
      dispatchable = await ctx.runQuery(isCloudBuildTurnDispatchableRef, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        conversationId: args.conversationId,
        appId: args.appId,
        turnId: args.turnId,
        sessionId: args.sessionId,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "build_dispatch_preflight_retrying",
          turnId: args.turnId,
          dispatchAttempt,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
    if (!dispatchable) {
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    let execution: CloudExecutionSelection;
    try {
      execution =
        args.execution ?? (await resolveOwnerExecution(ctx, args.ownerId));
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "build_dispatch_execution_retrying",
          turnId: args.turnId,
          dispatchAttempt,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
    const tokenHash = await hashToken(args.turnToken);
    let tokenReady = false;
    try {
      if (dispatchAttempt === 0) {
        await ctx.runMutation(storeTurnTokenRef, {
          tokenHash,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          turnId: args.turnId,
          agentType: "general",
          execution,
          now: Date.now(),
        });
        tokenReady = true;
      } else {
        tokenReady = await ctx.runMutation(ensureTurnTokenForDispatchRef, {
          tokenHash,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          turnId: args.turnId,
          agentType: "general",
          execution,
          now: Date.now(),
        });
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "build_dispatch_token_pending",
          turnId: args.turnId,
          dispatchAttempt,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
    if (!tokenReady) {
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    const authoritative = await ctx.runQuery(
      isCloudBuildTurnAttemptAuthoritativeRef,
      {
        tokenHash,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        conversationId: args.conversationId,
        appId: args.appId,
        turnId: args.turnId,
        sessionId: args.sessionId,
        now: Date.now(),
      },
    );
    if (!authoritative) {
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    let response: Response;
    try {
      response = await fetch(
        `${builderUrl.replace(/\/+$/, "")}/sessions/${encodeURIComponent(args.sessionId)}/turns`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${builderSecret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            conversationId: args.conversationId,
            appId: args.appId,
            turnId: args.turnId,
            sessionId: args.sessionId,
            prompt: args.prompt,
            turnToken: args.turnToken,
            convexCallbackBase: pinnedCallbackBase,
            execution,
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "build_dispatch_response_ambiguous",
          turnId: args.turnId,
          dispatchAttempt,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
    if (response.ok) {
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    if (
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "build_dispatch_response_retrying",
          turnId: args.turnId,
          dispatchAttempt,
          status: response.status,
        }),
      );
      return null;
    }
    await ctx.runMutation(failCloudTurnRef, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      turnId: args.turnId,
      message: "Stella hit a snag starting this change. Try again.",
      now: Date.now(),
    });
    await ctx.scheduler.cancel(retryId).catch(() => undefined);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Cloud chat — the orchestrator loop lives in the builder's OrchestratorSession
// DO; these functions are its Convex half: canonical transcript rows, turn
// tokens, spawned-agent threads, and the wake path that turns a finished
// subagent into a hidden orchestrator follow-up turn.
// ---------------------------------------------------------------------------

export const storeTurnTokenInternal = internalMutation({
  args: {
    tokenHash: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    turnId: v.string(),
    agentType: v.string(),
    execution: v.optional(cloudExecutionSelectionValidator),
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
      turn.status !== "running" ||
      turn.terminalKind
    ) {
      throw new ConvexError("Cloud turn is no longer active.");
    }
    const execution = args.execution
      ? normalizeCloudExecutionSelection(args.execution)
      : undefined;
    // A turn has exactly one live executor attempt. Querying and replacing the
    // bounded attempt set in this mutation serializes concurrent redispatches;
    // whichever token commits last invalidates every earlier capability.
    const priorAttempts = await ctx.db
      .query("cloud_turn_tokens")
      .withIndex("by_turnId_and_ownerId", (q) =>
        q.eq("turnId", args.turnId).eq("ownerId", args.ownerId),
      )
      .take(TURN_TOKEN_ATTEMPT_ROW_LIMIT + 1);
    if (priorAttempts.length > TURN_TOKEN_ATTEMPT_ROW_LIMIT) {
      throw new ConvexError(
        "Cloud turn has too many stale executor attempts to rotate safely.",
      );
    }
    for (const attempt of priorAttempts) await ctx.db.delete(attempt._id);
    await ctx.db.insert("cloud_turn_tokens", {
      tokenHash: args.tokenHash,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      turnId: args.turnId,
      agentType: args.agentType,
      ...(execution ? { execution } : {}),
      createdAt: args.now,
      expiresAt: args.now + TURN_TOKEN_TTL_MS,
    });
    await ctx.db.patch(turn._id, { activeTokenHash: args.tokenHash });
    return null;
  },
});

/**
 * Restart half of cloud-agent dispatch admission. A pre-published retry may
 * run after the first action died before storing its capability, so it may
 * fill an empty token slot or reuse the exact token already there. It must
 * never rotate a newer capability back to the stale action's token.
 */
export const ensureTurnTokenForDispatchInternal = internalMutation({
  args: {
    tokenHash: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    turnId: v.string(),
    agentType: v.string(),
    execution: v.optional(cloudExecutionSelectionValidator),
    now: v.number(),
  },
  returns: v.boolean(),
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
      turn.status !== "running" ||
      turn.terminalKind
    ) {
      return false;
    }
    const attempts = await ctx.db
      .query("cloud_turn_tokens")
      .withIndex("by_turnId_and_ownerId", (q) =>
        q.eq("turnId", args.turnId).eq("ownerId", args.ownerId),
      )
      .take(2);
    if (attempts.length > 1) {
      throw new ConvexError("Cloud turn token authority is ambiguous.");
    }
    const execution = args.execution
      ? normalizeCloudExecutionSelection(args.execution)
      : undefined;
    const current = attempts[0];
    if (current) {
      const exact =
        current.tokenHash === args.tokenHash &&
        current.ownerGeneration === args.ownerGeneration &&
        current.agentType === args.agentType &&
        JSON.stringify(current.execution ?? null) ===
          JSON.stringify(execution ?? null);
      if (!exact) return false;
      // A prolonged builder outage may outlive the ordinary token TTL. The
      // exact pre-published dispatch retry remains the admission owner, so it
      // renews only its unchanged capability; a different token is never
      // rotated back.
      await ctx.db.patch(current._id, {
        expiresAt: args.now + TURN_TOKEN_TTL_MS,
      });
      if (turn.activeTokenHash !== args.tokenHash) {
        await ctx.db.patch(turn._id, { activeTokenHash: args.tokenHash });
      }
      return true;
    }
    await ctx.db.insert("cloud_turn_tokens", {
      tokenHash: args.tokenHash,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      turnId: args.turnId,
      agentType: args.agentType,
      ...(execution ? { execution } : {}),
      createdAt: args.now,
      expiresAt: args.now + TURN_TOKEN_TTL_MS,
    });
    await ctx.db.patch(turn._id, { activeTokenHash: args.tokenHash });
    return true;
  },
});

export type TurnTokenAuthority = {
  tokenHash: string;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  now: number;
};

/**
 * Resolves only the single current capability for a turn. The owner lifecycle,
 * migration fence, token row, current-attempt range, and turn row all
 * participate in one Convex transaction so reset, migration, redispatch, or a
 * terminal write cannot race this authority check.
 */
export const resolveCurrentTurnToken = async (
  ctx: QueryCtx | MutationCtx,
  args: TurnTokenAuthority,
  requireActive: boolean,
): Promise<{
  token: Doc<"cloud_turn_tokens">;
  turn?: Doc<"agent_turns">;
} | null> => {
  const tokenRows = await ctx.db
    .query("cloud_turn_tokens")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
    .take(2);
  if (tokenRows.length !== 1) return null;
  const token = tokenRows[0]!;
  if (
    token.expiresAt <= args.now ||
    token.ownerId !== args.ownerId ||
    token.ownerGeneration !== args.ownerGeneration ||
    token.turnId !== args.turnId
  ) {
    return null;
  }
  try {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
  } catch {
    return null;
  }
  const currentAttempts = await ctx.db
    .query("cloud_turn_tokens")
    .withIndex("by_turnId_and_ownerId", (q) =>
      q.eq("turnId", args.turnId).eq("ownerId", args.ownerId),
    )
    .take(2);
  if (currentAttempts.length !== 1 || currentAttempts[0]!._id !== token._id) {
    return null;
  }
  if (!requireActive) return { token };
  const turn = await ctx.db
    .query("agent_turns")
    .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
    .unique();
  if (
    !turn ||
    turn.ownerId !== args.ownerId ||
    turn.ownerGeneration !== args.ownerGeneration ||
    turn.status !== "running" ||
    turn.terminalKind
  ) {
    return null;
  }
  return { token, turn };
};

/** Exact preflight for a direct app/build turn redispatch. */
export const isCloudBuildTurnDispatchableInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.string(),
    appId: v.string(),
    turnId: v.string(),
    sessionId: v.string(),
  },
  returns: v.boolean(),
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
    return Boolean(
      turn &&
        turn.ownerId === args.ownerId &&
        turn.ownerGeneration === args.ownerGeneration &&
        turn.conversationId === args.conversationId &&
        turn.appId === args.appId &&
        turn.sessionId === args.sessionId &&
        turn.kind === "build" &&
        turn.status === "running" &&
        !turn.terminalKind,
    );
  },
});

export const isCloudChatTurnDispatchableInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.string(),
    turnId: v.string(),
    sessionId: v.string(),
  },
  returns: v.boolean(),
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
    return Boolean(
      turn &&
        turn.ownerId === args.ownerId &&
        turn.ownerGeneration === args.ownerGeneration &&
        turn.conversationId === args.conversationId &&
        turn.sessionId === args.sessionId &&
        turn.kind === "chat" &&
        turn.status === "running" &&
        !turn.terminalKind,
    );
  },
});

/** Token-inclusive authority checked immediately before a direct build POST. */
export const isCloudBuildTurnAttemptAuthoritativeInternal = internalQuery({
  args: {
    tokenHash: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.string(),
    appId: v.string(),
    turnId: v.string(),
    sessionId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const authority = await resolveCurrentTurnToken(ctx, args, true);
    const turn = authority?.turn;
    return Boolean(
      turn &&
        turn.kind === "build" &&
        turn.conversationId === args.conversationId &&
        turn.appId === args.appId &&
        turn.sessionId === args.sessionId,
    );
  },
});

export const isCloudChatTurnAttemptAuthoritativeInternal = internalQuery({
  args: {
    tokenHash: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.string(),
    turnId: v.string(),
    sessionId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const authority = await resolveCurrentTurnToken(ctx, args, true);
    const turn = authority?.turn;
    return Boolean(
      turn &&
        turn.kind === "chat" &&
        turn.conversationId === args.conversationId &&
        turn.sessionId === args.sessionId,
    );
  },
});

/** Service tools may act only while their exact orchestrator turn still owns
 * the conversation. This closes delayed tool POSTs after terminalization. */
export const isActiveCloudParentTurnInternal = internalQuery({
  args: {
    tokenHash: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.string(),
    turnId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const authority = await resolveCurrentTurnToken(ctx, args, true);
    return Boolean(
      authority?.turn?.kind === "chat" &&
        authority.turn.conversationId === args.conversationId,
    );
  },
});

export const getTurnTokenByHashInternal = internalQuery({
  args: {
    tokenHash: v.string(),
    now: v.number(),
    requireActive: v.optional(v.boolean()),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("cloud_turn_tokens"),
      _creationTime: v.number(),
      tokenHash: v.string(),
      ownerId: v.string(),
      ownerGeneration: v.optional(v.string()),
      turnId: v.string(),
      agentType: v.string(),
      execution: v.optional(cloudExecutionSelectionValidator),
      createdAt: v.number(),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const tokenRows = await ctx.db
      .query("cloud_turn_tokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .take(2);
    if (tokenRows.length !== 1) return null;
    const row = tokenRows[0]!;
    if (!row.ownerGeneration) return null;
    const resolved = await resolveCurrentTurnToken(
      ctx,
      {
        tokenHash: args.tokenHash,
        ownerId: row.ownerId,
        ownerGeneration: row.ownerGeneration,
        turnId: row.turnId,
        now: args.now,
      },
      args.requireActive === true,
    );
    return resolved?.token ?? null;
  },
});

/**
 * Last transaction-plane barrier for unmetered provider I/O made with a cloud
 * turn capability (for example, a connected Claude/ChatGPT subscription).
 * Metered calls combine this same authority with their billing marker; BYOK
 * still needs a final active-attempt check even though no Stella charge exists.
 */
export const assertActiveTurnTokenDispatchInternal = internalMutation({
  args: {
    tokenHash: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    turnId: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!(await resolveCurrentTurnToken(ctx, args, true))?.turn) {
      throw new ConvexError({
        code: "TURN_NOT_ACTIVE",
        message: "Cloud turn is no longer active.",
      });
    }
    return null;
  },
});

export const purgeExpiredTurnTokensInternal = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const expired = await ctx.db
      .query("cloud_turn_tokens")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now()))
      .take(200);
    for (const row of expired) await ctx.db.delete(row._id);
    return expired.length;
  },
});

/**
 * A spawned agent's thread transcript, for `send_input` continuations.
 *
 * Scoped to THREADS by construction: the id must name a real
 * `cloud_agent_threads` row. User conversations are not reachable here — their
 * transcript is the DO's journal, and this route is the one place a
 * conversation id used to be honoured on the strength of nothing but its
 * shape.
 */
export const listThreadMessagesInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    threadId: v.string(),
    excludeTurnId: v.optional(v.string()),
  },
  returns: v.array(
    v.object({
      seq: v.number(),
      role: v.string(),
      payloadJson: v.string(),
      turnId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (
      !thread ||
      thread.ownerId !== args.ownerId ||
      thread.ownerGeneration !== args.ownerGeneration
    ) {
      throw new ConvexError("Unknown agent thread.");
    }
    // Newest 400 rows outside the current attempt, returned oldest-first. The
    // fixed scan ceiling covers a maximum-size current turn plus that context
    // suffix. If legacy/unbounded current-turn data exhausts the ceiling before
    // finding the suffix, fail closed rather than manufacturing partial history.
    const rows = await ctx.db
      .query("cloud_thread_messages")
      .withIndex("by_conversationId_and_ownerId_and_seq", (q) =>
        q.eq("conversationId", args.threadId).eq("ownerId", args.ownerId),
      )
      .order("desc")
      .take(THREAD_CONTEXT_SCAN_LIMIT + 1);
    const candidates = rows.filter((row) => row.turnId !== args.excludeTurnId);
    if (
      rows.length > THREAD_CONTEXT_SCAN_LIMIT &&
      candidates.length < THREAD_CONTEXT_ROW_LIMIT
    ) {
      throw new ConvexError(
        "Agent thread history exceeds the safe scan bound.",
      );
    }
    const selected: typeof candidates = [];
    let selectedBytes = 0;
    for (const row of candidates.slice(0, THREAD_CONTEXT_ROW_LIMIT)) {
      assertThreadMessagePayload(row.role, row.payloadJson);
      const rowBytes = utf8ByteLength(row.payloadJson);
      if (selectedBytes + rowBytes > THREAD_CONTEXT_MAX_BYTES) break;
      selectedBytes += rowBytes;
      selected.push(row);
    }
    const oldestFirst = selected.reverse();
    // The row and byte ceilings can cut through a prior exchange. Starting a
    // provider history with that exchange's assistant/toolResult rows would
    // orphan them from the user request (and, for a tool result, its call).
    // Every bounded candidate above is validated before this trim, so a
    // malformed leading row still rejects the authoritative history instead
    // of disappearing behind boundary repair. If the bounded suffix contains
    // no clean boundary, degrade to empty history rather than fabricate one.
    const safeStart = oldestFirst.findIndex((row) => row.role === "user");
    if (safeStart < 0) return [];
    return oldestFirst.slice(safeStart).map((row) => ({
      seq: row.seq,
      role: row.role,
      payloadJson: row.payloadJson,
      turnId: row.turnId,
    }));
  },
});

export const appendThreadMessagesInternal = internalMutation({
  args: {
    tokenHash: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    threadId: v.string(),
    turnId: v.string(),
    messages: v.array(
      v.object({
        ordinal: v.number(),
        role: v.string(),
        payloadJson: v.string(),
      }),
    ),
    now: v.number(),
  },
  returns: v.object({ lastSeq: v.number() }),
  handler: async (ctx, args) => {
    const authority = await resolveCurrentTurnToken(ctx, args, true);
    const turn = authority?.turn;
    if (!turn) throw new ConvexError("Cloud turn is no longer active.");
    // A spawned-agent turn writes ONLY its own thread transcript. Its turn
    // token must never reach the parent user conversation, where a hijacked
    // sandbox could forge assistant/user history the orchestrator would reload
    // as genuine context. Since the DO took ownership of conversation content
    // this check is also the only thing standing between a sandbox token and
    // the conversation index — the other half of that guarantee is the
    // `x-stella-owner` compare on the DO's own append surface.
    if (turn.kind !== "agent" || !turn.threadId) {
      throw new ConvexError("Only agent turns write a thread transcript.");
    }
    if (turn.threadId !== args.threadId) {
      throw new ConvexError("Turn does not belong to this thread.");
    }
    if (
      args.messages.length < 1 ||
      args.messages.length > THREAD_TURN_MESSAGE_LIMIT
    ) {
      throw new ConvexError("Invalid agent thread message batch size.");
    }
    const ordinals = new Set<number>();
    let totalBytes = 0;
    for (const message of args.messages) {
      if (
        !Number.isSafeInteger(message.ordinal) ||
        message.ordinal < 0 ||
        message.ordinal >= THREAD_TURN_MESSAGE_LIMIT ||
        ordinals.has(message.ordinal)
      ) {
        throw new ConvexError("Invalid agent thread message ordinal.");
      }
      ordinals.add(message.ordinal);
      assertThreadMessagePayload(message.role, message.payloadJson);
      totalBytes += utf8ByteLength(message.payloadJson);
      if (totalBytes > THREAD_TURN_MESSAGE_MAX_BYTES) {
        throw new ConvexError("Agent thread message batch is too large.");
      }
    }
    let lastSeq = -1;
    for (const message of args.messages) {
      lastSeq = await appendThreadMessage(ctx, {
        threadId: args.threadId,
        ownerId: turn.ownerId,
        turnId: args.turnId,
        ordinal: message.ordinal,
        role: message.role,
        payloadJson: message.payloadJson,
        now: args.now,
      });
    }
    return { lastSeq };
  },
});

// ---------------------------------------------------------------------------
// The conversation index. Everything below is a projection of the
// OrchestratorSession DO's journal: the DO is the only writer, Convex is the
// only place that can answer "list my conversations" and "search everything".
// ---------------------------------------------------------------------------

const PREVIEW_MAX_CHARS = 160;
const EXCERPT_TEXT_MAX = 4_000;
const INDEX_EXCERPT_BATCH_MAX = 50;
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

const clip = (value: string, max: number): string =>
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

const conversationTombstoned = async (
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

/**
 * The DO's only write into Convex's half of a conversation.
 *
 * Fenced on `(epoch, lastSeq)`: a retried or reordered flush is dropped as
 * stale rather than moving the row backwards. `updatedAt` takes max() because
 * Convex owns it too — `resolveConversationId` stamps it so a brand-new
 * conversation sorts to the top before the DO has flushed anything.
 *
 * The reply always carries the row's CURRENT lastSeq, accepted or not, so a DO
 * that lost track of what it had synced can converge without a second call.
 */
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
    excerpts: v.optional(
      v.array(
        v.object({
          turnId: v.string(),
          seqStart: v.number(),
          seqEnd: v.number(),
          text: v.string(),
          createdAt: v.number(),
        }),
      ),
    ),
    force: v.optional(v.boolean()),
  },
  returns: v.object({
    accepted: v.boolean(),
    /**
     * Reported separately from `accepted` on purpose. Excerpts are keyed by
     * turn and idempotent, so a flush the (epoch, lastSeq) fence rejects as
     * stale still lands them — otherwise a DO retrying after a half-recorded
     * flush would be refused forever and its excerpts would never sync.
     */
    excerptsAccepted: v.boolean(),
    reason: v.optional(v.string()),
    lastSeq: v.number(),
    epoch: v.number(),
  }),
  handler: async (ctx, args) => {
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
      // a deleted owner's conversation — and, through `writeExcerpts`, their
      // transcript — from a flush that a still-resident DO started before the
      // purge and retried after it. Ask before rebuilding anything.
      if (await conversationTombstoned(ctx, args.conversationId)) {
        // `excerptsAccepted: false` matters as much as `accepted: false`: it is
        // what stops `ConversationIndex.run` shipping the remaining batches,
        // and what keeps the DO from marking them synced.
        logCloud("conversation_index_after_purge", {
          conversationId: args.conversationId,
        });
        return {
          accepted: false,
          excerptsAccepted: false,
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
          excerptsAccepted: false,
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
      await writeExcerpts(ctx, args);
      return {
        accepted: true,
        excerptsAccepted: true,
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
        excerptsAccepted: false,
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
        excerptsAccepted: false,
        reason: "deleted",
        lastSeq: row.lastSeq ?? -1,
        epoch: row.epoch ?? 0,
      };
    }
    const currentEpoch = row.epoch ?? 0;
    const currentSeq = row.lastSeq ?? -1;
    if (args.epoch < currentEpoch) {
      // A rewind advances the epoch specifically to fence delayed flushes from
      // the removed suffix. Their excerpts are projection data too: accepting
      // them would make Recall resurrect content the journal can no longer
      // return, even though the conversation head itself stayed fenced.
      return {
        accepted: false,
        excerptsAccepted: false,
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
      // Same-epoch replay: the ordered fields stay where they are, while an
      // excerpt batch may still finish an earlier partial delivery.
      await writeExcerpts(ctx, args);
      return {
        accepted: false,
        excerptsAccepted: true,
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
    await writeExcerpts(ctx, args);
    return {
      accepted: true,
      excerptsAccepted: true,
      lastSeq: args.lastSeq,
      epoch: args.epoch,
    };
  },
});

// Excerpts are keyed by turn and rewritten in place, so a replayed flush or a
// /reindex costs an update rather than a duplicate.
const writeExcerpts = async (
  ctx: MutationCtx,
  args: {
    conversationId: string;
    ownerId: string;
    excerpts?: Array<{
      turnId: string;
      seqStart: number;
      seqEnd: number;
      text: string;
      createdAt: number;
    }>;
  },
): Promise<void> => {
  const excerpts = args.excerpts ?? [];
  if (excerpts.length === 0) return;
  if (excerpts.length > INDEX_EXCERPT_BATCH_MAX) {
    throw new ConvexError(
      `An index flush carries at most ${INDEX_EXCERPT_BATCH_MAX} excerpts.`,
    );
  }
  for (const excerpt of excerpts) {
    const searchText = clip(excerpt.text, EXCERPT_TEXT_MAX);
    if (!searchText.trim()) continue;
    const existing = await ctx.db
      .query("cloud_message_excerpts")
      .withIndex("by_turnId", (q) => q.eq("turnId", excerpt.turnId))
      .unique();
    if (existing) {
      // turnId is a global idempotency key, not a bearer capability. A flush
      // for one conversation must never be able to rewrite a row that key
      // already bound to another owner or conversation.
      if (
        existing.ownerId !== args.ownerId ||
        existing.conversationId !== args.conversationId
      ) {
        throw new ConvexError(
          "Excerpt id is already owned by another conversation.",
        );
      }
      await ctx.db.patch(existing._id, {
        seqStart: excerpt.seqStart,
        seqEnd: excerpt.seqEnd,
        searchText,
      });
      continue;
    }
    await ctx.db.insert("cloud_message_excerpts", {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      turnId: excerpt.turnId,
      seqStart: excerpt.seqStart,
      seqEnd: excerpt.seqEnd,
      searchText,
      createdAt: excerpt.createdAt,
    });
  }
};

/**
 * One call per DO lifetime: an OrchestratorSession that has never been bound
 * asks who owns it. The DO must never adopt its first connector as owner —
 * that would turn a conversation id into a bearer token — so this is the only
 * way ownership enters a fresh DO.
 */
export const getConversationOwnerInternal = internalQuery({
  args: { conversationId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      ownerId: v.string(),
      ownerGeneration: v.string(),
      createdAt: v.number(),
      title: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .unique();
    // A tombstoned conversation reads as unknown, so a DO recreated under the
    // same name discards itself instead of binding to a dead owner record.
    if (!row || row.deletedAt !== undefined) return null;
    const lifecycle = await assertOwnerDataWriteAllowed(ctx, row.ownerId);
    return {
      ownerId: row.ownerId,
      ownerGeneration: lifecycle.generation,
      createdAt: row.createdAt,
      title: row.title,
    };
  },
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
  handler: async (ctx, args) => {
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
  },
});

/**
 * Drops every Convex row derived from one conversation: the search excerpts,
 * and the turn/event rows that carry its prompts. Batched, because a long
 * conversation exceeds a single transaction.
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
    const excerpts = await ctx.db
      .query("cloud_message_excerpts")
      .withIndex("by_conversationId_and_seqStart", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .take(PURGE_BATCH);
    for (const row of excerpts) {
      if (purgeFence && row.ownerId !== purgeFence.ownerId) {
        throw new ConvexError("Conversation not found.");
      }
      await ctx.db.delete(row._id);
    }
    if (excerpts.length === PURGE_BATCH) return { hasMore: true };

    // Agents spawned from this conversation carry their own thread transcript
    // — the model's working notes about the user's request. They go too.
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
      const messages = await ctx.db
        .query("cloud_thread_messages")
        .withIndex("by_conversationId_and_seq", (q) =>
          q.eq("conversationId", thread.threadId),
        )
        .take(PURGE_BATCH);
      for (const row of messages) await ctx.db.delete(row._id);
      if (messages.length === PURGE_BATCH) return { hasMore: true };
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
      // Children first, and the turn only once its last child is gone — every
      // index into an event or a thread message starts at the turn, so an
      // orphan can never be found again.
      if (events.length === PURGE_BATCH) return { hasMore: true };
      const orphanMessages = await ctx.db
        .query("cloud_thread_messages")
        .withIndex("by_turnId", (q) => q.eq("turnId", turn.turnId))
        .take(PURGE_BATCH);
      for (const row of orphanMessages) await ctx.db.delete(row._id);
      if (orphanMessages.length === PURGE_BATCH) return { hasMore: true };
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

export const deleteMyConversation = action({
  args: { conversationId: v.string() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const ownerId = await requireOwnerId(ctx);
    await enforceActionRateLimit(
      ctx,
      "cloud_conversation_delete",
      ownerId,
      { rate: 30, periodMs: 10 * 60_000 },
      "Too many conversations deleted at once. Wait a moment and try again.",
    );
    // Tombstone synchronously: when this returns, the conversation is gone
    // from every list and no turn can be started in it again. The storage
    // purge continues in the background and retries on the sweep, so a slow or
    // unreachable DO never blocks the user's delete.
    await ctx.runMutation(internal.cloud_apps.tombstoneConversationInternal, {
      conversationId: args.conversationId,
      ownerId,
      now: Date.now(),
    });
    await ctx.scheduler.runAfter(
      0,
      internal.cloud_apps.purgeConversationInternal,
      { conversationId: args.conversationId, ownerId },
    );
    return { ok: true };
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
 * Drains the pre-DO transcript table. It is declared in the schema for exactly
 * this reason: an undeclared table keeps its documents, and abandoned user
 * transcripts are not an acceptable resting state. Unindexed by design — this
 * is a whole-table drain, bounded per call, run until `remaining` is 0. Delete
 * the table, this mutation, and its cron once every deployment reports 0.
 */
export const drainLegacyCloudMessagesInternal = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), remaining: v.boolean() }),
  handler: async (ctx, args) => {
    const limit = Math.min(500, Math.max(1, args.limit ?? 200));
    const rows = await ctx.db.query("cloud_messages").take(limit);
    for (const row of rows) await ctx.db.delete(row._id);
    return { deleted: rows.length, remaining: rows.length === limit };
  },
});

export const runOrchestratorTurnInternal = internalAction({
  args: {
    ownerId: v.string(),
    conversationId: v.string(),
    turnId: v.string(),
    sessionId: v.string(),
    prompt: v.string(),
    turnToken: v.string(),
    ownerGeneration: v.string(),
    execution: v.optional(cloudExecutionSelectionValidator),
    // Prompt-row metadata. The DO appends the user message to its journal as
    // the turn's first record, so the flags that used to shape the Convex
    // transcript insert travel with the dispatch instead.
    hiddenMessage: v.optional(v.boolean()),
    source: v.optional(v.string()),
    clientMsgId: v.optional(v.string()),
    // Transcript metadata Convex is authoritative for. `lane` labels the turn
    // record; `title` and `conversationCreatedAt` seed the DO's `meta` so its
    // index flush can re-create a lost `cloud_conversations` row.
    lane: v.optional(v.string()),
    title: v.optional(v.string()),
    conversationCreatedAt: v.optional(v.number()),
    // Reply-language hint the DO persists per conversation.
    locale: v.optional(v.string()),
    // Drive paths of attached images; the DO hydrates them into image blocks.
    attachments: v.optional(v.array(v.string())),
    agentThreadControl: v.optional(agentThreadControlReceiptValidator),
    convexCallbackBase: v.optional(v.string()),
    dispatchAttempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const builderSecret = process.env.BUILDER_SERVICE_SECRET?.trim();
    const failure = "Stella couldn't start on this. Try again in a moment.";
    const dispatchAttempt = args.dispatchAttempt ?? 0;
    const pinnedCallbackBase =
      args.convexCallbackBase?.trim() ?? process.env.CONVEX_SITE_URL?.trim();
    const retryId = await ctx.scheduler.runAfter(
      45_000,
      runOrchestratorTurnRef,
      {
        ownerId: args.ownerId,
        conversationId: args.conversationId,
        turnId: args.turnId,
        sessionId: args.sessionId,
        prompt: args.prompt,
        turnToken: args.turnToken,
        ownerGeneration: args.ownerGeneration,
        ...(args.execution ? { execution: args.execution } : {}),
        ...(args.hiddenMessage ? { hiddenMessage: true } : {}),
        ...(args.source ? { source: args.source } : {}),
        ...(args.clientMsgId ? { clientMsgId: args.clientMsgId } : {}),
        ...(args.lane ? { lane: args.lane } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(args.conversationCreatedAt !== undefined
          ? { conversationCreatedAt: args.conversationCreatedAt }
          : {}),
        ...(args.locale ? { locale: args.locale } : {}),
        ...(args.attachments?.length ? { attachments: args.attachments } : {}),
        ...(args.agentThreadControl
          ? { agentThreadControl: args.agentThreadControl }
          : {}),
        ...(pinnedCallbackBase
          ? { convexCallbackBase: pinnedCallbackBase }
          : {}),
        dispatchAttempt: dispatchAttempt + 1,
      },
    );
    try {
      await assertExpectedOwnerGenerationActive(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    } catch (error) {
      const data =
        error && typeof error === "object" && "data" in error
          ? (error as { data?: unknown }).data
          : undefined;
      const definitelyStale =
        data !== null &&
        typeof data === "object" &&
        (data as { code?: unknown }).code === "OWNER_DATA_GENERATION_STALE";
      if (definitelyStale) {
        await ctx.scheduler.cancel(retryId).catch(() => undefined);
      }
      console.warn(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: definitelyStale
            ? "chat_dispatch_authority_lost"
            : "chat_dispatch_authority_retrying",
          turnId: args.turnId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
    if (!builderUrl || !builderSecret || !pinnedCallbackBase) {
      await ctx.runMutation(failCloudTurnRef, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        turnId: args.turnId,
        message: failure,
        now: Date.now(),
      });
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    let dispatchable: boolean;
    try {
      dispatchable = await ctx.runQuery(isCloudChatTurnDispatchableRef, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        conversationId: args.conversationId,
        turnId: args.turnId,
        sessionId: args.sessionId,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "chat_dispatch_preflight_retrying",
          turnId: args.turnId,
          dispatchAttempt,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
    if (!dispatchable) {
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    let execution: CloudExecutionSelection;
    try {
      execution =
        args.execution ?? (await resolveOwnerExecution(ctx, args.ownerId));
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "chat_dispatch_execution_retrying",
          turnId: args.turnId,
          dispatchAttempt,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
    const tokenHash = await hashToken(args.turnToken);
    let tokenReady = false;
    try {
      if (dispatchAttempt === 0) {
        await ctx.runMutation(storeTurnTokenRef, {
          tokenHash,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          turnId: args.turnId,
          agentType: "orchestrator",
          execution,
          now: Date.now(),
        });
        tokenReady = true;
      } else {
        tokenReady = await ctx.runMutation(ensureTurnTokenForDispatchRef, {
          tokenHash,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          turnId: args.turnId,
          agentType: "orchestrator",
          execution,
          now: Date.now(),
        });
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "chat_dispatch_token_pending",
          turnId: args.turnId,
          dispatchAttempt,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
    if (!tokenReady) {
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    const authoritative = await ctx.runQuery(
      isCloudChatTurnAttemptAuthoritativeRef,
      {
        tokenHash,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        conversationId: args.conversationId,
        turnId: args.turnId,
        sessionId: args.sessionId,
        now: Date.now(),
      },
    );
    if (!authoritative) {
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    let response: Response;
    try {
      response = await fetch(
        `${builderUrl.replace(/\/+$/, "")}/conversations/${encodeURIComponent(args.conversationId)}/turns`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${builderSecret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "chat",
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            conversationId: args.conversationId,
            turnId: args.turnId,
            sessionId: args.sessionId,
            prompt: args.prompt,
            turnToken: args.turnToken,
            convexCallbackBase: pinnedCallbackBase,
            execution,
            ...(args.hiddenMessage ? { hiddenMessage: true } : {}),
            ...(args.source ? { source: args.source } : {}),
            ...(args.clientMsgId ? { clientMsgId: args.clientMsgId } : {}),
            ...(args.lane ? { lane: args.lane } : {}),
            ...(args.title ? { title: args.title } : {}),
            ...(args.conversationCreatedAt !== undefined
              ? { conversationCreatedAt: args.conversationCreatedAt }
              : {}),
            ...(args.locale ? { locale: args.locale } : {}),
            ...(args.attachments?.length
              ? { attachments: args.attachments }
              : {}),
            ...(args.agentThreadControl
              ? { agentThreadControl: args.agentThreadControl }
              : {}),
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "chat_dispatch_response_ambiguous",
          turnId: args.turnId,
          dispatchAttempt,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
    if (response.ok) {
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    if (
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      return null;
    }
    await ctx.runMutation(failCloudTurnRef, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      turnId: args.turnId,
      message: "Stella hit a snag starting this chat. Try again.",
      now: Date.now(),
    });
    await ctx.scheduler.cancel(retryId).catch(() => undefined);
    return null;
  },
});

type SpawnCloudAgentResult = {
  ok: boolean;
  threadId?: string;
  turnId?: string;
  /** Exact committed thread receipt. The conversation DO persists this and
   * supplies it on later control mutations; the model never invents it. */
  attemptGeneration?: number;
  threadUpdatedAt?: number;
  status?: "running";
  error?: string;
};

/**
 * Stable semantic identity for an at-least-once spawn delivery. The fixed
 * field order and explicit nulls are part of the v1 contract. Transport and
 * lifecycle fields (clientMsgId, placement attempt, generation, and request
 * time) are intentionally excluded. A continuation's exact terminal receipt
 * is semantic input, however: reusing a client id after another attempt must
 * conflict rather than silently discard the new instruction.
 */
const spawnIntentFingerprint = async (
  args: {
    conversationId: string;
    parentTurnId?: string;
    description: string;
    prompt: string;
    threadId?: string;
    expectedAttemptGeneration?: number;
    expectedTerminalUpdatedAt?: number;
    source?: string;
  },
  requestedExecution: CloudExecutionSelection | undefined,
  originDeviceId: string | undefined,
  originConversationId: string | undefined,
): Promise<string> =>
  await hashToken(
    JSON.stringify({
      version: "spawn-agent-intent/v2",
      conversationId: args.conversationId,
      parentTurnId: args.parentTurnId || null,
      description: args.description,
      prompt: args.prompt,
      threadId: args.threadId || null,
      expectedAttemptGeneration: args.expectedAttemptGeneration ?? null,
      expectedTerminalUpdatedAt: args.expectedTerminalUpdatedAt ?? null,
      source: args.source || null,
      requestedExecution: requestedExecution
        ? {
            engine: requestedExecution.engine,
            provider: requestedExecution.provider,
            model: requestedExecution.model,
            reasoningEffort: requestedExecution.reasoningEffort,
          }
        : null,
      originDeviceId: originDeviceId || null,
      originConversationId: originConversationId || null,
    }),
  );

/**
 * The one implementation of "put a background agent in the cloud".
 * `parentTurnId` is absent for desktop-dispatched spawns, which have no cloud
 * turn above them; every other gate (plan quota, one-running-agent
 * exclusivity) applies identically either way.
 */
const spawnCloudAgent = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    parentTurnId?: string;
    /** Hashed service-route capability for the active orchestrator parent. */
    parentTokenHash?: string;
    description: string;
    prompt: string;
    threadId?: string;
    expectedAttemptGeneration?: number;
    expectedTerminalUpdatedAt?: number;
    execution?: CloudExecutionSelection;
    model?: string;
    source?: string;
    clientMsgId?: string;
    placementAttempt?: ExecutionPlacementAttempt;
    originDeviceId?: string;
    originConversationId?: string;
    now: number;
  },
): Promise<SpawnCloudAgentResult> => {
  const lifecycle = await assertOwnerDataWriteAllowed(
    ctx,
    args.ownerId,
    args.ownerGeneration,
  );
  const originDeviceId = args.originDeviceId?.trim();
  const originConversationId = args.originConversationId?.trim();
  if (
    Boolean(originDeviceId) !== Boolean(originConversationId) ||
    (originDeviceId?.length ?? 0) > 256 ||
    (originConversationId?.length ?? 0) > 256
  ) {
    return {
      ok: false,
      error:
        "originDeviceId and originConversationId must be valid and provided together.",
    };
  }
  const clientMsgId = normalizeClientMsgId(args.clientMsgId);
  // Normalize the requested override once and hash that canonical meaning.
  // Availability is intentionally checked only after replay: disconnecting a
  // provider cannot invalidate an already-committed exact delivery.
  let requestedExecution: CloudExecutionSelection | undefined;
  try {
    requestedExecution = args.execution
      ? normalizeCloudExecutionSelection(args.execution)
      : parseLegacySpawnExecution(args.model);
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ConvexError
          ? String(error.data)
          : "That engine selection isn't available.",
    };
  }
  const intentFingerprint = clientMsgId
    ? await spawnIntentFingerprint(
        args,
        requestedExecution,
        originDeviceId,
        originConversationId,
      )
    : undefined;
  if (clientMsgId) {
    // Placement delivery is at-least-once across the action/mutation boundary.
    // Resolve the first committed turn before parent lookup, provisioning,
    // capacity checks, thread mutation, or scheduling, so an ambiguous action
    // response can never become a second cloud agent.
    const replayCandidates = await ctx.db
      .query("agent_turns")
      .withIndex("by_ownerId_and_clientMsgId", (q) =>
        q.eq("ownerId", args.ownerId).eq("clientMsgId", clientMsgId),
      )
      .take(2);
    if (replayCandidates.length > 1) {
      return {
        ok: false,
        error: "That cloud agent request has conflicting prior deliveries.",
      };
    }
    const replay = replayCandidates[0];
    if (replay) {
      const requestMatches =
        replay.kind === "agent" &&
        replay.ownerGeneration === args.ownerGeneration &&
        Boolean(replay.threadId) &&
        typeof replay.spawnIntentFingerprint === "string" &&
        replay.spawnIntentFingerprint === intentFingerprint;
      if (!requestMatches || !replay.threadId) {
        return {
          ok: false,
          error: "That cloud agent request id was already used differently.",
        };
      }
      const replayThread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", replay.threadId!))
        .unique();
      if (
        !replayThread ||
        replayThread.ownerId !== args.ownerId ||
        replayThread.ownerGeneration !== args.ownerGeneration ||
        replayThread.conversationId !== args.conversationId ||
        !Number.isSafeInteger(replay.attemptGeneration) ||
        replay.attemptGeneration! < 1
      ) {
        return {
          ok: false,
          error:
            "That cloud agent request has no authoritative thread receipt.",
        };
      }
      return {
        ok: true,
        threadId: replay.threadId,
        turnId: replay.turnId,
        attemptGeneration: replay.attemptGeneration!,
        // The turn and thread are inserted/patched with the same mutation
        // timestamp. Unlike the mutable thread row, this is the immutable
        // admission revision for exactly this clientMsgId delivery.
        threadUpdatedAt: replay.createdAt,
        status: "running",
      };
    }
  }
  if (args.parentTokenHash) {
    if (!args.parentTurnId) {
      return { ok: false, error: "An active parent turn is required." };
    }
    const parentAuthority = await resolveCurrentTurnToken(
      ctx,
      {
        tokenHash: args.parentTokenHash,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        turnId: args.parentTurnId,
        now: args.now,
      },
      true,
    );
    const parent = parentAuthority?.turn;
    if (
      !parent ||
      parent.kind !== "chat" ||
      parent.conversationId !== args.conversationId
    ) {
      return {
        ok: false,
        error: "That orchestrator turn is no longer active.",
      };
    }
  }
  await assertExecutionPlacementAdmission(ctx, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    conversationId: args.conversationId,
    kind: "agent",
    ...(clientMsgId ? { clientMsgId } : {}),
    ...(args.parentTurnId ? { parentTurnId: args.parentTurnId } : {}),
    ...(args.threadId ? { threadId: args.threadId } : {}),
    ...(args.placementAttempt
      ? { placementAttempt: args.placementAttempt }
      : {}),
  });
  let parentExecution: CloudExecutionSelection | undefined;
  if (args.parentTurnId) {
    const parentTurnId = args.parentTurnId;
    const parent = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", parentTurnId))
      .unique();
    if (
      !parent ||
      parent.ownerId !== args.ownerId ||
      parent.ownerGeneration !== args.ownerGeneration ||
      parent.conversationId !== args.conversationId
    ) {
      return { ok: false, error: "Parent turn not found." };
    }
    parentExecution = parent.execution
      ? normalizeCloudExecutionSelection(parent.execution)
      : undefined;
  }
  // A full execution object is the canonical override. The string parser
  // remains only for already-running cloud orchestrators during rollout.
  let executionOverride = requestedExecution;
  if (executionOverride) {
    try {
      executionOverride = await assertExecutionAvailable(
        ctx,
        args.ownerId,
        executionOverride,
      );
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof ConvexError
            ? String(error.data)
            : "That engine selection isn't available.",
      };
    }
  }
  let threadId = args.threadId;
  let continuedThread: Doc<"cloud_agent_threads"> | null = null;
  if (threadId) {
    const requestedThreadId = threadId;
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", requestedThreadId))
      .unique();
    if (
      !thread ||
      thread.ownerId !== args.ownerId ||
      thread.ownerGeneration !== args.ownerGeneration ||
      thread.conversationId !== args.conversationId
    ) {
      return { ok: false, error: `Thread not found: ${threadId}` };
    }
    if (
      !Number.isSafeInteger(args.expectedAttemptGeneration) ||
      args.expectedAttemptGeneration! < 1 ||
      !Number.isFinite(args.expectedTerminalUpdatedAt)
    ) {
      return {
        ok: false,
        error:
          "Continuing a cloud agent requires the exact terminal attempt receipt.",
      };
    }
    if (
      thread.attemptGeneration !== args.expectedAttemptGeneration ||
      thread.updatedAt !== args.expectedTerminalUpdatedAt
    ) {
      return {
        ok: false,
        error:
          "That cloud thread changed before the continuation arrived. Refresh its status and try again.",
      };
    }
    if (["running", "waiting_for_user", "resuming"].includes(thread.status)) {
      return {
        ok: false,
        error:
          "That agent is still working. Wait for its [Agent completed] event, then send the follow-up.",
      };
    }
    continuedThread = thread;
  }
  let execution = executionOverride;
  if (!execution && continuedThread?.execution) {
    try {
      execution = await assertExecutionAvailable(
        ctx,
        args.ownerId,
        normalizeCloudExecutionSelection(continuedThread.execution),
      );
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof ConvexError
            ? String(error.data)
            : "That cloud execution route is unavailable.",
      };
    }
  }
  if (!execution && parentExecution) {
    try {
      execution = await assertExecutionAvailable(
        ctx,
        args.ownerId,
        parentExecution,
      );
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof ConvexError
            ? String(error.data)
            : "That cloud execution route is unavailable.",
      };
    }
  }
  if (!execution) {
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
      return { ok: false, error: "Conversation not found." };
    }
    try {
      execution = conversation.execution
        ? await assertExecutionAvailable(
            ctx,
            args.ownerId,
            normalizeCloudExecutionSelection(conversation.execution),
          )
        : await resolveOwnerExecutionInMutation(ctx, args.ownerId);
      if (!conversation.execution) {
        await ctx.db.patch(conversation._id, { execution });
      }
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof ConvexError
            ? String(error.data)
            : "That cloud execution route is unavailable.",
      };
    }
  }
  const { quota } = await resolveCloudPlan(ctx, args.ownerId);
  // Fresh cloud threads carry an explicit expiring lease. The index range is
  // the admission authority: computer rows use lease marker 0 and terminal
  // rows leave the exact "running" prefix, so neither can shadow capacity.
  const leasedThreads = (
    await Promise.all(
      (["running", "resuming"] as const).map((status) =>
        ctx.db
          .query("cloud_agent_threads")
          .withIndex("by_owner_status_lease_updatedAt", (q) =>
            q
              .eq("ownerId", args.ownerId)
              .eq("status", status)
              .gt("sandboxLeaseExpiresAt", args.now),
          )
          .take(quota.concurrentTurns + 1),
      ),
    )
  ).flat();

  // Rolling compatibility for threads created before the lease field existed.
  // New computer rows use an explicit 0 marker, so only pre-deploy rows can
  // enter this slice. The one-hour updatedAt bound preserves the old watchdog
  // grace. If a pathological legacy slice exceeds the bound, fail closed
  // instead of letting a fixed mixed window hide an active cloud sandbox.
  const legacyLeaseRows = (
    await Promise.all(
      (["running", "resuming"] as const).map((status) =>
        ctx.db
          .query("cloud_agent_threads")
          .withIndex("by_owner_status_lease_updatedAt", (q) =>
            q
              .eq("ownerId", args.ownerId)
              .eq("status", status)
              .eq("sandboxLeaseExpiresAt", undefined)
              .gt("updatedAt", args.now - CLOUD_SANDBOX_LEASE_MS),
          )
          .order("desc")
          .take(LEGACY_SANDBOX_ADMISSION_SCAN_LIMIT + 1),
      ),
    )
  ).flat();
  if (legacyLeaseRows.length > LEGACY_SANDBOX_ADMISSION_SCAN_LIMIT) {
    return {
      ok: false,
      error:
        "Stella is reconciling active agents from an earlier version. Wait a moment, then try again.",
    };
  }
  const runningThreads = [
    ...leasedThreads,
    ...legacyLeaseRows.filter(
      (candidate) =>
        candidate.status === "resuming" ||
        cloudSandboxThreadIsActive({
          placement: candidate.placement,
          status: candidate.status,
          sandboxLeaseExpiresAt: candidate.sandboxLeaseExpiresAt,
          updatedAt: candidate.updatedAt,
          now: args.now,
        }),
    ),
  ].filter((candidate) => candidate.threadId !== threadId);
  if (runningThreads.length >= quota.concurrentTurns) {
    return {
      ok: false,
      error: `Your plan allows ${quota.concurrentTurns} concurrent background agent${
        quota.concurrentTurns === 1 ? "" : "s"
      }. Wait for one to finish, then try again.`,
    };
  }
  // One sandboxed agent per owner at a time. Every owner has one world, and a
  // turn restores its checkpoint at start and overwrites it at end, so a
  // second concurrent agent would silently lose the first one's work
  // (last-writer-wins on the ws:* key). This mutation is transactional, so
  // the check-and-insert can't race with itself.
  const occupied = (
    await Promise.all(
      (["running", "resuming"] as const).map((status) =>
        ctx.db
          .query("cloud_agent_threads")
          .withIndex("by_ownerId_and_placement_and_status", (q) =>
            q
              .eq("ownerId", args.ownerId)
              .eq("placement", "cloud")
              .eq("status", status),
          )
          .take(2),
      ),
    )
  )
    .flat()
    .filter((thread) => thread.threadId !== threadId);
  if (occupied.length > 0) {
    return {
      ok: false,
      error:
        "Another agent is already working in your cloud world. Wait for it to finish, then try again.",
    };
  }
  let attemptGeneration = 1;
  if (continuedThread) {
    attemptGeneration = continuedThread.attemptGeneration! + 1;
    await ctx.db.patch(continuedThread._id, {
      status: "running",
      description: args.description,
      // A continuation is a new lifecycle delivery. If this was originally a
      // desktop thread, keep it visible to that device until the new terminal
      // result is persisted and acknowledged.
      originDeliveryAckAt: undefined,
      resultJson: undefined,
      errorMessage: undefined,
      attemptGeneration,
      ...(originDeviceId ? { originDeviceId } : {}),
      ...(originConversationId ? { originConversationId } : {}),
      execution,
      sandboxLeaseExpiresAt: cloudAgentSandboxLeaseExpiresAt(
        "cloud",
        args.now,
      ),
      updatedAt: args.now,
    });
  }
  if (!threadId) {
    threadId = `thr-${crypto.randomUUID().slice(0, 18)}`;
    await ctx.db.insert("cloud_agent_threads", {
      threadId,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      conversationId: args.conversationId,
      ...(args.parentTurnId ? { parentTurnId: args.parentTurnId } : {}),
      ...(originDeviceId ? { originDeviceId } : {}),
      ...(originConversationId ? { originConversationId } : {}),
      description: args.description,
      placement: "cloud",
      agentType: "general",
      attemptGeneration,
      execution,
      sandboxLeaseExpiresAt: cloudAgentSandboxLeaseExpiresAt(
        "cloud",
        args.now,
      ),
      status: "running",
      createdAt: args.now,
      updatedAt: args.now,
    });
  }
  const turnId = crypto.randomUUID();
  await ctx.db.insert("agent_turns", {
    turnId,
    sessionId: threadId,
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    attemptGeneration,
    conversationId: args.conversationId,
    prompt: args.prompt,
    status: "running",
    lane: "agent",
    kind: "agent",
    agentType: "general",
    placement: "cloud",
    threadId,
    ...(args.parentTurnId ? { parentTurnId: args.parentTurnId } : {}),
    ...(args.source ? { source: args.source } : {}),
    ...(clientMsgId ? { clientMsgId } : {}),
    ...(intentFingerprint ? { spawnIntentFingerprint: intentFingerprint } : {}),
    execution,
    hidden: true,
    createdAt: args.now,
    updatedAt: args.now,
  });
  const turnToken =
    crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
  await ctx.scheduler.runAfter(0, runCloudAgentTurnRef, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
    threadId,
    turnId,
    prompt: args.prompt,
    turnToken,
    ownerGeneration: lifecycle.generation,
    attemptGeneration,
    execution,
    ...(process.env.CONVEX_SITE_URL?.trim()
      ? { convexCallbackBase: process.env.CONVEX_SITE_URL.trim() }
      : {}),
  });
  return {
    ok: true,
    threadId,
    turnId,
    attemptGeneration,
    threadUpdatedAt: args.now,
    status: "running",
  };
};

/**
 * Finds only the immutable admission inputs that a public desktop wrapper
 * needs in order to re-enter `spawnCloudAgent`'s full fingerprint check.
 *
 * This deliberately does not decide that a request is an exact replay. The
 * core mutation still compares the complete intent fingerprint and durable
 * thread receipt. It only prevents mutable wrapper work (newest-conversation
 * selection, current-thread state, and rate limiting) from running before an
 * already-committed delivery gets that comparison.
 */
const resolveCloudAgentReplayInput = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    clientMsgId: string;
    requestedConversationId?: string;
  },
): Promise<{ conversationId: string } | null> => {
  const candidates = await ctx.db
    .query("agent_turns")
    .withIndex("by_ownerId_and_clientMsgId", (q) =>
      q.eq("ownerId", args.ownerId).eq("clientMsgId", args.clientMsgId),
    )
    .take(2);
  if (candidates.length > 1) {
    throw new ConvexError(
      "That cloud agent request has conflicting prior deliveries.",
    );
  }
  const turn = candidates[0];
  if (!turn) return null;
  if (
    turn.kind !== "agent" ||
    turn.ownerGeneration !== args.ownerGeneration ||
    !turn.conversationId ||
    (args.requestedConversationId !== undefined &&
      turn.conversationId !== args.requestedConversationId)
  ) {
    throw new ConvexError(
      "That cloud agent request id was already used differently.",
    );
  }
  return { conversationId: turn.conversationId };
};

export const spawnCloudAgentInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.string(),
    parentTurnId: v.optional(v.string()),
    parentTokenHash: v.optional(v.string()),
    description: v.string(),
    prompt: v.string(),
    threadId: v.optional(v.string()),
    expectedAttemptGeneration: v.optional(v.number()),
    expectedTerminalUpdatedAt: v.optional(v.number()),
    execution: v.optional(cloudExecutionSelectionValidator),
    // spawn_agent's per-spawn engine override ("claude" | "claude/<model>").
    model: v.optional(v.string()),
    source: v.optional(v.string()),
    clientMsgId: v.optional(v.string()),
    placementAttempt: v.optional(executionPlacementAttemptValidator),
    originDeviceId: v.optional(v.string()),
    originConversationId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.object({
    ok: v.boolean(),
    threadId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    attemptGeneration: v.optional(v.number()),
    threadUpdatedAt: v.optional(v.number()),
    status: v.optional(v.literal("running")),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => await spawnCloudAgent(ctx, args),
});

/**
 * Desktop `spawn_agent` with cloud placement lands here. Authenticated by
 * the signed-in user's identity — never the builder service secret — so the
 * cloud bills and authorizes the person who asked. `conversationId` is a
 * cloud conversation echoed back from a previous call; refusals throw so the
 * desktop can surface the sentence verbatim as the tool error.
 */
export const spawnCloudAgentFromDesktop = mutation({
  args: {
    ownerGeneration: v.string(),
    clientMsgId: v.string(),
    description: v.string(),
    prompt: v.string(),
    conversationId: v.optional(v.string()),
    execution: v.optional(cloudExecutionSelectionValidator),
    // Optional during the rolling-client migration. Updated desktop runtimes
    // send both so a restart can recover terminal cloud-agent completions.
    originDeviceId: v.optional(v.string()),
    originConversationId: v.optional(v.string()),
  },
  returns: v.object({
    threadId: v.string(),
    conversationId: v.string(),
    attemptGeneration: v.number(),
    threadUpdatedAt: v.number(),
    status: v.literal("running"),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const expectedOwnerGeneration = args.ownerGeneration.trim();
    const clientMsgId = normalizeClientMsgId(args.clientMsgId);
    if (!expectedOwnerGeneration || !clientMsgId) {
      throw new ConvexError(
        "A cloud agent needs its exact owner generation and request id.",
      );
    }
    const lifecycle = await assertOwnerDataWriteAllowed(
      ctx,
      ownerId,
      expectedOwnerGeneration,
    );
    const prompt = args.prompt.trim();
    const description = args.description.trim();
    if (!prompt || prompt.length > MAX_DISPATCHED_PROMPT_CHARS) {
      throw new ConvexError(
        `A cloud agent needs a prompt of 1–${MAX_DISPATCHED_PROMPT_CHARS} characters.`,
      );
    }
    if (!description) {
      throw new ConvexError("A cloud agent needs a description.");
    }
    const originDeviceId = args.originDeviceId?.trim();
    const originConversationId = args.originConversationId?.trim();
    if (
      (args.originDeviceId !== undefined &&
        (!originDeviceId || originDeviceId.length > 256)) ||
      (args.originConversationId !== undefined &&
        (!originConversationId || originConversationId.length > 256))
    ) {
      throw new ConvexError("Invalid desktop cloud-agent origin.");
    }
    if (Boolean(originDeviceId) !== Boolean(originConversationId)) {
      throw new ConvexError(
        "originDeviceId and originConversationId must be provided together.",
      );
    }
    const replayInput = await resolveCloudAgentReplayInput(ctx, {
      ownerId,
      ownerGeneration: lifecycle.generation,
      clientMsgId,
      ...(args.conversationId !== undefined
        ? { requestedConversationId: args.conversationId }
        : {}),
    });
    const now = Date.now();
    if (replayInput) {
      const replayed = await spawnCloudAgent(ctx, {
        ownerId,
        ownerGeneration: lifecycle.generation,
        conversationId: replayInput.conversationId,
        description,
        prompt,
        ...(args.execution ? { execution: args.execution } : {}),
        source: "desktop",
        clientMsgId,
        ...(originDeviceId ? { originDeviceId } : {}),
        ...(originConversationId ? { originConversationId } : {}),
        now,
      });
      if (
        !replayed.ok ||
        !replayed.threadId ||
        !Number.isSafeInteger(replayed.attemptGeneration) ||
        replayed.attemptGeneration! < 1 ||
        !Number.isFinite(replayed.threadUpdatedAt)
      ) {
        throw new ConvexError(
          replayed.error ?? "Stella's cloud could not start that agent.",
        );
      }
      return {
        threadId: replayed.threadId,
        conversationId: replayInput.conversationId,
        attemptGeneration: replayed.attemptGeneration!,
        threadUpdatedAt: replayed.threadUpdatedAt!,
        status: "running" as const,
      };
    }
    const { quota } = await resolveCloudPlan(ctx, ownerId);
    await enforceMutationRateLimit(
      ctx,
      "cloud_chat_start",
      ownerId,
      { rate: quota.burstStarts * 5, periodMs: 10 * 60_000 },
      "Too many cloud turns in a row. Wait a moment and try again.",
    );
    // A desktop spawn joins the conversation the user is already reading
    // rather than minting a sibling that would become "newest" and re-point
    // their cloud chat. Falls through to a fresh one only when they have none.
    const newest = args.conversationId
      ? undefined
      : (
          await ctx.db
            .query("cloud_conversations")
            .withIndex("by_ownerId_and_updatedAt", (q) =>
              q.eq("ownerId", ownerId),
            )
            .order("desc")
            .take(1)
        )[0]?.conversationId;
    // Throws "Conversation not found." for a stale or foreign id — the exact
    // sentence the desktop dispatcher retries on.
    const { conversationId } = await resolveConversationId(ctx, {
      ownerId,
      conversationId: args.conversationId ?? newest,
      title: description,
      now,
    });
    const spawned = await spawnCloudAgent(ctx, {
      ownerId,
      ownerGeneration: lifecycle.generation,
      conversationId,
      description,
      prompt,
      ...(args.execution ? { execution: args.execution } : {}),
      source: "desktop",
      clientMsgId,
      ...(originDeviceId ? { originDeviceId } : {}),
      ...(originConversationId ? { originConversationId } : {}),
      now,
    });
    if (
      !spawned.ok ||
      !spawned.threadId ||
      !Number.isSafeInteger(spawned.attemptGeneration) ||
      spawned.attemptGeneration! < 1 ||
      !Number.isFinite(spawned.threadUpdatedAt)
    ) {
      throw new ConvexError(
        spawned.error ?? "Stella's cloud could not start that agent.",
      );
    }
    return {
      threadId: spawned.threadId,
      conversationId,
      attemptGeneration: spawned.attemptGeneration!,
      threadUpdatedAt: spawned.threadUpdatedAt!,
      status: "running" as const,
    };
  },
});

export const continueMyCloudAgentFromDesktop = mutation({
  args: {
    ownerGeneration: v.string(),
    threadId: v.string(),
    expectedAttemptGeneration: v.number(),
    expectedTerminalUpdatedAt: v.number(),
    description: v.string(),
    prompt: v.string(),
    originDeviceId: v.string(),
    originConversationId: v.string(),
    controlRequestId: v.string(),
  },
  returns: v.object({
    threadId: v.string(),
    conversationId: v.string(),
    attemptGeneration: v.number(),
    threadUpdatedAt: v.number(),
    status: v.literal("running"),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const expectedOwnerGeneration = args.ownerGeneration.trim();
    if (!expectedOwnerGeneration) {
      throw new ConvexError("ownerGeneration is required.");
    }
    const lifecycle = await assertOwnerDataWriteAllowed(
      ctx,
      ownerId,
      expectedOwnerGeneration,
    );
    const threadId = args.threadId.trim();
    const description = args.description.trim();
    const prompt = args.prompt.trim();
    const originDeviceId = args.originDeviceId.trim();
    const originConversationId = args.originConversationId.trim();
    const controlRequestId = normalizeClientMsgId(args.controlRequestId);
    if (!threadId) throw new ConvexError("threadId is required.");
    if (!description) {
      throw new ConvexError("A cloud agent needs a description.");
    }
    if (!prompt || prompt.length > MAX_DISPATCHED_PROMPT_CHARS) {
      throw new ConvexError(
        `A cloud agent needs a prompt of 1–${MAX_DISPATCHED_PROMPT_CHARS} characters.`,
      );
    }
    if (
      !originDeviceId ||
      originDeviceId.length > 256 ||
      !originConversationId ||
      originConversationId.length > 256
    ) {
      throw new ConvexError("Invalid desktop cloud-agent origin.");
    }
    if (!controlRequestId) {
      throw new ConvexError("A cloud continuation needs a request id.");
    }
    const replayInput = await resolveCloudAgentReplayInput(ctx, {
      ownerId,
      ownerGeneration: lifecycle.generation,
      clientMsgId: controlRequestId,
    });
    if (replayInput) {
      const replayed = await spawnCloudAgent(ctx, {
        ownerId,
        ownerGeneration: lifecycle.generation,
        conversationId: replayInput.conversationId,
        threadId,
        expectedAttemptGeneration: args.expectedAttemptGeneration,
        expectedTerminalUpdatedAt: args.expectedTerminalUpdatedAt,
        description,
        prompt,
        source: "desktop",
        clientMsgId: controlRequestId,
        originDeviceId,
        originConversationId,
        now: Date.now(),
      });
      if (
        !replayed.ok ||
        !replayed.threadId ||
        !Number.isSafeInteger(replayed.attemptGeneration) ||
        replayed.attemptGeneration! < 1 ||
        !Number.isFinite(replayed.threadUpdatedAt)
      ) {
        throw new ConvexError(
          replayed.error ?? "Stella's cloud could not continue that agent.",
        );
      }
      return {
        threadId: replayed.threadId,
        conversationId: replayInput.conversationId,
        attemptGeneration: replayed.attemptGeneration!,
        threadUpdatedAt: replayed.threadUpdatedAt!,
        status: "running" as const,
      };
    }
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .unique();
    if (
      !thread ||
      thread.ownerId !== ownerId ||
      thread.ownerGeneration !== lifecycle.generation ||
      thread.originDeviceId !== originDeviceId ||
      thread.originConversationId !== originConversationId
    ) {
      throw new ConvexError(`Thread not found: ${threadId}`);
    }
    const { quota } = await resolveCloudPlan(ctx, ownerId);
    await enforceMutationRateLimit(
      ctx,
      "cloud_chat_start",
      ownerId,
      { rate: quota.burstStarts * 5, periodMs: 10 * 60_000 },
      "Too many cloud turns in a row. Wait a moment and try again.",
    );
    const spawned = await spawnCloudAgent(ctx, {
      ownerId,
      ownerGeneration: lifecycle.generation,
      conversationId: thread.conversationId,
      threadId,
      expectedAttemptGeneration: args.expectedAttemptGeneration,
      expectedTerminalUpdatedAt: args.expectedTerminalUpdatedAt,
      description,
      prompt,
      source: "desktop",
      clientMsgId: controlRequestId,
      originDeviceId,
      originConversationId,
      now: Date.now(),
    });
    if (
      !spawned.ok ||
      !spawned.threadId ||
      !Number.isSafeInteger(spawned.attemptGeneration) ||
      spawned.attemptGeneration! < 1 ||
      !Number.isFinite(spawned.threadUpdatedAt)
    ) {
      throw new ConvexError(
        spawned.error ?? "Stella's cloud could not continue that agent.",
      );
    }
    return {
      threadId: spawned.threadId,
      conversationId: thread.conversationId,
      attemptGeneration: spawned.attemptGeneration!,
      threadUpdatedAt: spawned.threadUpdatedAt!,
      status: "running" as const,
    };
  },
});

export const getCloudAgentThreadControlInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    threadId: v.string(),
    conversationId: v.optional(v.string()),
    originDeviceId: v.optional(v.string()),
    originConversationId: v.optional(v.string()),
    controlRequestId: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      status: v.string(),
      runningTurnId: v.union(v.string(), v.null()),
      alreadyCanceled: v.boolean(),
      attemptGeneration: v.number(),
      threadUpdatedAt: v.number(),
      currentControl: v.optional(
        v.object({
          threadId: v.string(),
          status: v.string(),
          attemptGeneration: v.number(),
          threadUpdatedAt: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (
      !thread ||
      thread.ownerId !== args.ownerId ||
      thread.ownerGeneration !== args.ownerGeneration ||
      (args.conversationId !== undefined &&
        thread.conversationId !== args.conversationId) ||
      !Number.isSafeInteger(thread.attemptGeneration) ||
      thread.attemptGeneration! < 1
    ) {
      return null;
    }
    const hasOrigin =
      args.originDeviceId !== undefined ||
      args.originConversationId !== undefined;
    if (
      hasOrigin &&
      (thread.originDeviceId !== args.originDeviceId ||
        thread.originConversationId !== args.originConversationId)
    ) {
      return null;
    }
    const turns = await ctx.db
      .query("agent_turns")
      .withIndex("by_threadId_ownerGeneration_createdAt", (q) =>
        q
          .eq("threadId", args.threadId)
          .eq("ownerGeneration", args.ownerGeneration),
      )
      .order("desc")
      .take(2);
    const priorCancel = args.controlRequestId
      ? await ctx.db
          .query("agent_turns")
          .withIndex("by_threadId_ownerGeneration_cancelRequestId", (q) =>
            q
              .eq("threadId", args.threadId)
              .eq("ownerGeneration", args.ownerGeneration)
              .eq("cancelRequestId", args.controlRequestId),
          )
          .take(2)
      : [];
    if (priorCancel.length > 1) return null;
    const canceledReceipt = priorCancel[0];
    if (canceledReceipt) {
      if (
        !Number.isSafeInteger(canceledReceipt.attemptGeneration) ||
        canceledReceipt.attemptGeneration! < 1
      ) {
        return null;
      }
      return {
        status:
          canceledReceipt.status === "running"
            ? "canceled"
            : canceledReceipt.status,
        runningTurnId: null,
        alreadyCanceled: true,
        attemptGeneration: canceledReceipt.attemptGeneration!,
        threadUpdatedAt: canceledReceipt.updatedAt,
        currentControl: {
          threadId: thread.threadId,
          status: thread.status,
          attemptGeneration: thread.attemptGeneration!,
          threadUpdatedAt: thread.updatedAt,
        },
      };
    }
    const alreadyCanceled = false;
    if (thread.status !== "running") {
      return {
        status: thread.status,
        runningTurnId: null,
        alreadyCanceled,
        attemptGeneration: thread.attemptGeneration!,
        threadUpdatedAt: thread.updatedAt,
      };
    }
    const running = turns.find(
      (turn) =>
        turn.status === "running" &&
        turn.attemptGeneration === thread.attemptGeneration,
    );
    return {
      status: thread.status,
      runningTurnId: running?.turnId ?? null,
      alreadyCanceled,
      attemptGeneration: thread.attemptGeneration!,
      threadUpdatedAt: thread.updatedAt,
    };
  },
});

export const getMyCloudAgentThreadControl = query({
  args: {
    ownerGeneration: v.string(),
    threadId: v.string(),
    originDeviceId: v.string(),
    originConversationId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      status: v.string(),
      runningTurnId: v.union(v.string(), v.null()),
      alreadyCanceled: v.boolean(),
      attemptGeneration: v.number(),
      threadUpdatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    await assertOwnerDataWriteAllowed(ctx, ownerId, args.ownerGeneration);
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (
      !thread ||
      thread.ownerId !== ownerId ||
      thread.ownerGeneration !== args.ownerGeneration ||
      thread.originDeviceId !== args.originDeviceId ||
      thread.originConversationId !== args.originConversationId ||
      !Number.isSafeInteger(thread.attemptGeneration) ||
      thread.attemptGeneration! < 1
    ) {
      return null;
    }
    const recentTurns =
      thread.status === "running"
        ? await ctx.db
            .query("agent_turns")
            .withIndex("by_threadId_ownerGeneration_createdAt", (q) =>
              q
                .eq("threadId", args.threadId)
                .eq("ownerGeneration", args.ownerGeneration),
            )
            .order("desc")
            .take(2)
        : [];
    const running = recentTurns.find(
      (turn) =>
        turn.status === "running" &&
        turn.attemptGeneration === thread.attemptGeneration,
    );
    return {
      status: thread.status,
      runningTurnId:
        running?.attemptGeneration === thread.attemptGeneration
          ? (running?.turnId ?? null)
          : null,
      alreadyCanceled: false,
      attemptGeneration: thread.attemptGeneration!,
      threadUpdatedAt: thread.updatedAt,
    };
  },
});

export const isCloudAgentTurnDispatchableInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    threadId: v.string(),
    turnId: v.string(),
    attemptGeneration: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    return Boolean(
      thread &&
        thread.ownerId === args.ownerId &&
        thread.ownerGeneration === args.ownerGeneration &&
        thread.attemptGeneration === args.attemptGeneration &&
        thread.status === "running" &&
        turn &&
        turn.ownerId === args.ownerId &&
        turn.ownerGeneration === args.ownerGeneration &&
        turn.attemptGeneration === args.attemptGeneration &&
        turn.threadId === args.threadId &&
        turn.status === "running",
    );
  },
});

/**
 * Runtime authority for one already-admitted agent executor. Unlike the
 * scheduler's dispatchability check above, this includes the current token
 * hash so rotating a token quiesces an already-running stale sandbox even when
 * the logical turn and attempt generation did not change.
 */
export const isCloudAgentTurnAttemptAuthoritativeInternal = internalQuery({
  args: {
    tokenHash: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    threadId: v.string(),
    turnId: v.string(),
    attemptGeneration: v.number(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const authority = await resolveCurrentTurnToken(ctx, args, true);
    const turn = authority?.turn;
    if (
      !turn ||
      turn.kind !== "agent" ||
      turn.threadId !== args.threadId ||
      turn.attemptGeneration !== args.attemptGeneration
    ) {
      return false;
    }
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();
    return Boolean(
      thread &&
        thread.ownerId === args.ownerId &&
        thread.ownerGeneration === args.ownerGeneration &&
        thread.attemptGeneration === args.attemptGeneration &&
        thread.status === "running",
    );
  },
});

export const cancelCloudAgentTurnInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    threadId: v.string(),
    turnId: v.string(),
    attemptGeneration: v.number(),
    controlRequestId: v.string(),
    now: v.number(),
  },
  returns: v.object({
    canceled: v.boolean(),
    status: v.string(),
    threadId: v.string(),
    attemptGeneration: v.number(),
    threadUpdatedAt: v.number(),
    currentControl: v.object({
      threadId: v.string(),
      status: v.string(),
      attemptGeneration: v.number(),
      threadUpdatedAt: v.number(),
    }),
  }),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    if (
      !thread ||
      thread.ownerId !== args.ownerId ||
      thread.ownerGeneration !== args.ownerGeneration ||
      !turn ||
      turn.ownerId !== args.ownerId ||
      turn.ownerGeneration !== args.ownerGeneration ||
      turn.attemptGeneration !== args.attemptGeneration ||
      turn.threadId !== args.threadId
    ) {
      throw new ConvexError("Thread not found.");
    }
    const currentControl = (
      status = thread.status,
      attemptGeneration = thread.attemptGeneration!,
      threadUpdatedAt = thread.updatedAt,
    ) => ({
      threadId: thread.threadId,
      status,
      attemptGeneration,
      threadUpdatedAt,
    });
    if (turn.cancelRequestId === args.controlRequestId) {
      return {
        canceled: true,
        status: turn.status === "running" ? "canceled" : turn.status,
        threadId: args.threadId,
        attemptGeneration: args.attemptGeneration,
        threadUpdatedAt: turn.updatedAt,
        currentControl: currentControl(),
      };
    }
    if (thread.attemptGeneration !== turn.attemptGeneration) {
      // The cancel request did stop its exact turn, but a continuation won
      // before this bookkeeping mutation arrived. Record the request for
      // retry idempotency and never project the old cancel onto the successor.
      await ctx.db.patch(turn._id, {
        cancelRequestId: args.controlRequestId,
      });
      return {
        canceled: true,
        status: turn.status === "running" ? "canceled" : turn.status,
        threadId: args.threadId,
        attemptGeneration: args.attemptGeneration,
        threadUpdatedAt: turn.updatedAt,
        currentControl: currentControl(),
      };
    }
    if (turn.status === "canceled" || turn.terminalKind === "canceled") {
      await ctx.db.patch(turn._id, {
        cancelRequestId: args.controlRequestId,
        ...(turn.terminalTokenHash || !turn.activeTokenHash
          ? {}
          : { terminalTokenHash: turn.activeTokenHash }),
      });
      if (thread.status === "running") {
        await ctx.db.patch(thread._id, {
          status: "canceled",
          resultJson: undefined,
          errorMessage: "Paused by orchestrator.",
          updatedAt: args.now,
        });
      }
      return {
        canceled: true,
        status: "canceled",
        threadId: thread.threadId,
        attemptGeneration: args.attemptGeneration,
        threadUpdatedAt:
          thread.status === "running" ? args.now : turn.updatedAt,
        currentControl:
          thread.status === "running"
            ? currentControl("canceled", args.attemptGeneration, args.now)
            : currentControl(),
      };
    }
    if (thread.status !== "running") {
      await ctx.db.patch(turn._id, {
        cancelRequestId: args.controlRequestId,
      });
      return {
        canceled: true,
        status: thread.status,
        threadId: thread.threadId,
        attemptGeneration: thread.attemptGeneration!,
        threadUpdatedAt: thread.updatedAt,
        currentControl: currentControl(),
      };
    }
    if (turn.status !== "running") {
      return {
        canceled: false,
        status: thread.status,
        threadId: thread.threadId,
        attemptGeneration: thread.attemptGeneration!,
        threadUpdatedAt: thread.updatedAt,
        currentControl: currentControl(),
      };
    }
    const payloadJson = JSON.stringify({
      message: "Stopped. Nothing was changed.",
    });
    const seq = await nextEventSeq(ctx, turn.turnId);
    await ctx.db.insert("agent_events", {
      ownerId: turn.ownerId,
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      seq,
      kind: "canceled",
      payloadJson,
      createdAt: args.now,
    });
    await ctx.db.patch(turn._id, {
      status: "canceled",
      terminalKind: "canceled",
      errorMessage: payloadJson,
      cancelRequestId: args.controlRequestId,
      ...(turn.activeTokenHash
        ? { terminalTokenHash: turn.activeTokenHash }
        : {}),
      updatedAt: args.now,
    });
    await ctx.db.patch(thread._id, {
      status: "canceled",
      resultJson: undefined,
      errorMessage: "Paused by orchestrator.",
      updatedAt: args.now,
    });
    return {
      canceled: true,
      status: "canceled",
      threadId: thread.threadId,
      attemptGeneration: args.attemptGeneration,
      threadUpdatedAt: args.now,
      currentControl: currentControl(
        "canceled",
        args.attemptGeneration,
        args.now,
      ),
    };
  },
});

export const cancelMyCloudAgentThread = action({
  args: {
    ownerGeneration: v.string(),
    threadId: v.string(),
    expectedAttemptGeneration: v.number(),
    expectedThreadUpdatedAt: v.number(),
    originDeviceId: v.string(),
    originConversationId: v.string(),
    controlRequestId: v.string(),
  },
  returns: v.object({
    canceled: v.boolean(),
    status: v.string(),
    threadId: v.string(),
    attemptGeneration: v.number(),
    threadUpdatedAt: v.number(),
    currentControl: v.object({
      threadId: v.string(),
      status: v.string(),
      attemptGeneration: v.number(),
      threadUpdatedAt: v.number(),
    }),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    canceled: boolean;
    status: string;
    threadId: string;
    attemptGeneration: number;
    threadUpdatedAt: number;
    currentControl: {
      threadId: string;
      status: string;
      attemptGeneration: number;
      threadUpdatedAt: number;
    };
  }> => {
    const ownerId = await requireOwnerId(ctx);
    const { generation } = await assertOwnerDataAccessActive(ctx, ownerId);
    if (!args.ownerGeneration.trim() || generation !== args.ownerGeneration) {
      throw new ConvexError({
        code: "OWNER_DATA_GENERATION_STALE",
        message: "This pause started before the account data was reset.",
      });
    }
    const threadId = args.threadId.trim();
    const originDeviceId = args.originDeviceId.trim();
    const originConversationId = args.originConversationId.trim();
    const controlRequestId = normalizeClientMsgId(args.controlRequestId);
    if (!threadId) throw new ConvexError("threadId is required.");
    if (
      !originDeviceId ||
      originDeviceId.length > 256 ||
      !originConversationId ||
      originConversationId.length > 256
    ) {
      throw new ConvexError("Invalid desktop cloud-agent origin.");
    }
    if (!controlRequestId) {
      throw new ConvexError("A cloud pause needs a request id.");
    }
    await enforceActionRateLimit(
      ctx,
      "cloud_agent_cancel",
      ownerId,
      { rate: 30, periodMs: 10 * 60_000 },
      "Too many cloud agents paused at once. Wait a moment and try again.",
    );
    const control: CloudAgentThreadControl | null = await ctx.runQuery(
      getCloudAgentThreadControlRef,
      {
        ownerId,
        ownerGeneration: generation,
        threadId,
        originDeviceId,
        originConversationId,
        controlRequestId,
      },
    );
    if (!control) throw new ConvexError(`Thread not found: ${threadId}`);
    if (control.alreadyCanceled) {
      return {
        canceled: true,
        status: control.status,
        threadId,
        attemptGeneration: control.attemptGeneration,
        threadUpdatedAt: control.threadUpdatedAt,
        currentControl: control.currentControl ?? {
          threadId,
          status: control.status,
          attemptGeneration: control.attemptGeneration,
          threadUpdatedAt: control.threadUpdatedAt,
        },
      };
    }
    if (control.status !== "running") {
      return {
        canceled: true,
        status: control.status,
        threadId,
        attemptGeneration: control.attemptGeneration,
        threadUpdatedAt: control.threadUpdatedAt,
        currentControl: {
          threadId,
          status: control.status,
          attemptGeneration: control.attemptGeneration,
          threadUpdatedAt: control.threadUpdatedAt,
        },
      };
    }
    if (
      control.attemptGeneration !== args.expectedAttemptGeneration ||
      control.threadUpdatedAt !== args.expectedThreadUpdatedAt
    ) {
      throw new ConvexError(
        "The cloud thread changed while it was being paused. Try again.",
      );
    }
    if (!control.runningTurnId) {
      throw new ConvexError(
        "The cloud thread has no active turn to pause. Try again in a moment.",
      );
    }
    const builder = builderEndpoint();
    if (!builder) throw new ConvexError("Cloud builder is not configured.");
    const response = await fetch(
      `${builder.url}/sessions/${encodeURIComponent(threadId)}/cancel`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${builder.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ownerId,
          ownerGeneration: generation,
          turnId: control.runningTurnId,
          attemptGeneration: control.attemptGeneration,
          cancelRequestId: controlRequestId,
          reason: "Paused by orchestrator.",
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 409) {
      throw new ConvexError(
        "The cloud thread changed while it was being paused. Try again.",
      );
    }
    if (!response.ok) {
      throw new ConvexError("The cloud agent could not be paused. Try again.");
    }
    const canceled: {
      canceled: boolean;
      status: string;
      threadId: string;
      attemptGeneration: number;
      threadUpdatedAt: number;
      currentControl: {
        threadId: string;
        status: string;
        attemptGeneration: number;
        threadUpdatedAt: number;
      };
    } = await ctx.runMutation(cancelCloudAgentTurnRef, {
      ownerId,
      ownerGeneration: generation,
      threadId,
      turnId: control.runningTurnId,
      attemptGeneration: control.attemptGeneration,
      controlRequestId,
      now: Date.now(),
    });
    if (!canceled.canceled) {
      throw new ConvexError(
        "The cloud thread changed while it was being paused. Try again.",
      );
    }
    return canceled;
  },
});

export const runCloudAgentTurnInternal = internalAction({
  args: {
    ownerId: v.string(),
    conversationId: v.string(),
    threadId: v.string(),
    turnId: v.string(),
    prompt: v.string(),
    turnToken: v.string(),
    ownerGeneration: v.string(),
    attemptGeneration: v.number(),
    execution: v.optional(cloudExecutionSelectionValidator),
    browserResume: v.optional(cloudBrowserResumeReceiptValidator),
    convexCallbackBase: v.optional(v.string()),
    dispatchAttempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const builderSecret = process.env.BUILDER_SERVICE_SECRET?.trim();
    const failure = "Stella couldn't start that agent. Try again in a moment.";
    const dispatchAttempt = args.dispatchAttempt ?? 0;
    const pinnedCallbackBase =
      args.convexCallbackBase?.trim() ?? process.env.CONVEX_SITE_URL?.trim();
    // Publish the next exact attempt before the first await/read. The action is
    // otherwise the only copy of this admission after the creating mutation's
    // scheduled call starts, so a process loss in any preflight gap must leave
    // a durable successor behind.
    const retryId = await ctx.scheduler.runAfter(45_000, runCloudAgentTurnRef, {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      threadId: args.threadId,
      turnId: args.turnId,
      prompt: args.prompt,
      turnToken: args.turnToken,
      ownerGeneration: args.ownerGeneration,
      attemptGeneration: args.attemptGeneration,
      ...(args.execution ? { execution: args.execution } : {}),
      ...(args.browserResume ? { browserResume: args.browserResume } : {}),
      ...(pinnedCallbackBase ? { convexCallbackBase: pinnedCallbackBase } : {}),
      dispatchAttempt: dispatchAttempt + 1,
    });
    try {
      await assertExpectedOwnerGenerationActive(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    } catch (error) {
      const data =
        error && typeof error === "object" && "data" in error
          ? (error as { data?: unknown }).data
          : undefined;
      const definitelyStale =
        data !== null &&
        typeof data === "object" &&
        (data as { code?: unknown }).code === "OWNER_DATA_GENERATION_STALE";
      if (definitelyStale) {
        await ctx.scheduler.cancel(retryId).catch(() => undefined);
      }
      console.warn(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: definitelyStale
            ? "agent_dispatch_authority_lost"
            : "agent_dispatch_authority_retrying",
          turnId: args.turnId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
    if (!builderUrl || !builderSecret) {
      await ctx.runMutation(failCloudAgentDispatchRef, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        conversationId: args.conversationId,
        threadId: args.threadId,
        turnId: args.turnId,
        attemptGeneration: args.attemptGeneration,
        message: failure,
        now: Date.now(),
      });
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    const initiallyDispatchable = await ctx.runQuery(
      isCloudAgentTurnDispatchableRef,
      {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        threadId: args.threadId,
        turnId: args.turnId,
        attemptGeneration: args.attemptGeneration,
      },
    );
    if (!initiallyDispatchable) {
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    const execution =
      args.execution ?? (await resolveOwnerExecution(ctx, args.ownerId));
    const convexCallbackBase = pinnedCallbackBase;
    if (!convexCallbackBase) {
      await ctx.runMutation(failCloudAgentDispatchRef, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        conversationId: args.conversationId,
        threadId: args.threadId,
        turnId: args.turnId,
        attemptGeneration: args.attemptGeneration,
        message: failure,
        now: Date.now(),
      });
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    const tokenHash = await hashToken(args.turnToken);
    let tokenReady = false;
    try {
      if (dispatchAttempt === 0) {
        await ctx.runMutation(storeTurnTokenRef, {
          tokenHash,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          turnId: args.turnId,
          agentType: "general",
          execution,
          now: Date.now(),
        });
        tokenReady = true;
      } else {
        tokenReady = await ctx.runMutation(ensureTurnTokenForDispatchRef, {
          tokenHash,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          turnId: args.turnId,
          agentType: "general",
          execution,
          now: Date.now(),
        });
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "agent_dispatch_token_pending",
          turnId: args.turnId,
          dispatchAttempt,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      // The pre-published successor owns recovery. It can fill an empty token
      // slot but cannot rotate a different/newer token back to this attempt.
      return null;
    }
    if (!tokenReady) {
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    const authoritative = await ctx.runQuery(
      isCloudAgentTurnAttemptAuthoritativeRef,
      {
        tokenHash,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        threadId: args.threadId,
        turnId: args.turnId,
        attemptGeneration: args.attemptGeneration,
        now: Date.now(),
      },
    );
    if (!authoritative) {
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    let response: Response;
    try {
      response = await fetch(
        `${builderUrl.replace(/\/+$/, "")}/sessions/${args.threadId}/turns`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${builderSecret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "agent",
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            attemptGeneration: args.attemptGeneration,
            conversationId: args.conversationId,
            threadId: args.threadId,
            turnId: args.turnId,
            prompt: args.prompt,
            turnToken: args.turnToken,
            convexCallbackBase,
            execution,
            ...(args.browserResume
              ? { browserResume: args.browserResume }
              : {}),
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "agent_dispatch_response_ambiguous",
          turnId: args.turnId,
          dispatchAttempt,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      // The request may already have committed in the BuildSession. Its exact
      // durable replay receipt lets the pre-published successor converge.
      return null;
    }
    if (response.ok) {
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
      return null;
    }
    if (
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "agent_dispatch_response_retrying",
          turnId: args.turnId,
          dispatchAttempt,
          status: response.status,
        }),
      );
      return null;
    }
    console.error(
      JSON.stringify({
        service: "convex-cloud-apps",
        event: "agent_dispatch_response_rejected",
        turnId: args.turnId,
        dispatchAttempt,
        status: response.status,
      }),
    );
    await ctx.runMutation(failCloudAgentDispatchRef, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      conversationId: args.conversationId,
      threadId: args.threadId,
      turnId: args.turnId,
      attemptGeneration: args.attemptGeneration,
      message: "Stella hit a snag starting that agent. Try again.",
      now: Date.now(),
    });
    await ctx.scheduler.cancel(retryId).catch(() => undefined);
    return null;
  },
});

/**
 * Definitive pre-admission failure is one transaction: terminal turn, thread
 * projection, and descendant wake either all commit or none do. This also
 * repairs the legacy crash window where the turn was failed but its thread
 * remained running.
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
    if (thread.originDeviceId && thread.originConversationId) return null;
    await startChatTurn(ctx, {
      ownerId: thread.ownerId,
      conversationId: thread.conversationId,
      prompt: `[Agent failed] ${thread.description} (thread ${thread.threadId})\n\n${args.message}`,
      lane: "wake",
      source: "agent-thread",
      hiddenMessage: true,
      ownerGeneration: args.ownerGeneration,
      agentThreadControl: {
        threadId: thread.threadId,
        attemptGeneration: args.attemptGeneration,
        threadUpdatedAt: args.now,
        status: "failed",
      },
      now: args.now,
    });
    return null;
  },
});

export const completeAgentThreadInternal = internalMutation({
  args: {
    // Present only for token-authenticated HTTP calls. Service callbacks are
    // separately authenticated but must still name completingTurnId below.
    tokenHash: v.optional(v.string()),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    threadId: v.string(),
    attemptGeneration: v.number(),
    status: v.string(),
    resultJson: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    wake: v.optional(v.boolean()),
    // Set when the caller authenticated with a turn token: the token's turn
    // must belong to the thread it is completing. Service-secret callers
    // (the DOs) omit it.
    callerTurnId: v.optional(v.string()),
    // The turn whose outcome this is, from either credential. A thread outlives
    // its turns, so this is what says whether the caller still speaks for it.
    completingTurnId: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    if (!["completed", "failed", "canceled"].includes(args.status)) {
      throw new ConvexError("Invalid thread status.");
    }
    if (
      !Number.isSafeInteger(args.attemptGeneration) ||
      args.attemptGeneration < 1
    ) {
      throw new ConvexError("Invalid attempt generation.");
    }
    const completing = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.completingTurnId))
      .unique();
    if (args.tokenHash) {
      if (args.callerTurnId !== args.completingTurnId) {
        throw new ConvexError("Cloud turn is no longer active.");
      }
      const exactTerminalReceipt =
        Boolean(completing?.terminalKind) &&
        completing?.terminalTokenHash === args.tokenHash;
      if (!exactTerminalReceipt) {
        if (completing?.terminalTokenHash) {
          throw new ConvexError("Cloud turn is no longer active.");
        }
        const authority = await resolveCurrentTurnToken(
          ctx,
          {
            tokenHash: args.tokenHash,
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            turnId: args.completingTurnId,
            now: args.now,
          },
          false,
        );
        if (!authority) {
          throw new ConvexError("Cloud turn is no longer active.");
        }
      }
    }
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (
      !thread ||
      thread.ownerId !== args.ownerId ||
      thread.ownerGeneration !== args.ownerGeneration
    ) {
      throw new ConvexError("Unknown agent thread.");
    }
    // A late terminal receipt from attempt N is an idempotent no-op after
    // attempt N+1 has taken the thread. It may finish its own turn, but it must
    // never project that result onto the reused thread identity.
    if (thread.attemptGeneration !== args.attemptGeneration) return null;

    // This callback is thread-scoped, and the only thing that used to fence it
    // was the thread not being "running" — which a continuation has just
    // undone. So an outcome delivered late for a superseded turn (a DO
    // replaying a terminal payload it never managed to deliver) would cancel
    // the thread out from under the turn now running on it: the user is told
    // the agent stopped, and the live turn's own report is dropped as a
    // duplicate when it finally lands. A turn that a newer turn on the same
    // thread has already replaced completes itself, not the thread.
    if (
      !completing ||
      completing.ownerId !== args.ownerId ||
      completing.ownerGeneration !== args.ownerGeneration ||
      completing.threadId !== args.threadId ||
      completing.attemptGeneration !== args.attemptGeneration
    ) {
      throw new ConvexError("Turn does not belong to this thread.");
    }
    if (
      !completing.terminalKind ||
      completing.status === "running" ||
      completing.status !== args.status
    ) {
      // Thread completion is a projection of the already-durable terminal turn,
      // never an alternate terminalization path. This also makes a still-live
      // sandbox token incapable of closing the thread while retaining callback
      // authority.
      throw new ConvexError("Cloud turn is not terminal with that status.");
    }
    if (thread.status !== "running") return null;
    await ctx.db.patch(thread._id, {
      status: args.status,
      resultJson: args.resultJson,
      errorMessage: args.errorMessage,
      updatedAt: args.now,
    });
    if (args.wake === false) return null;
    // Desktop-originated threads have exactly one terminal-delivery owner:
    // the originating device's reactive subscription. Waking the cloud
    // conversation as well would duplicate the agent report in two
    // orchestrators. The desktop ACKs only after durable local persistence.
    if (thread.originDeviceId && thread.originConversationId) {
      return null;
    }

    // Wake the orchestrator with a lifecycle turn, mirroring the desktop
    // runtime's follow-up delivery for task lifecycle events. The turn itself
    // is VISIBLE — it is the only turn that carries the orchestrator's relay
    // of the agent's report, so hiding it would hide the result from the
    // user. Only its lifecycle prompt is hidden (the UI skips the user bubble
    // for lane "wake"; the transcript row below stays hidden context).
    let resultText = args.errorMessage ?? "";
    if (args.resultJson) {
      try {
        const parsed = JSON.parse(args.resultJson) as { finalText?: string };
        resultText =
          typeof parsed.finalText === "string" && parsed.finalText.trim()
            ? parsed.finalText
            : args.resultJson;
      } catch {
        resultText = args.resultJson;
      }
    }
    const label =
      args.status === "completed"
        ? "[Agent completed]"
        : args.status === "canceled"
          ? "[Agent canceled]"
          : "[Agent failed]";
    const lifecycleText = `${label} ${thread.description} (thread ${thread.threadId})\n\n${
      resultText || "No result was reported."
    }`;
    const wake = await startChatTurn(ctx, {
      ownerId: thread.ownerId,
      conversationId: thread.conversationId,
      prompt: lifecycleText,
      lane: "wake",
      source: "agent-thread",
      hiddenMessage: true,
      ownerGeneration: args.ownerGeneration,
      agentThreadControl: {
        threadId: thread.threadId,
        attemptGeneration: args.attemptGeneration,
        threadUpdatedAt: args.now,
        status: args.status as "completed" | "failed" | "canceled",
      },
      now: args.now,
    });
    // C4: the sandbox emits `output_files` on its own hidden turn, but the
    // files belong to the next VISIBLE turn — the wake turn carrying the
    // agent's report — so they surface where the user is actually reading.
    // The card is a journal row keyed by that turn, so it survives scrollback
    // instead of living only inside the tail's event window.
    const files = await collectThreadOutputFiles(ctx, args.threadId);
    if (files.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.cloud_apps.postConversationCardInternal,
        {
          ownerId: thread.ownerId,
          ownerGeneration: args.ownerGeneration,
          conversationId: thread.conversationId,
          sourceTurnId: wake.turnId,
          card: { type: "files", files },
        },
      );
    }
    return null;
  },
});

const OUTPUT_FILE_CARD_MAX = 20;

/**
 * Files a thread produced, newest description wins. Bounded on both axes: a
 * thread's turns and each turn's events, because this runs inside the
 * completion mutation and must not be able to blow its read budget.
 */
const collectThreadOutputFiles = async (
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

// Dev-only probe: drives the chat lane end to end without a signed-in
// client. Run with `bunx convex run cloud_apps:startChatProbeInternal`.
export const startChatProbeInternal = internalMutation({
  args: {
    prompt: v.string(),
    ownerId: v.optional(v.string()),
    conversationId: v.optional(v.string()),
  },
  returns: v.object({ conversationId: v.string(), turnId: v.string() }),
  handler: async (ctx, args) =>
    await startChatTurn(ctx, {
      ownerId: args.ownerId ?? "probe:cloud-chat",
      conversationId: args.conversationId,
      prompt: args.prompt,
      source: "probe",
      title: `[probe] ${args.prompt.slice(0, 40)}`,
      now: Date.now(),
    }),
});

export const getTurnProbeInternal = internalQuery({
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
    return {
      status: turn.status,
      terminalKind: turn.terminalKind,
      errorMessage: turn.errorMessage,
      // `hidden` on the turn is what the tail filters on. The transcript half
      // of this probe moved to `getConversationProbeInternal`, which reads the
      // DO's journal — Convex no longer holds conversation messages.
      hidden: turn.hidden === true,
      source: turn.source,
      lane: turn.lane,
      clientMsgId: turn.clientMsgId,
      conversationId: turn.conversationId,
      events: events.map((event) => ({
        seq: event.seq,
        kind: event.kind,
        payload: JSON.parse(event.payloadJson),
      })),
    };
  },
});

// Dev-only probe: the spawned-agent half of a turn, which
// `getTurnProbeInternal` cannot see because a thread's transcript lives under
// its own conversationId.
export const getAgentThreadProbeInternal = internalQuery({
  args: { ownerId: v.string(), limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const threads = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .order("desc")
      .take(args.limit ?? 3);
    return await Promise.all(
      threads.map(async (thread) => {
        const turns = await ctx.db
          .query("agent_turns")
          .withIndex("by_threadId_and_createdAt", (q) =>
            q.eq("threadId", thread.threadId),
          )
          .order("desc")
          .take(1);
        const turn = turns[0];
        const events = turn
          ? await ctx.db
              .query("agent_events")
              .withIndex("by_turnId_and_seq", (q) =>
                q.eq("turnId", turn.turnId),
              )
              .take(200)
          : [];
        return {
          threadId: thread.threadId,
          turnId: turn?.turnId,
          placement: thread.placement,
          status: thread.status,
          description: thread.description,
          turnStatus: turn?.status,
          errorMessage: thread.errorMessage ?? turn?.errorMessage,
          resultJson: thread.resultJson?.slice(0, 600),
          events: events.map((event) => ({
            seq: event.seq,
            kind: event.kind,
            payload: JSON.parse(event.payloadJson),
          })),
        };
      }),
    );
  },
});

export const listMyAgentThreads = query({
  args: { conversationId: v.string() },
  returns: v.array(cloudAgentThreadProjectionValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const rows = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_conversationId_and_ownerId_and_updatedAt", (q) =>
        q.eq("conversationId", args.conversationId).eq("ownerId", ownerId),
      )
      .order("desc")
      .take(30);
    return rows.map(projectCloudAgentThread);
  },
});

const MAX_AGENT_THREADS_PER_PAGE = 50;

/**
 * Complete conversation-scoped Activity history. The compound index applies
 * both the conversation and authenticated owner before Convex creates the
 * cursor, so every continuation stays inside the same authorization range.
 * Descending `updatedAt` matches the live Activity ordering; Convex's index
 * cursor supplies the deterministic tie-breaker for equal timestamps.
 */
export const listMyAgentThreadsPage = query({
  args: {
    conversationId: v.string(),
    // Cache-key fence only. Authorization always comes from `requireOwnerId`.
    // The renderer increments this whenever its immutable account scope
    // changes, forcing `usePaginatedQuery` to discard the prior cursor set.
    identityRevision: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: cloudAgentThreadPageValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    if (
      !Number.isSafeInteger(args.identityRevision) ||
      args.identityRevision < 0
    ) {
      throw new ConvexError("Invalid identity revision.");
    }
    const numItems = Math.min(
      Math.max(args.paginationOpts.numItems, 1),
      MAX_AGENT_THREADS_PER_PAGE,
    );
    const result = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_conversationId_and_ownerId_and_updatedAt", (q) =>
        q.eq("conversationId", args.conversationId).eq("ownerId", ownerId),
      )
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems,
      });
    return {
      ...result,
      page: result.page.map(projectCloudAgentThread),
    };
  },
});

// One runtime admits at most 48 concurrent local agents and a cloud account
// adds at most 6 cloud sandboxes. Keep headroom for lifecycle overlap while
// retaining a hard Convex read bound.
const MAX_RUNNING_AGENT_THREADS = 64;

/**
 * Active rows are subscribed independently of the history cursor so a
 * long-running thread cannot fall out of Activity after 30 newer completions.
 */
export const listMyRunningAgentThreads = query({
  args: {
    conversationId: v.string(),
    identityRevision: v.number(),
  },
  returns: v.array(cloudAgentThreadProjectionValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    if (
      !Number.isSafeInteger(args.identityRevision) ||
      args.identityRevision < 0
    ) {
      throw new ConvexError("Invalid identity revision.");
    }
    const rows = await ctx.db
      .query("cloud_agent_threads")
      .withIndex(
        "by_conversationId_and_ownerId_and_status_and_updatedAt",
        (q) =>
          q
            .eq("conversationId", args.conversationId)
            .eq("ownerId", ownerId)
            .eq("status", "running"),
      )
      .order("desc")
      .take(MAX_RUNNING_AGENT_THREADS);
    return rows.map(projectCloudAgentThread);
  },
});

/**
 * Activity renders every cloud thread the owner has, not just the newest
 * conversation's — a desktop-dispatched agent must stay visible while another
 * conversation is bumped. Ownership is the index key, so no post-filter.
 */
export const listMyRecentAgentThreads = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(cloudAgentThreadProjectionValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const rows = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 30, 1), 100));
    return rows.map(projectCloudAgentThread);
  },
});

/**
 * Restart-safe subscription surface for one desktop installation. The owner
 * and device are both in the index prefix, so a device cannot observe another
 * account or make Convex scan unrelated threads. Running and terminal threads
 * both remain here until the device ACKs durable local persistence; the ACK
 * moves them out of this index range. `sinceUpdatedAt` is an optional cursor
 * for a live process, while omitting it is the restart recovery path.
 */
export const listMyDeviceAgentThreads = query({
  args: {
    originDeviceId: v.string(),
    ownerGeneration: v.string(),
    sinceUpdatedAt: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      threadId: v.string(),
      cloudConversationId: v.string(),
      originDeviceId: v.string(),
      originConversationId: v.string(),
      parentTurnId: v.union(v.string(), v.null()),
      description: v.string(),
      placement: executionPlacementValidator,
      agentType: v.string(),
      ownerGeneration: v.string(),
      attemptGeneration: v.number(),
      status: v.string(),
      resultJson: v.union(v.string(), v.null()),
      errorMessage: v.union(v.string(), v.null()),
      originDeliveryAckAt: v.null(),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const ownerGeneration = args.ownerGeneration.trim();
    if (!ownerGeneration || ownerGeneration.length > 256) {
      throw new ConvexError("Invalid ownerGeneration.");
    }
    await assertOwnerDataWriteAllowed(ctx, ownerId, ownerGeneration);
    const originDeviceId = args.originDeviceId.trim();
    if (!originDeviceId || originDeviceId.length > 256) {
      throw new ConvexError("Invalid originDeviceId.");
    }
    const requestedLimit = args.limit ?? 50;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new ConvexError("limit must be a positive integer.");
    }
    if (
      args.sinceUpdatedAt !== undefined &&
      (!Number.isFinite(args.sinceUpdatedAt) || args.sinceUpdatedAt < 0)
    ) {
      throw new ConvexError("sinceUpdatedAt must be a non-negative number.");
    }
    const rows = await ctx.db
      .query("cloud_agent_threads")
      .withIndex(
        "by_ownerId_ownerGeneration_originDeviceId_ackAt_updatedAt",
        (q) => {
          const deviceRows = q
            .eq("ownerId", ownerId)
            .eq("ownerGeneration", ownerGeneration)
            .eq("originDeviceId", originDeviceId)
            .eq("originDeliveryAckAt", undefined);
          return args.sinceUpdatedAt === undefined
            ? deviceRows
            : deviceRows.gte("updatedAt", args.sinceUpdatedAt);
        },
      )
      .order("desc")
      .take(Math.min(requestedLimit, 100));
    return rows.flatMap((row) =>
      row.originDeviceId &&
      row.originConversationId &&
      row.ownerGeneration === ownerGeneration &&
      typeof row.attemptGeneration === "number"
        ? [
            {
              threadId: row.threadId,
              cloudConversationId: row.conversationId,
              originDeviceId: row.originDeviceId,
              originConversationId: row.originConversationId,
              parentTurnId: row.parentTurnId ?? null,
              description: row.description,
              placement: row.placement,
              agentType: row.agentType,
              ownerGeneration,
              attemptGeneration: row.attemptGeneration,
              status: row.status,
              resultJson: row.resultJson ?? null,
              errorMessage: row.errorMessage ?? null,
              originDeliveryAckAt: null,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            },
          ]
        : [],
    );
  },
});

/**
 * Removes a terminal thread from a desktop's recovery subscription only after
 * that desktop has durably stored the lifecycle event. Idempotent for retrying
 * the ACK request after an uncertain network response.
 */
export const acknowledgeMyDeviceAgentThreadDelivery = mutation({
  args: {
    threadId: v.string(),
    originDeviceId: v.string(),
    ownerGeneration: v.string(),
    attemptGeneration: v.number(),
    terminalUpdatedAt: v.number(),
  },
  returns: v.object({
    acknowledged: v.boolean(),
    acknowledgedAt: v.union(v.number(), v.null()),
    superseded: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const ownerGeneration = args.ownerGeneration.trim();
    if (!ownerGeneration || ownerGeneration.length > 256) {
      throw new ConvexError("Invalid ownerGeneration.");
    }
    await assertOwnerDataWriteAllowed(ctx, ownerId, ownerGeneration);
    const originDeviceId = args.originDeviceId.trim();
    if (!originDeviceId || originDeviceId.length > 256) {
      throw new ConvexError("Invalid originDeviceId.");
    }
    if (
      !Number.isSafeInteger(args.attemptGeneration) ||
      args.attemptGeneration < 1
    ) {
      throw new ConvexError("Invalid attemptGeneration.");
    }
    if (
      !Number.isFinite(args.terminalUpdatedAt) ||
      args.terminalUpdatedAt < 0
    ) {
      throw new ConvexError("Invalid terminalUpdatedAt.");
    }
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (
      !thread ||
      thread.ownerId !== ownerId ||
      thread.ownerGeneration !== ownerGeneration ||
      thread.originDeviceId !== originDeviceId ||
      !thread.originConversationId
    ) {
      throw new ConvexError("Agent thread not found.");
    }
    // The ACK is a receipt for one exact terminal generation/revision, not for
    // the mutable thread id. A delayed response from generation N must never
    // acknowledge a completed generation N+1 (or a new running attempt).
    if (
      thread.updatedAt !== args.terminalUpdatedAt ||
      thread.attemptGeneration !== args.attemptGeneration
    ) {
      return {
        acknowledged: false,
        acknowledgedAt: thread.originDeliveryAckAt ?? null,
        superseded: true,
      };
    }
    if (!["completed", "failed", "canceled"].includes(thread.status)) {
      throw new ConvexError(
        "Only a terminal agent thread delivery can be acknowledged.",
      );
    }
    if (thread.originDeliveryAckAt !== undefined) {
      return {
        acknowledged: false,
        acknowledgedAt: thread.originDeliveryAckAt,
        superseded: false,
      };
    }
    const acknowledgedAt = Date.now();
    await ctx.db.patch(thread._id, {
      originDeliveryAckAt: acknowledgedAt,
    });
    return { acknowledged: true, acknowledgedAt, superseded: false };
  },
});

const assertCurrentAppSdkOwner = async (
  ctx: QueryCtx | MutationCtx,
  appId: string,
  ownerId: string,
  ownerGeneration: string,
): Promise<void> => {
  await assertOwnerDataWriteAllowed(ctx, ownerId, ownerGeneration);
  const [app, sourceOwnerFenced] = await Promise.all([
    ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", appId))
      .unique(),
    hasOwnerMigrationSourceFence(ctx, ownerId),
  ]);
  if (
    !appSdkSessionOwnsCurrentApp({
      tokenOwnerId: ownerId,
      currentAppOwnerId: app?.ownerId ?? null,
      sourceOwnerFenced,
    })
  ) {
    throw new ConvexError("App session expired. Reload the app.");
  }
};

export const getStorageInternal = internalQuery({
  args: {
    appId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    userId: v.string(),
    viewerNamespace: v.string(),
    key: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await assertCurrentAppSdkOwner(
      ctx,
      args.appId,
      args.ownerId,
      args.ownerGeneration,
    );
    const namespaced = await ctx.db
      .query("cloud_app_storage")
      .withIndex("by_appId_and_viewerNamespace_and_key", (q) =>
        q
          .eq("appId", args.appId)
          .eq("viewerNamespace", args.viewerNamespace)
          .eq("key", args.key),
      )
      .unique();
    if (namespaced) return namespaced;
    return await ctx.db
      .query("cloud_app_storage")
      .withIndex("by_appId_and_userId_and_key", (q) =>
        q.eq("appId", args.appId).eq("userId", args.userId).eq("key", args.key),
      )
      .unique();
  },
});

export const listStorageInternal = internalQuery({
  args: {
    appId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    userId: v.string(),
    viewerNamespace: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await assertCurrentAppSdkOwner(
      ctx,
      args.appId,
      args.ownerId,
      args.ownerGeneration,
    );
    const [namespaced, legacy] = await Promise.all([
      ctx.db
      .query("cloud_app_storage")
      .withIndex("by_appId_and_viewerNamespace", (q) =>
        q.eq("appId", args.appId).eq("viewerNamespace", args.viewerNamespace),
      )
      .take(101),
      ctx.db
      .query("cloud_app_storage")
      .withIndex("by_appId_and_userId", (q) =>
        q.eq("appId", args.appId).eq("userId", args.userId),
      )
      .take(101),
    ]);
    const byKey = new Map(legacy.map((row) => [row.key, row]));
    for (const row of namespaced) byKey.set(row.key, row);
    return [...byKey.values()].slice(0, 101);
  },
});

export const setStorageInternal = internalMutation({
  args: {
    appId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    userId: v.string(),
    viewerNamespace: v.string(),
    key: v.string(),
    valueJson: v.string(),
    sizeBytes: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertCurrentAppSdkOwner(
      ctx,
      args.appId,
      args.ownerId,
      args.ownerGeneration,
    );
    if (args.key.length < 1 || args.key.length > 128) {
      throw new ConvexError("Storage keys must be 1–128 characters.");
    }
    if (args.sizeBytes > 16 * 1024) {
      throw new ConvexError("Storage value exceeds the 16 KB per-key limit.");
    }
    const [namespacedRows, legacyRows] = await Promise.all([
      ctx.db
      .query("cloud_app_storage")
      .withIndex("by_appId_and_viewerNamespace", (q) =>
        q.eq("appId", args.appId).eq("viewerNamespace", args.viewerNamespace),
      )
      .take(101),
      ctx.db
      .query("cloud_app_storage")
      .withIndex("by_appId_and_userId", (q) =>
        q.eq("appId", args.appId).eq("userId", args.userId),
      )
      .take(101),
    ]);
    const byKey = new Map(legacyRows.map((row) => [row.key, row]));
    for (const row of namespacedRows) byKey.set(row.key, row);
    const rows = [...byKey.values()];
    const existing = rows.find((row) => row.key === args.key);
    if (!existing && rows.length >= 100) {
      throw new ConvexError("Storage quota reached: maximum 100 keys.");
    }
    const total =
      rows.reduce((sum, row) => sum + row.sizeBytes, 0) -
      (existing?.sizeBytes ?? 0) +
      args.sizeBytes;
    if (total > 64 * 1024) {
      throw new ConvexError("Storage quota reached: maximum 64 KB per app.");
    }
    if (existing) {
      await ctx.db.patch(existing._id, {
        viewerNamespace: args.viewerNamespace,
        valueJson: args.valueJson,
        sizeBytes: args.sizeBytes,
        updatedAt: args.now,
      });
      const staleLegacyDuplicate = legacyRows.find(
        (row) => row.key === args.key && row._id !== existing._id,
      );
      if (staleLegacyDuplicate) {
        await ctx.db.delete(staleLegacyDuplicate._id);
      }
    } else {
      await ctx.db.insert("cloud_app_storage", {
        appId: args.appId,
        ownerId: args.ownerId,
        userId: args.userId,
        viewerNamespace: args.viewerNamespace,
        key: args.key,
        valueJson: args.valueJson,
        sizeBytes: args.sizeBytes,
        updatedAt: args.now,
      });
    }
    return null;
  },
});

export const deleteStorageInternal = internalMutation({
  args: {
    appId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    userId: v.string(),
    viewerNamespace: v.string(),
    key: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertCurrentAppSdkOwner(
      ctx,
      args.appId,
      args.ownerId,
      args.ownerGeneration,
    );
    const [namespaced, legacy] = await Promise.all([
      ctx.db
        .query("cloud_app_storage")
        .withIndex("by_appId_and_viewerNamespace_and_key", (q) =>
          q
            .eq("appId", args.appId)
            .eq("viewerNamespace", args.viewerNamespace)
            .eq("key", args.key),
        )
        .unique(),
      ctx.db
        .query("cloud_app_storage")
        .withIndex("by_appId_and_userId_and_key", (q) =>
          q
            .eq("appId", args.appId)
            .eq("userId", args.userId)
            .eq("key", args.key),
        )
        .unique(),
    ]);
    if (namespaced) await ctx.db.delete(namespaced._id);
    if (legacy && legacy._id !== namespaced?._id) await ctx.db.delete(legacy._id);
    return null;
  },
});

export const appendEventInternal = internalMutation({
  args: {
    // Present only when the caller authenticated with a per-turn capability.
    // Service-secret callbacks omit it and retain their separate trusted path.
    tokenHash: v.optional(v.string()),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    turnId: v.string(),
    attemptGeneration: v.optional(v.number()),
    sessionId: v.string(),
    seq: v.number(),
    // Executors that can't coordinate a shared counter with the DO (the
    // in-sandbox agent, the orchestrator loop) let Convex assign max(seq)+1.
    // Auto-seq events skip the duplicate check by construction.
    autoSeq: v.optional(v.boolean()),
    kind: v.string(),
    payloadJson: v.string(),
    terminal: v.boolean(),
    connectedAccount: v.optional(v.boolean()),
    now: v.number(),
  },
  returns: v.object({ inserted: v.boolean(), terminalAccepted: v.boolean() }),
  handler: async (ctx, args) => {
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    if (
      !turn ||
      turn.ownerId !== args.ownerId ||
      turn.ownerGeneration !== args.ownerGeneration ||
      turn.sessionId !== args.sessionId
    ) {
      throw new ConvexError("Unknown cloud turn.");
    }
    const isBrowserSuspension =
      args.kind === "waiting_for_user" && args.terminal === false;
    const exactBrowserSuspensionReplay =
      isBrowserSuspension &&
      Boolean(args.tokenHash) &&
      turn.kind === "agent" &&
      Boolean(turn.threadId) &&
      Number.isSafeInteger(args.attemptGeneration) &&
      args.attemptGeneration === turn.attemptGeneration
        ? await browserSuspensionReplayMatches(ctx, {
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            turnId: args.turnId,
            threadId: turn.threadId!,
            attemptGeneration: args.attemptGeneration!,
            tokenHash: args.tokenHash!,
            payloadJson: args.payloadJson,
          })
        : false;
    if (args.tokenHash) {
      // HTTP token verification is useful for an early 401, but it cannot grant
      // write authority across the following action -> mutation boundary. Read
      // the current token attempt and owner-generation/migration fence in this
      // same transaction as the append. `requireActive` is deliberately false:
      // an exact retry after a terminal event committed but its HTTP response
      // was lost must reach the idempotent terminal check below. A first write
      // still proves that the loaded turn and (for agents) thread are live.
      const exactTerminalReceipt =
        Boolean(turn.terminalKind) && turn.terminalTokenHash === args.tokenHash;
      const exactDurableTerminalAdmission =
        args.terminal &&
        !turn.terminalKind &&
        turn.status === "running" &&
        turn.activeTokenHash === args.tokenHash;
      if (
        exactTerminalReceipt ||
        exactDurableTerminalAdmission ||
        exactBrowserSuspensionReplay
      ) {
        if (exactBrowserSuspensionReplay) {
          await assertOwnerMigrationWriteAllowed(
            ctx,
            args.ownerId,
            args.ownerGeneration,
          );
        } else {
          await assertOwnerDataWriteAllowed(
            ctx,
            args.ownerId,
            args.ownerGeneration,
          );
        }
      } else {
        if (turn.terminalTokenHash) {
          throw new ConvexError("Cloud turn is no longer active.");
        }
        const authority = await resolveCurrentTurnToken(
          ctx,
          {
            tokenHash: args.tokenHash,
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            turnId: args.turnId,
            now: args.now,
          },
          false,
        );
        if (!authority) {
          throw new ConvexError("Cloud turn is no longer active.");
        }
      }
    } else {
      await assertOwnerDataWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    }
    if (isBrowserSuspension) {
      if (
        !args.tokenHash ||
        turn.kind !== "agent" ||
        !turn.threadId ||
        !Number.isSafeInteger(args.attemptGeneration) ||
        args.attemptGeneration !== turn.attemptGeneration
      ) {
        throw new ConvexError("Invalid hosted browser waiting event.");
      }
      if (exactBrowserSuspensionReplay) {
        return { inserted: false, terminalAccepted: false };
      }
      if (turn.status !== "running" || turn.terminalKind) {
        throw new ConvexError("Cloud turn is no longer active.");
      }
      const seq = args.autoSeq
        ? await nextEventSeq(ctx, args.turnId)
        : args.seq;
      if (!args.autoSeq) {
        const duplicate = await ctx.db
          .query("agent_events")
          .withIndex("by_turnId_and_seq", (q) =>
            q.eq("turnId", args.turnId).eq("seq", seq),
          )
          .unique();
        if (duplicate) {
          return { inserted: false, terminalAccepted: false };
        }
      }
      await projectCloudBrowserSuspension(ctx, {
        turn,
        tokenHash: args.tokenHash,
        payloadJson: args.payloadJson,
        connectedAccount: args.connectedAccount === true,
        now: args.now,
      });
      await ctx.db.insert("agent_events", {
        ownerId: turn.ownerId,
        turnId: args.turnId,
        sessionId: turn.sessionId,
        seq,
        kind: args.kind,
        payloadJson: args.payloadJson,
        createdAt: args.now,
      });
      return { inserted: true, terminalAccepted: false };
    }
    if (turn.terminalKind) {
      const storedPayload =
        turn.terminalKind === "completed" ? turn.resultJson : turn.errorMessage;
      if (
        args.terminal &&
        args.kind === turn.terminalKind &&
        storedPayload === args.payloadJson
      ) {
        return { inserted: false, terminalAccepted: false };
      }
      if (args.terminal) {
        throw new ConvexError(
          "Cloud turn is already terminal with a different result.",
        );
      }
      return { inserted: false, terminalAccepted: false };
    }
    if (turn.status !== "running") {
      throw new ConvexError("Cloud turn is no longer active.");
    }
    if (turn.browserResume) {
      await completeCloudBrowserInteractionForResumeTurn(ctx, {
        turn,
        now: args.now,
      });
    }
    if (turn.kind === "agent") {
      if (
        !turn.threadId ||
        !Number.isSafeInteger(args.attemptGeneration) ||
        args.attemptGeneration! < 1 ||
        turn.attemptGeneration !== args.attemptGeneration
      ) {
        throw new ConvexError("Cloud agent attempt is no longer active.");
      }
      const thread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", turn.threadId!))
        .unique();
      if (
        !thread ||
        thread.ownerId !== args.ownerId ||
        thread.ownerGeneration !== args.ownerGeneration ||
        thread.attemptGeneration !== args.attemptGeneration ||
        thread.status !== "running"
      ) {
        throw new ConvexError("Cloud agent attempt is no longer active.");
      }
    }
    const seq = args.autoSeq ? await nextEventSeq(ctx, args.turnId) : args.seq;
    if (!args.autoSeq) {
      const duplicate = await ctx.db
        .query("agent_events")
        .withIndex("by_turnId_and_seq", (q) =>
          q.eq("turnId", args.turnId).eq("seq", seq),
        )
        .unique();
      if (duplicate) {
        return { inserted: false, terminalAccepted: false };
      }
    }
    await ctx.db.insert("agent_events", {
      ownerId: turn.ownerId,
      turnId: args.turnId,
      sessionId: turn.sessionId,
      seq,
      kind: args.kind,
      payloadJson: args.payloadJson,
      createdAt: args.now,
    });
    if (args.terminal) {
      await ctx.db.patch(turn._id, {
        status: ["completed", "failed", "canceled", "timeout"].includes(
          args.kind,
        )
          ? args.kind
          : "failed",
        terminalKind: args.kind,
        resultJson: args.kind === "completed" ? args.payloadJson : undefined,
        errorMessage: args.kind === "completed" ? undefined : args.payloadJson,
        ...(args.tokenHash ? { terminalTokenHash: args.tokenHash } : {}),
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
    return { inserted: true, terminalAccepted: args.terminal };
  },
});

export const recordBuildInternal = internalMutation({
  args: {
    buildId: v.string(),
    appId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    turnId: v.string(),
    artifactPrefix: v.string(),
    previewUrl: v.string(),
    metricsJson: v.string(),
    slug: v.string(),
    title: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const expectedPrefix = `builds/${await hashSha256Hex(args.ownerId)}/${args.buildId}`;
    if (args.artifactPrefix !== expectedPrefix) {
      throw new ConvexError(
        "Build artifact prefix does not match its build id.",
      );
    }
    const callbackTitle = args.title?.trim().slice(0, 32) || undefined;
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (
      !turn ||
      !app ||
      turn.ownerId !== args.ownerId ||
      turn.appId !== args.appId ||
      app.ownerId !== args.ownerId
    ) {
      throw new ConvexError(
        "Build callback does not match its owner, app, and turn.",
      );
    }
    const existing = await ctx.db
      .query("cloud_app_builds")
      .withIndex("by_buildId", (q) => q.eq("buildId", args.buildId))
      .unique();
    if (existing) {
      if (
        existing.ownerId === args.ownerId &&
        existing.appId === args.appId &&
        existing.turnId === args.turnId &&
        existing.artifactPrefix === args.artifactPrefix &&
        existing.previewUrl === args.previewUrl &&
        existing.metricsJson === args.metricsJson &&
        existing.slug === args.slug &&
        existing.callbackTitle === callbackTitle
      ) {
        return null;
      }
      throw new ConvexError(
        "Build id is already bound to different artifacts.",
      );
    }
    const turnBuild = await ctx.db
      .query("cloud_app_builds")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .first();
    if (turnBuild) {
      throw new ConvexError("That turn already recorded a build.");
    }
    if (turn.terminalKind || turn.status !== "running") {
      throw new ConvexError("Build callback arrived after its turn closed.");
    }
    await ctx.db.insert("cloud_app_builds", {
      buildId: args.buildId,
      appId: args.appId,
      ownerId: args.ownerId,
      turnId: args.turnId,
      status: "pending",
      artifactPrefix: args.artifactPrefix,
      previewUrl: args.previewUrl,
      slug: args.slug,
      metricsJson: args.metricsJson,
      callbackTitle,
      createdAt: args.now,
      updatedAt: args.now,
    });
    // Apps carry their real product name (from the finished build), never the
    // prompt text that created them.
    const title = callbackTitle;
    await ctx.db.patch(app._id, {
      ...(title && title !== app.title ? { title } : {}),
      updatedAt: args.now,
    });
    return null;
  },
});

export const setAppTitleInternal = internalMutation({
  args: {
    appId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    title: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (app && app.ownerId === args.ownerId) {
      await ctx.db.patch(app._id, {
        title: args.title.trim().slice(0, 32),
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

export const activateBuildInternal = internalMutation({
  args: {
    appId: v.string(),
    buildId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    const build = await ctx.db
      .query("cloud_app_builds")
      .withIndex("by_buildId", (q) => q.eq("buildId", args.buildId))
      .unique();
    if (
      !app ||
      !build ||
      app.ownerId !== args.ownerId ||
      build.ownerId !== args.ownerId ||
      build.appId !== app.appId
    )
      throw new ConvexError("Build is not available for this app.");
    if (app.activeBuildId) {
      const old = await ctx.db
        .query("cloud_app_builds")
        .withIndex("by_buildId", (q) => q.eq("buildId", app.activeBuildId!))
        .unique();
      if (old)
        await ctx.db.patch(old._id, {
          status: "superseded",
          updatedAt: args.now,
        });
    }
    await ctx.db.patch(build._id, { status: "active", updatedAt: args.now });
    await ctx.db.patch(app._id, {
      activeBuildId: build.buildId,
      status: "active",
      updatedAt: args.now,
    });
    return null;
  },
});

export const suspendAppInternal = internalMutation({
  args: {
    appId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (app && app.ownerId === args.ownerId) {
      await ctx.db.patch(app._id, { status: "suspended", updatedAt: args.now });
    }
    return null;
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

export const probeOpsRateLimitInternal = internalMutation({
  args: { key: v.string() },
  returns: v.object({ allowed: v.boolean() }),
  handler: async (ctx, args) => {
    await enforceMutationRateLimit(
      ctx,
      "cloud_ops_start",
      `ops-probe:${args.key}`,
      { rate: 4, periodMs: 10 * 60_000 },
      "App-operation rate probe was limited as expected.",
    );
    return { allowed: true };
  },
});

// Dev/ops probe: internal-only (run via `bunx convex run`) — as a public
// action this was callable without auth against real owners/builds.
export const startBenchmarkTurn = internalAction({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const builderSecret = process.env.BUILDER_SERVICE_SECRET?.trim();
    if (!builderUrl || !builderSecret) {
      throw new ConvexError("Cloud builder is not configured.");
    }
    const turnId = crypto.randomUUID();
    const sessionId = `m1-${turnId.slice(0, 8)}`;
    const appId = `orbit-${turnId.slice(0, 8)}`;
    const ownerId = "benchmark:cloud-m1";
    const { generation } = await assertOwnerDataAccessActive(ctx, ownerId);
    const quota = await ctx.runQuery(checkQuotaRef, { ownerId });
    if (!quota.allowed)
      throw new ConvexError(quota.reason ?? "Build quota exceeded.");
    await ctx.runMutation(createTurnRef, {
      turnId,
      sessionId,
      ownerId,
      appId,
      prompt: benchmarkPrompt,
      ownerGeneration: generation,
      now: Date.now(),
    });
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const turnToken = Array.from(tokenBytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const response = await fetch(
      `${builderUrl.replace(/\/+$/, "")}/sessions/${sessionId}/turns`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${builderSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ownerId,
          ownerGeneration: generation,
          appId,
          turnId,
          prompt: benchmarkPrompt,
          turnToken,
          convexCallbackBase: process.env.CONVEX_SITE_URL,
        }),
      },
    );
    const body = await response.json();
    if (!response.ok) {
      throw new ConvexError(
        `Builder failed (${response.status}): ${JSON.stringify(body)}`,
      );
    }
    return body;
  },
});

// Dev/ops probe: internal-only (run via `bunx convex run`) — as a public
// action this was callable without auth against real owners/builds.
export const startLifecycleTurn = internalAction({
  args: { appId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const app = await ctx.runQuery(getAppRef, { appId: args.appId });
    if (!app) throw new ConvexError("Lifecycle app was not found.");
    const { generation } = await assertOwnerDataAccessActive(ctx, app.ownerId);
    const quota = await ctx.runQuery(checkQuotaRef, { ownerId: app.ownerId });
    if (!quota.allowed)
      throw new ConvexError(quota.reason ?? "Build quota exceeded.");
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const builderSecret = process.env.BUILDER_SERVICE_SECRET?.trim();
    if (!builderUrl || !builderSecret)
      throw new ConvexError("Cloud builder is not configured.");
    const turnId = crypto.randomUUID();
    const sessionId = `m2-${turnId.slice(0, 8)}`;
    const prompt =
      "Iterate Orbit with a calmer blue palette and add a fifth-minute breathing cue to the focus panel while preserving the habit layout.";
    await ctx.runMutation(createTurnRef, {
      turnId,
      sessionId,
      ownerId: app.ownerId,
      appId: app.appId,
      prompt,
      ownerGeneration: generation,
      now: Date.now(),
    });
    const turnToken =
      crypto.randomUUID().replaceAll("-", "") +
      crypto.randomUUID().replaceAll("-", "");
    const response = await fetch(
      `${builderUrl.replace(/\/+$/, "")}/sessions/${sessionId}/turns`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${builderSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ownerId: app.ownerId,
          ownerGeneration: generation,
          appId: app.appId,
          turnId,
          prompt,
          turnToken,
          convexCallbackBase: process.env.CONVEX_SITE_URL,
        }),
      },
    );
    const body = await response.json();
    if (!response.ok)
      throw new ConvexError(
        `Builder failed (${response.status}): ${JSON.stringify(body)}`,
      );
    return body;
  },
});

// Dev/ops probe: internal-only (run via `bunx convex run`) — as a public
// action this was callable without auth against real owners/builds.
export const applyBuild = internalAction({
  args: { buildId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const build = await ctx.runQuery(getBuildRef, args);
    if (!build?.artifactPrefix)
      throw new ConvexError("Build cannot be applied.");
    const { generation } = await assertOwnerDataAccessActive(
      ctx,
      build.ownerId,
    );
    const slug = build.slug ?? `orbit-${build.appId.slice(-8)}`;
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
    if (!builderUrl || !secret)
      throw new ConvexError("Cloud builder is not configured.");
    const response = await fetch(`${builderUrl}/routes/activate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug,
        appId: build.appId,
        ownerId: build.ownerId,
        ownerGeneration: generation,
        buildId: build.buildId,
        artifactPrefix: build.artifactPrefix,
      }),
    });
    if (!response.ok) throw new ConvexError("Route activation failed.");
    await ctx.runMutation(activateBuildRef, {
      appId: build.appId,
      buildId: build.buildId,
      ownerId: build.ownerId,
      ownerGeneration: generation,
      now: Date.now(),
    });
    return { ok: true, buildId: build.buildId, previewUrl: build.previewUrl };
  },
});

export const applyMyBuild = action({
  args: { buildId: v.string() },
  returns: v.object({ ok: v.boolean(), buildId: v.string() }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const { generation } = await assertOwnerDataAccessActive(ctx, ownerId);
    const build = await ctx.runQuery(getBuildRef, args);
    if (!build?.artifactPrefix || build.ownerId !== ownerId) {
      throw new ConvexError("Build is not available.");
    }
    const app = await ctx.runQuery(getAppRef, { appId: build.appId });
    if (!app || app.ownerId !== ownerId)
      throw new ConvexError("App not found.");
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
    if (!builderUrl || !secret)
      throw new ConvexError("Cloud builder is not configured.");
    const response = await fetch(`${builderUrl}/routes/activate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug: build.slug ?? app.slug,
        appId: build.appId,
        ownerId,
        ownerGeneration: generation,
        buildId: build.buildId,
        artifactPrefix: build.artifactPrefix,
      }),
    });
    if (!response.ok)
      throw new ConvexError("App activation failed. Try again.");
    await ctx.runMutation(activateBuildRef, {
      appId: build.appId,
      buildId: build.buildId,
      ownerId,
      ownerGeneration: generation,
      now: Date.now(),
    });
    return { ok: true, buildId: build.buildId };
  },
});

export const deleteMyApp = action({
  args: { appId: v.string() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const { generation } = await assertOwnerDataAccessActive(ctx, ownerId);
    const app = await ctx.runQuery(getAppRef, args);
    if (!app || app.ownerId !== ownerId)
      throw new ConvexError("App not found.");
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
    if (!builderUrl || !secret)
      throw new ConvexError("Cloud builder is not configured.");
    const response = await fetch(`${builderUrl}/routes/suspend`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug: app.slug,
        appId: app.appId,
        ownerId,
        ownerGeneration: generation,
      }),
    });
    if (!response.ok) throw new ConvexError("App removal failed. Try again.");
    await ctx.runMutation(
      makeFunctionReference<"mutation", any, any>(
        "cloud_apps:suspendAppInternal",
      ),
      {
        appId: app.appId,
        ownerId,
        ownerGeneration: generation,
        now: Date.now(),
      },
    );
    return { ok: true };
  },
});

// Dev/ops probe: internal-only (run via `bunx convex run`) — as a public
// action this was callable without auth against real owners/builds.
export const startLifecycleProbe = internalAction({
  args: {
    turnId: v.string(),
    sessionId: v.string(),
    appId: v.string(),
    preflightDelayMs: v.number(),
    watchdogMs: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const app = await ctx.runQuery(getAppRef, { appId: args.appId });
    if (!app) throw new ConvexError("Lifecycle app was not found.");
    const { generation } = await assertOwnerDataAccessActive(ctx, app.ownerId);
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
    if (!builderUrl || !secret)
      throw new ConvexError("Cloud builder is not configured.");
    const prompt =
      "Lifecycle probe: preserve the app and wait for orchestration.";
    await ctx.runMutation(createTurnRef, {
      turnId: args.turnId,
      sessionId: args.sessionId,
      ownerId: app.ownerId,
      appId: app.appId,
      prompt,
      ownerGeneration: generation,
      now: Date.now(),
    });
    const response = await fetch(
      `${builderUrl}/sessions/${args.sessionId}/turns`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ownerId: app.ownerId,
          ownerGeneration: generation,
          appId: app.appId,
          turnId: args.turnId,
          prompt,
          turnToken: crypto.randomUUID().replaceAll("-", ""),
          convexCallbackBase: process.env.CONVEX_SITE_URL,
          preflightDelayMs: args.preflightDelayMs,
          watchdogMs: args.watchdogMs,
        }),
      },
    );
    const body = await response.json();
    if (!response.ok)
      throw new ConvexError(
        `Lifecycle probe ended (${response.status}): ${JSON.stringify(body)}`,
      );
    return body;
  },
});

// ---------------------------------------------------------------------------
// Operations layer (two-speed agents). See docs/cloud-apps.md.
// The model only picks a verb and JSON arguments; the app's own deterministic
// code applies the change inside its origin-isolated instance.
// ---------------------------------------------------------------------------

type CloudOperationArg = {
  name: string;
  type: "string" | "number" | "boolean";
  description?: string;
  required?: boolean;
};
type CloudOperationDef = {
  name: string;
  description: string;
  args: CloudOperationArg[];
};

const OPS_LIMITS = {
  maxOperations: 20,
  maxArgs: 8,
  maxManifestBytes: 8 * 1024,
  maxArgsBytes: 8 * 1024,
  maxResultBytes: 8 * 1024,
  deliveryWindowMs: 20_000,
};

const OP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OP_ARG_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const OP_ARG_TYPES = new Set(["string", "number", "boolean"]);

const parseOperationsManifest = (manifestJson: string): CloudOperationDef[] => {
  if (
    new TextEncoder().encode(manifestJson).byteLength >
    OPS_LIMITS.maxManifestBytes
  ) {
    throw new ConvexError("Operations manifest exceeds the 8 KB limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    throw new ConvexError("Operations manifest is not valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ConvexError("Operations manifest must be a non-empty array.");
  }
  if (parsed.length > OPS_LIMITS.maxOperations) {
    throw new ConvexError(
      `Apps may register at most ${OPS_LIMITS.maxOperations} operations.`,
    );
  }
  const seen = new Set<string>();
  return parsed.map((entry) => {
    const op = entry as Partial<CloudOperationDef>;
    if (typeof op.name !== "string" || !OP_NAME_PATTERN.test(op.name)) {
      throw new ConvexError(
        "Operation names must be kebab-case, 1–64 characters.",
      );
    }
    if (seen.has(op.name)) {
      throw new ConvexError(`Duplicate operation name: ${op.name}.`);
    }
    seen.add(op.name);
    if (
      typeof op.description !== "string" ||
      op.description.length < 1 ||
      op.description.length > 200
    ) {
      throw new ConvexError(
        `Operation ${op.name} needs a 1–200 character description.`,
      );
    }
    const argDefs = Array.isArray(op.args) ? op.args : [];
    if (argDefs.length > OPS_LIMITS.maxArgs) {
      throw new ConvexError(
        `Operation ${op.name} declares more than ${OPS_LIMITS.maxArgs} arguments.`,
      );
    }
    const argNames = new Set<string>();
    const args = argDefs.map((raw) => {
      const arg = raw as Partial<CloudOperationArg>;
      if (
        typeof arg.name !== "string" ||
        !OP_ARG_NAME_PATTERN.test(arg.name) ||
        argNames.has(arg.name)
      ) {
        throw new ConvexError(
          `Operation ${op.name} has an invalid or duplicate argument name.`,
        );
      }
      argNames.add(arg.name);
      if (typeof arg.type !== "string" || !OP_ARG_TYPES.has(arg.type)) {
        throw new ConvexError(
          `Operation ${op.name} argument ${arg.name} must be string, number, or boolean.`,
        );
      }
      if (
        arg.description !== undefined &&
        (typeof arg.description !== "string" || arg.description.length > 200)
      ) {
        throw new ConvexError(
          `Operation ${op.name} argument ${arg.name} has an invalid description.`,
        );
      }
      return {
        name: arg.name,
        type: arg.type as CloudOperationArg["type"],
        ...(arg.description ? { description: arg.description } : {}),
        ...(arg.required === true ? { required: true } : {}),
      };
    });
    return { name: op.name, description: op.description, args };
  });
};

const validateOperationArgs = (
  def: CloudOperationDef,
  args: Record<string, unknown>,
): void => {
  for (const key of Object.keys(args)) {
    if (!def.args.some((arg) => arg.name === key)) {
      throw new ConvexError(
        `Operation ${def.name} does not accept an argument named ${key}.`,
      );
    }
  }
  for (const arg of def.args) {
    const value = args[arg.name];
    if (value === undefined) {
      if (arg.required) {
        throw new ConvexError(
          `Operation ${def.name} requires the ${arg.name} argument.`,
        );
      }
      continue;
    }
    if (typeof value !== arg.type) {
      throw new ConvexError(
        `Operation ${def.name} argument ${arg.name} must be a ${arg.type}.`,
      );
    }
  }
};

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

const appendTurnEvent = async (
  ctx: MutationCtx,
  turn: {
    _id: any;
    ownerId: string;
    turnId: string;
    sessionId: string;
    terminalKind?: string;
    kind?: string;
    appId?: string;
    conversationId?: string;
  },
  kind: string,
  payload: unknown,
  terminal: boolean,
  now: number,
  ownerGeneration: string,
): Promise<boolean> => {
  if (turn.terminalKind) return false;
  const payloadJson = JSON.stringify(payload ?? {});
  await ctx.db.insert("agent_events", {
    ownerId: turn.ownerId,
    turnId: turn.turnId,
    sessionId: turn.sessionId,
    seq: await nextEventSeq(ctx, turn.turnId),
    kind,
    payloadJson,
    createdAt: now,
  });
  if (terminal) {
    await ctx.db.patch(turn._id, {
      status: ["completed", "failed", "canceled", "timeout"].includes(kind)
        ? kind
        : "failed",
      terminalKind: kind,
      resultJson: kind === "completed" ? payloadJson : undefined,
      errorMessage: kind === "completed" ? undefined : payloadJson,
      updatedAt: now,
    });
    await scheduleTerminalCard(ctx, turn, kind, payloadJson, ownerGeneration);
  }
  return true;
};

const upsertOperationsManifest = async (
  ctx: MutationCtx,
  args: { appId: string; ownerId: string; manifestJson: string; now: number },
): Promise<{ operationCount: number }> => {
  const operations = parseOperationsManifest(args.manifestJson);
  const manifestJson = JSON.stringify(operations);
  const sizeBytes = new TextEncoder().encode(manifestJson).byteLength;
  const existing = await ctx.db
    .query("cloud_app_operations")
    .withIndex("by_appId", (q) => q.eq("appId", args.appId))
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, {
      manifestJson,
      sizeBytes,
      updatedAt: args.now,
    });
  } else {
    await ctx.db.insert("cloud_app_operations", {
      appId: args.appId,
      ownerId: args.ownerId,
      manifestJson,
      sizeBytes,
      updatedAt: args.now,
    });
  }
  return { operationCount: operations.length };
};

const completeOpInvocationRow = async (
  ctx: MutationCtx,
  row: {
    _id: any;
    ownerId: string;
    turnId: string;
    name: string;
    argsJson: string;
    status: string;
  },
  outcome: { ok: boolean; resultJson?: string; errorMessage?: string },
  now: number,
): Promise<void> => {
  const lifecycle = await assertOwnerDataWriteAllowed(ctx, row.ownerId);
  if (row.status !== "pending" && row.status !== "delivered") {
    throw new ConvexError("This operation request is no longer active.");
  }
  if (
    outcome.resultJson &&
    new TextEncoder().encode(outcome.resultJson).byteLength >
      OPS_LIMITS.maxResultBytes
  ) {
    throw new ConvexError("Operation result exceeds the 8 KB limit.");
  }
  await ctx.db.patch(row._id, {
    status: outcome.ok ? "completed" : "failed",
    resultJson: outcome.resultJson,
    errorMessage: outcome.errorMessage,
    updatedAt: now,
  });
  const turn = await ctx.db
    .query("agent_turns")
    .withIndex("by_turnId", (q) => q.eq("turnId", row.turnId))
    .unique();
  if (!turn) return;
  const payload = outcome.ok
    ? {
        operation: row.name,
        args: JSON.parse(row.argsJson),
        result: outcome.resultJson ? JSON.parse(outcome.resultJson) : null,
      }
    : {
        operation: row.name,
        args: JSON.parse(row.argsJson),
        message:
          outcome.errorMessage ?? "The app could not apply this operation.",
      };
  await appendTurnEvent(
    ctx,
    turn,
    outcome.ok ? "completed" : "failed",
    payload,
    true,
    now,
    lifecycle.generation,
  );
};

export const getOperationsManifestInternal = internalQuery({
  args: { appId: v.string() },
  returns: v.any(),
  handler: (ctx, args) =>
    ctx.db
      .query("cloud_app_operations")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique(),
});

export const upsertOperationsManifestInternal = internalMutation({
  args: {
    appId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    userId: v.string(),
    manifestJson: v.string(),
    now: v.number(),
  },
  returns: v.object({ operationCount: v.number() }),
  handler: async (ctx, args) => {
    await assertCurrentAppSdkOwner(
      ctx,
      args.appId,
      args.ownerId,
      args.ownerGeneration,
    );
    if (args.userId !== args.ownerId) {
      throw new ConvexError(
        "Only the app owner's session can register operations.",
      );
    }
    return await upsertOperationsManifest(ctx, {
      appId: args.appId,
      ownerId: args.ownerId,
      manifestJson: args.manifestJson,
      now: args.now,
    });
  },
});

export const publishMyAppOperations = mutation({
  args: { appId: v.string(), manifestJson: v.string() },
  returns: v.object({ operationCount: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    await assertOwnerDataWriteAllowed(ctx, ownerId);
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (!app || app.ownerId !== ownerId)
      throw new ConvexError("App not found.");
    return await upsertOperationsManifest(ctx, {
      appId: app.appId,
      ownerId,
      manifestJson: args.manifestJson,
      now: Date.now(),
    });
  },
});

export const createOpInvocationInternal = internalMutation({
  args: {
    invocationId: v.string(),
    appId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    turnId: v.string(),
    name: v.string(),
    argsJson: v.string(),
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean(), message: v.optional(v.string()) }),
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
      turn.appId !== args.appId ||
      turn.terminalKind
    ) {
      return { ok: false, message: "Turn is no longer active." };
    }
    const fail = async (message: string) => {
      await appendTurnEvent(
        ctx,
        turn,
        "failed",
        { message },
        true,
        args.now,
        args.ownerGeneration,
      );
      return { ok: false, message };
    };
    if (
      new TextEncoder().encode(args.argsJson).byteLength >
      OPS_LIMITS.maxArgsBytes
    ) {
      return await fail("Operation arguments exceed the 8 KB limit.");
    }
    const manifestRow = await ctx.db
      .query("cloud_app_operations")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    const operations = manifestRow
      ? (JSON.parse(manifestRow.manifestJson) as CloudOperationDef[])
      : [];
    const def = operations.find((op) => op.name === args.name);
    if (!def) {
      return await fail(
        "The app can't do that directly — ask Stella to change the app instead.",
      );
    }
    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(args.argsJson) as Record<string, unknown>;
      if (parsedArgs === null || typeof parsedArgs !== "object") {
        throw new Error("not an object");
      }
    } catch {
      return await fail("Operation arguments must be a JSON object.");
    }
    try {
      validateOperationArgs(def, parsedArgs);
    } catch (error) {
      return await fail(
        error instanceof ConvexError
          ? String(error.data)
          : "Operation arguments did not match the app's declaration.",
      );
    }
    await ctx.db.insert("cloud_app_op_invocations", {
      invocationId: args.invocationId,
      appId: args.appId,
      ownerId: args.ownerId,
      turnId: args.turnId,
      name: args.name,
      argsJson: args.argsJson,
      status: "pending",
      expiresAt: args.now + OPS_LIMITS.deliveryWindowMs,
      createdAt: args.now,
      updatedAt: args.now,
    });
    await ctx.db.patch(turn._id, { lane: "operation", updatedAt: args.now });
    await appendTurnEvent(
      ctx,
      turn,
      "op_selected",
      { operation: args.name, args: parsedArgs },
      false,
      args.now,
      args.ownerGeneration,
    );
    return { ok: true };
  },
});

export const reserveBuildLaneInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    turnId: v.string(),
  },
  returns: v.object({ ok: v.boolean() }),
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
    if (!turn || turn.ownerId !== args.ownerId || turn.terminalKind) {
      return { ok: false };
    }
    const now = Date.now();
    const { plan, quota } = await resolveCloudPlan(ctx, args.ownerId);
    const buildTurns = (
      await listRecentBuildTurns(ctx, args.ownerId, quota.dailyTurns + 2)
    ).filter((candidate) => candidate.turnId !== args.turnId);
    const running = buildTurns.filter(
      (candidate) => candidate.status === "running",
    );
    const fail = async (message: string) => {
      await appendTurnEvent(
        ctx,
        turn,
        "failed",
        { message },
        true,
        now,
        args.ownerGeneration,
      );
      return { ok: false };
    };
    if (running.length >= quota.concurrentTurns) {
      return await fail(
        "Stella is still working on an earlier change. Wait for it to finish, then try again.",
      );
    }
    if (buildTurns.length >= quota.dailyTurns) {
      return await fail(
        `You've used all ${quota.dailyTurns} app updates included with the ${
          plan === "free" ? "Free" : plan
        } plan today. Try again tomorrow.`,
      );
    }
    await ctx.db.patch(turn._id, { lane: "build", updatedAt: now });
    return { ok: true };
  },
});

/** Exact owner, migration, generation, and turn-state gate for route-model I/O. */
export const assertCloudRouteDispatchAllowedInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    turnId: v.string(),
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
      turn.status !== "running" ||
      turn.terminalKind
    ) {
      throw new ConvexError("Cloud app route turn is no longer active.");
    }
    return null;
  },
});

export const expireOpInvocationInternal = internalMutation({
  args: { invocationId: v.string(), ownerGeneration: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cloud_app_op_invocations")
      .withIndex("by_invocationId", (q) =>
        q.eq("invocationId", args.invocationId),
      )
      .unique();
    if (!row || (row.status !== "pending" && row.status !== "delivered")) {
      return null;
    }
    await assertOwnerMigrationWriteAllowed(
      ctx,
      row.ownerId,
      args.ownerGeneration,
    );
    const now = Date.now();
    await ctx.db.patch(row._id, { status: "expired", updatedAt: now });
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", row.turnId))
      .unique();
    if (turn) {
      await appendTurnEvent(
        ctx,
        turn,
        "failed",
        {
          operation: row.name,
          message:
            "The app was not open to receive this action. Open the app in Stella, then ask again.",
        },
        true,
        now,
        args.ownerGeneration,
      );
    }
    return null;
  },
});

export const listPendingOpInvocations = query({
  args: { appId: v.string() },
  returns: v.array(
    v.object({
      invocationId: v.string(),
      name: v.string(),
      argsJson: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    await assertOwnerDataWriteAllowed(ctx, ownerId);
    const rows = await ctx.db
      .query("cloud_app_op_invocations")
      .withIndex("by_ownerId_and_appId_and_status_and_createdAt", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("appId", args.appId)
          .eq("status", "pending"),
      )
      .order("desc")
      .take(10);
    return rows.map((row) => ({
      invocationId: row.invocationId,
      name: row.name,
      argsJson: row.argsJson,
      createdAt: row.createdAt,
    }));
  },
});

export const claimOpInvocation = mutation({
  args: { invocationId: v.string() },
  returns: v.object({ claimed: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    await assertOwnerDataWriteAllowed(ctx, ownerId);
    const row = await ctx.db
      .query("cloud_app_op_invocations")
      .withIndex("by_invocationId", (q) =>
        q.eq("invocationId", args.invocationId),
      )
      .unique();
    if (!row || row.ownerId !== ownerId || row.status !== "pending") {
      return { claimed: false };
    }
    await ctx.db.patch(row._id, { status: "delivered", updatedAt: Date.now() });
    return { claimed: true };
  },
});

export const completeOpInvocation = mutation({
  args: {
    invocationId: v.string(),
    ok: v.boolean(),
    resultJson: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    await assertOwnerDataWriteAllowed(ctx, ownerId);
    const row = await ctx.db
      .query("cloud_app_op_invocations")
      .withIndex("by_invocationId", (q) =>
        q.eq("invocationId", args.invocationId),
      )
      .unique();
    if (!row || row.ownerId !== ownerId) {
      throw new ConvexError("Operation request not found.");
    }
    await completeOpInvocationRow(
      ctx,
      row,
      {
        ok: args.ok,
        resultJson: args.resultJson,
        errorMessage: args.errorMessage,
      },
      Date.now(),
    );
    return null;
  },
});

export const claimOpInvocationsInternal = internalMutation({
  args: {
    appId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    userId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await assertCurrentAppSdkOwner(
      ctx,
      args.appId,
      args.ownerId,
      args.ownerGeneration,
    );
    if (args.userId !== args.ownerId) {
      throw new ConvexError(
        "Only the app owner can receive operation requests.",
      );
    }
    const rows = await ctx.db
      .query("cloud_app_op_invocations")
      .withIndex("by_appId_and_status_and_createdAt", (q) =>
        q.eq("appId", args.appId).eq("status", "pending"),
      )
      .take(5);
    const claimed = [];
    const now = Date.now();
    for (const row of rows) {
      if (row.ownerId !== args.ownerId) continue;
      await ctx.db.patch(row._id, { status: "delivered", updatedAt: now });
      claimed.push({
        invocationId: row.invocationId,
        name: row.name,
        argsJson: row.argsJson,
      });
    }
    return claimed;
  },
});

export const completeOpInvocationInternal = internalMutation({
  args: {
    appId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    invocationId: v.string(),
    userId: v.string(),
    ok: v.boolean(),
    resultJson: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertCurrentAppSdkOwner(
      ctx,
      args.appId,
      args.ownerId,
      args.ownerGeneration,
    );
    if (args.userId !== args.ownerId) {
      throw new ConvexError("Only the app owner can report results.");
    }
    const row = await ctx.db
      .query("cloud_app_op_invocations")
      .withIndex("by_invocationId", (q) =>
        q.eq("invocationId", args.invocationId),
      )
      .unique();
    if (!row || row.appId !== args.appId || row.ownerId !== args.ownerId) {
      throw new ConvexError("Operation request not found.");
    }
    await completeOpInvocationRow(
      ctx,
      row,
      {
        ok: args.ok,
        resultJson: args.resultJson,
        errorMessage: args.errorMessage,
      },
      Date.now(),
    );
    return null;
  },
});

export const routeCloudTurnInternal = internalAction({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.string(),
    appId: v.string(),
    turnId: v.string(),
    sessionId: v.string(),
    prompt: v.string(),
    turnToken: v.string(),
    execution: v.optional(cloudExecutionSelectionValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertExpectedOwnerGenerationActive(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const failTurn = (message: string) =>
      ctx.runMutation(failCloudTurnRef, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        turnId: args.turnId,
        message,
        now: Date.now(),
      });
    const dispatchBuild = async () => {
      const reserved = (await ctx.runMutation(reserveBuildLaneRef, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        turnId: args.turnId,
      })) as { ok: boolean };
      if (!reserved.ok) return;
      await ctx.runAction(runCloudTurnRef, {
        ownerId: args.ownerId,
        conversationId: args.conversationId,
        appId: args.appId,
        turnId: args.turnId,
        sessionId: args.sessionId,
        prompt: args.prompt,
        turnToken: args.turnToken,
        ownerGeneration: args.ownerGeneration,
        ...(args.execution ? { execution: args.execution } : {}),
      });
    };

    const manifestRow = await ctx.runQuery(getOpsManifestRef, {
      appId: args.appId,
    });
    if (!manifestRow || manifestRow.ownerId !== args.ownerId) {
      await dispatchBuild();
      return null;
    }
    const app = await ctx.runQuery(getAppRef, { appId: args.appId });
    if (!app || app.ownerId !== args.ownerId) {
      await failTurn("Stella couldn't find that app. Try again.");
      return null;
    }
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      await failTurn("Stella couldn't start on this. Try again in a moment.");
      return null;
    }
    type RouteDecision = {
      decision?: string;
      name?: string;
      args?: Record<string, unknown>;
    };
    const dispatchGuard = createManagedUsageDispatchGuard(ctx, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      executionId: `cloud-app-route:${args.turnId}`,
      spanExecution: true,
      beforeDispatch: async () => {
        await ctx.runMutation(assertCloudRouteDispatchRef, {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          turnId: args.turnId,
        });
      },
    });
    let executionOutcome: "succeeded" | "failed" = "failed";
    try {
      let decision: RouteDecision | undefined;
      try {
        decision = await runManagedDispatchAttempt({
          dispatchGuard,
          run: async (signal) => {
            const upstream = await fetch(
              "https://api.anthropic.com/v1/messages",
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-api-key": apiKey,
                  "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify({
                  model: "claude-haiku-4-5-20251001",
                  max_tokens: 300,
                  system: [
                    "You are Stella's cloud app agent. The user already runs the app",
                    ` "${app?.title ?? "app"}" and is asking for something in chat.`,
                    " Prefer operating the running app over rebuilding it: if the",
                    " request can be satisfied by one of the app's operations, return",
                    ' {"decision":"operation","name":"<operation-name>","args":{...}}',
                    " with arguments matching the declared names and types exactly.",
                    ' Return {"decision":"build"} only for structural, visual, or code',
                    " changes (new features, layout, styling, copy baked into the UI)",
                    " or when no operation fits the request. The app's operations:",
                    ` ${manifestRow.manifestJson}`,
                    " Respond with only the JSON object, no markdown.",
                  ].join(""),
                  messages: [{ role: "user", content: args.prompt }],
                }),
                signal,
              },
            );
            const payload = (await upstream.json()) as {
              content?: Array<{ type?: string; text?: string }>;
              error?: { message?: string };
            };
            if (!upstream.ok) {
              throw new Error(
                payload.error?.message ?? "Routing model failed.",
              );
            }
            const text =
              payload.content?.find((item) => item.type === "text")?.text ?? "";
            return JSON.parse(
              text.replace(/^```json\s*|\s*```$/g, ""),
            ) as RouteDecision;
          },
        });
      } catch {
        await failTurn("Stella couldn't finish this request. Try again.");
        return null;
      }
      if (!decision) {
        await failTurn("Stella couldn't finish this request. Try again.");
        return null;
      }
      if (decision.decision !== "operation" || !decision.name) {
        await dispatchBuild();
        executionOutcome = "succeeded";
        return null;
      }
      const invocationId = crypto.randomUUID();
      const created = (await ctx.runMutation(createOpInvocationRef, {
        invocationId,
        appId: args.appId,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        turnId: args.turnId,
        name: decision.name,
        argsJson: JSON.stringify(decision.args ?? {}),
        now: Date.now(),
      })) as { ok: boolean };
      if (created.ok) {
        await ctx.scheduler.runAfter(
          OPS_LIMITS.deliveryWindowMs + 1_000,
          expireOpInvocationRef,
          { invocationId, ownerGeneration: args.ownerGeneration },
        );
      }
      executionOutcome = "succeeded";
      return null;
    } finally {
      // The physical provider lease covers the complete JSON body. The
      // enclosing lease remains live until the chosen route-state write commits.
      await dispatchGuard.finishExecution?.(executionOutcome);
    }
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
