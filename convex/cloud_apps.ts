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
import { enforceMutationRateLimit } from "./lib/rate_limits";
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
const getOpsManifestRef = makeFunctionReference<"query", { appId: string }, any>(
  "cloud_apps:getOperationsManifestInternal",
);
const createOpInvocationRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:createOpInvocationInternal",
);
const reserveBuildLaneRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:reserveBuildLaneInternal",
);
const expireOpInvocationRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:expireOpInvocationInternal",
);

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
  if (!identity) throw new ConvexError("Sign in to use cloud apps.");
  return identity.tokenIdentifier;
};

export const listMyConversations = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    return await ctx.db
      .query("cloud_conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(25);
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

export const listMyCloudTurns = query({
  args: { conversationId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const conversation = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .unique();
    if (!conversation || conversation.ownerId !== ownerId) {
      throw new ConvexError("Conversation not found.");
    }
    const turns = await ctx.db
      .query("agent_turns")
      .withIndex("by_conversationId_and_createdAt", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .take(20);
    const hydrated = await Promise.all(
      turns.reverse().map(async (turn) => {
        const events = await ctx.db
          .query("agent_events")
          .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", turn.turnId))
          .take(100);
        return {
          ...turn,
          events: events.map((event) => ({
            ...event,
            payload: JSON.parse(event.payloadJson),
          })),
        };
      }),
    );
    return hydrated;
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
  },
  returns: v.object({
    conversationId: v.string(),
    appId: v.string(),
    turnId: v.string(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const prompt = args.prompt.trim();
    if (!prompt || prompt.length > 4_000) {
      throw new ConvexError("Describe the app in 1–4,000 characters.");
    }
    const { plan, quota } = await resolveCloudPlan(ctx, ownerId);

    // Resolve the target app first: turns aimed at an active app that has
    // registered operations enter the routed lane, which never reserves build
    // quota up front (the router re-checks it if the model chooses a build).
    let targetApp: { appId: string; ownerId: string; status: string } | null =
      null;
    if (args.appId) {
      const requestedAppId = args.appId;
      const app = await ctx.db
        .query("cloud_apps")
        .withIndex("by_appId", (q) => q.eq("appId", requestedAppId))
        .unique();
      if (!app || app.ownerId !== ownerId)
        throw new ConvexError("App not found.");
      targetApp = app;
    }
    const opsManifest =
      targetApp && targetApp.status === "active"
        ? await ctx.db
            .query("cloud_app_operations")
            .withIndex("by_appId", (q) => q.eq("appId", targetApp!.appId))
            .unique()
        : null;
    const routed = opsManifest !== null;

    if (routed) {
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
        "Daily app-operation quota reached. Try again after the rolling 24-hour window resets.",
      );
    } else {
      await enforceMutationRateLimit(
        ctx,
        "cloud_apps_start",
        ownerId,
        { rate: quota.burstStarts, periodMs: 10 * 60_000 },
        "Too many cloud turns started recently. Wait a few minutes and try again.",
      );
      const recentTurns = await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", ownerId).gte("createdAt", Date.now() - 86_400_000),
        )
        .take(quota.dailyTurns + 1);
      const buildTurns = recentTurns.filter(
        (turn) => turn.lane !== "operation",
      );
      const running = buildTurns.filter((turn) => turn.status === "running");
      if (running.length >= quota.concurrentTurns) {
        throw new ConvexError(
          `${plan === "free" ? "Free" : plan} allows ${quota.concurrentTurns} active cloud ${
            quota.concurrentTurns === 1 ? "turn" : "turns"
          }. Wait for one to finish or cancel it.`,
        );
      }
      if (buildTurns.length >= quota.dailyTurns) {
        throw new ConvexError(
          `${plan === "free" ? "Free" : plan} includes ${quota.dailyTurns} cloud turns per rolling 24 hours. Try again after the window resets.`,
        );
      }
    }

    const now = Date.now();
    let conversationId = args.conversationId;
    if (conversationId) {
      const requestedConversationId = conversationId;
      const conversation = await ctx.db
        .query("cloud_conversations")
        .withIndex("by_conversationId", (q) =>
          q.eq("conversationId", requestedConversationId),
        )
        .unique();
      if (!conversation || conversation.ownerId !== ownerId) {
        throw new ConvexError("Conversation not found.");
      }
      await ctx.db.patch(conversation._id, { updatedAt: now });
    } else {
      conversationId = crypto.randomUUID();
      await ctx.db.insert("cloud_conversations", {
        conversationId,
        ownerId,
        title: prompt.length > 56 ? `${prompt.slice(0, 53)}…` : prompt,
        createdAt: now,
        updatedAt: now,
      });
    }

    let appId = args.appId;
    let isNewApp = false;
    if (appId) {
      if (!targetApp) throw new ConvexError("App not found.");
    } else {
      appId = `app-${crypto.randomUUID()}`;
      isNewApp = true;
      await ctx.db.insert("cloud_apps", {
        appId,
        ownerId,
        slug: `orbit-${appId.slice(-8)}`,
        title:
          prompt.length > 32
            ? `${prompt.slice(0, 29).replace(/\s+\S*$/, "")}…`
            : prompt,
        status: "building",
        createdAt: now,
        updatedAt: now,
      });
    }

    const turnId = crypto.randomUUID();
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
      createdAt: now,
      updatedAt: now,
    });
    const turnToken =
      crypto.randomUUID().replaceAll("-", "") +
      crypto.randomUUID().replaceAll("-", "");
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
        autoActivate: isNewApp,
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
    const existing = await ctx.db
      .query("agent_events")
      .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", args.turnId))
      .take(100);
    const seq =
      existing.reduce((max, event) => Math.max(max, event.seq), -1) + 1;
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
    let failure = "The cloud builder is not configured. Try again later.";
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
      failure = `The cloud builder returned ${response.status}. Retry this turn.`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
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
    kind: v.string(),
    payloadJson: v.string(),
    terminal: v.boolean(),
    now: v.number(),
  },
  returns: v.object({ inserted: v.boolean(), terminalAccepted: v.boolean() }),
  handler: async (ctx, args) => {
    const duplicate = await ctx.db
      .query("agent_events")
      .withIndex("by_turnId_and_seq", (q) =>
        q.eq("turnId", args.turnId).eq("seq", args.seq),
      )
      .unique();
    if (duplicate) {
      return { inserted: false, terminalAccepted: false };
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
      seq: args.seq,
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
    if (app && args.autoActivate) {
      await ctx.db.patch(app._id, {
        status: "active",
        activeBuildId: args.buildId,
        updatedAt: args.now,
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

export const startBenchmarkTurn = action({
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

export const startLifecycleTurn = action({
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

export const applyBuild = action({
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

export const startLifecycleProbe = action({
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
  const existing = await ctx.db
    .query("agent_events")
    .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", turnId))
    .take(200);
  return existing.reduce((max, event) => Math.max(max, event.seq), -1) + 1;
};

const appendTurnEvent = async (
  ctx: MutationCtx,
  turn: { _id: any; turnId: string; sessionId: string; terminalKind?: string },
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
        `The app does not expose an operation named ${args.name}. Ask for a change to the app instead.`,
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
    const recentTurns = await ctx.db
      .query("agent_turns")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).gte("createdAt", now - 86_400_000),
      )
      .take(quota.dailyTurns + 21);
    const buildTurns = recentTurns.filter(
      (candidate) =>
        candidate.lane !== "operation" && candidate.turnId !== args.turnId,
    );
    const running = buildTurns.filter(
      (candidate) => candidate.status === "running",
    );
    const fail = async (message: string) => {
      await appendTurnEvent(ctx, turn, "failed", { message }, true, now);
      return { ok: false };
    };
    if (running.length >= quota.concurrentTurns) {
      return await fail(
        `${plan === "free" ? "Free" : plan} allows ${quota.concurrentTurns} active cloud ${
          quota.concurrentTurns === 1 ? "turn" : "turns"
        }. Wait for one to finish or cancel it.`,
      );
    }
    if (buildTurns.length >= quota.dailyTurns) {
      return await fail(
        `${plan === "free" ? "Free" : plan} includes ${quota.dailyTurns} cloud turns per rolling 24 hours. Try again after the window resets.`,
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
        autoActivate: false,
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
      await failTurn("The cloud agent is not configured. Try again later.");
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
      await failTurn(
        `Stella could not route this request: ${
          error instanceof Error ? error.message : String(error)
        }. Try again.`,
      );
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
