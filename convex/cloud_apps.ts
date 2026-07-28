import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import {
  enforceActionRateLimit,
  enforceMutationRateLimit,
} from "./lib/rate_limits";
import type { SubscriptionPlan } from "./lib/billing_plans";

type CloudPlanQuota = {
  dailyTurns: number;
  concurrentTurns: number;
  burstStarts: number;
};

const CLOUD_PLAN_QUOTAS: Record<SubscriptionPlan, CloudPlanQuota> = {
  free: { dailyTurns: 3, concurrentTurns: 1, burstStarts: 4 },
  go: { dailyTurns: 10, concurrentTurns: 1, burstStarts: 6 },
  pro: { dailyTurns: 25, concurrentTurns: 2, burstStarts: 10 },
  plus: { dailyTurns: 50, concurrentTurns: 3, burstStarts: 16 },
  ultra: { dailyTurns: 100, concurrentTurns: 4, burstStarts: 24 },
  max: { dailyTurns: 200, concurrentTurns: 6, burstStarts: 40 },
};

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

const resolveCloudPlan = async (
  ctx: Pick<MutationCtx, "db"> | Pick<QueryCtx, "db">,
  ownerId: string,
): Promise<{ plan: SubscriptionPlan; quota: CloudPlanQuota }> => {
  const profile = await ctx.db
    .query("billing_profiles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
  const plan: SubscriptionPlan =
    profile?.usageMode === "unlimited"
      ? "max"
      : profile &&
          ACTIVE_SUBSCRIPTION_STATUSES.has(profile.subscriptionStatus) &&
          profile.activePlan !== "free"
        ? profile.activePlan
        : "free";
  return { plan, quota: CLOUD_PLAN_QUOTAS[plan] };
};

const benchmarkPrompt =
  "Build a polished responsive habit tracker named Orbit. It needs a warm editorial visual style, a daily progress ring, four useful habit cards, and an encouraging focus panel. Make it feel like a real product, not a generic dashboard.";

const createTurnRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:createTurnInternal",
);
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
const runOrchestratorTurnRef = makeFunctionReference<"action", any, any>(
  "cloud_apps:runOrchestratorTurnInternal",
);
const runCloudAgentTurnRef = makeFunctionReference<"action", any, any>(
  "cloud_apps:runCloudAgentTurnInternal",
);
const storeTurnTokenRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:storeTurnTokenInternal",
);
const completeAgentThreadRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:completeAgentThreadInternal",
);
const getEngineSettingsRef = makeFunctionReference<
  "query",
  { ownerId: string },
  { chatEngine: string; connectedProviders: string[] }
>("cloud_engines:getEngineSettingsInternal");

// Engine-native default when a cloud turn runs on the owner's Claude
// subscription (mirrors DEFAULT_CLOUD_ANTHROPIC_ENGINE_MODEL in
// packages/executor-cloud/src/relay-model.ts).
const CLOUD_ANTHROPIC_ENGINE_DEFAULT_MODEL = "claude-sonnet-4.6";

type CloudEngineSelection = { provider: "anthropic"; model: string };

// Resolve which engine a cloud turn runs on: the owner's setting, honored
// only while the matching credential is still connected.
const resolveOwnerEngine = async (
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  ownerId: string,
): Promise<CloudEngineSelection | undefined> => {
  const settings = (await ctx.runQuery(getEngineSettingsRef, { ownerId })) as {
    chatEngine: string;
    connectedProviders: string[];
  };
  if (
    settings.chatEngine === "anthropic" &&
    settings.connectedProviders.includes("anthropic")
  ) {
    return {
      provider: "anthropic",
      model: CLOUD_ANTHROPIC_ENGINE_DEFAULT_MODEL,
    };
  }
  return undefined;
};

/**
 * Parse spawn_agent's cloud `model` override: "claude" | "claude/<model>".
 * Returns undefined for absent/default; throws readable errors otherwise.
 */
const parseSpawnEngineModel = (
  value: string | undefined,
): CloudEngineSelection | undefined => {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "default") return undefined;
  if (trimmed === "claude") {
    return {
      provider: "anthropic",
      model: CLOUD_ANTHROPIC_ENGINE_DEFAULT_MODEL,
    };
  }
  const pinned = /^claude\/([A-Za-z0-9._-]{1,64})$/.exec(trimmed);
  if (pinned) {
    return { provider: "anthropic", model: pinned[1]! };
  }
  throw new ConvexError(
    'Only "claude" or "claude/<model>" engines are available for cloud spawns right now.',
  );
};

const TURN_TOKEN_TTL_MS = 30 * 60_000;

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
    role: string;
    payloadJson: string;
    now: number;
  },
): Promise<number> => {
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
    now: number;
  },
): Promise<{ conversationId: string; title: string; createdAt: number }> => {
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
    await ctx.db.patch(conversation._id, { updatedAt: args.now });
    return {
      conversationId: requestedConversationId,
      title: conversation.title,
      createdAt: conversation.createdAt,
    };
  }
  const conversationId = crypto.randomUUID();
  const title =
    args.title.length > CHAT_TITLE_MAX
      ? `${args.title.slice(0, CHAT_TITLE_MAX - 3)}…`
      : args.title;
  await ctx.db.insert("cloud_conversations", {
    conversationId,
    ownerId: args.ownerId,
    title,
    createdAt: args.now,
    updatedAt: args.now,
  });
  return { conversationId, title, createdAt: args.now };
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

// Drive-relative POSIX paths, same shape the drive index stores. Junk is
// dropped rather than rejected — an attachment is a hint, never a reason to
// fail the send. The attachment route re-validates against the actual rows.
const normalizeChatAttachments = (paths: readonly string[]): string[] =>
  paths
    .filter(
      (path): path is string =>
        typeof path === "string" &&
        path.length > 0 &&
        path.length <= 512 &&
        !path.startsWith("/") &&
        !path.split("/").includes(".."),
    )
    .slice(0, 4);

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
    now: number;
  },
): Promise<{ conversationId: string; turnId: string }> => {
  const conversation = await resolveConversationId(ctx, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
    title: args.title ?? args.prompt,
    now: args.now,
  });
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
  });
  return { conversationId, turnId };
};

// Client-minted, so it is validated like any other client string before it is
// used as a dedupe key.
const CLIENT_MSG_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;

const normalizeClientMsgId = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!CLIENT_MSG_ID_PATTERN.test(trimmed)) {
    throw new ConvexError("That message could not be sent. Try again.");
  }
  return trimmed;
};

/**
 * A retried send must not become a second turn. The composer mints one id per
 * message and replays it on retry; if a turn already carries it, that turn is
 * the answer — before any quota is charged, because the first attempt already
 * paid.
 */
const findTurnByClientMsgId = async (
  ctx: MutationCtx,
  ownerId: string,
  clientMsgId: string,
): Promise<{ conversationId: string; turnId: string } | null> => {
  const existing = await ctx.db
    .query("agent_turns")
    .withIndex("by_clientMsgId", (q) => q.eq("clientMsgId", clientMsgId))
    .take(4);
  for (const turn of existing) {
    if (turn.ownerId !== ownerId || !turn.conversationId) continue;
    return { conversationId: turn.conversationId, turnId: turn.turnId };
  }
  return null;
};

const MAX_DISPATCHED_PROMPT_CHARS = 8_000;

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
    now: v.number(),
  },
  returns: v.object({ conversationId: v.string(), turnId: v.string() }),
  handler: async (ctx, args) => {
    const prompt = args.prompt.trim();
    if (!prompt || prompt.length > MAX_DISPATCHED_PROMPT_CHARS) {
      throw new ConvexError(
        `A cloud chat turn needs 1–${MAX_DISPATCHED_PROMPT_CHARS} characters.`,
      );
    }
    const clientMsgId = normalizeClientMsgId(args.clientMsgId);
    if (clientMsgId) {
      const replayed = await findTurnByClientMsgId(ctx, args.ownerId, clientMsgId);
      if (replayed) return replayed;
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
      hiddenMessage: args.hiddenMessage ?? args.hidden === true,
      hiddenTurn: args.hiddenTurn ?? args.hidden === true,
      ...(clientMsgId ? { clientMsgId } : {}),
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
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
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
  returns: v.any(),
  handler: (ctx, args) =>
    ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique(),
});

export const getBuildInternal = internalQuery({
  args: { buildId: v.string() },
  returns: v.any(),
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

const requireOwnerId = async (ctx: {
  auth: { getUserIdentity: () => Promise<{ tokenIdentifier: string } | null> };
}): Promise<string> => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Sign in to build apps with Stella.");
  return identity.tokenIdentifier;
};

export const listMyConversations = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    // Over-read by the tombstone allowance rather than filtering after the
    // take: a purge in flight must not silently shorten the sidebar.
    const rows = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(50);
    return rows
      .filter((row) => row.deletedAt === undefined)
      .slice(0, 25);
  },
});

export const listMyApps = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    return await ctx.db
      .query("cloud_apps")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(50);
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
  returns: v.any(),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (!app || app.ownerId !== ownerId)
      throw new ConvexError("App not found.");
    return await ctx.db
      .query("cloud_app_builds")
      .withIndex("by_appId_and_createdAt", (q) => q.eq("appId", args.appId))
      .order("desc")
      .take(5);
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

export const startCloudChat = mutation({
  args: {
    prompt: v.string(),
    conversationId: v.optional(v.string()),
    appId: v.optional(v.string()),
    /** Per-message id from the composer; makes a retried send idempotent. */
    clientMsgId: v.optional(v.string()),
    /** Client UI locale for the reply-language directive (e.g. "es"). */
    locale: v.optional(v.string()),
    /** Drive paths of attached images the turn should see as image blocks. */
    attachments: v.optional(v.array(v.string())),
  },
  returns: v.object({
    conversationId: v.string(),
    appId: v.optional(v.string()),
    turnId: v.string(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const prompt = args.prompt.trim();
    if (!prompt || prompt.length > 4_000) {
      throw new ConvexError("Describe the app in 1–4,000 characters.");
    }
    // Ahead of every quota and rate check: a replay is not a new request, and
    // charging it would punish the user for a dropped response.
    const clientMsgId = normalizeClientMsgId(args.clientMsgId);
    if (clientMsgId) {
      const replayed = await findTurnByClientMsgId(ctx, ownerId, clientMsgId);
      if (replayed) return replayed;
    }
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

    const now = Date.now();
    if (chatLane) {
      return await startChatTurn(ctx, {
        ownerId,
        conversationId: args.conversationId,
        prompt,
        ...(clientMsgId ? { clientMsgId } : {}),
        ...(args.locale ? { locale: args.locale } : {}),
        ...(args.attachments?.length
          ? { attachments: normalizeChatAttachments(args.attachments) }
          : {}),
        now,
      });
    }

    const { conversationId } = await resolveConversationId(ctx, {
      ownerId,
      conversationId: args.conversationId,
      title: prompt,
      now,
    });
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
        // Apps go live the moment their build finishes — new or updated.
        // There is nothing to approve: the artifact is built and hosted, so
        // a pending state would only hide working software behind a click.
        // (Stella's own interior is the exception; see the apply card.)
        autoActivate: true,
      },
    );
    return { conversationId, appId, turnId };
  },
});

export const failCloudTurnInternal = internalMutation({
  args: { turnId: v.string(), message: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    if (!turn || turn.terminalKind) return null;
    const seq = await nextEventSeq(ctx, args.turnId);
    const payloadJson = JSON.stringify({ message: args.message });
    await ctx.db.insert("agent_events", {
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
    autoActivate: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const builderSecret = process.env.BUILDER_SERVICE_SECRET?.trim();
    let failure = "Stella couldn't start on this. Try again in a moment.";
    try {
      if (!builderUrl || !builderSecret) throw new Error(failure);
      const response = await fetch(
        `${builderUrl.replace(/\/+$/, "")}/sessions/${args.sessionId}/turns`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${builderSecret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ownerId: args.ownerId,
            appId: args.appId,
            turnId: args.turnId,
            prompt: args.prompt,
            turnToken: args.turnToken,
            convexCallbackBase: process.env.CONVEX_SITE_URL,
            autoActivate: args.autoActivate,
          }),
        },
      );
      if (response.ok) return null;
      failure = "Stella hit a snag starting this change. Try again.";
    } catch (error) {
      // The raw error (fetch stack, provider blob) goes to logs; the turn
      // keeps the readable message the UI renders verbatim.
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "build_dispatch_failed",
          turnId: args.turnId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    await ctx.runMutation(
      makeFunctionReference<"mutation", any, any>(
        "cloud_apps:failCloudTurnInternal",
      ),
      { turnId: args.turnId, message: failure, now: Date.now() },
    );
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
    turnId: v.string(),
    agentType: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("cloud_turn_tokens", {
      tokenHash: args.tokenHash,
      ownerId: args.ownerId,
      turnId: args.turnId,
      agentType: args.agentType,
      createdAt: args.now,
      expiresAt: args.now + TURN_TOKEN_TTL_MS,
    });
    return null;
  },
});

export const getTurnTokenByHashInternal = internalQuery({
  args: { tokenHash: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cloud_turn_tokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!row || row.expiresAt <= Date.now()) return null;
    return row;
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
    threadId: v.string(),
    excludeTurnId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (!thread) throw new ConvexError("Unknown agent thread.");
    // Newest 400 rows, returned oldest-first. The executor prunes this to a
    // context-window token budget (packages/executor-cloud/prune-history).
    const rows = await ctx.db
      .query("cloud_thread_messages")
      .withIndex("by_conversationId_and_seq", (q) =>
        q.eq("conversationId", args.threadId),
      )
      .order("desc")
      .take(400);
    return rows
      .reverse()
      .filter((row) => row.turnId !== args.excludeTurnId)
      .map((row) => ({
        seq: row.seq,
        role: row.role,
        payloadJson: row.payloadJson,
        turnId: row.turnId,
      }));
  },
});

export const appendThreadMessagesInternal = internalMutation({
  args: {
    threadId: v.string(),
    turnId: v.string(),
    messages: v.array(
      v.object({
        role: v.string(),
        payloadJson: v.string(),
      }),
    ),
    now: v.number(),
  },
  returns: v.object({ lastSeq: v.number() }),
  handler: async (ctx, args) => {
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    if (!turn) throw new ConvexError("Unknown cloud turn.");
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
    let lastSeq = -1;
    for (const message of args.messages) {
      lastSeq = await appendThreadMessage(ctx, {
        threadId: args.threadId,
        ownerId: turn.ownerId,
        turnId: args.turnId,
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
    if (
      args.force !== true &&
      (args.epoch < currentEpoch ||
        (args.epoch === currentEpoch && args.lastSeq <= currentSeq))
    ) {
      // The ordered fields stay where they are; the excerpts still land.
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
    return {
      ownerId: row.ownerId,
      createdAt: row.createdAt,
      title: row.title,
    };
  },
});

/**
 * Cards are journal rows, so they survive scrollback — an "Open app" card used
 * to exist only while its event row was inside the tail's take(100). Convex
 * writes them because Convex is where the build, operation, and thread
 * outcomes land; the DO orders them.
 *
 * Best-effort by design: a card is a receipt for work that already happened.
 * Losing one must never fail a turn, so this action logs and returns.
 */
export const postConversationCardInternal = internalAction({
  args: {
    conversationId: v.string(),
    sourceTurnId: v.string(),
    card: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const builder = builderEndpoint();
    if (!builder) return null;
    try {
      // 429 means the DO is mid-reply and its inbox is full. The writer key is
      // `card:<sourceTurnId>:<type>`, so re-posting is exactly-once — retry a
      // couple of times rather than silently dropping a receipt the user is
      // waiting to see ("Open app" is the whole payoff of a build).
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
              sourceTurnId: args.sourceTurnId,
              card: args.card,
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (response.status !== 429 && response.status < 500) break;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
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
    kind?: string;
    appId?: string;
    conversationId?: string;
    turnId: string;
  },
  kind: string,
  payloadJson: string,
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
    { conversationId: turn.conversationId, sourceTurnId: turn.turnId, card },
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
    if (!response.ok) return { error: `journal ${response.status}`, body: text };
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

export const tombstoneConversationInternal = internalMutation({
  args: {
    conversationId: v.string(),
    /** Omitted by the sweeps, which already know the row. */
    ownerId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean(), ownerId: v.string() }),
  handler: async (ctx, args) => {
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
  args: { conversationId: v.string() },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const excerpts = await ctx.db
      .query("cloud_message_excerpts")
      .withIndex("by_conversationId_and_seqStart", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .take(PURGE_BATCH);
    for (const row of excerpts) await ctx.db.delete(row._id);
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
  args: { conversationId: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .unique();
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
  args: { conversationId: v.string(), ownerId: v.optional(v.string()) },
  returns: v.object({ purged: v.boolean() }),
  handler: async (ctx, args): Promise<{ purged: boolean }> => {
    await ctx.runMutation(internal.cloud_apps.tombstoneConversationInternal, {
      conversationId: args.conversationId,
      ...(args.ownerId ? { ownerId: args.ownerId } : {}),
      now: Date.now(),
    });
    let hasMore = true;
    while (hasMore) {
      const result: { hasMore: boolean } = await ctx.runMutation(
        internal.cloud_apps.purgeConversationRowsInternal,
        { conversationId: args.conversationId },
      );
      hasMore = result.hasMore;
    }
    const builder = builderEndpoint();
    if (builder) {
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
    await ctx.runMutation(
      internal.cloud_apps.finishConversationPurgeInternal,
      { conversationId: args.conversationId, now: Date.now() },
    );
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
        q.eq("purgedAt", undefined).gte("deletedAt", 1).lte("deletedAt", args.before),
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
      .withIndex("by_lastSeq_and_createdAt", (q) =>
        q.eq("lastSeq", undefined).lt("createdAt", cutoff),
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const builderSecret = process.env.BUILDER_SERVICE_SECRET?.trim();
    let failure = "Stella couldn't start on this. Try again in a moment.";
    try {
      if (!builderUrl || !builderSecret) throw new Error(failure);
      // The hash must exist before the DO can present the raw token to the
      // relay or the callback routes, so store it before dispatching.
      await ctx.runMutation(storeTurnTokenRef, {
        tokenHash: await hashToken(args.turnToken),
        ownerId: args.ownerId,
        turnId: args.turnId,
        agentType: "orchestrator",
        now: Date.now(),
      });
      // Engine is resolved here (one place covers user and wake turns): the
      // DO gets only a provider flag, never a credential.
      const engine = await resolveOwnerEngine(ctx, args.ownerId);
      const response = await fetch(
        `${builderUrl.replace(/\/+$/, "")}/conversations/${args.conversationId}/turns`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${builderSecret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "chat",
            ownerId: args.ownerId,
            conversationId: args.conversationId,
            turnId: args.turnId,
            sessionId: args.sessionId,
            prompt: args.prompt,
            turnToken: args.turnToken,
            convexCallbackBase: process.env.CONVEX_SITE_URL,
            ...(engine ? { engine } : {}),
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
          }),
        },
      );
      if (response.ok) return null;
      failure = "Stella hit a snag starting this chat. Try again.";
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "chat_dispatch_failed",
          turnId: args.turnId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    await ctx.runMutation(failCloudTurnRef, {
      turnId: args.turnId,
      message: failure,
      now: Date.now(),
    });
    return null;
  },
});

// Contract C2. "computer" is a real workspace on the desktop but is never
// dispatchable from the cloud, so it is deliberately absent here.
const CLOUD_WORKSPACE_PATTERN =
  /^(drive|stella|project:[A-Za-z0-9._-]{1,64}|app:[a-z0-9-]{1,64})$/;

const getProjectBySlugRef = makeFunctionReference<
  "query",
  { ownerId: string; slug: string },
  { projectId: string; slug: string; status: string } | null
>("cloud_projects:getProjectBySlugInternal");

/**
 * Contract C2's provisioning check: drive and stella exist for every owner,
 * but app:<slug> and project:<slug> only name something real once the owner
 * actually has that app or project.
 *
 * Returns a readable error, or the CANONICAL workspace string. Canonicalizing
 * here is load-bearing: the builder worker lowercases a workspace before
 * hashing it into the checkpoint key and before asking Convex for the
 * project's credentials, so a thread stored as `project:My_Project` would
 * checkpoint under a name no project row answers to.
 */
const checkWorkspaceProvisioned = async (
  ctx: MutationCtx,
  ownerId: string,
  workspace: string,
): Promise<{ error?: string; workspace: string }> => {
  if (workspace === "drive" || workspace === "stella") return { workspace };
  if (workspace.startsWith("app:")) {
    const slug = workspace.slice("app:".length);
    // by_slug is not owner-scoped and slugs are only unique in practice, so
    // read a small window and pick this owner's row rather than .unique().
    const candidates = await ctx.db
      .query("cloud_apps")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .take(5);
    const app = candidates.find((row) => row.ownerId === ownerId);
    if (!app) {
      return {
        workspace,
        error: `No app named "${slug}" in this account. Build the app first, then send an agent into its workspace.`,
      };
    }
    return { workspace: `app:${app.slug}` };
  }
  const slug = workspace.slice("project:".length);
  let project: { projectId: string; slug: string } | null = null;
  try {
    project = await ctx.runQuery(getProjectBySlugRef, { ownerId, slug });
  } catch {
    // Projects land in their own module; until it deploys, say so plainly
    // rather than reporting the project as missing.
    return {
      workspace,
      error:
        'Project workspaces are not available on this deployment yet. Use workspace "drive".',
    };
  }
  if (!project) {
    return {
      workspace,
      error: `No project named "${slug}" in this account. Create the project first, then send an agent into it.`,
    };
  }
  // The project's own slug, not what the caller typed: it is what the builder
  // resolves credentials by and what the checkpoint key is derived from.
  return { workspace: `project:${project.slug}` };
};

type SpawnCloudAgentResult = {
  ok: boolean;
  threadId?: string;
  turnId?: string;
  error?: string;
};

/**
 * The one implementation of "put a background agent into a cloud workspace".
 * `parentTurnId` is absent for desktop-dispatched spawns, which have no cloud
 * turn above them; every other gate (workspace pattern, provisioning, plan
 * quota, per-workspace exclusivity) applies identically either way.
 */
const spawnCloudAgent = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    conversationId: string;
    parentTurnId?: string;
    description: string;
    prompt: string;
    workspace: string;
    threadId?: string;
    model?: string;
    source?: string;
    now: number;
  },
): Promise<SpawnCloudAgentResult> => {
  if (args.parentTurnId) {
    const parentTurnId = args.parentTurnId;
    const parent = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", parentTurnId))
      .unique();
    if (!parent || parent.ownerId !== args.ownerId) {
      return { ok: false, error: "Parent turn not found." };
    }
  }
  if (!CLOUD_WORKSPACE_PATTERN.test(args.workspace)) {
    return {
      ok: false,
      error:
        "workspace must be drive, stella, project:<name>, or app:<slug> for cloud spawns.",
    };
  }
  // Validate an explicit engine override up front so the orchestrator gets
  // an immediate readable error instead of an async turn failure.
  let engineOverride: CloudEngineSelection | undefined;
  if (args.model) {
    try {
      engineOverride = parseSpawnEngineModel(args.model);
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof ConvexError
            ? String(error.data)
            : "That engine selection isn't available.",
      };
    }
    if (engineOverride) {
      const credential = await ctx.db
        .query("cloud_llm_credentials")
        .withIndex("by_ownerId_and_provider", (q) =>
          q.eq("ownerId", args.ownerId).eq("provider", "anthropic"),
        )
        .unique();
      if (!credential) {
        return {
          ok: false,
          error:
            "No connected Claude subscription for this account. Connect Claude in Settings first, or omit the model.",
        };
      }
    }
  }
  let threadId = args.threadId;
  let workspace = args.workspace;
  let continuedThread: { _id: any } | null = null;
  if (threadId) {
    const requestedThreadId = threadId;
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", requestedThreadId))
      .unique();
    if (!thread || thread.ownerId !== args.ownerId) {
      return { ok: false, error: `Thread not found: ${threadId}` };
    }
    if (thread.status === "running") {
      return {
        ok: false,
        error:
          "That agent is still working. Wait for its [Agent completed] event, then send the follow-up.",
      };
    }
    // Continuations stay in the thread's own workspace.
    workspace = thread.workspace;
    continuedThread = thread;
  }
  // Provisioning is judged on the RESOLVED workspace, so a continuation
  // into a project that has since been removed fails the same way a fresh
  // spawn into it would.
  const provisioning = await checkWorkspaceProvisioned(
    ctx,
    args.ownerId,
    workspace,
  );
  if (provisioning.error) return { ok: false, error: provisioning.error };
  workspace = provisioning.workspace;
  const { quota } = await resolveCloudPlan(ctx, args.ownerId);
  // Concurrency is judged from thread status, not agent_turns rows: a
  // running thread's updatedAt is always fresh (patched at spawn), so the
  // newest-first window reliably contains every live agent, where an
  // oldest-first turns scan could miss them behind a day of chat rows.
  const runningThreads = (
    await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .order("desc")
      .take(50)
  ).filter(
    (thread) =>
      thread.status === "running" &&
      thread.threadId !== threadId &&
      // Defense in depth: the 15-min watchdog (with retried terminal
      // delivery) should terminalize every thread, but a thread stuck
      // "running" must degrade to a bounded lockout, not a permanent one.
      thread.updatedAt > args.now - 60 * 60_000,
  );
  if (runningThreads.length >= quota.concurrentTurns) {
    return {
      ok: false,
      error: `Your plan allows ${quota.concurrentTurns} concurrent background agent${
        quota.concurrentTurns === 1 ? "" : "s"
      }. Wait for one to finish, then try again.`,
    };
  }
  // One agent per workspace at a time: turns restore the workspace
  // checkpoint at start and overwrite it at end, so two concurrent agents
  // in the same workspace would silently lose the first one's work
  // (last-writer-wins on the ws:* key). This mutation is transactional, so
  // the check-and-insert can't race with itself.
  if (runningThreads.some((thread) => thread.workspace === workspace)) {
    return {
      ok: false,
      error: `Another agent is already working in the "${workspace}" workspace. Wait for it to finish, then try again — concurrent agents can run in different workspaces.`,
    };
  }
  if (continuedThread) {
    await ctx.db.patch(continuedThread._id, {
      status: "running",
      description: args.description,
      updatedAt: args.now,
    });
  }
  if (!threadId) {
    threadId = `thr-${crypto.randomUUID().slice(0, 18)}`;
    await ctx.db.insert("cloud_agent_threads", {
      threadId,
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      ...(args.parentTurnId ? { parentTurnId: args.parentTurnId } : {}),
      description: args.description,
      workspace,
      agentType: "general",
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
    conversationId: args.conversationId,
    prompt: args.prompt,
    status: "running",
    lane: "agent",
    kind: "agent",
    agentType: "general",
    workspace,
    threadId,
    ...(args.parentTurnId ? { parentTurnId: args.parentTurnId } : {}),
    ...(args.source ? { source: args.source } : {}),
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
    workspace,
    turnToken,
    ...(engineOverride ? { engine: engineOverride } : {}),
  });
  return { ok: true, threadId, turnId };
};

export const spawnCloudAgentInternal = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.string(),
    parentTurnId: v.optional(v.string()),
    description: v.string(),
    prompt: v.string(),
    workspace: v.string(),
    threadId: v.optional(v.string()),
    // spawn_agent's per-spawn engine override ("claude" | "claude/<model>").
    model: v.optional(v.string()),
    source: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.object({
    ok: v.boolean(),
    threadId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => await spawnCloudAgent(ctx, args),
});

/**
 * Desktop `spawn_agent` with a cloud workspace lands here. Authenticated by
 * the signed-in user's identity — never the builder service secret — so the
 * cloud bills and authorizes the person who asked. `conversationId` is a
 * cloud conversation echoed back from a previous call; refusals throw so the
 * desktop can surface the sentence verbatim as the tool error.
 */
export const spawnCloudAgentFromDesktop = mutation({
  args: {
    workspace: v.string(),
    description: v.string(),
    prompt: v.string(),
    conversationId: v.optional(v.string()),
  },
  returns: v.object({ threadId: v.string(), conversationId: v.string() }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
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
    const now = Date.now();
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
      conversationId,
      description,
      prompt,
      workspace: args.workspace,
      source: "desktop",
      now,
    });
    if (!spawned.ok || !spawned.threadId) {
      throw new ConvexError(
        spawned.error ?? "Stella's cloud could not start that agent.",
      );
    }
    return { threadId: spawned.threadId, conversationId };
  },
});

export const runCloudAgentTurnInternal = internalAction({
  args: {
    ownerId: v.string(),
    conversationId: v.string(),
    threadId: v.string(),
    turnId: v.string(),
    prompt: v.string(),
    workspace: v.string(),
    turnToken: v.string(),
    engine: v.optional(v.object({ provider: v.string(), model: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const builderUrl = process.env.CLOUD_BUILDER_URL?.trim();
    const builderSecret = process.env.BUILDER_SERVICE_SECRET?.trim();
    let failure = "Stella couldn't start that agent. Try again in a moment.";
    try {
      if (!builderUrl || !builderSecret) throw new Error(failure);
      await ctx.runMutation(storeTurnTokenRef, {
        tokenHash: await hashToken(args.turnToken),
        ownerId: args.ownerId,
        turnId: args.turnId,
        agentType: "general",
        now: Date.now(),
      });
      // Explicit spawn override wins; otherwise follow the owner's engine
      // setting, same as chat turns.
      const engine =
        args.engine ?? (await resolveOwnerEngine(ctx, args.ownerId));
      const response = await fetch(
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
            conversationId: args.conversationId,
            threadId: args.threadId,
            turnId: args.turnId,
            prompt: args.prompt,
            workspace: args.workspace,
            turnToken: args.turnToken,
            convexCallbackBase: process.env.CONVEX_SITE_URL,
            ...(engine ? { engine } : {}),
          }),
        },
      );
      if (response.ok) return null;
      failure = "Stella hit a snag starting that agent. Try again.";
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "convex-cloud-apps",
          event: "agent_dispatch_failed",
          turnId: args.turnId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    await ctx.runMutation(failCloudTurnRef, {
      turnId: args.turnId,
      message: failure,
      now: Date.now(),
    });
    await ctx.runMutation(completeAgentThreadRef, {
      threadId: args.threadId,
      status: "failed",
      errorMessage: failure,
      now: Date.now(),
    });
    return null;
  },
});

export const completeAgentThreadInternal = internalMutation({
  args: {
    threadId: v.string(),
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
    completingTurnId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!["completed", "failed", "canceled"].includes(args.status)) {
      throw new ConvexError("Invalid thread status.");
    }
    if (args.callerTurnId) {
      const callerTurn = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", args.callerTurnId!))
        .unique();
      if (!callerTurn || callerTurn.threadId !== args.threadId) {
        // A sandbox token speaks only for its own thread — anything else is
        // the forged-lifecycle channel finding 4 closed for messages.
        throw new ConvexError("Turn does not belong to this thread.");
      }
    }
    // This callback is thread-scoped, and the only thing that used to fence it
    // was the thread not being "running" — which a continuation has just
    // undone. So an outcome delivered late for a superseded turn (a DO
    // replaying a terminal payload it never managed to deliver) would cancel
    // the thread out from under the turn now running on it: the user is told
    // the agent stopped, and the live turn's own report is dropped as a
    // duplicate when it finally lands. A turn that a newer turn on the same
    // thread has already replaced completes itself, not the thread.
    if (args.completingTurnId) {
      const completing = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", args.completingTurnId!))
        .unique();
      if (completing && completing.threadId === args.threadId) {
        const newer = await ctx.db
          .query("agent_turns")
          .withIndex("by_threadId_and_createdAt", (q) =>
            q.eq("threadId", args.threadId).gt("createdAt", completing.createdAt),
          )
          .take(10);
        const successor = newer.find(
          (turn) =>
            turn.turnId !== completing.turnId && turn.status === "running",
        );
        if (successor) {
          console.warn(
            JSON.stringify({
              service: "convex-cloud-apps",
              event: "thread_completion_superseded",
              threadId: args.threadId,
              turnId: completing.turnId,
              successorTurnId: successor.turnId,
              status: args.status,
            }),
          );
          return null;
        }
      }
    }
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (!thread) throw new ConvexError("Unknown agent thread.");
    if (thread.status !== "running") return null;
    await ctx.db.patch(thread._id, {
      status: args.status,
      resultJson: args.resultJson,
      errorMessage: args.errorMessage,
      updatedAt: args.now,
    });
    if (args.wake === false) return null;

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
          workspace: thread.workspace,
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
  returns: v.any(),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const rows = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_conversationId_and_updatedAt", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .take(30);
    return rows.filter((row) => row.ownerId === ownerId);
  },
});

/**
 * Activity renders every cloud thread the owner has, not just the newest
 * conversation's — a desktop-dispatched agent must stay visible while another
 * conversation is bumped. Ownership is the index key, so no post-filter.
 */
export const listMyRecentAgentThreads = query({
  args: { limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    return await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 30, 1), 100));
  },
});

export const getStorageInternal = internalQuery({
  args: { appId: v.string(), userId: v.string(), key: v.string() },
  returns: v.any(),
  handler: (ctx, args) =>
    ctx.db
      .query("cloud_app_storage")
      .withIndex("by_appId_and_userId_and_key", (q) =>
        q.eq("appId", args.appId).eq("userId", args.userId).eq("key", args.key),
      )
      .unique(),
});

export const listStorageInternal = internalQuery({
  args: { appId: v.string(), userId: v.string() },
  returns: v.any(),
  handler: (ctx, args) =>
    ctx.db
      .query("cloud_app_storage")
      .withIndex("by_appId_and_userId", (q) =>
        q.eq("appId", args.appId).eq("userId", args.userId),
      )
      .take(101),
});

export const setStorageInternal = internalMutation({
  args: {
    appId: v.string(),
    ownerId: v.string(),
    userId: v.string(),
    key: v.string(),
    valueJson: v.string(),
    sizeBytes: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.key.length < 1 || args.key.length > 128) {
      throw new ConvexError("Storage keys must be 1–128 characters.");
    }
    if (args.sizeBytes > 16 * 1024) {
      throw new ConvexError("Storage value exceeds the 16 KB per-key limit.");
    }
    const rows = await ctx.db
      .query("cloud_app_storage")
      .withIndex("by_appId_and_userId", (q) =>
        q.eq("appId", args.appId).eq("userId", args.userId),
      )
      .take(101);
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
        valueJson: args.valueJson,
        sizeBytes: args.sizeBytes,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("cloud_app_storage", {
        appId: args.appId,
        ownerId: args.ownerId,
        userId: args.userId,
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
  args: { appId: v.string(), userId: v.string(), key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cloud_app_storage")
      .withIndex("by_appId_and_userId_and_key", (q) =>
        q.eq("appId", args.appId).eq("userId", args.userId).eq("key", args.key),
      )
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

export const appendEventInternal = internalMutation({
  args: {
    turnId: v.string(),
    sessionId: v.string(),
    seq: v.number(),
    // Executors that can't coordinate a shared counter with the DO (the
    // in-sandbox agent, the orchestrator loop) let Convex assign max(seq)+1.
    // Auto-seq events skip the duplicate check by construction.
    autoSeq: v.optional(v.boolean()),
    kind: v.string(),
    payloadJson: v.string(),
    terminal: v.boolean(),
    now: v.number(),
  },
  returns: v.object({ inserted: v.boolean(), terminalAccepted: v.boolean() }),
  handler: async (ctx, args) => {
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
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    if (!turn) throw new ConvexError("Unknown cloud turn.");
    if (turn.terminalKind) {
      return { inserted: false, terminalAccepted: false };
    }
    await ctx.db.insert("agent_events", {
      turnId: args.turnId,
      sessionId: args.sessionId,
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
        updatedAt: args.now,
      });
      await scheduleTerminalCard(ctx, turn, args.kind, args.payloadJson);
    }
    return { inserted: true, terminalAccepted: args.terminal };
  },
});

export const recordBuildInternal = internalMutation({
  args: {
    buildId: v.string(),
    appId: v.string(),
    ownerId: v.string(),
    artifactPrefix: v.string(),
    previewUrl: v.string(),
    metricsJson: v.string(),
    slug: v.string(),
    autoActivate: v.boolean(),
    title: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("cloud_app_builds", {
      buildId: args.buildId,
      appId: args.appId,
      ownerId: args.ownerId,
      status: args.autoActivate ? "active" : "pending",
      artifactPrefix: args.artifactPrefix,
      previewUrl: args.previewUrl,
      slug: args.slug,
      metricsJson: args.metricsJson,
      createdAt: args.now,
      updatedAt: args.now,
    });
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (app) {
      // Apps carry their real product name (from the finished build), never
      // the prompt text that created them.
      const title = args.title?.trim().slice(0, 32);
      await ctx.db.patch(app._id, {
        ...(title && title !== app.title ? { title } : {}),
        ...(args.autoActivate
          ? { status: "active", activeBuildId: args.buildId }
          : {}),
        updatedAt: args.now,
      });
    }
    return null;
  },
});

export const setAppTitleInternal = internalMutation({
  args: { appId: v.string(), title: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (app) {
      await ctx.db.patch(app._id, {
        title: args.title.trim().slice(0, 32),
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

export const activateBuildInternal = internalMutation({
  args: { appId: v.string(), buildId: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    const build = await ctx.db
      .query("cloud_app_builds")
      .withIndex("by_buildId", (q) => q.eq("buildId", args.buildId))
      .unique();
    if (!app || !build || build.appId !== app.appId)
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
  args: { appId: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (app) {
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
    const quota = await ctx.runQuery(checkQuotaRef, { ownerId });
    if (!quota.allowed)
      throw new ConvexError(quota.reason ?? "Build quota exceeded.");
    await ctx.runMutation(createTurnRef, {
      turnId,
      sessionId,
      ownerId,
      appId,
      prompt: benchmarkPrompt,
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
          appId,
          turnId,
          prompt: benchmarkPrompt,
          turnToken,
          convexCallbackBase: process.env.CONVEX_SITE_URL,
          autoActivate: true,
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
          appId: app.appId,
          turnId,
          prompt,
          turnToken,
          convexCallbackBase: process.env.CONVEX_SITE_URL,
          autoActivate: false,
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
        buildId: build.buildId,
        artifactPrefix: build.artifactPrefix,
      }),
    });
    if (!response.ok) throw new ConvexError("Route activation failed.");
    await ctx.runMutation(activateBuildRef, {
      appId: build.appId,
      buildId: build.buildId,
      now: Date.now(),
    });
    return { ok: true, buildId: build.buildId, previewUrl: build.previewUrl };
  },
});

export const applyMyBuild = action({
  args: { buildId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
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
        buildId: build.buildId,
        artifactPrefix: build.artifactPrefix,
      }),
    });
    if (!response.ok)
      throw new ConvexError("App activation failed. Try again.");
    await ctx.runMutation(activateBuildRef, {
      appId: build.appId,
      buildId: build.buildId,
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
      body: JSON.stringify({ slug: app.slug, appId: app.appId, ownerId }),
    });
    if (!response.ok) throw new ConvexError("App removal failed. Try again.");
    await ctx.runMutation(
      makeFunctionReference<"mutation", any, any>(
        "cloud_apps:suspendAppInternal",
      ),
      { appId: app.appId, now: Date.now() },
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
          appId: app.appId,
          turnId: args.turnId,
          prompt,
          turnToken: crypto.randomUUID().replaceAll("-", ""),
          convexCallbackBase: process.env.CONVEX_SITE_URL,
          autoActivate: false,
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
): Promise<boolean> => {
  if (turn.terminalKind) return false;
  const payloadJson = JSON.stringify(payload ?? {});
  await ctx.db.insert("agent_events", {
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
    await scheduleTerminalCard(ctx, turn, kind, payloadJson);
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
    turnId: string;
    name: string;
    argsJson: string;
    status: string;
  },
  outcome: { ok: boolean; resultJson?: string; errorMessage?: string },
  now: number,
): Promise<void> => {
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
    userId: v.string(),
    manifestJson: v.string(),
    now: v.number(),
  },
  returns: v.object({ operationCount: v.number() }),
  handler: async (ctx, args) => {
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (!app || app.ownerId !== args.userId) {
      throw new ConvexError(
        "Only the app owner's session can register operations.",
      );
    }
    return await upsertOperationsManifest(ctx, {
      appId: app.appId,
      ownerId: app.ownerId,
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
    turnId: v.string(),
    name: v.string(),
    argsJson: v.string(),
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean(), message: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    if (!turn || turn.terminalKind) {
      return { ok: false, message: "Turn is no longer active." };
    }
    const fail = async (message: string) => {
      await appendTurnEvent(ctx, turn, "failed", { message }, true, args.now);
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
    );
    return { ok: true };
  },
});

export const reserveBuildLaneInternal = internalMutation({
  args: { ownerId: v.string(), turnId: v.string() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    if (!turn || turn.terminalKind) return { ok: false };
    const now = Date.now();
    const { plan, quota } = await resolveCloudPlan(ctx, args.ownerId);
    const buildTurns = (
      await listRecentBuildTurns(ctx, args.ownerId, quota.dailyTurns + 2)
    ).filter((candidate) => candidate.turnId !== args.turnId);
    const running = buildTurns.filter(
      (candidate) => candidate.status === "running",
    );
    const fail = async (message: string) => {
      await appendTurnEvent(ctx, turn, "failed", { message }, true, now);
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

export const expireOpInvocationInternal = internalMutation({
  args: { invocationId: v.string() },
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
      );
    }
    return null;
  },
});

export const listPendingOpInvocations = query({
  args: { appId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const rows = await ctx.db
      .query("cloud_app_op_invocations")
      .withIndex("by_appId_and_status_and_createdAt", (q) =>
        q.eq("appId", args.appId).eq("status", "pending"),
      )
      .order("desc")
      .take(10);
    return rows
      .filter((row) => row.ownerId === ownerId)
      .map((row) => ({
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
  args: { appId: v.string(), userId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloud_app_op_invocations")
      .withIndex("by_appId_and_status_and_createdAt", (q) =>
        q.eq("appId", args.appId).eq("status", "pending"),
      )
      .take(5);
    const claimed = [];
    const now = Date.now();
    for (const row of rows) {
      if (row.ownerId !== args.userId) continue;
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
    invocationId: v.string(),
    userId: v.string(),
    ok: v.boolean(),
    resultJson: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cloud_app_op_invocations")
      .withIndex("by_invocationId", (q) =>
        q.eq("invocationId", args.invocationId),
      )
      .unique();
    if (!row || row.ownerId !== args.userId) {
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
    conversationId: v.string(),
    appId: v.string(),
    turnId: v.string(),
    sessionId: v.string(),
    prompt: v.string(),
    turnToken: v.string(),
    autoActivate: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const failTurn = (message: string) =>
      ctx.runMutation(failCloudTurnRef, {
        turnId: args.turnId,
        message,
        now: Date.now(),
      });
    const dispatchBuild = async () => {
      const reserved = (await ctx.runMutation(reserveBuildLaneRef, {
        ownerId: args.ownerId,
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
        // Same rule as the direct build lane: a finished app build is live.
        autoActivate: true,
      });
    };

    const manifestRow = await ctx.runQuery(getOpsManifestRef, {
      appId: args.appId,
    });
    if (!manifestRow) {
      await dispatchBuild();
      return null;
    }
    const app = await ctx.runQuery(getAppRef, { appId: args.appId });
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      await failTurn("Stella couldn't start on this. Try again in a moment.");
      return null;
    }
    let decision: {
      decision?: string;
      name?: string;
      args?: Record<string, unknown>;
    };
    try {
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
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
      });
      const payload = (await upstream.json()) as {
        content?: Array<{ type?: string; text?: string }>;
        error?: { message?: string };
      };
      if (!upstream.ok) {
        throw new Error(payload.error?.message ?? "Routing model failed.");
      }
      const text =
        payload.content?.find((item) => item.type === "text")?.text ?? "";
      decision = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
    } catch (error) {
      await failTurn("Stella couldn't finish this request. Try again.");
      return null;
    }
    if (decision.decision !== "operation" || !decision.name) {
      await dispatchBuild();
      return null;
    }
    const invocationId = crypto.randomUUID();
    const created = (await ctx.runMutation(createOpInvocationRef, {
      invocationId,
      appId: args.appId,
      ownerId: args.ownerId,
      turnId: args.turnId,
      name: decision.name,
      argsJson: JSON.stringify(decision.args ?? {}),
      now: Date.now(),
    })) as { ok: boolean };
    if (created.ok) {
      await ctx.scheduler.runAfter(
        OPS_LIMITS.deliveryWindowMs + 1_000,
        expireOpInvocationRef,
        { invocationId },
      );
    }
    return null;
  },
});

export const getBenchmarkTurn = query({
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
